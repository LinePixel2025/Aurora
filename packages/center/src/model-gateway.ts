/**
 * Center 官方模型网关（docs/12 §12.2）。
 *
 * 客户端凭 Bearer 客户端令牌访问；上游 API Key 只在 Center 内存中解密。聊天流式响应
 * 原样透传，同时旁路解析真实 usage。提示词、回复与媒体正文都不落盘。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Logger, TokenUsage } from '@aurora/shared'
import type { ModelServicesStore, ResolvedOfficialService } from './model-services.js'
import type { SecretBox } from './secrets.js'
import type { UsageStore } from './usage.js'

const JSON_BODY_LIMIT = 64 * 1024 * 1024
const AUDIO_TICKET_TTL_MS = 10 * 60 * 1000

export interface ModelGatewayIdentity {
  userId: string
  username: string
  clientId: string
}

export interface ModelGatewayOptions {
  services: ModelServicesStore
  usage: UsageStore
  secrets: SecretBox
  logger?: Logger
}

export class ModelGateway {
  constructor(private readonly options: ModelGatewayOptions) {}

  /** 处理带客户端令牌的网关请求；不是网关路径时返回 false。 */
  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    identity: ModelGatewayIdentity,
  ): Promise<boolean> {
    if (!url.pathname.startsWith('/api/model-gateway/')) return false
    const path = url.pathname.slice('/api/model-gateway/'.length)
    const [capabilityRaw = '', ...restParts] = path.split('/')
    const capability = normalizeCapability(capabilityRaw)
    if (capability === undefined) {
      sendJson(res, 404, { error: 'E_NOT_FOUND' })
      return true
    }
    const service = this.options.services.resolve(capability)
    if (service === undefined) {
      sendJson(res, 503, { error: `E_${capability.toUpperCase()}_NOT_CONFIGURED` })
      return true
    }
    const rest = `/${restParts.join('/')}`

    if (rest === '/models' && req.method === 'GET') {
      sendJson(res, 200, {
        data: service.models
          .filter((model) => model.enabled)
          .map((model) => ({ id: model.id, owned_by: 'aurora-center' })),
      })
      return true
    }

    const kind = routeKind(capability, rest)
    if (kind === undefined) {
      sendJson(res, 404, { error: 'E_NOT_FOUND' })
      return true
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'E_METHOD_NOT_ALLOWED' })
      return true
    }

    const body = await readBody(req, JSON_BODY_LIMIT).catch((error: unknown) => {
      sendJson(res, 413, { error: error instanceof Error ? error.message : 'E_BODY_TOO_LARGE' })
      return undefined
    })
    if (body === undefined) return true

    const model = extractModel(capability, body, req.headers['content-type'] ?? '')
    if (model !== undefined && !this.options.services.allowedModel(capability, model)) {
      sendJson(res, 403, { error: 'E_MODEL_NOT_ALLOWED' })
      return true
    }

    try {
      await this.proxy(req, res, url, service, rest, body, identity)
    } catch (error) {
      this.options.logger?.warn('官方模型网关请求失败', {
        capability,
        clientId: identity.clientId,
        error: String(error),
      })
      if (!res.headersSent) sendJson(res, 502, { error: 'E_UPSTREAM_FAILED' })
      else res.destroy()
    }
    return true
  }

  /** 无客户端令牌的短期签名音频代理。 */
  async handleSignedAudio(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const prefix = '/api/model-gateway/tts/audio/'
    if (!url.pathname.startsWith(prefix)) return false
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'E_METHOD_NOT_ALLOWED' })
      return true
    }
    const ticket = decodeURIComponent(url.pathname.slice(prefix.length))
    let parsed: { url?: unknown; expiresAt?: unknown }
    try {
      parsed = JSON.parse(this.options.secrets.decrypt(ticket)) as typeof parsed
    } catch {
      sendJson(res, 403, { error: 'E_INVALID_TICKET' })
      return true
    }
    if (
      typeof parsed.url !== 'string' ||
      typeof parsed.expiresAt !== 'number' ||
      parsed.expiresAt < Date.now()
    ) {
      sendJson(res, 410, { error: 'E_TICKET_EXPIRED' })
      return true
    }
    const response = await fetch(parsed.url, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) {
      sendJson(res, 502, { error: 'E_AUDIO_DOWNLOAD_FAILED' })
      return true
    }
    res.writeHead(200, {
      'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream',
      'Cache-Control': 'private, max-age=300',
    })
    await pipeResponse(response, res)
    return true
  }

  private async proxy(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    service: ResolvedOfficialService,
    rest: string,
    body: Buffer,
    identity: ModelGatewayIdentity,
  ): Promise<void> {
    const upstreamUrl = joinUpstream(service.baseUrl, rest)
    const headers: Record<string, string> = {
      Authorization: `Bearer ${service.apiKey}`,
    }
    const contentType = req.headers['content-type']
    if (typeof contentType === 'string' && contentType !== '') headers['Content-Type'] = contentType
    const response = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: body.byteLength === 0 ? undefined : new Uint8Array(body),
      signal: AbortSignal.timeout(120_000),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      res.writeHead(response.status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(detail.slice(0, 4096) || JSON.stringify({ error: 'E_UPSTREAM_FAILED' }))
      return
    }

    const isLlm = service.capability === 'llm'
    const isImage = service.capability === 'imagegen'
    const isDashscopeTts = service.capability === 'tts' && service.type === 'dashscope'
    if (isLlm) {
      await this.proxyLlm(req, res, response, service, identity, body)
      return
    }
    if (isImage) {
      await this.proxyImage(res, response)
      return
    }
    if (isDashscopeTts) {
      await this.proxyDashscopeTts(res, response)
      return
    }
    res.writeHead(response.status, passthroughHeaders(response))
    await pipeResponse(response, res)
    void url
  }

  private async proxyLlm(
    req: IncomingMessage,
    res: ServerResponse,
    response: Response,
    service: ResolvedOfficialService,
    identity: ModelGatewayIdentity,
    requestBody: Buffer,
  ): Promise<void> {
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream')) {
      res.writeHead(200, passthroughHeaders(response))
      const parser = new UsageSseParser()
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        const buffer = Buffer.from(chunk)
        parser.push(buffer)
        res.write(buffer)
      }
      res.end()
      const usage = parser.usage()
      if (usage !== undefined) {
        await this.recordUsage(service, identity, requestModel(req, requestBody), usage)
      }
      return
    }

    const raw = Buffer.from(await response.arrayBuffer())
    let usage: TokenUsage | undefined
    try {
      usage = extractUsage(JSON.parse(raw.toString('utf8')))
    } catch {
      /* 非 JSON 响应照原样透传，只是不记账 */
    }
    res.writeHead(200, {
      'Content-Type': contentType || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(raw)
    if (usage !== undefined) {
      await this.recordUsage(service, identity, requestModel(req, requestBody), usage)
    }
  }

  private async proxyImage(res: ServerResponse, response: Response): Promise<void> {
    const raw = Buffer.from(await response.arrayBuffer())
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(raw)
      return
    }
    const data = (parsed as { data?: unknown }).data
    if (Array.isArray(data) && data.length > 0) {
      const first = data[0]
      if (typeof first === 'object' && first !== null) {
        const item = first as Record<string, unknown>
        const sourceUrl = typeof item['url'] === 'string' ? item['url'] : ''
        if (sourceUrl !== '') {
          const downloaded = await fetch(sourceUrl, { signal: AbortSignal.timeout(120_000) })
          if (downloaded.ok) {
            item['b64_json'] = Buffer.from(await downloaded.arrayBuffer()).toString('base64')
            delete item['url']
          }
        }
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(parsed))
  }

  private async proxyDashscopeTts(res: ServerResponse, response: Response): Promise<void> {
    const raw = Buffer.from(await response.arrayBuffer())
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.toString('utf8'))
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(raw)
      return
    }
    const output = (parsed as { output?: { audio?: { url?: unknown } } }).output
    const audioUrl = output?.audio?.url
    if (typeof audioUrl === 'string' && audioUrl !== '') {
      const ticket = this.options.secrets.encrypt(
        JSON.stringify({ url: audioUrl, expiresAt: Date.now() + AUDIO_TICKET_TTL_MS }),
      )
      output!.audio!.url = `/api/model-gateway/tts/audio/${encodeURIComponent(ticket)}`
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(parsed))
  }

  private async recordUsage(
    service: ResolvedOfficialService,
    identity: ModelGatewayIdentity,
    model: string,
    usage: TokenUsage,
  ): Promise<void> {
    await this.options.usage.record({
      userId: identity.userId,
      username: identity.username,
      clientId: identity.clientId,
      model: model || service.defaultModel,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      ...(usage.cachedTokens === undefined ? {} : { cachedTokens: usage.cachedTokens }),
      totalTokens: usage.totalTokens,
    })
  }
}

