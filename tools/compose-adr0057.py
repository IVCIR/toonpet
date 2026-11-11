"""
ADR 0057 的取证拼图（一次性脚本，不是生产路径）。

输入（全部来自真机截图，脚本只做排版）：
- `logs/evidence/scale-sweep/frame-*.png`            → 逐档缩放帧（`npm run scale:shot`）
- `logs/evidence/sit-ab/group1/stage-b.png`          → 修复前：坐姿停帧（眯眼，ADR 0051 组 1）
- `dist/selftest/sit-ab-stage-b.png`                 → 修复后：坐姿停帧（睁眼，ADR 0057 D3）
- `dist/selftest/window-after-sit-exit.png`          → 修复后：坐姿退场后站立
输出：
- `logs/evidence/window-scale-sweep.gif`             → 把逐档帧拼成动画（当"录屏"看）
- `logs/evidence/window-scale-strip.png`             → 0.6x / 1.0x / 最大档 三联（底边对齐）
- `logs/evidence/sit-eyes-before-after.png`          → 眯眼 vs 睁眼脸部特写对比
- `logs/evidence/sit-exit-after.png`                 → 坐姿（睁眼）vs 退场后站立

用法：`python tools/compose-adr0057.py`（需要在工程根目录执行）。
"""
import glob
import os
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVIDENCE = os.path.join(ROOT, "logs", "evidence")
SELFTEST = os.path.join(ROOT, "dist", "selftest")
# `dist/selftest` 会被下一次 `npm run build` 清空（build.mjs 会 rm -rf dist），
# 所以自检截图拷一份到 `logs/evidence/adr0057/` 再拼图；这里优先读副本。
COPIES = os.path.join(EVIDENCE, "adr0057")


def shot(name):
    """自检截图：优先读 `logs/evidence/adr0057/` 的副本，其次读 `dist/selftest/`。"""
    for base in (COPIES, SELFTEST):
        path = os.path.join(base, name)
        if os.path.exists(path):
            return path
    return os.path.join(SELFTEST, name)


FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhl.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
]


def font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def label(draw, xy, text, size=26, fill=(28, 28, 32)):
    draw.text(xy, text, font=font(size), fill=fill)


def open_or_none(path):
    return Image.open(path) if os.path.exists(path) else None


