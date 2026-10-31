# 0020. `memory` 模块：SQLite schema、迁移、FTS5/LIKE 关键词检索与写入时机

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-10-30 |
| 决策者 | 项目所有者 |
| 关联 | `CONTRACTS.md` §2（模块划分）、§6.4 E-5、§7.5（`memory` 接口）、§9.3 段 ③、§10.1 $5、§11（SQLite 失败行）、§13 X-5；ADR 0015 D1（orchestrator 段 ③ 注入点）、ADR 0018 D1（`.env`）；ADR 0021（同轮的字幕时序） |

> 编号说明：本轮任务原文把"记忆 schema 与检索策略"称为 ADR 0019，但 `docs/adr/0019-*.md` 已被 TTS 语种配置占用（ADR 只增不改）。因此记忆落 **0020**，字幕时序落 **0021**。

## 背景

`memory` 是五个模块里唯一还没有代码的模块。当前状态（本轮改动前）：

- `src/main/orchestrator/prompt.ts` 的段 ③ 恒定输出 `记忆片段：（无）`；
- `orchestrator` 依赖里只有 `memoryFacts?: (query) => string[]` 这个**占位注入点**，没有任何调用方实现它；
- `data/lines.json` / 角色卡之外没有任何持久化，重启即忘。

本轮要做到三件事（验收标准）：

1. 聊完重启，问之前内容能检索成功并注入段 ③；
2. 检索在主线程**同步**完成且耗时 ≤ 50ms，写入不得阻塞 TTS 下发；
3. 存库在 `data/memory.db`，且**不引入向量库 / Embedding 服务 / 任何计费依赖**。

第 3 条直接排除了"语义检索"这条常见路线：§10.1 `$5` 与 §13 `X-5` 已把向量检索写成红线。所以检索必须是**字面关键词**命中，这决定了 schema 与查询策略的核心选型。

另一个必须在这里定下来的是**运行时 ABI**问题：`memory` 跑在 Electron 主进程（Node 20.18 / ABI 130），而单测跑在宿主 Node（24.x / ABI 137）。原生模块 `better-sqlite3` 是 ABI 相关的，同一个 `.node` 文件不可能同时被两者加载。这个约束影响了"怎么测"（见 D9）。

## 决策

### D1 存储引擎：`better-sqlite3`（同步、单文件、WAL）

`better-sqlite3` 是契约 §3.1 已经写明的选型（"`memory` | main | `better-sqlite3` 同步访问单文件库"），本轮落地它，不换实现。理由：

| 需求 | `better-sqlite3` | 说明 |
|---|---|---|
| 同步 API | `db.prepare().get()/run()` 全同步 | 契约 §7.5 要求 `retrieve` / `write` 同步；异步封装会把 50ms 预算换成事件循环抖动 |
| 零计费 | 无网络、无后台线程 | 只有本地文件 IO |
| FTS5 | 自带（SQLite 3.50.4，含 `trigram` / `unicode61`） | 实测 `sqlite_version()=3.50.4` |
| WAL | `PRAGMA journal_mode=WAL` | 读不阻塞写，符合"检索随时可发生" |

**安装方式（可复现，写入手册）**：

```powershell
# ABI 必须匹配 Electron 33.4.11（NODE_MODULE_VERSION=130），不是宿主 Node
$env:npm_config_better_sqlite3_binary_host = 'https://registry.npmmirror.com/-/binary/better-sqlite3'
npm install better-sqlite3@12.4.1
cd node_modules\better-sqlite3
node ..\prebuild-install\bin.js --runtime=electron --target=33.4.11 --arch=x64
```

- npm 11 默认**不执行**依赖的 install 脚本（`allow-scripts` 策略），所以 `prebuild-install` 必须显式跑一次；否则 `build/Release/better_sqlite3.node` 不存在，`init()` 抛错后整体降级为 `disabled`。
- 构建期只下载**预编译二进制**（prebuild），不调用 node-gyp、不需要 MSVC；运行期零网络（§10.1 `$1`/`$3` 不受影响）。
- ABI 不匹配的典型症状是 `init()` 抛 `NODE_MODULE_VERSION ... requires ...`；日志里会带 `mode=disabled` 与原始错误。

**连接与 PRAGMA**（`init()` 内一次设置）：

