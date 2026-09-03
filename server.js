import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installSpec, listPackage } from './registry.js'
import {
  autoStartEnabled,
  browseDirectory,
  ensureSettings,
  loadSettings,
  resolveDataDir,
  safeDataDir,
  saveSettings,
  setAutoStart,
} from './settings.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
let DATA = resolveDataDir()
const PUBLIC = join(ROOT, 'public')
let CONFIG = join(DATA, 'config.json')
const PKG = '@deepseek-ai/dsh'
const MARKET_PKG = 'dshmarket'
const PORT = Number(process.env.PORT || 3780)
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/
const SPEC_RE = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+(?:@[a-z0-9._~+-]+)?$/i
const GITHUB_SPEC_RE = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#[\w./-]+)?$/
const READY_RE = /dsh web:\s+(https?:\/\/[^\s]+)/
const START_TIMEOUT_MS = 120_000

const clients = new Set()
const stateListeners = new Set()
const logs = []
let current = null
let installing = null
let pluginBusy = false
let remoteCache = { at: 0, data: null }
let server = null

function versionDir(version) {
  return join(DATA, 'versions', version)
}

function homeDir() {
  return join(DATA, 'home')
}

function binPath(version) {
  return join(versionDir(version), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

function profileManifest() {
  return join(homeDir(), 'profiles', 'web', 'package.json')
}

function scanInstalled() {
  const root = join(DATA, 'versions')
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(binPath(entry.name)))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

function listedVersions(config) {
  const onDisk = new Set(scanInstalled())
  const fromConfig = (config.versions || [])
    .map((item) => (typeof item === 'string' ? item : item.version))
    .filter((version) => version && onDisk.has(version))
  const extra = [...onDisk].filter((version) => !fromConfig.includes(version))
  return [...fromConfig, ...extra]
}

function safeVersion(version) {
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new Error('非法版本号')
  }
  return version
}

function safeSpec(spec) {
  if (typeof spec !== 'string' || !(SPEC_RE.test(spec) || GITHUB_SPEC_RE.test(spec))) {
    throw new Error('非法插件源')
  }
  return spec
}

async function loadConfig() {
  try {
    return JSON.parse(await readFile(CONFIG, 'utf8'))
  } catch {
    return { versions: [] }
  }
}

async function saveConfig(config) {
  await mkdir(DATA, { recursive: true })
  await writeFile(CONFIG, JSON.stringify(config, null, 2))
}

function pushLog(line) {
  const text = String(line).replace(/\s+$/, '')
  if (!text) return
  logs.push(text)
  if (logs.length > 400) logs.splice(0, logs.length - 400)
  emit('log', { line: text })
}

function emit(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of clients) res.write(payload)
}

async function snapshot() {
  const config = await loadConfig()
  const installed = listedVersions(config)
  return {
    installing,
    installed,
    versions: installed.map((version) => ({
      version,
      status: current?.version === version ? current.status : 'stopped',
      url: current?.version === version ? current.url : null,
    })),
    running: current
      ? { version: current.version, status: current.status, url: current.url }
      : null,
    dataDir: DATA,
  }
}

async function applyDataDir(dir) {
  await mkdir(dir, { recursive: true })
  DATA = dir
  CONFIG = join(DATA, 'config.json')
  pushLog(`数据目录 ${DATA}`)
}

async function publicSettings() {
  const stored = await loadSettings()
  return {
    dataDir: DATA,
    autoStart: await autoStartEnabled(),
    seedMarket: stored.seedMarket !== false,
  }
}

async function saveManagerSettings(body) {
  if (body.dataDir) {
    const dir = safeDataDir(body.dataDir)
    if (dir !== DATA && current) throw new Error('请先停止再改安装位置')
    if (installing) throw new Error('正在安装，稍后再改安装位置')
    await applyDataDir(dir)
  }
  const stored = await saveSettings({
    dataDir: DATA,
    autoStart: Boolean(body.autoStart),
    seedMarket: body.seedMarket !== false,
  })
  try {
    await setAutoStart(stored.autoStart)
  } catch (error) {
    pushLog(`开机自启未写入: ${error instanceof Error ? error.message : error}`)
  }
  if (stored.seedMarket) {
    const versions = listedVersions(await loadConfig())
    if (versions[0] && !pluginBusy) await seedMarket(versions[0])
  }
  await emitState()
  return publicSettings()
}

async function emitState() {
  const snap = await snapshot()
  emit('state', snap)
  for (const listener of stateListeners) {
    try { listener(snap) } catch { /* ignore tray listener errors */ }
  }
}

