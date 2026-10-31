# 0008. 给 `OrchestratorState` 增加 `idle` 取值

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-10-27 |
| 决策者 | 项目所有者 |
| 关联 | `CONTRACTS.md` §4.1、§4.2、§7.1、§15（1.3.0）；`docs/MODULE_STATUS.md` |

## 背景

`§7.1` 把 `RenderState.orchestrator` 定义为"orchestrator 的只读镜像"，类型是：

```ts
export type OrchestratorState = 'thinking';
```

但这个枚举**只有一个取值**。`render` 在渲染进程、`orchestrator` 在主进程，镜像字段至少要有"在思考 / 不在思考"两种取值才有意义。落地 render 模块时（第 2 步）真实撞上了这个洞：`getState()` 无论 orchestrator 在不在都只能填 `'thinking'`，等于常量，任何消费方据此判断都会永远为真。

同时 `Base.idle`（站立待机）已经占用了 `idle` 这个词，新取值与它同名——这本身不是问题（分层状态机里同名不同层很常见），但必须把"怎么区分"写死，否则后面一定会有人发明 `orchestratorIdle`、`isOrchestratorIdle` 之类的别名。

## 决策

1. `OrchestratorState` 改为 `'thinking' | 'idle'`：
   - `thinking` = 已收到用户话语、尚未产出回复（含义不变，仍是 §4.1 那一行）；
   - `idle` = 编排层没有在途话语（启动后默认值、产出 `Reply` 后、`cancel()` 后）。
2. **同名不同层，靠字段访问区分**，不靠名字区分：
   - `getState().base === 'idle'` → Base 层站立待机；
   - `getState().orchestrator === 'idle'` → 编排层没有在途话语。
3. §4.1 状态表为编排层的 `idle` **单列一行**，并在定义里显式写"与 Base.idle 同名不同层，不是同一个状态"。
4. §4.2 增加一条消除歧义的说明：禁止为区分层次而发明别名（`orchestratorIdle`、`baseIdle`、`orchIdle` 等一律禁止）；需要区分时读对应字段。
5. `render` 本轮把 `getState().orchestrator` 从常量 `'thinking'` 改为 `'idle'`（orchestrator 尚未实现，事实就是"没有在途话语"）。

## 替代方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 保持单值枚举 | 零改动 | 字段恒为真，镜像语义不成立；消费方必然误用 | 否 |
| 把字段改成 `boolean` | 语义直白 | 要改 `RenderState` 结构（§7.1），且与"镜像"这个词的粒度不符；以后编排层若再加状态又得改结构 | 否 |
| 新增 `'orchestrator_idle'` 之类的独立词 | 无歧义 | 与 §4.1 的命名风格冲突（状态名不带到模块前缀，§6.2 N-5 同理）；且破坏了"同名不同层"的可读性 | 否 |
| `OrchestratorState = 'thinking' \| 'idle'` + 字段区分（本方案） | 保留镜像粒度；不引入新词；分层同名可读 | 需要一条明确的消歧规则（已写入 §4.2） | **是** |

## 后果

**正面**

- `RenderState.orchestrator` 变成可用的二值镜像，`shell`/`render` 后续都能据此判断。
- 借这次改动把"同名不同层靠字段区分"写成规则，避免后续为 `idle` 造别名。

**负面 / 成本**

- 契约 minor 升版（1.2.1 → 1.3.0），所有读取 `RenderState` 的实现要重新对照一次。
- 文档里 `idle` 出现两次，读过旧版的人需要看到 §4.2 的消歧说明。

**约束**

- 禁止新增 `orchestratorIdle` / `baseIdle` / `orchIdle` 等别名词。
- 禁止用字符串比较以外的手段"猜"层次（例如按调用方推断）。
- 编排层若再增加状态，必须新出 ADR，不得在代码里私加字符串。
