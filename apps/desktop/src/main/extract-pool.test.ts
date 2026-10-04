import { describe, expect, it } from 'vitest'
import { ExtractPool, unwrapChildMessage, type ExtractChildLike } from './extract-pool.js'

/**
 * 假子进程：记录 postMessage，并能让测试手动投递回包。
 *
 * 关键点：**默认按真实 Electron 行为投递"裸 payload"**。
 * 父进程侧若照抄子进程的 `message.data`，这里的回包就永远匹配不上，
 * 测试会以超时失败——这正是真实环境里静默降级的那个缺陷。
 */
function fakeChild(options: { shape?: 'bare' | 'wrapped' } = {}) {
  const messages: unknown[] = []
  const listeners: Array<(message: unknown) => void> = []
  const exitListeners: Array<(code: number) => void> = []
  let killed = false

  const child: ExtractChildLike = {
    postMessage: (message) => {
      messages.push(message)
    },
    kill: () => {
      killed = true
    },
    on: (event: 'message' | 'exit', listener: never) => {
      if (event === 'message') listeners.push(listener as (message: unknown) => void)
      else exitListeners.push(listener as (code: number) => void)
      return child
    },
  }

  return {
    child,
    messages,
    get killed() {
      return killed
    },
    /** 模拟子进程回包；默认裸 payload（真实行为） */
    reply(payload: unknown) {
      const shaped =
        options.shape === 'wrapped' ? { data: payload, ports: [] } : (payload as unknown)
      for (const listener of listeners) listener(shaped)
    },
    emitExit(code: number) {
      for (const listener of exitListeners) listener(code)
    },
  }
}

function requestOf(message: unknown): {
  id: string
  path: string
  extractDocumentImages?: boolean
} {
  return message as { id: string; path: string; extractDocumentImages?: boolean }
}

describe('unwrapChildMessage', () => {
  it('接受裸 payload（Electron 实测的真实形状）', () => {
    const bare = { id: 'ex-1', ok: true, evidence: 'x' }
    expect(unwrapChildMessage(bare)).toEqual(bare)
  })

  it('兼容 { data } 包装形状', () => {
    const wrapped = { data: { id: 'ex-1', ok: true, evidence: 'x' }, ports: [] }
    expect(unwrapChildMessage(wrapped)).toEqual({ id: 'ex-1', ok: true, evidence: 'x' })
  })

  it('非法输入返回 undefined 而不是抛错', () => {
    expect(unwrapChildMessage(undefined)).toBeUndefined()
    expect(unwrapChildMessage(null)).toBeUndefined()
    expect(unwrapChildMessage('str')).toBeUndefined()
    expect(unwrapChildMessage(42)).toBeUndefined()
    expect(unwrapChildMessage({})).toBeUndefined()
    expect(unwrapChildMessage({ unrelated: true })).toBeUndefined()
  })
})

