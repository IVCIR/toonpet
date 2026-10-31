# 0002. 命中判定与点击穿透的 Windows 实现

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-10-27 |
| 决策者 | 项目所有者 |
| 关联 | `CONTRACTS.md` §3.3（R-2、R-4～R-7）、§3.6（P-1、P-2）、§12；修正 1.0.0 的 R-2/R-4/R-7 |

## 背景

契约 1.0.0 的 §3.3 按"渲染侧监听 `mousemove` + 逐像素读 drawing buffer"来写命中，实测有两条平台事实把它推翻：

1. **`setIgnoreMouseEvents(true, { forward: true })` 的 `forward` 只在 macOS 生效。** Windows 上窗口一旦穿透，渲染进程收不到 `mousemove`，也就不存在"光标移回模型上时自动恢复交互"的事件。任何依赖渲染侧鼠标事件的恢复逻辑在 Windows 上都是死代码。
2. **`gl.readPixels` 读 drawing buffer 是同步阻塞的，且跨帧读取必须开 `preserveDrawingBuffer: true`。** 在光标处读全分辨率 alpha，等于每次取样 stall GPU；开 preserve 又带来常驻的显存与合成开销。两条路都不适合一个需要长期驻留桌面的进程。

同时，窗口本身是"几乎全透明、只有角色不透明"的，命中精度不能退化成矩形，否则整块透明区域都会吞掉桌面点击。

## 决策

1. **命中以 CPU 侧 alpha 掩膜为准。** 渲染侧把角色渲染到独立的 `128 × 72` 离屏 RenderTarget（RGBA），用 `readRenderTargetPixels` 读回，得到每个单元的 alpha。光标位置按掩膜坐标做**双线性插值**，`alpha ≥ 0.5` 判为命中。
2. **禁用两条错路：** 不对 drawing buffer 调 `readPixels`；不开启 `preserveDrawingBuffer`。
3. **穿透恢复由主进程驱动。** 主进程以 ~16ms 轮询 `screen.getCursorScreenPoint()`；光标进入窗口矩形 → 发 `cmd:probe{x,y}` → 渲染侧用最新掩膜判定 → 回 `cmd:interactive{hit}` → `hit=true` 关闭穿透并保持，`hit=false` 维持穿透。
4. **迟滞与去抖：** 离开判定用窗口矩形外扩 8px；穿透状态每次切换后 100ms 内不再切换；光标停在同一掩膜单元内复用判定缓存。
5. **拖拽期间强制非穿透**，直到 `drag_released` 且回弹结束；拖拽期间暂停掩膜采集以省 GPU。
6. **共用一个轮询器：** 穿透状态机与拖拽位移（`D-5`）必须共用同一个 ~16ms 定时器，不允许出现两个并行的光标轮询。
7. **精度上限即 `128 × 72`**，不再追求逐像素命中；头部区域判定复用同一张掩膜（alpha 包围盒顶部 22%）。

## 替代方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 每帧（或每次移动）对 drawing buffer 调 `readPixels` 取全分辨率 alpha | 精度最高 | 同步 stall GPU；跨帧需 preserve；长期驻留场景帧率不稳 | 否 |
| 开 `preserveDrawingBuffer` 后按光标读单点 | 无需离屏渲染 | 常驻显存与合成开销；仍是一次同步读；影响整条渲染链 | 否 |
| 渲染侧监听 `mousemove` 自主切换穿透 | 实现最简单，零 IPC | Windows 上穿透后收不到事件，功能直接失效（仅 macOS 可行） | 否 |
| 主进程按窗口矩形命中，进入即取消穿透 | 无渲染侧参与，零延迟 | 透明区域的桌面点击会被窗口吞掉，桌面基本不可用 | 否 |
| 掩膜 + 主进程轮询 + `cmd:probe`（本方案） | 成本可控、精度够、不吞桌面点击；掩膜同时服务头部判定 | 有 1–2 帧判定延迟，快速点击可能落空 | **是** |

## 后果

**正面**
- 命中精度对桌宠足够（透明发梢会略宽松，肉眼无感），且不存在 GPU stall。
- 掩膜一物两用：点击判定 + 头部区域估算，省掉一套额外逻辑。
- 穿透状态机集中在主进程，只有一个地方能改 `setIgnoreMouseEvents`，不会出现两侧抢状态。
- 完全避开 `preserveDrawingBuffer`，渲染管线保持默认配置。

**负面 / 成本**
- 光标进入窗口到可交互有 1–2 帧延迟（16–32ms）；该窗口内的快速点击会落到桌面。这是**已知残余缺陷**，写进 `CONTRACTS.md` §12，不得声称已解决。
- 多一次 `cmd:probe` / `cmd:interactive` IPC 往返，需要保证 ≤ 1 帧返回。
- 掩膜分辨率低，边缘约 3–10px 误差；发梢、指尖可能点不中。

**约束**
- 禁止对 drawing buffer 使用 `readPixels`（任何频率）。
- 禁止开启 `preserveDrawingBuffer`。
- 禁止渲染侧自行调用 `setIgnoreMouseEvents`。
- 禁止新增第二个光标轮询定时器。
- 掩膜分辨率不得低于 `64 × 36`；如需下调，必须新写 ADR 并同步更新 `CONTRACTS.md` §13 X-9。
