/**
 * Office 专用工具（docs/06 §11）：只定义内核契约与参数校验，真实读写由主进程 worker 注入。
 *
 * 设计目标：让模型不再用 `run_command` 手写脆弱 PowerShell COM。DOCX / XLSX / PPTX
 * 的创建、读取与常用编辑走结构化端口；内核不依赖 Office、Electron 或 DOM。
 */
import { describeSnapshot, outsideGuard, type SnapshotWriteOutcome } from './files.js'
import type { ReadTracker } from './edit.js'
import type { ToolDefinition, ToolResult } from './registry.js'

export const OFFICE_READ_TOOL_NAME = 'office_read'
export const OFFICE_CREATE_TOOL_NAME = 'office_create'
export const OFFICE_EDIT_TOOL_NAME = 'office_edit'

export const OFFICE_TOOL_NAMES = [
  OFFICE_READ_TOOL_NAME,
  OFFICE_CREATE_TOOL_NAME,
  OFFICE_EDIT_TOOL_NAME,
] as const

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx'

export interface OfficeReadRequest {
  path: string
  target?: string
  offset?: number
  limit?: number
  allowOutside?: boolean
  sessionId?: string
}

export interface OfficeCreateRequest {
  path: string
  format: OfficeFormat
  content?: unknown
  templatePath?: string
  templateData?: Record<string, unknown>
  overwrite: boolean
  allowOutside?: boolean
  sessionId?: string
  toolCallId?: string
}

export interface OfficeEditRequest {
  path: string
  saveAs?: string
  overwrite: boolean
  operations: unknown[]
  allowOutside?: boolean
  sessionId?: string
  toolCallId?: string
}

export interface OfficeReadResult {
  absolutePath: string
  format: OfficeFormat
  content: string
  truncated: boolean
  warnings: string[]
}

export interface OfficeWriteResult {
  /** 实际写入的绝对路径（默认另存时是新文件） */
  absolutePath: string
  /** 被读取 / 用于生成结果的源文件绝对路径 */
  sourcePath: string
  format: OfficeFormat
  bytes: number
  snapshot?: SnapshotWriteOutcome
  warnings: string[]
}

export interface OfficePort {
  /** 解析并校验一个输入路径，供“先读后改”守卫与端口共用同一绝对路径。 */
  resolve(path: string, options?: { allowOutside?: boolean; sessionId?: string }): Promise<string>
  read(request: OfficeReadRequest): Promise<OfficeReadResult>
  create(request: OfficeCreateRequest): Promise<OfficeWriteResult>
  edit(request: OfficeEditRequest): Promise<OfficeWriteResult>
}

export interface OfficeToolOptions {
  office: OfficePort
  readTracker?: ReadTracker
  /** 单次编辑最多接受的操作数，防止一次工具调用里塞入无界批处理。 */
  maxOperations?: number
}

const DEFAULT_MAX_OPERATIONS = 200

export function createOfficeTools(options: OfficeToolOptions): ToolDefinition[] {
  const maxOperations = Math.max(1, Math.floor(options.maxOperations ?? DEFAULT_MAX_OPERATIONS))
  return [
    createOfficeReadTool(options.office, options.readTracker),
    createOfficeCreateTool(options.office, options.readTracker),
    createOfficeEditTool(options.office, options.readTracker, maxOperations),
  ]
}

