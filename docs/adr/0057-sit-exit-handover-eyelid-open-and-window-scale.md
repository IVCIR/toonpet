# 0057. 坐姿退场交接、坐姿眼睛照抄站立，与整体缩放（0.5x–2.0x）

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-11-10 |
| 决策者 | 项目所有者（真机实测三条：① 坐姿结束后走路姿势抽搐；② 坐下后眼睛是眯着的；③ 新功能：控制面板加"角色缩放比例"滑块 0.5x–2.0x） |
| 关联 | 契约 §3.2（窗口规格）、§3.3 R-2/R-3/R-4（掩膜分辨率）、§3.5（`cmd:state-report` 载荷）、§7.3（坐姿表现规则）、§7.8（控制面板）、§12（无新定时器）；ADR 0009（包围盒定窗口）、ADR 0014/0029（骨骼仲裁与基底判定）、ADR 0028/0043/0048/0051（坐姿生命周期 / 补偿权重 / 站立上半身覆盖 / 两段式停帧）、ADR 0044/0046/0047（眨眼通道、眼球接管、脸部特写取证）、ADR 0052（参数热更新） |

## 背景

真机（Windows 11，1600×1000 / 工作区 1600×952）实测三件事：

1. **坐姿结束后走路抽搐**。从 `sitting` 退出（拖拽 / 点她 / 目标窗口消失）回到 `idle` / `walking`
   之后，上半身是"拧着"的：头随光标抽动、脖子/胸口/下背像是被钉在坐姿上，
   和走路动画打架。
2. **坐姿是眯眼的**。落座后（阶段 B 16.2s 停帧之后）哪怕上半身已经照抄了站立姿态、
   眼球也接管成平视，**眼皮依然是半闭的**，读起来像"困得要睡着了"。
3. **新需求**：控制面板"物理手感"页加一个"角色缩放比例"滑块（0.5x–2.0x，默认 1.0x），
   拖动时窗口与角色实时同比变大变小、脚底始终贴窗口底边、参数持久化到 `config.json`。

## 排查

### 1. 抽搐：`overrideBase()` 是"每帧持续写"，从来没有人放手

`BoneArbiter.overrideBase(bone, q)` 不是"这一帧盖一下"，而是**把某根骨的旋转基底永久换掉**：
`endFrame()` 每帧都用 `overrideBase ?? base` 合成。ADR 0046 D1 的注释写着

> 退出坐姿：`overrideBase(eye, null)` 不需要显式调用 —— `sitMotion` 包络归零后不再提交眼球偏移，
> 站姿的 Mixer 会重新写眼骨。

这句话的前提是错的。`applySitMotion()` 在 `upperBlend > 0.0005` 时调 `overrideBase(...)`，
**权重归零时既不提交、也不清除**，仲裁器里那份四元数就一直留着。实测退出坐姿 2s 后：

| 骨骼 | 覆写状态 | 表现 |
|---|---|---|
| `Bip001 Spine` / `Spine1` / `Neck` / `Head` | `overrideBase ≠ null` | 上半身冻在最后一次混合出的"站立×坐姿"姿态上；视线通道每帧在这份冻结基底上加 yaw/pitch → 头随光标抽 |
| `Bip001 eye_L/R` | `overrideBase ≠ null` | 眼球冻在平视绑定姿态（这个方向是对的，但同样没人还权） |

同一段代码里还有第二个"权重卡住"的坑（`animation-controller.ts`）：`playHold()` / `playOnce()`
只 `crossFadeFrom(currentAction)`，**不清第三个仍在半途的 action**。待机站姿轮换的淡入是 0.8s、
坐姿进场 0.45s、摸头 0.45s —— 足够让"第三个 action"停在 0.5 左右的权重上，而此后没有任何路径
再淡出它。真机上的组合效果就是"坐姿叠着站姿、站起来还挂着"。

### 2. 眯眼：眼睛链被停帧冻在"半闭"位置

本资产的眨眼是**眼皮骨平移**，不是 blendshape、也不是贴图（ADR 0026 D6 / ADR 0044 D4 / ADR 0047）：
`Bip001 bone_eye_D_L/R` 的 `translation.x` 静止 **0.000275**（睁眼）→ 闭眼 **0.000435**
（取自 `Cafe_Idle` t≈2.5s 的眨眼帧，见 ADR 0026 D7 的否决记录）。

