/**
 * render 的 HFSM 三层壳（契约 §5.1；ADR 0014 D3、ADR 0024 D1/D3、ADR 0028 D5）。
 *
 * - Base：`idle` / `walking`。`idle` 持续 20–40s 后由内部调度器随机触发一次行走
 *   （§4.1 的进入条件），行走结束或被拖拽打断即回 `idle`。
 * - Overlay：`speaking`（事件驱动）+ `reacting`（一次性，超时自愈）。
 * - Physics：`dragged`（指针拖拽）/ `settling`（松手回弹）/ `sitting`（吸附在别的窗口边缘）。
 *   `settling` 期间不接受新的动作意图与摸头（用户要求"回弹期间不被事件打断"，
 *   唯一例外是重新拖拽——那是 `drag_started` 事件，优先级更高）。
 *   `sitting` 期间不做行走调度（她坐在那里，不会乱跑），只接受拖拽打断。
 *
 * 纯逻辑：不引用 three、不碰 DOM、不读时钟（时间由调用方传入），可脱离 WebGL 单测。
 * 随机数也注入，测试才能断言"到点必走"。
 */
import type { BaseState, Intent, OverlayState, PhysicsState } from '../../shared/types';

/** §4.1 明确"收到 intent 时进入 reacting"的 intent 子集（全集之外一律不动 Overlay）。 */
export const REACTING_INTENTS = [
  'pat_react',
  'happy_hop',
  'nod',
  'shake_head',
  'tilt_head',
] as const satisfies readonly Intent[];

const REACTING_INTENT_SET: ReadonlySet<string> = new Set(REACTING_INTENTS);

export function isReactingIntent(intent: string): intent is (typeof REACTING_INTENTS)[number] {
  return REACTING_INTENT_SET.has(intent);
}

export type ReactionKind = 'head_patted' | 'intent';

export interface HfsmReaction {
  kind: ReactionKind;
  /** `kind === 'intent'` 时是对应的 intent；`head_patted` 为 null */
  intent: Intent | null;
  startedAt: number;
  durationMs: number;
}

/** 一次行走计划：方向 + 期望距离（px）。实际距离由 shell 按工作区边界钳制。 */
export interface WalkPlan {
  direction: 'left' | 'right';
  distancePx: number;
}

export interface WalkScheduleOptions {
  minIntervalMs: number;
  maxIntervalMs: number;
  minDistancePx: number;
  maxDistancePx: number;
}

export interface HfsmSnapshot {
  base: BaseState;
  overlay: OverlayState | null;
  physics: PhysicsState | null;
  speakingUtteranceId: string | null;
  reaction: HfsmReaction | null;
}

export interface HfsmTickResult {
  /** 非空表示本 tick 触发了行走，调用方应发 `cmd:walk` 并播行走动画 */
  startWalk: WalkPlan | null;
}

export interface HfsmOptions {
  /** `head_patted` 的一次性反应时长（与 pat-react 同源） */
  patDurationMs: number;
  /** 行走调度参数（缺省取 §4.1 的 20–40s / 100–300px） */
  walk?: Partial<WalkScheduleOptions>;
  /** 注入随机源（测试用）；缺省 Math.random */
  random?: () => number;
}

const DEFAULT_WALK: WalkScheduleOptions = {
  minIntervalMs: 20_000,
  maxIntervalMs: 40_000,
  minDistancePx: 100,
  maxDistancePx: 300,
};

export interface Hfsm {
  /** `voice` 的事件（render 只跟随） */
  speechStarted(now: number, utteranceId: string): void;
  speechEnded(now: number): void;
  /**
   * `head_patted` 事件 → reacting。
   * `durationMs` 缺省时用 `patDurationMs`；接官方摸头片段时传片段时长，
   * 让 reacting 的生命周期与动画对齐（ADR 0023 D4）。
   */
  headPatted(now: number, durationMs?: number): void;
  /** `handleIntent` 命令；只有 §4.1 列出的 intent 会进入 reacting */
  intent(now: number, intent: Intent, durationMs: number): boolean;
  dragStarted(now: number): void;
  dragReleased(now: number): void;
  /**
   * `snap_applied` 事实 → Physics=`sitting`（ADR 0028 D5）。
   * 进入即打断 `walking` 并清空排期：坐着的时候不该再迈步。
   */
  snapApplied(now: number): void;
  /**
   * `snap_released` 事实 → 退出 `sitting`（只在仍处于 `sitting` 时生效）。
   * `drag_started` 会先把状态改成 `dragged`，此时本调用是空操作。
   */
  snapReleased(now: number): void;
  /** `motion_ended{kind:'walk'}`：行走结束（到达 / 撞边 / 被打断） */
  walkEnded(now: number): void;
  /** `motion_ended{kind:'settle'}`：回弹结束，Physics 整层退出 */
  settleEnded(now: number): void;
  /** 每帧调用：一次性反应到时自愈、到点触发行走 */
  tick(now: number): HfsmTickResult;
  /**
   * 内部（非契约）：改行走调度参数。自检用它把 20–40s 压到 1.5–2s，
   * 否则一次自检等不到调度；生产路径不调用。
   */
  setWalkSchedule(next: Partial<WalkScheduleOptions>, now: number): void;
  snapshot(): HfsmSnapshot;
  readonly reacting: boolean;
  /** 诊断：下一次行走的计划时刻（null = 尚未排期） */
  readonly nextWalkAt: number | null;
}

