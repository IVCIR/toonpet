# Azalea 坐姿与物理交互逆向报告

> 对象：`D:\Azalea\Azalea`（Python + PyQt6 + QWebEngine + Pymunk）
> 方法：通读 `pet/physics.py`、`pet/pet_window.py`、`pet/window_tracker.py`、`pet/ai_utils.py`、
> `front/index.html`，并用只读 GLB 解析统计了 `models/mika.glb` 的 `CH0069_my_event15_teapartytable`
> 关键帧（脚本只在 `logs/` 下临时运行，未改参考项目）。
> 日期：2026-11-05

## 0. 先纠正一个前提

**Azalea 不是 2D 桌宠，也没有 Live2D / 精灵图。** 它是透明窗口里的 **3D GLB 播放器**：

- `front/index.html` 直接 `import { GLTFLoader }`、`OutlineEffect`，加载 `models/mika.glb`（15.5 MB，38 段动画）；
- 骨骼动画由 `THREE.AnimationMixer` 播放；
- Python 侧只做窗口、物理、命中、动作编排，**不碰骨骼**。

这一点决定了整个报告的结论：**它的"灵动"不是程序化微动，也不是 2D 局部变换，而是官方长动画片段本身**。
所以"照抄它的逻辑"要抄的是**片段架构 + 切换时机**，不是它的物理引擎。

## 1. 站立 → 坐姿：一次硬切 + 一次模型瞬移

### 1.1 代码路径

`pet/ai_utils.py` 的 `Actions.sit()`（153–158 行）：

```python
async def sit(self):
    if self.if_sit:
        return
    await self.play_animation("CH0069_my_event15_teapartytable", loop=True, fade_duration=0)
    await self.set_model_transform(position=(1.2, -0.55, -0.5), rotation=(0, 170, 0), rotation_degrees=True)
    self.if_sit = True
```

`stand()`（160–165 行）完全对称：

```python
await self.play_animation("CH0069_Cafe_Idle", loop=True, fade_duration=0)
await self.set_model_transform(position=(0.0, 0.0, 0.0), rotation=(0, 90, 0), rotation_degrees=True)
```

`fade_duration=0` 在渲染侧的含义（`front/index.html` 419–447 行）：

```js
if (oldAction) {
  if (fadeDuration > 0) {
    oldAction.crossFadeTo(newAction, fadeDuration, false);
  } else {
    oldAction.stop();          // ← 没有交叉淡入：上一段立刻停
  }
}
newAction.play();
```

`set_model_transform` 也不是补间，而是**直接写** `model.position / rotation / scale`
（`front/index.html` 449–499 行）。所以：

**结论：站 → 坐没有代码级过渡动画，是"停掉站姿 + 起播 22.5s 坐姿片段 + 瞬移模型"三件事在同一拍发生。**
镜头里看起来自然，是因为坐姿片段自己在起始帧就提供了坐姿（推断：如果起始帧还是站姿，`y = -0.55` 的
下移会让她站到地面以下），而不是代码在插值。

### 1.2 为什么"坐下像瞬移"在 Azalea 上不明显

因为它**先落位、再坐**，而且中间隔了 1 秒：

- `jump_on_window(..., sit_after=True)`（175–191 行）先做跳跃物理，落地完成后再
  `await asyncio.sleep(sit_after_delay)`（默认 1.0s），然后才 `sit()`；
- `walk(..., sit_after=True)` / `jump_into_window(...)` 同理。

也就是说：**物理负责"到窗沿"，坐姿负责"换姿势"，两者用 1s 延迟解耦**。
用户看到的是"跳上去 → 停一下 → 坐下"，而不是"跳到一半突然变成坐姿"。

### 1.3 平台吸附：几何硬 snap，不是弹性落座

`pet/window_tracker.py` 的 `handle_window_top_landing()`（313–376 行）是唯一的上沿落地逻辑：

