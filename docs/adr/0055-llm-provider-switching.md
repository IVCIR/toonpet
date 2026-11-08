# 0055. LLM 提供商自由切换：本地 Ollama / OpenAI 兼容 / OpenCode Go

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-11-08 |
| 决策者 | 项目所有者（"除了本地 Ollama 和通用 OpenAI 兼容 API，还需要原生支持 OpenCode Go 订阅服务"） |
| 关联 | 契约 §3.5（跨进程通道）、§7.6（`respond` 永不 reject）、§7.8（控制面板）、§7.10（提供商）、§9.1（三路分流）、§9.3（提示词）、§10.2（默认回环 + 用户显式远程）、§11（失败与降级）、§12（thinking 预算）；ADR 0015（LLM 客户端）、ADR 0032/0033（预热/心跳）、ADR 0052/0053（面板、模型切换） |

> 后续：ADR 0056 已把"模型名手填"改为 `fetchModels()` + Combobox（OpenCode Go / OpenAI 兼容 / Ollama 都可拉取清单）。本 ADR 中"模型必须手填"的描述保留为当时的决策记录，不再是现行行为。

## 背景

ADR 0015 的 `LlmClient` 只有一个实现：本地 Ollama。ADR 0053 让面板能换 Ollama
的模型，但"换模型"仍被锁在 `qwen3:4b`/`qwen2.5:7b` 这一族里。真实使用中出现了三类需求：

1. **本地模型不够用时，用户手里往往有一个 OpenAI 兼容端点**（vLLM、LM Studio、
   OpenRouter、公司网关）。它们的协议一样，差别只在 base URL、Key 和模型名。
2. **OpenCode Go 是订阅服务**，不是"再填一个 base URL"：端点固定、鉴权用 Key、
   模型名必须手动输入（服务端清单变化不受本应用控制）。
3. **切换必须立刻生效且失败可见**：不能要求重启，也不能在 Key 错/网络断时
   让桌宠"突然不说话"却没有任何解释。

ADR 0053 已经解决了"换模型要重启"和"换模型清零熔断/预热"两个问题，
本轮把"模型"抽象成"提供商"，并在同一套面板/持久化/失败口径上扩展，
**不改状态机、不改事件白名单、不新增 IPC 通道、不新增定时器**。

## 决策

### D1 一个端口，三个实现：`LLMProvider`

`src/main/orchestrator/llm-client.ts` 保留 `LlmClient` 作为编排层唯一认识的端口
（`health` / `chat` / 可选 `warmup`），新增：

```ts
interface LLMProvider extends LlmClient {
  readonly providerId: string;
  readonly providerType: 'ollama' | 'openai' | 'opencode-go';
  readonly providerName: string;
}
```

- `createOllamaProvider`：原 `createLlmClient` 的实现原样搬入（`/api/tags`、
  `/api/chat`、`/api/generate` 预热、8s 硬超时、`format:'json'`、`think:false`）。
- `createOpenAiProvider`：`GET {base}/models` + `POST {base}/chat/completions`，
  `Authorization: Bearer <key>`，`response_format:{type:'json_object'}`，
  `temperature:0.8`、`max_tokens:256`；不实现 `warmup`（云端没有"加载权重"，
  心跳自然走 `no-warmup` 跳过）。
- `createOpenCodeGoProvider`：即 `createOpenAiProvider` 且 **base URL 恒为**
  `https://opencode.ai/inference/go/openai/v1`（配置里的值被忽略，见 D3）；每个实例生成稳定的
  `x-opencode-session: ses_…` 请求头，并带自己的 User-Agent。
- `createLlmProvider(config)` 是唯一分发点；`createLlmClient(config)` 保留为
  "本地 Ollama"的兼容别名，旧调用点与旧单测不需要改。

**为什么不让 orchestrator 认识 `LLMProvider`**：编排层只关心"发一条、拿一条"。
把提供商身份塞进 `orchestrator` 会让 §9.1 的三路分流多出一个它不需要的维度；
身份只用于日志、面板和诊断（`RuntimeSnapshot.llm.provider*`）。

### D2 配置：`llm.providers[]` + `llm.activeProvider`

`config.json` 的新形态（ADR 0053 的 `llm.model` 仍可读，作为旧格式）：

```json
{
  "version": 1,
  "llm": {
    "activeProvider": "oc",
    "providers": [
      {
        "id": "local-ollama",
        "type": "ollama",
        "name": "本地 Ollama",
        "baseUrl": "http://127.0.0.1:11434",
        "apiKey": "",
        "model": "qwen3:4b"
      },
      {
        "id": "oc",
        "type": "opencode-go",
        "name": "OpenCode Go",
        "baseUrl": "https://opencode.ai/inference/go/openai/v1",
        "apiKey": "oc_sk_…",
        "model": "glm-5.3-flash"
      }
    ]
  }
}
```

