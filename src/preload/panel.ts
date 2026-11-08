/**
 * 控制面板的 preload（ADR 0052 D2；ADR 0053 扩展载荷白名单；ADR 0056 加只读模型列表）。
 *
 * 与角色页 / 输入条的 preload 分开：面板只需要三条能力——
 * - `invoke(action)` → `cmd:panel`（读/写参数、角色卡、模型、TTS 测试、记忆管理）；
 * - `onState(listener)` → `cmd:panel-state`（4Hz 状态推送）；
 * - `fetchModels(request)` → `cmd:fetch-models`（只读模型列表；已保存的 Key 由主进程注入）。
 *
 * **不**暴露事件总线、探针、拖拽、语音或任何 Node 能力。载荷在过桥前做最小校验，
 * 主进程侧还有第二道校验（只接受面板窗口这一个 sender），第三道是业务校验
 * （模型名白名单、角色卡长度、清空需二次确认、模型列表的地址/Key/节流）。
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc';
import type {
  PanelAction,
  PanelFetchModelsRequest,
  PanelFetchModelsResult,
  PanelResult,
  PanelStatus,
} from '../shared/panel';

const ACTIONS = new Set([
  'snapshot',
  'status',
  'preview',
  'save',
  'reset',
  'card',
  'save-card',
  'set-model',
  'providers',
  'provider-save',
  'provider-delete',
  'provider-activate',
  'provider-test',
  'tts-test',
  'memories',
  'memory-delete',
  'memory-clear',
  'hide',
]);

function normalizeAction(action: unknown): PanelAction | null {
  if (!action || typeof action !== 'object') return null;
  const raw = action as Record<string, unknown>;
  const name = raw['action'];
  if (typeof name !== 'string' || !ACTIONS.has(name)) return null;
  switch (name) {
    case 'snapshot':
      return { action: 'snapshot' };
    case 'status':
      return { action: 'status' };
    case 'reset':
      return { action: 'reset' };
    case 'card':
      return { action: 'card' };
    case 'tts-test':
      return { action: 'tts-test' };
    case 'hide':
      return { action: 'hide' };
    case 'preview':
    case 'save': {
      const values = raw['values'];
      if (!values || typeof values !== 'object') return null;
      return { action: name, values };
    }
    case 'save-card': {
      const text = raw['text'];
      if (typeof text !== 'string') return null;
      return { action: 'save-card', text };
    }
    case 'set-model': {
      const model = raw['model'];
      if (typeof model !== 'string') return null;
      return { action: 'set-model', model };
    }
    case 'providers':
      return { action: 'providers' };
    case 'provider-save': {
      // 逐字段校验放到主进程（第三道）；这里只保证"是个对象"，不把 Key 写进报错
      const provider = raw['provider'];
      if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return null;
      return { action: 'provider-save', provider };
    }
    case 'provider-delete':
    case 'provider-activate':
    case 'provider-test': {
      const id = raw['id'];
      if (typeof id !== 'string' || id === '') return null;
      return { action: name, id };
    }
    case 'memories': {
      const limit = raw['limit'];
      return typeof limit === 'number' && Number.isFinite(limit)
        ? { action: 'memories', limit }
        : { action: 'memories' };
    }
    case 'memory-delete': {
      const id = raw['id'];
      if (typeof id !== 'number' || !Number.isFinite(id)) return null;
      return { action: 'memory-delete', id };
    }
    case 'memory-clear': {
      // 二次确认是布尔事实，不接受 "true"/1 之类的宽松输入
      return raw['confirm'] === true ? { action: 'memory-clear', confirm: true } : null;
    }
    default:
      return null;
  }
}

const api = {
  /** 面板 → 主进程的一次请求（`cmd:panel`，invoke/应答）。 */
  invoke(action: PanelAction): Promise<PanelResult> {
    const normalized = normalizeAction(action);
    if (!normalized) {
      return Promise.resolve({
        ok: false,
        values: {},
        config: { configPath: '', savedAt: null, loadedFromFile: false },
        error: '非法请求（preload 已拦截）',
      } as unknown as PanelResult);
    }
    return ipcRenderer.invoke(IPC_CHANNELS.panel, normalized) as Promise<PanelResult>;
  },

  /** 主进程 → 面板的状态推送（`cmd:panel-state`，只在面板可见时到达）。 */
  onState(listener: (status: PanelStatus) => void): () => void {
    const wrapped = (_event: IpcRendererEvent, status: PanelStatus): void => {
      if (!status || typeof status !== 'object') return;
      listener(status);
    };
    ipcRenderer.on(IPC_CHANNELS.panelState, wrapped);
    return () => {
      ipcRenderer.off(IPC_CHANNELS.panelState, wrapped);
    };
  },

  /**
   * ADR 0056：拉取模型列表（`cmd:fetch-models`，invoke/应答）。
   *
   * 过桥前只保留白名单字段，避免把面板里的额外对象带进主进程。
   * **已保存的 Key 不在这里**：编辑时 `apiKey` 留空，主进程按 `providerId` 自己注入。
   */
  fetchModels(request: PanelFetchModelsRequest): Promise<PanelFetchModelsResult> {
    if (!request || typeof request !== 'object' || typeof request.baseUrl !== 'string') {
      return Promise.resolve({ ok: false, error: '非法请求（preload 已拦截）' });
    }
    const payload: PanelFetchModelsRequest = { baseUrl: request.baseUrl };
    if (request.type === 'ollama' || request.type === 'openai' || request.type === 'opencode-go') {
      payload.type = request.type;
    }
    if (typeof request.apiKey === 'string') payload.apiKey = request.apiKey;
    if (typeof request.providerId === 'string' && request.providerId !== '') {
      payload.providerId = request.providerId;
    }
    return ipcRenderer.invoke(IPC_CHANNELS.fetchModels, payload) as Promise<PanelFetchModelsResult>;
  },
};

contextBridge.exposeInMainWorld('petPanel', api);

export type PetPanelApi = typeof api;
