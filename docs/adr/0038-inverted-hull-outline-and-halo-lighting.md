# 0038. 背面法描边（Inverted Hull）与光环受光定论

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-11-02 |
| 决策者 | 项目所有者 |
| 关联 | 契约 §1.1（C-1/C-2/C-4）、§7.3（着色表现、`RenderState` 不增字段）、§11（降级）；ADR 0009（GLB 加载）、ADR 0026（面部贴图），ADR 0037（Toon 光照，本轮的前置） |

## 背景

ADR 0037 让身体/头发吃上了 3 阶 Toon，但轮廓仍然"融进背景"——官方 NPR 的最后一块拼图是**描边**。

硬约束不变：零按次计费、不新增运行时依赖、透明置顶窗口下不能掉帧。
**明确不走后处理**：一张 RenderTarget + 全屏边缘检测 pass 会和 128×72 掩膜采集抢同一帧的 GPU 时间，
而且透明窗口的全屏 pass 还得处理 premultiplied alpha，风险与收益不成比例。

## 决策

### D1 背面法（Inverted Hull）：共享几何 + 共享骨骼，不复制顶点

新增 `src/renderer/render/outline.ts`：

```
mesh.clone(false)            // SkinnedMesh.copy() 会共享同一个 Skeleton 与绑定矩阵
  .material = ShaderMaterial({ side: BackSide, 纯色, 顶点里沿法线外扩 })
  → 挂到原网格的**同一个父节点**下
```

| 项 | 取值 | 理由 |
|---|---|---|
| 几何 | **共享**（`outline.geometry === mesh.geometry`） | 不复制顶点/不复制贴图，内存与上传都只一份 |
| 骨骼 | **共享**（`outline.skeleton === mesh.skeleton`） | `Skeleton.update()` 每帧只跑一次（`WebGLObjects` 按 frame 去重），描边天然跟动作同步，**不存在"滞后一帧"** |
| 父节点 | 与原网格相同 | 世界矩阵逐元素相等（自检断言 `matrixDelta === 0`） |
| 面 | `side: BackSide` | 只画背面 → 只有轮廓处露出来 |
| 片元 | 纯色 `outlineColor` | 不需要光照、贴图、雾 |
| 顶点 | `#include <skinning_*>` 全链 | 蒙皮后的法线与位置，动画时描边跟着形变 |

**没有第二份动画状态、没有第二套矩阵、没有额外 render pass。**

### D2 宽度按**屏幕像素**，不是模型单位

用户建议的 `0.003` 是**模型单位**，在本资产上等于 `0.003 × pixelsPerUnit(≈57538) ≈ 172px` —— 直接把整个人糊成一坨黑。
改为视空间外扩：

```glsl
vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
vec3 viewNormal = normalize( normalMatrix * objectNormal );
vec2 dir = viewNormal.xy;
dir *= smoothstep( 0.02, 0.30, length( dir ) );   // 见 D2.2
mvPosition.xy += dir * outlineWidth;              // 1 视空间单位 = 1 CSS px（正交相机）
mvPosition.z  -= outlineDepthBias;
```

正交相机 + 世界单位 = CSS px ⇒ **N 个视空间单位就是 N 个像素**，所以线宽与角色缩放、
呼吸压扁（`animationRoot.scale.y`）无关，天然满足"线条粗细均匀"。

**D2.1 为什么不做 `normalize(dir)`。**
第一版归一化后，正对镜头的面（`|xy|→0`）会被浮点噪声放大成一个随机方向，仍然外扩满宽 ——
实测在脸皮与头发卡片上留下一片楔形黑块（同帧 A/B 的暗像素占比从 16.1% 涨到 23.3%）。
改成乘 `smoothstep(0.02, 0.30, len)`：轮廓处（`len≈1`）保持满宽，正对镜头的面平滑归零。
改后同样区域的暗像素增量为 +4.2 个百分点，楔形黑块消失。

