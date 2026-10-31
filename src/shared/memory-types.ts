// 契约 §7.5 的记忆类型（原文形态），放在 shared 是为了让 orchestrator 只做
// **类型引用**（`import type`），不会被拖进 `better-sqlite3` 这个原生模块的依赖图。
//
// 禁止在这里加字段：`MemoryFact` / `MemoryWrite` 是契约字段，改动需要 ADR + 契约升版。

export type MemoryKind = 'user' | 'pet' | 'system';

/** 检索结果单元（契约 §7.5）。`score` 只在 `retrieve` 命中时填充。 */
export interface MemoryFact {
  id: number;
  at: number;
  kind: MemoryKind;
  text: string;
  tags: string[];
  score?: number;
}

/** 写入单元（契约 §7.5）。 */
export interface MemoryWrite {
  kind: MemoryKind;
  text: string;
  tags?: string[];
  at?: number;
  refId?: string;
}

/**
 * `orchestrator` 看到的记忆端口（结构化，不 import 实现，ADR 0020 D10）。
 * `memory` 模块的 `Memory` 天然满足它。
 */
export interface MemoryPort {
  retrieve(query: string, limit?: number): MemoryFact[];
  write(event: MemoryWrite): void;
}
