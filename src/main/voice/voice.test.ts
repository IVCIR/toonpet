import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import type { EventName, EventPayloads } from '../../shared/events';
import type { EventBus, RendererSink } from '../event-bus';
import { createTtsClient } from './gpt-sovits-client';
import type { TtsClient } from './gpt-sovits-client';
import { createVoice } from './index';
import type { Voice } from './index';
import { isSpeechReport } from './report-guard';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function makeWav(durationMs = 300, sampleRate = 16000): Buffer {
  const samples = Math.max(1, Math.floor((sampleRate * durationMs) / 1000));
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000);
    data.writeInt16LE(value, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

interface StubServer {
  url: string;
  hits: number;
  close(): Promise<void>;
}

async function startStub(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<StubServer> {
  const server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('桩服务未拿到端口');
  const stub: StubServer = {
    url: `http://127.0.0.1:${address.port}`,
    hits: 0,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  const original = handler;
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    stub.hits += 1;
    original(req, res);
  });
  return stub;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeBus implements EventBus {
  readonly events: Array<{ name: EventName; payload: EventPayloads[EventName] }> = [];
  readonly commands: Array<{ channel: string; payload: unknown }> = [];
  setRendererSink(_sink: RendererSink | null): void {
    void _sink;
  }
  emit<K extends EventName>(name: K, payload: EventPayloads[K]): void {
    this.events.push({ name, payload });
  }
  subscribe<K extends EventName>(_name: K, _handler: (payload: EventPayloads[K]) => void): () => void {
    return () => undefined;
  }
  sendCommand(channel: string, payload: unknown): boolean {
    this.commands.push({ channel, payload });
    return true;
  }
  named<K extends EventName>(name: K): EventPayloads[K][] {
    return this.events.filter((event) => event.name === name).map((event) => event.payload as EventPayloads[K]);
  }
}

function ttsConfig(url: string, overrides: Partial<Parameters<typeof createTtsClient>[0]> = {}) {
  return {
    baseUrl: url,
    refAudioPath: 'C:/fake/ref.wav',
    promptText: '参考音频文本',
    // ADR 0019：参考音频日文、合成回复中文
    promptLang: 'ja',
    textLang: 'zh',
    firstByteTimeoutMs: 300,
    totalTimeoutMs: 2000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GPT-SoVITS 客户端
// ---------------------------------------------------------------------------

test('TTS 客户端：200 + WAV → ok，请求体字段符合 api_v2（ADR 0015 D2.3）', async () => {
  let body: Record<string, unknown> = {};
  const stub = await startStub((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      body = JSON.parse(raw) as Record<string, unknown>;
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(makeWav());
    });
  });

  try {
    const client = createTtsClient(ttsConfig(stub.url), { exists: () => true });
    assert.equal(client.enabled, true);
    const result = await client.synthesize('你好');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.mime, 'audio/wav');
      assert.ok(result.audio.byteLength > 44);
    }
    assert.equal(body['text'], '你好');
    assert.equal(body['text_lang'], 'zh');
    assert.equal(body['prompt_lang'], 'ja');
    assert.equal(body['streaming_mode'], false);
    assert.equal(body['media_type'], 'wav');
    assert.equal(body['ref_audio_path'], 'C:/fake/ref.wav');
  } finally {
    await stub.close();
  }
});

test('TTS 客户端：prompt_lang / text_lang 来自 TtsConfig，不硬编码（ADR 0019）', async () => {
  let body: Record<string, unknown> = {};
  const stub = await startStub((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      body = JSON.parse(raw) as Record<string, unknown>;
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(makeWav());
    });
  });

  try {
    // 故意用与默认值不同的组合，证明请求体确实读配置而不是写死 ja/zh
    const client = createTtsClient(ttsConfig(stub.url, { promptLang: 'en', textLang: 'ko' }), {
      exists: () => true,
    });
    const result = await client.synthesize('안녕하세요');
    assert.equal(result.ok, true);
    assert.equal(body['prompt_lang'], 'en');
    assert.equal(body['text_lang'], 'ko');
  } finally {
    await stub.close();
  }
});

test('TTS 客户端：HTTP 400 的 message 被带进 detail；200 但非 WAV → invalid_audio', async () => {
  const bad = await startStub((_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'ref_audio_path is required' }));
  });
  try {
    const client = createTtsClient(ttsConfig(bad.url), { exists: () => true });
    const result = await client.synthesize('你好');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'http');
      assert.match(result.detail ?? '', /ref_audio_path is required/);
    }
  } finally {
    await bad.close();
  }

  const notWav = await startStub((_req, res) => {
    res.writeHead(200, { 'content-type': 'audio/wav' });
    res.end(Buffer.from('not a wav file at all'));
  });
  try {
    const client = createTtsClient(ttsConfig(notWav.url), { exists: () => true });
    const result = await client.synthesize('你好');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'invalid_audio');
  } finally {
    await notWav.close();
  }
});

