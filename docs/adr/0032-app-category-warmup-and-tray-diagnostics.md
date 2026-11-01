# ADR 0032：前台应用归一化、冷启动预热、托盘诊断

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-11-01 |
| 关联 | 契约 **1.11.0** §4.6、§7.6、§9.3、§11、§12、§15；ADR 0030（presence / 段 3.5）、ADR 0031（idle-drive）、ADR 0018 D3（托盘）、ADR 0028 D6（复用 16ms 轮询器） |
| 影响模块 | `presence`（新增 `app-normalizer`）、`orchestrator`、`shell`；新增 `proactive-stats`（进程内单例） |

## 背景

三件事都是上一轮自己留下的"已知负面项"，本轮一起收掉：

1. **段 3.5 直接把原始窗口标题喂给模型**（ADR 0030「后果 → 负面」里自己承认的那一条）。
   实测标题长这样：`report-final-v3.docx - Word`、`Trending repositories on GitHub today - Google Chrome`、
   `如何治疗失眠 - Google 搜索`。它们只发往本机 `127.0.0.1:11434`，不出网，但：
   - **隐私面不必要地大**：她只需要知道"你在写代码"，不需要知道文件名、搜索词、论文标题；
   - **token 与噪声**：一个 60 字标题占掉段 3.5 近一半预算，而信息量只有"这是什么应用"；
   - **小模型误读**：`main.ts - aa3dpet - Visual Studio Code` 里的 `main.ts` 会让模型去猜项目内容。
2. **冷启动首问撞 8s 预算**（MODULE_STATUS「已知坑位」）：`qwen3:4b` 首次加载约 10s，
   第一句话大概率 `llm_failed{timeout}` → 兜底。健康检查（`/api/tags`）**不加载权重**，所以它救不了这件事。
3. **主动性不可观测**：`snapshot().proactiveCount` 与日志之外，用户看不到"她今天主动说过几次 / 上次为什么没说"。
   MODULE_STATUS 的 TODO 里挂着"主动性的可观测面板"，而托盘是现成的、零新增依赖的落点。

## 决策

### D1：`app-normalizer` —— 标题/类名 → 有限个标准类别

新增 `src/main/presence/app-normalizer.ts`：

```ts
normalizeAppCategory(input: { title?: string; className?: string }): AppCategory
// AppCategory = '' | 'coding' | 'browser' | 'game' | 'meeting' | 'video' | `other: ${string}`
```

- **纯函数**：不读时钟、不碰 Win32、不 import Electron → 能在 Node 里用表格穷举单测（`app-normalizer.test.ts`）。
- **规则表顺序 = 优先级**：`game → video → meeting → coding → browser → other`。理由：
  - `YouTube - Google Chrome` 既是浏览器页面也是"在看视频"，后者对她更有用；
  - 游戏窗口常带 Chromium 内核类名，先认游戏才不会被 `browser` 抢走；
  - `Microsoft Teams - Google Chrome` 同理，会议优先于浏览器。
- **标题匹配与类名匹配分开**：
  - `text` 只匹配**标题**（`cursor\s*$` 这类末尾锚定规则一旦拼上类名就永远不命中——第一版就写错在这里）；
  - `classes` 只做**类名精确匹配**（`CASCADIA_HOSTING_WINDOW_CLASS`、`ConsoleWindowClass`、`UnityWndClass`、`MozillaWindowClass`…）。
- **`Chrome_WidgetWin_1` 绝不出现在任何规则里**：它是 Chromium/Electron 的通用窗口类，
  Chrome / Edge / VSCode / Cursor / Teams / Discord 全是它，用它分类等于随机分类。这条写进了代码注释。
- **降级**：未命中 → `` `other: ${className}` ``（类名是应用自己注册的，不含用户内容）；
  连类名都没有 → `other: unknown`；**没有前台窗口** → `''`（段 3.5 据此整项省略）。
- **归一化发生在采样点**（`presence.ts` 的 `sample()`），不是段 3.5 的拼装点：
  下游拿不到原始标题，类型上就没有"顺手把它塞进提示词"的机会。
- `WorldFacts` **删掉** `foregroundTitle` / `foregroundClass`，只留 `foregroundCategory`。
  `PresenceSnapshot` 仍保留原始标题（诊断日志要用），但它不再是提示词的候选输入。

