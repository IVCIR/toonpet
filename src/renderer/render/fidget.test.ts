import assert from 'node:assert/strict';
import test from 'node:test';
import { IDLE_FIDGET_MAX_MS, IDLE_FIDGET_MIN_MS } from '../../shared/constants';
import { nextFidgetAtMs, nextFidgetDelayMs } from './fidget';

test('小动作间隔：落在 [MIN, MAX] 内，随机源被夹取', () => {
  assert.equal(nextFidgetDelayMs(() => 0), IDLE_FIDGET_MIN_MS);
  assert.equal(nextFidgetDelayMs(() => 1), IDLE_FIDGET_MAX_MS);
  assert.equal(nextFidgetDelayMs(() => 0.5), Math.round((IDLE_FIDGET_MIN_MS + IDLE_FIDGET_MAX_MS) / 2));
  // 越界 / NaN 的随机源不得产生 NaN 或越界延迟
  for (const value of [-1, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
    const delay = nextFidgetDelayMs(() => value);
    assert.ok(Number.isFinite(delay), `value=${value}`);
    assert.ok(delay >= IDLE_FIDGET_MIN_MS && delay <= IDLE_FIDGET_MAX_MS, `value=${value} delay=${delay}`);
  }
});

test('排期：启动后前 45 秒绝对不到期（ADR 0043 D1）', () => {
  const startedAt = 1000;
  // 最坏情况：随机源给 0（最短间隔），排期就发生在启动那一刻 → 正好启动后 45s
  assert.equal(nextFidgetAtMs(startedAt, startedAt, () => 0), startedAt + IDLE_FIDGET_MIN_MS);
  // 模型加载很晚（启动后 30s 才排期）：仍然是"从排期时刻起再等 45s"，
  // 但那一定 ≥ 启动后 45s —— 前 45 秒是空的
  const late = startedAt + 30_000;
  assert.equal(nextFidgetAtMs(late, startedAt, () => 0), late + IDLE_FIDGET_MIN_MS);
  const veryLate = startedAt + 200_000;
  assert.equal(nextFidgetAtMs(veryLate, startedAt, () => 0), veryLate + IDLE_FIDGET_MIN_MS);
  // 非法输入不得产生 NaN
  for (const value of [Number.NaN, Number.NEGATIVE_INFINITY]) {
    const at = nextFidgetAtMs(value, startedAt, () => 0);
    assert.ok(Number.isFinite(at), `now=${value} at=${at}`);
  }
});

test('排期：任何随机源下都满足"启动后 ≥45s"且"排期后 ≥45s"（否则启动即触发会复现）', () => {
  const startedAt = 42;
  for (const sample of [0, 0.25, 0.5, 0.75, 1, -3, 9]) {
    for (const now of [42, 500, 20_000, 44_000, 90_000]) {
      const at = nextFidgetAtMs(now, startedAt, () => sample);
      assert.ok(at >= startedAt + IDLE_FIDGET_MIN_MS, `sample=${sample} now=${now} at=${at}`);
      assert.ok(at >= now + IDLE_FIDGET_MIN_MS, `sample=${sample} now=${now} at=${at}`);
    }
  }
});

test('ADR 0045 D1：转圈已删除——本模块不再导出任何旋转量', async () => {
  const module = await import('./fidget');
  const exported = Object.keys(module);
  assert.deepEqual(exported.sort(), ['nextFidgetAtMs', 'nextFidgetDelayMs']);
});
