# ADR 0031：主动性引擎 idle-drive（有预算的"自己找话茬"）

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-11-01 |
| 关联 | 契约 1.10.0 §7.6、§9.1、§9.3；ADR 0030（presence / 段 3.5）、ADR 0020（记忆）、ADR 0021（字幕） |
| 影响模块 | `orchestrator`（新增 `idle-drive.ts`）、`data/lines.json` |

## 背景

1.9.0 里 `orchestrator` 只有两个入口能产出 `Reply`：`user_utterance`（`attachUtteranceHandler`）与
`head_patted`（`handleHeadPatted`）。**没有用户输入时，编排层在进程里"不存在"**——她的"自己找事做"
仅有 `render` 的随机行走（20–40s，ADR 0024），而那只是位移，不产生任何话语。

参考项目 Azalea 用 `while True` 的 brain loop 解决了这件事，代价是每 5–20 秒一次视觉大模型调用
（`pet/ai.py:84-103`、`126-127`）。它还有一个自伤的设计：

```python
SLEEP_TIME += (no_respond_loops // 4) * 5   # pet/ai.py:390
```

`no_respond_loops` 只在用户说话/摸头时归零，于是**静默越久、休眠越长，且没有上限**——
放养一小时后她会开始永久沉默，与"灵魂感"正好相反。本 ADR 要把这个结构拿过来，但把频率改成
**有上下界的显式预算**。

## 决策

### D1：纯函数判定器 `idle-drive.ts`

```ts
evaluateIdleDrive(input: IdleDriveInput): IdleDriveDecision
// { fire, reason, allowLlm, budget, remaining, night, hour }
```

不读时钟（`now` 由调用方传入）、不碰 IO、不起定时器。`orchestrator` 里只有一个 15s 节拍器负责调用它
（`startProactiveTimer()`），因此：

- 全部时间/状态边界都能用假时钟穷举（14 条单测，见 `idle-drive.test.ts`）；
- 现有 19 条 orchestrator 单测**不传 `proactive`** → 一个定时器都不建 → 行为与 1.9.0 完全一致。

**定时器的边界**：这个 15s 节拍器不参与穿透判定、不参与窗口位移，与 §12 的"唯一 16ms 指针轮询器"
不冲突（§12 约束的是指针轮询，不是"进程内不许有任何定时器"）。已在契约 §12 增补一行说明。

### D2：触发条件（全部满足才开口）

判定顺序即优先级（命中即返回，不继续往下看）：

`disabled → busy → no-presence → user-active → user-away → gap → budget → cooldown → ok`

| 条件 | 阈值（`constants.ts`） | 理由 |
|---|---|---|
| 编排层 idle 且 voice 不在播 | — | 不能在说话时再开口（会自我打断） |
| 系统键鼠空闲 > 90s | `PROACTIVE_MIN_USER_IDLE_MS` | 用户正在输入时插嘴是骚扰 |
| 同上 < 5min | `PROACTIVE_MAX_USER_IDLE_MS` | **人大概率离开了**：对空房间说话比不说话更伤 |
| 距上次交互 > 90s | `PROACTIVE_MIN_INTERACTION_GAP_MS` | 刚聊完就自己找话说，像复读机 |
| 每会话 ≤ 12 次（深夜 ≤ 6） | `PROACTIVE_SESSION_BUDGET` | 打扰预算，见 D2.4 |
| 距上次主动 ≥ 10min | `PROACTIVE_COOLDOWN_MS` | 同上 |

#### D2.1 "交互"的定义与 gap 的基准

`respond()` 与 `handleHeadPatted()` 都会刷新 `lastInteractionAt`——**摸头也算交互**。

本会话还没有任何交互时，`gap` 的基准是**用户最后一次输入**（`now - userIdleMs`），
**不是**进程启动时刻。

