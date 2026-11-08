/**
 * 控制面板的**真机取证脚本**（`PET_PANEL_SHOT=1`，ADR 0052 D7）。
 *
 * 它回答一个自检回答不了的问题：**滑块真的到渲染进程了吗？**
 * 单测能证明夹取/持久化正确，但"面板 → cmd:panel → cmd:tuning → 渲染侧数值变化"这条
 * 跨进程序列只有把 Electron 跑起来才能验。脚本因此做四件事：
 *
 * 1. 打开面板，等页面装载完成；
 * 2. **通过页面自己的数字/滑块路径**（`window.__panelDebug.set`，等价于用户拖滑块）改三项参数；
 * 3. 从 `shell.panelDiagnostics().render.tuning` 读**渲染进程上报的真值**，
 *    与请求值逐项比对；同时比对面板 DOM 上的读数；
 * 4. 点「保存并应用」，读回 `config.json` 确认落盘；再「恢复默认」并**还原用户原配置**，
 *    最后截两张图（物理手感 / 系统状态），写 `logs/evidence/panel-hot-update.json`，退出。
 *
 * 之所以要"还原用户配置"：取证脚本会跑在用户自己的机器上，不能把 -0.12 这类标定值
 * 偷偷留在 `config.json` 里（那会改变她平时的坐姿）。
 */
import { app } from 'electron';
import Database from 'better-sqlite3';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { logError, logInfo, logWarn } from './log';
import { getRuntime } from './runtime';
import { shell } from './shell/index';
import type { TunableValues } from '../shared/tunable-params';
import { sanitizeTunablePatch } from '../shared/tunable-params';

const EVIDENCE_DIR = ['logs', 'evidence'];
const TIMEOUT_MS = 15_000;

/** 面板上要拨到的目标值（等价于用户拖三下） */
const TARGETS: Partial<TunableValues> = {
  'sit.phaseAHeadTuneRad': -0.12,
  'sit.spineOverlayWeight': 0.85,
  'gaze.eyeStiffness': 16,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ADR 0053：往**隔离**记忆库种几行（只在 `PET_MEMORY_DB` 指向 `logs/selftest` 时调用）。
 *
 * 为什么要绕过 runtime 直接开库：运行时没有"写一条测试记忆"的入口，而取证需要确定的行数
 * （用户真实库里有几行是任意的）。多开一个 WAL 连接是安全的：写提交后主进程连接立刻可见。
 * 返回实际写入的行数；失败返回 0（取证断言会因此失败，但不会把用户库写坏——路径已在调用处校验）。
 */
function seedIsolatedMemory(dbPath: string, texts: string[]): number {
  try {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
      const insert = db.prepare(
        'INSERT INTO memories (at, kind, text, tags, ref_id) VALUES (?, ?, ?, ?, ?)',
      );
      const now = Date.now();
      for (const [index, text] of texts.entries()) {
        insert.run(now + index, 'user', text, '[]', `panel-shot#${index}`);
      }
      return texts.length;
    } finally {
      db.close();
    }
  } catch (error) {
    logWarn('panel-shot', '隔离记忆库种行失败', { error: String(error) });
    return 0;
  }
}

interface ModelListStub {
  url: string;
  /** 每次 `/v1/models` 请求带的 Authorization（只用于断言"旧 Key 被主进程注入"） */
  authHeaders: string[];
  requests: number;
  close(): Promise<void>;
}

/**
 * ADR 0056：模型列表取证桩。只监听 127.0.0.1，不访问外网、不产生真实订阅调用。
 * 返回三条模型，其中 `grok-4.7` 用于"选择后保存并切换"的断言。
 */
