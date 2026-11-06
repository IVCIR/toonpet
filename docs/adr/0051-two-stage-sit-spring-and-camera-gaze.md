# 0051. 坐姿两段式 + 临界阻尼下坐 + 看镜头张望

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-11-05 |
| 决策者 | 项目所有者（"拆除 playHold + 瞬间覆盖；A 段从 14.2s 正放到 16.0s；B 段 16.2s 停帧并 0.3s 淡入覆盖；临界阻尼弹簧下坐；张望 1/3 概率看镜头"） |
| 关联 | 契约 §7.3（坐姿）；ADR 0028 / 0034（sitting 生命周期）、ADR 0042（下坐过渡）、ADR 0043（补偿按权重）、ADR 0044（停帧 + 程序化微动）、ADR 0046（眼球接管 / 不写眼皮）、ADR 0048（站立上半身覆盖）、ADR 0049（张望节奏）、ADR 0050（待机轮换） |

## 背景

ADR 0044 把坐姿变成"`playHold` 停在 14.5–14.7s + 全程序化微动"。真机反馈两个问题：

1. **"假人感"**：14.5–14.7s 这 0.2s 把片段里 14.95s 的头部快速转头（实测 0.253rad）
   直接冻掉了；她坐下后的第一秒没有任何"官方动作"，只剩程序化慢变量。
2. **眼神向下**：停帧在 14.7s 后，头/胸/颈被 ADR 0048 覆盖成站立姿态，但片段下背
   （`Bip001 Spine`）在 14.7s 的前倾与 16.2s 不同；只覆盖后三根时，整条上链继承了下背前倾，
   头看起来仍然低（真机 A/B：16.2s 停帧 + 三根覆盖时 `headOrientation.pitch` 约 0.59rad；
   加上下背后降到约 0.01rad）。

项目所有者拍板：不再在 0.2s 上叠代码，改回**让官方片段先演完"坐下 + 第一次张望"**，
再进入"停帧 + 站立覆盖 + 程序化微动"。

## 决策

### D1 两段式窗口：14.2 → 16.0 → 16.2

- `clip-bank.sit` 的裁剪窗口从 14.5–14.7 改为 **14.2–16.2**（`LoopOnce`，`playHold`）。
- **阶段 A（14.2–16.0s）**：正常播放。让她自己演"坐下 + 14.95s 的第一次张望"。
  14.2s 起播是为了把 14.5s 前那一点身体落位也放出来。
- **阶段 B（16.0–16.2s）**：继续播到 16.2s 后 clamp。从 16.0s 起用 **0.3s
  `easeInOutCubic`** 淡入站立上半身覆盖 + 程序化微动。
- **16.2s 是停帧基准**，不是 14.7s：`calibrateSitPose()` 也改为 `holdSeek(duration)`，
  身体平移补偿按 16.2s 的姿态测量。
- 为什么不能到 17.0s：17.0s 之后大腿/小腿开始起身（实测 17.5s 大腿已 1.46rad）。
- 阶段 B 的 0.3s 起点用"首次观测到片段本地时间 ≥1.8s"的时刻，而不是绝对片段时钟：
  掉帧时不会跳过整段淡入。

### D2 上半身覆盖改为四根骨骼，且从 `animationBase()` 采集

- 覆盖链：**下背 `Bip001 Spine` → 胸 `Bip001 Spine1` → 颈 `Bip001 Neck` → 头 `Bip001 Head`**。
- 采集必须在 `arbiter.beginFrame()` **之后**，用 `BoneArbiter.animationBase()`，不能读
  `bone.quaternion`：
  - `bone.quaternion` 含上一帧的视线偏移（启动时光标停在某个方向会把"站立平视"采成歪头）；
  - `animationBase()` 是 `beginFrame()` 判定的 mixer 产物，不含任何叠加量。
- 覆盖权重 `upperBlend = stageBBlend × sitPoseGain`，其中 `stageBBlend` 是 0.3s
  `easeInOutCubic`；`sitPoseGain = sitGain × sitDrop`。
- 眼球基底：阶段 A 允许片段自带的眼位；阶段 B 用 `upperBlend` 从片段眼位
  `slerp` 到绑定姿态，再叠张望 × 0.35。这样阶段 A 的"官方张望"能看见，
  阶段 B 又不会保留片段自带的向下看。

### D3 下坐弹簧：k=180 / c=26.8，固定子步长

```
v += (-k·(sitDrop - 1) - c·v)·dt
sitDrop += v·dt
k = 180, c = 26.8 ≈ 2√k（ζ = 1，临界阻尼）
```

