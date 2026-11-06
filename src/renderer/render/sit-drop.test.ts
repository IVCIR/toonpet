import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SIT_DROP_DAMPING,
  SIT_DROP_STIFFNESS,
} from '../../shared/constants';
import { createSitDrop, stepSitDrop } from './sit-drop';

test('参数：k=180 / c=26.8（≈2√k，ζ=1），临界阻尼不过冲', () => {
  assert.equal(SIT_DROP_STIFFNESS, 180);
  assert.ok(Math.abs(SIT_DROP_DAMPING - 2 * Math.sqrt(SIT_DROP_STIFFNESS)) < 0.1);
});

test('弹簧：60fps 下 0.4s 到 ~97%，1s 内收敛到 1，且单调不过冲', () => {
  let state = { value: 0, velocity: 0 };
  let previous = 0;
  let maxValue = 0;
  for (let i = 0; i < 60; i += 1) {
    state = stepSitDrop(state, 1 / 60);
    assert.ok(Number.isFinite(state.value) && Number.isFinite(state.velocity));
    assert.ok(state.value >= previous - 1e-9, `frame=${i} value=${state.value}`);
    assert.ok(state.value <= 1.0001, `overshoot frame=${i} value=${state.value}`);
    previous = state.value;
    maxValue = Math.max(maxValue, state.value);
  }
  assert.ok(state.value > 0.99, `value=${state.value}`);
  assert.ok(maxValue <= 1.0001, `max=${maxValue}`);
});

test('弹簧：0.3s 约 90%（"沉下去"的观感窗口），不是 240ms 线性', () => {
  let state = { value: 0, velocity: 0 };
  for (let i = 0; i < 18; i += 1) state = stepSitDrop(state, 1 / 60);
  assert.ok(state.value > 0.85 && state.value < 0.95, `value@0.3s=${state.value}`);
});

test('弹簧：dt=0 不动；NaN/负 dt 按 0；超大 dt 被夹到上限', () => {
  const steady = stepSitDrop({ value: 0.5, velocity: 0 }, 0);
  assert.deepEqual(steady, { value: 0.5, velocity: 0 });
  const nan = stepSitDrop({ value: 0.5, velocity: 0 }, Number.NaN);
  assert.deepEqual(nan, { value: 0.5, velocity: 0 });
  const negative = stepSitDrop({ value: 0.5, velocity: 0 }, -1);
  assert.deepEqual(negative, { value: 0.5, velocity: 0 });

  let state = { value: 0, velocity: 0 };
  state = stepSitDrop(state, 10);
  assert.ok(Number.isFinite(state.value) && state.value > 0 && state.value < 1);
});

test('有状态弹簧：reset 回 0，update 返回当前值', () => {
  const spring = createSitDrop();
  assert.equal(spring.value(), 0);
  for (let i = 0; i < 60; i += 1) spring.update(1 / 60);
  assert.ok(spring.value() > 0.99);
  spring.reset();
  assert.equal(spring.value(), 0);
  assert.equal(spring.velocity(), 0);
});