```python
if vy < 0:                 # 还在上升，不判落地
    return
...
crossed_top = previous_bottom <= window.y <= pet_bottom
...
target_y = max(COLLISION_HEIGHT / 2, landed.y - COLLISION_HEIGHT / 2)
physics.body.position = (gx, target_y)   # ← 直接吸到窗沿
physics.body.velocity = (vx * 0.78, 0)   # ← 竖直速度清零，水平保留 78%
self.active_platform_hwnd = landed.hwnd
self._arm_window_bounce_pending(landed.hwnd, abs(float(vy)))
```

- 判定是**纯几何**：上一帧身体底边 ≤ 窗口顶边 ≤ 这一帧身体底边，且水平有重叠；
- 命中后**直接改 body.position**，没有弹簧、没有插值；
- 紧接着 `_arm_window_bounce_pending` 把"冲击速度"交给 **`WindowBouncePhysics`**。

`WindowBouncePhysics`（`pet/physics.py` 197–263 行）弹的不是桌宠，而是**被踩的那扇桌面窗口**：

```python
self.mass = max(4.0, (self.width * self.height) / 140000.0)
stiffness = 180.0 * self.mass
damping = 16.0 * self.mass
self.spring = pymunk.DampedSpring(static_body, self.body, ..., stiffness, damping)
...
impulse = clamp(abs(impact_speed) * 36.0, 320.0, 6800.0)
self.body.apply_impulse_at_local_point((0.0, impulse))
```

`window_tracker.update_window_bounce()`（393–440 行）每帧把窗口 Y 设为 `origin_top + offset_y`，
并把桌宠 body 的 Y 同步加同样的 offset。于是观感是"她落到窗沿上，窗沿被踩得往下一沉"，
**桌宠自己的落地是硬的**。

### 1.4 拖拽悬挂才是 PivotJoint

`pet/physics.py` 113–133 行的 `start_drag()`：

```python
self.mouse_body.position = (x, y)
local_anchor = self.body.world_to_local(self.mouse_body.position)
self.mouse_joint = pymunk.PivotJoint(self.mouse_body, self.body, (0, 0), local_anchor)
self.mouse_joint.max_force = 10_000_000
self.mouse_joint.error_bias = pow(1.0 - 0.18, 60.0)
```

- 鼠标是 **KINEMATIC body**，桌宠是普通 body（质量 14、盒子碰撞体、elasticity 0.2、friction 1.5）；
- PivotJoint 把"按下点"作为刚体支点，所以拖动时身体会**绕抓取点转**，松手后保留角速度；
- `end_drag()` 143–163 行用拖拽队列的**首尾两点**算速度（不是末 100ms），直接赋给 body；
- `launch_towards()` 165–191 行是抛物线初速度，用于"跳到窗口上"。

**坐姿完全不用 PivotJoint**：坐下后 `ai_follow` 结束，body 只是被 `follow_active_platform()`
（442–479 行）每帧夹在窗沿上（`abs(bottom - platform.y) < 6` 时重新对齐，vx×0.96）。

## 2. 坐下后的"四处张望"：没有控制器，全是关键帧

### 2.1 代码里没有视线/眼神逻辑

对 `pet/*.py` 与 `front/*.html` 全量搜 `look_at` / `gaze` / `eye` / `head` / `bone`：
**没有任何运行时视线、头部跟随、眼球控制代码**。鼠标事件只用于命中、拖拽、右键菜单
（`front/index.html` 507–547 行：`isPointOnModel` + `hit_test` + `play_anim`/`set_transform`）。

### 2.2 "张望"在片段的骨骼曲线里

`CH0069_my_event15_teapartytable`：**22.5s、440 通道、24fps（541 帧）**。
对头部/眼/腿的旋转通道做"相对第一帧的四元数夹角"统计：

| 骨骼 | 峰值夹角 | 峰值时刻 | 单帧最大步进 |
|---|---:|---:|---:|
| `Bip001 Head` | **0.651 rad（37.3°）** | 7.17s | 0.050 |
| `Bip001 Neck` | 0.377 rad（21.6°） | 15.29s | 0.042 |
| `Bip001 eye_L_1` | 0.368 rad（21.1°） | **9.75s** | 0.227 |
| `Bip001 eye_R_1` | 0.368 rad | 9.75s | 0.223 |
| `Bip001 L/R Thigh` | 0.032 / 0.080 rad | 19.5s | 0.003 / 0.007 |
| `Bip001 L/R Calf` | 0.143 / 0.168 rad | 7.25 / 6.92s | 0.018 / 0.040 |
| `Bip001 L/R Hand` | **2.277 / 1.730 rad（130.5° / 99.1°）** | 19.08 / 10.21s | 0.184 / 0.259 |

