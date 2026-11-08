# 本地服务联调手册（Ollama + GPT-SoVITS）

| 项 | 值 |
|---|---|
| 适用版本 | 契约 1.4.1 / ADR 0015（本地 LLM 与 TTS 部署）、ADR 0016（输入条与热键）、ADR 0018（`.env` / 输出清洗 / 托盘） |
| 目标读者 | 第一次在自己机器上把"对话 + 语音"跑起来的人 |
| 前置 | Windows 11 x64、Node 20+、仓库依赖已安装（`npm install`）、`npm run build` 通过 |
| 成本约束 | **运行期零出站、零按次计费**：只连 `127.0.0.1`，不下载模型、不拉起服务、不用云 API |

> 一句话流程：**装 Ollama → `ollama pull qwen3:4b` → 起 GPT-SoVITS（凯伊配置）→ 复制 `.env.example` 为 `.env` → 放参考音频并填 `PET_TTS_PROMPT_TEXT` → `npm run doctor` 全绿 → `npm start`**。

---

## 0. 一分钟自检：`npm run doctor`

```powershell
cd D:\aa3dpet-app
npm run doctor
```

它**只读**文件、只连本机回环端口，不修改任何东西、不启动任何服务。输出是一份清单：

| 输出 | 含义 |
|---|---|
| `✔` 绿色 | 就绪 |
| `!` 黄色 | 可运行但有提醒（例如 CPU 超时仍是默认值） |
| `✘` 红色 | 缺失；按本手册对应小节补上 |

`doctor` 的退出码恒为 0——它是诊断工具，不是构建门槛（门槛是 `npm test` / `npm run selftest*`）。

> `doctor` 与运行时使用同一套配置来源（ADR 0018 D1）：先读工程根目录 `.env`，再叠加进程环境变量（**进程环境变量优先**）。所以 `.env` 里的值会同时影响 `doctor`、`npm start` 与自检。

**本机当前状态（2026-10-30 实测，逐项以你自己的 `doctor` 输出为准）**

| 项 | 状态 | 说明 |
|---|---|---|
| `.env` | 就绪 | 工程根目录已建；超时 15000 / 120000，参考文本已填，`text_lang=ja` |
| Ollama 服务 | 就绪 | `127.0.0.1:11434` 可访问（doctor 显示 4 个模型） |
| `qwen3:4b` | 就绪 | 已 `ollama pull`；`/api/tags` 能匹配到 |
| 真实回复 | 就绪 | 冷启动首问约 10s（会撞 8s 预算）；预热后 **1.3–2.6s**，`route=llm` 实测通过 |
| GPT-SoVITS | 就绪（已用凯伊配置重启） | 9880 在听；启动日志确认 `KaiYi-e10.ckpt` + `KaiYi_e18_s288.pth` |
| 参考音频 | 就绪 | `data/ref/kaiyi.wav`：4.28s / 44100Hz / 单声道 / 16bit，**日文** |
| TTS 语种 | 就绪 | `prompt_lang=ja` / `text_lang=ja`（角色只说日文，ADR 0022） |
| `PET_TTS_PROMPT_TEXT` | 就绪 | 已填该日文音频的逐字文本（20 字）；`doctor` 参考文本项转绿 |
| 记忆库 | 就绪 | `data/memory.db` 首次对话后生成；`doctor` 的"记忆库"与"SQLite 原生模块"两项均绿 |

也就是说：**对话链路（真实 LLM）+ 字幕时序 + 语音合成 + 本地记忆都已就绪**。剩下的是按真实逐字文本做一次音质/韵律试听（见 §3.2）。

---

## 1. Ollama（本地 LLM）

### 1.1 安装

1. 到 <https://ollama.com/download/windows> 下载 `OllamaSetup.exe`（官方安装包，约数百 MB，一次性出站）。
2. 安装后确认服务在跑：

```powershell
Get-Process ollama -ErrorAction SilentlyContinue
Invoke-RestMethod http://127.0.0.1:11434/api/tags | ConvertTo-Json -Depth 4
```

> 安装与 `pull` 是**部署期**的一次性出站；应用运行期不会联网、不会自动拉取（ADR 0015 D1.2）。

### 1.2 拉模型

```powershell
ollama pull qwen3:4b
```

- 契约 §9.4 的默认模型是 `qwen3:4b`（4B 级、Ollama 默认量化）。
- 体积约 2.5 GB，视网络 5–30 分钟。
- **不要**在 `.env` 里配置云端模型：`PET_LLM_URL` 只接受回环地址（ADR 0015 D6，启动期校验，配错直接拒绝启动）。
- 需要 OpenAI 兼容 / OpenCode Go 时，走控制面板 →「AI 人格」→「LLM 提供商」显式添加（ADR 0055）；它写进 `config.json.llm.providers[]`，默认仍保留本地 Ollama。远程请求会离开本机，可能产生订阅/接口费用。

### 1.3 验证 `/api/tags`

```powershell
$tags = Invoke-RestMethod http://127.0.0.1:11434/api/tags
$tags.models | Select-Object name, size
```

应能看到 `qwen3:4b`（Ollama 有时把它规范化为 `qwen3:4b:latest`，应用两种写法都认）。

