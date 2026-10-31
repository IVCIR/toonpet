# 0017. TTS 权重与配置权威源：`tts_infer.yaml` 的 `custom` 段（凯伊 e10 + e18_s288）

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-10-30 |
| 决策者 | 项目所有者 |
| 关联 | 修订 ADR 0015 D2.2（"新增专用 yaml、不改 `tts_infer.yaml`" 与 `KaiYi_e12_s192.pth` 示例）；`CONTRACTS.md` §7.4、§10.2；`docs/guides/LOCAL-SERVICES.md` §2 |

## 背景

ADR 0015 D2.2 当时的建议是：**不改**上游的 `GPT_SoVITS/configs/tts_infer.yaml`，另建 `tts_infer.kaiyi.yaml`，并给出了 `KaiYi_e12_s192.pth` 的示例。落地后出现三个与当时假设不符的事实：

1. **默认启动路径就是 `tts_infer.yaml`。** `api_v2.py` 的 `-c` 默认值是 `GPT_SoVITS/configs/tts_infer.yaml`（源码第 134 行）。用户实际就是用默认路径启动的（实测进程命令行：`api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml`）。只改专用文件时，默认启动的服务仍然是默认权重——表现为"配置改了，声音没变"。
2. **训练产出的权重要求变了。** 实际在位的 GPT 权重是 `GPT_weights_v2ProPlus\KaiYi-e10.ckpt`，SoVITS 权重是 `SoVITS_weights_v2ProPlus\KaiYi_e18_s288.pth`（`KaiYi_e12_s192.pth` 仍在目录里，但已不是目标版本）。ADR 0015 的示例文件名已经过时。
3. **`tts_infer.yaml` 的 `custom` 段当前指向 v2 默认权重**（`s1bert25hz-5kh-...ckpt` + `s2G2333k.pth`，`version: v2`），而本机无 CUDA，`device: cpu` / `is_half: false` 已由用户按实际情况写死。

## 决策

### D1 权威配置是 `tts_infer.yaml` 的 `custom` 段

1. `GPT_SoVITS/configs/tts_infer.yaml` 的 `custom:` 段是**权重与版本的唯一权威源**——因为它就是 `api_v2.py` 的默认配置，任何"直接用默认参数启动"的路径都会读它。
2. 同时保留 `GPT_SoVITS/configs/tts_infer.kaiyi.yaml`（与 `tts_infer.yaml` **内容一致**）作为显式启动副本：上游更新/WebUI 重置把 `tts_infer.yaml` 覆盖回默认时，专用副本仍是凯伊，且文档里的启动命令 `-c .../tts_infer.kaiyi.yaml` 仍然成立。
3. 两个文件内容必须同步；不一致时以 `tts_infer.yaml` 的 `custom` 段为准，并把专用副本同步过去。

### D2 权重与设备固定为

```yaml
custom:
  bert_base_path: GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large
  cnhuhbert_base_path: GPT_SoVITS/pretrained_models/chinese-hubert-base
  device: cpu            # 本机无 NVIDIA 驱动；TTS_Config 即使写 cuda 也会回退 cpu
  is_half: false         # CPU 上强制 False
  t2s_weights_path: GPT_weights_v2ProPlus/KaiYi-e10.ckpt
  version: v2ProPlus
  vits_weights_path: SoVITS_weights_v2ProPlus/KaiYi_e18_s288.pth
```

- 版本必须是 `v2ProPlus`：权重来自 v2ProPlus 训练，配 v2 底座会加载出错误的声音甚至报错。
- 不用 `/set_gpt_weights` / `/set_sovits_weights`：前者不切版本，后者按文件名推断版本（`KaiYi_e18_s288.pth` 推不出 v2ProPlus）。

### D3 修改前后的硬约束

1. **改 `.yaml` 之前先备份**到 GPT-SoVITS 根目录（`tts_infer.yaml.bak-YYYYMMDD-HHmm`）。
2. **改完必须重启 `api_v2.py`**：权重与版本在进程启动时加载（日志 `Loading Text2Semantic weights from ...`），运行期改文件不会生效。
3. 启动时出现 `_IncompatibleKeys(missing_keys=['enc_q.*', ...])` 是**正常**的：`enc_q` 是 SoVITS 训练期的判别器分支，推理权重里本来就没有。

### D4 文档同步

`MODULE_STATUS` 与 `docs/guides/LOCAL-SERVICES.md` 记录当前权重与配置策略；ADR 0015 D2.2 的示例权重与"不改 `tts_infer.yaml`"的措辞由本 ADR 修订（ADR 只增不改）。

## 替代方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 只改专用 `tts_infer.kaiyi.yaml`（ADR 0015 原方案） | 上游文件保持干净 | 默认启动路径仍用默认权重（实测就是这个坑）；用户"改了没效果" | 否 |
| 只改 `tts_infer.yaml` | 一处生效 | 上游更新/WebUI 重置会覆盖；没有可引用的显式副本 | 否 |
| 运行期用 `/set_*_weights` 切 | 不用改文件 | 版本推断靠文件名；`KaiYi_e18_s288.pth` 推不出版本；GPT 权重不切版本 | 否 |
| 两个文件都写、内容一致（本方案） | 默认路径与显式路径都正确；上游覆盖后仍有副本 | 需要人工保持两份一致 | **是** |
| 把权重写进代码/环境变量 | 不用配置文件 | 服务端（Python）不读应用的环境变量；权重属于服务部署，不属于应用 | 否 |

## 后果

**正面**

- "默认启动就是凯伊"成为事实，不再依赖用户记得加 `-c`。
- 权重文件名、版本、设备三件事集中在一处，换音色只需改 `custom` 段并重启。
- 备份 + 重启两条规则把"改了没生效"和"改坏了回不去"都堵住。

**负面 / 成本**

- 两份 yaml 需要人工同步；不一致时以 `tts_infer.yaml` 为准。
- 每次换权重都要重启服务（CPU 上冷启动约 13 秒，实测）。

**约束**

- 禁止把 `custom.version` 改回 `v2` 而继续用 v2ProPlus 权重。
- 禁止用 `/set_*_weights` 代替配置（版本推断不可靠）。
- 改配置后必须重启服务并在日志里确认 `Loading ... KaiYi-e10.ckpt` / `KaiYi_e18_s288.pth`。
- 本文档不改变 `CONTRACTS.md`：权重属于部署参数，不是模块接口。
