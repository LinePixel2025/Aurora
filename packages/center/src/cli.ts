/**
 * `aurora-center` CLI（docs/12 §9）：
 *
 *   init    建数据目录 + 首个管理员
 *   start   启动服务器（未 init 时自动 init，管理员密码随机生成、打印一次）
 *   users   add / list / passwd / remove
 *   status  数据目录概览
 *   update  [--check] 检查或执行更新（npm 通道）
 *   version 版本号
 *
 * 参数解析手写（无依赖）；密码可经 `--admin-password` / `--password` 传入，
 * 未传时用 readline 提示输入（start 自动引导除外——那里始终随机生成）。
 * 手动创建配对令牌的 `token` 子命令已移除：客户端接入统一走账号登录 /
 * 设备授权登录（v0.2.1 起，docs/12 §3 / §4.3）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import type { Logger } from '@aurora/shared'
import { AuthStore } from './auth.js'
import { ClientRegistry } from './clients.js'
import { createCenterServer } from './server.js'
import { serverVersion } from './version.js'
import { checkUpdate } from './update.js'

export interface CliOptions {
  argv: string[]
  stdout?: (line: string) => void
  stderr?: (line: string) => void
}

export const DEFAULT_DATA_DIR = join(homedir(), '.aurora-center')
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

const USAGE = `aurora-center —— Aurora Center 控制中心（docs/12）

用法：
  aurora-center init    [--data <dir>] [--admin-user <名>] [--admin-password <密码>]
  aurora-center start   [--port <N>] [--host <0.0.0.0>] [--data <dir>]
  aurora-center users   add <名> [--admin] [--password <密码>]
  aurora-center users   list
  aurora-center users   passwd <名> --password <密码>
  aurora-center users   remove <名>
  aurora-center status  [--data <dir>]
  aurora-center update  [--check] [--registry <npm 源>]
  aurora-center version
`

export async function runCli(options: CliOptions): Promise<number> {
  const out = options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`))
  const err = options.stderr ?? ((line: string) => process.stderr.write(`${line}\n`))
  const argv = options.argv
  const command = argv[0]

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      out(USAGE)
      return 0
    case 'version':
    case '--version':
      out(serverVersion())
      return 0
    case 'init':
      return runInit(argv.slice(1), out, err)
    case 'start':
      return runStart(argv.slice(1), out, err)
    case 'users':
      return runUsers(argv.slice(1), out, err)
    case 'status':
      return runStatus(argv.slice(1), out, err)
    case 'update':
      return runUpdate(argv.slice(1), out, err)
    default:
      err(`未知命令：${String(command)}\n`)
      out(USAGE)
      return 2
  }
}

// ─────────────── 参数工具 ───────────────

function flagOf(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index >= 0 ? (argv[index + 1] as string | undefined) : undefined
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name)
}

function positional(argv: string[], index: number): string | undefined {
  return argv[index]
}

function dataDirOf(argv: string[]): string {
  return flagOf(argv, '--data') ?? process.env['AURORA_CENTER_DATA'] ?? DEFAULT_DATA_DIR
}

function resolveUser(auth: AuthStore, name: string): string | undefined {
  return auth.getUser(name, 'username')?.id
}

// ─────────────── 命令 ───────────────

async function openAuth(dataDir: string, logger?: Logger): Promise<AuthStore> {
  const auth = new AuthStore({ dataDir, logger })
  await auth.init()
  return auth
}

async function runInit(
  argv: string[],
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const dataDir = dataDirOf(argv)
  const auth = await openAuth(dataDir)
  const username = flagOf(argv, '--admin-user') ?? 'admin'
  const password = flagOf(argv, '--admin-password')
  const result = await auth.ensureAdmin(username, password)
  if (result.created) {
    out(`已创建数据目录与首个管理员：${username}`)
    if (password === undefined)
      out(`初始密码（只显示这一次，请立即修改）：${result.password ?? ''}`)
    return 0
  }
  err(`管理员已存在，跳过（数据目录：${dataDir}）`)
  return 0
}

async function runStart(
  argv: string[],
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const dataDir = dataDirOf(argv)
  const port = Number.parseInt(flagOf(argv, '--port') ?? '8787', 10)
  const host = flagOf(argv, '--host') ?? '0.0.0.0'
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    err(`非法端口：${String(port)}`)
    return 2
  }
  const auth = await openAuth(dataDir)
  const bootstrap = await auth.ensureAdmin('admin')
  if (bootstrap.created) {
    out('首次启动：已自动创建管理员 admin')
    out(`初始密码（只显示这一次，请立即登录修改）：${bootstrap.password ?? ''}`)
  }
  // Web UI 构建产物与 dist 同级；不存在时服务器仅提供 API（界面未构建的提示）
  const webDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist-web')
  // 服务器日志直落 stdout/stderr（docker logs 可观测）：此前未传 logger，全局异常
  // 兜底（500 E_INTERNAL）完全不可见——真实事故排查时只能靠猜（2026-09-27）。
  const server = createCenterServer({
    dataDir,
    webDir: existsSync(webDir) ? webDir : undefined,
    logger: createCliLogger(),
  })
  const { port: actualPort } = await server.listen(port, host)
  out(`Aurora Center 已启动：http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`)
  out(`数据目录：${dataDir}`)
  out('Ctrl+C 停止')
  // start 必须常驻：runCli 返回后 bin 会 process.exit，因此这里挂到收到信号为止
  await new Promise<void>((resolveShutdown) => {
    let closing = false
    const shutdown = (): void => {
      if (closing) return
      closing = true
      void server.close().then(() => resolveShutdown())
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
  return 0
}

async function runUsers(
  argv: string[],
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const action = positional(argv, 0)
  const rest = argv.slice(1)
  const auth = await openAuth(dataDirOf(rest))
  switch (action) {
    case 'add': {
      const username = positional(rest, 0)
      if (username === undefined) {
        err('用法：aurora-center users add <名> [--admin] [--password <密码>]')
        return 2
      }
      const password = flagOf(rest, '--password') ?? (await promptPassword())
      const created = await auth.createUser({
        username,
        password,
        role: hasFlag(rest, '--admin') ? 'admin' : 'user',
      })
      out(`已创建用户 ${created.username}（${created.role}，id=${created.id}）`)
      return 0
    }
    case 'list': {
      for (const user of auth.listUsers()) {
        out(`${user.id}\t${user.username}\t${user.role}\t${user.createdAt}`)
      }
      return 0
    }
    case 'passwd': {
      const username = positional(rest, 0)
      const userId = username === undefined ? undefined : resolveUser(auth, username)
      if (userId === undefined) {
        err(`用户不存在：${String(username)}`)
        return 1
      }
      const password = flagOf(rest, '--password') ?? (await promptPassword())
      await auth.resetPassword(userId, password)
      out(`已更新 ${username} 的密码`)
      return 0
    }
    case 'remove': {
      const username = positional(rest, 0)
      const user = username === undefined ? undefined : auth.getUser(username, 'username')
      if (user === undefined) {
        err(`用户不存在：${String(username)}`)
        return 1
      }
      const actor = auth.listUsers().find((entry) => entry.role === 'admin')
      if (actor === undefined) {
        err('数据目录里没有管理员，无法执行删除')
        return 1
      }
      await auth.deleteUser(user.id, actor)
      out(`已删除用户 ${user.username}（其名下客户端登记一并移除）`)
      return 0
    }
    default:
      err('用法：aurora-center users <add|list|passwd|remove> ...')
      return 2
  }
}

async function runStatus(
  argv: string[],
  out: (s: string) => void,
  _err: (s: string) => void,
): Promise<number> {
  const dataDir = dataDirOf(argv)
  const auth = await openAuth(dataDir)
  const clients = new ClientRegistry({ dataDir })
  await clients.init()
  out(`Aurora Center v${serverVersion()}`)
  out(`数据目录：${dataDir}`)
  out(`用户数：${auth.listUsers().length}`)
  out(`客户端登记数：${clients.list().length}`)
  return 0
}

async function runUpdate(
  argv: string[],
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const registry = flagOf(argv, '--registry') ?? DEFAULT_REGISTRY
  const check = await checkUpdate(serverVersion(), registry)
  if (check.error !== undefined) {
    err(`检查更新失败：${check.error}`)
    return 1
  }
  if (!check.updateAvailable) {
    out(`已是最新版本（v${check.current}）`)
    return 0
  }
  out(`发现新版本：v${check.current} → v${check.latest}`)
  if (hasFlag(argv, '--check')) return 0
  out('正在执行 npm install -g @aurora/center@latest ...')
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const child = spawn(npm, ['install', '-g', '@aurora/center@latest', '--registry', registry], {
    stdio: 'inherit',
    shell: false,
  })
  return new Promise((resolveExit) => {
    child.once('exit', (code) => resolveExit(code === 0 ? 0 : 1))
    child.once('error', (error) => {
      err(`更新失败：${String(error)}`)
      resolveExit(1)
    })
  })
}

async function promptPassword(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question('请输入密码（至少 6 位）: ')
  rl.close()
  return answer
}

/** CLI 运行期的轻量日志器：info 走 stdout、warn/error 走 stderr（docker logs 都收）。 */
export function createCliLogger(): Logger {
  const line = (
    write: (text: string) => void,
    level: string,
    message: string,
    meta?: unknown,
  ): void => {
    const extra = meta === undefined ? '' : ` ${JSON.stringify(meta)}`
    write(`[${new Date().toISOString()}] [${level}] ${message}${extra}
`)
  }
  const make = (scope?: string): Logger => {
    const prefix = scope === undefined ? '' : `[${scope}] `
    return {
      debug: (message, meta) =>
        line((t) => process.stdout.write(t), 'debug', `${prefix}${message}`, meta),
      info: (message, meta) =>
        line((t) => process.stdout.write(t), 'info', `${prefix}${message}`, meta),
      warn: (message, meta) =>
        line((t) => process.stderr.write(t), 'warn', `${prefix}${message}`, meta),
      error: (message, meta) =>
        line((t) => process.stderr.write(t), 'error', `${prefix}${message}`, meta),
      child: (childScope) => make(childScope),
    }
  }
  return make()
}
