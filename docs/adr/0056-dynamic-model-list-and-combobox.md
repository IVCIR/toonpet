# 0056. 动态模型列表与 Combobox：`fetchModels()` / `cmd:fetch-models`

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-11-08 |
| 决策者 | 项目所有者（"OpenCode Go 的模型名目前是纯手填，希望像 DeepSeek 官网 / DSH 那样直接下拉选择"） |
| 关联 | 契约 §3.5（跨进程通道）、§7.8（控制面板）、§7.10（LLM 提供商）、§10.2（出站白名单）、§12（无新定时器）；ADR 0052/0053（面板）、ADR 0055（提供商切换） |

## 背景

ADR 0055 把"用哪个提供商"做成了面板里的显式选择，但模型名仍是纯手填：

- OpenCode Go 的模型清单由服务端决定，用户不可能记住 `glm-5.3-flash`、`grok-4.7` 这类名字；
- OpenAI 兼容端点的 `/models` 已经存在（`health()` 用它做连通性测试），但结果只用于
  `modelPresent` 判定，**没有回到面板**；
- 填错模型名不会在保存时暴露，要等下一轮真实对话 404 / 熔断，反馈太晚；
- 用户要求"填 Key → 点 🔄 → 下拉选模型 → 保存后主进程能正常对话"。

本轮把"模型清单"做成一个**只读、用户触发、主进程执行**的能力，并在面板上提供
`<input list>` + `<datalist>` 的 Combobox。它**不改状态机、不改事件白名单、
不改 `RenderState`、不新增定时器**；唯一新增的跨进程入口是一条只读通道
`cmd:fetch-models`。

## 决策

### D1 `LLMProvider.fetchModels()`

在 `src/main/orchestrator/llm-client.ts` 的 `LLMProvider` 上新增：

```ts
fetchModels(request?: { timeoutMs?: number }): Promise<LlmModelListResult>;

type LlmModelListResult =
  | { ok: true; models: Array<{ id: string; name: string }> }
  | { ok: false; error: string };
```

三个实现：

- `OllamaProvider`：`GET {base}/api/tags`，沿用 ADR 0015 的解析口径（`name` 优先、
  旧版 `model` 兜底）；**不要求当前模型在清单里**（用户正要换模型）。
- `OpenAIProvider`：`GET {base}/models`，带 `Authorization: Bearer <Key>` 与
  `User-Agent`；解析 `data[]` / `models[]` / 字符串数组，`id` 是发给端点的名字，
  `display_name` / `name` 是展示名。
- `OpenCode Go`：同一实现，但 base URL 由 `createOpenAiProvider` 钉死为
  `https://opencode.ai/inference/go/openai/v1`，并带 `x-opencode-session: ses_…`。

失败一律折算成 `{ ok:false, error }`：`401/403` 提示"API Key 可能无效"，
`404/405` 提示"端点不提供 /models"，超时/网络错误给可读原因。**不重试、不抛异常、
不改熔断、不发事件、不写盘**。返回清单去重、去空白、上限 200 条
（`LLM_MODEL_LIST_MAX_OPTIONS`）。

### D2 新增只读通道 `cmd:fetch-models`

```ts
// panel → main（invoke/handle）
{ type?: 'ollama' | 'openai' | 'opencode-go'; baseUrl: string; apiKey?: string; providerId?: string }

// main → panel
{ ok: true; models: Array<{ id: string; name: string }> } | { ok: false; error: string }
```

为什么**单独一条通道**而不是塞进 `cmd:panel`：

- `cmd:panel` 的语义是"面板对主进程的一次写/读状态请求"，ADR 0055 明确它不发起网络；
  模型列表是**唯一会主动访问远程端点**的面板动作，单独一条通道更容易在审计时
  一眼看到"面板能触发的出站请求只有这一条"；
- 它仍然是**只读**的：不改 `config.json`、不换客户端、不写记忆、不发事件；
- 两条通道共用同一套发送方白名单（只接受面板窗口这一个 sender）、同一份 preload
  （`contextBridge` 只暴露 `invoke` / `onState` / `fetchModels`）与同一层主进程业务校验。

`shell` 不 import `runtime` / `llm-client`：`cmd:fetch-models` 由
`src/main/shell/panel.ts` 接收，转给注入的 `PanelBackendLike.fetchModels()`，
真正建临时客户端的是 `runtime.panel()`（与 ADR 0053 的 `attachPanelBackend` 同一手法）。

### D3 Key 安全：已保存的 Key 只在"同一提供商 + 同一类型 + 同一地址"时注入

