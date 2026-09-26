/**
 * 真实的 PowerShell 命令执行器（docs/06 §11、step 3）。
 *
 * 契约：**不得 import electron** —— 本文件要能被 vitest 在纯 Node 环境里加载并真跑进程。
 *
 * 踩过的坑（逐条对应下面的实现）：
 * 1. **不走 shell**：命令作为 `-Command` 的**单个 argv 元素**交给 `spawn`，不传 `shell: true`，
 *    否则 cmd.exe 会二次解析引号与 `%VAR%`（AGENTS.md「绝不经过 shell」）。
 * 2. **中文编码**：Windows PowerShell 5.1 默认按控制台代码页（中文系统为 GBK）输出，
 *    不显式设 `[Console]::OutputEncoding` / `$OutputEncoding`，中文必然乱码。
 * 3. **超时要杀进程树**：Node 的 `child.kill()` 在 Windows 上杀不掉孙进程
 *    （`pnpm` / `npm` 这类会派生），残留的孤儿进程继续占端口、改磁盘，
 *    因此走 `taskkill /PID <pid> /T /F`。
 * 4. **`close` 可能永不到来**：孙进程若继承了 stdout 管道，父进程被杀后 `close` 仍不触发，
 *    所以杀了之后给一个宽限计时器强制收尾。
 * 5. **输出要有上限**：命令可以无限刷屏，必须按字节截断，否则撑爆上下文。
 * 6. **cwd 也要过项目根边界**（docs/06 §11.1）：判定与 `file-port.ts` 共用 `resolveWithin`
 *    （realpath 前缀校验，不复制第二份）；越界且未显式放行时**不启动进程**。
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { createNoopLogger } from '@aurora/shared'
import type { CommandRequest, CommandResult } from '@aurora/agent-core'
import {
  isPathOutsideError,
  resolveWithin,
  type OutsideOption,
  type WorkspaceGuardOptions,
} from './file-port.js'

export interface CommandRunnerOptions extends WorkspaceGuardOptions {
  defaultCwd: string
  /** stdout+stderr 各自收集上限（字节），默认 1 MiB */
  maxOutputBytes?: number
  /** 终止进程树时的等待宽限，默认 500ms */
  killGraceMs?: number
}

/**
 * 带边界放行位的执行请求：`allowOutside: true` = 用户已明确放行 cwd 越界
 * （由工具层在确认之后传入）。缺省 / `false` = 按项目根校验。
 */
export type CommandRunRequest = CommandRequest & OutsideOption

/**
 * `createCommandRunner` 的返回类型：比内核的 `CommandRunner` 多认一个可选放行位。
 * 因为多出来的字段是**可选**的，它仍可直接赋给 `TerminalToolOptions.run`（参数更宽 = 可赋值）。
 */
export type GuardedCommandRunner = (request: CommandRunRequest) => Promise<CommandResult>

export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
export const DEFAULT_KILL_GRACE_MS = 500
/** 调用方没给 timeoutMs 时的兜底（正常路径由内核按配置钳制后传入） */
export const DEFAULT_TIMEOUT_MS = 60_000

/**
 * 编码前缀：`$ProgressPreference` 关掉进度条（它会污染 stdout），
 * 后两行把控制台输出编码与管道编码都设成 UTF-8。
 */
const ENCODING_PREFIX =
  "$ProgressPreference='SilentlyContinue'; " +
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
  '$OutputEncoding=[System.Text.Encoding]::UTF8; '

/** PowerShell 的固定参数：不加载用户 profile、非交互、放行未签名脚本 */
const POWERSHELL_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
] as const

