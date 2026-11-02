"""只读诊断（第二轮）：按骨骼分部位统计 CH0335_Body 贴图采样颜色。

目的：判断"手部 UV 落在贴图的哪块颜色上"，以及这块颜色是否与脖子/腿等
裸露皮肤共用同一块（即：它到底是不是肤色）。
"""
from __future__ import annotations

import io
import json
import re
import struct
import sys
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
GLB = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "CH0335.glb"
OUT = ROOT / "dist" / "diagnostics"
OUT.mkdir(parents=True, exist_ok=True)

raw = GLB.read_bytes()
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

COMP = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2), 5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def read_accessor(idx: int) -> np.ndarray:
    acc = gltf["accessors"][idx]
    n = NCOMP[acc["type"]]
    fmt, size = COMP[acc["componentType"]]
    bv = gltf["bufferViews"][acc["bufferView"]]
    base = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = bv.get("byteStride") or (n * size)
    return np.array(
        [struct.unpack_from("<" + fmt * n, bin_chunk, base + i * stride) for i in range(acc["count"])],
        dtype=np.float64,
    )


def image_bytes(index: int) -> bytes:
    bv = gltf["bufferViews"][gltf["images"][index]["bufferView"]]
    start = bv.get("byteOffset", 0)
    return bin_chunk[start : start + bv["byteLength"]]


body = next(m for m in gltf["meshes"] if m["name"] == "CH0335_Body")
prim = next(p for p in body["primitives"] if gltf["materials"][p["material"]]["name"] == "CH0335_Body")
pos = read_accessor(prim["attributes"]["POSITION"])
uv = read_accessor(prim["attributes"]["TEXCOORD_0"])
joints = read_accessor(prim["attributes"]["JOINTS_0"]).astype(int)
weights = read_accessor(prim["attributes"]["WEIGHTS_0"])
index = read_accessor(prim["indices"]).astype(int).reshape(-1)

skin = gltf["skins"][0]
names = [gltf["nodes"][j].get("name", f"node{j}") for j in skin["joints"]]
dom = np.array([names[int(joints[i, weights[i].argmax()])] for i in range(len(joints))])

mat = gltf["materials"][prim["material"]]
tex_index = mat["pbrMetallicRoughness"]["baseColorTexture"]["index"]
img_index = gltf["textures"][tex_index]["source"]
img = Image.open(io.BytesIO(image_bytes(img_index))).convert("RGB")
W, H = img.size
arr = np.asarray(img).astype(np.int32)
print(f"texture image[{img_index}] {gltf['images'][img_index]['name']} {img.size}")

# 分部位：按 dominating bone 名归类
def group_of(name: str) -> str:
    n = name.lower()
    if re.search(r"\bhand\b", n): return "hand"
    if "forearm" in n: return "forearm"
    if "upperarm" in n: return "upperarm"
    if "clavicle" in n: return "clavicle"
    if re.search(r"\bhead\b", n) or "neck" in n: return "neck/head"
    if "spine" in n: return "spine"
    if "pelvis" in n: return "pelvis"
    if "thigh" in n: return "thigh"
    if "calf" in n: return "calf"
    if "foot" in n or "toe" in n: return "foot"
    if "hair" in n: return "hair"
    return "other"


groups = np.array([group_of(n) for n in dom])

# 每个 texel 的颜色（flat 色块），统计顶点采样
def texel(u, v):
    x = np.clip((u % 1) * (W - 1), 0, W - 1).round().astype(int)
    y = np.clip((1 - (v % 1)) * (H - 1), 0, H - 1).round().astype(int)
    return arr[y, x]

print("\n## 分部位：顶点数 / UV 范围 / 贴图采样（每顶点最近邻） / 主色（5bit）")
rows = {}
for g in sorted(set(groups)):
    m = groups == g
    if not m.any():
        continue
    cols = texel(uv[m, 0], uv[m, 1])
    q = (cols // 8)
    keys = q[:, 0] * 1024 + q[:, 1] * 32 + q[:, 2]
    top = Counter(keys.tolist()).most_common(3)
    top_cols = []
    for key, cnt in top:
        sel = keys == key
        top_cols.append(f"{cnt}px#({int(cols[sel].mean(axis=0)[0])},{int(cols[sel].mean(axis=0)[1])},{int(cols[sel].mean(axis=0)[2])})")
    rows[g] = {
        "n": int(m.sum()),
        "uv": [round(float(uv[m, 0].min()), 4), round(float(uv[m, 1].min()), 4),
               round(float(uv[m, 0].max()), 4), round(float(uv[m, 1].max()), 4)],
        "top": top_cols,
        "uniqueColors": int(len({tuple(c) for c in cols})),
    }
    print(f"  {g:10s} n={m.sum():5d} uv=[{uv[m,0].min():.3f},{uv[m,1].min():.3f}]..[{uv[m,0].max():.3f},{uv[m,1].max():.3f}] "
          f"colors={rows[g]['uniqueColors']:4d} top={', '.join(top_cols)}")

# 手部三角形做面积采样（真正决定屏幕颜色）：对每个包含手部顶点的三角形，
# 在 UV 空间取重心与三个中点，看看是不是同一块颜色。
tri = index.reshape(-1, 3)
hand_vert = set(np.nonzero(groups == "hand")[0].tolist())
samples = []
for a, b, c in tri:
    if not (a in hand_vert or b in hand_vert or c in hand_vert):
        continue
    for bary in ((1 / 3, 1 / 3, 1 / 3), (0.5, 0.5, 0.0), (0.0, 0.5, 0.5), (0.5, 0.0, 0.5)):
        u = bary[0] * uv[a, 0] + bary[1] * uv[b, 0] + bary[2] * uv[c, 0]
        v = bary[0] * uv[a, 1] + bary[1] * uv[b, 1] + bary[2] * uv[c, 1]
        samples.append(texel(np.array([u]), np.array([v]))[0])
samples = np.array(samples)
print(f"\n## 手部三角形 UV 面积采样 n={len(samples)}")
uniq = Counter(map(tuple, samples.tolist()))
print(f"  不同颜色数={len(uniq)}  前 5：")
for col, cnt in uniq.most_common(5):
    print(f"    {cnt:5d}  ({col[0]},{col[1]},{col[2]})  #%02X%02X%02X" % col)
print(f"  均值=({samples[:,0].mean():.1f},{samples[:,1].mean():.1f},{samples[:,2].mean():.1f})")

# 皮肤色块判定：找所有"接近 (241,237,236)"的连通区域，量它还被哪些部位使用
target = np.array([241, 237, 236])
dist = np.abs(arr - target).sum(axis=2)
skin_mask = dist <= 6
print(f"\n## 与手部同色（±6）的 texel：{int(skin_mask.sum())} / {W*H}")
ys, xs = np.nonzero(skin_mask)
if len(xs):
    print(f"  包围盒 x=[{xs.min()},{xs.max()}] y=[{ys.min()},{ys.max()}]")
# 部位→是否采样到该色块
for g in sorted(set(groups)):
    m = groups == g
    if not m.any():
        continue
    cols = texel(uv[m, 0], uv[m, 1])
    hit = (np.abs(cols - target).sum(axis=1) <= 6).mean()
    if hit > 0:
        print(f"  {g:10s} 采样到该色块的比例 {hit*100:5.1f}%")

(OUT / "body-part-colors.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
print("\n-> dist/diagnostics/body-part-colors.json")
