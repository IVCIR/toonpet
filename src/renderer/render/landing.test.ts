import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LANDING_DURATION_MS,
  LANDING_MAX_SQUASH,
  LANDING_KNEE_MAX_RAD,
  LANDING_SPINE_MAX_RAD,
} from '../../shared/constants';
import { impactFromDownVelocity, landingPose } from './landing';

test('落地姿态：开始/结束都为中立，冲击为 0 时不动', () => {
  const start = landingPose(0, 1);
  assert.equal(start.squash, 0);
  const end = landingPose(LANDING_DURATION_MS, 1);
  assert.deepEqual(end, { squash: 0, spinePitch: 0, neckPitch: 0, kneeBend: 0, armPitch: 0 });
  assert.deepEqual(landingPose(100, 0), {
    squash: 0,
    spinePitch: 0,
    neckPitch: 0,
    kneeBend: 0,
    armPitch: 0,
  });
});

test('落地姿态：在吸震段内达到峰值，重摔明显大于轻放', () => {
  const light = landingPose(25, 0.2);
  const hard = landingPose(25, 1);
  assert.ok(hard.squash > light.squash);
  assert.ok(hard.spinePitch > light.spinePitch);
  assert.ok(Math.abs(hard.squash) <= LANDING_MAX_SQUASH + 1e-9);
  assert.ok(Math.abs(hard.spinePitch) <= LANDING_SPINE_MAX_RAD + 1e-9);
  assert.ok(Math.abs(hard.kneeBend) <= LANDING_KNEE_MAX_RAD + 1e-9);
});

test('落地姿态：300ms 后完全回正；异常入参不产生 NaN', () => {
  for (const elapsed of [300, 400, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    const pose = landingPose(elapsed, 1);
    for (const value of Object.values(pose)) assert.ok(Number.isFinite(value));
  }
  assert.equal(landingPose(400, 1).squash, 0);
  assert.equal(landingPose(Number.NaN, 1).squash, 0);
});

test('冲击换算：150px/s 以下为 0，1150px/s 以上为 1，中间单调', () => {
  assert.equal(impactFromDownVelocity(0), 0);
  assert.equal(impactFromDownVelocity(150), 0);
  assert.equal(impactFromDownVelocity(1150), 1);
  assert.equal(impactFromDownVelocity(5000), 1);
  const mid = impactFromDownVelocity(650);
  assert.ok(mid > 0 && mid < 1);
  assert.equal(impactFromDownVelocity(Number.NaN), 0);
});
