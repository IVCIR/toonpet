import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import test from 'node:test';
import { LLM_WARMUP_NUM_PREDICT, LLM_WARMUP_TIMEOUT_MS } from '../../shared/constants';
import { OPENCODE_GO_BASE_URL } from '../../shared/llm-providers';
import type { LlmConfig } from '../config';
import {
  createLlmClient,
  createLlmProvider,
  createOpenAiProvider,
} from './llm-client';

// ---------------------------------------------------------------------------
// 本地桩服务（与 voice.test.ts 同一手法）：只连回环，不联网、不计费
// ---------------------------------------------------------------------------

interface StubServer {
  url: string;
  requests: Array<{
    method: string;
    url: string;
    body: string;
    headers: Record<string, string | string[] | undefined>;
  }>;
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
      stub.requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        body,
        headers: request.headers,
      });
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

// ---------------------------------------------------------------------------
// ADR 0055：OpenAI 兼容 / OpenCode Go
// ---------------------------------------------------------------------------

function makeProvider(baseUrl: string, overrides: Partial<Parameters<typeof createOpenAiProvider>[0]> = {}) {
  return {
    id: 'remote',
    type: 'openai' as const,
    name: '远程模型',
    baseUrl,
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
    ...overrides,
  };
}

test('OpenAI 兼容：health 带 Bearer 读 /models，并按 id 判断模型是否在清单里', async () => {
  const stub = await startStub((_request, _body, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] }));
  });
  try {
    const client = createOpenAiProvider(makeProvider(stub.url), { healthTimeoutMs: 800 });
    const health = await client.health();
    assert.equal(health.ok, true);
    assert.equal(health.reachable, true);
    assert.equal(health.modelPresent, true);
    assert.deepEqual(health.models, ['gpt-4o-mini', 'gpt-4o']);
    assert.equal(stub.requests[0]?.url, '/models');
    assert.equal(stub.requests[0]?.headers['authorization'], 'Bearer sk-test');
  } finally {
    await stub.close();
  }
});

test('OpenAI 兼容：401 明确判失败（不误报"模型缺失"）', async () => {
  const stub = await startStub((_request, _body, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'bad key' }));
  });
  try {
    const client = createOpenAiProvider(makeProvider(stub.url), { healthTimeoutMs: 800 });
    const health = await client.health();
    assert.equal(health.ok, false);
    if (!health.ok) assert.match(health.detail ?? '', /401/);
  } finally {
    await stub.close();
  }
});

test('OpenAI 兼容：端点没有 /models 时退化为 1-token 对话验证 Key', async () => {
  const stub = await startStub((request, _body, response) => {
    if (request.url === '/models') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: '{}' } }] }));
  });
  try {
    const client = createOpenAiProvider(makeProvider(stub.url, { model: 'm' }), { healthTimeoutMs: 800 });
    const health = await client.health();
    assert.equal(health.ok, true);
    assert.equal(health.modelPresent, null);
    assert.equal(stub.requests.some((entry) => entry.url === '/chat/completions'), true);
  } finally {
    await stub.close();
  }
});

test('OpenAI 兼容：chat 发 /chat/completions 并解析 message.content', async () => {
  const stub = await startStub((_request, _body, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: '{"reply":"喵"}' } }] }));
  });
  try {
    const client = createOpenAiProvider(makeProvider(stub.url), { requestTimeoutMs: 800 });
    const result = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.deepEqual(result, { ok: true, content: '{"reply":"喵"}' });
    const request = stub.requests[0];
    assert.equal(request?.url, '/chat/completions');
    assert.equal(request?.headers['authorization'], 'Bearer sk-test');
    const body = JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
    assert.equal(body['model'], 'gpt-4o-mini');
    assert.equal(body['stream'], false);
  } finally {
    await stub.close();
  }
});

test('OpenAI 兼容：超时 → timeout（沿用契约四值）', async () => {
  const stub = await startStub(() => {
    // 故意不回
  });
  try {
    const client = createOpenAiProvider(makeProvider(stub.url, { model: 'm' }), { requestTimeoutMs: 80 });
    const result = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'timeout');
  } finally {
    await stub.close();
  }
});

test('分发：OpenCode Go 强制使用预设端点，而不是配置里的 baseUrl', () => {
  const client = createLlmProvider(
    makeProvider('https://evil.example.com/v1', {
      id: 'oc',
      type: 'opencode-go',
      model: 'glm-5.3-flash',
    }),
  );
  assert.equal(client.providerType, 'opencode-go');
  assert.equal(client.providerId, 'oc');
  assert.equal(client.baseUrl, OPENCODE_GO_BASE_URL);
});

