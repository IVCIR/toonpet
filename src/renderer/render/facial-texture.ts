/**
 * 面部贴图合成（ADR 0010 D2 → ADR 0026 D3/D4 扩展）。
 *
 * 本资产（`CH0335.glb`）没有 blendshape、也没有眼睑骨：眼睛、嘴、红晕只能**改贴图**。
 * 上一版只做嘴，而且每次 `setFrame` 都清空整张 1024² 画布重绘——既浪费，也违反
 * "切换贴图不能造成整脸闪烁"。本轮（ADR 0026）改成：
 *
 * 1. `base` 画布只在创建时画一次（原贴图 + 肤色底板），之后**永不修改**；
 * 2. `live` 画布是材质真正用的那张，**只按脏矩形从 base 局部还原**，再叠本帧内容；
 * 3. 眼睛/嘴各自在一个预先栅格化好的**面空间表面**上绘制：每个贴图像素都记录了
 *    它在脸上的位置（眼局部 / 嘴局部归一化坐标），图元是在**脸的坐标系**里定义的，
 *    不是往 UV 里瞎猜；
 * 4. 材质 `map` 只在创建时换一次，之后只 `needsUpdate`——不重建贴图、不重编译材质。
 *
 * 翻转约定：glTF 贴图 `flipY = false`，因此**画布 y = v·H**（与原实现一致）；
 * `flipY = true` 的素材由 `vToPixelY` 统一处理。
 */
import * as THREE from 'three';
import {
  DEFAULT_PALETTE,
  ellipseValue,
  sampleMouthShapePacked,
  unpackAlpha,
  unpackBlue,
  unpackGreen,
  unpackRed,
} from './emotion-face';
import type { BlushLevel, FacePalette, MouthShape, SkinColor } from './emotion-face';
import {
  blushStrength,
  resolveEyeCrop,
  sampleBlushImagePacked,
  sampleEyeImagePacked,
} from './expression-assets';
import type { EyeCropMode, PixelImage } from './expression-assets';

/**
 * 眼型接受域（矩形，= 该眼三角形的面空间包围盒）。
 *
 * 注意：这里只是**画布上的裁剪范围**，不含任何"眼睛长什么样"的几何——
 * 眼型一律来自官方差分 PNG（ADR 0026 D6）。
 */
export const EYE_ACCEPT_RX = 1.02;
export const EYE_ACCEPT_RY = 0.98;

export const MOUTH_ATLAS_URL = 'pet-asset://asset/mouth';

/**
 * 图集布局（`Character_Mouth_Black-Due3Gpre.png`，1024×1024，8×8 帧）。
 *
 * `plateUv` 是 CH0335 的实测值：EyeMouth 网格里那块纯白 UV 岛
 * （u 0.0089..0.2411，v 0.7926..0.9571，glTF 原点在左上）。它不是标定猜测，
 * 而是从 UV 岛与贴图采样反推出来的；换模型必须重新标定（写进 MODULE_STATUS 坑位）。
 */
export interface MouthAtlasLayout {
  columns: number;
  rows: number;
  /** 图集里帧网格所占的归一化区域（通常整张图） */
  frameUv: { x: number; y: number; w: number; h: number };
  /** EyeMouth 贴图里的嘴部底板 UV */
  plateUv: { x: number; y: number; w: number; h: number };
  /** 图集帧是否按 alpha 内容裁边（避免整格留白把嘴画小） */
  cropToAlpha: boolean;
  /** 嘴宽占底板宽度的比例 */
  mouthWidthRatio: number;
  /** 嘴中心在底板高度的比例位置（0 = 顶边） */
  mouthCenterYRatio: number;
  /** 静态底图使用的帧号；-1 = 只刷肤色不画嘴（人工比对用） */
  staticFrameIndex: number;
}

export const CH0335_MOUTH_LAYOUT: MouthAtlasLayout = {
  columns: 8,
  rows: 8,
  frameUv: { x: 0, y: 0, w: 1, h: 1 },
  plateUv: { x: 0.0089, y: 0.7926, w: 0.2322, h: 0.1645 },
  cropToAlpha: true,
  mouthWidthRatio: 0.24,
  mouthCenterYRatio: 0.38,
  staticFrameIndex: 0,
};

/** 表情嘴型占嘴部底板的比例（比图集口型宽，才看得出"上扬/下垂"）。 */
const EMOTION_MOUTH_WIDTH_RATIO = 0.62;
const EMOTION_MOUTH_HEIGHT_RATIO = 0.72;
/** 表情嘴型在底板里的垂直中心（0 = 顶边，与 `mouthCenterYRatio` 同一口径）。 */
const EMOTION_MOUTH_CENTER_Y_RATIO = 0.42;

/** 三角形：面空间（绑定姿态，模型单位）与 UV 各三个顶点。 */
export interface UvTriangle {
  ax: number;
  ay: number;
  au: number;
  av: number;
  bx: number;
  by: number;
  bu: number;
  bv: number;
  cx: number;
  cy: number;
  cu: number;
  cv: number;
}

/** 一只眼的标定结果（面空间，模型单位）。 */
export interface EyeAnchor {
  x: number;
  y: number;
  halfWidth: number;
  halfHeight: number;
  /** 参与该眼绘制的三角形数（0 = 未标定） */
  triangles: number;
}

/** 嘴层当前状态（由调用方仲裁，通道只负责画）。 */
export type MouthLayer =
  | { kind: 'atlas'; frame: number; frameCount: number }
  | { kind: 'glyph'; shape: MouthShape }
  | { kind: 'static' };

