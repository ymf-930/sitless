import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Button, Stepper, Switch } from './ui/controls'
import { listen, emit } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Icon, type IconName } from './icons'
import { currentLang, t, useLang, setLangPref } from './i18n'
import { activityArt, ringArt } from './art'

type RemindState = 'on' | 'paused' | 'offday' | 'quiet' | 'fullscreen' | 'away'

type Status = {
  idle_threshold_ms: number
  sitting_ms: number
  next_alert_ms: number
  next_activity_ms: number
  alert_threshold_ms: number
  activity_interval_ms: number
  repeat_interval_ms: number
  repeat_limit: number
  daily_goal: number
  workdays: number
  quiet: string[]
  confirm_before_rest: boolean
  alert_seconds: number
  reminder_style: number
  action_beep: boolean
  tone: number
  sound_on: boolean
  volume: number
  paused: boolean
  present: boolean
  language: string
  fullscreen_suppress: boolean
  remind_state: RemindState
  resume_hint: string
}

type TodayData = {
  day: string
  sitting_ms: number
  longest_ms: number
  segments: number
  reminders: number
}
type DayRow = {
  day: string
  sitting_ms: number
  longest_ms: number
  segments: number
  rises: number
  reminders: number
}
type SegRow = {
  started_at: string
  sitting_ms: number
  closed: boolean
  /** away / dismiss → 真的起身；midnight / exit 只是结算；空为旧数据 */
  end_reason?: string
}

/** 只有真的站起来才算一次「起身」；跨零点与退出结算只是落库 */
const RISE_REASONS = ['away', 'dismiss', 'unknown', '']
const isRise = (s: SegRow) => s.closed && RISE_REASONS.includes(s.end_reason ?? '')

const DEMO = new URLSearchParams(window.location.search).get('demo') === '1'
/** 设计稿预览：?demo=1&state=offday|quiet|paused|away 直接验收非提醒状态 */
const DEMO_STATE = (new URLSearchParams(window.location.search).get('state') ?? 'on') as RemindState
/** ?demo=1&hint=off 直接验收「首启说明已读」后的连胜 / 洞察状态行 */
const DEMO_HINT_OFF = new URLSearchParams(window.location.search).get('hint') === 'off'

const EMPTY_STATUS: Status = {
  idle_threshold_ms: 180000,
  sitting_ms: 0,
  remind_state: 'on',
  resume_hint: '',
  next_alert_ms: 0,
  next_activity_ms: 0,
  alert_threshold_ms: 7200000,
  activity_interval_ms: 2700000,
  repeat_interval_ms: 300000,
  repeat_limit: 3,
  daily_goal: 8,
  workdays: 0b00111111,
  quiet: ['12:00-13:30'],
  confirm_before_rest: true,
  alert_seconds: 10,
  reminder_style: 0,
  action_beep: false,
  tone: 2,
  sound_on: true,
  volume: 62,
  paused: false,
  present: true,
  language: 'auto',
  fullscreen_suppress: true,
}

/** 浏览器里用 ?demo=1 预览设计稿效果，后端可用时完全不生效 */
const DEMO_STATUS: Status = {
  idle_threshold_ms: 3 * 60000,
  sitting_ms: 42 * 60000,
  remind_state: DEMO_STATE,
  resume_hint: DEMO_STATE === 'quiet' ? '13:30' : '',
  next_alert_ms: 18 * 60000,
  next_activity_ms: 12 * 60000,
  alert_threshold_ms: 60 * 60000,
  activity_interval_ms: 30 * 60000,
  repeat_interval_ms: 5 * 60000,
  repeat_limit: 3,
  daily_goal: 8,
  workdays: 0b00111111,
  quiet: ['12:00-13:30'],
  confirm_before_rest: true,
  alert_seconds: 10,
  reminder_style: 0,
  action_beep: false,
  tone: 2,
  sound_on: true,
  volume: 62,
  paused: false,
  present: true,
  language: 'auto',
  fullscreen_suppress: true,
}

const DEMO_TODAY: TodayData = {
  day: todayIso(),
  sitting_ms: 3 * 3600000 + 42 * 60000,
  longest_ms: 3600000 + 18 * 60000,
  segments: 4,
  reminders: 6,
}

/**
 * 演示段：最新一段是进行中的 42 分钟（和 DEMO_STATUS.sitting_ms 一致），
 * 各段时长合计 3h42m、最长 1h18m，跟 DEMO_TODAY 与圆环对得上。
 * 起点按当前时间倒推，段与段首尾相接，时间线里的时间戳才不会自相矛盾。
 */
const DEMO_SEGS: SegRow[] = (() => {
  const p = (n: number) => String(n).padStart(2, '0')
  const iso = (ts: number) => {
    const d = new Date(ts)
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }
  const spans = [
    { min: 42, closed: false, reason: 'open' },
    { min: 78, closed: true, reason: 'away' },
    { min: 60, closed: true, reason: 'dismiss' },
    { min: 42, closed: true, reason: 'away' },
  ]
  const now = Date.now()
  let elapsed = 0
  return spans.map((s) => {
    // 本段起点 = 现在 - 本段及其之后所有段的时长，段与段首尾相接
    const row: SegRow = {
      started_at: iso(now - (elapsed + s.min) * 60000),
      sitting_ms: s.min * 60000,
      closed: s.closed,
      end_reason: s.reason,
    }
    elapsed += s.min
    return row
  })
})()

const DEMO_DAYS: DayRow[] = lastDays(60).map((day, i) => ({
  day,
  sitting_ms: [5.2, 6.8, 4.1, 7.3, 6, 3.4, 3.7][i % 7] * 3600000,
  longest_ms: [1.2, 2.1, 0.9, 2.2, 1.6, 0.8, 1.3][i % 7] * 3600000,
  segments: [6, 9, 4, 11, 8, 3, 5][i % 7],
  rises: [5, 8, 3, 10, 7, 2, 4][i % 7],
  reminders: [4, 6, 3, 7, 5, 2, 3][i % 7],
}))

/** 演示模式下的时段分布，24 个小时桶（分钟 → 毫秒） */
const DEMO_HOURLY: number[] = [
  0, 0, 0, 0, 0, 0, 0,
  12, 38, 52, 58, 44, 20, 55,
  62, 48, 39, 30, 18, 8, 3,
  1, 0, 0,
].map((v) => v * 60000)

/**
 * 时段热力色阶：糖果色相（浅蓝 → 薄荷 → 蜜黄 → 粉），第 0 档是「无记录」。
 * 四档明度依次压低（约 89% / 85% / 82% / 74%）：四个糖果色亮度几乎相同的话，
 * 暖白底上「越深越久」就读不出来。薄荷替代纯绿，避开界面里「已完成」的语义。
 * 分档阈值按当前区间峰值取整后四等分（见 hourEdges），不写死分钟数：
 * 真实数据里单小时很少坐满 45 分钟，写死会让最深的颜色永远用不上。
 */
const HOUR_HEAT = ['#EDEAE3', '#D5E6F6', '#C3E6D6', '#EFCF92', '#EAA6B8']

/** 峰值向上取整到 5 分钟，最少按 20 分钟铺满四档，避免分钟级抖动导致整条重排 */
function hourEdges(peakMs: number): number[] {
  const step = 5 * 60000
  const base = Math.max(20 * 60000, Math.ceil(peakMs / step) * step)
  return [1, 2, 3].map((i) => Math.round((base * i) / 4 / 60000) * 60000)
}

function hm(ms: number) {
  if (ms > 0 && ms < 60000) return t('不到 1 分钟')
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  if (currentLang() === 'en') return h > 0 ? `${h}h ${m}m` : `${m}m`
  if (h <= 0) return `${m} 分钟`
  return `${h} 小时 ${m} 分`
}

function minutes(ms: number) {
  return Math.max(0, Math.round(ms / 60000))
}

/**
 * 活动提醒进度格：按间隔选粒度，让格数稳定在 7–15 根。
 * 一格一分钟只在小间隔下可读，45 分钟会变成 45 根细条，120 分钟连间距都放不下。
 */
function segSpec(intervalMin: number) {
  const unit = intervalMin <= 15 ? 1 : intervalMin <= 30 ? 2 : intervalMin <= 60 ? 5 : 10
  return { unit, count: Math.max(1, Math.ceil(intervalMin / unit)) }
}

function weekday(iso: string) {
  const d = new Date(`${iso}T00:00:00`)
  return [t('周日'), t('周一'), t('周二'), t('周三'), t('周四'), t('周五'), t('周六')][d.getDay()]
}

