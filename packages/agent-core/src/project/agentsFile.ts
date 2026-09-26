/**
 * 项目级 `AGENTS.md` 逐层收集器（docs/06 §5.1）。
 *
 * 语义：从项目根到当前工作目录**逐层**收集约定文件，每层**最多取一份**
 * （同目录内 `AGENTS.override.md` 优先，它存在就忽略同目录的 `AGENTS.md`），
 * 再按「远 → 近」拼成注入文本 —— 越靠近 cwd 的约定越具体，读在后面才符合
 * 「近端覆盖远端」的直觉。
 *
 * 端口约定：`ProjectFs` 在「文件不存在 / 无权限」时**抛错**，由本模块捕获后跳过该候选
 * 并记一条 warning。因此 `agentsFile.ts` 在任何路径下都**不抛错** ——
 * 收集失败绝不该打断一轮对话。
 */
import { isAbsolute, join, relative, resolve } from 'node:path'
import { createNoopLogger, type Logger } from '@aurora/shared'

/** 逐层收集的文件名（docs/06 §5.1） */
export const AGENTS_FILE_NAME = 'AGENTS.md'
/** 同目录内优先于 {@link AGENTS_FILE_NAME} 的文件名（docs/06 §5.1） */
export const AGENTS_OVERRIDE_FILE_NAME = 'AGENTS.override.md'
/**
 * 收集上限的缺省值（docs/06 §5.1）：
 * `maxDirs` 限制向近端走的目录层数，`maxBytes` 限制注入文本的 UTF-8 字节数。
 */
export const COLLECT_AGENTS_LIMITS = { maxDirs: 24, maxBytes: 32768 } as const

/** 单份文件被字节预算截断时追加在被截断文件末尾的标注行 */
const TRUNCATED_MARKER = '（已截断）'

/** 单份文件的 lstat 元信息（用布尔字段，便于内存桩实现；docs/06 §5.1） */
export interface ProjectStat {
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
  /** 文件大小（字节）；内存桩可省略，省略时签名里写 `?` */
  size?: number
  /** 修改时间（毫秒时间戳）；内存桩可省略，省略时签名里写 `?` */
  mtimeMs?: number
}

/**
 * 注入式 fs 端口（docs/06 §5.1）：不存在 / 无权限时**抛错**，
 * 由收集器捕获后跳过并记 warning（收集器本身永不抛错）。
 */
export interface ProjectFs {
  readFile(path: string): Promise<string>
  stat(path: string): Promise<ProjectStat>
}

/** 收集参数（docs/06 §5.1） */
export interface CollectProjectInstructionsOptions {
  /** 项目根（绝对路径） */
  root: string
  /** 当前工作目录（绝对路径）；不在 root 之下时只取 root 一层 */
  cwd: string
  /** 字节预算；缺省 `COLLECT_AGENTS_LIMITS.maxBytes` */
  maxBytes?: number
  /** 目录层数上限；缺省 `COLLECT_AGENTS_LIMITS.maxDirs` */
  maxDirs?: number
  fs: ProjectFs
  logger?: Logger
  /** 上一轮的快照：签名未变时直接复用 `text`，跳过全部 readFile */
  previous?: { signature: string; text: string }
}

/** 收集结果（docs/06 §5.1） */
export interface ProjectInstructions {
  /** 拼好的注入文本；没有命中任何文件时为空串 */
  text: string
  /** 实际读到的文件绝对路径（远 → 近） */
  files: string[]
  /** 是否因预算 / 目录层数被截断 */
  truncated: boolean
  /** 降级原因（文件不存在 / 读取失败 / 符号链接 / 目录 …），永不抛错 */
  warnings: string[]
  /** 缓存签名：由每个候选文件的「路径 + mtimeMs + size + 是否命中」拼成 */
  signature: string
}

/** 一次候选探测的结果（探测 = 只 stat，不读内容） */
interface ProbeRecord {
  path: string
  /** stat 成功时的元信息；`undefined` 表示未命中 */
  stat?: ProjectStat
  /** 命中且可用（普通文件、非符号链接） */
  selected: boolean
}

/** 本轮选中的文件（每层目录最多一个） */
interface SelectedFile {
  path: string
  stat?: ProjectStat
  /** 相对项目根的**正斜杠**路径，用作注入文本的标题行（root 层就是文件名本身） */
  display: string
}

/**
 * 逐层收集项目级 `AGENTS.md` 并拼成注入文本（docs/06 §5.1）。
 *
 * 任何失败路径都折成 `warnings` 返回，**永不抛错**；
 * 签名可算时不需要读文件 —— `previous.signature` 与本次一致即直接复用 `previous.text`。
 */
