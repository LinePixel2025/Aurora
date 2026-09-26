/**
 * Aurora Center Web —— REST 封装与 WebSocket 客户端。
 *
 * - 共享协议类型一律 `import type`（编译期擦除，运行时零依赖 @aurora/shared，
 *   SPA 的唯一运行时依赖是 vue）；
 * - WebSocket 断线自动重连：指数退避 1s→2s→4s→8s→15s 封顶；
 * - 登录令牌存 localStorage（7 天有效期由服务器控制，过期由 401 触发登出）。
 */
import type { CenterWebMessage, CenterWebServerMessage, ClientInfo } from '@aurora/shared'

export interface Me {
  id: string
  username: string
  role: 'admin' | 'user'
}

export interface LoginResponse {
  token: string
  user: Me
}

/** 配对令牌条目（GET /api/tokens 与 /api/admin/tokens 共用形状） */
export interface PairingToken {
  id: string
  label?: string
  createdAt: string
  clientId?: string
  revokedAt?: string
}

export interface AdminUser {
  id: string
  username: string
  role: 'admin' | 'user'
  createdAt: string
}

/** REST 错误（带 HTTP 状态码；401 触发登出、409 展示服务器原因） */
export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

const TOKEN_KEY = 'aurora-center-token'
const USER_KEY = 'aurora-center-user'

export function getToken(): string | null {
  return window.localStorage.getItem(TOKEN_KEY)
}

export function loadStoredAuth(): { token: string; user: Me } | null {
  const token = getToken()
  const raw = window.localStorage.getItem(USER_KEY)
  if (!token || !raw) return null
  try {
    return { token, user: JSON.parse(raw) as Me }
  } catch {
    return null
  }
}

export function saveAuth(token: string, user: Me): void {
  window.localStorage.setItem(TOKEN_KEY, token)
  window.localStorage.setItem(USER_KEY, JSON.stringify(user))
}

export function clearAuth(): void {
  window.localStorage.removeItem(TOKEN_KEY)
  window.localStorage.removeItem(USER_KEY)
}

/**
 * 文件下载走 query token（docs/12 §4.2）：`<a href>` 没法带 Authorization 头，
 * 服务器按 `?token=<登录令牌>` 鉴权。
 */
export function fileUrl(fileId: string): string {
  return `/api/files/${encodeURIComponent(fileId)}?token=${encodeURIComponent(getToken() ?? '')}`
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const data = (await response.json()) as { error?: string }
      if (data.error) message = data.error
    } catch {
      // 错误体不是 JSON：保留状态码信息
    }
    throw new ApiError(message, response.status)
  }
  return (await response.json()) as T
}

export const api = {
  login(username: string, password: string): Promise<LoginResponse> {
    return request('/api/auth/login', 'POST', { username, password })
  },
  me(): Promise<Me> {
    return request('/api/me')
  },
  clients(): Promise<{ clients: ClientInfo[] }> {
    return request('/api/clients')
  },
  /** 创建自己的配对令牌；明文只在本次响应里出现一次 */
  createPairingToken(label?: string): Promise<{ id: string; token: string }> {
    return request('/api/tokens', 'POST', label ? { label } : {})
  },
  listPairingTokens(): Promise<{ tokens: PairingToken[] }> {
    return request('/api/tokens')
  },
  revokePairingToken(id: string): Promise<{ ok: true }> {
    return request(`/api/tokens/${encodeURIComponent(id)}/revoke`, 'POST')
  },

  /** 管理员接口（role=admin） */
  admin: {
    users(): Promise<{ users: AdminUser[] }> {
      return request('/api/admin/users')
    },
    createUser(
      username: string,
      password: string,
      role: 'admin' | 'user',
    ): Promise<{ id: string }> {
      return request('/api/admin/users', 'POST', { username, password, role })
    },
    resetPassword(id: string, password: string): Promise<{ ok: true }> {
      return request(`/api/admin/users/${encodeURIComponent(id)}/reset-password`, 'POST', {
        password,
      })
    },
    /** 409 = 不能删自己 / 最后一个管理员，界面原样展示 error */
    deleteUser(id: string): Promise<{ ok: true }> {
      return request(`/api/admin/users/${encodeURIComponent(id)}`, 'DELETE')
    },
    clients(): Promise<{ clients: ClientInfo[] }> {
      return request('/api/admin/clients')
    },
    deleteClient(clientId: string): Promise<{ ok: true }> {
      return request(`/api/admin/clients/${encodeURIComponent(clientId)}`, 'DELETE')
    },
    tokens(): Promise<{ tokens: PairingToken[] }> {
      return request('/api/admin/tokens')
    },
  },
}

// ───────────────────────── WebSocket ─────────────────────────

export type SocketStatus = 'idle' | 'connecting' | 'open' | 'closed'

/**
 * 浏览器 → Center 的 WebSocket（`/api/ws?token=`，docs/12 §4.2）。
 * 断线自动重连：指数退避 1s 起步、15s 封顶；连接成功后清零。
 */
export class CenterSocket {
  onMessage: ((message: CenterWebServerMessage) => void) | null = null
  onStatus: ((status: SocketStatus) => void) | null = null

  private ws: WebSocket | null = null
  private attempt = 0
  private reconnectTimer: number | undefined
  private stopped = true

  connect(token: string): void {
    this.stopped = false
    this.attempt = 0
    this.open(token)
  }

  close(): void {
    this.stopped = true
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.ws?.close()
    this.ws = null
    this.emitStatus('idle')
  }

  /** 连接未就绪时返回 false（调用方按错误处理，不排队） */
  send(message: CenterWebMessage): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
      return true
    }
    return false
  }

  private open(token: string): void {
    this.emitStatus('connecting')
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(
      `${protocol}://${window.location.host}/api/ws?token=${encodeURIComponent(token)}`,
    )
    this.ws = ws
    ws.onopen = () => {
      this.attempt = 0
      this.emitStatus('open')
    }
    ws.onmessage = (event: MessageEvent) => {
      try {
        this.onMessage?.(JSON.parse(String(event.data)) as CenterWebServerMessage)
      } catch {
        // 非 JSON 帧一律忽略
      }
    }
    ws.onclose = () => {
      this.ws = null
      if (this.stopped) {
        this.emitStatus('idle')
        return
      }
      this.emitStatus('closed')
      const delay = Math.min(15_000, 1000 * 2 ** this.attempt)
      this.attempt += 1
      this.reconnectTimer = window.setTimeout(() => this.open(token), delay)
    }
    // onerror 后必然跟随 onclose，重连统一在 onclose 处理
  }

  private emitStatus(status: SocketStatus): void {
    this.onStatus?.(status)
  }
}
