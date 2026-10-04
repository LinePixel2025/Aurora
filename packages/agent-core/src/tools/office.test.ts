import { describe, expect, it, vi } from 'vitest'
import type { OfficePort } from './office.js'
import { createOfficeTools } from './office.js'
import type { ReadTracker } from './edit.js'

function makePort(): OfficePort & {
  read: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  edit: ReturnType<typeof vi.fn>
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
      { path: 'report.docx' },
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
      { path: 'report.docx', operations: [{ type: 'replace_text', find: 'a', replace: 'b' }] },
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
      { path: 'report.docx', operations: [{ type: 'replace_text', find: 'a', replace: 'b' }] },
      { sessionId: 's1' },
    )
    expect(result.isError).not.toBe(true)
    expect(port.edit).toHaveBeenCalledOnce()
    expect(tracker.keys.size).toBe(0)
  })

  it('office_create 校验 format 与内容组合', async () => {
    const port = makePort()
    const tool = toolOf(port, undefined, 'office_create')
    const badFormat = await tool.execute({ path: 'a.docx', format: 'doc' }, { sessionId: 's1' })
    expect(badFormat.isError).toBe(true)
    const noContent = await tool.execute({ path: 'a.docx', format: 'docx' }, { sessionId: 's1' })
    expect(noContent.isError).toBe(true)
    expect(port.create).not.toHaveBeenCalled()
  })
})
