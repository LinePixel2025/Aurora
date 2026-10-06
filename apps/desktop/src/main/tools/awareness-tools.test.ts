import { describe, expect, it } from 'vitest'
import { ToolRegistry, type ToolContext } from '@aurora/agent-core'
import {
  createMemoryLogger,
  type FileAwarenessNote,
  type FileAwarenessStatus,
} from '@aurora/shared'
import {
  AWARENESS_READ_TOOL_NAME,
  AWARENESS_RECENT_TOOL_NAME,
  AWARENESS_SEARCH_TOOL_NAME,
  AWARENESS_STATUS_TOOL_NAME,
  createAwarenessTools,
  type AwarenessToolPort,
} from './awareness-tools.js'
import { registerAwarenessTools } from './index.js'

const ctx: ToolContext = { sessionId: 'chat-test' }

const note: FileAwarenessNote = {
  id: 'note-1',
  title: '数学复习笔记',
  sourcePath: 'D:\\学习\\数学复习.docx',
  notePath: 'D:\\memory\\docx\\数学复习--note-1.md',
  ext: 'docx',
  createdAt: '2026-10-05T02:00:00.000Z',
  updatedAt: '2026-10-05T03:00:00.000Z',
  sourceAvailable: true,
  conflict: false,
  excerpt: '二次函数与一元二次方程。',
  tags: ['数学', '复习'],
  expiry: { mode: 'inherit' },
  expired: false,
}

const status: FileAwarenessStatus = {
  enabled: true,
  consentAccepted: true,
  active: true,
  waitingForModel: false,
  waitingForAgent: false,
  modelError: '所选后台模型缺少 API Key',
  knowledgeDir: 'D:\\memory',
  knowledgeDirAvailable: true,
  watchedDirs: ['D:\\学习'],
  includeRecent: true,
  suggestionsEnabled: true,
  visionEnabled: false,
  dailyAnalysisLimit: 20,
  todayAnalyzed: 1,
  queueDepth: 2,
  queueOverflow: 0,
  noteCount: 1,
  expiredNoteCount: 0,
  conflictCount: 0,
  usage: {
    promptTokens: 120,
    completionTokens: 20,
    totalTokens: 140,
    cachedTokens: 40,
    rounds: 1,
  },
}

function port(): AwarenessToolPort {
  return {
    status: () => structuredClone(status),
    notes: () => [structuredClone(note)],
    records: () => [],
    readNote: async (noteId) => {
      if (noteId !== note.id) throw new Error('笔记不存在')
      return {
        noteId: note.id,
        title: note.title,
        sourcePath: note.sourcePath,
        notePath: note.notePath,
        content: '# 数学复习笔记\n\n二次函数与一元二次方程。',
        truncated: false,
        conflict: false,
      }
    },
  }
}

describe('文件自感知只读工具', () => {
  it('四个工具均可创建，状态包含真实 token 用量', async () => {
    const tools = createAwarenessTools(port())
    expect(tools.map((tool) => tool.name)).toEqual([
      AWARENESS_STATUS_TOOL_NAME,
      AWARENESS_RECENT_TOOL_NAME,
      AWARENESS_SEARCH_TOOL_NAME,
      AWARENESS_READ_TOOL_NAME,
    ])
    const result = await tools[0]!.execute({}, ctx)
    expect(result.content).toContain('累计 token：140')
    expect(result.content).toContain('笔记：1')
    expect(result.content).toContain('过期：0')
    expect(result.content).toContain('模型：所选后台模型缺少 API Key')
  })

  it('搜索标签并分页读取已知 noteId', async () => {
    const tools = createAwarenessTools(port())
    const search = tools.find((tool) => tool.name === AWARENESS_SEARCH_TOOL_NAME)!
    const found = await search.execute({ query: '数学' }, ctx)
    expect(found.content).toContain('id: note-1')
    expect(found.content).toContain('标签：数学、复习')

    const read = tools.find((tool) => tool.name === AWARENESS_READ_TOOL_NAME)!
    const first = await read.execute({ noteId: 'note-1', offset: 0, maxChars: 5 }, ctx)
    expect(first.content).toContain('# 数学复习')
    expect(first.content).toContain('offset=5')
    const missing = await read.execute({ noteId: 'missing' }, ctx)
    expect(missing.isError).toBe(true)
  })

  it('未启用时只注册状态工具，启用后补齐只读工具', () => {
    const registry = new ToolRegistry()
    let active = false
    const registration = registerAwarenessTools({
      tools: registry,
      logger: createMemoryLogger(),
      port: port(),
      active: () => active,
    })
    registration.sync()
    expect(registry.get(AWARENESS_STATUS_TOOL_NAME)).toBeDefined()
    expect(registry.get(AWARENESS_RECENT_TOOL_NAME)).toBeUndefined()
    active = true
    registration.sync()
    expect(registry.get(AWARENESS_RECENT_TOOL_NAME)).toBeDefined()
    expect(registry.get(AWARENESS_SEARCH_TOOL_NAME)).toBeDefined()
    expect(registry.get(AWARENESS_READ_TOOL_NAME)).toBeDefined()
  })
})
