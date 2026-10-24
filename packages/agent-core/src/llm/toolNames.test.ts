import { describe, expect, it } from 'vitest'
import { createToolNameCodec, TOOL_NAME_WIRE_PATTERN } from './toolNames.js'

describe('createToolNameCodec', () => {
  it('合法名字原样保留', () => {
    const codec = createToolNameCodec([{ name: 'read_file' }, { name: 'mcp-server.tool' }])
    expect(codec.toWire('read_file')).toBe('read_file')
  })

  it('点号与其它非法字符统一换成下划线', () => {
    const codec = createToolNameCodec([
      { name: 'plugin.com.classmanagement.board.add_task' },
      { name: 'mcp.my server/工具' },
    ])
    expect(codec.toWire('plugin.com.classmanagement.board.add_task')).toBe(
      'plugin_com_classmanagement_board_add_task',
    )
    expect(codec.toWire('mcp.my server/工具')).toBe('mcp_my_server___')
    for (const name of ['plugin.com.classmanagement.board.add_task', 'mcp.my server/工具']) {
      expect(codec.toWire(name)).toMatch(TOOL_NAME_WIRE_PATTERN)
    }
  })

  it('线路名能解码回内部名，并且内部名也能被接受', () => {
    const internal = 'plugin.com.x.foo'
    const codec = createToolNameCodec([{ name: internal }])
    const wire = codec.toWire(internal)
    expect(codec.toInternal(wire)).toBe(internal)
    // 模型偶发照抄内部名的兼容路径
    expect(codec.toInternal(internal)).toBe(internal)
    // 未知名字原样返回（由循环走「工具不存在」的既有错误路径）
    expect(codec.toInternal('unknown_tool')).toBe('unknown_tool')
  })

  it('归一后重名时按顺序加后缀，且线路名唯一', () => {
    // 两者都会归一成 a_b；传入顺序模拟 toLlmTools() 的排序结果
    const codec = createToolNameCodec([{ name: 'a.b' }, { name: 'a_b' }])
    const first = codec.toWire('a.b')
    const second = codec.toWire('a_b')
    expect(first).toBe('a_b')
    expect(second).toBe('a_b_2')
    expect(codec.toInternal(first)).toBe('a.b')
    expect(codec.toInternal(second)).toBe('a_b')
  })

  it('超过 64 字符截断，且后缀不会突破上限', () => {
    const long = 'plugin.' + 'a'.repeat(60) + '.b'
    const codec = createToolNameCodec([{ name: long }, { name: long.replace(/\./g, '_') }])
    const first = codec.toWire(long)
    const second = codec.toWire(long.replace(/\./g, '_'))
    expect(first.length).toBeLessThanOrEqual(64)
    expect(second.length).toBeLessThanOrEqual(64)
    expect(first).not.toBe(second)
    expect(codec.toInternal(first)).toBe(long)
  })

  it('toWireTools 只改名字，参数与描述原样透传', () => {
    const codec = createToolNameCodec([{ name: 'plugin.com.x.foo' }])
    const [tool] = codec.toWireTools([
      {
        name: 'plugin.com.x.foo',
        description: '描述',
        parameters: { type: 'object', properties: { text: { type: 'string' } } },
      },
    ])
    expect(tool).toEqual({
      name: 'plugin_com_x_foo',
      description: '描述',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
    })
  })
})
