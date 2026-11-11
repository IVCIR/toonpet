/**
 * 可调参数契约的纯函数测试（ADR 0052 D3/D5）。
 *
 * 断言的是"跨进程只有一套夹取"这条规则：面板传什么、config.json 里写什么、
 * 渲染进程收到什么，都必须落成同一组数字。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampTunableValue,
  diffTunableValues,
  formatTunableValue,
  isTunableId,
  roundTunable,
  sanitizeTunablePatch,
  sanitizeTunableValues,
  TUNABLE_DEFAULTS,
  TUNABLE_IDS,
  TUNABLE_META,
  TUNABLE_ORDER,
} from './tunable-params';
import {
  CHARACTER_SCALE_DEFAULT,
  CHARACTER_SCALE_MAX,
  CHARACTER_SCALE_MIN,
  GAZE_EYE_STIFFNESS,
  GAZE_HEAD_STIFFNESS,
  GAZE_SPINE_STIFFNESS,
  SIT_PHASE_A_HEAD_TUNE_RAD,
  SIT_SPINE_OVERLAY_WEIGHT,
} from './constants';

test('参数契约：默认值逐项引用 constants.ts（不另写一份）', () => {
  assert.equal(TUNABLE_DEFAULTS['sit.phaseAHeadTuneRad'], SIT_PHASE_A_HEAD_TUNE_RAD);
  assert.equal(TUNABLE_DEFAULTS['sit.spineOverlayWeight'], SIT_SPINE_OVERLAY_WEIGHT);
  assert.equal(TUNABLE_DEFAULTS['gaze.eyeStiffness'], GAZE_EYE_STIFFNESS);
  assert.equal(TUNABLE_DEFAULTS['gaze.headStiffness'], GAZE_HEAD_STIFFNESS);
  assert.equal(TUNABLE_DEFAULTS['gaze.spineStiffness'], GAZE_SPINE_STIFFNESS);
  assert.deepEqual([...TUNABLE_ORDER], [...TUNABLE_IDS]);
  for (const id of TUNABLE_IDS) {
    assert.equal(TUNABLE_META[id].id, id);
    assert.ok(TUNABLE_META[id].max > TUNABLE_META[id].min, `${id} 的区间必须非空`);
    assert.ok(TUNABLE_DEFAULTS[id] >= TUNABLE_META[id].min && TUNABLE_DEFAULTS[id] <= TUNABLE_META[id].max);
  }
});

test('参数契约：夹取到区间、对齐步长、非法输入退回默认值', () => {
  assert.equal(clampTunableValue('sit.phaseAHeadTuneRad', -0.12), -0.12);
  assert.equal(clampTunableValue('sit.phaseAHeadTuneRad', -99), -0.3);
  assert.equal(clampTunableValue('sit.phaseAHeadTuneRad', 99), 0.3);
  assert.equal(clampTunableValue('gaze.eyeStiffness', 40), 30);
  assert.equal(clampTunableValue('gaze.eyeStiffness', 0), 1);
  // 非数字 / NaN / Infinity / null / 字符串乱码 → 默认值
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, null, undefined, 'abc', {}, []]) {
    assert.equal(clampTunableValue('gaze.headStiffness', bad), GAZE_HEAD_STIFFNESS, `bad=${String(bad)}`);
  }
  // 数组里的数字字符串可以接受（面板的 number input 就是字符串）
  assert.equal(clampTunableValue('gaze.headStiffness', '9'), 9);
  // 步长对齐：0.003 → 0.005（step=0.005）
  assert.equal(clampTunableValue('sit.phaseAHeadTuneRad', 0.003), 0.005);
  assert.equal(roundTunable(0.30000000000000004, 3), 0.3);
  assert.equal(roundTunable(-0.0001, 3), 0);
});

test('参数契约：部分更新只保留真实出现且合法的项', () => {
  assert.deepEqual(sanitizeTunablePatch({ 'sit.spineOverlayWeight': 0.85 }), {
    'sit.spineOverlayWeight': 0.85,
  });
  assert.deepEqual(sanitizeTunablePatch({ 'gaze.eyeStiffness': 16, nope: 1 }), { 'gaze.eyeStiffness': 16 });
  assert.deepEqual(sanitizeTunablePatch({ 'gaze.eyeStiffness': 'x' }), {
    'gaze.eyeStiffness': GAZE_EYE_STIFFNESS,
  });
  assert.deepEqual(sanitizeTunablePatch(null), {});
  assert.deepEqual(sanitizeTunablePatch('nope'), {});
  assert.equal(isTunableId('sit.phaseAHeadTuneRad'), true);
  assert.equal(isTunableId('sit.nope'), false);
});

test('参数契约：完整归一化会补齐缺失项（缺项 = 默认值）', () => {
  const full = sanitizeTunableValues({ 'gaze.spineStiffness': 9 });
  assert.equal(full['gaze.spineStiffness'], 9);
  assert.equal(full['gaze.eyeStiffness'], GAZE_EYE_STIFFNESS);
  assert.deepEqual(Object.keys(full).sort(), [...TUNABLE_IDS].sort());
  assert.deepEqual(sanitizeTunableValues(null), { ...TUNABLE_DEFAULTS });
});

test('参数契约：写盘只写与默认值不同的项', () => {
  assert.deepEqual(diffTunableValues({ ...TUNABLE_DEFAULTS }), {});
  const modified = {
    ...TUNABLE_DEFAULTS,
    'sit.phaseAHeadTuneRad': -0.12,
    'sit.spineOverlayWeight': 0.85,
  };
  assert.deepEqual(diffTunableValues(modified), {
    'sit.phaseAHeadTuneRad': -0.12,
    'sit.spineOverlayWeight': 0.85,
  });
});

test('参数契约：展示格式带单位与固定小数位', () => {
  assert.equal(formatTunableValue('sit.phaseAHeadTuneRad', -0.12), '-0.120 rad');
  assert.equal(formatTunableValue('sit.spineOverlayWeight', 0.85), '0.85');
  assert.equal(formatTunableValue('gaze.eyeStiffness', 12), '12.0 /s');
});

/**
 * ADR 0057 D2：整体缩放也是一个可热更新参数。
 *
 * 它和另外五个参数的区别只在**消费方**（主进程改窗口），范围/默认值/夹取仍然只有
 * 这一份实现 —— 面板滑块、`config.json`、渲染侧收到的值必须完全一致。
 */
