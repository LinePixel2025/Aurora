/**
 * 文件与「打开」类操控工具（docs/06 §11）。
 *
 * 内核只认识**注入的端口**：真实系统调用在主进程
 * （`apps/desktop/src/main/tools/file-port.ts` / `open-port.ts`），
 * 因此本文件保持纯 Node、可在 Node 里完整单测（`files.test.ts`）。
 * 工具名与顺序与 `COMPUTER_TOOL_NAMES` 一致（`run_command` 见 `terminal.ts`）。
 *
 * 安全边界（docs/06 §11.1）：`write_file` / `open_path` 为 `sensitivity: 'confirm'`，
 * 逐次调用都要过 `confirmTool` 钩子；路径**不设沙箱**，越界不静默——
 * 结果里一律回带解析后的绝对路径，由用户据此决定是否放行。
 */
import type { ToolDefinition, ToolResult } from './registry.js'

/** `read_file` 单次读取下限：防止模型传 1 字节反复试探把上下文刷爆 */
const MIN_READ_BYTES = 1_024
const MIN_LIST_LIMIT = 1
const MAX_LIST_LIMIT = 500
/** `list_dir` 未指定 limit 时的默认条数 */
const DEFAULT_LIST_LIMIT = 200

/** `read_file` 未指定 `limit` 时返回的行数（docs/06 §11、§20） */
export const DEFAULT_READ_LINES = 2_000
/** `read_file` 单次可请求的最大行数 */
export const MAX_READ_LINES = 5_000
/** 单行展示上限：超出即截断（对齐 opencode `read.txt` 的 2000 字符） */
export const MAX_LINE_CHARS = 2_000
/** 端口单次可扫描的文件上限：超过即拒绝并提示改用 `grep` / `run_command` */
export const MAX_READ_SCAN_BYTES = 16 * 1024 * 1024
/**
 * `offset` 的内核防护上限：超过它的行号一定落在任何可读文件的末尾之外，
 * 端口按「超出文件末尾」返回空窗口即可，不需要在这里报错。
 */
const MAX_READ_OFFSET = 10_000_000

export interface ReadTextOptions {
  /**
   * 起始行号（**1 起始**，相对文件开头）；缺省 1。
   * 非数字 / NaN / 小于 1 一律按 1 处理（见 `resolveLineParam`）。
   */
  offsetLines?: number
  /** 最多返回多少行；缺省 `DEFAULT_READ_LINES`，上限 `MAX_READ_LINES` */
  limitLines?: number
  /**
   * 返回窗口的字节上限：对**切片之后的窗口**生效（不再是从文件头截断）。
   * 窗口里**至少保留一行** —— 即使第一行单独就超过它，也要带回来，
   * 否则模型拿到空结果且无从推进。
   */
  maxBytes: number
}

export interface ReadLine {
  /** 行号（1 起始，相对文件开头，**不随 `offset` 改变**） */
  number: number
  /** 行内容（已去掉行尾的 `\r`，不含换行符） */
  text: string
}

export interface ReadTextResult {
  absolutePath: string
  /** 本次返回的行窗口（已按 `offsetLines` / `limitLines` / `maxBytes` 裁剪） */
  lines: ReadLine[]
  /** 文件总行数；命中扫描上限时为 `undefined`（无法准确统计） */
  totalLines?: number
  /** 后面是否还有未返回的内容（被 `limitLines` / `maxBytes` / 扫描上限截断） */
  truncated: boolean
  /** 是否因文件超过 `MAX_READ_SCAN_BYTES` 而没读完（此时 `totalLines` 为 `undefined`） */
  scanLimitHit?: boolean
  /** 本次返回窗口的字节数 */
  bytes: number
  /** 文件总字节数 */
  totalBytes: number
}

export interface FilePort {
  /**
   * 读文本的**行窗口**；二进制（含 NUL）与目录由实现抛错。
   *
   * 与既有 `readText(path, maxBytes)` 的差别：`maxBytes` 现在是对**窗口**的字节上限，
   * 不再是从文件头截断——因此大文件的后半段可以被读到（`offsetLines`）。
   */
  readText(path: string, options: ReadTextOptions): Promise<ReadTextResult>
  /** 写文本；mode='append' 追加；实现负责建父目录 + 原子写 */
  writeText(
    path: string,
    content: string,
    mode: 'overwrite' | 'append',
  ): Promise<{ absolutePath: string; bytes: number }>
  list(
    path: string,
    limit: number,
  ): Promise<{ absolutePath: string; entries: DirEntry[]; truncated: boolean }>
}

export interface DirEntry {
  name: string
  type: 'file' | 'dir'
  sizeBytes?: number
  modifiedAt?: string
}

export interface OpenPort {
  open(target: string): Promise<void>
}

