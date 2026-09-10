/**
 * AI 自动修复：启动失败时收集证据 → 让 deepseek-v4-flash 用固定 JSON 给出修复步骤 →
 * 由启动器执行（档位可选：只诊断 / 白名单 / 任意命令）→ server.js 负责重试启动。
 *
 * 设计要点：
 * - 证据先行：先用与 dsh 完全相同的两锚点解析算法做确定性探测，模型只负责"看起来模糊"的部分。
 * - 全程留痕：每一步命令、退出码、输出都进日志；改 profile 文件前先备份。
 * - 密钥只读不回显：key 仅用于请求头，日志里一律替换成 sk-***。
 */
import { spawn } from 'node:child_process'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFailedRows } from './plugins.js'

const ROOT = dirname(fileURLToPath(import.meta.url))

/** 修复档位：off 关闭 / plan 只诊断 / safe 仅白名单动作 / full 任意命令。 */
export const AI_MODES = ['off', 'plan', 'safe', 'full']
export const AI_MODE_LABELS = {
  off: '关闭',
  plan: '只诊断',
  safe: '白名单动作',
  full: '任意命令',
}
export const DEFAULT_AI = {
  mode: 'full',
  model: 'deepseek-v4-flash',
  baseURL: 'https://api.deepseek.com',
  apiKey: '',
  maxRounds: 2,
  allowDestructive: false,
  commandTimeoutMs: 180_000,
  requestTimeoutMs: 60_000,
}
const MAX_STEPS = 3
const MAX_OUTPUT = 6000