- 固定子步长 `1/240s`（显式欧拉在 k=180 下稳定）；单帧 `dt` 夹到 `0.05s`。
- 0→90% 约 0.3s、0→97% 约 0.4s；临界阻尼不过冲。
- 所有坐姿补偿（`offset`、`dropPx`、`transitionLiftPx`、`lean`、`thighBend`、`bodyYaw`、
  上半身覆盖）都乘 `sitPoseGain = sitGain × sitDrop`。
- 为什么保留 `sitGain`：片段交叉淡入仍是 0→1，补偿不能超过片段本身的混合权重
  （ADR 0043 D3）；`sitDrop` 只负责"座面上方 → 座面"。
- 程序化降级路径同样走弹簧：没有片段时 `sitDrop` 仍从 0→1，下沉 24px / 大腿 0.45rad。

### D4 张望：1/3 概率看镜头

- `SIT_GAZE_CAMERA_CHANCE = 1/3`：每次抽目标先决定"看镜头 / 随机"。
- 看镜头 = `yaw = 0`、`pitch = 0`（屏幕中心方向）；不额外叠角度。
- 随机目标保持原来的 5–9s hold、800–1200ms `easeInOutCubic`（均值约 1s）、
  到位静止 ≥2s。
- 为什么需要：她坐着如果永远只看远处，会像"回避对视"；偶尔看回镜头，
  才像"她注意到你在看她"。这比"强制持续追光标"更像发呆中的活人。

### D5 不新增状态 / 事件 / IPC / `RenderState` 字段

`getState()` 的 `base`/`overlay`/`physics` 不变；没有新事件、没有新 IPC、没有新依赖。
诊断只进内部：

- `RenderDiagnostics.sit` 新增 `stage` / `stageBBlend` / `sitDrop` / `sitPoseGain` /
  `upperOverride` / `holdAtSeconds` / `holdTimeSeconds`；
- `motion.gaze.targetKind`（`camera` / `wander`）；
- `window.diagnostics.sitSequence()`（16ms 采样用）与 `forceSitGaze(kind)`（自检取证）。

### D6 不引入外部物理引擎

弹簧是 `renderer/render/sit-drop.ts` 的纯数值（`stepSitDrop` / `createSitDrop`），
不依赖 Pymunk / Rapier / Cannon；窗口物理仍归 shell 的既有 16ms 轮询器。

### D7 两个真机标定参数（A/B 用）

两个参数都放在 `shared/constants.ts`，默认值 = 当前验收版本：

| 常量 | 默认 | 语义 | 真机可试 |
|---|---:|---|---|
| `SIT_PHASE_A_HEAD_TUNE_RAD` | 0 | 阶段 A（14.2–16.0s）叠在头骨上的俯仰（rad；**正 = 低头、负 = 抬头**） | `-0.10 ~ -0.15`（嫌官方片段半眯眼/低头） |
| `SIT_SPINE_OVERLAY_WEIGHT` | 1.0 | 下背 `Spine` 的站立覆盖权重（0..1）；胸/颈/头始终是完整 `upperBlend` | `0.85`（嫌坐得太直、像罚坐） |

实现细节：

- 阶段 A 的抬头补偿：`arbiter.add(head, 0, SIT_PHASE_A_HEAD_TUNE_RAD × sitPoseGain × (1 - stageBBlend))`。
  阶段 B 的 0.3s 覆盖把它平滑收到 0，不会在 16.0s 硬切。
- 下背权重：`slerp(片段, 站立, upperBlend × SIT_SPINE_OVERLAY_WEIGHT)`。
  1.0 = 与其它三根同权；0.85 = 保留 15% 片段前倾；0 = 退回只覆盖胸/颈/头（头会重新低下去）。
- 两个值都进内部诊断：`sit.phaseAHeadTuneRad / phaseAHeadAppliedRad /
  spineOverlayWeight / spineOverlayApplied`；`sitSequence()` 也带后两者，自检可验接线。

A/B 取证：

- 组 1（默认）：`SIT_PHASE_A_HEAD_TUNE_RAD = 0`、`SIT_SPINE_OVERLAY_WEIGHT = 1.0`；
- 组 2（微调放松）：`SIT_PHASE_A_HEAD_TUNE_RAD = -0.12`、`SIT_SPINE_OVERLAY_WEIGHT = 0.85`；
- 两组都跑 `tsc --noEmit` 与主链路自检；阶段 B 截图前强制 `forceSitGaze('camera')`，
  排除随机张望对头向的干扰；对比图见 `logs/evidence/sit-ab-compare.png`。

