/**
 * 掩膜采集器：把场景渲染进离屏 RenderTarget 并读回 alpha。
 *
 * 契约 §3.3 R-2/R-5/R-9；ADR 0002；ADR 0004 D5；ADR 0057 D2.5（分辨率随缩放自适应）。
 * - 只对离屏 RT 调 `readRenderTargetPixels`，绝不碰 drawing buffer，绝不开启 preserveDrawingBuffer。
 * - 20Hz 固定刷新（与 rAF 解耦）；光标离开（主进程停止探针）后暂停采集。
 * - 三态与降级计数在 MaskSampler 里；这里只负责"把 alpha 交进去"和"探针到达时按需重采"。
 * - **掩膜分辨率不是常量**：尺寸由 `maskSizeFor(内容宽, 内容高)` 按当前缩放算出来，
 *   缩放时重建 RT。单元覆盖的 CSS 面积保持恒定，命中精度与拖动滑块前一致。
 */
import * as THREE from 'three';
import {
  MASK_PROBE_ACTIVE_WINDOW_MS,
  MASK_REFRESH_INTERVAL_MS,
} from '../../shared/constants';
import { maskSizeFor, rgbaToAlpha } from '../../shared/mask';
import { MaskSampler } from './mask-sampler';
import type { MaskSample, MaskSnapshot } from './mask-sampler';

export interface MaskRendererHost {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
}

export interface MaskCapture {
  probe(cssX: number, cssY: number): MaskSample;
  start(): void;
  stop(): void;
  /** R-8：拖拽期间暂停采集（由渲染侧拖拽状态驱动，见 src/renderer/shell/drag-pause.ts） */
  setPaused(paused: boolean): void;
  /**
   * 在既有的 50ms 采集 tick 上挂一个观察者（R-8 的沉降窗口结算）。
   * 用途只有一个：不新增定时器也能在暂停期间继续推进状态。
   */
  setTickListener(listener: ((now: number) => void) | null): void;
  /**
   * ADR 0057 D2.5：内容区尺寸变化（整体缩放 / 显示器 DPI 变化）后重算掩膜分辨率。
   * 返回是否真的重建了 RT（自检据此断言"缩放真的换了分辨率"）。
   */
  resize(cssWidth: number, cssHeight: number): boolean;
  /** 当前掩膜分辨率 */
  size(): { width: number; height: number };
  snapshot(): MaskSnapshot;
  /** 自检用：模拟 WebGL 上下文丢失 */
  markContextLost(): void;
}

export function createMaskCapture(host: MaskRendererHost): MaskCapture {
  const sampler = new MaskSampler();

  let size = maskSizeFor(0, 0);
  let target = createTarget(size.width, size.height);
  let pixels = new Uint8Array(size.width * size.height * 4);

  let timer: number | null = null;
  let paused = false;
  let lastProbeAt = Number.NEGATIVE_INFINITY;
  let consecutiveFailures = 0;
  let tickListener: ((now: number) => void) | null = null;

  function createTarget(width: number, height: number): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(width, height, {
      depthBuffer: true,
      stencilBuffer: false,
    });
  }

  function capture(now: number): boolean {
    try {
      host.renderer.setRenderTarget(target);
      host.renderer.clear();
      host.renderer.render(host.scene, host.camera);
      host.renderer.readRenderTargetPixels(target, 0, 0, size.width, size.height, pixels);
      host.renderer.setRenderTarget(null);
      // WebGL 帧缓冲原点在左下，掩膜/CSS 原点在左上 → 读回时垂直翻转
      sampler.recordSuccess(
        now,
        rgbaToAlpha(pixels, size.width, size.height, true),
        size.width,
        size.height,
      );
      consecutiveFailures = 0;
      return true;
    } catch (error) {
      try {
        host.renderer.setRenderTarget(null);
      } catch {
        // 上下文已丢，忽略
      }
      sampler.recordFailure();
      consecutiveFailures += 1;
      // R-9：采集失败记一次降级日志，不刷屏
      if (consecutiveFailures === 1) {
        console.warn('[render] 掩膜采集失败，退回矩形判定（R-9）', error);
      }
      return false;
    }
  }

  function tick(): void {
    const now = performance.now();
    // 暂停期间仍要推进观察者（R-8 的沉降窗口在这里结算），否则永远醒不过来
    tickListener?.(now);
    if (paused) return;
    // R-5：主进程停止探针 = 光标离开窗口 → 暂停采集
    if (now - lastProbeAt > MASK_PROBE_ACTIVE_WINDOW_MS) return;
    capture(now);
  }

  return {
    probe(cssX: number, cssY: number): MaskSample {
      const now = performance.now();
      lastProbeAt = now;

      // R-5：陈旧 > 100ms 时立即重采一次再判定；暂停中无法重采，按 stale 走矩形退路
      if (!paused && sampler.stateAt(now) !== 'ready') {
        capture(performance.now());
      }

      const cssW = Math.max(1, window.innerWidth);
      const cssH = Math.max(1, window.innerHeight);
      return sampler.sample(cssX, cssY, cssW, cssH, performance.now());
    },

    start(): void {
      if (timer !== null) return;
      timer = window.setInterval(tick, MASK_REFRESH_INTERVAL_MS);
    },

    stop(): void {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
      target.dispose();
    },

    setPaused(next: boolean): void {
      paused = next;
    },

    setTickListener(listener: ((now: number) => void) | null): void {
      tickListener = listener;
    },

    resize(cssWidth: number, cssHeight: number): boolean {
      const next = maskSizeFor(cssWidth, cssHeight);
      if (next.width === size.width && next.height === size.height) return false;
      target.dispose();
      size = next;
      target = createTarget(size.width, size.height);
      pixels = new Uint8Array(size.width * size.height * 4);
      // 旧 alpha 缓冲尺寸对不上，必须作废：下一次 probe 会立刻重采一次（`stateAt !== 'ready'`）
      sampler.recordFailure();
      console.log(
        `[render] 掩膜分辨率随缩放调整：${next.width}×${next.height}` +
          `（内容区 ${Math.round(cssWidth)}×${Math.round(cssHeight)}，ADR 0057 D2.5）`,
      );
      return true;
    },

    size(): { width: number; height: number } {
      return { width: size.width, height: size.height };
    },

    snapshot(): MaskSnapshot {
      return sampler.snapshot(performance.now());
    },

    markContextLost(): void {
      sampler.recordFailure();
    },
  };
}
