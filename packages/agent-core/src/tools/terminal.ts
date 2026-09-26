/**
 * `run_command` 工具（docs/06 §11、step 3）。
 *
 * 分层：本文件是**纯逻辑**——工具定义、参数校验、超时钳制、结果裁剪。
 * 真正的进程执行由主进程实现（`apps/desktop/src/main/tools/command-runner.ts`），
 * 经构造参数 `run` 注入，因此内核既不依赖 Electron，也能在 Node 里完整单测。
 *
 * 安全边界（docs/06 §11.1）：`sensitivity: 'confirm'` —— 每次调用都要用户确认；
 * 不做命令黑名单，安全靠「逐次确认 + 输出上限 + 总开关」三道。
 */
import type { ToolDefinition, ToolResult } from './registry.js'

export interface CommandRequest {
  command: string
  cwd?: string
  timeoutMs?: number
  signal?: AbortSignal
  /**
   * 越界放行标记（docs/06 §11.2 三档权限）：`cwd` 落在项目根之外时，
   * 由实现侧（`main/tools/command-runner.ts`）决定拦不拦。
   *
   * 为什么放在请求里而不是另开一个钩子：`cwd` 校验天然属于"这次执行要用哪个目录"，
   * 与 `cwd` 同路传递最不容易漏；**内核不判档位、也不判越界**，只把内核的确认结论原样透传。
   * 缺省不传（`undefined`）= 维持既有行为——实现侧若本来不拦，就仍不拦。
   */
  allowOutside?: boolean
}

export interface CommandResult {
  /** 退出码；进程被终止（超时 / 取消）时为 `null` */
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  durationMs: number
  /** 实际使用的工作目录（绝对路径）——越界不静默，回带真实路径供用户判断 */
  cwd: string
  /**
   * 原始命令，仅用于 `formatCommandOutput` 渲染头部。
   * 可选：老调用方（step 6 smoke 的手工构造）不填也能工作，此时头部不显示命令行。
   */
  command?: string
}

export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>

export interface TerminalToolOptions {
  run: CommandRunner
  /** 默认超时（来自 agent.tools.terminal.timeoutMs） */
  timeoutMs: number
  /** 回填给模型的输出上限（来自 agent.tools.terminal.maxOutputChars） */
  maxOutputChars: number
  /** 单次请求可申请的超时硬上限，默认 300_000 */
  maxTimeoutMs?: number
  defaultCwd: string
}

export const RUN_COMMAND_TOOL_NAME = 'run_command'
/** 单次命令的**最小**超时：低于 1s 连 PowerShell 启动都不够，必然误报超时 */
export const MIN_TIMEOUT_MS = 1_000
export const DEFAULT_MAX_TIMEOUT_MS = 300_000

/** 截断时头部占比（尾部 40% 必须保住：编译错误与堆栈都在尾部，docs/06 §11.1） */
const HEAD_RATIO = 0.6