### 1.4 应用的匹配规则

| 情形 | 应用行为 |
|---|---|
| 服务未启动（连接拒绝/超时） | 健康检查失败 → **本会话熔断**，直接走兜底，`llm_failed{unavailable}`（§11） |
| 服务在、模型不在列表 | 同上（判 `unavailable`，日志列出 `/api/tags` 里的真实模型名） |
| 模型在、输出带 Markdown / 括号动作 / 代码围栏 | 先剥装饰并提取 JSON，再做一次字段修复；清洗后仍不合法 → `llm_failed{invalid_output}` → 兜底（§9.2 / ADR 0018 D2） |
| 推理超过 8s | `llm_failed{timeout}` → 兜底；**不熔断**，下一次话语仍会尝试（ADR 0015 D1.6） |

> 熔断是**会话级**的：中途启动 Ollama 不会自愈，必须重启桌宠（§11 明写，不提供"重探"开关）。

### 1.6 本机 CPU 推理与 8s 预算（实测）

本机无 NVIDIA 驱动，`qwen3:4b` 走 CPU。**冷启动**第一问（模型尚未载入显存/内存）实测约 **10 秒**，会撞上 `thinking` 的 8s 硬预算；**预热后**同样提示词的一轮实测 **1.3–2.6 秒**。

落地经验（2026-10-30，ADR 0018 D2 之后）：

- 真实输出经常带 `（轻轻叹了口气）` 这类括号动作或 Markdown，旧版会被 §9.2 判 `invalid_output`；
- 现在校验器先剥离"装饰"（围栏 / 括号动作 / 粗斜体）再按严格规则校验，同样的输出可以正常产出 `route=llm`；
- **冷启动首问仍可能 `timeout` 走兜底**，第二次起稳定接管。这是本机硬件与 8s 契约预算的落差，不是清洗失败。
- **应用现在会自己预热**（ADR 0033）：模型出现在桌面上的那一瞬间（`model_ready`）就发一发 1-token 请求，之后 15s 心跳按需重试；**关掉主动性也照样预热**。日志里搜 `[heartbeat] LLM 预热` 就能看到它到底发了没、成没成。

可选的处理：

| 选择 | 做法 | 代价 |
|---|---|---|
| 放宽预算 | `PET_LLM_TIMEOUT_MS=20000`（config 允许 500–60000；写进 `.env`） | 偏离契约 §9.1 的 8s 预算，打断体验变差 |
| 先预热模型 | 通常**不需要**手动了（自动预热已就位）；若你显式设了 `PET_WARMUP_DISABLE=1`，先手动问一句或保持 Ollama 常驻 | 只有关掉自动预热时才需要 |
| 换更小模型 | `ollama pull qwen3:1.7b` + `PET_LLM_MODEL=qwen3:1.7b`（需一次性出站） | 质量下降 |
| 上 GPU | 装驱动后 Ollama 自动用 CUDA | 硬件成本（不属于"运行成本"，但仍是成本） |
| 保持兜底 | 什么都不做 | 对话仍可用（规则 + 兜底台词），只是不"聪明" |

先看 `logs/pet.log` 里是 `timeout` 还是 `unavailable`：前者是慢，后者是没连上/没模型。

**真机实测（2026-10-30，本机）**：`/api/tags` 命中 `qwen3:4b`；真实一轮在 **1.7s** 内返回 `route=llm`，输出里的 `（略带担忧地皱眉）` 被清洗后成为可朗读文本。清洗记录见 `logs/pet.log` 的 `LLM 输出经清洗/字段修复后通过校验`。

### 1.5 相关环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PET_LLM_URL` | `http://127.0.0.1:11434` | 必须回环 |
| `PET_LLM_MODEL` | `qwen3:4b` | 必须已 `ollama pull` |
| `PET_LLM_HEALTH_TIMEOUT_MS` | `800` | `/api/tags` 超时 |
| `PET_LLM_TIMEOUT_MS` | `8000` | `thinking` 总预算（含健康检查） |

---

## 2. GPT-SoVITS（本地 TTS）

### 2.1 前置

- 已装好的 GPT-SoVITS 目录（ADR 0015 记录本机为 `D:\AI\GPT-SoVITS-V2ProPlus-Windows`）。
- 已训练的凯伊权重在位（ADR 0017）：
  - `GPT_weights_v2ProPlus\KaiYi-e10.ckpt`（Text2Semantic）
  - `SoVITS_weights_v2ProPlus\KaiYi_e18_s288.pth`（VITS）
  - v2ProPlus 底座 `s1v3.ckpt` / `s2Gv2ProPlus.pth`
- conda 环境 `GPT`（与 `run-webui.bat` 用的是同一个）。

### 2.2 配置权重（ADR 0017）

**权威位置是 `GPT_SoVITS\configs\tts_infer.yaml` 的 `custom:` 段**——因为 `api_v2.py` 的 `-c` 默认值就是它，直接 `python api_v2.py` 启动时会读这里。同时保留一份内容相同的 `tts_infer.kaiyi.yaml`，用于显式启动与"上游把 `tts_infer.yaml` 覆盖回默认"后的兜底。

两个文件的 `custom:` 段都应是：

