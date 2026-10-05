/**
 * `run_command` 工具的内核单测（docs/06 §11、step 3）。
 *
 * 全程用**假 runner**，不启动任何进程：这里只验证工具层契约
 * （参数校验 / 缺省值 / 超时钳制 / 错误映射 / 输出截断）；
 * 真实进程行为由 `apps/desktop/src/main/tools/command-runner.test.ts` 覆盖。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  createTerminalTool,
  formatCommandOutput,
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
} from './terminal.js'
import type { ToolDefinition } from './registry.js'

const DEFAULT_CWD = 'D:\\aurora-workspace'
const CONFIG_TIMEOUT_MS = 30_000
const CONFIG_MAX_OUTPUT_CHARS = 4_000
const CONTEXT = { sessionId: 'session-test' }

function fakeResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    aborted: false,
    durationMs: 123,
    cwd: DEFAULT_CWD,
    ...overrides,
  }
}

interface HarnessOptions {
  /** 固定返回值，或按请求动态构造 */
  result?: CommandResult | ((request: CommandRequest) => CommandResult)
  /** 让 runner 抛错（可以是非 Error 的值） */
  error?: unknown
  maxTimeoutMs?: number
}

interface Harness {
  tool: ToolDefinition
  calls: CommandRequest[]
}

function createHarness(options: HarnessOptions = {}): Harness {
  const calls: CommandRequest[] = []
  const run: CommandRunner = async (request) => {
    calls.push(request)
    if (options.error !== undefined) throw options.error
    if (typeof options.result === 'function') return options.result(request)
    return options.result ?? fakeResult()
  }
  const tool = createTerminalTool({
    run,
    timeoutMs: CONFIG_TIMEOUT_MS,
    maxOutputChars: CONFIG_MAX_OUTPUT_CHARS,
    ...(options.maxTimeoutMs === undefined ? {} : { maxTimeoutMs: options.maxTimeoutMs }),
    defaultCwd: DEFAULT_CWD,
  })
  return { tool, calls }
}

