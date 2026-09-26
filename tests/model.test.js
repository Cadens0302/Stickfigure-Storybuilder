'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../dist/model.js');
function fixture() {
  const scene = M.makeScene(1), a = M.makeFigure(1), b = M.makeFigure(2);
  a.x = 100; b.x = 500; scene.layers.push(a, b);
  const first = M.pose(a), last = { ...M.copy(first), x: 300, y: 405 };
  last.limbs[0] = [-80, -60];
  const take = { id: M.id('take'), type: 'figure', duration: 2, frames: [{ t: 0, pose: first }, { t: 2, pose: last }] };
  scene.recordings.push(take); return { scene, a, b, take };
}
test('independent channels interpolate together and hold their final positions', () => {
  const { scene, a, b, take } = fixture();
  M.placeClip(scene, take.id, a.id, 0); M.placeClip(scene, take.id, b.id, 1);
  assert.equal(M.layerAt(scene, a, 1.5).x, 250);
  assert.equal(M.layerAt(scene, b, 1.5).x, 550);
  assert.equal(M.layerAt(scene, a, 10).x, 300);
  assert.equal(M.layerAt(scene, b, .5).x, 500);
  assert.equal(M.sceneDuration(scene), 3);
  assert.equal(a.x, 100, 'playback must not overwrite the editable starting pose');
});
test('overlapping moves fail atomically without deleting either clip', () => {
  const { scene, a, b, take } = fixture();
  const clip = M.placeClip(scene, take.id, a.id, 0); M.placeClip(scene, take.id, b.id, 1);
  const before = M.copy(scene);
  assert.throws(() => M.placeClip(scene, take.id, b.id, 2, clip.id), /overlap/);
  assert.deepEqual(scene, before);
  assert.throws(() => M.placeClip(scene, take.id, a.id, -1), /between/);
  assert.throws(() => M.placeClip(scene, take.id, a.id, NaN), /between/);
});
test('clips can be shifted and transferred with relative movement and contiguous takes', () => {
  const { scene, a, b, take } = fixture();
  const clip = M.placeClip(scene, take.id, a.id, 0);
  M.placeClip(scene, take.id, a.id, 2, clip.id);
  assert.equal(M.layerAt(scene, a, 3).x, 200);
  M.placeClip(scene, take.id, b.id, 1, clip.id);
  assert.equal(a.clips.length, 0); assert.equal(b.clips.length, 1);
  assert.equal(M.layerAt(scene, b, 2).x, 600);
  M.placeClip(scene, take.id, b.id, 3);
  assert.equal(M.layerAt(scene, b, 4).x, 800);
});
test('selected drawing strokes become one movable layer without shifting their visible position', () => {
  const scene = M.makeScene(1);
  scene.strokes = [{ color: '#000', width: 4, points: [{ x: 10, y: 20 }, { x: 100, y: 120 }] }, { color: '#f00', width: 2, points: [{ x: 500, y: 500 }] }];
  const first = M.copy(scene.strokes[0]);
  const item = M.convertArt(scene, [0], 'Ball');
  assert.equal(scene.strokes.length, 1); assert.equal(item.type, 'item');
  item.strokes[0].points.forEach((p, i) => { assert.equal(p.x + item.x, first.points[i].x); assert.equal(p.y + item.y, first.points[i].y); });
  const r = { id: M.id('take'), type: 'item', duration: 1, frames: [{ t: 0, pose: M.pose(item) }, { t: 1, pose: { x: item.x + 80, y: item.y + 30 } }] };
  scene.recordings.push(r); M.placeClip(scene, r.id, item.id, 0);
  assert.equal(M.layerAt(scene, item, .5).x, item.x + 40);
  const character = M.makeFigure(1); scene.layers.push(character);
  assert.throws(() => M.placeClip(scene, r.id, character.id, 0), /matching layer/);
});
test('scenes retain separate drawings, layers and recordings', () => {
  const { scene, a, take } = fixture(); const second = M.makeScene(2);
  M.placeClip(scene, take.id, a.id, 0);
  second.name = 'The chase'; second.paper = '#eaf1f6'; second.layers.push(M.makeFigure(1));
  assert.equal(scene.name, 'Scene 01'); assert.equal(scene.paper, '#fffef9');
  assert.equal(second.recordings.length, 0); assert.equal(M.sceneDuration(second), 0);
  assert.equal(M.sceneDuration(scene), 2); assert.notEqual(second.layers[0].id, a.id);
});
test('trimmed movement samples the matching source interval and frees its old timeline space', () => {
  const { scene, a, take } = fixture();
  const clip = M.placeClip(scene, take.id, a.id, 0);
  M.updateClip(scene, clip.id, { trimIn: .5, trimOut: 1.5 });
  assert.equal(M.clipDuration(scene, clip), 1);
  assert.equal(M.clipEnd(scene, clip), 1);
  assert.equal(M.layerAt(scene, a, .5).x, 200);
  assert.equal(M.layerAt(scene, a, 1).x, 250);
  assert.equal(M.layerAt(scene, a, 1.5).x, 250, 'hold the trim-out pose instead of playing the removed tail');
  assert.equal(M.sceneDuration(scene), 1);
  M.placeClip(scene, take.id, a.id, 1);
  assert.equal(a.clips.length, 2);
});
test('voice clips trim independently, extend scene length, and contribute to sequential story offsets', () => {
  const first = M.makeScene(1), second = M.makeScene(2);
  first.voiceRecordings.push({ id: 'voice-1', type: 'voice', duration: 8, blob: new Blob(['audio']) });
  const voice = M.placeVoiceClip(first, 'voice-1', 1);
  M.updateClip(first, voice.id, { trimIn: 2, trimOut: 5 });
  assert.equal(M.clipEnd(first, voice), 4);
  assert.equal(M.sceneDuration(first), 4);
  second.layers.push(M.makeFigure(1));
  assert.equal(M.storyDuration([first, second]), 7);
  assert.equal(M.sceneOffset([first, second], second.id), 4);
  const snapshot = M.copy(first);
  assert.equal(snapshot.voiceRecordings[0].blob.size, 5);
});
