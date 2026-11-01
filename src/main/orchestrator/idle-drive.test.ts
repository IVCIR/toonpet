import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROACTIVE_COOLDOWN_MS,
  PROACTIVE_MAX_USER_IDLE_MS,
  PROACTIVE_MIN_INTERACTION_GAP_MS,
  PROACTIVE_MIN_USER_IDLE_MS,
  PROACTIVE_SESSION_BUDGET,
} from '../../shared/constants';
import {
  DEFAULT_IDLE_DRIVE_THRESHOLDS,
  effectiveBudget,
  evaluateIdleDrive,
  isNightHour,
} from './idle-drive';
import type { IdleDriveInput } from './idle-drive';

/** 本地 21:00 —— 白天档，避免测试跟着运行时的钟走。 */
const DAY = new Date(2026, 10, 1, 21, 0, 0).getTime();
const HOUR = 3_600_000;

function input(overrides: Partial<IdleDriveInput> = {}): IdleDriveInput {
  return {
    enabled: true,
    now: DAY,
    sessionStartedAt: DAY - 6 * HOUR,
    orchestratorIdle: true,
    voiceBusy: false,
    userIdleMs: 120_000,
    lastInteractionAt: DAY - 120_000,
    lastProactiveAt: null,
    firedCount: 0,
    llmUsable: true,
    ...overrides,
  };
}

test('idle-drive：四个条件全满足 → 开口，且允许升级到 LLM', () => {
  const decision = evaluateIdleDrive(input());
  assert.equal(decision.fire, true);
  assert.equal(decision.reason, 'ok');
  assert.equal(decision.allowLlm, true);
  assert.equal(decision.night, false);
  assert.equal(decision.hour, 21);
  assert.equal(decision.budget, PROACTIVE_SESSION_BUDGET);
  assert.equal(decision.remaining, PROACTIVE_SESSION_BUDGET);
});

test('idle-drive：总开关关闭 → disabled（优先级最高，不看其他条件）', () => {
  const decision = evaluateIdleDrive(input({ enabled: false, userIdleMs: null, orchestratorIdle: false }));
  assert.equal(decision.fire, false);
  assert.equal(decision.reason, 'disabled');
});

test('idle-drive：编排层在途 / 语音在播 → busy', () => {
  assert.equal(evaluateIdleDrive(input({ orchestratorIdle: false })).reason, 'busy');
  assert.equal(evaluateIdleDrive(input({ voiceBusy: true })).reason, 'busy');
  // busy 先于 no-presence：正在说话时不该再去看用户状态
  assert.equal(evaluateIdleDrive(input({ voiceBusy: true, userIdleMs: null })).reason, 'busy');
});

test('idle-drive：读不到空闲毫秒 → no-presence（宁可沉默，不猜）', () => {
  assert.equal(evaluateIdleDrive(input({ userIdleMs: null })).reason, 'no-presence');
  assert.equal(evaluateIdleDrive(input({ userIdleMs: Number.NaN })).reason, 'no-presence');
});

test('idle-drive：用户还在操作（<90s）→ user-active；正好 90s → 开口', () => {
  assert.equal(evaluateIdleDrive(input({ userIdleMs: 89_999 })).reason, 'user-active');
  assert.equal(evaluateIdleDrive(input({ userIdleMs: PROACTIVE_MIN_USER_IDLE_MS })).reason, 'ok');
});

test('idle-drive：离开太久（>5min）→ user-away；正好 5min 仍算"在场"', () => {
  assert.equal(evaluateIdleDrive(input({ userIdleMs: 300_001 })).reason, 'user-away');
  assert.equal(evaluateIdleDrive(input({ userIdleMs: PROACTIVE_MAX_USER_IDLE_MS })).reason, 'ok');
});

test('idle-drive：距上次交互不足 90s → gap（摸头/说话都算交互）', () => {
  assert.equal(
    evaluateIdleDrive(input({ lastInteractionAt: DAY - PROACTIVE_MIN_INTERACTION_GAP_MS + 1 })).reason,
    'gap',
  );
  assert.equal(
    evaluateIdleDrive(input({ lastInteractionAt: DAY - PROACTIVE_MIN_INTERACTION_GAP_MS })).reason,
    'ok',
  );
});

