/**
 * 控制面板的页面逻辑（ADR 0052 D1/D3；ADR 0053 加 AI 人格 / 记忆管理）。
 *
 * 四条纪律：
 * 1. **唯一出口是 `window.petPanel`**（preload 注入的 `cmd:panel` / `cmd:panel-state`），
 *    本文件不碰 Node、不拼 IPC 通道名、不发任何网络请求。
 * 2. **主进程是唯一权威**：每次 invoke 返回的 `values` 都整组覆盖本地状态，
 *    面板自己的拖动只是"先给个即时反馈"，最终以主进程回包为准。
 * 3. **拖动即预览**：滑块 `input` 触发防抖后的 `preview`（不写盘），
 *    松手/改数值框立即补发一次；只有「保存并应用」才落 `config.json`。
 * 4. **写操作都要回执**（ADR 0053）：角色卡 / 模型 / 记忆的每次改动都以主进程回包为准，
 *    失败时把主进程给的 `error` 原样显示——面板不猜"大概成功了吧"。
 */
import {
  clampTunableValue,
  diffTunableValues,
  formatTunableValue,
  TUNABLE_DEFAULTS,
  TUNABLE_META,
  TUNABLE_ORDER,
} from '../../shared/tunable-params';
import type { TunableId, TunableValues } from '../../shared/tunable-params';
import type {
  PanelAction,
  PanelCardFacts,
  PanelFetchModelsRequest,
  PanelFetchModelsResult,
  PanelMemoryFacts,
  PanelModelOption,
  PanelPersonaFacts,
  PanelProviderFacts,
  PanelProviderTestFacts,
  PanelResult,
  PanelStatus,
} from '../../shared/panel';
import type { MemoryRecord } from '../../shared/memory-types';
import { LLM_MODEL_LIST_THROTTLE_MS } from '../../shared/constants';
import {
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_DEFAULT_MODEL,
  type LlmModelOption,
  type LlmProviderType,
} from '../../shared/llm-providers';

declare global {
  interface Window {
    petPanel: {
      invoke(action: PanelAction): Promise<PanelResult>;
      onState(listener: (status: PanelStatus) => void): () => void;
      /** ADR 0056：拉取模型列表（只读；已保存的 Key 由主进程注入） */
      fetchModels(request: PanelFetchModelsRequest): Promise<PanelFetchModelsResult>;
    };
  }
}

const TAB_HEADERS: Record<string, { title: string; desc: string; actions: boolean }> = {
  physics: {
    title: '物理手感',
    desc: '拖动滑块即刻生效。满意后点「保存并应用」写入 config.json，重启后仍然生效。',
    actions: true,
  },
  status: {
    title: '系统状态',
    desc: '桌宠此刻在做什么。读数来自渲染进程的 4Hz 回报，只在面板可见时刷新。',
    actions: false,
  },
  persona: {
    title: 'AI 人格',
    desc: '切换 LLM 提供商 / 换本地模型 / 改角色卡 / 测语音。保存后下一轮对话生效，不用重启应用。',
    actions: false,
  },
  memory: {
    title: '记忆管理',
    desc: '本地 SQLite 记忆库：看最近聊过什么，删掉某一条，或让她彻底失忆。',
    actions: false,
  },
};

const PREVIEW_DEBOUNCE_MS = 60;
/** 记忆列表自动重取的节流：状态 4Hz，但列表不该每 250ms 重建 */
const MEMORY_REFRESH_MS = 2000;
/** "再点一次确认清空"的窗口期 */
const CLEAR_CONFIRM_MS = 5000;

function must<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`控制面板缺少元素：${selector}`);
  return element;
}

const dom = {
  configPath: must<HTMLElement>('#config-path'),
  savedAt: must<HTMLElement>('#saved-at'),
  changedChip: must<HTMLElement>('#changed-chip'),
  pageTitle: must<HTMLElement>('#page-title'),
  pageDesc: must<HTMLElement>('#page-desc'),
  sections: must<HTMLElement>('#param-sections'),
  actions: must<HTMLElement>('#actions'),
  save: must<HTMLButtonElement>('#save'),
  reset: must<HTMLButtonElement>('#reset'),
  toast: must<HTMLElement>('#toast'),
  // AI 人格
  providerList: must<HTMLUListElement>('#provider-list'),
  providerEmpty: must<HTMLElement>('#provider-empty'),
  providerActiveBadge: must<HTMLElement>('#provider-active-badge'),
  providerForm: must<HTMLElement>('#provider-form'),
  providerFormTitle: must<HTMLElement>('#provider-form-title'),
  providerFormStatus: must<HTMLElement>('#provider-form-status'),
  providerNew: must<HTMLButtonElement>('#provider-new'),
  providerType: must<HTMLSelectElement>('#provider-type'),
  providerTypeHint: must<HTMLElement>('#provider-type-hint'),
  providerName: must<HTMLInputElement>('#provider-name'),
  providerBaseUrl: must<HTMLInputElement>('#provider-baseurl'),
  providerBaseUrlHint: must<HTMLElement>('#provider-baseurl-hint'),
  providerApiKey: must<HTMLInputElement>('#provider-apikey'),
  providerApiKeyHint: must<HTMLElement>('#provider-apikey-hint'),
  providerModel: must<HTMLInputElement>('#provider-model'),
  providerModelList: must<HTMLDataListElement>('#provider-model-options'),
  providerModelRefresh: must<HTMLButtonElement>('#provider-model-refresh'),
  providerModelStatus: must<HTMLElement>('#provider-model-status'),
  providerModelChips: must<HTMLElement>('#provider-model-chips'),
  providerModelHint: must<HTMLElement>('#provider-model-hint'),
  providerSave: must<HTMLButtonElement>('#provider-save'),
  providerCancel: must<HTMLButtonElement>('#provider-cancel'),
  modelSelect: must<HTMLSelectElement>('#model-select'),
  modelBadge: must<HTMLElement>('#model-badge'),
  modelDetail: must<HTMLElement>('#model-detail'),
  modelApply: must<HTMLButtonElement>('#model-apply'),
  modelRefresh: must<HTMLButtonElement>('#model-refresh'),
  cardBadge: must<HTMLElement>('#card-badge'),
  cardPath: must<HTMLElement>('#card-path'),
  cardLlmUrl: must<HTMLElement>('#card-llm-url'),
  cardText: must<HTMLTextAreaElement>('#card-text'),
  cardCounter: must<HTMLElement>('#card-counter'),
  cardSave: must<HTMLButtonElement>('#card-save'),
  cardReload: must<HTMLButtonElement>('#card-reload'),
  ttsBadge: must<HTMLElement>('#tts-badge'),
  ttsRef: must<HTMLElement>('#tts-ref'),
  ttsUrl: must<HTMLElement>('#tts-url'),
  ttsResult: must<HTMLElement>('#tts-result'),
  ttsTest: must<HTMLButtonElement>('#tts-test'),
  // 记忆
  memoryBadge: must<HTMLElement>('#memory-badge'),
  memoryPath: must<HTMLElement>('#memory-path'),
  memorySize: must<HTMLElement>('#memory-size'),
  memoryUpdated: must<HTMLElement>('#memory-updated'),
  memoryRows: must<HTMLElement>('#memory-rows'),
  memoryEnabled: must<HTMLElement>('#memory-enabled'),
  memoryCount: must<HTMLElement>('#memory-count'),
  memoryList: must<HTMLUListElement>('#memory-list'),
  memoryEmpty: must<HTMLElement>('#memory-empty'),
  memoryRefresh: must<HTMLButtonElement>('#memory-refresh'),
  memoryClear: must<HTMLButtonElement>('#memory-clear'),
  clearHint: must<HTMLElement>('#clear-hint'),
};