```yaml
custom:
  bert_base_path: GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large
  cnhuhbert_base_path: GPT_SoVITS/pretrained_models/chinese-hubert-base
  device: cpu            # 本机无 NVIDIA 驱动；写 cuda 也会被 TTS_Config 回退
  is_half: false         # CPU 上强制 False
  version: v2ProPlus
  t2s_weights_path: GPT_weights_v2ProPlus/KaiYi-e10.ckpt
  vits_weights_path: SoVITS_weights_v2ProPlus/KaiYi_e18_s288.pth
```

改之前先备份（本机已有一份 `tts_infer.yaml.bak-20261030-1040` 在 GPT-SoVITS 根目录）：

```powershell
cd D:\AI\GPT-SoVITS-V2ProPlus-Windows
Copy-Item GPT_SoVITS\configs\tts_infer.yaml "tts_infer.yaml.bak-$(Get-Date -Format yyyyMMdd-HHmm)"
```

为什么不用 WebUI 里的 `/set_sovits_weights`：

- `/set_sovits_weights` 靠**文件名**推断版本，`KaiYi_e18_s288.pth` 里没有版本串；
- `/set_gpt_weights` 根本不切版本；
- `TTS_Config` 只认配置文件里的 `custom:` 段。

`custom:` 段缺失时会回退到 `v2` 段（v2 底座 + 默认权重）——那**不是**凯伊的声音。

> **改完必须重启 `api_v2.py`**：权重只在进程启动时加载。启动日志里的两行是唯一可信的验证：
> `Loading Text2Semantic weights from GPT_weights_v2ProPlus/KaiYi-e10.ckpt`
> `Loading VITS weights from SoVITS_weights_v2ProPlus/KaiYi_e18_s288.pth`
> 后面跟的 `_IncompatibleKeys(missing_keys=['enc_q.*', ...])` 是**正常**的：`enc_q` 是训练期判别器分支，推理权重里没有。

### 2.3 启动（必须绕过系统代理）

```powershell
cd D:\AI\GPT-SoVITS-V2ProPlus-Windows

# 系统代理（例如 127.0.0.1:7890）会把本机回环也拦掉，导致 gradio 自检 502
$env:NO_PROXY = "localhost,127.0.0.1,0.0.0.0,::1"
$env:no_proxy = "localhost,127.0.0.1,0.0.0.0,::1"

conda activate GPT

# 显式指定凯伊配置（推荐；两个文件内容一致，用哪个都能出凯伊的声音）
python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.kaiyi.yaml

# 或者用默认配置（custom 段已指向凯伊，ADR 0017）
# python api_v2.py -a 127.0.0.1 -p 9880
```

判据（本机实测）：CPU 冷启动约 **13 秒**；9880 可连；启动日志里出现上面那两行 `Loading ... KaiYi-*.ckpt / KaiYi_e18_s288.pth`。

> 应用**不会**自动拉起或重启该服务（ADR 0015 D2.7）：服务没起就走"字幕 + 无语音"的降级路径，这是被验收覆盖的正常状态。改过 yaml 之后也**不要**指望热加载——必须重启进程。

### 2.4 验证接口（会真的合成一次）

```powershell
$body = @{
  text              = "老师，测试一下语音。"
  text_lang         = "zh"
  ref_audio_path    = "D:\aa3dpet-app\data\ref\kaiyi.wav"
  prompt_text       = "（ここに参考音声の逐字テキスト / 日文逐字文本）"
  prompt_lang       = "ja"
  text_split_method = "cut5"
  streaming_mode    = $false
  media_type        = "wav"
} | ConvertTo-Json

Invoke-WebRequest -Method Post -Uri http://127.0.0.1:9880/tts `
  -ContentType "application/json" -Body $body -OutFile "$env:TEMP\tts-test.wav"

