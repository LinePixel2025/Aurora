/**
 * 文档内容提取（docs/05 §3.2）。
 *
 * 设计约束：
 * - **不 import electron**，可在单测里直接调用（T0 已验证 officeparser 在 Electron
 *   utilityProcess 内可用，Node 20.18 + pdfjs-dist 6 的 ESM 动态 import 正常）。
 * - 任何提取失败都**降级为「文件名 + 元数据」证据**，绝不抛错、绝不中断分类管线。
 * - 证据上限 8KB（docs/05 §3.2），按 head/tail 采样，避免把成本花在首尾重复的页眉上。
 */

export type EvidenceKind = 'text' | 'document' | 'image' | 'archive' | 'binary' | 'unknown'

export interface ExtractResult {
  kind: EvidenceKind
  /** 送给模型的证据文本（已按 head/tail 截断） */
  evidence: string
  /** 证据字符数（截断前） */
  evidenceChars: number
  /** 提取过程中的告警（如解析器报错后退化） */
  warnings: string[]
  /** `docx/pptx` 等 OOXML 内嵌、可交给视觉模型分析的图片（已在上限内）。 */
  documentImages: ExtractedDocumentImage[]
}

export interface ExtractedDocumentImage {
  name: string
  mimeType: string
  extension: string
  dataBase64: string
  altText?: string
}

/** 证据上限 8KB（docs/05 §3.2「证据大小上限 8KB，控制成本与耗时」） */
export const EVIDENCE_LIMIT_BYTES = 8 * 1024

/** 单次文件自感知分析最多送入模型的图片数 / 单张与合计原始字节上限。 */
export const MAX_DOCUMENT_IMAGES = 8
export const MAX_DOCUMENT_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_DOCUMENT_IMAGE_TOTAL_BYTES = 24 * 1024 * 1024

/** 纯文本格式：我们自己读，officeparser 不支持这些扩展名 */
const PLAIN_TEXT_EXT = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'xml',
  'yaml',
  'yml',
  'log',
  'tex',
  'srt',
  'vtt',
])

/** 交给 officeparser 的扩展名（与 T0 spike 实测的支持集一致） */
const OFFICE_EXT = new Set([
  'docx',
  'pptx',
  'xlsx',
  'odt',
  'odp',
  'ods',
  'pdf',
  'rtf',
  'html',
  'htm',
  'epub',
  // csv/md 同时在 PLAIN_TEXT_EXT 里——优先走自己的读取器（更快、不依赖解析器）
])

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'svg'])
const ARCHIVE_EXT = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'])
/** 老式二进制 Office：无零依赖解析方案，只给文件名 + 类型说明 */
const LEGACY_OFFICE_EXT = new Set(['doc', 'ppt', 'xls'])

export interface ExtractInput {
  /** 文件绝对路径 */
  path: string
  /** 小写扩展名（不含点） */
  ext: string
  /** 字节数 */
  sizeBytes: number
  /** 读取文件内容（注入以便单测；worker 内传 fs 实现） */
  readFile(path: string): Promise<Buffer>
  /** 调用 officeparser（注入以便单测；worker 内传 require 实现） */
  parseOffice?(path: string): Promise<OfficeParseResult>
}

interface OfficeAttachmentLike {
  type?: string
  mimeType?: string
  data?: string
  name?: string
  extension?: string
  altText?: string
}

interface OfficeParseResult {
  toText(): string
  to?(format: 'text'): Promise<{ value: string } | string>
  attachments?: OfficeAttachmentLike[]
}

