import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IDLE_MICRO_POOL,
  MICRO_POOL_MAX_MS,
  MICRO_POOL_MIN_MS,
  MICRO_POOL_TRANSITION_RATE,
  SIT_MICRO_POOL,
} from '../../shared/constants';
import { createMicroPool } from './micro-pool';

const ENTRIES = [
  { kind: 'legs', weight: 3 },
  { kind: 'hands', weight: 1 },
  { kind: 'far', weight: 1 },
] as const;

/** 固定随机源：0 = 永远抽权重列表里的第一个候选，1 = 永远抽最后一个 */
function pool(randomValue: number, min = 1000, max = 1000) {
  return createMicroPool({
    entries: ENTRIES,
    minIntervalMs: min,
    maxIntervalMs: max,
    random: () => randomValue,
  });
}

test('池：切换间隔落在 [MIN, MAX] 内，非法随机源不产生越界/NaN', () => {
  for (const [value, expected] of [
    [0, 1000],
    [1, 2000],
    [0.5, 1500],
  ] as const) {
    const p = createMicroPool({ entries: ENTRIES, minIntervalMs: 1000, maxIntervalMs: 2000, random: () => value });
    p.update(0, 0, true);
    const delay = p.snapshot()!.nextSwitchInMs;
    assert.equal(delay, expected, `random=${value}`);
  }
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -3, 9]) {
    const p = createMicroPool({ entries: ENTRIES, minIntervalMs: 1000, maxIntervalMs: 2000, random: () => value });
    p.update(0, 0, true);
    const delay = p.snapshot()!.nextSwitchInMs;
    assert.ok(Number.isFinite(delay) && delay >= 1000 && delay <= 2000, `random=${value} delay=${delay}`);
  }
});

test('池：默认间隔就是契约的 15–30s', () => {
  const p = createMicroPool({ entries: ENTRIES, random: () => 0 });
  p.update(0, 0, true);
  assert.equal(p.snapshot()!.nextSwitchInMs, MICRO_POOL_MIN_MS);
  const q = createMicroPool({ entries: ENTRIES, random: () => 1 });
  q.update(0, 0, true);
  assert.equal(q.snapshot()!.nextSwitchInMs, MICRO_POOL_MAX_MS);
});

test('池：到期前绝不切换，到期那一拍才换', () => {
  const p = pool(0, 1000, 1000);
  let snap = p.update(0, 0, true);
  assert.equal(snap.active, 'legs');
  assert.equal(snap.switches, 0);
  // 999ms：故意差 1ms
  for (let t = 100; t < 1000; t += 100) snap = p.update(t, 0.1, true);
  assert.equal(snap.active, 'legs');
  assert.equal(snap.switches, 0);
  snap = p.update(1000, 0.1, true);
  assert.equal(snap.switches, 1);
  assert.notEqual(snap.active, 'legs');
});

test('池：抽签排除当前条目——连续两次切换不会抽到同一个', () => {
  // 线性同余伪随机（确定性，不依赖 Math.random）
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const p = createMicroPool({
    entries: ENTRIES,
    minIntervalMs: 500,
    maxIntervalMs: 500,
    random,
  });
  const seen: string[] = [];
  p.update(0, 0, true);
  for (let t = 500; t <= 5000; t += 500) {
    const snap = p.update(t, 0.1, true);
    seen.push(snap.active);
  }
  assert.ok(seen.length >= 5, `switches=${seen.length}`);
  for (let i = 1; i < seen.length; i += 1) {
    assert.notEqual(seen[i], seen[i - 1], `第 ${i} 次切换与上一次相同：${seen.join(',')}`);
  }
  // 10 次抽签里三个条目都应该出现过（权重 3:1:1，排除当前条目后不会太偏）
  assert.deepEqual([...new Set(seen)].sort(), ['far', 'hands', 'legs']);
});

