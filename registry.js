import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { cp, mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const APP_ROOT = dirname(fileURLToPath(import.meta.url))
const LOCAL_NODE = join(APP_ROOT, 'node')
export const REGISTRY = (process.env.npm_config_registry || 'https://registry.npmmirror.com').replace(/\/$/, '')
const packumentCache = new Map()
let npmReady = null

const NPM_CMD = `@ECHO OFF
SETLOCAL
SET "NODE_EXE=%~dp0\\node.exe"
IF NOT EXIST "%NODE_EXE%" ( SET "NODE_EXE=node" )
SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"
"%NODE_EXE%" "%NPM_CLI_JS%" %*
`

const NPX_CMD = `@ECHO OFF
SETLOCAL
SET "NODE_EXE=%~dp0\\node.exe"
IF NOT EXIST "%NODE_EXE%" ( SET "NODE_EXE=node" )
SET "NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js"
"%NODE_EXE%" "%NPX_CLI_JS%" %*
`

function parseVer(version) {
  const match = String(version).trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2] || 0),
    patch: Number(match[3] || 0),
    pre: match[4] || '',
    parts: 1 + Number(match[2] != null) + Number(match[3] != null),
    raw: String(version),
  }
}

function cmpVer(a, b) {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.pre && b.pre) return a.pre < b.pre ? -1 : a.pre > b.pre ? 1 : 0
  if (a.pre) return -1
  if (b.pre) return 1
  return 0
}

async function registryGet(url) {
  let last
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: {
          accept: 'application/vnd.npm.install-v1+json, application/json',
          'user-agent': 'dsh-versions/0.1.0',
        },
      })
      if (!res.ok) throw new Error(`registry ${res.status} ${url}`)
      return await res.json()
    } catch (error) {
      last = error
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)))
    }
  }
  throw last
}

export async function packument(name) {
  if (packumentCache.has(name)) return packumentCache.get(name)
  const pending = registryGet(`${REGISTRY}/${name.replace('/', '%2f')}`)
  packumentCache.set(name, pending)
  try {
    return await pending
  } catch (error) {
    packumentCache.delete(name)
    throw error
  }
}

export async function listPackage(name) {
  const meta = await packument(name)
  const versions = Object.keys(meta.versions || {}).sort((a, b) => {
    const left = parseVer(a)
    const right = parseVer(b)
    if (!left || !right) return 0
    return cmpVer(right, left)
  })
  return { tags: meta['dist-tags'] || {}, versions }
}

async function fetchToFile(url, dest) {
  let last
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'dsh-versions/0.1.0' } })
      if (!res.ok) throw new Error(`tarball ${res.status} ${url}`)
      const expected = Number(res.headers.get('content-length')) || 0
      await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
      const fh = await open(dest, 'r')
      try {
        const buf = Buffer.alloc(2)
        const { bytesRead } = await fh.read(buf, 0, 2, 0)
        const { size } = await fh.stat()
        if (bytesRead < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b) throw new Error('tarball 不是 gzip')
        if (size < 22) throw new Error('tarball 为空')
        if (expected && size !== expected) throw new Error(`tarball 不完整 ${size}/${expected}`)
      } finally {
        await fh.close()
      }
      return
    } catch (error) {
      last = error
      try { await rm(dest, { force: true }) } catch { /* ignore */ }
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)))
    }
  }
  throw last
}

async function findPackageDir(staging, unpacked) {
  const ok = async (dir) => {
    try {
      const info = await stat(dir)
      if (!info.isDirectory()) return false
      const names = await readdir(dir)
      return names.includes('package.json') || names.length > 0
    } catch {
      return false
    }
  }
  if (await ok(join(unpacked, 'package'))) return join(unpacked, 'package')
  if (await ok(join(staging, 'package'))) return join(staging, 'package')
  let entries = []
  try { entries = await readdir(unpacked, { withFileTypes: true }) } catch { entries = [] }
  const dirs = entries.filter((entry) => entry.isDirectory())
  if (dirs.length === 1 && await ok(join(unpacked, dirs[0].name))) return join(unpacked, dirs[0].name)
  if (entries.some((entry) => entry.name === 'package.json')) return unpacked
  throw new Error(`解包后找不到 package（${entries.map((entry) => entry.name).join(', ') || '空'}）`)
}

