# 0015. 本地 TTS 与 LLM 部署架构（Ollama + GPT-SoVITS）与语音打断

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-10-29 |
| 决策者 | 项目所有者 |
| 关联 | `CONTRACTS.md` §3.5（通道）、§6.3（事件生产者）、§7.4（voice 接口）、§7.6（orchestrator）、§8.1、§9.1–§9.4、§10.2、§11、§12、§15（1.4.0）；ADR 0004（探针通道的"载荷缺口必须走 ADR"先例）、ADR 0010（贴图式口型）、ADR 0014（HFSM）；本 ADR 一并记录原编号 **0011（编排三路分流与 LLM 校验）** 与 **0012（本地 TTS 选型与包络来源）** 的内容，二者不再单独创建 |

## 背景

`voice` 与 `orchestrator` 此前只有空壳（`MODULE_STATUS` 两节全为 TODO）。本轮要把"对话 → 发声 → 口型"接通，落地时撞到五组硬事实：

1. **本机服务现状（已实测，不是假设）**
   - Ollama 在 `127.0.0.1:11434` 运行中，但**没有任何对话模型**：`/api/tags` 只有 `glm-ocr:q8_0` 与一个同尺寸的 `llamacpp:*` 导入项（1.1B，OCR 用途）。契约 §9.4 要的"4B 级量化"模型不存在。
   - GPT-SoVITS 位于 `D:\AI\GPT-SoVITS-V2ProPlus-Windows`，**未启动**（9880 无监听）。已训练权重在：`GPT_weights_v2ProPlus/KaiYi-e10.ckpt`、`SoVITS_weights_v2ProPlus/KaiYi_e12_s192.pth`（v2ProPlus 底座 `s1v3.ckpt` / `s2Gv2ProPlus.pth` 均在位）。
   - **全盘没有参考音频**（`D:\AI` 下除 conda 包自测文件外无任何 wav）。GPT-SoVITS `/tts` 强制要求 `ref_audio_path`，且 `GPT_SoVITS/TTS_infer_pack/TTS.py` 硬性要求参考音频 **3–10 秒**。
   - 本机无 NVIDIA 驱动（`nvidia-smi` 不存在），TTS 只能 CPU 推理（`TTS_Config` 会把 `cuda` 自动降级为 `cpu` 且强制 `is_half=False`）。
2. **契约把"语音生命周期"切在了两个进程。** §3.1 / §7.4 规定合成在主进程、播放与 RMS 在渲染进程；但 §6.3 又规定 `speech_started` / `speech_ended` 的**唯一生产者是 `voice`**（主进程）。主进程无法凭空知道"首帧真的开始播了""播到自然结束"，而新增事件名触 §6.2 N-8 与 §6.3 红线。
3. **`cmd:voice` 的载荷语义与播放实现冲突。** §3.5 写的是"下发已合成 PCM（ArrayBuffer）"，但 Web Audio 的 `decodeAudioData` 需要带容器头的完整音频字节；把裸 PCM 拼回 AudioBuffer 必须跨进程传采样率/声道数，反而更复杂。
4. **`speech_ended{interrupted}` 无法只靠事件停下音频。** 打断时主进程需要让渲染侧立刻停播；`evt:broadcast` 是事实广播，"停止播放"是命令，按 §6.1 应走接口/通道而不是事件。
5. **Windows 上自动播放策略。** 主窗口 `focusable: false`（ADR 0003），永远拿不到用户手势；Chromium 默认会把手势缺失的 `AudioContext` 置为 `suspended`，表现为"音频解码成功但没有声音"。

## 决策

### D1 本地 LLM：Ollama，健康检查一次失败即本会话熔断，无重试

