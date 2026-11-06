import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IDLE_VARIATION_FADE_SECONDS,
  IDLE_VARIATION_MAX_MS,
  IDLE_VARIATION_MIN_MS,
} from '../../shared/constants';
import { CLIP_RULES } from './clip-bank';
import {
  IDLE_VARIATION_CANDIDATES,
  IDLE_VARIATION_ROLES,
  createIdleVariation,
  nextIdleVariationDelayMs,
  pickIdleVariationRole,
} from './idle-variation';

test('站姿轮换：间隔落在 20–45s，随机源被夹取、不产生 NaN', () => {
  assert.equal(IDLE_VARIATION_MIN_MS, 20_000);
  assert.equal(IDLE_VARIATION_MAX_MS, 45_000);
  assert.equal(IDLE_VARIATION_FADE_SECONDS, 0.8);
  assert.equal(nextIdleVariationDelayMs(() => 0), IDLE_VARIATION_MIN_MS);
  assert.equal(nextIdleVariationDelayMs(() => 1), IDLE_VARIATION_MAX_MS);
  assert.equal(
    nextIdleVariationDelayMs(() => 0.5),
    Math.round((IDLE_VARIATION_MIN_MS + IDLE_VARIATION_MAX_MS) / 2),
  );
  for (const value of [-1, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
    const delay = nextIdleVariationDelayMs(() => value);
    assert.ok(Number.isFinite(delay), `value=${value}`);
    assert.ok(delay >= IDLE_VARIATION_MIN_MS && delay <= IDLE_VARIATION_MAX_MS, `value=${value}`);
  }
});

test('候选池：全部是正面静态循环片段的语义角色，且不含 Cafe_Reaction / Normal_Idle', () => {
  assert.equal(IDLE_VARIATION_ROLES.length, 7);
  for (const candidate of IDLE_VARIATION_CANDIDATES) {
    // 角色→片段必须与 `clip-bank` 的精确名一致（改表时不会悄悄漂移）
    assert.equal(CLIP_RULES[candidate.role].exact, candidate.clip, candidate.role);
    assert.equal(CLIP_RULES[candidate.role].loop, true, candidate.role);
    assert.ok(!candidate.clip.includes('Cafe_Reaction'), `${candidate.role} 不得来自一次性演出`);
    assert.ok(candidate.clip !== 'CH0335_Normal_Idle', '侧身战斗待机不得进池');
  }
  const names = IDLE_VARIATION_CANDIDATES.map((candidate) => candidate.clip);
  assert.ok(names.includes('CH0335_Cafe_Idle'));
  assert.ok(names.includes('CH0335_Formation_Idle'));
});

test('抽签：永远不抽当前角色，只从可用角色里抽；没有候选时返回 null', () => {
  const available = (): boolean => true;
  // random=0 → 候选列表第一个；候选已排除 current
  for (let i = 0; i < 20; i += 1) {
    const current = IDLE_VARIATION_ROLES[i % IDLE_VARIATION_ROLES.length]!;
    const picked = pickIdleVariationRole(current, available, () => (i % 7) / 7);
    assert.notEqual(picked, current);
    assert.ok(picked !== null && IDLE_VARIATION_ROLES.includes(picked));
  }
  // 只允许一个角色：它恰好是当前角色 → 无候选
  const only = IDLE_VARIATION_ROLES[0]!;
  assert.equal(pickIdleVariationRole(only, (role) => role === only, () => 0), null);
  // 片段全部缺失 → 不切
  assert.equal(pickIdleVariationRole('idle', () => false, () => 0), null);
  // 只剩一个别的角色 → 一定抽到它（随机源不影响）
  const next = IDLE_VARIATION_ROLES[1]!;
  for (const sample of [0, 0.25, 0.99, 1, Number.NaN]) {
    assert.equal(pickIdleVariationRole('idle', (role) => role === next, () => sample), next);
  }
});

test('调度器：不到点不换、到点换一次并重新排期、忙时不换（顺延）', () => {
  const scheduler = createIdleVariation({ random: () => 0 });
  const available = (): boolean => true;
  scheduler.reset(0);
  assert.equal(scheduler.tick(19_999, true, available), null);
  const first = scheduler.tick(20_000, true, available);
  assert.equal(first, 'idle.alt1');
  assert.equal(scheduler.snapshot(20_000).switches, 1);
  // 下一次间隔仍是 20s（random=0）；候选排除当前 alt1，第一个可用的是 idle
  assert.equal(scheduler.tick(39_999, true, available), null);
  assert.equal(scheduler.tick(40_000, true, available), 'idle');

  // 忙的时候到期：不换，并把排期推后到恢复之后
  const busy = createIdleVariation({ random: () => 0 });
  busy.reset(0);
  assert.equal(busy.tick(30_000, false, available), null);
  assert.equal(busy.tick(30_100, true, available), null, '恢复后不得立刻换姿势');
  assert.equal(busy.tick(49_999, true, available), null);
  assert.equal(busy.tick(50_000, true, available), 'idle.alt1');
});

test('调度器：强制角色只生效一次、非法角色被忽略、解除后回到生产节奏', () => {
  const scheduler = createIdleVariation({ random: () => 0 });
  const available = (): boolean => true;
  scheduler.reset(0);
  assert.equal(scheduler.force('idle.alt4', 0), 'idle.alt4');
  assert.equal(scheduler.tick(100, true, available), 'idle.alt4');
  assert.equal(scheduler.tick(101, true, available), null);
  assert.equal(scheduler.snapshot(101).switches, 0, '强制切换不计入随机抽签次数');
  assert.equal(scheduler.force('nope' as never, 101), null);
  assert.equal(scheduler.force(null, 101), null);
  assert.equal(scheduler.tick(20_101, true, available), 'idle');
});

test('调度器：间隔覆盖与快照字段（自检压缩时序用）', () => {
  const scheduler = createIdleVariation({ random: () => 0.5 });
  scheduler.reset(1000);
  scheduler.setIdleInterval(650, 650, 1000);
  assert.equal(scheduler.snapshot(1000).nextInMs, 650);
  assert.equal(scheduler.tick(1649, true, () => true), null);
  const role = scheduler.tick(1650, true, () => true);
  assert.ok(role !== null);
  const snap = scheduler.snapshot(1650);
  assert.equal(snap.minIntervalMs, 650);
  assert.equal(snap.maxIntervalMs, 650);
  assert.equal(snap.fadeSeconds, 0.8);
  assert.equal(snap.role, role);
  assert.equal(snap.clip, CLIP_RULES[role!].exact);
  assert.equal(snap.candidates.length, 7);
});