Get-Item "$env:TEMP\tts-test.wav" | Select-Object Length
```

返回文件 > 44 字节（RIFF 头）即通路正常。失败时服务端返回 400 + JSON `message`（例如参考音频不在、文本为空）。

**本机实测（2026-10-30，凯伊权重，CPU）**：

| 项 | 值 |
|---|---|
| 请求 | `text="老师，测试语音合成。"`、`ref_audio_path=data/ref/kaiyi.wav`、`streaming_mode:false` |
| 结果 | HTTP 200，**6.2s**，85,804 字节，`RIFF/WAVE` |
| 跨语种（ja 参考 + zh 合成） | HTTP 200，**3.97s**，111,404 字节，`RIFF/WAVE`（`prompt_lang=ja` / `text_lang=zh`，ADR 0019） |
| 应用端到端 | TTS 合成 4.2s → 下发 217,644 字节 → 播放 3.4s → `speech_started` / `speech_ended{completed}` |
| 冷启动 | 约 13s |

> 上面两次验证用的 `prompt_text` 是**占位文本**（真实逐字文本还没提供），所以只能证明"链路通"，不能证明"音色/韵律正确"。填好 §3.2 的参考文本后再听一次才算真机音质验收。

### 2.5 应用实际发送的字段（§7.4 / ADR 0015 D2.3 / ADR 0019）

`text`、`text_lang`、`ref_audio_path`、`prompt_text`、`prompt_lang`、`text_split_method: "cut5"`、`batch_size: 1`、`speed_factor: 1.0`、`temperature: 1`、`top_k: 15`、`top_p: 1`、`repetition_penalty: 1.35`、`streaming_mode: false`、`media_type: "wav"`。

其中 `prompt_lang` / `text_lang` 不再写死：分别来自 `PET_TTS_PROMPT_LANG`（参考音频语种，本机默认 `ja`）与 `PET_TTS_TEXT_LANG`（合成文本语种，默认 `zh`），见 §3.3。

---

## 3. 参考音频（TTS 的硬前置）

GPT-SoVITS 的 `/tts` **必须**有 `ref_audio_path`，且 `TTS.py` 要求片段长度 **3–10 秒**。没有它 = TTS 未配置，应用不会发起任何 HTTP。

### 3.1 要求

| 项 | 建议 |
|---|---|
| 时长 | 3–10 秒（超出会被 `doctor` 判红） |
| 内容 | 单人、干净人声、无 BGM、无混响；一句话读完 |
| 格式 | WAV（PCM）；采样率 ≥ 16 kHz（24 kHz 更好）；单声道或双声道均可 |
| 位置 | `D:\aa3dpet-app\data\ref\kaiyi.wav`（默认值，可用 `PET_TTS_REF_AUDIO` 覆盖） |

> 参考音频属于用户自备资产，**不入库**（`.gitignore` 已排除 `data/ref/`；零成本约束下不可能自动下载或生成）。

### 3.2 设置参考文本（推荐写进 `.env`）

`PET_TTS_PROMPT_TEXT` 必须是该音频里**逐字**说的话（本机音频是**日文**；标点尽量一致），否则音色会飘。本机 `data/ref/kaiyi.wav` 已就位（4.28s / 44100Hz / 单声道 / 16bit），**只差这一步日文文本**。

1. 若工程根目录还没有 `.env`：

   ```powershell
   Copy-Item .env.example .env
   ```

2. 编辑 `D:\aa3dpet-app\.env`，把这一行填上（等号后直接写文本，不要加引号）：

   ```dotenv
   PET_TTS_PROMPT_TEXT=这里替换成 kaiyi.wav 里逐字说的那句话
   ```

3. 重启应用（`.env` 只在启动时读取一次；改完不重启不生效）。

也可以用进程环境变量（**优先级高于 `.env`**）：

```powershell
# 仅当前终端会话
$env:PET_TTS_PROMPT_TEXT = "（kaiyi.wav 的逐字文本）"
```

> `setx` 写的是永久环境变量，会一直压过 `.env`；改完必须新开终端。若"`.env` 明明填了却没生效"，先 `echo $env:PET_TTS_PROMPT_TEXT` 看是否有同名进程变量。

验证：

```powershell
npm run doctor
```

`环境配置 .env`、`参考音频`、`参考文本`、`参考语种` 与 `合成语种` 都应变成绿色，汇总为 `全部就绪`。

### 3.3 多语言：参考音频与回复文本同为日文（ADR 0019 / ADR 0022）

本机 `data/ref/kaiyi.wav` 是**日文**，本轮起角色也**只讲日文**（ADR 0022），所以两个语种一致。GPT-SoVITS 的 `/tts` 要求两个语种分开指定：

| 参数 | 含义 | 本机值 | 环境变量 |
|---|---|---|---|
| `prompt_lang` | 参考音频/参考文本的语种 | `ja` | `PET_TTS_PROMPT_LANG` |
| `text_lang` | 要合成的回复文本语种 | `ja` | `PET_TTS_TEXT_LANG` |

`.env` 中对应两行（本机已写好）：

```dotenv
PET_TTS_PROMPT_LANG=ja
PET_TTS_TEXT_LANG=ja
```

v2ProPlus 仍支持跨语种：**日文参考 + 中文合成**实测 HTTP 200（3.97s / 111,404 字节 RIFF）——只是默认不再走这条路。

规则：

- 换参考音频 = 同时改 `PET_TTS_PROMPT_LANG` 与 `PET_TTS_PROMPT_TEXT`（逐字文本），否则音色/韵律会跑偏；
- `text_lang` 跟"角色说的语言"走：日文用 `ja`（混排英文/数字也可以），中文用 `zh`；纯语言无混排可用 `all_ja` / `all_zh`；
- v2ProPlus 合法值：`auto`、`auto_yue`、`en`、`zh`、`ja`、`yue`、`ko`、`all_zh`、`all_ja`、`all_yue`、`all_ko`。写错时服务端返回 400，例如 `prompt_lang: xx is not supported in version v2ProPlus`；
- 应用侧会把语种统一转小写；`doctor` 会校验取值，并在"参考文本含假名但 `prompt_lang=zh`"时给黄色提醒；
- 启动日志 `TTS 已配置` 会打印 `promptLang` / `textLang`，排查时先看这里。

---

## 4. CPU 机器必须放宽的超时

`streaming_mode: false` 时"首字节"等于"整段合成完成才发响应"。本机无 CUDA 时 v2ProPlus 走 CPU；实测一句话约 **6.2s**（见 §2.4），契约默认的 3s **必然超时**（ADR 0015 D2.5），30s 总超时对长句也偏紧。

推荐直接写进 `.env`（本机 `.env` 已写好这两行）：

```dotenv
PET_TTS_FIRST_BYTE_TIMEOUT_MS=15000
PET_TTS_TOTAL_TIMEOUT_MS=120000
```

也可以只在当前终端临时覆盖（进程环境变量优先于 `.env`）：

```powershell
$env:PET_TTS_FIRST_BYTE_TIMEOUT_MS = "15000"
$env:PET_TTS_TOTAL_TIMEOUT_MS      = "120000"
```

> 契约默认值仍是 3000 / 30000；`doctor` 会检查"是否仍为默认值"并给出黄色提醒，不会判红。

| 现象 | 含义 |
|---|---|
| 日志 `首字节超时` | 合成慢于 `PET_TTS_FIRST_BYTE_TIMEOUT_MS` → 调大 |
| 日志 `整段超时` | 文本太长或服务卡住 → 调大 `PET_TTS_TOTAL_TIMEOUT_MS`，或缩短回复（§7.4：>120 字直接失败） |

---

## 5. 环境变量总表

| 变量 | 默认值 | 作用 |
|---|---|---|
| `PET_LLM_URL` | `http://127.0.0.1:11434` | Ollama 地址（必须回环） |
| `PET_LLM_MODEL` | `qwen3:4b` | 模型名（必须已 pull） |
| `PET_LLM_HEALTH_TIMEOUT_MS` | `800` | `/api/tags` 超时 |
| `PET_LLM_TIMEOUT_MS` | `8000` | 单次回复的 `thinking` 预算 |
| `PET_TTS_URL` | `http://127.0.0.1:9880` | GPT-SoVITS 地址（必须回环） |
| `PET_TTS_REF_AUDIO` | `<data>/ref/kaiyi.wav` | 参考音频路径 |
| `PET_TTS_PROMPT_TEXT` | 空 | 参考音频的逐字文本（空 = TTS 未配置） |
| `PET_TTS_PROMPT_LANG` | `ja` | 参考音频/参考文本的语种（本机凯伊音频是日文；ADR 0019） |
| `PET_TTS_TEXT_LANG` | `ja` | 要合成的回复文本语种（角色只说日文，ADR 0022）；v2ProPlus 支持跨语种 |
| `PET_TTS_FIRST_BYTE_TIMEOUT_MS` | `3000` | 首字节超时（CPU 建议 15000） |
| `PET_TTS_TOTAL_TIMEOUT_MS` | `30000` | 整段超时（CPU 建议 120000） |
| `PET_DATA_DIR` | `<appRoot>/data` | 台词池 / 角色卡 / 参考音频 / 记忆库根目录 |
| `PET_MEMORY_DB` | `<data>/memory.db` | 记忆库文件（ADR 0020；已加入 `.gitignore`） |
| `PET_MEMORY_DISABLE` | 未设置 | `1/true/yes/on` → 不打开数据库，提示词段 3 恒为「（无）」 |
| `PET_MODEL_PATH` | `<appRoot>/CH0335.glb` | 角色模型 |
| `PET_FRAME_EXCLUDE` | `weapon\|prop\|brush\|outline` | 不参与取景/窗口尺寸的网格 |
| `PET_HIDE_ATTACHMENTS` | 与上一行同源 | 运行期隐藏的配件网格 |
| `PET_OCR_URL` | `http://127.0.0.1:8000/v1` | OpenAI 兼容 OCR 端点（必须回环；保留 `/v1` 路径；ADR 0054） |
| `PET_OCR_MODEL` | `glm-ocr` | OCR 模型名 |
| `PET_OCR_TIMEOUT_MS` | `20000` | 单次 OCR 超时（1000–120000） |
| `PET_OCR_API_KEY` | 空 | 可选 `Authorization: Bearer` |
| `PET_VISION_DISABLE` | 未设置 | `1/true/yes/on` → 关闭视觉（热键/`cmd:vision-query` 返回 `disabled`） |
| `PET_VISION_SOURCE` | `foreground` | `foreground`（前台窗口，匹配失败降级整屏）或 `screen`（整屏） |
| `PET_VISION_MAX_WIDTH` | `1600` | 送 OCR 前的最大宽度（640–2560） |
| `PET_VISION_CONTEXT_TTL_MS` | `120000` | 视觉上下文保鲜期（5000–600000） |

