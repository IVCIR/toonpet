/**
 * emotion → 面部图元的纯映射（ADR 0026 D6：**眼型不再由代码绘制**）。
 *
 * 背景：ADR 0026 首版用"逐像素重绘五官"程序化画眼型/瞳孔/眼睑，实机截图**明显恐怖、
 * 不像官方**（`docs/adr/0026` 的"决策变更"一节记录了失败原因）。本轮起：
 *
 * - **眼型与红晕**只能来自 `data/expressions/` 下的官方差分 PNG（见 `expression-assets.ts`）；
 * - 本文件只保留"emotion → 用哪张官方图 / 嘴型 / 红晕强度"的纯映射，以及嘴型图元；
 * - 任何"画眼睛弧线/瞳孔/眼睑"的代码都不允许出现（硬约束，写进 ADR 0026 D6）。
 *
 * 坐标约定（仅嘴型用）：`(mx, my)` 在"嘴部绘制框"内归一化，`my = +1` 为上。
 * 性能约定：逐像素热路径用 `xxxInto` 写 `out` 或返回打包整数（0 = 不画），零分配。
 */
import type { Emotion } from '../../shared/types';

/** 官方眼型差分的键（对应 `eyes_<key>.png`）；`null` = 没有对应贴图。 */
export type EyeAssetKey = 'happy' | 'shy' | 'sad' | 'surprised';

/** 嘴型图元。`none` = 不参与绘制（交回图集静态闭嘴帧）。 */
export type MouthShape = 'none' | 'smile' | 'frown' | 'open' | 'small';

/** 红晕强度：0 = 无，1 = 轻微（happy），2 = 明显（shy）。 */
export type BlushLevel = 0 | 1 | 2;

export interface EmotionFace {
  /** 用哪张官方眼型差分；`null` = 保持默认眼（降级） */
  eyes: EyeAssetKey | null;
  mouth: MouthShape;
  blush: BlushLevel;
}

/**
 * 契约 §4.5 的七个 emotion → 资产映射（全集，键必须覆盖 `EMOTIONS`）。
 *
 * 与 §4.5"表情基线"的对齐情况：
 * - `happy`  → 官方弯眼 + 上扬嘴 + 轻红晕 ✅
 * - `shy`    → 官方半闭眼 + 小口 + 重红晕 ✅
 * - `sad`    → 官方垂眼 + 嘴角下垂 ✅
 * - `surprised` → 官方睁大眼 + 张口 ✅
 * - `sleepy` → 复用官方半闭眼（§4.5 的"半闭眼"）+ 小口；素材里没有独立的"困"差分
 * - `angry`  → 素材里没有"生气"眼型 → **降级为只变嘴型**（抿嘴），保持默认眼
 * - `neutral`→ 不覆盖任何图元
 *
 * 降级规则（任务要求）：某个 emotion 没有对应贴图时，只变嘴型、保持默认眼。
 */
export const EMOTION_FACE: Record<Emotion, EmotionFace> = {
  neutral: { eyes: null, mouth: 'none', blush: 0 },
  happy: { eyes: 'happy', mouth: 'smile', blush: 1 },
  shy: { eyes: 'shy', mouth: 'small', blush: 2 },
  sad: { eyes: 'sad', mouth: 'frown', blush: 0 },
  surprised: { eyes: 'surprised', mouth: 'open', blush: 0 },
  angry: { eyes: null, mouth: 'small', blush: 0 },
  sleepy: { eyes: 'shy', mouth: 'small', blush: 0 },
};

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface SkinColor {
  r: number;
  g: number;
  b: number;
}

export interface FacePalette {
  /** 肤色（从 Face 贴图众数采样；缺失时用默认值） */
  skin: SkinColor;
  /** 嘴线的深色（**只用于嘴**；眼型一律来自图片） */
  ink: Rgba;
  /** 口内（`open` / `small` 用） */
  mouthInner: Rgba;
}

export const DEFAULT_PALETTE: FacePalette = {
  skin: { r: 249, g: 241, b: 236 },
  ink: { r: 58, g: 40, b: 44, a: 1 },
  mouthInner: { r: 122, g: 54, b: 60, a: 1 },
};

/** 归一化椭圆值：`<= 1` 在内部，`= 1` 为边界。 */
export function ellipseValue(ex: number, ey: number, rx: number, ry: number): number {
  return (ex * ex) / (rx * rx) + (ey * ey) / (ry * ry);
}

// ---------------------------------------------------------------------------
// 打包颜色（热路径零分配）
// ---------------------------------------------------------------------------

function scratchRgba(): Rgba {
  return { r: 0, g: 0, b: 0, a: 0 };
}

const MOUTH_SCRATCH: Rgba = scratchRgba();

/**
 * 把颜色打包成 0xRRGGBBAA；`null` 或全透明 → 0（= 不画）。
 * 0 作为哨兵不会与真实颜色冲突：alpha 为 0 的颜色本来就不该画。
 */
export function packColor(color: Rgba | null): number {
  if (!color || color.a <= 0.001) return 0;
  const alpha = Math.round(Math.max(0, Math.min(1, color.a)) * 255) & 0xff;
  return (
    (((color.r & 0xff) << 24) |
      ((color.g & 0xff) << 16) |
      ((color.b & 0xff) << 8) |
      alpha) >>>
    0
  );
}

export function unpackRed(packed: number): number {
  return (packed >>> 24) & 0xff;
}

export function unpackGreen(packed: number): number {
  return (packed >>> 16) & 0xff;
}

export function unpackBlue(packed: number): number {
  return (packed >>> 8) & 0xff;
}

export function unpackAlpha(packed: number): number {
  return (packed & 0xff) / 255;
}