const valueNodes = new Map<TunableId, { row: HTMLElement; number: HTMLInputElement; slider: HTMLInputElement }>();

let values: TunableValues = { ...TUNABLE_DEFAULTS };
let savedAt: string | null = null;
let pending: number | null = null;
let inflight = false;
let toastTimer: number | null = null;
let currentTab = 'physics';

/** 人格/记忆页的本地视图状态（权威值仍来自主进程推送） */
let cardLoaded = false;
let cardDirty = false;
let cardChars = 0;
let personaView: PanelPersonaFacts | null = null;
let memoryView: PanelMemoryFacts | null = null;
let memoryFetchedAt = Number.NEGATIVE_INFINITY;
let memoryLoading = false;
let lastModelsKey = '';
let lastRenderedRows = -1;
let clearArmedTimer: number | null = null;
let clearArmed = false;
let ttsBusy = false;

/** 截图/自检脚本读它，证明"页面上的数字"与"发出去的值"一致 */
const debugHook = {
  values: (): TunableValues => ({ ...values }),
  preview: (): Promise<PanelResult> => invoke({ action: 'preview', values: { ...values } }),
  set(id: string, raw: number): void {
    if (!(id in TUNABLE_META)) return;
    // 与用户拖动同一条路径：滑块位置、数字框、徽标一起更新
    setParam(id as TunableId, raw);
    void flushPreview();
  },
  /** 截图脚本用：直接切到某一页（复用 UI 的切换路径） */
  tab(name: string): void {
    setTab(name);
  },
  /** 截图脚本用：当前角色卡文本（不含未加载状态） */
  cardText: (): string => dom.cardText.value,
  /** 截图脚本用：当前记忆条数（DOM 里的 li 数） */
  memoryItems: (): number => dom.memoryList.children.length,
  /** 截图脚本用：提供商列表与当前生效项（不含任何 Key） */
  providers: (): Array<{ id: string; type: string; name: string; active: boolean; test: string | null }> =>
    providerView.map((entry) => ({
      id: entry.id,
      type: entry.type,
      name: entry.name,
      active: entry.active,
      test: entry.test?.status ?? null,
    })),
  /** ADR 0056：模型 Combobox 的 datalist 选项（截图脚本断言"真的填进去了"） */
  providerModels: (): string[] => [...dom.providerModelList.options].map((option) => option.value),
  /** ADR 0056：模型行的状态文案与颜色类（截图脚本断言成功/失败提示） */
  providerModelStatus: (): { text: string; cls: string } => ({
    text: dom.providerModelStatus.textContent ?? '',
    cls: dom.providerModelStatus.className,
  }),
  /** ADR 0056：拉取成功后渲染的模型 chips（截图里能直接看到可用模型） */
  providerModelChips: (): string[] =>
    [...dom.providerModelChips.querySelectorAll('button')].map(
      (button) => button.textContent ?? '',
    ),
};
(window as unknown as { __panelDebug?: typeof debugHook }).__panelDebug = debugHook;

function formatSavedAt(iso: string | null): string {
  if (!iso) return '从未保存';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '从未保存';
  return formatClock(date);
}

/** 记忆行的时间戳是 epoch 毫秒（契约 §7.5），不是 ISO 字符串 */
function formatEpoch(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '—';
  return formatClock(date);
}

function formatClock(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function shortConfigPath(path: string): string {
  if (!path) return '—';
  const parts = path.split(/[\\/]/).filter((part) => part !== '');
  if (parts.length <= 2) return path;
  return `…\\${parts.slice(-2).join('\\')}`;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '—';
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function showToast(message: string, kind: 'ok' | 'error' = 'ok'): void {
  dom.toast.textContent = message;
  dom.toast.classList.toggle('is-error', kind === 'error');
  dom.toast.classList.add('is-visible');
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    dom.toast.classList.remove('is-visible');
    toastTimer = null;
  }, 2600);
}

function refreshConfigFacts(result: PanelResult): void {
  values = { ...result.values };
  savedAt = result.config.savedAt;
  dom.configPath.textContent = shortConfigPath(result.config.configPath);
  dom.configPath.title = result.config.configPath;
  dom.savedAt.textContent = formatSavedAt(savedAt);
  const changed = Object.keys(diffTunableValues(values)).length;
  dom.changedChip.textContent = changed === 0 ? '默认参数' : `已改 ${changed} 项`;
  dom.changedChip.classList.toggle('is-dirty', changed > 0);
}

/** 把一组值写回所有控件（拖动中不动正在拖的那个，避免滑块抖动） */
function refreshAllParams(): void {
  for (const id of TUNABLE_ORDER) {
    const entry = valueNodes.get(id);
    if (!entry) continue;
    const meta = TUNABLE_META[id];
    const value = values[id];
    applyParamUi(id, entry, value);
    entry.number.value = value.toFixed(meta.decimals);
  }
  const changed = Object.keys(diffTunableValues(values)).length;
  dom.changedChip.textContent = changed === 0 ? '默认参数' : `已改 ${changed} 项`;
  dom.changedChip.classList.toggle('is-dirty', changed > 0);
}

/** 单个参数的视觉同步：滑块位置 + 填充比例 + "已改"标记 */
function applyParamUi(
  id: TunableId,
  entry: { row: HTMLElement; number: HTMLInputElement; slider: HTMLInputElement },
  value: number,
): void {
  const meta = TUNABLE_META[id];
  entry.row.classList.toggle('is-modified', value !== TUNABLE_DEFAULTS[id]);
  entry.slider.value = String(value);
  const pct = ((value - meta.min) / (meta.max - meta.min)) * 100;
  entry.slider.style.setProperty('--pct', `${Math.min(100, Math.max(0, pct))}%`);
}

function setParam(id: TunableId, raw: number, markOnly = false): void {
  const next = clampTunableValue(id, raw);
  if (next === values[id]) return;
  values[id] = next;
  const entry = valueNodes.get(id);
  if (entry) {
    const meta = TUNABLE_META[id];
    applyParamUi(id, entry, next);
    if (!markOnly) entry.number.value = next.toFixed(meta.decimals);
  }
  const changed = Object.keys(diffTunableValues(values)).length;
  dom.changedChip.textContent = changed === 0 ? '默认参数' : `已改 ${changed} 项`;
  dom.changedChip.classList.toggle('is-dirty', changed > 0);
}

async function invoke(action: PanelAction): Promise<PanelResult> {
  try {
    return await window.petPanel.invoke(action);
  } catch (error) {
    return {
      ok: false,
      values: { ...values },
      config: { configPath: '', savedAt, loadedFromFile: false },
      error: String(error),
    };
  }
}

async function flushPreview(): Promise<PanelResult> {
  if (pending !== null) {
    window.clearTimeout(pending);
    pending = null;
  }
  if (inflight) {
    return { ok: true, values: { ...values }, config: { configPath: '', savedAt, loadedFromFile: false } };
  }
  inflight = true;
  try {
    const result = await invoke({ action: 'preview', values: { ...values } });
    if (!result.ok && result.error) showToast(result.error, 'error');
    return result;
  } finally {
    inflight = false;
  }
}

function schedulePreview(): void {
  if (pending !== null) window.clearTimeout(pending);
  pending = window.setTimeout(() => {
    pending = null;
    void flushPreview();
  }, PREVIEW_DEBOUNCE_MS);
}

