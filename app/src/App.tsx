import { useCallback, useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Button, Stepper, Switch } from './ui/controls'
import { listen, emit } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Icon, type IconName } from './icons'
import { currentLang, t, useLang, setLangPref } from './i18n'
import { activityArt, ringArt } from './art'

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
}

type TodayData = {
  day: string
  sitting_ms: number
  longest_ms: number
  segments: number
  reminders: number
}
type DayRow = { day: string; sitting_ms: number; longest_ms: number }
type SegRow = { started_at: string; sitting_ms: number; closed: boolean }

const DEMO = new URLSearchParams(window.location.search).get('demo') === '1'

const EMPTY_STATUS: Status = {
  idle_threshold_ms: 180000,
  sitting_ms: 0,
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
  next_alert_ms: 78 * 60000,
  next_activity_ms: 12 * 60000,
  alert_threshold_ms: 120 * 60000,
  activity_interval_ms: 45 * 60000,
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
  segments: 3,
  reminders: 6,
}

const DEMO_SEGS: SegRow[] = [
  { started_at: `${todayIso()}T12:04:00`, sitting_ms: 30 * 60000, closed: true },
  { started_at: `${todayIso()}T11:30:00`, sitting_ms: 2 * 3600000, closed: true },
  { started_at: `${todayIso()}T10:00:00`, sitting_ms: 2 * 60000, closed: true },
  { started_at: `${todayIso()}T09:12:00`, sitting_ms: 42 * 60000, closed: false },
]

const DEMO_DAYS: DayRow[] = lastDays(7).map((day, i) => ({
  day,
  sitting_ms: [5.2, 6.8, 4.1, 7.3, 6, 3.4, 3.7][i] * 3600000,
  longest_ms: [1.2, 2.1, 0.9, 2.2, 1.6, 0.8, 1.3][i] * 3600000,
}))

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
    { type: 'sine' as OscillatorType, freq: 1300, dur: 0.4, decay: 0.1, attack: 0.003, glide: 420 },
    { type: 'triangle' as OscillatorType, freq: 780, dur: 0.22, decay: 0.05, attack: 0.0015, glide: 0 },
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
        {view === 'history' && <HistoryView />}
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
          onSkip={() => {
            act('skip')
            setToastAt(0)
          }}
          onClose={() => setToastAt(0)}
        />
      )}
    </div>
  )
}

