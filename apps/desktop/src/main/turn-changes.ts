/**
 * 轮终改动汇总（2026-11-07，docs/06 §4.2 / docs/07 §2.3）。
 *
 * 一条 job 正常收敛后，主进程用**写前快照**当 before、用盘上当前内容当 after，算出本轮
 * 「哪些文件被改了、各增删多少行」，经 `chat:turnChanges` 推给 chat 渲染层，渲染成对话尾部
 * 的「本次改动文件」卡片（对齐 DeepSeek Harness 的 changed-files card）。
 *
 * 只做汇总，不做持久化：不写会话文件、不进 Center 协议、重启即失（DSH 同款口径）。
 * 本模块不 import electron，文件系统与快照端口全部注入，因此可单独单测。
 *
 * 几条刻意取舍：
 * - **before 只认本轮工具调用 id 命中的快照**：同一会话里别的轮次的快照不能被当成本轮的基线；
 * - **同一路径本轮写多次**：before 取最早那份快照、after 取轮末内容，只列一条；
 * - 内容没变的路径**不列**（与 DSH 一致）；
 * - 二进制 / 超限 / 没有快照时**只列路径、不假装 0 行**；
 * - 行数对比有行数与时间预算，超了就退化成「整文件替换」并照常给数（`coarse`），绝不卡住收尾。
 */
import { isAbsolute, join, relative, sep } from 'node:path'
import type { AgentToolCall, ChangedFileInfo, Logger, SnapshotRef } from '@aurora/shared'
import type { SnapshotPort } from '@aurora/agent-core'

/** 会改动用户文件的工具（与 main/index.ts 的事件收集、docs/06 §4.2 同一份口径） */
export const TURN_CHANGE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'office_create',
  'office_edit',
  'office_raw_edit',
  'office_pdf',
])

/** 单轮最多列多少个文件（防失控常量，不做成配置项；DSH 是 500，桌面端 200 足够） */
export const MAX_TURN_FILES = 200
/** after 侧允许读入对比的最大字节数：更大的文件只列路径 */
export const MAX_TURN_CHANGE_BYTES = 2 * 1024 * 1024
/** 逐行对比的最大中间行数（前后缀裁掉之后）：超过即退化为整文件替换 */
export const MAX_DIFF_LINES = 4000
/** LCS 的单元格预算（n×m）：4000×4000 会吃满内存与时间，超过就退化 */
export const MAX_LCS_CELLS = 4_000_000
/** 单个文件逐行对比的时间预算（毫秒）：超时退化为整文件替换 */
export const DIFF_BUDGET_MS = 150
/** 整轮汇总的时间预算（毫秒）：超时后剩余文件只列路径、不再读盘对比 */
export const TURN_BUDGET_MS = 1000

/** 这些扩展名按二进制处理（不读内容也能判定；Office / PDF / 图片 / 压缩包等） */
const BINARY_EXTENSIONS = new Set([
  '.docx',
  '.doc',
  '.xlsx',
  '.xls',
  '.pptx',
  '.ppt',
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.zip',
  '.7z',
  '.rar',
  '.gz',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.mp3',
  '.mp4',
  '.wav',
  '.m4a',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
])

export interface TurnChangesDeps {
  /** 快照端口（主进程注入 `ensureSnapshotPort()`） */
  snapshots: Pick<SnapshotPort, 'list' | 'readContent'>
  /** 读文件（注入 `node:fs/promises` 的 readFile；返回 Buffer 也可以，只当 Uint8Array 用） */
  readFile: (path: string) => Promise<Uint8Array>
  /** stat（只需要 size；不存在时抛错） */
  stat: (path: string) => Promise<{ size: number }>
  logger: Logger
  /** 会话生效工作目录：相对路径按它解析、展示路径按它算相对 */
  workspaceRootOf?: (sessionId: string) => string | undefined
  /** 用户主目录（展示成 `~/…`）；缺省由装配层注入 `os.homedir()` */
  homeDir?: string
  /** 时钟注入（单测控制预算；缺省 `Date.now`） */
  now?: () => number
}

