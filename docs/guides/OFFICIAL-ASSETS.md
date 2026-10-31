# 官方表情图集（运行时资产）

由 `tools/spine-expression-atlas.py` 从游戏资产生成，**不入库**（契约 C-4：视觉资产外部提供）。
本目录只保留生成说明；`.gitignore` 已忽略 `data/expression/`。

## 来源

用 [Blue-Archive-Asset-Downloader](https://github.com/ZM-Kimu/Blue-Archive-Asset-Downloader) v3.0.0
从**国服（cn）**拉取 `CH0335`（天童凯伊）相关 bundle：

```powershell
# 环境：.NET 10 SDK（net10.0 工具链）、uv、git submodule 全量
uv sync --no-dev --allow-insecure-host pypi.org --allow-insecure-host files.pythonhosted.org
uv run --no-dev ba-downloader assets sync --region cn --workspace D:\BAAD\ws `
  --resources bundle --filter "path~ch0335" --concurrency 16
```

产物在 `<workspace>/cn/android/extracted/bundles/Assets`（本次 54 个 bundle → 286 个文件）。

表情图集的原始文件：

```
_MX/SpineCharacters/CH0335_spr/CH0335_spr.png         1024×1024 Spine 图集页
_MX/SpineCharacters/CH0335_spr/CH0335_spr.atlas.bytes  区域表（bounds/offsets/rotate）
```

## 生成

```powershell
python tools/spine-expression-atlas.py `
  --atlas "<extracted>/_MX/SpineCharacters/CH0335_spr/CH0335_spr.atlas.bytes" `
  --png   "<extracted>/_MX/SpineCharacters/CH0335_spr/CH0335_spr.png" `
  --out   "data/expression"
```

输出：

| 文件 | 说明 |
|---|---|
| `expressions.png` | 6×6 网格，每格 157×149，35 个表情 |
| `manifest.json` | 名字 → `col`/`row`，运行时用 `offset`/`repeat` 取格 |
| `_alignment_check.png` | 35 个表情按同一锚点叠加的检查图（眼睛应重合） |

## 对齐规则

每个表情按**虹膜质心**（品红像素）对齐；没有虹膜的（`00_eyeclose` 等）退回深色睫毛质心。
不用 atlas 的 `offsets`：未裁边精灵尺寸每个表情都不同（265×148 / 265×161 …），原点不统一，
实测质心横纵漂移 20/25px；按包围盒顶部对齐仍有 ~10px 纵向漂移。按虹膜对齐后眼睛完全重合。

## 表情清单

`00_default`、`00_eyeclose`、`01_normal`、`02_respond`、`03_smile`、`04_embarassed`、
`05_serious`、`06_depressed`、`07`–`33`（编号差分，含腮红/泪/青筋/各种嘴型）。

## 注意

- 这是 **2D Spine 战斗立绘**的表情，不是 3D 模型的；3D 模型（`CH0335.glb`）自带的脸只有一套表情。
- 图集页在游戏里是 2048²，导出时被 Unity 压到 1024²，所以单格约 123×64 px——够 422px 窗口用，但放大到 2 倍以上会糊。
