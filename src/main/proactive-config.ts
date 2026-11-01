/**
 * 主动性开关与阈值的解析（ADR 0031 D6）。
 *
 * 单独成一个**不 import Electron** 的文件，只为一个目的：能在普通 Node 里单测。
 * 这条开关的优先级本身就是需求的一部分，值得被断言而不是被"读代码相信"。
 *
 * 优先级（高 → 低）：
 * 1. `PET_PROACTIVE_DISABLE=1` → 一律关闭（用户逃生口，也用于排查"她怎么突然说话了"）；
 * 2. `PET_SELFTEST=1` → **默认硬关**（自检对时序/截图有强断言，随机插话会随机翻红）；
 * 3. `PET_SELFTEST=1` + `PET_SELFTEST_PROACTIVE=1` → 开（专门验收主动性）；
 * 4. 其余情况 → 开。
 *
 * 阈值可用 `PET_PROACTIVE_*` 覆盖（与 `PET_TTS_*` / `PET_LLM_*` 同一套做法）：默认值永远来自
 * `constants.ts`，这里只做"显式给了才覆盖"，缺省时返回空对象——因此不改变任何默认行为。
 */
import { truthyFlag } from './env-flags';
import type { IdleDriveThresholds } from './orchestrator/idle-drive';

/**
 * `truthy` 与 `heartbeat-config`（ADR 0033）共用 `env-flags` 的实现：
 * 两处若各写一份，就会出现"一个认 `on`、另一个不认"这类最难在真机上发现的语义偏差。
 */
const truthy = truthyFlag;

function readInt(
  env: NodeJS.ProcessEnv,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const raw = env[key];
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export interface ProactiveGate {
  enabled: boolean;
  /** 人类可读的原因，进启动日志与 `snapshot()`（排查"为什么她不说话"的第一现场） */
  reason: string;
  /** 只包含**显式**覆盖过的阈值；空对象 = 全用 constants.ts 的默认值 */
  thresholds: Partial<IdleDriveThresholds>;
}

/** 阈值的合法区间：防止 `PET_PROACTIVE_MIN_IDLE_MS=0` 把"打扰抑制"整段关掉。 */
const MIN_IDLE_RANGE = [1_000, 3_600_000] as const;
const MAX_IDLE_RANGE = [2_000, 86_400_000] as const;
const COOLDOWN_RANGE = [0, 86_400_000] as const;
const GAP_RANGE = [0, 86_400_000] as const;
const BUDGET_RANGE = [1, 100] as const;

export function resolveProactiveThresholds(env: NodeJS.ProcessEnv = process.env): Partial<IdleDriveThresholds> {
  const thresholds: Partial<IdleDriveThresholds> = {};
  const minIdle = readInt(env, 'PET_PROACTIVE_MIN_IDLE_MS', MIN_IDLE_RANGE[0], MIN_IDLE_RANGE[1]);
  const maxIdle = readInt(env, 'PET_PROACTIVE_MAX_IDLE_MS', MAX_IDLE_RANGE[0], MAX_IDLE_RANGE[1]);
  const cooldown = readInt(env, 'PET_PROACTIVE_COOLDOWN_MS', COOLDOWN_RANGE[0], COOLDOWN_RANGE[1]);
  const gap = readInt(env, 'PET_PROACTIVE_MIN_GAP_MS', GAP_RANGE[0], GAP_RANGE[1]);
  const budget = readInt(env, 'PET_PROACTIVE_BUDGET', BUDGET_RANGE[0], BUDGET_RANGE[1]);

  if (minIdle !== undefined) thresholds.minUserIdleMs = minIdle;
  if (maxIdle !== undefined) thresholds.maxUserIdleMs = maxIdle;
  if (cooldown !== undefined) thresholds.cooldownMs = cooldown;
  if (gap !== undefined) thresholds.minInteractionGapMs = gap;
  if (budget !== undefined) thresholds.sessionBudget = budget;

  // 上下界写反时以"更保守"的一侧为准：宁可她少说话
  if (
    thresholds.minUserIdleMs !== undefined &&
    thresholds.maxUserIdleMs !== undefined &&
    thresholds.minUserIdleMs >= thresholds.maxUserIdleMs
  ) {
    thresholds.maxUserIdleMs = thresholds.minUserIdleMs + 1_000;
  }
  return thresholds;
}

export function resolveProactiveEnabled(env: NodeJS.ProcessEnv = process.env): ProactiveGate {
  const thresholds = resolveProactiveThresholds(env);
  if (truthy(env['PET_PROACTIVE_DISABLE'])) {
    return { enabled: false, reason: 'PET_PROACTIVE_DISABLE=1', thresholds };
  }
  if (env['PET_SELFTEST'] === '1') {
    return truthy(env['PET_SELFTEST_PROACTIVE'])
      ? { enabled: true, reason: 'PET_SELFTEST=1 + PET_SELFTEST_PROACTIVE=1', thresholds }
      : { enabled: false, reason: 'PET_SELFTEST=1（自检默认硬关）', thresholds };
  }
  return { enabled: true, reason: 'default', thresholds };
}
