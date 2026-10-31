# 0021. 字幕与语音的时序对齐：`intent_resolved` 只登记、`speech_started` 才显示

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-10-30 |
| 决策者 | 项目所有者 |
| 关联 | `CONTRACTS.md` §3.2 R-1（字幕是唯一 DOM）、§6.3（`speech_started.text`）、§7.3、§8.1、§8.3、§11（TTS 失败行）；ADR 0015 D3（voice 事件唯一生产者）；ADR 0020（同轮的 memory） |

## 背景

当前（本轮改动前）字幕的气泡显示策略写在 `src/renderer/render/main.ts`：

```ts
if (event.name === 'intent_resolved') subtitle.show(payload.text); // 收到就显示，停留 6s
```

而两个环节的耗时差一个数量级：

| 环节 | 实测耗时 | 发生时刻 |
|---|---|---|
| LLM 出文本（`qwen3:4b`，真机） | 1.3–2.6s（冷启动可到 10s） | `intent_resolved` 之前 |
| TTS 合成（GPT-SoVITS v2ProPlus，CPU 非流式） | **4.2–6.2s** | `intent_resolved` 之后、`speech_started` 之前 |
| 播放 | 1.2–3.4s | `speech_started` 起 |

结果就是用户先看到整句话，再等 5–6 秒才听到声音——"先看字后听音"（验收里明确要求修掉）。

同时还有两个隐藏问题：

1. **字幕只停留 6s**：日文长句播放可能超过 6s，会出现"声音还在播、字已经没了"；本轮切日文后句子普遍变长，这个错位会更明显。
2. **`speech_ended{failed}` 之后没有兜底**：TTS 未配置/失败时，字幕已经在 6s 前显示过，用户可能已经看不到它（§11 要求"字幕气泡显示文本"是可读输出的唯一保证）。

## 决策

### D1 `intent_resolved` 只登记待显示文本，**不显示**

```ts
onIntentResolved(text) → pending = text; 不调用 show()
```

待显示文本（`pending`）是渲染侧的**内部状态**，不进 `RenderState`、不跨进程、不新增事件。

若新回复到达时上一条字幕**仍挂在屏幕上**（例如上一句的 1.2s 尾巴还没结束），先收起旧文本再登记新文本：旧回复已经结束，让它继续停在屏幕上会与新语音错位。

### D2 `speech_started` 显示完整字幕

`speech_started` 的载荷本来就带 `text`（§6.3），所以字幕不依赖 `pending` 也能显示：

```ts
onSpeechStarted({ text }) → show(text ?? pending, 无限停留)
```

同一帧里"首帧音频开始播放"与"字幕出现"对齐——这就是验收里的"字幕与声音同步出现"。

### D3 `speech_ended{failed}` 立即显示字幕作为兜底

```ts
onSpeechEnded({ reason }) → reason === 'failed' ? show(pending, 6s) : 不显示
```

TTS 未配置（参考音频/提示文本缺失）时 `voice.speak()` 会**立刻**发 `speech_ended{failed}`，因此这条路径上字幕几乎无延迟地出现（§11 的"TTS 未配置 → 字幕气泡显示文本"由此保证）。

### D4 可见期 = 语音期 + 1.2s 尾巴

`speech_started` 时用 **`holdMs = null`**（不自动隐藏）；`speech_ended{completed|interrupted}` 时再补一次 `holdFor(SUBTITLE_TAIL_MS = 1200)`。

- 播放期间字幕**一定**在（不会 6s 提前消失）；
- 说完留 1.2s 让用户读完，再淡出（`SUBTITLE_FADE_MS = 180`）；
- 兜底路径（D3）与 failsafe 路径（D6）仍用 `SUBTITLE_HOLD_MS = 6000`（没有语音可对齐，只能按时间停留）。

**残余风险（不声称解决）**：如果 `speech_ended` 永远不来（渲染进程崩溃、voice 会话挂住），字幕会一直停留到下一次 `intent_resolved`。用户提示 `pointer-events:none`，不挡点击；下一次回复会替换它。不为此加看门狗（与 ADR 0015 D3 不加看门狗同一取舍）。

### D5 打断：丢弃 `pending`，不显示

`speech_ended{interrupted}` 只可能来自"新话语打断旧语音"或 `stopSpeaking`。此时旧回复已经被取代：

- 若 `pending` 还在（旧回复的字幕还没显示），**丢弃**，不显示；
- 新回复的 `intent_resolved` 会写入新的 `pending`。

这保证"被打断的旧回复不会突然冒出一行字，而新回复还没开口"。

### D6 failsafe：15s 还没等到 `speech_started` 就显示

`intent_resolved` 之后启动一个 15s 的定时器（`SUBTITLE_PENDING_FAILSAFE_MS`），到点仍未收到 `speech_started` 且 `pending` 非空 → 按 6s 停留显示。

为什么需要它：本机 `PET_TTS_TOTAL_TIMEOUT_MS = 120000`（CPU 非流式的现实取舍，ADR 0015 D2.5）。如果 TTS 服务卡死，没有 failsafe 就是"最长 2 分钟什么都没有"。15s 大于本机实测合成时间（4.2–6.2s），不会干扰正常同步；触发即说明链路异常，此时宁可早一点给文本。

`speech_started` 或 `speech_ended` 到达时取消定时器；定时器回调本身不清 `pending`（随后真到达的 `speech_started` 会用同一文本再 `show` 一次，刷新停留时间，无副作用）。

