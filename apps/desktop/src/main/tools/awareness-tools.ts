/** 文件自感知只读工具（docs/06 §26）：状态 / 最近理解 / 搜索 / 读取笔记。 */
import type { ToolDefinition, ToolResult } from '@aurora/agent-core'
import type {
  FileAwarenessNote,
  FileAwarenessNoteContent,
  FileAwarenessRecord,
  FileAwarenessStatus,
  SessionUsageStats,
} from '@aurora/shared'

export const AWARENESS_STATUS_TOOL_NAME = 'awareness_status'
export const AWARENESS_RECENT_TOOL_NAME = 'awareness_recent'
export const AWARENESS_SEARCH_TOOL_NAME = 'awareness_search'
export const AWARENESS_READ_TOOL_NAME = 'awareness_read'

export const AWARENESS_TOOL_NAMES = [
  AWARENESS_STATUS_TOOL_NAME,
  AWARENESS_RECENT_TOOL_NAME,
  AWARENESS_SEARCH_TOOL_NAME,
  AWARENESS_READ_TOOL_NAME,
] as const

export const AWARENESS_ACTIVE_TOOL_NAMES = [
  AWARENESS_RECENT_TOOL_NAME,
  AWARENESS_SEARCH_TOOL_NAME,
  AWARENESS_READ_TOOL_NAME,
] as const

export interface AwarenessToolPort {
  status(): FileAwarenessStatus
  notes(limit?: number): FileAwarenessNote[]
  records(limit?: number): FileAwarenessRecord[]
  readNote(noteId: string): Promise<FileAwarenessNoteContent>
}

const DEFAULT_RECENT_LIMIT = 10
const MAX_RECENT_LIMIT = 50
const DEFAULT_SEARCH_LIMIT = 20
const MAX_SEARCH_LIMIT = 50
const DEFAULT_READ_CHARS = 12_000
const MAX_READ_CHARS = 30_000

export function createAwarenessStatusTool(port: AwarenessToolPort): ToolDefinition {
  return {
    name: AWARENESS_STATUS_TOOL_NAME,
    description:
      '查看 Aurora 文件自感知的运行状态、今日分析进度、队列、笔记数、冲突、错误与累计 token。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    sensitivity: 'safe',
    parallel: true,
    execute: async (): Promise<ToolResult> => {
      try {
        const status = port.status()
        const lines = [
          `启用：${status.enabled ? '是' : '否'}；正文分析授权：${status.consentAccepted ? '已同意' : '未同意'}`,
          `运行：${
            status.waitingForAgent
              ? '等待 Agent'
              : status.active
                ? '正在感知'
                : status.waitingForModel
                  ? '等待模型'
                  : '未运行'
          }`,
          `今日分析：${status.todayAnalyzed}/${status.dailyAnalysisLimit}`,
          `队列：${status.queueDepth}（溢出 ${status.queueOverflow}）`,
          `笔记：${status.noteCount}；过期：${status.expiredNoteCount}；冲突：${status.conflictCount}`,
          `图片识别：${status.visionEnabled ? '已开启' : '仅分析文字'}`,
          `累计 token：${formatUsage(status.usage)}`,
        ]
        if (status.modelError !== undefined) lines.push(`模型：${status.modelError}`)
        if (status.current !== undefined) lines.push(`当前文件：${status.current.fileName}`)
        if (status.lastError !== undefined) lines.push(`最近错误：${status.lastError}`)
        return {
          content: lines.join('\n'),
          summary: status.active ? '自感知运行中' : '自感知未运行',
        }
      } catch (error) {
        return {
          content: `读取自感知状态失败：${errorMessage(error)}`,
          isError: true,
          summary: '读取状态失败',
        }
      }
    },
  }
}