/** 本机自毁 / 不可逆命令：aiAllowDestructive 打开后才放行。 */
const DANGEROUS = [
  { re: /\b(format|diskpart|bcdedit|cipher\s+\/w)\b/i, why: '磁盘/引导级破坏性操作' },
  { re: /\b(shutdown|restart-computer|stop-computer)\b/i, why: '会关机或重启整台机器' },
  { re: /\breg(\.exe)?\s+(delete|add)\b/i, why: '改注册表（含开机自启项）' },
  { re: /(taskkill|stop-process)[^\n]*(node\.exe|-name\s+node|dshexe|DSH\.exe)/i, why: '会杀掉启动器自身（manager 就是 node.exe）' },
  { re: /(taskkill|stop-process)[^\n]*\/(im|pid)\s+(\d+)/i, why: '按 PID/镜像名强杀进程，可能误伤启动器' },
  { re: /remove-item[^\n]*\s-(recurse|r)\b[^\n]*\s[a-z]:\\(\s|$|")/i, why: '递归删除盘符根目录' },
  { re: /\brm\s+-[a-z]*r[a-z]*f?\s+\/(\s|$)/i, why: '递归删除根目录' },
  { re: /remove-item[^\n]*\$env:APPDATA\\DSH(\s|$|")/i, why: '删除启动器自身安装目录' },
  { re: /remove-item[^\n]*\$env:USERPROFILE\\\.dsh(\s|$|")/i, why: '删除整个 DSH 用户目录' },
  { re: /set-mppreference[^\n]*-disable/i, why: '关闭杀软实时防护' },
]

/** 白名单（safe 档）：只放开 dsh 官方的插件/探测命令。 */
const SAFE_ALLOW = [
  /dsh[^\n]*\bplugin\b[^\n]*\b(install|add|update|remove|list)\b/i,
  /\bplugin\b[^\n]*--profile\b/i,
  /--dump-config\b/,
  /--dump-default-config\b/,
  /^pnpm\b[^\n]*\binstall\b/i,
  /^npm\b[^\n]*\binstall\b/i,
  /(test-path|get-item|get-childitem|readlink|resolve-path)\b/i,
  // 启动器自带的插件开关工具（写入 cordis.patch.yml 的唯一安全入口）
  /DSH_LAUNCHER_PLUGIN_TOOL|plugin-tool\.js/i,
]

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** 把 key 之类的敏感串从任意文本里抹掉。 */
export function redact(text, secrets = []) {
  let out = String(text ?? '')
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join('sk-***')
  }
  return out.replace(/\b(sk|ak)-[A-Za-z0-9_-]{8,}/g, '$1-***')
}

/** 只读 DSH 凭据文件里的 DEEPSEEK_API_KEY（形如 refs:\n  DEEPSEEK_API_KEY: xxx）。 */
export function readCredentialsKey(dshHome) {
  const file = join(dshHome, '.credentials.yaml')
  if (!existsSync(file)) return ''
  try {
    const text = readFileSync(file, 'utf8')
    const match = /^\s+DEEPSEEK_API_KEY:\s*["']?([^"'\r\n#]+)["']?\s*$/m.exec(text)
    return match ? match[1].trim() : ''
  } catch {
    return ''
  }
}

/** 汇总 AI 配置：设置页 > 环境变量 > DSH 凭据文件。 */
export function resolveAiConfig(settings = {}, dshHome) {
  const mode = AI_MODES.includes(settings.aiRepair) ? settings.aiRepair : DEFAULT_AI.mode
  const model = String(settings.aiModel || '').trim() || DEFAULT_AI.model
  const baseURL = String(settings.aiBaseURL || '').trim().replace(/\/+$/, '') || DEFAULT_AI.baseURL
  const fromSettings = String(settings.aiApiKey || '').trim()
  const fromEnv = String(process.env.DEEPSEEK_API_KEY || '').trim()
  const fromFile = readCredentialsKey(dshHome)
  const key = fromSettings || fromEnv || fromFile
  const keySource = fromSettings ? 'settings' : fromEnv ? 'env' : fromFile ? 'credentials' : 'none'
  const rounds = Number(settings.aiMaxRounds)
  return {
    mode,
    model,
    baseURL,
    key,
    keySource,
    maxRounds: Number.isFinite(rounds) ? Math.max(0, Math.min(5, Math.trunc(rounds))) : DEFAULT_AI.maxRounds,
    allowDestructive: settings.aiAllowDestructive === true,
    commandTimeoutMs: DEFAULT_AI.commandTimeoutMs,
    requestTimeoutMs: DEFAULT_AI.requestTimeoutMs,
  }
}

/** 与 dsh 完全相同的两锚点解析：先安装目录，再 profile 目录。 */
function packageDirFromAnchor(anchor, name) {
  try {
    for (const searchPath of createRequire(anchor).resolve.paths(name) ?? []) {
      const candidate = join(searchPath, name)
      if (existsSync(join(candidate, 'package.json'))) return candidate
    }
  } catch {
    // 锚点不可用时按"解析不到"处理
  }
  return undefined
}

/** 描述 profile/node_modules 里的一个条目：是否存在、指向哪、目标是否有效。 */
function describeEntry(path) {
  try {
    const info = lstatSync(path)
    if (!info.isSymbolicLink()) return { exists: true, link: '', valid: existsSync(join(path, 'package.json')) }
    let link = ''
    try {
      link = readlinkSync(path)
    } catch {
      link = ''
    }
    const target = link && !/^[A-Za-z]:|^\\\\/.test(link) ? join(dirname(path), link) : link
    return { exists: true, link, valid: target ? existsSync(join(target, 'package.json')) : false }
  } catch {
    return { exists: false, link: '', valid: false }
  }
}

/** 读 profile 清单 + 逐个 bundle 的两锚点解析结果（确定性证据）。 */
export function inspectProfile({ profileDir, installAnchor }) {
  const manifestPath = join(profileDir, 'package.json')
  const result = { profileDir, manifestPath, exists: existsSync(manifestPath), bundles: [], dependencies: [], error: '' }
  if (!result.exists) {
    result.error = 'profile 清单不存在'
    return result
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    result.error = `清单不是合法 JSON: ${error instanceof Error ? error.message : error}`
    return result
  }
  result.bundles = (manifest.dsh?.profile?.bundles ?? []).map((name) => {
    const fromInstall = packageDirFromAnchor(installAnchor, name)
    const fromProfile = packageDirFromAnchor(join(profileDir, 'package.json'), name)
    return {
      name,
      resolvedFrom: fromInstall ? 'install' : fromProfile ? 'profile' : 'none',
      dir: fromInstall ?? fromProfile ?? '',
      entry: describeEntry(join(profileDir, 'node_modules', name)),
    }
  })
  result.dependencies = Object.keys(manifest.dependencies ?? {})
  const cordisRoot = join(profileDir, 'cordis.yml')
  result.cordisRoot = existsSync(cordisRoot) ? readFileSync(cordisRoot, 'utf8').trim().slice(0, 200) : '(缺失)'
  const patch = join(profileDir, 'cordis.patch.yml')
  result.userPatch = existsSync(patch) ? readFileSync(patch, 'utf8').trim().slice(0, 400) : '(缺失)'
  result.moduleFallback = describeEntry(join(profileDir, '.dsh-module-fallback', 'node_modules'))
  return result
}

function killTree(pid) {
  if (!pid) return
  try {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } catch {
    // 已经退出了
  }
}

/** 跑一条命令（非交互），返回退出码与输出尾巴。 */
export function runCommand({ command, cwd, env, timeoutMs = DEFAULT_AI.commandTimeoutMs, shell }) {
  return new Promise((resolve) => {
    const exe = shell || process.env.DSH_REPAIR_SHELL || 'powershell.exe'
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      killTree(child.pid)
      resolve({ code: null, out, err: `${err}\n[超时] 已终止（${timeoutMs}ms）`.trim(), timeout: true })
    }, timeoutMs)
    const push = (buf, toErr) => {
      const text = buf.toString('utf8')
      if (toErr) err = (err + text).slice(-MAX_OUTPUT)
      else out = (out + text).slice(-MAX_OUTPUT)
    }
    child.stdout.on('data', (buf) => push(buf, false))
    child.stderr.on('data', (buf) => push(buf, true))
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, out, err: String(error?.message || error), timeout: false })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err, timeout: false })
    })
  })
}

