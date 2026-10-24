#!/usr/bin/env node
/**
 * 插件包独立校验（docs/15 §8）：`node scripts/verify-plugin.mjs <目录|.zip|.aurora-plugin>`
 *
 * 与桌面安装器 / Center 市场**共用同一份清单 schema**（`@aurora/shared` 的
 * `parsePluginManifest`），因此这里通过的包在两端不会再因契约不同被拒。
 *
 * 需要先 `pnpm build:packages`（读取 `packages/shared/dist`）；缺失时明确提示。
 * 退出码：0 通过；1 校验失败；2 用法错误。
 */
import { existsSync, promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { unzipSync } from 'fflate'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SHARED_ENTRY = join(ROOT, 'packages', 'shared', 'dist', 'index.js')

const MAX_ENTRIES = 2000
const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_BYTES = 50 * 1024 * 1024
const MAX_ZIP_BYTES = 20 * 1024 * 1024
const MAX_RATIO = 200

function fail(message) {
  console.error(`✗ ${message}`)
  process.exitCode = 1
}

function ok(message) {
  console.log(`✓ ${message}`)
}

function pathProblem(name) {
  const normalized = String(name).replace(/\\/g, '/')
  if (normalized.includes('\0')) return '路径包含 NUL'
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('//')) {
    return `绝对路径：${name}`
  }
  if (normalized.split('/').some((segment) => segment === '..')) return `上级路径：${name}`
  return null
}

async function loadShared() {
  if (!existsSync(SHARED_ENTRY)) {
    console.error('✗ 找不到 packages/shared/dist（先运行 `pnpm build:packages`）')
    process.exit(1)
  }
  return await import(pathToFileURL(SHARED_ENTRY).href)
}

async function readZip(buffer) {
  if (buffer.byteLength > MAX_ZIP_BYTES) throw new Error('插件包超过 20 MB 上限')
  let total = 0
  let entries = 0
  const issues = []
  let files
  try {
    files = unzipSync(new Uint8Array(buffer), {
      filter: (file) => {
        entries += 1
        if (entries > MAX_ENTRIES) {
          issues.push(`条目超过 ${MAX_ENTRIES} 个`)
          return false
        }
        const problem = pathProblem(file.name)
        if (problem !== null) {
          issues.push(problem)
          return false
        }
        total += file.originalSize
        if (file.originalSize > MAX_FILE_BYTES) {
          issues.push(`单文件超过 10 MB：${file.name}`)
          return false
        }
        if (total > MAX_TOTAL_BYTES) {
          issues.push('解压总量超过 50 MB')
          return false
        }
        if (
          file.originalSize > 1024 * 1024 &&
          file.size > 0 &&
          file.originalSize / file.size > MAX_RATIO
        ) {
          issues.push(`压缩比异常：${file.name}`)
          return false
        }
        return true
      },
    })
  } catch (error) {
    throw new Error(`不是合法的 zip：${String(error)}`)
  }
  if (issues.length > 0) throw new Error(issues[0])
  return Object.fromEntries(
    Object.entries(files)
      .filter(([name]) => !name.endsWith('/'))
      .map(([name, data]) => [name.replace(/\\/g, '/'), data]),
  )
}

async function readDirectory(dir) {
  const files = {}
  const walk = async (current) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile()) {
        const name = absolute
          .slice(dir.length + 1)
          .split('\\')
          .join('/')
        files[name] = new Uint8Array(await fs.readFile(absolute))
      }
    }
  }
  await walk(dir)
  return files
}

async function main() {
  const target = process.argv[2]
  if (target === undefined) {
    console.error('用法：node scripts/verify-plugin.mjs <插件目录|.zip|.aurora-plugin>')
    process.exit(2)
  }
  const absolute = resolve(process.cwd(), target)
  if (!existsSync(absolute)) {
    console.error(`✗ 路径不存在：${absolute}`)
    process.exit(2)
  }
  const shared = await loadShared()
  const { parsePluginManifest, pluginToolName, isManifestTooLarge, normalizePluginPath } = shared

  const stat = await fs.stat(absolute)
  let files
  if (stat.isDirectory()) {
    files = await readDirectory(absolute)
  } else {
    files = await readZip(await fs.readFile(absolute))
  }

  const manifestBytes = files['manifest.json']
  if (manifestBytes === undefined) {
    fail('缺少根目录 manifest.json')
    return
  }
  if (isManifestTooLarge(manifestBytes.byteLength)) {
    fail('manifest.json 超过 64 KB')
    return
  }
  let json
  try {
    json = JSON.parse(Buffer.from(manifestBytes).toString('utf8'))
  } catch (error) {
    fail(`manifest.json 不是合法 JSON：${String(error)}`)
    return
  }
  const parsed = parsePluginManifest(json)
  if (!parsed.ok || parsed.manifest === undefined) {
    for (const error of parsed.errors) fail(`清单：${error}`)
    return
  }
  const manifest = parsed.manifest
  ok(`清单通过：${manifest.id} ${manifest.name} v${manifest.version}`)
  ok(`权限：${manifest.permissions.length === 0 ? '（无）' : manifest.permissions.join(', ')}`)

  const names = new Set(Object.keys(files))
  const requireFile = (relative, label) => {
    const normalized = normalizePluginPath(relative)
    if (normalized === null || !names.has(normalized)) fail(`${label} 不存在：${relative}`)
  }
  requireFile(manifest.main, 'main 入口')
  for (const skill of manifest.contributes.skills) {
    const normalized = normalizePluginPath(skill)
    if (normalized === null || !names.has(`${normalized}/SKILL.md`)) {
      fail(`Skill 目录缺少 SKILL.md：${skill}`)
    }
  }
  for (const panel of manifest.contributes.panels) {
    const file = panel.schema ?? panel.entry
    if (file !== undefined) requireFile(file, `面板「${panel.id}」文件`)
  }
  for (const widget of manifest.contributes.widgets) {
    const file = widget.schema ?? widget.entry
    if (file !== undefined) requireFile(file, `小组件「${widget.id}」文件`)
  }
  if (manifest.icon !== undefined) requireFile(manifest.icon, '市场图标')

  for (const tool of manifest.contributes.tools) {
    const full = pluginToolName(manifest.id, tool.name)
    if (full.length > 64) fail(`工具最终名超过 64 字符：${full}`)
    else console.log(`  · 工具 ${full}（${tool.sensitivity}${tool.readonly ? '，只读' : ''}）`)
  }
  for (const panel of manifest.contributes.panels) {
    console.log(`  · 面板 ${panel.id}（${panel.schema === undefined ? '页面' : '声明式'}）`)
  }
  for (const widget of manifest.contributes.widgets) {
    console.log(
      `  · 小组件 ${widget.id}（${widget.slot === 'desktop' ? '桌面' : '提示条'} · ${
        widget.schema === undefined ? '页面' : '声明式'
      }）`,
    )
  }
  for (const theme of manifest.contributes.themes) {
    console.log(`  · 主题 ${theme.id}（${Object.keys(theme.tokens).length} 个令牌）`)
  }

  if (process.exitCode === undefined) {
    console.log('\n插件包校验通过。安装前请确认来源可信：插件以你的用户权限运行。')
  }
}

main().catch((error) => {
  console.error(`✗ 校验异常：${String(error)}`)
  process.exit(1)
})
