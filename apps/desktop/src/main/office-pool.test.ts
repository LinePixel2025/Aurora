import { describe, expect, it, vi } from 'vitest'
import { OfficePool, type OfficeChildLike } from './office-pool.js'

class FakeChild implements OfficeChildLike {
  readonly messages: unknown[] = []
  killed = false
  private messageListener: ((message: unknown) => void) | undefined
  private exitListener: ((code: number) => void) | undefined

  postMessage(message: unknown): void {
    this.messages.push(message)
  }

  kill(): void {
    this.killed = true
  }

  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  on(
    event: 'message' | 'exit',
    listener: ((message: unknown) => void) | ((code: number) => void),
  ): unknown {
    if (event === 'message') this.messageListener = listener as (message: unknown) => void
    else this.exitListener = listener as (code: number) => void
    return this
  }

  reply(message: unknown): void {
    this.messageListener?.(message)
  }

  exit(code: number): void {
    this.exitListener?.(code)
  }
}

describe('OfficePool', () => {
  it('把裸 payload 与 { data } 包装两种回包都归一', async () => {
    const child = new FakeChild()
    const pool = new OfficePool({ fork: () => child, timeoutMs: 1000 })
    const pending = pool.run({
      action: 'read',
      path: 'a.docx',
      format: 'docx',
      offset: 0,
      limit: 10,
    })
    const request = child.messages[0] as { id: string }
    child.reply({
      id: request.id,
      ok: true,
      read: { content: 'ok', truncated: false, warnings: [] },
    })
    await expect(pending).resolves.toMatchObject({ ok: true, read: { content: 'ok' } })

    const second = pool.run({
      action: 'read',
      path: 'b.docx',
      format: 'docx',
      offset: 0,
      limit: 10,
    })
    const request2 = child.messages[1] as { id: string }
    child.reply({
      data: {
        id: request2.id,
        ok: true,
        read: { content: 'wrapped', truncated: false, warnings: [] },
      },
    })
    await expect(second).resolves.toMatchObject({ ok: true, read: { content: 'wrapped' } })
  })

  it('超时杀 worker、不自动重试，下一次请求会重建', async () => {
    vi.useFakeTimers()
    const first = new FakeChild()
    const second = new FakeChild()
    const fork = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    const pool = new OfficePool({ fork, timeoutMs: 50 })
    const pending = pool.run({
      action: 'read',
      path: 'a.docx',
      format: 'docx',
      offset: 0,
      limit: 10,
    })
    await vi.advanceTimersByTimeAsync(60)
    await expect(pending).resolves.toMatchObject({ ok: false })
    expect(first.killed).toBe(true)
    expect(fork).toHaveBeenCalledTimes(1)

    void pool.run({ action: 'read', path: 'b.docx', format: 'docx', offset: 0, limit: 10 })
    expect(fork).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('worker 退出让在途请求失败', async () => {
    const child = new FakeChild()
    const pool = new OfficePool({ fork: () => child, timeoutMs: 1000 })
    const pending = pool.run({
      action: 'read',
      path: 'a.docx',
      format: 'docx',
      offset: 0,
      limit: 10,
    })
    child.exit(9)
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('code=9'),
    })
  })
})
