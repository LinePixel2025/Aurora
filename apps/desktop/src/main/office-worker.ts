/**
 * Office worker —— 运行在 Electron utilityProcess 中。
 *
 * 主进程只做路径边界、快照与原子替换；本文件负责结构化读取 / 生成 / patch。
 * 这里不能 import electron，也不能触发 Office COM。解析或写入失败会如实回传，
 * 不会自动降级到 PowerShell。
 */
import { promises as fs } from 'node:fs'
import { extname } from 'node:path'
import type { OfficeFormat } from '@aurora/agent-core'
import type {
  OfficeWorkerRequest,
  OfficeWorkerResponse,
  OfficeWorkerReadResult,
  OfficeWorkerWriteResult,
} from './office-protocol.js'

type UnknownRecord = Record<string, unknown>

const DOCX_BULLET_REFERENCE = 'aurora-bullets'
const DOCX_NUMBER_REFERENCE = 'aurora-numbered'
const DOCX_LIST_LEVEL_COUNT = 9
let docxListInstance = 0

interface OfficeLibs {
  docx: {
    generateDocument(options: unknown): Promise<unknown>
    patchDocument(options: UnknownRecord): Promise<unknown>
    parseDocument(data: unknown): Promise<unknown>
  }
  xlsx: {
    generateWorkbook(options: unknown): Promise<unknown>
    patchWorkbook(options: UnknownRecord): Promise<unknown>
    parseWorkbook(data: unknown): Promise<unknown>
  }
  pptx: {
    generatePresentation(options: unknown): Promise<unknown>
    patchPresentation(options: UnknownRecord): Promise<unknown>
    parsePresentation(data: unknown): Promise<unknown>
  }
}

let libsPromise: Promise<OfficeLibs> | undefined

async function loadLibs(): Promise<OfficeLibs> {
  libsPromise ??= (async () => {
    const [docx, xlsx, pptx] = await Promise.all([
      import('@office-open/docx'),
      import('@office-open/xlsx'),
      import('@office-open/pptx'),
    ])
    return {
      docx: {
        generateDocument: async (options) =>
          await (docx.generateDocument as (value: unknown) => Promise<unknown>)(options),
        patchDocument: async (options) =>
          await (docx.patchDocument as unknown as (value: UnknownRecord) => Promise<unknown>)(
            options,
          ),
        parseDocument: async (data) =>
          await (docx.parseDocument as (value: unknown) => Promise<unknown>)(data),
      },
      xlsx: {
        generateWorkbook: async (options) =>
          await (xlsx.generateWorkbook as (value: unknown) => Promise<unknown>)(options),
        patchWorkbook: async (options) =>
          await (xlsx.patchWorkbook as unknown as (value: UnknownRecord) => Promise<unknown>)(
            options,
          ),
        parseWorkbook: async (data) =>
          await (xlsx.parseWorkbook as (value: unknown) => Promise<unknown>)(data),
      },
      pptx: {
        generatePresentation: async (options) =>
          await (pptx.generatePresentation as (value: unknown) => Promise<unknown>)(options),
        patchPresentation: async (options) =>
          await (pptx.patchPresentation as unknown as (value: UnknownRecord) => Promise<unknown>)(
            options,
          ),
        parsePresentation: async (data) =>
          await (pptx.parsePresentation as (value: unknown) => Promise<unknown>)(data),
      },
    }
  })()
  return libsPromise
}

export async function handleOfficeRequest(
  request: OfficeWorkerRequest,
): Promise<OfficeWorkerResponse> {
  try {
    if (request.action === 'read') {
      const result = await readOffice(
        request.path,
        request.format,
        request.target,
        request.offset,
        request.limit,
      )
      return { id: request.id, ok: true, read: result }
    }
    if (request.action === 'create') {
      const result = await createOffice(request)
      return { id: request.id, ok: true, write: result }
    }
    const result = await editOffice(request)
    return { id: request.id, ok: true, write: result }
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }
  }
}

