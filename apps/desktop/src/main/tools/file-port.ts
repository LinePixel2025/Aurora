/**
 * `FilePort` 的主进程实现（docs/06 §11、§20）。
 *
 * 用 `node:fs/promises` + `node:path`，**不得 import electron**：
 * 本文件因此能进 vitest（`file-port.test.ts`，Node 环境 + 真实临时目录）。
 * 端口保持无状态纯实现——上限（`agent.tools.files.maxReadBytes`）由装配层注入，
 * 行窗口常量（`DEFAULT_READ_LINES` / `MAX_READ_LINES` / `MAX_READ_SCAN_BYTES`）由内核持有，
 * 这里只引用它们，不另写一份字面量。
 *
 * 约定（与 `packages/shared/src/config/store.ts` 一致）：
 * 覆盖写走「同目录临时文件 + rename」原子写；错误信息一律带绝对路径（越界不静默）。
 */
import { appendFile, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DEFAULT_READ_LINES, MAX_READ_LINES, MAX_READ_SCAN_BYTES } from '@aurora/agent-core'
import type { DirEntry, FilePort, ReadLine } from '@aurora/agent-core'

/** 二进制探测范围：只扫前 8 KiB，避免为判定类型读入整个大文件 */
const NUL_SCAN_BYTES = 8 * 1024

/** 含 NUL 字节即按二进制处理（文本文件不该出现 NUL） */
const BINARY_MESSAGE = '这是二进制文件，无法按文本读取（可改用 run_command 处理）'

export function createNodeFilePort(): FilePort {
  return {
    /**
     * 读**行窗口**（docs/06 §11、§20）。
     *
     * - 行号 **1 起始、相对文件开头**；`ReadLine.number` 不随 `offsetLines` 改变。
     * - 行切分兼容 CRLF（逐行去掉行尾 `\r`）：`1: 内容` 里不会夹一个看不见的回车，
     *   模型据此写出的 `oldString` 也是干净的；**文件本身不被修改**。
     * - `maxBytes` 只约束**切片之后的窗口**（不再是从文件头截断），所以大文件的后半段能读到；
     *   窗口里**至少保留一行**（见 `sliceLineWindow` 的强制首行规则）。
     * - 文件超过 `MAX_READ_SCAN_BYTES` 时只读前 16 MiB 用于定位行，且**不给 `totalLines`**
     *   （`scanLimitHit: true`）——静默把 16 MiB 当成全文会报出一个假的总行数，
     *   模型按它推算 `offsetLines` 会读到错位的内容。该读入边界可能把最后一行切成两半：
     *   那一行的**行号仍正确**、内容不完整，调用方据 `scanLimitHit` 已知「只解析了开头」。
     * - 含 NUL 字节按二进制拒绝；目录提示改用 `list_dir`（两条口径与旧实现一致）。
     */
    async readText(path, options) {
      const absolutePath = resolve(path)
      try {
        const info = await stat(absolutePath)
        if (info.isDirectory()) throw new Error('这是目录，不是文件（可改用 list_dir）')
        const totalBytes = info.size
        const scanLimitHit = totalBytes > MAX_READ_SCAN_BYTES
        // 16 MiB 以内的文件整体读入（单用户桌面、工具顺序执行）；
        // 更大的文件只读前 16 MiB 用于定位行，不把全文载入内存
        const buffer = await readHead(absolutePath, scanLimitHit ? MAX_READ_SCAN_BYTES : totalBytes)
        if (hasNulByte(buffer)) throw new Error(BINARY_MESSAGE)
        const allLines = splitTextLines(buffer.toString('utf8'))
        const window = sliceLineWindow(
          allLines,
          resolveOffsetLines(options.offsetLines),
          resolveLimitLines(options.limitLines),
          options.maxBytes,
        )
        const last = window.lines[window.lines.length - 1]
        // 「后面还有内容」按**文件里的行**判断：`offsetLines` 越过末尾拿到空窗口时不算截断
        //（后面本来就没有内容了），而命中扫描上限时一定还有没读到的部分。
        const hasMoreLines = last !== undefined && last.number < allLines.length
        return {
          absolutePath,
          lines: window.lines,
          // 命中扫描上限时总行数未知（不能拿 16 MiB 去数）
          totalLines: scanLimitHit ? undefined : allLines.length,
          truncated: scanLimitHit || hasMoreLines,
          scanLimitHit,
          bytes: window.bytes,
          totalBytes,
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

/**
 * 按 `\n` 切分文本，并逐行去掉行尾的 `\r`（CRLF 兼容）。行数口径：
 *
 * - `'a\r\nb\r\n'` → `['a', 'b']`（2 行，`text` 里不含 `\r`）
 * - `'a\nb'` → `['a', 'b']`（末行没有换行符时**不凭空补一个空行**）
 * - `'a\nb\n'` → `['a', 'b']`（末尾换行符**不产生第 3 行**）
 * - `''` → `[]`（空文件是 **0 行**，不是 1 行）
 * - `'a\n\n'` → `['a', '']`（真正的空行算一行）
 *
 * 去掉 `\r` 只影响**返回给模型**的文本（也让 `edit_file` 的 `oldString` 干净），
 * 文件本身不会被这个函数（或端口）改写。
 */
function splitTextLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  // 末尾换行符切出的那个空串不是新的一行
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

interface LineWindow {
  lines: ReadLine[]
  /** 窗口的实际字节数（见 `sliceLineWindow`） */
  bytes: number
}

/**
 * 从第 `offsetLines` 行开始累加窗口，直到行数达 `limitLines` 或字节数超 `maxBytes`。
 *
 * **第一行强制保留**：即使窗口第一行单独就超过 `maxBytes`，也必须把它带回来 ——
 * 否则模型拿到空结果、既没有内容也无从判断该怎么调整 `offsetLines`（把上限压得更低也推不动）。
 *
 * `bytes` 是窗口的**实际**字节数：各行 UTF-8 字节数之和，加上行间换行符每处 1 字节
 * （末尾不加换行），即 `lines.join('\n')` 的字节数。
 */
function sliceLineWindow(
  allLines: readonly string[],
  offsetLines: number,
  limitLines: number,
  maxBytes: number,
): LineWindow {
  const byteLimit = Math.max(0, Math.floor(maxBytes))
  const lines: ReadLine[] = []
  let bytes = 0
  for (let index = offsetLines - 1; index < allLines.length; index += 1) {
    if (lines.length >= limitLines) break
    const text = allLines[index] ?? ''
    const lineBytes = Buffer.byteLength(text, 'utf8')
    if (lines.length === 0) {
      bytes = lineBytes
    } else {
      // 加上这一行（含行间换行符）会超上限就到此为止，窗口不超 maxBytes
      if (bytes + 1 + lineBytes > byteLimit) break
      bytes += 1 + lineBytes
    }
    lines.push({ number: index + 1, text })
  }
  return { lines, bytes }
}

/** `offsetLines` 的取整与钳制：缺省 1；非数字 / NaN 回落 1；小于 1 一律当 1（端口是独立入口） */
function resolveOffsetLines(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.max(Math.floor(value), 1)
}

/** `limitLines` 的取整与钳制：缺省 `DEFAULT_READ_LINES`；非数字 / NaN 回落缺省；钳到 1–`MAX_READ_LINES` */
function resolveLimitLines(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_READ_LINES
  return Math.min(Math.max(Math.floor(value), 1), MAX_READ_LINES)
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
