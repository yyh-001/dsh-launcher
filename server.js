import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cmpVer, installSpec, listPackage, parseVer } from './registry.js'
import pkg from './package.json' with { type: 'json' }
import {
  disableRowId,
  listPlugins,
  ownerOfRow,
  parseFailedRows,
  setPluginEnabled,
} from './plugins.js'
import {
  autoStartEnabled,
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
const APP_VERSION = String(pkg.version || '0.0.0')
const APP_REPO = 'yyh-001/dsh-launcher'
const APP_SETUP = 'DSH-Setup.exe'
const PORT = Number(process.env.PORT || 3780)
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/
const SPEC_RE = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+(?:@[a-z0-9._~+-]+)?$/i
const GITHUB_SPEC_RE = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#[\w./-]+)?$/
const READY_RE = /dsh web:\s+(https?:\/\/[^\s]+)/
const START_TIMEOUT_MS = 120_000
const PROFILE_NAME = 'web'
const LOG_DIR = process.env.APPDATA ? join(process.env.APPDATA, 'DSH') : join(ROOT, 'data')
const LOG_FILE = join(LOG_DIR, 'manager.log')
const LOG_MAX_BYTES = 5 * 1024 * 1024
const NOISY_LOG_RE = /^(?:已安装 \d+\/\d+|已解析 \d+)/

const clients = new Set()
const stateListeners = new Set()
let host = {
  onWake: async () => {},
}
const logs = []
let current = null
let installing = null
let installProgress = null
let pluginBusy = false
let remoteCache = { at: 0, data: null }
let selfCache = { at: 0, data: null }
let server = null
/** 最近一次启动失败的上下文（错误 + 子进程输出尾巴）。 */
let lastFailure = null
/** 最近一次启动后的页面自检结果（客户端插件包是否都拉得动）。 */
let lastHealth = null
/** 需要在日志里打码的敏感串（如 API key）。 */
let secretValues = []

/** 把 key 之类的敏感串从任意文本里抹掉（dsh 的凭据常出现在子进程输出里）。 */
function redact(text, secrets = []) {
  let out = String(text ?? '')
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join('sk-***')
  }
  return out.replace(/\b(sk|ak)-[A-Za-z0-9_-]{8,}/g, '$1-***')
}

function versionDir(version) {
  return join(DATA, 'versions', version)
}

function homeDir() {
  return join(homedir(), '.dsh')
}

function managedBin(version) {
  return join(versionDir(version), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

function systemNpmRoots() {
  const roots = []
  const seen = new Set()
  const add = (dir) => {
    if (!dir || seen.has(dir)) return
    seen.add(dir)
    roots.push(dir)
  }
  if (process.env.APPDATA) add(join(process.env.APPDATA, 'npm', 'node_modules'))
  if (process.env.LOCALAPPDATA) add(join(process.env.LOCALAPPDATA, 'npm', 'node_modules'))
  if (process.env.npm_config_prefix) add(join(process.env.npm_config_prefix, 'node_modules'))
  for (const key of ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)']) {
    const base = process.env[key]
    if (base) add(join(base, 'nodejs', 'node_modules'))
  }
  add('/usr/local/lib/node_modules')
  add(join(homedir(), '.npm-global', 'lib', 'node_modules'))
  return roots
}

function detectSystemDsh() {
  for (const root of systemNpmRoots()) {
    const pkgRoot = join(root, '@deepseek-ai', 'dsh')
    const bin = join(pkgRoot, 'lib', 'bin.js')
    const pkgFile = join(pkgRoot, 'package.json')
    if (!existsSync(bin) || !existsSync(pkgFile)) continue
    try {
      const version = String(JSON.parse(readFileSync(pkgFile, 'utf8')).version || '')
      if (!VERSION_RE.test(version)) continue
      return { version, bin, root: pkgRoot }
    } catch {
      continue
    }
  }
  return null
}

function isManaged(version) {
  return existsSync(managedBin(version))
}

function binPath(version) {
  if (isManaged(version)) return managedBin(version)
  const system = detectSystemDsh()
  if (system?.version === version) return system.bin
  return managedBin(version)
}

function profileManifest() {
  return join(profileDir(), 'package.json')
}

function scanInstalled() {
  const found = []
  const root = join(DATA, 'versions')
  if (existsSync(root)) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(managedBin(entry.name))) found.push(entry.name)
      }
    } catch {
      // ignore unreadable versions dir
    }
  }
  const system = detectSystemDsh()
  if (system && !found.includes(system.version)) found.push(system.version)
  return found
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

