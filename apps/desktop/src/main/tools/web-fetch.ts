/**
 * `WebFetchPort` 的主进程实现（Design/betav2-spec.md §8.4、docs/06 §14）。
 *
 * 出网统一走注入的 fetch（主进程装配时传 `netFetch` 的**取值函数**，
 * 使 `advanced.proxy` 改完即刻生效）；HTML 做**简单剥标签**（去 script/style、
 * 标签转空格、常见实体解码），压平空白后按 `MAX_WEB_FETCH_CHARS`（与 agent-core
 * 的常量同源）截断，保证一次抓取吃不掉整个上下文预算。
 *
 * 超时覆盖**整次抓取**（含 body 读取）、body 走**限量流式读取**（P2-09）——
 * 拿到响应头就清计时器 / 整份 `response.text()` 会让慢速或超大 body 挂住整轮 agentLoop。
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

/**
 * body 读取的软上限倍率（P2-09）：以 `maxChars` 为基准再留一截余量 ——
 * HTML 要先剥标签再截断，卡死在 `maxChars` 会让剥完标签的正文明显短于上限。
 * 内存上界因此是「倍率 × 上限」字符（默认 4 × 20000），仍是常数级、不可能 OOM，
 * 而 `response.text()` 那种「整份读进来再截断」的量级随之消失。
 */
const BODY_READ_HEADROOM = 4

export function createNetWebFetchPort(options: NetWebFetchPortOptions): WebFetchPort {
  const maxChars = Math.max(1, Math.floor(options.maxChars ?? MAX_WEB_FETCH_CHARS))
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  /** 流式读取的字符上限：读满即 abort，不再为「回填用不上的内容」继续下载（P2-09） */
  const readLimit = maxChars * BODY_READ_HEADROOM

  return {
    async fetch(url: string): Promise<{ status: number; text: string }> {
      assertHttpUrl(url)

      const fetchImpl = resolveFetch(options.fetchImpl)
      const controller = new AbortController()
      // 超时覆盖**整次抓取**（含 body 读取）：拿到响应头就 clearTimeout 会让
      // 「响应头秒回、body 停滞」的服务器把工具挂住数分钟并阻塞整轮 agentLoop（P2-09）。
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
      try {
        let response: Response
        try {
          response = await fetchImpl(url, {
            method: 'GET',
            headers: { Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
            redirect: 'follow',
            signal: controller.signal,
          })
        } catch (error) {
          if (timedOut) throw timeoutError(timeoutMs)
          throw new Error(`抓取请求失败：${errorMessage(error)}`)
        }

        const body = await readBodyLimited(response, readLimit, controller, () => timedOut)
        return {
          status: response.status,
          text: flattenText(extractText(body.text, response), maxChars, body.truncated),
        }
      } catch (error) {
        // body 阶段被超时 abort 打断（reader.read() 拒绝）也归到同一个超时口径
        if (timedOut) throw timeoutError(timeoutMs)
        throw error
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

// ───────────────────────── 内部 ─────────────────────────

function timeoutError(timeoutMs: number): Error {
  const shown = timeoutMs < 1000 ? `${timeoutMs}ms` : `${Math.round(timeoutMs / 1000)}s`
  return new Error(`抓取超时（${shown}）`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 限量流式读取 body（P2-09）：
 *
 * - 按 chunk 解码、累计到 `limit` 个字符即主动 `controller.abort()` —— 既停止下载，
 *   也把内存/时间上界钉死（旧实现 `await response.text()` 把整份 body 读进主进程内存，
 *   且不受超时约束）；
 * - `TextDecoder` **全程复用**（每 chunk 新建会丢挂起字节、把多字节字符截成 U+FFFD，
 *   同 P1-09 的教训）；
 * - `truncated = true` 表示「body 因限量被提前中断」，最终截断文案据此取更诚实的措辞。
 *
 * 超时 abort 打断 `reader.read()` 时**向上抛**，由 `fetch()` 统一映射成「抓取超时」；
 * 其余 body 中途失败（连接复位等）保留已读到的部分（旧实现整体吞成空串）。
 */
async function readBodyLimited(
  response: Response,
  limit: number,
  controller: AbortController,
  isTimedOut: () => boolean,
): Promise<{ text: string; truncated: boolean }> {
  const body = response.body
  if (body === null) return { text: await response.text().catch(() => ''), truncated: false }
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let text = ''
  let truncated = false
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
      if (text.length >= limit) {
        truncated = true
        controller.abort()
        break
      }
    }
  } catch (error) {
    if (isTimedOut()) throw error
    truncated = text !== ''
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* 已 abort / 已读尽：取消失败无需处理 */
    }
  }
  // 冲刷 decoder 的挂起字节（stream: true 期间不完整的多字节序列在这里收敛）
  return { text: `${text}${decoder.decode()}`, truncated }
}

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

/**
 * 压平空白（含换行）为单空格并截断；截断时加省略标记，让模型知道内容不完整。
 *
 * `truncated` = body 因限量被提前中断（真实总长未知）：此时只提示「已截断」，
 * 不报一个把「已读部分」当成原文总长的错误数字。
 */
function flattenText(text: string, maxChars: number, truncated = false): string {
  const flattened = text.replace(/\s+/g, ' ').trim()
  if (flattened.length <= maxChars && !truncated) return flattened
  const head = flattened.slice(0, maxChars)
  return truncated ? `${head}…（已截断）` : `${head}…（已截断，原文共 ${flattened.length} 字符）`
}
