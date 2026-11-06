# 0050. 待机静态站姿轮换（删除空闲 shy 演出）

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-11-05 |
| 决策者 | 项目所有者（"空闲时随机触发 shy 动静太大、极其突兀""手绕着手腕突然垂下""希望在几个静态站姿之间平滑切换"） |
| 关联 | 契约 §4.1（`idle`）、§7.3（待机规则）、§11（降级）；ADR 0014 D3.1（正面/侧身）、ADR 0023 D5、ADR 0041 D4、ADR 0043 D1、ADR 0045 D1（旧空闲小动作）、ADR 0049 D1（idle 微动作池） |

## 背景

真机反馈三件事，全部指向同一个来源：

1. **`Cafe_Reaction` 的闲置片段太突兀**。旧实现每 45–95s 播一次 `Cafe_Reaction` 3.2–4.9s
   （`clip-bank` 的 `fidget.shy`）：双手掩到脸前、整身缩一下再放开。它不是"待机的小变化"，
   而是一段**有起势、有幅度、有收势的演出**；在没有任何上下文触发的情况下出现，
   观感就是"她突然抽了一下"。
2. **同一段演出里有骨骼扭曲**。交叉淡入到该窗口时，手臂在"抱在胸前 → 放开垂下"的中间态
   会读成"手绕着手腕突然垂下"。根因是片段本身的姿态过渡被 0.3s 淡入截断后与站姿叠加，
   不是某一个骨骼写错。修法是**不再让空闲触发这段素材**，而不是给手腕手写补偿
   （ADR 0039 D2 的同一教训：不为单次反应手写骨骼姿态）。
3. **需求变了**。不需要"高频随机小动作"，而是希望她像活人一样，在几个**官方自带的正面站姿**
   之间慢慢换姿势。换姿势是"她现在怎么站着"，不是"她突然做了什么"。

## 决策

### D1 删除空闲 `shy` 演出（不是调参，是整体移除）

- 删除 `clip-bank` 的 `fidget.shy` 角色与 `Cafe_Reaction` 3.2–4.9s 窗口；
  删除 `renderer/render/fidget.ts` 及其单测、`render-module.updateFidget()`、
  `RenderDiagnostics.fidget`、`IDLE_FIDGET_MIN_MS/MAX_MS` 与"启动后 45s 冷却"整套机制。
- 空闲路径**不再引用 `Cafe_Reaction` 的任何窗口**。该片段只剩两个显式意图：
  `greet`（0.15–2.2s）与 `nod`（8.7–9.9s），都由 `intent` 驱动，不由计时器触发。
- 不改 `Cafe_Reaction` 资源本身；换模型/换素材后如果官方修了手腕，也不因此恢复空闲触发。

### D2 候选池：44 段里筛出 7 个正面静态循环片段

筛选口径（逐段看胶片条 + `tools/clip-preview/shots/census.json` 的骨骼事实）：

1. **正面**：根骨/头骨朝向面向镜头。排除 `Normal_*` / `Exs*` / `Vital_*` / `Public01` / `Move_*`
   等侧身战斗片段（ADR 0014 D3.1 已实测 `Normal_Idle` 根骨在绑定姿态上再转 −87°）。
2. **静态站立**：双脚着地、无位移/跳跃/倒地；`census.json` 的 `shrinkRatio ≤ 0.005`、
   `pitchRange ≤ 0.02`，即骨骼活动只有呼吸/头发量级。
3. **循环待机**：片段本身是 4s 循环，不是一次性演出或过场；排除 `Cafe_Reaction` /
   `Victory_Start*` / `Formation_Pickup` / `*_interaction_*`（后者根骨偏 128–190px）。

入选（`renderer/render/idle-variation.ts` 的 `IDLE_VARIATION_CANDIDATES`）：

