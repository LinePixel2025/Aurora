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
    expect(persisted.version).toBe(1)
    expect(persisted.sessionId).toBe('quick')
    expect(persisted.messages).toHaveLength(3)
    expect(persisted.messages[2]?.toolCallId).toBe('c1')
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
