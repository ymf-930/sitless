import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  MIN,
  hm,
  wholeMinutes,
  dayKey,
  DEFAULT_PREFS,
  type Prefs,
  type StatusView,
  type Action,
  type Msg,
} from './types';
import './popup.css';

const WEEK = ['一', '二', '三', '四', '五', '六', '日'];
const CIRC = 2 * Math.PI * 50;
const DEMO =
  typeof chrome === 'undefined' ||
  !chrome.runtime?.sendMessage ||
  new URLSearchParams(location.search).has('demo');

const STATE_TEXT: Record<StatusView['state'], string> = {
  on: '正在记录',
  paused: '已暂停提醒',
  offday: '今天不提醒',
  away: '已离座',
};

function send<T>(msg: Msg): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

function fill(v: number, lo: number, hi: number): string {
  const p = Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  return `linear-gradient(to right, var(--brand) ${p}%, var(--track) ${p}%)`;
}

// 在普通浏览器里直接打开 dist/popup.html 时用于样式验收，不进入正式产物逻辑。
function demoView(): StatusView {
  const now = Date.now();
  return {
    snap: {
      day: dayKey(now),
      segStartAt: now - 24 * MIN,
      sittingMs: 24 * MIN,
      todayMs: 134 * MIN,
      standUps: 3,
      alertMs: 24 * MIN,
      notices: 3,
      present: true,
      pausedUntil: null,
      updatedAt: now,
    },
    prefs: { ...DEFAULT_PREFS },
    now,
    state: 'on',
    remainMs: 36 * MIN,
  };
}