1. 端点固定 `http://127.0.0.1:11434`（`PET_LLM_URL` 可覆盖，但**必须是回环地址**，见 D6）；协议只用 `/api/tags` 与 `/api/chat`。
2. 模型默认 **`qwen3:4b`**（4B 级、Ollama 默认 Q4_K_M、中文角色扮演可用），`PET_LLM_MODEL` 覆盖。**不自动 `ollama pull`**：拉取会出站（违反 §10.1 $3 的"运行期零外部探测"精神，且体积不可控）；模型缺失就按"LLM 不可用"降级。
3. **健康检查**：`GET /api/tags`，超时 800ms；在返回的 `models[].name` 里找配置模型（同时接受 `qwen3:4b` 与 `qwen3:4b` 被规范化成 `qwen3:4b:latest` 的形式）。以下三种都判 `unavailable`：连接拒绝、超时、模型不在列表。
4. **熔断语义（照 §11 第一行）**：健康检查失败后置会话级 `disabled`，本次会话不再探测、不再尝试 ②，直接走 ③；只在启动日志与首次失败时各记一条，避免刷屏。
5. **请求**：`POST /api/chat`，`stream: false`（§9.4 关闭流式）、`format: "json"`（约束模型输出为 JSON，降低解析失败率）、`think: false`（qwen3 为混合推理模型；不关思维链时 token 会被推理吃光，JSON 易被 `num_predict` 截断）、`options: { temperature: 0.8, num_predict: 256 }`；只取 `message.content` 做 §9.2 校验。
6. **超时与重试**：8s 硬超时（`AbortController`，与 §9.1 的硬超时一致）。**不做自动重试**——理由：8s 已是延迟预算上限，重试必然翻倍；本地模型冷加载会先慢后快，重试只会把"慢"变成"更慢"；③ 兜底是即时的，重试没有收益。超时只记 `llm_failed{timeout}`，不熔断（下一次话语仍可尝试 ②，与 §11 的"LLM 超时→放弃本次结果"一致）。
7. **取消**：`orchestrator.cancel()` → `AbortController.abort()` → 记 `llm_failed{aborted}`；被取消的那次 `respond()` 仍按 §7.6 "永不 reject"返回一个兜底 `Reply`，但**不发布 `intent_resolved`、不调用 voice**（否则旧回复会跑出来抢新话语）。
8. 提示词按 §9.3 固定五段：① 输出约束（硬编码 JSON schema + 枚举全集）→ ② `data/character-card.md` → ③ 记忆片段（本轮 memory 未实现，段为空字符串，保留段位）→ ④ 最近 6 轮对话（进程内环形缓冲，不写库）→ ⑤ 当前用户话语。①–③ 合成 system 消息，④ 作为历史消息，⑤ 作为最后一条 user 消息。

### D2 本地 TTS：GPT-SoVITS `api_v2.py`，权重由启动配置决定，不通过 HTTP 切权重

1. **启动方式（用户侧，应用不代启、不杀进程）**：

   ```powershell
   # 工作目录：D:\AI\GPT-SoVITS-V2ProPlus-Windows
   # 用 run-webui.bat 同一个 conda 环境（GPT）；必须绕过系统代理，否则本机回环会被代理层拦掉
   $env:NO_PROXY  = "localhost,127.0.0.1,0.0.0.0,::1"
   $env:no_proxy  = "localhost,127.0.0.1,0.0.0.0,::1"
   conda activate GPT
   python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.kaiyi.yaml
   ```

2. **权重选择放在配置文件里**，不用 `/set_gpt_weights` / `/set_sovits_weights`。原因（读源码实测）：`/set_sovits_weights` 依据**文件名**推断版本（`get_sovits_version_from_path_fast`），而 `KaiYi_e12_s192.pth` 文件名里没有版本串；`/set_gpt_weights` 根本不切版本。`TTS_Config` 只认配置文件里的 `custom:` 段，所以"用哪套权重"必须由 `custom.version` 决定。推荐配置（新增文件，不改动原 `tts_infer.yaml`）：

   ```yaml
   custom:
     bert_base_path: GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large
     cnhuhbert_base_path: GPT_SoVITS/pretrained_models/chinese-hubert-base
     device: cuda            # 无 CUDA 时 TTS_Config 会告警并回退 cpu
     is_half: true           # CPU 上会被强制 False
     version: v2ProPlus
     t2s_weights_path: GPT_weights_v2ProPlus/KaiYi-e10.ckpt
     vits_weights_path: SoVITS_weights_v2ProPlus/KaiYi_e12_s192.pth
   ```

   若 `custom` 段缺失，`TTS_Config` 会回退到 `v2` 段（v2 底座 + 默认权重），**不是**凯伊的声音——这一点写进 `MODULE_STATUS` 坑位。

