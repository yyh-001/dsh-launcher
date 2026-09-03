import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import SysTrayModule from 'systray2'
import { startServer, stopAll } from './server.js'

const SysTray = SysTrayModule.default ?? SysTrayModule
const ROOT = dirname(fileURLToPath(import.meta.url))
const ICON = join(ROOT, 'assets', 'icon.ico')
const URL = 'http://127.0.0.1:3780/'

function openPage() {
  if (process.platform === 'win32') {
    execFile('cmd', ['/c', 'start', '', URL], { windowsHide: true })
    return
  }
  execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [URL])
}

function iconBase64() {
  if (!existsSync(ICON)) return ''
  return readFileSync(ICON).toString('base64')
}

async function main() {
  let url
  try {
    url = await startServer()
  } catch (error) {
    if (error && error.code === 'EADDRINUSE') {
      openPage()
      return
    }
    throw error
  }

  openPage()
  const tray = new SysTray({
    menu: {
      icon: iconBase64(),
      title: 'DSH',
      tooltip: 'DSH',
      items: [
        { title: '打开管理页', tooltip: url, enabled: true },
        { title: '退出', tooltip: '', enabled: true },
      ],
    },
    debug: false,
    copyDir: true,
  })

  const quit = async () => {
    try { tray.kill(false) } catch { /* already gone */ }
    await stopAll()
    process.exit(0)
  }

  tray.onClick((action) => {
    if (action.seq_id === 0) openPage()
    if (action.seq_id === 1) void quit()
  })

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => void quit())
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
