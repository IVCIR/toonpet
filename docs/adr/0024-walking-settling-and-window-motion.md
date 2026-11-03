# 0024. `walking` 调度、窗口位移与真实回弹

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-10-31 |
| 决策者 | 项目所有者 |
| 关联 | 契约 §3.3 R-8、§3.4 D-5/D-6/D-7、§4.1（`walking` / `settling`）、§5.1/§5.3、§6.3（`motion_ended`）、§7.1（`PhysicsState`）、§12（单一定时器）；ADR 0002（轮询器）、ADR 0004（手势与沉降窗口）、ADR 0023（官方片段） |
| 修订 | **D2 的 `SETTLE_RESTITUTION = 0.28` 已由 ADR 0040 D3 调为 0.15**：0.28 会让窗口整块反跳一次（实测 vy 948→−169、2137→−491，位移 15–40px），被误读成"摸头" |

## 背景

契约 §4.1 早就定义了 `walking`（"idle 持续 ≥20s 后由内部调度器随机触发，到达目标点或被 dragged 打断"），但实现里 Base 恒为 `idle`，`walk` 槽位只识别不启用；§3.4 D-6 要求"松手后播回弹"，实现里也只是 crossFade 回 Idle——角色在窗口里"落地"了，窗口本身纹丝不动。

本轮要把两件事做成真的：

1. **角色在桌面上走**：不是原地踏步，而是窗口真的水平移动 100–300px。
2. **松手有惯性**：窗口带末速度落回地面线，落地有弹性，而不是瞬移回原位。

三条硬约束决定了实现形状：

- **不能用动画里的 root motion**：44 段 clip 都是原地动画（根骨平移 ≤0.003 单位），拿它推窗口会漂移且不可控。
- **不能再开定时器**：§12 明确"指针轮询 单一定时器 ~16ms，同时服务穿透状态机与拖拽位移；不得再开第二个"。
- **穿透不能因为窗口在动而丢点击**：R-6 的判定依赖窗口矩形，位移必须让判定在同一 tick 看到新位置。

## 决策

### D1 调度在 render，执行在 shell，用命令 + 事实连接

§4.1 规定 `walking` 的"唯一置位者"是 `render` 的内部调度器，而窗口只有 `shell` 能动（§7.2）。因此：

- **`cmd:walk`（新命令通道，render → main）**：`{ phase:'start', direction, distancePx }` / `{ phase:'stop' }`。只承载"往哪边走、走多远"，**不放速度/加速度/弹簧参数**（与 `cmd:drag` 只承载原始指针事实同一条原则）。
- **`motion_ended`（新事件，shell → render）**：`{ kind:'walk'|'settle', reason:'arrived'|'edge'|'interrupted'|'rest' }`。这是**事实**不是命令：位移的物理在 shell，状态在 render，没有这条事实 render 只能自算时长猜，撞边时会出现"窗口停了、腿还在走"。

为什么不让 shell 自己调度：那会把 `walking` 的置位者改成 shell，违反 §4.1，也会让"LLM 不能命令角色乱跑"（§4.4 规则）失去一层保障——调度必须留在渲染侧的内部时钟里。

### D2 物理是纯函数，放在 `shared/`

`src/shared/motion.ts` 三个纯函数，输入状态 + dt → 输出新状态，不读时钟、不碰 Electron：

| 函数 | 用途 | 关键点 |
|---|---|---|
| `stepWalk` | 行走 | 期望速度取 `min(巡航, √(2·a·d))`（刹车曲线），到点吸附、绝不冲过头 |
| `stepSpring` | 弹簧-阻尼 | 半隐式欧拉 + **4ms 固定子步长**（k=200 时 ω·h≈0.06 仍稳定）；dt 上限 50ms |
| `stepSettle` | 整段回弹 | 竖直用 `stepSpring` 拉向地面线，触地按 `restitution` 反弹一次；水平只做 `e^(-friction·t)` 惯性衰减 |

参数集中在 `constants.ts`（k=140、c=12、恢复系数 0.28、摩擦 5、巡航 110px/s、加速度 520px/s²），全部有单位与出处注释。

### D3 `settling` 是 Physics 状态，不是"回弹动画播完没有"

`PhysicsState` 从 `'dragged'` 扩为 `'dragged' | 'settling'`：

- 进入：`drag_released`（D-6 的"松手"）。
- 退出：`motion_ended{kind:'settle'}`（弹簧收敛或撞到兜底时长）。
- 期间：`intent()` 与 `head_patted()` 被 HFSM 直接拒绝（用户要求"回弹期间不接受新事件打断"），**唯一例外是重新拖拽**——`drag_started` 是更高优先级的事件，会把 `settling` 直接改成 `dragged`。

`RenderState.physics` 因此会出现第三个取值。这是契约 minor 升级（§4.1 + §7.1），不是"私自加状态名"。

### D4 渲染侧不参与物理，只播动画

回弹时窗口自己在落，角色若再叠一层 y 偏移就是"双重下落"。所以 render 在 `settling` 期间只做两件事：