function buildParamUi(): void {
  const cards = new Map<string, HTMLElement>();
  for (const id of TUNABLE_ORDER) {
    const meta = TUNABLE_META[id];
    let card = cards.get(meta.section);
    if (!card) {
      const element = document.createElement('div');
      element.className = 'card';
      const head = document.createElement('div');
      head.className = 'card-head';
      const heading = document.createElement('h3');
      heading.textContent = meta.section;
      const hint = document.createElement('span');
      hint.className = 'card-hint';
      // ADR 0057 D2：分组提示词由参数元数据给出（新增"整体缩放"卡片时不必再改这里）
      hint.textContent =
        meta.sectionHint ??
        (meta.section === '坐姿' ? '仅坐姿（吸附到窗口边缘）时可见' : '光标在她身上移动时可见');
      head.append(heading, hint);
      element.append(head);
      card = element;
      cards.set(meta.section, card);
      dom.sections.append(card);
    }

    const row = document.createElement('div');
    row.className = 'param';
    row.dataset['id'] = id;

    // 第一行：名称 / 常量名 · 滑块 · 数字框
    const main = document.createElement('div');
    main.className = 'param-main';
    const name = document.createElement('div');
    name.className = 'param-label';
    const label = document.createElement('label');
    label.textContent = meta.label;
    label.htmlFor = `range-${id}`;
    const constant = document.createElement('span');
    constant.className = 'param-const';
    constant.textContent = meta.constant;
    name.append(label, constant);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.id = `range-${id}`;
    slider.min = String(meta.min);
    slider.max = String(meta.max);
    slider.step = String(meta.step);
    slider.setAttribute('aria-label', meta.label);

    const number = document.createElement('input');
    number.type = 'number';
    number.className = 'num';
    number.min = String(meta.min);
    number.max = String(meta.max);
    number.step = String(meta.step);
    number.setAttribute('aria-label', `${meta.label}（精确输入）`);

    main.append(name, slider, number);

    // 第二行：一句说明 + 默认值（改了会追加"· 已改"）
    const sub = document.createElement('div');
    sub.className = 'param-sub';
    const hint = document.createElement('p');
    hint.className = 'param-hint';
    hint.textContent = meta.hint;
    hint.title = meta.hint;
    const fallback = document.createElement('span');
    fallback.className = 'param-default';
    fallback.textContent = `默认 ${formatTunableValue(id, TUNABLE_DEFAULTS[id])}`;
    sub.append(hint, fallback);

    row.append(main, sub);
    card.append(row);

    valueNodes.set(id, { row, number, slider });

    slider.addEventListener('input', () => {
      setParam(id, Number(slider.value));
      schedulePreview();
    });
    slider.addEventListener('change', () => {
      setParam(id, Number(slider.value));
      void flushPreview();
    });
    number.addEventListener('change', () => {
      setParam(id, Number(number.value));
      void flushPreview();
    });
    // 数字框的 ↑/↓ 步进：立即生效（不用等 `change`）
    number.addEventListener('input', () => {
      setParam(id, Number(number.value));
      schedulePreview();
    });
  }
}

function setTab(tab: string): void {
  const header = TAB_HEADERS[tab];
  if (!header) return;
  currentTab = tab;
  for (const button of document.querySelectorAll<HTMLElement>('.nav-item')) {
    const active = button.dataset['tab'] === tab;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  }
  for (const page of document.querySelectorAll<HTMLElement>('.page')) {
    page.classList.toggle('is-active', page.dataset['page'] === tab);
  }
  dom.pageTitle.textContent = header.title;
  dom.pageDesc.textContent = header.desc;
  dom.actions.classList.toggle('is-hidden', !header.actions);
  // "已改 N 项"只描述物理手感页的参数草稿；挂在人格/记忆页会让人以为改的是角色卡
  dom.changedChip.classList.toggle('is-hidden', tab !== 'physics');
  must<HTMLElement>('#pages').scrollTop = 0;

  // 页签第一次打开才拉内容：面板常驻，不必在 boot 时就把角色卡和记忆全读一遍
  if (tab === 'persona' && !cardLoaded) void loadCard();
  if (tab === 'memory') void loadMemories(true);
}

// ---------------------------------------------------------------------------
// ADR 0053：本地模型
// ---------------------------------------------------------------------------

function modelOptionsKey(models: PanelModelOption[], current: string): string {
  return `${models.map((entry) => `${entry.name}@${entry.sizeBytes ?? ''}`).join('|')}#${current}`;
}

function syncModelSelect(models: PanelModelOption[], current: string): void {
  const key = modelOptionsKey(models, current);
  if (key === lastModelsKey) return;
  lastModelsKey = key;
  const previous = dom.modelSelect.value;
  dom.modelSelect.innerHTML = '';
  const known = models.some((entry) => entry.name === current);
  if (!known && current !== '') {
    const option = document.createElement('option');
    option.value = current;
    option.textContent = `${current}（未探测到）`;
    dom.modelSelect.append(option);
  }
  for (const entry of models) {
    const option = document.createElement('option');
    option.value = entry.name;
    option.textContent =
      entry.sizeBytes === null ? entry.name : `${entry.name} · ${formatBytes(entry.sizeBytes)}`;
    dom.modelSelect.append(option);
  }
  // 用户在列表刷新期间选过别的：只有当旧值仍存在时才保留，否则回到当前生效模型
  const candidates = [...dom.modelSelect.options].map((option) => option.value);
  dom.modelSelect.value = candidates.includes(previous) ? previous : current;
  if (dom.modelSelect.value === '' && candidates.length > 0) {
    dom.modelSelect.value = candidates.includes(current) ? current : candidates[0]!;
  }
}

let currentLlmModel = '';
let ollamaReachable = false;
let ollamaModelCount = 0;

/**
 * 「切换」按钮只在"选中项 ≠ 当前生效模型"且探测正常时可用。
 * 不能只看 `modelPresent`：`modelPresent` 描述的是**当前生效**模型，
 * 用户从下拉里选了另一个时按钮必须亮起来（ADR 0053）。
 */
function syncModelApplyState(): void {
  dom.modelApply.disabled =
    !ollamaReachable ||
    ollamaModelCount === 0 ||
    dom.modelSelect.value === '' ||
    dom.modelSelect.value === currentLlmModel;
}

function renderModelFacts(persona: PanelPersonaFacts, ollama: PanelStatus['ollama']): void {
  const models = ollama.models;
  syncModelSelect(models, persona.llmModel);
  const reachable = ollama.reachable;
  currentLlmModel = persona.llmModel;
  ollamaReachable = reachable;
  ollamaModelCount = models.length;
  const remote = persona.llmProviderType !== 'ollama';
  if (remote) {
    dom.modelBadge.className = 'panel-card-tag ok';
    dom.modelBadge.textContent = `${persona.llmProviderName} · ${persona.llmModel}`;
    dom.modelDetail.textContent = `当前生效的是远程提供商 ${persona.llmProviderName}（${persona.llmBaseUrl}）；下面的探测与切换只作用于本地 Ollama。`;
    dom.modelApply.textContent = '更新本地';
  } else {
    dom.modelBadge.className = `panel-card-tag ${
      ollama.status === 'online' ? 'ok' : ollama.status === 'offline' ? 'bad' : 'warn'
    }`;
    dom.modelBadge.textContent =
      ollama.status === 'online' ? `${persona.llmModel} · 在线` : reachable ? '服务在线 · 缺模型' : '未连接';
    dom.modelDetail.textContent =
      ollama.status === 'online'
        ? `GET ${ollama.baseUrl}/api/tags · ${ollama.latencyMs ?? '?'}ms · 共 ${models.length} 个本地模型`
        : ollama.detail ?? `${ollama.baseUrl} 不可达（Ollama 没启动？）`;
    dom.modelApply.textContent = '切换';
  }
  syncModelApplyState();
}

