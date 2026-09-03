import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
function defaultDataDir() {
  if (process.env.DSH_VERSIONS_DATA) return process.env.DSH_VERSIONS_DATA
  const local = join(ROOT, 'data')
  if (existsSync(join(local, 'config.json'))) return local
  if (process.env.APPDATA) return join(process.env.APPDATA, 'DSH', 'data')
  return local
}

const DATA = defaultDataDir()
const PUBLIC = join(ROOT, 'public')
const CONFIG = join(DATA, 'config.json')
const PKG = '@deepseek-ai/dsh'
const MARKET_PKG = 'dshmarket'
const MARKET_URL = process.env.DSHM_REGISTRY_URL || 'https://awesome-dsh-plugin.com/plugins.json'
const PORT = Number(process.env.PORT || 3780)
function npmCmd() {
  const bundled = join(dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm')
  if (existsSync(bundled)) return bundled
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/
const SPEC_RE = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+(?:@[a-z0-9._~+-]+)?$/i
const GITHUB_SPEC_RE = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#[\w./-]+)?$/
const READY_RE = /dsh web:\s+(https?:\/\/[^\s]+)/
const START_TIMEOUT_MS = 120_000

const clients = new Set()
const logs = []
const running = new Map()
let installing = null
let pluginBusy = null
let remoteCache = { at: 0, data: null }
let marketCache = { at: 0, data: null }
let server = null

function versionDir(version) {
  return join(DATA, 'versions', version)
}

function homeDir(version) {
  return join(DATA, 'homes', version)
}

function binPath(version) {
  return join(versionDir(version), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

function profileManifest(version) {
  return join(homeDir(version), 'profiles', 'web', 'package.json')
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

function quoteArg(value) {
  if (process.platform !== 'win32' || !/[\s&()^]/.test(value)) return value
  return `"${value}"`
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
  return {
    installing,
    pluginBusy,
    versions: config.versions.map((item) => {
      const proc = running.get(item.version)
      return {
        version: item.version,
        status: proc?.status ?? 'stopped',
        url: proc?.url ?? null,
      }
    }),
  }
}

async function emitState() {
  emit('state', await snapshot())
}

function runCommand(command, args, { logOutput = true, env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const useShell = process.platform === 'win32'
    const exe = useShell && /[\s]/.test(command) ? `"${command}"` : command
    const child = spawn(exe, args.map(quoteArg), {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: useShell,
    })
    let stdout = ''
    const onChunk = (buf, stream) => {
      const text = buf.toString('utf8')
      if (stream === 'stdout') stdout += text
      if (logOutput) {
        for (const line of text.split(/\r?\n/)) pushLog(line)
      }
    }
    child.stdout.on('data', (buf) => onChunk(buf, 'stdout'))
    child.stderr.on('data', (buf) => onChunk(buf, 'stderr'))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${command} ${args.join(' ')} 退出码 ${code}`))
    })
  })
}

function spawnDsh(version, extra) {
  const home = homeDir(version)
  const bin = binPath(version)
  return spawn(process.execPath, [bin, ...extra], {
    cwd: home,
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

async function fetchRemote() {
  if (remoteCache.data && Date.now() - remoteCache.at < 60_000) return remoteCache.data
  const raw = await runCommand(npmCmd(), ['view', PKG, 'versions', 'dist-tags', '--json'], { logOutput: false })
  const info = JSON.parse(raw)
  const versions = [...(Array.isArray(info.versions) ? info.versions : [info.versions])].reverse()
  const tags = info['dist-tags'] ?? {}
  const data = {
    package: PKG,
    source: 'https://github.com/deepseek-ai/deepseek-harness',
    tags,
    versions,
  }
  remoteCache = { at: Date.now(), data }
  return data
}

function slimPlugin(plugin) {
  return {
    name: plugin.name,
    owner: plugin.owner,
    url: plugin.url,
    page: plugin.page,
    category: plugin.category,
    description: plugin.description?.zh || plugin.description?.en || '',
    npm: plugin.npm,
    stars: plugin.stars ?? 0,
    downloads: plugin.downloads,
    install: plugin.install,
    added: plugin.added,
  }
}

async function fetchMarket() {
  if (marketCache.data && Date.now() - marketCache.at < 5 * 60_000) return marketCache.data
  const res = await fetch(MARKET_URL)
  if (!res.ok) throw new Error(`插件目录请求失败 HTTP ${res.status}`)
  const raw = await res.json()
  const plugins = (raw.plugins ?? []).map(slimPlugin)
  const data = {
    source: 'https://github.com/dsh-market/dsh-market',
    catalog: raw.source || 'https://github.com/awesome-dsh-plugin/awesome-dsh-plugin',
    updated: raw.updated,
    count: plugins.length,
    categories: raw.categories ?? {},
    plugins,
  }
  marketCache = { at: Date.now(), data }
  return data
}

function specFromPlugin(plugin) {
  const match = String(plugin.install || '').match(/add\s+(\S+)/)
  if (match) return safeSpec(match[1])
  if (plugin.npm) return safeSpec(plugin.npm)
  throw new Error('无法解析安装源')
}

async function installedPlugins(version) {
  const ver = safeVersion(version)
  const file = profileManifest(ver)
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
  if (pluginBusy) throw new Error(`正在安装插件 ${pluginBusy.spec}`)
  const config = await loadConfig()
  if (!config.versions.some((item) => item.version === ver)) throw new Error(`${ver} 未安装`)
  if (!existsSync(binPath(ver))) throw new Error('找不到官方入口 lib/bin.js')

  pluginBusy = { version: ver, spec: pkg }
  await emitState()
  await mkdir(homeDir(ver), { recursive: true })
  pushLog(`安装插件 ${pkg} → ${ver}`)
  try {
    await new Promise((resolve, reject) => {
      const child = spawnDsh(ver, ['plugin', '--profile', 'web', 'add', pkg])
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
    pushLog(`${pkg} 安装完成`)
  } finally {
    pluginBusy = null
    await emitState()
  }
}

async function seedMarket(version) {
  const plugins = await installedPlugins(version)
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
  if (config.versions.some((item) => item.version === ver)) throw new Error(`${ver} 已安装`)

  installing = ver
  await emitState()
  const dir = versionDir(ver)
  const home = homeDir(ver)
  await mkdir(dir, { recursive: true })
  pushLog(`安装 ${PKG}@${ver}`)
  try {
    await runCommand(npmCmd(), ['install', '--prefix', dir, `${PKG}@${ver}`])
    if (!existsSync(binPath(ver))) throw new Error('安装完成但找不到 lib/bin.js')
    await mkdir(home, { recursive: true })
    config.versions.unshift({ version: ver, dir, home })
    await saveConfig(config)
    pushLog(`${ver} 安装完成，预装插件市场 dshmarket`)
    await seedMarket(ver)
  } catch (error) {
    if (!config.versions.some((item) => item.version === ver)) {
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
  const proc = { child, status: 'starting', url: null }
  running.set(version, proc)
  const onChunk = (buf) => {
    const text = buf.toString('utf8')
    for (const line of text.split(/\r?\n/)) {
      pushLog(`[${version}] ${line}`)
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
    pushLog(`[${version}] 已退出 code=${code ?? '-'} signal=${signal ?? '-'}`)
    running.delete(version)
    emitState()
  })
  return proc
}

async function start(version) {
  const ver = safeVersion(version)
  if (running.has(ver)) throw new Error(`${ver} 已在运行`)
  const config = await loadConfig()
  if (!config.versions.some((item) => item.version === ver)) throw new Error(`${ver} 未安装`)
  if (!existsSync(binPath(ver))) throw new Error('找不到官方入口 lib/bin.js')

  await mkdir(homeDir(ver), { recursive: true })
  await seedMarket(ver)
  pushLog(`启动 ${ver}: dsh web --host 127.0.0.1 --port 0 --no-open`)
  const child = spawnDsh(ver, ['web', '--host', '127.0.0.1', '--port', '0', '--no-open'])
  const proc = attachProcess(ver, child)
  await emitState()

  const started = Date.now()
  while (proc.status === 'starting') {
    if (!running.has(ver)) throw new Error(`${ver} 启动失败`)
    if (Date.now() - started > START_TIMEOUT_MS) {
      killTree(child.pid)
      throw new Error(`${ver} 启动超时`)
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return { url: proc.url }
}

async function stop(version) {
  const ver = safeVersion(version)
  const proc = running.get(ver)
  if (!proc) return
  proc.status = 'stopping'
  await emitState()
  const closed = new Promise((resolve) => proc.child.once('close', resolve))
  killTree(proc.child.pid)
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5000))])
  running.delete(ver)
  await emitState()
}

async function uninstall(version) {
  const ver = safeVersion(version)
  if (running.has(ver)) throw new Error('请先停止再卸载')
  const config = await loadConfig()
  if (!config.versions.some((item) => item.version === ver)) throw new Error(`${ver} 未安装`)
  pushLog(`卸载 ${ver}`)
  await rm(versionDir(ver), { recursive: true, force: true })
  await rm(homeDir(ver), { recursive: true, force: true })
  config.versions = config.versions.filter((item) => item.version !== ver)
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
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/remote') {
    send(res, 200, await fetchRemote())
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    send(res, 200, await snapshot())
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/market') {
    send(res, 200, await fetchMarket())
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/plugins') {
    send(res, 200, { plugins: await installedPlugins(url.searchParams.get('version') || '') })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
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
  if (req.method === 'POST' && url.pathname === '/api/plugin') {
    const spec = body.spec || (body.plugin ? specFromPlugin(body.plugin) : '')
    await addPlugin(body.version, spec)
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
  return 'text/html'
}

export function startServer() {
  if (server) return Promise.resolve(`http://127.0.0.1:${PORT}`)
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
      console.log(`dsh-versions: http://127.0.0.1:${PORT}`)
      resolve(`http://127.0.0.1:${PORT}`)
    })
    server.on('error', reject)
  })
}

export async function stopAll() {
  for (const proc of running.values()) killTree(proc.child.pid)
  running.clear()
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
