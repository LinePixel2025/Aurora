/**
 * ClassIsland 桥接解析与 provider 单测（docs/05 §3.4 v2）。
 *
 * 重点覆盖**降级语义**：桥接数据缺失 / 非法 / 超时都必须变成"空课表 + 告警"，
 * 绝不能抛出 —— 课前提醒是增强能力，不能因为桥接插件没装就把主流程带崩。
 */
import { describe, expect, it } from 'vitest'
import {
  ClassIslandProvider,
  parseClassislandPayload,
  readClassIslandSource,
} from './classisland.js'
import { createMemoryLogger } from '@aurora/shared'

function payloadOf(lessons: unknown): string {
  return JSON.stringify({ version: 1, generatedAt: '2026-09-19T00:00:00Z', lessons })
}

describe('parseClassislandPayload', () => {
  it('解析合法数据并按星期 / 时间排序', () => {
    const result = parseClassislandPayload({
      lessons: [
        { weekday: 3, startTime: '10:00', endTime: '10:45', subject: '英语' },
        { weekday: 1, startTime: '09:00', endTime: '09:45', subject: '数学' },
        { weekday: 1, startTime: '08:00', endTime: '08:45', subject: '语文' },
      ],
    })
    expect(result.warnings).toEqual([])
    expect(result.lessons).toEqual([
      { weekday: 1, startTime: '08:00', endTime: '08:45', subject: '语文' },
      { weekday: 1, startTime: '09:00', endTime: '09:45', subject: '数学' },
      { weekday: 3, startTime: '10:00', endTime: '10:45', subject: '英语' },
    ])
  })

  it('宽容处理：顶层直接是数组、数字字符串 weekday、未补零时间、多余字段', () => {
    const result = parseClassislandPayload([
      { weekday: '1', startTime: '8:05', endTime: '8:50', subject: '数学', room: 'A101' },
    ])
    expect(result.warnings).toEqual([])
    expect(result.lessons).toEqual([
      { weekday: 1, startTime: '08:05', endTime: '08:50', subject: '数学' },
    ])
  })

  it('weekday=7 视为周日（ClassIsland 侧常见表示），越界值被拒绝', () => {
    const result = parseClassislandPayload({
      lessons: [
        { weekday: 7, startTime: '08:00', endTime: '08:45', subject: '数学' },
        { weekday: 9, startTime: '09:00', endTime: '09:45', subject: '英语' },
        { weekday: -1, startTime: '10:00', endTime: '10:45', subject: '物理' },
      ],
    })
    expect(result.lessons).toEqual([
      { weekday: 0, startTime: '08:00', endTime: '08:45', subject: '数学' },
    ])
    expect(result.warnings).toHaveLength(2)
  })

  it('逐条跳过非法数据并给出带行号的告警，不整份作废', () => {
    const result = parseClassislandPayload({
      lessons: [
        { weekday: 1, startTime: '08:00', endTime: '08:45', subject: '数学' },
        { weekday: 9, startTime: '09:00', endTime: '09:45', subject: '英语' },
        { weekday: 1, startTime: '25:00', endTime: '09:45', subject: '物理' },
        { weekday: 1, startTime: '10:00', endTime: '10:45', subject: '  ' },
      ],
    })
    expect(result.lessons).toHaveLength(1)
    expect(result.warnings).toHaveLength(3)
    expect(result.warnings[0]).toContain('第 2 条')
    expect(result.warnings[1]).toContain('startTime')
  })

  it('缺少 lessons 数组 → 空课表 + 告警（而不是抛错）', () => {
    const result = parseClassislandPayload({ foo: 1 })
    expect(result.lessons).toEqual([])
    expect(result.warnings[0]).toContain('lessons')
    expect(parseClassislandPayload(null).lessons).toEqual([])
    expect(parseClassislandPayload('nope').lessons).toEqual([])
  })
})

