/**
 * 官方表情差分贴图的加载与采样（ADR 0026 D6）。
 *
 * 数据来源：`data/expressions/`（可用 `PET_EXPRESSIONS_DIR` 覆盖），经只读
 * `pet-asset://asset/expr/<file>` 交给渲染进程。文件名固定、可枚举，不接受任意路径：
 *
 * ```
 * eyes_happy.png   eyes_shy.png   eyes_sad.png   eyes_surprised.png   blush.png
 * ```
 *
 * 设计要点：
 * 1. **纯采样**与**加载**分离：采样函数只吃 `PixelImage`（`{width,height,data}`），
 *    因此可以在 Node 单测里用合成缓冲验证，不需要 canvas；
 * 2. 一张图可以是**单眼**（两只眼共用）或**双眼条**（宽高比 ≥ `PAIR_ASPECT`，左半给左眼、
 *    右半给右眼）；这是"官方差分图集可能是整张脸也可能是单眼"的兼容规则；
 * 3. 采样用最近邻：贴图分辨率（≈128²/眼）远大于屏幕上的眼睛（≈55 CSS px），
 *    最近邻不会糊，且结果可复现、可断言。
 */
import { unpackAlpha, unpackBlue, unpackGreen, unpackRed } from './emotion-face';
import type { EyeAssetKey } from './emotion-face';
import { BLUSH_ASSET_FILE, EYE_ASSET_FILES, EXPRESSION_FILES } from '../../shared/expression-files';

export { BLUSH_ASSET_FILE, EYE_ASSET_FILES, EXPRESSION_FILES };

/** 只读资产路由前缀（见 `src/main/shell/asset-protocol.ts`）。 */
export const EXPRESSION_ASSET_PREFIX = 'pet-asset://asset/expr';

/** 宽高比达到该值的眼型图按"双眼条"处理（左半/右半各一只眼）。 */
export const PAIR_ASPECT = 1.6;

/** 一张已解码的贴图（RGBA8，行优先，无预乘）。 */
export interface PixelImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface ExpressionAssets {
  eyes: Partial<Record<EyeAssetKey, PixelImage>>;
  blush: PixelImage | null;
  /** 加载失败/缺失的文件名（诊断与日志用；不抛异常） */
  missing: string[];
}

export type EyeCropMode = 'single' | 'pair';

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 单眼图还是双眼条：按宽高比判定。
 * 双眼条（例如官方把左右眼画在一张横条里）比值通常 ≥ 2；单眼 ≈ 1。
 */
export function resolveEyeCrop(width: number, height: number): EyeCropMode {
  if (!(width > 0) || !(height > 0)) return 'single';
  return width / height >= PAIR_ASPECT ? 'pair' : 'single';
}

/**
 * 取第 `index` 只眼（0 = 画面左半，1 = 画面右半）的裁剪矩形。
 * 单眼图两只眼都返回整张（镜像使用同一图案）。
 */
export function eyeCropRect(image: PixelImage, mode: EyeCropMode, index: 0 | 1): CropRect {
  if (mode === 'single') {
    return { x: 0, y: 0, width: image.width, height: image.height };
  }
  const half = Math.floor(image.width / 2);
  return {
    x: index === 0 ? 0 : half,
    y: 0,
    width: half,
    height: image.height,
  };
}

/** 最近邻取一个像素并打包成 0xRRGGBBAA（越界返回 0）。 */
export function samplePixelPacked(
  image: PixelImage,
  rect: CropRect,
  u: number,
  v: number,
): number {
  if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return 0;
  const x = rect.x + Math.min(rect.width - 1, Math.max(0, Math.floor(u * rect.width)));
  const y = rect.y + Math.min(rect.height - 1, Math.max(0, Math.floor(v * rect.height)));
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return 0;
  const offset = (y * image.width + x) * 4;
  const alpha = image.data[offset + 3] ?? 0;
  if (alpha <= 2) return 0;
  return (
    (((image.data[offset] ?? 0) << 24) |
      ((image.data[offset + 1] ?? 0) << 16) |
      ((image.data[offset + 2] ?? 0) << 8) |
      alpha) >>>
    0
  );
}

/** 局部坐标 → 贴图 UV（`ey = +1` 为上，贴图 y 向下）。 */
export function localToUv(lx: number, ly: number): [number, number] {
  return [(lx + 1) / 2, (1 - ly) / 2];
}

