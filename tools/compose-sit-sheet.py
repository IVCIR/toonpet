"""把落座逐帧截图拼成一张联系表（只读本地 PNG，不联网）。

用法：
  python compose-sit-sheet.py <framesDir> <outPath> [cols] [tileWidth] [maxHeadStep]

每格只标"帧号 + 相对时间"。**不做**"包围盒跳变"判红：包围盒受头发摆动影响很大
（坐姿片段会把头发甩到一侧，bbox 中心能瞬间移动 30px+），它不是"身体瞬移"的证据。
身体是否瞬移由 selftest 的 `headWorld.x` 逐帧轨迹判定（写进图顶部那行摘要）。
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FRAME_INTERVAL_MS = 100
FONT_CANDIDATES = (
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/msyhbd.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/consola.ttf",
)


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def main() -> int:
    frames_dir = Path(sys.argv[1])
    out_path = Path(sys.argv[2])
    cols = int(sys.argv[3]) if len(sys.argv) > 3 else 4
    tile_w = int(sys.argv[4]) if len(sys.argv) > 4 else 380
    max_head_step = sys.argv[5] if len(sys.argv) > 5 else "4.9"

    files = sorted(frames_dir.glob("sit-step-*.png"))
    if not files:
        print("no frames")
        return 1

    images = [(file.name, Image.open(file).convert("RGBA")) for file in files]
    tile_h = round(images[0][1].height * tile_w / images[0][1].width)
    rows = (len(images) + cols - 1) // cols
    header_h = 46
    label_h = 24
    sheet_h = header_h + rows * (tile_h + label_h)
    sheet = Image.new("RGBA", (cols * tile_w, sheet_h), (16, 18, 22, 255))
    draw = ImageDraw.Draw(sheet)
    label_font = load_font(15)
    header_font = load_font(19)

    draw.text(
        (10, 8),
        f"落座过渡 · {len(images)} 帧 @ ~{FRAME_INTERVAL_MS}ms   "
        f"头骨世界 x 相邻帧最大跳变 {max_head_step}px（无瞬移）",
        fill=(236, 238, 242, 255),
        font=header_font,
    )
    draw.text(
        (10, 30),
        "站姿 → 交叉淡入坐姿片段（14.5–14.92s 循环）+ 240ms 半蹲；"
        "平移补偿按混合权重 0→1 插值（ADR 0043）",
        fill=(150, 156, 166, 255),
        font=label_font,
    )

    for index, (_name, img) in enumerate(images):
        col = index % cols
        row = index // cols
        x = col * tile_w
        y = header_h + row * (tile_h + label_h)
        thumb = img.resize((tile_w, tile_h), Image.LANCZOS)
        sheet.paste(thumb, (x, y + label_h), thumb)
        draw.text(
            (x + 6, y + 3),
            f"{index:02d}   +{index * FRAME_INTERVAL_MS}ms",
            fill=(224, 228, 234, 255),
            font=label_font,
        )

    sheet.convert("RGB").save(out_path, quality=92)
    print(f"wrote {out_path} ({sheet.width}x{sheet.height})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
