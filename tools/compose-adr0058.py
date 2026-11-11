"""ADR 0058 的取证合成：把 swing:shot / scale:shot 的帧拼成 GIF 与对照图。

    python tools/compose-adr0058.py

产物（logs/evidence/）：
    swing-100.gif        1.0x 下拖拽摇晃的逐帧动画（"录屏"）
    swing-130.gif        1.3x（实际 1.26x）同上
    swing-strip.png      两个倍率各挑 4 帧拼一条（静止 → 左摆 → 右摆 → 回摆）
    swing-margins.png    同一帧标出"她到窗口四边的距离"，证明没有被切
"""

from __future__ import annotations

import json
import pathlib

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "logs" / "evidence"
SWING_DIR = EVIDENCE / "swing"
SCALE_DIR = EVIDENCE / "scale-sweep"

BG = (250, 249, 247, 255)
INK = (60, 60, 66, 255)
ACCENT = (208, 72, 96, 255)
MUTED = (150, 150, 158, 255)


def load(path: pathlib.Path) -> Image.Image:
    image = Image.open(path).convert("RGBA")
    canvas = Image.new("RGBA", image.size, BG)
    canvas.alpha_composite(image)
    return canvas


def frames(scale_tag: str) -> list[pathlib.Path]:
    return sorted(SWING_DIR.glob(f"frame-{scale_tag}-*.png"))


def make_gif(paths: list[pathlib.Path], out: pathlib.Path, duration: int = 90) -> None:
    images = [load(path).convert("P", palette=Image.ADAPTIVE, colors=64) for path in paths]
    images[0].save(
        out,
        save_all=True,
        append_images=images[1:],
        duration=duration,
        loop=0,
        optimize=True,
        disposal=2,
    )
    print(f"gif  {out.relative_to(ROOT)}  {len(images)} frames  {out.stat().st_size // 1024} KB")


def fit_height(image: Image.Image, height: int) -> Image.Image:
    width = round(image.width * height / image.height)
    return image.resize((width, height), Image.LANCZOS)


def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """中文字体：Windows 自带雅黑；退化到黑体，再退化到内置位图字体。"""
    for name in ("msyh.ttc", "msyhbd.ttc", "simhei.ttf", "simsun.ttc"):
        path = pathlib.Path("C:/Windows/Fonts") / name
        if path.exists():
            try:
                return ImageFont.truetype(str(path), size)
            except OSError:
                continue
    return ImageFont.load_default(size=size)


def label(draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, fill=INK, size=26) -> None:
    draw.text(xy, text, fill=fill, font=_font(size))


def make_strip() -> None:
    """两倍率 × 四帧：一眼看出"摆动到两端时头发还在画框里"。"""
    picks = []
    for tag, caption in (("10", "1.0x"), ("13", "1.26x（面板 1.3x，受屏幕工作区限制）")):
        paths = frames(tag)
        if len(paths) < 4:
            continue
        idx = [0, len(paths) // 3, (2 * len(paths)) // 3, len(paths) - 1]
        picks.append((caption, [paths[i] for i in idx]))
    if not picks:
        print("strip  跳过（没有帧）")
        return

    cell_h = 900
    pad = 24
    rows = []
    for caption, paths in picks:
        images = [fit_height(load(p), cell_h) for p in paths]
        rows.append((caption, images))
    row_w = [sum(i.width for i in images) + pad * (len(images) + 1) for _, images in rows]
    width = max(row_w)
    height = sum(cell_h + 90 for _ in rows) + pad
    canvas = Image.new("RGBA", (width, height), BG)
    draw = ImageDraw.Draw(canvas)
    y = pad
    for caption, images in rows:
        label(draw, (pad, y), f"拖拽摇晃 {caption}", ACCENT, 34)
        x = pad
        for image in images:
            canvas.alpha_composite(image, (x, y + 54))
            draw.rectangle([x, y + 54, x + image.width - 1, y + 54 + image.height - 1], outline=(224, 222, 218, 255))
            x += image.width + pad
        y += cell_h + 90
    out = EVIDENCE / "swing-strip.png"
    canvas.convert("RGB").save(out, quality=92)
    print(f"strip {out.relative_to(ROOT)}  {canvas.width}x{canvas.height}")


def make_margins() -> None:
    """挑 1.0x 里**离边最近**的那一帧（最危险的一帧），把到四边的距离画出来。"""
    paths = frames("10")
    if not paths:
        print("margins 跳过（没有帧）")
        return
    best = None
    for path in paths:
        image = Image.open(path).convert("RGBA")
        bbox = image.split()[3].getbbox()
        if bbox is None:
            continue
        margins = [
            bbox[0],
            image.width - 1 - bbox[2],
            bbox[1],
            image.height - 1 - bbox[3],
        ]
        score = min(margins)
        if best is None or score < best[0]:
            best = (score, path, bbox, image, margins)
    if best is None:
        print("margins 跳过（全透明）")
        return
    _, path, bbox, rgba, margins = best
    base = Image.new("RGBA", rgba.size, BG)
    base.alpha_composite(rgba)
    draw = ImageDraw.Draw(base)
    scale = 2  # 截图是 2x DPI
    # 顶部先铺一条底色带，避免标注与"上 xx px"打架
    draw.rectangle([0, 0, rgba.width - 1, 104], fill=BG)
    draw.rectangle([bbox[0], bbox[1], bbox[2] - 1, bbox[3] - 1], outline=ACCENT, width=3)
    for text, xy in (
        (f"左 {margins[0] // scale}px", (10, max(112, bbox[1]))),
        (f"右 {margins[1] // scale}px", (rgba.width - 170, max(112, bbox[1]))),
        (f"上 {margins[2] // scale}px", (rgba.width // 2 - 60, 112)),
        (f"下 {margins[3] // scale}px", (max(10, bbox[0]), rgba.height - 52)),
    ):
        label(draw, xy, text, INK, 30)
    label(draw, (24, 14), "1.0x 拖拽摇晃：最贴近边缘的一帧", ACCENT, 32)
    label(
        draw,
        (24, 58),
        f"上留 {margins[2] // scale}px、左留 {margins[0] // scale}px、右留 {margins[1] // scale}px"
        f"、下留 {margins[3] // scale}px（CSS px，均 > 0 = 没被切）",
        MUTED,
        24,
    )
    out = EVIDENCE / "swing-margins.png"
    base.convert("RGB").save(out, quality=92)
    print(
        f"margin {out.relative_to(ROOT)}  frame={path.name} "
        f"左{margins[0] // scale} 右{margins[1] // scale} 上{margins[2] // scale} 下{margins[3] // scale}"
    )


def scale_report() -> None:
    path = EVIDENCE / "scale-sweep.json"
    if not path.exists():
        return
    report = json.loads(path.read_text(encoding="utf-8"))
    print("scale 基准内容区", report.get("base"), "工作区", report.get("workArea"))


if __name__ == "__main__":
    for tag, name in (("10", "swing-100.gif"), ("13", "swing-130.gif")):
        paths = frames(tag)
        if paths:
            make_gif(paths, EVIDENCE / name)
    make_strip()
    make_margins()
    scale_report()