坐姿片段停在 16.2s 时 Mixer 不再写这些骨（`PropertyMixer.apply()` 跳过冗余写入），
于是她**带着 16.2s 那一帧的眼睛状态**被冻住。上半身覆盖（ADR 0048/0051）只管
"下背/胸/颈/头"的**旋转**，眼睛完全不在覆盖范围内 —— 所以以前怎么调上半身都不管眼睛。

**第一版只还原了眼皮的 `translation.x`，真机 A/B 几乎没有变化**（`sit-eyes-before-after.png`
左右两张几乎一样）。于是把 GLB 里两段片段的同名骨骼逐轨对照，才发现"眼睛"是**一条链**：
眼卡片根骨在 16.2s 被平移了 −0.00016（≈ −9px）、它的两根子骨被各转了 ∓0.077/0.045 quat
（≈ 8.8°/5.1°）、眼皮再收一点点。**真正让眼睛变小的是"卡片下移 + 子骨对拧"**，眼皮只占一成。
（逐轨数据见 D3 的表格；采样脚本口径：`accessors` 线性插值到 t=16.2s。）


### 3. 缩放：窗口几何归谁、掩膜怎么办

- 模型在屏幕上的大小由 `pixelsPerUnit = 内容高 / (取景高 × 1.15)` 决定（ADR 0009 D4），
  也就是**窗口变高 = 模型同比变大**，脚底仍贴内容区底边。所以缩放不需要碰 `model.scale`，
  也不需要碰 `frame`；只要改窗口尺寸 + 让渲染侧 `resize`。
- 掩膜目前写死 `128 × 72`（契约 §3.3 R-2）。窗口放大到 2x 后，一个掩膜单元要覆盖 7.5 CSS px，
  点她的手指会"点不准"、摸头判定变钝 —— 必须让分辨率跟着尺寸走。
- 窗口"能不能放到 2x"取决于屏幕：基准 720 高 × 2 = 1440px，而 1080p 桌面的工作区只有约 1040px。

## 决策

### D1 退出坐姿 = 一次显式的 **0.3s 交接**，结束后整块放手

新增 `SIT_UPPER_HANDOVER_MS = 300`（`shared/constants.ts`）与纯函数
`sitUpperExitBlend(elapsedMs)`（`sit-sequence.ts`，`easeInOutCubic`，0 → 0、150ms → 0.5、300ms → 1）。

`render-module` 的每帧顺序改为：

```
updateSitGain(dt)               // 片段权重 → sitGain（原有）
updateSitStage(now, dt)         // 下坐弹簧 + 阶段 A/B（原有）
sitPoseGain = sitGain × sitDrop
updateSitUpperHandover(now)     // ← 新增：算出本帧唯一的上半身覆盖权重 sitUpperWeight
  ├─ 在坐姿里：sitUpperWeight = stageBBlend × sitPoseGain（与原来一致）
  ├─ 刚离开：  sitUpperWeight = sitExitFrom × (1 − exitBlend)（0.3s 收到 0）
  └─ 收到 0：  finishSitExit(now)
```

`finishSitExit()` 做四件事（幂等，打一条日志）：

1. `releaseSitBoneOverrides()`：`overrideBase(null)` × {Spine, Spine1, Neck, Head, eye_L, eye_R}
   + `overridePosition(null)` × {bone_eye_D_L, bone_eye_D_R} —— 把这 8 根骨彻底还给 `AnimationMixer`；
2. 清 `sitGain / sitPoseGain / sitFallbackGain / sitStageBGain / sitDropSpring / sitBodyYaw /
   sitPhaseAHeadApplied / sitSpineOverlay`；
3. `sitMotion.reset()` + `sitPool.flush()`（新增接口：**立刻**把微动作池权重清零，不走指数衰减）；
4. 日志 `坐姿退出收尾：上半身/眼球/眼皮覆写已释放、弹簧与微动作池归零（交接前 x.xxx）`。

两条入口都开交接：`exitSit()`（点她 / 命令 / 窗口消失 / 全屏）与 `drag_started`
（拖拽直接接管 `sitting`，**不经过** `exitSit`，旧实现这里连"淡出"都没有）。

`sitUpperWeight` 是**唯一**的上半身覆盖权重：`applySitMotion()` 里四根骨的 `slerp`、眼骨的
`slerp`、眼皮位置插值、呼吸/张望/晃腿的整体包络全部只读它。所以"0.3s 归零"是同一根曲线，
不会出现"上半身放开了、呼吸还挂着"。