async function applyModel(): Promise<void> {
  const model = dom.modelSelect.value;
  if (!model) return;
  dom.modelApply.disabled = true;
  const result = await invoke({ action: 'set-model', model });
  if (!result.ok) {
    syncModelApplyState();
    showToast(result.error ?? '模型切换失败', 'error');
    return;
  }
  // 回包里的 model 才是权威（主进程可能已经在用同一模型而给出"已经在用"）
  const applied = result.model ?? model;
  if (personaView) renderModelFacts({ ...personaView, llmModel: applied }, lastOllama);
  syncModelApplyState();
  showToast(result.notice ?? `已换成 ${applied}，下一轮对话生效`);
}

let lastOllama: PanelStatus['ollama'] = {
  status: 'unknown',
  baseUrl: '',
  model: '',
  latencyMs: null,
  detail: null,
  checkedAt: null,
  reachable: false,
  modelPresent: false,
  models: [],
};

// ---------------------------------------------------------------------------
// ADR 0055：LLM 提供商
// ---------------------------------------------------------------------------

const PROVIDER_TYPE_LABEL: Record<LlmProviderType, string> = {
  ollama: 'Ollama（本地）',
  openai: 'OpenAI 兼容',
  'opencode-go': 'OpenCode Go',
};

let providerView: PanelProviderFacts[] = [];
/** 正在编辑的提供商 id；`null` = 表单处于"新增"模式 */
let editingProviderId: string | null = null;
let providerBusy = false;
let lastProviderListKey = '';

function providerTypeOf(raw: string): LlmProviderType {
  return raw === 'openai' || raw === 'opencode-go' ? raw : 'ollama';
}

function providerTestTag(test: PanelProviderTestFacts | null): { text: string; cls: string } {
  if (!test) return { text: '未测试', cls: 'warn' };
  return test.status === 'ok'
    ? { text: `已连接${test.latencyMs === null ? '' : ` · ${test.latencyMs}ms`}`, cls: 'ok' }
    : { text: '连接失败', cls: 'bad' };
}

function providerListKey(facts: PanelProviderFacts[]): string {
  return facts
    .map(
      (entry) =>
        `${entry.id}:${entry.active ? 1 : 0}:${entry.name}:${entry.model}:${entry.hasApiKey ? 1 : 0}:${entry.test?.status ?? '-'}:${entry.test?.checkedAt ?? ''}`,
    )
    .join('|');
}

function renderProviderFacts(facts: PanelProviderFacts[]): void {
  providerView = facts;
  const active = facts.find((entry) => entry.active) ?? null;
  const activeFailed = active?.test?.status === 'failed';
  dom.providerActiveBadge.className = `panel-card-tag ${active ? (activeFailed ? 'bad' : active.test?.status === 'ok' ? 'ok' : 'warn') : 'warn'}`;
  dom.providerActiveBadge.textContent = active
    ? `当前：${active.name}${activeFailed ? '（连接失败）' : ''}`
    : '未配置';
  const key = providerListKey(facts);
  if (key !== lastProviderListKey) {
    lastProviderListKey = key;
    dom.providerList.innerHTML = '';
    for (const entry of facts) {
      const item = document.createElement('li');
      item.className = `provider-item${entry.active ? ' is-active' : ''}`;
      item.dataset['providerId'] = entry.id;

      const main = document.createElement('div');
      main.className = 'provider-main';
      const title = document.createElement('div');
      title.className = 'provider-title';
      const name = document.createElement('span');
      name.textContent = entry.name;
      title.append(name);
      if (entry.active) {
        const activeTag = document.createElement('span');
        activeTag.className = 'panel-card-tag ok';
        activeTag.textContent = '使用中';
        title.append(activeTag);
      }
      const testTagInfo = providerTestTag(entry.test);
      const testTag = document.createElement('span');
      testTag.className = `panel-card-tag ${testTagInfo.cls}`;
      testTag.textContent = testTagInfo.text;
      testTag.title = entry.test?.detail ?? '还没有测试过连接';
      title.append(testTag);

      const meta = document.createElement('div');
      meta.className = 'provider-meta';
      meta.textContent = `${PROVIDER_TYPE_LABEL[entry.type]} · ${entry.model} · ${entry.baseUrl}${
        entry.hasApiKey ? ' · Key 已保存' : ' · 无 Key'
      }`;

      const actions = document.createElement('div');
      actions.className = 'provider-actions';
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'btn tiny ghost';
      use.textContent = '使用';
      use.disabled = entry.active;
      use.addEventListener('click', () => void activateProvider(entry.id));
      const test = document.createElement('button');
      test.type = 'button';
      test.className = 'btn tiny ghost';
      test.textContent = '测试';
      test.addEventListener('click', () => void testProvider(entry.id));
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'btn tiny ghost';
      edit.textContent = '编辑';
      edit.addEventListener('click', () => beginProviderEdit(entry));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn tiny danger';
      remove.textContent = '删除';
      const lastOllama =
        entry.type === 'ollama' && facts.filter((candidate) => candidate.type === 'ollama').length <= 1;
      remove.disabled = facts.length <= 1 || lastOllama;
      remove.title = lastOllama ? '本地 Ollama 是默认回退选项，至少要保留一个' : '';
      remove.addEventListener('click', () => void deleteProvider(entry));
      actions.append(use, test, edit, remove);

      main.append(title, meta);
      item.append(main, actions);
      dom.providerList.append(item);
    }
  }
  dom.providerEmpty.classList.toggle('is-hidden', facts.length > 0);
}

let modelFetchBusy = false;
let modelFetchTimer: number | null = null;
/** 每次改类型/地址都 +1；在途请求回来时序号不一致就丢弃，避免旧清单填进新表单 */
let modelFetchSeq = 0;
/** 当前模型清单来源：Ollama 探测 / 手动刷新 / 编辑回填。刷新结果优先，不被 4Hz 探测覆盖 */
let modelOptionsSource: 'none' | 'probe' | 'fetch' | 'edit' = 'none';
let lastOllamaOptionsKey = '';

function setModelStatus(text: string, kind: 'idle' | 'ok' | 'warn' | 'error' = 'idle'): void {
  dom.providerModelStatus.textContent = text;
  dom.providerModelStatus.className = `field-status${kind === 'idle' ? '' : ` is-${kind}`}`;
}

function renderModelChips(models: LlmModelOption[]): void {
  dom.providerModelChips.innerHTML = '';
  const shown = models.slice(0, 12);
  for (const model of shown) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'model-chip';
    chip.textContent = model.name;
    chip.title = model.id;
    chip.addEventListener('click', () => {
      dom.providerModel.value = model.id;
      setModelStatus(`已选择 ${model.id}`, 'ok');
    });
    dom.providerModelChips.append(chip);
  }
  if (models.length > shown.length) {
    const more = document.createElement('span');
    more.className = 'model-chip-more';
    more.textContent = `+${models.length - shown.length}`;
    dom.providerModelChips.append(more);
  }
  dom.providerModelChips.classList.toggle('is-hidden', models.length === 0);
}

function setModelOptions(
  models: LlmModelOption[],
  source: 'probe' | 'fetch' | 'edit' = 'probe',
): void {
  modelOptionsSource = models.length === 0 ? 'none' : source;
  dom.providerModelList.innerHTML = '';
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    const option = document.createElement('option');
    option.value = model.id;
    option.label = model.name;
    dom.providerModelList.append(option);
  }
  renderModelChips(models);
}

function clearModelOptions(): void {
  modelOptionsSource = 'none';
  dom.providerModelList.innerHTML = '';
  renderModelChips([]);
}

function modelOptionsFromOllama(): LlmModelOption[] {
  return lastOllama.models.map((entry) => ({ id: entry.name, name: entry.name }));
}

