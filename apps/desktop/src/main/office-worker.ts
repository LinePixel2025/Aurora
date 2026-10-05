/**
 * Office utility worker.
 *
 * It runs inside `utilityProcess` and delegates document work to the pinned
 * OfficeCLI binary. No Electron or DOM APIs are used here.
 */
import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { PDFDocument } from 'pdf-lib'
import type { OfficeBatchCommand, OfficeFormat, OfficeRawOperation } from '@aurora/agent-core'
import {
  OfficeCliRunner,
  parseOfficeCliError,
  type OfficeCliEnvelope,
  type OfficeCliRunOptions,
} from './office-cli.js'
import type {
  OfficeWorkerPdfResult,
  OfficeWorkerReadResult,
  OfficeWorkerRenderResult,
  OfficeWorkerRequest,
  OfficeWorkerResponse,
  OfficeWorkerWriteResult,
} from './office-protocol.js'

type UnknownRecord = Record<string, unknown>

export interface OfficeWorkerDeps {
  runner?: OfficeCliRunner
  cliPath?: string
  logger?: {
    debug(message: string, detail?: Record<string, unknown>): void
    warn(message: string, detail?: Record<string, unknown>): void
  }
}

class OfficeCliOperationError extends Error {
  readonly code?: string
  readonly suggestion?: string

  constructor(message: string, code?: string, suggestion?: string) {
    super(message)
    this.name = 'OfficeCliOperationError'
    this.code = code
    this.suggestion = suggestion
  }
}

export async function handleOfficeRequest(
  request: OfficeWorkerRequest,
  deps: OfficeWorkerDeps = {},
): Promise<OfficeWorkerResponse> {
  try {
    const runner = resolveRunner(deps)
    if (request.action === 'read') {
      const read = await readOffice(runner, request, request.timeoutMs)
      return { id: request.id, ok: true, read }
    }
    if (request.action === 'help') {
      const content = await helpOffice(runner, request, request.timeoutMs)
      return { id: request.id, ok: true, help: content }
    }
    if (request.action === 'create') {
      const write = await createOffice(runner, request, deps.logger)
      return { id: request.id, ok: true, write }
    }
    if (request.action === 'edit') {
      const write = await editOffice(runner, request, deps.logger)
      return { id: request.id, ok: true, write }
    }
    if (request.action === 'raw-edit') {
      const write = await rawEditOffice(runner, request, deps.logger)
      return { id: request.id, ok: true, write }
    }
    if (request.action === 'render') {
      const render = await renderOffice(runner, request, deps.logger)
      return { id: request.id, ok: true, render }
    }
    const pdf = await pdfOffice(runner, request, deps.logger)
    return { id: request.id, ok: true, pdf }
  } catch (error) {
    const item = error instanceof OfficeCliOperationError ? error : undefined
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...(item?.code === undefined ? {} : { code: item.code }),
      ...(item?.suggestion === undefined ? {} : { suggestion: item.suggestion }),
    }
  }
}

function resolveRunner(deps: OfficeWorkerDeps): OfficeCliRunner {
  if (deps.runner !== undefined) return deps.runner
  const cliPath = deps.cliPath ?? process.env['AURORA_OFFICECLI_PATH'] ?? ''
  if (cliPath === '') {
    throw new Error('AURORA_OFFICECLI_PATH 未设置，Office worker 不可用')
  }
  return new OfficeCliRunner({ binaryPath: cliPath })
}

