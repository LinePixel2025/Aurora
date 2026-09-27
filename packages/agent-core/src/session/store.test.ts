import { describe, expect, it } from 'vitest'
import { createMemoryLogger } from '@aurora/shared'
import { SessionStore, normalizeSessionId, sessionFilePath } from './store.js'
import { SESSION_DIR, TestFileSystem } from '../testing/fileSystem.js'
import type { StoredMessage } from './types.js'

function setup(seed: Record<string, string> = {}) {
  const fs = new TestFileSystem(seed)
  const logger = createMemoryLogger()
  const store = new SessionStore({
    dir: SESSION_DIR,
    fs,
    logger,
    writeDebounceMs: 0,
    maxMessages: 5,
  })
  return { store, fs, logger }
}

function message(role: StoredMessage['role'], content: string): StoredMessage {
  return { id: `m-${content}`, role, content, createdAt: '2025-01-01T00:00:00.000Z' }
}

describe('normalizeSessionId', () => {
  it('归一非法字符与空值（防路径穿越）', () => {
    expect(normalizeSessionId('quick')).toBe('quick')
    expect(normalizeSessionId('../../evil')).toBe('______evil')
    expect(normalizeSessionId('a/b\\c')).toBe('a_b_c')
    expect(normalizeSessionId('   ')).toBe('settings')
    expect(normalizeSessionId('')).toBe('settings')
  })

  it('会话文件路径使用归一后的 id', () => {
    expect(sessionFilePath(SESSION_DIR, '../x')).toBe(`${SESSION_DIR}\\___x.json`)
    expect(sessionFilePath(SESSION_DIR, 'quick')).toBe(`${SESSION_DIR}\\quick.json`)
  })
})

