# 0028. 前台窗口吸附（Win32）与 `sitting` 状态

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-11-01 |
| 决策者 | 项目所有者 |
| 关联 | 契约 §3.2（窗口规格/锚点）、§3.3（穿透 D-8 / R-6）、§3.4（D-2/D-5/D-6/D-7）、§4.1（新增 `sitting`）、§5.1/§5.3、§6.3（`snap_applied` / `snap_released`）、§7.1（`PhysicsState`）、§7.3（render 订阅）、§11、§12（单一定时器）；ADR 0002（轮询器）、ADR 0003（焦点）、ADR 0004（拖拽/沉降）、ADR 0014（HFSM/片段）、ADR 0023（官方片段）、ADR 0024（位移与回弹） |

## 背景

最初需求里有一条核心交互一直没做：**坐在别的应用窗口边缘**。当前实现里角色只认"屏幕工作区底边"这一条地面线——`walking` 沿水平走、`settling` 落到工作区地面，窗口位置与"其它应用的窗口"毫无关系。

本轮要做成真的：

1. 桌宠能吸附到**当前前台应用**（浏览器 / VSCode / 记事本……）的**下边缘**或**上边缘**，水平居中；
2. 吸附后进入**坐姿**（`sitting`），停止 `walking` 调度，跟随目标窗口移动/缩放；
3. 拖她、点她、目标窗口消失/全屏，都能立刻解除吸附并恢复地面站立；
4. **不强依赖原生编译**：拿不到前台窗口边界时退回"物理贴边法"（吸附到工作区边缘 / 拖到上沿自动吸）。

三条硬约束决定实现形状：

- **零按次计费**（§10.1）：只用本机 Win32 API，不联网、不新增任何按次调用。GetForegroundWindow 级别的系统调用没有成本。
- **不破坏穿透判定（D-8）**：吸附只改窗口位置，`setIgnoreMouseEvents` 的唯一调用点仍是 `shell/index.ts` 的 `applyPassthrough`。
- **不新开定时器**（§12）：跟随目标窗口的轮询必须挂在既有 16ms 指针轮询器的 `onTick` 上。

## 决策

### D1 Win32 通过 `koffi`（N-API 预编译），并且是**可选**依赖

| 方案 | 结论 |
|---|---|
| `node-ffi-napi` | 否：需要 node-gyp 现场编译，Electron ABI 一变就得重编（本项目在 ADR 0006/0007 已经踩过原生模块的坑） |
| 手写 N-API C++ 插件 | 否：用户红线"不引入复杂的 C++ 插件（除非绝对必要）"；为 3 个 API 维护一个插件不划算 |
| 起一个 PowerShell 子进程 P/Invoke | 否：每次按键都要 ~200–400ms 的进程启动，且把"窗口几何"变成文本协议（ADR 0027 的教训是"不要用 shell 做文本往返"） |
| **`koffi`（本方案）** | **是**：纯 N-API 8，Windows x64 预编译在 `@koromix/koffi-win32-x64` 里（`koffi.node` 1.0MB），**装包即用、不需要编译器**；只在本机加载 `user32.dll` / `dwmapi.dll` |

`koffi` 写在 `optionalDependencies`：装不上、加载失败、架构不对，全部在 `try/catch` 里折算成 `supported=false`，应用照常启动并进入**工作区贴边模式**（D7）。这是"不强依赖原生编译"的落地方式——原生模块是**增强**，不是**前置**。

依赖审计（§10.1 `$7`：它会在运行时产生计费调用吗？）：不会。koffi 只做本机动态链接，无网络、无遥测、无后台线程。

### D2 前台窗口边界：DWM 无边框矩形 → 物理像素 → DIP

```
GetForegroundWindow()
  → IsWindowVisible / IsIconic 过滤
  → DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS=9, &rect, 16)   // 首选：不含阴影/边框
  → 失败则 GetWindowRect(hwnd, &rect)                                      // 退路
  → screen.screenToDipPoint(左上) / screen.screenToDipPoint(右下)          // 物理 → DIP
```

为什么用 `DWMWA_EXTENDED_FRAME_BOUNDS`：`GetWindowRect` 在 Win10/11 上会把不可见的调整边框和阴影算进去（实测同一窗口两者相差 3–5px），吸附会留一条缝。DWM 矩形是"肉眼看到的窗口边界"。

DPI 换算**只走 Electron 的 `screen` API**（`screenToDipPoint` 逐点换算，天然支持混合 DPI 与负坐标的多显示器），不自己算 `devicePixelRatio`：Windows 的窗口矩形是物理像素，而 Electron 的 `setPosition` / `getBounds` / `workArea` 全是 DIP，自己换算会在 125%/150%/200% 缩放下错位。

### D3 拒绝条件（吸附前校验）与用户提示

