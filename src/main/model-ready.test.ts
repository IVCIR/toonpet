import assert from 'node:assert/strict';
import test from 'node:test';
import {
  noteModelReady,
  onModelReady,
  readModelReadyAt,
  resetModelReady,
} from './model-ready';

// ---------------------------------------------------------------------------
// ADR 0033 D2.2：`model_ready` 的一次性闩锁
// 为什么要测它：`model_ready` 可能早于 `runtime.start()`，早到的那一次如果丢了，
// "她站起来时模型刚好热好"就在最关键的那一轮不成立。
// ---------------------------------------------------------------------------

test('ADR 0033 D2.2：初始状态是"还没就绪过"', () => {
  resetModelReady();
  assert.equal(readModelReadyAt(), null);
});

test('ADR 0033 D2.2：记下就绪时刻，读回同一个值', () => {
  resetModelReady();
  noteModelReady(1_770_000_000_123);
  assert.equal(readModelReadyAt(), 1_770_000_000_123);
});

test('ADR 0033 D2.2：只认第一次（重载渲染页的第二次不发第二次预热）', () => {
  resetModelReady();
  noteModelReady(1_000);
  noteModelReady(2_000);
  assert.equal(readModelReadyAt(), 1_000);
});

test('ADR 0033 D2.2：不传时间时用当前时刻', () => {
  resetModelReady();
  const before = Date.now();
  noteModelReady();
  const at = readModelReadyAt();
  assert.ok(at !== null);
  assert.ok(at >= before && at <= Date.now(), `at=${String(at)} before=${before}`);
});

test('ADR 0033 D2.2：非法时间退化为当前时刻（不写进 NaN）', () => {
  resetModelReady();
  noteModelReady(Number.NaN);
  const at = readModelReadyAt();
  assert.ok(at !== null && Number.isFinite(at));
});

test('ADR 0033 D2.2：reset 之后可以重新记录（runtime 重装 / 停止时清零）', () => {
  resetModelReady();
  noteModelReady(5);
  resetModelReady();
  assert.equal(readModelReadyAt(), null);
  noteModelReady(9);
  assert.equal(readModelReadyAt(), 9);
});

// ---------------------------------------------------------------------------
// 观察者（`runtime` 的在线补发路径；与"读闩锁"的早到补发路径互补）
// ---------------------------------------------------------------------------

test('ADR 0033 D2.2：观察者在记录时被回调一次，且带同一个时刻', () => {
  resetModelReady();
  const seen: number[] = [];
  onModelReady((at) => seen.push(at));
  noteModelReady(1_234);
  assert.deepEqual(seen, [1_234]);
});

test('ADR 0033 D2.2：退订后不再回调', () => {
  resetModelReady();
  let calls = 0;
  const off = onModelReady(() => {
    calls += 1;
  });
  off();
  noteModelReady(1);
  assert.equal(calls, 0);
});

test('ADR 0033 D2.2：注册时若已经就绪则不补调（早到的那次由 readModelReadyAt 补发）', () => {
  resetModelReady();
  noteModelReady(7);
  let calls = 0;
  onModelReady(() => {
    calls += 1;
  });
  assert.equal(calls, 0, '两条路各自只有一处触发点，不重复预热');
});

test('ADR 0033 D2.2：只记第一次 — 第二次 note 不再触发观察者', () => {
  resetModelReady();
  let calls = 0;
  onModelReady(() => {
    calls += 1;
  });
  noteModelReady(1);
  noteModelReady(2);
  assert.equal(calls, 1);
  assert.equal(readModelReadyAt(), 1);
});

test('ADR 0033 D2.2：观察者抛错不影响其他观察者，也不冒泡到事件源头', () => {
  resetModelReady();
  let reached = 0;
  onModelReady(() => {
    throw new Error('observer boom');
  });
  onModelReady(() => {
    reached += 1;
  });
  assert.doesNotThrow(() => noteModelReady(3));
  assert.equal(reached, 1);
});

test('ADR 0033 D2.2：reset 同时清空观察者（重装 runtime 不会留下野回调）', () => {
  resetModelReady();
  let calls = 0;
  onModelReady(() => {
    calls += 1;
  });
  resetModelReady();
  noteModelReady(4);
  assert.equal(calls, 0);
  assert.equal(readModelReadyAt(), 4);
});