/** 保留的版本数：最新的一个 + 最近装的一个（回退用）。 */
const KEEP_VERSIONS = 2

/**
 * 装完新版后清理旧版本：只留最新的和上一个，正在运行的除外。
 * @returns 被清理掉的版本号
 */
async function pruneVersions(config) {
  const versions = listedVersions(config)
  if (versions.length <= KEEP_VERSIONS) return []
  const keep = new Set(versions.slice(0, KEEP_VERSIONS))
  if (current?.version) keep.add(current.version)
  const removed = []
  for (const version of versions) {
    if (keep.has(version)) continue
    if (!isManaged(version)) continue // 系统装的 dsh 不归启动器管
    try {
      await rm(versionDir(version), { recursive: true, force: true })
      removed.push(version)
      pushLog(`清理旧版本 ${version}（保留 ${[...keep].join('、')}）`)
    } catch (error) {
      pushLog(`清理 ${version} 失败：${error instanceof Error ? error.message : error}`)
    }
  }
  if (removed.length) {
    config.versions = listedVersions(config)
    await saveConfig(config)
  }
  return removed
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

/** 把重要日志追加到 manager.log（进度类噪音行丢弃，超过 5MB 轮转一次）。 */
function persistLog(text) {
  if (NOISY_LOG_RE.test(text)) return
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`)
  } catch {
    // 目录/轮转问题不阻塞启动流程
  }
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${text}\n`)
  } catch {
    // 落盘失败不阻塞
  }
}

function pushLog(line) {
  const text = redact(String(line).replace(/\s+$/, ''), secretValues)
  if (!text) return
  logs.push(text)
  if (logs.length > 400) logs.splice(0, logs.length - 400)
  persistLog(text)
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
      managed: isManaged(version),
      status: current?.version === version ? current.status : 'stopped',
      url: current?.version === version ? current.url : null,
    })),
    running: current
      ? { version: current.version, status: current.status, url: current.url }
      : null,
    autoFix: lastAutoFix,
    health: lastHealth,
    dataDir: DATA,
    progress: installProgress,
  }
}

async function applyDataDir(dir) {
  await mkdir(dir, { recursive: true })
  DATA = dir
  CONFIG = join(DATA, 'config.json')
  pushLog(`版本目录 ${DATA}`)
}

async function publicSettings() {
  const stored = await loadSettings()
  return {
    dataDir: DATA,
    dshHome: homeDir(),
    autoStart: await autoStartEnabled(),
    seedMarket: stored.seedMarket !== false,
    autoDisablePlugins: stored.autoDisablePlugins !== false,
    profile: PROFILE_NAME,
  }
}

