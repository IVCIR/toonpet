/**
 * 坐姿的**姿态过渡**（ADR 0028 D8；ADR 0042 D1 半蹲；ADR 0044 起只管姿态，不再管呼吸）。
 *
 * 职责收窄（ADR 0044）：本文件只回答"落座那 240ms 的半蹲怎么走"与"没有坐姿片段时的
 * 降级姿态"。**所有"活感"（呼吸/张望/眨眼/晃腿）都搬到 `sit-motion.ts`**，参数在
 * `shared/constants.ts` 的「坐姿活体微动」段 —— 两件事必须解耦：
 * 姿态过渡只发生一次（0–240ms），活体微动是常驻的慢变量。
 *
 * 三条路径：
 * - **官方片段（停帧）**：片段给骨架基线，本文件只叠 240ms 半蹲（+14px → 0、大腿 0.22rad → 0、
 *   躯干前倾 0.05rad → 0）；
 * - **程序化降级**（没有坐姿片段）：悬空姿态下沉 24px + 大腿弯曲 0.45rad + 轻微后倾，400ms 缓入；
 * - 两者都不写 Pelvis/Spine 的常驻姿态（那会把片段的呼吸压掉）。
 */

/** 进入 sitting 时姿态变化（下沉、弯腿）的缓入时长 */
export const SIT_IN_RAMP_MS = 400;

/** 官方片段路径的"坐下"过渡时长（ms）：与 `shared/constants.ts` 的 `SIT_LOWER_MS` 同值 */
export const SIT_LOWER_TRANSITION_MS = 240;
/** 过渡起点的"悬空高度"（px）：从座面上方这么多开始落下 */
export const SIT_LOWER_TRANSITION_LIFT_PX = 14;
/** 过渡起点的额外大腿弯曲 / 躯干前倾（rad） */
export const SIT_LOWER_TRANSITION_THIGH_RAD = 0.22;
export const SIT_LOWER_TRANSITION_LEAN_RAD = 0.05;

/** 程序化降级：整体下沉多少像素（"把悬空姿态的 Y 轴压低"） */
export const SIT_DROP_PX = 24;

/** 程序化降级：大腿前弯弧度（正值 = 膝盖向前抬） */
export const SIT_THIGH_BEND_RAD = 0.45;

/** 程序化降级：轻微后倾（靠坐在边缘上） */
export const SIT_LEAN_RAD = 0.02;

export interface SitPose {
  /** 下沉像素（正值向下）；官方片段路径恒为 0 */
  dropPx: number;
  /** 身体后倾（rad，加到 animationRoot.rotation.z） */
  lean: number;
  /** 大腿弯曲（rad，交给骨骼仲裁器） */
  thighBend: number;
  /** 坐下过渡的进度（0..1）：1 = 已经落座 */
  transition: number;
  /** 坐下过渡本帧的"悬空高度"（px，正值向上）；过渡结束后恒为 0 */
  transitionLiftPx: number;
}

/** 0 → 1 的缓出（起步快、收尾稳），用于"坐下去"的那一下 */
export function easeOutCubic(progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return 1 - (1 - p) ** 3;
}

/**
 * 0 → 1 的缓入缓出（两端都慢、中间快），用于**自主张望**的转头（ADR 0045 D2.2）。
 *
 * 为什么不用指数阻尼：阻尼是"越接近越慢"，观感上像"慢慢飘过去"；
 * 固定时长的 cubic 是"起步 → 加速 → 收住"，才像一次干脆的转头。
 */
export function easeInOutCubic(progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
}

/**
 * 当前坐姿**过渡**姿态（不含呼吸/张望/眨眼/晃腿 —— 那些在 `sit-motion.ts`）。
 * @param elapsedMs 进入 sitting（**落座**）之后经过的毫秒数
 * @param procedural `true` = 没有官方坐姿片段，走"下沉 + 弯腿"降级
 */
export function sitPose(elapsedMs: number, procedural: boolean): SitPose {
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;

  // ADR 0042 D1：坐下过渡（两种路径都报告进度，只有官方路径真的用它做半蹲）
  const transition = Math.min(1, elapsed / SIT_LOWER_TRANSITION_MS);
  const settle = 1 - easeOutCubic(transition);

  if (!procedural) {
    return {
      dropPx: 0,
      lean: SIT_LOWER_TRANSITION_LEAN_RAD * settle,
      thighBend: SIT_LOWER_TRANSITION_THIGH_RAD * settle,
      transition,
      transitionLiftPx: SIT_LOWER_TRANSITION_LIFT_PX * settle,
    };
  }

  const ramp = easeOutCubic(elapsed / SIT_IN_RAMP_MS);
  return {
    dropPx: SIT_DROP_PX * ramp,
    lean: SIT_LEAN_RAD * ramp,
    thighBend: SIT_THIGH_BEND_RAD * ramp,
    transition,
    // 降级路径的"落下"由 SIT_DROP_PX 的下沉表达，不再额外叠加抬升
    transitionLiftPx: 0,
  };
}
