/**
 * 模型取景与窗口定标的纯函数（主进程与渲染侧**共用同一份**，ADR 0009 D3/D4/D5）。
 *
 * 这里只做矩形/比例运算，不引用 three、不引用 Electron，便于单测。
 * 关键约束：
 * - 取景排除正则必须两侧一致（渲染侧通过 loadFile 的 query 收到主进程解析后的同一个字符串）；
 * - 窗口尺寸公式只能有一份实现，禁止主进程与渲染侧各写一套。
 */

export interface Bounds3 {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** 契约 §3.2：窗口按模型包围盒 × 1.15 校正（顶部留白 15%）。 */
export const MODEL_FRAME_PADDING = 1.15;

/**
 * 取景时排除的网格名（正则，大小写不敏感）。配件（武器/道具/笔刷/描边）会把包围盒
 * 撑宽、把角色挤到窗口角落；它们仍然照常渲染，只是不参与窗口取景（ADR 0009 D3）。
 */
export const DEFAULT_FRAME_EXCLUDE = '(weapon|prop|brush|outline)';

/** 窗口宽度护栏：极端比例模型不能把窗口撑到无法使用（ADR 0009 D4）。 */
export const MIN_MODEL_WINDOW_WIDTH_PX = 240;
export const MAX_MODEL_WINDOW_WIDTH_PX = 960;

export interface WindowSize {
  width: number;
  height: number;
  pixelsPerUnit: number;
  /** true = 宽度被 MIN/MAX 夹过 */
  clampedWidth: boolean;
}

export function frameWidth(bounds: Bounds3): number {
  return Math.max(0, bounds.maxX - bounds.minX);
}

export function frameHeight(bounds: Bounds3): number {
  return Math.max(0, bounds.maxY - bounds.minY);
}

/** 正则无效时按"不排除"处理，绝不让一个坏的环境变量打挂加载。 */
export function matchesFrameExclude(name: string | null | undefined, pattern: string): boolean {
  if (!name || !pattern) return false;
  try {
    return new RegExp(pattern, 'i').test(name);
  } catch {
    return false;
  }
}

export function mergeBounds(bounds: readonly Bounds3[]): Bounds3 | null {
  if (bounds.length === 0) return null;
  const out: Bounds3 = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  };
  for (const b of bounds) {
    out.minX = Math.min(out.minX, b.minX);
    out.minY = Math.min(out.minY, b.minY);
    out.minZ = Math.min(out.minZ, b.minZ);
    out.maxX = Math.max(out.maxX, b.maxX);
    out.maxY = Math.max(out.maxY, b.maxY);
    out.maxZ = Math.max(out.maxZ, b.maxZ);
  }
  return out;
}

/**
 * 1 个模型单位对应多少 CSS px：让取景包围盒的高度占内容区高度的 `1 / padding`。
 * 输入非法时返回 0（调用方据此走"不缩放"或失败分支）。
 */
export function pixelsPerUnitFor(
  frameHeightUnits: number,
  contentHeightPx: number,
  padding: number = MODEL_FRAME_PADDING,
): number {
  if (!(frameHeightUnits > 0) || !(contentHeightPx > 0) || !(padding > 0)) return 0;
  return contentHeightPx / (frameHeightUnits * padding);
}

/**
 * D-4：高度沿用设计基准（默认 720），宽度按取景包围盒的宽高比推导，
 * 再夹到 [MIN, MAX]。等价于"默认 480×720，按模型包围盒 × 1.15 校正"。
 */
export function computeWindowSize(
  bounds: Bounds3,
  designHeightPx: number,
  padding: number = MODEL_FRAME_PADDING,
): WindowSize {
  const widthUnits = frameWidth(bounds);
  const heightUnits = frameHeight(bounds);
  const pixelsPerUnit = pixelsPerUnitFor(heightUnits, designHeightPx, padding);

  if (!(pixelsPerUnit > 0) || !(widthUnits > 0)) {
    return {
      width: MIN_MODEL_WINDOW_WIDTH_PX,
      height: designHeightPx,
      pixelsPerUnit: 0,
      clampedWidth: false,
    };
  }

  const rawWidth = Math.round(widthUnits * pixelsPerUnit * padding);
  const width = Math.min(
    MAX_MODEL_WINDOW_WIDTH_PX,
    Math.max(MIN_MODEL_WINDOW_WIDTH_PX, rawWidth),
  );
  return {
    width,
    height: designHeightPx,
    pixelsPerUnit,
    clampedWidth: width !== rawWidth,
  };
}