describe('SessionStore', () => {
  it('追加消息并原子落盘（含工具消息）', async () => {
    const { store, fs } = setup()
    await store.append('quick', { role: 'user', content: '你好' })
    await store.append('quick', {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'use_skill', arguments: '{}', state: 'running' }],
    })
    await store.append('quick', { role: 'tool', content: '技能正文', toolCallId: 'c1' })
    await store.flush()

    const path = sessionFilePath(SESSION_DIR, 'quick')
    expect(fs.writeLog).toContain(path)
    const persisted = JSON.parse(fs.files.get(path) ?? '{}') as {
      version: number
      sessionId: string
      messages: StoredMessage[]
    }
    expect(persisted.version).toBe(2)
    expect(persisted.sessionId).toBe('quick')
    expect(persisted.messages).toHaveLength(3)
    expect(persisted.messages[2]?.toolCallId).toBe('c1')
    // 没有 meta 的会话不该凭空多出一个 `"meta": {}`（老文件形状保持不变）
    expect('meta' in persisted).toBe(false)
  })

  it('append 尊重传入的 id，且与 nextMessageId 预领的 id 一致（正文流式的前提）', async () => {
    const { store } = setup()
    // 流式渲染要求「边收边发」的 id 与落盘 id 相同：循环先领、append 原样用
    const preallocated = store.nextMessageId()
    const stored = await store.append('quick', {
      id: preallocated,
      role: 'assistant',
      content: '边流边渲染',
    })
    expect(stored.id).toBe(preallocated)
    const messages = await store.get('quick')
    expect(messages.map((item) => item.id)).toEqual([preallocated])
    // 未给 id 时仍然自动生成（旧调用点不受影响）
    const generated = await store.append('quick', { role: 'user', content: '你好' })
    expect(generated.id).toMatch(/^msg-\d+-\d+$/)
    expect(generated.id).not.toBe(preallocated)
  })

  it('nextMessageId 不落盘、不与自动生成的 id 相撞', async () => {
    const { store, fs } = setup()
    const a = store.nextMessageId()
    const b = store.nextMessageId()
    expect(a).not.toBe(b)
    // 预领一个 id 不该在磁盘上留下任何消息
    expect(await store.get('quick')).toEqual([])
    expect((await fs.readdir(SESSION_DIR)).length).toBe(0)
    const appended = await store.append('quick', { role: 'user', content: 'x' })
    expect([a, b]).not.toContain(appended.id)
  })

  it('懒加载：第二次读取不再读盘', async () => {
    const { store, fs } = setup()
    await store.append('quick', { role: 'user', content: 'a' })
    await store.flush()
    const before = fs.writeLog.length
    const again = await store.get('quick')
    expect(again).toHaveLength(1)
    expect(fs.writeLog.length).toBe(before)
  })

  it('从磁盘恢复已有会话', async () => {
    const path = sessionFilePath(SESSION_DIR, 'main')
    const { store } = setup({
      [path]: JSON.stringify({
        version: 1,
        sessionId: 'main',
        updatedAt: '2025-01-01T00:00:00.000Z',
        messages: [message('user', '历史提问'), message('assistant', '历史回答')],
      }),
    })
    const messages = await store.get('main')
    expect(messages.map((item) => item.content)).toEqual(['历史提问', '历史回答'])
  })

  it('损坏文件：备份后重建为空会话（不丢证据）', async () => {
    const path = sessionFilePath(SESSION_DIR, 'main')
    const { store, fs, logger } = setup({ [path]: '{ not json' })
    const messages = await store.get('main')
    expect(messages).toEqual([])
    const backups = [...fs.files.keys()].filter((item) => item.includes('.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(logger.entries.some((line) => line.includes('会话文件解析失败'))).toBe(true)
  })

  it('结构非法的消息被过滤，单个坏消息不影响整份会话', async () => {
    const path = sessionFilePath(SESSION_DIR, 'main')
    const { store } = setup({
      [path]: JSON.stringify({
        version: 1,
        sessionId: 'main',
        updatedAt: '2025-01-01T00:00:00.000Z',
        messages: [message('user', 'ok'), { id: 42, role: 'nope' }],
      }),
    })
    const messages = await store.get('main')
    expect(messages).toHaveLength(1)
  })

  it('超出条数上限时裁剪最旧消息（保留新消息）', async () => {
    const { store } = setup()
    for (let index = 0; index < 8; index += 1) {
      await store.append('quick', { role: 'user', content: `m${index}` })
    }
    const messages = await store.get('quick')
    expect(messages).toHaveLength(5)
    expect(messages[0]?.content).toBe('m3')
    expect(messages[4]?.content).toBe('m7')
  })

  it('updateToolCall 原地更新工具状态', async () => {
    const { store } = setup()
    const assistant = await store.append('quick', {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'use_skill', arguments: '{}', state: 'running' }],
    })
    await store.updateToolCall(assistant.id, {
      id: 'c1',
      name: 'use_skill',
      arguments: '{}',
      state: 'success',
      outputSummary: '已加载',
    })
    const messages = await store.get('quick')
    expect(messages).toHaveLength(1)
    expect(messages[0]?.toolCalls?.[0]?.state).toBe('success')
    expect(messages[0]?.toolCalls?.[0]?.outputSummary).toBe('已加载')
  })

  it('rendererHistory 把工具卡片转成渲染层形状（arguments → input，子代理快照透传）', async () => {
    const { store } = setup()
    await store.append('quick', {
      role: 'assistant',
      content: 'a1',
      toolCalls: [
        {
          id: 'c1',
          name: 'task',
          arguments: '{"description":"查资料","prompt":"..."}',
          state: 'success',
          outputSummary: '子代理：查资料',
          subagent: {
            taskId: 't1',
            callId: 'c1',
            description: '查资料',
            prompt: '...',
            status: 'success',
            startedAt: 1,
            endedAt: 2,
            steps: [],
            toolCalls: 1,
            report: '报告',
          },
        },
        // 夹具 / 早期数据可能已经是渲染层形状（只有 input、没有 arguments）：
        // 曾经在这里直接读 `arguments.trim()`，抛错会让整份历史读不出来（界面全空）
        { id: 'c2', name: 'read_file', input: { path: 'a.txt' }, state: 'success' } as never,
      ],
    })

    const history = await store.rendererHistory('quick')
    const calls = history[0]?.toolCalls ?? []
    expect(calls[0]).toMatchObject({
      id: 'c1',
      name: 'task',
      state: 'success',
      input: { description: '查资料', prompt: '...' },
      outputSummary: '子代理：查资料',
    })
    expect(calls[0]?.subagent?.report).toBe('报告')
    expect(calls[1]?.input).toEqual({ path: 'a.txt' })
  })

  it('rendererHistory 过滤工具与 system 消息，limit 取最近 N 条', async () => {
    const { store } = setup()
    await store.append('quick', { role: 'user', content: 'q1' })
    await store.append('quick', { role: 'assistant', content: 'a1' })
    await store.append('quick', { role: 'tool', content: 'tool-out', toolCallId: 'c1' })
    await store.append('quick', { role: 'system', content: 'sys' })
    await store.append('quick', { role: 'user', content: 'q2' })

    const all = await store.rendererHistory('quick')
    expect(all.map((item) => item.content)).toEqual(['q1', 'a1', 'q2'])
    const limited = await store.rendererHistory('quick', 2)
    expect(limited.map((item) => item.content)).toEqual(['a1', 'q2'])
  })

  it('listSessions 合并内存与磁盘会话', async () => {
    const path = sessionFilePath(SESSION_DIR, 'main')
    const { store } = setup({
      [path]: JSON.stringify({ version: 1, sessionId: 'main', messages: [] }),
    })
    await store.append('quick', { role: 'user', content: 'a' })
    expect(await store.listSessions()).toEqual(['main', 'quick'])
  })

  it('写盘失败保持脏标记并在 flush 时重试', async () => {
    const { store, fs, logger } = setup()
    fs.failNextWrite = true
    await store.append('quick', { role: 'user', content: 'a' })
    // 等首次写入的失败落地（防抖为 0，append 内已入队）
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fs.files.has(sessionFilePath(SESSION_DIR, 'quick'))).toBe(false)
    expect(logger.entries.some((line) => line.includes('会话写入失败'))).toBe(true)

    // flush 会重试仍然脏的会话
    await store.flush()
    expect(fs.files.has(sessionFilePath(SESSION_DIR, 'quick'))).toBe(true)
  })

  it('clear 清空会话', async () => {
    const { store } = setup()
    await store.append('quick', { role: 'user', content: 'a' })
    await store.clear('quick')
    expect(await store.get('quick')).toEqual([])
  })
})

