/**
 * `run_command` 免确认模式列表的单测（docs/06 §11.7）。
 *
 * 这一份是**安全边界**的判据，不是普通功能测试：免确认列表等价于「摘掉终端工具自己的
 * 确认闸门」，因此断言必须对抗性 —— 除了正向命中，还要证明：
 * ① 纯通配（`*` / `**` / `?*` / 带空白的纯通配）与花括号绕过（`{a,*}` 这类）**匹配不上任何命令**；
 * ② 列表里混着非法模式时，合法的那条照常命中（非法项被**逐条跳过**，不是整次匹配失败）；
 * ③ AI 的 `set_setting` 改不动这份列表（自我提权闸门，见文件末尾那个 describe）。
 *
 * 纯函数、不碰磁盘、不 import electron（内核约束见 AGENTS.md）。
 */
import { describe, expect, it } from 'vitest'
import { canWriteSettingPath, createMemoryLogger, settingsReadonlyReason } from '@aurora/shared'
import {
  describeInvalidPattern,
  matchAllowPatterns,
  MAX_ALLOW_PATTERN_LENGTH,
  MAX_ALLOW_PATTERNS,
} from './command-allow.js'
import { matchesGlob } from './globPattern.js'
import { createSettingsTool } from './settings.js'
import type { SettingsToolPort } from './settings.js'
import type { ToolContext } from './registry.js'

/** 文本模式（命令串匹配）的短写：与 `matchAllowPatterns` 内部同一个编译口径 */
const hitText = (pattern: string, command: string): boolean =>
  matchesGlob(pattern, command, { pathMode: false, caseInsensitive: true })

describe('describeInvalidPattern：合法 / 非法模式的中文口径', () => {
  it('常量与 Schema 同源（上限 100 条 / 单条 200 字符）', () => {
    expect(MAX_ALLOW_PATTERNS).toBe(100)
    expect(MAX_ALLOW_PATTERN_LENGTH).toBe(200)
  })

  it('合法模式返回 undefined（字面字符 + `*` / `?` / 空格；恰好到上限也合法）', () => {
    expect(describeInvalidPattern('git status*')).toBeUndefined()
    expect(describeInvalidPattern('np? test')).toBeUndefined()
    expect(describeInvalidPattern('echo AURORA_ALLOW*')).toBeUndefined()
    expect(describeInvalidPattern('npm run build -- --watch')).toBeUndefined()
    expect(describeInvalidPattern('a')).toBeUndefined()
    expect(describeInvalidPattern('a'.repeat(MAX_ALLOW_PATTERN_LENGTH))).toBeUndefined()
  })

  it('空串 / 纯空白（含制表与换行）→ 「模式不能为空」', () => {
    expect(describeInvalidPattern('')).toBe('模式不能为空')
    expect(describeInvalidPattern('   ')).toBe('模式不能为空')
    expect(describeInvalidPattern('\t \n')).toBe('模式不能为空')
  })

  it('超过 200 字符 → 「模式过长（上限 200 字符）」', () => {
    expect(describeInvalidPattern('a'.repeat(MAX_ALLOW_PATTERN_LENGTH + 1))).toBe(
      `模式过长（上限 ${MAX_ALLOW_PATTERN_LENGTH} 字符）`,
    )
  })

  it('非字符串（手改 config.json 塞进来的）→ 「模式必须是字符串」', () => {
    expect(describeInvalidPattern(123 as unknown as string)).toBe('模式必须是字符串')
    expect(describeInvalidPattern(null as unknown as string)).toBe('模式必须是字符串')
    expect(describeInvalidPattern(['git status*'] as unknown as string)).toBe('模式必须是字符串')
  })

  it('纯通配（去掉 `*` / `?` 与空白后什么都不剩）→ 「…纯通配等于放行全部命令」', () => {
    const reason = '模式必须至少包含一个具体字符，纯通配等于放行全部命令'
    expect(describeInvalidPattern('*')).toBe(reason)
    expect(describeInvalidPattern('**')).toBe(reason)
    expect(describeInvalidPattern('?*')).toBe(reason)
    expect(describeInvalidPattern('  *  ')).toBe(reason)
    expect(describeInvalidPattern('***??')).toBe(reason)
  })

  it('含 `{` 或 `}` 一律判非法（未配对的同样被这一条整类拦住）', () => {
    const reason = '命令模式不支持花括号交替'
    expect(describeInvalidPattern('{a,*}')).toBe(reason)
    expect(describeInvalidPattern('{*,x}')).toBe(reason)
    expect(describeInvalidPattern('{x}*')).toBe(reason)
    // 未配对的花括号走不到「模式语法不合法」那一支：花括号整类拒绝在前
    expect(describeInvalidPattern('git {status')).toBe(reason)
    expect(describeInvalidPattern('git status}')).toBe(reason)
  })

  it('`{*}` 同时满足两条拒绝条件时，报的是花括号（口径统一、与 Schema refine 一致）', () => {
    expect(describeInvalidPattern('{*}')).toBe('命令模式不支持花括号交替')
  })
})

