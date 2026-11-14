/**
 * 文件面板的 Office 版式预览（2026-11-12，docs/07 §2.3）。
 *
 * 与正文提取是两条独立链路：这里走 OfficeCLI 截图（需要 Edge/Chrome 后端），
 * **另实例化一个 office-port**，只调 `render()`，不进 Agent 工具表 —— Agent 侧口径零变化。
 *
 * 分步取页：manifest 只带首页，其余页按 index 单取。一次推 N 张 base64 会撑爆 IPC。
 * 产物移入自管缓存目录（worker 命名恒为 `-1.png`，不能直接当缓存 key），命中缓存零 CLI 调用。
 *
 * 清理：内存 LRU 6 个 renderId（淘汰即删目录）+ 启动 sweep 超龄产物 + 退出清缓存根。
 * 引擎与 Agent 办公工具共用一条 worker，忙时**立即回错不排队**（人在等，不能排几十秒队尾）。
 */
import { createHash } from 'node:crypto'
import { promises as nodeFs } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import type { OfficeRenderRequest, OfficeRenderResult } from '@aurora/agent-core'
import type {
  FileLayoutFormat,
  FileLayoutManifest,
  FileLayoutPage,
  FileLayoutPageRequest,
  FileLayoutRequest,
} from '@aurora/shared'
import { assertPreviewPath, type PreviewPathPort } from './preview-path.js'

/** 同时保留的渲染份数：淘汰即删磁盘目录，避免产物无限膨胀 */
export const LAYOUT_CACHE_ENTRIES = 6
export const LAYOUT_MAX_BYTES = 32 * 1024 * 1024
export const LAYOUT_SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000

const DATA_URL_PREFIX = 'data:image/png;base64,'
const LAYOUT_FORMATS = new Map<string, FileLayoutFormat>([
  ['.docx', 'docx'],
  ['.xlsx', 'xlsx'],
  ['.pptx', 'pptx'],
])

export interface FileLayoutPort extends PreviewPathPort {
  render(request: OfficeRenderRequest): Promise<OfficeRenderResult>
  /** OfficeCLI worker 是否正被占用（`OfficePool.running`） */
  busy(): boolean
}

export interface FileLayoutOptions {
  /** 自管缓存根（生产 = `userData/office-previews/panel`） */
  cacheRoot: string
  /** sweep 根（生产 = `userData/office-previews`，同时收掉 office-port 的临时产物） */
  sweepRoot: string
  logger?: { warn(message: string, detail?: Record<string, unknown>): void }
  now?: () => number
}

export interface FileLayoutService {
  manifest(request: FileLayoutRequest): Promise<FileLayoutManifest>
  page(request: FileLayoutPageRequest): Promise<FileLayoutPage>
  /** 启动时清掉超龄产物（全仓此前缺这一环） */
  sweep(): Promise<void>
  dispose(): Promise<void>
}

interface LayoutEntry {
  renderId: string
  sessionId: string
  sourcePath: string
  format: FileLayoutFormat
  dir: string
  pageCount: number
  labels: string[]
  warnings: string[]
  /** index → 已落盘的缓存页 */
  pages: Map<number, string>
}

