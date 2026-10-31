/**
 * `memory` 单测（ADR 0020）。
 *
 * 必须跑在 **Electron 的 Node**（ABI 130）里：
 *   npm run test:memory      # = node build.mjs && node scripts/run-electron-test.mjs ...
 * 直接用宿主 `node` 跑会 `ERR_DLOPEN_FAILED`（ABI 137），见 ADR 0020 D9。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { MEMORY_PRUNE_BATCH_MAX, MEMORY_RETRIEVE_BUDGET_MS } from '../../shared/constants';
import type { Memory } from './index';
import { createMemory } from './index';
import { extractFactTags } from './facts';
import { buildFtsExpression, escapeLike, extractTerms } from './query';

interface Harness {
  memory: Memory;
  dbPath: string;
  dir: string;
  cleanup(): void;
}

function makeHarness(t: { after(fn: () => void): void }): Harness {
  const dir = mkdtempSync(path.join(tmpdir(), 'aa3dpet-memory-'));
  const dbPath = path.join(dir, 'memory.db');
  const memory = createMemory({ log: () => undefined });
  t.after(() => {
    try {
      memory.close();
    } catch {
      // 已经关过
    }
    // Windows 上 WAL 文件句柄释放有延迟，EBUSY 时重试；仍失败就留给系统临时目录清理
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // 临时目录残留不影响测试结论
    }
  });
  return {
    memory,
    dbPath,
    dir,
    cleanup(): void {
      memory.close();
    },
  };
}

// ---------------------------------------------------------------------------
// 初始化与迁移
// ---------------------------------------------------------------------------

test('init：建表、迁移版本、WAL、FTS5 全部就绪', async (t) => {
  const { memory, dbPath } = makeHarness(t);
  await memory.init(dbPath);

  const snapshot = memory.snapshot();
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.mode, 'file');
  assert.equal(snapshot.wal, true, 'WAL 必须真的开起来');
  assert.equal(snapshot.fts, true, 'FTS5 索引必须建起来');
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.rows, 0);
  assert.ok(statSync(dbPath).size > 0);
});

test('init 幂等：重复调用不清数据、不重复迁移', async (t) => {
  const { memory, dbPath } = makeHarness(t);
  await memory.init(dbPath);
  memory.write({ kind: 'user', text: '一度目の記憶。', at: 1_000 });

  await memory.init(dbPath);
  assert.equal(memory.snapshot().rows, 1);
  assert.equal(memory.snapshot().schemaVersion, 1);
});

test('init：文件打不开时降级为 :memory:（可写可检索，§11）', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aa3dpet-memory-blocked-'));
  const blocker = path.join(dir, 'blocker');
  writeFileSync(blocker, 'not a directory');
  const memory = createMemory({ log: () => undefined });
  t.after(() => {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  });

  await memory.init(path.join(blocker, 'memory.db'));
  const snapshot = memory.snapshot();
  assert.equal(snapshot.mode, 'memory');
  assert.equal(snapshot.wal, false);

  memory.write({ kind: 'user', text: 'メモリモードでも書ける。' });
  assert.equal(memory.retrieve('メモリモード').length, 1);
});

// ---------------------------------------------------------------------------
// 写入与检索
// ---------------------------------------------------------------------------

test('write / retrieve：中文长词走 FTS5 命中，并带 score', async (t) => {
  const { memory, dbPath } = makeHarness(t);
  await memory.init(dbPath);
  memory.write({ kind: 'user', text: '我喜欢喝咖啡，尤其是早上。' });
  memory.write({ kind: 'pet', text: '……そういうことですか。' });

  const facts = memory.retrieve('喜欢喝咖啡');
  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.kind, 'user');
  assert.match(facts[0]?.text ?? '', /咖啡/);
  assert.ok((facts[0]?.score ?? 0) >= 1);
});

test('write / retrieve：2 字短词走 LIKE 降级（trigram 匹配不到 <3 字）', async (t) => {
  const { memory, dbPath } = makeHarness(t);
  await memory.init(dbPath);
  memory.write({ kind: 'user', text: '我喜欢喝咖啡。' });

  assert.equal(memory.retrieve('咖啡').length, 1);
  assert.equal(memory.retrieve('红茶').length, 0);
});

test('retrieve：未命中返回 []（不抛、不算错）', async (t) => {
  const { memory, dbPath } = makeHarness(t);
  await memory.init(dbPath);
  memory.write({ kind: 'user', text: '今日はいい天気ですね。' });

  assert.deepEqual(memory.retrieve('宇宙飛行士'), []);
  assert.deepEqual(memory.retrieve(''), []);
  assert.deepEqual(memory.retrieve('   '), []);
  assert.deepEqual(memory.retrieve('！？。'), []);
});

test('retrieve：SQL/通配符特殊字符不会注入，也不会抛', async (t) => {
  const { memory, dbPath } = makeHarness(t);
  await memory.init(dbPath);
  memory.write({ kind: 'user', text: '100% の果汁と under_score。' });

  for (const query of ['%', '_', '"', "'; DROP TABLE memories; --", 'MATCH', 'NEAR(', 'a*b']) {
    assert.doesNotThrow(() => memory.retrieve(query), `query=${query}`);
  }
  // 纯标点不是词条（切词阶段就被丢弃），所以不会命中任何行
  assert.deepEqual(memory.retrieve('%'), []);
  // 库还在、行还在：注入没有生效
  assert.equal(memory.snapshot().rows, 1);
});

test('retrieve：默认 limit=5，上限 20，越界钳制', async (t) => {
  const { memory, dbPath } = makeHarness(t);
  await memory.init(dbPath);
  for (let index = 0; index < 25; index += 1) {
    memory.write({ kind: 'user', text: `コーヒーの記憶 ${index}`, at: 1_000 + index });
  }

  assert.equal(memory.retrieve('コーヒー').length, 5, '默认 5 条');
  assert.equal(memory.retrieve('コーヒー', 100).length, 20, '上限 20 条');
  assert.equal(memory.retrieve('コーヒー', 0).length, 1, '下限 1 条');
  assert.equal(memory.retrieve('コーヒー', -3).length, 1);
});

test('排序：命中数优先，其次时间新近', async (t) => {
  const { memory, dbPath } = makeHarness(t);
  await memory.init(dbPath);
  // 旧的命中两个词
  memory.write({ kind: 'user', text: 'コーヒーと紅茶の話。', at: 1_000 });
  // 新的只命中一个词
  memory.write({ kind: 'user', text: 'コーヒーだけの話。', at: 2_000 });

  const facts = memory.retrieve('コーヒー 紅茶');
  assert.equal(facts.length, 2);
  assert.equal(facts[0]?.at, 1_000, '命中数多的优先，即使更旧');
  assert.ok((facts[0]?.score ?? 0) > (facts[1]?.score ?? 0));

  const sameHits = memory.retrieve('コーヒー');
  assert.equal(sameHits[0]?.at, 2_000, '同命中数时新的在前');
});

test('持久化：close 后重新 init（等价"重启"）仍能检索到', async (t) => {
  const { memory, dbPath } = makeHarness(t);
  await memory.init(dbPath);
  memory.write({ kind: 'user', text: '私の好きな飲み物はコーヒーです。' });
  memory.close();

  const reopened = createMemory({ log: () => undefined });
  await reopened.init(dbPath);
  try {
    const facts = reopened.retrieve('コーヒー');
    assert.equal(facts.length, 1);
    assert.match(facts[0]?.text ?? '', /コーヒー/);
    assert.equal(reopened.snapshot().rows, 1);
  } finally {
    reopened.close();
  }
});

// ---------------------------------------------------------------------------
// WAL 并发读取
// ---------------------------------------------------------------------------

test('WAL：写事务未提交时检索不被阻塞，提交后可读到新行', async (t) => {
  const { memory, dbPath } = makeHarness(t);
  await memory.init(dbPath);
  memory.write({ kind: 'user', text: '最初の記憶。' });

  const second = new Database(dbPath, { timeout: 2000 });
  try {
    assert.equal(String(second.pragma('journal_mode', { simple: true })).toLowerCase(), 'wal');

    second.exec('BEGIN IMMEDIATE');
    second
      .prepare('INSERT INTO memories (at, kind, text, tags, ref_id) VALUES (?, ?, ?, ?, ?)')
      .run(9_000, 'user', '並行書き込みの記憶。', '[]', null);

    // 写事务还开着：WAL 下读连接不被阻塞，且看不到未提交的行
    assert.equal(memory.retrieve('並行').length, 0);

    second.exec('COMMIT');
    assert.equal(memory.retrieve('並行').length, 1);
    assert.equal(memory.snapshot().rows, 2);
  } finally {
    second.close();
  }
});

// ---------------------------------------------------------------------------
// 失败降级
// ---------------------------------------------------------------------------

test('write 失败只记 lastError，不抛给调用方（§7.5）', async (t) => {
  const { memory, dbPath } = makeHarness(t);
  await memory.init(dbPath);
  memory.close();

  assert.doesNotThrow(() => memory.write({ kind: 'user', text: '閉じた後でも安全。' }));
  assert.equal(memory.snapshot().enabled, false);
});

test('retrieve 失败返回 []（不抛）', async (t) => {
  const { memory, dbPath } = makeHarness(t);
  await memory.init(dbPath);
  memory.write({ kind: 'user', text: '記憶。' });
  memory.close();

  let facts: unknown[] = ['sentinel'];
  assert.doesNotThrow(() => {
    facts = memory.retrieve('記憶');
  });
  assert.deepEqual(facts, []);
});

test('非法 kind / 空文本被丢弃，不写坏库', async (t) => {
  const { memory, dbPath } = makeHarness(t);
  await memory.init(dbPath);

  memory.write({ kind: 'robot' as never, text: 'だめな種類。' });
  memory.write({ kind: 'user', text: '   ' });
  assert.equal(memory.snapshot().rows, 0);
});

// ---------------------------------------------------------------------------
// 事实标签
// ---------------------------------------------------------------------------

test('事实提取：中文喜欢/不喜欢，否定优先', () => {
  assert.deepEqual(extractFactTags('我喜欢喝咖啡。'), ['like:喝咖啡']);
  assert.deepEqual(extractFactTags('我最喜欢猫。'), ['like:猫']);
  assert.deepEqual(extractFactTags('我不喜欢辣的东西。'), ['dislike:辣的东西']);
  assert.deepEqual(extractFactTags('嗯……'), []);
});

test('事实提取：日文 が好き / が嫌い，去掉主语与助动词', () => {
  assert.deepEqual(extractFactTags('コーヒーが好きです。'), ['like:コーヒー']);
  assert.deepEqual(extractFactTags('私は猫が好きです。'), ['like:猫']);
  assert.deepEqual(extractFactTags('にんじんは嫌いです。'), ['dislike:にんじん']);
});

test('write 自动附带事实标签，且标签参与检索', async (t) => {
  const { memory, dbPath } = makeHarness(t);
  await memory.init(dbPath);
  memory.write({ kind: 'user', text: '我喜欢喝咖啡。', tags: ['好み'] });

  const facts = memory.retrieve('好み');
  assert.equal(facts.length, 1);
  assert.deepEqual(facts[0]?.tags, ['好み', 'like:喝咖啡']);
});

// ---------------------------------------------------------------------------
// 查询纯函数
// ---------------------------------------------------------------------------

test('extractTerms：CJK 长串切三字滑窗，ASCII 长词保持整词', () => {
  assert.deepEqual(extractTerms('咖啡'), ['咖啡']);
  // 4 字以上的 CJK 串一律切滑窗（假名同理：`コーヒー` 本身没有分词边界）
  assert.deepEqual(extractTerms('コーヒー'), ['コーヒ', 'ーヒー']);
  const windows = extractTerms('喜欢什么咖啡吗');
  assert.deepEqual(windows, ['喜欢什', '欢什么', '什么咖', '么咖啡', '咖啡吗']);
  assert.deepEqual(extractTerms('coffee shop'), ['coffee', 'shop']);
  assert.deepEqual(extractTerms('   '), []);
});

test('escapeLike / buildFtsExpression：短词不进 FTS，引号被转义', () => {
  assert.equal(escapeLike('100%_a\\b'), '100\\%\\_a\\\\b');
  assert.equal(buildFtsExpression(['咖啡']), null, '2 字词交给 LIKE');
  assert.equal(buildFtsExpression(['コーヒー']), '"コーヒー"');
  assert.equal(buildFtsExpression(['コーヒー', '紅茶です']), '"コーヒー" OR "紅茶です"');
  assert.equal(buildFtsExpression(['ab"cd']), '"ab""cd"');
});

// ---------------------------------------------------------------------------
// 延迟预算（契约 §7.5：≤ 50ms）
// ---------------------------------------------------------------------------

test(`检索延迟：500 行 × 20 次平均 ≤ ${MEMORY_RETRIEVE_BUDGET_MS}ms（契约 §7.5）`, async (t) => {
  const { memory, dbPath } = makeHarness(t);
  await memory.init(dbPath);
  for (let index = 0; index < 500; index += 1) {
    memory.write({
      kind: index % 2 === 0 ? 'user' : 'pet',
      text: `記憶 ${index}：今日はゲーム開発部でテストをしていました。${index} 番目の記録です。`,
      at: 1_000 + index,
    });
  }

  const queries = ['ゲーム開発部', 'テスト', '記録', '今日は', '記憶'];
  const startedAt = Date.now();
  let count = 0;
  for (let round = 0; round < 20; round += 1) {
    count += memory.retrieve(queries[round % queries.length] ?? 'ゲーム').length;
  }
  const average = (Date.now() - startedAt) / 20;

  assert.ok(count > 0, '查询应当命中');
  assert.ok(average <= MEMORY_RETRIEVE_BUDGET_MS, `平均 ${average.toFixed(2)}ms 超出预算`);
  assert.ok(memory.snapshot().lastRetrieve !== null);
});

test('超长文本被截断到 2000 字（不撑爆库）', async (t) => {
  const { memory, dbPath } = makeHarness(t);
  await memory.init(dbPath);
  memory.write({ kind: 'user', text: `コーヒー${'あ'.repeat(3000)}` });

  const facts = memory.retrieve('コーヒー');
  assert.equal(facts.length, 1);
  assert.equal((facts[0]?.text ?? '').length, 2000);
});

// ---------------------------------------------------------------------------
// 淘汰策略（ADR 0025）
// ---------------------------------------------------------------------------

/** 直接读 FTS 表行数：证明"删主表"确实同步清理了索引，而不是只删了 memories。 */
function countFtsRows(dbPath: string): number {
  const handle = new Database(dbPath, { timeout: 2000 });
  try {
    const row = handle.prepare('SELECT COUNT(*) AS n FROM memories_fts').get() as { n?: unknown };
    return Number(row?.n ?? -1);
  } finally {
    handle.close();
  }
}

