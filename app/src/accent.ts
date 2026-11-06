// 主色（--pink 角色）随机调色板：取自系统现有几种高亮色
const ACCENTS = ['#ffd9bf', '#d3f2c4', '#d9eefb', '#fbe7b4', '#c9ef9f']
const KEY = 'sitless.accent'

// 主窗(isPrimary=true)每次启动随机定一个主色并写入 localStorage；
// 警戒窗(子窗口)读取主窗写入的值，保证两个窗口主色一致。
export function applyAccent(isPrimary: boolean) {
  if (isPrimary) {
    const color = ACCENTS[Math.floor(Math.random() * ACCENTS.length)]
    localStorage.setItem(KEY, color)
    document.documentElement.style.setProperty('--pink', color)
    return
  }
  const stored = localStorage.getItem(KEY)
  document.documentElement.style.setProperty('--pink', stored ?? ACCENTS[0])
}
