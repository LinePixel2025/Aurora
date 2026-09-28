/**
 * `ask_user` 装配层服务的单测（docs/06 §21）。
 *
 * 这个服务的唯一硬要求是**一定返回**：内核在 `await` 它，任何一条路径不落结论
 * 都会把一次请求挂死。因此四条出口（回答 / 超时 / 中止 / 端口异常）全部有用例。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAskUserService } from './ask-user.js'
import type { AskUserRequest } from '@aurora/shared'
import { createNoopLogger } from '@aurora/shared'

const QUESTION = {
  question: '归档到哪个目录？',
  header: '目标目录',
  options: [{ label: '科目资料文件夹' }, { label: '桌面' }],
  multiSelect: false,
}

function makeService(options?: { timeoutMs?: number }): {
  service: ReturnType<typeof createAskUserService>
  pushed: AskUserRequest[]
  present: ReturnType<typeof vi.fn>
} {
  const pushed: AskUserRequest[] = []
  const present = vi.fn()
  const service = createAskUserService({
    logger: createNoopLogger(),
    present,
    ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  service.onRequest((request) => pushed.push(request))
  return { service, pushed, present }
}

describe('createAskUserService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ask 推卡片 + 亮窗口，回执后返回用户的选择', async () => {
    const { service, pushed, present } = makeService()
    const promise = service.ask(QUESTION, { sessionId: 'main', toolCallId: 'call-1' })

    expect(pushed).toHaveLength(1)
    expect(pushed[0]).toMatchObject({
      sessionId: 'main',
      question: QUESTION.question,
      header: '目标目录',
      multiSelect: false,
    })
    expect(pushed[0]?.options).toHaveLength(2)
    expect(present).toHaveBeenCalledTimes(1)
    expect(service.pendingCount()).toBe(1)

    expect(service.resolve({ requestId: pushed[0]!.requestId, answers: ['桌面'] })).toBe(true)
    await expect(promise).resolves.toEqual({ answers: ['桌面'] })
    expect(service.pendingCount()).toBe(0)
  })

  it('超时按「未回答」结算（不是拒绝、也不是挂起）', async () => {
    const { service, pushed } = makeService({ timeoutMs: 1000 })
    const promise = service.ask(QUESTION, { sessionId: 'main' })

    await vi.advanceTimersByTimeAsync(1001)
    await expect(promise).resolves.toEqual({ answers: [], timedOut: true })
    expect(service.pendingCount()).toBe(0)
    // 超时后再来的回执是幂等的 false（卡片可能还在发最后一份回执）
    expect(service.resolve({ requestId: pushed[0]!.requestId, answers: ['桌面'] })).toBe(false)
  })

  it('中止信号 → 立刻结算 aborted，且不留下定时器', async () => {
    const controller = new AbortController()
    const { service } = makeService({ timeoutMs: 60_000 })
    const promise = service.ask(QUESTION, { sessionId: 'main', signal: controller.signal })

    controller.abort()
    await expect(promise).resolves.toEqual({ answers: [], aborted: true })
    expect(service.pendingCount()).toBe(0)
    // 定时器已清：推进到超时点也不会有第二次结算（否则会重复 resolve）
    await vi.advanceTimersByTimeAsync(60_001)
    expect(service.pendingCount()).toBe(0)
  })

  it('进来就已中止的信号 → 不推卡片、直接结算', async () => {
    const controller = new AbortController()
    controller.abort()
    const { service, pushed, present } = makeService()
    const answer = await service.ask(QUESTION, { sessionId: 'main', signal: controller.signal })
    expect(answer).toEqual({ answers: [], aborted: true })
    expect(pushed).toHaveLength(0)
    expect(present).not.toHaveBeenCalled()
  })

  it('未知 requestId 的回执返回 false（不抛错、不影响在途提问）', async () => {
    const { service, pushed } = makeService()
    const promise = service.ask(QUESTION, { sessionId: 'main' })
    expect(service.resolve({ requestId: 'ask-nope', answers: ['x'] })).toBe(false)
    expect(service.pendingCount()).toBe(1)
    service.resolve({ requestId: pushed[0]!.requestId, answers: ['桌面'] })
    await promise
  })

  it('空回答按跳过处理；显式 skipped 同样落 skipped', async () => {
    const { service, pushed } = makeService()
    const first = service.ask(QUESTION, { sessionId: 'main' })
    service.resolve({ requestId: pushed[0]!.requestId, answers: ['   '] })
    await expect(first).resolves.toEqual({ answers: [], skipped: true })

    const second = service.ask(QUESTION, { sessionId: 'main' })
    service.resolve({ requestId: pushed[1]!.requestId, answers: ['桌面'], skipped: true })
    await expect(second).resolves.toEqual({ answers: ['桌面'], skipped: true })
  })

  it('解除订阅后不再收到推送（ipc 拆除时的路径）', async () => {
    const pushed: AskUserRequest[] = []
    const service = createAskUserService({
      logger: createNoopLogger(),
      present: () => undefined,
    })
    const off = service.onRequest((request) => pushed.push(request))
    off()
    const promise = service.ask(QUESTION, { sessionId: 'main' })
    expect(pushed).toHaveLength(0)
    expect(service.pendingCount()).toBe(1)
    // 仍要靠超时兜底返回（没有回执通道时的最后一根安全绳）
    vi.advanceTimersByTime(180_000)
    await expect(promise).resolves.toMatchObject({ timedOut: true })
  })

  it('单个订阅者抛错不影响其它订阅者与提问本身', async () => {
    const seen: string[] = []
    const service = createAskUserService({
      logger: createNoopLogger(),
      present: () => undefined,
      timeoutMs: 500,
    })
    service.onRequest(() => {
      throw new Error('订阅者炸了')
    })
    service.onRequest((request) => seen.push(request.requestId))
    const promise = service.ask(QUESTION, { sessionId: 'main' })
    expect(seen).toHaveLength(1)
    vi.advanceTimersByTime(600)
    await expect(promise).resolves.toMatchObject({ timedOut: true })
  })
})
