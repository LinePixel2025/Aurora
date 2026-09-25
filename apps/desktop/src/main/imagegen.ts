/**
 * 图像生成（Design/betav2-spec.md §8.3、docs/06 §15）。
 *
 * 主进程用**解密后**的凭据调用户配置的 OpenAI 兼容生图服务
 * `POST <baseUrl>/images/generations`（JSON），把 b64 图片解码后落盘到
 * `<userData>/generated/<ts>-<rand>.png`，并回传 `{filePath, dataUrl}`；
 * 渲染层永远看不到明文密钥。
 *
 * `readDataUrl` 是渲染层预览的唯一入口：**路径安全校验**（resolve 后必须在
 * generated 目录内）后才允许读盘，防止把任意路径的文件当图片读出去。
 *
 * 本文件**不得 import electron**：出网 fetch（netFetch）与文件系统都由
 * Node 内置 / 注入提供，因此能被 vitest 直接加载（见 vitest.config.ts 的 include）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { ImageGenGenerateRequest, ImageGenReadRequest, Logger } from '@aurora/shared'

export interface ImageGenServiceOptions {
  settings: ImageGenSettingsStoreLike
  logger: Logger
  /** 图片落盘目录（主进程传 `<userData>/generated`） */
  generatedDir: string
  /** 生图请求超时（生图耗时较长，默认 120s） */
  timeoutMs?: number
  /** 下载 `url` 形式结果 / 出网用的 fetch（netFetch），不传回落 `globalThis.fetch` */
  resolveFetch?: () => typeof fetch | undefined
  /** 注入便于单测；默认 `node:fs/promises` */
  fs?: {
    mkdir: (path: string, options: { recursive: true }) => Promise<string | undefined>
    writeFile: (path: string, data: Uint8Array) => Promise<void>
    readFile: (path: string) => Promise<Uint8Array>
  }
}

/** 最小依赖面：只需要 `get()` 与 `getSecret()`（凭据解密），比 `SettingsStoreLike` 更窄 */
export interface ImageGenSettingsStoreLike {
  get(): {
    imagegen: {
      enabled: boolean
      active: string
      providers: Record<
        string,
        { type: 'openai-compat'; baseUrl: string; apiKeyEnc: string; model: string; size: string }
      >
    }
  }
  getSecret(path: string): string
}

export interface ImageGenService {
  /** 生成图片并落盘。失败一律**抛出**（IPC 层折成 `Result.error`）。 */
  generate(request: ImageGenGenerateRequest): Promise<{ filePath: string; dataUrl: string }>
  /** 读回已生成的图片（仅允许 generated 目录内），回 `data:` URL 供渲染层预览。 */
  read(request: ImageGenReadRequest): Promise<{ dataUrl: string }>
}

/** 生图超时（默认 120s：生图比对话慢得多，30s 量级会大量误报超时）。 */
const DEFAULT_TIMEOUT_MS = 120_000
/** 非 2xx 时读进 message 的 body 上限。 */
const ERROR_BODY_LIMIT = 300
/** 生成的图片固定为 PNG（`response_format: 'b64_json'` 解码后落盘）。 */
const PNG_MIME = 'image/png'