describe('SessionStore · 会话列表与新建（chat:sessions / chat:newSession）', () => {
  it('summaries 用首条用户消息作标题，并给出条数与更新时间', async () => {
    const { store } = setup()
    await store.append('main', { role: 'system', content: '系统提示词不参与渲染' })
    await store.append('main', { role: 'user', content: '帮我把数学作业分类' })
    await store.append('main', { role: 'assistant', content: '好的' })

    const summaries = await store.summaries()
    const main = summaries.find((item) => item.id === 'main')
    expect(main?.title).toBe('帮我把数学作业分类')
    // 只统计渲染层可见的用户 / 助手消息
    expect(main?.messageCount).toBe(2)
    expect(main?.updatedAt).not.toBe('')
  })

  it('标题过长时截断并加省略号', async () => {
    const { store } = setup()
    await store.append('main', { role: 'user', content: '一二三四五六七八九十'.repeat(5) })
    const summaries = await store.summaries()
    const title = summaries.find((item) => item.id === 'main')?.title ?? ''
    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBeLessThanOrEqual(25)
  })

  it('空会话标题为「新会话」', async () => {
    const { store } = setup()
    await store.clear('main')
    const summaries = await store.summaries()
    expect(summaries.find((item) => item.id === 'main')?.title).toBe('新会话')
  })

  it('activeId 命中时标记 active（渲染层也可自行判定）', async () => {
    const { store } = setup()
    await store.append('quick', { role: 'user', content: 'hi' })
    const summaries = await store.summaries('quick')
    expect(summaries.find((item) => item.id === 'quick')?.active).toBe(true)
  })

  it('按最后更新时间倒序排列', async () => {
    const { store } = setup()
    await store.append('older', { role: 'user', content: 'a' })
    // 直接控制时间戳，避免依赖真实时钟精度
    await store.append('newer', {
      role: 'user',
      content: 'b',
      createdAt: '2099-01-01T00:00:00.000Z',
    })
    const summaries = await store.summaries()
    expect(summaries[0]?.id).toBe('newer')
  })

  it('createSession 返回新 id 且不落空文件（首条消息才创建文件）', async () => {
    const { store, fs } = setup()
    const id = await store.createSession()
    expect(id.startsWith('chat-')).toBe(true)
    expect(await store.get(id)).toEqual([])
    // 还没写任何消息，磁盘上不该出现文件
    const files = await fs.readdir(SESSION_DIR)
    expect(files.some((name) => name === `${id}.json`)).toBe(false)

    await store.append(id, { role: 'user', content: '第一条' })
    await store.flush()
    expect(await store.get(id)).toHaveLength(1)
  })

  it('两个 createSession 的 id 不同', async () => {
    const { store } = setup()
    const first = await store.createSession()
    const second = await store.createSession()
    expect(first).not.toBe(second)
  })
})

