# 0041. 拖拽统一官方悬空片段、摸头收尾与片段利用率

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-11-03 |
| 决策者 | 项目所有者（真机体验四问之一二三） |
| 关联 | 契约 §3.4（D-1/D-6）、§4.1（`dragged` / `reacting` / `idle`）、§4.4（`nod` / `greet` / `happy_hop`）、§5.2、§5.3、§7.3（render 订阅与表现规则）、§11、§12；ADR 0023（官方片段接线）、ADR 0035（抓取带与单摆）、ADR 0039（摸头只播官方片段） |

## 背景

阶段 16 封版后，真机体验提出三个"影响表现力"的问题，本轮逐一解决：

1. **拖拽不同部位表现不一致**：拖上半部分（头）不播官方拖拽动画，而是回到"参考 Azalea 写的程序化姿态"；拖下半部分才播 `Formation_Pickup`。
2. **摸头收尾像被切断**：官方摸头片段（`Victory_Start_Random`）后段收尾太快。
3. **44 段动画绝大多数吃灰**：只有 9 个角色被接线，待机只有两段轮换。

### 排查：问题一的根因

`render-module.ts` 的 `drag_started` 分支按**抓取带**选片段：

```ts
if (this.dragBand === 'head') {
  playRole('held.limp', …)   // = CH0335_Carrier_Idle，其实是普通站姿
} else {
  playAnimation('held', …)   // = CH0335_Formation_Pickup，真正的悬空垂姿
}
```

`held.limp` 选的是 `Carrier_Idle` —— 胶片条实测是**正面站姿**（双手交叠），不是悬空姿态；
为了让"被拎着头"看起来成立，`drag-motion.ts` 又给头/身/脚三态各写了一套手写骨骼偏移
（`dragBoneOffsets`：脊柱/颈/头/上臂/大腿/小腿共 12 根骨，抓脚时 `upperArm roll = -1.4rad`
= 双臂举过头顶），再加一个 `liftPx` 整身抬升。于是：

- **抓头 = 普通站姿 + 手写骨骼**（正是用户说的"之前的程序化姿态"）；
- **抓身/抓脚 = 官方悬空片段 + 手写骨骼叠加**；
- "抓取带"同时决定了"播什么"与"怎么摆"，两件事被耦合在同一个分支里。

### 排查：问题二的两个原因

1. `animation-controller` 的 `finished` 回调固定回 `returnTo` 槽位（`'idle'`）→
   **回的是槽位，不是"她刚才在播的那个动作"**。待机姿态是会轮换的（`idle` / `idle.alt1`），
   摸头时她在抱臂站姿里，回来却被交叉淡入到 `Cafe_Idle` —— 抱臂的手在 0.25s 内被放下来。
   这一条是"像被生生切断"的真正根因，靠调片段窗口修不好。
2. 裁剪窗口 0.3–2.4s 包含了片段自己的"2.0→2.2s 抬头回正"（20ms 级的一次弹起），
   紧接着又是一个 0.25s 的淡出 —— 两段恢复叠在一起，观感是"抽一下然后被按住"。

### 排查：问题三的资产事实（逐段普查 + 胶片条）

`tools/clip-preview` 全量普查（44 段 × 0.2s 采样骨骼事实）+ 逐段胶片条复核，结论：

| 类别 | 段数 | 片段 | 结论 |
|---|---|---|---|
| 纯相机/道具轨（没有骨骼通道，4–14 channels） | 7 | `Exs_Cutin_Cam_01/01_1/02/02_1`、`Exs_Prop_Start/Ing/End` | 不可用（不含骨骼动画） |
| 侧身战斗 | 17 | `Normal_*`(8)、`Exs`/`Exs_Cutin_01/02`(3)、`Vital_*`(4)、`Public01`/`Public01_Random`(2) | 不可用（侧身/背身，ADR 0023 D7） |
| 移动（侧向） | 2 | `Move_Ing`、`Move_End_Normal` | 不可用（侧向） |
| **正面家族** | **18** | `Cafe_Idle`/`Cafe_Walk`/`Cafe_Reaction`、`Formation_Idle`/`_Random`/`Formation_Pickup`、`Carrier_Idle`/`Carrier2_Idle`/`Carrier2_Walk`、`Victory_Start`/`_Random`、`Victory_End`/`_Random`、`Victory_Start_Interaction_02`、`Victory_End_Interaction_02`、`Victory_End_interaction_01`、`Victory_Start_interaction_01`、`my_event088_pastmemory_01` | 可用候选 18 段 |