async function startModelListStub(): Promise<ModelListStub> {
  let server: Server;
  const stub: ModelListStub = {
    url: '',
    authHeaders: [],
    requests: 0,
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  server = createServer((request, response) => {
    stub.requests += 1;
    if (request.url === '/v1/models') {
      const authorization = request.headers['authorization'];
      stub.authHeaders.push(typeof authorization === 'string' ? authorization : '');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          data: [
            { id: 'grok-4.7', name: 'Grok 4.7' },
            { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' },
            { id: 'qwen3.5-coder', name: 'Qwen 3.5 Coder' },
          ],
        }),
      );
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('模型列表桩未拿到端口');
  stub.url = `http://127.0.0.1:${address.port}`;
  return stub;
}

async function waitFor<T>(label: string, probe: () => Promise<T | null> | T | null, timeoutMs = TIMEOUT_MS): Promise<T> {  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`);
    await sleep(120);
  }
}

interface Evidence {
  generatedAt: string;
  configPath: string;
  requested: Partial<TunableValues>;
  rendererReported: TunableValues | null;
  sitFacts: {
    stage: string;
    sitPoseGain: number;
    phaseAHeadAppliedRad: number;
    spineOverlayApplied: number;
  } | null;
  panelDom: {
    phaseA: string | null;
    spine: string | null;
    tuningDetail: string | null;
    phaseASlider: string | null;
    spineSlider: string | null;
    eyeSlider: string | null;
  };
  configAfterSave: { tuning: Record<string, unknown>; updatedAt: string | null } | null;
  /** ADR 0055：提供商页的取证读数（不含任何 Key 明文） */
  providers: {
    idsBefore: string[];
    idsAfterAdd: string[];
    activeAfterSwitch: string | null;
    activeType: string | null;
    activeModel: string | null;
    testStatus: string | null;
    configProviderCount: number;
    configActiveProvider: string | null;
    configHasKey: boolean;
  } | null;
  /** ADR 0056：动态模型列表的取证读数 */
  modelList: {
    fetched: string[];
    chips: string[];
    statusText: string;
    statusClass: string;
    reusedKeyAuth: string | null;
    failureStatus: string;
    failureClass: string;
    manualModelSaved: boolean;
    runtimeModel: string | null;
    runtimeProviderType: string | null;
  } | null;
  /** ADR 0053：AI 人格页的取证读数 */
  persona: {
    cardPath: string;
    cardCharsBefore: number | null;
    cardCharsAfterSave: number | null;
    cardTextOnDiskHasMarker: boolean;
    modelOptions: string[];
    selectedModel: string | null;
    modelBadge: string | null;
    ttsBadge: string | null;
  } | null;
  /** ADR 0053：记忆页的取证读数（只读一次 + 写入路径各一次） */
  memory: {
    rows: number | null;
    listed: number | null;
    countText: string | null;
    badge: string | null;
    emptyVisible: boolean | null;
    seeded: number;
    listedAfterSeed: number | null;
    listedAfterDelete: number | null;
    deleteDeleted: boolean | null;
    cleared: number | null;
    listedAfterClear: number | null;
    emptyAfterClear: boolean | null;
  } | null;
  screenshots: string[];
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  ok: boolean;
  error?: string;
}

async function writeEvidence(appRoot: string, evidence: Evidence): Promise<string> {
  const dir = path.join(appRoot, ...EVIDENCE_DIR);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'panel-hot-update.json');
  writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return file;
}

async function capture(window: Electron.BrowserWindow, appRoot: string, name: string): Promise<string> {
  const image = await window.webContents.capturePage();
  const dir = path.join(appRoot, ...EVIDENCE_DIR);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, image.toPNG());
  return file;
}

/**
 * ADR 0056 的**手动诊断**：用真实 OpenCode Go `/models`（无 Key 时公开可读）截一张
 * "OpenCode Go 模型下拉"的图。它不是 `npm run panel:shot` 的一部分，默认取证仍然只用
 * 127.0.0.1 桩、不访问外网。入口：`npm run panel:opencode`。
 */
async function runOpenCodeModelsShot(): Promise<void> {
  const appRoot = app.getAppPath();
  const evidence: {
    generatedAt: string;
    ok: boolean;
    models: string[];
    statusText: string;
    statusClass: string;
    screenshot: string | null;
    error?: string;
  } = {
    generatedAt: new Date().toISOString(),
    ok: false,
    models: [],
    statusText: '',
    statusClass: '',
    screenshot: null,
  };
  try {
    if (!shell.openControlPanel()) throw new Error('控制面板打开失败');
    const panel = await waitFor('面板窗口', () => shell.getControlPanelWindow());
    await waitFor('面板页面脚本', async () => {
      const ready = await panel.webContents.executeJavaScript(
        "document.readyState === 'complete' && Boolean(window.__panelDebug)",
      );
      return ready === true ? true : null;
    });
    await panel.webContents.executeJavaScript(
      "document.querySelector('[data-tab=\"persona\"]')?.click(); true",
    );
    await sleep(300);
    await panel.webContents.executeJavaScript(
      `(() => {
        document.querySelector('#provider-new')?.click();
        const type = document.querySelector('#provider-type');
        type.value = 'opencode-go';
        type.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('#provider-name').value = 'OpenCode Go 真机';
        document.querySelector('#provider-apikey').value = '';
        document.querySelector('#provider-model').value = '';
        document.querySelector('#provider-model-refresh').click();
        return true;
      })()`,
    );
    const models = (await waitFor(
      'OpenCode Go 模型列表',
      async () => {
        const list = (await panel.webContents.executeJavaScript(
          'window.__panelDebug?.providerModels?.() ?? []',
        )) as string[];
        return Array.isArray(list) && list.length > 0 ? list : null;
      },
      30000,
    )) as string[];
    const status = (await panel.webContents.executeJavaScript(
      'window.__panelDebug?.providerModelStatus?.() ?? { text: "", cls: "" }',
    )) as { text: string; cls: string };
    // 等 2s 冷却结束，让 🔄 恢复（截图展示正常态）
    await sleep(2100);
    await panel.webContents.executeJavaScript(
      "document.querySelector('#provider-form')?.scrollIntoView({ block: 'center' }); true",
    );
    await sleep(200);
    evidence.models = models;
    evidence.statusText = status.text;
    evidence.statusClass = status.cls;
    evidence.screenshot = await capture(panel, appRoot, 'panel-opencode-models.png');
    evidence.ok = status.cls.includes('is-ok') && models.length > 0;
  } catch (error) {
    evidence.error = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    logError('panel-shot', 'OpenCode Go 真机截图失败', error);
  } finally {
    try {
      const dir = path.join(appRoot, ...EVIDENCE_DIR);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'panel-opencode-models.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
        'utf8',
      );
    } catch (error) {
      logWarn('panel-shot', 'OpenCode Go 截图证据写盘失败', { error: String(error) });
    }
    app.quit();
  }
}

export async function runPanelShotIfRequested(): Promise<void> {
  if (process.env['PET_PANEL_OPENCODE_SHOT'] === '1') {
    await runOpenCodeModelsShot();
    return;
  }
  if (process.env['PET_PANEL_SHOT'] !== '1') return;

  const appRoot = app.getAppPath();
  const evidence: Evidence = {
    generatedAt: new Date().toISOString(),
    configPath: '',
    requested: TARGETS,
    rendererReported: null,
    sitFacts: null,
    panelDom: {
      phaseA: null,
      spine: null,
      tuningDetail: null,
      phaseASlider: null,
      spineSlider: null,
      eyeSlider: null,
    },
    configAfterSave: null,
    providers: null,
    modelList: null,
    persona: null,
    memory: null,
    screenshots: [],
    checks: [],
    ok: false,
  };

  // 用户原配置备份：不管脚本怎么折腾，退出前都要还原
  let configPath = '';
  let originalConfig: string | null = null;
  let modelStub: ModelListStub | null = null;

  try {
    logInfo('panel-shot', '控制面板取证开始（PET_PANEL_SHOT=1）');

    // 1) 打开面板（此时角色渲染页已装载完成：bootstrap 在 shell.start 之后才调这里）
    if (!shell.openControlPanel()) throw new Error('控制面板打开失败');
    const panel = await waitFor('面板窗口', () => shell.getControlPanelWindow());
    configPath = shell.panelDiagnostics()?.configPath ?? '';
    evidence.configPath = configPath;
    originalConfig = existsSync(configPath) ? readFileSync(configPath, 'utf8') : null;

    // 2) 等页面脚本就绪 + 拿到第一次渲染侧状态（证明 4Hz 轮询链路通了）
    await waitFor('面板页面脚本', async () => {
      const ready = await panel.webContents.executeJavaScript(
        "document.readyState === 'complete' && Boolean(window.__panelDebug)",
      );
      return ready === true ? true : null;
    });
    await waitFor('渲染侧首次状态回报', () => {
      const diagnostics = shell.panelDiagnostics();
      return diagnostics && diagnostics.render ? diagnostics.render : null;
    });

    // 3) 走页面自己的路径拨三项（与用户拖滑块同一条 DOM → preview → IPC 链）
    await panel.webContents.executeJavaScript(
      `(async () => {
        const debug = window.__panelDebug;
        debug.set('sit.phaseAHeadTuneRad', ${TARGETS['sit.phaseAHeadTuneRad']});
        debug.set('sit.spineOverlayWeight', ${TARGETS['sit.spineOverlayWeight']});
        debug.set('gaze.eyeStiffness', ${TARGETS['gaze.eyeStiffness']});
        await debug.preview();
        return true;
      })()`,
    );
    // 等一轮 4Hz 状态回报（250ms）+ 余量
    await sleep(900);

    const after = shell.panelDiagnostics();
    evidence.rendererReported = after?.render?.tuning ?? null;
    evidence.sitFacts = after?.render?.sit ?? null;

    const dom = (await panel.webContents.executeJavaScript(
      `(() => ({
        phaseA: document.querySelector('#kv-phase-a')?.textContent ?? null,
        spine: document.querySelector('#kv-spine')?.textContent ?? null,
        tuningDetail: document.querySelector('#stat-tuning-detail')?.textContent ?? null,
        phaseASlider:
          document.querySelector('.param[data-id="sit.phaseAHeadTuneRad"] .num')?.value ?? null,
        spineSlider:
          document.querySelector('.param[data-id="sit.spineOverlayWeight"] .num')?.value ?? null,
        eyeSlider:
          document.querySelector('.param[data-id="gaze.eyeStiffness"] .num')?.value ?? null
      }))()`,
    )) as Evidence['panelDom'];
    evidence.panelDom = dom;

    const reported = evidence.rendererReported;
    const check = (name: string, ok: boolean, detail: string): void => {
      evidence.checks.push({ name, ok, detail });
    };
    check(
      '渲染进程收到 A 段抬头 = -0.12',
      reported?.['sit.phaseAHeadTuneRad'] === TARGETS['sit.phaseAHeadTuneRad'],
      `renderer=${String(reported?.['sit.phaseAHeadTuneRad'])}`,
    );
    check(
      '渲染进程收到下背覆盖 = 0.85',
      reported?.['sit.spineOverlayWeight'] === TARGETS['sit.spineOverlayWeight'],
      `renderer=${String(reported?.['sit.spineOverlayWeight'])}`,
    );
    check(
      '渲染进程收到眼球刚度 = 16',
      reported?.['gaze.eyeStiffness'] === TARGETS['gaze.eyeStiffness'],
      `renderer=${String(reported?.['gaze.eyeStiffness'])}`,
    );
    // 面板上的三个数字框都该显示新值（滑块位置与数字框由同一路径更新）
    check(
      '面板数字框显示 -0.120 / 0.85 / 16.0',
      dom.phaseASlider === '-0.120' && dom.spineSlider === '0.85' && dom.eyeSlider === '16.0',
      `boxes=${String(dom.phaseASlider)}|${String(dom.spineSlider)}|${String(dom.eyeSlider)}`,
    );
    // "系统状态"里的"渲染侧生效参数"必须来自渲染进程回报（不是面板本地值）
    check(
      '面板状态页显示渲染侧回报的参数',
      (dom.tuningDetail?.includes('-0.120') ?? false) && (dom.tuningDetail?.includes('16.0') ?? false),
      `detail=${String(dom.tuningDetail)}`,
    );

    // 4) 截图：物理手感（滑块已改，未保存）
    evidence.screenshots.push(await capture(panel, appRoot, 'panel-physics.png'));

    // 5) 保存 → 读回 config.json
    await panel.webContents.executeJavaScript("document.querySelector('#save')?.click(); true");
    await sleep(600);
    if (configPath && existsSync(configPath)) {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      const tuning = (parsed['tuning'] ?? {}) as Record<string, unknown>;
      evidence.configAfterSave = {
        tuning,
        updatedAt: typeof parsed['updatedAt'] === 'string' ? parsed['updatedAt'] : null,
      };
      check('config.json 写入三项改动', Object.keys(tuning).length === 3, `keys=${Object.keys(tuning).join(',')}`);
      check(
        'config.json 里 A 段抬头 = -0.12',
        tuning['sit.phaseAHeadTuneRad'] === TARGETS['sit.phaseAHeadTuneRad'],
        `file=${String(tuning['sit.phaseAHeadTuneRad'])}`,
      );
    } else {
      check('config.json 写入', false, `文件不存在：${configPath}`);
    }

    // 6) 切到"系统状态"截第二张（证明只读页也有真数据）
    await panel.webContents.executeJavaScript(
      "document.querySelector('[data-tab=\"status\"]')?.click(); true",
    );
    await sleep(700);
    evidence.screenshots.push(await capture(panel, appRoot, 'panel-status.png'));

    // 7) ADR 0053：AI 人格页。角色卡真的走一次"编辑 → 保存"，但写的是**隔离副本**
    //    （start.mjs 用 PET_CHARACTER_CARD 把路径指到 logs/selftest/），用户真实人格不受影响。
    const cardPath = shell.panelDiagnostics()?.cardPath ?? '';
    const originalCard = cardPath && existsSync(cardPath) ? readFileSync(cardPath, 'utf8') : null;
    const charsBefore = getRuntime()?.snapshot().orchestrator.cardChars ?? null;
    await panel.webContents.executeJavaScript(
      "document.querySelector('[data-tab=\"persona\"]')?.click(); true",
    );
    await waitFor('角色卡加载', async () => {
      const length = await panel.webContents.executeJavaScript(
        'window.__panelDebug?.cardText?.().length ?? 0',
      );
      return typeof length === 'number' && length > 0 ? length : null;
    });
    const marker = '取证追加：保持简短';
    await panel.webContents.executeJavaScript(
      `(() => {
        const editor = document.querySelector('#card-text');
        if (!editor) return false;
        editor.value = editor.value + "\\n\\n${marker}。";
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#card-save')?.click();
        return true;
      })()`,
    );
    await waitFor('角色卡保存回执', () => (shell.panelDiagnostics()?.cardSavedAt ? true : null));
    await sleep(400);
    const personaDom = (await panel.webContents.executeJavaScript(
      `(() => ({
        cardChars: document.querySelector('#card-badge')?.textContent ?? null,
        cardCounter: document.querySelector('#card-counter')?.textContent ?? null,
        modelBadge: document.querySelector('#model-badge')?.textContent ?? null,
        ttsBadge: document.querySelector('#tts-badge')?.textContent ?? null,
        modelOptions: [...document.querySelectorAll('#model-select option')].map((option) => option.value),
        selectedModel: document.querySelector('#model-select')?.value ?? null
      }))()`,
    )) as {
      cardChars: string | null;
      cardCounter: string | null;
      modelBadge: string | null;
      ttsBadge: string | null;
      modelOptions: string[];
      selectedModel: string | null;
    };
    const runtimeCardChars = getRuntime()?.snapshot().orchestrator.cardChars ?? null;
    // eslint-disable-next-line no-control-regex
    const diskHasMarker =
      cardPath !== '' && existsSync(cardPath) && readFileSync(cardPath, 'utf8').includes(marker);
    evidence.persona = {
      cardPath,
      cardCharsBefore: charsBefore,
      cardCharsAfterSave: runtimeCardChars,
      cardTextOnDiskHasMarker: diskHasMarker,
      modelOptions: personaDom.modelOptions,
      selectedModel: personaDom.selectedModel,
      modelBadge: personaDom.modelBadge,
      ttsBadge: personaDom.ttsBadge,
    };
    check(
      '角色卡保存后运行时的 cardChars 真的变了',
      runtimeCardChars !== null && charsBefore !== null && runtimeCardChars > charsBefore,
      `before=${String(charsBefore)} after=${String(runtimeCardChars)}`,
    );
    check(
      '角色卡落盘包含取证标记（写的是隔离副本）',
      diskHasMarker,
      `path=${cardPath} badge=${String(personaDom.cardChars)} counter=${String(personaDom.cardCounter)}`,
    );
    check(
      '模型下拉至少有一个选项，且徽标给出可读状态',
      personaDom.modelOptions.length >= 1 && (personaDom.modelBadge ?? '').length > 0,
      `options=${personaDom.modelOptions.join(',')} badge=${String(personaDom.modelBadge)}`,
    );
    check(
      'TTS 卡片给出"已配置/未配置"的明确状态',
      (personaDom.ttsBadge ?? '') !== '',
      `tts=${String(personaDom.ttsBadge)}`,
    );
    evidence.screenshots.push(await capture(panel, appRoot, 'panel-persona.png'));

    // 7.1) ADR 0055：提供商列表 / 新增 / 切换失败可见性。
    //      用回环上的"关闭端口"当离线端点：不访问外网、不产生任何真实订阅调用。
    const idsBefore = (await panel.webContents.executeJavaScript(
      'window.__panelDebug?.providers?.().map((entry) => entry.id) ?? []',
    )) as string[];
    const providerFormPresent = (await panel.webContents.executeJavaScript(
      `Boolean(document.querySelector('#provider-type') && document.querySelector('#provider-baseurl') && document.querySelector('#provider-apikey') && document.querySelector('#provider-model') && document.querySelector('#provider-save'))`,
    )) as boolean;
    await panel.webContents.executeJavaScript(
      `(() => {
        const type = document.querySelector('#provider-type');
        type.value = 'openai';
        type.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('#provider-name').value = '离线取证端点';
        document.querySelector('#provider-baseurl').value = 'http://127.0.0.1:9/v1';
        document.querySelector('#provider-model').value = 'offline-model';
        document.querySelector('#provider-apikey').value = 'sk-selftest-not-real';
        document.querySelector('#provider-save').click();
        return true;
      })()`,
    );
    await waitFor('新增提供商进入列表', async () => {
      const count = await panel.webContents.executeJavaScript(
        'window.__panelDebug?.providers?.().length ?? 0',
      );
      return typeof count === 'number' && count >= idsBefore.length + 1 ? count : null;
    });
    const idsAfterAdd = (await panel.webContents.executeJavaScript(
      'window.__panelDebug?.providers?.().map((entry) => entry.id) ?? []',
    )) as string[];
    const addedId = idsAfterAdd.find((id) => !idsBefore.includes(id)) ?? null;
    if (addedId !== null) {
      await panel.webContents.executeJavaScript(
        `(() => {
          const item = document.querySelector('[data-provider-id="${addedId}"]');
          const button = [...(item?.querySelectorAll('button') ?? [])].find((entry) => entry.textContent === '使用');
          button?.click();
          return true;
        })()`,
      );
      await waitFor('离线端点连接失败被面板记录', async () => {
        const providers = (await panel.webContents.executeJavaScript(
          'window.__panelDebug?.providers?.() ?? []',
        )) as Array<{ id: string; active: boolean; test: string | null }>;
        const active = providers.find((entry) => entry.id === addedId);
        return active?.active === true && active.test === 'failed' ? active : null;
      });
    }
    await sleep(300);
    evidence.screenshots.push(await capture(panel, appRoot, 'panel-providers.png'));
    const providerRuntime = getRuntime()?.snapshot();
    const configNow =
      configPath && existsSync(configPath)
        ? (JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>)
        : {};
    const llmConfig = (configNow['llm'] ?? {}) as Record<string, unknown>;
    const configProviders = Array.isArray(llmConfig['providers'])
      ? (llmConfig['providers'] as Array<Record<string, unknown>>)
      : [];
    const configActive = typeof llmConfig['activeProvider'] === 'string' ? llmConfig['activeProvider'] : null;
    const activeProviderFacts = (
      (await panel.webContents.executeJavaScript(
        'window.__panelDebug?.providers?.() ?? []',
      )) as Array<{ id: string; active: boolean; test: string | null; type: string }>
    ).find((entry) => entry.active);
    evidence.providers = {
      idsBefore,
      idsAfterAdd,
      activeAfterSwitch: activeProviderFacts?.id ?? null,
      activeType: providerRuntime?.llm.providerType ?? null,
      activeModel: providerRuntime?.llm.model ?? null,
      testStatus: activeProviderFacts?.test ?? null,
      configProviderCount: configProviders.length,
      configActiveProvider: configActive,
      // 只检查"有没有写进去"，绝不把 Key 明文放进取证文件
      configHasKey: configProviders.some((entry) => entry.apiKey === 'sk-selftest-not-real'),
    };
    check(
      '提供商表单齐全，且默认列表包含本地 Ollama',
      providerFormPresent && idsBefore.includes('local-ollama'),
      `form=${String(providerFormPresent)} before=${idsBefore.join(',')}`,
    );
    check(
      '新增提供商写到 config.json，且 Key 落盘、面板只显示"已保存"',
      addedId !== null &&
        evidence.providers.configProviderCount === idsAfterAdd.length &&
        evidence.providers.configActiveProvider === addedId &&
        evidence.providers.configHasKey,
      `after=${idsAfterAdd.join(',')} config=${String(evidence.providers.configProviderCount)} active=${String(configActive)}`,
    );
    check(
      '切换离线端点后运行时真的换了提供商，面板显示"连接失败"（应用不崩）',
      evidence.providers.activeAfterSwitch === addedId &&
        evidence.providers.activeType === 'openai' &&
        evidence.providers.activeModel === 'offline-model' &&
        evidence.providers.testStatus === 'failed' &&
        providerRuntime !== null,
      `active=${String(evidence.providers.activeAfterSwitch)} type=${String(evidence.providers.activeType)} test=${String(evidence.providers.testStatus)}`,
    );

    // 7.2) ADR 0056：动态模型列表 + Combobox。
    //      本地桩只监听 127.0.0.1，验证"面板 → cmd:fetch-models → 临时客户端 → /models → datalist"整条链，
    //      不访问外网、不产生任何真实订阅调用。
    const stub = await startModelListStub();
    modelStub = stub;
    const stubBaseUrl = `${stub.url}/v1`;
    await panel.webContents.executeJavaScript(
      `(() => {
        document.querySelector('#provider-new')?.click();
        const type = document.querySelector('#provider-type');
        type.value = 'openai';
        type.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('#provider-name').value = '模型列表取证';
        document.querySelector('#provider-baseurl').value = ${JSON.stringify(stubBaseUrl)};
        document.querySelector('#provider-apikey').value = 'sk-selftest-not-real';
        document.querySelector('#provider-model').value = '';
        document.querySelector('#provider-model-refresh').click();
        return true;
      })()`,
    );
    await waitFor('模型列表拉取完成', async () => {
      const models = (await panel.webContents.executeJavaScript(
        'window.__panelDebug?.providerModels?.() ?? []',
      )) as string[];
      return models.length >= 3 ? models : null;
    });
    const modelStatus = (await panel.webContents.executeJavaScript(
      'window.__panelDebug?.providerModelStatus?.() ?? { text: "", cls: "" }',
    )) as { text: string; cls: string };
    const modelChips = (await panel.webContents.executeJavaScript(
      'window.__panelDebug?.providerModelChips?.() ?? []',
    )) as string[];
    const modelFetched = (await panel.webContents.executeJavaScript(
      'window.__panelDebug?.providerModels?.() ?? []',
    )) as string[];
    // 等 2s 节流冷却结束，让 🔄 恢复（截图展示正常态；⏳ 只在冷却期出现）
    await sleep(2100);
    // 让表单完整出现在截图里（模型行 + 状态 + chips）
    await panel.webContents.executeJavaScript(
      "document.querySelector('#provider-form')?.scrollIntoView({ block: 'center' }); true",
    );
    await sleep(200);
    evidence.screenshots.push(await capture(panel, appRoot, 'panel-models.png'));

    // 选下拉里的模型 → 保存 → 切换：证明存进去的是选中的模型名，主进程也真的换了
    await panel.webContents.executeJavaScript(
      `(() => {
        const input = document.querySelector('#provider-model');
        input.value = 'grok-4.7';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#provider-save').click();
        return true;
      })()`,
    );
    const savedModelProvider = await waitFor('模型列表提供商进入列表', async () => {
      const providers = (await panel.webContents.executeJavaScript(
        'window.__panelDebug?.providers?.() ?? []',
      )) as Array<{ id: string; name: string }>;
      return providers.find((entry) => entry.name === '模型列表取证') ?? null;
    });
    await panel.webContents.executeJavaScript(
      `(() => {
        const item = document.querySelector('[data-provider-id="${savedModelProvider.id}"]');
        const button = [...(item?.querySelectorAll('button') ?? [])].find((entry) => entry.textContent === '使用');
        button?.click();
        return true;
      })()`,
    );
    await waitFor('模型列表提供商连接测试通过', async () => {
      const providers = (await panel.webContents.executeJavaScript(
        'window.__panelDebug?.providers?.() ?? []',
      )) as Array<{ id: string; active: boolean; test: string | null }>;
      const active = providers.find((entry) => entry.id === savedModelProvider.id);
      return active?.active === true && active.test === 'ok' ? active : null;
    });

    // 编辑时留空 Key：主进程应注入已保存的 Key。等过 2s 节流窗口再点，确保桩收到新请求。
    await sleep(2200);
    await panel.webContents.executeJavaScript(
      `(() => {
        const item = document.querySelector('[data-provider-id="${savedModelProvider.id}"]');
        const button = [...(item?.querySelectorAll('button') ?? [])].find((entry) => entry.textContent === '编辑');
        button?.click();
        return true;
      })()`,
    );
    await panel.webContents.executeJavaScript(
      `(() => {
        const key = document.querySelector('#provider-apikey');
        key.value = '';
        key.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#provider-model-refresh').click();
        return true;
      })()`,
    );
    await waitFor('留空 Key 仍能拉取模型列表', async () => {
      const status = (await panel.webContents.executeJavaScript(
        'window.__panelDebug?.providerModelStatus?.() ?? { text: "", cls: "" }',
      )) as { text: string; cls: string };
      return status.cls.includes('is-ok') ? status : null;
    });
    const reusedKeyAuth = stub.authHeaders.length > 0 ? stub.authHeaders[stub.authHeaders.length - 1] ?? null : null;

    // 失败路径：关闭端口 + 手填模型名仍可保存
    await panel.webContents.executeJavaScript(
      `(() => {
        document.querySelector('#provider-new')?.click();
        const type = document.querySelector('#provider-type');
        type.value = 'openai';
        type.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('#provider-name').value = '失败取证';
        document.querySelector('#provider-baseurl').value = 'http://127.0.0.1:9/v1';
        document.querySelector('#provider-apikey').value = 'sk-selftest-not-real';
        document.querySelector('#provider-model').value = '';
        document.querySelector('#provider-model-refresh').click();
        return true;
      })()`,
    );
    const failureStatus = await waitFor('模型列表失败提示', async () => {
      const status = (await panel.webContents.executeJavaScript(
        'window.__panelDebug?.providerModelStatus?.() ?? { text: "", cls: "" }',
      )) as { text: string; cls: string };
      return status.cls.includes('is-error') ? status : null;
    });
    const failureFormEnabled = (await panel.webContents.executeJavaScript(
      `(() => ({
        modelDisabled: document.querySelector('#provider-model')?.disabled === true,
        saveDisabled: document.querySelector('#provider-save')?.disabled === true
      }))()`,
    )) as { modelDisabled: boolean; saveDisabled: boolean };
    await panel.webContents.executeJavaScript(
      `(() => {
        const input = document.querySelector('#provider-model');
        input.value = 'manual-model';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#provider-save').click();
        return true;
      })()`,
    );
    const manualModelSaved = await waitFor('失败后手动保存进入列表', async () => {
      const providers = (await panel.webContents.executeJavaScript(
        'window.__panelDebug?.providers?.() ?? []',
      )) as Array<{ name: string }>;
      return providers.some((entry) => entry.name === '失败取证') ? true : null;
    });

    const runtimeAfterModelList = getRuntime()?.snapshot();
    evidence.modelList = {
      fetched: modelFetched,
      chips: modelChips,
      statusText: modelStatus.text,
      statusClass: modelStatus.cls,
      reusedKeyAuth,
      failureStatus: failureStatus.text,
      failureClass: failureStatus.cls,
      manualModelSaved,
      runtimeModel: runtimeAfterModelList?.llm.model ?? null,
      runtimeProviderType: runtimeAfterModelList?.llm.providerType ?? null,
    };
    check(
      '模型列表拉取成功并填入 Combobox（datalist + chips + 绿色状态）',
      modelFetched.includes('grok-4.7') &&
        modelChips.includes('Grok 4.7') &&
        modelStatus.cls.includes('is-ok'),
      `models=${modelFetched.join(',')} chips=${modelChips.join(',')} status=${modelStatus.cls}`,
    );
    check(
      '选择模型保存并切换后，主进程真的在用 grok-4.7',
      runtimeAfterModelList?.llm.model === 'grok-4.7' &&
        runtimeAfterModelList?.llm.providerType === 'openai',
      `model=${String(runtimeAfterModelList?.llm.model)} type=${String(runtimeAfterModelList?.llm.providerType)}`,
    );
    check(
      '编辑时留空 Key 仍可拉取（主进程注入已保存的 Key）',
      reusedKeyAuth === 'Bearer sk-selftest-not-real',
      `auth=${String(reusedKeyAuth)}`,
    );
    check(
      '拉取失败显示红色提示，且仍可手填模型名保存',
      failureStatus.cls.includes('is-error') &&
        failureFormEnabled.modelDisabled === false &&
        failureFormEnabled.saveDisabled === false &&
        manualModelSaved === true,
      `status=${failureStatus.cls} modelDisabled=${String(failureFormEnabled.modelDisabled)} saveDisabled=${String(failureFormEnabled.saveDisabled)} saved=${String(manualModelSaved)}`,
    );
    // 回到新增表单，避免影响后续记忆页
    await panel.webContents.executeJavaScript("document.querySelector('#provider-new')?.click(); true");
    await sleep(200);

    // 8) 记忆页：只读（绝不删用户记忆），验证列表/空态与条数读数
    await panel.webContents.executeJavaScript(
      "document.querySelector('[data-tab=\"memory\"]')?.click(); true",
    );
    await sleep(500);
    const memoryDom = (await panel.webContents.executeJavaScript(
      `(() => {
        const list = document.querySelector('#memory-list');
        return {
          listed: list ? list.children.length : null,
          countText: document.querySelector('#memory-count')?.textContent ?? null,
          rowsText: document.querySelector('#memory-rows')?.textContent ?? null,
          badge: document.querySelector('#memory-badge')?.textContent ?? null,
          emptyVisible: document.querySelector('#memory-empty')
            ? !document.querySelector('#memory-empty').classList.contains('is-hidden')
            : null
        };
      })()`,
    )) as {
      listed: number | null;
      countText: string | null;
      rowsText: string | null;
      badge: string | null;
      emptyVisible: boolean | null;
    };
    const runtimeRows = getRuntime()?.snapshot().memory.rows ?? null;
    evidence.memory = {
      rows: runtimeRows,
      listed: memoryDom.listed,
      countText: memoryDom.countText,
      badge: memoryDom.badge,
      emptyVisible: memoryDom.emptyVisible,
      seeded: 0,
      listedAfterSeed: null,
      listedAfterDelete: null,
      deleteDeleted: null,
      cleared: null,
      listedAfterClear: null,
      emptyAfterClear: null,
    };
    check(
      '记忆页显示条数，且"列表为空"与"空态提示"一致',
      (memoryDom.countText ?? '').length > 0 &&
        (memoryDom.listed === 0 ? memoryDom.emptyVisible === true : memoryDom.emptyVisible === false),
      `listed=${String(memoryDom.listed)} count=${String(memoryDom.countText)} empty=${String(memoryDom.emptyVisible)}`,
    );

    // 8.1) 写入路径：往**隔离**记忆库里种两条，走 UI 的"删除 / 清空"验证真的删掉了。
    //      只有 PET_MEMORY_DB 被指向 logs/selftest 时才做（防止误删用户记忆）。
    const memoryDb = process.env['PET_MEMORY_DB'] ?? '';
    if (memoryDb !== '' && memoryDb.replace(/\\/g, '/').includes('logs/selftest')) {
      const seeded = seedIsolatedMemory(memoryDb, ['取证记忆 Alpha', '取证记忆 Beta']);
      evidence.memory.seeded = seeded;
      // 刷新列表（按钮绕过节流），等两拍让 IPC 往返完成
      await panel.webContents.executeJavaScript(
        "document.querySelector('#memory-refresh')?.click(); true",
      );
      await sleep(900);
      const afterSeed = (await panel.webContents.executeJavaScript(
        `document.querySelector('#memory-list')?.children.length ?? null`,
      )) as number | null;
      evidence.memory.listedAfterSeed = afterSeed;
      // 截图：列表里真的有几条（在删之前截，删完就只剩空态了）
      evidence.screenshots.push(await capture(panel, appRoot, 'panel-memory.png'));

      // 删除第一条：点列表里第一个"删除"按钮
      const before = afterSeed ?? 0;
      const deleteStart = Date.now();
      await panel.webContents.executeJavaScript(
        `(() => { const button = document.querySelector('#memory-list .memory-item button'); button?.click(); return true; })()`,
      );
      let afterDelete: number | null = null;
      for (;;) {
        afterDelete = (await panel.webContents.executeJavaScript(
          `document.querySelector('#memory-list')?.children.length ?? null`,
        )) as number | null;
        if (afterDelete !== null && afterDelete < before) break;
        if (Date.now() - deleteStart > 4000) break;
        await sleep(120);
      }
      evidence.memory.listedAfterDelete = afterDelete;
      evidence.memory.deleteDeleted = afterDelete !== null && afterDelete < before;

      // 清空：第一次点击进入确认态，第二次才真的清
      await panel.webContents.executeJavaScript(
        "document.querySelector('#memory-clear')?.click(); true",
      );
      await sleep(120);
      await panel.webContents.executeJavaScript(
        "document.querySelector('#memory-clear')?.click(); true",
      );
      await sleep(900);
      const afterClearDom = (await panel.webContents.executeJavaScript(
        `(() => ({
          listed: document.querySelector('#memory-list')?.children.length ?? null,
          emptyVisible: document.querySelector('#memory-empty')
            ? !document.querySelector('#memory-empty').classList.contains('is-hidden')
            : null
        }))()`,
      )) as { listed: number | null; emptyVisible: boolean | null };
      evidence.memory.listedAfterClear = afterClearDom.listed;
      evidence.memory.emptyAfterClear = afterClearDom.emptyVisible;
      evidence.memory.cleared = getRuntime()?.snapshot().memory.rows ?? null;
      check(
        '记忆页：删除一条后列表变短',
        evidence.memory.deleteDeleted === true && (afterDelete ?? 99) === before - 1,
        `before=${String(before)} after=${String(afterDelete)}`,
      );
      check(
        '记忆页：两次确认后清空，行数与空态都归零',
        evidence.memory.cleared === 0 &&
          afterClearDom.listed === 0 &&
          afterClearDom.emptyVisible === true,
        `rows=${String(evidence.memory.cleared)} listed=${String(afterClearDom.listed)} empty=${String(afterClearDom.emptyVisible)}`,
      );
    } else {
      logWarn('panel-shot', 'PET_MEMORY_DB 未指向隔离库，跳过记忆写入取证（不删用户记忆）', {
        memoryDb,
      });
      // 无隔离库时至少截一张只读列表
      evidence.screenshots.push(await capture(panel, appRoot, 'panel-memory.png'));
    }

    // 9) 恢复默认 + 还原用户原配置（脚本不得改变用户手感）
    await panel.webContents.executeJavaScript("document.querySelector('#reset')?.click(); true");
    await sleep(500);
    // 角色卡：写回原始内容（若原本不存在则删掉副本）
    try {
      if (cardPath) {
        if (originalCard !== null) writeFileSync(cardPath, originalCard, 'utf8');
        else if (existsSync(cardPath)) rmSync(cardPath, { force: true });
      }
    } catch (error) {
      logWarn('panel-shot', '还原角色卡失败', { error: String(error) });
    }

    evidence.ok = evidence.checks.every((item) => item.ok);
    const file = await writeEvidence(appRoot, evidence);
    logInfo('panel-shot', `取证完成 ok=${String(evidence.ok)} evidence=${file}`, {
      checks: evidence.checks,
      screenshots: evidence.screenshots,
    });
  } catch (error) {
    evidence.error = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    logError('panel-shot', '控制面板取证失败', error);
    try {
      await writeEvidence(appRoot, evidence);
    } catch (writeError) {
      logWarn('panel-shot', '取证结果写盘失败', { error: String(writeError) });
    }
  } finally {
    // 还原用户配置：脚本只取证，不留下任何"手感改动"
    try {
      if (configPath) {
        if (originalConfig !== null) writeFileSync(configPath, originalConfig, 'utf8');
        else if (existsSync(configPath)) rmSync(configPath, { force: true });
      }
    } catch (error) {
      logWarn('panel-shot', '还原 config.json 失败（用户手感可能被改动）', { error: String(error) });
    }
    try {
      if (modelStub) await modelStub.close();
    } catch (error) {
      logWarn('panel-shot', '关闭模型列表桩失败', { error: String(error) });
    }
    app.quit();
  }
}