class UsageSseParser {
  private buffer = ''
  private parsed: TokenUsage | undefined

  push(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '' || data === '[DONE]') continue
      try {
        const usage = extractUsage(JSON.parse(data))
        if (usage !== undefined) this.parsed = usage
      } catch {
        /* SSE 中可能有非 JSON 数据；跳过 */
      }
    }
  }

  usage(): TokenUsage | undefined {
    return this.parsed
  }
}

function normalizeCapability(value: string): 'llm' | 'imagegen' | 'tts' | 'stt' | undefined {
  return value === 'llm' || value === 'imagegen' || value === 'tts' || value === 'stt'
    ? value
    : undefined
}

function routeKind(
  capability: 'llm' | 'imagegen' | 'tts' | 'stt',
  rest: string,
): 'llm' | 'image' | 'tts' | 'stt' | undefined {
  if (capability === 'llm' && (rest === '/chat/completions' || rest === '/responses')) return 'llm'
  if (capability === 'imagegen' && rest === '/images/generations') return 'image'
  if (
    capability === 'tts' &&
    (rest === '/audio/speech' || rest === '/api/v1/services/aigc/multimodal-generation/generation')
  ) {
    return 'tts'
  }
  if (
    capability === 'stt' &&
    (rest === '/audio/transcriptions' ||
      rest === '/api/v1/services/aigc/multimodal-generation/generation')
  ) {
    return 'stt'
  }
  return undefined
}

