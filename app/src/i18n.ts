/** 界面语言：中文原文即 key，英文由字典提供；auto 跟随系统语言。 */
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export type Lang = 'zh' | 'en'
export type LangPref = 'auto' | 'zh' | 'en'

/** 中文原文 → 英文。未收录的条目保持中文，避免界面出现空白。 */
const EN: Record<string, string> = {
  'CSV，含每日时长、提醒次数与段明细': 'CSV with daily totals, reminder counts and segment details',
  '{d} 开始': 'Started {d}',
  '{n} 分钟': '{n} min',
  '{n} 秒': '{n} s',
  '{n} 秒后才可关闭。': 'Can be dismissed after {n} s.',
  '{n} 项': '{n} items',
  '今日目标 {n}': 'Daily goal {n}',
  '一': 'Mon',
  '七天合计': '7-day total',
  '三': 'Wed',
  '下一次提醒在 {n} 分钟后': 'Next reminder in {n} min',
  '下一次提醒马上就到': 'Next reminder is due now',
  '不做强制等待。': 'No forced wait.',
  '不到 1 分钟': 'less than 1 min',
  '不选的日子不提醒，但仍记录时长': 'Unselected days: no reminders, still tracked',
  '不锁': 'No lock',
  '中文': 'Chinese',
  '主窗口': 'Main window',
  '主窗口提醒': 'Main window reminder',
  '久坐警戒': 'Sedentary alert',
  '久坐警戒 · 阈值 {n} 分钟': 'Sedentary alert · threshold {n} min',
  '久坐警戒阈值': 'Sedentary alert threshold',
  '二': 'Tue',
  '五': 'Fri',
  '五个常用项放在外面，其余收进高级。改完立即生效。':
    'Five common options up front, the rest under Advanced. Changes apply immediately.',
  '今天坐了 {d}': 'Sat {d} today',
  '今天的第一段从这里开始。': 'The first segment of today starts here.',
  '今天打算起身几次': 'Breaks you plan to take today',
  '今日': 'Today',
  '今日时间线': 'Today timeline',
  '今日第 {n} 段': 'Segment {n} today',
  '今日起身目标': 'Daily break goal',
  '从第一次打开本应用算起': 'Since the app was first opened',
  '休息前确认': 'Confirm before break',
  '休息时段': 'Quiet hours',
  '屏幕看太久了': 'Too long at the screen',
  '抬头看看窗外，眼睛也要喘口气。': 'Look out the window — your eyes need a breather too.',
  '颈椎想放假': 'Your neck wants a day off',
  '扶着椅背，慢慢转两圈肩膀。': 'Hold the chair back and roll your shoulders slowly.',
  '起身倒杯热的': 'Go get something warm to drink',
  '顺便把小腿活动开。': 'And stretch your calves while you are up.',
  '坐满这一节了': 'That is one session done',
  '站起来伸伸腿，别让血都憋在腰上。': 'Stand up and stretch — do not let blood pool at your waist.',
  '身体不是工位': 'Your body is not a workstation',
  '椅子坐久了，腰在替你付账。': 'Sit long enough and your lower back pays the bill.',
  '还有下半场': 'Still a second half to go',
  '现在动两分钟，晚上还留得住精神。': 'Two minutes now keeps your evening energy intact.',
  '给腰放个假': 'Give your back a break',
  '它已经替你扛了一上午。': 'It has carried you all morning.',
  '别等疼了才动': 'Do not wait for the pain',
  '久坐的账，最后都要还。': 'The bill for sitting always comes due.',
  '别把身体当耗材': "Don't treat your body as consumable",
  '公司是老板的，身体是自己的。': 'The company belongs to your boss; your body is yours.',
  '起来接杯水': 'Go grab some water',
  '顺便让眼睛也看看远处。': 'And let your eyes look into the distance.',
  '肩颈在报警': 'Your neck is complaining',
  '转两圈脖子，比贴膏药管用。': 'Roll your neck twice — better than a pain patch.',
  '腰先撑不住了': 'Your back gives up first',
  '站起来动一动，比硬扛划算。': 'A short break beats gritting your teeth.',
  '该活动一下了': 'Time to move around',
  '肩颈和腰都该换个姿势。': 'Neck, shoulders and back all need a change of posture.',
  '站起来伸个懒腰': 'Stand up and stretch',
  '连续坐太久，注意力也会变差。': 'Sitting too long dulls your focus as well.',
  '走两分钟再回来': 'Walk for two minutes',
  '起身活动一下，血液循环会好很多。': 'A short walk gets your blood moving again.',
  '你已连续坐了很久。': "You've been sitting for a long time.",
  '保存': 'Save',
  '倒计时结束前不能清零重计；关闭和暂停随时可用':
    'Reset is locked until the countdown ends; close and pause stay available',
  '秒后可清零重计，也可直接暂停或跳过': 's until reset — or pause/skip right away',
  '偏好设置': 'Preferences',
  '全屏抑制': 'Fullscreen suppression',
  '全屏时抑制提醒': 'Suppress reminders in fullscreen',
  '六': 'Sat',
  '关闭': 'Off',
  '关闭提示音': 'Turn sound off',
  '关闭提醒': 'Turn reminders off',
  '出现即可关闭。': 'Can be dismissed immediately.',
  '分钟': 'min',
  '已坐 · 分钟': 'min seated',
  '诊断信息': 'Diagnostics',
  '诊断文件已导出到下载目录': 'Diagnostics saved to Downloads',
  '时': 'Hour',
  '分': 'Min',
  '切换休息前确认': 'Toggle confirm before break',
  '切换全屏抑制': 'Toggle fullscreen suppression',
  '切换开机自启动': 'Toggle launch at login',
  '切换提示音': 'Toggle sound',
  '切换操作检测提示音': 'Toggle presence beep',
  '删除该时段': 'Delete this quiet period',
  '历史': 'History',
  '取消': 'Cancel',
  '可以清零重计了': 'You can reset the timer now',
  '右上角轻提示，不抢焦点，不响铃打断。': 'A subtle toast in the top right; no focus steal, no interruption.',
  '同一轮提醒最多弹几次，之后静默': 'Max repeats in one cycle before going silent',
  '周一': 'Mon',
  '周三': 'Wed',
  '周二': 'Tue',
  '周五': 'Fri',
  '周六': 'Sat',
  '周四': 'Thu',
  '周日': 'Sun',
  '四': 'Thu',
  '坐姿总时长': 'Total sitting time',
  '天': 'days',
  '导出': 'Export',
  '导出数据': 'Export data',
  '就要打断你了': 'About to interrupt you',
  '峰值在 {w}，{d}。': 'Peak on {w}, {d}.',
  '工作日': 'Workdays',
  '已导出到下载目录': 'Exported to Downloads',
  '已记录 {a} 段，起身 {b} 次，最长连续 {d}。': '{a} segments, {b} breaks, longest stretch {d}.',
  '已记录 {n} 段': '{n} segments logged',
  '已起身': 'Got up',
  '已起身，清零重计': 'Got up — reset timer',
  '已连续 {d}': 'Sitting {d}',
  '已连续坐 {d}': 'Sitting {d}',
  '开启': 'On',
  '开启提示音': 'Turn sound on',
  '开机自启': 'Launch at login',
  '开机自启动': 'Launch at login',
  '开始': 'Start',
  '开始时间': 'Start time',
  '开始与结束不能相同': 'Start and end cannot be the same',
  '结束早于开始表示跨零点，例如 22:00—06:00':
    'An end earlier than the start crosses midnight, e.g. 22:00–06:00',
  '当前不锁，出现即可清零重计': 'No lock — reset works as soon as it appears',
  '当前配置': 'Current settings',
  '恢复计时': 'Resume timer',
  '提醒已暂停': 'Reminders paused',
  '今天是休息日': 'Rest day today',
  '休息时段 · 暂不提醒': 'Quiet hours - no reminders',
  '已离座': 'Away from desk',
  '提醒已关闭': 'Reminders off',
  '久坐仍在累计': 'Sitting time still counting',
  '下个工作日自动恢复': 'Resumes on the next workday',
  '{d} 恢复提醒': 'Reminders resume at {d}',
  '回到座位后继续': 'Resumes when you return',
  '今天不在所选工作日，提醒不会弹出，时长照常记录。': 'Today is not a selected workday; no reminders, but sitting time is still recorded.',
  '当前处于休息时段，提醒不会弹出，时长照常记录。': 'Quiet hours are active; no reminders, but sitting time is still recorded.',
  '检测到你已离开，计时与提醒都暂时停下。': 'You stepped away; tracking and reminders are paused.',
  '休息日': 'Rest day',
  '免打扰': 'Quiet hours',
  '打开主窗口': 'Open main window',
  '打开所在文件夹': 'Open containing folder',
  '提醒声音': 'Reminder sound',
  '提醒暂不弹出，久坐仍在累计。': 'Reminders paused; sitting time still counts.',
  '提醒次数': 'Reminders',
  '提醒被忽略后，隔多久再弹一次': 'How long to wait before repeating an ignored reminder',
  '提醒窗口': 'Alert window',
  '操作检测提示音': 'Presence beep',
  '收进托盘': 'Minimize to tray',
  '改完立即生效，不需要重启应用。': 'Changes apply immediately; no restart needed.',
  '数据存在本地 SQLite，不上传、不联网。改过的配置也存同一份库。':
    'Data stays in a local SQLite file; nothing is uploaded. Settings live in the same file.',
  '新时段开始': 'New segment started',
  '新时段结束': 'New segment end',
  '无': 'None',
  '无输入超过即算离座，计时归零': 'No input for this long counts as away and resets the timer',
  '日': 'Sun',
  '日均': 'Daily average',
  '日均 {d}': 'Avg {d}/day',
  '时长按段累加，同一段反复写入不会重复计数。':
    'Time is summed per segment; repeated writes of one segment never double count.',
  '时间与范围': 'Time & scope',
  '木琴': 'Marimba',
  '暂停': 'Pause',
  '暂停 15 分钟': 'Pause 15 min',
  '最久的一天': 'Longest day',
  '最小化': 'Minimize',
  '最近 7 天': 'Last 7 days',
  '最长连续': 'Longest stretch',
  '有记录的天数': 'Days with data',
  '未响应重复间隔': 'Repeat interval',
  '未响应重申': 'Repeat when ignored',
  '未响应重申次数': 'Max repeats',
  '未计入起身': 'Not counted as a break',
  '次': 'times',
  '次封顶': 'max',
  '段': 'segments',
  '每日目标': 'Daily goal',
  '每格 {n} 分钟': '{n} min per block',
  '每隔多久做一次轻提醒': 'How often to show a gentle reminder',
  '活动提醒 · 每 {n} 分钟': 'Activity reminder · every {n} min',
  '活动提醒间隔': 'Activity reminder interval',
  '添加': 'Add',
  '清空': 'Clear',
  '清空全部记录': 'Erase all records',
  '演示模式下不写文件': 'Demo mode does not write files',
  '独立音量，点音色可试听，不受系统通知音设置影响':
    'Separate volume; click a tone to preview. Independent of system notification sounds.',
  '现在': 'Now',
  '界面语言': 'Language',
  '登录后静默启动到托盘，不弹主窗': 'Start silently to the tray after login, without opening the main window',
  '目标 · 工作日 · 免打扰': 'Goal · Workdays · Quiet hours',
  '确认清空': 'Confirm erase',
  '离座判定': 'Away detection',
  '离座或回到座位时轻响一声': 'A short beep when you leave or return',
  '秒': 's',
  '站起来走 1 分钟，或者做两个伸展。点「已起身」会把计时清零。':
    'Walk for a minute or do two stretches. Tap "Got up" to reset the timer.',
  '第': 'No.',
  '系统通知': 'System notification',
  '铃': 'Bell',
  '结束时间': 'End time',
  '统计与历史一并删除，不可恢复': 'Deletes stats and history permanently',
  '置顶窗': 'Always-on-top window',
  '警戒窗出现后先锁 {d}，防止顺手关掉': 'Lock the alert for {d} so it is not dismissed absent-mindedly',
  '警戒窗强制倒计时': 'Forced countdown on alert',
  '警戒预览': 'Preview alert',
  '计时已归零': 'Timer reset',
  '设置': 'Settings',
  '试听音量': 'Preview volume',
  '该起身活动一下了': 'Time to get up and move',
  '走走': 'Zouzou',
  '起来走两步': 'Get up and walk',
  '起身次数': 'Breaks taken',
  '跟随系统': 'System default',
  '跨零点的那一段会被拆成两段，分别记在两天。没有记录的日子在图上留空，不补零。':
    'Segments crossing midnight split into two days. Days without data stay blank instead of showing fake bars.',
  '只有离座或点了「已起身」才算起身次数，跨零点与退出结算不计入。':
    'Only leaving the desk or tapping "I stood up" counts as a break; midnight and quit settlements do not.',
  '当天还没走完，不计入日均、达标与环比，只出现在柱图上。':
    'Today is not finished, so it is left out of the average, goal days and period comparison — it only appears on the chart.',
  '已结算': 'Settled',
  '全屏': 'Fullscreen',
  '全屏中 · 暂不提醒': 'Fullscreen · on hold',
  '检测到全屏播放，提醒先压住；退出后会补一条汇总，不会连发。':
    'Fullscreen playback detected. Reminders are held back and summarized once when you leave fullscreen.',
  '退出全屏后汇总补发': 'One summary after leaving fullscreen',
  '跳过': 'Skip',
  '跳过本次并关闭': 'Skip this one and close',
  '跳过本次提醒': 'Skip this reminder',
  '跳过本次（关闭）': 'Skip this one (close)',
  '软提示': 'Soft',
  '活动提醒': 'Activity reminder',
  // 历史页
  '最近 {n} 天': 'Last {n} days',
  '{n} 天': '{n} days',
  '总时长': 'Total sitting',
  '{n} 天合计': '{n}-day total',
  '{n} 天有记录': 'data on {n} day(s)',
  '单次没起身的最久一段': 'Longest single stretch',
  '达标天数': 'Goal met',
  '目标 每天 {n} 次起身': 'Goal: {n} breaks/day',
  '环比上一周期': 'vs previous period',
  '少坐 {d}': '{d} less',
  '多坐 {d}': '{d} more',
  '暂无对比数据': 'No comparison data yet',
  '与上一周期基本持平': 'About the same as the previous period',
  '基本持平': 'About the same',
  '比上一周期少坐 {d}': '{d} less than the previous period',
  '比上一周期多坐 {d}': '{d} more than the previous period',
  '连续 {n} 天达标': '{n} days on goal',
  '时段分布': 'Time of day',
  '哪几个小时坐得最久（不含今天）': 'When you sit the most (today excluded)',
  '累计 {d}': '{d} in total',
  '最近 {n} 天里（不含今天），{h}:00–{h2}:00 累计坐得最久，共 {d}。': 'Over the last {n} days (today excluded), {h}:00–{h2}:00 adds up to the most sitting, {d} in total.',
  '逐日明细': 'Daily breakdown',
  '无记录': 'No data',
  '起身 {n} 次': '{n} breaks',
  '提醒 {n} 次': '{n} reminders',
  '最长 {d}': 'longest {d}',
  '查看全部 {n} 天': 'Show all {n} days',
  '收起': 'Show less',
  '统计口径': 'How these are calculated',
  '轻提醒以什么形式出现；置顶窗为不抢焦点的小浮窗，警戒始终是完整弹窗': 'How light reminders appear; always-on-top is a small non-focusing card, alerts keep the full window',
  '还有 {d}': '{d} left',
  '还没有记录，坐一会儿就有了。': 'No records yet — sit for a while and they will show up.',
  '还没有足够的数据。': 'Not enough data yet.',
  '这一段已经 {d}，计时未中断。': 'This segment is {d} and still counting.',
  '这一段连续坐了 {d}。': 'This stretch lasted {d}.',
  '这段时间内不打扰': 'No interruptions during this period',
  '这组数字怎么来的': 'How these numbers are calculated',
  '进行中': 'In progress',
  '连续坐多久触发置顶警戒窗': 'Sitting time before an always-on-top alert',
  '连续坐满阈值会弹置顶窗，': 'Reaching the threshold opens an always-on-top window. ',
  '退出': 'Quit',
  '退出全屏后汇总补发一条': 'One summary reminder after leaving fullscreen',
  '需先打开上面的「休息前确认」': 'Requires "Confirm before break" above',
  '预览': 'Preview',
  '高级': 'Advanced',
  '默认跟随系统，切换后立即生效': 'Follows the system by default; applies immediately',
  '（已设为不锁）': '(no lock)',
  // 今日页：一次性首启说明 + 两张跨天结论卡
  '走走已经开始记录：连续坐 {a} 分钟轻提醒一次，{b} 分钟弹出警戒窗。':
    'Zouzou is tracking now: a gentle nudge every {a} min, an always-on-top alert at {b} min.',
  '知道了': 'Got it',
  '连续达标': 'Days on goal',
  '近 7 天最长连续': 'Longest stretch, last 7 days',
  '每日目标 {n} 次起身': 'Daily goal: {n} breaks',
  '今天最长 {d}': 'Today longest: {d}',
  '满 1 天后开始统计': 'Available after the first full day',
  '站起来走 1 分钟，或者做两个伸展。点「已起身」会把计时清零，先忙就别管它。':
    'Walk for a minute or do two stretches. "I stood up" resets the timer; if you are busy, just ignore this.',
}