> LLM / TTS / OCR 三个 URL 都有"只允许回环"的启动期校验（ADR 0015 D6、ADR 0054 D1）；写成外网地址或 `https` 会直接启动失败并落 ERROR 日志。
>
> 以上变量都可以写进工程根目录的 `.env`（模板：`.env.example`）。读取顺序见 ADR 0018 D1：**进程环境变量 > `.env` > 代码默认值**；`.env` 只补空缺，且只记键名不记值。

---

## 6. 启动顺序与验收

0. 首次部署：`Copy-Item .env.example .env`，至少填好 `PET_TTS_PROMPT_TEXT`。
1. 启动 Ollama（安装后常驻；`Get-Process ollama` 可确认）。
2. 启动 GPT-SoVITS（§2.3，注意 `NO_PROXY`）。
3. `npm run doctor` → 期望只剩"提醒"没有"缺失"。
4. `npm start`（首次会先 `build`）。
5. 按 **Ctrl+Shift+B**（被占用时自动降级 **Ctrl+Alt+B**，`logs/pet.log` 有 `降级到备用热键`）；也可以右键**系统托盘**图标 → “呼出输入条”。
6. 输入"你好"→ **Enter**：输入条消失，角色用**日文**回话（`……先生、おはようございます。今日もよろしくお願いします。`），字幕与声音同时出现（ADR 0021）；字幕在 TTS 合成完成后才亮，属正常。再问一句刚才聊过的内容，`logs/pet.log` 的 `记忆检索 {count>0}` 与 `LLM 请求已装配 {memoryFacts>0}` 说明记忆已注入段 3。
7. **Esc** 或点桌面：输入条消失，不发任何事件。
8. 托盘菜单另有“重新加载桌宠”（重启渲染进程，调试用）与“退出”（先 `shell.stop()` 再退出，ADR 0004 D9）。

