/**
 * 视觉/OCR 的截图端（ADR 0054 D2）。
 *
 * 只做一件事：把"用户眼前的屏幕"变成一张 PNG Buffer。刻意不 import `electron`，
 * 平台能力（desktopCapturer / screen）由调用方注入 —— 这样单测可以用假图源跑完
 * 全部选择/降级/缩放逻辑，不需要起 Electron（与 `passthrough-fsm` 同一手法）。
 *
 * 两条来源：
 * - `screen`：光标所在显示器的整屏（`display_id` 匹配）；
 * - `foreground`：按前台窗口标题在 `desktopCapturer` 的窗口源里找同名窗口；
 *   找不到就**静默降级为整屏**并把 `capturedFrom` 写成 `screen`（ADR 0054 D2.3）。
 */
import type { VisionSource } from '../../shared/vision';

/** Electron `NativeImage` 的最小结构（只用到这四个方法） */
export interface NativeImageLike {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: { width?: number; height?: number; quality?: 'good' | 'better' | 'best' }): NativeImageLike;
  toPNG(): Buffer;
}

export interface DesktopSourceLike {
  id: string;
  name: string;
  display_id: string;
  thumbnail: NativeImageLike;
}

export interface DisplayLike {
  id: number;
  size: { width: number; height: number };
  scaleFactor: number;
}

export interface CapturePlatform {
  getSources(options: {
    types: Array<'screen' | 'window'>;
    thumbnailSize: { width: number; height: number };
    fetchWindowIcons: boolean;
  }): Promise<DesktopSourceLike[]>;
  getCursorScreenPoint(): { x: number; y: number };
  getDisplayNearestPoint(point: { x: number; y: number }): DisplayLike;
  getPrimaryDisplay(): DisplayLike;
}

export interface CaptureRequest {
  source: VisionSource;
  /** 前台窗口标题（`presence` 已读好的那份；没有就传 null） */
  foregroundTitle?: string | null;
  /** 缩放后的最大宽度（见 `VISION_CAPTURE_MAX_WIDTH_PX`） */
  maxWidth: number;
  /** 硬上限：缩略图请求尺寸（防止 8K 屏一次解码出巨图） */
  hardMaxWidth?: number;
}

export interface CaptureSuccess {
  ok: true;
  png: Buffer;
  width: number;
  height: number;
  /** 实际来源：前台窗口没匹配到时为 `screen` */
  capturedFrom: VisionSource;
  /** 匹配到的窗口标题 / 屏幕名，仅用于日志 */
  sourceTitle: string | null;
  displayId: string | null;
  /** 截图时刻（epoch ms）：视觉上下文的"几秒前"以它为准 */
  capturedAt: number;
  captureMs: number;
}

export interface CaptureFailure {
  ok: false;
  reason: 'disabled' | 'unavailable' | 'empty' | 'error';
  detail: string;
  captureMs: number;
}

export type CaptureOutcome = CaptureSuccess | CaptureFailure;

const DEFAULT_HARD_MAX_WIDTH = 2560;