async function extractTarball(url, dest) {
  const id = randomBytes(8).toString('hex')
  const staging = join(tmpdir(), `dsh-${id}`)
  await mkdir(staging, { recursive: true })
  const archive = join(staging, 'pkg.tgz')
  const unpacked = join(staging, 'out')
  await mkdir(unpacked)
  try {
    await fetchToFile(url, archive)
    await new Promise((resolve, reject) => {
      const child = spawn('tar', ['-x', '-f', archive, '-C', unpacked], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let err = ''
      child.stderr.on('data', (chunk) => { err += chunk })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`tar 退出码 ${code}${err.trim() ? `: ${err.trim()}` : ''}`))
      })
    })
    const src = await findPackageDir(staging, unpacked)
    await rm(dest, { recursive: true, force: true })
    await mkdir(dirname(dest), { recursive: true })
    await cp(src, dest, { recursive: true })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

function npmCli(home) {
  return join(home, 'node_modules', 'npm', 'bin', 'npm-cli.js')
}

function npmHomes() {
  return [...new Set([LOCAL_NODE, dirname(process.execPath)])]
}

function foundNpm() {
  for (const home of npmHomes()) {
    const cli = npmCli(home)
    if (existsSync(cli)) return { home, cli }
  }
  return null
}

function runNpm(cli, args, { cwd, onLog, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--require', join(APP_ROOT, 'stdio-unblock.cjs'), cli, ...args], {
      cwd,
      env: {
        ...process.env,
        npm_config_registry: REGISTRY,
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_update_notifier: 'false',
        npm_config_progress: 'false',
        npm_config_loglevel: 'http',
        ...env,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let err = ''
    const onChunk = (buf) => {
      const text = buf.toString('utf8')
      err += text
      if (!onLog) return
      for (const line of text.split(/\r?\n|\r/)) onLog(line)
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(err.trim().split(/\r?\n/).filter(Boolean).at(-1) || `npm 退出码 ${code}`))
    })
  })
}

async function npmVersion(cli) {
  let out = ''
  await runNpm(cli, ['--version'], {
    env: { npm_config_loglevel: 'silent' },
    onLog: (line) => { if (line.trim()) out += `${line.trim()}\n` },
  })
  return out.trim().split(/\r?\n/).filter((line) => /^\d+\.\d+/.test(line)).at(-1) || out.trim().split(/\r?\n/).at(-1) || ''
}

async function writeNpmShims(home) {
  if (process.platform !== 'win32') return
  await writeFile(join(home, 'npm.cmd'), NPM_CMD)
  await writeFile(join(home, 'npx.cmd'), NPX_CMD)
}

async function installNpm(home, version, onLog) {
  const meta = await packument('npm')
  const pack = meta.versions?.[version]
  const tarball = pack?.dist?.tarball
  if (!tarball) throw new Error(`找不到 npm@${version} 的 tarball`)
  onLog(`下载 npm@${version}`)
  await mkdir(home, { recursive: true })
  await extractTarball(tarball, join(home, 'node_modules', 'npm'))
  await writeNpmShims(home)
}

function npmCompatible(version) {
  const npm = parseVer(version)
  if (!npm || npm.major < 10) return false
  const node = parseVer(process.versions.node)
  if (!node) return npm.major === 10
  if (npm.major >= 12) {
    return node.major > 22
      || (node.major === 22 && (node.minor > 22 || (node.minor === 22 && node.patch >= 2)))
      || node.major >= 24
  }
  return true
}

async function latestCompatibleNpm() {
  const meta = await packument('npm')
  let best = '10.9.3'
  for (const version of Object.keys(meta.versions || {})) {
    const parsed = parseVer(version)
    if (!parsed || parsed.pre || !npmCompatible(version)) continue
    const current = parseVer(best)
    if (!current || cmpVer(parsed, current) > 0) best = version
  }
  return best
}

async function ensureNpmOnce(onLog) {
  const found = foundNpm()
  const current = found ? await npmVersion(found.cli) : ''
  if (found && npmCompatible(current)) {
    onLog(`使用 npm ${current} · ${REGISTRY}`)
    return found
  }
  const want = await latestCompatibleNpm()
  if (!found) onLog(`未找到 npm，正在下载 ${want}`, { phase: 'resolve' })
  else onLog(`npm ${current} 与 Node ${process.versions.node} 不匹配，改用 ${want}`, { phase: 'resolve' })
  await installNpm(LOCAL_NODE, want, onLog)
  const next = { home: LOCAL_NODE, cli: npmCli(LOCAL_NODE) }
  onLog(`npm ${await npmVersion(next.cli)} · ${REGISTRY}`)
  return next
}