async function readOffice(
  path: string,
  format: OfficeFormat,
  target: string | undefined,
  offset: number,
  limit: number,
): Promise<OfficeWorkerReadResult> {
  const libs = await loadLibs()
  const data = await fs.readFile(path)
  if (format === 'docx') {
    const parsed = await libs.docx.parseDocument(data)
    return summarizeDocx(parsed, offset, limit)
  }
  if (format === 'xlsx') {
    const parsed = await libs.xlsx.parseWorkbook(data)
    return summarizeXlsx(parsed, target, offset, limit)
  }
  const parsed = await libs.pptx.parsePresentation(data)
  return summarizePptx(parsed, target, offset, limit)
}

async function createOffice(
  request: Extract<OfficeWorkerRequest, { action: 'create' }>,
): Promise<OfficeWorkerWriteResult> {
  const libs = await loadLibs()
  let output: unknown
  if (request.templatePath !== undefined) {
    const template = await fs.readFile(request.templatePath)
    output = await patchTemplate(
      libs,
      request.format,
      template,
      request.templateData ?? {},
      request.content,
    )
  } else {
    output = await generateFromContent(libs, request.format, request.content)
  }
  const bytes = toBytes(output)
  await fs.writeFile(request.outputPath, bytes)
  await validateOutput(libs, request.format, request.outputPath)
  return { bytes: bytes.byteLength, warnings: [] }
}

async function editOffice(
  request: Extract<OfficeWorkerRequest, { action: 'edit' }>,
): Promise<OfficeWorkerWriteResult> {
  const libs = await loadLibs()
  let bytes = new Uint8Array(await fs.readFile(request.sourcePath))
  const warnings: string[] = []
  for (const [index, rawOperation] of request.operations.entries()) {
    const operation = asRecord(rawOperation)
    const type = stringOf(operation?.['type'])
    if (operation === undefined || type === undefined || type === '') {
      throw new Error(`第 ${index + 1} 条操作缺少 type`)
    }
    bytes = await applyOperation(libs, request.format, bytes, type, operation, warnings)
  }
  await fs.writeFile(request.outputPath, bytes)
  await validateOutput(libs, request.format, request.outputPath)
  return { bytes: bytes.byteLength, warnings }
}

async function generateFromContent(
  libs: OfficeLibs,
  format: OfficeFormat,
  content: unknown,
): Promise<unknown> {
  const value = asRecord(content) ?? {}
  if (format === 'docx') return await libs.docx.generateDocument(await docxOptions(value))
  if (format === 'xlsx') return await libs.xlsx.generateWorkbook(xlsxOptions(value))
  return await libs.pptx.generatePresentation(await pptxOptions(value))
}

async function patchTemplate(
  libs: OfficeLibs,
  format: OfficeFormat,
  template: Uint8Array,
  templateData: Record<string, unknown>,
  appendContent: unknown,
): Promise<unknown> {
  if (format === 'docx') {
    const patched = await libs.docx.patchDocument({
      data: template,
      outputType: 'nodebuffer',
      placeholders: mapDocxPlaceholders(templateData),
    })
    return appendContent === undefined
      ? patched
      : await appendDocxChildren(libs, toBytes(patched), asRecord(appendContent) ?? {})
  }
  if (format === 'xlsx') {
    const appendSheets = asRecord(appendContent)?.['sheets']
    return await libs.xlsx.patchWorkbook({
      data: template,
      outputType: 'nodebuffer',
      placeholders: templateData,
      ...(Array.isArray(appendSheets) && appendSheets.length > 0
        ? { worksheets: { append: appendSheets.map((sheet) => xlsxSheet(asRecord(sheet) ?? {})) } }
        : {}),
    })
  }
  const appendSlides = asRecord(appendContent)?.['slides']
  return await libs.pptx.patchPresentation({
    data: template,
    outputType: 'nodebuffer',
    placeholders: mapPptxPlaceholders(templateData),
    ...(Array.isArray(appendSlides) && appendSlides.length > 0
      ? {
          slides: {
            append: await Promise.all(
              appendSlides.map((slide) => pptxSlide(asRecord(slide) ?? {})),
            ),
          },
        }
      : {}),
  })
}

async function applyOperation(
  libs: OfficeLibs,
  format: OfficeFormat,
  bytes: Uint8Array,
  type: string,
  operation: UnknownRecord,
  warnings: string[],
): Promise<Uint8Array> {
  if (format === 'docx') return await applyDocxOperation(libs, bytes, type, operation, warnings)
  if (format === 'xlsx') return await applyXlsxOperation(libs, bytes, type, operation, warnings)
  return await applyPptxOperation(libs, bytes, type, operation, warnings)
}

