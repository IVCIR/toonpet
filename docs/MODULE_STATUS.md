# 模块状态（MODULE_STATUS）

| 项 | 值 |
|---|---|
| 对应契约版本 | 1.35.0（ADR 0058：视口安全边距 / 拖拽摆角视口约束 / 悬空姿态下沉补偿 / 自检时序与桩端口；ADR 0057：坐姿退场交接 / 坐姿眼睛照抄站立 / 整体缩放；ADR 0056：动态模型列表 + Combobox；ADR 0055：LLM 提供商自由切换；ADR 0054：视觉 OCR；ADR 0053：面板二期 AI 人格 / 模型切换 / 记忆管理；ADR 0052：控制面板 / 参数热更新） |
| 最后更新 | 2026-11-11 |
| 当前里程碑 | **M31（视觉边界完美体）**：拖拽摇晃时头发/身体不再被窗口边缘切掉、摆角按真实侧影自适应、悬空姿态不再被底边切脚；契约 **1.35.0**，发布 tag **`v3.1.0-safe-viewport`** |
| 发布 | **v3.1.0-safe-viewport**（2026-11-11，git tag `v3.1.0-safe-viewport`；`package.json` 版本 **3.1.0**）。上一个发布是 `v3.0.0-ultimate`（2026-11-08） |
| 本轮验收（2026-11-11，ADR 0058） | `tsc --noEmit` **0 错**；`npm test` **exit 0**（**62 个测试入口**，新增 `drag-motion` 4 条、`model-frame` 3 条）；**四套自检全绿**：主链路 **236 / 0**（新增 3.10 节 7 条；提交前连跑两轮均 236/0）、输入条 **29 / 0**、语音 **33 / 0**、视觉 **16 / 0**（全部 exit 0）；`npm run panel:shot` **exit 0、26 / 26**；`npm run scale:shot` **exit 0**（11 档）；`npm run swing:shot` 新增（两个倍率各 8–10 帧拖拽摇晃 → `swing-100.gif` / `swing-130.gif` / `swing-strip.png` / `swing-margins.png`）。真机 1600×1000（工作区 1600×952）：1.0x 内容区 **550×756**、`pixelsPerUnit` 仍 **57538**（模型像素尺寸不变）；抓头摇晃摆角 **0.300–0.350rad**（1.0x / 1.26x，`swingLimit` 保持 0.35 未被夹）；**逐帧越界 0**；最贴近边缘的一帧像素包围盒仍留 **左 4px / 右 183px / 上 140px / 下 80px**（均 > 0）；面板 1.3x 实际 **1.26x**（受工作区夹取），同样不出画 |
| 维护规则 | 每个模块对话收尾时必须更新本文件；只写事实，不写计划性描述（计划进 TODO） |

## v3.0.0 封版记录（M30 · 终极完全体）

| 项 | 值 |
|---|---|
| 版本 / Tag | `v3.0.0-ultimate`（`package.json` 3.0.0） |
| 契约 | **1.33.0**（ADR 0056 为最后一个契约变更） |
| 全量测试 | `npm test` exit 0：61 个入口 / 597 条 / 0 fail（含 memory 29 条） |
| 自检 | 主链路 198 / 0、输入条 29 / 0、语音 33 / 0、缺失模型 4 / 0、视觉 16 / 0 |
| 面板取证 | `panel:shot` exit 0：21 / 21 断言；`panel:opencode` 真实 OpenCode Go 30 个模型 |
| 封版能力 | 透明置顶 3D VRM、alpha 掩膜命中/穿透、拖拽/摸头/行走/回弹/吸附、HFSM + Toon/描边 + 表情/口型、本地 Ollama / OpenAI 兼容 / OpenCode Go 动态模型下拉、视觉截图 → OCR → 段 3.6、本地 GPT-SoVITS、SQLite 记忆、控制面板 |
| 已知坑位 | 见各模块「已知坑位」；v3.0.0 新增/确认：改 Base URL 需重输 Key、`/models` 404/405 只红字不阻断手填、2s 节流缓存失败、`panel:opencode` 依赖外网（默认取证不依赖） |

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
- **视口安全边距（2026-11-10，ADR 0058 D1/D2/D5）**：窗口从"包围盒 × 1.15"改为**再加一圈边距**——左右各
  `MODEL_VIEW_PADDING_X_PX=64`、头顶 `MODEL_VIEW_PADDING_PX=36`、**底边 0**（锚点=窗口底边）。
  1.0x 内容区 **550×756**（原 422×720），而 `pixelsPerUnit` 仍是 **57538**——她的像素尺寸没变，
  多出来的是透明空白。`shared/model-frame.ts` 新增 `viewPaddingShare()` / `fallbackWindowSize()`
  （模型缺失时兜底 608×756）。**缩放锚点**改走 `resolveViewAnchor()`：复用上次提交的锚点，
  只在窗口被拖拽/行走/吸附/D-7 搬动过（>2px）时才重取，连续缩放不再累积 ±0.5px 取整误差
  （实测原来一轮漂 2px）。
- **整体缩放（2026-11-10，ADR 0057 D2）**：控制面板"物理手感"页新增滑块 **`view.scale`（角色缩放比例，0.5–2.0，默认 1.0，步长 0.01）**。
  几何只有一份实现 `src/shared/window-scale.ts`（`resolveScaledWindowBounds`）：等比 `宽高 = 基准 × 比例`、**底边中心锚点不动**、
  再按当前显示器工作区夹一次（`effective = min(请求, 工作区/base)`，`clamped='workarea'`），位置兜底复用 `shared/geometry.ts`
  的 `clampRectToWorkAreas()`（D-7：至少 80×120 可见）。执行链：面板 `preview/save/reset` → 主进程 `sendTuning` 闭包里先
  `shell.applyViewScale()`（`window.setBounds(rect,false)`）再 `cmd:tuning`；启动时 `resolveWindowSize()` 之后按
  `config.json` 的 `view.scale` **直接算出初始矩形**（不会"先 1.0x 闪一下"）。窗口 `resizable:false` 不影响程序化 `setBounds`；
  输入条跟随、吸附跟随、拖拽/回弹都读 `getContentBounds()`，自动跟上新尺寸。诊断 `shell.viewScaleSnapshot()` /
  `shell.setViewScale()`（内部入口，非 §7.2 契约方法）+ 每次缩放一条 INFO/（被夹时）WARN 日志。**没有新定时器、没有新 IPC 通道**。
  实测（1600×1000 / 工作区 1600×952，基准 422×720）：1.35x/1.4x/2.0x 均被夹到 **1.3222x**（窗口 558×952，底边中心不动）；
  0.6x → 253×432；掩膜从 128×72 跟着变成 169×95 / 77×43。
- **自检不再读用户 `config.json`（2026-11-10，ADR 0057 D4）**：`scripts/start.mjs` 给五套自检统一 `PET_PANEL_CONFIG=logs/selftest/panel-config.json`。
  原来只有 `--panel-shot` 隔离，主链路自检会读到用户真实配置里配好的远程提供商（OpenCode Go），于是"LLM 不可用 → `llm_failed` /
  `route=fallback` / 熔断"三条断言真的走网络并成功 → 由绿变红，**而且会用用户的 Key 发真实请求**（§10.2 红线）。
- **动态模型列表 + Combobox（2026-11-08，ADR 0056）**：新增只读 IPC 通道 `cmd:fetch-models`（preload 暴露 `petPanel.fetchModels`，主进程 `shell/panel.ts` 只接受面板 sender，业务校验与网络在 `runtime.panel().fetchModels()`）。提供商表单的模型字段改为 `<input list>` + `<datalist>` + `🔄` 按钮 + 绿色/红色状态行 + 可点击模型 chips；Ollama 仍自动用 `/api/tags` 探测结果填充，手动刷新结果优先。成功填充 `{id,name}`；失败只显示红字，输入框与保存按钮保持可用（手填模型名照常 `provider-save`）。已保存 Key 不进渲染进程：编辑留空时主进程仅在 `type` + 归一化 `baseUrl` 都匹配时注入；地址被改写则要求重新输入 Key。同一配置 2s 节流 + 单飞 + 60s 内存缓存（`src/main/llm-model-list.ts`，注入时钟可单测）。取证新增 `panel-models.png` 与 4 项断言（总 21 项），临时桩只监听 127.0.0.1；另 `npm run panel:opencode` 手动诊断用真实 OpenCode Go `/models` 截图 `panel-opencode-models.png`（30 个模型），默认取证不访问外网
- **LLM 提供商面板（2026-11-08，ADR 0055）**：`cmd:panel` 扩 5 个动作（`providers` / `provider-save` / `provider-delete` / `provider-activate` / `provider-test`），仍走同一条通道；preload 白名单同步（载荷只做形状校验，业务校验留在主进程）。写权限全在 `shell/panel.ts`：`persistLlmProviders()` 统一写 `llm.providers[]` + `llm.activeProvider`，`writeConfigWithProviders()` 保证"保存参数/恢复默认"不会覆盖提供商；API Key 只在主进程与 `config.json` 之间流动，`PanelProviderFacts` 只含 `hasApiKey`。切换/删除/保存后返回最新列表，面板原子刷新；当前生效项保存或激活后自动 `provider-test`，失败在列表与顶部徽标显示"连接失败"。**不允许删除最后一个本地 Ollama**（默认回退选项）。取证新增 `panel-providers.png` 与 3 项断言
- **视觉查询（2026-11-07，ADR 0054）**：`cmd:vision-query`（§3.5）+ 热键 `Ctrl+Shift+V`（降级 `Ctrl+Alt+V`）+ 输入条"看看屏幕"按钮，三入口共用 `runVisionQuery`，查询中单飞。`shell` 仍**不** import runtime：`bootstrap` 用 `attachVisionBackend(() => getRuntime()?.vision())` 接线，未就绪时返回 `null` 并 WARN。截图走主进程 `desktopCapturer`（`screen` 按光标 `display_id`、`foreground` 按 presence 标题匹配，失败降级整屏），OCR 走回环 OpenAI 兼容端点；失败只更新按钮与日志，不弹窗、不发事件。视觉上下文由 orchestrator 在**下一轮 LLM** 消费。取证 `npm run selftest:vision`（16 项断言全过，真 Windows OCR 桩；`logs/evidence/vision-chain.json` + `vision-capture.png` / `vision-reply.png` / `vision-desktop.png`）
- **控制面板二期：AI 人格 / 记忆管理（2026-11-06，ADR 0053）**：`shell/panel.ts` 的 `cmd:panel` 从 5 个动作扩到 13 个（`snapshot` / `status` / `preview` / `save` / `reset` / `card` / `save-card` / `set-model` / `tts-test` / `memories` / `memory-delete` / `memory-clear` / `hide`），**没有新增通道**。写权限全收在控制器：角色卡走 `src/main/character-card.ts`（归一化 / 码点计数 / 原子写 / 空卡超长相对路径拒绝），模型选择写 `config.json.llm.model`，记忆读写经注入的 `runtime.panel()`（`shell` **不** import `memory`，`bootstrap` 用 `attachPanelBackend` 接线）。三层校验：preload 白名单 + 面板 sender 白名单 + 主进程业务校验（模型名白名单 `[namespace/]name[:tag]`、`limit` 夹取、`memory-clear` 必须 `confirm === true`）。`status` 动作强制刷新 Ollama 探测（"重新探测"按钮不被 3s TTL 吞掉）；`hide`（`Esc`）只 hide 不销毁。`panel-config.ts` 移到 `src/main/` 并新增 `llm.model` 读写。运行期实现在 `runtime.panel()`：`card()` / `saveCard()`（**先写盘**再 `orchestrator.replaceCard`）/ `applyLlmModel()`（新 `LlmClient` + `orchestrator.replaceLlm` 清零熔断 + `heartbeat.retarget` 清零预热，**成功后才写 `config.json`**）/ `testTts()`（独立短预算、不播放不写记忆）/ `memories` / `deleteMemory` / `clearMemories`；`bootstrap` 用 `attachPanelBackend(() => getRuntime()?.panel())` 接线。取证扩到四页（14 项断言全过；角色卡与记忆库都写隔离副本，用户 `data/memory.db` 仍为 14 行）
- **控制面板（2026-11-06，ADR 0052）**：`src/main/shell/panel.ts`（控制器）+ `panel-window.ts`（800×600、不可缩放、无边框、`alwaysOnTop`、`skipTaskbar`；独立最小 preload `src/preload/panel.ts` 只暴露 `invoke(cmd:panel)` 与 `onState(cmd:panel-state)`）+ `panel-config.ts`（`config.json` 读写：只写与默认值不同的项、保留未知顶层键、`tmp + rename` 原子写、坏文件只记 `error` 并按默认值启动、`PET_PANEL_CONFIG` 可覆盖）。入口是全局热键 **`Ctrl+Shift+P`** 与托盘第一项；`Esc`/失焦/再按热键 → `hide`（不销毁）。面板**不是**事件白名单的一部分：`cmd:panel` / `cmd:panel-state` / `cmd:tuning` / `cmd:state-poll` / `cmd:state-report` 五条都是控制面通道。渲染侧状态 4Hz 轮询**复用既有 16ms 轮询器**（节流 250ms，面板不可见立即停），**没有新定时器**；Ollama 探测 3s 一次（`ollama-probe.ts`，注入 `fetch`、只读 `/api/tags`、三态、dispose 丢弃在飞结果，**不碰熔断/事件/托盘**）。取证 `npm run panel:shot` → `logs/evidence/panel-hot-update.json`（7 项断言全过，脚本自还原用户配置）
- **吸附跟随的追赶模式（2026-11-03，ADR 0042 D2）**：`snap.ts` 的跟随不再是固定 120ms 节流——检测到目标矩形变化（≥1px）后把节流压到**一个 tick（16ms）** 并持续 `SNAP_FOLLOW_SETTLE_MS=220ms`，目标停稳后自动回落到常规 120ms。没有新定时器（仍挂在既有 16ms 轮询器的 `onTick` 上），没有新 IPC。日志只在**进入**追赶那一拍打一条（避免 60Hz 刷屏）；诊断新增 `SnapDiagnostics.catchUp / catchUpTicks`。单测新增"目标连续移动时每 20ms 都重算、停下后回到节流"1 条；主链路自检新增"追赶模式 `catchUpTicks ≥ 1`"1 条
- **解除吸附后落回桌面（2026-11-03，ADR 0042 D4）**：`snap_released{window-gone|fullscreen}` 之后，shell 用**回弹弹簧**（`motion.startSettle({vx:0, vy:SNAP_RELEASE_FALL_VY_PX_PER_SEC=620})`）把她从窗沿落到工作区地面线；离地面 ≤ `SNAP_RELEASE_FALL_MIN_PX=48px` 时不落下（避免无意义回弹）。`clicked`/`command`/`dragged` **不**落下（目标窗口还在，站在边缘是物理成立的）。没有新状态、新定时器、新通道；render 侧不伪造冲击速度（ADR 0040 D3 的"轻放不缩"口径），这次落地只由 `startle` + 弹簧表达。主链路自检新增 2 条（落回地面线 ±8px / 按轻放处理不触发 landing）
- **回弹恢复系数与反跳可观测（2026-11-03，ADR 0040 D3）**：`SETTLE_RESTITUTION 0.28 → 0.15`（窗口整块反跳从 15–40px 降到 1/2 以下）；`motion.ts` 新增触地反跳打点（`回弹触地反跳 {bounce, vyBefore, vyAfter}`）与回弹结束的 `bounces` 计数，用来把"弹一下"与"摸头"区分开
- **拖拽与摸头严格互斥（2026-11-03，ADR 0039 D5）**：`drag-gesture.ts` 新增两道闸——① `patArmed`：只有全新 `pointerdown` 才重新武装，任何一次进入拖拽立刻置 false（"直到下一次全 pointerdown"）；② `movedWindow`：按下期间窗口位置变过（拖拽位移 / 回弹弹簧 / 吸附跟随都会搬窗口）→ 不发 `head_patted`，且**不伪造** `drag_started`（否则回弹期轻点会把她重新拎起来），只留一条 `head_patted 未触发：按下期间窗口被移动过` 日志。`pointer-poller.ts` 在发出 `head_patted` 前再查一次 `settling`（500ms 沉降窗口）与 `isSettling()`，命中即丢弃并 WARN（`head_patted 被丢弃：拖拽/回弹期间严格互斥`）。单测 `drag-gesture` 新增 2 条（窗口被移动 / 拖拽后解除资格）；主链路自检新增"回弹期间 head_patted 被 render 拒绝"与"松手不经过 reacting"
- **吸附接近（2026-11-02，ADR 0034）**：`src/main/shell/approach.ts` 纯函数（`planApproach` / `sampleApproach` / `approachDelta`）；`snap.ts` 的 `snapNow()` 在距离 >8px 时先发 `snap_approach_started`，在既有 16ms `snap.tick(now)` 里按 `t += dt/duration` 推进（**没有新定时器**），`t>=1` 才 `commit()` 并发 `snap_applied`；`mode='walk'` 用于同一地面线，`mode='leap'` 先水平走到目标 x 下方、再短弧跳上去。接近期间锁目标、暂停跟随；只有 `drag_started` 能立即中断，`clicked`/`command`/`window-gone`/`fullscreen` 延迟到到达后再释放。诊断 `SnapDiagnostics.approaching/approachProgress/approachMode`；单测新增 6 条（`approach.test.ts`）+ `snap.test.ts` 4 条接近用例
- **落地分级标定钩子（2026-11-02，ADR 0035 D4）**：`shell.debugDropFromHeight(heightPx)`（非契约，内部标定用）把窗口抬到地面上方后走真实 `drag_released` 事件链；`PET_LANDING_CALIBRATE=1` 落 `dist/selftest/landing-10px.png` / `landing-300px.png`，实测 impact 0.00 / 1.00、`landingSquash` 0 / 0.078，脚底未穿出窗口
- **`model_ready` 事实闩锁（本轮，ADR 0033 D2.2）**：`onRendererEvent` 收到 `model_ready` 时多调一行 `noteModelReady()`（`src/main/model-ready.ts` 的进程内单例，只记第一次；`runtime.stop()` 清零）。这一行不是为了 shell——`model_ready` **可能早于 `runtime.start()` 完成**（启动顺序是先 shell 后 runtime，而渲染进程加载 VRM 只要 1–2s），早到的那一次如果没人落闩锁，`runtime` 就没机会"在模型出现的那一刻预热"。**没有新增事件、IPC 通道、setter 或 `RenderState` 字段**（与 ADR 0032 的 `proactive-stats` 同一手法）
- **托盘顶部两行只读诊断（ADR 0032 D4）**：`tray-menu.ts` 变成"2 行只读（`enabled:false`）+ 5 个动作项"的纯规格；第一行 `今天主动交互: N 次`、第二行 `上次未主动原因: user-active（先生正在操作）`（原因保留 idle-drive 的英文原词 + 中文解释，`Record<ProactiveSilenceReason,string>` 穷举，漏一个 `tsc` 就报错；取值 = 九个判定原因 + `no-lines`/`llm-failed` 两个"判定通过但最终静默"的诊断值，避免在她什么都没说时显示"已开口"）。数据来自新增的 `src/main/proactive-stats.ts` 进程内单例（与 `appBus` 同一手法）：**没有新事件、没有新 IPC、没给 shell 加 setter、`RenderState` 未动**。`tray.setStats()` 只在标签真的变化时 `setContextMenu`；刷新挂在既有 16ms 指针轮询器的 `onTick` 上（读数变化 → 下一拍即刷，无变化 → 5s 复查），**没有新定时器**；`stop()` 里连同 `lastTrayStats` 一起清空
- **托盘诊断的自检覆盖**：输入条套件新增 2 条断言（两行格式 `/^今天主动交互: \d+ 次$/`、`/^上次未主动原因: /`；`stats.lastReason === 'disabled'`），并把菜单项断言从 5 项改为 7 项；实测 `menuLabels = ["今天主动交互: 0 次","上次未主动原因: disabled（主动性已关闭）","呼出输入条","吸附到前台窗口（Ctrl+Shift+S）","离开窗口边缘","重新加载桌宠","退出"]`（自检里主动性硬关，所以是 `disabled`）
- **前台窗口吸附（上一轮，ADR 0028）**：`src/main/shell/foreground-window.ts`（`koffi` 加载 `user32`/`dwmapi`：`GetForegroundWindow` → `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)`，失败退回 `GetWindowRect`；`IsWindowVisible/IsIconic/GetClassNameW/GetWindowTextW` 一并读取；**物理像素**输出，DIP 换算由 shell 用 `screen.screenToDipPoint()` 逐点做）、`snap-geometry.ts`（纯函数：`y = 边缘线 - 窗口高`、水平居中、**整窗可见优先**的 D-7 夹取、竖直夹取 >40px 直接拒绝、覆盖式全屏判定）、`snap.ts`（控制器：8 种拒绝原因、热键/托盘入口、跟随轮询、五条解除路径、`snapDiagnostics`）
- **吸附入口（ADR 0028 D4）**：全局热键 `Ctrl+Shift+S`（被占用降级 `Ctrl+Alt+S`，与输入条热键同一套三级降级，都失败只记 ERROR）；托盘新增 `吸附到前台窗口（Ctrl+Shift+S）` 与 `离开窗口边缘` 两项（托盘菜单单测同步更新）
- **吸附跟随（ADR 0028 D6）**：挂在既有 16ms 指针轮询器的 `onTick` 上（**没有新定时器**），内部节流 `PET_SNAP_FOLLOW_MS`（默认 120ms）；按句柄重读目标矩形 → 用同一 edge 重算位置 → `setPosition`；句柄失效/最小化 → `snap_released{window-gone}`，变全屏 → `{fullscreen}`
- **解除的五条路径（ADR 0028 D9）**：指针按下（`clicked`，在把手势交给 poller **之前**解除，避免 sitting→idle→dragged 闪回）、拖拽（`dragged`）、托盘（`command`）、目标消失（`window-gone`）、目标全屏（`fullscreen`）
- **拒绝与提示（ADR 0028 D3）**：全屏 / 自己的窗口 / 桌面外壳窗口（`Progman`/`WorkerW`/`Shell_TrayWnd`…）/ 不可见 / 太小（<80×40 DIP）/ 坐标异常 / 放不下（夹取 >40px）/ 忙（行走·回弹·拖拽，只记日志）→ 托盘气泡 + WARN 日志，**不移动窗口、不发 `snap_applied`**
- **回退（ADR 0028 D7）**：`koffi` 缺失/加载失败 → 有效模式退回 `workarea`（启动日志 WARN）；热键吸到工作区下沿（`PET_SNAP_EDGE=top` 放不下时自动退回下沿）；拖到下沿 24px 内松手 → 直接坐在那条边上；`PET_SNAP_MODE=workarea` 可强制
- **自检新增 22 条（119/119 全绿）**：真实前台窗口读取（Win32 + DIP 闭环）、热键入口、贴下边缘 ±8px、水平居中 ±8px、`physics=sitting`、播放坐姿片段（非降级）、行走调度关闭、`playHold` 停帧、桌面合成截图、跟随移动、点击解除、拖拽解除、坐姿掩膜命中、全屏拒绝 + 提示、目标关闭自动解除；截图 `dist/selftest/window-sitting.png`（窗口）与 `window-sitting-desktop.png`（**桌面合成图**，3200×2000）
- **单测 287 个（28 文件）**：上一轮新增 `snap-geometry`（12）、`snap`（17）、`sit-pose`（4）、`bone-arbiter`（4）；`hfsm` +4（sitting 进出/打断行走/不得覆盖 dragged）、`tray-menu` 改动 3
- **本轮（M14 封版）单测总量 417 个（38 文件）**：`orchestrator` 34 → 29（5 条预热用例随实现迁往 `heartbeat.test.ts`），新增 `heartbeat`（16）、`heartbeat-config`（6）、`model-ready`（12）
- **本轮四套自检全绿（exit 0）**：主链路 **121/121**（+1「预热：自检默认硬关」）、输入条 **29/29**、语音 **30/30**、缺失模型 **4/4**；`tsc --noEmit` 0 错
- **顺带修 bug**：占位胶囊体被写成 `-height/2 + margin`（animationRoot 已在底边，等于双重偏移），实测只剩 1px 露在窗口底边、掩膜几乎全空 → 缺失模型自检第 4 条失败；改成 `+margin` 后 4/4
- **字幕与语音时序对齐（ADR 0021）**：新增 `src/renderer/shell/subtitle-cue.ts`（纯逻辑、定时器注入）+ `subtitle.ts` 扩 `holdMs: null`（不自动隐藏）与 `holdFor(ms)`。`intent_resolved` **只登记**待显示文本（15s failsafe），`speech_started` 才显示完整字幕（播放期间不自动隐藏），`speech_ended{failed}` 立即显示兜底，`{completed|interrupted}` 留 1.2s 尾巴；新回复到达时先收起旧字幕；打断丢弃未显示的 pending。渲染页只做接线（`window.petSubtitle.getDiagnostics()` 是内部诊断，不进 `RenderState`）
- **系统托盘（ADR 0018 D3；本轮扩为 2 行只读诊断 + 5 个动作项）**：`src/main/shell/tray.ts` + 纯规格 `tray-menu.ts`；图标是内嵌的 16×16 PNG data URL（不新增二进制资产、不联网）；动作项为 `呼出输入条`（复用 `openInputBar()`，不复制热键逻辑）/ `吸附到前台窗口` / `离开窗口边缘` / `重新加载桌宠`（`mainWindow.webContents.reload()`，只重启渲染进程）/ `退出`（先 `await shell.stop()` 再 `app.quit()`，ADR 0004 D9）；`start()` 内创建、`stop()` 内先销毁；创建/销毁失败只记 WARN，不影响热键与桌宠；`shell.traySnapshot()` 为内部诊断
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
- 吸附跟随只认"同一个句柄"：目标窗口被销毁重建（部分应用切全屏会重建 HWND）时以 `window-gone` 结束，不会自动改吸新窗口
- 显示器增删/分辨率变化时没有重算吸附位置（未监听 `display-metrics-changed`）
- `top` 边缘只在"窗口上沿离屏幕顶 ≥ 窗口高"时成立；工作区上沿永远放不下（自动退回下沿），没有别的上沿方案
- Win11 关闭通知时托盘气泡不显示，`notify` 只有日志兜底
- 真实鼠标（非自检合成事件）下的手工验收；指针捕获在"窗口被 D-7 钳制停住、指针离开窗口"时的行为当前只有日志级证据
- 行走/回弹期间的**穿透**只做到"按新窗口矩形重新判定"：R-6 轮询器每 tick 读 `getContentBounds()`，没有额外的"位移中强制刷新探针"通路（实测不丢点击，但没有专门断言）
- 托盘：热键注册失败时**仍没有** UI 提示（托盘菜单不显示热键状态，只能看 `logs/pet.log` 的 `输入条热键状态`）
- 托盘诊断只有"本进程"口径：`今天主动交互: N 次` 其实是"本次启动以来 N 次"，跨天/跨重启都没有累计（ADR 0032 D4.2）
- 托盘诊断项不可点击（本来就只读），但**原生菜单的点击行为仍无法自检**：`重新加载桌宠` 与 `退出` 需人工点一次验收
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
| `traySnapshot` | `traySnapshot(): TrayDiagnostics` | 非契约（内部诊断）：托盘存在性 / 菜单标签 / tooltip / 图标尺寸 / **顶部两行诊断文本与原始读数**（ADR 0018 D3、ADR 0032 D4） |
| `getInputBarWindow` | `getInputBarWindow(): BrowserWindow \| null` | 非契约（内部）：只给自检截图与注入脚本 |
| `snapToForeground` | `snapToForeground(): SnapOutcome \| null` | 非契约（内部）：吸附的唯一内部入口（热键/托盘/自检共用），ADR 0028 D4 |
| `releaseSnap` | `releaseSnap(): void` | 非契约（内部）：解除吸附（幂等），与托盘"离开窗口边缘"同一路径 |
| `snapSnapshot` | `snapSnapshot(): SnapDiagnostics \| null` | 非契约（内部诊断）：模式/是否坐着/**是否接近中与进度**/目标窗口/最近一次结果/跟随计数 |
| `debugDropFromHeight` | `debugDropFromHeight(heightPx: number): boolean` | 非契约（内部标定）：把窗口抬到地面上方后走 `drag_released` 事件链，只用于落地截图（ADR 0035 D4） |
| `openControlPanel` | `openControlPanel(): boolean` | 非契约（内部）：热键/托盘/取证脚本共用的打开入口（ADR 0052） |
| `panelDiagnostics` | `panelDiagnostics(): PanelDiagnostics \| null` | 非契约（内部诊断）：面板存在性/可见性/当前值/配置文件/最近一次渲染侧回报/Ollama 三态/节拍计数 |
| `fetchModels`（面板 IPC） | `cmd:fetch-models{type?,baseUrl,apiKey?,providerId?}` → `{ ok,models } \| { ok,error }` | 契约 §3.5（ADR 0056）：只读模型列表；只接受面板 sender；Key 注入与 2s 节流在主进程 |
| `getControlPanelWindow` | `getControlPanelWindow(): BrowserWindow \| null` | 非契约（内部）：只给取证脚本截图 |
| `attachPanelBackend` | `attachPanelBackend(provider: () => PanelBackendLike \| null): void` | 非契约（内部，ADR 0053）：`bootstrap` 在 runtime 就绪后注入 `runtime.panel()`；`shell` 因此不必 import `runtime`/`memory` |

