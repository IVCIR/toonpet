import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createVisionOcrClient,
  extractOcrContent,
  normalizeOcrText,
  resolveChatCompletionsUrl,
} from './vision-service';

function png(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('ADR 0054 D1.2：base URL → chat/completions（保留 /v1，裸 origin 补 /v1）', () => {
  assert.equal(
    resolveChatCompletionsUrl('http://127.0.0.1:8000/v1'),
    'http://127.0.0.1:8000/v1/chat/completions',
  );
  assert.equal(
    resolveChatCompletionsUrl('http://127.0.0.1:8000/v1/'),
    'http://127.0.0.1:8000/v1/chat/completions',
  );
  assert.equal(
    resolveChatCompletionsUrl('http://127.0.0.1:8000/v1/chat/completions'),
    'http://127.0.0.1:8000/v1/chat/completions',
  );
  assert.equal(
    resolveChatCompletionsUrl('http://127.0.0.1:8000'),
    'http://127.0.0.1:8000/v1/chat/completions',
  );
});

test('ADR 0054 D3.3：OCR 文本归一化（CJK 空格 / 全角空格 / 代码围栏 / 空行去重 / 截断）', () => {
  const raw = '```text\n桌 宠 控 制 面 板\n\n凯伊 。 参数\nCPU 占用 12%\n';
  const normalized = normalizeOcrText(raw);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.text, '桌宠控制面板\n凯伊。参数\nCPU 占用 12%');
  assert.equal(normalized.rawChars, normalized.text.length);

  const truncated = normalizeOcrText('一二三四五六七八九十', 6);
  assert.equal(truncated.text, '一二三四五…');
  assert.equal(truncated.chars, 6);
  assert.equal(truncated.rawChars, 10);
});

test('ADR 0054 D3.2：请求体是 OpenAI 兼容的 image_url + 文本指令', async () => {
  let seenUrl = '';
  let seenBody: Record<string, unknown> = {};
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    seenUrl = String(url);
    seenBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return jsonResponse({ choices: [{ message: { role: 'assistant', content: '画 面 上 的 字' } }] });
  }) as typeof fetch;

  const client = createVisionOcrClient({
    enabled: true,
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'glm-ocr',
    prompt: '提取文字',
    timeoutMs: 2000,
    fetchImpl,
  });
  const image = png();
  const result = await client.recognize({ png: image, prompt: '只输出纯文本' });

  assert.equal(seenUrl, 'http://127.0.0.1:8000/v1/chat/completions');
  assert.equal(seenBody['model'], 'glm-ocr');
  assert.equal(seenBody['stream'], false);
  const messages = seenBody['messages'] as Array<{ content: Array<Record<string, unknown>> }>;
  const parts = messages[0]?.content ?? [];
  assert.equal((parts[0] as { text?: string }).text, '只输出纯文本');
  assert.equal(
    (parts[1] as { image_url?: { url?: string } }).image_url?.url,
    `data:image/png;base64,${image.toString('base64')}`,
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.text, '画面上的字');
});

test('ADR 0054 D5：HTTP 失败 / 空内容 / 超时 / 关闭 都返回结果对象，不抛异常', async () => {
  const base = {
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'glm-ocr',
    prompt: '提取文字',
  };

  const http500 = createVisionOcrClient({
    ...base,
    enabled: true,
    timeoutMs: 1000,
    fetchImpl: (async () => jsonResponse({ error: 'boom' }, 500)) as typeof fetch,
  });
  const r500 = await http500.recognize({ png: png() });
  assert.equal(r500.ok, false);
  if (!r500.ok) {
    assert.equal(r500.reason, 'unavailable');
    assert.match(r500.detail, /500/);
  }

  const blank = createVisionOcrClient({
    ...base,
    enabled: true,
    timeoutMs: 1000,
    fetchImpl: (async () =>
      jsonResponse({ choices: [{ message: { content: '   \n  ' } }] })) as typeof fetch,
  });
  const rBlank = await blank.recognize({ png: png() });
  assert.equal(rBlank.ok, false);
  if (!rBlank.ok) assert.equal(rBlank.reason, 'empty');

  const timeout = createVisionOcrClient({
    ...base,
    enabled: true,
    timeoutMs: 20,
    fetchImpl: ((_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch,
  });
  const rTimeout = await timeout.recognize({ png: png() });
  assert.equal(rTimeout.ok, false);
  if (!rTimeout.ok) assert.equal(rTimeout.reason, 'timeout');

  const disabled = createVisionOcrClient({
    ...base,
    enabled: false,
    timeoutMs: 1000,
    fetchImpl: (async () => jsonResponse({})) as typeof fetch,
  });
  const rDisabled = await disabled.recognize({ png: png() });
  assert.equal(rDisabled.ok, false);
  if (!rDisabled.ok) assert.equal(rDisabled.reason, 'disabled');

  const noText = createVisionOcrClient({
    ...base,
    enabled: true,
    timeoutMs: 1000,
    fetchImpl: (async () => jsonResponse({ choices: [] })) as typeof fetch,
  });
  const rNoText = await noText.recognize({ png: png() });
  assert.equal(rNoText.ok, false);
  if (!rNoText.ok) assert.equal(rNoText.reason, 'empty');
});

test('ADR 0054 D3.2：兼容 content 数组与 output.text 两种响应形态', () => {
  assert.equal(
    extractOcrContent([{ message: { content: [{ type: 'text', text: '你好' }] } }] as never),
    null,
  );
  assert.equal(
    extractOcrContent({ choices: [{ message: { content: [{ type: 'text', text: '你好' }] } }] }),
    '你好',
  );
  assert.equal(extractOcrContent({ output: { text: '从 output 读' } }), '从 output 读');
  assert.equal(extractOcrContent({ choices: [{ text: '从 choice.text 读' }] }), '从 choice.text 读');
  assert.equal(extractOcrContent(null), null);
});
