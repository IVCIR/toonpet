# ADR 0030：在场感（presence）与提示词段 3.5「环境事实」

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-11-01 |
| 关联 | 契约 1.10.0 §7.5、§9.3；ADR 0020（记忆）、ADR 0031（idle-drive） |
| 影响模块 | `orchestrator`、`shell`（只读 Win32）、新增 `presence` |

## 背景

1.9.0 的提示词是**无时间**的：段 1 输出约束、段 2 角色卡、段 3 记忆、段 4 最近 6 轮、段 5 当前话语。
模型永远不知道"现在几点"、"用户是不是刚坐下"、"上次说话是 12 分钟前还是昨天"。

参考项目 Azalea 的灵魂感几乎全部来自一句话（`pet/ai.py:179`）：

```
现在是 2026-11-01 21:14:07，距离桌宠上一次做出行为过去了 93.42 秒。请根据截屏判断桌宠的行为。
```

它的载体是"每 10 秒一次全屏截图 + 视觉大模型"。这条路我们**明确不走**（`docs/adr/` 之外还有两条硬约束：
不引全屏截图、不新增网络请求）。本 ADR 记录的是"只要事实、不要像素"的替代方案。

## 决策

### D1：新增 `presence`（只读端口，Win32）

`src/main/presence.ts` 提供 `getSnapshot(): PresenceSnapshot`：

```ts
{ userIdleMs: number | null, foregroundTitle: string, foregroundClass: string, at: number }
```

- **空闲毫秒**来自 `GetLastInputInfo` + `GetTickCount`（系统级，含键盘与鼠标）；
- **前台窗口**来自 `GetForegroundWindow` + `GetWindowTextW` / `GetClassNameW`；
- 两者都在 `user32.dll`，与 `shell/foreground-window.ts` 各自 load 一次——那边要的是 DWM 边框矩形
  （吸附几何），这边要的是语义；互不 import，避免把吸附逻辑拖进语义层。

#### D1.1 `GetTickCount` 在 kernel32，不在 user32

实测：`user32.dll` 中 `koffi.func('uint32 __stdcall GetTickCount()')` 直接抛
`Cannot find function 'GetTickCount' in shared library`；改从 `kernel32.dll` 取即成功。
`LASTINPUTINFO.dwTime` 的时基正是 `GetTickCount`，**不能**用 `performance.now()` 替代。

#### D1.2 `GetLastInputInfo` 必须声明 `_Inout_`

实测三种写法：

| 签名 | `ok` | `dwTime` | 结论 |
|---|---|---|---|
| `_Out_` | 0 | 0 | koffi 不把 `cbSize` 传进去，恒失败 |
| 省略注解 | 0 | 0 | 同上 |
| `_Inout_` | 1 | 68669453 | 正确 |

`cbSize` 必须等于 `sizeof(LASTINPUTINFO)` = 8（两个 `uint32`）。这两个坑都会表现为"代码能编译、值恒为 0"。

#### D1.3 懒采样，不开定时器

`getSnapshot()` 内部按 `PRESENCE_SAMPLE_INTERVAL_MS`（2s）节流：读的时候才判断是否需要重采。
**没有 setInterval**，因此不构成契约 §12 所说的"第二个轮询器"（那一条约束的是 16ms 指针轮询，它服务穿透与位移）。
时钟回拨（`at < sampledAt`）时强制重采。

#### D1.4 失败一律折算为"未知"

koffi 未安装、绑定失败、调用抛异常 → `userIdleMs: null` + 空标题，**永不抛异常**。
"未知"在语义上等于"不要猜"，由 D2 的消费方决定降级行为（见 ADR 0031 D2.3）。

### D2：提示词新增段 3.5「环境事实」（插在段 3 与段 4 之间）

`buildPrompt({..., world?: WorldFacts})`。**`world` 缺省时不产生任何字节变化**——这是"现有单测零改动"的机制保证，
也是 presence 不可用时的退化形态（只剩时间戳，见 D5）。

段 3.5 是**一行自然语言**，不是 JSON：小模型对"距上次行为过去 93 秒"远比 `{"idleMs":93000}` 敏感
（与 Azalea 同源的判断）。上限 `WORLD_SEGMENT_MAX_CHARS`（160 字）。

### D3：格式（可逐字断言）

```
環境: 2026-11-01 21:14 / 先生は 90 秒前まで入力中 / 前面のアプリ: Visual Studio Code / 前回の会話から 12 分
```