3. **合成调用**：`POST /tts`，`Content-Type: application/json`，字段：`text`、`text_lang`（默认 `zh`）、`ref_audio_path`、`prompt_text`、`prompt_lang`（默认 `zh`）、`text_split_method: "cut5"`、`batch_size: 1`、`speed_factor: 1.0`、`temperature: 1`、`top_k: 15`、`top_p: 1`、`repetition_penalty: 1.35`、`streaming_mode: false`、`media_type: "wav"`。成功返回 `audio/wav` 字节流，失败返回 400 + JSON `message`。
4. **参考音频是硬前置**：`PET_TTS_REF_AUDIO`（3–10 秒、干净人声、路径对 GPT-SoVITS 进程可见）+ `PET_TTS_PROMPT_TEXT`（该片段逐字文本）。**两者缺一即视为"TTS 未配置"**：`speak()` 不发起任何 HTTP，直接 `failed` 并记明确日志。零成本约束下不可能自动下载/生成参考音频，必须由用户提供（建议放 `data/ref/kaiyi.wav`，不入库）。
5. **超时**：首字节 3000ms、整段 30000ms（§7.4），均用 `AbortController` 实现；超时判 `failed` 并中止请求。
   **例外（本机现实）**：`streaming_mode: false` 时"首字节"等于"整段合成完成才发响应"；本机无 CUDA、v2ProPlus 走 CPU，3s 几乎必然超时。因此提供 `PET_TTS_FIRST_BYTE_TIMEOUT_MS` / `PET_TTS_TOTAL_TIMEOUT_MS` 覆盖，契约 §7.4 同步写明"CPU 非流式部署建议 15000 / 120000"。默认值仍是契约值，不为某台机器改默认。
6. **失败处理**：连接拒绝 / 超时 / 非 200 / 非 WAV 字节 → `speech_ended{failed}`，字幕气泡保留；**不重试本次**，下一次回复重新尝试（§11 的 TTS 行）。失败原因（含服务端 400 的 `message`）只写日志，不进事件载荷（§6.3 载荷固定）。
7. 本 ADR 不引入"重启 TTS 服务/自动拉起"的能力：拉起外部进程属于运维，超出桌宠职责，也会让"服务没启动"这个降级路径无法被验收。

### D3 语音生命周期与打断：新增 `cmd:speech`，`cmd:voice` 改为命令联合体

1. **归属不变**：`voice`（主进程）仍是 `speech_started` / `speech_ended` 的唯一生产者（§6.3、N-4）。播放事实由渲染侧上报，事件由 voice 统一发出。
2. **新增通道 `cmd:speech`（renderer → main）**，只有两种载荷：

   ```ts
   { utteranceId: string, phase: 'started' }
   { utteranceId: string, phase: 'ended', reason: 'completed' | 'failed', durationMs: number, detail?: string }
   ```

   `interrupted` **不由渲染侧上报**：打断是主进程的决定，由 voice 直接发事件，避免"主进程已打断、渲染侧又报 completed"的双发。
3. **`cmd:voice`（main → renderer）改为命令联合体**（原 `{ utteranceId, pcm }` 语义过窄，且与 Web Audio 解码方式冲突）：

   ```ts
   { kind: 'speak', utteranceId: string, audio: ArrayBuffer, mime: 'audio/wav' }
   { kind: 'stop',  utteranceId: string }
   ```

   `audio` 是 WAV 容器字节（含 RIFF 头）。§7.4 的"帧级包络不跨进程"不变：主进程只发字节，解码、RMS、包络全在渲染进程。
4. **打断序列（新话语到达，§12）**：

   ```
   orchestrator.cancel()                     // 中止在途 LLM（llm_failed{aborted}）
     → voice.stopSpeaking('interrupt')       // 幂等
         → abort 在途合成（若有）
         → cmd:voice{kind:'stop'}            // 渲染侧立刻停源、嘴型归 0
         → 发 speech_ended{interrupted}      // 让 render 退出 speaking、shell 收字幕
     → 开始新的 respond()
   ```

   渲染侧对 `stop` 与 `speech_ended{interrupted}` 都按 `utteranceId` 幂等处理：先到的那个停音频，后到的那个只更新状态，不重复上报。
5. **单一在途**：`speak()` 开始前若已有在途会话，先按第 4 步以 `interrupted` 结束它（其 `speak()` Promise 以 `'interrupted'` 兑现，不泄漏）。
6. **`speak()` 的语义**（§7.4）：永不 reject；返回 `'completed' | 'interrupted' | 'failed'`，**在语音终态时兑现**（不是"开始播放"时）。`orchestrator` **不 await 它**（fire-and-forget + 内部 catch），因此 `thinking → idle` 不被播放时长拖延（§4.1 的 `Orch.idle` 定义是"没有在途话语"，不是"没有在播语音"）。
7. **文本 > 120 字**：不截断、不发 HTTP，直接 `speech_ended{failed}` 并返回 `'failed'`（§7.4，长度由编排层保证——本轮 LLM 校验与台词池都在源头卡 120）。
8. **失败/打断的 `durationMs`**：`completed` = 首帧到自然结束；`failed` = `speak()` 发起到失败；`interrupted` = 首帧到被打断（未开始播放则为 0）。

