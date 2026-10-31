# 0005. 将 Electron 运行时基线升级到 44.7.0

| 项 | 值 |
|---|---|
| 状态 | 被替代（由 #0006 撤回） |
| 日期 | 2026-10-27 |
| 决策者 | 项目所有者 |
| 关联 | `CONTRACTS.md` §3.1（Electron main）、§3.2（窗口规格）；大厅 `docs/MODULE_STATUS.md` |

## 背景

1. 本项目把 Electron 锁在 `33.4.11`，在目标机器（Windows 11 25H2，build 26200）上启动即失败：进程在 Chromium 初始化阶段以 `0x80000003`（STATUS_BREAKPOINT）退出，约 30–40ms，连主进程 JS 都没执行（`logs/boot.log` 不生成）。临时对照的 Electron `38.2.0` 表现完全相同。
2. 同一台机器上，DeepSeek Harness 自身是 **Electron 44.7.0**，正在稳定运行（含 GPU 渲染、透明窗口），证明这台机器的 Chromium 能力正常、Windows 25H2 可运行现代 Electron。
3. 同机 Chrome（Chromium 14x）也运行正常，而 Electron 33/38/44 在 agent 会话里全部崩溃——但该会话是 **Low 完整性令牌**（`S-1-16-4096`，仅 `SeChangeNotifyPrivilege`），本身不足以运行 Chromium。因此"版本问题"与"启动上下文问题"在这个会话里无法区分，必须由用户在 Medium 完整性进程里判定。

## 决策

1. 把 `electron` 的 devDependency 从 `33.4.11` 改为**精确** `44.7.0`（不写 `^`），与已证明可在本机运行的运行时对齐。
2. 判定规则写死如下：**以"Medium 完整性进程中冷启动成功（出现 `logs/pet.log` 的 `主窗口已显示` 行）"为准**。
   - 若成功 → 本 ADR 转为「已接受」，44.7.0 成为基线。
   - 若仍以 `0x80000003` 失败 → 本 ADR 标记「已废弃」，回退 `33.4.11`，并把结论落到 `MODULE_STATUS.md` 的已知坑位（说明这不是版本问题）。
3. 无论结论如何，都不使用 `^` 范围：桌面常驻程序必须可复现构建。

## 替代方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 维持 `33.4.11` | 零改动 | 在本机目标系统（25H2）上尚未被证明能启动；Chromium 130 早于该系统 | 否（除非验证表明 33 在 Medium 下正常） |
| 用 `^33` 之类的范围 | 自动打补丁 | 不可复现，桌宠崩溃后无法回溯 | 否 |
| 改用 Tauri / WebView2 重写外壳 | 可能绕开 Electron 的启动问题 | 违反 §3.1 的进程划分，透明窗口、`setIgnoreMouseEvents`、`screen` 轮询都要重写，等于推翻 ADR 0002/0003 | 否 |
| 精确锁定 `44.7.0`（本方案） | 与同机已验证运行的运行时一致；Chromium 144 包含 25H2 相关修复 | 大版本跨度需要回归 | **是（提议）** |

## 后果

**正面**

- 运行时与本机唯一已证明可用的 Electron 基线一致，降低"新系统上起不来"的风险。
- Chromium 144 比 130 多了近一年的系统兼容与安全修复。

**负面 / 成本**

- 33 → 44 跨 11 个大版本，必须回归四件事：透明窗口与置顶层级、`setIgnoreMouseEvents` 行为、`readRenderTargetPixels`（R-2）、`screen.getCursorScreenPoint` / `getContentBounds` 的坐标语义。
- 打包体积与 Node 运行时版本随之变化（Node 22）。
- 若后续发现必须回退，需要新 ADR，不得直接改 `package.json`。

**约束**

- `electron` 版本必须是精确值；升级或降级都要新 ADR。
- 验收必须包含"透明窗口 + 穿透 + 掩膜读回"三件事，不能只看窗口是否出现。
