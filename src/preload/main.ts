/**
 * preload：唯一的渲染侧 → 主进程出口。
 * 只暴露 §3.5 已定义的通道，不暴露 Node 能力（contextIsolation + sandbox）。
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { isEventName } from '../shared/events';
import type { BroadcastEvent, EventName, EventPayloads } from '../shared/events';
import { IPC_CHANNELS } from '../shared/ipc';
import type {
  PointerFact,
  ProbeRequest,
  ProbeResponse,
  RenderIntentCommand,
  SpeechReport,
  VoiceCommand,
  WalkCommand,
} from '../shared/ipc';
import type { PanelRenderFacts } from '../shared/panel';
import type { VisionQueryRequest, VisionResult } from '../shared/vision';

const api = {
  /** 主进程 → 渲染侧：请求一次掩膜命中判定（cmd:probe，ADR 0004 D1）。 */
  onProbe(listener: (request: ProbeRequest) => void): () => void {
    const wrapped = (_event: IpcRendererEvent, request: ProbeRequest): void => {
      listener(request);
    };
    ipcRenderer.on(IPC_CHANNELS.probe, wrapped);
    return () => {
      ipcRenderer.off(IPC_CHANNELS.probe, wrapped);
    };
  },

  /** 渲染侧 → 主进程：命中结果与头部区派生值（cmd:interactive，ADR 0004 D1）。 */
  reportProbe(response: ProbeResponse): void {
    ipcRenderer.send(IPC_CHANNELS.interactive, response);
  },

  /** 渲染侧 → 主进程：原始指针事实，不带位移/速度（cmd:drag，ADR 0004 D2）。 */
  reportPointer(fact: PointerFact): void {
    ipcRenderer.send(IPC_CHANNELS.drag, fact);
  },

  /**
   * 主进程 → 渲染侧的事件广播（evt:broadcast，§3.5 / §6.4 E-1）。
   * 只放行 §6.3 白名单里的事件名；载荷是纯数据（E-3：消费者只读）。
   */
  onEvent(listener: (event: BroadcastEvent) => void): () => void {
    const wrapped = (_event: IpcRendererEvent, envelope: BroadcastEvent): void => {
      if (!envelope || typeof envelope !== 'object') return;
      if (!isEventName(envelope.name)) return;
      listener(envelope);
    };
    ipcRenderer.on(IPC_CHANNELS.eventBroadcast, wrapped);
    return () => {
      ipcRenderer.off(IPC_CHANNELS.eventBroadcast, wrapped);
    };
  },

  /**
   * 渲染侧 → 主进程的既有事件（`evt:broadcast` 反向，§3.5 的双向转发）。
   * 目前唯一的生产者是 `model_ready`（§6.3），仍然走同一通道与同一白名单。
   */
  sendEvent<K extends EventName>(name: K, payload: EventPayloads[K]): void {
    if (!isEventName(name)) return;
    ipcRenderer.send(IPC_CHANNELS.eventBroadcast, { name, payload });
  },

  /** 输入条 → 主进程：提交文本（cmd:respond，第 6 步接线）。 */
  submitUtterance(text: string): void {
    ipcRenderer.send(IPC_CHANNELS.respond, text);
  },

  /** 主进程 → 渲染侧：动作命令（cmd:render-intent，§3.5；orchestrator 的唯一动作出口）。 */
  onRenderIntent(listener: (command: RenderIntentCommand) => void): () => void {
    const wrapped = (_event: IpcRendererEvent, command: RenderIntentCommand): void => {
      if (!command || typeof command !== 'object') return;
      listener(command);
    };
    ipcRenderer.on(IPC_CHANNELS.renderIntent, wrapped);
    return () => {
      ipcRenderer.off(IPC_CHANNELS.renderIntent, wrapped);
    };
  },

  /** 主进程 → 渲染侧：语音命令（cmd:voice，ADR 0015 D3.3；speak / stop）。 */
  onVoice(listener: (command: VoiceCommand) => void): () => void {
    const wrapped = (_event: IpcRendererEvent, command: VoiceCommand): void => {
      if (!command || typeof command !== 'object') return;
      if (command.kind !== 'speak' && command.kind !== 'stop') return;
      if (typeof command.utteranceId !== 'string' || command.utteranceId === '') return;
      listener(command);
    };
    ipcRenderer.on(IPC_CHANNELS.voice, wrapped);
    return () => {
      ipcRenderer.off(IPC_CHANNELS.voice, wrapped);
    };
  },

  /** 渲染侧 → 主进程：播放事实（cmd:speech，ADR 0015 D3.2）。 */
  reportSpeech(report: SpeechReport): void {
    ipcRenderer.send(IPC_CHANNELS.speech, report);
  },

  /**
   * 渲染侧 → 主进程：请求窗口行走（cmd:walk，ADR 0024 D5）。
   * 只发"往哪边走、走多远"；位移物理与窗口写入都在主进程。
   */
  requestWalk(command: WalkCommand): void {
    if (!command || typeof command !== 'object') return;
    if (command.phase !== 'start' && command.phase !== 'stop') return;
    ipcRenderer.send(IPC_CHANNELS.walk, command);
  },

  /**
   * 主进程 → 渲染侧：热更新参数（cmd:tuning，ADR 0052 D3）。
   *
   * 载荷是完整的一组 `TunableValues`；这里只做"是不是对象"的最小校验，
   * 数值夹取统一在渲染进程的 `createTunableStore` 里做（与主进程同一份实现）。
   */
  onTuning(listener: (values: Record<string, unknown>) => void): () => void {
    const wrapped = (_event: IpcRendererEvent, values: unknown): void => {
      if (!values || typeof values !== 'object') return;
      listener(values as Record<string, unknown>);
    };
    ipcRenderer.on(IPC_CHANNELS.tuning, wrapped);
    return () => {
      ipcRenderer.off(IPC_CHANNELS.tuning, wrapped);
    };
  },

  /**
   * 主进程 → 渲染侧：状态轮询（cmd:state-poll，ADR 0052 D4）。
   * 面板可见时约 4Hz；渲染侧收到就回报一次 `reportState()`。
   */
  onStatePoll(listener: () => void): () => void {
    const wrapped = (): void => {
      listener();
    };
    ipcRenderer.on(IPC_CHANNELS.statePoll, wrapped);
    return () => {
      ipcRenderer.off(IPC_CHANNELS.statePoll, wrapped);
    };
  },

  /** 渲染侧 → 主进程：面板状态快照（cmd:state-report，ADR 0052 D4）。 */
  reportState(snapshot: PanelRenderFacts): void {
    if (!snapshot || typeof snapshot !== 'object') return;
    ipcRenderer.send(IPC_CHANNELS.stateReport, snapshot);
  },

  /**
   * 渲染侧 → 主进程：请求一次视觉/OCR 查询（cmd:vision-query，ADR 0054 D6）。
   *
   * 这是**请求/应答**，不是事件：返回 `VisionResult` 后主进程即把上下文挂到下一轮对话，
   * 渲染页不需要（也拿不到）图片本身。载荷只允许 `{ source }`，主进程会再校验。
   */
  queryVision(request?: VisionQueryRequest): Promise<VisionResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.visionQuery, request ?? {}) as Promise<VisionResult>;
  },
};

contextBridge.exposeInMainWorld('petShell', api);

export type PetShellApi = typeof api;
