# 0037. 全局光照与 Toon 材质：身体/头发吃光、面部死守、零新增成本

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-11-02 |
| 决策者 | 项目所有者 |
| 关联 | 契约 §1.1（C-1/C-2/C-3/C-4）、§7.3（`RenderState` 不增字段、面部表现规则）、§11（降级矩阵）；ADR 0009（GLB 加载/材质统一转无光照）、ADR 0026（面部贴图合成）、ADR 0036（被本轮废止的手部顶点色烘焙） |

## 背景

阶段 14 的观感结论：角色是 `MeshBasicMaterial` 平涂，**没有明暗、没有体积**，和《蔚蓝档案》官方 NPR 的"硬边二分阴影"差距明显。

上一轮（ADR 0036）为了修"手发白"，把明暗**烘焙进顶点色**。那是局部补丁，不是着色方案：全身上下只有 214 个手/小臂顶点有明暗，身体、衣服、头发仍然是零光照。

本轮要先回答"这套资产到底能不能做 NPR"，再决定动不动材质。**硬约束不变**：不产生任何按次计费的外部调用（C-1）、不内嵌模型文件（C-4）、不新增运行时依赖（T-3）。

## 资产审查（2026-11-02，本机 `CH0335.glb`，14.9 MB）

工具：`tools/audit-glb-assets.mjs`（只读；自带 PNG 解码，`node tools/audit-glb-assets.mjs CH0335.glb`），报告落 `dist/diagnostics/asset-audit.json`。

### A. 贴图（8 张，全部 RGBA8，全部只有 baseColor 槽）

| # | 名称 | 分辨率 | 格式 | 唯一色数 | 灰阶占比 | Alpha | 用于 |
|---|---|---|---|---|---|---|---|
| 0 | `CH0335_Face.png` | 128×128 | RGBA8 | 78 | 2% | 全不透明 | `CH0335_Face` / `Eyebrow` / `Eyebrow2` |
| 1 | `CH0335_EyeMouth.png` | 128×128 | RGBA8 | 316 | 9% | 全不透明 | `CH0335_EyeMouth` |
| 2 | `CH0335_Hair.png` | 512×512 | RGBA8 | 44 | 25% | 全不透明 | `CH0335_Hair` |
| 3 | `CH0335_Body.png` | 512×512 | RGBA8 | 873 | 11% | 全不透明 | `CH0335_Body` |
| 4 | `CH0335_Weapon.png` | 64×64 | RGBA8 | 64 | 39% | 全不透明 | 已隐藏的配件 |
| 5 | `CH0335_Prop.png` | 64×64 | RGBA8 | 22 | 38% | 全不透明 | 已隐藏的配件 |
| 6 | `CH0335_Brush_01.png` | 64×64 | RGBA8 | 6 | 31% | 全不透明 | 已隐藏的配件 |
| 7 | `CH0335_Halo.png` | 32×32 | RGBA8 | 23 | 0% | 全不透明 | 光环 |

### B. 没有 Mask / Ramp 贴图（三条独立证据）

1. **槽位**：10 个材质全部只有 `baseColorTexture`，**没有** `occlusionTexture` / `normalTexture` / `emissiveTexture` / 第二张自定义槽 —— 没有任何位置可以挂 Mask/Ramp；
2. **形态**：8 张图没有一张是灰阶阶梯，也没有"少量颜色而通道互不相关"的打包图（`maskOrRampTextures: []`）；
3. **命名**：没有任何文件名带 `mask` / `ramp` / `toon` / `shade` / `shadow`；
4. **UV**：只有 `TEXCOORD_0`，**没有第二套 UV**（Mask 贴图通常要第二套 UV 才划算）。

结论：**这套资产是"纯色平涂 + 一张颜色贴图"的移动端 NPR 资产，阴影信息靠顶点色，不靠 Mask/Ramp。** 官方"影子范围可控"的能力在本资产里不存在，硬边二分只能由**光照模型本身**产生（这就是本轮选 `MeshToonMaterial` + `gradientMap` 的原因）。

### C. 顶点色 `COLOR_0`：RGB 是常量，**alpha 才是数据**

