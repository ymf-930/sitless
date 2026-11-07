import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'
import { Button } from './ui/controls'
import { currentLang, setLangPref, t, useLang } from './i18n'
import { Icon } from './icons'
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

/** 卡片四周的透明边距，给 CSS 阴影留位置 */
const CARD_PAD = 12
/** 轻浮窗自动收起时间，与主窗右上角 toast-card 的 9 秒一致 */
const LIGHT_HIDE_MS = 9000

type Mode = 'light' | 'alert'
type ShowPayload = { mode: Mode; seq: number }
type StatusInfo = {
  confirm_before_rest: boolean
  alert_seconds: number
  language: string
  sitting_ms: number
}

const PARAMS = new URLSearchParams(window.location.search)

/** 按内容把窗口收到最小：卡片多高窗口就多高，圆角正好落在窗口四角 */
async function fitWindow() {
  const el = document.querySelector<HTMLElement>('.alertwin, .lightwin')
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

/** 轻浮窗展示的连续坐姿时长，跟随界面语言 */
function fmtSit(ms: number) {
  const m = Math.max(0, Math.floor(ms / 60000))
  if (currentLang() === 'en') {
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`
  }
  return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

/** 同一个置顶窗按 mode 分两种形态。
 *  首次建窗靠 URL query（WebView 还没挂载，事件会丢），复用窗口靠 alert://show。 */
export default function Alert() {
  useLang()
  const [mode, setMode] = useState<Mode>(() => (PARAMS.get('mode') === 'light' ? 'light' : 'alert'))
  const [seq, setSeq] = useState(() => Number(PARAMS.get('seq') ?? 0))
  const [status, setStatus] = useState<StatusInfo | null>(null)

  useEffect(() => {
    const load = () => {
      invoke<StatusInfo>('status')
        .then((s) => {
          setStatus(s)
          setLangPref(s.language)
        })
        .catch(() => {})
    }
    load()
    const un = listen<ShowPayload>('alert://show', (e) => {
      setMode(e.payload.mode)
      setSeq(e.payload.seq)
      load()
    })
    return () => {
      un.then((f) => f())
    }
  }, [])

  return mode === 'light'
    ? <LightPanel seq={seq} sitting={status?.sitting_ms ?? 0} />
    : <AlertPanel status={status} />
}

/** 轻浮窗：置顶但不抢焦点、固定白底、无倒计时、9 秒自动收起 */
function LightPanel({ seq, sitting }: { seq: number; sitting: number }) {
  const [busy, setBusy] = useState(false)
  // 只有紧跟在真实指针按下之后的点击才认，挡掉窗口显示时被系统补发的伪点击
  const armedAt = useRef(0)

  useEffect(() => {
    const id = window.setTimeout(async () => {
      await fitWindow().catch(() => {})
      await invoke('alert_ready').catch(() => {})
    }, 60)
    return () => window.clearTimeout(id)
  }, [])

  // seq 变化（重申 / 被抢占）会让旧定时器作废；后端还会再校验一次序号
  useEffect(() => {
    const id = window.setTimeout(() => {
      invoke('close_light', { seq }).catch(() => {})
    }, LIGHT_HIDE_MS)
    return () => window.clearTimeout(id)
  }, [seq])

  const act = async (cmd: string) => {
    if (busy || Date.now() - armedAt.current > 5000) return
    setBusy(true)
    await invoke(cmd)
    await invoke('close_alert')
    setBusy(false)
  }

  return (
    <div className="lightwin" onPointerDownCapture={() => { armedAt.current = Date.now() }}>
      <div className="lw-top">
        <div className="lw-ico"><Icon name="alarm" size={16} /></div>
        <div className="lw-titles">
          <b>{t('该起身活动一下了')}</b>
          <span>{t('活动提醒')} · {t('已连续坐 {d}', { d: fmtSit(sitting) })}</span>
        </div>
        <button className="lw-x" aria-label={t('关闭提醒')} onClick={() => invoke('close_alert').catch(() => {})}>
          ×
        </button>
      </div>
      <p>{t('站起来走 1 分钟，或者做两个伸展。点「已起身」会把计时清零。')}</p>
      <div className="lw-acts">
        <Button variant="dark" disabled={busy} onClick={() => act('dismiss')}>
          {t('已起身')}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => act('skip')}>
          {t('跳过')}
        </Button>
      </div>
    </div>
  )
}

/** 警戒窗：抢焦点、随机面板色 / 插画 / 文案、强制倒计时 */
function AlertPanel({ status }: { status: StatusInfo | null }) {
  // 「休息前确认」关掉时不锁按钮；直接派生，避免 effect 里同步 setState
  const total = status ? (status.confirm_before_rest ? status.alert_seconds : 0) : 10
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
    // 首帧后再量：此时图片与字体已参与布局；量完由后端贴右下角并显示窗口
    const id = window.setTimeout(async () => {
      await fitWindow().catch(() => {})
      await invoke('alert_ready').catch(() => {})
    }, 60)
    return () => window.clearTimeout(id)
  }, [])

  useEffect(() => {
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
      un.then((f) => f())
    }
  }, [start])

  const armedAt = useRef(0)

  const act = async (cmd: string, args?: Record<string, unknown>) => {
    if (busy) return
    if (Date.now() - armedAt.current > 5000) {
      diag(`ignored ${cmd}: no recent pointerdown`)
      return
    }
    setBusy(true)
    diag(`act ${cmd}`)
    await invoke(cmd, args)
    await invoke('close_alert')
    setBusy(false)
  }

  const ready = left === 0
  const cdTicks = Math.max(1, Math.min(total, 20))
  const cdLit = Math.ceil((left / Math.max(1, total)) * cdTicks)

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
        {!ready && total > 0 && (
          <div className="cd-ticks" aria-hidden="true">
            {Array.from({ length: cdTicks }, (_, i) => (
              <i key={i} className={i < cdLit ? 'on' : ''} />
            ))}
          </div>
        )}
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
