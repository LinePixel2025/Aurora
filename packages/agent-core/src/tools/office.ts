/**
 * Office tools backed by the packaged OfficeCLI runtime.
 *
 * The core only owns the tool contract and validation. Platform execution,
 * path guards and snapshots live behind an injected `OfficePort`.
 */
import { describeSnapshot, outsideGuard, type SnapshotWriteOutcome } from './files.js'
import type { ReadTracker } from './edit.js'
import type { ToolDefinition, ToolImage, ToolResult } from './registry.js'

export const OFFICE_READ_TOOL_NAME = 'office_read'
export const OFFICE_HELP_TOOL_NAME = 'office_help'
export const OFFICE_CREATE_TOOL_NAME = 'office_create'
export const OFFICE_EDIT_TOOL_NAME = 'office_edit'
export const OFFICE_RENDER_TOOL_NAME = 'office_render'
export const OFFICE_PDF_TOOL_NAME = 'office_pdf'
export const OFFICE_RAW_EDIT_TOOL_NAME = 'office_raw_edit'

export const OFFICE_TOOL_NAMES = [
  OFFICE_READ_TOOL_NAME,
  OFFICE_HELP_TOOL_NAME,
  OFFICE_CREATE_TOOL_NAME,
  OFFICE_EDIT_TOOL_NAME,
  OFFICE_RENDER_TOOL_NAME,
  OFFICE_PDF_TOOL_NAME,
  OFFICE_RAW_EDIT_TOOL_NAME,
] as const

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx'
export type OfficeReadMode = 'summary' | 'text' | 'element' | 'query' | 'issues' | 'validate'
export type OfficeRenderMode = 'screenshot' | 'html'
export type OfficeRawAction =
  | 'append'
  | 'prepend'
  | 'insertBefore'
  | 'before'
  | 'insertAfter'
  | 'after'
  | 'replace'
  | 'remove'
  | 'delete'
  | 'setattr'

/** One OfficeCLI batch item accepted by `office_create` / `office_edit`. */
export type OfficeBatchCommand = Record<string, unknown>

export interface OfficeRawOperation {
  part: string
  xpath: string
  action: OfficeRawAction
  xml?: string
}

export interface OfficeReadRequest {
  path: string
  mode: OfficeReadMode
  target?: string
  offset?: number
  limit?: number
  depth?: number
  allowOutside?: boolean
  sessionId?: string
}

export interface OfficeHelpRequest {
  format: OfficeFormat
  verb?: string
  element?: string
}

export interface OfficeCreateRequest {
  path: string
  format: OfficeFormat
  commands: OfficeBatchCommand[]
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
  commands: OfficeBatchCommand[]
  allowOutside?: boolean
  sessionId?: string
  toolCallId?: string
}

export interface OfficeRawEditRequest {
  path: string
  saveAs?: string
  overwrite: boolean
  operations: OfficeRawOperation[]
  allowOutside?: boolean
  sessionId?: string
  toolCallId?: string
}

export interface OfficeRenderRequest {
  path: string
  mode: OfficeRenderMode
  target?: string
  pageStart?: number
  pageEnd?: number
  grid?: number
  maxPages?: number
  allowOutside?: boolean
  sessionId?: string
}

