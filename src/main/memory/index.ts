/**
 * `memory` 模块（契约 §7.5；ADR 0020）。
 *
 * 三件事，全部同步：
 * - `init(dbPath)`：建表/迁移、开 WAL、（尽力）建 FTS5 索引；失败按三层降级（D7）；
 * - `retrieve(query, limit)`：字面关键词检索，命中数优先、时间新近次之，≤ 50ms；
 * - `write(event)`：同步落盘，**自吞异常**，只记 `lastError`。
 *
 * 边界（§2.1）：不订阅事件（E-5）、不调用别的模块、不联网、不认识 Reply。
 * 写入时机由 `orchestrator` 单点决定（`setImmediate` 异步，ADR 0020 D5）。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  MEMORY_CANDIDATE_LIMIT,
  MEMORY_LIKE_TERM_LIMIT,
  MEMORY_MAX_ROWS,
  MEMORY_PRUNE_BATCH_MAX,
  MEMORY_RETRIEVE_LIMIT,
  MEMORY_RETRIEVE_LIMIT_MAX,
  MEMORY_TAG_MAX,
  MEMORY_TAG_MAX_CHARS,
  MEMORY_TEXT_MAX_CHARS,
} from '../../shared/constants';
import type { MemoryFact, MemoryKind, MemoryPort, MemoryWrite } from '../../shared/memory-types';
import { extractFactTags } from './facts';
import { buildFtsExpression, countHits, extractTerms, likePattern } from './query';
import { currentVersion, ensureFts, migrate, type SqliteDatabase } from './schema';

export type MemoryMode = 'file' | 'memory' | 'disabled';

export interface MemoryRetrieveTrace {
  query: string;
  /** 词条数（含 CJK 三字滑窗） */
  terms: number;
  /** 返回条数 */
  count: number;
  ms: number;
  /** 本次是否走了 FTS（false = 纯 LIKE） */
  fts: boolean;
}

export interface MemorySnapshot {
  enabled: boolean;
  mode: MemoryMode;
  path: string | null;
  /** 文件库是否真的拿到了 WAL（`:memory:` 恒为 false） */
  wal: boolean;
  /** FTS5 索引是否可用（false 时检索整体降级 LIKE） */
  fts: boolean;
  schemaVersion: number;
  rows: number;
  lastWriteAt: number | null;
  lastRetrieve: MemoryRetrieveTrace | null;
  lastError: string | null;
  /** ADR 0025：最近一次淘汰（行数、删除数、剩余） */
  lastPrune: { at: number; deleted: number; rows: number } | null;
}

export interface MemoryDeps {
  now?: () => number;
  log?: (level: 'info' | 'warn', message: string, data?: unknown) => void;
}

export interface Memory extends MemoryPort {
  /** 契约 §7.5：建表、迁移、打开 WAL。失败会 reject（由 runtime 兜住，§11） */
  init(dbPath: string): Promise<void>;
  /** 契约 §7.5：同步、失败返回 []、耗时目标 ≤ 50ms */
  retrieve(query: string, limit?: number): MemoryFact[];
  /** 契约 §7.5：同步落盘、失败只记日志 */
  write(event: MemoryWrite): void;
  /**
   * ADR 0025：按 `at` 升序淘汰超额行，返回本次删除行数。
   * 同步但**有界**（单次最多 `MEMORY_PRUNE_BATCH_MAX` 行）；`write` 之后异步触发。
   */
  prune(): number;
  /** 非契约（内部）：停机释放句柄 */
  close(): void;
  /** 非契约（内部诊断，不进 RenderState） */
  snapshot(): MemorySnapshot;
}

const KINDS: readonly MemoryKind[] = ['user', 'pet', 'system'];

interface Row {
  id: number;
  at: number;
  kind: MemoryKind;
  text: string;
  tags: string;
}

function parseTags(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function normalizeTags(values: string[]): string[] {
  const tags: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed === '' || trimmed.length > MEMORY_TAG_MAX_CHARS) continue;
    if (tags.includes(trimmed)) continue;
    tags.push(trimmed);
    if (tags.length >= MEMORY_TAG_MAX) break;
  }
  return tags;
}

function clampLimit(limit: unknown): number {
  const value = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : MEMORY_RETRIEVE_LIMIT;
  return Math.min(MEMORY_RETRIEVE_LIMIT_MAX, Math.max(1, value));
}