export interface FileToolOptions {
  files: FilePort
  open: OpenPort
  /** `agent.tools.files.maxReadBytes`（docs/08 §1） */
  maxReadBytes: number
  /** `list_dir` 的默认条数（缺省 200） */
  listLimit?: number
}

/**
 * 文件类工具：`read_file` / `write_file` / `list_dir` / `open_path`，
 * **恰好 4 个**（顺序按 `COMPUTER_TOOL_NAMES`）——step 5 的开关按名字分派。
 */
export function createFileTools(options: FileToolOptions): ToolDefinition[] {
  const listLimit = clampListLimit(options.listLimit)
  return [
    createReadFileTool(options.files, options.maxReadBytes),
    createWriteFileTool(options.files),
    createListDirTool(options.files, listLimit),
    createOpenTool({ open: options.open }),
  ]
}

/** `open_path` 单独暴露：它受 `agent.tools.open.enabled` 控制（docs/06 §11） */
export function createOpenTool(options: { open: OpenPort }): ToolDefinition {
  return {
    name: 'open_path',
    description:
      '用系统默认方式打开目标：网页 URL（http/https）、mailto 链接、本地文件、文件夹、已安装程序名都能打开，交给 Windows 默认程序处理；不等待目标程序退出。打开后立即返回。',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '要打开的目标：网址、本地文件 / 文件夹的路径，或已安装程序名',
        },
      },
      required: ['target'],
      additionalProperties: false,
    },
    sensitivity: 'confirm',
    execute: async (input): Promise<ToolResult> => {
      const target = readNonEmptyString(asRecord(input), 'target')
      if (target === undefined) {
        return {
          content: '缺少参数 target（要打开的网址 / 文件 / 文件夹 / 程序名）。',
          isError: true,
          summary: '缺少 target 参数',
        }
      }
      try {
        await options.open.open(target)
        return { content: `已打开：${target}`, summary: `已打开：${target}` }
      } catch (error) {
        return {
          content: `打开失败：${describeError(error)}`,
          isError: true,
          summary: '打开失败',
        }
      }
    },
  }
}