describe('createTerminalTool', () => {
  it('按 docs/06 §11 的工具表声明名字、敏感级与参数 schema', () => {
    const { tool } = createHarness()
    expect(tool.name).toBe('run_command')
    expect(tool.sensitivity).toBe('confirm')
    expect(tool.parameters.type).toBe('object')
    expect(Object.keys(tool.parameters.properties ?? {})).toEqual(['command', 'cwd', 'timeoutMs'])
    expect(tool.parameters.required).toEqual(['command'])
    expect(tool.parameters.additionalProperties).toBe(false)
    // 描述要提示模型「先说明再调用」，并交代非交互限制
    expect(tool.description).toContain('先向用户说明')
    expect(tool.description).toContain('非交互')
  })

  it('命令透传（去空白），cwd 缺省用装配层注入的目录，超时用配置默认值', async () => {
    const { tool, calls } = createHarness()
    const result = await tool.execute({ command: '  echo AURORA  ' }, CONTEXT)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe('echo AURORA')
    expect(calls[0]?.cwd).toBe(DEFAULT_CWD)
    expect(calls[0]?.timeoutMs).toBe(CONFIG_TIMEOUT_MS)
    expect(calls[0]?.signal).toBeUndefined()
    expect(result.isError).toBe(false)
    expect(result.summary).toBe('退出码 0 · 123ms')
    // runner 没回带 command 时，头部也要能看到到底跑了什么
    expect(result.content).toContain('命令：echo AURORA')
  })

  it('显式 cwd 与 timeoutMs 生效', async () => {
    const { tool, calls } = createHarness()
    await tool.execute({ command: 'dir', cwd: 'C:\\Windows', timeoutMs: 5_000 }, CONTEXT)

    expect(calls[0]?.cwd).toBe('C:\\Windows')
    expect(calls[0]?.timeoutMs).toBe(5_000)
  })

  it('超时下限：请求 10ms 被抬到 1000ms', async () => {
    const { tool, calls } = createHarness()
    await tool.execute({ command: 'dir', timeoutMs: 10 }, CONTEXT)

    expect(calls[0]?.timeoutMs).toBe(MIN_TIMEOUT_MS)
  })

  it('超时上限：请求 9e9ms 被压到硬上限 300000ms', async () => {
    const { tool, calls } = createHarness()
    await tool.execute({ command: 'dir', timeoutMs: 9e9 }, CONTEXT)

    expect(calls[0]?.timeoutMs).toBe(DEFAULT_MAX_TIMEOUT_MS)
  })

  it('maxTimeoutMs 可被装配层收紧', async () => {
    const { tool, calls } = createHarness({ maxTimeoutMs: 5_000 })
    await tool.execute({ command: 'dir', timeoutMs: 60_000 }, CONTEXT)

    expect(calls[0]?.timeoutMs).toBe(5_000)
  })

  it('非零退出码 → isError，content 里带 stderr 供模型自我修正', async () => {
    const { tool } = createHarness({
      result: fakeResult({
        exitCode: 3,
        stdout: 'partial\n',
        stderr: 'BOOM: 找不到文件\n',
        durationMs: 210,
      }),
    })
    const result = await tool.execute({ command: 'dir nope' }, CONTEXT)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('BOOM: 找不到文件')
    expect(result.content).toContain('退出码：3')
    expect(result.summary).toBe('退出码 3 · 210ms')
  })

  it('超时 → isError，summary 用的是**生效后**的超时值', async () => {
    const timeoutResult = fakeResult({ exitCode: null, timedOut: true, durationMs: 812 })
    const { tool } = createHarness({ result: timeoutResult })

    const asked = await tool.execute({ command: 'Start-Sleep 10', timeoutMs: 1_500 }, CONTEXT)
    expect(asked.isError).toBe(true)
    expect(asked.summary).toBe('执行超时（>1500ms）已被终止')
    expect(asked.content).toContain('已终止（超时）')
    expect(asked.content).toContain('达到 1500ms 超时上限')
    expect(asked.content).toContain('空输出不代表命令未开始执行')

    // 请求 800ms 会被抬到下限 1000ms：summary 里必须是 1000 而不是 800（说的就是实际生效值）
    const clamped = await tool.execute({ command: 'Start-Sleep 10', timeoutMs: 800 }, CONTEXT)
    expect(clamped.summary).toBe('执行超时（>1000ms）已被终止')
  })

  it('被取消 → isError，summary 是「已取消」', async () => {
    const { tool } = createHarness({
      result: fakeResult({ exitCode: null, aborted: true, durationMs: 40 }),
    })
    const result = await tool.execute({ command: 'Start-Sleep 10' }, CONTEXT)

    expect(result.isError).toBe(true)
    expect(result.summary).toBe('已取消')
    expect(result.content).toContain('已终止（已取消）')
    expect(result.content).toContain('这不代表目标命令自身失败')
  })

  it('runner 抛错 → isError，content 为「命令执行失败：<message>」', async () => {
    const { tool, calls } = createHarness({ error: new Error('spawn ENOENT') })
    const result = await tool.execute({ command: 'dir' }, CONTEXT)

    expect(calls).toHaveLength(1)
    expect(result.isError).toBe(true)
    expect(result.content).toBe('命令执行失败：spawn ENOENT')
  })

  it('runner 抛非 Error 也能映射成文案', async () => {
    const { tool } = createHarness({ error: 'boom' })
    const result = await tool.execute({ command: 'dir' }, CONTEXT)

    expect(result.isError).toBe(true)
    expect(result.content).toBe('命令执行失败：boom')
  })

  it('参数非法（缺失 / 非字符串 / 纯空白）→ isError 且不调用 runner', async () => {
    const { tool, calls } = createHarness()

    const missing = await tool.execute({}, CONTEXT)
    const wrongType = await tool.execute({ command: 42 }, CONTEXT)
    const blank = await tool.execute({ command: '   \n ' }, CONTEXT)
    const notObject = await tool.execute('dir', CONTEXT)

    for (const result of [missing, wrongType, blank, notObject]) {
      expect(result.isError).toBe(true)
      expect(result.content).toContain('command')
    }
    expect(calls).toHaveLength(0)
  })

  it('AbortSignal 透传给 runner', async () => {
    const { tool, calls } = createHarness()
    const controller = new AbortController()
    await tool.execute({ command: 'dir' }, { sessionId: 's', signal: controller.signal })

    expect(calls[0]?.signal).toBe(controller.signal)
  })

  /**
   * 三档权限的越界放行透传（docs/06 §11.2）。
   *
   * 真正拦不拦 `cwd` 由实现侧（`main/tools/command-runner.ts`）决定；内核只把
   * "用户已批准"这一结论原样带进请求里，且**缺省一个键都不多**。
   */
  it('approvedByUser 未注入 / 为 false 时请求里没有 allowOutside 键', async () => {
    const { tool, calls } = createHarness()

    await tool.execute({ command: 'dir' }, CONTEXT)
    await tool.execute({ command: 'dir' }, { sessionId: 's', approvedByUser: false })

    expect(calls).toHaveLength(2)
    for (const request of calls) {
      expect('allowOutside' in request).toBe(false)
    }
  })

  it('approvedByUser === true → 请求带 allowOutside: true', async () => {
    const { tool, calls } = createHarness()

    await tool.execute({ command: 'dir' }, { sessionId: 's', approvedByUser: true })

    expect(calls[0]?.allowOutside).toBe(true)
  })
})

