#!/usr/bin/env node
/* global process */
/**
 * 从模板创建一个新插件（工具包 v0.5.9）。
 *
 *   node tools/create-plugin.mjs <插件目录> [--id com.example.foo] [--name "显示名"] [--version 0.1.0]
 *
 * 做的事：
 *   1. 复制 `template/` 到目标目录（目标必须不存在或为空）；
 *   2. 写入 `manifest.json` 的 id / name / version；
 *   3. 附带 `types/aurora-plugin.d.ts`（编辑器补全）；
 *   4. 立刻跑一遍 `tools/check-plugin.mjs`，失败时退出码 1。
 *
 * 只用 Node 内置模块。
 */
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXIT_OK = 0
const EXIT_INVALID = 1
const EXIT_USAGE = 2

const HERE = dirname(fileURLToPath(import.meta.url))
const KIT_ROOT = resolve(HERE, '..')
const TEMPLATE_DIR = join(KIT_ROOT, 'template')
const TYPE_SOURCE = join(KIT_ROOT, 'examples', 'hello-aurora', 'types', 'aurora-plugin.d.ts')

const ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])?)+$/
const RESERVED_SEGMENTS = ['aurora', 'builtin', 'plugin', 'mcp', 'skill', 'system', 'core']
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9a-zA-Z.-]+)?$/

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(EXIT_INVALID)
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
}

function defaultId(targetDir) {
  const slug = slugify(basename(targetDir)) || 'myplugin'
  return `com.example.${slug}`
}

function validateId(id) {
  if (!ID_PATTERN.test(id)) {
    return 'id 必须是反向域名（小写字母 / 数字 / 连字符，至少两段，如 com.example.todo）'
  }
  const reserved = id.split('.').find((segment) => RESERVED_SEGMENTS.includes(segment))
  if (reserved !== undefined) return `id 不能包含保留段「${reserved}」`
  return null
}

async function main() {
  // 位置参数 = 第一个既不是选项、也不是选项值的参数。
  const args = process.argv.slice(2)
  let target
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--id' || arg === '--name' || arg === '--version') {
      index += 1
      continue
    }
    if (arg.startsWith('--')) continue
    target = arg
    break
  }

  if (target === undefined) {
    console.error(
      '用法：node tools/create-plugin.mjs <插件目录> [--id com.example.foo] [--name "显示名"] [--version 0.1.0]',
    )
    process.exit(EXIT_USAGE)
  }

  const root = resolve(process.cwd(), target)
  const id = argValue('--id') ?? defaultId(root)
  const idProblem = validateId(id)
  if (idProblem !== null) fail(idProblem)
  const name = argValue('--name') ?? basename(root)
  const version = argValue('--version') ?? '0.1.0'
  if (!SEMVER_PATTERN.test(version)) fail('--version 必须是 x.y.z')

  const exists = await fs
    .stat(root)
    .then(() => true)
    .catch(() => false)
  if (exists) {
    const entries = await fs.readdir(root)
    if (entries.length > 0) fail(`目标目录已存在且非空：${root}`)
    await fs.rmdir(root)
  }

  await fs.cp(TEMPLATE_DIR, root, { recursive: true })

  const manifestPath = join(root, 'manifest.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  manifest.id = id
  manifest.name = name
  manifest.version = version
  if (typeof manifest.description === 'string') {
    manifest.description = `Aurora 插件：${name}（由工具包模板创建，按需修改）。`
  }
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const readmePath = join(root, 'README.md')
  const readme = await fs.readFile(readmePath, 'utf8')
  await fs.writeFile(readmePath, readme.replace(/^# .*$/m, `# ${name}`), 'utf8')

  const typesDir = join(root, 'types')
  await fs.mkdir(typesDir, { recursive: true })
  await fs.copyFile(TYPE_SOURCE, join(typesDir, 'aurora-plugin.d.ts'))

  console.log(`✓ 已创建插件：${root}`)
  console.log(`  id：${id}`)
  console.log(`  名称：${name}  v${version}`)

  const check = spawnSync(process.execPath, [join(HERE, 'check-plugin.mjs'), root], {
    stdio: 'inherit',
  })
  if (check.status !== 0) {
    console.error('\n模板已生成，但校验未通过；按上面的错误修改后再跑一次校验。')
    process.exit(EXIT_INVALID)
  }

  console.log(`
下一步：
  1. 编辑 manifest.json 与 main.js，加入你的工具 / 面板 / 小组件；
  2. node tools/check-plugin.mjs ${target}
  3. node tools/pack-plugin.mjs ${target}    # 生成可安装 / 上传市场的 zip
`)
  process.exit(EXIT_OK)
}

main().catch((cause) => {
  console.error(`✗ 创建失败：${String(cause)}`)
  process.exit(EXIT_INVALID)
})