> 内部接口（不对外）：`PointerPoller.notePointerFact()`（`cmd:drag` 入队）、`DragGesture`、`drag-pause`、`installInputBarWindow()`、`registerHotkey()`。

### 消费事件

| 事件 | 用途 |
|---|---|
| `model_ready` | 渲染侧加载成功、首帧已渲染后上行；shell 记日志、`showInactive()`（与 `did-finish-load` 同一幂等显示路径），并落一个**一次性闩锁**（`noteModelReady()`）给 `runtime` 补发预热（ADR 0033 D2.2） |
| `intent_resolved` | 渲染侧（shell 的字幕气泡）消费：**只登记**待显示文本，不显示（ADR 0021 D1）；不参与动作（动作只走 `cmd:render-intent`） |
| `speech_started` | 字幕显示完整文本（同一帧），播放期间不自动隐藏（ADR 0021 D2/D4） |
| `speech_ended` | `failed` → 立即显示兜底字幕；`completed`/`interrupted` → 留 1.2s 尾巴（ADR 0021 D3/D4/D5） |

> 生产侧：shell 发出 `drag_started` / `drag_released` / `head_patted` / `user_utterance` / `snap_applied` / `snap_released`（§6.3 全量清单内，未新增清单外事件）。

### 已知坑位

| 现象 | 影响 | 规避 |
|---|---|---|
| **本应用拿不到系统前台权**：主窗口 `focusable=false`（§3.2），自检里 `BrowserWindow.focus()` 无法把自建窗口变成系统前台窗口（Windows 前台锁） | 自检没法"打开一个记事本并让它成为前台"；第一版自检因此把桌宠吸到了真实前台（MuMu 模拟器）上，7 条断言全错 | 几何断言改用**脚本化前台**（`pushScriptedForeground`，仅 `PET_SELFTEST=1` 生效，输入是物理像素、仍走真实 `screenToDipPoint`）；真实 Win32 路径由另一条断言覆盖（"读到前台窗口 + 矩形自洽"） |
| **DWM 扩展边框与 `GetWindowRect` 差 3–5px**（阴影/不可见调整边框） | 用后者吸附会留一条缝 | 优先 `DWMWA_EXTENDED_FRAME_BOUNDS`（9），失败才退回 `GetWindowRect`；日志记 `source` |
| **全屏判定是"覆盖整块显示器 bounds"的矩形近似** | 带黑边的无边框全屏可能漏判成普通窗口 | 漏判时位置会被 D-7 夹取或按 `geometry` 拒绝，不会画到屏幕外；拖动目标窗口改变其矩形同样会触发重算/解除 |
| **接近期间锁定目标、暂停跟随** | 目标窗口在 300–900ms 内移动时，她会落到旧位置，随后跟随轮询（≤16ms 追赶 / 常规 120ms）再补正 | 接受为首版取舍；到达后 `lastFollowAt=null` 立即恢复跟随（ADR 0034 D3、ADR 0042 D2） |
| **跟随的追赶模式只覆盖"变化后 220ms"** | 目标窗口每 300ms 才动一次的"点动"（键盘移动窗口 / 快速点标题栏）会夹在追赶窗口之外，回到 120ms 节流 | 感知上限是 120ms 一次的补正（约 3 帧），肉眼仍是"贴着走"；要更紧就调 `SNAP_FOLLOW_SETTLE_MS`，但空闲时的 Win32 查询会变多 |
| **窗沿落差 < 48px 时解除吸附不落下** | 她站在目标窗口边缘上（物理成立），不会落到任务栏 | 刻意如此：几十像素的回弹没有观感收益，而且会打断 `startle`。真要"永远落回桌面"就调 `SNAP_RELEASE_FALL_MIN_PX`（ADR 0042 D4） |
| **解除下落不叠落地缓冲** | 从窗沿掉到桌面时没有下蹲压缩 | ADR 0040 D3 的口径是"轻放不缩"，而"窗沿掉落"没有"松手瞬间竖直速度"这个事实；这次落地只由 `startle` + 弹簧表达（ADR 0042 D4） |
| **接近中非拖拽解除被延迟** | 点她/托盘解除/目标消失时，她要先走完接近再起身，最长约 0.9s | 避免半空冻结/第三条下落路径；拖动是唯一立即中断（ADR 0034 D4） |
| **坐姿片段的"身体平移"**：`CH0335_my_event088_pastmemory_01` 的坐姿窗口把身体搬到长椅上（cx/minY 与站姿差一万分之几单位），而 `HaloRoot` 不是骨骼、任何片段都不驱动它 | 直接播：她悬在窗口左上角、光环留在窗口中间（实测截图，第一版就是这样） | render 侧两处修正：加载期按**停帧那一帧**（`holdSeek`）采样坐姿身体包围盒 → 每帧把"身体中心→窗口中线、最低点→窗口底边"，**并按坐姿片段权重缩放**（ADR 0043 D3，否则落座瞬间会瞬移 390px）；光环每帧挂到头骨（`updateHalo`）。诊断 `sit.rawOffsetPx`（原始补偿，实测 x≈+257、y≈-287）与 `sit.offsetPx`（实际施加 = raw × blend） |
| **坐姿片段的最后一帧曾是闭眼放松姿态** | 观感偏"打盹" | **已修（ADR 0042 D3 → ADR 0043 D2）**：窗口换到 14.5–14.92s 并**循环**（"睁眼、手放膝上"那一段），不再停帧；换模型/换窗口需重新标定 `clip-bank` 的 `startSeconds/maxSeconds` 并重跑 `holdSeek` 标定 |
| **掩膜随姿态变化**：坐姿轮廓与站姿完全不同，加载时算出的 body 探针点会落到空气里 | 按下被 D-2 门槛拒绝（"not-interactive"），自检点不中她 | 自检用 `findCurrentHitPoint()` 在当前掩膜上扫描；生产路径无需处理（掩膜本来就是当前姿态） |
| **坐姿是活的**（ADR 0043：片段循环 + 呼吸 + 重心偏移），身体逐帧移动 1–3px | 掩膜逐帧变化，"扫描命中"与"按下"之间该点可能变透明 → 按下被拒（自检踩到过） | 自检的 `findCurrentHitPoint()` 现在只接受"实心点"（周围 8px 四邻至少 3 个也命中）且优先从骨盆高度扫；`sit.done` 已废弃（恒为 null） |
| **`koffi` 是 optionalDependency**：`build.mjs` 必须把它标成 `external`，且 `@koromix/koffi-win32-x64`（1.0MB `.node`）要随包带上 | 忘记 external 会打包失败；忘带平台包 → 启动期 `require` 失败（功能降级为贴工作区，不崩溃） | `build.mjs` 的 main bundle `external: ['electron','better-sqlite3','koffi']`；启动日志的 `吸附配置` 行会打印 `supported/effectiveMode` |
| **曾经的怀疑：`desktopCapturer` 抓透明置顶窗会拿到"另一帧"** | 修 ADR 0029 之前，桌面合成图里的姿势确实会和窗口截图不一致（"背对镜头"），当时误以为是抓帧问题 | **已澄清**：那是头骨在漂移（1.5s 转半圈）。修好后两张图一致；断言"截图后 `animation.current.time` 仍为 2.3s"也一直是通过的（它只证明片段没重播，不能证明骨骼没漂——所以另加了 `headQuat` 断言） |
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
| **ADR 0039 起"拖完还能误摸头"的路已全部封死**：`dragged`/`settling` 期间的三道闸（手势 `patArmed`、窗口位移判据、轮询器沉降窗口）任一生效都不发事件 | 拖拽结束后 0.5–1s 内点她，可能"没反应"（不是坏了，是被互斥挡下） | 想立刻摸头请等回弹停下（`physics=idle`）；日志 `head_patted 未触发：按下期间窗口被移动过` / `head_patted 被丢弃` 可确认是被拦而不是没点中 |
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
| **托盘菜单点击无法自检**（原生菜单，Electron 不暴露"点第 N 项"） | "重新加载桌宠 / 退出"只有代码单测（tray-menu）与人工验收，没有端到端断言 | 自检断言 `exists` / `menuLabels` / `statLabels` / `stats` / `iconSize`；点击行为列为人工验收项 |
| **托盘诊断的刷新依赖 16ms 指针轮询器** | 若将来把轮询器改成"窗口隐藏就停"，托盘两行会僵在旧读数 | `refreshTrayStats()` 只在 `onTick` 里跑（与吸附跟随同一约束，§12）；轮询器当前在 `start()` 到 `stop()` 之间**永不暂停**，因此可接受。要让它在无指针场景下也刷新，必须复用同一个定时器，不得新开 |
| **第一版"一律 5s 节流"会让启动后的托盘显示旧读数**（本轮踩到）：`shell.start()` 先建托盘，`runtime.start()` 之后才装配 orchestrator，orchestrator 写下的第一条 `disabled`/`user-active` 要等最长 5s 才可见 | 用户点开菜单看到"尚未评估"，误以为诊断坏了；自检里也要 sleep 等待 | 改成"读数变了就在下一拍刷新，只在没变化时才 5s 复查"（ADR 0032 D4.3）。`setStats()` 内部仍会比较标签，文本相同不碰原生菜单 |
| **托盘两行的原因文案是穷举映射**（`Record<ProactiveSilenceReason, string>`） | 将来若给判定原因或静默诊断加值而忘了映射，编译期就会报错（这是刻意的） | 加取值时同步 `tray-menu.ts` 的 `SKIP_REASON_LABEL` 与该模块单测 |
| **`ok` 不等于"她真的说了"**：主动路径有两条"判定通过但静默"的分支（没台词且 LLM 不可用 / 主动推理失败） | 只看 `snapshot().lastProactiveSkip` 会误判成"她说过了"；第一版托盘就撒过这个谎 | 托盘读的是 `proactive-stats.lastReason`，静默分支会分别写 `no-lines` / `llm-failed`（ADR 0032 D4.0）；两条路径都有单测断言 |
| **托盘"重新加载桌宠"会直接重启渲染进程**：不通知 voice/orchestrator | 若重载时正在播放语音，voice 会话会停在 `waiting-start` / `playing`，直到下一次 `speak` / `stopSpeaking` 收尾（与渲染进程崩溃同一类，ADR 0015 D3 不加看门狗） | 仅用于调试；重载后说下一句话即自动收尾。不要在正常对话中频繁点 |
| **托盘"退出"会先 `shell.stop()`**，销毁窗口会触发 `window-all-closed` → `app.quit()` | 看起来像"退出了两次" | bootstrap 的 `before-quit` 有 `quitting` 守卫，`shell.stop()` 幂等；托盘回调随后再 `app.quit()` 是空操作（ADR 0004 D9） |
| **`.env` 只在启动时读一次**，且进程环境变量优先 | 改 `.env` 后不重启不生效；`setx` 留下的同名变量会一直压过 `.env`，表现为"文件明明改了没用" | 改完重启；用 `echo $env:PET_XXX` 确认是否有同名进程变量；`logs/pet.log` 的 `.env 已加载` 行会列出 `applied` / `kept` 键名 |
| `doctor` 用 Node 原生 `process.loadEnvFile()`（Node ≥20.12），应用用自研解析器 | 两处实现需保持同一语义（优先级 / 引号 / 注释）；Node <20.12 时 doctor 只会给黄色提醒 | 语义写在 ADR 0018 D1 与 `src/shared/env-file.ts` 头注释；`doctor` 不 import `dist`（构建前也要能跑） |
| 输入条 `movable:false` | 拖动输入条无效（会被下一次定位弹回） | 刻意如此：位置属于主窗口（ADR 0003 §2）；只在主窗口 `move` 时跟随 |
| 字幕留在**窗口下沿**而不是"角色头顶" | 观感上气泡压在脚部附近；与需求里"桌宠上方"的字面读法不一致 | 窗口按模型包围盒紧贴（422×720），头顶没有窗口内空白，窗口外上方又是输入条的位置；要做"头顶外部气泡"需要**第三个窗口**（新 ADR）。当前用自检矩形断言保证"输入条与字幕不相交"（ADR 0016 D6） |
| `npm run doctor` 的绿灯不等于链路可用 | 例如 Ollama 有模型但显存不足、TTS 端口通但权重配错 | doctor 只覆盖"可观测前提"（文件、端口、模型名、参考音频时长）；真实链路以 `npm run selftest*` 与 `logs/pet.log` 为准 |
| **自检的日志切片曾按"当前行数"**：`model_ready` 可能在 `runtime.start()` 完成前落盘，而自检入口在那之后才执行 | 主链路自检偶发 `事件：model_ready 已发出并被主进程收到` 失败（2026-10-30 复现一次，exit 1） | 改为按本进程启动时间戳切片（`baselineLineCount`）；只影响自检，不影响生产代码。修后主链路连续两次 61/61 |
| 非 UTF-8 控制台（`chcp 936`）里 `npm run doctor` 的中文会乱码 | 清单读不清，容易误判 | 用 `run-doctor.cmd`（内部 `chcp 65001`）或 Windows Terminal |
| **`.cmd` 里不能出现中文（UTF-8）**：cmd.exe 按 ANSI 代码页**逐行**解析批处理，`chcp 65001` 救不回来；多字节序列被误读时甚至**吞掉换行**，表现为 `'竴娈佃窛…' 不是内部或外部命令` 之类的连串报错（`run-capture.cmd` 第一版踩到，2026-11-03） | 脚本完全跑不起来，看起来像"文件坏了" | **所有 `.cmd` 只写 ASCII**（本轮已把 `run-capture.cmd` / `run-doctor.cmd` 全量英文化）；要匹配中文日志就用**ASCII 锚点**（`ADR 0024 D`、`ADR 0040 D3`、`squashMax`、`headBoneCss`）；两个脚本都带 `--check` 只做解析自检（`run-capture.cmd --check` / `run-doctor.cmd --check`，exit 0 = 语法 OK） |
| **字幕在合成期间是空白的（4–6s）**：ADR 0021 把"显示"推迟到 `speech_started` | 用户会以为"没反应"，尤其是 TTS 冷启动（本机首句 6.2s） | 这是与语音对齐的必然代价；`logs/pet.log` 的 `已下发音频，等待渲染侧首帧` 可确认链路在动。不要把显示时机改回 `intent_resolved` |
| **`speech_ended` 永不到达时字幕会一直停留**（渲染进程崩溃、voice 会话挂住） | 屏幕上有一行旧文本，直到下一次回复 | 字幕 `pointer-events:none` 不挡点击；下一次 `intent_resolved` 会先收起旧字幕。不为此加看门狗（与 ADR 0015 D3 同一取舍） |
| **failsafe 15s 是固定常量**（`SUBTITLE_PENDING_FAILSAFE_MS`） | 换更慢的 TTS（如整段 30s+）时会在语音开始前提前亮字 | 该值必须大于实测合成耗时；改 TTS 部署后重估。日志 `等待 speech_started 超时，提前显示字幕` 是它触发的唯一证据 |
| 自检里"字幕在 `intent_resolved` 后立刻可见"的旧断言已失效 | 照旧写会假失败 | 现在的断言是"`intent_resolved` 后**不可见** + pending 已登记"（`SLOWTTS` 桩把 TTS 延迟 1.2s 制造窗口） |

### TODO
- [x] 前台窗口吸附（Win32 via koffi + DIP 换算 + 热键/托盘 + 跟随 + 五条解除路径，ADR 0028）
- [x] 吸附接近（`snap_approach_started` + 16ms 倒计时 + walk/leap + 延迟解除，ADR 0034）
- [ ] 接近中目标窗口移动的实时重算（当前锁定目标，到达后由跟随补正 ≤120ms）
- [ ] 吸附不可用时回退工作区贴边（无 koffi 也能用）
- [ ] 目标窗口重建句柄后的自动重连（当前以 `window-gone` 结束）
- [ ] `display-metrics-changed` 时重算吸附位置（显示器增删/缩放变化）
- [x] 穿透状态机（8px 迟滞、100ms 冷却、单探针在飞、超时降级）
- [x] 128×72 掩膜采集 / `cmd:probe` 应答 / cold-ready-stale / 矩形退路
- [x] 拖拽位移与末速度、`head_patted` 的 4px/250ms/800ms 判定（第 4/5 步）
- [x] 按模型包围盒设定窗口尺寸 + 只读资产协议 + `model_ready` 接收（ADR 0009）
- [x] render 侧 `dragged` 状态与 HFSM 三层壳（ADR 0014）
- [x] render 侧真实回弹（ADR 0024；本轮补落地分级，ADR 0035 D4）
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
- **拖拽摇晃不出画：视口边距 + 摆角约束 + 悬空下沉补偿（2026-11-10，ADR 0058）**：
  ① **视口边距（D1/D2）**：`placeModel()` 与 `computeWindowSize()` 共用 `viewPaddingShare()`
  （= 36/756），于是 1.0x 的 `pixelsPerUnit` 与加边距之前**逐位相同**（57538），
  窗口却宽了 128px、高了 36px。掩膜基准从 720 改为 `BASE_CONTENT_HEIGHT_PX`（756），
  `view.scale` 读数同理（否则 1.0x 会被读成 0.95x）。
  ② **摆角约束（D3）**：`drag-motion.ts` 新增 `swingFits()` / `maxSwingAngle()`（纯函数，含 4 条单测）；
  侧影来自 `model-loader.measureSilhouette()`（16 带 × 2048–8192 点，排除光环/配件，已平移到脚底中心）。
  **关键教训**：用包围盒四角判"会不会出画"会把 0.35rad 压到 0.12rad（脚底那一行是假角落）；
  用真实侧影能摆到 0.28rad。拖拽中按 `DRAG_SWING_RECALIBRATE_MS=[220,550,900,1400]` 重采样
  （悬空片段的头发会继续往外甩：0.2s ±182px → 1.4s ±221px），新点**只增不减**地并入，
  上限按 120ms 指数收敛；退化时返回兜底 0.06（**绝不返回 0**）。
  实测 1.0x 下 `swingLimit` 保持 **0.35（物理上限，不用夹）**，只有抓最靠上的头发时收到 0.24–0.27。
  ③ **悬空下沉补偿（D5）**：`calibrateDragPose()` 量当前姿态最低点，`dragLift = 下沉量 + 32px×比例`
  （32px 是几何必需：绕抓取点转 θ 时脚会往下扫，只补下沉会把摆角压成 0.02rad），
  随 `dragPoseGain` 淡入淡出 —— 修掉"拖着走时靴子被底边切一截"。
  ④ **取证入口**：`silhouetteCss()`（当前姿态整块 CSS 包围盒，含光环）、`dragDigest()`（O(1) 摘要：
  角度/上限/补偿/支撑加速度/内容区），以及新增 `npm run swing:shot`（脚本光标 → 真实拖拽 → 0.8Hz 摇晃，
  逐帧记录 + `capturePage`，产物 `swing-100.gif` / `swing-130.gif` / `swing-strip.png` / `swing-margins.png`）。
  ⑤ **自检 3.10 新增 7 条**：内容区 550×756 且 `pixelsPerUnit` 不变、静止四周有空白、
  摇晃摆角 >0.15rad、1.0x 下摆角容得下物理上限、逐帧侧影在视口内、**摆幅最大那一帧实拍 alpha 包围盒
  四周 ≥2px**、下沉补偿 >5px。
- **坐姿退场交接 + 坐姿眼皮睁眼 + 整体缩放（2026-11-10，ADR 0057）**：
  ① **退场交接（D1，修"坐完站起来抽搐"）**：新增纯函数 `sitUpperExitBlend()`（`SIT_UPPER_HANDOVER_MS=300`，`easeInOutCubic`）
  与 `updateSitUpperHandover()` / `finishSitExit()`。`sitUpperWeight` 成为**唯一**的上半身覆盖权重
  （坐姿内 = `stageBBlend × sitPoseGain`；离开后从离开那一刻的值 0.3s 收到 0），呼吸/张望/晃腿同乘这条曲线；
  收到 0 的那一帧 `releaseSitBoneOverrides()` 显式 `overrideBase(null)` × {`Spine`/`Spine1`/`Neck`/`Head`/`eye_L`/`eye_R`}
  + `overridePosition(null)` × {`bone_eye_D_L/R`}，并清 `sitGain`/`sitPoseGain`/`sitDropSpring`/`sitBodyYaw`/
  `sitPhaseAHeadApplied`/`sitStageBGain`、`sitMotion.reset()`、**新增** `sitPool.flush()`（立刻清零，不走指数衰减）。
  两条入口都开交接：`exitSit()` 与 `drag_started`（后者不经过 `exitSit`）。片段交叉淡出 0.35 → **0.28s**（`SIT_EXIT_CROSSFADE_SECONDS`），
  保证"覆写归零那一帧片段权重已经到 0"，补偿不掉块。**根因**：`BoneArbiter.overrideBase()` 是每帧持续写的，
  旧实现权重归零后**从不放手** → 头/胸/下背/眼球被永久冻在坐姿上（真机：走路时上半身拧着、头随光标抽）。
  ② **残留权重（D1.3）**：`animation-controller` 抽出 `fadeOutOthers(keep, seconds)`，在 `fadeTo` / `playHold` /
  `playOnce` / `finished` 里都调用 —— 旧实现只有 `fadeTo` 会清"半途的第三个 action"，`playHold`（坐姿 0.45s）
  与 `playOnce`（摸头 0.45s）会把它永久留在 0.5 权重上（真机第二类"抽搐"）。
  ③ **眼睛照抄站立（D3，修"坐下就眯眼"）**：本资产的眼睛是一条**骨骼链**——眼卡片根骨 `eye_L/R`
  （片段在 16.2s 把它平移 −0.00016 ≈ **−9px**）、子骨 `eye_*_1/_2`（各转 ±0.077/0.045 quat ≈ **8.8°/5.1°**）、
  眼皮链 `bone_eye_D_*` + `_01` + `_02`（眨眼 = 本地 `translation.x`：睁眼 0.000275 → 闭眼 0.000435）。
  **第一版只还原眼皮 x（片段 0.00033 → 0.000275），真机 A/B 几乎没变化**（眼球仍被压住）——逐轨对照
  GLB 才发现主因是"卡片下移 + 子骨对拧"。改为整条链**照抄站立待机**：`model-loader` 新增 8 个骨骼槽位
  （`eye_*_1/_2`、`bone_eye_D_*_01/_02`）；`BoneArbiter` 新增 `overridePosition()`（**绝对值**、每帧写、
  `null` 放手，与已删除的"手写眨眼位移通道"不是一回事）；三份快照 `eyeChainBind`（`setupAnimations()` 之前）/
  `eyeChainIdle`（第一帧纯待机，与上半身同帧）/ `eyeChainSitFrom`（阶段 B 起点），
  `quat = slerp(片段, 站立, blend)`、`pos = lerp(片段, 站立, blend)`，张望仍以加法叠在眼卡片上；
  退场期间保持睁开，`finishSitExit()` 后放手。**没有任何眨眼动画被恢复**（ADR 0046 D2 仍有效）。
  实测修复后 `sit.eyelid.x` 0.00033 → **0.00027**、`sit.eyes.captured=true`（12 根全部登记），
  真机 A/B 见 `logs/evidence/sit-eyes-before-after.png`。
  ④ **诊断**：`sit.{handover,eyelid,eyes,overrides}` 与 `RenderDiagnostics.view = {width,height,scale,pixelsPerUnit,mask,faceZoom}`，
  `sitSequence()` 增 `handoverRemainingMs` / `eyelidApplied` / `overrideCount`；**未新增状态、事件、`intent`、`emotion`、
  IPC 通道或 `RenderState` 字段**。
  ⑤ **整体缩放（D2.4/D2.5）**：`resize()` 增加 `maskCapture.resize(w,h)`；掩膜分辨率改为 `maskSizeFor()`（128×72 × 缩放，
  夹 64×36–256×144），`MaskSampler` 用**当前帧实际尺寸**做 CSS → 掩膜映射、尺寸变化作废旧 bbox；
  `headBandDiagnostics()` 不再用 `MASK_HEIGHT` 常量。
  ⑥ **自检新增 12 条**（坐姿覆写在位 ≥4 根 / 眼皮回到基线 / 16ms 采样抓到完整交接（upper 单调降到 0、覆写 4→0 与 2→0、
  交接期间眼皮不掉）/ 收尾后 handover=null 且覆写为空、`headBase.baseFrom='mixer'`、微动作池全 0、0.6s 后仍然为空；
  缩放 1.4x/0.6x/2.0x 三档的窗口尺寸、锚点、渲染侧尺寸、掩膜分辨率、缩放后仍能命中，2.0x 被工作区夹住、还原 1.0x）。
- **参数热更新与状态上报（2026-11-06，ADR 0052）**：
  ① `src/renderer/render/tunables-store.ts` 是渲染侧**唯一**参数表：`get()` / `values()` /
  `apply(patch)`（夹取后返回真正变化的 id）/ `reset()` / `restoreDefaults()`；默认值来自
  `shared/tunable-params.ts`（后者引用 `shared/constants.ts`），所以"没调过"与"调到默认值"完全等价。
  ② `cmd:tuning` 收到即写表、下一帧生效：坐姿两个常量与视线三级刚度都改成**每帧读 `tunables.get()`**，
  不再直接读常量；改参数**不重播坐姿、不打断在播片段、不重置姿势基准**。
  ③ `cmd:state-poll` → 回 `cmd:state-report`：`{ at, state, tuning, sit }`，`state` 是 `getState()` 浅拷贝、
  `sit` 是坐姿诊断子集；只在主进程索要时回，**不主动推、不开定时器**。
  ④ 取证钩子 `window.__panelDebug`（仅面板页，不跨进程）：`set(id, raw)` 走与用户拖动相同的
  `setParam → preview → invoke` 路径，`panel:shot` 用它把整条链路跑通。
  **未新增状态、事件、`intent`、`emotion` 或 `RenderState` 字段。**
- **坐姿手感标定参数 + A/B 封版（2026-11-06，ADR 0051 D7）**：
  ① **`SIT_PHASE_A_HEAD_TUNE_RAD`（默认 0）**——阶段 A（14.2–16.0s）把头骨的俯仰叠一个常量，
  实际施加 `= 常量 × sitPoseGain × (1 − stageBBlend)`，阶段 B 的 0.3s 覆盖平滑收到 0；
  负值 = 抬头，用来解决"刚坐下一直低着半眯眼"。
  ② **`SIT_SPINE_OVERLAY_WEIGHT`（默认 1.0）**——只乘下背 `Spine` 的覆盖权重
  （`upperBlend × weight`），胸/颈/头保持完整 `upperBlend`；0.85 = 保留 15% 官方片段前倾，
  解决"坐得太直、像罚坐"。
  ③ **诊断**：`sit.{phaseAHeadTuneRad,phaseAHeadAppliedRad,spineOverlayWeight,spineOverlayApplied}`，
  `sitSequence()` 也带后两者；**没有**新增状态、事件、IPC 通道、接口方法或 `RenderState` 字段。
  ④ **A/B 取证**：两组（0 / 1.0 与 -0.12 / 0.85）各跑一次 `tsc` + 主链路自检（均 **198/0**），
  自检新增 1 条"A/B 特写已产出"断言，产出阶段 A 脸（260px）/ 阶段 B 上半身（420px）各两张，
  对比图 `logs/evidence/sit-ab-compare.png`；封版提交保留组 1 为默认，真机只改两个常量。
- **坐姿两段式 + 临界阻尼下坐 + 看镜头（2026-11-05，ADR 0051）**：
  ① **窗口**：`clip-bank.sit` 改为 **14.2–16.2s**（`LoopOnce`）。阶段 A（14.2–16.0s）正常播放，
  让她自己演"坐下 + 14.95s 的第一次张望"；阶段 B（16.0–16.2s）继续播到 16.2s 后 clamp 停帧。
  ② **覆盖**：阶段 B 用 **0.3s `easeInOutCubic`** 淡入站立上半身，权重
  `upperBlend = stageBBlend × sitGain × sitDrop`；覆盖链从三根扩为
  **下背 `Spine` / 胸 `Spine1` / 颈 / 头** 四根。采集改到 `arbiter.beginFrame()` **之后**、
  用 `animationBase()`（不再读含视线偏移的 `bone.quaternion`）。实测 `headOrientation.pitch`
  从约 **0.59rad** 降到 **0.01–0.12rad**（看镜头时 0.0102rad；随机张望时会随目标抬高/压低）——"低头/眼神向下"的根因是下背前倾被上链继承。
  ③ **下坐弹簧**：新增纯逻辑 `sit-drop.ts`（k=180 / c=26.8 / 固定 1/240s 子步长 / dt≤0.05s），
  `sitDrop` 0→1；所有补偿、侧身、大腿弯曲、覆盖都乘 `sitGain × sitDrop`（诊断 `sitPoseGain`）。
  ④ **看镜头**：`sit-motion` 的每次抽签 **1/3 概率**选 `camera`（yaw/pitch=0 = 屏幕中心），
  其余为随机张望；过渡仍 800–1200ms、到位静止 ≥2s。⑤ **诊断/取证**：
  `sit.{stage,stageBBlend,sitDrop,sitPoseGain,upperOverride,holdAtSeconds,holdTimeSeconds}`、
  `motion.gaze.targetKind`、`window.diagnostics.sitSequence()` / `forceSitGaze()`；
  自检产出 `sit-stage-a.png` / `sit-stage-b.png`，并保留 `sit-step-00..11.png`。