## 替代方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 继续用 14.7s 停帧、只加程序化动作 | 改动最小 | 14.95s 的官方张望永远看不到；"假人感"的根因没解决 | 否 |
| 在 16.2s 停帧但只覆盖胸/颈/头 | 沿用 ADR 0048 | 下背前倾被整条上链继承，头仍然低（真机 A/B `pitch≈0.59rad`） | 否 |
| 覆盖下背/胸/颈/头四根 | 上半身真正与站姿一致（实测 `pitch≈0.01rad`） | 需要把采集时机移到 `beginFrame()` 之后；覆盖链多一根 | 是 |
| 16.2s 停帧后直接硬切站立姿态 | 实现简单 | 头会"啪"地回正；0.3s 是需求给定的过渡窗口 | 否（用 0.3s cubic） |
| 用线性 240ms 半蹲 | 沿用旧代码 | 读起来像"被按下去"，不是"体重落座" | 否（用弹簧） |
| 用 Pymunk 做下坐 | 物理真实 | 多一个 tick、多一套坐标系，违反零成本/单轮询器 | 否 |
| 张望持续追光标 | "看人"最直接 | 坐姿下会像监控摄像头，且与 ADR 0044 D3 的"不盯光标"冲突 | 否（1/3 看镜头） |

## 后果

**正面**

- 坐下后的第一秒有官方动作：落位、14.95s 的快速张望、16.2s 的稳定坐姿，
  不再是"一坐下就冻住"。
- 下坐有弹簧的加速度与收尾，读起来像"体重落在座面上"；不过冲、不弹回。
- 阶段 B 的上半身（含下背）与站立姿态一致，头不再低、眼神不再向下。
- 张望有 1/3 概率看镜头，减少"永远看别处"的回避感。
- 参数集中在 `shared/constants.ts`，弹簧/阶段/覆盖都是纯函数，可单测。

**负面 / 成本**

- 进入段 2.0s 比旧的 0.2s 长：落座后前 2s 她"在演"，程序化微动要到 16.0s 才起来。
  这是刻意的取舍（需求要看到官方张望）。
- 阶段 A 是片段自带的低头/半眯眼；如果真机觉得"坐下时还是有点困"，可以把 A 段裁到
  14.9s 前（但那会丢掉 14.95s 的转头），或者给阶段 A 叠一个很小的抬头偏移
  （2026-11-06 已作为 `SIT_PHASE_A_HEAD_TUNE_RAD` 落地，默认仍为 0；见文末补记）。
- `Spine` 覆盖会改变坐姿的躯干角度：从"略前倾"变成"直立"。如果真机觉得"坐得太直"，
  可以给 `Spine` 的覆盖权重单独乘一个系数（2026-11-06 已作为
  `SIT_SPINE_OVERLAY_WEIGHT` 落地，默认仍为 1.0；见文末补记）。
- 阶段 B 的 0.3s 覆盖与 0.5s 微动包络不同步：头先回正、呼吸后起来。这是有意的
  （头是敏感部位，呼吸可以慢）。
- 自检新增 16ms 采样（约 2.6s）与 2 张截图，主链路从 189 条增到 **198** 条
  （封版时含 A/B 特写 1 条，见补记）。

**约束**

- 不新增状态名、事件、`intent`、`emotion`、IPC 通道、模块接口方法或 `RenderState` 字段。
- 不引入外部物理引擎、不新增定时器、不产生按次计费调用。
- 阶段 B 的覆盖必须用 0.3s 淡入，**禁止** 16.2s 一帧硬切。
- `bone_eye_D_*`（眼皮）仍然一个通道都不写（ADR 0046 D2）。

## 验证

- 单测：
  - `sit-drop.test.ts`：k/c 参数、60fps 0.4s 收敛、0.3s 约 90%、不过冲、dt 钳制、reset；
  - `sit-sequence.test.ts`：14.2/16.0/16.2、阶段判定、0.3s cubic（0 / 0.5 / 1）；
  - `sit-pose.test.ts`：`sitDrop` 0/0.5/1 的官方/降级姿态；
  - `sit-motion.test.ts`：1/3 看镜头、`forceGaze` 立即生效；
  - `animation-controller.test.ts` / `role-weight.test.ts`：新窗口 14.2–16.2、2.0s 停帧。