**头部峰值在 7.17s，眼球峰值在 9.75s，颈部峰值在 15.29s**——三者的时间差是**画在动画曲线里的**，
不是代码用不同阻尼算出来的。也就是说：

> 用户看到的"眼先动、头慢半拍、脖子最后跟"，在 Azalea 里是**动画师 K 帧的结果**；
> 代码没有做任何眼/头分离。

这正是我们 `gaze.ts` 已经用三层阻尼（眼 12 / 头 8 / 躯干 4 + 眼球领先份额）在 3D 里
**程序化重建**的东西。方向上我们比 Azalea 更"工程化"，不需要退回去抄它的"无控制器"。

### 2.3 它不跟鼠标

`front/index.html` 的鼠标位置只用于 `isPointOnModel()` 的 raycast 命中；
没有 `mousemove` → 视线目标。所以 Azalea 的坐姿张望是**固定片段**，看多久、看哪里都由 22.5s 循环决定。
看几分钟会循环——这恰好是用户觉得"灵动"的来源，也是它的上限。

## 3. "晃腿"：骨骼动画，不是 2D 平移/旋转

- 代码里没有任何腿骨引用（Python 没有骨骼 API，JS 没有 `getObjectByName`/`skeleton` 操作）；
- 腿的旋转只在 GLB 的动画通道里：大腿 0.032–0.080 rad（1.8–4.6°），小腿 0.143–0.168 rad（8.2–9.6°）；
- 真正的大幅运动是**手**（1.73–2.28 rad，99–130°）和**头**（0.651 rad，37°）；
- `Pelvis` 的 translation 只有 2 帧、range 为 0：没有根位移，所以不是"整张图在平移"。

**结论：晃腿是 `my_event15_teapartytable` 这段 22.5s 官方动画里烘焙的小腿/大腿关键帧。**
它的幅度不大（小腿 ~9°），但因为角色是 Q 版、腿短，画面上读起来像"晃腿"。
如果照抄"9° 小腿"到我们的 3D 模型上，效果会接近 ADR 0045 D3 的 0.136rad（7.8°）——这正是我们现在的参数，
说明我们此前的标定方向是对的。

## 4. 3D 模型可以借鉴什么

### 4.1 眼睛下瞟：不要用 IK 硬掰眼球，先分清"头低"还是"贴图低"

Azalea 没有这个问题，因为它的坐姿片段**本身就是抬头看人的关键帧**；
我们的问题来自 `playHold` 把片段冻在某一帧，且我们的眼睛是**近平面卡片 + 画在贴图上的虹膜**
（ADR 0047 已实测：眼骨 ±0.35rad 只让虹膜挪 2–3px）。所以：

1. **先判因**（已有 `face-sit.png` / `face-probe.png`）：
   - 准星在眼眶中心、瞳孔偏下 → **贴图/UV 问题**，转骨头无效；
   - 准星本身偏出眼眶 → **头骨/脸卡朝向问题**，调头部基底或 `SIT_HEAD_TUNE_RAD`。
2. **头的朝向才是主杠杆**：坐姿停帧后，头/颈/胸的基底已被 `ADR 0048` 覆盖成站立局部四元数；
   先用这个基底把"脸平面"对向相机，再叠张望。不要用"眼球 IK 目标"去补偿一个贴图问题。
3. **目标策略**：坐姿不要持续追光标（ADR 0044 D3 已关闭），但可以给 `sit-motion` 的张望池
   增加一个**"看镜头"目标**（屏幕中心方向，权重 1/3），与"看远处/看手"并列；
   用固定时长 `easeInOutCubic` 转过去，到位后静止 ≥2s（ADR 0049 D6）。
   这比"强制看向屏幕坐标"更像活人，也不会把脖子拧死。