### D2：段 3.5 的新形态（契约 §9.3 微调）

```
環境: 2026-11-01 21:14 / 先生は 90 秒前まで入力中 / 前面のアプリ: coding / 先生は今、プログラミングに集中している / 前回の会話から 12 分
```

| 分项 | 变化 | 缺项时 |
|---|---|---|
| 前台应用 | `前面のアプリ: {类别}`，类别超 48 字才截断 + `…`（实测只有 `other: <长类名>` 会触发） | 类别为 `''` → 整项省略 |
| 编程提示（**新增**） | 仅当类别是 `coding` 时追加一句 `先生は今、プログラミングに集中している` | 非 coding → 不出现 |

为什么只给 `coding` 加这一句：其它类别（看视频、开会、打游戏）的"别打扰"含义不需要解释，
而"他在写代码"是唯一一种**长时间、不宜被打断、且她完全看得懂**的状态。小模型不会自己从
`前面のアプリ: coding` 推出"现在是专注时间"，多这 12 个字，她才可能选择"不说话"或"轻声说一句"。

**降级顺序**（相对 ADR 0030 D3 的唯一变化是插入"编程提示"）：

`先丢编程提示 → 再截类别 → 再丢上次会话 → 再丢类别 → 再丢输入状态`，时间戳永远保留。

实现上仍是"尾部优先逐个丢弃"：分项数组顺序是
`[输入状态, 应用类别, 编程提示, 上次会话]`，从尾部丢正好是上表顺序，**不需要额外分支**，
同一输入永远产出同一字节串（段 3.5 必须可单测）。

### D3：冷启动 LLM 预热（`isWarmedUp` 状态位）

> **2026-11-01 更新（ADR 0033）**：D3 的**调度方**已被取代——预热不再挂在 idle-drive 的 15s 节拍上，
> 而是搬到独立的**生命周期心跳**（`heartbeat.ts`），并在 `model_ready` 到达时立即触发一次；
> `PET_PROACTIVE_DISABLE=1` 不再影响预热。下文的条件表与 W-1…W-4 四条硬边界**继续有效**，
> 仅"挂在 idle-drive 节拍上"与文末那条"推论"作废。以 ADR 0033 与契约 §7.6 PR-8 为准。

在既有的 idle-drive 15s 节拍上多一个状态位，**不新增定时器**（与 §12 的"唯一 16ms 轮询器"无冲突，理由同 ADR 0031 D1）：

```ts
maybeWarmUp(at, presence)   // tickProactive() 的第一件事，且在 evaluateIdleDrive 之前
```

触发条件（全部满足）：

| 条件 | 值 | 理由 |
|---|---|---|
| 还没成功预热过 | `!llmWarmedUp` | 一次就够 |
| 失败次数未达上限 | `< LLM_WARMUP_MAX_ATTEMPTS`（3） | 不对着一个关掉的 Ollama 每 15s 敲一次 |
| 编排层空闲 | `state === 'idle' && session === null && !voiceBusy` | 不在说话/推理中抢 CPU |
| presence 正常 | `userIdleMs !== null && finite` | 与 idle-drive 的 `no-presence` 同源："读不到就一定不做消耗 CPU 的事" |
| 未熔断 | `!llmDisabled` | 已判死的服务不值得再打 |
| 距上次尝试 ≥ 间隔 | `LLM_WARMUP_RETRY_MS`（60s） | 重试节流 |

请求形态：`POST http://127.0.0.1:11434/api/generate`，
`{ model, prompt: 'hi', stream: false, think: false, options: { num_predict: 1 } }`，
超时 `LLM_WARMUP_TIMEOUT_MS`（60s，买的是**加载**时间，不是推理时间）。

**四条硬边界**（本轮最容易写错的地方，逐条钉死）：

| 编号 | 边界 | 违反后的后果 |
|---|---|---|
| W-1 | **不触发全局锁**：不建 `UtteranceSession`、不置 `thinking`、不碰 `voice` | 用户此刻说话会撞上"在途话语"，打断序列会去取消一次并不存在的对话 |
| W-2 | **不改熔断状态**：成功**不**置 `llmHealthChecked`、失败**不**置 `llmDisabled` | 一次后台预热会改变用户后续每一次交互的路由（ADR 0031 D4.1 的同一理由） |
| W-3 | **不发事件、不播兜底**：成功/失败都只记日志 | `llm_failed` 的语义是"用户说了话但没答上"（§6.3），预热没有这个上下文 |
| W-4 | **不占预算**：不进对话历史、不计入 `proactiveCount`、不写 `memory.db` | 主动性的 12 次预算是"打扰用户"的额度，不是"加载模型"的额度 |