function todayIso() {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function clockOf(iso: string) {
  const i = iso.indexOf('T')
  return i >= 0 ? iso.slice(i + 1, i + 6) : iso
}

function shortDur(ms: number) {
  if (ms <= 0) return ''
  return ms >= 3600000 ? `${(ms / 3600000).toFixed(1)}h` : `${Math.round(ms / 60000)}m`
}

/** 图例刻度用：整小时不显示 .0（30 天视图的累加值会到几小时） */
function bandLabel(ms: number) {
  if (ms >= 3600000) return `${(ms / 3600000).toFixed(1).replace(/\.0$/, '')}h`
  return `${Math.round(ms / 60000)}m`
}

function lastDays(n: number) {
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const p = (x: number) => String(x).padStart(2, '0')
    out.push(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`)
  }
  return out
}

function dateLabel(iso: string) {
  const p = iso.split('-')
  if (currentLang() === 'en') return `${weekday(iso)} · ${Number(p[1])}/${Number(p[2])}`
  return `${weekday(iso)} · ${Number(p[1])} 月 ${Number(p[2])} 日`
}

/** 统计块里的紧凑时长：3h42 / 16m */
function compact(ms: number) {
  const h = Math.floor(ms / 3600000)
  const m = Math.round((ms % 3600000) / 60000)
  return h > 0
    ? { lead: String(h), unit: 'h', tail: String(m).padStart(2, '0') }
    : { lead: String(m), unit: 'm', tail: '' }
}

/** 连续达标天数：只数已经走完的日子，从最近一天倒着数。今日页与历史页共用，避免两处口径不一致 */
function streakOf(days: DayRow[], goal: number) {
  let n = 0
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].rises >= goal) n++
    else break
  }
  return n
}

function usedDays() {
  const key = 'sitless.first-day'
  let first = localStorage.getItem(key)
  if (!first) {
    first = todayIso()
    localStorage.setItem(key, first)
  }
  const a = new Date(`${first}T00:00:00`).getTime()
  const b = new Date(`${todayIso()}T00:00:00`).getTime()
  return Math.max(1, Math.round((b - a) / 86400000) + 1)
}

/** 音色试听：纯前端合成，参数对齐 scripts/make_sounds.py；仅演示模式用，真实运行走 preview_tone */
function previewTone(tone: number, volume: number) {
  if (volume <= 0 || !window.AudioContext) return
  const specs = [
    { type: 'sine' as OscillatorType, freq: 523.25, dur: 0.7, decay: 0.3, attack: 0.004, glide: 0 },
    { type: 'sine' as OscillatorType, freq: 659.25, dur: 1.0, decay: 0.45, attack: 0.002, glide: 0, echo: 523.25 },
    { type: 'sine' as OscillatorType, freq: 587.33, dur: 0.55, decay: 0.2, attack: 0.03, glide: 0 },
  ]
  const spec = specs[tone] ?? specs[0]
  const ctx = new window.AudioContext()
  const gain = ctx.createGain()
  const now = ctx.currentTime
  const level = Math.max(0.001, (volume / 100) * 0.16)

  const strike = (freq: number, at: number, dur: number) => {
    const osc = ctx.createOscillator()
    osc.type = spec.type
    osc.frequency.setValueAtTime(freq, now + at)
    if (spec.glide) osc.frequency.exponentialRampToValueAtTime(spec.glide, now + at + 0.04)
    osc.connect(gain)
    osc.start(now + at)
    osc.stop(now + at + dur)
  }
  if (spec.echo) strike(spec.echo, 0.3, spec.dur - 0.3)
  strike(spec.freq, 0, spec.dur)

  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(level, now + Math.max(0.01, spec.attack))
  gain.gain.exponentialRampToValueAtTime(0.0001, now + spec.dur)
  gain.connect(ctx.destination)
  window.setTimeout(() => void ctx.close(), (spec.dur + 0.2) * 1000)
}

/**
 * 容器还能往下滚时把 is-more 挂到元素上，样式据此做底边渐隐。
 * 滚动条藏掉之后，这是「下面还有内容」的唯一提示；滚到底或内容没溢出时自动撤掉，
 * 否则卡片少的时候也会把最后一张的底边淡掉。
 */
function useScrollHint<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  const [more, setMore] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const sync = () => setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 2)
    sync()
    el.addEventListener('scroll', sync, { passive: true })
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    // 子节点增删（时间线多一段、逐日明细展开）不会改容器高度，得单独盯
    const mo = new MutationObserver(sync)
    mo.observe(el, { childList: true, subtree: true })
    return () => {
      el.removeEventListener('scroll', sync)
      ro.disconnect()
      mo.disconnect()
    }
  }, [])

  return [ref, more] as const
}

/** 固定间隔轮询，卸载即停；demo 有值时直接返回静态数据 */
function usePoll<T>(
  cmd: string,
  args: Record<string, unknown> | undefined,
  ms: number,
  init: T,
  demo?: T,
) {
  const [v, setV] = useState<T>(demo ?? init)
  // args 是字面量对象，按 JSON 快照复用，避免每次渲染都重建回调
  const argsKey = JSON.stringify(args ?? null)
  const stableArgs = useMemo<Record<string, unknown> | undefined>(
    () => (argsKey === 'null' ? undefined : JSON.parse(argsKey)),
    [argsKey],
  )
  const pull = useCallback(async () => {
    try {
      setV(await invoke<T>(cmd, stableArgs))
    } catch {
      /* 后端未就绪时保留旧值 */
    }
  }, [cmd, stableArgs])
  useEffect(() => {
    if (demo !== undefined) return
    let alive = true
    const run = async () => {
      if (!alive) return
      await pull()
    }
    run()
    const timer = window.setInterval(run, ms)
    const un = listen('data://changed', run)
    return () => {
      alive = false
      window.clearInterval(timer)
      un.then((f) => f())
    }
  }, [pull, ms, demo])
  return [v, pull] as const
}

export default function App() {
  useLang()
  const [view, setView] = useState<View>('today')
  const [status] = usePoll<Status>(
    'status', undefined, 1000, EMPTY_STATUS, DEMO ? DEMO_STATUS : undefined,
  )
  const [today, reloadToday] = usePoll<TodayData>(
    'today',
    undefined,
    15000,
    { day: todayIso(), sitting_ms: 0, longest_ms: 0, segments: 0, reminders: 0 },
    DEMO ? DEMO_TODAY : undefined,
  )
  const [toastAt, setToastAt] = useState(0)

  // 语言偏好存在后端，启动时也从 localStorage 读一次，避免首帧闪中文
  useEffect(() => {
    setLangPref(status.language)
    localStorage.setItem('sitless.language', status.language)
  }, [status.language])

  useEffect(() => {
    const un = listen('reminder://toast', () => setToastAt(Date.now()))
    return () => {
      un.then((f) => f())
    }
  }, [])
  useEffect(() => {
    const un = listen<string>('tray://navigate', (e) => {
      if (e.payload === 'today' || e.payload === 'history' || e.payload === 'settings') {
        setView(e.payload)
      }
    })
    return () => {
      un.then((f) => f())
    }
  }, [])
  useEffect(() => {
    if (!toastAt) return
    const t = window.setTimeout(() => setToastAt(0), 9000)
    return () => window.clearTimeout(t)
  }, [toastAt])

  const act = async (cmd: string, args?: Record<string, unknown>) => {
    if (DEMO) return
    try {
      await invoke(cmd, args)
      reloadToday()
    } catch (e) {
      console.error(e)
    }
  }

  return (
    <div className="app">
      <div className="topbar" data-tauri-drag-region>
        <div className="brand">
          <img src="/logo.png" alt="" />
          <b>{t('走走')}</b>
        </div>
        <div className="topnav">
          <button className={view === 'today' ? 'on' : ''} onClick={() => setView('today')}>
            <Icon name="home" size={15} />
            <span>{t('今日')}</span>
          </button>
          <button className={view === 'history' ? 'on' : ''} onClick={() => setView('history')}>
            <Icon name="chart" size={15} />
            <span>{t('历史')}</span>
          </button>
          <button className={view === 'settings' ? 'on' : ''} onClick={() => setView('settings')}>
            <Icon name="sliders" size={15} />
            <span>{t('设置')}</span>
          </button>
        </div>
        <div className="drag" data-tauri-drag-region />
        <div className="days-tag" title={t('从第一次打开本应用算起')}>
          <Icon name="calendar" size={13} />
          <span>
            {t('第')} <b>{usedDays()}</b> {t('天')}
          </span>
        </div>
        <div className="win-actions">
          <button className="wbtn" title={t('最小化')} onClick={() => getCurrentWindow().minimize()}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M2.5 6h7" />
            </svg>
          </button>
          <button className="wbtn close" title={t('收进托盘')} onClick={() => getCurrentWindow().hide()}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M3 3l6 6M9 3l-6 6" />
            </svg>
          </button>
        </div>
      </div>

      <div className="body">
        {view === 'today' && (
          <TodayView status={status} today={today} act={act} />
        )}
        {view === 'history' && <HistoryView status={status} />}
        {view === 'settings' && <SettingsView status={status} />}
      </div>

      <Dock status={status} act={act} view={view} onNav={setView} />

      {toastAt > 0 && (
        <Toast
          sitting={status.sitting_ms}
          onDone={() => {
            act('dismiss')
            setToastAt(0)
          }}
          onClose={() => setToastAt(0)}
        />
      )}
    </div>
  )
}

/** 右上角轻提醒：只给一个主动作「已起身」；× 只收起卡片，不理它就会按重申节奏再来 */
function Toast({
  sitting,
  onDone,
  onClose,
}: {
  sitting: number
  onDone: () => void
  onClose: () => void
}) {
  return (
    <div className="toast-card">
      <div className="toast-top">
        <div className="toast-ico">
          <Icon name="alarm" size={16} />
        </div>
        <div className="toast-titles">
          <b>{t('该起身活动一下了')}</b>
          <span>{t('已连续坐 {d}', { d: hm(sitting) })}</span>
        </div>
        <button className="toast-x" onClick={onClose} aria-label={t('关闭提醒')}>
          ×
        </button>
      </div>
      <p>{t('站起来走 1 分钟，或者做两个伸展。点「已起身」会把计时清零，先忙就别管它。')}</p>
      <div className="toast-acts">
        <Button variant="dark" onClick={onDone}>
          {t('已起身')}
        </Button>
      </div>
    </div>
  )
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 时间选择：自绘圆角面板，替掉 WebView2 无法用 CSS 定制的原生弹出层。
 *  隐藏的 input 仍是值容器，timeVal() / addQuiet() 的取数逻辑不用改。 */
function TimePicker({ id, defaultValue, label }: { id: string; defaultValue: string; label: string }) {
  const [value, setValue] = useState(defaultValue)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const [hh, mm] = value.split(':').map((v) => Number(v) || 0)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    // 打开时把当前时/分滚到列表中间
    box.current?.querySelectorAll<HTMLElement>('.tp-list').forEach((list) => {
      const on = list.querySelector<HTMLElement>('.is-on')
      if (on) list.scrollTop = Math.max(0, on.offsetTop - list.clientHeight / 2 + on.clientHeight / 2)
    })
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const pick = (h: number, m: number) => {
    const next = `${pad2(h)}:${pad2(m)}`
    setValue(next)
    const input = document.getElementById(id) as HTMLInputElement | null
    if (input) input.value = next
    setOpen(false)
  }

  return (
    <div className="tp" ref={box}>
      <input type="time" id={id} className="tp-native" defaultValue={defaultValue} tabIndex={-1} aria-hidden="true" />
      <button type="button" className="tp-trigger" aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{value}</span>
        <Icon name="clock" size={14} />
      </button>
      {open && (
        <div className="tp-pop">
          <div className="tp-col">
            <div className="tp-col-title">{t('时')}</div>
            <div className="tp-list">
              {Array.from({ length: 24 }, (_, i) => (
                <button type="button" key={i} className={i === hh ? 'is-on' : ''} onClick={() => pick(i, mm)}>{pad2(i)}</button>
              ))}
            </div>
          </div>
          <div className="tp-col">
            <div className="tp-col-title">{t('分')}</div>
            <div className="tp-list">
              {Array.from({ length: 60 }, (_, i) => (
                <button type="button" key={i} className={i === mm ? 'is-on' : ''} onClick={() => pick(hh, i)}>{pad2(i)}</button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

type View = 'today' | 'history' | 'settings'

function Dock({
  status,
  act,
  view,
  onNav,
}: {
  status: Status
  act: (cmd: string, args?: Record<string, unknown>) => void
  view: View
  onNav: (v: View) => void
}) {
  const sound = () => act('update_config', { key: 'sound_on', value: status.sound_on ? '0' : '1' })
  const NAV: { key: View; icon: IconName; title: string }[] = [
    { key: 'today', icon: 'home', title: t('今日') },
    { key: 'history', icon: 'chart', title: t('历史') },
    { key: 'settings', icon: 'sliders', title: t('设置') },
  ]
  return (
    <div className="dock-bar">
      <div className="dock-side left" />

      <div className="dock-wing left" aria-hidden="true" />

      <div className="dock">
        <button
          className="dock-btn is-sky"
          title={status.paused ? t('恢复计时') : t('暂停 15 分钟')}
          onClick={() =>
            act(status.paused ? 'resume' : 'pause', status.paused ? undefined : { minutes: 15 })
          }
        >
          <Icon name={status.paused ? 'play' : 'pause'} size={17} />
        </button>
        <button className="dock-btn is-accent" title={t('已起身，清零重计')} onClick={() => act('dismiss')}>
          <Icon name="check" size={17} />
        </button>
        <button
          className="dock-btn is-pink"
          title={status.sound_on ? t('关闭提示音') : t('开启提示音')}
          onClick={sound}
        >
          <Icon name={status.sound_on ? 'speaker' : 'speakerOff'} size={17} />
        </button>

        <div className="dock-sep" />

        {NAV.map((item) => (
          <button
            key={item.key}
            className={`dock-btn is-nav${view === item.key ? ' is-on' : ''}`}
            title={item.title}
            aria-current={view === item.key ? 'page' : undefined}
            onClick={() => onNav(item.key)}
          >
            <Icon name={item.icon} size={17} />
          </button>
        ))}
      </div>

      <div className="dock-wing right" aria-hidden="true" />

      <div className="dock-side right" />
    </div>
  )
}

type SilentState = Exclude<RemindState, 'on'>

/**
 * 分段环：30 根粗刻度，12 点起顺时针点亮，一段 = 1/30 警戒阈值。
 * 用半透明墨色而不是主题色：卡片底色每次启动都会随机换，对比度不能跟着飘。
 */
const RING_SEGMENTS = 30

/** 不提醒状态下，所有「即将发生」的文案统一换成状态说明 */
const SILENT_COPY: Record<SilentState, { head: string; sub: string; tag: string; body: string }> = {
  paused: {
    head: '提醒已暂停', sub: '久坐仍在累计', tag: '暂停',
    body: '提醒暂不弹出，久坐仍在累计。',
  },
  offday: {
    head: '今天是休息日', sub: '下个工作日自动恢复', tag: '休息日',
    body: '今天不在所选工作日，提醒不会弹出，时长照常记录。',
  },
  quiet: {
    head: '休息时段 · 暂不提醒', sub: '{d} 恢复提醒', tag: '免打扰',
    body: '当前处于休息时段，提醒不会弹出，时长照常记录。',
  },
  fullscreen: {
    head: '全屏中 · 暂不提醒', sub: '退出全屏后汇总补发', tag: '全屏',
    body: '检测到全屏播放，提醒先压住；退出后会补一条汇总，不会连发。',
  },
  away: {
    head: '已离座', sub: '回到座位后继续', tag: '已离座',
    body: '检测到你已离开，计时与提醒都暂时停下。',
  },
}

function TodayView({
  status,
  today,
  act,
}: {
  status: Status
  today: TodayData
  act: (cmd: string, args?: Record<string, unknown>) => void
}) {
  const [segs] = usePoll<SegRow[]>('segments', undefined, 15000, [], DEMO ? DEMO_SEGS : undefined)
  const [trend] = usePoll<DayRow[]>('trend', { days: 8 }, 60000, [], DEMO ? DEMO_DAYS : undefined)
  const [hintDone, setHintDone] = useState(
    () => DEMO ? DEMO_HINT_OFF : localStorage.getItem('sitless.hint-dismissed') === '1',
  )
  const [stageRef, stageMore] = useScrollHint<HTMLDivElement>()
  const [listRef, listMore] = useScrollHint<HTMLDivElement>()
  const state = status.remind_state
  const silent = state !== 'on'
  const copy = silent ? SILENT_COPY[state as SilentState] : null
  const total = Math.max(1, status.alert_threshold_ms)
  const progress = Math.min(1, Math.max(0, status.sitting_ms / total))
  const litSegments = Math.round(progress * RING_SEGMENTS)
  const nextAct = minutes(status.next_activity_ms)
  const actTotal = Math.max(1, minutes(status.activity_interval_ms))
  const { unit: segUnit, count: segCount } = segSpec(actTotal)
  const passed = Math.round(Math.min(1, Math.max(0, 1 - nextAct / actTotal)) * segCount)
  // 圆环读的是内存实时值（每秒刷），时间线读的是库里每分钟一次的快照，
  // 续接上一段时库里还停在旧值。进行中的段一律改用 status.sitting_ms，两处同源。
  // 后端按 started_at DESC 返回：最新一段在前，右栏沿用这个顺序。
  const openIdx = segs.findIndex((s) => !s.closed)
  const liveMs = status.sitting_ms
  const ordered: SegRow[] = segs.map((s, i) =>
    i === openIdx ? { ...s, sitting_ms: liveMs } : s,
  )
  const rises = segs.filter(isRise).length
  const beginAt = ordered.length ? ordered[ordered.length - 1].started_at : null
  const started = beginAt ? clockOf(beginAt) : '—'
  const tones = ['tl-mint', 'tl-sky', 'tl-butter', 'tl-lilac']

  // 首页连胜 / 健康解读只看已经走完的近 7 天，和历史页同口径；今天不参与。
  const on = todayIso()
  const past = lastDays(8)
    .filter((d) => d < on)
    .slice(-7)
    .map((day) => trend.find((r) => r.day === day) ?? {
      day, sitting_ms: 0, longest_ms: 0, segments: 0, rises: 0, reminders: 0,
    })
  const streak = streakOf(past, Math.max(1, status.daily_goal))
  const weekPeak = past.reduce((a, d) => Math.max(a, d.longest_ms), 0)
  const weekDur = compact(weekPeak)
  // 只有真正的新用户才需要规则说明；库里已有记录的老用户直接看数据
  const hasHistory = trend.some((r) => r.day < on && r.sitting_ms > 0)
  const showGuide = !hintDone && (DEMO || !hasHistory)
  const dismissHint = () => {
    if (!DEMO) localStorage.setItem('sitless.hint-dismissed', '1')
    setHintDone(true)
  }

  return (
    <>
      <div className={`stage${stageMore ? ' is-more' : ''}`} ref={stageRef}>
        <header className="head view-head">
          <div>
            <div className="eyebrow">{dateLabel(today.day)}</div>
            <h1>{t('今天坐了 {d}', { d: hm(today.sitting_ms) })}</h1>
            <p className="sub">
              {t('已记录 {a} 段，起身 {b} 次，最长连续 {d}。', {
                a: today.segments,
                b: rises,
                d: hm(today.longest_ms),
              })}
              {copy ? ` ${t(copy.sub, { d: status.resume_hint })}` : ''}
            </p>
            {showGuide && (
              <div className="today-hint is-guide">
                <Icon name="play" size={14} />
                <span>
                  {t('走走已经开始记录：连续坐 {a} 分钟轻提醒一次，{b} 分钟弹出警戒窗。', {
                    a: minutes(status.activity_interval_ms),
                    b: minutes(status.alert_threshold_ms),
                  })}
                </span>
                <button className="hint-x" onClick={dismissHint}>{t('知道了')}</button>
              </div>
            )}
          </div>
        </header>

        <section className={`alert${silent ? ' is-silent' : ''}`}>
          <div className="alert-main">
            <span className="card-eyebrow">
              <Icon name="warning" size={13} />
              {t('久坐警戒 · 阈值 {n} 分钟', { n: minutes(status.alert_threshold_ms) })}
            </span>
            <h2>
              {copy ? (
                <>{t(copy.head)}<br /><em className="state-line">{t(copy.sub, { d: status.resume_hint })}</em></>
              ) : (
                <>{t('还有 {d}', { d: hm(status.next_alert_ms) })}<br />{t('就要打断你了')}</>
              )}
            </h2>
            <p>
              {copy
                ? t(copy.body)
                : <>
                    {t('连续坐满阈值会弹置顶窗，')}
                    {status.confirm_before_rest
                      ? (status.alert_seconds > 0 ? t('{n} 秒后才可关闭。', { n: status.alert_seconds }) : t('出现即可关闭。'))
                      : t('不做强制等待。')}
                  </>}
            </p>
            <div className="pill-row">
              <span className="pill">
                <Icon name="clock" size={12} />
                {t('{d} 开始', { d: started })}
              </span>
              <span className="pill pill-lime">{t('今日第 {n} 段', { n: Math.max(1, today.segments) })}</span>
            </div>
          </div>

          <img className="alert-art" src={ringArt()} alt="" />

          <div className="ring">
            <svg width="140" height="140" viewBox="0 0 124 124" aria-hidden="true">
              {Array.from({ length: RING_SEGMENTS }, (_, i) => {
                const lit = i < litSegments
                // 不提醒时保留累计进度，但压成哑光，别读成「即将触发」
                let stroke = 'rgba(12,12,12,.12)'
                if (lit) stroke = silent ? 'rgba(12,12,12,.32)' : 'rgba(12,12,12,.85)'
                return (
                  <line
                    key={i}
                    x1="62"
                    y1="17"
                    x2="62"
                    y2="8"
                    transform={`rotate(${(i * 360) / RING_SEGMENTS} 62 62)`}
                    stroke={stroke}
                    strokeWidth="5.5"
                    strokeLinecap="round"
                  />
                )
              })}
            </svg>
            <div className="ring-mid">
              <b>{minutes(status.sitting_ms)}</b>
              <span>{t('已坐 · 分钟')}</span>
            </div>
          </div>
        </section>

        <section className={`next${silent ? ' is-silent' : ''}`}>
          <div className="next-main">
            <span className="card-eyebrow">
              <Icon name="alarm" size={13} />
              {t('活动提醒 · 每 {n} 分钟', { n: minutes(status.activity_interval_ms) })}
            </span>
            <h3>{copy ? t('提醒已关闭') : nextAct <= 0 ? t('下一次提醒马上就到') : t('下一次提醒在 {n} 分钟后', { n: nextAct })}</h3>
            <div className="next-meta-row">
              <span className="next-meta">{copy ? t(copy.sub, { d: status.resume_hint }) : t('右上角轻提示，不抢焦点，不响铃打断。')}</span>
              <span className="segs-scale">{t('每格 {n} 分钟', { n: segUnit })}</span>
            </div>
            <div className={`segs${silent ? ' is-silent' : ''}`}>
              {Array.from({ length: segCount }, (_, i) => (
                <i key={i} className={!silent && i < passed ? 'on' : ''} />
              ))}
            </div>
          </div>
          <img className="next-art" src={activityArt()} alt="" />
        </section>

        <div className="tiles tiles-2">
          <div className="tile t-mint">
            <span className="tile-ico">
              <Icon name="check" size={19} />
            </span>
            <b>
              {hasHistory ? streak : '—'}
              {hasHistory && <small>{t('天')}</small>}
            </b>
            <span>{t('连续达标')}</span>
            <em className="tile-tag">
              {hasHistory
                ? t('每日目标 {n} 次起身', { n: status.daily_goal })
                : t('满 1 天后开始统计')}
            </em>
          </div>
          <div className="tile t-sky">
            <span className="tile-ico">
              <Icon name="chart" size={19} />
            </span>
            <b>
              {weekPeak > 0 ? weekDur.lead : '—'}
              {weekPeak > 0 && <><small>{weekDur.unit}</small>{weekDur.tail}</>}
            </b>
            <span>{t('近 7 天最长连续')}</span>
            <em className="tile-tag">
              {weekPeak > 0
                ? t('今天最长 {d}', { d: hm(today.longest_ms) })
                : t('满 1 天后开始统计')}
            </em>
          </div>
        </div>
      </div>

      <aside className="side side-today">
        <div className="side-head">
          <h2>{t('今日时间线')}</h2>
        </div>

        {copy && (
          <div className="tl-state">
            <Icon
              name={
                state === 'paused'
                  ? 'pause'
                  : state === 'away'
                    ? 'person'
                    : state === 'fullscreen'
                      ? 'warning'
                      : 'clock'
              }
              size={14}
            />
            <b>{t(copy.tag)}</b>
            <span>{t(copy.sub, { d: status.resume_hint })}</span>
            {state === 'paused' && (
              <button onClick={() => act('resume')}>{t('恢复计时')}</button>
            )}
          </div>
        )}

        <div className={`timeline${listMore ? ' is-more' : ''}`} ref={listRef}>
          {ordered.length === 0 ? (
            <p className="note">{t('还没有记录，坐一会儿就有了。')}</p>
          ) : (
            ordered.map((s, i) => {
              // 进行中段始终显示「进行中 + 时长」，别被当成今天第一段
              const isLive = !s.closed && i === openIdx
              const isBegin = !isLive && s.started_at === beginAt
              const rise = isRise(s)
              const kind = isBegin ? t('开始') : rise ? t('已起身') : s.closed ? t('已结算') : t('进行中')
              const icon: IconName = isBegin ? 'play' : rise ? 'check' : 'clock'
              const footIcon: IconName = isBegin ? 'chart' : 'clock'
              return (
                <div className={`tl-item ${tones[i % tones.length]}`} key={s.started_at}>
                  <div className="tl-top">
                    <span className="tl-ico">
                      <Icon name={icon} size={14} />
                    </span>
                    <b>{kind}</b>
                    <span className="tl-time">{clockOf(s.started_at)}</span>
                  </div>
                  <p>
                    {isBegin
                      ? t('今天的第一段从这里开始。')
                      : s.closed
                        ? t('这一段连续坐了 {d}。', { d: hm(s.sitting_ms) })
                        : t('这一段已经 {d}，计时未中断。', { d: hm(s.sitting_ms) })}
                  </p>
                  <div className="tl-foot">
                    <Icon name={footIcon} size={11} />
                    {isBegin ? t('已记录 {n} 段', { n: segs.length }) : s.closed ? t('计时已归零') : t('未计入起身')}
                  </div>
                </div>
              )
            })
          )}
        </div>

        <div className="goal">
          <div className="goal-top">
            <span className="tl-ico">
              <Icon name="person" size={15} />
            </span>
            <b>{t('今日起身目标')}</b>
            <span>
              {rises} / {status.daily_goal}
            </span>
          </div>
          <div className="goal-blocks">
            {Array.from({ length: Math.min(status.daily_goal, 30) }, (_, i) => (
              <i key={i} className={i < rises ? 'done' : 'todo'} />
            ))}
          </div>
        </div>
      </aside>
    </>
  )
}

type Metric = 'sitting' | 'longest' | 'rises'

const METRIC_KEYS: { key: Metric; label: string }[] = [
  { key: 'sitting', label: '总时长' },
  { key: 'longest', label: '最长连续' },
  { key: 'rises', label: '起身次数' },
]

const EMPTY_DAY: Omit<DayRow, 'day'> = {
  sitting_ms: 0,
  longest_ms: 0,
  segments: 0,
  rises: 0,
  reminders: 0,
}

function HistoryView({ status }: { status: Status }) {
  const [range, setRange] = useState<7 | 30>(7)
  const [metric, setMetric] = useState<Metric>('sitting')
  const [picked, setPicked] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  // 取 range*2 天：后一半是当前周期，前一半是环比对照周期
  const [rows] = usePoll<DayRow[]>('trend', { days: range * 2 }, 30000, [], DEMO ? DEMO_DAYS : undefined)
  const [hourly] = usePoll<number[]>('hourly', { days: range }, 60000, Array(24).fill(0), DEMO ? DEMO_HOURLY : undefined)
  const [stageRef, stageMore] = useScrollHint<HTMLDivElement>()

  const on = todayIso()
  const all = lastDays(range * 2).map((day) => {
    const hit = rows.find((r) => r.day === day)
    return hit ?? { day, ...EMPTY_DAY }
  })
  // 柱图展示含今天的窗口；统计（日均 / 达标 / 环比）只用已经走完的日子，
  // 否则上午看历史会得出「比上周期少坐 5 小时」这种假结论。
  const days = all.slice(range)
  const done = all.filter((d) => d.day < on)
  // 统计只用窗口里已经走完的日子；对照周期取同样长度，保证两边可比
  const cur = days.filter((d) => d.day < on)
  const prev = done.slice(-(cur.length * 2), -cur.length)

  const sum = (arr: DayRow[], f: (d: DayRow) => number) => arr.reduce((a, d) => a + f(d), 0)
  const curTotal = sum(cur, (d) => d.sitting_ms)
  const prevTotal = sum(prev, (d) => d.sitting_ms)
  const active = cur.filter((d) => d.sitting_ms > 0)
  // 日均只除以「有记录的日子」：没开机的日子是「没数据」，不是「0 分钟」，
  // 拿它做分母会把 1 天的数据摊成「日均 1 分钟」。卡片标签同时写明有记录几天，读者能自己核对。
  const avg = active.length ? curTotal / active.length : 0
  const longestPeak = cur.reduce((a, d) => Math.max(a, d.longest_ms), 0)
  const goal = Math.max(1, status.daily_goal)
  const okDays = cur.filter((d) => d.rises >= goal).length

  const streak = streakOf(cur, goal)

  const diff = curTotal - prevTotal
  const flat = Math.abs(diff) < 60000
  const parts: string[] = []
  if (prevTotal > 0) {
    parts.push(flat
      ? t('与上一周期基本持平')
      : diff <= 0
        ? t('比上一周期少坐 {d}', { d: hm(-diff) })
        : t('比上一周期多坐 {d}', { d: hm(diff) }))
  }
  if (streak > 0) parts.push(t('连续 {n} 天达标', { n: streak }))
  const insight = active.length === 0
    ? t('还没有足够的数据。')
    : parts.length > 0 ? parts.join(' · ') : t('暂无对比数据')

  const val = (d: DayRow) =>
    metric === 'sitting' ? d.sitting_ms : metric === 'longest' ? d.longest_ms : d.rises
  const peakVal = Math.max(0, ...days.map(val))
  const max = metric === 'rises'
    ? Math.max(4, peakVal)
    : Math.max(15 * 60000, Math.ceil(peakVal / (15 * 60000)) * 15 * 60000)
  const fmtBar = (v: number) => (metric === 'rises' ? String(v) : shortDur(v))

  const hasHour = hourly.some((v) => v > 0)
  const peakHour = hourly.indexOf(Math.max(...hourly))
  const edges = hourEdges(Math.max(0, ...hourly))
  const heat = (ms: number) => {
    if (ms <= 0) return HOUR_HEAT[0]
    const band = edges.filter((e) => ms > e).length
    return HOUR_HEAT[band + 1]
  }
  // 阈值用短时长格式（16m / 4.6h）：30 天视图的累加值会到几百分钟，写成「≤320 分」没法读
  const heatLabels = [t('无记录'), ...edges.map((e) => `≤${bandLabel(e)}`), `>${bandLabel(edges[2])}`]
  const visible = showAll ? [...days].reverse() : [...days].reverse().slice(0, 10)

  const toggle = (day: string) => setPicked(picked === day ? null : day)

  return (
    <>
      <div className={`stage${stageMore ? ' is-more' : ''}`} ref={stageRef}>
        <header className="head hist-head">
          <div>
            <div className="eyebrow">
              {t('最近 {n} 天', { n: range })}
              {active.length > 0 && active.length < cur.length
                ? ` · ${t('{n} 天有记录', { n: active.length })}`
                : ''}
            </div>
            <h1>{t('日均 {d}', { d: hm(avg) })}</h1>
            <p className="sub">{insight}</p>
          </div>
          <div className="seg-ctrl hist-range">
            {[7, 30].map((n) => (
              <button
                key={n}
                className={range === n ? 'is-on' : ''}
                onClick={() => { setRange(n as 7 | 30); setPicked(null); setShowAll(false) }}
              >
                {t('{n} 天', { n })}
              </button>
            ))}
          </div>
        </header>

        <div className={`card hist-chart-card${range === 30 ? ' is-wide' : ''}`}>
          <div className="hist-metrics">
            {METRIC_KEYS.map((m) => (
              <button key={m.key} className={metric === m.key ? 'is-on' : ''} onClick={() => setMetric(m.key)}>
                {t(m.label)}
              </button>
            ))}
          </div>
          <div className="chart">
            <div className="chart-plot">
              {days.map((r) => {
                const v = val(r)
                const empty = v === 0
                const pct = empty ? 0 : Math.max(4, (v / max) * 88)
                return (
                  <div
                    className={`col${r.day === on ? ' on' : ''}${picked === r.day ? ' is-picked' : ''}`}
                    key={r.day}
                    onClick={() => toggle(r.day)}
                  >
                    <div className="barbox">
                      <b>{empty ? '' : fmtBar(v)}</b>
                      {empty ? null : <div className="bar" style={{ height: `${pct}%` }} />}
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="chart-axis">
              {days.map((r) => {
                // 30 天视图只露每 5 天的刻度；带上月份，否则跨月时「30 → 05」读不出是几月
                const label = range === 30
                  ? (Number(r.day.slice(8)) % 5 === 0 || r.day === on
                    ? `${Number(r.day.slice(5, 7))}/${Number(r.day.slice(8))}`
                    : '')
                  : weekday(r.day)
                return (
                  <i
                    key={r.day}
                    className={`${r.day === on ? 'on' : ''}${picked === r.day ? ' is-picked' : ''}`}
                    onClick={() => toggle(r.day)}
                  >
                    {label}
                  </i>
                )
              })}
            </div>
          </div>
        </div>

        <div className="tiles tiles-history">
          <div className="tile t-mint">
            <b>{hm(curTotal)}</b>
            <span>{t('{n} 天合计', { n: cur.length })}</span>
            <em className="tile-tag">{t('日均 {d}', { d: hm(avg) })}</em>
          </div>
          <div className="tile t-sky">
            <b>{longestPeak > 0 ? hm(longestPeak) : '—'}</b>
            <span>{t('最长连续')}</span>
            <em className="tile-tag">{t('单次没起身的最久一段')}</em>
          </div>
          <div className="tile t-butter">
            <b>{okDays} / {cur.length}</b>
            <span>{t('达标天数')}</span>
            <em className="tile-tag">{t('目标 每天 {n} 次起身', { n: goal })}</em>
          </div>
          <div className="tile t-pink">
            <b>{prevTotal > 0 ? (flat ? '→ 0%' : `${diff <= 0 ? '↓' : '↑'} ${Math.round(Math.abs(diff) / prevTotal * 100)}%`) : '—'}</b>
            <span>{t('环比上一周期')}</span>
            <em className="tile-tag">
              {prevTotal > 0
                ? (flat
                  ? t('基本持平')
                  : diff <= 0 ? t('少坐 {d}', { d: hm(-diff) }) : t('多坐 {d}', { d: hm(diff) }))
                : t('暂无对比数据')}
            </em>
          </div>
        </div>

        <div className="card hour-card">
          <div className="hour-top">
            <h3>{t('时段分布')}</h3>
            <span>{t('哪几个小时坐得最久（不含今天）')}</span>
            <div className="hour-legend">
              {heatLabels.map((label, i) => (
                <span key={i}><i style={{ background: HOUR_HEAT[i] }} />{label}</span>
              ))}
            </div>
          </div>
          <div className="hour-bars">
            {hourly.map((ms, h) => (
              <i
                key={h}
                className="hour-cell"
                style={{ background: heat(ms) }}
                title={`${h}:00–${(h + 1) % 24}:00 · ${t('累计 {d}', { d: hm(ms) })}`}
              />
            ))}
          </div>
          <div className="hour-axis">
            <span>0:00</span><span>6:00</span><span>12:00</span><span>18:00</span><span>23:00</span>
          </div>
          <p className="note">
            {hasHour
              ? t('最近 {n} 天里（不含今天），{h}:00–{h2}:00 累计坐得最久，共 {d}。', {
                n: range,
                h: peakHour,
                h2: (peakHour + 1) % 24,
                d: hm(hourly[peakHour]),
              })
              : t('还没有足够的数据。')}
          </p>
        </div>
      </div>

      <aside className="side">
        <div className="side-head">
          <h2>{t('逐日明细')}</h2>
          {/* 30 天时列表比窗口高，「查看全部」放到底部会落在折叠线以下，挪进吸顶标题里 */}
          {days.length > 10 && (
            <button className="day-more head-more" onClick={() => setShowAll(!showAll)}>
              {showAll ? t('收起') : t('查看全部 {n} 天', { n: days.length })}
            </button>
          )}
        </div>
        <div className="day-list">
          {visible.map((d) => (
            <button key={d.day} className={`day-row${picked === d.day ? ' is-sel' : ''}`} onClick={() => toggle(d.day)}>
              <span className="day-date">{d.day.slice(5)}<em>{weekday(d.day)}</em></span>
              <span className="day-vals">
                <b>{d.sitting_ms > 0 ? hm(d.sitting_ms) : t('无记录')}</b>
                <i>
                  {t('起身 {n} 次', { n: d.rises })} · {t('提醒 {n} 次', { n: d.reminders })} · {t('最长 {d}', { d: hm(d.longest_ms) })}
                </i>
              </span>
            </button>
          ))}
        </div>
        <details className="hist-note">
          <summary>{t('统计口径')}</summary>
          <p className="note">{t('时长按段累加，同一段反复写入不会重复计数。')}</p>
          <p className="note">{t('跨零点的那一段会被拆成两段，分别记在两天。没有记录的日子在图上留空，不补零。')}</p>
          <p className="note">{t('只有离座或点了「已起身」才算起身次数，跨零点与退出结算不计入。')}</p>
          <p className="note">{t('当天还没走完，不计入日均、达标与环比，只出现在柱图上。')}</p>
        </details>
      </aside>
    </>
  )
}

/** 数值配置卡：滑块拖动即时反馈，停手 240ms 再写入后端 */
function SliderCard({
  configKey,
  icon,
  title,
  hint,
  value,
  min,
  max,
  step,
  save,
}: {
  configKey: string
  icon: IconName
  title: string
  hint: string
  value: number
  min: number
  max: number
  step: number
  save: (key: string, value: number) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  useEffect(() => {
    if (draft === value) return
    const t = window.setTimeout(() => save(configKey, draft), 240)
    return () => window.clearTimeout(t)
  }, [draft, value, configKey, save])

  const pct = Math.min(100, Math.max(0, ((draft - min) / (max - min)) * 100))
  return (
    <div className="card set-card">
      <div className="set-head">
        <span className="set-icon">
          <Icon name={icon} size={16} />
        </span>
        <h4>{title}</h4>
      </div>
      <div className="hint">{hint}</div>
      <div className="set-value">
        <b>{draft}</b>
        <span>{t('分钟')}</span>
      </div>
      <div className="slider-wrap">
        <input
          className="range"
          type="range"
          min={min}
          max={max}
          step={step}
          value={draft}
          aria-label={title}
          style={{
            background: `linear-gradient(90deg, var(--ink) ${pct}%, #e8e8de ${pct}%)`,
          }}
          onChange={(e) => setDraft(Number(e.target.value))}
        />
        <div className="range-scale">
          <span>{t('{n} 分钟', { n: min })}</span>
          <span>{t('{n} 分钟', { n: max })}</span>
        </div>
      </div>
    </div>
  )
}

