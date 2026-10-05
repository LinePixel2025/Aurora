import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { normalizeSessionId, type TodoItem } from '@aurora/agent-core'
// @aurora/agent-core 的 exports 只暴露 "."，testing 子目录不在导出面上；
// 单测对 dist 产物做深层相对导入（与包本身一样依赖 dist 已构建）。
import { TestFileSystem } from '../../../../../packages/agent-core/dist/testing/fileSystem.js'
import { createMemoryLogger } from '@aurora/shared'
import { createFileTodoPort, type FileTodoPort } from './todo-port.js'

/** 固定测试目录，避免不同平台路径分隔符差异影响断言 */
const TODO_DIR = 'C:\\aurora-test\\todos'

function todo(id: string, content: string, status: TodoItem['status'] = 'pending'): TodoItem {
  return { id, content, status }
}

function setup(options: { debounceMs?: number; seed?: Record<string, string> } = {}) {
  const fs = new TestFileSystem(options.seed ?? {})
  const logger = createMemoryLogger()
  const port: FileTodoPort = createFileTodoPort({
    dir: TODO_DIR,
    fs,
    logger,
    ...(options.debounceMs === undefined ? {} : { writeDebounceMs: options.debounceMs }),
  })
  return { fs, logger, port }
}

/** 让 writeDebounceMs: 0 触发的写盘微任务链排空（mkdirp → writeFileAtomic） */
const drain = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/**
 * 计数文件系统：只统计 `readFile` 次数（断言"并发首读共享同一次读盘"）。
 *
 * 与 SessionStore 侧同款做法：`ensureLoaded` 是私有的，能观察到的只有真实读盘次数。
 */
class CountingFileSystem extends TestFileSystem {
  readCount = 0

  override readFile(path: string): Promise<string> {
    this.readCount += 1
    return super.readFile(path)
  }
}

