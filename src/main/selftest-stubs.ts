/**
 * 自检专用本地桩（只被 `selftest.ts` 引用，不进入产品路径）。
 *
 * 为什么需要桩：真实验收时本机可能既没有 Ollama 对话模型、也没有 TTS 参考音频，
 * "语音闭环"无法用真实服务跑通。桩提供**确定的**输入：
 * - `PET_LLM_URL` → /api/tags 返回固定模型、/api/chat 按用户话语返回合法或非法 JSON；
 * - `PET_TTS_URL` → /tts 返回一段带幅度调制的 WAV（能产生真实的 RMS 包络）。
 *
 * 两者都只监听 127.0.0.1（§10.2 白名单），不产生任何出站流量。
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SELFTEST_LLM_PORT = 11435;
export const SELFTEST_TTS_PORT = 9881;
export const SELFTEST_OCR_PORT = 8003;
export const SELFTEST_LLM_MODEL = 'selftest-stub:1b';
export const SELFTEST_OCR_MODEL = 'win-ocr-stub';

export interface SelftestStubStats {
  llmChats: number;
  ttsCalls: number;
  ttsFailures: number;
  /** ADR 0054：OCR 端点被调用的次数、收到的图片字节数、失败次数 */
  ocrCalls: number;
  ocrImageBytes: number;
  ocrFailures: number;
  /** ADR 0054：LLM 的 system 段里是否真的出现了 OCR 文字（证明段 3.6 注入了） */
  llmVisionPrompt: boolean;
}

export interface SelftestStubs {
  stats: SelftestStubStats;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    request.on('end', () => resolve(raw));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function makeWav(durationMs: number, sampleRate = 16000): Buffer {
  const samples = Math.max(1, Math.floor((sampleRate * durationMs) / 1000));
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const t = i / sampleRate;
    // 幅度调制（0.45–1.0）→ 包络有起伏，口型帧会变化
    const amplitude = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t));
    const fade = Math.min(1, Math.min(i, samples - i) / (sampleRate * 0.02));
    const value = Math.sin(2 * Math.PI * 220 * t) * amplitude * fade * 20000;
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), i * 2);
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

function lastUserMessage(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown };
    if (message?.role === 'user' && typeof message.content === 'string') return message.content;
  }
  return '';
}

/** 全部消息正文拼接（system 段也要看：视觉上下文只出现在 system 里） */
function fullPrompt(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return '';
  return messages
    .map((message) => {
      const content = (message as { content?: unknown })?.content;
      return typeof content === 'string' ? content : '';
    })
    .join('\n');
}

/**
 * ADR 0054：自检用的 OCR 端点。
 *
 * 它不是假数据：把请求里的 PNG 落盘，调 `scripts/win-ocr.ps1`（Windows.Media.Ocr）**真的识别**，
 * 再把文字按 OpenAI 兼容响应返回。这样"截图 → 文字 → 段 3.6 → LLM"整条链路都是真跑的；
 * 唯一被替换的是 GLM-OCR 本身（本机没装模型）。
 */
function runWindowsOcr(pngPath: string): { ok: true; text: string } | { ok: false; detail: string } {
  const script = path.resolve(process.cwd(), 'scripts', 'win-ocr.ps1');
  const systemRoot = process.env['SystemRoot'] ?? process.env['WINDIR'] ?? 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(
    powershell,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Path', pngPath],
    { encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
  );
  if (result.error) return { ok: false, detail: String(result.error) };
  if (result.status !== 0) {
    return { ok: false, detail: (result.stderr || `powershell exit ${String(result.status)}`).slice(0, 300) };
  }
  return { ok: true, text: (result.stdout || '').trim() };
}

/** 从 OpenAI 兼容请求体里取第一张 data URL 的 base64 */
function firstImageDataUrl(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    const content = (message as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const url = (part as { image_url?: { url?: unknown } })?.image_url?.url;
      if (typeof url === 'string' && url.startsWith('data:image/')) return url;
    }
  }
  return null;
}

function replyFor(prompt: string): string {
  if (prompt.includes('INVALID')) {
    // §9.2：完全无法解析 → invalid_output
    return '这不是一个 JSON 对象';
  }
  if (prompt.includes('NOAUDIO')) {
    return '{"text":"NOAUDIO 测试。","emotion":"neutral","intent":"none"}';
  }
  // ADR 0021：TTS 侧对 SLOWTTS 故意慢 1.2s，用来断言"字幕不早于 speech_started"
  if (prompt.includes('SLOWTTS')) {
    return '{"text":"SLOWTTS 検証用の返事です。","emotion":"neutral","intent":"none"}';
  }
  if (prompt.includes('第一句')) {
    return '{"text":"第一句的回复。","emotion":"neutral","intent":"nod"}';
  }
  if (prompt.includes('第二句')) {
    return '{"text":"第二句的回复。","emotion":"happy","intent":"nod"}';
  }
  // 语言：角色只讲日文（ADR 0022），桩也按同一形态返回，自检才代表真实链路
  return '{"text":"先生、私はここにいます。今日もよろしくお願いします。","emotion":"happy","intent":"nod"}';
}