test('池：权重是平滑交叉淡入淡出（切换瞬间新旧同时非零，之后收敛到 0/1）', () => {
  const p = pool(0, 1500, 1500);
  p.update(0, 0, true);
  // 先把第一个条目喂到 1：rate 3.0 下 1.5s 到 0.99
  let snap = p.update(0, 0, true);
  for (let t = 16; t < 1500; t += 16) snap = p.update(t, 0.016, true);
  assert.ok((snap.weights.legs ?? 0) > 0.95, `legs=${String(snap.weights.legs)}`);

  const before = { ...snap.weights };
  // 1500ms 到期切换（random=0 → 候选里第一个 ≠ legs → hands）
  snap = p.update(1500, 0.016, true);
  assert.equal(snap.active, 'hands');
  assert.ok((snap.weights.legs ?? 0) > 0, '旧条目不能瞬间清零');
  assert.ok((snap.weights.legs ?? 0) < before.legs! + 1e-9, '旧条目开始淡出');
  assert.ok((snap.weights.hands ?? 0) > 0, '新条目不能瞬间置 1，也不能为 0');
  assert.ok((snap.weights.hands ?? 0) < 0.5, '第一拍不该一步到位');

  // 交叉淡入淡出期间权重之和保持 ≈1（每个条目用同一个 α，所以是"守恒"的）
  for (let t = 1516; t <= 2500; t += 16) {
    snap = p.update(t, 0.016, true);
    const sum = Object.values(snap.weights).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 0.02, `t=${t} sum=${sum}`);
  }
  assert.ok((snap.weights.hands ?? 0) > 0.9, `hands=${String(snap.weights.hands)}`);
  assert.ok((snap.weights.legs ?? 0) < 0.1, `legs=${String(snap.weights.legs)}`);
});

test('池：非激活时权重平滑归零且不抽签；重新激活后重新计时（不立刻切）', () => {
  const p = pool(0, 500, 500);
  let snap = p.update(0, 0, true);
  for (let t = 16; t < 400; t += 16) snap = p.update(t, 0.016, true);
  assert.ok((snap.weights.legs ?? 0) > 0.5);

  // 上下文失效（进入行走/拖拽/说话…）：500ms 后已到抽签时刻，但不得切换
  for (let t = 400; t <= 1600; t += 16) snap = p.update(t, 0.016, false);
  assert.equal(snap.active, 'legs');
  assert.equal(snap.switches, 0);
  assert.ok((snap.weights.legs ?? 0) < 0.03, `legs=${String(snap.weights.legs)}`);

  // 重新激活：先排期（15–30s 被压到 500ms），不会在回来的那一拍抽签
  snap = p.update(1600, 0.016, true);
  assert.equal(snap.switches, 0);
  assert.equal(snap.nextSwitchInMs, 500);
  for (let t = 1616; t < 2100; t += 16) snap = p.update(t, 0.016, true);
  assert.equal(snap.switches, 0);
  snap = p.update(2100, 0.016, true);
  assert.equal(snap.switches, 1);
});

test('池：setInterval 立即生效并重新排期（自检压缩时序用）', () => {
  const p = pool(0, 60_000, 60_000);
  let snap = p.update(0, 0, true);
  assert.equal(snap.nextSwitchInMs, 60_000);
  p.setInterval(100, 100);
  snap = p.update(16, 0.016, true);
  assert.equal(snap.nextSwitchInMs, 100);
  for (let t = 32; t < 116; t += 16) snap = p.update(t, 0.016, true);
  assert.equal(snap.switches, 0);
  snap = p.update(116, 0.016, true);
  assert.equal(snap.switches, 1);
});

test('池：force 强制条目（自检取证），非法名字被忽略，解除后重新排期', () => {
  const p = pool(0, 60_000, 60_000);
  p.update(0, 0, true);
  assert.equal(p.force('far'), 'far');
  let snap = p.update(16, 0.016, true);
  assert.equal(snap.active, 'far');
  assert.equal(snap.forced, 'far');
  assert.equal(snap.nextSwitchInMs, -1);
  // 被强制期间不抽签——即使早就过了 60s
  for (let t = 32; t <= 70_000; t += 100) snap = p.update(t, 0.016, true);
  assert.equal(snap.switches, 0);
  assert.equal(snap.active, 'far');
  assert.ok((snap.weights.far ?? 0) > 0.99);

  // 非法名字：不改变已有强制
  assert.equal(p.force('spin'), null);
  assert.equal(p.update(70_100, 0.016, true).active, 'far');

  // 解除：重新排期并回到默认条目（避免"强制过 headTilt 之后又一直歪着"）
  assert.equal(p.force(null), null);
  snap = p.update(70_200, 0.016, true);
  assert.equal(snap.forced, null);
  assert.equal(snap.nextSwitchInMs, 60_000);
  assert.equal(snap.active, 'legs');
  assert.equal(snap.releases, 1);
});