4. **眼球只做次级**：保留 `overrideBase(eye, bind)` + `张望 × 0.35`；
   如果虹膜是贴图，眼骨的唯一价值是"不保留片段自带的向下看"，不是"让瞳孔对准相机"。

### 4.2 摆脱 `playHold`：两段式，但不是"循环 0.2s"

Azalea 的做法是**一整段 22.5s 的坐姿长动画循环**，里面自带坐好、张望、晃腿、手部动作。
我们的坐姿片段是 38.25s 的回忆演出，14.5–14.7s 只是"最平稳的 0.2s"，**没有可循环的坐姿 idle 段**；
ADR 0043 D2 已经证明把 0.42s 循环起来会读作"抽搐"。

可借鉴的是**两段式**，而不是照抄循环长度：

| 阶段 | 内容 | 时长 | 关键点 |
|---|---|---|---|
| A 进入 | 从 **14.2s 正放**（不是 hold），让官方片段自己演"坐好 + 第一次张望" | ~1.8–2.0s | 这段里 14.96s 有一次头部 0.253rad 的快速转头（实测），是现成的"坐下后看一下"；**此阶段不要用 ADR 0048 的站立上半身覆盖**，否则烘焙的头部动作会被盖掉 |
| B 稳定 | 在 **16.0–16.3s** 附近停帧（此时仍是坐姿；17.0s 之后大腿/小腿开始起身，不能用） | 持续 | 这时再淡入站立上半身覆盖 + 程序化呼吸/张望/晃腿；覆盖权重用 0.3–0.4s 淡入，避免"头啪地回正" |
| C 变奏 | 每 10–20s 播一次"官方烘焙张望"（14.5–16.3）作为一次性片段，或继续用 `SIT_MICRO_POOL` | 1.5–2s | 前者更自然但会打断程序化张望；后者零新素材。建议先做 B，观察后再决定 C |

> 注意：A 阶段如果直接 `playHold` 在 14.7s，就会把 14.96s 的转头**冻掉**——这正是"假人感"的来源之一。
> 先正放 1.5s 再停，坐下的第一秒就有官方动作。

### 4.3 站 → 坐的"跳上去"：用标量弹簧，不要引入物理引擎

Azalea 的跳跃是 Pymunk 抛物线（`launch_towards`），坐姿是硬切；它没有"弹簧坐姿"。
我们的窗口位移已经有 `shared/motion.ts` 的弹簧函数，**不需要 Pymunk**。建议：

- 把现在 `sitPose()` 的 240ms 线性半蹲（`transitionLiftPx` 14→0、`thighBend` 0.22→0）
  改成**临界阻尼弹簧**驱动的标量 `sitDrop`：
  `x'' = -k(x - 1) - c x'`，`k = 180`、`c = 2√k ≈ 26.8`（ζ=1），从 0 → 1 约 250–300ms；
- 所有坐姿量（下沉、补偿、大腿弯曲、微侧身）继续乘这个 `sitDrop`（现有 `sitGain` 已经是这个角色，
  只需把"时间包络"换成"弹簧解"）；
- 起跳仍用 `snap_approach` 的 leap 弧线（shell 已有），**不要**让窗口真的做自由落体；
- 落地冲击仍按 `drag_released.vy` 的口径（ADR 0040 D3），不要因为坐姿弹簧又造一套冲击。

**为什么不用 Pymunk/物理引擎**：我们只有一个刚体（窗口），窗口位置归 shell，模型姿态归 render；
引入物理引擎会多一个 tick、多一套坐标系，且与"零成本、单 16ms 轮询器"的契约冲突。
标量弹簧已经足够，且完全可单测。

## 5. 事实 / 推断清单

