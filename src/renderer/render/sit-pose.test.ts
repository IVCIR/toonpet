import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SIT_BREATH_AMPLITUDE_PX,
  SIT_DROP_PX,
  SIT_IN_RAMP_MS,
  SIT_LEAN_RAD,
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

test('官方片段路径：不下沉、不弯腿，只保留呼吸浮动', () => {
  const start = sitPose(0, false);
  assert.equal(start.dropPx, 0);
  assert.equal(start.thighBend, 0);
  assert.equal(start.lean, 0);
  assert.equal(start.bobPx, 0);

  const quarter = sitPose(900, false); // 1/4 周期 → 峰值
  assert.ok(Math.abs(quarter.bobPx - SIT_BREATH_AMPLITUDE_PX) < 1e-9);
  assert.equal(quarter.dropPx, 0);
});

test('程序化降级：400ms 内下沉到 24px 并弯腿 0.45rad', () => {
  const start = sitPose(0, true);
  assert.equal(start.dropPx, 0);
  assert.equal(start.thighBend, 0);

  const mid = sitPose(SIT_IN_RAMP_MS / 2, true);
  assert.ok(mid.dropPx > 0 && mid.dropPx < SIT_DROP_PX, `mid drop=${mid.dropPx}`);

  const done = sitPose(SIT_IN_RAMP_MS, true);
  assert.ok(Math.abs(done.dropPx - SIT_DROP_PX) < 1e-9);
  assert.ok(Math.abs(done.thighBend - SIT_THIGH_BEND_RAD) < 1e-9);
  assert.ok(Math.abs(done.lean - SIT_LEAN_RAD) < 1e-9);
});

test('异常入参：NaN / 负数按 0 处理，不产生 NaN 姿态', () => {
  for (const elapsed of [Number.NaN, -500, Number.NEGATIVE_INFINITY]) {
    const pose = sitPose(elapsed, true);
    assert.ok(Number.isFinite(pose.dropPx));
    assert.ok(Number.isFinite(pose.bobPx));
    assert.equal(pose.dropPx, 0);
  }
});
