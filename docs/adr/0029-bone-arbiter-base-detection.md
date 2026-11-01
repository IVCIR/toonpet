# 0029. 骨骼仲裁的基底判定：用 `mixer.update()` 前后快照取代"比较上次写入值"

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-11-01 |
| 决策者 | 项目所有者（真机 bug 报告 + 二分排查指令） |
| 关联 | 契约 §5.2（混合通道）、§5.3、§7.3；ADR 0014 D1/D2（骨骼仲裁）、ADR 0028 D8（`sitting` 停帧） |

## 背景

真机首跑 `sitting` 时，角色**头在疯狂打转**（像陀螺），发丝被甩成锥形、光环跟着乱飞的脑袋漂移；窗口位置是稳的。用户给出了二分排查清单（先停视线、再停光环、再查 `playHold` 重入、最后查窗口跟随抖动）。

本 ADR 记录实测结论：**四条怀疑里只有一条成立，而且不在清单上**——问题在骨骼仲裁器判断"这一帧动画有没有重写这根骨骼"的方法上。

## 实测数据（本机 selftest，同一进程内可复现）

| 观测 | 值 |
|---|---|
| 头骨**本地**四元数 1s 内的夹角变化 | **2.51 rad**（≈144°/s），修后 **0.000 rad** |
| 头骨**世界坐标** | 稳定（-13.8, -77.3），即"位置没动、只有旋转在累积" |
| 仲裁器提交的偏移 | yaw ≈ -0.11…-0.20 rad、pitch ≈ 0.05…0.08 rad（很小，且方向稳定） |
| `animation.current.time` | 恒为 2.300s（`playHold` 停帧正常，没有重播） |
| 逐帧追踪（`pre` = `mixer.update()` 前、`post` = 仲裁器写回后） | `pre` 在停帧后**等于上一帧的 `post`** → mixer 根本没写；`baseFrom` 却报 `'mixer'` → 基底取成了"我们上次写出的值" → 每帧再叠一次偏移 |

## 根因

`bone-arbiter.beginFrame()` 的旧判据是：

```ts
// 旧：骨骼的值还是我上次写的值 ⇒ 动画没写它
const animated = entry.written && sameRotation(quaternion, entry.applied);
```

它依赖"动画没写 ⇒ 骨的值精确等于我上次写的值"。但 **three 的 `PropertyMixer.apply()` 有跳写优化**（`PropertyMixer.js` 尾部）：

```js
for ( let i = stride, e = stride + stride; i !== e; ++ i ) {
    if ( buffer[ i ] !== buffer[ i + stride ] ) {
        // value has changed -> update scene graph
        binding.setValue( buffer, offset );
        break;
    }
}
```

`playHold` 把片段 `clampWhenFinished` 停在最后一帧后，每帧累计出的姿态**完全相同** → 这段比较恒等 → **mixer 从此不再写这根骨骼**。此时骨头上留着的是"仲裁器上一帧写的值"，而 `applied` 与它之间只差浮点末位（1e-4 量级，实测），旧阈值 `1 - 1e-8` 判成"不相等" → 误判成"动画写了" → `base = 当前值（= 上一帧的 applied）` → **偏移逐帧叠加**。

为什么 `idle`/`walking` 一直没暴露：那些片段每帧都在推进、姿态每帧都变，mixer 每帧都真的写，基底自然刷新。**只有"停帧"这种状态会踩到**，而 `sitting` 是第一个用停帧的项目功能。

## 决策

### D1 用"直接观测"取代"记忆推断"

仲裁器新增 `capture()`：**在 `mixer.update()` 之前**把每根受控骨骼的本地四元数记进 `entry.preMixer`。`beginFrame()` 改成：

```ts
const mixerWrote = entry.captured
  ? !sameRotation(entry.preMixer, entry.bone.quaternion)   // 这中间变了没有
  : !(entry.written && sameRotation(entry.bone.quaternion, entry.applied)); // 旧调用方兜底
```

- `mixerWrote === true` → 基底 = 当前四元数（动画的真实产物）；
- `false` → 基底 = `prevBase`（缓存），**绝不**拿 `applied` 当基底。

渲染循环的调用顺序因此固定为：`arbiter.capture()` → `animations.update(dt)` → `updateHalo()` → `arbiter.beginFrame()` → … → `arbiter.endFrame()`。

### D2 阈值放宽到 1e-6（≈0.0014 rad）