| 分项 | 规则 | 缺项时 |
|---|---|---|
| 时间 | `YYYY-MM-DD HH:mm`（本地时区，手工补零） | 永不缺失 |
| 输入状态 | `userIdleMs < 5s` → `先生は今入力中`；否则 `先生は {时长}前まで入力中` | `userIdleMs === null` → 整项省略 |
| 前台应用 | 标题优先、类名兜底，截断 48 字 + `…` | 两者都空 → 整项省略 |
| 上次会话 | `前回の会話から {时长}` | `lastInteractionAt === null` → 整项省略 |

时长单位：`< 2min` 用秒（ADR 的示例就是"90 秒"）、`< 1h` 用分、`< 1d` 用時間、其余用日。

`未知` 不作输出：小模型会把"未知"当成一个需要解释的事实，反而答非所问。

**超长降级顺序固定**：先截应用名 → 再丢"上次会话" → 再丢应用名 → 再丢输入状态；时间戳永远保留。
顺序固定是为了让同一输入永远产出同一字节串（段 3.5 必须可单测）。

### D4：段 3 的两处改造（相对时间 + 去冗余 + 预算）

#### D4.1 相对时间

`[10-30]` → `[3日前]` / `[昨日]` / `[今日]` / `[4ヶ月前]` / `[2年前]`。
按**本地日历天**差计算（`localDayStart`），因此"昨晚 23:50"与"今早 00:10"是 `昨日` 而不是 `今日`。
`formatMemoryFacts(facts, limit, now?)`：给了 `now` 用相对时间，没给保持 1.9.0 的绝对时间（向后兼容）。

#### D4.2 去冗余

同 `tags` 且三字组 Jaccard ≥ 0.8 视为同一件事，只留先出现的那条。
先出现的必然是 `hits` 更高或同分更晚的那条（调用方已按 §7.5 排好序），**排序规则一个字没改**。

#### D4.3 预算

段 3 全部记忆行合计上限 `MEMORY_SEGMENT_MAX_CHARS`（360 字）。超出即停止装填（不二次截断行内文本）。
理由：5 条 × 120 字的最坏情况会把"记忆"顶到角色卡的两倍，压过真正定义人格的那一段。

### D5：降级矩阵（与 §11 对齐）

| 故障 | 表现 |
|---|---|
| koffi 未安装 | presence 记一条 WARN；段 3.5 只剩时间戳；idle-drive 永不触发 |
| `GetLastInputInfo` 返回 0 | 本次 `userIdleMs: null`；同上 |
| 没有前台窗口（`hwnd = 0`） | 标题/类名为空；段 3.5 省略应用项 |
| 标题含换行/控制字符 | `sanitizeWindowText` 压成单空格，段 3.5 永远单行 |
| `buildPrompt` 未传 `world` | 与 1.9.0 逐字节一致（单测锁死） |

## 后果

**正面**：模型第一次知道"此刻"；主动性有了唯一可信的"要不要打扰"依据；全部零成本、零出站、零新依赖。

**负面 / 已知取舍**：

- 前台**标题**可能含用户文档名（如 `report-final.docx - Word`）。它只进本机 `127.0.0.1` 的 Ollama 请求，
  不出网；但仍建议后续做"应用名归一化"（ADR 未定，见 MODULE_STATUS 下一步）。
- 段 3.5 让**每次请求**的 system 段都不同，提示词不再可复现——这是特性（时间感）的代价；
  单测只能断言"存在且格式正确"，不能断言整串相等。

## 被否决的备选

| 备选 | 否决理由 |
|---|---|
| 全屏截图 + 多模态 | `qwen3:4b` 无视觉能力；每 10s 一次全屏编码是 CPU 白烧 + 隐私面扩大；违反本次硬约束 |
| 读剪贴板 | 内容不可控（密码、代码、私人文本），且对"要不要开口"这个决策没有增量信息 |
| 枚举所有窗口 | 只为一句话需要的信息量过大；`GetForegroundWindow` 一次调用就够 |
| 用 `screen.getCursorScreenPoint()` 算活动 | 违反 §12（会变成第二个指针轮询器），且漏掉纯键盘操作 |
| 段 3.5 用 JSON | 小模型对结构化字段不敏感；且与"段 3 是纯文本"的既有风格冲突 |
