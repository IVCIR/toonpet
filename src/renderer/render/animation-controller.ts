/**
 * 模型自带动画的选择与交叉淡入（ADR 0014 D3/D8，ADR 0023 扩展）。
 *
 * 44 段动画全部建 action，分两类驱动：
 *
 * 1. **常驻槽位（循环）** —— `play(slot)`：
 *    - `idle`  → `CH0335_Cafe_Idle`（Base 层待机）
 *    - `held`  → `CH0335_Carrier_Idle`（Physics 层"被拎起"的悬空姿态）
 *    - `walk`  → `CH0335_Cafe_Walk`（本轮只识别、不启用）
 *    另外 `playRole('idle.alt1' | 'idle.alt2', …)` 可以换待机姿态（同一 Base 状态）。
 *
 * 2. **一次性演出** —— `playOnce(role)`：`LoopOnce` + `clampWhenFinished`，
 *    播完由 `finished` 事件淡回 `returnTo` 槽位。用于摸头反应、打招呼、开心、被拎起。
 *
 * 选择规则是"精确名 → 模式降级 → 缺失"，降级原因写进诊断与日志；
 * 语义表在 `clip-bank.ts`，换模型只改那张表，不改这里。
 *
 * 切换只用 `crossFadeFrom(prev, seconds, false)`：不做整身叠加（H-2），
 * 也不在事件回调里 `update`（同一帧只允许在渲染循环第 1 步更新一次）。
 */
import * as THREE from 'three';
import { CLIP_RULES, selectRole, trimClip } from './clip-bank';
import type { ClipRole, RoleSelection } from './clip-bank';

export type AnimationSlot = 'idle' | 'held' | 'walk';

export interface ClipSelection {
  slot: AnimationSlot;
  name: string | null;
  reason: 'exact' | 'pattern' | 'missing';
  /** 命中的模式（reason === 'pattern' 时非空） */
  pattern: string | null;
  /** 首选精确名（日志用） */
  preferred: string;
}

export interface AnimationStatus {
  name: string | null;
  slot: AnimationSlot | null;
  time: number;
  weight: number;
  running: boolean;
}

export interface ActionStatus {
  name: string;
  weight: number;
  time: number;
  running: boolean;
}

/** 一次性演出的进行态（诊断用） */
export interface OneShotStatus {
  role: ClipRole;
  name: string;
  time: number;
  duration: number;
}

export interface OneShotOptions {
  /** 淡入秒数（默认 0.18） */
  fadeIn?: number;
  /** 播完淡回常驻槽位的秒数（默认 0.25） */
  fadeOut?: number;
  /** 播完回到哪个槽位（默认 idle） */
  returnTo?: AnimationSlot;
}

export interface ModelAnimations {
  readonly clipNames: string[];
  readonly selection: Record<AnimationSlot, ClipSelection>;
  /** 语义角色的命中结果（含缺失原因，诊断用） */
  readonly roles: Record<ClipRole, RoleSelection>;
  /** 切到某常驻槽位；片段缺失时返回 false（调用方保持现状，不抛异常） */
  play(slot: AnimationSlot, fadeSeconds: number): boolean;
  /**
   * 播某语义角色的循环片段，并把它当作指定槽位（默认 idle）。
   * 用于换待机姿态（`idle.alt1` / `idle.alt2`）。
   */
  playRole(role: ClipRole, fadeSeconds: number, slot?: AnimationSlot): boolean;
  /** 播一次性演出；片段缺失返回 false，调用方自行降级 */
  playOnce(role: ClipRole, options?: OneShotOptions): boolean;
  /** 打断正在播的一次性演出（淡出），不改变常驻槽位 */
  cancelOneShot(fadeSeconds: number): void;
  oneShot(): OneShotStatus | null;
  update(dtSeconds: number): void;
  current(): AnimationStatus;
  /** 权重 > 0 的 action（诊断用） */
  actions(): ActionStatus[];
  dispose(): void;
}

/** 槽位 → 语义角色：槽位只是角色的别名，片段表只在 clip-bank 里维护一份。 */
const SLOT_TO_ROLE: Record<AnimationSlot, ClipRole> = {
  idle: 'idle',
  held: 'held',
  walk: 'walk',
};

function selectClip(
  roleSelections: Record<ClipRole, RoleSelection>,
  slot: AnimationSlot,
): ClipSelection {
  const role = roleSelections[SLOT_TO_ROLE[slot]];
  return {
    slot,
    name: role.name,
    reason: role.reason,
    pattern: role.pattern,
    preferred: role.preferred,
  };
}

/** dt 上限：切后台/断点回来时不要一次跳过整段动画。 */
const MAX_UPDATE_SECONDS = 0.1;

/** 一次性演出的默认淡入/淡出（秒）。 */
const ONE_SHOT_FADE_IN = 0.18;
const ONE_SHOT_FADE_OUT = 0.25;