async function readOffice(
  runner: OfficeCliRunner,
  request: Extract<OfficeWorkerRequest, { action: 'read' }>,
  timeoutMs: number,
): Promise<OfficeWorkerReadResult> {
  const options = cliOptions(timeoutMs)
  if (request.mode === 'text') {
    const start = request.offset + 1
    const end = Math.max(start, request.offset + request.limit)
    const run = await runner.run(
      ['view', request.path, 'text', '--start', String(start), '--end', String(end)],
      options,
    )
    if (run.code !== 0 || run.timedOut) throw cliRunError(run)
    const text = truncatedText(run.stdout, Math.min(30_000, request.limit * 800))
    return { ...text, warnings: [] }
  }

  let args: string[]
  if (request.mode === 'summary') {
    const [outline, stats] = await Promise.all([
      runEnvelope<unknown>(runner, ['view', request.path, 'outline', '--json'], options),
      runEnvelope<unknown>(runner, ['view', request.path, 'stats', '--json'], options),
    ])
    return renderJson({ outline, stats }, Math.min(30_000, request.limit * 800))
  }
  if (request.mode === 'element') {
    args = [
      'get',
      request.path,
      requiredTarget(request.target),
      '--depth',
      String(request.depth),
      '--json',
    ]
  } else if (request.mode === 'query') {
    args = ['query', request.path, requiredTarget(request.target), '--json']
  } else if (request.mode === 'issues') {
    args = ['view', request.path, 'issues', '--limit', String(request.limit), '--json']
  } else {
    args = ['validate', request.path, '--json']
  }
  const data = await runEnvelope<unknown>(runner, args, options)
  return renderJson(data, Math.min(30_000, request.limit * 800))
}

async function helpOffice(
  runner: OfficeCliRunner,
  request: Extract<OfficeWorkerRequest, { action: 'help' }>,
  timeoutMs: number,
): Promise<{ content: string; truncated: boolean }> {
  const args = ['help', request.format]
  if (request.verb !== undefined) args.push(request.verb)
  if (request.element !== undefined) args.push(request.element)
  const run = await runner.run(args, cliOptions(timeoutMs))
  if (run.code !== 0 || run.timedOut) throw cliRunError(run)
  return truncatedText(run.stdout, 30_000)
}

async function createOffice(
  runner: OfficeCliRunner,
  request: Extract<OfficeWorkerRequest, { action: 'create' }>,
  logger: OfficeWorkerDeps['logger'],
): Promise<OfficeWorkerWriteResult> {
  await fs.mkdir(dirname(request.outputPath), { recursive: true })
  const options = cliOptions(request.timeoutMs)
  if (request.templatePath !== undefined) {
    const dataFile = await writeTempJson(request.outputPath, 'template', request.templateData ?? {})
    try {
      await runEnvelope(
        runner,
        [
          'merge',
          request.templatePath,
          request.outputPath,
          '--data',
          dataFile,
          '--force',
          '--json',
        ],
        options,
      )
    } finally {
      await fs.rm(dataFile, { force: true }).catch(() => undefined)
    }
  } else {
    await runEnvelope(runner, ['create', request.outputPath, '--json'], options)
  }
  if (request.commands.length > 0) {
    await applyBatch(runner, request.outputPath, request.commands, request.timeoutMs)
  }
  const warnings = await validateAndCollectWarnings(
    runner,
    request.outputPath,
    request.timeoutMs,
    logger,
  )
  return { bytes: await fileSize(request.outputPath), warnings }
}

async function editOffice(
  runner: OfficeCliRunner,
  request: Extract<OfficeWorkerRequest, { action: 'edit' }>,
  logger: OfficeWorkerDeps['logger'],
): Promise<OfficeWorkerWriteResult> {
  await fs.mkdir(dirname(request.outputPath), { recursive: true })
  await fs.copyFile(request.sourcePath, request.outputPath)
  await applyBatch(runner, request.outputPath, request.commands, request.timeoutMs)
  const warnings = await validateAndCollectWarnings(
    runner,
    request.outputPath,
    request.timeoutMs,
    logger,
  )
  return { bytes: await fileSize(request.outputPath), warnings }
}

async function rawEditOffice(
  runner: OfficeCliRunner,
  request: Extract<OfficeWorkerRequest, { action: 'raw-edit' }>,
  logger: OfficeWorkerDeps['logger'],
): Promise<OfficeWorkerWriteResult> {
  const commands = request.operations.map(rawOperationCommand)
  await fs.mkdir(dirname(request.outputPath), { recursive: true })
  await fs.copyFile(request.sourcePath, request.outputPath)
  await applyBatch(runner, request.outputPath, commands, request.timeoutMs)
  const warnings = await validateAndCollectWarnings(
    runner,
    request.outputPath,
    request.timeoutMs,
    logger,
  )
  return { bytes: await fileSize(request.outputPath), warnings }
}