`sameRotation` 的用途从"证明两个四元数逐位相同"变成"判断这根骨骼有没有被改动"。1e-8 会被浮点末位噪声击穿，1e-6 既不会漏掉真实写入（真实姿态变化远大于 0.0014 rad），也不会把噪声当成写入。

### D3 可观测：`baseFrom` 进诊断

`BoneArbitrationState` 新增 `baseFrom: 'mixer' | 'cache' | null` 与 `applied`，`RenderDiagnostics.sit` 暴露 `headQuat` / `headWorld` / `headBase`。自检据此断言"坐姿 1s 内头骨不漂移"（≤0.15 rad；修前 2.51，修后 0.000）。

## 二分排查记录（用户清单逐条）

| 怀疑 | 实测 | 结论 |
|---|---|---|
| ① 视线跟随与坐姿动画冲突 | 停用前先测：仲裁器给头骨提交的 yaw/pitch 只有 ±0.11…0.20 rad，且 `sameRotation` 的误判发生在 `gaze.add()` 之前 | **不是原因**。视线保留（修后头骨 1s 内夹角 0.000 rad） |
| ② `HaloRoot` 挂载写反、导致矩阵无限滚动 | GLB 层级实测：`RootNode → CH0335 → { bone_root → Bip001 → … , HaloRoot → CH0335_Halo }`，`HaloRoot` 与骨架**平级**、不是任何骨骼的祖先；代码只写 `HaloRoot.position`（世界→父空间换算），从不复制四元数 | **不是原因**。视频里光环"跟着乱飞的脑袋跑"恰好证明挂载是对的 |
| ③ `playHold` 每帧被重触发 | `snap_applied` 每次吸附只发一次；追踪里 `hold.time` 恒为 2.300s、`done=true` | **不是原因** |
| ④ 窗口跟随抖动（正负号反转 / 无阈值） | 跟随只在目标矩形变化 ≥1px 时 `setPosition`，且比较基准是"上次记录的目标矩形"而不是窗口自身位置（无反馈回路）；录屏里窗口位置稳定 | **不是原因**（另加了回归断言，见下） |
| ⑤（未在清单上）仲裁器基底判定 | `pre == 上一帧 post` 且 `baseFrom='mixer'` | **根因**，已修 |

## 替代方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 每次 `beginFrame` 都 `reset()` 一遍骨骼再让 mixer 写 | 不依赖任何检测 | 会被 `PropertyMixer` 的跳写优化再次绕过（它比的是自己的 accu，不看你有没有 reset） | 否 |
| `sitting` 时暂停 `gaze`/仲裁器 | 一行开关 | 治标：任何"停帧"状态（未来可能还有）都会复发；且丢掉视线 | 否（仅作为排查手段） |
| 每个受控骨骼加"上一帧 mixer 输出"并逐帧 diff（本方案） | 直接观测、与 mixer 内部优化无关、可单测 | 每帧多 5 次四元数拷贝（微秒级） | **是** |
| 换掉 `playHold`，坚持循环播放 | 不触发跳写 | 坐姿片段首尾不接（抬头→低头），循环会跳变 | 否 |

## 后果

**正面**

- 坐姿头骨 1s 漂移从 **2.51 rad → 0.000 rad**；桌面合成截图与窗口截图不再互相矛盾（之前那张"背对镜头"的桌面图就是旋转中的一帧）。
- 判据从"记忆推断"变成"直接观测"，对 three 的跳写优化、`clampWhenFinished`、权重淡入淡出都免疫。
- 新增单测 `bone-arbiter.test.ts`（4 条）：停写 100 帧不累积、写回时基底跟随、写/停交替稳定、零偏移帧不写骨骼。
- 新增自检断言：`sit.headQuat` 1s 不漂移（`baseFrom` 同时进 detail）。

**负面 / 成本**

- 渲染循环多了一步 `capture()`，调用顺序不能被换（`capture` 必须在 `mixer.update` 之前）；已在 ADR 0014 D1 的帧序里固定下来。
- `sameRotation` 的语义从"逐位相同"变成"没有可观测改动"，阈值 1e-6 是标定值（真实姿态变化远大于它）。
- `entry.applied`/`baseFrom` 只为诊断存在，不参与判定逻辑（判定只看 `preMixer` 与当前值）。

**约束**

- 受控骨骼的写入顺序不变：`capture → mixer.update →（视线/反应提交偏移）→ endFrame`。
- 禁止再用"骨骼值 == 上次写入值"作为"动画没写"的判据（那是本轮的错误来源）。
- 停帧姿态（`playHold`）与循环姿态（`playSlot`）共用同一套仲裁逻辑，不得为某一类单独开口子。