/** 右上角轻提醒：与 toast.png 一致，按钮直接操作计时 */
function Toast({
  sitting,
  onDone,
  onSkip,
  onClose,
}: {
  sitting: number
  onDone: () => void
  onSkip: () => void
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
      <p>{t('站起来走 1 分钟，或者做两个伸展。点「已起身」会把计时清零。')}</p>
      <div className="toast-acts">
        <Button variant="dark" onClick={onDone}>
          {t('已起身')}
        </Button>
        <Button variant="ghost" onClick={onSkip}>
          {t('跳过')}
        </Button>
      </div>
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
      <div className="dock-side left">
        <span className="dock-label">
          {t('已连续 {d}', { d: status.sitting_ms < 60000 ? t('不到 1 分钟') : hm(status.sitting_ms) })}
        </span>
      </div>

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
        <button className="dock-btn is-butter" title={t('跳过本次提醒')} onClick={() => act('skip')}>
          <Icon name="skip" size={17} />
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
  const total = Math.max(1, status.alert_threshold_ms)
  const progress = Math.min(1, Math.max(0, status.sitting_ms / total))
  const R = 52
  const C = 2 * Math.PI * R
  const nextAct = minutes(status.next_activity_ms)
  const actTotal = Math.max(1, minutes(status.activity_interval_ms))
  const { unit: segUnit, count: segCount } = segSpec(actTotal)
  const passed = Math.round(Math.min(1, Math.max(0, 1 - nextAct / actTotal)) * segCount)
  const ordered = [...segs].reverse()
  const rises = segs.filter((s) => s.closed).length
  const reminders = today.reminders
  const started = ordered.length ? clockOf(ordered[0].started_at) : '—'
  const totalDur = compact(today.sitting_ms)
  const longDur = compact(today.longest_ms)
  const tones = ['tl-mint', 'tl-sky', 'tl-butter', 'tl-lilac']

  return (
    <>
      <div className="stage">
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
              {status.paused ? t(' 提醒已暂停。') : ''}
            </p>
          </div>
        </header>

        <section className="alert">
          <div className="alert-main">
            <span className="card-eyebrow">
              <Icon name="warning" size={13} />
              {t('久坐警戒 · 阈值 {n} 分钟', { n: minutes(status.alert_threshold_ms) })}
            </span>
            <h2>
              {t('还有 {d}', { d: hm(status.next_alert_ms) })}
              <br />
              {t('就要打断你了')}
            </h2>
            <p>
              {t('连续坐满阈值会弹置顶窗，')}
              {status.confirm_before_rest
                ? (status.alert_seconds > 0 ? t('{n} 秒后才可关闭。', { n: status.alert_seconds }) : t('出现即可关闭。'))
                : t('不做强制等待。')}
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
            <svg width="124" height="124" viewBox="0 0 124 124">
              <circle cx="62" cy="62" r={R} fill="none" stroke="rgba(12,12,12,.13)" strokeWidth="9" />
              <circle
                cx="62"
                cy="62"
                r={R}
                fill="none"
                stroke="#0c0c0c"
                strokeWidth="9"
                strokeLinecap="round"
                strokeDasharray={C.toFixed(1)}
                strokeDashoffset={(C * (1 - progress)).toFixed(1)}
                style={{ transition: 'stroke-dashoffset .9s linear' }}
              />
            </svg>
            <div className="ring-mid">
              <b>{minutes(status.sitting_ms)}</b>
              <span>{t('分钟')}</span>
            </div>
          </div>
        </section>

        <section className="next">
          <div className="next-main">
            <span className="card-eyebrow">
              <Icon name="alarm" size={13} />
              {t('活动提醒 · 每 {n} 分钟', { n: minutes(status.activity_interval_ms) })}
            </span>
            <h3>{nextAct <= 0 ? t('下一次提醒马上就到') : t('下一次提醒在 {n} 分钟后', { n: nextAct })}</h3>
            <div className="next-meta-row">
              <span className="next-meta">{t('右上角轻提示，不抢焦点，不响铃打断。')}</span>
              <span className="segs-scale">{t('每格 {n} 分钟', { n: segUnit })}</span>
            </div>
            <div className="segs">
              {Array.from({ length: segCount }, (_, i) => (
                <i key={i} className={i < passed ? 'on' : ''} />
              ))}
            </div>
          </div>
          <img className="next-art" src={activityArt()} alt="" />
        </section>

        <div className="tiles">
          <div className="tile t-mint">
            <span className="tile-ico">
              <Icon name="clock" size={19} />
            </span>
            <b>
              {totalDur.lead}
              <small>{totalDur.unit}</small>
              {totalDur.tail}
            </b>
            <span>{t('坐姿总时长')}</span>
          </div>
          <div className="tile t-sky">
            <span className="tile-ico">
              <Icon name="chart" size={19} />
            </span>
            <b>
              {longDur.lead}
              <small>{longDur.unit}</small>
              {longDur.tail}
            </b>
            <span>{t('最长连续')}</span>
          </div>
          <div className="tile t-butter">
            <span className="tile-ico">
              <Icon name="bell" size={19} />
            </span>
            <b>{reminders}</b>
            <span>{t('提醒次数')}</span>
          </div>
          <div className="tile t-dash">
            <span className="tile-ico">
              <Icon name="person" size={19} />
            </span>
            <b>{rises}</b>
            <span>{t('起身次数')}</span>
            <em className="tile-tag">{t('今日目标 {n}', { n: status.daily_goal })}</em>
          </div>
        </div>
      </div>

      <aside className="side">
        <div className="side-head">
          <h2>{t('今日时间线')}</h2>
        </div>

        {status.paused && (
          <div className="tl-item tl-lilac">
            <div className="tl-top">
              <span className="tl-ico">
                <Icon name="pause" size={14} />
              </span>
              <b>{t('暂停')}</b>
              <span className="tl-time">{t('现在')}</span>
            </div>
            <p>{t('提醒暂不弹出，久坐仍在累计。')}</p>
            <button className="tl-foot is-action" onClick={() => act('resume')}>
              {t('恢复计时')}
            </button>
          </div>
        )}

        <div className="timeline">
          {ordered.length === 0 ? (
            <p className="note">{t('还没有记录，坐一会儿就有了。')}</p>
          ) : (
            ordered.slice(0, 4).map((s, i) => {
              const first = i === 0
              const kind = first ? t('开始') : s.closed ? t('已起身') : t('进行中')
              const icon: IconName = first ? 'play' : s.closed ? 'check' : 'clock'
              const footIcon: IconName = first ? 'chart' : 'clock'
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
                    {first
                      ? t('检测到你在电脑前，新的一段正在累计。')
                      : s.closed
                        ? t('这一段连续坐了 {d}。', { d: hm(s.sitting_ms) })
                        : t('这一段已经 {d}，计时未中断。', { d: hm(s.sitting_ms) })}
                  </p>
                  <div className="tl-foot">
                    <Icon name={footIcon} size={11} />
                    {first ? t('已记录 {n} 段', { n: segs.length }) : s.closed ? t('计时已归零') : t('未计入起身')}
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

function HistoryView() {
  const [rows] = usePoll<DayRow[]>('trend', { days: 7 }, 30000, [], DEMO ? DEMO_DAYS : undefined)
  const days = lastDays(7).map((day) => {
    const hit = rows.find((r) => r.day === day)
    return { day, sitting_ms: hit?.sitting_ms ?? 0, longest_ms: hit?.longest_ms ?? 0 }
  })
  // 刻度取 15 分钟为步长的整数倍，数据稀疏时柱子不会被压成一条线
  const peakMs = Math.max(...days.map((d) => d.sitting_ms))
  const max = Math.max(15 * 60000, Math.ceil(peakMs / (15 * 60000)) * 15 * 60000)
  const totalMs = days.reduce((a, r) => a + r.sitting_ms, 0)
  const active = days.filter((d) => d.sitting_ms > 0)
  const avg = active.length ? totalMs / active.length : 0
  const peak = days.reduce<DayRow | null>((a, r) => (!a || r.sitting_ms > a.sitting_ms ? r : a), null)
  const on = todayIso()

  return (
    <>
      <div className="stage">
        <header className="head">
          <div className="eyebrow">{t('最近 7 天')}</div>
          <h1>{t('日均 {d}', { d: hm(avg) })}</h1>
          <p className="sub">
            {peak && peak.sitting_ms > 0
              ? t('峰值在 {w}，{d}。', { w: weekday(peak.day), d: hm(peak.sitting_ms) })
              : t('还没有足够的数据。')}
          </p>
        </header>

        <div className="card chart-card">
          <div className="chart">
            {days.map((r) => {
              const empty = r.sitting_ms === 0
              const pct = empty ? 88 : Math.max(4, (r.sitting_ms / max) * 88)
              return (
                <div className={`col${r.day === on ? ' on' : ''}`} key={r.day}>
                  <div className="barbox">
                    <b>{shortDur(r.sitting_ms)}</b>
                    <div className={`bar${empty ? ' is-empty' : ''}`} style={{ height: `${pct}%` }} />
                  </div>
                  <i>{weekday(r.day)}</i>
                </div>
              )
            })}
          </div>
        </div>

        <div className="tiles tiles-history">
          <div className="tile t-mint">
            <div className="ico">
              <Icon name="clock" size={19} />
            </div>
            <b>{hm(totalMs)}</b>
            <span>{t('七天合计')}</span>
          </div>
          <div className="tile t-sky">
            <div className="ico">
              <Icon name="chart" size={19} />
            </div>
            <b>{peak ? hm(peak.sitting_ms) : '—'}</b>
            <span>{t('最久的一天')}</span>
          </div>
          <div className="tile t-butter">
            <div className="ico">
              <Icon name="person" size={19} />
            </div>
            <b>{active.length}</b>
            <span>{t('有记录的天数')}</span>
          </div>
          <div className="tile t-pink">
            <div className="ico">
              <Icon name="alarm" size={19} />
            </div>
            <b>{active.length ? hm(avg) : '—'}</b>
            <span>{t('日均')}</span>
          </div>
        </div>
      </div>

      <aside className="side">
        <div className="card">
          <img src="/cal.png" alt="" style={{ width: 92, height: 92, objectFit: 'contain', display: 'block', margin: '0 auto 6px' }} />
          <p className="note" style={{ textAlign: 'center' }}>
            {t('时长按段累加，同一段反复写入不会重复计数。')}
          </p>
        </div>
        <div className="card">
          <h3>{t('这组数字怎么来的')}</h3>
          <p className="note">
            {t('跨零点的那一段会被拆成两段，分别记在两天。缺记录的日子在图上画成淡色占位，不会被跳过。')}
          </p>
        </div>
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
    save('quiet', [...status.quiet, `${a}-${b}`].join(','))
  }

  const updateQuiet = (i: number) => {
    const a = timeVal(`qs${i}`)
    const b = timeVal(`qe${i}`)
    if (!a || !b) return
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

  const changeVolume = (v: number) => {
    setVolume(v)
    if (DEMO) {
      localStorage.setItem('sitless.volume', String(v))
    } else {
      save('volume', v)
    }
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
      <div className="stage">
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
              {[t('木琴'), t('铃'), t('软提示'), t('水滴'), t('木鱼')].map((label, i) => (
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
            </div>
            <div className="quiet-list">
              {status.quiet.map((q, i) => {
                const [a, b] = q.split('-')
                return (
                  <div className="quiet-row" key={`${i}-${q}`}>
                    <input type="time" id={`qs${i}`} defaultValue={a} aria-label={t('开始时间')} />
                    <span>—</span>
                    <input type="time" id={`qe${i}`} defaultValue={b} aria-label={t('结束时间')} />
                    <button className="quiet-save" onClick={() => updateQuiet(i)}>{t('保存')}</button>
                    <button className="quiet-del" onClick={() => removeQuiet(i)} aria-label={t('删除该时段')}>×</button>
                  </div>
                )
              })}
              {status.quiet.length === 0 && <span className="hint">{t('无')}</span>}
            </div>
          </div>

          <div className="pref-row">
            <div className="quiet-add">
              <input type="time" id="qStart" defaultValue="12:00" aria-label={t('新时段开始')} />
              <span>—</span>
              <input type="time" id="qEnd" defaultValue="13:30" aria-label={t('新时段结束')} />
              <Button variant="dark" onClick={addQuiet}>{t('添加')}</Button>
            </div>
          </div>
        </div>

        <div className="card row-card">
          <div>
            <h4>{t('提醒窗口')}</h4>
            <div className="hint">{t('轻提醒以什么形式出现')}</div>
          </div>
          <div className="head-tools">
            <div className="seg-ctrl">
              {[t('系统通知'), t('主窗口提醒'), t('置顶窗')].map((label, i) => (
                <button key={label} className={status.reminder_style === i ? 'is-on' : ''} onClick={() => save('reminder_style', i)}>
                  {label}
                </button>
              ))}
            </div>
            <Button variant="soft" onClick={() => preview('light')}>{t('预览')}</Button>
            <Button variant="soft" onClick={() => preview('alert')}>{t('警戒预览')}</Button>
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
                <Button variant="dark" onClick={doExport}>{t('导出')}</Button>
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