describe('formatCommandOutput', () => {
  it('头部含 command / cwd / 退出码 / 耗时，随后是 stdout 与 stderr', () => {
    const text = formatCommandOutput(
      fakeResult({
        command: 'echo hi',
        stdout: 'hi\r\n',
        stderr: 'warn\r\n',
        exitCode: 3,
        durationMs: 210.4,
      }),
      1_000,
    )

    expect(text).toContain('命令：echo hi')
    expect(text).toContain(`工作目录：${DEFAULT_CWD}`)
    expect(text).toContain('退出码：3')
    expect(text).toContain('耗时：210ms')
    expect(text).toContain('stdout：\nhi')
    expect(text).toContain('stderr：\nwarn')
  })

  it('超时 / 取消时明确说明进程树已终止与空输出语义', () => {
    const timeout = formatCommandOutput(
      fakeResult({ timedOut: true, exitCode: null, durationMs: 500 }),
      1_000,
      1_500,
    )
    expect(timeout).toContain('退出码：已终止（超时）')
    expect(timeout).toContain('达到 1500ms 超时上限')
    expect(timeout).toContain('空输出不代表命令未开始执行')

    const aborted = formatCommandOutput(
      fakeResult({ aborted: true, exitCode: null, durationMs: 50 }),
      1_000,
    )
    expect(aborted).toContain('退出码：已终止（已取消）')
    expect(aborted).toContain('这不代表目标命令自身失败')
  })

  it('空段省略（无 stdout / stderr 时只剩头部）', () => {
    const text = formatCommandOutput(fakeResult({ command: 'exit 0' }), 1_000)

    expect(text).not.toContain('stdout：')
    expect(text).not.toContain('stderr：')
    expect(text).toContain('退出码：0')
  })

  it('未超限时原样返回（不插截断标记）', () => {
    const text = formatCommandOutput(fakeResult({ stdout: 'ok' }), 1_000)

    expect(text).not.toContain('已截断')
    expect(text.endsWith('stdout：\nok')).toBe(true)
  })

  it('超长输出保留头 60% + 尾 40%，中间标注被截断的字符数', () => {
    const stdout = `HEAD_MARK${'A'.repeat(2_000)}MIDDLE_MARK`
    // 尾部放 stderr：真实场景里编译错误与堆栈都在尾部，必须保住
    const result = fakeResult({ command: 'dump', stdout, stderr: 'TAIL_MARK' })
    const full = formatCommandOutput(result, 1_000_000)
    const maxOutputChars = 200
    const truncated = formatCommandOutput(result, maxOutputChars)

    // 头 60% = 120 字符、尾 40% = 80 字符，其余全部丢弃
    expect(truncated.startsWith(full.slice(0, 120))).toBe(true)
    expect(truncated.endsWith(full.slice(-80))).toBe(true)
    // 头尾片段都在：命令回显 + stdout 开头 + 尾部 stderr
    expect(truncated).toContain('命令：dump')
    expect(truncated).toContain('HEAD_MARK')
    expect(truncated).toContain('TAIL_MARK')
    // 中间标记只有一行，且计数等于真正丢掉的字符数
    expect(truncated.match(/…（已截断 \d+ 字符）…/g)).toHaveLength(1)
    expect(truncated).toContain(`…（已截断 ${full.length - maxOutputChars} 字符）…`)
    // 被丢掉的中段确实没了（只可能出现在头尾窗口内的连续串不会整段保留）
    expect(truncated).not.toContain('A'.repeat(200))
  })

  it('恰好在限内不截断，仅超一个字符就截断', () => {
    const text = 'X'.repeat(300)
    const result = fakeResult({ command: '', stdout: text })

    const full = formatCommandOutput(result, 1_000_000)
    expect(formatCommandOutput(result, full.length)).toBe(full)
    expect(formatCommandOutput(result, full.length - 1)).toContain('已截断')
  })
})