其中还有两条**此前没记录的硬事实**：

1. **`Carrier2_Idle` / `Carrier2_Walk` 与 `Cafe_Idle` / `Cafe_Walk` 是同一份数据**
   （普查逐项相同：缩身 0.001、手到脸 0.007、yaw 1.553…）。它们只留作模式降级候选。
2. **`*_interaction_*` / `*_Interaction_*` 四段是过场，根骨被搬到镜头外**：
   `Victory_End_interaction_01` 偏左 **128px**（并悬空 73px）、`Victory_Start_Interaction_02` 偏左
   **190px**、`Victory_End_Interaction_02` 偏左 **190px**。它们虽然在正面家族里，但接进 422px 宽的
   桌宠窗口会让她半个身子在窗外 —— 与 ADR 0023 对 `Victory_Start_interaction_01` 的判断同因，本轮一并排除。
3. **资产里没有"挥手"，也没有"伸懒腰/原地转圈"**：正面家族里没有任何片段把手抬到肩以上
   （唯一的"双手举过头"是 `Vital_Retreat` / `Vital_Death`，都是侧身/背身的撤退与倒地）。

## 决策

### D1 抓取带与"播哪段官方片段"解耦：**统一** `Formation_Pickup`

`clip-bank` 删除 `held.limp` 角色；`held` 只有一个，就是 `CH0335_Formation_Pickup`，
**从第 0 秒起播**（该片段 0–1.2s 正是"被拎起来"的屈膝起势，1.4s 之后一直保持垂姿）。
每一段 `drag_started` 都从头播放，因此**每次被抓起都有官方的那一下"被拎起"**。

抓取带（head / body / foot）**只**决定单摆物理（摆长 / 阻尼 / 限幅 / 挣扎），不再决定播什么：

| 抓取带 | 摆长 | 阻尼 | 限幅 | 挣扎 | 播放 |
|---|---|---|---|---|---|
| head | 374px | 3.2 | 0.35rad | — | `Formation_Pickup` |
| body | 230px | 4.2 | 0.32rad | — | `Formation_Pickup` |
| foot | 130px | 0.9 | 0.25rad | 2.5Hz / 0.045rad | `Formation_Pickup` |

**删除的全部内容**（不是"降级保留"）：

- `drag-motion.ts` 的 `dragBoneOffsets()` / `DragBoneOffset` / `DragBoneKey`（12 根骨、三态手写姿态）；
- `DRAG_PENDULUM[*].liftPx`（4/12/8px 的程序化整身抬升）；
- `render-module` 第 4.2 步的骨骼叠加块与第 6 步的 `dragLift`；
- `clip-bank` 的 `held.limp` 角色。
- 保留：`pivotCompensation` + 受迫单摆（整身**绕抓取点旋转**）、`struggleOffset`（作为单摆角度的一部分）。

### D2 一次性演出播完回到"演出前那个动作"，并按角色配淡入淡出

| 改动 | 位置 | 理由 |
|---|---|---|
| 记住 `oneShotReturnAction` 并在 `finished` 时淡回它（找不到才回槽位） | `animation-controller.ts` | 修"抱臂→普通站姿"的姿态跳变（问题二根因 1） |
| `ClipRule` 新增 `fadeInSeconds` / `fadeOutSeconds`（按角色覆盖默认 0.18/0.25） | `clip-bank.ts` + `animation-controller.ts` | 不同片段的收尾姿态差别很大，淡出时长不能一刀切 |
| 摸头窗口 0.3–**2.05s**（原 2.4）、淡出 **0.45s**（原 0.25） | `clip-bank.ts` | 停在"还缩着"的保持段末尾，把"抬头/放手"整段交给 0.45s 交叉淡入 —— 观感是"慢慢直起身"（问题二根因 2） |