/** 安全的组合探测：让 dsh 自己走一遍 profile 组装（不监听端口、不挂载插件）。 */
export async function probeCompose({ nodePath, binPath, env, profile, timeoutMs = 90_000 }) {
  const result = await runCommand({
    command: `& "${nodePath}" "${binPath}" ${profile} --dump-config`,
    cwd: env?.DSH_HOME,
    env,
    timeoutMs,
    shell: process.env.DSH_REPAIR_SHELL,
  })
  const tail = `${result.out}\n${result.err}`.trim().split(/\r?\n/).slice(-12).join('\n')
  return { ok: result.code === 0, code: result.code, tail, timedOut: Boolean(result.timeout) }
}

/** 从失败输出里给错误定性，便于模型少猜。 */
export function classifyFailure(text) {
  const t = String(text ?? '')
  if (/cannot resolve profile bundle\s+"([^"]+)"/.test(t)) {
    return { kind: 'bundle-unresolved', bundle: /cannot resolve profile bundle\s+"([^"]+)"/.exec(t)[1] }
  }
  if (/declares no dsh\.bundle/.test(t)) return { kind: 'bundle-no-patch' }
  if (/same loader entry id|重复的 loader 条目|duplicate/i.test(t)) return { kind: 'duplicate-entry' }
  if (/ERR_PNPM_|npm error|npm ERR!/.test(t)) return { kind: 'package-manager' }
  if (/EBUSY|EPERM|EACCES|resource busy or locked|being used by another process/i.test(t)) return { kind: 'file-locked' }
  if (/Cannot find module|ERR_MODULE_NOT_FOUND/.test(t)) return { kind: 'module-missing' }
  if (/EADDRINUSE/.test(t)) return { kind: 'port-in-use' }
  if (/启动超时|timeout/i.test(t)) return { kind: 'start-timeout' }
  return { kind: 'unknown' }
}

function evidencePrompt(evidence) {
  return `# 现场证据（JSON）
${JSON.stringify(evidence, null, 2)}`
}

