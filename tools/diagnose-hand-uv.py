"""只读诊断：把 CH0335_Body 网格里"由手/小臂骨骼主导"的顶点挑出来，量它们在
CH0335_Body 贴图上的 UV 区域到底是什么颜色。用于定位"手部发白"。

不联网、不改文件，只写 dist/diagnostics/ 下的证据图。
"""
from __future__ import annotations

import io
import json
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
GLB = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "CH0335.glb"
OUT = ROOT / "dist" / "diagnostics"
OUT.mkdir(parents=True, exist_ok=True)

raw = GLB.read_bytes()
magic, version, total = struct.unpack_from("<III", raw, 0)
assert magic == 0x46546C67, "not glb"
off = 12
gltf = None
bin_chunk = None
while off + 8 <= len(raw):
    clen, ctype = struct.unpack_from("<II", raw, off)
    data = raw[off + 8 : off + 8 + clen]
    if ctype == 0x4E4F534A:
        gltf = json.loads(data.decode("utf-8"))
    elif ctype == 0x004E4942:
        bin_chunk = data
    off += 8 + clen
assert gltf and bin_chunk is not None

COMP = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2), 5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def read_accessor(idx: int) -> np.ndarray:
    acc = gltf["accessors"][idx]
    n = NCOMP[acc["type"]]
    fmt, size = COMP[acc["componentType"]]
    count = acc["count"]
    bv = gltf["bufferViews"][acc["bufferView"]]
    base = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = bv.get("byteStride") or (n * size)
    out = np.empty((count, n), dtype=np.float64)
    for i in range(count):
        vals = struct.unpack_from("<" + fmt * n, bin_chunk, base + i * stride)
        out[i] = vals
    return out


def image_bytes(image_index: int) -> bytes:
    img = gltf["images"][image_index]
    bv = gltf["bufferViews"][img["bufferView"]]
    start = bv.get("byteOffset", 0)
    return bin_chunk[start : start + bv["byteLength"]]


# 找到使用 CH0335_Body 材质的 primitive
body_mesh = next(m for m in gltf["meshes"] if m["name"] == "CH0335_Body")
prim_index = next(
    i for i, p in enumerate(body_mesh["primitives"])
    if gltf["materials"][p["material"]]["name"] == "CH0335_Body"
)
prim = body_mesh["primitives"][prim_index]
print(f"body primitive index={prim_index} material={gltf['materials'][prim['material']]['name']}")

pos = read_accessor(prim["attributes"]["POSITION"])
uv = read_accessor(prim["attributes"]["TEXCOORD_0"])
joints = read_accessor(prim["attributes"]["JOINTS_0"]).astype(int)
weights = read_accessor(prim["attributes"]["WEIGHTS_0"])
colors = read_accessor(prim["attributes"]["COLOR_0"]) if "COLOR_0" in prim["attributes"] else None
index = read_accessor(prim["indices"]).astype(int).reshape(-1)

skin = gltf["skins"][0]
joint_names = [gltf["nodes"][j].get("name", f"node{j}") for j in skin["joints"]]

# 顶点主导骨
dominant = joints[np.arange(len(joints)), weights.argmax(axis=1)]
dom_names = np.array([joint_names[int(d)] for d in dominant])

groups = {
    "hand": r"[LR] Hand\b",
    "forearm": r"[LR] Forearm\b",
    "upperarm": r"[LR] UpperArm\b",
    "clavicle": r"[LR] Clavicle\b",
}
import re

masks = {k: np.array([bool(re.search(p, n)) for n in dom_names]) for k, p in groups.items()}
masks["other"] = ~(masks["hand"] | masks["forearm"] | masks["upperarm"] | masks["clavicle"])

print("\n## 主导骨顶点数")
for k, m in masks.items():
    print(f"  {k:9s} {int(m.sum()):5d}")

body_mat = gltf["materials"][prim["material"]]
tex_ref = body_mat["pbrMetallicRoughness"]["baseColorTexture"]["index"]
tex_img = Image.open(io.BytesIO(image_bytes(gltf["textures"][tex_ref]["source"]))).convert("RGB")
print(f"\n## CH0335_Body 贴图 index={tex_ref} -> image #{gltf['textures'][tex_ref]['source']} {tex_img.size} mode=RGB")
arr = np.asarray(tex_img).astype(np.float64)
H, W, _ = arr.shape


def sample(u: np.ndarray, v: np.ndarray) -> np.ndarray:
    x = np.clip((u % 1.0) * (W - 1), 0, W - 1).round().astype(int)
    y = np.clip((1.0 - (v % 1.0)) * (H - 1), 0, H - 1).round().astype(int)
    return arr[y, x]


