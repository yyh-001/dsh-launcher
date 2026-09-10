#!/usr/bin/env node
/**
 * 命令行开关 dsh profile 插件（启动器管理页、AI 修复、人工共用同一套逻辑）。
 *
 * 用法：
 *   node plugin-tool.js list
 *   node plugin-tool.js disable <包名|行 id>
 *   node plugin-tool.js enable  <包名|行 id>
 *
 * 环境变量：DSH_HOME（默认 ~/.dsh）、DSH_PROFILE（默认 web）。
 * 退出码 0 成功 / 1 失败（失败原因打到 stderr）。
 * dsh 起不来时也能用：只改 cordis.patch.yml，不需要 dsh 在跑。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  disableRowId,
  enableRowId,
  listPlugins,
  ownerOfRow,
  profileDirOf,
  setPluginEnabled,
} from './plugins.js'

const ROW_ID_RE = /^[A-Za-z0-9_.-]+$/

function fail(message) {
  console.error(message)
  process.exit(1)
}

const [command, target] = process.argv.slice(2)
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profile = process.env.DSH_PROFILE || 'web'
const profileDir = profileDirOf(dshHome, profile)

if (!command || command === 'help' || command === '--help' || command === '-h') {
  console.log('用法: node plugin-tool.js list | disable <包名|行 id> | enable <包名|行 id>')
  process.exit(0)
}

if (command === 'list') {
  const { plugins } = listPlugins(profileDir)
  if (!plugins.length) {
    console.log(`(${profileDir} 里没有已装插件)`)
    process.exit(0)
  }
  for (const plugin of plugins) {
    const state = plugin.enabled ? '启用  ' : '已禁用'
    const ids = plugin.ids.length ? plugin.ids.join(',') : '-'
    const note = plugin.toggleable ? '' : `（${plugin.reason}）`
    console.log(`${state} ${plugin.name}${plugin.version ? `@${plugin.version}` : ''}  行: ${ids}${note}`)
  }
  process.exit(0)
}

if (command !== 'disable' && command !== 'enable') {
  fail(`未知命令 ${command}；支持 list / disable / enable`)
}
if (!target) fail(`${command} 需要一个包名或行 id`)
if (/^@deepseek-ai\//.test(target)) fail(`${target} 是官方组件，不提供开关`)

const enabled = command === 'enable'
try {
  const { plugins } = listPlugins(profileDir)
  const plugin = plugins.find((item) => item.name === target)
  if (plugin) {
    if (!plugin.toggleable) fail(`${target} 不能开关：${plugin.reason}`)
    const result = setPluginEnabled(profileDir, target, enabled)
    console.log(`${target} → ${enabled ? '启用' : '禁用'}${result.changed ? '' : '（本来就是这个状态）'}；行 ${result.ids.join(', ')}`)
  } else if (ROW_ID_RE.test(target)) {
    const owner = ownerOfRow(profileDir, target)
    if (owner && /^@deepseek-ai\//.test(owner)) fail(`行 ${target} 属于官方组件 ${owner}，不提供开关`)
    const result = enabled ? enableRowId(profileDir, target) : disableRowId(profileDir, target)
    console.log(`行 ${target} → ${enabled ? '启用' : '禁用'}${result.changed ? '' : '（本来就是这个状态）'}${owner ? `；属于 ${owner}` : ''}`)
  } else {
    fail(`找不到插件 ${target}，且不是合法的行 id`)
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