const SYSTEM_PROMPT = `你是 DeepSeek Harness (dsh) Windows 启动器的修复规划器。启动刚失败，你要给出少量、可逆、非交互的 PowerShell 修复步骤；启动器会执行后自动重试启动。

## 环境事实（必须遵守）
- 系统：Windows，命令由 powershell.exe -NoProfile -NonInteractive 执行；只能输出单行命令（多条用 ";" 串联），不能有交互式提示、不能有换行。
- 可用环境变量：$env:DSH_NODE（node.exe 路径）、$env:DSH_BIN（当前版本 dsh 的 lib/bin.js）、$env:DSH_VERSION、$env:DSH_HOME（默认 C:\\Users\\<用户>\\.dsh）、$env:DSH_PROFILE（如 web）、$env:DSH_PROFILE_DIR、$env:DSH_LAUNCHER_PLUGIN_TOOL（插件开关工具）。
- 跑 dsh 一律用：& $env:DSH_NODE $env:DSH_BIN <参数>，工作目录默认已是 $env:DSH_HOME。
- profile 结构：$env:DSH_PROFILE_DIR\\package.json 的 dsh.profile.bundles 决定加载哪些 bundle 包；bundle 解析规则与 Node 一致，先在 dsh 安装目录的 node_modules 找，再在 profile 目录找（profile\\node_modules 里是 pnpm 链接，另有共享回退目录 $env:DSH_HOME\\profiles\\node_modules 提供安装依赖闭包）。
- 插件管理官方入口：dsh plugin --profile <名称> install（重建 profile 依赖链接）/ add -w <包名> / remove <包名>。
- 插件开关（dsh 起不来时的主要出口）：& $env:DSH_NODE $env:DSH_LAUNCHER_PLUGIN_TOOL list；disable <包名或行id>；enable <包名或行id>。它按官方机制把 id + disabled: true 写进 cordis.patch.yml（下一条启动生效），是唯一允许的开关方式——不要手改 cordis.patch.yml，那里的占位符和空文件都有坑。
- 错误里出现 failed to import loader entry <行id> (<包名>) 时，首选就是 disable 这一行再让启动器重试（启动器已经会先自己试一次）。
- cordis.yml 是组合根文件，内容必须是 []（dsh 每次启动会自己重写）；用户覆盖层是 cordis.patch.yml。
- 只读探测：dsh <profile> --dump-config（输出组合后的树，不改状态）。

## 硬约束
- 不要重启/杀死启动器自身（manager 就是 node.exe），不要关机、不要改注册表、不要卸载杀软、不要递归删盘符根目录或整个 .dsh 目录。
- 优先"重建链接/重装依赖/最小配置改动"这类可逆操作；改任何文件前先用 Copy-Item 备份成 *.bak-<时间>。
- 需要临时改配置时，优先用 dsh 自带的 --patch 覆盖文件机制，而不是改用户手写的文件。
- 最多 3 步。若证据不足以确定原因，或只能靠大范围破坏性操作，就 giveUp=true 并给出人工建议。
- 今天是文件系统可能瞬时锁定的情况：若证据显示文件都在、只是刚才读不到，第一步可以是空操作重试（steps 为空、giveUp=false），启动器会直接重试。

## 输出（严格 JSON，无多余文字）
{"diagnosis":"一句话结论","rootCause":"根因（含不确定度说明）","confidence":0.0,"steps":[{"command":"单行 PowerShell","why":"这一步做什么","risk":"low|medium|high"}],"giveUp":false,"userHint":"给人看的一句话建议"}`

function extractJson(text) {
  const raw = String(text ?? '').trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const body = fenced ? fenced[1] : raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON')
  return JSON.parse(body.slice(start, end + 1))
}

/** 规范化模型返回的计划，剔除非法项。 */
export function parsePlan(raw) {
  const data = typeof raw === 'string' ? extractJson(raw) : raw
  const steps = Array.isArray(data?.steps) ? data.steps : []
  const plan = {
    diagnosis: String(data?.diagnosis ?? '').slice(0, 600),
    rootCause: String(data?.rootCause ?? '').slice(0, 900),
    confidence: Number.isFinite(Number(data?.confidence)) ? Math.max(0, Math.min(1, Number(data.confidence))) : 0,
    giveUp: data?.giveUp === true,
    userHint: String(data?.userHint ?? '').slice(0, 600),
    steps: [],
  }
  for (const step of steps.slice(0, MAX_STEPS)) {
    const command = String(step?.command ?? '').replace(/[\r\n]+/g, ' ').trim()
    if (!command || command.length > 2000) continue
    plan.steps.push({
      command,
      why: String(step?.why ?? '').slice(0, 300),
      risk: ['low', 'medium', 'high'].includes(step?.risk) ? step.risk : 'medium',
    })
  }
  if (plan.giveUp) plan.steps = []
  return plan
}

