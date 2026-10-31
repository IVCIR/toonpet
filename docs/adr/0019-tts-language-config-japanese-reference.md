# 0019. TTS 语种配置：日文参考音频（`prompt_lang=ja`）+ 中文合成（`text_lang=zh`）

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-10-30 |
| 决策者 | 项目所有者 |
| 关联 | 修订 ADR 0015 D2.3 的"`prompt_lang` 默认 zh"；`CONTRACTS.md` §7.4（`voice` 接口与 `/tts` 字段）；`PET_TTS_PROMPT_LANG` / `PET_TTS_TEXT_LANG`；ADR 0018 D1（`.env` 配置来源） |

## 背景

本机 `data/ref/kaiyi.wav`（4.28s）是**日文**参考音频，而角色对用户说**中文**。

GPT-SoVITS 的 `/tts` 把语种拆成两个独立参数，且都是**必填**：

| 参数 | 作用 |
|---|---|
| `prompt_lang` | 参考音频/`prompt_text` 的语种（决定参考文本怎么被音素化） |
| `text_lang` | 要合成的 `text` 的语种 |

旧默认值在 `src/shared/constants.ts` 里是 `TTS_PROMPT_LANG = 'zh'`。这会造成两种情况：

1. 如果参考文本是日文、却按 `zh` 做 G2P，日文假名会被中文前端吞掉/读错，参考语义特征失真，音色与韵律明显跑偏；
2. 若有人把 `prompt_lang` 写成不支持的值（例如 `japanese`、`zh-CN`），服务端直接 400：`prompt_lang: xx is not supported in version v2ProPlus`，应用只能走"字幕 + 无语音"。

v2ProPlus 的语言集合（源码实测，`GPT_SoVITS/TTS_infer_pack/TTS.py` 的 `v2_languages`）是：

```text
auto, auto_yue, en, zh, ja, yue, ko, all_zh, all_ja, all_yue, all_ko
```

它支持**跨语种**：日文参考 + 中文合成是合法组合。

## 决策

### D1 默认值：`prompt_lang=ja`、`text_lang=zh`

1. `TTS_PROMPT_LANG = 'ja'`：本机参考音频是日文，这是"开箱即对"的默认。
2. `TTS_TEXT_LANG = 'zh'`：角色对用户说中文。
3. 二者都可用 `.env` 的 `PET_TTS_PROMPT_LANG` / `PET_TTS_TEXT_LANG` 覆盖（进程环境变量优先，ADR 0018 D1）。
4. 应用侧把语种统一 `toLowerCase()`（`readLang`）：日志、doctor 与请求体保持同一份小写值，避免 `JA` 与 `ja` 看起来像两份配置。
5. 换参考音频 = 同时改 `PET_TTS_PROMPT_LANG` 与 `PET_TTS_PROMPT_TEXT`；只改一个必然错配。

### D2 请求载荷只从 `TtsConfig` 取值，禁止写死

`gpt-sovits-client.ts` 的请求体：

```ts
text_lang: config.textLang,
prompt_lang: config.promptLang,
```

`TtsConfig` 来自 `resolveAppConfig()`，其值来自 `PET_TTS_PROMPT_LANG` / `PET_TTS_TEXT_LANG`。客户端里不得再出现字面量 `'zh'` / `'ja'` 作为语种。启动日志 `TTS 已配置` 同时打印 `promptLang` / `textLang`，便于排查"到底发了什么"。

### D3 `doctor` 校验语种，而不是只展示

`scripts/doctor.mjs` 新增两项检查（`参考语种` / `合成语种`）：

1. 取值必须属于 v2ProPlus 合法集合；否则判红并给出正确写法。
2. 明显错配给黄色提醒：
   - 参考文本含日文假名，但 `prompt_lang` 是 `zh` / `all_zh` → 应改 `ja`；
   - `prompt_lang` 是 `ja` / `all_ja`，但参考文本不含假名 → 提醒确认音频是否真是日文（明确写"确认"，不判红，因为纯汉字日文是合法存在）。
3. 参考文本为空时仍检查语种取值；"参考文本"本身仍是独立红色项（§11 的 TTS 未配置）。

### D4 文档与模板