function createReadFileTool(files: FilePort, configuredMaxBytes: number): ToolDefinition {
  const maximum = Math.max(MIN_READ_BYTES, Math.floor(configuredMaxBytes))
  return {
    name: 'read_file',
    description: [
      `按 UTF-8 读取文本文件内容，返回的每一行都带 \`<行号>: \` 前缀（后续用它引用原文，注意引用时不要把前缀带进去）。`,
      `默认返回开头 ${DEFAULT_READ_LINES} 行；大文件不必整篇读进来——用 offset（**1 起始**的行号）从任意位置继续读，用 limit 控制本次行数（最多 ${MAX_READ_LINES} 行）。`,
      `单行超过 ${MAX_LINE_CHARS} 字符会被截断。`,
      '不知道文件名先用 glob 找，要找内容是 grep 更快（它直接给路径与行号，再回到这里按 offset 读那一段）。',
      '二进制文件读不了，请改用 run_command 处理。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '要读取的文件路径（可为相对路径，结果里回带解析后的绝对路径）',
        },
        offset: {
          type: 'integer',
          minimum: 1,
          description: `起始行号（**1 起始**，相对文件开头），缺省 1；用于读大文件的后半段`,
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_READ_LINES,
          description: `本次最多返回的行数，取值 1–${MAX_READ_LINES}，缺省 ${DEFAULT_READ_LINES}`,
        },
        maxBytes: {
          type: 'integer',
          minimum: MIN_READ_BYTES,
          maximum: maximum,
          description: `本次返回窗口的字节上限，取值 ${MIN_READ_BYTES}–${maximum}，缺省为 ${maximum}`,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    sensitivity: 'safe',
    execute: async (input): Promise<ToolResult> => {
      const record = asRecord(input)
      const path = readNonEmptyString(record, 'path')
      if (path === undefined) {
        return {
          content: '缺少参数 path（要读取的文件路径）。',
          isError: true,
          summary: '缺少 path 参数',
        }
      }
      // 行窗口参数是「怎么读」不是「读什么」：写坏时给一个可用窗口比直接报错更有用，
      // 所以非数字 / NaN / 越界一律钳制回落（与 maxBytes 的严格口径不同，见 §20 措辞规范）。
      const offsetLines = resolveLineParam(record?.['offset'], 1, MAX_READ_OFFSET, 1)
      const limitLines = resolveLineParam(record?.['limit'], 1, MAX_READ_LINES, DEFAULT_READ_LINES)
      const maxBytes = resolveClamped(record?.['maxBytes'], MIN_READ_BYTES, maximum, maximum)
      if (maxBytes === undefined) {
        return {
          content: `参数 maxBytes 必须是数字（${MIN_READ_BYTES}–${maximum} 的整数）。`,
          isError: true,
          summary: 'maxBytes 参数非法',
        }
      }
      try {
        const result = await files.readText(path, { offsetLines, limitLines, maxBytes })
        return renderReadResult(result)
      } catch (error) {
        return {
          content: `读取文件失败：${describeError(error)}`,
          isError: true,
          summary: '读取文件失败',
        }
      }
    },
  }
}

/**
 * 把端口回带的行窗口渲染成结果文本（docs/06 §11、§20）。
 *
 * 头部三态：正常窗口 / 窗口为空（offset 越界）/ 文件过大（`totalLines` 未知）。
 * 结果为空**不是错误**（`isError` 由调用方不设），模型据此换 offset 继续读即可。
 */
function renderReadResult(result: ReadTextResult): ToolResult {
  const first = result.lines[0]
  const last = result.lines[result.lines.length - 1]
  const mib = Math.round(MAX_READ_SCAN_BYTES / 1024 / 1024)

  let head: string
  if (result.totalLines === undefined) {
    head = `文件：${result.absolutePath}（${result.totalBytes} 字节；文件超过 ${mib} MiB 只解析了开头，建议用 grep 定位）`
  } else if (first === undefined || last === undefined) {
    head = `文件：${result.absolutePath}（共 ${result.totalLines} 行 / ${result.totalBytes} 字节）`
  } else {
    head = `文件：${result.absolutePath}（共 ${result.totalLines} 行 / ${result.totalBytes} 字节；本次显示第 ${first.number}–${last.number} 行）`
  }

  const lines = result.lines.map(renderReadLine)
  const tail: string[] = []
  if (result.scanLimitHit === true) {
    tail.push(`…（文件超过 ${mib} MiB，仅解析了开头；请用 grep 定位或改用 run_command）…`)
  }
  if (first === undefined || last === undefined) {
    if (result.totalLines === 0) tail.push('（空文件）')
    else if (result.totalLines !== undefined) {
      tail.push(`offset 超出文件末尾（共 ${result.totalLines} 行）`)
    }
  } else if (result.truncated) {
    tail.push(
      result.totalLines === undefined
        ? '…（还有未显示的内容，可用更大的 offset 继续读）…'
        : `…（还有 ${result.totalLines - last.number} 行未显示，用 offset 继续读）…`,
    )
  }

  return {
    content: [head, ...lines, ...tail].join('\n\n'),
    summary: describeReadSummary(result, first, last),
  }
}

function describeReadSummary(
  result: ReadTextResult,
  first: ReadLine | undefined,
  last: ReadLine | undefined,
): string {
  if (first === undefined || last === undefined) {
    return result.totalLines === 0 ? '空文件' : '未读到内容（offset 超出文件末尾）'
  }
  if (result.totalLines === undefined) {
    return `读取第 ${first.number}–${last.number} 行（文件过大仅开头）`
  }
  return `读取第 ${first.number}–${last.number} 行 / 共 ${result.totalLines} 行`
}

/** `12: 内容`；超长行截断并标注原长（截断标记在**这一行**上，模型一眼能看出是哪行的问题） */
function renderReadLine(line: ReadLine): string {
  if (line.text.length <= MAX_LINE_CHARS) return `${line.number}: ${line.text}`
  return `${line.number}: ${line.text.slice(0, MAX_LINE_CHARS)}…（本行共 ${line.text.length} 字符已截断）…`
}

/**
 * 行窗口参数的宽松解析：非数字 / NaN 回落到 `fallback`，其余取整后钳到 `[minimum, maximum]`。
 *
 * 与 `resolveClamped` 的差别只在「非数字」这一支：后者返回 `undefined` 让调用方报错，
 * 这里按缺省值处理——`offset` / `limit` 传错时退回默认窗口仍能读到东西，而 `maxBytes`
 * 关系着"会不会把上下文刷爆"，保持严格。
 */
function resolveLineParam(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.floor(value), minimum), maximum)
}

