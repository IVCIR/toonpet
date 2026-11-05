# 0043. 启动冷却、坐姿活体化与落座补偿的平滑插值

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-11-04 |
| 决策者 | 项目所有者（真机实测三问） |
| 关联 | 契约 §4.1（`idle` / `sitting`）、§5.2、§7.3（render 表现规则）、§11、§12；ADR 0028（吸附与坐姿）、ADR 0042（坐下过渡 / 跟随 / 坐姿窗口）、ADR 0041（空闲小动作） |

## 背景

1.6.0 那一轮把坐姿从"停帧"改成"停帧 + 240ms 半蹲"之后，真机实测又发现三个问题：

1. **打开应用时角色会原地转一圈**；
2. **坐下之后像假人**：没有呼吸、只有眼睛在动；
3. **切换坐姿的瞬间乱平移、甚至出边框**（最严重）。

## 排查

### 问题一：启动即转圈

`fidgetAt`（下一次空闲小动作的绝对时刻）的字段初值是 **0**。而 `updateFidget()` 每帧都跑，
判定条件是"到点 + 站着待机 + 无 Physics + 不说话 + 无一次性演出"：

```
if (now < this.fidgetAt) return;   // 0 → 永不 early-return
const idleOk = base==='idle' && physics===null && …;
```

**首帧到"模型加载完成"之间有几秒空窗**：那时 `this.animations === null`，`base` 已经是 idle、
physics 是 null、没在说话 —— `idleOk` 全为真。于是 `Math.random() < 0.5 && this.animations?.playOnce() === true`
落空后直接走到 `spin` 分支：**模型还没出现，转圈就已经开始**，等她加载完成时正好看到"开局转一圈"。

`setupAnimations()` 里的 `scheduleFidget()` 确实排了 45–95s，但它只在加载成功后执行一次，
挡不住"加载前的那几帧"。

### 问题二：坐姿像假人

上一轮为了"不要自己站回去"，用 `playHold()`（`LoopOnce` + `clampWhenFinished`）把坐姿片段
**停在最后一帧**。停帧之后：

- 片段里的呼吸、头发、布料全停（它们都是骨骼动画）；
- 只剩 `sit-pose.ts` 的 1.2px 竖向浮动与视线跟随 —— 1.2px 在 720px 窗口里肉眼几乎不可见。

### 问题三：落座瞬间乱平移

`enterSit()` 把 `this.sitting = true` 之后，帧循环里：

```
const sitShift = this.sitting ? this.sitOffsetPx() : { x: 0, y: 0 };
```

`sitOffsetPx()` 是加载期按**停帧姿态**量出来的常量，实测 **x≈+265px、y≈-287px**
（回忆片段把她搬到画面右侧的椅子上）。于是：

1. `snap_applied` 那一帧，`animationRoot.position` 直接被加上 (+265, -287) ——
   **一帧内瞬移近 390px**，模型瞬间飞出窗口；
2. 更早：`snap_approach_started`（接近阶段）就把 `sitting` 置为 true，而那时她还在播 `walk`，
   补偿已经生效 —— 整个"走过去"的过程都是带着 265px 偏移在走，看起来就是"乱飘"。

## 决策

### D1 启动冷却：`fidgetAt` 初值 = `+Infinity`，并且以"模块构造时刻"为基准

| 改动 | 位置 | 说明 |
|---|---|---|
| 字段初值 `Number.POSITIVE_INFINITY` | `render-module.ts` | 语义从"已到期"变成"安全冷却，等排期"；漏排期时永远不会触发（宁可没有小动作） |
| 模型未就绪一律不触发 | `updateFidget()` | `if (!this.ready \|\| !this.animations) return;` —— 直接消灭"加载前空窗" |
| 排期带第二道闸 `nextFidgetAtMs(now, startedAt)` | `fidget.ts` | `max(now + delay, startedAt + 45s)`；`startedAt` 是模块构造时刻，所以**启动后前 45s 绝对不可能到期**，与加载快慢无关 |

