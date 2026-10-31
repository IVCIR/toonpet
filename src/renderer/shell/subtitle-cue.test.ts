import assert from 'node:assert/strict';
import test from 'node:test';
import { SUBTITLE_HOLD_MS, SUBTITLE_PENDING_FAILSAFE_MS, SUBTITLE_TAIL_MS } from '../../shared/constants';
import { createSubtitleCue } from './subtitle-cue';

// ---------------------------------------------------------------------------
// 假定时器：ADR 0021 D7 要求时序逻辑可单测，所以 schedule/cancel 是注入的。
// ---------------------------------------------------------------------------

interface Timer {
  at: number;
  callback: () => void;
}

class FakeClock {
  private timers = new Map<number, Timer>();
  private seq = 1;
  now = 0;

  schedule = (callback: () => void, delayMs: number): unknown => {
    const id = this.seq;
    this.seq += 1;
    this.timers.set(id, { at: this.now + delayMs, callback });
    return id;
  };

  cancel = (handle: unknown): void => {
    this.timers.delete(Number(handle));
  };

  /** 推进时间并触发到期定时器（按到期时间顺序） */
  advance(ms: number): void {
    this.now += ms;
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.at <= this.now)
      .sort((left, right) => left[1].at - right[1].at);
    for (const [id, timer] of due) {
      if (!this.timers.has(id)) continue;
      this.timers.delete(id);
      timer.callback();
    }
  }

  get pending(): number {
    return this.timers.size;
  }
}

interface ShowCall {
  text: string;
  holdMs: number | null | undefined;
}

function makeCue() {
  const clock = new FakeClock();
  const shown: ShowCall[] = [];
  const holds: number[] = [];
  const hidden: number[] = [];
  const logs: string[] = [];

  const cue = createSubtitleCue({
    show: (text, holdMs) => {
      shown.push({ text, holdMs });
    },
    holdFor: (holdMs) => {
      holds.push(holdMs);
    },
    hide: () => {
      hidden.push(1);
    },
    schedule: clock.schedule,
    cancel: clock.cancel,
    log: (level, message) => {
      logs.push(`${level}:${message}`);
    },
  });

  return { cue, clock, shown, holds, hidden, logs };
}

// ---------------------------------------------------------------------------
// D1 / D2：intent_resolved 只登记，speech_started 才显示
// ---------------------------------------------------------------------------

test('ADR 0021 D1：收到 intent_resolved 不显示，只登记并武装 failsafe', () => {
  const { cue, shown, clock } = makeCue();
  cue.onIntentResolved('……先生、おはようございます。');

  assert.deepEqual(shown, [], '不得在 intent_resolved 时显示字幕');
  assert.equal(cue.snapshot().pending, '……先生、おはようございます。');
  assert.equal(cue.snapshot().armed, true);
  assert.equal(clock.pending, 1);
});

test('ADR 0021 D2：speech_started 显示完整字幕，且不自动隐藏（holdMs=null）', () => {
  const { cue, shown, clock } = makeCue();
  cue.onIntentResolved('……先生、おはようございます。');
  cue.onSpeechStarted({ text: '……先生、おはようございます。' });

  assert.deepEqual(shown, [{ text: '……先生、おはようございます。', holdMs: null }]);
  assert.equal(cue.snapshot().pending, null);
  assert.equal(cue.snapshot().visible, true);
  assert.equal(clock.pending, 0, 'speech_started 之后 failsafe 必须取消');
});

test('ADR 0021 D2：speech_started 缺 text 时用 pending 兜底', () => {
  const { cue, shown } = makeCue();
  cue.onIntentResolved('はい、わかりました。');
  cue.onSpeechStarted({});

  assert.deepEqual(shown, [{ text: 'はい、わかりました。', holdMs: null }]);
});

// ---------------------------------------------------------------------------
// D3：TTS 失败 → 立即显示字幕（§11 可读输出的唯一保证）
// ---------------------------------------------------------------------------

test('ADR 0021 D3：speech_ended{failed} 立即显示 pending 字幕（6s 停留）', () => {
  const { cue, shown } = makeCue();
  cue.onIntentResolved('……そういうことですか。');
  cue.onSpeechEnded({ reason: 'failed' });

  assert.deepEqual(shown, [{ text: '……そういうことですか。', holdMs: SUBTITLE_HOLD_MS }]);
  assert.equal(cue.snapshot().pending, null);
});