test('idle-drive：本会话还没有交互时，gap 以"用户最后一次输入"为基准（不是进程启动）', () => {
  // 真机场景：应用在用户已离开 4 分钟后才启动。若用 sessionStartedAt 当基准，
  // 等 gap 满 90s 时 userIdle 会越过 5 分钟 → 永远 user-away，一次都不开口。
  const launchedJustNow = input({
    lastInteractionAt: null,
    sessionStartedAt: DAY - 1_000,
    userIdleMs: 240_000,
  });
  assert.equal(evaluateIdleDrive(launchedJustNow).reason, 'ok');

  // 用户刚有输入（10s 前）→ gap 未满足
  assert.equal(
    evaluateIdleDrive(input({ lastInteractionAt: null, userIdleMs: 10_000 })).reason,
    'user-active',
  );

  // 有显式交互记录时，永远以它为准（哪怕 userIdle 更大）
  assert.equal(
    evaluateIdleDrive(
      input({ lastInteractionAt: DAY - 10_000, sessionStartedAt: DAY - 5 * HOUR, userIdleMs: 200_000 }),
    ).reason,
    'gap',
  );
});

test('idle-drive：预算耗尽 → budget；预算先于冷却判定', () => {
  assert.equal(
    evaluateIdleDrive(input({ firedCount: PROACTIVE_SESSION_BUDGET })).reason,
    'budget',
  );
  const lastOne = evaluateIdleDrive(input({ firedCount: PROACTIVE_SESSION_BUDGET - 1 }));
  assert.equal(lastOne.fire, true);
  assert.equal(lastOne.remaining, 1);

  // 预算耗尽 + 冷却未过：报 budget（先归因于不可恢复的那一条）
  assert.equal(
    evaluateIdleDrive(
      input({ firedCount: PROACTIVE_SESSION_BUDGET, lastProactiveAt: DAY - 1000 }),
    ).reason,
    'budget',
  );
});

test('idle-drive：冷却未过 → cooldown；正好 10 分钟 → 开口', () => {
  assert.equal(
    evaluateIdleDrive(input({ lastProactiveAt: DAY - PROACTIVE_COOLDOWN_MS + 1 })).reason,
    'cooldown',
  );
  assert.equal(evaluateIdleDrive(input({ lastProactiveAt: DAY - PROACTIVE_COOLDOWN_MS })).reason, 'ok');
});

test('idle-drive：深夜 23:00–07:00 预算减半，且区间必须跨零点正确环绕', () => {
  assert.equal(isNightHour(23), true);
  assert.equal(isNightHour(0), true);
  assert.equal(isNightHour(6), true);
  assert.equal(isNightHour(7), false, '07:00 已经是白天');
  assert.equal(isNightHour(22), false);

  const late = new Date(2026, 10, 1, 23, 30, 0).getTime();
  const nightDecision = evaluateIdleDrive(input({ now: late, lastInteractionAt: late - 120_000 }));
  assert.equal(nightDecision.night, true);
  assert.equal(nightDecision.budget, Math.floor(PROACTIVE_SESSION_BUDGET / 2));
  assert.equal(nightDecision.fire, true);

  // 深夜第 6 次之后不再开口（白天这时还能说）
  assert.equal(
    evaluateIdleDrive(
      input({ now: late, lastInteractionAt: late - 120_000, firedCount: nightDecision.budget }),
    ).reason,
    'budget',
  );
  assert.equal(
    evaluateIdleDrive(input({ firedCount: nightDecision.budget, lastInteractionAt: DAY - 120_000 })).reason,
    'ok',
  );

  // 早上 6:59 仍算深夜
  assert.equal(effectiveBudget(DEFAULT_IDLE_DRIVE_THRESHOLDS, 6), 6);
  assert.equal(effectiveBudget(DEFAULT_IDLE_DRIVE_THRESHOLDS, 7), 12);
});

test('idle-drive：LLM 不可用时仍然开口（只走规则），但 allowLlm=false', () => {
  const decision = evaluateIdleDrive(input({ llmUsable: false }));
  assert.equal(decision.fire, true);
  assert.equal(decision.allowLlm, false);
});

test('idle-drive：阈值可注入（自检/单测压时间用）', () => {
  const decision = evaluateIdleDrive(
    input({
      userIdleMs: 1000,
      lastInteractionAt: DAY - 100,
      thresholds: { minUserIdleMs: 500, maxUserIdleMs: 5000, minInteractionGapMs: 50, sessionBudget: 2 },
    }),
  );
  assert.equal(decision.fire, true);
  assert.equal(decision.budget, 2);
});

test('idle-drive：时间倒退（lastInteractionAt 在未来）按 gap 未满足处理', () => {
  assert.equal(evaluateIdleDrive(input({ lastInteractionAt: DAY + 10_000 })).reason, 'gap');
});
