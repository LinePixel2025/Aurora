#!/usr/bin/env node
/**
 * 把 release 产物上传到**公开的 releases 仓库**（docs/09 §2）。
 *
 * 为什么不用 `gh` CLI：本机可能没装；且 CI 里也要一条统一的路径。
 * 这里直接用 GitHub REST API，token 来源依次为：
 *   GH_TOKEN → GITHUB_TOKEN → `git credential fill`（本机凭据管理器）
 *
 * 用法：
 *   node scripts/upload-release.mjs                 # 用当前 package.json 版本
 *   node scripts/upload-release.mjs --tag v0.3.0    # 指定 tag
 *   node scripts/upload-release.mjs --dry-run       # 只打印将要做什么
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 内网/代理环境的 TLS 拦截：Node 默认不信任系统证书存储里的代理根证书，
 * 访问 api.github.com 会报 UNABLE_TO_VERIFY_LEAF_SIGNATURE。
 * Node 24 支持 `--use-system-ca`，因此这里自动补上并重启自身，
 * 免得用户为了上传产物还要知道这个细节。
 */
function ensureSystemCa() {
  if (process.env.AURORA_SYSTEM_CA_APPLIED === '1') return
  const nodeOptions = process.env.NODE_OPTIONS ?? ''
  if (nodeOptions.includes('--use-system-ca')) return

  const result = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_OPTIONS: `${nodeOptions} --use-system-ca`.trim(),
      AURORA_SYSTEM_CA_APPLIED: '1',
    },
  })
  process.exit(result.status ?? 1)
}

ensureSystemCa()

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const releaseDir = join(root, 'apps', 'desktop', 'release')

const args = process.argv.slice(2)
const tagArgIndex = args.indexOf('--tag')
const dryRun = args.includes('--dry-run')

const OWNER = 'LinePixel2025'
const REPO = 'Aurora-releases'

const packageJson = JSON.parse(await fs.readFile(join(root, 'package.json'), 'utf8'))
const version = packageJson.version
const tag = tagArgIndex >= 0 ? args[tagArgIndex + 1] : `v${version}`

if (tag === undefined || tag === '') {
  console.error('缺少 tag：请用 --tag vX.Y.Z 指定')
  process.exit(2)
}

const files = [`Aurora-Setup-${version}.exe`, `Aurora-Setup-${version}.exe.blockmap`, 'latest.yml']

for (const name of files) {
  const path = join(releaseDir, name)
  try {
    await fs.access(path)
  } catch {
    console.error(`缺少产物：${path}\n请先运行 pnpm package`)
    process.exit(2)
  }
}

/** 依次尝试环境变量与 git 凭据管理器 */
function resolveToken() {
  const fromEnv = (process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '').trim()
  if (fromEnv !== '') return { token: fromEnv, source: '环境变量' }

  try {
    const output = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const match = /^password=(.+)$/m.exec(output)
    const token = match?.[1]?.trim() ?? ''
    if (token !== '') return { token, source: 'git 凭据管理器' }
  } catch {
    /* 没有可用凭据 */
  }
  return { token: '', source: '' }
}

const { token, source } = resolveToken()
if (token === '') {
  console.error(
    [
      '无法获取 GitHub token。请任选一种方式：',
      '  1) 设置环境变量后重试：  $env:GH_TOKEN="ghp_xxx"; node scripts/upload-release.mjs',
      '  2) 安装 gh 并登录：      gh auth login，然后 node scripts/release.mjs --publish',
      '  3) 手工在网页上传产物到 Release：',
      `     https://github.com/${OWNER}/${REPO}/releases/new?tag=${tag}`,
      `     需要上传：${files.join('、')}`,
    ].join('\n'),
  )
  process.exit(2)
}

const api = `https://api.github.com/repos/${OWNER}/${REPO}`
const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'aurora-release-script',
}

async function apiCall(path, options = {}) {
  const response = await fetch(`${api}${path}`, { headers, ...options })
  const text = await response.text()
  let body
  try {
    body = text === '' ? null : JSON.parse(text)
  } catch {
    body = text
  }
  return { ok: response.ok, status: response.status, body }
}

console.log(`目标：${OWNER}/${REPO}  tag=${tag}  token 来源：${source}`)

// ── 1. 确保 release 存在 ──
let release = await apiCall(`/releases/tags/${tag}`)
if (release.ok) {
  console.log(`release ${tag} 已存在（id=${release.body?.id}）`)
} else if (release.status === 404) {
  if (dryRun) {
    console.log(`[dry-run] 将创建 release ${tag}`)
  } else {
    const created = await apiCall('/releases', {
      method: 'POST',
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: 'main',
        name: `Aurora ${tag}`,
        body: `Aurora ${tag}（Windows x64 安装包，未签名）。\n\n首次运行若出现 SmartScreen「未知发行者」提示：点「更多信息」→「仍要运行」。`,
        draft: false,
        prerelease: false,
      }),
    })
    if (!created.ok) {
      console.error(`创建 release 失败：HTTP ${created.status} ${JSON.stringify(created.body)}`)
      process.exit(1)
    }
    release = created
    console.log(`已创建 release ${tag}（id=${created.body?.id}）`)
  }
} else {
  console.error(`查询 release 失败：HTTP ${release.status} ${JSON.stringify(release.body)}`)
  process.exit(1)
}

// ── 2. 上传（已存在的同名资产先删除再传，保证 latest.yml 与 exe 同步） ──
const existing = Array.isArray(release.body?.assets) ? release.body.assets : []
for (const name of files) {
  const path = join(releaseDir, name)
  const data = await fs.readFile(path)
  const previous = existing.find((asset) => asset.name === name)

  if (previous !== undefined) {
    if (dryRun) {
      console.log(`[dry-run] 将覆盖 ${name}`)
      continue
    }
    const deleted = await apiCall(`/releases/assets/${previous.id}`, { method: 'DELETE' })
    if (!deleted.ok) {
      console.error(`删除旧资产失败 ${name}：HTTP ${deleted.status}`)
      process.exit(1)
    }
  }

  if (dryRun) {
    console.log(`[dry-run] 将上传 ${name}（${(data.length / 1024 / 1024).toFixed(1)} MB）`)
    continue
  }

  const uploadUrl = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${release.body.id}/assets?name=${encodeURIComponent(name)}`
  const uploaded = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/octet-stream',
      'content-length': String(data.length),
    },
    body: data,
  })
  if (!uploaded.ok) {
    console.error(`上传失败 ${name}：HTTP ${uploaded.status} ${await uploaded.text()}`)
    process.exit(1)
  }
  console.log(`已上传 ${name}`)
}

console.log(
  dryRun
    ? '\n[dry-run] 未做任何修改'
    : `\n完成：https://github.com/${OWNER}/${REPO}/releases/tag/${tag}`,
)
