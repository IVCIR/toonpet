# 0039. 摸头反应改为纯官方片段；拖拽与摸头严格互斥

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-11-03 |
| 决策者 | 项目所有者 |
| 关联 | 契约 §3.4（D-2/D-3/D-4/D-6）、§4.1（`dragged` / `settling` / `reacting`）、§4.4（`pat_react`）、§5.2（身体/表情通道）、§5.3（必测组合）、§7.3（render 订阅）、§11；ADR 0004（手势判定归属）、ADR 0014 D6（程序化摸头，**本 ADR 取代**）、ADR 0023 D4（官方片段接线，摸头部分**本 ADR 修订**）、ADR 0024（回弹）、ADR 0035（拖拽姿态） |

## 背景

两个现象，项目所有者实机确认：

1. **摸头观感生硬**。当前摸头是"程序化三通道合成"：头骨 pitch `-0.3rad` + roll `0.08rad` + `animationRoot.rotation.z` 前倾 `0.05rad`，按 `sin(πp)` 包络一次性叠加（`pat-react.ts`）。它没有重心转移、没有布料/头发跟随，读起来就是"上半身被压了一下"。
   ADR 0023 D4 已经把**非说话**时的摸头换成官方片段（`Cafe_Reaction` 3.5–6.6s），但仍保留了"说话时退回程序化"的分支；也就是说程序化摸头**没有消失**，只是被藏到了 `speaking` 分支里。
2. **拖拽结束后会冒出摸头反应**。根因不在"4px 判定"本身（`drag-gesture.ts` 的阈值与冷却是对的），而在**两个状态在时间上重叠**：
   - `hfsm.dragStarted()` 只改 `physics`，**不清 `reaction`**；
   - `hfsm.dragReleased()` 同样不清；
   - `render.handleIntent('pat_react')` 只拒绝 `settling`，不拒绝 `dragged`；
   - 因此"摸头 → 编排层（异步）回一条 `intent=pat_react` 的回复 → 用户已经开始拖"这条链路会把一个 `reacting` 塞进 `dragged` 里，并在松手后继续存在（`patState()` 只看 `reaction`，不看 `physics`）。表现就是"拖完她还在缩着"。

## 决策

### D1 摸头只有一个来源：官方片段

`clip-bank.ts` 的 `pat` 角色改为 **`CH0335_Victory_Start_Random` 的 0.3–2.4s**（2.1s）。

选择依据来自 `tools/clip-preview` 的全量普查（44 段逐段按 0.2s 采样骨骼事实：身高代理、手到头的距离、头骨 pitch/roll、脚底高度），再用胶片条逐帧目视确认。结论：

| 候选 | 事实 | 结论 |
|---|---|---|
| `Cafe_Reaction` 3.2–6.4s | 缩身 + 双手抱在胸前；**没有回正段**，剪到哪都停在含胸姿态，淡回 Idle 时手会突然放下 | 只作 `greet`（0–2.2s），不再作摸头 |
| `Cafe_Reaction` 9.0–10.0s | 鞠躬；缩身比 0.18，但幅度来自"弯腰"不是"缩一下" | 否 |
| `Formation_Pickup` 0.2s+ | 被拎起的垂姿（缩身 0.27） | 已是 `held`，不重复使用 |
| `Victory_Start_Random` 0.4–2.2s | **完整闭环**：站姿（0–0.4）→ 0.4–0.8 快速缩身抱手低头（缩身 0.13–0.16、头 pitch −0.13）→ 0.8–2.0 保持害羞 → 2.0–2.2 抬头回正 | **是** |
| `Victory_Start_interaction_01` | 起手是腾空/翻滚的过场（首帧脚底高度差 0.3 单位），带镜头/根位移 | 否（过场片段不进桌宠） |
| `my_event088_pastmemory_01` 17–20s | 大角度低头/下沉，但是回忆过场且伴随根位移 | 否 |

`Victory_Start_Random` 的武器/道具由 `HIDE_ATTACHMENTS`（`weapon|prop|brush|outline`）隐藏，画面上只有她本人；脚底高度在整段内只变化 0.01 单位（≈7px 窗口内），不需要额外补偿。

### D2 程序化摸头整体删除（不是"降级保留"）

