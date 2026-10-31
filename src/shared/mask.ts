/**
 * 命中掩膜的坐标映射与采样。
 *
 * 契约 §3.3 R-2/R-3/R-4/R-10；ADR 0002；ADR 0004 D1.3。
 *
 * 本文件是 CSS → 掩膜坐标映射的**唯一**实现。主进程与渲染侧都必须引用这里，
 * 禁止各自再写一份（ADR 0004 D1.3）。
 *
 * 坐标系约定：
 * - 掩膜是 128 × 72 的单元网格，单元 (i, j) 的中心位于 ((i + 0.5) / 128, (j + 0.5) / 72)；
 * - 因此连续掩膜坐标在单元中心处取整数，`cssToMask` 的 −0.5 偏移就是这个约定；
 * - 掩膜覆盖整个窗口内容区，CSS 坐标按内容区宽高等比映射（R-3）。
 */
import { HEAD_BAND_RATIO, HIT_ALPHA_THRESHOLD, MASK_HEIGHT, MASK_WIDTH } from './constants';

export interface MaskPoint {
  mx: number;
  my: number;
}

export interface MaskBoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface HitSample {
  inside: boolean;
  mx: number;
  my: number;
  alpha: number;
  hit: boolean;
}

/**
 * 窗口内容区 CSS 坐标 → 连续掩膜坐标（单元中心为整数）。
 * 调用方必须先保证 `cssW > 0 && cssH > 0`；`hitTest` 已内置该检查。
 */
export function cssToMask(cssX: number, cssY: number, cssW: number, cssH: number): MaskPoint {
  return {
    mx: (cssX / cssW) * MASK_WIDTH - 0.5,
    my: (cssY / cssH) * MASK_HEIGHT - 0.5,
  };
}

/** 光标是否落在窗口内容区矩形内（左闭右开）。 */
export function isInsideContent(cssX: number, cssY: number, cssW: number, cssH: number): boolean {
  if (!(cssW > 0) || !(cssH > 0)) return false;
  if (!Number.isFinite(cssX) || !Number.isFinite(cssY)) return false;
  return cssX >= 0 && cssY >= 0 && cssX < cssW && cssY < cssH;
}

/**
 * 双线性采样（R-4）。返回 0..1 的归一化 alpha。
 * 掩膜之外按 0 处理（不做边缘复制），因此贴着内容区边缘的点不会被外扩命中。
 */
export function alphaAt(
  alpha: Uint8Array,
  width: number,
  height: number,
  mx: number,
  my: number,
): number {
  if (!Number.isFinite(mx) || !Number.isFinite(my)) return 0;
  const x0 = Math.floor(mx);
  const y0 = Math.floor(my);
  const tx = mx - x0;
  const ty = my - y0;

  const a00 = cellAlpha(alpha, width, height, x0, y0);
  const a10 = cellAlpha(alpha, width, height, x0 + 1, y0);
  const a01 = cellAlpha(alpha, width, height, x0, y0 + 1);
  const a11 = cellAlpha(alpha, width, height, x0 + 1, y0 + 1);

  const top = a00 + (a10 - a00) * tx;
  const bottom = a01 + (a11 - a01) * tx;
  return (top + (bottom - top) * ty) / 255;
}

function cellAlpha(
  alpha: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  if (x < 0 || y < 0 || x >= width || y >= height) return 0;
  return alpha[y * width + x] ?? 0;
}

/**
 * `readRenderTargetPixels` 的 RGBA 缓冲 → 纯 alpha 缓冲。
 *
 * `flipY`：WebGL 的帧缓冲原点在左下，而 CSS/掩膜坐标系原点在左上，
 * 从离屏 RT 读回时必须垂直翻转，否则整个掩膜会上下颠倒（实测踩到过）。
 */
export function rgbaToAlpha(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  flipY = false,
): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sourceRow = flipY ? height - 1 - y : y;
    for (let x = 0; x < width; x += 1) {
      out[y * width + x] = rgba[(sourceRow * width + x) * 4 + 3] ?? 0;
    }
  }
  return out;
}

/**
 * 掩膜 alpha 包围盒（R-10 的头部区基准）。
 * 以 `threshold`（默认与命中阈值同源 0.5）判定"参与包围盒的单元"，保证命中与头部区不打架。
 */
export function alphaBoundingBox(
  alpha: Uint8Array,
  width: number,
  height: number,
  threshold: number = HIT_ALPHA_THRESHOLD,
): MaskBoundingBox | null {
  const minAlpha = threshold * 255;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((alpha[y * width + x] ?? 0) < minAlpha) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) return null;
  return { minX, minY, maxX, maxY };
}

/** 头部区的下边界（连续掩膜行坐标，不包含）。 */
export function headBandBottomRow(
  bbox: MaskBoundingBox,
  ratio: number = HEAD_BAND_RATIO,
): number {
  const rows = bbox.maxY - bbox.minY + 1;
  return bbox.minY + rows * ratio;
}

/** 连续掩膜坐标是否落在"包围盒顶部 22%"这个横带内（R-10）。 */
export function isInHeadRegion(
  bbox: MaskBoundingBox | null,
  mx: number,
  my: number,
  ratio: number = HEAD_BAND_RATIO,
): boolean {
  if (!bbox) return false;
  if (!Number.isFinite(mx) || !Number.isFinite(my)) return false;
  // 连续坐标下包围盒覆盖 [minX, maxX + 1) × [minY, maxY + 1)
  if (mx < bbox.minX || mx >= bbox.maxX + 1) return false;
  return my >= bbox.minY && my < headBandBottomRow(bbox, ratio);
}

/** 一次完整的命中判定：内容区矩形 → 双线性 alpha → 阈值。 */
export function hitTest(
  alpha: Uint8Array,
  width: number,
  height: number,
  cssX: number,
  cssY: number,
  cssW: number,
  cssH: number,
  threshold: number = HIT_ALPHA_THRESHOLD,
): HitSample {
  if (!isInsideContent(cssX, cssY, cssW, cssH)) {
    return { inside: false, mx: Number.NaN, my: Number.NaN, alpha: 0, hit: false };
  }
  const { mx, my } = cssToMask(cssX, cssY, cssW, cssH);
  const alphaValue = alphaAt(alpha, width, height, mx, my);
  return { inside: true, mx, my, alpha: alphaValue, hit: alphaValue >= threshold };
}