export interface TurnChangesInput {
  sessionId: string
  /** 本轮已结算的工具调用（取自 `chat:event` 的 `tool` 事件） */
  toolCalls: readonly AgentToolCall[]
}

/** 工具入参里取目标路径；非写文件工具 / 参数非法返回 undefined。 */
export function pathOfToolCall(call: Pick<AgentToolCall, 'name' | 'input'>): string | undefined {
  const record = asRecord(call.input)
  const read = (key: string): string => {
    const value = record[key]
    return typeof value === 'string' ? value.trim() : ''
  }
  switch (call.name) {
    case 'write_file':
    case 'edit_file':
    case 'office_create':
    case 'office_raw_edit': {
      const path = read('path')
      return path === '' ? undefined : path
    }
    case 'office_edit': {
      // 默认另存（saveAs）时目标不是源文件；不带 saveAs = 原地覆盖
      const saveAs = read('saveAs')
      if (saveAs !== '') return saveAs
      const path = read('path')
      return path === '' ? undefined : path
    }
    case 'office_pdf': {
      // 缺省输出路径由 Office 端口推导（同目录同名 .pdf），这里拿不到 → 不计入
      const output = read('outputPath')
      return output === '' ? undefined : output
    }
    default:
      return undefined
  }
}

/** 收集一轮的改动文件；失败不抛（只记日志并返回已算出的部分）。 */
export async function collectTurnChanges(
  input: TurnChangesInput,
  deps: TurnChangesDeps,
): Promise<ChangedFileInfo[]> {
  try {
    return await collect(input, deps)
  } catch (error) {
    deps.logger.warn('轮终改动汇总失败，已跳过', {
      sessionId: input.sessionId,
      error: messageOf(error),
    })
    return []
  }
}

async function collect(input: TurnChangesInput, deps: TurnChangesDeps): Promise<ChangedFileInfo[]> {
  const now = deps.now ?? Date.now
  const startedAt = now()
  const root = deps.workspaceRootOf?.(input.sessionId)
  const home = deps.homeDir

  /** 本轮写文件调用：只认结算成功的 */
  const calls = input.toolCalls.filter(
    (call) => call.state === 'success' && TURN_CHANGE_TOOL_NAMES.has(call.name),
  )
  if (calls.length === 0) return []

  /** toolCallId → 目标绝对路径（相对路径按会话工作目录解析；解析不出就不计入） */
  const targetByCallId = new Map<string, string>()
  for (const call of calls) {
    const raw = pathOfToolCall(call)
    if (raw === undefined) continue
    const absolute = toAbsolute(raw, root)
    if (absolute === undefined) continue
    if (!targetByCallId.has(call.id)) targetByCallId.set(call.id, absolute)
  }
  if (targetByCallId.size === 0) return []

  /** path → 本轮最早的一条 before 快照（同一路径多次写：取最早） */
  const beforeByPath = new Map<string, SnapshotRef>()
  const callIds = new Set(targetByCallId.keys())
  const refs = await deps.snapshots.list({ sessionId: input.sessionId, limit: 0 })
  for (const ref of refs) {
    if (ref.toolCallId === undefined || !callIds.has(ref.toolCallId)) continue
    if (ref.origin === 'rollback') continue
    const existing = beforeByPath.get(ref.path)
    if (existing === undefined || ref.createdAt < existing.createdAt) {
      beforeByPath.set(ref.path, ref)
    }
  }

  /** 并入「没有快照但工具确实指向了」的路径（快照关闭 / 被跳过时仍要如实列出） */
  const paths = new Set<string>(beforeByPath.keys())
  for (const path of targetByCallId.values()) paths.add(path)

  const results: ChangedFileInfo[] = []
  for (const path of [...paths].sort()) {
    if (results.length >= MAX_TURN_FILES) break
    const overBudget = now() - startedAt > TURN_BUDGET_MS
    if (overBudget) {
      results.push({ path, display: displayPath(path, root, home), status: 'unknown' })
      continue
    }
    const file = await inspect(path, beforeByPath.get(path), deps, root, home, startedAt)
    if (file !== undefined) results.push(file)
  }

  results.sort((left, right) =>
    left.display < right.display ? -1 : left.display > right.display ? 1 : 0,
  )
  return results
}

