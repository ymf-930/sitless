/** 界面语言：中文原文即 key，英文由字典提供；auto 跟随系统语言。 */
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export type Lang = 'zh' | 'en'
export type LangPref = 'auto' | 'zh' | 'en'

/** 中文原文 → 英文。未收录的条目保持中文，避免界面出现空白。 */
const EN: Record<string, string> = {
  ' 提醒已暂停。': ' Reminders paused.',
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
  '今天打算起身几次': 'Breaks you plan to take today',
  '今日': 'Today',
  '今日时间线': 'Today timeline',
  '今日第 {n} 段': 'Segment {n} today',
  '今日起身目标': 'Daily break goal',
  '从第一次打开本应用算起': 'Since the app was first opened',
  '休息前确认': 'Confirm before break',
  '休息时段': 'Quiet hours',
  '你已连续坐了很久。': "You've been sitting for a long time.",
  '保存': 'Save',
  '倒计时结束前不能清零重计；关闭和暂停随时可用':
    'Reset is locked until the countdown ends; close and pause stay available',
  '倒计时结束前不能清零重计；赶时间可以跳过或暂停。':
    'Reset is locked until the countdown ends. In a hurry? Skip or pause.',
  '偏好设置': 'Preferences',
  '全屏抑制': 'Fullscreen suppression',
  '全屏时抑制提醒': 'Suppress reminders in fullscreen',
  '六': 'Sat',
  '关闭': 'Off',
  '关闭提示音': 'Turn sound off',
  '关闭提醒': 'Turn reminders off',
  '出现即可关闭。': 'Can be dismissed immediately.',
  '分钟': 'min',
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
  '当前不锁，出现即可清零重计': 'No lock — reset works as soon as it appears',
  '当前配置': 'Current settings',
  '恢复计时': 'Resume timer',
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
  '木鱼': 'Woodblock',
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
  '检测到你在电脑前，新的一段正在累计。': 'You are back at the desk; a new segment is counting.',
  '次': 'times',
  '次封顶': 'max',
  '段': 'segments',
  '每日目标': 'Daily goal',
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
  '秒后可清零重计': 's until reset is available',
  '站起来走 1 分钟，或者做两个伸展。点「已起身」会把计时清零。':
    'Walk for a minute or do two stretches. Tap "Got up" to reset the timer.',
  '第': 'No.',
  '系统通知': 'System notification',
  '水滴': 'Droplet',
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
  '跨零点的那一段会被拆成两段，分别记在两天。缺记录的日子在图上画成淡色占位，不会被跳过。':
    'Segments crossing midnight split into two days. Days without data show as faint placeholders instead of being skipped.',
  '跳过': 'Skip',
  '跳过本次并关闭': 'Skip this one and close',
  '跳过本次提醒': 'Skip this reminder',
  '跳过本次（关闭）': 'Skip this one (close)',
  '软提示': 'Soft',
  '轻提醒以什么形式出现': 'How gentle reminders appear',
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