**没有**采用"最后 0.2s 叠加骨骼回正插值"：ADR 0039 D2 已经禁止为摸头写任何骨骼偏移，
而"停在保持段 + 长淡出"能在不加骨骼的前提下拿到同样的缓出。

### D3 扩充语义映射（`clip-bank` 由 9 个角色扩到 13 个）

| 角色 | 片段 | 窗口 | 说明 |
|---|---|---|---|
| `idle` | `Cafe_Idle` | 全段循环 | 不变 |
| `idle.alt1` | `Formation_Idle` | 全段循环 | 不变（抱臂站姿） |
| **`idle.alt2`** | `Carrier_Idle` | 全段循环 | 正面、双手交叠、几乎不动的"乖"站姿 |
| **`idle.alt3`** | `Victory_End_Random` | 全段循环 | 正面、双手轻握胸前、呼吸极小 |
| `held` | `Formation_Pickup` | 全段循环 | 见 D1 |
| **`nod`** | `Cafe_Reaction` | **8.7–9.9s** | 真正的鞠躬（9.4s 最低点、10.0s 起身）；裁到 1.2s 符合 §4.4 上限 |
| `greet` | `Cafe_Reaction` | 0.15–2.2s | **资产里没有挥手**；这是正面家族里唯一"手抬到胸肩并摊开"的动作 |
| `happy` | `Victory_Start` | 全段 | 双手合十 + 微微鞠躬再抬头 |
| `pat` | `Victory_Start_Random` | 0.3–2.05s | 见 D2 |
| **`fidget.shy`** | `Cafe_Reaction` | **3.2–4.9s** | "双手掩到脸前、身子缩一下"（害羞），1.7s 闭环 |
| `sit` | `my_event088_pastmemory_01` | 13.4–15.6s | 见 ADR 0042 D3 |
| `walk` / `walk.carried` | `Cafe_Walk` / `Carrier2_Walk` | 全段 | 不变 |

`INTENT_CLIP` 由 `{greet, happy_hop}` 扩到 `{greet, nod, happy_hop}`。
`happy_hop` 在播官方片段的同时保留一个**更小的 22px 根跳**（§4.4 要求"有位移的小跳，需回位"；
官方 `Victory_Start` 本身没有腾空）。

### D4 待机姿态池扩到 4 段，并新增"空闲小动作"

- 待机轮换 `IDLE_VARIANT_ROLES` 由 2 段扩到 4 段（上表 `idle` / `alt1` / `alt2` / `alt3`），
  间隔仍是 22–40s、淡入 0.8s；换的是"底噪"，不改变 `Base.idle`。
- **空闲小动作（fidget）**：45–95s 一次，只在"站着待机、无 Physics、不在说话、无一次性演出、
  无拖拽姿态"时触发；到点但条件不满足就顺延一个完整间隔。
  - `spin`：**纯根节点偏航**转一圈（`fidget.ts` 的梯形速度曲线，0→2π，1.7s），
    不换片段、不动骨骼；转到 2π ≡ 0，结束时不需要回正。
  - `shy`：播官方 `fidget.shy`（1.7s），播完按 D2 淡回原姿势。
  - 一半概率各一个；`fidget.shy` 缺失时退回 `spin`。
- **不新增 §4.1 状态**：fidget 期间 Base 仍是 `idle`、`overlay` 仍是 `null`，
  只有内部诊断 `RenderDiagnostics.fidget` 记录 `{kind, progress, yaw}`。
  理由：它不是"对某个 intent/事件的反应"，而是 Base 层自己的一个短演出；
  若塞进 `reacting`，会与"`reacting` 只由 `head_patted` / §4.1 的 5 个 intent 进入"冲突。
- 为什么不做"伸懒腰"：资产里没有对应片段，硬做就是第二个"手写骨骼"（ADR 0039 D2 已因同一理由删掉程序化摸头）。

