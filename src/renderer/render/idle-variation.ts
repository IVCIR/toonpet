/**
 * 待机**静态站姿轮换**（ADR 0050）。
 *
 * 这一层解决的是"她一个人站着时像不像活人"：
 *
 * - 旧实现（ADR 0041 D4 / 0045 D1）每隔 45–95s 播一次 `Cafe_Reaction` 3.2–4.9s 的掩面缩身。
 *   真机反馈很明确：**动静太大、极其突兀**；而且该片段在交叉淡入时会出现
 *   "手绕着手腕突然垂下"的骨骼扭曲。ADR 0050 把这次演出**整体删除**。
 * - 现在空闲只做一件事：在 44 段动画里筛出的**正面、静态、无位移**待机片段之间，
 *   每 20–45s 做一次 0.8s 的交叉淡入。换的是"她现在用哪个姿势站着"，
 *   不是新状态、不是一次性演出：`getState().base` 恒为 `idle`。
 *
 * 为什么单独一个文件：这是**纯逻辑**（不引用 three、不读时钟），
 * 与 `micro-pool.ts` 同一手法，可脱离 WebGL 单测；渲染侧只负责把选中的角色
 * 交给 `animation-controller.playRole()`。
 */
import {
  IDLE_VARIATION_FADE_SECONDS,
  IDLE_VARIATION_MAX_MS,
  IDLE_VARIATION_MIN_MS,
} from '../../shared/constants';
import type { ClipRole } from './clip-bank';

/**
 * 一个候选站姿：语义角色 + 官方片段名 + 入选理由。
 *
 * 筛选口径（对 44 段逐段看过胶片条 + `census.json` 的骨骼事实，ADR 0050）：
 * 1. **正面**：根骨朝向面向镜头（排除 `Normal_*` / `Exs*` / `Vital_*` / `Public01` / `Move_*` 等侧身战斗片段）；
 * 2. **静态站立**：有双脚着地、没有位移/跳跃/倒地，骨骼活动的量级在"呼吸/头发"级别
 *    （`census.json` 的 `shrinkRatio ≤ 0.005`、`pitchRange ≤ 0.02`）；
 * 3. **循环待机**：片段本身是 4s 的待机循环，不是一次性演出或过场
 *    （排除 `Cafe_Reaction` / `Victory_Start*` / `Formation_Pickup` / `*_interaction_*`）。
 *
 * 不选 `CH0335_Normal_Idle`：它是战斗侧身待机（ADR 0014 D3.1 已实测），
 * 切过去会"整身侧对镜头"。不选 `Cafe_Walk` / `Carrier2_Walk` / `Move_Ing`：那是走路循环。
 */
export interface IdleVariationCandidate {
  role: ClipRole;
  clip: string;
  /** 观感说明（日志/文档用；不参与运行期决策） */
  note: string;
}

export const IDLE_VARIATION_CANDIDATES: readonly IdleVariationCandidate[] = [
  {
    role: 'idle',
    clip: 'CH0335_Cafe_Idle',
    note: '正面大厅待机，双臂自然下垂（基线）',
  },
  {
    role: 'idle.alt1',
    clip: 'CH0335_Formation_Idle',
    note: '正面抱臂站姿（队形待机）',
  },
  {
    role: 'idle.alt2',
    clip: 'CH0335_Carrier_Idle',
    note: '正面静止站姿，双手自然下垂、几乎不动',
  },
  {
    role: 'idle.alt3',
    clip: 'CH0335_Victory_End_Random',
    note: '正面双手轻握在胸前，呼吸幅度极小',
  },
  {
    role: 'idle.alt4',
    clip: 'CH0335_Carrier2_Idle',
    note: '正面双手交叠在身前，比 Carrier_Idle 多一个手部姿势',
  },
  {
    role: 'idle.alt5',
    clip: 'CH0335_Victory_End',
    note: '正面收势站姿，手臂自然垂下',
  },
  {
    role: 'idle.alt6',
    clip: 'CH0335_Formation_Idle_Random',
    note: '正面抱臂站姿的随机变体（与 alt1 不同的头部/呼吸相位）',
  },
];

export const IDLE_VARIATION_ROLES: readonly ClipRole[] = IDLE_VARIATION_CANDIDATES.map(
  (candidate) => candidate.role,
);

export interface IdleVariationSnapshot {
  /** 当前站姿角色 */
  role: ClipRole;
  /** 当前角色对应的官方片段名（缺失为 null） */
  clip: string | null;
  /** 距离下一次换姿势还有多久（ms）；无排期时为 null */
  nextInMs: number | null;
  /** 本次运行换过多少次（强制切换不计入） */
  switches: number;
  /** 自检强制的角色（null = 正常随机） */
  forced: ClipRole | null;
  minIntervalMs: number;
  maxIntervalMs: number;
  fadeSeconds: number;
  /** 候选池（自检/文档可读） */
  candidates: { role: ClipRole; clip: string }[];
}

