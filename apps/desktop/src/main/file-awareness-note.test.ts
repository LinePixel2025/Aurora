import { describe, expect, it } from 'vitest'
import {
  GENERATED_END,
  GENERATED_START,
  KNOWLEDGE_INDEX_FILE,
  candidateScore,
  createNoteMarkdown,
  mergeGeneratedBlock,
  noteExpiryInfo,
  noteRelativePath,
  normalizeNoteExpiry,
  parseAwarenessAnalysis,
  renderGeneratedBlock,
  renderKnowledgeIndex,
  safeNoteStem,
  stableNoteId,
} from './file-awareness-note.js'

describe('file-awareness-note', () => {
  it('稳定 id 与文件名对路径大小写归一，并清理非法字符', () => {
    expect(stableNoteId('D:\\Docs\\A.docx')).toBe(stableNoteId('d:/docs/a.docx'))
    expect(safeNoteStem('数学:第一课?', 'abc123')).toBe('数学-第一课---abc123.md')
  })

  it('inherit 按 updatedAt 续期，固定 at 不随 updatedAt 变化', () => {
    const updatedAt = '2026-10-01T00:00:00.000Z'
    const inherit = noteExpiryInfo(
      { updatedAt, expiry: { mode: 'inherit' } },
      7,
      Date.parse('2026-10-05T00:00:00.000Z'),
    )
    expect(inherit).toEqual({
      expiresAt: '2026-10-08T00:00:00.000Z',
      expired: false,
    })
    const expired = noteExpiryInfo(
      { updatedAt, expiry: { mode: 'inherit' } },
      3,
      Date.parse('2026-10-05T00:00:00.000Z'),
    )
    expect(expired.expired).toBe(true)

    const fixed = noteExpiryInfo(
      {
        updatedAt: '2026-10-04T00:00:00.000Z',
        expiry: { mode: 'at', at: '2026-10-05T00:00:00.000Z' },
      },
      365,
      Date.parse('2026-10-05T01:00:00.000Z'),
    )
    expect(fixed).toEqual({
      expiresAt: '2026-10-05T00:00:00.000Z',
      expired: true,
    })

    const manual = noteExpiryInfo(
      {
        updatedAt: '2026-10-04T00:00:00.000Z',
        expiry: { mode: 'at', at: '2099-01-01T00:00:00.000Z', preset: 'manual' },
      },
      365,
      Date.parse('2026-10-05T01:00:00.000Z'),
    )
    expect(manual).toEqual({ expired: true })
  })

  it('过期策略归一：缺省 / 损坏值回落 inherit，合法 preset 保留', () => {
    expect(normalizeNoteExpiry(undefined)).toEqual({ mode: 'inherit' })
    expect(normalizeNoteExpiry({ mode: 'at', at: '' })).toEqual({ mode: 'inherit' })
    expect(normalizeNoteExpiry({ mode: 'never' })).toEqual({ mode: 'never' })
    expect(
      normalizeNoteExpiry({ mode: 'at', at: '2026-10-05T00:00:00.000Z', preset: 'at7' }),
    ).toEqual({
      mode: 'at',
      at: '2026-10-05T00:00:00.000Z',
      preset: 'at7',
    })
    expect(
      normalizeNoteExpiry({
        mode: 'at',
        at: '2026-10-05T00:00:00.000Z',
        preset: 'manual',
      }),
    ).toEqual({
      mode: 'at',
      at: '2026-10-05T00:00:00.000Z',
      preset: 'manual',
    })
  })

  it('知识库路径按格式与首次感知日期分层', () => {
    expect(
      noteRelativePath({
        ext: 'DOCX',
        createdAt: new Date(2026, 9, 4, 12).toISOString(),
        title: '数学资料',
        id: 'abc123',
      }),
    ).toBe('docx/2026-10-04/数学资料--abc123.md')
  })

  it('根索引按格式与日期列出笔记链接和摘要', () => {
    const text = renderKnowledgeIndex({
      knowledgeDir: 'D:\\知识库',
      updatedAt: '2026-10-04T08:00:00.000Z',
      entries: [
        {
          id: 'abc',
          title: '项目计划',
          sourcePath: 'D:\\Docs\\项目计划.docx',
          notePath: 'D:\\知识库\\docx\\2026-10-04\\项目计划--abc.md',
          ext: 'docx',
          createdAt: '2026-10-04T08:00:00.000Z',
          updatedAt: '2026-10-04T08:00:00.000Z',
          summary: '待办与提醒',
          tags: ['项目'],
          expired: false,
        },
      ],
    })
    expect(KNOWLEDGE_INDEX_FILE).toBe('INDEX.md')
    expect(text).toContain('## docx')
    expect(text).toContain('[项目计划](<docx/2026-10-04/项目计划--abc.md>)')
    expect(text).toContain('标签：项目')
  })

  it('只替换生成区，标记外的手工内容保持不变', () => {
    const note = createNoteMarkdown(
      '资料',
      `${GENERATED_START}\n旧内容\n${GENERATED_END}\n\n用户手写\n`,
    )
    const merged = mergeGeneratedBlock(note, `${GENERATED_START}\n新内容\n${GENERATED_END}`)
    expect(merged.conflict).toBe(false)
    expect(merged.content).toContain('新内容')
    expect(merged.content).toContain('用户手写')
    expect(merged.content).not.toContain('旧内容')
  })

  it('标记缺失或重复时返回冲突，不覆盖原内容', () => {
    expect(mergeGeneratedBlock('没有标记', `${GENERATED_START}\n${GENERATED_END}`)).toEqual({
      content: '没有标记',
      conflict: true,
    })
    expect(
      mergeGeneratedBlock(
        `${GENERATED_START}\n${GENERATED_END}\n${GENERATED_START}`,
        `${GENERATED_START}\n${GENERATED_END}`,
      ).conflict,
    ).toBe(true)
  })

  it('解析严格 JSON，并从代码围栏外仍可提取对象', () => {
    const parsed = parseAwarenessAnalysis(`\`\`\`json
{"title":"数学","summary":"摘要","topics":["方程"],"keyPoints":["根"],"relationships":[{"noteId":"n1","relation":"同章","confidence":0.9}],"changes":[],"tags":["数学"],"suggestion":{"headline":"有后续练习","body":"可以继续整理","confidence":0.8,"action":{"label":"整理练习","prompt":"请把这份资料里的练习整理成待办清单。"}}}
\`\`\``)
    expect(parsed?.relationships[0]?.noteId).toBe('n1')
    expect(parsed?.suggestion?.headline).toBe('有后续练习')
    expect(parsed?.suggestion?.action?.label).toBe('整理练习')
    expect(parseAwarenessAnalysis('not json')).toBeUndefined()
  })

  it('建议 action 不完整时降级为不可执行，不影响建议正文', () => {
    const parsed = parseAwarenessAnalysis(
      JSON.stringify({
        title: '数学',
        summary: '摘要',
        suggestion: {
          headline: '有后续练习',
          body: '可以继续整理',
          confidence: 0.8,
          action: { label: '', prompt: '执行操作' },
        },
      }),
    )
    expect(parsed?.suggestion?.headline).toBe('有后续练习')
    expect(parsed?.suggestion?.action).toBeNull()
  })

  it('提醒文案按短口径截断，避免提示条重新变成长段落', () => {
    const parsed = parseAwarenessAnalysis(
      JSON.stringify({
        title: '数学',
        summary: '摘要',
        suggestion: {
          headline: '标'.repeat(40),
          body: '文'.repeat(80),
          confidence: 0.8,
          action: { label: '动'.repeat(12), prompt: '执行操作' },
        },
      }),
    )
    expect(parsed?.suggestion?.headline).toHaveLength(24)
    expect(parsed?.suggestion?.body).toHaveLength(60)
    expect(parsed?.suggestion?.action?.label).toHaveLength(8)
  })

  it('相关性评分优先同文件、同目录与共享标签', () => {
    const current = { title: '数学', sourcePath: 'D:\\Docs\\数学\\A.docx', tags: ['方程'] }
    const close = candidateScore(
      {
        title: '数学',
        sourcePath: 'D:\\Docs\\数学\\B.docx',
        tags: ['方程'],
        updatedAt: new Date().toISOString(),
      },
      current,
    )
    const far = candidateScore(
      {
        title: '英语',
        sourcePath: 'D:\\Docs\\英语\\C.docx',
        tags: ['语法'],
        updatedAt: new Date(0).toISOString(),
      },
      current,
    )
    expect(close).toBeGreaterThan(far)
  })

  it('生成块包含文件来源、哈希与使用次数', () => {
    const block = renderGeneratedBlock({
      note: {
        updatedAt: '2026-10-04T00:00:00.000Z',
        sourcePath: 'D:\\Docs\\A.docx',
        sourceHash: 'hash',
        usageCount: 3,
      },
      analysis: {
        title: 'A',
        summary: '摘要',
        topics: [],
        keyPoints: [],
        relationships: [],
        changes: [],
        tags: [],
        suggestion: null,
      },
    })
    expect(block).toContain('D:\\Docs\\A.docx')
    expect(block).toContain('hash')
    expect(block).toContain('已记录使用次数：3')
  })
})
