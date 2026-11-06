"""交叉检查「JSX 里用到的类名」和「CSS 里定义的类名」。

专门防一类误删：类名是拼出来的（模板字符串、数组常量），
肉眼看 CSS 或按字面搜 className 都会漏掉，清理死代码时容易误杀。

用法：python scripts/check_classes.py
退出码 1 表示有类名在 JSX 里用到但 CSS 里没有定义。
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"


def used_classes() -> set[str]:
    text = "\n".join(p.read_text(encoding="utf-8") for p in SRC.glob("*.tsx"))
    names: set[str] = set()

    # 1) 字面量：className="a b" / className={'a b'}
    for m in re.finditer(r"""className=\{?["']([^"']+)["']\}?""", text):
        names |= {t for t in re.split(r"\s+", m.group(1)) if t}

    # 2) 模板字符串里的静态片段：className={`a b${x} c`}
    for m in re.finditer(r"className=\{`([^`]+)`\}", text):
        frag = re.sub(r"\$\{[^}]*\}", " ", m.group(1))
        names |= {t for t in re.split(r"[\s'\"]+", frag) if t}

    # 3) 常量数组里的类名：const tones = ['tl-mint', ...]
    #    只收带连字符的（配置键多是 a_b 这种下划线命名，排除掉）
    for m in re.finditer(r"const\s+\w+\s*=\s*\[([^\]]*)\]", text):
        cand = re.findall(r"['\"]([a-z][a-z0-9-]*)['\"]", m.group(1))
        names |= {t for t in cand if "-" in t}

    # 4) 三元里带前导空格的片段：? ' is-on' : ''（约定：补一个类名前留空格）
    names |= {t.strip() for t in re.findall(r"\?\s*'( [a-z][a-z0-9 -]*)'", text) if t.strip()}

    # 以 - 结尾的是动态拼接的前缀（如 `btn-${variant}`），交给 CSS 无法校验
    return {n for n in names if n and not n.startswith("${") and not n.endswith("-")}


def main() -> None:
    css = "\n".join(
        p.read_text(encoding="utf-8") for p in SRC.rglob("*.css")
    )
    defined = set(re.findall(r"\.([A-Za-z][A-Za-z0-9_-]*)", css))
    missing = sorted(c for c in used_classes() if c not in defined)
    if missing:
        print("以下类名在 JSX 里用到，但 CSS 里没有定义：")
        for c in missing:
            print("  -", c)
        sys.exit(1)
    print("类名对齐：没有缺失")


if __name__ == "__main__":
    main()