/** 调 deepseek-v4-flash 拿修复计划。 */
export async function askModel({ evidence, config, onLog }) {
  const url = `${config.baseURL}/chat/completions`
  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: evidencePrompt(evidence) },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 1600,
    stream: false,
  }
  const call = async (payload) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.key}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status} ${redact(text, [config.key]).slice(0, 300)}`)
    const data = JSON.parse(text)
    return data?.choices?.[0]?.message?.content ?? ''
  }
  let content
  try {
    content = await call(body)
  } catch (error) {
    // 少数网关不认 response_format，去掉再试一次
    if (/response_format/i.test(String(error?.message || ''))) {
      const { response_format: _drop, ...rest } = body
      content = await call(rest)
    } else {
      throw error
    }
  }
  const plan = parsePlan(content)
  onLog?.(`[AI] 结论：${plan.diagnosis || '(空)'}`)
  if (plan.rootCause) onLog?.(`[AI] 根因：${plan.rootCause}`)
  onLog?.(`[AI] 置信度 ${(plan.confidence * 100).toFixed(0)}% · 步骤 ${plan.steps.length} 个`)
  return plan
}

/** 命令准入检查：档位 + 危险命令拦截。 */
export function checkCommand(command, { mode, allowDestructive }) {
  if (mode === 'plan') return { ok: false, reason: '当前档位"只诊断"，不执行命令' }
  if (mode === 'safe' && !SAFE_ALLOW.some((re) => re.test(command))) {
    return { ok: false, reason: '当前档位"白名单动作"，该命令不在白名单内' }
  }
  if (!allowDestructive) {
    for (const rule of DANGEROUS) {
      if (rule.re.test(command)) return { ok: false, reason: `危险命令已拦截（${rule.why}）；如确需执行请在设置里打开"允许危险命令"` }
    }
  }
  return { ok: true, reason: '' }
}

function backupFile(file, onLog) {
  if (!existsSync(file)) return ''
  try {
    const dest = `${file}.bak-${stamp()}`
    copyFileSync(file, dest)
    onLog?.(`[AI] 已备份 ${file} → ${dest}`)
    return dest
  } catch (error) {
    onLog?.(`[AI] 备份失败：${error instanceof Error ? error.message : error}`)
    return ''
  }
}

/** 纯诊断路径：只写日志，不动系统（plan 档 / 缺少 key / 模型失败时使用）。 */
function reportOnly(plan, onLog) {
  onLog?.('[AI] 当前只做诊断，未执行任何命令。可手工执行以下步骤：')
  plan.steps.forEach((step, index) => onLog?.(`[AI]   ${index + 1}. ${step.command}    # ${step.why}`))
  if (plan.userHint) onLog?.(`[AI] 建议：${plan.userHint}`)
}

/**
 * 跑一轮修复：收集证据 → 模型出计划 → 执行。
 * @returns 报告对象（含 plan / executed / blocked），供上层决定是否重试。
 */
