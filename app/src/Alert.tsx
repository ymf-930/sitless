import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'
import { Button } from './ui/controls'
import { setLangPref, t, useLang } from './i18n'
import { pickAlertArt } from './art'
import { randomAccent, tintAccent } from './accent'

const diag = (msg: string) => { invoke('diag', { msg }).catch(() => {}) }

/** 警戒文案池：标题 + 一句说明成对出现，每次弹窗换一组，别每回都是同一句 */
const LINES: [string, string][] = [
  ['起来走两步', '你已连续坐了很久。'],
  ['该活动一下了', '肩颈和腰都该换个姿势。'],
  ['站起来伸个懒腰', '连续坐太久，注意力也会变差。'],
  ['走两分钟再回来', '起身活动一下，血液循环会好很多。'],
  ['别把身体当耗材', '公司是老板的，身体是自己的。'],
  ['起来接杯水', '顺便让眼睛也看看远处。'],
  ['肩颈在报警', '转两圈脖子，比贴膏药管用。'],
  ['腰先撑不住了', '站起来动一动，比硬扛划算。'],
  ['屏幕看太久了', '抬头看看窗外，眼睛也要喘口气。'],
  ['颈椎想放假', '扶着椅背，慢慢转两圈肩膀。'],
  ['起身倒杯热的', '顺便把小腿活动开。'],
  ['坐满这一节了', '站起来伸伸腿，别让血都憋在腰上。'],
  ['身体不是工位', '椅子坐久了，腰在替你付账。'],
  ['还有下半场', '现在动两分钟，晚上还留得住精神。'],
  ['给腰放个假', '它已经替你扛了一上午。'],
  ['别等疼了才动', '久坐的账，最后都要还。'],
]

/** 卡片四周的透明边距，给 CSS 阴影留位置；与 index.css 的 --alert-pad 保持一致 */
const CARD_PAD = 12

/** 按内容把窗口收到最小：卡片多高窗口就多高，圆角正好落在窗口四角 */
async function fitWindow() {
  const el = document.querySelector<HTMLElement>('.alertwin')
  if (!el) return
  const win = getCurrentWindow()
  const prev = el.style.minHeight
  el.style.minHeight = '0' // min-height 会兜住高度，量不出真实内容高度
  const height = Math.ceil(el.getBoundingClientRect().height)
  el.style.minHeight = prev
  if (height < 120) return
  const { width, height: cur } = await win.innerSize()
  const scale = await win.scaleFactor()
  const cap = Math.min(window.screen.availHeight - 120, 720)
  const target = Math.min(height + CARD_PAD * 2, cap)
  if (Math.abs(cur / scale - target) > 2) {
    await win.setSize(new LogicalSize(width / scale, target))
  }
  await invoke('alert_reposition').catch(() => {})
}

export default function Alert() {
  useLang()
  const [total, setTotal] = useState(10)
  const [left, setLeft] = useState(10)
  const [busy, setBusy] = useState(false)
  const [art, setArt] = useState(() => pickAlertArt())
  const [color, setColor] = useState(() => randomAccent())
  const [line, setLine] = useState(() => Math.floor(Math.random() * LINES.length))
  const timer = useRef<number | undefined>(undefined)

  // 警戒窗用自己的随机主色，不跟随主窗；每次弹出换一个。
  // 颜色落在整块面板上（而不是标签），所以按比例混到米白里，避免太扎眼。
  useEffect(() => {
    document.documentElement.style.setProperty('--pink', color)
    document.documentElement.style.setProperty('--alert-bg', tintAccent(color))
  }, [color])

  const start = useCallback(() => {
    window.clearInterval(timer.current)
    setLeft(total)
    if (total === 0) return
    timer.current = window.setInterval(() => {
      setLeft((v) => {
        if (v <= 1) {
          window.clearInterval(timer.current)
          return 0
        }
        return v - 1
      })
    }, 1000)
  }, [total])

  useEffect(() => {
    // 「休息前确认」关掉时，警戒窗不锁按钮
    invoke<{ confirm_before_rest: boolean; alert_seconds: number; language: string }>('status')
      .then((s) => {
        setTotal(s.confirm_before_rest ? s.alert_seconds : 0)
        setLangPref(s.language)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    // 首帧后再量：此时图片与字体已参与布局；量完由后端贴右下角并显示窗口
    const id = window.setTimeout(async () => {
      await fitWindow().catch(() => {})
      await invoke('alert_ready').catch(() => {})
    }, 60)
    return () => window.clearTimeout(id)
  }, [])

  useEffect(() => {
    const onDown = (e: PointerEvent) =>
      diag(`pointerdown x=${Math.round(e.clientX)} y=${Math.round(e.clientY)} trusted=${e.isTrusted}`)
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      diag(`click tag=${target.tagName} text=${(target.textContent || '').slice(0, 8)} trusted=${e.isTrusted}`)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('click', onClick, true)
    diag('alert mounted')
    start()
    const un = listen('alert://reset', () => {
      setBusy(false)
      // 每次弹出换一张插画、一个主色和一组文案
      setArt((prev) => pickAlertArt(prev))
      setColor((prev) => randomAccent(prev))
      setLine((prev) => (prev + 1 + Math.floor(Math.random() * (LINES.length - 1))) % LINES.length)
      start()
    })
    return () => {
      window.clearInterval(timer.current)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('click', onClick, true)
      un.then((f) => f())
    }
  }, [start])

  // 只有紧跟在真实指针按下之后的点击才认，挡掉窗口显示时被系统补发的伪点击
  const armedAt = useRef(0)

  const act = async (cmd: string, args?: Record<string, unknown>) => {
    if (busy) return
    if (Date.now() - armedAt.current > 5000) {
      diag(`ignored ${cmd}: no recent pointerdown`)
      return
    }
    setBusy(true)
    console.log('act', cmd, JSON.stringify(args ?? {}))
    await invoke(cmd, args)
    await invoke('close_alert')
    setBusy(false)
  }

  const ready = left === 0

  return (
    <div className="alertwin" onPointerDownCapture={() => { armedAt.current = Date.now() }}>
      <button
        className="alert-close"
        title={t('跳过本次（关闭）')}
        aria-label={t('跳过本次并关闭')}
        disabled={busy}
        onClick={() => act('skip')}
      >
        ×
      </button>

      <span className="alert-tag">{t('久坐警戒')}</span>

      <img className="alert-art" src={art} alt="" />

      <h1>{t(LINES[line][0])}</h1>
      <p className="alert-sub">{t(LINES[line][1])}</p>

      <div className="cd">
        <div className="cd-bar">
          <i style={{ width: `${total > 0 ? (left / total) * 100 : 0}%` }} />
        </div>
        <div className="cd-text">
          {ready ? t('可以清零重计了') : (
            <>
              <b>{left}</b> {t('秒后可清零重计，也可直接暂停或跳过')}
            </>
          )}
        </div>
      </div>

      <div className="alert-acts">
        <Button variant="dark" disabled={!ready || busy} onClick={() => act('dismiss')}>
          {t('已起身，清零重计')}
        </Button>
        {/* 右上角 × 随时可跳过；倒计时只锁「已起身，清零重计」，
            暂停也是主动的自我限制（15 分钟后照常提醒），不跟倒计时一起锁 */}
        <Button variant="ghost" disabled={busy} onClick={() => act('pause', { minutes: 15 })}>
          {t('暂停 15 分钟')}
        </Button>
      </div>
    </div>
  )
}