/**
 * 眼型采样：`(ex, ey)` 是眼局部坐标（`ex` 左 −1 → 右 +1，`ey` 下 −1 → 上 +1）。
 *
 * `side` 是这只眼在画面上的左右（−1 左 / +1 右），只在"双眼条"图里用于选半边；
 * 单眼图两只眼共用同一张。
 */
export function sampleEyeImagePacked(
  image: PixelImage,
  mode: EyeCropMode,
  side: -1 | 1,
  ex: number,
  ey: number,
): number {
  const rect = eyeCropRect(image, mode, side < 0 ? 0 : 1);
  const [u, v] = localToUv(ex, ey);
  const packed = samplePixelPacked(image, rect, u, v);
  if (packed === 0) return 0;
  // 保留 PNG 的 alpha：让官方差分自带的柔边/半透明能透出原贴图
  const alpha = unpackAlpha(packed);
  if (alpha <= 0.02) return 0;
  return (
    (((unpackRed(packed) & 0xff) << 24) |
      ((unpackGreen(packed) & 0xff) << 16) |
      ((unpackBlue(packed) & 0xff) << 8) |
      Math.round(Math.min(1, alpha) * 255)) >>>
    0
  );
}

/** 红晕采样：`(bx, by)` 是颊部椭圆内的归一化坐标，`strength` 是强度倍率（0..1）。 */
export function sampleBlushImagePacked(
  image: PixelImage,
  bx: number,
  by: number,
  strength = 1,
): number {
  const rect: CropRect = { x: 0, y: 0, width: image.width, height: image.height };
  const [u, v] = localToUv(bx, by);
  const packed = samplePixelPacked(image, rect, u, v);
  if (packed === 0) return 0;
  const alpha = unpackAlpha(packed) * Math.max(0, Math.min(1, strength));
  if (alpha <= 0.02) return 0;
  return (
    (((unpackRed(packed) & 0xff) << 24) |
      ((unpackGreen(packed) & 0xff) << 16) |
      ((unpackBlue(packed) & 0xff) << 8) |
      Math.round(Math.min(1, alpha) * 255)) >>>
    0
  );
}

/** 红晕强度倍率：level 1 = 轻微，level 2 = 明显。 */
export function blushStrength(level: 0 | 1 | 2): number {
  if (level <= 0) return 0;
  return level >= 2 ? 0.85 : 0.45;
}

// ---------------------------------------------------------------------------
// 加载（渲染进程内；失败一律降级，不抛）
// ---------------------------------------------------------------------------

const cache = new Map<string, PixelImage | null>();

function toPixelImage(bitmap: ImageBitmap): PixelImage | null {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(bitmap, 0, 0);
  const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  return { width: bitmap.width, height: bitmap.height, data };
}

/** 读取一张表情差分；404/解码失败返回 null（调用方降级，不抛）。 */
export async function loadExpressionImage(fileName: string): Promise<PixelImage | null> {
  const cached = cache.get(fileName);
  if (cached !== undefined) return cached;
  try {
    const response = await fetch(`${EXPRESSION_ASSET_PREFIX}/${fileName}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    const image = toPixelImage(bitmap);
    bitmap.close();
    cache.set(fileName, image);
    return image;
  } catch (error) {
    console.warn(`[render] 表情差分缺失或读取失败：${fileName}（该 emotion 降级为只变嘴型）`, error);
    cache.set(fileName, null);
    return null;
  }
}

/**
 * 载入全部表情差分。缺失的进 `missing`，其余照常返回——**任何缺失都不阻断表情系统**：
 * 缺眼型 → 该 emotion 保持默认眼；缺红晕 → 该 emotion 不叠红晕（ADR 0026 D6.4）。
 */
export async function loadExpressionAssets(): Promise<ExpressionAssets> {
  const eyes: Partial<Record<EyeAssetKey, PixelImage>> = {};
  const missing: string[] = [];

  const eyeEntries = Object.entries(EYE_ASSET_FILES) as Array<[EyeAssetKey, string]>;
  const loaded = await Promise.all(
    eyeEntries.map(async ([key, file]) => ({ key, image: await loadExpressionImage(file) })),
  );
  for (const item of loaded) {
    if (item.image) eyes[item.key] = item.image;
    else missing.push(EYE_ASSET_FILES[item.key]);
  }

  const blush = await loadExpressionImage(BLUSH_ASSET_FILE);
  if (!blush) missing.push(BLUSH_ASSET_FILE);

  console.log(
    `[render] 表情差分：eyes=${Object.keys(eyes).length}/${eyeEntries.length} ` +
      `blush=${String(Boolean(blush))} missing=${missing.join('|') || '(none)'}`,
  );

  return { eyes, blush, missing };
}