test('池生命周期：带 hold 的条目到时自动回默认条目，权重平滑衰减（headTilt 3–5s 回正）', () => {
  const p = createMicroPool({
    entries: [
      { kind: 'browse', weight: 1 },
      { kind: 'headTilt', weight: 1, holdMinMs: 1000, holdMaxMs: 1000 },
    ],
    minIntervalMs: 2000,
    maxIntervalMs: 2000,
    random: () => 0,
  });
  let snap = p.update(0, 0, true);
  assert.equal(snap.active, 'browse');
  assert.equal(snap.holdRemainingMs, -1);

  // 2000ms：抽到 headTilt，回正时刻 = 3000ms
  snap = p.update(2000, 0.016, true);
  assert.equal(snap.active, 'headTilt');
  assert.equal(snap.switches, 1);
  assert.equal(snap.releases, 0);
  assert.equal(snap.holdRemainingMs, 1000);

  // 到期前一直保持
  for (let t = 2016; t < 3000; t += 16) {
    snap = p.update(t, 0.016, true);
    assert.equal(snap.active, 'headTilt', `t=${t}`);
  }
  assert.equal(snap.active, 'headTilt');
  assert.ok((snap.weights.headTilt ?? 0) > 0.9);

  // 3000ms：自动回到默认条目（这不算一次随机抽签）
  snap = p.update(3000, 0.016, true);
  assert.equal(snap.active, 'browse');
  assert.equal(snap.releases, 1);
  assert.equal(snap.switches, 1);
  assert.equal(snap.holdRemainingMs, -1);

  // 权重平滑衰减到 0（不是瞬切）
  for (let t = 3016; t < 3320; t += 16) snap = p.update(t, 0.016, true);
  snap = p.update(3320, 0.016, true);
  const mid = snap.weights.headTilt ?? 0;
  assert.ok(mid > 0.05 && mid < 0.7, `mid=${mid}`);
  for (let t = 3336; t < 4000; t += 16) snap = p.update(t, 0.016, true);
  assert.ok((snap.weights.headTilt ?? 0) < 0.05, `tilt=${String(snap.weights.headTilt)}`);
  assert.ok((snap.weights.browse ?? 0) > 0.95);

  // 下一次抽签仍按原节奏（4000ms），不会因为回正而提前
  snap = p.update(4000, 0.016, true);
  assert.equal(snap.switches, 2);
});

test('池生命周期：上下文失效时非默认条目立即回默认（不把歪头带进坐姿/拖拽）', () => {
  const p = createMicroPool({
    entries: [
      { kind: 'browse', weight: 1 },
      { kind: 'headTilt', weight: 1, holdMinMs: 3000, holdMaxMs: 3000 },
    ],
    minIntervalMs: 1000,
    maxIntervalMs: 1000,
    random: () => 0,
  });
  p.update(0, 0, true);
  let snap = p.update(1000, 0.016, true);
  assert.equal(snap.active, 'headTilt');
  assert.equal(snap.releases, 0);

  // 进入坐姿/拖拽：上下文失效 → 回到默认条目、权重开始衰减
  snap = p.update(1100, 0.016, false);
  assert.equal(snap.active, 'browse');
  assert.equal(snap.releases, 1);
  for (let t = 1116; t < 1800; t += 16) snap = p.update(t, 0.016, false);
  assert.ok((snap.weights.headTilt ?? 0) < 0.05);

  // 重新激活：重新排期，不会在回来的一瞬间抽签
  snap = p.update(2000, 0.016, true);
  assert.equal(snap.switches, 1);
  assert.equal(snap.nextSwitchInMs, 1000);
});

