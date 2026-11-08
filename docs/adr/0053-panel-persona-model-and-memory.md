# 0053. 控制面板二期：AI 人格（模型切换 / 角色卡热更新）与记忆管理

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-11-06 |
| 决策者 | 项目所有者（"AI 人格和记忆管理这两个页现在只有只读概览。我要能换模型、改角色卡不重启就生效，还要能看见她记住的东西、能删掉某一条、能让她失忆"） |
| 关联 | 契约 §3.5（跨进程通道）、§7.8（控制面板）、§7.5（记忆接口）；ADR 0015（角色卡 / 记忆纪律）、ADR 0020（memory 的 SQLite 实现）、ADR 0032（预热）、ADR 0033（心跳）、ADR 0052（控制面板一期）、§11（失败与降级） |

## 背景

ADR 0052 把面板做成了"参数调校台"，但"AI 人格"和"记忆管理"两页仍然只是只读概览，
页面上明写着"下一轮接入"。真实使用里留下了四个洞：

1. **换模型要改配置再重启**。`PET_LLM_MODEL` 是进程启动时读的，想试 `qwen2.5:7b` 就得关掉应用、
   改 `.env`、再启动——而换模型正是"她说话不好听"时最想做的第一件事。
2. **改人格要重载桌宠**。角色卡（`data/character-card.md`）只在启动时读一次，改完必须
   托盘 → 重新加载桌宠；用户改的往往是一句话，代价却是整个渲染进程重建。
3. **看不见她记住了什么**。记忆库只有"文件大小 / 最后写入"，用户无法确认"她是不是真的记得"，
   也无法删掉一条说错的话。
4. **TTS 是否可用要靠聊天才知道**。GPT-SoVITS 没起来时，表现为"没有声音"，和"参考音频缺失"
   无法区分。

这一轮的约束与一期相同：不改状态机、不改事件白名单、不新增定时器、面板窗口与 preload 不碰
`memory`/`llm` 的内部。区别是这四项都需要**写**：写角色卡、写 `config.json` 的 `llm.model`、
删/清 `memory.db`。写权限必须收在主进程的**一个**地方（面板控制器），并且每一笔写都要有回执。

## 决策

### D1 角色卡：文件读写收进 `character-card.ts`

- 新模块 `src/main/character-card.ts`：`normalizeCardText` / `readCharacterCard` / `writeCharacterCard`，
  并提供 `MINIMAL_CHARACTER_CARD`（原先散在 `runtime.ts` 里的最小身份行，ADR 0015 D1.8 的降级口径）。
- **归一化只有一套**：去 BOM（Windows 记事本会写）、`CRLF`/`CR` → `LF`、去首尾空白；内部空行/缩进保留。
  面板显示的字数与注入 `system` 段的正文因此永远一致（都按码点 `[...text].length` 计，emoji 算 1 个字）。
- **拒绝三类写**：空正文（等于删除人格）、超过 `PANEL_CARD_MAX_CHARS`（每轮 prompt 都会变长）、
  相对路径（避免写到 cwd 的意外位置）。拒绝时原文件不动。
- **原子写**：`character-card.md.tmp` + `rename`，与 `config.json` 同一手法。
- **路径可覆盖**：`PET_CHARACTER_CARD`（绝对路径或相对工程根），默认仍是 `<dataDir>/character-card.md`。
  唯一用途是取证/截图脚本**不写回用户真实人格**，与 `PET_PANEL_CONFIG` 同一先例。
- 启动时 `runtime` 改走 `readCharacterCard()`，读不到仍用最小身份行，不阻断对话。

### D2 角色卡热更新：`orchestrator.replaceCard()`

- `createOrchestrator` 内部的 `card` 从 `deps.card` 变成可变引用，新增**内部**方法
  `replaceCard(text, reason)`：只改下一轮 `buildPrompt` 用的 `system` 段。
- **不重发在途请求、不清空历史轮次**：用户改的是"她是谁"，不是"忘掉刚才的对话"；
  历史保留（`historyTurns` 只增不减），下一轮 prompt 就是新卡。
- 面板的保存顺序固定为「**先写盘 → 再换内存**」：反过来的话，内存里是新人格、文件还是旧的，
  重启后"人格又变回去"会极难排查。写盘成功但运行期未就绪时，面板如实回 "已写入文件，
  本轮未生效（重启后生效）" 并记为失败，不假装成功。
- `orchestrator.snapshot()` 新增 `cardChars`，作为"换内存真的发生了"的可断言事实（取证脚本读它）。

### D3 模型切换：`config.json` 的 `llm.model` 是唯一持久化

