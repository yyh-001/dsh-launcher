/**
 * Profile 插件开关：读写 dsh 用户补丁层 cordis.patch.yml。
 *
 * 机制与 dshmarket 的 lib/patch.js 相同——`- id: <行> / disabled: true` 停掉一条
 * loader 行，删掉该块即恢复；dsh 每次启动都会应用这层补丁，运行中还会热加载。
 * 因为只动文件、不需要 dsh 在跑，dsh 起不来时这里才是唯一能用的开关。
 *
 * 安全线（对齐市场实现，别把坏状态写得更坏）：
 * - 行 id 只允许 [A-Za-z0-9_.-]；补丁文件不是合法条目数组时拒绝追加；
 * - 删掉最后一行后恢复模板的 `[]` 占位，否则整个 profile 起不来；
 * - 官方包（@deepseek-ai/*）与市场自管行（mkt-/client-）不提供开关。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROW_ID_RE = /^[A-Za-z0-9_.-]+$/
/** 官方组件：关掉任何一条都可能让 dsh 起不来。 */
const PROTECTED_PACKAGE_RE = /^@deepseek-ai\//
/** 市场自己的运行时命名空间，永久补丁行会变成孤儿。 */
const MARKET_ROW_RE = /^(?:mkt-|client-|include:)/

/** 启动失败输出里点名的失败插件行：failed to import loader entry <行> (<包>)。 */
const FAILED_ROW_RE = /failed to import loader entry\s+(\S+)\s+\(([^)\s]+)\)/g

/** 启动失败输出里解析不到的 profile bundle（依赖缺失或断链，可重建修复）。 */
const UNRESOLVED_BUNDLE_RE = /cannot resolve profile bundle\s+"([^"]+)"/g

export function profileDirOf(dshHome, profile = 'web') {
  return join(dshHome, 'profiles', profile)
}

export function patchPathOf(profileDir) {
  return join(profileDir, 'cordis.patch.yml')
}

/** 读用户补丁层里已有的禁用/强制启用行（行扫描，不解析 YAML）。 */
export function readPatchState(patchPath) {
  let text = ''
  try {
    text = readFileSync(patchPath, 'utf8')
  } catch {
    // 没有补丁文件 = 空状态
  }
  const disables = []
  const forced = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^- id:\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*$/.exec(lines[index] ?? '')
    if (!match) continue
    const next = lines[index + 1] ?? ''
    if (/^ {2}disabled:\s*true\s*$/.test(next)) disables.push(match[1])
    else if (/^ {2}disabled:\s*false\s*$/.test(next)) forced.push(match[1])
  }
  return { disables, forced, text }
}

/** 插件补丁 `- insert:` 块里插入的 loader 行 id（4 空格缩进，避免误吞 config 里的 id）。 */
export function insertedIds(text) {
  const ids = []
  let inInsert = false
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (/^- /.test(line)) inInsert = /^- insert:\s*$/.test(line)
    if (!inInsert) continue
    const match = /^ {4}- id:\s*['"]?([A-Za-z0-9_.-]+)['"]?\s*$/.exec(line)
    if (match) ids.push(match[1])
  }
  return ids
}

/** 一个已安装插件包拥有的 loader 行：声明的 dsh.bundle.patch + 根目录 cordis.patch.yml。 */
export function packageRowIds(profileDir, packageName) {
  const pkgDir = join(profileDir, 'node_modules', packageName)
  const ids = new Set()
  try {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    const declared = manifest?.dsh?.bundle?.patch
    if (typeof declared === 'string' && declared.trim()) {
      const file = join(pkgDir, declared)
      if (existsSync(file)) for (const id of insertedIds(readFileSync(file, 'utf8'))) ids.add(id)
    }
  } catch {
    // 包不在或清单损坏：loader 侧可能还是知道，交给调用方
  }
  try {
    for (const id of insertedIds(readFileSync(join(pkgDir, 'cordis.patch.yml'), 'utf8'))) ids.add(id)
  } catch {
    // 没有传统位置的补丁
  }
  return [...ids]
}

function packageVersion(profileDir, name) {
  try {
    return String(JSON.parse(readFileSync(join(profileDir, 'node_modules', name, 'package.json'), 'utf8')).version || '')
  } catch {
    return ''
  }
}