### D7 实现位置：渲染侧纯逻辑模块，可单测

新增 `src/renderer/shell/subtitle-cue.ts`：

```ts
createSubtitleCue({ show, hide, holdFor, schedule, cancel, now? }): SubtitleCue
```

- **不碰 DOM、不读全局定时器**：`show` / `hide` / `holdFor` / `schedule` / `cancel` 全部由调用方注入，因此可以在 Node 里用假定时器单测（`subtitle-cue.test.ts`）；
- `src/renderer/render/main.ts` 只做接线：把 `intent_resolved` / `speech_started` / `speech_ended` 三条事件转给 cue，并把它绑定到真实 `subtitle`；
- `subtitle.ts` 的 `show(text, holdMs)` 扩一个 `holdMs: number | null`（`null` = 不自动隐藏）与 `holdFor(ms)`（重排隐藏定时器，不可见时为空操作）。

**为什么不在主进程做**：字幕是渲染侧唯一的 DOM（§3.2 R-1），主进程没有"显示/隐藏"的能力；新增 IPC 通道会被 §3.5 / §6.3 的封闭清单挡住。渲染侧本来就同时收到 `intent_resolved` 与 `speech_*`（`evt:broadcast`），三条事件在同一进程内，时序最准。

### D8 不新增事件、不新增通道、不改 voice

- 事件清单（§6.3）不变：`speech_started` 早就有 `text` 字段；
- 无新 IPC 通道；
- `voice` 不知道字幕存在，`orchestrator` 也不改；
- 契约侧只是把"字幕何时显示"从隐含行为写成显式规则（§7.3 / §8.1），属 minor。

## 替代方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 收到 `intent_resolved` 就显示（现状） | 最简单；文本立刻可读 | 与语音错位 5–6s，正是本轮要修的问题 | 否 |
| 主进程等到 `speech_started` 再发一个新事件（如 `subtitle_show`） | 时序集中在一处 | 新事件 = 契约 minor + ADR + 渲染侧仍要订阅；现有 `speech_started` 已经够用 | 否 |
| 让 `intent_resolved` 延后到语音开始再发 | 一个事件解决 | `intent_resolved` 还负责 `emotion`（render 的表情基线），延后会让表情也晚 5–6s；且它的事实语义会变 | 否 |
| 字幕按音频包络逐字显示（卡拉 OK） | 更"同步" | 需要逐字时间戳，TTS 只给整段 WAV；渲染侧只能按包络猜，做不到字级对齐 | 否（列入未来） |
| 只做 D1/D2，不要 failsafe | 少一个定时器 | TTS 卡死时最长 2 分钟无文本 | 否 |
| 把可见期固定 6s（现状不动） | 无改动 | 日文长句播放超 6s 就"声音还在、字没了" | 否 |
| 在 `voice` 里插入 `speech_about_to_start` 事件 | 更早显示 | 新事件 + 仍然不是"真的开始"；且 `speech_started` 已经是"同一帧"语义 | 否 |

## 后果

**正面**

- 字幕与声音在同一帧出现（验收标准 1 的"同步"）。
- 播放期间字幕不会提前消失；说完留 1.2s 尾巴。
- TTS 不可用时字幕仍会出现（D3 兜底，§11）。
- TTS 卡死时有 15s failsafe，不再"最长 2 分钟什么都没有"。
- 时序逻辑是纯函数 + 注入定时器，5 类场景都有单测（不依赖真实 TTS）。

**负面 / 成本**

- 多一个内部模块与 3 个常量（`SUBTITLE_TAIL_MS` / `SUBTITLE_PENDING_FAILSAFE_MS` / `subtitle.holdFor`）。
- 合成期间（4–6s）屏幕上"什么都没有"：这是与语音对齐的必然代价；对比之前"先看字后听音"是更好的取舍。
- `speech_ended` 缺失时字幕可能长期停留（D4 残余风险，接受）。
- 自检里"字幕在 `intent_resolved` 后立刻可见"的旧断言必须改成"`speech_started` 后可见 / `failed` 后兜底可见"，否则会假失败。

**约束**

- 不得在 `intent_resolved` 里显示完整字幕（本轮起这是契约行为）。
- 不得为字幕新增事件或 IPC 通道。
- `subtitle` 元素必须保持 `pointer-events: none`，不得参与命中判定（§3.2 R-1）。
- failsafe 的 15s 必须是常量（`shared/constants.ts`），不得散落在渲染页。

## 验证（2026-10-30，本机）

| 项 | 结果 |
|---|---|
| 单测 | `subtitle-cue.test.ts` **13 条全绿**（未提前显示 / started 显示 / started 缺 text 用 pending / failed 兜底 / 已可见只续期 / completed 只补尾巴 / 打断丢弃 / failsafe 触发 / failsafe 后 started 刷新 / 新回复收起旧文本 / 空文本 / dispose 不泄漏定时器 / 缺载荷不抛） |
| 自检（语音套件） | 桩把 TTS 响应延迟 500ms，断言 `intent_resolved` 后字幕**不可见**、`speech_started` 后**可见**（`SLOWTTS` 标记） |
| 自检（降级套件） | TTS 未配置 → `speech_ended{failed}` 后字幕可见（既有断言保留） |
| 截图 | 说话中 `dist/selftest/window-speech.png` 含字幕文本 |
