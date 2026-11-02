import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDragPendulum,
  dragBoneOffsets,
  pendulumConfigFor,
  pivotCompensation,
  stepDragPendulum,
  struggleOffset,
} from './drag-motion';
import type { DragPendulumState } from './drag-motion';

const NO_FORCE = { accelerationX: 0, accelerationY: 0 };

function assertFiniteState(state: DragPendulumState): void {
  assert.ok(Number.isFinite(state.angle), `angle=${state.angle}`);
  assert.ok(Number.isFinite(state.angularVelocity), `omega=${state.angularVelocity}`);
}

test('单摆参数：抓头的摆长/阻尼最大，抓脚的最小（初始手感，ADR 0035 D3）', () => {
  const head = pendulumConfigFor('head');
  const body = pendulumConfigFor('body');
  const foot = pendulumConfigFor('foot');
  assert.ok(head.lengthPx > body.lengthPx && body.lengthPx > foot.lengthPx);
  assert.ok(head.damping > foot.damping);
  assert.ok(foot.struggleHz > 0 && foot.struggleRad > 0);
  assert.equal(head.struggleHz, 0);
  assert.equal(body.struggleHz, 0);
});

test('单摆：没有外力且初始静止时保持不动', () => {
  let state = createDragPendulum();
  for (let i = 0; i < 60; i += 1) {
    state = stepDragPendulum(state, 'head', { dtSeconds: 1 / 60, forcing: NO_FORCE, nowMs: i * 16.7 });
  }
  assert.equal(state.angle, 0);
  assert.equal(state.angularVelocity, 0);
});

test('单摆：支撑点向右加速 → 身体因惯性向左摆（θ 为负）', () => {
  let state = createDragPendulum();
  for (let i = 0; i < 20; i += 1) {
    state = stepDragPendulum(state, 'head', {
      dtSeconds: 1 / 60,
      forcing: { accelerationX: 1500, accelerationY: 0 },
      nowMs: i * 16.7,
    });
  }
  assert.ok(state.angle < -0.01, `angle=${state.angle}`);
  assertFiniteState(state);
});

test('单摆：零输入从初始角度出发会衰减（阻尼生效）', () => {
  let state: DragPendulumState = { angle: 0.25, angularVelocity: 0 };
  const first = Math.abs(state.angle);
  for (let i = 0; i < 240; i += 1) {
    state = stepDragPendulum(state, 'body', { dtSeconds: 1 / 60, forcing: NO_FORCE, nowMs: i * 16.7 });
  }
  assert.ok(Math.abs(state.angle) < first * 0.8, `angle=${state.angle}`);
  assertFiniteState(state);
});

test('单摆：极大外力被角度/角速度限幅，不产生 NaN', () => {
  let state = createDragPendulum();
  for (let i = 0; i < 120; i += 1) {
    state = stepDragPendulum(state, 'foot', {
      dtSeconds: 0.1,
      forcing: { accelerationX: 1e9, accelerationY: -1e9 },
      nowMs: i * 100,
    });
  }
  const limit = pendulumConfigFor('foot').angleLimitRad;
  assert.ok(Math.abs(state.angle) <= limit + 1e-9);
  assert.ok(Math.abs(state.angularVelocity) <= 6 + 1e-9);
  assertFiniteState(state);
});

test('单摆：非法 dt/外力按安全值处理', () => {
  const input = createDragPendulum();
  const out = stepDragPendulum(input, 'head', {
    dtSeconds: Number.NaN,
    forcing: { accelerationX: Number.NaN, accelerationY: Number.POSITIVE_INFINITY },
    nowMs: Number.NaN,
  });
  assert.deepEqual(out, input);
});

test('抓脚挣扎：头/身恒为 0，脚有界且随时间变化', () => {
  assert.equal(struggleOffset('head', 1000), 0);
  assert.equal(struggleOffset('body', 1000), 0);
  const a = struggleOffset('foot', 0);
  const b = struggleOffset('foot', 137);
  assert.notEqual(a, b);
  for (let t = 0; t < 3000; t += 17) {
    const value = struggleOffset('foot', t);
    assert.ok(Number.isFinite(value));
    assert.ok(Math.abs(value) <= pendulumConfigFor('foot').struggleRad * 2.9 + 1e-9, `t=${t} v=${value}`);
  }
  // gain=0 时完全关闭
  assert.equal(struggleOffset('foot', 500, 0), 0);
});

test('支点补偿：θ=0 无补偿；绕头旋转时头不动、脚甩出去', () => {
  assert.deepEqual(pivotCompensation({ x: 12, y: 300 }, 0), { x: 0, y: 0 });
  const p = { x: 0, y: 300 };
  const c = pivotCompensation(p, Math.PI / 2);
  // p - R(90°)p = (0,300) - (-300,0) = (300,300)
  assert.ok(Math.abs(c.x - 300) < 1e-9);
  assert.ok(Math.abs(c.y - 300) < 1e-9);
  // 非法输入安全
  const bad = pivotCompensation({ x: Number.NaN, y: 1 }, Number.NaN);
  assert.ok(Number.isFinite(bad.x) && Number.isFinite(bad.y));
});

test('三态姿态：抓头/身/脚返回不同骨骼组合，全部有限', () => {
  const head = dragBoneOffsets('head', 0);
  const body = dragBoneOffsets('body', 0);
  const foot = dragBoneOffsets('foot', 0);

  for (const offsets of [head, body, foot]) {
    assert.ok(offsets.length >= 10);
    for (const item of offsets) {
      assert.ok(Number.isFinite(item.yaw) && Number.isFinite(item.pitch) && Number.isFinite(item.roll));
    }
  }
  const footArm = foot.find((item) => item.bone === 'upperArmL');
  assert.ok(footArm && footArm.roll < -1, '抓脚应举臂挣扎（负 roll = 抬手）');
  const headArm = head.find((item) => item.bone === 'upperArmL');
  assert.ok(headArm && Math.abs(headArm.roll) < 0.3, '抓头应自然下垂，不举臂');
  assert.notDeepEqual(head, body);
});
