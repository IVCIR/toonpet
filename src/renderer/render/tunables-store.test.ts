/**
 * 渲染进程参数表的测试（ADR 0052 D3）。
 *
 * 这里只验"热更新入口"的语义：改内存、下一帧可读、非法输入被忽略、
 * 变化 id 恰好是真正变的那些。它与主进程共用 `shared/tunable-params` 的夹取。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTunableStore } from './tunables-store';
import { GAZE_EYE_STIFFNESS, SIT_SPINE_OVERLAY_WEIGHT } from '../../shared/constants';

test('参数表：默认值来自契约，读取是 O(1)', () => {
  const store = createTunableStore();
  assert.equal(store.get('gaze.eyeStiffness'), GAZE_EYE_STIFFNESS);
  assert.equal(store.get('sit.spineOverlayWeight'), SIT_SPINE_OVERLAY_WEIGHT);
});

test('参数表：apply 返回真正变化的 id，重复应用不再算变化', () => {
  const store = createTunableStore();
  assert.deepEqual(store.apply({ 'sit.phaseAHeadTuneRad': -0.12 }), ['sit.phaseAHeadTuneRad']);
  assert.equal(store.get('sit.phaseAHeadTuneRad'), -0.12);
  assert.deepEqual(store.apply({ 'sit.phaseAHeadTuneRad': -0.12 }), []);
  assert.deepEqual(store.apply({ 'gaze.eyeStiffness': 16, 'sit.phaseAHeadTuneRad': -0.12 }), [
    'gaze.eyeStiffness',
  ]);
  assert.equal(store.get('gaze.eyeStiffness'), 16);
});

test('参数表：非法 id / 非有限数被忽略（不抛错、不改值）', () => {
  const store = createTunableStore();
  assert.deepEqual(store.apply({ nonsense: 3, 'gaze.headStiffness': Number.NaN }), []);
  assert.equal(store.get('gaze.headStiffness'), 8);
  assert.deepEqual(store.apply(null), []);
  assert.deepEqual(store.apply('nope'), []);
  // 越界会被夹到区间边界（与主进程同一套规则），所以算"变化"
  assert.deepEqual(store.apply({ 'gaze.eyeStiffness': 999 }), ['gaze.eyeStiffness']);
  assert.equal(store.get('gaze.eyeStiffness'), 30);
});

test('参数表：values() 返回拷贝，外部改不到内部状态', () => {
  const store = createTunableStore({ 'sit.phaseAHeadTuneRad': -0.1 });
  const snapshot = store.values();
  snapshot['sit.phaseAHeadTuneRad'] = 99;
  assert.equal(store.get('sit.phaseAHeadTuneRad'), -0.1);
});

test('参数表：reset / restoreDefaults 回到契约默认值', () => {
  const store = createTunableStore();
  store.apply({ 'gaze.spineStiffness': 9, 'sit.spineOverlayWeight': 0.8 });
  store.reset();
  assert.equal(store.get('gaze.spineStiffness'), 4);
  assert.equal(store.get('sit.spineOverlayWeight'), SIT_SPINE_OVERLAY_WEIGHT);
  store.apply({ 'gaze.spineStiffness': 9 });
  store.restoreDefaults();
  assert.equal(store.get('gaze.spineStiffness'), 4);
});

test('参数表：初始值走同一套夹取（config.json 的坏值不会进渲染侧）', () => {
  const store = createTunableStore({ 'sit.phaseAHeadTuneRad': -8, 'gaze.eyeStiffness': 'oops' });
  assert.equal(store.get('sit.phaseAHeadTuneRad'), -0.3);
  assert.equal(store.get('gaze.eyeStiffness'), GAZE_EYE_STIFFNESS);
});
