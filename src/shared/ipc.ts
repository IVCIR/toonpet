// 契约 §3.5 的跨进程通道与载荷形态。
// 载荷变化必须走 ADR（ADR 0004 已把 cmd:probe / cmd:interactive / cmd:drag 写死；
// ADR 0015 新增 cmd:speech 并把 cmd:voice 改为命令联合体）。
import type { Intent } from './types';

export const IPC_CHANNELS = {
  eventBroadcast: 'evt:broadcast',
  respond: 'cmd:respond',
  renderIntent: 'cmd:render-intent',
  voice: 'cmd:voice',
  probe: 'cmd:probe',
  interactive: 'cmd:interactive',
  drag: 'cmd:drag',
  /** ADR 0015 D3.2：渲染侧播放事实 → 主进程（speech_started / speech_ended 的唯一生产者仍是 voice） */
  speech: 'cmd:speech',
  /**
   * ADR 0024 D5：`render` 的内部调度器请求窗口行走（命令，不是事件）。
   * 位移物理与窗口写入都在主进程，`render` 只说"往哪边走、走多远"。
   */
  walk: 'cmd:walk',
  /**
   * ADR 0052 D3：主进程 → 角色渲染页的**热更新参数**（命令，不是事件）。
   * 载荷是完整的一组 `TunableValues`（`shared/tunable-params.ts`），渲染侧收到即改内存值，
   * 下一帧生效；不落盘、不重启、不重建模型。
   */
  tuning: 'cmd:tuning',
  /**
   * ADR 0052 D4：主进程 → 角色渲染页的状态轮询（命令）。
   * 只在控制面板可见时发（复用既有 16ms 轮询器，节流 250ms = 4Hz，契约 §6.5 的口径）。
   */
  statePoll: 'cmd:state-poll',
  /** ADR 0052 D4：角色渲染页 → 主进程的状态快照（`PanelRenderFacts`）。 */
  stateReport: 'cmd:state-report',
  /**
   * ADR 0052 D2：控制面板 → 主进程的请求（`ipcMain.handle`，invoke/应答）。
   * 载荷见 `shared/panel.ts` 的 `PanelAction`；只接受面板窗口这一个 sender。
   */
  panel: 'cmd:panel',
  /** ADR 0052 D4：主进程 → 控制面板的状态快照（`PanelStatus`），只在面板可见时推。 */
  panelState: 'cmd:panel-state',
  /**
   * ADR 0056：控制面板 → 主进程的**只读**模型列表请求（`ipcMain.handle`，invoke/应答）。
   * 载荷 `PanelFetchModelsRequest`，应答 `PanelFetchModelsResult`；只接受面板窗口这一个 sender。
   * 这是面板唯一的网络只读通道；写操作仍全部走 `cmd:panel`。
   */
  fetchModels: 'cmd:fetch-models',
  /**
   * ADR 0054 D6：视觉/OCR 查询（`ipcMain.handle`，invoke/应答）。
   * 载荷 `VisionQueryRequest`，应答 `VisionResult`；**不广播**、不进 `evt:broadcast`。
   * 只接受角色渲染页与控制面板两个 sender（截图是隐私操作，不开放给任意页面）。
   */
  visionQuery: 'cmd:vision-query',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/** ADR 0004 D1.1：窗口内容区 CSS 坐标，原点为内容区左上角。 */
export interface ProbeRequest {
  x: number;
  y: number;
}

/**
 * ADR 0004 D1.4：`head` 是"该探针坐标是否落在头部区"的派生布尔，
 * 掩膜不可用（cold / stale / 失败）时为 `null`，不得当 `false` 使用。
 */
export interface ProbeResponse {
  hit: boolean;
  x: number;
  y: number;
  head: boolean | null;
}

/**
 * ADR 0004 D2：只承载原始指针事实。
 * 位移、末速度、阈值判定全部归主进程，禁止在这里加字段。
 */
export interface PointerFact {
  phase: 'down' | 'up';
  x: number;
  y: number;
  t: number;
}

/** 契约 §3.5：`cmd:render-intent` 的单向命令（orchestrator → render）。 */
export interface RenderIntentCommand {
  intent: Intent;
}

/**
 * ADR 0015 D3.3：`cmd:voice` 是命令，不是事件。
 * `audio` 是 WAV 容器字节（含 RIFF 头）；解码、RMS 与包络全部留在渲染进程（§7.4）。
 */
export type VoiceCommand =
  | {
      kind: 'speak';
      utteranceId: string;
      audio: ArrayBuffer;
      mime: 'audio/wav';
    }
  | {
      kind: 'stop';
      utteranceId: string;
    };

/**
 * ADR 0015 D3.2：渲染侧的播放事实。
 * `interrupted` 不在这里：打断是主进程的决定，由 voice 直接发 `speech_ended`。
 */
export type SpeechReport =
  | {
      utteranceId: string;
      phase: 'started';
    }
  | {
      utteranceId: string;
      phase: 'ended';
      reason: 'completed' | 'failed';
      durationMs: number;
      detail?: string;
    };

/**
 * ADR 0024 D5：`cmd:walk` 是**命令**，只承载"往哪边走、走多远"。
 *
 * 不在这里放速度、加速度、弹簧参数：那是物理实现细节，归 `shell`
 * （与 `cmd:drag` 只承载原始指针事实同一条原则，§3.5 / ADR 0004 D2）。
 * `phase:'stop'` 用于拖拽打断行走——`render` 一旦进入 `dragged` 就无权再让窗口走。
 */
export type WalkCommand =
  | {
      phase: 'start';
      direction: 'left' | 'right';
      /** 期望位移（px，正数）；实际距离受工作区边缘钳制 */
      distancePx: number;
    }
  | {
      phase: 'stop';
    };
