# 0052. 控制面板（参数调校台）

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-11-06 |
| 决策者 | 项目所有者（"坐姿和视线这几个参数，我要能自己拖着调，不用改代码再重启；面板里还要能看见她现在到底在干什么、本地模型通不通"） |
| 关联 | 契约 §3.5（跨进程通道）、§3.1（窗口）、§7.8（控制面板）；ADR 0028 / 0033 / 0034（吸附、预热、坐姿生命周期）、ADR 0049 D2（视线三级阻尼）、ADR 0051 D7（坐姿两个标定常量） |

## 背景

ADR 0051 D7 把两个坐姿手感参数放进了 `shared/constants.ts`，标定方式是"改常量 → `tsc` → 重启 → 看真机"。
真实使用里这条路太慢：一次 A/B 要 3–5 分钟，而且改完就忘了改回去。项目所有者的原话是
"我不想为了调 -0.12 还是 -0.15 反复重启进程"。

同一轮里还有两个"看不见"的问题：

1. **状态不可见**：她此刻是 `idle` 还是 `sitting`、播到哪个片段、视线权重多少、模型加载没有——
   只有 `window.diagnostics`（开发者工具里）和 `logs/` 能看。
2. **本地服务不可见**：Ollama 没起来时，界面上只会表现为"她不说话"，用户无法区分
   "模型没加载 / 服务没启动 / 请求超时"。

需要一个**普通用户能开、能拖、能保存、能看状态**的窗口。它不能破坏已有的三条红线：
不改状态机、不改事件白名单、不产生任何按次计费的外部调用。

## 决策

### D1 独立窗口 + 最小 preload

- 第三个 `BrowserWindow`（与角色页、输入条并列）：**800×600、不可缩放、`frame: false`、`alwaysOnTop: true`、
  `skipTaskbar: true`、不透明**。页面走 `file://`（`renderer/panel/index.html`），不起本地 Web Server。
- 独立 preload `src/preload/panel.ts`，只暴露两个出口：
  `panel.invoke(cmd)` → `ipcRenderer.invoke('cmd:panel', cmd)`；
  `panel.onState(cb)` → 订阅 `cmd:panel-state`。
- **不复用**角色页 preload（它持有 `evt:broadcast` 与掩膜/拖拽通道）。面板不需要、也不允许
  看见角色页的任何通道。
- 入口：全局热键 **`Ctrl+Shift+P`**、托盘菜单第一组"控制面板"；`Esc` 收起（`hide`，不销毁）。

### D2 五项参数，唯一出处

只有五项（`src/shared/tunable-params.ts`）：

| id | 常量 | 默认 | 区间 / 步长 | 为什么可调 |
|---|---|---:|---|---|
| `sit.phaseAHeadTuneRad` | `SIT_PHASE_A_HEAD_TUNE_RAD` | 0 | −0.3..0.3 / 0.005 | 落座瞬间的抬头量，直接决定"她坐下后是不是半眯着眼" |
| `sit.spineOverlayWeight` | `SIT_SPINE_OVERLAY_WEIGHT` | 1.0 | 0.6..1 / 0.01 | 1.0 = 坐得直；0.85 = 放松一点 |
| `gaze.eyeStiffness` | `GAZE_EYE_STIFFNESS` | 12 | 1..30 / 0.5 | 眼球多快跟上光标 |
| `gaze.headStiffness` | `GAZE_HEAD_STIFFNESS` | 8 | 1..20 / 0.5 | 头部慢半拍的程度 |
| `gaze.spineStiffness` | `GAZE_SPINE_STIFFNESS` | 4 | 1..12 / 0.5 | 躯干跟不跟、跟多少 |

- 默认值**必须引用 `shared/constants.ts`**，不另写数字；新增第六项要改本 ADR（见"替代方案"）。
- 夹取只有一份：`clampTunableValue(id, raw)`。主进程、面板、渲染侧共用；越界夹到边界、
  非数字（`null`/`NaN`/`"abc"`/`true`）**退回默认值**而不是 0，`-0` 归一成 `0`。
  为什么不用裸 `Number()`：`Number(null) === 0` 会把"没改"读成"把刚度调到 0"。

### D3 热更新链路（不重启渲染进程）

```
面板 slider/number  →  cmd:panel{kind:'set', patch}
                    →  主进程 clamp + 合并
                    →  cmd:panel-state（回显） + cmd:tuning{values, reason:'preview'}
                    →  渲染进程 tunables-store.apply(patch)
                    →  下一帧 render-module 读 store.get(id)
```

- 渲染侧新增 `renderer/render/tunables-store.ts`：**唯一**参数表，`apply()` 返回真正变化的 id，
  上下文据此决定"要不要重新标定坐姿/视线"。