export interface OfficePdfRequest {
  path: string
  outputPath?: string
  overwrite: boolean
  pageStart?: number
  pageEnd?: number
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

export interface OfficeHelpResult {
  content: string
  truncated: boolean
}

export interface OfficeWriteResult {
  /** Actual output file. Save-as mode points at the new file. */
  absolutePath: string
  /** Source file used to derive the result. */
  sourcePath: string
  format: OfficeFormat
  bytes: number
  snapshot?: SnapshotWriteOutcome
  warnings: string[]
}

export interface OfficeRenderResult {
  sourcePath: string
  format: OfficeFormat
  files: string[]
  images: readonly ToolImage[]
  pageCount?: number
  warnings: string[]
}

export interface OfficePdfResult {
  absolutePath: string
  sourcePath: string
  format: OfficeFormat
  bytes: number
  pages: number
  snapshot?: SnapshotWriteOutcome
  warnings: string[]
}

export interface OfficePort {
  /** Resolve a path with the same project-root guard used by the other file tools. */
  resolve(path: string, options?: { allowOutside?: boolean; sessionId?: string }): Promise<string>
  read(request: OfficeReadRequest): Promise<OfficeReadResult>
  help(request: OfficeHelpRequest): Promise<OfficeHelpResult>
  create(request: OfficeCreateRequest): Promise<OfficeWriteResult>
  edit(request: OfficeEditRequest): Promise<OfficeWriteResult>
  rawEdit(request: OfficeRawEditRequest): Promise<OfficeWriteResult>
  render(request: OfficeRenderRequest): Promise<OfficeRenderResult>
  pdf(request: OfficePdfRequest): Promise<OfficePdfResult>
}

export interface OfficeToolOptions {
  office: OfficePort
  readTracker?: ReadTracker
  /** Maximum number of batch commands accepted in one write. */
  maxCommands?: number
  /** Maximum serialized size of one batch command payload. */
  maxCommandsBytes?: number
}

export const DEFAULT_MAX_OFFICE_COMMANDS = 200
export const DEFAULT_MAX_OFFICE_COMMANDS_BYTES = 2 * 1024 * 1024
export const MAX_OFFICE_RAW_OPERATIONS = 50
export const DEFAULT_OFFICE_RENDER_PAGES = 6

const READ_MODES: readonly OfficeReadMode[] = [
  'summary',
  'text',
  'element',
  'query',
  'issues',
  'validate',
]
const RAW_ACTIONS: readonly OfficeRawAction[] = [
  'append',
  'prepend',
  'insertBefore',
  'before',
  'insertAfter',
  'after',
  'replace',
  'remove',
  'delete',
  'setattr',
]

export function createOfficeTools(options: OfficeToolOptions): ToolDefinition[] {
  const maxCommands = Math.max(1, Math.floor(options.maxCommands ?? DEFAULT_MAX_OFFICE_COMMANDS))
  const maxCommandsBytes = Math.max(
    1,
    Math.floor(options.maxCommandsBytes ?? DEFAULT_MAX_OFFICE_COMMANDS_BYTES),
  )
  return [
    createOfficeReadTool(options.office, options.readTracker),
    createOfficeHelpTool(options.office),
    createOfficeCreateTool(options.office, maxCommands, maxCommandsBytes),
    createOfficeEditTool(options.office, options.readTracker, maxCommands, maxCommandsBytes),
    createOfficeRenderTool(options.office),
    createOfficePdfTool(options.office),
    createOfficeRawEditTool(options.office, options.readTracker, maxCommandsBytes),
  ]
}

function createOfficeReadTool(
  office: OfficePort,
  readTracker: ReadTracker | undefined,
): ToolDefinition {
  return {
    name: OFFICE_READ_TOOL_NAME,
    description: [
      '读取 DOCX / XLSX / PPTX 的结构、元素路径、文本、问题或校验结果。',
      'mode=summary 返回结构与统计；text 返回文本；element 用 target 读取元素；query 用 target 查询；issues 返回排版/内容问题；validate 返回 OpenXML 校验。',
      '编辑前必须先用本工具成功读取源文件。修改时应复用结果中的稳定路径（/@id=、/@paraId=、/Sheet/A1）。',
      '属性名和取值不确定时先调用 office_help，不要猜。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要读取的 .docx / .xlsx / .pptx 路径' },
        mode: {
          type: 'string',
          enum: [...READ_MODES],
          description: '读取模式；缺省 summary',
        },
        target: {
          type: 'string',
          description: '元素模式传元素路径；查询模式传 selector；issues 模式可传问题类型',
        },
        offset: { type: 'integer', minimum: 0, description: '可选：分页起点；缺省 0' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: '可选：最多返回多少条；缺省 80',
        },
        depth: {
          type: 'integer',
          minimum: 0,
          maximum: 8,
          description: 'element 模式的子节点深度；缺省 1',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    sensitivity: 'safe',
    parallel: true,
    execute: async (input, ctx): Promise<ToolResult> => {
      const record = asRecord(input)
      const path = readNonEmptyString(record, 'path')
      if (path === undefined) {
        return failure('缺少参数 path（要读取的 Office 文件路径）。', '缺少 path 参数')
      }
      const mode = readEnum(record?.['mode'], READ_MODES, 'summary')
      if (mode === undefined) {
        return failure('mode 参数非法。', 'mode 参数非法')
      }
      const target = readOptionalString(record, 'target')
      if ((mode === 'element' || mode === 'query') && target === undefined) {
        return failure(`${mode} 模式必须提供 target。`, '缺少 target 参数')
      }
      const offset = readOptionalInt(record, 'offset', 0, 0, 1_000_000)
      const limit = readOptionalInt(record, 'limit', 80, 1, 500)
      const depth = readOptionalInt(record, 'depth', 1, 0, 8)
      try {
        const result = await office.read({
          path,
          mode,
          ...(target === undefined ? {} : { target }),
          offset,
          limit,
          depth,
          ...outsideGuard(ctx),
        })
        readTracker?.mark(ctx.sessionId, result.absolutePath)
        const warning = result.warnings.length === 0 ? '' : `\n警告：${result.warnings.join('；')}`
        return {
          content: `Office 文件：${result.absolutePath}（${result.format}，${mode}）\n${result.content}${warning}`,
          summary: `读取 Office（${result.format}/${mode}${result.truncated ? '，已截断' : ''}）`,
        }
      } catch (error) {
        return failure(`读取 Office 文件失败：${describeError(error)}`, '读取 Office 文件失败')
      }
    },
  }
}

function createOfficeHelpTool(office: OfficePort): ToolDefinition {
  return {
    name: OFFICE_HELP_TOOL_NAME,
    description:
      '查询 OfficeCLI 的元素、属性名、合法取值与示例。脚本化创建 / 编辑高级元素前必须先查询，避免猜 props 导致反复失败。',
    parameters: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['docx', 'xlsx', 'pptx'] },
        verb: {
          type: 'string',
          enum: ['add', 'set', 'get', 'query', 'remove'],
          description: '可选：只看某个命令可用的属性',
        },
        element: {
          type: 'string',
          description: '可选：元素类型，如 paragraph / run / shape / cell / chart',
        },
      },
      required: ['format'],
      additionalProperties: false,
    },
    sensitivity: 'safe',
    parallel: true,
    execute: async (input): Promise<ToolResult> => {
      const record = asRecord(input)
      const format = readFormat(record?.['format'])
      if (format === undefined) {
        return failure('format 只能是 docx / xlsx / pptx。', 'format 参数非法')
      }
      const verb = readOptionalString(record, 'verb')
      const element = readOptionalString(record, 'element')
      try {
        const result = await office.help({
          format,
          ...(verb === undefined ? {} : { verb }),
          ...(element === undefined ? {} : { element }),
        })
        return {
          content: result.content,
          summary: `OfficeCLI 帮助（${format}${element === undefined ? '' : `/${element}`}）`,
        }
      } catch (error) {
        return failure(`查询 OfficeCLI 帮助失败：${describeError(error)}`, '查询帮助失败')
      }
    },
  }
}