`nextFidgetDelayMs()` 保持纯函数不变，新增的 `nextFidgetAtMs()` 也可单测（含"晚排期""非法输入"）。

### D2 坐姿从"停帧"改成"循环 0.42s 平稳段"

- `clip-bank.sit`：`loop: true`，窗口 **14.5–14.92s**（0.42s），淡入 0.45s、淡出 0.35s。
  - 为什么是这一段：普查 14.5→14.9 的骨骼差 —— 头 y 0.0002、骨盆 0.0001、脚底 0.0003、
    头 pitch 0.007rad，**循环接缝在 1–2px 量级**；再往前后都会进入"坐下去/起身"或明显转头。
  - 片段自带的呼吸（胸/肩）、头发与手指微动因此回来了。
- `animation-controller`：
  - **循环角色也按窗口裁剪** —— 旧实现 `selection.loop ? base : trimClip(...)` 会把
    `loop: true` 的角色直接绑到整段 38s 过场（窗口被静默忽略）；
  - 新增 `playRole(role, fade, slot: AnimationSlot | null)`：坐姿不是 Base 槽位，传 `null`；
  - 新增 `roleWeight(role)`：返回角色 action 的有效权重（未在跑的角色返回 0，
    因为 three 未播放的 action 默认权重是 1，不能直接读）。
- `render-module`：`enterSit()` 用 `playRole('sit', 0.45, null)`，不再 `playHold`。
  `calibrateSitPose()` **仍用 `playHold` + `holdSeek(末尾)`**：它只需要"量一次停帧姿态的包围盒"，
  与运行时播放方式无关。

### D3 补偿与姿态共用"片段权重"当插值因子

新增 `updateSitGain(dt)`，每帧（`mixer.update` 之后）算：

```
clipWeight   = animations.roleWeight('sit')            // 0 → 1（淡入）/ 1 → 0（淡出）
fallbackGain = 指数包络（仅程序化降级路径用，τ=180ms）
sitGain      = sitPoseActive ? max(clipWeight, fallbackGain) : 0
```

然后**所有**坐姿相关量都乘 `sitGain`：身体平移补偿、下沉、过渡抬升、呼吸浮动、重心偏移、
后倾、大腿弯曲。效果：

- 站姿时 `sitGain = 0` → 补偿恒为 0（接近阶段再也不会带着 265px 偏移走路）；
- 交叉淡入时 `sitGain` 与片段权重同源 → 补偿与"片段把身体搬走多少"严格同步，中间没有跳变；
- 解除坐姿时片段淡出（0.35s）→ 补偿跟着退到 0，不会在 `exitSit` 那一帧弹回原点。

`sitPoseActive` 是一个"会话闩锁"：落座后置 true，退场且 `sitGain < 0.002` 才置 false ——
这样标定期（`calibrateSitPose` 的 1ms 淡入淡出）不会被误判成"在坐"。

### D4 活体微动兜底（即使片段循环也叠一层）

`sit-pose.ts` 新增三项，全部由 `sitGain` 缩放：

| 量 | 幅度 | 周期 | 作用 |
|---|---|---|---|
| `bobPx` | ±2.4px（旧 1.2） | 3.6s | 呼吸的竖向浮动 |
| `breathScale` | ±0.5%（≈±3.6px） | 3.6s | 根节点 `scale.y`：从脚底向上伸缩，脚不离地 |
| `swayPx` | ±1.6px | 5.2s | 极慢的左右重心偏移 |

为什么用根节点 `scale.y` 而不是脊柱骨：`animationRoot` 的原点在内容区底边中心，竖向缩放
天然是"从脚底往上长"；写脊柱骨会盖掉片段自带的胸腔起伏（ADR 0028 D8 的既有结论）。
视线跟随本来就有（`gaze.update` 每帧写头部/眼球），本轮未改。

### D5 契约与可观测

- **不新增**状态名、事件、`intent`、`emotion`、IPC 通道、`RenderState` 字段、依赖、定时器。
- 内部诊断：`RenderDiagnostics.sit.{looping, blend, clipWeight, rawOffsetPx}`；
  `done` 字段保留但恒为 `null`（`playHold` 停帧语义已废弃，不破坏诊断形状）。