- **待机静态站姿轮换 + 删除空闲 shy（2026-11-05，ADR 0050）**：
  ① **删除** `fidget.shy`（`Cafe_Reaction` 3.2–4.9s 的掩面缩身）与整个 `fidget.ts` 调度模块、
  `RenderDiagnostics.fidget`、"启动后 45s 冷却"机制。空闲路径**不再引用 `Cafe_Reaction`**，
  同时消除了换姿势时"手绕着手腕突然垂下"的骨骼扭曲（该扭曲是片段过渡被淡入截断造成的，
  不再触发即不再出现）。
  ② **新增纯逻辑** `renderer/render/idle-variation.ts`：从 44 段里筛出 **7 个正面、静态、循环**
  的官方待机片段（`Cafe_Idle` / `Formation_Idle` / `Carrier_Idle` / `Victory_End_Random` /
  `Carrier2_Idle` / `Victory_End` / `Formation_Idle_Random`），每 **20–45s** 抽一个
  **非当前**且片段可用的角色，走 `playRole(..., 0.8s, 'idle')` 的交叉淡入。
  参数唯一出处 `shared/constants.ts`（`IDLE_VARIATION_MIN_MS/MAX_MS/FADE_SECONDS`）。
  ③ **上下文门**：拖拽 / 坐姿 / 行走 / 说话 / 一次性演出期间不换姿势；到点不满足则从
  恢复时刻重新计时（不会"忙完立刻换"）。片段缺失只跳过该候选，不回退程序化。
  ④ **呼吸与视线不换轨**：呼吸仍由每个官方片段自带，`gaze.ts` 三层阻尼照常叠加；
  顺手补上 `IDLE_MICRO_POOL` 漏掉的 `speaking` 上下文门（ADR 0049 D1 的要求）。
  ⑤ **诊断/取证**：`RenderDiagnostics.idleVariation` 与 `window.diagnostics.{idleVariation,
  forceIdleVariation,setIdleVariationInterval}`（内部，不进 `RenderState`）；自检产出
  `idle-pose-00..06.png` 与交叉淡入四帧 `idle-crossfade-00..03.png`。
- **真机第二轮三问：躯干跟随 / 歪头回正 / 坐姿张望放缓（2026-11-05，ADR 0049 D4/D5/D6）**：
  ① **Spine1 跟随可见化**——排查结论是**没有被动画覆盖**：新增骨骼级诊断 `RenderDiagnostics.gaze.spineBone`（从 `spine1.quaternion · animationBase(spine1)⁻¹` 反解本帧实际写入量并投影世界 Y），实测 `spineYawRad=0.0665–0.0666`、`spineYawDeg=3.81–3.82`、`axisY=1.000`、`submitted=0.0665–0.0666`，四者一致；真正的问题是第一版死区/份额（0.08 / 0.18）只产生 **0.0295rad / 1.7°**，肉眼不可见。改为 **0.05 / 0.35**：头部 0.244rad → 躯干 **0.0665rad / 3.81°**，最大 **0.0945rad / 5.4°**。
  ② **`headTilt` 生命周期**——`MicroPoolEntry` 增加 `holdMinMs/holdMaxMs`：`headTilt` **3–5s**、`hands` 4–7s、`far` 5–8s，到时 `active` 自动回默认条目（`browse` / `legs`），权重指数衰减到 0；默认条目不设 hold；上下文失效立即回默认；回正不计入随机抽签。`MicroPoolSnapshot` 增 `releases` / `holdRemainingMs`。自检实测 roll 0.1388 → 0.0036、`releases=1`、`headTilt` 权重 0.026（衰减中）。
  ③ **坐姿张望放缓**——换向 **5–9s**、`easeInOutCubic` **800–1200ms**、到位后**完全静止 ≥2s**（新增 `SIT_GAZE_STILL_MIN_MS=2000`，调度取 `max(2000, hold)`）。自检 11.6s 内 2 个目标、最长连续静止 **6.1–8.9s**、头骨摆幅 **0.38–0.46rad**。
  ④ 自检新增 1 条 Spine1 骨骼断言 + 1 张 `window-gaze-spine.png`，另产出 `idle-micro-tilt.png` / `idle-micro-untilt.png`；主链路 **181/181**。
  ⑤ **顺带修一个 HFSM 边界**：`intent('pat_react')` 原来只看 `isPatReaction(reaction)`，而 `reaction` 要等下一帧 `tick()` 才清空——"刚到期的这一帧"里 `pat.active=false` 但 `reaction` 仍在，新反应会被旧反应挡掉（真机自检"说话时被摸头"复现一次：日志有 `pat_react → reacting`，但诊断读到 `active=false`）。改为同时判 `now - startedAt < durationMs`；`hfsm.test.ts` 加 1 条锁死"过期反应不挡新反应 / 未到期仍拒绝"。另外"验收 1 点击脸部"改为**先等片段播完再取头骨坐标**（旧写法在缩身时取到低 57px 的下巴，回正后落到半径外）。
  ⑥ **顺带修一个动画残留**：`fadeTo` 只对 `currentAction` 做 `crossFadeFrom`；若切换时还有第三个 action 在交叉淡入半途（待机轮换 0.8s 淡入被拖拽打断），它会停在 0.5 权重（自检实测 `Cafe_Idle=0.52`，真的会在悬空姿态上叠站姿）。现在每次 `fadeTo` 都把"除目标与上一个之外、仍有权的 action"一并 `fadeOut`；`animation-controller` 加 1 条单测。
  ⑦ **自检的环境稳定性**：真实前台读取在桌面/隐藏窗口时会返回 `hidden-window`/`no-foreground`，这是合法结果而不是失败；断言白名单补上这两个（仍排除 `disabled`/`busy`/`invalid-pet`）。
- **状态微动作池 + 视线三级阻尼（2026-11-05，ADR 0049）**：
  ① **池**——新增纯逻辑 `micro-pool.ts`（15–30s 抽签、排除当前条目、0..1 权重指数交叉、上下文失效时归零并暂停抽签），条目/间隔/姿态参数全部集中在 `shared/constants.ts`（`IDLE_MICRO_POOL` = `browse`×3 / `headTilt`×1；`SIT_MICRO_POOL` = `legs`×3 / `hands`×1 / `far`×1；`MICRO_POOL_MIN/MAX_MS`、`MICRO_POOL_TRANSITION_RATE`）。`sitting` 池在 `applySitMotion()` 里按权重混合：`hands` = 头/颈/眼低头并偏向手 + 躯干微前倾 + 晃腿停；`far` = 头/眼抬起 + 躯干微后仰 + 晃腿 0.3 倍；`idle` 池在 `updateFrame()` 的视线之后给头骨/颈骨叠 roll —— **只动现有骨骼，不新增片段**。池不是状态：`RenderState` 未增字段，`base` 仍为 `idle`/`physics` 仍为 `sitting`。
  ② **视线**——`gaze.ts` 重写为三层：眼 12 / 头 8 / 躯干 4；眼球目标 `(目标−当前头)×0.45 + 目标×0.35`（夹 ±0.45rad），躯干只在 `|yaw|>0.08` 时跟超出部分 ×0.18（**已被 D4 改为 0.05 / 0.35**）；光标静默 >150ms 后目标**先保持 150ms**，再用刚度 3.0 缓出回正；>1500ms 才进入 idle 随机微动（与 ADR 0010 D1 一致）。自检实测 t90：**眼 32ms / 头 268ms / 躯干 499ms**。
  ③ **诊断/取证**——`RenderDiagnostics.microPool.{idle,sit}` 与 `gaze.{eyeYaw,eyePitch,spineYaw,phase}`；`window.diagnostics.microPool()` / `gaze()`（极轻、可 16–100ms 采样）与 `forceMicroPool()` / `setMicroPoolInterval()`（仅自检，生产不调用）。单测新增 `micro-pool.test.ts` 11 条、`gaze.test.ts` 5 条。
  ④ **自检**——新增 9 条：视线三级 t90 阶梯（2）、idle 池抽签/平滑/歪头落点/回正（4）、sitting 池抽签/平滑/俯仰差（3），并产出 `sit-micro-hands.png` / `sit-micro-far.png`。
- **坐姿上半身照抄站立姿态（2026-11-05，ADR 0048）**：
  ① **D1 直接覆盖**——纯待机帧记录 **胸 `Spine1` / 颈 / 头** 三根骨骼的局部四元数（`idleUpperLocals`），坐姿停帧后每帧 `slerp(片段姿态, 站立值, sitGain)` 经 `BoneArbiter.overrideBase()` **直接覆盖**为旋转基底；不叠差值、不做欧拉分解、无固定偏移。呼吸/张望/眼球基底仍叠在其上（"头真的在动""呼吸平缓"两条自检仍通过）。
  ② **D2 键盘微调**——`setSitHeadTune(rad)` + `window.diagnostics.headTune(rad)` + 键盘 ↑/↓（Shift 大步 0.1 / 普通 0.02）；扫描取证 `face-tune-{m20,m10,p0,p10,p20}.png` 与拼图 `logs/evidence/face-tune-sweep.png`；**定档 `SIT_HEAD_TUNE_RAD = 0`**（完全照抄站立：再往下 0.10/0.20 明显低头、眼型变窄、刘海压眼）。
  ③ **删掉的旧机制**——`captureSitHeadLevel()` / `measureEyePitch()` / `SIT_HEAD_AIM_DOWN_RAD` / `SIT_HEAD_LEVEL_MAX_RAD` 的运行时使用 / `sit.headRawPitch`、`headLevelPitch`、`eyeRawPitch`、`idleHeadPitch`、`headWorldPitch` 全部移除；`sit.idleUpperCaptured`、`sit.headTune` 新增。
  ④ 自检：171 条全绿（改写"上半身照抄站立"1 条、新增"微调扫描产出"1 条、删除 2 条数值型头部/眼球断言）。
- **脸部特写取证 + 头部基准改口径（2026-11-05，ADR 0047）**：
  ① **取证相机**（D1）——`setFaceZoom(size)`：正交视锥缩到 `size×size` 并每帧跟随头骨（只动相机）；`setEyeProbe(enabled)`：在 `EyeMouth` 贴图上叠准星（绿=眼区矩形、品红=眼区 UV 中心、青=嘴底板），关闭时**整张还原**再重绘（描边压在脏矩形外，局部还原擦不掉——踩过，绿框会永久留在脸上）。两个接口只挂 `window.diagnostics`。
  ② **头部基准换成"站立姿态"**（D2）——`idleHeadPitch` 在纯待机帧采一次（世界 pitch，实测 **-0.032rad**），坐姿补偿 = 基准 − 片段世界 pitch（实测 **-0.120 − (-0.032) → +0.087rad**，旧实现是 **-0.248rad**）**再加固定低头 `SIT_HEAD_AIM_DOWN_RAD = 0.10`**（头骨朝向相同 ≠ 脸卡朝向相同），**只补 pitch**，yaw/roll 为 0。根因：旧口径拿绑定姿态（T-pose）当平视基准，0.262rad 里大半是参照系误差，补偿把脸抬过头 → 虹膜顶到眼眶上沿（"翻白眼/死鱼眼"）。
  ③ **不新增 `lookAt` 通道**（D3）——脸部特写 A/B 证明：眼骨 ±0.35rad 对虹膜位置几乎无影响（`face-idle-eye-{down,up}.png` 与 `face-idle.png` 几乎一致），因为 `CH0335_EyeMouth` 是近平面卡片、虹膜画在贴图上；视线由头骨朝向决定。保留 ADR 0046 D1 的"基底=绑定 + 张望×0.35"。
  ④ **诊断口径统一**（D3 附带）——`sit.headOrientation` 改为**世界（扣微侧身）**、`sit.eyeOrientation` 改为**相对头骨**；新增 `sit.idleHeadPitch`。贴图指纹每次变化打一条日志（`面部贴图 …`），基线指纹也打（`面部基线指纹 …`）。
  ⑤ **自检**：主链路新增 3 条（脸部特写产出 / 站姿+眼骨 A/B 产出 / 坐姿头部俯仰 A/B 产出）与 2 条改写（头部补偿公式、眼球与头同向）；**修掉 3 条既有的时序抖动**——"说话时被摸头"改成先等上一次反应播完再轮询、"落地下蹲"改成轮询冲击峰值、"眼睛对齐"改用眼相对头的口径（不再是"相对绑定姿态"）。
- **真机截图三问：死鱼眼 / 翻白眼 / 嘴型与侧坐（2026-11-05，ADR 0046）**：
  ① **眼球接管**（D1）——停帧后眼骨不再被 Mixer 驱动，片段自带的"向下看"（实测 **+0.262rad**）会永久保留。新增 `BoneArbiter.overrideBase(bone, q)`：坐姿把眼骨的**旋转基底**换成绑定姿态（`eyeBindLocal`，加载时采），再叠 `张望 × 0.35`；零偏移时也写（否则要等第一个非零张望才生效）。实测接管后眼球俯仰均值 **-0.14rad**、与头骨朝向差 <0.2rad。
  ② **删除全部手写眨眼**（D2）——`bone-arbiter` 删除 `addPosition()` 与整条位置偏移通道；`sit-motion` 删除 `blinkEnvelope`/排期/`blinkNow`；`render-module` 删除 `debugBlink()` 与眼皮骨分支；`main.ts`/`globals.d.ts` 删除 `forceBlink`。**停帧下不再眨眼**（站姿眨眼仍由官方 `Cafe_Idle` 动画提供）。
  ③ **微侧身**（D3.1）——`SIT_BODY_YAW_RAD = 0.15` 加在 `animationRoot.rotation.y`，按 `sitGain` 淡入；头部基准用 `removeBodyYaw()` 在**未侧身**坐标系里量（否则补偿会把侧身转回去）。
  ④ **嘴型**（D3.2）——`MOUTH_FRAME_CLOSED` 7 → **0**（平直细线），`staticFrameIndex = 0`，`mouthWidthRatio 0.24 → 0.32`；表情嘴型重映射 `smile=7 / frown=8 / small=0 / open=2`（原来 `small=9` 是**大圆张口**，正是"常驻微张"的元凶）。
  单测：`bone-arbiter` 6 条（基底覆写 2 条 + 删除位置偏移 3 条）、`sit-motion` 9 条（删眨眼 2 条、加"无眨眼字段" 1 条）、`speech` 5 条、`facial-texture` 1 条；主链路自检 169 条（新增眼球/侧身/无眼皮位移/停帧嘴型取证）。
- **真机四问：开局转圈 / 坐姿低头 / 上半身僵硬 / 嘴型（2026-11-04，ADR 0045）**：
  ① **删除转圈**（D1）——`fidget.ts` 只剩排期，`render-module.updateFidget()` 只尝试 `playOnce('fidget.shy')`，片段缺失**什么都不做**（不回退程序化）；诊断 `fidget.kind` 收窄为 `'shy'`。
  ② **头部基准重置**（D2.1）——新增 `sit-head.ts`（`sitHeadLevelCorrection` / `removeHeadOffset` / `headWorldPitch` / `headWorldYaw`）：`playHold('sit')` 权重 ≥0.95 的第一帧量一次头骨**世界** pitch（先减掉上一帧自己叠的 `yaw·pitch`），之后每帧 `+(-pitch)×包络` 抵消；夹取 ±0.6rad；离开坐姿不硬清零（跟着 500ms 包络淡出）。诊断 `sit.headRawPitch` / `sit.headOrientation`。
  ③ **张望改干脆**（D2.2）——每 2.2–4.2s 换目标、水平 ±0.36rad、**72% 抬头**（-0.06…-0.22）/28% 往下（+0…0.06），固定时长 `easeInOutCubic` 220–420ms 走完（废止指数阻尼）。
  ④ **肩膀呼吸**（D2.3）——锁骨与上臂各 ±0.02rad，上臂相位领先 90°。
  ⑤ **晃腿加大且不对称**（D3）——大腿 0.17rad / 小腿 0.136rad（×0.8），左腿速度 ×1.05、右 ×0.95，幅度 0.9，包络幂次 0.66/0.82，膝盖滞后 0.32rad（膝盖只往"折"的方向走，脚不会低于静止姿态）。
  ⑥ **嘴型**（D4）——`MOUTH_FRAME_CLOSED` 0 → **7**（小弧线），`drawAtlasFrame` 静态帧必须传真实帧数（新增纯函数 `atlasFrameIndex()`）；口型改**四档元音**（7 / 6·14 / 1·3 / 2·9）+ 档内 180ms 轮换。
  ⑦ **顺带修掉一个 NaN 传播**：`sit-motion` 的随机源全部走 `sampleUnit()`（NaN/∞/越界钳到安全值），否则注入式随机源会把 `gazeYaw` 变成 NaN 一路传到头骨四元数。
  单测新增 `sit-head.test.ts`（3 条）、`sit-motion` 扩到 10 条、`speech` 口型 5 条、`facial-texture` 静态帧 1 条；主链路/语音自检各加 4 条真机断言（头部基准 / 头真的在转 / 晃腿幅度与不对称 / 闭嘴帧 / 多帧口型）