function App() {
  const [view, setView] = useState<StatusView | null>(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState('');
  const [, beat] = useState(0);
  const timer = useRef<number | null>(null);
  const pending = useRef<Partial<Prefs>>({});
  const flashTimer = useRef<number | null>(null);
  const [flash, setFlash] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const hasView = view !== null;

  const refresh = useCallback(async () => {
    if (DEMO) {
      setView(demoView());
      return;
    }
    try {
      const v = await send<StatusView>({ type: 'status' });
      if (v && v.snap) setView(v);
      else setErr('读取状态失败');
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => beat((x) => x + 1), 1000);
    return () => {
      window.clearInterval(t);
      if (timer.current) window.clearTimeout(timer.current);
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
    };
  }, [refresh]);

  // 内容超出可视高度时给底边渐隐，滚到底自动摘掉（与桌面版同一套滚动提示）。
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const check = () => setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 8);
    check();
    const t = window.setTimeout(check, 320); // 展开动画结束后再量一次
    el.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check);
    return () => {
      window.clearTimeout(t);
      el.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
    };
  }, [open, hasView]);

  async function act(action: Action) {
    if (DEMO) {
      setView((v) =>
        v
          ? {
              ...v,
              snap: { ...v.snap, updatedAt: Date.now() },
              state: action === 'pause' ? 'paused' : action === 'resume' ? 'on' : v.state,
              now: Date.now(),
            }
          : v,
      );
      confirmRise(action);
      return;
    }
    await send({ type: 'action', action });
    await refresh();
    confirmRise(action);
  }

  // 「已起身」原本只是数字清零，没有任何反馈；给 3 秒确认，把动作闭合。
  function confirmRise(action: Action) {
    if (action !== 'dismiss') return;
    setFlash('已记录 · 去接杯水');
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(''), 3000);
  }

  // 与桌面版一致：滑块停手约 240ms 后才落盘，避免拖动时反复写 storage。
  function patch(p: Partial<Prefs>) {
    setView((v) => (v ? { ...v, prefs: { ...v.prefs, ...p } } : v));
    if (DEMO) return;
    pending.current = { ...pending.current, ...p };
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      const toSend = pending.current;
      pending.current = {};
      await send({ type: 'config', patch: toSend });
      await refresh();
    }, 240);
  }

  if (!view) {
    return (
      <div className="wrap">
        <div className="hero loading">正在读取…{err && <span className="err">{err}</span>}</div>
      </div>
    );
  }

  // popup 是普通文档，本地 1 秒插值；后台累计只看 service worker 的时间戳差值。
  const live = view.state === 'away' ? 0 : Math.max(0, Date.now() - view.now);
  const seg = view.snap.sittingMs + live;
  const today = view.snap.todayMs + live;
  const remain = Math.max(0, view.remainMs - live);
  const threshold = view.prefs.alertMin * MIN;
  const progress = Math.min(1, threshold > 0 ? seg / threshold : 0);
  const paused = view.state === 'paused';

  return (
    <div className={`wrap ${more ? 'is-more' : ''}`} ref={wrapRef}>
      <header className="top">
        <span className="brand-mark">
          <img src="icons/icon32.png" alt="" />
        </span>
        <span className="brand-name">走走</span>
        <span className={`pill ${view.state}`}>
          <i className="dot" aria-hidden="true" />
          {STATE_TEXT[view.state]}
        </span>
      </header>

      <section className="hero">
        <div className="eyebrow">今天坐了</div>
        <div className="total">{hm(today)}</div>

        <div
          className={`dial ${view.state === 'on' ? '' : 'muted'}`}
          role="progressbar"
          aria-label="当前这一段相对久坐警戒阈值的进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
        >
          <svg viewBox="0 0 120 120" aria-hidden="true">
            <circle className="dial-track" cx="60" cy="60" r="50" />
            <circle
              className="dial-fill"
              cx="60"
              cy="60"
              r="50"
              strokeDasharray={CIRC}
              strokeDashoffset={CIRC * (1 - progress)}
            />
          </svg>
          <div className="dial-center">
            <b>{wholeMinutes(seg)}</b>
            <span>已坐 · 分钟</span>
          </div>
        </div>

        <div className="sub">
          当前这一段 · 起身 <b>{view.snap.standUps}</b> 次
        </div>
        <div className="chips">
          {flash ? (
            <span className="chip done" role="status">
              {flash}
            </span>
          ) : (
            <span className="chip">
              距警戒 <b>{wholeMinutes(remain)}</b> 分钟
            </span>
          )}
        </div>
      </section>

      <section className="actions" aria-label="快捷操作">
        <button className="primary" onClick={() => void act('dismiss')}>
          已起身
        </button>
        <button onClick={() => void act(paused ? 'resume' : 'pause')}>
          {paused ? '恢复提醒' : '暂停 15 分钟'}
        </button>
        <button onClick={() => void act('skip')}>跳过</button>
      </section>

      <button className="fold" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>提醒设置</span>
        <span className={`chev ${open ? 'up' : ''}`} aria-hidden="true">
          ⌄
        </span>
      </button>

      {open && (
        <section className="settings" aria-label="提醒设置">
          <div className="group-title">节奏</div>

          <label className="slider-row">
            <span className="slider-head">
              <span>久坐警戒阈值</span>
              <b>{view.prefs.alertMin} 分钟</b>
            </span>
            <input
              type="range"
              min={10}
              max={180}
              step={5}
              value={view.prefs.alertMin}
              aria-label="久坐警戒阈值（分钟）"
              style={{ background: fill(view.prefs.alertMin, 10, 180) }}
              onChange={(e) => patch({ alertMin: Number(e.target.value) })}
            />
          </label>

          <label className="slider-row">
            <span className="slider-head">
              <span>离座判定</span>
              <b>{view.prefs.idleMin} 分钟</b>
            </span>
            <input
              type="range"
              min={1}
              max={15}
              step={1}
              value={view.prefs.idleMin}
              aria-label="离座判定（分钟）"
              style={{ background: fill(view.prefs.idleMin, 1, 15) }}
              onChange={(e) => patch({ idleMin: Number(e.target.value) })}
            />
          </label>

          <div className="group-title">不打扰</div>

          <label className="switch-row">
            <span>提示音</span>
            <input
              className="sr-only"
              type="checkbox"
              checked={view.prefs.sound}
              onChange={(e) => patch({ sound: e.target.checked })}
            />
            <i className="switch" aria-hidden="true" />
          </label>

          <div className="field">
            <div className="field-head">
              <span>工作日</span>
              <small>不选的日子不提醒，但仍记录时长</small>
            </div>
            <div className="week" role="group" aria-label="工作日">
              {WEEK.map((w, i) => (
                <button
                  key={w}
                  className={(view.prefs.workdays & (1 << i)) !== 0 ? 'on' : ''}
                  aria-pressed={(view.prefs.workdays & (1 << i)) !== 0}
                  onClick={() => patch({ workdays: view.prefs.workdays ^ (1 << i) })}
                >
                  {w}
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      {err && (
        <div className="err" role="alert">
          {err}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
