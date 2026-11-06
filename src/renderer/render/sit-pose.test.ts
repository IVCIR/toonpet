import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SIT_LOWER_LEAN_RAD,
  SIT_LOWER_LIFT_PX,
  SIT_LOWER_THIGH_RAD,
} from '../../shared/constants';
import {
  SIT_DROP_PX,
  SIT_LEAN_RAD,
  SIT_THIGH_BEND_RAD,
  easeInOutCubic,
  sitPose,
} from './sit-pose';

test('缓入缓出：0 → 0、1 → 1、单调不减、越界夹取', () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  assert.equal(easeInOutCubic(0.5), 0.5);
  let previous = 0;
  for (let p = 0; p <= 1.0001; p += 0.1) {
    const value = easeInOutCubic(p);
    assert.ok(value >= previous - 1e-9, `p=${p}`);
    previous = value;
  }
  assert.equal(easeInOutCubic(-1), 0);
  assert.equal(easeInOutCubic(2), 1);
});

test('官方片段路径：sitDrop=0 时从 +14px / 弯腿 0.22rad / 前倾 0.05rad 起步', () => {
  const start = sitPose(0, false);
  assert.equal(start.dropPx, 0);
  assert.ok(Math.abs(start.transitionLiftPx - SIT_LOWER_LIFT_PX) < 1e-9);
  assert.ok(Math.abs(start.thighBend - SIT_LOWER_THIGH_RAD) < 1e-9);
  assert.ok(Math.abs(start.lean - SIT_LOWER_LEAN_RAD) < 1e-9);
  assert.equal(start.transition, 0);
  // ADR 0044：呼吸/张望/晃腿已搬走，`SitPose` 里不得再出现任何"常驻运动"字段
  assert.deepEqual(Object.keys(start).sort(), [
    'dropPx',
    'lean',
    'thighBend',
    'transition',
    'transitionLiftPx',
  ]);

  const mid = sitPose(0.5, false);
  assert.ok(mid.transitionLiftPx > 0 && mid.transitionLiftPx < SIT_LOWER_LIFT_PX);
  assert.ok(mid.thighBend > 0 && mid.thighBend < SIT_LOWER_THIGH_RAD);
  assert.equal(mid.dropPx, 0, '过渡期间不额外下沉（片段自己在往下坐）');
  assert.equal(mid.transition, 0.5);

  const done = sitPose(1, false);
  assert.equal(done.transition, 1);
  assert.equal(done.transitionLiftPx, 0);
  assert.equal(done.thighBend, 0);
  assert.equal(done.lean, 0);
});

test('程序化降级：sitDrop=1 时下沉 24px、弯腿 0.45rad、后倾 0.02rad（不叠过渡抬升）', () => {
  const start = sitPose(0, true);
  assert.equal(start.dropPx, 0);
  assert.equal(start.thighBend, 0);
  assert.equal(start.transitionLiftPx, 0);

  const mid = sitPose(0.5, true);
  assert.ok(mid.dropPx > 0 && mid.dropPx < SIT_DROP_PX, `mid drop=${mid.dropPx}`);

  const done = sitPose(1, true);
  assert.ok(Math.abs(done.dropPx - SIT_DROP_PX) < 1e-9);
  assert.ok(Math.abs(done.thighBend - SIT_THIGH_BEND_RAD) < 1e-9);
  assert.ok(Math.abs(done.lean - SIT_LEAN_RAD) < 1e-9);
});

test('异常入参：NaN / 负数按 0 处理，>1 按 1 处理，不产生 NaN 姿态', () => {
  for (const value of [Number.NaN, -5, Number.NEGATIVE_INFINITY]) {
    for (const procedural of [true, false]) {
      const pose = sitPose(value, procedural);
      assert.ok(Number.isFinite(pose.dropPx));
      assert.ok(Number.isFinite(pose.transition));
      assert.ok(Number.isFinite(pose.transitionLiftPx));
      assert.ok(Number.isFinite(pose.thighBend));
      assert.equal(pose.transition, 0);
      assert.equal(pose.dropPx, 0);
    }
  }
  for (const procedural of [true, false]) {
    const pose = sitPose(2, procedural);
    assert.equal(pose.transition, 1);
    assert.equal(pose.transitionLiftPx, 0);
  }
  const officialDone = sitPose(2, false);
  assert.equal(officialDone.thighBend, 0);
  const proceduralDone = sitPose(2, true);
  assert.ok(Math.abs(proceduralDone.thighBend - SIT_THIGH_BEND_RAD) < 1e-9);
});
