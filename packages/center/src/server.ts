/**
 * Aurora Center 服务器（docs/12）：单端口同时服务
 * - REST `/api/*`（登录、客户端列表、令牌、文件下载）
 * - WS `/api/client`（Aurora 客户端长连：Bearer 配对令牌，连接后第一条 hello 完成配对）
 * - WS `/api/ws`（网页长连：`?token=` 登录令牌，升级期即校验）
 * - `/api/ingest/files`（客户端上传，流式落盘）
 * - 其余路径静态服务 Web UI（`dist-web/`）
 *
 * 不用 express：路由就十几条，手写 dispatch 少一层依赖面。鉴权失败的 REST 一律
 * `401 {"error":...}`；WS 在升级期 / hello 期直接关闭。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream, promises as fs } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import type { CenterServerMessage, ClientStatus, Logger, ModeId } from '@aurora/shared'
import { AuthError, AuthStore, type UserRecord } from './auth.js'
import { ClientRegistry } from './clients.js'
import { FileStore, FileTooLargeError } from './files.js'
import { Hub, type ClientConn, type WebConn } from './hub.js'
import { serverVersion } from './version.js'

export interface CenterServerOptions {
  dataDir: string
  /** Web UI 构建产物目录（缺省不启用静态服务，测试用） */
  webDir?: string
  /** 单个上传文件上限（字节，默认 512 MB；客户端配置另有更小的 `center.maxFileMb`） */
  maxFileBytes?: number
  logger?: Logger
}

export interface RunningCenterServer {
  listen(port: number, host: string): Promise<{ port: number }>
  close(): Promise<void>
  readonly hub: Hub
}

const MAX_JSON_BODY = 256 * 1024
const HELLO_TIMEOUT_MS = 10_000
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
}

/** 客户端 hello（协议见 packages/shared/src/center/protocol.ts；服务器只做宽松校验） */
interface HelloBody {
  clientId: string
  name: string
  version: string
  platform: string
  mode: ModeId
  capabilities: { session: boolean; remoteConfig: boolean; fileTransfer: boolean }
}

