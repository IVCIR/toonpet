"""
把《蔚蓝档案》Spine 表情图集重打包成"按帧对齐"的运行时图集。

输入（Blue-Archive-Asset-Downloader 的产出）：
  <extracted>/_MX/SpineCharacters/CH0335_spr/CH0335_spr.atlas.bytes
  <extracted>/_MX/SpineCharacters/CH0335_spr/CH0335_spr.png

输出：
  <out>/expressions.png     —— 每格一个表情，全部按 offsets 对齐到同一原点
  <out>/manifest.json       —— 名字 → 列/行/UV，运行时只做 offset/repeat，不重采样

为什么重打包而不是直接用原图：
  1. 原图集里约一半区域带 `rotate:90`，UV 的 offset/repeat 表达不了旋转；
  2. 原图集 2048 声明 / 1024 实际，坐标要换算；
  3. 重打包后所有表情共用同一原点（按 atlas 的 offsets 对齐），换表情不会整体位移。

用法：
  python tools/spine-expression-atlas.py --atlas <...atlas.bytes> --png <...png> --out data/expression
"""
from __future__ import annotations

import argparse
import json
import os
import re
from dataclasses import dataclass

from PIL import Image, ImageDraw


@dataclass
class Region:
    name: str
    bounds: tuple[float, float, float, float]
    offsets: tuple[float, float, float, float] | None
    rotate: bool


def parse_atlas(text: str) -> list[Region]:
    regions: list[Region] = []
    name: str | None = None
    props: dict[str, str] = {}

    def flush() -> None:
        nonlocal name, props
        if name and "bounds" in props:
            bounds = tuple(float(v) for v in props["bounds"].split(","))
            offsets = None
            if "offsets" in props:
                offsets = tuple(float(v) for v in props["offsets"].split(","))
            regions.append(Region(name, bounds, offsets, props.get("rotate") == "90"))
        name, props = None, {}

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            flush()
            continue
        if ":" in line:
            key, value = line.split(":", 1)
            props[key.strip()] = value.strip()
        else:
            flush()
            name = line
    flush()
    return regions


