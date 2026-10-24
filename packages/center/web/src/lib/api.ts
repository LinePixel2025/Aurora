/**
 * Aurora Center Web —— REST 封装（docs/12 §4.2）。
 *
 * 共享协议类型一律 `import type`（编译期擦除）；运行时依赖只有 vue 与
 * `@aurora/shared/browser`（Markdown 渲染器 / 设计令牌 / 图标查表）。
 * 登录令牌存 localStorage（7 天有效期由服务器控制，过期由 401 触发登出）。
 */
import type {
  CenterOfficialCapability,
  CenterOfficialServiceConfig,
  CenterOfficialServicesConfig,
  CenterReleaseInfo,
  CenterUsageQuery,
  PluginMarketEntry,
  CenterUsageResponse,
  ClientInfo,
  FileEntryInfo,
} from '@aurora/shared'

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

export type CenterPluginEntry = PluginMarketEntry

export const api = {
  /** 插件市场（公开浏览，无需登录） */
  marketplace(
    query: { q?: string; page?: number; limit?: number; sort?: 'updated' | 'downloads' } = {},
  ) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value))
    }
    const suffix = params.size === 0 ? '' : `?${params.toString()}`
    return request<{ total: number; entries: CenterPluginEntry[] }>(`/api/plugins${suffix}`)
  },
  /** 下载直链（无需登录；浏览器直接跳转） */
  pluginDownloadUrl(pluginId: string, version?: string): string {
    const suffix = version === undefined ? '' : `?version=${encodeURIComponent(version)}`
    return `/api/plugins/${encodeURIComponent(pluginId)}/download${suffix}`
  },
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
  currentRelease(): Promise<{ current: CenterReleaseInfo | null }> {
    return request('/api/updates/current')
  },
  usage(query: CenterUsageQuery = {}): Promise<CenterUsageResponse> {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value))
    }
    const suffix = params.size === 0 ? '' : `?${params.toString()}`
    return request(`/api/usage${suffix}`)
  },

  /** 客户端上传的文件列表（属主过滤后端已做，uploadedAt 倒序） */
  files(): Promise<{ files: FileEntryInfo[] }> {
    return request('/api/files')
  },
  /**
   * 网页上传一个文件给指定客户端（docs/12 §5，本轮）：`POST /api/uploads?clientId=`。
   * 二进制体不带 JSON 头，文件名走 `X-File-Name`（与客户端上传同款编码）。
   * 上传成功后由 `commands.sendFile` 推给客户端落盘。
   */
  async uploadFile(
    file: File,
    clientId: string,
  ): Promise<{ fileId: string; name: string; size: number }> {
    const token = getToken()
    const response = await fetch(`/api/uploads?clientId=${encodeURIComponent(clientId)}`, {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'X-File-Name': encodeURIComponent(file.name),
        'Content-Type': 'application/octet-stream',
      },
      body: file,
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
    return (await response.json()) as { fileId: string; name: string; size: number }
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
    /** 市场列表（管理员看到的是与公开列表同形的全量快照） */
    plugins(): Promise<{ total: number; entries: CenterPluginEntry[] }> {
      return request('/api/admin/plugins')
    },
    /** 上传插件 zip 到 staging；返回 token，需再调用 publish 才进市场 */
    async uploadPlugin(file: File): Promise<{
      token: string
      plugin: { id: string; name: string; version: string; sha256: string; size: number }
    }> {
      const token = getToken()
      const response = await fetch('/api/admin/plugins/upload', {
        method: 'POST',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'Content-Type': 'application/octet-stream',
        },
        body: file,
      })
      if (!response.ok) {
        let message = `HTTP ${response.status}`
        try {
          const data = (await response.json()) as { error?: string }
          if (data.error) message = data.error
        } catch {
          // 非 JSON 错误体：保留状态码
        }
        throw new ApiError(message, response.status)
      }
      return (await response.json()) as {
        token: string
        plugin: { id: string; name: string; version: string; sha256: string; size: number }
      }
    },
    publishPlugin(token: string, changelog?: string): Promise<{ entry: CenterPluginEntry }> {
      return request('/api/admin/plugins/publish', 'POST', {
        token,
        ...(changelog === undefined || changelog.trim() === '' ? {} : { changelog }),
      })
    },
    deletePlugin(pluginId: string, version: string): Promise<{ ok: true }> {
      return request(
        `/api/admin/plugins/${encodeURIComponent(pluginId)}/${encodeURIComponent(version)}`,
        'DELETE',
      )
    },
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
    modelServices(): Promise<{ services: CenterOfficialServicesConfig }> {
      return request('/api/admin/model-services')
    },
    updateModelService(
      capability: CenterOfficialCapability,
      config: Partial<CenterOfficialServiceConfig> & { apiKey?: string | null },
    ): Promise<{ service: CenterOfficialServiceConfig }> {
      return request(`/api/admin/model-services/${encodeURIComponent(capability)}`, 'PUT', config)
    },
    fetchModelServiceModels(
      capability: CenterOfficialCapability,
      config: Record<string, unknown>,
    ): Promise<{ models: string[] }> {
      return request(
        `/api/admin/model-services/${encodeURIComponent(capability)}/models`,
        'POST',
        config,
      )
    },
    release(): Promise<{ current: CenterReleaseInfo | null }> {
      return request('/api/admin/releases')
    },
    async uploadRelease(file: File): Promise<{ ok: true; name: string; size: number }> {
      const token = getToken()
      const response = await fetch(
        `/api/admin/releases/upload?name=${encodeURIComponent(file.name)}`,
        {
          method: 'POST',
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            'Content-Type': 'application/octet-stream',
          },
          body: file,
        },
      )
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string }
        throw new ApiError(data.error ?? `HTTP ${response.status}`, response.status)
      }
      return (await response.json()) as { ok: true; name: string; size: number }
    },
    publishRelease(): Promise<{ current: CenterReleaseInfo }> {
      return request('/api/admin/releases/publish', 'POST')
    },
  },
}
