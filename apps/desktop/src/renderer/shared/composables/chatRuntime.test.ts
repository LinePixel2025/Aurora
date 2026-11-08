import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@aurora/shared'
import {
  activityTone,
  applyActivityEvent,
  applyChatEvent,
  applyStreamDelta,
  createSessionActivity,
  createSessionRuntime,
  evictRuntimeIds,
  isHiddenSessionId,
  markActivityViewed,
  matchUserMessageEcho,
  mergeHydratedMessages,
  seedActivityRunning,
  USER_MESSAGE_ECHO_WINDOW_MS,
  type ChatEventContext,
  type ChatMessage,
  type ChatSessionRuntime,
} from './chatRuntime.js'

/**
 * 会话级运行态 / 活动态的纯逻辑回归（2026-11-07，docs/06 §4.3）。
 *
 * 这些用例就是「多会话并行时展示不串味」的最小证明：两个 runtime 交错喂事件，各自的消息、
 * 流式态、在途请求、未读态互不影响；切走再切回靠的是运行态不被清空，而不是重新猜。
 */

let seq = 0
function nextSeq(): number {
  seq += 1
  return seq
}

function context(overrides: Partial<ChatEventContext> = {}): ChatEventContext {
  return {
    currentSessionId: 'a',
    countedUsage: new Set<string>(),
    jobOrigin: 'chat',
    now: () => 1_700_000_000_000,
    ...overrides,
  }
}

function userMessage(sessionId: string, requestId: string, content: string): AgentEvent {
  return {
    type: 'user-message',
    sessionId,
    requestId,
    seq: nextSeq(),
    content,
    createdAt: 1_700_000_000_000,
  }
}

function textEvent(
  sessionId: string,
  requestId: string,
  messageId: string,
  delta: string,
): AgentEvent {
  return { type: 'text', sessionId, requestId, seq: nextSeq(), round: 0, messageId, delta }
}

function reasoningEvent(
  sessionId: string,
  requestId: string,
  messageId: string,
  delta: string,
): AgentEvent {
  return { type: 'reasoning', sessionId, requestId, seq: nextSeq(), round: 0, messageId, delta }
}

function doneEvent(sessionId: string, requestId: string): AgentEvent {
  return { type: 'done', sessionId, requestId, seq: nextSeq() }
}

function errorEvent(sessionId: string, requestId: string, code = 'E_UNKNOWN'): AgentEvent {
  return { type: 'error', sessionId, requestId, seq: nextSeq(), code, message: '失败' }
}

/** 按真实链路「先 applyChatEvent（补在途 / 流式态）→ 只有被接受才入缓冲」 */
function pushDelta(
  rt: ChatSessionRuntime,
  event: AgentEvent,
  ctx: ChatEventContext,
  kind: 'text' | 'reasoning',
): void {
  const effect = applyChatEvent(rt, event, ctx)
  if (!effect.accepted) return
  if (event.type !== 'text' && event.type !== 'reasoning') return
  applyStreamDelta(rt, {
    kind,
    sessionId: event.sessionId,
    messageId: event.messageId,
    requestId: event.requestId,
    seq: event.seq,
    delta: event.delta,
  })
}

function assistantOf(rt: ChatSessionRuntime, messageId: string): ChatMessage | undefined {
  return rt.messages.find((message) => message.id === messageId)
}