/** 单个文件：读 before / after、判二进制、算行数。返回 undefined = 不列（内容未变 / 读不到） */
async function inspect(
  path: string,
  ref: SnapshotRef | undefined,
  deps: TurnChangesDeps,
  root: string | undefined,
  home: string | undefined,
  startedAt: number,
): Promise<ChangedFileInfo | undefined> {
  const display = displayPath(path, root, home)
  const binaryByExtension = BINARY_EXTENSIONS.has(extensionOf(path))
  if (binaryByExtension) return { path, display, status: 'binary' }

  // after 侧：不存在 = 本轮被删（只有之前有内容时才列）；过大 = 只列路径
  let afterBytes: Uint8Array | undefined
  let afterTooLarge = false
  try {
    const info = await deps.stat(path)
    if (info.size > MAX_TURN_CHANGE_BYTES) afterTooLarge = true
    else afterBytes = await deps.readFile(path)
  } catch {
    afterBytes = undefined
  }

  // before 侧：没有快照 / 快照没有内容 → 只能列路径
  let beforeText: string | undefined
  let beforeExists = false
  if (ref !== undefined && ref.exists) {
    const content = await deps.snapshots.readContent(ref)
    if (content !== undefined && !content.truncated) {
      beforeText = Buffer.from(content.bytes).toString('utf8')
      beforeExists = true
    }
  }

  if (
    (afterBytes !== undefined && hasNulByte(afterBytes)) ||
    (beforeText ?? '').includes('\u0000')
  ) {
    return { path, display, status: 'binary' }
  }
  if (afterTooLarge) return { path, display, status: 'oversized' }

  if (afterBytes === undefined) {
    // after 不存在：只有 before 有内容才算「本轮删除」
    if (!beforeExists) return undefined
    return {
      path,
      display,
      status: 'deleted',
      added: 0,
      removed: splitLines(beforeText ?? '').length,
    }
  }

  const afterText = Buffer.from(afterBytes).toString('utf8')

  if (ref === undefined) {
    // 没有 before 快照（快照关闭 / 被跳过）：能读到的路径仍要列，但不猜行数
    return { path, display, status: 'unknown' }
  }
  if (ref.exists && !beforeExists) {
    // 有快照记录但内容读不出来（索引在、内容文件被删）：只列路径
    return { path, display, status: 'unknown' }
  }
  if (!ref.exists) {
    // 写之前文件还不存在 = 本轮新建
    return {
      path,
      display,
      status: 'created',
      added: splitLines(afterText).length,
      removed: 0,
    }
  }

  const before = beforeText ?? ''
  if (before === afterText) return undefined
  const now = deps.now ?? Date.now
  const diff = countLineChanges(before, afterText, {
    maxLines: MAX_DIFF_LINES,
    maxCells: MAX_LCS_CELLS,
    budgetMs: Math.max(1, Math.min(DIFF_BUDGET_MS, TURN_BUDGET_MS - (now() - startedAt))),
    now: deps.now,
  })
  return {
    path,
    display,
    status: 'modified',
    added: diff.added,
    removed: diff.removed,
  }
}

// ───────────────────────── 行数对比 ─────────────────────────

export interface LineDiffOptions {
  /** 中间段最大行数：超过即退化为整文件替换（缺省 `MAX_DIFF_LINES`） */
  maxLines?: number
  /** LCS 单元格预算（缺省 `MAX_LCS_CELLS`） */
  maxCells?: number
  /** 时间预算（毫秒，缺省 `DIFF_BUDGET_MS`；<=0 视为立即超时） */
  budgetMs?: number
  now?: () => number
}

/**
 * 逐行增删统计。
 *
 * 先裁掉公共前后缀，再对中间段做 LCS；超出 `maxLines` / `maxCells` / 时间预算时**退化为
 * 整文件替换**（`added = after 行数`、`removed = before 行数`），并在返回值里标 `coarse`。
 * 行切分按 `\n`、容忍 CRLF；末尾换行不额外算一行。
 */
