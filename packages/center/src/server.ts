/**
 * Aurora Center 服务器（docs/12）：单端口同时服务
 * - REST `/api/*`（注册 / 登录、设备授权登录、客户端列表、文件列表 / 下载 / 删除）
 * - WS `/api/client`（Aurora 客户端长连：Bearer 客户端令牌，连接后第一条 hello 完成绑定）
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
import type {
  CenterServerMessage,
  ClientStatus,
  FileEntryInfo,
  Logger,
  ModeId,
} from '@aurora/shared'
import { AuthError, AuthStore, type UserRecord } from './auth.js'
import { ClientRegistry } from './clients.js'
import { DeviceAuthStore } from './device.js'
import { FILE_PRUNE_INTERVAL_MS, FileStore, FileTooLargeError } from './files.js'
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
/*
 * 半开连接的判死节奏（2026-09-29 提速，用户反馈「客户端下线时 Center 更新太慢」）：
 * 每 `HEARTBEAT_INTERVAL_MS` 发一次 ping，连续 `HEARTBEAT_MISSES_ALLOWED` 次没收到 pong
 * 就 `terminate()` —— 最坏 2 × 15s = 30s 判离线（旧值 30s × 3 = 90s）。
 * 正常连接的 pong 是毫秒级回包，这两个值只影响"真死了"的那条路径。
 * 导出供单测钉住节奏（改这两个数必须同时改 docs/12 的时效表）。
 */
export const HEARTBEAT_INTERVAL_MS = 15_000
export const HEARTBEAT_MISSES_ALLOWED = 1
/*
 * 单帧上限（P2-14）：ws 默认的 100 MiB 意味着一条恶意帧就能让 `JSON.parse` 停顿秒级
 * 并吃掉上百 MB 内存，因此仍要显式设上限；超限帧由 ws 自己以 1009 关闭该连接
 * （见下面的 socket error 监听：那条 error 必须就地消费）。导出供单测钉住上限。
 *
 * v0.3.2 语音中转（docs/12 §6.4）把上限从 1 MiB 放宽到 16 MiB：`stt.transcribe` 的
 * 上行是最大约 10 MB 的 base64 音频（base64 膨胀后 ≈13.7 MiB，再加 JSON 包封留余量），
 * `tts.synthesize` 的回执（client → server 的 result）同样可能带数 MB base64 音频。
 * 沿用 1 MiB 会把语音链路在网关处以 1009 掐断（连接整个被关，不止丢一条命令）。
 * 两侧 WebSocketServer（clientWss / webWss）共用这一个值：上行与转发都要过得去。
 */
export const MAX_WS_PAYLOAD = 16 * 1024 * 1024
/*
 * 认证类端点的限速参数（P2-12）—— **参数集中在这一处**，便于按部署调参；
 * 计数键是源 IP，三个作用域各自独立（互不占用额度）。
 *
 * 部署事实：Center 直连公网（120.24.223.65:8787，无反代），因此源 IP 只取 socket 地址
 * （`req.socket.remoteAddress`），**不读可伪造的 `x-forwarded-for`** —— 放到反代后面时
 * 必须回来改这一处的取值口径，否则限速键会退化成"所有请求同一把"。
 *
 * 计数口径：`login` **只记失败**（密码错 / 用户不存在）—— 成功登录不消耗额度，否则正常
 * 用户连登几次就会被自己的成功挡在门外；穷举则全是失败，记失败足以拦住（5 次/分钟 =
 * 一天 7200 次，配合 scrypt 成本已是不可行量级）。`register` / `deviceStart` 两侧都记数。
 */
export const AUTH_RATE_LIMITS = {
  /** 登录：`/api/auth/login` 与 `/api/client/login` 共用一把（同一个密码校验面） */
  login: { max: 5, windowMs: 60_000 },
  /** 自助注册（批量建号防护；成功与失败都算一次） */
  register: { max: 10, windowMs: 60_000 },
  /** 设备授权 start（无需登录，防刷挑战表） */
  deviceStart: { max: 30, windowMs: 60_000 },
} as const