export async function extract(input: ExtractInput): Promise<ExtractResult> {
  const { path, ext, sizeBytes } = input
  const warnings: string[] = []
  const fileName = baseName(path)

  const header = [
    `文件名：${fileName}`,
    `类型：${ext === '' ? '无扩展名' : `.${ext}`}`,
    `大小：${formatBytes(sizeBytes)}`,
  ].join('\n')

  // 1. 纯文本：直接读，编码嗅探
  if (PLAIN_TEXT_EXT.has(ext)) {
    try {
      const buffer = await input.readFile(path)
      const text = decodeText(buffer)
      return finalize('text', `${header}\n\n正文：\n${normalizeWhitespace(text)}`, warnings)
    } catch (error) {
      warnings.push(`读取文本失败：${describe(error)}`)
      return finalize('text', header, warnings)
    }
  }

  // 2. 图片：文件名 + 元数据（OCR 为 P1 可选，见 docs/05 §3.2；本轮不启用）
  if (IMAGE_EXT.has(ext)) {
    try {
      const buffer = await input.readFile(path)
      const dimensions = readImageSize(buffer, ext)
      const lines = [header]
      if (dimensions) lines.push(`尺寸：${dimensions.width}×${dimensions.height}`)
      lines.push('（图片仅提供文件名与元数据；OCR 未启用）')
      return finalize('image', lines.join('\n'), warnings)
    } catch (error) {
      warnings.push(`读取图片元数据失败：${describe(error)}`)
      return finalize('image', header, warnings)
    }
  }

  // 3. 压缩包：文件名 + 条目清单（只读 zip 目录区，不解压）
  if (ARCHIVE_EXT.has(ext)) {
    const lines = [header]
    if (ext === 'zip') {
      try {
        const buffer = await input.readFile(path)
        const entries = listZipEntries(buffer).slice(0, 40)
        if (entries.length > 0) {
          lines.push(`包含 ${entries.length} 个条目：`, ...entries.map((name) => `- ${name}`))
        }
      } catch (error) {
        warnings.push(`读取压缩包目录失败：${describe(error)}`)
      }
    }
    return finalize('archive', lines.join('\n'), warnings)
  }

  // 4. 老式二进制 Office：提示用文件名判断
  if (LEGACY_OFFICE_EXT.has(ext)) {
    warnings.push(`.${ext} 为老式二进制格式，无法抽取正文`)
    return finalize(
      'binary',
      `${header}\n（老式二进制 Office 格式，请依据文件名判断科目）`,
      warnings,
    )
  }

  // 5. Office / PDF：交给 officeparser
  if (OFFICE_EXT.has(ext) || input.parseOffice !== undefined) {
    if (input.parseOffice === undefined) {
      warnings.push('解析器不可用，降级为文件名证据')
      return finalize('document', header, warnings)
    }
    try {
      const parsed = await input.parseOffice(path)
      const text = normalizeWhitespace(await officeTextOf(parsed))
      const collected = collectDocumentImages(parsed.attachments ?? [], warnings)
      const imageSection = renderDocumentImageEvidence(collected)
      if (text.trim() === '' && collected.images.length === 0 && collected.total === 0) {
        warnings.push('解析结果为空，降级为文件名证据')
        return finalize('document', header, warnings)
      }
      const body: string[] = [header]
      if (text.trim() !== '') body.push('', '正文：', text)
      if (imageSection !== '') body.push('', imageSection)
      return finalize('document', body.join('\n'), warnings, collected.images)
    } catch (error) {
      warnings.push(`解析失败，降级为文件名证据：${describe(error)}`)
      return finalize('document', header, warnings)
    }
  }

  // 6. 其他：只给文件名 + 元数据
  return finalize('unknown', header, warnings)
}

/** 拼装结果并按 8KB 上限做 head/tail 截断。 */
function finalize(
  kind: EvidenceKind,
  evidence: string,
  warnings: string[],
  documentImages: ExtractedDocumentImage[] = [],
): ExtractResult {
  const evidenceChars = evidence.length
  return {
    kind,
    evidence: truncateEvidence(evidence, EVIDENCE_LIMIT_BYTES),
    evidenceChars,
    warnings,
    documentImages,
  }
}

async function officeTextOf(parsed: OfficeParseResult): Promise<string> {
  if (parsed.to !== undefined) {
    const converted = await parsed.to('text')
    if (typeof converted === 'string') return converted
    if (typeof converted.value === 'string') return converted.value
  }
  return parsed.toText()
}

const DOCUMENT_IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
}

