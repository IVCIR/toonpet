/**
 * 窗口几何的纯函数：只做矩形运算，不引用 Electron，便于单测。
 * 契约 §3.4 D-7；ADR 0004 D6.2。
 */
import { WORKAREA_MIN_KEEP_HEIGHT_PX, WORKAREA_MIN_KEEP_WIDTH_PX } from './constants';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function intersectionArea(a: Rect, b: Rect): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

/**
 * D-7 钳制：把窗口矩形挪回工作区，保证至少 `keepWidth × keepHeight` 落在某一个工作区内。
 *
 * 选显示器的方式是**纯几何**的：先取与窗口矩形交集面积最大的工作区；
 * 若窗口完全在所有工作区之外（交集面积全为 0），取中心距离最近的工作区。
 * 不使用 `screen.getDisplayNearestPoint()`——指针可能停在显示器缝隙里，
 * 最近点会给出错误的显示器（ADR 0004 D6.2）。
 */
export function clampRectToWorkAreas(
  bounds: Rect,
  workAreas: readonly Rect[],
  keepWidth: number = WORKAREA_MIN_KEEP_WIDTH_PX,
  keepHeight: number = WORKAREA_MIN_KEEP_HEIGHT_PX,
): Rect {
  if (workAreas.length === 0) return bounds;

  const target = pickWorkArea(bounds, workAreas);

  const keepW = Math.min(keepWidth, bounds.width);
  const keepH = Math.min(keepHeight, bounds.height);

  const minX = target.x - (bounds.width - keepW);
  const maxX = target.x + target.width - keepW;
  const minY = target.y - (bounds.height - keepH);
  const maxY = target.y + target.height - keepH;

  return {
    x: clamp(bounds.x, minX, maxX),
    y: clamp(bounds.y, minY, maxY),
    width: bounds.width,
    height: bounds.height,
  };
}

function pickWorkArea(bounds: Rect, workAreas: readonly Rect[]): Rect {
  let best: Rect | null = null;
  let bestArea = 0;
  for (const workArea of workAreas) {
    const area = intersectionArea(bounds, workArea);
    if (area > bestArea) {
      bestArea = area;
      best = workArea;
    }
  }
  if (best) return best;

  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  let nearest: Rect | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const workArea of workAreas) {
    const dx = centerX - (workArea.x + workArea.width / 2);
    const dy = centerY - (workArea.y + workArea.height / 2);
    const distance = dx * dx + dy * dy;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = workArea;
    }
  }
  return nearest ?? workAreas[0]!;
}

function clamp(value: number, low: number, high: number): number {
  if (high < low) return low;
  return Math.min(Math.max(value, low), high);
}