| 条件 | 判定 | 结果 |
|---|---|---|
| 前台是**全屏**窗口（视频/游戏） | 窗口矩形覆盖了某台显示器的 `bounds`（容差 2 DIP） | 拒绝，`reason='fullscreen'` |
| 前台是**我们自己**（主窗口/输入条） | `getNativeWindowHandle()` 比对 | 拒绝，`reason='own-window'` |
| 前台是**桌面/任务栏**（`Progman` / `WorkerW` / `Shell_TrayWnd`） | `GetClassNameW` 名单 | 拒绝，`reason='shell-window'` |
| 坐标异常（NaN/Inf/宽高 ≤ 0）或窗口太小（< 80×40 DIP） | 纯函数校验 | 拒绝，`reason='invalid-rect'` |
| 吸附后**竖直方向**被 D-7 夹回超过 40px（说明这条边缘线根本放不下她，例如窗口上沿离屏幕顶只有 100px，而她要 720px 才能"坐在上面"） | 纯函数校验 | 拒绝，`reason='geometry'` |
| 正在 `walking` / `settling` / `dragged` | `motion.kind !== 'idle'` 或手势按下 | 拒绝，`reason='busy'`（只记日志，不打扰用户） |

"给出提示"的实现：托盘存在时 `tray.displayBalloon({ title, content })`（Windows 通知），否则只写 `WARN` 日志。**不新增事件、不新增 IPC 通道**——提示是 shell 自己的 UI 责任，与 render 的状态无关。

### D4 触发方式：全局热键 `Ctrl+Shift+S` + 托盘的"吸附/离开"两项

- 热键沿用 ADR 0016 D4 的三级降级模式：`Control+Shift+S` → 被占用降级 `Control+Alt+S` → 都失败只记 ERROR 并继续启动（可换成 `PET_SNAP_HOTKEY`）。
- 托盘菜单新增两项（固定标签，顺序在"退出"之前）：`吸附到前台窗口` / `离开窗口边缘`。托盘项的点击**不改变**主窗口焦点（`focusable` 恒 false，§3.2）。
- 吸附/解除**全部在主进程完成**：shell 自己算目标、自己 `setPosition`；render 只收"事实"（D5）。

### D5 `sitting` 是 Physics 层的第三个状态，用两条事件告知 render

`PhysicsState` 从 `'dragged' | 'settling'` 扩为 `'dragged' | 'settling' | 'sitting'`。

| 事件 | 生产者 | 载荷 | 触发时机 |
|---|---|---|---|
| `snap_applied` | `shell` | `{ edge: 'top'|'bottom', source: 'foreground'|'workarea' }` | 窗口已经落到目标位置**之后** |
| `snap_released` | `shell` | `{ reason: 'dragged'|'clicked'|'command'|'window-gone'|'fullscreen' }` | 吸附解除**之后** |

为什么放 Physics 而不是 Base：Base 的状态由 render 的内部调度器置位（`idle`/`walking`），而吸附的置位者必须是 shell（它才知道前台窗口是谁）。Physics 层的语义本来就是这个——"窗口位置被外部接管"：`dragged` 是手、`settling` 是回弹、`sitting` 是别的应用窗口。三条都属于"人/系统在动窗口"，优先级高于 Overlay/Base，与 §5.1 的分层一致。

`snap_released` 只在自己仍是 `sitting` 时生效（`physics === 'sitting'` → 退出）。这样 `drag_started` 先把它变成 `dragged` 之后，紧随其后的 `snap_released{reason:'dragged'}` 不会把 `dragged` 打回 `idle`。

### D6 跟随：复用唯一的 16ms 轮询器，节流到 ~120ms

吸附后每 120ms（`PET_SNAP_FOLLOW_MS`）用**同一个句柄**重新读一次矩形：

- 句柄失效 / 最小化 → `release('window-gone')`；
- 矩形变化（移动/缩放）→ 用同一个 edge 与新的边界重算位置并 `setPosition`；
- 重算失败（比如窗口变成全屏）→ `release('fullscreen')`。

不跟随"新的前台窗口"：用户切到别的应用时把桌宠整体搬走会像"绑架"，而且会丢掉"她坐在这扇窗上"的语义。跟随的永远是**被吸附的那一扇窗**。

轮询挂在既有的 16ms `onTick` 上（§12 不许开第二个定时器），控制器内部用时间戳节流；一次 Win32 调用是微秒级，120ms 一次对 CPU 无影响。

### D7 回退：工作区贴边模式（没有 koffi 时的"物理贴边法"）

`supported=false`（koffi 缺失/加载失败，或 `PET_SNAP_MODE=workarea`）时：

