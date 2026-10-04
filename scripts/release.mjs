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
 *   --notes-file docs/release-notes/v<版本>.md # 必传：完整版本差异与 Release Notes
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

/**
 * 详细 Release Notes（硬规则：每个版本必须在 docs/release-notes/ 存档一份，
 * 内容必须相对上一版本 tag 汇总全部更新点；同一份正文同时用于 annotated tag
 * 与 GitHub Release，不能用单行默认文案）。
 * 用法：node scripts/release.mjs --publish --push --notes-file docs/release-notes/v0.0.4.md
 */
const notesFileFlag = process.argv.indexOf('--notes-file')
let notesFile = notesFileFlag === -1 ? undefined : process.argv[notesFileFlag + 1]
if (notesFile !== undefined) {
  notesFile = resolve(root, notesFile)
  if (!(await exists(notesFile))) {
    console.error(`--notes-file 指定的文件不存在：${notesFile}`)
    process.exit(2)
  }
}

const packageJson = JSON.parse(await fs.readFile(join(root, 'package.json'), 'utf8'))
const version = packageJson.version
const tag = `v${version}`

const previousTag = capture('git', ['tag', '--merged', 'HEAD', '--sort=-version:refname'])
  .split('\n')
  .map((item) => item.trim())
  .find((item) => /^v\d+\.\d+\.\d+$/.test(item) && item !== tag)

if (notesFile === undefined) {
  console.error(
    '缺少 --notes-file：每次打包安装包都必须提供相对上一版本的完整 Release Notes。\n' +
      '例如：node scripts/release.mjs --publish --push --notes-file docs/release-notes/vX.Y.Z.md',
  )
  process.exit(2)
}

const notesText = await fs.readFile(notesFile, 'utf8')
if (previousTag !== undefined && !notesText.includes(previousTag)) {
  console.error(
    `Release Notes 未包含上一版本 tag ${previousTag}：请先相对该版本汇总全部更新点，` +
      '再打包和创建 tag。',
  )
  process.exit(2)
}

if (previousTag !== undefined) {
  console.log(`\n上一版本 tag：${previousTag}`)
  console.log('\n相对上一版本的提交：')
  console.log(capture('git', ['log', '--reverse', '--pretty=format:%h %s', `${previousTag}..HEAD`]))
  console.log('\n相对上一版本的改动统计：')
  console.log(capture('git', ['diff', '--stat', `${previousTag}..HEAD`]))
}

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
  run('git', ['tag', '-a', tag, '-F', notesFile, '--cleanup=verbatim'])
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
    // 已存在的 release 也要把正文刷成详细 notes（如上次上传时还没写好说明）
    if (notesFile !== undefined) {
      run('gh', ['release', 'edit', tag, '--repo', RELEASES_REPO, '--notes-file', notesFile])
    }
  } catch {
    run('gh', [
      'release',
      'create',
      tag,
      '--repo',
      RELEASES_REPO,
      '--title',
      `Aurora ${tag}`,
      '--notes-file',
      notesFile,
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

或直接：node scripts/release.mjs --publish --push --notes-file docs/release-notes/v<版本>.md
──────────────────────────────────────────────────────────────`)
}

console.log(`\n发布流程完成（tag ${tag}${shouldPublish ? '，已上传' : '，未上传'}）`)