export function createModelAnimations(
  root: THREE.Object3D,
  clips: readonly THREE.AnimationClip[],
): ModelAnimations {
  const mixer = new THREE.AnimationMixer(root);
  const all = [...clips];
  const byName = new Map<string, THREE.AnimationAction>();

  for (const clip of all) {
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    action.enabled = false;
    byName.set(clip.name, action);
  }

  // 语义角色 → action（长演出按 startSeconds/maxSeconds 裁窗口，裁出来的片段只给 role 用）
  const roleSelections = {} as Record<ClipRole, RoleSelection>;
  const roleActions = new Map<ClipRole, THREE.AnimationAction>();
  for (const role of Object.keys(CLIP_RULES) as ClipRole[]) {
    const selection = selectRole(all, role);
    roleSelections[role] = selection;
    if (!selection.name) continue;
    const base = all.find((clip) => clip.name === selection.name);
    if (!base) continue;
    const rule = CLIP_RULES[role];
    const clip =
      selection.loop || (!rule.maxSeconds && !rule.startSeconds)
        ? base
        : trimClip(base, rule.startSeconds ?? 0, rule.maxSeconds);
    roleActions.set(role, mixer.clipAction(clip));
  }

  const selection: Record<AnimationSlot, ClipSelection> = {
    idle: selectClip(roleSelections, 'idle'),
    held: selectClip(roleSelections, 'held'),
    walk: selectClip(roleSelections, 'walk'),
  };

  let currentAction: THREE.AnimationAction | null = null;
  let currentSlot: AnimationSlot | null = null;
  let oneShotAction: THREE.AnimationAction | null = null;
  let oneShotRole: ClipRole | null = null;
  let oneShotReturn: AnimationSlot = 'idle';

  function fadeTo(action: THREE.AnimationAction, fadeSeconds: number): void {
    const previous = currentAction;
    if (previous === action) {
      currentAction = action;
      return;
    }
    action.reset();
    action.enabled = true;
    action.setEffectiveTimeScale(1);
    action.setEffectiveWeight(1);
    action.play();
    if (previous) {
      action.crossFadeFrom(previous, Math.max(0, fadeSeconds), false);
    }
    currentAction = action;
  }

  function clearOneShot(fadeSeconds: number): void {
    if (!oneShotAction) return;
    // 只淡出、不立刻 stop：让交叉淡入有过渡，`finished` 事件由 action 身份比对忽略
    oneShotAction.fadeOut(Math.max(0, fadeSeconds));
    oneShotAction = null;
    oneShotRole = null;
  }

  function playSlot(slot: AnimationSlot, fadeSeconds: number): boolean {
    const picked = selection[slot];
    if (!picked.name) return false;
    const next = byName.get(picked.name);
    if (!next) return false;
    if (next === currentAction && oneShotAction === null) return true;
    clearOneShot(fadeSeconds);
    next.setLoop(THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = false;
    fadeTo(next, fadeSeconds);
    currentSlot = slot;
    return true;
  }

  mixer.addEventListener('finished', (event) => {
    const finished = (event as unknown as { action?: THREE.AnimationAction }).action;
    if (!oneShotAction || finished !== oneShotAction) return;
    const back = oneShotReturn;
    oneShotAction = null;
    oneShotRole = null;
    playSlot(back, ONE_SHOT_FADE_OUT);
  });

  return {
    clipNames: all.map((clip) => clip.name),
    selection,
    roles: roleSelections,

    play(slot: AnimationSlot, fadeSeconds: number): boolean {
      return playSlot(slot, fadeSeconds);
    },

    playRole(role: ClipRole, fadeSeconds: number, slot: AnimationSlot = 'idle'): boolean {
      const next = roleActions.get(role);
      if (!next || !roleSelections[role].name) return false;
      if (next === currentAction && oneShotAction === null) {
        currentSlot = slot;
        return true;
      }
      clearOneShot(fadeSeconds);
      next.setLoop(THREE.LoopRepeat, Infinity);
      next.clampWhenFinished = false;
      fadeTo(next, fadeSeconds);
      currentSlot = slot;
      return true;
    },

    playOnce(role: ClipRole, options: OneShotOptions = {}): boolean {
      const next = roleActions.get(role);
      if (!next || !roleSelections[role].name) return false;
      const fadeIn = options.fadeIn ?? ONE_SHOT_FADE_IN;
      const returnTo = options.returnTo ?? 'idle';

      if (oneShotAction && oneShotAction !== next) clearOneShot(fadeIn);
      oneShotAction = next;
      oneShotRole = role;
      oneShotReturn = returnTo;

      next.setLoop(THREE.LoopOnce, 1);
      next.clampWhenFinished = true;
      next.reset();
      next.enabled = true;
      next.setEffectiveTimeScale(1);
      next.setEffectiveWeight(1);
      next.play();
      if (currentAction && currentAction !== next) {
        next.crossFadeFrom(currentAction, Math.max(0, fadeIn), false);
      }
      currentAction = next;
      currentSlot = null;
      return true;
    },

    cancelOneShot(fadeSeconds: number): void {
      clearOneShot(fadeSeconds);
    },

    oneShot(): OneShotStatus | null {
      if (!oneShotAction || !oneShotRole) return null;
      const clip = oneShotAction.getClip();
      return {
        role: oneShotRole,
        name: clip.name,
        time: oneShotAction.time,
        duration: clip.duration,
      };
    },

    update(dtSeconds: number): void {
      if (!Number.isFinite(dtSeconds)) return;
      const dt = Math.min(MAX_UPDATE_SECONDS, Math.max(0, dtSeconds));
      if (dt === 0) {
        // 仍需让首次 play 的动作权重生效（crossFade/权重在 update 内结算）
        mixer.update(0);
        return;
      }
      mixer.update(dt);
    },

    current(): AnimationStatus {
      if (!currentAction) {
        return { name: null, slot: null, time: 0, weight: 0, running: false };
      }
      return {
        name: currentAction.getClip().name,
        slot: currentSlot,
        time: currentAction.time,
        weight: currentAction.getEffectiveWeight(),
        running: currentAction.isRunning(),
      };
    },

    actions(): ActionStatus[] {
      const out: ActionStatus[] = [];
      for (const [name, action] of byName) {
        // 只报"正在跑"的 action：未播放的 action 也有默认权重 1，不能据此判断混合状态
        if (!action.isRunning()) continue;
        out.push({ name, weight: action.getEffectiveWeight(), time: action.time, running: true });
      }
      return out;
    },

    dispose(): void {
      mixer.stopAllAction();
      mixer.uncacheRoot(root);
    },
  };
}
