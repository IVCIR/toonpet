import assert from 'node:assert/strict';
import test from 'node:test';
import { PRESENCE_SAMPLE_INTERVAL_MS, PRESENCE_TITLE_MAX_CHARS } from '../shared/constants';
import { createPresence, sanitizeWindowText } from './presence';
import type { PresenceBindings } from './presence';

interface FakeOptions {
  idle?: number | null | (() => number | null);
  title?: string;
  className?: string;
  throwOnIdle?: boolean;
}

function makeBindings(options: FakeOptions = {}): { bindings: PresenceBindings; calls: () => number } {
  let calls = 0;
  const bindings: PresenceBindings = {
    readIdleMs(): number | null {
      calls += 1;
      if (options.throwOnIdle) throw new Error('user32 boom');
      if (typeof options.idle === 'function') return options.idle();
      return options.idle === undefined ? 1234 : options.idle;
    },
    readForeground() {
      return {
        title: options.title ?? 'Visual Studio Code',
        className: options.className ?? 'Chrome_WidgetWin_1',
      };
    },
  };
  return { bindings, calls: () => calls };
}

test('presence：首次读采样一次，2s 内复用，超过 2s 重采（懒采样，无定时器）', () => {
  let clock = 1_000;
  const fake = makeBindings({ idle: 4321 });
  const presence = createPresence({ now: () => clock, loadBindings: () => fake.bindings });

  const first = presence.getSnapshot();
  assert.equal(first.userIdleMs, 4321);
  assert.equal(first.foregroundTitle, 'Visual Studio Code');
  assert.equal(first.foregroundClass, 'Chrome_WidgetWin_1');
  // ADR 0032 D1：采样点就归一化，下游（段 3.5）拿不到原始标题
  assert.equal(first.foregroundCategory, 'coding');
  assert.equal(fake.calls(), 1);
  assert.equal(first.at, clock);

  // 2s 内：同一个对象、不再调 Win32
  clock += PRESENCE_SAMPLE_INTERVAL_MS - 1;
  assert.equal(presence.getSnapshot(), first);
  assert.equal(fake.calls(), 1, '节流期内不得重复采样');

  // 到点：重采
  clock += 1;
  const second = presence.getSnapshot();
  assert.notEqual(second, first);
  assert.equal(fake.calls(), 2);
  assert.equal(second.at, clock);
});

test('presence：时钟回拨（时钟倒退）时强制重采，不返回未来时刻的陈旧读数', () => {
  let clock = 10_000;
  const fake = makeBindings({ idle: () => clock / 10 });
  const presence = createPresence({ now: () => clock, loadBindings: () => fake.bindings });

  presence.getSnapshot();
  clock = 5_000; // 回拨
  presence.getSnapshot();
  assert.equal(fake.calls(), 2);
});

test('presence：koffi 缺失（loadBindings 抛错）→ 一律 null，永不抛异常', () => {
  const presence = createPresence({
    now: () => 1,
    loadBindings: () => {
      throw new Error('Cannot find module koffi');
    },
  });
  const snapshot = presence.getSnapshot();
  assert.equal(snapshot.userIdleMs, null);
  assert.equal(snapshot.foregroundTitle, '');
  assert.equal(snapshot.foregroundClass, '');
  assert.equal(snapshot.foregroundCategory, '', '读不到就没有类别，段 3.5 整项省略');
});

test('presence：readIdleMs 抛错时整体降级为"未知"，不把异常抛给调用方', () => {
  const fake = makeBindings({ throwOnIdle: true });
  const presence = createPresence({ now: () => 1, loadBindings: () => fake.bindings });
  const snapshot = presence.getSnapshot();
  assert.equal(snapshot.userIdleMs, null);
  assert.equal(snapshot.foregroundTitle, '', '读空闲失败时不下发标题：半真半假的读数比没有更危险');
});

test('presence：空闲毫秒为 null 或负数时统一折算为 null', () => {
  const nullIdle = createPresence({
    now: () => 1,
    loadBindings: () => makeBindings({ idle: null }).bindings,
  });
  assert.equal(nullIdle.getSnapshot().userIdleMs, null);

  const negative = createPresence({
    now: () => 2,
    loadBindings: () => makeBindings({ idle: -5 }).bindings,
  });
  assert.equal(negative.getSnapshot().userIdleMs, null);
});

test('presence：没有前台窗口时标题与类名都是空串', () => {
  const presence = createPresence({
    now: () => 1,
    loadBindings: () => ({
      readIdleMs: () => 100,
      readForeground: () => null,
    }),
  });
  const snapshot = presence.getSnapshot();
  assert.equal(snapshot.userIdleMs, 100);
  assert.equal(snapshot.foregroundTitle, '');
  assert.equal(snapshot.foregroundClass, '');
  assert.equal(snapshot.foregroundCategory, '');
});

test('presence：前台标题 → 类别在采样点完成（ADR 0032 D1），不受空闲读数影响', () => {
  const presence = createPresence({
    now: () => 1,
    loadBindings: () =>
      makeBindings({ idle: null, title: '某视频_哔哩哔哩_bilibili', className: 'Chrome_WidgetWin_1' })
        .bindings,
  });
  const snapshot = presence.getSnapshot();
  assert.equal(snapshot.userIdleMs, null);
  assert.equal(snapshot.foregroundCategory, 'video', '空闲读不到也不影响类别归类');
  assert.equal(snapshot.foregroundTitle, '某视频_哔哩哔哩_bilibili', '原始标题仍留在快照里供诊断');
});

test('sanitizeWindowText：控制字符与换行压成单空格（段 3.5 必须单行）', () => {
  assert.equal(sanitizeWindowText('a\nb\tc'), 'a b c');
  assert.equal(sanitizeWindowText('  Visual   Studio  Code  '), 'Visual Studio Code');
  assert.equal(sanitizeWindowText('zero\u200bwidth'), 'zero width');
  assert.equal(sanitizeWindowText(undefined as unknown as string), '');
  assert.equal(sanitizeWindowText('x'.repeat(200)).length, PRESENCE_TITLE_MAX_CHARS);
});