function normalizeTitle(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * 窗口标题匹配：先精确、再去掉尾部 " - 应用名" 之类的后缀做包含匹配。
 *
 * 只做包含匹配而不做模糊评分：宁可降级为整屏，也不要截错窗口
 * （截错窗口会把别人的密码/聊天记录喂进提示词，是比"没识别到"严重得多的问题）。
 */
export function matchWindowSource(
  sources: readonly DesktopSourceLike[],
  title: string | null | undefined,
): DesktopSourceLike | null {
  const wanted = normalizeTitle(title);
  if (wanted.length < 3) return null;
  const windows = sources.filter((source) => source.id.startsWith('window:'));
  const exact = windows.find((source) => normalizeTitle(source.name) === wanted);
  if (exact) return exact;
  return (
    windows.find((source) => {
      const name = normalizeTitle(source.name);
      return name.length >= 3 && (name.includes(wanted) || wanted.includes(name));
    }) ?? null
  );
}

function pickDisplay(platform: CapturePlatform): DisplayLike {
  try {
    return platform.getDisplayNearestPoint(platform.getCursorScreenPoint());
  } catch {
    return platform.getPrimaryDisplay();
  }
}

/** 物理像素尺寸 → 缩略图请求尺寸：限制宽度上限，保持宽高比 */
export function thumbnailSizeFor(display: DisplayLike, hardMaxWidth: number): { width: number; height: number } {
  const physicalWidth = Math.max(1, Math.round(display.size.width * (display.scaleFactor || 1)));
  const physicalHeight = Math.max(1, Math.round(display.size.height * (display.scaleFactor || 1)));
  const width = Math.min(physicalWidth, hardMaxWidth);
  const height = Math.max(1, Math.round((width * physicalHeight) / physicalWidth));
  return { width, height };
}

function pickScreenSource(
  sources: readonly DesktopSourceLike[],
  display: DisplayLike,
): DesktopSourceLike | null {
  const screens = sources.filter((source) => source.id.startsWith('screen:'));
  return (
    screens.find((source) => source.display_id === String(display.id)) ??
    screens[0] ??
    sources[0] ??
    null
  );
}

function imageSize(image: NativeImageLike): { width: number; height: number } {
  try {
    return image.getSize();
  } catch {
    return { width: 0, height: 0 };
  }
}

export interface VisionCapture {
  capture(request: CaptureRequest): Promise<CaptureOutcome>;
}

export function createVisionCapture(platform: CapturePlatform): VisionCapture {
  async function capture(request: CaptureRequest): Promise<CaptureOutcome> {
    const startedAt = Date.now();
    const capturedAt = startedAt;
    const hardMaxWidth = request.hardMaxWidth ?? DEFAULT_HARD_MAX_WIDTH;
    const display = pickDisplay(platform);
    const thumbnailSize = thumbnailSizeFor(display, hardMaxWidth);
    const wantedForeground = request.source === 'foreground';

    let sources: DesktopSourceLike[];
    try {
      sources = await platform.getSources({
        // 一次把 window + screen 都取回来：省一次 IPC，也保证标题匹配和整屏降级用同一帧
        types: wantedForeground ? ['window', 'screen'] : ['screen'],
        thumbnailSize,
        fetchWindowIcons: false,
      });
    } catch (error) {
      return {
        ok: false,
        reason: 'unavailable',
        detail: `desktopCapturer.getSources 失败：${String(error)}`,
        captureMs: Date.now() - startedAt,
      };
    }

    if (!Array.isArray(sources) || sources.length === 0) {
      return {
        ok: false,
        reason: 'unavailable',
        detail: 'desktopCapturer 没有返回任何源（受控桌面/远程会话通常会禁用截图）',
        captureMs: Date.now() - startedAt,
      };
    }

    let capturedFrom: VisionSource = 'screen';
    let source: DesktopSourceLike | null = null;
    if (wantedForeground) {
      source = matchWindowSource(sources, request.foregroundTitle);
      if (source) capturedFrom = 'foreground';
    }
    if (!source) source = pickScreenSource(sources, display);
    if (!source) {
      return {
        ok: false,
        reason: 'unavailable',
        detail: '没有可用的屏幕源',
        captureMs: Date.now() - startedAt,
      };
    }

    if (!source.thumbnail || source.thumbnail.isEmpty()) {
      return {
        ok: false,
        reason: 'empty',
        detail: `源 ${source.id} 的缩略图为空`,
        captureMs: Date.now() - startedAt,
      };
    }

    let image = source.thumbnail;
    let size = imageSize(image);
    if (size.width <= 0 || size.height <= 0) {
      return {
        ok: false,
        reason: 'empty',
        detail: `源 ${source.id} 的缩略图尺寸为 0`,
        captureMs: Date.now() - startedAt,
      };
    }

    if (size.width > request.maxWidth) {
      const width = Math.max(1, Math.round(request.maxWidth));
      const height = Math.max(1, Math.round((width * size.height) / size.width));
      image = image.resize({ width, height, quality: 'good' });
      size = imageSize(image);
    }

    let png: Buffer;
    try {
      png = image.toPNG();
    } catch (error) {
      return {
        ok: false,
        reason: 'error',
        detail: `toPNG 失败：${String(error)}`,
        captureMs: Date.now() - startedAt,
      };
    }
    if (!Buffer.isBuffer(png) || png.length === 0) {
      return {
        ok: false,
        reason: 'empty',
        detail: 'toPNG 返回空 Buffer',
        captureMs: Date.now() - startedAt,
      };
    }

    return {
      ok: true,
      png,
      width: size.width,
      height: size.height,
      capturedFrom,
      sourceTitle: source.name || null,
      displayId: source.display_id || null,
      capturedAt,
      captureMs: Date.now() - startedAt,
    };
  }

  return { capture };
}