export async function collectProjectInstructions(
  options: CollectProjectInstructionsOptions,
): Promise<ProjectInstructions> {
  const logger = options.logger ?? createNoopLogger()
  const warnings: string[] = []
  const root = resolve(options.root)
  const cwd = resolve(options.cwd)
  const maxDirs = normalizeLimit(options.maxDirs, COLLECT_AGENTS_LIMITS.maxDirs)
  const maxBytes = normalizeLimit(options.maxBytes, COLLECT_AGENTS_LIMITS.maxBytes)

  // —— 目录链：root → cwd 逐层；cwd 不在 root 之下时只取 root 一层 ——
  const chain = directoryChain(root, cwd)
  const dirsCut = chain.length > maxDirs
  const dirs = dirsCut ? chain.slice(0, maxDirs) : chain
  if (dirsCut) {
    logger.warn('项目指令目录层数超过上限，只收集靠近项目根的部分', {
      root,
      cwd,
      maxDirs,
      chainLength: chain.length,
    })
  }

  // —— 探测阶段：只做 stat（签名只依赖 stat 结果），因此缓存命中时可以一次 readFile 都不做 ——
  const probes: ProbeRecord[] = []
  const selections: SelectedFile[] = []
  for (const dir of dirs) {
    const overridePath = join(dir, AGENTS_OVERRIDE_FILE_NAME)
    const override = await probeCandidate(options.fs, overridePath, warnings, logger)
    probes.push(override)
    if (override.selected) {
      // override 存在即用它、忽略同目录的 AGENTS.md（被顶掉的那份不进签名）
      selections.push(toSelection(root, overridePath, override.stat))
      continue
    }
    const plainPath = join(dir, AGENTS_FILE_NAME)
    const plain = await probeCandidate(options.fs, plainPath, warnings, logger)
    probes.push(plain)
    if (plain.selected) selections.push(toSelection(root, plainPath, plain.stat))
  }

  const signature = buildSignature(probes, maxDirs, maxBytes)
  const files: string[] = []
  let truncated = dirsCut

  // 签名未变 ⇒ 内容必然未变：跳过全部 readFile，只按本轮探测结果回带元信息
  const previous = options.previous
  if (previous !== undefined && previous.signature === signature) {
    truncated = truncated || exceedsBudget(selections, maxBytes)
    for (const selection of selections) files.push(selection.path)
    logger.debug('项目指令缓存命中，复用上一轮文本', { root, files: files.length })
    return { text: previous.text, files, truncated, warnings, signature }
  }

  // —— 读取阶段：远 → 近拼接，按**已拼文本**的 UTF-8 字节数控制预算 ——
  const blocks: string[] = []
  let usedBytes = 0
  for (const selection of selections) {
    let content: string
    try {
      content = await options.fs.readFile(selection.path)
    } catch (error) {
      warnings.push(`${selection.path} 读取失败，已跳过：${describeError(error)}`)
      logger.warn('项目指令文件读取失败，已跳过', {
        path: selection.path,
        error: describeError(error),
      })
      continue
    }
    if (content.includes('\u0000')) {
      // 与 tools/files.ts 的 readWholeText 同一口径：含 NUL 即不是文本文件
      warnings.push(`${selection.path} 不是文本文件（含 NUL 字节），已跳过`)
      logger.warn('项目指令文件疑似二进制，已跳过', { path: selection.path })
      continue
    }
    if (content.trim() === '') {
      // 空文件只会在注入文本里留下一个光秃秃的标题行，纯噪音，直接跳过（不算降级）
      logger.debug('项目指令文件内容为空，已跳过', { path: selection.path })
      continue
    }

    const header = `### ${selection.display}`
    const separatorBytes = blocks.length > 0 ? 2 : 0 // 文件之间用一个空行分隔
    const remaining = maxBytes - usedBytes
    const fullBytes = separatorBytes + utf8Bytes(`${header}\n${content}`)
    if (fullBytes <= remaining) {
      blocks.push(`${header}\n${content}`)
      usedBytes += fullBytes
      files.push(selection.path)
      continue
    }

    // 单份文件超过剩余预算：按 UTF-8 安全截断（不截出半个字符），标注后停止
    const markerLine = `\n${TRUNCATED_MARKER}`
    const fixedBytes = separatorBytes + utf8Bytes(header) + 1 + utf8Bytes(markerLine)
    const contentBudget = remaining - fixedBytes
    truncated = true
    if (contentBudget < 0) {
      logger.warn('项目指令预算耗尽，剩余文件未注入', {
        path: selection.path,
        maxBytes,
        usedBytes,
      })
      break
    }
    const slice = truncateUtf8(content, contentBudget)
    blocks.push(`${header}\n${slice === '' ? TRUNCATED_MARKER : `${slice}${markerLine}`}`)
    usedBytes += fixedBytes + utf8Bytes(slice)
    files.push(selection.path)
    logger.warn('项目指令文件被字节预算截断', {
      path: selection.path,
      maxBytes,
      usedBytes,
    })
    break
  }

  return { text: blocks.join('\n\n'), files, truncated, warnings, signature }
}

