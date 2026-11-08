/**
 * 视觉控制器（ADR 0054 D4/D6）：截图 + OCR + 把结果交给编排层的唯一入口。
 *
 * 分工：
 * - `capture()`：只截图。热键要用"先截图、立刻呼出输入条、再慢慢 OCR"的顺序，
 *   否则等 OCR（最多 20s）时输入条一直不出现，用户会以为热键坏了；
 * - `recognize()`：只识别。把截图结果交给 OCR，成功时调用 `onContext`；
 * - `query()`：两步合一，给 IPC 用（面板/渲染页只要最终结果）。
 *
 * 并发：识别是**单飞**的（`busy`）——第二次查询直接返回 `busy`，
 * 不排队、不并发打两个 OCR；截图本身很便宜，不设锁。
 */
import type { VisionConfig } from '../config';
import type {
  VisionContext,
  VisionFailureReason,
  VisionQueryRequest,
  VisionResult,
  VisionSource,
} from '../../shared/vision';
import type { CaptureFailure, CaptureOutcome, CaptureSuccess, VisionCapture } from './capture';
import type { OcrFailureReason, OcrResult, VisionOcrClient } from './vision-service';

export type VisionLogLevel = 'info' | 'warn';

export interface VisionSnapshot {
  enabled: boolean;
  model: string;
  baseUrl: string;
  pending: boolean;
  lastAt: number | null;
  lastOk: boolean | null;
  lastReason: VisionFailureReason | null;
  lastChars: number;
  contextAvailable: boolean;
  contextAt: number | null;
  queries: number;
  failures: number;
}

export interface VisionControllerDeps {
  config: VisionConfig;
  ocr: VisionOcrClient;
  capturePort: VisionCapture;
  /** 前台窗口标题（来自 presence；读不到就 null → 降级整屏） */
  getForegroundTitle?: () => string | null;
  /** 识别成功：把上下文交给编排层（编排层自己管 TTL 与一次性消费） */
  onContext: (context: VisionContext) => void;
  now?: () => number;
  log?: (level: VisionLogLevel, message: string, detail?: unknown) => void;
}

export interface VisionController {
  readonly enabled: boolean;
  capture(source?: VisionSource): Promise<CaptureOutcome>;
  recognize(outcome: CaptureOutcome, source: VisionSource, prompt?: string): Promise<VisionResult>;
  query(request?: VisionQueryRequest): Promise<VisionResult>;
  snapshot(): VisionSnapshot;
  dispose(): void;
}

function captureFailure(result: CaptureFailure): CaptureOutcome {
  return result;
}