let current: Lang = 'zh'
const listeners = new Set<(v: Lang) => void>()

export function resolveLang(pref: string): Lang {
  if (pref === 'zh' || pref === 'en') return pref
  return (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export function setLangPref(pref: string) {
  const next = resolveLang(pref)
  document.documentElement.lang = next
  if (next !== current) {
    current = next
    listeners.forEach((fn) => fn(current))
  }
  // 后端系统通知 / 托盘提示 / CSV 表头也要跟着切；浏览器演示模式下忽略异常
  void invoke('set_ui_language', { lang: next }).catch(() => {})
}

export function currentLang(): Lang {
  return current
}

/** 根组件订阅一次即可：父组件重渲染会带动整棵子树刷新文案 */
export function useLang(): Lang {
  const [v, setV] = useState(current)
  useEffect(() => {
    listeners.add(setV)
    return () => {
      listeners.delete(setV)
    }
  }, [])
  return v
}

/** 翻译；{name} 占位符由 vars 代入 */
export function t(s: string, vars?: Record<string, string | number>): string {
  let out = current === 'en' ? (EN[s] ?? s) : s
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.replaceAll(`{${k}}`, String(v))
    }
  }
  return out
}

/** 浏览器演示模式下没有 Tauri 事件，忽略即可 */
listen<string>('lang://changed', (e) => setLangPref(e.payload)).catch(() => {})
