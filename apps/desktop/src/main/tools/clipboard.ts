/**
 * `ClipboardPort` 的主进程实现（Design/betav2-spec.md §8.4、docs/06 §14）。
 *
 * 直接使用 Electron 的 `clipboard`（只有主进程拿得到），映射成内核的
 * `read() / write()` 两个异步方法。本文件**允许 import electron**——
 * 因此**没有也不该有**单测（vitest 的 Node 环境加载不了它）；
 * 工具层的参数解析与 `sensitivity: 'confirm'` 语义由 agent-core 的
 * `createClipboardTools` 覆盖。
 */
import { clipboard } from 'electron'
import type { ClipboardPort } from '@aurora/agent-core'

export function createElectronClipboardPort(): ClipboardPort {
  return {
    async read(): Promise<string> {
      // 非文本内容（图片 / 文件）readText 返回空串，由工具层折叠成「剪贴板为空」提示
      return clipboard.readText()
    },
    async write(text: string): Promise<void> {
      clipboard.writeText(text)
    },
  }
}
