import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { cp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const REGISTRY = (process.env.npm_config_registry || 'https://registry.npmjs.org').replace(/\/$/, '')
const packumentCache = new Map()

function pkgDir(root, name) {
  return join(root, 'node_modules', ...name.split('/'))
}

function parseVer(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
  if (!match) return null
  return { major: +match[1], minor: +match[2], patch: +match[3], pre: match[4] || '', raw: version }
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

function satisfies(version, range) {
  const parsed = parseVer(version)
  if (!parsed) return false
  const spec = String(range || '*').trim()
  if (spec === '*' || spec === 'x' || spec === '') return !parsed.pre
  const caret = spec.startsWith('^')
  const tilde = spec.startsWith('~')
  const ge = spec.startsWith('>=')
  const want = parseVer(spec.replace(/^[\^~]|>=/, '').trim())
  if (!want) return version === spec
  if (parsed.pre && !want.pre) return false
  if (!caret && !tilde && !ge) return cmpVer(parsed, want) === 0
  if (cmpVer(parsed, want) < 0) return false
  if (caret) {
    if (want.major > 0) return parsed.major === want.major
    if (want.minor > 0) return parsed.major === 0 && parsed.minor === want.minor
    return parsed.major === 0 && parsed.minor === 0 && parsed.patch === want.patch
  }
  if (tilde) return parsed.major === want.major && parsed.minor === want.minor
  return true
}

function maxSatisfying(versions, range) {
  let best = null
  for (const version of versions) {
    if (!satisfies(version, range)) continue
    const parsed = parseVer(version)
    if (!parsed) continue
    if (!best || cmpVer(parsed, best) > 0) best = parsed
  }
  return best?.raw ?? null
}

async function registryGet(url) {
  const res = await fetch(url, {
    headers: {
      accept: 'application/vnd.npm.install-v1+json, application/json',
      'user-agent': 'dsh-versions/0.1.0',
    },
  })
  if (!res.ok) throw new Error(`registry ${res.status} ${url}`)
  return res.json()
}

export async function packument(name) {
  if (packumentCache.has(name)) return packumentCache.get(name)
  const pending = registryGet(`${REGISTRY}/${name.replace('/', '%2f')}`)
  packumentCache.set(name, pending)
  return pending
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

async function extractTarball(url, dest) {
  const id = randomBytes(8).toString('hex')
  const staging = join(tmpdir(), `dsh-${id}`)
  await mkdir(staging, { recursive: true })
  const archive = join(staging, 'pkg.tgz')
  const unpacked = join(staging, 'out')
  await mkdir(unpacked)
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'dsh-versions/0.1.0' } })
    if (!res.ok) throw new Error(`tarball ${res.status} ${url}`)
    await pipeline(Readable.fromWeb(res.body), createWriteStream(archive))
    await new Promise((resolve, reject) => {
      const child = spawn('tar', ['-xf', 'pkg.tgz', '-C', 'out'], {
        cwd: staging,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`tar 退出码 ${code}`))
      })
    })
    await mkdir(dest, { recursive: true })
    await cp(join(unpacked, 'package'), dest, { recursive: true })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function resolveTree(name, range, tree, inflight) {
  if (inflight.has(name)) return inflight.get(name)
  const job = (async () => {
    const meta = await packument(name)
    const version = meta.versions[range] ? range : maxSatisfying(Object.keys(meta.versions || {}), range)
    if (!version) throw new Error(`无法解析 ${name}@${range}`)
    const pack = meta.versions[version]
    tree.set(name, {
      version,
      tarball: pack.dist.tarball,
      dependencies: pack.dependencies || {},
      optional: pack.optionalDependencies || {},
    })
    await Promise.all(Object.entries(pack.dependencies || {}).map(([dep, depRange]) => (
      resolveTree(dep, depRange, tree, inflight)
    )))
  })()
  inflight.set(name, job)
  return job
}

export async function installSpec(root, name, range, onLog = () => {}) {
  const tree = new Map()
  const inflight = new Map()
  onLog(`解析依赖 ${name}@${range}`)
  await resolveTree(name, range, tree, inflight)
  const entries = [...tree.entries()]
  onLog(`下载 ${entries.length} 个包`)
  let done = 0
  let index = 0
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (index < entries.length) {
      const current = index++
      const [pkgName, info] = entries[current]
      await extractTarball(info.tarball, pkgDir(root, pkgName))
      done += 1
      if (done === 1 || done === entries.length || done % 10 === 0) {
        onLog(`已解开 ${done}/${entries.length} ${pkgName}@${info.version}`)
      }
    }
  }))
}