- 自检（主链路 **198 / 0 失败**，exit 0）：
  - 阶段 A 期间 `upperOverride=0`、`stageBBlend=0`；
  - 阶段 B 在片段本地 1.8s 触发，0.3s 内 `stageBBlend=1`、`upperOverride≥0.95`；
  - 16ms 采样 A→B 头部四元数最大步进 **<0.15rad**（实测远小于阈值）；
  - `sitDrop` 0→1 无过冲（max≤1.01，最终≥0.95）；
  - 看镜头：`targetKind='camera'`、`targetYaw/Pitch≈0`；
  - 补偿 `offset ≈ raw × sitPoseGain`；
  - 截图：`sit-stage-a.png` / `sit-stage-b.png` / `sit-step-00..11.png` / `window-sitting*.png`；
  - D7 接线：`sit.phaseAHeadAppliedRad` 在默认 0 时恒为 0、在负值时与配置同号；
    `sit.spineOverlayApplied` 在 1.0 时等于 `upperOverride`、在 0.85 时明显低于它；
  - A/B 特写：`sit-ab-stage-a.png`（阶段 A 脸，260px）/ `sit-ab-stage-b.png`（阶段 B 上半身，420px）。
- 关键实测：加下背覆盖后 `headOrientation.pitch` 从约 **0.59rad** 降到约 **0.01–0.12rad**（看镜头时 0.01rad）；
  阶段 A→B 头部最大步进小于 0.15rad；弹簧 max `sitDrop=1`、无过冲。

## 补记（2026-11-06）：D7 参数落地与 A/B 封版

D7 的两个参数已落地为 `shared/constants.ts` 的常量，并完成两组 A/B 取证。提交保留组 1
（默认 = 当前验收版本），组 2 只作为临时标定运行，不写进默认值。

| 常量 | 提交值 | 语义 |
|---|---:|---|
| `SIT_PHASE_A_HEAD_TUNE_RAD` | 0 | 阶段 A 头骨俯仰，`× sitPoseGain × (1 − stageBBlend)`；正 = 低头、负 = 抬头 |
| `SIT_SPINE_OVERLAY_WEIGHT` | 1.0 | **只**乘下背 `Spine` 的覆盖权重；胸/颈/头仍是完整 `upperBlend` |

实现接线（`src/renderer/render/render-module.ts`）：

- 阶段 A：`sit.phaseAHeadAppliedRad = 常量 × sitPoseGain × (1 − stageBBlend)`，
  `arbiter.add(head, 0, 该值)`；阶段 B 的 0.3s 覆盖把它收到 0，不硬切。
- 下背：`animationBase(spine).slerp(站立局部四元数, upperBlend × weight)`；
  `sit.spineOverlayApplied = upperOverride × weight` 仅作诊断（实际混合权重由同一常量
  在 `applySitMotion()` 里计算，两处都用 `shared/constants.ts` 的唯一出处）。
- 诊断：`sit.phaseAHeadTuneRad / phaseAHeadAppliedRad / spineOverlayWeight /
  spineOverlayApplied`，`sitSequence()` 也带后两者；**没有**新增状态、事件、IPC 通道、
  接口方法或 `RenderState` 字段。

A/B 取证（两组都跑 `tsc --noEmit` + 主链路自检，均 exit 0）：

| 组 | `SIT_PHASE_A_HEAD_TUNE_RAD` | `SIT_SPINE_OVERLAY_WEIGHT` | 自检 | 阶段 A 实测 | 阶段 B 实测 |
|---|---:|---:|---|---:|---:|
| 1（提交默认） | 0 | 1.0 | **198 / 0** | `phaseAHeadAppliedRad=0` | `spineOverlayApplied=1.000` |
| 2（临时标定） | -0.12 | 0.85 | **198 / 0** | `phaseAHeadAppliedRad=-0.120` | `spineOverlayApplied=0.850` |

- 截图：`logs/evidence/sit-ab/group1|group2/stage-{a,b}.png`；
  对比图 `logs/evidence/sit-ab-compare.png`（由 `tools/compose-sit-ab.py` 生成）。
- 组 2 的 A 段：-0.12rad（≈ 6.9°）把刚坐下时低着的脸抬起来，眼型不再被刘海/眼皮压成
  半眯；这是"她坐下后一直低着眼"的真机手感开关。
- 组 2 的 B 段：0.85 只放松下背，肩线/躯干略向后，胸/颈/头仍完整照抄站立；变化刻意做小
  （15% 片段前倾），避免从"坐得直"跳到"瘫坐"。
- 为什么不把组 2 写成默认：D7 的验收口径仍是"官方片段原样优先"（组 1 = 完全照抄站立）。
  真机手感由用户只改两个常量决定；改完无需改代码，`tsc` / `npm test` / 主链路自检的
  接线断言按"同号 / 低于 upperOverride"判定，不锁死具体数值。

真机标定建议：`SIT_PHASE_A_HEAD_TUNE_RAD` 从 0 往 **-0.10 ~ -0.15** 试；
`SIT_SPINE_OVERLAY_WEIGHT` 从 1.0 往 **0.85** 试；每改一次只动一个参数，避免两个方向
同时变、分不清是哪一个改变了观感。