function spawnDsh(version, extra) {
  const home = homeDir()
  const bin = binPath(version)
  return spawn(process.execPath, [bin, ...extra], {
    cwd: home,
    env: {
      ...process.env,
      DSH_HOME: home,
      npm_config_ignore_workspace_root_check: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

async function ensureProfileNpmrc() {
  const dir = join(homeDir(), 'profiles', 'web')
  await mkdir(dir, { recursive: true })
  const file = join(dir, '.npmrc')
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch {
    text = ''
  }
  if (/(^|\n)ignore-workspace-root-check\s*=/.test(text)) return
  await writeFile(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}ignore-workspace-root-check=true\n`)
}

async function fetchRemote() {
  if (remoteCache.data && Date.now() - remoteCache.at < 60_000) return remoteCache.data
  const info = await listPackage(PKG)
  const data = {
    package: PKG,
    source: 'https://github.com/deepseek-ai/deepseek-harness',
    tags: info.tags,
    versions: info.versions,
  }
  remoteCache = { at: Date.now(), data }
  return data
}

async function installedPlugins() {
  const file = profileManifest()
  if (!existsSync(file)) return []
  try {
    const manifest = JSON.parse(await readFile(file, 'utf8'))
    return Object.keys(manifest.dependencies ?? {}).sort()
  } catch {
    return []
  }
}

async function addPlugin(version, spec) {
  const ver = safeVersion(version)
  const pkg = safeSpec(spec)
  if (pluginBusy) throw new Error('正在安装插件')
  if (!existsSync(binPath(ver))) throw new Error('找不到官方入口 lib/bin.js')

  pluginBusy = true
  await mkdir(homeDir(), { recursive: true })
  await ensureProfileNpmrc()
  pushLog(`安装插件 ${pkg} 到 web profile`)
  try {
    await new Promise((resolve, reject) => {
      const child = spawnDsh(ver, ['plugin', '--profile', 'web', 'add', '-w', pkg])
      child.stdout.on('data', (buf) => {
        for (const line of buf.toString('utf8').split(/\r?\n/)) pushLog(`[plugin] ${line}`)
      })
      child.stderr.on('data', (buf) => {
        for (const line of buf.toString('utf8').split(/\r?\n/)) pushLog(`[plugin] ${line}`)
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`dsh plugin add ${pkg} 退出码 ${code}`))
      })
    })
    pushLog(`${pkg} 已在 web profile`)
  } finally {
    pluginBusy = false
  }
}

async function seedMarket(version) {
  const settings = await loadSettings()
  if (settings.seedMarket === false) return
  const plugins = await installedPlugins()
  if (plugins.includes(MARKET_PKG)) return
  try {
    await addPlugin(version, MARKET_PKG)
  } catch (error) {
    pushLog(`预装 dshmarket 失败: ${error instanceof Error ? error.message : error}`)
  }
}

async function install(version) {
  const ver = safeVersion(version)
  if (installing) throw new Error(`正在安装 ${installing}`)
  const config = await loadConfig()
  if (listedVersions(config).includes(ver) || existsSync(binPath(ver))) {
    if (!listedVersions(config).includes(ver)) {
      config.versions = [ver, ...listedVersions(config)]
      await saveConfig(config)
      await emitState()
    }
    return
  }

  installing = ver
  await emitState()
  const dir = versionDir(ver)
  await mkdir(dir, { recursive: true })
  pushLog(`安装 ${PKG}@${ver}`)
  try {
    await installSpec(dir, PKG, ver, pushLog)
    if (!existsSync(binPath(ver))) throw new Error('安装完成但找不到 lib/bin.js')
    await mkdir(homeDir(), { recursive: true })
    config.versions = [ver, ...listedVersions(config).filter((item) => item !== ver)]
    await saveConfig(config)
    pushLog(`${ver} 安装完成`)
    await seedMarket(ver)
  } catch (error) {
    if (!listedVersions(config).includes(ver)) {
      await rm(dir, { recursive: true, force: true })
    }
    throw error
  } finally {
    installing = null
    await emitState()
  }
}

function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // already gone
  }
}

function attachProcess(version, child) {
  current = { version, child, status: 'starting', url: null }
  const proc = current
  const onChunk = (buf) => {
    const text = buf.toString('utf8')
    for (const line of text.split(/\r?\n/)) {
      pushLog(line)
      const match = line.match(READY_RE)
      if (match && proc.status === 'starting') {
        proc.url = match[1]
        proc.status = 'running'
        emitState()
      }
    }
  }
  child.stdout.on('data', onChunk)
  child.stderr.on('data', onChunk)
  child.on('exit', (code, signal) => {
    pushLog(`已退出 code=${code ?? '-'} signal=${signal ?? '-'}`)
    if (current?.child === child) current = null
    emitState()
  })
  return proc
}

async function waitUntilReady(proc, version) {
  const started = Date.now()
  while (proc.status === 'starting') {
    if (current !== proc) throw new Error(`${version} 启动失败`)
    if (Date.now() - started > START_TIMEOUT_MS) {
      killTree(proc.child.pid)
      throw new Error(`${version} 启动超时`)
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  if (!proc.url) throw new Error(`${version} 启动失败`)
  return { url: proc.url }
}

async function startNow(version) {
  const ver = safeVersion(version)
  if (current?.version === ver && current.status === 'running' && current.url) {
    return { url: current.url }
  }
  if (current?.version === ver && current.status === 'starting') {
    return waitUntilReady(current, ver)
  }
  if (current) await stop()
  const config = await loadConfig()
  if (!listedVersions(config).includes(ver)) throw new Error(`${ver} 未安装`)
  if (!existsSync(binPath(ver))) throw new Error('找不到官方入口 lib/bin.js')

  await mkdir(homeDir(), { recursive: true })
  await seedMarket(ver)
  pushLog(`启动 ${ver} · profile web`)
  const child = spawnDsh(ver, ['web', '--host', '127.0.0.1', '--port', '0', '--no-open'])
  const proc = attachProcess(ver, child)
  await emitState()
  return waitUntilReady(proc, ver)
}

let startChain = Promise.resolve()

async function start(version) {
  const run = startChain.then(() => startNow(version))
  startChain = run.then(() => {}, () => {})
  return run
}

export async function launchInstalled() {
  if (current?.status === 'running' && current.url) {
    return { version: current.version, url: current.url }
  }
  if (current?.status === 'starting' && current.version) {
    const result = await start(current.version)
    return { version: current.version, url: result.url }
  }
  const installed = listedVersions(await loadConfig())
  if (!installed.length) return { version: null, url: null }
  const version = installed[0]
  const result = await start(version)
  return { version, url: result.url }
}

export async function restartInstalled() {
  const version = current?.version
  if (current) await stop()
  if (version) {
    const result = await start(version)
    return { version, url: result.url }
  }
  return launchInstalled()
}

export function onState(listener) {
  stateListeners.add(listener)
  return () => stateListeners.delete(listener)
}

export { snapshot, stop }

async function stop(version) {
  const proc = current
  if (!proc) return
  if (typeof version === 'string' && version && VERSION_RE.test(version) && proc.version !== version) {
    throw new Error(`正在运行的是 ${proc.version}`)
  }
  proc.status = 'stopping'
  await emitState()
  const closed = new Promise((resolve) => proc.child.once('close', resolve))
  killTree(proc.child.pid)
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5000))])
  if (current?.child === proc.child) current = null
  await emitState()
}

async function uninstall(version) {
  const ver = safeVersion(version)
  if (current?.version === ver) throw new Error('请先停止再移除')
  const config = await loadConfig()
  const versions = listedVersions(config)
  if (!versions.includes(ver)) throw new Error(`${ver} 未安装`)
  pushLog(`移除 ${ver}`)
  await rm(versionDir(ver), { recursive: true, force: true })
  config.versions = versions.filter((item) => item !== ver)
  await saveConfig(config)
  await emitState()
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', connection: 'close' })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/remote') {
    send(res, 200, await fetchRemote())
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/settings') {
    send(res, 200, await publicSettings())
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    send(res, 200, await snapshot())
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    if (typeof res.flushHeaders === 'function') res.flushHeaders()
    res.write(`event: log\ndata: ${JSON.stringify({ lines: logs.slice(-120) })}\n\n`)
    res.write(`event: state\ndata: ${JSON.stringify(await snapshot())}\n\n`)
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }

  const body = req.method === 'POST' ? await readJson(req) : {}
  if (req.method === 'POST' && url.pathname === '/api/install') {
    await install(body.version)
    send(res, 200, { ok: true })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/start') {
    send(res, 200, await start(body.version))
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/launch') {
    send(res, 200, await launchInstalled())
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/stop') {
    await stop(body.version)
    send(res, 200, { ok: true })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/uninstall') {
    await uninstall(body.version)
    send(res, 200, { ok: true })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/settings/browse') {
    send(res, 200, { path: await browseDirectory(body.path || DATA) })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/settings') {
    send(res, 200, await saveManagerSettings(body))
    return
  }
  send(res, 404, { error: 'not found' })
}

function mime(path) {
  if (path.endsWith('.css')) return 'text/css'
  if (path.endsWith('.js')) return 'text/javascript'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  return 'text/html'
}

export async function startServer() {
  if (server) return Promise.resolve(`http://127.0.0.1:${PORT}`)
  await ensureSettings()
  DATA = resolveDataDir()
  CONFIG = join(DATA, 'config.json')
  await mkdir(DATA, { recursive: true })
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url)
        return
      }
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
      const path = join(PUBLIC, file)
      if (!path.startsWith(PUBLIC) || !existsSync(path)) {
        send(res, 404, 'not found', 'text/plain; charset=utf-8')
        return
      }
      send(res, 200, await readFile(path, 'utf8'), `${mime(path)}; charset=utf-8`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pushLog(`错误: ${message}`)
      send(res, 500, { error: message })
    }
  })
  return new Promise((resolve, reject) => {
    server.listen(PORT, '127.0.0.1', () => {
      pushLog(`DSH 管理器 http://127.0.0.1:${PORT}`)
      pushLog(`数据目录 ${DATA}`)
      console.log(`dsh-versions: http://127.0.0.1:${PORT}`)
      console.log(`dsh-versions data: ${DATA}`)
      resolve(`http://127.0.0.1:${PORT}`)
    })
    server.on('error', reject)
  })
}

export async function stopAll() {
  if (current) killTree(current.child.pid)
  current = null
  await new Promise((resolve) => server?.close(() => resolve()))
  server = null
}

if (/server\.js$/i.test(process.argv[1] || '')) {
  startServer().catch((error) => {
    console.error(error)
    process.exit(1)
  })
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      stopAll().finally(() => process.exit(0))
    })
  }
}
