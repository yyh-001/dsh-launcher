import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import SysTrayModule from 'systray2'
import {
  launchInstalled,
  onState,
  restartInstalled,
  setHost,
  snapshot,
  startServer,
  stop,
  stopAll,
} from './server.js'

const SysTray = SysTrayModule.default ?? SysTrayModule
const ROOT = dirname(fileURLToPath(import.meta.url))
const ICON = existsSync(join(ROOT, 'assets', 'tray.ico'))
  ? join(ROOT, 'assets', 'tray.ico')
  : join(ROOT, 'assets', 'icon.ico')
const MANAGER_URL = 'http://127.0.0.1:3780/'
const LOG_DIR = process.env.APPDATA ? join(process.env.APPDATA, 'DSH') : join(ROOT, 'data')
const LOG = join(LOG_DIR, 'manager.log')

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((item) => (item instanceof Error ? item.stack || item.message : String(item))).join(' ')}\n`
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(LOG, line)
  } catch { /* ignore */ }
  console.error(...args)
}

function openPage(target = MANAGER_URL) {
  if (process.platform === 'win32') {
    execFile('cmd', ['/c', 'start', '', target], { windowsHide: true })
    return
  }
  execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [target])
}

function iconBase64() {
  if (!existsSync(ICON)) return ''
  return readFileSync(ICON).toString('base64')
}

function runningOf(snap) {
  return snap?.running && snap.running.version ? snap.running : null
}

async function wakeExisting() {
  try {
    const res = await fetch(`${MANAGER_URL}api/wake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) return true
    log(`唤醒托盘失败 HTTP ${res.status}`)
  } catch (error) {
    log('唤醒托盘失败', error)
  }
  return false
}

async function main() {
  log('启动管理器', ROOT, ICON)
  let url
  try {
    url = await startServer()
  } catch (error) {
    if (error && error.code === 'EADDRINUSE') {
      log('端口 3780 已被占用，通知已在运行的实例重建托盘')
      await wakeExisting()
      openPage(MANAGER_URL)
      try {
        const res = await fetch(`${MANAGER_URL}api/state`, { cache: 'no-store', signal: AbortSignal.timeout(3000) })
        const data = await res.json()
        if (data.running?.url) openPage(data.running.url)
      } catch { /* manager page is enough */ }
      return
    }
    throw error
  }

  openPage(MANAGER_URL)
  launchInstalled().then((result) => {
    if (result.url) openPage(result.url)
  }).catch((error) => {
    log(error)
  })

  const itemOpenDsh = {
    title: '打开 DSH',
    tooltip: '',
    enabled: false,
    click: () => {
      const href = itemOpenDsh.tooltip
      if (href && href.startsWith('http')) openPage(href)
    },
  }
  const itemToggle = {
    title: '启动',
    tooltip: '启动 DSH',
    enabled: false,
    click: async () => {
      try {
        const snap = await snapshot()
        const running = runningOf(snap)
        if (running && (running.status === 'running' || running.status === 'starting')) {
          await stop(running.version)
          return
        }
        const result = await launchInstalled()
        if (result.url) openPage(result.url)
      } catch (error) {
        console.error(error)
      }
    },
  }
  const itemRestart = {
    title: '重启',
    tooltip: '重启 DSH',
    enabled: false,
    click: async () => {
      try {
        const result = await restartInstalled()
        if (result?.url) openPage(result.url)
      } catch (error) {
        console.error(error)
      }
    },
  }
  const itemManager = {
    title: '打开管理页',
    tooltip: url,
    enabled: true,
    click: () => openPage(MANAGER_URL),
  }
  const itemQuit = {
    title: '退出',
    tooltip: '',
    enabled: true,
    click: () => void quit(),
  }

  const menu = {
    icon: iconBase64(),
    title: 'DSH',
    tooltip: 'DSH',
    items: [
      itemOpenDsh,
      itemToggle,
      itemRestart,
      SysTray.separator,
      itemManager,
      itemQuit,
    ],
  }

  let tray = null
  let trayGen = 0
  let quitting = false

  function trayAlive() {
    const child = tray?.process
    return Boolean(child && child.exitCode == null && !child.killed)
  }

  function applyTray(snap) {
    if (!trayAlive()) return
    const running = runningOf(snap)
    const status = running?.status
    const live = status === 'running' || status === 'starting'
    const installed = Array.isArray(snap.installed) && snap.installed.length > 0
    const href = status === 'running' && running.url ? running.url : ''

    itemOpenDsh.enabled = Boolean(href)
    itemOpenDsh.tooltip = href
    itemToggle.title = live ? '停止' : '启动'
    itemToggle.tooltip = live ? '停止 DSH' : installed ? '启动 DSH' : '尚未安装'
    itemToggle.enabled = installed && status !== 'stopping'
    itemRestart.enabled = status === 'running'
    void tray.sendAction({ type: 'update-item', item: itemOpenDsh })
    void tray.sendAction({ type: 'update-item', item: itemToggle })
    void tray.sendAction({ type: 'update-item', item: itemRestart })
  }

  async function ensureTray() {
    if (quitting || trayAlive()) return
    const gen = ++trayGen
    log('启动托盘')
    const next = new SysTray({
      menu,
      debug: false,
      copyDir: false,
    })
    tray = next
    next.onClick((action) => {
      if (typeof action.item?.click === 'function') action.item.click()
    })
    try {
      await Promise.race([
        next.ready(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('托盘启动超时')), 8000)),
      ])
      if (next.process) {
        next.onExit(() => {
          if (quitting || gen !== trayGen) return
          log('托盘进程已退出，将重新创建')
          if (tray === next) tray = null
          setTimeout(() => { void ensureTray() }, 800)
        })
      }
    } catch (error) {
      log(error)
      if (gen === trayGen && !quitting && !trayAlive()) {
        setTimeout(() => { void ensureTray() }, 1500)
      }
    }
    if (gen === trayGen && !quitting) applyTray(await snapshot())
  }

  const quit = async () => {
    if (quitting) return
    quitting = true
    log('正在退出')
    await Promise.race([
      stopAll(),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ])
    try { tray?.kill(false) } catch { /* already gone */ }
    process.exit(0)
  }

  setHost({ onWake: () => ensureTray() })
  onState(applyTray)
  await ensureTray()

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => void quit())
  }
}

main().catch((error) => {
  log(error)
  process.exit(1)
})
