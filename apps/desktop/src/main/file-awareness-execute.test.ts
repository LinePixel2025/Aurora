import { describe, expect, it, vi } from 'vitest'
import type { FileAwarenessSuggestion } from '@aurora/shared'
import { executeFileAwarenessSuggestion } from './file-awareness-execute.js'

const SUGGESTION: FileAwarenessSuggestion = {
  id: 's-1',
  noteId: 'n-1',
  sourcePath: 'D:\\Docs\\课程.pptx',
  sourceHash: 'hash-1',
  headline: '可以继续整理',
  body: '建议把讲义整理成待办。',
  createdAt: '2026-10-04T08:00:00.000Z',
  confidence: 0.9,
  action: {
    label: '整理待办',
    prompt: '请把课程讲义整理成待办清单。',
  },
}

describe('executeFileAwarenessSuggestion', () => {
  it('先建会话并激活，再把 action.prompt 作为首条消息发送', async () => {
    const calls: string[] = []
    const send = vi.fn(async (input: { sessionId: string; text: string; extraContext: string }) => {
      calls.push(`send:${input.sessionId}`)
      expect(input.text).toContain('整理成待办清单')
      expect(input.extraContext).toContain('D:\\Docs\\课程.pptx')
    })
    const result = await executeFileAwarenessSuggestion('s-1', {
      suggestion: (id) => (id === SUGGESTION.id ? SUGGESTION : undefined),
      createSession: async () => {
        calls.push('create')
        return 'chat-new-1'
      },
      persistSession: async (sessionId) => {
        calls.push(`persist:${sessionId}`)
      },
      presentSession: (sessionId) => calls.push(`present:${sessionId}`),
      send,
      removeSession: async () => undefined,
    })

    expect(result).toEqual({ ok: true, value: { sessionId: 'chat-new-1' } })
    expect(calls).toEqual(['create', 'persist:chat-new-1', 'present:chat-new-1', 'send:chat-new-1'])
    expect(send).toHaveBeenCalledOnce()
  })

  it('建议不存在或没有 action 时拒绝，不创建空会话', async () => {
    const createSession = vi.fn(async () => 'chat-new-1')
    const common = {
      createSession,
      persistSession: vi.fn(async () => undefined),
      presentSession: vi.fn(),
      send: vi.fn(async () => undefined),
      removeSession: vi.fn(async () => undefined),
    }

    await expect(
      executeFileAwarenessSuggestion('missing', { ...common, suggestion: () => undefined }),
    ).resolves.toMatchObject({ ok: false, code: 'E_NOT_FOUND' })
    await expect(
      executeFileAwarenessSuggestion('s-no-action', {
        ...common,
        suggestion: () => ({ ...SUGGESTION, id: 's-no-action', action: undefined }),
      }),
    ).resolves.toMatchObject({ ok: false, code: 'E_INVALID_STATE' })
    expect(createSession).not.toHaveBeenCalled()
  })

  it('发送失败时回收刚建的空会话', async () => {
    const removeSession = vi.fn(async () => undefined)
    const result = await executeFileAwarenessSuggestion('s-1', {
      suggestion: () => SUGGESTION,
      createSession: async () => 'chat-new-1',
      persistSession: async () => undefined,
      presentSession: () => undefined,
      send: async () => {
        throw new Error('provider unavailable')
      },
      removeSession,
    })

    expect(result).toMatchObject({ ok: false, code: 'E_UNKNOWN' })
    expect(removeSession).toHaveBeenCalledWith('chat-new-1')
  })
})