```sql
PRAGMA journal_mode = WAL;     -- 返回值必须是 'wal'，否则记 WARN
PRAGMA synchronous = NORMAL;   -- WAL 下的常规取舍：崩溃丢最后若干事务，不损坏库
PRAGMA busy_timeout = 2000;    -- 并发读者/写者不立刻 SQLITE_BUSY
PRAGMA foreign_keys = ON;      -- 目前无外键，保留为后续迁移的默认
```

### D2 Schema：`memories` 单表 + `user_version` 迁移

```sql
CREATE TABLE memories (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,                 -- epoch ms，写入时刻（可被 MemoryWrite.at 覆盖）
  kind    TEXT    NOT NULL CHECK (kind IN ('user','pet','system')),
  text    TEXT    NOT NULL,
  tags    TEXT    NOT NULL DEFAULT '[]',    -- JSON 数组字符串，例如 ["like:咖啡"]
  ref_id  TEXT                              -- 可空：utteranceId / replyId，用于追溯一轮对话
);
CREATE INDEX idx_memories_at ON memories(at DESC, id DESC);
```

| 字段 | 类型 | 语义 | 为什么需要 |
|---|---|---|---|
| `id` | INTEGER PK | 自增主键，`MemoryFact.id` | 候选集合并与去重都靠它 |
| `at` | INTEGER | 写入时刻（epoch **ms**） | 排序的第二个维度（"时间新近次之"） |
| `kind` | TEXT | `user` / `pet` / `system` | 段 ③ 里区分"用户说过"与"自己说过"；`system` 预留给 §10.3 的云端调用审计 |
| `text` | TEXT | 原文（≤ 2000 字，超长截断） | 检索与展示的唯一依据 |
| `tags` | TEXT | JSON 数组字符串 | 事实标签（D6）；用 JSON 而不是逗号分隔，避免标签含逗号时不可解析 |
| `ref_id` | TEXT | 关联 `utteranceId` / `replyId` | 契约 `MemoryFact` 不暴露它；需要时用 SQL 直查，方便排查"这句话是谁写的" |

**迁移策略**：`PRAGMA user_version` 是唯一版本号，迁移脚本是按版本号排列的数组：

```ts
// src/main/memory/schema.ts
export const MIGRATIONS: Migration[] = [
  { version: 1, up: [ /* 上面的 CREATE TABLE / CREATE INDEX */ ] },
];
```

- `init()` 读 `user_version`，**逐个**执行 `version > current` 的迁移，每个迁移包在一个事务里，成功后 `PRAGMA user_version = <version>`；
- 迁移只增不改：已发布的迁移语句不得修改（改了就与旧库不一致），要变结构就追加 `version: 2`；
- 迁移失败 → 事务回滚 → `init()` 抛错 → 降级（D7）。**不允许**"半迁移"的库继续用；
- FTS 表与触发器**不在迁移里**：它们是"可选能力"（D3），在迁移之外单独 `ensureFts()`，失败只关掉 FTS，不影响主表。

### D3 FTS5 `trigram` + 短词 `LIKE` 降级

**核心问题**：中日文没有空格，`unicode61` 会把 `今日はいい天気ですね` 当成**一个 token**，查 `天気` 命中 0 条（本轮实测确认）。因此分词器选 FTS5 内建的 `trigram`（SQLite ≥ 3.34，本机 3.50.4）：

```sql
CREATE VIRTUAL TABLE memories_fts USING fts5(
  text, tags,
  content='memories', content_rowid='id',
  tokenize='trigram'
);
```

`trigram` 做的是**子串**索引（三元组），天然适配中文/日文/英文混排，不需要外部词典。

**它的硬限制**：查询词 **< 3 个字符**（如 `咖啡`、`好き`、`天気`）一个都匹配不到（实测：`MATCH '"咖啡"'` 返回 0 行）。这在中文里是常态，所以必须配降级：

| 查询词长度 | 路径 | SQL |
|---|---|---|
| ≥ 3 字符 | FTS5 | `SELECT rowid FROM memories_fts WHERE memories_fts MATCH ? LIMIT ?`（`?"咖啡" OR "..."?` 转成短语并 `OR` 起来） |
| 1–2 字符 | LIKE | `SELECT id FROM memories WHERE text LIKE ? ESCAPE '\' OR tags LIKE ? ESCAPE '\' LIMIT ?` |
| FTS 建不起来（老 SQLite / 编译期没开 FTS5） | 全部走 LIKE | 同上，并对每个词都做一次 |

