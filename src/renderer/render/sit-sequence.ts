/**
 * 坐姿**两段式**的纯逻辑（ADR 0051）。
 *
 * - 阶段 A：从 `SIT_CLIP_START_SECONDS`（14.2s）正常播到 `SIT_CLIP_STAGE_B_SECONDS`（16.0s），
 *   让官方片段自己演"坐下 + 第一次张望"；
 * - 阶段 B：继续播到 `SIT_CLIP_HOLD_SECONDS`（16.2s）停帧；从 16.0s 起用 0.3s
 *   淡入站立上半身覆盖 + 程序化微动。
 *
 * 这里只回答"现在到 B 了吗 / 覆盖权重是多少"，不引用 three、不读时钟。
 */
import {
  SIT_CLIP_HOLD_SECONDS,
  SIT_CLIP_STAGE_B_SECONDS,
  SIT_CLIP_START_SECONDS,
  SIT_STAGE_B_FADE_MS,
  SIT_UPPER_HANDOVER_MS,
} from '../../shared/constants';
import { easeInOutCubic } from './sit-pose';

export type SitStage = 'a' | 'b';

/** 阶段 B 在**裁剪后片段**里的本地时间（秒） */
export function sitStageBLocalSeconds(): number {
  // 14.2/16.0 在二进制浮点里相减会得到 1.8000000000000007；四舍五入到毫秒，
  // 保证断言与运行时都在"正好 1.8s"触发。
  return Math.round((SIT_CLIP_STAGE_B_SECONDS - SIT_CLIP_START_SECONDS) * 1000) / 1000;
}

/** 停帧在**裁剪后片段**里的本地时长（秒） */
export function sitHoldLocalSeconds(): number {
  return Math.round((SIT_CLIP_HOLD_SECONDS - SIT_CLIP_START_SECONDS) * 1000) / 1000;
}

/** 用片段本地时间判断阶段；非法输入按阶段 A 处理。 */
export function sitStageAt(localSeconds: number): SitStage {
  if (!Number.isFinite(localSeconds)) return 'a';
  return localSeconds >= sitStageBLocalSeconds() ? 'b' : 'a';
}

/**
 * 阶段 B 的上半身覆盖权重（0..1），用 `easeInOutCubic` 平滑淡入。
 *
 * 为什么用缓动而不是线性：0.3s 的线性混合在起点/终点都有速度突变，
 * 头部会读成"先被拽一下、再停住"；cubic 两端速度 0，过渡是"慢慢回正"。
 */
export function sitStageBBlend(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs)) return 0;
  const p = Math.min(1, Math.max(0, elapsedMs / Math.max(1, SIT_STAGE_B_FADE_MS)));
  return easeInOutCubic(p);
}

/**
 * **退出坐姿的交接进度**（ADR 0057 D1）：0 → 1，`SIT_UPPER_HANDOVER_MS` 用 cubic 走完。
 *
 * 用途只有一个：离开 `sitting` 之后把"上半身覆写权重"从离开那一刻的值乘 `(1 - 本值)` 收到 0，
 * 收到 0 的那一帧再把 `overrideBase/overridePosition` 全部清成 `null`，
 * 把这四根骨（+眼球 +眼皮）彻底还给 `AnimationMixer`。
 *
 * 为什么也是 cubic：与阶段 B 的淡入对称 —— 起点/终点速度都是 0，交接不会读成"头被拽一下"。
 * 非法输入（NaN/负值）按 0 处理，超时按 1 处理（= 收尾已完成，可以放手）。
 */
export function sitUpperExitBlend(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs)) return 0;
  const p = Math.min(1, Math.max(0, elapsedMs / Math.max(1, SIT_UPPER_HANDOVER_MS)));
  return easeInOutCubic(p);
}
