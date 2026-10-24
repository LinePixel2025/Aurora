/**
 * 插件页面的自定义协议与 guest 归属（docs/14 §2.4）。
 *
 * `aurora-plugin://<pluginId>/<path>` 只服务已安装 / 开发目录里已启用插件的文件：
 * 路径 `realpath` 后必须仍在插件根内，扩展名走 MIME 白名单，响应统一带严格 CSP。
 *
 * 页面本身跑在 webview guest 里（沙箱 + 专用 preload），RPC 由渲染层中继到主进程；
 * 这里登记 `webContentsId → { pluginId, hostId }`，`plugins:pageRpc` 据此拒绝冒名请求。
 */
import { promises as fs } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { protocol, type Session, type WebContents } from 'electron'
import type { Logger } from '@aurora/shared'
import type { PluginManager } from './plugins/manager.js'
import {
  isPluginPageUrl,
  PLUGIN_PAGE_CSP,
  PLUGIN_PAGE_MIME_TYPES,
  PLUGIN_PAGE_SCHEME,
  pluginPageTargetOf,
  type PluginPageTarget,
} from './plugin-page-url.js'

export {
  isPluginPageUrl,
  PLUGIN_PAGE_CSP,
  PLUGIN_PAGE_SCHEME,
  pluginPageTargetOf,
  type PluginPageTarget,
}

/** 在 `app.whenReady()` 之前注册 scheme 特权（否则 webview 会按普通 URL 处理）。 */
export function registerPluginPageScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PLUGIN_PAGE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: false,
      },
    },
  ])
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await fs.realpath(path)
  } catch {
    return null
  }
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function textResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

/** 每个 session 只注册一次协议处理器（WeakSet 跟着 session 生命周期走） */
const registeredSessions = new WeakSet<Session>()
let pageHandler: ((request: Request) => Promise<Response>) | undefined

/**
 * 在插件 webview 的**独立 partition session** 上挂同一个处理器。
 *
 * Electron 的 `protocol` 模块只作用于默认 session；插件页面跑在 `plugin-<id>` partition 里，
 * 不在这里补注册就会得到 `ERR_FAILED`（实测）。
 */
export function ensurePluginPageProtocol(session: Session): boolean {
  if (pageHandler === undefined) return false
  if (registeredSessions.has(session)) return true
  registeredSessions.add(session)
  session.protocol.handle(PLUGIN_PAGE_SCHEME, pageHandler)
  return true
}

/** 注册 `aurora-plugin://` 处理器（`app.whenReady()` 之后调用一次）。 */
export function registerPluginPageProtocol(manager: PluginManager, logger: Logger): void {
  pageHandler = async (request) => {
    const target = pluginPageTargetOf(request.url)
    if (target === null) return textResponse(400, '非法插件页面地址')
    const summary = manager.get(target.pluginId)
    if (summary === undefined) return textResponse(404, '插件不存在')
    if (summary.status === 'disabled') return textResponse(403, '插件已停用')
    const root = manager.installPathOf(target.pluginId)
    if (root === undefined) return textResponse(404, '插件目录不存在')

    const extension = target.path.slice(target.path.lastIndexOf('.')).toLowerCase()
    const mime = PLUGIN_PAGE_MIME_TYPES[extension]
    if (mime === undefined) return textResponse(403, '不允许的文件类型')

    const rootReal = await realpathOrNull(resolve(root))
    const fileReal = await realpathOrNull(join(root, target.path))
    if (rootReal === null || fileReal === null) return textResponse(404, '文件不存在')
    if (!isWithin(rootReal, fileReal)) {
      logger.warn('插件页面路径越界，已拒绝', {
        pluginId: target.pluginId,
        path: target.path,
      })
      return textResponse(403, '路径越界')
    }

    try {
      const body = await fs.readFile(fileReal)
      logger.debug('插件页面已读取', {
        pluginId: target.pluginId,
        path: target.path,
        bytes: body.byteLength,
        mime,
      })
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Content-Security-Policy': PLUGIN_PAGE_CSP,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        },
      })
    } catch (error) {
      logger.warn('插件页面读取失败', {
        pluginId: target.pluginId,
        path: target.path,
        error: String(error),
      })
      return textResponse(500, '读取失败')
    }
  }
  protocol.handle(PLUGIN_PAGE_SCHEME, pageHandler)
}

// ───────────────────────── guest 归属 ─────────────────────────

export interface PluginGuest {
  pluginId: string
  /** 承载 webview 的窗口 webContents */
  hostId: number
  /** 桌面小组件页面时记录小组件 id（面板页面为空） */
  widgetId?: string
}

const guests = new Map<number, PluginGuest>()

function widgetIdOfUrl(rawUrl: string): string | undefined {
  try {
    const value = new URL(rawUrl).searchParams.get('widget')
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * `did-attach-webview` 时登记：只有自家窗口里的 aurora-plugin 页面才允许中继 RPC。
 * `src` 由 attach 前的 `will-attach-webview` 一并带过来 —— guest 刚 attach 时
 * `getURL()` 还是空串，不能用它判归属。
 */
export function registerPluginPageGuest(guest: WebContents, host: WebContents, src?: string): void {
  const source = src ?? guest.getURL()
  const target = pluginPageTargetOf(source)
  if (target === null) return
  const id = guest.id
  const widgetId = widgetIdOfUrl(source)
  guests.set(id, { pluginId: target.pluginId, hostId: host.id, ...(widgetId === undefined ? {} : { widgetId }) })
  guest.once('destroyed', () => guests.delete(id))
}

export function pluginPageGuestOf(webContentsId: number): PluginGuest | undefined {
  return guests.get(webContentsId)
}

/** 测试 / 退出收尾用 */
export function clearPluginPageGuests(): void {
  guests.clear()
}
