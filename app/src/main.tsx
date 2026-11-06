import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import Alert from './Alert.tsx'
import TrayMenu from './TrayMenu.tsx'
import { applyAccent } from './accent'
import { setLangPref } from './i18n'

const win = new URLSearchParams(window.location.search).get('win')
const isAlert = win === 'alert'
const isTrayMenu = win === 'traymenu'
document.body.dataset.win = isAlert ? 'alert' : isTrayMenu ? 'tray-menu' : 'main'
applyAccent(win === null) // 只有主窗随机选主色，其它窗口沿用主窗写入的值
setLangPref(localStorage.getItem('sitless.language') ?? 'auto')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isAlert ? <Alert /> : isTrayMenu ? <TrayMenu /> : <App />}
  </StrictMode>,
)