async function renderOffice(
  runner: OfficeCliRunner,
  request: Extract<OfficeWorkerRequest, { action: 'render' }>,
  logger: OfficeWorkerDeps['logger'],
): Promise<OfficeWorkerRenderResult> {
  await fs.mkdir(request.outputDir, { recursive: true })
  if (request.mode === 'html') {
    const file = join(request.outputDir, `${safeStem(request.sourcePath)}.html`)
    const run = await runner.run(
      ['view', request.sourcePath, 'html'],
      cliOptions(request.timeoutMs),
    )
    if (run.code !== 0 || run.timedOut) throw cliRunError(run)
    await fs.writeFile(file, run.stdout, 'utf8')
    return { files: [file], warnings: [] }
  }
  const pages = await resolveRenderPages(runner, request, request.timeoutMs)
  const selected = pages.slice(0, request.maxPages)
  const files: string[] = []
  for (const [index, page] of selected.entries()) {
    const file = join(request.outputDir, `${safeStem(request.sourcePath)}-${index + 1}.png`)
    await captureScreenshot(runner, request.sourcePath, file, page, request.timeoutMs)
    files.push(file)
  }
  logger?.debug('Office 截图完成', { source: request.sourcePath, count: files.length })
  return {
    files,
    ...(pages.length === 1 ? { pageCount: 1 } : { pageCount: pages.length }),
    warnings: [],
  }
}

