# 0009. GLB 加载管线、骨骼映射与包围盒校正

| 项 | 值 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-10-28 |
| 决策者 | 项目所有者 |
| 关联 | `CONTRACTS.md` §1.1 C-4、§1.2、§3.1、§3.2（尺寸/锚点）、§6.3（`model_ready`）、§7.3、§11；ADR 0002、ADR 0004 D8.1；本 ADR 使契约中"VRM / three-vrm"的表述过时，本轮按指令**不改** `CONTRACTS.md`，契约同步列为待办 |

## 背景

角色资产最终确定为 **glTF 2.0 二进制（`.glb`）**，不是 VRM：文件 `CH0335.glb`（15.7 MB，glTF-Transform v4.2.1 导出），5 个网格节点、4 套 skin、10 个材质、8 张内嵌 PNG、44 段动画。契约里多处写的是"VRM / three-vrm"（§1.2、§2、§3.1、§7.3、§11），这一事实已经变化；按本轮指令先以 ADR 记录，不改契约正文。

落地时有三条硬事实无法回避：

1. **渲染进程拿不到本地文件。** 页面是 `file://`，且 `contextIsolation + sandbox`。Chromium 不支持 `fetch('file://…')`，`GLTFLoader.load()` 走 `fetch` 会直接失败；把 15.7 MB 通过 `executeJavaScript` 注入更不可接受。契约 §3.5 的模块通道里也没有"取模型字节"的语义位，不能为加载器新开通道。
2. **模型单位不是米。** 身体世界包围盒高约 `0.00926`（连同光环 `0.01088`），宽 `0.00638`。必须按包围盒自动定标，不能沿用"1 单位 = 1 px"的占位假设。
3. **场景里混有配件网格。** `CH0335_Weapon`（高到 `0.0126`、向左伸到 `-0.009`）、`CH0335_Prop_Outlline`、`brush_01`（最低到 `-0.00118`）会把包围盒撑宽、把角色挤到窗口角落。若用全场景包围盒，窗口会变成约 `979 × 720`，角色只有约 428 px 高。

## 决策

### D1 资产入口：私有 `pet-asset:` scheme（不是 §3.5 的模块通道）

1. 在 `app.ready` 之前 `protocol.registerSchemesAsPrivileged([{ scheme: 'pet-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])`；ready 之后 `protocol.handle('pet-asset', …)`。
2. **只映射两条固定路由**：`pet-asset://asset/model`、`pet-asset://asset/mouth`。不存在路径参数，因此没有目录穿越面；读不到文件返回 404。
3. 路径解析集中在 `resolveAssetConfig()`：默认 `<appRoot>/CH0335.glb` 与 `<appRoot>/Character_Mouth_Black-Due3Gpre.png`，可用 `PET_MODEL_PATH` / `PET_MOUTH_ATLAS` 覆盖（绝对路径优先，相对路径按 appRoot 解析）。
4. 该 scheme 只读本地磁盘、只服务这两个文件，**不联网**、不承载语义消息，因此不属于 §3.5 的 IPC 通道表；它替代"渲染进程直接读文件"这一不可行路径。渲染侧用 `fetch('pet-asset://asset/model')` 取 `ArrayBuffer`，再交给 `GLTFLoader.parse()`（不依赖 `FileLoader` 的 URL 解析）。

### D2 主进程侧包围盒（窗口必须先于模型创建）

1. 新增纯模块 `src/main/shell/glb-bounds.ts`：只解析 GLB 的 JSON chunk（不依赖 three、不依赖 DOM、不执行模型），按默认场景的节点 TRS 组合出世界矩阵，对各网格的 `POSITION` accessor `min/max` 求世界 AABB。
2. 结果 `{ ok, meshes: [{ name, min, max }], scene: bbox, frame: bbox, hasMorphTargets, error? }`。文件缺失、magic/版本不符、JSON 解析失败 → `ok=false`，窗口退回 §3.2 默认 `480 × 720`，并记一条 WARN。
3. 蒙皮网格按绑定姿态的节点变换取包围盒（不做蒙皮形变）；这与 three 的 `Box3.setFromObject` 同一近似，差异由自检截图兜底。

### D3 取景规则：`frame` 包围盒排除配件

