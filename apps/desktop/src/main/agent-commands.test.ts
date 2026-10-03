/**
 * 内置斜杠命令 `/init` 的指令拼装（docs/06 §6）：纯函数，只验文本口径。
 */
import { describe, expect, it } from 'vitest'
import { buildInitCommandContext, isInitCommand } from './agent-commands.js'

describe('agent-commands（/init）', () => {
  it('只认整串 /init（不带参数、容空白）', () => {
    expect(isInitCommand('/init')).toBe(true)
    expect(isInitCommand(' /init ')).toBe(true)
    expect(isInitCommand('/init 请重点看构建命令')).toBe(false)
    expect(isInitCommand('/initialize')).toBe(false)
    expect(isInitCommand('')).toBe(false)
  })

  it('指令含目标目录、步骤与「不覆盖重写」要求；未绑定项目时说明空间根', () => {
    const text = buildInitCommandContext({
      root: 'C:\\Users\\u\\Desktop\\Aurora',
      isProjectRoot: false,
    })
    expect(text).toContain('C:\\Users\\u\\Desktop\\Aurora')
    expect(text).toContain('没有绑定项目')
    expect(text).toContain('AGENTS.md')
    // 已存在时补全而非推翻 —— 这是 AGENTS.md 作为约定文件的关键口径
    expect(text).toContain('不要整份推翻重写')

    const projectText = buildInitCommandContext({ root: 'D:\\work\\demo', isProjectRoot: true })
    expect(projectText).toContain('绑定了一个项目')
    expect(projectText).not.toContain('没有绑定项目')
  })
})
