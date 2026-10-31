/**
 * 摸头反应 `pat_react` 的程序化姿态（ADR 0014 D6）。
 *
 * 资产里没有摸头片段（`Cafe_Reaction` 10.75s、`Formation_Pickup` 14s 都是整身演出，
 * 会抢身体/口型通道），因此用三通道合成：
 * - 头部：后仰 + 轻微侧倾（经骨骼仲裁器叠加，不写整身动画）；
 * - 身体：前倾（`animationRoot` 旋转，不改脚底锚点）；
 * - 表情：嘴型图集切到 shy 帧（ADR 0010 D2 的贴图管线）。
 *
 * 权重上限由 §5.3 决定：`speaking` 期间 `pat_react` 权重 ≤ 0.4，且不得触碰嘴型贴图。
 * 本文件只有纯数值，便于单测；不引用 three。
 */

/** 一次性反应时长（与 HFSM 的 reacting 生命周期同源）。 */
export const PAT_DURATION_MS = 1100;

/** 头部后仰（负 pitch = 抬头看）与侧倾（正 roll）。 */
export const PAT_HEAD_PITCH_RAD = -0.3;
export const PAT_HEAD_ROLL_RAD = 0.08;

/** 身体前倾（绕 z 轴，正值向角色左肩方向倾）。 */
export const PAT_BODY_LEAN_RAD = 0.05;

/** 图集里的 "shy" 嘴型帧（0 = 静态闭嘴底图；见 ADR 0010 D2 的标定）。 */
export const PAT_MOUTH_FRAME = 4;

/** §5.3：说话时被摸头，反应以 ≤ 0.4 权重叠加，不打断口型。 */
export const PAT_SPEAKING_WEIGHT_CAP = 0.4;

/** `sin(π·p)`：0 → 峰值 → 0，且两端导数为 0（不会突然开始/结束）。 */
export function patEnvelope(progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return Math.sin(Math.PI * p);
}

/** 说话时上限 0.4；非说话时满权重。 */
export function patWeight(speaking: boolean): number {
  return speaking ? PAT_SPEAKING_WEIGHT_CAP : 1;
}

export interface PatPose {
  envelope: number;
  weight: number;
  headPitch: number;
  headRoll: number;
  bodyLean: number;
  /** 是否允许改嘴型贴图（说话时禁止，§5.2 口型通道最高优先级） */
  allowMouthChange: boolean;
}

export function patPose(progress: number, speaking: boolean): PatPose {
  const envelope = patEnvelope(progress);
  const weight = patWeight(speaking);
  const scaled = envelope * weight;
  return {
    envelope,
    weight,
    headPitch: PAT_HEAD_PITCH_RAD * scaled,
    headRoll: PAT_HEAD_ROLL_RAD * scaled,
    bodyLean: PAT_BODY_LEAN_RAD * scaled,
    allowMouthChange: !speaking,
  };
}
