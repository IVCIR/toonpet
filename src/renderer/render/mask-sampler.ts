/**
 * 掩膜采样器（纯逻辑，不碰 WebGL）。
 *
 * 契约 §3.3 R-2/R-4/R-5/R-9/R-10；ADR 0002；ADR 0004 D5。
 * 三态（cold / ready / stale）与两个降级计数器都在这里，采集器只负责"把 alpha 交进来"。
 * cold 与 stale 都走 R-9 的矩形退路，`head = null`。
 */
import {
  HEAD_BAND_RATIO,
  HIT_ALPHA_THRESHOLD,
  MASK_HEIGHT,
  MASK_STALE_MS,
  MASK_WIDTH,
} from '../../shared/constants';
import type { ProbeResponse } from '../../shared/ipc';
import {
  alphaBoundingBox,
  hitTest,
  isInHeadRegion,
  isInsideContent,
  type MaskBoundingBox,
} from '../../shared/mask';

export type MaskState = 'cold' | 'ready' | 'stale';

export interface MaskCounters {
  /** cold 期间走了矩形退路的次数 */
  cold: number;
  /** stale 期间走了矩形退路的次数 */
  stale: number;
}

export interface MaskSnapshot {
  state: MaskState;
  lastSuccessAt: number | null;
  counters: MaskCounters;
  bbox: MaskBoundingBox | null;
}

export interface MaskSample extends ProbeResponse {
  state: MaskState;
  /** true = 本次判定走了 R-9 矩形退路 */
  degraded: boolean;
}

export interface MaskSamplerOptions {
  staleMs?: number;
}

export class MaskSampler {
  private alpha: Uint8Array | null = null;
  private bbox: MaskBoundingBox | null = null;
  private lastSuccessAt: number | null = null;
  private contextLost = false;
  private readonly staleMs: number;
  private readonly counters: MaskCounters = { cold: 0, stale: 0 };

  constructor(options: MaskSamplerOptions = {}) {
    this.staleMs = options.staleMs ?? MASK_STALE_MS;
  }

  stateAt(now: number): MaskState {
    if (this.contextLost || this.lastSuccessAt === null) return 'cold';
    if (now - this.lastSuccessAt > this.staleMs) return 'stale';
    return 'ready';
  }

  recordSuccess(at: number, alpha: Uint8Array): void {
    this.alpha = alpha;
    this.bbox = alphaBoundingBox(alpha, MASK_WIDTH, MASK_HEIGHT);
    this.lastSuccessAt = at;
    this.contextLost = false;
  }

  /** 采集失败或 WebGL 上下文丢失：立即进入 cold，直到下一次成功。 */
  recordFailure(): void {
    this.contextLost = true;
  }

  snapshot(now: number): MaskSnapshot {
    return {
      state: this.stateAt(now),
      lastSuccessAt: this.lastSuccessAt,
      counters: { ...this.counters },
      bbox: this.bbox,
    };
  }

  /** 一次命中判定：ready 走双线性，cold/stale 走 R-9 矩形退路并计数。 */
  sample(cssX: number, cssY: number, cssW: number, cssH: number, now: number): MaskSample {
    const state = this.stateAt(now);

    if (state === 'ready' && this.alpha) {
      const hit = hitTest(
        this.alpha,
        MASK_WIDTH,
        MASK_HEIGHT,
        cssX,
        cssY,
        cssW,
        cssH,
        HIT_ALPHA_THRESHOLD,
      );
      const inHeadBand =
        this.bbox !== null
          ? isInHeadRegion(this.bbox, hit.mx, hit.my, HEAD_BAND_RATIO)
          : false;
      return {
        hit: hit.hit,
        x: cssX,
        y: cssY,
        // R-10：头部区只在命中时才有意义
        head: hit.hit && inHeadBand,
        state: 'ready',
        degraded: false,
      };
    }

    // R-9：掩膜不可用 → 退回"窗口内容区矩形"判定
    const fallbackState: 'cold' | 'stale' = state === 'cold' ? 'cold' : 'stale';
    this.counters[fallbackState] += 1;
    return {
      hit: isInsideContent(cssX, cssY, cssW, cssH),
      x: cssX,
      y: cssY,
      head: null,
      state: fallbackState,
      degraded: true,
    };
  }
}