function syncProviderModelOptions(models: LlmModelOption[] = modelOptionsFromOllama()): void {
  setModelOptions(models, 'probe');
  if (dom.providerModel.value.trim() === '' && models.length > 0) {
    dom.providerModel.value = models[0]!.id;
  }
}

function resetModelFetchCooldown(): void {
  if (modelFetchTimer !== null) {
    window.clearTimeout(modelFetchTimer);
    modelFetchTimer = null;
  }
  dom.providerModelRefresh.disabled = modelFetchBusy;
  dom.providerModelRefresh.textContent = modelFetchBusy ? '⏳' : '🔄';
}

function startModelFetchCooldown(): void {
  if (modelFetchTimer !== null) window.clearTimeout(modelFetchTimer);
  dom.providerModelRefresh.disabled = true;
  dom.providerModelRefresh.textContent = '⏳';
  modelFetchTimer = window.setTimeout(() => {
    modelFetchTimer = null;
    if (!modelFetchBusy) {
      dom.providerModelRefresh.disabled = false;
      dom.providerModelRefresh.textContent = '🔄';
    }
  }, LLM_MODEL_LIST_THROTTLE_MS);
}

function applyProviderTypeUi(type: LlmProviderType): void {
  const opencode = type === 'opencode-go';
  const ollama = type === 'ollama';
  modelFetchSeq += 1;
  dom.providerBaseUrl.readOnly = opencode;
  dom.providerBaseUrl.classList.toggle('is-readonly', opencode);
  dom.providerTypeHint.textContent = ollama
    ? '本地 Ollama：只连 127.0.0.1，不需要 Key。'
    : opencode
      ? 'OpenCode Go 订阅：固定端点，只需填 API Key 与模型名。'
      : '任意 OpenAI 兼容端点：远程必须 https（本机回环可用 http）。';
  dom.providerBaseUrlHint.textContent = opencode
    ? 'OpenCode Go 的端点固定，不可修改。'
    : ollama
      ? '只允许回环地址（127.0.0.1 / localhost）。'
      : '例如 https://api.example.com/v1；本机兼容服务可用 http://127.0.0.1:端口/v1。';
  dom.providerApiKeyHint.textContent = ollama
    ? '本地 Ollama 通常不需要 Key。'
    : '只保存在本机 config.json；日志里只会出现"已配置"。';
  dom.providerModelHint.textContent = ollama
    ? '来自本机 GET /api/tags；点 🔄 重新拉取，也可以手动输入。'
    : opencode
      ? '点 🔄 从 OpenCode Go 拉取模型列表；失败时仍可手动输入模型名。'
      : '点 🔄 从 <Base URL>/models 拉取；端点不提供该接口时仍可手动输入。';
  resetModelFetchCooldown();
  if (opencode) {
    dom.providerBaseUrl.value = OPENCODE_GO_BASE_URL;
    if (dom.providerModel.value.trim() === '') dom.providerModel.value = OPENCODE_GO_DEFAULT_MODEL;
    clearModelOptions();
    setModelStatus('点 🔄 拉取 OpenCode Go 的可用模型', 'idle');
  } else if (ollama) {
    if (
      dom.providerBaseUrl.value.trim() === '' ||
      dom.providerBaseUrl.value.startsWith('http://127.0.0.1:11434') === false
    ) {
      const local = providerView.find((entry) => entry.type === 'ollama');
      dom.providerBaseUrl.value = local?.baseUrl ?? 'http://127.0.0.1:11434';
    }
    syncProviderModelOptions(modelOptionsFromOllama());
    setModelStatus('', 'idle');
  } else {
    clearModelOptions();
    setModelStatus('点 🔄 拉取模型列表；失败也可以手动输入', 'idle');
  }
}

function resetProviderForm(): void {
  editingProviderId = null;
  dom.providerFormTitle.textContent = '添加提供商';
  dom.providerSave.textContent = '添加并应用';
  dom.providerCancel.classList.add('is-hidden');
  dom.providerType.disabled = false;
  dom.providerType.value = 'ollama';
  dom.providerName.value = '';
  dom.providerBaseUrl.value = '';
  dom.providerApiKey.value = '';
  dom.providerApiKey.placeholder = '可留空';
  dom.providerModel.value = '';
  clearModelOptions();
  dom.providerFormStatus.textContent = '填写后点「添加并应用」';
  applyProviderTypeUi('ollama');
}