export interface FacialTargetOptions {
  material: THREE.MeshBasicMaterial | null;
  sourceTexture: THREE.Texture | null;
  /** 该材质组的三角形（面空间 + UV），用于眼睛/嘴的面空间绘制 */
  triangles?: readonly UvTriangle[];
  /** 8× 超采样倍率（ADR 0010 D2.6） */
  supersample?: number;
  palette?: Partial<FacePalette>;
  /** 底板填充色（从 Face 贴图采样的肤色众数）；缺失时用默认肤色 */
  skinColor?: SkinColor | null;
  atlas?: CanvasImageSource | null;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 预先栅格化的"面空间表面"：只保留真正落在目标区域内的贴图像素。
 *
 * `index` 是相对 `rect` 的像素序号（`py * rect.width + px`），`lx/ly` 是该像素在
 * 面空间里的归一化坐标。每帧只需遍历这个紧凑数组，不必再扫三角形。
 */
interface FaceSurface {
  rect: Rect;
  count: number;
  index: Int32Array;
  lx: Float32Array;
  ly: Float32Array;
}

export interface FacialChannelDiagnostics {
  materialName: string | null;
  calibrated: boolean;
  hasAtlas: boolean;
  eyeCalibrated: boolean;
  eyeTriangles: number;
  mouthTriangles: number;
  eyePixels: number;
  mouthPixels: number;
  lastPaintMs: number | null;
  lastPaintPixels: number;
  eyes: EyeAnchor[];
  /**
   * 贴图内容指纹（每次重绘后更新）。
   *
   * 为什么需要：截图受 Idle 动画/视线漂移影响，"同一状态的两次截图"天然有 7% 的像素差
   * （实测噪声底 ≈6000/84864）。指纹把 64×64 缩略图做 FNV-1a，直接说明"贴图变了没有"，
   * 不受姿势影响（ADR 0026 D4.4）。
   */
  textureDigest: string | null;
  /** 当前贴图与"首次绘制基线"的平均绝对差（0..1）；恢复 neutral 时应回到 ~0 */
  faceDistance: number | null;
}

export interface FacialChannel {
  readonly materialName: string | null;
  readonly calibrated: boolean;
  readonly hasAtlas: boolean;
  readonly eyeCalibrated: boolean;
  /** 眼睛标定结果（红晕锚点由它派生） */
  readonly eyes: EyeAnchor[];
  /** 设置嘴层（口型 / 表情嘴型 / 静态闭嘴） */
  setMouth(layer: MouthLayer): void;
  /**
   * 设置眼型差分（官方表情贴图）与淡入系数。
   * `image = null` 表示保持默认眼（该 emotion 没有对应差分时的降级路径）。
   */
  setEyes(image: PixelImage | null, alpha: number): void;
  /** 按当前层状态重画（只动脏矩形）；返回覆盖的贴图像素数 */
  repaint(): number;
  /** 回到"原贴图 + 肤色底板 + 静态闭嘴" */
  clearEmotion(): void;
  /** 回到模型自带贴图 */
  reset(): void;
  dispose(): void;
  diagnostics(): FacialChannelDiagnostics;
  /** 诊断：当前眼型差分是否已加载（文件名，不参与绘制） */
  readonly eyeImageLabel: string | null;
}

export interface BlushChannel {
  readonly materialName: string | null;
  readonly calibrated: boolean;
  /** 设置红晕差分（官方半透明 PNG）与强度；`image = null` → 不叠红晕 */
  setBlush(image: PixelImage | null, level: BlushLevel, alpha: number): void;
  repaint(): number;
  clear(): void;
  reset(): void;
  dispose(): void;
  diagnostics(): FacialChannelDiagnostics;
}

/** 读取嘴型图集（只读 pet-asset 路由；失败不抛，返回 null 并告警）。 */
export async function loadMouthAtlas(url: string = MOUTH_ATLAS_URL): Promise<HTMLImageElement | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2D 上下文不可用');
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const output = new Image();
    output.src = canvas.toDataURL('image/png');
    await output.decode();
    return output;
  } catch (error) {
    console.warn('[render] 嘴型图集加载失败（表情/口型将不可用，不影响模型显示）', error);
    return null;
  }
}

interface AlphaBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 在图集的某一帧格子内按 alpha 裁出内容包围盒（避免把整格留白缩放进去）。 */
function measureAlphaBox(image: CanvasImageSource, cell: AlphaBox): AlphaBox | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(cell.w));
    canvas.height = Math.max(1, Math.round(cell.h));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, cell.x, cell.y, cell.w, cell.h, 0, 0, canvas.width, canvas.height);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        if ((data[(y * canvas.width + x) * 4 + 3] ?? 0) <= 10) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < minX || maxY < minY) return null;
    return { x: cell.x + minX, y: cell.y + minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  } catch {
    return null;
  }
}

/** 三角形 UV 质心是否落在嘴部底板矩形内（含 `grow` 外扩）——用于把嘴与眼分开。 */
export function isPlateTriangle(
  triangle: Pick<UvTriangle, 'au' | 'av' | 'bu' | 'bv' | 'cu' | 'cv'>,
  plate: { x: number; y: number; w: number; h: number },
  grow = 0.01,
): boolean {
  const u = (triangle.au + triangle.bu + triangle.cu) / 3;
  const v = (triangle.av + triangle.bv + triangle.cv) / 3;
  return (
    u >= plate.x - grow &&
    u <= plate.x + plate.w + grow &&
    v >= plate.y - grow &&
    v <= plate.y + plate.h + grow
  );
}

/** 由三角形集合求面空间包围盒；空集合返回 null。 */
export function trianglesBounds(
  triangles: readonly UvTriangle[],
): { minX: number; maxX: number; minY: number; maxY: number } | null {
  if (triangles.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const t of triangles) {
    for (const [x, y] of [
      [t.ax, t.ay],
      [t.bx, t.by],
      [t.cx, t.cy],
    ] as const) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, maxX, minY, maxY };
}

/**
 * 把"非底板"三角形按面空间 x 的符号分成左右两只眼，给出归一化锚点。
 *
 * 本资产的眼睛三角形是一片横跨双眼的虹膜圆盘 + 巩膜/眼睑条，左右眼**共用同一块
 * UV**，所以只能靠几何位置区分（ADR 0026 D2.2）；这也限制了眼型必须镜像对称。
 */
export function clusterEyes(triangles: readonly UvTriangle[]): EyeAnchor[] {
  const left: UvTriangle[] = [];
  const right: UvTriangle[] = [];
  for (const t of triangles) {
    const x = (t.ax + t.bx + t.cx) / 3;
    (x < 0 ? left : right).push(t);
  }
  const anchors: EyeAnchor[] = [];
  for (const group of [left, right]) {
    const bounds = trianglesBounds(group);
    if (!bounds || group.length < 8) continue;
    const halfWidth = Math.max(1e-9, (bounds.maxX - bounds.minX) / 2);
    const halfHeight = Math.max(1e-9, (bounds.maxY - bounds.minY) / 2);
    anchors.push({
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
      halfWidth,
      halfHeight,
      triangles: group.length,
    });
  }
  return anchors;
}

/** 由眼锚点派生颊部红晕位置（纯函数，可单测）。 */
export function deriveCheekAnchors(
  eyes: readonly EyeAnchor[],
): Array<{ x: number; y: number; rx: number; ry: number }> {
  return eyes.map((eye) => {
    // 眼包围盒包含睫毛与高光，比"可见眼型"高不少；颊部只能按半高的 3/4 往下挪，
    // 再往下就会掉出脸皮三角形（实测：按 1.9 倍半高会落到下巴以下、红晕层 0 像素）。
    const rx = eye.halfWidth * 0.55;
    return {
      x: eye.x * 1.2,
      y: eye.y - eye.halfHeight * 0.75,
      rx,
      ry: rx * 0.7,
    };
  });
}