1. `drag_released` 立刻用 0.45s 把 `Formation_Pickup` 淡回 `Cafe_Idle`（覆盖整段下落，落地时已经是站姿）；
2. `motion_ended{kind:'settle'}` 时加一次 **180ms / 6% 的下蹲缓冲**（复用既有的 `reaction.squash` 通道，不写骨骼）。

### D5 契约增量（1.5.0 → 1.6.0）

| 位置 | 变更 |
|---|---|
| §3.5 | 新增 `cmd:walk`（render → main，命令） |
| §4.1 | `dragged` 行补"退出条件 = `drag_released` 且回弹结束"；新增 `settling` 行 |
| §6.3 | 新增 `motion_ended`（唯一生产者 `shell`） |
| §7.1 | `PhysicsState = 'dragged' \| 'settling'` |
| §5.1/§5.3 | Physics 层状态集合补 `settling`；必测组合补"回弹期间 intent 被拒" |
| §12 | 明确位移复用同一个 16ms 定时器 |

### D6 复用唯一的 16ms 轮询器

`createPointerPoller` 新增两个可选依赖：`onTick(now)`（先推进位移，再读窗口矩形做穿透判定）与 `isSettling()`（R-8 要求回弹期间保持非穿透）。顺序是刻意的：**位移必须先于 `getContentBounds()`**，否则本 tick 的穿透判定用的是上一帧位置。

窗口在动的时候，穿透判定天然正确：FSM 每 tick 用最新矩形重新算"光标在不在窗口内"，探针坐标也是相对新矩形的。回弹期间 `isSettling()` 让 FSM 走 `interactive` 分支（不探测、不切穿透），与 R-8 一致。

### D7 撞边掉头

行走目标先按"与窗口重叠面积最大的工作区"（不用 `getDisplayNearestPoint`，D-7 同口径）夹到 `[area.x, area.x+area.width-width]`。若该方向已经贴边（夹完等于原地），**掉头走反向**；两侧都没有空间才发 `motion_ended{reason:'edge'}` 并停下。

## 替代方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 用动画 root motion 推窗口 | 不用写物理 | 44 段都是原地动画，根骨位移 ≤0.003；会漂移、无法控制距离 | 否（用户红线） |
| shell 自己定时调度行走 | 少一条通道 | `walking` 置位者变成 shell，违反 §4.1；LLM 侧防线少一层 | 否 |
| render 直接调 `BrowserWindow.setPosition` | 省掉 IPC | 渲染进程不该碰窗口（§7.2），sandbox 下也拿不到 | 否 |
| 回弹在 render 里算、窗口不动 | 改动最小 | 用户要的是"窗口真的落下去"，角色在窗口里下坠会穿出窗口边界 | 否 |
| 引入物理引擎（matter/rapier） | 功能全 | 为一个一维弹簧引入 WASM 依赖，违反"不引入外部物理引擎"与 T-3 | 否 |
| 弹簧-阻尼纯函数 + 单定时器（本方案） | 无依赖、可单测、手感可调 | 参数要手调；回弹是"一维"的，没有真实碰撞 | **是** |
| `settling` 只做内部标志、不进 `RenderState` | 不用升契约 | 自检与 shell 看不到回弹状态，无法断言 R-8 | 否 |
| 新增 `settle_started` + `settle_ended` 两个事件 | 语义更细 | 事件表膨胀；`drag_released` 已经隐含 started | 否（用一个 `motion_ended` 带 `kind`） |

## 后果

**正面**

- 角色真的会在桌面上走：自检实测窗口 `x` 从 0 → 44（≥20px 断言），并能在撞边时掉头。
- 松手有惯性：自检把窗口抬高 220px 后松手，实测 `liftedY=0 → fallingY=72 → 落地 232`（工作区地面线），落地后加 180ms 下蹲。
- 位移与穿透共用一帧：移动过程中点击判定不会因为"窗口已经动了、矩形还是旧的"而错位。
- 物理全部可单测（12 条），手感调整只改 `constants.ts`。

**负面 / 成本**

- `settling` 让 `PhysicsState` 多一个取值，`getState()` 的消费方（目前只有自检与诊断）要能接受三态。
- 回弹是一维弹簧：不做水平碰撞，甩到屏幕边缘时只夹位置、没有"撞墙"反馈。
- 撞边只做单次掉头：窗口比工作区还宽时直接停下，不会来回踱步。
- 行走期间窗口在动，`capturePage` 截到的是运动中的一帧，人工复验时容易误判"卡住"。

**约束**

- 位移只允许由 `shell/motion.ts` 写窗口位置；`render` 只能发 `cmd:walk`。
- 物理必须是 `shared/motion.ts` 的纯函数，不得在控制器里内联积分。
- 不得新增定时器（§12）；位移挂在既有 16ms 轮询器的 `onTick` 上。
- `settling` 期间不得接受 `intent` / `head_patted`；重新拖拽是唯一出口。
- 不得用动画 root motion 驱动窗口（用户红线）。
