/**
 * `view_image` 读盘策略的**纯逻辑**（docs/06 §25）。
 *
 * 为什么单独成文件：`image-read-port.ts` 要 import `node:fs` 侧的端口与项目根边界，
 * 而这两条判定（扩展名、app 自有目录）是纯粹的字符串逻辑 —— 抽出来才能被单测直接覆盖，
 * 与 `attachments.ts` / `workspace-target.ts` 同一套分层。
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'
import { IMAGE_EXTENSIONS, extensionOf } from '../attachments.js'

/**
 * app **自有图片目录**的目录名（`<userData>/` 之下）：
 * `generated` 生图产物、`screenshots` 截屏产物、`clipboard` 剪贴板图片产物。
 *
 * 这三个目录里的图片**始终可读**，不受项目根边界限制 —— 它们是 Agent 自己刚写下的东西，
 * 用户说「看看你刚画的那张图」时必须读得到；而 `<userData>` 在 `%APPDATA%` 下，
 * 正常永远落在任何项目根之外（Agent 空间根是 `桌面\Aurora`）。
 *
 * 目录名在这里列一份，`:screenshots` / `:clipboard` 的落盘实现从同一个常量取子目录名 ——
 * 名单漂移的症状是「工具说读不了自己刚存的图」，排查成本远高于共用一份常量。
 */
export const OWNED_IMAGE_SUBDIRS = ['generated', 'screenshots', 'clipboard'] as const

/**
 * 该路径是否落在 `dirs` 里的**任一**目录内（含子目录）。
 *
 * 判定与 `imagegen.ts` 的 `read` 逐字同款：两侧都 `resolve()` 归一后取 `relative`，
 * `rel` 为空（就是目录本身）/ 以 `..` 段开头 / 是绝对路径（换盘符）一律**不算命中**。
 * `..` 段的判据是 `rel === '..' || rel.startsWith('..' + sep)`，**不是** `startsWith('..')`
 * —— 后者会把目录内一个合法的 `..foo` 条目误判成越界（`relative` 对它返回的正是 `..foo`）。
 */
export function isWithinAnyDir(target: string, dirs: readonly string[]): boolean {
  const resolved = resolve(target)
  for (const dir of dirs) {
    const rel = relative(resolve(dir), resolved)
    if (rel === '') continue
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue
    return true
  }
  return false
}

/**
 * 非图片扩展名的可操作提示（是图片则返回 `undefined`）。
 *
 * 为什么要拦：`read_file` 明确拒绝二进制，模型很容易拿 `view_image` 去读 `AGENTS.md`
 * 或 `.json` —— 那种调用会走到「读出来一堆乱码字节当图片发」的路径上（服务端还会 400）。
 * 这里如实回一句该用哪个工具，比让它自己猜便宜。
 */
export function unsupportedFormatNote(path: string): string | undefined {
  const ext = extensionOf(path)
  if (IMAGE_EXTENSIONS.includes(ext)) return undefined
  const allowed = IMAGE_EXTENSIONS.join(' / ')
  return ext === ''
    ? `不是图片文件（没有扩展名），只能读 ${allowed}；读文本文件请用 read_file`
    : `不是图片格式（.${ext}），只能读 ${allowed}；读文本文件请用 read_file`
}

/** 项目根之外时的提示语：给出**可操作的下一步**，而不是只说"越界"。 */
export const OUTSIDE_NOTE =
  '该路径在当前会话的项目根之外，无法直接读取；可以让用户把图片拖进对话窗口，' +
  '或把图片放到工作目录内再试'