| 网格 | 材质 | 顶点数 | RGB | alpha 直方图（值×顶点数） |
|---|---|---|---|---|
| `CH0335_Body[0]` | Face | 617 | 全 1 | 0×346, 0.502×138, 1×130, 0.251×3 |
| `CH0335_Body[1]` | Eyebrow | 76 | 全 1 | 0×76 |
| `CH0335_Body[2]` | EyeMouth | 351 | 全 1 | 0×351 |
| `CH0335_Body[3]` | Eyebrow2 | 106 | 全 1 | 0×106 |
| `CH0335_Body[4]` | Hair | 2276 | 全 1 | 0.502×1823, 0.349×123, 0×84, 0.2×84, 0.102×46 |
| `CH0335_Body[5]` | Body | 4319 | 全 1 | 0.502×1937, 1×1683, 0×547, 0.251×100, 0.102×32 |
| `CH0335_Weapon[0]` | Weapon | 5304 | 全 1 | 0.502×4743, 0.251×268, 0×149, 1×120, 0.745×24 |
| `CH0335_Prop_Outlline[0]` | Prop | 9888 | 全 1 | 0.502×9888 |
| `brush_01[0]` | Brush_01 | 1056 | **常量 `(0.141,0.086,0.043)`** | 1×1056 |
| `CH0335_Halo[0]` | Halo | 72 | 全 1 | 1×72 |

解读：

- **RGB 没有任何空间变化**（要么全 1，要么整块一个常量）→ 顶点色**不能**当颜色/明暗乘子用，ADR 0036 那套"乘进 COLOR_0.rgb"的做法只能覆盖到 214 个手部顶点，天然无法推广；
- **alpha 是真实数据**，且取值集中在 `0 / 26 / 51 / 64 / 89 / 128 / 190 / 255` 这类 8 bit 量化值（0.502 = 128/255、0.251 = 64/255、0.349 = 89/255），即 DCC 里导出的一张 8 bit 遮罩。按骨骼归类的分布（`Bip001 Spine1`、`bone_ribborn_*`、`Head`…）说明它与"部位/飘带"相关，**最可能是描边或边缘光遮罩**（Blue Archive 的 shader 常用顶点 alpha 控制描边宽度），而不是阴影 ramp；
- 因此本轮**不把 `COLOR_0.a` 接进任何管线**：面部的 `Eyebrow` / `EyeMouth` alpha 恒为 0，若拿它当不透明度或阴影阈值，眉毛和五官会直接消失/全黑。这条已作为"禁止项"写进 D4。

## 决策

### D1 只给身体与头发加光，用 `MeshToonMaterial` + 3 阶 `gradientMap`

新增 `src/renderer/render/toon-shading.ts`，职责单一：建灯、建色阶贴图、按材质名换材质、可逆。

| 项 | 值 | 理由 |
|---|---|---|
| 主方向光 | `DirectionalLight`，强度 **2.6**，方向 `(-0.38, 0.72, 0.58)` 归一化 | 斜上方偏左前（`+Z` = 面向镜头），和 ADR 0036 烘焙用的光向一致，A/B 可比 |
| 环境光 | `AmbientLight`，强度 **0.55** | 占受光面亮度的 **17.5%**，即"极低"；保证背光面不死黑 |
| 亮度配平 | `ambient + directional = π` | three 的 toon BRDF 是 `map ×(ambient + ramp×directional)/π`，此时**受光面 = 贴图原色**（白外套仍是官方白，不整体压灰） |
| 色阶 | 3 档：`dot ≤ 0.12 → 0.58`、`0.12 < dot ≤ 0.38 → 0.80`、`> 0.38 → 1.00` | `NearestFilter` ⇒ 硬边；断点偏正使正对镜头的平face落在受光档，二分线出现在圆柱侧缘 |
| 色阶贴图 | `DataTexture` 32×1、`NearestFilter`、`NoColorSpace` | shader 取 `.r`，必须是亮度乘子（不能被 sRGB 解码）；32 格量化误差 < 1 texel |
| 命中材质 | `CH0335_Body`（身体/衣服）、`CH0335_Hair`（头发） | 本轮范围 |

`MeshToonMaterial` 保留原 `map` / `color` / `alphaTest` / `side` / `depthWrite` / `toneMapped:false`；`gradientMap` 由本模块持有并随 `dispose()` 释放。

