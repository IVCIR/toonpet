# 贡献指南（Contributing to ToonPet）

感谢你对「ToonPet · 凯伊 3D 桌宠」的关注！这是一个以 **Windows 11 桌面 + 本地 AI** 为核心的实验性项目，欢迎通过 Issue 与 Pull Request 参与。

---

## 1. 先聊，再改

- **提 Issue 永远受欢迎**：Bug、体验问题、文档错漏、想法都可以开 Issue，请尽量附上复现步骤、日志片段（`logs/pet.log`）和系统环境。
- **大改动请先开 Issue 对齐**：新增模块、改契约、改窗口规格、改状态机这类改动，先讨论方向，避免白写。
- **不要直接改 `docs/CONTRACTS.md` 的既有规则**：本项目的契约是"唯一事实来源"，流程是 **先写 ADR → 再改契约 → 升契约版本号**（见 `docs/adr/0001-record-architecture-decisions.md`）。只改实现、不碰契约的 PR 最好合并。

## 2. 动手前必读

| 文档 | 为什么读 |
|---|---|
| [`docs/CONTRACTS.md`](docs/CONTRACTS.md) | 模块职责、状态/事件白名单、窗口规格、命中与拖拽硬规则、成本红线。**改代码前先读这里** |
| [`docs/MODULE_STATUS.md`](docs/MODULE_STATUS.md) | 各模块当前完成度、对外接口、已知坑位 |
| [`docs/adr/`](docs/adr/) | 55 篇架构决策记录，解释"为什么是现在这样" |
| [`README.md`](README.md) | 快速开始、热键、架构总览 |

## 3. 开发环境

```powershell
# 前置：Windows 11 x64 + Node.js 20.x 或更高
npm install
copy .env.example .env   # 本机配置，.env 已被 .gitignore 排除
npm run build            # esbuild 打包到 dist/
npm run typecheck        # tsc --noEmit，必须 0 错
npm test                 # 构建 + 全量单测（含 memory 的 Electron 子进程）
npm start                # 启动桌宠
```

- 需要本地 **Ollama**（默认 `http://127.0.0.1:11434`，模型 `qwen3:4b`）才能对话；TTS / OCR 可选。
- 模型、贴图、参考音频等**视觉/语音资产不入库**（契约 C-4），请自备，详见 `docs/guides/`。
- 提交前至少跑通 `npm run build`、`npm run typecheck`、`npm test`。

## 4. 提交规范

沿用仓库现有的 Conventional Commits 风格（中英文皆可）：

```
feat(render): 3-stage toon lighting for body/hair (ADR 0037)
fix: resolve clipping during drag swing
docs: fix typo in quick start
```

- 一个 PR 尽量只做一件事；涉及契约/ADR 的改动请在 PR 描述里贴编号。
- 新增行为请补测试（`src/**/*.test.ts` 会被 `build.mjs` 自动编到 `dist/tests/`）。
- 行为改变优先"降级而不是崩溃"：任何外部服务（LLM / TTS / OCR）失败都应有降级路径。

## 5. 绝对不要提交的东西

| 路径 | 原因 |
|---|---|
| `config.json` | 含本机 API Key / 面板调参（`.gitignore` 已排除） |
| `.env` / `.env.local` | 本机环境变量（模板 `.env.example` 可入库） |
| `data/memory.db*` | 用户私人记忆库 |
| `*.glb` / `*.vrm` / `*.obj` / `*.wav` / `*.pth` / `*.ckpt` | 大体积模型/音频资产，版权与仓库体积双重原因 |
| `data/ref/`、`data/expression/`、`Character_Mouth_*.png` | 用户自备运行时资产 |

如果你发现仓库里出现了上述文件，请立刻开 Issue 或直接发 PR 修 `.gitignore`，**不要**在 PR 里附带真实 Key。

## 6. 分支与 PR

- 从 `main` 拉分支：`feature/<short-name>`、`fix/<short-name>`、`docs/<short-name>`。
- PR 描述请包含：改了什么、为什么、如何验证（命令/截图/日志）、是否涉及契约或 ADR。
- 合并前 CI 等价检查：`npm run build && npm run typecheck && npm test` 全绿。
- 保持提交历史可读，不要求 squash；但请不要在 PR 里混入无关的格式化改动。

## 7. 资产与版权

- 仓库不附带任何角色模型、贴图、语音、参考音频；这些资产的使用与再分发请遵守其原始来源的许可。
- 提交的代码默认按仓库的 [MIT License](LICENSE) 授权。

## 8. 行为准则

保持友善、就事论事。对"桌面宠物"这种高度个人化的项目，审美和手感的分歧很正常——用数据和可复现的现象说话（这也是本仓库 55 篇 ADR 存在的原因）。

---

有疑问？先开 Issue，或读一遍 `docs/adr/`，大概率已经有答案。