### D4 包络与口型：解码后按 30ms 窗口算 RMS，8 级映射到图集帧

1. 渲染侧 `AudioContext.decodeAudioData` 解 WAV → `AudioBuffer`；单声道视为混音，多声道取平均。
2. 包络：固定 **30ms** 窗、50% 重叠、每窗 RMS；以 95 分位峰值归一化到 `[0,1]`；低于 **0.06** 的窗置 0（噪声门，避免静音时嘴抖）。
3. 映射：`level → frame ∈ {0..7}`（8 级），带 **attack 0.55 / release 0.30** 的单极平滑与 1 级迟滞；刷新上限 **30Hz**（ADR 0010 的"每帧重绘嘴部矩形"预算）。`level=0` 一定回帧 0（闭嘴）。
4. **标定假设（必须写进坑位）**：图集是 8×8=64 帧，资产没有给出帧语义；本 ADR 假定 `0..7` 是"闭口 → 逐步张口"，`8+` 不用于口型。帧 4 已被 `pat_react` 当作 "shy" 用（ADR 0014 D6），说话时摸头不改嘴型（§5.3），因此不冲突；非说话时摸头仍用帧 4。换图集必须重新看图选帧。
5. `speech_ended`（任意 reason）→ 嘴型立即回帧 0，避免"说完张着嘴"。
6. 包络只存在于渲染进程（§7.4）；`RenderState` 不新增字段（§7.1），当前帧与电平只进内部诊断 `getDiagnostics().speech`。

### D5 Windows 自动播放策略：启动即声明无需手势

`app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')`，在 `app.ready` 之前执行（`bootstrap()` 顶部）。理由：主窗口 `focusable:false`，不存在"用户点一下再播"的时机；不加这个开关时 `AudioContext` 常驻 `suspended`，音频"解码成功但无声"。仍保留运行时兜底：`resume()` 后若状态不是 `running`，按 `failed` 上报并记日志。

### D6 零出站守卫：客户端只接受回环地址

`llm-client` 与 `tts-client` 在构造时校验 base URL：协议必须是 `http:`，主机必须是 `127.0.0.1` / `localhost` / `[::1]`，否则直接抛装配错误（启动失败并记 ERROR），`fetch` 一律 `redirect: 'error'`。这条守卫是 §10.1 红线的可执行版本，也是本轮唯一新增的"安全默认值"。

### D7 契约升版

`CONTRACTS.md` 升 **1.4.0**（minor）：§3.5 补 `cmd:speech`、改写 `cmd:voice` 载荷、明确 `cmd:render-intent` 的落地；§7.4 补 WAV 容器与超时覆盖；§9.4 写明默认模型；§11 补 TTS 参考音频缺失一行。**不新增事件名、不新增状态名、不新增 intent/emotion 值、不新增依赖。**

