"""把 design/logo/mark.png 导出成应用用到的各尺寸图标。

用法：python scripts/export_icons.py
前置：先跑 scripts/make_logo.py + 浏览器栅格化出 design/logo/mark.png。
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT.parent / "design" / "logo" / "mark.png"
ICONS = ROOT / "src-tauri" / "icons"

TARGETS = {
    "32x32.png": 32,
    "64x64.png": 64,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
    "StoreLogo.png": 50,
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
}


def main() -> None:
    src = Image.open(SRC).convert("RGBA")

    src.save(ROOT / "public" / "logo.png")
    print("顶栏／favicon →", ROOT / "public" / "logo.png")

    for name, px in TARGETS.items():
        p = ICONS / name
        if p.exists():
            src.resize((px, px), Image.LANCZOS).save(p)

    ico = ICONS / "icon.ico"
    if ico.exists():
        src.save(ico, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("图标已重出", len(TARGETS), "个 png + icon.ico")


if __name__ == "__main__":
    main()
