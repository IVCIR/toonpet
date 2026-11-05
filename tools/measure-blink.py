"""对比"睁眼/闭眼"两张截图里虹膜（暗洋红）像素占比，量化眨眼幅度（只读本地 PNG）。

用法：python measure-blink.py <open.png> <closed.png>
"""
import sys
from pathlib import Path

from PIL import Image


def iris_fraction(path: Path, box: tuple[int, int, int, int]) -> tuple[float, int, int]:
    image = Image.open(path).convert("RGB").crop(box)
    pixels = list(image.getdata())
    dark = 0
    for r, g, b in pixels:
        # 虹膜：亮洋红偏暗（R 高、G 低、B 中）；眼皮/皮肤：三通道都高
        if r > 90 and g < 80 and b < 120 and r - g > 40:
            dark += 1
    total = len(pixels)
    return (dark / total if total else 0.0, dark, total)


def main() -> int:
    open_path = Path(sys.argv[1])
    closed_path = Path(sys.argv[2])
    # 眼部带（设备像素）：窗口内容 422×720 CSS、截图 2×；
    # 位置由 `find-iris` 实测（虹膜像素集中在 y≈810–860），这里取一个略宽的带。
    box = (280, 780, 640, 900)
    o, od, ot = iris_fraction(open_path, box)
    c, cd, ct = iris_fraction(closed_path, box)
    print(f"open  : iris={od}/{ot} = {o*100:.2f}%")
    print(f"closed: iris={cd}/{ct} = {c*100:.2f}%")
    if o > 0:
        print(f"reduction = {(1 - c / o) * 100:.1f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
