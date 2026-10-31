/**
 * `memory` 的 schema 与迁移（ADR 0020 D2/D3）。
 *
 * 约定：
 * - 主表 `memories` 用 `PRAGMA user_version` 记版本，迁移**只增不改**；
 * - FTS5 是**可选能力**，它的 DDL 与触发器不在迁移里：老 SQLite / 未编译 FTS5 时
 *   只关掉 FTS，主表与 LIKE 检索照常工作（D3）；
 * - 所有 DDL 都带 `IF NOT EXISTS`，重复 `init()` 幂等。
 */
/**
 * 结构化的最小 SQLite 面（不 import `better-sqlite3` 的类型）。
 *
 * 为什么这么做：schema / query / facts 都是**纯逻辑**，单测想在没有原生模块的
 * 环境里也能过。真正的 `Database` 实例在结构上满足这两个接口，`index.ts` 里
 * 用一次显式转换桥接（ADR 0020 D1/D9）。
 */
export interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(sql: string, options?: { simple?: boolean }): unknown;
  close(): void;
  transaction<T>(fn: () => T): () => T;
}

export interface Migration {
  version: number;
  statements: string[];
}

/** 迁移目标版本；`init()` 会按顺序跑到这里。 */
export const SCHEMA_VERSION = 1;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS memories (
         id      INTEGER PRIMARY KEY AUTOINCREMENT,
         at      INTEGER NOT NULL,
         kind    TEXT    NOT NULL CHECK (kind IN ('user','pet','system')),
         text    TEXT    NOT NULL,
         tags    TEXT    NOT NULL DEFAULT '[]',
         ref_id  TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS idx_memories_at ON memories(at DESC, id DESC)`,
    ],
  },
];

export const FTS_TABLE = 'memories_fts';

/**
 * `trigram` 而不是 `unicode61`：中日文没有空格，`unicode61` 会把整句当成一个 token
 * （实测查 `天気` 命中 0 条）。`trigram` 是子串索引，代价是查询词必须 ≥ 3 字符，
 * 短词由 LIKE 兜底（ADR 0020 D3）。
 */
export const FTS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
  text,
  tags,
  content='memories',
  content_rowid='id',
  tokenize='trigram'
)`;

/** external-content 表的标准三触发器：内容表变了，索引跟着变。 */
export const FTS_TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
     INSERT INTO ${FTS_TABLE}(rowid, text, tags) VALUES (new.id, new.text, new.tags);
   END`,
  `CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
     INSERT INTO ${FTS_TABLE}(${FTS_TABLE}, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
   END`,
  `CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
     INSERT INTO ${FTS_TABLE}(${FTS_TABLE}, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
     INSERT INTO ${FTS_TABLE}(rowid, text, tags) VALUES (new.id, new.text, new.tags);
   END`,
];

/** 新建索引表后把已有行灌进去（升级场景）。 */
export const FTS_REBUILD = `INSERT INTO ${FTS_TABLE}(${FTS_TABLE}) VALUES('rebuild')`;

export function tableExists(db: SqliteDatabase, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?`)
    .get(name) as { name?: unknown } | undefined;
  return typeof row?.name === 'string';
}

export function currentVersion(db: SqliteDatabase): number {
  const value = db.pragma('user_version', { simple: true });
  const version = Number(value);
  return Number.isFinite(version) ? version : 0;
}

/**
 * 按版本号顺序迁移；每个迁移一个事务，失败整体回滚（不允许半迁移的库继续用）。
 * 返回实际执行到的版本。
 */
export function migrate(db: SqliteDatabase): number {
  let version = currentVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;
    const run = db.transaction(() => {
      for (const statement of migration.statements) db.exec(statement);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    });
    run();
    version = migration.version;
  }
  return version;
}

export interface FtsState {
  enabled: boolean;
  /** 这一轮调用刚刚新建了索引表（调用方决定是否 rebuild） */
  created: boolean;
  error: string | null;
}

/** 建 FTS5 表与触发器；任何一步失败都只关掉 FTS，不抛给调用方。 */
export function ensureFts(db: SqliteDatabase): FtsState {
  const existed = tableExists(db, FTS_TABLE);
  try {
    db.exec(FTS_DDL);
    for (const trigger of FTS_TRIGGERS) db.exec(trigger);
    if (!existed) db.exec(FTS_REBUILD);
    return { enabled: true, created: !existed, error: null };
  } catch (error) {
    return { enabled: false, created: false, error: String(error) };
  }
}