test('参数契约：角色缩放 0.5x–2.0x、默认 1.0x、两位小数', () => {
  const meta = TUNABLE_META['view.scale'];
  assert.equal(meta.group, 'physics', '与其它手感参数同一个 Tab');
  assert.equal(meta.min, CHARACTER_SCALE_MIN);
  assert.equal(meta.max, CHARACTER_SCALE_MAX);
  assert.equal(meta.default, CHARACTER_SCALE_DEFAULT);
  assert.equal(meta.decimals, 2);
  assert.equal(TUNABLE_DEFAULTS['view.scale'], 1);

  assert.equal(clampTunableValue('view.scale', 2), 2);
  assert.equal(clampTunableValue('view.scale', 0.5), 0.5);
  assert.equal(clampTunableValue('view.scale', 9), 2);
  assert.equal(clampTunableValue('view.scale', 0), 0.5);
  assert.equal(clampTunableValue('view.scale', 1.234), 1.23, '对齐 0.01 步长');
  assert.equal(clampTunableValue('view.scale', 'x'), CHARACTER_SCALE_DEFAULT);
  assert.equal(formatTunableValue('view.scale', 1.4), '1.40 x');
  // 与默认值相同 → 不写进 config.json
  assert.deepEqual(diffTunableValues({ ...TUNABLE_DEFAULTS, 'view.scale': 1 }), {});
  assert.deepEqual(diffTunableValues({ ...TUNABLE_DEFAULTS, 'view.scale': 1.4 }), {
    'view.scale': 1.4,
  });
});
