import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MEMORY_SEGMENT_MAX_CHARS,
  WORLD_APP_TITLE_MAX_CHARS,
  WORLD_SEGMENT_MAX_CHARS,
} from '../../shared/constants';
import type { MemoryFact } from '../../shared/memory-types';
import type { PresenceSnapshot, WorldFacts } from '../../shared/world-types';
import {
  OUTPUT_CONTRACT,
  buildPrompt,
  dedupeMemoryFacts,
  formatMemoryFacts,
  formatRelativeDay,
} from './prompt';
import { buildWorldFacts, formatElapsedJa, formatWorldSegment, formatWorldStamp } from './world';

/** 用本地时区构造时间，断言才不会随运行环境的 TZ 漂移。 */
const AT = new Date(2026, 10, 1, 21, 14, 0).getTime();

function world(overrides: Partial<WorldFacts> = {}): WorldFacts {
  return {
    now: AT,
    userIdleMs: 90_000,
    // ADR 0032 D1：段 3.5 只认归一化类别
    foregroundCategory: 'coding',
    lastInteractionAt: AT - 12 * 60_000,
    ...overrides,
  };
}

test('formatElapsedJa：秒（<2min）/ 分 / 時間 / 日 四档，向下取整', () => {
  assert.equal(formatElapsedJa(1_200), '1 秒');
  assert.equal(formatElapsedJa(90_000), '90 秒');
  assert.equal(formatElapsedJa(59_999), '60 秒');
  assert.equal(formatElapsedJa(60_000), '60 秒');
  assert.equal(formatElapsedJa(119_999), '120 秒');
  assert.equal(formatElapsedJa(120_000), '2 分');
  assert.equal(formatElapsedJa(12 * 60_000 + 33_000), '12 分');
  assert.equal(formatElapsedJa(2 * 3_600_000), '2 時間');
  assert.equal(formatElapsedJa(3 * 86_400_000), '3 日');
  assert.equal(formatElapsedJa(-1), '1 秒', '负数夹到下限，不产出 0 秒');
});

test('formatWorldStamp：YYYY-MM-DD HH:mm，补零', () => {
  assert.equal(formatWorldStamp(AT), '2026-11-01 21:14');
  assert.equal(formatWorldStamp(new Date(2026, 0, 2, 3, 4).getTime()), '2026-01-02 03:04');
  assert.equal(formatWorldStamp(Number.NaN), '----/--/-- --:--');
});

test('段 3.5：分项齐全时的完整格式（ADR 0032 D2 的形态）', () => {
  const text = formatWorldSegment(world());
  assert.equal(
    text,
    '環境: 2026-11-01 21:14 / 先生は 90 秒前まで入力中 / 前面のアプリ: coding / 先生は今、プログラミングに集中している / 前回の会話から 12 分',
  );
  assert.ok(text.length <= WORLD_SEGMENT_MAX_CHARS);
});

test('段 3.5：正在输入（<5s）用"今入力中"，不提"多久之前"', () => {
  assert.equal(
    formatWorldSegment(world({ userIdleMs: 1200, lastInteractionAt: null })),
    '環境: 2026-11-01 21:14 / 先生は今入力中 / 前面のアプリ: coding / 先生は今、プログラミングに集中している',
  );
});

test('段 3.5：缺项整段省略（不写"未知"），只剩时间戳也合法', () => {
  assert.equal(
    formatWorldSegment(
      world({ userIdleMs: null, foregroundCategory: '', lastInteractionAt: null }),
    ),
    '環境: 2026-11-01 21:14',
  );

  // 未命中规则的应用走 `other: <类名>` 降级
  assert.match(
    formatWorldSegment(world({ foregroundCategory: 'other: Notepad' })),
    /前面のアプリ: other: Notepad/,
  );
});