async function pdfOffice(
  runner: OfficeCliRunner,
  request: Extract<OfficeWorkerRequest, { action: 'pdf' }>,
  logger: OfficeWorkerDeps['logger'],
): Promise<OfficeWorkerPdfResult> {
  await fs.mkdir(dirname(request.outputPath), { recursive: true })
  const scratch = await fs.mkdtemp(join(tmpdir(), 'aurora-office-pdf-'))
  try {
    const pages = await resolveRenderPages(
      runner,
      {
        ...request,
        action: 'render',
        mode: 'screenshot',
        outputDir: scratch,
        maxPages: Number.MAX_SAFE_INTEGER,
      },
      request.timeoutMs,
    )
    const images: string[] = []
    for (const [index, page] of pages.entries()) {
      const file = join(scratch, `page-${index + 1}.png`)
      await captureScreenshot(runner, request.sourcePath, file, page, request.timeoutMs)
      images.push(file)
    }
    if (images.length === 0) {
      throw new OfficeCliOperationError('没有可导出的页面', 'empty_document')
    }
    const pdf = await PDFDocument.create()
    for (const imagePath of images) {
      const bytes = await fs.readFile(imagePath)
      const embedded = await pdf.embedPng(bytes)
      const width = Math.max(1, embedded.width / 2)
      const height = Math.max(1, embedded.height / 2)
      const page = pdf.addPage([width, height])
      page.drawImage(embedded, { x: 0, y: 0, width, height })
    }
    const bytes = await pdf.save()
    await fs.writeFile(request.outputPath, bytes)
    logger?.debug('Office PDF 合成完成', {
      source: request.sourcePath,
      pages: images.length,
      bytes: bytes.byteLength,
    })
    return { bytes: bytes.byteLength, pages: images.length, warnings: [] }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}

interface RenderPage {
  args: string[]
}

async function resolveRenderPages(
  runner: OfficeCliRunner,
  request: Extract<OfficeWorkerRequest, { action: 'render' | 'pdf' }>,
  timeoutMs: number,
): Promise<RenderPage[]> {
  if (request.action === 'render' && request.target !== undefined) {
    return [{ args: ['--range', request.target] }]
  }
  if (request.action === 'render' && request.grid !== undefined) {
    return [{ args: ['--grid', String(request.grid), ...pageRangeArgs(request)] }]
  }
  if (request.format === 'xlsx') {
    const sheets = await workbookSheets(runner, request.sourcePath, timeoutMs)
    if (sheets.length > 0) {
      return sheets.map((sheet) => ({ args: ['--range', sheetRange(sheet)] }))
    }
  }
  const start = request.pageStart ?? 1
  const end =
    request.pageEnd ?? (await pageCount(runner, request.sourcePath, request.format, timeoutMs))
  const from = Math.max(1, start)
  const to = Math.max(from, end)
  const pages: RenderPage[] = []
  for (let page = from; page <= to; page += 1) {
    pages.push({ args: ['--start', String(page), '--end', String(page)] })
  }
  return pages
}

function pageRangeArgs(
  request: Extract<OfficeWorkerRequest, { action: 'render' | 'pdf' }>,
): string[] {
  const args: string[] = []
  if (request.pageStart !== undefined) args.push('--start', String(request.pageStart))
  if (request.pageEnd !== undefined) args.push('--end', String(request.pageEnd))
  return args
}

async function pageCount(
  runner: OfficeCliRunner,
  path: string,
  format: OfficeFormat,
  timeoutMs: number,
): Promise<number> {
  const options = cliOptions(timeoutMs)
  if (format === 'pptx') {
    const data = await runEnvelope<UnknownRecord>(
      runner,
      ['view', path, 'outline', '--json'],
      options,
    )
    const slides = Array.isArray(data['slides']) ? data['slides'] : []
    return Math.max(1, slides.length)
  }
  const data = await runEnvelope<UnknownRecord>(
    runner,
    ['view', path, 'stats', '--page-count', '--json'],
    options,
  )
  return positiveNumber(data['pages']) ?? positiveNumber(data['pageCount']) ?? 1
}

interface WorkbookSheet {
  name: string
  rows: number
  cols: number
}

async function workbookSheets(
  runner: OfficeCliRunner,
  path: string,
  timeoutMs: number,
): Promise<WorkbookSheet[]> {
  const data = await runEnvelope<UnknownRecord>(
    runner,
    ['view', path, 'outline', '--json'],
    cliOptions(timeoutMs),
  )
  const sheets = Array.isArray(data['sheets']) ? data['sheets'] : []
  return sheets
    .map((raw) => asRecord(raw))
    .filter((item): item is UnknownRecord => item !== undefined)
    .map((sheet) => ({
      name: String(sheet['name'] ?? 'Sheet1'),
      rows: positiveNumber(sheet['rows']) ?? 1,
      cols: positiveNumber(sheet['cols']) ?? 1,
    }))
}

function sheetRange(sheet: WorkbookSheet): string {
  const endColumn = columnName(Math.max(1, sheet.cols))
  return `${sheet.name}!A1:${endColumn}${Math.max(1, sheet.rows)}`
}

async function captureScreenshot(
  runner: OfficeCliRunner,
  sourcePath: string,
  outputPath: string,
  page: RenderPage,
  timeoutMs: number,
): Promise<void> {
  const run = await runner.run(
    [
      'view',
      sourcePath,
      'screenshot',
      '--render',
      'html',
      '--screenshot-width',
      '1600',
      ...page.args,
      '-o',
      outputPath,
    ],
    cliOptions(timeoutMs),
  )
  if (run.code !== 0 || run.timedOut) throw cliRunError(run)
  const info = await fs.stat(outputPath).catch(() => undefined)
  if (info === undefined || info.size === 0) {
    throw new OfficeCliOperationError(
      `OfficeCLI 未生成截图：${outputPath}。请确认系统已安装 Edge/Chrome/Chromium。`,
      'no_screenshot_backend',
    )
  }
}

async function applyBatch(
  runner: OfficeCliRunner,
  path: string,
  commands: readonly OfficeBatchCommand[],
  timeoutMs: number,
): Promise<void> {
  const input = await writeTempJson(path, 'batch', commands)
  try {
    const { envelope, run } = await runner.runJson<UnknownRecord>(
      ['batch', path, '--input', input, '--json'],
      cliOptions(timeoutMs),
    )
    if (!envelope.success || run.code !== 0 || run.timedOut) {
      throw batchError(envelope, run)
    }
  } finally {
    await fs.rm(input, { force: true }).catch(() => undefined)
  }
}

async function validateAndCollectWarnings(
  runner: OfficeCliRunner,
  path: string,
  timeoutMs: number,
  logger: OfficeWorkerDeps['logger'],
): Promise<string[]> {
  const options = cliOptions(timeoutMs)
  await runEnvelope(runner, ['validate', path, '--json'], options)
  try {
    const issues = await runEnvelope<UnknownRecord>(
      runner,
      ['view', path, 'issues', '--limit', '20', '--json'],
      options,
    )
    const list = Array.isArray(issues['issues']) ? issues['issues'] : []
    return list
      .map((raw) => asRecord(raw))
      .filter((issue): issue is UnknownRecord => issue !== undefined)
      .map((issue) => String(issue['message'] ?? issue['description'] ?? 'Office 问题'))
      .slice(0, 10)
  } catch (error) {
    logger?.warn('OfficeCLI issues 检查失败，保留 validate 结果', {
      error: String(error),
    })
    return []
  }
}

async function runEnvelope<T>(
  runner: OfficeCliRunner,
  args: readonly string[],
  options: OfficeCliRunOptions,
): Promise<T> {
  const { envelope, run } = await runner.runJson<T>(args, options)
  if (!envelope.success || run.code !== 0 || run.timedOut) {
    throw envelope.error === undefined ? cliRunError(run) : officeError(envelope.error)
  }
  return envelope.data as T
}

function batchError(
  envelope: OfficeCliEnvelope<UnknownRecord>,
  run: Awaited<ReturnType<OfficeCliRunner['run']>>,
): OfficeCliOperationError {
  if (envelope.error !== undefined) return officeError(envelope.error)
  const data = envelope.data ?? {}
  const results = Array.isArray(data['results']) ? data['results'] : []
  for (const raw of results) {
    const item = asRecord(raw)
    if (item?.['success'] === false) {
      const index = typeof item['index'] === 'number' ? item['index'] + 1 : '?'
      const message = String(item['error'] ?? 'OfficeCLI 命令失败')
      const code = typeof item['code'] === 'string' ? item['code'] : undefined
      return new OfficeCliOperationError(`第 ${index} 条命令失败：${message}`, code)
    }
  }
  return cliRunError(run)
}

function officeError(error: {
  error: string
  code?: string
  suggestion?: string
}): OfficeCliOperationError {
  const suffix = error.suggestion === undefined ? '' : `（建议：${error.suggestion}）`
  return new OfficeCliOperationError(`${error.error}${suffix}`, error.code, error.suggestion)
}

function cliRunError(run: Awaited<ReturnType<OfficeCliRunner['run']>>): OfficeCliOperationError {
  const parsed = parseOfficeCliError(run.stderr.trim())
  const base = run.timedOut
    ? 'OfficeCLI 执行超时并被终止'
    : `OfficeCLI 执行失败（退出码 ${run.code ?? 'unknown'}）`
  return new OfficeCliOperationError(
    `${base}${parsed.error === '' ? '' : `：${parsed.error}`}`,
    parsed.code,
    parsed.suggestion,
  )
}

function rawOperationCommand(operation: OfficeRawOperation): OfficeBatchCommand {
  return {
    command: 'raw-set',
    part: operation.part,
    xpath: operation.xpath,
    action: operation.action,
    ...(operation.xml === undefined ? {} : { xml: operation.xml }),
  }
}

function cliOptions(timeoutMs: number): OfficeCliRunOptions {
  return { timeoutMs }
}

function requiredTarget(target: string | undefined): string {
  if (target === undefined || target.trim() === '') {
    throw new OfficeCliOperationError('element / query 模式缺少 target', 'invalid_request')
  }
  return target
}

async function writeTempJson(nearPath: string, label: string, value: unknown): Promise<string> {
  const file = join(
    dirname(nearPath),
    `.${basename(nearPath)}.aurora-${label}-${process.pid}-${Date.now()}.json`,
  )
  await fs.writeFile(file, JSON.stringify(value), 'utf8')
  return file
}

async function fileSize(path: string): Promise<number> {
  return (await fs.stat(path)).size
}

function renderJson(value: unknown, maxChars: number): OfficeWorkerReadResult {
  const rendered = JSON.stringify(value, null, 2)
  const limited = truncatedText(rendered, Math.max(1000, maxChars))
  return { content: limited.content, truncated: limited.truncated, warnings: [] }
}

function truncatedText(value: string, maxChars: number): { content: string; truncated: boolean } {
  if (value.length <= maxChars) return { content: value, truncated: false }
  return {
    content: `${value.slice(0, maxChars)}\n…（内容过长已截断）`,
    truncated: true,
  }
}

function safeStem(path: string): string {
  return (
    basename(path, extname(path))
      .replace(/[^\p{L}\p{N}._-]+/gu, '_')
      .slice(0, 80) || 'office'
  )
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

function columnName(index: number): string {
  let value = Math.max(1, index)
  let result = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    value = Math.floor((value - 1) / 26)
  }
  return result
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
        /* parent process exited */
      }
    })
  })
}
