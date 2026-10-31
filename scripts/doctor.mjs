// 环境自检（`npm run doctor`）：只读、只连本机回环，不修改任何文件。
//
// 检查项与 docs/guides/LOCAL-SERVICES.md 一一对应：
//   资产（模型/嘴型图集）→ 数据（台词池/角色卡）→ Ollama → GPT-SoVITS → 参考音频 → 超时配置。
// 结论只有三种：就绪 / 降级可运行 / 缺失（红）。缺失项不会让 doctor 退出非 0——
// 它是一份"清单"，不是构建门槛（构建门槛由 npm test / selftest 负责）。
import http from 'node:http';
import net from 'node:net';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const APP_ROOT = path.resolve(import.meta.dirname, '..');
const NO_COLOR = process.argv.includes('--no-color') || process.env.NO_COLOR !== undefined;
const COLOR = Boolean(process.stdout.isTTY) && !NO_COLOR;

// `.env` 与运行时同语义（ADR 0018 D1）：进程环境变量优先，.env 只补空缺。
// 用 Node 原生的 process.loadEnvFile（Node ≥20.12）：行为与 src/shared/env-file.ts 一致，
// 且 doctor 必须在 `npm run build` 之前也能跑，所以不能依赖 dist 里的应用代码。
// 注意：它不覆盖已存在的环境变量——这一点已实测确认。
const ENV_FILE = path.join(APP_ROOT, '.env');
const envFileState = (() => {
  if (!existsSync(ENV_FILE)) return { status: 'missing', error: null };
  if (typeof process.loadEnvFile !== 'function') {
    return { status: 'unsupported', error: `当前 Node ${process.version} 不支持 process.loadEnvFile` };
  }
  try {
    process.loadEnvFile(ENV_FILE);
    return { status: 'loaded', error: null };
  } catch (error) {
    return { status: 'error', error: String(error?.message ?? error) };
  }
})();

const COLOR_CODES = { red: 31, green: 32, yellow: 33, dim: 90, bold: 1 };
function paint(name, text) {
  if (!COLOR) return text;
  return `\u001b[${COLOR_CODES[name]}m${text}\u001b[0m`;
}

const MARK = {
  ok: () => paint('green', '✔'),
  warn: () => paint('yellow', '!'),
  fail: () => paint('red', '✘'),
  dim: (text) => paint('dim', text),
};

const results = [];
function record(status, title, detail) {
  results.push({ status, title, detail });
  line(status, title, detail);
}
function ok(title, detail) {
  record('ok', title, detail);
}
function warn(title, detail) {
  record('warn', title, detail);
}
function fail(title, detail) {
  record('fail', title, detail);
}

function section(title) {
  process.stdout.write(`\n${paint('bold', title)}\n`);
}

function line(status, title, detail) {
  const mark = MARK[status]();
  const padded = title.padEnd(30, ' ');
  process.stdout.write(`  ${mark} ${padded}${detail ? MARK.dim(detail) : ''}\n`);
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function parseLoopback(raw, label) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:') return { ok: false, error: `${label} 只允许 http:，实际 ${url.protocol}` };
    if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
      return { ok: false, error: `${label} 必须是回环地址，实际 ${url.hostname}` };
    }
    return { ok: true, url };
  } catch (error) {
    return { ok: false, error: `${label} 不是合法 URL：${String(error.message ?? error)}` };
  }
}

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function httpGetJson(url, timeoutMs) {
  return new Promise((resolve) => {
    const request = http.get(
      url,
      { timeout: timeoutMs, headers: { accept: 'application/json' } },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
          if (body.length > 4 * 1024 * 1024) request.destroy(new Error('响应过大'));
        });
        response.on('end', () => {
          resolve({
            ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
            status: response.statusCode ?? 0,
            body,
          });
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error('超时')));
    request.on('error', (error) => resolve({ ok: false, error: String(error.message ?? error) }));
  });
}

function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: '超时' }));
    socket.once('connect', () => finish({ ok: true }));
    socket.once('error', (error) => finish({ ok: false, error: String(error.code ?? error.message) }));
  });
}

