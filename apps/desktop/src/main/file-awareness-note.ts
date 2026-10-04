/** 文件自感知笔记与分析 JSON 的纯逻辑（docs/06 §26）。 */
import { createHash } from 'node:crypto'
import { basename, extname, relative } from 'node:path'

export const GENERATED_START = '<!-- aurora:generated:start -->'
export const GENERATED_END = '<!-- aurora:generated:end -->'
export const KNOWLEDGE_INDEX_FILE = 'INDEX.md'

export interface AwarenessRelationship {
  noteId: string
  relation: string
  confidence: number
}

export interface AwarenessSuggestionPayload {
  headline: string
  body: string
  confidence: number
  action: AwarenessAgentAction | null
}

export interface AwarenessAgentAction {
  label: string
  prompt: string
}

export interface AwarenessAnalysis {
  title: string
  summary: string
  topics: string[]
  keyPoints: string[]
  relationships: AwarenessRelationship[]
  changes: string[]
  tags: string[]
  suggestion: AwarenessSuggestionPayload | null
}

export interface AwarenessNoteRecord {
  id: string
  title: string
  sourcePath: string
  sourceHash: string
  sizeBytes: number
  mtimeMs: number
  ext: string
  notePath: string
  createdAt: string
  updatedAt: string
  sourceAvailable: boolean
  conflict: boolean
  usageCount: number
  lastUsedAt?: string
  summary: string
  tags: string[]
  relatedNoteIds: string[]
}

export interface KnowledgeIndexEntry {
  id: string
  title: string
  sourcePath: string
  notePath: string
  ext: string
  createdAt: string
  updatedAt: string
  summary: string
  tags: string[]
}

export function stableNoteId(sourcePath: string): string {
  const normalized = sourcePath.replace(/\//g, '\\').toLowerCase()
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12)
}

export function safeNoteStem(title: string, id: string): string {
  const withoutInvalid = [...title]
    .map((char) => {
      const code = char.charCodeAt(0)
      return code < 32 || '<>:"/\\|?*'.includes(char) ? '-' : char
    })
    .join('')
  const stem = withoutInvalid
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 80)
  return `${stem === '' ? '文件笔记' : stem}--${id}.md`
}

/**
 * 知识库相对路径：格式 / 首次感知日期 / 一源文件一 md。
 *
 * 日期取笔记首次创建时间，后续更新不随当天日期漂移；因此同一源文件始终写回同一份 md，
 * 不会在同一天或跨天产生多份重复笔记。
 */
export function noteRelativePath(input: {
  ext: string
  createdAt: string
  title: string
  id: string
}): string {
  const format =
    input.ext
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '') || 'other'
  const date = new Date(input.createdAt)
  const day = Number.isNaN(date.getTime())
    ? 'unknown-date'
    : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
        date.getDate(),
      ).padStart(2, '0')}`
  return `${format}/${day}/${safeNoteStem(input.title, input.id)}`
}

export function renderGeneratedBlock(input: {
  note: Pick<AwarenessNoteRecord, 'updatedAt' | 'sourcePath' | 'sourceHash' | 'usageCount'>
  analysis: AwarenessAnalysis
}): string {
  const { analysis } = input
  const lines: string[] = [GENERATED_START]
  lines.push(`## 摘要`, '', analysis.summary.trim() || '（暂无摘要）', '')

  if (analysis.topics.length > 0) {
    lines.push('## 主题', '', ...analysis.topics.map((item) => `- ${item}`), '')
  }
  if (analysis.keyPoints.length > 0) {
    lines.push('## 关键信息', '', ...analysis.keyPoints.map((item) => `- ${item}`), '')
  }
  if (analysis.changes.length > 0) {
    lines.push('## 本次变化', '', ...analysis.changes.map((item) => `- ${item}`), '')
  }
  if (analysis.relationships.length > 0) {
    lines.push(
      '## 与已有记录的关联',
      '',
      ...analysis.relationships.map(
        (item) =>
          `- \`${item.noteId}\`：${item.relation}（置信度 ${(item.confidence * 100).toFixed(0)}%）`,
      ),
      '',
    )
  }
  lines.push(
    '## 文件信息',
    '',
    `- 来源：\`${input.note.sourcePath}\``,
    `- 内容哈希：\`${input.note.sourceHash}\``,
    `- 更新：${input.note.updatedAt}`,
    `- 已记录使用次数：${input.note.usageCount}`,
    GENERATED_END,
  )
  return lines.join('\n')
}