test('TTS 客户端：首字节超时 → timeout（默认 3000ms 可被 CPU 部署放宽）', async () => {
  const stub = await startStub((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(makeWav());
    }, 400);
  });
  try {
    const client = createTtsClient(ttsConfig(stub.url, { firstByteTimeoutMs: 100 }), { exists: () => true });
    const started = Date.now();
    const result = await client.synthesize('你好');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'timeout');
    assert.ok(Date.now() - started < 350, '必须在首字节预算附近中止');
  } finally {
    await stub.close();
  }
});

test('TTS 客户端：整段超时 → timeout（响应头已到、响应体未完）', async () => {
  const stub = await startStub((_req, res) => {
    res.writeHead(200, { 'content-type': 'audio/wav' });
    res.write(makeWav().subarray(0, 20));
    setTimeout(() => res.end(), 500);
  });
  try {
    const client = createTtsClient(ttsConfig(stub.url, { firstByteTimeoutMs: 1000, totalTimeoutMs: 150 }), {
      exists: () => true,
    });
    const result = await client.synthesize('你好');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'timeout');
  } finally {
    await stub.close();
  }
});

test('TTS 客户端：外部取消 → aborted', async () => {
  const stub = await startStub((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(makeWav());
    }, 400);
  });
  try {
    const client = createTtsClient(ttsConfig(stub.url, { firstByteTimeoutMs: 1000 }), { exists: () => true });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    const result = await client.synthesize('你好', { signal: controller.signal });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'aborted');
  } finally {
    await stub.close();
  }
});

test('TTS 客户端：参考音频/提示文本缺失 → disabled，且不发起 HTTP', async () => {
  const stub = await startStub((_req, res) => {
    res.writeHead(500);
    res.end();
  });
  try {
    const client = createTtsClient(ttsConfig(stub.url), { exists: () => false });
    assert.equal(client.enabled, false);
    assert.match(client.disabledReason ?? '', /参考音频不存在/);
    const result = await client.synthesize('你好');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'disabled');
    assert.equal(stub.hits, 0);

    const noPrompt = createTtsClient(ttsConfig(stub.url, { promptText: '  ' }), { exists: () => true });
    assert.equal(noPrompt.enabled, false);
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// voice 状态机
// ---------------------------------------------------------------------------

interface FakeTts extends TtsClient {
  calls: number;
  texts: string[];
}

function makeTts(options: { enabled?: boolean; delayMs?: number } = {}): FakeTts {
  const tts: FakeTts = {
    baseUrl: 'http://127.0.0.1:9880',
    enabled: options.enabled ?? true,
    disabledReason: options.enabled === false ? '参考音频不存在' : null,
    calls: 0,
    texts: [],
    async synthesize(text: string): Promise<{ ok: true; audio: ArrayBuffer; mime: 'audio/wav' }> {
      tts.calls += 1;
      tts.texts.push(text);
      if (options.delayMs) await sleep(options.delayMs);
      return { ok: true, audio: new Uint8Array([82, 73, 70, 70]).buffer, mime: 'audio/wav' };
    },
  };
  return tts;
}

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await sleep(5);
  }
}

function makeVoice(tts: TtsClient): { voice: Voice; bus: FakeBus } {
  const bus = new FakeBus();
  return { voice: createVoice({ bus, tts, log: () => undefined }), bus };
}

/**
 * `speech_ended` 的失败载荷断言。
 *
 * `durationMs` 是"本次尝试耗时"（`now() - startedAt`），机器快时会取到 1ms；
 * 旧测试写死 0，属于**时序敏感**断言（本轮实测偶发失败）。这里允许 0–50ms，
 * 同时仍然锁住"只发一条、reason/utteranceId 正确"。
 */
function assertStrictEqualEnded(
  events: Array<{ utteranceId: string; reason: string; durationMs: number }>,
  utteranceId: string,
  reason: string,
): void {
  assert.equal(events.length, 1, '只应发一条 speech_ended');
  const event = events[0]!;
  assert.equal(event.utteranceId, utteranceId);
  assert.equal(event.reason, reason);
  assert.ok(
    Number.isFinite(event.durationMs) && event.durationMs >= 0 && event.durationMs <= 50,
    `durationMs 应为尝试耗时（0–50ms），实际 ${event.durationMs}`,
  );
}

test('voice：TTS 未配置 → speak 兑现 failed，并发 speech_ended{failed}，不发命令', async () => {
  const { voice, bus } = makeVoice(makeTts({ enabled: false }));
  const outcome = await voice.speak('你好', 'u1');

  assert.equal(outcome, 'failed');
  assertStrictEqualEnded(bus.named('speech_ended'), 'u1', 'failed');
  assert.equal(bus.commands.length, 0);
});