### D5 契约与可观测

- **不新增**状态名、事件、`intent`、`emotion`、IPC 通道、`RenderState` 字段、依赖。
- 内部诊断新增 `RenderDiagnostics.fidget`；`drag.band` 的语义收窄为"只影响单摆物理"。
- 契约 §7.3 的表现规则、§11 的降级行、§4.1 的 `idle` 说明同步（minor，1.18.0）。

## 替代方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 抓头继续用 `Carrier_Idle` + 减小手写骨骼幅度 | 改动最小 | 用户明确要求"删除所有纯程序化的骨骼大幅度位移"；站姿做底永远不像悬空 | 否 |
| 抓头 / 抓脚各用一段官方片段（如 `Victory_End_interaction_01` 抓头） | 表现更丰富 | 该片段根骨偏左 128px、悬空 73px，需要额外的中心/落地补偿与一段 128px 的横向滑移 | 否（D1 统一，记入"未完成"） |
| 摸头最后 0.2s 叠加骨骼回正 | 字面满足需求 | 违反 ADR 0039 D2；且源片段在 2.0–2.2s 本来就是"快速抬头"，叠插值只会更乱 | 否 |
| 为 `greet` 用 `Victory_Start_Interaction_02`（唯一"举手"的正面片段） | 更接近"举手打招呼" | 根骨偏左 190px，会让她半个身子在窗外 | 否 |
| 把 fidget 塞进 `reacting` | 状态可读 | `reacting` 的进入条件是封闭集合（`head_patted` + 5 个 intent），塞进去要改契约语义 | 否（只进内部诊断） |
| **解耦抓取带 + 统一官方悬空片段 + 回原动作 + 扩 4 段待机/olon 小动作（本方案）** | 零新依赖、零新状态、可单测、每一条都有截图/普查证据 | 抓头与抓脚的上半身表现一致（只有物理不同）；`Formation_Pickup` 超过 14s 会循环回起势 | **是** |

## 后果

**正面**

- 拖拽**任何部位**都是官方演出（`Formation_Pickup`），每次抓起都有"被拎起"的起势；
  手写骨骼与 `liftPx` 全部删除，代码净减少约 90 行。
- 摸头收尾由"片段自己 0.2s 弹起 + 0.25s 淡出"换成"停在保持段 + 0.45s 淡出"，
  并且**一定回到她刚才那个姿势**（抱臂不会突然变成普通站姿）。
- 可用正面片段从 9 段用到 13 个角色（含 4 段待机、1 段鞠躬、1 段害羞小动作），
  44 段里"能用的都接上了"（18 段正面家族中排除 4 段过场 + 1 段腾空过场 + 2 段与 `Cafe_*` 重复）。
- 新增 11 个单测（片段表窗口 / 悬空片段唯一性 / 待机池 / `playOnce` 回原动作 / fidget 曲线）。

**负面 / 成本**

- 抓头不再有"头被拎住、身体下垂"的**部位特有**姿态（只有单摆参数不同）；要恢复差异需要
  第二段"悬空"素材（`Victory_End_interaction_01` 需要 128px 横向补偿，列为后续可选项）。
- `Formation_Pickup` 14s 循环：拖拽超过 14s 会回到"从地上被拎起"的起势（很少发生，接受）。
- fidget 是**概率性**行为（45–95s），自检无法稳定命中；只能单测纯函数 + 读日志确认。
- 摸头片段变短（2.1s → 1.75s）：`head_patted` 的 800ms 冷却仍然短于片段，冷却期内重复点击会重启片段。

**约束**

- 不得再为拖拽写任何"按部位"的骨骼姿态或整身位移；抓取带只能影响 `DRAG_PENDULUM`。
- 一次性演出必须回到 `oneShotReturnAction`（找不到才回槽位）；不得再引入"固定回 idle 槽位"的分支。
- 不得把 fidget 做成 §4.1 的新状态或新 intent；它不进 `RenderState`。
- `*_interaction_*` 四段与 `Carrier2_*` 两段不得接线（根骨偏移 / 与 `Cafe_*` 重复）。
