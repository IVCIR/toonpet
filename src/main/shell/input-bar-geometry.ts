/**
 * 输入条几何（纯函数，不引用 Electron，便于单测）：ADR 0003 §2、ADR 0004 D8.2。
 *
 * 规则只有三条：
 * 1. 默认放在主窗口内容区顶边**上方 8px**、水平居中（ADR 0003 §2）；
 * 2. 上方可用空间不足以容纳 `44 + 8`（贴屏幕顶边）时，改到顶边**下方 8px**（ADR 0004 D8.2）；
 * 3. 水平方向钳制在显示器工作区内，避免半截跑到屏外（不引入新的 D-7 类规则）。
 *
 * 输入条是独立窗口，不在主窗口内，因此"与字幕气泡不重叠"由**位置关系**保证：
 * 字幕固定在主窗口内容区下沿，输入条在顶边之外（下落时也只占顶边内 8–52px）。
 * 自检里用矩形断言把这条几何关系锁死（`npm run selftest:input`）。
 */
import {
  INPUT_BAR_GAP_PX,
  INPUT_BAR_HEIGHT_PX,
  INPUT_BAR_WIDTH_PX,
} from '../../shared/constants';
import type { Rect } from '../../shared/geometry';

export type InputBarPlacement = 'above' | 'below';

export interface InputBarBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  placement: InputBarPlacement;
  /** 垂直方向被工作区下边界钳制过（诊断用） */
  clampedY: boolean;
  /** 水平方向被工作区左右边界钳制过（诊断用） */
  clampedX: boolean;
}

export function computeInputBarBounds(content: Rect, workArea: Rect): InputBarBounds {
  const width = INPUT_BAR_WIDTH_PX;
  const height = INPUT_BAR_HEIGHT_PX;

  const aboveY = content.y - INPUT_BAR_GAP_PX - height;
  const belowY = content.y + INPUT_BAR_GAP_PX;
  const placement: InputBarPlacement = aboveY >= workArea.y ? 'above' : 'below';

  const rawY = placement === 'above' ? aboveY : belowY;
  const maxY = workArea.y + workArea.height - height;
  const y = Math.min(Math.max(rawY, workArea.y), Math.max(workArea.y, maxY));

  const centeredX = Math.round(content.x + (content.width - width) / 2);
  const maxX = workArea.x + workArea.width - width;
  const x = Math.min(Math.max(centeredX, workArea.x), Math.max(workArea.x, maxX));

  return {
    x,
    y,
    width,
    height,
    placement,
    clampedY: y !== rawY,
    clampedX: x !== centeredX,
  };
}

/** 两个矩形是否相交（边贴边不算），用于"输入条与字幕气泡不重叠"的断言。 */
export function rectsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