test('voice：正常路径 —— 下发 speak → 渲染上报 started → completed', async () => {
  const { voice, bus } = makeVoice(makeTts());
  const pending = voice.speak('老师，早上好。', 'u1');
  await until(() => bus.commands.length === 1);

  const speakCommand = bus.commands[0]?.payload as { kind: string; utteranceId: string; mime: string };
  assert.equal(speakCommand.kind, 'speak');
  assert.equal(speakCommand.utteranceId, 'u1');
  assert.equal(speakCommand.mime, 'audio/wav');

  voice.handleSpeechReport({ utteranceId: 'u1', phase: 'started' });
  assert.deepEqual(bus.named('speech_started'), [{ utteranceId: 'u1', text: '老师，早上好。' }]);

  voice.handleSpeechReport({ utteranceId: 'u1', phase: 'ended', reason: 'completed', durationMs: 800 });
  assert.equal(await pending, 'completed');
  const ended = bus.named('speech_ended')[0] as { reason: string; durationMs: number };
  assert.equal(ended.reason, 'completed');
  assert.ok(ended.durationMs >= 0);
});

test('voice：stopSpeaking → interrupted，且先下发 stop 命令（§12 打断序列）', async () => {
  const { voice, bus } = makeVoice(makeTts());
  const pending = voice.speak('一句话', 'u1');
  await until(() => bus.commands.length === 1);
  voice.handleSpeechReport({ utteranceId: 'u1', phase: 'started' });

  voice.stopSpeaking('interrupt');
  assert.equal(await pending, 'interrupted');
  const stopCommand = bus.commands[1]?.payload as { kind: string; utteranceId: string };
  assert.equal(stopCommand.kind, 'stop');
  assert.equal(stopCommand.utteranceId, 'u1');
  assert.equal((bus.named('speech_ended')[0] as { reason: string }).reason, 'interrupted');

  // 幂等：再次调用不产生新事件/命令
  voice.stopSpeaking('interrupt');
  assert.equal(bus.named('speech_ended').length, 1);
  assert.equal(bus.commands.length, 2);
});

test('voice：新 speak 以 interrupted 结束旧语音，单一在途', async () => {
  const { voice, bus } = makeVoice(makeTts());
  const first = voice.speak('第一句', 'u1');
  await until(() => bus.commands.length === 1);

  const second = voice.speak('第二句', 'u2');
  assert.equal(await first, 'interrupted');
  await until(() => bus.commands.length >= 3);

  const kinds = bus.commands.map((command) => (command.payload as { kind: string }).kind);
  assert.deepEqual(kinds, ['speak', 'stop', 'speak']);
  const firstEnded = bus.named('speech_ended')[0] as { utteranceId: string; reason: string };
  assert.equal(firstEnded.utteranceId, 'u1');
  assert.equal(firstEnded.reason, 'interrupted');

  voice.handleSpeechReport({ utteranceId: 'u2', phase: 'started' });
  voice.handleSpeechReport({ utteranceId: 'u2', phase: 'ended', reason: 'completed', durationMs: 100 });
  assert.equal(await second, 'completed');
});

test('voice：>120 字直接 failed，不发 HTTP（§7.4）', async () => {
  const tts = makeTts();
  const { voice, bus } = makeVoice(tts);
  const outcome = await voice.speak('长'.repeat(121), 'u1');

  assert.equal(outcome, 'failed');
  assert.equal(tts.calls, 0);
  assertStrictEqualEnded(bus.named('speech_ended'), 'u1', 'failed');
});

test('voice：陈旧的 cmd:speech（不同 utteranceId）被忽略', async () => {
  const { voice, bus } = makeVoice(makeTts());
  const pending = voice.speak('一句话', 'u1');
  await until(() => bus.commands.length === 1);

  voice.handleSpeechReport({ utteranceId: 'other', phase: 'started' });
  assert.equal(bus.named('speech_started').length, 0);

  voice.handleSpeechReport({ utteranceId: 'u1', phase: 'started' });
  voice.handleSpeechReport({ utteranceId: 'u1', phase: 'ended', reason: 'completed', durationMs: 1 });
  assert.equal(await pending, 'completed');
});

test('report-guard：非法载荷被拒绝，合法载荷通过', () => {
  assert.equal(isSpeechReport({ utteranceId: 'u1', phase: 'started' }), true);
  assert.equal(isSpeechReport({ utteranceId: 'u1', phase: 'ended', reason: 'failed', durationMs: 12 }), true);
  assert.equal(isSpeechReport({ utteranceId: 'u1', phase: 'ended', reason: 'interrupted', durationMs: 12 }), false);
  assert.equal(isSpeechReport({ utteranceId: '', phase: 'started' }), false);
  assert.equal(isSpeechReport({ utteranceId: 'u1', phase: 'ended', reason: 'failed', durationMs: -1 }), false);
  assert.equal(isSpeechReport({ utteranceId: 'u1', phase: 'ended', reason: 'completed', durationMs: Number.NaN }), false);
  assert.equal(isSpeechReport(null), false);
});
