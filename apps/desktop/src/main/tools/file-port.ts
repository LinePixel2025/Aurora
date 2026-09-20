/**
 * `FilePort` 的主进程实现（docs/06 §11）。
 *
 * 用 `node:fs/promises` + `node:path`，**不得 import electron**：
 * 本文件因此能进 vitest（`file-port.test.ts`，Node 环境 + 真实临时目录）。
 * 端口保持无状态纯实现——上限（`agent.tools.files.maxReadBytes`）由装配层注入。
 *
 * 约定（与 `packages/shared/src/config/store.ts` 一致）：
 * 覆盖写走「同目录临时文件 + rename」原子写；错误信息一律带绝对路径（越界不静默）。
 */
import { appendFile, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { DirEntry, FilePort } from '@aurora/agent-core'

/** 二进制探测范围：只扫前 8 KiB，避免为判定类型读入整个大文件 */
const NUL_SCAN_BYTES = 8 * 1024

/** 含 NUL 字节即按二进制处理（文本文件不该出现 NUL） */
const BINARY_MESSAGE = '这是二进制文件，无法按文本读取（可改用 run_command 处理）'

export function createNodeFilePort(): FilePort {
  return {
    async readText(path, maxBytes) {
      const absolutePath = resolve(path)
      try {
        const info = await stat(absolutePath)
        if (info.isDirectory()) throw new Error('这是目录，不是文件（可改用 list_dir）')
        const size = info.size
        const bytesToRead = Math.min(size, Math.max(0, Math.floor(maxBytes)))
        const buffer = await readHead(absolutePath, bytesToRead)
        if (hasNulByte(buffer)) throw new Error(BINARY_MESSAGE)
        return {
          absolutePath,
          text: buffer.toString('utf8'),
          truncated: size > bytesToRead,
          bytes: buffer.length,
        }
      } catch (error) {
        throw withPath('读取文件失败', absolutePath, error)
      }
    },

    async writeText(path, content, mode) {
      const absolutePath = resolve(path)
      const bytes = Buffer.byteLength(content, 'utf8')
      try {
        await mkdir(dirname(absolutePath), { recursive: true })
        if (mode === 'append') {
          await appendFile(absolutePath, content, 'utf8')
        } else {
          await writeFileAtomic(absolutePath, content)
        }
        return { absolutePath, bytes }
      } catch (error) {
        throw withPath(mode === 'append' ? '追加写入失败' : '写入文件失败', absolutePath, error)
      }
    },

    async list(path, limit) {
      const absolutePath = resolve(path)
      try {
        const dirents = await readdir(absolutePath, { withFileTypes: true })
        const entries: DirEntry[] = []
        for (const dirent of dirents) {
          const entryPath = join(absolutePath, dirent.name)
          // 单条 stat 失败（权限 / 竞态删除 / 断链）只跳过该条，不让整次列举失败
          let info: Stats
          try {
            info = await stat(entryPath)
          } catch {
            continue
          }
          const modifiedAt = info.mtime.toISOString()
          if (info.isDirectory()) {
            entries.push({ name: dirent.name, type: 'dir', modifiedAt })
          } else if (info.isFile()) {
            entries.push({ name: dirent.name, type: 'file', sizeBytes: info.size, modifiedAt })
          }
          // 其它类型（设备 / 管道等）不入列表
        }
        entries.sort(compareEntries)
        const max = Math.max(0, Math.floor(limit))
        return {
          absolutePath,
          entries: entries.length > max ? entries.slice(0, max) : entries,
          truncated: entries.length > max,
        }
      } catch (error) {
        throw withPath('读取目录失败', absolutePath, error)
      }
    },
  }
}

/** 只读文件头部 `bytes` 个字节（大文件不整体载入内存） */
async function readHead(path: string, bytes: number): Promise<Buffer> {
  if (bytes <= 0) return Buffer.alloc(0)
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function hasNulByte(buffer: Buffer): boolean {
  return buffer.subarray(0, NUL_SCAN_BYTES).includes(0)
}

/** 同目录临时文件 + rename（原子写；失败时清掉临时文件） */
async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

/** 目录在前，同类按名称排序（与内核输出的行序一致） */
function compareEntries(a: DirEntry, b: DirEntry): number {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
  return a.name.localeCompare(b.name)
}

/**
 * 保证错误信息里出现绝对路径。
 * Node 的 fs 错误（ENOENT / EISDIR…）通常已自带路径，此时不重复包装。
 */
function withPath(action: string, absolutePath: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error)
  if (reason.includes(absolutePath)) {
    return error instanceof Error ? error : new Error(reason)
  }
  return new Error(`${action}（${absolutePath}）：${reason}`)
}