- 热键/托盘 → 吸附到**桌宠当前所在显示器工作区的下沿**，`source='workarea'`；
- 拖拽松手时若窗口底边离工作区下沿 ≤24px → 直接坐在这条边上（她本来就落在这条线上，`settling` 只是换成"坐下"）；
- `PET_SNAP_EDGE=top` 在工作区模式下放不下（上沿以上没有 720px 空间），自动退回下沿并记 WARN。

**上沿为什么不能用在工作区**：`y = 边缘线 - 窗口高`，工作区上沿的 `y = -720`；D-7 的"整窗可见"夹取会把它拉回 `0`（差 720px > 40px 容差），于是按 `geometry` 拒绝。这是几何事实，不是实现取巧。

### D8 坐姿：用官方片段 `CH0335_my_event088_pastmemory_01` 的 11.2–13.5s 窗口，缺片时程序化降级

44 段动画里没有名字带 `Sit` 的片段，但逐段时间轴探查（`tools/clip-preview` 胶片条，本轮实测）发现回忆片段 `CH0335_my_event088_pastmemory_01`（38.25s）在 **11.2–13.5s** 是一段正面坐姿：屈膝坐在低处、双手在胸前，之后 ~14.6s 起身。取这一段：

- **`LoopOnce` + `clampWhenFinished=true`**：播完停在最后一帧（坐稳），不自动回 Idle（那是 `playOnce` 的行为，会把她变回站姿）；
- 循环会看到"抬头 → 低头"的跳变，所以不循环；
- 静态帧会显得死板，故在 `sitting` 期间叠加**程序化呼吸**（`animationRoot` 的 1.2px / 3.6s 正弦漂浮）。

**这个片段有两处必须修正的资产事实**（不修就是"她悬在窗口左上角、光环留在窗口中间"，第一版实测如此）：

1. **身体被搬走**：片段把 `Bip001` 身体相对根节点平移（身体包围盒 cx≈-0.0035、minY≈+0.0058 单位，在 57538 ppm 下约 200px / 335px）。处理：加载期临时切到坐姿片段（淡入 1ms）、CPU 蒙皮采一次身体包围盒，之后每帧把 `animationRoot` 补偿到"身体中心 = 窗口中线、最低点 = 窗口底边"（诊断 `sit.offsetPx`，实测 x≈+218、y≈-323）。
2. **光环不跟头**：`CH0335_Halo` 挂在 `HaloRoot` 下，是普通节点、不在骨架里，**任何片段都不驱动它**。处理：加载期标定"光环相对头骨"的偏移，之后每帧把 `HaloRoot` 挂到头骨（`updateHalo`）。这一条对其它片段也是正向修正（角色被拎起时也不会再把光环落在原地）。

片段里的"座位"（粉色线框道具）是 `CH0335_Prop_Outlline`，已被 `HIDE_ATTACHMENTS` 隐藏——正好只剩她本人，坐在窗口边缘。

**降级**：片段缺失（换模型）→ 播 `held`（被拎起的悬空姿态）+ 下沉 24px + 大腿骨 `Bip001 L/R Thigh` 弯曲 0.45rad（走骨骼仲裁器，叠加在动画基底上）。用户原始建议（"把悬空姿态的 Y 轴压低，腿稍微弯曲"）就是这条路径。

> **后续（ADR 0029）**：`playHold` 停帧暴露了骨骼仲裁的一个隐藏缺陷——three 的 `PropertyMixer.apply()` 在姿态不变时会跳过写入，旧判据因此把上一帧的偏移当成新基底，导致坐姿时"头疯狂打转"。修法是 `capture()` 前后快照 + 阈值 1e-6，与本 ADR 的坐姿方案互不影响（停帧本身没有问题）。

### D9 解除吸附的四条路径

| 路径 | 谁发起 | 结果 |
|---|---|---|
| 拖拽她 | `cmd:drag down` → shell 先 `release('clicked')`，越过 4px 后 `drag_started` | `sitting` → `dragged`，松手照常回弹到地面线 |
| 点一下她 | 同上（`clicked`），若位移 ≤4px 就只有解除 + 摸头/点击反应 | 回到 `idle` 站立 |
| 托盘"离开窗口边缘" / 再次按热键 | shell | `release('command')` |
| 目标窗口没了/最小化/变全屏 | 跟随轮询 | `release('window-gone' / 'fullscreen')` |

解除后**窗口不移动**：她就在原地站起来（"恢复默认地面站立"）；若用户接着拖她，回弹会把她落到工作区地面线。

### D10 契约增量（1.8.0 → 1.9.0）