export function createVisionController(deps: VisionControllerDeps): VisionController {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((): void => undefined);
  let busy = false;
  let last: VisionResult | null = null;
  let queries = 0;
  let failures = 0;
  let lastContext: VisionContext | null = null;
  let abortInFlight: AbortController | null = null;

  function baseResult(source: VisionSource, startedAt: number): VisionResult {
    return {
      ok: false,
      source,
      capturedFrom: null,
      text: '',
      chars: 0,
      at: startedAt,
      durationMs: 0,
      image: null,
      model: deps.ocr.model,
      baseUrl: deps.ocr.baseUrl,
      reason: null,
      detail: null,
    };
  }

  function failureResult(
    source: VisionSource,
    startedAt: number,
    reason: VisionFailureReason,
    detail: string,
    extra?: Partial<VisionResult>,
  ): VisionResult {
    const result: VisionResult = {
      ...baseResult(source, startedAt),
      ...extra,
      ok: false,
      reason,
      detail,
      durationMs: extra?.durationMs ?? Math.max(0, now() - startedAt),
    };
    last = result;
    failures += 1;
    log('warn', '视觉查询失败（这一轮按无视觉上下文降级）', {
      reason,
      detail,
      source,
      capturedFrom: result.capturedFrom,
      durationMs: result.durationMs,
    });
    return result;
  }

  async function capture(source?: VisionSource): Promise<CaptureOutcome> {
    const wanted = source ?? deps.config.source;
    if (!deps.config.enabled) {
      return captureFailure({
        ok: false,
        reason: 'disabled',
        detail: 'PET_VISION_DISABLE=1 或配置关闭了视觉',
        captureMs: 0,
      });
    }
    const foregroundTitle = (() => {
      try {
        return deps.getForegroundTitle?.() ?? null;
      } catch {
        return null;
      }
    })();
    try {
      return await deps.capturePort.capture({
        source: wanted,
        foregroundTitle,
        maxWidth: deps.config.maxImageWidth,
      });
    } catch (error) {
      return captureFailure({
        ok: false,
        reason: 'error',
        detail: `截图异常：${String(error)}`,
        captureMs: 0,
      });
    }
  }

  async function runRecognize(
    outcome: CaptureOutcome,
    source: VisionSource,
    prompt?: string,
  ): Promise<VisionResult> {
    const startedAt = now();
    if (!outcome.ok) {
      return failureResult(source, startedAt, outcome.reason, outcome.detail, {
        durationMs: outcome.captureMs,
      });
    }
    const capture: CaptureSuccess = outcome;
    const image = { bytes: capture.png.length, width: capture.width, height: capture.height };
    const captureAt = capture.capturedAt;
    abortInFlight = new AbortController();
    const ocr: OcrResult = await deps.ocr.recognize({
      png: capture.png,
      signal: abortInFlight.signal,
      prompt,
    });
    abortInFlight = null;
    const durationMs = now() - captureAt;

    if (!ocr.ok) {
      return failureResult(source, startedAt, ocr.reason as OcrFailureReason, ocr.detail, {
        capturedFrom: capture.capturedFrom,
        image,
        at: captureAt,
        durationMs,
      });
    }

    const context: VisionContext = {
      text: ocr.text,
      chars: ocr.chars,
      at: captureAt,
      source: capture.capturedFrom,
      model: deps.ocr.model,
    };
    lastContext = context;
    const result: VisionResult = {
      ok: true,
      source,
      capturedFrom: capture.capturedFrom,
      text: ocr.text,
      chars: ocr.chars,
      at: captureAt,
      durationMs,
      image,
      model: deps.ocr.model,
      baseUrl: deps.ocr.baseUrl,
      reason: null,
      detail: null,
    };
    last = result;
    log('info', '视觉查询成功：下一次对话会带上画面文字（一次性）', {
      source,
      capturedFrom: capture.capturedFrom,
      chars: ocr.chars,
      truncated: ocr.rawChars > ocr.chars,
      imageBytes: image.bytes,
      imageSize: { width: capture.width, height: capture.height },
      durationMs,
    });
    deps.onContext(context);
    return result;
  }

  async function recognize(
    outcome: CaptureOutcome,
    source: VisionSource,
    prompt?: string,
  ): Promise<VisionResult> {
    if (busy) {
      return failureResult(source, now(), 'busy', '已有一次视觉识别在途');
    }
    busy = true;
    try {
      return await runRecognize(outcome, source, prompt);
    } finally {
      busy = false;
    }
  }

  async function query(request?: VisionQueryRequest): Promise<VisionResult> {
    const source = request?.source ?? deps.config.source;
    if (busy) {
      return failureResult(source, now(), 'busy', '已有一次视觉识别在途');
    }
    busy = true;
    queries += 1;
    try {
      const captured = await capture(source);
      return await runRecognize(captured, source);
    } finally {
      busy = false;
    }
  }

  function snapshot(): VisionSnapshot {
    const contextAlive =
      lastContext !== null && now() - lastContext.at <= deps.config.contextTtlMs;
    return {
      enabled: deps.config.enabled,
      model: deps.ocr.model,
      baseUrl: deps.ocr.baseUrl,
      pending: busy,
      lastAt: last?.at ?? null,
      lastOk: last?.ok ?? null,
      lastReason: last?.reason ?? null,
      lastChars: last?.chars ?? 0,
      contextAvailable: contextAlive,
      contextAt: contextAlive ? lastContext?.at ?? null : null,
      queries,
      failures,
    };
  }

  function dispose(): void {
    try {
      abortInFlight?.abort();
    } catch {
      // 忽略：已经结束
    }
    abortInFlight = null;
    lastContext = null;
  }

  return { enabled: deps.config.enabled, capture, recognize, query, snapshot, dispose };
}