function clampRectToCanvas(rect: Rect, width: number, height: number): Rect {
  const x = Math.max(0, Math.min(width - 1, Math.floor(rect.x)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(rect.y)));
  const right = Math.max(x + 1, Math.min(width, Math.ceil(rect.x + rect.width)));
  const bottom = Math.max(y + 1, Math.min(height, Math.ceil(rect.y + rect.height)));
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * 丢掉完全重合的表面。
 *
 * 本资产左右眼共用同一块 UV（ADR 0026 D2.2），两个眼表面覆盖的是同一批贴图像素；
 * 眼型是镜像对称的，所以画一次就够——不合并会让每次重绘的像素量翻倍。
 */
export function dedupeSurfaces(surfaces: readonly FaceSurface[]): FaceSurface[] {
  const kept: FaceSurface[] = [];
  for (const surface of surfaces) {
    const duplicate = kept.some(
      (other) =>
        other.rect.x === surface.rect.x &&
        other.rect.y === surface.rect.y &&
        other.rect.width === surface.rect.width &&
        other.rect.height === surface.rect.height &&
        other.count === surface.count,
    );
    if (!duplicate) kept.push(surface);
  }
  return kept;
}

interface SurfaceSource {
  triangles: readonly UvTriangle[];
  /** 顶点 → 像素坐标 */
  toPixel: (u: number, v: number) => [number, number];
  /** 顶点 → 该层的归一化局部坐标（每三角形线性插值） */
  toLocal: (u: number, v: number) => [number, number];
  accept?: (lx: number, ly: number) => boolean;
  bounds?: Rect | null;
}

/**
 * 把三角形栅格化成"面空间表面"。
 *
 * 用"顶点像素坐标 + 质心插值"而不是逐像素反照 UV：贴图坐标在三角形内是线性的，
 * 直接插值局部坐标即可，且能顺带按 `accept` 丢掉不需要的像素。
 */
export function buildSurface(
  source: SurfaceSource,
  canvasWidth: number,
  canvasHeight: number,
): FaceSurface | null {
  const { triangles, toPixel, toLocal, accept, bounds } = source;
  if (triangles.length === 0) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const t of triangles) {
    for (const [u, v] of [
      [t.au, t.av],
      [t.bu, t.bv],
      [t.cu, t.cv],
    ] as const) {
      const [px, py] = toPixel(u, v);
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  }
  let rect: Rect = { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
  if (bounds) {
    const left = Math.max(rect.x, bounds.x);
    const top = Math.max(rect.y, bounds.y);
    const right = Math.min(rect.x + rect.width, bounds.x + bounds.width);
    const bottom = Math.min(rect.y + rect.height, bounds.y + bounds.height);
    if (right <= left || bottom <= top) return null;
    rect = { x: left, y: top, width: right - left, height: bottom - top };
  }
  rect = clampRectToCanvas(rect, canvasWidth, canvasHeight);
  const width = rect.width;
  const height = rect.height;

  const covered = new Uint8Array(width * height);
  const localX = new Float32Array(width * height);
  const localY = new Float32Array(width * height);

  for (const t of triangles) {
    const [pax, pay] = toPixel(t.au, t.av);
    const [pbx, pby] = toPixel(t.bu, t.bv);
    const [pcx, pcy] = toPixel(t.cu, t.cv);
    const denominator = (pby - pcy) * (pax - pcx) + (pcx - pbx) * (pay - pcy);
    if (Math.abs(denominator) < 1e-9) continue;

    const [lax, lay] = toLocal(t.au, t.av);
    const [lbx, lby] = toLocal(t.bu, t.bv);
    const [lcx, lcy] = toLocal(t.cu, t.cv);

    const startX = Math.max(rect.x, Math.floor(Math.min(pax, pbx, pcx)));
    const endX = Math.min(rect.x + width - 1, Math.ceil(Math.max(pax, pbx, pcx)));
    const startY = Math.max(rect.y, Math.floor(Math.min(pay, pby, pcy)));
    const endY = Math.min(rect.y + height - 1, Math.ceil(Math.max(pay, pby, pcy)));
    if (endX < startX || endY < startY) continue;

    for (let py = startY; py <= endY; py += 1) {
      const sy = py + 0.5;
      for (let px = startX; px <= endX; px += 1) {
        const sx = px + 0.5;
        const wa = ((pby - pcy) * (sx - pcx) + (pcx - pbx) * (sy - pcy)) / denominator;
        const wb = ((pcy - pay) * (sx - pcx) + (pax - pcx) * (sy - pcy)) / denominator;
        const wc = 1 - wa - wb;
        // 留边界容差：相邻三角形的缝隙不留黑点
        if (wa < -0.03 || wb < -0.03 || wc < -0.03) continue;
        const lx = lax * wa + lbx * wb + lcx * wc;
        const ly = lay * wa + lby * wb + lcy * wc;
        if (accept && !accept(lx, ly)) continue;
        const index = (py - rect.y) * width + (px - rect.x);
        covered[index] = 1;
        localX[index] = lx;
        localY[index] = ly;
      }
    }
  }

  let count = 0;
  for (let i = 0; i < covered.length; i += 1) if (covered[i]) count += 1;
  if (count === 0) return null;

  const index = new Int32Array(count);
  const lx = new Float32Array(count);
  const ly = new Float32Array(count);
  let cursor = 0;
  for (let i = 0; i < covered.length; i += 1) {
    if (!covered[i]) continue;
    index[cursor] = i;
    lx[cursor] = localX[i]!;
    ly[cursor] = localY[i]!;
    cursor += 1;
  }
  return { rect, count, index, lx, ly };
}

/** 把一个打包颜色（0xRRGGBBAA）混进像素；`packed = 0` 表示不画。 */
function blendPixel(data: Uint8ClampedArray, offset: number, packed: number, alpha: number): void {
  if (packed === 0) return;
  const a = Math.max(0, Math.min(1, unpackAlpha(packed) * alpha));
  if (a <= 0.001) return;
  const inverse = 1 - a;
  data[offset] = unpackRed(packed) * a + (data[offset] ?? 0) * inverse;
  data[offset + 1] = unpackGreen(packed) * a + (data[offset + 1] ?? 0) * inverse;
  data[offset + 2] = unpackBlue(packed) * a + (data[offset + 2] ?? 0) * inverse;
  data[offset + 3] = Math.max(data[offset + 3] ?? 255, Math.round(255 * a));
}

/**
 * 在表面上绘制一层；返回覆盖的像素数。
 *
 * 采样函数返回**打包整数**（0 = 不画）：一张 1024² 贴图一次约 50 万像素，
 * 若每像素返回 `{r,g,b,a}` 对象会触发大量 GC 并让一次重绘卡到 100ms（ADR 0026 D4.2）。
 */
function paintSurface(
  surface: FaceSurface,
  context: CanvasRenderingContext2D,
  alpha: number,
  sample: (lx: number, ly: number) => number,
): number {
  if (alpha <= 0.001) return 0;
  const image = context.getImageData(
    surface.rect.x,
    surface.rect.y,
    surface.rect.width,
    surface.rect.height,
  );
  const data = image.data;
  let painted = 0;
  for (let i = 0; i < surface.count; i += 1) {
    const packed = sample(surface.lx[i]!, surface.ly[i]!);
    if (packed === 0) continue;
    blendPixel(data, surface.index[i]! * 4, packed, alpha);
    painted += 1;
  }
  if (painted > 0) context.putImageData(image, surface.rect.x, surface.rect.y);
  return painted;
}

/** 贴图缩略图边长（64² 的热路径开销 ≈1ms，足够捕捉眼/嘴/红晕的任何变化）。 */
const DIGEST_SIZE = 64;

function createDigestScratch(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = DIGEST_SIZE;
  canvas.height = DIGEST_SIZE;
  return canvas;
}

/** 把整张贴图缩到 64×64 读回（每个缩略图像素是 16×16 texel 的均值）。 */
function sampleThumbnail(
  canvas: HTMLCanvasElement,
  scratch: HTMLCanvasElement,
): Uint8ClampedArray | null {
  const context = scratch.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.clearRect(0, 0, DIGEST_SIZE, DIGEST_SIZE);
  context.drawImage(canvas, 0, 0, DIGEST_SIZE, DIGEST_SIZE);
  return context.getImageData(0, 0, DIGEST_SIZE, DIGEST_SIZE).data;
}

/** FNV-1a：缩略图指纹（跨进程可比、日志友好）。 */
function digestOf(data: Uint8ClampedArray): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i += 1) {
    hash ^= data[i]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * 与基线的平均绝对差（0..1）。
 *
 * 为什么不用"指纹相等"判断恢复：还原是按脏矩形 `drawImage` 回来的，矩形边界会有
 * 1 texel 的抗锯齿差异——指纹会变，但画面上看不出来。平均绝对差把这种边界噪声
 * 摊薄到 0.1% 量级，同时保留"整只眼没还原"这种 1–2% 量级的真实差异（ADR 0026 D4.4）。
 */
function meanAbsDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let total = 0;
  for (let i = 0; i < length; i += 1) total += Math.abs(a[i]! - b[i]!);
  return total / length / 255;
}

/** 把一块矩形从 `base` 原样还原到 `live`（局部还原，不清整张脸）。 */
function restoreRect(context: CanvasRenderingContext2D, base: CanvasImageSource, rect: Rect): void {
  context.clearRect(rect.x, rect.y, rect.width, rect.height);
  context.drawImage(
    base,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
  );
}

interface CanvasPair {
  live: HTMLCanvasElement;
  liveContext: CanvasRenderingContext2D;
  base: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
}

/** 一块矩形区域的原始像素快照（还原时 `putImageData` 写回，边界零误差）。 */
interface Baseline {
  rect: Rect;
  image: ImageData;
}

/** 快照：只在创建时采一次，之后永不更新。 */
function captureBaseline(context: CanvasRenderingContext2D, rect: Rect): Baseline | null {
  try {
    return {
      rect,
      image: context.getImageData(rect.x, rect.y, rect.width, rect.height),
    };
  } catch {
    return null;
  }
}

/**
 * 还原：把快照原样写回。
 *
 * 为什么不用 `drawImage` 从 base 拷贝：拷贝在矩形边界会与相邻像素做插值，
 * 留下 1 texel 的抗锯齿差——指纹会变、画面上看不出来，但"完全还原"就无法断言
 * （ADR 0026 D6.3）。`putImageData` 是逐像素覆盖，不做混合。
 */
function restoreBaseline(context: CanvasRenderingContext2D, baseline: Baseline): void {
  context.putImageData(baseline.image, baseline.rect.x, baseline.rect.y);
}

/** 眼型缓存键：按对象身份 + 裁剪模式（同一张图换 emotion 时不必重画层）。 */
const eyeIdentity = new WeakMap<PixelImage, number>();
let eyeIdentitySeq = 0;

function eyeLayerKeyOf(image: PixelImage): number {
  const existing = eyeIdentity.get(image);
  if (existing !== undefined) return existing;
  const next = (eyeIdentitySeq += 1);
  eyeIdentity.set(image, next);
  return next;
}

function createCanvasPair(source: THREE.Texture, supersample: number): CanvasPair | null {
  const image = source.image as (CanvasImageSource & { width?: number; height?: number }) | undefined;
  if (!image) return null;
  const width = Math.max(1, image.width ?? 128);
  const height = Math.max(1, image.height ?? 128);

  const base = document.createElement('canvas');
  base.width = width * supersample;
  base.height = height * supersample;
  const baseContext = base.getContext('2d');
  if (!baseContext) return null;

  const live = document.createElement('canvas');
  live.width = base.width;
  live.height = base.height;
  const liveContext = live.getContext('2d', { willReadFrequently: true });
  if (!liveContext) return null;

  baseContext.imageSmoothingEnabled = true;
  baseContext.drawImage(image, 0, 0, base.width, base.height);
  liveContext.imageSmoothingEnabled = true;
  liveContext.drawImage(base, 0, 0);

  const texture = new THREE.CanvasTexture(live);
  texture.colorSpace = source.colorSpace;
  texture.flipY = source.flipY;
  texture.needsUpdate = true;

  return { live, liveContext, base, texture };
}

function resolvePalette(options: FacialTargetOptions): FacePalette {
  const skin = options.skinColor ?? options.palette?.skin ?? DEFAULT_PALETTE.skin;
  return { ...DEFAULT_PALETTE, ...(options.palette ?? {}), skin };
}

/**
 * 1%/99% 分位区间（用 256 桶直方图，O(n) 且不需要排序）。
 * 用来把局部坐标按"真实被覆盖的像素分布"归一化，避免包围盒里的空白把图元挤到一边。
 *
 * 两个坑（都实测踩过）：
 * - 不能用 `low === min` 当"还没赋值"的哨兵：直方图第一桶通常就超过 1%，
 *   于是 low 会被一路覆盖到接近 high，区间塌成一个点、归一化后绝大多数像素落到 [-1,1] 外
 *   （表现是表情贴图只在眼睛上画出一小块碎片）；
 * - 高侧要从右往左累加，不能与低侧共用同一个循环。
 */
export function percentileRange(
  values: Float32Array,
  covered: Uint8Array,
): [number, number] | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let total = 0;
  for (let i = 0; i < covered.length; i += 1) {
    if (!covered[i]) continue;
    const value = values[i]!;
    if (value < min) min = value;
    if (value > max) max = value;
    total += 1;
  }
  if (total === 0 || !Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (max - min < 1e-9) return [min, max];

  const BINS = 256;
  const bins = new Uint32Array(BINS);
  const scale = (BINS - 1) / (max - min);
  for (let i = 0; i < covered.length; i += 1) {
    if (!covered[i]) continue;
    const bin = Math.min(BINS - 1, Math.max(0, Math.round((values[i]! - min) * scale)));
    bins[bin] = (bins[bin] ?? 0) + 1;
  }

  const tail = Math.max(1, Math.round(total * 0.01));
  let low = min;
  let accumulated = 0;
  for (let bin = 0; bin < BINS; bin += 1) {
    accumulated += bins[bin] ?? 0;
    if (accumulated >= tail) {
      low = min + bin / scale;
      break;
    }
  }
  let high = max;
  accumulated = 0;
  for (let bin = BINS - 1; bin >= 0; bin -= 1) {
    accumulated += bins[bin] ?? 0;
    if (accumulated >= tail) {
      high = min + bin / scale;
      break;
    }
  }
  if (!(high > low)) return [min, max];
  return [low, high];
}

/**
 * 把一个三角形集合栅格化成"面空间表面"：像素的局部坐标由**顶点面空间坐标**插值，
 * 与 UV 无关。这是"在脸上画画"的关键——UV 到面空间的映射是弯的（本资产的脸是曲面），
 * 只有逐三角形重心插值才是精确的（ADR 0026 D2.2）。
 */
function rasterizeFaceLocal(options: {
  triangles: readonly UvTriangle[];
  toPixel: (u: number, v: number) => [number, number];
  center: { x: number; y: number };
  scale: { x: number; y: number };
  accept: (lx: number, ly: number) => boolean;
  canvasWidth: number;
  canvasHeight: number;
  /** 是否按"实际覆盖像素的 1%/99% 分位"重新归一化（眼睛需要，颊部不需要） */
  normalize?: boolean;
}): FaceSurface | null {
  const { triangles, toPixel, center, scale, accept, canvasWidth, canvasHeight } = options;
  if (triangles.length === 0) return null;
  const sx = Math.max(1e-12, scale.x);
  const sy = Math.max(1e-12, scale.y);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const t of triangles) {
    for (const [u, v] of [
      [t.au, t.av],
      [t.bu, t.bv],
      [t.cu, t.cv],
    ] as const) {
      const [px, py] = toPixel(u, v);
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  }
  const rect = clampRectToCanvas(
    { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) },
    canvasWidth,
    canvasHeight,
  );
  const covered = new Uint8Array(rect.width * rect.height);
  const localX = new Float32Array(rect.width * rect.height);
  const localY = new Float32Array(rect.width * rect.height);

  for (const t of triangles) {
    const [pax, pay] = toPixel(t.au, t.av);
    const [pbx, pby] = toPixel(t.bu, t.bv);
    const [pcx, pcy] = toPixel(t.cu, t.cv);
    const denominator = (pby - pcy) * (pax - pcx) + (pcx - pbx) * (pay - pcy);
    if (Math.abs(denominator) < 1e-9) continue;

    const lax = (t.ax - center.x) / sx;
    const lay = (t.ay - center.y) / sy;
    const lbx = (t.bx - center.x) / sx;
    const lby = (t.by - center.y) / sy;
    const lcx = (t.cx - center.x) / sx;
    const lcy = (t.cy - center.y) / sy;

    const startX = Math.max(rect.x, Math.floor(Math.min(pax, pbx, pcx)));
    const endX = Math.min(rect.x + rect.width - 1, Math.ceil(Math.max(pax, pbx, pcx)));
    const startY = Math.max(rect.y, Math.floor(Math.min(pay, pby, pcy)));
    const endY = Math.min(rect.y + rect.height - 1, Math.ceil(Math.max(pay, pby, pcy)));
    if (endX < startX || endY < startY) continue;

    for (let py = startY; py <= endY; py += 1) {
      const y = py + 0.5;
      for (let px = startX; px <= endX; px += 1) {
        const x = px + 0.5;
        const wa = ((pby - pcy) * (x - pcx) + (pcx - pbx) * (y - pcy)) / denominator;
        const wb = ((pcy - pay) * (x - pcx) + (pax - pcx) * (y - pcy)) / denominator;
        const wc = 1 - wa - wb;
        // 留边界容差：相邻三角形的缝隙不留黑点
        if (wa < -0.03 || wb < -0.03 || wc < -0.03) continue;
        const lx = lax * wa + lbx * wb + lcx * wc;
        const ly = lay * wa + lby * wb + lcy * wc;
        if (!accept(lx, ly)) continue;
        const index = (py - rect.y) * rect.width + (px - rect.x);
        covered[index] = 1;
        localX[index] = lx;
        localY[index] = ly;
      }
    }
  }

  let count = 0;
  for (let i = 0; i < covered.length; i += 1) if (covered[i]) count += 1;
  if (count === 0) return null;

  // 自标定：把局部坐标按"实际被三角形覆盖的像素分布"重新归一化。
  //
  // 为什么必须做：眼的包围盒包含睫毛/高光条，而虹膜画片占的 UV 面积巨大且集中在
  // 包围盒的偏下位置。直接按包围盒归一化时，"上半眼睑"只命中极少数贴图像素——
  // 实测 `squint`（眯眼）与 `droop`（下垂）几乎画不出任何变化（贴图平均差 <0.2%），
  // 而 `closed-arc` / `wide`（整只眼重画）正常。按像素分布归一化后两者都落在
  // 真实可见的眼部区域上（ADR 0026 D2.2 的标定修正）。
  if (options.normalize !== false) {
    const rangeX = percentileRange(localX, covered);
    const rangeY = percentileRange(localY, covered);
    if (rangeX && rangeY) {
      const midX = (rangeX[0] + rangeX[1]) / 2;
      const halfX = Math.max(1e-6, (rangeX[1] - rangeX[0]) / 2);
      const midY = (rangeY[0] + rangeY[1]) / 2;
      const halfY = Math.max(1e-6, (rangeY[1] - rangeY[0]) / 2);
      for (let i = 0; i < covered.length; i += 1) {
        if (!covered[i]) continue;
        // 归一化到 [-1,1] 后**夹取**而不是丢弃：1%/99% 之外的 ~2% 像素若被丢掉，
        // 眼区边缘就留一圈没有覆盖的原虹膜，实机看起来是一圈"幽灵眼环"。
        const nx = Math.max(-1, Math.min(1, (localX[i]! - midX) / halfX));
        const ny = Math.max(-1, Math.min(1, (localY[i]! - midY) / halfY));
        if (!accept(nx, ny)) {
          covered[i] = 0;
          count -= 1;
          continue;
        }
        localX[i] = nx;
        localY[i] = ny;
      }
      if (count === 0) return null;
    }
  }

  const index = new Int32Array(count);
  const lx = new Float32Array(count);
  const ly = new Float32Array(count);
  let cursor = 0;
  for (let i = 0; i < covered.length; i += 1) {
    if (!covered[i]) continue;
    index[cursor] = i;
    lx[cursor] = localX[i]!;
    ly[cursor] = localY[i]!;
    cursor += 1;
  }
  return { rect, count, index, lx, ly };
}