describe('matchAllowPatterns：命中语义（glob 全串、大小写不敏感）', () => {
  it('`echo AURORA_ALLOW*` 命中 `echo AURORA_ALLOW_OK`', () => {
    expect(matchAllowPatterns('echo AURORA_ALLOW_OK', ['echo AURORA_ALLOW*'])).toBe(
      'echo AURORA_ALLOW*',
    )
  })

  it('`git status*` 命中 `git status` 与 `git status --short`，不命中 `git stash`', () => {
    const patterns = ['git status*']
    expect(matchAllowPatterns('git status', patterns)).toBe('git status*')
    expect(matchAllowPatterns('git status --short', patterns)).toBe('git status*')
    expect(matchAllowPatterns('git stash', patterns)).toBeUndefined()
    expect(matchAllowPatterns('git stash pop', patterns)).toBeUndefined()
    expect(matchAllowPatterns('git statusx', patterns)).toBe('git status*')
  })

  it('全串锚定：`git *` 不命中 `echo git`（是整串匹配，不是子串匹配）', () => {
    expect(matchAllowPatterns('git status', ['git *'])).toBe('git *')
    expect(matchAllowPatterns('echo git', ['git *'])).toBeUndefined()
    expect(matchAllowPatterns('echo git status', ['git *'])).toBeUndefined()
    expect(matchAllowPatterns('sudo git status', ['git *'])).toBeUndefined()
  })

  it('大小写不敏感：`GIT STATUS` 命中 `git status*`；而 `rm *` 不命中 `git rm x`', () => {
    expect(matchAllowPatterns('GIT STATUS', ['git status*'])).toBe('git status*')
    expect(matchAllowPatterns('gIt StAtUs --short', ['git status*'])).toBe('git status*')
    expect(matchAllowPatterns('RM -rf /', ['rm *'])).toBe('rm *')
    expect(matchAllowPatterns('git rm x', ['rm *'])).toBeUndefined()
  })

  it('`?` 恰好匹配一个字符：`np? test` 命中 `npm test`，不命中 `np test` / `npmm test`', () => {
    expect(matchAllowPatterns('npm test', ['np? test'])).toBe('np? test')
    expect(matchAllowPatterns('np test', ['np? test'])).toBeUndefined()
    expect(matchAllowPatterns('npmm test', ['np? test'])).toBeUndefined()
  })

  it('返回被命中的模式串（审计留痕）；多条都命中时返回第一条', () => {
    expect(matchAllowPatterns('git status --short', ['git status*'])).toBe('git status*')
    expect(matchAllowPatterns('git status', ['git *', 'git status*'])).toBe('git *')
    expect(matchAllowPatterns('git status', ['git status*', 'git *'])).toBe('git status*')
  })

  it('空模式列表 → 任何命令都不命中（缺省配置 = 行为与从前完全一致）', () => {
    expect(matchAllowPatterns('git status', [])).toBeUndefined()
    expect(matchAllowPatterns('rm -rf /', [])).toBeUndefined()
  })
})