function createOfficeCreateTool(
  office: OfficePort,
  maxCommands: number,
  maxCommandsBytes: number,
): ToolDefinition {
  return {
    name: OFFICE_CREATE_TOOL_NAME,
    description: [
      '创建或从模板生成 DOCX / XLSX / PPTX。',
      'commands 是 OfficeCLI batch 命令数组：add/set/remove/move/swap；不会执行 raw XML。',
      '有 templatePath 时先替换 {{placeholder}}（templateData），再按 commands 继续初始化。',
      '默认拒绝覆盖已有文件；只有用户明确要求覆盖时传 overwrite=true，并在写入前自动保存二进制快照。',
      '属性不确定时先调用 office_help。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '输出路径；相对路径按会话工作目录解析' },
        format: { type: 'string', enum: ['docx', 'xlsx', 'pptx'] },
        templatePath: { type: 'string', description: '可选模板文件路径' },
        templateData: {
          type: 'object',
          description: '模板占位符值；键对应 {{name}} 中的 name',
        },
        commands: {
          type: 'array',
          maxItems: maxCommands,
          items: { type: 'object', additionalProperties: true },
          description: 'OfficeCLI batch 命令数组；可为空以创建空白文件或只填充模板',
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
      const templatePath = readOptionalString(record, 'templatePath')
      const templateData = readObject(record?.['templateData'])
      if (templatePath !== undefined && templateData === undefined) {
        return failure('使用 templatePath 时必须提供 templateData（可为空对象）。', '缺少模板数据')
      }
      if (
        templateData !== undefined &&
        Buffer.byteLength(JSON.stringify(templateData), 'utf8') > maxCommandsBytes
      ) {
        return failure(
          `templateData 序列化后超过 ${Math.round(maxCommandsBytes / 1024 / 1024)} MiB。`,
          'templateData 过大',
        )
      }
      const commands = validateBatchCommands(record?.['commands'], maxCommands, maxCommandsBytes)
      if (!commands.ok) return failure(commands.error, commands.summary)
      try {
        const result = await office.create({
          path,
          format,
          commands: commands.value,
          ...(templatePath === undefined ? {} : { templatePath }),
          ...(templateData === undefined ? {} : { templateData }),
          overwrite: record?.['overwrite'] === true,
          ...outsideGuard(ctx),
          ...(ctx.sessionId === undefined || ctx.sessionId === ''
            ? {}
            : { sessionId: ctx.sessionId }),
          ...(ctx.toolCallId === undefined ? {} : { toolCallId: ctx.toolCallId }),
        })
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
  maxCommands: number,
  maxCommandsBytes: number,
): ToolDefinition {
  return {
    name: OFFICE_EDIT_TOOL_NAME,
    description: [
      '用 OfficeCLI batch 命令编辑现有 DOCX / XLSX / PPTX。',
      'commands 只允许 add/set/remove/move/swap；raw XML 必须改用 office_raw_edit。',
      '修改前必须先用 office_read 读取源文件。默认另存；只有用户明确要求覆盖时才传 overwrite=true。',
      '失败会整批回滚；成功后自动执行 OpenXML validate，再把结果原子替换到目标。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要编辑的源 Office 文件路径' },
        saveAs: { type: 'string', description: '可选：另存为的绝对或相对路径' },
        commands: {
          type: 'array',
          minItems: 1,
          maxItems: maxCommands,
          items: { type: 'object', additionalProperties: true },
          description: 'OfficeCLI batch 命令数组',
        },
        overwrite: {
          type: 'boolean',
          description: '是否覆盖源文件；缺省 false（另存新文件）',
        },
      },
      required: ['path', 'commands'],
      additionalProperties: false,
    },
    sensitivity: 'confirm',
    execute: async (input, ctx): Promise<ToolResult> => {
      const record = asRecord(input)
      const path = readNonEmptyString(record, 'path')
      if (path === undefined) {
        return failure('缺少参数 path（要编辑的 Office 文件路径）。', '缺少 path 参数')
      }
      const commands = validateBatchCommands(
        record?.['commands'],
        maxCommands,
        maxCommandsBytes,
        true,
      )
      if (!commands.ok) return failure(commands.error, commands.summary)
      const saveAs = readOptionalString(record, 'saveAs')
      try {
        const absoluteSource = await office.resolve(path, outsideGuard(ctx))
        const unread = requireRead(readTracker, ctx.sessionId, absoluteSource)
        if (unread !== undefined) return unread
        const result = await office.edit({
          path,
          ...(saveAs === undefined ? {} : { saveAs }),
          overwrite: record?.['overwrite'] === true,
          commands: commands.value,
          ...outsideGuard(ctx),
          ...(ctx.sessionId === undefined || ctx.sessionId === ''
            ? {}
            : { sessionId: ctx.sessionId }),
          ...(ctx.toolCallId === undefined ? {} : { toolCallId: ctx.toolCallId }),
        })
        readTracker?.clear(ctx.sessionId, result.sourcePath)
        readTracker?.clear(ctx.sessionId, result.absolutePath)
        return describeWriteResult(result)
      } catch (error) {
        return failure(`编辑 Office 文件失败：${describeError(error)}`, '编辑 Office 文件失败')
      }
    },
  }
}

function createOfficeRenderTool(office: OfficePort): ToolDefinition {
  return {
    name: OFFICE_RENDER_TOOL_NAME,
    description:
      '把 Office 文件渲染成 PNG 或 HTML 供你看版式。screenshot 默认最多返回 6 页图片并直接附在工具结果里；大文件用 pageStart/pageEnd 或 grid。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要渲染的 Office 文件路径' },
        mode: { type: 'string', enum: ['screenshot', 'html'], description: '缺省 screenshot' },
        target: {
          type: 'string',
          description: '可选：XLSX 单元格范围（Sheet1!A1:D20）或元素路径，截取该区域',
        },
        pageStart: { type: 'integer', minimum: 1, description: '起始页/幻灯片' },
        pageEnd: { type: 'integer', minimum: 1, description: '结束页/幻灯片' },
        grid: { type: 'integer', minimum: 1, maximum: 6, description: '可选：缩略图网格列数' },
        maxPages: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'screenshot 最多返回图片数；缺省 6',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    sensitivity: 'safe',
    execute: async (input, ctx): Promise<ToolResult> => {
      const record = asRecord(input)
      const path = readNonEmptyString(record, 'path')
      if (path === undefined) return failure('缺少参数 path。', '缺少 path 参数')
      const mode = readEnum(record?.['mode'], ['screenshot', 'html'] as const, 'screenshot')
      if (mode === undefined) return failure('mode 只能是 screenshot / html。', 'mode 参数非法')
      const target = readOptionalString(record, 'target')
      const pageStart = readOptionalPositiveInt(record, 'pageStart')
      const pageEnd = readOptionalPositiveInt(record, 'pageEnd')
      if (pageStart !== undefined && pageEnd !== undefined && pageEnd < pageStart) {
        return failure('pageEnd 不能小于 pageStart。', '页码范围非法')
      }
      const grid = readOptionalPositiveInt(record, 'grid')
      if (grid !== undefined && grid > 6) {
        return failure('grid 最大为 6。', 'grid 参数非法')
      }
      const maxPages = readOptionalInt(record, 'maxPages', DEFAULT_OFFICE_RENDER_PAGES, 1, 20)
      try {
        const result = await office.render({
          path,
          mode,
          ...(target === undefined ? {} : { target }),
          ...(pageStart === undefined ? {} : { pageStart }),
          ...(pageEnd === undefined ? {} : { pageEnd }),
          ...(grid === undefined ? {} : { grid }),
          maxPages,
          ...outsideGuard(ctx),
          ...(ctx.sessionId === undefined || ctx.sessionId === ''
            ? {}
            : { sessionId: ctx.sessionId }),
        })
        const detail =
          result.files.length === 0
            ? '未生成文件。'
            : `输入：${result.sourcePath}\n输出：${result.files.join('\n')}`
        return {
          content: `${detail}${describeWarnings(result.warnings)}`,
          summary:
            mode === 'screenshot'
              ? `Office 已渲染 ${result.images.length} 张截图`
              : 'Office 已生成 HTML',
          ...(result.images.length === 0 ? {} : { images: result.images }),
        }
      } catch (error) {
        return failure(`渲染 Office 文件失败：${describeError(error)}`, '渲染 Office 文件失败')
      }
    },
  }
}

function createOfficePdfTool(office: OfficePort): ToolDefinition {
  return {
    name: OFFICE_PDF_TOOL_NAME,
    description: [
      '把 DOCX / XLSX / PPTX 导出为 PDF。',
      '实现为逐页/逐工作表截图后用 pdf-lib 合成页面图，文字不可选择；版式和页数稳定，不依赖本机 Office。',
      '默认写到同目录同名 .pdf；覆盖已有 PDF 时必须显式传 overwrite=true 并先保存快照。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要导出的 Office 文件路径' },
        outputPath: { type: 'string', description: '可选：PDF 输出路径；缺省为同目录同名 .pdf' },
        pageStart: { type: 'integer', minimum: 1, description: '可选：起始页/幻灯片' },
        pageEnd: { type: 'integer', minimum: 1, description: '可选：结束页/幻灯片' },
        overwrite: { type: 'boolean', description: '是否覆盖已有 PDF；缺省 false' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    sensitivity: 'confirm',
    execute: async (input, ctx): Promise<ToolResult> => {
      const record = asRecord(input)
      const path = readNonEmptyString(record, 'path')
      if (path === undefined) return failure('缺少参数 path。', '缺少 path 参数')
      const outputPath = readOptionalString(record, 'outputPath')
      const pageStart = readOptionalPositiveInt(record, 'pageStart')
      const pageEnd = readOptionalPositiveInt(record, 'pageEnd')
      if (pageStart !== undefined && pageEnd !== undefined && pageEnd < pageStart) {
        return failure('pageEnd 不能小于 pageStart。', '页码范围非法')
      }
      try {
        const result = await office.pdf({
          path,
          ...(outputPath === undefined ? {} : { outputPath }),
          overwrite: record?.['overwrite'] === true,
          ...(pageStart === undefined ? {} : { pageStart }),
          ...(pageEnd === undefined ? {} : { pageEnd }),
          ...outsideGuard(ctx),
          ...(ctx.sessionId === undefined || ctx.sessionId === ''
            ? {}
            : { sessionId: ctx.sessionId }),
          ...(ctx.toolCallId === undefined ? {} : { toolCallId: ctx.toolCallId }),
        })
        return {
          content: `已导出 PDF：${result.absolutePath}（${result.pages} 页，${result.bytes} 字节；源文件：${result.sourcePath}）${describeSnapshot(result.snapshot)}${describeWarnings(result.warnings)}`,
          summary: `已导出 PDF（${result.pages} 页）`,
        }
      } catch (error) {
        return failure(`导出 PDF 失败：${describeError(error)}`, '导出 PDF 失败')
      }
    },
  }
}

function createOfficeRawEditTool(
  office: OfficePort,
  readTracker: ReadTracker | undefined,
  maxBytes: number,
): ToolDefinition {
  return {
    name: OFFICE_RAW_EDIT_TOOL_NAME,
    description: [
      '高风险 raw XML 编辑。仅在用户明确要求或确认 L2 结构化能力不足时使用。',
      '修改前必须先用 office_read；每次操作必须给出 part、XPath、action，且写后自动 validate，失败整批回滚。',
      '普通 office_edit 不会调用 raw-set，也不得在结构化工具失败后自动改走本工具。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要修改的 Office 文件路径' },
        saveAs: { type: 'string', description: '可选：另存为路径' },
        rawOperations: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_OFFICE_RAW_OPERATIONS,
          items: {
            type: 'object',
            properties: {
              part: { type: 'string' },
              xpath: { type: 'string' },
              action: { type: 'string', enum: [...RAW_ACTIONS] },
              xml: { type: 'string' },
            },
            required: ['part', 'xpath', 'action'],
            additionalProperties: false,
          },
        },
        overwrite: { type: 'boolean', description: '是否覆盖源文件；缺省 false' },
      },
      required: ['path', 'rawOperations'],
      additionalProperties: false,
    },
    sensitivity: 'confirm',
    execute: async (input, ctx): Promise<ToolResult> => {
      const record = asRecord(input)
      const path = readNonEmptyString(record, 'path')
      if (path === undefined) return failure('缺少参数 path。', '缺少 path 参数')
      const operations = validateRawOperations(record?.['rawOperations'])
      if (!operations.ok) return failure(operations.error, operations.summary)
      if (Buffer.byteLength(JSON.stringify(operations.value), 'utf8') > maxBytes) {
        return failure(
          `rawOperations 序列化后超过 ${Math.round(maxBytes / 1024 / 1024)} MiB。`,
          'rawOperations 过大',
        )
      }
      const saveAs = readOptionalString(record, 'saveAs')
      try {
        const absoluteSource = await office.resolve(path, outsideGuard(ctx))
        const unread = requireRead(readTracker, ctx.sessionId, absoluteSource)
        if (unread !== undefined) return unread
        const result = await office.rawEdit({
          path,
          ...(saveAs === undefined ? {} : { saveAs }),
          overwrite: record?.['overwrite'] === true,
          operations: operations.value,
          ...outsideGuard(ctx),
          ...(ctx.sessionId === undefined || ctx.sessionId === ''
            ? {}
            : { sessionId: ctx.sessionId }),
          ...(ctx.toolCallId === undefined ? {} : { toolCallId: ctx.toolCallId }),
        })
        readTracker?.clear(ctx.sessionId, result.sourcePath)
        readTracker?.clear(ctx.sessionId, result.absolutePath)
        return describeWriteResult(result)
      } catch (error) {
        return failure(`raw XML 编辑失败：${describeError(error)}`, 'raw XML 编辑失败')
      }
    },
  }
}

