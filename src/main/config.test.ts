import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigError, isLoopbackHost, requireLoopbackUrl, resolveAppConfig } from './config';

test('零出站守卫：非回环地址与 https 一律拒绝（ADR 0015 D6）', () => {
  assert.throws(() => requireLoopbackUrl('http://example.com:11434', 'PET_LLM_URL'), ConfigError);
  assert.throws(() => requireLoopbackUrl('http://10.0.0.8:11434', 'PET_LLM_URL'), ConfigError);
  assert.throws(() => requireLoopbackUrl('https://127.0.0.1:9880', 'PET_TTS_URL'), ConfigError);
  assert.throws(() => requireLoopbackUrl('not-a-url', 'PET_TTS_URL'), ConfigError);
});

test('零出站守卫：回环地址被接受并归一化为 origin（去掉尾斜杠与路径）', () => {
  assert.equal(requireLoopbackUrl('http://127.0.0.1:11434/', 'x'), 'http://127.0.0.1:11434');
  assert.equal(requireLoopbackUrl('http://localhost:9880/tts', 'x'), 'http://localhost:9880');
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('LOCALHOST'), true);
  assert.equal(isLoopbackHost('192.168.1.2'), false);
});

test('默认值：模型 qwen3:4b、LLM 8s、TTS 3s/30s（契约 §9.4 / §7.4）', () => {
  const config = resolveAppConfig({ appRoot: 'D:/aa3dpet-app', env: {} });
  assert.equal(config.llm.model, 'qwen3:4b');
  assert.equal(config.llm.baseUrl, 'http://127.0.0.1:11434');
  assert.equal(config.llm.requestTimeoutMs, 8000);
  assert.equal(config.llm.healthTimeoutMs, 800);
  assert.equal(config.tts.baseUrl, 'http://127.0.0.1:9880');
  assert.equal(config.tts.firstByteTimeoutMs, 3000);
  assert.equal(config.tts.totalTimeoutMs, 30000);
  assert.equal(config.tts.promptText, '');
  // ADR 0022：角色只讲日文 → 参考语种与合成语种默认都是 ja（修订 ADR 0019 的 zh）
  assert.equal(config.tts.promptLang, 'ja');
  assert.equal(config.tts.textLang, 'ja');
  assert.ok(config.tts.refAudioPath.endsWith('ref/kaiyi.wav') || config.tts.refAudioPath.endsWith('ref\\kaiyi.wav'));
  assert.ok(config.characterCardPath.endsWith('character-card.md'));
  assert.ok(config.linesPath.endsWith('lines.json'));
});

test('记忆配置：默认 <数据目录>/memory.db，可覆盖，可显式关闭（ADR 0020 D2/D10）', () => {
  const fallback = resolveAppConfig({ appRoot: 'D:/aa3dpet-app', env: {} });
  assert.equal(fallback.memory.enabled, true);
  assert.ok(fallback.memory.dbPath.replace(/\\/g, '/').endsWith('data/memory.db'));

  const overridden = resolveAppConfig({
    appRoot: 'D:/aa3dpet-app',
    env: { PET_MEMORY_DB: 'D:/tmp/pet-memory.db', PET_DATA_DIR: 'D:/aa3dpet-app/custom-data' },
  });
  assert.equal(overridden.memory.dbPath, 'D:/tmp/pet-memory.db');
  assert.equal(overridden.memory.enabled, true);

  const disabled = resolveAppConfig({ appRoot: 'D:/aa3dpet-app', env: { PET_MEMORY_DISABLE: '1' } });
  assert.equal(disabled.memory.enabled, false);
  // 只有 1/true/yes/on 算开，其它值都算关
  assert.equal(resolveAppConfig({ appRoot: 'D:/aa3dpet-app', env: { PET_MEMORY_DISABLE: 'yes' } }).memory.enabled, false);
  assert.equal(resolveAppConfig({ appRoot: 'D:/aa3dpet-app', env: { PET_MEMORY_DISABLE: '0' } }).memory.enabled, true);
});

test('环境变量覆盖：CPU 非流式部署可放宽超时；非法 URL 启动即失败', () => {
  const config = resolveAppConfig({
    appRoot: 'D:/aa3dpet-app',
    env: {
      PET_LLM_MODEL: 'qwen2.5:3b-instruct',
      PET_LLM_URL: 'http://localhost:11434',
      PET_TTS_FIRST_BYTE_TIMEOUT_MS: '15000',
      PET_TTS_TOTAL_TIMEOUT_MS: '120000',
      PET_TTS_REF_AUDIO: 'D:/ref/kaiyi.wav',
      PET_TTS_PROMPT_TEXT: '参考文本',
      // 语种归一化为小写：GPT-SoVITS 内部也会 lower()
      PET_TTS_PROMPT_LANG: ' JA ',
      PET_TTS_TEXT_LANG: 'ZH',
      PET_DATA_DIR: 'D:/aa3dpet-app/custom-data',
    },
  });
  assert.equal(config.llm.model, 'qwen2.5:3b-instruct');
  assert.equal(config.llm.baseUrl, 'http://localhost:11434');
  assert.equal(config.tts.firstByteTimeoutMs, 15000);
  assert.equal(config.tts.totalTimeoutMs, 120000);
  assert.equal(config.tts.refAudioPath, 'D:/ref/kaiyi.wav');
  assert.equal(config.tts.promptText, '参考文本');
  assert.equal(config.tts.promptLang, 'ja');
  assert.equal(config.tts.textLang, 'zh');
  assert.ok(config.characterCardPath.replace(/\\/g, '/').startsWith('D:/aa3dpet-app/custom-data'));

  assert.throws(
    () => resolveAppConfig({ appRoot: 'D:/aa3dpet-app', env: { PET_LLM_URL: 'http://api.openai.com' } }),
    ConfigError,
  );
});
