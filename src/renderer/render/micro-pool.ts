/**
 * 微动作池的**调度器**（ADR 0049 D1；真机第二轮补"条目生命周期"）。
 *
 * 职责只有一件事：每隔 15–30s 从条目池里随机换一个"当前主打的微动作"，
 * 并用指数插值维护每个条目的**权重**（0..1，同时在跑的所有条目之和趋近 1）。
 *
 * 为什么权重而不是"当前条目名"：
 * - 需求要求"过渡用现有的平滑插值（不要瞬间切换）"。只给名字的话，调用方还得自己
 *   记上一帧、自己淡入淡出；把权重放在这里，调用方只需要把每个条目的姿态 offsets
 *   乘上它自己的权重再相加 —— 换条目时旧条目淡出、新条目淡入，天然交叉混合。
 * - 池里有 3:1:1 这种权重分布，"当前条目"仍然只有一个（抽签结果），
 *   所以"这一段时间主打什么"是明确的，可诊断、可单测。
 *
 * **条目生命周期**（真机问题二）：`headTilt` 这种"一次性小动作"不能一直保持到下一次
 * 抽签（15–30s 后），否则会看到"歪头之后一直歪着"。条目可以带 `holdMinMs/holdMaxMs`：
 * 到时后 `active` 自动回到**默认条目**（池里的第一项），权重按同一套指数衰减到 0；
 * 下一次随机抽签仍按 15–30s 的节奏走。默认条目本身不设 hold。
 *
 * 纯逻辑：不引用 three、不读时钟、不碰 DOM，可脱离 WebGL 单测。
 */
import {
  MICRO_POOL_MAX_MS,
  MICRO_POOL_MIN_MS,
  MICRO_POOL_TRANSITION_RATE,
  type MicroPoolEntry,
} from '../../shared/constants';

export interface MicroPoolOptions<K extends string> {
  entries: readonly MicroPoolEntry<K>[];
  /** 切换间隔区间（ms）；缺省用 `MICRO_POOL_MIN/MAX_MS` */
  minIntervalMs?: number;
  maxIntervalMs?: number;
  /** 权重过渡速率（1/s）；缺省 `MICRO_POOL_TRANSITION_RATE` */
  transitionRatePerSecond?: number;
  /** 注入随机源（单测/自检）；缺省 `Math.random` */
  random?: () => number;
}

export interface MicroPoolSnapshot<K extends string> {
  /** 当前主打的条目 */
  active: K;
  /** 每个条目的当前权重（0..1；同时激活时之和趋近 1） */
  weights: Record<K, number>;
  /** 距下一次抽签还有多久（ms）；-1 = 正在强制指定 / 尚未排期 */
  nextSwitchInMs: number;
  /** 累计抽签次数（初始条目不计） */
  switches: number;
  /** 累计"非默认条目到时/上下文失效 → 回到默认"的次数 */
  releases: number;
  /** 当前条目已经持续多久（ms） */
  activeForMs: number;
  /** 距当前条目自动回正还有多久（ms）；-1 = 默认条目 / 强制中 / 不设维持时长 */
  holdRemainingMs: number;
  /** 诊断用：被 `force()` 强制指定的条目（null = 正常随机） */
  forced: K | null;
}

export interface MicroPool<K extends string> {
  /**
   * 推进一帧。
   * @param nowMs 单调时钟（performance.now）
   * @param dtSeconds 距上一帧秒数（NaN/负值按 0）
   * @param active 当前上下文是否允许微动作（false → 所有权重平滑归零，并在重新激活时重新排期）
   */
  update(nowMs: number, dtSeconds: number, active: boolean): MicroPoolSnapshot<K>;
  /** 最近一帧快照（没跑过返回 null） */
  snapshot(): MicroPoolSnapshot<K> | null;
  /** 重置（重新进入状态时调用：回到第一个条目、权重归零、重新排期） */
  reset(nowMs: number): void;
  /**
   * 覆盖切换间隔（自检压缩时序用；**不是**生产参数）。
   * 下一拍生效并重新排期——否则当前那 15–30s 的截止时间会挡在中间。
   */
  setInterval(minIntervalMs: number, maxIntervalMs: number): void;
  /**
   * 强制指定条目（自检取证用；`null` = 解除并回到默认条目）。
   * 强制期间**忽略 hold**（诊断要能一直看这个姿态）；非法条目名被忽略并返回 null。
   */
  force(kind: K | string | null): K | null;
}

/** 间隔下限（ms）：再小就不是"偶尔一次"了（自检压缩也只用 600ms 左右） */
const INTERVAL_FLOOR_MS = 50;
/** dt 上限（s）：与 render 循环的其它缓冲一致，避免切后台回来时权重瞬移 */
const MAX_DT_SECONDS = 0.1;

