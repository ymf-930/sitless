import {
  MIN,
  PAUSE_MS,
  GAP_FLOOR_MS,
  DEFAULT_PREFS,
  freshSnap,
  dayKey,
  hm,
  silenceState,
  clampPrefs,
  type Prefs,
  type Snap,
  type StatusView,
  type Action,
  type Msg,
} from './types';

const ALARM = 'zouzou-tick';
const KEY_PREFS = 'prefs';
const KEY_SNAP = 'snap';
const ID_ALERT = 'zouzou-alert';

// service worker 会被多个事件并发唤醒，而 storage 读写不是原子的。
// 所有状态变更排成一条链，避免两个 tick 同时读到旧快照再互相覆盖。
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => undefined);
  return p;
}

async function read(): Promise<{ prefs: Prefs; snap: Snap }> {
  const got = await chrome.storage.local.get([KEY_PREFS, KEY_SNAP]);
  const saved = (got[KEY_PREFS] as Partial<Prefs> | undefined) ?? {};
  const prefs = clampPrefs({ ...DEFAULT_PREFS, ...saved }, DEFAULT_PREFS);
  const now = Date.now();
  const snap = (got[KEY_SNAP] as Snap | undefined) ?? freshSnap(now, dayKey(now));
  return { prefs, snap };
}

async function write(snap: Snap): Promise<void> {
  await chrome.storage.local.set({ [KEY_SNAP]: snap });
}

async function writePrefs(prefs: Prefs): Promise<void> {
  await chrome.storage.local.set({ [KEY_PREFS]: prefs });
}

function resetAlertAxis(s: Snap): void {
  s.alertMs = 0;
}

/** 切段。只有真正站起来才计入起身次数；exit / midnight 只是结算。 */
function closeSegment(s: Snap, rise: boolean, now: number): void {
  s.sittingMs = 0;
  s.segStartAt = now;
  resetAlertAxis(s);
  if (rise) s.standUps += 1;
}

function remainMs(prefs: Prefs, s: Snap): number {
  return Math.max(0, prefs.alertMin * MIN - s.alertMs);
}

function viewOf(prefs: Prefs, s: Snap): StatusView {
  const now = Date.now();
  return {
    snap: s,
    prefs,
    now,
    state: silenceState(prefs, s, now),
    remainMs: remainMs(prefs, s),
  };
}

// badge 数字 + tooltip 是常驻、零打断的「轻」层；系统通知只在警戒时出现。
async function badge(prefs: Prefs, s: Snap): Promise<void> {
  const now = Date.now();
  const state = silenceState(prefs, s, now);
  let text = '';
  let title = '走走 · 久坐提醒';
  let color = '#22241e';
  let ink = '#ffffff';

  if (state === 'on') {
    text = String(Math.max(0, Math.ceil(remainMs(prefs, s) / MIN)));
    title = `走走 · 距警戒 ${text} 分钟`;
  } else if (state === 'paused') {
    text = 'P';
    title = '走走 · 已暂停';
    color = '#9a9a92';
    ink = '#26281f';
  } else if (state === 'offday') {
    text = '休';
    title = '走走 · 休息中';
    color = '#9a9a92';
    ink = '#26281f';
  } else {
    title = '走走 · 已离座';
    color = '#9a9a92';
    ink = '#26281f';
  }

  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeTextColor({ color: ink });
  await chrome.action.setTitle({ title });
}

async function clearNotice(): Promise<void> {
  try {
    await chrome.notifications.clear(ID_ALERT);
  } catch {
    // 已消失，忽略
  }
}

// 同一句提醒看多了会麻木；按当天第几次警戒轮换，喝水挂在「已经站起来」这个节点上。
const COPY = [
  '起来走两步吧。',
  '接杯水，顺便伸个懒腰。',
  '看看窗外，让眼睛歇一会儿。',
  '站起来活动一下肩颈。',
];

async function notify(prefs: Prefs, sittingMs: number, idx: number): Promise<void> {
  try {
    await chrome.notifications.clear(ID_ALERT);
  } catch {
    // 已消失，忽略
  }
  await chrome.notifications.create(ID_ALERT, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: '走走 · 该起身活动一下了',
    message: `已经连续坐了 ${hm(sittingMs)}，${COPY[idx % COPY.length]}`,
    buttons: [{ title: '已起身' }, { title: '暂停 15 分钟' }],
    priority: 2,
    requireInteraction: true,
    silent: !prefs.sound,
  });
}