/**
 * 创建嘴部贴图通道（同时承载眼型与表情嘴型）。
 *
 * 未标定（缺材质/缺原贴图/缺三角形）时所有绘制方法都是空操作并记一条 WARN：
 * 契约 §11 要求"表情缺失 → 表情不生效，动作正常"。
 */
export function createFacialChannel(options: FacialTargetOptions): FacialChannel {
  const material = options.material;
  const source = options.sourceTexture;
  const triangles = options.triangles ?? [];
  const layout = CH0335_MOUTH_LAYOUT;
  const palette = resolvePalette(options);
  const supersample = options.supersample ?? 8;
  const originalMap = material?.map ?? null;

  const materialName = material?.name ?? null;
  const calibrated = Boolean(material && source && triangles.length > 0);

  const plateTriangles = triangles.filter((t) => isPlateTriangle(t, layout.plateUv));
  const eyeTriangles = triangles.filter((t) => !isPlateTriangle(t, layout.plateUv));
  const eyes = clusterEyes(eyeTriangles);
  const eyeCalibrated = eyes.length === 2;

  let pair: CanvasPair | null = null;
  /**
   * 眼睛单独画在一张透明层上，再按 `alpha` 合成到 `live`。
   *
   * 为什么：眼睛占的贴图像素数约 52 万（虹膜 UV 岛很大），逐像素重绘一次 ~40ms；
   * 淡入要重绘 6 次，直接画在 live 上会卡掉 0.24s。分层后每种眼型只渲染一次，
   * 淡入的每一步只是 `drawImage` + `globalAlpha`（毫秒级，ADR 0026 D4.3）。
   */
  let eyeLayer: HTMLCanvasElement | null = null;
  let eyeLayerContext: CanvasRenderingContext2D | null = null;
  /** 眼睛层当前缓存的是哪张差分（`对象身份|裁剪模式`；null = 层是空的） */
  let eyeLayerKey: string | null = null;
  let eyeSurfaces: FaceSurface[] = [];
  let mouthSurface: FaceSurface | null = null;
  let plateRect: Rect | null = null;
  /** 眼区 / 嘴部底板的**原始像素快照**：还原时直接 putImageData，边界零误差 */
  let eyeBaselines: Baseline[] = [];
  let plateBaseline: Baseline | null = null;
  let warned = false;
  let lastPaintMs: number | null = null;
  let lastPaintPixels = 0;
  let digestScratch: HTMLCanvasElement | null = null;
  let textureDigest: string | null = null;
  /** 首次绘制后的缩略图（基线）：faceDistance 的参照 */
  let baselineThumb: Uint8ClampedArray | null = null;
  let faceDistance: number | null = null;

  let mouthLayer: MouthLayer = { kind: 'static' };
  /** 当前眼型差分（null = 保持默认眼） */
  let eyeImage: PixelImage | null = null;
  let eyeMode: EyeCropMode = 'single';
  let eyeAlpha = 0;
  /** 上一次重画是否画了眼睛（决定本帧是否需要还原眼区） */
  let eyePainted = false;

  function ensure(): boolean {
    if (!material || !source) return false;
    if (pair) return true;
    const created = createCanvasPair(source, supersample);
    if (!created) return false;
    pair = created;
    material.map = created.texture;
    material.needsUpdate = true;

    const width = created.live.width;
    const height = created.live.height;
    const flipY = created.texture.flipY;
    const toPixel = (u: number, v: number): [number, number] => [
      u * width,
      (flipY ? 1 - v : v) * height,
    ];

    // ---- 眼睛表面：左右眼各一个（UV 可能重叠，各自独立栅格化） ----
    if (eyeCalibrated) {
      eyeSurfaces = dedupeSurfaces(
        buildEyeSurfaces(eyeTriangles, eyes, toPixel, width, height),
      );
      eyeLayer = document.createElement('canvas');
      eyeLayer.width = width;
      eyeLayer.height = height;
      eyeLayerContext = eyeLayer.getContext('2d', { willReadFrequently: true });
    }

    // ---- 嘴表面：表情嘴型（图集口型仍走 drawImage） ----
    const plate = {
      x: layout.plateUv.x * width,
      y: layout.plateUv.y * height,
      w: layout.plateUv.w * width,
      h: layout.plateUv.h * height,
    };
    const bleed = 2 * supersample;
    plateRect = clampRectToCanvas(
      { x: plate.x - bleed, y: plate.y - bleed, width: plate.w + bleed * 2, height: plate.h + bleed * 2 },
      width,
      height,
    );

    if (plateTriangles.length > 0) {
      const mouthW = plate.w * EMOTION_MOUTH_WIDTH_RATIO;
      const mouthH = plate.h * EMOTION_MOUTH_HEIGHT_RATIO;
      const mouthX = plate.x + (plate.w - mouthW) / 2;
      const mouthY = plate.y + plate.h * EMOTION_MOUTH_CENTER_Y_RATIO - mouthH / 2;
      mouthSurface = buildSurface(
        {
          triangles: plateTriangles,
          toPixel,
          toLocal: (u, v) => {
            const [px, py] = toPixel(u, v);
            return [
              (px - (mouthX + mouthW / 2)) / (mouthW / 2),
              (mouthY + mouthH / 2 - py) / (mouthH / 2),
            ];
          },
          bounds: { x: mouthX, y: mouthY, width: mouthW, height: mouthH },
        },
        width,
        height,
      );
    }

    // ---- 原始像素快照（此时 live 与 base 完全一致，尚未画过任何东西） ----
    eyeBaselines = eyeSurfaces
      .map((surface) => captureBaseline(created.liveContext, surface.rect))
      .filter((item): item is Baseline => item !== null);
    plateBaseline = plateRect ? captureBaseline(created.liveContext, plateRect) : null;

    console.log(
      `[render] 面部贴图通道已就绪 material=${String(materialName)} ` +
        `calibrated=${String(calibrated)} eyes=${String(eyeCalibrated)} ` +
        `eyeTri=${eyeTriangles.length} plateTri=${plateTriangles.length} ` +
        `eyePixels=${eyeSurfaces.reduce((sum, s) => sum + s.count, 0)} ` +
        `mouthPixels=${mouthSurface?.count ?? 0}`,
    );
    return true;
  }

  /** 眼表面：局部坐标由**面空间**给出（顶点位置线性插值），而不是 UV。 */
  function buildEyeSurfaces(
    candidates: readonly UvTriangle[],
    anchors: readonly EyeAnchor[],
    toPixel: (u: number, v: number) => [number, number],
    width: number,
    height: number,
  ): FaceSurface[] {
    const surfaces: FaceSurface[] = [];
    for (const eye of anchors) {
      const group = candidates.filter((t) => {
        const x = (t.ax + t.bx + t.cx) / 3;
        return (x < 0) === (eye.x < 0);
      });
      if (group.length === 0) continue;
      const surface = rasterizeFaceLocal({
        triangles: group,
        toPixel,
        center: eye,
        scale: { x: eye.halfWidth, y: eye.halfHeight },
        // 接受域 = 矩形（眼包围盒）：椭圆会在四角留下原虹膜的"幽灵眼环"
        accept: (lx, ly) =>
          lx >= -EYE_ACCEPT_RX && lx <= EYE_ACCEPT_RX && ly >= -EYE_ACCEPT_RY && ly <= EYE_ACCEPT_RY,
        canvasWidth: width,
        canvasHeight: height,
      });
      if (surface) surfaces.push(surface);
    }
    return surfaces;
  }

  /** 底板：还原原始像素 + 刷肤色（遮掉资产里的白块，ADR 0010 D2.5）。 */
  function paintPlate(): void {
    if (!pair || !plateRect) return;
    if (plateBaseline) {
      restoreBaseline(pair.liveContext, plateBaseline);
    } else {
      restoreRect(pair.liveContext, pair.base, plateRect);
    }
    pair.liveContext.fillStyle = `rgb(${palette.skin.r}, ${palette.skin.g}, ${palette.skin.b})`;
    pair.liveContext.fillRect(plateRect.x, plateRect.y, plateRect.width, plateRect.height);
  }

  function drawAtlasFrame(frameIndex: number, frameCount: number): void {
    if (!pair || !plateRect || !options.atlas) return;
    const atlas = options.atlas as HTMLImageElement;
    if (!atlas.width || !atlas.height) return;
    const width = pair.live.width;
    const height = pair.live.height;
    const plate = {
      x: layout.plateUv.x * width,
      y: layout.plateUv.y * height,
      w: layout.plateUv.w * width,
      h: layout.plateUv.h * height,
    };
    const count = Math.max(1, Math.min(frameCount, layout.columns * layout.rows));
    const index = Math.max(0, Math.min(frameIndex, count - 1));
    const column = index % layout.columns;
    const row = Math.floor(index / layout.columns);
    const cellW = (layout.frameUv.w * atlas.width) / layout.columns;
    const cellH = (layout.frameUv.h * atlas.height) / layout.rows;
    const cell: AlphaBox = {
      x: layout.frameUv.x * atlas.width + column * cellW,
      y: layout.frameUv.y * atlas.height + row * cellH,
      w: cellW,
      h: cellH,
    };
    const box = layout.cropToAlpha ? measureAlphaBox(atlas, cell) ?? cell : cell;
    const targetW = plate.w * layout.mouthWidthRatio;
    const targetH = targetW * (box.h / box.w);
    const targetX = plate.x + (plate.w - targetW) / 2;
    const targetY = plate.y + plate.h * layout.mouthCenterYRatio - targetH / 2;
    pair.liveContext.drawImage(atlas, box.x, box.y, box.w, box.h, targetX, targetY, targetW, targetH);
  }

  /**
   * 把当前眼型差分合成到眼睛层（同一张图只做一次，约 40ms）。
   *
   * 层是透明的：图片 alpha 为 0 的像素保持透明，合成时露出原贴图。
   * **左右眼共用同一块 UV**（ADR 0026 的资产事实），所以这里统一用 `side = -1`
   * 采样（双眼条图取左半）；单眼图两只眼共用同一张，不受影响。
   */
  function renderEyeLayer(image: PixelImage, mode: EyeCropMode): void {
    if (!eyeLayer || !eyeLayerContext) return;
    for (const surface of eyeSurfaces) {
      eyeLayerContext.clearRect(surface.rect.x, surface.rect.y, surface.rect.width, surface.rect.height);
    }
    for (const surface of eyeSurfaces) {
      paintSurface(surface, eyeLayerContext, 1, (lx, ly) =>
        sampleEyeImagePacked(image, mode, -1, lx, ly),
      );
    }
  }

  function repaint(): number {
    if (!ensure() || !pair) {
      if (!warned) {
        warned = true;
        console.warn('[render] 面部贴图通道未标定：口型/表情绘制为空操作（ADR 0026 D4）');
      }
      return 0;
    }
    const startedAt = performance.now();
    let painted = 0;

    // 1) 还原上一次画过的眼区：用初始化时快照的 **ImageData** 直接写回，
    //    不用 drawImage 从 base 拷贝——那样矩形边界会留 1 texel 的抗锯齿差（ADR 0026 D6.3）。
    if (eyePainted) {
      for (const baseline of eyeBaselines) {
        restoreBaseline(pair.liveContext, baseline);
        painted += baseline.rect.width * baseline.rect.height;
      }
      eyePainted = false;
    }

    // 2) 嘴：底板 + 图集帧 / 表情嘴型 / 静态闭嘴
    paintPlate();
    if (mouthLayer.kind === 'atlas') {
      drawAtlasFrame(mouthLayer.frame, mouthLayer.frameCount);
    } else if (mouthLayer.kind === 'glyph') {
      if (mouthSurface) {
        const aspect = EMOTION_MOUTH_WIDTH_RATIO / EMOTION_MOUTH_HEIGHT_RATIO;
        const shape = mouthLayer.shape;
        painted += paintSurface(mouthSurface, pair.liveContext, 1, (lx, ly) =>
          sampleMouthShapePacked(shape, lx, ly, palette, aspect),
        );
      }
    } else {
      drawAtlasFrame(layout.staticFrameIndex, 1);
    }

    // 3) 眼型：官方差分 → 眼睛层缓存 → 按 alpha 合成（淡入每一步都是毫秒级）
    if (eyeCalibrated && eyeImage && eyeAlpha > 0.001) {
      const key = `${eyeLayerKeyOf(eyeImage)}|${eyeMode}`;
      if (eyeLayerKey !== key) {
        renderEyeLayer(eyeImage, eyeMode);
        eyeLayerKey = key;
      }
      if (eyeLayer && eyeLayerContext) {
        pair.liveContext.save();
        pair.liveContext.globalAlpha = eyeAlpha;
        for (const surface of eyeSurfaces) {
          pair.liveContext.drawImage(
            eyeLayer,
            surface.rect.x,
            surface.rect.y,
            surface.rect.width,
            surface.rect.height,
            surface.rect.x,
            surface.rect.y,
            surface.rect.width,
            surface.rect.height,
          );
          painted += surface.count;
        }
        pair.liveContext.restore();
      }
      eyePainted = true;
    } else if (eyeLayerKey !== null && eyeLayerContext) {
      // 眼型清空：层不再需要，下次重绘从基线快照还原即可
      for (const surface of eyeSurfaces) {
        eyeLayerContext.clearRect(surface.rect.x, surface.rect.y, surface.rect.width, surface.rect.height);
      }
      eyeLayerKey = null;
    }

    pair.texture.needsUpdate = true;
    lastPaintPixels = painted;
    lastPaintMs = performance.now() - startedAt;
    digestScratch = digestScratch ?? createDigestScratch();
    const thumb = sampleThumbnail(pair.live, digestScratch);
    if (thumb) {
      baselineThumb = baselineThumb ?? thumb.slice();
      textureDigest = digestOf(thumb);
      faceDistance = meanAbsDiff(thumb, baselineThumb);
    }
    return painted;
  }

  // 创建即落静态底图
  if (material && source && ensure()) repaint();

  return {
    materialName,
    calibrated,
    hasAtlas: Boolean(options.atlas),
    eyeCalibrated,
    eyes,
    get eyeImageLabel(): string | null {
      return eyeImage ? `${eyeImage.width}x${eyeImage.height}/${eyeMode}` : null;
    },
    setMouth(layer: MouthLayer): void {
      mouthLayer = layer;
    },
    setEyes(image: PixelImage | null, alpha: number): void {
      eyeImage = image;
      eyeMode = image ? resolveEyeCrop(image.width, image.height) : 'single';
      eyeAlpha = Math.max(0, Math.min(1, alpha));
    },
    repaint,
    clearEmotion(): void {
      mouthLayer = { kind: 'static' };
      eyeImage = null;
      eyeMode = 'single';
      eyeAlpha = 0;
      repaint();
    },
    reset(): void {
      if (!material) return;
      material.map = originalMap;
      material.needsUpdate = true;
    },
    dispose(): void {
      this.reset();
      pair?.texture.dispose();
      pair = null;
      eyeSurfaces = [];
      eyeBaselines = [];
      plateBaseline = null;
      mouthSurface = null;
    },
    diagnostics(): FacialChannelDiagnostics {
      return {
        materialName,
        calibrated,
        hasAtlas: Boolean(options.atlas),
        eyeCalibrated,
        eyeTriangles: eyeTriangles.length,
        mouthTriangles: plateTriangles.length,
        eyePixels: eyeSurfaces.reduce((sum, s) => sum + s.count, 0),
        mouthPixels: mouthSurface?.count ?? 0,
        lastPaintMs,
        lastPaintPixels,
        eyes,
        textureDigest,
        faceDistance,
      };
    },
  };
}

