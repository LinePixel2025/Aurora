#!/usr/bin/env node
/**
 * 端到端验证"安装版能发现更新"（docs/09 §6）。
 *
 * 做法：起一个本地 HTTP 服务，按 electron-updater 的 generic provider 协议
 * 提供 `latest.yml` 与安装包，然后用 `AURORA_UPDATE_FEED` 把**已打包**的
 * Aurora.exe 指过去，并检查它是否真的报告"发现新版本"。
 *
 * 这验证了打包产物里真实生效的链路：
 * electron-updater → app-update.yml（被 override）→ feed 解析 → 版本比较 → 状态事件。
 *
 * 前置：先 `pnpm --filter @aurora/desktop package` 生成 release 产物。
 * 用法：node scripts/verify-update-e2e.mjs
 *
 * 注意：只读取产物、写临时目录，不会安装或修改任何东西。
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const releaseDir = join(root, 'apps', 'desktop', 'release')
const exePath = join(releaseDir, 'win-unpacked', 'Aurora.exe')
const packageJson = JSON.parse(
  await fs.readFile(join(root, 'apps', 'desktop', 'package.json'), 'utf8'),
)

const REAL_VERSION = packageJson.version
/** 故意高于当前版本，用来触发"发现新版本"分支 */
const FAKE_VERSION = '99.0.0'

async function exists(path) {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

if (!(await exists(exePath))) {
  console.error(`缺少打包产物：${exePath}\n请先运行 pnpm --filter @aurora/desktop package`)
  process.exit(2)
}

const installerName = `Aurora-Setup-${REAL_VERSION}.exe`
const installerPath = join(releaseDir, installerName)
if (!(await exists(installerPath))) {
  console.error(`缺少安装包：${installerPath}`)
  process.exit(2)
}

const installer = await fs.readFile(installerPath)
const sha512 = createHash('sha512').update(installer).digest('base64')
const latestYml = [
  `version: ${FAKE_VERSION}`,
  'files:',
  `  - url: ${installerName}`,
  `    sha512: ${sha512}`,
  `    size: ${installer.length}`,
  `path: ${installerName}`,
  `sha512: ${sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  '',
].join('\n')

// ── 本地更新源 ──
const served = []
const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  served.push(path)
  if (path.endsWith('latest.yml')) {
    res.writeHead(200, { 'content-type': 'text/yaml' })
    res.end(latestYml)
    return
  }
  if (path.endsWith(installerName)) {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(installer.length),
    })
    res.end(installer)
    return
  }
  res.writeHead(404)
  res.end('not found')
})
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
const port = server.address().port
const feed = `http://127.0.0.1:${port}/updates`

// ── 用临时 userData 启动已打包应用（不碰真实配置） ──
const workDir = await fs.mkdtemp(join(tmpdir(), 'aurora-update-e2e-'))
const userData = join(workDir, 'userData')

console.log(`启动打包应用验证更新发现：feed=${feed}（伪装新版本 ${FAKE_VERSION}）`)
const child = spawn(exePath, [`--user-data-dir=${userData}`], {
  env: {
    ...process.env,
    AURORA_UPDATE_FEED: feed,
    AURORA_UPDATE_AUTODELAY_MS: '1500',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
})

let stderr = ''
child.stderr?.on('data', (chunk) => {
  stderr += chunk.toString('utf8')
})

/** 轮询日志目录（应用自身写日志，比 stdout 可靠） */
async function readLogs() {
  const logsDir = join(userData, 'logs')
  try {
    const entries = await fs.readdir(logsDir)
    let text = ''
    for (const entry of entries) {
      if (!entry.endsWith('.log')) continue
      text += await fs.readFile(join(logsDir, entry), 'utf8')
    }
    return text
  } catch {
    return ''
  }
}

let logText = ''
const deadline = Date.now() + 40_000
while (Date.now() < deadline) {
  await new Promise((resolveWait) => setTimeout(resolveWait, 1000))
  logText = await readLogs()
  if (logText.includes('发现新版本') || logText.includes('更新失败')) break
  if (child.exitCode !== null) break
}

try {
  child.kill()
} catch {
  /* 忽略 */
}
server.close()
await new Promise((resolveWait) => setTimeout(resolveWait, 500))
await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)

// ── 断言 ──
const results = []
const record = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail })

record(
  '打包应用已启动并写入日志',
  logText.length > 0,
  logText === '' ? `stderr=${stderr.slice(0, 200)}` : `${logText.length} 字节`,
)
record('更新源被环境变量覆盖（自测开关生效）', logText.includes('更新源被环境变量覆盖'), '')
record(
  `发现了伪装的新版本 ${FAKE_VERSION}`,
  logText.includes(`发现新版本`) && logText.includes(FAKE_VERSION),
  logText.includes('发现新版本') ? '状态机进入 available' : '未出现"发现新版本"日志',
)
record(
  '确实向本地更新源请求过 latest.yml',
  served.some((item) => item.endsWith('latest.yml')),
  served.join(' | ') || '（没有任何请求）',
)
record('未停留在检查失败状态', !logText.includes('更新失败'), '')

for (const item of results) {
  const line = `${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail === '' ? '' : ` — ${item.detail}`}`
  if (item.ok) console.log(line)
  else console.error(line)
}
const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
process.exit(failed.length === 0 ? 0 : 2)
