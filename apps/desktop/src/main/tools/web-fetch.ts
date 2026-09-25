/**
 * `WebFetchPort` 的主进程实现（Design/betav2-spec.md §8.4、docs/06 §14）。
 *
 * 出网统一走注入的 fetch（主进程装配时传 `netFetch` 的**取值函数**，
 * 使 `advanced.proxy` 改完即刻生效）；HTML 做**简单剥标签**（去 script/style、
 * 标签转空格、常见实体解码），压平空白后按 `MAX_WEB_FETCH_CHARS`（与 agent-core
 * 的常量同源）截断，保证一次抓取吃不掉整个上下文预算。
 *
 * 本文件**不得 import electron**：出网 fetch 由构造参数注入，可在 Node 里完整单测。
 */
import { MAX_WEB_FETCH_CHARS } from '@aurora/agent-core'
import type { WebFetchPort } from '@aurora/agent-core'

/** 回填文本的长度上限；re-export 保证主进程与内核的常量永远同源。 */
export { MAX_WEB_FETCH_CHARS }

export interface NetWebFetchPortOptions {
  /**
   * 出网 fetch 的**取值函数**（每次调用即时取值）：主进程传 `() => netFetch`，
   * 系统代理重建后新请求自动走新链路；返回 undefined 时回落 `globalThis.fetch`。
   */
  fetchImpl: () => typeof fetch | undefined
  /** 抓取超时（默认 20s） */
  timeoutMs?: number
  /** 回填文本上限（默认取 agent-core 的 `MAX_WEB_FETCH_CHARS`） */
  maxChars?: number
}

/** 抓取超时（默认 20s：网页抓取不应比一次 LLM 请求还慢）。 */
const DEFAULT_TIMEOUT_MS = 20_000

export function createNetWebFetchPort(options: NetWebFetchPortOptions): WebFetchPort {
  const maxChars = Math.max(1, Math.floor(options.maxChars ?? MAX_WEB_FETCH_CHARS))
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    async fetch(url: string): Promise<{ status: number; text: string }> {
      assertHttpUrl(url)

      const fetchImpl = resolveFetch(options.fetchImpl)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let response: Response
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
          redirect: 'follow',
          signal: controller.signal,
        })
      } catch (error) {
        if (controller.signal.aborted)
          throw new Error(`抓取超时（${Math.round(timeoutMs / 1000)}s）`)
        throw new Error(`抓取请求失败：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        clearTimeout(timer)
      }

      const raw = await response.text().catch(() => '')
      return { status: response.status, text: flattenText(extractText(raw, response), maxChars) }
    },
  }
}

// ───────────────────────── 内部 ─────────────────────────

function assertHttpUrl(raw: string): void {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`不是合法的网址：${raw}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`只允许 http/https 网址（收到 ${parsed.protocol}）`)
  }
}

function resolveFetch(source: NetWebFetchPortOptions['fetchImpl']): typeof fetch {
  const resolved = source()
  return typeof resolved === 'function' ? resolved : globalThis.fetch
}

/** HTML 内容剥成纯文本；非 HTML（JSON / 纯文本）原样返回（剥标签会误伤 JSON 里的 `<`）。 */
function extractText(raw: string, response: Response): string {
  const mime = (response.headers.get('content-type') ?? '').toLowerCase()
  if (mime !== '' && !mime.includes('html') && !mime.includes('xml')) return raw
  return stripHtml(raw)
}

/**
 * 简单剥标签：注释 → script/style 整块 → 标签转空格 → 常见实体解码。
 * 刻意不做完整 DOM 解析：主进程只要「正文大致可读」即可，解析器自身的
 * 安全面（脚本执行、资源加载）因此完全不存在。
 */
function stripHtml(raw: string): string {
  return raw
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, decodeNamedEntity)
    .replace(/&#(\d+);/g, (_, code: string) => fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => fromCodePoint(Number.parseInt(code, 16)))
}

function decodeNamedEntity(entity: string): string {
  switch (entity) {
    case '&amp;':
      return '&'
    case '&lt;':
      return '<'
    case '&gt;':
      return '>'
    case '&quot;':
      return '"'
    case '&#39;':
    case '&apos;':
      return "'"
    case '&nbsp;':
      return ' '
    default:
      return entity
  }
}

function fromCodePoint(code: number): string {
  return Number.isFinite(code) && code >= 0 ? String.fromCodePoint(code) : ''
}

/** 压平空白（含换行）为单空格并截断；截断时加省略标记，让模型知道内容不完整。 */
function flattenText(text: string, maxChars: number): string {
  const flattened = text.replace(/\s+/g, ' ').trim()
  if (flattened.length <= maxChars) return flattened
  return `${flattened.slice(0, maxChars)}…（已截断，原文共 ${flattened.length} 字符）`
}
