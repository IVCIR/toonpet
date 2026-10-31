# 模块状态（MODULE_STATUS）

| 项 | 值 |
|---|---|
| 对应契约版本 | 1.8.0（ADR 0026 第 2 版：表情改为官方差分贴图，禁止程序化绘制眼型） |
| 最后更新 | 2026-10-31 |
| 当前里程碑 | M11：走路会转身 + 表情改为**官方差分贴图驱动**（`data/expressions/`，缺图自动降级为只变嘴型）。**官方差分尚未拿到**（下载器在本机受阻，详见 ADR 0026 D6.4），当前用非官方 fixture 跑通并自证管线 |
| 维护规则 | 每个模块对话收尾时必须更新本文件；只写事实，不写计划性描述（计划进 TODO） |

## 填写口径

| 小节 | 写什么 | 不写什么 |
|---|---|---|
| 已完成 | 已合入、可运行、有验证方式的行为 | 半成品、注释掉的代码 |
| 未完成 | 契约要求但尚未实现的能力 | 契约之外的设想 |
| 对外暴露 | 实际存在的对外接口，签名照抄契约 | 内部函数 |
| 消费事件 | 实际订阅的事件及用途 | 计划要订阅的 |
| 已知坑位 | 已踩到、有现象、有规避手段的问题 | 猜测 |
| TODO | 下一步可执行的具体动作 | 愿景 |

---

## 模块：shell

### 已完成
- **字幕与语音时序对齐（本轮，ADR 0021）**：新增 `src/renderer/shell/subtitle-cue.ts`（纯逻辑、定时器注入）+ `subtitle.ts` 扩 `holdMs: null`（不自动隐藏）与 `holdFor(ms)`。`intent_resolved` **只登记**待显示文本（15s failsafe），`speech_started` 才显示完整字幕（播放期间不自动隐藏），`speech_ended{failed}` 立即显示兜底，`{completed|interrupted}` 留 1.2s 尾巴；新回复到达时先收起旧字幕；打断丢弃未显示的 pending。渲染页只做接线（`window.petSubtitle.getDiagnostics()` 是内部诊断，不进 `RenderState`）
- **系统托盘（ADR 0018 D3）**：`src/main/shell/tray.ts` + 纯规格 `tray-menu.ts`；图标是内嵌的 16×16 PNG data URL（不新增二进制资产、不联网）；菜单固定为 `呼出输入条`（复用 `openInputBar()`，不复制热键逻辑）/ `重新加载桌宠`（`mainWindow.webContents.reload()`，只重启渲染进程）/ `退出`（先 `await shell.stop()` 再 `app.quit()`，ADR 0004 D9）；`start()` 内创建、`stop()` 内先销毁；创建/销毁失败只记 WARN，不影响热键与桌宠；`shell.traySnapshot()` 为内部诊断
- **`.env` 加载器（本轮，装配层；ADR 0018 D1）**：`src/shared/env-file.ts`（约 100 行纯字符串解析，无第三方依赖、无网络）+ `src/main/env.ts`；`bootstrap()` 的第一条可执行语句调用 `loadProjectEnv()`，文件固定 `<appRoot>/.env`，**进程环境变量优先**（`setx` / 终端变量 / 自检注入压过文件），坏行只记 WARN 并忽略；日志只记键名不记值。新增 `.env.example` 全量模板、`.gitignore` 排除 `.env` / `.env.local`；`scripts/doctor.mjs` 用 `process.loadEnvFile()` 按同一语义加载并在「运行环境」报告，因此 `.env` 同时作用于 `doctor` 与 `npm start`
- **单测 219 个全绿（22 个文件）**：本轮新增 34（memory 21 / subtitle-cue 13）+ reply-validator +7（日文用例）+ orchestrator +8（记忆接入）+ config +1（记忆配置）；`tsc --noEmit` 0 错；四套自检 exit 0（主链路 61 / 输入条 27 / 语音 **30** / 缺失模型 4）
- 工程骨架：`package.json` / `tsconfig.json` / `build.mjs`（esbuild CLI 打包，产物 `dist/`），`npm run build` 通过
- 共享层（`src/shared/`）：`types.ts`（§7.1 原文）、`events.ts`（§6.3 全量事件名与载荷 + 白名单校验）、`ipc.ts`（§3.5 通道 + ADR 0004 载荷）、`constants.ts`（全部阈值的唯一出处）、`mask.ts`（CSS→掩膜映射与双线性采样，两侧唯一实现）、`geometry.ts`（D-7 多显示器钳制）
- 主窗口按 §3.2 全参数创建：`transparent` / `frame:false` / `alwaysOnTop(screen-saver)` / `skipTaskbar` / `hasShadow:false` / `resizable:false` / `backgroundColor:#00000000` / `focusable:false`
- **窗口尺寸改为由模型包围盒决定（本轮，ADR 0009 D2/D4）**：启动时读 `resolveAssetConfig()`（默认 `<appRoot>/CH0335.glb`，可用 `PET_MODEL_PATH` 覆盖），用 `glb-bounds.ts` 解析 GLB JSON 求取景包围盒（排除 `weapon|prop|brush|outline`），`computeWindowSize()` 得 **422 × 720**（高度沿用 720 设计基准）；模型缺失/解析失败才退回默认 `480 × 720`。启动日志打印：资产路径、`frame`/`scene` 包围盒、`excluded` 网格、`pixelsPerUnit`、窗口尺寸、解析耗时
- **配件隐藏配置（本轮，ADR 0014 D5）**：`resolveAssetConfig()` 新增 `hideAttachments`（`PET_HIDE_ATTACHMENTS`，**缺省与 `PET_FRAME_EXCLUDE` 同源**），随 `loadFile` query 传给渲染侧；两者被显式改得不同时记一条 WARN（窗口尺寸仍只按取景排除计算）
- **只读资产协议 `pet-asset:`（ADR 0009 D1）**：`protocol.registerSchemesAsPrivileged`（ready 前）+ `protocol.handle`（ready 后），只映射 `/model`、`/mouth` 两条固定路由；无路径参数、无目录穿越面、不联网；渲染页据此 `fetch` 模型字节（`file://` fetch 在 Chromium 上不可用）
- **`model_ready` 上行接收（本轮）**：`evt:broadcast` 反向（渲染侧 → 主进程）在 shell 侧首次落地；收到后只记日志并 `showInactive()`（与 `did-finish-load` 同一幂等显示路径）
- 单实例锁（C-5）：二次启动 `app.quit()`，`second-instance` 走 `showInactive()` 并记日志（ADR 0004 D9）
- 首帧就绪显示路径：`did-finish-load` + `showInactive()`（ADR 0004 D8.1）
- 页面缩放因子校验：非 1 时重置为 1 并记 WARN（ADR 0004 D1.2）
- 构建产物与单测通过：`tsc --noEmit` 0 错，**单测 95 个全绿**（mask 16 + geometry 9 + model-frame 6 + glb-bounds 8 + passthrough-fsm 11 + drag-gesture 16 + drag-pause 4 + mask-sampler 7 + attachments 5 + hfsm 9 + pat-react 4）
- 运行期实测通过（工作区外 `D:\petapp`，ADR 0006）：窗口 `480×720`、底边居中于工作区（`y = workArea.height - 720`）、`isAlwaysOnTop=true`、`isFocusable=false`、`isResizable=false`、`zoomFactor=1`；`logs/pet.log`、`logs/boot.log`、`dist/selftest/window.png` 三件产物齐全，进程 exit 0
- 工程根目录迁至 `D:\aa3dpet-app`（ADR 0007），原 `D:\aa3dpet` 只留 `MOVED.txt`；迁移后复验：构建 0 错、类型 0 错、24 个单测全绿、完整自检 exit 0（同一窗口属性与三件产物）
- 本地文件日志 `logs/pet.log`（Windows 上 Electron 的 console 在终端不可见，验收依赖日志；单文件 2MB 上限）
- 启动面包屑 `logs/boot.log`：在 `require('electron')` **之前**落盘，用于区分"主进程没被加载"与"加载后崩了"
- 启动器 `scripts/start.mjs`：清掉 `ELECTRON_RUN_AS_NODE` / `ELECTRON_NO_ATTACH_CONSOLE` 后再 spawn electron，`npm start` / `npm run selftest`
- **命中链路（第 3 步）**：唯一 16ms 轮询器（`pointer-poller.ts`）+ 纯状态机（`passthrough-fsm.ts`）；`screen.getCursorScreenPoint()` → `getContentBounds()` 换算成内容区 CSS 坐标 → `cmd:probe` → `cmd:interactive{hit,x,y,head}` → 唯一调用点 `setIgnoreMouseEvents`（D-8）
- 外扩 8px 迟滞（R-7）、切换冷却 100ms（R-7，日志 `cooled`）、单探针在飞 + 200ms 超时按未命中（ADR 0004 D4）
- **拖拽 + 摸头（本轮，第 4/5 步）**：纯判定模块 `src/main/shell/drag-gesture.ts`（不碰 Electron / IPC / 定时器），全部阈值在这里：D-2 的 4px（严格大于）、D-3 的 250ms（含边界）、D-4 的 800ms 冷却（含边界）、D-6 末速度（抬手前 ≤100ms 光标采样，px/s）、D-7 钳制（复用 `clampRectToWorkAreas`，只改位置）
- `cmd:drag` 接线：渲染侧 `pointerdown/up/cancel`（含 `setPointerCapture`）→ 主进程监听（只接受主窗口 sender）→ 只入队原始事实；位移/速度/判定全在主进程（ADR 0004 D2）
- 窗口位移写回（D-5）：`window.setPosition`，位移 = **按下点起的累计位移**（不是增量累加，因此不漂移）；与穿透状态机共用同一个 16ms 定时器
- `evt:broadcast` 首次真正落地（§3.5 / §6.4 E-1）：shell 发出 `drag_started` / `drag_released` / `head_patted`，信封 `{name,payload}`，preload 侧按 §6.3 白名单校验
- **事件总线单一出口（本轮，ADR 0015 D3）**：新增 `src/main/event-bus.ts`（`appBus`）；shell 在 start/stop 时注入/清空渲染侧句柄（`event` 走 `evt:broadcast`，`command` 走任意 `cmd:*`）。`drag_*` / `head_patted` 改经 `appBus.emit` 发出，行为与顺序不变；orchestrator / voice 不再各自碰 `webContents`，shell 仍是唯一持有 BrowserWindow 的模块
- **`user_utterance` 的生产点（本轮）**：`cmd:respond` 由 shell 接管——校验字符串、长度 ≤ 500、生成 `utteranceId`，以 `input:'hotkey'` 发 `user_utterance`（§6.3 的唯一生产者仍是 shell；第 6 步换成输入条页面后这里不改语义）
- **输入条独立窗口（第 6 步，ADR 0003 / ADR 0016）**：`src/main/shell/input-window.ts` 创建 `260×44` / `frame:false` / `transparent:false` / `alwaysOnTop(screen-saver)` / `skipTaskbar` / `show:false` 复用 / 不设 parent / `movable:false`；定位在纯函数 `src/main/shell/input-bar-geometry.ts`（主窗口内容区顶边上方 8px、水平居中；上方空间 < `44+8` 改下方 8px；钳制进显示器工作区）；主窗口 `move` 时若输入条可见则重新定位，**不新增定时器**
- **输入页与独立 preload（ADR 0016 D1）**：`src/renderer/input/`（单行输入框 + 发送按钮 + 提示文案，CSP 只放行自身脚本/样式）；`src/preload/input.ts` 只暴露 `submit(text) → cmd:respond`，不复用角色页 preload（事件总线/探针/拖拽/语音命令一律不给输入页）
- **Enter / Esc / 失焦的归属（ADR 0016 D2/D3）**：Enter 在渲染页（`isComposing || keyCode === 229` 时视为输入法候选确认，不提交）→ `submit` → 主进程；Esc 与 `blur` 在**主进程**（`before-input-event` / `blur`）收窗，**不发任何事件、不新增通道、不聚焦主窗口**
- **`cmd:respond` 接入（第 6 步）**：主进程校验发送方（只接受输入条或主窗口渲染页）→ 校验文本 → **先** `closeInputBar('submitted')` **再** `appBus.emit('user_utterance', {input:'hotkey'})`；日志带 `source: 'input-bar' | 'renderer'`
- **全局热键三级降级（ADR 0016 D4）**：`src/main/shell/hotkey.ts` 默认 `Control+Shift+B` → 被占用/抛错则降级 `Control+Alt+B`（WARN + `降级到备用热键`）→ 都失败只记 ERROR 并继续启动（不抛、不退出）；热键是 toggle，`stop()` 时注销
- **`npm run doctor`（只读环境自检）**：`scripts/doctor.mjs` 检查构建产物新鲜度、模型 GLB magic、嘴型图集、台词池（规则/兜底条数）、角色卡、Ollama `/api/tags` 与模型匹配、GPT-SoVITS 端口、参考音频 WAV 时长（3–10s）与采样率、`PET_TTS_PROMPT_TEXT`、**TTS 语种（`PET_TTS_PROMPT_LANG` / `PET_TTS_TEXT_LANG`，ADR 0019）**、TTS 超时配置；只读文件、只连回环，缺项标红，退出码恒 0
- **联调手册**：`docs/guides/LOCAL-SERVICES.md`（Ollama 安装/`pull qwen3:4b`/`/api/tags` 验证；GPT-SoVITS 的 `tts_infer.kaiyi.yaml` + conda `GPT` + `NO_PROXY` 启动；参考音频 3–10s 与 `PET_TTS_PROMPT_TEXT`；CPU 放宽首字节/总超时；环境变量总表；故障表；零成本核对）
- **输入条自检 24 条 + 两张截图**：`npm run selftest:input` —— 启动即隐藏、260×44、主窗口 `focusable=false` 且未抢焦点、热键注册与 `isRegistered` 一致、可打开/聚焦/输入框为活动元素、上方 8px 与水平居中、与字幕矩形不相交（打开时 + 回复显示时各一次）、Enter→收起→`user_utterance{source:'input-bar'}`→字幕、Esc 收起且不发事件、失焦收起；截图 `dist/selftest/input-bar.png`、`dist/selftest/input-submitted.png`
- **单测 151 个全绿（18 个文件）**：本轮新增 13 个（输入条几何 8 + 热键降级 5）；`tsc --noEmit` 0 错；四个自检套件全部 exit 0（主链路 61 / 输入条 24 / 语音 23 / 缺失模型 4）
- **真实键盘链路（手工复验，非自检）**：`npm start` 下用系统级 `SendInput` 发送 **Ctrl+Shift+B** → 日志 `输入条已打开`（主窗口 `mainFocusable:false`、`mainFocused:false`）；再发 **Esc** → `输入条已收起 reason=escape`；再次唤起后用剪贴板粘贴"你好" + **Enter** → `输入条已收起 reason=submitted` → `user_utterance{chars:2, input:'hotkey', source:'input-bar'}` → `route=rule` → 字幕显示"……老师，早上好。今天也请多指教。"。桌面上下文截图：`dist/selftest/input-bar-desktop.png`、`input-submitted-desktop.png`
- **字幕气泡（ADR 0015 D3、ADR 0021）**：`src/renderer/shell/subtitle.ts` + `styles.css`；`pointer-events:none`（不参与命中、不吞桌面点击）。显示时机由 `subtitle-cue.ts` 决定：`intent_resolved` 只登记、`speech_started` 显示、`speech_ended{failed}` 兜底（见上）；TTS 不可用时它是唯一可读输出（§8.3）
- 端到端自检：**61 条断言全绿、`npm run selftest` exit 0**；语音闭环自检 **30 条全绿**（`npm run selftest:speech`，本地桩 + 截图像素差，本轮新增 7 条：记忆就绪 / 记忆写入 / 段 ③ 注入 / 检索延迟 / 字幕不早于 speech_started / speech_started 后字幕出现 / 记忆行数）；截图四类：`dist/selftest/window.png`（Idle）、`window-drag.png`、`window-pat.png`、`window-idle.png` / `window-speech.png`（闭嘴 vs 张口，同区域像素差 9100/57600）
- 单测 138 个全绿（16 个测试文件；本轮新增 43 个：config 4 / reply-validator 8 / orchestrator 11 / voice 13 / speech 7）
- head 判定：`cmd:interactive.head` 在 `down` 时按 ADR 0004 D1.6 快照（距离 ≤8 CSS px、新鲜度 ≤100ms）；`head === null`（掩膜不可用）或快照陈旧/过远一律保守丢弃，并记一条可诊断日志
- `passthrough-fsm` 新增 `pressed` 保持位（内部输入，不是 §4.1 状态）：按下期间不切穿透（否则 `pointerup` 落到桌面会把手势挂住），但**仍按 R-5 发探针**；优先级 `dragging > settling > pressed`，既有输入位未被绕过
- 端到端自检：**51 条断言全绿、`npm run selftest` exit 0**；截图三张：`dist/selftest/window.png`（Idle 动作帧）、`window-drag.png`（拖拽悬空姿态）、`window-pat.png`（摸头反应）；证据在 `logs/pet.log` 的 `[selftest] 模型加载与 Base 层验收`
- 单测 95 个全绿（清单见上）；`tsc --noEmit` 0 错
- `CursorSource` 依赖注入：默认接 `screen.getCursorScreenPoint()`，`PET_SELFTEST=1` 时由自检注入脚本化坐标（§7.2 接口未变）
- 结构化日志：`穿透切换 {target, reason, maskAvailable}` / `穿透切换被冷却拦下（R-7）` / `探针超时`，全部落 `logs/pet.log`
- **窗口位移控制器（2026-10-31，ADR 0024）**：`src/main/shell/motion.ts` —— `walking` 与 `settling` 两段位移的唯一执行者。物理是纯函数（`shared/motion.ts`），控制器只负责读窗口矩形、夹工作区、写 `setPosition`、发 `motion_ended`。**没有新定时器**：`tick(now)` 由既有 16ms 指针轮询器驱动（§12），因此位移与穿透判定共用同一帧。
- **回弹接管链**：`drag_released` → `startSettle(vx, vy)`（订阅 appBus，与 render 同时收到同一事件）；`drag_started` → `cancel()`（拖拽立刻接管）；`cmd:walk` 的 `stop` 也走 `cancel()`。回弹期间 `isSettling()` 为真，穿透状态机据此保持非穿透（R-8）。
- **撞边处理**：行走目标先按"重叠面积最大的工作区"夹取；若该方向已贴边则**掉头**走反向，两侧都无空间才停下并发 `motion_ended{reason:'edge'}`。掉头/夹取都在启动时决定，运行中不再改目标。