def compose_scale_gif():
    frames = sorted(glob.glob(os.path.join(EVIDENCE, "scale-sweep", "frame-*.png")))
    if not frames:
        print("[skip] 没有缩放帧（先跑 npm run scale:shot）")
        return
    images = [Image.open(path).convert("RGBA") for path in frames]
    # 逐档帧的分辨率不同（窗口在变），统一放到"最大帧"的画布上，**底边中心对齐**：
    # 这正是缩放的设计口径（脚底贴底边、左右对称生长），动画看起来就是她在长高。
    max_w = max(image.width for image in images)
    max_h = max(image.height for image in images)
    # 浅灰底 = "桌面"；窗口边界画一圈细线，能看出"是窗口在长大"而不是模型单独缩放
    background = (236, 238, 243, 255)
    gif_frames = []
    for image in images:
        canvas = Image.new("RGBA", (max_w, max_h), background)
        x = (max_w - image.width) // 2
        y = max_h - image.height
        canvas.alpha_composite(image, (x, y))
        draw = ImageDraw.Draw(canvas)
        draw.rectangle([x, y, x + image.width - 1, max_h - 1], outline=(150, 156, 168, 255), width=2)
        # 缩小一半，GIF 体积可控
        gif_frames.append(canvas.convert("RGB").resize((max_w // 2, max_h // 2), Image.LANCZOS))
    out = os.path.join(EVIDENCE, "window-scale-sweep.gif")
    gif_frames[0].save(
        out,
        save_all=True,
        append_images=gif_frames[1:],
        duration=520,
        loop=0,
        optimize=True,
    )
    print(f"[ok] {out}（{len(gif_frames)} 帧，{gif_frames[0].size[0]}×{gif_frames[0].size[1]}）")


def compose_scale_strip():
    picks = [
        ("0.60x", os.path.join(EVIDENCE, "scale-sweep", "frame-01-0.6x.png")),
        ("1.00x", os.path.join(EVIDENCE, "scale-sweep", "frame-05-1.0x.png")),
        ("1.32x（2.0x 请求，受屏幕工作区限制）", os.path.join(EVIDENCE, "scale-sweep", "frame-10-2.0x.png")),
    ]
    items = [(text, open_or_none(path)) for text, path in picks]
    items = [(text, image) for text, image in items if image is not None]
    if not items:
        print("[skip] 没有缩放帧")
        return
    # 统一缩到 CSS 像素（设备像素比 2 → 取一半），底边对齐
    scale = 0.5
    scaled = [
        (text, image.resize((int(image.width * scale), int(image.height * scale)), Image.LANCZOS))
        for text, image in items
    ]
    gap = 28
    title_h = 74
    label_h = 40
    max_h = max(image.height for _, image in scaled)
    total_w = sum(image.width for _, image in scaled) + gap * (len(scaled) + 1)
    canvas = Image.new("RGB", (total_w, max_h + title_h + label_h + gap), (246, 247, 250))
    draw = ImageDraw.Draw(canvas)
    label(draw, (gap, 18), "ADR 0057 D2：整体缩放（窗口与角色同比，脚底始终贴窗口底边）", size=30)
    x = gap
    for text, image in scaled:
        y = title_h + (max_h - image.height)
        # 浅灰"桌面"底 + 窗口边框：让"窗口本身在长大"这件事看得出来
        backdrop = Image.new("RGB", image.size, (236, 238, 243))
        backdrop.paste(image.convert("RGB"), (0, 0), image.convert("RGBA").split()[3])
        canvas.paste(backdrop, (x, y))
        draw.rectangle([x, y, x + image.width - 1, y + image.height - 1], outline=(150, 156, 168), width=2)
        label(draw, (x, title_h + max_h + 8), text, size=24, fill=(60, 64, 72))
        x += image.width + gap
    out = os.path.join(EVIDENCE, "window-scale-strip.png")
    canvas.save(out, optimize=True)
    print(f"[ok] {out}（{canvas.size[0]}×{canvas.size[1]}）")


def compose_sit_eyes():
    before = open_or_none(os.path.join(EVIDENCE, "sit-ab", "group1", "stage-b.png"))
    after = open_or_none(shot("sit-ab-stage-b.png"))
    if before is None or after is None:
        print("[skip] 缺少坐姿脸部特写（先跑 npm run selftest）")
        return
    # 两张都是 420px 的脸部特写（`setFaceZoom(420)`），只裁上半部分到眼睛
    def crop_eyes(image):
        width, height = image.size
        return image.crop((0, 0, width, int(height * 0.62)))

    before = crop_eyes(before.convert("RGB"))
    after = crop_eyes(after.convert("RGB"))
    target_h = min(before.height, after.height)
    before = before.resize((int(before.width * target_h / before.height), target_h), Image.LANCZOS)
    after = after.resize((int(after.width * target_h / after.height), target_h), Image.LANCZOS)
    gap = 24
    header = 92
    footer = 56
    canvas = Image.new(
        "RGB",
        (before.width + after.width + gap * 3, target_h + header + footer),
        (246, 247, 250),
    )
    draw = ImageDraw.Draw(canvas)
    label(draw, (gap, 14), "ADR 0057 D3：坐姿停帧的眼睛（整条眼睛链照抄站立待机）", size=28)
    label(
        draw,
        (gap, 52),
        "修复前：片段 16.2s 冻住 —— 眼卡片下移 9px、子骨各转 8.8°/5.1%、眼皮 0.00033（半闭）",
        size=21,
        fill=(150, 60, 60),
    )
    label(
        draw,
        (gap * 2 + before.width, 52),
        "修复后：整条链（12 根）覆写回站立待机（眼皮 0.00027、weight 1.0）",
        size=21,
        fill=(40, 110, 60),
    )
    canvas.paste(before, (gap, header))
    canvas.paste(after, (gap * 2 + before.width, header))
    draw.rectangle([gap - 1, header - 1, gap + before.width, header + target_h], outline=(200, 204, 212))
    draw.rectangle(
        [gap * 2 + before.width - 1, header - 1, gap * 2 + before.width + after.width, header + target_h],
        outline=(200, 204, 212),
    )
    label(draw, (gap, header + target_h + 14), "同一机位、同一姿态（脸部特写相机 420px）", size=20, fill=(90, 94, 102))
    out = os.path.join(EVIDENCE, "sit-eyes-before-after.png")
    canvas.save(out, optimize=True)
    print(f"[ok] {out}（{canvas.size[0]}×{canvas.size[1]}）")


def compose_sit_exit():
    seated = open_or_none(shot("sit-stage-b.png"))
    standing = open_or_none(shot("window-after-sit-exit.png"))
    if seated is None or standing is None:
        print("[skip] 缺少坐姿/退场截图（先跑 npm run selftest）")
        return
    scale = 0.5
    panels = []
    for text, image in [("坐姿（眼睛照抄站立，阶段 B）", seated), ("退场 0.3s 交接之后：站立待机", standing)]:
        resized = image.convert("RGB").resize(
            (int(image.width * scale), int(image.height * scale)), Image.LANCZOS
        )
        panels.append((text, resized))
    gap = 24
    header = 66
    footer = 46
    height = max(panel.height for _, panel in panels)
    width = sum(panel.width for _, panel in panels) + gap * (len(panels) + 1)
    canvas = Image.new("RGB", (width, height + header + footer), (246, 247, 250))
    draw = ImageDraw.Draw(canvas)
    label(
        draw,
        (gap, 14),
        "ADR 0057 D1：坐姿退场（覆写全部释放，控制权交还 AnimationMixer）",
        size=26,
    )
    x = gap
    for text, panel in panels:
        canvas.paste(panel, (x, header))
        draw.rectangle([x - 1, header - 1, x + panel.width, header + panel.height], outline=(200, 204, 212))
        label(draw, (x, header + panel.height + 10), text, size=22, fill=(60, 64, 72))
        x += panel.width + gap
    out = os.path.join(EVIDENCE, "sit-exit-after.png")
    canvas.save(out, optimize=True)
    print(f"[ok] {out}（{canvas.size[0]}×{canvas.size[1]}）")


if __name__ == "__main__":
    compose_scale_gif()
    compose_scale_strip()
    compose_sit_eyes()
    compose_sit_exit()
    sys.exit(0)