- **坐姿回到停帧 + 全程序化微动（2026-11-04，ADR 0044）**：0.42s 循环被真机判为"抽搐"，本轮**废止**（`clip-bank.sit` → `loop:false`、14.5–14.7s、`playHold` 停帧）。停帧后 Mixer 只给静态姿态，四件事全部程序化重建，参数集中在 `shared/constants.ts` 的「坐姿活体微动」段：① **呼吸**——单根 3.6s 正弦，整体高低 ±0.9px（旧 2.4px + 0.5% 躯干缩放已删，那是"心跳感"）+ 脊柱/脊柱1/颈 ±0.006/0.004/−0.0025rad；② **自主张望**——坐姿期间**不调用 `gaze.update()`**（光标视线关闭），新调度器每 3–6s 随机 ±0.3/±0.15rad，`1-exp(-3.2·dt)` 阻尼缓动；③ **眨眼**——每 2.5–5s，`bone_eye_D_L/R.translation.x` 平移 **0.00028**（实机标定：0.00017 只闭 60%，0.00028 闭 91%），110/50/180ms 平滑包络；④ **悬空晃腿**——左右交替、`0.5−0.5cos` 单峰（只往抬的方向，避免脚甩出窗口底边），大腿 ±0.08rad / 小腿 0.06rad，600ms 软启动 + 500ms 总包络。新增 `sit-motion.ts`（纯数值，10 个单测）与 `bone-arbiter.addPosition()`（位置偏移与旋转共用"检测 mixer 重写"逻辑，防止眨眼位移累积）。**注意：其中 D3 的张望参数（3–6s / ±0.3 / 阻尼）与 D5 的晃腿幅度（0.08/0.06）已被 ADR 0045 调整；D4 的眨眼（含 `addPosition()`）已被 ADR 0046 D2 整体删除**
- **`roleWeight` 的"暂停=没播"bug（2026-11-04，ADR 0044 排查）**：`clampWhenFinished` 把 action 置为 `paused`，`isRunning()` 变 false，旧 `roleWeight()` 据此过滤 → 停帧 0.42s 后坐姿权重掉到 0 → **身体平移补偿整块消失**（截图里她被推到窗口左边、只剩半个身子）。改为维护"已激活角色表"，只认 `enabled + 权重`。新增 `role-weight.test.ts`（停帧后仍报 1 / 未播放恒为 0）
- **坐姿取帧改为"睁眼基线"（2026-11-04，ADR 0044 D1）**：窗口 14.5–14.92s → **14.5–14.7s**。14.8s 之后她开始眯眼（14.92s 眼皮 x 已 0.000314），基线半闭会让程序化眨眼看不出来。
- **取证接口（内部，不进 `RenderState`）**：`sitMotionDiagnostics()`（极轻的微动快照——`getDiagnostics()` 单次约 300ms，采不到瞬态）、`debugBlink(holdMs)`（**ADR 0046 D2 已删除**：停帧不眨眼）。新增 `tools/measure-blink.py`（虹膜像素占比判"闭没闭上"）与 `tools/compose-sit-alive.py`（微动联系表）
- **启动冷却：开局不再转圈（2026-11-04，ADR 0043 D1）**：三个根因一起堵死——① `fidgetAt` 初值 `0` → **`+Infinity`**（"安全冷却"而不是"立即到期"）；② `updateFidget()` 在模型未就绪（`ready=false` / 无 animations）时直接 return（旧实现会在"首帧→加载完成"的空窗里命中"条件全满足"，于是在加载期间转了一圈）；③ 排期改用纯函数 `nextFidgetAtMs(now, startedAt)` = `max(now + 45–95s, startedAt + 45s)`，以渲染模块构造时刻为基准，**启动后前 45 秒绝对不可能触发**。实测：06:31:17 启动 → 06:32:06 首次 `spin`（49s）。单测新增 3 条（排期边界 / 晚排期 / 非法输入）
- **坐姿不再是假人（2026-11-04，ADR 0043 D2/D4）**：`clip-bank.sit` 从"13.4–15.6s 停帧"改为**循环 14.5–14.92s**（0.42s，普查确认 14.5→14.9 的骨骼差在 1–2px 量级，接缝几乎看不见）——片段自带的呼吸/头发/手指微动回来了。`animation-controller` 三处配套：**循环角色也按窗口裁剪**（旧实现 `selection.loop ? base : trimClip()` 会静默忽略窗口，把 38s 过场整段绑上）、`playRole(role, fade, slot|null)`（坐姿不是 Base 槽位）、`roleWeight(role)`（未播放的 action 默认权重是 1，不能直接读）。另叠一层程序化微动：`bobPx` ±2.4px、`breathScale` ±0.5%（根节点 scale.y，从脚底向上伸缩、脚不离地）、`swayPx` ±1.6px/5.2s。单测新增 4 条
- **落座不再乱平移（2026-11-04，ADR 0043 D3）**：根因是 `sitOffsetPx()`（实测 x≈+265 / y≈-287）被**常量硬套**——`snap_applied` 那一帧 `animationRoot.position` 直接加满，模型瞬移近 390px；更早的 `snap_approach_started`（接近阶段 `sitting` 已为 true）也在带着这个偏移走路。修法：新增 `updateSitGain()`，用**片段混合权重**当唯一插值因子（`sitGain = roleWeight('sit')`，程序化降级退回指数包络），**所有**坐姿量（补偿、下沉、过渡抬升、呼吸、重心、后倾、弯腿）都乘它；`sitPoseActive` 闩锁保证"标定期不算在坐"。实测逐帧：`blend` 0→0.26→0.56→0.81 时 `offsetX` 0→66.7→143→209.5（= raw 257.3 × blend），`headWorld.x` 相邻帧最大跳变 **4.9px**。自检新增 3 条（补偿=raw×blend / 落座连续 / 循环播放）
- **拖拽统一官方悬空片段 + 删除全部程序化姿态（2026-11-03，ADR 0041 D1）**：`clip-bank` 删除 `held.limp`（`Carrier_Idle` 其实是普通站姿，正是"拖头不触发官方动画"的根因），`held` 只剩 `CH0335_Formation_Pickup`，**从第 0 秒起播**（0–1.2s 就是"被拎起来"的屈膝起势，每次抓起都有官方起势）。抓取带（head/body/foot）此后**只**决定 `DRAG_PENDULUM` 的摆长/阻尼/限幅/挣扎，不决定播什么。**删除**：`drag-motion.ts` 的 `dragBoneOffsets()`（12 根骨、三态手写姿态）、`DRAG_PENDULUM[*].liftPx`、render 第 4.2 步的骨骼叠加与第 6 步的 `dragLift`。保留：受迫单摆 + `pivotCompensation`（整身绕抓取点旋转）+ `struggleOffset`（作为单摆角度的一部分）。自检新增 2 条（抓头拖拽仍播 `Formation_Pickup` + 窗口跟随），单测把"三态姿态"换成"三态物理参数、字段里不得出现姿态项"
- **摸头收尾不再被切断（2026-11-03，ADR 0041 D2）**：根因有两个——① `animation-controller` 的 `finished` 固定回 `returnTo` **槽位**，而待机姿态会轮换（抱臂站姿被淡入成普通站姿）；② 裁剪窗口 0.3–2.4s 含片段自己 0.2s 的快速抬头，后面又接 0.25s 淡出。修法：`playOnce` 记住 `oneShotReturnAction`（播出前正在播的那个 action）并在播完淡回它；`ClipRule` 新增 `fadeInSeconds/fadeOutSeconds`；摸头窗口改 **0.3–2.05s + 淡出 0.45s**（停在保持段末尾，抬头/放手交给交叉淡入）。**没有**加"最后 0.2s 骨骼回正插值"（ADR 0039 D2 禁止为摸头写骨骼偏移）。单测新增"播完回到演出前的动作"1 条
- **片段利用率：13 个语义角色 + 4 段待机 + 空闲小动作（2026-11-03，ADR 0041 D3/D4）**：新增 `idle.alt2`（`Carrier_Idle`）、`idle.alt3`（`Victory_End_Random`）、`nod`（`Cafe_Reaction` **8.7–9.9s** 的鞠躬，≤1.2s）、`fidget.shy`（`Cafe_Reaction` 3.2–4.9s 的掩面缩身）；`INTENT_CLIP` 扩到 `{greet, nod, happy_hop}`，`happy_hop` 在官方片段之上保留 22px 根跳（§4.4 要求"有位移的小跳"）。待机轮换池 2 → 4 段；新增 45–95s 一次的空闲小动作：`spin`（纯根节点偏航 1.7s，梯形速度曲线，0→2π）与 `shy`（官方片段）。fidget **不是**新状态：Base 仍 `idle`、`overlay` 仍 `null`，只进内部诊断 `RenderDiagnostics.fidget`
- **坐下过渡（2026-11-03，ADR 0042 D1）**：`snap_applied` 之后 240ms 内叠加一次性"半蹲"——`transitionLiftPx` 从 +14px 落到 0、`thighBend` 0.22rad → 0、`lean` 0.05rad → 0（`sit-pose.ts` 的 `sitPose()`），与 0.45s 的片段淡入同时发生；只在**首次落座**时出现（改吸另一扇窗不重播）。程序化降级路径不叠这次抬升
- **坐姿窗口换成"坐正、手放膝上"（2026-11-03，ADR 0042 D3）**：`clip-bank.sit` 由 11.2–13.5s（手撑脸、闭眼、前塌）改为 **13.4–15.6s**（撑起身子 → 手放膝上、睁眼、大腿水平、小腿垂下），`playHold` 停在 15.6s。`calibrateSitPose()` 改为 `playHold` → **`holdSeek(片段末尾)`** → 采包围盒（旧实现量的是片段第一帧，补偿量偏）；`ModelAnimations` 因此新增 `holdSeek(seconds)`。桌面合成截图证据：`dist/selftest/window-sitting-desktop.png`
- **自检还要修的一个假失败**：`头部区：光环上的点 hit=true 但 head=false` 只探**中线**（x=W/2），而光环在角色右上方——该行是否命中取决于当帧头发/光环摆到哪儿，实测约 50% 假失败。改为"每一行沿 x 扫 8px 步长找第一个命中点"，断言终于稳定（2026-11-03）
- **背面法描边（2026-11-02，ADR 0038）**：新增 `outline.ts`（`applyOutline(mesh)` + `OutlineSet`）。做法 = `mesh.clone(false)`（`SkinnedMesh.copy()` **共享同一 `Skeleton`** 与绑定矩阵）→ `ShaderMaterial{ side: BackSide }` → 顶点着色器里 `#include <skinning_*>` 全链拿到**蒙皮后的法线与位置**，再按 `mvPosition.xy += viewNormal.xy * smoothstep(0.02,0.30,len) * width` 外扩 → 纯色输出。**宽度单位是屏幕像素**（正交相机下 1 视空间单位 = 1 CSS px）：身体/脸 **1.5px**、头发 **0.8px**、颜色 `0x2a1b1a`、深度偏移 0.6px + `polygonOffset`。范围：`Body`/`Hair`/`Face`（3 个描边壳，共享 2 个材质实例）；`EyeMouth`/`Eyebrow*`/`Halo`/已隐藏配件**不描**。**没有后处理、没有新 RenderTarget、没有第二套动画状态**。实测：draw call **7 → 10**、三角形 9,926 → 19,130（同一几何再画一遍）、帧时间 EMA **16.7 → 16.7ms**（vsync 封顶）；描边壳与源网格**世界矩阵逐元素一致（`matrixDelta = 0`）**，所以呼吸/眨眼/拖拽/坐姿全程不穿模、不滞后。**两个实测坑**：① 归一化 `viewNormal.xy` 会把"正对镜头"的浮点噪声放大成随机方向 → 脸皮/头发卡片上出现楔形黑块（暗像素占比 16.1%→23.3%），改 `smoothstep` 后收敛到 +4.2pp；② 头发是**重叠卡片**，每张卡的描边会叠线，1.2px 档最厚处 12 设备像素（6 CSS px），单独降到 0.8px 后收敛到 2–3px。A/B 截图（`PET_OUTLINE_DIAG=1`，连拍 6 对取 16×16 缩略图差最小的一对）：整身暗像素占比 24.8%→28.7%、头部 16.0%→20.2%、外套 29.7%→33.2%。主链路自检新增 5 条结构级断言（含 `matrixDelta`）
- **光环受光定论（2026-11-02，ADR 0038 D6）**：`PET_HALO_DIAG=1` 同姿态对照 `MeshBasicMaterial` vs `MeshToonMaterial`——区域亮度 198.2 → 193.0、暗像素占比 13.2% → 16.7%，观感从"均匀发光的粉色符号"变成"右半侧暗玫瑰 + 顶部高光被吃掉"的脏塑料片。**定论：光环保持无光照 `MeshBasicMaterial`，不吃光、不描边**。`window.diagnostics.setHaloToon(true)` 只留作一次性对照（沿 ADR 0026 的惯例），不进生产路径
- **全局光照 + Toon（2026-11-02，ADR 0037）**：先做**资产审查**再动材质。新工具 `tools/audit-glb-assets.mjs`（只读、自带 PNG 解码）遍历 GLB：**8 张贴图全是 RGBA8 颜色贴图、10 个材质只有 `baseColorTexture` 一个槽、没有 Mask/Ramp/多通道打包图、没有第二套 UV**——本资产是"纯色平涂 + 一张颜色图"的移动端 NPR 资产，阴影信息不在贴图里。`COLOR_0`：**RGB 全为常量**（要么全 1，要么整块一个常量色），**alpha 才是真数据**（0/0.102/0.2/0.251/0.349/0.502/0.745/1，即 8 bit 量化的 26/51/64/89/128/190/255），按骨骼分布与飘带/躯干相关，**疑似描边遮罩而非阴影 ramp**；`Eyebrow`/`EyeMouth` 的 alpha 恒为 0，所以 alpha **绝不能**接进 `alphaTest`/`transparent`。实现：新增 `toon-shading.ts`（`ToonShading` 类）——主方向光（强度 2.6、方向 `(-0.38,0.72,0.58)` = 斜上方偏左前）+ 极低环境光（0.55，占受光面 17.5%），**`ambient + directional = π`** 使受光面 = 贴图原色（白外套不被压灰）；代码生成 **3 阶** `DataTexture` 色阶（32×1、`NearestFilter`、`NoColorSpace`，断点 `dot≤0.12→0.58 / ≤0.38→0.80 / >0.38→1.00`）→ 硬边二分；**只把 `CH0335_Body` 与 `CH0335_Hair`** 换成 `MeshToonMaterial`（保留 map/color/alphaTest/side/depthWrite，显式 `vertexColors:false`）。**面部死守**：`Face`/`EyeMouth`/`Eyebrow*` 由正则双重排除，永不参与。**ADR 0036 的手部顶点色烘焙整体废止**（删 `skin-shading.ts` 及其单测/诊断接口），手部改由真光照产生明暗。A/B（`PET_TOON_DIAG=1`，同表情同帧，连拍 5 对取脸部统计最接近的一对）：外套近白占比 **38.6% → 30.6%**、左手 **35.1% → 19.3%**、全身亮度只降 4.2%（受光面不变）；截图 `toon-00-before.png` / `toon-01-after.png` + 5 张局部裁剪。主链路自检 **131/131**（4 条材质级断言替换原"手部烘焙"1 条）；单测新增 `toon-shading` 6 条、删除 `skin-shading` 6 条；`tsc --noEmit` 0 错
- **手/小臂发白修复（2026-11-02 真机，ADR 0036；已被 ADR 0037 废止）**：数据定位——`CH0335_Body_6` 的 150 个 Hand + 64 个 Forearm 顶点共用材质 `CH0335_Body`（`MeshBasicMaterial`，`map` 存在、512²、`colorSpace=srgb`）；手部 UV 只有约 `1.2 × 1.0 texel`，采样恒为 `#f1edec`；场景**没有任何灯**。根因 = **平涂身体贴图 × 无光照材质**（不是缺图、不是色彩空间、不是过曝）。当时的修法：`skin-shading.ts` 的 `bakeSkinShading()` 把 `clamp(ambient + diffuse·dot(n, light)) × tint` 只写进手/小臂顶点的 `COLOR_0`（214 个）。**2026-11-02 起该模块已删除**（ADR 0037 D4）：同一条判据（平涂贴图 × 无光照）现在由 Toon 光照正面解决，且覆盖全身而非 214 个顶点
- **本轮四套自检全绿（exit 0）**：主链路 **128/128**（新增"手/小臂已烘焙暖色明暗"1 条）、输入条 **29/29**、语音 **30/30**、缺失模型 **4/4**；`tsc --noEmit` 0 错；单测新增 `skin-shading` 6 条（普通 Mesh 不被误伤 / 交错属性转换 / 归一化 Uint8 转换 / 幂等 / 明暗公式边界）
- **拖拽"有重量"（2026-11-02，ADR 0035）**：`drag-motion.ts` 纯函数（抓取带、受迫单摆、绕支点补偿、三态姿态）；渲染侧在 `pointerdown` 记录抓取点（`noteGrabPoint`），`drag_started` 时按骨骼最近点分类为 head/body/foot（骨骼缺失退回掩膜 bbox 三段带），**支点用真实按下点**（不用骨骼中心；否则抓头发时支点差 140px），用 `pivotCompensation(p, θ)` 绕抓取点旋转；抓头切 `held.limp`（`CH0335_Carrier_Idle`，手臂自然下垂），抓身/抓脚用 `held`（`Formation_Pickup`）；每帧从 `window.screenX/Y` 求支撑加速度（两级 EMA + 死区 + 限幅）驱动单摆；松手保留 θ/ω 衰减；`motion_ended{settle}` 用 `settlePeakDownVelocity` 换算 impact，按 0–300ms 包络做 `scale.y` + 脊柱/膝/臂辅助下蹲。**没有新 IPC、没有新状态、没有物理引擎**；自检新增"抓取带与支点已建立""落地 impact > 0"两条；`PET_GRAB_CALIBRATE=1` 落 `grab-head/body/foot.png` 三张截图
- **吸附接近与坐姿生命周期（2026-11-02，ADR 0034）**：`handleEvent` 新增 `snap_approach_started` → `hfsm.snapApproaching()` 提前进入 `sitting`（接近阶段），播 `walk`；`snap_applied` 才 `playHold('sit')`；`snap_released` 按 reason 启动 `startle`（clicked/command/window-gone/fullscreen 四档；dragged 不叠）；坐姿视线仍走 `gaze.update`，自检断言"sitting 下光标移动 → yaw 变化"。诊断 `sit.arrived` / `sit.approach` / `drag.startle`
- **骨骼轴向标定（2026-11-02，ADR 0035 D5）**：`window.diagnostics` 暴露 `listBones/setBone/clear/boneWorld`；`PET_CALIBRATE=1` 对 `Spine`/`Neck`/`UpperArm`/`Thigh`/`Calf` 分别施加 ±0.25/±0.3/±0.5 并落 13 张 `dist/selftest/calib-*.png`。实机结论：`spine/neck pitch>0 = 低头/前屈`；`upperArm roll<0 = 双侧抬手`；`thigh pitch<0 = 腿前抬`、`calf pitch>0 = 小腿后摆`。`ModelBones` 从 6 根扩到 21 根，全部登记进仲裁器
- **坐姿"头在打转"修复（2026-11-01 真机 bug，ADR 0029）**：根因不在视线/光环/`playHold`，而是骨骼仲裁器判断"动画这帧写没写"的方法——three 的 `PropertyMixer.apply()` 在累计姿态与上一个 accu 相同时**跳过 `binding.setValue()`**，`playHold` 停帧后 mixer 再也不写头骨，旧判据（"骨值 = 我上次写的值 ⇒ 动画没写"）被浮点末位噪声击穿 → 把上一帧的偏移当成新基底 → 每帧再叠一次（实测 **2.51 rad/s**）。修法：新增 `arbiter.capture()`（`mixer.update()` **之前**记录受控骨骼四元数），`beginFrame()` 改为"这中间变没变"的直接观测；阈值 1e-6。修后 1s 漂移 **0.000 rad**，桌面截图与窗口截图不再互相矛盾
- **骨骼仲裁可观测**：`BoneArbitrationState` 增 `baseFrom`（`mixer`/`cache`）与 `applied`；`RenderDiagnostics.sit` 增 `headQuat` / `headWorld` / `headBase`；自检断言"坐姿 1s 内头骨不漂移（≤0.15 rad）"
- **坐姿 `sitting`（本轮，ADR 0028 D8）**：`hfsm.ts` 新增 `snapApplied(now)` / `snapReleased(now)`——进入即 `Physics=sitting`、打断 `walking`、清空行走排期；`snapReleased` 只在仍是 `sitting` 时生效（`drag_started` 优先，不会被回滚）。`animation-controller.ts` 新增 `playHold/clearHold/hold()`：`LoopOnce + clampWhenFinished`，播完**停在最后一帧**、不自动回槽位（`playOnce` 相反），诊断带回 `done`。`clip-bank.ts` 新增 `sit` 角色（`CH0335_my_event088_pastmemory_01` 11.2–13.5s 裁剪）。`render-module.ts`：加载期"临时切到坐姿采样身体包围盒"（淡入 1ms）→ 每帧把 `animationRoot.x/y` 补偿到"身体中心=窗口中线、最低点=窗口底边"；坐姿期间关掉待机姿态轮换、`handleIntent` 照常可用；`sit-pose.ts` 提供呼吸浮动（1.2px/3.6s）与程序化降级（下沉 24px + 大腿 0.45rad）
- **光环跟随头骨**：`HaloRoot` 不是骨骼、任何片段都不驱动它（回忆片段把角色搬走时它留在原地）→ 加载期标定"光环相对头骨"的偏移，每帧把光环挂回头骨（`updateHalo`）；诊断新增 `sit` 块（sitting/edge/procedural/clip/done/dropPx/bobPx/offsetPx）
- **顺带修 bug**：占位胶囊体的位置被写成 `-height/2 + 24`（`animationRoot` 已经在底边 → 双重偏移），实测只剩 1px 露在窗口底边；改成 `+24` 后"缺失模型"自检 4/4
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
- **骨骼仲裁（ADR 0014 D1/D2；基底判定于 ADR 0029 修正）**：`bone-arbiter.ts` 固定每帧顺序 **`capture()` → Mixer → 抓取动画基底 → 视线叠加 → pat 叠加 → 单次写回 → Physics 根变换 → render**；`head`/`eyeL`/`eyeR` 只允许仲裁器写。**"本帧动画有没有重写这根骨"改为用 `mixer.update()` 前后快照判定**（ADR 0029：three 的 `PropertyMixer.apply()` 在停帧后会跳过冗余写入，旧的"骨值 = 我上次写的值"判据在浮点噪声下会误判，把上一帧偏移当成新基底 → 逐帧累积）；未受动画驱动的骨骼仍然安全。
- **视线改造（本轮）**：`gaze.ts` 不再持绑定姿态快照，改为向仲裁器提交 yaw/pitch 偏移；Idle 动画驱动头/眼时视线仍然有效（自检：左右光标 `yaw` 分别为 -0.24 / +0.24）。
- **头部区改由头骨半径判定（2026-11-03，ADR 0040）**：`cmd:interactive.head` 的权威口径从"掩膜 alpha 包围盒顶部 22%"（R-10 旧文）改为"以 `bones.head` 的内容区 CSS 位置为圆心、`HEAD_PAT_RADIUS_RATIO=0.125 × 内容区高度` = **90px**（422×720）为半径的圆"，判定在渲染侧 `headSampleAt(x, y, maskHead, hit)` 完成；头骨/模型缺失时退回旧的 bbox 22%，两者都不可用 → `head = null`（主进程保守丢弃）。实测几何：头骨 y≈343、发顶 y≈260、脸 y≈350–420、光环 y≈120–205 → 圆覆盖 **253–433**（发顶到下颚），**光环落在圆外**。诊断：`headBandDiagnostics()` 返回 `{source, headBoneCss, headRadiusPx, bandBottomCssY, bbox, holdClip}`；probe 日志每次打印 `boneY/radius/dist/src`。自检点位从"包围盒顶部 17%"改为"头骨 + 1% 内容高"，新增 3 条口径断言 + 2 条端到端验收（点脸触发且播官方片段 / 点光环不触发）
- **落地冲击换口径并收平（2026-11-03，ADR 0040 D3）**：删除 `settlePeakDownVelocity`（settling 期间窗口向下峰值——自由落体必然饱和，导致每次拖拽都按"重摔"压满 8%），改用 **`drag_released.vy`**；`LANDING_MAX_SQUASH 0.08 → 0.03`、`LANDING_DURATION_MS 300 → 220`、`LANDING_IMPACT_MIN 150 → 700px/s`。实测：向下甩手 `vy=2220` → `impact=1.00`、`squashMax=0.0300`；轻放（`vy=0`）→ `impact=0`、`squashMax=0`（自检新增"轻放不缩"断言）。窗口反跳同时由 `SETTLE_RESTITUTION 0.28 → 0.15` 收小（shell 侧常量）
- **摸头改为纯官方片段（2026-11-03，ADR 0039）**：`clip-bank.ts` 的 `pat` 角色改绑 `CH0335_Victory_Start_Random` 0.3–2.4s——全量普查（44 段 × 0.2s 采样骨骼事实：身高代理/手到头距离/头骨 pitch-roll/脚底高度）后唯一"站姿 → 缩身抱手低头 → 保持 → 抬头回正"的闭环片段；`Cafe_Reaction` 只留 `greet`（0–2.2s）。**删除 `pat-react.ts` 与其单测**，render 里所有摸头专用骨骼偏移（头 pitch/roll）、`animationRoot.rotation.z` 的身体前倾、`'pat'` 嘴层归属全部移除——摸头不再有任何程序化姿态或 `scale`/squash。表情改为把 `effective emotion` 临时投影 `shy`（走官方差分，ADR 0026）；`PatDiagnostics` 改为 `{active, body, clip, blockedBy}`。`hfsm.dragStarted/dragReleased` 清空 `reaction`，`headPatted/intent` 在 `dragged` 也拒绝；`handleIntent('pat_react')` 在已有摸头反应时不重启（避免把 2.1s 官方片段截成 1.1s）。§5.3 三行（说话/行走/坐着被摸头）改为"身体通道不动、只表情"。**顺带**：`nod` 的"整身 `scale.y` 压扁 6%"也换成头骨低头 0.26rad + 颈骨 0.35 倍（同一类"生硬压缩"，且它是兜底台词的常用 intent）——`REACTIONS` 里再无 `squash`，`animationRoot.scale` 只剩落地与惊跳两处
- **拖拽姿态（ADR 0014 D3）**：`drag_started` → crossFade 到 `Formation_Pickup`（被拎着的垂姿，ADR 0023 D3）、`animationRoot` 抬升 18px + 周期 1.6s / ±0.05 rad 摇摆；`drag_released` → Physics=`settling`，回弹过程中淡回 Idle。
- **行走调度与窗口位移（2026-10-31，ADR 0024 D1）**：`hfsm.ts` 的 Base 增加 `walking`——idle 满 20–40s（注入随机源，可单测）后随机方向 + 100–300px，`tick()` 返回 `startWalk`；`render-module` 收到后播 `Cafe_Walk` 并经 `cmd:walk` 让 shell 位移。**不用动画 root motion**：位移由 `shared/motion.ts` 的 `stepWalk`（刹车曲线 v=√(2ad)）驱动，窗口 16ms 更新一次。到达/撞边/被拖拽打断都由 `motion_ended{kind:'walk'}` 收步。
- **真实回弹（2026-10-31，ADR 0024 D2/D3）**：`drag_released` 进入 `settling`，shell 用弹簧-阻尼（k=140、c=12、恢复系数 0.28）把窗口落到工作区地面线，水平速度按 `e^(-5t)` 衰减；落地后 render 加 180ms / 6% 的下蹲缓冲。回弹期间 `intent` 与 `head_patted` 被忽略（唯一例外是重新拖拽）。物理全部是纯函数（`stepSpring`/`stepWalk`/`stepSettle`），单测 12 条。
- **配件隐藏（本轮，ADR 0014 D5）**：`HIDE_ATTACHMENTS` 默认 `(weapon|prop|brush|outline)`，实测隐藏 `CH0335_Weapon` / `CH0335_Prop_Outlline` / `brush_01` 三件；只 `visible=false`（不删节点、不改材质），隐藏集合同时不参与取景。
- **地面校正（本轮，ADR 0014 D4）**：加载后按 Idle 姿态做一次 CPU 蒙皮采样（每网格 ≤4096 顶点），把可见网格最低点对齐内容区底边；实测 `Cafe_Idle` 校正 **-0.2px**，`resize` 后重算，不逐帧。
- **口型通道（本轮接线，ADR 0015 D4）**：`facial-texture.ts` 以 EyeMouth 贴图为底、8× 超采样 CanvasTexture：刷肤色底板 + 画图集帧。渲染侧语音播放器按 **30Hz** 把包络电平映射成 8 级帧，经内部接口 `setMouthFrame(frame)` → `MouthChannel.setFrame` 驱动贴图；`speech_ended`（任何 reason）调 `resetMouthFrame()` 回闭嘴帧。口型通道优先级最高：`speech_started` 时立刻 `applyFacial(force)` 让嘴层归 `lip-sync`（ADR 0039 起嘴层只剩 **口型 > 表情 > 静态闭嘴** 三级，`'pat'` 已删除）。
- **口型诊断（本轮）**：`getDiagnostics().speech = { frame, driven }`（内部，不进 `RenderState`）；自检用它与 `window.petVoice.getDiagnostics()`（包络电平/帧/AudioContext 状态）互相校验。
- **`model_ready`（阶段 4.5）**：首帧渲染后经 `evt:broadcast` 上行，payload `{modelId, loadMs}`；shell 记日志并走与 `did-finish-load` 相同的幂等显示路径（§6.3、§7.3）。
- **能力探测**：`getState().modelReady` 真实反映加载结果；更细的诊断（包围盒、ppm、骨骼名、当前动作/权重、HFSM 快照、`pat {active,body,clip,blockedBy}`、隐藏网格、地面校正、视线角度、口型通道）在内部 `window.petModel.getDiagnostics()`。**动作名按 ADR 0014 D7 不进入 `RenderState`**（§7.1 字段固定）。
- 掩膜采集与 `cmd:probe` 应答（128×72、20Hz、垂直翻转、cold/stale/矩形退路）、`cmd:drag` 上行、R-8 暂停链路保持上一轮实现，未回退。

### 未完成
- **微动作池的生产间隔（15–30s）无法在自检里真等**：自检用内部 `setMicroPoolInterval(650,650)` 压缩后断言"换过 ≥2 个条目、权重平滑"；生产默认值只由常量与单测锁死，真机观感仍需人眼复核
- **池条目只有三条**（sitting）/ 两条（idle），且 `hands` / `far` / `headTilt` 的幅度是**一次标定**（只动头/颈/眼 + 躯干 ±0.02rad）：换模型、换窗口高度或换坐姿片段后要重看 `sit-micro-hands.png` / `sit-micro-far.png`
- **`hands` 不是字面"托腮"**：本资产无 IK，抬手臂会穿脸/穿发，也没有官方坐姿片段支撑（ADR 0049 的明确取舍）
- **idle 池只有"歪头"一个变奏**：资产没有伸懒腰/挥手片段，更多花样要等新素材（ADR 0045 D1 的同一约束）
- **池不保证长周期均匀**：只排除"当前条目"，`legs` 权重 3 时可能连续多次抽到 `legs`（这符合"偶尔变奏"的语义，但不是严格轮转）
- **三级阻尼只在站立/idle 生效**：`sitting` 期间光标视线按 ADR 0044 D3 关闭，坐姿用 `sit-motion` 的自主张望，不经过 `gaze.ts`
- **躯干层没有在 `dragged` 期间单独阻断**：与其它通道一致叠加；拖拽时单摆角度远大于 0.0945rad 的躯干跟随，观感上可忽略，但未做专门断言
- **自检的 t90 依赖探针节奏**：主进程 16ms 轮询停顿或窗口失焦会让采样稀疏；断言阈值（眼早 60ms / 头早 100ms）已按实测留余量
- **抓头与抓脚"上半身表现"一致**（都播 `Formation_Pickup`），只有单摆物理不同；要恢复部位特有的悬空姿态，需要第二段"悬空"素材（`Victory_End_interaction_01` 是唯一候选，但根骨偏左 128px、悬空 73px，要先做中心/落地补偿）
- 空闲小动作是**概率性**的（45–95s、50% 转圈 / 50% 害羞），自检无法稳定命中；只有纯函数单测 + 日志可证
- `sitting` 期间没有专门的坐姿表情（沿用当前 `emotion`；片段自带"手放膝上"的姿态，表情效果比旧窗口明显）
- **官方表情差分尚未获取**：`ZM-Kimu/Blue-Asset-Downloader` 在本机卡在三处环境问题（uv 对 PyPI 的 TLS 证书不受信、缺 .NET 10 SDK、未走到 BA CDN），详见 ADR 0026 D6.4。当前 `data/expressions/` 为空，表情走"只变嘴型"降级；`data/expressions.fixtures/` 是非官方 fixture，仅用于自检自证
- 眉毛类表情（§4.5 的"眉内侧下压""眉下压"）：本资产眉毛/眼线是几何体 + 1 texel 纯色块，贴图改不了形状。若官方差分里带眉毛则可直接接入（协议白名单加文件名即可），否则需要"眉毛贴片"（等于改模型）
- `angry` 与 `sleepy` 共用 `half` 眼型、嘴型差异小，视觉区分度一般（可继续调参或加眉毛贴片）
- 眼型/嘴型/红晕的弧度、厚度、浓度是**美术标定值**，只做过截图目视复核，没有量化美观指标
- 动作名进入 `getState()`（需契约 minor + ADR，见「跨模块阻塞」）。
- 真实鼠标 / 多显示器 / DPI 变化下的人工复验。
- 行走的"掉头"只做了单次翻转：连续撞边（窗口比工作区还宽）时直接停下，没有来回踱步。
- **只有身体/头发吃光**：配件（`Weapon`/`Prop`/`brush`/`Halo`）仍是平涂 `MeshBasicMaterial`。前三个默认隐藏（ADR 0014 D5），**光环是可见的**——目前它不受光照，和头发的明暗关系对不上
- **面部与身体的光照不一致**（有意为之，ADR 0037 D3）：脸是"已经烘焙好的最终颜色"，吃光只会变脏；要统一得先做"不受光但带边缘光"的面部专用材质
- **`COLOR_0.a` 的真实语义未确认**：数据形态像 8 bit 遮罩（疑似描边宽度），但没有任何官方文档；本轮不动它。若将来要接，必须先证明"接进去不会毁掉眉毛/五官"（它们的 alpha 恒为 0）
- **二分线是纯几何的**：本资产没有 Ramp/Mask，阴影形状完全由法线与光向决定，不能像官方 shader 那样"按部位调影子范围"。要让某个部位永远不吃阴影，目前只能换材质
- **没有描边（outline）**：官方 NPR 的"黑边"还没做；这是下一步最值得做的观感提升（需要用 inverted-hull 或后处理，会与掩膜采集共用一帧，需先评估成本）

### 对外暴露

| 接口 | 签名 | 稳定性 |
|---|---|---|
| `handleIntent` | `handleIntent(intent: Intent): void` | 契约 §7.3（实现取 `string` 以便对未知值降级，不抛异常） |
| `getState` | `getState(): RenderState` | 契约 §7.3（字段未增删；overlay 是单字段投影） |
| `resize` | `resize(width: number, height: number): void` | 实现细节，非契约 |
| `dispose` | `dispose(): void` | 实现细节，非契约 |
| `gazeDiagnostics` | `gazeDiagnostics(): GazeDiagnostics \| null` | 非契约（内部诊断，ADR 0049 D2/D4）：眼球/头部/躯干三层的当前角度、目标、阶段、静默时长；`spineBone.{spineYawRad,spineYawDeg,axisY,submittedYawRad}` 是 Spine1 **骨骼实际**被写入的偏航（区分"没提交"与"被覆盖"） |
| `microPoolDiagnostics` | `microPoolDiagnostics(): { idle: MicroPoolDiag \| null; sit: MicroPoolDiag \| null }` | 非契约（内部诊断，ADR 0049 D1/D5）：当前条目 / 权重表 / 抽签计数 / **`releases` 回正次数 / `holdRemainingMs` 自动回正倒计时** / 强制值 |
| `forceMicroPool` | `forceMicroPool(pool: 'idle' \| 'sit', kind: string \| null): string \| null` | 非契约（仅自检取证）：强制池条目，非法名字忽略 |
| `setMicroPoolInterval` | `setMicroPoolInterval(pool: 'idle' \| 'sit', minMs: number, maxMs: number): void` | 非契约（仅自检压缩时序）：生产路径不调用，默认仍 15–30s |
| `idleVariationDiagnostics` | `idleVariationDiagnostics(): IdleVariationSnapshot` | 非契约（内部诊断，ADR 0050）：当前站姿 / 片段 / 下一次倒计时 / 抽签次数 / 候选池 |
| `forceIdleVariation` | `forceIdleVariation(role: ClipRole \| null): ClipRole \| null` | 非契约（仅自检取证）：强制下一个 tick 换到某个站姿（`null` = 解除），非法角色忽略 |
| `setIdleVariationInterval` | `setIdleVariationInterval(minMs: number, maxMs: number): void` | 非契约（仅自检压缩时序）：生产路径不调用，默认 20–45s |

> 内部接口（不属于 §7.3，且不跨进程暴露）：`handleEvent(event)`（`evt:broadcast` 的渲染侧入口）、`setCursor(cssX,cssY,at)`、`noteGrabPoint(cssX,cssY,at)`（ADR 0035 抓取点）、**`headSampleAt(x,y,maskHead,hit)`（ADR 0040 头部区判定：头骨半径优先 + 掩膜 bbox 兜底，返回 `{head, source}`）**、**`headBandDiagnostics()`（ADR 0040 头部区几何：`source/headBoneCss/headRadiusPx/bandBottomCssY/bbox/holdClip`）**、`setDebugBoneOffset/clearDebugBoneOffsets/listBones/getBoneWorld`（ADR 0035 骨骼标定）、`setWalkInterval(min,max)`（自检压缩行走间隔）、`getDiagnostics()`（含 `facial` 块：emotion/eyeShape/mouthShape/mouthOwner/blush/alpha/faceDistance/textureDigest；`pat` 块：active/body/clip/blockedBy——ADR 0039；`toon` 块——ADR 0037；`outline`/`render` 块——ADR 0038）、`applyFacial`（内部装配点，私有）、`FacialChannel.setMouth/setEyes/repaint` / `BlushChannel.setBlush/repaint` / `MaskCapture.setPaused` / `setTickListener` / `snapshot` / `markContextLost`。
>
> 着色与材质诊断专用（只在 `window.diagnostics` 同页暴露）：`inspectMaterials()`（网格/材质/`map`/`colorSpace`/手部顶点/UV 采样色）、`tintSkin('hand'|'both'|'none')`（只染手/小臂顶点，用于证明手在哪块网格）、`testHandMaterial(color)`（整块 Body 材质换纯色，对照实验）、**`setToon(false|true)`（ADR 0037：摘灯 + 还原无光照材质 ↔ 3 阶 Toon）**、**`setOutline(false|true)`（ADR 0038：只切描边壳 `visible`）**、**`setHaloToon(false|true)`（ADR 0038 D6：光环吃光的对照开关）**、`resetMaterials()`、`handScreenPoints()`（双手骨骼的 CSS 坐标，截图取样用）。
> `PET_TOON_DIAG=1`（配合 `PET_SELFTEST=1`）只跑 Toon 对照：产出 `dist/diagnostics/toon-comparison.json` 与 `dist/selftest/toon-00-before.png` / `toon-01-after.png` / `toon-{before,after}-{coat,torso,face,handL,handR}.png`。
> `PET_OUTLINE_DIAG=1` 只跑描边对照：`dist/diagnostics/outline-comparison.json` + `dist/selftest/outline-0{0-off,1-on}.png` + `outline-{off,on}-{head,hair,coat,face,hand}.png`；同一套还采 `render.calls/triangles/frameMs`（描边的性能口径）。
> `PET_HALO_DIAG=1` 只跑光环对照：`dist/diagnostics/halo-comparison.json` + `halo-0{0-basic,1-toon}.png`（含 `-crop`）。
> 三套对照都用"连拍多对 + 16×16 缩略图姿态对齐"挑同一姿态的两帧（`poseSignature` / `signatureDelta`）。
> 资产审查走出独立的**只读**脚本 `tools/audit-glb-assets.mjs`（不依赖 three、自带 PNG 解码），报告落 `dist/diagnostics/asset-audit.json`——它不在运行时链路上，只在"换模型/换皮肤"时手动跑。

