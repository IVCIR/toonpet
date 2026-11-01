/**
 * 前台窗口吸附的**纯几何**（ADR 0028 D2/D3/D7）。
 *
 * 只做矩形运算，不引用 Electron、不引用 koffi、不读时钟——因此可以脱离桌面单测。
 * 三条规则写在这里，别处不许重算：
 * 1. 吸附位置 = 目标边缘线 - 桌宠高度（脚底/臀压在边缘线上，身体在线上方）；
 * 2. 水平居中于目标窗口（吸附的是"窗口"，不是"屏幕"）；
 * 3. 结果必须满足 D-7 的可见性：先算期望位置，完全落在所有工作区之外就拒绝，
 *    否则用 `clampRectToWorkAreas` 夹回工作区（夹过的位置进日志，不当异常）。
 */
import {
  SNAP_FULLSCREEN_TOLERANCE_PX,
  SNAP_MAX_CLAMP_PX,
  SNAP_MIN_TARGET_HEIGHT_PX,
  SNAP_MIN_TARGET_WIDTH_PX,
} from '../../shared/constants';
import { clampRectToWorkAreas, intersectionArea } from '../../shared/geometry';
import type { Rect } from '../../shared/geometry';

/** 吸附在第几条边：`bottom` = 坐在窗口下边缘，`top` = 坐在上边缘（ADR 0028 D5）。 */
export type SnapEdge = 'top' | 'bottom';

export interface SnapTargetInput {
  edge: SnapEdge;
  /** 被吸附的矩形（DIP）：前台窗口边界，或回退模式下的工作区 */
  anchor: Rect;
  /** 桌宠窗口尺寸（DIP） */
  pet: { width: number; height: number };
  /** 所有显示器的工作区（DIP），D-7 判定用；空数组表示"不知道屏幕"，此时不夹 */
  workAreas: readonly Rect[];
}

export type SnapRefusal = 'invalid-rect' | 'invalid-pet' | 'fullscreen' | 'geometry';

export type SnapTargetResult =
  | {
      ok: true;
      x: number;
      y: number;
      edge: SnapEdge;
      /** 期望位置被 D-7 夹过（仍然吸附成功，只是没完全贴住） */
      clamped: boolean;
      /** 期望位置（诊断用，夹之前） */
      desired: { x: number; y: number };
    }
  | {
      ok: false;
      reason: SnapRefusal;
      /** 拒绝时的人话补充（进日志，不进 UI） */
      detail?: Record<string, unknown>;
    };

/** 有限数 + 正尺寸。前台窗口矩形来自 Win32，异常时可能是 0 / NaN。 */
export function isFiniteRect(rect: unknown): rect is Rect {
  if (!rect || typeof rect !== 'object') return false;
  const value = rect as Partial<Rect>;
  return (
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height) &&
    (value.width ?? 0) > 0 &&
    (value.height ?? 0) > 0
  );
}

/**
 * 可作为吸附目标的前台窗口：坐标合法、且不小于 80×40 DIP。
 * 比这更小的窗口（浮动提示条、工具窗）吸上去等于把她挂在一条缝上。
 */
export function isUsableTargetRect(rect: unknown): rect is Rect {
  return (
    isFiniteRect(rect) &&
    rect.width >= SNAP_MIN_TARGET_WIDTH_PX &&
    rect.height >= SNAP_MIN_TARGET_HEIGHT_PX
  );
}

/**
 * 全屏判定（ADR 0028 D3）：窗口矩形**盖住**了某台显示器的完整 bounds（容差 2 DIP）。
 *
 * 用"覆盖"而不是"相等"：无边框全屏游戏的 DWM 矩形常比显示器大几像素（阴影/边框），
 * 抓成窗口对象时是"大于等于屏幕"。用 `bounds` 而不是 `workArea`：最大化窗口差一个任务栏，
 * 不是全屏（吸上去完全合法）。
 */
export function isFullscreenRect(rect: Rect, displays: readonly Rect[]): boolean {
  if (!isFiniteRect(rect)) return false;
  const tolerance = SNAP_FULLSCREEN_TOLERANCE_PX;
  return displays.some(
    (display) =>
      rect.x <= display.x + tolerance &&
      rect.y <= display.y + tolerance &&
      rect.x + rect.width >= display.x + display.width - tolerance &&
      rect.y + rect.height >= display.y + display.height - tolerance,
  );
}

/**
 * 计算吸附后的窗口位置（左上角，DIP）。
 *
 * `edge: 'top'` 与 `'bottom'` 用同一个公式 `y = 边缘线 - 高度`：
 * 角色锚点是"脚底/臀 = 窗口底边中心"，所以窗口底边压在边缘线上，
 * 身体自然落在边缘线**上方**——坐在下边缘时盖住窗口内容，坐在上边缘时悬在桌面上方。
 */