test('ADR 0021 D3：字幕已可见时 failed 只续期，不重复渲染同一文本', () => {
  const { cue, shown, holds } = makeCue();
  cue.onIntentResolved('はい。');
  cue.onSpeechStarted({ text: 'はい。' });
  cue.onSpeechEnded({ reason: 'failed' });

  assert.equal(shown.length, 1);
  assert.deepEqual(holds, [SUBTITLE_HOLD_MS]);
});

// ---------------------------------------------------------------------------
// D4 / D5：completed 只补尾巴；interrupted 丢弃 pending
// ---------------------------------------------------------------------------

test('ADR 0021 D4：speech_ended{completed} 不新增显示，只留 1.2s 尾巴', () => {
  const { cue, shown, holds } = makeCue();
  cue.onIntentResolved('おやすみなさい。');
  cue.onSpeechStarted({ text: 'おやすみなさい。' });
  cue.onSpeechEnded({ reason: 'completed' });

  assert.equal(shown.length, 1);
  assert.deepEqual(holds, [SUBTITLE_TAIL_MS]);
});

test('ADR 0021 D5：speech_ended{interrupted} 丢弃尚未显示的 pending（旧回复作废）', () => {
  const { cue, shown, clock } = makeCue();
  cue.onIntentResolved('古い返事です。');
  cue.onSpeechEnded({ reason: 'interrupted' });

  assert.deepEqual(shown, [], '被打断的旧回复不得冒出一行字');
  assert.equal(cue.snapshot().pending, null);
  assert.equal(clock.pending, 0);
});

// ---------------------------------------------------------------------------
// D6：failsafe
// ---------------------------------------------------------------------------

test('ADR 0021 D6：15s 内没有 speech_started → 提前显示 pending（6s 停留）', () => {
  const { cue, shown, clock } = makeCue();
  cue.onIntentResolved('……聞いています。');

  clock.advance(SUBTITLE_PENDING_FAILSAFE_MS - 1);
  assert.deepEqual(shown, [], '没到点不得提前显示');

  clock.advance(1);
  assert.deepEqual(shown, [{ text: '……聞いています。', holdMs: SUBTITLE_HOLD_MS }]);
  assert.equal(cue.snapshot().visible, true);
  assert.equal(clock.pending, 0);
});

test('ADR 0021 D6：failsafe 触发后 speech_started 到达，仍刷新显示', () => {
  const { cue, shown, clock } = makeCue();
  cue.onIntentResolved('はい。');
  clock.advance(SUBTITLE_PENDING_FAILSAFE_MS);
  cue.onSpeechStarted({ text: 'はい。' });

  assert.equal(shown.length, 2);
  assert.deepEqual(shown[1], { text: 'はい。', holdMs: null });
});

// ---------------------------------------------------------------------------
// 打断 / 替换 / 边界
// ---------------------------------------------------------------------------

test('新回复到达时，上一条仍在屏幕上的字幕先收起（不留旧文本）', () => {
  const { cue, hidden, shown } = makeCue();
  cue.onIntentResolved('前の返事。');
  cue.onSpeechStarted({ text: '前の返事。' });
  cue.onIntentResolved('次の返事。');

  assert.equal(hidden.length, 1);
  assert.equal(shown.length, 1, '新回复尚未开口，不得显示它');
  assert.equal(cue.snapshot().pending, '次の返事。');
});

test('空文本：不显示、不武装 failsafe、不覆盖已有 pending', () => {
  const { cue, shown, clock } = makeCue();
  cue.onIntentResolved('   ');
  assert.deepEqual(shown, []);
  assert.equal(clock.pending, 0);
  assert.equal(cue.snapshot().pending, null);
});

test('dispose() 取消 failsafe，不留定时器', () => {
  const { cue, clock } = makeCue();
  cue.onIntentResolved('はい。');
  assert.equal(clock.pending, 1);
  cue.dispose();
  assert.equal(clock.pending, 0);
  assert.equal(cue.snapshot().pending, null);
});

test('缺载荷的 speech 事件不抛异常（跨进程载荷可能被丢弃）', () => {
  const { cue, shown } = makeCue();
  assert.doesNotThrow(() => cue.onSpeechStarted(null));
  assert.doesNotThrow(() => cue.onSpeechEnded(undefined));
  assert.deepEqual(shown, []);
});
