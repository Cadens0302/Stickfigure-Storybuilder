'use strict';
const M = window.StoryModel;
const $ = id => document.getElementById(id);
const canvas = $('stage'), ctx = canvas.getContext('2d');
const inkCanvas = document.createElement('canvas'), inkCtx = inkCanvas.getContext('2d');
inkCanvas.width = canvas.width; inkCanvas.height = canvas.height;
const W = 1200, H = 650;
const scenes = [M.makeScene(1)];
let scene = scenes[0], selected = null, selectedArt = [], selectedClip = null;
let tool = 'select', ink = '#30392f', brush = 4, gesture = null;
let playing = false, storyPlayback = false, recording = null, voiceRecording = null, exporting = false, elapsed = 0, storyElapsed = 0, startTime = 0, loop = false;
let toastTimer, clipDrag = null, dragGhost = null, undo = [], redo = [], recordingCounter = 0, voiceCounter = 0;
let audioContext = null, voiceNodes = [], voiceDecoded = new Map(), voiceTimers = [];
const busy = () => playing || !!recording || !!voiceRecording || exporting;
const activeLayer = () => scene.layers.find(l => l.id === selected);
const duration = () => M.sceneDuration(scene);
const wholeStoryDuration = () => M.storyDuration(scenes);
const timelineSpan = () => Math.max(10, Math.ceil((Math.max(duration(), recording ? elapsed : 0) + 2) / 5) * 5);
function toast(message) {
  $('toast').textContent = message; $('toast').classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 4200);
}
function format(t) { return `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(1).padStart(4, '0')}`; }
function button(text, label, action, className = '') {
  const b = document.createElement('button'); b.textContent = text;
  if (label) b.setAttribute('aria-label', label);
  b.className = className; b.onclick = action; return b;
}
function editAllowed() { if (busy()) { toast('Stop playback or recording before editing.'); return false; } return true; }
function remember() { undo.push(M.copy(scene)); if (undo.length > 40) undo.shift(); redo = []; }
function restore(snapshot) {
  const i = scenes.findIndex(s => s.id === scene.id); scene = snapshot; scenes[i] = scene;
  if (!scene.layers.some(l => l.id === selected)) selected = scene.layers[0]?.id || null;
  selectedArt = []; selectedClip = null; elapsed = Math.min(elapsed, duration()); refresh();
}
function setTool(value) {
  tool = value;
  document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  canvas.style.cursor = tool === 'select' ? 'grab' : 'crosshair';
  $('toolHint').textContent = { select: 'Drag a layer to move it. Drag hands or feet to change a pose.', pen: 'Draw your world directly on the stage.', line: 'Drag between two points to draw a straight line.', eraser: 'Erase background strokes. Movable layers stay separate.', art: 'Drag a box around your drawing, then choose Make layer.' }[tool];
  render();
}
function renderScenes() {
  $('sceneTabs').replaceChildren();
  scenes.forEach(s => {
    const b = button(s.name, null, () => switchScene(s.id), 'scene-tab');
    b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', s.id === scene.id);
    b.disabled = busy(); $('sceneTabs').append(b);
  });
  $('sceneName').value = scene.name; $('sceneCorner').textContent = scene.name.toUpperCase();
  renderStoryOverview();
}
function renderStoryOverview() {
  const root = $('storyOverview'); if (!root) return; root.replaceChildren();
  scenes.forEach(item => {
    const segment = button(item.name, `Play ${item.name} in the story`, () => { if (!busy()) switchScene(item.id); }, 'story-segment' + (scene.id === item.id ? ' current' : ''));
    segment.disabled = busy(); segment.style.flexGrow = Math.max(3, M.sceneDuration(item));
    root.append(segment);
  });
  $('playStory').textContent = storyPlayback && playing ? 'Ⅱ Pause story' : '▶ Play whole story';
  $('playStory').disabled = !!recording || !!voiceRecording || exporting;
}
function switchScene(id) {
  if (!editAllowed() || scene.id === id) return;
  storyPlayback = false; stopVoiceSources();
  scene = scenes.find(s => s.id === id); selected = scene.layers[0]?.id || null;
  selectedArt = []; selectedClip = null; elapsed = 0; undo = []; redo = []; gesture = null;
  refresh();
}
function addScene() {
  if (!editAllowed()) return;
  const next = M.makeScene(scenes.length + 1); scenes.push(next); switchScene(next.id);
  toast('New scene ready. Add characters or draw a new world.');
}
function addFigure() {
  if (!editAllowed()) return;
  if (scene.layers.length >= 24) return toast('This scene has 24 layers. Create another scene for more.');
  remember();
  const number = scene.layers.filter(l => l.type === 'figure').length + 1;
  const layer = M.makeFigure(number, ink); scene.layers.push(layer); selected = layer.id;
  selectedArt = []; setTool('select'); refresh();
}
function selectLayer(id) {
  if (busy()) return;
  selected = id; selectedArt = []; setTool('select'); renderCast(); renderChannels(); state();
}
function renderCast() {
  $('cast').replaceChildren();
  if (!scene.layers.length) { const empty = document.createElement('p'); empty.className = 'tool-hint'; empty.textContent = 'Add a character or turn your drawing into a layer.'; $('cast').append(empty); }
  scene.layers.forEach((layer, index) => {
    const row = document.createElement('div'); row.className = 'cast-row' + (selected === layer.id ? ' selected' : '');
    const choose = button(`${layer.type === 'figure' ? '♧' : '◇'} ${layer.name}`, `Select ${layer.name}`, () => selectLayer(layer.id), 'cast-select');
    choose.disabled = busy();
    const remove = button('×', `Remove ${layer.name}`, () => {
      if (!editAllowed()) return; remember(); scene.layers.splice(index, 1);
      if (selected === layer.id) selected = scene.layers[0]?.id || null;
      selectedClip = null; refresh(); toast('Layer removed. Undo will restore it.');
    });
    remove.disabled = busy(); row.append(choose, remove); $('cast').append(row);
  });
}
function drawStroke(target, stroke, offsetX = 0, offsetY = 0) {
  target.save(); target.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
  target.strokeStyle = stroke.color; target.lineWidth = stroke.width; target.lineCap = 'round'; target.lineJoin = 'round';
  target.beginPath(); stroke.points.forEach((p, i) => i ? target.lineTo(p.x + offsetX, p.y + offsetY) : target.moveTo(p.x + offsetX, p.y + offsetY));
  if (stroke.points.length === 1) target.lineTo(stroke.points[0].x + offsetX + .1, stroke.points[0].y + offsetY);
  target.stroke(); target.restore();
}
function drawInk(strokes, x = 0, y = 0) {
  inkCtx.clearRect(0, 0, W, H); strokes.forEach(s => drawStroke(inkCtx, s, x, y)); ctx.drawImage(inkCanvas, 0, 0);
}
function drawFigure(f, handles) {
  ctx.save(); ctx.translate(f.x, f.y); ctx.strokeStyle = f.color; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.arc(0, -42, 26, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, -16); ctx.lineTo(0, 60); ctx.stroke();
  f.limbs.forEach((p, i) => { ctx.beginPath(); ctx.moveTo(0, i < 2 ? 7 : 60); ctx.lineTo(p[0] * .58, p[1] * .5 + (i < 2 ? -2 : 34)); ctx.lineTo(...p); ctx.stroke(); });
  ctx.fillStyle = f.color; ctx.beginPath(); ctx.arc(-8, -46, 2, 0, 7); ctx.arc(8, -46, 2, 0, 7); ctx.fill();
  ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, -40, 10, .2, Math.PI - .2); ctx.stroke();
  if (handles) { ctx.strokeStyle = '#89a663'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 6]); ctx.strokeRect(-70, -84, 140, 218); ctx.setLineDash([]);
    f.limbs.forEach(p => { ctx.beginPath(); ctx.arc(...p, 6, 0, 7); ctx.fillStyle = scene.paper; ctx.fill(); ctx.stroke(); }); }
  ctx.restore();
}
function displayedLayer(layer) {
  return recording?.layerId === layer.id ? { ...layer, ...recording.pose } : M.layerAt(scene, layer, elapsed);
}
function selectionBox(box) {
  ctx.save(); ctx.strokeStyle = '#6f8f49'; ctx.fillStyle = '#a4c97b22'; ctx.lineWidth = 2; ctx.setLineDash([7, 5]);
  ctx.fillRect(box.left, box.top, box.right - box.left, box.bottom - box.top);
  ctx.strokeRect(box.left, box.top, box.right - box.left, box.bottom - box.top); ctx.restore();
}
function render() {
  ctx.fillStyle = scene.paper; ctx.fillRect(0, 0, W, H);
  if (!exporting) { ctx.fillStyle = '#dfe4d5'; for (let x = 24; x < W; x += 24) for (let y = 24; y < H; y += 24) { ctx.beginPath(); ctx.arc(x, y, .7, 0, 7); ctx.fill(); } }
  drawInk(gesture?.stroke ? [...scene.strokes, gesture.stroke] : scene.strokes);
  scene.layers.forEach(layer => {
    const view = displayedLayer(layer), handles = !playing && !exporting && view.id === selected && tool === 'select';
    if (view.type === 'figure') drawFigure(view, handles);
    else { drawInk(view.strokes, view.x, view.y); if (handles) selectionBox({ left: view.x - view.width / 2 - 8, top: view.y - view.height / 2 - 8, right: view.x + view.width / 2 + 8, bottom: view.y + view.height / 2 + 8 }); }
  });
  if (!exporting && !playing) {
    if (gesture?.box) selectionBox(gesture.box);
    else if (selectedArt.length) { const box = M.bounds(selectedArt.map(i => scene.strokes[i]).filter(Boolean)); if (box) selectionBox(box); }
  }
  $('emptyHint').hidden = scene.strokes.length > 0 || scene.recordings.length > 0 || scene.layers.some(l => l.type === 'item') || busy();
}
function updateSelection() {
  $('selectionInfo').textContent = selectedArt.length ? `${selectedArt.length} stroke${selectedArt.length === 1 ? '' : 's'} selected` : 'Draw a box around an item to select it.';
  $('makeLayer').disabled = busy() || !selectedArt.length;
}
function point(e) { const r = canvas.getBoundingClientRect(); return { x: M.clamp((e.clientX - r.left) * W / r.width, 0, W), y: M.clamp((e.clientY - r.top) * H / r.height, 0, H) }; }
function layerHit(layer, p) {
  if (layer.type === 'item') return Math.abs(p.x - layer.x) <= layer.width / 2 + 10 && Math.abs(p.y - layer.y) <= layer.height / 2 + 10;
  return (Math.abs(p.x - layer.x) < 64 && p.y > layer.y - 78 && p.y < layer.y + 125) || layer.limbs.some(l => Math.hypot(p.x - layer.x - l[0], p.y - layer.y - l[1]) < 20);
}
canvas.addEventListener('pointerdown', e => {
  if (playing || exporting) return;
  const p = point(e); canvas.setPointerCapture(e.pointerId); canvas.focus({ preventScroll: true });
  if (tool === 'select') {
    const layer = [...scene.layers].reverse().find(l => (!recording || l.id === recording.layerId) && layerHit(displayedLayer(l), p));
    if (!layer) { if (!recording) { selected = null; renderCast(); state(); render(); } return; }
    selected = layer.id; const view = displayedLayer(layer), limb = layer.type === 'figure' ? view.limbs.findIndex(l => Math.hypot(p.x - view.x - l[0], p.y - view.y - l[1]) < 20) : -1;
    gesture = { layer, limb, start: p, initial: M.pose(view), before: recording ? null : M.copy(scene), moved: false };
    selectedArt = []; renderCast(); state(); render();
  } else if (tool === 'art') { if (recording) return; selectedArt = []; gesture = { start: p, box: { left: p.x, top: p.y, right: p.x, bottom: p.y } }; updateSelection(); }
  else { if (recording) return; gesture = { start: p, stroke: { points: [p], color: ink, width: tool === 'eraser' ? brush * 5 : brush, erase: tool === 'eraser' } }; render(); }
});
function applyPoseDelta(layer, initial, next) {
  // Move a whole track consistently, including the origins of all its clips.
  const current = M.layerAt(scene, layer, elapsed), dx = next.x - current.x, dy = next.y - current.y;
  layer.x += dx; layer.y += dy; layer.clips.forEach(c => { c.origin.x += dx; c.origin.y += dy; });
  if (next.limbs && !layer.clips.length) layer.limbs = M.copy(next.limbs);
}
canvas.addEventListener('pointermove', e => {
  if (!gesture) return;
  const p = point(e);
  if (gesture.layer) {
    const g = gesture, next = M.copy(g.initial); g.moved = true;
    if (g.limb >= 0) {
      next.limbs[g.limb] = [M.clamp(p.x - next.x, -125, 125), M.clamp(p.y - next.y, -120, 160)];
      if (!recording && g.layer.clips.length) return toast('Press Record to create a new pose take for this animated character.');
    } else { next.x = M.clamp(g.initial.x + p.x - g.start.x, 0, W); next.y = M.clamp(g.initial.y + p.y - g.start.y, 0, H); }
    if (recording) recording.pose = next; else applyPoseDelta(g.layer, g.initial, next);
  } else if (gesture.box) gesture.box = { left: Math.min(gesture.start.x, p.x), top: Math.min(gesture.start.y, p.y), right: Math.max(gesture.start.x, p.x), bottom: Math.max(gesture.start.y, p.y) };
  else if (tool === 'line') gesture.stroke.points = [gesture.start, p]; else gesture.stroke.points.push(p);
  render();
});
function finishGesture() {
  if (!gesture) return;
  if (gesture.stroke) { remember(); scene.strokes.push(gesture.stroke); selectedArt = []; }
  if (gesture.layer && gesture.moved && gesture.before) { undo.push(gesture.before); redo = []; }
  if (gesture.box) {
    const box = gesture.box;
    scene.strokes.forEach((s, i) => { const b = M.bounds([s]); if (b && b.right >= box.left && b.left <= box.right && b.bottom >= box.top && b.top <= box.bottom) selectedArt.push(i); });
    if (!selectedArt.length) toast('No drawing selected. Draw something, then drag a box around it.');
  }
  gesture = null; updateSelection(); render(); state();
}
canvas.addEventListener('pointerup', finishGesture); canvas.addEventListener('pointercancel', finishGesture);
canvas.addEventListener('keydown', e => {
  const delta = { ArrowLeft: [-5, 0], ArrowRight: [5, 0], ArrowUp: [0, -5], ArrowDown: [0, 5] }[e.key];
  const layer = activeLayer(); if (!delta || !layer || playing || exporting || tool !== 'select') return;
  e.preventDefault(); const initial = M.pose(displayedLayer(layer)), next = M.copy(initial);
  next.x = M.clamp(next.x + delta[0], 0, W); next.y = M.clamp(next.y + delta[1], 0, H);
  if (recording) recording.pose = next; else { remember(); applyPoseDelta(layer, initial, next); } render(); state();
});
$('makeLayer').onclick = () => {
  if (!editAllowed() || !selectedArt.length) return;
  if (scene.layers.length >= 24) return toast('This scene has 24 layers. Create another scene for more.');
  try { const before = M.copy(scene); const layer = M.convertArt(scene, selectedArt, `Item ${scene.layers.filter(l => l.type === 'item').length + 1}`); undo.push(before); redo = []; selected = layer.id; selectedArt = []; setTool('select'); refresh(); toast('Your drawing is now a movable item. Select it and record a take.'); } catch (error) { toast(error.message); }
};
function renderRecordings() {
  $('recordingsTray').replaceChildren();
  if (!scene.recordings.length && !scene.voiceRecordings.length) { const empty = document.createElement('p'); empty.textContent = 'Movement and voice takes will appear here.'; $('recordingsTray').append(empty); }
  [...scene.recordings, ...scene.voiceRecordings].forEach(r => {
    const card = document.createElement('div'); card.className = 'take-card'; card.tabIndex = 0;
    card.setAttribute('aria-label', `${r.name}, ${r.duration.toFixed(1)} seconds. ${r.type === 'voice' ? 'Drag it onto the Voice channel.' : 'Press Enter to add it to a layer.'}`);
    const label = document.createElement('span'), title = document.createElement('b'), info = document.createElement('small');
    title.textContent = r.name; info.textContent = r.type === 'voice' ? `🎙 Voice · ${r.duration.toFixed(1)}s` : `${r.sourceName} · ${r.duration.toFixed(1)}s`; label.append(title, info);
    const add = button('+', r.type === 'voice' ? `Add ${r.name} to Voice at playhead` : `Add ${r.name} to selected layer at playhead`, () => r.type === 'voice' ? placeVoiceRecording(r.id, elapsed) : placeRecording(r.id, selected, elapsed)); add.disabled = busy();
    card.append(label, add); card.addEventListener('pointerdown', e => { if (!e.target.closest('button')) beginClipDrag(e, r.id, null, null, r.type); });
    card.addEventListener('keydown', e => { if (e.target === card && e.key === 'Enter') { e.preventDefault(); r.type === 'voice' ? placeVoiceRecording(r.id, elapsed) : placeRecording(r.id, selected, elapsed); } });
    $('recordingsTray').append(card);
  });
}
function takeForId(recordingId) { return [...scene.recordings, ...scene.voiceRecordings].find(r => r.id === recordingId); }
function placeVoiceRecording(recordingId, time, movingId = null) {
  if (!editAllowed()) return;
  const before = M.copy(scene);
  try {
    const placed = movingId ? M.updateClip(scene, movingId, { start: time }) : M.placeVoiceClip(scene, recordingId, time);
    undo.push(before); redo = []; selectedClip = placed.id; refresh();
    toast('Voice take placed on the Voice channel.');
  } catch (error) { restore(before); toast(error.message); }
}
function placeRecording(recordingId, layerId, time, movingId = null) {
  if (!editAllowed()) return;
  try {
    const before = M.copy(scene); const clip = M.placeClip(scene, recordingId, layerId, time, movingId);
    undo.push(before); redo = []; selectedClip = clip.id; selected = layerId;
    refresh(); toast(movingId ? 'Clip moved.' : 'Take added. Press play to see your layers together.');
  } catch (error) { toast(error.message); }
}
function renderChannels() {
  const span = timelineSpan(); $('channels').replaceChildren();
  $('ruler').replaceChildren(...Array.from({ length: 11 }, (_, i) => { const el = document.createElement('span'); el.textContent = `${(i * span / 10).toFixed(span % 10 ? 1 : 0)}s`; return el; }));
  scene.layers.forEach(layer => {
    const row = document.createElement('div'); row.className = 'channel-row' + (selected === layer.id ? ' selected-channel' : '');
    const label = button(`${layer.type === 'figure' ? '♧' : '◇'} ${layer.name}`, `Select channel ${layer.name}`, () => selectLayer(layer.id), 'channel-name'); label.disabled = busy();
    const lane = document.createElement('div'); lane.className = 'channel-lane'; lane.dataset.layerId = layer.id; lane.dataset.channelType = layer.type;
    lane.setAttribute('aria-label', `${layer.name} timeline`);
    if (!layer.clips.length) { const hint = document.createElement('span'); hint.className = 'lane-hint'; hint.textContent = 'Drop a take here'; lane.append(hint); }
    layer.clips.forEach(clip => renderClip(lane, clip, layer, span));
    const head = document.createElement('div'); head.className = 'channel-playhead'; lane.append(head);
    if (recording?.layerId === layer.id) { const live = document.createElement('div'); live.className = 'live-recording'; lane.append(live); }
    row.append(label, lane); $('channels').append(row);
  });
  if (!scene.layers.length) { const empty = document.createElement('p'); empty.className = 'empty-channels'; empty.textContent = 'Add a character or make an item layer to create a channel.'; $('channels').append(empty); }
  const lane = $('voiceLane'); lane.replaceChildren();
  if (!scene.voiceClips.length && !voiceRecording) { const hint = document.createElement('span'); hint.className = 'lane-hint'; hint.textContent = 'Record a voice, then place it here'; lane.append(hint); }
  const voiceLayer = { id: 'voice', name: 'Voice', type: 'voice', clips: scene.voiceClips };
  scene.voiceClips.forEach(clip => renderClip(lane, clip, voiceLayer, span));
  if (voiceRecording) { const live = document.createElement('div'); live.className = 'live-recording'; live.style.left = `${voiceRecording.start / span * 100}%`; live.style.width = `${Math.max(.5, (elapsed - voiceRecording.start) / span * 100)}%`; lane.append(live); }
  const head = document.createElement('div'); head.className = 'channel-playhead'; lane.append(head);
  updateClock();
}
function renderClip(lane, clip, layer, span) {
  const take = M.recordingFor(scene, clip), wrapper = document.createElement('div');
  wrapper.className = 'timeline-clip' + (selectedClip === clip.id ? ' chosen' : ''); wrapper.dataset.clipId = clip.id;
  wrapper.style.left = `${clip.start / span * 100}%`; wrapper.style.width = `${M.clipDuration(scene, clip) / span * 100}%`;
  wrapper.title = `${take.name}: ${clip.start.toFixed(1)}s · ${M.trimIn(clip).toFixed(1)}–${M.trimOut(scene, clip).toFixed(1)}s from source. Drag the ends to trim.`;
  const left = button('', `Trim start of ${take.name}`, () => {}, 'trim-handle trim-left');
  const body = button(take.name, `${take.name} on ${layer.name}; starts ${clip.start.toFixed(1)} seconds; source ${M.trimIn(clip).toFixed(1)} to ${M.trimOut(scene, clip).toFixed(1)} seconds`, () => { if (!busy()) { selectedClip = clip.id; renderInspector(); renderChannels(); } }, 'clip-body');
  const right = button('', `Trim end of ${take.name}`, () => {}, 'trim-handle trim-right');
  [left, body, right].forEach(el => { el.dataset.clipId = clip.id; el.disabled = busy(); });
  left.addEventListener('pointerdown', e => beginClipDrag(e, take.id, clip, lane, clip.kind, 'trim-in'));
  body.addEventListener('pointerdown', e => beginClipDrag(e, take.id, clip, lane, clip.kind, 'move'));
  right.addEventListener('pointerdown', e => beginClipDrag(e, take.id, clip, lane, clip.kind, 'trim-out'));
  wrapper.append(left, body, right); lane.append(wrapper);
}
function updateClock() {
  const span = timelineSpan(); $('currentTime').textContent = format(elapsed); $('duration').textContent = format(duration());
  $('scrub').max = span; $('scrub').value = elapsed;
  document.querySelectorAll('.channel-playhead').forEach(head => head.style.left = `${elapsed / span * 100}%`);
  if (recording) { const live = document.querySelector('.live-recording'); if (live) { live.style.left = `${recording.start / span * 100}%`; live.style.width = `${Math.max(0, elapsed - recording.start) / span * 100}%`; } }
}
function clipDetails() {
  const owner = scene.layers.find(l => l.clips.some(c => c.id === selectedClip));
  const clip = owner?.clips.find(c => c.id === selectedClip) || scene.voiceClips.find(c => c.id === selectedClip);
  const layer = owner || (clip?.kind === 'voice' ? { id: 'voice', name: 'Voice', type: 'voice', clips: scene.voiceClips } : null);
  return { layer, clip, take: clip ? M.recordingFor(scene, clip) : null };
}
function renderInspector() {
  const { layer, clip, take } = clipDetails(); $('clipInspector').hidden = !clip;
  if (!clip) return;
  $('clipName').textContent = take.name; $('clipLayer').replaceChildren();
  scene.layers.filter(l => l.type === take.type).forEach(l => { const option = document.createElement('option'); option.value = l.id; option.textContent = l.name; $('clipLayer').append(option); });
  $('clipLayerLabel').hidden = clip.kind === 'voice';
  if (clip.kind !== 'voice') $('clipLayer').value = layer.id;
  $('clipStart').value = clip.start.toFixed(1); $('clipIn').value = M.trimIn(clip).toFixed(1); $('clipOut').value = M.trimOut(scene, clip).toFixed(1);
  $('clipInspector').querySelectorAll('input,select,button').forEach(el => el.disabled = busy());
}
function beginClipDrag(e, recordingId, clip = null, lane = null, kind = 'figure', mode = 'move') {
  if (busy() || e.button !== 0) return;
  const span = timelineSpan(), box = lane?.getBoundingClientRect();
  const offset = clip && box ? (e.clientX - box.left) / box.width * span - clip.start : 0;
  clipDrag = { recordingId, clipId: clip?.id || null, kind, mode, offset, span, x: e.clientX, y: e.clientY, laneWidth: box?.width || 1, laneLeft: box?.left || 0,
    oldStart: clip?.start || 0, trimIn: clip ? M.trimIn(clip) : 0, trimOut: clip ? M.trimOut(scene, clip) : 0, moving: false, pointerId: e.pointerId };
  e.currentTarget.setPointerCapture(e.pointerId);
}
document.addEventListener('pointermove', e => {
  if (!clipDrag || e.pointerId !== clipDrag.pointerId) return;
  if (!clipDrag.moving && Math.hypot(e.clientX - clipDrag.x, e.clientY - clipDrag.y) < 6) return;
  clipDrag.moving = true; e.preventDefault();
  if (!dragGhost) { dragGhost = document.createElement('div'); dragGhost.className = 'clip-drag-ghost'; document.body.append(dragGhost); }
  const take = takeForId(clipDrag.recordingId), lane = document.elementFromPoint(e.clientX, e.clientY)?.closest('.channel-lane');
  const start = lane ? Math.max(0, (e.clientX - lane.getBoundingClientRect().left) / lane.getBoundingClientRect().width * clipDrag.span - clipDrag.offset) : null;
  dragGhost.textContent = clipDrag.mode.startsWith('trim') ? `${take.name} · trim ${clipDrag.mode === 'trim-in' ? 'in' : 'out'}` : `${take.name}${start !== null ? ` · ${start.toFixed(1)}s` : ' · Drop on a matching channel'}`;
  dragGhost.style.left = `${e.clientX + 12}px`; dragGhost.style.top = `${e.clientY + 12}px`;
  document.querySelectorAll('.channel-lane').forEach(el => el.classList.toggle('drop-target', el === lane));
}, { passive: false });
function finishClipDrag(e) {
  if (!clipDrag) return;
  const drag = clipDrag; clipDrag = null; dragGhost?.remove(); dragGhost = null;
  document.querySelectorAll('.channel-lane').forEach(el => el.classList.remove('drop-target'));
  if (!drag.moving || e.type === 'pointercancel') return;
  if (drag.mode.startsWith('trim')) {
    const delta = (e.clientX - drag.x) / drag.laneWidth * drag.span;
    const changes = drag.mode === 'trim-in' ? { trimIn: M.clamp(drag.trimIn + delta, 0, drag.trimOut - .1), start: Math.max(0, drag.oldStart + delta) } : { trimOut: M.clamp(drag.trimOut + delta, drag.trimIn + .1, takeForId(drag.recordingId).duration) };
    const before = M.copy(scene);
    try { M.updateClip(scene, drag.clipId, changes); undo.push(before); redo = []; refresh(); toast('Clip trimmed. Drag an edge again to adjust it.'); }
    catch (error) { restore(before); toast(error.message); }
    return;
  }
  const lane = document.elementFromPoint(e.clientX, e.clientY)?.closest('.channel-lane');
  if (!lane) return toast('Drop the take on a matching channel.');
  const start = Math.max(0, (e.clientX - lane.getBoundingClientRect().left) / lane.getBoundingClientRect().width * drag.span - drag.offset);
  if (drag.kind === 'voice') {
    if (lane.dataset.channelType && lane.dataset.channelType !== 'voice') return toast('Voice takes belong on the Voice channel.');
    placeVoiceRecording(drag.recordingId, start, drag.clipId);
  } else {
    if (!lane.dataset.layerId || lane.dataset.channelType !== takeForId(drag.recordingId)?.type) return toast('Drop this take on a matching character or item channel.');
    placeRecording(drag.recordingId, lane.dataset.layerId, start, drag.clipId);
  }
}
document.addEventListener('pointerup', finishClipDrag); document.addEventListener('pointercancel', finishClipDrag);
$('applyClip').onclick = () => {
  const { clip } = clipDetails(); if (!clip || !editAllowed()) return;
  const before = M.copy(scene);
  try {
    if (clip.kind === 'voice') M.updateClip(scene, clip.id, { start: Number($('clipStart').value), trimIn: Number($('clipIn').value), trimOut: Number($('clipOut').value) });
    else M.placeClip(scene, clip.recordingId, $('clipLayer').value, Number($('clipStart').value), clip.id), M.updateClip(scene, clip.id, { trimIn: Number($('clipIn').value), trimOut: Number($('clipOut').value) });
    undo.push(before); redo = []; refresh(); toast('Clip timing updated.');
  } catch (error) { restore(before); toast(error.message); }
};
$('removeClip').onclick = () => {
  if (!editAllowed()) return; const { layer, clip } = clipDetails(); if (!clip) return;
  remember(); if (clip.kind === 'voice') scene.voiceClips = scene.voiceClips.filter(c => c.id !== clip.id); else layer.clips = layer.clips.filter(c => c.id !== clip.id);
  selectedClip = null; refresh(); toast('Clip removed. The original take is still in Recordings.');
};
async function ensureAudioContext() {
  const Constructor = window.AudioContext || window.webkitAudioContext;
  if (!Constructor) throw new Error('Audio playback is unavailable in this browser.');
  if (!audioContext || audioContext.state === 'closed') audioContext = new Constructor();
  if (audioContext.state === 'suspended') await audioContext.resume();
  return audioContext;
}
async function decodeVoice(take) {
  if (voiceDecoded.has(take.id)) return voiceDecoded.get(take.id);
  const context = await ensureAudioContext();
  const bytes = await take.blob.arrayBuffer();
  const buffer = await context.decodeAudioData(bytes);
  voiceDecoded.set(take.id, buffer); return buffer;
}
function stopVoiceSources() {
  voiceNodes.forEach(node => { try { node.stop(); } catch {} }); voiceNodes = [];
  voiceTimers.forEach(clearTimeout); voiceTimers = [];
}
function voiceSegments(allScenes) {
  const list = allScenes ? scenes : [scene];
  return list.flatMap(item => item.voiceClips.map(clip => ({ item, clip, offset: allScenes ? M.sceneOffset(scenes, item.id) : 0 })));
}
async function scheduleVoicePlayback(allScenes, globalTime = 0, destination = null) {
  stopVoiceSources();
  const segments = voiceSegments(allScenes);
  if (!segments.length) return;
  const context = await ensureAudioContext();
  const target = destination || context.destination;
  for (const { item, clip, offset } of segments) {
    const begins = offset + clip.start;
    const ends = offset + M.clipEnd(item, clip);
    if (ends <= globalTime) continue;
    const take = M.recordingFor(item, clip), buffer = await decodeVoice(take);
    const skip = Math.max(0, globalTime - begins), sourceOffset = M.trimIn(clip) + skip;
    const playDuration = Math.min(M.trimOut(item, clip) - sourceOffset, ends - Math.max(globalTime, begins));
    if (playDuration <= .01) continue;
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(target);
    const when = context.currentTime + Math.max(0, begins - globalTime);
    source.start(when, sourceOffset, playDuration); voiceNodes.push(source);
  }
}
function state() {
  const locked = busy();
  $('record').classList.toggle('recording', !!recording);
  $('record').innerHTML = '<span class="record-dot"></span>' + (recording ? 'Stop' : 'Record');
  $('record').disabled = exporting || playing || !!voiceRecording || (!recording && !activeLayer());
  $('recordVoice').classList.toggle('recording', !!voiceRecording && !voiceRecording.pending);
  $('recordVoice').textContent = voiceRecording ? '■ Stop voice' : '🎙 Record voice';
  $('recordVoice').disabled = !!recording || (playing && !voiceRecording) || exporting;
  $('play').disabled = !!recording || !!voiceRecording || exporting || (!playing && !duration());
  $('play').textContent = playing && !storyPlayback ? 'Ⅱ' : '▶';
  $('play').setAttribute('aria-label', playing && !storyPlayback ? 'Pause scene' : 'Play scene');
  $('playStory').disabled = !!recording || (!!voiceRecording && !voiceRecording.pending) || exporting;
  $('playStory').textContent = storyPlayback && playing ? 'Ⅱ Pause story' : '▶ Play whole story';
  $('export').disabled = locked;
  $('export').title = 'Export every scene and recorded voice in story order';
  $('add').disabled = locked; $('newScene').disabled = locked; $('sceneName').disabled = locked;
  $('rewind').disabled = !!recording || !!voiceRecording || exporting; $('scrub').disabled = !!recording || !!voiceRecording || exporting;
  $('undo').disabled = locked || !undo.length; $('redo').disabled = locked || !redo.length; $('clear').disabled = locked || !scene.strokes.length;
  $('status').textContent = exporting ? '● Preparing your story video' : voiceRecording ? (voiceRecording.pending ? '● Requesting microphone' : '● Recording voice') : recording ? `● Recording ${activeLayer()?.name}` : playing ? (storyPlayback ? '● Playing the whole story' : '● Playing scene layers') : '● Ready when you are';
  $('recordTip').textContent = voiceRecording ? 'Speak naturally. Press Stop voice when you’re finished.' : recording ? 'Other layers play along. Move the selected layer.' : activeLayer() ? `Record ${activeLayer().name} at ${elapsed.toFixed(1)}s` : 'Select a layer to record.';
  $('recordLabel').textContent = `${scene.layers.length} LAYERS · ${scene.recordings.length + scene.voiceRecordings.length} TAKES`;
  $('take').textContent = String(scene.recordings.length + scene.voiceRecordings.length).padStart(2, '0');
  document.querySelectorAll('[data-tool], #ink button, #paper button, #customColor, #brush').forEach(el => el.disabled = locked);
  document.querySelectorAll('.scene-tab, .story-segment, .take-card button, .timeline-clip button, .channel-name, .cast-row button').forEach(el => el.disabled = locked);
  $('clipInspector').querySelectorAll('input,select,button').forEach(el => el.disabled = locked);
  updateSelection(); renderStoryOverview();
}
function refresh() { renderScenes(); renderCast(); renderRecordings(); renderChannels(); renderInspector(); state(); render(); }
function startRecording() {
  if (recording) return stopRecording();
  if (busy() || !activeLayer()) return;
  if (elapsed >= 600) return toast('Move the playhead before 600 seconds to record.');
  stopVoiceSources(); storyPlayback = false; gesture = null; setTool('select'); selectedArt = [];
  const layer = activeLayer(), initial = M.pose(M.layerAt(scene, layer, elapsed));
  recording = { layerId: layer.id, type: layer.type, sourceName: layer.name, start: elapsed, frames: [{ t: 0, pose: M.copy(initial) }], pose: initial, lastSample: 0 };
  startTime = performance.now() - elapsed * 1000; refresh();
}
function stopRecording() {
  if (!recording) return;
  const localTime = Math.max(.1, Math.min(120, elapsed - recording.start));
  recording.frames.push({ t: localTime, pose: M.copy(recording.pose) }); remember();
  scene.recordings.push({ id: M.id('take'), name: `Take ${++recordingCounter}`, sourceName: recording.sourceName, sourceLayerId: recording.layerId, type: recording.type, duration: localTime, frames: recording.frames });
  elapsed = recording.start; recording = null; gesture = null; refresh();
  toast('Take saved. Drag it onto a matching channel, or press ＋ to place it.');
}
async function stopVoiceRecording() {
  if (!voiceRecording || voiceRecording.pending) return;
  const active = voiceRecording; voiceRecording = null;
  const seconds = Math.max(.1, (performance.now() - active.startedAt) / 1000);
  try { if (active.recorder.state !== 'inactive') active.recorder.stop(); } catch {}
  active.stream.getTracks().forEach(track => track.stop());
  await active.stopped;
  const blob = new Blob(active.chunks, { type: active.recorder.mimeType || 'audio/webm' });
  if (!blob.size) { refresh(); return toast('No voice audio was captured. Check your microphone and try again.'); }
  remember();
  const take = { id: M.id('voice-take'), name: `Voice ${++voiceCounter}`, type: 'voice', duration: Math.min(120, seconds), blob, url: URL.createObjectURL(blob) };
  scene.voiceRecordings.push(take);
  const clip = M.placeVoiceClip(scene, take.id, active.start); selectedClip = clip.id; elapsed = active.start;
  refresh(); toast('Voice take saved and placed on the Voice channel. Drag its edges to trim it.');
}
async function startVoiceRecording() {
  if (voiceRecording && !voiceRecording.pending) return stopVoiceRecording();
  if (busy()) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('Voice recording needs microphone support. Try a recent Chrome, Edge, or Safari browser.');
  voiceRecording = { pending: true, start: elapsed }; state();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    if (!voiceRecording) { stream.getTracks().forEach(track => track.stop()); return; }
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(t => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {}), chunks = [];
    const active = { pending: false, start: elapsed, startedAt: performance.now(), recorder, chunks, stream };
    active.stopped = new Promise(resolve => { recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); }; recorder.onstop = resolve; });
    recorder.onerror = () => toast('Microphone recording stopped unexpectedly.');
    voiceRecording = active; recorder.start(100); refresh();
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop()); voiceRecording = null; state();
    toast(error.name === 'NotAllowedError' ? 'Allow microphone access in your browser to record a voice take.' : 'Could not start the microphone. Check that it is connected and try again.');
  }
}
function findStoryScene(time) {
  for (let i = 0; i < scenes.length; i++) {
    const offset = M.sceneOffset(scenes, scenes[i].id), span = Math.max(3, M.sceneDuration(scenes[i]));
    if (time < offset + span || i === scenes.length - 1) return { item: scenes[i], offset, time: M.clamp(time - offset, 0, M.sceneDuration(scenes[i])) };
  }
  return { item: scenes[0], offset: 0, time: 0 };
}
function displayStoryTime(time) {
  const result = findStoryScene(time), changed = scene.id !== result.item.id;
  scene = result.item; elapsed = result.time; storyElapsed = time;
  if (changed) { selected = scene.layers[0]?.id || null; selectedClip = null; renderScenes(); renderCast(); renderRecordings(); renderChannels(); renderInspector(); }
  if (changed) renderStoryOverview(); updateClock(); render();
}
async function beginPlayback(allScenes) {
  if (recording || voiceRecording || exporting || (!allScenes && !duration())) return;
  if (playing) { playing = false; storyPlayback = false; stopVoiceSources(); state(); return; }
  storyPlayback = allScenes;
  if (allScenes) {
    storyElapsed = 0;
    displayStoryTime(storyElapsed);
  } else if (elapsed >= duration()) elapsed = 0;
  playing = true; state();
  try {
    const time = allScenes ? storyElapsed : elapsed;
    await scheduleVoicePlayback(allScenes, time);
    if (!playing) return;
    startTime = performance.now() - time * 1000;
  } catch (error) { playing = false; state(); toast(error.message || 'Could not play the recorded voice.'); return; }
  render();
}
function tick(now) {
  if (recording) {
    const oldSpan = timelineSpan(); elapsed = Math.min(600, recording.start + 120, (now - startTime) / 1000);
    const local = elapsed - recording.start;
    if (local - recording.lastSample >= 1 / 30) { recording.frames.push({ t: local, pose: M.copy(recording.pose) }); recording.lastSample = local; }
    if (timelineSpan() !== oldSpan) renderChannels(); updateClock(); render(); if (local >= 120 || elapsed >= 600) stopRecording();
  } else if (voiceRecording && !voiceRecording.pending) {
    elapsed = Math.min(voiceRecording.start + 120, voiceRecording.start + (now - voiceRecording.startedAt) / 1000);
    updateClock(); renderChannels();
    if (elapsed - voiceRecording.start >= 120) stopVoiceRecording();
  } else if (playing) {
    const time = Math.max(0, (now - startTime) / 1000);
    if (storyPlayback) {
      if (time >= wholeStoryDuration()) { storyElapsed = wholeStoryDuration(); const last = findStoryScene(storyElapsed - .001); scene = last.item; elapsed = M.sceneDuration(scene); playing = false; stopVoiceSources(); state(); }
      else displayStoryTime(time);
    } else {
      elapsed = time;
      if (elapsed >= duration()) { if (loop && !exporting) { elapsed = 0; startTime = now; scheduleVoicePlayback(false, 0).catch(() => {}); } else { elapsed = duration(); playing = false; stopVoiceSources(); state(); } }
      updateClock(); render();
    }
  }
  requestAnimationFrame(tick);
}
$('record').onclick = startRecording;
$('recordVoice').onclick = () => { if (voiceRecording?.pending) { voiceRecording = null; state(); toast('Microphone request cancelled.'); } else if (voiceRecording) stopVoiceRecording(); else startVoiceRecording(); };
$('play').onclick = () => beginPlayback(false);
$('playStory').onclick = () => beginPlayback(true);
$('rewind').onclick = () => { if (recording || voiceRecording || exporting) return; playing = false; storyPlayback = false; stopVoiceSources(); elapsed = 0; storyElapsed = M.sceneOffset(scenes, scene.id); updateClock(); state(); render(); };
$('scrub').oninput = () => {
  if (recording || voiceRecording || exporting) return; playing = false; storyPlayback = false; stopVoiceSources(); elapsed = Number($('scrub').value); updateClock(); state(); render();
};
$('loop').onclick = () => { loop = !loop; $('loop').setAttribute('aria-pressed', loop); };
async function exportStory() {
  if (busy()) return;
  if (!canvas.captureStream || !window.MediaRecorder) return toast('Video export is unavailable here. Try Chrome or Edge.');
  let stream, recorder, audioDestination; const chunks = [], storyLength = wholeStoryDuration();
  const finish = () => { stream?.getTracks().forEach(t => t.stop()); stopVoiceSources(); audioContext?.close().catch(() => {}); audioContext = null; voiceDecoded.clear(); exporting = false; playing = false; storyPlayback = false; refresh(); };
  try {
    exporting = true; playing = false; storyPlayback = true; storyElapsed = 0; displayStoryTime(0); render(); state();
    stream = canvas.captureStream(30);
    if (scenes.some(item => item.voiceClips.length)) {
      const context = await ensureAudioContext(); audioDestination = context.createMediaStreamDestination();
      await Promise.all(voiceSegments(true).map(({ item, clip }) => decodeVoice(M.recordingFor(item, clip))));
      audioDestination.stream.getAudioTracks().forEach(track => stream.addTrack(track));
    }
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/mp4', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onerror = () => { recorder.onstop = null; finish(); toast('Video export failed. Please try again.'); };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType }), url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `stickfigure-story.${recorder.mimeType.includes('mp4') ? 'mp4' : 'webm'}`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000); finish(); toast('Your full story video has downloaded, with recorded voices.');
    };
    recorder.start(); playing = true; startTime = performance.now();
    if (audioDestination) await scheduleVoicePlayback(true, 0, audioDestination);
    state(); toast('Making your whole story video… keep this tab open.');
    const end = () => { if (!playing) { if (recorder.state !== 'inactive') recorder.stop(); } else requestAnimationFrame(end); }; requestAnimationFrame(end);
    // `storyLength` is also used by the story clock and every scheduled voice take.
    void storyLength;
  } catch (error) { finish(); toast(error.message || 'This browser could not export your story video.'); }
}
$('export').onclick = exportStory;
$('add').onclick = addFigure; $('newScene').onclick = addScene;
$('sceneName').onchange = () => { if (busy()) return; const name = $('sceneName').value.trim(); if (!name) { $('sceneName').value = scene.name; return; } remember(); scene.name = name; renderScenes(); state(); };
$('sceneName').onkeydown = e => { if (e.key === 'Enter') e.target.blur(); };
document.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => { if (!busy()) setTool(b.dataset.tool); });
function palette(id, callback) { $(id).querySelectorAll('[data-color]').forEach(b => b.onclick = () => { if (!editAllowed()) return; $(id).querySelectorAll('.swatch').forEach(s => s.classList.remove('selected')); b.classList.add('selected'); callback(b.dataset.color, b); render(); state(); }); }
palette('ink', (color, b) => { ink = color; $('colorName').textContent = b.getAttribute('aria-label'); });
palette('paper', color => { remember(); scene.paper = color; });
$('customColor').oninput = e => { ink = e.target.value; $('colorName').textContent = 'Custom'; $('ink').querySelectorAll('.swatch').forEach(s => s.classList.remove('selected')); };
$('brush').oninput = e => { brush = Number(e.target.value); $('brushValue').textContent = `${brush} px`; };
$('undo').onclick = () => { if (!editAllowed() || !undo.length) return; redo.push(M.copy(scene)); restore(undo.pop()); };
$('redo').onclick = () => { if (!editAllowed() || !redo.length) return; undo.push(M.copy(scene)); restore(redo.pop()); };
$('clear').onclick = () => { if (!editAllowed() || !scene.strokes.length) return; remember(); scene.strokes = []; selectedArt = []; refresh(); toast('Background cleared. Undo will restore it.'); };
$('help').onclick = () => $('helpDialog').showModal(); $('closeHelp').onclick = $('letsGo').onclick = () => $('helpDialog').close();
scene.layers.push(M.makeFigure(1)); selected = scene.layers[0].id;
refresh(); requestAnimationFrame(tick);
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  try { Promise.resolve(document.modelContext.registerTool({ name: 'add_stick_figure', description: 'Add one stick figure and its channel to the current scene.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false }, execute(input) {
    if (!input || typeof input !== 'object' || Object.keys(input).length) throw new Error('Expected an empty object.');
    if (busy() || scene.layers.length >= 24) throw new Error('Stop the take and ensure there is room in the scene.');
    addFigure(); return { id: selected, count: scene.layers.length };
  } }, { signal: lifecycle.signal })).catch(() => {}); window.addEventListener('pagehide', () => lifecycle.abort(), { once: true }); } catch { /* Older browsers do not support WebMCP. */ }
}
