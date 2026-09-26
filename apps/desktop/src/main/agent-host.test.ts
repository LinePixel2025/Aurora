/**
 * `createConfirmTool` 的**免确认模式分支与审计日志**（docs/06 §11.7）。
 *
 * 这块直接触碰安全边界：免确认列表只是"少弹一张卡片"（减少打扰），**不是**安全加固。
 * 因此本文件按对抗性口径写 —— 每一条"拿不到命令 / 模式非法 / 工具名不对"的情形都必须
 * 落回正常确认；只有"确实读出命令、且被合法模式命中"这一种情形才允许跳过卡片。
 *
 * 本文件不需要 Electron：`agent-host.ts` 的依赖链只到 `@aurora/agent-core` 与 `@aurora/shared`
 * （vitest 只收不 import 'electron' 的主进程测试，见 vitest.config.ts 的 include）。
 */
import { describe, expect, it } from 'vitest'
import type { Logger } from '@aurora/shared'
import { createConfirmTool, type SensitiveToolConfirmerLike } from './agent-host.js'

/** 内核 `confirmTool` 钩子的入参（与 `ConfirmToolDecision` 一致；不用 `Parameters<>` 以免被索引访问影响） */
interface ConfirmInfo {
  name: string
  input: unknown
  sessionId: string
  sensitivity: 'confirm'
}

function confirmInfo(name: string, input: unknown): ConfirmInfo {
  return { name, input, sessionId: 'test-session', sensitivity: 'confirm' }
}

interface ConfirmRequest {
  sessionId: string
  toolName: string
  input: unknown
}

/** 假的确认载体：只记账、按给定结果返回，用来断言"卡片到底弹没弹" */
function createFakeProactive(result: boolean | 'always'): {
  proactive: SensitiveToolConfirmerLike
  requests: ConfirmRequest[]
} {
  const requests: ConfirmRequest[] = []
  return {
    requests,
    proactive: {
      requestSensitiveToolConfirm(input) {
        requests.push({ ...input })
        return Promise.resolve(result)
      },
    },
  }
}

interface LogRecord {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  meta: unknown
}

/** 记账日志器：断言审计留痕必须能看到**级别**与**载荷**，光有字符串不够 */
function createRecordingLogger(): Logger & { records: LogRecord[] } {
  const records: LogRecord[] = []
  const logger: Logger & { records: LogRecord[] } = {
    records,
    debug: (message, meta) => records.push({ level: 'debug', message, meta }),
    info: (message, meta) => records.push({ level: 'info', message, meta }),
    warn: (message, meta) => records.push({ level: 'warn', message, meta }),
    error: (message, meta) => records.push({ level: 'error', message, meta }),
    child: () => logger,
  }
  return logger
}

/** 取审计载荷（实现里写的是对象字面量，这里转成可断言的对象） */
function metaOf(records: LogRecord[], index = 0): Record<string, unknown> {
  return (records[index]?.meta ?? {}) as Record<string, unknown>
}