export function ensureNpm(onLog = () => {}) {
  if (!npmReady) npmReady = ensureNpmOnce(onLog).catch((error) => {
    npmReady = null
    throw error
  })
  return npmReady
}

function pkgFromTarballUrl(url) {
  const match = String(url).match(/\/(?:(@[^/]+)\/)?([^/]+)\/-\/\2-([^/?]+)\.tgz/)
  if (!match) return ''
  return `${match[1] ? `${match[1]}/` : ''}${match[2]}@${match[3]}`
}

function pkgFromCacheSpec(spec) {
  return pkgFromTarballUrl(spec) || spec.replace(/@https?:.*$/, '') || spec
}

function parseInstallProgress(line, state) {
  const cache = line.match(/http cache\s+(\S+)\s+\d+ms \(cache hit\)/i)
  if (cache) {
    const spec = cache[1]
    if (/\.tgz(?:\?|$)/i.test(spec) || /\/-\//.test(spec)) {
      state.fetched += 1
      if (!state.total) state.total = Math.max(state.resolved, state.fetched)
      else state.total = Math.max(state.total, state.fetched)
      return { phase: 'download', done: state.fetched, total: state.total, pkg: pkgFromCacheSpec(spec) }
    }
    state.resolved += 1
    if (state.fetched) {
      state.total = Math.max(state.total, state.resolved, state.fetched)
      return { phase: 'download', done: state.fetched, total: state.total }
    }
    return { phase: 'resolve', done: state.resolved }
  }
  const http = line.match(/http fetch GET \d+\s+(\S+)/i)
  if (http) {
    const url = http[1]
    if (/\.tgz(?:\?|$)/i.test(url)) {
      state.fetched += 1
      if (!state.total) state.total = Math.max(state.resolved, state.fetched)
      else state.total = Math.max(state.total, state.fetched)
      return { phase: 'download', done: state.fetched, total: state.total, pkg: pkgFromTarballUrl(url) }
    }
    state.resolved += 1
    if (state.fetched) {
      state.total = Math.max(state.total, state.resolved, state.fetched)
      return { phase: 'download', done: state.fetched, total: state.total }
    }
    return { phase: 'resolve', done: state.resolved }
  }
  const added = line.match(/added (\d+) packages?/i)
  if (added) {
    state.total = Number(added[1])
    state.fetched = state.total
    return { phase: 'download', done: state.fetched, total: state.total }
  }
  return null
}

export async function installSpec(root, name, range, onLog = () => {}) {
  const { cli } = await ensureNpm(onLog)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'package.json'), `${JSON.stringify({
    private: true,
    name: 'dsh-version',
    version: '0.0.0',
  }, null, 2)}\n`)
  await writeFile(join(root, '.npmrc'), `registry=${REGISTRY}\naudit=false\nfund=false\nupdate-notifier=false\nprogress=false\n`)
  onLog(`npm install ${name}@${range}`, { phase: 'resolve' })
  const state = { resolved: 0, fetched: 0, total: 0 }
  await runNpm(cli, [
    'install',
    `${name}@${range}`,
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    '--loglevel=http',
    '--no-progress',
  ], {
    cwd: root,
    onLog: (line) => {
      const text = String(line).replace(/\s+$/, '')
      const progress = parseInstallProgress(text, state)
      const important = /^(?:npm warn|npm error|npm ERR!)|(?:^|\s)ERR!|added \d+ packages?/i.test(text)
      if (progress?.phase === 'download' && (progress.done === 1 || progress.done === progress.total || progress.done % 10 === 0)) {
        onLog(`已安装 ${progress.done}/${progress.total} ${progress.pkg || ''}`.trim(), progress)
      } else if (progress?.phase === 'resolve' && progress.done && progress.done % 10 === 0) {
        onLog(`已解析 ${progress.done} 个依赖`, progress)
      } else if (important && text) {
        onLog(text, progress || undefined)
      } else if (progress) {
        onLog('', progress)
      }
    },
  })
}
