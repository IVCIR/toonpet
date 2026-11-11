/**
 * 控制面板的跨进程契约（ADR 0052；ADR 0053 扩展到人格/模型/记忆；ADR 0056 加只读模型列表）。
 *
 * 只有这些纯数据跨进程（§6.2 N-7）：
 * - `PanelAction`：面板 → 主进程的一次写/状态请求（`cmd:panel`，invoke/handle）；
 * - `PanelResult`：`cmd:panel` 的应答（同样走 invoke 的返回值）；
 * - `PanelStatus`：主进程 → 面板的状态快照（`cmd:panel-state`，只在面板可见时推）；
 * - `PanelFetchModelsRequest` / `PanelFetchModelsResult`：只读模型列表（`cmd:fetch-models`）。
 *
 * **没有**新增事件（§6.3 清单不变）、**没有**新增 `RenderState` 字段（§7.1 不变）。
 * 状态快照里的 `RenderState` 是渲染进程 `getState()` 的原样拷贝，只读。
 *
 * ADR 0053 的两条新原则：
 * - 面板**不直接**读写 SQLite：记忆列表/删除/清空都是主进程 `memory` 模块上的管理方法，
 *   由 `runtime` 暴露给面板控制器（面板只发 IPC，不 import 原生模块）；
 * - 面板**不直接**改 LLM 客户端：`set-model` 由 `runtime` 换掉 `LlmClient` 并清掉健康检查状态，
 *   下一轮 `respond()` 自然对新模型重新做一次健康检查。
 */
import type { MemoryRecord } from './memory-types';
import type { RenderState } from './types';
import type { TunableValues } from './tunable-params';
import type { LlmModelListResult, LlmProviderType } from './llm-providers';

/**
 * 面板能做的事。
 * 物理手感：`snapshot` / `status` / `preview` / `save` / `reset`；
 * 人格与模型：`card` / `save-card` / `set-model` / `tts-test`；
 * 提供商（ADR 0055）：`providers` / `provider-save` / `provider-delete` /
 * `provider-activate` / `provider-test`；
 * 记忆管理：`memories` / `memory-delete` / `memory-clear`。
 * `preview` 不写盘，`save` 才写；`save-card` 直接覆盖角色卡文件（原子写）。
 */
export type PanelAction =
  | { action: 'snapshot' }
  | { action: 'status' }
  | { action: 'preview'; values: unknown }
  | { action: 'save'; values: unknown }
  | { action: 'reset' }
  | { action: 'card' }
  | { action: 'save-card'; text: string }
  | { action: 'set-model'; model: string }
  | { action: 'tts-test' }
  | { action: 'providers' }
  | { action: 'provider-save'; provider: unknown }
  | { action: 'provider-delete'; id: string }
  | { action: 'provider-activate'; id: string }
  | { action: 'provider-test'; id: string }
  | { action: 'memories'; limit?: number }
  | { action: 'memory-delete'; id: number }
  | { action: 'memory-clear'; confirm: boolean }
  // ADR 0053：面板自己收起来（Esc）。不销毁窗口，与标题栏关闭按钮同一条路径
  | { action: 'hide' };

/** 面板顶部/底部要展示的持久化信息 */
export interface PanelConfigFacts {
  /** `<appRoot>/config.json` 的绝对路径（面板只展示，不读取） */
  configPath: string;
  /** 上一次成功保存的时间（ISO 8601）；`null` = 从未保存过 */
  savedAt: string | null;
  /** 本次启动是否从文件里读到了覆盖值 */
  loadedFromFile: boolean;
}

/**
 * 当前正在播放的动画片段（面板"系统状态"用）。
 * 与 `RenderDiagram.animation.current` 同源，但这里只取三个字段，避免把整包诊断拉过 IPC。
 */
export interface PanelClipFacts {
  name: string | null;
  slot: string | null;
  timeSeconds: number;
  weight: number;
}