function requireRead(
  readTracker: ReadTracker | undefined,
  sessionId: string,
  absolutePath: string,
): ToolResult | undefined {
  if (readTracker === undefined || readTracker.has(sessionId, absolutePath)) return undefined
  return failure(
    `修改前必须先用 office_read 读过 ${absolutePath}（本会话尚未读过该文件）。`,
    '未读过该 Office 文件',
  )
}

function describeWriteResult(result: OfficeWriteResult): ToolResult {
  const mode = result.absolutePath === result.sourcePath ? '已覆盖源文件' : '已另存'
  return {
    content: `${mode}：${result.absolutePath}（源文件：${result.sourcePath}，${result.bytes} 字节）${describeSnapshot(result.snapshot)}${describeWarnings(result.warnings)}`,
    summary: mode === '已另存' ? 'Office 已另存新文件' : 'Office 文件已覆盖',
  }
}

function validateBatchCommands(
  value: unknown,
  maxCommands: number,
  maxBytes: number,
  requireNonEmpty = false,
): { ok: true; value: OfficeBatchCommand[] } | { ok: false; error: string; summary: string } {
  if (value === undefined && !requireNonEmpty) return { ok: true, value: [] }
  if (!Array.isArray(value)) {
    return { ok: false, error: 'commands 必须是数组。', summary: 'commands 参数非法' }
  }
  if (requireNonEmpty && value.length === 0) {
    return { ok: false, error: 'commands 不能为空。', summary: 'commands 参数非法' }
  }
  if (value.length > maxCommands) {
    return {
      ok: false,
      error: `commands 最多 ${maxCommands} 条。`,
      summary: 'commands 过多',
    }
  }
  const commands: OfficeBatchCommand[] = []
  for (const [index, raw] of value.entries()) {
    const command = asRecord(raw)
    if (command === undefined) {
      return {
        ok: false,
        error: `第 ${index + 1} 条命令不是对象。`,
        summary: 'commands 参数非法',
      }
    }
    const name = readNonEmptyString(command, 'command')
    if (name === undefined || !['set', 'add', 'remove', 'move', 'swap'].includes(name)) {
      return {
        ok: false,
        error: `第 ${index + 1} 条命令只允许 set/add/remove/move/swap。raw-set 必须使用 office_raw_edit。`,
        summary: 'commands 含不支持的命令',
      }
    }
    const invalid = validateCommandShape(name, command)
    if (invalid !== undefined) {
      return {
        ok: false,
        error: `第 ${index + 1} 条命令无效：${invalid}`,
        summary: 'commands 参数非法',
      }
    }
    commands.push(command)
  }
  const bytes = Buffer.byteLength(JSON.stringify(commands), 'utf8')
  if (bytes > maxBytes) {
    return {
      ok: false,
      error: `commands 序列化后超过 ${Math.round(maxBytes / 1024 / 1024)} MiB。`,
      summary: 'commands 过大',
    }
  }
  return { ok: true, value: commands }
}

