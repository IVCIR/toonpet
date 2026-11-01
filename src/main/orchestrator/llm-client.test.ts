import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import test from 'node:test';
import { LLM_WARMUP_NUM_PREDICT, LLM_WARMUP_TIMEOUT_MS } from '../../shared/constants';
import type { LlmConfig } from '../config';
import { createLlmClient } from './llm-client';

// ---------------------------------------------------------------------------
// 本地桩服务（与 voice.test.ts 同一手法）：只连回环，不联网、不计费
// ---------------------------------------------------------------------------

interface StubServer {
  url: string;
  requests: Array<{ method: string; url: string; body: string }>;
  close(): Promise<void>;
}

async function startStub(
  handler: (request: IncomingMessage, body: string, response: ServerResponse) => void,
): Promise<StubServer> {
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    request.on('end', () => {
      stub.requests.push({ method: request.method ?? '', url: request.url ?? '', body });
      handler(request, body, response);
    });
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const stub: StubServer = {
    url: '',
    requests: [],
    async close(): Promise<void> {
      // 超时用例里客户端会主动 abort，但套接字可能还挂在服务端；先全部 destroy，避免 close 挂住
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('桩服务未拿到端口');
  stub.url = `http://127.0.0.1:${address.port}`;
  return stub;
}

function makeConfig(baseUrl: string): LlmConfig {
  return { baseUrl, model: 'qwen3:4b', healthTimeoutMs: 800, requestTimeoutMs: 8000 };
}

// ---------------------------------------------------------------------------
// 预热（ADR 0032 D3）
// ---------------------------------------------------------------------------

test('预热：走 /api/generate、1 token、不流式、不要求 JSON（只是把权重读进内存）', async () => {
  const stub = await startStub((_request, _body, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ model: 'qwen3:4b', response: 'H', done: true }));
  });

  try {
    const client = createLlmClient(makeConfig(stub.url));
    assert.equal(typeof client.warmup, 'function', '真实客户端必须实现预热');

    const result = await client.warmup?.();
    assert.equal(result?.ok, true);

    assert.equal(stub.requests.length, 1);
    const request = stub.requests[0];
    assert.equal(request?.method, 'POST');
    assert.equal(request?.url, '/api/generate', '预热不得借用 /api/chat 或 /api/tags');

    const payload = JSON.parse(request?.body ?? '{}') as {
      model?: string;
      prompt?: string;
      stream?: boolean;
      think?: boolean;
      options?: { num_predict?: number };
    };
    assert.equal(payload.model, 'qwen3:4b');
    assert.equal(payload.prompt, 'hi', '极简提示词');
    assert.equal(payload.stream, false);
    assert.equal(payload.think, false);
    assert.equal(payload.options?.num_predict, LLM_WARMUP_NUM_PREDICT);
  } finally {
    await stub.close();
  }
});

test('预热：HTTP 非 2xx → ok=false + reason=error（不抛异常、不重试）', async () => {
  const stub = await startStub((_request, _body, response) => {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'model not found' }));
  });

  try {
    const client = createLlmClient(makeConfig(stub.url));
    const result = await client.warmup?.();
    assert.equal(result?.ok, false);
    if (result && !result.ok) assert.equal(result.reason, 'error');
  } finally {
    await stub.close();
  }
});

test('预热：端口没人监听 → ok=false + reason=unavailable（Ollama 没启动的日常路径）', async () => {
  const stub = await startStub((_request, _body, response) => {
    response.writeHead(200);
    response.end('{}');
  });
  const url = stub.url;
  // 先关掉桩，端口立刻不可连
  await stub.close();

  const client = createLlmClient(makeConfig(url));
  const result = await client.warmup?.();
  assert.equal(result?.ok, false);
  if (result && !result.ok) assert.equal(result.reason, 'unavailable');
});

test('预热：超时 → ok=false + reason=timeout（默认预算留给模型加载，比对话宽得多）', async () => {
  const stub = await startStub((_request, _body, _response) => {
    // 故意不响应：等 deadline 触发
  });

  try {
    const client = createLlmClient(makeConfig(stub.url));
    const result = await client.warmup?.({ timeoutMs: 60 });
    assert.equal(result?.ok, false);
    if (result && !result.ok) assert.equal(result.reason, 'timeout');
    // 默认超时必须明显大于 8s 的对话硬超时：冷加载 4B 权重可能要几十秒
    assert.ok(LLM_WARMUP_TIMEOUT_MS > 8000, `默认预热超时 ${LLM_WARMUP_TIMEOUT_MS}ms`);
  } finally {
    await stub.close();
  }
});

test('预热：baseUrl 末尾的斜杠不会拼出 //api/generate', async () => {
  const stub = await startStub((_request, _body, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ response: 'H', done: true }));
  });

  try {
    const client = createLlmClient(makeConfig(`${stub.url}/`));
    const result = await client.warmup?.();
    assert.equal(result?.ok, true);
    assert.equal(stub.requests[0]?.url, '/api/generate');
  } finally {
    await stub.close();
  }
});