test('池生命周期：force 期间忽略 hold（取证要能一直看），解除后回到默认条目', () => {
  const p = createMicroPool({
    entries: [
      { kind: 'browse', weight: 1 },
      { kind: 'headTilt', weight: 1, holdMinMs: 1000, holdMaxMs: 1000 },
    ],
    minIntervalMs: 2000,
    maxIntervalMs: 2000,
    random: () => 0,
  });
  p.update(0, 0, true);
  assert.equal(p.force('headTilt'), 'headTilt');
  let snap = p.update(16, 0.016, true);
  assert.equal(snap.active, 'headTilt');
  assert.equal(snap.forced, 'headTilt');
  assert.equal(snap.holdRemainingMs, -1);
  for (let t = 32; t <= 8000; t += 100) snap = p.update(t, 0.016, true);
  assert.equal(snap.active, 'headTilt');
  assert.equal(snap.releases, 0);
  assert.equal(snap.switches, 0);

  // 解除强制 → 默认条目 + 权重平滑衰减
  p.force(null);
  snap = p.update(8100, 0.016, true);
  assert.equal(snap.active, 'browse');
  assert.equal(snap.releases, 1);
  for (let t = 8116; t < 9700; t += 16) snap = p.update(t, 0.016, true);
  assert.ok((snap.weights.headTilt ?? 0) < 0.05);
});

test('池：生产条目都配了合理的 hold（headTilt 3–5s、hands/far 4–8s）', () => {
  const idleTilt = IDLE_MICRO_POOL.find((entry) => entry.kind === 'headTilt');
  assert.ok(idleTilt);
  assert.equal(idleTilt.holdMinMs, 3000);
  assert.equal(idleTilt.holdMaxMs, 5000);
  // 默认条目（browse/legs）不设 hold：它们就是"底噪"，要保持到下一次抽签
  assert.equal(IDLE_MICRO_POOL[0]?.kind, 'browse');
  assert.equal(IDLE_MICRO_POOL[0]?.holdMinMs, undefined);
  for (const kind of ['hands', 'far'] as const) {
    const entry = SIT_MICRO_POOL.find((item) => item.kind === kind);
    assert.ok(entry, `缺少 ${kind}`);
    assert.ok((entry.holdMinMs ?? 0) >= 4000, `${kind} holdMin`);
    assert.ok((entry.holdMaxMs ?? 0) <= 8000, `${kind} holdMax`);
  }
  assert.equal(SIT_MICRO_POOL[0]?.kind, 'legs');
  assert.equal(SIT_MICRO_POOL[0]?.holdMinMs, undefined);
});

test('池：reset 回到第一个条目、权重归零、计数清零', () => {
  const p = pool(0, 500, 500);
  for (let t = 0; t <= 2000; t += 16) p.update(t, 0.016, true);
  assert.ok(p.snapshot()!.switches >= 1);
  p.reset(3000);
  const snap = p.snapshot();
  assert.equal(snap, null);
  const after = p.update(3000, 0.016, true);
  assert.equal(after.active, 'legs');
  assert.equal(after.switches, 0);
  assert.equal(after.nextSwitchInMs, 500);
  assert.ok(Object.values(after.weights).every((weight) => weight < 0.1));
});

test('池：空条目池直接抛错（装配错误必须在启动期暴露）', () => {
  assert.throws(() => createMicroPool({ entries: [] }), /至少需要一个条目/);
});

test('池：过渡速率常量的口径（1-exp(-rate·dt)）被单测锁死', () => {
  // 这条断言的目的不是"数字好看"，而是防止有人把 rate 改成"每帧固定 0.1"这类帧率相关写法：
  // rate=3.0 时 160ms 的过渡量应 ≈ 1-e^{-0.48} ≈ 0.381。
  const expected = 1 - Math.exp(-MICRO_POOL_TRANSITION_RATE * 0.16);
  assert.ok(expected > 0.35 && expected < 0.42, String(expected));
});
