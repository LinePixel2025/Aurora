/**
 * Isolated OfficeCLI process runner.
 *
 * The binary is pinned and shipped with Aurora. Runtime auto-update, automatic
 * install, resident mode and third-party plugins are always disabled here.
 */
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process'

export interface OfficeCliRunOptions {
  timeoutMs: number
  cwd?: string
}

export interface OfficeCliRunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface OfficeCliErrorJson {
  error: string
  code?: string
  suggestion?: string
  validValues?: string[]
}

export interface OfficeCliEnvelope<T> {
  success: boolean
  data?: T
  error?: OfficeCliErrorJson
}

export type OfficeCliSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams

export interface OfficeCliRunnerOptions {
  binaryPath: string
  spawnImpl?: OfficeCliSpawn
  maxOutputBytes?: number
}

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024

export class OfficeCliRunner {
  private readonly binaryPath: string
  private readonly spawnImpl: OfficeCliSpawn
  private readonly maxOutputBytes: number

  constructor(options: OfficeCliRunnerOptions) {
    this.binaryPath = options.binaryPath
    this.spawnImpl = options.spawnImpl ?? (spawn as OfficeCliSpawn)
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  }

  async run(args: readonly string[], options: OfficeCliRunOptions): Promise<OfficeCliRunResult> {
    const child = this.spawnImpl(this.binaryPath, args, {
      cwd: options.cwd,
      env: hardenedEnv(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let outputExceeded = false
    const append = (current: Buffer, chunk: Buffer): Buffer => {
      if (current.length + chunk.length > this.maxOutputBytes) {
        outputExceeded = true
        this.killTree(child)
        return current
      }
      return Buffer.concat([current, chunk])
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      this.killTree(child)
    }, options.timeoutMs)
    timer.unref?.()

    const result = await new Promise<{ code: number | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => resolve({ code }))
    }).finally(() => clearTimeout(timer))

    return {
      code: result.code,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8'),
      timedOut: timedOut || outputExceeded,
    }
  }

  async runJson<T>(
    args: readonly string[],
    options: OfficeCliRunOptions,
  ): Promise<{ envelope: OfficeCliEnvelope<T>; run: OfficeCliRunResult }> {
    const run = await this.run(args, options)
    const text = run.stdout.trim()
    if (text === '') {
      throw new Error(formatCliFailure('OfficeCLI 未返回 JSON', run))
    }
    try {
      return { envelope: JSON.parse(text) as OfficeCliEnvelope<T>, run }
    } catch {
      throw new Error(formatCliFailure('OfficeCLI 返回了无效 JSON', run))
    }
  }

  private killTree(child: ChildProcessWithoutNullStreams): void {
    if (child.pid === undefined) {
      child.kill()
      return
    }
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      })
      killer.once('error', () => child.kill())
      return
    }
    child.kill('SIGKILL')
  }
}

export function parseOfficeCliError(error: unknown): OfficeCliErrorJson {
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>
    if (typeof record['error'] === 'string') {
      return {
        error: record['error'],
        ...(typeof record['code'] === 'string' ? { code: record['code'] } : {}),
        ...(typeof record['suggestion'] === 'string' ? { suggestion: record['suggestion'] } : {}),
        ...(Array.isArray(record['validValues'])
          ? { validValues: record['validValues'].map(String) }
          : {}),
      }
    }
  }
  return { error: typeof error === 'string' ? error : JSON.stringify(error) }
}

function hardenedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OFFICECLI_SKIP_UPDATE: '1',
    OFFICECLI_NO_AUTO_INSTALL: '1',
    OFFICECLI_NO_AUTO_RESIDENT: '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  for (const key of Object.keys(env)) {
    if (key.startsWith('OFFICECLI_PLUGIN_')) delete env[key]
  }
  return env
}

function formatCliFailure(message: string, run: OfficeCliRunResult): string {
  const details = [message]
  if (run.timedOut) details.push('进程已超时并终止')
  if (run.code !== null) details.push(`退出码 ${run.code}`)
  const stderr = run.stderr.trim()
  if (stderr !== '') details.push(stderr)
  return details.join('：')
}
