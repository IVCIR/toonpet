// 启动器：整理环境变量后起 Electron，并把"有没有起来、怎么死的"记到 logs/start.log。
//
// 为什么需要这层：Electron 在 Windows 上是 GUI 子系统进程，`console.log` 在终端不可见；
// 一旦它在加载我们的 main.js 之前就退出（Chromium 初始化失败是最常见的），
// boot.log 也不会出现，排查就只剩黑盒。启动器是普通 Node 进程，它的日志一定写得出。
//
// stdio 用 inherit：不要用管道捕获 Electron 的输出，否则在没有命名管道权限的环境里会 EPERM。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const logFile = resolveLogFile();
const startedAt = Date.now();

function resolveLogFile() {
  for (const directory of [path.join(process.cwd(), 'logs'), path.join(tmpdir(), 'aa3dpet-logs')]) {
    try {
      mkdirSync(directory, { recursive: true });
      return path.join(directory, 'start.log');
    } catch {
      // 换下一个候选
    }
  }
  return null;
}

function log(event, data = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, elapsedMs: Date.now() - startedAt, ...data });
  if (logFile) {
    try {
      appendFileSync(logFile, `${line}\n`);
    } catch {
      // 日志失败不挡启动
    }
  }
  // 控制台只输出 ASCII：Windows 控制台代码页不是 UTF-8 时中文会变成乱码，
  // 而这些行是给"窗口没起来"时看的，必须可读。
  console.log(`[start] ${event} ${JSON.stringify(data)}`);
}

let electronPath;
try {
  /** electron 包的入口导出的是可执行文件路径。 */
  electronPath = require('electron');
} catch (error) {
  log('resolve-failed', { message: String(error) });
  process.exit(1);
}

const extraArgs = process.argv
  .slice(2)
  .filter(
    (arg) =>
      arg !== '--selftest' &&
      arg !== '--selftest-fallback' &&
      arg !== '--selftest-speech' &&
      arg !== '--selftest-input' &&
      arg !== '--selftest-vision' &&
      arg !== '--panel-shot' &&
      arg !== '--panel-opencode-shot' &&
      arg !== '--scale-shot' &&
      arg !== '--swing-shot',
  );
const selftest = process.argv.includes('--selftest');
const selftestFallback = process.argv.includes('--selftest-fallback');
const selftestSpeech = process.argv.includes('--selftest-speech');
const selftestInput = process.argv.includes('--selftest-input');
const selftestVision = process.argv.includes('--selftest-vision');
// ADR 0052 D7：控制面板取证（打开面板 → 拨滑块 → 验证渲染侧收到 → 截图 → 还原配置 → 退出）
// ADR 0056：`--panel-opencode-shot` 是**手动诊断**：用真实 OpenCode Go `/models`（无 Key 公开清单）
// 截一张"OpenCode Go 模型下拉"的图；默认的 `--panel-shot` 仍然只用 127.0.0.1 桩，不访问外网。
const panelOpenCodeShot = process.argv.includes('--panel-opencode-shot');
const panelShot = process.argv.includes('--panel-shot') || panelOpenCodeShot;
// ADR 0057 D2：整体缩放的逐档截图（拼成 GIF 当"录屏"看）
const scaleShot = process.argv.includes('--scale-shot');
// ADR 0058 D4：拖拽摇晃的逐帧取证。它必须开 `PET_SELFTEST=1`：
// 主进程只有在这个模式下才读**脚本光标**，而摇晃正是靠"推光标 → 窗口跟随 → 单摆"驱动的。
const swingShot = process.argv.includes('--swing-shot');

