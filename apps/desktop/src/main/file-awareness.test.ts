import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createDefaultSettings, createNoopLogger } from '@aurora/shared'
import { FileAwarenessService, type AwarenessWatcherLike } from './file-awareness.js'

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
        return JSON.stringify({
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
          },
        })
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
    expect(note!.notePath.replaceAll('\\', '/')).toContain('/docx/')
    const content = await fs.readFile(note!.notePath, 'utf8')
    expect(content).toContain('<!-- aurora:generated:start -->')
    expect(content).toContain('一元二次方程复习资料。')
    expect(content).toContain('hash-v1')
    const index = await fs.readFile(join(knowledge, 'INDEX.md'), 'utf8')
    expect(index).toContain('## docx')
    expect(index).toContain('高数第三章')
    expect(suggestions).toHaveLength(1)
    expect(service.status().todayAnalyzed).toBe(1)

    expect(service.ignoreSuggestion(suggestions[0]!)).toBe(true)
    await service.flush()
    await service.close()
  })
})