async function listen(server: Server, port: number, label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      reject(
        new Error(
          `${label} 桩无法监听 127.0.0.1:${port}（${error.code ?? 'error'}）；` +
            '端口可能被占用，或已有外部服务在跑（自检要求端口空闲）',
        ),
      );
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

export async function startSelftestStubs(): Promise<SelftestStubs> {
  const stats: SelftestStubStats = {
    llmChats: 0,
    ttsCalls: 0,
    ttsFailures: 0,
    ocrCalls: 0,
    ocrImageBytes: 0,
    ocrFailures: 0,
    llmVisionPrompt: false,
  };

  const llm = createServer((request, response) => {
    void (async () => {
      if (request.method === 'GET' && request.url?.startsWith('/api/tags')) {
        sendJson(response, 200, { models: [{ name: SELFTEST_LLM_MODEL, model: SELFTEST_LLM_MODEL }] });
        return;
      }
      if (request.method === 'POST' && request.url?.startsWith('/api/chat')) {
        stats.llmChats += 1;
        const raw = await readBody(request);
        let prompt = '';
        let full = '';
        try {
          const parsed = JSON.parse(raw) as unknown;
          prompt = lastUserMessage(parsed);
          full = fullPrompt(parsed);
        } catch {
          prompt = '';
        }
        // ADR 0054：段 3.6 只出现在 system 里；用它证明"OCR 文字真的进了 LLM 请求"
        if (full.includes('VISIONTEST')) {
          stats.llmVisionPrompt = true;
          sendJson(response, 200, {
            message: {
              role: 'assistant',
              content:
                '{"text":"画面には「VISIONTEST」と書いてありますね。","emotion":"happy","intent":"nod"}',
            },
          });
          return;
        }
        sendJson(response, 200, { message: { role: 'assistant', content: replyFor(prompt) } });
        return;
      }
      sendJson(response, 404, { message: 'stub: not found' });
    })().catch(() => {
      if (!response.headersSent) sendJson(response, 500, { message: 'stub error' });
    });
  });

  const ocr = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || !request.url?.startsWith('/v1/chat/completions')) {
        sendJson(response, 404, { error: { message: 'stub: not found' } });
        return;
      }
      stats.ocrCalls += 1;
      const raw = await readBody(request);
      let dataUrl: string | null = null;
      try {
        dataUrl = firstImageDataUrl(JSON.parse(raw));
      } catch {
        dataUrl = null;
      }
      if (!dataUrl) {
        stats.ocrFailures += 1;
        sendJson(response, 400, { error: { message: 'stub: 请求里没有 image_url' } });
        return;
      }
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const png = Buffer.from(base64, 'base64');
      stats.ocrImageBytes = png.length;
      const outputDir = path.join(process.cwd(), 'logs', 'selftest');
      await mkdir(outputDir, { recursive: true });
      const pngPath = path.join(outputDir, 'vision-request.png');
      await writeFile(pngPath, png);
      const recognized = runWindowsOcr(pngPath);
      if (!recognized.ok) {
        stats.ocrFailures += 1;
        sendJson(response, 502, { error: { message: `Windows OCR 失败：${recognized.detail}` } });
        return;
      }
      sendJson(response, 200, {
        choices: [{ message: { role: 'assistant', content: recognized.text }, finish_reason: 'stop' }],
      });
    })().catch((error: unknown) => {
      stats.ocrFailures += 1;
      if (!response.headersSent) sendJson(response, 500, { error: { message: String(error) } });
    });
  });

  const tts = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || !request.url?.startsWith('/tts')) {
        sendJson(response, 404, { message: 'stub: not found' });
        return;
      }
      stats.ttsCalls += 1;
      const raw = await readBody(request);
      let text = '';
      try {
        const parsed = JSON.parse(raw) as { text?: unknown };
        text = typeof parsed.text === 'string' ? parsed.text : '';
      } catch {
        text = '';
      }
      if (text.includes('NOAUDIO')) {
        stats.ttsFailures += 1;
        sendJson(response, 500, { message: 'stub: forced TTS failure' });
        return;
      }
      if (text.includes('SLOWTTS')) {
        // 模拟 CPU 非流式合成的 5–6s：只用于字幕时序断言，不影响其他用例
        await new Promise<void>((resolve) => setTimeout(resolve, 1200));
      }
      response.writeHead(200, { 'content-type': 'audio/wav' });
      response.end(makeWav(1200));
    })().catch(() => {
      if (!response.headersSent) sendJson(response, 500, { message: 'stub error' });
    });
  });

  await listen(llm, SELFTEST_LLM_PORT, 'LLM');
  try {
    await listen(tts, SELFTEST_TTS_PORT, 'TTS');
  } catch (error) {
    await new Promise<void>((resolve) => llm.close(() => resolve()));
    throw error;
  }
  try {
    await listen(ocr, SELFTEST_OCR_PORT, 'OCR');
  } catch (error) {
    await new Promise<void>((resolve) => llm.close(() => resolve()));
    await new Promise<void>((resolve) => tts.close(() => resolve()));
    throw error;
  }

  return {
    stats,
    async close(): Promise<void> {
      // 关闭 keep-alive 连接，否则 server.close() 要等到连接超时（自检会白等数秒）
      llm.closeAllConnections();
      tts.closeAllConnections();
      ocr.closeAllConnections();
      await new Promise<void>((resolve) => llm.close(() => resolve()));
      await new Promise<void>((resolve) => tts.close(() => resolve()));
      await new Promise<void>((resolve) => ocr.close(() => resolve()));
    },
  };
}


