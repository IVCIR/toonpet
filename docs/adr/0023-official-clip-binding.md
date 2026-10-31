# 0023. 官方片段接线：语义表、一次性演出与朝向约束

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-10-31 |
| 决策者 | 项目所有者 |
| 关联 | ADR 0014（骨骼仲裁、Mixer 接入、`pat_react` 程序化）、ADR 0010（贴图口型）、`CONTRACTS.md` §4.1/§4.4/§5.1～§5.3/§7.1/§7.3 |

## 背景

ADR 0014 把模型自带的 44 段骨骼动画接进了 `AnimationMixer`，但只驱动三个槽位：
`idle`（`CH0335_Cafe_Idle`）、`held`（`CH0335_Carrier_Idle`）、`walk`（`CH0335_Move_Ing`，未启用）。
其余 41 段闲置，`pat_react` / `greet` / `happy_hop` 全部由 `pat-react.ts` 与 `REACTIONS`
程序化合成（位移、缩放、骨骼偏移）。

结果是"动作是手写的，资产没用上"：摸头只是点头+侧倾，打招呼只是 18px 跳一下。
ADR 0014 D6 当初不用整身片段，理由是 `Cafe_Reaction`（10.75s）与
`Formation_Pickup`（14s）会长时间抢走身体与口型通道——这个理由针对"整段播"成立，
针对"按窗口裁短 + 单 action 替换"不成立。

本轮用 `tools/clip-preview` 把 44 段逐段截图核对，得到三个 ADR 0014 没记录的事实：

1. **朝向分两族。** `Normal_*` / `Exs*` / `Vital_*` / `Public01` / `Move_*` 是战斗动画，
   角色**侧身**对镜头（`Normal_Callsign` 直接是举枪侧身）；`Cafe_*` / `Formation_*` /
   `Carrier*` / `Victory_*` 是正面。桌宠默认正面，侧向片段不能用。
2. **`Carrier_Idle` 不是悬空姿态。** 它是普通站姿（双手交叠），
   真正"被拎着、四肢垂下"的是 `Formation_Pickup` 的 0.2s 之后整段——原 `held` 映射选错了。
3. **`Cafe_Reaction` 是分段演出。** 0–2.2s 摊手（像"诶？"），3.5–6.6s 缩身、
   手放胸前（读作害羞），9s 前后低头鞠躬。同一段可以裁成两个语义。

## 决策

### D1 语义表集中到 `clip-bank.ts`，槽位退化为角色别名

新增 `src/renderer/render/clip-bank.ts`：`ClipRole → { exact, patterns, loop, startSeconds, maxSeconds }`。
`animation-controller` 的 `SLOT_RULES` 删除，`idle`/`held`/`walk` 三个槽位改为
`SLOT_TO_ROLE` 的别名，片段名只在 `clip-bank` 维护一份。换模型只改这张表。

选择规则沿用 ADR 0014 D3（精确名 → 模式降级 → 缺失），降级原因继续进诊断与日志。

### D2 一次性演出：`playOnce` 用单 action 替换，不叠加

`playOnce(role)`：`LoopOnce` + `clampWhenFinished`，`mixer` 的 `finished` 事件触发
`play(returnTo)` 淡回常驻槽位；被打断时按 action 身份比对忽略迟到的 `finished`。

- **不是叠加**：整身片段替换 Base，不新增第二个整身 action，因此不违反 H-1/H-2。
- **不新增状态名**：Overlay 仍是 `reacting`，`RenderState` 字段不变（§7.1）。
- HFSM 的 `reacting` 时长改为跟片段等长（`headPatted(now, durationMs?)`、
  `intent(now, intent, durationMs)`），避免"状态结束了动画还在播"。

### D3 `held` 改用 `Formation_Pickup`

拖拽期间播 `Formation_Pickup`（循环，14s 的垂姿，实测 0.2s 后一直保持"被拎着"）。
`Carrier_Idle` 降为模式降级候选。不再单独播 `pickup` 起势——它与 `held` 是同一段，
连播两次会跳帧。

### D4 摸头：非说话时播官方片段，说话时退回程序化

- 非 `speaking`：`playOnce('pat')` = `Cafe_Reaction` 的 **3.5–6.6s**（缩身害羞段，3.1s）。
  官方片段自己会动头，因此**不再叠加** `patPose` 的头部 pitch/roll 与身体前倾；
  `shy` 嘴型帧仍然切（贴图通道与骨骼通道独立）。