async function applyDocxOperation(
  libs: OfficeLibs,
  bytes: Uint8Array,
  type: string,
  operation: UnknownRecord,
  warnings: string[],
): Promise<Uint8Array> {
  if (type === 'replace_text') {
    const find = requiredString(operation, 'find')
    const replace = stringOf(operation['replace']) ?? ''
    return toBytes(
      await libs.docx.patchDocument({
        data: bytes,
        outputType: 'nodebuffer',
        findReplace: { [find]: docxPatchValue(replace) },
      }),
    )
  }
  if (type === 'set_placeholders') {
    return toBytes(
      await libs.docx.patchDocument({
        data: bytes,
        outputType: 'nodebuffer',
        placeholders: mapDocxPlaceholders(asRecord(operation['values']) ?? {}),
      }),
    )
  }
  if (type === 'append_content') {
    return await appendDocxChildren(libs, bytes, asRecord(operation['content']) ?? {})
  }
  if (type === 'replace_section') {
    const index = requiredInt(operation, 'index')
    return await replaceDocxSection(libs, bytes, index, asRecord(operation['content']) ?? {})
  }
  throw unsupportedOperation('DOCX', type, warnings)
}

async function applyXlsxOperation(
  libs: OfficeLibs,
  bytes: Uint8Array,
  type: string,
  operation: UnknownRecord,
  warnings: string[],
): Promise<Uint8Array> {
  if (type === 'replace_text') {
    const find = requiredString(operation, 'find')
    const replace = scalarOf(operation['replace'])
    return toBytes(
      await libs.xlsx.patchWorkbook({
        data: bytes,
        outputType: 'nodebuffer',
        findReplace: { [find]: replace },
      }),
    )
  }
  if (type === 'set_placeholders') {
    return toBytes(
      await libs.xlsx.patchWorkbook({
        data: bytes,
        outputType: 'nodebuffer',
        placeholders: asRecord(operation['values']) ?? {},
      }),
    )
  }
  if (type === 'append_sheets') {
    const sheets = arrayOfRecords(operation['sheets'])
    return toBytes(
      await libs.xlsx.patchWorkbook({
        data: bytes,
        outputType: 'nodebuffer',
        worksheets: { append: sheets.map((sheet) => xlsxSheet(sheet)) },
      }),
    )
  }
  if (type === 'remove_sheets') {
    const names = arrayOfStrings(operation['names'])
    if (names.length === 0) throw new Error('remove_sheets.names 不能为空')
    return toBytes(
      await libs.xlsx.patchWorkbook({
        data: bytes,
        outputType: 'nodebuffer',
        worksheets: { remove: names },
      }),
    )
  }
  if (type === 'set_cells') {
    const parsed = asRecord(await libs.xlsx.parseWorkbook(bytes))
    if (parsed === undefined) throw new Error('无法解析工作簿以设置单元格')
    for (const cell of arrayOfRecords(operation['cells'])) {
      setWorkbookCell(parsed, cell)
    }
    warnings.push(
      'set_cells 会重建工作簿；模板中的极少数未知扩展若未被解析器识别，可能在保存时被规范化。',
    )
    return toBytes(await libs.xlsx.generateWorkbook(parsed))
  }
  throw unsupportedOperation('XLSX', type, warnings)
}