describe('ExtractPool · 子进程回包', () => {
  it('裸 payload 回包被正确接收（回归：父进程曾误读 message.data 导致必然超时）', async () => {
    const fake = fakeChild({ shape: 'bare' })
    const pool = new ExtractPool({ fork: () => fake.child, timeoutMs: 5_000 })

    const promise = pool.extract({ path: 'D:\\感知\\a.pdf', ext: 'pdf', sizeBytes: 10 })
    const sent = requestOf(fake.messages[0])
    expect(sent.path).toBe('D:\\感知\\a.pdf')

    fake.reply({
      id: sent.id,
      ok: true,
      kind: 'document',
      evidence: '正文内容',
      evidenceChars: 4,
      warnings: [],
    })

    await expect(promise).resolves.toEqual({
      kind: 'document',
      evidence: '正文内容',
      evidenceChars: 4,
      warnings: [],
      degraded: false,
    })
  })

  it('{ data } 包装回包同样被接收（跨 Electron 版本兼容）', async () => {
    const fake = fakeChild({ shape: 'wrapped' })
    const pool = new ExtractPool({ fork: () => fake.child, timeoutMs: 5_000 })

    const promise = pool.extract({ path: 'D:\\感知\\a.txt', ext: 'txt', sizeBytes: 3 })
    const sent = requestOf(fake.messages[0])
    fake.reply({ id: sent.id, ok: true, kind: 'text', evidence: 'hi', evidenceChars: 2 })

    await expect(promise).resolves.toMatchObject({ kind: 'text', evidence: 'hi', degraded: false })
  })

  it('文件自感知请求带回内嵌图片数据', async () => {
    const fake = fakeChild()
    const pool = new ExtractPool({ fork: () => fake.child, timeoutMs: 5_000 })
    const promise = pool.extract({
      path: 'D:\\感知\\课程.pptx',
      ext: 'pptx',
      sizeBytes: 10,
      extractDocumentImages: true,
    })
    const sent = requestOf(fake.messages[0])
    expect(sent.extractDocumentImages).toBe(true)
    fake.reply({
      id: sent.id,
      ok: true,
      kind: 'document',
      evidence: '正文',
      evidenceChars: 2,
      warnings: [],
      documentImages: [
        {
          name: '图.png',
          mimeType: 'image/png',
          extension: 'png',
          dataBase64: 'AQID',
        },
      ],
    })
    await expect(promise).resolves.toMatchObject({
      documentImages: [{ name: '图.png', mimeType: 'image/png', extension: 'png' }],
    })
  })

  it('回包 id 不匹配时忽略（不误解其它请求的结果）', async () => {
    const fake = fakeChild()
    const pool = new ExtractPool({ fork: () => fake.child, timeoutMs: 5_000 })
    const promise = pool.extract({ path: 'D:\\感知\\a.pdf', ext: 'pdf', sizeBytes: 1 })

    fake.reply({ id: 'wrong-id', ok: true, kind: 'text', evidence: 'nope' })
    expect(pool.running).toBe(true)

    const sent = requestOf(fake.messages[0])
    fake.reply({ id: sent.id, ok: true, kind: 'text', evidence: 'right', evidenceChars: 5 })
    await expect(promise).resolves.toMatchObject({ evidence: 'right' })
  })

  it('子进程返回 ok:false → 降级结果并带原因', async () => {
    const fake = fakeChild()
    const warnings: string[] = []
    const pool = new ExtractPool({
      fork: () => fake.child,
      timeoutMs: 5_000,
      logger: { debug: () => undefined, warn: (message) => warnings.push(message) },
    })

    const promise = pool.extract({ path: 'D:\\感知\\broken.pdf', ext: 'pdf', sizeBytes: 9 })
    const sent = requestOf(fake.messages[0])
    fake.reply({ id: sent.id, ok: false, error: '解析器崩了' })

    const result = await promise
    expect(result.degraded).toBe(true)
    expect(result.evidence).toContain('broken.pdf')
    expect(result.evidence).toContain('解析器崩了')
    expect(warnings.join()).toContain('内容提取失败')
  })

  it('子进程退出 → 在途请求降级且不挂起', async () => {
    const fake = fakeChild()
    const pool = new ExtractPool({ fork: () => fake.child, timeoutMs: 5_000 })
    const promise = pool.extract({ path: 'D:\\感知\\a.pdf', ext: 'pdf', sizeBytes: 1 })

    fake.emitExit(1)
    const result = await promise
    expect(result.degraded).toBe(true)
    expect(result.evidence).toContain('子进程退出')
  })

  it('超时会杀子进程并在下次请求时重建', async () => {
    const children: ReturnType<typeof fakeChild>[] = []
    const pool = new ExtractPool({
      fork: () => {
        const fake = fakeChild()
        children.push(fake)
        return fake.child
      },
      timeoutMs: 50,
    })

    const result = await pool.extract({ path: 'D:\\感知\\slow.pdf', ext: 'pdf', sizeBytes: 1 })
    expect(result.degraded).toBe(true)
    expect(result.evidence).toContain('提取超时')
    expect(children[0]?.killed).toBe(true)

    // 下一次请求应重建子进程（而不是复用被杀的）
    const second = pool.extract({ path: 'D:\\感知\\b.pdf', ext: 'pdf', sizeBytes: 1 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(children).toHaveLength(2)
    const sent = requestOf(children[1]!.messages[0])
    children[1]!.reply({ id: sent.id, ok: true, kind: 'text', evidence: 'ok', evidenceChars: 2 })
    await expect(second).resolves.toMatchObject({ evidence: 'ok' })
  })

  it('close 结算在途请求并杀掉子进程（不泄漏 Promise）', async () => {
    const fake = fakeChild()
    const pool = new ExtractPool({ fork: () => fake.child, timeoutMs: 60_000 })
    const promise = pool.extract({ path: 'D:\\感知\\a.pdf', ext: 'pdf', sizeBytes: 1 })

    pool.close()
    const result = await promise
    expect(result.degraded).toBe(true)
    expect(fake.killed).toBe(true)
  })

  it('close 之后不再接受新请求', async () => {
    const fake = fakeChild()
    const pool = new ExtractPool({ fork: () => fake.child, timeoutMs: 1_000 })
    pool.close()
    const result = await pool.extract({ path: 'D:\\感知\\a.pdf', ext: 'pdf', sizeBytes: 1 })
    expect(result.degraded).toBe(true)
    expect(fake.messages).toHaveLength(0)
  })

  it('fork 抛错 → 降级而不抛出', async () => {
    const pool = new ExtractPool({
      fork: () => {
        throw new Error('spawn 失败')
      },
    })
    const result = await pool.extract({ path: 'D:\\感知\\a.pdf', ext: 'pdf', sizeBytes: 1 })
    expect(result.degraded).toBe(true)
  })

  it('失败回包后再收到迟到回包不会二次结算', async () => {
    const fake = fakeChild()
    const pool = new ExtractPool({ fork: () => fake.child, timeoutMs: 5_000 })
    const promise = pool.extract({ path: 'D:\\感知\\a.pdf', ext: 'pdf', sizeBytes: 1 })
    const sent = requestOf(fake.messages[0])

    fake.reply({ id: sent.id, ok: false, error: '第一次失败' })
    await expect(promise).resolves.toMatchObject({ degraded: true })

    // 迟到回包：此时 pending 已清空，不应抛错
    expect(() =>
      fake.reply({ id: sent.id, ok: true, kind: 'text', evidence: 'late', evidenceChars: 4 }),
    ).not.toThrow()
    expect(pool.running).toBe(false)
  })

  it('degraded 标记：解析器告警也算降级', async () => {
    const fake = fakeChild()
    const pool = new ExtractPool({ fork: () => fake.child, timeoutMs: 5_000 })
    const promise = pool.extract({ path: 'D:\\感知\\a.pdf', ext: 'pdf', sizeBytes: 1 })
    const sent = requestOf(fake.messages[0])
    fake.reply({
      id: sent.id,
      ok: true,
      kind: 'document',
      evidence: 'e',
      evidenceChars: 1,
      warnings: ['解析失败，降级为文件名证据'],
    })
    await expect(promise).resolves.toMatchObject({ degraded: true })
  })
})