export function createTerminalTool(options: TerminalToolOptions): ToolDefinition {
  const maxTimeoutMs = Math.max(MIN_TIMEOUT_MS, options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS)

  return {
    name: RUN_COMMAND_TOOL_NAME,
    description:
      '在 Windows 上以 PowerShell 执行一条命令，返回退出码、stdout 与 stderr。' +
      '需要用户确认后才会真正执行，因此**先向用户说明你要做什么、为什么**，再调用本工具。' +
      '非交互执行：不适合需要持续输入的程序（REPL、密码提示、more 等），这类命令会一直挂到超时；' +
      '需要交互时请改写成非交互写法。超时会终止整棵进程树。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的 PowerShell 命令（单条、非交互）',
        },
        cwd: {
          type: 'string',
          description: '工作目录（绝对路径）；缺省用配置里的默认工作目录',
        },
        timeoutMs: {
          type: 'number',
          description: `超时毫秒数，会被钳制到 ${MIN_TIMEOUT_MS}–${maxTimeoutMs}；缺省用配置里的默认超时`,
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    sensitivity: 'confirm',
    execute: async (input, ctx): Promise<ToolResult> => {
      const parsed = readInput(input)
      // 参数非法时**不调用 runner**：宁可什么都不做，也不猜一个命令去执行
      if (parsed.command === '') {
        return {
          content: '缺少命令：参数 command 必须是非空字符串。',
          isError: true,
          summary: '缺少 command 参数',
        }
      }

      const cwd = parsed.cwd ?? options.defaultCwd
      const timeoutMs = clampTimeout(parsed.timeoutMs ?? options.timeoutMs, maxTimeoutMs)

      let result: CommandResult
      try {
        result = await options.run({
          command: parsed.command,
          cwd,
          timeoutMs,
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
          // 已获用户批准时才带上放行标记：缺省不带（老调用方与直接调工具的单测行为不变）
          ...(ctx.approvedByUser === true ? { allowOutside: true } : {}),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: `命令执行失败：${message}`,
          isError: true,
          summary: '命令执行失败',
        }
      }

      // 非零退出码 / 超时 / 取消都算失败：让模型看到 stderr 自行修正，而不是让循环崩掉
      const ok = result.exitCode === 0 && !result.timedOut && !result.aborted
      return {
        // 头部必须带命令行：runner 没回带就补上（确认卡片与工具结果里都要能看到到底跑了什么）
        content: formatCommandOutput(
          { ...result, command: result.command ?? parsed.command },
          options.maxOutputChars,
        ),
        isError: !ok,
        summary: summarize(result, timeoutMs),
      }
    },
  }
}

/**
 * 把执行结果渲染成回填给模型的文本。
 *
 * 头部固定为 `command / cwd / 退出码 / 耗时`（越界不静默：绝对路径要露给用户看），
 * 随后是 stdout、stderr（空段省略）。总长超过 `maxOutputChars` 时保留**头部 60% + 尾部 40%**，
 * 中间插一行 `…（已截断 N 字符）…`——尾部不丢是关键。
 */
export function formatCommandOutput(result: CommandResult, maxOutputChars: number): string {
  const header: string[] = []
  const command = result.command?.trim() ?? ''
  if (command !== '') header.push(`命令：${command}`)
  header.push(`工作目录：${result.cwd}`)
  header.push(`退出码：${describeExitCode(result)}`)
  header.push(`耗时：${Math.round(result.durationMs)}ms`)

  const sections = [header.join('\n')]
  const stdout = trimTrailingBlank(result.stdout)
  if (stdout !== '') sections.push(`stdout：\n${stdout}`)
  const stderr = trimTrailingBlank(result.stderr)
  if (stderr !== '') sections.push(`stderr：\n${stderr}`)

  return truncateMiddle(sections.join('\n\n'), maxOutputChars)
}

interface ParsedInput {
  /** 去空白后的命令；参数非法时为空串 */
  command: string
  cwd: string | undefined
  timeoutMs: number | undefined
}

function readInput(input: unknown): ParsedInput {
  const record =
    typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
  const rawCommand = record['command']
  const rawCwd = record['cwd']
  const rawTimeout = record['timeoutMs']
  return {
    command: typeof rawCommand === 'string' ? rawCommand.trim() : '',
    cwd: typeof rawCwd === 'string' && rawCwd.trim() !== '' ? rawCwd.trim() : undefined,
    // 非数字 / NaN / Infinity 一律当没传：交给配置默认值与钳制
    timeoutMs:
      typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) ? rawTimeout : undefined,
  }
}

function clampTimeout(requested: number, maxTimeoutMs: number): number {
  return Math.min(Math.max(Math.round(requested), MIN_TIMEOUT_MS), maxTimeoutMs)
}

function describeExitCode(result: CommandResult): string {
  if (result.timedOut) return '已终止（超时）'
  if (result.aborted) return '已终止（已取消）'
  if (result.exitCode === null) return '未知（进程被终止）'
  return String(result.exitCode)
}

/** 渲染卡片用的短摘要（docs/07 执行卡片） */
function summarize(result: CommandResult, timeoutMs: number): string {
  if (result.aborted) return '已取消'
  if (result.timedOut) return `执行超时（>${timeoutMs}ms）已被终止`
  const code = result.exitCode === null ? '未知' : String(result.exitCode)
  return `退出码 ${code} · ${Math.round(result.durationMs)}ms`
}

function trimTrailingBlank(text: string): string {
  return text.replace(/\s+$/, '')
}

/** 超长时保留头 60% + 尾 40%，中间标注被丢弃的字符数。 */
function truncateMiddle(text: string, maxOutputChars: number): string {
  if (maxOutputChars <= 0 || text.length <= maxOutputChars) return text
  const headLength = Math.floor(maxOutputChars * HEAD_RATIO)
  const tailLength = maxOutputChars - headLength
  const head = safeHead(text, headLength)
  const tail = safeTail(text, tailLength)
  const omitted = text.length - head.length - tail.length
  return `${head}\n…（已截断 ${omitted} 字符）…\n${tail}`
}

/** 不在代理对中间切开（emoji 等非 BMP 字符），否则尾部会出现替换字符。 */
function safeHead(text: string, length: number): string {
  if (length <= 0) return ''
  const code = text.charCodeAt(length - 1)
  return text.slice(0, isHighSurrogate(code) ? length - 1 : length)
}

function safeTail(text: string, length: number): string {
  if (length <= 0) return ''
  const start = Math.max(0, text.length - length)
  const code = text.charCodeAt(start)
  return text.slice(isLowSurrogate(code) ? start + 1 : start)
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}