const env = { ...process.env };
delete env['ELECTRON_RUN_AS_NODE'];
delete env['ELECTRON_NO_ATTACH_CONSOLE'];
if (selftest || selftestFallback || selftestSpeech || selftestInput || selftestVision) env['PET_SELFTEST'] = '1';
if (swingShot) {
  env['PET_SELFTEST'] = '1';
  env['PET_SWING_SHOT'] = '1';
}
if (scaleShot) env['PET_SCALE_SHOT'] = '1';
if (panelShot) {
  // 面板取证**不**开 PET_SELFTEST：它需要真实运行时（真实输入/真实配置路径），
  // 只是把配置指向 logs/selftest/panel-config.json，跑完由脚本自己还原/删除。
  if (panelOpenCodeShot) env['PET_PANEL_OPENCODE_SHOT'] = '1';
  else env['PET_PANEL_SHOT'] = '1';
  if (env['PET_PANEL_CONFIG'] === undefined || env['PET_PANEL_CONFIG'] === '') {
    env['PET_PANEL_CONFIG'] = path.join(process.cwd(), 'logs', 'selftest', 'panel-config.json');
  }
  // ADR 0053：角色卡也要隔离——取证会真的保存一次角色卡，不能写回用户真实人格文件。
  // 脚本启动前把真实角色卡复制到隔离路径（见 panel-shot.ts），退出前删掉副本。
  if (env['PET_CHARACTER_CARD'] === undefined || env['PET_CHARACTER_CARD'] === '') {
    env['PET_CHARACTER_CARD'] = path.join(process.cwd(), 'logs', 'selftest', 'character-card.md');
  }
  // ADR 0053：记忆库也要隔离——取证会真的删一条、清空一次，绝不能动用户真实的 data/memory.db。
  // 每次取证前清掉旧库（含 WAL/SHM），保证"列表里有几条"是脚本自己种的。
  if (env['PET_MEMORY_DB'] === undefined || env['PET_MEMORY_DB'] === '') {
    env['PET_MEMORY_DB'] = path.join(process.cwd(), 'logs', 'selftest', 'memory.db');
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${env['PET_MEMORY_DB']}${suffix}`;
      try {
        if (existsSync(file)) rmSync(file, { force: true });
      } catch {
        // 残留文件不影响结论：下次启动会再试
      }
    }
  }
}
if (selftestFallback) {
  env['PET_SELFTEST_FALLBACK'] = '1';
  // 缺失模型验收：指向一个确定不存在的路径（可用显式环境变量覆盖以测别的坏路径）
  if (!env['PET_MODEL_PATH']) {
    env['PET_MODEL_PATH'] = path.join(process.cwd(), '__selftest_missing__', 'CH0335.glb');
  }
}
if (selftestSpeech) {
  env['PET_SELFTEST_SPEECH'] = '1';
}

if (selftestVision) {
  // ADR 0054：视觉自检。OCR 端点用脚本内的本地桩（真调 Windows OCR），
  // LLM/TTS 与语音自检同一套桩（chat 桩会检查 system 段里有没有 OCR 文字）。
  // 端口在下面统一探测（ADR 0058 D8），这里只定模型/超时/来源。
  env['PET_SELFTEST_VISION'] = '1';
  setDefault('PET_OCR_MODEL', 'win-ocr-stub');
  setDefault('PET_OCR_TIMEOUT_MS', '20000');
  setDefault('PET_VISION_SOURCE', 'screen');
  // 自检屏幕是 3200×2000（200% 缩放）：缩到 1600 后 96px 字只剩 48px，
  // Windows OCR 会把 "VISION" 拆错。放宽到契约上限 2560，保留更多笔画。
  setDefault('PET_VISION_MAX_WIDTH', '2560');
  setDefault('PET_LLM_MODEL', 'selftest-stub:1b');
  setDefault('PET_TTS_PROMPT_TEXT', '参考音频：测试语音。');
  if (env['PET_TTS_REF_AUDIO'] === undefined || env['PET_TTS_REF_AUDIO'] === '') {
    const refPath = path.join(process.cwd(), 'logs', 'selftest-ref.wav');
    mkdirSync(path.dirname(refPath), { recursive: true });
    writeFileSync(refPath, silenceWav(300));
    env['PET_TTS_REF_AUDIO'] = refPath;
  }
}

/**
 * 自检必须可复现：默认把两个外部服务指到"确定没人监听"的端口（ADR 0015 D2.6 / §11）。
 * 显式设置过的环境变量优先，方便用户拿真实服务做对照验收。
 */
function setDefault(key, value) {
  if (env[key] === undefined || env[key] === '') env[key] = value;
}

if (selftest && !selftestSpeech) {
  setDefault('PET_TTS_URL', 'http://127.0.0.1:9882');
  setDefault('PET_TTS_REF_AUDIO', path.join(process.cwd(), '__selftest_missing__', 'ref.wav'));
  setDefault('PET_LLM_URL', 'http://127.0.0.1:11436');
  setDefault('PET_LLM_MODEL', 'selftest-missing:1b');
}

/**
 * 表情差分的来源（ADR 0026 D6）：
 * 1. 显式设了 `PET_EXPRESSIONS_DIR` → 听用户的；
 * 2. 官方目录 `data/expressions/` 里已经有差分 → 用官方素材跑自检；
 * 3. 否则退到 `data/expressions.fixtures/`（非官方 fixture，只为验证管线），并打一条日志。
 */
if (selftest) {
  const officialDir = path.join(process.cwd(), 'data', 'expressions');
  const fixtureDir = path.join(process.cwd(), 'data', 'expressions.fixtures');
  const officialFiles = ['eyes_happy.png', 'eyes_shy.png', 'eyes_sad.png', 'eyes_surprised.png'];
  const hasOfficial = officialFiles.every((file) => existsSync(path.join(officialDir, file)));
  // fixture 默认**不启用**（ADR 0026 D8）：自检截图必须等于真机效果，
  // 假眼/假腮红曾经被误当成产品效果。需要验证"图片 → 贴图"管线时才显式开启。
  const wantFixtures = env['PET_SELFTEST_FIXTURES'] === '1';
  if (wantFixtures && !env['PET_EXPRESSIONS_DIR'] && !hasOfficial && existsSync(fixtureDir)) {
    env['PET_EXPRESSIONS_DIR'] = fixtureDir;
    console.log('[selftest] 显式启用 fixture（非官方美术，仅验证管线）：data/expressions.fixtures');
  }
}

if (selftestInput) {
  env['PET_SELFTEST_INPUT'] = '1';
  // 输入条套件只看"文本入口 → 规则回复 → 字幕"，因此把外部服务指到无人监听的端口，
  // 保持与降级套件同样的可复现前提（§11；ADR 0015 D2.6）。
  setDefault('PET_TTS_URL', 'http://127.0.0.1:9882');
  setDefault('PET_TTS_REF_AUDIO', path.join(process.cwd(), '__selftest_missing__', 'ref.wav'));
  setDefault('PET_LLM_URL', 'http://127.0.0.1:11436');
  setDefault('PET_LLM_MODEL', 'selftest-missing:1b');
}

if (selftestSpeech) {
  // 语音自检用本地桩（脚本内起在回环端口）；桩由 selftest.ts 启动
  setDefault('PET_LLM_MODEL', 'selftest-stub:1b');
  setDefault('PET_TTS_PROMPT_TEXT', '参考音频：测试语音。');
  if (env['PET_TTS_REF_AUDIO'] === undefined || env['PET_TTS_REF_AUDIO'] === '') {
    const refPath = path.join(process.cwd(), 'logs', 'selftest-ref.wav');
    mkdirSync(path.dirname(refPath), { recursive: true });
    writeFileSync(refPath, silenceWav(300));
    env['PET_TTS_REF_AUDIO'] = refPath;
  }
}

/**
 * 自检桩的**端口选择**（ADR 0058 D8）。
 *
 * 原来三个桩写死 11435 / 9881 / 8003。Windows 的"端口排除范围"是**动态**的
 * （Hyper-V / WinNAT 重启后会重新占段）：真机实测某次重启后 `11367–11466` 被整段排除，
 * 于是 LLM 桩 `listen()` 直接 EACCES → 语音/视觉两套自检 exit 1（而断言本身还是全过的，
 * 极难一眼看出是环境问题）。这里在**拉起 Electron 之前**逐个候选端口试绑，
 * 选第一个真的能监听的，再通过环境变量同时告诉主进程和桩。
 */
const STUB_PORT_CANDIDATES = {
  llm: [11435, 12435, 13435, 14435, 15435, 16435, 17435],
  tts: [9881, 10881, 11881, 12881, 13881],
  ocr: [8003, 9003, 10003, 11003],
};

function canListen(port) {
  return new Promise((resolve) => {
    const server = createServer();
    const done = (ok) => {
      server.removeAllListeners();
      server.close(() => resolve(ok));
    };
    server.once('error', () => done(false));
    server.once('listening', () => done(true));
    server.listen(port, '127.0.0.1');
  });
}

async function pickStubPort(kind) {
  for (const port of STUB_PORT_CANDIDATES[kind]) {
    if (await canListen(port)) return port;
  }
  // 全都被占/被排除：退回首选端口，让桩按原有方式报错（错误信息里带端口号）
  return STUB_PORT_CANDIDATES[kind][0];
}

if (selftestSpeech || selftestVision) {
  const llmPort = await pickStubPort('llm');
  env['PET_LLM_URL'] = `http://127.0.0.1:${llmPort}`;
  env['PET_SELFTEST_LLM_PORT'] = String(llmPort);
  const ttsPort = await pickStubPort('tts');
  env['PET_TTS_URL'] = `http://127.0.0.1:${ttsPort}`;
  env['PET_SELFTEST_TTS_PORT'] = String(ttsPort);
  if (selftestVision) {
    const ocrPort = await pickStubPort('ocr');
    env['PET_OCR_URL'] = `http://127.0.0.1:${ocrPort}/v1`;
    env['PET_SELFTEST_OCR_PORT'] = String(ocrPort);
  }
  log('stub-ports', { llm: llmPort, tts: ttsPort });
}

// 自检不得污染真实记忆库（data/memory.db，ADR 0020）：改用 logs/selftest/memory.db，
// 每次自检前清空，保证"行数 / 检索命中"类断言可复现。
if (selftest || selftestFallback || selftestSpeech || selftestInput || selftestVision || swingShot) {
  const memoryDir = path.join(process.cwd(), 'logs', 'selftest');
  try {
    rmSync(memoryDir, { recursive: true, force: true });
    mkdirSync(memoryDir, { recursive: true });
  } catch {
    // 清理失败不挡自检：记忆库打不开时应用会降级为 :memory:（§11）
  }
  setDefault('PET_MEMORY_DB', path.join(memoryDir, 'memory.db'));
  /**
   * ADR 0057 D4：自检同样**不得读用户的 `config.json`**。
   *
   * 原来只有 `--panel-shot` 会隔离这个文件，主链路/输入条/语音/视觉四套自检都直接读
   * `<appRoot>/config.json`。一旦用户在面板里配了一个**真实**的远程提供商（例如 OpenCode Go），
   * 自检的"LLM 不可用 → llm_failed / route=fallback / 熔断"三条断言就会真的走网络并成功，
   * 于是由绿变红 —— 更要紧的是**自检会拿用户的 Key 发真实请求**（§10.2 成本红线）。
   * 隔离之后自检只看默认值（本地 Ollama + 环境变量里那个确定没人监听的端口）。
   */
  setDefault('PET_PANEL_CONFIG', path.join(memoryDir, 'panel-config.json'));
}

/** 300ms 静音 WAV：自检只需要"参考音频文件存在"这个前置条件。 */
function silenceWav(durationMs) {
  const sampleRate = 16000;
  const samples = Math.floor((sampleRate * durationMs) / 1000);
  const data = Buffer.alloc(samples * 2);
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

// 仅诊断用途的逃生口：个别机器的 EDR/应用控制会挡住 Chromium 的沙箱初始化。
// 默认关闭；开启后 Chrome 以无沙箱运行，不得用于分发包。
if (env['PET_CHROMIUM_NO_SANDBOX'] === '1') {
  extraArgs.push('--no-sandbox');
  log('no-sandbox-enabled', { note: 'diagnostic only, never for distribution' });
}

const args = ['.', ...extraArgs];

// ADR 0053：取证用的角色卡副本从用户真实人格复制一份出来（没有真实文件就留空，
// 由 runtime 的"最小身份行"降级——这本身也是一条要验的路径）。
if (panelShot && env['PET_CHARACTER_CARD']) {
  try {
    const source = path.join(process.cwd(), 'data', 'character-card.md');
    const target = path.resolve(env['PET_CHARACTER_CARD']);
    if (existsSync(source)) {
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
  } catch (error) {
    log('character-card-copy-failed', { error: String(error) });
  }
}

log('launch', {
  electronPath,
  args,
  cwd: process.cwd(),
  appPath: path.resolve('.'),
  env: {
    ELECTRON_RUN_AS_NODE: env['ELECTRON_RUN_AS_NODE'] ?? null,
    PET_SELFTEST: env['PET_SELFTEST'] ?? null,
    PET_PANEL_SHOT: env['PET_PANEL_SHOT'] ?? null,
    PET_PANEL_CONFIG: env['PET_PANEL_CONFIG'] ?? null,
    PET_SELFTEST_FALLBACK: env['PET_SELFTEST_FALLBACK'] ?? null,
    PET_SELFTEST_SPEECH: env['PET_SELFTEST_SPEECH'] ?? null,
    PET_SELFTEST_INPUT: env['PET_SELFTEST_INPUT'] ?? null,
    PET_SELFTEST_VISION: env['PET_SELFTEST_VISION'] ?? null,
    PET_OCR_URL: env['PET_OCR_URL'] ?? null,
    PET_OCR_MODEL: env['PET_OCR_MODEL'] ?? null,
    PET_MODEL_PATH: env['PET_MODEL_PATH'] ?? null,
    PET_CHROMIUM_NO_SANDBOX: env['PET_CHROMIUM_NO_SANDBOX'] ?? null,
    PET_LLM_URL: env['PET_LLM_URL'] ?? null,
    PET_LLM_MODEL: env['PET_LLM_MODEL'] ?? null,
    PET_TTS_URL: env['PET_TTS_URL'] ?? null,
    PET_TTS_REF_AUDIO: env['PET_TTS_REF_AUDIO'] ?? null,
    PET_TTS_PROMPT_TEXT: env['PET_TTS_PROMPT_TEXT'] ? '(set)' : null,
    PET_MEMORY_DB: env['PET_MEMORY_DB'] ?? null,
  },
});

const child = spawn(electronPath, args, {
  stdio: 'inherit',
  env,
  cwd: process.cwd(),
});

log('spawned', { pid: child.pid ?? null });

child.on('exit', (code, signal) => {
  log('exit', { code, codeHex: toHex(code), signal, diagnosis: describeExit(code) });
  if (signal) process.exit(1);
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  log('spawn-error', { message: String(error), code: error?.code ?? null });
  process.exit(1);
});

/** Windows 退出码在 Node 里可能以无符号 32 位返回，统一成有符号再看。 */
function toSigned(code) {
  if (code === null || code === undefined) return code;
  return code > 0x7fffffff ? code - 0x100000000 : code;
}

function toHex(code) {
  if (code === null || code === undefined) return null;
  return `0x${(code >>> 0).toString(16).toUpperCase()}`;
}

function describeExit(code) {
  const signed = toSigned(code);
  if (signed === 0) return 'clean exit';
  if (signed === 78) return 'guard: ELECTRON_RUN_AS_NODE';
  if (signed === -2147483645) return 'Chromium sandbox init failed (STATUS_BREAKPOINT). Try PET_CHROMIUM_NO_SANDBOX=1 to confirm it is an environment restriction.';
  if (signed === -1073741819) return 'access violation during Chromium init (0xC0000005)';
  if (signed === -1073740791) return 'fast fail / stack buffer overrun (0xC0000409)';
  if (signed === -36861) return 'exited before app ready (Electron started, main.js not confirmed)';
  return 'unrecognised exit code';
}