export async function runRepairRound({
  version,
  binPath,
  nodePath,
  dshHome,
  profile = 'web',
  profileDir,
  installAnchor,
  childEnv,
  error,
  logTail = [],
  config,
  history = [],
  round = 1,
  onLog = () => {},
}) {
  const secrets = [config.key].filter(Boolean)
  const emit = (line) => onLog(redact(line, secrets))
  emit(`[AI] ── 第 ${round} 轮修复 · 模型 ${config.model} · 档位 ${AI_MODE_LABELS[config.mode] || config.mode}`)

  if (config.mode === 'off') {
    emit('[AI] 自动修复已关闭，跳过。')
    return { skipped: 'off' }
  }
  if (!config.key) {
    emit(`[AI] 未找到 API key（设置页 / DEEPSEEK_API_KEY / ${join(dshHome, '.credentials.yaml')}），本轮跳过。`)
    return { skipped: 'no-key' }
  }

  const inspect = inspectProfile({ profileDir, installAnchor })
  const probe = await probeCompose({ nodePath, binPath, env: childEnv, profile })
  emit(`[AI] 组合探测(--dump-config) 退出码 ${probe.code}${probe.ok ? '（profile 可组装）' : '（组装失败，见证据）'}`)

  const failure = classifyFailure(`${error?.message || error || ''}\n${logTail.join('\n')}`)
  emit(`[AI] 错误归类：${failure.kind}${failure.bundle ? ` (${failure.bundle})` : ''}`)

  const evidence = {
    version,
    profile,
    node: process.versions.node,
    platform: process.platform,
    failure,
    errorMessage: String(error?.message || error || '').slice(0, 1200),
    probe,
    profile: { ...inspect, dir: profileDir },
    logTail: logTail.slice(-80).map((line) => String(line).slice(0, 400)),
    // 错误输出里被点名的插件行：模型据此直接开禁用，不用猜
    failingPluginRows: parseFailedRows(`${String(error?.message || error || '')}\n${logTail.join('\n')}`),
    pluginTool: join(ROOT, 'plugin-tool.js'),
    alreadyTried: history,
    env: { DSH_HOME: dshHome, DSH_BIN: binPath, DSH_NODE: nodePath, DSH_PROFILE: profile },
  }

  let plan
  try {
    plan = await askModel({ evidence, config, onLog: emit })
  } catch (error) {
    emit(`[AI] 调用模型失败：${error instanceof Error ? error.message : error}`)
    return { error: 'model-call-failed' }
  }

  if (!plan.steps.length) {
    emit(`[AI] 没有可执行步骤${plan.giveUp ? '（模型认为无法自动修复）' : '，直接重试启动。'}`)
    if (plan.userHint) emit(`[AI] 建议：${plan.userHint}`)
    return { plan, executed: [], retry: !plan.giveUp }
  }
  if (config.mode === 'plan') {
    reportOnly(plan, emit)
    return { plan, executed: [], retry: false }
  }

  const executed = []
  for (const [index, step] of plan.steps.entries()) {
    const verdict = checkCommand(step.command, config)
    if (!verdict.ok) {
      emit(`[AI] 跳过第 ${index + 1} 步：${verdict.reason}`)
      emit(`[AI]   （${step.command}）`)
      executed.push({ ...step, skipped: verdict.reason })
      continue
    }
    if (history.includes(step.command)) {
      emit(`[AI] 跳过第 ${index + 1} 步：本轮之前已执行过同一条命令（避免死循环）`)
      executed.push({ ...step, skipped: 'duplicate' })
      continue
    }
    emit(`[AI] 执行 ${index + 1}/${plan.steps.length}（风险 ${step.risk}）：${step.command}`)
    if (step.why) emit(`[AI]   原因：${step.why}`)
    // 允许命令自己备份：这里给涉及 profile 配置的命令追加一次兜底备份提示
    const result = await runCommand({
      command: step.command,
      cwd: dshHome,
      env: childEnv,
      timeoutMs: config.commandTimeoutMs,
    })
    const tail = `${result.out}\n${result.err}`.trim().split(/\r?\n/).filter(Boolean).slice(-12).join('\n')
    if (tail) emit(`[AI]   输出：${tail}`)
    emit(`[AI]   退出码 ${result.code ?? '(超时/被终止)'}`)
    executed.push({ ...step, code: result.code, out: tail })
    if (result.code !== 0) {
      emit('[AI] 该步失败，继续下一步（由后续重试决定成败）。')
    }
  }
  return { plan, executed, retry: true }
}

/** 兜底备份：修复前把 profile 的关键文件存一份快照。 */
export function snapshotProfileFiles({ profileDir, dshHome, onLog = () => {} }) {
  const files = [
    join(profileDir, 'package.json'),
    join(profileDir, 'cordis.yml'),
    join(profileDir, 'cordis.patch.yml'),
  ]
  const dir = join(dshHome, '.dsh-repair-backup')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return []
  }
  const saved = []
  for (const file of files) {
    if (!existsSync(file)) continue
    try {
      const info = statSync(file)
      if (!info.isFile()) continue
      const dest = join(dir, `${stamp()}__${file.replace(/[:\\/]/g, '_')}`)
      copyFileSync(file, dest)
      saved.push(dest)
    } catch {
      // 单个文件备份失败不影响修复
    }
  }
  if (saved.length) onLog(`[AI] 已快照 profile 配置 ${saved.length} 个文件 → ${dir}`)
  return saved
}

export { ROOT as REPAIR_ROOT }