### 未完成
- 真实鼠标（非自检合成事件）下的手工验收；指针捕获在"窗口被 D-7 钳制停住、指针离开窗口"时的行为当前只有日志级证据
- 行走/回弹期间的**穿透**只做到"按新窗口矩形重新判定"：R-6 轮询器每 tick 读 `getContentBounds()`，没有额外的"位移中强制刷新探针"通路（实测不丢点击，但没有专门断言）
- 托盘：热键注册失败时**仍没有** UI 提示（托盘菜单不显示热键状态，只能看 `logs/pet.log` 的 `输入条热键状态`）
- 托盘菜单的点击行为无法在自检里合成：自检只断言"托盘存在 / 菜单标签 / 图标 16×16"，`重新加载桌宠` 与 `退出` 需人工点一次验收
- "角色头顶之上"的字幕气泡：窗口按模型包围盒紧贴，头顶没有窗口内空白；要做窗口外气泡需要第三个窗口与新的 ADR（ADR 0016 D6）
- DPI/分辨率变化时重建窗口尺寸、锚点与掩膜映射（当前尺寸只在启动时按模型包围盒算一次）

### 对外暴露

| 接口 | 签名 | 稳定性 |
|---|---|---|
| `start` | `start(opts?: { hotkey?: string }): Promise<void>` | 契约 §7.2 |
| `stop` | `stop(): Promise<void>` | 契约 §7.2 |
| `getBounds` | `getBounds(): { x: number; y: number; width: number; height: number }` | 契约 §7.2 |
| `notifySecondInstance` | `notifySecondInstance(): void` | 非契约方法，仅 main 的单实例钩子调用（ADR 0004 D9） |
| `motionSnapshot` | `motionSnapshot(): MotionDiagnostics \| null` | 非契约（内部诊断）：`walking`/`settling` 状态、目标 x、地面线、最近一次结束原因 |
| `openInputBar` | `openInputBar(): boolean` | 非契约（内部）：热键回调与自检的唯一打开入口（ADR 0016） |
| `closeInputBar` | `closeInputBar(reason: string): void` | 非契约（内部）：Esc / 失焦 / 提交后共用，不发事件 |
| `inputBarDiagnostics` | `inputBarDiagnostics(): InputBarDiagnostics` | 非契约（内部诊断）：存在性/可见性/焦点/几何 |
| `hotkeySnapshot` | `hotkeySnapshot(): HotkeyRegistration \| null` | 非契约（内部诊断）：默认/降级/失败结果 |
| `traySnapshot` | `traySnapshot(): TrayDiagnostics` | 非契约（内部诊断，本轮）：托盘存在性 / 菜单标签 / tooltip / 图标尺寸（ADR 0018 D3） |
| `getInputBarWindow` | `getInputBarWindow(): BrowserWindow \| null` | 非契约（内部）：只给自检截图与注入脚本 |

> 内部接口（不对外）：`PointerPoller.notePointerFact()`（`cmd:drag` 入队）、`DragGesture`、`drag-pause`、`installInputBarWindow()`、`registerHotkey()`。

### 消费事件

| 事件 | 用途 |
|---|---|
| `model_ready` | 渲染侧加载成功、首帧已渲染后上行；shell 记日志并 `showInactive()`（与 `did-finish-load` 同一幂等显示路径） |
| `intent_resolved` | 渲染侧（shell 的字幕气泡）消费：**只登记**待显示文本，不显示（ADR 0021 D1）；不参与动作（动作只走 `cmd:render-intent`） |
| `speech_started` | 字幕显示完整文本（同一帧），播放期间不自动隐藏（ADR 0021 D2/D4） |
| `speech_ended` | `failed` → 立即显示兜底字幕；`completed`/`interrupted` → 留 1.2s 尾巴（ADR 0021 D3/D4/D5） |

> 生产侧：shell 发出 `drag_started` / `drag_released` / `head_patted` / `user_utterance`（§6.3 全量清单内，未新增事件）。

### 已知坑位

| 现象 | 影响 | 规避 |
|---|---|---|
| Windows 上 `setIgnoreMouseEvents(true, {forward:true})` 的 `forward` 无效，穿透后渲染进程收不到 `mousemove` | 无法用"光标回到模型上"的事件自动恢复交互 | 主进程 ~16ms 轮询光标 + `cmd:probe` 回判（ADR 0002，契约 §3.3 R-6） |
| 光标进入窗口到判定返回约 1–2 帧 | 该窗口内的快速点击会落到桌面（点不中角色） | 判定通过才关闭穿透；不靠"进入即取消穿透"，否则会吞掉空白区点击（契约 §12 残余缺陷） |
| 运行期切换主窗口 `focusable` 会闪烁、丢失置顶、输入法异常 | 输入条无法复用主窗口 | 输入条使用独立窗口，主窗口 `focusable` 恒 false（ADR 0003） |
| 环境里存在 `ELECTRON_RUN_AS_NODE` 时，electron.exe 以 Node 模式运行：不建窗口、`require('electron')` 返回字符串、主进程立刻抛错 | 表现为"命令跑完、没有窗口、也没有日志"，极易误判成代码问题 | `scripts/start.mjs` 启动前清掉该变量；`main.ts` 在加载 Electron 前先落 `logs/boot.log` 并在检测到该变量时打印明确提示后退出 |
| 在**低完整性级别**（`Mandatory Label\Low`，S-1-16-4096，只有 `SeChangeNotifyPrivilege`）的进程里启动 Electron，Chromium 初始化阶段直接以 `0x80000003` 退出；同一环境里 `notepad` 能正常启动，Electron 33 与 38 表现一致 | 沙箱/受限终端里"命令跑完、无窗口、无日志"，连 `boot.log` 都不会生成，看似代码没生效 | 必须由普通（Medium 完整性）进程启动：资源管理器双击 `run.cmd` / `run-selftest.cmd`，或在自己的 PowerShell 里用 `whoami /groups` 确认是 Medium 后再跑 |
| Electron 33.4.11 / 38.2.0 在 Windows 11 25H2（build 26200）上启动即 `0x80000003`（30–40ms，JS 未执行）；同机运行的 DeepSeek Harness 是 Electron 44.7.0，稳定正常 | 无法在会话内区分"版本不兼容"与"启动上下文受限"，容易误改业务代码 | 运行时按 ADR 0005（提议）锁到精确 `44.7.0`；判定以 Medium 完整性进程的冷启动为准；`run-selftest.cmd` 会先打印完整性级别与 `DSH_SESSION_ID` |
| **可执行文件位于 `D:\aa3dpet`（本会话工作区）之下时，Electron 固定以 `0x80000003` 在 Chromium 初始化阶段退出**；同一份二进制/工程放到 `D:\petapp`、`D:\pettest`、`D:\aa3dpet2`、`C:\Users\<user>\pet-test`、`D:\acl-probe` 均正常（33 与 44 都是）。已排除 ACL、完整性标签、代码签名、Electron 版本、TEMP 重定向、Job UI 限制、Exploit Protection、第三方杀软 | 工作区内无法启动桌宠；极易被误判成代码 / 版本 / 权限问题（本项目为此误升过一次 Electron 大版本） | 工程已迁出该目录（ADR 0007，根目录现为 `D:\aa3dpet-app`），原目录只留 `MOVED.txt` 指针 |
| 穿透状态下若再开第二个定时器做拖拽，光标会抖 | 拖拽位移与穿透判定互相抢状态 | 穿透状态机与拖拽位移共用同一个 16ms 轮询器（契约 §3.4 D-5） |
| **`readRenderTargetPixels` 读回的行序是自下而上**（WebGL 帧缓冲原点在左下，CSS/掩膜原点在左上） | 不翻转时整个掩膜上下颠倒：胶囊体在掩膜里出现在顶部，`hit` 判定全部反了（实测：胶囊体内判 miss、透明区判 hit） | `rgbaToAlpha(..., flipY = true)`；已加单测锁死翻转语义 |
| `cmd:interactive` 只能表达"掩膜可用/不可用"（`head === null`），**无法区分 cold 与 stale** | 主进程日志里的 `maskAvailable` 是二值，别当成三态用 | 三态与两个降级计数器在渲染侧（`mask-sampler.ts`）+ 渲染侧日志；主进程只记二值事实（本轮新增的日志一律 `maskAvailable: <boolean>`） |
| **`cmd:drag` 的 `t` 是渲染进程的 `performance.now()`**，主进程另有自己的时基 | 用主进程时钟去减渲染侧 `t` 会得到无意义的时长 | 250ms 用 `tUp − tDown`（同一时基，不含 IPC 抖动）；800ms 冷却与 4px 位移用主进程时钟。两者不跨时基相减 |
| **指针抬起事件若丢失**（例如窗口被 D-7 钳制停住、指针离开窗口且系统捕获失效） | 按下状态会保持：窗口继续非穿透、探针照常发；直到下一次 `pointerdown`（按下即替换旧按下）才恢复 | 渲染侧 `pointerdown` 里 `setPointerCapture`；主进程不新增超时兜底（避免引入契约外机制）。已列为已知风险，未声称解决 |
| 沉降窗口（500ms）内按下：新手势会重置沉降窗口（ADR 0004 D3.2），但此时 `cmd:interactive` 快照可能已 >100ms 陈旧 | 该次点击**不会**触发 `head_patted`（即使点在头部区） | 按 ADR 0004 D1.6 保守丢弃并记日志；拖完立即摸头需要等一次新的探针回包 |
| 拖到屏幕外被钳制后，窗口不再跟随光标（D-7 命中上限） | 真实鼠标下 `pointerup` 依赖 Windows 的鼠标捕获；合成事件下无此问题 | 只做 `setPointerCapture` 缓解；D-7 的 80×120 可见性是硬约束，不为了跟随而放宽 |
| `pressed` 是**内部 FSM 输入位**，不是 §4.1 的状态名 | 读日志/代码时容易误以为新增了状态 | `pressed` 只表达"已按下、未过 4px"；`dragging` / `settling` 优先级更高，未被绕过。§4.1 状态集合未变 |
| **窗口尺寸不再是固定 480×720**：由模型取景包围盒决定（本次 422×720） | 任何假设"内容区 480 宽 / 角色在 x=240"的代码与脚本都会失效（自检已改为从掩膜/诊断取点位）；§3.2 的"默认 480×720"只在模型缺失时作为回退 | 窗口尺寸只有一处计算（`src/shared/model-frame.ts`）；输入条定位等第 6 步按实际宽度算 |
| 主进程同步解析 GLB JSON（9–84ms，随文件缓存波动） | 冷启动多一点阻塞；超大模型可能更久 | 只解析 JSON chunk、不读 BIN/不建 three；失败退回默认尺寸并 WARN。将来模型变大再评估 worker |
| `pet-asset:` 的 scheme 特权必须在 `app.ready` **之前**注册 | 注册晚了 `fetch` 直接失败，表现为"模型 404 / 白屏" | `asset-protocol.ts` 在 bootstrap 的 import 链里执行 `registerSchemesAsPrivileged`，`start()` 里才 `protocol.handle` |
| 窗口尺寸在启动时算一次，运行期不再跟随模型/DPI 变化 | 换模型需重启；DPI 变化会错位 | 已列入未完成；当前接受"重启生效" |
| **渲染侧 `console.*` 的第二个参数不会跨进程**：Electron 的 `console-message` 只带格式化后的字符串 | 日志里出现 `[render] [voice] 开始播放 [object Object]`，丢失 utteranceId 等细节 | 关键事实（utteranceId、帧号、包络窗数）一律由主进程 `voice` / `orchestrator` 打日志；渲染侧只打摘要 |
| **字幕气泡是窗口内唯一 DOM 覆盖层** | 若误加 `pointer-events:auto` 或让它铺满窗口，会挡住 canvas 的命中区语义（虽然命中仍按掩膜，但视觉与调试都会误导） | `subtitle.ts` 固定 `pointer-events:none`；只放下沿、宽度 ≤88% |
| `cmd:respond` 有两个合法发送方（输入条 / 主窗口渲染页），其余一律丢弃 | 任何拿到 IPC 的页面都能提交话语的话，"文本入口唯一"就名存实亡 | 主进程按 `event.sender` 白名单校验；输入条页面的 preload 只暴露 `submit(text)`（ADR 0016 D1/D2） |
| **`BrowserWindow.getAllWindows()[0]` 不再是主窗口**：输入条也是 BrowserWindow，`getAllWindows()` 的顺序不保证按创建顺序（实测返回的是 260×44 的输入条） | 任何"取第一个窗口"的代码/脚本都会把输入条当主窗口：`focusable` 读到 true、字幕读到 null、断言全错 | 自检已改为**显式排除** `shell.getInputBarWindow()`；后续新增窗口时同样按身份取，不按序号取 |
| 隐藏一个已聚焦的窗口会再触发一次 `blur` | 若在 `blur` 里无条件 `hide()`，会出现"hide → blur → hide"的重复日志/递归风险 | `closeInputBar()` 先判 `isVisible()`，不可见即无操作；Esc/失焦/提交共用这一个出口 |
| 中文输入法组合期间的 Enter 是"确认候选词" | 不判组合态会把"确认词"误当提交，用户永远打不出第一个词 | 渲染页 `isComposing || keyCode === 229` 双守卫；**主进程不处理 Enter**（它拿不到可靠的组合态，ADR 0016 D2） |
| 热键被占用时没有状态提示（托盘已实现，但菜单不显示热键状态） | 用户以为功能坏了，实际已降级或完全不可用 | 看 `logs/pet.log` 的 `输入条热键状态` / `降级到备用热键` / `两个热键都无法注册`；不自动重试注册（避免与占用方互抢） |
| **托盘图标是 16×16 内嵌占位图**；通知区域由 explorer 提供 | explorer 未运行/受限桌面会话里 `new Tray` 可能抛错或图标不可见 | 创建失败只 WARN 并继续无托盘运行；热键、输入条、桌宠都不依赖托盘。换正式图标需要新资产与构建拷贝（ADR 0018 D3） |
| **Windows 11 默认把新托盘图标放进溢出区（任务栏 `^`）** | 首次运行时可能"看不到图标"，需要点 `^` 或把它拖到任务栏常驻 | Electron 没有"强制常驻任务栏"的 API；这是系统设置，不是应用缺陷。`logs/pet.log` 的 `托盘已创建` 可确认创建成功 |
| **托盘菜单点击无法自检**（原生菜单，Electron 不暴露"点第 N 项"） | "重新加载桌宠 / 退出"只有代码单测（tray-menu）与人工验收，没有端到端断言 | 自检断言 `exists` / `menuLabels` / `iconSize`；点击行为列为人工验收项 |
| **托盘"重新加载桌宠"会直接重启渲染进程**：不通知 voice/orchestrator | 若重载时正在播放语音，voice 会话会停在 `waiting-start` / `playing`，直到下一次 `speak` / `stopSpeaking` 收尾（与渲染进程崩溃同一类，ADR 0015 D3 不加看门狗） | 仅用于调试；重载后说下一句话即自动收尾。不要在正常对话中频繁点 |
| **托盘"退出"会先 `shell.stop()`**，销毁窗口会触发 `window-all-closed` → `app.quit()` | 看起来像"退出了两次" | bootstrap 的 `before-quit` 有 `quitting` 守卫，`shell.stop()` 幂等；托盘回调随后再 `app.quit()` 是空操作（ADR 0004 D9） |
| **`.env` 只在启动时读一次**，且进程环境变量优先 | 改 `.env` 后不重启不生效；`setx` 留下的同名变量会一直压过 `.env`，表现为"文件明明改了没用" | 改完重启；用 `echo $env:PET_XXX` 确认是否有同名进程变量；`logs/pet.log` 的 `.env 已加载` 行会列出 `applied` / `kept` 键名 |
| `doctor` 用 Node 原生 `process.loadEnvFile()`（Node ≥20.12），应用用自研解析器 | 两处实现需保持同一语义（优先级 / 引号 / 注释）；Node <20.12 时 doctor 只会给黄色提醒 | 语义写在 ADR 0018 D1 与 `src/shared/env-file.ts` 头注释；`doctor` 不 import `dist`（构建前也要能跑） |
| 输入条 `movable:false` | 拖动输入条无效（会被下一次定位弹回） | 刻意如此：位置属于主窗口（ADR 0003 §2）；只在主窗口 `move` 时跟随 |
| 字幕留在**窗口下沿**而不是"角色头顶" | 观感上气泡压在脚部附近；与需求里"桌宠上方"的字面读法不一致 | 窗口按模型包围盒紧贴（422×720），头顶没有窗口内空白，窗口外上方又是输入条的位置；要做"头顶外部气泡"需要**第三个窗口**（新 ADR）。当前用自检矩形断言保证"输入条与字幕不相交"（ADR 0016 D6） |
| `npm run doctor` 的绿灯不等于链路可用 | 例如 Ollama 有模型但显存不足、TTS 端口通但权重配错 | doctor 只覆盖"可观测前提"（文件、端口、模型名、参考音频时长）；真实链路以 `npm run selftest*` 与 `logs/pet.log` 为准 |
| **自检的日志切片曾按"当前行数"**：`model_ready` 可能在 `runtime.start()` 完成前落盘，而自检入口在那之后才执行 | 主链路自检偶发 `事件：model_ready 已发出并被主进程收到` 失败（2026-10-30 复现一次，exit 1） | 改为按本进程启动时间戳切片（`baselineLineCount`）；只影响自检，不影响生产代码。修后主链路连续两次 61/61 |
| 非 UTF-8 控制台（`chcp 936`）里 `npm run doctor` 的中文会乱码 | 清单读不清，容易误判 | 用 `run-doctor.cmd`（内部 `chcp 65001`）或 Windows Terminal |
| **字幕在合成期间是空白的（4–6s）**：ADR 0021 把"显示"推迟到 `speech_started` | 用户会以为"没反应"，尤其是 TTS 冷启动（本机首句 6.2s） | 这是与语音对齐的必然代价；`logs/pet.log` 的 `已下发音频，等待渲染侧首帧` 可确认链路在动。不要把显示时机改回 `intent_resolved` |
| **`speech_ended` 永不到达时字幕会一直停留**（渲染进程崩溃、voice 会话挂住） | 屏幕上有一行旧文本，直到下一次回复 | 字幕 `pointer-events:none` 不挡点击；下一次 `intent_resolved` 会先收起旧字幕。不为此加看门狗（与 ADR 0015 D3 同一取舍） |
| **failsafe 15s 是固定常量**（`SUBTITLE_PENDING_FAILSAFE_MS`） | 换更慢的 TTS（如整段 30s+）时会在语音开始前提前亮字 | 该值必须大于实测合成耗时；改 TTS 部署后重估。日志 `等待 speech_started 超时，提前显示字幕` 是它触发的唯一证据 |
| 自检里"字幕在 `intent_resolved` 后立刻可见"的旧断言已失效 | 照旧写会假失败 | 现在的断言是"`intent_resolved` 后**不可见** + pending 已登记"（`SLOWTTS` 桩把 TTS 延迟 1.2s 制造窗口） |

