"""把"坐姿活体微动"逐帧截图拼成联系表，并做一张"睁眼/闭眼"对照图。

用法：
  python compose-sit-alive.py <framesDir> <outAlive> <openPng> <blinkPng> <outBlinkCompare>

只读本地 PNG，不联网。
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT_CANDIDATES = (
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/msyhbd.ttc",
    "C:/Windows/Fonts/simhei.ttf",
)


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def sheet(frames: list[Path], out: Path, cols: int, tile_w: int, title: str, subtitle: str) -> None:
    images = [(p.name, Image.open(p).convert("RGBA")) for p in frames]
    tile_h = round(images[0][1].height * tile_w / images[0][1].width)
    rows = (len(images) + cols - 1) // cols
    header_h = 46
    label_h = 24
    canvas = Image.new("RGBA", (cols * tile_w, header_h + rows * (tile_h + label_h)), (16, 18, 22, 255))
    draw = ImageDraw.Draw(canvas)
    draw.text((10, 8), title, fill=(236, 238, 242, 255), font=load_font(19))
    draw.text((10, 30), subtitle, fill=(150, 156, 166, 255), font=load_font(15))
    label_font = load_font(15)
    for index, (name, img) in enumerate(images):
        col = index % cols
        row = index // cols
        x = col * tile_w
        y = header_h + row * (tile_h + label_h)
        thumb = img.resize((tile_w, tile_h), Image.LANCZOS)
        canvas.paste(thumb, (x, y + label_h), thumb)
        draw.text((x + 6, y + 3), f"{index:02d}  {name}", fill=(224, 228, 234, 255), font=label_font)
    canvas.convert("RGB").save(out, quality=92)
    print(f"wrote {out} ({canvas.width}x{canvas.height})")


def blink_compare(open_png: Path, blink_png: Path, out: Path) -> None:
    # 眼部特写（设备像素）：与 measure-blink.py 同一块 ROI
    box = (280, 760, 640, 920)
    left = Image.open(open_png).convert("RGB").crop(box).resize((720, 320), Image.LANCZOS)
    right = Image.open(blink_png).convert("RGB").crop(box).resize((720, 320), Image.LANCZOS)
    canvas = Image.new("RGB", (1480, 372), (16, 18, 22))
    draw = ImageDraw.Draw(canvas)
    font = load_font(20)
    canvas.paste(left, (10, 42))
    canvas.paste(right, (750, 42))
    draw.text((10, 10), "睁眼（基线）", fill=(236, 238, 242), font=font)
    draw.text((750, 10), "闭眼（forceBlink 钉住包络）", fill=(236, 238, 242), font=font)
    canvas.save(out, quality=92)
    print(f"wrote {out} ({canvas.width}x{canvas.height})")


def main() -> int:
    frames_dir = Path(sys.argv[1])
    out_alive = Path(sys.argv[2])
    open_png = Path(sys.argv[3])
    blink_png = Path(sys.argv[4])
    out_compare = Path(sys.argv[5])

    frames = sorted(frames_dir.glob("sit-alive-*.png"))
    if not frames:
        print("no alive frames")
        return 1
    sheet(
        frames,
        out_alive,
        3,
        380,
        "坐姿活体微动 · 6 帧 / 约 1.2s",
        "呼吸（±0.9px / 3.6s）+ 自主张望（±0.3 / ±0.15rad，3–6s 换向）+ 悬空晃腿（±0.08rad，左右反相）",
    )
    blink_compare(open_png, blink_png, out_compare)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
