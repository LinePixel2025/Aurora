/**
 * Aurora Center Web —— REST 封装（docs/12 §4.2）。
 *
 * 共享协议类型一律 `import type`（编译期擦除）；运行时依赖只有 vue 与
 * `@aurora/shared/browser`（Markdown 渲染器 / 设计令牌 / 图标查表）。
 * 登录令牌存 localStorage（7 天有效期由服务器控制，过期由 401 触发登出）。
 */
import type { ClientInfo, FileEntryInfo } from '@aurora/shared'

export interface Me {
  id: string
  username: string
  role: 'admin' | 'user'
}

export interface LoginResponse {
  token: string
  user: Me
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
  /** 自助注册：成功返回与 login 相同形状（直接进入登录态）；409 重名 / 403 注册关闭 */
  register(username: string, password: string): Promise<LoginResponse> {
    return request('/api/auth/register', 'POST', { username, password })
  },
  me(): Promise<Me> {
    return request('/api/me')
  },
  clients(): Promise<{ clients: ClientInfo[] }> {
    return request('/api/clients')
  },

  /** 客户端上传的文件列表（属主过滤后端已做，uploadedAt 倒序） */
  files(): Promise<{ files: FileEntryInfo[] }> {
    return request('/api/files')
  },
  deleteFile(fileId: string): Promise<{ ok: true }> {
    return request(`/api/files/${encodeURIComponent(fileId)}`, 'DELETE')
  },

  /** 设备授权（docs/12 §4.3）：展示码换设备码（无需登录），供确认页拿到 authorize 凭据 */
  deviceInfo(userCode: string): Promise<{ deviceCode: string; expiresAt: string }> {
    return request(`/api/client/device/info?code=${encodeURIComponent(userCode)}`)
  },
  authorizeDevice(deviceCode: string, approve: boolean): Promise<{ ok: true; clientId: string }> {
    return request('/api/client/device/authorize', 'POST', { deviceCode, approve })
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
  },
}