async function applyPptxOperation(
  libs: OfficeLibs,
  bytes: Uint8Array,
  type: string,
  operation: UnknownRecord,
  warnings: string[],
): Promise<Uint8Array> {
  if (type === 'replace_text') {
    const find = requiredString(operation, 'find')
    const replace = stringOf(operation['replace']) ?? ''
    return toBytes(
      await libs.pptx.patchPresentation({
        data: bytes,
        outputType: 'nodebuffer',
        findReplace: { [find]: replace },
      }),
    )
  }
  if (type === 'set_placeholders') {
    return toBytes(
      await libs.pptx.patchPresentation({
        data: bytes,
        outputType: 'nodebuffer',
        placeholders: mapPptxPlaceholders(asRecord(operation['values']) ?? {}),
      }),
    )
  }
  if (type === 'append_slides') {
    const slides = await Promise.all(
      arrayOfRecords(operation['slides']).map((slide) => pptxSlide(slide)),
    )
    return toBytes(
      await libs.pptx.patchPresentation({
        data: bytes,
        outputType: 'nodebuffer',
        slides: { append: slides },
      }),
    )
  }
  if (type === 'replace_slides') {
    const replace: Record<number, unknown> = {}
    for (const item of arrayOfRecords(operation['slides'])) {
      replace[requiredInt(item, 'index')] = await pptxSlide(asRecord(item['slide']) ?? {})
    }
    return toBytes(
      await libs.pptx.patchPresentation({
        data: bytes,
        outputType: 'nodebuffer',
        slides: { replace },
      }),
    )
  }
  if (type === 'remove_slides') {
    const indexes = arrayOfNumbers(operation['indexes'])
    if (indexes.length === 0) throw new Error('remove_slides.indexes 不能为空')
    return toBytes(
      await libs.pptx.patchPresentation({
        data: bytes,
        outputType: 'nodebuffer',
        slides: { remove: indexes },
      }),
    )
  }
  throw unsupportedOperation('PPTX', type, warnings)
}

function unsupportedOperation(format: string, type: string, warnings: string[]): Error {
  warnings.push(`${format} 不支持操作 ${type}`)
  return new Error(`${format} 不支持操作 ${type}；请改用支持的结构化操作或由用户明确要求 COM 兜底`)
}

async function validateOutput(libs: OfficeLibs, format: OfficeFormat, path: string): Promise<void> {
  const data = await fs.readFile(path)
  if (format === 'docx') {
    await libs.docx.parseDocument(data)
    return
  }
  if (format === 'xlsx') {
    await libs.xlsx.parseWorkbook(data)
    return
  }
  await libs.pptx.parsePresentation(data)
}

async function docxOptions(content: UnknownRecord): Promise<UnknownRecord> {
  return {
    ...(typeof content['title'] === 'string' ? { title: content['title'] } : {}),
    sections: [{ children: await docxChildren(content) }],
    numbering: docxNumberingOptions(),
  }
}

async function docxChildren(content: UnknownRecord): Promise<unknown[]> {
  const children: unknown[] = []
  if (typeof content['title'] === 'string' && content['title'].trim() !== '') {
    children.push({
      paragraph: {
        heading: 'Heading1',
        children: [{ text: content['title'], bold: true, size: 40 }],
      },
    })
  }
  let pageBreakBefore = false
  for (const rawBlock of Array.isArray(content['blocks']) ? content['blocks'] : []) {
    const block = asRecord(rawBlock)
    if (block === undefined) continue
    const type = stringOf(block['type'])
    if (type === 'pageBreak') {
      pageBreakBefore = true
      continue
    }
    const paragraphOptions: UnknownRecord = pageBreakBefore ? { pageBreakBefore: true } : {}
    pageBreakBefore = false
    if (type === 'heading') {
      const level = clampInt(block['level'], 1, 6, 1)
      children.push({
        paragraph: {
          ...paragraphOptions,
          heading: `Heading${level}`,
          children: [{ text: stringOf(block['text']) ?? '' }],
        },
      })
      continue
    }
    if (type === 'paragraph') {
      children.push({
        paragraph: { ...paragraphOptions, children: [{ text: stringOf(block['text']) ?? '' }] },
      })
      continue
    }
    if (type === 'bullets' || type === 'numbered') {
      const items = arrayOfStrings(block['items'])
      const level = clampInt(block['level'], 0, DOCX_LIST_LEVEL_COUNT - 1, 0)
      const instance = docxListInstance++
      for (const item of items) {
        children.push({
          paragraph: {
            ...(pageBreakBefore ? { pageBreakBefore: true } : {}),
            numbering: {
              reference: type === 'bullets' ? DOCX_BULLET_REFERENCE : DOCX_NUMBER_REFERENCE,
              level,
              instance,
            },
            children: [{ text: item }],
          },
        })
        pageBreakBefore = false
      }
      continue
    }
    if (type === 'table') {
      const headers = Array.isArray(block['headers']) ? block['headers'] : []
      const rows = Array.isArray(block['rows']) ? block['rows'] : []
      children.push({
        table: {
          rows: [headers, ...rows].map((row) => ({
            cells: (Array.isArray(row) ? row : []).map((cell) => ({
              children: [{ paragraph: String(cell ?? '') }],
            })),
          })),
        },
      })
      continue
    }
    if (type === 'image') {
      const path = stringOf(block['path'])
      if (path !== undefined) {
        children.push({ paragraph: { children: await docxPicture(path, block) } })
      }
    }
  }
  if (pageBreakBefore) {
    children.push({ paragraph: { pageBreakBefore: true, children: [] } })
  }
  return children
}