这条是真机踩出来的（2026-11-01 22:17 的观察运行）：应用在用户已经离开键鼠 **4 分钟**后才启动，
若以 `sessionStartedAt` 为基准，等 `gap` 满 90s 时 `userIdle` 已经 325s → 越过 5 分钟上限 →
**永远判 `user-away`，她一次都不会开口**。日志现场：

```
22:17:17 idle-drive：不开口 {"reason":"gap",       ...}   ← 启动后第 1 拍
22:18:17 idle-drive：不开口 {"reason":"user-away", ...}   ← 之后永久 user-away
```

改成"以最后一次输入为基准"后，两条时间线对齐：`gap` 在无显式交互时恒等于 `userIdleMs`，
于是"用户静了 90s"这件事只由一个时钟决定。反之，若本会话有过交互（说话/摸头），
仍以那次交互为准——那才是"她刚被搭理过"的真实时刻。

#### D2.2 为什么最大空闲是 5 分钟

`userIdleMs` 是"最后一次键鼠输入到现在"。超过 5 分钟，用户有极大概率不在屏幕前。
此时她说的每一句话都**没有听众**，而"没有听众的主动"恰恰是最破坏"她真的在陪你"这件事的。

#### D2.3 读不到就不打扰

`userIdleMs === null`（koffi 缺失 / 调用失败）→ `no-presence` → 永久沉默。
不猜"用户大概在"，因为猜错的代价（打断用户）远高于猜对的收益（说一句话）。

#### D2.4 预算而非计数漂移

`sessionBudget = 12`，深夜（`23:00–07:00`，区间跨零点，必须按环绕比较）减半为 6。
预算耗尽后**不看冷却**直接归因 `budget`——让日志能区分"我还没到点"与"我已经说够了"。

副作用（**已知且接受**）：冷却 10 分钟 > 最大空闲 5 分钟，因此**一次离开最多主动开口一次**。
这不是 bug，是"严格打扰预算"的自然结果；若产品上希望"一次离开能说两三句"，应同时调
`PROACTIVE_COOLDOWN_MS` 与 `PROACTIVE_MAX_USER_IDLE_MS`，不要在代码里偷偷放宽。

### D3：分流——先规则，后 LLM

1. `rules.matchIdle(now)`：`data/lines.json` 里 `match.on === 'idle'` 的条目（本轮新增 4 条日文台词）。
   零推理、零延迟、可被 `cooldownMs` 单独节流。
2. 未命中且预算允许 → 一次 **3s 超时**（`PROACTIVE_LLM_TIMEOUT_MS`）的本地推理。

`on:'idle'` 不是新事件：`idle` 是编排层自己的状态条件，不广播、不跨进程，§6.3 的事件清单没有变化。
`lines.json` 的 `match` 条件类型在 §4.6 里本就允许"关键词 / 事件 / 状态 / 冷却"。

### D4：四条红线（本轮最重要的一节）

#### D4.1 主动路径只有"已健康"时才用 LLM

`llmUsable() = llmHealthChecked && !llmDisabled`。理由：§11 的熔断语义是**用户触发的**。
如果让桌宠自己的后台探测去调用 `health()`，一次空闲时的心血来潮就可能把 LLM 判死，
改变用户后续每一次交互的路由——那是把用户当测试用例。

#### D4.2 LLM 失败 → 完全沉默

主动路径失败**不播兜底、不发 `llm_failed`、不写日志正文**，只记一条 WARN 的 `reason`。
无缘无故冒出一句兜底台词（"……そういうことですか。先生。"）比沉默更毁人设；
而 `llm_failed` 的语义属于"用户说了话但没答上"（§6.3），主动场景下没有这个上下文。

#### D4.3 主动路径的"用户侧"是舞台指示，不是伪造用户话语

```
PROACTIVE_PROMPT_USER = '（いま先生は静かにしています。あなたから短く話しかけてください。説教や質問攻めはしないこと。）'
```

它只作为本次请求的最后一条 user 消息，**不写入历史**、不写 memory.db、不进日志正文。

