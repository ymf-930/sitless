# app/ · 走走前端与 Tauri 后端工程

本目录是「走走」久坐提醒应用的工程目录。**完整项目文档在仓库根目录：[../README.md](../README.md)**（快速开始、架构、计时规则、踩坑清单、已知限制）。

日常开发在本目录执行：

```powershell
pnpm install
pnpm dev                 # 仅前端，浏览器打开 http://localhost:5173/?demo=1
pnpm exec tauri dev      # 完整桌面应用（同时启动 Vite + Rust）
pnpm build               # 类型检查 + 前端构建
pnpm exec tauri build    # 打 Windows NSIS 安装包
```

配置说明：`tauri.conf.json`（窗口/打包）、`src-tauri/capabilities/default.json`（ACL 权限）、`src-tauri/src/state.rs`（计时默认值）。