- 预览是**内存态**：不写盘、不阻断、不弹窗。`Ctrl+S` / 「保存并应用」才落盘。
- 三条热更新语义：
  1. `sit.phaseAHeadTuneRad` / `sit.spineOverlayWeight`：下一帧直接生效（阶段 A 的叠加量本就每帧算）。
  2. `gaze.*Stiffness`：下一帧直接生效（阻尼系数每帧读）。
  3. 任何参数变化**不重播坐姿**、不打断在播片段、不重置姿势基准；改完只是"下一帧的系数变了"。

### D4 参数表在渲染侧只有一处

`render-module` 的坐姿与视线模块不再直接读 `shared/constants` 的四个值，而是读
`tunables.get(id)`。`shared/constants` 仍是**默认值来源**（`TUNABLE_DEFAULTS` 引用它），
所以"没调过"和"调到默认值"完全等价。

### D5 持久化：`config.json`，只写改动项

- 位置：`app.getAppPath()/config.json`（工程根，与 `data/` 同级）。`PET_PANEL_CONFIG` 可覆盖
  （取证脚本用它隔离用户配置）。
- 结构：

```json
{
  "version": 1,
  "updatedAt": "2026-11-06T03:12:44.120Z",
  "tuning": { "sit.phaseAHeadTuneRad": -0.12, "sit.spineOverlayWeight": 0.85, "gaze.eyeStiffness": 16 }
}
```

- **只写与默认值不同的项**：文件里没有的项 = 默认值；回到默认值时该项从 `tuning` 消失。
- **保留未知顶层键**：本文件不解析的键（以后放窗口/语音设置）原样写回，避免"面板一保存就丢别人的配置"。
- **原子写**：`config.json.tmp` + `rename`；写失败只更新 `lastError` 并通知面板，**不抛给调用方**。
- **坏文件不阻断启动**：JSON 解析失败 / 顶层不是对象 / `tuning` 不是对象 → 按默认值启动，
  记一条 WARN 与面板上的"读取错误"（`error` 字段），并保留原文以便用户手工修。
- 启动顺序：`shell.start()` 里先读 `config.json` → 装配面板控制器 → `cmd:tuning` 立即广播一次
  （渲染页 `did-finish-load` 之前就发，靠已有的一次性闩锁重放），保证"首帧就是保存过的值"。

### D6 只读状态页 + Ollama 探测

- 面板可见时每 **250ms** 发一次 `cmd:state-poll`；渲染侧 `cmd:state-report`
  回 `{ at, state, tuning, sit }`（`state` 是 `getState()` 的浅拷贝，`sit` 是坐姿诊断子集）。
  **面板不可见时不发**（零后台开销）；面板 4Hz 推状态不会让渲染侧多做任何事。
- 状态页显示：主状态（Base/Overlay/Physics）、当前片段（角色名/本地时间/权重）、模型是否就绪、
  坐姿阶段/增益/两个标定量的实际生效值、渲染侧当前参数、Ollama 三态、配置文件路径与上次保存时间。
- **Ollama 探测**：面板可见时**每 3s 最多一次** `GET http://127.0.0.1:11434/api/tags`，
  超时 1.5s；三态 `online`（且列出是否含配置的模型）/ `offline`（附原因：连接拒绝 / 超时 / HTTP 码 /
  缺模型）/ `unknown`（还没探测过）。
  - 只用于**诊断展示**：不写 `llm_failed`、不影响 `orchestrator` 的熔断、不进托盘诊断、不计次。
  - 探测本身是回环请求，零成本（§10 白名单内）。`dispose()` 后丢弃在飞结果。
  - 用 `fetch` 而不是复用 `llm-client`：后者带熔断语义与 `/v1/chat/completions` 预热，
    面板要的是"服务在不在"，不能让一次看面板的动作影响她的可用性判断。

### D7 取证：`npm run panel:shot`

单测能证明夹取/持久化，但证明不了"滑块真的到了渲染进程"。取证脚本
（`src/main/panel-shot.ts`，`--panel-shot`）把整条链路跑一遍：

1. 打开面板，等页面脚本与首次状态回报；
2. 走**页面自己的路径**（`window.__panelDebug.set` = 等价于用户拖滑块）改三项；
3. 从 `shell.panelDiagnostics().render.tuning` 读**渲染进程上报的真值**，逐项比对；
4. 比对面板数字框显示；
5. 点「保存并应用」，读回 `config.json`；
6. 截两张图（物理手感 / 系统状态），写 `logs/evidence/panel-hot-update.json`；
7. **`finally` 里还原用户原 `config.json`**（取证不得改变用户手感），然后退出。

