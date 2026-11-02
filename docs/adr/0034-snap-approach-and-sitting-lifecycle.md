# 0034. 吸附接近（`snap_approach_started`）与 `sitting` 生命周期

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-11-02 |
| 决策者 | 项目所有者 |
| 关联 | 契约 §3.5（通道）、§4.1（`sitting`）、§5.1/§5.3、§6.3（事件）、§7.1（`RenderState`）、§7.3（render 订阅）、§11、§12（单一定时器）、§13；ADR 0024（位移复用 16ms 轮询器）、ADR 0028（吸附与坐姿）、ADR 0035（拖拽手感） |

## 背景

ADR 0028 把“坐到前台窗口边缘”做成了真的，但进入方式是**一次 `setPosition` 瞬移**：`snap.ts` 的 `apply()` 直接写最终位置，然后发 `snap_applied`；render 在同一帧 `playHold('sit')`。用户看到的是“她闪现到窗沿并瞬间坐下”，没有因果过程。

本轮要求（用户已确认四个决策）：

1. 检测到吸附目标后，先“走过去”或“跳过去”，到达边缘后再坐下；
2. 接近过程不得新增状态机状态（复用 `sitting`）；
3. 不新增定时器，接近倒计时挂在既有 16ms 轮询器上；
4. 坐姿不锁死上身（视线/口鼻/呼吸继续），解除时按原因播放“惊跳起身”；
5. 修改契约前先出本 ADR。

## 决策

### D1 新增事实事件 `snap_approach_started`（不新增 IPC 通道）

| 项 | 值 |
|---|---|
| 名称 | `snap_approach_started`（`snap_approach` + 过去式 `started`，符合 §6.2 N-1） |
| 唯一生产者 | `shell` |
| 消费者 | `render` |
| 触发时机 | 已算出吸附目标、且决定“不瞬移”之后，窗口开始移动之前/同一 tick |
| 载荷 | `{ edge: 'top' \| 'bottom'; source: 'foreground' \| 'workarea'; mode: 'walk' \| 'leap'; distancePx: number; durationMs: number }` |
| 通道 | 既有 `evt:broadcast` 白名单（§3.5 / §6.4 E-1），**不新增 `cmd:*`** |

`mode` 只表达“这一段接近是水平走还是带高度的跳”，不把速度、加速度、弹簧参数放进载荷（与 `cmd:drag` / `cmd:walk` 同一原则）。`distancePx` 用于日志与 render 选择步频，`durationMs` 让 render 能把走路/跳跃动作与窗口位移对齐。

### D2 `sitting` 从“已经坐下”扩展为“吸附生命周期（接近 + 落座）”

不新增 `approaching` / `jumping` 状态（用户硬约束），而是给 `sitting` 增加一个**阶段**：

```
snap_approach_started  → Physics = sitting（approach 阶段）
snap_applied           → Physics = sitting（seated 阶段；载荷/时机不变）
snap_released          → Physics 退出 sitting
drag_started           → Physics = dragged（最高优先级，直接接管）
```

- `getState()` 的字段与取值集合**不变**，`RenderState` 不增删字段。
- 为什么不让接近期间保持 `physics=null`：`getState()` 会在最长 0.9s 内报告“她站着待机”，而窗口正在移动，属于状态说谎；`sitting` 本来就是“窗口位置被外部接管”的 Physics 状态，扩展为“吸附进程”是语义上最小的一步。
- 为什么不在接近期用 `walking`：`walking` 的定义是“render 内部调度器自主触发的水平行走”，不允许外部驱动（§4.4 规则），把 shell 的吸附接近塞进去会破坏唯一置位者。
- `snap_applied` 的语义**不变**：仍然是“窗口已经贴到目标边缘并水平居中之后”；只是它现在表示“落座阶段开始”，而不是“sitting 状态开始”。

### D3 接近运动：纯数学、同一定时器、倒计时

`snap.ts` 在既有 `tick(now)` 中推进，不新建 `setInterval` / `setTimeout`：

```
t += dt / durationMs
p = clamp(t, 0, 1)
position = from + (to - from) * ease(p)      // walk
position = ... + arc(p)                       // leap
t >= 1 → commit(to) → 发 snap_applied
```

- **walk**：`|dy| <= 16px`，水平走到目标 x；用 `stepWalk` 的刹车曲线（复用 `shared/motion.ts`）或 `easeInOutCubic`。
- **leap**：需要升高时，先水平到目标 x 下方，再按短弹道/缓动弧升到目标 y；总时长 300–900ms。
- `durationMs` 由距离决定并钳制在 `SNAP_APPROACH_MIN_MS..SNAP_APPROACH_MAX_MS`（常量在 `shared/constants.ts`）。
- 接近期间 `snap.tick` 暂停“跟随目标窗口”的 120ms 节流，避免追着移动窗口跑；到达后恢复跟随。

### D4 目标锁定与解除语义

接近一旦开始，**锁定目标矩形**（不再每 tick 重读）：