### TODO
- [x] 穿透状态机（8px 迟滞、100ms 冷却、单探针在飞、超时降级）
- [x] 128×72 掩膜采集 / `cmd:probe` 应答 / cold-ready-stale / 矩形退路
- [x] 拖拽位移与末速度、`head_patted` 的 4px/250ms/800ms 判定（第 4/5 步）
- [x] 按模型包围盒设定窗口尺寸 + 只读资产协议 + `model_ready` 接收（ADR 0009）
- [x] render 侧 `dragged` 状态与 HFSM 三层壳（ADR 0014，本轮）
- [ ] render 侧真实回弹（ADR 0014 只做到"松手淡回 Idle"）
- [x] 按 ADR 0003 实现输入条独立窗口与全局热键
- [x] 输入条落地后把 `cmd:respond` 的调用点从渲染页移到输入条页面（主进程侧不变）
- [x] 托盘（呼出输入条 / 重新加载桌宠 / 退出；退出走 `shell.stop()`，ADR 0004 D9 / ADR 0018 D3）
- [x] `.env` 环境配置加载器（`src/shared/env-file.ts` + `src/main/env.ts` + `.env.example`，ADR 0018 D1）
- [ ] 托盘显示热键注册状态（当前只能看日志）
- [ ] 实现 DPI 变化时重建窗口尺寸、锚点与掩膜映射
- [ ] 真实鼠标下的人工复验（目前只有合成事件 + 脚本化光标的端到端证据）

---

## 模块：render

### 已完成
- **行走转身（2026-10-31，ADR 0026 D1）**：`walking` 期间 `animationRoot.rotation.y` 叠加 ±90° 偏航（右走 `+π/2`、左走 `-π/2`），用帧率无关的指数逼近 `approach(cur, target, dt, 9)`（≈0.3s 走完 96%，不过冲）；停下 / 撞边 / 被拖拽 / 进入回弹时目标归 0，自动回正。偏航与既有 `look` 反应**相加**共用同一个 Y 轴通道，不互相覆盖。偏航进内部诊断 `motion.walkYaw / walkYawTarget`，自检断言"起步转向 ±90°、平滑逼近、停下回正"三条（截图 `window-walking.png` 可见侧身行走）
- **emotion → 面部贴图（2026-10-31 第 2 版，ADR 0026 D6）**：**废弃"逐像素重绘五官"**（实机截图恐怖、不像官方），改为"官方差分贴图 → 面空间投影 → 覆盖眼部 UV"。新增 `expression-assets.ts`（PNG 解码成 `PixelImage`、单眼/双眼条裁剪、最近邻采样、缺失降级）、`shared/expression-files.ts`（协议白名单）；`emotion-face.ts` 只保留 `EMOTION_FACE`（emotion → `eyes/blush/mouth`）与嘴型图元，**删除全部眼型绘制代码**。`facial-texture.ts` 保留面空间栅格化/脏矩形/眼睛层/淡入，眼睛层改为合成 PNG、红晕层改为叠加 `blush.png`。素材目录 `data/expressions/`（`PET_EXPRESSIONS_DIR` 可覆盖），经只读 `pet-asset://asset/expr/<file>` 白名单路由读取
- **降级与还原（ADR 0026 D6.2/D6.3）**：缺眼型 → 保持默认眼、只变嘴型；缺红晕 → 不叠；缺材质/几何 → 表情整体不生效。还原改用**初始化时的 `ImageData` 快照 + `putImageData`**（不再从 base 画布 `drawImage` 拷贝），恢复 neutral 时 `faceDistance` 精确为 **0**
- **通道仲裁（ADR 0026 D3）**：纯函数 `resolveMouthOwner`（口型 > 摸头 > 表情 > 静态闭嘴）决定嘴层归属，渲染侧照此绘制；说话时嘴层永远是图集帧，**口型驱动未被破坏**；`mouthOwner` 进诊断并自检断言
- **合成性能（ADR 0026 D4.2）**：`base` 画布只画一次、脏矩形还原、眼睛独立透明层 + `globalAlpha` 合成、逐像素打包整数零分配、左右眼表面去重（1,048,770 → 524,408 px）。实测：换眼型 40ms（一次性）、淡入每步 **3.6ms**、静态闭嘴重绘 0.6ms
- **表情可观测/可测（ADR 0026 D4.4）**：贴图通道输出 `faceDistance`（与基线缩略图 64×64 的平均绝对差）、`textureDigest`、`lastPaintMs`、`lastPaintPixels`、眼/嘴/颊像素数与锚点。自检据此做**贴图级**断言（四种情绪 8.6%–19.4%、还原后 0.000），不依赖受 Idle 姿势影响的截图差
- **降级（ADR 0026 D5）**：缺材质/缺贴图/缺三角形 → 通道空转 + 一条 WARN；缺 `Face` 材质只禁用红晕；眼三角形不足 8 个 → 只画嘴型图元。所有路径都不白屏、不抛异常
- **资产事实落档（本轮实测）**：`EyeMouth` 的虹膜岛 `u 0.2839..0.9575 × v 0.0376..0.9124`、巩膜/眼睑条只有 2–3 texel 宽、`Eyebrow`/`Eyebrow2` 是 1 texel 纯色块、**左右眼共用同一块 UV**、UV→面空间不是仿射映射（逐岛残差与岛尺度同量级）——见 ADR 0026「资产事实」
- **资产事实（2026-10-28 文档同步；来自上一轮未落盘的探索结论，本轮直接采纳、不再探查）**：
  1. 模型是 **glTF 2.0 `.glb`**（`CH0335.glb`，15.7 MB），**不是 VRM**，无需转换；加载器用 `three/examples/jsm/loaders/GLTFLoader.js`（three 0.170 自带，无新增依赖）。
  2. 骨骼命名干净：`Bip001 Head`、`Bip001 eye_L`、`Bip001 eye_R`、`Bip001 Pelvis`、`Bip001 Neck` 等；`Bip001` 为根。经 GLTFLoader 后名字会被清洗成 `Bip001_Head` 这类形式（空格→下划线），实现按**归一化名**匹配。
  3. **没有任何 morph target（blendshape）**：5 个网格的 primitive `targets` 全为空，口型/表情不能靠形态键。
  4. **没有眼睑骨骼**：只有眼球/虹膜/眉毛骨，没有 `eyelid` / `eye_close`。
  5. **眨眼方案已证伪**：对眼球骨 `scaleY` 会连高光与瞳孔一起压扁，视觉上完全不像眨眼；v1 **不实现眨眼**，用"视线微动"替代。
  6. **口型方案（阶段 5 预留，本轮只做静态底图）**：用外部图集 `Character_Mouth_Black-Due3Gpre.png`（1024×1024、8×8 帧、透明底），通过 Canvas 合成到模型自带的 `CH0335_EyeMouth` 贴图上（贴图切换式），见 ADR 0010。
- 决策记录：[ADR 0009（GLB 加载/骨骼映射/包围盒）](adr/0009-glb-loading-and-model-validation.md)、[ADR 0010（贴图式口型与表情降级）](adr/0010-texture-lip-sync-and-facial-fallback.md)、[ADR 0014（HFSM 三层/骨骼仲裁/自带动画接入）](adr/0014-bone-arbitration-and-builtin-animations.md)
- **GLB 加载管线（阶段 4.5）**：`model-loader.ts` — `fetch('pet-asset://asset/model')` → `GLTFLoader.parse()`；材质统一转**无光照** `MeshBasicMaterial`（保留 `map`/`color`/`vertexColors`/`name`，`side=DoubleSide`，仅当贴图确实含 alpha 时 `alphaTest=0.5`）；SkinnedMesh 关闭视锥裁剪；`loadMs` 实测 155–247ms（随文件缓存波动）。
- **窗口尺寸与锚点（阶段 4.5）**：主进程 `glb-bounds.ts` 只解析 GLB JSON（不引入 three）求世界 AABB；取景包围盒排除 `weapon|prop|brush|outline` 后为 `0.006376 × 0.010881`（模型单位），按 ADR 0009 D4 得窗口 **422 × 720**、`pixelsPerUnit≈57538`；渲染侧用同一公式（`src/shared/model-frame.ts`）定标，**脚底中心 = 内容区底边中心**。
- **真实模型替换占位（阶段 4.5）**：加载成功即移除胶囊体；模型缺失/HTTP 404/解析失败/关键骨骼（head、eyeL、eyeR）缺失 → `modelReady=false` + 占位胶囊体（§7.3、§11），不白屏、不抛异常。
- **自带动画接入（本轮，ADR 0014 D3/D8）**：`animation-controller.ts` 把 **44 段 clip 全量建 action**、启动时在控制台打印全部名称与角色识别（`pickup=CH0335_Formation_Pickup`、`struggle=CH0335_Vital_Panic` 作为 `held` 的降级候选）；选择 `idle=CH0335_Cafe_Idle`、`held=CH0335_Carrier_Idle`、`walk=CH0335_Move_Ing`（只识别、不启用，留给下一轮 `walking`）；切换只用 `crossFadeFrom(prev, 0.25/0.3s, false)`。**程序化呼吸退役**（ADR 0014 D8）：Base 的"呼吸"由 Idle 动画承担，不再对 `modelRoot` 做周期缩放。
- **HFSM 三层壳（本轮，ADR 0014 D3）**：`hfsm.ts` 纯逻辑（不引用 three / 不读时钟）；Base=`idle`（`walking` 未实现，枚举保留）、Overlay=`speaking`/`reacting`、Physics=`dragged`；`overlay` 是 §7.1 单字段的投影 `speaking > reacting > null`；`reacting` 由 `head_patted` 或 §4.1 列出的 5 个 intent 进入，1.1s 自愈；`dragged`/`speaking` 只由事件进出（H-4）。
- **骨骼仲裁（本轮，ADR 0014 D1/D2）**：`bone-arbiter.ts` 固定每帧顺序 **Mixer → 抓取动画基底 → 视线叠加 → pat 叠加 → 单次写回 → Physics 根变换 → render**；`head`/`eyeL`/`eyeR` 只允许仲裁器写；用"写回检测/还原"区分"本帧动画有没有重写这根骨"，避免未受动画驱动的骨骼逐帧累积偏移。
- **视线改造（本轮）**：`gaze.ts` 不再持绑定姿态快照，改为向仲裁器提交 yaw/pitch 偏移；Idle 动画驱动头/眼时视线仍然有效（自检：左右光标 `yaw` 分别为 -0.24 / +0.24）。
- **摸头反应（本轮，ADR 0014 D6）**：`pat-react.ts` 纯函数（`sin(πp)` 包络、权重、姿态）；头部后仰 `-0.3 rad` + 侧倾 `0.08 rad` + 身体前倾 `0.05 rad`，嘴型切图集第 4 帧（shy）；**说话时权重封顶 0.4、且不改嘴型**，`emotion` 临时投影 `shy`、结束回到 `intent_resolved` 的值。
- **拖拽姿态（ADR 0014 D3）**：`drag_started` → crossFade 到 `Formation_Pickup`（被拎着的垂姿，ADR 0023 D3）、`animationRoot` 抬升 18px + 周期 1.6s / ±0.05 rad 摇摆；`drag_released` → Physics=`settling`，回弹过程中淡回 Idle。
- **行走调度与窗口位移（2026-10-31，ADR 0024 D1）**：`hfsm.ts` 的 Base 增加 `walking`——idle 满 20–40s（注入随机源，可单测）后随机方向 + 100–300px，`tick()` 返回 `startWalk`；`render-module` 收到后播 `Cafe_Walk` 并经 `cmd:walk` 让 shell 位移。**不用动画 root motion**：位移由 `shared/motion.ts` 的 `stepWalk`（刹车曲线 v=√(2ad)）驱动，窗口 16ms 更新一次。到达/撞边/被拖拽打断都由 `motion_ended{kind:'walk'}` 收步。
- **真实回弹（2026-10-31，ADR 0024 D2/D3）**：`drag_released` 进入 `settling`，shell 用弹簧-阻尼（k=140、c=12、恢复系数 0.28）把窗口落到工作区地面线，水平速度按 `e^(-5t)` 衰减；落地后 render 加 180ms / 6% 的下蹲缓冲。回弹期间 `intent` 与 `head_patted` 被忽略（唯一例外是重新拖拽）。物理全部是纯函数（`stepSpring`/`stepWalk`/`stepSettle`），单测 12 条。
- **配件隐藏（本轮，ADR 0014 D5）**：`HIDE_ATTACHMENTS` 默认 `(weapon|prop|brush|outline)`，实测隐藏 `CH0335_Weapon` / `CH0335_Prop_Outlline` / `brush_01` 三件；只 `visible=false`（不删节点、不改材质），隐藏集合同时不参与取景。
- **地面校正（本轮，ADR 0014 D4）**：加载后按 Idle 姿态做一次 CPU 蒙皮采样（每网格 ≤4096 顶点），把可见网格最低点对齐内容区底边；实测 `Cafe_Idle` 校正 **-0.2px**，`resize` 后重算，不逐帧。
- **口型通道（本轮接线，ADR 0015 D4）**：`facial-texture.ts` 以 EyeMouth 贴图为底、8× 超采样 CanvasTexture：刷肤色底板 + 画图集帧。渲染侧语音播放器按 **30Hz** 把包络电平映射成 8 级帧，经内部接口 `setMouthFrame(frame)` → `MouthChannel.setFrame` 驱动贴图；`speech_ended`（任何 reason）调 `resetMouthFrame()` 回闭嘴帧。口型通道优先级最高：说话开始时 `restorePatMouth()` 立即让位（§5.2）；`setFrame` 的另一个调用方仍是摸头的 shy 帧（第 4 帧）。
- **口型诊断（本轮）**：`getDiagnostics().speech = { frame, driven }`（内部，不进 `RenderState`）；自检用它与 `window.petVoice.getDiagnostics()`（包络电平/帧/AudioContext 状态）互相校验。
- **`model_ready`（阶段 4.5）**：首帧渲染后经 `evt:broadcast` 上行，payload `{modelId, loadMs}`；shell 记日志并走与 `did-finish-load` 相同的幂等显示路径（§6.3、§7.3）。
- **能力探测**：`getState().modelReady` 真实反映加载结果；更细的诊断（包围盒、ppm、骨骼名、当前动作/权重、HFSM 快照、pat 权重、隐藏网格、地面校正、视线角度、口型通道）在内部 `window.petModel.getDiagnostics()`。**动作名按 ADR 0014 D7 不进入 `RenderState`**（§7.1 字段固定）。
- 掩膜采集与 `cmd:probe` 应答（128×72、20Hz、垂直翻转、cold/stale/矩形退路）、`cmd:drag` 上行、R-8 暂停链路保持上一轮实现，未回退。