async function appendDocxChildren(
  libs: OfficeLibs,
  bytes: Uint8Array,
  content: UnknownRecord,
): Promise<Uint8Array> {
  const document = await parseDocx(libs, bytes)
  const sections = Array.isArray(document['sections']) ? document['sections'] : []
  const children = await docxChildren(content)
  if (sections.length === 0) {
    sections.push({ children })
  } else {
    const index = sections.length - 1
    const section = asRecord(sections[index]) ?? {}
    section['children'] = [
      ...(Array.isArray(section['children']) ? section['children'] : []),
      ...children,
    ]
    sections[index] = section
  }
  document['sections'] = sections
  return toBytes(await libs.docx.generateDocument(withDocxNumbering(document)))
}

async function replaceDocxSection(
  libs: OfficeLibs,
  bytes: Uint8Array,
  index: number,
  content: UnknownRecord,
): Promise<Uint8Array> {
  const document = await parseDocx(libs, bytes)
  const sections = Array.isArray(document['sections']) ? document['sections'] : []
  if (index < 0 || index >= sections.length) {
    throw new Error(`DOCX section 不存在：${index}（当前共 ${sections.length} 节）`)
  }
  const section = asRecord(sections[index]) ?? {}
  section['children'] = await docxChildren(content)
  sections[index] = section
  document['sections'] = sections
  return toBytes(await libs.docx.generateDocument(withDocxNumbering(document)))
}

async function parseDocx(libs: OfficeLibs, bytes: Uint8Array): Promise<UnknownRecord> {
  const parsed = asRecord(await libs.docx.parseDocument(bytes))
  if (parsed === undefined) throw new Error('DOCX 解析结果不是对象')
  return parsed
}

function withDocxNumbering(document: UnknownRecord): UnknownRecord {
  return { ...document, numbering: mergeDocxNumbering(document['numbering']) }
}

function mergeDocxNumbering(existing: unknown): UnknownRecord {
  const numbering = asRecord(existing) ?? {}
  const current = arrayOfRecords(numbering['abstractNumberings']).filter(
    (item) =>
      item['reference'] !== DOCX_BULLET_REFERENCE && item['reference'] !== DOCX_NUMBER_REFERENCE,
  )
  return {
    ...numbering,
    abstractNumberings: [...current, ...docxNumberingDefinitions()],
  }
}

function docxNumberingOptions(): UnknownRecord {
  return { abstractNumberings: docxNumberingDefinitions() }
}

function docxNumberingDefinitions(): UnknownRecord[] {
  const bulletCharacters = ['•', '○', '▪']
  return [
    {
      reference: DOCX_BULLET_REFERENCE,
      properties: { multiLevelType: 'hybridMultilevel' },
      levels: Array.from({ length: DOCX_LIST_LEVEL_COUNT }, (_, level) => ({
        level,
        format: 'bullet',
        text: bulletCharacters[level % bulletCharacters.length] ?? '•',
        alignment: 'left',
        suffix: 'tab',
        paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } },
      })),
    },
    {
      reference: DOCX_NUMBER_REFERENCE,
      properties: { multiLevelType: 'multilevel' },
      levels: Array.from({ length: DOCX_LIST_LEVEL_COUNT }, (_, level) => ({
        level,
        format: 'decimal',
        text: `%${level + 1}.`,
        alignment: 'left',
        suffix: 'tab',
        paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } },
      })),
    },
  ]
}

async function docxPicture(path: string, block: UnknownRecord): Promise<unknown[]> {
  const extension = normalizeImageType(path)
  return [
    {
      picture: {
        data: await readImage(path),
        type: extension,
        transformation: {
          width: stringOf(block['width']) ?? '8cm',
          height: stringOf(block['height']) ?? '6cm',
        },
      },
    },
  ]
}