describe('createConfirmTool 的免确认模式分支（run_command）', () => {
  it('命中免确认模式：不调用确认卡片，直接放行（返回 true）', async () => {
    const { proactive, requests } = createFakeProactive(false)
    const confirm = createConfirmTool({
      proactive,
      mode: () => 'confirm',
      allowPatterns: () => ['echo AURORA_ALLOW*'],
    })

    const approved = await confirm(confirmInfo('run_command', { command: 'echo AURORA_ALLOW_OK' }))

    expect(approved).toBe(true)
    expect(requests).toHaveLength(0)
  })

  it('未命中模式：调用确认卡片，并把它返回的 true 原样透传', async () => {
    const { proactive, requests } = createFakeProactive(true)
    const confirm = createConfirmTool({
      proactive,
      mode: () => 'confirm',
      allowPatterns: () => ['echo AURORA_ALLOW*'],
    })

    const approved = await confirm(confirmInfo('run_command', { command: 'echo OTHER' }))

    expect(approved).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.toolName).toBe('run_command')
    expect(requests[0]!.input).toEqual({ command: 'echo OTHER' })
    expect(requests[0]!.sessionId).toBe('test-session')
  })

  it('未命中模式：调用确认卡片，并把它返回的 false 原样透传（不放行）', async () => {
    const { proactive, requests } = createFakeProactive(false)
    const confirm = createConfirmTool({
      proactive,
      mode: () => 'confirm',
      allowPatterns: () => ['echo AURORA_ALLOW*'],
    })

    const approved = await confirm(confirmInfo('run_command', { command: 'echo OTHER' }))

    expect(approved).toBe(false)
    expect(requests).toHaveLength(1)
  })

  it('input 缺 command 字段：走确认（不因拿不到命令而放行）', async () => {
    const { proactive, requests } = createFakeProactive(true)
    const confirm = createConfirmTool({
      proactive,
      mode: () => 'confirm',
      // 故意用一条"假如能读出命令就会命中"的模式：放行才说明判据被绕过
      allowPatterns: () => ['git status*'],
    })

    for (const input of [{}, { cmd: 'git status' }, { Command: 'git status' }]) {
      await confirm(confirmInfo('run_command', input))
    }

    expect(requests).toHaveLength(3)
  })

  it('input 不是对象（null / 裸字符串 / 数字 / 数组）：走确认', async () => {
    const { proactive, requests } = createFakeProactive(true)
    const confirm = createConfirmTool({
      proactive,
      mode: () => 'confirm',
      allowPatterns: () => ['git status*'],
    })

    for (const input of [null, 'git status', 42, true, ['git status'], undefined]) {
      await confirm(confirmInfo('run_command', input))
    }

    expect(requests).toHaveLength(6)
  })

  it('command 不是字符串（数字 / 对象 / 数组 / 布尔）：走确认', async () => {
    const { proactive, requests } = createFakeProactive(true)
    const confirm = createConfirmTool({
      proactive,
      mode: () => 'confirm',
      // 三条都是"String() 一把会变成 git status"的形态，用来堵"隐式转字符串再匹配"的写法
      allowPatterns: () => ['git status*'],
    })

    for (const command of [123, { text: 'git status' }, ['git status'], true]) {
      await confirm(confirmInfo('run_command', { command }))
    }

    expect(requests).toHaveLength(4)
  })

  it('command 是空串或纯空白：走确认（空命令不构成"命中"）', async () => {
    const { proactive, requests } = createFakeProactive(true)
    const confirm = createConfirmTool({
      proactive,
      mode: () => 'confirm',
      allowPatterns: () => ['git status*'],
    })

    for (const command of ['', '   ', '\n\t']) {
      await confirm(confirmInfo('run_command', { command }))
    }

    expect(requests).toHaveLength(3)
  })

  it('命令首尾带空白：按 trim 后的串匹配（「被匹配的命令」=「被执行的命令」）', async () => {
    const logger = createRecordingLogger()
    const { proactive, requests } = createFakeProactive(true)
    const confirm = createConfirmTool({
      proactive,
      mode: () => 'confirm',
      allowPatterns: () => ['git status*'],
      logger,
    })

    // 真正执行时 terminal.ts 用的是 `rawCommand.trim()`；匹配侧若拿未 trim 的原串，
    // 下面这些写法都会白弹一张卡片 —— fail-safe（不会误放行），但"加了模式却有时不生效"难排查
    for (const command of ['  git status', 'git status  ', '\n\tgit status  ']) {
      const approved = await confirm(confirmInfo('run_command', { command }))
      expect(approved).toBe(true)
    }

    expect(requests).toHaveLength(0)
    // 审计日志记的也是 trim 后的命令：与真正执行的那条串一致，排查时不会对不上
    expect(logger.records).toHaveLength(3)
    expect(metaOf(logger.records)).toMatchObject({
      pattern: 'git status*',
      command: 'git status',
    })
  })

  it('命令首尾带空白但未命中：走确认，且卡片看到的是**原串**（匹配用的 trim 不污染展示）', async () => {
    const { proactive, requests } = createFakeProactive(true)
    const confirm = createConfirmTool({
      proactive,
      mode: () => 'confirm',
      allowPatterns: () => ['git status*'],
    })

    await confirm(confirmInfo('run_command', { command: '  git diff  ' }))

    expect(requests).toHaveLength(1)
    expect(requests[0]!.input).toEqual({ command: '  git diff  ' })
  })

  it('name 不是 run_command（write_file）：入参里带着命中模式的 command 也走确认', async () => {
    const { proactive, requests } = createFakeProactive(true)
    const confirm = createConfirmTool({
      proactive,
      mode: () => 'confirm',
      allowPatterns: () => ['git status*'],
    })

    const approved = await confirm(confirmInfo('write_file', { command: 'git status' }))

    expect(approved).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.toolName).toBe('write_file')
  })

  it('allowPatterns 未注入：行为与从前完全一致（run_command 也全走确认）', async () => {
    const { proactive, requests } = createFakeProactive(false)
    const confirm = createConfirmTool({ proactive, mode: () => 'confirm' })

    const approved = await confirm(confirmInfo('run_command', { command: 'echo AURORA_ALLOW_OK' }))

    expect(approved).toBe(false)
    expect(requests).toHaveLength(1)
  })

  it('allowPatterns 返回空数组：不命中任何命令，全走确认', async () => {
    const { proactive, requests } = createFakeProactive(true)
    const confirm = createConfirmTool({
      proactive,
      mode: () => 'confirm',
      allowPatterns: () => [],
    })

    const approved = await confirm(confirmInfo('run_command', { command: 'echo AURORA_ALLOW_OK' }))

    expect(approved).toBe(true)
    expect(requests).toHaveLength(1)
  })

  it('allowPatterns 每次调用即时取值：改完列表立刻生效（无需重启）', async () => {
    let patterns: readonly string[] = []
    const { proactive, requests } = createFakeProactive(true)
    const confirm = createConfirmTool({
      proactive,
      mode: () => 'confirm',
      allowPatterns: () => patterns,
    })

    await confirm(confirmInfo('run_command', { command: 'echo AURORA_ALLOW_OK' }))
    expect(requests).toHaveLength(1) // 空列表 → 弹卡片

    patterns = ['echo AURORA_ALLOW*']
    await confirm(confirmInfo('run_command', { command: 'echo AURORA_ALLOW_OK' }))
    expect(requests).toHaveLength(1) // 命中 → 不再弹卡片（计数没涨）
  })

  it('auto 档且未配置项目：直接放行、不调用确认载体（等价于旧的"关掉确认总开关"语义）', async () => {
    const logger = createRecordingLogger()
    const { proactive, requests } = createFakeProactive(false)
    const confirm = createConfirmTool({
      proactive,
      mode: () => 'auto',
      allowPatterns: () => ['echo AURORA_ALLOW*'],
      logger,
    })

    const approved = await confirm(confirmInfo('run_command', { command: 'echo AURORA_ALLOW_OK' }))

    expect(approved).toBe(true)
    expect(requests).toHaveLength(0)
    // 放行路径**会**留痕（info）：无项目时的 auto 放行必须可追溯，否则"为什么这次没弹卡片"无从查起
    expect(logger.records).toHaveLength(1)
    expect(logger.records[0]?.level).toBe('info')
  })

  it('命中时写 info 级审计日志（不是 warn），载荷含被命中的模式与命令', async () => {
    const logger = createRecordingLogger()
    const { proactive, requests } = createFakeProactive(true)
    const confirm = createConfirmTool({
      proactive,
      mode: () => 'confirm',
      allowPatterns: () => ['echo AURORA_ALLOW*'],
      logger,
    })

    await confirm(confirmInfo('run_command', { command: 'echo AURORA_ALLOW_OK' }))

    expect(requests).toHaveLength(0)
    expect(logger.records).toHaveLength(1)
    const entry = logger.records[0]!
    expect(entry.level).toBe('info')
    expect(entry.message).toContain('免确认模式')
    expect(metaOf(logger.records)).toMatchObject({
      tool: 'run_command',
      pattern: 'echo AURORA_ALLOW*',
      command: 'echo AURORA_ALLOW_OK',
    })
  })

  it('审计日志记的是**被命中的那条模式**（多条模式时取第一条命中的）', async () => {
    const logger = createRecordingLogger()
    const { proactive } = createFakeProactive(true)
    const confirm = createConfirmTool({
      proactive,
      mode: () => 'confirm',
      allowPatterns: () => ['npm test*', 'echo AURORA_ALLOW*'],
      logger,
    })

    await confirm(confirmInfo('run_command', { command: 'echo AURORA_ALLOW_OK' }))

    expect(metaOf(logger.records)['pattern']).toBe('echo AURORA_ALLOW*')
  })

  it('审计日志的命令只记前 200 字符（超长命令不整条留痕）', async () => {
    const logger = createRecordingLogger()
    const { proactive } = createFakeProactive(true)
    const confirm = createConfirmTool({
      proactive,
      mode: () => 'confirm',
      allowPatterns: () => ['echo *'],
      logger,
    })

    await confirm(confirmInfo('run_command', { command: `echo ${'x'.repeat(300)}` }))

    expect(metaOf(logger.records)['command']).toHaveLength(200)
  })

  it('未命中时**不写**审计日志（留痕只属于"跳过卡片"这一条路径）', async () => {
    const logger = createRecordingLogger()
    const { proactive } = createFakeProactive(true)
    const confirm = createConfirmTool({
      proactive,
      mode: () => 'confirm',
      allowPatterns: () => ['echo AURORA_ALLOW*'],
      logger,
    })

    await confirm(confirmInfo('run_command', { command: 'echo OTHER' }))

    expect(logger.records).toHaveLength(0)
  })

  it('负对照：allowPatterns 返回纯通配 [*]（用户手改 config.json 塞进来的）时仍然走确认', async () => {
    const logger = createRecordingLogger()
    const { proactive, requests } = createFakeProactive(true)
    const confirm = createConfirmTool({
      proactive,
      mode: () => 'confirm',
      allowPatterns: () => ['*'],
      logger,
    })

    const approved = await confirm(confirmInfo('run_command', { command: 'echo AURORA_ALLOW_OK' }))

    // 匹配层的纵深防御真的生效：一条 `*` 不能变成"全部免确认"
    expect(approved).toBe(true)
    expect(requests).toHaveLength(1)
    expect(logger.records).toHaveLength(0)
  })

  it('负对照：其它"等于全放行"的写法（** / ?* / 空白包围的 * / 花括号交替）也仍然走确认', async () => {
    const bypasses: readonly (readonly string[])[] = [
      ['**'],
      ['?*'],
      ['  *  '],
      ['{a,*}'],
      ['{*,git*}'],
      ['{x}*'],
    ]
    for (const patterns of bypasses) {
      const logger = createRecordingLogger()
      const { proactive, requests } = createFakeProactive(true)
      const confirm = createConfirmTool({
        proactive,
        mode: () => 'confirm',
        allowPatterns: () => patterns,
        logger,
      })

      const approved = await confirm(
        confirmInfo('run_command', { command: 'echo AURORA_ALLOW_OK' }),
      )

      expect(requests, `模式 ${patterns.join(',')} 不该放行`).toHaveLength(1)
      expect(approved).toBe(true) // 透传假载体的返回值
      expect(logger.records, `模式 ${patterns.join(',')} 不该留痕`).toHaveLength(0)
    }
  })
})

