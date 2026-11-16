export const MIN = 60_000;
export const PAUSE_MS = 15 * MIN;
export const GAP_FLOOR_MS = 5 * MIN;
export const TICK_MS = 30_000;

export interface Prefs {
  alertMin: number;
  idleMin: number;
  sound: boolean;
  /** bit0=周一 … bit6=周日 */
  workdays: number;
}

export const DEFAULT_PREFS: Prefs = {
  alertMin: 60,
  idleMin: 3,
  sound: true,
  workdays: 0b0011_1111,
};

export interface Snap {
  day: string;
  /** 段起点。只在开段时生成一次并持久化，后续不反推。 */
  segStartAt: number;
  sittingMs: number;
  todayMs: number;
  standUps: number;
  alertMs: number;
  /** 当天第几次警戒，用于轮换提醒文案；跨零点归零 */
  notices: number;
  present: boolean;
  pausedUntil: number | null;
  updatedAt: number;
}

export function freshSnap(now: number, day: string): Snap {
  return {
    day,
    segStartAt: now,
    sittingMs: 0,
    todayMs: 0,
    standUps: 0,
    alertMs: 0,
    notices: 0,
    present: true,
    pausedUntil: null,
    updatedAt: now,
  };
}

export type RemindState = 'on' | 'paused' | 'offday' | 'away';

export interface StatusView {
  snap: Snap;
  prefs: Prefs;
  now: number;
  state: RemindState;
  remainMs: number;
}

export type Action = 'dismiss' | 'pause' | 'resume' | 'skip';

export type Msg =
  | { type: 'status' }
  | { type: 'action'; action: Action }
  | { type: 'config'; patch: Partial<Prefs> }
  | { type: 'changed' };

export function dayKey(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 向下取整，只数坐满的整分钟。桌面版 hm()/wholeMinutes() 同口径。 */
export function wholeMinutes(ms: number): number {
  return Math.max(0, Math.floor(ms / MIN));
}

export function hm(ms: number): string {
  const m = wholeMinutes(ms);
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`;
}

export function isWorkday(prefs: Prefs, t: number): boolean {
  const jsDay = new Date(t).getDay(); // 0=周日
  const bit = jsDay === 0 ? 6 : jsDay - 1;
  return (prefs.workdays & (1 << bit)) !== 0;
}

export function silenceState(prefs: Prefs, snap: Snap, now: number): RemindState {
  if (snap.pausedUntil !== null && snap.pausedUntil > now) return 'paused';
  if (!snap.present) return 'away';
  if (!isWorkday(prefs, now)) return 'offday';
  return 'on';
}

export function clampPrefs(patch: Partial<Prefs>, base: Prefs): Prefs {
  const num = (v: number | undefined, lo: number, hi: number, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;
  return {
    alertMin: num(patch.alertMin, 10, 180, base.alertMin),
    idleMin: num(patch.idleMin, 1, 15, base.idleMin),
    sound: typeof patch.sound === 'boolean' ? patch.sound : base.sound,
    workdays: typeof patch.workdays === 'number' ? patch.workdays & 0x7f : base.workdays,
  };
}