/** 读回某会话文件的原始 JSON（断言落盘形状用） */
function readFile(fs: TestFileSystem, id: string): Record<string, unknown> {
  const raw = fs.files.get(sessionFilePath(SESSION_DIR, id))
  expect(raw).toBeDefined()
  return JSON.parse(raw ?? '{}') as Record<string, unknown>
}

function metaOf(fs: TestFileSystem, id: string): Record<string, unknown> {
  return (readFile(fs, id)['meta'] ?? {}) as Record<string, unknown>
}

/**
 * 计数文件系统：只统计 `readFile` 次数（断言"并发首读共享同一次读盘"）。
 *
 * 用子类而不是 spy 包一层：`ensureLoaded` 是私有方法，能观察到的只有真实调用次数，
 * 而 `readFile` 是读盘路径上唯一必经且无副作用的观测点。
 */
class CountingFileSystem extends TestFileSystem {
  readCount = 0

  override readFile(path: string): Promise<string> {
    this.readCount += 1
    return super.readFile(path)
  }
}

describe('SessionStore · 并发首读（in-flight 去重，docs/06 §4）', () => {
  it('并发首读 + append：磁盘历史与刚追加的消息都不能丢', async () => {
    const path = sessionFilePath(SESSION_DIR, 'main')
    const { store, fs } = setup({
      [path]: JSON.stringify({
        version: 2,
        sessionId: 'main',
        updatedAt: '2025-01-01T00:00:00.000Z',
        messages: [message('user', '历史提问'), message('assistant', '历史回答')],
      }),
    })

    // 两个调用同时进入首读窗口：get 发起读盘，append 必须等同一份读盘结果
    const [loaded, appended] = await Promise.all([
      store.get('main'),
      store.append('main', { role: 'user', content: '并发追加' }),
    ])
    expect(appended.content).toBe('并发追加')
    // 并发那次 get 的返回不约束顺序（它可能先于 append 完成），但历史一条都不能少
    expect(loaded.map((item) => item.content)).toEqual(
      expect.arrayContaining(['历史提问', '历史回答']),
    )

    // 关键断言：后续读取既有磁盘历史、也有并发追加的那条
    const after = await store.get('main')
    expect(after.map((item) => item.content)).toEqual(['历史提问', '历史回答', '并发追加'])

    // 落盘快照同样两条都在：旧写法会用"读盘那一刻的空快照"把磁盘历史改写掉
    await store.flush()
    const persisted = JSON.parse(fs.files.get(path) ?? '{}') as { messages: StoredMessage[] }
    expect(persisted.messages.map((item) => item.content)).toEqual([
      '历史提问',
      '历史回答',
      '并发追加',
    ])
  })

  it('并发两次 get 只触发一次读盘，且后续 get 命中缓存', async () => {
    const path = sessionFilePath(SESSION_DIR, 'main')
    const fs = new CountingFileSystem({
      [path]: JSON.stringify({
        version: 2,
        sessionId: 'main',
        updatedAt: '2025-01-01T00:00:00.000Z',
        messages: [message('user', '只读一次')],
      }),
    })
    const store = new SessionStore({ dir: SESSION_DIR, fs, writeDebounceMs: 0, maxMessages: 5 })

    const [first, second] = await Promise.all([store.get('main'), store.get('main')])
    expect(first.map((item) => item.content)).toEqual(['只读一次'])
    expect(second.map((item) => item.content)).toEqual(['只读一次'])
    expect(fs.readCount).toBe(1)

    // 读盘完成后已置 loaded：第三次读取纯命中缓存
    expect((await store.get('main')).map((item) => item.content)).toEqual(['只读一次'])
    expect(fs.readCount).toBe(1)
  })
})

