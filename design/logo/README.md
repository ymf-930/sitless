# 品牌资源（logo / 图标）

这里是全项目**唯一**的图标源头。桌面端、浏览器扩展、macOS/iOS/Android 的图标都由这里产出，不要直接改任何一处的产物图。

## 目录

| 路径 | 说明 |
|---|---|
| `mark.svg` | 唯一源文件。超椭圆底 `#c9ef9f` + 近黑人形「站在空椅旁」，双臂站姿 |
| `mark.png` | 由 `mark.svg` 栅格化的 1024×1024 透明 PNG，供各脚本读取 |
| `make_logo.py` | 用坐标生成 `mark.svg`（改笔画时改这里，保证 SVG 与脚本一致） |
| `rasterize.py` | `mark.svg` → `mark.png`（调本机 Edge/Chrome 无头截图） |
| `export_icons.py` | `mark.png` → 前端 logo + Windows 15 个尺寸 + `icon.ico` + 扩展 4 个尺寸 |
| `export_platform_icons.py` | `mark.png` → `icon.icns` / iOS 18 张白底 / Android 15 张透明 |
| `archive/` | 历史稿：坐姿版、单臂版、各轮候选与预览页。回滚时从这里取 |

## 改图标的完整流程

```bash
# 1. 只改造型时：编辑 make_logo.py 的坐标，重新生成 mark.svg
python design/logo/make_logo.py

# 2. 栅格化（自动调 Edge/Chrome；换浏览器加 --browser 路径）
python design/logo/rasterize.py

# 3. 一次导出所有平台的图标
python design/logo/export_icons.py
python design/logo/export_platform_icons.py
```

第 3 步会覆盖四处产物：

| 产物 | 位置 |
|---|---|
| 顶栏 / favicon | `app/public/logo.png` |
| Windows 图标 | `app/src-tauri/icons/*.png`（15 个）+ `icon.ico` |
| macOS / iOS / Android | `app/src-tauri/icons/icon.icns`、`icons/ios/`、`icons/android/` |
| 扩展图标 | `extension/public/icons/icon{16,32,48,128}.png` |

## 两条容易踩的坑

1. **别直接改 `mark.svg` 再改脚本之外的产物**。`make_logo.py` 里的 `TRANSFORM`、`FILL_RATIO`、`ARMS` 是定稿值，脚本重跑必须与 `mark.svg` 字节一致，否则以后每跑一次都漂移一点。
2. **Windows 会缓存 exe 图标**。`tauri-winres` 只比对 `resource.rc` 文本，换了 ico 内容不会触发重编；打包前删 `app/src-tauri/target/release/build/sitless-*/out/resource.lib|rc` 并 touch `build.rs`。任务栏仍显示旧图时，那是 Explorer 图标缓存，`Stop-Process -Name explorer -Force` 即可（不影响应用与计时数据）。
