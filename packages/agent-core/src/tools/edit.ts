/**
 * `edit_file` 工具与「改前先读」守卫契约（docs/06 §11.6）。
 *
 * 分层：本文件是**纯逻辑**——工具定义、参数校验、行尾归一、计数与替换、各条拒绝条件。
 * 真实的整文件读与原子写由主进程端口承担（`apps/desktop/src/main/tools/file-port.ts`），
 * 经 `EditToolOptions.files` 注入，因此内核保持纯 Node、可在 Node 里完整单测（`edit.test.ts`）。
 *
 * 为什么整文件替换必须走 `readWholeText` 而不是 `read_file` 的行窗口 API
 * （`readText` 默认只给 2000 行，`maxBytes` 是对窗口的上限）：
 * 「截断后替换再写回」会把窗口外的内容**整段丢掉，而且不报任何错**。
 * 所以这里只接受语义为「要么给全文、要么明确拒绝」的整文件读（`ReadWholeTextResult.refused`）。
 *
 * 安全边界（docs/06 §11.1）：`sensitivity: 'confirm'`（与 `write_file` 同族），
 * 每一次调用都要过 `confirmTool` 钩子。并且本工具**没有备份、没有撤销**：
 * 原子写只保证「写盘过程不会写坏」，**不保证改动内容可回滚**——改错了只能靠用户自己恢复
 * （`git checkout` / 备份 / 编辑历史）。
 *
 * 设计取向：**宁可失败一次，不可改错一次**。因此本文件不做模糊匹配、不做自动重试：
 * 找不到就如实报错让模型重新读取；命中多处就拒绝，绝不猜「想改哪一处」。
 * 四种拒绝（找不到 / 多处命中 / 空 `oldString` / 新旧相同）与三种行尾拒绝
 * （文件含孤立回车 / `newString` 含孤立回车 / 混合行尾）全部返回 `isError` 且**不写盘**。
 */
import { MAX_EDIT_BYTES } from './files.js'
import type { FilePort, ReadWholeTextResult } from './files.js'
import type { ToolDefinition, ToolResult } from './registry.js'

/**
 * 会话级「读过哪些文件」的守卫（docs/06 §11.6）。
 *
 * 未注入时**不做拦截**（供直接调用工具的单测使用，与 `confirmTool` 同款的可注入端口）。
 * 键是**解析后的绝对路径**（端口回带），不是模型传入的原始串——防 `a/../b` 这类写法绕过。
 */
export interface ReadTracker {
  has(sessionId: string, absolutePath: string): boolean
  mark(sessionId: string, absolutePath: string): void
  /** `write_file` 整篇覆盖后必须清掉：否则模型拿着"读过"的标记去 edit，套用的是过期基线 */
  clear(sessionId: string, absolutePath: string): void
}

export interface EditToolOptions {
  files: FilePort
  /** `read_file` 读完后标记，`edit_file` 据此放行 */
  readTracker?: ReadTracker
  /** 单文件上限，缺省 `MAX_EDIT_BYTES` */
  maxEditBytes?: number
}

/**
 * 精确局部替换：`read_file` 读出原文 → 只换 `oldString` 命中的那一段，其余部分**逐字节不变**。
 *
 * 执行顺序固定为「参数校验 → 整文件读 → 读前守卫 → 行尾拒绝 → 归一匹配 → 替换 → 按原行尾还原 → 原子写」，
 * 任何一步失败都立即返回 `isError` 且**不写盘**。
 */