**推论（已知取舍）**：预热挂在 idle-drive 节拍上，因此 **`PET_SELFTEST=1`（主动性硬关）时不预热**，
`PET_PROACTIVE_DISABLE=1` 时也不预热。这是"不新增定时器"的直接代价，换来的是自检期间**零后台推理**
（ADR 0031 D6 的三处时序断言依赖这一点）。

**为什么不用 `/api/tags` 预热**：它只列模型清单，不加载权重——预热等于没做。
**为什么不设 `keep_alive`**：常驻时长交给 Ollama 自己的默认值（当前 5 分钟），
想更长由用户设 `OLLAMA_KEEP_ALIVE`；应用不偷偷改外部服务的资源策略。

### D4：托盘顶部两行只读诊断

菜单固定变成 **2 行只读（`enabled: false`）+ 5 个动作项**：

```
今天主动交互: 3 次
上次未主动原因: budget（本次会话的打扰预算已用完）
──────────────────────────
呼出输入条
吸附到前台窗口（Ctrl+Shift+S）
离开窗口边缘
重新加载桌宠
退出
```

原因文案**保留 idle-drive 的英文原词**（`user-active` / `budget` / `no-presence` …）再跟中文解释：
用户、`snapshot().lastProactiveSkip`、日志三处看到同一个词，排查时不会"菜单说一套、日志说另一套"。
`Record<ProactiveSilenceReason, string>` 是穷举映射——新增取值忘了这里，`tsc` 直接报错。

#### D4.0 判定通过 ≠ 真的开口：补两个"静默"诊断值

`idle-drive` 返回 `ok` 只说明"可以开口"。有两条路径**判定通过、她却一个字都没说**：

| 取值 | 场景 |
|---|---|
| `no-lines` | `lines.json` 没有可用的 `on:'idle'` 台词（冷却中/已被别的入口消费），且 LLM 路径不可用（本会话未健康检查，或已熔断） |
| `llm-failed` | 主动推理真的发出去了，但超时 / 失败 / 输出不合法 → 按 ADR 0031 D4.2 保持沉默 |

若不做区分，托盘会在她**什么都没说**的时候显示"（上次已开口）"——一条会撒谎的诊断。
这两个值**不是** `IdleDriveReason` 的成员：判定器不该知道自己有没有台词，那是分流阶段的事实。
它们是 `ProactiveSilenceReason = IdleDriveReason | 'no-lines' | 'llm-failed'` 的扩充，
只存在于这块诊断内存与托盘菜单里。

用户打断主动推理（让位）时**不写**这两个值：下一拍 idle-drive 会以 `busy`/其它原因覆盖这一行，
"她失败了"不是那一刻的真相——真相是用户开口了。

#### D4.1 数据怎么从 `orchestrator` 到 `shell`（不新增事件、不新增 IPC、不加 setter）

契约把"不新增事件"（N-8 / E-6）与"不加多余 setter"（I-2）都写死了，而 §6.3 的事件清单里
没有"她主动开口了"。三条被否决的路：

| 备选 | 否决理由 |
|---|---|
| 新增 `proactive_fired` 事件 | 直接违反 N-8：新增事件 = 契约 minor + 全模块评审，而这个信息只有一个消费者（托盘） |
| 给 `shell` 加 `setProactiveStats()` | 违反 I-2（多余的 setter），而且把"谁在说话"的知识塞进了 shell |
| 新增 IPC 通道让渲染侧转发 | 违反任务硬约束，且绕了整整一圈跨进程只为一句话 |

采用工程里**已有且被验证过**的手法：进程内单例（`src/main/event-bus.ts` 的 `appBus` 就是它）。
新增 `src/main/proactive-stats.ts`：`resetProactiveStats()` / `publishProactiveStats()` / `readProactiveStats()`。
写方只有 `orchestrator`（每次判定一拍、每次成功开口一次），读方只有 `shell` 的托盘。
它**不是事件、不是 IPC、不改 `RenderState`、不是新的对外接口方法**——只是两个字段的内存。