1. `frameBBox` = 所有网格节点的并集，**排除**名字匹配 `PET_FRAME_EXCLUDE`（默认 `/(weapon|prop|brush|outline)/i`）的节点；若全部被排除则退回全场景并 WARN。
2. 默认值以 `CH0335` 的实测为准：只取 `CH0335_Body` + `CH0335_Halo` 时，`frame` 为 `x ∈ [-0.00319, 0.00319]`、`y ∈ [0, 0.01088]`，宽高比 `0.586`。
3. 规则是运行期可调的环境变量 + 共享正则，不写死任何具体模型名；渲染侧通过 `loadFile(..., { query: { frameExclude } })` 收到同一个正则，两侧必须一致。
4. 配件仍然**照常渲染**（不隐藏、不改材质）；只是不参与取景。

### D4 窗口尺寸：高度沿用 720，宽度按包围盒比例

1. `pixelsPerUnit = 720 / (frameHeight × 1.15)`；`width = round(frameWidth × pixelsPerUnit × 1.15)`，夹在 `[240, 960]`，越界记 WARN。这等价于"默认 `480 × 720`，按模型包围盒 × 1.15 校正"（§3.2），同时保留 15% 顶部留白。
2. 本次实测：`pixelsPerUnit ≈ 57546`，`width = 422`，即窗口 `422 × 720`；角色身体高约 533 px，头顶留白约 94 px，光环顶到 626 px。
3. 窗口仍按工作区底边居中创建（§1.2），`resizable:false`、`focusable:false` 等 §3.2 属性不变；D-7 钳制逻辑不变（窗口变窄后 80 × 120 的可见性反而更容易满足）。
4. 公式进 `src/shared/model-frame.ts`（纯函数 + 单测），主进程与渲染侧共用同一份实现。

### D5 渲染侧定标与锚点

1. 真实单位加载 → 计算同一套 `frame` 包围盒 → `modelRoot.scale = pixelsPerUnit`（渲染侧用 `contentHeight / (frameHeight × 1.15)` 独立求出，与主进程同一条公式）。
2. `modelRoot.position = (-frameCenterX × ppm, -contentHeight/2 − frameMinY × ppm, -frameCenterZ × ppm)`，即**脚底中心 = 内容区底边中心**（§3.2 锚点）。
3. 呼吸以 `modelRoot` 为锚点缩放（脚底不动）：`scaleY = ppm × (1 + 0.012·sin)`、`scaleX = ppm × (1 − 0.006·sin)`、周期 3.4 s。模型没有 blendshape，这是 §5.1 "Base 层呼吸通道"的唯一可行实现。
4. 材质统一转**无光照** `MeshBasicMaterial`（保留原 `map`/`color`/`vertexColors`/`name`），`side = DoubleSide`，`alphaTest = 0.5` 仅当贴图确实含 alpha 时启用。理由：场景没有灯光，PBR 会发黑；二次元贴图已烘焙明暗；toon 光照留待后续 ADR。

### D6 骨骼映射与降级

1. 先按 GLTFLoader 的节点名清洗规则归一化（空格→下划线、去掉保留字符），再匹配 `Bip001 Head`、`Bip001 eye_L`、`Bip001 eye_R`；`Bip001 Pelvis` 只用于自检探针点。**不要**用原始名字精确匹配——清洗后实际是 `Bip001_Head`。
2. **关键骨骼缺失 = 整体回退**：`head` / `eyeL` / `eyeR` 任一缺失 → `modelReady=false` + 占位胶囊体，并在日志列出缺失项。理由：§7.3 明确"骨骼缺失时 `modelReady=false` 并渲染占位胶囊体"，比 §11 的"缺失部位不动"更严格；本轮按更严格者执行。`Pelvis` 缺失只影响自检点位，不触发回退。
3. 模型缺失 / 解析失败 / 首帧渲染异常 → `modelReady=false`，回退**占位胶囊体**，不白屏、不抛异常（§7.3、§11）；错误只写日志。

### D7 事件与诊断边界

1. 加载成功且首帧已渲染后，由 `render` 经 `evt:broadcast` 发出 **既有** 事件 `model_ready { modelId, loadMs }`（§6.3、§7.3）。shell 只记日志并走与 `did-finish-load` 相同的**幂等**显示路径；不新增事件、不新增通道。
2. `RenderState` 字段**不变**（§7.1）；"加载状态"只体现为 `modelReady`。更多诊断（包围盒、ppm、骨骼命中、视线角度、呼吸相位、EyeMouth 材质）放在**内部** `window.petModel.getDiagnostics()`，仅供自检与同页脚本，不跨进程暴露。
3. 口型钩子（阶段 5）放在内部 `facial-texture.ts`，本轮不驱动，详见 ADR 0010。

