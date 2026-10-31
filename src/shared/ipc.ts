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