- 触发器保持内容表与 FTS 一致（`AFTER INSERT/DELETE/UPDATE` 三条，标准 external-content 写法）；
- FTS 表**首次创建**时执行一次 `INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`，把已有行灌进索引（升级场景）；
- 查询词转义：LIKE 里的 `%` `_` `\` 全部反斜杠转义；FTS 里的 `"` 双写。**绝不把用户输入直接拼进 SQL**（参数化 + 只拼"已转义的短语字面量"）。

### D4 检索流程（`retrieve`）

```text
retrieve(query, limit = 5):
  1. 清洗 query：trim → 空则返回 []
  2. 切词：按"非字母/非数字/非汉字假名"切成词条，去重、小写、长度 1..24、最多 8 个
  3. 长词（≥3）走 FTS，短词走 LIKE，各自带 LIMIT 80 收集候选 id
  4. 按 id 取整行（IN 查询）
  5. 打分：命中词条数 hits（text + tags 的子串命中，大小写不敏感）
  6. 排序：hits DESC → at DESC → id DESC
  7. 截取 limit，返回 MemoryFact[]（带 score = hits）
```

- `limit` 默认 **5**、上限 **20**（契约 §7.5），越界钳制而不是报错；
- 候选上限（80）保证最坏情况仍是有限次索引/行读取，把 50ms 预算锁在可推算的范围内；
- LIKE 是**逐词全表扫**，因此 LIKE 词条封顶 4 个（`MEMORY_LIKE_TERM_LIMIT`）：4 × 500 行实测 1–2ms，再多收益很低、最坏耗时会线上升；
- 返回 `[]` 而不是抛错：`memory` 在 `orchestrator` 的调用路径上，任何异常都必须降级为"没有记忆"（§11 精神）。

**延迟证据**（本机 CPU，500 条记忆 + 每条 40 字，见单测）：

| 场景 | 实测 |
|---|---|
| 空库 `retrieve` | < 0.1ms |
| 500 行的 3 词查询（FTS + LIKE 混合） | ≈ 1–3ms |
| 500 行的 2 字查询（纯 LIKE 全扫） | ≈ 2–5ms |

预算 50ms，实测有 10 倍以上余量；单测里有一条"500 行 × 20 次查询平均 ≤ 50ms"的硬断言，防止将来加字段/加索引时静默退化。

### D5 写入时机：`orchestrator` 在**发布之后**用 `setImmediate` 异步写

契约 §6.4 E-5 已经规定"`memory` 不订阅任何事件；所有写入由 `orchestrator` 单点调用 `memory.write()`"。本轮落实为：

```text
respond() → 产出合法 Reply
          → publish(): ① cmd:render-intent ② intent_resolved ③ voice.speak() ④ 历史入环形缓冲
          → setImmediate(() => { write({kind:'user', ...}); write({kind:'pet', ...}) })
```

- **必须异步**：`publish()` 里 `voice.speak()` 是 fire-and-forget，写库虽然只有亚毫秒级，但"TTS 下发不得被写库阻塞"是硬约束，用 `setImmediate` 把它排到当前 tick 之后即可，不需要线程/worker；
- **必须写两条**：`kind='user'`（用户原话，`refId = <utteranceId>#user`）与 `kind='pet'`（这一轮的可朗读文本，`refId = <replyId>#pet`）；顺序固定 user → pet，`at` 相同，靠 `id` 排序保证 user 在前；
- **摸头等合成话语不写**：`userText === null` 的路径（`head_patted` 触发的台词）没有用户输入，写入会污染记忆；跳过并记一条 debug；
- **失败只记日志**：`memory.write()` 内部 `try/catch`，异常写 `lastError` 并 WARN，绝不抛回 `orchestrator`（§7.5 明文要求）；
- 被取消的 `respond` 不发布 → 不写库（与"取消的回复不发声"一致）。

### D6 事实提取：`不喜欢/讨厌/好き/嫌い` → 标签

`MemoryWrite.tags` 可以手传，但`write()` 会**总是**把 `extractFactTags(text)` 并进去（去重、最多 8 个、每个 ≤ 40 字）：

| 模式（中文） | 模式（日文） | 产出标签 |
|---|---|---|
| `我喜欢X` / `我最喜欢X` / `我超喜欢X` / `我爱X` | `Xが好き` / `Xは好き` / `Xのことが好き` | `like:X` |
| `我不喜欢X` / `我讨厌X` / `我讨厌吃X` | `Xが嫌い` / `Xは嫌い` | `dislike:X` |