- `.env.example`：把两个变量从注释改为**生效行**，默认 `ja` / `zh`，并列出合法值与 `all_*` 语义。
- `.env`（本机，不入库）：写入 `PET_TTS_PROMPT_LANG=ja` / `PET_TTS_TEXT_LANG=zh`。
- `docs/guides/LOCAL-SERVICES.md`：新增 §3.3"多语言：日文参考 + 中文回复"，更新 §0 状态、§2.4 实测、§2.5 字段说明、§5 环境变量表、§7 故障表。

### D5 契约不动

`CONTRACTS.md` §7.4 只规定 `/tts` 的字段与归属，没有规定语种默认值；本次没有新增字段、事件、接口或依赖，因此**不升契约版本**。ADR 0015 D2.3 的"`prompt_lang` 默认 zh"由本 ADR 修订（ADR 只增不改）。

## 替代方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 保持默认 `zh`，只在 `.env` 写 `ja` | 不改代码默认值，影响面最小 | 没有 `.env` 的机器（或 `doctor` 之前）默认就是错的；新克隆仓库首次运行必错配 | 否 |
| 默认 `ja`（本方案） | 与本机唯一参考音频一致；开箱即对 | 若将来换成中文/英文参考音频，必须显式改 `.env` | **是** |
| 默认 `auto` | 看似免配置 | `auto` 的行为依版本/文本而变，不可复现；参考文本语种错判时更难排查 | 否 |
| 把 `prompt_lang` 写死 `'ja'` | 少一个配置项 | 换音频就要改代码；测试无法证明"读配置" | 否 |
| 从 `prompt_text` 自动猜语种（假名→ja） | 用户少填一项 | 纯汉字日文/中文无法区分；猜错时错误更隐蔽 | 否 |
| 用 `all_ja` 作为默认 | 纯日文文本更"强制" | `all_*` 面向整段纯语言文本；参考文本里混英文/数字时反而受限 | 否（保留为可选值） |
| doctor 只打印不校验 | 实现最简 | 写错只能等服务端 400，且错误在对话时才暴露 | 否 |

## 后果

**正面**

- 日文参考音频第一次有了正确的默认语种；不再需要"记得设环境变量"才不会跑偏。
- 跨语种链路有真机证据：`prompt_lang=ja` + `text_lang=zh` → HTTP 200 / 3.97s / 111,404 字节 RIFF。
- 语种错误从"对话时才发现"前移到 `doctor`（取值非法直接红，文本语种错配黄）。
- 载荷由配置驱动，并有单测锁死（用 `en`/`ko` 非默认组合证明不是写死）。

**负面 / 成本**

- 默认 `ja` 只对"日文参考音频"正确；换音频必须同步改两个变量，这写进了模板与手册。
- `doctor` 的"ja 但无假名"提醒可能对纯汉字日文误报为黄色（不判红，可忽略）。
- 多两个配置项，`.env` 模板变长了一点。

**约束**

- 不得在 `gpt-sovits-client.ts` 里写死语种字面量；必须走 `TtsConfig`。
- `prompt_lang` 与 `prompt_text` 必须同语种、逐字一致；不得只改其一。
- 不得用"从文本猜语种"替代显式配置。
- 语种取值必须是 v2ProPlus 的合法集合；`all_*` 只在整段纯语言文本时使用。
- 换参考音频后必须重启应用（`.env` 只在启动读取）并重新跑 `doctor`。

## 验证（2026-10-30，本机）

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | 0 错 |
| 单测 | **171 个全绿**（voice 14，新增"语种来自配置"1 条；config 默认/覆盖断言已补 ja/zh 与小写归一化） |
| `doctor` | `参考语种 prompt_lang=ja` 绿、`合成语种 text_lang=zh` 绿；因参考文本留空，仍 1 项红（16 通过 / 1 缺失） |
| 真实 `/tts`（ja 参考 + zh 合成） | HTTP **200**，**3.97s**，**111,404 字节**，`RIFF/WAVE` |
| 说明 | 该验证用的是**占位日文** `prompt_text`，只证明"语种组合 + 跨语种链路可用"，不代表音色/韵律已按真实逐字文本验收 |
