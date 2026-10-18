/**
 * 内置浏览器的「兼容 User-Agent」（v35，docs/06 §27）。
 *
 * 不少站点会对 `Electron/x.y.z` 这个 token 走兼容性分支或直接拒绝（「请使用 Chrome」），
 * 这是「Agent 能访问所有网站」最常见的实际障碍之一。做法不是伪造一个新浏览器，
 * 而是**把宿主 UA 里属于 Electron / Aurora 的 token 去掉**，保留同一份 Chromium 版本号 ——
 * 版本与真实内核一致，不会把网站带进错误的特性分支。
 *
 * 只在 Agent 控制的标签上使用（`agent.browser.compatUserAgent` 打开时）；用户自己的
 * 浏览器标签保持原 UA，避免用户的登录态 / 站点白名单被意外切换。
 */

/** 默认要剥掉的 token（Electron 运行时 + 应用自身）；大小写不敏感 */
const HOST_TOKENS = [/electron\/[^\s]+/gi, /aurora\/[^\s]+/gi]

/**
 * 剥掉 Electron / 应用 token 并压平空白。
 *
 * 失败兜底：入参为空串、或剥完只剩空串时原样返回 `raw` —— 宁可给一个带 Electron
 * token 的 UA，也不要给一个空 UA（有些站点会直接 403，比识别成 Electron 更难查）。
 */
export function compatUserAgent(raw: string): string {
  const source = raw.trim()
  if (source === '') return raw
  let next = source
  for (const pattern of HOST_TOKENS) next = next.replace(pattern, ' ')
  next = next.replace(/\s+/g, ' ').trim()
  if (next === '' || !/mozilla|chrome|safari/i.test(next)) return source
  return next
}