/** 可挂起下一次写入，用来验证 removeSession 会等在途写盘结束后再删文件。 */
class GatedWriteFileSystem extends TestFileSystem {
  gateHit = false
  private gate: Promise<void> | undefined

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

/** 可挂起下一次读取，用来验证 removeSession 不会被迟到的读盘结果复活。 */
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

describe('FileTodoPort', () => {
  it('write → read 往返；新实例从盘上懒加载同一份', async () => {
    const { fs, port } = setup({ debounceMs: 0 })
    const items = [todo('t1', '第一步', 'in_progress'), todo('t2', '第二步')]
    await port.write('main', items)
    await drain()
    expect(await port.read('main')).toEqual(items)

    const second = createFileTodoPort({ dir: TODO_DIR, fs })
    expect(await second.read('main')).toEqual(items)
  })

  it('懒加载与缓存：write 后 read 命中内存缓存，不回读磁盘', async () => {
    const { fs, port } = setup({ debounceMs: 0 })
    const items = [todo('t1', '真清单')]
    await port.write('s', items)
    await drain()

    // 从磁盘上把文件偷换成另一份 —— read 命中缓存，不受影响
    const path = join(TODO_DIR, 's.json')
    fs.files.set(
      path,
      JSON.stringify({
        version: 1,
        sessionId: 's',
        updatedAt: '',
        todos: [{ id: 'x', content: '盗版', status: 'completed' }],
      }),
    )
    expect(await port.read('s')).toEqual(items)

    // 没有缓存的新实例才读到磁盘上那份
    const fresh = createFileTodoPort({ dir: TODO_DIR, fs })
    expect(await fresh.read('s')).toEqual([todo('x', '盗版', 'completed')])
  })

  it('sessionId 归一：非法字符替换为 _，文件不会逃出目录（防路径穿越）', async () => {
    const { fs, port } = setup({ debounceMs: 0 })
    const items = [todo('t1', '穿越')]
    await port.write('../../evil:session', items)
    await drain()

    const keys = [...fs.files.keys()]
    expect(keys).toHaveLength(1)
    expect(keys[0]).toBe(join(TODO_DIR, `${normalizeSessionId('../../evil:session')}.json`))
    expect(keys[0]?.startsWith(TODO_DIR)).toBe(true)
    // 归一后的会话名读写一致
    expect(await port.read('../../evil:session')).toEqual(items)
  })

  it('默认 300ms 防抖：到期才落盘，窗口内反复写合并为最后一次', async () => {
    vi.useFakeTimers()
    try {
      const { fs, port } = setup()
      const path = join(TODO_DIR, 's.json')
      await port.write('s', [todo('t1', '第一版')])
      await vi.advanceTimersByTimeAsync(299)
      expect(fs.files.has(path)).toBe(false)

      await port.write('s', [todo('t1', '第一版'), todo('t2', '第二版')])
      await vi.advanceTimersByTimeAsync(300)
      expect(fs.files.has(path)).toBe(true)
      const onDisk = JSON.parse(fs.files.get(path) ?? '{}') as { todos: TodoItem[] }
      expect(onDisk.todos).toEqual([todo('t1', '第一版'), todo('t2', '第二版')])
    } finally {
      vi.useRealTimers()
    }
  })

  it('writeDebounceMs: 0 立即落盘（不等防抖窗口）', async () => {
    const { fs, port } = setup({ debounceMs: 0 })
    await port.write('s', [todo('t1', '马上写')])
    await drain()
    expect(fs.writeLog).toContain(join(TODO_DIR, 's.json'))
    expect(fs.files.has(join(TODO_DIR, 's.json'))).toBe(true)
  })

  it('flush 排空：防抖定时器未到期也立即落盘', async () => {
    const { fs, port } = setup()
    await port.write('s', [todo('t1', '退出前')])
    expect(fs.files.size).toBe(0) // 300ms 防抖挂着，尚未写
    await port.flush()
    expect(fs.files.has(join(TODO_DIR, 's.json'))).toBe(true)
    expect(await port.read('s')).toEqual([todo('t1', '退出前')])
  })

  it('写盘失败：回调 onWriteError、保持脏标记，flush 重试成功', async () => {
    const { fs, port } = setup({ debounceMs: 0 })
    const errors: Error[] = []
    const failing = createFileTodoPort({
      dir: TODO_DIR,
      fs,
      writeDebounceMs: 0,
      onWriteError: (error) => errors.push(error),
    })
    fs.failNextWrite = true
    await failing.write('s', [todo('t1', '失败重试')])
    await drain()
    expect(errors).toHaveLength(1)
    expect(fs.files.has(join(TODO_DIR, 's.json'))).toBe(false)

    await failing.flush() // 脏标记还在，重试成功
    expect(fs.files.has(join(TODO_DIR, 's.json'))).toBe(true)
    expect(port.directory).toBe(TODO_DIR)
  })

  it('损坏文件：备份为 .corrupt-<ts>.json 后按空清单继续（读失败不抛）', async () => {
    const path = join(TODO_DIR, 's.json')
    const { fs, logger, port } = setup({ seed: { [path]: '{ 这不是 JSON' } })
    expect(await port.read('s')).toEqual([])

    const backup = [...fs.files.keys()].find((key) => key.includes('s.corrupt-'))
    expect(backup).toBeDefined()
    expect(fs.files.get(backup ?? '')).toBe('{ 这不是 JSON')
    expect(fs.files.has(path)).toBe(false) // 原文件已改名让位
    expect(logger.entries.some((entry) => entry.includes('解析失败'))).toBe(true)

    // 备份之后写入恢复正常
    await port.write('s', [todo('t1', '重建')])
    await port.flush()
    expect(await port.read('s')).toEqual([todo('t1', '重建')])
  })

  it('read 不存在的会话：返回空数组且不创建任何文件', async () => {
    const { fs, port } = setup()
    expect(await port.read('missing')).toEqual([])
    expect(fs.files.size).toBe(0)
    expect(fs.writeLog).toEqual([])
  })

  it('子代理会话（-sub 后缀）与主会话各一份清单（docs/06 §18/§19 约定）', async () => {
    const { fs, port } = setup({ debounceMs: 0 })
    const mainItems = [todo('t1', '主会话任务')]
    const subItems = [todo('t1', '子代理任务')]
    await port.write('main', mainItems)
    await port.write('main-sub', subItems)
    await drain()

    expect(await port.read('main')).toEqual(mainItems)
    expect(await port.read('main-sub')).toEqual(subItems)
    expect(fs.files.has(join(TODO_DIR, 'main.json'))).toBe(true)
    expect(fs.files.has(join(TODO_DIR, 'main-sub.json'))).toBe(true)
  })

  it('removeSession 同时删除主清单与 -sub 清单，并清掉内存缓存', async () => {
    const { fs, port } = setup({ debounceMs: 0 })
    const mainPath = join(TODO_DIR, 'main.json')
    const subPath = join(TODO_DIR, 'main-sub.json')
    await port.write('main', [todo('t1', '主会话任务')])
    await port.write('main-sub', [todo('t1', '子代理任务')])
    await port.flush()
    expect(fs.files.has(mainPath)).toBe(true)
    expect(fs.files.has(subPath)).toBe(true)

    await port.removeSession('main')

    expect(fs.files.has(mainPath)).toBe(false)
    expect(fs.files.has(subPath)).toBe(false)
    expect(await port.read('main')).toEqual([])
    expect(await port.read('main-sub')).toEqual([])
  })

  it('removeSession 取消防抖写入，flush 不会把已删除清单写回来', async () => {
    const { fs, port } = setup()
    const path = join(TODO_DIR, 's.json')
    await port.write('s', [todo('t1', '未到防抖窗口')])
    expect(fs.files.has(path)).toBe(false)

    await port.removeSession('s')
    await port.flush()

    expect(fs.files.has(path)).toBe(false)
    expect(await port.read('s')).toEqual([])
  })

  it('removeSession 等在途写入结束后再删文件，不会被随后完成的写盘复活', async () => {
    const fs = new GatedWriteFileSystem()
    const port = createFileTodoPort({ dir: TODO_DIR, fs, writeDebounceMs: 0 })
    const path = join(TODO_DIR, 's.json')
    const release = fs.blockNextWrite()

    await port.write('s', [todo('t1', '在途写入')])
    await vi.waitFor(() => expect(fs.gateHit).toBe(true))

    const removing = port.removeSession('s')
    release()
    await removing

    expect(fs.files.has(path)).toBe(false)
    expect(await port.read('s')).toEqual([])
  })

  it('removeSession 不会被迟到的在途读盘结果复活', async () => {
    const path = join(TODO_DIR, 's.json')
    const fs = new GatedReadFileSystem({
      [path]: JSON.stringify({
        version: 1,
        sessionId: 's',
        updatedAt: '2025-01-01T00:00:00.000Z',
        todos: [todo('t1', '旧清单', 'in_progress')],
      }),
    })
    const port = createFileTodoPort({ dir: TODO_DIR, fs, writeDebounceMs: 0 })
    const release = fs.blockNextRead()

    const reading = port.read('s')
    await vi.waitFor(() => expect(fs.gateHit).toBe(true))

    const removing = port.removeSession('s')
    release()
    await Promise.all([reading, removing])

    expect(fs.files.has(path)).toBe(false)
    expect(await port.read('s')).toEqual([])
  })

  it('并发首读 + write：写入不被读盘结果盖掉（内存与磁盘都读回刚写的清单）', async () => {
    const path = join(TODO_DIR, 's.json')
    const { fs, port } = setup({
      debounceMs: 0,
      seed: {
        [path]: JSON.stringify({
          version: 1,
          sessionId: 's',
          updatedAt: '2025-01-01T00:00:00.000Z',
          todos: [todo('old', '盘上旧清单')],
        }),
      },
    })

    const items = [todo('t1', '并发写入', 'in_progress')]
    // read 发起读盘、write 同时进入：write 必须等同一份读盘结果，否则会被旧清单盖回去
    await Promise.all([port.read('s'), port.write('s', items)])

    // 关键断言：后续读取看到的是刚写的那份，而不是盘上的旧清单
    expect(await port.read('s')).toEqual(items)

    await port.flush()
    const onDisk = JSON.parse(fs.files.get(path) ?? '{}') as { todos: TodoItem[] }
    expect(onDisk.todos).toEqual(items)
  })

  it('并发两次 read 只触发一次读盘，且后续 read 命中缓存', async () => {
    const path = join(TODO_DIR, 's.json')
    const fs = new CountingFileSystem({
      [path]: JSON.stringify({
        version: 1,
        sessionId: 's',
        updatedAt: '2025-01-01T00:00:00.000Z',
        todos: [todo('t1', '只读一次')],
      }),
    })
    const port = createFileTodoPort({ dir: TODO_DIR, fs, writeDebounceMs: 0 })

    const [first, second] = await Promise.all([port.read('s'), port.read('s')])
    expect(first).toEqual([todo('t1', '只读一次')])
    expect(second).toEqual([todo('t1', '只读一次')])
    expect(fs.readCount).toBe(1)

    // 读盘完成后已置 loaded：第三次读取纯命中缓存
    expect(await port.read('s')).toEqual([todo('t1', '只读一次')])
    expect(fs.readCount).toBe(1)
  })
})
