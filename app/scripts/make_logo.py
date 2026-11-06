"""生成「动一动」的图标：超椭圆底 + 人坐在椅子上（内部形状参考截图）。

底是品牌绿，外轮廓是小米那种超椭圆。默认方案 h：人与椅子都用近黑，
中间垫一圈底色留缝，26px 下也能看清椅背、坐板和人的分界。
用法：python scripts/make_logo.py [h|gh|a|b|c]
输出 design/logo/mark.svg，位图由 Chrome headless 栅格化。
"""

import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT.parent / "design" / "logo" / "mark.svg"

SIZE = 1024
N = 4.0            # 超椭圆指数，和之前图标一致
BG = "#c9ef9f"     # 品牌绿（保留之前的底色）
FILL_RATIO = 0.66  # 图形占画布比例

# 笔画基准坐标，最后统一缩放居中
HEAD = (438, 296, 56)                        # cx, cy, r
BODY = [(438, 368), (466, 548), (604, 548)]  # 背 → 大腿
SHIN = [(604, 548), (650, 706)]              # 小腿斜向下
BACK = [(368, 344), (368, 716)]              # 椅背 + 后腿（一根竖线）
SEAT = [(368, 596), (700, 596)]              # 坐板（右端伸过膝，别留半截桩）

BODY_W = 56
CHAIR_W = 46

VARIANTS = {
    # 椅子：深绿；人：近黑 —— 两色都压在浅绿底上，椅子不再发白看不清
    "a": {"person": "#0c0c0c", "chair": "#3f7a4c"},
    # 椅子：墨绿偏青
    "b": {"person": "#0c0c0c", "chair": "#2f6b5a"},
    # 椅子：橄榄绿
    "c": {"person": "#0c0c0c", "chair": "#5c6b32"},
    # 人和椅子都黑，靠一圈底色把两者分开（26px 下最清楚）
    "h": {"person": "#0c0c0c", "chair": "#0c0c0c", "halo": True},
    # 深绿椅子 + 底色留缝
    "gh": {"person": "#0c0c0c", "chair": "#3f7a4c", "halo": True},
}


def squircle_path(size: int, n: float, samples: int = 480) -> str:
    c = size / 2
    pts = []
    for i in range(samples):
        t = 2 * math.pi * i / samples
        ct, st = math.cos(t), math.sin(t)
        x = c + c * (abs(ct) ** (2 / n)) * (1 if ct >= 0 else -1)
        y = c + c * (abs(st) ** (2 / n)) * (1 if st >= 0 else -1)
        pts.append(f"{x:.1f},{y:.1f}")
    return "M" + " L".join(pts) + " Z"


def bbox() -> tuple[float, float, float, float]:
    xs: list[float] = []
    ys: list[float] = []
    hx, hy, hr = HEAD
    xs += [hx - hr, hx + hr]
    ys += [hy - hr, hy + hr]
    segs = [(BODY, BODY_W), (SHIN, BODY_W), (BACK, CHAIR_W), (SEAT, CHAIR_W)]
    for seg, w in segs:
        for x, y in seg:
            xs += [x - w / 2, x + w / 2]
            ys += [y - w / 2, y + w / 2]
    return min(xs), min(ys), max(xs), max(ys)


def main() -> None:
    which = (sys.argv[1] if len(sys.argv) > 1 else "h").lower()
    pal = VARIANTS.get(which, VARIANTS["a"])

    x0, y0, x1, y1 = bbox()
    w, h = x1 - x0, y1 - y0
    scale = SIZE * FILL_RATIO / max(w, h)
    tx = SIZE / 2 - (x0 + w / 2) * scale
    ty = SIZE / 2 - (y0 + h / 2) * scale

    def line(seg, width):
        (ax, ay), (bx, by) = seg
        return f'<path d="M{ax} {ay} L{bx} {by}" stroke-width="{width}"/>'

    def polyline(points, width):
        d = "M" + " L".join(f"{x} {y}" for x, y in points)
        return f'<path d="{d}" stroke-width="{width}"/>'

    hx, hy, hr = HEAD
    chair = "\n        ".join([line(BACK, CHAIR_W), line(SEAT, CHAIR_W)])
    person = "\n        ".join([
        f'<circle cx="{hx}" cy="{hy}" r="{hr}" fill="{pal["person"]}" stroke="none"/>',
        polyline(BODY, BODY_W),
        line(SHIN, BODY_W),
    ])
    # 描边分离：先按底色画一遍加粗的人，再压上真正的人形，
    # 这样人与椅子交叠处会露出一条底色细缝
    halo = ""
    if pal.get("halo"):
        halo = f'''      <g stroke="{BG}">
        <circle cx="{hx}" cy="{hy}" r="{hr + 8}" fill="{BG}" stroke="none"/>
        {polyline(BODY, BODY_W + 16)}
        {line(SHIN, BODY_W + 16)}
      </g>
'''

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{SIZE}" height="{SIZE}" viewBox="0 0 {SIZE} {SIZE}">
  <path d="{squircle_path(SIZE, N)}" fill="{BG}"/>
  <g transform="translate({tx:.2f} {ty:.2f}) scale({scale:.4f})"
     fill="none" stroke-linecap="round" stroke-linejoin="round">
      <g stroke="{pal['chair']}">
        {chair}
      </g>
{halo}      <g stroke="{pal['person']}">
        {person}
      </g>
  </g>
</svg>
"""
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(svg, encoding="utf-8", newline="\n")
    print(f"写出 {OUT}  方案 {which}")


if __name__ == "__main__":
    main()