export function createNoteMarkdown(title: string, block: string): string {
  return `# ${title.trim() || '文件笔记'}\n\n${block}\n`
}

/** 生成知识库根目录的 Markdown 索引；只读展示，不参与生成区合并。 */
export function renderKnowledgeIndex(input: {
  entries: readonly KnowledgeIndexEntry[]
  knowledgeDir: string
  updatedAt: string
}): string {
  const lines = [
    '# Aurora 文件知识库索引',
    '',
    '> 本文件由 Aurora 自动维护，用于快速定位和联想已有笔记。',
    `> 最近更新：${input.updatedAt}`,
    '',
  ]
  const grouped = new Map<string, Map<string, KnowledgeIndexEntry[]>>()
  for (const entry of input.entries) {
    const day = dayKeyOf(entry.createdAt)
    const byDay = grouped.get(entry.ext) ?? new Map<string, KnowledgeIndexEntry[]>()
    const items = byDay.get(day) ?? []
    items.push(entry)
    byDay.set(day, items)
    grouped.set(entry.ext, byDay)
  }
  if (grouped.size === 0) {
    lines.push('暂无笔记。', '')
    return lines.join('\n')
  }
  for (const [ext, days] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## ${ext}`, '')
    for (const [day, items] of [...days.entries()].sort(([a], [b]) => b.localeCompare(a))) {
      lines.push(`### ${day}`, '')
      for (const item of items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
        const relativePath = relativePathOf(input.knowledgeDir, item.notePath)
        lines.push(`- [${escapeLinkText(item.title)}](<${relativePath}>)`)
        lines.push(`  - ID：\`${item.id}\``)
        lines.push(`  - 来源：\`${item.sourcePath}\``)
        if (item.tags.length > 0) lines.push(`  - 标签：${item.tags.join('、')}`)
        if (item.summary.trim() !== '') {
          lines.push(`  - 摘要：${item.summary.replace(/\s+/g, ' ').trim().slice(0, 180)}`)
        }
      }
      lines.push('')
    }
  }
  return lines.join('\n')
}

/**
 * 只替换标记内的生成区；标记缺失或超过一组时返回 conflict，调用方不得覆盖。
 */
export function mergeGeneratedBlock(
  existing: string,
  block: string,
): { content: string; conflict: boolean } {
  const starts = existing.split(GENERATED_START).length - 1
  const ends = existing.split(GENERATED_END).length - 1
  if (starts !== 1 || ends !== 1) return { content: existing, conflict: true }
  const start = existing.indexOf(GENERATED_START)
  const end = existing.indexOf(GENERATED_END)
  if (start < 0 || end < start) return { content: existing, conflict: true }
  const after = end + GENERATED_END.length
  return {
    content: `${existing.slice(0, start)}${block}${existing.slice(after)}`,
    conflict: false,
  }
}

function stringValue(value: unknown, max = 1200): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function stringList(value: unknown, maxItems = 8, maxChars = 240): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => stringValue(item, maxChars))
    .filter((item) => item !== '')
    .slice(0, maxItems)
}

