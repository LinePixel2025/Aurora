/**
 * 文件面板的文档正文提取（2026-11-12，docs/07 §2.3）。
 *
 * 为什么另开一条池：分类 / 自感知共用的提取池是**串行**的，且被后台管线长期占用，
 * 预览排进去就是几十秒队尾，违背「点开即看」。这里复用 `ExtractPool` 类、另实例化一条
 * 预览专用池（装配层负责），本文件只做薄封装 + 内存 LRU。
 *
 * 缓存 key 带 mtime 与 size：文件改过就自然失效，不需要监听。
 */
import type { ExtractPoolRequest, ExtractPoolResult } from './extract-pool.js'
import type { DocumentBody } from './file-preview.js'

export interface PreviewExtractPool {
  extract(request: ExtractPoolRequest): Promise<ExtractPoolResult>
}

/** 反复点开同一批文件是常态；12 条足够覆盖一屏，单条 512KB 封顶防内存膨胀。 */
export const PREVIEW_BODY_CACHE_ENTRIES = 12
export const PREVIEW_BODY_MAX_BYTES = 512 * 1024

export interface PreviewExtractor {
  documentBodyOf(
    path: string,
    ext: string,
    sizeBytes: number,
    mtimeMs: number,
  ): Promise<DocumentBody>
  clear(): void
}

export function createPreviewExtractor(pool: PreviewExtractPool): PreviewExtractor {
  const cache = new Map<string, DocumentBody>()
  return {
    async documentBodyOf(path, ext, sizeBytes, mtimeMs) {
      const key = `${path}|${mtimeMs}|${sizeBytes}`
      const hit = cache.get(key)
      if (hit !== undefined) {
        cache.delete(key)
        cache.set(key, hit)
        return hit
      }
      const result = await pool.extract({ path, ext, sizeBytes, bodyOnly: true })
      // 降级路径只有文件名证据、没有 body：如实报错，让面板给信息卡 + 系统打开
      if (result.body === undefined) {
        throw new Error(result.warnings[0] ?? '文档正文提取失败')
      }
      if (result.body.trim() === '') throw new Error('文档没有可显示的正文')
      const body: DocumentBody = { body: result.body, warnings: result.warnings }
      if (Buffer.byteLength(result.body, 'utf8') <= PREVIEW_BODY_MAX_BYTES) {
        cache.set(key, body)
        while (cache.size > PREVIEW_BODY_CACHE_ENTRIES) {
          const oldest = cache.keys().next()
          if (oldest.done === true) break
          cache.delete(oldest.value)
        }
      }
      return body
    },
    clear() {
      cache.clear()
    },
  }
}
