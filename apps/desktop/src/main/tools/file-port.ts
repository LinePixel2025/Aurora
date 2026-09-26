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
 *
 * 搜索层（`findFiles` / `searchText`，docs/06 §11.5）与读文件走**同一个递归 walker**：
 * 忽略目录、符号链接、预算、结果顺序这些口径只写一份；单文件的大小上限、遍历预算与墙钟预算
 * 常量（`MAX_FILE_SCAN_BYTES` / `SEARCH_BUDGET` / `SEARCH_TIME_BUDGET_MS` / `DEFAULT_SEARCH_IGNORE`）
 * 同样来自内核，这里只引用，不另抄一份字面量（可经 `NodeFilePortOptions` 收紧，便于单测）。
 *
 * 项目根边界（docs/06 §11.1）：六个方法都先过 `resolveWithin`（realpath 前缀校验），
 * 越界抛 `PATH_OUTSIDE_CODE`；`run_command` 的 cwd 校验复用**同一个**函数（见 `command-runner.ts`）。
 */
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import type { Dirent, Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createNoopLogger, type Logger } from '@aurora/shared'
import {
  DEFAULT_READ_LINES,
  DEFAULT_SEARCH_IGNORE,
  DEFAULT_SEARCH_MAX_RESULTS,
  MAX_EDIT_BYTES,
  MAX_FILE_SCAN_BYTES,
  MAX_READ_LINES,
  MAX_READ_SCAN_BYTES,
  SEARCH_BUDGET,
  SEARCH_TIME_BUDGET_MS,
  compileGlob,
  matchesGlob,
} from '@aurora/agent-core'
import type {
  DirEntry,
  FilePort,
  FindFilesOptions,
  FindFilesResult,
  ReadLine,
  ReadTextOptions,
  ReadTextResult,
  ReadWholeTextResult,
  SearchMatch,
  SearchTextOptions,
  SearchTextResult,
} from '@aurora/agent-core'

/* ───────────────────────── 项目根边界（docs/06 §11.1） ───────────────────────── */

/**
 * 越界错误码：`resolveWithin` 抛出的错误带这个 `code`。
 *
 * 为什么要有它：调用方（工具层 / `run_command`）必须能把「路径越界」与普通 IO 失败区分开
 * ——两者的处置完全不同（越界要让用户改路径或显式放行，IO 失败要重试或换目标）。
 */
export const PATH_OUTSIDE_CODE = 'E_PATH_OUTSIDE_WORKSPACE'

/** 越界错误（`code` 固定为 `PATH_OUTSIDE_CODE`） */
export interface PathOutsideError extends Error {
  code: typeof PATH_OUTSIDE_CODE
}

/**
 * 显式放行位（与 `packages/agent-core/src/tools/files.ts` 上的同名字段对应）：
 * `true` = 用户已在确认卡片里同意操作项目根之外的路径，**跳过边界校验**。
 */
export interface OutsideOption {
  /** 显式放行到项目根之外；缺省 / `false` = 按项目根校验 */
  allowOutside?: boolean
}

/**
 * 项目根边界的三件套：`file-port` 与 `command-runner` **共用同一套判定**（不复制两份）。
 *
 * 两个 getter 都是**每次调用即时读**的 live getter（不是启动时快照）：用户在设置页改
 * 「项目根 / 是否限制在项目内」后立刻生效，不需要重建端口（与 `registerComputerTools` 的 `sync()`
 * 热重建是两条互补的路子——这里连重建都省了）。
 */
export interface WorkspaceGuardOptions {
  /**
   * 项目根（绝对路径）；返回 `undefined` / 空串 = **不做边界校验**
   * （行为与没有边界校验时逐字一致）。
   */
  workspaceRoot?: () => string | undefined
  /**
   * 是否启用边界校验。缺省 = `workspaceRoot()` 有值就启用；
   * 显式返回 `false` 时**完全等同于没配根**（用户在设置页关掉了「限制在项目内」）。
   */
  enforceWorkspace?: () => boolean
  /** 根不可用（不存在 / 解析不出真实路径）时的留痕；缺省静默（no-op logger） */
  logger?: Logger
}