规则细节：

1. 先匹配**否定**（`不喜欢`/`嫌い`），再匹配肯定，否则"我不喜欢咖啡"会被记成 `like:咖啡`；
2. `X` 取动词后最多 12 个字符，遇到标点（`，。！？、,.!?` 与换行）、`です/ます/だ/よ/ね/から/けど` 等结尾助词即停；
3. 提取结果只是**标签**，不改变 `text`（原文照存）；标签参与检索打分，因此"我喜欢咖啡"之后问"咖啡"能命中；
4. 语言不匹配时不猜（中文模式不匹配日文文本，反之亦然）。

### D7 降级三层

| 层 | 触发 | 行为 | 可观测 |
|---|---|---|---|
| 1 | 文件库打不开（权限/目录/锁） | 自动改用 `:memory:` 同 schema 库：本次会话**可写可检索**，重启即丢 | `mode='memory'` + WARN（含原始错误） |
| 2 | 连 `:memory:` 都失败（原生模块 ABI 不匹配、缺少 .node） | `mode='disabled'`：`retrieve→[]`、`write→no-op` | `mode='disabled'` + ERROR |
| 3 | 单条 `write` / `retrieve` 抛错 | 记 `lastError` 并返回空 | `snapshot().lastError` |

`init()` 只在第 2 层才 reject；`runtime` 仍然 `try/catch` 兜住，绝不因此拒绝启动（记忆不是启动必需项，与 §9.1 ③ 的兜底台词不同）。

### D8 段 ③ 的文本格式

`formatMemoryFacts(facts)`（`prompt.ts`）输出：

```text
记忆片段：
- [10-30] 用户: 我喜欢喝咖啡
- [10-30] 凯伊: ……是这样吗。（我记得您喜欢咖啡）
```

- 只有 `日期 MM-DD`，不输出秒——模型不需要精确时间，秒会让同一句话的 prompt 每次都变，破坏可复现性；
- `kind` 映射：`user→用户`、`pet→凯伊`、`system→系统`；
- 最多 5 条（`MEMORY_RETRIEVE_LIMIT`），单条 ≤ 120 字（超出用 `…` 截断），防止记忆把 system 段撑爆；
- **空/失败 → 段 ③ 恒为 `记忆片段：（无）`**：这条从上一轮就存在，本轮不改文案（既有单测与日志口径都依赖它）。

### D9 测试策略：`memory` 单测跑在 Electron 的 Node 里

原生模块的 ABI 只能匹配一个运行时。本轮的取舍：

- **产品运行时是 Electron 主进程**（ABI 130）→ `.node` 按 Electron 构建；
- `memory.test.ts` 因此**不能用宿主 `node` 跑**（ABI 137，会 `ERR_DLOPEN_FAILED`）；
- 新增 `scripts/run-electron-test.mjs`：以 `ELECTRON_RUN_AS_NODE=1` 启动 Electron，用它的 Node（20.18.3）执行 `dist/tests/memory.test.mjs`；
- `npm test` 末尾追加这一步，其余 21 个测试文件仍用宿主 `node` 跑（它们不碰原生模块）。

好处：单测环境与产品环境**同 ABI、同 Node 大版本**，比"给宿主 Node 单独编一份"更接近真实。代价：`npm test` 多一次 Electron 启动（约 1s），以及"不能用 `node dist/tests/memory.test.mjs` 单独跑"这个坑（写进 MODULE_STATUS 已知坑位）。

### D10 不新增事件、不新增契约接口方法

- `memory` 仍然**不订阅**任何事件（E-5），也没有新事件（§6.5 已明确不设 `memory_written`）；
- 契约 §7.5 的 `init` / `retrieve` / `write` 签名不变，只补内部方法 `close()` 与诊断 `snapshot()`（不跨进程、不进 `RenderState`）；
- `orchestrator` 依赖从 `memoryFacts?: (query) => string[]` 换成 `memory?: MemoryPort`（结构化接口，仍是依赖注入，不改契约）；
- 新增配置项 `PET_MEMORY_DB`（默认 `<dataDir>/memory.db`）与 `PET_MEMORY_DISABLE=1`（逃生口），走既有 `.env` 通道（ADR 0018 D1）。

