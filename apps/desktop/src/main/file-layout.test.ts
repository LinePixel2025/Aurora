/**
 * 文件面板版式预览（2026-11-12，docs/07 §2.3）：分步取页 / 缓存命中 / 忙闸门 /
 * 降级文案 / LRU 淘汰删目录 / 超龄 sweep / 边界同源。
 *
 * office-port 用假实现注入（真 CLI 与 Edge 后端由 `chat-file-layout` 截图场景覆盖），
 * 但**产物落盘与目录清理走真实临时目录** —— 这部分没有值得替换的抽象层。
 */
import { promises as nodeFs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OfficeRenderRequest, OfficeRenderResult } from '@aurora/agent-core'
import {
  LAYOUT_CACHE_ENTRIES,
  LAYOUT_MAX_BYTES,
  LAYOUT_SWEEP_MAX_AGE_MS,
  createFileLayoutService,
  type FileLayoutPort,
} from './file-layout.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

let base = ''
let scratch = ''
let cacheRoot = ''
let tmpRoot = ''

beforeEach(async () => {
  base = await nodeFs.mkdtemp(join(tmpdir(), 'aurora-layout-root-'))
  scratch = await nodeFs.mkdtemp(join(tmpdir(), 'aurora-layout-cache-'))
  cacheRoot = join(scratch, 'panel')
  tmpRoot = join(scratch, 'panel-tmp')
  await nodeFs.writeFile(join(base, '书.docx'), 'docx-bytes')
})

afterEach(async () => {
  for (const dir of [base, scratch]) {
    if (dir !== '') await nodeFs.rm(dir, { recursive: true, force: true })
  }
})

interface FakeOptions {
  root?: string | undefined
  busy?: boolean
  pageCount?: number
  labels?: string[]
  fail?: string
}

function fakePort(options: FakeOptions = {}) {
  const calls: OfficeRenderRequest[] = []
  let produced = 0
  const port: FileLayoutPort = {
    rootOf: () => ('root' in options ? options.root : base),
    busy: () => options.busy === true,
    render: async (request) => {
      calls.push(request)
      if (options.fail !== undefined) throw new Error(options.fail)
      // 模拟 office-port：每次新建唯一目录，worker 产物命名恒为 -1.png
      produced += 1
      const dir = join(tmpRoot, `render-${produced}`)
      await nodeFs.mkdir(dir, { recursive: true })
      const file = join(dir, '书-1.png')
      await nodeFs.writeFile(file, PNG)
      const result: OfficeRenderResult = {
        sourcePath: request.path,
        format: 'docx',
        files: [file],
        images: [],
        pageCount: options.pageCount ?? 3,
        warnings: [],
        ...(request.pageIndex === undefined
          ? {}
          : { pageLabels: options.labels ?? ['第 1 页', '第 2 页', '第 3 页'] }),
      }
      return result
    },
  }
  return { calls, port }
}

function serviceOf(port: FileLayoutPort) {
  return createFileLayoutService(port, { cacheRoot, sweepRoot: scratch })
}

async function exists(path: string): Promise<boolean> {
  return await nodeFs
    .stat(path)
    .then(() => true)
    .catch(() => false)
}