/**
 * 三档权限的判定（docs/06 §11.2，v13）。
 *
 * 这几条钉的是"档位真的改变了行为"，而不只是"字段被存下来了"：
 * 只读档必须**拒绝**（工具层已经不注册，这里是双保险）、auto 档按项目根内/外分流、confirm 档不变。
 */
describe('createConfirmTool 的三档权限判定', () => {
  const root = 'D:\\proj'

  it('readonly 档：任何敏感工具一律拒绝，且不弹确认卡片', async () => {
    const logger = createRecordingLogger()
    const { proactive, requests } = createFakeProactive(true)
    const confirm = createConfirmTool({
      proactive,
      mode: () => 'readonly',
      projectRoot: () => root,
      logger,
    })

    const approved = await confirm(confirmInfo('write_file', { path: 'D:\\proj\\a.txt' }))

    expect(approved).toBe(false)
    expect(requests).toHaveLength(0)
    expect(logger.records[0]?.level).toBe('warn')
  })

  it('auto 档 + 项目根内：免确认直接放行，并写 info 审计日志', async () => {
    const logger = createRecordingLogger()
    const { proactive, requests } = createFakeProactive(false)
    const confirm = createConfirmTool({
      proactive,
      mode: () => 'auto',
      projectRoot: () => root,
      logger,
    })

    const approved = await confirm(confirmInfo('write_file', { path: 'D:\\proj\\sub\\a.txt' }))

    expect(approved).toBe(true)
    expect(requests).toHaveLength(0)
    expect(logger.records[0]?.level).toBe('info')
    expect(metaOf(logger.records)).toMatchObject({
      tool: 'write_file',
      target: 'D:\\proj\\sub\\a.txt',
    })
  })

  it('auto 档 + 项目根外：仍走确认卡片（越界不免确认）', async () => {
    const { proactive, requests } = createFakeProactive(true)
    const confirm = createConfirmTool({
      proactive,
      mode: () => 'auto',
      projectRoot: () => root,
    })

    // 兄弟目录（前缀相同但不在根内）与 `..` 穿越都必须回到确认卡片
    expect(await confirm(confirmInfo('write_file', { path: 'D:\\proj2\\a.txt' }))).toBe(true)
    expect(await confirm(confirmInfo('write_file', { path: 'D:\\proj\\..\\other\\a.txt' }))).toBe(
      true,
    )
    // `edit_file` 走 `path`、`open_path` 走 `target`
    expect(await confirm(confirmInfo('open_path', { target: 'C:\\Windows' }))).toBe(true)
    expect(requests).toHaveLength(3)
  })

  it('auto 档 + run_command：cwd 在根内免确认，命令串里出现绝对路径时一律回到确认', async () => {
    const { proactive, requests } = createFakeProactive(true)
    const confirm = createConfirmTool({
      proactive,
      mode: () => 'auto',
      projectRoot: () => root,
    })

    // cwd 在根内、命令是相对命令 → 免确认
    expect(await confirm(confirmInfo('run_command', { command: 'npm test', cwd: root }))).toBe(true)
    // cwd 缺省（回落到根）但命令里带了绝对路径 → 保守起见回到确认卡片
    expect(
      await confirm(confirmInfo('run_command', { command: 'type C:\\Windows\\win.ini' })),
    ).toBe(true)
    expect(requests).toHaveLength(1)
  })

  it('confirm 档：行为与三档之前完全一致（一律走确认卡片）', async () => {
    const { proactive, requests } = createFakeProactive(true)
    const confirm = createConfirmTool({
      proactive,
      mode: () => 'confirm',
      projectRoot: () => root,
    })

    // 即便路径就在项目根内，confirm 档也要问
    expect(await confirm(confirmInfo('write_file', { path: 'D:\\proj\\a.txt' }))).toBe(true)
    expect(requests).toHaveLength(1)
  })
})
