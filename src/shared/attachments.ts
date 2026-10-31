/**
 * 装配期配件过滤（ADR 0014 D5）。
 *
 * `HIDE_ATTACHMENTS` 与取景排除是**两件不同的事**，只是默认同源：
 * - 取景排除（`PET_FRAME_EXCLUDE`）决定窗口尺寸与脚底锚点（ADR 0009 D3/D4）；
 * - 隐藏集合（`PET_HIDE_ATTACHMENTS`）决定装配后哪些网格 `visible = false`。
 *
 * 只做可见性，不删除节点、不改材质、不改几何：可逆、可配置，也不会破坏
 * 动画 track 指向的节点表。正则匹配复用 `matchesFrameExclude`（同一份语义），
 * 避免出现"取景用一个正则、隐藏用另一个"的两套实现。
 */
import { DEFAULT_FRAME_EXCLUDE, matchesFrameExclude } from './model-frame';

/** 默认隐藏武器 / 道具 / 笔刷 / 描边（与默认取景排除同一串）。 */
export const DEFAULT_HIDE_ATTACHMENTS = DEFAULT_FRAME_EXCLUDE;

/** 名字是否属于"应隐藏的配件"。空模式/坏正则一律按"不隐藏"处理。 */
export function matchesHiddenAttachment(
  name: string | null | undefined,
  pattern: string,
): boolean {
  return matchesFrameExclude(name, pattern);
}