export function createEditTool(options: EditToolOptions): ToolDefinition {
  const maxEditBytes = resolveMaxEditBytes(options.maxEditBytes)
  const limit = formatEditLimit(maxEditBytes)

  return {
    name: 'edit_file',
    description: [
      '对文件做精确的局部替换：只改 oldString 命中的那一处，文件其余部分逐字节不变（含原有行尾风格，不会把整篇的 CRLF 改成 LF，或反过来）。',
      `适合只改几行而不是重写整个文件；整文件重写仍用 write_file。单文件上限 ${limit}，超过请改用 run_command 或分块 write_file。`,
      '改前必须先用 read_file 读过该文件（同一会话内），否则本工具拒绝执行——凭记忆改文件是最典型的改坏来源。',
      'oldString 要带足上下文保证唯一，并与 read_file 输出去掉行号前缀后的内容逐字一致（缩进照抄）；命中多处时本工具直接拒绝，要全局改名用 replaceAll: true。',
      '**不要**在 oldString 里带上 read_file 的行号前缀（形如 "12: " 的那一段），它不属于文件内容。',
      '匹配按字面进行、且比对前会把行尾统一成 LF，因此行尾差异不是匹配不上的原因；找不到时请用 read_file 重新确认原文——本工具不做模糊匹配、也不自动重试。newString 传空串表示删除这段内容。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '要修改的文件路径（必须先用 read_file 读过；结果里回带解析后的绝对路径）',
        },
        oldString: {
          type: 'string',
          description:
            '要被替换的原文，必须与 read_file 输出**去掉行号前缀后**的内容逐字一致，且在本文件内唯一',
        },
        newString: {
          type: 'string',
          description:
            '替换成的新文本；传空串表示删除该片段。换行请用普通换行符（LF 或 CRLF），不要用孤立的回车符',
        },
        replaceAll: {
          type: 'boolean',
          description:
            'oldString 在文件里出现多处时，必须显式传 true 才会全部替换；缺省只允许唯一命中',
        },
      },
      required: ['path', 'oldString', 'newString'],
      additionalProperties: false,
    },
    sensitivity: 'confirm',
    execute: async (input, ctx): Promise<ToolResult> => {
      // 参数非法一律**不触碰端口**（与 run_command 的既有口径一致）：
      // 宁可什么都不做，也不猜一个片段去替换。
      const record = asRecord(input)
      const path = readNonEmptyString(record, 'path')
      if (path === undefined) {
        return failure('缺少参数 path（要修改的文件路径）。', '缺少 path 参数')
      }
      const oldString = readString(record, 'oldString')
      if (oldString === undefined) {
        return failure('缺少参数 oldString（要被替换的原文）。', '缺少 oldString 参数')
      }
      const newString = readString(record, 'newString')
      if (newString === undefined) {
        return failure(
          '缺少参数 newString（替换成的新文本；要删除片段就传空串）。',
          '缺少 newString 参数',
        )
      }
      if (oldString === '') {
        return failure(
          'oldString 不能为空：空串会在任意位置匹配。请给出要被替换的原文。',
          'oldString 为空',
        )
      }
      if (oldString === newString) {
        return failure('新旧内容相同，无需改动。', '新旧内容相同')
      }
      // `newString` 里若含孤立的回车符（旧 Mac 行尾），归一（CRLF → LF）处理不了它，写进文件后
      // 该文件就会**被本工具自己永久拒绝**（下一次调用先撞上「文件含孤立的回车符」）——
      // 等于工具把用户文件改成了自己再也改不了的状态。因此**在归一之前**按原始串判，命中即拒。
      if (ISOLATED_CR.test(newString)) {
        return failure(
          'newString 含孤立的回车符（旧 Mac 行尾），写进去会让整个文件的行尾风格不一致，已放弃改动。请把 newString 里的换行改成 LF 或 CRLF。',
          '行尾异常，已放弃改动',
        )
      }
      // 非布尔真值（含字符串 'true'）一律按 false 处理：不猜模型的意图
      const replaceAll = record?.['replaceAll'] === true

      let read: ReadWholeTextResult
      try {
        read = await options.files.readWholeText(path, maxEditBytes)
      } catch (error) {
        // 二进制（含 NUL）与目录由端口抛错，这里折成 isError，不冒泡进工具循环
        return failure(`读取文件失败：${describeError(error)}`, '读取文件失败')
      }
      if (read.refused) {
        return failure(
          `文件超过 ${limit} 无法整体替换（本次未读取全文，为避免截断后写回丢弃内容已放弃改动）。请改用 run_command 或分块 write_file。`,
          '文件过大，已放弃改动',
        )
      }

      // 读前守卫：以**端口回带**的绝对路径为键，而不是模型传入的原始串
      const tracker = options.readTracker
      if (tracker !== undefined && !tracker.has(ctx.sessionId, read.absolutePath)) {
        return failure(
          `修改前必须先用 read_file 读过 ${read.absolutePath}（本会话尚未读过该文件，无法核对原文）。`,
          '未读过该文件',
        )
      }

      const text = read.text
      // 孤立的回车符（不跟在 \n 后面的 \r，旧 Mac 行尾）：归一不了，也不该猜——直接拒绝
      if (ISOLATED_CR.test(text)) {
        return failure(
          '文件含孤立的回车符（旧 Mac 行尾），为避免写坏已放弃改动。',
          '行尾异常，已放弃改动',
        )
      }
      const usesCrlf = text.includes('\r\n')
      // 混合行尾（同时含 CRLF 与 LF 行）必须拒绝：「归一成 LF 再按 usesCrlf 还原」这套做法
      // 在混合行尾文件上会把**所有 LF 行也改成 CRLF** = 整个文件每一行的行尾都被改写
      // （git diff 全文变色、用户的 stash 全部冲突），与本工具「除目标片段外逐字节不变」
      // 的承诺正好相反。宁可不改。
      if (usesCrlf && /\n/.test(text.replace(CRLF, ''))) {
        return failure(
          '文件行尾不一致（同时含 CRLF 与 LF 行），为避免把整个文件的行尾改掉，已放弃改动；请先统一行尾。',
          '行尾不一致，已放弃改动',
        )
      }

      // 归一后匹配：模型给的 oldString 几乎总是 LF 形态，直接按原文匹配会匹配不到
      const fileNorm = toLf(text)
      const oldNorm = toLf(oldString)
      const newNorm = toLf(newString)
      // 计数与替换都用 split / indexOf，**不用正则**：oldString 里的正则元字符必须当字面量
      // （否则 oldString = a.b 会把 axb 一起改掉）
      const count = fileNorm.split(oldNorm).length - 1
      if (count === 0) {
        return failure(
          `未找到 oldString（文件：${read.absolutePath}）。请用 read_file 确认原文（注意 oldString 不要带 "N: " 行号前缀）；比对已按 LF 归一，行尾差异不是原因。`,
          '未找到 oldString',
        )
      }
      if (count > 1 && !replaceAll) {
        return failure(
          `oldString 在文件中命中 ${count} 处，未声明 replaceAll 时只允许唯一命中，已放弃改动。请扩大 oldString 的上下文使其唯一，或显式传 replaceAll: true 全部替换。`,
          `命中 ${count} 处，未替换`,
        )
      }
      const replaced = replaceAll
        ? fileNorm.split(oldNorm).join(newNorm)
        : replaceFirst(fileNorm, oldNorm, newNorm)
      // 行尾还原：原文是 CRLF 就整篇还原成 CRLF（原文是 LF 时一个 \r 都不引入）
      const out = usesCrlf ? replaced.replace(/\n/g, '\r\n') : replaced

      try {
        const written = await options.files.writeText(path, out, 'overwrite')
        // 成功后**保留**守卫标记：模型刚主动改过它，知道当前内容（清掉只会逼它白读一次）
        return {
          content: `已修改：${written.absolutePath}（替换 ${count} 处，共 ${written.bytes} 字节）`,
          summary: `替换 ${count} 处`,
        }
      } catch (error) {
        return failure(`写入文件失败：${describeError(error)}`, '写入文件失败')
      }
    },
  }
}