describe('会话级运行态：事件归属与流式隔离', () => {
  it('两个会话交错流式：正文 / 思考 / 在途请求互不污染，A 的 done 不影响 B', () => {
    const a = createSessionRuntime('a')
    const b = createSessionRuntime('b')
    const ctx = context()

    applyChatEvent(a, userMessage('a', 'req-a', '问题 A'), ctx)
    applyChatEvent(b, userMessage('b', 'req-b', '问题 B'), ctx)

    pushDelta(a, textEvent('a', 'req-a', 'msg-a', 'A 的正文 '), ctx, 'text')
    pushDelta(b, textEvent('b', 'req-b', 'msg-b', 'B 的正文 '), ctx, 'text')
    pushDelta(a, reasoningEvent('a', 'req-a', 'msg-a', 'A 的思考'), ctx, 'reasoning')
    pushDelta(b, textEvent('b', 'req-b', 'msg-b', '第二段'), ctx, 'text')
    pushDelta(a, textEvent('a', 'req-a', 'msg-a', '结束'), ctx, 'text')

    expect(assistantOf(a, 'msg-a')?.content).toBe('A 的正文 结束')
    expect(assistantOf(a, 'msg-a')?.reasoning).toBe('A 的思考')
    expect(assistantOf(b, 'msg-b')?.content).toBe('B 的正文 第二段')
    expect(assistantOf(b, 'msg-b')?.reasoning).toBeUndefined()
    expect(a.messages.some((message) => message.content === '问题 B')).toBe(false)
    expect(b.messages.some((message) => message.content === '问题 A')).toBe(false)
    expect(a.streaming).toBe(true)
    expect(b.streaming).toBe(true)

    applyChatEvent(a, doneEvent('a', 'req-a'), ctx)
    expect(a.streaming).toBe(false)
    expect(a.activeRequest).toBeNull()
    // B 的流式状态与在途请求不受 A 收尾影响
    expect(b.streaming).toBe(true)
    expect(b.activeRequest).toBe('req-b')
  })

  it('非当前会话的 done 只写本会话的收尾态，不碰当前会话的 unread / error', () => {
    const a = createSessionRuntime('a')
    const b = createSessionRuntime('b')
    const ctx = context({ currentSessionId: 'a' })
    applyChatEvent(b, userMessage('b', 'req-b', '后台问题'), ctx)
    pushDelta(b, textEvent('b', 'req-b', 'msg-b', '后台正文'), ctx, 'text')
    applyChatEvent(b, doneEvent('b', 'req-b'), ctx)

    expect(b.unread).toBe(true)
    expect(b.streaming).toBe(false)
    expect(a.unread).toBe(false)
    expect(a.error).toBeNull()
  })

  it('远端请求没有本地 send() 也不会丢：事件补 activeRequest，done 后清理', () => {
    const rt = createSessionRuntime('remote')
    const ctx = context({ currentSessionId: 'a' })
    applyChatEvent(rt, textEvent('remote', 'req-remote', 'msg-r', '远端正文'), ctx)
    expect(rt.activeRequest).toBe('req-remote')
    expect(rt.lastRequestId).toBe('req-remote')
    expect(rt.streaming).toBe(true)
    applyChatEvent(rt, doneEvent('remote', 'req-remote'), ctx)
    expect(rt.activeRequest).toBeNull()
    expect(rt.streaming).toBe(false)
  })

  it('同一会话已结束请求的迟到增量被丢弃；切会话（换 current）不影响该记忆', () => {
    const rt = createSessionRuntime('a')
    const ctx = context()
    applyChatEvent(rt, userMessage('a', 'req-a', '问题'), ctx)
    pushDelta(rt, textEvent('a', 'req-a', 'msg-a', '完整回答'), ctx, 'text')
    applyChatEvent(rt, doneEvent('a', 'req-a'), ctx)
    const before = rt.messages.length

    // 换到别的会话再切回来，运行态不重建（调用方只改 currentSessionId）
    applyChatEvent(rt, doneEvent('a', 'req-a'), context({ currentSessionId: 'b' }))
    pushDelta(rt, textEvent('a', 'req-a', 'msg-a', '迟到增量'), context(), 'text')

    expect(rt.messages.length).toBe(before)
    expect(assistantOf(rt, 'msg-a')?.content).toBe('完整回答')
  })

  it('按 seq 插入：新回复落在对应的用户气泡之后，不越过无 seq 的本地气泡', () => {
    const rt = createSessionRuntime('a')
    const ctx = context()
    // 本地发送的临时气泡（无 seq）：此后的事件不能越过它往前插
    rt.messages.push({ id: 'u-local', role: 'user', content: '本地问题', createdAt: 1 })
    applyChatEvent(rt, userMessage('a', 'req-a', '下一问'), ctx)
    pushDelta(rt, textEvent('a', 'req-a', 'msg-a', '回答'), ctx, 'text')

    expect(rt.messages.map((message) => message.id)).toEqual(['u-local', 'u-evt-req-a', 'msg-a'])
  })

  it('user-message 回声只对账本会话的临时气泡（同文本跨会话不互相命中）', () => {
    const a = createSessionRuntime('a')
    const b = createSessionRuntime('b')
    const now = 1_700_000_000_000
    a.messages.push({ id: 'u-local-a', role: 'user', content: '继续', createdAt: now })
    b.messages.push({ id: 'u-local-b', role: 'user', content: '继续', createdAt: now })

    applyChatEvent(a, userMessage('a', 'req-a', '继续'), context())
    expect(a.messages[0]?.seq).toBeDefined()
    expect(a.messages[0]?.id).toBe('u-local-a')
    expect(b.messages[0]?.seq).toBeUndefined()
    expect(b.messages[0]?.id).toBe('u-local-b')
  })
})

describe('历史水合合并（切会话 / 收尾自愈共用）', () => {
  it('同 id 取更长内容 + 保留本地流式状态，本地在途消息不丢、同文 user 气泡不重复', () => {
    const server: ChatMessage[] = [
      { id: 'u-1', role: 'user', content: '问题', createdAt: 1 },
      { id: 'm-1', role: 'assistant', content: '磁盘上的半段', createdAt: 2 },
    ]
    const local: ChatMessage[] = [
      { id: 'm-1', role: 'assistant', content: '本地更长的完整回答', pending: true, createdAt: 2 },
      { id: 'm-2', role: 'assistant', content: '进行中', seq: 9, requestId: 'req-1', createdAt: 3 },
      { id: 'u-local', role: 'user', content: '问题', createdAt: 4 },
    ]
    const merged = mergeHydratedMessages(server, local)
    expect(merged.map((message) => message.id)).toEqual(['u-1', 'm-1', 'm-2'])
    expect(merged[1]?.content).toBe('本地更长的完整回答')
    expect(merged[1]?.pending).toBe(true)
    expect(merged.some((message) => message.id === 'u-local')).toBe(false)
  })
})

