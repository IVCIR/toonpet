/**
 * 模型取景与窗口定标的纯函数（主进程与渲染侧**共用同一份**，ADR 0009 D3/D4/D5）。
 *
 * 这里只做矩形/比例运算，不引用 three、不引用 Electron，便于单测。
 * 关键约束：
 * - 取景排除正则必须两侧一致（渲染侧通过 loadFile 的 query 收到主进程解析后的同一个字符串）；
 * - 窗口尺寸公式只能有一份实现，禁止主进程与渲染侧各写一套。
 *
 * ADR 0058 D1：窗口尺寸在"包围盒 × 1.15"之外**再加一圈视口安全边距**
 * （`MODEL_VIEW_PADDING_PX`：左右各一份、头顶一份、底边 0）。边距是**加法**：
 * 1.0x 时她的像素尺寸与加边距之前**完全一样**（`pixelsPerUnit` 不变），
 * 多出来的只是四周的透明空白 —— 这是"拖拽摇晃时头发不被窗口边缘切掉"的空间来源。
 */
import {
  BASE_CONTENT_HEIGHT_PX,
  MODEL_VIEW_PADDING_PX,
  MODEL_VIEW_PADDING_X_PX,
  WINDOW_HEIGHT_PX,
  WINDOW_WIDTH_PX,
} from './constants';

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
 * 视口安全边距在**内容区高度**里占的份额（0..1）。
 *
 * 边距是"px 加法"，但缩放是等比乘窗口，所以运行期不能直接减 `MODEL_VIEW_PADDING_PX`：
 * 2.0x 时窗口 1512px 高，减 36px 会让她的像素尺寸偏离 2.0x 一点点。
 * 改成**固定份额** `P / (设计高 + P)`：任何倍率下边距都与窗口同比，
 * `pixelsPerUnit` 因此严格与内容区高度成正比（缩放比例才是真的等比）。
 */
export function viewPaddingShare(designHeightPx: number = WINDOW_HEIGHT_PX): number {
  const design = designHeightPx > 0 ? designHeightPx : WINDOW_HEIGHT_PX;
  return MODEL_VIEW_PADDING_PX / (design + MODEL_VIEW_PADDING_PX);
}

/**
 * 1 个模型单位对应多少 CSS px。
 *
 * 没有视口边距时（`viewPaddingShare = 0`）等价于旧口径：
 * 取景包围盒的高度占内容区高度的 `1 / padding`。
 * 有边距时先把内容区按份额折回"纯取景高度"，模型的像素尺寸就只跟内容区高度成比例。
 * 输入非法时返回 0（调用方据此走"不缩放"或失败分支）。
 */
export function pixelsPerUnitFor(
  frameHeightUnits: number,
  contentHeightPx: number,
  padding: number = MODEL_FRAME_PADDING,
  viewPaddingShareRatio = 0,
): number {
  if (!(frameHeightUnits > 0) || !(contentHeightPx > 0) || !(padding > 0)) return 0;
  const share =
    Number.isFinite(viewPaddingShareRatio) && viewPaddingShareRatio > 0
      ? Math.min(0.5, viewPaddingShareRatio)
      : 0;
  return (contentHeightPx * (1 - share)) / (frameHeightUnits * padding);
}

/**
 * D-4：高度 = 设计基准（默认 720）+ 头顶安全边距；宽度按取景包围盒的宽高比推导
 * 再加左右各一份边距，最后夹到 [MIN, MAX]。
 *
 * 1.0x 的窗口因此从 422×720 变成 494×756：她的像素尺寸不变（`pixelsPerUnit` 仍是
 * 57538），左右各多 36px、头顶多 36px 的透明空白（ADR 0058 D1）。
 */
export function computeWindowSize(
  bounds: Bounds3,
  designHeightPx: number,
  padding: number = MODEL_FRAME_PADDING,
): WindowSize {
  const widthUnits = frameWidth(bounds);
  const heightUnits = frameHeight(bounds);
  const share = viewPaddingShare(designHeightPx);
  const pixelsPerUnit = pixelsPerUnitFor(heightUnits, designHeightPx + MODEL_VIEW_PADDING_PX, padding, share);

  if (!(pixelsPerUnit > 0) || !(widthUnits > 0)) {
    return {
      width: MIN_MODEL_WINDOW_WIDTH_PX,
      height: designHeightPx + MODEL_VIEW_PADDING_PX,
      pixelsPerUnit: 0,
      clampedWidth: false,
    };
  }

  const rawWidth =
    Math.round(widthUnits * pixelsPerUnit * padding) + 2 * MODEL_VIEW_PADDING_X_PX;
  const width = Math.min(
    MAX_MODEL_WINDOW_WIDTH_PX,
    Math.max(MIN_MODEL_WINDOW_WIDTH_PX, rawWidth),
  );
  return {
    width,
    height: designHeightPx + MODEL_VIEW_PADDING_PX,
    pixelsPerUnit,
    clampedWidth: width !== rawWidth,
  };
}

/** 1.0x 的基准内容区尺寸（模型缺失/解析失败时的兜底，ADR 0009 D6）。 */
export function fallbackWindowSize(): WindowSize {
  return {
    width: Math.min(
      MAX_MODEL_WINDOW_WIDTH_PX,
      WINDOW_WIDTH_PX + 2 * MODEL_VIEW_PADDING_X_PX,
    ),
    height: BASE_CONTENT_HEIGHT_PX,
    pixelsPerUnit: 0,
    clampedWidth: false,
  };
}