function validateCommandShape(name: string, command: Record<string, unknown>): string | undefined {
  if (name === 'set' && readNonEmptyString(command, 'path') === undefined) return 'set 缺少 path'
  if (name === 'remove' && readNonEmptyString(command, 'path') === undefined) {
    return 'remove 缺少 path'
  }
  if (name === 'move' && readNonEmptyString(command, 'path') === undefined) return 'move 缺少 path'
  if (name === 'swap') {
    if (readNonEmptyString(command, 'path') === undefined) return 'swap 缺少 path'
    if (readNonEmptyString(command, 'path2') === undefined) return 'swap 缺少 path2'
  }
  if (name === 'add') {
    const parent = readNonEmptyString(command, 'parent')
    const fallbackPath = readNonEmptyString(command, 'path')
    if (parent === undefined && fallbackPath === undefined) return 'add 缺少 parent'
    if (readNonEmptyString(command, 'type') === undefined) return 'add 缺少 type'
  }
  if (command['props'] !== undefined && asRecord(command['props']) === undefined) {
    return 'props 必须是对象'
  }
  return undefined
}

function validateRawOperations(
  value: unknown,
): { ok: true; value: OfficeRawOperation[] } | { ok: false; error: string; summary: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: 'rawOperations 必须是非空数组。', summary: 'rawOperations 参数非法' }
  }
  if (value.length > MAX_OFFICE_RAW_OPERATIONS) {
    return {
      ok: false,
      error: `rawOperations 最多 ${MAX_OFFICE_RAW_OPERATIONS} 条。`,
      summary: 'rawOperations 过多',
    }
  }
  const operations: OfficeRawOperation[] = []
  for (const [index, raw] of value.entries()) {
    const item = asRecord(raw)
    const part = readNonEmptyString(item, 'part')
    const xpath = readNonEmptyString(item, 'xpath')
    const action = readEnum(item?.['action'], RAW_ACTIONS, undefined)
    const xml = readOptionalString(item, 'xml')
    if (part === undefined || xpath === undefined || action === undefined) {
      return {
        ok: false,
        error: `第 ${index + 1} 条 rawOperations 缺少 part/xpath/action。`,
        summary: 'rawOperations 参数非法',
      }
    }
    if (!['remove', 'delete'].includes(action) && xml === undefined) {
      return {
        ok: false,
        error: `第 ${index + 1} 条 rawOperations 的 ${action} 需要 xml。`,
        summary: 'rawOperations 缺少 xml',
      }
    }
    operations.push({ part, xpath, action, ...(xml === undefined ? {} : { xml }) })
  }
  return { ok: true, value: operations }
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
  return asRecord(value)
}

function readFormat(value: unknown): OfficeFormat | undefined {
  return value === 'docx' || value === 'xlsx' || value === 'pptx' ? value : undefined
}

function readEnum<T extends string>(
  value: unknown,
  values: readonly T[],
  fallback: T,
): T | undefined
function readEnum<T extends string>(
  value: unknown,
  values: readonly T[],
  fallback: undefined,
): T | undefined
function readEnum<T extends string>(
  value: unknown,
  values: readonly T[],
  fallback: T | undefined,
): T | undefined {
  if (value === undefined) return fallback
  return typeof value === 'string' && values.includes(value as T) ? (value as T) : undefined
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

function readOptionalPositiveInt(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return undefined
  return Math.floor(value)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