/** 把状态推进到当前时刻。所有入口（闹钟、消息、通知按钮、空闲变化）都先走它。 */
async function step(): Promise<void> {
  const { prefs, snap } = await read();
  const now = Date.now();
  const dt = Math.max(0, now - snap.updatedAt);
  const gap = Math.max(prefs.idleMin * MIN, GAP_FLOOR_MS);
  const today = dayKey(now);

  // 跨零点：简版只保留当天，旧数据直接翻篇（midnight 不算起身）。
  if (snap.day !== today) {
    const fresh = freshSnap(now, today);
    await write(fresh);
    await badge(prefs, fresh);
    return;
  }

  // 浏览器关掉太久 / 系统睡眠：按桌面版 can_resume 的阈值收口，间隔不补算。
  if (dt > gap) {
    closeSegment(snap, false, now);
    snap.pausedUntil = null;
    snap.present = true;
    snap.updatedAt = now;
    await write(snap);
    await badge(prefs, snap);
    return;
  }

  const idle = await chrome.idle.queryState(Math.max(15, Math.round(prefs.idleMin * 60)));
  const present = idle === 'active';

  if (!present && snap.present) {
    closeSegment(snap, true, now); // 离座算一次起身
    snap.present = false;
    snap.updatedAt = now;
    await write(snap);
    await badge(prefs, snap);
    return;
  }
  if (present && !snap.present) {
    closeSegment(snap, false, now); // 回来开新段，本身不算起身
    snap.present = true;
    snap.updatedAt = now;
    await write(snap);
    await badge(prefs, snap);
    return;
  }
  if (!present) {
    snap.updatedAt = now; // 离座期间停表
    await write(snap);
    await badge(prefs, snap);
    return;
  }

  // 在座：暂停只关提醒，计时照走。
  if (snap.pausedUntil !== null && now >= snap.pausedUntil) snap.pausedUntil = null;
  snap.sittingMs += dt;
  snap.todayMs += dt;
  snap.alertMs += dt;

  let noticeIdx = -1;
  // 抑制期警戒轴照走，但不触发（对齐 state.rs 的 active 判定）。
  if (silenceState(prefs, snap, now) === 'on' && snap.alertMs >= prefs.alertMin * MIN) {
    snap.alertMs = 0;
    noticeIdx = snap.notices ?? 0;
    snap.notices = noticeIdx + 1;
  }

  snap.updatedAt = now;
  await write(snap);
  await badge(prefs, snap);
  if (noticeIdx >= 0) await notify(prefs, snap.sittingMs, noticeIdx);
}

function applyAction(s: Snap, action: Action, now: number): void {
  switch (action) {
    case 'dismiss':
      closeSegment(s, true, now);
      s.present = true;
      break;
    case 'pause':
      s.pausedUntil = now + PAUSE_MS;
      break;
    case 'resume':
      s.pausedUntil = null;
      break;
    case 'skip':
      resetAlertAxis(s); // 把警戒推迟一个阈值周期，不切段
      break;
  }
  s.updatedAt = now;
}

async function handle(msg: Msg): Promise<StatusView> {
  await step(); // 先推进，保证用户动作不会吞掉自上次 tick 起的时间

  if (msg.type === 'action') {
    const { prefs, snap } = await read();
    applyAction(snap, msg.action, Date.now());
    await write(snap);
    await badge(prefs, snap);
    if (msg.action === 'dismiss' || msg.action === 'skip') await clearNotice();
  } else if (msg.type === 'config') {
    const { prefs, snap } = await read();
    const next = clampPrefs(msg.patch, prefs);
    await writePrefs(next);
    await badge(next, snap);
  }

  const { prefs, snap } = await read();
  return viewOf(prefs, snap);
}

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  serial(() => handle(msg))
    .then(sendResponse)
    .catch((e) => sendResponse({ error: String(e) }));
  return true;
});

chrome.notifications.onButtonClicked.addListener((id, index) => {
  if (id !== ID_ALERT) return;
  void serial(async () => {
    await step();
    const { prefs, snap } = await read();
    applyAction(snap, index === 0 ? 'dismiss' : 'pause', Date.now());
    await write(snap);
    await badge(prefs, snap);
    await clearNotice();
  });
});

chrome.notifications.onClicked.addListener((id) => {
  void chrome.notifications.clear(id).catch(() => undefined);
});

chrome.runtime.onInstalled.addListener(() => void serial(step));
chrome.runtime.onStartup.addListener(() => void serial(step));
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) void serial(step);
});
chrome.idle.onStateChanged.addListener(() => void serial(step));

// 同名覆盖，不会累积多个闹钟。Chrome 120+ 支持 0.5 分钟粒度。
void chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
