import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampRectToWorkAreas,
  groundYFor,
  isAtRest,
  stepSettle,
  stepSpring,
  stepWalk,
} from './motion';
import type { SettleState, SpringConfig, WalkState } from './motion';

const SPRING: SpringConfig = { stiffness: 140, damping: 12 };

test('stepSpring：从静止出发必然收敛到目标，且不产生 NaN', () => {
  let state = { position: 0, velocity: 0 };
  for (let i = 0; i < 600; i += 1) {
    state = stepSpring(state, 100, SPRING, 1 / 60);
    assert.ok(Number.isFinite(state.position) && Number.isFinite(state.velocity));
  }
  assert.ok(Math.abs(state.position - 100) < 0.5, `position=${state.position}`);
  assert.ok(isAtRest(state, 100, 0.5, 1));
});

test('stepSpring：纯函数（同输入同输出、不改入参）', () => {
  const input = { position: 10, velocity: -5 };
  const a = stepSpring(input, 0, SPRING, 1 / 60);
  const b = stepSpring(input, 0, SPRING, 1 / 60);
  assert.deepEqual(a, b);
  assert.deepEqual(input, { position: 10, velocity: -5 }, '入参不得被修改');
});

test('stepSpring：dt 非法或为 0 时原样返回', () => {
  const input = { position: 3, velocity: 1 };
  assert.deepEqual(stepSpring(input, 0, SPRING, 0), input);
  assert.deepEqual(stepSpring(input, 0, SPRING, -1), input);
  assert.deepEqual(stepSpring(input, 0, SPRING, Number.NaN), input);
});

test('stepSpring：大步长（100ms）被夹到上限，仍然稳定', () => {
  let state = { position: 0, velocity: 0 };
  for (let i = 0; i < 60; i += 1) {
    state = stepSpring(state, 50, SPRING, 0.1);
    assert.ok(Number.isFinite(state.position));
  }
  assert.ok(Math.abs(state.position - 50) < 0.5);
});

test('stepWalk：起步有加速、到点精确停住、绝不越过目标', () => {
  let state: WalkState = { x: 0, vx: 0, targetX: 200 };
  let done = false;
  let maxAbsX = 0;
  let peakSpeed = 0;
  for (let i = 0; i < 600 && !done; i += 1) {
    const result = stepWalk(state, { speed: 110, acceleration: 520 }, 1 / 60);
    state = result.state;
    done = result.done;
    maxAbsX = Math.max(maxAbsX, Math.abs(state.x));
    peakSpeed = Math.max(peakSpeed, Math.abs(state.vx));
  }
  assert.equal(done, true, '必须在 10s 内到达');
  assert.equal(state.x, 200, '到点后精确停在目标');
  assert.equal(state.vx, 0);
  assert.ok(maxAbsX <= 200, `不得冲过头：${maxAbsX}`);
  assert.ok(peakSpeed <= 110 + 1e-6, `不得超过巡航速度：${peakSpeed}`);
});

test('stepWalk：向左走（目标小于起点）同样成立', () => {
  let state: WalkState = { x: 300, vx: 0, targetX: 100 };
  let done = false;
  for (let i = 0; i < 600 && !done; i += 1) {
    const result = stepWalk(state, { speed: 110, acceleration: 520 }, 1 / 60);
    state = result.state;
    done = result.done;
  }
  assert.equal(done, true);
  assert.equal(state.x, 100);
});

test('stepWalk：已经在目标上时立即 done', () => {
  const result = stepWalk({ x: 42, vx: 0, targetX: 42 }, { speed: 110, acceleration: 520 }, 1 / 60);
  assert.equal(result.done, true);
  assert.equal(result.state.x, 42);
});

test('stepSettle：从空中落到地面线并静止，全程不穿地', () => {
  let state: SettleState = { x: 0, y: 0, vx: 0, vy: 0 };
  let landed = false;
  let done = false;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < 600 && !done; i += 1) {
    const result = stepSettle(
      state,
      300,
      { stiffness: 140, damping: 12, restitution: 0.28, minBounceSpeed: 60, friction: 5 },
      1 / 60,
    );
    state = result.state;
    landed = landed || result.landed;
    done = result.done;
    minY = Math.min(minY, state.y);
    maxY = Math.max(maxY, state.y);
  }
  assert.equal(done, true, '必须收敛');
  assert.equal(state.y, 300, '最终停在地面线');
  assert.equal(state.vy, 0);
  assert.ok(maxY <= 300, `不得穿到地面以下：${maxY}`);
  assert.equal(landed, true, '至少触地一次');
});

test('stepSettle：向上抛出的末速度会先上升再下落', () => {
  let state: SettleState = { x: 0, y: 250, vx: 0, vy: -600 };
  let minY = 250;
  let done = false;
  for (let i = 0; i < 600 && !done; i += 1) {
    const result = stepSettle(
      state,
      300,
      { stiffness: 140, damping: 12, restitution: 0.28, minBounceSpeed: 60, friction: 5 },
      1 / 60,
    );
    state = result.state;
    done = result.done;
    minY = Math.min(minY, state.y);
  }
  assert.ok(minY < 250, '负的 vy 必须先往上走');
  assert.equal(done, true);
  assert.equal(state.y, 300);
});

test('stepSettle：水平惯性会衰减并被夹在边界内', () => {
  let state: SettleState = { x: 100, y: 300, vx: 900, vy: 0 };
  let done = false;
  for (let i = 0; i < 600 && !done; i += 1) {
    const result = stepSettle(
      state,
      300,
      { stiffness: 140, damping: 12, restitution: 0.28, minBounceSpeed: 60, friction: 5 },
      1 / 60,
    );
    state = result.state;
    done = result.done;
  }
  assert.equal(done, true);
  assert.ok(state.x > 100, '水平方向应保留惯性');
  assert.ok(Math.abs(state.vx) <= 1, '惯性必须收敛到 0');
});

test('clampRectToWorkAreas：按最大重叠的工作区夹取（不用 getDisplayNearestPoint）', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  // 右边界：1920-400=1520；下边界：1040-720=320（两个方向都要夹）
  assert.deepEqual(clampRectToWorkAreas({ x: 1800, y: 500, width: 400, height: 720 }, [area]), {
    x: 1520,
    y: 320,
  });
  assert.deepEqual(clampRectToWorkAreas({ x: -100, y: -50, width: 400, height: 720 }, [area]), {
    x: 0,
    y: 0,
  });
  // 双屏：窗口大部分落在第二块屏上，就夹到第二块屏
  const left = { x: 0, y: 0, width: 1920, height: 1040 };
  const right = { x: 1920, y: 0, width: 1920, height: 1040 };
  const clamped = clampRectToWorkAreas({ x: 3500, y: 0, width: 400, height: 720 }, [left, right]);
  assert.equal(clamped.x, 3440);
});

test('groundYFor：窗口底边贴工作区底边', () => {
  assert.equal(groundYFor({ x: 0, y: 0, width: 1920, height: 1040 }, 720), 320);
});
