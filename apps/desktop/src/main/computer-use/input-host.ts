/**
 * Computer Use 的常驻 PowerShell 宿主客户端（docs/06 §28）。
 *
 * 三条硬约定：
 * 1. **只启动一次**：`Add-Type` / DPI / UIAutomation 程序集只付一次启动成本；
 *    之后每条命令是 NDJSON 一行，点击延迟毫秒级。不能每次动作 spawn 一个 PowerShell
 *    （单次 1s 级，且无法保证串行）。
 * 2. **串行队列**：桌面同一时刻只能有一个指针 / 焦点，命令必须按顺序执行。
 * 3. **失败关闭**：宿主崩溃 / 超时 / 握手失败时拒绝所有 pending；会话层据此停止。
 *
 * 本文件不 import electron；spawn / fs / 时钟都可注入，便于单测。
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { windowsComputerUseHostScript } from './win-host-script.js'

export type SpawnLike = (command: string, args: string[], options: SpawnOptions) => ChildProcess

export interface HostResponse {
  id: number
  ok: boolean
  data?: unknown
  code?: string
  message?: string
}

export interface HostInfo {
  powershell: string
  uia: boolean
  cursor?: { x: number; y: number }
  foreground?: unknown
}

export interface ComputerUseInputHostOptions {
  /** 脚本落盘目录（`<userData>/computer-use`） */
  dir: string
  logger: {
    info(message: string, detail?: Record<string, unknown>): void
    warn(message: string, detail?: Record<string, unknown>): void
    debug(message: string, detail?: Record<string, unknown>): void
  }
  /** 平台门控；单测可显式开启 */
  supported?: boolean
  spawnImpl?: SpawnLike
  /** PowerShell 可执行文件；缺省探测 pwsh 再回落 powershell.exe */
  powershellPath?: string
  /** 宿主脚本（注入以便单测；缺省用 win-host-script） */
  script?: () => string
  /** 单条命令默认超时 */
  timeoutMs?: number
  /** 握手超时 */
  readyTimeoutMs?: number
  now?: () => number
  /** 宿主意外退出时通知装配层（会停止当前会话） */
  onCrash?: (reason: string) => void
}