function SettingsView({ status }: { status: Status }) {
  const [stageRef, stageMore] = useScrollHint<HTMLDivElement>()
  const [adv, setAdv] = useState(false)
  const [volume, setVolume] = useState(() =>
    DEMO ? Number(localStorage.getItem('sitless.volume') ?? 62) : status.volume,
  )
  const [autostart, setAutostart] = useState(false)

  useEffect(() => {
    if (DEMO) return
    invoke<boolean>('autostart_state').then(setAutostart).catch(() => {})
  }, [])
  const [tone, setTone] = useState(() =>
    DEMO ? Number(localStorage.getItem('sitless.tone') ?? 2) : status.tone,
  )
  const [lang, setLang] = useState(status.language || 'auto')
  const [exported, setExported] = useState('')
  const [exportMsg, setExportMsg] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)
  const [quietErr, setQuietErr] = useState('')

  useEffect(() => setLang(status.language || 'auto'), [status.language])

  const changeLang = (v: string) => {
    setLang(v)
    setLangPref(v)
    localStorage.setItem('sitless.language', v)
    void emit('lang://changed', v).catch(() => {})
    if (!DEMO) save('language', v)
  }

  const doExport = async () => {
    if (DEMO) {
      setExportMsg(t('演示模式下不写文件'))
      return
    }
    try {
      setExported(await invoke<string>('export_csv'))
      setExportMsg('')
    } catch (e) {
      setExportMsg(String(e))
    }
  }

  const doDiag = async () => {
    if (DEMO) {
      setExportMsg(t('演示模式下不写文件'))
      return
    }
    try {
      const p = await invoke<string>('export_diagnostics')
      invoke('reveal_path', { path: p }).catch(console.error)
      setExportMsg(t('诊断文件已导出到下载目录'))
    } catch (e) {
      setExportMsg(String(e))
    }
  }

  const doClear = async () => {
    if (!confirmClear) {
      setConfirmClear(true)
      return
    }
    setConfirmClear(false)
    if (DEMO) return
    try {
      await invoke('clear_history')
      setExported('')
      setExportMsg('')
    } catch (e) {
      setExportMsg(String(e))
    }
  }

  const save = useCallback(async (key: string, value: number | string) => {
    if (DEMO) return
    try {
      await invoke<Status>('update_config', { key, value: String(value) })
    } catch (e) {
      console.error(e)
    }
  }, [])

  const timeVal = (id: string) =>
    (document.getElementById(id) as HTMLInputElement | null)?.value ?? ''

  const addQuiet = () => {
    const a = timeVal('qStart')
    const b = timeVal('qEnd')
    if (!a || !b) return
    // 起止相同是零长度时段，后端会直接丢弃，这里先说清楚，不静默失败
    if (a === b) {
      setQuietErr(t('开始与结束不能相同'))
      return
    }
    setQuietErr('')
    save('quiet', [...status.quiet, `${a}-${b}`].join(','))
  }

  const updateQuiet = (i: number) => {
    const a = timeVal(`qs${i}`)
    const b = timeVal(`qe${i}`)
    if (!a || !b) return
    if (a === b) {
      setQuietErr(t('开始与结束不能相同'))
      return
    }
    setQuietErr('')
    const next = [...status.quiet]
    next[i] = `${a}-${b}`
    save('quiet', next.join(','))
  }

  const removeQuiet = (i: number) =>
    save('quiet', status.quiet.filter((_, k) => k !== i).join(','))

  const preview = (kind: string) => {
    if (DEMO) return
    invoke('preview', { kind }).catch(console.error)
  }

  /** 音量：拖动时只动界面，停手 240ms 再落库 */
  const volTimer = useRef<number | null>(null)
  useEffect(() => () => {
    if (volTimer.current) window.clearTimeout(volTimer.current)
  }, [])

  const changeVolume = (v: number) => {
    setVolume(v)
    if (DEMO) {
      localStorage.setItem('sitless.volume', String(v))
      return
    }
    // 每落一次库都会重写 12 项配置并重新采样 5 个 wav，不能跟着拖动走
    if (volTimer.current) window.clearTimeout(volTimer.current)
    volTimer.current = window.setTimeout(() => save('volume', v), 240)
  }

  const toggleAutostart = async () => {
    if (DEMO) return
    const next = !autostart
    try {
      await invoke('set_autostart', { on: next })
      setAutostart(next)
    } catch (e) {
      console.error(e)
    }
  }
  const changeTone = (t: number) => {
    setTone(t)
    localStorage.setItem('sitless.tone', String(t))
    if (DEMO) {
      previewTone(t, volume)
    } else {
      invoke('preview_tone', { tone: t }).catch(console.error)
      save('tone', t)
    }
  }

  const vAlert = minutes(status.alert_threshold_ms)
  const vActivity = minutes(status.activity_interval_ms)
  const vIdle = Math.max(1, minutes(status.idle_threshold_ms))
  const volPct = Math.min(100, Math.max(0, volume))

  const numbers = [
    {
      key: 'alert_min',
      icon: 'warning' as IconName,
      title: t('久坐警戒阈值'),
      hint: t('连续坐多久触发置顶警戒窗'),
      value: vAlert,
      min: 30,
      max: 180,
      step: 15,
    },
    {
      key: 'activity_min',
      icon: 'alarm' as IconName,
      title: t('活动提醒间隔'),
      hint: t('每隔多久做一次轻提醒'),
      value: vActivity,
      min: 10,
      max: 120,
      step: 5,
    },
    {
      key: 'idle_min',
      icon: 'person' as IconName,
      title: t('离座判定'),
      hint: t('无输入超过即算离座，计时归零'),
      value: vIdle,
      min: 1,
      max: 15,
      step: 1,
    },
  ]

  return (
    <>
      <div className={`stage${stageMore ? ' is-more' : ''}`} ref={stageRef}>
        <header className="head">
          <div className="eyebrow">{t('偏好设置')}</div>
          <h1>{t('设置')}</h1>
          <p className="sub">{t('五个常用项放在外面，其余收进高级。改完立即生效。')}</p>
        </header>

        <div className="grid2">
          {numbers.map((r) => (
            <SliderCard
              key={r.key}
              configKey={r.key}
              icon={r.icon}
              title={r.title}
              hint={r.hint}
              value={r.value}
              min={r.min}
              max={r.max}
              step={r.step}
              save={save}
            />
          ))}

          <div className="card set-card">
            <div className="set-head">
              <span className="set-icon">
                <Icon name="speaker" size={16} />
              </span>
              <h4>{t('提醒声音')}</h4>
            </div>
            <div className="hint">{t('独立音量，点音色可试听，不受系统通知音设置影响')}</div>
            <div className="set-foot">
              <Switch checked={status.sound_on} onChange={() => save('sound_on', status.sound_on ? 0 : 1)} label={t('切换提示音')} />
              <input
                className="range"
                type="range"
                min={0}
                max={100}
                value={volPct}
                aria-label={t('试听音量')}
                style={{
                  background: `linear-gradient(90deg, var(--ink) ${volPct}%, #e8e8de ${volPct}%)`,
                }}
                onChange={(e) => changeVolume(Number(e.target.value))}
              />
              <span className="vol-num">{volPct}</span>
            </div>
            <div className="tone-row">
              {[t('木琴'), t('铃'), t('软提示')].map((label, i) => (
                <button key={label} className={tone === i ? 'is-on' : ''} onClick={() => changeTone(i)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="card pref-card">
          <div className="set-head">
            <h4>{t('时间与范围')}</h4>
            <span className="pill">{t('目标 · 工作日 · 免打扰')}</span>
          </div>

          <div className="pref-row">
            <div>
              <b>{t('每日目标')}</b>
              <div className="hint">{t('今天打算起身几次')}</div>
            </div>
            <Stepper
              value={status.daily_goal}
              min={1}
              max={30}
              onChange={(v) => save('daily_goal', v)}
            >
              {status.daily_goal}
              <i>{t('次')}</i>
            </Stepper>
          </div>

          <div className="pref-row">
            <div>
              <b>{t('工作日')}</b>
              <div className="hint">{t('不选的日子不提醒，但仍记录时长')}</div>
            </div>
            <div className="week-row">
              {[t('一'), t('二'), t('三'), t('四'), t('五'), t('六'), t('日')].map((d, i) => (
                <button
                  key={d}
                  className={status.workdays & (1 << i) ? 'is-on' : ''}
                  onClick={() => save('workdays', status.workdays ^ (1 << i))}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>

          <div className="pref-row">
            <div>
              <b>{t('休息时段')}</b>
              <div className="hint">{t('这段时间内不打扰')}</div>
            </div>            <div className="quiet-list">
              {status.quiet.map((q, i) => {
                const [a, b] = q.split('-')
                return (
                  <div className="quiet-row" key={`${i}-${q}`}>
                    <TimePicker id={`qs${i}`} defaultValue={a} label={t('开始时间')} />
                    <span>—</span>
                    <TimePicker id={`qe${i}`} defaultValue={b} label={t('结束时间')} />
                    <button className="quiet-save" onClick={() => updateQuiet(i)}>{t('保存')}</button>
                    <button className="quiet-del" onClick={() => removeQuiet(i)} aria-label={t('删除该时段')}>×</button>
                  </div>
                )
              })}
              {status.quiet.length === 0 && <span className="hint">{t('无')}</span>}
            </div>
          </div>

          <div className="pref-row">
            <div className="quiet-add-wrap">
              <div className="quiet-add">
                <TimePicker id="qStart" defaultValue="12:00" label={t('新时段开始')} />
                <span>—</span>
                <TimePicker id="qEnd" defaultValue="13:30" label={t('新时段结束')} />
                <Button variant="dark" onClick={addQuiet}>{t('添加')}</Button>
              </div>
              <span className={`quiet-err${quietErr ? '' : ' is-hint'}`}>
                {quietErr || t('结束早于开始表示跨零点，例如 22:00—06:00')}
              </span>
            </div>
          </div>
        </div>

        <div className="card row-card remind-card">
          <div className="remind-top">
            <div>
              <h4>{t('提醒窗口')}</h4>
              <div className="hint">{t('轻提醒以什么形式出现；置顶窗为不抢焦点的小浮窗，警戒始终是完整弹窗')}</div>
            </div>
            <div className="remind-preview">
              <Button variant="soft" onClick={() => preview('light')}>{t('预览')}</Button>
              <Button variant="soft" onClick={() => preview('alert')}>{t('警戒预览')}</Button>
            </div>
          </div>
          <div className="head-tools">
            <div className="seg-ctrl">
              {[t('系统通知'), t('主窗口提醒'), t('置顶窗')].map((label, i) => (
                <button key={label} className={status.reminder_style === i ? 'is-on' : ''} onClick={() => save('reminder_style', i)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="card row-card">
          <div>
            <h4>{t('开机自启动')}</h4>
            <div className="hint">{t('登录后静默启动到托盘，不弹主窗')}</div>
          </div>
          <Switch checked={autostart} onChange={toggleAutostart} label={t('切换开机自启动')} />
        </div>

        <div className="card adv-card">
          <button className={`adv-head${adv ? ' is-open' : ''}`} onClick={() => setAdv(!adv)}>
            <h4>{t('高级')}</h4>
            <span className="count">{t('{n} 项', { n: 9 })}</span>
            <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          {adv && (
            <div className="adv-body">
              <div className="adv-row">
                <div>
                  <h4>{t('休息前确认')}</h4>
                  <div className="hint">
                    {t('警戒窗出现后先锁 {d}，防止顺手关掉', {
                      d: status.alert_seconds > 0 ? t('{n} 秒', { n: status.alert_seconds }) : t('（已设为不锁）'),
                    })}
                  </div>
                </div>
                <Switch checked={status.confirm_before_rest} onChange={() => save('confirm_before_rest', status.confirm_before_rest ? 0 : 1)} label={t('切换休息前确认')} />
              </div>
              <div className="adv-row">
                <div>
                  <h4>{t('操作检测提示音')}</h4>
                  <div className="hint">{t('离座或回到座位时轻响一声')}</div>
                </div>
                <Switch checked={status.action_beep} onChange={() => save('action_beep', status.action_beep ? 0 : 1)} label={t('切换操作检测提示音')} />
              </div>
              <div className="adv-row">
                <div>
                  <h4>{t('未响应重复间隔')}</h4>
                  <div className="hint">{t('提醒被忽略后，隔多久再弹一次')}</div>
                </div>
                <Stepper
                  value={minutes(status.repeat_interval_ms)}
                  min={1}
                  max={30}
                  onChange={(v) => save('repeat_interval_min', v)}
                >
                  {minutes(status.repeat_interval_ms)}
                  <i>{t('分钟')}</i>
                </Stepper>
              </div>
              <div className="adv-row">
                <div>
                  <h4>{t('未响应重申次数')}</h4>
                  <div className="hint">{t('同一轮提醒最多弹几次，之后静默')}</div>
                </div>
                <Stepper value={status.repeat_limit} min={1} max={6} onChange={(v) => save('repeat_limit', v)}>
                  {status.repeat_limit}
                  <i>{t('次')}</i>
                </Stepper>
              </div>
              <div className="adv-row">
                <div>
                  <h4>{t('警戒窗强制倒计时')}</h4>
                  <div className="hint">
                    {status.confirm_before_rest
                      ? (status.alert_seconds > 0 ? t('倒计时结束前不能清零重计；关闭和暂停随时可用') : t('当前不锁，出现即可清零重计'))
                      : t('需先打开上面的「休息前确认」')}
                  </div>
                </div>
                <Stepper
                  value={status.alert_seconds}
                  min={0}
                  max={120}
                  step={5}
                  disabled={!status.confirm_before_rest}
                  onChange={(v) => save('alert_seconds', v)}
                >
                  {status.alert_seconds > 0 ? (
                    <>
                      {status.alert_seconds}
                      <i>{t('秒')}</i>
                    </>
                  ) : (
                    t('不锁')
                  )}
                </Stepper>
              </div>
              <div className="adv-row">
                <div>
                  <h4>{t('全屏时抑制提醒')}</h4>
                  <div className="hint">{t('退出全屏后汇总补发一条')}</div>
                </div>
                <Switch
                  checked={status.fullscreen_suppress}
                  onChange={() => save('fullscreen_suppress', status.fullscreen_suppress ? 0 : 1)}
                  label={t('切换全屏抑制')}
                />
              </div>
              <div className="adv-row">
                <div>
                  <h4>{t('界面语言')}</h4>
                  <div className="hint">{t('默认跟随系统，切换后立即生效')}</div>
                </div>
                <div className="seg-ctrl">
                  {(['auto', 'zh', 'en'] as const).map((v) => (
                    <button key={v} className={lang === v ? 'is-on' : ''} onClick={() => changeLang(v)}>
                      {v === 'auto' ? t('跟随系统') : v === 'zh' ? t('中文') : 'EN'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="adv-row is-wrap">
                <div>
                  <h4>{t('导出数据')}</h4>
                  <div className="hint">{t('CSV，含每日时长、提醒次数与段明细')}</div>
                  {exported && (
                    <div className="adv-result">
                      <span title={exported}>{t('已导出到下载目录')}</span>
                      <Button variant="soft" onClick={() => invoke('reveal_path', { path: exported }).catch(console.error)}>
                        {t('打开所在文件夹')}
                      </Button>
                    </div>
                  )}
                  {exportMsg && <div className="adv-result is-error">{exportMsg}</div>}
                </div>
                <div className="adv-acts">
                  <Button variant="soft" onClick={doDiag}>{t('诊断信息')}</Button>
                  <Button variant="dark" onClick={doExport}>{t('导出')}</Button>
                </div>
              </div>
              <div className="adv-row">
                <div>
                  <h4 className="danger">{t('清空全部记录')}</h4>
                  <div className="hint">{t('统计与历史一并删除，不可恢复')}</div>
                </div>
                <div className="adv-acts">
                  {confirmClear && (
                    <>
                      <Button variant="ghost" onClick={() => setConfirmClear(false)}>{t('取消')}</Button>
                      <Button variant="dark" className="is-danger" onClick={doClear}>{t('确认清空')}</Button>
                    </>
                  )}
                  {!confirmClear && <Button variant="soft" onClick={doClear}>{t('清空')}</Button>}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <aside className="side">
        <div className="side-head">
          <h2>{t('当前配置')}</h2>
        </div>
        <p className="side-sub">{t('改完立即生效，不需要重启应用。')}</p>
        <div className="kv-list">
          <div className="kv-row">
            <span>{t('久坐警戒阈值')}</span>
            <b>{vAlert}<i>{t('分钟')}</i></b>
          </div>
          <div className="kv-row">
            <span>{t('活动提醒间隔')}</span>
            <b>{vActivity}<i>{t('分钟')}</i></b>
          </div>
          <div className="kv-row">
            <span>{t('离座判定')}</span>
            <b>{vIdle}<i>{t('分钟')}</i></b>
          </div>
          <div className="kv-row">
            <span>{t('提醒声音')}</span>
            <b>{volPct}<i>%</i></b>
          </div>
          <div className="kv-row">
            <span>{t('未响应重申')}</span>
            <b>{status.repeat_limit}<i>{t('次封顶')}</i></b>
          </div>
          <div className="kv-row">
            <span>{t('每日目标')}</span>
            <b>{status.daily_goal}<i>{t('次')}</i></b>
          </div>
          <div className="kv-row">
            <span>{t('工作日')}</span>
            <b>{[...Array(7)].filter((_, i) => status.workdays & (1 << i)).length}<i>{t('天')}</i></b>
          </div>
          <div className="kv-row">
            <span>{t('休息时段')}</span>
            <b>{status.quiet.length}<i>{t('段')}</i></b>
          </div>
          <div className="kv-row">
            <span>{t('提醒窗口')}</span>
            <b>{[t('系统通知'), t('主窗口'), t('置顶窗')][status.reminder_style]}</b>
          </div>
          <div className="kv-row">
            <span>{t('全屏抑制')}</span>
            <b>{status.fullscreen_suppress ? t('开启') : t('关闭')}</b>
          </div>
          <div className="kv-row">
            <span>{t('界面语言')}</span>
            <b>{status.language === 'auto' ? t('跟随系统') : status.language === 'zh' ? t('中文') : 'EN'}</b>
          </div>
          <div className="kv-row">
            <span>{t('开机自启')}</span>
            <b>{autostart ? t('开启') : t('关闭')}</b>
          </div>
        </div>
        <p className="side-note">{t('数据存在本地 SQLite，不上传、不联网。改过的配置也存同一份库。')}</p>
      </aside>
    </>
  )
}