#### D4.2 "今天"其实是"本进程启动以来"

计数器在内存里，进程启动归零（`runtime.start()` 再显式 `reset` 一次，便于同一进程内重装 runtime）。
不落盘：跨天统计需要新的持久化与清理策略（与 ADR 0020 的记忆库语义也不同），本轮不做。
菜单文案沿用"今天"，但真实语义是"本会话"，**这条差异记在这里与 MODULE_STATUS 的已知坑位里**，
将来要做真·跨天统计时再改文案与存储，不要在代码里偷偷改语义。

#### D4.3 刷新时机：搭 16ms 轮询器，不加定时器

`refreshTrayStats(now)` 挂在既有的 16ms 指针轮询器 `onTick` 上（与 ADR 0028 D6 的吸附跟随同一手法）：

- 读数**变了** → 下一拍（≤16ms）就重建菜单；
- 读数没变 → 每 `TRAY_STATS_REFRESH_MS`（5s）复查一次；
- 重建前先比标签，**文本相同就不碰原生菜单**（`setContextMenu` 会替换句柄，没必要每 5s 做一次）。

第一版写的是"一律 5s 节流"，结果是启动后托盘会显示最长 5 秒的旧读数——而
`orchestrator` 是在 `shell.start()` **之后**才装配的，这个窗口几乎必然被用户看到。改成
"变了立刻刷、没变才 5s 复查"后，自检里也稳定了（不再需要 sleep 等待）。

## 后果

**正面**：

- 提示词里不再出现用户文档名/页面标题/搜索词；段 3.5 从"最长 60 字的标题"变成"最多 8 个字符的类别 + 一句可选提示"，token 更省、噪声更小。
- 冷启动第一句话不必再等模型加载（预热在 15s 节拍内完成），且**完全不触碰**熔断、事件、预算这三处语义。
- 主动性第一次有了面向用户的只读观测点：两次主动之间的"为什么没说"可以直接看菜单，不用翻日志。
- 单测 +25（app-normalizer 6 / llm-client 5 / world 2 / orchestrator 7 / tray-menu 4 / presence 1），全部零网络（`llm-client` 用本地桩）。

**负面 / 已知取舍**：

- 类别是**启发式**：规则表之外的应用一律 `other: <类名>`，模型看到的信息量确实比标题少。
  这是刻意的方向——"少而稳"优于"多而不可控"；要扩类别就改规则表 + 补单测。
- 预热会**占几秒 CPU**（模型加载）。条件里排除了"说话中/推理中"，但**没有**排除"用户正在打字"：
  那会把预热推迟到 90s 空闲之后，等于让第一次对话继续冷启动。宁可花几秒 CPU，也不要第一句等 10s。
- 预热只保证"读进内存"，**不保证常驻**：Ollama 默认 `keep_alive` 5 分钟，闲置后仍会卸载。
- 托盘两行是"本进程"口径（D4.2），且**按钮点不动**（本来就是只读诊断）。
- 段 3.5 的形态变了 → 1.10.0 的"整串逐字断言"必须同步更新（`world.test.ts` 已改）。

## 被否决的备选

| 备选 | 否决理由 |
|---|---|
| 只做"标题截断到前 N 字" | 仍然是用户内容，只是短一点；隐私与噪声问题都没解决 |
| 白名单制（只认已知应用，其余不发） | 用户换个没见过的编辑器，她就完全"看不见你在忙"；`other: <类名>` 保留了可区分性 |
| 用模型自己分类标题 | 每轮多一次推理，与"零成本 + 低延迟"冲突，且结果不可单测 |
| 预热写成独立 `setTimeout` | 多一个定时器、多一种生命周期；挂在既有节拍上还能顺带复用"空闲/在场感"判定 |
| 预热走 `/api/chat` | 会走 §9.2 校验与 `llm_failed`，把"加载模型"混进"用户对话"的语义里 |
| 托盘读 `shell` 自己维护的计数器 | shell 只能从事件得知"她开口了"，而事件里没有"这次是主动"的信息（route 不区分主动/被动） |
| 托盘每 5s 无条件重建菜单 | 实测会不停替换原生菜单句柄；且启动后仍有 5s 的旧读数窗口（见 D4.3 的第一版） |