/**
 * 目录链：从 root 到 cwd 逐层（含两端）。
 *
 * cwd 不在 root 之下时（`path.relative` 以 `..` 开头或返回绝对路径）只取 root 一层 ——
 * 此时无法从 root 走到 cwd，注入更靠外的约定只会误导模型。
 */
function directoryChain(root: string, cwd: string): string[] {
  const rel = relative(root, cwd)
  if (rel === '') return [root]
  if (rel.startsWith('..') || isAbsolute(rel)) return [root]
  const chain = [root]
  let cursor = root
  for (const part of rel.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue
    cursor = join(cursor, part)
    chain.push(cursor)
  }
  return chain
}

/** 探测单个候选：只 stat，不读内容；不可用（缺失 / 目录 / 符号链接）时记一条 warning。 */
async function probeCandidate(
  fs: ProjectFs,
  path: string,
  warnings: string[],
  logger: Logger,
): Promise<ProbeRecord> {
  let stat: ProjectStat
  try {
    stat = await fs.stat(path)
  } catch (error) {
    const reason = isMissingError(error) ? '不存在' : `无法获取文件状态（${describeError(error)}）`
    warnings.push(`${path} ${reason}，已跳过`)
    logger.debug('项目指令候选未命中', { path, reason })
    return { path, selected: false }
  }
  if (stat.isSymbolicLink) {
    warnings.push(`${path} 是符号链接，出于安全考虑已跳过`)
    logger.warn('项目指令候选是符号链接，已跳过', { path })
    return { path, stat, selected: false }
  }
  if (stat.isDirectory) {
    warnings.push(`${path} 是目录（不是文件），已跳过`)
    logger.warn('项目指令候选是目录，已跳过', { path })
    return { path, stat, selected: false }
  }
  if (!stat.isFile) {
    warnings.push(`${path} 不是普通文件，已跳过`)
    logger.warn('项目指令候选不是普通文件，已跳过', { path })
    return { path, stat, selected: false }
  }
  return { path, stat, selected: true }
}

function toSelection(root: string, path: string, stat: ProjectStat | undefined): SelectedFile {
  return {
    path,
    display: relative(root, path)
      .split(/[\\/]+/)
      .join('/'),
    ...(stat === undefined ? {} : { stat }),
  }
}

/**
 * 缓存签名：每个候选一行 `<绝对路径>|<mtimeMs>|<size>`，未命中写 `<路径>|missing`。
 *
 * 首行的 `limits|<maxDirs>|<maxBytes>` 必须一起进签名 —— 否则用户把预算改小之后，
 * 尺寸未变的文件会让缓存**误命中**，把上一轮的超预算文本原样注入。
 */
function buildSignature(probes: readonly ProbeRecord[], maxDirs: number, maxBytes: number): string {
  const lines = [`limits|${maxDirs}|${maxBytes}`]
  for (const probe of probes) {
    if (probe.stat === undefined) {
      lines.push(`${probe.path}|missing`)
      continue
    }
    lines.push(`${probe.path}|${probe.stat.mtimeMs ?? '?'}|${probe.stat.size ?? '?'}`)
  }
  return lines.join('\n')
}

/**
 * 缓存命中时的截断判定：不读文件，用 stat 的 `size` 近似内容字节数
 * （真实 utf8 文本两者一致；无法读出的元信息按 0 计，最坏情况是漏报截断）。
 */
function exceedsBudget(selections: readonly SelectedFile[], maxBytes: number): boolean {
  let usedBytes = 0
  for (const [index, selection] of selections.entries()) {
    const separatorBytes = index > 0 ? 2 : 0
    const blockBytes =
      separatorBytes + utf8Bytes(`### ${selection.display}\n`) + (selection.stat?.size ?? 0)
    if (usedBytes + blockBytes > maxBytes) return true
    usedBytes += blockBytes
  }
  return false
}

/** 把上限折成非负整数；非法（负数 / NaN / Inf）一律回落缺省值。 */
function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback
  return Math.floor(value)
}

/** UTF-8 字节数（按码点累加，代理对算 4 字节） */
function utf8Bytes(text: string): number {
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code < 0x10000) bytes += 3
    else bytes += 4
  }
  return bytes
}

/** 按 UTF-8 字节预算安全截断（以**码点**为单位，绝不截出半个字符） */
function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  let usedBytes = 0
  let result = ''
  for (const char of text) {
    const size = utf8Bytes(char)
    if (usedBytes + size > maxBytes) break
    result += char
    usedBytes += size
  }
  return result
}

/** 区分「文件不存在」（正常情况）与「真的读不了」（异常情况）的告警文案 */
function isMissingError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return true
  return /ENOENT|ENOTDIR|no such file/i.test(describeError(error))
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
