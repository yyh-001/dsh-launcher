import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync, rmSync } from 'node:fs'
import { copyFile, cp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const NODE_VERSION = process.env.DSH_NODE_VERSION || '22.19.0'
// dsh 的 profile 用 pnpm 8（lockfile 6.0），便携目录带同主版本
const PNPM_VERSION = process.env.DSH_PNPM_VERSION || '8.15.9'
const DIST = `node-v${NODE_VERSION}-win-x64`
const ZIP = `${DIST}.zip`
const VENDOR = join(ROOT, 'vendor')
const ZIP_PATH = join(VENDOR, ZIP)
const EXTRACTED = join(VENDOR, DIST)
const OUT = join(ROOT, 'release', 'DSH')
const INNO_DIR = join(VENDOR, 'inno')
const INNO_SETUP = join(VENDOR, 'innosetup.exe')
const ISCC = join(INNO_DIR, 'ISCC.exe')
const SETUP_ISS = join(ROOT, 'scripts', 'dsh-setup.iss')
const SETUP_NAME = 'DSH-Setup'
const DESKTOP = join(process.env.USERPROFILE || ROOT, 'Desktop')

function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: false })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`)
}

async function download(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status} ${url}`)
  await pipeline(res.body, createWriteStream(dest))
}

async function downloadNode() {
  await mkdir(VENDOR, { recursive: true })
  if (existsSync(join(EXTRACTED, 'node.exe'))) return
  const urls = [
    `https://npmmirror.com/mirrors/node/v${NODE_VERSION}/${ZIP}`,
    `https://nodejs.org/dist/v${NODE_VERSION}/${ZIP}`,
  ]
  let last
  for (const url of urls) {
    try {
      console.log(`下载 ${url}`)
      await download(url, ZIP_PATH)
      last = null
      break
    } catch (error) {
      last = error
    }
  }
  if (last) throw last
  run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force '${ZIP_PATH}' '${VENDOR}'`])
}

async function copyNodeRuntime() {
  await mkdir(join(OUT, 'node'), { recursive: true })
  await copyFile(join(EXTRACTED, 'node.exe'), join(OUT, 'node', 'node.exe'))
  for (const name of ['npm', 'npm.cmd', 'npm.ps1', 'npx', 'npx.cmd', 'npx.ps1', 'corepack', 'corepack.cmd']) {
    const src = join(EXTRACTED, name)
    if (existsSync(src)) await copyFile(src, join(OUT, 'node', name))
  }
  await mkdir(join(OUT, 'node', 'node_modules'), { recursive: true })
  await cp(join(EXTRACTED, 'node_modules', 'npm'), join(OUT, 'node', 'node_modules', 'npm'), { recursive: true })
  const corepack = join(EXTRACTED, 'node_modules', 'corepack')
  if (existsSync(corepack)) {
    await cp(corepack, join(OUT, 'node', 'node_modules', 'corepack'), { recursive: true })
  }
  await copyPnpm()
}

/**
 * `dsh plugin` 是 pnpm 的透传器，PATH 上没有 pnpm 就完全装不了插件（含开机预装
 * dshmarket）。机器上有没有全局 pnpm 全看运气，所以便携目录自带一个，启动器再
 * 把它加进子进程 PATH。
 */
async function copyPnpm() {
  const target = join(OUT, 'node', 'node_modules', 'pnpm')
  if (existsSync(join(target, 'bin', 'pnpm.cjs'))) return
  const staging = join(VENDOR, 'pnpm')
  if (!existsSync(join(staging, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'))) {
    console.log(`下载 pnpm@${PNPM_VERSION}`)
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, 'package.json'), JSON.stringify({
      name: 'pnpm-bootstrap',
      private: true,
      dependencies: { pnpm: PNPM_VERSION },
    }, null, 2))
    run(process.execPath, [join(EXTRACTED, 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'install',
      '--registry=https://registry.npmmirror.com', '--no-audit', '--no-fund'], staging)
  }
  await cp(join(staging, 'node_modules', 'pnpm'), target, { recursive: true })
  await writeFile(join(OUT, 'node', 'pnpm.cmd'), [
    '@ECHO off',
    'SETLOCAL',
    'SET "PNPM_JS=%~dp0node_modules\\pnpm\\bin\\pnpm.cjs"',
    '"%~dp0node.exe" "%PNPM_JS%" %*',
    '',
  ].join('\r\n'))
  await writeFile(join(OUT, 'node', 'pnpm'), [
    '#!/bin/sh',
    'exec "$(dirname "$0")/node.exe" "$(dirname "$0")/node_modules/pnpm/bin/pnpm.cjs" "$@"',
    '',
  ].join('\n'))
  const pnpx = 'pnpx'
  await writeFile(join(OUT, 'node', `${pnpx}.cmd`), [
    '@ECHO off',
    'SETLOCAL',
    '"%~dp0node.exe" "%~dp0node_modules\\pnpm\\bin\\pnpx.cjs" %*',
    '',
  ].join('\r\n'))
}

async function buildLauncher() {
  run('cargo', ['build', '--release'], join(ROOT, 'launcher'))
}

async function assemble() {
  rmSync(OUT, { recursive: true, force: true })
  await mkdir(join(OUT, 'public'), { recursive: true })
  await mkdir(join(OUT, 'assets'), { recursive: true })
  await mkdir(join(OUT, 'traybin'), { recursive: true })
  for (const file of [
    'start.js',
    'server.js',
    'registry.js',
    'settings.js',
    'plugins.js',
    'plugin-tool.js',
    'stdio-unblock.cjs',
    'package.json',
  ]) {
    await copyFile(join(ROOT, file), join(OUT, file))
  }
  await cp(join(ROOT, 'public'), join(OUT, 'public'), { recursive: true })
  await cp(join(ROOT, 'assets'), join(OUT, 'assets'), { recursive: true })
  await cp(join(ROOT, 'perf'), join(OUT, 'perf'), { recursive: true })
  await copyNodeRuntime()
  await cp(join(ROOT, 'node_modules'), join(OUT, 'node_modules'), { recursive: true })
  await copyFile(
    join(ROOT, 'node_modules', 'systray2', 'traybin', 'tray_windows_release.exe'),
    join(OUT, 'traybin', 'tray_windows_release.exe'),
  )
  await copyFile(join(ROOT, 'launcher', 'target', 'release', 'DSH.exe'), join(OUT, 'DSH.exe'))
  console.log(`已打包到 ${OUT}`)
}

function findIscc() {
  const candidates = [
    ISCC,
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    join(process.env['ProgramFiles(x86)'] || '', 'Inno Setup 6', 'ISCC.exe'),
    join(process.env.ProgramFiles || '', 'Inno Setup 6', 'ISCC.exe'),
  ]
  return candidates.find((path) => path && existsSync(path)) || ''
}

async function ensureInno() {
  const existing = findIscc()
  if (existing) return existing
  await mkdir(VENDOR, { recursive: true })
  const url = 'https://github.com/jrsoftware/issrc/releases/download/is-6_7_3/innosetup-6.7.3.exe'
  console.log(`下载 Inno Setup ${url}`)
  await download(url, INNO_SETUP)
  if (!existsSync(INNO_SETUP) || readFileSync(INNO_SETUP).length < 1_000_000) {
    throw new Error('Inno Setup 下载失败')
  }
  await mkdir(INNO_DIR, { recursive: true })
  console.log(`安装 Inno Setup 到 ${INNO_DIR}`)
  run(INNO_SETUP, [
    '/VERYSILENT',
    '/SUPPRESSMSGBOXES',
    '/NORESTART',
    '/SP-',
    `/DIR=${INNO_DIR}`,
  ])
  const installed = findIscc()
  if (!installed) throw new Error('Inno Setup 安装后找不到 ISCC.exe')
  return installed
}

async function buildInstaller() {
  const iscc = await ensureInno()
  console.log('编译安装包')
  run(iscc, [
    SETUP_ISS,
    `/DMyAppVersion=${PKG.version}`,
    `/O${join(ROOT, 'release')}`,
    `/F${SETUP_NAME}`,
  ])
  const setup = join(ROOT, 'release', `${SETUP_NAME}.exe`)
  if (!existsSync(setup)) throw new Error(`没有生成 ${setup}`)
  const desktop = join(DESKTOP, `${SETUP_NAME}.exe`)
  await copyFile(setup, desktop)
  console.log(`安装包: ${setup}`)
  console.log(`已复制到桌面: ${desktop}`)
}

await downloadNode()
await buildLauncher()
await assemble()
await buildInstaller()
