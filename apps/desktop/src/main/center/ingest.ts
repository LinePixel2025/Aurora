/**
 * `center_send_file` 的上传实现（docs/12 §5）：`POST /api/ingest/files`，
 * 配对令牌鉴权（`Authorization: Bearer` + `X-Client-Id`），流式读文件。
 *
 * v1 明确**不走代理**（`advanced.proxy` 对本通道无效）—— Center 地址是用户
 * 显式配置的可信目标，与 LLM 出网不同源；docs/12 §11 已注明。
 */
import { createReadStream, promises as fs } from 'node:fs'
import { Readable } from 'node:stream'

export interface UploadOptions {
  /** Center 服务器地址（与 WS 同源；http(s)/ws(s) 均可，内部统一成 http origin） */
  serverUrl: string
  token: string
  clientId: string
  path: string
  note?: string
  fetchImpl?: typeof fetch
}

export interface UploadResult {
  fileId: string
  name: string
  size: number
  url: string
}

export class CenterUploadError extends Error {
  constructor(
    message: string,
    public readonly code: 'E_NOT_CONFIGURED' | 'E_IO' | 'E_HTTP' | 'E_RESPONSE',
  ) {
    super(message)
  }
}

/** ws(s):// 与 http(s):// 统一折算成 HTTP origin（API 与上传都走 HTTP） */
export function httpOriginOf(serverUrl: string): string | undefined {
  try {
    const url = new URL(serverUrl)
    if (url.protocol === 'wss:') url.protocol = 'https:'
    else if (url.protocol === 'ws:') url.protocol = 'http:'
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.origin
  } catch {
    return undefined
  }
}

export async function uploadFileToCenter(options: UploadOptions): Promise<UploadResult> {
  const origin = httpOriginOf(options.serverUrl)
  if (origin === undefined || options.token === '' || options.clientId === '') {
    throw new CenterUploadError('Aurora Center 尚未配置（地址或配对令牌缺失）', 'E_NOT_CONFIGURED')
  }
  let stat
  try {
    stat = await fs.stat(options.path)
  } catch (error) {
    throw new CenterUploadError(`文件不可访问：${String(error)}`, 'E_IO')
  }
  const url = `${origin}/api/ingest/files${options.note ? `?note=${encodeURIComponent(options.note)}` : ''}`
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.token}`,
        'X-Client-Id': options.clientId,
        'X-File-Name': encodeURIComponent(basename(options.path)),
        'Content-Type': 'application/octet-stream',
      },
      // undici 需要 web 流；Node 的 fs 流经 Readable.toWeb 转换
      body: Readable.toWeb(createReadStream(options.path)) as unknown as NonNullable<
        RequestInit['body']
      >,
      duplex: 'half',
    } as RequestInit)
  } catch (error) {
    throw new CenterUploadError(`上传请求失败：${String(error)}`, 'E_HTTP')
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new CenterUploadError(
      `Center 返回 ${response.status}${detail === '' ? '' : `：${detail.slice(0, 200)}`}`,
      'E_HTTP',
    )
  }
  try {
    const body = (await response.json()) as { fileId?: string; name?: string; size?: number }
    if (typeof body.fileId !== 'string' || body.fileId === '') {
      throw new CenterUploadError('Center 响应缺少 fileId', 'E_RESPONSE')
    }
    return {
      fileId: body.fileId,
      name: typeof body.name === 'string' ? body.name : basename(options.path),
      size: typeof body.size === 'number' ? body.size : stat.size,
      url: `/api/files/${body.fileId}`,
    }
  } catch (error) {
    if (error instanceof CenterUploadError) throw error
    throw new CenterUploadError(`Center 响应解析失败：${String(error)}`, 'E_RESPONSE')
  }
}

function basename(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1)
  return name === '' ? 'file' : name
}