function collectDocumentImages(
  attachments: readonly OfficeAttachmentLike[],
  warnings: string[],
): {
  total: number
  images: ExtractedDocumentImage[]
  lines: string[]
} {
  const imageAttachments = attachments.filter((item) => {
    const mime = (item.mimeType ?? '').toLowerCase()
    return item.type === 'image' || mime.startsWith('image/')
  })
  const images: ExtractedDocumentImage[] = []
  const lines: string[] = []
  let totalBytes = 0

  for (const [index, attachment] of imageAttachments.entries()) {
    const name = (attachment.name ?? `image-${index + 1}`).trim() || `image-${index + 1}`
    const mime = (attachment.mimeType ?? '').toLowerCase()
    const extension = DOCUMENT_IMAGE_EXTENSIONS[mime]
    const alt = (attachment.altText ?? '').trim()
    const label = alt === '' ? name : `${name}（${alt}）`
    const dataBase64 = normalizeBase64(attachment.data ?? '')

    if (extension === undefined) {
      const reason = `不支持视觉模型输入（${mime || attachment.extension || '未知格式'}）`
      lines.push(`- ${label}：未读取（${reason}）`)
      warnings.push(`内嵌图片 ${name} ${reason}`)
      continue
    }
    if (dataBase64 === '') {
      lines.push(`- ${label}：未读取（图片数据为空或缺失）`)
      warnings.push(`内嵌图片 ${name} 数据为空，已跳过`)
      continue
    }
    const bytes = base64ByteLength(dataBase64)
    if (bytes > MAX_DOCUMENT_IMAGE_BYTES) {
      lines.push(`- ${label}：未读取（超过 8 MiB）`)
      warnings.push(`内嵌图片 ${name} 超过 8 MiB，已跳过`)
      continue
    }
    if (images.length >= MAX_DOCUMENT_IMAGES) {
      lines.push(`- ${label}：未读取（单次最多分析 ${MAX_DOCUMENT_IMAGES} 张）`)
      warnings.push(`内嵌图片 ${name} 因数量上限未读取`)
      continue
    }
    if (totalBytes + bytes > MAX_DOCUMENT_IMAGE_TOTAL_BYTES) {
      lines.push(`- ${label}：未读取（本次图片总量超过 24 MiB）`)
      warnings.push(`内嵌图片 ${name} 因总量上限未读取`)
      continue
    }
    totalBytes += bytes
    images.push({
      name,
      mimeType: mime,
      extension,
      dataBase64,
      ...(alt === '' ? {} : { altText: alt }),
    })
    lines.push(`- ${label}：已提取，随本次请求交给视觉模型`)
  }

  return { total: imageAttachments.length, images, lines }
}

function renderDocumentImageEvidence(input: {
  total: number
  images: ExtractedDocumentImage[]
  lines: string[]
}): string {
  if (input.total === 0) return ''
  return [`内嵌图片：${input.total} 张，本次读取 ${input.images.length} 张`, ...input.lines].join(
    '\n',
  )
}

function normalizeBase64(value: string): string {
  const comma = value.indexOf(',')
  return (comma >= 0 ? value.slice(comma + 1) : value).replace(/\s+/g, '')
}

function base64ByteLength(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding)
}

/**
 * 按**字节**上限截断：保留头部 70% + 尾部 30%。
 * 只保留头部会丢掉最关键的结论性文字（如文末的「参考答案」），
 * 只保留尾部会丢掉标题里最直接的科目线索。
 */
export function truncateEvidence(text: string, limitBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= limitBytes) return text

  const headBytes = Math.floor(limitBytes * 0.7)
  const tailBytes = limitBytes - headBytes
  const head = safeSlice(buffer, 0, headBytes)
  const tail = safeSlice(buffer, buffer.length - tailBytes, buffer.length)
  const omitted = buffer.length - Buffer.byteLength(head) - Buffer.byteLength(tail)
  return `${head}\n\n…（此处省略约 ${omitted} 字节）…\n\n${tail}`
}