### 未完成
- **官方表情差分尚未获取**：`ZM-Kimu/Blue-Archive-Asset-Downloader` 在本机卡在三处环境问题（uv 对 PyPI 的 TLS 证书不受信、缺 .NET 10 SDK、未走到 BA CDN），详见 ADR 0026 D6.4。当前 `data/expressions/` 为空，表情走"只变嘴型"降级；`data/expressions.fixtures/` 是非官方 fixture，仅用于自检自证
- 眉毛类表情（§4.5 的"眉内侧下压""眉下压"）：本资产眉毛/眼线是几何体 + 1 texel 纯色块，贴图改不了形状。若官方差分里带眉毛则可直接接入（协议白名单加文件名即可），否则需要"眉毛贴片"（等于改模型）
- `angry` 与 `sleepy` 共用 `half` 眼型、嘴型差异小，视觉区分度一般（可继续调参或加眉毛贴片）
- 眼型/嘴型/红晕的弧度、厚度、浓度是**美术标定值**，只做过截图目视复核，没有量化美观指标
- 动作名进入 `getState()`（需契约 minor + ADR，见「跨模块阻塞」）。
- 真实鼠标 / 多显示器 / DPI 变化下的人工复验。
- 行走的"掉头"只做了单次翻转：连续撞边（窗口比工作区还宽）时直接停下，没有来回踱步。

### 对外暴露

| 接口 | 签名 | 稳定性 |
|---|---|---|
| `handleIntent` | `handleIntent(intent: Intent): void` | 契约 §7.3（实现取 `string` 以便对未知值降级，不抛异常） |
| `getState` | `getState(): RenderState` | 契约 §7.3（字段未增删；overlay 是单字段投影） |
| `resize` | `resize(width: number, height: number): void` | 实现细节，非契约 |
| `dispose` | `dispose(): void` | 实现细节，非契约 |

> 内部接口（不属于 §7.3，且不跨进程暴露）：`handleEvent(event)`（`evt:broadcast` 的渲染侧入口）、`setCursor(cssX,cssY,at)`、`setWalkInterval(min,max)`（自检压缩行走间隔）、`getDiagnostics()`（含 `facial` 块：emotion/eyeShape/mouthShape/mouthOwner/blush/alpha/faceDistance/textureDigest）、`applyFacial`（内部装配点，私有）、`FacialChannel.setMouth/setEyes/repaint` / `BlushChannel.setBlush/repaint` / `MaskCapture.setPaused` / `setTickListener` / `snapshot` / `markContextLost`。

### 消费事件

| 事件 | 用途 |
|---|---|
| `speech_started` | Overlay=`speaking`；立即交还嘴型（§5.2 口型通道最高优先级）；之后口型由渲染侧播放器按包络驱动（ADR 0015 D4） |
| `speech_ended` | Overlay 退出 `speaking`；嘴型 `resetMouthFrame()` 回闭嘴帧（任何 reason） |
| `drag_started` | Physics=`dragged`；R-8 暂停掩膜采集；crossFade 到 `Carrier_Idle` 并抬升/摇摆 |
| `drag_released` | Physics 退出；R-8 从此刻起等 500ms 再恢复采集；crossFade 回 Idle |
| `head_patted` | Overlay=`reacting`；`pat_react` 低权重叠加（说话时 ≤0.4、不改嘴型）；回弹期间忽略 |
| `intent_resolved` | 只取 `emotion`（不触发动作）；摸头期间投影为 `shy`；该值驱动**面部贴图合成**（眼型/嘴型/红晕，ADR 0026） |
| `motion_ended` | ADR 0024：`kind:'walk'` → Base 回 `idle` 并重新排期；`kind:'settle'` → Physics 退出、加落地缓冲 |

> 生产侧（既有）：`model_ready` 由 render 经 `evt:broadcast` 上行（§6.3 事件，未新增）。

### 已知坑位

| 现象 | 影响 | 规避 |
|---|---|---|
| **左右眼共用同一块 UV 岛**（虹膜 + 巩膜条都在 `u 0.14..0.96` 一带） | 眼型只能**镜像对称**：`>_<` 这种左右不同的画法在贴图上无法区分两只眼 | 契约 §4.5 对 `shy` 写的是"`>_<` 或半闭"，本轮取 `squint`（半闭/眯眼）；`EyeShape` 里不提供 `cross`（ADR 0026 D2.2） |
| **`percentileRange` 的"还没赋值"哨兵写错会把区间塌成一点**：用 `low === min` 判断时，直方图第一桶通常就超过 1%，`low` 被一路覆盖到接近 high | 归一化后绝大多数像素落到 `[-1,1]` 外 → 表情贴图只在眼睛上画出一小块碎片（实测症状） | 用独立的两侧累加（低侧从左、高侧从右）代替哨兵；补单测（均匀分布 → 1%/99%） |
| **眼部包围盒宽:高 ≈ 2:1，方形差分图会被横向拉伸** | 手绘方形眼图直接贴上去会变扁；而"官方贴图空间的眼部裁剪"恰好需要这个拉伸 | 差分按包围盒**拉伸铺满**（语义写进 `data/expressions/README.md`）；手绘图应画在垂直中段并横向铺满 |
| **上眼睑是独立几何体，会挡住画在上半部的图元** | 第 1 版程序化弧线整条被挡；fixture 初版画在画布上部同样看不见 | 差分图必须让"可见的眼部"占据画布垂直中段；这是构图问题，不是映射问题（探针图验证过方向正确） |
| **1%/99% 之外的 ~2% 像素若被丢弃，会留一圈原虹膜** | 实机表现为"幽灵眼环"（差分贴上去后眼睛边缘一圈旧虹膜） | 归一化后对 `[-1,1]` **夹取**而不是丢弃（`rasterizeFaceLocal` 的 clamp） |
| **椭圆接受域会在包围盒四角留下原虹膜边缘** | 渲染出来是一圈"幽灵眼环"（截图可见） | 接受域改成**矩形**（= 眼包围盒）；`wide` 在眼型外、框内刷肤色 |
| **按 UV 矩形直接画表情会错位** | 脸是曲面，UV→面空间不是仿射的（逐岛仿射拟合残差与岛尺度同量级） | 逐三角形重心插值 + 面空间局部坐标（`rasterizeFaceLocal`），不做 UV 猜测 |
| **屏幕空间 overlay 画表情会盖在刘海之上** | 本资产左眼被一缕刘海遮挡，overlay 不参与遮挡 → 眼睛浮在头发上 | 只做**贴图**编辑；这也是 ADR 0010 早就定下的路线 |
| **眼睛占 52 万贴图像素，逐像素重绘一次 ≈40ms** | 0.25s 淡入切 6 步会卡 0.24s | 眼睛画在独立透明层，按 `alpha` 合成；每步 3.6ms（ADR 0026 D4） |
| **截图差受 Idle 动画/视线漂移影响**：同一状态两次截图有 ≈6000/84864（7%）像素差 | 用"截图差"证明"表情生效/还原"会误判 | 贴图级断言：`faceDistance`（64×64 缩略图平均绝对差）+ `textureDigest`；截图只作人眼证据 |
| **`drawImage` 按矩形还原会留 1 texel 抗锯齿边界差** | "指纹完全相等"不能作为还原判据；`faceDistance` 也压不到 0 | 初始化时对眼区/嘴底板/颊部各拍 `ImageData` 快照，还原用 `putImageData`（逐像素覆盖）；实测恢复后 `faceDistance = 0` |
| **自检截图必须区分官方素材与 fixture** | fixture 是 Pillow 画的替身，拿去当美术验收就是造假 | fixture 只在 `data/expressions/` 缺图时由 `scripts/start.mjs` 自动退到 `PET_EXPRESSIONS_DIR`，并在启动日志打印"改用 fixture（非官方美术）"；MODULE_STATUS/ADR 同步标注 |
| **自检期间行走调度会再次触发** | 表情截图拍到"转身中/位移中"的角色，像素差失去意义 | 表情段开始前把 `setWalkInterval` 推到 600s，并等 `base=idle` + `walkYaw≈0` 再截图 |
| **`GLTFLoader` 会清洗节点名**：`Bip001 Head` → `Bip001_Head`（空格换下划线、去掉保留字符） | 用原始名字精确匹配会误判"骨骼缺失"，整模型被回退成胶囊体（实测踩到） | 加载器按**归一化名**（小写、非字母数字→`_`）匹配；日志里打印真实骨名 |
| **渲染页 CSP 原本是 `connect-src 'none'`** | 自定义 scheme 的 `fetch` 与 GLTFLoader 的 `blob:` 纹理都会被 CSP 拦掉（实测：先 `Failed to fetch`，再 `Couldn't load texture blob:…`） | CSP 只放行本地 `pet-asset:` 与 `blob:`（`connect-src pet-asset: blob:`、`img-src … blob: pet-asset:`），不放开任何网络来源（ADR 0009 D1） |
| **模型单位不是米**：身体包围盒高 0.00926、连同光环 0.010881 | 按"1 单位 = 1 px"渲染会把角色画成 1 px 高 | 全部按包围盒定标（`pixelsPerUnit`），主进程与渲染侧共用 `src/shared/model-frame.ts` |
| **`CH0335_EyeMouth` 贴图里有一块纯白的"嘴部底板"**（UV `0.0089..0.2411 × 0.7926..0.9571`） | 不处理时脸上是一块白矩形（实测截图）。游戏里这块由 shader 按嘴型图集绘制 | v1：刷成 Face 贴图的**主色** + 画图集第 0 帧（静态闭嘴）；阶段 5 改用 `setFrame` 驱动 |
| **底板填色不能用贴图平均色**：Face 贴图混着眉毛/鼻影/下颌阴影，整张平均 `(204,190,186)`，比肤色 `(249,241,236)` 暗 18% | 嘴周一圈明显比脸暗，像贴了块膏药（实测截图 `face-before`） | 取**众数**（5bit 量化，最大桶占 43% → `(249,241,236)`），算法抽到 `shared/color.ts` 并单测；同时把填色向外扩 2 texel，避免 UV 岛边界采样到岛外白色形成亮边 |
| 外部嘴型图集是水彩风格、透明底；直接缩放会糊成一团 | 嘴型不可读 | CanvasTexture 用 **8× 超采样**重绘（`SUPERSAMPLE=8`），并按 alpha 裁边后保持宽高比 |
| 配件（`CH0335_Weapon` / `Prop_Outlline` / `brush_01`）在绑定姿态下位于取景框外，且会把包围盒撑宽 | 不隐藏时窗口只框角色、配件被窗口边缘裁切；取全场景包围盒时窗口会被武器撑到约 979px | 取景排除（`PET_FRAME_EXCLUDE`）与装配隐藏（`PET_HIDE_ATTACHMENTS`，ADR 0014 D5）默认同源；隐藏只 `visible=false`，不删节点、不改材质 |
| 主进程要在**创建窗口之前**知道包围盒 | 否则会先显示 480×720 再跳尺寸 | 启动时同步解析 GLB JSON（实测 9–84ms，随文件缓存波动），失败退回默认尺寸并 WARN |
| 骨骼缺失的策略是"整体回退"而不是"逐骨降级" | 缺任意关键骨（head/eyeL/eyeR）就看不到模型 | 按 §7.3 严格执行：`modelReady=false` + 胶囊体；日志列出缺失项（ADR 0009 D6） |
| **自检模式下真实鼠标事件会污染脚本场景**（窗口就在桌面上，用户动一下鼠标/点一下就会插入 `cmd:drag`） | 断言随机失败（实测：3px 阈值与暂停检查各失败过一次） | 仅当 `PET_SELFTEST=1` 时，渲染页忽略 `event.isTrusted === true` 的指针事件（生产路径不变） |
| 加载是异步的：窗口显示时模型可能还在解析 | 早期探针只能命中空气/胶囊体 | 启动即放占位胶囊体兜底；模型就绪后替换，不阻塞窗口显示 |
| `three` 0.170 不自带 TypeScript 声明 | 渲染侧无法类型检查 | devDependency `@types/three@0.170.0`（仅类型，无运行时、无联网） |
| **`CH0335_Normal_Idle` 是战斗侧身待机**：根骨 `Bip001` 旋转在绑定 `-90°` 上再转约 `-87°`（q≈`z0.9994,w-0.0288`） | 直接播它，角色整身侧对镜头（实测截图），桌面宠物看起来在"看旁边" | Base 首选 `CH0335_Cafe_Idle`（根骨 `-98.6°`，正面待机）；`Normal_Idle` 保留为降级候选并在日志里打印识别结果（ADR 0014 D3） |
| **自带动画带根骨平移**（`Bip001` 的 translation/rotation 每段都有；幅度 <0.0013 单位、无持续漂移） | 姿态与绑定姿态不同：Idle 第 0 帧把根骨从 `y=-0.00038` 提到约 0，不校正会"悬空站立" | 不裁 track；加载后按 Idle 姿态做**一次** CPU 蒙皮采样把最低点对齐底边（`measureAnimatedMinY`）；拖拽期间不复位（悬空是表现） |
| **`applyBoneTransform` 要求传入的向量里已经是顶点位置**（内部会再乘 `bindMatrix`） | 传 `(0,0,0)` 只蒙皮"骨骼原点"，会得到 `minY=-0.44`、把角色抬到窗口外两万像素（实测踩到，导致整轮自检 18 条失败） | 采样前 `point.fromBufferAttribute(position, i)`；并先检查 `skinIndex/skinWeight` 存在，否则按静态网格处理 |
| **骨骼写回检测是推断，不是事实**（three 没有骨骼级 mask） | 如果动画恰好写出与我们上一帧完全相同的四元数，会被误判为"没被动画驱动"而沿用旧基底 | 判断阈值取 `|dot| ≥ 1-1e-8`；即使误判也只错一帧，下一帧自愈（ADR 0014 D2） |
| **动作名不能进 `RenderState`**（§7.1 字段固定） | 想从 `getState()` 读当前 clip 的人会找不到字段 | 走内部诊断 `getDiagnostics().animation.current` + 动作切换日志；要进 `getState()` 必须契约 minor + ADR（ADR 0014 D7） |
| 拖拽的"悬空"是合成表现（`Carrier_Idle` + 抬升 18px + ±0.05 rad 摇摆），不是物理 | 快速甩动时没有惯性/落地缓冲；松手直接淡回 Idle | 真实回弹下一轮；本轮只保证"看起来被拎起来"（ADR 0014 D3） |
| 摸头没有专门动画；`Cafe_Reaction`（10.75s）/`Formation_Pickup`（14s）都是整身演出 | 整身动画会抢身体/口型通道（H-1/H-2） | 程序化三通道合成（头后仰 + 身体前倾 + 嘴型第 4 帧），说话时权重 ≤0.4 且不改嘴型（ADR 0014 D6） |
| 嘴型"shy"帧（索引 4）是**资产相关标定** | 换图集/换角色后该帧可能不是微笑 | 常量集中在 `pat-react.ts`；换资产需重新看图集选帧（写进本坑位） |
| **口型的 8 级映射是未标定假设**：图集 8×8=64 帧没有语义标注，实现假定 `0..7` 是"闭口→逐步张口"，帧 0 一定闭嘴 | 换图集/换角色时帧序可能完全不同，嘴型会"跳帧"或不对应音素 | 映射只在 `shared/constants.ts`（`MOUTH_LEVELS`）与 `mouth-mapping.ts`；帧 0 被 `resetMouthFrame` 强制回闭嘴。实测本资产帧 7 是明显张口，截图可辨 |
| `speech_ended` 会立刻 `resetMouthFrame()` | 若把"说完后的余韵"当成表现需求，会被这行抵消 | §5.2 口型通道最高优先级；宁可闭嘴也不要"说完张着嘴"。摸头 shy 帧若仍在，下一帧 `syncPatMouth` 会重新画回来 |
| **`capturePage()` 返回的是物理像素**（本机 844×1440），而诊断点位是 CSS px（422×720） | 自检像素差一开始全 0（裁到了左上角透明区）；肉眼截图明明有变化 | 自检按 `image.width / contentBounds.width` 缩放区域；任何截图比对都必须先算 DPR |
| 44 段 clip 全部建 action（`mixer.clipAction`），只有 2 段在跑 | 初始化多一点开销与内存；无按次成本 | 这是 three 的常规做法，切片段时才需要 action 已存在；如后续片段数暴涨再评估懒加载 |
| `dragging` / `patMouthActive` / `dragSwayGain` 是**内部标志位**，不是 §4.1 的状态名 | 读代码/日志时容易误以为新增了状态 | 只会出现在 render 内部；对外状态仍只有 `base/overlay/physics` 三个字段（§4.1 集合未变）。`reaction.kind` 里的 `head_patted` 是"触发来源"，不是状态名 |

