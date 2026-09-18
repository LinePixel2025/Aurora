#!/usr/bin/env node
/**
 * 发布流程（docs/09 §2）。
 *
 * 默认做"能离线完成的那一半"：构建 → 打包 → 校验产物 → 打 tag，并打印
 * 上传命令。真正把产物送到 GitHub Releases 由显式参数触发，避免误发布。
 *
 * 用法：
 *   node scripts/release.mjs                 # 构建 + 打包 + 校验 + 打 tag（不上传）
 *   node scripts/release.mjs --publish       # 额外用 gh 上传产物到 releases 仓库
 *   node scripts/release.mjs --publish --push # 再把 tag 推到 origin
 *   node scripts/release.mjs --skip-package  # 只校验已有产物 + 打 tag
 *
 * 环境变量：
 *   GH_TOKEN  —— `--publish` 时 gh CLI 需要（repo 权限即可）
 */
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const releaseDir = join(root, 'apps', 'desktop', 'release')

/** 更新产物托管仓库（公开，仅存放安装包与更新元数据） */
const RELEASES_REPO = 'LinePixel2025/Aurora-releases'

const args = new Set(process.argv.slice(2))
const shouldPublish = args.has('--publish')
const shouldPush = args.has('--push')
const skipPackage = args.has('--skip-package')

const packageJson = JSON.parse(await fs.readFile(join(root, 'package.json'), 'utf8'))
const version = packageJson.version
const tag = `v${version}`

/**
 * Windows 下 `shell: true` 时 Node 只是用空格把参数拼起来、不做转义，
 * 含空格的参数（如 tag 消息 `-m "Aurora v0.5.0"`）会被拆成两个参数，
 * 表现为 `git tag` 报 `Failed to resolve 'v0.5.0' as a valid ref`。
 * 因此这里显式加引号。
 */
function shellQuote(arg) {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg
}

function shellArgs(commandArgs) {
  return process.platform === 'win32' ? commandArgs.map(shellQuote) : commandArgs
}

function run(command, commandArgs, options = {}) {
  const args = shellArgs(commandArgs)
  console.log(`\n$ ${command} ${args.join(' ')}`)
  execFileSync(command, args, {
    cwd: options.cwd ?? root,
    stdio: 'inherit',
    env: { ...process.env, ...(options.env ?? {}) },
    shell: process.platform === 'win32',
  })
}

function capture(command, commandArgs) {
  return execFileSync(command, shellArgs(commandArgs), {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  }).trim()
}

async function exists(path) {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

// ── 1. 预检 ──
const status = capture('git', ['status', '--porcelain'])
const dirty = status !== ''
if (dirty && !args.has('--force')) {
  console.error(
    '工作区不干净：发布包应来自确定的提交。\n请先提交，或显式加 --force（把当前未提交改动打进包里）。\n\n' +
      status.split('\n').slice(0, 10).join('\n'),
  )
  process.exit(2)
}

// ── 2. 构建 + 打包 ──
if (!skipPackage) {
  run('pnpm', ['build'])
  // 内网/代理环境要点：electron-builder 下载打包工具链与 Electron 发行包时，
  // Node 默认不信任系统证书存储里的代理根证书，会报 unable to verify the first certificate。
  // `--use-system-ca` 让 Node 读取系统证书（本机实测可行），CI 上无副作用。
  run('pnpm', ['--filter', '@aurora/desktop', 'package'], {
    env: { NODE_OPTIONS: '--use-system-ca' },
  })
}

// ── 3. 校验产物（离线可跑） ──
run('node', ['scripts/verify-update.mjs'])

if (!(await exists(join(releaseDir, `Aurora-Setup-${version}.exe`)))) {
  console.error(`产物缺失：Aurora-Setup-${version}.exe`)
  process.exit(2)
}

// ── 4. 打 tag ──
const existingTag = capture('git', ['tag', '--list', tag])
if (existingTag === tag) {
  console.log(`\ntag ${tag} 已存在，跳过创建`)
} else {
  run('git', ['tag', '-a', tag, '-m', `Aurora ${tag}`])
}

// ── 5. 上传（显式触发） ──
const artifacts = [
  `Aurora-Setup-${version}.exe`,
  `Aurora-Setup-${version}.exe.blockmap`,
  'latest.yml',
]

if (shouldPublish) {
  const hasGh = (() => {
    try {
      capture('gh', ['--version'])
      return true
    } catch {
      return false
    }
  })()
  if (!hasGh) {
    console.error('未找到 gh CLI；请安装后重试，或按下面的命令手工上传。')
    process.exit(2)
  }

  // 先确保 release 存在（已存在则忽略错误）
  try {
    run('gh', ['release', 'view', tag, '--repo', RELEASES_REPO])
    console.log(`release ${tag} 已存在，将上传/覆盖产物`)
  } catch {
    run('gh', [
      'release',
      'create',
      tag,
      '--repo',
      RELEASES_REPO,
      '--title',
      `Aurora ${tag}`,
      '--notes',
      `Aurora ${tag}（Windows x64 安装包，未签名）`,
    ])
  }

  run('gh', ['release', 'upload', tag, '--repo', RELEASES_REPO, '--clobber', ...artifacts], {
    cwd: releaseDir,
  })

  if (shouldPush) {
    run('git', ['push', 'origin', 'HEAD'])
    run('git', ['push', 'origin', tag])
  }
} else {
  console.log(`
──────────────────────────────────────────────────────────────
产物已就绪（未上传）：
  apps/desktop/release/${artifacts.join('\n  apps/desktop/release/')}

上传到公开更新源仓库 ${RELEASES_REPO}：
  gh release create ${tag} --repo ${RELEASES_REPO} --title "Aurora ${tag}" \\
    apps/desktop/release/Aurora-Setup-${version}.exe \\
    apps/desktop/release/Aurora-Setup-${version}.exe.blockmap \\
    apps/desktop/release/latest.yml

或直接：node scripts/release.mjs --publish --push
──────────────────────────────────────────────────────────────`)
}

console.log(`\n发布流程完成（tag ${tag}${shouldPublish ? '，已上传' : '，未上传'}）`)