function joinUpstream(baseUrl: string, rest: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  const suffix = rest.replace(/^\/+/, '')
  if (base.endsWith(`/${suffix}`)) return base
  for (const marker of ['/api/v1', '/compatible-mode/v1', '/api']) {
    if (base.endsWith(marker) && suffix.startsWith(`${marker.slice(1)}/`)) {
      return `${base.slice(0, -marker.length)}/${suffix}`
    }
  }
  return `${base}/${suffix}`
}

function extractModel(
  capability: 'llm' | 'imagegen' | 'tts' | 'stt',
  body: Buffer,
  contentType: string,
): string | undefined {
  if (contentType.includes('multipart/form-data')) return multipartField(body, 'model')
  try {
    const value = JSON.parse(body.toString('utf8')) as { model?: unknown }
    return typeof value.model === 'string' ? value.model : undefined
  } catch {
    return undefined
  }
}

function multipartField(body: Buffer, field: string): string | undefined {
  const text = body.toString('latin1')
  const match = new RegExp(`name="${field}"\\r\\n\\r\\n([^\\r\\n]+)`, 'i').exec(text)
  return match?.[1]
}

function requestModel(_req: IncomingMessage, body: Buffer): string {
  try {
    const value = JSON.parse(body.toString('utf8')) as { model?: unknown }
    return typeof value.model === 'string' ? value.model : ''
  } catch {
    return ''
  }
}

function extractUsage(value: unknown): TokenUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const usage =
    asRecord(record['usage']) ??
    asRecord(asRecord(record['response'])?.['usage']) ??
    asRecord(asRecord(record['message'])?.['usage'])
  if (usage === undefined) return undefined
  const prompt = numberField(usage, ['prompt_tokens', 'input_tokens'])
  const completion = numberField(usage, ['completion_tokens', 'output_tokens'])
  if (prompt === undefined || completion === undefined) return undefined
  const total = numberField(usage, ['total_tokens']) ?? prompt + completion
  const details =
    asRecord(usage['prompt_tokens_details']) ?? asRecord(usage['input_tokens_details'])
  const cached =
    numberField(details ?? {}, ['cached_tokens']) ?? numberField(usage, ['prompt_cache_hit_tokens'])
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    ...(cached === undefined ? {} : { cachedTokens: cached }),
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = Number(record[key])
    if (Number.isFinite(value) && value >= 0) return value
  }
  return undefined
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > limit) throw new Error('E_BODY_TOO_LARGE')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function passthroughHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  }
  const disposition = response.headers.get('content-disposition')
  if (disposition !== null) headers['Content-Disposition'] = disposition
  return headers
}

async function pipeResponse(response: Response, res: ServerResponse): Promise<void> {
  if (response.body === null) {
    res.end()
    return
  }
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    res.write(Buffer.from(chunk))
  }
  res.end()
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}
