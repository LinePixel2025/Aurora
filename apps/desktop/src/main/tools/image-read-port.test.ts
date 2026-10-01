/**
 * `ViewImagePort` 的单测（图像工具，docs/06 §25）。
 *
 * 这一组钉的是**两层判定的顺序**与各自的证据：
 * - app 自有目录（`generated` / `screenshots` / `clipboard`）**跳过项目根校验**读得到 ——
 *   顺序反过来的话，「看看你刚画的图」会被自己的边界拦住（`<userData>` 在 `%APPDATA%`，
 *   正常永远在任何项目根之外）；
 * - 其余路径走与 `read_file` 同一条 realpath 边界，根外**拒绝且不读盘**；
 * - 大小 / 空文件 / 读失败沿用附件管线那一套降级文案。
 *
 * io 是注入的假端口，因此不需要真实图片文件。
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { ImageReadPort } from '../attachments.js'
import { IMAGE_MAX_BYTES } from '../attachments.js'
import { createViewImagePort } from './image-read-port.js'
import { OUTSIDE_NOTE } from './image-read.js'

const ROOT = process.cwd()
const USER_DATA = join(ROOT, 'userData')
const OWNED = ['generated', 'screenshots', 'clipboard'].map((name) => join(USER_DATA, name))
const INSIDE = join(ROOT, 'cat.png')
const OUTSIDE = join(ROOT, '..', 'outside.png')

interface Harness {
  port: ReturnType<typeof createViewImagePort>
  reads: string[]
}

function createHarness(
  options: { sizes?: Record<string, number>; readError?: unknown } = {},
): Harness {
  const reads: string[] = []
  const io: ImageReadPort = {
    sizeOf: async (path) => {
      const size = options.sizes?.[path]
      return size ?? 1024
    },
    readFile: async (path) => {
      if (options.readError !== undefined) throw options.readError
      reads.push(path)
      return Buffer.from([1, 2, 3])
    },
  }
  // 边界根 = 当前工作目录（真实存在的目录），因此 realpath 能解析出来
  return {
    port: createViewImagePort({
      io,
      guard: { workspaceRoot: () => ROOT },
      ownedDirs: OWNED,
    }),
    reads,
  }
}

describe('createViewImagePort', () => {
  it('项目根内的图片：读得到，并带回解析后的绝对路径与 MIME', async () => {
    const { port, reads } = createHarness()
    const result = await port.view({ path: INSIDE, sessionId: 's1' })

    expect(result.note).toBeUndefined()
    expect(result.path).toBe(INSIDE)
    expect(result.image?.mimeType).toBe('image/png')
    expect(result.image?.dataBase64).toBe(Buffer.from([1, 2, 3]).toString('base64'))
    expect(result.image?.name).toBe('cat.png')
    expect(reads).toEqual([INSIDE])
  })

  it('app 自有目录：**跳过**项目根校验（生图 / 截屏 / 剪贴板产物必须能回看）', async () => {
    const { port } = createHarness()
    for (const dir of OWNED) {
      const result = await port.view({ path: join(dir, '1-a.png'), sessionId: 's1' })
      expect(result.image).toBeDefined()
    }
  })

  it('项目根之外：拒绝、给出可操作提示，且**不读盘**', async () => {
    const { port, reads } = createHarness()
    const result = await port.view({ path: OUTSIDE, sessionId: 's1' })

    expect(result.image).toBeUndefined()
    expect(result.note).toBe(OUTSIDE_NOTE)
    expect(reads).toEqual([])
  })

  it('非图片扩展名：在边界判定**之前**就拦下（不把文本当图片读）', async () => {
    const { port, reads } = createHarness()
    const result = await port.view({ path: join(ROOT, 'AGENTS.md'), sessionId: 's1' })

    expect(result.note).toContain('read_file')
    expect(reads).toEqual([])
  })

  it('超过单图上限：如实说明（与附件管线同一个 8 MiB 上限）', async () => {
    const { port, reads } = createHarness({ sizes: { [INSIDE]: IMAGE_MAX_BYTES + 1 } })
    const result = await port.view({ path: INSIDE, sessionId: 's1' })

    expect(result.image).toBeUndefined()
    expect(result.note).toContain('上限')
    expect(reads).toEqual([])
  })

  it('读盘抛错：转成 note（端口只回结果，不抛给工具层）', async () => {
    const { port } = createHarness({ readError: new Error('磁盘读取失败') })
    const result = await port.view({ path: INSIDE, sessionId: 's1' })

    expect(result.image).toBeUndefined()
    expect(result.note).toContain('磁盘读取失败')
  })

  it('空白路径：直接拒绝，不触碰 io', async () => {
    const { port, reads } = createHarness()
    const result = await port.view({ path: '   ', sessionId: 's1' })
    expect(result.image).toBeUndefined()
    expect(reads).toEqual([])
  })

  it('没配 guard（无边界）：行为与"没有边界校验"一致，照常读', async () => {
    const io: ImageReadPort = { sizeOf: async () => 10, readFile: async () => Buffer.from([9]) }
    const port = createViewImagePort({ io, ownedDirs: [] })
    const result = await port.view({ path: OUTSIDE, sessionId: 's1' })
    expect(result.image).toBeDefined()
  })
})