**D2.2 深度偏移与多边形偏移。**
描边壳只做 xy 外扩，z 与原表面相同；对**近共面**的表面（脸皮、双层衣料）会 z-fighting。
`mvPosition.z -= 0.6`（推远，正交相机视线沿 -Z）+ `polygonOffset(factor 1, units 1)` 双保险。
代价：轮廓外侧 0.6px 的深度不参与遮挡，肉眼不可见。

### D3 应用范围：Body / Hair / Face，其余一律不描

| 材质 | 描边 | 理由 |
|---|---|---|
| `CH0335_Body` | ✅ 1.5px | 衣服/腿/手的外轮廓 |
| `CH0335_Hair` | ✅ **0.8px** | 见 D4 |
| `CH0335_Face` | ✅ 1.5px | 下巴/颈部轮廓；**但实际几乎不可见**（见 D5） |
| `CH0335_EyeMouth` | ❌ | 眼睛/嘴是贴图层，倒角会在眼眶上压出黑线，且表情合成会盖不住 |
| `CH0335_Eyebrow*` | ❌ | 同上（1 texel 纯色块） |
| `CH0335_Halo` | ❌ | 发光体不描边（D6 定论） |
| `Weapon` / `Prop` / `Brush` | ❌ | 默认已隐藏（ADR 0014 D5）；细杆件描边会糊成黑块 |

判定顺序：先 `OUTLINE_EXCLUDE_PATTERN = /eyemouth|eyebrow|halo|weapon|prop|brush|outline/i` 排除，
再匹配 `OUTLINE_TARGET_PATTERN = /^(?:.*_)?(?:Body|Hair|Face)$/i`。

### D4 头发单独一档 0.8px：因为它是**重叠的卡片**

实测（`outline-01-on.png` 的扫描线）：单层发梢的线宽 = 0.8px 档 × smoothstep ≈ 1.4–2.4 设备像素（DPR 2），
但在 3–5 张卡片投影重合的侧发处，每张卡片的描边会**叠加**，1.2px 档能叠出 **12 设备像素（6 CSS px）**的
黑边，看起来像贴纸。降到 0.8px 后重叠区收敛到 2–3 CSS px，单层发梢仍是清晰的一条线。

这不优雅，但它是"卡片式头发 + 背面法"的物理结果：**每张卡片都是一个独立的开口曲面**，各自有轮廓。
想根治只能按"外壳合并"或屏幕空间描边（后处理），两条路都被 D1 的约束否掉。

### D5 脸皮的描边"装了但看不见"——这是资产事实，不是 bug

`Face` 是**开口曲面**（脸皮 + 下巴片）。背面法只画背面；开口曲面正对镜头时所有三角形都是正面，
`BackSide` 全部被剔除 → 不产生任何像素。只有当某块面片的法线转到背离镜头（如下巴下缘）时才露线。

因此：**下巴/颈部那条线实际来自 Body 与 Hair 的描边**。`Face` 仍然按需求接入了描边（结构上存在、
参数可调），但没有可牺牲的观感；把 `Face` 排除也不会让画面变差——保留是因为"以后换模型时脸皮可能是封闭的"。

### D6 光环：**保持 `MeshBasicMaterial`（不吃光、不描边）**

任务二的对照实验（`PET_HALO_DIAG=1`，同姿态）：

| 项 | Basic（全亮） | Toon（吃光） |
|---|---|---|
| 区域亮度均值 | **198.2** | 193.0 |
| 暗像素占比 | **13.2%** | **16.7%** |
| 观感 | 均匀的粉色发光符号，与官方一致 | 右半侧压成暗玫瑰、顶部高光被吃掉，像"脏掉的塑料片" |

定论：**光环是"自发光符号"，它的读数就是"平"**。给它明暗会把"发光"读成"被弄脏"，
而且光环是平面片，法线只有微小起伏，二分线出现的位置随机（看起来像污渍而不是形体）。

具体规定：
- `CH0335_Halo` 保持 `MeshBasicMaterial`；
- **不**加描边（发光体描边会变成黑框）；
- `window.diagnostics.setHaloToon(true)` 只作为诊断保留（ADR 0026 的"一次性对照"惯例），
  **不进生产路径**；`PET_HALO_DIAG=1` 可随时复现这张对照图。