- `src/shared/llm-providers.ts` 是**纯数据 + 纯校验**的唯一出处，主进程与面板共用；
  不 import Electron。
- 旧格式迁移：`llm.providers` 缺失/为空时，`llm.model`（若有）作为本地 Ollama 的模型；
  运行时**永远至少保留一个本地 Ollama 提供商**（用户只配了远程时自动追加），
  这是"本地 Ollama 作为默认回退选项"的硬约束。
- 面板每次写 `config.json` 都同时带上 `providers` 与 `activeProvider`，
  避免"保存参数"把提供商列表覆盖掉（`writeConfigWithProviders`）。
- `activeProvider` 指向不存在的 id → 解析为 `null`，运行时选第一个（优先本地 Ollama）。

### D3 安全：远程只在用户显式添加时出现

- **默认永远只连回环**（ADR 0015 / §10.2 不变）。远程端点只可能来自
  `config.json.llm.providers` 里用户亲手添加的项。
- `ollama` 类型：只允许 `http` + 回环（`127.0.0.1` / `localhost` / `::1`），返回 `origin`。
- `openai` 类型：只允许 `https`（回环可用 `http`），保留路径（例如 `/v1`）、去掉尾斜杠；
  拒绝 URL 内嵌账号密码、查询串、锚点；拒绝 `file:` 等非 HTTP(S)。
- `opencode-go` 类型：base URL **不允许**被配置改写，校验函数直接返回预设常量；
  UI 上该字段只读。
- **API Key**：只存 `config.json`，不写日志（只记"已配置/未配置"），不进
  `PanelStatus`（面板只拿 `hasApiKey`），UI 用 `type=password`；编辑时留空 = 沿用旧 Key。
  日志脱敏函数 `maskApiKey` 只在诊断里用（`sk-…cdef`），**永远不返回完整 Key**。
- 这是有意的取舍：SSRF 面从"任意用户输入 URL"收缩到"用户显式添加的远程端点"，
  与 §10.2 的威胁模型一致（本应用不是多租户服务）。

### D4 运行期切换：与 ADR 0053 完全同构

`runtime.panel().applyProvider / activateProvider / deleteProvider` 都走同一条内部路径：

1. `createLlmProvider(provider)` 造新客户端（先造后换，失败不留半更新）；
2. `orchestrator.replaceLlm(client, reason)`：换引用 + **清零 `llmHealthChecked` /
   `llmDisabled`**（§11 的"一次失败"只属于同一个提供商）；
3. `heartbeat.retarget(client, reason)`：换引用 + **清零 `warmedUp` / `attempts` /
   `lastAttemptAt`**（旧提供商热过不代表新提供商热过）；
4. 更新 `providers` / `activeProviderId`，日志只记身份与"Key 是否配置"。

- **不打断在途请求**：在途 `respond` 捕获旧客户端，用旧提供商说完这一句；下一轮才换。
- **删除**：至少保留一个；删的是当前生效项时自动切到剩下的第一个（并再次走 1–3）。
- **失败不崩**：提供商切换本身只做"建客户端 + 换引用"，不发起网络请求；
  连接失败由 `provider-test`（面板按钮）或下一轮真实对话暴露。真实对话失败仍走
  §9.1 的规则/兜底，并触发 §11 熔断；面板显示 `llmDisabled` 与"连接失败"测试徽标。

### D5 连接测试：`provider-test`（面板动作，非契约事件）

`PanelBackendLike.testProvider(id)` → `LLMProvider.health()`：

- Ollama：`GET /api/tags`，模型必须在清单里（沿用 ADR 0015 的精确/`:latest` 等价匹配）。
- OpenAI 兼容 / OpenCode Go：`GET {base}/models`（健康预算至少 5s，避免跨公网时把健康端点误判为不可用）：
  - 2xx：成功；若返回清单，则 `modelPresent` 表示模型是否在清单里（清单为空 = `null`，
    不据此判失败——很多网关不返回完整清单）；
  - 401/403：明确失败，detail 提示"API Key 可能无效"；
  - 404/405：端点不提供 `/models`，退化为一次 1-token 对话验证 Key 与网络；
  - 其他非 2xx / 网络错误 / 超时：失败，detail 带状态码或原因。
- 结果只存**面板内存**（`Map<id, PanelProviderTestFacts>`），不写盘、不进事件、
  不改熔断；面板用 `ok` / `failed` 徽标显示"已连接 / 连接失败"。
