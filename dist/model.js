/* Shared, deterministic scene and timeline operations. No browser dependencies. */
(function (root) {
  'use strict';
  let serial = 0;
  const id = prefix => `${prefix}-${++serial}`;
  // structuredClone also preserves voice-recording Blobs for undo/redo.
  const copy = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  function makeScene(number) {
    return { id: id('scene'), name: `Scene ${String(number).padStart(2, '0')}`, paper: '#fffef9', strokes: [], layers: [], recordings: [], voiceRecordings: [], voiceClips: [] };
  }
  function makeFigure(number, color = '#30392f') {
    return { id: id('layer'), name: `Character ${number}`, type: 'figure', x: 550 + ((number - 1) % 4) * 100, y: 305, color, limbs: [[-47, 22], [47, 22], [-32, 116], [32, 116]], clips: [] };
  }
  function pose(layer) {
    return { x: layer.x, y: layer.y, ...(layer.type === 'figure' ? { limbs: copy(layer.limbs) } : {}) };
  }
  function sample(recording, time) {
    const frames = recording.frames;
    let lo = 0, hi = frames.length - 1;
    time = clamp(time, 0, recording.duration);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (frames[mid].t <= time) lo = mid; else hi = mid - 1;
    }
    const a = frames[lo], b = frames[Math.min(lo + 1, frames.length - 1)];
    const fraction = a.t === b.t ? 0 : clamp((time - a.t) / (b.t - a.t), 0, 1);
    return { x: a.pose.x + (b.pose.x - a.pose.x) * fraction, y: a.pose.y + (b.pose.y - a.pose.y) * fraction,
      ...(a.pose.limbs ? { limbs: a.pose.limbs.map((p, i) => p.map((v, j) => v + (b.pose.limbs[i][j] - v) * fraction)) } : {}) };
  }
  function recordingFor(scene, clip) {
    return clip.kind === 'voice' ? scene.voiceRecordings.find(r => r.id === clip.recordingId) : scene.recordings.find(r => r.id === clip.recordingId);
  }
  function trimIn(clip) { return clip.trimIn ?? 0; }
  function trimOut(scene, clip) { return clip.trimOut ?? recordingFor(scene, clip).duration; }
  function clipDuration(scene, clip) { return Math.max(0, trimOut(scene, clip) - trimIn(clip)); }
  function clipEnd(scene, clip) { return clip.start + clipDuration(scene, clip); }
  function sceneDuration(scene) { return Math.max(0, ...scene.layers.flatMap(l => l.clips.map(c => clipEnd(scene, c))), ...(scene.voiceClips || []).map(c => clipEnd(scene, c))); }
  function storyDuration(scenes) { return scenes.reduce((total, scene) => total + Math.max(3, sceneDuration(scene)), 0); }
  function sceneOffset(scenes, sceneId) {
    let offset = 0;
    for (const item of scenes) { if (item.id === sceneId) return offset; offset += Math.max(3, sceneDuration(item)); }
    return offset;
  }
  function layerAt(scene, layer, time, ignoreClip = null) {
    const result = { ...layer, ...pose(layer) };
    const eligible = layer.clips.filter(c => c.id !== ignoreClip && c.start <= time).sort((a, b) => a.start - b.start);
    if (!eligible.length) return result;
    const clip = eligible[eligible.length - 1], recording = recordingFor(scene, clip);
    const sourceTime = Math.min(trimOut(scene, clip), trimIn(clip) + time - clip.start);
    const p = sample(recording, sourceTime), first = recording.frames[0].pose;
    return { ...result, ...p, x: clip.origin.x + p.x - first.x, y: clip.origin.y + p.y - first.y };
  }
  function validatePlacement(scene, recording, target, start, ignoreClip = null, length = recording.duration) {
    if (!target || recording.type !== target.type) throw new Error('Choose a matching layer: characters with characters, drawings with items.');
    if (!Number.isFinite(start) || start < 0 || start + length > 600) throw new Error('Place the clip between 0 and 600 seconds.');
    if (target.clips.some(c => c.id !== ignoreClip && start < clipEnd(scene, c) - .001 && start + length > c.start + .001)) {
      throw new Error('These clips overlap on one layer. Move the clip to an empty time or another matching layer.');
    }
  }
  function placeClip(scene, recordingId, targetId, start, movingId = null) {
    const recording = scene.recordings.find(r => r.id === recordingId);
    const target = scene.layers.find(l => l.id === targetId);
    if (!recording) throw new Error('Recording not found in this scene.');
    const source = movingId ? scene.layers.find(l => l.clips.some(c => c.id === movingId)) : null;
    const old = source?.clips.find(c => c.id === movingId);
    if (movingId && !old) throw new Error('Clip not found.');
    start = Math.round(start * 10) / 10;
    const input = old?.trimIn ?? 0, output = old?.trimOut ?? recording.duration;
    validatePlacement(scene, recording, target, start, movingId, output - input);
    const origin = source === target ? copy(old.origin) : pose(layerAt(scene, target, start, movingId));
    const clip = { id: old?.id || id('clip'), kind: 'movement', recordingId, start, trimIn: input, trimOut: output, origin: { x: origin.x, y: origin.y } };
    if (source) source.clips = source.clips.filter(c => c.id !== movingId);
    target.clips.push(clip);
    target.clips.sort((a, b) => a.start - b.start);
    return clip;
  }
  function placeVoiceClip(scene, recordingId, start) {
    const recording = scene.voiceRecordings.find(r => r.id === recordingId);
    if (!recording) throw new Error('Voice recording not found in this scene.');
    if (!Number.isFinite(start) || start < 0 || start + recording.duration > 600) throw new Error('Place the voice clip between 0 and 600 seconds.');
    const clip = { id: id('voice-clip'), kind: 'voice', recordingId, start: Math.round(start * 10) / 10, trimIn: 0, trimOut: recording.duration };
    scene.voiceClips.push(clip); scene.voiceClips.sort((a, b) => a.start - b.start); return clip;
  }
  function updateClip(scene, clipId, changes) {
    const layer = scene.layers.find(item => item.clips.some(c => c.id === clipId));
    const clip = layer?.clips.find(c => c.id === clipId) || scene.voiceClips.find(c => c.id === clipId);
    if (!clip) throw new Error('Clip not found.');
    const recording = recordingFor(scene, clip);
    const start = Number(changes.start ?? clip.start), input = Number(changes.trimIn ?? trimIn(clip)), output = Number(changes.trimOut ?? trimOut(scene, clip));
    if (![start, input, output].every(Number.isFinite) || start < 0 || input < 0 || output > recording.duration || output - input < .1 || start + output - input > 600) throw new Error('Keep the clip at least 0.1 seconds long and within the 10-minute timeline.');
    if (layer && layer.clips.some(c => c.id !== clipId && start < clipEnd(scene, c) - .001 && start + output - input > c.start + .001)) throw new Error('These clips overlap on one layer. Move this clip to an empty time or another matching layer.');
    Object.assign(clip, changes, { start: Math.round(start * 10) / 10, trimIn: input, trimOut: output });
    if (layer) layer.clips.sort((a, b) => a.start - b.start);
    else scene.voiceClips.sort((a, b) => a.start - b.start);
    return clip;
  }
  function trimVoiceClip(scene, clipId, changes) { return updateClip(scene, clipId, changes); }
  function bounds(strokes) {
    const points = strokes.flatMap(s => s.points.map(p => ({ x: p.x, y: p.y, pad: s.width / 2 })));
    if (!points.length) return null;
    return { left: Math.min(...points.map(p => p.x - p.pad)), top: Math.min(...points.map(p => p.y - p.pad)),
      right: Math.max(...points.map(p => p.x + p.pad)), bottom: Math.max(...points.map(p => p.y + p.pad)) };
  }
  function convertArt(scene, indices, name) {
    const selected = new Set(indices);
    const art = scene.strokes.filter((_, i) => selected.has(i));
    if (!art.some(s => !s.erase)) throw new Error('Select some drawing strokes first.');
    const box = bounds(art), x = (box.left + box.right) / 2, y = (box.top + box.bottom) / 2;
    const layer = { id: id('layer'), name, type: 'item', x, y, color: art.find(s => !s.erase).color,
      width: box.right - box.left, height: box.bottom - box.top,
      strokes: art.map(s => ({ ...copy(s), points: s.points.map(p => ({ x: p.x - x, y: p.y - y })) })), clips: [] };
    scene.strokes = scene.strokes.filter((_, i) => !selected.has(i));
    scene.layers.push(layer);
    return layer;
  }
  const api = { id, copy, clamp, makeScene, makeFigure, pose, sample, recordingFor, trimIn, trimOut, clipDuration, clipEnd, sceneDuration, storyDuration, sceneOffset, layerAt, placeClip, placeVoiceClip, updateClip, trimVoiceClip, bounds, convertArt };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StoryModel = api;
})(typeof window === 'undefined' ? globalThis : window);
