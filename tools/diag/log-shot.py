# 把 logs/pet.log 里的关键行渲染成图片（"控制台截图"），用于排查汇报。
#
# 为什么不用真截图：Electron 主进程的 console 在自检/后台启动时没有可见终端，
# 权威记录就是 logs/pet.log。这个脚本只做"把文本行画进 PNG"，不改写任何内容：
# 每行按原样换行（不动空格），超长行折行显示，不做删改。
#
# 用法：
#   python tools/diag/log-shot.py --log logs/diag-run1.log --out dist/diagnostics \
#       --group "告示|静态点击（头部带内）|drag-gesture|head_patted" ...
# 简化用法见 build_shots() 里的默认三组（本轮 ADR 0039 排查）。
import argparse
import os
import re
import textwrap

from PIL import Image, ImageDraw, ImageFont

BG = (18, 20, 24)
FG = (214, 219, 226)
DIM = (128, 138, 152)
ACCENT = (255, 196, 92)
OK = (122, 214, 138)
BAD = (255, 128, 128)
HEAD = (126, 182, 255)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\consola.ttf",
    r"C:\Windows\Fonts\simhei.ttf",
]


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def read_lines(path):
    # 注意：PowerShell 的 `Tee-Object` 会写成 **UTF-16LE + BOM**，而应用自己的 `logs/pet.log`
    # 是 UTF-8。两种都要能读，否则中文行会变成乱码、正则一条都匹配不到（本轮踩过）。
    with open(path, "rb") as handle:
        raw = handle.read()
    if raw.startswith(b"\xff\xfe") or raw.startswith(b"\xfe\xff"):
        text = raw.decode("utf-16", errors="replace")
    elif raw.startswith(b"\xef\xbb\xbf"):
        text = raw.decode("utf-8-sig", errors="replace")
    else:
        text = raw.decode("utf-8", errors="replace")
    return [line.rstrip("\r") for line in text.split("\n")]


def colour_for(line):
    if "emit head_patted? true" in line or "head_patted 发出" in line:
        return OK
    if "emit head_patted? false" in line or "忽略 head_patted" in line or "未触发" in line:
        return BAD
    if "头部带几何" in line or "脸部点击诊断" in line or "落地缓冲" in line or "反跳" in line:
        return ACCENT
    if "[drag-gesture]" in line:
        return HEAD
    return FG


def render(groups, out_dir, width=1480, font_size=15, line_height=21, wrap=150):
    os.makedirs(out_dir, exist_ok=True)
    font = load_font(font_size)
    title_font = load_font(font_size + 4)
    written = []

    for index, group in enumerate(groups):
        body = []
        for line in group["lines"]:
            wrapped = textwrap.wrap(line, width=wrap, subsequent_indent="    ") or [""]
            body.extend(wrapped)

        height = 64 + max(1, len(body)) * line_height + 24
        canvas = Image.new("RGB", (width, height), BG)
        draw = ImageDraw.Draw(canvas)
        draw.text((18, 16), group["title"], font=title_font, fill=(255, 255, 255))
        draw.text((18, 42), group.get("subtitle", ""), font=font, fill=DIM)
        draw.line((16, 66, width - 16, 66), fill=(48, 54, 64))

        y = 76
        for line in body:
            draw.text((18, y), line, font=font, fill=colour_for(line))
            y += line_height

        name = group.get("name") or f"log-{index:02d}"
        path = os.path.join(out_dir, f"{name}.png")
        canvas.save(path)
        written.append(path)
    return written


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--log", default="logs/diag-run1.log")
    parser.add_argument("--out", default="dist/diagnostics")
    parser.add_argument("--strip-prefix", action="store_true", default=True)
    args = parser.parse_args()

    lines = read_lines(args.log)

    def pick(pattern, limit=None):
        regex = re.compile(pattern)
        hits = [line for line in lines if regex.search(line)]
        return hits[:limit] if limit else hits

    groups = [
        {
            "name": "log-01-face-click",
            "title": "① 点她的脸：hitHead=true → 发出 head_patted → render 播官方片段（weight=1.00）",
            "subtitle": "ADR 0040 验收 1；旧口径下这一点是 head=false（掩膜 bbox 22%），现在按头骨半径判定",
            "lines": pick(r"脸部|pointdown: hitHead=true.*y=4|pointerdown: hitHead=true.*y=45|emit head_patted\? true|head_patted 发出|收到 head_patted|官方片段 head_patted|摸头片段回报", 12),
        },
        {
            "name": "log-02-halo-click",
            "title": "② 点光环（y≈0.22H）：hit=true 但 head=false → 不触发（ADR 0040 验收 2）",
            "subtitle": "光环在掩膜里不透明（旧口径把它算成头部），现在它离头骨 > 半径，被正确排除",
            "lines": pick(r"head-not-in-band|pointerdown: hitHead=false, x=\d+, y=15", 6),
        },
        {
            "name": "log-03-head-region",
            "title": "③ 头部区几何：圆心 = 头骨 y343，半径 = 90px（发顶 260 → 下巴 433）",
            "subtitle": "旧口径的 22% 下边界 y≈228–275 只盖到光环与发顶——这就是“点她没反应”的根因",
            "lines": pick(r"头部区几何", 2),
        },
        {
            "name": "log-04-landing",
            "title": "④ 落地：冲击只看松手速度；压扁上限 3%、220ms；反跳比值 0.28 → 0.15",
            "subtitle": "向下甩手 vy=2220 → impact=1.00 / squashMax=0.0300；轻放 vy=0 → impact=0（完全不缩）",
            "lines": pick(r"松手：竖直速度|回弹触地反跳|回弹结束|落地缓冲", 10),
        },
    ]

    written = render(groups, args.out)
    for path in written:
        print(path)


if __name__ == "__main__":
    main()
