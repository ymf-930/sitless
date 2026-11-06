// 主色（--pink 角色）随机调色板：取自系统现有几种高亮色
export const ACCENTS = ['#ffd9bf', '#d3f2c4', '#d9eefb', '#fbe7b4', '#c9ef9f']
const KEY = 'sitless.accent'

/** 随机取一个主色；传 exclude 可避免连续两次撞色 */
export function randomAccent(exclude?: string): string {
  const list = exclude && ACCENTS.length > 1 ? ACCENTS.filter((c) => c !== exclude) : ACCENTS
  return list[Math.floor(Math.random() * list.length)]
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
