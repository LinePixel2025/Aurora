/**
 * `ViewImagePort` 的主进程实现（图像工具，docs/06 §25）。
 *
 * 读盘路径上叠了两层判定，顺序不能换：
 * 1. **app 自有目录优先**（`<userData>/generated|screenshots|clipboard`）：命中就直接 `resolve()`
 *    读，**不做项目根校验** —— 这三处是 Agent 自己刚写下的图，而 `<userData>` 正常永远在
 *    任何项目根之外，先校验的话「看看你刚画的图」会被自己的边界拦住；
 * 2. 其余路径走**与 `read_file` 同一条**项目根 realpath 边界（`file-port.ts` 的 `resolveWithin`，
 *    边界根按**会话**解析）—— 不新增任何放行面，`allowOutside` 恒为 `false`：
 *    `view_image` 是 `safe` 档工具，没有确认卡片，也就没有"用户当次批准"这回事。
 *
 * 真实读盘复用 `attachments.ts` 的 `readImages`：**8 MiB 上限、空文件、读失败**三种情形
 * 的降级文案与附件管线共用一份实现（同一句「内容未读取」不该有两套措辞）。
 *
 * io 是注入的（`sizeOf` / `readFile`）：本文件因此不 import electron，可以在 vitest 里直接跑。
 */
import { promises as fs } from 'node:fs'
import { resolve } from 'node:path'
import type { ViewImagePort, ViewImageResult } from '@aurora/agent-core'
import { readImages, type ImageReadPort } from '../attachments.js'
import { isPathOutsideError, resolveWithin, type WorkspaceGuardOptions } from './file-port.js'
import { OUTSIDE_NOTE, isWithinAnyDir, unsupportedFormatNote } from './image-read.js'

/**
 * `ImageReadPort` 的 node:fs 实现（附件管线与 `view_image` **共用同一份**）。
 *
 * 两处各写一遍 `stat` / `readFile` 的下场是"大小上限在一边生效、另一边不生效"：
 * 上限的判定虽然共用 `readImages`，但 `sizeOf` 返回 `undefined`（写成"绕过上限"）
 * 与"按目录读"（`isFile()` 判定）这两种语义差异只在实现里。装配层只传这一个。
 */
export function createNodeImageIo(): ImageReadPort {
  return {
    sizeOf: async (path) => {
      const stat = await fs.stat(path).catch(() => undefined)
      return stat?.isFile() === true ? stat.size : undefined
    },
    readFile: (path) => fs.readFile(path),
  }
}

export interface ViewImagePortOptions {
  /** 读盘端口（真实实现是 `node:fs` 的 stat / readFile） */
  io: ImageReadPort
  /**
   * 项目根边界（与 `file-port` / `command-runner` **同一个** guard 取值器）：
   * 边界根按会话解析（会话绑定项目 > 当前项目 > …，docs/06 §5.1）。
   * 缺省 = 不做边界校验（单测与"没配项目"的语义一致）。
   */
  guard?: WorkspaceGuardOptions
  /** app 自有图片目录的**绝对路径**（装配层按 `userData` 拼出，见 `OWNED_IMAGE_SUBDIRS`） */
  ownedDirs: readonly string[]
}

export function createViewImagePort(options: ViewImagePortOptions): ViewImagePort {
  return {
    async view({ path, sessionId }): Promise<ViewImageResult> {
      const requested = path.trim()
      if (requested === '') return { path: requested, note: '缺少图片路径' }

      const formatNote = unsupportedFormatNote(requested)
      if (formatNote !== undefined) return { path: requested, note: formatNote }

      let target: string
      try {
        target = isWithinAnyDir(requested, options.ownedDirs)
          ? resolve(requested)
          : await resolveWithin(requested, false, options.guard, sessionId)
      } catch (error) {
        return {
          path: requested,
          note: isPathOutsideError(error) ? OUTSIDE_NOTE : `路径解析失败：${describeError(error)}`,
        }
      }

      const [loaded] = await readImages([target], options.io)
      if (loaded === undefined) return { path: target, note: '读取失败' }
      if (loaded.image === undefined) return { path: target, note: loaded.note ?? '读取失败' }
      return { path: target, image: loaded.image }
    },
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