function beginProviderEdit(entry: PanelProviderFacts): void {
  editingProviderId = entry.id;
  dom.providerFormTitle.textContent = `编辑：${entry.name}`;
  dom.providerSave.textContent = '保存并应用';
  dom.providerCancel.classList.remove('is-hidden');
  dom.providerType.disabled = true;
  dom.providerType.value = entry.type;
  dom.providerName.value = entry.name;
  dom.providerBaseUrl.value = entry.baseUrl;
  dom.providerApiKey.value = '';
  dom.providerApiKey.placeholder = entry.hasApiKey ? '已保存 · 留空保持不变' : '可留空';
  dom.providerModel.value = entry.model;
  applyProviderTypeUi(entry.type);
  if (entry.type !== 'ollama' && entry.model !== '') {
    setModelOptions([{ id: entry.model, name: entry.model }], 'edit');
  }
  dom.providerFormStatus.textContent = entry.hasApiKey
    ? '留空 API Key = 沿用已保存的 Key（拉取模型时由主进程注入）'
    : '留空 API Key = 沿用已保存的 Key';
  dom.providerForm.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function refreshProviderModels(): Promise<void> {
  if (modelFetchBusy) return;
  const type = providerTypeOf(dom.providerType.value);
  const baseUrl = dom.providerBaseUrl.value.trim();
  const apiKey = dom.providerApiKey.value.trim();
  if (baseUrl === '') {
    setModelStatus('先填写 Base URL，再拉取模型列表', 'error');
    showToast('先填写 Base URL', 'error');
    return;
  }
  const saved = editingProviderId
    ? (providerView.find((entry) => entry.id === editingProviderId) ?? null)
    : null;
  // 安全闸：地址被改写时不再复用旧 Key（否则等于把旧 Key 发给新地址）。
  // 与主进程 `resolveModelListTarget` 的判定同一口径，这里只是提前给人话。
  if (
    saved &&
    saved.hasApiKey &&
    apiKey === '' &&
    baseUrl.replace(/\/+$/, '') !== saved.baseUrl
  ) {
    setModelStatus('Base URL 已改：为安全起见，请重新填写 API Key 再拉取', 'error');
    showToast('Base URL 已改，需要重新填写 API Key', 'error');
    return;
  }

  modelFetchBusy = true;
  const seq = ++modelFetchSeq;
  startModelFetchCooldown();
  setModelStatus('正在拉取模型列表…', 'idle');
  try {
    const request: PanelFetchModelsRequest = { type, baseUrl };
    if (apiKey !== '') request.apiKey = apiKey;
    if (editingProviderId !== null) request.providerId = editingProviderId;
    const result = await window.petPanel.fetchModels(request);
    // 期间用户改了类型/地址：这份结果已经过期，丢弃（按钮状态在 finally 里恢复）
    if (seq !== modelFetchSeq) return;
    if (!result.ok) {
      setModelStatus(`拉取失败：${result.error}`, 'error');
      showToast(`拉取模型失败：${result.error}`, 'error');
      return;
    }
    if (result.models.length === 0) {
      setModelStatus('端点没有返回模型，请手动输入模型名', 'warn');
      return;
    }
    setModelOptions(result.models, 'fetch');
    if (dom.providerModel.value.trim() === '') dom.providerModel.value = result.models[0]!.id;
    setModelStatus(
      `已拉取 ${result.models.length} 个模型，可从下拉选择或继续手动输入`,
      'ok',
    );
    showToast(`已拉取 ${result.models.length} 个模型`);
  } catch (error) {
    setModelStatus(`拉取失败：${String(error)}`, 'error');
    showToast(`拉取模型失败：${String(error)}`, 'error');
  } finally {
    modelFetchBusy = false;
    if (modelFetchTimer === null) {
      dom.providerModelRefresh.disabled = false;
      dom.providerModelRefresh.textContent = '🔄';
    }
  }
}

async function saveProvider(): Promise<void> {
  if (providerBusy) return;
  const type = providerTypeOf(dom.providerType.value);
  const model = dom.providerModel.value.trim();
  if (model === '') {
    setModelStatus('请先选择或输入模型名，再保存', 'error');
    showToast('请先选择或输入模型名', 'error');
    return;
  }
  const payload = {
    ...(editingProviderId ? { id: editingProviderId } : {}),
    type,
    name: dom.providerName.value.trim() || PROVIDER_TYPE_LABEL[type],
    baseUrl: dom.providerBaseUrl.value.trim(),
    apiKey: dom.providerApiKey.value.trim(),
    model,
  };
  providerBusy = true;
  dom.providerSave.disabled = true;
  dom.providerFormStatus.textContent = '正在应用…';
  try {
    const result = await invoke({ action: 'provider-save', provider: payload });
    if (!result.ok) {
      dom.providerFormStatus.textContent = result.error ?? '保存失败';
      showToast(result.error ?? '提供商保存失败', 'error');
      return;
    }
    if (result.providers) renderProviderFacts(result.providers);
    const test = result.providerTest;
    if (test && test.status === 'failed') {
      dom.providerFormStatus.textContent = `已保存，但连接失败：${test.detail ?? '未知原因'}`;
      showToast(`已保存，但连接失败：${test.detail ?? '未知原因'}`, 'error');
    } else {
      dom.providerFormStatus.textContent = result.notice ?? '已保存';
      showToast(result.notice ?? '提供商已保存');
    }
    resetProviderForm();
  } finally {
    providerBusy = false;
    dom.providerSave.disabled = false;
  }
}

async function activateProvider(id: string): Promise<void> {
  if (providerBusy) return;
  providerBusy = true;
  try {
    const result = await invoke({ action: 'provider-activate', id });
    if (!result.ok) {
      showToast(result.error ?? '切换失败', 'error');
      return;
    }
    if (result.providers) renderProviderFacts(result.providers);
    const test = result.providerTest;
    if (test && test.status === 'failed') {
      showToast(`已切换，但连接失败：${test.detail ?? '未知原因'}`, 'error');
    } else {
      showToast(result.notice ?? '已切换，下一轮对话生效');
    }
  } finally {
    providerBusy = false;
  }
}

async function testProvider(id: string): Promise<void> {
  if (providerBusy) return;
  providerBusy = true;
  try {
    const result = await invoke({ action: 'provider-test', id });
    if (result.providers) renderProviderFacts(result.providers);
    const test = result.providerTest;
    if (!test) return;
    if (test.status === 'ok') {
      showToast(`连接正常${test.latencyMs === null ? '' : ` · ${test.latencyMs}ms`}`);
    } else {
      showToast(`连接失败：${test.detail ?? '未知原因'}`, 'error');
    }
  } finally {
    providerBusy = false;
  }
}

async function deleteProvider(entry: PanelProviderFacts): Promise<void> {
  if (providerBusy) return;
  if (!window.confirm(`删除提供商「${entry.name}」？${entry.active ? '它正在使用中，会自动切到剩下的第一个。' : ''}`)) {
    return;
  }
  providerBusy = true;
  try {
    const result = await invoke({ action: 'provider-delete', id: entry.id });
    if (!result.ok) {
      showToast(result.error ?? '删除失败', 'error');
      return;
    }
    if (result.providers) renderProviderFacts(result.providers);
    if (editingProviderId === entry.id) resetProviderForm();
    showToast(result.notice ?? '已删除');
  } finally {
    providerBusy = false;
  }
}


// ---------------------------------------------------------------------------
// ADR 0053：角色卡
// ---------------------------------------------------------------------------

function renderCardFacts(card: PanelCardFacts): void {
  cardChars = card.chars;
  cardLoaded = true;
  cardDirty = false;
  dom.cardText.value = card.text;
  dom.cardPath.textContent = card.path;
  dom.cardPath.title = card.path;
  dom.cardBadge.className = `panel-card-tag ${card.exists ? (card.chars > 0 ? 'ok' : 'bad') : 'bad'}`;
  dom.cardBadge.textContent = card.exists ? `${card.chars} 字` : '文件缺失';
  dom.cardCounter.textContent = `${[...card.text].length} 字`;
}

async function loadCard(): Promise<void> {
  const result = await invoke({ action: 'card' });
  if (!result.ok && result.error) showToast(result.error, 'error');
  if (result.card) renderCardFacts(result.card);
}

async function saveCard(): Promise<void> {
  const text = dom.cardText.value;
  if (text.trim() === '') {
    showToast('角色卡不能为空——人格不允许静默消失', 'error');
    return;
  }
  dom.cardSave.disabled = true;
  try {
    const result = await invoke({ action: 'save-card', text });
    if (result.card) renderCardFacts(result.card);
    if (!result.ok) {
      showToast(result.error ?? '角色卡保存失败', 'error');
      return;
    }
    showToast(result.notice ?? '角色卡已保存，下一轮对话生效');
  } finally {
    dom.cardSave.disabled = false;
  }
}

function markCardDirty(): void {
  cardDirty = true;
  dom.cardCounter.textContent = `${[...dom.cardText.value].length} 字 · 未保存`;
  dom.cardBadge.className = 'panel-card-tag warn';
  dom.cardBadge.textContent = '未保存';
}

// ---------------------------------------------------------------------------
// ADR 0053：TTS 测试
// ---------------------------------------------------------------------------

async function testTts(): Promise<void> {
  if (ttsBusy) return;
  ttsBusy = true;
  dom.ttsTest.disabled = true;
  dom.ttsResult.textContent = '合成中…（最多等几秒）';
  try {
    const result = await invoke({ action: 'tts-test' });
    const tts = result.tts;
    if (!tts) {
      dom.ttsResult.textContent = result.error ?? '没有回执';
      showToast(result.error ?? 'TTS 测试失败', 'error');
      return;
    }
    const ms = tts.ms === null ? '?' : `${tts.ms}ms`;
    if (tts.ok) {
      dom.ttsResult.textContent = `通过 · ${ms} · ${formatBytes(tts.bytes)} 音频`;
      showToast('语音链路是通的');
    } else {
      dom.ttsResult.textContent = `失败 · ${tts.detail ?? tts.reason ?? '未知原因'}`;
      showToast(`TTS 不可用：${tts.detail ?? tts.reason ?? '未知原因'}`, 'error');
    }
  } finally {
    ttsBusy = false;
    dom.ttsTest.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// ADR 0053：记忆管理
// ---------------------------------------------------------------------------

function kindLabel(kind: string): string {
  if (kind === 'user') return '老师';
  if (kind === 'pet') return '凯伊';
  if (kind === 'system') return '系统';
  return kind;
}

function memoryItem(record: MemoryRecord): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'memory-item';
  item.dataset['id'] = String(record.id);

  const main = document.createElement('div');
  main.className = 'memory-main';
  const meta = document.createElement('div');
  meta.className = 'memory-meta';
  const kind = document.createElement('span');
  kind.className = `memory-kind ${record.kind}`;
  kind.textContent = kindLabel(record.kind);
  const at = document.createElement('span');
  at.textContent = formatEpoch(record.at);
  const id = document.createElement('span');
  id.textContent = `#${record.id}`;
  meta.append(kind, at, id);
  const text = document.createElement('p');
  text.className = 'memory-text';
  text.textContent = record.text;
  text.title = record.text;
  main.append(meta, text);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn tiny ghost';
  remove.textContent = '删除';
  remove.addEventListener('click', () => void deleteMemory(record.id));

  item.append(main, remove);
  return item;
}

function renderMemoryList(rows: MemoryRecord[], total: number | null): void {
  dom.memoryList.innerHTML = '';
  for (const record of rows) dom.memoryList.append(memoryItem(record));
  dom.memoryEmpty.classList.toggle('is-hidden', rows.length > 0);
  const totalText = total === null ? `${rows.length} 条` : `${rows.length} / ${total} 条`;
  dom.memoryCount.textContent = totalText;
}

async function loadMemories(force = false): Promise<void> {
  if (memoryLoading) return;
  if (!force && performance.now() - memoryFetchedAt < MEMORY_REFRESH_MS) return;
  memoryLoading = true;
  memoryFetchedAt = performance.now();
  try {
    const result = await invoke({ action: 'memories' });
    if (!result.ok) {
      showToast(result.error ?? '读取记忆失败', 'error');
      return;
    }
    renderMemoryList(result.memories ?? [], result.memoryRows ?? null);
    lastRenderedRows = result.memoryRows ?? -1;
  } finally {
    memoryLoading = false;
  }
}

async function deleteMemory(id: number): Promise<void> {
  const result = await invoke({ action: 'memory-delete', id });
  if (!result.ok) {
    showToast(result.error ?? '删除失败', 'error');
    return;
  }
  await loadMemories(true);
  showToast(result.notice ?? (result.deleted ? '已删除这一条' : '没有找到这一条'));
}

function armClear(): void {
  if (clearArmed) return;
  clearArmed = true;
  dom.memoryClear.textContent = '再点一次确认清空';
  dom.memoryClear.classList.add('is-armed');
  dom.clearHint.textContent = '5 秒内再点一次才会真的清空';
  clearArmedTimer = window.setTimeout(() => disarmClear(), CLEAR_CONFIRM_MS);
}

function disarmClear(): void {
  clearArmed = false;
  if (clearArmedTimer !== null) {
    window.clearTimeout(clearArmedTimer);
    clearArmedTimer = null;
  }
  dom.memoryClear.textContent = '清空所有记忆';
  dom.memoryClear.classList.remove('is-armed');
  dom.clearHint.textContent = '需要点两次确认';
}

async function clearMemories(): Promise<void> {
  if (!clearArmed) {
    armClear();
    return;
  }
  disarmClear();
  dom.memoryClear.disabled = true;
  try {
    const result = await invoke({ action: 'memory-clear', confirm: true });
    if (!result.ok) {
      showToast(result.error ?? '清空失败', 'error');
      return;
    }
    await loadMemories(true);
    showToast(result.notice ?? '已清空');
  } finally {
    dom.memoryClear.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 状态推送
// ---------------------------------------------------------------------------

function renderStatus(status: PanelStatus): void {
  const render = status.render;
  const stateText = render
    ? `base ${render.state.base}${render.state.overlay ? ` · ${render.state.overlay}` : ''}${
        render.state.physics ? ` · ${render.state.physics}` : ''
      }`
    : '等待渲染进程…';
  must<HTMLElement>('#stat-state').textContent = stateText;
  must<HTMLElement>('#stat-sit').textContent = render
    ? render.sit
      ? `坐姿阶段 ${render.sit.stage.toUpperCase()} · 姿态增益 ${render.sit.sitPoseGain.toFixed(2)}`
      : `不在坐姿 · 模型${render.state.modelReady ? '已就绪' : '未就绪'}`
    : '—';

  must<HTMLElement>('#stat-clip').textContent = render?.clip.name ?? '—';
  must<HTMLElement>('#stat-clip-time').textContent = render?.clip.name
    ? `${render.clip.slot ?? '—'} · ${render.clip.timeSeconds.toFixed(2)}s · 权重 ${render.clip.weight.toFixed(2)}`
    : '—';

  const ollama = status.ollama;
  lastOllama = ollama;
  const ollamaValue = must<HTMLElement>('#stat-ollama');
  ollamaValue.innerHTML = '';
  const dot = document.createElement('span');
  dot.className = `dot dot-${ollama.status === 'online' ? 'online' : ollama.status === 'offline' ? 'offline' : 'unknown'}`;
  const text = document.createElement('span');
  text.textContent =
    ollama.status === 'online' ? '在线' : ollama.status === 'offline' ? '离线' : '未探测';
  ollamaValue.append(dot, text);
  must<HTMLElement>('#stat-ollama-detail').textContent =
    ollama.status === 'offline'
      ? ollama.detail ?? `${ollama.baseUrl} 不可达`
      : `${ollama.model} · ${ollama.latencyMs !== null ? `${ollama.latencyMs}ms` : ollama.baseUrl}`;

  const tuning = render?.tuning ?? values;
  const changed = Object.keys(diffTunableValues(tuning)).length;
  must<HTMLElement>('#stat-tuning-count').textContent = changed === 0 ? '全部默认' : `${changed} 项已调整`;
  must<HTMLElement>('#stat-tuning-detail').textContent = `A 段抬头 ${formatTunableValue(
    'sit.phaseAHeadTuneRad',
    tuning['sit.phaseAHeadTuneRad'],
  )} · 视线 ${formatTunableValue('gaze.eyeStiffness', tuning['gaze.eyeStiffness'])} / ${formatTunableValue(
    'gaze.headStiffness',
    tuning['gaze.headStiffness'],
  )} / ${formatTunableValue('gaze.spineStiffness', tuning['gaze.spineStiffness'])}`;

  /**
   * ADR 0057 D2.6：缩放要看**两个数**。
   *
   * 左边是滑块给的请求值（面板自己的状态），右边是渲染进程报回来的实际尺寸反算出的比例。
   * 两者不等只有一个原因：窗口被**屏幕工作区**夹过（1080p 桌面上放不到 2.0x）——
   * 这正是要显示出来的事实，否则用户会以为滑块坏了。
   */
  {
    const requested = tuning['view.scale'];
    const actual = render?.view && render.view.scale > 0 ? render.view.scale : null;
    must<HTMLElement>('#stat-scale').textContent =
      actual === null
        ? `${requested.toFixed(2)}x`
        : `${requested.toFixed(2)}x → ${actual.toFixed(2)}x`;
    must<HTMLElement>('#stat-scale-detail').textContent =
      render?.view && render.view.height > 0
        ? `内容区 ${Math.round(render.view.width)}×${Math.round(render.view.height)}`
        : '窗口与角色同比缩放';
  }

  must<HTMLElement>('#kv-state').textContent = render
    ? `${render.state.base} / ${render.state.overlay ?? '—'} / ${render.state.physics ?? '—'}`
    : '—';
  must<HTMLElement>('#kv-sit-stage').textContent = render?.sit ? render.sit.stage.toUpperCase() : '—';
  must<HTMLElement>('#kv-sit-gain').textContent = render?.sit ? render.sit.sitPoseGain.toFixed(3) : '—';
  must<HTMLElement>('#kv-phase-a').textContent = render?.sit
    ? formatTunableValue('sit.phaseAHeadTuneRad', render.sit.phaseAHeadAppliedRad)
    : '—';
  must<HTMLElement>('#kv-spine').textContent = render?.sit ? render.sit.spineOverlayApplied.toFixed(3) : '—';
  must<HTMLElement>('#kv-clip-weight').textContent = render ? render.clip.weight.toFixed(3) : '—';
  must<HTMLElement>('#status-freshness').textContent = render
    ? `刚刚 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
    : '等待渲染进程…';

  // ── AI 人格 ───────────────────────────────────────────────
  const persona = status.persona;
  personaView = persona;
  renderModelFacts(persona, ollama);
  renderProviderFacts(status.providers);
  if (
    providerTypeOf(dom.providerType.value) === 'ollama' &&
    editingProviderId === null &&
    modelOptionsSource !== 'fetch' &&
    !dom.providerForm.contains(document.activeElement)
  ) {
    const key = lastOllama.models.map((entry) => entry.name).join('|');
    if (key !== lastOllamaOptionsKey) {
      lastOllamaOptionsKey = key;
      syncProviderModelOptions(modelOptionsFromOllama());
    }
  }
  dom.cardPath.textContent = persona.cardPath;
  dom.cardPath.title = persona.cardPath;
  dom.cardLlmUrl.textContent = persona.llmBaseUrl;
  if (!cardDirty) {
    dom.cardBadge.className = `panel-card-tag ${persona.cardExists ? (persona.cardChars > 0 ? 'ok' : 'bad') : 'bad'}`;
    dom.cardBadge.textContent = persona.cardExists ? `${persona.cardChars} 字` : '文件缺失';
    if (!cardLoaded) dom.cardCounter.textContent = persona.cardExists ? `${persona.cardChars} 字` : '文件缺失';
  }
  dom.ttsBadge.className = `panel-card-tag ${persona.ttsEnabled ? 'ok' : ''}`;
  dom.ttsBadge.textContent = persona.ttsEnabled ? '已配置' : '未配置';
  dom.ttsRef.textContent = persona.ttsRefAudioPath || '—';
  dom.ttsRef.title = persona.ttsRefAudioPath || '';
  dom.ttsUrl.textContent = persona.ttsEnabled ? 'wolf-tts 本地服务（见日志）' : persona.ttsDisabledReason ?? '—';
  if (!ttsBusy && dom.ttsResult.textContent === '未测试' && !persona.ttsEnabled) {
    dom.ttsResult.textContent = '未配置，测试无意义';
  }

  // ── 记忆 ──────────────────────────────────────────────────
  const memory = status.memory;
  memoryView = memory;
  dom.memoryBadge.className = `panel-card-tag ${memory.enabled ? (memory.dbExists ? 'ok' : '') : 'bad'}`;
  dom.memoryBadge.textContent = !memory.enabled ? '已禁用' : memory.dbExists ? '可读写' : '尚未创建';
  dom.memoryPath.textContent = memory.dbPath;
  dom.memoryPath.title = memory.dbPath;
  dom.memorySize.textContent = formatBytes(memory.dbBytes);
  dom.memoryUpdated.textContent = memory.dbUpdatedAt ? formatSavedAt(memory.dbUpdatedAt) : '—';
  dom.memoryRows.textContent = memory.enabled ? `${memory.rows} 条` : '—';
  dom.memoryEnabled.textContent = memory.enabled ? `启用（${memory.mode}）` : '禁用';
  if (memory.lastError) dom.memoryCount.title = `最近错误：${memory.lastError}`;

  // 列表：条数变了、或者用户正停在这一页，才重取（节流在 loadMemories 里）
  if (currentTab === 'memory' && memory.dbExists && memory.rows !== lastRenderedRows) {
    void loadMemories();
  }
}

async function save(): Promise<void> {
  dom.save.disabled = true;
  try {
    if (pending !== null) {
      window.clearTimeout(pending);
      pending = null;
    }
    const result = await invoke({ action: 'save', values: { ...values } });
    if (!result.ok) {
      showToast(result.error ?? '保存失败', 'error');
      return;
    }
    refreshConfigFacts(result);
    showToast('已保存到 config.json，重启后仍然生效');
  } finally {
    dom.save.disabled = false;
  }
}

async function reset(): Promise<void> {
  const result = await invoke({ action: 'reset' });
  if (!result.ok) {
    showToast(result.error ?? '恢复默认失败', 'error');
  }
  refreshConfigFacts(result);
  refreshAllParams();
  showToast('已恢复契约默认值');
}

function bindStaticUi(): void {
  for (const button of document.querySelectorAll<HTMLElement>('.nav-item')) {
    button.addEventListener('click', () => setTab(button.dataset['tab'] ?? 'physics'));
  }
  dom.save.addEventListener('click', () => void save());
  dom.reset.addEventListener('click', () => void reset());

  // ADR 0053
  dom.modelRefresh.addEventListener('click', () => {
    void invoke({ action: 'status' }).then(() => {
      showToast('已请求重新探测');
    });
  });
  dom.modelApply.addEventListener('click', () => void applyModel());
  dom.modelSelect.addEventListener('change', () => syncModelApplyState());

  // ADR 0055：提供商表单
  dom.providerNew.addEventListener('click', () => resetProviderForm());
  dom.providerCancel.addEventListener('click', () => resetProviderForm());
  dom.providerType.addEventListener('change', () => {
    if (editingProviderId !== null) return; // 编辑时类型锁定，避免把已有 Key 套到另一种协议
    applyProviderTypeUi(providerTypeOf(dom.providerType.value));
  });
  // ADR 0056：刷新模型列表（input + datalist 的 Combobox）
  dom.providerModelRefresh.addEventListener('click', () => void refreshProviderModels());
  dom.providerModel.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      void refreshProviderModels();
    }
  });
  dom.providerBaseUrl.addEventListener('input', () => {
    // 地址变了，旧清单不再可信；同时解除本地冷却（主进程按新地址单独节流）
    modelFetchSeq += 1;
    clearModelOptions();
    resetModelFetchCooldown();
    setModelStatus('', 'idle');
  });
  dom.providerApiKey.addEventListener('input', () => {
    // Key 变了 = 主进程的节流键也变了，允许立即重试
    resetModelFetchCooldown();
  });
  dom.providerSave.addEventListener('click', () => void saveProvider());
  dom.cardReload.addEventListener('click', () => void loadCard());
  dom.cardSave.addEventListener('click', () => void saveCard());
  dom.cardText.addEventListener('input', markCardDirty);
  dom.ttsTest.addEventListener('click', () => void testTts());
  dom.memoryRefresh.addEventListener('click', () => void loadMemories(true));
  dom.memoryClear.addEventListener('click', () => void clearMemories());

  window.addEventListener('keydown', (event) => {
    const target = event.target;
    const editing =
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement && (target.type === 'number' || target.type === 'text')) ||
      target instanceof HTMLSelectElement;
    if (editing) {
      // 在编辑器里打字时，单键快捷键一律让路；只留 Ctrl+S 这一条（按当前页决定保存什么）
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (currentTab === 'persona') void saveCard();
        else void save();
      }
      if (event.key === 'Enter' && target instanceof HTMLInputElement && target.type === 'number') {
        target.blur();
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void save();
      return;
    }
    if (event.key.toLowerCase() === 'r' && !event.ctrlKey && !event.metaKey) {
      void reset();
      return;
    }
    if (event.key === 'Escape') {
      void invoke({ action: 'hide' });
    }
  });
}

async function boot(): Promise<void> {
  buildParamUi();
  bindStaticUi();
  resetProviderForm();
  refreshAllParams();
  setTab('physics');

  const snapshot = await invoke({ action: 'snapshot' });
  if (!snapshot.ok) showToast(snapshot.error ?? '读取当前参数失败', 'error');
  refreshConfigFacts(snapshot);
  refreshAllParams();

  window.petPanel.onState(renderStatus);
  void invoke({ action: 'status' });
}

void boot();