### 消费事件

| 事件 | 用途 |
|---|---|
| `speech_started` | Overlay=`speaking`；`applyFacial(force)` 立刻把嘴层交还 `lip-sync`（§5.2 口型通道最高优先级）；之后口型由渲染侧播放器按包络驱动（ADR 0015 D4） |
| `speech_ended` | Overlay 退出 `speaking`；嘴型 `resetMouthFrame()` 回闭嘴帧（任何 reason） |
| `drag_started` | Physics=`dragged`；**先 `cancelOneShot()` 收走在播的摸头片段**，再 crossFade 到官方悬空片段 `CH0335_Formation_Pickup`（**任何抓取带都一样**，ADR 0041 D1）；R-8 暂停掩膜采集；清除摸头表情投影（ADR 0039 D5） |
| `drag_released` | Physics=`settling`（同时清空 reaction）；R-8 从此刻起等 500ms 再恢复采集；crossFade 回 Idle |
| `head_patted` | Overlay=`reacting`；**只有 Base=`idle`、无 Physics、不在说话时**才播官方 `pat` 片段（其余场景只有 `shy` 表情）；`dragged`/`settling` 期间直接拒绝并记日志（ADR 0039 D4/D5） |
| `intent_resolved` | 只取 `emotion`（不触发动作）；摸头期间投影为 `shy`；该值驱动**面部贴图合成**（眼型/嘴型/红晕，ADR 0026） |
| `motion_ended` | ADR 0024：`kind:'walk'` → Base 回 `idle` 并重新排期；`kind:'settle'` → Physics 退出、加落地缓冲 |
| `snap_applied` | ADR 0028 / 0051：Physics=`sitting`、收步、两段式坐姿（14.2–16.0 正放 → 16.2 停帧）+ 0.3s 站立上半身覆盖；下坐走临界阻尼弹簧 `sitDrop`，补偿按 `sitGain × sitDrop` 缩放（缺片则程序化降级 + 同一弹簧）；期间不做行走调度 |
| `snap_released` | ADR 0028 / ADR 0042：只在仍是 `sitting` 时退出 → 按 reason 播 `startle`、淡回 `idle` 并重新排期行走（`dragged` 优先，不会被回滚）；`window-gone`/`fullscreen` 之后由 shell 把她落回桌面 |

> 生产侧（既有）：`model_ready` 由 render 经 `evt:broadcast` 上行（§6.3 事件，未新增）。

### 已知坑位

| 现象 | 影响 | 规避 |
|---|---|---|
| **"躯干完全没有跟随"的第一嫌疑不是被动画覆盖**（本轮真机） | 容易先去改骨骼仲裁/动画权重，越改越乱 | 先读 `gaze.spineBone`：`axisY ≈ 1` 且 `spineYawRad ≈ submittedYawRad` ⇒ 骨骼真的转了，问题在**幅度**（第一版 0.08/0.18 只给 1.7°，肉眼不可见）；只有 `spineYawRad ≈ 0` 才是被覆盖/没提交 |
| **判"会不会出画"绝不能用包围盒四角**（ADR 0058 D3） | 用四角时抓头单摆上限被压到 0.12rad（真实可摆 0.28rad），看起来像"单摆坏了" | 用 `measureSilhouette()` 的**侧影行剖面**；包围盒在脚底那一行也有 ±183px 的假角落 |
| **悬空姿态本身比站立宽 ≈95px、且偏左 ≈50px**（ADR 0058 D2） | 只加"站立侧影 + 36px 边距"仍会切发梢 | 左右边距用 `MODEL_VIEW_PADDING_X_PX=64`；侧影在拖拽中**重采样并入**（只增不减），让摆角上限跟着收 |
| **下沉补偿不能用"片段造成的下沉"当上限**（ADR 0058 D4） | 绕抓取点转 θ 时脚本来就往下扫，只补下沉会把摆角压成 0.02rad（等于没有单摆） | `dragLift = 下沉量 + DRAG_LIFT_MIN_PX(32px)`；代价是抓取点相对光标上移 ≤32px |
| **缩放锚点不能每次从 bounds 现算**（ADR 0058 D5） | 宽高取整带 ±0.5px，连续缩放漂 2px（自检"还原 1.00x 回原位"失败） | `resolveViewAnchor()` 记住上次提交的锚点，只在窗口被别人搬动 >2px 时重取 |
| **坐姿时序断言不能用 `getDiagnostics()` 单帧**（ADR 0058 D7） | `getDiagnostics()` 单次 ≈300ms，而落座弹簧只有 ≈0.3s → "半蹲过渡/补偿缩放"偶发假失败（同代码一天内一绿一红） | 从接近阶段就开 16ms 的 `sitSequence()` 轻采样，断言整段不变量（`offset == raw × gain` 每帧成立、`sitDrop` 中间态 ≥3 帧、阶段 B 过渡时长 150–700ms） |
| **自检桩端口写死会被 Windows 的动态端口排除范围打掉**（ADR 0058 D8） | `LLM 桩无法监听 127.0.0.1:11435（EACCES）`→ 语音/视觉自检**断言全过但 exit 1**（重启后 Hyper-V 重新占段，实测 `11367–11466` 被整段排除） | `scripts/start.mjs` 拉起前逐个候选端口试绑，写进 `PET_LLM_URL`/`PET_SELFTEST_*_PORT`；桩从环境变量取端口，启动后打一行"本地桩已监听" |
| **池的 `hold` 必须短于抽签间隔** | 自检把间隔压到 650ms 时，`headTilt` 的 3–5s hold 会被下一次抽签提前打断（不是 bug，是测试语义） | 生产是 3–8s hold < 15–30s 间隔；生命周期用**单测**（1000ms hold + 2000ms 间隔）验证，自检只验证"强制/解除后回正" |
| **`forceMicroPool` 期间忽略 hold** | 取证时以为"hold 没生效" | 强制是诊断开关，语义是"一直看这个姿态"；解除强制时才回默认条目。要看 hold 用单测或等自然抽签 |
| **张望放慢后，自检采样窗口必须 > 一个周期** | 21 个样本 × 250ms 只有 5.3s，会只看到一个目标，"换过方向"假失败 | 坐到 45 × 250ms ≈ 11.3s（> 最大周期 10.2s）；"头真的在转"改用 `yawRange + pitchRange` 之和，避免两个目标恰好接近 |
| **微动作池的 15–30s 抽签在自检里无法真等** | 会误以为"没变化 / 还是固定循环" | 自检用 `setMicroPoolInterval(650,650)` 压缩后采样 `microPool().switches / weights`；生产间隔由常量 + 单测锁死。`setMicroPoolInterval` / `forceMicroPool` **不得**接进生产路径 |
| **池权重从"非激活 → 激活"时总和 <1** | 进坐姿 / 回待机的前 ~0.5s 变奏幅度偏小 | 刻意的淡入（与 `sitGain` 双包络叠加）；坐姿振幅类断言都在 1.2s 后才采样 |
| **`headTilt` 的 roll 与光标视线的 yaw/pitch 叠加** | 歪头时"看用户"的偏航仍在，`headBase.roll` 不是全部姿态 | 这是想要的表现（歪头看你）；`headBase.roll` 单独可读，自检按它断言；调参只改 `IDLE_TILT_*` |
| **眼球领先份额会让 `eyeYaw` 短暂超过常驻量** | 目标跳变后先冲高再回落（实测峰值 ≈ 终值 1.3 倍） | 这正是"眼先动"的来源；夹 ±0.45rad、刚度 12 在 ~200ms 内回落。**不要**把它当过冲 bug 调小 `GAZE_EYE_LEAD_SHARE`，否则时间差会消失 |
| **t90 采样不能用 `getDiagnostics()`** | 单次 ~300ms，16ms 间隔的时间差会被抹平 | 用轻接口 `window.diagnostics.gaze()`（微秒级）+ rAF；断言只看"到 90% 终值的时刻" |
| **`reaction` 到期与 `tick()` 清空差一帧** | 在到期那一帧里 `pat.active=false` 但 `reaction` 仍非空，新的 `pat_react` 会被旧反应拒掉（表现为偶发"说话时被摸头没反应"） | `hfsm.intent` 现在同时判 `now - startedAt < durationMs`；`hfsm.test.ts` 锁死"过期反应不挡新反应、未到期仍拒绝" |
| **`fadeTo` 只淡出 `currentAction`，第三个 action 会卡在半途** | 待机轮换的 0.8s 淡入被拖拽打断时，`Cafe_Idle` 留在 0.5 权重，悬空姿态上叠一层站姿（自检"Base 的 Idle 已淡出"偶发失败） | `animation-controller` 维护 `actionRegistry`，每次 `fadeTo` 把"除目标与上一个之外、仍有权的 action"一并 `fadeOut`；单测锁死 `Cafe_Idle < 0.1` |
| **真实前台读取会返回 `hidden-window` / `no-foreground`** | 桌面/隐藏窗口会话里把"合法的明确拒绝"误判成失败（本轮复现 `hidden-window`，`ok=false`） | 自检白名单接受这两类明确拒绝（仍排除 `disabled`/`busy`/`invalid-pet`）；产品侧行为不变 |
| **摸头验收 1 的取点竞态**：旧写法先取 `headBandDiagnostics()` 再等 950ms | 片段缩身时头骨被压低 ~57px，取到的是"缩着的下巴"；等她回正后这个点落在头骨半径外 → `head_patted` 不触发（本轮复现一次，`click.y=457` vs 头骨 343） | **已修**：先 `waitFor(d.pat.active === false)` 再取头骨坐标（不要用固定 sleep 赌 1.75s 片段的结尾）；修后主链路连续两次 181/181 |
| **主链路自检的时序抖动**（本轮复现两次，两个不同家族：① `4px 阈值` / `窗口跟随 ≥16px` / `掩膜暂停`；② `冷却结束后可再次触发` / `overlay=reacting` / `pat.body`） | 看起来像本轮改动引入的回归，实际是**默认 20–40s 的随机行走**撞进了前半段用例：她走开时摸头点不到，走位又让脚本光标的 `current` 变旧（拖拽检查读到十几像素偏差） | **本轮已修**：`runSelfTestIfRequested` 在模型就绪后先把行走间隔推到 600s（与 `runGrabCalibration` 同一手法），后面的「行走」用例再显式压回 1.5–2s。修后主链路 **181/181**（连续两次）；若再遇到，先看 `logs/pet.log` 的 `walking 开始` 时间戳 |
| **眼骨的旋转对画面几乎无效**（ADR 0047 排查 2）：`CH0335_EyeMouth` 是近平面卡片（z 厚 1.4mm），虹膜画在贴图上 | 眼骨 ±0.35rad（20°）的 A/B 在 260px 特写下只挪 2–3px；"让眼球看向相机"这种需求**改骨头没用** | 视线由**头骨朝向**决定：头部基准对齐站立姿态（D2）。真要改瞳孔位置只能改贴图（UV 偏移/正视眼型图） |
| **眼区 UV 标定只覆盖单眼内角一小块**（`eyeSurfaces` 两个矩形 UV 完全相同，准星探针可见），嘴底板准星也偏在嘴下方 | 官方 `eyes_*.png` 差分图层**无处可画**（表情的眼型一直是 `missing` 降级） | 已知缺陷，不做半吊子修补：要用差分眼型必须先重做"按 UV 分眼"的标定，并逐张目视核对 |
| **`eyeProbe` 关闭时不能只走 `repaint()`**：准星描边压在脏矩形边界上，局部还原擦不掉 | 关掉探针后绿框永久留在脸上 | `debugProbe(false)` 先整张 `drawImage(base)` 还原再重绘（ADR 0047 D1 已修） |
| **世界欧拉角在 y≈±90° 附近退化**：`headWorldYaw` 在坐姿下读到 1.474rad 附近，张望 0.24rad 只让 yaw 变化 0.017rad | 用世界 yaw 量"头在不在转"会误判成"头不动"（自检当场报红） | 判"在动"用 `sit.headOrientation`（相对绑定姿态，范围稳定）；判"对齐站立"用 `sit.headWorldPitch`（世界 pitch，与 `idleHeadPitch` 同口径） |
| **描边外扩不能对 `viewNormal.xy` 归一化**：正对镜头的面 `|xy|→0`，归一化会把浮点噪声放大成一个随机方向，仍按满宽外扩 | 脸皮与头发卡片上出现**楔形/条状黑块**（同帧 A/B 的暗像素占比 16.1%→23.3%），看起来像贴图坏了 | 乘 `smoothstep(0.02, 0.30, len)`：轮廓处（len≈1）满宽、正对镜头的面平滑归零（ADR 0038 D2.1）；改后增量收敛到 +4pp 以内，楔形消失 |
| **头发是"重叠的卡片"**：每张卡片的轮廓都会各外扩一圈，几层投影重合处线宽叠加 | 1.2px 档在侧发重叠处叠出 **12 设备像素（6 CSS px）**，像贴纸黑边 | 头发单独一档 **0.8px**（`OUTLINE_HAIR_WIDTH`），重叠区收敛到 2–3px；单层发梢仍是清晰一条线（ADR 0038 D4）。要根治只能合并外壳或走后处理，两条都被"不做后处理"否掉 |
| **`Face` 是开口曲面**：`BackSide` 对正对镜头的三角形全部剔除 | 脸皮的描边**几乎看不见**（"装了但没有像素"）；下巴/颈部那条线其实来自 Body 与 Hair | 这是资产事实，不是 bug；`Face` 仍按需求接入（换成封闭脸皮的模型才会显现）。**不要**为了"看得见"改用 `DoubleSide`——那会把描边糊在脸上（ADR 0038 D5） |
| **描边壳与近共面表面会 z-fighting**（脸皮、双层衣料） | 轮廓内侧出现闪烁的黑色碎片 | 视空间推远 0.6px（`OUTLINE_DEPTH_BIAS`）+ `polygonOffset(1,1)` 双保险 |
| **描边会把"轮廓"算进掩膜** | 掩膜（128×72）比之前大约 ≤1.5px，轮廓也可被点中 | 这是想要的行为；R-9 的矩形退路与双线性采样不变。头部区已不依赖掩膜比例（ADR 0040：头骨半径优先），所以描边宽度变化不再影响"哪儿算头" |
| **A/B 截图会被动画污染**（呼吸/眨眼/手指微动） | 隔 300ms 拍两张可能一张闭眼一张睁眼，拿去做"有/无描边"证据不严谨 | 用 **16×16 灰度缩略图差**挑姿态最接近的一对（1px 的描边线在缩略图里被平均掉，整体位移不会）；`PET_OUTLINE_DIAG=1` 自动连拍 6 对 |
| **本资产没有 Mask / Ramp 贴图**：8 张贴图全是 RGBA8 颜色图，10 个材质只有 `baseColorTexture` 一个槽，也没有第二套 UV | "阴影范围可画"这条路不存在；二分只能由光照模型产生 | ADR 0037：`MeshToonMaterial` + 3 阶 `gradientMap`（硬边由 `NearestFilter` 给）。**换模型/换皮肤前先跑 `node tools/audit-glb-assets.mjs`**，若新资产带 Ramp，改 `TOON_STEPS` 或直接用它 |
| **`COLOR_0` 的 RGB 是常量、alpha 才是数据**（0/0.102/0.2/0.251/0.349/0.502/0.745/1 = 8bit 的 26/51/64/89/128/190/255，疑似描边遮罩） | 最新版本的顶点色**不能**当颜色/明暗乘子（只有常量），也**不能**接进 `alphaTest`/`transparent`——`Eyebrow`/`EyeMouth` 的 alpha 恒为 0，接进去眉毛和五官会整块消失 | Toon 材质显式 `vertexColors: false`；要消费 alpha 必须先出 ADR + 单测（ADR 0037 D4） |
| **面部与身体的光照不一致**：`Face`/`EyeMouth` 恒为无光照材质，身体/头发吃光 | 强光侧看会有"脸比衣服亮"的割裂感（本轮实测在可接受范围） | ADR 0037 D3 的明确取舍：脸黑比脸亮更不可接受；要统一需"专用不受光 + 边缘光"材质，另开 ADR |
| **二分线位置完全由 `TOON_LIGHT_DIRECTION` 决定** | 改方向后观感变化很大（谁亮谁暗会翻） | 参数集中在 `toon-shading.ts` 顶部常量；改完必须重跑 `PET_TOON_DIAG=1` 人眼复核 |
| **A/B 截图会被动画干扰**（眨眼/呼吸/手指微动）：隔 300ms 拍两张可能一张闭眼一张睁眼 | 拿来当"修改前后"证据会显得不严谨 | `PET_TOON_DIAG=1` 连拍最多 5 对 before/after，取**脸部亮度均值 + 标准差差值最小**的一对（眨眼会同时改变这两个量） |
| **身体贴图是平涂色块**：`CH0335_Body.png` 里手部 UV 只有约 1.2 texel（`u 0.2830–0.2854 × v 0.9558–0.9577`），采样恒为 `#f1edec`；脸/头发是插画贴图 | 手部没有任何贴图细节——无光照时就是一块"发光白板"（阶段 14 真机问题） | **已由 ADR 0037 正面解决**：手和其它部位一样由 Toon 光照产生明暗（左手近白占比 35%→19%）。ADR 0036 的顶点色烘焙已删除；`handScreenPoints()` / `tintSkin()` 仍保留作取证工具 |
| **`COLOR_0` 可能是 `InterleavedBufferAttribute`**（glTF-Transform 交错存放属性时）：没有独立 `array`，`needsUpdate` 也不在属性上 | 第一版诊断直接 `instanceof BufferAttribute`，6 块网格全跳过（`meshes=0`），手一个顶点都没染上 | `material-diagnostics.ts` 的 `ensureColorSnapshot()` 先把交错属性复制成独立 `BufferAttribute`（诊断专用，生产路径不再写顶点色） |
| **"Toon + 灯"曾经被判为不可行**（ADR 0036 D4：只换 Body → 外套变灰、脸仍白；全换 → 整体偏灰） | 误以为"加灯就会灰" | 那次是**没有做亮度配平**：本轮把 `ambient + directional` 定成 `π`，受光面 = 贴图原色，实测全身只降 4.2%，不灰。**结论已由 ADR 0037 取代** |
| **`playHold` 停帧后，three 的 `PropertyMixer.apply()` 会跳过冗余写入**（累计姿态与上一个 accu 相同就不调 `binding.setValue()`） | 骨骼仲裁器旧判据（"骨值 = 我上次写的值 ⇒ 动画没写"）被浮点末位噪声击穿 → 把上一帧偏移当新基底 → **头每帧多转一点，像陀螺**（真机实测 2.51 rad/s；桌面截图与窗口截图互相矛盾就是它在转） | 用 `arbiter.capture()`（`mixer.update()` 前后快照）直接观测"动画有没有写这根骨"，阈值 1e-6；见 ADR 0029。**任何"停帧"状态都适用，不要退回旧判据** |
| **`PropertyMixer.apply()` 的跳写是"比自己的两个 accu"**，不是"比骨骼当前值" | 试图用"先 `reset()` 骨骼再让 mixer 写"来绕过它会失效（它比的是内部 buffer） | 同上：只在仲裁器侧做观测，不改 mixer 行为 |
| **`sitting` 期间头骨会跟着视线小幅转动**（±0.2 rad） | 属正常表现，不是 bug；但会让"1s 不漂移"这类断言误报 | 自检阈值取 0.15 rad（真实累积是 2.5 rad/s 量级，差 15 倍以上），断言 detail 里带 `headBase.baseFrom` 便于区分"cache/mixer" |
| **坐姿片段的最后一帧是闭眼放松姿态**（美术事实） | 观感像在打盹；表情贴图被眼睑遮住 | 接受；换片段/换窗口要重新标定 `startSeconds/maxSeconds` |
| **掩膜随姿态变化**：坐姿脚/腿/头发的位置与站姿完全不同 | 若沿用加载期的 body 探针点，点击会落到空气里（自检踩到两次，按下被 D-2 拒绝） | 生产路径无需处理（掩膜本来就是当前姿态）；自检改用 `findCurrentHitPoint()` 在掩膜上扫描，并等 `sit.done` 后再点 |
| **`playHold` 与 `playOnce` 的区别**：前者 `clampWhenFinished` 后**不**回槽位，后者由 `finished` 事件淡回 `returnTo` | 用错的话坐姿会在 2.3s 后自己站起来 | 停帧姿态一律走 `playHold`；`clearHold` 时淡出（被暂停的 action 权重插值照常工作） |
| **加载期"临时切到坐姿采样"必须用极小淡入（1ms）而不是 0** | 淡入 0 时 three 的权重插值区间长度为 0，行为依赖 `Interpolant` 的边界分支 | `CALIBRATION_FADE_SECONDS = 0.001`，采样后立刻切回 Idle |
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
| **抓脚的"倒吊"在 422×720 窗口里装不下**：绕脚骨转 180° 会把头转到窗口底边以下，被透明窗口裁掉 | 只能做"被拎住脚踝的挣扎"（前折 + 举臂 + 屈膝），不是真倒吊 | 接受为 ADR 0035 的明确取舍；要真倒吊必须动态加高窗口/改锚点，另立 ADR |
| **`window.screenX/Y` 有 1px 量化噪声**：直接二阶差分求加速度会抖 | 单摆会被噪声驱动，看起来像"抽搐" | 两级 EMA（55/90ms）+ 死区 80px/s² + 加速度上限 6000px/s²；单测锁死极值/NaN |
| **落地膝盖弯曲可能让脚离地/穿出窗口底边**（没有 IK） | 重摔时脚可能离开底边 | 下蹲以 `scale.y` 为主、膝盖 ≤0.16rad；ADR 0040 D3 起压扁上限只有 **3%**、时长 220ms，穿帮风险进一步降低。实拍 `window-landing.png` / `window-landed.png` 复核 |
| **头部判定圆会跟着头骨走**：摸头动画本身把她压低了 ~57px（`Victory_Start_Random` 的缩身段），此时圆心也跟着下移 | 动画播放中再点"原来的那个点"可能刚好在圆外（实测圆心 y 343 → 399） | 这是**想要**的行为：判的是"她的头在哪"，不是屏幕坐标。用户在缩身过程中重新点，只要点在她当前头上就仍然算；要避免误判就让冷却（800ms）吃掉这段时间 |
| **向上甩手再落下的拖拽不会触发落地压缩**（ADR 0040 D3 的推论）：`drag_released.vy < 0` → `releaseDownVelocity = 0` | "把她往上一抛"的玩法没有落地反馈 | 刻意的：冲击只看"松手瞬间有没有向下送"。若将来要按"落下高度"分级，需另立 ADR 从窗口轨迹反推 |
| **`HEAD_PAT_RADIUS_RATIO = 0.125` 与四个落地阈值都是本资产/本机标定值** | 换模型（身高比例不同）或改窗口高度后，圆可能盖住胸口或盖不到下巴 | 自检的 `头部区几何` 会打印 `headBoneCss / headRadiusPx / bandBottomCssY`；换资产先跑一遍再定比例 |
| **`head = null` 的三层降级只在"骨骼+掩膜都不可用"时出现**（占位胶囊体、掩膜 cold 且无模型） | 此时点哪都不算摸头（保守丢弃） | 符合 ADR 0004 D1.6；日志里 `blockedBy="head-rejected"`、`headRejectedBecause="mask-unavailable"` 可确认 |
| **坐姿片段末帧闭眼**：视线/表情在最后 0.5s 不易读 | 坐姿"看着用户"的观感被闭眼削弱 | **已解决（ADR 0042 D3 → ADR 0043 D2）**：坐姿窗口换成 14.5–14.92s 循环（睁眼、手放膝上）；旧窗口 11.2–13.5s 的闭眼问题不再存在 |
| **窗口移动期间的轻点都不算摸头**（回弹 / 行走 / 吸附跟随）：`movedWindow` 判据会把它压掉并记日志 | 想摸正在走路的她，可能"点不动" | 已知取舍（ADR 0039 D5）：移动中的目标无法与"拖拽后的抬手"区分。要修必须让 D-3 的距离排除窗口自身位移（`cmd:drag` 加窗口位移或把 motion 状态喂给判定），属契约变更，暂不做 |
| **抓取点用骨骼最近点分类**：点到光环/武器（已隐藏）或发梢可能落到 head/body 的边界 | 极端点位可能选错支点 | 骨骼缺失/不可信时退回掩膜 bbox 三段带；点到光环的概率低，且光环不是可拖拽语义 |
| **6 个 `*_interaction_*` / `Victory_*_Random` 片段的可用性只有目视结论**：`Victory_Start_interaction_01` 首帧是腾空翻滚的过场（带根位移/镜头感），`Victory_End_interaction_01` 是原地小动作 | 直接拿来当"互动反应"会穿帮（她先飞起来再落地） | 片段表里只接 `Victory_Start_Random`（正面、站姿起、闭环回正）；过场片段在 `clip-bank` 不登记，换资产要重新用 `tools/clip-preview` 过一遍 |
| **摸头反应在"说话 / 走路 / 坐着"时只有表情**（§5.3 / ADR 0039 D4）：身体通道一动不动 | 观感比"整身片段"安静，容易被误判成"没反应" | 这是"删掉程序化姿态"后的唯一诚实实现；表情仍是官方 `shy` 差分投影。要身体反应就必须允许整身片段接管，那与 §5.3 冲突 |
| **摸头片段 1.75s 长于 800ms 冷却**：冷却期内再点会重启片段（`playOnce` 重置） | 连续摸头看起来像"一直在缩着" | 符合 §4.1"被同类型新反应替换"；若要"冷却期内忽略"需要改 D-4，属于契约变更 |
| **`pat` 的裁剪窗口（0.3–2.05s / 淡出 0.45s）与 `sit` 的循环窗口（14.5–14.92s）都是本资产标定值** | 换模型/换动作集后可能剪到半个动作，或收尾又变生硬 | 换资产必须用 `tools/clip-preview/census.cjs` + `filmstrip.cjs` 重新标定（ADR 0039 D1 / ADR 0041 D2 / ADR 0042 D3） |
| 嘴型"shy"帧（索引 4）曾是**资产相关标定** | ADR 0039 起摸头不再单独切这一帧，改为 `emotion=shy` 的官方差分；该常量已随 `pat-react.ts` 删除 | 若将来又要"只换嘴型不改眼型"，重新看图集选帧并写回本坑位 |
| **口型的 8 级映射是未标定假设**：图集 8×8=64 帧没有语义标注，实现假定 `0..7` 是"闭口→逐步张口"，帧 0 一定闭嘴 | 换图集/换角色时帧序可能完全不同，嘴型会"跳帧"或不对应音素 | 映射只在 `shared/constants.ts`（`MOUTH_LEVELS`）与 `mouth-mapping.ts`；帧 0 被 `resetMouthFrame` 强制回闭嘴。实测本资产帧 7 是明显张口，截图可辨 |
| `speech_ended` 会立刻 `resetMouthFrame()` | 若把"说完后的余韵"当成表现需求，会被这行抵消 | §5.2 口型通道最高优先级；宁可闭嘴也不要"说完张着嘴"。摸头的 `shy` 表情由 `applyFacial` 的状态指纹重画，不依赖嘴型帧 |
| **`capturePage()` 返回的是物理像素**（本机 844×1440），而诊断点位是 CSS px（422×720） | 自检像素差一开始全 0（裁到了左上角透明区）；肉眼截图明明有变化 | 自检按 `image.width / contentBounds.width` 缩放区域；任何截图比对都必须先算 DPR |
| 44 段 clip 全部建 action（`mixer.clipAction`），只有 2 段在跑 | 初始化多一点开销与内存；无按次成本 | 这是 three 的常规做法，切片段时才需要 action 已存在；如后续片段数暴涨再评估懒加载 |
| `dragging` / `lastPatActive` / `dragPoseGain` 是**内部标志位**，不是 §4.1 的状态名 | 读代码/日志时容易误以为新增了状态 | 只会出现在 render 内部；对外状态仍只有 `base/overlay/physics` 三个字段（§4.1 集合未变）。`reaction.kind` 里的 `head_patted` 是"触发来源"，不是状态名 |
| **`Carrier2_Idle` / `Carrier2_Walk` 与 `Cafe_Idle` / `Cafe_Walk` 是同一份数据**（普查逐项相同：缩身 0.001、手到脸 0.007、yaw 1.553） | 误把它俩当"额外待机/走路"接线，会得到两个一模一样的姿势 | 只作模式降级候选，不进待机池（ADR 0041 的资产普查）。换资产要重新比对 |
| **`*_interaction_*` / `*_Interaction_*` 四段是过场，根骨被搬到镜头外**：`Victory_End_interaction_01` 偏左 128px 且悬空 73px、`Victory_Start_Interaction_02` 与 `Victory_End_Interaction_02` 各偏左 190px | 接进 422px 宽的窗口她半个身子在窗外（"举手打招呼""开心"看似可用，实际不能用） | `clip-bank` 不接线；要用必须先做"身体中心 → 窗口中线"的**按片段**补偿（目前只有 `sit` 有这套：`holdSeek` + 停帧包围盒） |
| **资产里没有"挥手"，也没有"伸懒腰/原地转圈"**：正面家族没有任何片段把手抬到肩以上（唯一"双手举过头"是侧身的 `Vital_Retreat` / `Vital_Death`） | "打招呼挥手""伸懒腰"这类需求不能靠官方片段满足 | `greet` 用 `Cafe_Reaction` 0.15–2.2s 的"抬手摊开"（最接近）；"原地转圈"已于 **ADR 0045 D1 整体删除**（无位移的根偏航读作"贴图在转"），**不做**手写伸懒腰/歪头（ADR 0039 D2 的同一理由） |
| **`Formation_Pickup` 是 14s 循环片段**：拖拽超过 14s 会循环回"从地上被拎起"的屈膝起势 | 极长拖拽会看到她"又被拎起来一次" | 接受（拖拽通常 < 10s）；要根治得把窗口裁到 1.4–14s，但那样就失去"每次抓起都有官方起势"的效果（ADR 0041 D1 的取舍） |
| **待机站姿的 7 个候选只有 4 类轮廓**（手在胸前 / 抱臂 / 双臂垂下 / 手在脸侧），其中 `Cafe_Idle`、`Carrier_Idle`、`Carrier2_Idle` 是近邻姿势 | 20–45s 换一次，但有时肉眼变化不大；如果觉得"像没换"，不是调度器没生效 | 先减候选（只留轮廓差最大的 4 个）而不是加快间隔；诊断 `idleVariation.switches` 可确认真的换了 |
| **阶段 A 是官方片段自带的低头/半眯眼**（14.2–16.0s） | 坐下后的前 1.8s 看起来"有点困"；这是官方演出，不是覆盖失败 | 阶段 B（16.0s 起）0.3s 覆盖到站立上半身后头会抬起来（实测看镜头时 `headOrientation.pitch 0.0102rad`；随机张望时会到 0.12rad 上下）。若真机仍嫌 A 段低，可把 A 段裁到 14.9s 前（会丢掉 14.95s 的转头）或给 A 段叠一个很小的抬头偏移（未做） |
| **`Spine` 覆盖让坐姿更"直"**（下背从片段的前倾改为站立值） | 如果真机觉得"坐得太直、像罚坐" | 给 `Spine` 的覆盖权重单独乘一个 0.8–0.9 的系数（需要新的标定，本轮未做）；不要退回只覆盖三根（头会重新低下去） |
| **自检里两个"时间窗"假失败（2026-11-03 各复现 1–2 次；2026-11-04 又复现一次，已彻底修）**：① `头部区：光环上的点…` 只探中线（x=W/2），而光环在角色右上方；② `落地：向下快速松手 → 轻微下蹲` 在回弹收敛那一拍直接读 `drag.landingImpact`，而落地缓冲只活 220ms | 主链路自检偶发 1 条失败（exit 1），看起来像功能坏了 | ① 每一行沿 x 以 8px 步长找第一个命中点；② **不要用 `waitFor` 去撞 220ms 的窗口**（`getDiagnostics()` 单次就 ~300ms）——render 侧改成留存 `drag.lastLandingImpact / lastLandingSquash / landingCount`，自检断言"计数 +1 且 impact>0 且 squash ≤3%"，与采样时机无关。**教训：任何"只读一次"的短时间窗诊断都该改成"读留存值"或"轮询一个窗口"** |
| **`clampWhenFinished` 会把 action 置为 `paused`**，此时 `isRunning() === false` 但权重仍是 1、姿态仍在生效 | 任何"用 `isRunning()` 判断这个角色在不在播"的代码都会在停帧后误判为"没播"：`roleWeight()` 曾因此把坐姿权重读成 0，**整块平移补偿消失**（她被推到窗口左边、只剩半个身子） | `animation-controller` 维护"已激活角色表"，`roleWeight` 只看 `activated + enabled + weight`；单测 `role-weight.test.ts` 锁死"停帧后仍报 1" |
| **停帧下用 `bone_eye_D_*` 的平移做眨眼 = 翻白眼（2026-11-05 真机，ADR 0046 D2）**：站姿眨眼靠 `Cafe_Idle` 整段动画（眼皮平移 + 上下眼皮子骨旋转 + 混合）；停帧后只剩我们这一条平移通道，下眼皮子骨被本地 x 推上去 | 闭眼瞬间"下眼皮硬拉上去"，极其惊悚；调幅度只会更糟（0.00028 已是畸形） | **整套手写眨眼删除**：`BoneArbiter.addPosition()` 与位置通道、`sit-motion` 的 blink、`debugBlink`/`forceBlink` 全部移除；坐姿不眨眼。**教训：停帧状态不要试图复刻"需要整段动画联动"的动作** |
| **眼球也有自己的"低头"**（ADR 0046 D1）：坐姿片段里眼骨自带向下旋转（实测 +0.262rad），ADR 0045 只接管了头骨 | 头抬起来了、瞳孔还压在下面 → "死鱼眼" | 眼骨也用**旋转基底覆写**（`overrideBase(eye, 绑定姿态)`）+ 张望 ×0.35；单测锁死"覆写后回到绑定姿态、取消后回到动画姿态" |
| **`EMOTION_MOUTH_FRAMES.small = 9` 是"大圆张口"**（ADR 0046 D3.2）：`shy`/`angry`/`sleepy` 都用 `small`，且表情嘴型按 0.62 底板宽绘制 | 真机"嘴巴还是微张（一个小圆）"就是这个；换成 7 号弧线在 0.62 尺寸下也像小圆 | 逐帧目视核对后重映射：`smile=7 / frown=8 / small=0 / open=2`，静态闭嘴 0 号平直细线；`mouthWidthRatio 0.24→0.32` 保证线可见 |
| **晃腿不能往下摆**：坐姿把最低点钉在窗口底边，靴底正贴下沿 | 纯正弦的负半周会把脚甩出窗口（被裁掉），破坏吸附锚点 | 用 `0.5-0.5cos` 单峰包络，只往"抬"的方向摆；幅度 0.17rad、左右**不对称**（速度 1.05/0.95、幅度 0.9、包络幂次 0.66/0.82、膝盖滞后 0.32rad，ADR 0045 D3）；单测断言 `thigh ≤ 0`、`calf ≥ 0` 全程成立 |
| **坐姿头骨的"低头"藏在整条骨链里**（骨盆后坐 + 脊柱前倾 + 颈前伸），不是头骨本地旋转 | 只抵消 `head.quaternion` 会剩下一半低头，"四处张望"仍然在看地面 | 量**世界** pitch（`sit-head.ts` 的 `headWorldPitch`），每帧以 `-值 × 包络` 抵消；夹取 ±0.6rad，超限不修（ADR 0045 D2.1） |
| **停帧后 `getWorldQuaternion()` 读到的是上一帧的最终值**（含我们自己叠的张望） | 标定时直接拿它当基线，会把"张望"也当成"片段低头"一起抵消，抵消量越跑越偏 | 读 `BoneArbiter.animationBase()`（本帧动画基底，不含我们的偏移）再合成世界朝向；`sit-head.test.ts` 锁死"delta 减完必须精确回到绑定姿态" |
| **`drawAtlasFrame(frame, 1)` 会把任何帧号夹成 0**（`min(frameIndex, count-1)`） | 静态闭嘴写的是"7 号帧"却画成 0 号帧，缩小后几乎不可见（真机读作"没有嘴"） | 帧数参数必须传**图集真实帧数**（`columns × rows`）；新增纯函数 `atlasFrameIndex()` 作为回归点（ADR 0045 D4.1） |
| **连续量化 `round(level·7)` 在稳定电平下永远停在同一帧**（本机 TTS 的 RMS 很平） | 说话时只有一张嘴，长句像"定格" | 改成**四档元音**（0 / 6·14 / 1·3 / 2·9）+ 档内每 180ms 轮换；`speech.test.ts` 用"响→轻→静"的合成包络断言 ≥3 种帧（ADR 0045 D4.2） |
| **`getDiagnostics()` 单次约 300ms**（面部贴图摘要占大头） | 用它做逐帧采样必然错过短事件（落地 220ms、张望过渡 300ms） | 取证走极轻的 `window.diagnostics.sitMotion()`（~16ms 采样）与 render 侧留存值（`lastLanding*`）；`getDiagnostics` 只用于状态断言 |
| **开局转圈（2026-11-04 真机，ADR 0043 D1；动作本身已于 ADR 0045 D1 删除）**：`fidgetAt` 初值 `0` 表示"已到期"，而首帧→模型加载完成之间 `base=idle`/`physics=null`/不说话，`updateFidget` 的条件"全部满足" | 模型还没出现，转圈就已经开始 → 每次打开应用都看到她先转一圈；极易被误判成"随机行为"或"动画串了" | 初值改 `+Infinity`（安全冷却）+ 模型未就绪直接 return + 排期 `nextFidgetAtMs()` 以模块构造时刻为基准（启动前 45s 硬冷却）。ADR 0045 D1 更进一步：**`spin` 整体删除**，空闲小动作只剩官方 `shy`。**教训：任何"绝对时刻"字段的初值都不能是 0** |
| **`capturePage` 抓不连贯的过渡帧**：截图本身 60–80ms，但 `getDiagnostics()` 单次约 300ms（含面部贴图摘要） | 把诊断读进逐帧循环会把采样间隔拉到 ~400ms，弹簧下坐（约 0.4s）抓不到几帧；更早一版还把窗口移动叠进去，图里出现"疑似瞬移"的假象（其实是头发摆动 + 抓帧滞后） | 取证分两遍：**图一遍**（只 `capturePage`，~100ms/帧）+ **数字一遍**（只读诊断，~300ms/次）。判断"有没有瞬移"只认 `sit.headWorld.x` 的逐帧轨迹，不认截图包围盒 |

