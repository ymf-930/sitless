// 主色（--pink 角色）随机调色板：都是高明度低饱和的浅色，深色文字压得住。
// 按色相铺开，避免相邻两个看起来是同一个颜色。
export const ACCENTS = [
  '#ffd9bf', // 蜜橙
  '#fbe7b4', // 奶油黄
  '#c9ef9f', // 青柠
  '#d3f2c4', // 薄荷
  '#cdeff0', // 水青
  '#d9eefb', // 天蓝
  '#dcdcf7', // 蓝紫
  '#e8dcfa', // 薰衣草
  '#fbdde6', // 樱粉
  '#f2dced', // 藕荷
  '#f0e3d2', // 燕麦
  '#dfe8d5', // 鼠尾草
]

const KEY = 'sitless.accent'
const PALETTE_KEY = 'sitless.palette'
/** 每次启动随机分配到这些 CSS 变量上，卡片、柱图、时间线、工具栏按钮都跟着变 */
const ROLES = ['--pink', '--mint', '--sky', '--butter', '--lilac'] as const

/** 随机取一个主色；传 exclude 可避免连续两次撞色 */
export function randomAccent(exclude?: string): string {
  const list = exclude && ACCENTS.length > 1 ? ACCENTS.filter((c) => c !== exclude) : ACCENTS
  return list[Math.floor(Math.random() * list.length)]
}

/** 两个绿留给「已完成」语义（目标方块、进度胶囊），不参与卡片配色，免得撞色 */
const RESERVED = new Set(['#c9ef9f', '#d3f2c4'])

/** 洗牌后取前 n 个，保证同一次启动里几个卡片颜色不重复 */
function pickDistinct(n: number): string[] {
  const pool = ACCENTS.filter((c) => !RESERVED.has(c))
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, n)
}

/** 把主色按比例混到卡片底色上，得到不刺眼的浅色面板 */
export function tintAccent(hex: string, ratio = 0.55, base = '#fbfbf5'): string {
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const [r1, g1, b1] = rgb(hex)
  const [r2, g2, b2] = rgb(base)
  const mix = (a: number, b: number) => Math.round(a * ratio + b * (1 - ratio))
  return `rgb(${mix(r1, r2)}, ${mix(g1, g2)}, ${mix(b1, b2)})`
}

function paint(colors: string[]) {
  ROLES.forEach((role, i) => {
    document.documentElement.style.setProperty(role, colors[i])
  })
}

function readPalette(): string[] {
  try {
    const raw = localStorage.getItem(PALETTE_KEY)
    const arr = raw ? JSON.parse(raw) : null
    if (Array.isArray(arr) && arr.length === ROLES.length) return arr as string[]
  } catch {
    /* 读坏了就回落到默认 */
  }
  const stored = localStorage.getItem(KEY) ?? ACCENTS[0]
  const rest = ACCENTS.filter((c) => c !== stored).slice(0, ROLES.length - 1)
  return [stored, ...rest]
}

// 主窗(isPrimary=true)每次启动随机定一组色并写入 localStorage；
// 警戒窗(子窗口)读取主窗写入的那组，保证两个窗口配色一致。
export function applyAccent(isPrimary: boolean) {
  if (isPrimary) {
    const colors = pickDistinct(ROLES.length)
    localStorage.setItem(PALETTE_KEY, JSON.stringify(colors))
    localStorage.setItem(KEY, colors[0]) // 兼容只读这个键的旧逻辑
    paint(colors)
    return
  }
  paint(readPalette())
}