## 替代方案

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 渲染侧 `fetch('file://…')` 直接读模型 | 零新增机制 | Chromium 不支持 `file:` 的 fetch，`GLTFLoader.load()` 必失败 | 否 |
| 新增 IPC 通道把 `ArrayBuffer` 推给渲染侧 | 不引入 scheme | 改 §3.5 通道表；15.7 MB 走 IPC 有拷贝与 4 KB 载荷习惯冲突；本轮禁止改契约 | 否 |
| 用 `webContents.executeJavaScript` 注入 base64 | 不改通道 | 15.7 MB → 约 21 MB 字符串，内存与解析都不可接受 | 否 |
| 主进程读文件后写进 `dist/` 再 `file://` 引用 | 简单 | 仍是 `file:` fetch，问题没解决；且污染构建产物 | 否 |
| 私有 `pet-asset:` scheme（本方案 D1） | 只读两条路由、无穿越面、不联网、不改 §3.5 | 多一个 scheme 注册与生命周期管理 | **是** |
| 窗口固定 480×720，模型缩放进窗口 | 零主进程解析 | 违反 §3.2 "按模型包围盒 × 1.15 校正"；不同模型留白不可控 | 否 |
| 渲染侧算包围盒后用新通道通知主进程改窗口 | 单一数据源 | 新通道 + 改契约；且窗口在模型加载前就要显示 | 否 |
| 主进程解析 GLB JSON 求包围盒（本方案 D2） | 无新通道；窗口创建前就能定尺寸；纯函数可单测 | 蒙皮形变不参与、需要自己写矩阵组合 | **是** |
| 取全场景包围盒 | 不裁剪任何配件 | 窗口被武器撑到约 979 px 宽，角色仅约 428 px 高、且偏离中心 | 否 |
| 取景排除配件、配件照常渲染（本方案 D3） | 角色占比合理、仍显示完整配件 | 极端姿态下配件可能被窗口边缘裁到 | **是** |
| 隐藏被排除的配件网格 | 画面最干净 | 擅自删除模型部件，不可逆、不可配置 | 否 |
| 用模型自带 44 段动画做待机 | 表现力最好 | 会与视线骨骼写入抢同一批骨骼，需 AnimationMixer 与遮罩；超出本轮范围 | 否（记入 MODULE_STATUS TODO） |

## 后果

**正面**

- 渲染进程不需要文件系统权限，模型加载路径与 Electron 安全模型一致（sandbox + contextIsolation 不变）。
- 窗口尺寸与角色占比在模型加载前就能确定，避免"先显示 480×720 再跳尺寸"的闪烁。
- 包围盒、ppm、取景排除规则都成为可单测的纯函数；换模型只需换文件/调 `PET_FRAME_EXCLUDE`。
- 失败路径只有一条：`modelReady=false` + 胶囊体，与 §7.3/§11 一致。

**负面 / 成本**

- 契约正文里的"VRM / three-vrm"表述已过时，需要一次契约升版（本轮按指令不改，列入 MODULE_STATUS 跨模块阻塞）。
- `frame` 取景规则依赖网格命名（`weapon|prop|brush|outline`），换模型可能需要调整环境变量；这是有意的、可配置的取舍。
- 主进程多一次约 1.4 MB JSON 的同步解析（约几十毫秒，冷启动一次）；不引入 three 到主进程。
- 蒙皮形变不参与包围盒：极端 bind pose 下窗口比例可能偏差，用截图验收兜底。
- 配件被窗口边缘裁切时无自动补偿（只做取景，不做逐帧重排）。

**约束**

- 不得把模型字节通过 `executeJavaScript` 或 IPC 大载荷传输；只能用 `pet-asset:` 只读路由。
- 不得在渲染侧直接读文件系统；不得关闭 `sandbox`/`contextIsolation`/`webSecurity`。
- `pet-asset:` 只允许两条路由，不得接受任意路径参数（目录穿越面必须为零）。
- 取景正则必须两侧一致（主进程与渲染侧共用 `src/shared/model-frame.ts` 的默认值与匹配函数）。
- 不得为了适配某个模型在代码里写死网格名/骨骼名；骨骼名缺失必须降级而不是抛错。
- 窗口尺寸公式只能有一份实现（`src/shared/model-frame.ts`）；主进程与渲染侧禁止各写一份。
- 不得在本轮引入 `three-vrm`、Draco/KTX2 解码器或任何新的运行时依赖。
