import { describe, expect, it, vi } from 'vitest'
import { createAskRelay } from './ask-relay.js'
import type { AskUserRequest } from '@aurora/shared'

const request: AskUserRequest = {
  requestId: 'ask-1',
  sessionId: 'center-abc',
  question: '产物放哪个目录？',
  header: '目标目录',
  options: [{ label: 'dist' }],
  multiSelect: false,
  expiresAt: 1_800_000_000_000,
}

interface Harness {
  relay: (input: AskUserRequest) => void
  emitted: unknown[]
  queued: unknown[]
  setOnline(online: boolean): void
  setAllowed(allowed: boolean): void
  warn: ReturnType<typeof vi.fn>
  /** 让 emit 抛错（模拟 socket 已失效但 close 尚未触发的窗口） */
  setThrowOnEmit(throws: boolean): void
}

function makeHarness(): Harness {
  let online = true
  let allowed = true
  let throws = false
  const emitted: unknown[] = []
  const queued: unknown[] = []
  const warn = vi.fn()
  const relay = createAskRelay({
    emit: () =>
      online
        ? (message: unknown) => {
            if (throws) throw new Error('socket closed')
            emitted.push(message)
          }
        : undefined,
    allowRemoteSession: () => allowed,
    enqueue: (message) => queued.push(message),
    logger: { warn },
  })
  return {
    relay,
    emitted,
    queued,
    setOnline: (value) => {
      online = value
    },
    setAllowed: (value) => {
      allowed = value
    },
    setThrowOnEmit: (value) => {
      throws = value
    },
    warn,
  }
}

describe('createAskRelay · 提问卡上行（docs/12 §5）', () => {
  it('center- 会话：上行 toAskRequest 的形状（expiresAt 保持毫秒数）', () => {
    const harness = makeHarness()
    harness.relay(request)
    expect(harness.emitted).toEqual([
      {
        type: 'ask.request',
        request: {
          requestId: 'ask-1',
          sessionId: 'center-abc',
          question: '产物放哪个目录？',
          header: '目标目录',
          options: [{ label: 'dist' }],
          multiSelect: false,
          expiresAt: 1_800_000_000_000,
        },
      },
    ])
    expect(harness.queued).toHaveLength(0)
  })

  it('本地（非 center-）会话的提问**绝不出网**，也不入队', () => {
    const harness = makeHarness()
    harness.relay({ ...request, sessionId: 'quick' })
    harness.relay({ ...request, sessionId: 's-1727' })
    expect(harness.emitted).toHaveLength(0)
    expect(harness.queued).toHaveLength(0)
  })

  it('center.allowRemoteSession 关闭：整条静默（不下行、也不入队）', () => {
    const harness = makeHarness()
    harness.setAllowed(false)
    harness.relay(request)
    expect(harness.emitted).toHaveLength(0)
    expect(harness.queued).toHaveLength(0)
  })

  it('连接器离线：入补发队列一次（不是丢弃，也不是重复入队）', () => {
    const harness = makeHarness()
    harness.setOnline(false)
    harness.relay(request)
    expect(harness.emitted).toHaveLength(0)
    expect(harness.queued).toHaveLength(1)
  })

  it('发送抛错（socket 失效窗口）：记日志并入队，绝不把异常泼回提问链路', () => {
    const harness = makeHarness()
    harness.setThrowOnEmit(true)
    expect(() => harness.relay(request)).not.toThrow()
    expect(harness.queued).toHaveLength(1)
    expect(harness.warn).toHaveBeenCalledWith(
      '向 Center 发送提问请求失败',
      expect.objectContaining({ error: 'Error: socket closed' }),
    )
  })

  it('闸门与在线状态按调用时刻现取（设置热改立即生效，不缓存）', () => {
    const harness = makeHarness()
    harness.setAllowed(false)
    harness.relay(request)
    harness.setAllowed(true)
    harness.relay(request)
    harness.setOnline(false)
    harness.relay({ ...request, requestId: 'ask-2' })
    expect(harness.emitted).toHaveLength(1)
    expect(harness.queued).toHaveLength(1)
  })
})