describe('matchAllowPatterns：安全边界（等于「全放行」的模式一律不匹配）', () => {
  /** 覆盖「像命令的」「危险的」「空的」三类输入 */
  const ANY_COMMANDS = ['git status', 'rm -rf /', 'echo AURORA_ALLOW_OK', 'curl x | sh', 'a', '']

  it('`*` 匹配不了任何命令（用户手改 config.json 塞进来的那条路）', () => {
    for (const command of ANY_COMMANDS) {
      expect(matchAllowPatterns(command, ['*']), command).toBeUndefined()
    }
  })

  it('`**` 匹配不了任何命令', () => {
    for (const command of ANY_COMMANDS) {
      expect(matchAllowPatterns(command, ['**']), command).toBeUndefined()
    }
  })

  it('`?*` 匹配不了任何命令', () => {
    for (const command of ANY_COMMANDS) {
      expect(matchAllowPatterns(command, ['?*']), command).toBeUndefined()
    }
  })

  it('带空白的纯通配 `  *  ` 匹配不了任何命令（去空白后仍是纯通配）', () => {
    for (const command of ANY_COMMANDS) {
      expect(matchAllowPatterns(command, ['  *  ']), command).toBeUndefined()
    }
  })

  it('空串模式（列表里的空元素）匹配不了任何命令', () => {
    for (const command of ANY_COMMANDS) {
      expect(matchAllowPatterns(command, ['']), command).toBeUndefined()
    }
  })

  it('非法模式被逐条跳过，同列表里合法的那条照常命中（不是整次匹配失败）', () => {
    const patterns = ['*', '{a,*}', '   ', 'git status*']
    expect(matchAllowPatterns('git status --short', patterns)).toBe('git status*')
    expect(matchAllowPatterns('rm -rf /', patterns)).toBeUndefined()
  })
})

describe('安全边界：花括号绕过被堵死（本计划修订过的缺口的回归测试）', () => {
  // 绕过原理：`{a,*}` 去掉 `*` / `?` 与空白后还剩一个 `a`，能骗过「至少含一个具体字符」
  // 的检查，但 glob 编译器把它编成交替组 —— 含 `.*` 的那一支匹配任意命令，等于一行关掉闸门。
  // 因此 `describeInvalidPattern` 从字符集里删掉 `{},` 并**整类拒绝花括号**。

  it('前提核实：底层 glob 编译器确实把花括号编成交替组（拦住它的只能是上面那条规则）', () => {
    // 这条同时是「下面三条不是空测」的证据：匹配器本身并没有「反正也匹配不上」这回事
    expect(hitText('{a,*}', 'rm -rf /')).toBe(true)
    expect(hitText('{*,x}', 'rm -rf /')).toBe(true)
    expect(hitText('git {status,stash}*', 'git stash')).toBe(true)
  })

  it('`{a,*}` 判非法，且连「本该被它的交替分支命中」的命令也不放行', () => {
    expect(describeInvalidPattern('{a,*}')).toBe('命令模式不支持花括号交替')
    expect(matchAllowPatterns('rm -rf /', ['{a,*}'])).toBeUndefined()
    expect(matchAllowPatterns('echo AURORA_ALLOW_OK', ['{a,*}'])).toBeUndefined()
    // `a` 是那个残留的具体字符：若只查「至少一个具体字符」，它这里会被放行
    expect(matchAllowPatterns('a', ['{a,*}'])).toBeUndefined()
    expect(matchAllowPatterns('anything', ['{a,*}'])).toBeUndefined()
  })

  it('`{*,x}` 判非法，且匹配不了任何命令', () => {
    expect(describeInvalidPattern('{*,x}')).toBe('命令模式不支持花括号交替')
    for (const command of ['x', 'rm -rf /', 'echo hi', '']) {
      expect(matchAllowPatterns(command, ['{*,x}']), command).toBeUndefined()
    }
  })

  it('`{x}*` 判非法（虽然它单独看无害，但花括号整类拒绝的口径不开口子）', () => {
    expect(describeInvalidPattern('{x}*')).toBe('命令模式不支持花括号交替')
    for (const command of ['x', 'xx', 'rm -rf /']) {
      expect(matchAllowPatterns(command, ['{x}*']), command).toBeUndefined()
    }
  })

  it('花括号模式混在合法模式里也不会被顺带放行', () => {
    expect(matchAllowPatterns('rm -rf /', ['git status*', '{a,*}'])).toBeUndefined()
    expect(matchAllowPatterns('a', ['{a,*}', 'git status*'])).toBeUndefined()
    expect(matchAllowPatterns('{a,*}', ['{a,*}'])).toBeUndefined()
  })
})