### TODO
- [x] GLB 加载管线 + 包围盒校正 + 真实模型替换占位
- [x] 视线跟随/微动（替代眨眼）
- [x] 口型通道接口 + 静态闭嘴底图（8×8 图集标定）
- [x] `model_ready` 上行 + `modelReady` 真实状态
- [x] HFSM 三层壳（Base/Overlay/Physics）+ 自带动画接入 + 骨骼仲裁（ADR 0014）
- [x] `head_patted` → `pat_react`（程序化、说话时 ≤0.4 权重）
- [x] 拖拽悬空姿态（`Carrier_Idle` + 抬升 + 摇摆）与松手回 Idle
- [ ] `walking` 调度器（`Move_Ing` 已识别，需接入 Base 层 + 水平位移）
- [ ] 真实回弹（松手后的弹簧/落地缓冲，ADR 待写）
- [x] 阶段 5：`voice` 包络 → `MouthChannel.setFrame`（ADR 0015 D4；说话时嘴型随 RMS 变化）
- [x] `emotion` 的贴图表情（ADR 0026 第 1 版：程序化图元）
- [x] 表情改为**官方差分贴图驱动**（ADR 0026 第 2 版 D6）：单眼/双眼条、红晕层、缺失降级、ImageData 精确还原
- [ ] **拿到官方表情差分**（下载器受阻：uv TLS / .NET 10 / BA CDN，见 ADR 0026 D6.4）并放进 `data/expressions/`
- [x] 行走时按方向转身、停下回正（ADR 0026 D1）
- [ ] 眉毛类表情（需要资产侧"眉毛贴片"，另立 ADR）
- [ ] `angry` / `sleepy` 的视觉区分度加强（目前与 `shy`/`sad` 共用部分图元）
- [ ] 真实鼠标 / 多显示器 / DPI 变化复验

---

## 模块：orchestrator

### 已完成
- **三路分流（§9.1，ADR 0015 D1）**：`respond({text, utteranceId})` → ① 规则池（字面命中即返回，≤5ms）→ ② 本地 LLM（Ollama，8s 硬超时）→ ③ 兜底；**永不 reject**（§7.6），任何异常都折算为兜底 `Reply`
- **顺序与双轨（§8.1 / §7.3）**：先发 `cmd:render-intent{intent}`（命令），再发 `intent_resolved`（事实），最后 `voice.speak`（fire-and-forget，不阻塞 `thinking → idle`）；`RenderState` 未新增字段
- **台词池 `data/lines.json`**（version 1）：7 条规则 + 5 条兜底。规则条件只允许契约列出的两类：`keywords`（字面子串、大小写不敏感）与 `on:'head_patted'`；每条规则独立冷却（缺省 4s）；命中策略是**数据顺序的第一个满足者**（确定性，不随机）；兜底按轮转取、避免连续重复
- **装配期校验（§9.1 ③）**：`lines.json` 顶层/版本/规则/兜底结构、id 唯一、文本 1–120 字且无 Markdown/URL/括号、`emotion`/`intent` 严格属 §4.4/§4.5；**兜底为空或不合法 → 抛错 → bootstrap 拒绝启动**（实测 exit 1 并落 ERROR）
- **角色卡 `data/character-card.md`**（933 字）注入 system 段；文件缺失/为空 → WARN 并改用最小身份行（不阻断对话）
- **提示词 §9.3 段序固定**：① 硬编码输出约束（JSON + 枚举全集）→ ② 角色卡 → ③ 记忆段（`memory` 未实现，显式写"（无）"）→ ④ 最近 6 轮（进程内环形缓冲）→ ⑤ 当前话语；①–③ 合成 system 消息，④ 展开成 user/assistant
- **Ollama 客户端（ADR 0015 D1）**：`GET /api/tags` 健康检查（800ms，模型名精确/`:latest` 等价匹配）；**一次失败即本会话熔断**，不再探测 ②（§11）；`POST /api/chat`（`stream:false`、`format:'json'`、`temperature:0.8`、`num_predict:256`），8s 硬超时按"thinking 总预算"扣掉健康检查耗时；**不做重试**；`cancel()` 用 `AbortController`
- **§9.2 输出校验（本轮增强，ADR 0018 D2）**：先**剥装饰**（三反引号代码围栏（含 json 标记）/ 括号动作 / Markdown 粗斜体 / 行内代码 / 标题前缀）→ JSON 提取（纯文本 / 围栏内容 / 文本中第一个平衡 `{...}`，字符串内花括号不误判）→ 结构（三字段齐全）→ **一次**字段修复（未知 `intent→none`、未知 `emotion→neutral`）→ **严格**文本约束（1–120 字、单段、无残留 Markdown/URL/代码块/括号）；失败发 `llm_failed{invalid_output}` 并降级 ③。清洗与修复记入 `repaired`（`output:fence-stripped` / `output:json-extracted` / `text:decorations-stripped` / `emotion->neutral` / `intent->none`），编排层 WARN 记录；台词池装配不走清洗
- **提示词增强（本轮）**：§9.3 段 1 明确"仅输出纯 JSON、禁止三反引号代码围栏、禁止括号动作、text 禁止 Markdown/换行"；两层防线（提示词降概率 + 清洗兜底）
- **真实 LLM 已接管（本轮真机，2026-10-30）**：真实 orchestrator + Ollama `qwen3:4b` 一轮 **1.7s** 返回、`route=llm`；原始输出含 `（略带担忧地皱眉）`，清洗后 `repaired=["text:decorations-stripped"]` 并正常发布 `intent_resolved`。另测 `（轻轻叹了口气）`、`我叫天童凯伊（Kei Tendo）。` 均可清洗通过；冷启动首问约 10s 仍会撞 8s 预算走兜底（见已知坑位）
- **记忆接入（本轮，ADR 0020）**：依赖从占位 `memoryFacts?: (q) => string[]` 换成结构化 `memory?: MemoryPort`（不 import `memory` 实现，避免把原生模块拖进 orchestrator 的依赖图）。`respond()` 在 LLM 分支先 `retrieve(text, 5)` → `formatMemoryFacts()` → 段 ③；检索为空或抛错都退回 `记忆片段：（无）`（不改路由）。`publish()` 在 `voice.speak()` **之后**用 `setImmediate` 异步写 `kind='user'`（`refId=<utteranceId>#user`）与 `kind='pet'`（`refId=<replyId>#pet`），同一 `at`；摸头等无用户输入的合成话语不写
- **日文输出约束（本轮，ADR 0022）**：§9.3 段 1 增加"必须完全使用纯正日文"的硬约束，并把 `text` 语言改写成日文；角色卡同步（语言一节置顶 + 日文 few-shot + 「你好→日文」示例）；台词池全部日文
- **事件归属**：`user_utterance` 的唯一消费者；`intent_resolved` / `llm_failed` 的唯一生产者；不订阅其他事件产生副作用；`memory.write` 的唯一调用方（§6.4 E-5）
- **打断（§12）**：`respond()` 开头先取消在途 LLM、再 `voice.stopSpeaking('interrupt')`；被取消的那次 `respond` 仍返回合法兜底 `Reply`，但**不发布 `intent_resolved`、不发声**（旧回复不抢新话语），并记 `llm_failed{aborted}`
- **摸头规则（§9.1 的事件条件）**：空闲时命中 `on:'head_patted'` 规则并说话；`thinking` 或正在说话时**跳过**（§5.3：摸头不打断语音/在途 LLM），只有身体反应由 render 自己处理
- **单测 19 个**：规则命中/顺序、健康检查熔断、LLM 合法/非法/超时、`cancel` 不发布、新话语打断旧话语、空话语、chat 抛异常、摸头跳过、prompt 段序；本轮新增 8 条记忆用例（段 ③ 注入 / 查询词 / 空或失败退回「（无）」/ 异步写两条 + refId / 写库在 speak 之后 / write 抛错不影响回复 / 摸头不写 / 无 memory 依赖时行为不变 + `formatMemoryFacts` 上限与截断）
- **自检**：降级套件（无 TTS/无 LLM）验证 `route=rule` / `route=fallback` / `llm_failed{unavailable}` / 无 `speech_started` / 字幕可见 / 熔断；语音桩套件验证 `route=llm`、`invalid_output`、打断、记忆写入与段 ③ 注入、字幕时序

### 未完成
- 台词池的权重/随机化/多句变体（当前确定性首命中 + 固定兜底轮转）
- 云端 fallback（§10.3；明确不在默认链，未实现）
- ASR（§13 X-1）
- 记忆的跨语言召回（中文提问查不到日文记忆，字面匹配的必然结果，见已知坑位）

### 对外暴露

| 接口 | 签名 | 稳定性 |
|---|---|---|
| `respond` | `respond(input: { text: string; utteranceId: string }): Promise<Reply>` | 契约 §7.6（永不 reject） |
| `cancel` | `cancel(): void` | 契约 §7.6（只中止在途 LLM；已发出的回复不回滚） |

> 内部接口（不对外）：`handleHeadPatted(patCount)`（`head_patted` 事件入口）、`snapshot()`（自检诊断：state/inflight/llmDisabled/historyTurns/voiceBusy）、`dispose()`、`attachUtteranceHandler(bus, orchestrator)`、`retrieveMemory()`（段 ③）/`scheduleMemoryWrite()`（ADR 0020 D4/D5，模块内私有）。

### 消费事件

| 事件 | 用途 |
|---|---|
| `user_utterance` | 唯一入口 → `respond()` |
| `head_patted` | 规则池的事件条件（选摸头台词；说话/思考时跳过） |
| `speech_started` / `speech_ended` | 只用于跟踪"voice 是否在播"（`voiceBusy`），据此决定摸头是否该出声；不产生动作、不改状态 |

> 生产侧：`intent_resolved`、`llm_failed`（§6.3 全量清单内，未新增事件）。

### 已知坑位