配套把**片段的交叉淡出**从 0.35s 收到 **0.28s**（`SIT_EXIT_CROSSFADE_SECONDS`）：
补偿量是 `raw × sitPoseGain`，而 `sitPoseGain` 跟片段权重同源；片段必须在交接结束前先到 0，
否则最后一帧会掉一块 0.02×265px ≈ 5px 的位移。

**同时修掉"第三个 action 卡住"**：`animation-controller.ts` 抽出 `fadeOutOthers(keep, seconds)`，
在 `fadeTo()` / `playHold()` / `playOnce()` / `finished` 回调里都调用 —— 任何一次"接管身体"
都会把除目标与上一个之外的残权 action 一起淡出。

### D2 整体缩放：窗口 = 基准 × 比例，底边中心不动，上限受工作区

- **参数**：`view.scale`（`shared/tunable-params.ts`），范围 `CHARACTER_SCALE_MIN..MAX` = 0.5–2.0、
  默认 `CHARACTER_SCALE_DEFAULT` = 1.0、步长 0.01、两位小数；分组 `physics` → 面板新增一张
  "整体缩放"卡片（`sectionHint` 由元数据给出，不再是面板里硬编码的分组文案）。
- **几何唯一实现**：`src/shared/window-scale.ts` 的 `resolveScaledWindowBounds({base, scale, anchor, workArea})`
  - 等比：`宽高 = round(基准 × 比例)`；
  - **底边中心锚点**：`anchor` 是当前窗口的底边中点，缩放后 `x = anchor.x − w/2`、`y = anchor.y − h`；
  - **工作区夹取**：`effective = min(请求, workArea.width/base.width, workArea.height/base.height)`，
    差额与 `clamped='workarea'` 一起进诊断（面板状态页显示"请求 2.00x → 实际 1.32x"）；
  - 位置兜底复用 `shared/geometry.ts` 的 `clampRectToWorkAreas()`（D-7"至少 80×120 可见"），
    **不新写一份**。
- **主进程执行**：`shell.applyViewScale(scale, reason)` → `window.setBounds(rect, false)`。
  入口有三条，都走同一个函数：① 启动时 `resolveWindowSize()` 之后按 `config.json` 里的值算初始矩形
  （避免"先 1.0x 闪一下"）；② 面板 `preview` / `save` / `reset` → `sendTuning` 闭包里先调
  `applyViewScale` 再 `appBus.sendCommand(cmd:tuning)`；③ 内部入口 `shell.setViewScale()`
  （自检 / 取证用）。
- **渲染侧只做 resize**：窗口 `setBounds` 之后浏览器发 `resize`，`render-module.resize()` 已经有
  正交视锥（±w/2 / ±h/2）、`renderer.setSize()`、`animationRoot.position.y = -h/2` 与
  `applyPlacement()`（重算 `pixelsPerUnit` 与脚底锚点）。模型因此**同比**变化，不需要改
  `model.scale`、不需要改取景包围盒。
- **掩膜分辨率自适应**：`maskSizeFor(cssW, cssH)`（`shared/mask.ts`）按 `内容高/720` 缩放
  128×72，夹在 `[0.5x, 2x]`（即 64×36 – 256×144）；`MaskCapture.resize()` 重建离屏 RT 并把
  采样器标成 cold（下一次 probe 立刻重采）。`MaskSampler` 不再读常量，改为记**这一帧实际的**
  `maskWidth/maskHeight`；`cssToMask()` / `hitTest()` 增加可选尺寸参数（缺省仍是 128×72）。
- **交互坐标系同步**：命中判定（`cmd:probe` → 双线性 → `cmd:interactive`）、头部区
  （`0.125 × 内容高`）、抓取带、拖拽支点（骨骼世界坐标 → CSS）、`findCurrentHitPoint`
  全部已经是"按内容区比例/骨骼世界坐标"计算，窗口一变尺寸就自动跟上 —— 这一轮只补了
  掩膜分辨率这一处硬编码。
- **持久化**：`view.scale` 与其它五个参数同一套 `config.json.tuning`（只写非默认项、原子写、
  非法值退默认）。**运行期没有新定时器**：滑块 `input` → 面板 60ms 防抖 → `preview` → 主进程
  `setBounds`，全程事件驱动。

