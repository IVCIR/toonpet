"""ADR 0047 取证：把脸部特写拼成对照条（人眼一屏看完 A/B/C）。

用法：python tools/diag/face-compare.py
输出：logs/evidence/face-sit-compare.png / face-eye-bone-compare.png

对齐方式：用**虹膜像素的红色掩膜质心**给每张图找眼睛位置，再裁同样大小的框——
三张图的头在画面里本来就会因为相机跟头而移动，不对齐就没法比"瞳孔朝哪"。
只读 dist/selftest/*.png，不改素材。
"""

from __future__ import annotations

import pathlib

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / "dist" / "selftest"
OUT = ROOT / "logs" / "evidence"

BOX = 470          # 裁剪边长（像素，原图 844×1440 @2x）
# 质心落在双眼连线上，往下挪一点才框住整张脸
CENTER_Y_OFFSET = 95
SCALE = 0.86
GAP = 14
LABEL_HEIGHT = 38


def iris_center(image: Image.Image) -> tuple[int, int]:
    """虹膜是深洋红（≈#c2185b）；校服的粉色条纹更亮更绿，用 g<80 把它们排除。
    只在画面上半部分找——坐姿特写里虹膜一定在头部，负片/胸口没有同样的深红。"""
    data = np.asarray(image.convert("RGB")).astype(np.int16)
    red = data[:, :, 0]
    green = data[:, :, 1]
    blue = data[:, :, 2]
    mask = (red > 120) & (red < 235) & (green < 80) & (blue > 55) & (blue < 150) & (red - green > 90)
    mask[int(image.height * 0.45) :, :] = False
    ys, xs = np.nonzero(mask)
    if xs.size < 200:
        return image.width // 2, image.height // 3
    return int(xs.mean()), int(ys.mean())


def load(name: str) -> Image.Image:
    image = Image.open(SRC / name).convert("RGB")
    cx, cy = iris_center(image)
    cy += CENTER_Y_OFFSET
    left = max(0, min(image.width - BOX, cx - BOX // 2))
    top = max(0, min(image.height - BOX, cy - BOX // 2))
    return image.crop((left, top, left + BOX, top + BOX))


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in ("C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf"):
        if pathlib.Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def strip(entries: list[tuple[str, str]], dest: str, scale: float = SCALE) -> None:
    tiles = [load(name) for name, _ in entries]
    side = int(BOX * scale)
    sheet = Image.new(
        "RGB",
        (side * len(tiles) + GAP * (len(tiles) - 1), side + LABEL_HEIGHT),
        (24, 24, 28),
    )
    draw = ImageDraw.Draw(sheet)
    label_font = font(21)
    for index, ((_, label), tile) in enumerate(zip(entries, tiles)):
        x = index * (side + GAP)
        sheet.paste(tile.resize((side, side), Image.LANCZOS), (x, LABEL_HEIGHT))
        draw.text((x + 8, 8), label, fill=(240, 240, 240), font=label_font)
    OUT.mkdir(parents=True, exist_ok=True)
    target = OUT / dest
    sheet.save(target)
    print(f"wrote {target} ({sheet.width}x{sheet.height})")


strip(
    [
        ("face-sit-head-down.png", "A. 现方案再低 0.25rad（≈片段原姿态）"),
        ("face-sit.png", "B. 现方案：站立基准 + 0.10rad"),
        ("face-sit-head-up.png", "C. 现方案再抬 0.12rad（旧补偿的过头方向）"),
    ],
    "face-sit-compare.png",
)

strip(
    [
        ("face-idle.png", "A. 眼骨 0"),
        ("face-idle-eye-down.png", "B. 眼骨 +0.35rad（低头 20°）"),
        ("face-idle-eye-up.png", "C. 眼骨 -0.35rad（抬头 20°）"),
    ],
    "face-eye-bone-compare.png",
)

# 最有意义的一组：**站立 vs 坐姿**。站立是玩家平时看到的"正常眼神"，
# 坐姿只要跟它看起来一致，就不该再有"死鱼眼"的读感。
strip(
    [
        ("face-idle.png", "A. 站立待机（参照：正常眼神）"),
        ("face-sit.png", "B. 坐姿（现方案）"),
        ("face-sit-head-up.png", "C. 坐姿（旧补偿的过头方向）"),
    ],
    "face-idle-vs-sit.png",
)

# 头部微调扫描：找"肉眼平视"的那一档
tune_files = [
    ("face-tune-m20.png", "抬头 0.20"),
    ("face-tune-m10.png", "抬头 0.10"),
    ("face-tune-p0.png", "0（照抄站立）"),
    ("face-tune-p10.png", "低头 0.10"),
    ("face-tune-p20.png", "低头 0.20"),
]
if all((SRC / name).exists() for name, _ in tune_files):
    strip(tune_files, "face-tune-sweep.png", scale=0.74)