/** 已装插件清单 + 当前开关状态（无需 dsh 在跑）。 */
export function listPlugins(profileDir) {
  const patchPath = patchPathOf(profileDir)
  const state = readPatchState(patchPath)
  let manifest = {}
  try {
    manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  } catch {
    // 空 profile：返回空清单
  }
  const deps = Object.keys(manifest?.dependencies ?? {}).sort()
  const plugins = deps.map((name) => {
    const ids = packageRowIds(profileDir, name)
    const official = PROTECTED_PACKAGE_RE.test(name)
    const marketOwned = ids.length > 0 && ids.every((id) => MARKET_ROW_RE.test(id))
    const disabled = ids.some((id) => state.disables.includes(id))
    let toggleable = true
    let reason = ''
    if (!ids.length) {
      toggleable = false
      reason = '没有可开关的加载行（客户端插件，由插件市场管理）'
    } else if (official) {
      toggleable = false
      reason = '官方组件，不提供开关'
    } else if (marketOwned) {
      toggleable = false
      reason = '市场自管行，不提供开关'
    }
    return { name, version: packageVersion(profileDir, name), ids, enabled: !disabled, toggleable, reason, official }
  })
  return { profileDir, patchPath, plugins, disables: state.disables }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function block(rowId) {
  return `- id: ${rowId}\n  disabled: true\n`
}

/** 补丁文件是否还是合法的顶层条目数组（行级启发式，宁可拒绝也不写坏）。 */
function looksLikeEntryList(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
  if (!lines.length) return true
  if (lines.length === 1 && /^\[\s*\]$/.test(lines[0].trim())) return true
  if (lines.some((line) => /^\S/.test(line) && !line.startsWith('- '))) return false
  if (lines.some((line) => /^\[\s*\]$|^\{\s*\}$/.test(line.trim()))) return false
  return true
}

/** 追加一行禁用（纯文本变换，便于一次写多行）。 */
function appendDisableBlock(text, rowId) {
  const core = String(text ?? '').trim()
  if (core === '') return { ok: true, text: block(rowId) }
  const withoutComments = core.replace(/^[ \t]*#.*$/gmu, '').trim()
  if (withoutComments === '') {
    const head = text.endsWith('\n') ? text : `${text}\n`
    return { ok: true, text: `${head}${block(rowId)}` }
  }
  if (withoutComments === '[]' || withoutComments === '[ ]') {
    const commented = text.replace(/^[ \t]*\[[ \t]*\][ \t]*(?:#.*)?(?:\r?\n|$)/mu, '# []\n')
    const head = commented.endsWith('\n') ? commented : `${commented}\n`
    return { ok: true, text: `${head}${block(rowId)}` }
  }
  const lastContent = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#')).pop() ?? ''
  if (/^[[{]/.test(lastContent)) {
    return { ok: false, reason: '补丁层以顶层流式结构结尾，拒绝自动追加；请先把 cordis.patch.yml 整理成条目列表' }
  }
  if (!looksLikeEntryList(text)) {
    return { ok: false, reason: '补丁层不是合法的条目数组，已拒绝写入以免破坏；请先修正 cordis.patch.yml' }
  }
  const head = text.endsWith('\n') ? text : `${text}\n`
  return { ok: true, text: `${head}${block(rowId)}` }
}

function removeDisableBlock(text, rowId) {
  const re = new RegExp(`^- id: ['"]?${escapeRegExp(rowId)}['"]?\\r?\\n {2}disabled: true\\r?\\n`, 'mu')
  return text.replace(re, '')
}

/** 补丁层空了就把模板的 `[]` 占位恢复回来（否则 dsh 拒绝启动整个 profile）。 */
function ensurePlaceholder(text) {
  if (text.replace(/^[ \t]*#.*$/gmu, '').trim() !== '') return text
  const revived = text.replace(/^[ \t]*#[ \t]*\[[ \t]*\][ \t]*(?:\r?\n|$)/mu, '[]\n')
  if (revived !== text) return revived
  return text === '' || text.endsWith('\n') ? `${text}[]\n` : `${text}\n[]\n`
}

function backupOnce(patchPath) {
  try {
    if (existsSync(patchPath)) copyFileSync(patchPath, `${patchPath}.bak`)
  } catch {
    // 备份失败不阻塞开关本身
  }
}

/** 禁用一条 loader 行（幂等）。返回是否发生变化。 */
export function disableRowId(profileDir, rowId) {
  if (!ROW_ID_RE.test(rowId)) throw new Error(`行 id ${rowId} 含特殊字符，不能写入补丁层`)
  if (MARKET_ROW_RE.test(rowId)) throw new Error(`行 id ${rowId} 由插件市场自管，不写入补丁层`)
  const patchPath = patchPathOf(profileDir)
  const state = readPatchState(patchPath)
  if (state.disables.includes(rowId)) return { ok: true, changed: false }
  const result = appendDisableBlock(state.text, rowId)
  if (!result.ok) throw new Error(result.reason)
  backupOnce(patchPath)
  writeFileSync(patchPath, result.text)
  return { ok: true, changed: true }
}

/** 重新启用一条 loader 行：删掉禁用块。返回是否发生变化。 */
export function enableRowId(profileDir, rowId) {
  if (!ROW_ID_RE.test(rowId)) throw new Error(`行 id ${rowId} 含特殊字符`)
  const patchPath = patchPathOf(profileDir)
  const state = readPatchState(patchPath)
  const next = removeDisableBlock(state.text, rowId)
  if (next === state.text) return { ok: true, changed: false }
  backupOnce(patchPath)
  writeFileSync(patchPath, ensurePlaceholder(next))
  return { ok: true, changed: true }
}

/** 按包名整包开关。 */
export function setPluginEnabled(profileDir, packageName, enabled) {
  if (PROTECTED_PACKAGE_RE.test(packageName)) throw new Error('官方组件不提供开关')
  const ids = packageRowIds(profileDir, packageName)
  if (!ids.length) throw new Error(`${packageName} 没有可开关的加载行`)
  const targets = ids.filter((id) => !MARKET_ROW_RE.test(id))
  if (!targets.length) throw new Error(`${packageName} 的加载行由市场自管，不提供开关`)
  const patchPath = patchPathOf(profileDir)
  const initial = readPatchState(patchPath)
  const disabledSet = new Set(initial.disables)
  let text = initial.text
  let changed = false
  for (const id of targets) {
    if (enabled) {
      const next = removeDisableBlock(text, id)
      if (next !== text) {
        text = next
        disabledSet.delete(id)
        changed = true
      }
    } else {
      if (disabledSet.has(id)) continue
      const result = appendDisableBlock(text, id)
      if (!result.ok) throw new Error(result.reason)
      text = result.text
      disabledSet.add(id)
      changed = true
    }
  }
  if (changed) {
    backupOnce(patchPath)
    writeFileSync(patchPath, ensurePlaceholder(text))
  }
  return { ok: true, changed, ids: targets }
}

/** 找到某条 loader 行属于哪个已装插件（找不到返回空串，例如传递挂载的行）。 */
export function ownerOfRow(profileDir, rowId) {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    for (const name of Object.keys(manifest?.dependencies ?? {})) {
      if (packageRowIds(profileDir, name).includes(rowId)) return name
    }
  } catch {
    // profile 清单不可读：按未知属主处理
  }
  return ''
}

/** 从启动失败输出里解析被点名的失败插件行（去重）。 */
export function parseFailedRows(text) {
  const found = []
  const seen = new Set()
  for (const match of String(text ?? '').matchAll(FAILED_ROW_RE)) {
    const key = `${match[1]} ${match[2]}`
    if (seen.has(key)) continue
    seen.add(key)
    found.push({ id: match[1], pkg: match[2] })
  }
  return found
}

/**
 * 从启动失败输出里解析解析不到的 profile bundle（去重）。
 *
 * 这条错误说明 profile 的 node_modules 里那个包不在（没装、或 pnpm 中途被打断
 * 只留了断链），重装 profile 依赖即可修复——dsh 的报错信息也是这么建议的。
 */
export function parseUnresolvedBundles(text) {
  const found = []
  const seen = new Set()
  for (const match of String(text ?? '').matchAll(UNRESOLVED_BUNDLE_RE)) {
    if (seen.has(match[1])) continue
    seen.add(match[1])
    found.push(match[1])
  }
  return found
}