### D3 坐姿的"眼睛"：整条眼睛链照抄站立待机（旋转 + 位置）

**为什么不是"把眼皮的 `translation.x` 拉回睁眼值"就够了**——第一版只做了这一件事，
真机 A/B 几乎没有变化（见"排查 3"）。逐轨对照 `Cafe_Idle`（站立）与
`my_event088_pastmemory_01`（坐姿）在同名骨骼上的数据后，原因很清楚：**这只眼睛由多根骨共同决定**。

| 骨骼 | 站立待机 | 坐姿 16.2s | 差异 | 视觉后果 |
|---|---|---|---|---|
| `Bip001 eye_L/R`（眼卡片根骨）**位置** | x = 0.00071 | x = 0.00055 | **−0.00016 ≈ −9px** | 整张眼卡片往下沉 |
| `Bip001 eye_L/R_1` **旋转** | ≈ 0（x=0.003） | x = −0.077 | **≈ −8.8°** | 上眼睑/眼角被压下来 |
| `Bip001 eye_L/R_2` **旋转** | ≈ 0（x=−0.002） | x = 0.045 | **≈ +5.1°** | 下眼睑方向相反地拧 |
| `Bip001 bone_eye_D_*` **位置** x | 0.000275 | 0.000296（16.0s 处 0.00033） | +0.00006 | 眼皮再收一点点（≈ 一次眨眼行程的 13–39%） |
| `bone_Eyering_*` **缩放** | 0.9984 | 0.9937 | −0.5% | 可忽略 |

所以**只还原眼皮是"把最小的一项修好了"**，真正让眼睛变小的是"卡片下移 + 子骨对拧"。
本轮把口径改成与 ADR 0048 上半身完全一致的思路：**照抄站立待机**。

- 覆盖对象 = **眼睛链 12 根**：`eye_L/R`、`eye_L/R_1`、`eye_L/R_2`（眼卡片及其子骨）、
  `bone_eye_D_L/R` + `_01` + `_02`（眼皮链）。`model-loader` 新增这 8 个骨骼槽位
  （缺失只跳过，不影响 `modelReady`）。
- `BoneArbiter` 新增 `overridePosition(bone, vec3 | null)`：**绝对值**（不是偏移、没有累加），
  `endFrame()` 每帧写一次，传 `null` 即放手。ADR 0046 D2 删掉的是"手写眨眼位移通道"
  （逐帧累加、把下眼皮硬拉上去），这里是一个**固定值还原**，两者不是一回事。
- 三份姿态，结构与上半身一致：
  | 快照 | 何时采 | 用途 |
  |---|---|---|
  | `eyeChainBind` | `setupAnimations()` **之前** | 确定性"睁眼"兜底（待机帧可能撞上眨眼） |
  | `eyeChainIdle` | 第一帧纯站立待机（与上半身四元数同帧） | **目标**：她平时睁着眼的样子 |
  | `eyeChainSitFrom` | 阶段 B 开始那一帧 | 起点（片段值），0.3s 内插值过去 |
  目标姿态里**只有眼皮链的 x** 取 `min(idle, bind)`（本资产 x 越大越闭）；眼卡片没有这条口径。
- 施加：`quat = slerp(片段值, 站立值, blend)`、`pos = lerp(片段值, 站立值, blend)`，
  `blend = 上半身覆盖权重`（阶段 B 淡入是 0.3s，所以是"慢慢睁开"而不是"啪一下"）。
  **退场时保持 1**：站起来的过程中眼睛必须一直是睁开的；`finishSitExit()` 放手之后，
  站姿动画自己的眼睛/眼皮数据接管（与基线几乎一致，看不到跳变）。
- 降级：眼睛链骨骼缺失 → 缺几根就跳过几根（记一次 WARN）；一根都没有时完全不施加，
  只是"坐姿仍可能眯眼"，其它一切照常。


