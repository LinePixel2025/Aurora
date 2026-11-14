/**
 * 把目标交给系统（2026-11-12，docs/07 §2.3）：用**真实临时目录** + 假 shell 测。
 * 重点是边界判定与 `preview:read` 同源，以及 openPath 的「非空串即失败」约定。
 */
import { promises as nodeFs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { OPEN_TIMEOUT_MS, openWithSystem, type FileOpenShell } from './file-open.js'

let base = ''
let file = ''
let dir = ''

beforeAll(async () => {
  base = await nodeFs.mkdtemp(join(tmpdir(), 'aurora-fileopen-'))
  file = join(base, 'note.txt')
  dir = join(base, 'sub')
  await nodeFs.writeFile(file, '正文', 'utf8')
  await nodeFs.mkdir(dir, { recursive: true })
})

afterAll(async () => {
  if (base !== '') await nodeFs.rm(base, { recursive: true, force: true })
})

function port(root?: string) {
  return { rootOf: () => root }
}

function shellSpy(failure = ''): FileOpenShell & {
  openPath: ReturnType<typeof vi.fn>
  showItemInFolder: ReturnType<typeof vi.fn>
} {
  return {
    openPath: vi.fn().mockResolvedValue(failure),
    showItemInFolder: vi.fn(),
  }
}

describe('openWithSystem（右栏文件面板交给系统）', () => {
  it('default 打开普通文件；reveal 定位目录', async () => {
    const api = shellSpy()
    await openWithSystem(port(base), api, { sessionId: 's1', path: file, mode: 'default' })
    expect(api.openPath).toHaveBeenCalledWith(file)

    await openWithSystem(port(base), api, { sessionId: 's1', path: dir, mode: 'reveal' })
    expect(api.showItemInFolder).toHaveBeenCalledWith(dir)
  })

  it('default 不接受目录', async () => {
    const api = shellSpy()
    await expect(
      openWithSystem(port(base), api, { sessionId: 's1', path: dir, mode: 'default' }),
    ).rejects.toThrow('不是普通文件')
    expect(api.openPath).not.toHaveBeenCalled()
  })

  it('openPath 返回非空串即失败，原文回给用户', async () => {
    const api = shellSpy('没有关联的应用程序')
    await expect(
      openWithSystem(port(base), api, { sessionId: 's1', path: file, mode: 'default' }),
    ).rejects.toThrow('没有关联的应用程序')
  })

  it('边界与 preview:read 同源：越界拒绝、缺根拒绝（不退回无边界）', async () => {
    const outside = await nodeFs.mkdtemp(join(tmpdir(), 'aurora-fileopen-outside-'))
    try {
      const api = shellSpy()
      await expect(
        openWithSystem(port(base), api, {
          sessionId: 's1',
          path: join(outside, 'secret.txt'),
          mode: 'default',
        }),
      ).rejects.toThrow('边界之外')
      await expect(
        openWithSystem(port(undefined), api, { sessionId: 's1', path: file, mode: 'default' }),
      ).rejects.toThrow('没有可用的工作目录')
      expect(api.openPath).not.toHaveBeenCalled()
      expect(api.showItemInFolder).not.toHaveBeenCalled()
    } finally {
      await nodeFs.rm(outside, { recursive: true, force: true })
    }
  })

  it('不存在的路径如实报错', async () => {
    await expect(
      openWithSystem(port(base), shellSpy(), {
        sessionId: 's1',
        path: join(base, 'missing.txt'),
        mode: 'default',
      }),
    ).rejects.toThrow('不存在')
  })

  it('系统迟迟不响应时按失败报出（面板不能永远锁在 opening）', async () => {
    const api: FileOpenShell = {
      openPath: () => new Promise<string>(() => undefined),
      showItemInFolder: () => undefined,
    }
    await expect(
      openWithSystem(port(base), api, { sessionId: 's1', path: file, mode: 'default' }, 30),
    ).rejects.toThrow('超时')
    expect(OPEN_TIMEOUT_MS).toBeGreaterThan(1000)
  })
})
