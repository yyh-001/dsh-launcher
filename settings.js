import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROOT = dirname(fileURLToPath(import.meta.url))
const SETTINGS_DIR = process.env.APPDATA ? join(process.env.APPDATA, 'DSH') : join(ROOT, 'data')
const SETTINGS_FILE = join(SETTINGS_DIR, 'settings.json')
const RUN_REG = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUN_NAME = 'DSH'

export const DEFAULTS = {
  dataDir: '',
  autoStart: false,
  seedMarket: true,
  // 启动失败时按错误点名自动禁用问题插件（兼容模式），再重试
  autoDisablePlugins: true,
}

function hasInstall(dir) {
  return existsSync(join(dir, 'config.json')) || existsSync(join(dir, 'versions'))
}

export function safeDataDir(dir) {
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('版本目录不能为空')
  const resolved = resolve(dir.trim())
  if (!isAbsolute(resolved)) throw new Error('请使用绝对路径')
  return resolved
}

export function fallbackDataDir() {
  const local = join(ROOT, 'data')
  if (hasInstall(local)) return local
  if (process.env.APPDATA) {
    const roaming = join(process.env.APPDATA, 'DSH', 'data')
    if (hasInstall(roaming)) return roaming
  }
  if (existsSync(join(ROOT, 'DSH.exe')) && process.env.APPDATA) {
    return join(process.env.APPDATA, 'DSH', 'data')
  }
  return local
}

export function loadSettingsSync() {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

export async function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(await readFile(SETTINGS_FILE, 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

export async function saveSettings(patch) {
  const current = await loadSettings()
  const merged = { ...current, ...patch }
  if (merged.dataDir) merged.dataDir = safeDataDir(merged.dataDir)
  merged.autoStart = Boolean(merged.autoStart)
  merged.seedMarket = merged.seedMarket !== false
  merged.autoDisablePlugins = merged.autoDisablePlugins !== false
  // 已废弃的 AI 修复配置：清掉历史文件里的残留字段
  for (const key of ['aiRepair', 'aiModel', 'aiBaseURL', 'aiApiKey', 'aiMaxRounds', 'aiAllowDestructive']) {
    delete merged[key]
  }
  await mkdir(SETTINGS_DIR, { recursive: true })
  await writeFile(SETTINGS_FILE, JSON.stringify(merged, null, 2))
  return merged
}

export function inferDataDir() {
  if (process.env.DSH_VERSIONS_DATA) return process.env.DSH_VERSIONS_DATA
  return fallbackDataDir()
}

export function resolveDataDir() {
  const settings = loadSettingsSync()
  if (settings.dataDir) return safeDataDir(settings.dataDir)
  return inferDataDir()
}

export async function ensureSettings() {
  const stored = await loadSettings()
  const dataDir = stored.dataDir ? safeDataDir(stored.dataDir) : inferDataDir()
  if (stored.dataDir === dataDir) return stored
  return saveSettings({ ...stored, dataDir })
}

export function launchCommand() {
  const exe = join(ROOT, 'DSH.exe')
  if (existsSync(exe)) return `"${exe}"`
  return `"${process.execPath}" "${join(ROOT, 'start.js')}"`
}

function runReg(args) {
  return execFileAsync('reg.exe', args, { windowsHide: true, encoding: 'utf8' })
}

export async function autoStartEnabled() {
  if (process.platform !== 'win32') return false
  try {
    await runReg(['query', RUN_REG, '/v', RUN_NAME])
    return true
  } catch {
    return false
  }
}

export async function setAutoStart(enabled) {
  if (process.platform !== 'win32') {
    if (enabled) throw new Error('开机自启目前只支持 Windows')
    return
  }
  const on = await autoStartEnabled()
  if (on === Boolean(enabled)) return
  if (enabled) {
    await runReg(['add', RUN_REG, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', launchCommand(), '/f'])
    return
  }
  try {
    await runReg(['delete', RUN_REG, '/v', RUN_NAME, '/f'])
  } catch {
    // already off
  }
}