| 事件 | 处理 |
|---|---|
| `drag_started` | 立即取消接近；`dragged` 接管（用户手在，安全） |
| 指针按下（`clicked`） | 若尚未越过 4px，**延迟**到到达后再 `snap_released{clicked}`，避免半空冻结 |
| 托盘/热键解除（`command`） | 延迟到到达后再释放 |
| 目标消失/最小化/全屏（`window-gone` / `fullscreen`） | 接近期间不中断；到达后由跟随轮询（≤120ms）释放 |
| 已在 `sitting` 时再次吸附 | 保持 ADR 0028 的直接重定位（本轮不做“从窗沿再跳一次”），列为非目标 |

“延迟释放”的理由：接近是 300–900ms 的短过程，中途取消需要额外的“半空坠落/回地面”状态；本轮选择让过程走完再按原因释放，避免引入 `settling` 之外的第三条下落路径。唯一例外是拖拽——用户的手已经接管，必须立即响应。

### D5 render 的表现

| 事件 | render |
|---|---|
| `snap_approach_started` | `hfsm.snapApproaching(now)` → Physics=`sitting`；按 `mode` 播 `walk` 或 `happy`/跳跃姿态；停止行走调度 |
| `snap_applied` | `hfsm.snapApplied(now)`（仍是 `sitting`）；`playHold('sit')` + 身体平移补偿；进入坐姿活体（视线/呼吸） |
| `snap_released` | `exitSit`；按 `reason` 播惊跳/起身（`window-gone`/`fullscreen` 最强） |
| `drag_started` | 既有逻辑： clears sitting、播 `held`、Physics=`dragged` |

`snap_approach_started` 只影响“播什么”，不影响口型通道（§5.2 最高优先级）：接近期间如果正在说话，口型照常驱动。

### D6 契约增量（1.12.0 → 1.13.0）

| 位置 | 变更 |
|---|---|
| §4.1 | `sitting` 行的定义与进入条件改为“`snap_approach_started` 进入吸附进程；`snap_applied` 表示已落座”；退出条件不变 |
| §5.1 | Physics 层说明补“`sitting` 含接近阶段” |
| §5.3 | 补一行“吸附接近中被拖拽 → 立即转 `dragged`” |
| §6.3 | 新增 `snap_approach_started`（唯一生产者 `shell`，消费者 `render`） |
| §7.3 | render 订阅列表补 `snap_approach_started` |
| §11 | 补“接近中目标消失/被拖拽/取消”的降级行 |
| §12 | 补“接近倒计时挂在既有 16ms `snap.tick` 上，不新建定时器” |
| §13 | 补非目标 X-12：不从窗沿再次跳向另一扇窗（保持直接重定位） |
| `RenderState` | **不增删字段** |

## 替代方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 接近期间保持 `physics=null`，只播临时动画 | 不改 `sitting` 语义 | `getState()` 最长 0.9s 说谎；自检无法断言“吸附进程” | 否 |
| 新增 `approaching` 状态 | 语义最干净 | 违反用户“不新增状态”硬约束；契约大改 | 否 |
| 用 `walking` 承载接近 | 复用状态 | 违反 `walking` 的唯一置位者与“不接受外部驱动” | 否 |
| 新增 `cmd:snap-approach` 命令通道 | 方向明确 | 多一条 IPC 通道；“已开始接近”本质是事实不是命令 | 否（用事件） |
| 接近中任意解除都立即中断 + 自由落体 | 响应快 | 需要第三条下落路径（非 `settling`）；半空姿态难解释 | 否（延迟到到达） |
| **`snap_approach_started` + `sitting` 生命周期（本方案）** | 无新状态、无新通道、可观测、可单测 | `sitting` 语义变宽；需要在 ADR/契约写清 | **是** |

## 后果

**正面**

- 吸附从“闪现”变成“走过去/跳过去再坐下”，因果完整。
- 接近倒计时完全在既有 16ms 循环内，零新定时器、零新依赖。
- 自检可断言 `snap.approaching === true`、`t` 单调递增、`snap_applied` 只在 `t>=1` 后发出。
- 解除仍只有 `snap_released` 一个出口，`drag_started` 仍是最高优先级。

**负面 / 成本**

- `sitting` 的含义从“已坐下”变成“吸附进程”，读 `getState()` 的人需要知道这个阶段；`sit` 内部需区分 approach/seated 两个阶段。
- 接近中目标窗口移动时，落点会短暂滞后（≤120ms 后由跟随轮询修正）。
- 接近中非拖拽解除被延迟到到达，最长 0.9s 的“她还在过去”的观感；这是为了不引入半空坠落状态。

**约束**

- 不得新增状态名；不得新增 IPC 通道；不得新建定时器。
- 接近只允许 `shell` 移动窗口；render 不得 `setPosition`。
- `snap_applied` 载荷不增字段；`RenderState` 不增字段。
- 接近期间口型通道优先级不变（§5.2）。
- 不得把接近做成新的 `intent` 或新的 `walking` 触发源。