export function parseAwarenessAnalysis(raw: string): AwarenessAnalysis | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  const candidate = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed
  let value: unknown
  try {
    value = JSON.parse(candidate)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const relationshipsRaw = Array.isArray(record['relationships']) ? record['relationships'] : []
  const relationships: AwarenessRelationship[] = []
  for (const item of relationshipsRaw.slice(0, 12)) {
    if (typeof item !== 'object' || item === null) continue
    const relation = item as Record<string, unknown>
    const noteId = stringValue(relation['noteId'], 40)
    const text = stringValue(relation['relation'], 300)
    const confidence = Number(relation['confidence'])
    if (noteId === '' || text === '') continue
    relationships.push({
      noteId,
      relation: text,
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
    })
  }

  const suggestionRaw =
    typeof record['suggestion'] === 'object' && record['suggestion'] !== null
      ? (record['suggestion'] as Record<string, unknown>)
      : null
  const headline = suggestionRaw === null ? '' : stringValue(suggestionRaw['headline'], 24)
  const body = suggestionRaw === null ? '' : stringValue(suggestionRaw['body'], 60)
  const suggestionConfidence =
    suggestionRaw === null ? 0 : Number(suggestionRaw['confidence'] ?? 0.7)
  const actionRaw =
    suggestionRaw !== null &&
    typeof suggestionRaw['action'] === 'object' &&
    suggestionRaw['action'] !== null
      ? (suggestionRaw['action'] as Record<string, unknown>)
      : null
  const actionLabel = actionRaw === null ? '' : stringValue(actionRaw['label'], 8)
  const actionPrompt = actionRaw === null ? '' : stringValue(actionRaw['prompt'], 2_000)
  const action =
    actionLabel === '' || actionPrompt === ''
      ? null
      : {
          label: actionLabel,
          prompt: actionPrompt,
        }
  const suggestion =
    headline === '' || body === ''
      ? null
      : {
          headline,
          body,
          confidence: Number.isFinite(suggestionConfidence)
            ? Math.min(1, Math.max(0, suggestionConfidence))
            : 0.7,
          action,
        }

  const title = stringValue(record['title'], 120)
  const summary = stringValue(record['summary'], 1600)
  if (title === '' && summary === '') return undefined
  return {
    title: title || '文件笔记',
    summary,
    topics: stringList(record['topics']),
    keyPoints: stringList(record['keyPoints']),
    relationships,
    changes: stringList(record['changes']),
    tags: stringList(record['tags'], 12, 60),
    suggestion,
  }
}

export function candidateScore(
  candidate: Pick<AwarenessNoteRecord, 'title' | 'sourcePath' | 'tags' | 'updatedAt'>,
  current: { title: string; sourcePath: string; tags: string[] },
): number {
  let score = 0
  const currentDir = dirOf(current.sourcePath)
  if (candidate.sourcePath.toLowerCase() === current.sourcePath.toLowerCase()) score += 100
  if (dirOf(candidate.sourcePath) === currentDir) score += 40
  const candidateStem = basename(candidate.sourcePath, extname(candidate.sourcePath)).toLowerCase()
  const currentStem = basename(current.sourcePath, extname(current.sourcePath)).toLowerCase()
  if (candidateStem === currentStem) score += 80
  else if (candidateStem.includes(currentStem) || currentStem.includes(candidateStem)) {
    score += 25
  }
  const currentTags = new Set(current.tags.map((tag) => tag.toLowerCase()))
  for (const tag of candidate.tags) {
    if (currentTags.has(tag.toLowerCase())) score += 20
  }
  const updated = Date.parse(candidate.updatedAt)
  if (Number.isFinite(updated)) score += Math.max(0, 10 - (Date.now() - updated) / 86_400_000)
  return score
}

function dirOf(path: string): string {
  const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return index < 0 ? '' : path.slice(0, index).toLowerCase()
}

function dayKeyOf(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'unknown-date'
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`
}

function relativePathOf(root: string, path: string): string {
  return relative(root, path).replaceAll('\\', '/')
}

function escapeLinkText(value: string): string {
  return value.replaceAll('[', '\\[').replaceAll(']', '\\]')
}
