import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, rmSync } from 'node:fs'
import { copyFile, cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NODE_VERSION = process.env.DSH_NODE_VERSION || '22.19.0'
const DIST = `node-v${NODE_VERSION}-win-x64`
const ZIP = `${DIST}.zip`
const VENDOR = join(ROOT, 'vendor')
const ZIP_PATH = join(VENDOR, ZIP)
const EXTRACTED = join(VENDOR, DIST)
const OUT = join(ROOT, 'release', 'DSH')

function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`)
}

async function downloadNode() {
  await mkdir(VENDOR, { recursive: true })
  if (existsSync(join(EXTRACTED, 'node.exe'))) return
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${ZIP}`
  console.log(`下载 ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载 Node 失败 HTTP ${res.status}`)
  await pipeline(res.body, createWriteStream(ZIP_PATH))
  run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force '${ZIP_PATH}' '${VENDOR}'`])
}

async function buildLauncher() {
  run('cargo', ['build', '--release'], join(ROOT, 'launcher'))
}

async function assemble() {
  rmSync(OUT, { recursive: true, force: true })
  await mkdir(join(OUT, 'public'), { recursive: true })
  await mkdir(join(OUT, 'assets'), { recursive: true })
  await mkdir(join(OUT, 'node'), { recursive: true })
  for (const file of ['start.js', 'server.js', 'package.json']) {
    await copyFile(join(ROOT, file), join(OUT, file))
  }
  await cp(join(ROOT, 'public'), join(OUT, 'public'), { recursive: true })
  await cp(join(ROOT, 'assets'), join(OUT, 'assets'), { recursive: true })
  await cp(EXTRACTED, join(OUT, 'node'), { recursive: true })
  await copyFile(join(ROOT, 'launcher', 'target', 'release', 'DSH.exe'), join(OUT, 'DSH.exe'))
  run(join(OUT, 'node', 'npm.cmd'), ['install', '--omit=dev', '--prefix', OUT])
  console.log(`已打包到 ${OUT}`)
}

await downloadNode()
await buildLauncher()
await assemble()
