import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../dist/sw.js', import.meta.url), 'utf8');

let fakeNow = new Date('2026-11-11T09:00:00').getTime(); // 周三 09:00，工作日
class FakeDate extends Date {
  static now() { return fakeNow; }
}

const store = new Map();
let idleState = 'active';
const notifications = [];
const badgeState = { text: '', bg: '', ink: '' };
const listeners = {};
const addListener = (name) => (cb) => { (listeners[name] ||= []).push(cb); };

const chrome = {
  storage: {
    local: {
      get: async (keys) => {
        const out = {};
        for (const k of Array.isArray(keys) ? keys : [keys]) {
          if (store.has(k)) out[k] = structuredClone(store.get(k));
        }
        return out;
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) store.set(k, structuredClone(v));
      },
    },
  },
  alarms: { create: async () => {}, onAlarm: { addListener: addListener('alarm') } },
  runtime: {
    onInstalled: { addListener: addListener('installed') },
    onStartup: { addListener: addListener('startup') },
    onMessage: { addListener: addListener('message') },
    getURL: (p) => `chrome-extension://fake/${p}`,
  },
  idle: {
    queryState: async () => idleState,
    onStateChanged: { addListener: addListener('idle') },
  },
  notifications: {
    create: async (id, opts) => { notifications.push({ id, opts }); },
    clear: async () => {},
    onButtonClicked: { addListener: addListener('button') },
    onClicked: { addListener: addListener('click') },
  },
  action: {
    setBadgeText: async ({ text }) => { badgeState.text = text; },
    setBadgeBackgroundColor: async ({ color }) => { badgeState.bg = color; },
    setBadgeTextColor: async ({ color }) => { badgeState.ink = color; },
    setTitle: async () => {},
  },
};

vm.runInContext(code, vm.createContext({ chrome, Date: FakeDate, console }), { filename: 'sw.js' });

async function pump() {
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
}
async function msg(m) {
  let out;
  listeners.message[0](m, {}, (r) => { out = r; });
  await pump();
  return out;
}
async function advance(minutes) {
  const steps = Math.round((minutes * 60_000) / 30_000);
  for (let i = 0; i < steps; i++) {
    fakeNow += 30_000;
    await msg({ type: 'status' });
  }
}

let failed = 0;
function assert(ok, label) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) failed++;
}

const idCount = (id) => notifications.filter((n) => n.id === id).length;
const snap = () => store.get('snap');

const first = await msg({ type: 'status' });
assert(!!first && !!first.snap, '首次 status 返回快照');
assert(snap().sittingMs === 0 && snap().standUps === 0, '首次初始化为空段');
assert(badgeState.text === '60', '徽标显示距警戒分钟数');
assert(badgeState.bg === '#22241e' && badgeState.ink === '#ffffff', '计时徽标用近黑墨 + 白字');

await advance(30);
assert(notifications.length === 0, '30 分钟不再发轻提醒');
assert(snap().alertMs >= 30 * 60_000 - 30_000, '警戒轴正常累计');
assert(first.prefs.activityMin === undefined, '配置里已无活动提醒间隔');
assert(first.prefs.quiet === undefined, '配置里已无免打扰时段');

await advance(30);
assert(idCount('zouzou-alert') === 1, '60 分钟触发警戒');
assert(notifications.length === 1, '全程只有一条通知，无轻提醒');
assert(snap().todayMs >= 60 * 60_000 - 60_000, '今日累计随计时增长');

await msg({ type: 'action', action: 'dismiss' });
assert(snap().standUps === 1, '已起身 +1');
assert(snap().sittingMs === 0, '已起身清零当前段');

idleState = 'idle';
await msg({ type: 'status' });
assert(snap().present === false && snap().standUps === 2, '离座切段并算一次起身');

idleState = 'active';
await msg({ type: 'status' });
assert(snap().present === true && snap().standUps === 2, '回来开新段不虚增起身');

fakeNow += 10 * 60_000;
await msg({ type: 'status' });
assert(snap().standUps === 2 && snap().sittingMs === 0, '长断点按 exit 收口，不算起身');

await msg({ type: 'action', action: 'pause' });
const before = snap().todayMs;
notifications.length = 0;
await advance(14);
assert(snap().todayMs > before + 13 * 60_000, '暂停期间计时照走');
assert(notifications.length === 0, '暂停期间不提醒');

fakeNow = new Date('2026-11-12T12:30:00').getTime(); // 周四 12:30，原默认免打扰时段
const noon = await msg({ type: 'status' });
assert(snap().day === '2026-11-12' && snap().todayMs === 0 && snap().standUps === 0, '跨天重置当天数据');
assert(noon.state === 'on', '原免打扰时段不再抑制提醒');
notifications.length = 0;
await advance(61);
assert(idCount('zouzou-alert') === 1, '原免打扰时段内照常触发警戒');

const firstMsg = notifications[0].opts.message;
notifications.length = 0;
await advance(61);
assert(idCount('zouzou-alert') === 1, '第二次警戒照常触发');
assert(notifications[0].opts.message !== firstMsg, '提醒文案轮换，不重复上一句');
assert(snap().notices === 2, '轮换计数按当天累加');

fakeNow = new Date('2026-11-15T10:30:00').getTime(); // 周日，非工作日
const sunday = await msg({ type: 'status' });
assert(sunday.state === 'offday', '周日判定为非工作日');
assert(snap().notices === 0, '跨天重置轮换计数');
notifications.length = 0;
await advance(61);
assert(notifications.length === 0, '非工作日不提醒');
assert(snap().todayMs >= 61 * 60_000 - 60_000, '非工作日仍记录时长');

const v = await msg({ type: 'config', patch: { alertMin: 999, idleMin: 99 } });
assert(v.prefs.alertMin === 180 && v.prefs.idleMin === 15, '配置越界被钳制');

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}`);
process.exitCode = failed ? 1 : 0;
