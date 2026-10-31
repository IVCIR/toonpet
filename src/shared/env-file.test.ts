import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveAppConfig } from '../main/config';
import { loadEnvFile, parseEnvText } from './env-file';

function withTempEnvFile(contents: string, run: (filePath: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'aa3dpet-env-'));
  const filePath = path.join(dir, '.env');
  try {
    writeFileSync(filePath, contents, 'utf8');
    run(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('.env 解析：注释 / 空行 / export / CRLF / BOM', () => {
  const parsed = parseEnvText(
    '\uFEFF# 注释\r\n\r\nFOO=bar\r\nexport BAZ="a b"\r\nEMPTY=\r\n',
  );
  assert.deepEqual(
    parsed.entries.map((entry) => [entry.key, entry.value]),
    [
      ['FOO', 'bar'],
      ['BAZ', 'a b'],
      ['EMPTY', ''],
    ],
  );
  assert.deepEqual(parsed.issues, []);
});

test('.env 解析：引号、转义、行尾注释与重复键（后者覆盖）', () => {
  const parsed = parseEnvText(
    [
      'PLAIN=value # 行尾注释',
      'SINGLE=\'a # b\'',
      'DOUBLE="line1\\nline2\\t\\"quoted\\""',
      'DUP=first',
      'DUP=second',
      "TRAILING='x' # 注释",
    ].join('\n'),
  );

  const map = new Map(parsed.entries.map((entry) => [entry.key, entry.value]));
  assert.equal(map.get('PLAIN'), 'value');
  assert.equal(map.get('SINGLE'), 'a # b');
  assert.equal(map.get('DOUBLE'), 'line1\nline2\t"quoted"');
  assert.equal(map.get('DUP'), 'second');
  assert.equal(map.get('TRAILING'), 'x');
  assert.deepEqual(parsed.issues, []);
});

test('.env 解析：坏行只记 issue，不抛异常，也不影响其他键', () => {
  const parsed = parseEnvText(
    ['NO_EQUALS', '1BAD=x', 'UNCLOSED="abc', 'GOOD=1'].join('\n'),
  );
  assert.deepEqual(
    parsed.entries.map((entry) => entry.key),
    ['UNCLOSED', 'GOOD'],
  );
  assert.equal(parsed.issues.length, 3);
  assert.ok(parsed.issues.some((issue) => issue.line === 1));
  assert.ok(parsed.issues.some((issue) => issue.line === 2));
  assert.ok(parsed.issues.some((issue) => issue.line === 3 && issue.reason.includes('引号未闭合')));
});

test('.env 加载：进程环境变量优先，.env 只补空缺', () => {
  withTempEnvFile('FOO=from_file\nBAR=from_file\nEMPTY=\n', (filePath) => {
    const env: NodeJS.ProcessEnv = { FOO: 'from_process' };
    const result = loadEnvFile(filePath, env);

    assert.equal(result.exists, true);
    assert.equal(result.error, null);
    assert.equal(env['FOO'], 'from_process');
    assert.equal(env['BAR'], 'from_file');
    assert.equal(env['EMPTY'], '');
    assert.deepEqual(result.applied.sort(), ['BAR', 'EMPTY']);
    assert.deepEqual(result.kept, ['FOO']);
  });
});

test('.env 加载：override=true 时才覆盖已有变量', () => {
  withTempEnvFile('FOO=from_file\n', (filePath) => {
    const env: NodeJS.ProcessEnv = { FOO: 'from_process' };
    const result = loadEnvFile(filePath, env, { override: true });
    assert.equal(env['FOO'], 'from_file');
    assert.deepEqual(result.applied, ['FOO']);
    assert.deepEqual(result.kept, []);
  });
});

test('.env 加载：文件不存在不是错误（只使用环境变量与默认值）', () => {
  const env: NodeJS.ProcessEnv = {};
  const missing = path.join(tmpdir(), 'aa3dpet-env-does-not-exist', '.env');
  const result = loadEnvFile(missing, env);
  assert.equal(result.exists, false);
  assert.equal(result.error, null);
  assert.deepEqual(result.applied, []);
  assert.deepEqual(env, {});
});

test('.env 加载：不碰无关变量；空文件等价于什么都没发生', () => {
  withTempEnvFile('# 只有注释\n', (filePath) => {
    const env: NodeJS.ProcessEnv = { UNRELATED: 'kept' };
    const result = loadEnvFile(filePath, env);
    assert.equal(result.exists, true);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.kept, []);
    assert.equal(env['UNRELATED'], 'kept');
  });
});

test('.env → resolveAppConfig：本轮要求的五个键都能生效', () => {
  withTempEnvFile(
    [
      'PET_LLM_MODEL=qwen2.5:3b-instruct',
      'PET_TTS_REF_AUDIO=D:/ref/kaiyi.wav',
      'PET_TTS_PROMPT_TEXT=参考音频的逐字文本',
      'PET_TTS_FIRST_BYTE_TIMEOUT_MS=15000',
      'PET_TTS_TOTAL_TIMEOUT_MS=120000',
    ].join('\n'),
    (filePath) => {
      const env: NodeJS.ProcessEnv = {};
      loadEnvFile(filePath, env);

      const config = resolveAppConfig({ appRoot: 'D:/aa3dpet-app', env });
      assert.equal(config.llm.model, 'qwen2.5:3b-instruct');
      assert.equal(config.tts.refAudioPath, 'D:/ref/kaiyi.wav');
      assert.equal(config.tts.promptText, '参考音频的逐字文本');
      assert.equal(config.tts.firstByteTimeoutMs, 15000);
      assert.equal(config.tts.totalTimeoutMs, 120000);
    },
  );
});

test('.env → resolveAppConfig：进程环境变量优先（.env 不覆盖已存在的值）', () => {
  withTempEnvFile('PET_TTS_PROMPT_TEXT=from_file\n', (filePath) => {
    const env: NodeJS.ProcessEnv = { PET_TTS_PROMPT_TEXT: 'from_process' };
    loadEnvFile(filePath, env);

    const config = resolveAppConfig({ appRoot: 'D:/aa3dpet-app', env });
    assert.equal(config.tts.promptText, 'from_process');
  });
});