## 替代方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 渲染侧直接发 `speech_started` / `speech_ended` | 零新增通道，播放侧最清楚 | 违反 §6.3 的"唯一生产者 = voice"；`speech_ended` 会同时有 voice（打断）与 render（自然结束）两个生产者 | 否 |
| 主进程在"发出 cmd:voice"时就发 `speech_started` | 不用上报 | 与"首帧开始播放的同一帧"不符；解码失败也已经被登记成"在说话" | 否 |
| 新增事件 `speech_progress` / `speech_stopped` | 语义直白 | 触 §6.2 N-8 / §6.3 红线（新增事件需 minor + ADR，且 `stopped` 与 `ended` 重复） | 否 |
| 加 `cmd:speech` 上报通道（本方案） | 生产者仍是 voice；载荷只有两种事实；不动事件表 | 通道表 +1 行，需要 minor 升版 | **是** |
| 主进程发裸 PCM + 采样率，渲染侧手工拼 AudioBuffer | 严格符合"PCM"字面 | 要跨进程传 sampleRate/channels/位深；解码器还得自己写；WAV 头解析反而更简单 | 否 |
| 发 WAV 容器字节，渲染侧 `decodeAudioData`（本方案） | 浏览器原生解码、无自写解析；包络仍不出渲染进程 | §3.5 的"PCM"措辞要改写 | **是** |
| TTS 走流式（`streaming_mode: 3`）拿首块 | 首字节快 | 返回的是 WAV 头 + 分块裸 PCM 的混合流，`decodeAudioData` 无法直接吃；整段包络还要自己拼 | 否（v1 非流式） |
| 自动重试 LLM / TTS 一次 | 偶发失败更"稳" | 8s/30s 预算直接翻倍；本地服务冷启动会让重试更慢；兜底本来就是即时可用 | 否 |
| 应用自动拉起 GPT-SoVITS / Ollama | 用户少一步 | 进程生命周期、显存/内存、端口冲突都要管；且"服务未启动"的降级路径再也测不到 | 否 |
| 健康检查失败后每次话语都重探 | 服务后启动能自愈 | 违反 §11 的"本次会话不再探测 ②"，且每次多 800ms 延迟 | 否 |
| 用 `/set_*_weights` 在运行时切到凯伊权重 | 不用改配置 | 版本推断依赖文件名，`KaiYi_*.pth` 推不出 v2ProPlus；`init_t2s_weights` 不切版本，会 v2 底座 + v2ProPlus 权重 | 否 |
| 权重写进启动配置（本方案） | 版本与权重同一处、可复现；不依赖文件名 | 用户要新建一个 yaml；换音色要改配置重启服务 | **是** |
| 用 `AnalyserNode` 实时取 RMS | 与真实播放严格同步 | 逐帧读时域数据 + 归一化不稳定；自动化验收不可复现 | 否（用预计算包络 + 播放位置取样） |
| 口型按 `level` 连续改材质透明度/颜色 | 不用图集 | 嘴形不是颜色能表达的（ADR 0010 已否） | 否 |

## 后果

**正面**

- 语音链路的"谁发事件、谁播音频"第一次有了明确分工：voice 发事件、renderer 播并上报，§6.3 的单生产者规则没有被破坏。
- 两个外部服务都只有一条降级路径，且降级是**默认可见**的：本机当前既没有对话模型也没有参考音频，跑一次就能看到"兜底台词 + 字幕 + 无语音 + 口型归零"。
- 打断语义是单一序列（cancel → stop → interrupted → 新话语），不会出现"旧语音还在放、新语音已经开始"。
- 包络不进主进程、不上 IPC，§7.4 的性能意图被保留；同一份 RMS 还能在自检里被断言。
- 零新增依赖：HTTP 用 Node 20+ 原生 `fetch`（Electron 33 主进程自带），解码用 Web Audio。

**负面 / 成本**

- 契约升到 1.4.0：通道表 +1、`cmd:voice` 载荷改名（`pcm` → `audio`），所有消费方要同步一次。
- 主进程与渲染进程之间多一次 `cmd:speech` 往返；自然结束的判定依赖渲染侧，渲染进程崩溃时主进程只能靠"下一次 speak 打断"收尾（不新增看门狗，避免契约外机制）。
- 本机 CPU 推理下 3s 首字节默认值不可用，必须用环境变量放宽——这是"契约默认值"与"本机硬件"的已知落差，写进坑位。
- 口型 8 级映射是未标定假设；换图集/换角色要重选帧。
- 参考音频必须由用户提供（3–10 秒），首次部署多一步；没有它时"本地 TTS"实际上不可用。

**约束**

- `speech_started` / `speech_ended` 只能由 `voice` 发出；渲染侧只能通过 `cmd:speech` 上报事实，不得自己广播同名事件。
- `interrupted` 只能由主进程决定；渲染侧不得上报 `interrupted`。
- `cmd:voice` 的 `audio` 必须是完整 WAV 容器字节；不得在主进程解析 PCM 或计算包络。
- 不得新增事件名、状态名、intent/emotion 值；不得引入 TTS/LLM SDK。
- 两个客户端只允许回环地址；不得自动 `pull` 模型、不得自动拉起/重启外部服务。
- 健康检查失败后不得在本次会话内重探 LLM；TTS 失败不得在本次回复内重试。
- `speak()` 永不 reject，且必须在终态兑现；`orchestrator` 不得 await 完整的播放。
- 自动播放开关必须在 `app.ready` 之前设置；不得改成"等用户点击"。
- 口型包络不得跨进程传输，`RenderState` 不得新增字段。