## 替代方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 退出时直接 `overrideBase(null)`（硬切） | 一行修好抽搐 | 头在起身瞬间"啪"地回正；需求明确要 0.3s 平滑 | 否 |
| 退出时不放开、只把权重乘 `sitGain` | 不用新状态 | 就是当前 bug 本身：权重到 0 后覆写还在 | 否 |
| 用 `arbiter.reset()` 整块清空 | 简单 | 会连视线/呼吸的偏移一起清，且不知道"当前帧到底谁在写" | 否 |
| 给 `BoneArbiter` 加"权重中"字段，由消费方递减 | 更通用 | 把时间/曲线塞进仲裁器，它就不再是纯每帧合成器 | 否（曲线留在 `sit-sequence` 纯函数里） |
| 靠 `sitMotion` 自己的 500ms 包络退场 | 不动代码 | 比上半身慢 200ms，读到"头已经站好、身体还在呼吸" | 否（乘交接曲线） |
| 缩放改 `model.scale`、窗口尺寸不动 | 不碰窗口 | 窗口太小会裁掉放大的模型；命中掩膜/拖拽/吸附全部要另算坐标系 | 否 |
| 缩放让渲染进程发 IPC 请求主进程改窗口 | "分层干净" | 窗口几何归 `shell`（§7.2），渲染侧没有改窗口的权限；而且会多一条通道 | 否 |
| 缩放不夹工作区（2.0x 就是 1440px 高） | 字面满足滑块 | 1080p 上头顶被切成两半、窗口超出工作区后拖不回来 | 否（夹到工作区，面板显式显示实际值） |
| 掩膜保持 128×72 不变 | 零改动 | 2x 后一个单元 7.5px，命中/摸头变钝 | 否（按比例放大，夹 2x） |
| 眼皮用"重置眼部贴图"实现睁眼 | 不碰骨骼 | 本资产的眼型贴图是画在卡片上的静态图，没有"半闭"变体可用（ADR 0047 排查 4） | 否 |
| 只还原眼皮的 `translation.x`（第一版实现） | 改动最小、只碰 2 根骨 | 真机 A/B 几乎无变化：眼睛变小的主因是"眼卡片下移 9px + 子骨对拧 8.8°" | 否（改为整条眼睛链照抄站立） |
| 把眼睛链"归零到绑定姿态"而不是照抄站立待机 | 与 ADR 0046 的绑定姿态口径一致 | 绑定姿态是 T-pose 的脸，和玩家认可的"站立平视"差一个量级（ADR 0047 踩过同样的坑） | 否（照抄站立） |

## 后果

**正面**

- 坐姿退出后上半身/眼球/眼睛链**全部交还 `AnimationMixer`**：`sit.overrides` 两个数组为空、
  头骨 `baseFrom='mixer'`、微动作池权重精确为 0；走路/待机不再被坐姿的扭曲拖住。
- 坐姿停帧后眼睛与**站立待机一致**（阶段 B 的 0.3s 淡入里"慢慢睁开"，不是瞬切）；
  真机 A/B：虹膜从"被上眼睑压住"回到"完整可见"，`sit-eyes-before-after.png`。
- 缩放滑块 0.5x–2.0x 实时生效：窗口与角色同比、脚底贴底边、参数持久化；
  掩膜分辨率跟着变，命中精度不随缩放退化；屏幕装不下时按工作区夹住并**在面板上显示实际值**。
- 所有新逻辑都有纯函数与单测（`window-scale` 8 条、`mask` 3 条、`mask-sampler` 2 条、
  `bone-arbiter` +1 条、`animation-controller` +3 条、`micro-pool` +1 条、`sit-sequence` +2 条、
  `tunable-params` +1 条）。

**负面 / 成本**

- 多了一个"交接"状态（`sitExitAt`）与一个位置覆写通道；`RenderDiagnostics.sit` 增
  `handover` / `eyelid` / `eyes` / `overrides` 四个**内部**字段（不进 `RenderState`）。
- 坐姿下每帧多覆写 12 根眼睛链骨骼的旋转 + 位置（合计 20 根受控骨），实测帧时间无变化
  （`render.frameMs` EMA 仍在 16.7ms 量级）。
- 掩膜在 0.5x 时只有 64×36：命中精度与 1.0x 相同（单元覆盖的 CSS 面积不变），但 bbox 的
  绝对行数变少，头部带降级口径（bbox 22%）的分辨率也随之降低 —— 首选口径是头骨半径，
  不受影响。
- 缩放上限不是滑块上限：1080p 桌面上 2.0x 实际只能到 ~1.32x（面板状态页会写出来）。
- 2.0x 在超宽屏上会吃掉较多 GPU 填充（窗口面积 ×4）；本资产 ~1.7 万三角形，实测无掉帧。