/** 渲染进程上报的极轻快照（`cmd:state-report`） */
export interface PanelRenderFacts {
  state: RenderState;
  clip: PanelClipFacts;
  /** 坐姿两段式的关键读数；不在坐姿时为 `null` */
  sit: {
    stage: 'a' | 'b';
    sitPoseGain: number;
    phaseAHeadAppliedRad: number;
    spineOverlayApplied: number;
  } | null;
  /** 渲染进程**实际生效**的调参值（用于证明"滑块真的到了渲染侧"） */
  tuning: TunableValues;
  /**
   * ADR 0057 D2.6：整体缩放的渲染侧事实（面板只显示，不反推行为）。
   * `scale` = 内容区高 / 基准高 720；主进程会再按屏幕工作区夹一次，
   * 所以它才是"真正生效的比例"（滑块上的是请求值）。
   */
  view: { width: number; height: number; scale: number };
  /** 渲染进程采样时刻（`performance.now()` 同一进程时基，只用于判断新鲜度） */
  collectedAt: number;
}

/**
 * `/api/tags` 里的一个模型（ADR 0053）。
 * 只保留"面板要显示的三件事"：标签名、体积、更新时间。
 */
export interface PanelModelOption {
  /** `qwen3:4b` 这种标签名（Ollama 的 name:tag） */
  name: string;
  sizeBytes: number | null;
  modifiedAt: string | null;
}

/** Ollama 在线状态（主进程探测，只连回环） */
export interface PanelOllamaFacts {
  /** 服务可达且**当前模型**在 `/api/tags` 里 = online；服务可达但缺模型 = offline（detail 说清缺哪个） */
  status: 'online' | 'offline' | 'unknown';
  baseUrl: string;
  /** 主进程当前生效的模型名（切换后会变） */
  model: string;
  /** 探测往返耗时（ms）；未成功时为 `null` */
  latencyMs: number | null;
  detail: string | null;
  checkedAt: number | null;
  /** 服务本身可达（即使缺模型也是 true）；用于把"服务没起来"与"模型没拉下来"分开 */
  reachable: boolean;
  /** 当前模型是否在 `/api/tags` 里 */
  modelPresent: boolean;
  /** 本地可用模型列表（下拉框的数据源；探测失败时为空数组） */
  models: PanelModelOption[];
}

/** AI 人格 / 模型配置 Tab 的事实（ADR 0053；ADR 0055 提供商） */
export interface PanelPersonaFacts {
  cardPath: string;
  cardExists: boolean;
  cardChars: number;
  /** 主进程**当前生效**的模型名（`config.json` 覆盖过 `PET_LLM_MODEL` 时是这个） */
  llmModel: string;
  llmBaseUrl: string;
  /** ADR 0055：当前生效提供商的类型/显示名 */
  llmProviderType: LlmProviderType;
  llmProviderName: string;
  /** ADR 0055：当前生效提供商 id */
  llmProviderId: string;
  /**
   * 启动/当前这一轮 LLM 是否被熔断（`orchestrator.snapshot().llmDisabled`）。
   * 面板只展示，不提供"重置熔断"按钮（§11：熔断是用户触发的会话级决定）。
   */
  llmDisabled: boolean;
  /** TTS 是否可用（参考音频 + 参考文本齐备） */
  ttsEnabled: boolean;
  /** 参考音频的绝对路径（只读展示） */
  ttsRefAudioPath: string;
  /** TTS 不可用时的原因（`null` = 可用） */
  ttsDisabledReason: string | null;
}

/**
 * 一个提供商在面板上的**只读投影**（ADR 0055 D5）。
 * 刻意不包含 `apiKey`：面板只知道"有没有存 Key"，永远拿不到明文。
 */
export interface PanelProviderFacts {
  id: string;
  type: LlmProviderType;
  name: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  /** 当前生效的提供商 */
  active: boolean;
  /** 最近一次连接测试的结果（`null` = 还没测过） */
  test: PanelProviderTestFacts | null;
}

/**
 * `cmd:fetch-models` 的请求（ADR 0056）。
 *
 * 面板只发"当前表单里的地址 + 用户刚输入的 Key"；**已保存的 Key 永远不进渲染进程**。
 * `apiKey` 为空且 `providerId` 指向一个已保存的提供商时，主进程在**类型与地址都匹配**的
 * 前提下注入旧 Key（防止把旧 Key 发到被改写的地址上）。
 */
export interface PanelFetchModelsRequest {
  /** 缺省时主进程按 baseUrl 推断（OpenCode Go 预设 / 回环 / 其他） */
  type?: LlmProviderType;
  baseUrl: string;
  /** 用户刚输入的 Key；留空 = 尝试沿用已保存的 Key */
  apiKey?: string;
  /** 编辑中的提供商 id；用于"留空沿用旧 Key" */
  providerId?: string;
}