| 结论 | 性质 | 证据 |
|---|---|---|
| Azalea 是 3D GLB 播放器，不是 2D/Live2D | **事实** | `front/index.html` imports GLTFLoader/OutlineEffect；`models/mika.glb` 38 段动画 |
| 站→坐是硬切（fade 0）+ 模型瞬移 | **事实** | `ai_utils.py` 153–158；`front/index.html` 419–447、449–499 |
| 坐下与落地用 1s 延迟解耦 | **事实** | `ai_utils.py` 175–191 |
| 平台吸附是几何硬 snap，不是弹簧 | **事实** | `window_tracker.py` 313–376 |
| 被踩的是桌面窗口，桌宠只是同步 offset | **事实** | `physics.py` 197–263；`window_tracker.py` 393–440 |
| PivotJoint 只用于拖拽 | **事实** | `physics.py` 113–133；坐姿路径不调用 |
| 坐姿张望/眼头分离/晃腿都在 22.5s 片段里 | **事实** | GLB 通道统计：Head 0.651@7.17s、eye 0.368@9.75s、Neck 0.377@15.29s、Calf 0.168@6.92s |
| 运行期没有任何视线/骨骼控制器 | **事实** | 全仓 grep 无 `look_at`/`gaze`/`skeleton`/`bone` 逻辑；鼠标只做命中 |
| "眼先动、头慢半拍"是动画 K 帧而非代码阻尼 | **推断**（由峰值时刻差 + 无控制器代码推出） | 同上 |
| 我们的 14.5–16.3s 含有可用的官方"坐下后张望" | **实测**（我们的模型） | Head 在 14.96s 有 0.253rad 快速转头，16.42s 前保持 ~0.2rad；17.0s 后起身 |
| 两段式（A 正放 + B 停帧覆盖）能改善"假人感" | **建议/待验证** | 需要真机 A/B；本文不声称已实现 |

## 6. 对我们第一阶段的附带结论

第一阶段（待机站姿轮换）与 Azalea 的坐姿没有依赖关系，但这次逆向确认了两件事：

1. **长片段 > 程序化拼姿态**：Azalea 的灵动来自"官方 22.5s 里什么都有"；我们的 44 段里没有坐姿 idle 长片段，
   所以坐姿只能走"官方姿态 + 程序化微动"（ADR 0044/0049），这是资产差异，不是实现优劣。
2. **不要在冻结的片段上再叠全身覆盖**：ADR 0048 的站立上半身覆盖解决了"上半身僵硬/低头"，
   但也把片段里可能的头部动作盖掉了。坐姿若要"活"，要么接受程序化（现状），要么在进入阶段先让片段自己演 1.5s，
   再淡入覆盖（4.2 的两段式）。这是第二阶段最值得先做的一次 A/B。

## 7. 落地记录（2026-11-05）

本报告的建议已被 [ADR 0051](../adr/0051-two-stage-sit-spring-and-camera-gaze.md) 采纳并落地：

- 坐姿窗口 **14.2–16.2s**：阶段 A 正放（14.2–16.0）让 14.95s 的官方转头可见，阶段 B 16.0–16.2 停帧；
- 下坐改为**临界阻尼弹簧**（k=180 / c=26.8），替代 240ms 线性半蹲；
- 阶段 B 的站立上半身覆盖从三根扩为**下背/胸/颈/头四根**——真机 A/B 证明只覆盖后三根时，
  16.2s 片段的下背前倾会被整条上链继承，头仍然低（`headOrientation.pitch` 约 0.59rad；
  加下背后约 0.01rad）；
- 张望增加 **1/3 概率看镜头**（yaw/pitch=0），其余仍为随机张望。

也就是说：报告里"借片段架构、不借物理引擎；用标量弹簧；先分清头低还是贴图低"三条建议，
在本项目里分别落成了两段式、`sit-drop.ts` 和"下背覆盖 + 看镜头目标"。

---

### 附：本文引用的文件

- `D:\Azalea\Azalea\pet\physics.py`
- `D:\Azalea\Azalea\pet\window_tracker.py`
- `D:\Azalea\Azalea\pet\pet_window.py`
- `D:\Azalea\Azalea\pet\ai_utils.py`
- `D:\Azalea\Azalea\front\index.html`
- `D:\Azalea\Azalea\models\mika.glb`（只读统计）
