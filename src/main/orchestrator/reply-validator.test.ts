import assert from 'node:assert/strict';
import test from 'node:test';
import { assertValidReplyShape, parseAndValidateReply, validateReplyText } from './reply-validator';

test('§9.2：合法 JSON 原样通过，不产生修复', () => {
  const out = parseAndValidateReply('{"text":"老师，早上好。","emotion":"neutral","intent":"greet"}');
  assert.equal(out.ok, true);
  assert.deepEqual(out.reply, { text: '老师，早上好。', emotion: 'neutral', intent: 'greet' });
  assert.deepEqual(out.repaired, []);
});

test('§9.2：代码块包裹与前后废话都能提取出 JSON', () => {
  const fenced = parseAndValidateReply('```json\n{"text":"我在听。","emotion":"happy","intent":"nod"}\n```');
  assert.equal(fenced.ok, true);
  assert.equal(fenced.reply?.text, '我在听。');

  const chatty = parseAndValidateReply(
    '好的，结果如下：{"text":"请多指教。","emotion":"shy","intent":"nod"} 以上。',
  );
  assert.equal(chatty.ok, true);
  assert.equal(chatty.reply?.emotion, 'shy');
});

test('§9.2：未知 intent / emotion 只做一次字段修复（→ none / neutral）', () => {
  const out = parseAndValidateReply('{"text":"嗯。","emotion":"excited","intent":"wave"}');
  assert.equal(out.ok, true);
  assert.equal(out.reply?.intent, 'none');
  assert.equal(out.reply?.emotion, 'neutral');
  assert.deepEqual(out.repaired, ['emotion->neutral', 'intent->none']);
});

test('§9.2：大小写/空格不接受的枚举值按未知处理', () => {
  const out = parseAndValidateReply('{"text":"嗯。","emotion":" Happy ","intent":"Nod"}');
  assert.equal(out.ok, true);
  assert.equal(out.reply?.emotion, 'neutral');
  assert.equal(out.reply?.intent, 'none');
});

test('§9.2：缺字段是结构错误，不做修复', () => {
  const out = parseAndValidateReply('{"text":"只有文本"}');
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'structure');
  assert.equal(out.reply, null);
});

test('§9.2：文本含 Markdown / 括号动作 / URL 一律不合法', () => {
  assert.equal(validateReplyText('**你好**').ok, false);
  assert.equal(validateReplyText('（微笑）你好').ok, false);
  assert.equal(validateReplyText('请看 https://example.com').ok, false);
  assert.equal(validateReplyText('`code`').ok, false);
});

test('§9.2：文本长度 1–120（按码点计），换行折成单段', () => {
  assert.equal(validateReplyText('').ok, false);
  assert.equal(validateReplyText('x'.repeat(120)).ok, true);
  assert.equal(validateReplyText('x'.repeat(121)).ok, false);

  // ADR 0022 D3：中日文之间不留半角空格（日文句子被换行折行时不能插空格）
  const wrapped = validateReplyText('第一行\n第二行');
  assert.equal(wrapped.ok, true);
  assert.equal(wrapped.text, '第一行第二行');

  // 拉丁文与中文之间保留空格（那是语义分隔，不是折行造成的）
  const mixed = validateReplyText('OK\n了解');
  assert.equal(mixed.ok, true);
  assert.equal(mixed.text, 'OK 了解');
});

test('§9.2：完全无法解析 → unparseable', () => {
  const out = parseAndValidateReply('我不是 JSON');
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'unparseable');
});

// ---------------------------------------------------------------------------
// ADR 0018 D2：真实 LLM 的"脏输出"清洗（围栏 / 括号动作 / Markdown）
// ---------------------------------------------------------------------------

test('清洗：```json 围栏 + 括号动作 + 粗体 → 合法 Reply', () => {
  const dirty = [
    '```json',
    '{"text":"**老师**，（微笑）今天也要加油哦！","emotion":"happy","intent":"nod"}',
    '```',
  ].join('\n');

  const out = parseAndValidateReply(dirty);
  assert.equal(out.ok, true);
  assert.deepEqual(out.reply, {
    text: '老师，今天也要加油哦！',
    emotion: 'happy',
    intent: 'nod',
  });
  assert.ok(out.repaired.includes('output:fence-stripped'));
  assert.ok(out.repaired.includes('text:decorations-stripped'));
});

test('清洗：无语言标记的围栏 + 斜体包裹的动作描写', () => {
  const out = parseAndValidateReply(
    '```\n{"text":"*（笑）*老师，早上好。","emotion":"shy","intent":"greet"}\n```',
  );
  assert.equal(out.ok, true);
  assert.deepEqual(out.reply, {
    text: '老师，早上好。',
    emotion: 'shy',
    intent: 'greet',
  });
});