### D2 为什么不是自定义 shader、不是 `MeshStandardMaterial`、不是后处理

- 自定义 shader 要自己写光照、蒙皮、雾、阴影的 GLSL 组合，等于接管 three 的材质体系（后续 `three` 升级必然踩坑）；
- `MeshStandardMaterial` 是 PBR：需要环境贴图才有金属/粗糙度表现，透明窗口里没有 IBL → 会发灰发黑（和 ADR 0036 实测一致）；
- 后处理描边/色调分离要额外的 RenderTarget 与 pass，违反"每帧成本不变"的项目取向；
- `MeshToonMaterial` 是 three 自带、无新依赖、成本与 Lambert 同级，`gradientMap` 就是官方给 NPR 留的口子。

### D3 面部死守：`Face` / `EyeMouth` / `Eyebrow*` 永不参与 Toon

`isToonMaterialName()` 先跑 `FACE_MATERIAL_PATTERN = /face|eyemouth|eyebrow/i` 排除，再匹配 `/*_Body$ | *_Hair$/`。双保险，理由：

1. 面部贴图是**已经烘焙好的最终颜色**（含腮红、眼睛高光、嘴部底色），吃光只会变脏；
2. ADR 0026 的表情合成往 `EyeMouth`/`Face` 贴图上逐像素写，材质若带光照，`faceDistance` 这类贴图级断言会失真；
3. 面部一旦发黑，是最刺眼的回归（§7.3"表情整体不生效但动作照常"都算可接受，脸黑不可接受）。

代价是"脸与身体的光照不一致"。本轮接受：Q 版脸本来就以平涂为主，实测脸/身亮度差在可接受范围内（见 D6 数据）；若将来要统一，属于"给脸做专用不受光但带边缘光的材质"，需要另开 ADR。

### D4 废止 ADR 0036 的顶点色烘焙（`skin-shading.ts` 删除）

- 删除 `src/renderer/render/skin-shading.ts` 与 `skin-shading.test.ts`；
- 删除 `bakeSkinShading` / `restoreSkinShading` / `clearSkinShadingCache` / `shadeSkinVertices` / `setSkinBake` 及 `window.diagnostics.shadeSkin` / `setSkinBake`；
- `dominantBoneNames` / `matchesSkinBone` 迁到 `material-diagnostics.ts`（只剩诊断在用）；
- `COLOR_0` 回到模型原值（全 1），手/小臂和其它部位一样**由光照产生明暗**。

**禁止**把 `COLOR_0.a` 接进 `alphaTest` / `transparent` / 阴影阈值：`Eyebrow` 与 `EyeMouth` 的 alpha 恒为 0（见 C 表），接进去会把眉毛和五官整块裁掉。Toon 材质显式 `vertexColors: false`，把这条约束固化在代码里。

### D5 可逆与可观测

- `ToonShading.setEnabled(false)` = 摘灯 + 还原原始 `MeshBasicMaterial`，即"本轮修改前的样子"，供截图 A/B；
- `RenderDiagnostics.toon`（内部诊断，**不进 `RenderState`**）：`{ enabled, ambient, directional, direction, gradientSteps, gradientWidth, materials[{mesh,material,from,to}], litMeshes }`；
- 主链路自检新增 4 条**材质级**断言：只有 `CH0335_Body` + `CH0335_Hair` 变 Toon、3 阶色阶单调且顶档为 1、面部材质不在替换列表、`ambient + directional ≈ π`；
- 单测 `toon-shading.test.ts` 6 条：命名判定（含"名字带 Face 的 Body 也不换"）、色阶形态/断点、材质替换保留字段、A/B 可逆、光照配平。

### D6 证据（`PET_TOON_DIAG=1`，同姿态同帧、只切换光照）

工具：`$env:PET_SELFTEST='1'; $env:PET_TOON_DIAG='1'; node scripts/start.mjs --selftest`
产物：`dist/diagnostics/toon-comparison.json`、`dist/selftest/toon-00-before.png` / `toon-01-after.png`、`toon-{before,after}-{coat,torso,face,handL,handR}.png`。

因为动画在跑（眨眼/呼吸），脚本会连拍最多 5 对 before/after，取**脸部亮度统计最接近**的一对（眨眼会同时改变脸部均值与标准差），保证两张图是同一表情状态。

