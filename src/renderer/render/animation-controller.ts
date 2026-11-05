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
  /** `getEffectiveWeight()`：交叉淡入结束后应为 1（ADR 0039 排查用） */
  weight: number;
  paused: boolean;
  enabled: boolean;
}

/**
 * "停住的姿态"的进行态（诊断用，ADR 0028 D8）。
 * 与 `OneShotStatus` 的区别：播完**不回**常驻槽位，停在最后一帧等调用方解除。
 */
export interface HoldStatus extends OneShotStatus {
  /** 已经播到最后一帧（clampWhenFinished 生效） */
  done: boolean;
}

export interface OneShotOptions {
  /** 淡入秒数（缺省取 `clip-bank` 的 `fadeInSeconds`，再缺省 0.18） */
  fadeIn?: number;
  /** 播完淡出的秒数（缺省取 `clip-bank` 的 `fadeOutSeconds`，再缺省 0.25） */
  fadeOut?: number;
  /** 没有"上一个动作"可回时，回到哪个槽位（默认 idle） */
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
   * 播某语义角色的**循环**片段，并把它当作指定槽位（默认 idle）。
   * 用于换待机姿态（`idle.alt1` / `idle.alt2`）。坐姿不再用它——ADR 0044 起走 `playHold`。
   */
  playRole(role: ClipRole, fadeSeconds: number, slot?: AnimationSlot): boolean;
  /** 播一次性演出；片段缺失返回 false，调用方自行降级 */
  playOnce(role: ClipRole, options?: OneShotOptions): boolean;
  /**
   * 播一个"停住的姿态"（ADR 0028 D8）：`LoopOnce` + `clampWhenFinished`，
   * 播完停在最后一帧**不回**常驻槽位，直到 `clearHold` 或下一次 `play*`。
   * 用于 `sitting`：她坐在那里，姿势不能自己变回站姿。
   */
  playHold(role: ClipRole, fadeSeconds: number): boolean;
  /**
   * 把**当前停住姿态**定位到片段的第 N 秒（ADR 0042 D3.2）。
   *
   * 为什么需要：坐姿的"身体平移补偿"必须按**停帧那一帧**来量，而不是片段第一帧。
   * 交叉淡入仍在进行时不能量（量到的是站姿与坐姿的混合），所以加载期用
   * `playHold` + `holdSeek(片段末尾)` + `mixer.update(0)` 一次性取到终帧。
   */
  holdSeek(seconds: number): boolean;
  /** 淡出当前停住的姿态（离开 `sitting` 时用）；幂等 */
  clearHold(fadeSeconds: number): void;
  /** 停住姿态的进行态（诊断用）；没有时返回 null */
  hold(): HoldStatus | null;
  /** 打断正在播的一次性演出（淡出），不改变常驻槽位 */
  cancelOneShot(fadeSeconds: number): void;
  oneShot(): OneShotStatus | null;
  /**
   * 某个语义角色此刻的**有效权重**（0..1，ADR 0043 D3）。
   *
   * 用途：坐姿的身体平移补偿必须与"片段混合权重"同步 —— 权重 0（站姿）时补偿必须是 0，
   * 权重 1（完全坐姿）时补偿是满值。用动作自己的权重当插值因子，进场/退场都不会硬切。
   * 没在跑的角色返回 0（three 未播放的 action 默认权重是 1，不能直接读）。
   */
  roleWeight(role: ClipRole): number;
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
    // ADR 0043 D2：**循环角色同样允许裁窗口**。坐姿就是一个"只循环 0.42s 平稳段"的循环角色，
    // 旧实现把 `loop: true` 的角色直接绑到整段片段（38s 的过场），窗口被无声忽略。
    const clip =
      rule.maxSeconds === undefined && rule.startSeconds === undefined
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
  /**
   * 一次性演出开始**之前**在播的那个 action（ADR 0041 D2）。
   *
   * 为什么需要：`returnTo` 只是槽位名，回到槽位会重新选 `idle` 角色的片段。
   * 但待机姿态是会轮换的（`idle` / `idle.alt1` / `idle.alt2` / `idle.alt3`）——
   * 摸头时她在抱臂站姿里，回来却变成普通站姿，就是一次"被切断"的姿态跳变。
   * 记下那个 action，播完直接淡回它，姿势才连续。
   */
  let oneShotReturnAction: THREE.AnimationAction | null = null;
  let oneShotFadeOut = ONE_SHOT_FADE_OUT;
  let holdAction: THREE.AnimationAction | null = null;
  let holdRole: ClipRole | null = null;
  /**
   * 已经被播放过的语义角色（ADR 0044 修正）。
   *
   * 为什么需要：three 的 `AnimationAction` 默认 `enabled = true`、权重 1，
   * 所以"没播过的角色"和"正在播的角色"从权重上分不出来；而 `playHold` 停帧后
   * `isRunning()` 又会变成 false。用一张"激活表"把两者都绕开：
   * 只有真正被 `playOnce/playRole/playHold` 播放过的角色才报告权重（含淡出中的 0→1→0）。
   */
  const activatedRoles = new Set<ClipRole>();

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
    oneShotReturnAction = null;
  }

  function fadeOutHold(fadeSeconds: number): void {
    if (!holdAction) return;
    // 停住的姿态是被 clampWhenFinished 暂停的 action：淡出仍然生效（权重插值照跑）
    holdAction.fadeOut(Math.max(0, fadeSeconds));
    holdAction = null;
    holdRole = null;
  }

  function playSlot(slot: AnimationSlot, fadeSeconds: number): boolean {
    const picked = selection[slot];
    if (!picked.name) return false;
    const next = byName.get(picked.name);
    if (!next) return false;
    if (next === currentAction && oneShotAction === null && holdAction === null) return true;
    clearOneShot(fadeSeconds);
    fadeOutHold(fadeSeconds);
    next.setLoop(THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = false;
    fadeTo(next, fadeSeconds);
    currentSlot = slot;
    return true;
  }

  mixer.addEventListener('finished', (event) => {
    const finished = (event as unknown as { action?: THREE.AnimationAction }).action;
    if (!oneShotAction || finished !== oneShotAction) return;
    const back = oneShotReturnAction;
    const fadeOut = oneShotFadeOut;
    const slot = oneShotReturn;
    oneShotAction = null;
    oneShotRole = null;
    oneShotReturnAction = null;
    // ADR 0041 D2：能回到"演出前那个 action"就回去（姿势连续），否则退回槽位
    if (back && back !== finished) {
      back.enabled = true;
      back.setEffectiveTimeScale(1);
      back.play();
      // crossFadeFrom 会把 back 的权重从 0 拉到 1（fadeIn 内部从 0 开始）
      back.crossFadeFrom(finished as THREE.AnimationAction, Math.max(0, fadeOut), false);
      currentAction = back;
      // 槽位也要还原：否则诊断里会显示"有一个动作在播、但没有槽位"
      currentSlot = slot;
      return;
    }
    playSlot(slot, fadeOut);
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
      activatedRoles.add(role);
      if (next === currentAction && oneShotAction === null && holdAction === null) {
        currentSlot = slot;
        return true;
      }
      clearOneShot(fadeSeconds);
      fadeOutHold(fadeSeconds);
      next.setLoop(THREE.LoopRepeat, Infinity);
      next.clampWhenFinished = false;
      fadeTo(next, fadeSeconds);
      currentSlot = slot;
      return true;
    },

    roleWeight(role: ClipRole): number {
      const action = roleActions.get(role);
      // **不能只看 `isRunning()`**：`playHold` 的 `clampWhenFinished` 会把 action 置为
      // `paused = true`，此时 `isRunning()` 返回 false，但它的权重仍然是 1、姿态仍然生效。
      // 旧实现按 `isRunning()` 过滤，导致坐姿停帧后权重读成 0 → 身体平移补偿整块消失
      // （真机/自检截图：她被推到窗口左边，只剩半个身子）。
      if (!action || !activatedRoles.has(role) || !action.enabled) return 0;
      const weight = action.getEffectiveWeight();
      if (!Number.isFinite(weight)) return 0;
      return Math.min(1, Math.max(0, weight));
    },

    playHold(role: ClipRole, fadeSeconds: number): boolean {
      const next = roleActions.get(role);
      if (!next || !roleSelections[role].name) return false;
      activatedRoles.add(role);
      if (next === currentAction && holdAction === next) return true;
      clearOneShot(fadeSeconds);
      next.setLoop(THREE.LoopOnce, 1);
      next.clampWhenFinished = true;
      next.reset();
      next.enabled = true;
      next.setEffectiveTimeScale(1);
      next.setEffectiveWeight(1);
      next.play();
      if (currentAction && currentAction !== next) {
        next.crossFadeFrom(currentAction, Math.max(0, fadeSeconds), false);
      }
      currentAction = next;
      currentSlot = null;
      holdAction = next;
      holdRole = role;
      return true;
    },

    clearHold(fadeSeconds: number): void {
      fadeOutHold(fadeSeconds);
    },

    holdSeek(seconds: number): boolean {
      if (!holdAction) return false;
      const clip = holdAction.getClip();
      const target = Math.max(0, Math.min(clip.duration, Number.isFinite(seconds) ? seconds : 0));
      holdAction.time = target;
      holdAction.paused = false;
      // 只结算权重/时间，不推进时间轴（ADR 0014 D1：同一帧只允许在渲染循环里 update）
      mixer.update(0);
      return true;
    },

    hold(): HoldStatus | null {
      if (!holdAction || !holdRole) return null;
      const clip = holdAction.getClip();
      return {
        role: holdRole,
        name: clip.name,
        time: holdAction.time,
        duration: clip.duration,
        done: holdAction.time >= clip.duration - 1e-3,
        weight: holdAction.getEffectiveWeight(),
        paused: holdAction.paused,
        enabled: holdAction.enabled,
      };
    },

    playOnce(role: ClipRole, options: OneShotOptions = {}): boolean {
      const next = roleActions.get(role);
      if (!next || !roleSelections[role].name) return false;
      activatedRoles.add(role);
      const rule = CLIP_RULES[role];
      const fadeIn = options.fadeIn ?? rule.fadeInSeconds ?? ONE_SHOT_FADE_IN;
      const fadeOut = options.fadeOut ?? rule.fadeOutSeconds ?? ONE_SHOT_FADE_OUT;
      const returnTo = options.returnTo ?? 'idle';

      // "回到哪儿"要在切换之前定：若已有一次性演出在播，它记的底才是真正的底
      // （`currentAction` 此刻指向那个一次性演出，不能拿它当初底）
      const returnAction =
        oneShotReturnAction !== null
          ? oneShotReturnAction
          : currentAction && currentAction !== next
            ? currentAction
            : null;
      if (oneShotAction && oneShotAction !== next) clearOneShot(fadeIn);
      // 一次性演出要接管身体：停住的姿态必须让位（否则两份权重叠在一起）
      fadeOutHold(fadeIn);
      oneShotAction = next;
      oneShotRole = role;
      oneShotReturn = returnTo;
      oneShotReturnAction = returnAction;
      oneShotFadeOut = fadeOut;

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
        weight: oneShotAction.getEffectiveWeight(),
        paused: oneShotAction.paused,
        enabled: oneShotAction.enabled,
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