| 位置 | 变更 |
|---|---|
| §4.1 | 新增 `sitting` 行（Physics 层，置位者 shell 的事件） |
| §5.1 | Physics 层状态集合补 `sitting`；说明它同样高于 Overlay |
| §5.2/§5.3 | 补"吸附时说话照常（Overlay 叠加）""吸附时被拖拽 → 立即转 `dragged`" |
| §6.3 | 新增 `snap_applied` / `snap_released`（唯一生产者 `shell`） |
| §7.1 | `PhysicsState = 'dragged' \| 'settling' \| 'sitting'` |
| §7.3 | render 订阅列表补 `snap_applied` / `snap_released` |
| §3.5 | 不新增通道（吸附是 shell 内部行为，见 D4） |
| §11 | 新增两行：koffi 不可用 → 工作区贴边模式；前台全屏/坐标异常 → 拒绝吸附 + 托盘提示 |
| §12 | 跟随复用同一个 16ms 定时器，节流 ~120ms |
| §13 | 非目标补一条：不跟随"新的前台窗口"、不做窗口内的逐像素定位 |

## 替代方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| `node-ffi-napi` | 生态老牌 | 需要 node-gyp + 本机 MSVC；ABI 随 Electron 变，一次升级就要重编 | 否 |
| 自写 C++ N-API 插件 | 完全可控 | 用户红线；为一个 3 函数 FFI 维护插件 | 否 |
| PowerShell + P/Invoke 子进程 | 零依赖 | 每次 200–400ms；文本协议；ADR 0027 已否掉 shell 文本往返 | 否 |
| 纯 `screen.getCursorScreenPoint` 猜测 | 无依赖 | 拿不到别的窗口的矩形，功能不成立 | 否 |
| **koffi（可选）+ 工作区贴边回退** | 装即用；失败可降级；单测友好 | 多一个 optional 依赖；`@koromix/*` 平台包要考虑打包 | **是** |
| 吸附状态放 Base，让 render 自己排期 | 少一条事件 | 置位者变成 render，它看不到前台窗口；违反 §4.1 的"唯一置位者" | 否 |
| 用 `drag_released` 兼职表达"解除吸附" | 省一个事件 | 语义错位（她没被拖）、无法表达 `window-gone` | 否 |
| 坐姿改程序化（只用 Y 压低 + 弯腿） | 不依赖片段 | 观感差一档；资产里明明有真坐姿 | 否（作为**降级**保留） |
| 吸附后跟随**新的**前台窗口 | 看起来更"智能" | 用户切窗口时桌宠会被整体搬走；语义从"坐在这扇窗"变成"追着焦点跑" | 否 |

## 后果

**正面**

- 需求闭环：按 `Ctrl+Shift+S`，她跳到记事本/浏览器/VSCode 的下边缘并坐下；目标窗口移动/缩放时她跟着走。
- 零成本：只用本机 Win32 + Electron `screen`，无网络、无计费调用。
- 可测：几何/拒绝条件/解除路径都是纯函数（单测），端到端由自检断言（窗口坐标、`physics='sitting'`、动作名、桌面截图）。
- 可降级：koffi 装不上时功能退成"工作区贴边"，不会启动失败。

**负面 / 成本**

- 多一个可选原生依赖（`koffi` + `@koromix/koffi-win32-x64`，约 1.1MB）。打包时必须把 `node_modules/koffi` 与平台包一起带上，且 `build.mjs` 要把它标成 `external`。
- 跟随是"按句柄"的：目标窗口被销毁再重建（部分应用全屏切换会重建 HWND）时，吸附会以 `window-gone` 结束。
- 全屏判定用"覆盖整块显示器"的矩形近似：带黑边的无边框全屏（如某些游戏）可能不判为全屏；此时吸附位置会被 D-7 钳制或拒绝（`geometry`），不会画到屏幕外。
- 坐姿是"切片"：回忆片段最后一帧是**闭眼放松**姿态（观感安静），换模型要重新标定时间窗口（`clip-bank.ts` 里写死）。
- 坐姿片段自带的身体平移必须做**运行期补偿**（加载期采样一次包围盒）；否则她悬在窗口左上角、光环留在原地（第一版实测）。
- 吸附期间窗口仍在屏幕最上层（`screen-saver`），她的身体会盖住目标窗口的一部分——这正是"坐在窗口上"的观感，但截图/录屏里会挡住内容。
- 自检拿不到系统前台权（主窗口 `focusable=false`），几何断言依赖"脚本化前台"注入；真实 Win32 路径另有一条断言覆盖（读到的前台矩形自洽）。

**约束**

- 只允许 `shell` 写窗口位置；`render` 不得自己 `setPosition`，也不得自己决定吸附目标。
- `sitting` 只由 `snap_applied` / `snap_released` / `drag_started` 进出（H-4 的延伸）。
- 不得新增 IPC 通道（吸附不需要 render 参与决策）。
- 不得新增定时器；跟随只能挂在既有的 16ms `onTick` 上。
- 不得因为吸附而修改主窗口任何属性（`focusable` / 尺寸 / `alwaysOnTop` 层级）。
- 不得在吸附路径里做任何网络或文件 IO。