export function createFileLayoutService(
  port: FileLayoutPort,
  options: FileLayoutOptions,
): FileLayoutService {
  const entries = new Map<string, LayoutEntry>()
  const now = options.now ?? Date.now

  const warn = (message: string, detail?: Record<string, unknown>): void => {
    options.logger?.warn(message, detail)
  }

  function assertIdle(): void {
    if (port.busy()) throw new Error('Office 引擎正忙，请稍后重试')
  }

  /** Map 的插入序即 LRU：命中就重新插到队尾，超限淘汰队首并删目录。 */
  async function remember(entry: LayoutEntry): Promise<void> {
    entries.delete(entry.renderId)
    entries.set(entry.renderId, entry)
    while (entries.size > LAYOUT_CACHE_ENTRIES) {
      const oldest = entries.keys().next()
      if (oldest.done === true) break
      const evicted = entries.get(oldest.value)
      entries.delete(oldest.value)
      if (evicted !== undefined) {
        await nodeFs.rm(evicted.dir, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

  async function renderInto(
    entry: LayoutEntry,
    index: number,
  ): Promise<{ dataUrl: string; bytes: number }> {
    const cached = entry.pages.get(index)
    if (cached !== undefined) {
      const bytes = await nodeFs.readFile(cached).catch(() => undefined)
      if (bytes !== undefined) {
        return { dataUrl: `${DATA_URL_PREFIX}${bytes.toString('base64')}`, bytes: bytes.length }
      }
      entry.pages.delete(index)
    }
    assertIdle()
    let result: OfficeRenderResult
    try {
      result = await port.render({
        path: entry.sourcePath,
        mode: 'screenshot',
        maxPages: 1,
        pageIndex: index,
        sessionId: entry.sessionId,
      })
    } catch (error) {
      throw layoutError(error)
    }
    const produced = result.files[0]
    if (produced === undefined) throw new Error('版式渲染没有产出页面')
    entry.pageCount = result.pageCount ?? entry.pageCount
    if (result.pageLabels !== undefined) entry.labels = result.pageLabels
    entry.warnings = result.warnings

    const target = join(entry.dir, `page-${index}.png`)
    await nodeFs.mkdir(entry.dir, { recursive: true })
    try {
      await nodeFs.rename(produced, target)
    } catch {
      // 跨卷 rename 会失败：退回复制 + 删源
      await nodeFs.copyFile(produced, target)
      await nodeFs.rm(produced, { force: true }).catch(() => undefined)
    }
    // office-port 每次渲染都新建一个唯一目录；搬走产物后收掉空壳，不留垃圾
    await nodeFs.rm(dirname(produced), { recursive: true, force: true }).catch(() => undefined)
    entry.pages.set(index, target)
    const bytes = await nodeFs.readFile(target)
    return { dataUrl: `${DATA_URL_PREFIX}${bytes.toString('base64')}`, bytes: bytes.length }
  }

  async function manifestOf(entry: LayoutEntry): Promise<FileLayoutManifest> {
    const first = await renderInto(entry, 0)
    const pageCount = Math.max(1, entry.pageCount)
    return {
      renderId: entry.renderId,
      sourcePath: entry.sourcePath,
      format: entry.format,
      pageCount,
      pages: Array.from({ length: pageCount }, (_, index) => ({
        index,
        label: entry.labels[index] ?? `第 ${index + 1} 页`,
      })),
      firstPage: { index: 0, dataUrl: first.dataUrl, bytes: first.bytes },
      warnings: entry.warnings,
    }
  }

  return {
    async manifest(request) {
      const { path } = await assertPreviewPath(port, request)
      const format = LAYOUT_FORMATS.get(extname(path).toLowerCase())
      if (format === undefined) throw new Error('该格式不支持版式预览（仅 docx / xlsx / pptx）')
      const stat = await nodeFs.stat(path).catch(() => undefined)
      if (stat === undefined || !stat.isFile()) throw new Error('文件不存在或无法访问')
      if (stat.size > LAYOUT_MAX_BYTES) {
        throw new Error('文档超过版式预览上限（32 MB），请用系统默认程序打开')
      }
      const renderId = createHash('sha1')
        .update(`${path}|${stat.mtimeMs}|${stat.size}`)
        .digest('hex')
        .slice(0, 16)
      let entry = entries.get(renderId)
      if (entry === undefined) {
        entry = {
          renderId,
          sessionId: request.sessionId,
          sourcePath: path,
          format,
          dir: join(options.cacheRoot, safeSegment(request.sessionId), renderId),
          pageCount: 0,
          labels: [],
          warnings: [],
          pages: new Map(),
        }
      }
      await remember(entry)
      return await manifestOf(entry)
    },

    async page(request) {
      const entry = entries.get(request.renderId)
      if (entry === undefined) throw new Error('版式渲染已过期，请重新打开该文件')
      if (entry.sessionId !== request.sessionId) throw new Error('版式渲染不属于当前会话')
      // 每次翻页都重校验边界：会话根可能已经变了
      await assertPreviewPath(port, { sessionId: request.sessionId, path: entry.sourcePath })
      const index = Math.trunc(request.index)
      if (!Number.isFinite(index) || index < 0 || index >= Math.max(1, entry.pageCount)) {
        throw new Error('页码超出范围')
      }
      await remember(entry)
      const rendered = await renderInto(entry, index)
      return { index, dataUrl: rendered.dataUrl, bytes: rendered.bytes }
    },

    async sweep() {
      const cutoff = now() - LAYOUT_SWEEP_MAX_AGE_MS
      await pruneOld(options.sweepRoot, cutoff, 3)
      for (const [renderId, entry] of [...entries]) {
        const stat = await nodeFs.stat(entry.dir).catch(() => undefined)
        if (stat === undefined) entries.delete(renderId)
      }
    },

    async dispose() {
      entries.clear()
      await nodeFs
        .rm(options.cacheRoot, { recursive: true, force: true })
        .catch((error: unknown) => {
          warn('退出前清理版式缓存失败', { error: String(error) })
        })
    },
  }
}

/** 只删超龄的**叶子目录**（产物就是 png），再收掉空壳；深度封顶防意外递归。 */
async function pruneOld(dir: string, cutoff: number, depth: number): Promise<void> {
  const children = await readDirs(dir)
  if (children.length === 0) {
    const stat = await nodeFs.stat(dir).catch(() => undefined)
    if (stat !== undefined && stat.mtimeMs < cutoff) {
      await nodeFs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
    return
  }
  if (depth <= 0) return
  for (const child of children) await pruneOld(join(dir, child), cutoff, depth - 1)
  if ((await readDirs(dir)).length === 0) {
    await nodeFs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function readDirs(dir: string): Promise<string[]> {
  const items = await nodeFs.readdir(dir, { withFileTypes: true }).catch(() => undefined)
  if (items === undefined) return []
  return items.filter((item) => item.isDirectory()).map((item) => item.name)
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^\p{L}\p{N}._-]+/gu, '_')
  return cleaned === '' ? 'session' : cleaned
}

/** 把 CLI 的原始报错换成用户能据此行动的话（渲染层再决定回落正文）。 */
function layoutError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('Edge/Chrome') || message.includes('no_screenshot_backend')) {
    return new Error('缺少浏览器渲染后端（需要 Edge / Chrome）')
  }
  if (message.includes('超时') || message.includes('timed out')) {
    return new Error('版式渲染超时')
  }
  return new Error(message)
}