/** 孤立的回车符（不跟在 `\n` 后面的 `\r`） */
const ISOLATED_CR = /\r(?!\n)/

/** CRLF 对（`replace` 对 `g` 正则会自行重置 `lastIndex`，**不要**拿它去做 `test`） */
const CRLF = /\r\n/g

function failure(content: string, summary: string): ToolResult {
  return { content, isError: true, summary }
}

/** 归一：CRLF → LF（文件内容与 `oldString` / `newString` 走同一套） */
function toLf(value: string): string {
  return value.replace(CRLF, '\n')
}

/** 只替换第一处（调用方已确认 `target` 至少命中一次） */
function replaceFirst(text: string, target: string, replacement: string): string {
  const index = text.indexOf(target)
  if (index === -1) return text
  return `${text.slice(0, index)}${replacement}${text.slice(index + target.length)}`
}

/** 缺省 / 非法值一律回落到内核常量 `MAX_EDIT_BYTES`（上限是正确性前提，不是性能参数） */
function resolveMaxEditBytes(configured: number | undefined): number {
  if (configured === undefined || !Number.isFinite(configured) || configured <= 0) {
    return MAX_EDIT_BYTES
  }
  return Math.floor(configured)
}

/** 上限的展示文案：整 MiB 时补一个等值说明（`1048576 字节（1 MiB）`），否则只报字节数 */
function formatEditLimit(bytes: number): string {
  const mib = bytes / 1024 / 1024
  return Number.isInteger(mib) ? `${bytes} 字节（${mib} MiB）` : `${bytes} 字节`
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  return input as Record<string, unknown>
}

/** 必填字符串：非字符串或纯空白一律视为缺参（**不触碰端口**，与 `files.ts` 同一口径） */
function readNonEmptyString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** 字符串参数：**不做 trim**（`oldString` / `newString` 里的空白是文件内容的一部分） */
function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' ? value : undefined
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
