/**
 * ClassIsland 桥接解析与 provider 单测（docs/05 §3.4 v2/v3）。
 *
 * 重点覆盖**降级语义**：桥接数据缺失 / 非法 / 超时都必须变成"空课表 + 告警"，
 * 绝不能抛出 —— 课前提醒是增强能力，不能因为桥接插件没装就把主流程带崩。
 * v3 另覆盖两件事：status 快照的新字段（宽容解析）与**反向提醒通道**
 * （文件模式写命令 + 轮询回执；HTTP 模式 POST /notify）。
 */
import { describe, expect, it } from 'vitest'
import {
  ClassIslandNotifier,
  ClassIslandProvider,
  buildNotifyUrl,
  parseClassislandPayload,
  readClassIslandSource,
} from './classisland.js'
import { createMemoryLogger } from '@aurora/shared'
import { describeClassStatus } from './perception.js'

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

  it('file 源端点读不到时按默认路径回落（v0.2.4）', async () => {
    const reads: string[] = []
    const result = await readClassIslandSource(
      {
        source: 'file',
        endpoint: 'D:\configured.json',
        timeoutMs: 1000,
        fallbackFilePath: 'D:\default\schedule.json',
      },
      {
        readFile: async (path) => {
          reads.push(path)
          if (path === 'D:\configured.json') throw new Error('ENOENT')
          return '{"ok":1}'
        },
      },
    )
    expect(result.raw).toBe('{"ok":1}')
    expect(result.usedFallback).toBe(true)
    expect(result.endpointError).toContain('ENOENT')
    expect(reads).toEqual(['D:\configured.json', 'D:\default\schedule.json'])
  })

  it('端点本身就是默认路径时不重复回落（失败如实上报）', async () => {
    let calls = 0
    const result = await readClassIslandSource(
      {
        source: 'file',
        endpoint: 'D:\default\schedule.json',
        timeoutMs: 1000,
        fallbackFilePath: 'D:\default\SCHEDULE.json',
      },
      {
        readFile: async () => {
          calls += 1
          throw new Error('ENOENT')
        },
      },
    )
    expect(result.raw).toBeUndefined()
    expect(result.usedFallback).toBeUndefined()
    expect(result.error).toContain('ENOENT')
    expect(calls).toBe(1)
  })

  it('http 源不走回落', async () => {
    let calls = 0
    const result = await readClassIslandSource(
      {
        source: 'http',
        endpoint: 'http://127.0.0.1:1/schedule',
        timeoutMs: 1000,
        fallbackFilePath: 'D:\default\schedule.json',
      },
      {
        fetchImpl: (async () => new Response('', { status: 503 })) as unknown as typeof fetch,
        readFile: async () => {
          calls += 1
          return '{}'
        },
      },
    )
    expect(result.usedFallback).toBeUndefined()
    expect(result.error).toContain('503')
    expect(calls).toBe(0)
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

// ───────────────────────── status 快照 v3（docs/05 §3.4） ─────────────────────────

describe('parseClassislandPayload 的 status 快照', () => {
  function statusOf(raw: unknown): unknown {
    return parseClassislandPayload(raw).status
  }

  it('解析完整的 v3 快照（含新增的三个时间字段）', () => {
    const status = statusOf({
      lessons: [],
      status: {
        version: 3,
        generatedAt: '2026-09-25T08:00:00+08:00',
        onClass: true,
        currentSubject: '数学',
        currentStartTime: '08:00',
        currentEndTime: '08:45',
        nextSubject: '语文',
        nextStartTime: '09:20',
        nextEndTime: '10:05',
      },
    })
    expect(status).toEqual({
      version: 3,
      generatedAt: '2026-09-25T08:00:00+08:00',
      onClass: true,
      currentSubject: '数学',
      currentStartTime: '08:00',
      currentEndTime: '08:45',
      nextSubject: '语文',
      nextStartTime: '09:20',
      nextEndTime: '10:05',
    })
  })

  it('只用两个核心字段（version + onClass）就成立，其余缺就缺', () => {
    expect(statusOf({ lessons: [], status: { version: 3, onClass: false } })).toEqual({
      version: 3,
      onClass: false,
    })
    // v2 老数据（没有 v3 的三个时间字段）照常解析 —— 版本不分派
    expect(
      statusOf({ lessons: [], status: { version: 2, onClass: true, currentSubject: '生物' } }),
    ).toEqual({ version: 2, onClass: true, currentSubject: '生物' })
  })

  it('未知版本号只记录不拒绝（向前兼容）', () => {
    const status = statusOf({
      lessons: [],
      status: { version: 99, onClass: true, nextSubject: '物理', nextStartTime: '10:00' },
    })
    expect(status).toEqual({
      version: 99,
      onClass: true,
      nextSubject: '物理',
      nextStartTime: '10:00',
    })
  })

  it('缺 version / onClass 时整份丢弃（不是契约快照），坏字段则逐字段丢弃', () => {
    expect(statusOf({ lessons: [], status: { onClass: true } })).toBeUndefined()
    expect(statusOf({ lessons: [], status: { version: 3 } })).toBeUndefined()
    expect(statusOf({ lessons: [], status: { version: '3', onClass: true } })).toBeUndefined()
    expect(statusOf({ lessons: [], status: { version: 3, onClass: 'yes' } })).toBeUndefined()

    // 坏字段（时间非法 / 科目空白）丢掉，好字段保留；未补零的时间被归一
    expect(
      statusOf({
        lessons: [],
        status: {
          version: 3,
          onClass: true,
          currentSubject: '   ',
          currentStartTime: '25:00',
          nextStartTime: '9:20',
        },
      }),
    ).toEqual({ version: 3, onClass: true, nextStartTime: '09:20' })
  })

  it('status 不是对象 / 缺失 / 是数组时都不产生快照，也不影响课表解析', () => {
    for (const status of [undefined, null, 'nope', [1, 2], 42]) {
      const result = parseClassislandPayload({
        lessons: [{ weekday: 1, startTime: '08:00', endTime: '08:45', subject: '数学' }],
        ...(status === undefined ? {} : { status }),
      })
      expect(result.status).toBeUndefined()
      expect(result.lessons).toHaveLength(1)
      expect(result.warnings).toEqual([])
    }
  })

  it('provider 把快照透出到 getStatus() 与 test()', async () => {
    const content = JSON.stringify({
      version: 1,
      lessons: [{ weekday: 1, startTime: '08:00', endTime: '08:45', subject: '数学' }],
      status: {
        version: 3,
        onClass: true,
        currentSubject: '数学',
        currentStartTime: '08:00',
        currentEndTime: '08:45',
      },
    })
    const provider = new ClassIslandProvider({
      source: 'file',
      endpoint: 'D:\\bridge.json',
      timeoutMs: 1000,
      readFile: async () => content,
      logger: createMemoryLogger(),
    })

    const monday = new Date(2026, 8, 21)
    await provider.getToday(monday)
    expect(provider.getStatus().status?.currentEndTime).toBe('08:45')

    const result = await provider.test(monday)
    expect(result.status?.version).toBe(3)
    expect(result.status?.currentStartTime).toBe('08:00')
  })
})

// ───────────────────────── 提醒通道（v3，docs/05 §3.4） ─────────────────────────

describe('buildNotifyUrl', () => {
  it('按 origin 拼 /notify（用户可能填了带路径的课表端点）', () => {
    expect(buildNotifyUrl('http://127.0.0.1:17945/schedule')).toBe('http://127.0.0.1:17945/notify')
    expect(buildNotifyUrl('http://127.0.0.1:17945')).toBe('http://127.0.0.1:17945/notify')
    expect(buildNotifyUrl('  https://example.com/a/b?c=1  ')).toBe('https://example.com/notify')
  })

  it('非法 / 非 http(s) 地址返回 undefined（调用方转成失败结果）', () => {
    expect(buildNotifyUrl('D:\\bridge.json')).toBeUndefined()
    expect(buildNotifyUrl('')).toBeUndefined()
    expect(buildNotifyUrl('ftp://example.com/x')).toBeUndefined()
  })
})

describe('ClassIslandNotifier', () => {
  const BRIDGE = 'D:\\bridge\\schedule.json'
  const COMMAND_PATH = 'D:\\bridge\\command.json'
  const RESULT_PATH = 'D:\\bridge\\command-result.json'

  /** 文件模式的最小假实现：内存里的 command.json / command-result.json */
  function fileHarness(options: { timeoutMs?: number } = {}) {
    const files = new Map<string, string>()
    let written: Record<string, unknown> | undefined
    const notifier = new ClassIslandNotifier({
      getConfig: () => ({ source: 'file', endpoint: BRIDGE, timeoutMs: options.timeoutMs ?? 200 }),
      writeFile: async (path, content) => {
        files.set(path, content)
        written = JSON.parse(content) as Record<string, unknown>
      },
      readFile: async (path) => {
        const content = files.get(path)
        if (content === undefined) throw new Error('ENOENT')
        return content
      },
      // 不等真实时间：轮询逻辑仍然完整跑一遍
      sleep: async () => undefined,
      newId: () => 'fixed-id',
      now: () => new Date('2026-09-25T08:00:00.000Z'),
      logger: createMemoryLogger(),
    })
    return { notifier, files, command: () => written }
  }

  it('文件模式：写 command.json 到位、轮询到同 id 回执 → ok，状态更新', async () => {
    const files = new Map<string, string>()
    let written: Record<string, unknown> | undefined
    // 模拟桥接端：收到命令立刻写好回执
    const notifier = new ClassIslandNotifier({
      getConfig: () => ({ source: 'file', endpoint: BRIDGE, timeoutMs: 500 }),
      writeFile: async (path, content) => {
        files.set(path, content)
        written = JSON.parse(content) as Record<string, unknown>
        files.set(
          RESULT_PATH,
          JSON.stringify({
            version: 1,
            id: 'fixed-id',
            ok: true,
            handledAt: '2026-09-25T08:00:01Z',
          }),
        )
      },
      readFile: async (path) => {
        const content = files.get(path)
        if (content === undefined) throw new Error('ENOENT')
        return content
      },
      sleep: async () => undefined,
      newId: () => 'fixed-id',
      now: () => new Date('2026-09-25T08:00:00.000Z'),
      logger: createMemoryLogger(),
    })

    const result = await notifier.notify({ title: 'Aurora', body: '该交作业了' })
    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)

    // 命令写到了课表文件同目录，契约与 docs/05 §3.4 v3 一致
    expect(files.has(COMMAND_PATH)).toBe(true)
    expect(written).toMatchObject({
      version: 1,
      id: 'fixed-id',
      kind: 'notify',
      channel: 'custom',
      title: 'Aurora',
      body: '该交作业了',
    })
    expect(typeof written?.['createdAt']).toBe('string')

    const state = notifier.getState()
    expect(state.available).toBe(true)
    expect(state.ok).toBe(true)
    expect(state.lastAt).not.toBeNull()
    expect(state.error).toBeUndefined()
  })

  it('文件模式：回执 ok:false 时把 error 原样带回（通道本身仍算可用）', async () => {
    const files = new Map<string, string>()
    const notifier = new ClassIslandNotifier({
      getConfig: () => ({ source: 'file', endpoint: BRIDGE, timeoutMs: 500 }),
      writeFile: async (path, content) => {
        files.set(path, content)
        files.set(
          RESULT_PATH,
          JSON.stringify({ version: 1, id: 'fixed-id', ok: false, error: '提醒提供方不可用' }),
        )
      },
      readFile: async (path) => {
        const content = files.get(path)
        if (content === undefined) throw new Error('ENOENT')
        return content
      },
      sleep: async () => undefined,
      newId: () => 'fixed-id',
      logger: createMemoryLogger(),
    })

    const result = await notifier.notify({ title: 't', body: 'b' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('提醒提供方不可用')
    expect(notifier.getState().ok).toBe(false)
    expect(notifier.getState().error).toContain('提醒提供方不可用')
  })

  it('文件模式：等不到回执（插件不是 v3 / 通道关闭）→ 超时失败且标记通道不可用', async () => {
    const harness = fileHarness()
    const result = await harness.notifier.notify({ title: 't', body: 'b', channel: 'pre-class' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('等待 ClassIsland 回执超时')
    expect(harness.notifier.getState().available).toBe(false)

    // 命令仍然写了出去（命令文件不删除，也不因为没回执就改写别的文件）
    expect(harness.files.has(COMMAND_PATH)).toBe(true)
    expect(harness.files.has(RESULT_PATH)).toBe(false)
  })

  it('文件模式：回执 id 不匹配（上一次命令的残留）时继续等，不当成自己的结果', async () => {
    const files = new Map<string, string>()
    let reads = 0
    const notifier = new ClassIslandNotifier({
      getConfig: () => ({ source: 'file', endpoint: BRIDGE, timeoutMs: 1000 }),
      writeFile: async (path, content) => {
        files.set(path, content)
        files.set(RESULT_PATH, JSON.stringify({ version: 1, id: 'stale-id', ok: true }))
      },
      readFile: async (path) => {
        if (path === RESULT_PATH) {
          reads += 1
          // 第 3 次读时才换成自己的 id
          if (reads >= 3) return JSON.stringify({ version: 1, id: 'fixed-id', ok: true })
        }
        const content = files.get(path)
        if (content === undefined) throw new Error('ENOENT')
        return content
      },
      sleep: async () => undefined,
      newId: () => 'fixed-id',
      logger: createMemoryLogger(),
    })

    const result = await notifier.notify({ title: 't', body: 'b' })
    expect(result.ok).toBe(true)
    expect(reads).toBeGreaterThanOrEqual(3)
  })

  it('文件模式：端点不是带目录的路径 → 立刻失败（不写文件）', async () => {
    let wrote = false
    const notifier = new ClassIslandNotifier({
      getConfig: () => ({ source: 'file', endpoint: 'schedule.json', timeoutMs: 500 }),
      writeFile: async () => {
        wrote = true
      },
      readFile: async () => {
        throw new Error('ENOENT')
      },
      sleep: async () => undefined,
      logger: createMemoryLogger(),
    })

    const result = await notifier.notify({ title: 't', body: 'b' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('不是有效的文件路径')
    expect(wrote).toBe(false)
    expect(notifier.getState().available).toBe(false)
  })

  it('HTTP 模式：POST 到 <origin>/notify，body 与文件模式同构', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const notifier = new ClassIslandNotifier({
      getConfig: () => ({
        source: 'http',
        endpoint: 'http://127.0.0.1:17945/schedule',
        timeoutMs: 1000,
      }),
      fetchImpl: () =>
        (async (url: unknown, init?: RequestInit) => {
          calls.push({ url: String(url), init })
          return new Response(JSON.stringify({ version: 1, id: 'fixed-id', ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }) as unknown as typeof fetch,
      newId: () => 'fixed-id',
      logger: createMemoryLogger(),
    })

    const result = await notifier.notify({ title: 'A', body: 'B', channel: 'class-started' })
    expect(result.ok).toBe(true)
    expect(calls[0]?.url).toBe('http://127.0.0.1:17945/notify')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      version: 1,
      kind: 'notify',
      channel: 'class-started',
      title: 'A',
      body: 'B',
    })
  })

  it('HTTP 模式：404（插件不是 v3 / 命令通道关闭）→ 失败并标记通道不可用', async () => {
    const notifier = new ClassIslandNotifier({
      getConfig: () => ({ source: 'http', endpoint: 'http://127.0.0.1:17945', timeoutMs: 1000 }),
      fetchImpl: () => (async () => new Response('', { status: 404 })) as unknown as typeof fetch,
      logger: createMemoryLogger(),
    })

    const result = await notifier.notify({ title: 't', body: 'b' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('404')
    expect(notifier.getState().available).toBe(false)
  })

  it('未配置端点 / 标题与正文都为空 → 失败且不发任何 IO', async () => {
    let called = false
    const unconfigured = new ClassIslandNotifier({
      getConfig: () => ({ source: 'file', endpoint: '  ', timeoutMs: 500 }),
      writeFile: async () => {
        called = true
      },
      readFile: async () => {
        called = true
        return '{}'
      },
      logger: createMemoryLogger(),
    })
    const result = await unconfigured.notify({ title: 't', body: 'b' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('尚未配置')
    expect(unconfigured.getState().available).toBe(false)

    const empty = new ClassIslandNotifier({
      getConfig: () => ({ source: 'file', endpoint: BRIDGE, timeoutMs: 500 }),
      writeFile: async () => {
        called = true
      },
      readFile: async () => '{}',
      logger: createMemoryLogger(),
    })
    const emptyResult = await empty.notify({ title: '', body: '   ' })
    expect(emptyResult.ok).toBe(false)
    expect(emptyResult.error).toContain('不能都为空')
    // 参数错误不算「通道不可用」
    expect(empty.getState().available).toBe(true)
    expect(called).toBe(false)
  })
})

// ───────────────────────── 课堂状态行（感知摘要，v3） ─────────────────────────

// 放在本文件而不是新开 perception.test.ts：它是「ClassIsland 快照 → 人读文本」的最后一环，
// 与上面两组用例同属一条消费链，读起来更连贯（也不新增文件）。
describe('describeClassStatus', () => {
  it('上课中 + 下节课：给出两者的科目与起止时间', () => {
    expect(
      describeClassStatus({
        version: 3,
        onClass: true,
        currentSubject: '数学',
        currentStartTime: '08:00',
        currentEndTime: '08:45',
        nextSubject: '语文',
        nextStartTime: '09:20',
        nextEndTime: '10:05',
      }),
    ).toBe('课堂状态：上课中（数学 08:00-08:45）；下节课 语文 09:20-10:05')
  })

  it('上课中但时间缺失：宁可省略时间也不编造', () => {
    expect(describeClassStatus({ version: 3, onClass: true, currentSubject: '数学' })).toBe(
      '课堂状态：上课中（数学）',
    )
  })

  it('课间（不在上课）但有下节课：给出「不在上课」+ 下节课', () => {
    expect(
      describeClassStatus({
        version: 3,
        onClass: false,
        nextSubject: '物理',
        nextStartTime: '10:00',
      }),
    ).toBe('课堂状态：不在上课；下节课 物理 10:00')
  })

  it('不在上课且没有下节课 / 快照只有版本号 / 未提供快照 → 空串（调用方省略整行）', () => {
    expect(describeClassStatus({ version: 3, onClass: false })).toBe('')
    expect(describeClassStatus({ version: 2, onClass: false, generatedAt: 'x' })).toBe('')
    expect(describeClassStatus(undefined)).toBe('')
  })

  describe('ClassIslandProvider.refreshIfStale', () => {
    const monday = new Date(2026, 8, 21)

    function providerFor(content: string): ClassIslandProvider {
      return new ClassIslandProvider({
        source: 'file',
        endpoint: 'D:\\bridge.json',
        timeoutMs: 1000,
        readFile: async () => content,
        logger: createMemoryLogger(),
      })
    }

    it('未读过任何数据时补读一次；缓存窗口内不重复读', async () => {
      const provider = providerFor(
        payloadOf([
          { weekday: monday.getDay(), startTime: '08:00', endTime: '08:45', subject: '数学' },
        ]),
      )
      // 从未读过的 provider（用户刚把课表来源切到 ClassIsland 时的真实状态）
      expect(provider.getStatus().lastSyncAt).toBeNull()

      await provider.refreshIfStale(15_000)
      const first = provider.getStatus().lastSyncAt
      expect(first).not.toBeNull()
      expect(provider.getStatus().lessonCount).toBe(1)

      // 缓存窗口内的第二次调用不应重读（时间戳原样）
      await provider.refreshIfStale(15_000)
      expect(provider.getStatus().lastSyncAt).toBe(first)

      // 过期（maxAge 0）则重读一次
      await provider.refreshIfStale(0)
      expect(provider.getStatus().lastSyncAt).not.toBeNull()
    })

    it('读取失败不抛错，失败原因落在 status 上', async () => {
      const provider = new ClassIslandProvider({
        source: 'file',
        endpoint: 'D:\\missing.json',
        timeoutMs: 1000,
        readFile: async () => {
          throw new Error('文件不存在')
        },
        logger: createMemoryLogger(),
      })
      await expect(provider.refreshIfStale(0)).resolves.toBeUndefined()
      expect(provider.getStatus().ok).toBe(false)
    })
  })
})
