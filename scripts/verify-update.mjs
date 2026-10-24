#!/usr/bin/env node
/**
 * 发布产物验收（docs/09 §6）：不联网，只检查 `apps/desktop/release` 里的产物是否
 * 满足"可安装 + 可被自动更新"的全部前提。
 *
 * 用法：
 *   node scripts/verify-update.mjs            # 校验已存在的 release 产物
 *   node scripts/verify-update.mjs --keep     # 校验后保留临时校验文件
 *
 * 覆盖点：
 * 1. NSIS 安装包存在且体积合理（> 30MB，排除空包）；
 * 2. `latest.yml` 版本与 package.json 一致，且 sha512 / size 与安装包**实际内容**一致
 *    （electron-updater 会用这两个字段校验下载结果，不一致会导致更新失败）；
 * 3. `*.blockmap` 存在（差分下载的前提）；
 * 4. `win-unpacked/` 已打包完成：asar 存在、内置 skills 已随包、
 *    `app-update.yml` 指向公开 releases 仓库（否则装机后检查更新会失败）；
 * 5. 安装包内不含明文 API Key（粗筛 sk- 形态）。
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const releaseDir = join(root, 'apps', 'desktop', 'release')
const packageJson = JSON.parse(
  await fs.readFile(join(root, 'apps', 'desktop', 'package.json'), 'utf8'),
)

const results = []
const record = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail })

async function exists(path) {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

async function stat(path) {
  try {
    return await fs.stat(path)
  } catch {
    return null
  }
}

function sha512Base64(buffer) {
  return createHash('sha512').update(buffer).digest('base64')
}

/** 极简 YAML 取值：latest.yml 是我们自己生成的固定结构，够用且不引入依赖 */
function readYamlScalar(text, key) {
  const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(text)
  return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : undefined
}

function readYamlFileEntry(text) {
  const url = /-\s*url:\s*(.+)$/m.exec(text)?.[1]?.trim()
  const sha512 = /^\s*sha512:\s*(.+)$/m.exec(text)?.[1]?.trim()
  const size = /^\s*size:\s*(\d+)\s*$/m.exec(text)?.[1]
  return { url, sha512, size: size === undefined ? undefined : Number(size) }
}

const version = packageJson.version

// ── 1. 安装包 ──
const installerName = `Aurora-Setup-${version}.exe`
const installerPath = join(releaseDir, installerName)
const installerStat = await stat(installerPath)
record('安装包存在', installerStat !== null, installerName)
record(
  '安装包体积合理（> 30MB）',
  installerStat !== null && installerStat.size > 30 * 1024 * 1024,
  installerStat === null ? '文件缺失' : `${(installerStat.size / 1024 / 1024).toFixed(1)} MB`,
)

// ── 2. latest.yml 与实际内容一致 ──
const latestPath = join(releaseDir, 'latest.yml')
const latestExists = await exists(latestPath)
record('latest.yml 存在（自动更新元数据）', latestExists, 'latest.yml')

if (latestExists && installerStat !== null) {
  const latest = await fs.readFile(latestPath, 'utf8')
  record(
    'latest.yml 版本与 package.json 一致',
    readYamlScalar(latest, 'version') === version,
    `expected ${version}`,
  )

  const entry = readYamlFileEntry(latest)
  record('latest.yml 指向正确的安装包名', entry.url === installerName, String(entry.url))
  record(
    'latest.yml size 与实际文件一致',
    entry.size === installerStat.size,
    `${entry.size} vs ${installerStat.size}`,
  )

  const actualSha = sha512Base64(await fs.readFile(installerPath))
  record(
    'latest.yml sha512 与实际文件一致（更新校验会用到）',
    entry.sha512 === actualSha,
    entry.sha512 === actualSha ? '' : `expected ${actualSha} got ${entry.sha512}`,
  )

  // ── 5. 安装包内不含明文密钥（粗筛） ──
  const head = await fs.readFile(installerPath)
  const suspicious = /\bsk-[A-Za-z0-9]{16,}\b/.exec(head.toString('latin1'))
  record('安装包内无 sk- 形态明文密钥', suspicious === null, suspicious?.[0]?.slice(0, 12) ?? '')
}

// ── 3. blockmap ──
const blockmapPath = join(releaseDir, `${installerName}.blockmap`)
record('差分更新 blockmap 存在', await exists(blockmapPath), `${installerName}.blockmap`)

// ── 4. 解包目录 ──
const unpacked = join(releaseDir, 'win-unpacked')
record('win-unpacked 存在', await exists(unpacked), 'win-unpacked')
record('asar 已打包', await exists(join(unpacked, 'resources', 'app.asar')), 'resources/app.asar')

// 插件子进程 / 页面 preload 是 electron.vite 的独立入口，漏掉任何一个打包后运行时才炸
const pluginHostBuilt = await exists(join(root, 'apps', 'desktop', 'out', 'main', 'plugin-host.js'))
const pluginPagePreloadBuilt = await exists(
  join(root, 'apps', 'desktop', 'out', 'preload', 'plugin-page.js'),
)
record(
  '插件入口已构建（plugin-host / plugin-page）',
  pluginHostBuilt && pluginPagePreloadBuilt,
  `host=${pluginHostBuilt} page=${pluginPagePreloadBuilt}`,
)

const skillsDir = join(unpacked, 'resources', 'skills')
const skillEntries = await fs.readdir(skillsDir).catch(() => [])
record(
  '内置 Skill 随包（extraResources）',
  skillEntries.length >= 3,
  skillEntries.join(',') || '缺失',
)

const appUpdatePath = join(unpacked, 'resources', 'app-update.yml')
if (await exists(appUpdatePath)) {
  const appUpdate = await fs.readFile(appUpdatePath, 'utf8')
  const owner = readYamlScalar(appUpdate, 'owner')
  const repo = readYamlScalar(appUpdate, 'repo')
  record(
    'app-update.yml 指向公开 releases 仓库',
    owner === 'LinePixel2025' && repo === 'Aurora-releases',
    `${owner}/${repo}`,
  )
  record(
    'app-update.yml provider 为 github',
    readYamlScalar(appUpdate, 'provider') === 'github',
    readYamlScalar(appUpdate, 'provider'),
  )
} else {
  record('app-update.yml 存在（更新源配置）', false, '缺失 → 装机后无法检查更新')
}

// ── 输出 ──
for (const item of results) {
  const line = `${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail === '' ? '' : ` — ${item.detail}`}`
  if (item.ok) console.log(line)
  else console.error(line)
}

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
process.exit(failed.length === 0 ? 0 : 2)
