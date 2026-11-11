import assert from 'node:assert/strict';
import test from 'node:test';
import { DRAG_SWING_MIN_ANGLE_RAD } from '../../shared/constants';
import {
  createDragPendulum,
  maxSwingAngle,
  pendulumConfigFor,
  pivotCompensation,
  stepDragPendulum,
  struggleOffset,
  swingFits,
} from './drag-motion';
import type { DragPendulumState, SwingPoint } from './drag-motion';

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

test('三态物理参数：抓头/身/脚各不相同，且都不含"按部位写姿态"的字段（ADR 0041 D1）', () => {
  const head = pendulumConfigFor('head');
  const body = pendulumConfigFor('body');
  const foot = pendulumConfigFor('foot');

  assert.notDeepEqual(head, body);
  assert.notDeepEqual(body, foot);
  // 抓取带只允许影响单摆物理；姿态字段（旧 liftPx）已删除，出现即回归
  for (const config of [head, body, foot]) {
    assert.deepEqual(Object.keys(config).sort(), [
      'angleLimitRad',
      'damping',
      'lengthPx',
      'struggleHz',
      'struggleRad',
    ]);
    for (const value of Object.values(config)) {
      assert.ok(Number.isFinite(value) && value >= 0);
    }
  }
});

// ---------------------------------------------------------------------------
// ADR 0058 D3：摆角的视口约束
// ---------------------------------------------------------------------------

/**
 * 实测侧影（CH0335，1.0x：脚底为原点、px）：[x 半宽, y 高度]。
 * 最宽在髋部（y≈234 处 ±183），脚只有 ±67 —— 这正是"包围盒四角"不真实的原因。
 */
const PROFILE: SwingPoint[] = [
  { x: 0, y: 0 },
  { x: 67, y: 33 },
  { x: -67, y: 33 },
  { x: 139, y: 100 },
  { x: -139, y: 100 },
  { x: 183, y: 234 },
  { x: -183, y: 234 },
  { x: 171, y: 268 },
  { x: -171, y: 268 },
  { x: 95, y: 402 },
  { x: -95, y: 402 },
  { x: 64, y: 535 },
  { x: -64, y: 535 },
];
/** 1.0x 的视口：494 宽（左右各 36px 边距）/ 756 高 */
const VIEW = { halfWidthPx: 247, heightPx: 756 };

test('摆角约束：θ=0 一定可行；抓头大幅甩动会被夹到可行角以内', () => {
  const pivot = { x: 0, y: 500 };
  assert.equal(swingFits(PROFILE, pivot, 0, VIEW), true);
  // 20°（物理上限 0.35rad）时髋部会顶出内容区
  assert.equal(swingFits(PROFILE, pivot, 0.35, VIEW), false);
  const limit = maxSwingAngle({ points: PROFILE, pivot, viewport: VIEW, limitRad: 0.35 });
  assert.ok(limit > 0.2 && limit < 0.35, `limit=${limit}`);
  // 夹出来的角度真的可行，再往外 0.02rad 就不可行
  assert.equal(swingFits(PROFILE, pivot, limit, VIEW), true);
  assert.equal(swingFits(PROFILE, pivot, limit + 0.02, VIEW), false);
});

test('摆角约束：物理上限内本来就装得下时原样返回（不偷偷改手感）', () => {
  const pivot = { x: 0, y: 300 };
  const limit = maxSwingAngle({ points: PROFILE, pivot, viewport: VIEW, limitRad: 0.32 });
  assert.equal(limit, 0.32);
  // 抓脚：支点很低，重心绕脚摆，头部也出不了画
  const foot = maxSwingAngle({ points: PROFILE, pivot: { x: 0, y: 40 }, viewport: VIEW, limitRad: 0.25 });
  assert.equal(foot, 0.25);
});

test('摆角约束：数据异常时退回兜底下限，绝不返回 0（否则拖拽变成硬平移）', () => {
  const noProfile = maxSwingAngle({ points: [], pivot: { x: 0, y: 300 }, viewport: VIEW, limitRad: 0.3 });
  assert.ok(noProfile > 0);
  assert.equal(noProfile, DRAG_SWING_MIN_ANGLE_RAD);
  const narrow = maxSwingAngle({
    points: PROFILE,
    pivot: { x: 0, y: 500 },
    viewport: { halfWidthPx: 60, heightPx: 756 },
    limitRad: 0.35,
  });
  assert.ok(narrow >= DRAG_SWING_MIN_ANGLE_RAD && narrow <= 0.35);
  // 上限 0 / 非法输入不产生 NaN
  assert.equal(maxSwingAngle({ points: PROFILE, pivot: { x: 0, y: 1 }, viewport: VIEW, limitRad: 0 }), 0);
  const bad = maxSwingAngle({
    points: [{ x: Number.NaN, y: Number.NaN }],
    pivot: { x: Number.NaN, y: Number.NaN },
    viewport: { halfWidthPx: Number.NaN, heightPx: Number.NaN },
    limitRad: 0.3,
  });
  assert.ok(Number.isFinite(bad));
});

test('摆角约束：边距越大能摆的角度越大（ADR 0058 D1 与 D3 的因果）', () => {
  const pivot = { x: 0, y: 500 };
  const tight = maxSwingAngle({ points: PROFILE, pivot, viewport: { halfWidthPx: 211, heightPx: 720 }, limitRad: 0.35 });
  const padded = maxSwingAngle({ points: PROFILE, pivot, viewport: VIEW, limitRad: 0.35 });
  assert.ok(padded > tight, `padded=${padded} tight=${tight}`);
});