test('prune：未超上限时是空操作（不删、不报错）', async (t) => {
  const { memory, dbPath } = makeHarness(t);
  await memory.init(dbPath);
  for (let index = 0; index < 10; index += 1) {
    memory.write({ kind: 'user', text: `記録 ${index}`, at: 1_000 + index });
  }
  // 同一同步块内调用：setImmediate 的自动淘汰还没跑，断言的是 prune() 本身
  assert.equal(memory.prune(), 0);
  assert.equal(memory.snapshot().rows, 10);
});

test('prune：超过 2000 行时按 at 升序删最旧的，FTS5 索引同步清理', async (t) => {
  const { memory, dbPath } = makeHarness(t);
  await memory.init(dbPath);

  const total = 2005;
  for (let index = 0; index < total; index += 1) {
    memory.write({
      kind: 'user',
      text: `記憶 ${index} ユニーク${index}`,
      at: 1_000 + index,
    });
  }

  // 同步块内：单次 prune 只删 200（有界），循环收敛到上限
  let deleted = 0;
  for (let round = 0; round < 10; round += 1) {
    const removed = memory.prune();
    deleted += removed;
    if (removed === 0) break;
  }

  assert.equal(deleted, 5, '只删掉超出的 5 行');
  assert.equal(memory.snapshot().rows, 2000);
  assert.equal(countFtsRows(dbPath), 2000, 'FTS5 索引必须与主表一致');

  // 最旧的 5 条（at 1000..1004）已不在；最新的一条仍在
  const handle = new Database(dbPath, { timeout: 2000 });
  try {
    const oldest = handle.prepare('SELECT COUNT(*) AS n FROM memories WHERE at < 1005').get() as {
      n?: unknown;
    };
    const newest = handle.prepare('SELECT COUNT(*) AS n FROM memories WHERE at = 2004').get() as {
      n?: unknown;
    };
    assert.equal(Number(oldest?.n ?? -1), 0, '最旧的行必须被删掉');
    assert.equal(Number(newest?.n ?? -1), 1, '最新的行必须保留');
  } finally {
    handle.close();
  }
});