export function countLineChanges(
  before: string,
  after: string,
  options: LineDiffOptions = {},
): { added: number; removed: number; coarse: boolean } {
  if (before === after) return { added: 0, removed: 0, coarse: false }
  const beforeLines = splitLines(before)
  const afterLines = splitLines(after)

  const maxLines = options.maxLines ?? MAX_DIFF_LINES
  const coarseAll = (): { added: number; removed: number; coarse: boolean } => ({
    added: afterLines.length,
    removed: beforeLines.length,
    coarse: true,
  })

  let prefix = 0
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const beforeMid = beforeLines.slice(prefix, beforeLines.length - suffix)
  const afterMid = afterLines.slice(prefix, afterLines.length - suffix)
  if (beforeMid.length === 0 && afterMid.length === 0) {
    return { added: 0, removed: 0, coarse: false }
  }
  if (beforeMid.length === 0) return { added: afterMid.length, removed: 0, coarse: false }
  if (afterMid.length === 0) return { added: 0, removed: beforeMid.length, coarse: false }
  if (beforeMid.length > maxLines || afterMid.length > maxLines) return coarseAll()
  if (beforeMid.length * afterMid.length > (options.maxCells ?? MAX_LCS_CELLS)) return coarseAll()

  const now = options.now ?? Date.now
  const deadline = now() + Math.max(0, options.budgetMs ?? DIFF_BUDGET_MS)
  const lcs = lcsLength(beforeMid, afterMid, deadline, now)
  if (lcs === undefined) return coarseAll()
  return {
    added: afterMid.length - lcs,
    removed: beforeMid.length - lcs,
    coarse: false,
  }
}

/** LCS 长度（滚动数组）；超时返回 undefined（调用方退化）。 */
function lcsLength(
  a: readonly string[],
  b: readonly string[],
  deadline: number,
  now: () => number,
): number | undefined {
  const width = b.length + 1
  let previous = new Uint32Array(width)
  let current = new Uint32Array(width)
  for (let i = 1; i <= a.length; i += 1) {
    if (now() >= deadline) return undefined
    const left = a[i - 1] ?? ''
    for (let j = 1; j <= b.length; j += 1) {
      current[j] =
        left === b[j - 1]
          ? (previous[j - 1] ?? 0) + 1
          : Math.max(previous[j] ?? 0, current[j - 1] ?? 0)
    }
    const swap = previous
    previous = current
    current = swap
    current.fill(0)
  }
  return previous[b.length] ?? 0
}

// ───────────────────────── 纯工具函数 ─────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function toAbsolute(raw: string, root: string | undefined): string | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  if (isAbsolute(trimmed)) return trimmed
  if (root === undefined || root.trim() === '') return undefined
  return join(root, trimmed)
}

/** 展示路径：工作目录内 → `/` 相对路径；家目录内 → `~/…`；其余绝对路径（`/` 分隔）。 */
export function displayPath(
  path: string,
  root: string | undefined,
  home: string | undefined,
): string {
  if (root !== undefined && root.trim() !== '') {
    const rel = relative(root, path)
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/')
  }
  if (home !== undefined && home.trim() !== '') {
    const rel = relative(home, path)
    if (rel === '') return '~'
    if (!rel.startsWith('..') && !isAbsolute(rel)) return `~/${rel.split(sep).join('/')}`
  }
  return path.replace(/\\/g, '/')
}

/** 行切分：CRLF 归一、末尾换行不算额外一行；空串 0 行。 */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const normalized = text.replace(/\r\n/g, '\n')
  const body = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
  return body.split('\n')
}

function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

/** 只扫前 8 KiB 判二进制（与 file-port 的 `NUL_SCAN_BYTES` 同款思路）。 */
function hasNulByte(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.byteLength, 8 * 1024)
  for (let index = 0; index < end; index += 1) {
    if (bytes[index] === 0) return true
  }
  return false
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
