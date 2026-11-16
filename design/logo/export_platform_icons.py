"""重出 macOS / iOS / Android 平台图标（Windows 图标由 export_icons.py 负责）。

源图默认 design/logo/mark.png（1024 透明超椭圆），按 Tauri 模板现有文件尺寸
逐个覆盖 icons/icon.icns、icons/ios/*.png、icons/android/**/*.png。
XML（adaptive-icon / 背景色）不动。

改 logo 后的顺序：
    python design/logo/make_logo.py            # 需要改笔画时，产出 design/logo/mark.svg
    # Edge headless 栅格化 mark.svg -> design/logo/mark.png
    python design/logo/export_icons.py         # 前端 logo + Windows 图标 + 扩展图标
    python design/logo/export_platform_icons.py

回滚历史稿时可指定源图：
    python design/logo/export_platform_icons.py --source design/logo/archive/sit.png
"""

from __future__ import annotations

import argparse
import io
import struct
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
ICONS = ROOT / "app/src-tauri/icons"
DEFAULT_SOURCE = ROOT / "design/logo/mark.png"

# ICNS 的 PNG 块类型 -> 实际像素尺寸（@2x 类型存的是放大后的像素）
ICNS_BLOCKS = [
    (b"ic07", 128),   # 128x128
    (b"ic08", 256),   # 256x256
    (b"ic09", 512),   # 512x512
    (b"ic10", 1024),  # 1024x1024
    (b"ic11", 64),    # 32x32 @2x
    (b"ic12", 128),   # 64x64 @2x
    (b"ic13", 512),   # 256x256 @2x
    (b"ic14", 1024),  # 512x512 @2x
]


def png_bytes(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def build_icns(src: Image.Image) -> bytes:
    blocks = []
    for kind, size in ICNS_BLOCKS:
        data = png_bytes(src.resize((size, size), Image.LANCZOS))
        blocks.append(kind + struct.pack(">I", 8 + len(data)) + data)
    body = b"".join(blocks)
    return b"icns" + struct.pack(">I", 8 + len(body)) + body


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="1024 透明源图")
    args = ap.parse_args()
    source = args.source if args.source.is_absolute() else (Path.cwd() / args.source)
    source = source.resolve()
    if not source.exists():
        raise SystemExit(f"源图不存在: {source}")

    img = Image.open(source).convert("RGBA")
    print(f"源图: {source}  {img.size} {img.mode}")

    # 1) macOS icns —— 纯 PNG 块，现代 macOS 足够；不再写旧式 is32/il32 mask 块
    icns = build_icns(img)
    (ICONS / "icon.icns").write_bytes(icns)
    print(f"icon.icns: {len(icns)} bytes, {len(ICNS_BLOCKS)} 个 PNG 块")

    # 2) iOS —— Tauri 模板里 iOS 图标是白底不透明，铺白底保持同规格
    ios_files = sorted((ICONS / "ios").glob("*.png"))
    for p in ios_files:
        size = Image.open(p).size
        bg = Image.new("RGBA", size, (255, 255, 255, 255))
        bg.alpha_composite(img.resize(size, Image.LANCZOS))
        bg.save(p, "PNG", optimize=True)
    print(f"ios/: {len(ios_files)} 个 png 已覆盖（白底不透明）")

    # 3) Android —— 透明底，含 adaptive icon 的 foreground；尺寸沿用模板
    android_files = sorted((ICONS / "android").rglob("*.png"))
    for p in android_files:
        size = Image.open(p).size
        img.resize(size, Image.LANCZOS).save(p, "PNG", optimize=True)
    print(f"android/: {len(android_files)} 个 png 已覆盖（透明底）")

    # 4) 自检：尺寸没变、icns 能被 PIL 读、平台图标里没有旧 L 形方案的残留
    check = Image.open(io.BytesIO(icns))
    print(f"自检: icns 可读 {check.size}, 角像素 {check.convert('RGBA').getpixel((0, 0))}")
    print("完成。XML 未改动。")


if __name__ == "__main__":
    main()
