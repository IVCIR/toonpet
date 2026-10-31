/**
 * 字幕气泡（契约 §2 shell 渲染侧、§3.2 R-1、§8.3；ADR 0015 D3、ADR 0021）。
 *
 * 窗口内容只有 canvas + 这一个 DOM：`pointer-events: none`，不参与命中、不改变穿透判定。
 * 本文件只负责"把文本画出来 / 定时收起"；**什么时候显示**由 `subtitle-cue.ts` 决定
 * （ADR 0021 D7：时序是纯逻辑，可单测；DOM 只在这里）。
 */
import { SUBTITLE_FADE_MS, SUBTITLE_HOLD_MS } from '../../shared/constants';

export interface Subtitle {
  /**
   * 显示文本。`holdMs`：
   * - 数字 → 停留这么久后淡出；
   * - `null` → **不自动隐藏**，等 `holdFor()` 或 `hide()`（语音播放期间用，ADR 0021 D4）。
   */
  show(text: string, holdMs?: number | null): void;
  /** 重排隐藏定时器（不可见时为空操作）；用于"语音结束后留 1.2s 尾巴"。 */
  holdFor(holdMs: number): void;
  hide(): void;
  dispose(): void;
}

const MAX_CHARS = 160;

export function createSubtitle(): Subtitle {
  const element = document.createElement('div');
  element.id = 'subtitle';
  element.className = 'subtitle';
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  document.body.appendChild(element);

  let hideTimer: number | null = null;
  let clearTimer: number | null = null;

  function clearTimers(): void {
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    if (clearTimer !== null) window.clearTimeout(clearTimer);
    hideTimer = null;
    clearTimer = null;
  }

  /** 安排淡出：先摘 `visible`，再等淡出动画结束清文本（避免"文字瞬间消失"）。 */
  function scheduleHide(holdMs: number): void {
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      hideTimer = null;
      element.classList.remove('visible');
      clearTimer = window.setTimeout(() => {
        clearTimer = null;
        element.textContent = '';
      }, SUBTITLE_FADE_MS);
    }, Math.max(500, holdMs));
  }

  return {
    show(text: string, holdMs: number | null = SUBTITLE_HOLD_MS): void {
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (trimmed === '') return;
      clearTimers();
      element.textContent = trimmed.length > MAX_CHARS ? `${trimmed.slice(0, MAX_CHARS)}…` : trimmed;
      element.classList.add('visible');
      if (holdMs === null) return; // 语音期间不自动隐藏
      scheduleHide(holdMs);
    },

    holdFor(holdMs: number): void {
      if (!element.classList.contains('visible')) return;
      scheduleHide(holdMs);
    },

    hide(): void {
      clearTimers();
      element.classList.remove('visible');
      clearTimer = window.setTimeout(() => {
        clearTimer = null;
        element.textContent = '';
      }, SUBTITLE_FADE_MS);
    },

    dispose(): void {
      clearTimers();
      element.remove();
    },
  };
}