### 验收小抄

```powershell
npm run doctor          # 环境清单（会读 .env），含记忆库与 SQLite 原生模块
npm test                # 单测 219（含 .env 解析、托盘菜单、输出清洗、记忆、字幕时序）
npm run test:memory     # 只跑记忆单测（Electron ABI，见 §8）
npm run selftest:input  # 输入条 + 托盘套件：27 条断言 + 两张截图
npm run selftest        # 主链路回归：61 条
npm run selftest:speech # 语音闭环：30 条（本地桩，不需要真实服务；含记忆与字幕时序）
npm run selftest:fallback # 缺失模型回退：4 条
```

截图产物：

| 文件 | 内容 |
|---|---|
| `dist/selftest/input-bar.png` | 输入条打开（窗口 260×44；截图为 2× DPR，即 520×88） |
| `dist/selftest/input-submitted.png` | 提交后主窗口字幕 |
| `dist/selftest/input-bar-desktop.png` / `input-submitted-desktop.png` | **手工**桌面上下文截图：真实按键 Ctrl+Shift+B 唤起、剪贴板粘贴"你好" + Enter 提交（不由自检生成） |
| `dist/selftest/window.png` 等 | 既有模型/拖拽/摸头/语音截图 |

---

## 7. 出问题时看哪里

`logs/pet.log`（单文件 2 MB 上限）里的关键行：

| 关键字 | 说明 |
|---|---|
| `LLM 客户端已装配` / `本地 LLM 健康检查通过` | LLM 通路 |
| `本地 LLM 不可用，本会话不再探测 ②` | 熔断（服务没起 / 模型缺失） |
| `LLM 路径失败，走兜底` | `llm_failed` 的 reason 在同行 JSON |
| `TTS 已配置` / `TTS 未配置` | 参考音频与提示文本是否齐备 |
| `speech_ended failed` | TTS 失败；具体原因在相邻 WARN 行 |
| `输入条已打开` / `输入条已收起` | 输入条生命周期（含 reason：`submitted` / `escape` / `blur` / `hotkey-toggle`） |
| `全局热键已注册` / `降级到备用热键` / `两个热键都无法注册` | 热键三级降级（ADR 0016 D4） |
| `user_utterance 发出（§6.3）` | 文本入口成功；`source` 为 `input-bar` 或 `renderer` |
| `记忆库已就绪` / `记忆库文件打开失败` / `记忆写入失败` / `记忆检索` | 记忆库模式（`file`/`memory`/`disabled`）、降级与检索耗时（ADR 0020） |
| `记忆检索超出 50ms 预算` | 检索退化预警（WARN），通常意味着库太大或机器负载高 |
| `等待 speech_started 超时，提前显示字幕` | 字幕 failsafe 触发（ADR 0021 D6）：TTS 卡在合成阶段 |

### 常见问题