test('分发：Ollama 保持旧行为与身份字段', () => {
  const client = createLlmProvider(
    {
      id: 'local-ollama',
      type: 'ollama',
      name: '本地 Ollama',
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: '',
      model: 'qwen3:4b',
    },
    { requestTimeoutMs: 800 },
  );
  assert.equal(client.providerType, 'ollama');
  assert.equal(client.providerName, '本地 Ollama');
  assert.equal(client.model, 'qwen3:4b');
  assert.equal(typeof client.warmup, 'function');
});

// ---------------------------------------------------------------------------
// ADR 0056：动态模型列表
// ---------------------------------------------------------------------------

test('Ollama fetchModels：GET /api/tags，返回 name 清单', async () => {
  const stub = await startStub((request, _body, response) => {
    if (request.url !== '/api/tags') {
      response.writeHead(404);
      response.end('{}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        models: [{ name: 'qwen3:4b' }, { model: 'qwen2.5:7b' }, { name: 'qwen3:4b' }],
      }),
    );
  });
  try {
    const client = createLlmProvider({
      id: 'local-ollama',
      type: 'ollama',
      name: '本地 Ollama',
      baseUrl: stub.url,
      apiKey: '',
      model: 'qwen3:4b',
    });
    const result = await client.fetchModels();
    assert.deepEqual(result, {
      ok: true,
      models: [
        { id: 'qwen3:4b', name: 'qwen3:4b' },
        { id: 'qwen2.5:7b', name: 'qwen2.5:7b' },
      ],
    });
    assert.equal(stub.requests[0]?.method, 'GET');
    assert.equal(stub.requests[0]?.url, '/api/tags');
  } finally {
    await stub.close();
  }
});

test('OpenAI 兼容 fetchModels：GET /models，Bearer，解析 id/display_name', async () => {
  const stub = await startStub((_request, _body, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        data: [
          { id: 'grok-4.7', display_name: 'Grok 4.7' },
          { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' },
          { id: 'grok-4.7' },
        ],
      }),
    );
  });
  try {
    const client = createOpenAiProvider(makeProvider(stub.url), { healthTimeoutMs: 800 });
    const result = await client.fetchModels();
    assert.deepEqual(result, {
      ok: true,
      models: [
        { id: 'grok-4.7', name: 'Grok 4.7' },
        { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' },
      ],
    });
    assert.equal(stub.requests[0]?.url, '/models');
    assert.equal(stub.requests[0]?.headers['authorization'], 'Bearer sk-test');
  } finally {
    await stub.close();
  }
});

test('OpenAI 兼容 fetchModels：401 给出可读错误，不抛异常', async () => {
  const stub = await startStub((_request, _body, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end('{}');
  });
  try {
    const client = createOpenAiProvider(makeProvider(stub.url), { healthTimeoutMs: 800 });
    const result = await client.fetchModels();
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /401.*API Key/);
  } finally {
    await stub.close();
  }
});

test('OpenAI 兼容 fetchModels：404 明确说明端点不提供 /models', async () => {
  const stub = await startStub((_request, _body, response) => {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{}');
  });
  try {
    const client = createOpenAiProvider(makeProvider(stub.url), { healthTimeoutMs: 800 });
    const result = await client.fetchModels();
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /404.*\/models/);
  } finally {
    await stub.close();
  }
});

test('OpenCode Go fetchModels：固定端点 + Bearer + x-opencode-session', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(
      JSON.stringify({ data: [{ id: 'grok-4.7', name: 'Grok 4.7' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    const client = createOpenAiProvider(
      makeProvider('https://evil.example.com/v1', {
        id: 'oc',
        type: 'opencode-go',
        apiKey: 'sk-oc',
        model: 'glm-5.3-flash',
      }),
    );
    const result = await client.fetchModels();
    assert.deepEqual(result, { ok: true, models: [{ id: 'grok-4.7', name: 'Grok 4.7' }] });
    assert.equal(calls[0]?.url, `${OPENCODE_GO_BASE_URL}/models`);
    assert.equal(calls[0]?.headers['authorization'], 'Bearer sk-oc');
    assert.match(calls[0]?.headers['x-opencode-session'] ?? '', /^ses_[0-9a-f]{32}$/);
    assert.match(calls[0]?.headers['user-agent'] ?? '', /KaiyiDesktopPet/);
  } finally {
    globalThis.fetch = original;
  }
});