/** 只读 WAV 头：返回采样率/声道/位深/时长，用于判断"3–10 秒参考音频"这条硬前置。 */
function readWavInfo(filePath) {
  const buffer = readFileSync(filePath);
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return { ok: false, error: '不是 RIFF/WAVE 文件' };
  }

  let offset = 12;
  let format = null;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        byteRate: buffer.readUInt32LE(body + 8),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    }
    if (id === 'data') {
      dataSize = Math.min(size, Math.max(0, buffer.length - body));
      break;
    }
    offset = body + size + (size % 2);
  }

  if (!format || format.byteRate <= 0) return { ok: false, error: '缺少 fmt 段' };
  return {
    ok: true,
    ...format,
    dataSize,
    durationSec: dataSize / format.byteRate,
  };
}

function fileInfo(filePath) {
  try {
    const stat = statSync(filePath);
    return { exists: stat.isFile(), size: stat.size, mtime: stat.mtime };
  } catch {
    return { exists: false, size: 0, mtime: null };
  }
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 只读前 4 字节（GLB magic），不把 15MB 模型整个读进内存。 */
function readMagic(filePath) {
  const fd = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(4);
    const read = readSync(fd, buffer, 0, 4, 0);
    return read === 4 ? buffer.toString('ascii') : '';
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// 1) 运行环境
// ---------------------------------------------------------------------------
section('运行环境');
ok('平台', `${process.platform} ${process.arch}（契约 C-2：只保证 Windows 11 x64）`);
ok('Node', process.version);
ok('工程根目录', APP_ROOT);

if (envFileState.status === 'loaded') {
  ok('环境配置 .env', `${ENV_FILE}（进程环境变量优先，.env 只补空缺）`);
} else if (envFileState.status === 'missing') {
  warn('环境配置 .env', `未找到 ${ENV_FILE}（可复制 .env.example；缺失时用默认值）`);
} else if (envFileState.status === 'unsupported') {
  warn('环境配置 .env', envFileState.error);
} else {
  fail('环境配置 .env', `${ENV_FILE} 解析失败：${envFileState.error}`);
}

const distMain = path.join(APP_ROOT, 'dist', 'main', 'main.js');
const distInfo = fileInfo(distMain);
if (!distInfo.exists) {
  fail('构建产物', 'dist/main/main.js 不存在 → 先执行 npm run build');
} else {
  const newest = newestMtime(path.join(APP_ROOT, 'src'));
  const stale = newest !== null && newest > distInfo.mtime.getTime() + 1000;
  if (stale) warn('构建产物', 'dist 早于 src（可能过期）→ npm run build');
  else ok('构建产物', `dist/main/main.js（${formatBytes(distInfo.size)}）`);
}

function newestMtime(dir) {
  let newest = null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const child = newestMtime(full);
      if (child !== null && (newest === null || child > newest)) newest = child;
    } else {
      const stat = statSync(full, { throwIfNoEntry: false });
      if (stat && (newest === null || stat.mtimeMs > newest)) newest = stat.mtimeMs;
    }
  }
  return newest;
}

// ---------------------------------------------------------------------------
// 2) 资产
// ---------------------------------------------------------------------------
section('资产');
const modelPath = env('PET_MODEL_PATH', path.join(APP_ROOT, 'CH0335.glb'));
const model = fileInfo(modelPath);
if (!model.exists) {
  fail('模型文件', `${modelPath} 不存在（PET_MODEL_PATH 可覆盖）`);
} else {
  let magic = null;
  try {
    magic = readMagic(modelPath);
  } catch {
    magic = null;
  }
  if (magic !== 'glTF') fail('模型文件', `${modelPath} 不是 GLB（magic=${String(magic)}）`);
  else ok('模型文件', `${modelPath}（${formatBytes(model.size)}，glTF 2.0）`);
}

