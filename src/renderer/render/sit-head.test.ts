import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  SIT_HEAD_LEVEL_MAX_RAD,
  headTiltFromBind,
  headWorldFromBase,
  headWorldPitch,
  headWorldYaw,
  sitHeadLevelCorrection,
} from './sit-head';
import type { SitHeadCorrection } from './sit-head';

const WORLD_X = new THREE.Vector3(1, 0, 0);
const WORLD_Y = new THREE.Vector3(0, 1, 0);
const WORLD_Z = new THREE.Vector3(0, 0, 1);

function axis(ax: THREE.Vector3, rad: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(ax, rad);
}

/** 与骨骼仲裁器同序：yawQ · pitchQ · rollQ */
function compose(correction: SitHeadCorrection): THREE.Quaternion {
  return axis(WORLD_Y, correction.yaw)
    .multiply(axis(WORLD_X, correction.pitch))
    .multiply(axis(WORLD_Z, correction.roll));
}

function angleBetween(a: THREE.Quaternion, b: THREE.Quaternion): number {
  return 2 * Math.acos(Math.min(1, Math.abs(a.dot(b))));
}

test('抬头补偿：相对绑定姿态的旋转差取反，YXZ 分解与仲裁器同序', () => {
  // 纯低头：delta = Rx(0.24) → 抵消 pitch = -0.24
  const down = axis(WORLD_X, 0.24);
  const correction = sitHeadLevelCorrection(down);
  assert.ok(correction);
  assert.ok(Math.abs(correction!.pitch + 0.24) < 1e-9, `pitch=${correction!.pitch}`);
  assert.ok(Math.abs(correction!.yaw) < 1e-9);
  assert.ok(Math.abs(correction!.roll) < 1e-9);

  // 复合（低头 + 侧转 + 歪头）：抵消量必须能把它精确转回单位旋转
  const delta = axis(WORLD_Y, 0.3).multiply(axis(WORLD_X, 0.18)).multiply(axis(WORLD_Z, -0.08));
  const mixed = sitHeadLevelCorrection(delta);
  assert.ok(mixed);
  const residual = compose(mixed!).multiply(delta);
  assert.ok(angleBetween(residual, new THREE.Quaternion()) < 1e-6, '补偿后必须回到绑定姿态');
});

test('抬头补偿：非法值 / 超过 ±0.6rad 一律不修（宁可不修也不要把头掰上天）', () => {
  assert.equal(sitHeadLevelCorrection(new THREE.Quaternion()), null);
  assert.equal(sitHeadLevelCorrection(new THREE.Quaternion(Number.NaN, 0, 0, 1)), null);
  assert.equal(sitHeadLevelCorrection(axis(WORLD_X, SIT_HEAD_LEVEL_MAX_RAD + 0.05)), null);
  assert.equal(sitHeadLevelCorrection(axis(WORLD_X, -SIT_HEAD_LEVEL_MAX_RAD - 0.05)), null);
  // 边界内仍然生效
  assert.ok(sitHeadLevelCorrection(axis(WORLD_X, SIT_HEAD_LEVEL_MAX_RAD - 0.01)));
  assert.ok(SIT_HEAD_LEVEL_MAX_RAD >= 0.3 && SIT_HEAD_LEVEL_MAX_RAD <= 1);
});

test('headTiltFromBind：worldSit = delta · worldBind 时能精确还原 delta', () => {
  const bind = axis(WORLD_X, 0.12).multiply(axis(WORLD_Z, 0.04));
  for (const delta of [
    axis(WORLD_X, 0.2),
    axis(WORLD_Y, -0.3).multiply(axis(WORLD_X, -0.1)),
    new THREE.Quaternion(),
  ]) {
    const sit = delta.clone().multiply(bind);
    const recovered = headTiltFromBind(sit, bind);
    assert.ok(angleBetween(recovered, delta) < 1e-6);
  }
});

test('headWorldFromBase：父骨骼世界朝向 × 动画基底；pitch/yaw 用 YXZ 分解', () => {
  const base = axis(WORLD_X, 0.1);
  const parent = axis(WORLD_Y, 0.25);
  const world = headWorldFromBase(base, parent);
  const expected = parent.clone().multiply(base);
  assert.ok(angleBetween(world, expected) < 1e-12);
  // 没有父骨骼时原样返回
  const noParent = headWorldFromBase(base, null);
  assert.ok(angleBetween(noParent, base) < 1e-12);

  assert.ok(Math.abs(headWorldPitch(axis(WORLD_X, 0.25)) - 0.25) < 1e-9);
  assert.ok(Math.abs(headWorldYaw(axis(WORLD_Y, -0.3)) + 0.3) < 1e-9);
  assert.ok(Math.abs(headWorldPitch(new THREE.Quaternion())) < 1e-12);
  assert.ok(Math.abs(headWorldYaw(new THREE.Quaternion())) < 1e-12);
});