删除 `src/renderer/render/pat-react.ts` 与其单测，并删掉 `render-module.ts` 里所有摸头专用的骨骼/根变换：

- 头骨 `pitch/roll` 叠加（`arbiter.add(head, 0, pat.pose.headPitch, pat.pose.headRoll)`）；
- `animationRoot.rotation.z` 的 `bodyLean` 项；
- `PatPose` / `patPose()` / `patEnvelope()` / `patWeight()` / `PAT_*` 常量；
- 嘴层仲裁里的 `'pat'` 归属（摸头的"shy 嘴型帧"改为走 `emotion=shy` 的官方差分，见 D3）。

**不再有任何为摸头服务的 `scale` / `squash` / 骨骼压扁代码。** 落地缓冲（`landing.ts`，ADR 0035 D4）与惊跳（`startle.ts`）是拖拽/吸附的表现，不属于摸头，保持原样。

顺带把 `nod` 的"整身 `scale.y` 压扁 6%"换成"头骨低头 0.26rad + 颈骨 0.35 倍"（走 `BoneArbiter`，符号按 ADR 0035 D5 的标定：`pitch > 0 = 低头`）。理由是同一个"生硬压缩"：`scale.y` 会连脚底一起缩，读起来像"被按了一下"；而 `nod` 恰恰是兜底台词最常带的 intent（`fb-ack`），出现频率比摸头更高。改完 `REACTIONS` 里再无 `squash` 字段，`animationRoot.scale` 只剩落地与惊跳两处来源。

### D3 摸头的表情投影改为"临时 `shy`"，走官方差分

原来摸头单独切图集第 4 帧（`PAT_MOUTH_FRAME`）。本轮起：

- 摸头期间 `effective emotion` 投影为 `shy`（§4.5 已有定义），眼型/嘴型/红晕全部来自 `data/expressions/` 的官方差分（ADR 0026 D6）；
- 嘴层仲裁退化为 **口型 > 表情 > 静态闭嘴**（`MouthOwner` 去掉 `'pat'`），`speaking` 时口型仍最高优先；
- 差分缺失 → 只变嘴型、保持默认眼，动作照常（§11 既有降级行）。

### D4 身体片段只在"站着的 idle"播；其余场景只做表情

官方片段是整身替换（ADR 0023 D2），一旦播就会接管身体通道。因此：

| 场景 | 身体通道 | 表情通道 |
|---|---|---|
| Base=`idle`、无 Physics、不在说话 | 播 `pat` 官方片段（0.3–2.4s） | 临时 `shy` |
| `speaking` | **不动**（不切动作、不叠加任何骨骼偏移） | 临时 `shy`（口型仍最高优先） |
| Base=`walking` | **不动**（走路继续） | 临时 `shy` |
| `sitting` | **不动**（坐姿停帧不变） | 临时 `shy` |
| `dragged` / `settling` | **拒绝**（不切动作、不建 reaction） | 不变 |
| 片段缺失 | 不动 | 临时 `shy`（记一条 WARN） |

理由：§5.3 要求"说话/行走/坐着被摸头时**不整体切换**反应动画"。既然程序化通道被删了，"不整体切换"就退化为"身体不动、表情照应"——这是唯一不做假动作的实现方式，也比原来"0.4 权重的手写骨骼"更诚实。

### D5 `dragged` 是摸头的硬边界（严格互斥）

三层同时收紧，任一层生效都能挡住：

1. **HFSM（`hfsm.ts`）**：`dragStarted()` 与 `dragReleased()` 都**清空 `reaction`**；`headPatted()` / `intent()` 在 `physics ∈ {dragged, settling}` 时直接返回（不再只挡 `settling`）。
2. **render**：`patActive()` 只在"没有 Physics 接管"或 `sitting` 时为真；`drag_started` 到达时先 `cancelOneShot()` 再切悬空动作，确保官方摸头片段不会跟着拖拽一起活下来。
3. **shell（`drag-gesture.ts` / `pointer-poller.ts`）**：
   - 每次接受 `pointerdown` 才重新武装摸头（`patArmed = true`），**任何一次进入拖拽都把它置 false**（"直到下一次全新的 `pointerdown`"），此后到抬手都不恢复；
   - `onPointerUp` 增加一条独立判据：**按下期间窗口位置变过 → 这次按下不是"干净的点一下"**（`originWindow` 与当前 `contentBounds` 之差 > 0.5px）。它**只压制摸头、不伪造拖拽**——否则回弹期的一次轻点会发出 `drag_started`，把她从刚落地的状态又拎起来；
   - 轮询器在 `settling`（500ms 沉降窗口）或 `isSettling()`（真实回弹）期间**丢弃** `head-patted` 效果并记一条 WARN。