test('prune：单次删除有界（最多 MEMORY_PRUNE_BATCH_MAX 行），多次调用收敛', async (t) => {
  const { memory, dbPath } = makeHarness(t);
  await memory.init(dbPath);

  const total = 2300;
  for (let index = 0; index < total; index += 1) {
    memory.write({ kind: 'user', text: `記憶 ${index}`, at: 1_000 + index });
  }

  const first = memory.prune();
  assert.equal(first, MEMORY_PRUNE_BATCH_MAX, '单次不得超过批量上限');
  assert.equal(memory.snapshot().rows, total - MEMORY_PRUNE_BATCH_MAX);

  // 继续收敛到 2000
  for (let round = 0; round < 10; round += 1) {
    if (memory.prune() === 0) break;
  }
  assert.equal(memory.snapshot().rows, 2000);
});

test('write 之后会自动排期淘汰（不阻塞调用方）', async (t) => {
  const { memory, dbPath } = makeHarness(t);
  await memory.init(dbPath);

  for (let index = 0; index < 2010; index += 1) {
    memory.write({ kind: 'user', text: `記憶 ${index}`, at: 1_000 + index });
  }
  // 让 setImmediate 队列跑完：自动淘汰应当把行数压到上限
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(memory.snapshot().rows, 2000);
  assert.ok(memory.snapshot().lastPrune !== null, '应记录最近一次淘汰');
});
