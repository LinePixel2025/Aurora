/**
 * 服务器下发文件的**落地**实现（`file.send` 的对端，docs/12 §5，本轮）。
 *
 * 方向与 `ingest.ts` 相反：用同一套客户端令牌（`Authorization: Bearer` + `X-Client-Id`）
 * 从 `GET /api/client/files/:fileId` 流式拉回本机，写进用户下载目录。
 *
 * 三条口径：
 * 1. **先写 `.part` 再原子改名**：中途断网 / 崩溃不会留下一个"看着像完整文件"的半截产物，
 *    用户也不会在下载器还没写完时就去双击它；
 * 2. **大小上限在读流时兜底**（`maxBytes`）：服务器侧已有上限，但这里是本机磁盘的守门人
 *    —— 目录可能被换成另一个服务器 / 代理返回了别的东西；
 * 3. **重名不覆盖**：`file.txt` 已存在就写 `file (1).txt`（`uniquePath`），
 *    覆盖用户已有文件是不可逆的破坏，宁可多留几个副本。
 *
 * 与 ingest 一样**不走代理**（`advanced.proxy` 对本通道无效）—— Center 地址是用户显式
 * 配置的可信目标（docs/12 §11）。
 */
import { createWriteStream, promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { httpOriginOf } from './ingest.js'

export interface DeliverOptions {
  /** Center 服务器地址（与 WS 同源；http(s)/ws(s) 均可，内部统一成 http origin） */
  serverUrl: string
  token: string
  clientId: string
  fileId: string
  /** 服务器给的原始文件名（只取 basename，防路径穿越） */
  name: string
  /** 落盘目录（装配层给 `app.getPath('downloads')`） */
  targetDir: string
  /** 单文件上限（字节）；超限即中断并删除半截文件 */
  maxBytes: number
  fetchImpl?: typeof fetch
}

export interface DeliverResult {
  path: string
  size: number
}

export class CenterDeliverError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'E_NOT_CONFIGURED'
      | 'E_IO'
      | 'E_HTTP'
      | 'E_TOO_LARGE'
      | 'E_INCOMPLETE',
  ) {
    super(message)
  }
}

/**
 * 拉回一个文件并返回**最终落盘路径**。
 *
 * 失败时保证不留 `.part` 残骸（`finally` 里清），把可读的中文原因放进错误信息 ——
 * 这条链的失败会一路回到网页端（`result.error`），用户看到的必须是能行动的话。
 */
export async function downloadFileFromCenter(options: DeliverOptions): Promise<DeliverResult> {
  const origin = httpOriginOf(options.serverUrl)
  if (origin === undefined || options.token === '' || options.clientId === '') {
    throw new CenterDeliverError('Aurora Center 尚未配置（地址或登录凭据缺失）', 'E_NOT_CONFIGURED')
  }
  const url = `${origin}/api/client/files/${encodeURIComponent(options.fileId)}`
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${options.token}`,
        'X-Client-Id': options.clientId,
      },
    })
  } catch (error) {
    throw new CenterDeliverError(`下载请求失败：${String(error)}`, 'E_HTTP')
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new CenterDeliverError(
      `Center 返回 ${response.status}${detail === '' ? '' : `：${detail.slice(0, 200)}`}`,
      'E_HTTP',
    )
  }
  if (response.body === null) {
    throw new CenterDeliverError('Center 响应没有正文', 'E_HTTP')
  }

  const safeName = basename(options.name.replaceAll('\\', '/')) || `center-${options.fileId}`
  await fs.mkdir(options.targetDir, { recursive: true })
  const finalPath = await uniquePath(options.targetDir, safeName)
  const partPath = `${finalPath}.part`
  let size = 0
  try {
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          size += chunk.byteLength
          if (size > options.maxBytes) {
            throw new CenterDeliverError(
              `文件超过上限（${Math.round(options.maxBytes / 1024 / 1024)} MB）`,
              'E_TOO_LARGE',
            )
          }
          yield chunk
        }
      },
      createWriteStream(partPath),
    )
    // 服务器给的 size 只用于提示；以实际落盘字节数为准，不一致就如实报（代理截断 / 换源）
    await fs.rename(partPath, finalPath)
    return { path: finalPath, size }
  } catch (error) {
    await fs.rm(partPath, { force: true }).catch(() => undefined)
    if (error instanceof CenterDeliverError) throw error
    throw new CenterDeliverError(`写入文件失败：${String(error)}`, 'E_IO')
  }
}

/**
 * 找一个不冲突的落盘路径：`a.txt` → `a (1).txt` → `a (2).txt` …
 *
 * 只在前 100 个候选里找，之后直接放弃改名（用 `Date.now()` 后缀）—— 目录里已经有
 * 一百份同名文件时，继续试探既是无用的 IO 也说明用户根本不在意保留哪一份。
 */
async function uniquePath(dir: string, name: string): Promise<string> {
  const ext = extname(name)
  const stem = ext === '' ? name : name.slice(0, -ext.length)
  for (let index = 0; index < 100; index += 1) {
    const candidate = join(dir, index === 0 ? name : `${stem} (${index})${ext}`)
    if (!(await exists(candidate))) return candidate
  }
  return join(dir, `${stem} (${Date.now()})${ext}`)
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}