export function createHfsm(options: HfsmOptions): Hfsm {
  let walk: WalkScheduleOptions = { ...DEFAULT_WALK, ...options.walk };
  const random = options.random ?? Math.random;

  let speakingUtteranceId: string | null = null;
  let reaction: HfsmReaction | null = null;
  let physics: PhysicsState | null = null;
  let base: BaseState = 'idle';
  let nextWalkAt: number | null = null;

  function scheduleNextWalk(now: number): void {
    const span = Math.max(0, walk.maxIntervalMs - walk.minIntervalMs);
    nextWalkAt = now + walk.minIntervalMs + random() * span;
  }

  function startReaction(now: number, kind: ReactionKind, intent: Intent | null, durationMs: number): void {
    // 同类型新反应替换旧反应（§4.1："动作自然播完 / 被同类型新反应替换"）
    reaction = {
      kind,
      intent,
      startedAt: now,
      durationMs: Math.max(1, durationMs),
    };
  }

  return {
    speechStarted(_now: number, utteranceId: string): void {
      speakingUtteranceId = utteranceId;
    },

    speechEnded(_now: number): void {
      speakingUtteranceId = null;
    },

    headPatted(now: number, durationMs?: number): void {
      // 回弹期间不接受新事件（用户要求）；重新拖拽会先走 dragStarted
      if (physics === 'settling') return;
      startReaction(
        now,
        'head_patted',
        null,
        durationMs && durationMs > 0 ? durationMs : options.patDurationMs,
      );
    },

    intent(now: number, intent: Intent, durationMs: number): boolean {
      if (!isReactingIntent(intent)) return false;
      // 回弹期间不接受新的动作意图（同上）
      if (physics === 'settling') return false;
      startReaction(now, 'intent', intent, durationMs);
      return true;
    },

    dragStarted(_now: number): void {
      // H-4：只有事件可以进 dragged
      physics = 'dragged';
      // §4.1：`walking` 的退出条件之一就是被拖拽打断
      if (base === 'walking') base = 'idle';
      nextWalkAt = null;
    },

    dragReleased(_now: number): void {
      // D-6：松手先进入回弹（settling），回弹结束才整层退出（§5.1）
      physics = 'settling';
    },

    snapApplied(_now: number): void {
      physics = 'sitting';
      // §4.1：`walking` 的退出条件之一就是被更高的 Physics 层接管
      if (base === 'walking') base = 'idle';
      nextWalkAt = null;
    },

    snapReleased(now: number): void {
      if (physics !== 'sitting') return;
      physics = null;
      base = 'idle';
      scheduleNextWalk(now);
    },

    walkEnded(now: number): void {
      if (base !== 'walking') return;
      base = 'idle';
      scheduleNextWalk(now);
    },

    settleEnded(now: number): void {
      if (physics !== 'settling') return;
      physics = null;
      base = 'idle';
      scheduleNextWalk(now);
    },

    setWalkSchedule(next: Partial<WalkScheduleOptions>, now: number): void {
      walk = { ...walk, ...next };
      if (base === 'idle' && physics === null) scheduleNextWalk(now);
    },

    tick(now: number): HfsmTickResult {
      if (reaction && now - reaction.startedAt >= reaction.durationMs) {
        reaction = null;
      }
      // Base 层的行走调度：只在 idle 且没有 Physics 接管时触发
      if (base === 'idle' && physics === null) {
        if (nextWalkAt === null) {
          scheduleNextWalk(now);
        } else if (now >= nextWalkAt) {
          const span = Math.max(0, walk.maxDistancePx - walk.minDistancePx);
          const plan: WalkPlan = {
            direction: random() < 0.5 ? 'left' : 'right',
            distancePx: Math.round(walk.minDistancePx + random() * span),
          };
          base = 'walking';
          nextWalkAt = null;
          return { startWalk: plan };
        }
      }

      return { startWalk: null };
    },

    snapshot(): HfsmSnapshot {
      const overlay: OverlayState | null = speakingUtteranceId
        ? 'speaking'
        : reaction
          ? 'reacting'
          : null;
      return {
        base,
        overlay,
        physics,
        speakingUtteranceId,
        reaction,
      };
    },

    get reacting(): boolean {
      return reaction !== null;
    },

    get nextWalkAt(): number | null {
      return nextWalkAt;
    },
  };
}