const mouthPath = path.join(APP_ROOT, 'Character_Mouth_Black-Due3Gpre.png');
const mouth = fileInfo(mouthPath);
if (mouth.exists) ok('嘴型图集', `Character_Mouth_Black-Due3Gpre.png（${formatBytes(mouth.size)}）`);
else fail('嘴型图集', `${mouthPath} 不存在（口型通道会退回静态闭嘴）`);

// 官方表情差分（ADR 0026 D6）：缺失不是错误，但必须让用户一眼看到"现在是降级状态"
{
  const expressionsDir = env('PET_EXPRESSIONS_DIR', path.join(APP_ROOT, 'data', 'expressions'));
  const expected = [
    'eyes_happy.png',
    'eyes_shy.png',
    'eyes_sad.png',
    'eyes_surprised.png',
    'blush.png',
  ];
  const present = expected.filter((file) => fileInfo(path.join(expressionsDir, file)).exists);
  if (present.length === expected.length) {
    ok('表情差分', `${expressionsDir}：5/5（眼型 4 + 红晕 1）`);
  } else if (present.length === 0) {
    warn('表情差分', `${expressionsDir} 为空 → 表情降级为"只变嘴型"（放 5 张 PNG 即生效）`);
  } else {
    warn(
      '表情差分',
      `${expressionsDir}：${present.length}/5（缺 ${expected
        .filter((file) => !present.includes(file))
        .join(', ')} → 缺的那几个 emotion 只变嘴型）`,
    );
  }
}

// ---------------------------------------------------------------------------
// 3) 数据
// ---------------------------------------------------------------------------
section('编排数据');
const dataDir = env('PET_DATA_DIR', path.join(APP_ROOT, 'data'));
const linesPath = path.join(dataDir, 'lines.json');
const linesInfo = fileInfo(linesPath);
if (!linesInfo.exists) {
  fail('台词池', `${linesPath} 不存在（§9.1 ③：兜底为空不得启动）`);
} else {
  try {
    const parsed = JSON.parse(readFileSync(linesPath, 'utf8'));
    const rules = Array.isArray(parsed.rules) ? parsed.rules.length : 0;
    const fallbacks = Array.isArray(parsed.fallbacks) ? parsed.fallbacks.length : 0;
    if (fallbacks === 0) fail('台词池', `${linesPath}：兜底为空（启动会被拒绝）`);
    else ok('台词池', `${rules} 条规则 / ${fallbacks} 条兜底`);
  } catch (error) {
    fail('台词池', `${linesPath} 解析失败：${String(error.message ?? error)}`);
  }
}

const cardPath = path.join(dataDir, 'character-card.md');
const cardInfo = fileInfo(cardPath);
if (!cardInfo.exists) warn('角色卡', `${cardPath} 不存在（启动会用最小身份行）`);
else ok('角色卡', `${formatBytes(cardInfo.size)}`);

// ---------------------------------------------------------------------------
// 4) Ollama（本地 LLM）
// ---------------------------------------------------------------------------
section('本地 LLM（Ollama）');
const llmUrlRaw = env('PET_LLM_URL', 'http://127.0.0.1:11434');
const llmUrl = parseLoopback(llmUrlRaw, 'PET_LLM_URL');
const llmModel = env('PET_LLM_MODEL', 'qwen3:4b');
if (!llmUrl.ok) {
  fail('地址', llmUrl.error);
} else {
  const tags = await httpGetJson(`${llmUrl.url.origin}/api/tags`, 1200);
  if (!tags.ok) {
    fail(
      '服务',
      `${llmUrl.url.origin} 不可达（${tags.error ?? `HTTP ${tags.status}`}）→ 启动 Ollama；本轮对话会走兜底`,
    );
  } else {
    let models = [];
    try {
      const parsed = JSON.parse(tags.body);
      models = (parsed.models ?? []).map((item) => item.name).filter(Boolean);
    } catch {
      models = [];
    }
    ok('服务', `${llmUrl.url.origin}（${models.length} 个模型）`);
    const wanted = [llmModel, `${llmModel}:latest`];
    const matched = models.find((name) => wanted.includes(name) || wanted.includes(`${name}:latest`));
    if (matched) ok('模型', `${matched}`);
    else fail('模型', `未找到 ${llmModel} → ollama pull ${llmModel}（应用不会自动拉取，ADR 0015 D1.2）`);
    const chatModels = models.filter((name) => !/ocr|embed|llava/i.test(name));
    if (!matched && chatModels.length > 0) {
      warn('可用候选', chatModels.join(', '));
    }
  }
}

