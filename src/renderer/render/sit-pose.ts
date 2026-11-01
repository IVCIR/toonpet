/**
 * 坐姿的程序化部分（ADR 0028 D8）。纯数值，不引用 three，便于单测。
 *
 * 两条路径共用同一套"活着"的微动：
 * - **官方片段**（`clip-bank` 的 `sit`，11.2–13.5s 的回忆坐姿）：片段会被
 *   `clampWhenFinished` 停在最后一帧，静止画面会显得像死机 → 叠一层 1.2px / 3.6s
 *   的呼吸浮动；
 * - **程序化降级**（换模型后没有坐姿片段）：用"被拎起的悬空姿态"下沉 24px +
 *   大腿骨弯曲 0.45rad + 轻微后倾，进入时 400ms 缓入（与 `dragSway` 同一手法：
 *   只动 `animationRoot` 与骨骼偏移，不改任何片段数据）。
 *
 * 不写 `Bip001 Pelvis` / `Spine`：那会把动画的呼吸压掉，且坐下高度已经由片段/下沉表达。
 */

/** 进入 sitting 时姿态变化（下沉、弯腿）的缓入时长 */
export const SIT_IN_RAMP_MS = 400;

/** 程序化降级：整体下沉多少像素（"把悬空姿态的 Y 轴压低"） */
export const SIT_DROP_PX = 24;

/** 程序化降级：大腿前弯弧度（正值 = 膝盖向前抬） */
export const SIT_THIGH_BEND_RAD = 0.45;

/** 程序化降级：轻微后倾（靠坐在边缘上） */
export const SIT_LEAN_RAD = 0.02;

/** 呼吸浮动：静止姿态也保留一点生命感 */
export const SIT_BREATH_AMPLITUDE_PX = 1.2;
export const SIT_BREATH_PERIOD_MS = 3600;

export interface SitPose {
  /** 下沉像素（正值向下）；官方片段路径恒为 0 */
  dropPx: number;
  /** 呼吸浮动像素（±amplitude） */
  bobPx: number;
  /** 身体后倾（rad，加到 animationRoot.rotation.z） */
  lean: number;
  /** 大腿弯曲（rad，交给骨骼仲裁器；官方片段路径恒为 0） */
  thighBend: number;
}

/** 0 → 1 的缓出（起步快、收尾稳），用于"坐下去"的那一下 */
export function easeOutCubic(progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return 1 - (1 - p) ** 3;
}

/**
 * 当前坐姿姿态。
 * @param elapsedMs 进入 sitting 之后经过的毫秒数
 * @param procedural `true` = 没有官方坐姿片段，走"下沉 + 弯腿"降级
 */
export function sitPose(elapsedMs: number, procedural: boolean): SitPose {
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const ramp = easeOutCubic(elapsed / SIT_IN_RAMP_MS);
  const phase = (elapsed / SIT_BREATH_PERIOD_MS) * Math.PI * 2;
  const bobPx = Math.sin(phase) * SIT_BREATH_AMPLITUDE_PX;
  if (!procedural) {
    return { dropPx: 0, bobPx, lean: 0, thighBend: 0 };
  }
  return {
    dropPx: SIT_DROP_PX * ramp,
    bobPx,
    lean: SIT_LEAN_RAD * ramp,
    thighBend: SIT_THIGH_BEND_RAD * ramp,
  };
}
