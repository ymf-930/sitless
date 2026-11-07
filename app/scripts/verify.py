#!/usr/bin/env python3
"""改动后的一键静态验证：build / lint / CSS 类名 / i18n / Rust 单测。

用法：pnpm verify  或  python app/scripts/verify.py
"""
from __future__ import annotations

import collections
import os
import pathlib
import re
import subprocess
import sys

APP = pathlib.Path(__file__).resolve().parents[1]
TAURI = APP / "src-tauri"


def run(name: str, command: str, cwd: pathlib.Path) -> bool:
    print(f"\n=== {name} ===")
    env = os.environ.copy()
    cargo_bin = pathlib.Path.home() / ".cargo" / "bin"
    if cargo_bin.is_dir():
        env["PATH"] = str(cargo_bin) + os.pathsep + env.get("PATH", "")
    try:
        proc = subprocess.run(
            command,
            cwd=cwd,
            env=env,
            shell=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except OSError as exc:
        print(f"  FAIL 无法执行: {exc}")
        return False
    lines = ((proc.stdout or "") + (proc.stderr or "")).strip().splitlines()
    for line in lines[-6:]:
        print("  " + line)
    ok = proc.returncode == 0
    print(f"  -> {'OK' if ok else 'FAIL'} (exit {proc.returncode})")
    return ok


def check_i18n() -> bool:
    print("\n=== i18n 词条 ===")
    text = (APP / "src" / "i18n.ts").read_text(encoding="utf-8")
    keys = re.findall(r"^  '((?:[^'\\]|\\.)*)':", text, re.M)
    dup = [k for k, c in collections.Counter(keys).items() if c > 1]
    used: set[str] = set()
    for name in ("src/Alert.tsx", "src/App.tsx", "src/TrayMenu.tsx"):
        body = (APP / name).read_text(encoding="utf-8")
        used |= set(re.findall(r"(?<![A-Za-z])t\('([^']+)'", body))
    missing = sorted(used - set(keys))
    print(f"  字典 {len(keys)} 条 / 重复 {len(dup)} / 静态 key {len(used)} / 缺失 {len(missing)}")
    for key in dup:
        print("   DUP", key)
    for key in missing:
        print("   MISS", key)
    return not dup and not missing


def main() -> int:
    py = f'"{sys.executable}"'
    cargo = pathlib.Path.home() / ".cargo" / "bin" / "cargo.exe"
    cargo_cmd = f'"{cargo}"' if cargo.exists() else "cargo"
    results = {
        "前端构建": run("pnpm build", "pnpm build", APP),
        "代码检查": run("pnpm lint", "pnpm lint", APP),
        "CSS 类名": run("check_classes", f"{py} scripts/check_classes.py", APP),
        "i18n 词条": check_i18n(),
        "Rust 单测": run("cargo test", f'{cargo_cmd} test --manifest-path "{TAURI / "Cargo.toml"}"', APP),
    }
    print("\n=== 汇总 ===")
    for name, ok in results.items():
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    failed = [name for name, ok in results.items() if not ok]
    if failed:
        print(f"\n{len(failed)} 项失败：{', '.join(failed)}")
        return 1
    print("\n全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