### TODO
- [x] **Spine1 跟随可见化**：阈值/份额 0.08/0.18 → **0.05/0.35**（3.82°@0.244rad），并加骨骼级诊断 `gaze.spineBone`（ADR 0049 D4）
- [x] **`headTilt` 3–5s 生命周期**：到时回 `browse`、权重指数衰减；`hands` 4–7s / `far` 5–8s；上下文失效立即回默认（ADR 0049 D5）
- [x] **坐姿张望放缓**：5–9s 换向 + 800–1200ms 过渡 + 到位后 ≥2s 静止（ADR 0049 D6）
- [ ] 真机再看一遍"更慢的张望"是否仍嫌频繁（若嫌慢，只改 `SIT_GAZE_HOLD_*`；**不要**把 `STILL_MIN` 调到 2s 以下）
- [ ] `headTilt` 的 roll 0.14rad / 3–5s hold 与 Spine1 0.35 份额都是"一次标定"：换模型/换窗口高度后要人眼复核（截图 `idle-micro-tilt.png`、`window-gaze-spine.png`）
- [x] 状态微动作池（sitting：`legs`/`hands`/`far`；idle：`browse`/`headTilt`；15–30s 抽签 + 指数交叉，ADR 0049 D1）
- [x] 视线三级阻尼（眼 12 / 头 8 / 躯干 4；眼球领先份额；躯干 yaw 阈值；150ms 保持 + 3.0 慢回正，ADR 0049 D2）
- [ ] 真机人眼复核：15–30s 的池切换观感、歪头 0.14rad、`hands`/`far` 的 0.17/0.15rad、离开窗口后的缓出速度
- [ ] 换模型 / 换窗口高度后重标 `IDLE_TILT_*` 与 `SIT_MICRO_*`（幅度是比例而不是绝对像素，但头身比会变）
- [ ] 池条目扩充：等官方坐姿/手势片段（当前资产没有"抬头看远处 / 托腮"的坐姿片段，只能头/颈/眼）
- [ ] `hands` 若将来要做字面"托腮"，必须先有 IK 或手到脸的安全区间标定（否则穿模，ADR 0049 的取舍）
- [ ] **坐姿眼神略显向下**（2026-11-05 封版时确认，ADR 0048 D3）：受限于 **2D 贴图与躯干倾斜**。
      眼骨/头骨都已试过——`CH0335_EyeMouth` 是近平面卡片、虹膜是画上去的，转骨头不会让瞳孔在
      眼眶里移动（眼骨 ±0.35rad 的 A/B 特写几乎无差别）。**若未来要彻底解决，需移动虹膜 UV
      或做正视差分图**（贴花覆盖），不要再动骨骼。证据：`logs/evidence/face-tune-sweep.png`、
      `face-idle-vs-sit.png`；现场微调入口 `window.diagnostics.headTune(rad)`（正式运行不挂键盘）。
- [x] 资产审查（贴图/通道/Mask-Ramp/顶点色）：`tools/audit-glb-assets.mjs`（ADR 0037）
- [x] 全局光照 + 身体/头发 Toon（3 阶硬边色阶）+ 面部死守；手部发白由真光照解决（ADR 0037）
- [x] **描边（Inverted Hull）**：Body/Hair/Face，屏幕像素宽度（1.5 / 头发 0.8），共享几何与骨骼（ADR 0038）
- [x] **光环受光定论**：保持 `MeshBasicMaterial`（吃光会变脏，ADR 0038 D6）
- [ ] 描边的**美术微调**：宽度（1.5/0.8）与颜色（`0x2a1b1a`）是基线值，需在浅色/深色壁纸、100%/125% 缩放下各看一遍
- [ ] 头发卡片重叠处的叠线：若要更干净，需要研究"按材质合并外壳"（把同材质的卡片合成一个 geometry 再描边）——会动到加载管线，单独评估
- [ ] 换模型/换皮肤后重跑 `node tools/audit-glb-assets.mjs` + `PET_TOON_DIAG=1` + `PET_OUTLINE_DIAG=1`，按新资产重估 `TOON_STEPS` / `OUTLINE_WIDTH`
- [x] 坐姿 `sitting`（HFSM + `playHold` 停帧 + 身体平移补偿 + 光环跟随 + 程序化降级，ADR 0028）
- [ ] 坐姿专用表情（闭眼/困倦 vs 当前 emotion 的取舍）
- [ ] `sitting` 时的腿部遮挡检查（长裙/大衣在屈膝姿态下的穿插，需人眼复验）
- [x] GLB 加载管线 + 包围盒校正 + 真实模型替换占位
- [x] 视线跟随/微动（替代眨眼）
- [x] 口型通道接口 + 静态闭嘴底图（8×8 图集标定）
- [x] `model_ready` 上行 + `modelReady` 真实状态
- [x] HFSM 三层壳（Base/Overlay/Physics）+ 自带动画接入 + 骨骼仲裁（ADR 0014）
- [x] `head_patted` → 官方 `pat` 片段 + `emotion=shy` 投影（ADR 0039；程序化通道已删除）
- [x] 拖拽 / 回弹与摸头严格互斥（HFSM 清 reaction + render 拒绝 + shell `patArmed`/`movedWindow`，ADR 0039 D5）
- [x] 拖拽统一官方悬空片段 `Formation_Pickup` + 删除按部位手写的骨骼姿态（ADR 0041 D1）
- [x] 摸头收尾：停在保持段 + 0.45s 淡出 + 回到演出前的动作（ADR 0041 D2）
- [x] 片段利用率：7 段正面静态待机轮换（20–45s / 0.8s，ADR 0050）/ `nod` 官方鞠躬
- [x] 坐姿下坐：临界阻尼弹簧 `sitDrop`（k=180 / c=26.8）+ 按 16.2s 停帧标定补偿（ADR 0051）
- [x] 拖拽抓取点分类 / 绕支点旋转 / 受迫单摆 / 松手惯性（ADR 0035）
- [x] 吸附跟随追赶模式（变化后 220ms 内每拍重算，ADR 0042 D2）
- [x] 解除吸附（`window-gone`/`fullscreen`）后落回桌面（ADR 0042 D4）
- [x] 坐姿两段式：14.2–16.0 正放（官方"坐下 + 第一次张望"）→ 16.2 停帧 + 0.3s 站立上半身覆盖 + 程序化微动（ADR 0051）
- [ ] 待机轮换的 7 个候选里有 3 组是近邻轮廓（手在胸前 / 抱臂 / 双臂垂下），实际观感变化只有 4 类；若真机嫌变化小，先减候选而不是加快间隔（ADR 0050）
- [x] 删除空闲 `shy`（`Cafe_Reaction` 3.2–4.9s）与整个 `fidget.ts`（ADR 0050）
- [x] 坐姿两段式 A/B：先正放 14.2–16.0s 让官方"坐下后张望"可见，再 0.3s 淡入站立上半身覆盖 + 程序化微动；已加"看镜头"张望目标（ADR 0051）
- [x] 坐姿手感 A/B：`SIT_PHASE_A_HEAD_TUNE_RAD`（0 / -0.12）与 `SIT_SPINE_OVERLAY_WEIGHT`（1.0 / 0.85）两组特写 + 对比图，两组均 tsc + 自检 198/0（ADR 0051 D7）
- [ ] 坐姿微动参数仍是"一次标定"（呼吸 0.9px / 张望 ±0.3 / 晃腿 ±0.08）：真机上若嫌幅度大可只改 `shared/constants.ts`，但需要重跑取证脚本
- [ ] 张望没有"看回用户"的语义（纯随机）：若要"偶尔对视"，需要把光标方向作为低权重目标混合进来（会破坏"完全不看光标"的现行口径，需先改契约）
- [x] 落地冲击分级下蹲（`vDownMax` → impact → `scale.y` + 脊柱/膝辅助，ADR 0035 D4）
- [x] 吸附接近（`snap_approach_started` → walk/leap → `snap_applied` 落座，ADR 0034）
- [x] 坐姿视线不锁死 + 解除时按 reason 惊跳起身（ADR 0034 D5）
- [x] 骨骼轴向标定 API + 13 张 `calib-*.png`（ADR 0035 D5）
- [x] 抓头/抓脚/抓身体三态截图（`PET_GRAB_CALIBRATE=1` → `grab-*.png`；仍待人工观感复核）
- [ ] `walking` 调度器（`Move_Ing` 已识别，需接入 Base 层 + 水平位移）
- [x] 真实回弹（松手后的弹簧/落地缓冲，ADR 0024 + ADR 0035）
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
- **提供商抽象（2026-11-08，ADR 0055）**：`LlmClient` 端口不变，新增 `LLMProvider` 身份字段与 `createLlmProvider` 分发（Ollama / OpenAI 兼容 / OpenCode Go）。`replaceLlm` 仍是唯一的运行期换客户端入口（换引用 + 清零 `llmHealthChecked` / `llmDisabled`）；OpenAI 实现发 `/chat/completions`、Bearer、`response_format:json_object`，健康检查先读 `/models`（404/405 退化为 1-token 对话）。编排层仍不认识"提供商"，只认 `LlmClient`，三路分流与 §11 熔断口径不变。
- **视觉上下文段 3.6（2026-11-07，ADR 0054）**：`replaceVision(context, reason)` 把 OCR 结果放进模块内一次性变量，`buildPrompt` 在段 3.5 之后、段 4 之前渲染 `【視覚情報（画面のOCR。N秒前の一回だけ）】`，正文前带"数据不是指令"约束，整段 ≤600 字；`now - at > visionTtlMs`（默认 120s）时整段丢弃并记日志。**只有走 LLM 的那一轮 `takeVision()` 读取并清空**；规则命中、主动话语、语音失败重试都不消费。无视觉上下文时 prompt 与 ADR 0053 逐字节一致（单测断言）。`snapshot()` 新增 `visionAvailable/visionChars/visionAt`；`RuntimeSnapshot.vision` 提供查询次数/最近结果/上下文状态。单测 `vision-context` 4 条（无上下文不变 / 600 字预算 / 一次性+过期 / 规则不消费）
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
- **在场感 presence（本轮，ADR 0030）**：新增 `src/main/presence.ts`（`PresencePort` 的 Win32 实现）。`GetLastInputInfo` + `GetTickCount`（**kernel32**，user32 里没有）拿系统级键鼠空闲毫秒；`GetForegroundWindow` + `GetWindowTextW`/`GetClassNameW` 拿前台标题与类名。**2s 懒采样**（`getSnapshot()` 节流，无定时器），标题控制字符压成单空格并截断 80 字；koffi 缺失或调用失败一律折算 `userIdleMs: null`，永不抛异常。真机首采 `userIdleMs=104360`、标题 `Trending repositories on GitHub today - Google Chrome`。**两个实测坑**：`GetTickCount` 不在 user32 导出表；`GetLastInputInfo` 必须声明 `_Inout_`（`_Out_` 或省略注解时 `cbSize` 传不进去，恒返回 0）
- **提示词段 3.5「环境事实」（ADR 0030 D2/D3；本轮形态见 ADR 0032 D2）**：`buildPrompt` 新增**可选** `world?: WorldFacts`；缺省时输出与 1.9.0 **逐字节一致**（`world.test.ts` 用整串相等锁死）。注入时插在段 3 与段 4 之间，单行 ≤160 字：`環境: {YYYY-MM-DD HH:mm} / 先生は {时长}前まで入力中 / 前面のアプリ: {类别} / 先生は今、プログラミングに集中している（仅 coding） / 前回の会話から {时长}`；缺项整项省略（不写"未知"）；超长按"先丢编程提示 → 截类别 → 丢上次会话 → 丢类别 → 丢输入状态"降级，时间戳永远保留。时长 `<2min` 用秒（ADR 示例就是"90 秒"）、`<1h` 分、`<1d` 時間、其余日
- **段 3 相对时间 + 去冗余 + 预算（本轮，ADR 0030 D4）**：`[10-30]` → `[今日]/[昨日]/[N日前]/[Nヶ月前]/[N年前]`（按**本地日历天**差，跨零点算昨日）；同 `tags` 且三字组 Jaccard ≥0.8 只留先出现的一条（**排序规则未改**，仍是 `hits → at → id`）；全部记忆行合计 ≤360 字，超出即停止装填（不二次截断行内文本）。`formatMemoryFacts(facts, limit, now?)`：给了 `now` 走相对时间，没给保持 1.9.0 的绝对时间
- **主动性 idle-drive（本轮，ADR 0031）**：新增 `src/main/orchestrator/idle-drive.ts`（**纯函数**，14 条单测覆盖全部边界）+ `src/main/proactive-config.ts`（开关与阈值解析，9 条单测）。orchestrator 内 15s 节拍评估：编排层 idle、voice 不在播、`userIdleMs` ∈ (90s, 5min)、距上次交互 >90s、每会话 ≤12 次（深夜 23:00–07:00 减半为 6）、距上次主动 ≥10min；判定顺序 `disabled → busy → no-presence → user-active → user-away → gap → budget → cooldown → ok`。分流固定"先 `lines.json` 的 `on:'idle'`（4 条日文台词）→ 未命中才一次 3s 超时的本地 LLM"。**三条红线**：① LLM 失败/超时/非法输出 → **完全沉默**（不发 `llm_failed`、不播兜底）；② 主动话语**进对话历史**（`{user:'（彼女が自分から話しかけた）', assistant}`）但**不写 `memory.db`**；③ 仅在"本会话已成功健康检查且未熔断"时用 LLM——主动路径**不得**自行探测，否则一次心血来潮就会把 LLM 判死
- **主动性开关（本轮，ADR 0031 D6）**：`PET_SELFTEST=1` 时**默认硬关**，只有 `PET_SELFTEST_PROACTIVE=1` 才开；`PET_PROACTIVE_DISABLE=1` 是逃生口且优先级最高；阈值可用 `PET_PROACTIVE_MIN_IDLE_MS` / `MAX_IDLE_MS` / `COOLDOWN_MS` / `MIN_GAP_MS` / `BUDGET` 覆盖（默认值仍来自 `constants.ts`，缺省时不覆盖任何一项）
- **单测 29 个**（orchestrator；M14 封版时由 34 降为 29——5 条预热用例随实现迁往 `heartbeat.test.ts`）：上一轮 27 条（规则命中/健康检查熔断/LLM 合法非法超时/`cancel` 不发布/新话语打断/空话语/chat 抛异常/摸头跳过/prompt 段序/记忆注入与写入/段 3.5 与主动路径 8 条）+ 7 条（`proactive-stats` 的判定与开口写入 + 读副本 + reset、未装配主动性时写 `disabled`、段 3.5 主动路径）；**预热相关的 5 条已整体搬到 `heartbeat.test.ts`（16 条）**
- **前台应用归一化接入（本轮，ADR 0032 D1/D2）**：`presence` 在**采样点**就把标题/类名归一化成 `coding`/`browser`/`game`/`meeting`/`video`/`other: <类名>`（新增 `src/main/presence/app-normalizer.ts`，纯函数、6 条单测表格穷举）；`PresenceSnapshot.foregroundCategory` 随之出现，`WorldFacts` **删掉** `foregroundTitle`/`foregroundClass`、只留 `foregroundCategory`——类型上就不给"把用户文档名塞进模型"留口子。段 3.5 变成 `前面のアプリ: coding`，`coding` 时追加一句 `先生は今、プログラミングに集中している`；降级顺序在原有基础上插入"先丢编程提示"
- **生命周期心跳（本轮，ADR 0033；预热从本模块迁出）**：新增 `src/main/orchestrator/heartbeat.ts` + `src/main/heartbeat-config.ts` + `src/main/env-flags.ts`（与 `proactive-config` 共用同一个"什么算真"的语义）+ `src/main/model-ready.ts`（闩锁 + 观察者）。心跳是 `runtime` 装配的**独立 15s 节拍**（`HEARTBEAT_TICK_MS`），**只做生命周期任务**，当前唯一一件 = 冷启动预热（1-token `/api/generate`；16 + 6 + 12 条单测）。触发有两条：① `model_ready` 到达**立即**一次（ADR 0033 D2，`warmUpNow('model-ready')`）；② 15s 节拍按"未热好 + 未在飞 + 未熔断 + 编排层空闲 + presence 可读 + 距上次 ≥60s + 未超 3 次"重试。**与主动性彻底解耦**：`PET_PROACTIVE_DISABLE=1` 照样预热；`PET_SELFTEST=1` 时心跳整个不启动（不建定时器、零后台推理、无 opt-in 开关）；另有 `PET_WARMUP_DISABLE=1` 逃生口。沿用 W-1…W-4（不建会话 / 不改熔断 / 不发事件 / 不占预算），唯一放宽的是 `model_ready` 触发不看 presence（启动动作本身就是在场证据，ADR 0033 D3）。`orchestrator.snapshot()` 随之**删除** `llmWarmedUp` / `warmupAttempts`，诊断搬到 `RuntimeSnapshot.warmup`（迁移后编排层不再认识"预热"这个概念）
- **托盘诊断的数据源（本轮，ADR 0032 D4）**：新增 `src/main/proactive-stats.ts` 进程内单例（`reset/publish/read`，读出来是副本）。`tickProactive()` 每拍写 `lastReason`、`publishProactive()` 每次成功开口写 `firedCount`；`startProactiveTimer()` 在主动性关闭时写 `disabled`（托盘据此解释"为什么没开"，而不是含糊的"尚未评估"）。**没有新增事件、IPC 或 setter**
- **运行期换模型 / 换角色卡（2026-11-06，ADR 0053）**：新增两个**内部**方法（不跨进程、不属契约接口）——`replaceLlm(client, reason)` 换引用并**清零 `llmHealthChecked` / `llmDisabled`**（§11 的"一次失败即熔断"只属于同一个模型，换模型必须重新开始；在途 `respond` 捕获旧引用，用旧模型说完这一句）；`replaceCard(text, reason)` 只改下一轮 `buildPrompt` 的 system 段（不清历史、不重发）。`snapshot()` 新增 `cardChars` 作为可断言事实。单测新增 2 条（换卡后 prompt 用新卡且历史保留；换 client 后健康检查重新开始、旧 client 不再被调用）

