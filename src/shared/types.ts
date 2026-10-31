// 契约 §7.1 原文。任何模块都不得增删字段，不得新增状态值、情绪值或意图值。
export type ModuleId = 'shell' | 'render' | 'orchestrator' | 'voice' | 'memory';

export type BaseState = 'idle' | 'walking';
export type OverlayState = 'speaking' | 'reacting';
/**
 * Physics 层。`dragged` = 指针拖拽；`settling` = 松手后的回弹（ADR 0024 D3）。
 * 二者互斥，且都高于 Overlay：回弹期间不接受新的动作意图。
 */
export type PhysicsState = 'dragged' | 'settling';
export type OrchestratorState = 'thinking' | 'idle';

export type Emotion =
  | 'neutral'
  | 'happy'
  | 'sad'
  | 'surprised'
  | 'shy'
  | 'angry'
  | 'sleepy';

export type Intent =
  | 'none'
  | 'greet'
  | 'nod'
  | 'shake_head'
  | 'tilt_head'
  | 'look_at_user'
  | 'pat_react'
  | 'happy_hop';

/** 编排层唯一输出物，不允许增删字段 */
export interface Reply {
  text: string;
  emotion: Emotion;
  intent: Intent;
}

/** render.getState() 的返回，只读 */
export interface RenderState {
  base: BaseState;
  overlay: OverlayState | null;
  physics: PhysicsState | null;
  emotion: Emotion;
  speakingUtteranceId: string | null;
  orchestrator: OrchestratorState; // 只读镜像
  modelReady: boolean;
}
