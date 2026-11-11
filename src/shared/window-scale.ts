/**
 * 整体缩放的**唯一几何实现**（ADR 0057 D2）。
 *
 * 一条规则，三个约束：
 *
 * 1. **等比**：窗口内容区宽高 = 基准尺寸 × scale。不等比缩放会让模型被拉扁
 *    （`placeModel()` 只按高度算 `pixelsPerUnit`，宽度是独立分量）。
 * 2. **底边中心锚点不动**：她的脚底永远在窗口底边中心（契约 §1.2 / §3.2）。
 *    放大时窗口向上、向左/右同时生长，而不是"左上角不动"。
 * 3. **不许长到工作区外面**：实际比例再按当前显示器工作区夹一次
 *    （`clamped: 'workarea'`）。1080p 桌面的工作区只有约 1040px 高，
 *    2.0x（1440px）硬放会把头切在屏幕外，且窗口超出工作区后拖不回来。
 *
 * 纯函数：不引用 Electron / three，可在 Node 单测里直接跑。
 * 主进程的 `shell` 与 `panel-shot` / `selftest` 取证都只走这里，禁止各写一份。
 */
import {
  CHARACTER_SCALE_DEFAULT,
  CHARACTER_SCALE_MAX,
  CHARACTER_SCALE_MIN,
} from './constants';
import { clampRectToWorkAreas } from './geometry';
import type { Rect } from './geometry';

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** 缩放被夹的原因：`none` 原样、`range` 超出 0.5–2.0、`workarea` 超出工作区 */
export type ScaleClamp = 'none' | 'range' | 'workarea';

export interface ScaledRect extends Rect {
  /** 请求的比例（夹到 [CHARACTER_SCALE_MIN, CHARACTER_SCALE_MAX] 之后） */
  requestedScale: number;
  /** 实际生效的比例（再按工作区夹过之后） */
  effectiveScale: number;
  clamped: ScaleClamp;
  /** 基准尺寸（未缩放）——诊断用，方便算出"这一帧到底放大了多少" */
  base: Size;
}

export interface ScaleWindowRequest {
  /** 基准内容区尺寸（`resolveWindowSize()` 的结果，未乘任何比例） */
  base: Size;
  /** 用户请求的比例；非有限值按默认 1.0 */
  scale: number;
  /** 底边中心锚点（屏幕 DIP 坐标）；缩放前后这一个点不动 */
  anchor: Point;
  /** 目标显示器工作区（DIP） */
  workArea: Rect;
}

function finitePositive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 夹到可调范围；非有限值退回默认 1.0（不是 min，也不是 0）。 */
export function clampCharacterScale(raw: unknown): number {
  const value =
    typeof raw === 'number' && Number.isFinite(raw) ? raw : Number.NaN;
  if (!Number.isFinite(value)) return CHARACTER_SCALE_DEFAULT;
  return Math.min(CHARACTER_SCALE_MAX, Math.max(CHARACTER_SCALE_MIN, value));
}

/**
 * 工作区能装下的**最大**比例（等比）。
 * 工作区非法时返回 `Infinity`（等于"不额外夹"）。
 */
export function maxScaleForWorkArea(base: Size, workArea: Rect): number {
  const width = finitePositive(base.width, 0);
  const height = finitePositive(base.height, 0);
  if (width <= 0 || height <= 0) return Number.POSITIVE_INFINITY;
  const areaWidth = finitePositive(workArea.width, Number.POSITIVE_INFINITY);
  const areaHeight = finitePositive(workArea.height, Number.POSITIVE_INFINITY);
  return Math.min(areaWidth / width, areaHeight / height);
}

/**
 * 把"位置"推进工作区：复用 `shared/geometry.ts` 的 D-7 钳制（**唯一实现**），
 * 至少保留 `WORKAREA_MIN_KEEP_*` 可见。正常情形（窗口本来就在工作区内）原样返回，
 * 所以"她贴在工作区底边"这个常见姿态不会被这一层悄悄抬起来。
 */
function keepVisible(rect: Rect, workArea: Rect): Point {
  const clamped = clampRectToWorkAreas(rect, [workArea]);
  return { x: Math.round(clamped.x), y: Math.round(clamped.y) };
}

/**
 * 算出缩放后的窗口矩形（宽高 + 位置）。
 *
 * 顺序是刻意的：**先定尺寸，再按底边中心锚点定位置，最后才做可见性兜底**。
 * 这样"放大 → 底边不动、左右对称生长"是主路径，只有把窗口拖出屏幕之后才走兜底。
 */
export function resolveScaledWindowBounds(request: ScaleWindowRequest): ScaledRect {
  const baseWidth = finitePositive(request.base?.width, 0);
  const baseHeight = finitePositive(request.base?.height, 0);
  const workArea = request.workArea;
  const anchorX = typeof request.anchor?.x === 'number' && Number.isFinite(request.anchor.x)
    ? request.anchor.x
    : 0;
  const anchorY = typeof request.anchor?.y === 'number' && Number.isFinite(request.anchor.y)
    ? request.anchor.y
    : 0;
  const base: Size = { width: baseWidth, height: baseHeight };

  // 基准非法：不动，也不假装成功（调用方据此跳过 setBounds）
  if (baseWidth <= 0 || baseHeight <= 0) {
    return {
      x: Math.round(anchorX - baseWidth / 2),
      y: Math.round(anchorY - baseHeight),
      width: Math.round(baseWidth),
      height: Math.round(baseHeight),
      requestedScale: CHARACTER_SCALE_DEFAULT,
      effectiveScale: CHARACTER_SCALE_DEFAULT,
      clamped: 'none',
      base,
    };
  }

  const requestedScale = clampCharacterScale(request.scale);
  let clamped: ScaleClamp = requestedScale === request.scale ? 'none' : 'range';
  let effectiveScale = requestedScale;

  const fit = maxScaleForWorkArea(base, workArea);
  if (Number.isFinite(fit) && fit < effectiveScale) {
    effectiveScale = Math.max(CHARACTER_SCALE_MIN, fit);
    clamped = 'workarea';
  }

  const width = Math.max(1, Math.round(baseWidth * effectiveScale));
  const height = Math.max(1, Math.round(baseHeight * effectiveScale));
  const wanted: Rect = {
    x: Math.round(anchorX - width / 2),
    y: Math.round(anchorY - height),
    width,
    height,
  };
  const position = workArea ? keepVisible(wanted, workArea) : { x: wanted.x, y: wanted.y };

  return {
    x: position.x,
    y: position.y,
    width,
    height,
    requestedScale,
    effectiveScale,
    clamped,
    base,
  };
}

/** 实际生效比例（按最终宽高反算，含取整误差）——诊断与面板读数用。 */
export function effectiveScaleOf(rect: Rect, base: Size): number {
  if (!(base.width > 0)) return CHARACTER_SCALE_DEFAULT;
  const value = rect.width / base.width;
  return Number.isFinite(value) ? Number(value.toFixed(3)) : CHARACTER_SCALE_DEFAULT;
}