async function saveManagerSettings(body) {
  if (body.dataDir) {
    const dir = safeDataDir(body.dataDir)
    if (dir !== DATA && current) throw new Error('请先停止再改版本目录')
    if (installing) throw new Error('正在安装，稍后再改版本目录')
    await applyDataDir(dir)
  }
  const stored = await saveSettings({
    dataDir: DATA,
    autoStart: Boolean(body.autoStart),
    seedMarket: body.seedMarket !== false,
    autoDisablePlugins: body.autoDisablePlugins !== false,
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

/** dsh 子进程与 AI 修复命令共用的环境变量（AI 靠这些变量拼出正确的 dsh 命令）。 */
function dshEnv(version) {
  const home = homeDir()
  return {
    ...process.env,
    DSH_HOME: home,
    DSH_NODE: process.execPath,
    DSH_BIN: binPath(version),
    DSH_VERSION: version,
    DSH_PROFILE: PROFILE_NAME,
    // 浏览器里堆积的 cookie 会顶爆默认 16KB 的请求头上限（HTTP 431），一并放宽
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--max-http-header-size=131072'].filter(Boolean).join(' '),
    npm_config_ignore_workspace_root_check: 'true',
  }
}

/** 当前 profile 目录。 */
function profileDir() {
  return join(homeDir(), 'profiles', PROFILE_NAME)
}

/** dsh 启动参数。 */
function bootArgs() {
  return [PROFILE_NAME, '--host', '127.0.0.1', '--port', '0', '--no-open']
}

function spawnDsh(version, extra) {
  const home = homeDir()
  const bin = binPath(version)
  return spawn(process.execPath, [bin, ...extra], {
    cwd: home,
    env: dshEnv(version),
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

function stripTag(tag) {
  return String(tag || '').trim().replace(/^v/i, '')
}

async function checkSelfUpdate() {
  const current = APP_VERSION
  const url = `https://github.com/${APP_REPO}/releases/latest/download/${APP_SETUP}`
  const fallback = { current, latest: null, update: false, url }
  if (selfCache.data && Date.now() - selfCache.at < 30 * 60 * 1000) return selfCache.data
  try {
    const latest = await fetchLatestTag()
    if (!latest) return fallback
    const cur = parseVer(current)
    const next = parseVer(latest)
    const update = Boolean(cur && next && cmpVer(next, cur) > 0)
    const data = { current, latest, update, url }
    selfCache = { at: Date.now(), data }
    return data
  } catch {
    return fallback
  }
}

async function fetchLatestTag() {
  try {
    const res = await fetch(`https://api.github.com/repos/${APP_REPO}/releases/latest`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-launcher',
      },
    })
    if (res.ok) {
      const rel = await res.json()
      return stripTag(rel.tag_name)
    }
  } catch { /* HTML fallback */ }
  const page = await fetch(`https://github.com/${APP_REPO}/releases/latest`, {
    headers: { 'user-agent': 'dsh-launcher' },
    redirect: 'follow',
  })
  if (!page.ok) return null
  const match = /\/releases\/tag\/([^/?#]+)/.exec(page.url || '')
  return match ? stripTag(decodeURIComponent(match[1])) : null
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
  installProgress = { phase: 'resolve' }
  await emitState()
  emit('progress', installProgress)
  const dir = versionDir(ver)
  await mkdir(dir, { recursive: true })
  pushLog(`安装 ${PKG}@${ver}`)
  try {
    await installSpec(dir, PKG, ver, (line, progress) => {
      if (line) pushLog(line)
      if (progress) {
        installProgress = progress
        emit('progress', progress)
      }
    })
    if (!existsSync(binPath(ver))) throw new Error('安装完成但找不到 lib/bin.js')
    await mkdir(homeDir(), { recursive: true })
    config.versions = [ver, ...listedVersions(config).filter((item) => item !== ver)]
    await saveConfig(config)
    pushLog(`${ver} 安装完成`)
    await seedMarket(ver)
    // 装完新版顺手清掉更旧的（保留最新 + 最近装的一个，正在跑的除外）
    await pruneVersions(config)
  } catch (error) {
    if (!listedVersions(config).includes(ver)) {
      await rm(dir, { recursive: true, force: true })
    }
    throw error
  } finally {
    installing = null
    installProgress = null
    emit('progress', { phase: 'idle' })
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
  current = { version, child, status: 'starting', url: null, tail: [], exit: null }
  const proc = current
  const onChunk = (buf) => {
    const text = buf.toString('utf8')
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) {
        proc.tail.push(line)
        if (proc.tail.length > 200) proc.tail.shift()
      }
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
    proc.exit = { code, signal }
    pushLog(`已退出 code=${code ?? '-'} signal=${signal ?? '-'}`)
    if (current?.child === child) {
      current = null
      lastHealth = null
    }
    emitState()
  })
  return proc
}

async function waitUntilReady(proc, version) {
  const started = Date.now()
  const label = version
  while (proc.status === 'starting') {
    if (current !== proc) throw new Error(`${label} 启动失败`)
    if (Date.now() - started > START_TIMEOUT_MS) {
      killTree(proc.child.pid)
      throw new Error(`${label} 启动超时`)
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  if (!proc.url) throw new Error(`${version} 启动失败`)
  return { url: proc.url }
}

/**
 * 页面自检：按浏览器的方式抓一次 app 页面（token 换 cookie），把页面引用的所有
 * 客户端插件包请求一遍。dsh 进程活着不等于页面打得开——实例切换后浏览器里的旧
 * 页面会一直报「bundle script failed to load」，这一步用来区分"实例有问题"和
 * "你看的是旧页面"。
 * @returns {{origin: string, total: number, ok: number, failed: Array<{url: string, status: number, error?: string}>}}
 */
export async function checkWebPage(origin, token) {
  const base = String(origin).replace(/\/+$/, '')
  const first = await fetch(`${base}/?token=${encodeURIComponent(token)}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(8000),
  })
  const cookie = (first.headers.getSetCookie?.() || []).map((item) => item.split(';')[0]).join('; ')
  const headers = cookie ? { cookie } : {}
  const page = await fetch(`${base}/`, { headers, signal: AbortSignal.timeout(15000) })
  const html = await page.text()
  const urls = [...new Set([...html.matchAll(/\/plugins\/[^"'\s<>)]+/g)].map((match) => match[0].replaceAll('&amp;', '&')))]
  const failed = []
  let ok = 0
  for (const url of urls) {
    try {
      const res = await fetch(`${base}${url}`, { headers, signal: AbortSignal.timeout(30000) })
      await res.arrayBuffer()
      if (res.status === 200) ok += 1
      else failed.push({ url, status: res.status })
    } catch (error) {
      failed.push({ url, status: 0, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { origin: base, total: urls.length, ok, failed }
}

/** 启动成功后异步自检并把结论写进状态（失败不影响运行中的实例）。 */
async function selfCheckPage(url, version) {
  const match = /^http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+)/.exec(String(url || ''))
  if (!match) return
  try {
    const result = await checkWebPage(`http://127.0.0.1:${match[1]}`, match[2])
    lastHealth = {
      at: Date.now(),
      version,
      url,
      total: result.total,
      ok: result.ok,
      failed: result.failed.slice(0, 8),
    }
    if (result.failed.length) {
      pushLog(`页面自检：${result.ok}/${result.total} 个客户端插件包正常，${result.failed.length} 个失败`)
      for (const item of result.failed.slice(0, 5)) pushLog(`[自检] HTTP ${item.status || '-'} ${item.url.slice(0, 160)}`)
    } else {
      pushLog(`页面自检：${result.total} 个客户端插件包全部正常`)
    }
    await emitState()
  } catch (error) {
    pushLog(`页面自检没跑成：${error instanceof Error ? error.message : error}`)
  }
}

/** 起一个 web 子进程并等到它打印就绪 URL；失败时把子进程输出尾巴留给 AI 当证据。 */
async function bootOnce(ver) {
  await mkdir(homeDir(), { recursive: true })
  await seedMarket(ver)
  pushLog(`启动 ${ver} · profile ${PROFILE_NAME}`)
  const child = spawnDsh(ver, bootArgs())
  const proc = attachProcess(ver, child)
  await emitState()
  try {
    const result = await waitUntilReady(proc, ver)
    lastHealth = null
    await emitState()
    void selfCheckPage(result.url, ver)
    return result
  } catch (error) {
    const failure = {
      at: Date.now(),
      version: ver,
      message: error instanceof Error ? error.message : String(error),
      exit: proc.exit,
      tail: (proc.tail || []).slice(-120),
    }
    lastFailure = failure
    try {
      error.failure = failure
    } catch {
      // 非 Error 对象就算了
    }
    throw error
  }
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
  return bootOnce(ver)
}

/** 一次启动尝试里最多按错误自动禁用几个插件（避免连环禁用不可收拾）。 */
const MAX_AUTO_DISABLE = 3
/** 最近一次按错误自动禁用的插件（管理页显示 + 一键恢复）。 */
let lastAutoFix = null

/**
 * 兼容模式：启动输出点名了某个插件行加载失败时，把该行写进补丁层禁用。
 * 只信任错误的原始输出（failed to import loader entry <行> (<包>)），官方组件不动。
 * @returns 是否改动了配置（改动后上层立刻重试启动）。
 */
async function autoDisableFailedPlugins(error, already) {
  const settings = await loadSettings()
  if (settings.autoDisablePlugins === false) return false
  const failure = error?.failure || lastFailure
  const rows = parseFailedRows(`${failure?.message || ''}\n${(failure?.tail || []).join('\n')}`)
  for (const row of rows) {
    if (already.has(row.id)) continue
    if (/^@deepseek-ai\//.test(row.pkg)) continue
    const owner = ownerOfRow(profileDir(), row.id)
    if (owner && /^@deepseek-ai\//.test(owner)) continue
    try {
      const result = disableRowId(profileDir(), row.id)
      if (!result.changed) continue
      pushLog(`[兼容] ${row.pkg} 的加载行「${row.id}」加载失败，已写入 cordis.patch.yml 禁用，重试启动…`)
      already.add(row.id)
      lastAutoFix = {
        at: Date.now(),
        version: failure?.version || null,
        plugins: [...(lastAutoFix?.plugins || []), { name: row.pkg, id: row.id }],
      }
      await emitState()
      return true
    } catch (error2) {
      pushLog(`[兼容] 自动禁用「${row.id}」失败：${error2 instanceof Error ? error2.message : error2}`)
    }
  }
  return false
}

/** 启动失败 → 按错误自动禁用问题插件（兼容模式）→ 重试，直到成功或无法再修。 */
async function startWithRepair(version) {
  lastAutoFix = null
  const autoDisabled = new Set()
  let lastError
  for (;;) {
    try {
      return await startNow(version)
    } catch (error) {
      lastError = error
      pushLog(`启动失败：${error instanceof Error ? error.message : error}`)
      if (autoDisabled.size < MAX_AUTO_DISABLE && await autoDisableFailedPlugins(error, autoDisabled)) {
        continue
      }
      break
    }
  }
  throw lastError
}

let startChain = Promise.resolve()

async function start(version) {
  const run = startChain.then(() => startWithRepair(version))
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

export function setHost(next) {
  host = { ...host, ...next }
}

function openLocalUrl(target) {
  if (typeof target !== 'string' || !/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:[/?#]|$)/i.test(target)) {
    throw new Error('只能打开本机地址')
  }
  if (process.platform === 'win32') {
    execFile('cmd', ['/c', 'start', '', target], { windowsHide: true })
    return
  }
  execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [target])
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

async function uninstallSystem(ver) {
  const system = detectSystemDsh()
  if (!system || system.version !== ver) throw new Error(`${ver} 未安装`)
  pushLog(`卸载系统 ${ver}`)
  await rm(system.root, { recursive: true, force: true })
  const prefix = dirname(dirname(dirname(system.root)))
  for (const name of ['dsh', 'dsh.cmd', 'dsh.ps1']) {
    const file = join(prefix, name)
    if (existsSync(file)) await rm(file, { force: true })
  }
}

async function uninstall(version) {
  const ver = safeVersion(version)
  if (current?.version === ver) throw new Error('请先停止再移除')
  const config = await loadConfig()
  const versions = listedVersions(config)
  if (!versions.includes(ver)) throw new Error(`${ver} 未安装`)
  if (isManaged(ver)) {
    pushLog(`移除 ${ver}`)
    await rm(versionDir(ver), { recursive: true, force: true })
  }
  const system = detectSystemDsh()
  if (system?.version === ver) await uninstallSystem(ver)
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
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  res.writeHead(status, {
    'content-type': type,
    'content-length': payload.length,
    'cache-control': 'no-store',
    connection: 'close',
  })
  res.end(payload)
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/remote') {
    send(res, 200, await fetchRemote())
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/self') {
    send(res, 200, await checkSelfUpdate())
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
  if (req.method === 'GET' && url.pathname === '/api/plugins') {
    send(res, 200, { ...listPlugins(profileDir()), profile: PROFILE_NAME, autoFix: lastAutoFix })
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
    if (installProgress) res.write(`event: progress\ndata: ${JSON.stringify(installProgress)}\n\n`)
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
  if (req.method === 'POST' && url.pathname === '/api/settings') {
    send(res, 200, await saveManagerSettings(body))
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/plugins/toggle') {
    const name = String(body.name || '')
    const enabled = body.enabled !== false
    const result = setPluginEnabled(profileDir(), name, enabled)
    pushLog(`插件 ${name} → ${enabled ? '启用' : '禁用'}${result.changed ? '' : '（无变化）'}`)
    send(res, 200, { ok: true, changed: result.changed, ...listPlugins(profileDir()), profile: PROFILE_NAME, autoFix: lastAutoFix })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/wake') {
    await host.onWake?.()
    send(res, 200, { ok: true })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/open') {
    openLocalUrl(body.url)
    send(res, 200, { ok: true })
    return
  }
  send(res, 404, { error: 'not found' })
}

function mime(path) {
  if (path.endsWith('.css')) return 'text/css'
  if (path.endsWith('.js')) return 'text/javascript'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.ico')) return 'image/x-icon'
  return 'text/html'
}

function isTextFile(file) {
  return /\.(html|css|js|svg|json|txt|map)$/i.test(file)
}

export async function startServer() {
  if (server) return Promise.resolve(`http://127.0.0.1:${PORT}`)
  await ensureSettings()
  DATA = resolveDataDir()
  CONFIG = join(DATA, 'config.json')
  await mkdir(DATA, { recursive: true })
  // 默认 16KB 的请求头上限会被浏览器里堆积的 cookie 顶爆（HTTP 431），放宽到 128KB
  server = createServer({ maxHeaderSize: 128 * 1024 }, async (req, res) => {
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
      const type = mime(path)
      if (isTextFile(file)) {
        let body = await readFile(path, 'utf8')
        if (file === 'index.html') body = body.replaceAll('__APP_VERSION__', APP_VERSION)
        send(res, 200, body, `${type}; charset=utf-8`)
        return
      }
      send(res, 200, await readFile(path), type)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      pushLog(`错误: ${message}`)
      send(res, 500, { error: message })
    }
  })
  return new Promise((resolve, reject) => {
    server.listen(PORT, '127.0.0.1', () => {
      pushLog(`DSH 管理器 http://127.0.0.1:${PORT}`)
      pushLog(`版本目录 ${DATA}`)
      pushLog(`DSH_HOME ${homeDir()}`)
      const system = detectSystemDsh()
      if (system) pushLog(`发现系统已安装 ${system.version}`)
      console.log(`dsh-versions: http://127.0.0.1:${PORT}`)
      console.log(`dsh-versions data: ${DATA}`)
      console.log(`dsh-versions home: ${homeDir()}`)
      resolve(`http://127.0.0.1:${PORT}`)
    })
    server.on('error', reject)
  })
}

export async function stopAll() {
  if (current) killTree(current.child.pid)
  current = null
  for (const res of clients) {
    try { res.end() } catch { /* already gone */ }
  }
  clients.clear()
  const httpServer = server
  server = null
  if (!httpServer) return
  if (typeof httpServer.closeAllConnections === 'function') {
    httpServer.closeAllConnections()
  }
  await Promise.race([
    new Promise((resolve) => httpServer.close(() => resolve())),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ])
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