describe('活动态：running / unread / error 与兜底种子', () => {
  it('后台会话收尾 → 未读；切到该会话清掉', () => {
    const activity = createSessionActivity()
    const ctx = { currentSessionId: 'a', now: () => 1 }
    applyActivityEvent(activity, userMessage('b', 'req-b', '后台问题'), ctx)
    expect(activity.running).toBe(true)
    expect(activityTone(activity)).toBe('running')

    applyActivityEvent(activity, doneEvent('b', 'req-b'), ctx)
    expect(activity.running).toBe(false)
    expect(activityTone(activity)).toBe('unread')
    markActivityViewed(activity)
    expect(activityTone(activity)).toBeUndefined()
  })

  it('当前会话收尾不亮未读；失败后台会话亮 error', () => {
    const current = createSessionActivity()
    applyActivityEvent(current, userMessage('a', 'req-a', '问题'), {
      currentSessionId: 'a',
      now: () => 1,
    })
    applyActivityEvent(current, doneEvent('a', 'req-a'), { currentSessionId: 'a', now: () => 1 })
    expect(current.running).toBe(false)
    expect(current.unread).toBe(false)
    expect(activityTone(current)).toBeUndefined()

    const failed = createSessionActivity()
    applyActivityEvent(failed, userMessage('b', 'req-b', '问题'), {
      currentSessionId: 'a',
      now: () => 1,
    })
    applyActivityEvent(failed, errorEvent('b', 'req-b'), { currentSessionId: 'a', now: () => 1 })
    expect(activityTone(failed)).toBe('error')
  })

  it('排队 / 续跑被拒（E_BUSY / E_QUEUE_FULL）不算会话失败、不亮未读', () => {
    const activity = createSessionActivity()
    const ctx = { currentSessionId: 'a', now: () => 1 }
    applyActivityEvent(activity, userMessage('b', 'req-run', '正在跑'), ctx)
    applyActivityEvent(
      activity,
      { type: 'queued', sessionId: 'b', requestId: 'req-x', seq: 1 },
      ctx,
    )
    applyActivityEvent(activity, errorEvent('b', 'req-x', 'E_QUEUE_FULL'), ctx)
    expect(activity.running).toBe(true)
    expect(activity.unread).toBe(false)
    expect(activity.attention).toBeNull()
  })

  it('chat:sessions.running 种子：窗口创建前就开跑时也能显示进行中', () => {
    const activity = createSessionActivity()
    seedActivityRunning(activity, 1)
    expect(activity.running).toBe(true)
    expect(activityTone(activity)).toBe('running')
  })
})

describe('隐藏会话与 LRU 淘汰', () => {
  it('auto- / awareness- / -sub 不在 chat 里累积，普通会话不受影响', () => {
    expect(isHiddenSessionId('auto-123')).toBe(true)
    expect(isHiddenSessionId('auto')).toBe(true)
    expect(isHiddenSessionId('awareness-x')).toBe(true)
    expect(isHiddenSessionId('quick-sub')).toBe(true)
    expect(isHiddenSessionId('chat-1')).toBe(false)
    expect(isHiddenSessionId('center-1')).toBe(false)
  })

  it('LRU 只淘汰非当前 / 非流式 / 无暂停提示的最旧会话', () => {
    const entries: Array<[string, ChatSessionRuntime]> = []
    for (let index = 0; index < 10; index += 1) {
      const rt = createSessionRuntime(`r${index}`, index)
      entries.push([`r${index}`, rt])
    }
    // 当前 / 流式 / 有暂停提示的都不许淘汰
    entries[1]![1].streaming = true
    entries[2]![1].pendingNotice = '已达到轮次上限，已暂停'
    const ids = evictRuntimeIds(entries, 'r0', 8)
    expect(ids).toEqual(['r3', 'r4'])
    expect(ids).not.toContain('r0')
    expect(ids).not.toContain('r1')
    expect(ids).not.toContain('r2')
  })
})

describe('matchUserMessageEcho（从 useChat 迁入后保持原有语义）', () => {
  it('带 seq 的已确认气泡跳过；同文本重发命中最近一条临时气泡', () => {
    const confirmed: ChatMessage = {
      id: 'u-evt-1',
      role: 'user',
      content: '继续',
      createdAt: 1_700_000_000_000,
      seq: 7,
    }
    const local: ChatMessage = {
      id: 'u-local',
      role: 'user',
      content: '继续',
      createdAt: 1_700_000_005_000,
    }
    expect(matchUserMessageEcho([confirmed], '继续', 1_700_000_005_000)).toBe(-1)
    expect(matchUserMessageEcho([confirmed, local], '继续', 1_700_000_005_000)).toBe(1)
    expect(
      matchUserMessageEcho([local], '继续', 1_700_000_005_000 + USER_MESSAGE_ECHO_WINDOW_MS + 1),
    ).toBe(-1)
  })
})