/**
 * 解析路径并做**项目根 realpath 前缀校验**（`FilePort` 六个方法与 `run_command` 的 cwd 共用）。
 *
 * ## 判定口径
 * 1. `target = resolve(path)`：先按 `node:path` 归一（相对路径、`..` 段、混合分隔符），与既有口径一致。
 * 2. **realpath 归一**：对目标的「已存在的最近父目录」做 `fs.realpath`，再把不存在的尾部原样拼回去
 *    （`canonicalize`）——`write_file` 新建文件时目标还不存在，而"还不存在"恰恰是最需要校验的场景；
 *    只做字符串比较的话，符号链接 / junction / 8.3 短名都能把路径指到根外。
 *    `workspaceRoot()` 同样 realpath；**根不存在视为不可用 → 不启用校验**（记一条 warn，不抛错：
 *    项目目录还没建好不该让所有文件工具都失效）。
 * 3. 前缀判定用 `relative(root, target)`：结果以 `..` 段开头（或换盘符时是绝对路径）即越界。
 *    ⚠️ 判据是 `rel === '..' || rel.startsWith('..' + sep)`，**不是** `rel.startsWith('..')`
 *    ——后者会把根内一个合法的 `..foo` 条目误判成越界（`relative` 对它返回的正是 `..foo`）。
 *    目标恰好就是根本身（`rel === ''`）**允许**：`list_dir` / `glob` / `grep` 的根常常就是项目根。
 *
 * ## 大小写（Windows 实测结论见 `file-port.test.ts` 的「项目根边界」用例注释）
 * `fs.realpath` 会把 `c:\...` / `C:\...` / `\\?\C:\...` / 8.3 短名一律归一成**磁盘上的真实长名形态**
 * （盘符也归成大写），而 `path.win32.relative` 的分段比较本身大小写不敏感 —— 所以这里**不需要**
 * 再 `toLowerCase()`（加了是死代码，只会掩盖"判定其实靠 relative 的大小写不敏感"这个事实）。
 *
 * ## 返回值
 * 返回 `resolve(path)`，**不是** realpath 之后的形态：回带路径与加边界之前逐字一致
 * （模型看到的路径就是它自己写的那个）；realpath 形态只用于判定，不外泄。
 *
 * `allowOutside === true` 整段跳过（用户显式放行）；`guard` 缺省 / 根不可用 / 校验关闭时
 * 直接返回 `resolve(path)`：**行为与没有边界校验时完全一致**。
 */
export async function resolveWithin(
  path: string,
  allowOutside: boolean,
  guard?: WorkspaceGuardOptions,
): Promise<string> {
  const target = resolve(path)
  if (allowOutside) return target
  const root = await resolveWorkspaceRoot(guard)
  if (root === undefined) return target
  const rel = relative(root, await canonicalize(target))
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw createPathOutsideError(target, root)
  }
  return target
}

/** 越界判定：唯一的识别方式是错误上的 `code`（message 只给人看，不参与判定） */
export function isPathOutsideError(error: unknown): error is PathOutsideError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === PATH_OUTSIDE_CODE
  )
}

/** 越界错误：message 里带目标与根（**越界不静默**），并带上可识别的 `code` */
function createPathOutsideError(target: string, root: string): PathOutsideError {
  const error = new Error(
    `该路径在项目根之外；如需操作请改用项目内路径（目标：${target}；项目根：${root}）`,
  ) as PathOutsideError
  // `as` 而不是 `Object.assign`：`Object.assign` 会把 `code` 推成 `string`，
  // 与 `PathOutsideError` 上的字面量类型对不上（TS2322）
  error.code = PATH_OUTSIDE_CODE
  return error
}

/**
 * 取**可用的**项目根（realpath 形态）：没配 / 显式关闭 / 根不存在 都返回 `undefined`
 * = 不启用边界校验。
 *
 * 根必须真实存在才谈得上"边界"：`workspaceDir` 配了但目录还没建、或用户在设置页填了个错的路径时，
 * 让全部文件工具直接报错是更糟的结果（连读都读不了），所以这里选择**退回无边界**并留一条 warn。
 */