### 未完成
- 台词池的权重/随机化/多句变体（当前确定性首命中 + 固定兜底轮转）
- 云端 fallback（§10.3；明确不在默认链，未实现）
- ASR（§13 X-1）
- 记忆的跨语言召回（中文提问查不到日文记忆，字面匹配的必然结果，见已知坑位）
- 应用类别规则表的可配置化（目前硬编码在 `app-normalizer.ts`；扩类别要改代码 + 补单测）
- 主动话语的"话题延续"（现在只按规则/单次生成，不会接着上一轮的话题自己往下说）
- 段 3.5 里"上次会话"与"输入状态"信息有重叠（用户刚说完话时两者数值接近），可以合并成一项

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
| **`gap` 的基准曾经写错：真机"永远不开口"**（本轮踩到并修复） | 应用在用户已离开 4 分钟后启动时，若以 `sessionStartedAt` 为 gap 基准，等 gap 满 90s 时 `userIdle` 已越过 5 分钟 → 永久 `user-away`，一次都不开口。日志现场：22:17:17 `gap` → 22:18:17 起 `user-away` | 已改为"无显式交互时以 `now - userIdleMs` 为基准"（ADR 0031 D2.1）；单测 `idle-drive` 增加"启动即已离开 4 分钟"用例 |
| **一次离开最多主动开口一次** | 冷却 10min > 空闲上限 5min，所以第二次必定撞 `user-away` | 这是"严格打扰预算"的必然结果（ADR 0031 D2.4），不是 bug。要更黏人请同时调 `PET_PROACTIVE_COOLDOWN_MS` 与 `PET_PROACTIVE_MAX_IDLE_MS`，不要在代码里放宽 |
| **主动路径在"本会话还没说过话"时只用规则** | 用户启动后从未发言 → `llmHealthChecked=false` → 主动 LLM 不可用，只能命中 4 条 `on:'idle'` 台词 | 有意为之（ADR 0031 D4.1：主动路径不得自行探测，否则空闲时的探测会污染 §11 的熔断语义）。规则台词由 `data/lines.json` 扩充即可 |
| **TTS 未启动时主动话语只有字幕** | 真机 22:30:00 的观察：`intent_resolved{route:rule}` → `speech_ended{failed}`，气泡显示文本 | 与用户话语的降级路径完全一致（§11 / ADR 0021），不是新缺陷；启动 GPT-SoVITS 后自动有声 |
| **presence 依赖 `koffi`（可选依赖）** | 装不上时 `userIdleMs` 恒 `null` → idle-drive 因 `no-presence` 永不触发；段 3.5 只剩时间戳 | 启动日志 `presence 不可用` + `snapshot().orchestrator.presenceIdleKnown=false` 可诊断；不阻断启动、不影响对话 |
| **主动性的 15s 节拍器是进程内第二个定时器** | 容易被误读成违反 §12"不得再开第二个轮询器" | §12 约束的是**指针轮询器**（16ms，服务穿透与位移）。该节拍只做 idle-drive 评估，已在契约 §12 与 ADR 0031 D1 明确；未装配 `proactive` 时一个定时器都不建 |
| **段 3.5 让提示词不可复现** | 每次请求的 system 段都不同（时间在走） | 这是"时间感"的代价；单测只能断言"存在 + 格式正确"，不能断言整串相等（`buildPrompt` 不传 `world` 时才逐字节可复现） |
| ~~预热只在主动性开启时发生~~ **（已在 ADR 0033 修掉）**：旧实现把预热挂在 idle-drive 的 15s 节拍上，`PET_SELFTEST=1`（硬关）与 `PET_PROACTIVE_DISABLE=1` 都不预热 | 关掉主动性的人，首句仍会冷启动（10s → 撞 8s 预算） | 预热已迁到独立的心跳（`heartbeat.ts`）：`PET_PROACTIVE_DISABLE=1` 照样预热。**不要再把预热挂回 idle-drive**，那等于把"要不要打扰"和"把模型热好"重新绑在一起（ADR 0033 D1） |
| **`model_ready` 不在 `appBus` 上**（本轮真机验证抓到的坑）：它是渲染侧 → 主进程的 IPC，`shell` 的 `onRendererEvent` 是收口，但**没有** `appBus.emit('model_ready')`；第一版把预热触发写成 `appBus.subscribe('model_ready')`，单测全绿、真机静默（模型热了才怪） | "预热看起来接好了，其实一次都没发出"——最坏的一类 bug：所有断言都过，功能没生效 | 改用 `src/main/model-ready.ts` 的一次性闩锁 + 观察者（`onModelReady`），**不要**改成 `appBus.emit('model_ready')`：`appBus.emit` 会把事件回环转发给渲染侧（`evt:broadcast`）。真机验证方法见 ADR 0033「验证」一节（本地桩 + `logs/pet.log` 的 `trigger:"model-ready"`） |
| **`model_ready` 触发绕过 presence 门槛（有意放宽）** | koffi 缺失的机器上，启动时也会打一次本地预热请求 | 这是对 ADR 0032 D3 第 4 条的唯一放宽：启动动作本身就是在场证据，代价被限制在"1 token × 最多 3 次"。15s 心跳仍然守 presence 门槛（读不到就不做消耗 CPU 的事） |
| **定时器现在有两个 15s 节拍**（idle-drive + heartbeat） | 计划表上"多一个定时器"容易被误读成违反 §12 | §12 禁的是**指针轮询器**（16ms）重复；两条 15s 节拍职责不同、互不引用，任一关闭都不影响另一条（ADR 0033 D1）。自检里心跳整个不启动，所以自检期间仍然只有一个（或零个） |
| **自检的"零后台推理"是硬保证，不是默认值** | 没有 `PET_SELFTEST_WARMUP=1` 这类开关，想端到端验收预热只能起本地桩 | 刻意如此（ADR 0033 D1.1）：给自检留一个可能被 `.env` 意外打开的口，比"暂时测不了"危险得多。要看预热是否真的发生，看 `logs/pet.log` 的 `[heartbeat] LLM 预热已发出` / `已常驻内存` |
| **预热不再是编排层的事实** | 老的排查习惯（`snapshot().orchestrator.llmWarmedUp`）会读到 `undefined` | 改读 `getRuntime().snapshot().warmup`（`enabled/running/warmedUp/attempts/lastTrigger/lastResult/lastSkip`）；`tsc` 已经会拦住旧字段访问 |
| **预热会占几秒 CPU**（模型加载），且条件里**没有**排除"用户正在打字" | 用户可能感到一次短暂卡顿 | 只排除了"她在说话/推理中"；若要求预热必须在用户空闲时才做，就要把门槛提到 90s 空闲，等于让第一句继续冷启动。宁可花几秒 CPU |
| **预热成功 ≠ 模型常驻** | Ollama 默认 `keep_alive` 5 分钟，闲置后仍会卸载；再隔很久说话又冷一次 | 应用**不**偷偷设 `keep_alive`（不擅自改外部服务的资源策略）；需要更长常驻请设 `OLLAMA_KEEP_ALIVE` |
| **首问仍可能超时**：预热完成前用户就开口 | 那一轮仍走 `llm_failed{timeout}` → 兜底 | 预热不会取消/排队用户的请求（W-1：不建在途话语）；`getRuntime().snapshot().warmup.warmedUp` 可用于确认"到底热了没"（`lastSkip` 会给出没热的原因） |
| **段 3.5 的应用信息变成"类别"后信息量下降** | 模型不再知道具体是哪个编辑器/哪个网页 | 刻意的方向（ADR 0032 D1）：隐私面更小、token 更省、对 4B 小模型更稳。要加信息就扩规则表，不要回退到原始标题 |
| **归一化是启发式**：`Chrome_WidgetWin_1` 这类通用类名不能用来分类，只能靠标题；标题被应用改得面目全非时（如全屏只显示页面名）会落到 `other:` | 个别应用分类不准 | 规则表顺序与用例都在 `app-normalizer.test.ts` 里锁死；新增规则必须同时补用例。降级仍是可用的（`other: <类名>` 比空更有信息） |

### TODO
- [x] 台词池与规则匹配 + 冷却
- [x] 冷启动预热策略（ADR 0032 D3：1-token `/api/generate`，最多 3 次尝试，不改熔断）
- [x] 预热与主动性解耦 + `model_ready` 前置对齐（ADR 0033：独立生命周期心跳，`PET_PROACTIVE_DISABLE=1` 照样预热，首问不再等 15s 节拍）
- [x] 前台应用名归一化（ADR 0032 D1：`src/main/presence/app-normalizer.ts`，段 3.5 只发类别）
- [x] 主动性可观测（ADR 0032 D4：托盘两行只读诊断，`proactive-stats` 单例）
- [x] 本地 LLM 客户端与 8s 硬超时
- [x] 输出 schema / 枚举校验与兜底
- [x] `user_utterance` → `intent_resolved` / `llm_failed` 接线 + 打断
- [x] 安装 `qwen3:4b` 后真机联调（2026-10-29：健康检查通过、一轮 3.1s；输出被判 `invalid_output`，见已知坑位）
- [x] 真实 LLM 输出的合规化（ADR 0018 D2：提示词约束 + 装饰剥离 + 严格校验；真机 `route=llm` 1.7s）
- [x] 记忆段接入（`memory.retrieve` → 段 ③，≤5 条；ADR 0020）
- [x] 记忆写入接线（`publish()` 之后异步写 user + pet）
- [x] 输入条热键与 `input:'hotkey'` 的真实来源（ADR 0016）
- [ ] 记忆的淘汰/压缩策略（当前只增不删）
- [x] 时间感：段 3.5 环境事实 + 段 3 相对时间（ADR 0030）
- [x] 在场感：`presence` 只读端口（`GetLastInputInfo`，2s 懒采样）（ADR 0030）
- [x] 主动性：idle-drive（规则优先 + 3s LLM，有打扰预算，失败即沉默）（ADR 0031）
- [x] 主动性测试隔离：`PET_SELFTEST=1` 默认硬关，`PET_SELFTEST_PROACTIVE=1` 才开
- [ ] 前台应用类别规则表的可配置化（当前硬编码，扩类别 = 改代码 + 补单测）
- [ ] 主动话语的话题延续（接上一轮话题往下说，而不是每次重新起头）
- [ ] 主动/被动比例的长期统计（托盘已有"本进程"两行读数，但没有跨天累计与历史曲线）

---

## 模块：LLM 提供商（ADR 0055）

### 已完成
- **共享契约**：`src/shared/llm-providers.ts`（纯数据/纯校验，主进程与面板共用）——`LlmProviderConfig`、三种类型、OpenCode Go 预设端点、`sanitizeProviderConfig`、地址/模型/Key 校验、`maskApiKey`、`makeLocalOllamaProvider`。Ollama 仅回环 http；OpenAI 兼容远程仅 https（回环可 http）且禁 URL 内嵌凭证/查询串；OpenCode Go 的 base URL 不可被配置改写。
- **三个客户端**（`src/main/orchestrator/llm-client.ts`）：`OllamaProvider`（原行为：`/api/tags` + `/api/chat` + `/api/generate` 预热）、`OpenAIProvider`（`/models` + `/chat/completions`，Bearer，`response_format:json_object`；`/models` 404/405 时退化为 1-token 对话验证 Key）、`OpenCodeGoProvider`（OpenAI 实现的固定端点 `https://opencode.ai/inference/go/openai/v1`，带 `x-opencode-session` 与自有 User-Agent）。`LLMProvider extends LlmClient`，`createLlmProvider` 唯一分发；`createLlmClient` 保留为本地 Ollama 兼容别名。云端不实现 `warmup`，心跳走 `no-warmup`；远程健康预算至少 5s（本地 Ollama 仍用 800ms）。
- **配置**：`config.json.llm.providers[]` + `activeProvider`；旧的 `llm.model` 仍可读（迁移成本地 Ollama 模型）。运行时**至少追加一个本地 Ollama**；删除最后一个 Ollama 被拒绝。`panel-config.ts` 逐项清洗，坏项只跳过并记一条"被忽略"，不阻断启动。
- **运行期切换**（`runtime.panel()`）：`applyProvider` / `activateProvider` / `deleteProvider` / `testProvider`。换客户端统一走"先建后换 → `orchestrator.replaceLlm`（清零熔断）→ `heartbeat.retarget`（清零预热）"；在途请求用旧提供商说完，下一轮才换。测试结果只存面板内存，不写盘、不改熔断；激活失败仍完成切换（由下一轮兜底/熔断暴露）。
- **可观测**：`RuntimeSnapshot.llm.providerId/providerType/providerName`；`PanelPersonaFacts.llmProvider*`；`PanelStatus.providers`、`PanelResult.providerTest`。日志只记 id/type/name/baseUrl/model 与 `apiKey: 已配置|未配置`，无明文 Key。
- **面板**：提供商列表（名称/类型/模型/地址/Key 状态/使用中/连接测试徽标）、新增/编辑表单（Ollama 模型来自 `/api/tags`，OpenCode Go 端点只读、模型可 🔄 拉取，也允许手填）、使用/测试/编辑/删除；当前生效项连接失败时顶部徽标与列表同时标红。旧"本地模型快速切换"卡片保留，但只改本地 Ollama（远程生效时按钮变"更新本地"）。
- **动态模型列表（ADR 0056）**：`LLMProvider.fetchModels()` 三个实现——Ollama `GET /api/tags`、OpenAI 兼容 `GET {base}/models`、OpenCode Go 固定预设 `GET /models`（Bearer + `x-opencode-session`）；返回 `{id,name}[]`，401/403、404/405、超时/网络错误都给可读 `error`，不重试、不改熔断、不发事件。`src/main/llm-model-list.ts` 负责请求解析、Key 注入安全边界、2s 节流 + 单飞 + 60s 缓存；`runtime.panel().fetchModels()` 只造临时客户端。面板表单改为 `<input list>` + `<datalist>` + `🔄` + 状态行 + chips；失败仍可手填保存。真机手动截图 `npm run panel:opencode`：真实 OpenCode Go `/models` 返回 30 个模型，`logs/evidence/panel-opencode-models.png`。测试：`llm-model-list.test.ts` 12 条 + `llm-client.test.ts` 新增 5 条（Ollama/OpenAI/401/404/OpenCode Go headers）
- **测试**：`llm-providers.test.ts` 8 条、`llm-client.test.ts` 新增 7 条（health/401/404 降级/chat/超时/分发）+ 5 条（fetchModels）、`llm-model-list.test.ts` 12 条、`panel-config.test.ts` 新增 4 条；`panel:shot` 新增 3 + 4 项断言与 `panel-providers.png` / `panel-models.png`。

### 未完成
- 提供商级自动重试/自动切换（§9.1 仍只降级到规则/兜底，不静默换提供商）
- 流式输出、多 Key 轮换
- Key 加密存储（当前按 ADR 0055 明示只存本机 `config.json`）
- 模型清单的自动刷新/搜索/分组/收藏（ADR 0056 D7 明确不做；只在用户点 🔄 时拉取）

### 对外暴露
- `PanelAction` 新增：`providers` / `provider-save{provider}` / `provider-delete{id}` / `provider-activate{id}` / `provider-test{id}`。
- `cmd:fetch-models`（ADR 0056）：面板 → 主进程只读模型列表；载荷 `PanelFetchModelsRequest`，应答 `PanelFetchModelsResult`；preload 暴露 `petPanel.fetchModels`。
- `LLMProvider.fetchModels(request?: { timeoutMs?: number }): Promise<LlmModelListResult>`。
- `PanelProviderFacts` / `PanelProviderTestFacts`（见 `src/shared/panel.ts`）。

### 消费事件
- 不新增事件；提供商切换不产生 `intent_resolved` / `llm_failed`，真实对话失败才走 §9.1/§11。

### 已知坑位
- `config.json` 里 API Key 是明文（威胁模型是本机用户；UI/日志/ADR 均已标注）。
- OpenAI 兼容端点的 `/models` 行为不一致：404/405 会退化到一次 1-token 对话，测试因此可能产生极少量 token 消耗（激活/手动测试时才发生，不会周期性打）。
- 远程端点意味着请求离开本机；只允许用户显式添加的提供商，默认仍只连回环。
- **模型列表失败不等于提供商不可用**：`/models` 401/404/超时只让面板显示红字，用户仍可手填模型名保存；真正的连通性由 `provider-test` / 下一轮对话暴露（ADR 0056 D6）。
- **改 Base URL 后不能沿用旧 Key**：主进程只在 `type` + 归一化 `baseUrl` 都与已保存项一致时注入 Key；地址一改就必须重新输入（防"改地址泄 Key"）。面板会提前显示红色提示。
- **OpenCode Go 的真实 `/models` 已验证端点与响应形状**：2026-11-08 用 `curl` 访问 `https://opencode.ai/inference/go/openai/v1/models`——无 Key 返回 **200**，`data[].id/name` 与解析一致；带无效 `Bearer` 返回 **401**（对应面板红色提示）；带 `x-opencode-session` 返回 **200**。本机没有用户的真实订阅 Key，所以"带有效 Key 成功拉取"由真实端点形状 + `llm-client.test.ts` 的 Bearer/Headers 断言 + `panel:shot` 的本地桩共同覆盖，不声称已用真实 Key 跑过。
- **2s 节流按配置键缓存**：同一配置在 2s 内重复点 🔄 返回上次结果（成功/失败都缓存）；换 Key / 换地址会立即重新请求。缓存 60s 后失效，不会持久化。
- **`npm run panel:opencode` 是手动诊断**：它用真实 OpenCode Go `/models`（无 Key 公开清单）截 `panel-opencode-models.png`；网络不可达时只把错误写进 `panel-opencode-models.json`，不影响默认 `panel:shot` 与任何测试。