export function createCommandRunner(options: CommandRunnerOptions): GuardedCommandRunner {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  // 边界来源与 file-port **同一套 live getter**（每次执行即时读，配置改了立刻生效）
  const guard: WorkspaceGuardOptions = {
    workspaceRoot: options.workspaceRoot,
    enforceWorkspace: options.enforceWorkspace,
    logger: options.logger ?? createNoopLogger(),
  }

  return async (request: CommandRunRequest): Promise<CommandResult> => {
    // cwd 边界校验（判定与 file-port 共用 `resolveWithin`，不另写一份）。
    // 承重事实（2026-09 纠偏注释）：工具层（`terminal.ts`）将缺省 cwd 解析成**绝对路径**后
    // 恒传 `request.cwd`，所以这里几乎总是"显式给了 cwd"——缺省值本身即装配层按
    // §5.1 三级回落算出的生效工作目录（配了项目 = 项目根，天然在根内）；
    // 只有绕过工具层直调 runner 时才可能不带 cwd，那正是下面的 `defaultCwd` 兜底路径。
    // ⚠️ 校验发生在下面的 `existsSync` 回落**之前**：不存在的越界路径同样拒绝
    //（否则"探一个不存在的根外路径"会变成探测文件系统存在性的信道）。
    if (request.cwd !== undefined && request.cwd !== '') {
      try {
        await resolveWithin(request.cwd, request.allowOutside === true, guard)
      } catch (error) {
        // 只有"路径越界"才在这里收口；其它异常（读取配置本身出错之类）原样抛给内核，
        // 由它渲染成「命令执行失败：…」——**都不会启动进程**（fail-closed）。
        if (!isPathOutsideError(error)) throw error
        guard.logger?.warn('run_command 的 cwd 在项目根之外，已拒绝执行', {
          command: request.command,
          cwd: request.cwd,
        })
        // 越界：进程**根本不启动**（命令的副作用一点都不该发生），按既有结果形状返回失败：
        // 非零 / null 退出码让内核置 `isError`，中文原因走 `stderr`（内核会把 stderr 渲染出来）。
        return {
          command: request.command,
          // 没有进程，也就没有退出码（`null` 的既有语义正是"没有正常退出码"）
          exitCode: null,
          stdout: '',
          stderr: `cwd 在项目根之外，本次命令未执行：${error.message}`,
          timedOut: false,
          aborted: false,
          durationMs: 0,
          cwd: request.cwd,
        }
      }
    }

    return new Promise<CommandResult>((resolve, reject) => {
      // 工作目录兜底：默认目录可能已被用户删掉，此时 spawn 会抛 ENOENT，
      // 宁可回落到装配层给的默认目录，也不要让工具直接报错。
      const cwd =
        request.cwd !== undefined && request.cwd !== '' && existsSync(request.cwd)
          ? request.cwd
          : options.defaultCwd
      const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS

      const started = performance.now()
      const script = ENCODING_PREFIX + request.command
      const child = spawn('powershell.exe', [...POWERSHELL_ARGS, script], {
        cwd,
        windowsHide: true,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const stdout = new OutputCollector(maxOutputBytes)
      const stderr = new OutputCollector(maxOutputBytes)
      let settled = false
      let timedOut = false
      let aborted = false
      // 计时器放进可变持有对象：`cleanup()` 要能清掉它们，而它们只能在事件回调挂上之后创建
      // （直接 `let` 会被 lint 的 prefer-const 判定为"只赋值一次"）。
      const timers: { kill?: NodeJS.Timeout; grace?: NodeJS.Timeout } = {}

      const cleanup = (): void => {
        if (timers.kill !== undefined) clearTimeout(timers.kill)
        if (timers.grace !== undefined) clearTimeout(timers.grace)
        request.signal?.removeEventListener('abort', onAbort)
      }

      const finish = (exitCode: number | null): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve({
          command: request.command,
          exitCode,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          timedOut,
          aborted,
          durationMs: performance.now() - started,
          cwd,
        })
      }

      const kill = async (reason: 'timeout' | 'abort'): Promise<void> => {
        if (settled) return
        if (reason === 'timeout') timedOut = true
        else aborted = true
        if (timers.kill !== undefined) clearTimeout(timers.kill)
        // 先 taskkill 整棵树（含孙进程）；失败时下面再补一刀 child.kill()。
        await terminateProcessTree(child.pid)
        // 无条件补一刀：taskkill 已经杀干净时它是 no-op（Node 对已退出的子进程不再发信号），
        // taskkill 失败（进程刚退出 / PID 失效）时它正好兜底。
        child.kill()
        // 宽限 killGraceMs 等 `close` 事件；到点仍未 close 就强制收尾（退出码按 null）。
        if (!settled) timers.grace = setTimeout(() => finish(null), killGraceMs)
      }

      const onAbort = (): void => {
        void kill('abort')
      }

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))

      child.on('error', (error: Error) => {
        // spawn 本身失败（例如系统里没有 powershell.exe）：抛给内核，
        // 由它回填「命令执行失败：…」，比返回一个空结果更容易定位。
        if (settled) return
        settled = true
        cleanup()
        reject(new Error(`无法启动 PowerShell：${error.message}`))
      })

      // 退出码取 `close`（不是 `exit`）：`close` 保证 stdout/stderr 已全部收完
      child.on('close', (code: number | null) => finish(code))

      timers.kill = setTimeout(() => {
        void kill('timeout')
      }, timeoutMs)

      if (request.signal !== undefined) {
        if (request.signal.aborted) {
          // 已经中止：同样走杀进程树这条路，保证「取消 → 进程真的没了」语义一致
          void kill('abort')
        } else {
          request.signal.addEventListener('abort', onAbort, { once: true })
        }
      }
    })
  }
}

/**
 * 按 PID 终止整棵进程树。
 *
 * `taskkill /T` 递归杀子进程、`/F` 强制；用 `execFile`（argv 数组）而非 shell，
 * 与 AGENTS.md「绝不经过 shell」一致。PID 不存在或进程已退出时 taskkill 会报错，
 * 这里吞掉错误，由调用方用 `child.kill()` 兜底。
 */
export function terminateProcessTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return Promise.resolve()
  return new Promise<void>((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {
      resolve()
    })
  })
}

/**
 * stdout / stderr 的定长收集器：超过上限的片段**直接丢弃**并置截断标记，
 * 避免一条 `Get-ChildItem -Recurse` 就把模型上下文撑爆。
 */
class OutputCollector {
  private readonly chunks: Buffer[] = []
  private bytes = 0
  private truncated = false

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    if (this.bytes >= this.limit) {
      this.truncated = true
      return
    }
    const remaining = this.limit - this.bytes
    if (chunk.length > remaining) {
      // 只留到上限（可能把一个多字节字符切成两半，下面的解码会给出替换字符而不是抛错）
      this.chunks.push(chunk.subarray(0, remaining))
      this.bytes = this.limit
      this.truncated = true
      return
    }
    this.chunks.push(chunk)
    this.bytes += chunk.length
  }

  toString(): string {
    // 统一按 UTF-8 解码（前缀已把 PowerShell 的输出编码设成 UTF-8）；
    // 残缺字节由 Node 解码成 U+FFFD，不抛错——命令输出不该因为半个字符就让整次调用失败。
    const text = Buffer.concat(this.chunks).toString('utf8')
    if (!this.truncated) return text
    return `${text}\n…（输出超过 ${describeBytes(this.limit)} 已截断）…\n`
  }
}

function describeBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KiB`
  return `${bytes} 字节`
}