async function resolveWorkspaceRoot(
  guard: WorkspaceGuardOptions | undefined,
): Promise<string | undefined> {
  if (guard?.enforceWorkspace !== undefined && !guard.enforceWorkspace()) return undefined
  const declared = guard?.workspaceRoot?.()
  if (declared === undefined || declared.trim() === '') return undefined
  try {
    return await realpath(resolve(declared))
  } catch (error) {
    guard?.logger?.warn('项目根不可用（不存在或无法解析），已跳过路径边界校验', {
      workspaceRoot: declared,
      reason: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
}

/**
 * 目标路径的 realpath 形态：从目标本身逐级向上找到**第一个真实存在**的祖先，对它做 `fs.realpath`，
 * 再把沿途不存在的名字按原样拼回去。
 *
 * 为什么不直接 `realpath(target)`：`write_file` 新建文件时目标不存在，`realpath` 会 `ENOENT`
 * （Windows 实测就是 `ENOENT`，不是返回原路径），于是"最该校验的新建场景"反而漏掉。
 *
 * 为什么必须 realpath：`resolve()` 只做**字符串级**归一，根内一个指向根外的符号链接 / junction
 * 会让"看着在根内"的路径实际落到根外——纯字符串前缀比较挡不住这一类。
 */
async function canonicalize(target: string): Promise<string> {
  const tail: string[] = []
  let current = target
  for (;;) {
    try {
      const real = await realpath(current)
      return tail.length === 0 ? real : join(real, ...tail.reverse())
    } catch {
      const parent = dirname(current)
      // 上溯到盘符根（`C:\` 的 dirname 还是 `C:\`）仍不存在：放弃上溯，原样返回。
      // 不在这里报错——路径本身不存在时，后面的 fs 调用会给出更准确的 ENOENT。
      if (parent === current) return target
      tail.push(basename(current))
      current = parent
    }
  }
}

/**
 * 搜索层的可选注入（docs/06 §11.5）：四个字段都只是**收紧护栏**用的，
 * 缺省时取内核导出的常量。单测据此把预算 / 单文件上限调到极小，
 * 不必真造 2 万个文件、1 MiB 的文本或一个病态正则就能验证「触顶仍返回已收集结果」
 * 「大文件跳过」「时间护栏到点不再扫」这些行为。
 */
export interface NodeFilePortOptions extends WorkspaceGuardOptions {
  /** 忽略的目录名（整棵子树跳过；按名字**精确匹配**，不做模式匹配） */
  searchIgnore?: readonly string[]
  /** 遍历预算：文件数与总字节数双重上限，任一触顶即停止遍历 */
  searchBudget?: { maxFiles: number; maxBytes: number }
  /** 单文件扫描上限（字节）：超过即**静默**跳过（不扫内容） */
  maxFileScanBytes?: number
  /** 内容扫描的墙钟预算（毫秒）：缺省取内核的 `SEARCH_TIME_BUDGET_MS` */
  searchTimeBudgetMs?: number
}

/**
 * 本实现的端口类型：比内核的 `FilePort` **每个方法多一个可选的放行位**（`OutsideOption`）。
 *
 * 为什么要显式声明而不是复用 `FilePort`：内核侧的同名字段是**同一波**由另一位同事加上的，
 * 这里先把自己的类型钉住，两侧改动互不阻塞；字段是**可选**的，所以本类型可直接赋给 `FilePort`
 * （`main/index.ts` 就是这么用的）。
 */
export interface NodeFilePort extends FilePort {
  readText(path: string, options: ReadTextOptions & OutsideOption): Promise<ReadTextResult>
  readWholeText(
    path: string,
    maxBytes: number,
    options?: OutsideOption,
  ): Promise<ReadWholeTextResult>
  writeText(
    path: string,
    content: string,
    mode: 'overwrite' | 'append',
    options?: OutsideOption,
  ): Promise<{ absolutePath: string; bytes: number }>
  list(
    path: string,
    limit: number,
    options?: OutsideOption,
  ): Promise<{ absolutePath: string; entries: DirEntry[]; truncated: boolean }>
  findFiles(options: FindFilesOptions & OutsideOption): Promise<FindFilesResult>
  searchText(options: SearchTextOptions & OutsideOption): Promise<SearchTextResult>
}

/** 二进制探测范围：只扫前 8 KiB，避免为判定类型读入整个大文件 */
const NUL_SCAN_BYTES = 8 * 1024
/** 含 NUL 字节即按二进制处理（文本文件不该出现 NUL） */
const BINARY_MESSAGE = '这是二进制文件，无法按文本读取（可改用 run_command 处理）'

/**
 * 非 UTF-8 文本的拒绝原因（只给 `readWholeText` 用）。
 *
 * 文案里必须出现「UTF-8」：调用方（模型）要据此知道该换工具，而不是重试同一次读取。
 */
const NOT_UTF8_MESSAGE =
  '文件不是 UTF-8 文本（无法保证逐字节保真，已放弃读取）：GBK / GB18030 / UTF-16 等编码或二进制内容在 UTF-8 编解码往返后会丢失原始字节'

export function createNodeFilePort(options: NodeFilePortOptions = {}): NodeFilePort {
  // 搜索层的四条护栏在工厂里**一次性**规范化：遍历期间不再重算，也不信任调用方给的怪值
  const searchIgnore: ReadonlySet<string> = new Set(options.searchIgnore ?? DEFAULT_SEARCH_IGNORE)
  const searchBudgetLimits = options.searchBudget ?? SEARCH_BUDGET
  const maxFileScanBytes = resolveLimit(
    options.maxFileScanBytes ?? MAX_FILE_SCAN_BYTES,
    MAX_FILE_SCAN_BYTES,
  )
  const searchTimeBudgetMs = resolveLimit(
    options.searchTimeBudgetMs ?? SEARCH_TIME_BUDGET_MS,
    SEARCH_TIME_BUDGET_MS,
  )
  // 项目根边界：两个 getter 原样透传（**不在工厂里快照**，每次调用即时读）；
  // 未注入 logger 时为 no-op，主进程装配层会注入真实 logger（根不可用时留痕）
  const guard: WorkspaceGuardOptions = {
    workspaceRoot: options.workspaceRoot,
    enforceWorkspace: options.enforceWorkspace,
    logger: options.logger ?? createNoopLogger(),
  }

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
    async readText(path: string, options: ReadTextOptions & OutsideOption) {
      // 边界校验放在 try **之外**：越界错误要原样抛出（带 `PATH_OUTSIDE_CODE`），
      // 不能被 `withPath` 包成一条普通 IO 失败（那样调用方就分不清"越界"与"读不到"了）
      const absolutePath = await resolveWithin(path, options.allowOutside === true, guard)
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

    /**
     * **整文件**读入（`edit_file` 专用，docs/06 §11.6）。
     *
     * 语义与 `readText` 的行窗口正相反：这里不做任何裁剪，只有两种结果——
     * 要么给出**逐字节原样**的全文（`bytes` 是文件真实大小），要么明确拒绝（`refused: true`）。
     * 为什么必须有这个入口：`readText` 是行窗口 API（默认 2000 行、`maxBytes` 是对窗口的字节上限），
     * 拿它做「读全文 → 替换 → 写回」会在文件超出窗口时把窗口外的内容**整段丢掉，而且不报任何错**。
     *
     * - `size > maxBytes` 或 `size > MAX_READ_SCAN_BYTES` → `refused: true` 且**不读内容**
     *   （`text` 为空串，`bytes` 仍是真实大小）：拒绝要发生在读入之前，把读到的半截内容摆给调用方
     *   只会诱使它"就用这一段改吧"。`maxBytes` 的非有限值回落 `MAX_EDIT_BYTES`、非正值按 1 处理
     *   （沿用 `resolveLimit` 的既有口径：端口是独立入口，调用方给的怪值不该让护栏失效）。
     * - 文本**逐字节原样**：CRLF 不归一、末尾换行保留、BOM 不动（改写要"除目标片段外不变"，
     *   任何归一都是对全文件的改写）。这句承诺**不是尽力而为**——下方三条不变量（读满、
     *   整缓冲区无 NUL、UTF-8 编解码往返一致）任一不成立就抛错：宁可拒绝读取，
     *   也不交出一份"看着像全文、写回却会改坏文件"的文本。
     * - 二进制（**整缓冲区**含 NUL，见 `containsNulByte`）与非 UTF-8 文本（GBK / GB18030 /
     *   UTF-16 等，见 `NOT_UTF8_MESSAGE`）与目录**抛错**（同 `readText`）：
     *   它们若被当作文本读入并以 UTF-8 原文写回，就是**静默损坏且不报错**
     *   ——一个 1 MiB 以内的 `.png` / 压缩包只要字节里恰好出现一段能被当成 `oldString` 的序列，
     *   或某个 GBK 文本文件的非 ASCII 字节被 `toString('utf8')` 换成 U+FFFD，即可触发。
     */
    async readWholeText(path: string, maxBytes: number, options?: OutsideOption) {
      const absolutePath = await resolveWithin(path, options?.allowOutside === true, guard)
      const limit = resolveLimit(maxBytes, MAX_EDIT_BYTES)
      try {
        const info = await stat(absolutePath)
        if (info.isDirectory()) throw new Error('这是目录，不是文件（可改用 list_dir）')
        const size = info.size
        if (size > limit || size > MAX_READ_SCAN_BYTES) {
          return { absolutePath, text: '', bytes: size, refused: true }
        }
        const buffer = await readHead(absolutePath, size)
        // 不变量 ①：真的读满 size 字节。短读（并发截断 / 读期间被改写）会让我们手里只有
        // 文件的开头一段，而调用方拿到的 `bytes` 仍是完整大小 —— 它把这段写回就等于
        // **静默丢掉尾部**，且没有任何迹象提示它内容不完整。
        if (buffer.length !== size) {
          throw new Error(
            `文件在读取期间发生变化（应有 ${size} 字节、实读 ${buffer.length} 字节），已放弃读取`,
          )
        }
        // 不变量 ②：**整缓冲区**扫 NUL（不是 `readText` 的 8 KiB 口径，原因见 `containsNulByte`）
        if (containsNulByte(buffer)) throw new Error(BINARY_MESSAGE)
        const text = buffer.toString('utf8')
        // 不变量 ③：UTF-8 编解码往返必须一致。`toString('utf8')` 会把所有非法序列换成
        // U+FFFD（再编码成 EF BF BD），于是「读进来 - 换个词 - 写回」就把整个文件的
        // 非 ASCII 内容**静默替换成另一种字节**（GBK 的「你好」→ 6 个替换字符）。
        // ② 与 ③ 合起来覆盖三条已知的坏输入：NUL 在任意位置（②）、GBK / GB18030 / UTF-16
        // 这类"另类编码但无 NUL"的文本、以及 UTF-8 里被截断的多字节序列（③）。
        // 注意 ③ **挡不住** NUL 本身（U+0000 是合法字符、能原样往返），别把两者混为一谈。
        if (!Buffer.from(text, 'utf8').equals(buffer)) throw new Error(NOT_UTF8_MESSAGE)
        return { absolutePath, text, bytes: size, refused: false }
      } catch (error) {
        throw withPath('读取文件失败', absolutePath, error)
      }
    },

    async writeText(
      path: string,
      content: string,
      mode: 'overwrite' | 'append',
      options?: OutsideOption,
    ) {
      // 校验在建父目录**之前**：越界时连 `mkdir -p` 都不该发生
      const absolutePath = await resolveWithin(path, options?.allowOutside === true, guard)
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

    async list(path: string, limit: number, options?: OutsideOption) {
      const absolutePath = await resolveWithin(path, options?.allowOutside === true, guard)
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

    /**
     * 按文件名 glob 递归找文件（docs/06 §11.5，`glob` 工具）。
     *
     * - 匹配的是**相对 root 的正斜杠路径**（如 `src/a.ts`）；模式里的 `**\/` 会编译成
     *   「任意层目录（含零层）」，所以 `**\/*.ts` 命中 `a.ts`（编译规则见 `globPattern.ts`）。
     * - 只比名字、**不读内容**，因此**不受 `maxFileScanBytes` 约束**：一个 2 MiB 的
     *   `pnpm-lock.yaml` 是真实存在且常被按名字查找的文件，让它「按名字也找不到」才是反直觉的
     *   （那个阈值是**内容扫描**的上限，只对 `searchText` 生效）。
     *   其余遍历口径与 `searchText` 完全一致：忽略目录、符号链接、文件数与字节数双预算。
     * - 命中数达 `maxResults` 即停止遍历并置 `truncated`（此时可能还有更多，模型据此收窄模式）。
     */
    async findFiles(options: FindFilesOptions & OutsideOption): Promise<FindFilesResult> {
      // 只校验**遍历根**，遍历过程中**不**逐文件校验：每次校验都要 realpath（最坏情况逐级上溯多次
      // 系统调用），给一次 glob 加上几千次 realpath 会把搜索拖垮。这个取舍是安全的——
      // 子路径由 `join(根, 名字)` 拼出，而 walker 的**口径 1** 一律跳过符号链接
      //（文件与目录都跳），所以"根内某个链接把我带到根外"这条路已经在遍历层堵住了。
      const absoluteRoot = await resolveWithin(options.root, options.allowOutside === true, guard)
      const maxResults = resolveMaxResults(options.maxResults)
      const pattern = options.pattern
      const files: string[] = []
      let truncated = false
      const walk = createSearchWalk(searchIgnore, searchBudgetLimits)
      try {
        await requireDirectory(absoluteRoot)
        await walkDirectory(absoluteRoot, '', walk, (relativePath) => {
          // 模式匹配一律复用 `globPattern.ts`（本文件不含第二份匹配逻辑）
          if (!matchesGlob(pattern, relativePath)) return true
          files.push(relativePath)
          if (files.length >= maxResults) {
            truncated = true
            return false
          }
          return true
        })
      } catch (error) {
        throw withPath('查找文件失败', absoluteRoot, error)
      }
      return {
        root: absoluteRoot,
        files,
        truncated,
        scannedFiles: walk.budget.files,
        budgetExceeded: walk.budget.exceeded,
      }
    },

    /**
     * 按正则递归搜文件内容（docs/06 §11.5，`grep` 工具）。
     *
     * - `pattern` 是**正则源码**（内核已用 `new RegExp` 校验过能编译），真正编译执行在这里：
     *   `RegExp` 对象不跨端口传。
     * - 行切分与 `readText` **同一口径**（复用 `splitTextLines`）：逐行走 `\n` 切分并去掉行尾 `\r`，
     *   行号 **1 起始**；因此 CRLF 文件的命中行是干净的（不会夹一个看不见的回车），
     *   末尾换行符也**不产生**一个虚假的末行（否则 `^$` 这类模式会报出一条不存在的命中）。
     * - 同一行**只记一条**（一行内多次命中不重复 push）：grep 的用途是「定位到行」，
     *   同一行重复出现对模型没有增量信息，还会把 `maxResults` 的名额浪费掉。
     * - 二进制（前 8 KiB 含 NUL，复用 `hasNulByte`）计入 `skippedBinary` 后跳过。
     * - 墙钟护栏：遍历耗时超过 `SEARCH_TIME_BUDGET_MS`（可经 `NodeFilePortOptions` 收紧）
     *   即停止遍历并置 `budgetExceeded`，**已收集的结果照常返回**（不抛错、也不是空结果）。
     *   它防的是"很多个慢匹配累积"而不是"单次匹配本身很慢"：`regex.test` 是同步调用，
     *   一旦开始就**无法被打断**，所以到点只能保证「不再进入下一个文件」——单次调用仍会跑完。
     * - `include` 的 glob **只在开始遍历前编译一次**（`compileGlob` 每次调用都会 `new RegExp`，
     *   放在 visitor 里就是每个文件重编译一遍）；匹配语义与 `matchesGlob` 的缺省口径一致。
     */
    async searchText(options: SearchTextOptions & OutsideOption): Promise<SearchTextResult> {
      // 同 `findFiles`：只校验遍历根，不在 visitor 里逐文件 realpath（取舍理由见那里的注释）
      const absoluteRoot = await resolveWithin(options.root, options.allowOutside === true, guard)
      const maxResults = resolveMaxResults(options.maxResults)
      const include = options.include
      const matches: SearchMatch[] = []
      let skippedBinary = 0
      let truncated = false
      // 时间护栏的起点：整次遍历共用一个预算（不是每个文件各给一份）
      const startedAt = Date.now()
      const walk = createSearchWalk(searchIgnore, searchBudgetLimits)
      try {
        await requireDirectory(absoluteRoot)
        // 内核只用 `new RegExp` 校验；编译失败（理论上到不了这里）按普通错误抛出，由 withPath 带上路径
        const regex = new RegExp(options.pattern)
        // `include` 按**相对 root 的路径**过滤（`globPattern.ts` 的路径模式）。
        // `compileGlob` 已是全串锚定、路径模式、大小写不敏感 —— 与 `matchesGlob` 的缺省完全同款；
        // 这里只做「编译一次、复用同一个正则」，不引入第二套匹配语义
        //（visitor 收到的 `relativePath` 已由 `toPosixPath` 归一过，所以不必再调 `matchesGlob`
        // 的值归一化那一步）。
        const includeRegex = include === undefined ? undefined : compileGlob(include)
        await walkDirectory(
          absoluteRoot,
          '',
          walk,
          async (relativePath, absolutePath, sizeBytes) => {
            // 时间护栏：进入下一个文件之前先看是否到点。到点就停止遍历并如实置 `budgetExceeded`
            //（内核会为它渲染「搜索预算已用完」的标注），已收集的结果原样带回去。
            if (Date.now() - startedAt > searchTimeBudgetMs) {
              walk.budget.exceeded = true
              return false
            }
            if (includeRegex !== undefined && !includeRegex.test(relativePath)) return true
            // 内容扫描的单文件上限：超大文件（构建产物 / 日志 / 媒体）不读进来，
            // 避免一个文件吃掉整个字节预算。**静默跳过**，不单独计数也不标注（避免噪声）
            if (sizeBytes > maxFileScanBytes) return true
            let content: Buffer
            try {
              content = await readFile(absolutePath)
            } catch {
              // 单个文件读不了（权限 / 竞态删除 / 断链）只跳过它，不让整次搜索失败
              return true
            }
            if (hasNulByte(content)) {
              skippedBinary += 1
              return true
            }
            const lines = splitTextLines(content.toString('utf8'))
            for (let index = 0; index < lines.length; index += 1) {
              const text = lines[index] ?? ''
              if (!regex.test(text)) continue
              matches.push({ path: relativePath, line: index + 1, text })
              if (matches.length >= maxResults) {
                truncated = true
                return false
              }
            }
            return true
          },
        )
      } catch (error) {
        throw withPath('搜索文件失败', absoluteRoot, error)
      }
      return {
        root: absoluteRoot,
        matches,
        truncated,
        scannedFiles: walk.budget.files,
        skippedBinary,
        budgetExceeded: walk.budget.exceeded,
      }
    },
  }
}

/**
 * 遍历预算的运行态：上限在建立时规范化一次，之后只累加与判定。
 * `exceeded` 为真时**已收集的结果照常返回**（不是抛错、也不是空结果）。
 */
interface SearchBudget {
  maxFiles: number
  maxBytes: number
  files: number
  bytes: number
  exceeded: boolean
}

/** 一次遍历的共享上下文：`findFiles` 与 `searchText` 走同一个 walker，只有 visitor 不同 */
interface SearchWalk {
  /** 忽略的目录名集合（精确匹配，整棵子树跳过） */
  ignore: ReadonlySet<string>
  budget: SearchBudget
}

/**
 * visitor 返回 `false` 表示「收集够了，停止遍历」（结果数达上限 / 预算触顶）。
 * `relativePath` 已是**正斜杠**分隔的相对 root 路径。
 */
type WalkVisitor = (
  relativePath: string,
  absolutePath: string,
  /** 文件大小（字节，遍历时已 stat 过，visitor 不必再查一次） */
  sizeBytes: number,
) => boolean | Promise<boolean>

/**
 * 递归遍历 `absoluteDir` 下的普通文件，逐个交给 `visit`（docs/06 §11.5）。
 *
 * 四条口径缺一不可：
 * 1. **符号链接一律跳过**（文件与目录都跳）——这是防目录环的**唯一**手段：
 *    `dir/loop -> dir` 这类自指环会让递归永不返回，而且 `readdir` 不会报错、只会一直往下走，
 *    所以没有「靠错误退出」或「靠深度护栏」的替代方案（深度上限还会误伤真实目录树）。
 * 2. **条目先按名字字典序排序再处理**：配合命中行按行号升序，结果**天然有序**、
 *    不需要事后全局排序；预算提前中止时返回的也是稳定前缀（前缀稳定才谈得上可复现）。
 * 3. **忽略目录名命中即整棵子树跳过**（按名字**精确匹配**，不做模式匹配）：
 *    既不进结果、也不计入 `scannedFiles`（`node_modules` 动辄上万文件，计进去会瞬间吃光预算）。
 * 4. **预算（文件数 / 字节数）任一触顶立即停止遍历**并置 `budget.exceeded`，
 *    已收集的结果照常返回——不是抛错、也不是空结果（内核的 `budgetExceeded` 标注依赖这个标记）。
 *
 * 文件大小**不在本函数判定**：`sizeBytes` 原样交给 `visit`，由各工具自己决定上限怎么用
 * （`searchText` 用 `maxFileScanBytes` 静默跳过超大文件，`findFiles` 只比名字、不看大小）。
 *
 * `visit` 返回 `false` 时本函数返回 `true`；自然结束或预算触顶返回 `false`（两者由 `budget.exceeded` 区分）。
 * 单个子目录 / 单个文件出错（权限、竞态删除、断链）只跳过它，**不**让整次搜索失败；
 * 根目录（`relativeDir` 为空串）读不了则抛给调用方，由 `withPath` 补上绝对路径（越界不静默）。
 */
async function walkDirectory(
  absoluteDir: string,
  relativeDir: string,
  walk: SearchWalk,
  visit: WalkVisitor,
): Promise<boolean> {
  let dirents: Dirent[]
  try {
    dirents = await readdir(absoluteDir, { withFileTypes: true })
  } catch (error) {
    if (relativeDir === '') throw error
    return false
  }
  for (const dirent of [...dirents].sort(compareDirentNames)) {
    if (walk.budget.exceeded) return false
    const name = dirent.name
    // 口径 1：符号链接一律跳过（目录环、指向树外的链、断链都在这里一次性挡住）
    if (dirent.isSymbolicLink()) continue
    const absolutePath = join(absoluteDir, name)
    const relativePath = toPosixPath(relativeDir === '' ? name : join(relativeDir, name))
    if (dirent.isDirectory()) {
      // 口径 3：忽略目录整棵子树跳过
      if (walk.ignore.has(name)) continue
      if (await walkDirectory(absolutePath, relativePath, walk, visit)) return true
      continue
    }
    // 其它条目类型（设备 / 管道等）不入结果
    if (!dirent.isFile()) continue
    if (walk.budget.files + 1 > walk.budget.maxFiles) {
      walk.budget.exceeded = true
      return false
    }
    walk.budget.files += 1
    let sizeBytes: number
    try {
      sizeBytes = (await stat(absolutePath)).size
    } catch {
      // 竞态删除 / 权限：跳过该条（它已占掉一个文件名额，不再计入字节预算）
      continue
    }
    if (walk.budget.bytes + sizeBytes > walk.budget.maxBytes) {
      walk.budget.exceeded = true
      return false
    }
    walk.budget.bytes += sizeBytes
    if (!(await visit(relativePath, absolutePath, sizeBytes))) return true
  }
  return false
}

/** 搜索层的初始上下文：预算上限在这里规范化一次（遍历期间只累加，不重算） */
function createSearchWalk(
  ignore: ReadonlySet<string>,
  limits: { maxFiles: number; maxBytes: number },
): SearchWalk {
  return {
    ignore,
    budget: {
      maxFiles: resolveLimit(limits.maxFiles, SEARCH_BUDGET.maxFiles),
      maxBytes: resolveLimit(limits.maxBytes, SEARCH_BUDGET.maxBytes),
      files: 0,
      bytes: 0,
      exceeded: false,
    },
  }
}

/**
 * 注入口径的规范化：非数字 / NaN 回落缺省值，其余取整后**不小于 1**。
 * 端口是独立入口，调用方给的怪值不该让遍历失去护栏（0 或负数会让「触顶」变得毫无意义）。
 */
function resolveLimit(value: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(Math.floor(value), 1)
}

/**
 * `maxResults` 的取整与钳制：非数字回落 `DEFAULT_SEARCH_MAX_RESULTS`，其余不小于 1。
 * 上限（`MAX_SEARCH_MAX_RESULTS`）由内核 / 装配层钳制——端口只保证拿到的是正整数，
 * 这样「结果的条数策略」只在一处定义。
 */
function resolveMaxResults(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SEARCH_MAX_RESULTS
  return Math.max(Math.floor(value), 1)
}

/**
 * 搜索根必须是**目录**：不存在（`stat` 抛 ENOENT）或不是目录都抛出，
 * 由调用方 `withPath` 补上绝对的搜索根路径（越界不静默的既有口径）。
 * 端口是独立入口，不假设调用方已经检查过。
 */
async function requireDirectory(absoluteRoot: string): Promise<void> {
  const info = await stat(absoluteRoot)
  if (!info.isDirectory()) throw new Error('搜索根不是目录（这里要的是一个文件夹）')
}

/**
 * 相对路径一律**正斜杠**（`split(sep).join('/')`）：模式匹配、结果展示、跨平台测试
 * 都按同一口径走，Windows 上不会突然冒出 `src\a.ts`。
 */
function toPosixPath(relativePath: string): string {
  return relativePath.split(sep).join('/')
}

/** 条目按名字字典序（与 `list` 的排序口径一致）；先排序再处理才有确定性的结果顺序 */
function compareDirentNames(a: Dirent, b: Dirent): number {
  return a.name.localeCompare(b.name)
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
 * **整缓冲区**的 NUL 判定（只给 `readWholeText` 用，口径与 `hasNulByte` 刻意不同）。
 *
 * 为什么不是"复用 `hasNulByte` 更省事"：`readText` 是**行窗口** API，文件可以大到 16 MiB，
 * 为了判定类型把整个文件扫一遍不划算 —— 它在 8 KiB 处止步是既有的性能取舍（别动）。
 * `readWholeText` 不一样：它的文件上限是 1 MiB（`MAX_EDIT_BYTES` / `MAX_READ_SCAN_BYTES`
 * 二者取小），全量扫一遍的成本可忽略；而这里的漏判是**破坏性**的 ——
 * 后段的 NUL 让一个二进制文件被当成文本读入，`edit_file` 再以 UTF-8 原文写回整篇。
 */
function containsNulByte(buffer: Buffer): boolean {
  return buffer.includes(0)
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
