/**
 * 剪贴板工具的内核单测（Design/betav2-spec.md §6）。
 *
 * 全程用**假端口**，不碰真实系统剪贴板：这里只验证工具层契约
 * （敏感级 / 参数校验 / 结果回填 / 端口错误转工具错误）；
 * 真实读写由主进程（Electron clipboard）承担。
 */
import { describe, expect, it } from 'vitest'
import { createClipboardImageTool, createClipboardTools } from './clipboard.js'
import type { ClipboardImagePort, ClipboardPort } from './clipboard.js'
import type { ToolDefinition, ToolImage } from './registry.js'

const CONTEXT = { sessionId: 'session-test' }

interface Harness {
  tools: { read: ToolDefinition; write: ToolDefinition }
  state: { reads: number; writes: string[] }
}

function createHarness(options: {
  readResult?: string
  readError?: unknown
  writeError?: unknown
}): Harness {
  const state: Harness['state'] = { reads: 0, writes: [] }
  const port: ClipboardPort = {
    read: async () => {
      state.reads += 1
      if (options.readError !== undefined) throw options.readError
      return options.readResult ?? '剪贴板里的内容'
    },
    write: async (text) => {
      if (options.writeError !== undefined) throw options.writeError
      state.writes.push(text)
    },
  }
  const [read, write] = createClipboardTools({ port })
  return { tools: { read, write }, state }
}

describe('createClipboardTools', () => {
  it('两个工具都是 confirm 敏感级（读剪贴板涉及隐私）', () => {
    const { tools } = createHarness({})
    expect(tools.read.name).toBe('clipboard_read')
    expect(tools.read.sensitivity).toBe('confirm')
    expect(tools.write.name).toBe('clipboard_write')
    expect(tools.write.sensitivity).toBe('confirm')
    // 读剪贴板不需要参数
    expect(tools.read.parameters.required).toEqual([])
  })

  it('clipboard_read 成功回填文本', async () => {
    const { tools, state } = createHarness({ readResult: '机密内容' })
    const result = await tools.read.execute({}, CONTEXT)
    expect(state.reads).toBe(1)
    expect(result.isError).toBeUndefined()
    expect(result.content).toBe('机密内容')
  })

  it('剪贴板为空时给出可读提示而不是空串', async () => {
    const { tools } = createHarness({ readResult: '' })
    const result = await tools.read.execute({}, CONTEXT)
    expect(result.content).toBe('（剪贴板为空或不含文本）')
  })

  it('clipboard_write 透传文本并回填字符数', async () => {
    const { tools, state } = createHarness({})
    const result = await tools.write.execute({ text: '要复制的内容' }, CONTEXT)
    expect(state.writes).toEqual(['要复制的内容'])
    expect(result.isError).toBeUndefined()
    expect(result.content).toBe('已写入剪贴板（6 字符）')
  })

  it('缺少 text 参数时报错且不触碰端口', async () => {
    const { tools, state } = createHarness({})
    const result = await tools.write.execute({}, CONTEXT)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('缺少参数 text')
    expect(state.writes).toEqual([])
  })

  it('端口抛错转为工具错误结果（不冒泡）', async () => {
    const read = createHarness({ readError: new Error('剪贴板被占用') })
    const readResult = await read.tools.read.execute({}, CONTEXT)
    expect(readResult.isError).toBe(true)
    expect(readResult.content).toContain('读取剪贴板失败')

    const write = createHarness({ writeError: 'boom' })
    const writeResult = await write.tools.write.execute({ text: 'x' }, CONTEXT)
    expect(writeResult.isError).toBe(true)
    expect(writeResult.content).toContain('写入剪贴板失败')
  })
})

/**
 * `clipboard_read_image`（图像工具，docs/06 §25）。
 *
 * 与文本工具的差别只有两处，都要钉住：`confirm` 敏感级（同档），
 * 以及"剪贴板里没有图片"是**正常情形**而不是错误 —— 如实回填并指路 `clipboard_read`，
 * 免得模型把空结果当成"图里什么都没看出来"。
 */
describe('createClipboardImageTool', () => {
  const CAPTURED: ToolImage = {
    path: 'C:\\Users\\u\\AppData\\Roaming\\Aurora\\clipboard\\1-a.png',
    image: { mimeType: 'image/png', dataBase64: 'AAA', name: '1-a.png' },
  }

  function createImageTool(options: { captured?: ToolImage; error?: unknown }): {
    tool: ToolDefinition
    calls: () => number
  } {
    let calls = 0
    const port: ClipboardImagePort = {
      capture: async () => {
        calls += 1
        if (options.error !== undefined) throw options.error
        return options.captured
      },
    }
    return { tool: createClipboardImageTool({ port }), calls: () => calls }
  }

  it('声明名字、confirm 敏感级，且不需要参数', () => {
    const { tool } = createImageTool({ captured: CAPTURED })
    expect(tool.name).toBe('clipboard_read_image')
    expect(tool.sensitivity).toBe('confirm')
    expect(tool.parameters.required).toEqual([])
    expect(tool.parameters.additionalProperties).toBe(false)
  })

  it('成功：回填落盘路径并把图片挂到 images 上', async () => {
    const { tool } = createImageTool({ captured: CAPTURED })
    const result = await tool.execute({}, CONTEXT)
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain(CAPTURED.path)
    expect(result.images).toEqual([CAPTURED])
  })

  it('剪贴板里没有图片：按正常结果如实说明并指路 clipboard_read', async () => {
    const { tool } = createImageTool({})
    const result = await tool.execute({}, CONTEXT)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('没有图片')
    expect(result.content).toContain('clipboard_read')
    expect(result.images).toBeUndefined()
  })

  it('端口抛错转为工具错误结果（不冒泡）', async () => {
    const { tool } = createImageTool({ error: new Error('剪贴板被占用') })
    const result = await tool.execute({}, CONTEXT)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('读取剪贴板图片失败')
    expect(result.content).toContain('剪贴板被占用')
  })
})