describe('SessionStore · 会话 meta 与归档（chat:archiveSession，docs/06 §4）', () => {
  it('归档写盘可往返：重新从磁盘装载仍带 archived 与 archivedAt', async () => {
    const { store, fs } = setup()
    await store.append('quick', { role: 'user', content: 'hi' })
    await store.setArchived('quick', true)

    // setArchived 是 await 写盘的（不靠 300ms 防抖），因此此刻盘上已是最终内容
    const persisted = readFile(fs, 'quick')
    expect(persisted['version']).toBe(2)
    expect(metaOf(fs, 'quick')['archived']).toBe(true)
    expect(typeof metaOf(fs, 'quick')['archivedAt']).toBe('string')

    // 模拟重启：同一份磁盘内容、新的 store 实例
    const reloaded = new SessionStore({
      dir: SESSION_DIR,
      fs,
      writeDebounceMs: 0,
      maxMessages: 5,
    })
    expect((await reloaded.summaries()).find((item) => item.id === 'quick')?.archived).toBe(true)
    expect(await reloaded.get('quick')).toHaveLength(1)
    expect(await reloaded.get('quick')).toMatchObject([{ content: 'hi' }])
  })

  it('v1 老文件（无 meta）宽容读出：视为未归档，消息一条不少', async () => {
    const path = sessionFilePath(SESSION_DIR, 'main')
    const { store, fs } = setup({
      [path]: JSON.stringify({
        version: 1,
        sessionId: 'main',
        updatedAt: '2025-01-01T00:00:00.000Z',
        messages: [message('user', '老提问'), message('assistant', '老回答')],
      }),
    })
    const messages = await store.get('main')
    expect(messages.map((item) => item.content)).toEqual(['老提问', '老回答'])
    const main = (await store.summaries()).find((item) => item.id === 'main')
    expect(main?.archived).toBeUndefined()
    // 只读不该顺手重写老文件（v1 无需迁移）
    expect(fs.writeLog).toHaveLength(0)
    expect(readFile(fs, 'main')['version']).toBe(1)
  })

  it('setArchived 幂等：状态未变不写盘（归档与取消归档两侧都是）', async () => {
    const { store, fs } = setup()
    await store.append('quick', { role: 'user', content: 'a' })
    await store.setArchived('quick', true)
    const afterArchive = fs.writeLog.length

    await store.setArchived('quick', true)
    expect(fs.writeLog.length).toBe(afterArchive)
    expect(typeof metaOf(fs, 'quick')['archivedAt']).toBe('string')

    await store.setArchived('quick', false)
    expect(fs.writeLog.length).toBe(afterArchive + 1)
    const afterUnarchive = fs.writeLog.length
    await store.setArchived('quick', false)
    expect(fs.writeLog.length).toBe(afterUnarchive)
  })

  it('取消归档会清掉 archivedAt（不留空值）', async () => {
    const { store, fs } = setup()
    await store.append('quick', { role: 'user', content: 'a' })
    await store.setArchived('quick', true)
    await store.setArchived('quick', false)

    const meta = metaOf(fs, 'quick')
    expect(meta['archived']).toBe(false)
    expect(meta['archivedAt']).toBeUndefined()
    expect((await store.summaries()).find((item) => item.id === 'quick')?.archived).toBe(false)
  })

  it('归档从未落盘的空会话：写出只含 meta、messages 为空的文件（归档需要落点）', async () => {
    const { store, fs } = setup()
    await store.setArchived('empty-one', true)

    const persisted = readFile(fs, 'empty-one')
    expect(persisted['version']).toBe(2)
    expect(persisted['messages']).toEqual([])
    expect(metaOf(fs, 'empty-one')['archived']).toBe(true)
    expect((await store.summaries()).find((item) => item.id === 'empty-one')?.title).toBe('新会话')

    // 取消归档一个从未归档过的会话被幂等挡住：不写盘、也不凭空造出文件
    const before = fs.writeLog.length
    await store.setArchived('never-archived', false)
    expect(fs.writeLog.length).toBe(before)
    expect(fs.files.has(sessionFilePath(SESSION_DIR, 'never-archived'))).toBe(false)
  })

  it('归档不改变排序：仍按 updatedAt 倒序，归档会话照常留在列表里', async () => {
    const { store } = setup()
    await store.append('older', {
      role: 'user',
      content: 'a',
      createdAt: '2020-01-01T00:00:00.000Z',
    })
    await store.append('newer', {
      role: 'user',
      content: 'b',
      createdAt: '2099-01-01T00:00:00.000Z',
    })
    await store.setArchived('older', true)

    const summaries = await store.summaries()
    // 归档不做过滤、也不参与排序（分组是渲染层的事）
    expect(summaries.map((item) => item.id)).toEqual(['newer', 'older'])
    expect(summaries.find((item) => item.id === 'older')?.archived).toBe(true)
    expect(summaries.find((item) => item.id === 'older')?.messageCount).toBe(1)
    expect(summaries.find((item) => item.id === 'newer')?.archived).toBeUndefined()
  })

  it('meta 畸形（字符串 / 数字 / 数组）时消息照旧读出，视为未归档且不触发损坏备份', async () => {
    const badString = sessionFilePath(SESSION_DIR, 'bad-string')
    const badNumber = sessionFilePath(SESSION_DIR, 'bad-number')
    const badArray = sessionFilePath(SESSION_DIR, 'bad-array')
    const { store, fs, logger } = setup({
      [badString]: JSON.stringify({
        version: 2,
        sessionId: 'bad-string',
        updatedAt: '2025-01-01T00:00:00.000Z',
        messages: [message('user', '消息还在')],
        meta: 'x',
      }),
      [badNumber]: JSON.stringify({
        version: 2,
        sessionId: 'bad-number',
        updatedAt: '2025-01-01T00:00:00.000Z',
        messages: [message('user', '消息还在')],
        meta: 42,
      }),
      [badArray]: JSON.stringify({
        version: 2,
        sessionId: 'bad-array',
        updatedAt: '2025-01-01T00:00:00.000Z',
        messages: [message('user', '消息还在')],
        meta: [{ archived: true }],
      }),
    })

    for (const id of ['bad-string', 'bad-number', 'bad-array']) {
      expect((await store.get(id)).map((item) => item.content)).toEqual(['消息还在'])
      expect((await store.summaries()).find((item) => item.id === id)?.archived).toBeUndefined()
    }
    // 只归化为空 meta：不备份、不重建（那会丢消息）
    expect([...fs.files.keys()].filter((item) => item.includes('.corrupt-'))).toEqual([])
    expect(logger.entries.some((line) => line.includes('会话文件解析失败'))).toBe(false)
  })

  it('clear 清空消息但不抹掉归档状态（已装载与未装载两条路径）', async () => {
    const { store, fs } = setup()
    await store.append('quick', { role: 'user', content: 'a' })
    await store.setArchived('quick', true)
    await store.clear('quick')
    expect(await store.get('quick')).toEqual([])
    expect(readFile(fs, 'quick')['messages']).toEqual([])
    expect(metaOf(fs, 'quick')['archived']).toBe(true)
  })

  it('clear 一个尚未装载过的会话时会先读回盘上 meta（不静默丢归档）', async () => {
    const path = sessionFilePath(SESSION_DIR, 'main')
    const { store, fs } = setup({
      [path]: JSON.stringify({
        version: 2,
        sessionId: 'main',
        updatedAt: '2025-01-01T00:00:00.000Z',
        messages: [message('user', '历史提问')],
        meta: { archived: true, archivedAt: '2025-01-01T00:00:00.000Z' },
      }),
    })
    await store.clear('main')
    expect(await store.get('main')).toEqual([])
    expect(metaOf(fs, 'main')['archived']).toBe(true)
    expect(metaOf(fs, 'main')['archivedAt']).toBe('2025-01-01T00:00:00.000Z')
  })
})