test('段 3.5：只有 coding 才追加"编程中"的提示句（ADR 0032 D2）', () => {
  const hint = '先生は今、プログラミングに集中している';
  for (const category of ['browser', 'game', 'meeting', 'video', 'other: Notepad', ''] as const) {
    const text = formatWorldSegment(world({ foregroundCategory: category }));
    assert.ok(!text.includes(hint), `${category} 不该出现编程提示`);
  }
  assert.ok(formatWorldSegment(world({ foregroundCategory: 'coding' })).includes(hint));
  // 提示句只在段 3.5 出现一次，且排在应用类别之后
  const coding = formatWorldSegment(world({ foregroundCategory: 'coding' }));
  assert.equal(coding.split(hint).length, 2);
  assert.ok(coding.indexOf(hint) > coding.indexOf('前面のアプリ: coding'));
});

test('段 3.5：应用类别过长时先截类别，仍超长则按"尾优先"丢弃，时间戳永在', () => {
  const long = formatWorldSegment(world({ foregroundCategory: `other: ${'x'.repeat(300)}` }));
  assert.ok(long.length <= WORLD_SEGMENT_MAX_CHARS, `实际 ${long.length}`);
  assert.ok(long.startsWith('環境: 2026-11-01 21:14'));
  assert.ok(long.includes('…'), '先截断类别而不是整段丢弃');

  // 极端：类别 + 各项全超长 → 降级到只剩时间戳也绝不超预算
  const extreme = formatWorldSegment({
    now: AT,
    userIdleMs: 4 * 86_400_000,
    foregroundCategory: `other: ${'y'.repeat(500)}`,
    lastInteractionAt: 0,
  });
  assert.ok(extreme.length <= WORLD_SEGMENT_MAX_CHARS, `实际 ${extreme.length}`);
  assert.ok(extreme.startsWith('環境: 2026-11-01 21:14'));
});

test('段 3.5：应用类别截断上限独立于 presence 的类名上限', () => {
  const text = formatWorldSegment(
    world({ foregroundCategory: `other: ${'a'.repeat(WORLD_APP_TITLE_MAX_CHARS + 40)}` }),
  );
  assert.match(text, /a{20}/);
  assert.ok(text.length <= WORLD_SEGMENT_MAX_CHARS);
});

test('buildWorldFacts：只搬归一化类别，原始标题不进 WorldFacts（ADR 0032 D1）', () => {
  const presence: PresenceSnapshot = {
    userIdleMs: 90_000,
    foregroundTitle: 'report-final-含敏感文件名.docx - Word',
    foregroundClass: 'OpusApp',
    foregroundCategory: 'other: OpusApp',
    at: AT,
  };
  const facts = buildWorldFacts({ now: AT, presence, lastInteractionAt: null });
  assert.deepEqual(facts, {
    now: AT,
    userIdleMs: 90_000,
    foregroundCategory: 'other: OpusApp',
    lastInteractionAt: null,
  });
  assert.ok(!('foregroundTitle' in facts), 'WorldFacts 上不得存在标题字段');
  assert.ok(!formatWorldSegment(facts).includes('敏感文件名'), '提示词里不得出现原始标题');

  // 没有 presence（koffi 缺失）→ 类别为空，段 3.5 省略该分项
  const empty = buildWorldFacts({ now: AT, presence: null, lastInteractionAt: null });
  assert.equal(empty.foregroundCategory, '');
  assert.equal(empty.userIdleMs, null);
});

test('buildPrompt：不传 world 时与 1.9.0 逐字节一致（现有单测零改动的保证）', () => {
  const messages = buildPrompt({ card: '角色卡正文', memory: [], history: [], userText: '你好' });
  assert.equal(
    messages[0]?.content,
    [OUTPUT_CONTRACT, '', '角色卡：', '角色卡正文', '', '记忆片段：（无）'].join('\n'),
  );
});

