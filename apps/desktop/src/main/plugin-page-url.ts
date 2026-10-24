/**
 * 插件页面 URL 的纯解析（`page-protocol.ts` 的协议处理与窗口守卫共用）。
 *
 * 只做「形状」判定：是不是本协议、插件 id 与相对路径能不能拆出来。
 * 磁盘层面的路径 containment 由协议处理器在 `realpath` 之后再做一次。
 */

export const PLUGIN_PAGE_SCHEME = 'aurora-plugin'

/** 页面可加载的文件类型（其余一律 403）。 */
export const PLUGIN_PAGE_MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

/**
 * 页面 CSP（docs/14 §2.4）：只允许自身资源；`connect-src 'none'` 逼插件走宿主 RPC，
 * 不开放 `frame` / `object` / 表单提交。
 */
export const PLUGIN_PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'none'; media-src 'self'; " +
  "object-src 'none'; base-uri 'none'; form-action 'none'"

export interface PluginPageTarget {
  pluginId: string
  /** 包内相对路径（已解码，`/` 分隔） */
  path: string
}

/** 解析 `aurora-plugin://<id>/<path>`；非本协议 / 形状不对返回 null。 */
export function pluginPageTargetOf(rawUrl: string): PluginPageTarget | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== `${PLUGIN_PAGE_SCHEME}:`) return null
  const pluginId = parsed.hostname
  if (pluginId === '') return null
  let path: string
  try {
    path = decodeURIComponent(parsed.pathname)
  } catch {
    return null
  }
  path = path.replace(/^\/+/, '')
  if (path === '' || path.includes('\0') || path.includes('\\') || /^[a-zA-Z]:/.test(path)) {
    return null
  }
  if (path.split('/').some((segment) => segment === '..' || segment === '.')) return null
  return { pluginId, path }
}

export function isPluginPageUrl(rawUrl: string): boolean {
  return pluginPageTargetOf(rawUrl) !== null
}