- 优先级：`config.json.llm.model`（用户从面板选过）> `PET_LLM_MODEL`（默认值来源）> `qwen3:4b`。
  启动时 `runtime.start()` 读 `config.json`，有合法值就覆盖 `config.llm.model`。
  "没选过"与"选回默认值"的行为一致：写 `null` 时 `llm` 键从文件里**移除**。
- **面板的模型下拉只列 `/api/tags` 里真实存在的模型**（D5 的探测顺便取回了清单）。
  主进程会拒绝不在清单里的模型名（`本地没有这个模型：xxx（先 ollama pull）`）——
  否则用户选一个拼错的名字，下一轮对话会因为首次请求失败直接触发 §11 熔断，体感是"她突然不理我了"。
  清单为空（探测失败）时不拒绝，但只允许合法名字（白名单见下）。
- **模型名白名单**：`[namespace/]name[:tag]` 逐段匹配（`panel-config.ts::isValidModelName`）。
  逐段限制而不是"允许一堆字符"是刻意的：否则一次 `cmd:panel` 就能把 `llm.model` 写成 `http://evil/x`，
  绕过 §10.2 的"只连回环"。
- **运行期切换（`runtime.panel().applyLlmModel`）三件事**：
  1. `createLlmClient({ ...config.llm, model })` 造新客户端；
  2. `orchestrator.replaceLlm(client, 'panel')`：换引用 + **清零 `llmHealthChecked` / `llmDisabled`**——
     §11 的"一次失败即本会话熔断"属于**同一个模型**，换模型必须重新开始，否则换个坏模型会连带把
     好模型判死；
  3. `heartbeat.retarget(client, 'panel')`：换引用 + **清零 `warmedUp` / `attempts` / `lastAttemptAt`**——
     旧模型热过不代表新模型热过，不清零则切完模型首次对话撞冷启动预算，而且心跳永远不会为新模型预热。
- **不打断在途请求**：在途的 `respond` 捕获的是旧 `llm` 引用，用旧模型把这一句说完；
  下一轮才用新模型。用户体感是"换完，接下来那句变了"。
- **写入顺序**：运行期切换成功后才写 `config.json`；写盘失败只影响"重启后是否记住"，
  面板会明说"已生效，但写入 config.json 失败：重启后会回到旧模型"。

### D4 TTS 连通性测试：短预算、固定文案、不播放

- `runtime.panel().testTts()` 用**独立**的短预算客户端（`PANEL_TTS_TEST_FIRST_BYTE_MS` /
  `PANEL_TTS_TEST_TOTAL_MS`）合成 `PANEL_TTS_TEST_TEXT`；真实回复的首字节预算（~30s）不适合一个按钮。
- **不播放、不写记忆、不发事件**：只判断"地址可达 + 参考音频能出声"，回
  `{ ok, enabled, ms, bytes, reason, detail }`；`reason` 取 `disabled`（配置不全）/
  `timeout` / `unavailable` / `error`，`detail` 给可读原因。
- 面板只显示结果，不据此改变任何运行期状态。

### D5 探测扩展：模型清单 + 「在不在」按同一套规则判

- `ollama-probe.ts` 的 `PanelOllamaFacts` 新增 `models: PanelModelOption[]`（name / sizeBytes / modifiedAt）。
  `/api/tags` 返回什么就显示什么，坏字段（`size: "nope"`）降级为 `null`，不丢整个条目。
- `modelPresent` 用 `modelNameMatches()`（与 `llm-client.health()` 同一个函数）判定，`:latest` 等价；
  避免"面板显示在线、对话却熔断"这种两处口径分叉。
- `offline` 的语义拆开：**服务不可达**（`reachable=false`，detail 是 fetch 错误）与
  **服务在线但缺模型**（`reachable=true`、`modelPresent=false`，detail 说清缺哪个）。面板据此显示
  "未连接" / "服务在线 · 缺模型"。
- 新增 `useModel(model)`（切模型后作废旧结论、强制下一次重探）与 `status` 动作的**强制探测**
  （"重新探测"按钮必须立刻有反应，不能被 3s TTL 吞掉）。

### D6 记忆管理：`listRecent` / `deleteById` / `clearAll`

- `memory` 实现新增三个方法：
  - `listRecent(limit)`：时间倒序、`id/at/kind/text/tags`（`MemoryRecord`，不含 `score`）；
  - `deleteById(id)`：返回是否真的删到（面板据此区分"删了"与"已经被删掉"）；
  - `clearAll()`：返回删除行数；FTS 索引随触发器一起清。