export function createAwarenessRecentTool(port: AwarenessToolPort): ToolDefinition {
  return {
    name: AWARENESS_RECENT_TOOL_NAME,
    description:
      '列出 Aurora 最近理解的文件与运行记录，按时间倒序。返回的 noteId 可用于 awareness_read。',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: `返回条数，默认 ${DEFAULT_RECENT_LIMIT}，最大 ${MAX_RECENT_LIMIT}`,
        },
      },
      required: [],
      additionalProperties: false,
    },
    sensitivity: 'safe',
    parallel: true,
    execute: async (input): Promise<ToolResult> => {
      const record = asRecord(input)
      const limit = clampInteger(record?.['limit'], DEFAULT_RECENT_LIMIT, 1, MAX_RECENT_LIMIT)
      const notes = port.notes(limit)
      const records = port.records(limit)
      const seen = new Set(notes.map((note) => normalizePath(note.sourcePath)))
      const items = [
        ...notes.map((note) => ({
          at: note.updatedAt,
          text: `- [笔记] ${note.title}（id: ${note.id}，${note.ext}，更新 ${note.updatedAt}）\n  来源：${note.sourcePath}\n  摘要：${compact(note.excerpt, 180)}`,
        })),
        ...records
          .filter((item) => !seen.has(normalizePath(item.sourcePath)))
          .map((item) => ({
            at: item.occurredAt,
            text: `- [${recordLabel(item)}] ${item.fileName}${item.noteId === undefined ? '' : `（id: ${item.noteId}）`}\n  来源：${item.sourcePath}\n  摘要：${compact(item.summary || item.error || '尚未生成笔记', 180)}`,
          })),
      ]
        .sort((left, right) => right.at.localeCompare(left.at))
        .slice(0, limit)
      if (items.length === 0) {
        return { content: '暂无最近理解记录。', summary: '暂无最近理解' }
      }
      return {
        content: items.map((item) => item.text).join('\n'),
        summary: `${items.length} 条最近理解`,
      }
    },
  }
}

export function createAwarenessSearchTool(port: AwarenessToolPort): ToolDefinition {
  return {
    name: AWARENESS_SEARCH_TOOL_NAME,
    description:
      '搜索 Aurora 已登记的文件记忆笔记。可按关键词、格式与首次感知日期过滤；返回 noteId 后可用 awareness_read 读取全文。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '在标题、来源路径、摘要与标签中匹配的关键词' },
        ext: { type: 'string', description: '文件格式，如 docx / pptx（可选）' },
        since: { type: 'string', description: '首次感知日期下界，ISO 日期或 YYYY-MM-DD（可选）' },
        until: { type: 'string', description: '首次感知日期上界，ISO 日期或 YYYY-MM-DD（可选）' },
        limit: {
          type: 'number',
          description: `返回条数，默认 ${DEFAULT_SEARCH_LIMIT}，最大 ${MAX_SEARCH_LIMIT}`,
        },
      },
      required: [],
      additionalProperties: false,
    },
    sensitivity: 'safe',
    parallel: true,
    execute: async (input): Promise<ToolResult> => {
      const record = asRecord(input)
      const query = readString(record, 'query')?.toLowerCase()
      const ext = readString(record, 'ext')?.toLowerCase()
      const since = parseBoundary(readString(record, 'since'), false)
      const until = parseBoundary(readString(record, 'until'), true)
      if (since.error !== undefined || until.error !== undefined) {
        return {
          content: since.error ?? until.error ?? '日期参数无效。',
          isError: true,
          summary: '日期参数无效',
        }
      }
      if (
        query === undefined &&
        ext === undefined &&
        since.value === undefined &&
        until.value === undefined
      ) {
        return {
          content: '至少提供 query、ext、since、until 中的一个筛选条件。',
          isError: true,
          summary: '缺少筛选条件',
        }
      }
      const limit = clampInteger(record?.['limit'], DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT)
      const matches = port.notes(500).filter((note) => {
        if (ext !== undefined && note.ext.toLowerCase() !== ext) return false
        const created = Date.parse(note.createdAt)
        if (since.value !== undefined && (!Number.isFinite(created) || created < since.value))
          return false
        if (until.value !== undefined && (!Number.isFinite(created) || created > until.value))
          return false
        if (query === undefined) return true
        return [note.title, note.sourcePath, note.excerpt, ...note.tags]
          .join('\n')
          .toLowerCase()
          .includes(query)
      })
      const items = matches.slice(0, limit)
      if (items.length === 0) {
        return { content: '没有匹配的文件记忆。', summary: '没有匹配项' }
      }
      return {
        content: items
          .map(
            (note) =>
              `- ${note.title}（id: ${note.id}，${note.ext}，首次感知 ${note.createdAt}）\n  来源：${note.sourcePath}\n  摘要：${compact(note.excerpt, 220)}${note.tags.length === 0 ? '' : `\n  标签：${note.tags.join('、')}`}`,
          )
          .join('\n'),
        summary: `${matches.length} 条匹配`,
      }
    },
  }
}