- 激活提供商后自动测一次；**测试失败不影响已完成的切换**（用户仍可用它，
  下一轮对话会走兜底并熔断——面板会同时显示这两个事实，不替用户做决定）。

### D6 面板：提供商列表 + 表单 + 测试/删除

- "AI 人格"页顶部新增"LLM 提供商"卡片：
  - 列表项显示名称、类型、模型、base URL、Key 状态、当前生效徽标、连接测试徽标；
  - 按钮：使用（切换）/ 测试 / 编辑 / 删除（只剩一个时禁用）；
  - 表单：类型（Ollama / OpenAI 兼容 / OpenCode Go）、名称、Base URL、API Key、模型；
    - Ollama 的模型从 `/api/tags` 下拉选，也允许手填（清单为空时）；
    - OpenCode Go 的 Base URL 只读并预填预设，模型必须手填（服务端清单会变）；
    - API Key 输入框 `type=password`，编辑时留空 = 沿用旧值。
- 旧的"本地模型快速切换"卡片保留，但**只改本地 Ollama 提供商**；当前生效的是远程时，
  卡片明说"不会影响它"，按钮文案变为"更新本地"。
- `status.providers` 是只读投影（无 Key），随 4Hz 状态推送刷新；
  每次 provider 动作的 `PanelResult` 也直接带最新列表，面板据此原子刷新。

### D7 可观测事实

- `RuntimeSnapshot.llm` 新增 `providerId` / `providerType` / `providerName`。
- `PanelPersonaFacts` 新增 `llmProviderType` / `llmProviderName` / `llmProviderId`。
- `PanelStatus.providers`（`PanelProviderFacts[]`）+ `PanelResult.providerTest`。
- 日志：装配、切换、删除、保存各一条，字段固定为 id/type/name/baseUrl/model/
  `apiKey: 已配置|未配置`；**不含 Key 明文**。

## 备选方案

1. **在 `LlmClient` 上直接加 `providerType` 字段，不做新接口**：编排层会开始看到
   它不需要的提供商概念，且面板/诊断与传输耦合。`LLMProvider extends LlmClient`
   把"身份"限制在装配与展示层，代价是多一个类型。
2. **OpenCode Go 用通用 OpenAI 类型 + 用户手填 base URL**：用户需要知道固定端点，
   且配置错误会在运行时才暴露。类型即预设更符合"原生支持"的要求，也让 UI 少一个错误面。
3. **自动 fallback 到本地 Ollama**：用户可能正想用远程，静默换提供商会让"为什么回答变了"
   无法解释。本轮保持 §9.1 的规则/兜底降级，不自动切提供商；面板显示失败原因，
   由用户点"使用"切回本地。若未来需要，应作为独立 ADR（带预算/重试策略）。
4. **把 Key 加密存进系统凭据库**：Windows 凭据管理器需要额外依赖/原生调用，
   本轮明确"Key 只存本机 config.json"，与 ADR 0052 的配置文件同级；
   威胁模型是"本机用户"，不是"防本机恶意软件"。

## 后果

- 正面：本地/远程/订阅三类提供商共用一条 `respond` 路径；切换无需重启；
  失败可见（面板徽标 + 兜底回复）；旧 `config.json` 与旧调用点无需迁移。
- 负面：`config.json` 里出现明文 Key（已在 UI/日志/文档三处标注）；
  远程端点意味着网络请求可能离开本机，用户必须显式添加；
  OpenAI 兼容端点的 `/models` 行为不一致，测试逻辑有 404/405 降级分支。
- 不做：提供商级自动重试/自动切换、流式输出、多 Key 轮换、模型清单远程拉取进下拉
  （OpenCode Go 的模型名由用户手填）。

## 验证

- `llm-providers.test.ts`：地址规则（回环/https/拒绝凭证与查询串）、OpenCode 预设不可改写、
  模型字符集、Key 留空沿用旧值、脱敏。
- `llm-client.test.ts`：OpenAI 兼容的 `/models` 成功/401/404 降级、`chat` 的 Bearer 与
  响应解析、超时四值；`createLlmProvider` 的 Ollama/OpenCode 分发与身份字段。
- `panel-config.test.ts`：提供商解析/坏项跳过/active 不存在/新格式写盘/旧格式回退。
- `panel:shot`：真实面板新增一个回环关闭端口上的 OpenAI 兼容提供商 → 写入 `config.json`
  → 点"使用" → 运行时真的换了提供商 → 面板显示"连接失败"且应用不崩；截图
  `panel-providers.png`；脚本退出前还原用户 `config.json`。