- **面板不直接碰 SQLite**：`shell` 不 import `memory`；面板控制器通过注入的
  `runtime.panel()` 读/删/清（`bootstrap` 里 `shell.attachPanelBackend(() => getRuntime()?.panel())`）。
  这样"装配失败时面板仍能打开看配置"这条降级路径才成立，`shell → memory` 的跨层依赖也不存在。
- **清空需要二次确认**：面板首次点击进入 5s 确认窗口；但**主进程把 `confirm === true` 当硬条件**，
  缺了直接拒绝。UI 的两次点击是体验，主进程的校验才是边界。
- 列表默认最近 **20** 条（上限 `PANEL_MEMORY_LIST_LIMIT_MAX`），可按 `limit` 覆盖；
  `limit` 在主进程再夹一次（IPC 载荷不可信）。
- 删除/清空后**立刻**重取列表与条数，不猜"大概删掉了"。

### D7 IPC 与三层校验

- 动作从 5 个扩到 13 个（`shared/panel.ts::PanelAction`）：
  `snapshot` / `status` / `preview` / `save` / `reset` / `card` / `save-card` / `set-model` /
  `tts-test` / `memories` / `memory-delete` / `memory-clear` / `hide`。
  **没有新增通道**：仍是 `cmd:panel` + `cmd:panel-state`（ADR 0052 那五条控制面通道）。
- 三层校验，缺一不可：
  1. preload 白名单（`normalizeAction`）：形状不对直接拒绝，不发起 IPC；
  2. 主进程 sender 白名单：只接受**面板窗口**这一个 `webContents`（与 `cmd:respond` 同一原则）；
  3. 业务校验：模型名白名单、`limit` 夹取、`memory-clear` 必须 `confirm === true`、角色卡非空。
- `hide`（`Esc`）也走 `cmd:panel`：面板窗口只 `hide`，不销毁、不退出，与标题栏关闭同一路径。
- `openControlPanel()` 首次显示后立刻 `runTick(performance.now())`，打开瞬间就有状态，不等 250ms 节拍。

### D8 取证：`panel:shot` 扩到四页

`src/main/panel-shot.ts` 在一期 7 项断言之后追加：

1. AI 人格页：等角色卡加载（`window.__panelDebug.cardText()` 非空）→ 追加一句取证标记 →
   触发 `input` 事件 → 点「保存角色卡」→ 等 `shell.panelDiagnostics().cardSavedAt`；
   断言 `getRuntime().snapshot().orchestrator.cardChars` **变大**、隔离副本文件里**含标记**、
   模型下拉至少 1 项且徽标可读、TTS 卡片给出明确状态；
2. 记忆页：先读一次（条数与"列表为空 ⇔ 空态提示"一致）；再往**隔离**的
   `logs/selftest/memory.db` 种两条 → 刷新 → 截图（列表里有内容）→ 点第一条的「删除」等列表变短 →
   点两次「清空所有记忆」→ 断言 `rows=0` 且空态回来；
3. 截图 `panel-persona.png` / `panel-memory.png`；
4. 还原：`config.json` 写回原内容（或删除），角色卡写回原内容（或删除副本）。

隔离方式：`start.mjs --panel-shot` 在启动前把 `PET_CHARACTER_CARD` 指到
`logs/selftest/character-card.md` 并从用户真实角色卡复制一份过去；把 `PET_MEMORY_DB` 指到
`logs/selftest/memory.db` 并**先删掉旧库（含 WAL/SHM）**。脚本退出后删除/还原副本。
取证因此既不碰用户人格、也不碰用户记忆与配置（用户真实库仍保持 14 行）。

种库为什么由脚本直接开 SQLite：运行时没有"写一条测试记忆"的入口（也不该为取证加一个），
而取证需要**确定**的初始行数。多开一个 WAL 连接写两行，主进程连接立刻可见；
只有 `PET_MEMORY_DB` 指向 `logs/selftest` 时才会走这条路径，否则整个写入取证跳过并记 WARN。

## 替代方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 保持两页只读 | 零新代码 | 用户四个洞全在；改人格/换模型仍要重启 | 否 |
| 换模型后整窗 `reload` / 重启应用 | 实现最省事 | 打断桌宠、丢在播动作与对话历史；不是"切换"是"重启" | 否 |
| 渲染进程自己写角色卡文件 | 少一层 | 渲染侧不该有文件写权限；路径/编码/原子写会分叉 | 否 |
| 面板直接 `import memory` 读写 SQLite | 少一个注入点 | `shell → memory` 跨层；装配失败时面板也打不开 | 否 |
| 模型选择写进 `.env` | 与现有配置一致 | 改 `.env` 要重启；且 `.env` 是部署配置，不是用户设置 | 否 |
| 模型选择写进 `data/memory.db` | 复用 SQLite | 设置不属于记忆；面板要在 SQLite 不可用时仍可用 | 否 |
| 换模型不重置熔断/预热状态 | 少两行 | 坏模型会"污染"好模型；新模型首问撞冷启动预算 | 否 |
| 模型名不做白名单 | 少一段代码 | 一次 IPC 即可把 `llm.model` 写成任意 URL，绕过"只连回环" | 否 |
| 清空记忆只靠 UI 两次点击 | 少一道校验 | IPC 可被伪造；用户误点也需要主进程这一层兜底 | 否 |
| 角色卡保存只写内存 | 简单 | 重启即丢；用户会以为保存了 | 否 |