`PET_PANEL_CONFIG` 默认指向 `logs/selftest/panel-config.json`，所以取证连真实配置都不碰。

## 替代方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 继续改常量 + 重启 | 零新代码 | 一次 A/B 3–5 分钟；改完忘了改回去 | 否 |
| 用 Electron 开发者工具手改 `window.diagnostics` | 零新窗口 | 只有开发者能用；不能保存；用户看不到 | 否 |
| 把参数塞进托盘菜单 | 复用现有入口 | 托盘放不下 5 个连续量；无精确输入；无状态页 | 否 |
| 独立窗口 + 独立 preload + `config.json` | 用户能开、能拖、能存；参数与状态同屏 | 多一个窗口、多一个 preload、多 4 条 IPC | **是** |
| 复用输入条窗口的 preload | 少一个文件 | 会把 `evt:broadcast`/掩膜/拖拽通道暴露给一个不该有它们的页面 | 否 |
| 参数走 `.env` | 与现有配置一致 | 改 `.env` 要重启；不是"调参"是"部署" | 否 |
| 存进 `data/memory.db` | 复用 SQLite | 调参属于设置，不属于记忆；且渲染侧读不到 | 否 |
| 面板每帧推全量状态 | 实现简单 | 面板不可见时也烧 CPU；违反"面板只是观察者" | 否（4Hz + 仅可见） |
| Ollama 探测走 `llm-client` | 复用现有 HTTP | 会把面板打开动作绑进熔断/预热语义 | 否（独立探测） |

## 后果

**正面**

- 调参从"改常量 + 重启 + 看"变成"拖一下，立刻看"。ADR 0051 D7 的两个参数第一次有了
  面向用户的入口。
- 状态第一次可见：她在做什么、播到哪、模型是否就绪、Ollama 通不通，一屏之内。
- 参数与状态共用一条链路（`cmd:panel` / `cmd:panel-state`），没有第二套真相。
- `config.json` 只写改动项 + 保留未知键 + 原子写 + 坏文件降级，升级/回滚都不会丢用户设置。
- 取证脚本可重复、可断言、且**自还原**。

**负面 / 成本**

- 新增一个窗口（800×600）与一个 preload：常驻内存约 30–40MB（Chromium 渲染进程），
  只在打开时创建、收起时 `hide`（不销毁，避免反复加载）。
- 新增 5 条 IPC 通道（`cmd:panel` / `cmd:panel-state` / `cmd:tuning` / `cmd:state-poll` / `cmd:state-report`）。
  它们都是**控制面**，不在 §6 事件白名单里——事件仍然是事实，这些是命令/快照，不得被用来伪造事实。
- 面板的 4Hz 轮询是"可见才跑"；`Esc` 收起后立即停止，无后台定时器。
- 参数一旦落盘就成为"用户配置"，默认值只在 `shared/constants.ts`。发布新版本若改了默认值，
  用户保存过的旧值仍然优先——这是刻意的（用户手感不该被升级覆盖）。

**约束**

- 不新增状态名、事件、`intent`、`emotion` 或 `RenderState` 字段。
- 面板**不得**写 `memory.db`、不得发起非回环请求、不得调用 `voice`/`orchestrator`。
- 渲染侧参数表是唯一写入点；任何模块不得绕过 `tunables-store.apply()` 改参数。
- Ollama 探测不得进入熔断/事件/托盘诊断链路。

## 验证

- 单测（`npm test` 内）：
  - `tunable-params.test.ts`：默认值引用常量、夹取/步长/`-0`、非法输入退默认、部分更新、
    完整归一化、写盘只写差异、展示格式；
  - `tunables-store.test.ts`：变化 id 准确、重复 apply 无变化、非法 id 忽略、`values()` 拷贝、
    `reset`/`restoreDefaults`、初始值同一套夹取；
  - `panel-config.test.ts`：合法/坏 JSON/非对象/坏时间戳、缺文件、只写差异 + 保留未知键、
    原子读写、`PET_PANEL_CONFIG` 覆盖；
  - `ollama-probe.test.ts`：在线/缺模型/连接拒绝/HTTP 码、TTL 节流、单飞、`dispose` 丢弃。
- 真机取证（`npm run panel:shot`，exit 0）：7 项断言全过——
  渲染侧收到 `-0.12 / 0.85 / 16`、面板数字框显示 `-0.120 / 0.85 / 16.0`、
  状态页显示渲染侧回报、`config.json` 写入三项且值正确。
  证据：`logs/evidence/panel-hot-update.json`、`panel-physics.png`、`panel-status.png`。
- 交叉验证：`tsc --noEmit` 0 错；`npm test` 全绿（新增 4 个测试文件）。