### D7 成本

| 项 | 数值 | 说明 |
|---|---|---|
| draw call | 7 → **10** | 三块描边各一次；无新 pass、无新 RenderTarget |
| 三角形 | 9,926 → **19,130** | 描边重用同一几何，等于把这三块再画一遍（背面剔除后实际像素很少） |
| 帧时间 EMA | 16.7 → **16.7 ms** | vsync 封顶，无可测下降 |
| 二进制 | +1 个模块（~7KB 源码）、0 新依赖 | `ShaderMaterial` / `DataTexture` 都是 three 自带 |

### D8 可观测与回归

- `RenderDiagnostics.outline`（内部诊断，**不进 `RenderState`**）：`enabled / width / hairWidth / depthBias / color / sources / meshes / tracked / matrixDelta`；
- `RenderDiagnostics.render`：`calls / triangles / frameMs`（帧时间 EMA，α=0.05）——"描边有没有拖慢"的可读口径；
- `window.diagnostics.setOutline(bool)`：只切描边壳的 `visible`，主体不动 → 可以拍"只差几根线"的 A/B；
- `window.diagnostics.setHaloToon(bool)`：D6 的对照开关；
- 主链路自检新增 **5 条结构级断言**：三块已加描边（1.5/0.8）、EyeMouth/眉毛/光环/配件不描边、共享几何与骨骼、
  宽度/颜色/深度偏移、「世界矩阵与源网格逐元素一致（`matrixDelta === 0`）」；
- 单测 `outline.test.ts` 6 条：命名判定（含排除优先）、材质形态（`BackSide`/纯色/两档宽度）、
  共享几何+共享骨骼+同父节点、非目标/重复/无父节点的 `null`、`OutlineSet` 幂等与开关、不复制顶点。

### D9 截图对照怎么做到"同一姿态"

模型一直在呼吸/眨眼，直接隔 300ms 拍两张就不叫 A/B 了。`PET_OUTLINE_DIAG=1` 会连拍最多 6 对
"关/开"帧，取**16×16 灰度缩略图差最小**的一对：

- 缩略图每格平均了约 50×90 个像素，几条 1px 的描边线在格内几乎被平均掉；
- 而整体位移 2px 会让**每一格**都变。

第一版用"脸部亮度均值 + 标准差"做判据，对描边不适用（描边本身就会改变脸框统计），
换缩略图后 A/B 两帧的眼睛/手/头发姿态一致（`poseDelta ≈ 1.3–1.5`）。

## 后果

| 项 | 影响 |
|---|---|
| 契约 | **1.15.0**（§7.3「着色表现」新增描边三行 + 光环行；§11 新增描边降级行；`RenderState` 未增删字段，无新事件/状态/`intent`/`emotion`/IPC） |
| 依赖 | 无新增（`ShaderMaterial` / `BackSide` / `polygonOffset` 均为 three 内置） |
| 降级 | 材质名匹配不到 → 不加描边、不报错，模型照常显示；`OutlineSet` 构造/装配异常被上层 try-catch 兜住（WARN 一条） |
| 与掩膜的关系 | 描边属于可见轮廓，所以掩膜（128×72）会把它算进去 —— 点轮廓也能点中她，符合直觉；掩膜大小变化 ≤ 1.5px，R-9 的矩形退路不变 |
| 已知代价 | 头发卡片重叠处的线宽会叠加（0.8px 档收敛到 2–3px）；脸皮的描边几乎不可见（D5） |
| 证据 | `dist/diagnostics/{outline,halo}-comparison.json`、`dist/selftest/outline-0{0-off,1-on}.png`、`outline-{off,on}-{head,hair,coat,face,hand}.png`、`halo-0{0-basic,1-toon}{,-crop}.png` |
| 复现 | `PET_SELFTEST=1 PET_OUTLINE_DIAG=1 node scripts/start.mjs --selftest`；`PET_HALO_DIAG=1` 同 |