- 契约 §7.3 的坐姿规则、§4.1 的 `idle` 说明（启动冷却）、§11 的降级行同步（minor，1.19.0）。

## 替代方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 只在 `updateFidget` 里加"启动后 N 秒"判断 | 改动最小 | 依赖"模块构造时刻"这个隐式基准；漏排期仍会到期 | 部分采纳（D1 第二道闸就是它，但写成纯函数 + 单测） |
| 启动时直接 `scheduleFidget(now + 45s)` 硬编码 | 一眼看懂 | 45s 是常量，散落两处 | 否（`nextFidgetAtMs` 复用 `IDLE_FIDGET_MIN_MS`） |
| 坐姿继续 `playHold` + 加大程序化呼吸 | 不用改控制器 | 身体仍是整帧冻结（头发/布料死），加大呼吸会变成"整体起伏" | 否 |
| 坐姿循环**整段** 14.1–16.4s | 动作最自然 | 接缝处头 yaw 差 0.24rad（14°）、pitch 差 0.31rad → 每 2.3s 一次"甩头" | 否 |
| 补偿用指数淡入（时间包络）而不是片段权重 | 与片段解耦 | 两条曲线不可能完全同步 → 中间会出现"补偿过头/不足"的滑移 | 否 |
| 补偿在 `snap_applied` 瞬间直接给满值（+ 让片段淡入） | 实现最省 | 就是本轮的 bug（一帧 390px 瞬移） | 否 |
| **启动双闸 + 0.42s 循环 + 权重同源补偿 + 微动兜底（本方案）** | 每一步都可单测/逐帧取证；零新状态 | 0.42s 循环的接缝仍有 1–2px；补偿与权重的同步依赖"权重=混合因子"这一 three 的实现事实 | **是** |

## 后果

**正面**

- 冷启动前 45s **不可能**出现任何 fidget（实测：06:31:17 启动 → 06:32:06 首次 `spin`，49s）。
- 坐姿是活的：片段自带的呼吸/头发回来了，另有 ±2.4px 浮动、±0.5% 躯干缩放、±1.6px 重心偏移。
- 落座过程连续：逐帧诊断 `headWorld.x` 相邻帧最大跳变 **4.9px**（旧实现是 ~265px 的一次跳变），
  `offsetPx` 与 `rawOffsetPx × blend` 逐帧吻合（误差 < 2px）。
- 接近阶段不再应用任何坐姿补偿（旧实现带着 265px 偏移走过去）。
- 新增 5 个单测（启动排期 2 条、循环裁剪 1 条、`roleWeight` 淡出 1 条、微动有界 1 条）
  + 主链路自检 4 条（循环播放 / 补偿缩放 / 呼吸微动 / 落座连续）。

**负面 / 成本**

- 0.42s 循环的接缝是 1–2px 的"微跳"，在极慢速回放下可见（正常速度看不出）。
- 坐姿的"活着"依赖片段权重；如果将来把坐姿换成 `playHold` 或加 `timeScale` 变化，
  `blend` 的语义要重新确认。
- `getDiagnostics()` 单次约 300ms（含面部贴图摘要），所以"逐帧取证"只能分两遍跑
  （图一遍、数字一遍）；取证脚本 `tools/compose-sit-sheet.py` 只做拼图，不参与运行时。

**约束**

- 不得把坐姿改回 `playHold` 停帧；要"更静"只能调 `sit-pose` 的微动幅度。
- 坐姿相关的一切变换都必须乘 `sitGain`；不得出现"常量补偿直接加到根节点"的写法。
- fidget 的排期只能走 `nextFidgetAtMs()`；不得在别处直接写 `fidgetAt = now + …`。
- `bg`：`sit-loop` 取证图（`dist/selftest/sit-step-*.png` + `sit-sequence.png`）是证据产物，
  不进仓库（`dist/` 已在 `.gitignore`）。
