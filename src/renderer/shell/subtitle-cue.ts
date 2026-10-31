/**
 * 字幕显示时序（ADR 0021）。
 *
 * 目标：**字幕与语音同时出现**。TTS 合成比 LLM 慢一个数量级（本机 4.2–6.2s），
 * 所以"一拿到文本就显示"必然"先看字后听音"。
 *
 * 规则（逐条对应 ADR 0021）：
 * | 输入 | 行为 |
 * |---|---|
 * | `intent_resolved{text}` | 只登记 `pending`，**不显示**（D1）；启动 15s failsafe（D6） |
 * | `speech_started{text}` | 显示完整字幕，`holdMs=null`（不自动隐藏）（D2/D4） |
 * | `speech_ended{failed}` | 显示 `pending` 作为兜底（D3） |
 * | `speech_ended{completed}` | 字幕留 1.2s 尾巴（D4） |
 * | `speech_ended{interrupted}` | 丢弃 `pending`（旧回复已作废），可见则留尾巴（D5） |
 *
 * 纯逻辑：`show` / `hide` / `holdFor` / `schedule` / `cancel` 全部注入，
 * 因此可以在 Node 里用假定时器单测（`subtitle-cue.test.ts`），不需要 DOM。
 */
import {
  SUBTITLE_HOLD_MS,
  SUBTITLE_PENDING_FAILSAFE_MS,
  SUBTITLE_TAIL_MS,
} from '../../shared/constants';

export interface SubtitleCueDeps {
  show(text: string, holdMs?: number | null): void;
  holdFor(holdMs: number): void;
  hide(): void;
  /** 返回一个句柄给 `cancel`（浏览器里是 `window.setTimeout` 的 number） */
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
  log?: (level: 'info' | 'warn', message: string, data?: unknown) => void;
}

export interface SubtitleCueSnapshot {
  /** 已登记但还没显示的字幕（等 `speech_started`） */
  pending: string | null;
  /** 当前是否有一条字幕在屏幕上 */
  visible: boolean;
  /** failsafe 定时器是否在跑 */
  armed: boolean;
}

export interface SubtitleCue {
  onIntentResolved(text: unknown): void;
  onSpeechStarted(payload: { text?: unknown } | null | undefined): void;
  onSpeechEnded(payload: { reason?: unknown } | null | undefined): void;
  dispose(): void;
  snapshot(): SubtitleCueSnapshot;
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function createSubtitleCue(deps: SubtitleCueDeps): SubtitleCue {
  const log =
    deps.log ??
    ((level, message, data) => {
      const line = `[subtitle] ${message}`;
      if (level === 'warn') console.warn(line, data ?? '');
      else console.log(line, data ?? '');
    });

  let pending: string | null = null;
  let visible = false;
  let failsafe: unknown = null;

  function cancelFailsafe(): void {
    if (failsafe === null) return;
    deps.cancel(failsafe);
    failsafe = null;
  }

  function showNow(text: string, holdMs: number | null): void {
    const value = toText(text);
    if (value === '') return;
    deps.show(value, holdMs);
    visible = true;
  }

  function armFailsafe(): void {
    cancelFailsafe();
    failsafe = deps.schedule(() => {
      failsafe = null;
      if (pending === null) return;
      // 等到 15s 还没开口：链路异常，先把文本给用户（D6）
      log('warn', '等待 speech_started 超时，提前显示字幕（ADR 0021 D6）', {
        failsafeMs: SUBTITLE_PENDING_FAILSAFE_MS,
      });
      showNow(pending, SUBTITLE_HOLD_MS);
    }, SUBTITLE_PENDING_FAILSAFE_MS);
  }

  return {
    onIntentResolved(text: unknown): void {
      const value = toText(text);
      if (value === '') return;
      // 上一条还挂在屏幕上 → 它已经结束（新话语意味着旧回复作废），先收掉
      if (visible) {
        deps.hide();
        visible = false;
      }
      pending = value;
      armFailsafe();
    },

    onSpeechStarted(payload: { text?: unknown } | null | undefined): void {
      cancelFailsafe();
      const spoken = toText(payload?.text) || pending;
      if (spoken === null || spoken === '') return;
      pending = null;
      // 语音期间不自动隐藏：由 speech_ended 决定何时淡出（D4）
      showNow(spoken, null);
    },

    onSpeechEnded(payload: { reason?: unknown } | null | undefined): void {
      cancelFailsafe();
      const reason = payload?.reason;

      if (reason === 'failed') {
        if (pending !== null) {
          const text = pending;
          pending = null;
          // §11：没有语音时字幕是可读输出的唯一兜底
          showNow(text, SUBTITLE_HOLD_MS);
          return;
        }
        if (visible) deps.holdFor(SUBTITLE_HOLD_MS);
        return;
      }

      if (reason === 'interrupted') {
        pending = null; // 旧回复被新话语取代，不再补显示（D5）
        if (visible) deps.holdFor(SUBTITLE_TAIL_MS);
        return;
      }

      // completed：字幕在 speech_started 时已经显示；这里只补"说完后的尾巴"
      pending = null;
      if (visible) deps.holdFor(SUBTITLE_TAIL_MS);
    },

    dispose(): void {
      cancelFailsafe();
      pending = null;
      visible = false;
    },

    snapshot(): SubtitleCueSnapshot {
      return { pending, visible, armed: failsafe !== null };
    },
  };
}