function xlsxOptions(content: UnknownRecord): UnknownRecord {
  const worksheets = Array.isArray(content['sheets']) ? content['sheets'] : []
  return {
    ...(typeof content['title'] === 'string' ? { title: content['title'] } : {}),
    worksheets: worksheets.map((sheet) => xlsxSheet(asRecord(sheet) ?? {})),
  }
}

function xlsxSheet(sheet: UnknownRecord): UnknownRecord {
  const name = stringOf(sheet['name']) ?? 'Sheet1'
  const rows = Array.isArray(sheet['rows']) ? sheet['rows'] : []
  return {
    name,
    rows: rows.map((rawRow) => ({
      cells: (Array.isArray(rawRow) ? rawRow : []).map(xlsxCell),
    })),
  }
}

function xlsxCell(value: unknown): UnknownRecord {
  if (value === null || value === undefined) return { value: null }
  if (typeof value !== 'object' || Array.isArray(value)) return { value }
  const cell = value as UnknownRecord
  const out: UnknownRecord = { value: cell['value'] ?? null }
  const formula = cell['formula']
  if (typeof formula === 'string') out['formula'] = { formula, value: cell['value'] ?? 0 }
  else if (typeof formula === 'object' && formula !== null) out['formula'] = formula
  const style: UnknownRecord = {}
  if (typeof cell['numFmt'] === 'string') style['numFmt'] = cell['numFmt']
  if (cell['bold'] === true || cell['italic'] === true) {
    style['font'] = {
      ...(cell['bold'] === true ? { bold: true } : {}),
      ...(cell['italic'] === true ? { italic: true } : {}),
    }
  }
  if (typeof cell['fill'] === 'string') style['fill'] = { type: 'solid', color: cell['fill'] }
  if (typeof cell['alignment'] === 'string') style['alignment'] = { horizontal: cell['alignment'] }
  if (Object.keys(style).length > 0) out['style'] = style
  return out
}

async function pptxOptions(content: UnknownRecord): Promise<UnknownRecord> {
  const slides = Array.isArray(content['slides']) ? content['slides'] : []
  return {
    ...(typeof content['title'] === 'string' ? { title: content['title'] } : {}),
    slides: await Promise.all(slides.map((slide) => pptxSlide(asRecord(slide) ?? {}))),
  }
}

async function pptxSlide(slide: UnknownRecord): Promise<UnknownRecord> {
  const children: unknown[] = []
  const title = stringOf(slide['title'])
  if (title !== undefined) {
    children.push({
      shape: {
        x: 50,
        y: 40,
        width: 860,
        height: 60,
        textBody: {
          paragraphs: [
            {
              properties: { alignment: 'center' },
              children: [{ text: title, size: 32, bold: true }],
            },
          ],
        },
      },
    })
  }
  const bullets = arrayOfStrings(slide['bullets'])
  if (bullets.length > 0) {
    children.push({
      shape: {
        x: 50,
        y: 130,
        width: 860,
        height: 390,
        textBody: {
          paragraphs: bullets.map((bullet) => ({
            properties: { bullet: { type: 'char', char: '•' } },
            children: [{ text: bullet, size: 20 }],
          })),
        },
      },
    })
  }
  const image = asRecord(slide['image'])
  const imagePath = stringOf(image?.['path'])
  if (imagePath !== undefined) {
    children.push({
      shape: {
        x: numberOr(image?.['x'], 100),
        y: numberOr(image?.['y'], 180),
        width: numberOr(image?.['width'], 600),
        height: numberOr(image?.['height'], 320),
        properties: {
          fill: {
            type: 'blip',
            data: await readImage(imagePath),
            imageType: normalizeImageType(imagePath),
          },
        },
      },
    })
  }
  return {
    children,
    ...(typeof slide['notes'] === 'string' ? { notes: slide['notes'] } : {}),
  }
}