**约束**

- 不新增外部依赖、不新增定时器、不新增 IPC 通道、不新增状态名/事件/`intent`/`emotion`。
- `RenderState` 不增删字段；缩放只走 `config.json.tuning` 与既有 `cmd:tuning`。
- 眼睛链（12 根）**只允许**这一处"照抄站立"的覆写（且只在坐姿阶段 B 之后、退场期间）；
  **禁止**恢复任何逐帧累加的眨眼通道（ADR 0046 D2 仍然有效），**禁止**给眼睛写 `scale`。
- 窗口几何（宽高/位置）只能由 `shell` 写；渲染侧只响应 `resize`。
- 所有幅度/时长常量只写在 `shared/constants.ts`。

## 验证

- **单测**（`npm test`，exit 0）：见上文"正面"里的计数；关键几条：
  - `window-scale`：1.0x 恒等、1.2x/0.6x 等比 + 锚点、范围夹取、工作区夹取（等比不拉扁）、
    D-7 兜底、基准非法时不动；
  - `mask` / `mask-sampler`：`maskSizeFor` 三档 + 夹取、2x 掩膜的命中与 bbox 换网格、
    尺寸变化作废旧 bbox；
  - `bone-arbiter`：位置覆写是绝对值、每帧写、`null` 后不再写、`reset()` 清空；
  - `animation-controller`：`playHold` / `playOnce` 都会淡出半途的第三个 action；
    `clearHold + play('idle')` 之后坐姿 action 权重 <0.02 且 `hold()=null`；
  - `sit-sequence`：`sitUpperExitBlend` 0/0.5/1、单调、两端速度为 0；片段淡出时长 < 交接窗口。
- **主链路自检**（`npm run selftest`，229 条）新增 12 条：
  - 坐姿里 `sit.overrides.rotation ≥ 4`；眼皮 x 已回到站立基线（|Δx| ≤ 2e-5、weight ≥0.95）、
    `sit.eyes.captured=true`（12 根眼睛链全部登记）；
  - 16ms 采样观测到完整交接：`upper` 单调降到 0、覆写从 4→0（旋转）/ ≥2→0（位置）、
    交接期间眼睛保持睁开（`eyelidApplied` 不掉回 0 再跳）；
  - 交接结束后 `handover=null`、`sitPoseGain=0`、`upperOverride=0`、`overrides` 两空、
    `headBase.baseFrom='mixer'`、微动作池全 0；0.6s 后再读一次仍然全 0（不会自己长回来）；
  - 缩放三档（1.4x / 0.6x / 2.0x）：窗口 = 基准 × 生效比例（±1px）、底边中心锚点不动（±1px）、
    渲染侧内容区与窗口一致、`pixelsPerUnit` 同比、掩膜分辨率 = `maskSizeFor()`、缩放后仍能像素级命中；
    2.0x 装不下时 `clamped='workarea'`；还原 1.0x 后窗口回到原位；
  - 截图：`sit-eyelid-open.png`（坐姿睁眼）、`window-after-sit-exit.png`（退场后站立）、
    `window-scale-140.png` / `window-scale-060.png` / `window-scale-200.png`。
- **面板取证**（`npm run panel:shot`，隔离 `config.json`，退出前还原）新增 5 项断言：
  窗口 = 基准 × 1.35（超出屏幕时按工作区夹）、锚点不动、渲染侧尺寸同步、面板滑块与状态页读数
  （`1.35x → 1.32x`）、`config.json` 里 `view.scale=1.35`；截图 `panel-physics.png`（含新滑块）/
  `panel-status.png`（含"角色缩放（请求 / 实际生效）"卡片）。
- **缩放逐档取证**（`npm run scale:shot`）：0.5x → 2.0x 每档一张窗口截图（11 帧）+
  `logs/evidence/scale-sweep.json`；GIF `window-scale-sweep.gif` 当"录屏"看。
- **脸 A/B**：`sit-eyes-before-after.png`（2026-11-06 的眯眼 vs 今天照抄站立；同一 420px 脸部特写相机）。
- **真机**：1600×1000（工作区 1600×952）上 2.0x 被夹到约 1.32x，窗口高度正好等于工作区高度、
  头顶不越界；拖动滑块时窗口逐帧跟随（`setBounds` 无动画），角色脚底稳定贴在屏幕底边。