| 症状 | 可能原因 | 处理 |
|---|---|---|
| 角色只回固定的几句 | 规则命中、LLM 熔断、冷启动超时（首问），或清洗后仍 `invalid_output` | 看 `规则命中` / `本会话不再探测 ②` / `LLM 路径失败` 三行；`invalid_output` 时会带 `reason`/`detail`。括号/Markdown 已会自动清洗（ADR 0018 D2） |
| 第一句总是兜底、之后正常 | 冷启动模型加载约 10s，撞 8s `thinking` 预算 | 先手动问一句预热；或按 §1.6 评估放宽 `PET_LLM_TIMEOUT_MS` |
| 托盘图标看不到 | Windows 11 默认把新图标放进溢出区（任务栏 `^`） | 点 `^` 找到图标，或拖到任务栏常驻；`logs/pet.log` 有 `托盘已创建` 即创建成功 |
| `.env` 明明改了却不生效 | 同名进程环境变量（`setx` / 终端）优先；或改完没重启 | `echo $env:PET_XXX` 检查；`.env` 只在启动读一次。日志 `\.env 已加载` 的 `applied` / `kept` 可确认 |
| 有字幕没声音 | TTS 未配置/未启动/超时，最常见是 `.env` 的 `PET_TTS_PROMPT_TEXT` 为空 | `npm run doctor`；检查 `NO_PROXY`、9880、参考音频 3–10 秒、参考文本 |
| 声音不像凯伊 | 配置回退到 v2 底座，或改完 yaml 没重启服务 | 确认启动日志有 `Loading Text2Semantic weights from .../KaiYi-e10.ckpt` 与 `Loading VITS weights from .../KaiYi_e18_s288.pth`；`custom.version: v2ProPlus`；改完必须重启进程（ADR 0017） |
| 日文参考音频却读出中文/读音很怪 | `prompt_lang` 不是 `ja`，或 `PET_TTS_PROMPT_TEXT` 填成了中文 | `.env` 设 `PET_TTS_PROMPT_LANG=ja`，并确保参考文本是音频里的**日文逐字**；重启应用（ADR 0019） |
| `/tts` 返回 400 `prompt_lang/text_lang is not supported` | 语种代码写错（例如 `japanese`、`zh-CN`） | 用 v2ProPlus 合法值：`ja` / `zh` / `en` / `ko` / `yue` / `auto` / `all_*`；`npm run doctor` 会校验 |
| 改了 `tts_infer.yaml` 但毫无变化 | 9880 上的旧进程仍持有启动时加载的权重 | `Get-NetTCPConnection -LocalPort 9880 -State Listen` 找 PID → 停掉 → 用新配置重启（本轮实测踩到） |
| TTS WebUI 报 `localhost is not accessible` | 系统代理劫持回环 | 设 `NO_PROXY` / `no_proxy` 后重启服务 |
| 按 Ctrl+Shift+B 没反应 | 热键被其他软件占用且降级也失败 | 看 `logs/pet.log` 的 `输入条热键状态`；先关闭占用方，或等后续版本提供配置项 |
| 输入中文时按 Enter 变成发送 | 输入法候选未确认 | 组合期间 Enter 已被 `isComposing` 拦截；若仍复现，先按空格/数字确认候选再回车 |
| `doctor` 全绿但仍没声音 | 音频设备被独占 / 系统静音 | 应用会记 `AudioContext` 非 `running` → `speech_ended{failed}`（§11） |
| 说完话立刻有字幕了，但字幕早了 5–6 秒 | 显示时机被改回 `intent_resolved`（ADR 0021 之前的行为） | 字幕只应在 `speech_started` 出现；确认 `src/renderer/render/main.ts` 走的是 `subtitleCue`，并跑 `selftest:speech` 的 `SLOWTTS` 用例 |
| 完全没声音时字幕要等一会儿才出现 | TTS 已配置但服务卡住：`speech_ended{failed}` 没来，15s failsafe 先亮字 | 正常兜底（ADR 0021 D6）；看 `TTS 合成失败` / 首字节超时行定位 |
| 重启后"记不住"之前聊的内容 | `memory` 降级（`mode=memory`/`disabled`）、或问法与记忆用词没有交集（字面匹配） | `logs/pet.log` 的 `记忆库已就绪` 看 mode 与 `path`；`记忆检索 {count}` 为 0 表示没命中；跨语言（中文问日文记忆）不命中是已知限制 |
| `npm test` 里记忆用例报 `ERR_DLOPEN_FAILED` | 用宿主 `node` 直接跑 `memory.test.ts` | 用 `npm run test:memory`（Electron ABI，见 §8） |
| `npm run doctor` 报"SQLite 原生模块 缺失" | `npm install` 时 install 脚本被 npm 11 的 allow-scripts 拦下 | 按 §8 手动跑一次 `prebuild-install` |

---

## 8. 本地记忆：`better-sqlite3` 与 ABI（ADR 0020）

`memory` 是唯一带原生模块（`.node`）的模块。它**必须**按 Electron 的 ABI 安装，否则应用启动后记忆会静默降级为 `disabled`。

```powershell
# 1) 安装（npm 11 默认不执行依赖的 install 脚本，所以下面第 2 步是必须的）
npm install better-sqlite3@12.4.1

# 2) 抓 Electron ABI 的预编译二进制（NODE_MODULE_VERSION=130；npm 镜像替代 GitHub）
$env:npm_config_better_sqlite3_binary_host = 'https://registry.npmmirror.com/-/binary/better-sqlite3'
cd node_modules\better-sqlite3
node ..\prebuild-install\bin.js --runtime=electron --target=33.4.11 --arch=x64

# 3) 校验
Test-Path node_modules\better-sqlite3\build\Release\better_sqlite3.node   # 应为 True
npm run doctor                                                            # "SQLite 原生模块" 应为绿
```

为什么：`better-sqlite3` 是 ABI 相关的原生扩展，宿主 Node（本机 24.x / ABI 137）与 Electron 33（Node 20.18 / ABI 130）不通用。装错的表现：

| 症状 | 说明 |
|---|---|
| `NODE_MODULE_VERSION ... requires ...`（应用日志） | 装成了宿主 Node 版本 → 应用里 `mode=disabled` |
| `npm test` 的 `memory.test.ts` 报 `ERR_DLOPEN_FAILED` | 反过来：装成 Electron 版本却用宿主 `node` 跑 |

