"""生成「走走」图标：超椭圆底 + 人站在空椅旁（正式定稿）。

正式链路：design/logo/mark.svg → 栅格化出 mark.png → export_icons.py 导出各尺寸。
坐姿旧稿归档在 design/logo/sit.svg / sit.png / sit-icons/，需要回滚直接覆盖回来即可。

用法：python scripts/make_logo.py [h|gh|a|b|c]
注意：mark.svg 的缩放偏移是手工微调过的定稿值，脚本用 TRANSFORM 固定它，
改动笔画后要重新算 bbox 并更新 TRANSFORM（脚本会打印自动计算值供核对）。
"""

import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT.parent / "design" / "logo" / "mark.svg"

SIZE = 1024
N = 4.0            # 超椭圆指数，和之前图标一致
BG = "#c9ef9f"     # 品牌绿（保留之前的底色）
FILL_RATIO = 0.68  # 站姿并排构图，取较高边做基准

# 定稿缩放偏移（由 bbox 自动算出后微调，重跑脚本才能保证字节一致）
TRANSFORM = "translate(-260.71 -139.03) scale(1.3521)"

# 笔画基准坐标：椅子保持空椅，人站到右侧（用户 2026-11-09 定稿，人左移 50 拉近）
HEAD = (690, 280, 56)                         # cx, cy, r
TORSO = [(690, 352), (690, 520)]              # 竖直躯干
LEGS = [                                      # 两条 V 形落地腿
    [(690, 520), (650, 706)],
    [(690, 520), (750, 706)],
]
ARM = [(720, 382), (780, 470)]                # 从躯干侧边斜向下垂
BACK = [(368, 344), (368, 716)]               # 椅背 + 后腿（一根竖线）
SEAT = [(368, 596), (560, 596)]               # 坐板（右端落在前腿上）
FRONT = [(560, 596), (560, 716)]              # 前腿

BODY_W = 56
ARM_W = 36
ARM_HALO_INSET = 18                           # 底色缝起点内插，避免在肩部横切躯干
CHAIR_W = 46

VARIANTS = {
    # 椅子：深绿；人：近黑 —— 两色都压在浅绿底上，椅子不再发白看不清
    "a": {"person": "#0c0c0c", "chair": "#3f7a4c"},
    # 椅子：墨绿偏青
    "b": {"person": "#0c0c0c", "chair": "#2f6b5a"},
    # 椅子：橄榄绿
    "c": {"person": "#0c0c0c", "chair": "#5c6b32"},
    # 人和椅子都黑，靠一圈底色把两者分开（26px 下最清楚，正式定稿用这个）
    "h": {"person": "#0c0c0c", "chair": "#0c0c0c"},
    # 深绿椅子 + 底色留缝
    "gh": {"person": "#0c0c0c", "chair": "#3f7a4c"},
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


def auto_transform() -> str:
    """按当前笔画自动算居中缩放，改动笔画后用它核对 TRANSFORM。"""
    xs: list[float] = []
    ys: list[float] = []
    hx, hy, hr = HEAD
    xs += [hx - hr, hx + hr]
    ys += [hy - hr, hy + hr]
    segs = ([(TORSO, BODY_W)] + [(leg, BODY_W) for leg in LEGS]
            + [(ARM, ARM_W), (BACK, CHAIR_W), (SEAT, CHAIR_W), (FRONT, CHAIR_W)])
    for seg, w in segs:
        for x, y in seg:
            xs += [x - w / 2, x + w / 2]
            ys += [y - w / 2, y + w / 2]
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    w, h = x1 - x0, y1 - y0
    scale = SIZE * FILL_RATIO / max(w, h)
    tx = SIZE / 2 - (x0 + w / 2) * scale
    ty = SIZE / 2 - (y0 + h / 2) * scale
    return f"translate({tx:.2f} {ty:.2f}) scale({scale:.4f})"


def main() -> None:
    which = (sys.argv[1] if len(sys.argv) > 1 else "h").lower()
    pal = VARIANTS.get(which, VARIANTS["h"])

    def line(seg, width):
        (ax, ay), (bx, by) = seg
        return f'<path d="M{ax} {ay} L{bx} {by}" stroke-width="{width}"/>'

    hx, hy, hr = HEAD
    chair = "\n        ".join(line(s, CHAIR_W) for s in [BACK, SEAT, FRONT])

    # 底色留缝：先按底色画一遍加粗的人，再压上真正的人形，
    # 这样人与椅子交叠处、胳膊末端与大腿之间会露出一条底色细缝。
    body_segs = [TORSO] + LEGS
    halo = "\n        ".join(
        [f'        <circle cx="{hx}" cy="{hy}" r="{hr + 8}"'
         f' fill="{BG}" stroke="none"/>']
        + [line(s, BODY_W + 16) for s in body_segs]
    )
    person = "\n        ".join(
        [f'        <circle cx="{hx}" cy="{hy}" r="{hr}"'
         f' fill="{pal["person"]}" stroke="none"/>']
        + [line(s, BODY_W) for s in body_segs]
    )
    (ax, ay), (bx, by) = ARM[0], ARM[1]
    t = ARM_HALO_INSET / ((bx - ax) ** 2 + (by - ay) ** 2) ** 0.5
    arm_halo = (f'<path d="M{ax + (bx - ax) * t:.1f} {ay + (by - ay) * t:.1f}'
                + ''.join(f' L{x} {y}' for x, y in ARM[1:])
                + f'" stroke-width="{ARM_W + 16}"/>')
    arm = line(ARM, ARM_W)

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{SIZE}" height="{SIZE}" viewBox="0 0 {SIZE} {SIZE}">
  <path d="{squircle_path(SIZE, N)}" fill="{BG}"/>
  <g transform="{TRANSFORM}"
     fill="none" stroke-linecap="round" stroke-linejoin="round">
      <g stroke="{pal['chair']}">
        {chair}
      </g>
      <g stroke="{BG}">
        {halo}
      </g>
      <g stroke="{pal['person']}">
        {person}
      </g>
      <g stroke="{BG}">
        {arm_halo}
      </g>
      <g stroke="{pal['person']}">
        {arm}
      </g>
  </g>
</svg>
"""
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(svg, encoding="utf-8", newline="\n")
    auto = auto_transform()
    print(f"写出 {OUT}  方案 {which}")
    print(f"定稿 transform: {TRANSFORM}")
    print(f"bbox 自动计算:  {auto}" + ("  (一致)" if auto == TRANSFORM else "  (手工微调值)"))


if __name__ == "__main__":
    main()