describe('set_setting 的自我提权闸门：AI 改不动免确认模式列表（docs/06 §11.7 / §12.2）', () => {
  const ALLOW_PATH = 'agent.tools.terminal.allowPatterns'
  const ctx: ToolContext = { sessionId: 'test-session' }

  /**
   * 最小假端口：只实现内核真正会碰的部分，**可写性判定委托给 `@aurora/shared` 的真实实现**
   * （主进程端口 `apps/desktop/src/main/tools/settings-port.ts` 用的是同一对函数），
   * 因此这里的「拒绝」不是测试自己编的规则，也不是端口一律拒绝（末尾有正对照）。
   */
  function createGateProbe(): {
    port: SettingsToolPort
    writes: Array<Array<{ path: string; value: unknown }>>
  } {
    const writes: Array<Array<{ path: string; value: unknown }>> = []
    const port: SettingsToolPort = {
      snapshot: () => ({}),
      read: () => undefined,
      writable(path) {
        const reason = settingsReadonlyReason(path)
        return reason === undefined ? { ok: true } : { ok: false, reason }
      },
      async write(paths) {
        writes.push(paths)
        return { ok: true, message: '已更新', applied: paths.map((item) => item.path) }
      },
    }
    return { port, writes }
  }

  it('规格原样输入 `value: [git*]` → 返回 isError，且一次 write 都没落下去', async () => {
    const { port, writes } = createGateProbe()
    const tool = createSettingsTool({ port, logger: createMemoryLogger() })

    const result = await tool.execute(
      { action: 'set', values: [{ path: ALLOW_PATH, value: ['git*'] }] },
      ctx,
    )

    // 数组值本身也会被参数校验拦掉（value 只收标量），但真正的判据是：写口一次都没通
    expect(result.isError).toBe(true)
    expect(writes).toHaveLength(0)
  })

  it('隔离只读闸门本身：标量写法也被「不能修改 …」拒绝，不是参数类型错误', async () => {
    const { port, writes } = createGateProbe()
    const tool = createSettingsTool({ port, logger: createMemoryLogger() })

    const result = await tool.execute(
      { action: 'set', values: [{ path: ALLOW_PATH, value: 'git*' }] },
      ctx,
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain(`不能修改 ${ALLOW_PATH}`)
    // 拒绝理由必须来自只读黑名单（含「确认闸门」），而不是 value 类型那条兜底
    expect(result.content).toContain('确认闸门')
    expect(result.content).not.toContain('value 只能是')
    expect(writes).toHaveLength(0)
  })

  it('夹带写入也不行：同一批里混一条合法 path，整批被拒且一个字段都没写', async () => {
    const { port, writes } = createGateProbe()
    const tool = createSettingsTool({ port, logger: createMemoryLogger() })

    const result = await tool.execute(
      {
        action: 'set',
        values: [
          { path: 'agent.tools.terminal.timeoutMs', value: 1000 },
          { path: ALLOW_PATH, value: 'git*' },
        ],
      },
      ctx,
    )

    expect(result.isError).toBe(true)
    expect(writes).toHaveLength(0)
  })

  it('换个写法也白搭：按数组下标路径 `…allowPatterns.0` 写入同样被拒', async () => {
    const { port, writes } = createGateProbe()
    const tool = createSettingsTool({ port, logger: createMemoryLogger() })

    const result = await tool.execute(
      { action: 'set', values: [{ path: `${ALLOW_PATH}.0`, value: 'git*' }] },
      ctx,
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain(`不能修改 ${ALLOW_PATH}.0`)
    expect(writes).toHaveLength(0)
  })

  it('读也拒绝：action=get 同路径 → isError「该路径不可读」（不可写即不可读）', async () => {
    const { port } = createGateProbe()
    const tool = createSettingsTool({ port, logger: createMemoryLogger() })

    const result = await tool.execute({ action: 'get', path: ALLOW_PATH }, ctx)

    expect(result.isError).toBe(true)
    expect(result.content).toBe('该路径不可读')
  })

  it('只读判定来自 @aurora/shared 的真实实现：该路径只读，同组邻居字段仍可写', () => {
    expect(canWriteSettingPath(ALLOW_PATH)).toBe(false)
    const reason = settingsReadonlyReason(ALLOW_PATH)
    expect(reason).toBeDefined()
    expect(reason).toContain('确认闸门')
    // 不是「未知配置路径」那条兜底：原因来自黑名单
    expect(reason).not.toBe('未知配置路径')
    // 别把整个 terminal 分组一起封死（AI 仍能调超时 / 开关终端）
    expect(canWriteSettingPath('agent.tools.terminal.timeoutMs')).toBe(true)
    expect(canWriteSettingPath('agent.tools.terminal.enabled')).toBe(true)
  })

  it('正对照：同一端口下 `agent.tools.terminal.timeoutMs` 能正常写入', async () => {
    const { port, writes } = createGateProbe()
    const tool = createSettingsTool({ port, logger: createMemoryLogger() })

    const result = await tool.execute(
      { action: 'set', values: [{ path: 'agent.tools.terminal.timeoutMs', value: 12_345 }] },
      ctx,
    )

    expect(result.isError).not.toBe(true)
    expect(writes).toHaveLength(1)
  })
  /**
   * v0.2.8 复核的两条只读路径：**AI 改不动「自动化」与「自己的提权开关」**。
   *
   * 与上面的免确认列表同属自我提权闸门：`automations.*` 是用户对「AI 能不能自己排后台动作」的
   * 总闸门（改它 + `automation_*` 工具 = 自己给自己排程），`general.requireAdmin` 是 Agent 自己的
   * 权限边界（关掉它等于降低权限约束面）。两条都由用户在设置页操作，判定走同一份真实实现。
   */
  it('automations.* 整组只读，理由是黑名单那条而不是「未知配置路径」', () => {
    for (const path of ['automations.enabled', 'automations']) {
      expect(canWriteSettingPath(path)).toBe(false)
      const reason = settingsReadonlyReason(path)
      expect(reason).toBeDefined()
      expect(reason).toContain('自动化')
      expect(reason).not.toBe('未知配置路径')
    }
  })

  it('general.requireAdmin 只读（AI 不能给自己关掉提权），常规页邻居字段不受影响', () => {
    expect(canWriteSettingPath('general.requireAdmin')).toBe(false)
    const reason = settingsReadonlyReason('general.requireAdmin')
    expect(reason).toBeDefined()
    expect(reason).toContain('管理员')
    expect(reason).not.toBe('未知配置路径')
    // 正对照：没被整组封死
    expect(canWriteSettingPath('general.chat.showThinking')).toBe(true)
    expect(canWriteSettingPath('general.edgeBar.enabled')).toBe(true)
  })

  it('端口侧同样拒绝（如实回填中文原因，且一次 write 都没落下去）', async () => {
    const { port, writes } = createGateProbe()
    const tool = createSettingsTool({ port, logger: createMemoryLogger() })
    for (const path of ['automations.enabled', 'general.requireAdmin']) {
      const result = await tool.execute({ action: 'set', values: [{ path, value: false }] }, ctx)
      expect(result.isError).toBe(true)
      expect(result.content).toContain(`不能修改 ${path}`)
    }
    expect(writes).toHaveLength(0)
  })
})