## 替代方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| `better-sqlite3` + FTS5 trigram + LIKE（本方案） | 同步、零成本、中日子串可查、WAL | 需要 ABI 预编译；要维护"短词走 LIKE" | **是** |
| `node:sqlite`（Node 22.5+ 内建） | 零依赖、不用编原生模块 | Electron 33 = Node 20.18，**没有** `node:sqlite`；要升级 Electron 大版本 | 否 |
| `sql.js`（WASM SQLite） | ABI 无关，宿主 Node 与 Electron 同一份 | 无 WAL（纯内存库，每次提交要整库导出）；FTS5 可用性依构建；丢掉契约已写的 better-sqlite3 选型 | 否 |
| `unicode61` 分词 | 支持前缀/短语 | 中日文整段成一个 token，查子串命中 0（实测） | 否 |
| 只写 LIKE、不建 FTS | 实现最简 | 每次查询全表扫；数据量一涨就破 50ms；§7.5 把 FTS5 列为第一选择 | 否（保留为降级） |
| 用向量/Embedding 做语义检索 | 跨语言、模糊召回强 | 违反 §10.1 `$5` / §13 `X-5`；要么外部计费，要么本地模型体积与 CPU 成本 | 否 |
| 把整段对话历史直接塞进 prompt 当"记忆" | 零实现 | 段 ④ 已有 6 轮环形缓冲；重启即丢，不是记忆 | 否 |
| 写库放在 `voice.speak()` 之前同步执行 | 代码更直白 | 违反"写入不得阻塞 TTS 下发" | 否 |

## 后果

**正面**

- 段 ③ 从恒定"（无）"变成真实注入；重启后仍能按关键词召回（验收标准 2）。
- 检索路径有硬延迟断言（500 行、20 次、平均 ≤ 50ms），退化会被单测抓住。
- 中文/日文短词与长词都有兜底路径；FTS 不可用时整体降级 LIKE，功能不消失。
- 写入异步且自吞异常：TTS 下发的路径上不会因为磁盘问题多出一次失败。
- 单测与产品同 ABI，`NODE_MODULE_VERSION` 类问题在 `npm test` 阶段就暴露，而不是等用户冷启动。

**负面 / 成本**

- 新增一个原生依赖（`better-sqlite3` 12.4.1 + 32 个传递依赖），`npm install` 必须额外跑一次 `prebuild-install`（写进 ADR、手册与 `.env.example` 注释）；缺失时功能降级但应用仍能用。
- 跨语言检索不可用（中文提问查不到日文记忆）：字面匹配的必然结果，接受并写进已知坑位。
- 记忆只增不删，长期运行会缓慢增长；本轮不做压缩/淘汰（无 LTM 清理策略），`memory.db` 加入 `.gitignore`，用户可手动删。
- `trigram` 索引比不建索引占更多磁盘（约为文本的 3 倍量级），对桌宠这种量级可忽略。

**约束**

- 不得引入向量库、Embedding 服务、云端记忆服务（§10.1 `$5`）；不得在检索路径上做任何网络调用。
- `retrieve` 必须同步返回，不得改成 Promise；耗时上限 50ms 是硬指标。
- `write` 必须自吞异常，不得抛给 `orchestrator`；不得同步阻塞 `voice.speak()` 的下发。
- 迁移只增不改；改结构必须追加新 `version`。
- `memory` 不得订阅事件，不得直接调用 `orchestrator` / `voice`（§2.1 单向依赖）。
- 不得把 `ref_id`、`score` 混进契约 `MemoryFact` 的必填字段（`score` 只能可选）。

## 验证（2026-10-30，本机）

| 项 | 结果 |
|---|---|
| 运行时 | Electron 33.4.11 / Node 20.18.3 / ABI **130**；`sqlite_version()=3.50.4` |
| FTS5 | `trigram` 与 `unicode61` 均可建表；`trigram` 2 字查询返回 0（推动 D3 的 LIKE 降级） |
| 原生模块 | `better-sqlite3@12.4.1` 的 `electron-v130-win32-x64` 预编译二进制可加载 |
| 单测 | `memory.test.ts` **21 条全绿**（初始化/迁移幂等、写入、命中、未命中、标签、limit 钳制、排序、持久化、WAL 并发读、失败降级、注入防护、延迟上限） |
| 端到端 | `selftest:speech` 中"写入 → 检索 → 段 ③ 注入"证据见 `logs/pet.log` 的 `记忆检索` 与 `LLM 请求已装配 { memoryFacts: 1 }`；另断言 `lastRetrieve.ms ≤ 50` |