单测因此走 Electron 的 Node：

```powershell
npm run test:memory   # = node build.mjs && node scripts/run-electron-test.mjs dist/tests/memory.test.mjs
```

记忆库本身：

| 项 | 值 |
|---|---|
| 文件 | `data/memory.db`（`PET_MEMORY_DB` 可覆盖；`data/memory.db*` 已在 `.gitignore`） |
| 模式 | WAL（另有 `-wal` / `-shm` 两个伴生文件，正常现象） |
| 表 | `memories(id, at, kind, text, tags, ref_id)` + FTS5 `memories_fts`（`trigram`） |
| 版本 | `PRAGMA user_version`（当前 1） |
| 清空 | 退出应用后删掉 `data/memory.db*` 即可（下次启动重建） |
| 关闭 | `PET_MEMORY_DISABLE=1`（不打开数据库，段 3 恒为「（无）」） |

---

## 8.5 视觉 / OCR（可选，ADR 0054）

视觉查询是**可选**功能：没有 OCR 服务时应用照常启动，按 `Ctrl+Shift+V` 只会记一条 WARN
并在输入条恢复按钮，不会弹窗、不会影响对话。

### 8.5.1 默认端点

```
PET_OCR_URL=http://127.0.0.1:8000/v1
PET_OCR_MODEL=glm-ocr
```

要求是 **OpenAI 兼容**的 `POST /v1/chat/completions`，且支持 `image_url` 多模态输入。
GLM-OCR（vLLM / 官方 serving）默认就是 8000；llama.cpp 的 `llama-server` 也能用，但模型要支持视觉。
路径会被保留：`.../v1` → `.../v1/chat/completions`；裸 `http://127.0.0.1:8000` 会自动补 `/v1`。

### 8.5.2 验证（手动发一张图）

```powershell
$png = [Convert]::ToBase64String([IO.File]::ReadAllBytes('D:\shot.png'))
$body = @{
  model = 'glm-ocr'
  stream = $false
  messages = @(@{ role='user'; content=@(
    @{ type='text'; text='只提取画面中的文字，原样输出，不要解释。' },
    @{ type='image_url'; image_url=@{ url="data:image/png;base64,$png" } }
  )})
} | ConvertTo-Json -Depth 8
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8000/v1/chat/completions' `
  -ContentType 'application/json' -Body $body | ConvertTo-Json -Depth 6
```

能在 `choices[0].message.content` 里看到文字，就说明端点可用。

### 8.5.3 不带 OCR 服务时怎么验收

`npm run selftest:vision` **不需要 GLM-OCR**：脚本会起一个本地 OCR 桩（`127.0.0.1:8003`），
把应用发来的 PNG 落盘后调用 Windows 自带的 `Windows.Media.Ocr`（`scripts/win-ocr.ps1`，
离线、无需安装），再把文字按 OpenAI 响应返回。整条链路（截图 → OCR → 段 3.6 → LLM → TTS → 字幕）
都是真的，只有"GLM-OCR 模型"被替换。

```powershell
npm run selftest:vision
# 证据：logs/evidence/vision-chain.json
#       dist/selftest/vision-capture.png（OCR 实际收到的截图）
#       dist/selftest/vision-reply.png（带字幕的她）
#       dist/selftest/vision-desktop.png（整屏）
```

### 8.5.4 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 热键没反应 | `Ctrl+Shift+V` 被占用时会降级到 `Ctrl+Alt+V`；看 `logs/pet.log` 的 `视觉热键状态` |
| 返回 `unavailable` | OCR 端点没起、端口不对、或路径不是 OpenAI 兼容（看 `detail` 里的 HTTP 状态/`fetch failed`） |
| 返回 `timeout` | 首次加载模型慢；调大 `PET_OCR_TIMEOUT_MS`（最大 120000） |
| 返回 `empty` | 画面里没有可识别文字，或 OCR 服务返回了空 `content` |
| 截到的是整个屏幕 | `PET_VISION_SOURCE=foreground` 时前台窗口标题匹配失败会自动降级整屏；这是刻意行为 |
| 画面认错字 | 截图会先缩到 `PET_VISION_MAX_WIDTH`（默认 1600）；小字/艺术字可调到 2560，但仍受 OCR 能力限制 |
| 不想用 | `PET_VISION_DISABLE=1`；或在 `.env` 里注释掉 `PET_OCR_*`（端点连不上时同样只降级） |

---

## 9. 零成本核对（对照契约 §10.4）

| 检查 | 方法 | 通过标准 |
|---|---|---|
| 断网可用 | 禁用所有网络适配器后冷启动并完成一轮对话 | 有回复、有字幕（无语音时按 §11 降级） |
| 无外部连接 | `netstat -ano \| findstr ESTABLISHED` 对照桌宠 PID | 只有 `127.0.0.1:11434` / `127.0.0.1:9880` |
| 零账单 | 月末核对云服务账单 | 全部为 0 |
| 依赖审计 | 检查 `package.json` | 无计费 SDK（运行时只有 `three` 与 `better-sqlite3`，后者是本地原生库、不联网） |

本手册涉及的所有命令都只在本机执行；`doctor` 与两个客户端都只连回环地址。