/** 取一个 [0,1] 随机数；注入源返回 NaN/∞/越界时钳到安全值。 */
function sampleUnit(random: () => number): number {
  const value = random();
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function clampInterval(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(INTERVAL_FLOOR_MS, Math.round(value));
}

interface NormalizedEntry<K extends string> {
  kind: K;
  weight: number;
  /** 维持时长（ms）；null = 维持到下一次抽签 */
  holdMinMs: number | null;
  holdMaxMs: number | null;
}

export function createMicroPool<K extends string>(
  options: MicroPoolOptions<K>,
): MicroPool<K> {
  const entries: Array<NormalizedEntry<K>> = options.entries
    .map((entry) => {
      const weight = Number.isFinite(entry.weight) && entry.weight > 0 ? entry.weight : 1;
      const hasHold = Number.isFinite(entry.holdMinMs) || Number.isFinite(entry.holdMaxMs);
      if (!hasHold) return { kind: entry.kind, weight, holdMinMs: null, holdMaxMs: null };
      const first = Number.isFinite(entry.holdMinMs) ? (entry.holdMinMs as number) : Number.NaN;
      const second = Number.isFinite(entry.holdMaxMs) ? (entry.holdMaxMs as number) : Number.NaN;
      const one = Number.isFinite(first) ? first : second;
      const two = Number.isFinite(second) ? second : first;
      return {
        kind: entry.kind,
        weight,
        holdMinMs: Math.max(0, Math.min(one, two)),
        holdMaxMs: Math.max(0, Math.max(one, two)),
      };
    })
    .filter((entry) => typeof entry.kind === 'string' && entry.kind.length > 0);
  if (entries.length === 0) throw new Error('微动作池至少需要一个条目（ADR 0049 D1）');

  const random = options.random ?? Math.random;
  let minIntervalMs = clampInterval(options.minIntervalMs ?? MICRO_POOL_MIN_MS, MICRO_POOL_MIN_MS);
  let maxIntervalMs = clampInterval(options.maxIntervalMs ?? MICRO_POOL_MAX_MS, MICRO_POOL_MAX_MS);
  if (minIntervalMs > maxIntervalMs) {
    const swap = minIntervalMs;
    minIntervalMs = maxIntervalMs;
    maxIntervalMs = swap;
  }
  const transitionRate =
    Number.isFinite(options.transitionRatePerSecond) && (options.transitionRatePerSecond as number) > 0
      ? (options.transitionRatePerSecond as number)
      : MICRO_POOL_TRANSITION_RATE;

  const kinds = entries.map((entry) => entry.kind);
  const byKind = new Map<K, NormalizedEntry<K>>(entries.map((entry) => [entry.kind, entry]));
  /** 默认条目 = 池里的第一项（`browse` / `legs`）；非默认条目到时后都回到它 */
  const defaultKind: K = entries[0]!.kind;
  const weights = {} as Record<K, number>;
  for (const entry of entries) weights[entry.kind] = 0;

  let active: K = defaultKind;
  /** 下一次抽签的绝对时刻；NaN = 尚未排期（未激活/刚解除强制） */
  let nextSwitchAt = Number.NaN;
  /** 当前非默认条目的自动回正时刻；NaN = 不设/已回正 */
  let releaseAt = Number.NaN;
  let activeSince = 0;
  let switches = 0;
  let releases = 0;
  let forced: K | null = null;
  /** `setInterval()` 改了参数，需要下一拍重新排期 */
  let intervalDirty = false;
  let last: MicroPoolSnapshot<K> | null = null;

  function randomIntervalMs(): number {
    const unit = sampleUnit(random);
    return Math.round(minIntervalMs + unit * (maxIntervalMs - minIntervalMs));
  }

  /** 新条目进场时的自动回正时刻（默认条目 / 未设 hold → NaN） */
  function releaseFor(kind: K, now: number): number {
    const entry = byKind.get(kind);
    if (!entry || kind === defaultKind || entry.holdMinMs === null || entry.holdMaxMs === null) {
      return Number.NaN;
    }
    if (entry.holdMaxMs <= entry.holdMinMs) return now + Math.round(entry.holdMinMs);
    return now + Math.round(entry.holdMinMs + sampleUnit(random) * (entry.holdMaxMs - entry.holdMinMs));
  }

  /** 回到默认条目（到时 / 上下文失效 / 解除强制）。权重会在下一拍开始衰减。 */
  function releaseToDefault(now: number): void {
    active = defaultKind;
    activeSince = now;
    releaseAt = Number.NaN;
    releases += 1;
  }

  /** 按权重从"除当前条目以外"的条目里抽一个。只有一个条目时返回它自己。 */
  function pickNext(): K {
    const candidates = entries.filter((entry) => entry.kind !== active);
    if (candidates.length === 0) return active;
    const total = candidates.reduce((sum, entry) => sum + entry.weight, 0);
    let roll = sampleUnit(random) * total;
    for (const candidate of candidates) {
      roll -= candidate.weight;
      if (roll <= 0) return candidate.kind;
    }
    return candidates[candidates.length - 1]!.kind;
  }

  function snapshot(nowMs: number): MicroPoolSnapshot<K> {
    const copy = {} as Record<K, number>;
    for (const kind of kinds) copy[kind] = Number((weights[kind] ?? 0).toFixed(4));
    return {
      active,
      weights: copy,
      nextSwitchInMs:
        forced !== null || !Number.isFinite(nextSwitchAt)
          ? -1
          : Math.max(0, Math.round(nextSwitchAt - nowMs)),
      switches,
      releases,
      activeForMs: Math.max(0, Math.round(nowMs - activeSince)),
      holdRemainingMs:
        forced !== null || active === defaultKind || !Number.isFinite(releaseAt)
          ? -1
          : Math.max(0, Math.round(releaseAt - nowMs)),
      forced,
    };
  }

  return {
    update(nowMs: number, dtSeconds: number, activeNow: boolean): MicroPoolSnapshot<K> {
      const now = Number.isFinite(nowMs) ? nowMs : 0;
      const dt = Number.isFinite(dtSeconds) ? Math.min(MAX_DT_SECONDS, Math.max(0, dtSeconds)) : 0;

      // 0) 强制条目：第一次落地时把"持续时长"的起点记在这一拍；强制期间不自动回正
      if (forced !== null && forced !== active) {
        active = forced;
        activeSince = Number.NaN;
        releaseAt = Number.NaN;
      }
      if (!Number.isFinite(activeSince)) activeSince = now;

      /**
       * 1) 生命周期：非默认条目到时 → 回到默认条目。
       *    先于抽签判断，避免"正好同一拍到期"时先抽新条目再回正。
       */
      if (activeNow && forced === null && active !== defaultKind) {
        if (Number.isFinite(releaseAt) && now >= releaseAt) {
          releaseToDefault(now);
        }
      }

      // 2) 排期：只在"激活"时计时；从非激活回到激活时重新计时（不在回来的一瞬间就切）
      if (activeNow) {
        if (forced === null && (intervalDirty || !Number.isFinite(nextSwitchAt))) {
          nextSwitchAt = now + randomIntervalMs();
          intervalDirty = false;
        }
        if (forced === null && Number.isFinite(nextSwitchAt) && now >= nextSwitchAt) {
          active = pickNext();
          activeSince = now;
          switches += 1;
          releaseAt = releaseFor(active, now);
          nextSwitchAt = now + randomIntervalMs();
        }
      } else {
        // 上下文失效：杀掉"还在歪着/还在看远处"的残留，回到默认姿态再淡出
        if (active !== defaultKind) releaseToDefault(now);
        // 暂停期间不推进抽签；回到激活后从现在重新算 15–30s
        if (!intervalDirty) nextSwitchAt = Number.NaN;
      }

      // 3) 权重过渡：目标 = 激活且是当前条目 → 1，否则 0
      const alpha = dt > 0 ? 1 - Math.exp(-transitionRate * dt) : 0;
      for (const kind of kinds) {
        const target = activeNow && kind === active ? 1 : 0;
        const current = weights[kind] ?? 0;
        weights[kind] = current + (target - current) * alpha;
      }

      last = snapshot(now);
      return last;
    },

    snapshot(): MicroPoolSnapshot<K> | null {
      return last;
    },

    reset(nowMs: number): void {
      active = defaultKind;
      activeSince = Number.isFinite(nowMs) ? nowMs : 0;
      for (const kind of kinds) weights[kind] = 0;
      nextSwitchAt = Number.NaN;
      releaseAt = Number.NaN;
      switches = 0;
      releases = 0;
      forced = null;
      intervalDirty = false;
      last = null;
    },

    setInterval(min: number, max: number): void {
      const nextMin = clampInterval(min, minIntervalMs);
      const nextMax = clampInterval(max, maxIntervalMs);
      minIntervalMs = Math.min(nextMin, nextMax);
      maxIntervalMs = Math.max(nextMin, nextMax);
      intervalDirty = true;
    },

    force(kind: K | string | null): K | null {
      if (kind === null) {
        forced = null;
        // 解除强制 = 回到默认条目（避免"强制过 headTilt 之后又一直歪着"）
        if (active !== defaultKind) releaseToDefault(Number.NaN);
        nextSwitchAt = Number.NaN;
        intervalDirty = false;
        return null;
      }
      if (!kinds.includes(kind as K)) return null;
      forced = kind as K;
      if (active !== forced) {
        active = forced;
        activeSince = Number.NaN;
        releaseAt = Number.NaN;
        nextSwitchAt = Number.NaN;
      }
      return forced;
    },
  };
}
