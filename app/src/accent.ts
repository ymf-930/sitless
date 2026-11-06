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

/** 随机取一个主色；传 exclude 可避免连续两次撞色 */
export function randomAccent(exclude?: string): string {
  const list = exclude && ACCENTS.length > 1 ? ACCENTS.filter((c) => c !== exclude) : ACCENTS
  return list[Math.floor(Math.random() * list.length)]
}

/** 把主色按比例混到卡片底色上，得到不刺眼的浅色面板 */
export function tintAccent(hex: string, ratio = 0.55, base = '#fbfbf5'): string {
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const [r1, g1, b1] = rgb(hex)
  const [r2, g2, b2] = rgb(base)
  const mix = (a: number, b: number) => Math.round(a * ratio + b * (1 - ratio))
  return `rgb(${mix(r1, r2)}, ${mix(g1, g2)}, ${mix(b1, b2)})`
}

// 主窗(isPrimary=true)每次启动随机定一个主色并写入 localStorage；
// 警戒窗(子窗口)读取主窗写入的值，保证两个窗口主色一致。
export function applyAccent(isPrimary: boolean) {
  if (isPrimary) {
    const color = randomAccent()
    localStorage.setItem(KEY, color)
    document.documentElement.style.setProperty('--pink', color)
    return
  }
  const stored = localStorage.getItem(KEY)
  document.documentElement.style.setProperty('--pink', stored ?? ACCENTS[0])
}