### TODO
- 若需要"远程失败自动回退本地"，单独开 ADR（带重试/预算/用户可见性），不要塞进本轮。
- 若要支持"模型清单自动刷新/搜索"，单独开 ADR（ADR 0056 D7 明确不做，避免启动/空闲打远程端点）。

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
- **单测 29 个（`npm run test:memory`，跑在 Electron 的 Node 里；本次由 21 增至 29）**：初始化/迁移幂等、`:memory:` 降级、长词 FTS 命中、短词 LIKE 命中、未命中、注入与通配符、limit 钳制与排序（命中数优先 / 同分新近优先）、持久化（close → 重新 init 等价"重启"）、WAL 并发读、写/读失败降级、非法 kind、事实标签（中/日、否定）、标签参与检索、纯函数（切词/转义/匹配式）、**500 行 × 20 次平均 ≤ 50ms**、管理视图四条（`listRecent` 顺序/上限/无 `score`、`deleteById` 真值与 FTS 同步、`clearAll` 计数与清空后检索为空、未初始化时安全）
- **实测**：500 行库上 5 个查询词轮转 20 次，平均 ≈1–2ms（预算 50ms）；单轮 `retrieve` 在 `logs/pet.log` 里记 `记忆检索 {query,terms,count,ms,fts}`
- **淘汰策略（2026-10-31，ADR 0025）**：`prune()` 按 `at ASC, id ASC` 删除超出 `MEMORY_MAX_ROWS=2000` 的行，单次最多 `MEMORY_PRUNE_BATCH_MAX=200` 行（最坏耗时锁在毫秒级）；`write()` 之后用 `setImmediate` 排期，不阻塞调用方；FTS5 是 external-content 表，`AFTER DELETE` 触发器自动同步索引（单测直接数 `memories_fts` 行数验证）。`snapshot().lastPrune` 暴露最近一次的 `{at, deleted, rows}`
- **管理视图（2026-11-06，ADR 0053）**：新增 `listRecent(limit)`（时间倒序，返回 `MemoryRecord` = `id/at/kind/text/tags`，不含 `score`；`limit` 默认 20 / 上限 50）、`deleteById(id)`（返回是否真的删到；FTS 索引随触发器一起删）、`clearAll()`（返回删除行数，连 FTS 一起清空）。三者都**同步**、只由主进程控制面板经 `runtime.panel()` 调用；`memory.test.ts` 新增 4 条（列表顺序与上限、按 id 删除与不存在 id、清空后 `rows=0` 且 FTS 无残留、`:memory:`/disabled 模式下行为安全）

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
| `listRecent` | `listRecent(limit: number): MemoryRecord[]` | 契约 §7.5（ADR 0053）：管理视图，时间倒序、不含 `score`；只由控制面板经 `runtime.panel()` 调用 |
| `deleteById` | `deleteById(id: number): boolean` | 契约 §7.5（ADR 0053）：返回是否真的删到；FTS 由触发器同步 |
| `clearAll` | `clearAll(): number` | 契约 §7.5（ADR 0053）：返回删除行数；"让她失忆"的唯一入口 |
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
| 掩膜坐标系在窗口缩放/DPI 变化时的重建时机 | shell、render | **已解决（ADR 0057 D2.5）**：整体缩放改窗口尺寸 → 浏览器 `resize` → `render-module.resize()` 重建掩膜 RT（`maskSizeFor()`，128×72 × 缩放、夹 0.5–2x）、作废旧包围盒、下一次 probe 立刻重采；CSS → 掩膜映射一律用**当前帧实际尺寸**。DPI 变化仍由同一路径覆盖（内容区尺寸变了就重建） | —（已解决） |
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
| 2026-11-07 | shell、orchestrator、全局 | **视觉查询（截图 → OCR → 段 3.6）**（ADR 0054）：① 新增 `shared/vision.ts`（`VisionContext` / `VisionResult` / `VisionSnapshot`）与 `src/main/vision/`（`capture.ts` 平台注入的 desktopCapturer 截图、`vision-service.ts` OpenAI 兼容 OCR 客户端 + CJK 空格归一化、`vision-controller.ts` 单飞/TTL/诊断）；② `config.ts` 新增 `vision`（`PET_OCR_*` / `PET_VISION_*`，`requireLoopbackUrlWithPath` 保留 `/v1`，仍只允许回环 http）；③ `orchestrator.replaceVision` + 段 3.6（≤600 字、数据非指令、只有 LLM 路径消费、过期丢弃）；④ `cmd:vision-query` + 热键 `Ctrl+Shift+V`（降级 `Ctrl+Alt+V`）+ 输入条按钮 + `bootstrap` 的 `attachVisionBackend`；⑤ `runtime.snapshot().vision` 与 `Runtime.vision()`；⑥ 单测新增 `vision-service`（5）、`vision-capture`（5）、`vision-context`（4）与 config 2 条；`npm run selftest:vision` **16/16 全过**（真 Windows OCR 桩，证据 `logs/evidence/vision-chain.json` + `vision-capture.png` / `vision-reply.png` / `vision-desktop.png`）。**未新增事件、状态、`intent`、`emotion`、`RenderState` 字段** | 1.31.0 |
| 2026-11-02 | 全局 | **封版 `v1.1.0-visual-final`（M15 视觉完全体）**：视觉侧三件套槽位封闭 —— ① ADR 0037 全局光照 + 身体/头发 3 阶硬边 Toon（受光面 = 贴图原色，`ambient+directional=π`）；② ADR 0038 背面法描边（共享几何/骨骼、屏幕像素宽度 1.5 / 头发 0.8、深褐 `0x2a1b1a`、`smoothstep` 规避楔形黑块）；③ 面部与光环死守无光照（光环吃光实测变"脏塑料"，见 ADR 0038 D6）。**封版验收**：`npm test` 全绿（含 memory 25/25）、四套自检 **136 / 29 / 30 / 4** 全 exit 0、`tsc --noEmit` 0 错。**所有者拍板**：宽度与颜色不再调；"合并材质外壳消除头发叠线"明确不做（性价比低、易破坏模型，留在 TODO）；官方表情差分随缘。0 新依赖 / 0 新 pass / 0 按次计费调用 | 1.15.0 |
| 2026-11-02 | render、全局 | **背面法描边 + 光环定论（ADR 0038）**：① 新增 `outline.ts`：`applyOutline(mesh)` = 克隆同一几何（`SkinnedMesh.copy()` 共享 `Skeleton`）+ `ShaderMaterial{side:BackSide}` + 顶点里 `#include <skinning_*>` 后按视空间法线外扩；`OutlineSet` 负责装配/开关/诊断/销毁。**宽度按屏幕像素**（身体/脸 1.5、头发 0.8）——模型单位 0.003 在本资产等于 172px，已实测否掉。② 范围：Body/Hair/Face 描边；EyeMouth/Eyebrow/Halo/配件不描。③ 两个实测修正：`viewNormal.xy` **不能归一化**（否则正对镜头的面被噪声放大成楔形黑块），改 `smoothstep(0.02,0.30,len)`；头发卡片会叠线，单独降到 0.8px。④ **光环对照定论：保持 `MeshBasicMaterial`**（亮度 198.2→193.0、暗像素 13.2%→16.7%，观感变"脏塑料"），`setHaloToon` 只作诊断。⑤ 诊断：`RenderDiagnostics.outline`（含 `tracked/matrixDelta`）与 `render`（calls/triangles/frameMs）；`PET_OUTLINE_DIAG=1` / `PET_HALO_DIAG=1`，A/B 用 16×16 缩略图做姿态对齐。**实测**：draw call 7→10、帧时间 EMA 16.7→16.7ms、`matrixDelta=0`（不穿模不滞后）。契约 **1.15.0**（§7.3 描边规则表、§11 降级行）。单测 +6（outline）、`tsc` 0 错、主链路自检 **136/136**、输入条 29 / 语音 30 / 缺失模型 4 均 exit 0；0 新依赖 / 0 新 pass / 0 新 IPC / `RenderState` 未增删字段 | 1.15.0 |
| 2026-11-02 | render、全局 | **资产审查 + 全局光照 / Toon（ADR 0037）**：① 新增只读工具 `tools/audit-glb-assets.mjs`（自带 PNG 解码、按通道统计、判定 Mask/Ramp、统计 `COLOR_0` 直方图并按骨骼归类）：实测 **8 张贴图全是 RGBA8 颜色图、10 个材质只有 baseColor 槽、无 Mask/Ramp、无第二套 UV**；`COLOR_0` 的 **RGB 是常量、alpha 才是数据**（8bit 量化值，`Eyebrow`/`EyeMouth` 恒为 0 → 绝不能接进 alphaTest）。② 新增 `toon-shading.ts`：主方向光（2.6，斜上方偏左前）+ 极低环境光（0.55），**`ambient+directional=π`** 让受光面等于贴图原色；代码生成 **3 阶** `DataTexture` 色阶（32×1 / NearestFilter / NoColorSpace，`dot≤0.12→0.58 / ≤0.38→0.80 / >0.38→1.00`）；只替换 `CH0335_Body` 与 `CH0335_Hair` 为 `MeshToonMaterial`（显式 `vertexColors:false`）。③ **面部死守**：`Face`/`EyeMouth`/`Eyebrow*` 正则双重排除，永不参与。④ **ADR 0036 的手部顶点色烘焙整体废止**（删 `skin-shading.ts` / 单测 / `setSkinBake` / `shadeSkin` / `setShading`），`dominantBoneNames`/`matchesSkinBone` 迁入 `material-diagnostics.ts`。⑤ 诊断 `RenderDiagnostics.skin` → `toon`；`window.diagnostics.setToon(bool)`；`PET_TOON_DIAG=1` 连拍 before/after 并取脸部统计最接近的一对。**A/B 实测**：外套近白 38.6%→30.6%、左手 35.1%→19.3%、全身亮度只降 4.2%（不灰）。契约 **1.14.0**（§7.3 着色规则表、§11 一行降级）。单测 +6（toon）/ −6（skin）、`tsc` 0 错、主链路自检 **131/131**、其余三套 exit 0；0 新依赖 / 0 新 IPC / 0 新事件 / `RenderState` 未增删字段 | 1.14.0 |
| 2026-11-01 | render | **真机 bug：坐姿时头疯狂打转**（ADR 0029）。二分结论：不是视线（提交的 yaw/pitch 只有 ±0.2 rad）、不是 `HaloRoot` 挂载（GLB 层级里它与骨架平级、只写 position）、不是 `playHold` 重入（`time` 恒为 2.3s）、不是窗口抖动。根因是骨骼仲裁的基底判定依赖"骨值 = 我上次写的值"，而 three 的 `PropertyMixer.apply()` 在**停帧**后会跳过冗余写入 → 误判成"动画写了" → 每帧把偏移叠在上一帧结果上（实测 2.51 rad/s）。修法：`arbiter.capture()` 在 `mixer.update()` 前快照受控骨骼，`beginFrame()` 用"这中间变没变"判定；阈值 1e-8 → 1e-6；新增 `baseFrom`/`applied` 诊断与 `headQuat/headWorld/headBase` 字段。修后 1s 漂移 **0.000 rad**；新增单测 `bone-arbiter` 4 条、自检 +1 条（头骨不漂移），主链路 **119/119** | 1.9.0 |
| 2026-11-01 | shell、render、全局 | **前台窗口吸附 + 坐姿**（ADR 0028）：① shell 新增 `foreground-window.ts`（`koffi` → `GetForegroundWindow` + `DWMWA_EXTENDED_FRAME_BOUNDS`，退路 `GetWindowRect`；物理像素 → `screen.screenToDipPoint` 逐点换 DIP）、`snap-geometry.ts`（纯几何：边缘线 + 居中 + 整窗可见夹取 + 竖直 >40px 拒绝 + 覆盖式全屏判定）、`snap.ts`（控制器 + 跟随节流 120ms + 8 种拒绝 + 五条解除路径）；热键 `Ctrl+Shift+S`（降级 `Ctrl+Alt+S`）与托盘两项；无 `koffi` 时回退"工作区贴边"。② render 新增 Physics=`sitting`（`snapApplied/snapReleased`）、`playHold` 停帧播放、`clip-bank` 的 `sit` 角色（回忆片段 11.2–13.5s）、`sit-pose.ts`（呼吸 + 程序化降级）、坐姿身体平移补偿与**光环跟随头骨**。③ 修 bug：占位胶囊体位置双重偏移（缺失模型自检 4/4）。契约 **1.9.0**（§4.1 `sitting`、§5.1/§5.3、§6.3 两条事件、§7.1/§7.2/§7.3、§11 四行、§12、§13 X-10/X-11）。单测 **287**（28 文件，+15）、`tsc` 0 错、主链路自检 **119/119**（+22）、输入条 27 / 语音 30 / 缺失模型 4 套均 exit 0；截图 `window-sitting.png` + `window-sitting-desktop.png`（桌面合成） | 1.9.0 |
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
| 2026-11-01 | orchestrator、memory（段 3 格式）、新增 presence、全局 | **时间感 + 在场感 + 主动性**（ADR 0030 / ADR 0031）：① `presence.ts`（`GetLastInputInfo`+`GetTickCount` 取系统空闲，`GetForegroundWindow`+`GetWindowTextW/GetClassNameW` 取前台；**2s 懒采样、无定时器**；koffi 缺失即 `userIdleMs:null`）；② `buildPrompt` 新增可选 `world`，段 3.5 `環境: … / 先生は …前まで入力中 / 前面のアプリ: … / 前回の会話から …`，缺省与 1.9.0 逐字节一致；③ 段 3 改相对时间（`[3日前]`）+ 同 tags 三字组 Jaccard ≥0.8 去冗余 + 360 字预算（**排序规则未改**）；④ `idle-drive.ts` 纯函数判定 + orchestrator 15s 节拍：`userIdle ∈ (90s, 5min)`、gap >90s、每次 ≥10min、每会话 12 次（深夜 6）；先 `lines.json` 的 `on:'idle'`（新增 4 条日文台词）再 3s LLM；**失败完全沉默**、**进历史但不写 `memory.db`**、**只在已健康检查时用 LLM**；⑤ `PET_SELFTEST=1` 默认硬关 + `PET_SELFTEST_PROACTIVE=1` 才开 + `PET_PROACTIVE_*` 阈值覆盖。契约 **1.10.0**（§2/§2.1/§3.1、§9.3 段 3.5、§7.5 段 ③ 格式、§7.6 PR-1…PR-7、§11 四行、§12 两行）。单测 **+40**（orchestrator 19→27、world 13、idle-drive 14、presence 7、proactive-config 9）、`tsc` 0 错、主链路自检 **120/120**（+1 条主动性闸门）。**真机两处发现**：`GetTickCount` 不在 user32 导出表；`gap` 以 `sessionStartedAt` 为基准会导致"启动即已离开"时永不开口（已修为以最后一次输入为基准）。真机观察：22:30:00 规则 `idle-check` 主动开口 → `intent_resolved{route:rule}` → TTS 未启动按 §11 降级为字幕 | 1.10.0 |
| 2026-11-01 | render、全局 | **编码事故与重建**（ADR 0027）：用 PowerShell `Get-Content/Set-Content` 临时改行，GBK 解码把 `render-module.ts` 变成乱码并吃掉换行（305 个语法错误，编码不可逆）。当时**没有 git**、`dist` 被 `rm -rf` 清空、无编辑器历史/卷影副本 → 只能重写。① 先建 git（`f653cd3` 事故基线、`8dc450a` 重建）；② 分三轮重写 `render-module.ts`（骨架与加载 / 动画视线交互 / 口型贴花）；③ 新增 ADR 0027（禁止 shell 文本往返、强制 git、破坏性实验走副本）；④ ADR 0026 补 **D7 官方线稿贴花层**（`face-decal.ts`：头骨下的深度测试平面，贴图由 `FX_TEX_CH0335_Img_Face_01.png` 按连通域裁出）。验证：`tsc` 0 错、单测 **272**（25 套件）全绿、自检 **97/97**（连跑两次，其中一次仅 shell 侧"冷却拦下"日志断言偶发，属既有 flaky） | 1.6.0 |
| 2026-11-01 | render | **移除多余贴花，回归官方动画眨眼**（ADR 0026 D7 否决）：实测 `Cafe_Idle` 在 t≈2.5s 用**眼皮骨骼平移**（`bone_eye_D_L/R` 的 `translation.x` 0.000262→0.000435，0.3s 回落）完成眨眼。此前自建的「遮罩 + 线稿」贴花层多余且每帧写 `applyBlink(0)` 覆盖了动画——这是"看不见眨眼"的真正原因。① 删除 `render-module` 里的贴花接线、眨眼计时器、眼骨缩放、`PET_DECAL_DEBUG` 调试通道；② `face-decal.ts` 保留为储备，默认不创建、不加载贴图；`DECAL_FACE_FILES` 移出 `EXPRESSION_FILES` 白名单，任何代码都不再读取；③ 嘴型换用官方高清图集 `Character_Mouth_High-BgFqI_9W.png`（2048²/8×8=64 帧）；④ 表情嘴型改用图集帧，不再用 Canvas 图元；⑤ 自检 fixture 默认关闭（`PET_SELFTEST_FIXTURES=1` 才启用），截图=真机效果。**教训：先查动画，再做渲染；不要写动画拥有的骨骼** | 1.6.0 |
| 2026-11-02 | shell、render、全局 | **拖拽生命感 + 吸附接近**（ADR 0034 / ADR 0035）：① 拖拽：渲染侧 `noteGrabPoint` 按骨骼最近点分类 head/body/foot（缺失退回掩膜 bbox），`drag-motion.ts` 受迫单摆（窗口 `screenX/Y` 两级 EMA 求加速度）+ 绕抓取点 `pivotCompensation` + 松手 θ/ω 衰减；落地按 `vDownMax` 分级做 `scale.y` + 脊柱/膝/臂下蹲，脚底不穿窗口。② 吸附：新增 `snap_approach_started`（契约 §6.3），`sitting` 扩展为"接近 + 落座"生命周期；`approach.ts` 纯函数（walk/leap、300–900ms），倒计时挂在既有 16ms `snap.tick`，`t>=1` 才 `commit` + `snap_applied`；只有拖拽能立即中断，其余解除延迟到到达。③ 坐姿：`snap_applied` 才 `playHold('sit')`，视线继续跟随；`snap_released` 按 clicked/command/window-gone/fullscreen 播惊跳。④ 骨骼标定：`window.diagnostics` + `PET_CALIBRATE=1` 13 张截图，确认 spine/neck pitch>0=低头、upperArm roll<0=抬手、thigh pitch<0=前抬、calf pitch>0=后摆；`ModelBones` 6→21 根。⑤ 落地标定：`PET_LANDING_CALIBRATE=1` 10px/300px 两张截图（impact 0.00/1.00，squash 0/0.078）。契约 **1.13.0**；单测全绿、四套自检 **127 / 29 / 30 / 4** 全 exit 0；`tsc` 0 错；0 新依赖 / 0 新定时器 / 0 新 IPC 通道 | 1.13.0 |
| 2026-11-03 | shell、render、全局 | **摸头改官方片段 + 拖拽/摸头严格互斥**（ADR 0039）：① **全量普查 44 段动画**——新增 `tools/clip-preview/census.cjs`（按 0.2s 采样头/骨盆/双手/双脚世界坐标 + 头骨欧拉角，输出 `shots/census.json`）与 `inspect-census.cjs`（逐帧表格）、`list-clips.cjs`（只读 GLB 列出 44 段），并用 `filmstrip.cjs`（改为 `FILM_JOBS`/`FILM_CLIP` 环境变量驱动）目视复核。结论：`Cafe_Reaction` 3.2–6.4s 只有"缩下去"没有回正（剪到哪都停在含胸姿态）；`Victory_Start_interaction_01` 首帧是腾空翻滚过场；**唯一闭环**是 `Victory_Start_Random` 0.4–2.2s（站姿 → 缩身抱手低头 → 保持 → 抬头回正）。② `clip-bank.pat` 改绑 `CH0335_Victory_Start_Random` 0.3–2.4s，`Cafe_Reaction` 只留 `greet`。③ **删除 `pat-react.ts` + 其单测**（build.mjs / package.json 同步），render 里的摸头头部 pitch/roll、身体前倾、`'pat'` 嘴层归属全部移除——摸头不再有任何程序化姿态或 `scale`；`nod` 也从"整身压扁 6%"改为"头骨低头 0.26rad"。④ 表情改为 `effective emotion = shy`（官方差分），`MouthOwner` 收敛为 口型 > 表情 > 静态。⑤ **严格互斥三层**：HFSM 在 `dragStarted/dragReleased` 清 `reaction` 且 `dragged` 也拒绝 `head_patted`/`intent`；render 在 `drag_started` 先 `cancelOneShot()` 并拒绝 settling 期事件；shell 新增 `patArmed`（一次拖拽解除到下次 pointerdown）与 `movedWindow`（按下期间窗口被搬过就不判摸头、且不伪造拖拽）+ 轮询器沉降窗口丢弃。⑥ §5.3 三行改为"身体通道不动、只表情"。契约 **1.16.0**（§3.4 D-2/D-3、§4.4 `pat_react`、§5.3 三行、§7.3 摸头规则、§11 降级行）。验证：`tsc` 0 错、单测 **433**（含新增 6 条互斥用例，删除 `pat-react` 4 条）、四套自检 **140 / 29 / 30 / 4** 全 exit 0、截图 `window-pat.png`（缩身害羞）/`window-drag.png`（被拎起）；证据 `dist/selftest/evidence-{pat,drag}-adr0039.png` | 1.16.0 |
| 2026-11-03 | shell、render、全局 | **头部判定换基准 + 落地收平**（ADR 0040）：① **排查打点**：shell 侧 `[drag-gesture] pointerdown/pointerup/emit head_patted?`、render 侧 `收到 head_patted + HFSM 状态`、`摸头片段回报（weight/paused/hold）`、`probe … boneY/radius/dist`、`回弹触地反跳 {vyBefore,vyAfter}`；新增 `tools/diag/log-shot.py` 把日志渲染成图（UTF-16LE 的 Tee 输出也能读）。② **根因 1**：`cmd:interactive.head` 用"掩膜 bbox 顶部 22%"，光环把 bbox 顶到 y≈90–120 → 头部带只有 **y≈120–275**（光环+发顶），脸在 **y≈340–420**，实测点脸 `blockedBy=head-not-in-band`、一轮运行 0 次触发。改为**头骨半径**（`0.125×720=90px`，圆心=头骨 CSS 位置），光环落在圆外，骨骼/掩膜缺失时退回 bbox 22%，都不可用才 `head=null`。③ **根因 2**：落地 `impact=(vDown−150)/1000` 用 settling 峰值 → 自由落体必然饱和（实测 1500–1716px/s）→ 每次拖拽压满 8%，再叠 `restitution 0.28` 的窗口反跳（948→−169、2137→−491），看起来就是"弹一下/被截断的摸头"。改为冲击只看 `drag_released.vy`、门槛 700、上限 3%、时长 220ms、恢复系数 0.15。④ 自检点位改"头骨 + 1%"，新增 3 条口径断言 + 3 条验收（点脸触发/点光环不触发/轻放不缩）+ 2 张落地帧截图。契约 **1.17.0**（R-10、D-1、`cmd:interactive`、§7.3 落地缓冲规则）。验证：单测 **433**、四套自检 **147 / 29 / 30 / 4** 全 exit 0、`tsc` 0 错 | 1.17.0 |
| 2026-11-03 | shell、render、全局 | **表现力四问：拖拽一致 / 摸头衔接 / 片段利用率 / 坐姿吸附**（ADR 0041 / ADR 0042）：① **拖拽解耦**——`clip-bank` 删除 `held.limp`（`Carrier_Idle` 是普通站姿，正是"拖头不触发官方动画"的根因），任何抓取带都播官方悬空片段 `Formation_Pickup`（从第 0 秒起，每次抓起都有"被拎起"的起势）；抓取带只决定单摆物理。**删除** `dragBoneOffsets()`（12 根骨的三态手写姿态）、`DRAG_PENDULUM[*].liftPx`、render 的骨骼叠加与 `dragLift`。② **摸头收尾**——根因是 `finished` 固定回 `idle` 槽位（待机姿态会轮换 → 抱臂被淡成普通站姿），改为回到 `oneShotReturnAction`；窗口 0.3–2.4s → **0.3–2.05s**、淡出 0.25s → **0.45s**。③ **片段利用率**——语义角色 13 个：新增 `idle.alt2`(`Carrier_Idle`) / `idle.alt3`(`Victory_End_Random`) / `nod`(`Cafe_Reaction` 8.7–9.9s 鞠躬) / `fidget.shy`(3.2–4.9s 掩面)，待机轮换 2→4 段，新增 45–95s 一次的空闲小动作（纯根节点转圈 1.7s / 官方害羞片段），fidget 不进 `RenderState`、不是新状态。**资产事实**：`Carrier2_*` 与 `Cafe_*` 是同一份数据、四段 `*_interaction_*` 根骨偏 128–190px、没有挥手/伸懒腰片段。④ **坐姿吸附**——`snap_applied` 后 240ms 半蹲过渡（+14px→0、大腿 0.22rad→0）；坐姿窗口 11.2–13.5s → **13.4–15.6s**（睁眼、手放膝上）并按 `holdSeek` 停帧标定补偿；`snap.tick` 跟随加**追赶模式**（目标一变就每拍重算 220ms）；`window-gone`/`fullscreen` 后用回弹弹簧落回桌面（不伪造冲击速度）。⑤ **自检**：修掉"光环命中点只探中线"的 50% 假失败；主链路 147→**156**、单测 433→**446**、四套 selftest 全绿 |
| 2026-11-04 | render、全局 | **真机三问：开局转圈 / 坐姿假人 / 落座乱平移**（ADR 0043）：① **启动冷却** —— `fidgetAt` 初值 0 → `+Infinity`（安全冷却），`updateFidget` 在模型未就绪时直接 return，排期改成纯函数 `nextFidgetAtMs(now, startedAt) = max(now + 45–95s, startedAt + 45s)`；实测冷启动 49s 才出现第一次小动作。② **坐姿活体化** —— `clip-bank.sit` 由 13.4–15.6s 停帧改为**循环 14.5–14.92s**（普查确认接缝 1–2px）；`animation-controller` 支持循环角色裁窗口 + `playRole(slot=null)` + `roleWeight()`；再叠 ±2.4px 呼吸浮动、±0.5% 躯干缩放、±1.6px 重心偏移。③ **补偿平滑** —— 新增 `updateSitGain()`：补偿/下沉/呼吸/重心全部乘"坐姿片段混合权重"，落座瞬间不再硬套 265px；接近阶段不再应用补偿。逐帧实测 `headWorld.x` 最大跳变 4.9px、`offsetX = raw × blend`。④ 自检新增 4 条（循环播放 / 补偿缩放 / 呼吸微动 / 落座连续）+ 落座逐帧取证 12 帧；单测 446→**451**、主链路 156→**160** |
| 2026-11-04 | render、全局 | **坐姿活体化：停帧 + 全程序化微动**（ADR 0044）：① **停帧**——`clip-bank.sit` 14.5–14.7s、`loop:false`、`playHold`（0.42s 循环真机判"抽搐"，ADR 0043 D2 废止）；② **呼吸**——3.6s 正弦，整体 ±0.9px + 脊柱/颈 ±0.006rad（旧的 2.4px 浮动与 0.5% 躯干缩放全删）；③ **自主张望**——坐姿期间关闭 `gaze.update()`，3–6s 随机 ±0.3/±0.15rad，阻尼缓动；④ **眨眼**——2.5–5s，`bone_eye_D_L/R.translation.x` = 0.00028（虹膜覆盖 2.8%→0.26%），110/50/180ms 包络，新增 `bone-arbiter.addPosition()`（与旋转同一套"检测 mixer 重写"，防位移累积）；⑤ **晃腿**——左右交替、只往抬的方向（`0.5-0.5cos`），±0.08rad，600ms 软启动；⑥ **顺带修** `roleWeight` 的"暂停=没播"bug（否则补偿消失、人被推出窗口）；⑦ 新增 `sit-motion.ts`（10 单测）+ `role-weight.test.ts`（2 条）+ 主链路 6 条自检 + 3 个取证工具（`measure-blink.py` / `compose-sit-alive.py` / `compose-sit-sheet.py`）。单测 446→**463**、主链路 160→**165** | ADR 0044 |
| 2026-11-04 | render、voice、全局 | **真机四问：开局转圈 / 坐姿低头 / 上半身僵硬 / 嘴型**（ADR 0045）：① **删转圈**——`fidget` 只剩官方 `shy` 片段与排期，片段缺失时什么都不做（`spin` 整体删除，诊断 `kind` 收窄为 `'shy'`）。② **头部基准**——新增 `sit-head.ts`（相对**绑定姿态**的旋转差 → YXZ 抵消量 / 世界朝向分解），`playHold` 权重 ≥0.95 时用 `BoneArbiter.animationBase()` 量一次，之后每帧 `+delta⁻¹ × 包络`；实测片段自带低头 **+0.263rad**、抵消 **-0.250rad**，抵消后头骨均值从"低头 15°"回到 **-0.03rad（平视）**。张望改 **2.2–4.2s / ±0.36rad / 72% 抬头 / easeInOutCubic 220–420ms**（废止指数阻尼）。③ **上半身与腿**——锁骨/上臂 ±0.02rad（相位差 90°）；晃腿 0.17rad、小腿 0.136rad（×0.8），左腿速度 ×1.05、右 ×0.95、幅度 0.9、包络幂次 0.66/0.82、膝盖滞后 0.32rad。④ **嘴型**——`MOUTH_FRAME_CLOSED` 0 → **7**，`drawAtlasFrame` 静态帧必须传真实帧数（新增纯函数 `atlasFrameIndex()`），口型改**四档元音**（7 / 6·14 / 1·3 / 2·9）+ 档内 180ms 轮换；自检实测说话中嘴型序列 `7→1→3→2→9`。⑤ 顺带修 `sit-motion` 的 NaN 传播（随机源统一 `sampleUnit()`）。契约 **1.21.0**；单测 **495 / 0 失败**（新增 `sit-head.test.ts` 4 条、`sit-motion` 扩到 10 条、`speech` 口型 5 条、`facial-texture` 静态帧 1 条）；四套自检 **168 / 29 / 33 / 4** 全 exit 0；`tsc` 0 错；0 新依赖 / 0 新定时器 / 0 新 IPC 通道 | 1.21.0 |
| 2026-11-05 | render、voice、全局 | **真机截图三问：死鱼眼 / 翻白眼 / 嘴型与侧坐**（ADR 0046）：① **眼球接管**——片段里眼骨自带向下看（实测 **+0.262rad**），停帧后永不消失。新增 `BoneArbiter.overrideBase()`：坐姿把眼骨旋转基底换成**绑定姿态**再叠张望 ×0.35；实测接管后眼球俯仰均值 **-0.14rad**、与头骨朝向差 <0.2rad（不再死盯地面）。② **删除手写眨眼**——`addPosition()` 与整条位置通道、`sit-motion` 的 blink、`debugBlink`/`forceBlink` 全部移除（停帧下推下眼皮 = 翻白眼）；**坐姿不眨眼**，站姿仍用官方 `Cafe_Idle`。③ **微侧身**——`SIT_BODY_YAW_RAD=0.15` 加在根节点，头部基准用 `removeBodyYaw()` 在未侧身坐标系里量。④ **嘴型**——`MOUTH_FRAME_CLOSED` 7 → **0**（平直细线）、`staticFrameIndex=0`、`mouthWidthRatio 0.24→0.32`；表情帧重映射 `smile=7 / frown=8 / small=0 / open=2`（`small=9` 是大圆张口，正是"常驻微张"）。契约 **1.22.0**；单测 **493 / 0 失败**（bone-arbiter 6、sit-motion 9、speech 5、facial 29）；四套自检 **169 / 29 / 33 / 4** 全 exit 0；`tsc` 0 错；0 新依赖 / 0 新定时器 / 0 新 IPC 通道 | 1.22.0 |
| 2026-11-05 | render、全局 | **待机重构：删除空闲 shy + 七个正面静态站姿轮换**（ADR 0050）：① **删除** `fidget.shy`（`Cafe_Reaction` 3.2–4.9s 掩面缩身）、`fidget.ts` 调度模块、`RenderDiagnostics.fidget` 与"启动后 45s 冷却"整套机制；空闲路径不再引用 `Cafe_Reaction`，同时消除换姿势时"手绕着手腕突然垂下"的扭曲（片段过渡被淡入截断所致，不再触发）。② **新增** `idle-variation.ts`（纯逻辑）：44 段筛出 **7 个正面静态循环待机**（`Cafe_Idle` / `Formation_Idle` / `Carrier_Idle` / `Victory_End_Random` / `Carrier2_Idle` / `Victory_End` / `Formation_Idle_Random`），每 **20–45s** 抽一个非当前且可用的角色，`playRole(..., 0.8s, 'idle')` 交叉淡入；间隔/淡入常量集中在 `shared/constants.ts`。③ **上下文门**：拖拽 / 坐姿 / 行走 / 说话 / 一次性演出期间不换；到点不满足则从恢复时刻重新计时；片段缺失只跳过候选，不回退程序化。④ 呼吸（片段自带）与视线（`gaze.ts` 三层阻尼）不换轨；顺手补 `IDLE_MICRO_POOL` 漏掉的 `speaking` 门。⑤ 自检新增 8 条（生产常量 / 候选池 / 压缩抽签 / 无 `Cafe_Reaction` / 中段权重证明交叉淡入 / 7 张站姿截图 / 交叉淡入 4 帧 / 角色表 ×7），主链路 **189/189**、`npm test` exit 0、`tsc` 0 错；截图 `idle-pose-00..06.png`、`idle-crossfade-00..03.png`；另修掉 `clicked` / `window-gone` 两条瞬态 `startle` 假失败（改为同时接受渲染侧稳定日志）。**未新增/删除状态名、事件、`intent`、`emotion`、IPC 通道、模块接口方法或 `RenderState` 字段** | 1.27.0 |
| 2026-11-05 | render、全局 | **坐姿两段式 + 临界阻尼下坐 + 看镜头**（ADR 0051）：① **窗口** 14.5–14.7 → **14.2–16.2s**；阶段 A（14.2–16.0）正放官方"坐下 + 第一次张望"（14.95s 头部 0.253rad 转头），阶段 B 16.0–16.2 停帧。② **覆盖** 0.3s `easeInOutCubic` 淡入站立上半身，`upperBlend = stageBBlend × sitGain × sitDrop`；覆盖链三根 → **下背/胸/颈/头四根**，采集改到 `beginFrame()` 后用 `animationBase()`（不读含视线偏移的 `bone.quaternion`）；实测 `headOrientation.pitch` **0.59 → 0.0102rad**。③ **下坐弹簧** `sit-drop.ts`（k=180 / c=26.8 / 1/240s 子步长 / dt≤0.05s），`sitDrop` 0→1，所有补偿/侧身/覆盖乘 `sitGain × sitDrop`。④ **看镜头**：张望 1/3 概率 `camera`（yaw/pitch=0），其余随机；过渡 800–1200ms、到位静止 ≥2s。⑤ 自检新增 6 条（A 无覆盖 / B 0.3s 到 1 / 16ms 头部步进 <0.15rad / 弹簧无过冲 / A/B 截图 / targetKind=camera）；主链路 **189→195**、`npm test` exit 0、`tsc` 0 错。**0 新依赖 / 0 新定时器 / 0 新 IPC / `RenderState` 未增删字段** | 1.28.0 |
| 2026-11-06 | render、全局 | **坐姿手感标定 + A/B 封版**（ADR 0051 D7）：① 新增 `SIT_PHASE_A_HEAD_TUNE_RAD`（默认 **0**）——阶段 A（14.2–16.0s）头骨俯仰按 `sitPoseGain × (1 − stageBBlend)` 淡入淡出，负值 = 抬头；② 新增 `SIT_SPINE_OVERLAY_WEIGHT`（默认 **1.0**）——只乘下背 `Spine` 的覆盖权重（0.85 = 保留 15% 片段前倾），胸/颈/头仍是完整 `upperBlend`；③ 诊断 `sit.{phaseAHeadTuneRad,phaseAHeadAppliedRad,spineOverlayWeight,spineOverlayApplied}` 与 `sitSequence()`，**未新增状态/事件/IPC/接口方法/`RenderState` 字段**；④ A/B 两组（0/1.0 与 -0.12/0.85）各跑 `tsc` + 主链路自检，均 **198/0**；自检新增"A/B 特写已产出"1 条，产出 `sit-ab-stage-{a,b}.png` 与对比图 `logs/evidence/sit-ab-compare.png`（`tools/compose-sit-ab.py`）；⑤ 本轮 `npm test` **525/0**（52 文件）、四套自检 **198 / 29 / 33 / 4** 全 exit 0，封版 `v1.7.0-sit-final` | 1.28.1 |
| 2026-11-10 | render、shell、全局 | **坐姿退场残留 / 坐姿眯眼 / 整体缩放**（ADR 0057）：① **退场交接**——`BoneArbiter.overrideBase()` 是每帧持续写的，旧实现权重归零后从不放手，头/胸/颈/下背/眼球被永久冻在坐姿上（真机"站起来走路上半身拧着、头随光标抽搐"）。新增 `sitUpperExitBlend()`（0.3s `easeInOutCubic`）+ `updateSitUpperHandover()` + `finishSitExit()`：`sitUpperWeight` 成为唯一的上半身覆盖权重，收到 0 时显式 `overrideBase(null)`/`overridePosition(null)`（上半身 4 根 + 眼睛链 12 根）、清弹簧/增益/侧身、`sitMotion.reset()`、`sitPool.flush()`；`exitSit` 与 `drag_started` 两条入口都开交接；片段淡出 0.35 → 0.28s。② **残留权重**——`animation-controller` 新增 `fadeOutOthers()`，`playHold` / `playOnce` / `finished` 也会清掉"半途的第三个 action"（旧实现只有 `fadeTo` 会）。③ **眼睛照抄站立**——第一版只还原眼皮 x（0.00033 → 0.00027），真机 A/B 几乎无变化；逐轨对照 GLB 后改为覆盖**整条眼睛链 12 根**（`eye_L/R` 卡片被片段平移 ≈9px、`eye_*_1/_2` 各转 ≈8.8°/5.1°、眼皮链 `bone_eye_D_*_01/_02`），三份快照（绑定 / 站立待机 / 阶段 B 起点）+ `slerp`/`lerp`；`overridePosition()` 为新增的绝对值位置覆写通道；`model-loader` 增 8 个眼睛链骨骼槽位。④ **整体缩放**——控制面板新增 `view.scale`（0.5–2.0，默认 1.0）；`shared/window-scale.ts` 唯一几何（等比 + 底边中心锚点不动 + 工作区夹取 + D-7 兜底）；主进程 `applyViewScale()` 走 `setBounds`，启动按 `config.json` 首帧生效；渲染侧只 `resize`（视锥/`pixelsPerUnit` 同比、掩膜按 `maskSizeFor()` 自适应 169×95 / 77×43）。⑤ **自检隔离**——五套自检统一 `PET_PANEL_CONFIG=logs/selftest/`，不再读用户真实 `config.json`（否则会拿用户的远程提供商 Key 发真实请求，且三条降级断言必红）。验证：单测全绿、`tsc` 0 错、四套自检 **229 / 29 / 33 / 16** 全 exit 0、`panel:shot` **26/26**、`npm run scale:shot` 11 帧；证据 `logs/evidence/{window-scale-sweep.gif,window-scale-strip.png,sit-eyes-before-after.png,sit-exit-after.png,panel-physics.png,panel-status.png}`。**未新增状态名、事件、`intent`、`emotion`、IPC 通道、模块接口方法或 `RenderState` 字段** | 1.34.0 |
| 2026-11-06 | render、全局 | **控制面板 / 参数热更新**（ADR 0052）：① 新增第三个窗口（`shell/panel.ts` + `panel-window.ts` + 独立 preload `preload/panel.ts`，800×600、不可缩放、无边框、置顶、不占任务栏），入口 `Ctrl+Shift+P` + 托盘第一项，`Esc` 收起；② 五项可调参数（`sit.phaseAHeadTuneRad` / `sit.spineOverlayWeight` / `gaze.{eye,head,spine}Stiffness`）唯一出处 `shared/tunable-params.ts`（默认值引用 `shared/constants.ts`），夹取唯一一份 `clampTunableValue`（越界夹取、非法退默认、`-0` 归一）；③ 热更新链路 `cmd:panel{set}` → 主进程夹取 → `cmd:tuning` → 渲染侧 `tunables-store`，**不重启渲染进程、不重播坐姿**；④ `config.json` 持久化（只写改动项、保留未知顶层键、`tmp+rename` 原子写、坏文件降级、`PET_PANEL_CONFIG` 可覆盖）；⑤ 只读状态页 4Hz（复用 16ms 轮询器、仅面板可见时）+ Ollama 3s 探测三态（只诊断，不碰熔断/事件/托盘）；⑥ 新增 5 条控制面 IPC 通道 `cmd:panel` / `cmd:panel-state` / `cmd:tuning` / `cmd:state-poll` / `cmd:state-report`，**未新增/删除状态名、事件、`intent`、`emotion`、模块接口方法或 `RenderState` 字段**；⑦ 取证 `npm run panel:shot` 7 项断言全过（渲染侧收到 `-0.12/0.85/16`、面板数字框、状态页、`config.json`），`npm test` **552/0**（56 文件）、`tsc` 0 错 | 1.29.0 |
