/**
 * 网络层（docs/08 §6 `advanced.proxy`）。
 *
 * 为什么需要它：`advanced.proxy` 曾经只是个「存了不生效」的配置项 ——
 * Node 的 `globalThis.fetch`（undici）**不读** Chromium 会话的代理设置，
 * 因此国内用户配了代理，LLM 与 MCP HTTP 依然直连失败。
 *
 * 做法：
 * 1. 代理本身交给 Electron 的 `session.setProxy`，让 Chromium 网络栈统一生效；
 * 2. 出网请求改用 Electron 的 `net.fetch`（走 Chromium 网络栈，自动遵守上面的代理），
 *    不可用时回落到 `globalThis.fetch`，保证异常环境仍能跑。
 *
 * 边界：本文件是**唯一**接触 electron 的代理相关文件；`agent-core` 只接受注入的
 * `fetchImpl`，因此内核保持 Electron-free（AGENTS.md 架构硬约束 1）。
 * 纯解析逻辑在 `net-proxy.ts`（可单测）。
 */
import { net, session, type Session } from 'electron'
import { parseProxy, type ProxySpec } from './net-proxy.js'

export { parseProxy, type ProxySpec }

/**
 * 应用代理到指定会话（默认 default session）。
 *
 * 必须在每次代理变更后调用 `closeAllConnections()`：已建立的 keep-alive 连接
 * 仍然走旧路径，不清理的话用户会看到「改了代理但没生效」。
 */
export async function applyProxy(raw: string, target?: Session): Promise<ProxySpec> {
  const targetSession = target ?? session.defaultSession
  const spec = parseProxy(raw)
  await (spec.mode === 'direct'
    ? targetSession.setProxy({ mode: 'direct' })
    : targetSession.setProxy({ mode: 'fixed_servers', proxyRules: spec.rules ?? '' }))
  // 关闭残留连接，让新请求立即走新代理 / 直连
  await targetSession.closeAllConnections().catch(() => undefined)
  return spec
}

/**
 * 出网 fetch：优先用 Electron `net.fetch`（走 Chromium 网络栈 → 遵守会话代理），
 * 不可用时回落 `globalThis.fetch`。
 *
 * 保留回落的理由：LLM 的 SSE 依赖 ReadableStream 的完整支持，
 * 万一某个 Electron 版本或环境下 `net.fetch` 不可用，
 * 回落到 undici 至少能保证直连场景照常工作。
 */
export function createNetFetch(): typeof fetch {
  const electronFetch = (net as { fetch?: typeof fetch } | undefined)?.fetch
  if (typeof electronFetch === 'function') {
    return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      electronFetch.call(net, input, init)) as typeof fetch
  }
  return globalThis.fetch
}