面板**永远不读取已保存的 Key**。请求里的 `apiKey` 只代表"用户刚刚输入的 Key"：

1. 用户输入了非空 Key → 用它；
2. 留空且带 `providerId` → 主进程查已保存提供商，**同时满足**下列三条才注入旧 Key：
   - `saved.id === providerId`；
   - `saved.type === request.type`（或按地址推断出的类型）；
   - `saved.baseUrl === validateProviderBaseUrl(type, request.baseUrl)`（归一化后完全相等）。
3. 任一条不满足 → 以空 Key 请求（Ollama 本来不需要；远程会得到 401，面板显示红色提示）。

**为什么地址必须相等**：如果只按 `providerId` 复用，恶意/误操作的面板请求可以
`{ providerId:'oc', baseUrl:'https://evil.example.com/v1' }`，主进程就会把 OpenCode Go 的
Key 发给攻击者。加上地址相等这一条后，"改地址"与"沿用旧 Key"不能同时成立；
面板 UI 也在 `refreshProviderModels()` 里提前挡一次并给出人话：
"Base URL 已改：为安全起见，请重新填写 API Key 再拉取"。

日志只记 `apiKey: 已输入 | 沿用已保存/未配置`，**不记明文**；节流键里的 Key 指纹
只含长度与末 4 位（`modelListKeyFingerprint`），不是可逆哈希。

### D4 2 秒节流 + 单飞 + 短缓存

`src/main/llm-model-list.ts` 是纯逻辑模块（注入时钟与客户端，可在 Node 单测）：

- 节流键 = `type | 归一化 baseUrl | providerId | Key 指纹`；
- 同一键在 `LLM_MODEL_LIST_THROTTLE_MS = 2000` 内重复请求 → 直接返回上次结果
  （成功/失败都缓存），不会重复打端点；
- 同刻并发 → 复用同一个在途 Promise（单飞），不会打出两次请求；
- 缓存超过 `LLM_MODEL_LIST_CACHE_TTL_MS = 60000` 自动清理；
- 超时：Ollama `3000ms`，远程 `8000ms`（`LLM_MODEL_LIST_LOCAL_TIMEOUT_MS` /
  `LLM_MODEL_LIST_REMOTE_TIMEOUT_MS`）。
- 面板按钮在请求后 2s 内显示 ⏳ 并禁用；改变 Base URL / API Key 会立即解除本地冷却
  （主进程按新配置的节流键单独判定）。

**没有新定时器**：节流是"比较时间戳 + 复用 Promise"，不是 `setInterval`；
面板的 2s 按钮冷却只是一次性 `setTimeout`，不参与主进程生命周期。

### D5 面板：`<input>` + `<datalist>` Combobox

"AI 人格"页的提供商表单把模型字段统一为：

- `<input id="provider-model" list="provider-model-options">`：始终可编辑（失败时也能手填）；
- `<datalist id="provider-model-options">`：刷新成功后填入 `id`，`label` 显示 `name`；
- `🔄` 按钮（`#provider-model-refresh`）：显式用户动作；请求中/2s 冷却显示 ⏳；
- 状态行 `#provider-model-status`：成功绿色、失败红色、警告黄色；
- 模型 chips：把前 12 个模型渲染成可点击的胶囊，点一下回填输入框；多出的显示 `+N`。

交互：

1. 选类型 → 填 Base URL / API Key（编辑时留空 = 沿用旧 Key）；
2. 点 🔄（或在模型输入框按 Enter）；
3. 面板 `fetchModels({ type, baseUrl, apiKey?, providerId? })`；
4. 成功：datalist + chips 填充，输入框为空时自动选第一个，绿色提示"已拉取 N 个模型"；
5. 失败：红色提示原样显示主进程的 `error`，**输入框与保存按钮保持可用**；
6. 保存：模型名取输入框当前值（下拉选中或手填都一样），走原有 `provider-save`。

Ollama 仍然会在 4Hz 状态推送里用 `/api/tags` 的探测结果自动填充（ADR 0053），
但**手动刷新结果优先**（`modelOptionsSource === 'fetch'` 时不被探测覆盖）。

### D6 可观测与失败口径

- 日志（`panel`）：成功一条 `模型列表已拉取 {type, baseUrl, providerId, apiKey, models, durationMs}`；
  失败一条 `模型列表拉取失败 {..., error, durationMs}`；**无 Key 明文**。