describe('file-layout · manifest 与分步取页', () => {
  it('manifest 只带首页，给出页数与页标签', async () => {
    const { calls, port } = fakePort()
    const service = serviceOf(port)
    const manifest = await service.manifest({ sessionId: 's1', path: join(base, '书.docx') })
    expect(manifest.pageCount).toBe(3)
    expect(manifest.format).toBe('docx')
    expect(manifest.pages.map((page) => page.label)).toEqual(['第 1 页', '第 2 页', '第 3 页'])
    expect(manifest.firstPage?.index).toBe(0)
    expect(manifest.firstPage?.dataUrl).toMatch(/^data:image\/png;base64,/)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ mode: 'screenshot', maxPages: 1, pageIndex: 0 })
  })

  it('xlsx 的工作表名当页标签', async () => {
    await nodeFs.writeFile(join(base, '表.xlsx'), 'xlsx-bytes')
    const { port } = fakePort({ pageCount: 2, labels: ['一月', '二月'] })
    const manifest = await serviceOf(port).manifest({
      sessionId: 's1',
      path: join(base, '表.xlsx'),
    })
    expect(manifest.format).toBe('xlsx')
    expect(manifest.pages.map((page) => page.label)).toEqual(['一月', '二月'])
  })

  it('翻到未缓存的页才调 CLI；回头翻已缓存的页零调用', async () => {
    const { calls, port } = fakePort()
    const service = serviceOf(port)
    const manifest = await service.manifest({ sessionId: 's1', path: join(base, '书.docx') })
    expect(calls).toHaveLength(1)

    const second = await service.page({ sessionId: 's1', renderId: manifest.renderId, index: 1 })
    expect(second.index).toBe(1)
    expect(second.bytes).toBe(PNG.length)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.pageIndex).toBe(1)

    await service.page({ sessionId: 's1', renderId: manifest.renderId, index: 0 })
    await service.page({ sessionId: 's1', renderId: manifest.renderId, index: 1 })
    expect(calls).toHaveLength(2)
  })

  it('同一文件重开命中缓存，不再调 CLI；产物落 page-<n>.png', async () => {
    const { calls, port } = fakePort()
    const service = serviceOf(port)
    const first = await service.manifest({ sessionId: 's1', path: join(base, '书.docx') })
    const again = await service.manifest({ sessionId: 's1', path: join(base, '书.docx') })
    expect(again.renderId).toBe(first.renderId)
    expect(calls).toHaveLength(1)
    expect(await exists(join(cacheRoot, 's1', first.renderId, 'page-0.png'))).toBe(true)
    // office-port 的临时目录搬空后即收掉，不留垃圾
    expect(await nodeFs.readdir(tmpRoot).catch(() => [])).toEqual([])
  })

  it('文件改过（mtime 变）换 renderId 重新渲染', async () => {
    const { calls, port } = fakePort()
    const service = serviceOf(port)
    const path = join(base, '书.docx')
    const first = await service.manifest({ sessionId: 's1', path })
    const future = new Date(Date.now() + 5_000)
    await nodeFs.utimes(path, future, future)
    const second = await service.manifest({ sessionId: 's1', path })
    expect(second.renderId).not.toBe(first.renderId)
    expect(calls).toHaveLength(2)
  })
})

describe('file-layout · 闸门与降级', () => {
  it('引擎忙时立即回错，不排队、不调 CLI', async () => {
    const { calls, port } = fakePort({ busy: true })
    await expect(
      serviceOf(port).manifest({ sessionId: 's1', path: join(base, '书.docx') }),
    ).rejects.toThrow('Office 引擎正忙，请稍后重试')
    expect(calls).toHaveLength(0)
  })

  it('缺截图后端换成人话（渲染层据此回落正文）', async () => {
    const { port } = fakePort({
      fail: 'OfficeCLI 未生成截图：x.png。请确认系统已安装 Edge/Chrome/Chromium。',
    })
    await expect(
      serviceOf(port).manifest({ sessionId: 's1', path: join(base, '书.docx') }),
    ).rejects.toThrow('缺少浏览器渲染后端（需要 Edge / Chrome）')
  })

  it('渲染超时换成人话', async () => {
    const { port } = fakePort({ fail: 'OfficeCLI 执行超时（90000ms）' })
    await expect(
      serviceOf(port).manifest({ sessionId: 's1', path: join(base, '书.docx') }),
    ).rejects.toThrow('版式渲染超时')
  })

  it('非 docx/xlsx/pptx 不支持版式；超过 32 MiB 拒绝', async () => {
    const { port } = fakePort()
    const service = serviceOf(port)
    await nodeFs.writeFile(join(base, '论文.pdf'), 'pdf')
    await expect(
      service.manifest({ sessionId: 's1', path: join(base, '论文.pdf') }),
    ).rejects.toThrow('不支持版式预览')

    const huge = join(base, '巨.docx')
    await nodeFs.writeFile(huge, '')
    await nodeFs.truncate(huge, LAYOUT_MAX_BYTES + 1)
    await expect(service.manifest({ sessionId: 's1', path: huge })).rejects.toThrow(
      '超过版式预览上限',
    )
  })

  it('过期 renderId / 跨会话 / 页码越界都如实报错', async () => {
    const { port } = fakePort()
    const service = serviceOf(port)
    const manifest = await service.manifest({ sessionId: 's1', path: join(base, '书.docx') })
    await expect(service.page({ sessionId: 's1', renderId: 'nope', index: 0 })).rejects.toThrow(
      '已过期',
    )
    await expect(
      service.page({ sessionId: 's2', renderId: manifest.renderId, index: 0 }),
    ).rejects.toThrow('不属于当前会话')
    await expect(
      service.page({ sessionId: 's1', renderId: manifest.renderId, index: 3 }),
    ).rejects.toThrow('页码超出范围')
    await expect(
      service.page({ sessionId: 's1', renderId: manifest.renderId, index: -1 }),
    ).rejects.toThrow('页码超出范围')
  })

  it('边界与 read 同源：越界拒绝、缺根拒绝（不调 CLI）', async () => {
    const outside = await nodeFs.mkdtemp(join(tmpdir(), 'aurora-layout-outside-'))
    try {
      const foreign = join(outside, '外.docx')
      await nodeFs.writeFile(foreign, 'docx')
      const { calls, port } = fakePort()
      await expect(serviceOf(port).manifest({ sessionId: 's1', path: foreign })).rejects.toThrow(
        '边界之外',
      )
      expect(calls).toHaveLength(0)

      const rootless = fakePort({ root: undefined })
      await expect(
        serviceOf(rootless.port).manifest({ sessionId: 's1', path: join(base, '书.docx') }),
      ).rejects.toThrow('工作目录')
      expect(rootless.calls).toHaveLength(0)
    } finally {
      await nodeFs.rm(outside, { recursive: true, force: true })
    }
  })
})

