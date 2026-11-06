/**
 * 插画池：3D 人物素材按用途分两套，避免同一屏里重复出现同一个人。
 * 圆环卡用「坐姿 / 工位」，活动提醒与警戒窗用「起身 / 走动」。
 */

const RING = [
  '/art/ring-1.png',
  '/art/ring-2.png',
  '/art/ring-3.png',
  '/art/ring-4.png',
  '/art/ring-5.png',
]

const ACT = [
  '/art/art-1.png',
  '/art/art-2.png',
  '/art/art-3.png',
  '/art/art-4.png',
  '/art/art-5.png',
  '/art/art-6.png',
  '/art/art-7.png',
  '/art/art-8.png',
  '/art/art-9.png',
]

function pick(pool: string[], exclude?: string): string {
  const list = exclude && pool.length > 1 ? pool.filter((p) => p !== exclude) : pool
  return list[Math.floor(Math.random() * list.length)]
}

let ring: string | null = null
let activity: string | null = null

/** 计时圆环卡：一次启动内不变 */
export function ringArt(): string {
  if (!ring) ring = pick(RING)
  return ring
}

/** 活动提醒卡：一次启动内不变 */
export function activityArt(): string {
  if (!activity) activity = pick(ACT)
  return activity
}

/** 警戒窗：每次弹出重取，传上一条可避免连续撞图 */
export function pickAlertArt(exclude?: string): string {
  return pick(ACT, exclude)
}