interface Pending {
  resolve: (value: HostResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_READY_TIMEOUT_MS = 20_000
const MARKER = 'AURORA_CU|'
const READY_MARKER = 'AURORA_CU_READY|'

/** 解析 PowerShell 路径：优先 `%ProgramFiles%\PowerShell\7\pwsh.exe`，回落系统 PowerShell。 */
export function defaultPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files'
  const systemRoot = env['SystemRoot'] ?? 'C:\\Windows'
  const pwsh = join(programFiles, 'PowerShell', '7', 'pwsh.exe')
  if (existsSync(pwsh)) return pwsh
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

export class ComputerUseInputHost {
  private readonly options: ComputerUseInputHostOptions
  private readonly supported: boolean
  private child: ChildProcess | undefined
  private ready = false
  private starting: Promise<HostInfo> | undefined
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private stdoutBuffer = ''
  private stderrTail = ''
  private queue: Promise<unknown> = Promise.resolve()
  private info: HostInfo | undefined
  private startError: string | undefined
  private stopping = false

  constructor(options: ComputerUseInputHostOptions) {
    this.options = options
    this.supported = options.supported ?? process.platform === 'win32'
  }

  get available(): boolean {
    return this.supported
  }

  get readyState(): boolean {
    return this.ready
  }

  get lastError(): string {
    return this.stderrTail.trim()
  }

  async ensureReady(): Promise<HostInfo> {
    if (this.ready && this.info !== undefined) return this.info
    if (this.starting !== undefined) return this.starting
    this.starting = this.start().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  /**
   * 发一条命令。队列串行；超时会杀掉宿主并拒绝整批 pending（失败关闭）。
   */
  async request<T = unknown>(
    op: string,
    payload: Record<string, unknown> = {},
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    return this.enqueue(async () => {
      const info = await this.ensureReady()
      void info
      const response = await this.send(op, payload, options)
      if (!response.ok) {
        throw new HostCommandError(response.code ?? 'HOST_COMMAND_FAILED', response.message ?? op)
      }
      return response.data as T
    })
  }

  /** 环境检查（启动宿主但不合成输入）。 */
  async diagnose(): Promise<HostInfo> {
    return this.ensureReady()
  }

  async stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    this.child = undefined
    this.ready = false
    this.info = undefined
    this.rejectAll(new Error('host stopped'))
    if (child !== undefined && !child.killed) {
      try {
        child.stdin?.write(`${JSON.stringify({ id: 0, op: 'release_all' })}\n`)
      } catch {
        // 宿主可能已退出；杀进程即可
      }
      setTimeout(() => {
        if (!child.killed) child.kill()
      }, 120)
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async start(): Promise<HostInfo> {
    if (!this.supported) throw new HostCommandError('PLATFORM_UNSUPPORTED', '仅支持 Windows')
    if (this.stopping) throw new HostCommandError('HOST_STOPPED', '宿主已停止')
    const script = this.options.script?.() ?? windowsComputerUseHostScript()
    await fs.mkdir(this.options.dir, { recursive: true })
    const scriptPath = join(this.options.dir, 'win-host.ps1')
    await fs.writeFile(scriptPath, script, 'utf8')

    const powershell = this.options.powershellPath ?? defaultPowerShellPath()
    const spawnImpl = this.options.spawnImpl ?? spawn
    const child = spawnImpl(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Sta', '-File', scriptPath],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    this.child = child
    this.stderrTail = ''
    this.stdoutBuffer = ''
    this.startError = undefined

    const stdout = child.stdout
    const stderr = child.stderr
    if (stdout === null || stderr === null) {
      child.kill()
      throw new HostCommandError('HOST_PIPE_UNAVAILABLE', '无法建立 PowerShell 管道')
    }
    stdout.setEncoding('utf8')
    stderr.setEncoding('utf8')
    stdout.on('data', (chunk: string) => this.consumeStdout(chunk))
    stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000)
    })
    child.on('error', (error) => {
      this.options.logger.warn('Computer Use 宿主启动失败', { error: String(error) })
      this.handleCrash(`宿主启动失败：${String(error)}`)
    })
    child.on('exit', (code, signal) => {
      if (this.stopping) return
      this.handleCrash(`宿主已退出（code=${String(code)} signal=${String(signal)}）`)
    })

    const info = await this.waitReady()
    this.info = info
    this.ready = true
    this.options.logger.info('Computer Use 宿主就绪', {
      powershell: info.powershell,
      uia: info.uia,
    })
    return info
  }

  private waitReady(): Promise<HostInfo> {
    const timeoutMs = this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    return new Promise<HostInfo>((resolve, reject) => {
      const started = this.options.now?.() ?? Date.now()
      const timer = setInterval(() => {
        const elapsed = (this.options.now?.() ?? Date.now()) - started
        if (this.info !== undefined) {
          clearInterval(timer)
          resolve(this.info)
        } else if (this.startError !== undefined) {
          clearInterval(timer)
          reject(new HostCommandError('HOST_START_FAILED', this.startError))
        } else if (elapsed > timeoutMs) {
          clearInterval(timer)
          const tail = this.stderrTail.trim()
          void this.stop()
          reject(
            new HostCommandError(
              'HOST_START_TIMEOUT',
              `PowerShell 宿主启动超时${tail === '' ? '' : `：${tail.slice(-300)}`}`,
            ),
          )
        }
      }, 50)
      // 启动时先主动让脚本输出 READY；stdout 监听已在 start() 里挂好
      timer.unref?.()
    })
  }

  private send(
    op: string,
    payload: Record<string, unknown>,
    options: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<HostResponse> {
    const child = this.child
    if (child === undefined || child.stdin === null) {
      return Promise.reject(new HostCommandError('HOST_NOT_RUNNING', 'PowerShell 宿主未运行'))
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(new HostCommandError('ABORTED', '操作已取消'))
    }
    const id = this.nextId++
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    return new Promise<HostResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new HostCommandError('HOST_TIMEOUT', `命令 ${op} 超时（${timeoutMs}ms）`))
        this.handleCrash(`命令 ${op} 超时`)
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      const onAbort = (): void => {
        const entry = this.pending.get(id)
        if (entry === undefined) return
        clearTimeout(entry.timer)
        this.pending.delete(id)
        entry.reject(new HostCommandError('ABORTED', '操作已取消'))
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        child.stdin?.write(`${JSON.stringify({ id, op, ...payload })}\n`)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new HostCommandError('HOST_WRITE_FAILED', String(error)))
      }
    })
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    const lines = this.stdoutBuffer.split(/\r?\n/)
    this.stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      if (trimmed.startsWith(READY_MARKER)) {
        try {
          const info = JSON.parse(trimmed.slice(READY_MARKER.length)) as HostInfo
          this.info = info
        } catch {
          this.info = { powershell: 'unknown', uia: false }
        }
        continue
      }
      if (!trimmed.startsWith(MARKER)) continue
      let response: HostResponse
      try {
        response = JSON.parse(trimmed.slice(MARKER.length)) as HostResponse
      } catch {
        this.options.logger.debug('Computer Use 宿主返回了非法 JSON', {
          line: trimmed.slice(0, 200),
        })
        continue
      }
      const entry = this.pending.get(response.id)
      if (entry === undefined) continue
      clearTimeout(entry.timer)
      this.pending.delete(response.id)
      entry.resolve(response)
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
      this.pending.delete(id)
    }
  }

  private handleCrash(reason: string): void {
    if (this.stopping) return
    this.ready = false
    this.info = undefined
    this.startError = reason
    this.child = undefined
    this.rejectAll(new HostCommandError('HOST_CRASHED', reason))
    this.options.logger.warn('Computer Use 宿主异常', {
      reason,
      stderr: this.stderrTail.slice(-600),
    })
    this.options.onCrash?.(reason)
  }
}

export class HostCommandError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'HostCommandError'
    this.code = code
  }
}

/** 供单测 / 诊断使用：脚本会落到的文件路径。 */
export function hostScriptPath(dir: string): string {
  return join(dir, 'win-host.ps1')
}

/** 清掉宿主脚本目录（应用重置 / 单测用）。 */
export async function removeHostScript(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}