function createOfficeReadTool(
  office: OfficePort,
  readTracker: ReadTracker | undefined,
): ToolDefinition {
  return {
    name: OFFICE_READ_TOOL_NAME,
    description: [
      '读取现有 DOCX / XLSX / PPTX 的结构摘要。',
      'DOCX 返回段落、表格与占位符；XLSX 返回工作表、使用范围、单元格和公式；PPTX 返回幻灯片、文本与备注。',
      '编辑前必须先用本工具读取源文件；大文件用 target / offset / limit 分页，不要反复整篇求摘要。',
      '不依赖本机 Office，不会启动 Word / Excel / PowerPoint。旧格式 .doc / .xls / .ppt 不在支持范围内。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要读取的 .docx / .xlsx / .pptx 路径' },
        target: {
          type: 'string',
          description: '可选：XLSX 传工作表名，PPTX 传从 0 开始的幻灯片序号，DOCX 忽略',
        },
        offset: { type: 'integer', minimum: 0, description: '可选：分页起点；缺省 0' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: '可选：最多返回多少条结构项；缺省 80',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    sensitivity: 'safe',
    execute: async (input, ctx): Promise<ToolResult> => {
      const record = asRecord(input)
      const path = readNonEmptyString(record, 'path')
      if (path === undefined) {
        return failure('缺少参数 path（要读取的 Office 文件路径）。', '缺少 path 参数')
      }
      const target = readOptionalString(record, 'target')
      const offset = readOptionalInt(record, 'offset', 0, 0, 1_000_000)
      const limit = readOptionalInt(record, 'limit', 80, 1, 500)
      try {
        const result = await office.read({
          path,
          ...(target === undefined ? {} : { target }),
          offset,
          limit,
          ...outsideGuard(ctx),
        })
        readTracker?.mark(ctx.sessionId, result.absolutePath)
        const warning = result.warnings.length === 0 ? '' : `\n警告：${result.warnings.join('；')}`
        return {
          content: `Office 文件：${result.absolutePath}（${result.format}）\n${result.content}${warning}`,
          summary: `读取 Office 文件（${result.format}${result.truncated ? '，已截断' : ''}）`,
        }
      } catch (error) {
        return failure(`读取 Office 文件失败：${describeError(error)}`, '读取 Office 文件失败')
      }
    },
  }
}

function createOfficeCreateTool(
  office: OfficePort,
  readTracker: ReadTracker | undefined,
): ToolDefinition {
  return {
    name: OFFICE_CREATE_TOOL_NAME,
    description: [
      '创建 DOCX / XLSX / PPTX，或从模板复制并填充 {{placeholder}}。',
      'content 是格式专用结构化 JSON；有 templatePath 时 templateData 指定占位符值，content 作为可选追加内容。',
      'DOCX 的 heading 会落成 Heading1–Heading6 大纲样式，bullets / numbered 会生成真实 Word 编号（可传 level: 0–8）。',
      '默认拒绝覆盖已有文件；只有用户明确要求覆盖时传 overwrite=true，并在写入前自动保存二进制快照。',
      '不依赖本机 Office，不执行宏、不自动转 PDF，也不处理旧格式 .doc / .xls / .ppt。',
      '工具报不支持时如实说明限制；不要手写 OOXML / ZIP 冒充 Office 文件，也不要自动改用 COM。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '输出路径；相对路径按会话工作目录解析' },
        format: { type: 'string', enum: ['docx', 'xlsx', 'pptx'] },
        content: {
          type: 'object',
          description:
            'DOCX {title?,blocks?}（heading/bullets/numbered/table/image 等）；XLSX {sheets:[{name,rows}]}；PPTX {title?,slides:[{title?,bullets?,notes?,image?}]}。无模板时必填，有模板时作为追加内容。',
        },
        templatePath: { type: 'string', description: '可选模板文件路径' },
        templateData: {
          type: 'object',
          description: '模板占位符值；键对应 {{name}} 中的 name',
        },
        overwrite: {
          type: 'boolean',
          description: '目标已存在时是否允许覆盖；缺省 false',
        },
      },
      required: ['path', 'format'],
      additionalProperties: false,
    },
    sensitivity: 'confirm',
    execute: async (input, ctx): Promise<ToolResult> => {
      const record = asRecord(input)
      const path = readNonEmptyString(record, 'path')
      const format = readFormat(record?.['format'])
      if (path === undefined) {
        return failure('缺少参数 path（要创建的 Office 文件路径）。', '缺少 path 参数')
      }
      if (format === undefined) {
        return failure("参数 format 只能是 'docx' / 'xlsx' / 'pptx'。", 'format 参数非法')
      }
      const content = record?.['content']
      const templatePath = readOptionalString(record, 'templatePath')
      const templateData = readObject(record?.['templateData'])
      if (content === undefined && templatePath === undefined) {
        return failure(
          '创建 Office 文件时必须提供 content，或提供 templatePath + templateData。',
          '缺少内容',
        )
      }
      if (templatePath !== undefined && templateData === undefined) {
        return failure('使用 templatePath 时必须提供 templateData（可为空对象）。', '缺少模板数据')
      }
      try {
        const result = await office.create({
          path,
          format,
          ...(content === undefined ? {} : { content }),
          ...(templatePath === undefined ? {} : { templatePath }),
          ...(templateData === undefined ? {} : { templateData }),
          overwrite: record?.['overwrite'] === true,
          ...outsideGuard(ctx),
          ...(ctx.sessionId === undefined || ctx.sessionId === ''
            ? {}
            : { sessionId: ctx.sessionId }),
          ...(ctx.toolCallId === undefined ? {} : { toolCallId: ctx.toolCallId }),
        })
        readTracker?.clear(ctx.sessionId, result.absolutePath)
        return {
          content: `已创建 Office 文件：${result.absolutePath}（${result.format}，${result.bytes} 字节）${describeSnapshot(result.snapshot)}${describeWarnings(result.warnings)}`,
          summary: `已创建 ${result.format.toUpperCase()}（${result.bytes} 字节）`,
        }
      } catch (error) {
        return failure(`创建 Office 文件失败：${describeError(error)}`, '创建 Office 文件失败')
      }
    },
  }
}