- `speaking`：§5.3 要求 `pat_react` 权重 ≤0.4 且不得动嘴型，整身片段无法在 0.4 权重下
  正常成立，因此**退回 ADR 0014 D6 的程序化路径**（1.1s，头部偏移 + 满权重规则不变）。

### D5 待机姿态轮换

空闲 22–40s 随机在 `idle`（`Cafe_Idle`）与 `idle.alt1`（`Formation_Idle`，正面抱臂）
之间交叉淡入 0.8s。拖拽与一次性演出期间不轮换。Base 状态仍是 `idle`（§4.1 不变）。
`Public01` 因侧向被排除，不参与轮换。

### D6 接线范围

| intent / 事件 | 片段 | 备注 |
|---|---|---|
| `head_patted` / `pat_react` | `Cafe_Reaction` 3.5–6.6s | 说话时退回程序化 |
| `greet` | `Cafe_Reaction` 0–2.2s | 摊手，正面 |
| `happy_hop` | `Victory_Start` | 双手合十，正面 |
| `drag_started` | `Formation_Pickup`（循环） | `held` 槽位 |
| `nod` / `shake_head` / `tilt_head` / `look_at_user` | 无对应片段 | 保持程序化 |

`attack` / `skill` / `panic` / `down` / `revive` / `victory` 在表里登记但**不接线**：
它们要么侧向，要么属于"战斗模式"的表现，等有转屏演出时再启用。

### D7 朝向是第一约束

`clip-bank` 里每个 `exact` 都注明朝向。新增片段前必须先在
`tools/clip-preview` 里看一遍——侧身片段直接进桌宠会"歪着身子"，这是本轮最大的坑，
且从片段名完全看不出来。

## 替代方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 维持现状（只用 3 槽位 + 程序化反应） | 零风险 | 41 段资产闲置，动作没有重量感 | 否 |
| 整段播 `Cafe_Reaction` / `Formation_Pickup` | 实现最省事 | 10–14s 抢身体通道，摸头要等 10 秒 | 否 |
| 按窗口裁短 + 单 action 替换（本方案） | 时长可控、不叠加、不新增状态 | 裁剪窗口是资产相关标定，换模型要重标 | **是** |
| 用 `AnimationUtils.subclip` 裁剪 | 现成 API | 依赖 fps 假设，模型片段采样率不统一 | 否 |
| 摸头说话时也播整身片段 | 表现统一 | 违反 §5.3 的 0.4 权重上限与口型优先 | 否 |
| 把侧向战斗片段转 90° 再播 | 44 段全可用 | 角色会横着走，穿帮更明显 | 否 |
| 语义表写在 `render-module` 常量里 | 少一个文件 | 与槽位规则两处维护，换模型要改两遍 | 否 |
| 独立 `clip-bank.ts` + 槽位别名（本方案） | 单一事实来源，预览工具可复用同一张表 | 多一层间接 | **是** |

## 后果

**正面**

- 44 段里正面可用的 8 段全部接上：待机 ×2、行走 ×2、被拎起、摸头、打招呼、开心。
- 摸头/打招呼/开心第一次是"官方演出"而不是手写位移，角色重心与布料/头发摆动都跟着走。
- 槽位与片段名解耦：换模型只改 `clip-bank.ts`，`render-module` 不动。
- 新增 `tools/clip-preview`（浏览器预览 + 胶片条 + 离屏截图），选片段不再靠猜。

**负面 / 成本**

- 裁剪窗口（3.5–6.6s 等）是**针对 CH0335 标定**的，换模型/换动作集要重新标。
- 摸头片段 3.1s 比原来的 1.1s 长，`head_patted` 冷却期间角色会一直缩着；
  selftest 的第二次摸头因此要等片段播完才能重新命中头部（已改为 sleep 3300）。
- 说话时摸头仍是程序化，和官方片段观感不一致（受 §5.3 约束，本轮无解）。
- 待机轮换会让 `Formation_Idle` 的抱臂姿态周期性出现，是否喜欢需实际使用后调
  `IDLE_VARIANT_ROLES`。

**约束**

- `clip-bank` 里的片段名必须与模型原始名一致；改模型必须同步改表，否则走降级。
- 一次性演出只能替换 Base，不得叠加第二个整身 action（H-1/H-2 仍然有效）。
- `speaking` 期间不得播整身摸头片段；口型通道优先级不变（§5.2）。
- 不新增状态名、事件名、`RenderState` 字段、依赖（§4.1/§7.1）。
- 侧向片段（`Normal_*` / `Exs*` / `Vital_*` / `Public01` / `Move_*`）不得接进正面桌宠。
