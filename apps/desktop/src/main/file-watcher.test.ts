import { describe, expect, it } from 'vitest'
import { AuroraFileWatcher, extOf, shouldIgnore, type WatcherLike } from './file-watcher.js'

/** 假 chokidar：手动触发 add / error 事件 */
function fakeWatcher(): WatcherLike & {
  emitAdd(path: string): void
  emitChange(path: string): void
  emitError(error: unknown): void
  closed: boolean
} {
  const addListeners: Array<(path: string) => void> = []
  const changeListeners: Array<(path: string) => void> = []
  const errorListeners: Array<(error: unknown) => void> = []
  const watcher = {
    closed: false,
    on(event: 'add' | 'change' | 'error', listener: (payload: never) => void) {
      if (event === 'add') addListeners.push(listener as (path: string) => void)
      else if (event === 'change') changeListeners.push(listener as (path: string) => void)
      else errorListeners.push(listener as (error: unknown) => void)
      return watcher
    },
    async close() {
      watcher.closed = true
    },
    emitAdd(path: string) {
      for (const listener of addListeners) listener(path)
    },
    emitChange(path: string) {
      for (const listener of changeListeners) listener(path)
    },
    emitError(error: unknown) {
      for (const listener of errorListeners) listener(error)
    },
  }
  return watcher
}

