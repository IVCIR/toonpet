import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SNAP_APPROACH_MAX_MS,
  SNAP_APPROACH_MIN_MS,
  SNAP_APPROACH_WALK_MAX_DY_PX,
} from '../../shared/constants';
import { approachDelta, planApproach, sampleApproach } from './approach';

test('接近计划：距离小于瞬时阈值返回 null（直接落座）', () => {
  assert.equal(planApproach({ x: 100, y: 200 }, { x: 104, y: 203 }), null);
  assert.equal(planApproach({ x: Number.NaN, y: 0 }, { x: 0, y: 0 }), null);
});

test('接近计划：同一地面线走 walk，时长有界，y 只做 ≤16px 的缓动', () => {
  const plan = planApproach({ x: 0, y: 200 }, { x: 200, y: 210 });
  assert.ok(plan);
  assert.equal(plan.mode, 'walk');
  assert.ok(plan.durationMs >= SNAP_APPROACH_MIN_MS && plan.durationMs <= SNAP_APPROACH_MAX_MS);
  assert.ok(Math.abs(plan.durationMs - (200 / 260) * 1000) < 1e-6);
  const mid = sampleApproach(plan, 0.5);
  assert.ok(mid.x > 0 && mid.x < 200);
  assert.ok(mid.y > 200 && mid.y < 210, `mid y=${mid.y}`);
  const end = sampleApproach(plan, 1);
  assert.equal(end.x, 200);
  assert.equal(end.y, 210);
  assert.equal(end.done, true);
});

test('接近计划：需要升高时走 leap，先水平再跳，弧线高于起点/终点', () => {
  const plan = planApproach({ x: 100, y: 600 }, { x: 700, y: 80 });
  assert.ok(plan);
  assert.equal(plan.mode, 'leap');
  assert.ok(plan.arcHeightPx > 0);
  assert.ok(plan.walkFraction > 0 && plan.walkFraction < 1);
  // 起点/终点精确
  const start = sampleApproach(plan, 0);
  assert.equal(start.x, 100);
  assert.equal(start.y, 600);
  const end = sampleApproach(plan, 1);
  assert.equal(end.x, 700);
  assert.equal(end.y, 80);
  // 走段 y 不变
  const walk = sampleApproach(plan, plan.walkFraction * 0.5);
  assert.equal(walk.y, 600);
  // 跳段中某点应高于两端（y 更小）
  const hop = sampleApproach(plan, plan.walkFraction + (1 - plan.walkFraction) * 0.5);
  assert.ok(hop.y < 600 && hop.y < 80, `hop y=${hop.y}`);
});

test('接近计划：竖直跳（dx=0）也成立，时长有界', () => {
  const plan = planApproach({ x: 200, y: 600 }, { x: 200, y: 100 });
  assert.ok(plan);
  assert.equal(plan.mode, 'leap');
  assert.ok(plan.durationMs >= SNAP_APPROACH_MIN_MS && plan.durationMs <= SNAP_APPROACH_MAX_MS);
  const mid = sampleApproach(plan, 0.8);
  assert.ok(mid.y < 600);
});

test('接近计划：|dy| 恰好在阈值内算 walk，超过算 leap', () => {
  const walk = planApproach({ x: 0, y: 200 }, { x: 200, y: 200 + SNAP_APPROACH_WALK_MAX_DY_PX });
  assert.equal(walk?.mode, 'walk');
  const leap = planApproach({ x: 0, y: 200 }, { x: 200, y: 200 + SNAP_APPROACH_WALK_MAX_DY_PX + 1 });
  assert.equal(leap?.mode, 'leap');
});

test('进度增量：按 duration 归一，非法 dt 返回 0，单步有上限', () => {
  const plan = planApproach({ x: 0, y: 0 }, { x: 200, y: 0 });
  assert.ok(plan);
  const delta = approachDelta(plan, plan.durationMs / 10);
  assert.ok(Math.abs(delta - 0.1) < 1e-9);
  assert.equal(approachDelta(plan, 0), 0);
  assert.equal(approachDelta(plan, Number.NaN), 0);
  assert.ok(approachDelta(plan, 10_000) <= 0.25);
});
