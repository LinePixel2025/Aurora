/**
 * `BrowserSessionPort` 的主进程实现（v35，docs/06 §27）。
 *
 * 分层：内核（`agent-core/src/tools/browser.ts`）只定义工具与端口；本文件负责
 * **策略**（开关 / URL / 内网 / 直连 chrome 会话），真正的驱动在 `browser-agent.ts`。
 * 拆开的原因：
 * - 本文件不 import electron，URL 与内网判定可以直接单测（含边界用例）；
 * - 开发自测（capture / smoke）要直接打开本地夹具页，可以绕过工具面的 http(s) 限制，
 *   但**不能**绕过开关 —— 策略留在端口层，测试只替换 driver。
 *
 * 语义（docs/06 §27）：
 * - 只接受 http / https；无协议按主机名补全（本机地址补 http，其余补 https）；
 * - `agent.browser.allowPrivateNetwork === false` 时拒绝本机 / 内网 / 链路本地地址；
 * - 总开关关闭时明确报错（注册表正常情况下已不注册工具，这是纵深防御）；
 * - 并发上限由 driver（会话槽位）判定，错误文案原样透出。
 */
import { isIP } from 'node:net'
import type {
  BrowserAction,
  BrowserEvalResult,
  BrowserReadInput,
  BrowserReadResult,
  BrowserScreenshotResult,
  BrowserSessionPort,
  BrowserSnapshot,
  BrowserWaitInput,
  BrowserWaitResult,
} from '@aurora/agent-core'
import type { Logger } from '@aurora/shared'

/** 端口只需要这几个字段（结构类型，避免测试时构造整份 Settings）。 */
export interface BrowserPortSettings {
  enabled: boolean
  allowPrivateNetwork: boolean
}

/** 驱动接口（`BrowserAgentManager` 满足它；单测用假实现）。 */
export interface BrowserAgentDriver {
  open(sessionId: string, url: string, title: string): Promise<void>
  snapshot(sessionId: string): Promise<BrowserSnapshot>
  act(
    sessionId: string,
    action: BrowserAction,
    params: {
      ref?: string
      text?: string
      key?: string
      direction?: 'up' | 'down' | 'left' | 'right'
      amount?: number
      value?: string
    },
  ): Promise<{ summary: string; url: string; title: string }>
  read(sessionId: string, what: BrowserReadInput['what']): Promise<BrowserReadResult>
  wait(sessionId: string, input: Omit<BrowserWaitInput, 'sessionId'>): Promise<BrowserWaitResult>
  screenshot(sessionId: string, fullPage: boolean): Promise<BrowserScreenshotResult>
  evaluate(sessionId: string, expression: string): Promise<BrowserEvalResult>
  stop(sessionId: string, reason: string): boolean
}

export interface BrowserPortDeps {
  driver: BrowserAgentDriver
  settings: () => BrowserPortSettings
  logger: Logger
}

/** 本机地址：用户/本地开发服务器最常直接敲 `localhost:3000`（与地址栏同口径）。 */
const LOCAL_HOST_PATTERN =
  /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i

export function createBrowserAgentPort(deps: BrowserPortDeps): BrowserSessionPort {
  const ensureEnabled = (): void => {
    if (deps.settings().enabled) return
    throw new Error('内置浏览器已被用户关闭：请让用户到「设置 → 智能与工具 → 内置浏览器」开启。')
  }

  const resolveTarget = (raw: string): string => {
    const normalized = normalizeBrowserUrl(raw)
    if (!normalized.ok) throw new Error(normalized.error)
    if (!deps.settings().allowPrivateNetwork) {
      const host = hostnameOf(normalized.url)
      if (host !== '' && isPrivateHostname(host)) {
        throw new Error(
          `当前设置不允许访问本机 / 内网地址（${host}）：请让用户在设置里开启「允许访问本机与内网地址」。`,
        )
      }
    }
    return normalized.url
  }

  return {
    async open({ sessionId, url }) {
      ensureEnabled()
      const target = resolveTarget(url)
      deps.logger.info('内置浏览器打开页面', { sessionId, host: hostnameOf(target) })
      await deps.driver.open(sessionId, target, '')
      const snapshot = await deps.driver.snapshot(sessionId)
      return { url: snapshot.url === '' ? target : snapshot.url, title: snapshot.title, snapshot }
    },

    async snapshot({ sessionId }) {
      ensureEnabled()
      return deps.driver.snapshot(sessionId)
    },

    async act({ sessionId, action, ...params }) {
      ensureEnabled()
      return deps.driver.act(sessionId, action, params)
    },

    async read({ sessionId, what }) {
      ensureEnabled()
      return deps.driver.read(sessionId, what)
    },

    async wait({ sessionId, ...input }) {
      ensureEnabled()
      return deps.driver.wait(sessionId, input)
    },

    async screenshot({ sessionId, fullPage }) {
      ensureEnabled()
      const shot = await deps.driver.screenshot(sessionId, fullPage === true)
      deps.logger.info('内置浏览器截图', {
        sessionId,
        bytes: shot.bytes,
        width: shot.width,
        height: shot.height,
      })
      return shot
    },

    async evaluate({ sessionId, expression }) {
      ensureEnabled()
      return deps.driver.evaluate(sessionId, expression)
    },

    async close({ sessionId }) {
      const closed = deps.driver.stop(sessionId, '已通过 browser_close 结束')
      return { closed }
    },
  }
}

export type NormalizedBrowserUrl = { ok: true; url: string } | { ok: false; error: string }

/**
 * 归一 Agent 给的 URL：
 * - 带 `http://` / `https://` 原样保留（其余协议一律拒绝，含 `file:` / `javascript:` / `data:`）；
 * - 无协议：本机地址补 `http://`，其余补 `https://`（与地址栏同一口径）。
 */
export function normalizeBrowserUrl(raw: string): NormalizedBrowserUrl {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false, error: '缺少要打开的网址。' }
  const withScheme = trimmed.includes('://')
    ? trimmed
    : LOCAL_HOST_PATTERN.test(trimmed)
      ? `http://${trimmed}`
      : `https://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    return { ok: false, error: `网址无法解析：${trimmed}` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      error: `只支持 http / https 网址（收到 ${parsed.protocol}）；本地文件请用 show_preview。`,
    }
  }
  if (parsed.hostname === '') return { ok: false, error: `网址缺少主机名：${trimmed}` }
  return { ok: true, url: parsed.toString() }
}

/** 取 hostname（去掉 IPv6 的方括号；解析失败返回空串）。 */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase()
  } catch {
    return ''
  }
}

/**
 * 本机 / 内网 / 链路本地地址判定（`allowPrivateNetwork=false` 时拒绝）。
 *
 * 覆盖：
 * - 主机名：`localhost` / `*.localhost` / `*.local` / `*.internal` / `*.lan`；
 * - IPv4：`0.0.0.0`、`127/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`100.64/10`；
 * - IPv6：`::1`、`fc00::/7`（fc / fd 开头）、`fe80::/10`。
 *
 * 刻意不解析 DNS：域名解析到内网 IP 的情况交给系统网络层，这里只挡「明显是内网」的字面量。
 */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '')
  if (host === '') return false
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return true
  const family = isIP(host)
  if (family === 4) {
    const parts = host.split('.').map((part) => Number.parseInt(part, 10))
    const [a = 0, b = 0] = parts
    if (a === 0 || a === 127 || a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  if (family === 6) {
    if (host === '::1' || host === '::') return true
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true
    return false
  }
  return false
}