// ---------------------------------------------------------------------------
// 嘴型（唯一允许程序化绘制的部分：一条弧线/一个小口，不涉及眼型）
// ---------------------------------------------------------------------------

/** 嘴型采样（`aspect` = 绘制框宽/高）。写入 `out` 并返回"要不要画"。 */
export function mouthShapeInto(
  shape: MouthShape,
  mx: number,
  my: number,
  palette: FacePalette,
  out: Rgba,
  aspect = 1,
): boolean {
  if (shape === 'none') return false;
  const ax = Math.max(1e-6, aspect);

  switch (shape) {
    case 'smile': {
      // 嘴角上扬：中间低、两端高（凹向上）
      if (Math.abs(mx) > 0.92) return false;
      const line = -0.34 + 0.66 * mx * mx;
      if (Math.abs(my - line) > 0.15) return false;
      break;
    }
    case 'frown': {
      // 嘴角下垂：中间高、两端低（凹向下）
      if (Math.abs(mx) > 0.92) return false;
      const line = 0.34 - 0.66 * mx * mx;
      if (Math.abs(my - line) > 0.15) return false;
      break;
    }
    case 'open': {
      // 微张：竖椭圆的口（surprised）
      const value = ellipseValue(mx / ax, my, 0.46, 0.74);
      if (value > 1) return false;
      if (value > 0.7) break;
      out.r = palette.mouthInner.r;
      out.g = palette.mouthInner.g;
      out.b = palette.mouthInner.b;
      out.a = palette.mouthInner.a;
      return true;
    }
    case 'small': {
      // 小口（shy / sleepy / angry）：短横椭圆
      const value = ellipseValue(mx / ax, my, 0.36, 0.32);
      if (value > 1) return false;
      if (value > 0.58) break;
      out.r = palette.mouthInner.r;
      out.g = palette.mouthInner.g;
      out.b = palette.mouthInner.b;
      out.a = palette.mouthInner.a;
      return true;
    }
    default:
      return false;
  }

  out.r = palette.ink.r;
  out.g = palette.ink.g;
  out.b = palette.ink.b;
  out.a = palette.ink.a;
  return true;
}

export function sampleMouthShape(
  shape: MouthShape,
  mx: number,
  my: number,
  palette: FacePalette,
  aspect = 1,
): Rgba | null {
  if (!mouthShapeInto(shape, mx, my, palette, MOUTH_SCRATCH, aspect)) return null;
  return { r: MOUTH_SCRATCH.r, g: MOUTH_SCRATCH.g, b: MOUTH_SCRATCH.b, a: MOUTH_SCRATCH.a };
}

export function sampleMouthShapePacked(
  shape: MouthShape,
  mx: number,
  my: number,
  palette: FacePalette,
  aspect = 1,
): number {
  if (!mouthShapeInto(shape, mx, my, palette, MOUTH_SCRATCH, aspect)) return 0;
  return packColor(MOUTH_SCRATCH);
}

// ---------------------------------------------------------------------------
// 行走朝向（ADR 0026 D1，本轮未改）
// ---------------------------------------------------------------------------

/** 行走朝向：右走 `+90°`、左走 `-90°`（three 的 +Y 旋转把 +Z 转向 +X）。 */
export const WALK_YAW_RAD = Math.PI / 2;

/** 行走方向 → 目标偏航角（rad）。`null` = 站定回正。 */
export function walkYawFor(direction: 'left' | 'right' | null): number {
  if (direction === 'right') return WALK_YAW_RAD;
  if (direction === 'left') return -WALK_YAW_RAD;
  return 0;
}

/**
 * 指数逼近平滑（帧率无关，不会因丢帧过冲）。
 * `dt` 单位秒，`rate` 单位 1/秒（转身取 9 ≈ 0.3s 走完 96%）。
 */
export function approach(current: number, target: number, dtSeconds: number, rate: number): number {
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return current;
  const alpha = 1 - Math.exp(-Math.max(0, rate) * dtSeconds);
  const next = current + (target - current) * alpha;
  // 收敛后直接吸附，避免长期残留 1e-4 的抖动
  if (Math.abs(target - next) < 1e-4) return target;
  return next;
}

// ---------------------------------------------------------------------------
// 淡入与嘴层仲裁（§5.2）
// ---------------------------------------------------------------------------

/** 表情淡入淡出时长（§5.2 的 0.25s；任务要求 0.2s，取 §5.2 更宽的旧值以保持契约一致） */
export const EMOTION_FADE_MS = 250;

/** 淡入进度 0..1，`elapsedMs` 用毫秒。 */
export function fadeProgress(elapsedMs: number, durationMs: number = EMOTION_FADE_MS): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 1;
  return Math.min(1, elapsedMs / durationMs);
}

/**
 * 嘴层的实际归属（§5.2 口型通道最高优先级的可观测形式）。
 *
 * ADR 0039 D3：`'pat'` 归属已删除——摸头不再单独切"shy 帧"，它只是把 `effective emotion`
 * 投影成 `shy`，嘴型由 `'emotion'` 用官方差分承担。
 */
export type MouthOwner = 'lip-sync' | 'emotion' | 'static';

/**
 * 嘴层仲裁（§5.2 / ADR 0026 D3 / ADR 0039 D3）：
 * 口型 > 表情 > 静态闭嘴。纯函数，可单测；渲染侧照它的结论画。
 */
export function resolveMouthOwner(input: {
  speaking: boolean;
  lipSyncDriven: boolean;
  emotionMouth: MouthShape;
  alpha: number;
}): MouthOwner {
  if (input.speaking || input.lipSyncDriven) return 'lip-sync';
  if (input.emotionMouth !== 'none' && input.alpha > 0.001) return 'emotion';
  return 'static';
}
