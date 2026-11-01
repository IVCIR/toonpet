// 契约 §6.3 事件清单（全量，禁止私自扩充）。
// 事件名用 snake_case 跨进程传递；载荷字段用 camelCase（§6.2 N-6）。
import type { Emotion, Intent } from './types';

export const EVENT_NAMES = [
  'speech_started',
  'speech_ended',
  'drag_started',
  'drag_released',
  'head_patted',
  'user_utterance',
  'intent_resolved',
  'llm_failed',
  'model_ready',
  'motion_ended',
  'snap_applied',
  'snap_released',
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export interface SpeechStartedPayload {
  utteranceId: string;
  text: string;
}

export interface SpeechEndedPayload {
  utteranceId: string;
  reason: 'completed' | 'interrupted' | 'failed';
  durationMs: number;
}

export interface DragStartedPayload {
  x: number;
  y: number;
}

export interface DragReleasedPayload {
  x: number;
  y: number;
  /** px/s */
  vx: number;
  /** px/s */
  vy: number;
}

export interface HeadPattedPayload {
  patCount: number;
}

export interface UserUtterancePayload {
  utteranceId: string;
  text: string;
  /** 本期唯一可达值是 'hotkey'（§13 X-1；ADR 0004 D8.3） */
  input: 'keyboard' | 'hotkey';
}

export interface IntentResolvedPayload {
  replyId: string;
  text: string;
  emotion: Emotion;
  intent: Intent;
  route: 'rule' | 'llm' | 'fallback';
}

export interface LlmFailedPayload {
  replyId: string;
  reason: 'unavailable' | 'timeout' | 'invalid_output' | 'aborted';
  detail?: string;
}

export interface ModelReadyPayload {
  modelId: string;
  loadMs: number;
}

/**
 * ADR 0024 D5：`shell` 完成一次窗口位移后的**事实**（不是命令）。
 *
 * - `kind: 'walk'`：`render` 请求的行走结束（到达目标 / 撞到工作区边缘 / 被拖拽打断）；
 * - `kind: 'settle'`：松手回弹结束（静止在工作区地面上）。
 *
 * 为什么需要它：位移的物理在 `shell`（唯一能动窗口的进程），而 `walking` / `settling`
 * 两个状态由 `render` 持有（§4.1）。没有这条事实，`render` 只能靠自算时长猜，
 * 撞边缘时会出现"窗口停了、腿还在走"。
 */
export interface MotionEndedPayload {
  kind: 'walk' | 'settle';
  reason: 'arrived' | 'edge' | 'interrupted' | 'rest';
}

/**
 * ADR 0028 D5：`shell` 已把窗口贴到一条边缘上，并进入 `sitting`（**事实**，不是命令）。
 *
 * - `edge: 'bottom'`：坐在下边缘（脚/臀压在这条线上，身体在其上方）；
 * - `source: 'foreground'`：目标是另一个应用的窗口；`'workarea'`：没有 Win32 时的回退（D7）。
 *
 * 为什么需要它：窗口位置只有 `shell` 能动（§7.2），但 `sitting` 的姿势与 `walking` 的
 * 停摆归 `render`（§4.1）。没有这条事实，render 无法知道"她现在是坐在别人窗口上"。
 */
export interface SnapAppliedPayload {
  edge: 'top' | 'bottom';
  source: 'foreground' | 'workarea';
}

/**
 * ADR 0028 D5：吸附已解除（**事实**）。
 *
 * 只在 render 仍处于 `sitting` 时生效：`drag_started` 会先把状态改成 `dragged`，
 * 紧随其后的 `snap_released{reason:'dragged'}` 不得把 `dragged` 打回 `idle`。
 */
export interface SnapReleasedPayload {
  reason: 'dragged' | 'clicked' | 'command' | 'window-gone' | 'fullscreen';
}

export interface EventPayloads {
  speech_started: SpeechStartedPayload;
  speech_ended: SpeechEndedPayload;
  drag_started: DragStartedPayload;
  drag_released: DragReleasedPayload;
  head_patted: HeadPattedPayload;
  user_utterance: UserUtterancePayload;
  intent_resolved: IntentResolvedPayload;
  llm_failed: LlmFailedPayload;
  model_ready: ModelReadyPayload;
  motion_ended: MotionEndedPayload;
  snap_applied: SnapAppliedPayload;
  snap_released: SnapReleasedPayload;
}

/** `evt:broadcast` 的唯一信封形态（§3.5、§6.4 E-1） */
export interface BroadcastEvent {
  name: EventName;
  payload: EventPayloads[EventName];
}

const EVENT_NAME_SET: ReadonlySet<string> = new Set(EVENT_NAMES);

/** 跨进程转发前的白名单校验：只有 §6.3 的事件名可以过桥。 */
export function isEventName(value: unknown): value is EventName {
  return typeof value === 'string' && EVENT_NAME_SET.has(value);
}
