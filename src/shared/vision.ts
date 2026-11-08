/**
 * 视觉/OCR（ADR 0054）的公共类型。
 *
 * 这里只放**跨进程**的形状（主进程结果 → 渲染页/面板），不放 PNG Buffer：
 * `cmd:vision-query` 是 invoke/handle，返回值必须能被结构化克隆 + JSON 序列化。
 * 图像本体留在主进程，渲染侧只拿到"读到了多少字、多大、多久"这类可展示的事实。
 */

/** 截图来源：整屏（光标所在显示器）或前台窗口（按标题匹配 desktopCapturer 窗口源） */
export type VisionSource = 'screen' | 'foreground';

export const VISION_SOURCES: readonly VisionSource[] = ['screen', 'foreground'];

/**
 * 失败原因。全部是**降级**语义（ADR 0054 D5）：
 * 没有一条会让对话失败，最坏情况就是"这一轮没有视觉上下文"。
 */
export type VisionFailureReason =
  /** `PET_VISION_DISABLE=1` 或配置里显式关闭 */
  | 'disabled'
  /** 已有一次截图/识别在途（单飞，ADR 0054 D6） */
  | 'busy'
  /** 截图不可用（desktopCapturer 空源/空缩略图）、OCR 端点连不上或返回非 2xx */
  | 'unavailable'
  /** 超过 OCR 超时预算 */
  | 'timeout'
  /** 端点正常，但没有识别出任何文字 */
  | 'empty'
  /** 其它异常（解析失败、内部错误） */
  | 'error';

/** 请求体（`cmd:vision-query` 的载荷）：只允许挑来源，不允许带图/带提示词 */
export interface VisionQueryRequest {
  source?: VisionSource;
}

/** 图像元信息：只用于展示与自检断言，不回传像素 */
export interface VisionImageInfo {
  bytes: number;
  width: number;
  height: number;
}

/** 一次视觉查询的完整结果（成功与失败同构，便于 UI 直接展示） */
export interface VisionResult {
  ok: boolean;
  /** 请求的来源（用户/热键想要的） */
  source: VisionSource;
  /** 实际截到的来源：前台窗口没找到时降级为整屏（ADR 0054 D2） */
  capturedFrom: VisionSource | null;
  text: string;
  chars: number;
  /** 截图时刻（epoch ms） */
  at: number;
  /** 截图 + 识别总耗时（ms） */
  durationMs: number;
  image: VisionImageInfo | null;
  model: string;
  baseUrl: string;
  reason: VisionFailureReason | null;
  detail: string | null;
}

/**
 * 注入提示词的视觉上下文（ADR 0054 D4）。
 *
 * 与 `VisionResult` 分开：提示词只关心"文字 + 何时读的 + 谁读的"，
 * 不关心 PNG 大小/失败原因；`VisionResult` 是给 UI 的回执。
 */
export interface VisionContext {
  text: string;
  chars: number;
  /** 截图时刻（epoch ms）：提示词里的"几秒前"以它为准 */
  at: number;
  source: VisionSource;
  model: string;
}

export function isVisionSource(value: unknown): value is VisionSource {
  return value === 'screen' || value === 'foreground';
}

/**
 * 解析 `cmd:vision-query` 的载荷。
 *
 * 只接受两种形状：`undefined` / `{}` / `{ source: 'screen'|'foreground' }`。
 * 其它字段一律忽略（不报错），非法 source 退回 `undefined`（由调用方用配置默认值），
 * 与面板参数"非法输入忽略"的既有口径一致（ADR 0052 D3）。
 */
export function parseVisionQueryRequest(payload: unknown): VisionQueryRequest {
  if (payload === null || typeof payload !== 'object') return {};
  const source = (payload as { source?: unknown }).source;
  return isVisionSource(source) ? { source } : {};
}