// ---------------------------------------------------------------------------
// 5) GPT-SoVITS（本地 TTS）
// ---------------------------------------------------------------------------
section('本地 TTS（GPT-SoVITS）');
const ttsUrlRaw = env('PET_TTS_URL', 'http://127.0.0.1:9880');
const ttsUrl = parseLoopback(ttsUrlRaw, 'PET_TTS_URL');
const refAudio = env('PET_TTS_REF_AUDIO', path.join(dataDir, 'ref', 'kaiyi.wav'));
const promptText = env('PET_TTS_PROMPT_TEXT', '');

if (!ttsUrl.ok) {
  fail('地址', ttsUrl.error);
} else {
  const port = Number(ttsUrl.url.port || 80);
  const probe = await tcpProbe(ttsUrl.url.hostname.replace(/^\[|\]$/g, ''), port, 800);
  if (probe.ok) ok('服务', `${ttsUrl.url.origin} 端口可连接`);
  else fail('服务', `${ttsUrl.url.origin} 未监听（${probe.error}）→ 见 docs/guides/LOCAL-SERVICES.md`);
}

const refInfo = fileInfo(refAudio);
if (!refInfo.exists) {
  fail('参考音频', `${refAudio} 不存在（3–10 秒干净人声；零成本约束下不自动下载）`);
} else {
  try {
    const info = readWavInfo(refAudio);
    if (!info.ok) {
      fail('参考音频', `${refAudio}：${info.error}`);
    } else {
      const duration = info.durationSec.toFixed(2);
      const detail = `${duration}s / ${info.sampleRate}Hz / ${info.channels}ch / ${info.bitsPerSample}bit`;
      if (info.durationSec < 3 || info.durationSec > 10) {
        fail('参考音频', `${refAudio}：${detail} → GPT-SoVITS 要求 3–10 秒`);
      } else {
        ok('参考音频', `${refAudio}：${detail}`);
        if (info.sampleRate < 16000) warn('参考音频采样率', `${info.sampleRate}Hz 偏低，建议 ≥16000Hz`);
      }
    }
  } catch (error) {
    fail('参考音频', `${refAudio} 读取失败：${String(error.message ?? error)}`);
  }
}

if (promptText === '') {
  fail('参考文本 PET_TTS_PROMPT_TEXT', '未设置 → TTS 判定为"未配置"，不发起任何 HTTP（§11）');
} else {
  ok('参考文本', `${promptText.length} 字`);
}

// 语种（ADR 0019）：prompt_lang 是参考音频/文本的语种，text_lang 是要合成的回复语种。
// v2ProPlus 的合法集合来自 GPT_SoVITS/TTS_infer_pack/TTS.py 的 v2_languages。
const SUPPORTED_TTS_LANGS = new Set([
  'auto',
  'auto_yue',
  'en',
  'zh',
  'ja',
  'yue',
  'ko',
  'all_zh',
  'all_ja',
  'all_yue',
  'all_ko',
]);
const promptLang = env('PET_TTS_PROMPT_LANG', 'ja').toLowerCase();
const textLang = env('PET_TTS_TEXT_LANG', 'zh').toLowerCase();

if (!SUPPORTED_TTS_LANGS.has(promptLang)) {
  fail(
    '参考语种 PET_TTS_PROMPT_LANG',
    `不支持 "${promptLang}" → 用 ja（日文参考）/ zh / en / ko / yue / auto 等`,
  );
} else {
  ok('参考语种', `prompt_lang=${promptLang}（参考音频/参考文本的语种）`);
}

