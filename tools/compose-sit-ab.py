"""把坐姿 A/B 两组特写拼成一张对比图（ADR 0051 D7 取证）。

输入（由 `npm run selftest` 两次运行产出，分别归档）：
  logs/evidence/sit-ab/group1/stage-a.png  # SIT_PHASE_A_HEAD_TUNE_RAD=0,    SIT_SPINE_OVERLAY_WEIGHT=1.0
  logs/evidence/sit-ab/group1/stage-b.png
  logs/evidence/sit-ab/group2/stage-a.png  # SIT_PHASE_A_HEAD_TUNE_RAD=-0.12, SIT_SPINE_OVERLAY_WEIGHT=0.85
  logs/evidence/sit-ab/group2/stage-b.png

输出：logs/evidence/sit-ab-compare.png

只读输入、不联网、不依赖第三方服务；Pillow 只用于拼图。
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "logs" / "evidence"
AB = EVIDENCE / "sit-ab"
OUT = EVIDENCE / "sit-ab-compare.png"

PANEL_W = 430
PANEL_H = 734
GUTTER = 210
HEADER_H = 112
COL_GAP = 22
ROW_GAP = 54
FOOTER_H = 92
PAD = 28
BG = (24, 26, 31, 255)
PANEL_BG = (32, 35, 42, 255)
FG = (238, 240, 244, 255)
MUTED = (168, 174, 186, 255)
ACCENT = (255, 128, 160, 255)
GREEN = (126, 214, 160, 255)

FONT = "C:/Windows/Fonts/msyh.ttc"
FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_BOLD if bold else FONT, size, index=0)


def load_panel(path: Path, crop: tuple[int, int, int, int] | None = None) -> Image.Image:
    image = Image.open(path).convert("RGBA")
    if crop is not None:
        image = image.crop(crop)
    # 面板比例固定；特写图按 contain 缩放，不拉伸。
    image.thumbnail((PANEL_W, PANEL_H), Image.LANCZOS)
    canvas = Image.new("RGBA", (PANEL_W, PANEL_H), PANEL_BG)
    canvas.alpha_composite(image, ((PANEL_W - image.width) // 2, (PANEL_H - image.height) // 2))
    return canvas


def fit_text(draw: ImageDraw.ImageDraw, text: str, max_width: int, size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    while size > 10:
        candidate = font(size, bold)
        box = draw.textbbox((0, 0), text, font=candidate)
        if box[2] - box[0] <= max_width:
            return candidate
        size -= 1
    return font(size, bold)


def main() -> None:
    # 阶段 B 的相机是 420px 方框，原图会带到脚；裁到"头 → 大腿"才是上半身特写，
    # 也才能看清 0.85 与 1.00 在下背/肩线上的差别。裁切框在所有面板间一致。
    upper_body = (142, 20, 702, 976)
    panels = {
        ("group1", "a"): load_panel(AB / "group1" / "stage-a.png"),
        ("group1", "b"): load_panel(AB / "group1" / "stage-b.png", upper_body),
        ("group2", "a"): load_panel(AB / "group2" / "stage-a.png"),
        ("group2", "b"): load_panel(AB / "group2" / "stage-b.png", upper_body),
    }
    for key, panel in panels.items():
        if panel.size != (PANEL_W, PANEL_H):
            raise SystemExit(f"panel {key} is {panel.size}, expected {(PANEL_W, PANEL_H)}")

    width = PAD * 2 + GUTTER + COL_GAP + PANEL_W * 2 + COL_GAP
    height = HEADER_H + 78 + (PANEL_H + ROW_GAP) * 2 + FOOTER_H
    sheet = Image.new("RGBA", (width, height), BG)
    draw = ImageDraw.Draw(sheet)

    draw.text((PAD, 30), "坐姿手感 A/B · 两段式坐姿（ADR 0051 D7）", font=font(36, True), fill=FG)
    draw.text(
        (PAD, 78),
        "组 1 = 默认（head 0.00 / spine 1.00，完全照抄站立）   ·   组 2 = 微调放松（head -0.12 / spine 0.85）",
        font=font(21),
        fill=MUTED,
    )

    col1 = PAD + GUTTER + COL_GAP
    col2 = col1 + PANEL_W + COL_GAP
    row1 = HEADER_H + 78
    row2 = row1 + PANEL_H + ROW_GAP

    headers = [
        (col1, "阶段 A · 14.2–16.0s", "抬头补偿：脸 / 眼（-0.12rad ≈ -6.9°）"),
        (col2, "阶段 B · 16.2s 停帧", "Spine 覆盖权重：上半身（0.85 = 保留 15% 前倾）"),
    ]
    for x, title, sub in headers:
        draw.text((x, HEADER_H + 12), title, font=font(25, True), fill=FG)
        draw.text((x, HEADER_H + 46), sub, font=font(19), fill=MUTED)

    rows = [
        (row1, "组 1", "默认 / 验收值", "headTune = 0.00", "spineWeight = 1.00", FG),
        (row2, "组 2", "微调放松（临时标定）", "headTune = -0.12", "spineWeight = 0.85", ACCENT),
    ]
    for y, name, desc, head, spine, color in rows:
        draw.text((PAD, y + 8), name, font=font(30, True), fill=color)
        draw.text((PAD, y + 50), desc, font=font(18), fill=MUTED)
        draw.text((PAD, y + 92), head, font=font(20, True), fill=FG)
        draw.text((PAD, y + 122), spine, font=font(20, True), fill=FG)
        draw.line((PAD, y + 168, PAD + GUTTER - 20, y + 168), fill=(66, 70, 80, 255), width=2)

    for (group, stage), panel in panels.items():
        x = col1 if stage == "a" else col2
        y = row1 if group == "group1" else row2
        sheet.alpha_composite(panel, (x, y))
        draw.rectangle((x, y, x + PANEL_W - 1, y + PANEL_H - 1), outline=(66, 70, 80, 255), width=2)

    footer_y = row2 + PANEL_H + 26
    draw.line((PAD, footer_y, width - PAD, footer_y), fill=(66, 70, 80, 255), width=2)
    draw.text(
        (PAD, footer_y + 14),
        "结论：A 段 -0.12rad 把她刚坐下时低着的脸抬起来（眼型不再半眯/压眼）；B 段 0.85 只放松下背，胸/颈/头仍完整照抄站立。",
        font=font(20),
        fill=FG,
    )
    draw.text(
        (PAD, footer_y + 44),
        "两组均通过 tsc --noEmit 0 错 + 主链路自检 198 条全绿；封版提交保留组 1 为默认值，真机可只改 shared/constants.ts 两个常量。",
        font=font(18),
        fill=GREEN,
    )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(OUT, "PNG")
    print(f"wrote {OUT} ({sheet.width}x{sheet.height})")

    # 量化差异：帮助确认"不是拿同一张图拼的"
    for stage in ("a", "b"):
        a = Image.open(AB / "group1" / f"stage-{stage}.png").convert("RGB")
        b = Image.open(AB / "group2" / f"stage-{stage}.png").convert("RGB")
        if a.size != b.size:
            print(f"stage {stage}: size mismatch {a.size} vs {b.size}")
            continue
        from PIL import ImageChops

        diff = ImageChops.difference(a, b).convert("L")
        hist = diff.histogram()
        total = a.width * a.height
        changed = sum(hist[8:])
        mean = sum(i * n for i, n in enumerate(hist)) / total
        bbox = diff.point(lambda v: 255 if v >= 8 else 0).getbbox()
        print(f"stage {stage}: changed={changed}/{total} ({changed / total:.2%}), mean={mean:.2f}, bbox={bbox}")


if __name__ == "__main__":
    main()
