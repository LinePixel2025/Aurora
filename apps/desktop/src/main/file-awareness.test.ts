import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createDefaultSettings, createNoopLogger } from '@aurora/shared'
import {
  FileAwarenessService,
  type AwarenessAnalyzeRequest,
  type AwarenessWatcherLike,
} from './file-awareness.js'

class FakeWatcher implements AwarenessWatcherLike {
  readonly listeners = new Map<string, Array<(value: never) => void>>()
  closed = false

  on(event: 'add' | 'change' | 'unlink' | 'error', listener: (value: never) => void): unknown {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  emit(event: 'add' | 'change' | 'unlink' | 'error', value: string | Error): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value as never)
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  if (!predicate()) throw new Error('等待条件超时')
}

describe('FileAwarenessService', () => {
  it('首次扫描文档、后台分析、生成受保护的 Markdown 并发出建议', async () => {
    const root = join(tmpdir(), `aurora-awareness-${randomUUID()}`)
    const watched = join(root, 'docs')
    const knowledge = join(root, 'notes')
    const userData = join(root, 'userData')
    await fs.mkdir(watched, { recursive: true })
    const source = join(watched, '高数第三章.docx')
    await fs.writeFile(source, 'fake docx bytes')
    await fs.writeFile(join(watched, '~$高数第三章.docx'), 'office lock')

    const settings = createDefaultSettings()
    settings.fileAwareness = {
      enabled: true,
      contentConsentAccepted: true,
      watchedDirs: [watched],
      knowledgeDir: knowledge,
      includeRecent: false,
      suggestionsEnabled: true,
      dailyAnalysisLimit: 20,
      maxFileMb: 100,
      defaultMemoryTtlDays: 0,
      backgroundModel: { providerId: '', model: '' },
    }
    const watcher = new FakeWatcher()
    const suggestions: string[] = []
    const service = new FileAwarenessService({
      userData,
      settings: () => settings,
      logger: createNoopLogger(),
      createWatcher: () => watcher,
      tickMs: 20,
      extract: async () => ({
        kind: 'document',
        evidence: '文件名：高数第三章.docx\n正文：一元二次方程',
        evidenceChars: 20,
        warnings: [],
        degraded: false,
        sourceHash: 'hash-v1',
      }),
      analyze: async () => {
        return {
          text: JSON.stringify({
            title: '高数第三章',
            summary: '一元二次方程复习资料。',
            topics: ['一元二次方程'],
            keyPoints: ['求根公式'],
            relationships: [],
            changes: [],
            tags: ['数学'],
            suggestion: {
              headline: '可与第二章笔记关联',
              body: '这份资料延续了上一章的方法。',
              confidence: 0.9,
              action: {
                label: '整理关联',
                prompt: '请基于高数第三章的分析，整理与第二章的关联。',
              },
            },
          }),
          usage: {
            promptTokens: 120,
            completionTokens: 20,
            totalTokens: 140,
            cachedTokens: 40,
            rounds: 1,
          },
        }
      },
      providerReady: () => true,
      canNotify: () => true,
      onSuggestion: (item) => suggestions.push(item.id),
      openPath: async () => undefined,
    })

    await service.init()
    await waitFor(() => service.notes().length === 1)
    await service.drain()
    await waitFor(() => service.notes()[0]?.excerpt !== '')

    const note = service.notes()[0]
    expect(note).toBeDefined()
    expect(note!.ext).toBe('docx')
    expect(note!.createdAt).not.toBe('')
    expect(note!.notePath.replaceAll('\\', '/')).toContain('/docx/')
    const content = await fs.readFile(note!.notePath, 'utf8')
    expect(content).toContain('<!-- aurora:generated:start -->')
    expect(content).toContain('一元二次方程复习资料。')
    expect(content).toContain('hash-v1')
    const view = await service.readNote(note!.id)
    expect(view.content).toContain('一元二次方程复习资料。')
    expect(view.truncated).toBe(false)
    await expect(service.readNote('missing-note')).rejects.toThrow('笔记不存在')
    const index = await fs.readFile(join(knowledge, 'INDEX.md'), 'utf8')
    expect(index).toContain('## docx')
    expect(index).toContain('高数第三章')
    expect(suggestions).toHaveLength(1)
    expect(service.suggestion(suggestions[0]!)?.action?.label).toBe('整理关联')
    expect(service.status().todayAnalyzed).toBe(1)
    expect(service.status().visionEnabled).toBe(false)
    expect(service.status().usage).toEqual({
      promptTokens: 120,
      completionTokens: 20,
      totalTokens: 140,
      cachedTokens: 40,
      rounds: 1,
    })

    const expired = service.setNoteExpiry(note!.id, {
      mode: 'at',
      at: '2020-01-01T00:00:00.000Z',
    })
    expect(expired.expired).toBe(true)
    expect(service.notes().some((item) => item.id === note!.id && item.expired)).toBe(true)
    expect(service.agentNotes()).toEqual([])
    expect(service.agentRecords()).toEqual([])
    expect(service.status().expiredNoteCount).toBe(1)
    await expect(service.readAgentNote(note!.id)).rejects.toThrow('不再提供给 Agent')
    await expect(service.readNote(note!.id)).resolves.toMatchObject({ noteId: note!.id })

    expect(service.ignoreSuggestion(suggestions[0]!)).toBe(true)
    await service.flush()
    await service.close()
  })

  it('视觉开启时把内嵌图片作为同一轮分析输入，并清理临时文件', async () => {
    const root = join(tmpdir(), `aurora-awareness-images-${randomUUID()}`)
    const watched = join(root, 'docs')
    const knowledge = join(root, 'notes')
    const userData = join(root, 'userData')
    await fs.mkdir(watched, { recursive: true })
    const source = join(watched, '电路课程.pptx')
    await fs.writeFile(source, 'fake pptx bytes')

    const settings = createDefaultSettings()
    settings.fileAwareness = {
      enabled: true,
      contentConsentAccepted: true,
      watchedDirs: [watched],
      knowledgeDir: knowledge,
      includeRecent: false,
      suggestionsEnabled: false,
      dailyAnalysisLimit: 20,
      maxFileMb: 100,
      defaultMemoryTtlDays: 0,
      backgroundModel: { providerId: '', model: '' },
    }
    const watcher = new FakeWatcher()
    const analyzedImages: string[][] = []
    const imageContents: Buffer[] = []
    const service = new FileAwarenessService({
      userData,
      settings: () => settings,
      logger: createNoopLogger(),
      createWatcher: () => watcher,
      tickMs: 20,
      extract: async () => ({
        kind: 'document',
        evidence: '文件名：电路课程.pptx\n正文：欧姆定律\n内嵌图片：1 张',
        evidenceChars: 30,
        warnings: [],
        degraded: false,
        sourceHash: 'hash-image-v1',
        documentImages: [
          {
            name: '电路图.png',
            mimeType: 'image/png',
            extension: 'png',
            dataBase64: Buffer.from([1, 2, 3, 4]).toString('base64'),
          },
        ],
      }),
      analyze: async (input: AwarenessAnalyzeRequest) => {
        analyzedImages.push([...(input.images ?? [])])
        if (input.images?.[0] !== undefined) {
          imageContents.push(await fs.readFile(input.images[0]))
        }
        return {
          text: JSON.stringify({
            title: '电路课程',
            summary: '包含电路图。',
            topics: [],
            keyPoints: [],
            relationships: [],
            changes: [],
            tags: ['物理'],
            suggestion: null,
          }),
        }
      },
      providerReady: () => true,
      visionReady: () => true,
      canNotify: () => false,
      openPath: async () => undefined,
    })

    await service.init()
    await waitFor(() => service.notes().length === 1)
    await service.drain()

    expect(analyzedImages).toHaveLength(1)
    expect(analyzedImages[0]).toHaveLength(1)
    expect(imageContents[0]?.equals(Buffer.from([1, 2, 3, 4]))).toBe(true)
    expect(service.status().visionEnabled).toBe(true)
    await expect(fs.readFile(analyzedImages[0]![0]!)).rejects.toThrow()
    await service.close()
  })

  it('状态 v2 只回填一次历史用量，重启不重复累计', async () => {
    const root = join(tmpdir(), `aurora-awareness-usage-${randomUUID()}`)
    const userData = join(root, 'userData')
    const settings = createDefaultSettings()
    const first = new FileAwarenessService({
      userData,
      settings: () => settings,
      logger: createNoopLogger(),
      extract: async () => {
        throw new Error('not used')
      },
      analyze: async () => ({ text: '{}' }),
      providerReady: () => true,
      canNotify: () => false,
      initialUsage: async () => ({
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        cachedTokens: 40,
        rounds: 1,
      }),
    })
    await first.init()
    expect(first.status().usage?.totalTokens).toBe(120)
    await first.flush()
    await first.close()

    const second = new FileAwarenessService({
      userData,
      settings: () => settings,
      logger: createNoopLogger(),
      extract: async () => {
        throw new Error('not used')
      },
      analyze: async () => ({ text: '{}' }),
      providerReady: () => true,
      canNotify: () => false,
      initialUsage: async () => ({
        promptTokens: 900,
        completionTokens: 100,
        totalTokens: 1_000,
        cachedTokens: 0,
        rounds: 9,
      }),
    })
    await second.init()
    expect(second.status().usage?.totalTokens).toBe(120)
    await second.close()
  })

  it('扫描图片与常见文档，legacy Office 只记录不分析', async () => {
    const root = join(tmpdir(), `aurora-awareness-formats-${randomUUID()}`)
    const watched = join(root, 'files')
    const knowledge = join(root, 'notes')
    const userData = join(root, 'userData')
    await fs.mkdir(watched, { recursive: true })
    const png = Buffer.alloc(24)
    png.writeUInt32BE(0x89504e47, 0)
    png.writeUInt32BE(16, 16)
    png.writeUInt32BE(16, 20)
    await fs.writeFile(join(watched, '示意图.png'), png)
    await fs.writeFile(join(watched, '讲义.pdf'), 'fake pdf')
    await fs.writeFile(join(watched, '说明.txt'), '一段说明文字')
    await fs.writeFile(join(watched, '旧资料.doc'), 'legacy')

    const settings = createDefaultSettings()
    settings.fileAwareness = {
      enabled: true,
      contentConsentAccepted: true,
      watchedDirs: [watched],
      knowledgeDir: knowledge,
      includeRecent: false,
      suggestionsEnabled: false,
      dailyAnalysisLimit: 20,
      maxFileMb: 100,
      defaultMemoryTtlDays: 0,
      backgroundModel: { providerId: '', model: '' },
    }
    const seenExts: string[] = []
    const service = new FileAwarenessService({
      userData,
      settings: () => settings,
      logger: createNoopLogger(),
      createWatcher: () => new FakeWatcher(),
      tickMs: 20,
      extract: async (input) => {
        seenExts.push(input.ext)
        return {
          kind: input.ext === 'png' ? 'image' : 'document',
          evidence: `结构化证据：${input.ext}`,
          evidenceChars: 20,
          warnings: [],
          degraded: false,
          sourceHash: `hash-${input.ext}`,
          ...(input.ext !== 'png' || !input.includeImages
            ? {}
            : {
                documentImages: [
                  {
                    name: '示意图.png',
                    mimeType: 'image/png',
                    extension: 'png',
                    dataBase64: png.toString('base64'),
                  },
                ],
              }),
        }
      },
      analyze: async () => ({
        text: JSON.stringify({
          title: '感知笔记',
          summary: '完成结构化分析。',
          topics: [],
          keyPoints: [],
          relationships: [],
          changes: [],
          tags: [],
          suggestion: null,
        }),
      }),
      providerReady: () => true,
      visionReady: () => true,
      canNotify: () => false,
      openPath: async () => undefined,
    })

    await service.init()
    await waitFor(() => service.notes().length === 3)
    await service.drain()
    expect(new Set(seenExts)).toEqual(new Set(['png', 'pdf', 'txt']))
    expect(
      service
        .notes()
        .map((note) => note.ext)
        .sort(),
    ).toEqual(['pdf', 'png', 'txt'])
    expect(service.records().some((record) => record.ext === 'doc')).toBe(true)
    expect(service.notes().some((note) => note.ext === 'doc')).toBe(false)
    await service.close()
  })
})
