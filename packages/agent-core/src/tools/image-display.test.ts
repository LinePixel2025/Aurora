import { describe, expect, it } from 'vitest'
import { createShowImageTool, type ImageDisplayPort } from './image-display.js'

describe('createShowImageTool', () => {
  function setup(error?: Error) {
    const calls: unknown[] = []
    const port: ImageDisplayPort = {
      async prepareImage(input) {
        calls.push(input)
        if (error !== undefined) throw error
        return {
          id: 'img-1',
          path: 'C:\\work\\result.png',
          name: 'result.png',
          mime: 'image/png',
          ...(input.caption === undefined ? {} : { caption: input.caption }),
        }
      },
      async readImage() {
        return { dataUrl: 'data:image/png;base64,AA==', name: 'result.png', mime: 'image/png' }
      },
    }
    return { tool: createShowImageTool({ port }), calls }
  }

  it('参数与敏感级：path 必填、caption 可选、safe', () => {
    const { tool } = setup()
    expect(tool.name).toBe('show_image')
    expect(tool.sensitivity).toBe('safe')
    expect(tool.parameters.required).toEqual(['path'])
    expect(tool.parameters.additionalProperties).toBe(false)
  })

  it('成功时把 path / caption / sessionId 交给端口，并返回展示元数据', async () => {
    const { tool, calls } = setup()
    const result = await tool.execute(
      { path: 'result.png', caption: '最终效果' },
      { sessionId: 's1' },
    )
    expect(calls).toEqual([{ path: 'result.png', caption: '最终效果', sessionId: 's1' }])
    expect(result.isError).toBeUndefined()
    expect(result.displayImages?.[0]).toMatchObject({
      id: 'img-1',
      name: 'result.png',
      caption: '最终效果',
    })
  })

  it('缺参不触碰端口；端口抛错折成工具错误', async () => {
    const { tool, calls } = setup()
    for (const input of [{}, { path: '' }, { path: '   ' }, null]) {
      const result = await tool.execute(input, { sessionId: 's1' })
      expect(result.isError).toBe(true)
    }
    expect(calls).toEqual([])

    const failing = setup(new Error('越界')).tool
    const result = await failing.execute({ path: 'x.png' }, { sessionId: 's1' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('越界')
  })
})
