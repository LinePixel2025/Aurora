import { describe, expect, it, vi } from 'vitest'
import type { OfficePort } from './office.js'
import { createOfficeTools } from './office.js'
import type { ReadTracker } from './edit.js'

function makePort(): OfficePort & {
  read: ReturnType<typeof vi.fn>
  help: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  edit: ReturnType<typeof vi.fn>
  rawEdit: ReturnType<typeof vi.fn>
  render: ReturnType<typeof vi.fn>
  pdf: ReturnType<typeof vi.fn>
  resolve: ReturnType<typeof vi.fn>
} {
  return {
    resolve: vi.fn(async (path: string) => `C:\\abs\\${path}`),
    read: vi.fn(async () => ({
      absolutePath: 'C:\\abs\\report.docx',
      format: 'docx' as const,
      content: 'P0: hello',
      truncated: false,
      warnings: [],
    })),
    help: vi.fn(async () => ({ content: 'paragraph props', truncated: false })),
    create: vi.fn(async () => ({
      absolutePath: 'C:\\abs\\report.docx',
      sourcePath: 'C:\\abs\\report.docx',
      format: 'docx' as const,
      bytes: 100,
      warnings: [],
    })),
    edit: vi.fn(async () => ({
      absolutePath: 'C:\\abs\\report-Aurora.docx',
      sourcePath: 'C:\\abs\\report.docx',
      format: 'docx' as const,
      bytes: 120,
      warnings: [],
    })),
    rawEdit: vi.fn(async () => ({
      absolutePath: 'C:\\abs\\report-Aurora.docx',
      sourcePath: 'C:\\abs\\report.docx',
      format: 'docx' as const,
      bytes: 120,
      warnings: [],
    })),
    render: vi.fn(async () => ({
      sourcePath: 'C:\\abs\\report.docx',
      format: 'docx' as const,
      files: ['C:\\cache\\render-1.png'],
      images: [
        {
          path: 'C:\\cache\\render-1.png',
          image: { mimeType: 'image/png', dataBase64: 'AA==' },
        },
      ],
      pageCount: 1,
      warnings: [],
    })),
    pdf: vi.fn(async () => ({
      absolutePath: 'C:\\abs\\report.pdf',
      sourcePath: 'C:\\abs\\report.docx',
      format: 'docx' as const,
      bytes: 300,
      pages: 1,
      warnings: [],
    })),
  }
}

function makeTracker(): ReadTracker & { keys: Set<string> } {
  const keys = new Set<string>()
  return {
    keys,
    has: (_sessionId, path) => keys.has(path),
    mark: (_sessionId, path) => void keys.add(path),
    clear: (_sessionId, path) => void keys.delete(path),
  }
}

function toolOf(port: OfficePort, tracker: ReadTracker | undefined, name: string) {
  return createOfficeTools({
    office: port,
    ...(tracker === undefined ? {} : { readTracker: tracker }),
  }).find((tool) => tool.name === name)!
}

describe('Office 工具契约', () => {
  it('office_read 成功后标记已读路径', async () => {
    const port = makePort()
    const tracker = makeTracker()
    const result = await toolOf(port, tracker, 'office_read').execute(
      { path: 'report.docx', mode: 'summary' },
      { sessionId: 's1' },
    )
    expect(result.isError).not.toBe(true)
    expect(tracker.keys.has('C:\\abs\\report.docx')).toBe(true)
    expect(port.read).toHaveBeenCalledOnce()
  })

  it('office_edit 在未读时拒绝且不调用端口', async () => {
    const port = makePort()
    const tracker = makeTracker()
    const result = await toolOf(port, tracker, 'office_edit').execute(
      {
        path: 'report.docx',
        commands: [{ command: 'set', path: '/body/p[1]', props: { text: 'x' } }],
      },
      { sessionId: 's1' },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('必须先用 office_read')
    expect(port.edit).not.toHaveBeenCalled()
  })

  it('office_edit 读过之后调用端口，并清掉编辑过的源 / 目标标记', async () => {
    const port = makePort()
    const tracker = makeTracker()
    tracker.mark('s1', 'C:\\abs\\report.docx')
    const result = await toolOf(port, tracker, 'office_edit').execute(
      {
        path: 'report.docx',
        commands: [{ command: 'set', path: '/body/p[1]', props: { text: 'x' } }],
      },
      { sessionId: 's1' },
    )
    expect(result.isError).not.toBe(true)
    expect(port.edit).toHaveBeenCalledOnce()
    expect(tracker.keys.size).toBe(0)
  })

  it('office_create 允许空白创建但拒绝 raw 命令', async () => {
    const port = makePort()
    const tool = toolOf(port, undefined, 'office_create')
    const badFormat = await tool.execute({ path: 'a.docx', format: 'doc' }, { sessionId: 's1' })
    expect(badFormat.isError).toBe(true)
    const raw = await tool.execute(
      {
        path: 'a.docx',
        format: 'docx',
        commands: [{ command: 'raw-set', part: '/document', xpath: '//w:p', action: 'remove' }],
      },
      { sessionId: 's1' },
    )
    expect(raw.isError).toBe(true)
    expect(raw.content).toContain('office_raw_edit')
    const blank = await tool.execute({ path: 'a.docx', format: 'docx' }, { sessionId: 's1' })
    expect(blank.isError).not.toBe(true)
    expect(port.create).toHaveBeenCalledOnce()
  })

  it('office_render 直接回传图片且保持 safe', async () => {
    const port = makePort()
    const tool = toolOf(port, undefined, 'office_render')
    expect(tool.sensitivity).toBe('safe')
    const result = await tool.execute({ path: 'report.docx' }, { sessionId: 's1' })
    expect(result.isError).not.toBe(true)
    expect(result.images).toHaveLength(1)
    expect(port.render).toHaveBeenCalledOnce()
  })

  it('office_raw_edit 需要先读取，且 office_pdf 是 confirm', async () => {
    const port = makePort()
    const tracker = makeTracker()
    const rawTool = toolOf(port, tracker, 'office_raw_edit')
    const rejected = await rawTool.execute(
      {
        path: 'report.docx',
        rawOperations: [{ part: '/document', xpath: '//w:p', action: 'remove' }],
      },
      { sessionId: 's1' },
    )
    expect(rejected.isError).toBe(true)
    tracker.mark('s1', 'C:\\abs\\report.docx')
    const accepted = await rawTool.execute(
      {
        path: 'report.docx',
        rawOperations: [{ part: '/document', xpath: '//w:p', action: 'remove' }],
      },
      { sessionId: 's1' },
    )
    expect(accepted.isError).not.toBe(true)
    expect(port.rawEdit).toHaveBeenCalledOnce()
    expect(toolOf(port, tracker, 'office_pdf').sensitivity).toBe('confirm')
  })

  it('office_help 查询指定元素', async () => {
    const port = makePort()
    const result = await toolOf(port, undefined, 'office_help').execute(
      { format: 'docx', verb: 'set', element: 'paragraph' },
      { sessionId: 's1' },
    )
    expect(result.isError).not.toBe(true)
    expect(port.help).toHaveBeenCalledWith({
      format: 'docx',
      verb: 'set',
      element: 'paragraph',
    })
  })
})