describe('file-layout · 产物清理', () => {
  it(`LRU 超过 ${LAYOUT_CACHE_ENTRIES} 份即淘汰最旧的并删目录`, async () => {
    const { port } = fakePort()
    const service = serviceOf(port)
    const ids: string[] = []
    for (let i = 0; i <= LAYOUT_CACHE_ENTRIES; i += 1) {
      const path = join(base, `书${i}.docx`)
      await nodeFs.writeFile(path, `docx-${i}`)
      const manifest = await service.manifest({ sessionId: 's1', path })
      ids.push(manifest.renderId)
    }
    const evicted = ids[0]!
    expect(await exists(join(cacheRoot, 's1', evicted))).toBe(false)
    expect(await exists(join(cacheRoot, 's1', ids[ids.length - 1]!))).toBe(true)
    await expect(service.page({ sessionId: 's1', renderId: evicted, index: 0 })).rejects.toThrow(
      '已过期',
    )
  })

  it('sweep 只删超龄叶子目录，新产物保留', async () => {
    const oldDir = join(cacheRoot, 's1', 'old')
    const newDir = join(cacheRoot, 's1', 'new')
    for (const dir of [oldDir, newDir]) {
      await nodeFs.mkdir(dir, { recursive: true })
      await nodeFs.writeFile(join(dir, 'page-0.png'), PNG)
    }
    const past = (Date.now() - LAYOUT_SWEEP_MAX_AGE_MS - 60_000) / 1000
    await nodeFs.utimes(oldDir, past, past)

    const { port } = fakePort()
    await serviceOf(port).sweep()
    expect(await exists(oldDir)).toBe(false)
    expect(await exists(newDir)).toBe(true)
  })

  it('sweep 顺带收掉 office-port 的超龄临时产物', async () => {
    const stale = join(tmpRoot, 's1', '1700000000000-uuid')
    await nodeFs.mkdir(stale, { recursive: true })
    await nodeFs.writeFile(join(stale, '书-1.png'), PNG)
    const past = (Date.now() - LAYOUT_SWEEP_MAX_AGE_MS - 60_000) / 1000
    await nodeFs.utimes(stale, past, past)
    await serviceOf(fakePort().port).sweep()
    expect(await exists(stale)).toBe(false)
  })

  it('dispose 清掉整个缓存根', async () => {
    const { port } = fakePort()
    const service = serviceOf(port)
    const manifest = await service.manifest({ sessionId: 's1', path: join(base, '书.docx') })
    expect(await exists(join(cacheRoot, 's1', manifest.renderId))).toBe(true)
    await service.dispose()
    expect(await exists(cacheRoot)).toBe(false)
  })
})