| 角色 | 片段 | 观感 | census 事实 |
|---|---|---|---|
| `idle` | `CH0335_Cafe_Idle` | 正面、右手在胸前/领带，左臂自然下垂 | `shrink=0.001`、`pitch=0.012`、`facing=1.553` |
| `idle.alt1` | `CH0335_Formation_Idle` | 正面抱臂 | `shrink=0.005`、`pitch=0.011`、`facing=1.962` |
| `idle.alt2` | `CH0335_Carrier_Idle` | 正面、右手握拳在胸前 | `shrink=0.001`、`pitch=0.011`、`facing=1.548` |
| `idle.alt3` | `CH0335_Victory_End_Random` | 正面、双手抱在胸前 | `shrink=0.005`、`pitch=0.015`、`facing=1.270` |
| `idle.alt4` | `CH0335_Carrier2_Idle` | 正面、右手在胸前（与 `Cafe_Idle` 是近邻姿势） | `shrink=0.001`、`pitch=0.012`、`facing=1.553` |
| `idle.alt5` | `CH0335_Victory_End` | 正面、双臂自然垂下 | `shrink=0.006`、`pitch=0.022`、`facing=1.945` |
| `idle.alt6` | `CH0335_Formation_Idle_Random` | 正面、右手抬到脸侧（抱臂姿势的变体） | `shrink=0.005`、`pitch=0.016`、`facing=1.186` |

排除的典型：

- `CH0335_Normal_Idle`：战斗侧身待机（`facing=0.584`，与正面基准 1.55 差约 55°）。
- `CH0335_Cafe_Walk` / `Carrier2_Walk` / `Move_Ing`：走路循环，不是站姿。
- `CH0335_Cafe_Reaction` / `Victory_Start*` / `Formation_Pickup` / `Public01*` / `Exs*`：
  一次性演出、过场或侧身战斗；`Victory_End_interaction_01` 等根骨被搬出镜头。
- `Exs_Prop_*` / `Exs_Cutin_Cam_*`：道具/相机轨道，不驱动角色身体。

> 7 个候选的**轮廓**其实只有 4 类（手在胸前 / 抱臂 / 双臂垂下 / 手在脸侧），
> 其余是同一轮廓的不同头部与呼吸相位。这符合"几个静态站姿"的需求，也让 20–45s 的
> 换姿势不会每次都读成"换了一个人"。

### D3 间隔与淡入：20–45s / 0.8s，唯一出处 `shared/constants.ts`

- `IDLE_VARIATION_MIN_MS = 20_000`
- `IDLE_VARIATION_MAX_MS = 45_000`
- `IDLE_VARIATION_FADE_SECONDS = 0.8`

数值理由：20s 是"不会觉得她在抖"的下限；45s 是"看半分钟能看到一次变化"的上限。
0.8s 是"看得出在换姿势、但不会读成动作"的窗口——短于 0.5s 会像瞬移，长于 1.2s 会让手臂
在两个站姿的混合体里停留过久（容易穿过身体）。这些值不再散落在 `render-module` 里。

### D4 纯逻辑调度器：`renderer/render/idle-variation.ts`

与 `micro-pool.ts` 同一手法（不引用 three、不读时钟、可单测）：

- 每次从候选里抽一个**不是当前角色**、且片段可用的角色（排除当前角色是硬约束：
  抽到自己等于什么都没发生，还会把片段 time 重置回 0）。
- `tick(now, active, available)` 只在 `active=true` 时推进；不在拖拽 / 坐姿 / 行走 /
  说话 / 一次性演出期间换姿势。
- 到点但上下文不成立时**不顺延到"一恢复就换"**：把下一次排期改成"恢复时刻 + 20–45s"，
  避免"刚站起来就换姿势"。
- 片段缺失时跳过该候选并记 WARN；**不回退**到程序化骨骼/根变换。
- 切换仍走 `animation-controller.playRole(role, 0.8, 'idle')` 的 `crossFadeFrom`；
  该函数已会把"交叉淡入半途的第三个 action"一并淡出（ADR 0049 D8）。
- 从 `walking` / `settling` 淡回 `idle` 槽位时，调度器用 `noteCurrent('idle')` 同步
  "当前站姿"，避免下一次抽到 `idle` 时从 0s 重播同一个姿势。

### D5 呼吸与视线不换轨

- 呼吸由每个官方待机片段自己带（ADR 0014 D8），换姿势只换"基底"。
- 视线仍由 `gaze.ts` 每帧叠加（三层阻尼、眼球领先、躯干跟随），不受轮换影响。
- `idle` 微动作池（`browse` / `headTilt`）继续工作；顺手补上它此前漏掉的
  `speaking` 上下文门（ADR 0049 D1 要求"说话时不抽签"）。