export function createAwarenessReadTool(port: AwarenessToolPort): ToolDefinition {
  return {
    name: AWARENESS_READ_TOOL_NAME,
    description:
      '按 noteId 读取 Aurora 文件记忆笔记的 Markdown。支持 offset 与 maxChars 分页；不接受任意文件路径。',
    parameters: {
      type: 'object',
      properties: {
        noteId: {
          type: 'string',
          description: 'awareness_search / awareness_recent 返回的笔记 id',
        },
        offset: { type: 'number', description: '起始字符偏移，默认 0' },
        maxChars: {
          type: 'number',
          description: `本次最多返回字符数，默认 ${DEFAULT_READ_CHARS}，最大 ${MAX_READ_CHARS}`,
        },
      },
      required: ['noteId'],
      additionalProperties: false,
    },
    sensitivity: 'safe',
    parallel: true,
    execute: async (input): Promise<ToolResult> => {
      const record = asRecord(input)
      const noteId = readString(record, 'noteId')
      if (noteId === undefined) {
        return { content: '缺少参数：noteId。', isError: true, summary: '缺少 noteId' }
      }
      const offset = clampInteger(record?.['offset'], 0, 0, Number.MAX_SAFE_INTEGER)
      const maxChars = clampInteger(record?.['maxChars'], DEFAULT_READ_CHARS, 1, MAX_READ_CHARS)
      try {
        const note = await port.readNote(noteId)
        const chunk = note.content.slice(offset, offset + maxChars)
        const nextOffset = offset + chunk.length
        const truncated = nextOffset < note.content.length
        const footer = truncated ? `\n\n[已截断；可继续用 offset=${nextOffset} 读取]` : ''
        return {
          content: `# ${note.title}\n来源：${note.sourcePath}\n\n${chunk}${footer}`,
          summary: truncated ? '已读取笔记片段' : '已读取笔记',
        }
      } catch (error) {
        return {
          content: `读取笔记失败：${errorMessage(error)}`,
          isError: true,
          summary: '读取笔记失败',
        }
      }
    },
  }
}

export function createAwarenessTools(port: AwarenessToolPort): ToolDefinition[] {
  return [
    createAwarenessStatusTool(port),
    createAwarenessRecentTool(port),
    createAwarenessSearchTool(port),
    createAwarenessReadTool(port),
  ]
}

function formatUsage(usage: SessionUsageStats | undefined): string {
  if (usage === undefined || usage.rounds <= 0) return '暂无用量'
  return `${usage.totalTokens}（输入 ${usage.promptTokens} / 输出 ${usage.completionTokens} / 缓存 ${usage.cachedTokens} / ${usage.rounds} 轮）`
}

function recordLabel(record: FileAwarenessRecord): string {
  if (record.status === 'done') return '已理解'
  if (record.status === 'error') return '失败'
  if (record.status === 'conflict') return '冲突'
  return record.kind === 'delete' ? '已删除' : '已跳过'
}

function parseBoundary(
  value: string | undefined,
  endOfDay: boolean,
): { value?: number; error?: string } {
  if (value === undefined) return {}
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`)
    : new Date(value)
  if (Number.isNaN(date.getTime())) return { error: `日期参数无效：${value}` }
  return { value: date.getTime() }
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function compact(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function normalizePath(value: string): string {
  return value.replaceAll('/', '\\').toLowerCase()
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  return input as Record<string, unknown>
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