test('buildPrompt：world 插在段 3 与段 4 之间，system 只多一段', () => {
  const messages = buildPrompt({
    card: '角色卡正文',
    memory: ['[今日] 用户: 记忆一'],
    history: [{ user: '旧问题', assistant: '旧回答' }],
    userText: '当前问题',
    world: world(),
  });
  const system = messages[0]?.content ?? '';
  const memoryIndex = system.indexOf('记忆片段');
  const worldIndex = system.indexOf('環境:');
  assert.ok(memoryIndex >= 0 && worldIndex > memoryIndex, '段 3.5 必须在段 3 之后');
  assert.equal(system.match(/環境:/gu)?.length, 1, '段 3.5 只能出现一次');
  assert.ok(!system.includes('学生'), '段 3.5 不得混入角色描述');

  // 段 4 仍然是交替消息，没有被打乱
  assert.deepEqual(
    messages.slice(1).map((message) => `${message.role}:${message.content}`),
    ['user:旧问题', 'assistant:旧回答', 'user:当前问题'],
  );
});

test('formatRelativeDay：按本地日历天计算，跨零点算"昨日"', () => {
  const now = new Date(2026, 10, 1, 0, 10).getTime();
  assert.equal(formatRelativeDay(new Date(2026, 9, 31, 23, 50).getTime(), now), '昨日');
  assert.equal(formatRelativeDay(new Date(2026, 10, 1, 0, 0).getTime(), now), '今日');
  assert.equal(formatRelativeDay(new Date(2026, 9, 29, 12, 0).getTime(), now), '3日前');
  assert.equal(formatRelativeDay(new Date(2026, 6, 1, 12, 0).getTime(), now), '4ヶ月前');
  assert.equal(formatRelativeDay(new Date(2024, 6, 1, 12, 0).getTime(), now), '2年前');
});

const fact = (overrides: Partial<MemoryFact> & { id: number }): MemoryFact => ({
  at: AT - 3 * 86_400_000,
  kind: 'user',
  text: '我喜欢喝咖啡。',
  tags: ['like:咖啡'],
  ...overrides,
});

test('formatMemoryFacts：传 now → 相对时间；不传 → 保持 1.9.0 的绝对时间', () => {
  const facts = [fact({ id: 1 })];
  assert.deepEqual(formatMemoryFacts(facts, 5, AT), ['[3日前] 用户: 我喜欢喝咖啡。']);
  assert.deepEqual(formatMemoryFacts(facts), ['[10-29] 用户: 我喜欢喝咖啡。']);
});

test('去冗余：同 tags 且三字组高度重合只留一条，不同 tags 各自保留', () => {
  const facts = [
    fact({ id: 1, text: '我喜欢喝咖啡。' }),
    fact({ id: 2, text: '我喜欢喝咖啡！' }), // 只差标点 → 重合
    fact({ id: 3, text: '我喜欢喝红茶。', tags: ['like:红茶'] }),
  ];
  const deduped = dedupeMemoryFacts(facts);
  assert.deepEqual(
    deduped.map((item) => item.id),
    [1, 3],
  );

  // tags 不同即视为不同事实，即使文本相近
  const differentTags = [
    fact({ id: 4, text: '我喜欢喝咖啡。', tags: ['like:咖啡'] }),
    fact({ id: 5, text: '我喜欢喝咖啡。', tags: [] }),
  ];
  assert.equal(dedupeMemoryFacts(differentTags).length, 2);
});

test('formatMemoryFacts：总字符预算 360，超出即停（不二次截断行内文本）', () => {
  // 每条用完全不同的字，确保不会被去冗余合并掉，只剩预算在起作用
  const facts = Array.from({ length: 6 }, (_item, index) =>
    fact({ id: index + 1, text: String.fromCharCode(0x3042 + index * 8).repeat(130) }),
  );
  const lines = formatMemoryFacts(facts, 5, AT);
  assert.ok(lines.length < 5, `预算生效后条数应少于 5，实际 ${lines.length}`);
  const total = lines.join('').length;
  assert.ok(total <= MEMORY_SEGMENT_MAX_CHARS, `总字符 ${total}`);
  // 行内文本仍以单条 120 字上限的省略号为结尾：预算只减少条数，不改写正文
  assert.ok(lines.every((line) => line.endsWith('…')));
});