/** 按 UTF-8 边界安全切片，避免切出半个多字节字符（U+FFFD）。 */
function safeSlice(buffer: Buffer, start: number, end: number): string {
  let from = Math.max(0, start)
  let to = Math.min(buffer.length, end)
  // 向后找到合法的起始字节（非 10xxxxxx）
  while (from < to && (buffer[from]! & 0xc0) === 0x80) from += 1
  // 向前退到合法的结束位置，避免末尾留下不完整序列
  while (to > from && (buffer[to - 1]! & 0xc0) === 0x80) to -= 1
  if (to > from && (buffer[to - 1]! & 0x80) !== 0) {
    // 末尾是多字节序列的首字节，退掉它（由 Buffer.toString 的容忍度兜底）
    to -= 1
  }
  return buffer.subarray(from, to).toString('utf8')
}

/**
 * 编码嗅探：优先 UTF-8（含 BOM 判定），失败后回退 GBK（Windows 中文环境常见）。
 * GBK 的解码交给调用环境（Node 的 TextDecoder 支持 gbk），不可用时退回 latin1 保底。
 */
export function decodeText(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8')
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le')
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    // UTF-16BE：Node 无内建解码，手工交换字节后按 LE 解
    const swapped = Buffer.from(buffer.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }

  const utf8 = buffer.toString('utf8')
  // U+FFFD 出现说明不是合法 UTF-8；中文文档此时应为 GBK
  if (utf8.includes('\uFFFD')) {
    try {
      return new TextDecoder('gbk').decode(buffer)
    } catch {
      return buffer.toString('latin1')
    }
  }
  return utf8
}

/** 归一空白：压缩连续空行，但保留段落分隔（正文可读性影响模型判定质量）。 */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 只读 ZIP 中央目录，列出条目名（不解压，避免 zip 炸弹）。 */
export function listZipEntries(buffer: Buffer): string[] {
  const names: string[] = []
  const minEocd = 22
  if (buffer.length < minEocd) return names

  // 从尾部向前找 EOCD 签名 0x06054b50（注释最长 64KB）
  let eocd = -1
  const from = Math.max(0, buffer.length - 65_557)
  for (let i = buffer.length - minEocd; i >= from; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return names

  const total = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const limit = Math.min(total, 2000)

  for (let i = 0; i < limit; i += 1) {
    if (offset + 46 > buffer.length) break
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const nameStart = offset + 46
    if (nameStart + nameLength > buffer.length) break
    const name = decodeText(buffer.subarray(nameStart, nameStart + nameLength))
    // 目录条目以 / 结尾，跳过以减少噪声
    if (name !== '' && !name.endsWith('/')) names.push(name)
    offset = nameStart + nameLength + extraLength + commentLength
  }
  return names
}

/** 读取常见图片的像素尺寸（不引依赖，按文件头解析）。 */
export function readImageSize(
  buffer: Buffer,
  ext: string,
): { width: number; height: number } | undefined {
  try {
    if (ext === 'png' && buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
    }
    if ((ext === 'jpg' || ext === 'jpeg') && buffer.length >= 4 && buffer[0] === 0xff) {
      let offset = 2
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset += 1
          continue
        }
        const marker = buffer[offset + 1]!
        // SOF0..SOF15（排除 DHT/DAC/RST）
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8) {
          return {
            height: buffer.readUInt16BE(offset + 5),
            width: buffer.readUInt16BE(offset + 7),
          }
        }
        const length = buffer.readUInt16BE(offset + 2)
        if (length <= 0) break
        offset += 2 + length
      }
    }
    if (
      ext === 'gif' &&
      buffer.length >= 10 &&
      buffer.subarray(0, 3).toString('latin1') === 'GIF'
    ) {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
    }
    if (ext === 'bmp' && buffer.length >= 26 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
      return { width: buffer.readInt32LE(18), height: Math.abs(buffer.readInt32LE(22)) }
    }
  } catch {
    /* 元数据解析失败不是错误：调用方只用它做补充信息 */
  }
  return undefined
}

function baseName(path: string): string {
  const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return index < 0 ? path : path.slice(index + 1)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