| 区域 | 亮度均值（前 → 后） | 亮度标准差（前 → 后） | 近白占比（前 → 后） |
|---|---|---|---|
| 全身可见像素 | 184.3 → 176.5（**−7.8**） | 66.2 → 64.8 | 15.8% → 13.3% |
| 外套（胸口 180px） | 183.3 → 175.1（**−8.2**） | 73.3 → 70.6 | **38.6% → 30.6%** |
| 躯干/裙（160px） | 161.9 → 156.4（−5.5） | 80.0 → 77.9 | 28.0% → 22.2% |
| 脸（72px，含刘海） | 218.3 → 214.2（−4.1） | 45.7 → 46.1 | 49.5% → 48.1% |
| 左手（握领带，90px） | 160.2 → 152.9（−7.3） | 83.7 → 79.3 | **35.1% → 19.3%** |

解读：

- 外套"近白像素"从 38.6% 掉到 30.6% —— 平涂面被压到中间档，这正是"有了明暗关系"的量化表现；左手**近白占比腰斩**（35%→19%），即 ADR 0036 那个"发光白板手"问题在真光照下自然消失；
- 全身亮度只降 4.2%（−7.8/184），**没有出现 ADR 0036 实测的"整体偏灰"**：受光面仍等于贴图原色，暗的只是背光侧；
- 脸部区域的小幅下降来自**框内的刘海**（头发是 Toon），面部材质本身未被替换（`materials` 只有 2 条 swap，且自检有断言）。

### D7 已知取舍与坑位

| 项 | 事实 | 处理 |
|---|---|---|
| 本资产没有 Mask/Ramp | 影子形状完全由法线决定，不能"画"阴影 | 换模型/换皮肤前先跑 `tools/audit-glb-assets.mjs` |
| `COLOR_0.a` 是 8 bit 遮罩（疑似描边）但 RGB 是常量 | 直接接进管线会破坏眉毛/五官 | 恒不开 `vertexColors`；要用 alpha 必须另开 ADR + 单测 |
| 面部不吃光 | 脸与身体的光照方向不完全一致 | 本轮接受；要统一需专用不受光材质（另开 ADR） |
| 配件（Weapon/Prop/Brush/Halo）仍是平涂 | 本轮范围只到身体/头发；配件默认已隐藏（ADR 0014 D5），光环仍在 | 若要让光环吃光，扩 `TOON_MATERIAL_PATTERN` 即可，但要先确认光环的 alpha |
| 二分线位置依赖光照方向 | 换个 `TOON_LIGHT_DIRECTION` 观感会明显变化 | 参数集中在 `toon-shading.ts` 顶部常量；调完必须重跑 `PET_TOON_DIAG=1` |

## 后果

| 项 | 影响 |
|---|---|
| 契约 | **1.14.0**（§7.3 新增「着色」规则表、§11 新增一行降级；`RenderState` 字段未增删，无新事件/状态/`intent`/`emotion`/IPC） |
| 依赖 | 无新增（`three` 自带 `MeshToonMaterial` / `DataTexture` / `AmbientLight` / `DirectionalLight`） |
| 成本 | **0**：2 盏灯 + 1 张 32×1 贴图，每帧成本与 Lambert 同级；不联网、不计费 |
| 性能 | 材质数不变（2 个网格各 1 个材质），多一张极小的 uniform 贴图；无新增 pass、无新增 RT |
| 降级 | 材质名匹配不到（换模型）→ 不换材质、不加光，模型照常显示，一条 WARN；渐变贴图创建失败 → 同上（`ToonShading` 构造整体包 try/catch） |
| 测试 | 单测 **+6**（`toon-shading`），删 `skin-shading` 6 条；主链路自检 4 条新断言替换原"手部烘焙"1 条 |
| 证据 | `dist/diagnostics/{asset-audit,toon-comparison}.json`、`dist/selftest/toon-0{0-before,1-after}.png`、`toon-{before,after}-coat.png` |
| 复现 | `node tools/audit-glb-assets.mjs CH0335.glb`；`PET_SELFTEST=1 PET_TOON_DIAG=1 node scripts/start.mjs --selftest` |