export function createImageGenService(options: ImageGenServiceOptions): ImageGenService {
  const { settings, logger } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const io = options.fs ?? {
    mkdir: (path, ioOptions) => mkdir(path, ioOptions),
    writeFile: (path, data) => writeFile(path, data),
    readFile: async (path) => new Uint8Array(await readFile(path)),
  }

  function resolveProvider(request: ImageGenGenerateRequest): {
    providerId: string
    baseUrl: string
    model: string
    size: string
    apiKey: string
  } {
    const config = settings.get().imagegen
    if (!config.enabled || config.active === '') {
      throw new Error('图像生成未配置：请先在设置中启用生图模型并选择默认 provider')
    }
    const providerId = config.active
    const provider = config.providers[providerId]
    if (provider === undefined) {
      throw new Error(`图像生成未配置：生图模型「${providerId}」不存在`)
    }

    const baseUrl = provider.baseUrl.trim()
    if (baseUrl === '') throw new Error('图像生成未配置：生图模型的 baseURL 为空')

    const model = provider.model.trim()
    if (model === '') throw new Error('图像生成未配置：请先填写生图模型名')

    const apiKey = settings.getSecret(`imagegen.providers.${providerId}.apiKey`)
    if (apiKey === '') throw new Error('缺少 API Key：请先填写生图模型的密钥')

    const prompt = request.prompt.trim()
    if (prompt === '') throw new Error('没有可生成的图片描述')

    // 尺寸：请求覆盖值优先，其次 provider 配置；都为空交给服务端默认
    const size = (request.size ?? provider.size).trim()

    return { providerId, baseUrl, model, size, apiKey }
  }

  return {
    async generate(request: ImageGenGenerateRequest): Promise<{
      filePath: string
      dataUrl: string
    }> {
      const resolved = resolveProvider(request)
      const startedAt = Date.now()

      const response = await postJson({
        fetchImpl: resolveFetchOf(options.resolveFetch, logger),
        endpoint: generationsEndpoint(resolved.baseUrl),
        apiKey: resolved.apiKey,
        body: JSON.stringify({
          model: resolved.model,
          prompt: request.prompt.trim(),
          // `auto` 等尺寸原样下发，由服务端解释（provider 配置受 Schema 白名单约束）
          ...(resolved.size === '' ? {} : { size: resolved.size }),
          n: 1,
          response_format: 'b64_json',
        }),
        timeoutMs,
      })

      if (!response.ok) {
        const detail = await readErrorDetail(response)
        const message = describeHttpFailure(response.status, detail)
        logger.warn('生图请求失败', { provider: resolved.providerId, status: response.status })
        throw new Error(message)
      }

      const image = await extractImage(response, resolved, options.resolveFetch, logger)

      // 落盘：目录不存在则建；文件名 `<ts>-<rand6>.png`（随机段防止同毫秒覆盖）
      await io.mkdir(options.generatedDir, { recursive: true })
      const filePath = join(
        options.generatedDir,
        `${Date.now()}-${randomBytes(3).toString('hex')}.png`,
      )
      await io.writeFile(filePath, image)

      logger.info('生图成功', {
        provider: resolved.providerId,
        bytes: image.byteLength,
        filePath,
        latencyMs: Date.now() - startedAt,
      })
      return {
        filePath,
        dataUrl: `data:${PNG_MIME};base64,${Buffer.from(image).toString('base64')}`,
      }
    },

    async read(request: ImageGenReadRequest): Promise<{ dataUrl: string }> {
      const requested = request.filePath.trim()
      if (requested === '') throw new Error('缺少文件路径')

      const dir = resolve(options.generatedDir)
      const target = resolve(requested)
      // 路径安全校验：resolve 后必须仍在 generated 目录内（`..` 逃逸 / 换盘符一律拒绝）
      const rel = relative(dir, target)
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`路径不合法：只允许读取生成目录内的图片（${basename(requested)}）`)
      }

      let bytes: Uint8Array
      try {
        bytes = await io.readFile(target)
      } catch (error) {
        throw new Error(
          `读取生成图片失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
      return { dataUrl: `data:${PNG_MIME};base64,${Buffer.from(bytes).toString('base64')}` }
    },
  }
}

// ───────────────────────── 内部 ─────────────────────────

/** 发一次 JSON POST；超时统一折成固定中文文案。 */
async function postJson(input: {
  fetchImpl: typeof fetch
  endpoint: string
  apiKey: string
  body: string
  timeoutMs: number
}): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs)
  const seconds = Math.round(input.timeoutMs / 1000)

  try {
    return await input.fetchImpl(input.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.apiKey}`,
      },
      body: input.body,
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`生图超时（${seconds}s）`)
    throw new Error(`生图请求失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

/** `<baseUrl>` 去尾斜杠后拼 `/images/generations`；已经以它结尾时不重复拼。 */
function generationsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.endsWith('/images/generations') ? trimmed : `${trimmed}/images/generations`
}

/**
 * 从响应里取出图片字节：
 * 优先 `data[0].b64_json`；部分服务不遵守 `response_format` 只回 `url`，
 * 此时用注入的 fetch 下载（同样走 netFetch → 代理生效）。
 */
async function extractImage(
  response: Response,
  resolved: { providerId: string; baseUrl: string },
  resolveFetch: (() => typeof fetch | undefined) | undefined,
  logger: Logger,
): Promise<Uint8Array> {
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new Error('生图服务返回了无法解析的内容')
  }

  const first = (parsed as { data?: unknown } | null)?.data
  const item = Array.isArray(first) ? (first[0] as Record<string, unknown> | undefined) : undefined
  const b64 = item?.['b64_json']
  if (typeof b64 === 'string' && b64.trim() !== '') {
    const bytes = Buffer.from(b64.trim(), 'base64')
    if (bytes.byteLength === 0) throw new Error('生图服务返回了空的图片数据')
    return bytes
  }

  const url = item?.['url']
  if (typeof url === 'string' && url.trim() !== '') {
    logger.info('生图服务未回 b64_json，改为下载 url', { provider: resolved.providerId })
    return await download(url.trim(), resolveFetch, logger)
  }

  throw new Error('生图服务返回格式异常（缺少 b64_json / url）')
}

async function download(
  url: string,
  resolveFetch: (() => typeof fetch | undefined) | undefined,
  logger: Logger,
): Promise<Uint8Array> {
  const fetchImpl = resolveFetchOf(resolveFetch, logger)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`下载图片失败（HTTP ${response.status}）`)
    return new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    if (controller.signal.aborted) throw new Error('下载图片超时')
    throw new Error(`下载图片失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const body = await response.text()
    return body.slice(0, ERROR_BODY_LIMIT)
  } catch {
    return ''
  }
}

/** 按状态码给中文前缀，并把服务端返回的 body 尾巴拼上（便于用户自查）。 */
function describeHttpFailure(status: number, detail: string): string {
  const prefix =
    status === 401 || status === 403
      ? 'API Key 无效或没有权限'
      : status === 404
        ? '接口或模型不存在（请检查 baseURL 与模型名）'
        : status === 429
          ? '请求过于频繁，已被限流'
          : status >= 500
            ? '生图服务端错误'
            : '图像生成失败'
  const suffix = detail.trim() === '' ? '' : `：${detail.trim()}`
  return `${prefix}（HTTP ${status}）${suffix}`
}

/** 解析当前出网 fetch；解析失败按未提供处理（回落 `globalThis.fetch`）。 */
function resolveFetchOf(
  resolveFetch: (() => typeof fetch | undefined) | undefined,
  logger: Logger,
): typeof fetch {
  if (resolveFetch !== undefined) {
    try {
      const resolved = resolveFetch()
      if (resolved !== undefined) return resolved
    } catch (error) {
      logger.debug('取网络客户端失败，回落默认实现', { error: String(error) })
    }
  }
  return globalThis.fetch
}