#### D4.4 主动路径不检索记忆

没有用户查询词，硬造一个只会引入噪声。段 3 恒为「（无）」，段 3.5 照常注入（时间感在主动路径上同样生效）。

#### D4.5 主动推理期间用户开口 → 让位

`respond()` 开头的既有打断序列（abort 在途会话 + `stopSpeaking('interrupt')`）天然覆盖这条：
主动会话被标记 `cancelled`，`proactiveLlm()` 在 `await` 之后发现 `current.cancelled` 就直接返回，
**一个字节都不发**。

### D5：主动话语与"记忆"的三层区分（容易写错，逐条钉死）

| 载体 | 主动话语是否写入 | 原因 |
|---|---|---|
| 对话历史（段 4，内存环形缓冲） | **写**，形态 `{user:'（彼女が自分から話しかけた）', assistant: reply.text}` | 不写的话，下一轮模型不知道自己刚说过什么，会重复同一句话 |
| `memory.db`（长期记忆） | **不写**（`userText: null` → `scheduleMemoryWrite()` 直接返回） | 自言自语不是"发生过的事实"，写进去会污染后续检索 |
| 预算计数器 | **写**（`proactiveCount` / `lastProactiveAt`），仅成功发布时 +1 | 失败不计入预算 |

### D6：开关与测试隔离

`src/main/proactive-config.ts` 的 `resolveProactiveEnabled(env)`：

1. `PET_PROACTIVE_DISABLE=1` → 一律关闭（逃生口）；
2. `PET_SELFTEST=1` → **默认硬关**；
3. `PET_SELFTEST=1` + `PET_SELFTEST_PROACTIVE=1` → 开；
4. 其余 → 开。

为什么自检必须硬关：主链路自检断言了"收尾没有在途语音"（`selftest.ts` 的 `收尾：没有在途语音`）、
对 idle/speaking 两帧做像素差、并把行走压到 1.5–2s。自检期间没有人碰键鼠，
`GetLastInputInfo` 的空闲值会一路涨过 90s——若不硬关，她会**在自检中途随机开口**，
把这三处断言随机打红。

`resolveProactiveEnabled` 刻意不 import Electron，因此能在普通 Node 里单测（5 条）。

## 后果

**正面**：她第一次能在用户沉默时自己开口，且开口是"有理由的"（规则台词 → 从 `lines.json` 读，
可整段替换；LLM 台词 → 带段 3.5 的上下文）。全部零成本、零出站；主链路 119 条断言不受影响。

**负面 / 已知取舍**：

- 一次离开最多主动一次（D2.4）。如果用户希望更"黏人"，需要调阈值而不是改代码。
- 段 3.5 在主动路径上也注入，因此主动请求的 system 段同样不可复现。
- 主动话语会占用"同一时刻最多 1 条在途话语"的槽位（§12）。用户在这 3s 内开口会被优先处理，
  但主动那次推理的算力已经花掉（本地推理，不产生费用）。

## 被否决的备选

| 备选 | 否决理由 |
|---|---|
| 两个模型（决策脑 + 说话脑） | 本机一次推理 1.7–2.6s，双脑会让延迟翻倍；我们的 `Reply` 三字段已隐含分离 |
| 每轮都调用 LLM 决定"要不要说话" | 与 Azalea 的 `SLEEP_TIME` 同构，成本是每 10s 一次推理；我们用纯函数判定替代 |
| 用 `no_respond_loops` 计数的自增休眠 | 无界漂移（见背景），且不可单测 |
| 主动话语走"只出气泡不出声" | 字幕状态机要求 `speech_started` 才显示，无语音时靠 15s failsafe（ADR 0021）；静默气泡 = 15 秒后凭空出现一行字 |
| 主动话语写 `memory.db` | 自言自语会污染长期记忆，且与 ADR 0020 D5"合成话语不写"冲突 |
| 全屏截图/剪贴板作为触发源 | 见 ADR 0030 的否决表 |
