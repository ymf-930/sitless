import { invoke } from '@tauri-apps/api/core'
import { useEffect, type ReactNode } from 'react'
import { setLangPref } from './i18n'
import { t, useLang } from './i18n'

// 参考样式：圆形浅灰底 + 实心图标
const ico = (children: ReactNode) => (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
    {children}
  </svg>
)

const I = {
  home: ico(
    <path
      d="M12 3 2.5 11.2c-.4.35-.15 1 .35 1H5v8h5v-6h4v6h5v-8h2.15c.5 0 .75-.65.35-1L12 3z"
      fill="currentColor"
    />,
  ),
  pause: ico(
    <>
      <circle cx="12" cy="12" r="9.2" fill="currentColor" />
      <rect x="9" y="7.8" width="2.3" height="8.4" rx="1.1" fill="#fff" />
      <rect x="12.7" y="7.8" width="2.3" height="8.4" rx="1.1" fill="#fff" />
    </>,
  ),
  skip: ico(
    <path d="M3.5 5.2v13.6L13 12 3.5 5.2zM12 5.2v13.6L21.5 12 12 5.2z" fill="currentColor" />,
  ),
  gear: ico(
    <path
      fill="currentColor"
      d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .43-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.49-.12-.61l-2.01-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z"
    />,
  ),
  exit: ico(
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" fill="currentColor" />
      <path
        d="M9.5 12h7m-2.8-2.8L16.5 12l-2.8 2.8"
        fill="none"
        stroke="#fff"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>,
  ),
}

type Item = { id: string; label: string; icon: ReactNode }

const items: Item[] = [
  { id: 'show', label: t('打开主窗口'), icon: I.home },
  { id: 'pause', label: t('暂停 15 分钟'), icon: I.pause },
  { id: 'skip', label: t('跳过本次提醒'), icon: I.skip },
  { id: 'settings', label: t('设置'), icon: I.gear },
]

export default function TrayMenu() {
  useLang()
  useEffect(() => {
    invoke<{ language: string }>('status')
      .then((s) => setLangPref(s.language))
      .catch(() => {})
  }, [])
  const run = (id: string) => {
    invoke('tray_action', { action: id }).catch(() => {})
  }

  return (
    <div className="tm-wrap">
      <div className="tm-card">
        {items.map((it) => (
          <button key={it.id} className="tm-item" onClick={() => run(it.id)}>
            <span className="tm-ico">{it.icon}</span>
            <span>{it.label}</span>
          </button>
        ))}
        <div className="tm-sep" />
        <button className="tm-item danger" onClick={() => run('quit')}>
          <span className="tm-ico">{I.exit}</span>
          <span>{t('退出')}</span>
        </button>
      </div>
    </div>
  )
}