/** 等待所有已排队的微任务与一次宏任务 */
function settle(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('shouldIgnore', () => {
  it('忽略隐藏文件与 Office 临时文件', () => {
    expect(shouldIgnore('.gitignore')).toBe(true)
    expect(shouldIgnore('~$数学作业.docx')).toBe(true)
  })

  it('忽略下载中间态与临时扩展名', () => {
    expect(shouldIgnore('a.pdf.crdownload')).toBe(true)
    expect(shouldIgnore('a.pdf.part')).toBe(true)
    expect(shouldIgnore('a.tmp')).toBe(true)
    expect(shouldIgnore('a.TEMP')).toBe(true)
  })

  it('忽略系统缩略图缓存', () => {
    expect(shouldIgnore('Thumbs.db')).toBe(true)
    expect(shouldIgnore('desktop.ini')).toBe(true)
    expect(shouldIgnore('.DS_Store')).toBe(true)
  })

  it('忽略编辑器交换文件', () => {
    expect(shouldIgnore('a.swp')).toBe(true)
    expect(shouldIgnore('a.swo')).toBe(true)
  })

  it('正常文档不忽略', () => {
    expect(shouldIgnore('数学作业.pdf')).toBe(false)
    expect(shouldIgnore('课件.pptx')).toBe(false)
  })
})

describe('extOf', () => {
  it('取小写扩展名', () => {
    expect(extOf('a.PDF')).toBe('pdf')
    expect(extOf('a.b.docx')).toBe('docx')
  })

  it('无扩展名或点开头时不返回扩展名', () => {
    expect(extOf('README')).toBe('')
    expect(extOf('.env')).toBe('')
    expect(extOf('trailing.')).toBe('')
  })
})

describe('AuroraFileWatcher', () => {
  it('稳定文件触发回调（含扩展名与大小）', async () => {
    const watcher = fakeWatcher()
    const fileWatcher = new AuroraFileWatcher({
      createWatcher: () => watcher,
      statFile: async () => ({ sizeBytes: 1234, mtimeMs: 1_700_000_000_000 }),
    })
    const seen: Array<{
      fileName: string
      ext: string
      sizeBytes: number
      mtimeMs: number
    }> = []
    fileWatcher.onAdd((file) => seen.push(file))

    await fileWatcher.watch('D:\\感知')
    watcher.emitAdd('D:\\感知\\数学作业.pdf')
    await settle()

    expect(seen).toEqual([
      {
        path: 'D:\\感知\\数学作业.pdf',
        fileName: '数学作业.pdf',
        ext: 'pdf',
        sizeBytes: 1234,
        mtimeMs: 1_700_000_000_000,
      },
    ])
    expect(fileWatcher.watching).toBe(true)
  })

  it('忽略临时文件（不触发回调）', async () => {
    const watcher = fakeWatcher()
    const fileWatcher = new AuroraFileWatcher({
      createWatcher: () => watcher,
      statFile: async () => ({ sizeBytes: 1, mtimeMs: 1_700_000_000_000 }),
    })
    const seen: string[] = []
    fileWatcher.onAdd((file) => seen.push(file.fileName))

    await fileWatcher.watch('D:\\感知')
    watcher.emitAdd('D:\\感知\\~$数学.docx')
    watcher.emitAdd('D:\\感知\\a.pdf.crdownload')
    await settle()
    expect(seen).toEqual([])
  })

  it('忽略子目录中的文件（depth:0 的防御性校验，避免自触发）', async () => {
    const watcher = fakeWatcher()
    const fileWatcher = new AuroraFileWatcher({
      createWatcher: () => watcher,
      statFile: async () => ({ sizeBytes: 1, mtimeMs: 1_700_000_000_000 }),
    })
    const seen: string[] = []
    fileWatcher.onAdd((file) => seen.push(file.fileName))

    await fileWatcher.watch('D:\\感知')
    watcher.emitAdd('D:\\感知\\分类\\数学\\已归类.pdf')
    await settle()
    expect(seen).toEqual([])
  })

  it('文件在处理前消失 → 跳过且不抛错', async () => {
    const watcher = fakeWatcher()
    const fileWatcher = new AuroraFileWatcher({
      createWatcher: () => watcher,
      statFile: async () => undefined,
    })
    const seen: string[] = []
    fileWatcher.onAdd((file) => seen.push(file.fileName))

    await fileWatcher.watch('D:\\感知')
    watcher.emitAdd('D:\\感知\\gone.pdf')
    await settle()
    expect(seen).toEqual([])
  })

  it('suppress 过的路径不再触发（防止管线自身移动造成循环）', async () => {
    const watcher = fakeWatcher()
    const fileWatcher = new AuroraFileWatcher({
      createWatcher: () => watcher,
      statFile: async () => ({ sizeBytes: 1, mtimeMs: 1_700_000_000_000 }),
    })
    const seen: string[] = []
    fileWatcher.onAdd((file) => seen.push(file.fileName))

    await fileWatcher.watch('D:\\感知')
    fileWatcher.suppress('D:\\感知\\a.pdf')
    watcher.emitAdd('D:\\感知\\a.pdf')
    await settle()
    expect(seen).toEqual([])
  })

  it('重复 watch 会先关闭旧监听（幂等，不泄漏 watcher）', async () => {
    const first = fakeWatcher()
    const second = fakeWatcher()
    const watchers = [first, second]
    let index = 0
    const fileWatcher = new AuroraFileWatcher({
      createWatcher: () => watchers[index++]!,
      statFile: async () => ({ sizeBytes: 1, mtimeMs: 1_700_000_000_000 }),
    })

    await fileWatcher.watch('D:\\A')
    await fileWatcher.watch('D:\\B')
    expect(first.closed).toBe(true)
    expect(second.closed).toBe(false)
    expect(fileWatcher.watchDir).toBe('D:\\B')
  })

  it('stop 后不再回调，且 watching 为 false', async () => {
    const watcher = fakeWatcher()
    const fileWatcher = new AuroraFileWatcher({
      createWatcher: () => watcher,
      statFile: async () => ({ sizeBytes: 1, mtimeMs: 1_700_000_000_000 }),
    })
    const seen: string[] = []
    fileWatcher.onAdd((file) => seen.push(file.fileName))

    await fileWatcher.watch('D:\\感知')
    await fileWatcher.stop()
    watcher.emitAdd('D:\\感知\\a.pdf')
    await settle()
    expect(seen).toEqual([])
    expect(fileWatcher.watching).toBe(false)
  })

  it('监听报错只记日志，不影响后续事件', async () => {
    const watcher = fakeWatcher()
    const logs: string[] = []
    const fileWatcher = new AuroraFileWatcher({
      createWatcher: () => watcher,
      statFile: async () => ({ sizeBytes: 1, mtimeMs: 1_700_000_000_000 }),
      logger: {
        info: () => undefined,
        debug: () => undefined,
        warn: (message) => logs.push(message),
      },
    })
    const seen: string[] = []
    fileWatcher.onAdd((file) => seen.push(file.fileName))

    await fileWatcher.watch('D:\\感知')
    watcher.emitError(new Error('EPERM'))
    watcher.emitAdd('D:\\感知\\a.pdf')
    await settle()

    expect(logs.join()).toContain('文件监听出错')
    expect(seen).toEqual(['a.pdf'])
  })

  it('回调抛错不影响其它回调', async () => {
    const watcher = fakeWatcher()
    const fileWatcher = new AuroraFileWatcher({
      createWatcher: () => watcher,
      statFile: async () => ({ sizeBytes: 1, mtimeMs: 1_700_000_000_000 }),
    })
    const seen: string[] = []
    fileWatcher.onAdd(() => {
      throw new Error('callback boom')
    })
    fileWatcher.onAdd((file) => seen.push(file.fileName))

    await fileWatcher.watch('D:\\感知')
    watcher.emitAdd('D:\\感知\\a.pdf')
    await settle()
    expect(seen).toEqual(['a.pdf'])
  })

  it('取消订阅后不再回调', async () => {
    const watcher = fakeWatcher()
    const fileWatcher = new AuroraFileWatcher({
      createWatcher: () => watcher,
      statFile: async () => ({ sizeBytes: 1, mtimeMs: 1_700_000_000_000 }),
    })
    const seen: string[] = []
    const off = fileWatcher.onAdd((file) => seen.push(file.fileName))

    await fileWatcher.watch('D:\\感知')
    off()
    watcher.emitAdd('D:\\感知\\a.pdf')
    await settle()
    expect(seen).toEqual([])
  })
})
describe('AuroraFileWatcher · change 事件（docs/05 §3.2）', () => {
  // 路径用拼接构造，避免源码里出现转义反斜杠（可读性也更好）
  const SEP = String.fromCharCode(92)
  const DIR = 'D:' + SEP + '感知'
  const FILE = DIR + SEP + '作业.pdf'

  it('文件被覆盖（change）同样触发回调，交由上层按签名去重', async () => {
    const watcher = fakeWatcher()
    const fileWatcher = new AuroraFileWatcher({
      createWatcher: () => watcher,
      statFile: async () => ({ sizeBytes: 2048, mtimeMs: 1_700_000_100_000 }),
    })
    const seen: Array<{ fileName: string; sizeBytes: number; mtimeMs: number }> = []
    fileWatcher.onAdd((file) => seen.push(file))

    await fileWatcher.watch(DIR)
    watcher.emitAdd(FILE)
    await settle()
    watcher.emitChange(FILE)
    await settle()

    // 两次都应上报：是否重复处理由分类管线按 (路径, 大小, 修改时间) 决定，
    // 监听层不做业务判断——否则「内容变了要重新分类」这件事永远收不到通知。
    expect(seen).toHaveLength(2)
    expect(seen[1]?.mtimeMs).toBe(1_700_000_100_000)
  })

  it('change 也遵守忽略规则与子目录校验', async () => {
    const watcher = fakeWatcher()
    const fileWatcher = new AuroraFileWatcher({
      createWatcher: () => watcher,
      statFile: async () => ({ sizeBytes: 1, mtimeMs: 1 }),
    })
    const seen: string[] = []
    fileWatcher.onAdd((file) => seen.push(file.fileName))

    await fileWatcher.watch(DIR)
    watcher.emitChange(DIR + SEP + '~' + String.fromCharCode(36) + '作业.docx')
    watcher.emitChange(DIR + SEP + '分类' + SEP + '作业.pdf')
    await settle()
    expect(seen).toEqual([])
  })

  it('change 也受抑制集约束（避免管线自身移动造成重复处理）', async () => {
    const watcher = fakeWatcher()
    const fileWatcher = new AuroraFileWatcher({
      createWatcher: () => watcher,
      statFile: async () => ({ sizeBytes: 1, mtimeMs: 1 }),
    })
    const seen: string[] = []
    fileWatcher.onAdd((file) => seen.push(file.fileName))

    await fileWatcher.watch(DIR)
    fileWatcher.suppress(FILE)
    watcher.emitChange(FILE)
    await settle()
    expect(seen).toEqual([])
  })
})
