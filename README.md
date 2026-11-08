# 凯伊 · 3D 桌宠（Kaiyi Desktop Pet）

> 一个常驻 Windows 11 桌面的 3D 角色：透明置顶、逐像素命中、可拖拽、可摸头、会走路、会吸附到窗口边缘、会说话、有表情和口型，还能记住你们聊过什么。
>
> **v3.0.0-ultimate** · 契约 1.33.0 · M30（终极完全体）

---

## 目录

- [它能做什么](#它能做什么)
- [技术亮点](#技术亮点)
- [启动前置条件](#启动前置条件)
- [快速开始](#快速开始)
- [常用热键](#常用热键)
- [LLM 提供商与模型下拉](#llm-提供商与模型下拉)
- [视觉 / OCR](#视觉--ocr)
- [常用命令](#常用命令)
- [项目结构](#项目结构)
- [隐私、成本与安全](#隐私成本与安全)
- [已知限制](#已知限制)
- [文档](#文档)
- [License](#license)

---

## 它能做什么

| 能力 | 说明 |
|---|---|
| **3D 渲染** | 透明、无边框、置顶、不占任务栏的 glTF 2.0（GLB）角色窗口；按模型包围盒自动计算窗口尺寸 |
| **逐像素命中 / 点击穿透** | 128×72 alpha 掩膜 + 双线性采样；只有真的点到角色才进入交互态，空白区域点击直接落到桌面 |
| **拖拽 / 摸头 / 行走 / 回弹** | 拖拽单摆物理、抓取点旋转、松手回弹；点头部触发官方摸头片段；待机时自主行走 |
| **吸附到前台窗口** | `Ctrl+Shift+S` 把角色贴到前台应用的上/下边缘并水平居中，播放坐姿；拖拽/点击/目标消失即解除 |
| **HFSM 动画** | Base（idle / walking）、Overlay（speaking / reacting）、Physics（dragged / settling / sitting）三层；七个正面待机站姿轮换、坐姿两段式、下坐弹簧 |
| **表情 / 口型** | 贴图合成表情（眼型 / 嘴型 / 红晕），四档元音口型；说话时被摸头不打断语音 |
| **Toon 着色 / 描边** | 身体与头发使用 3 阶 Toon + 背面法描边；面部保持无光照，保证贴图原色 |
| **本地 AI 对话** | 默认 Ollama；也支持任意 OpenAI 兼容端点与 OpenCode Go 订阅；动态拉取模型列表、面板里一键切换 |
| **视觉 / OCR** | `Ctrl+Shift+V` 截屏 → 本地 OpenAI 兼容 OCR → 下一轮对话注入一次性画面文字 |
| **本地语音** | GPT-SoVITS 本地合成 + Web Audio 播放 + RMS 包络驱动口型；支持打断 |
| **长期记忆** | 本地 SQLite（WAL + FTS5）记录交互与事实，按关键词召回；面板可查看/删除/清空 |
| **控制面板** | `Ctrl+Shift+P` 打开：物理手感热更新、LLM 提供商管理、模型 Combobox、角色卡编辑、TTS 测试、记忆管理 |

> 视觉资产（GLB、表情差分、参考音频）由用户自行提供，仓库不内嵌（契约 C-4）。

---

## 技术亮点

- **单一定时器**：穿透判定、拖拽位移、行走、回弹、吸附跟随、面板状态轮询共用同一个 ~16ms 轮询器，不额外开定时器。
- **主进程权威**：窗口位置、穿透状态、配置写盘、LLM 客户端切换、SQLite 读写全部在主进程；渲染侧只做表现。
- **安全边界**：默认只连本机回环；远程 LLM/OCR 端点必须由用户在面板里显式添加；API Key 只存本机 `config.json`，不进日志、不进状态快照。
- **可验证**：60+ 测试入口 / 近 600 条单测 + 五套真机自检 + 面板取证（`panel:shot` 21 项断言）。
- **零默认成本**：未配置远程提供商时，不产生任何按 token / 按次计费的外部调用；远程只在用户显式添加并启用后发生。

---

## 启动前置条件

### 1. 系统与运行时

| 项 | 要求 |
|---|---|
| 操作系统 | **Windows 11 x64**（唯一目标平台） |
| Node.js | 20.x 或更高 |
| 包管理 | `npm`（仓库自带 `package-lock.json`） |
| Electron | `33.4.11`（devDependency，`npm install` 自动安装） |

> 如果 Electron 启动即退出（无窗口、无日志），请用**普通权限**的终端 / 资源管理器双击 `run.cmd` 启动；低完整性级别或受限沙箱会导致 Chromium 初始化失败。

### 2. 角色资产（必须自备）

| 资产 | 默认位置 | 说明 |
|---|---|---|
| 角色模型 | `CH0335.glb`（工程根目录） | 可用 `PET_MODEL_PATH` 指向任意 GLB；仓库不内嵌模型 |
| 嘴型图集 | 由模型自带 `CH0335_EyeMouth` 贴图 | 口型/表情合成依赖它 |
| 表情差分（可选） | `data/expressions/` | `eyes_*.png` / `blush.png`；缺失时表情降级为只变嘴型 |
| 参考音频（TTS） | `data/ref/kaiyi.wav` | 3–10 秒；可用 `PET_TTS_REF_AUDIO` 覆盖 |

### 3. 本地 LLM：Ollama（推荐，默认路径）

```powershell
ollama pull qwen3:4b
ollama serve   # 默认 http://127.0.0.1:11434
```

- 默认模型：`qwen3:4b`（`PET_LLM_MODEL` 可覆盖）
- 面板里可以切换本地模型，或添加 OpenAI 兼容 / OpenCode Go 提供商

### 4. 本地 TTS：GPT-SoVITS（可选）

- 启动 `api_v2.py`，默认 `http://127.0.0.1:9880`
- 在 `.env` 填好参考音频逐字文本（`PET_TTS_PROMPT_TEXT`）与语种（`PET_TTS_PROMPT_LANG` / `PET_TTS_TEXT_LANG`）
- 不配置 TTS 也能完整运行：语音失败时字幕照常显示，对话不中断

### 5. 视觉 OCR：GLM-OCR（可选）

- OpenAI 兼容端点，默认 `http://127.0.0.1:8000/v1`，模型 `glm-ocr`
- 可用 `PET_OCR_URL` / `PET_OCR_MODEL` 覆盖；`PET_VISION_DISABLE=1` 可整体关闭
- OCR 端点只允许回环地址（与 LLM/TTS 同一套白名单）

### 6. 环境变量

```powershell
copy .env.example .env
# 按需编辑 .env：Ollama 地址/模型、TTS 参考音频与文本、OCR 地址等
```

优先级：**进程环境变量 > `.env` > 代码默认值**。`.env` 已被 `.gitignore` 排除，不会入库。

---

## 快速开始

```powershell
git clone <your-repo-url> aa3dpet-app
cd aa3dpet-app

npm install
copy .env.example .env
# 编辑 .env（至少确认 PET_LLM_URL / PET_LLM_MODEL）

npm run doctor   # 只读环境自检：模型、台词池、角色卡、Ollama、TTS、OCR
npm start        # 启动桌宠
```

启动后：

- 桌面底部出现角色；鼠标移到角色上才可交互，空白区域点击穿透到桌面
- 托盘菜单可呼出输入条、打开控制面板、吸附、重新加载、退出
- 控制面板在保存参数 / 提供商时写入 `config.json`（已忽略，不入库）

---

## 常用热键

| 热键 | 功能 | 降级 |
|---|---|---|
| `Ctrl+Shift+B` | 打开/收起输入条（唯一可聚焦窗口） | `Ctrl+Alt+B` |
| `Ctrl+Shift+P` | 打开控制面板 | — |
| `Ctrl+Shift+V` | 截图 → 本地 OCR → 下一轮对话注入画面文字 | `Ctrl+Alt+V` |
| `Ctrl+Shift+S` | 吸附到前台窗口上/下边缘 | `Ctrl+Alt+S` |
| `Esc` | 收起输入条 / 控制面板 | — |

> 热键被占用时会自动降级；都失败只记 ERROR，不阻断启动。托盘菜单始终可用。

---

## LLM 提供商与模型下拉

控制面板 → **AI 人格** → **LLM 提供商**：

| 类型 | 端点 | 模型来源 |
|---|---|---|
| 本地 Ollama | `http://127.0.0.1:11434` | 自动读 `/api/tags`，也可点 🔄 刷新 |
| OpenAI 兼容 | 任意 `https://...`（本机回环可 http） | `GET {baseURL}/models` |
| OpenCode Go | 固定 `https://opencode.ai/inference/go/openai/v1` | `GET /models`（Bearer + `x-opencode-session`） |

- 填好 Base URL / API Key 后点模型行右侧 **🔄**，成功会填充下拉与模型 chips；失败显示红字，但仍可手填模型名保存。
- 同一配置 **2 秒节流**；换 Key / 换地址会立即重新请求。
- **已保存的 Key 不会回到渲染进程**：编辑时留空，主进程只在「同一提供商 + 同一类型 + 同一归一化地址」时注入旧 Key；地址被改写则要求重新输入。
- 切换/保存/删除后**下一轮对话生效**，不需要重启；在途请求用旧提供商说完。
- 远程提供商只会在你显式添加并启用后访问；默认路径仍然只连本机回环。

---

## 视觉 / OCR

1. 按 `Ctrl+Shift+V`（或在输入条点「看看屏幕」）
2. 主进程截屏 → 调用本地 OpenAI 兼容 OCR → 文本归一化
3. 下一轮 LLM 对话注入**一次性**段 3.6；用完即清空
4. 失败（端点不可用 / 超时 / 空文本）只降级为「这一轮没有画面」，不阻断对话、不弹窗

---

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm run build` | esbuild 打包到 `dist/` |
| `npm start` | 构建并启动桌宠 |
| `npm test` | 全量 Node 单测（含 memory 的 Electron 子进程） |
| `npm run doctor` | 只读环境自检（模型 / 台词池 / 角色卡 / Ollama / TTS / OCR） |
| `npm run selftest` | 主链路真机自检（198 项） |
| `npm run selftest:input` | 输入条自检（29 项） |
| `npm run selftest:speech` | 对话 + 发声闭环自检（33 项） |
| `npm run selftest:fallback` | 缺失模型回退自检（4 项） |
| `npm run selftest:vision` | 视觉/OCR 全链路自检（16 项，真 Windows OCR 桩） |
| `npm run panel:shot` | 控制面板真机取证（21 项断言 + 截图，使用本地回环桩） |
| `npm run panel:opencode` | 手动诊断：真实 OpenCode Go `/models` 截图（依赖外网，非默认测试链） |

取证产物在 `logs/evidence/`（已忽略，不入库）；自检截图在 `dist/selftest/`。

---

## 项目结构

```
src/
  main/                 # Electron 主进程
    shell/              # 窗口、命中/穿透、拖拽、输入条、吸附、托盘、控制面板
    orchestrator/       # 规则/LLM/兜底、提示词、心跳、LLM 客户端
    voice/              # GPT-SoVITS 客户端与播放事实
    memory/             # SQLite + FTS5 记忆
    vision/             # 截图、OCR、视觉上下文
    runtime.ts          # 装配与 IPC 桥接
  renderer/
    render/             # Three.js / glTF（GLB）/ HFSM / 表情 / 口型 / 坐姿
    input/              # 独立输入条页面
    panel/              # 控制面板页面
  preload/              # 最小 preload（主页面 / 输入条 / 面板）
  shared/               # 类型、事件、IPC、常量、纯函数
docs/
  CONTRACTS.md          # 架构契约（唯一事实来源）
  MODULE_STATUS.md      # 模块状态与坑位
  adr/                  # 架构决策记录
  guides/               # 本地服务联调手册
data/                   # 角色卡、台词池、规则、记忆库（运行期生成）
scripts/                # 启动器、doctor、Electron 测试 runner
tools/                  # 片段预览等开发工具
```

---

## 隐私、成本与安全

- **默认零外部计费**：未添加远程提供商时，只连本机回环（Ollama / GPT-SoVITS / OCR）。
- **远程显式添加**：OpenAI 兼容 / OpenCode Go 端点只来自用户在面板里亲手添加的条目；启动、空闲、定时任务都不探测远程。
- **API Key**：只存本机 `config.json`（明文，威胁模型是本机用户）；日志只写「已配置 / 未配置」；`cmd:panel-state` 只给 `hasApiKey`；模型列表请求不把已保存 Key 发给渲染进程。
- **无遥测**：不收集、不上报任何使用数据。
- **记忆**：本地 SQLite，面板可查看/删除/清空。
- **截图**：只在用户按 `Ctrl+Shift+V` 时发生；OCR 端点默认回环；视觉上下文只存活一轮，可整体关闭。

---

## 已知限制

- 仅支持 **Windows 11 x64**；不提供 macOS / Linux 分支。
- 模型 / 表情差分 / 参考音频需自备，仓库不含这些资产。
- 远程 LLM 失败不会自动切回本地；面板会显示失败原因，下一轮走规则/兜底并熔断（可按面板提示切回本地 Ollama）。
- 吸附跟随以「同一个窗口句柄」为准；目标窗口销毁重建时按「目标消失」解除。
- 显示器增删 / DPI 变化后窗口尺寸不会运行期重算，重启生效。
- `panel:opencode` 依赖真实外网；默认 `panel:shot` 与全部单测都只用 127.0.0.1 桩。

---

## 文档

| 文件 | 内容 |
|---|---|
| [`docs/CONTRACTS.md`](docs/CONTRACTS.md) | 架构契约（1.33.0）：模块、状态、事件、接口、成本红线 |
| [`docs/MODULE_STATUS.md`](docs/MODULE_STATUS.md) | 各模块已完成/未完成、对外接口、已知坑位、M30 封版记录 |
| [`docs/adr/`](docs/adr/) | 架构决策记录（从 ADR 0001 到 0056） |
| [`docs/guides/LOCAL-SERVICES.md`](docs/guides/LOCAL-SERVICES.md) | Ollama / GPT-SoVITS / OCR 本地联调手册 |

---

## License

本项目尚未选择开源许可证。**在公开发布前请补充 `LICENSE`**（例如 MIT / Apache-2.0），并确认：

- 角色模型、贴图、表情差分、参考音频的版权与再分发许可；
- 第三方依赖（Electron、three.js、better-sqlite3、koffi 等）的许可证兼容性。

---

> 凯伊，毕业快乐。  
> —— v3.0.0-ultimate，2026-11-08
