import { describe, expect, it, vi } from 'vitest'
import { createMemoryLogger } from '@aurora/shared'
import type {
  AgentProviderFactory,
  ChatEvent,
  ChatRequest,
  ProviderConfig,
  StoredMessage,
} from '@aurora/agent-core'
import {
  SessionTitleService,
  buildTitleSource,
  isAutoTitleSession,
  normalizeGeneratedTitle,
  type SessionTitleState,
  type SessionTitleStore,
} from './session-title.js'

class FakeTitleStore implements SessionTitleStore {
  readonly messages: StoredMessage[] = []
  title: string | undefined
  pending = false
  setTitleCalls = 0

  async titleStateOf(): Promise<SessionTitleState> {
    return {
      ...(this.title === undefined ? {} : { title: this.title }),
      pending: this.pending,
    }
  }

  async markTitlePending(): Promise<boolean> {
    if (this.title !== undefined) return false
    this.pending = true
    return true
  }

  async setTitle(_sessionId: string, title: string): Promise<boolean> {
    this.setTitleCalls += 1
    this.title = title
    this.pending = false
    return true
  }

  async get(): Promise<StoredMessage[]> {
    return [...this.messages]
  }
}

function textProvider(
  replies: string[],
  onRequest?: (request: ChatRequest, sessionId: string | undefined) => void,
): AgentProviderFactory {
  let call = 0
  return {
    create: (options): ProviderConfig | undefined => {
      const reply = replies[Math.min(call, replies.length - 1)] ?? ''
      call += 1
      return {
        model: 'title-model',
        provider: {
          id: 'title-provider',
          chat: (request): AsyncIterable<ChatEvent> => ({
            async *[Symbol.asyncIterator]() {
              onRequest?.(request, options?.sessionId)
              yield { type: 'text', delta: reply }
              yield { type: 'done', finishReason: 'stop' }
            },
          }),
        },
      }
    },
  }
}

describe('session-title 纯函数', () => {
  it('可见会话判定排除后台会话', () => {
    for (const id of ['main', 'quick', 'chat-1', 'center-1', 'project-1']) {
      expect(isAutoTitleSession(id)).toBe(true)
    }
    for (const id of ['awareness-note', 'auto-run-1', 'chat-1-sub']) {
      expect(isAutoTitleSession(id)).toBe(false)
    }
  })

  it('纯附件使用文件名，不把路径整段送进标题提示词', () => {
    expect(buildTitleSource('', ['D:\\资料\\高数复习.pdf'])).toBe('高数复习.pdf')
  })

  it('标题清洗只保留单行任务名，超长输出直接失败', () => {
    expect(normalizeGeneratedTitle('标题：整理高数错题。')).toBe('整理高数错题')
    expect(normalizeGeneratedTitle('AURORA_SESSION_TITLE\n「修复登录接口」')).toBe(
      '修复登录接口',
    )
    expect(normalizeGeneratedTitle('这是一段很长的标题'.repeat(5))).toBeUndefined()
    expect(normalizeGeneratedTitle('\n\n')).toBeUndefined()
  })
})

describe('SessionTitleService', () => {
  it('首条需求异步生成标题并使用会话级模型选择', async () => {
    const store = new FakeTitleStore()
    const onTitle = vi.fn()
    const requests: Array<{ prompt: string; sessionId: string | undefined }> = []
    const service = new SessionTitleService({
      sessions: store,
      provider: textProvider(['整理高数错题'], (request, sessionId) => {
        requests.push({ prompt: request.messages[0]?.content ?? '', sessionId })
      }),
      logger: createMemoryLogger(),
      onTitle,
    })

    await expect(service.generate('chat-1', '帮我整理高数第三章的错题')).resolves.toBe(true)
    expect(store.title).toBe('整理高数错题')
    expect(store.pending).toBe(false)
    expect(requests).toEqual([
      {
        prompt: expect.stringContaining('帮我整理高数第三章的错题'),
        sessionId: 'chat-1',
      },
    ])
    expect(onTitle).toHaveBeenCalledWith({ sessionId: 'chat-1', title: '整理高数错题' })
  })

  it('失败保留 pending，后续发送用首条用户消息重试', async () => {
    const store = new FakeTitleStore()
    store.messages.push({
      id: 'u-1',
      role: 'user',
      content: '修复登录接口的鉴权问题',
      createdAt: '2026-10-05T00:00:00.000Z',
    })
    const service = new SessionTitleService({
      sessions: store,
      provider: textProvider(['这是一个明显超过二十四个字符的无效标题输出内容'.repeat(2), '修复登录鉴权']),
      logger: createMemoryLogger(),
    })

    await expect(service.generate('chat-1', '修复登录接口')).resolves.toBe(false)
    expect(store.pending).toBe(true)
    await expect(service.generate('chat-1')).resolves.toBe(true)
    expect(store.title).toBe('修复登录鉴权')
  })

  it('同会话并发只发一个标题请求', async () => {
    const store = new FakeTitleStore()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const provider: AgentProviderFactory = {
      create: () => ({
        model: 'm',
        provider: {
          id: 'p',
          chat: (): AsyncIterable<ChatEvent> => ({
            async *[Symbol.asyncIterator]() {
              await gate
              yield { type: 'text', delta: '整理高数错题' }
              yield { type: 'done', finishReason: 'stop' }
            },
          }),
        },
      }),
    }
    const service = new SessionTitleService({ sessions: store, provider })

    const first = service.generate('chat-1', '整理错题')
    await expect(service.generate('chat-1', '整理错题')).resolves.toBe(false)
    release()
    await expect(first).resolves.toBe(true)
  })

  it('后台隐藏会话不调用模型', async () => {
    const store = new FakeTitleStore()
    const create = vi.fn()
    const service = new SessionTitleService({
      sessions: store,
      provider: { create },
    })
    await expect(service.generate('awareness-note', '分析文件')).resolves.toBe(false)
    expect(create).not.toHaveBeenCalled()
  })
})
