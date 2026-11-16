"""把 design/logo/mark.png 导出成三处用到的图标：前端 logo、Tauri 桌面图标、扩展图标。

用法：python design/logo/export_icons.py
前置：改过笔画先跑 design/logo/make_logo.py 产出 mark.svg，
      再用 Edge headless 栅格化成 design/logo/mark.png（命令见同目录 README.md）。
"""

from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent          # design/logo
ROOT = HERE.parents[1]                          # 仓库根
APP = ROOT / "app"
SRC = HERE / "mark.png"
ICONS = APP / "src-tauri" / "icons"
EXT_ICONS = ROOT / "extension" / "public" / "icons"

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

# 浏览器扩展 toolbar / 商店图标
EXT_TARGETS = {
    "icon16.png": 16,
    "icon32.png": 32,
    "icon48.png": 48,
    "icon128.png": 128,
}


def main() -> None:
    src = Image.open(SRC).convert("RGBA")

    src.save(APP / "public" / "logo.png")
    print("顶栏／favicon →", APP / "public" / "logo.png")

    for name, px in TARGETS.items():
        p = ICONS / name
        if p.exists():
            src.resize((px, px), Image.LANCZOS).save(p)

    ico = ICONS / "icon.ico"
    if ico.exists():
        src.save(ico, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("桌面图标已重出", len(TARGETS), "个 png + icon.ico")

    EXT_ICONS.mkdir(parents=True, exist_ok=True)
    for name, px in EXT_TARGETS.items():
        src.resize((px, px), Image.LANCZOS).save(EXT_ICONS / name)
    print("扩展图标已重出", len(EXT_TARGETS), "个 →", EXT_ICONS)


if __name__ == "__main__":
    main()