/** 限速超限的回执（HTTP 429；WS 侧不涉及） */
export const RATE_LIMITED_ERROR = 'E_RATE_LIMITED'

/**
 * 滑动窗口计数器（内存、进程内）。只保存窗口内的时间戳，键上一条不剩时删键 ——
 * 否则 Map 会被一次性源 IP 撑大（P2-12 的限速自己变成内存问题）。
 */
class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>()

  constructor(
    private readonly rule: { max: number; windowMs: number },
    private readonly now: () => number = Date.now,
  ) {}

  /** 该键当前是否已达上限（只读，不记账） */
  exceeded(key: string): boolean {
    return this.recent(key).length >= this.rule.max
  }

  /** 记一次（失败 / 一次请求） */
  record(key: string): void {
    const recent = this.recent(key)
    recent.push(this.now())
    this.hits.set(key, recent)
  }

  private recent(key: string): number[] {
    const threshold = this.now() - this.rule.windowMs
    const recent = (this.hits.get(key) ?? []).filter((at) => at > threshold)
    if (recent.length === 0) this.hits.delete(key)
    else this.hits.set(key, recent)
    return recent
  }
}

/** 限速键：直连部署取 socket 地址（见 AUTH_RATE_LIMITS 的口径说明） */
function sourceKeyOf(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown'
}

/*
 * 服务器锁文件（P2-17）：CLI 的 users 写命令与运行中的服务器各自缓存整份 users.json，
 * 谁后写谁覆盖（CLI 侧的改密会被服务器下一次落盘静默回滚）。服务器在**监听成功后**创建
 * `<dataDir>/server.lock`、`close()` 时删除，并周期性刷新 mtime；CLI 据此判定"服务器在跑"。
 *
 * 陈旧锁：进程被 kill -9 / 断电时锁文件会残留。判定只看 mtime —— 服务器每
 * SERVER_LOCK_REFRESH_MS（15s）刷一次，mtime 超过 SERVER_LOCK_STALE_MS（60s）没动过
 * 即视为残留（= 无服务器，放行）。刷新周期必须显著小于陈旧窗口。
 */
export const SERVER_LOCK_FILE = 'server.lock'
export const SERVER_LOCK_STALE_MS = 60_000
export const SERVER_LOCK_REFRESH_MS = 15_000

export type ServerLockState = 'none' | 'running' | 'stale'

/** 锁文件绝对路径（CLI 与服务器共用这一处口径） */
export function serverLockPath(dataDir: string): string {
  return join(dataDir, SERVER_LOCK_FILE)
}

/**
 * 纯判定（无 I/O，供单测）：不存在 → `none`；存在且 mtime 在陈旧窗口内 → `running`;
 * 存在但 mtime 已超窗口 → `stale`（崩溃残留，按无服务器放行）。
 */
export function evaluateServerLock(input: {
  exists: boolean
  mtimeMs: number
  nowMs: number
}): ServerLockState {
  if (!input.exists) return 'none'
  return input.nowMs - input.mtimeMs > SERVER_LOCK_STALE_MS ? 'stale' : 'running'
}

