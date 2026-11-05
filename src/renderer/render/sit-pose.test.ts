import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SIT_DROP_PX,
  SIT_IN_RAMP_MS,
  SIT_LEAN_RAD,
  SIT_LOWER_TRANSITION_LIFT_PX,
  SIT_LOWER_TRANSITION_MS,
  SIT_LOWER_TRANSITION_THIGH_RAD,
  SIT_THIGH_BEND_RAD,
  easeOutCubic,
  sitPose,
} from './sit-pose';

test('缓出曲线：0 → 0、1 → 1、单调不减', () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  let previous = 0;
  for (let p = 0; p <= 1.0001; p += 0.1) {
    const value = easeOutCubic(p);
    assert.ok(value >= previous - 1e-9, `p=${p}`);
    previous = value;
  }
  // 越界夹取
  assert.equal(easeOutCubic(-1), 0);
  assert.equal(easeOutCubic(2), 1);
});

test('官方片段路径：不下沉，只输出过渡（呼吸/微动在 sit-motion，不在这里）', () => {
  const start = sitPose(SIT_LOWER_TRANSITION_MS, false);
  assert.equal(start.dropPx, 0);
  assert.equal(start.thighBend, 0);
  assert.equal(start.lean, 0);
  // ADR 0044：呼吸/张望/眨眼/晃腿已搬走，`SitPose` 里不得再出现任何"常驻运动"字段
  assert.deepEqual(Object.keys(start).sort(), [
    'dropPx',
    'lean',
    'thighBend',
    'transition',
    'transitionLiftPx',
  ]);
});

test('坐下过渡（ADR 0042 D1）：从 +14px、弯腿 0.22rad 起步，240ms 内归零', () => {
  const start = sitPose(0, false);
  assert.ok(Math.abs(start.transitionLiftPx - SIT_LOWER_TRANSITION_LIFT_PX) < 1e-9);
  assert.ok(Math.abs(start.thighBend - SIT_LOWER_TRANSITION_THIGH_RAD) < 1e-9);
  assert.equal(start.transition, 0);

  const mid = sitPose(SIT_LOWER_TRANSITION_MS / 2, false);
  assert.ok(mid.transitionLiftPx > 0 && mid.transitionLiftPx < SIT_LOWER_TRANSITION_LIFT_PX);
  assert.ok(mid.thighBend > 0 && mid.thighBend < SIT_LOWER_TRANSITION_THIGH_RAD);
  assert.equal(mid.dropPx, 0, '过渡期间不额外下沉（片段自己在往下坐）');

  const done = sitPose(SIT_LOWER_TRANSITION_MS, false);
  assert.equal(done.transition, 1);
  assert.equal(done.transitionLiftPx, 0);
  assert.equal(done.thighBend, 0);
  assert.equal(done.lean, 0);

  // 过渡是一次性的：一直往下走不会再抬起来
  for (let t = SIT_LOWER_TRANSITION_MS; t <= 4000; t += 137) {
    assert.equal(sitPose(t, false).transitionLiftPx, 0);
  }
});

test('程序化降级：400ms 内下沉到 24px 并弯腿 0.45rad（不叠过渡抬升）', () => {
  const start = sitPose(0, true);
  assert.equal(start.dropPx, 0);
  assert.equal(start.thighBend, 0);
  assert.equal(start.transitionLiftPx, 0);

  const mid = sitPose(SIT_IN_RAMP_MS / 2, true);
  assert.ok(mid.dropPx > 0 && mid.dropPx < SIT_DROP_PX, `mid drop=${mid.dropPx}`);

  const done = sitPose(SIT_IN_RAMP_MS, true);
  assert.ok(Math.abs(done.dropPx - SIT_DROP_PX) < 1e-9);
  assert.ok(Math.abs(done.thighBend - SIT_THIGH_BEND_RAD) < 1e-9);
  assert.ok(Math.abs(done.lean - SIT_LEAN_RAD) < 1e-9);
});

test('异常入参：NaN / 负数按 0 处理，不产生 NaN 姿态', () => {
  for (const elapsed of [Number.NaN, -500, Number.NEGATIVE_INFINITY]) {
    for (const procedural of [true, false]) {
      const pose = sitPose(elapsed, procedural);
      assert.ok(Number.isFinite(pose.dropPx));
      assert.ok(Number.isFinite(pose.transition));
      assert.ok(Number.isFinite(pose.transitionLiftPx));
      assert.ok(Number.isFinite(pose.thighBend));
      assert.equal(pose.dropPx, 0);
    }
  }
});