if (!SUPPORTED_TTS_LANGS.has(textLang)) {
  fail(
    '合成语种 PET_TTS_TEXT_LANG',
    `不支持 "${textLang}" → 回复说中文用 zh（纯中文可 all_zh）`,
  );
} else {
  ok('合成语种', `text_lang=${textLang}（要合成的回复文本语种）`);
}

// 文本与语种的明显错配：假名 → 必须是日文；声称 ja 却无假名 → 提醒确认。
const hasKana = /[\u3040-\u30ff\u31f0-\u31ff]/.test(promptText);
if (promptText !== '') {
  if (hasKana && (promptLang === 'zh' || promptLang === 'all_zh')) {
    warn('参考文本语种', `参考文本含日文假名，但 prompt_lang=${promptLang} → 应改为 ja`);
  } else if (!hasKana && (promptLang === 'ja' || promptLang === 'all_ja')) {
    warn('参考文本语种', `prompt_lang=${promptLang}，但参考文本不含假名；确认音频确实是日文`);
  }
}

const firstByte = env('PET_TTS_FIRST_BYTE_TIMEOUT_MS', '3000');
const total = env('PET_TTS_TOTAL_TIMEOUT_MS', '30000');
if (Number(firstByte) <= 3000 && Number(total) <= 30000) {
  warn(
    'TTS 超时',
    `首字节 ${firstByte}ms / 整段 ${total}ms（CPU 非流式部署建议 15000 / 120000，见 ADR 0015 D2.5）`,
  );
} else {
  ok('TTS 超时', `首字节 ${firstByte}ms / 整段 ${total}ms`);
}

// ---------------------------------------------------------------------------
// 本地记忆（ADR 0020）
// ---------------------------------------------------------------------------
section('本地记忆（SQLite）');
const memoryDisabled = ['1', 'true', 'yes', 'on'].includes(env('PET_MEMORY_DISABLE', '').toLowerCase());
const memoryPath = env('PET_MEMORY_DB', path.join(dataDir, 'memory.db'));
if (memoryDisabled) {
  ok('记忆开关', 'PET_MEMORY_DISABLE 已开启 → 提示词段 3 恒为"（无）"');
} else if (fileInfo(memoryPath).exists) {
  const info = fileInfo(memoryPath);
  ok('记忆库', `${memoryPath}（${formatBytes(info.size)}）`);
} else {
  // 首次运行还没有库是正常的：应用会在 init() 时创建
  ok('记忆库', `${memoryPath} 尚未生成（首次对话后自动创建）`);
}

// 原生模块必须按 Electron 的 ABI 安装（ADR 0020 D1/D9）；这里只查文件在不在。
const sqliteBinding = path.join(APP_ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
if (fileInfo(sqliteBinding).exists) {
  ok('SQLite 原生模块', `better_sqlite3.node（${formatBytes(fileInfo(sqliteBinding).size)}）`);
} else {
  fail(
    'SQLite 原生模块',
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node 不存在 → 记忆会降级为 disabled；' +
      '按 docs/guides/LOCAL-SERVICES.md §8 用 prebuild-install 装 Electron ABI 版本',
  );
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
section('汇总');
const counts = {
  ok: results.filter((item) => item.status === 'ok').length,
  warn: results.filter((item) => item.status === 'warn').length,
  fail: results.filter((item) => item.status === 'fail').length,
};

process.stdout.write('\n');
if (counts.fail === 0) {
  process.stdout.write(`${paint('green', '结论：全部就绪')}  （${counts.ok} 项通过 / ${counts.warn} 项提醒）\n`);
} else {
  process.stdout.write(
    `${paint('red', `结论：${counts.fail} 项缺失`)}  （${counts.ok} 项通过 / ${counts.warn} 项提醒）\n` +
      `${MARK.dim('缺失项不影响启动：对话会走兜底、语音会退化为字幕（契约 §11）。')}\n` +
      `${MARK.dim('修复步骤见 docs/guides/LOCAL-SERVICES.md；退出码恒为 0（doctor 只报告，不判定构建失败）。')}\n`,
  );
}