function createOfficeEditTool(
  office: OfficePort,
  readTracker: ReadTracker | undefined,
  maxOperations: number,
): ToolDefinition {
  return {
    name: OFFICE_EDIT_TOOL_NAME,
    description: [
      '编辑现有 DOCX / XLSX / PPTX，支持文字替换、模板占位符、追加段落/表格、设置单元格、增删幻灯片与工作表等常用操作。',
      '默认另存为同目录的新文件；只有用户明确要求覆盖源文件时才传 overwrite=true，并自动保存二进制快照。',
      '编辑前必须先在当前会话用 office_read 读取该文件。破坏性覆盖在快照不可用时会被拒绝。',
      'operations 是顺序执行的数组；不支持宏、PDF 导出和旧格式 .doc / .xls / .ppt。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要编辑的源 Office 文件路径' },
        saveAs: { type: 'string', description: '可选：另存为的绝对或相对路径' },
        overwrite: {
          type: 'boolean',
          description: '是否覆盖源文件；缺省 false（另存新文件）',
        },
        operations: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: { type: { type: 'string' } },
            required: ['type'],
            additionalProperties: true,
          },
          description:
            '操作示例：replace_text{find,replace}；set_placeholders{values}；append_content{content}；replace_section{index,content}；set_cells{cells:[{sheet,address,value?,formula?}]}；append_sheets{sheets}；remove_sheets{names}；append_slides{slides}；replace_slides{slides:[{index,slide}]}；remove_slides{indexes}',
        },
      },
      required: ['path', 'operations'],
      additionalProperties: false,
    },
    sensitivity: 'confirm',
    execute: async (input, ctx): Promise<ToolResult> => {
      const record = asRecord(input)
      const path = readNonEmptyString(record, 'path')
      const operations = record?.['operations']
      if (path === undefined) {
        return failure('缺少参数 path（要编辑的 Office 文件路径）。', '缺少 path 参数')
      }
      if (!Array.isArray(operations) || operations.length === 0) {
        return failure('operations 必须是非空数组。', 'operations 参数非法')
      }
      if (operations.length > maxOperations) {
        return failure(`operations 最多 ${maxOperations} 条。`, 'operations 过多')
      }
      const saveAs = readOptionalString(record, 'saveAs')
      try {
        const absoluteSource = await office.resolve(path, outsideGuard(ctx))
        if (readTracker !== undefined && !readTracker.has(ctx.sessionId, absoluteSource)) {
          return failure(
            `修改前必须先用 office_read 读过 ${absoluteSource}（本会话尚未读过该文件）。`,
            '未读过该 Office 文件',
          )
        }
        const result = await office.edit({
          path,
          ...(saveAs === undefined ? {} : { saveAs }),
          overwrite: record?.['overwrite'] === true,
          operations,
          ...outsideGuard(ctx),
          ...(ctx.sessionId === undefined || ctx.sessionId === ''
            ? {}
            : { sessionId: ctx.sessionId }),
          ...(ctx.toolCallId === undefined ? {} : { toolCallId: ctx.toolCallId }),
        })
        readTracker?.clear(ctx.sessionId, result.sourcePath)
        readTracker?.clear(ctx.sessionId, result.absolutePath)
        const mode = result.absolutePath === result.sourcePath ? '已覆盖源文件' : '已另存'
        return {
          content: `${mode}：${result.absolutePath}（源文件：${result.sourcePath}，${result.bytes} 字节）${describeSnapshot(result.snapshot)}${describeWarnings(result.warnings)}`,
          summary: mode === '已另存' ? 'Office 已另存新文件' : 'Office 文件已覆盖',
        }
      } catch (error) {
        return failure(`编辑 Office 文件失败：${describeError(error)}`, '编辑 Office 文件失败')
      }
    },
  }
}

function describeWarnings(warnings: readonly string[]): string {
  return warnings.length === 0 ? '' : `\n警告：${warnings.join('；')}`
}

function failure(content: string, summary: string): ToolResult {
  return { content, isError: true, summary }
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined
}

function readNonEmptyString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function readOptionalString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function readFormat(value: unknown): OfficeFormat | undefined {
  return value === 'docx' || value === 'xlsx' || value === 'pptx' ? value : undefined
}

function readOptionalInt(
  record: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = record?.[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.floor(value), minimum), maximum)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