### D6 不新增状态 / 事件 / IPC / `RenderState` 字段

`getState().base` 恒为 `idle`，`overlay` / `physics` 不变；没有新事件、没有新 IPC。
诊断只进内部：`RenderDiagnostics.idleVariation` 与
`window.diagnostics.{idleVariation, forceIdleVariation, setIdleVariationInterval}`
（前两个只读/取证，第三个只给自检压缩时序）。

## 替代方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 保留 `fidget.shy`，把间隔拉长到 3–5 分钟 | 改动最小 | 突兀感来自"演出本身"，不是频率；手腕扭曲仍在 | 否 |
| 给 `Cafe_Reaction` 3.2–4.9s 加手腕补偿/重定向 | 保留素材 | 违反 ADR 0039 D2；用户明确说"停止这种演出" | 否 |
| 只保留现有 4 段待机（22–40s） | 改动更小 | 没有利用 44 段里另外三段合格的正面站姿；用户要求"所有适合正面站立的动作" | 否 |
| 候选池 7 个全收 | 变化最多 | 有 3 组近邻轮廓，观感变化没有数量那么大 | 是（D2） |
| 用 `IDLE_MICRO_POOL` 的权重交叉代替交叉淡入 | 复用现成机制 | 池是叠加骨骼偏移，不能切整段动作；整段切换必须走 `crossFadeFrom` | 否 |
| 用程序化骨骼在站姿之间插值 | 可控 | 需要手写全身姿态，穿模风险高；违反"只用官方片段"的既定路线 | 否 |

## 后果

**正面**

- 空闲不再出现"突然掩面缩身"的演出，也不会再触发那段手腕扭曲。
- 她会在 7 个官方正面站姿之间慢慢换姿势（20–45s / 0.8s 交叉淡入），呼吸与视线照常。
- 参数集中在 `shared/constants.ts`；候选与筛选口径集中在一个纯逻辑文件。
- 删除一个模块（`fidget.ts`）与一个诊断块，代码量净减少。

**负面 / 成本**

- 7 个候选里有多组近邻姿势（胸前手 / 抱臂），实际轮廓变化只有 4 类；
  如果观感仍嫌"变化太小"，下一步应减少候选而不是加快间隔。
- `idle.alt6`（`Formation_Idle_Random`）是"手抬到脸侧"的姿势，比其它候选更"有表情"；
  若真机觉得它像固定动作，可从池里去掉（只改一行候选表）。
- 交叉淡入的中间帧仍可能出现手臂重叠（0.8s 内两套手臂同时有权重）；
  已用 `idle-crossfade-00..03.png` 取证，当前 7 个候选的过渡未见穿模。
  换模型/换素材后必须重拍这组图。

**约束**

- 不新增状态名、事件、`intent`、`emotion`、IPC 通道、模块接口方法或 `RenderState` 字段。
- 不新增动画片段、不引入 Live2D/精灵图、不产生任何按次计费调用。
- 空闲路径**禁止**再引用 `Cafe_Reaction`；轮换必须是交叉淡入，**禁止**瞬切。

## 验证

- 单测：`idle-variation.test.ts`（7 条）锁死 20–45s / 0.8s、排除当前、只抽可用角色、
  忙时顺延、强制与间隔覆盖；`animation-controller.test.ts` 锁死 7 个候选互不相同且无
  `Cafe_Reaction` / `Normal_Idle`。
- 自检（主链路）：候选池 7 个、2.6s 压缩抽签换过 ≥2 个、中段权重证明交叉淡入、
  7 个站姿截图 `idle-pose-00..06.png`、交叉淡入四帧 `idle-crossfade-00..03.png`。
- 日志：`[render] 待机站姿轮换 → <role>=<clip>（crossFade 0.8s）`；
  删除后不应再出现 `[render] 空闲小动作`。
- 证据目录：`dist/selftest/`（截图）与 `logs/selftest-idle-variation*.log`；
  `logs/evidence/` 有 7 张站姿、4 张交叉淡入帧与两张拼图（`idle-pose-sheet.png` /
  `idle-crossfade-sheet.png`）。