- 失败**不**改熔断、**不**发 `llm_failed`、**不**影响下一轮对话；它只是面板上的一个红字。
- 远程 `/models` 请求只在用户点 🔄 时发生；启动、空闲、定时任务都不探测（§10.2 不变）。
- `provider-test` 与 `fetchModels` 是两条独立路径：前者判"连通性/模型是否存在"，
  后者只取清单；两者都不写盘。

### D7 不做

- 不自动刷新（打开面板/切页/输入 Key 时都不自动打端点）；
- 不把模型清单持久化进 `config.json`（服务端会变，缓存只在内存 60s）；
- 不做模型搜索/分组/收藏；
- 不新增事件、不新增 `RenderState` 字段、不新增状态、不改 `intent` / `emotion`；
- 不为 OpenCode Go 引入新的协议字段（沿用 ADR 0055 的 Bearer + `x-opencode-session`）。

## 备选方案

1. **继续手填 + 保存时校验 `/models`**：保存前多一次网络，失败会阻止保存；用户仍看不到
   可选清单，且"端点不提供 /models"时无法保存。放弃。
2. **把 `fetch-models` 塞进 `cmd:panel`**：可以复用现有通道，但会让"面板唯一的写入口"
   同时承担一次远程网络请求，审计面变大；且 `PanelAction` 联合体会多出一个返回结构
   完全不同的分支。单独只读通道更清晰。
3. **渲染进程直接 `fetch` 模型列表**：面板页面是 `file://`，会绕过主进程的地址/Key
   校验与节流，也违反 §10.2 的"出站只由主进程发起"。放弃。
4. **用 `<select>` 替代输入框**：端点不提供 `/models` 时无法手填，违背"失败仍可手动保存"。
   采用 input + datalist，保留手填能力。
5. **按 providerId 无条件复用旧 Key**：实现最简单，但存在"改地址即泄 Key"的面。
   放弃，改为三重匹配。

## 后果

- 正面：OpenCode Go / OpenAI 兼容 / Ollama 三类提供商都能"点一下看到模型"；
  失败可见且不阻断保存；Key 不回到渲染进程；远程请求只在用户动作时发生；
  2s 节流 + 单飞避免误点把端点打爆。
- 负面：新增一条 IPC 通道（§3.5 从"五条控制面通道"变为六条）；OpenCode Go 的
  `/models` 需要真实订阅 Key 才能验证，离线环境只能用本地桩证明请求形状；
  地址与已保存值不一致时用户必须重新输入 Key（这是刻意的安全取舍）。
- 不做：自动刷新、清单持久化、模型搜索/分组。

## 验证

- `llm-model-list.test.ts`（12 条）：类型推断、Key 指纹、OpenCode Go 固定端点 +
  旧 Key 注入、地址/类型不匹配时不复用、用户输入优先、非法请求、2s 节流、
  Key 变化立即重试、单飞、空清单/失败/抛错、去重与展示名。
- `llm-client.test.ts` 新增 5 条：Ollama `/api/tags`、OpenAI `/models` 解析、
  401/404 可读错误、OpenCode Go 固定端点 + Bearer + `x-opencode-session`。
- `npm run panel:shot`：新增 4 项断言（模型列表填入 Combobox、选模型保存并切换后
  runtime 真在用 `grok-4.7`、编辑留空 Key 仍能拉取且桩收到 Bearer、失败红色提示且
  手填保存成功），截图 `panel-models.png`；脚本用 127.0.0.1 上的临时桩，不访问外网，
  退出前还原用户 `config.json`。
- 真机端点（2026-11-08，`curl`）：`GET https://opencode.ai/inference/go/openai/v1/models`
  - 无 Key → **200**，响应 `{ object:'list', data:[{ id, name, ... }] }`，与解析口径一致；
  - `Authorization: Bearer sk-invalid-selftest` → **401**，对应"API Key 可能无效"红色提示；
  - 带 `x-opencode-session: ses_selftest` → **200**。
  本机没有用户真实订阅 Key，"带有效 Key 成功拉取"由真实响应形状 + 单测的
  Bearer/Headers 断言 + 本地桩共同覆盖；不声称已用真实 Key 跑过。
- **手动真机截图**：`npm run panel:opencode`（`--panel-opencode-shot`，不是默认取证）
  在面板里选 OpenCode Go、API Key 留空、点 🔄，真实端点返回 **30 个模型**，
  截图 `logs/evidence/panel-opencode-models.png`，证据
  `logs/evidence/panel-opencode-models.json`。默认 `npm run panel:shot` 仍只用
  127.0.0.1 桩，不访问外网。
