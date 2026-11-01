/**
 * idle-drive（ADR 0031）：**纯函数**的"要不要主动开口"判定器。
 *
 * 每 15 秒被调一次（`PROACTIVE_TICK_MS`），输入是当前时刻 + 编排状态 + 在场感读数，
 * 输出是"开不开口 / 为什么不开 / 能不能升级到 LLM"。**不读时钟、不碰 IO、不起定时器**：
 * 时间由调用方传入，因此所有边界条件都能在 Node 里用假时钟穷举。
 *
 * 判定的顺序即优先级（命中即返回，不继续往下看）：
 *   disabled → busy → no-presence → user-active → user-away → gap → budget → cooldown → ok
 *
 * 三条硬性约束（ADR 0031 D2/D3）：
 * 1. **用户不在时不许说话**：空闲 > 5 分钟视为"人离开了"，此时开口对着空房间说话最伤体验；
 * 2. **预算比冷却优先**：预算耗尽时不再看冷却，避免"冷却刚过又来说一句"；
 * 3. **同等条件下永久沉默**：任何字段为 `null`（读不到）都判"不打扰"，不猜。
 */
import {
  PROACTIVE_COOLDOWN_MS,
  PROACTIVE_MAX_USER_IDLE_MS,
  PROACTIVE_MIN_INTERACTION_GAP_MS,
  PROACTIVE_MIN_USER_IDLE_MS,
  PROACTIVE_NIGHT_END_HOUR,
  PROACTIVE_NIGHT_START_HOUR,
  PROACTIVE_SESSION_BUDGET,
} from '../../shared/constants';

export type IdleDriveReason =
  | 'ok'
  | 'disabled'
  | 'busy'
  | 'no-presence'
  | 'user-active'
  | 'user-away'
  | 'gap'
  | 'budget'
  | 'cooldown';

export interface IdleDriveThresholds {
  minUserIdleMs: number;
  maxUserIdleMs: number;
  minInteractionGapMs: number;
  cooldownMs: number;
  sessionBudget: number;
  nightStartHour: number;
  nightEndHour: number;
}

export const DEFAULT_IDLE_DRIVE_THRESHOLDS: IdleDriveThresholds = {
  minUserIdleMs: PROACTIVE_MIN_USER_IDLE_MS,
  maxUserIdleMs: PROACTIVE_MAX_USER_IDLE_MS,
  minInteractionGapMs: PROACTIVE_MIN_INTERACTION_GAP_MS,
  cooldownMs: PROACTIVE_COOLDOWN_MS,
  sessionBudget: PROACTIVE_SESSION_BUDGET,
  nightStartHour: PROACTIVE_NIGHT_START_HOUR,
  nightEndHour: PROACTIVE_NIGHT_END_HOUR,
};

export interface IdleDriveInput {
  /** 总开关（`PET_SELFTEST=1` 时由 runtime 硬关，ADR 0031 D6） */
  enabled: boolean;
  now: number;
  /** 进程启动时刻：本会话还没有任何交互时，用它与 `gap` 比较 */
  sessionStartedAt: number;
  /** 编排层 `state === 'idle'`（没有在途话语） */
  orchestratorIdle: boolean;
  /** `voice` 是否在播（订阅 `speech_started` / `speech_ended` 得到的） */
  voiceBusy: boolean;
  /** 系统级键鼠空闲毫秒；`null` = 读不到 */
  userIdleMs: number | null;
  /** 上一次用户主动交互（说话 / 摸头）；`null` = 本会话还没有过 */
  lastInteractionAt: number | null;
  /** 上一次主动开口；`null` = 还没有过 */
  lastProactiveAt: number | null;
  /** 本会话已主动开口次数（规则 + LLM 合并计） */
  firedCount: number;
  /** LLM 路径当前是否可用（健康检查已通过且未熔断，ADR 0031 D4） */
  llmUsable: boolean;
  thresholds?: Partial<IdleDriveThresholds>;
}

export interface IdleDriveDecision {
  fire: boolean;
  reason: IdleDriveReason;
  /** `fire === true` 时，是否允许升级到 LLM（否则只用规则池台词） */
  allowLlm: boolean;
  /** 本次生效的每会话预算（深夜减半） */
  budget: number;
  /** 本次生效的预算余量（已扣掉本次） */
  remaining: number;
  night: boolean;
  hour: number;
}

/**
 * 深夜判定：默认 23:00–07:00。区间跨零点（start > end）时必须按"环绕"比较，
 * 否则 `hour >= 23 && hour < 7` 会永远为假——这是最容易写错的一行。
 */
export function isNightHour(hour: number, start: number = PROACTIVE_NIGHT_START_HOUR, end: number = PROACTIVE_NIGHT_END_HOUR): boolean {
  if (!Number.isFinite(hour)) return false;
  if (start === end) return false;
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

/** 深夜预算减半（向下取整，至少 1）；白天用满额。 */
export function effectiveBudget(thresholds: IdleDriveThresholds, hour: number): number {
  const base = Math.max(1, Math.floor(thresholds.sessionBudget));
  if (!isNightHour(hour, thresholds.nightStartHour, thresholds.nightEndHour)) return base;
  return Math.max(1, Math.floor(base / 2));
}

export function evaluateIdleDrive(input: IdleDriveInput): IdleDriveDecision {
  const thresholds: IdleDriveThresholds = { ...DEFAULT_IDLE_DRIVE_THRESHOLDS, ...input.thresholds };
  const hour = new Date(input.now).getHours();
  const night = isNightHour(hour, thresholds.nightStartHour, thresholds.nightEndHour);
  const budget = effectiveBudget(thresholds, hour);
  const remaining = Math.max(0, budget - Math.max(0, input.firedCount));

  const result = (
    fire: boolean,
    reason: IdleDriveReason,
    allowLlm = false,
  ): IdleDriveDecision => ({ fire, reason, allowLlm, budget, remaining, night, hour });

  if (!input.enabled) return result(false, 'disabled');
  if (!input.orchestratorIdle || input.voiceBusy) return result(false, 'busy');

  // 读不到"用户不在"就绝不打扰：宁可全程沉默，也不在用户打字时插嘴
  if (input.userIdleMs === null || !Number.isFinite(input.userIdleMs)) {
    return result(false, 'no-presence');
  }
  if (input.userIdleMs < thresholds.minUserIdleMs) return result(false, 'user-active');
  if (input.userIdleMs > thresholds.maxUserIdleMs) return result(false, 'user-away');

  // gap 的基准（ADR 0031 D2.1）：
  // - 有过交互 → 用那次交互；
  // - 本会话还没有交互 → 用"用户最后一次输入"（`now - userIdleMs`），而**不是**进程启动时刻。
  //   真机踩到过：应用在用户已经离开 4 分钟后启动时，若用 sessionStartedAt，等 gap 满 90s 时
  //   userIdle 已经越过 5 分钟 → 永远判 user-away，她一次都不会开口。
  const reference =
    input.lastInteractionAt ??
    (input.userIdleMs !== null && Number.isFinite(input.userIdleMs)
      ? input.now - input.userIdleMs
      : input.sessionStartedAt);
  const gap = input.now - reference;
  if (!Number.isFinite(gap) || gap < thresholds.minInteractionGapMs) return result(false, 'gap');

  if (remaining <= 0) return result(false, 'budget');

  if (input.lastProactiveAt !== null) {
    const since = input.now - input.lastProactiveAt;
    if (!Number.isFinite(since) || since < thresholds.cooldownMs) return result(false, 'cooldown');
  }

  return result(true, 'ok', Boolean(input.llmUsable));
}