describe('SessionStore · 会话绑定项目（chat:setSessionProject，docs/06 §5.1）', () => {
  it('setProject 写盘可往返：重启后 projectOf / summaries 仍带 projectId', async () => {
    const { store, fs } = setup()
    await store.append('quick', { role: 'user', content: 'hi' })
    await store.setProject('quick', 'proj-1')

    // setProject 是 await 写盘的（不靠 300ms 防抖），因此此刻盘上已是最终内容
    expect(metaOf(fs, 'quick')['projectId']).toBe('proj-1')
    expect(store.projectOf('quick')).toBe('proj-1')

    // 模拟重启：同一份磁盘内容、新的 store 实例
    const reloaded = new SessionStore({
      dir: SESSION_DIR,
      fs,
      writeDebounceMs: 0,
      maxMessages: 5,
    })
    expect(await reloaded.projectIdOf('quick')).toBe('proj-1')
    expect((await reloaded.summaries()).find((item) => item.id === 'quick')?.projectId).toBe(
      'proj-1',
    )
    expect(await reloaded.get('quick')).toHaveLength(1)
  })

  it('空串清除绑定且不留空键；幂等（同值 / 双重清除）不写盘', async () => {
    const { store, fs } = setup()
    await store.setProject('quick', 'proj-1')
    const afterBind = fs.writeLog.length

    // 同值幂等
    await store.setProject('quick', 'proj-1')
    expect(fs.writeLog.length).toBe(afterBind)

    await store.setProject('quick', '')
    const afterClear = fs.writeLog.length
    const meta = metaOf(fs, 'quick')
    expect('projectId' in meta).toBe(false)
    expect(store.projectOf('quick')).toBeUndefined()

    // 双重清除幂等：undefined 与 '' 都算「未绑定」，不算变更
    await store.setProject('quick', '')
    await store.setProject('quick', '   ')
    expect(fs.writeLog.length).toBe(afterClear)
  })

  it('未绑定会话 projectOf / projectIdOf 返回 undefined，summaries 不含 projectId 键', async () => {
    const { store } = setup()
    await store.append('quick', { role: 'user', content: 'hi' })

    expect(store.projectOf('quick')).toBeUndefined()
    expect(await store.projectIdOf('quick')).toBeUndefined()
    const summary = (await store.summaries()).find((item) => item.id === 'quick')
    expect(summary?.projectId).toBeUndefined()
    expect('projectId' in (summary ?? {})).toBe(false)
  })

  it('老文件（meta 无 projectId）宽容读出：视为未绑定，只读不重写', async () => {
    const path = sessionFilePath(SESSION_DIR, 'main')
    const { store, fs } = setup({
      [path]: JSON.stringify({
        version: 2,
        sessionId: 'main',
        updatedAt: '2025-01-01T00:00:00.000Z',
        messages: [message('user', '历史提问')],
        meta: { archived: true },
      }),
    })

    expect(await store.projectIdOf('main')).toBeUndefined()
    expect(fs.writeLog).toHaveLength(0)
    expect(readFile(fs, 'main')['version']).toBe(2)
  })

  it('绑定与归档共用同一份 meta：各改各的字段互不覆盖', async () => {
    const { store, fs } = setup()
    await store.append('quick', { role: 'user', content: 'hi' })
    await store.setProject('quick', 'proj-1')
    await store.setArchived('quick', true)

    const meta = metaOf(fs, 'quick')
    expect(meta['projectId']).toBe('proj-1')
    expect(meta['archived']).toBe(true)

    // 清除绑定不动归档
    await store.setProject('quick', '')
    expect(metaOf(fs, 'quick')['archived']).toBe(true)
  })
})