def anchor_of(tile: Image.Image) -> tuple[float, float]:
    """表情的"眼睛锚点"：优先用虹膜（品红）质心，闭眼等没有虹膜的退回睫毛（深色）质心。

    为什么不用包围盒：不同表情上方可能多出眉毛、汗滴、青筋，包围盒顶部并不对齐；
    实测按顶部对齐仍会纵向漂移 ~10px，换表情时脸会跳。虹膜是每个表情都有的
    固定特征，用它做锚点最稳。
    """
    width, height = tile.size
    pixels = tile.load()
    iris_x = iris_y = iris_n = 0
    dark_x = dark_y = dark_n = 0
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a < 40:
                continue
            if r > 150 and b > 90 and g < 130 and r - g > 60:
                iris_x += x
                iris_y += y
                iris_n += 1
            elif r < 90 and g < 90 and b < 90:
                dark_x += x
                dark_y += y
                dark_n += 1
    if iris_n >= 20:
        return iris_x / iris_n, iris_y / iris_n
    if dark_n > 0:
        return dark_x / dark_n, dark_y / dark_n
    bbox = tile.getbbox() or (0, 0, width, height)
    return (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--atlas", required=True)
    parser.add_argument("--png", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--page", type=int, default=2048, help="atlas 里声明的页尺寸")
    parser.add_argument("--only", default="", help="只导出匹配这些前缀的区域（逗号分隔）")
    args = parser.parse_args()

    text = open(args.atlas, encoding="utf-8").read()
    declared_page = args.page
    for line in text.splitlines():
        if line.strip().startswith("size:"):
            declared_page = int(line.split(":", 1)[1].split(",")[0])
            break

    image = Image.open(args.png).convert("RGBA")
    scale = image.size[0] / float(declared_page)

    regions = parse_atlas(text)
    # 表情区域只认 `00_default` / `01_normal` … `33` 这种两位数命名的格子；
    # 身体、头发、光环、武器也带 offsets，必须靠命名排除（否则会混进图集）。
    expressions = [r for r in regions if re.match(r"^\d{2}", r.name)]

    decoded: list[tuple[Region, Image.Image]] = []
    for region in expressions:
        x, y, w, h = region.bounds
        if region.rotate:
            box = (round(x * scale), round(y * scale), round((x + h) * scale), round((y + w) * scale))
            tile = image.crop(box).rotate(-90, expand=True)
        else:
            box = (round(x * scale), round(y * scale), round((x + w) * scale), round((y + h) * scale))
            tile = image.crop(box)
        decoded.append((region, tile))

    # 统一画布：所有表情按**眼睛锚点**对齐。
    #
    # 为什么不用 atlas 的 offsets：offsets 是"裁边内容在未裁边精灵里的偏移"，
    # 而未裁边精灵的尺寸每个表情都不一样（265×148 / 265×161 …），原点并不统一，
    # 实测质心横向漂移 20px、纵向 25px；按包围盒顶部对齐也仍有 ~10px 纵向漂移
    # （有的表情头顶多了汗滴/青筋）。用虹膜质心当锚点，换表情时眼睛不动。
    anchors = [anchor_of(tile) for _, tile in decoded]
    pad = 8
    left = max(anchor[0] for anchor in anchors)
    right = max(tile.size[0] - anchor[0] for (_, tile), anchor in zip(decoded, anchors))
    up = max(anchor[1] for anchor in anchors)
    down = max(tile.size[1] - anchor[1] for (_, tile), anchor in zip(decoded, anchors))
    cell_w = int(left + right) + pad * 2
    cell_h = int(up + down) + pad * 2

    columns = 6
    rows = (len(decoded) + columns - 1) // columns
    sheet = Image.new("RGBA", (columns * cell_w, rows * cell_h), (0, 0, 0, 0))
    entries = []
    for index, (region, tile) in enumerate(decoded):
        col = index % columns
        row = index // columns
        anchor_x, anchor_y = anchors[index]
        bbox = tile.getbbox() or (0, 0, tile.size[0], tile.size[1])
        x0 = col * cell_w + pad + int(left - anchor_x)
        y0 = row * cell_h + pad + int(up - anchor_y)
        sheet.paste(tile, (x0, y0), tile)
        entries.append(
            {
                "name": region.name,
                "col": col,
                "row": row,
                "width": bbox[2] - bbox[0],
                "height": bbox[3] - bbox[1],
            }
        )

    os.makedirs(args.out, exist_ok=True)
    sheet.save(os.path.join(args.out, "expressions.png"))
    manifest = {
        "schema": 1,
        "source": "BA Spine CH0335_spr",
        "atlas": "expressions.png",
        "imageWidth": sheet.size[0],
        "imageHeight": sheet.size[1],
        "columns": columns,
        "rows": rows,
        "cellWidth": cell_w,
        "cellHeight": cell_h,
        "expressions": entries,
    }
    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)

    print(f"expressions={len(entries)} cell={cell_w}x{cell_h} sheet={sheet.size}")
    for entry in entries[:8]:
        print(" ", entry["name"], entry["col"], entry["row"], entry["width"], entry["height"])

    # 对齐检查图：所有格子按同一锚点叠在一起，眼睛应当重合
    preview = Image.new("RGB", (cell_w, cell_h), (255, 255, 255))
    for index, (_, tile) in enumerate(decoded):
        anchor_x, anchor_y = anchors[index]
        layer = Image.new("RGBA", (cell_w, cell_h), (0, 0, 0, 0))
        layer.paste(
            tile,
            (pad + int(left - anchor_x), pad + int(up - anchor_y)),
            tile,
        )
        preview = Image.alpha_composite(preview.convert("RGBA"), layer).convert("RGB")
    ImageDraw.Draw(preview).text((2, 2), f"{len(decoded)} expressions stacked", fill=(0, 0, 0))
    preview.save(os.path.join(args.out, "_alignment_check.png"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
