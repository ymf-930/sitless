import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'
import { Button } from './ui/controls'
import { setLangPref, t, useLang } from './i18n'

const diag = (msg: string) => { invoke('diag', { msg }).catch(() => {}) }

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
  const timer = useRef<number | undefined>(undefined)

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

      <img className="alert-art" src="/alert-art.png" alt="" />

      <h1>{t('起来走两步')}</h1>
      <p className="alert-sub">
        {total > 0
          ? t('倒计时结束前不能清零重计；赶时间可以跳过或暂停。')
          : t('你已连续坐了很久。')}
      </p>

      <div className="cd">
        <div className="cd-bar">
          <i style={{ width: `${total > 0 ? (left / total) * 100 : 0}%` }} />
        </div>
        <div className="cd-text">
          {ready ? t('可以清零重计了') : (
            <>
              <b>{left}</b> {t('秒后可清零重计')}
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