/** `cmd:fetch-models` 的应答：成功给 `{id,name}` 清单，失败给一句人话。 */
export type PanelFetchModelsResult = LlmModelListResult;

/** 提供商连通性测试结果（`provider-test` 动作；ADR 0055） */
export interface PanelProviderTestFacts {
  id: string;
  /** `ok` = 端点与凭证可用；`failed` = 连接/鉴权失败；`unknown` = 尚未测试 */
  status: 'ok' | 'failed';
  /** 给人看的一句话（失败原因/成功时的模型数） */
  detail: string | null;
  /** 往返耗时（ms） */
  latencyMs: number | null;
  /** 服务可达（即使模型不在清单里） */
  reachable: boolean;
  /** 模型是否在服务端清单里（端点不提供清单时为 `null`） */
  modelPresent: boolean | null;
  /** 测试时刻（ISO 8601） */
  checkedAt: string;
}

/** 记忆管理 Tab 的概览（ADR 0053：列表/删除/清空另走动作，状态里只有计数） */
export interface PanelMemoryFacts {
  enabled: boolean;
  /** `file` / `memory`（降级到内存库）/ `disabled` */
  mode: string;
  dbPath: string;
  dbExists: boolean;
  dbBytes: number | null;
  dbUpdatedAt: string | null;
  /** 当前行数（来自 `memory.snapshot()`，不是文件大小推算） */
  rows: number;
  lastError: string | null;
}

/** 系统状态 Tab 的完整快照 */
export interface PanelStatus {
  render: PanelRenderFacts | null;
  ollama: PanelOllamaFacts;
  persona: PanelPersonaFacts;
  /** ADR 0055：提供商列表（只读投影，不含 Key） */
  providers: PanelProviderFacts[];
  memory: PanelMemoryFacts;
  /** 面板窗口是否可见（主进程侧事实） */
  panelVisible: boolean;
}

/** 角色卡读取结果（`card` 动作） */
export interface PanelCardFacts {
  path: string;
  exists: boolean;
  chars: number;
  text: string;
  /** 读取失败的原因（`null` = 读到了） */
  error: string | null;
}

/** TTS 连通性测试结果（`tts-test` 动作） */
export interface PanelTtsTestFacts {
  ok: boolean;
  /** TTS 是否配置齐全（缺参考音频/参考文本时为 false，且不发 HTTP） */
  enabled: boolean;
  baseUrl: string;
  refAudioPath: string;
  /** 往返耗时（ms）；未发出请求时为 `null` */
  ms: number | null;
  /** 返回的 WAV 字节数（成功时） */
  bytes: number | null;
  /** 失败原因（`disabled` / `unavailable` / `timeout` / `http` / `invalid_audio`） */
  reason: string | null;
  detail: string | null;
}

/** `cmd:panel` 的应答 */
export interface PanelResult {
  ok: boolean;
  /** 主进程当前认为生效的一组值（完整） */
  values: TunableValues;
  config: PanelConfigFacts;
  /** `ok=false` 时的可读原因（直接显示在面板上） */
  error?: string;
  /** 成功/失败都可能有的一句人话（例如"已保存，下一轮对话生效"） */
  notice?: string;
  /** `card` / `save-card` 的应答 */
  card?: PanelCardFacts;
  /** `set-model` 的应答：主进程当前生效的模型名 */
  model?: string;
  /** `tts-test` 的应答 */
  tts?: PanelTtsTestFacts;
  /** `memories` 的应答（时间倒序） */
  memories?: MemoryRecord[];
  /** ADR 0055：提供商列表（每次 provider 动作后返回最新投影） */
  providers?: PanelProviderFacts[];
  /** ADR 0055：当前生效提供商 id */
  activeProvider?: string;
  /** ADR 0055：`provider-test` 的结果 */
  providerTest?: PanelProviderTestFacts;
  /** `memory-delete` / `memory-clear` 的应答：删除后的行数 */
  memoryRows?: number;
  /** `memory-delete` 是否真的删到了行 */
  deleted?: boolean;
  /** `memory-clear` 实际删除的行数 */
  cleared?: number;
}