export interface IdleVariationScheduler {
  /** 以 `now` 为基准重新排期，并把当前角色重置为 `idle`。 */
  reset(now: number): void;
  /** 自检压缩时序：覆盖间隔（生产路径不调用，默认 20–45s）。 */
  setIdleInterval(minIntervalMs: number, maxIntervalMs: number, now?: number): void;
  /** 实际播出的动作不是池里的角色时（例如从 walking 淡回 `idle` 槽位）同步当前角色。 */
  noteCurrent(role: ClipRole): void;
  /**
   * 自检取证：强制下一个 tick 切到某个角色（`null` = 解除强制）。
   * 非法角色（不在候选池里）被忽略。
   */
  force(role: ClipRole | null, now: number): ClipRole | null;
  /**
   * 每帧推进。`active=false`（拖拽/坐姿/行走/说话/一次性演出）时**不换姿势**：
   * 若已到期则从恢复的那一刻重新计时——避免"忙完立刻换姿势"的突兀。
   *
   * 返回要切的角色；`null` = 本帧不切。调用方负责 `playRole()`。
   */
  tick(now: number, active: boolean, available: (role: ClipRole) => boolean): ClipRole | null;
  snapshot(now: number, available?: (role: ClipRole) => boolean): IdleVariationSnapshot;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 20–45s 的随机间隔；随机源被夹到 [0,1]，非法值按 0 处理。 */
export function nextIdleVariationDelayMs(random: () => number = Math.random): number {
  const r = clamp01(random());
  return Math.round(IDLE_VARIATION_MIN_MS + r * (IDLE_VARIATION_MAX_MS - IDLE_VARIATION_MIN_MS));
}

/**
 * 从候选里抽一个**不是当前角色**、且片段可用的角色。
 *
 * 排除当前角色是硬约束：抽到自己等于"这次切换什么都没发生"，还会把片段 time 重置回 0
 * （肉眼是"她忽然打了个同样的姿势"）。
 */
export function pickIdleVariationRole(
  current: ClipRole,
  available: (role: ClipRole) => boolean,
  random: () => number = Math.random,
): ClipRole | null {
  const candidates = IDLE_VARIATION_ROLES.filter((role) => role !== current && available(role));
  if (candidates.length === 0) return null;
  const index = Math.min(candidates.length - 1, Math.floor(clamp01(random()) * candidates.length));
  return candidates[index] ?? null;
}

export function createIdleVariation(options: {
  minIntervalMs?: number;
  maxIntervalMs?: number;
  random?: () => number;
} = {}): IdleVariationScheduler {
  const random = options.random ?? Math.random;
  let minMs = Math.max(0, options.minIntervalMs ?? IDLE_VARIATION_MIN_MS);
  let maxMs = Math.max(minMs, options.maxIntervalMs ?? IDLE_VARIATION_MAX_MS);
  let current: ClipRole = 'idle';
  let nextAt = Number.POSITIVE_INFINITY;
  let switches = 0;
  let forced: ClipRole | null = null;
  let pending: ClipRole | null = null;

  const delay = (): number => {
    const r = clamp01(random());
    return Math.round(minMs + r * (maxMs - minMs));
  };

  const validInterval = (value: number): number =>
    Number.isFinite(value) ? Math.max(0, value) : 0;

  const snapshot = (now: number, available?: (role: ClipRole) => boolean): IdleVariationSnapshot => {
    const at = Number.isFinite(nextAt) ? Math.max(0, nextAt - now) : null;
    const clipOf = (role: ClipRole): string | null =>
      IDLE_VARIATION_CANDIDATES.find((candidate) => candidate.role === role)?.clip ?? null;
    return {
      role: current,
      clip: clipOf(current),
      nextInMs: at === null ? null : Math.round(at),
      switches,
      forced,
      minIntervalMs: Math.round(minMs),
      maxIntervalMs: Math.round(maxMs),
      fadeSeconds: IDLE_VARIATION_FADE_SECONDS,
      candidates:
        available === undefined
          ? IDLE_VARIATION_CANDIDATES.map(({ role, clip }) => ({ role, clip }))
          : IDLE_VARIATION_CANDIDATES.filter((candidate) => available(candidate.role)).map(
              ({ role, clip }) => ({ role, clip }),
            ),
    };
  };

  return {
    reset(now: number): void {
      current = 'idle';
      switches = 0;
      forced = null;
      pending = null;
      const base = Number.isFinite(now) ? now : 0;
      nextAt = base + delay();
    },

    setIdleInterval(nextMin: number, nextMax: number, now?: number): void {
      minMs = validInterval(nextMin);
      maxMs = Math.max(minMs, validInterval(nextMax));
      // 间隔变化后从"现在"重新算，避免旧排期落到新窗口之外。
      // `now` 由调用方给（纯逻辑不读时钟）；自检不传时就沿用下个 tick 的 now。
      if (typeof now === 'number' && Number.isFinite(now)) nextAt = now + delay();
    },

    noteCurrent(role: ClipRole): void {
      if (IDLE_VARIATION_ROLES.includes(role)) current = role;
    },

    force(role: ClipRole | null, now: number): ClipRole | null {
      if (role !== null && !IDLE_VARIATION_ROLES.includes(role)) return null;
      forced = role;
      if (role !== null) {
        current = role;
        pending = role;
      } else {
        pending = null;
        const base = Number.isFinite(now) ? now : performance.now();
        nextAt = base + delay();
      }
      return role;
    },

    tick(now: number, active: boolean, available: (role: ClipRole) => boolean): ClipRole | null {
      if (pending !== null) {
        const role = pending;
        pending = null;
        // 强制切换不算一次随机抽签；排期仍按生产节奏继续
        if (!Number.isFinite(nextAt)) nextAt = now + delay();
        return role;
      }
      if (!active) {
        // 忙的时候到期不切：从恢复的那一刻重新计时（不是"一回来就换"）
        if (Number.isFinite(nextAt) && now >= nextAt) nextAt = now + delay();
        return null;
      }
      if (!Number.isFinite(nextAt)) {
        nextAt = now + delay();
        return null;
      }
      if (now < nextAt) return null;
      const role = pickIdleVariationRole(current, available, random);
      nextAt = now + delay();
      if (role === null) return null;
      current = role;
      switches += 1;
      return role;
    },

    snapshot,
  };
}