| 现象 | 影响 | 规避 |
|---|---|---|
| **关键词是字面子串，规则词过宽会误伤**：实测 `"测试"` 让 `INVALID 测试` / `NOAUDIO 测试` 命中"游戏开发部"台词，LLM 与 TTS 分支被整段跳过 | 自检假失败，真实对话也会"答非所问" | 规则词必须短而具体；本轮已把 `"测试"` 从台词池移除（保留 `游戏/开发部/桃井/部活`）。新增规则要在自检里跑一遍 |
| **健康检查失败 = 整个会话熔断**（§11 明写） | 用户中途启动 Ollama 也不会自愈，必须重启应用 | 启动日志明确写"本会话不再探测"；`snapshot().orchestrator.llmDisabled` 可诊断。不提供"重探"开关（§11 不允许） |
| **`qwen3:4b` 冷启动首问约 10s，超过 §9.1 的 8s `thinking` 预算** | 应用刚启动后的第一句话可能 `llm_failed{timeout}` → 兜底；第二句起通常 1.3–2.6s、`route=llm` | 这是硬件/预算落差，不是清洗失败；可先手动问一句预热、或按 `docs/guides/LOCAL-SERVICES.md` §1.6 评估放宽 `PET_LLM_TIMEOUT_MS`（会偏离契约 8s）。健康检查成功 ≠ 模型已载入 |
| **清洗会把括号内容一律当旁白丢掉**：实测 `我叫天童凯伊（Kei Tendo）。` → `我叫天童凯伊。` | 括号里的补充说明/英文名不会进入 TTS | 这是 §9.2"text 不含括号"的必然取舍；提示词已禁止括号。若将来要保留，需要先改 §9.2（ADR + 契约 minor），不在清洗里偷偷放行 |
| 清洗只处理 ≤60 字的短括号组 | 很长的括号旁白不会被剥离 → 仍判 `invalid_output` 走兜底 | 宁可降级也不猜正文边界；日志里 `text:decorations-stripped` 可确认清洗是否发生 |
| **`thinking` 预算包含健康检查** | 首轮最坏 800ms + 7.2s；不是"8s 纯推理" | `remaining = requestTimeoutMs - 已用`；剩余 ≤100ms 直接判 timeout，不再发 chat |
| 文本校验偏严：清洗后仍残留中文括号/方括号/星号/URL 一律拒绝 | 模型偶尔写出未配对的括号或链接时会被判 `invalid_output` 而降级 | 短括号/粗斜体已在清洗阶段剥离（ADR 0018 D2）；残留即拒绝，不从宽。自检覆盖了非法样本 |
| 台词池/角色卡只在启动读一次 | 改 `lines.json` / 角色卡要重启 | 启动日志打印路径与条数；不做热更新（避免半更新状态） |
| 兜底是**确定性轮转** | 连续同话题会听到固定顺序的几句 | 目前 5 条，足够覆盖降级；随机化会牺牲可复现性，暂不做 |
| 被取消的 `respond` 仍返回兜底 `Reply` | 调用方若把返回值当事实会误判（实际未发布） | 事件才是唯一事实（§6.1）；返回值只保证 §7.6 "永不 reject、类型合法" |
| **记忆写入是异步的（`setImmediate`）**：`respond()` 返回时可能还没落库 | 单元测试/自检里"写完立刻查"会读到 0 行（本轮踩到，已用 flush 修复） | 需要确定性时等一轮 `setImmediate`（测试）或轮询 `snapshot().rows`（自检）；生产路径不需要等 |
| **跨语言检索不到**：记忆里是日文，用户用中文问同一个东西 | 段落 ③ 为空，模型"记不住" | 字面匹配的必然结果（ADR 0020 D4）；不引入 Embedding（§10.1 $5）。缓解方式：记忆同时存用户原话，用词尽量贴近 |
| **检索发生在 LLM 分支内** | 规则/兜底路径不会去查记忆，`lastRetrieve` 可能停留在上一轮 | 段 ③ 只服务 LLM；想看"刚查了什么"看 `logs/pet.log` 的 `记忆检索` 行或 `snapshot().memory.lastRetrieve` |

### TODO
- [x] 台词池与规则匹配 + 冷却
- [x] 本地 LLM 客户端与 8s 硬超时
- [x] 输出 schema / 枚举校验与兜底
- [x] `user_utterance` → `intent_resolved` / `llm_failed` 接线 + 打断
- [x] 安装 `qwen3:4b` 后真机联调（2026-10-29：健康检查通过、一轮 3.1s；输出被判 `invalid_output`，见已知坑位）
- [x] 真实 LLM 输出的合规化（ADR 0018 D2：提示词约束 + 装饰剥离 + 严格校验；真机 `route=llm` 1.7s）
- [ ] 冷启动预热策略（避免首问撞 8s 预算；需先决定是否值得多一次本地推理）
- [x] 记忆段接入（`memory.retrieve` → 段 ③，≤5 条；ADR 0020）
- [x] 记忆写入接线（`publish()` 之后异步写 user + pet）
- [x] 输入条热键与 `input:'hotkey'` 的真实来源（ADR 0016）
- [ ] 记忆的淘汰/压缩策略（当前只增不删）

---

## 模块：voice