export function createMemory(deps: MemoryDeps = {}): Memory {
  const now = deps.now ?? Date.now;
  const log =
    deps.log ??
    ((level, message, data) => {
      const line = `[memory] ${message}`;
      if (level === 'warn') console.warn(line, data ?? '');
      else console.log(line, data ?? '');
    });

  let db: SqliteDatabase | null = null;
  let mode: MemoryMode = 'disabled';
  let dbPath: string | null = null;
  let wal = false;
  let fts = false;
  let lastWriteAt: number | null = null;
  let lastRetrieve: MemoryRetrieveTrace | null = null;
  let lastError: string | null = null;
  let lastPrune: MemorySnapshot['lastPrune'] = null;
  let pruneScheduled = false;

  /**
   * ADR 0025：淘汰超额行（按 `at` 升序，最旧的先走）。
   *
   * 同步执行但**有界**：单次最多 `MEMORY_PRUNE_BATCH_MAX` 行，把最坏耗时锁在毫秒级；
   * FTS5 是 external-content 表，`AFTER DELETE` 触发器会自动同步索引，不需要手工删。
   */
  function pruneNow(): number {
    const handle = db;
    if (!handle) return 0;
    try {
      const row = handle.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n?: unknown } | undefined;
      const rows = Number(row?.n ?? 0);
      const overflow = rows - MEMORY_MAX_ROWS;
      if (overflow <= 0) return 0;
      const limit = Math.min(overflow, MEMORY_PRUNE_BATCH_MAX);
      const info = handle
        .prepare(
          `DELETE FROM memories WHERE id IN (
             SELECT id FROM memories ORDER BY at ASC, id ASC LIMIT ?
           )`,
        )
        .run(limit);
      const deleted = Number((info as { changes?: unknown } | undefined)?.changes ?? 0);
      lastPrune = { at: now(), deleted, rows: rows - deleted };
      log('info', '记忆淘汰（ADR 0025）', {
        rows,
        deleted,
        maxRows: MEMORY_MAX_ROWS,
        remaining: rows - deleted,
      });
      return deleted;
    } catch (error) {
      lastError = String(error);
      log('warn', '记忆淘汰失败（已吞掉，不影响对话）', { error: String(error) });
      return 0;
    }
  }

  /** 写后异步淘汰：不阻塞 `write` 的调用方（E-4 / I-3）。 */
  function schedulePrune(): void {
    if (pruneScheduled || !db) return;
    pruneScheduled = true;
    setImmediate(() => {
      pruneScheduled = false;
      pruneNow();
    });
  }

  function open(target: string, isMemory: boolean): SqliteDatabase {
    if (!isMemory) mkdirSync(path.dirname(target), { recursive: true });
    // timeout 是 better-sqlite3 的连接级 busy_timeout（毫秒），与下面的 PRAGMA 一致
    const handle = new Database(target, { timeout: 2000 }) as unknown as SqliteDatabase;
    handle.pragma('journal_mode = WAL');
    handle.pragma('synchronous = NORMAL');
    handle.pragma('busy_timeout = 2000');
    const version = migrate(handle);
    const ftsState = ensureFts(handle);
    const journal = String(handle.pragma('journal_mode', { simple: true }) ?? '');

    db = handle;
    dbPath = isMemory ? ':memory:' : target;
    mode = isMemory ? 'memory' : 'file';
    wal = journal.toLowerCase() === 'wal';
    fts = ftsState.enabled;

    if (!fts) {
      log('warn', 'FTS5 不可用，检索降级为 LIKE（ADR 0020 D3）', { error: ftsState.error });
    }
    if (!wal) {
      log('warn', '未能开启 WAL（暂存库或只读介质），并发读取退化为默认日志模式', {
        mode,
        journal,
      });
    }
    log('info', '记忆库已就绪', {
      mode,
      path: dbPath,
      schemaVersion: version,
      currentVersion: currentVersion(handle),
      fts,
      wal,
      ftsCreated: ftsState.created,
    });
    return handle;
  }

  const memory: Memory = {
    async init(target: string): Promise<void> {
      if (db) return; // 幂等：重复 init 不重开、不清数据
      lastError = null;
      try {
        open(target, false);
        return;
      } catch (error) {
        lastError = String(error);
        log('warn', '记忆库文件打开失败，降级为 :memory:（可写可检索，重启即丢，§11）', {
          path: target,
          error: String(error),
        });
      }
      try {
        open(':memory:', true);
        return;
      } catch (error) {
        mode = 'disabled';
        db = null;
        dbPath = null;
        wal = false;
        fts = false;
        lastError = String(error);
        log('warn', '记忆库完全不可用（原生模块缺失或 ABI 不匹配），本轮不记忆', {
          error: String(error),
        });
        throw error;
      }
    },

    retrieve(query: string, limit?: number): MemoryFact[] {
      const startedAt = now();
      let facts: MemoryFact[] = [];
      let terms: string[] = [];
      let usedFts = false;
      try {
        if (!db) return [];
        terms = extractTerms(query);
        if (terms.length === 0) return [];
        const capped = clampLimit(limit);
        const handle = db;
        const ids = new Set<number>();

        const expression = fts ? buildFtsExpression(terms) : null;
        if (expression !== null) {
          usedFts = true;
          const rows = handle
            .prepare(
              `SELECT rowid AS id FROM memories_fts WHERE memories_fts MATCH ? LIMIT ?`,
            )
            .all(expression, MEMORY_CANDIDATE_LIMIT) as Array<{ id: unknown }>;
          for (const row of rows) ids.add(Number(row.id));
        }

        // 短词（或整个 FTS 不可用时的全部词）走 LIKE；逐词全表扫，词条数要封顶
        const likeTerms = (fts ? terms.filter((term) => [...term].length < 3) : terms).slice(
          0,
          MEMORY_LIKE_TERM_LIMIT,
        );
        if (likeTerms.length > 0) {
          const statement = handle.prepare(
            `SELECT id FROM memories
              WHERE text LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\'
              ORDER BY at DESC, id DESC LIMIT ?`,
          );
          for (const term of likeTerms) {
            const pattern = likePattern(term);
            const rows = statement.all(pattern, pattern, MEMORY_CANDIDATE_LIMIT) as Array<{ id: unknown }>;
            for (const row of rows) ids.add(Number(row.id));
          }
        }

        if (ids.size === 0) return [];

        const idList = [...ids].slice(0, MEMORY_CANDIDATE_LIMIT);
        const placeholders = idList.map(() => '?').join(',');
        const rows = handle
          .prepare(`SELECT id, at, kind, text, tags FROM memories WHERE id IN (${placeholders})`)
          .all(...idList) as Row[];

        const scored = rows.map((row) => {
          const tags = parseTags(row.tags);
          const hits = countHits(terms, row.text, tags.join(' '));
          return {
            fact: {
              id: Number(row.id),
              at: Number(row.at),
              kind: row.kind,
              text: row.text,
              tags,
              score: hits,
            } satisfies MemoryFact,
            hits,
          };
        });

        // 排序：命中数优先 → 时间新近次之 → id 稳定递减（契约 §7.5）
        scored.sort((left, right) => {
          if (right.hits !== left.hits) return right.hits - left.hits;
          if (right.fact.at !== left.fact.at) return right.fact.at - left.fact.at;
          return right.fact.id - left.fact.id;
        });
        facts = scored.slice(0, capped).map((item) => item.fact);
        return facts;
      } catch (error) {
        lastError = String(error);
        facts = [];
        log('warn', '记忆检索失败，按"没有记忆"继续（§11 无缝退回）', { error: String(error) });
        return [];
      } finally {
        const ms = Math.max(0, now() - startedAt);
        lastRetrieve = { query: typeof query === 'string' ? query : '', terms: terms.length, count: facts.length, ms, fts: usedFts };
        if (facts.length > 0) {
          log('info', '记忆检索', { ...lastRetrieve });
        }
        if (ms > 50) {
          log('warn', '记忆检索超出 50ms 预算（契约 §7.5）', { ...lastRetrieve });
        }
      }
    },

    write(event: MemoryWrite): void {
      try {
        if (!db) return;
        if (!event || typeof event !== 'object') return;
        if (!KINDS.includes(event.kind)) {
          log('warn', '记忆写入被丢弃：kind 非法', { kind: String(event.kind) });
          return;
        }
        const raw = typeof event.text === 'string' ? event.text.trim() : '';
        if (raw === '') return;
        const text = raw.length > MEMORY_TEXT_MAX_CHARS ? raw.slice(0, MEMORY_TEXT_MAX_CHARS) : raw;
        const at = typeof event.at === 'number' && Number.isFinite(event.at) ? Math.round(event.at) : now();
        // 手传标签 + 事实提取；去重与上限都在 normalizeTags 里
        const tags = normalizeTags([...(event.tags ?? []), ...extractFactTags(text)]);
        db.prepare(
          `INSERT INTO memories (at, kind, text, tags, ref_id) VALUES (?, ?, ?, ?, ?)`,
        ).run(at, event.kind, text, JSON.stringify(tags), typeof event.refId === 'string' ? event.refId : null);
        lastWriteAt = at;
        schedulePrune();
      } catch (error) {
        lastError = String(error);
        log('warn', '记忆写入失败（已吞掉，不影响对话，§11）', { error: String(error) });
      }
    },

    prune(): number {
      return pruneNow();
    },

    close(): void {
      const handle = db;
      db = null;
      mode = 'disabled';
      lastRetrieve = null;
      if (!handle) return;
      try {
        handle.close();
        log('info', '记忆库已关闭', { path: dbPath });
      } catch (error) {
        lastError = String(error);
        log('warn', '记忆库关闭失败', { error: String(error) });
      }
    },

    snapshot(): MemorySnapshot {
      let rows = 0;
      let schemaVersion = 0;
      if (db) {
        try {
          const row = db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n?: unknown } | undefined;
          rows = Number(row?.n ?? 0);
          schemaVersion = currentVersion(db);
        } catch (error) {
          lastError = String(error);
        }
      }
      return {
        enabled: db !== null,
        mode,
        path: dbPath,
        wal,
        fts,
        schemaVersion,
        rows,
        lastWriteAt,
        lastRetrieve,
        lastError,
        lastPrune,
      };
    },
  };

  return memory;
}