/** 读盘判定（CLI 用）：读不到 / stat 失败一律按 `none`。 */
export async function inspectServerLock(
  dataDir: string,
  nowMs: number = Date.now(),
): Promise<ServerLockState> {
  try {
    const stat = await fs.stat(serverLockPath(dataDir))
    return evaluateServerLock({ exists: true, mtimeMs: stat.mtimeMs, nowMs })
  } catch {
    return 'none'
  }
}

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
  const device = new DeviceAuthStore({ logger })
  // 数据目录 config.json 的服务器自身开关（缺省放行）；init() 时读取一次
  let allowRegistration = true
  let pruneTimer: NodeJS.Timeout | undefined
  let lockTimer: NodeJS.Timeout | undefined
  // 认证类端点限速（P2-12）：每个作用域一把，键是源 IP；只挡认证端点，不碰 WS 心跳与常规 API
  const limiters = {
    login: new SlidingWindowLimiter(AUTH_RATE_LIMITS.login),
    register: new SlidingWindowLimiter(AUTH_RATE_LIMITS.register),
    deviceStart: new SlidingWindowLimiter(AUTH_RATE_LIMITS.deviceStart),
  }
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
  const clientWss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD })
  const webWss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD })
  /** 已升级、还没完成 hello 的客户端连接：socket → 客户端令牌 */
  const pendingHello = new Map<WebSocket, string>()

  /**
   * ws 层的 `'error'` 必须**就地消费**：EventEmitter 上没有 `'error'` 监听时，
   * `emit('error')` 会直接抛成 uncaughtException（全仓没有进程级兜底 = 服务器退出）。
   * 触发它的现实路径：单帧超过 maxPayload（ws 报 `Max payload size exceeded` 后以 1009
   * 关闭该连接）、协议帧畸形等 —— 都只该影响这一条连接（P2-14 / P0-01 的兜底）。
   */
  function watchSocketErrors(ws: WebSocket, describe: () => Record<string, unknown>): void {
    ws.on('error', (error: Error) => {
      logger?.warn('WS 连接错误', { ...describe(), error: String(error) })
    })
  }

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

    /**
     * 交给 hub 处理一条客户端消息。**必须 try/catch**：协议类型在运行时被盲转型，
     * 畸形帧（缺字段 / 错型）会让处理链抛错，异常逃出 `'message'` 监听器即
     * uncaughtException → 整个服务器退出（P0-01 / P1-02，全仓没有进程级兜底）。
     * 单条消息出错只记日志：该命令的网页端会走 15s 超时（E_CLIENT_TIMEOUT）自然收尾。
     */
    const dispatchClientMessage = (parsed: Record<string, unknown>): void => {
      try {
        hub.handleClientMessage(
          registeredClient,
          parsed as Parameters<Hub['handleClientMessage']>[1],
        )
      } catch (error) {
        logger?.error('处理客户端 WS 消息失败', {
          clientId: registeredClient,
          error: String(error),
        })
      }
    }

    watchSocketErrors(ws, () => ({ clientId: registeredClient }))
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
      dispatchClientMessage(parsed)
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
        .verifyClientToken(token, body.clientId)
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
            dispatchClientMessage(pending)
          }
          logger?.info('客户端已连接', { clientId: body.clientId, name: body.name })
          /*
           * 心跳：`HEARTBEAT_INTERVAL_MS` 一次 ping，连续 `HEARTBEAT_MISSES_ALLOWED` 次无 pong 判死。
           *
           * 半开连接（拔网线 / 休眠 / 进程被硬杀）只能靠这条兜底把设备**标成离线** ——
           * 网页端看到的「在线」就是这一刻还有没有连接（`hub.clientConns`），所以判死有多快，
           * 「下线」就有多快。旧值 30s × 3 拍 = 最坏 90s，用户实测反馈「下线太慢」；
           * 现在 15s × 2 拍 = 最坏 30s（正常网络的 pong 在毫秒级回来，不会误杀）。
           */
          const heartbeat = setInterval(() => {
            missedPongs += 1
            if (missedPongs > HEARTBEAT_MISSES_ALLOWED) {
              logger?.info('客户端心跳超时，已断开', {
                clientId: body.clientId,
                missedPongs,
              })
              ws.terminate()
              return
            }
            try {
              ws.send(JSON.stringify({ type: 'ping' } satisfies CenterServerMessage))
            } catch {
              /* 发送失败等 close/terminate 收尾 */
            }
          }, HEARTBEAT_INTERVAL_MS)
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
          // 身份校验：只有"当前这条连接"关掉才算真断开 —— 旧连接的迟到 close 既不能删掉
          // 同 clientId 的新连接（见 hub.removeClient），也不能顺手清掉新连接名下的会话属主记账
          if (!hub.removeClient(clientId, conn)) return
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
      // 同 agent：占位快照，客户端连上后的第一条 `status` 会整体覆盖（含生效 LLM）
      llm: { activeProviderId: '', model: '', reasoningEffort: 'auto' },
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
    watchSocketErrors(ws, () => ({ webConnId: conn.id, userId: conn.user.id }))
    ws.on('message', (data) => {
      let parsed: Record<string, unknown> | undefined
      try {
        parsed = parseMessage(data)
        if (parsed === undefined) return
        hub.handleWebMessage(conn, parsed as Parameters<Hub['handleWebMessage']>[1])
      } catch (error) {
        // 同客户端侧：畸形消息的异常**不得穿透到进程级**（P0-01）。能定位到 requestId
        // 就回一帧错误回执（网页端不必干等 30s 超时），否则只记日志。
        logger?.error('处理网页 WS 消息失败', { webConnId: conn.id, error: String(error) })
        const requestId = parsed?.['requestId']
        if (typeof requestId === 'string') {
          try {
            conn.send({ type: 'result', requestId, ok: false, error: 'E_INTERNAL' })
          } catch {
            /* 连接已断开：close 处理会收尾 */
          }
        }
      }
    })
    ws.on('close', () => hub.removeWeb(conn.id))
  }

  // ─────────────── REST ───────────────

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    if (path === '/api/auth/login' && req.method === 'POST') {
      const rateKey = sourceKeyOf(req)
      if (limiters.login.exceeded(rateKey)) {
        logger?.warn('登录请求超限，已拒绝', { source: rateKey, path })
        sendJson(res, 429, { error: RATE_LIMITED_ERROR })
        return
      }
      const body = await readJsonBody(req)
      const user = await auth
        .verifyPassword(String(body['username'] ?? ''), String(body['password'] ?? ''))
        .catch(() => undefined)
      if (user === undefined) {
        limiters.login.record(rateKey)
        logger?.warn('网页登录失败（用户名或密码不正确）', { source: rateKey })
        sendJson(res, 401, { error: '用户名或密码不正确' })
        return
      }
      sendJson(res, 200, {
        token: auth.createWebSession(user.id),
        user: { id: user.id, username: user.username, role: user.role },
      })
      return
    }

    // 自助注册（docs/12 §4.2）：创建 role:'user' 账户并直接登录（返回与 login 相同形状）。
    // 服务器 config.json 的 allowRegistration = false 时整条 403 关闭。
    if (path === '/api/auth/register' && req.method === 'POST') {
      if (!allowRegistration) {
        sendJson(res, 403, { error: 'E_REGISTRATION_DISABLED' })
        return
      }
      // 注册成功与失败都记账（防批量建号）；建号本身要跑一次 scrypt，更该挡住洪水
      const rateKey = sourceKeyOf(req)
      if (limiters.register.exceeded(rateKey)) {
        sendJson(res, 429, { error: RATE_LIMITED_ERROR })
        return
      }
      limiters.register.record(rateKey)
      const body = await readJsonBody(req)
      try {
        const user = await auth.registerUser(
          String(body['username'] ?? ''),
          String(body['password'] ?? ''),
        )
        sendJson(res, 200, {
          token: auth.createWebSession(user.id),
          user: { id: user.id, username: user.username, role: user.role },
        })
      } catch (error) {
        sendAuthError(res, error)
      }
      return
    }

    // 客户端账号登录（docs/12 §3，v0.2.1）：密码换客户端令牌（归属该用户、创建即绑定
    // clientId）。与 /api/auth/login 一样是登录入口本身，放在鉴权段之前。
    if (path === '/api/client/login' && req.method === 'POST') {
      // 与 /api/auth/login 共用 login 限速（同一个密码校验面，共用额度才挡得住穷举）
      const rateKey = sourceKeyOf(req)
      if (limiters.login.exceeded(rateKey)) {
        logger?.warn('客户端登录请求超限，已拒绝', { source: rateKey, path })
        sendJson(res, 429, { error: RATE_LIMITED_ERROR })
        return
      }
      const body = await readJsonBody(req)
      const username = String(body['username'] ?? '').trim()
      const password = String(body['password'] ?? '')
      const clientIdRaw = body['clientId']
      const clientId = typeof clientIdRaw === 'string' ? clientIdRaw.trim() : ''
      if (
        username === '' ||
        password === '' ||
        clientId === '' ||
        clientId.length > HELLO_STRING_MAX
      ) {
        sendJson(res, 400, { error: 'E_INVALID_ARGUMENT' })
        return
      }
      const user = await auth.verifyPassword(username, password).catch(() => undefined)
      if (user === undefined) {
        limiters.login.record(rateKey)
        logger?.warn('客户端账号登录失败（用户名或密码不正确）', { source: rateKey })
        sendJson(res, 401, { error: '用户名或密码不正确' })
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

    // 设备授权登录（docs/12 §4.3）：start / poll 是客户端入口（无需登录），
    // authorize 需网页会话（用户在网页上确认），放在鉴权段之后。
    if (path === '/api/client/device/start' && req.method === 'POST') {
      // 无需登录的挑战创建：限速防刷表（表本身另有上限与清扫，见 device.ts）
      const rateKey = sourceKeyOf(req)
      if (limiters.deviceStart.exceeded(rateKey)) {
        sendJson(res, 429, { error: RATE_LIMITED_ERROR })
        return
      }
      limiters.deviceStart.record(rateKey)
      const body = await readJsonBody(req)
      const clientId = typeof body['clientId'] === 'string' ? body['clientId'].trim() : ''
      if (clientId === '' || clientId.length > HELLO_STRING_MAX) {
        sendJson(res, 400, { error: 'E_INVALID_ARGUMENT' })
        return
      }
      const challenge = device.start(clientId, (userCode) => verifyUrlOf(req, userCode))
      sendJson(res, 200, challenge)
      return
    }
    if (path === '/api/client/device/poll' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const deviceCode = typeof body['deviceCode'] === 'string' ? body['deviceCode'] : ''
      const clientId = typeof body['clientId'] === 'string' ? body['clientId'].trim() : ''
      if (deviceCode === '' || clientId === '') {
        sendJson(res, 400, { error: 'E_INVALID_ARGUMENT' })
        return
      }
      sendJson(res, 200, device.poll(deviceCode, clientId))
      return
    }
    // 网页确认页只拿到展示码（userCode），authorize 端点认的是 deviceCode —— 这里做一次
    // 无需登录的查询（docs/12 §4.3）。不存在的 code 回 404 且不带任何细节（防枚举）。
    if (path === '/api/client/device/info' && req.method === 'GET') {
      const code = url.searchParams.get('code') ?? ''
      const info = device.findByUserCode(code)
      if (info === undefined) {
        sendJson(res, 404, { error: 'E_NOT_FOUND' })
        return
      }
      sendJson(res, 200, { deviceCode: info.deviceCode, expiresAt: info.expiresAt })
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

    // 设备授权确认（网页会话）：approve=false 置 denied；approve=true 先做属主护栏
    // （clientId 已绑定其他账号的有效令牌 → 409 并把挑战置 denied），再颁发令牌。
    if (path === '/api/client/device/authorize' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const deviceCode = typeof body['deviceCode'] === 'string' ? body['deviceCode'] : ''
      const approve = body['approve'] !== false
      const info = device.peek(deviceCode)
      if (info === undefined) {
        sendJson(res, 404, { error: 'E_NOT_FOUND' })
        return
      }
      if (approve) {
        const owner = auth.activeOwnerOfClient(info.clientId)
        if (owner !== undefined && owner !== user.id) {
          device.resolve(deviceCode, false, () => ({ token: '', username: '' }))
          sendJson(res, 409, { error: 'E_CLIENT_BOUND' })
          return
        }
        const minted = await auth.mintClientToken(user.id, info.clientId, '设备授权登录')
        device.resolve(deviceCode, true, () => ({
          token: minted.token,
          username: user.username,
        }))
        sendJson(res, 200, { ok: true, clientId: info.clientId })
        return
      }
      const resolved = device.resolve(deviceCode, false, () => ({ token: '', username: '' }))
      if (!resolved) {
        sendJson(res, 404, { error: 'E_NOT_FOUND' })
        return
      }
      sendJson(res, 200, { ok: true, clientId: info.clientId })
      return
    }

    // 文件列表（属主看自己名下客户端上传的，管理员看全部），按上传时间倒序
    if (path === '/api/files' && req.method === 'GET') {
      const entries = files
        .list()
        .filter((record) => {
          if (user.role === 'admin') return true
          return clients.get(record.clientId)?.ownerUserId === user.id
        })
        .sort((a, b) => b.at.localeCompare(a.at))
        .map(toFileEntryInfo)
      sendJson(res, 200, { files: entries })
      return
    }
    const fileDownload = /^\/api\/files\/([^/]+)$/.exec(path)
    if (fileDownload && req.method === 'GET') {
      await serveFile(res, fileDownload[1] as string, user)
      return
    }
    if (fileDownload && req.method === 'DELETE') {
      const record = files.get(fileDownload[1] as string)
      if (record === undefined) {
        sendJson(res, 404, { error: 'E_NOT_FOUND' })
        return
      }
      const client = clients.get(record.clientId)
      if (user.role !== 'admin' && client?.ownerUserId !== user.id) {
        sendJson(res, 403, { error: 'E_FORBIDDEN' })
        return
      }
      await files.remove(record.fileId)
      sendJson(res, 200, { ok: true })
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

    sendJson(res, 404, { error: 'E_NOT_FOUND' })
  }

  /** 客户端上传（`center_send_file` 的对端）：客户端令牌 + X-Client-Id 双因子，流式落盘 */
  async function handleIngest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const token = bearerOf(req)
    const clientIdHeader = req.headers['x-client-id']
    const clientId = Array.isArray(clientIdHeader)
      ? (clientIdHeader[0] ?? '')
      : (clientIdHeader ?? '')
    const pair = await auth.verifyClientToken(token, clientId).catch(() => undefined)
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
    streamFile(
      res,
      path,
      {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(record.name)}`,
      },
      { fileId },
    )
  }

  /**
   * 流式回一个文件（P2-16）：**`open` 成功之后才写 200 头**，并挂 `error` 监听。
   *
   * 现实竞态：校验通过之后、流真正 open 之前，目标文件可能已被 15 分钟清理轮删掉
   * （24h 到期的瞬间点下载正好命中）。没有 `error` 监听时 ENOENT 是 uncaughtException
   * —— 全仓没有进程级兜底，等于**整个服务器退出**。先挂监听再写头，`headersSent`
   * 为假时回 404，已发头则 destroy 这条响应（连接报废但进程活着）。
   */
  function streamFile(
    res: ServerResponse,
    path: string,
    headers: Record<string, string>,
    label: Record<string, unknown>,
  ): void {
    const stream = createReadStream(path)
    stream.once('open', () => {
      res.writeHead(200, headers)
      stream.pipe(res)
    })
    stream.on('error', (error) => {
      logger?.warn('文件流打开失败', { ...label, error: String(error) })
      if (!res.headersSent) sendJson(res, 404, { error: 'E_NOT_FOUND' })
      else res.destroy()
    })
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
          // 同 serveFile：stat 与流 open 之间文件可能已被替换 / 删除，error 在
          // headersSent 之前到达即 404（P2-16）
          streamFile(
            res,
            target,
            {
              'Content-Type': type,
              'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
            },
            { path: relative },
          )
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

  /**
   * 创建锁文件并周期性刷新 mtime（P2-17）。写失败只告警不拦启动：锁是给 CLI 的
   * 并发护栏，数据目录只读之类的情况下服务器照常该能跑（CLI 会退化成"看不到服务器"，
   * 与升级前的行为一致 —— 所以 CLI 与服务器要**同版本上线**）。
   */
  async function acquireLock(): Promise<void> {
    const lockPath = serverLockPath(options.dataDir)
    try {
      await fs.mkdir(options.dataDir, { recursive: true })
      await fs.writeFile(
        lockPath,
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
        'utf8',
      )
    } catch (error) {
      logger?.warn('写入服务器锁文件失败（CLI 将无法识别服务器在运行）', {
        lockPath,
        error: String(error),
      })
      return
    }
    lockTimer = setInterval(() => {
      const now = new Date()
      void fs.utimes(lockPath, now, now).catch(() => {
        /* 锁文件被外部删掉：下一轮 CLI 会按"无服务器"处理，不刷日志 */
      })
    }, SERVER_LOCK_REFRESH_MS)
    lockTimer.unref?.()
  }

  /** 删除锁文件（close 时调用；删不掉也不影响退出，最坏是让 CLI 等一个陈旧窗口）。 */
  async function releaseLock(): Promise<void> {
    if (lockTimer !== undefined) {
      clearInterval(lockTimer)
      lockTimer = undefined
    }
    await fs.rm(serverLockPath(options.dataDir), { force: true }).catch(() => {
      /* 忽略：残留锁由 mtime 陈旧判定兜底 */
    })
  }

  async function init(): Promise<void> {
    await auth.init()
    await clients.init()
    await files.init()
    allowRegistration = await readAllowRegistration(options.dataDir)
    // 启动清一次过期文件，之后每 15 分钟一轮（unref：不拦进程退出）
    await files.pruneExpired().catch((error) => {
      logger?.error('启动清理过期文件失败', { error: String(error) })
    })
    pruneTimer = setInterval(() => {
      void files.pruneExpired().catch((error) => {
        logger?.error('定期清理过期文件失败', { error: String(error) })
      })
    }, FILE_PRUNE_INTERVAL_MS)
    pruneTimer.unref?.()
  }

  /** 数据目录 config.json 的 `allowRegistration`（缺省 true；读不到 / 解析失败按缺省）。 */
  async function readAllowRegistration(dataDir: string): Promise<boolean> {
    try {
      const raw = await fs.readFile(join(dataDir, 'config.json'), 'utf8')
      const parsed = JSON.parse(raw) as { allowRegistration?: unknown }
      return parsed['allowRegistration'] !== false
    } catch {
      return true
    }
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
              const actualPort =
                typeof address === 'object' && address !== null ? address.port : port
              // 锁文件在**监听成功之后**创建：端口占用等启动失败不留假锁（P2-17）
              void acquireLock().then(() => {
                resolveListen({ port: actualPort })
              })
            })
          })
          .catch(reject)
      })
    },
    close() {
      if (pruneTimer !== undefined) clearInterval(pruneTimer)
      return new Promise((resolveClose) => {
        void releaseLock().then(() => {
          clientWss.close()
          webWss.close()
          http.close(() => resolveClose())
        })
      })
    },
  }
  return running
}

// ─────────────── 工具 ───────────────

/** 网页确认页地址：`http(s)://<Host>/#/device?code=<userCode>`（x-forwarded-proto 优先） */
function verifyUrlOf(req: IncomingMessage, userCode: string): string {
  const hostHeader = req.headers['host']
  const host = (Array.isArray(hostHeader) ? hostHeader[0] : hostHeader) ?? 'localhost'
  const fwd = req.headers['x-forwarded-proto']
  const proto = (Array.isArray(fwd) ? fwd[0] : fwd) === 'https' ? 'https' : 'http'
  return `${proto}://${host}/#/device?code=${encodeURIComponent(userCode)}`
}

/** 索引条目 → 网页端文件信息（协议 FileEntryInfo；uploadedAt 即内部记录的 at） */
function toFileEntryInfo(record: {
  fileId: string
  clientId: string
  name: string
  size: number
  note?: string
  at: string
  expiresAt: string
}): FileEntryInfo {
  return {
    fileId: record.fileId,
    clientId: record.clientId,
    name: record.name,
    size: record.size,
    ...(record.note === undefined ? {} : { note: record.note }),
    uploadedAt: record.at,
    expiresAt: record.expiresAt,
  }
}

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