describe('SessionStore · 远程会话管理（centerVisible / permissionMode，docs/12 §6.3）', () => {
  it('setCenterVisible 写盘可往返：重启后 summaries 仍带 centerVisible=false', async () => {
    const { store, fs } = setup()
    await store.append('center-abc', { role: 'user', content: '远程提问' })
    await store.setCenterVisible('center-abc', false)

    expect(metaOf(fs, 'center-abc')['centerVisible']).toBe(false)

    // 模拟重启：同一份磁盘内容、新的 store 实例
    const reloaded = new SessionStore({
      dir: SESSION_DIR,
      fs,
      writeDebounceMs: 0,
      maxMessages: 5,
    })
    const summary = (await reloaded.summaries()).find((item) => item.id === 'center-abc')
    expect(summary?.centerVisible).toBe(false)
    expect(await reloaded.get('center-abc')).toHaveLength(1)
  })

  it('setCenterVisible 置回可见删键且不留 true 空值；缺省可见时幂等不写盘', async () => {
    const { store, fs } = setup()
    // 缺省（undefined）= 可见：置 true 不算变更，不写盘
    await store.setCenterVisible('center-abc', true)
    expect(fs.writeLog).toHaveLength(0)

    await store.setCenterVisible('center-abc', false)
    const afterHide = fs.writeLog.length
    // 同值幂等
    await store.setCenterVisible('center-abc', false)
    expect(fs.writeLog.length).toBe(afterHide)

    await store.setCenterVisible('center-abc', true)
    const meta = metaOf(fs, 'center-abc')
    expect('centerVisible' in meta).toBe(false)
    expect(
      (await store.summaries()).find((item) => item.id === 'center-abc')?.centerVisible,
    ).toBeUndefined()
  })

  it('setPermissionMode 写盘可往返 + summaries 带键；同值幂等；非法值抛错', async () => {
    const { store, fs } = setup()
    await store.setPermissionMode('center-abc', 'readonly')
    expect(metaOf(fs, 'center-abc')['permissionMode']).toBe('readonly')
    expect(await store.permissionModeOf('center-abc')).toBe('readonly')
    expect((await store.summaries()).find((item) => item.id === 'center-abc')?.permissionMode).toBe(
      'readonly',
    )

    // 幂等：同档位不写盘
    const afterFirst = fs.writeLog.length
    await store.setPermissionMode('center-abc', 'readonly')
    expect(fs.writeLog.length).toBe(afterFirst)

    // 非法档位：宁可抛错也不静默落一个"看起来成功实则没生效"的覆盖
    await expect(store.setPermissionMode('center-abc', 'yolo' as never)).rejects.toThrow(
      /非法的权限档位/,
    )
    // 换档仍可继续
    await store.setPermissionMode('center-abc', 'auto')
    expect(await store.permissionModeOf('center-abc')).toBe('auto')
  })

  it('老文件缺字段宽容读出：centerVisible / permissionMode 不带键（缺省可见 / 跟随全局），畸形档位归化为未覆盖', async () => {
    const path = sessionFilePath(SESSION_DIR, 'center-old')
    const { store, fs } = setup({
      [path]: JSON.stringify({
        version: 2,
        sessionId: 'center-old',
        updatedAt: '2025-01-01T00:00:00.000Z',
        messages: [message('user', '历史提问')],
        meta: { permissionMode: 'yolo', archived: true },
      }),
    })

    expect(await store.permissionModeOf('center-old')).toBeUndefined()
    const summary = (await store.summaries()).find((item) => item.id === 'center-old')
    expect(summary?.centerVisible).toBeUndefined()
    expect(summary?.permissionMode).toBeUndefined()
    expect('permissionMode' in (summary ?? {})).toBe(false)
    // 宽容归化不触发写盘：老文件只读不重写
    expect(fs.writeLog).toHaveLength(0)
  })

  it('visibility / permissionMode 与既有 meta 字段共用同一份 meta：互不覆盖', async () => {
    const { store, fs } = setup()
    await store.setCenterVisible('center-abc', false)
    await store.setPermissionMode('center-abc', 'confirm')
    await store.setProject('center-abc', 'proj-1')
    await store.setArchived('center-abc', true)

    const meta = metaOf(fs, 'center-abc')
    expect(meta['centerVisible']).toBe(false)
    expect(meta['permissionMode']).toBe('confirm')
    expect(meta['projectId']).toBe('proj-1')
    expect(meta['archived']).toBe(true)

    // 改可见性不动权限覆盖
    await store.setCenterVisible('center-abc', true)
    expect(metaOf(fs, 'center-abc')['permissionMode']).toBe('confirm')
  })
})