export function createCenterServer(options: CenterServerOptions): RunningCenterServer {
  const logger = options.logger
  const auth = new AuthStore({ dataDir: options.dataDir, logger })
  const clients = new ClientRegistry({ dataDir: options.dataDir, logger })
  const files = new FileStore({
    dataDir: options.dataDir,
    maxFileBytes: options.maxFileBytes ?? 512 * 1024 * 1024,
    logger,
  })
  const hub = new Hub({
    clients,
    usernameOf: (userId) => auth.getUser(userId)?.username ?? '',
    serverVersion,
    logger,
  })

  const http: Server = createServer((req, res) => {
    void dispatch(req, res).catch((error) => {
      // 剥掉查询串：?token= 的登录令牌（文件下载直链场景）不能进日志
      logger?.error('请求处理失败', {
        url: (req.url ?? '').split('?')[0],
        error: String(error),
      })
      if (!res.headersSent) sendJson(res, 500, { error: 'E_INTERNAL' })
    })
  })
  const clientWss = new WebSocketServer({ noServer: true })
  const webWss = new WebSocketServer({ noServer: true })
  /** 已升级、还没完成 hello 的客户端连接：socket → 配对令牌 */
  const pendingHello = new Map<WebSocket, string>()

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/api/ws') {
      const user = auth.verifyWebSession(url.searchParams.get('token') ?? '')
      if (user === undefined) {
        socket.destroy()
        return
      }
      webWss.handleUpgrade(req, socket, head, (ws) => attachWebSocket(ws, user))
      return
    }
    if (url.pathname === '/api/client') {
      const token = bearerOf(req)
      if (token === '') {
        socket.destroy()
        return
      }
      // ⚠️ ws 库的约定：手动 handleUpgrade 时回调**替代**了 'connection' 事件
      // （库里只有自动挂 upgrade 监听的那条路径才会 emit('connection')），
      // 因此这里直接进入会话流程，不依赖 'connection' 事件。
      clientWss.handleUpgrade(req, socket, head, (ws) => beginClientSession(ws, token))
      return
    }
    socket.destroy()
  })

  // ─────────────── 客户端连接（hello → 配对 → 常规消息） ───────────────

  function beginClientSession(ws: WebSocket, token: string): void {
    pendingHello.set(ws, token)
    // 10s 内没发合法 hello 就断开：不让半开连接挂着
    const helloTimer = setTimeout(() => {
      if (pendingHello.has(ws)) {
        pendingHello.delete(ws)
        ws.close(4002, 'E_HELLO_TIMEOUT')
      }
    }, HELLO_TIMEOUT_MS)
    helloTimer.unref?.()

    // ⚠️ 竞态防线：hello 校验是异步的（令牌哈希查表 + 落盘绑定），期间客户端发来的
    // status / result 若无人监听就**永久丢失**（真实连接器在 open 后立刻连发 hello +
    // status）。这里先挂统一监听把"未注册期"的消息排队，注册完成后回放。
    const queuedBeforeRegister: Array<Record<string, unknown>> = []
    let registeredClient = ''
    let pongHook: () => void = () => {}
    ws.on('message', (data) => {
      const parsed = parseMessage(data)
      if (parsed === undefined || parsed['type'] === 'hello') return
      if (parsed['type'] === 'pong') {
        pongHook()
        return
      }
      if (registeredClient === '') {
        queuedBeforeRegister.push(parsed)
        return
      }
      hub.handleClientMessage(registeredClient, parsed as Parameters<Hub['handleClientMessage']>[1])
    })

    ws.once('message', (data) => {
      clearTimeout(helloTimer)
      const hello = parseMessage(data)
      if (hello?.['type'] !== 'hello' || !isRecord(hello?.['hello'])) {
        pendingHello.delete(ws)
        ws.close(4003, 'E_BAD_MESSAGE')
        return
      }
      const body = readHello(hello['hello'])
      if (body === undefined) {
        pendingHello.delete(ws)
        ws.close(4003, 'E_BAD_MESSAGE')
        return
      }
      void auth
        .verifyPairingToken(token, body.clientId)
        .then(async (pair) => {
          pendingHello.delete(ws)
          if (pair === undefined) {
            ws.close(4001, 'E_UNAUTHORIZED')
            return
          }
          await clients.upsert({
            clientId: body.clientId,
            name: body.name,
            ownerUserId: pair.userId,
            version: body.version,
            platform: body.platform,
            mode: body.mode,
          })
          // 先挂常规消息监听（hello 被过滤、命令类消息到 registerClient 前无害），
          // 再注册进 hub：保证 welcome 发出前监听已就位
          let missedPongs = 0
          const conn = makeClientConn(ws, body.clientId)
          conn.bind()
          hub.registerClient(conn, helloToStatus(body))
          // 统一监听切换到"已注册"：pong 归心跳计数、排队的消息按序回放
          pongHook = (): void => {
            missedPongs = 0
          }
          registeredClient = body.clientId
          for (const pending of queuedBeforeRegister.splice(0)) {
            hub.handleClientMessage(
              registeredClient,
              pending as Parameters<Hub['handleClientMessage']>[1],
            )
          }
          logger?.info('客户端已连接', { clientId: body.clientId, name: body.name })
          // 心跳：30s 一次 ping，连续 2 次无 pong 判死（半开连接兜底）
          const heartbeat = setInterval(() => {
            missedPongs += 1
            if (missedPongs > 2) {
              logger?.info('客户端心跳超时，已断开', { clientId: body.clientId })
              ws.terminate()
              return
            }
            try {
              ws.send(JSON.stringify({ type: 'ping' } satisfies CenterServerMessage))
            } catch {
              /* 发送失败等 close/terminate 收尾 */
            }
          }, 30_000)
          heartbeat.unref?.()
          ws.once('close', () => clearInterval(heartbeat))
        })
        .catch((error) => {
          pendingHello.delete(ws)
          logger?.error('客户端配对失败', { error: String(error) })
          ws.close(4001, 'E_UNAUTHORIZED')
        })
    })
  }

  function makeClientConn(ws: WebSocket, clientId: string): ClientConn & { bind(): void } {
    const conn: ClientConn & { bind(): void } = {
      clientId,
      send: (message) => ws.send(JSON.stringify(message)),
      close: () => ws.close(),
      // 消息监听由 beginClientSession 的统一监听负责（防配对异步窗口丢消息）；
      // bind 只负责注册后的清理钩子
      bind: () => {
        ws.on('close', () => {
          hub.removeClient(clientId)
          hub.dropClientSessions(clientId)
          logger?.info('客户端已断开', { clientId })
        })
      },
    }
    return conn
  }

  function helloToStatus(hello: HelloBody): ClientStatus {
    return {
      mode: hello.mode,
      version: hello.version,
      platform: hello.platform,
      // hello 只带能力位；完整的 agent 状态由客户端连上后的第一条 `status` 覆盖
      agent: {
        permissionMode: '',
        tools: { enabled: false, files: false, search: false, open: false, terminal: false },
      },
      center: {
        allowRemoteSession: hello.capabilities.session,
        allowRemoteConfig: hello.capabilities.remoteConfig,
        allowFileTransfer: hello.capabilities.fileTransfer,
      },
    }
  }

  // ─────────────── 网页连接 ───────────────

  let webConnSeq = 0

  function attachWebSocket(ws: WebSocket, user: UserRecord): void {
    webConnSeq += 1
    const conn: WebConn = {
      id: `w-${webConnSeq}`,
      user: { id: user.id, username: user.username, role: user.role },
      send: (message) => ws.send(JSON.stringify(message)),
    }
    hub.registerWeb(conn)
    ws.on('message', (data) => {
      const parsed = parseMessage(data)
      if (parsed === undefined) return
      hub.handleWebMessage(conn, parsed as Parameters<Hub['handleWebMessage']>[1])
    })
    ws.on('close', () => hub.removeWeb(conn.id))
  }

  // ─────────────── REST ───────────────

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    if (path === '/api/auth/login' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const user = await auth
        .verifyPassword(String(body['username'] ?? ''), String(body['password'] ?? ''))
        .catch(() => undefined)
      if (user === undefined) {
        sendJson(res, 401, { error: '用户名或口令不正确' })
        return
      }
      sendJson(res, 200, {
        token: auth.createWebSession(user.id),
        user: { id: user.id, username: user.username, role: user.role },
      })
      return
    }

    // 客户端账号登录（docs/12 §3，v0.2.1）：口令换客户端令牌（归属该用户、创建即绑定
    // clientId）。与 /api/auth/login 一样是登录入口本身，放在鉴权段之前。
    if (path === '/api/client/login' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const username = String(body['username'] ?? '').trim()
      const password = String(body['password'] ?? '')
      const clientIdRaw = body['clientId']
      const clientId =
        typeof clientIdRaw === 'string' ? clientIdRaw.trim() : ''
      if (username === '' || password === '' || clientId === '' || clientId.length > HELLO_STRING_MAX) {
        sendJson(res, 400, { error: 'E_INVALID_ARGUMENT' })
        return
      }
      const user = await auth.verifyPassword(username, password).catch(() => undefined)
      if (user === undefined) {
        sendJson(res, 401, { error: '用户名或口令不正确' })
        return
      }
      // clientId 已绑定到**其他**账号的有效令牌 → 拒绝抢注（否则 mint 会吊销对方
      // 的有效令牌，等于用一次登录把别人的机器踢下线）。
      const activeOwner = auth.activeOwnerOfClient(clientId)
      if (activeOwner !== undefined && activeOwner !== user.id) {
        sendJson(res, 409, { error: 'E_CLIENT_BOUND' })
        return
      }
      const { token } = await auth.mintClientToken(user.id, clientId, '账号登录')
      logger?.info('客户端账号登录成功', { username: user.username, clientId })
      sendJson(res, 200, {
        token,
        clientId,
        user: { id: user.id, username: user.username },
      })
      return
    }

    if (path === '/api/ingest/files' && req.method === 'POST') {
      await handleIngest(req, res, url)
      return
    }

    // 静态资源（SPA）在鉴权之前：登录页本身就住在 `/`，越过 /api 的 GET 一律回静态
    if (options.webDir !== undefined && req.method === 'GET' && !path.startsWith('/api/')) {
      await serveStatic(res, path, options.webDir)
      return
    }

    // 其余 REST 都要登录（Bearer 头或 ?token=，后者服务于 <a> 直接下载）
    const user = auth.verifyWebSession(bearerOf(req) || url.searchParams.get('token') || '')
    if (user === undefined) {
      sendJson(res, 401, { error: 'E_UNAUTHORIZED' })
      return
    }

    if (path === '/api/me' && req.method === 'GET') {
      sendJson(res, 200, { id: user.id, username: user.username, role: user.role })
      return
    }
    if (path === '/api/clients' && req.method === 'GET') {
      sendJson(res, 200, { clients: hub.buildClientInfos(user) })
      return
    }
    if (path === '/api/tokens' && req.method === 'GET') {
      sendJson(res, 200, { tokens: auth.listPairingTokens(user.id) })
      return
    }
    if (path === '/api/tokens' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const { record, token } = await auth.createPairingToken(user.id, String(body['label'] ?? ''))
      sendJson(res, 200, { id: record.id, token, label: record.label })
      return
    }
    const tokenRevoke = /^\/api\/tokens\/([^/]+)\/revoke$/.exec(path)
    if (tokenRevoke && req.method === 'POST') {
      await auth.revokePairingToken(tokenRevoke[1] as string, user)
      sendJson(res, 200, { ok: true })
      return
    }
    const fileDownload = /^\/api\/files\/([^/]+)$/.exec(path)
    if (fileDownload && req.method === 'GET') {
      await serveFile(res, fileDownload[1] as string, user)
      return
    }

    // ── 管理员 ──
    if (user.role !== 'admin') {
      sendJson(res, 403, { error: 'E_FORBIDDEN' })
      return
    }
    if (path === '/api/admin/users' && req.method === 'GET') {
      sendJson(res, 200, { users: auth.listUsers() })
      return
    }
    if (path === '/api/admin/users' && req.method === 'POST') {
      const body = await readJsonBody(req)
      try {
        const created = await auth.createUser({
          username: String(body['username'] ?? ''),
          password: String(body['password'] ?? ''),
          role: body['role'] === 'admin' ? 'admin' : 'user',
        })
        sendJson(res, 200, { id: created.id })
      } catch (error) {
        sendAuthError(res, error)
      }
      return
    }
    const resetPassword = /^\/api\/admin\/users\/([^/]+)\/reset-password$/.exec(path)
    if (resetPassword && req.method === 'POST') {
      const body = await readJsonBody(req)
      try {
        await auth.resetPassword(resetPassword[1] as string, String(body['password'] ?? ''))
        sendJson(res, 200, { ok: true })
      } catch (error) {
        sendAuthError(res, error)
      }
      return
    }
    const deleteUser = /^\/api\/admin\/users\/([^/]+)$/.exec(path)
    if (deleteUser && req.method === 'DELETE') {
      try {
        await auth.deleteUser(deleteUser[1] as string, user)
        await clients.removeByOwner(deleteUser[1] as string)
        sendJson(res, 200, { ok: true })
      } catch (error) {
        sendAuthError(res, error)
      }
      return
    }
    if (path === '/api/admin/clients' && req.method === 'GET') {
      sendJson(res, 200, { clients: hub.buildClientInfos(user) })
      return
    }
    const removeClient = /^\/api\/admin\/clients\/([^/]+)$/.exec(path)
    if (removeClient && req.method === 'DELETE') {
      await clients.remove(removeClient[1] as string)
      hub.removeClient(removeClient[1] as string)
      sendJson(res, 200, { ok: true })
      return
    }
    if (path === '/api/admin/tokens' && req.method === 'GET') {
      sendJson(res, 200, { tokens: auth.listPairingTokens() })
      return
    }

    sendJson(res, 404, { error: 'E_NOT_FOUND' })
  }

  /** 客户端上传（`center_send_file` 的对端）：配对令牌 + X-Client-Id 双因子，流式落盘 */
  async function handleIngest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const token = bearerOf(req)
    const clientIdHeader = req.headers['x-client-id']
    const clientId = Array.isArray(clientIdHeader)
      ? (clientIdHeader[0] ?? '')
      : (clientIdHeader ?? '')
    const pair = await auth.verifyPairingToken(token, clientId).catch(() => undefined)
    if (pair === undefined) {
      sendJson(res, 401, { error: 'E_UNAUTHORIZED' })
      return
    }
    const rawName = req.headers['x-file-name']
    const name = decodeURIComponent(Array.isArray(rawName) ? (rawName[0] ?? '') : (rawName ?? ''))
    const note = url.searchParams.get('note') ?? undefined
    try {
      const record = await files.save({
        clientId: pair.clientId,
        name,
        ...(note === undefined ? {} : { note }),
        content: req,
      })
      const owner = clients.get(pair.clientId)?.ownerUserId ?? pair.userId
      hub.broadcastFileReceived(record, owner)
      sendJson(res, 200, { fileId: record.fileId, name: record.name, size: record.size })
    } catch (error) {
      if (error instanceof FileTooLargeError) {
        sendJson(res, 413, { error: error.message })
        return
      }
      logger?.error('文件上传失败', { clientId: pair.clientId, error: String(error) })
      sendJson(res, 500, { error: 'E_UPLOAD_FAILED' })
    }
  }

  async function serveFile(res: ServerResponse, fileId: string, user: UserRecord): Promise<void> {
    const record = files.get(fileId)
    if (record === undefined) {
      sendJson(res, 404, { error: 'E_NOT_FOUND' })
      return
    }
    const client = clients.get(record.clientId)
    if (client === undefined || (user.role !== 'admin' && client.ownerUserId !== user.id)) {
      sendJson(res, 403, { error: 'E_FORBIDDEN' })
      return
    }
    const path = files.pathOf(fileId)
    if (path === undefined) {
      sendJson(res, 404, { error: 'E_NOT_FOUND' })
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(record.name)}`,
    })
    createReadStream(path).pipe(res)
  }

  async function serveStatic(res: ServerResponse, path: string, webDir: string): Promise<void> {
    const relative = normalize(path === '/' ? 'index.html' : path.slice(1))
    const target = relative.startsWith('..') ? undefined : join(webDir, relative)
    if (target !== undefined) {
      try {
        const stat = await fs.stat(target)
        if (stat.isFile()) {
          const type = MIME[extname(target)] ?? 'application/octet-stream'
          const immutable = target.includes(join('assets', ''))
          res.writeHead(200, {
            'Content-Type': type,
            'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
          })
          createReadStream(target).pipe(res)
          return
        }
      } catch {
        /* 落到下面的 SPA 回退 */
      }
    }
    try {
      const index = await fs.readFile(join(webDir, 'index.html'))
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      })
      res.end(index)
    } catch {
      sendJson(res, 404, { error: 'E_NOT_FOUND' })
    }
  }

  async function init(): Promise<void> {
    await auth.init()
    await clients.init()
    await files.init()
  }

  const running: RunningCenterServer = {
    hub,
    listen(port, host) {
      return new Promise((resolveListen, reject) => {
        void init()
          .then(() => {
            http.once('error', reject)
            http.listen(port, host, () => {
              const address = http.address()
              resolveListen({
                port: typeof address === 'object' && address !== null ? address.port : port,
              })
            })
          })
          .catch(reject)
      })
    },
    close() {
      return new Promise((resolveClose) => {
        clientWss.close()
        webWss.close()
        http.close(() => resolveClose())
      })
    },
  }
  return running
}

// ─────────────── 工具 ───────────────

function parseMessage(data: unknown): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(String(data))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** hello 字符段上限：登记表 / clients 快照都要落它们，超长即拒绝（防恶意撑爆） */
const HELLO_STRING_MAX = 128

function bounded(value: string): string {
  return value.length > HELLO_STRING_MAX ? value.slice(0, HELLO_STRING_MAX) : value
}

function readHello(raw: Record<string, unknown>): HelloBody | undefined {
  const clientId = raw['clientId']
  if (typeof clientId !== 'string' || clientId.trim() === '') return undefined
  const trimmed = clientId.trim()
  if (trimmed.length > HELLO_STRING_MAX) return undefined
  const capabilitiesRaw = isRecord(raw['capabilities']) ? raw['capabilities'] : {}
  return {
    clientId: trimmed,
    name: typeof raw['name'] === 'string' && raw['name'] !== '' ? bounded(raw['name']) : trimmed,
    version: typeof raw['version'] === 'string' ? bounded(raw['version']) : '',
    platform: typeof raw['platform'] === 'string' ? bounded(raw['platform']) : '',
    mode: typeof raw['mode'] === 'string' ? (raw['mode'] as ModeId) : 'work',
    capabilities: {
      session: capabilitiesRaw['session'] !== false,
      remoteConfig: capabilitiesRaw['remoteConfig'] !== false,
      fileTransfer: capabilitiesRaw['fileTransfer'] !== false,
    },
  }
}

function bearerOf(req: IncomingMessage): string {
  const header = req.headers['authorization']
  if (header === undefined || Array.isArray(header)) return ''
  const matched = /^Bearer\s+(.+)$/.exec(header)
  return matched?.[1]?.trim() ?? ''
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_JSON_BODY) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  const parsed = parseMessage(Buffer.concat(chunks).toString('utf8'))
  return parsed ?? {}
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function sendAuthError(res: ServerResponse, error: unknown): void {
  const status =
    error instanceof AuthError
      ? error.code === 'E_USER_EXISTS' || error.code === 'E_LAST_ADMIN'
        ? 409
        : 400
      : 500
  sendJson(res, status, { error: error instanceof Error ? error.message : String(error) })
}
