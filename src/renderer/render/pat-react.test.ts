import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PAT_BODY_LEAN_RAD,
  PAT_DURATION_MS,
  PAT_HEAD_PITCH_RAD,
  PAT_HEAD_ROLL_RAD,
  PAT_SPEAKING_WEIGHT_CAP,
  patEnvelope,
  patPose,
  patWeight,
} from './pat-react';

function assertClose(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);
}

test('包络在两端为 0、中点为 1，并对越界进度做钳制', () => {
  assertClose(patEnvelope(0), 0);
  assertClose(patEnvelope(0.5), 1);
  assertClose(patEnvelope(1), 0);
  assertClose(patEnvelope(-3), 0);
  assertClose(patEnvelope(9), 0);
});

test('说话时权重恰好封顶 0.4，非说话时满权重（§5.3）', () => {
  assert.equal(patWeight(true), PAT_SPEAKING_WEIGHT_CAP);
  assert.equal(patWeight(false), 1);
  assert.ok(patWeight(true) <= 0.4);
});

test('说话时头部偏移按 0.4 缩放，且禁止改嘴型贴图', () => {
  const speaking = patPose(0.5, true);
  const silent = patPose(0.5, false);
  assertClose(speaking.headPitch, PAT_HEAD_PITCH_RAD * PAT_SPEAKING_WEIGHT_CAP);
  assertClose(silent.headPitch, PAT_HEAD_PITCH_RAD);
  assertClose(speaking.headRoll, PAT_HEAD_ROLL_RAD * PAT_SPEAKING_WEIGHT_CAP);
  assertClose(speaking.bodyLean, PAT_BODY_LEAN_RAD * PAT_SPEAKING_WEIGHT_CAP);
  assert.equal(speaking.allowMouthChange, false);
  assert.equal(silent.allowMouthChange, true);
});

test('头部后仰是"抬头"方向（pitch 为负），并带一点侧倾', () => {
  const pose = patPose(0.5, false);
  assert.ok(pose.headPitch < 0, '后仰应为负 pitch');
  assert.ok(pose.headRoll > 0, '侧倾应为正 roll');
  assert.ok(PAT_DURATION_MS > 0 && PAT_DURATION_MS < 2000, '一次性反应时长应在 2s 内');
});
