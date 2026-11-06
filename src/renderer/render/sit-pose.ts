/**
 * 坐姿的**姿态过渡**（ADR 0028 D8；ADR 0042 D1 半蹲；ADR 0051 改为弹簧）。
 *
 * 职责收窄：本文件只回答"给定 `sitDrop`（0..1）时，落座姿态怎么摆"与
 * "没有坐姿片段时的降级姿态"。**所有"活感"（呼吸/张望/晃腿）都在 `sit-motion.ts`**。
 *
 * ADR 0051 起 `sitDrop` 由 `sit-drop.ts` 的临界阻尼弹簧产出（k=180 / c=26.8），
 * 不再是 240ms 线性缓动。所有量都按 `(1 - sitDrop)` 衰减到 0：
 * - 悬空高度 14px → 0；
 * - 大腿弯曲 0.22rad → 0；
 * - 躯干前倾 0.05rad → 0。
 * 这样"落座"的观感由弹簧的加速度曲线决定，而不是一条写死的时间线。
 */
import {
  SIT_LOWER_LEAN_RAD,
  SIT_LOWER_LIFT_PX,
  SIT_LOWER_THIGH_RAD,
} from '../../shared/constants';

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

/**
 * 0 → 1 的缓入缓出（两端都慢、中间快），用于**自主张望**的转头与阶段 B 覆盖淡入。
 *
 * 为什么不用指数阻尼：阻尼是"越接近越慢"，观感上像"慢慢飘过去"；
 * 固定时长的 cubic 是"起步 → 加速 → 收住"，才像一次干脆的转头。
 */
export function easeInOutCubic(progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * 当前坐姿**过渡**姿态（不含呼吸/张望/晃腿 —— 那些在 `sit-motion.ts`）。
 * @param sitDrop 弹簧进度 0..1（0 = 还在座面上方，1 = 完全坐好）
 * @param procedural `true` = 没有官方坐姿片段，走"下沉 + 弯腿"降级
 */
export function sitPose(sitDrop: number, procedural: boolean): SitPose {
  const progress = clamp01(sitDrop);
  const settle = 1 - progress;

  if (!procedural) {
    return {
      dropPx: 0,
      lean: SIT_LOWER_LEAN_RAD * settle,
      thighBend: SIT_LOWER_THIGH_RAD * settle,
      transition: progress,
      transitionLiftPx: SIT_LOWER_LIFT_PX * settle,
    };
  }

  return {
    dropPx: SIT_DROP_PX * progress,
    lean: SIT_LEAN_RAD * progress,
    thighBend: SIT_THIGH_BEND_RAD * progress,
    transition: progress,
    // 降级路径的"落下"由 SIT_DROP_PX 的下沉表达，不再额外叠加抬升
    transitionLiftPx: 0,
  };
}