print("\n## 各分组：UV 包围盒 + 贴图采样颜色（逐顶点最近邻）")
summary = {}
for k, m in masks.items():
    if m.sum() == 0:
        continue
    u, v = uv[m, 0], uv[m, 1]
    cols = sample(u, v)
    mean = cols.mean(axis=0)
    whiteish = ((cols > 245).all(axis=1)).mean()
    summary[k] = {
        "count": int(m.sum()),
        "uv": [float(u.min()), float(v.min()), float(u.max()), float(v.max())],
        "mean": [round(float(c), 1) for c in mean],
        "whitePct": round(float(whiteish) * 100, 2),
        "uvUniq": int(len(np.unique(np.round(np.stack([u, v], axis=1), 5), axis=0))),
    }
    print(f"  {k:9s} n={int(m.sum()):5d} uv=[{u.min():.4f},{v.min():.4f}]..[{u.max():.4f},{v.max():.4f}] "
          f"meanRGB=({mean[0]:.1f},{mean[1]:.1f},{mean[2]:.1f}) white%={whiteish*100:.1f} uvUniq={summary[k]['uvUniq']}")

if colors is not None:
    print("\n## COLOR_0（顶点色）")
    for k, m in masks.items():
        if m.sum() == 0:
            continue
        c = colors[m]
        print(f"  {k:9s} mean=({c[:,0].mean():.3f},{c[:,1].mean():.3f},{c[:,2].mean():.3f}) "
              f"min=({c[:,0].min():.3f},{c[:,1].min():.3f},{c[:,2].min():.3f}) max=({c[:,0].max():.3f},{c[:,1].max():.3f},{c[:,2].max():.3f})")

# 手部 UV 区域截图（外扩 2%）
if masks["hand"].sum():
    u, v = uv[masks["hand"], 0], uv[masks["hand"], 1]
    pad = 0.02
    x0, x1 = max(0, int((u.min() - pad) * W)), min(W, int((u.max() + pad) * W) + 1)
    # v 轴：glTF UV 原点在左下，图片原点在左上
    y0 = max(0, int((1 - (v.max() + pad)) * H))
    y1 = min(H, int((1 - (v.min() - pad)) * H) + 1)
    crop = tex_img.crop((x0, y0, x1, y1))
    scale = max(1, min(8, 512 // max(1, crop.width)))
    crop.resize((crop.width * scale, crop.height * scale), Image.NEAREST).save(OUT / "body-hand-uv-region.png")
    print(f"\n手部 UV 区域裁剪 -> dist/diagnostics/body-hand-uv-region.png  ({x0},{y0})-({x1},{y1}) x{scale}")

# 手部三角形高亮叠加到整张贴图上
overlay = tex_img.copy()
draw = ImageDraw.Draw(overlay)
tri = index.reshape(-1, 3)
hand_set = set(np.nonzero(masks["hand"])[0].tolist())
drawn = 0
for a, b, c in tri:
    if not (a in hand_set or b in hand_set or c in hand_set):
        continue
    pts = []
    for i in (a, b, c):
        pts.append(((uv[i, 0] % 1.0) * W, (1.0 - (uv[i, 1] % 1.0)) * H))
    draw.polygon(pts, outline=(255, 0, 0), fill=(255, 0, 0, 90) if False else None)
    drawn += 1
print(f"手部三角形 {drawn} 个（红框标出）")
blend = Image.blend(tex_img.convert("RGBA"), overlay.convert("RGBA"), 1.0)
blend.save(OUT / "body-texture-hand-overlay.png")
print("手部三角形高亮 -> dist/diagnostics/body-texture-hand-overlay.png")

# 所有关键分组的 UV 框叠图，便于对比"手 vs 腿"
full = tex_img.copy()
d = ImageDraw.Draw(full)
palette = {"hand": (255, 0, 0), "forearm": (255, 128, 0), "upperarm": (0, 160, 255), "other": (0, 220, 0)}
for k, col in palette.items():
    m = masks[k]
    if m.sum() == 0:
        continue
    u, v = uv[m, 0], uv[m, 1]
    x0, x1 = (u.min() % 1) * W, (u.max() % 1) * W
    y0, y1 = (1 - (v.max() % 1)) * H, (1 - (v.min() % 1)) * H
    d.rectangle([x0, y0, x1, y1], outline=col, width=3)
    d.text((x0 + 4, y0 + 4), k, fill=col)
full.save(OUT / "body-texture-uv-boxes.png")
print("分组 UV 框 -> dist/diagnostics/body-texture-uv-boxes.png")

# 贴图整体主色（众数）对照
from collections import Counter

q = (arr.reshape(-1, 3) // 8).astype(int)
keys = q[:, 0] * 32 * 32 + q[:, 1] * 32 + q[:, 2]
top = Counter(keys.tolist()).most_common(5)
print("\n## CH0335_Body 整张贴图主要颜色（5bit 量化，前 5）")
for key, cnt in top:
    sel = keys == key
    print(f"  {cnt:7d}px mean=({arr.reshape(-1,3)[sel].mean(axis=0)[0]:.0f},"
          f"{arr.reshape(-1,3)[sel].mean(axis=0)[1]:.0f},{arr.reshape(-1,3)[sel].mean(axis=0)[2]:.0f})")

(OUT / "hand-uv-diagnosis.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
print("\n汇总 -> dist/diagnostics/hand-uv-diagnosis.json")
