/**
 * 右栏「文件」tab 的目录列表实现（2026-10-03，docs/07 §2.3）。
 *
 * 口径与 `file-preview.ts` 同源（同一个边界根、同一套 `resolveWithin` realpath 前缀校验）：
 * - 缺省列出**会话边界根**（绑定了项目 → 项目文件夹；未绑定 → 会话空间目录），
 *   于是「有项目的会话」在文件 tab 里直接看到自己的项目目录；
 * - 只列目录，不递归、不跟随链接展开（组件按需逐层进入）；
 * - 边界根解析不出来时**直接拒绝**（与 preview:read 同款：渲染层主动发起的读通道
 *   不退回无边界）。
 */
import { promises as nodeFs } from 'node:fs'
import { join } from 'node:path'
import { assertPreviewPath, type PreviewPathPort } from './preview-path.js'
import type { FileListEntry, FileListResult } from '@aurora/shared'

/** 单次列出的条目上限：目录再大也只列前 N 条（避免一次把上万条推给渲染层） */
export const FILE_LIST_MAX_ENTRIES = 500

export type FileListPort = PreviewPathPort

export async function buildFileList(
  port: FileListPort,
  request: { sessionId: string; path?: string },
): Promise<FileListResult> {
  const requested = typeof request.path === 'string' ? request.path.trim() : ''
  // 缺省列边界根。根不可用时这里得到空串，由 assertPreviewPath 统一报「没有可用的工作目录」
  const target = requested === '' ? (port.rootOf(request.sessionId) ?? '') : requested
  const { path: dir, root } = await assertPreviewPath(port, {
    sessionId: request.sessionId,
    path: target,
  })

  const stat = await nodeFs.stat(dir).catch(() => undefined)
  if (stat === undefined) throw new Error('目录不存在或无法访问')
  if (!stat.isDirectory()) throw new Error('不是目录（只有目录可以列出）')

  const dirents = await nodeFs.readdir(dir, { withFileTypes: true })
  const entries: FileListEntry[] = []
  let truncated = false
  for (const dirent of dirents) {
    if (entries.length >= FILE_LIST_MAX_ENTRIES) {
      truncated = true
      break
    }
    // 目录项之外（符号链接 / 设备等）按文件对待，`stat` 失败按 0 字节——列表不因
    // 一个坏链接整体失败（点开预览时预览侧会如实报「文件不存在或无法访问」）
    const isDir = dirent.isDirectory()
    const path = join(dir, dirent.name)
    let bytes = 0
    let mtimeMs: number | undefined
    if (!isDir) {
      const fileStat = await nodeFs.stat(path).catch(() => undefined)
      bytes = fileStat?.size ?? 0
      mtimeMs = fileStat?.mtimeMs
    }
    entries.push({
      name: dirent.name,
      path,
      kind: isDir ? 'dir' : 'file',
      bytes,
      ...(mtimeMs === undefined ? {} : { mtimeMs }),
    })
  }

  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'dir' ? -1 : 1
    // 数字感知排序：`lesson2` 排在 `lesson10` 前面（`localeCompare` 的 numeric 选项）
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
  })

  return { root, dir, entries, ...(truncated ? { truncated: true } : {}) }
}