function createWriteFileTool(files: FilePort): ToolDefinition {
  return {
    name: 'write_file',
    description:
      '把文本写入本地文件（UTF-8）。缺省 mode=overwrite 覆盖整个文件，mode=append 追加到末尾；父目录不存在时自动创建。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '要写入的文件路径（可为相对路径，结果里回带解析后的绝对路径）',
        },
        content: { type: 'string', description: '要写入的文本内容' },
        mode: {
          type: 'string',
          enum: ['overwrite', 'append'],
          description: 'overwrite（缺省）覆盖写入；append 追加写入',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    sensitivity: 'confirm',
    execute: async (input): Promise<ToolResult> => {
      const record = asRecord(input)
      const path = readNonEmptyString(record, 'path')
      const content = readString(record, 'content')
      if (path === undefined) {
        return {
          content: '缺少参数 path（要写入的文件路径）。',
          isError: true,
          summary: '缺少 path 参数',
        }
      }
      if (content === undefined) {
        return {
          content: '缺少参数 content（要写入的文本内容）。',
          isError: true,
          summary: '缺少 content 参数',
        }
      }
      const mode = resolveWriteMode(record?.['mode'])
      if (mode === undefined) {
        return {
          content: "参数 mode 只能是 'overwrite' 或 'append'。",
          isError: true,
          summary: 'mode 参数非法',
        }
      }
      try {
        const result = await files.writeText(path, content, mode)
        return {
          content: `${result.absolutePath}（写入 ${result.bytes} 字节，mode=${mode}）`,
          summary: mode === 'append' ? `追加 ${result.bytes} 字节` : `写入 ${result.bytes} 字节`,
        }
      } catch (error) {
        return {
          content: `写入文件失败：${describeError(error)}`,
          isError: true,
          summary: '写入文件失败',
        }
      }
    },
  }
}

function createListDirTool(files: FilePort, defaultLimit: number): ToolDefinition {
  return {
    name: 'list_dir',
    description:
      '列出目录下的条目（目录在前，同类按名称排序）。默认返回前 200 条，可用 limit 调整；条目含名称、类型、文件大小与修改时间。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要列出的目录路径（可为相对路径）' },
        limit: {
          type: 'integer',
          minimum: MIN_LIST_LIMIT,
          maximum: MAX_LIST_LIMIT,
          description: `最多返回的条目数，取值 ${MIN_LIST_LIMIT}–${MAX_LIST_LIMIT}，缺省为 ${defaultLimit}`,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    sensitivity: 'safe',
    execute: async (input): Promise<ToolResult> => {
      const record = asRecord(input)
      const path = readNonEmptyString(record, 'path')
      if (path === undefined) {
        return {
          content: '缺少参数 path（要列出的目录路径）。',
          isError: true,
          summary: '缺少 path 参数',
        }
      }
      const limit = resolveClamped(record?.['limit'], MIN_LIST_LIMIT, MAX_LIST_LIMIT, defaultLimit)
      if (limit === undefined) {
        return {
          content: `参数 limit 必须是数字（${MIN_LIST_LIMIT}–${MAX_LIST_LIMIT} 的整数）。`,
          isError: true,
          summary: 'limit 参数非法',
        }
      }
      try {
        const result = await files.list(path, limit)
        const lines = result.entries.map(renderEntry)
        if (lines.length === 0) lines.push('（空目录）')
        if (result.truncated) lines.push('还有更多条目，已按 limit 截断')
        const header = `目录：${result.absolutePath}（返回 ${result.entries.length} 项）`
        return {
          content: [header, ...lines].join('\n'),
          summary: `列出 ${result.entries.length} 项`,
        }
      } catch (error) {
        return {
          content: `列出目录失败：${describeError(error)}`,
          isError: true,
          summary: '列出目录失败',
        }
      }
    },
  }
}

/** `[DIR]  名称  (2026-09-20 17:10)` / `[FILE] 名称  1234 字节  (…)` */
function renderEntry(entry: DirEntry): string {
  const time = formatTimestamp(entry.modifiedAt)
  const stamp = time === '' ? '' : `  (${time})`
  if (entry.type === 'dir') return `[DIR]  ${entry.name}${stamp}`
  const size = entry.sizeBytes === undefined ? '' : `  ${entry.sizeBytes} 字节`
  return `[FILE] ${entry.name}${size}${stamp}`
}

/** 端口回带的 `modifiedAt` 是 ISO 串；展示用本地时间 `YYYY-MM-DD HH:mm` */
function formatTimestamp(value: string | undefined): string {
  if (value === undefined || value === '') return ''
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return ''
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
}

/** 缺省或非法值时给出可读的回落（`undefined` 表示参数类型非法，调用方按校验失败处理） */
function resolveClamped(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number | undefined {
  if (value === undefined || value === null) return Math.min(Math.max(fallback, minimum), maximum)
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(Math.max(Math.floor(value), minimum), maximum)
}

function clampListLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LIST_LIMIT
  return Math.min(Math.max(Math.floor(value), MIN_LIST_LIMIT), MAX_LIST_LIMIT)
}

function resolveWriteMode(value: unknown): 'overwrite' | 'append' | undefined {
  if (value === undefined || value === null) return 'overwrite'
  return value === 'overwrite' || value === 'append' ? value : undefined
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  return input as Record<string, unknown>
}

/** 必填字符串：非字符串或纯空白一律视为缺参（**不触碰端口**） */
function readNonEmptyString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' ? value : undefined
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