## 后果

**正面**

- 换模型从"关应用 → 改 `.env` → 启动"变成下拉框一次点击，下一句就用新模型；选择写进
  `config.json`，重启后仍然记得。
- 改人格从"托盘重载桌宠"变成"编辑框 → 保存"，下一轮对话生效，对话历史不丢。
- 记忆终于可见、可删、可清；"她记得我"从猜测变成一屏事实。
- TTS 是否可用从"聊一句试试"变成按钮，且与真实回复的预算语义分开。
- 面板的写权限全部收在主进程控制器一处：`shell` 不碰 `memory`/`llm`，渲染侧/preload 只发形状受限的动作。
- 取证扩展到四页且自还原：一次 `npm run panel:shot` 同时证明"参数到了渲染侧""新人格进了 runtime"
  "记忆列表真的读出来了"。

**负面 / 成本**

- 面板动作从 5 个变成 13 个，`cmd:panel` 的分支与校验面积变大（换来的是三层校验与回执）。
- 换模型会重建 `LlmClient` 并重新预热：切换后的第一次对话仍可能有一次加载延迟（但不再撞 8s 预算）。
- 记忆列表默认 20 条、250ms 状态推送 + 2s 列表节流：极端高频写入时列表会滞后几秒（刻意的节流）。
- `PET_CHARACTER_CARD` 是一个只为取证存在的环境变量；生产路径不设它，行为与之前完全一致。

**约束**

- 不新增事件、`intent`、`emotion`、`RenderState` 字段与 IPC 通道；`cmd:panel` 仍是面板唯一入口。
- 面板**不得**直接读写文件或 SQLite：所有写经 `runtime.panel()`，所有读经推送或动作回执。
- 换模型必须同时重置编排层健康检查与心跳预热状态；缺一即视为回归。
- 角色卡保存必须"先盘后内存"；空卡、超长、相对路径必须被拒绝。
- 清空记忆必须在主进程校验 `confirm === true`；面板取证不得删改用户记忆。

## 验证

- 单测（`npm test` 内）：
  - `character-card.test.ts`（新增 8 条）：归一化（BOM/CRLF/首尾空白/内部保留）、缺失文件不抛、
    码点计数、原子写不留 `.tmp`、空正文拒绝且原文件不动、超长拒绝、相对路径拒绝、最小身份行；
  - `panel-config.test.ts`（10 条）：`llm.model` 读出/写回/非法忽略/`null` 移除 `llm` 键、
    模型名白名单拒绝 URL/空白/超长；
  - `ollama-probe.test.ts`（10 条）：三态、模型清单（含坏字段降级）、`:latest`、TTL、单飞、
    `useModel` 强制重探、`dispose` 丢弃；
  - `heartbeat.test.ts`（新增 1 条）：`retarget` 清零 `warmedUp`/`attempts` 并改调新客户端；
  - `orchestrator.test.ts`（新增 2 条）：`replaceCard` 下一轮 prompt 用新卡且历史不清空；
    `replaceLlm` 清零熔断/健康检查、新客户端重新探活、旧客户端不再被调用。
- 真机取证（`npm run panel:shot`，exit 0）：**14 项断言全过**——
  一期 7 项（渲染侧收到 `-0.12 / 0.85 / 16`、数字框显示、状态页回报、`config.json` 写入三项）
  + 二期 7 项（角色卡保存后 runtime `cardChars` 变大、隔离副本落盘含标记、模型下拉 ≥ 1 项且徽标可读、
  TTS 卡片有明确状态、记忆页条数与空态一致、删除一条后列表变短、两次确认后清空归零）。
  证据：`logs/evidence/panel-hot-update.json`、`panel-physics.png` / `panel-status.png` /
  `panel-persona.png` / `panel-memory.png`。
- 交叉验证：`tsc --noEmit` 0 错；`npm test` 57 个测试文件 / **574** 条全绿（Node 545 + Electron 里的 memory 29）；
  四套自检未受本轮影响（未改状态机/渲染主链路），仍以最近一次记录为准。