### 已完成
- **TTS 客户端（ADR 0015 D2）**：`POST http://127.0.0.1:9880/tts`，字段照 `api_v2.py`（`text` / `text_lang` / `ref_audio_path` / `prompt_text` / `prompt_lang` / `text_split_method:cut5` / `batch_size` / `speed_factor` / `temperature` / `top_k` / `top_p` / `repetition_penalty` / `streaming_mode:false` / `media_type:'wav'`）
- **配置前置**：参考音频（3–10s，`PET_TTS_REF_AUDIO`，默认 `data/ref/kaiyi.wav`）+ 参考文本（`PET_TTS_PROMPT_TEXT`）缺一 → `enabled=false`，**不发起任何 HTTP**，`speak()` 直接 `failed`（本机参考音频已就位，仅缺日文逐字文本）
- **语种配置（ADR 0019，本轮修订为 ja/ja）**：`PET_TTS_PROMPT_LANG` 默认 **`ja`**（本机凯伊参考音频是日文）、`PET_TTS_TEXT_LANG` 默认 **`ja`**（角色只说日文，ADR 0022 修订了 ADR 0019 的 `zh`）；两者都从 `.env` 读取并统一转小写，`/tts` 的 `prompt_lang` / `text_lang` 直接取 `TtsConfig`，客户端不写死语种；启动日志 `TTS 已配置` 打印 `promptLang` / `textLang`。跨语种能力仍在（v2ProPlus 支持日文参考 + 其他语言合成，上一轮实测 200 / 3.97s），但默认走同语种组合
- **`.env` 配置来源（ADR 0018 D1）**：`PET_TTS_REF_AUDIO` / `PET_TTS_PROMPT_TEXT` / `PET_TTS_PROMPT_LANG` / `PET_TTS_TEXT_LANG` / 两个超时都可写进工程根目录 `.env`（进程环境变量优先）。**本机本次已填好** `PET_TTS_PROMPT_TEXT`（`data/ref/kaiyi.wav` 的逐字日文，20 字）与 `PET_TTS_TEXT_LANG=ja` → TTS `enabled=true`，`doctor` 的"参考文本/参考语种/合成语种/超时"四项全绿
- **权重与配置权威源（ADR 0017，本轮）**：`GPT_SoVITS/configs/tts_infer.yaml` 的 `custom:` 段是唯一权威（`api_v2.py` 的默认 `-c` 就是它），并保留内容一致的 `tts_infer.kaiyi.yaml` 作为显式启动副本。当前值：`version: v2ProPlus`、`t2s_weights_path: GPT_weights_v2ProPlus/KaiYi-e10.ckpt`、`vits_weights_path: SoVITS_weights_v2ProPlus/KaiYi_e18_s288.pth`、`device: cpu`、`is_half: false`；改前备份 `tts_infer.yaml.bak-20261030-1040`
- **真实凯伊合成已通（本轮真机）**：服务以凯伊配置重启（启动日志 `Loading Text2Semantic weights from .../KaiYi-e10.ckpt`、`Loading VITS weights from .../KaiYi_e18_s288.pth`）；`POST /tts` 用 `data/ref/kaiyi.wav`（4.28s）返回 **HTTP 200 / 6.2s / 85,804 字节 RIFF**；应用链路同一句话：合成 4.2s → 下发 217,644 字节 → 播放 3.4s → `speech_started` → `speech_ended{completed}`（临时用占位参考文本，仅验证链路）
- **超时**：首字节 3000ms / 整段 30000ms（§7.4），`AbortController` 中止；`PET_TTS_FIRST_BYTE_TIMEOUT_MS` / `PET_TTS_TOTAL_TIMEOUT_MS` 可覆盖（CPU 非流式部署用）；无重试（§11）
- **错误面**：连接拒绝 / 超时 / 非 200（含服务端 400 的 `message`）/ 非 RIFF-WAVE → 全部折算 `speech_ended{failed}`，原因只进日志
- **语音状态机（ADR 0015 D3）**：单一在途；`speak()` 永不 reject、在**终态**兑现；>120 字直接 `failed`（不发 HTTP、不截断、不影响在途语音）；`stopSpeaking()` 幂等；新 `speak` 先以 `interrupted` 结束旧的
- **事件唯一生产者**：`speech_started` / `speech_ended` 只由 voice 发；播放事实由渲染侧经新增 `cmd:speech` 上报（`started` / `ended{completed|failed}`）；`interrupted` 只由主进程决定，渲染侧不得上报
- **打断序列**：`cmd:voice{kind:'stop'}`（命令，让渲染侧立刻停源）→ `speech_ended{interrupted}`（事实）；渲染侧按 `utteranceId` 幂等
- **渲染侧播放器**（`src/renderer/voice/speech-player.ts`）：`decodeAudioData` 解 WAV；预计算 **30ms 窗 / 50% 重叠** RMS 包络（95 分位归一化、0.06 噪声门）；按 `AudioContext.currentTime` 取样 → 8 级口型帧（attack 0.55 / release 0.30、≤30Hz）→ `setMouthFrame`；首帧上报 `started`、自然结束上报 `completed`、解码/设备失败上报 `failed`；被 stop 时**不**上报
- **自动播放（ADR 0015 D5）**：`bootstrap()` 在 `app.ready` 前 `app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required')`；主窗口 `focusable:false` 无手势。实测 `AudioContext.state='running'`
- **单测 14 个**：TTS 客户端（WAV/HTTP 400/首字节超时/整段超时/外部取消/未配置不发请求/**语种来自配置**）、状态机（failed/正常/打断/新 speak 结束旧/120 字/陈旧上报）、`cmd:speech` 载荷守卫
- **语音自检 30 条全绿**（`npm run selftest:speech`，本地桩）：规则路径 + 真实播放 + `speech_started` + 帧 7 + `overlay=speaking` + 字幕 + 截图像素差 + `completed`；LLM 合法/非法；打断；TTS 500 保留字幕；记忆写入 + 段 ③ 注入 + 检索延迟；字幕时序（`SLOWTTS` 桩延迟 1.2s）；voice 收尾 idle

### 未完成
- **真实 GPT-SoVITS 合成的音质验收**：链路、权重、语种都已就位（`prompt_lang=ja` + `text_lang=ja`），但本轮没有重跑真实 `/tts`（改的是语种默认值与文本语言，客户端代码未动）；音色/韵律仍需一次真机试听
- 流式合成（`streaming_mode`）与"边合成边播"（ADR 0015 D2.5 解释了非流式的首字节矛盾）
- 音量/语速/音色的运行期配置（只有固定常量与启动配置权重，本轮未暴露 UI）
- ASR 触发的打断（下一步）

### 对外暴露

| 接口 | 签名 | 稳定性 |
|---|---|---|
| `speak` | `speak(text: string, utteranceId: string): Promise<'completed' \| 'interrupted' \| 'failed'>` | 契约 §7.4（永不 reject；终态兑现） |
| `stopSpeaking` | `stopSpeaking(reason?: 'interrupt' \| 'shutdown'): void` | 契约 §7.4（幂等） |

> 内部接口（不对外）：`handleSpeechReport(report)`（`cmd:speech` 入口）、`snapshot()`（phase/activeUtteranceId/enabled/disabledReason）、`dispose()`、`createTtsClient` / `isSpeechReport`。

### 消费事件

| 事件 | 用途 |
|---|---|
| 无（voice 不订阅事件） | 只被 `orchestrator` 调 `speak()`；播放事实走 `cmd:speech` 通道 |

> 生产侧：`speech_started`、`speech_ended`（§6.3 全量清单内，未新增事件）；命令侧：`cmd:voice{kind:'speak'|'stop'}`。

### 已知坑位

| 现象 | 影响 | 规避 |
|---|---|---|
| **本机无 CUDA**（`nvidia-smi` 不存在），`TTS_Config` 会把 `custom.device: cuda` 自动降为 CPU 且强制 `is_half=false` | v2ProPlus CPU 推理慢；`streaming_mode:false` 下"首字节"= 整段合成完成；实测一句话 **6.2s**，契约默认 3s **必然超时** | 真机运行设 `PET_TTS_FIRST_BYTE_TIMEOUT_MS=15000`、`PET_TTS_TOTAL_TIMEOUT_MS=120000`（默认值不改，ADR 0015 D2.5） |
| **参考音频是硬前置**（`TTS.py` 要求 3–10 秒），且必须有**逐字文本** | 音频已在位（4.28s），`PET_TTS_PROMPT_TEXT` 为空时仍判"未配置"，一个 HTTP 都不发 | 文本必须与音频逐字一致；写进 `.env` 后重启（`setx` 同名变量会压过 `.env`）。零成本约束下不自动转写（无本地 ASR）。本轮已填好，`doctor` 的"参考文本"转绿 |
| **`prompt_lang` / `text_lang` 必须与内容匹配**：本机参考音频是日文，角色也只说日文 | `prompt_lang` 误用 `zh` 会让日文参考文本被中文 G2P 处理，音色/韵律明显跑偏；写错代码（如 `japanese`、`zh-CN`）服务端直接 400 | `.env` 设 `PET_TTS_PROMPT_LANG=ja` / `PET_TTS_TEXT_LANG=ja`（ADR 0019 / ADR 0022）；`doctor` 校验取值，并在"参考文本含假名但 prompt_lang=zh"时黄色提醒。换参考音频必须同时改语种与逐字文本 |
| **`custom:` 段决定版本与权重**；权重是 `KaiYi-e18_s288.pth`，文件名推不出版本 | 用 `/set_sovits_weights` 会在 v2 底座上加载 v2ProPlus 权重 → 音色/音质异常甚至报错 | 改 `tts_infer.yaml` 的 `custom:`（权威）并同步 `tts_infer.kaiyi.yaml`；不要靠 `/set_*_weights` 切（ADR 0017） |
| **改 yaml 不重启服务 = 没生效**：权重只在进程启动时加载 | 表现为"配置明明改了，声音还是默认的"（本轮实测踩到：9880 上的旧进程仍持有默认 v2 权重） | 改完 `Stop-Process` 旧 python 再起；以启动日志的 `Loading ... KaiYi-*.ckpt / KaiYi_e18_s288.pth` 为准 |
| 启动日志里的 `_IncompatibleKeys(missing_keys=['enc_q.*', ...])` | 看起来像加载失败，容易被误判成权重不兼容 | 这是 SoVITS **训练期判别器**分支，推理权重本就没有；只要没抛异常、能合成即正常 |
| 系统代理（`127.0.0.1:7890`）会让 GPT-SoVITS 自己的 gradio 本地检查 502 | WebUI 的 TTS 子进程报 "localhost is not accessible" | 启动服务前设 `NO_PROXY=localhost,127.0.0.1,0.0.0.0,::1`（`run-webui.bat` 已这么做） |
| **契约原写"PCM ArrayBuffer"，实现传 WAV 容器字节** | `decodeAudioData` 需要容器头；裸 PCM 还要跨进程传采样率/声道 | 契约 1.4.0 已改写（§3.5 / §7.4）；包络仍在渲染进程（§7.4 不变） |
| **口型帧语义未标定**（8×8 图集无标注；帧 4 又被摸头当 shy 用） | 换图集/换角色时帧序可能不对 | 8 级映射与帧 0 闭嘴都集中在 `mouth-mapping.ts` + `shared/constants.ts`；说话时摸头不改嘴型（§5.3） |
| 播放结束依赖渲染侧上报 `cmd:speech` | 渲染进程崩溃/挂起时 voice 会话停在 `waiting-start`/`playing`，直到下一次 `speak`/`stop` 收尾 | 不加看门狗（避免契约外机制）；`snapshot().phase` 可诊断；下一次说话必然先 interrupted 旧会话 |
| `speech_ended{failed}` 的 `durationMs` 是"发起→失败"，不是播放时长 | 按播放时长做统计会偏差 | 契约只要求 `durationMs` 字段；口径写在 ADR 0015 D3.8 |
| AudioContext 未 running（设备丢失/策略拦截） | 表现为"解码成功但没声音" | 播放前 `resume()`；仍非 running → `failed` 并记日志；autoplay 开关在 `app.ready` 前设置 |
| 渲染侧 `console` 转发丢对象细节（`[object Object]`） | 播放日志在主进程日志里看不清 utteranceId | 关键事实由主进程 voice 打印（下发字节数、started/ended、失败原因） |

### TODO
- [x] GPT-SoVITS `api_v2.py` 客户端（127.0.0.1:9880）
- [x] 音频下发与渲染侧播放/包络
- [x] 打断语义（`interrupted` 必须先发 `speech_ended`）
- [x] 包络 → `MouthChannel.setFrame`（ADR 0015 D4）
- [x] 真实 TTS 联调：参考音频就位 + `api_v2.py` 以凯伊权重启动（ADR 0017）；`/tts` 与应用链路均实测通过
- [x] 填入 `data/ref/kaiyi.wav` 的**日文**逐字文本（`.env` 的 `PET_TTS_PROMPT_TEXT`）
- [ ] 按真实逐字文本做一次音质/韵律验收（试听）
- [x] TTS 语种配置（`PET_TTS_PROMPT_LANG=ja` / `PET_TTS_TEXT_LANG=ja`，ADR 0019 + ADR 0022；doctor 校验）
- [x] 参考文本的文件式配置 → 由 `.env` 取代（ADR 0018 D1；不再依赖 `setx`，`.env.example` 有模板）
- [ ] 音量/语速/音色运行期配置
- [ ] 流式合成评估（需新 ADR：WAV 头 + 分块 PCM 的拼装）

---

## 模块：memory

### 已完成
- **schema 与迁移（ADR 0020 D2）**：`src/main/memory/schema.ts`；单表 `memories(id, at, kind, text, tags, ref_id)`，`kind` 有 `CHECK IN ('user','pet','system')`，`idx_memories_at(at DESC, id DESC)`；版本走 `PRAGMA user_version`，迁移数组**只增不改**、每个迁移一个事务、失败整体回滚（不允许半迁移的库继续用）
- **FTS5 `trigram` + 短词 LIKE 降级（ADR 0020 D3）**：`memories_fts` 是 external-content 表（`content='memories'`、`content_rowid='id'`、`tokenize='trigram'`）+ 标准三触发器；新建索引表时 `rebuild` 一次。**实测 `unicode61` 会把 `今日はいい天気ですね` 当成一个 token（查 `天気` 命中 0）**，而 `trigram` 是子串索引但要求查询词 ≥3 字符 → 1–2 字查询（`咖啡`、`好き`）走 `LIKE`（`%term%`，`ESCAPE '\'` 转义）；FTS 建不起来时整体降级 LIKE
- **检索查询策略（ADR 0020 D4）**：`query.ts` 纯函数——按"非字母/数字/汉字/假名"切词、CJK 长串切**三字滑窗**（`喜欢什么咖啡吗` → `喜欢什/欢什么/什么咖/么咖啡/咖啡吗`）、ASCII 长词保持整词；长词进 FTS（短语 `OR`），短词进 LIKE；候选各限 80 条，按 `hits`（text+tags 子串命中数）→ `at` → `id` 排序，`limit` 默认 5 / 上限 20
- **写入与事实标签（ADR 0020 D5/D6）**：`index.ts`；`write()` 同步插入、`tags` 存 JSON 数组、`text` 超 2000 字截断；总是把 `extractFactTags(text)` 合并进 `tags`（`喜欢/不喜欢/好き/嫌い/苦手` → `like:X`/`dislike:X`，**否定优先**，去主语与句尾助动词）
- **三层降级（ADR 0020 D7）**：文件库打不开 → 自动用 `:memory:`（同 schema，本次会话可写可检索）；再失败 → `mode='disabled'`（`retrieve→[]`、`write` 空操作）；单条操作异常只记 `lastError` + WARN。`init()` 只在最后一层 reject，`runtime` 仍 `try/catch` 兜住（记忆不是启动必需项）
- **WAL 与并发（ADR 0020 D1）**：`journal_mode=WAL`（`:memory:` 恒为 `memory`）、`synchronous=NORMAL`、`busy_timeout=2000`；单测实测"另一连接持有未提交写事务时，主连接检索**不被阻塞**且看不到未提交行，提交后立即可见"
- **诊断**：`snapshot()` 返回 `enabled/mode/path/wal/fts/schemaVersion/rows/lastWriteAt/lastRetrieve{query,terms,count,ms,fts}/lastError`；`runtime.snapshot().memory` 直接可用；检索 >50ms 会记一条 WARN
- **单测 21 个（`npm run test:memory`，跑在 Electron 的 Node 里）**：初始化/迁移幂等、`:memory:` 降级、长词 FTS 命中、短词 LIKE 命中、未命中、注入与通配符、limit 钳制与排序（命中数优先 / 同分新近优先）、持久化（close → 重新 init 等价"重启"）、WAL 并发读、写/读失败降级、非法 kind、事实标签（中/日、否定）、标签参与检索、纯函数（切词/转义/匹配式）、**500 行 × 20 次平均 ≤ 50ms**
- **实测**：500 行库上 5 个查询词轮转 20 次，平均 ≈1–2ms（预算 50ms）；单轮 `retrieve` 在 `logs/pet.log` 里记 `记忆检索 {query,terms,count,ms,fts}`
- **淘汰策略（2026-10-31，ADR 0025）**：`prune()` 按 `at ASC, id ASC` 删除超出 `MEMORY_MAX_ROWS=2000` 的行，单次最多 `MEMORY_PRUNE_BATCH_MAX=200` 行（最坏耗时锁在毫秒级）；`write()` 之后用 `setImmediate` 排期，不阻塞调用方；FTS5 是 external-content 表，`AFTER DELETE` 触发器自动同步索引（单测直接数 `memories_fts` 行数验证）。`snapshot().lastPrune` 暴露最近一次的 `{at, deleted, rows}`

### 未完成
- 跨语言召回（中文提问查不到日文记忆）——不做 Embedding 就无解，见已知坑位
- `kind='system'` 目前没有任何写入方（预留给 §10.3 的云端调用审计）
- 迁移只有 v1；后续加字段要追加 `version: 2`
- 淘汰是"按条数"而不是"按时间/重要度"：事实标签（`like:`）不参与保留权重，长期仍可能把早期偏好挤掉

### 对外暴露

| 接口 | 签名 | 稳定性 |
|---|---|---|
| `init` | `init(dbPath: string): Promise<void>` | 契约 §7.5（建表/迁移/WAL/FTS；最后一层失败才 reject） |
| `retrieve` | `retrieve(query: string, limit?: number): MemoryFact[]` | 契约 §7.5（同步、失败返回 `[]`、目标 ≤50ms） |
| `write` | `write(event: MemoryWrite): void` | 契约 §7.5（同步、自吞异常；写后 `setImmediate` 触发淘汰） |
| `prune` | `prune(): number` | 契约 §7.5（ADR 0025）：按 `at` 升序删超额行，单次 ≤200 行，返回删除数 |
| `close` | `close(): void` | 非契约（内部）：停机释放句柄 |
| `snapshot` | `snapshot(): MemorySnapshot` | 非契约（内部诊断，不进 `RenderState`） |

> 内部实现（不对外）：`extractFactTags`（`facts.ts`）、`extractTerms` / `escapeLike` / `buildFtsExpression` / `countHits`（`query.ts`）、`MIGRATIONS` / `migrate` / `ensureFts`（`schema.ts`）。契约类型放在 `src/shared/memory-types.ts`，`orchestrator` 只做 `import type`。

### 消费事件

| 事件 | 用途 |
|---|---|
| 无（按契约 E-5，memory 不订阅事件；写入由 `orchestrator` 单点调用） | — |

### 已知坑位

| 现象 | 影响 | 规避 |
|---|---|---|
| **`better-sqlite3` 是 ABI 相关原生模块**：仓库按 Electron 33.4.11（`NODE_MODULE_VERSION=130`）安装；宿主 Node 是 24.x（137） | 用宿主 `node` 跑 `memory.test.ts` 会 `ERR_DLOPEN_FAILED`；用反了则应用起不来、记忆 `disabled` | 单测走 `npm run test:memory`（`scripts/run-electron-test.mjs` 用 `ELECTRON_RUN_AS_NODE=1`）；安装用 `prebuild-install --runtime=electron --target=33.4.11`（手册 §8） |
| **npm 11 默认不执行依赖的 install 脚本**（allow-scripts 策略） | `npm install better-sqlite3` 之后 `build/Release/better_sqlite3.node` 不存在 → `init()` 抛错 → `mode=disabled`，段 ③ 永远为空 | 显式跑一次 `prebuild-install`；`npm run doctor` 的"SQLite 原生模块"会直接报红 |
| GitHub Releases 在本机不可达（`prebuild-install` 默认源） | 下载预编译二进制超时 | 用 npmmirror 镜像：`npm_config_better_sqlite3_binary_host=https://registry.npmmirror.com/-/binary/better-sqlite3` |
| **`trigram` 匹配不到 1–2 个字符的查询** | 若只走 FTS，"咖啡/好き"这类最短常用词永远查不到 | 短词走 LIKE（ADR 0020 D3）；`retrieve` 的两个路径都跑，候选合并后打分 |
| **中日文没有空格**：`unicode61` 整句一个 token | 换分词器会静默失去子串检索能力（实测 `天気` 命中 0） | 分词器固定 `trigram`；CJK 查询切三字滑窗 |
| **跨语言检索不到**：记忆里是日文，用户用中文问同一件事 | 段 ③ 为空，模型"记不住" | 字面匹配的必然结果；不引入向量库（§10.1 `$5`）。记忆里同时存用户原话可缓解 |
| 写入是**异步**的（`orchestrator` 用 `setImmediate`） | "说完立刻查"可能还没落库 | 生产上不需要等；单测/自检显式等一轮 `setImmediate` 或轮询 `rows` |
| 记忆只增不删 | `data/memory.db` 与 `-wal` 会长大（文本量级，增长慢） | 已在 `.gitignore`；需要时手动删文件（下次启动重建）。不做自动淘汰（避免"忘掉用户说过的话"） |
| `:memory:` 降级时 `wal=false`、重启即丢 | 用户以为记不住 | 启动日志 `记忆库已就绪 {mode:'memory'}` 与 `snapshot().mode` 可诊断；`lastError` 保留原始错误 |
| `snapshot()` 每次都 `SELECT COUNT(*)` | 频繁调用（毫秒级轮询）会有额外开销 | 只在自检/诊断里调用；生产路径不轮询 |

### TODO
- [x] schema 与迁移（单表 `memories` + `user_version`）
- [x] FTS5（`trigram`）+ 短词 LIKE 降级与排序
- [x] 打开失败时退化为 `:memory:` 模式，再失败 `disabled`
- [x] 事实标签（喜欢/讨厌/好き/嫌い）与标签参与检索
- [x] 写入时机（发布后异步、不阻塞 TTS）
- [ ] 淘汰/压缩策略（按时间或条数上限）
- [ ] 迁移 v2（例如给 `tags` 建独立索引表）—— 仅在确有需要时

---

## 跨模块阻塞

| 阻塞项 | 涉及模块 | 当前状态 | 需要谁决定 |
|---|---|---|---|
| 输入条独立窗口是否复用同一 preload | shell | 已决定：**不复用**，独立最小 preload 只暴露 `submit(text)`（ADR 0016 D1） | —（已解决） |
| 掩膜坐标系在窗口缩放/DPI 变化时的重建时机 | shell、render | 待定 | 同上 |
| **契约正文仍写"VRM / three-vrm"（§1.2、§2、§3.1、§7.3、§11），资产实际是 glTF `.glb`** | 全局 | ADR 0009 已记录差异，本轮按指令不改 `CONTRACTS.md` | 下一次契约升版时把"VRM"改为"glTF 2.0（GLB）"（minor） |
| **当前动作名想进 `getState()` 就需要给 `RenderState` 加字段** | render | 本轮按 ADR 0014 D7 走内部诊断，`RenderState` 未增删字段 | 若 `shell`/`orchestrator` 确需读取，先出 ADR 再升契约 minor |
| **本机 Ollama 已有对话模型**（`qwen3:4b`，doctor 实测 4 个模型） | orchestrator | **已解决（ADR 0018 D2）**：提示词明确禁止 + 校验前剥离装饰（围栏/括号动作/Markdown），真机 1.7s `route=llm`；冷启动首问仍可能撞 8s 预算（见 orchestrator 坑位） | —（已解决） |
| **ADR 0015 D2.2 的示例权重（`KaiYi_e12_s192.pth`）与"不改 `tts_infer.yaml`"已过时**，与实际启动方式（默认 `-c` 就是 `tts_infer.yaml`）冲突 | voice、部署 | 已由 ADR 0017 修订：`tts_infer.yaml` 的 `custom:` 段为权威，`tts_infer.kaiyi.yaml` 为同内容副本；权重改为 `KaiYi-e10.ckpt` + `KaiYi_e18_s288.pth`；手册与本节已同步 | —（已解决） |
| **GPT-SoVITS 参考文本缺失**：服务已用凯伊权重启动、日文参考音频已就位（4.28s），`.env` 中 `PET_TTS_PROMPT_TEXT` 仍为空；语种已按 `ja`/`ja` 配好（ADR 0019 / ADR 0022） | voice | **已解决（本轮）**：`.env` 已填逐字日文（20 字），TTS `enabled=true`，`doctor` 参考文本/语种/超时四项全绿；音质验收仍待试听 | —（已解决） |
| **`memory` 未实现 → 提示词段 ③ 恒为空** | orchestrator、memory | **已解决（ADR 0020）**：`memory.init/retrieve/write` 全部落地，段 ③ 注入 ≤5 条并带 `[MM-DD] kind: text`；空/失败仍退回「（无）」；`selftest:speech` 有"检索命中 → `memoryFacts>0`"的端到端断言 | —（已解决） |
| **字幕显示时机与 TTS 合成耗时错位**（先看字后听音） | shell、voice | **已解决（ADR 0021）**：`intent_resolved` 只登记、`speech_started` 显示、`failed` 兜底、15s failsafe；`selftest:speech` 用 `SLOWTTS` 桩断言"`intent_resolved` 后不可见" | —（已解决） |
| **跨语言记忆召回不可用**（中文提问查不到日文记忆） | memory、orchestrator | 字面匹配的必然结果；不做向量检索（§10.1 `$5`） | 若确需跨语言召回，先出 ADR 评估"本地小模型翻译查询词"的成本（会增加一次推理） |

## 变更记录

| 日期 | 模块 | 摘要 | 契约版本 |
|---|---|---|---|
| 2026-10-31 | render、shell（资产协议）、全局 | ADR 0026 第 2 版（**决策反转**）：实机判定"逐像素重绘五官"恐怖、不像官方 → **废弃程序化眼型/红晕**，改为官方差分贴图（`data/expressions/eyes_{happy,shy,sad,surprised}.png` + `blush.png`）。新增 `expression-assets.ts`（解码/裁剪/采样/降级）、`shared/expression-files.ts`（协议白名单）、`pet-asset://asset/expr/<file>` 只读路由与 `PET_EXPRESSIONS_DIR` 配置；`emotion-face.ts` 删除全部眼型绘制，只留 emotion→资产映射与嘴型；`facial-texture.ts` 保留面空间栅格化/脏矩形/眼睛层/0.25s 淡入，眼睛层改为合成 PNG、还原改为 `ImageData` 快照（`faceDistance` 恢复为 0）。修 `percentileRange` 哨兵 bug、边缘像素改夹取（去"幽灵眼环"）。契约 **1.8.0**（§5.2 表情通道、§7.3 新增"表情表现"规则表、§11 新增差分缺失降级行）。**官方差分未拿到**：下载器卡在 uv TLS（PyPI 证书不受信）/ 缺 .NET 10 SDK / 未到 BA CDN，已记入 ADR 0026 D6.4；改用 `data/expressions.fixtures/`（非官方 fixture）自证管线。单测 **247**（24 套件，+5 新增：差分裁剪/采样/红晕强度/百分位区间/去重）、`tsc` 0 错、主链路自检 **97 条全绿**（有素材与空目录两种配置各跑一遍）、输入条/语音/缺失模型三套 exit 0 | 1.8.0 |
| 2026-10-31 | render | ADR 0026：① **行走转身**（修侧滑）：`walking` 期间 `animationRoot.rotation.y` 叠加 ±90° 偏航（指数逼近 9/s，≈0.3s），与 `look` 反应相加共用 Y 轴通道；停下/撞边/拖拽/回弹强制回正，偏航进 `motion.walkYaw` 诊断。② **emotion 上脸**：新增 `emotion-face.ts`（`EMOTION_FACE` 七个值 + 纯图元采样 + `resolveMouthOwner` 仲裁）、`facial-geometry.ts`（抽面空间三角形）、重写 `facial-texture.ts`（逐三角形重心插值栅格化 + 1%/99% 分位重归一化 + 脏矩形还原 + 眼睛透明层合成 + 打包颜色零分配 + `faceDistance` / `textureDigest`）。实测：换眼型 40ms（一次性）、淡入每步 3.6ms、眼像素 1,048,770 → 524,408（去重）。契约 **1.7.0**（§4.1 walking 朝向、§5.2 表情通道贴图实现、§7.3 四条禁令与降级、§11 两行降级）。单测 **242**（24 套件，+23 新增；上一轮记录的 244 未复现，本轮以 `npm test` 实测 242/24 为准）、`tsc` 0 错、主链路自检 **96 条全绿**、输入条/语音/缺失模型三套仍 exit 0；截图 `window-emotion-{neutral,happy,shy,sad,surprised,neutral-again}.png` + `window-walking.png`（侧身行走） | 1.7.0 |
| 2026-10-27 | 全局 | 建立模板；按 ADR 0002/0003 预置 shell、render 的已知坑位 | 1.1.0 |
| 2026-10-27 | shell、render | 契约升至 1.2.0（ADR 0004：`cmd:interactive` 增 `head`、`cmd:drag` 载荷边界、探针坐标与丢包降级）；建立工程骨架与共享层；主窗口按 §3.2 落地；渲染页占位 | 1.2.0 |
| 2026-10-27 | 全局 | Electron 基线一度按 ADR 0005（提议）升到 `44.7.0`，随后定位到崩溃与版本无关而是**工作区目录**所致，按 ADR 0006 撤回并恢复精确 `33.4.11`；`run.cmd` / `run-selftest.cmd` 会先打印完整性级别与 `DSH_SESSION_ID` 以区分启动上下文 | 1.2.0 |
| 2026-10-27 | 全局 | 工程根目录迁至 `D:\aa3dpet-app`（ADR 0007），§16.1 路径同步，契约升 patch 至 1.2.1；迁移后构建/类型/24 单测/完整自检全部复验通过 | 1.2.1 |
| 2026-10-27 | render | 第 2 步：占位胶囊体 + 呼吸 + 3–5s 眨眼 + `handleIntent`/`getState`（未知 intent 降级并告警、200ms 去重）；自检里跑通 render 接口探针；`three@0.170.0` + `@types/three@0.170.0`（dev） | 1.2.1 |
| 2026-10-27 | shell、render | 命中链路：16ms 单轮询器 + 纯状态机（8px 迟滞/100ms 冷却/单探针在飞/超时降级）、128×72 掩膜 20Hz 采集 + 垂直翻转、`cmd:probe`/`cmd:interactive` 应答、cold/ready/stale 与 R-9 矩形退路；`OrchestratorState` 增 `idle`（ADR 0008），契约升 1.3.0 | 1.3.0 |
| 2026-10-27 | shell、render | 拖拽 + 摸头（第 4/5 步）：`cmd:drag` 接线、**同一个** 16ms 定时器驱动窗口位移写回与阈值判定（D-5）、D-2/D-3/D-4/D-6/D-7 全部落在主进程、`evt:broadcast` 首次落地（`drag_started`/`drag_released`/`head_patted`）、R-8 掩膜暂停与 500ms 沉降（`setPaused` 由拖拽状态驱动）、FSM `pressed` 保持位；单测 63 个全绿、`tsc` 0 错、自检 17 条断言全绿（exit 0）；未新增通道/事件/状态/intent/emotion，未改 `CONTRACTS.md` | 1.3.0 |
| 2026-10-28 | 全局 | 先把上一轮未落盘的资产盘点写进 ADR 0009/0010 与 MODULE_STATUS（GLB、骨骼命名、无 morph/无眼睑、眨眼证伪、贴图式口型）；记录"契约仍写 VRM"的差异与待升版项 | 1.3.0 |
| 2026-10-28 | shell、render | render 阶段 4.5：GLB 加载管线（`pet-asset:` 只读协议 + GLTFLoader.parse）、主进程 GLB JSON 包围盒解析、按包围盒定窗口（422×720）与脚底锚点、无光照材质、真实模型替换占位、呼吸 + 视线跟随/5s 微动（不眨眼）、EyeMouth 口型通道（静态闭嘴底图 + 8× 超采样，阶段 5 才驱动）、`model_ready` 上行；模型缺失/关键骨骼缺失 → `modelReady=false` + 胶囊体。单测 77 个全绿、`tsc` 0 错、自检 35 条断言全绿、缺失回退 4 条断言全绿（均 exit 0）；未新增状态/事件/intent/emotion，未改 `CONTRACTS.md` | 1.3.0 |
| 2026-10-28 | render、shell | render 阶段 5（ADR 0014）：HFSM 三层壳（`hfsm.ts` 纯逻辑）+ 44 段自带动画接入（idle=`Cafe_Idle`、held=`Carrier_Idle`、walk=`Move_Ing` 只识别）+ `AnimationMixer` crossFade + 骨骼仲裁（Mixer→视线→pat→单次写回）+ 程序化呼吸退役 + `head_patted`→`pat_react`（说话时 ≤0.4、不改嘴型）+ 拖拽悬空姿态（抬升/摇摆）+ `HIDE_ATTACHMENTS` 配件隐藏 + 一次性地面校正；shell 侧新增 `hideAttachments` 配置并透传。单测 95 个全绿、`tsc` 0 错、自检 51 条断言全绿（exit 0），三张验收截图 `window.png`（Idle）/`window-drag.png`/`window-pat.png`；未新增状态/事件/intent/emotion，`RenderState` 未增删字段，未改 `CONTRACTS.md` | 1.3.0 |
| 2026-10-29 | 全局、orchestrator、voice、render、shell | ADR 0015：本地 LLM（Ollama `/api/tags` 健康检查 + `/api/chat` 8s 硬超时 + 熔断 + 取消）与本地 TTS（GPT-SoVITS `/tts`、WAV 容器、3s/30s 可覆盖）；orchestrator 三路分流 + 台词池/角色卡 + §9.2 校验 + `head_patted` 规则；voice 状态机（单一在途/终态兑现/打断）+ 渲染侧 WAV 播放与 30ms RMS 包络 + 8 级口型 → `setFrame`；新增 `cmd:speech` 与 `cmd:voice` 命令联合体（契约 1.4.0）；shell 事件总线单一出口 + 字幕气泡；bootstrap autoplay 开关。单测 138 个全绿（16 文件）、`tsc` 0 错；自检 61 条 + 语音套件 23 条 + 缺失模型 4 条全绿（均 exit 0）；截图 `window-idle.png` / `window-speech.png`（嘴部像素差 9100/57600）。未新增状态/事件/intent/emotion | 1.4.0 |
| 2026-10-29 | shell、全局 | 第 6 步：输入条独立窗口（260×44、非透明、show:false 复用、无 parent）+ 纯函数定位（上方 8px / 贴顶下方 8px / 水平居中 / 工作区钳制）+ 独立最小 preload（只暴露 `submit`）+ Enter（IME 双守卫）在渲染页、Esc/失焦在主进程收窗 + `cmd:respond` 接入（发送方白名单 → 先收窗 → 发 `user_utterance{input:'hotkey'}`）+ 全局热键三级降级（Ctrl+Shift+B → Ctrl+Alt+B → 只记 ERROR）；新增 `npm run doctor`（只读环境自检）与 `docs/guides/LOCAL-SERVICES.md`、`run-doctor.cmd` / `run-selftest-input.cmd`；ADR 0016。单测 151 个全绿（18 文件，+13）、`tsc` 0 错、四套自检全 exit 0（主链路 61 / 输入条 24 / 语音 23 / 缺失模型 4），截图 `dist/selftest/input-bar.png`、`input-submitted.png`；未新增通道/事件/状态/intent/emotion，未改 `CONTRACTS.md` | 1.4.0 |
| 2026-10-30 | voice、部署 | ADR 0017：TTS 权重切到凯伊（`KaiYi-e10.ckpt` + `KaiYi_e18_s288.pth`，`version: v2ProPlus`，`device: cpu` / `is_half: false`）；`tts_infer.yaml` 的 `custom:` 段成为权威（`api_v2.py` 默认 `-c` 就是它），`tts_infer.kaiyi.yaml` 为同内容副本，改前备份 `tts_infer.yaml.bak-20261030-1040`。以凯伊配置重启 9880（旧进程持有默认 v2 权重，改文件不生效），启动日志确认两个 KaiYi 权重加载；`/tts` 实测 **200 / 6.2s / 85,804B**，应用链路合成 4.2s + 播放 3.4s + `speech_started`/`completed`。参考音频 `data/ref/kaiyi.wav`（4.28s / 44.1k / mono）已就位，仍缺逐字 `PET_TTS_PROMPT_TEXT`。未改代码、未改契约 | 1.4.0 |
| 2026-10-30 | 全局、shell、orchestrator、voice | ADR 0018：① `.env` 加载器（`src/shared/env-file.ts` + `src/main/env.ts`；`bootstrap()` 首条语句；进程环境变量优先；`.env.example` / `.gitignore`；`doctor` 用 `process.loadEnvFile` 同语义）；② LLM 输出清洗（围栏 / 括号动作 / Markdown → 严格 `validateReplyText`；提示词段 1 增强；真机 1.7s `route=llm`）；③ 系统托盘（16×16 内嵌图标；`呼出输入条` / `重新加载桌宠` / `退出`；`start()` 创建、`stop()` 销毁；退出走 `shell.stop()`）。契约 **1.4.1**（§9.2 澄清清洗顺序、§9.4 补 `.env`）。单测 **170**（+19，20 文件）、`tsc` 0 错、四套自检 **61 / 27 / 23 / 4** 全绿；`doctor` 在填好参考文本后 **15 项全绿 / 0 提醒**（当前 `.env` 留空该文本，仅该项红） | 1.4.1 |
| 2026-10-30 | voice、配置 | ADR 0019：参考音频是**日文** → `PET_TTS_PROMPT_LANG` 默认 **`ja`**、`PET_TTS_TEXT_LANG` 默认 **`zh`**（`constants.ts` 改默认值，`config.ts` 用 `readLang` 统一小写）；`/tts` 的 `prompt_lang` / `text_lang` 只从 `TtsConfig` 取值（客户端不写死），启动日志打印两种语种；`.env` / `.env.example` 写入两行；`doctor` 新增 `参考语种` / `合成语种` 校验（v2ProPlus 合法集合 + 假名/语种错配提醒）；手册新增 §3.3 多语言说明。真机跨语种 `/tts`（ja 参考 + zh 合成）**200 / 3.97s / 111,404B**。单测 **171**（voice 14，+1）、`tsc` 0 错；`doctor` 语种两项绿（参考文本仍空 → 16 通过 / 1 缺失） | 1.4.1 |
| 2026-10-30 | memory、orchestrator、shell、voice、全局 | 本轮三件事：① **memory 落地**（ADR 0020）：`src/main/memory/`（schema/迁移/`trigram` FTS5 + 短词 LIKE/三字滑窗/事实标签/三层降级/`snapshot`），`better-sqlite3@12.4.1` 按 Electron ABI 130 预编译安装，`data/memory.db` 入 `.gitignore`，`PET_MEMORY_DB` / `PET_MEMORY_DISABLE` 配置；orchestrator 段 ③ 注入 + 发布后异步写 user/pet。② **字幕时序**（ADR 0021）：`subtitle-cue.ts`（`intent_resolved` 只登记 → `speech_started` 显示 → `failed` 兜底 → `completed/interrupted` 留 1.2s 尾巴 → 15s failsafe）。③ **全切日文**（ADR 0022）：角色卡语言硬约束置顶 + 日文 few-shot、台词池全量日文（关键词中/日并存）、提示词段 1 语言硬约束、`TTS_TEXT_LANG` 默认改 `ja`、校验器 `joinCjkWithoutSpace` + 日文标点放行。契约 **1.5.0**（§7.5 实现补充、§7.2 字幕时机、§9.2 语言/空格规则、§8.1 时序图、§11 SQLite 行）。单测 **219**（22 文件，+34 新增 +16 扩充）、`tsc` 0 错、四套自检 **61 / 27 / 30 / 4** 全绿；`doctor` **19 通过 / 0 提醒**（重新构建后 dist 新鲜） | 1.5.0 |
| 2026-10-31 | render | ADR 0023：官方片段接线。新增 `clip-bank.ts`（44 段 → 语义角色：idle/idle.alt1/held/walk/walk.carried/pat/greet/happy/victory + 侧向战斗片段只登记）；`animation-controller` 增 `playOnce`/`playRole`，槽位退化为角色别名；held 改用 `Formation_Pickup`（`Carrier_Idle` 实为站姿）、摸头用 `Cafe_Reaction` 3.5–6.6s、打招呼用同段 0–2.2s、开心用 `Victory_Start`；待机 22–40s 在 `Cafe_Idle`/`Formation_Idle` 间轮换。**关键实测：`Normal_*`/`Exs*`/`Vital_*`/`Public01`/`Move_*` 是侧身战斗动画，不能用于正面桌宠**。新增 `tools/clip-preview`（浏览器预览 + 胶片条 + 离屏截图）。单测 **13（hfsm）+4（pat）+12（motion）**、`tsc` 0 错、自检 61 条全绿 | 1.5.0 |
| 2026-10-31 | shell、render、memory、全局 | ADR 0024/0025：① **walking 与窗口位移**：`shared/motion.ts` 纯函数（`stepWalk` 刹车曲线 / `stepSpring` / `stepSettle`）+ `shell/motion.ts` 控制器，由唯一 16ms 轮询器驱动；`cmd:walk`（新命令通道）让 render 只说方向与距离；`motion_ended`（新事件）回传到达/撞边/回弹结束；撞边自动掉头。② **真实回弹**：`drag_released` → Physics=`settling`，弹簧-阻尼落到工作区地面线（k=140/c=12/恢复系数 0.28）+ 180ms 落地缓冲；回弹期间忽略 intent/摸头（重新拖拽除外）。③ **记忆淘汰**：`prune()` 按 `at` 升序删超额行（上限 2000、单次 ≤200），`write` 后 `setImmediate` 排期，FTS5 由 `AFTER DELETE` 触发器同步。契约 **1.6.0**（§3.5 增 `cmd:walk`、§4.1/§7.1 `PhysicsState` 增 `settling`、§6.3 增 `motion_ended`、§7.5 增 `prune`、§12 单定时器口径）。单测 **25（memory，+4）/12（motion）/13（hfsm）**、`tsc` 0 错、自检 **69 条全绿**（新增行走 4 条 + 回弹 4 条，截图 `window-walking.png`） | 1.6.0 |
| 2026-10-31 | render | 修嘴周发暗：`sampleTextureColor` 用 1×1 缩放取整张贴图的**平均色**，被眉毛/鼻影/下颌阴影拖到 `(204,190,186)`，比肤色 `(249,241,236)` 暗 18%，嘴部底板刷上去就是一圈暗斑。改为取**众数**（5bit 量化，最大桶 43%），算法抽到 `shared/color.ts` 纯函数 + 5 条单测；填色向外扩 2 texel 消除 UV 岛边界的亮边。自检仍 69 条全绿，`tsc` 0 错，单测 **244**（23 套件，+5） | 1.6.0 |
| 2026-11-01 | render、全局 | **编码事故与重建**（ADR 0027）：用 PowerShell `Get-Content/Set-Content` 临时改行，GBK 解码把 `render-module.ts` 变成乱码并吃掉换行（305 个语法错误，编码不可逆）。当时**没有 git**、`dist` 被 `rm -rf` 清空、无编辑器历史/卷影副本 → 只能重写。① 先建 git（`f653cd3` 事故基线、`8dc450a` 重建）；② 分三轮重写 `render-module.ts`（骨架与加载 / 动画视线交互 / 口型贴花）；③ 新增 ADR 0027（禁止 shell 文本往返、强制 git、破坏性实验走副本）；④ ADR 0026 补 **D7 官方线稿贴花层**（`face-decal.ts`：头骨下的深度测试平面，贴图由 `FX_TEX_CH0335_Img_Face_01.png` 按连通域裁出）。验证：`tsc` 0 错、单测 **272**（25 套件）全绿、自检 **97/97**（连跑两次，其中一次仅 shell 侧"冷却拦下"日志断言偶发，属既有 flaky） | 1.6.0 |
