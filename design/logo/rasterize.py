"""把 mark.svg 栅格化成 mark.png（1024 透明底）。

SVG 直接交给浏览器截图会因为缺少视口而留白，所以先包一层内联 SVG 的临时 HTML。
需要本机装有 Edge 或 Chrome；换浏览器用 --browser。

用法：python design/logo/rasterize.py [--browser 路径]
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SVG = HERE / "mark.svg"
OUT = HERE / "mark.png"
SIZE = 1024

CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
]


def find_browser(explicit: str | None) -> str:
    if explicit:
        p = Path(explicit)
        if not p.is_file():
            raise SystemExit(f"浏览器不存在: {p}")
        return str(p)
    for c in CANDIDATES:
        if Path(c).is_file():
            return c
    raise SystemExit("没找到 Edge/Chrome，用 --browser 指定可执行文件路径")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--browser", default=None, help="Edge/Chrome 可执行文件路径")
    args = ap.parse_args()

    if not SVG.is_file():
        raise SystemExit(f"缺源文件: {SVG}（先跑 make_logo.py）")

    svg = SVG.read_text(encoding="utf-8")
    html = (
        "<!doctype html><meta charset=\"utf-8\">"
        f"<style>html,body{{margin:0;padding:0;background:transparent}}"
        f"svg{{display:block;width:{SIZE}px;height:{SIZE}px}}</style>"
        f"{svg}"
    )

    with tempfile.TemporaryDirectory() as tmp:
        page = Path(tmp) / "raster.html"
        page.write_text(html, encoding="utf-8")
        cmd = [
            find_browser(args.browser),
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--default-background-color=00000000",
            "--force-device-scale-factor=1",
            f"--window-size={SIZE},{SIZE}",
            f"--screenshot={OUT}",
            page.as_uri(),
        ]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0 and not OUT.exists():
            sys.stderr.write(r.stderr)
            raise SystemExit(f"栅格化失败，退出码 {r.returncode}")

    if not OUT.exists():
        raise SystemExit("没有产出 mark.png")

    try:
        from PIL import Image

        im = Image.open(OUT)
        corner = im.convert("RGBA").getpixel((0, 0))
        print(f"mark.png {im.size} {im.mode}，角像素 {corner}")
    except ImportError:
        print(f"mark.png 已写出：{OUT}")


if __name__ == "__main__":
    main()