function setWorkbookCell(workbook: UnknownRecord, cell: UnknownRecord): void {
  const sheetName = requiredString(cell, 'sheet')
  const address = requiredString(cell, 'address').toUpperCase()
  const sheets = Array.isArray(workbook['worksheets']) ? workbook['worksheets'] : []
  const sheet = sheets
    .map(asRecord)
    .find((item) => item !== undefined && item['name'] === sheetName)
  if (sheet === undefined) throw new Error(`工作表不存在：${sheetName}`)
  const { row, col } = parseA1(address)
  const rows = Array.isArray(sheet['rows']) ? sheet['rows'] : (sheet['rows'] = [])
  const rowItem = asRecord(rows[row]) ?? (rows[row] = { cells: [] })
  const cells = Array.isArray(rowItem['cells']) ? rowItem['cells'] : (rowItem['cells'] = [])
  const next: UnknownRecord = { value: cell['value'] ?? null }
  if (typeof cell['formula'] === 'string') {
    next['formula'] = { formula: cell['formula'], value: cell['value'] ?? 0 }
  }
  const style = asRecord(cell['style'])
  if (style !== undefined) next['style'] = style
  else if (typeof cell['numFmt'] === 'string') next['style'] = { numFmt: cell['numFmt'] }
  cells[col] = next
}

function parseA1(address: string): { row: number; col: number } {
  const match = /^([A-Z]+)(\d+)$/.exec(address)
  if (match === null) throw new Error(`单元格地址非法：${address}`)
  const letters = match[1] ?? ''
  const rowText = match[2] ?? ''
  let col = 0
  for (const char of letters) col = col * 26 + (char.charCodeAt(0) - 64)
  const row = Number(rowText) - 1
  if (row < 0 || col <= 0) throw new Error(`单元格地址非法：${address}`)
  return { row, col: col - 1 }
}

function summarizeDocx(parsed: unknown, offset: number, limit: number): OfficeWorkerReadResult {
  const doc = asRecord(parsed) ?? {}
  const sections = Array.isArray(doc['sections']) ? doc['sections'] : []
  const lines: string[] = []
  let paragraphIndex = 0
  for (const [sectionIndex, rawSection] of sections.entries()) {
    lines.push(`## 第 ${sectionIndex + 1} 节`)
    const section = asRecord(rawSection) ?? {}
    for (const rawChild of Array.isArray(section['children']) ? section['children'] : []) {
      const child = asRecord(rawChild) ?? {}
      const paragraph = asRecord(child['paragraph'])
      if (paragraph !== undefined) {
        const text = flattenText(paragraph)
        if (text.trim() !== '') lines.push(`P${paragraphIndex}: ${text}`)
        paragraphIndex += 1
        continue
      }
      const table = asRecord(child['table'])
      if (table !== undefined) {
        const rows = Array.isArray(table['rows']) ? table['rows'] : []
        lines.push(`TABLE: ${rows.length} 行`)
      }
    }
  }
  const allText = JSON.stringify(parsed)
  const placeholders = [...new Set(allText.match(/\{\{[^{}]+\}\}/g) ?? [])]
  if (placeholders.length > 0) lines.push(`占位符：${placeholders.join(', ')}`)
  return paginate(lines, offset, limit, 20_000)
}

function summarizeXlsx(
  parsed: unknown,
  target: string | undefined,
  offset: number,
  limit: number,
): OfficeWorkerReadResult {
  const workbook = asRecord(parsed) ?? {}
  const worksheets = Array.isArray(workbook['worksheets']) ? workbook['worksheets'] : []
  const lines: string[] = []
  for (const rawSheet of worksheets) {
    const sheet = asRecord(rawSheet)
    if (sheet === undefined) continue
    const name = stringOf(sheet['name']) ?? 'Sheet'
    if (target !== undefined && target !== name) continue
    lines.push(`## ${name}`)
    const rows = Array.isArray(sheet['rows']) ? sheet['rows'] : []
    for (const [rowIndex, rawRow] of rows.entries()) {
      const row = asRecord(rawRow) ?? {}
      const cells = Array.isArray(row['cells']) ? row['cells'] : []
      const values = cells.map((rawCell, colIndex) => {
        const cell = asRecord(rawCell)
        if (cell === undefined)
          return `${columnName(colIndex)}${rowIndex + 1}=${String(rawCell ?? '')}`
        const formula = asRecord(cell['formula'])
        if (formula !== undefined)
          return `${columnName(colIndex)}${rowIndex + 1}==${String(formula['formula'])}`
        return `${columnName(colIndex)}${rowIndex + 1}=${String(cell['value'] ?? '')}`
      })
      if (values.length > 0) lines.push(values.join(' | '))
    }
  }
  return paginate(lines, offset, limit, 20_000)
}

