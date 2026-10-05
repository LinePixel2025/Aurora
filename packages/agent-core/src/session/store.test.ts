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
    await store.append('quick', { role: 'user', content: '你好', requestId: 'req-1' })
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
    expect(persisted.version).toBe(7)
    expect(persisted.sessionId).toBe('quick')
    expect(persisted.messages).toHaveLength(3)
    expect(persisted.messages[0]?.requestId).toBe('req-1')
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

  it('usageTotals 按会话前缀汇总真实 meta.usage，不混入普通会话', async () => {
    const { store, fs } = setup()
    await store.addUsage('awareness-a', {
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cachedTokens: 40,
    })
    await store.addUsage('awareness-b', {
      promptTokens: 50,
      completionTokens: 10,
      totalTokens: 60,
      cachedTokens: 0,
    })
    await store.addUsage('chat-c', {
      promptTokens: 999,
      completionTokens: 1,
      totalTokens: 1_000,
    })
    await store.flush()
    expect(await store.usageTotals('awareness-')).toEqual({
      promptTokens: 150,
      completionTokens: 30,
      totalTokens: 180,
      cachedTokens: 40,
      rounds: 2,
    })
    expect(await store.usageTotals('missing-')).toBeUndefined()

    const reloaded = new SessionStore({
      dir: SESSION_DIR,
      fs,
      logger: createMemoryLogger(),
      writeDebounceMs: 0,
    })
    expect(await reloaded.usageTotals('awareness-')).toEqual({
      promptTokens: 150,
      completionTokens: 30,
      totalTokens: 180,
      cachedTokens: 40,
      rounds: 2,
    })
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
      requestId: 'req-history',
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
    expect(history[0]?.requestId).toBe('req-history')
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

  it('对话展示图片随工具卡持久化：历史只投影无路径元数据，displayImageOf 保留内部路径', async () => {
    const { store, fs } = setup()
    await store.append('quick', {
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 'c-img',
          name: 'show_image',
          arguments: '{"path":"result.png"}',
          state: 'success',
          displayImages: [
            {
              id: 'img-1',
              path: 'C:\\work\\result.png',
              name: 'result.png',
              mime: 'image/png',
              caption: '最终结果',
            },
          ],
        },
      ],
    })
    await store.flush()

    const history = await store.rendererHistory('quick')
    expect(history[0]?.toolCalls?.[0]?.displayImages).toEqual([
      { id: 'img-1', name: 'result.png', mime: 'image/png', caption: '最终结果' },
    ])
    expect(history[0]?.toolCalls?.[0]?.input).toEqual({ name: 'result.png' })
    expect(JSON.stringify(history)).not.toContain('C:\\\\work')
    expect(await store.displayImageOf('quick', 'img-1')).toEqual({
      id: 'img-1',
      path: 'C:\\work\\result.png',
      name: 'result.png',
      mime: 'image/png',
      caption: '最终结果',
    })

    const persisted = JSON.parse(fs.files.get(`${SESSION_DIR}\\quick.json`) ?? '{}') as {
      version: number
    }
    expect(persisted.version).toBe(7)
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

  it('meta.title 优先于首条消息回退，并随会话落盘 / 重读', async () => {
    const { store, fs } = setup()
    await store.append('main', { role: 'user', content: '原始需求很长很长' })
    await expect(store.setTitle('main', '整理数学作业')).resolves.toBe(true)
    expect((await store.summaries()).find((item) => item.id === 'main')?.title).toBe('整理数学作业')
    expect(metaOf(fs, 'main')['title']).toBe('整理数学作业')

    const reopened = new SessionStore({ dir: SESSION_DIR, fs, writeDebounceMs: 0 })
    expect((await reopened.summaries()).find((item) => item.id === 'main')?.title).toBe(
      '整理数学作业',
    )
  })

  it('pending 与空会话只改内存：首条消息落盘时才写入 meta', async () => {
    const { store, fs } = setup()
    const id = await store.createSession()
    expect(await store.markTitlePending(id)).toBe(true)
    expect(await store.titleStateOf(id)).toEqual({ pending: true })
    expect((await fs.readdir(SESSION_DIR)).includes(`${id}.json`)).toBe(false)

    await store.append(id, { role: 'user', content: '第一条需求' })
    await store.flush()
    expect(metaOf(fs, id)['titleState']).toBe('pending')

    expect(await store.setTitle(id, '整理第一条需求')).toBe(true)
    expect(metaOf(fs, id)['title']).toBe('整理第一条需求')
    expect(metaOf(fs, id)['titleState']).toBeUndefined()
  })

  it('标题写入幂等；已删会话不会被异步标题结果复活', async () => {
    const { store, fs } = setup()
    await store.append('gone', { role: 'user', content: '需求' })
    await store.setTitle('gone', '原标题')
    await store.remove('gone')

    await expect(store.setTitle('gone', '迟到标题')).resolves.toBe(false)
    await expect(store.markTitlePending('gone')).resolves.toBe(false)
    expect((await fs.readdir(SESSION_DIR)).includes('gone.json')).toBe(false)
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

  it('persistEmptySession 让外部激活目标先进入会话列表，且仍是空会话', async () => {
    const { store, fs } = setup()
    const id = await store.createSession({ space: 'agent' })
    expect(await fs.exists(sessionFilePath(SESSION_DIR, id))).toBe(false)
    await store.persistEmptySession(id)
    expect(await fs.exists(sessionFilePath(SESSION_DIR, id))).toBe(true)
    expect(await store.listSessions()).toContain(id)
    expect(await store.get(id)).toEqual([])
  })
})

describe('SessionStore · 会话空间（docs/06 §4 会话三分，2026-09-30）', () => {
  it('createSession({ space: "work" }) 只写内存：列表立即按空间分组，空会话不落盘', async () => {
    const { store, fs } = setup()
    const id = await store.createSession({ space: 'work' })

    const summaries = await store.summaries()
    expect(summaries.find((item) => item.id === id)?.space).toBe('work')
    expect(store.spaceOf(id)).toBe('work')
    // 空会话不落盘（与不带 space 的 createSession 同一条不变量）
    const files = await fs.readdir(SESSION_DIR)
    expect(files.some((name) => name === `${id}.json`)).toBe(false)

    // 首条消息落盘时 meta.space 随消息一起写入
    await store.append(id, { role: 'user', content: '第一条' })
    await store.flush()
    expect(metaOf(fs, id)['space']).toBe('work')
  })

  it('spaceOf 缺省归一为 agent；agent 空间不带键（缺省值不产生空值键）', async () => {
    const { store, fs } = setup()
    const id = await store.createSession({ space: 'agent' })

    expect(store.spaceOf('never-seen')).toBe('agent')
    expect(store.spaceOf(id)).toBe('agent')
    const summaries = await store.summaries()
    const item = summaries.find((entry) => entry.id === id)
    expect(item?.space).toBeUndefined()
    await store.append(id, { role: 'user', content: '第一条' })
    await store.flush()
    expect(metaOf(fs, id)['space']).toBeUndefined()
  })

  it('setSpace 往返：写入 work、改回 agent 删键；幂等不重复写盘', async () => {
    const { store, fs } = setup()
    await store.append('s1', { role: 'user', content: 'a' })
    await store.flush()

    await store.setSpace('s1', 'work')
    expect(store.spaceOf('s1')).toBe('work')
    expect(metaOf(fs, 's1')['space']).toBe('work')

    await store.setSpace('s1', 'work') // 幂等
    await store.setSpace('s1', 'agent')
    expect(store.spaceOf('s1')).toBe('agent')
    expect(metaOf(fs, 's1')['space']).toBeUndefined()

    // 重新从磁盘装载仍能读出空间
    await store.setSpace('s1', 'work')
    await store.flush()
    const reopened = new SessionStore({ dir: SESSION_DIR, fs, writeDebounceMs: 0 })
    await reopened.append('s1', { role: 'user', content: 'b' })
    expect(reopened.spaceOf('s1')).toBe('work')
  })

  it('setSpace 非法值抛错； summaries 对未标记会话不带 space 键', async () => {
    const { store } = setup()
    await expect(store.setSpace('s1', 'code' as never)).rejects.toThrow()
    await store.append('s1', { role: 'user', content: 'a' })
    const summaries = await store.summaries()
    expect(summaries.find((item) => item.id === 's1')?.space).toBeUndefined()
  })
})

describe('SessionStore · 真删除会话（chat:deleteSession，docs/08 会话管理页）', () => {
  it('remove 删掉盘上文件并清空内存态，删完不再出现在列表里', async () => {
    const { store, fs } = setup()
    await store.append('s1', { role: 'user', content: 'a' })
    await store.flush()
    expect((await fs.readdir(SESSION_DIR)).includes('s1.json')).toBe(true)

    await store.remove('s1')
    expect((await fs.readdir(SESSION_DIR)).includes('s1.json')).toBe(false)
    expect(await store.listSessions()).not.toContain('s1')
    expect((await store.summaries()).some((item) => item.id === 's1')).toBe(false)
  })

  it('remove 撤掉防抖定时器与脏标记：删完不会被待写状态「写回来」', async () => {
    const { store, fs } = setup()
    await store.append('s1', { role: 'user', content: 'a' })
    // 不 flush：此刻脏标记与防抖定时器都挂着（这正是「删了又回来」的现场）
    await store.remove('s1')
    await store.flush()
    expect((await fs.readdir(SESSION_DIR)).includes('s1.json')).toBe(false)
  })

  it('remove 幂等：文件不存在（从未落盘的空会话）不报错', async () => {
    const { store } = setup()
    await expect(store.remove('never-written')).resolves.toBeUndefined()
  })

  it('remove 清掉 meta 绑定：删掉再同名重建（重新 append）不残留项目 / 空间', async () => {
    const { store, fs } = setup()
    await store.append('s1', { role: 'user', content: 'a' })
    await store.setProject('s1', 'proj-1')
    await store.setSpace('s1', 'work')
    await store.remove('s1')

    // 同名会话重新出现时读的是新文件（旧 meta 不残留）
    await store.append('s1', { role: 'user', content: 'b' })
    await store.flush()
    expect(store.projectOf('s1')).toBeUndefined()
    expect(store.spaceOf('s1')).toBe('agent')
    expect(metaOf(fs, 's1')['projectId']).toBeUndefined()
    expect(metaOf(fs, 's1')['space']).toBeUndefined()
  })
})

describe('SessionStore · 读盘错误两态（P2-01）与删除竞态（P2-02）', () => {
  /** 可注入一次读盘异常的会话文件系统（`TestFileSystem.readFile` 只能用 ENOENT 表达缺失） */
  class FlakyReadFileSystem extends TestFileSystem {
    failNextRead: Error | undefined

    override readFile(path: string): Promise<string> {
      const error = this.failNextRead
      if (error !== undefined) {
        this.failNextRead = undefined
        return Promise.reject(error)
      }
      return super.readFile(path)
    }
  }

  /** 可让下一次写盘挂在闸门上的会话文件系统（造「在途写盘」现场） */
  class GatedWriteFileSystem extends TestFileSystem {
    gateHit = false
    private gate: Promise<void> | undefined

    /** 挂起下一次 `writeFileAtomic`，返回放行函数 */
    blockNextWrite(): () => void {
      let release: () => void = () => undefined
      this.gate = new Promise<void>((resolve) => {
        release = resolve
      })
      return release
    }

    override async writeFileAtomic(path: string, content: string): Promise<void> {
      const gate = this.gate
      this.gate = undefined
      if (gate !== undefined) {
        this.gateHit = true
        await gate
      }
      return super.writeFileAtomic(path, content)
    }
  }

  /** 轮询等待条件成立（超时即抛，避免"条件其实没达成"的假绿） */
  async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('等待条件超时')
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }

  const seedPath = (id: string): string => sessionFilePath(SESSION_DIR, id)
  const seedFile = (id: string): string =>
    JSON.stringify({
      version: 2,
      sessionId: id,
      updatedAt: '2025-01-01T00:00:00.000Z',
      messages: [message('user', '历史提问')],
    })
  const storedMessages = (fs: TestFileSystem, id: string): string[] => {
    const parsed = JSON.parse(fs.files.get(seedPath(id)) ?? '{}') as { messages?: unknown }
    return Array.isArray(parsed.messages)
      ? (parsed.messages as StoredMessage[]).map((item) => item.content)
      : []
  }

  it('读盘抛非 ENOENT 错误（EPERM）：上抛而不返回空快照，下次访问重试仍读回历史', async () => {
    const fs = new FlakyReadFileSystem({ [seedPath('main')]: seedFile('main') })
    const store = new SessionStore({ dir: SESSION_DIR, fs, writeDebounceMs: 0, maxMessages: 5 })
    const eperm = Object.assign(new Error('EPERM: operation not permitted, open main.json'), {
      code: 'EPERM',
    })

    fs.failNextRead = eperm
    await expect(store.get('main')).rejects.toThrow(/EPERM/)
    // 关键：没有把「读错误」当成「文件不存在」——盘上数据一条没动，也没触发写盘
    expect(storedMessages(fs, 'main')).toEqual(['历史提问'])
    expect(fs.writeLog).toEqual([])

    // 下一次访问重新读盘：拿到的是磁盘上的真实历史（而不是被置位的空快照）
    expect((await store.get('main')).map((item) => item.content)).toEqual(['历史提问'])
  })

  it('读盘错误期间 append：不落盘（更谈不上用空快照覆盖磁盘历史）', async () => {
    const fs = new FlakyReadFileSystem({ [seedPath('main')]: seedFile('main') })
    const store = new SessionStore({ dir: SESSION_DIR, fs, writeDebounceMs: 0, maxMessages: 5 })
    fs.failNextRead = Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })

    await expect(store.append('main', { role: 'user', content: '新消息' })).rejects.toThrow(/EBUSY/)
    await store.flush()
    expect(fs.writeLog).toEqual([])
    expect(storedMessages(fs, 'main')).toEqual(['历史提问'])

    // 读盘恢复后追加：磁盘历史与新消息都在（旧写法会把文件覆盖成「只有新消息」）
    await store.append('main', { role: 'user', content: '新消息' })
    await store.flush()
    expect(storedMessages(fs, 'main')).toEqual(['历史提问', '新消息'])
  })

  it('在途写盘期间 remove：文件保持已删除（不被在途那次写重建）', async () => {
    const fs = new GatedWriteFileSystem()
    const store = new SessionStore({ dir: SESSION_DIR, fs, writeDebounceMs: 0, maxMessages: 5 })

    const release = fs.blockNextWrite()
    const appending = store.append('s1', { role: 'user', content: 'a' })
    await waitFor(() => fs.gateHit) // 写盘已进入 writeFileAtomic（脏标记检查早已通过）

    const removing = store.remove('s1')
    release()
    await appending
    await removing

    expect(fs.files.has(seedPath('s1'))).toBe(false)
    // 之后的 flush 也不会把它写回来（脏标记与在途写都收干净了）
    await store.flush()
    expect(fs.files.has(seedPath('s1'))).toBe(false)
    expect(await store.listSessions()).not.toContain('s1')
  })

  it('在途写盘失败 + 并发 remove：不把已删会话写回空文件（脏标记不再复亮）', async () => {
    /** 下一次 `writeFileAtomic` 直接抛错（造「在途写失败」），其余照常 */
    class FailingWriteFileSystem extends TestFileSystem {
      failNextWrite = false
      override async writeFileAtomic(path: string, content: string): Promise<void> {
        if (this.failNextWrite) {
          this.failNextWrite = false
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
        }
        return super.writeFileAtomic(path, content)
      }
    }
    const fs = new FailingWriteFileSystem({ [seedPath('main')]: seedFile('main') })
    const store = new SessionStore({ dir: SESSION_DIR, fs, writeDebounceMs: 0, maxMessages: 5 })

    fs.failNextWrite = true
    await store.append('main', { role: 'user', content: '新消息' })
    await store.remove('main')
    // `remove` 之后 flush：写盘失败那次**不得**把 id 重新点亮成脏（否则会用空
    // messages 把已删会话重建出来 ——「删了又回来」的另一半）
    await store.flush()
    expect(fs.files.has(seedPath('main'))).toBe(false)
    expect(await store.listSessions()).not.toContain('main')
  })

  it('读盘在途时 remove：读盘完成后不把已删会话复活（幽灵条目）', async () => {
    /** 让下一次 `readFile` 挂在闸门上的会话文件系统（造「在途读盘」现场） */
    class GatedReadFileSystem extends TestFileSystem {
      gateHit = false
      private gate: Promise<void> | undefined

      blockNextRead(): () => void {
        let release: () => void = () => undefined
        this.gate = new Promise<void>((resolve) => {
          release = resolve
        })
        return release
      }

      override async readFile(path: string): Promise<string> {
        const gate = this.gate
        this.gate = undefined
        if (gate !== undefined) {
          this.gateHit = true
          await gate
        }
        return super.readFile(path)
      }
    }
    const fs = new GatedReadFileSystem({ [seedPath('main')]: seedFile('main') })
    const store = new SessionStore({ dir: SESSION_DIR, fs, writeDebounceMs: 0, maxMessages: 5 })

    const release = fs.blockNextRead()
    const reading = store.get('main')
    await waitFor(() => fs.gateHit)

    const removing = store.remove('main')
    release() // 读盘现在才完成 —— 结果必须被丢弃
    await reading
    await removing

    expect(fs.files.has(seedPath('main'))).toBe(false)
    expect(await store.listSessions()).not.toContain('main')
    // 内存里也没有那份被复活的历史：再次访问按「文件不存在」给出空会话
    expect(await store.get('main')).toEqual([])
  })

  it('summaries() 逐条隔离：单个会话读盘失败只跳过它，不拖垮整张列表', async () => {
    const fs = new FlakyReadFileSystem({
      [seedPath('main')]: seedFile('main'),
      [seedPath('other')]: seedFile('other'),
    })
    const store = new SessionStore({ dir: SESSION_DIR, fs, writeDebounceMs: 0, maxMessages: 5 })
    fs.failNextRead = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })

    // 第一条（id 排序在前的 main）失败被跳过，其它的照常返回 —— 而不是整表 reject
    expect((await store.summaries()).map((item) => item.id)).toEqual(['other'])
    // 只是「这一次跳过」：下次访问自愈（读错误仍然不产生空快照冲盘）
    expect((await store.summaries()).map((item) => item.id).sort()).toEqual(['main', 'other'])
  })

  it('summaries() 不把未装载会话的消息常驻内存；第二次命中摘要缓存不重复读盘', async () => {
    const fs = new CountingFileSystem({
      [seedPath('a')]: seedFile('a'),
      [seedPath('b')]: seedFile('b'),
    })
    const store = new SessionStore({ dir: SESSION_DIR, fs, writeDebounceMs: 0, maxMessages: 5 })

    expect((await store.summaries()).map((item) => item.id).sort()).toEqual(['a', 'b'])
    // 只为算摘要临时装载过，算完立刻释放：内存里不保留任何会话消息
    expect(store.loadedSessionCount).toBe(0)

    const readsAfterFirst = fs.readCount
    expect((await store.summaries()).map((item) => item.id).sort()).toEqual(['a', 'b'])
    // 摘要缓存命中：第二次不再读盘
    expect(fs.readCount).toBe(readsAfterFirst)
  })

  it('超过 maxLoadedSessions 的干净会话被淘汰，重读后内容不丢', async () => {
    const store = new SessionStore({
      dir: SESSION_DIR,
      fs: new TestFileSystem(),
      writeDebounceMs: 0,
      maxMessages: 5,
      maxLoadedSessions: 1,
      loadedIdleMs: 0,
    })
    await store.append('a', { role: 'user', content: 'A' })
    await store.flush()
    await store.append('b', { role: 'user', content: 'B' })
    await store.flush()

    // 装载 b 时容量超 1，a 干净且空闲 → 被淘汰；b 保留
    expect(store.loadedSessionCount).toBe(1)
    // 再次访问 a 自动重读，内容不丢
    expect((await store.get('a')).map((item) => item.content)).toEqual(['A'])
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
    expect(persisted['version']).toBe(7)
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
    expect(persisted['version']).toBe(7)
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
    // 只读不该顺手重写老文件：盘上那份仍是它自己的 v2（读取侧对 v1 / v2 都宽容）
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

describe('SessionStore · 会话级模型覆盖（chat:setSessionModel，docs/06 §3）', () => {
  it('setModelOverride 写盘可往返：重启后 modelOverrideOf / summaries 仍带 llm', async () => {
    const { store, fs } = setup({
      [`${SESSION_DIR}\\s1.json`]: JSON.stringify({
        version: 3,
        sessionId: 's1',
        updatedAt: '2025-01-01T00:00:00.000Z',
        messages: [message('user', '你好')],
      }),
    })
    await store.setModelOverride('s1', { providerId: 'p1', model: 'm-a' })
    expect(metaOf(fs, 's1')['llm']).toEqual({ providerId: 'p1', model: 'm-a' })

    // 重新构造 store（模拟重启）：从磁盘装载后仍读得到覆盖
    const fs2 = new TestFileSystem({ ...Object.fromEntries(fs.files) })
    const store2 = new SessionStore({ dir: SESSION_DIR, fs: fs2, writeDebounceMs: 0 })
    // 同步读依赖「会话已装载」这条装配不变量（内核 send 前的会话列表拉取），先 get 装载
    await store2.get('s1')
    expect(store2.modelOverrideOf('s1')).toEqual({ providerId: 'p1', model: 'm-a' })
    const summaries = await store2.summaries()
    expect(summaries.find((item) => item.id === 's1')?.llm).toEqual({
      providerId: 'p1',
      model: 'm-a',
    })
  })

  it('null / 空串清除覆盖且不留空键；同值幂等不写盘', async () => {
    const { store, fs } = setup()
    await store.setModelOverride('s2', { providerId: 'p1', model: 'm-a' })
    const writes = fs.writeLog.length

    // 同值幂等：不写盘
    await store.setModelOverride('s2', { providerId: 'p1', model: 'm-a' })
    expect(fs.writeLog.length).toBe(writes)

    // 空串 / null 都按清除处理（删键，不留 `"llm": {...空}`）
    await store.setModelOverride('s2', null)
    expect('llm' in metaOf(fs, 's2')).toBe(false)
    expect(store.modelOverrideOf('s2')).toBeUndefined()

    // 双重清除幂等
    const afterClear = fs.writeLog.length
    await store.setModelOverride('s2', null)
    expect(fs.writeLog.length).toBe(afterClear)

    // providerId / model 任一为空 = 清除（不落半截条目）
    await store.setModelOverride('s2', { providerId: '', model: 'm-a' })
    expect('llm' in metaOf(fs, 's2')).toBe(false)
    await store.setModelOverride('s2', { providerId: 'p1', model: '  ' })
    expect('llm' in metaOf(fs, 's2')).toBe(false)
  })

  it('未覆盖会话 modelOverrideOf 返回 undefined，summaries 不含 llm 键（也不多写空 meta）', async () => {
    const { store, fs } = setup({
      [`${SESSION_DIR}\\s3.json`]: JSON.stringify({
        version: 3,
        sessionId: 's3',
        updatedAt: '2025-01-01T00:00:00.000Z',
        messages: [message('user', '你好')],
      }),
    })
    expect(store.modelOverrideOf('s3')).toBeUndefined()
    const summaries = await store.summaries()
    expect(summaries.find((item) => item.id === 's3')).not.toHaveProperty('llm')
    // 只读不重写：磁盘上仍没有 meta 键
    expect(readFile(fs, 's3')['meta']).toBeUndefined()
  })

  it('老文件 / 畸形 llm 宽容读出：半截条目（缺 providerId / 非字符串）按未覆盖处理', async () => {
    const { store } = setup({
      [`${SESSION_DIR}\\s4.json`]: JSON.stringify({
        version: 3,
        sessionId: 's4',
        updatedAt: '2025-01-01T00:00:00.000Z',
        messages: [message('user', '你好')],
        meta: { llm: { providerId: 'p1' } },
      }),
      [`${SESSION_DIR}\\s5.json`]: JSON.stringify({
        version: 3,
        sessionId: 's5',
        updatedAt: '2025-01-01T00:00:00.000Z',
        messages: [message('user', '你好')],
        meta: { llm: 'not-an-object' },
      }),
      [`${SESSION_DIR}\\s6.json`]: JSON.stringify({
        version: 3,
        sessionId: 's6',
        updatedAt: '2025-01-01T00:00:00.000Z',
        messages: [message('user', '你好')],
        meta: { llm: { providerId: '  ', model: 'm-a' } },
      }),
    })
    expect(await store.summaries()).toBeDefined() // 装载三条
    expect(store.modelOverrideOf('s4')).toBeUndefined()
    expect(store.modelOverrideOf('s5')).toBeUndefined()
    expect(store.modelOverrideOf('s6')).toBeUndefined()
  })

  it('模型覆盖与既有 meta 字段共用同一份 meta：互不覆盖', async () => {
    const { store, fs } = setup()
    await store.setModelOverride('center-x', { providerId: 'p2', model: 'm-b' })
    await store.setPermissionMode('center-x', 'auto')
    await store.setProject('center-x', 'proj-2')

    const meta = metaOf(fs, 'center-x')
    expect(meta['llm']).toEqual({ providerId: 'p2', model: 'm-b' })
    expect(meta['permissionMode']).toBe('auto')
    expect(meta['projectId']).toBe('proj-2')

    // 改权限不动模型覆盖
    await store.setPermissionMode('center-x', 'readonly')
    expect(metaOf(fs, 'center-x')['llm']).toEqual({ providerId: 'p2', model: 'm-b' })
  })
})

describe('SessionStore · 提问留痕（StoredSession.asks，docs/12 §5）', () => {
  function record(requestId: string, createdAt = '2025-01-02T00:00:00.000Z') {
    return {
      requestId,
      question: `问题 ${requestId}`,
      multiSelect: false,
      answers: ['A'],
      outcome: 'answered' as const,
      createdAt,
      settledAt: createdAt,
    }
  }

  it('appendAskRecord 落盘可往返：重启后 rendererHistoryWithAsks 仍带 kind=ask 条目', async () => {
    const { store, fs } = setup()
    await store.append('center-a', { role: 'user', content: '你好' })
    await store.appendAskRecord('center-a', record('ask-1'))
    await store.flush()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const persisted = JSON.parse(fs.files.get(`${SESSION_DIR}\\center-a.json`) ?? '{}') as {
      asks?: unknown[]
    }
    expect(persisted.asks).toHaveLength(1)

    const store2 = new SessionStore({
      dir: SESSION_DIR,
      fs: new TestFileSystem({ ...Object.fromEntries(fs.files) }),
      writeDebounceMs: 0,
    })
    const history = await store2.rendererHistoryWithAsks('center-a')
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({ kind: 'ask', content: '问题 ask-1' })
    expect(history[0]!.ask).toMatchObject({ outcome: 'answered', answers: ['A'] })
    expect(history[1]).toMatchObject({ role: 'user' })
  })

  it('同一 requestId 重复追加按覆盖（幂等）；有界环保留最近 50 条', async () => {
    const { store } = setup()
    await store.appendAskRecord('center-b', record('ask-1'))
    await store.appendAskRecord('center-b', { ...record('ask-1'), answers: ['B'] })
    await store.flush()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await store.asksOf('center-b')).toHaveLength(1)
    expect((await store.asksOf('center-b'))[0]!.answers).toEqual(['B'])

    for (let index = 0; index < 60; index += 1) {
      await store.appendAskRecord('center-c', record(`ask-${index}`))
    }
    await store.flush()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const kept = await store.asksOf('center-c')
    expect(kept).toHaveLength(50)
    expect(kept[0]!.requestId).toBe('ask-10')
  })

  it('畸形留痕按整条丢弃，且不影响消息读出（旁路字段不触发损坏备份）', async () => {
    const { store } = setup({
      [`${SESSION_DIR}\\center-d.json`]: JSON.stringify({
        version: 4,
        sessionId: 'center-d',
        updatedAt: '2025-01-01T00:00:00.000Z',
        messages: [message('user', '你好')],
        asks: [
          { requestId: 'ok', question: 'q', createdAt: 'x', settledAt: 'y', outcome: 'answered' },
          { requestId: 42, question: 'q' },
          'not-an-object',
        ],
      }),
    })
    expect(await store.asksOf('center-d')).toHaveLength(1)
    expect(await store.get('center-d')).toHaveLength(1)
    // 没有 meta / asks 之外的东西被顺手写回（只读不重写）
    expect(await store.summaries()).toHaveLength(1)
  })
})