/**
 * 红晕通道：作用在 `Face`（脸皮）材质上——与眼睛/嘴**不是同一张贴图**。
 *
 * 与嘴通道同一套"局部还原 + 表面绘制"，只有一层；`level = 0` 时只做还原。
 */
export function createBlushChannel(
  options: FacialTargetOptions & { eyes: readonly EyeAnchor[] },
): BlushChannel {
  const material = options.material;
  const source = options.sourceTexture;
  const triangles = options.triangles ?? [];
  const cheeks = deriveCheekAnchors(options.eyes);
  const palette = resolvePalette(options);
  const supersample = options.supersample ?? 8;
  const originalMap = material?.map ?? null;
  const materialName = material?.name ?? null;

  let pair: CanvasPair | null = null;
  let surfaces: FaceSurface[] = [];
  /** 红晕差分（官方半透明 PNG）；null = 不叠红晕 */
  let blushImage: PixelImage | null = null;
  let level: BlushLevel = 0;
  let alpha = 0;
  /** 颊部原始像素快照（与眼睛同理：putImageData 精确还原） */
  let baselines: Baseline[] = [];
  let lastPaintMs: number | null = null;
  let lastPaintPixels = 0;
  let digestScratch: HTMLCanvasElement | null = null;
  let textureDigest: string | null = null;
  /** 首次绘制后的缩略图（基线）：faceDistance 的参照 */
  let baselineThumb: Uint8ClampedArray | null = null;
  let faceDistance: number | null = null;

  const calibrated = Boolean(material && source && triangles.length > 0 && cheeks.length > 0);

  function ensure(): boolean {
    if (!material || !source || cheeks.length === 0) return false;
    if (pair) return true;
    const created = createCanvasPair(source, supersample);
    if (!created) return false;
    pair = created;
    material.map = created.texture;
    material.needsUpdate = true;

    const width = created.live.width;
    const height = created.live.height;
    const flipY = created.texture.flipY;
    const toPixel = (u: number, v: number): [number, number] => [
      u * width,
      (flipY ? 1 - v : v) * height,
    ];

    // 只保留颊部附近的三角形：Face 材质同时被手/腿使用，不筛会扫到全身
    const minX = Math.min(...cheeks.map((c) => c.x - c.rx));
    const maxX = Math.max(...cheeks.map((c) => c.x + c.rx));
    const minY = Math.min(...cheeks.map((c) => c.y - c.ry));
    const maxY = Math.max(...cheeks.map((c) => c.y + c.ry));
    const local = triangles.filter((t) => {
      const xs = [t.ax, t.bx, t.cx];
      const ys = [t.ay, t.by, t.cy];
      return (
        Math.max(...xs) >= minX &&
        Math.min(...xs) <= maxX &&
        Math.max(...ys) >= minY &&
        Math.min(...ys) <= maxY
      );
    });

    surfaces = [];
    for (const cheek of cheeks) {
      const surface = rasterizeFaceLocal({
        triangles: local,
        toPixel,
        center: cheek,
        scale: { x: cheek.rx, y: cheek.ry },
        accept: (lx, ly) => lx * lx + ly * ly <= 1,
        canvasWidth: width,
        canvasHeight: height,
      });
      if (surface) surfaces.push(surface);
    }
    // 原始像素快照：红晕层同样用 putImageData 精确还原
    baselines = surfaces
      .map((surface) => captureBaseline(created.liveContext, surface.rect))
      .filter((item): item is Baseline => item !== null);
    console.log(
      `[render] 红晕通道已就绪 material=${String(materialName)} cheeks=${cheeks.length} ` +
        `tris=${local.length} pixels=${surfaces.reduce((sum, s) => sum + s.count, 0)}`,
    );
    return true;
  }

  function repaint(): number {
    if (!ensure() || !pair) return 0;
    const startedAt = performance.now();
    let painted = 0;
    const strength = blushStrength(level) * alpha;
    const image = blushImage;
    for (let i = 0; i < surfaces.length; i += 1) {
      const surface = surfaces[i]!;
      const baseline = baselines[i];
      if (baseline) restoreBaseline(pair.liveContext, baseline);
      else restoreRect(pair.liveContext, pair.base, surface.rect);
      painted += surface.rect.width * surface.rect.height;
      if (image && strength > 0.001) {
        painted += paintSurface(surface, pair.liveContext, 1, (lx, ly) =>
          sampleBlushImagePacked(image, lx, ly, strength),
        );
      }
    }
    pair.texture.needsUpdate = true;
    lastPaintPixels = painted;
    lastPaintMs = performance.now() - startedAt;
    digestScratch = digestScratch ?? createDigestScratch();
    const thumb = sampleThumbnail(pair.live, digestScratch);
    if (thumb) {
      baselineThumb = baselineThumb ?? thumb.slice();
      textureDigest = digestOf(thumb);
      faceDistance = meanAbsDiff(thumb, baselineThumb);
    }
    return painted;
  }

  if (material && source && cheeks.length > 0 && ensure()) repaint();

  return {
    materialName,
    calibrated,
    setBlush(image: PixelImage | null, next: BlushLevel, nextAlpha: number): void {
      blushImage = image;
      level = next;
      alpha = Math.max(0, Math.min(1, nextAlpha));
    },
    repaint,
    clear(): void {
      blushImage = null;
      level = 0;
      alpha = 0;
      repaint();
    },
    reset(): void {
      if (!material) return;
      material.map = originalMap;
      material.needsUpdate = true;
    },
    dispose(): void {
      this.reset();
      pair?.texture.dispose();
      pair = null;
      surfaces = [];
      baselines = [];
    },
    diagnostics(): FacialChannelDiagnostics {
      return {
        materialName,
        calibrated,
        hasAtlas: false,
        eyeCalibrated: false,
        eyeTriangles: 0,
        mouthTriangles: 0,
        eyePixels: 0,
        mouthPixels: surfaces.reduce((sum, s) => sum + s.count, 0),
        lastPaintMs,
        lastPaintPixels,
        eyes: [],
        textureDigest,
        faceDistance,
      };
    },
  };
}