function summarizePptx(
  parsed: unknown,
  target: string | undefined,
  offset: number,
  limit: number,
): OfficeWorkerReadResult {
  const presentation = asRecord(parsed) ?? {}
  const slides = Array.isArray(presentation['slides']) ? presentation['slides'] : []
  const wanted = target === undefined ? undefined : Number(target)
  const lines: string[] = []
  for (const [index, rawSlide] of slides.entries()) {
    if (wanted !== undefined && Number.isFinite(wanted) && index !== wanted) continue
    const slide = asRecord(rawSlide) ?? {}
    lines.push(`## 幻灯片 ${index + 1}`)
    for (const rawChild of Array.isArray(slide['children']) ? slide['children'] : []) {
      const child = asRecord(rawChild) ?? {}
      const shape = asRecord(child['shape'])
      const body = asRecord(shape?.['textBody'])
      const text = flattenText(body)
      if (text.trim() !== '') lines.push(text)
    }
    if (typeof slide['notes'] === 'string' && slide['notes'].trim() !== '') {
      lines.push(`备注：${slide['notes']}`)
    }
  }
  return paginate(lines, offset, limit, 20_000)
}

function paginate(
  lines: string[],
  offset: number,
  limit: number,
  maxChars: number,
): OfficeWorkerReadResult {
  const selected = lines.slice(offset, offset + limit)
  let content = selected.join('\n')
  let truncated = offset + selected.length < lines.length
  if (content.length > maxChars) {
    content = `${content.slice(0, maxChars)}\n…（内容过长已截断）`
    truncated = true
  }
  return { content, truncated, warnings: [] }
}

function flattenText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(flattenText).join('')
  const record = asRecord(value)
  if (record === undefined) return ''
  if (typeof record['text'] === 'string') return record['text']
  if (record['children'] !== undefined) return flattenText(record['children'])
  const paragraphs = Array.isArray(record['paragraphs']) ? record['paragraphs'] : []
  return paragraphs.map(flattenText).join('\n')
}

function mapDocxPlaceholders(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, docxPatchValue(value)]),
  )
}

function docxPatchValue(value: unknown): UnknownRecord {
  return {
    type: 'paragraph',
    children: Array.isArray(value) ? value.map(String) : [String(value ?? '')],
  }
}

function mapPptxPlaceholders(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.map(String) : String(value ?? ''),
    ]),
  )
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (Array.isArray(value)) return Uint8Array.from(value as number[])
  throw new Error('Office 引擎返回了非二进制结果')
}

function scalarOf(value: unknown): string | number | boolean | Date {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value
  if (value instanceof Date) return value
  return String(value ?? '')
}

function requiredString(record: UnknownRecord, key: string): string {
  const value = stringOf(record[key])
  if (value === undefined || value === '') throw new Error(`缺少参数 ${key}`)
  return value
}

function requiredInt(record: UnknownRecord, key: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`参数 ${key} 必须是数字`)
  return Math.floor(value)
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined
}

function arrayOfRecords(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is UnknownRecord => item !== undefined)
    : []
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function arrayOfNumbers(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === 'number')
    : []
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(Math.floor(value), min), max)
    : fallback
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function columnName(index: number): string {
  let value = index + 1
  let result = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    value = Math.floor((value - 1) / 26)
  }
  return result
}

function normalizeImageType(path: string): string {
  const extension = extname(path).slice(1).toLowerCase()
  if (extension === 'jpeg') return 'jpg'
  if (extension === 'svg') return 'svg'
  if (extension === 'bmp' || extension === 'gif' || extension === 'png' || extension === 'jpg')
    return extension
  throw new Error(`不支持的图片格式：${extension || '未知'}`)
}

async function readImage(path: string): Promise<Uint8Array> {
  return new Uint8Array(await fs.readFile(path))
}

const parentPort = process.parentPort
if (parentPort !== undefined) {
  parentPort.on('message', (message) => {
    const request = message.data as OfficeWorkerRequest | undefined
    if (request === undefined || typeof request !== 'object' || typeof request.id !== 'string') {
      return
    }
    void handleOfficeRequest(request).then((response) => {
      try {
        parentPort.postMessage(response)
      } catch {
        /* 父进程已退出 */
      }
    })
  })
}