test('清洗：前后废话 + 嵌套花括号，仍能提取第一个完整 JSON 对象', () => {
  const out = parseAndValidateReply(
    '结果如下：{"text":"你好。","emotion":"neutral","intent":"none","extra":{"n":1}} 以上。',
  );
  assert.equal(out.ok, true);
  assert.equal(out.reply?.text, '你好。');
  assert.ok(out.repaired.includes('output:json-extracted'));
});

test('清洗：Markdown 标题前缀 + 粗体 + 换行，清洗后单段可朗读', () => {
  const out = parseAndValidateReply(
    '{"text":"# **老师**，\\n早上好。","emotion":"neutral","intent":"greet"}',
  );
  assert.equal(out.ok, true);
  assert.equal(out.reply?.text, '老师，早上好。');
});

test('清洗不放宽校验：只剩括号动作 → text 非法（走兜底）', () => {
  const out = parseAndValidateReply('{"text":"（微笑）","emotion":"happy","intent":"none"}');
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'text');
  assert.equal(out.reply, null);
});

test('清洗不放宽校验：URL 与残留的未配对括号仍被拒绝', () => {
  const url = parseAndValidateReply(
    '{"text":"**请看** https://example.com","emotion":"neutral","intent":"none"}',
  );
  assert.equal(url.ok, false);
  assert.equal(url.reason, 'text');

  const unbalanced = parseAndValidateReply(
    '{"text":"老师（微笑，早上好。","emotion":"neutral","intent":"none"}',
  );
  assert.equal(unbalanced.ok, false);
  assert.equal(unbalanced.reason, 'text');
});

test('清洗：台词池装配不走清洗（**你好** 仍属装配错误）', () => {
  assert.throws(() =>
    assertValidReplyShape(
      { text: '**你好**', emotion: 'neutral', intent: 'none' },
      'lines.fallbacks[0].reply',
    ),
  );
});

// ---------------------------------------------------------------------------
// ADR 0022 D3：日文字符不得被误判
// ---------------------------------------------------------------------------

test('日文：正常日文回复原样通过（含 …… 「」 、 。 ！ ？ ・ ー）', () => {
  const samples = [
    '……先生、おはようございます。今日もよろしくお願いします。',
    'コーヒーがお好きなんですね？',
    '「そんなこと、ありません。」',
    'はい！わかりました。',
    'カフェ・ラテ、飲みますか？',
    'それは……ちょっと、恥ずかしいです。',
  ];
  for (const sample of samples) {
    const checked = validateReplyText(sample);
    assert.equal(checked.ok, true, `${sample} → ${String(checked.detail)}`);
    assert.equal(checked.text, sample);
  }
});

test('日文：结构化输出（全角标点 + 长句）通过并保持原样', () => {
  const raw = JSON.stringify({
    text: '……先生、無理しないでくださいね。私は、ちゃんと見ていますから。',
    emotion: 'shy',
    intent: 'nod',
  });
  const out = parseAndValidateReply(raw);
  assert.equal(out.ok, true);
  assert.equal(out.reply?.text, '……先生、無理しないでくださいね。私は、ちゃんと見ていますから。');
  assert.deepEqual(out.repaired, []);
});

test('日文：括号动作描写（全角）走清洗，不判 invalid_output', () => {
  const out = parseAndValidateReply(
    '{"text":"（小声で）……ありがとう、ございます。","emotion":"shy","intent":"nod"}',
  );
  assert.equal(out.ok, true);
  assert.equal(out.reply?.text, '……ありがとう、ございます。');
  assert.ok(out.repaired.includes('text:decorations-stripped'));
});

test('日文：码点计长度（120 个假名合法，121 个不合法）', () => {
  assert.equal(validateReplyText('あ'.repeat(120)).ok, true);
  assert.equal(validateReplyText('あ'.repeat(121)).ok, false, '长度按码点而不是字节');
  // 缺字段/枚举仍按原规则拒绝
  assert.equal(parseAndValidateReply('{"text":"はい。"}').ok, false);
});

test('日文：URL / 英文括号 / 残留 Markdown 仍判不合法（清洗不放宽）', () => {
  assert.equal(validateReplyText('詳しくは https://example.com を見てください。').ok, false);
  assert.equal(validateReplyText('はい（笑）').ok, false);
  assert.equal(validateReplyText('**はい**').ok, false);
});
