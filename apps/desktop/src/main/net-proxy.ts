/**
 * 代理字符串归一（docs/08 §6 `advanced.proxy`）。
 *
 * 单独成文件的原因：`net.ts` 需要 import `electron`（`net` / `session`），
 * 而 vitest 只收「不 import electron」的主进程模块。把纯解析放在这里，
 * 就能直接对**真实实现**做单测，而不是在测试里复写一份容易漂移的逻辑。
 */

/** 代理配置归一结果 */
export interface ProxySpec {
  /** `direct` 表示显式直连（清除代理），`fixed` 表示使用给定规则 */
  mode: 'direct' | 'fixed'
  /** Chromium proxyRules，例如 `http://127.0.0.1:7890` 或 `socks5://127.0.0.1:1080` */
  rules?: string
}

/**
 * 解析用户填写的代理串。
 *
 * 三种形态：
 * 1. 带 scheme（`http://127.0.0.1:7890`、`socks5://…`）→ 原样保留；
 * 2. Chromium 的分协议规则（`http=…;https=…`）→ 原样保留；
 * 3. 裸 `host:port`（用户最常见写法）→ 补 `http://`。
 *
 * 第 3 条是必需的：Chromium 会把无 scheme 的规则当成**协议名**去解析而失败，
 * 表现为「配了代理但完全没用」，且日志里看不出原因。
 * 第 2 条若被误补前缀会变成 `http://http=…`，同样静默失效。
 */
export function parseProxy(raw: string): ProxySpec {
  const value = raw.trim()
  if (value === '') return { mode: 'direct' }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return { mode: 'fixed', rules: value }
  if (value.includes('=')) return { mode: 'fixed', rules: value }
  return { mode: 'fixed', rules: `http://${value}` }
}