export function computeSnapTarget(input: SnapTargetInput): SnapTargetResult {
  const { edge, anchor, pet, workAreas } = input;

  if (!isUsableTargetRect(anchor)) {
    return {
      ok: false,
      reason: 'invalid-rect',
      detail: { anchor, min: [SNAP_MIN_TARGET_WIDTH_PX, SNAP_MIN_TARGET_HEIGHT_PX] },
    };
  }
  if (!Number.isFinite(pet.width) || !Number.isFinite(pet.height) || pet.width <= 0 || pet.height <= 0) {
    return { ok: false, reason: 'invalid-pet', detail: { pet } };
  }

  const edgeLine = edge === 'bottom' ? anchor.y + anchor.height : anchor.y;
  const desired = {
    x: Math.round(anchor.x + (anchor.width - pet.width) / 2),
    y: Math.round(edgeLine - pet.height),
  };
  const rect: Rect = { x: desired.x, y: desired.y, width: pet.width, height: pet.height };

  // 完全落在所有工作区之外 → 拒绝（"坐标异常"的兜底：多显示器被拔掉、窗口在虚拟屏外）
  if (workAreas.length > 0 && workAreas.every((area) => intersectionArea(rect, area) <= 0)) {
    return { ok: false, reason: 'geometry', detail: { desired, workAreas } };
  }

  // 夹取时用**整窗尺寸**做 keep：能整窗放进工作区就整窗放（头不能被屏幕边缘切掉），
  // 窗口比工作区还大时才退到 D-7 的 80×120 下限（clampRectToWorkAreas 内部取 min）。
  const clampedRect =
    workAreas.length > 0
      ? clampRectToWorkAreas(rect, workAreas, pet.width, pet.height)
      : rect;

  // 竖直方向夹动太多 = 这条边缘线根本放不下她（例如窗口上沿离屏幕顶只有 100px，
  // 而她要 720px 才能"坐在上面"）。这时候不假装吸附，直接拒绝并提示（ADR 0028 D3）。
  // 水平方向的夹动只影响"是否居中"，不拒绝——窗口一半在屏幕外仍然可以坐。
  const clampDistanceY = Math.abs(clampedRect.y - rect.y);
  if (clampDistanceY > SNAP_MAX_CLAMP_PX) {
    return {
      ok: false,
      reason: 'geometry',
      detail: {
        desired,
        clamped: { x: Math.round(clampedRect.x), y: Math.round(clampedRect.y) },
        clampDistanceY: Math.round(clampDistanceY),
        edge,
        maxClampPx: SNAP_MAX_CLAMP_PX,
      },
    };
  }

  return {
    ok: true,
    x: Math.round(clampedRect.x),
    y: Math.round(clampedRect.y),
    edge,
    clamped: clampedRect.x !== rect.x || clampedRect.y !== rect.y,
    desired,
  };
}

/**
 * 回退模式（ADR 0028 D7）：拖到工作区边缘附近松手 → 吸附到那条边。
 *
 * 只认**下沿**：上沿要 720px 的身体悬在工作区之外，物理上放不下（`computeSnapTarget`
 * 会以 `geometry` 拒绝）。她自己本来就落在下沿线上，这里只是把姿态换成"坐"。
 */
export function findWorkAreaForBottomEdgeSnap(
  bounds: Rect,
  workAreas: readonly Rect[],
  thresholdPx: number,
): Rect | null {
  if (!isFiniteRect(bounds) || workAreas.length === 0) return null;
  const bottom = bounds.y + bounds.height;
  let best: Rect | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const area of workAreas) {
    const distance = Math.abs(bottom - (area.y + area.height));
    if (distance <= thresholdPx && distance < bestDistance) {
      bestDistance = distance;
      best = area;
    }
  }
  return best;
}

/**
 * 回退模式的热键目标：桌宠当前所在显示器的工作区（按重叠面积最大者，与 D-7 同口径）。
 * 没有工作区信息时返回 null（调用方拒绝吸附）。
 */
export function pickWorkArea(bounds: Rect, workAreas: readonly Rect[]): Rect | null {
  if (workAreas.length === 0) return null;
  let best: Rect | null = null;
  let bestArea = 0;
  for (const candidate of workAreas) {
    const overlap = intersectionArea(bounds, candidate);
    if (overlap > bestArea) {
      bestArea = overlap;
      best = candidate;
    }
  }
  if (best) return best;
  // 完全在工作区外（窗口被拖到屏幕外）：取中心最近的一个，保证回退始终有目标
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  let nearest: Rect | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of workAreas) {
    const dx = centerX - (candidate.x + candidate.width / 2);
    const dy = centerY - (candidate.y + candidate.height / 2);
    const distance = dx * dx + dy * dy;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = candidate;
    }
  }
  return nearest;
}