> 副产物（已知，写进坑位）：窗口正在移动时（回弹 / 行走 / 吸附跟随）的轻点都不再判摸头。
> 其中"行走时被摸头"在 ADR 0024 引入窗口位移后**本来就是不可达的**——窗口在按下期间移动
> 会把"屏幕位移"顶过 4px，旧实现会把它判成拖拽。要让移动中的目标也能被摸头，必须让
> D-3 的距离排除窗口自身位移（要求 `cmd:drag` 携带窗口位移，或把 motion 状态喂给判定），
> 属于契约变更，本轮不做。

`intent('pat_react')` 的语义收窄：它是"伴随台词的动作命令"，若此时摸头反应已经在播（`head_patted` 先到），**不得重启或截短**它；若 `physics` 非空则丢弃。

### D6 不新增任何契约实体

- 不新增状态名、事件名、`intent`、`emotion`、IPC 通道、`RenderState` 字段；
- `PatDiagnostics`（内部诊断）改为 `{ active, body, clip, blockedBy }`，仍不进 `RenderState`；
- 契约 §5.3 的三行（说话/行走/吸附时被摸头）与 §3.4 的 D-2/D-3 措辞同步为"D5/D4 的口径"，属 minor（1.16.0）。

## 替代方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 保留程序化摸头，只调参数 | 改动最小 | 观感上限就是"手写骨骼"，用户已否决 | 否 |
| 说话时也播整身官方片段 | 表现统一 | 违反 §5.3"不整体切换"；会打断走路/坐姿 | 否 |
| 说话时按 ≤0.4 权重叠加第二个整身 action | 字面满足"≤0.4 权重" | 两条整身 action 混合同一骨骼，H-2 禁止 Overlay 嵌套；拖拽/坐姿会互相抢通道 | 否 |
| 继续用 `Cafe_Reaction` 3.5–6.6s | 不用改表 | 片段没有回正段，结束必然"手突然放下" | 否 |
| 摸头反应期间也允许拖拽打断（不清 reaction） | 少两行代码 | 就是本轮要修的 bug | 否 |
| **官方闭环片段 + 表情投影 + 三层互斥（本方案）** | 摸头是官方演出；拖拽与摸头在状态层不可能重叠 | 说话/走路/坐着时只有表情反应，观感偏静 | **是** |

## 后果

**正面**

- 摸头是官方整身演出（缩身 → 保持 → 抬头回正），不再有手写骨骼的"压一下"。
- 44 段里"正面 + 可闭环"的非战斗动作被完整利用：`idle` / `idle.alt1` / `held` / `walk` / `sit` / `pat` / `greet` / `happy` / `victory`。
- 拖拽与摸头在 HFSM、render、shell 三层都不可能出现重叠；"拖完还在缩着"从根上消失。
- 删除一个源文件与一个单测文件，代码量净减少。

**负面 / 成本**

- 说话/走路/坐着时被摸头**只有表情**（没有身体反应），比原来更"安静"；这是 §5.3 的直接后果，写进已知坑位。
- `Victory_Start_Random` 的裁剪窗口（0.3–2.4s）是针对 CH0335 标定的，换模型要重标（ADR 0023 的既有成本）。
- 摸头片段 2.1s 仍长于 800ms 冷却：冷却期内重复点击会重启片段（§4.1"被同类型新反应替换"），不会叠加。

**约束**

- 不得再为摸头写任何骨骼偏移或 `scale`；摸头只能由 `clip-bank` 的 `pat` 角色驱动。
- `pat` 片段必须是"正面 + 自带回正"的闭环片段；侧身片段（`Normal_*` / `Exs*` / `Vital_*` / `Public01` / `Move_*`）不得接入。
- `dragged` / `settling` 期间不得建任何 `reaction`；`head_patted` 在沉降窗口内一律丢弃。