describe('readClassIslandSource', () => {
  it('未配置端点时直接返回错误，不发起任何调用', async () => {
    let called = false
    const result = await readClassIslandSource(
      { source: 'file', endpoint: '   ', timeoutMs: 1000 },
      {
        readFile: async () => {
          called = true
          return '{}'
        },
      },
    )
    expect(result.raw).toBeUndefined()
    expect(result.error).toContain('尚未配置')
    expect(called).toBe(false)
  })

  it('file 源读取失败返回错误而不抛出', async () => {
    const result = await readClassIslandSource(
      { source: 'file', endpoint: 'D:\\nope.json', timeoutMs: 1000 },
      {
        readFile: async () => {
          throw new Error('ENOENT')
        },
      },
    )
    expect(result.error).toContain('ENOENT')
  })

  it('http 源在非 2xx 时返回错误', async () => {
    const result = await readClassIslandSource(
      { source: 'http', endpoint: 'http://127.0.0.1:1/schedule', timeoutMs: 1000 },
      {
        fetchImpl: (async () => new Response('', { status: 503 })) as unknown as typeof fetch,
      },
    )
    expect(result.error).toContain('503')
  })

  it('http 源超时按 abort 处理（超时值被夹到下限以上）', async () => {
    const hanging = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })
    }) as unknown as typeof fetch

    const result = await readClassIslandSource(
      // timeoutMs 给 1ms：会被 clamp 到下限 200ms，因此这里仍能较快返回
      { source: 'http', endpoint: 'http://127.0.0.1:1/schedule', timeoutMs: 1 },
      { fetchImpl: hanging },
    )
    expect(result.error).toBe('请求超时')
  })
})

describe('ClassIslandProvider', () => {
  const monday = new Date(2026, 8, 21) // 2026-09-21 是周一

  function providerFor(content: string): ClassIslandProvider {
    return new ClassIslandProvider({
      source: 'file',
      endpoint: 'D:\\bridge.json',
      timeoutMs: 1000,
      readFile: async () => content,
      logger: createMemoryLogger(),
    })
  }

  it('getToday 只返回当天课程且不抛错', async () => {
    const provider = providerFor(
      payloadOf([
        { weekday: monday.getDay(), startTime: '08:00', endTime: '08:45', subject: '数学' },
        {
          weekday: (monday.getDay() + 1) % 7,
          startTime: '09:00',
          endTime: '09:45',
          subject: '英语',
        },
      ]),
    )
    const lessons = await provider.getToday(monday)
    expect(lessons).toHaveLength(1)
    expect(lessons[0]?.subject).toBe('数学')
  })

  it('读取失败时返回空课表并把原因写进状态（供设置页展示）', async () => {
    const provider = new ClassIslandProvider({
      source: 'file',
      endpoint: 'D:\\missing.json',
      timeoutMs: 1000,
      readFile: async () => {
        throw new Error('文件不存在')
      },
      logger: createMemoryLogger(),
    })
    await expect(provider.getToday(monday)).resolves.toEqual([])
    const status = provider.getStatus()
    expect(status.ok).toBe(false)
    expect(status.error).toContain('文件不存在')
  })

  it('非法 JSON 不抛错，状态里带告警', async () => {
    const provider = providerFor('{ 这不是 JSON')
    await expect(provider.getToday(monday)).resolves.toEqual([])
    expect(provider.getStatus().warnings[0]).toContain('JSON')
  })

  it('成功读取记录同步时间与课程数', async () => {
    const provider = providerFor(
      payloadOf([
        { weekday: monday.getDay(), startTime: '08:00', endTime: '08:45', subject: '数学' },
      ]),
    )
    await provider.getToday(monday)
    const status = provider.getStatus()
    expect(status.ok).toBe(true)
    expect(status.lessonCount).toBe(1)
    expect(status.lastSyncAt).not.toBeNull()
  })

  it('test() 返回今日预览且不改动既有状态语义', async () => {
    const provider = providerFor(
      payloadOf([
        { weekday: monday.getDay(), startTime: '08:00', endTime: '08:45', subject: '数学' },
        {
          weekday: (monday.getDay() + 2) % 7,
          startTime: '10:00',
          endTime: '10:45',
          subject: '物理',
        },
      ]),
    )
    const result = await provider.test(monday)
    expect(result.ok).toBe(true)
    expect(result.lessons.map((lesson) => lesson.subject)).toEqual(['数学'])
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    // test() 是只读探针：不应该把 provider 标记成"已同步"
    expect(provider.getStatus().lastSyncAt).toBeNull()
  })

  it('test() 在端点未配置 / 读取失败时 ok=false 并给出 error', async () => {
    const provider = new ClassIslandProvider({
      source: 'http',
      endpoint: '',
      timeoutMs: 1000,
      logger: createMemoryLogger(),
    })
    const result = await provider.test(monday)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('尚未配置')
  })
})
