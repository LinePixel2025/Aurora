/**
 * Main-process `OfficePort`: path boundaries, file locks, snapshots, atomic
 * replacement and rendering image handoff.
 */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { createNoopLogger, type Logger } from '@aurora/shared'
import type {
  OfficeCreateRequest,
  OfficeEditRequest,
  OfficeFormat,
  OfficeHelpRequest,
  OfficeHelpResult,
  OfficePdfRequest,
  OfficePdfResult,
  OfficePort,
  OfficeRawEditRequest,
  OfficeReadRequest,
  OfficeReadResult,
  OfficeRenderRequest,
  OfficeRenderResult,
  OfficeWriteResult,
  SnapshotWriteOutcome,
} from '@aurora/agent-core'
import type { SnapshotPort, ToolImage } from '@aurora/agent-core'
import { resolveWithin, type OutsideOption, type WorkspaceGuardOptions } from './file-port.js'
import type { OfficePool } from '../office-pool.js'
import type { OfficeWorkerResponse, OfficeWorkerRunRequest } from '../office-protocol.js'

export interface NodeOfficePortOptions extends WorkspaceGuardOptions {
  pool: OfficePool
  snapshots?: Pick<SnapshotPort, 'capture'>
  logger?: Logger
  maxFileBytes?: number
  renderRoot: string
  normalTimeoutMs?: number
  renderTimeoutMs?: number
}

export const DEFAULT_MAX_OFFICE_FILE_BYTES = 64 * 1024 * 1024
export const DEFAULT_NORMAL_OFFICE_TIMEOUT_MS = 45_000
export const DEFAULT_RENDER_OFFICE_TIMEOUT_MS = 120_000

export function createNodeOfficePort(options: NodeOfficePortOptions): OfficePort {
  const logger = options.logger ?? createNoopLogger()
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_OFFICE_FILE_BYTES
  const normalTimeoutMs = options.normalTimeoutMs ?? DEFAULT_NORMAL_OFFICE_TIMEOUT_MS
  const renderTimeoutMs = options.renderTimeoutMs ?? DEFAULT_RENDER_OFFICE_TIMEOUT_MS
  const guard: WorkspaceGuardOptions = {
    workspaceRoot: options.workspaceRoot,
    enforceWorkspace: options.enforceWorkspace,
    logger,
  }

  const resolve = async (
    path: string,
    input?: { allowOutside?: boolean; sessionId?: string },
  ): Promise<string> => resolveOfficePath(path, input, guard)

  return {
    resolve,

    async read(request: OfficeReadRequest): Promise<OfficeReadResult> {
      const absolutePath = await resolve(request.path, request)
      const format = formatOf(absolutePath)
      await assertRegularFile(absolutePath, maxFileBytes)
      const response = await runWorker(options.pool, {
        action: 'read',
        timeoutMs: normalTimeoutMs,
        path: absolutePath,
        format,
        mode: request.mode,
        ...(request.target === undefined ? {} : { target: request.target }),
        offset: request.offset ?? 0,
        limit: request.limit ?? 80,
        depth: request.depth ?? 1,
      })
      if (response.read === undefined) throw new Error('Office worker 未返回读取结果')
      return {
        absolutePath,
        format,
        content: response.read.content,
        truncated: response.read.truncated,
        warnings: response.read.warnings,
      }
    },

    async help(request: OfficeHelpRequest): Promise<OfficeHelpResult> {
      const response = await runWorker(options.pool, {
        action: 'help',
        timeoutMs: normalTimeoutMs,
        format: request.format,
        ...(request.verb === undefined ? {} : { verb: request.verb }),
        ...(request.element === undefined ? {} : { element: request.element }),
      })
      if (response.help === undefined) throw new Error('Office worker 未返回帮助内容')
      return response.help
    },

    async create(request: OfficeCreateRequest): Promise<OfficeWriteResult> {
      const outputPath = await resolve(request.path, request)
      assertFormatMatchesPath(request.format, outputPath)
      const exists = await fileExists(outputPath)
      if (exists && !request.overwrite) {
        throw new Error(`目标文件已存在：${outputPath}；如需覆盖请显式传 overwrite=true`)
      }
      if (exists) await assertNotLocked(outputPath)
      const templatePath =
        request.templatePath === undefined
          ? undefined
          : await resolve(request.templatePath, request)
      if (templatePath !== undefined) {
        assertFormatMatchesPath(request.format, templatePath)
        await assertRegularFile(templatePath, maxFileBytes)
      }
      await fs.mkdir(dirname(outputPath), { recursive: true })
      const tempPath = tempPathFor(outputPath)
      try {
        const response = await runWorker(options.pool, {
          action: 'create',
          timeoutMs: normalTimeoutMs,
          outputPath: tempPath,
          format: request.format,
          commands: request.commands,
          ...(templatePath === undefined ? {} : { templatePath }),
          ...(request.templateData === undefined ? {} : { templateData: request.templateData }),
        })
        const bytes = response.write?.bytes ?? (await statSize(tempPath))
        const snapshot = exists
          ? await captureRequiredSnapshot(options, request, outputPath, 'office_edit', logger)
          : undefined
        await replaceFile(tempPath, outputPath)
        return {
          absolutePath: outputPath,
          sourcePath: templatePath ?? outputPath,
          format: request.format,
          bytes,
          ...(snapshot === undefined ? {} : { snapshot }),
          warnings: response.write?.warnings ?? [],
        }
      } catch (error) {
        await fs.rm(tempPath, { force: true }).catch(() => undefined)
        throw error
      }
    },

    async edit(request: OfficeEditRequest): Promise<OfficeWriteResult> {
      const sourcePath = await resolve(request.path, request)
      const format = formatOf(sourcePath)
      await assertRegularFile(sourcePath, maxFileBytes)
      await assertNotLocked(sourcePath)
      const outputPath = await resolveEditOutputPath(sourcePath, request, resolve)
      assertFormatMatchesPath(format, outputPath)
      const sameOutput = outputPath.toLowerCase() === sourcePath.toLowerCase()
      const outputExists = await fileExists(outputPath)
      if (sameOutput && request.overwrite !== true) {
        throw new Error('saveAs 指向源文件；如需覆盖源文件请显式传 overwrite=true')
      }
      if (!sameOutput && outputExists && request.overwrite !== true) {
        throw new Error(`另存目标已存在：${outputPath}；请换一个 saveAs，或显式传 overwrite=true`)
      }
      if (outputExists) await assertNotLocked(outputPath)
      const tempPath = tempPathFor(outputPath)
      try {
        const response = await runWorker(options.pool, {
          action: 'edit',
          timeoutMs: normalTimeoutMs,
          sourcePath,
          outputPath: tempPath,
          format,
          commands: request.commands,
        })
        const bytes = response.write?.bytes ?? (await statSize(tempPath))
        const snapshot = outputExists
          ? await captureRequiredSnapshot(options, request, outputPath, 'office_edit', logger)
          : undefined
        await replaceFile(tempPath, outputPath)
        return {
          absolutePath: outputPath,
          sourcePath,
          format,
          bytes,
          ...(snapshot === undefined ? {} : { snapshot }),
          warnings: response.write?.warnings ?? [],
        }
      } catch (error) {
        await fs.rm(tempPath, { force: true }).catch(() => undefined)
        throw error
      }
    },

    async rawEdit(request: OfficeRawEditRequest): Promise<OfficeWriteResult> {
      const sourcePath = await resolve(request.path, request)
      const format = formatOf(sourcePath)
      await assertRegularFile(sourcePath, maxFileBytes)
      await assertNotLocked(sourcePath)
      const outputPath = await resolveEditOutputPath(sourcePath, request, resolve)
      assertFormatMatchesPath(format, outputPath)
      const sameOutput = outputPath.toLowerCase() === sourcePath.toLowerCase()
      const outputExists = await fileExists(outputPath)
      if (sameOutput && request.overwrite !== true) {
        throw new Error('saveAs 指向源文件；如需覆盖源文件请显式传 overwrite=true')
      }
      if (!sameOutput && outputExists && request.overwrite !== true) {
        throw new Error(`另存目标已存在：${outputPath}；请换一个 saveAs，或显式传 overwrite=true`)
      }
      if (outputExists) await assertNotLocked(outputPath)
      const tempPath = tempPathFor(outputPath)
      try {
        const response = await runWorker(options.pool, {
          action: 'raw-edit',
          timeoutMs: normalTimeoutMs,
          sourcePath,
          outputPath: tempPath,
          format,
          operations: request.operations,
        })
        const bytes = response.write?.bytes ?? (await statSize(tempPath))
        const snapshot = outputExists
          ? await captureRequiredSnapshot(options, request, outputPath, 'office_edit', logger)
          : undefined
        await replaceFile(tempPath, outputPath)
        return {
          absolutePath: outputPath,
          sourcePath,
          format,
          bytes,
          ...(snapshot === undefined ? {} : { snapshot }),
          warnings: response.write?.warnings ?? [],
        }
      } catch (error) {
        await fs.rm(tempPath, { force: true }).catch(() => undefined)
        throw error
      }
    },

    async render(request: OfficeRenderRequest): Promise<OfficeRenderResult> {
      const sourcePath = await resolve(request.path, request)
      const format = formatOf(sourcePath)
      await assertRegularFile(sourcePath, maxFileBytes)
      const outputDir = await createRenderDir(options.renderRoot, request.sessionId)
      const response = await runWorker(options.pool, {
        action: 'render',
        timeoutMs: renderTimeoutMs,
        sourcePath,
        format,
        mode: request.mode,
        outputDir,
        ...(request.target === undefined ? {} : { target: request.target }),
        ...(request.pageStart === undefined ? {} : { pageStart: request.pageStart }),
        ...(request.pageEnd === undefined ? {} : { pageEnd: request.pageEnd }),
        ...(request.grid === undefined ? {} : { grid: request.grid }),
        maxPages: request.maxPages ?? 6,
      })
      if (response.render === undefined) throw new Error('Office worker 未返回渲染结果')
      const images: ToolImage[] = []
      if (request.mode === 'screenshot') {
        for (const path of response.render.files) {
          const bytes = await fs.readFile(path)
          images.push({
            path,
            image: {
              mimeType: 'image/png',
              dataBase64: bytes.toString('base64'),
              name: basename(path),
            },
          })
        }
      }
      return {
        sourcePath,
        format,
        files: response.render.files,
        images,
        ...(response.render.pageCount === undefined
          ? {}
          : { pageCount: response.render.pageCount }),
        warnings: response.render.warnings,
      }
    },

    async pdf(request: OfficePdfRequest): Promise<OfficePdfResult> {
      const sourcePath = await resolve(request.path, request)
      const format = formatOf(sourcePath)
      await assertRegularFile(sourcePath, maxFileBytes)
      const outputPath =
        request.outputPath === undefined
          ? defaultPdfPath(sourcePath)
          : await resolve(request.outputPath, request)
      if (extname(outputPath).toLowerCase() !== '.pdf') {
        throw new Error(`PDF 输出必须使用 .pdf 扩展名：${outputPath}`)
      }
      const exists = await fileExists(outputPath)
      if (exists && !request.overwrite) {
        throw new Error(`PDF 已存在：${outputPath}；如需覆盖请显式传 overwrite=true`)
      }
      if (exists) await assertNotLocked(outputPath)
      const tempPath = tempPathFor(outputPath)
      try {
        const response = await runWorker(options.pool, {
          action: 'pdf',
          timeoutMs: renderTimeoutMs,
          sourcePath,
          outputPath: tempPath,
          format,
          ...(request.pageStart === undefined ? {} : { pageStart: request.pageStart }),
          ...(request.pageEnd === undefined ? {} : { pageEnd: request.pageEnd }),
        })
        const bytes = response.pdf?.bytes ?? (await statSize(tempPath))
        const snapshot = exists
          ? await captureRequiredSnapshot(options, request, outputPath, 'office_export', logger)
          : undefined
        await replaceFile(tempPath, outputPath)
        return {
          absolutePath: outputPath,
          sourcePath,
          format,
          bytes,
          pages: response.pdf?.pages ?? 1,
          ...(snapshot === undefined ? {} : { snapshot }),
          warnings: response.pdf?.warnings ?? [],
        }
      } catch (error) {
        await fs.rm(tempPath, { force: true }).catch(() => undefined)
        throw error
      }
    },
  }
}

async function resolveEditOutputPath(
  sourcePath: string,
  request: OfficeEditRequest | OfficeRawEditRequest,
  resolve: (
    path: string,
    input?: { allowOutside?: boolean; sessionId?: string },
  ) => Promise<string>,
): Promise<string> {
  if (request.overwrite === true) {
    if (request.saveAs !== undefined) {
      const requested = await resolve(request.saveAs, request)
      if (requested.toLowerCase() !== sourcePath.toLowerCase()) {
        throw new Error('overwrite=true 时 saveAs 只能指向源文件；请改为 overwrite=false')
      }
    }
    return sourcePath
  }
  return request.saveAs === undefined
    ? defaultSaveAsPath(sourcePath)
    : resolve(request.saveAs, request)
}

async function runWorker(
  pool: OfficePool,
  request: OfficeWorkerRunRequest,
): Promise<OfficeWorkerResponse & { ok: true }> {
  const response = await pool.run(request)
  if (!response.ok) {
    const suffix = response.suggestion === undefined ? '' : `；建议：${response.suggestion}`
    throw new Error(`${response.error ?? 'Office worker 执行失败'}${suffix}`)
  }
  return response as OfficeWorkerResponse & { ok: true }
}

async function resolveOfficePath(
  path: string,
  input: OutsideOption | undefined,
  guard: WorkspaceGuardOptions,
): Promise<string> {
  const absolutePath = await resolveWithin(
    path,
    input?.allowOutside === true,
    guard,
    input?.sessionId,
  )
  const info = await lstatOrUndefined(absolutePath)
  if (info?.isSymbolicLink() === true) {
    throw new Error(`目标已是符号链接 / junction，出于安全考虑拒绝：${absolutePath}`)
  }
  if (info?.isDirectory() === true) {
    throw new Error(`目标是目录而不是 Office 文件：${absolutePath}`)
  }
  return absolutePath
}

async function assertRegularFile(path: string, maxFileBytes: number): Promise<void> {
  const info = await fs.lstat(path)
  if (!info.isFile()) throw new Error(`不是普通文件：${path}`)
  if (info.size > maxFileBytes) {
    throw new Error(`Office 文件超过 ${Math.round(maxFileBytes / 1024 / 1024)} MiB：${path}`)
  }
}

async function assertNotLocked(path: string): Promise<void> {
  const lockPath = join(dirname(path), `~$${basename(path)}`)
  if (await fileExists(lockPath)) {
    throw new Error(`检测到 Office 锁文件，文件可能正被打开：${lockPath}；请关闭 Office 后重试`)
  }
  let handle
  try {
    handle = await fs.open(path, 'r+')
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
      throw new Error(`文件正被其它程序占用：${path}；请关闭 Office 或占用它的程序后重试`)
    }
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function captureRequiredSnapshot(
  options: NodeOfficePortOptions,
  request: { sessionId?: string; toolCallId?: string },
  path: string,
  origin: 'office_edit' | 'office_export',
  logger: Logger,
): Promise<SnapshotWriteOutcome> {
  const snapshots = options.snapshots
  if (snapshots === undefined) {
    throw new Error('写前快照尚未装配，已拒绝覆盖已有文件')
  }
  const bytes = new Uint8Array(await fs.readFile(path))
  const result = await snapshots.capture({
    sessionId: request.sessionId ?? 'office',
    path,
    ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
    origin,
    mode: 'overwrite',
    bytes,
  })
  if (result.snapshot !== undefined) return { id: result.snapshot.id }
  const reason = result.skipped ?? 'unreadable'
  logger.warn('Office 覆盖前快照未成功，已拒绝写入', { path, reason })
  throw new Error(
    reason === 'too-large'
      ? '原文件超过 agent.snapshots.maxSnapshotBytes，已拒绝覆盖；请另存新文件或提高快照上限'
      : '写前快照不可用，已拒绝覆盖；请检查文件备份设置',
  )
}

async function replaceFile(tempPath: string, outputPath: string): Promise<void> {
  await fs.rename(tempPath, outputPath)
}

async function createRenderDir(root: string, sessionId: string | undefined): Promise<string> {
  const safeSession = (sessionId ?? 'office').replace(/[^\p{L}\p{N}._-]+/gu, '_')
  const dir = join(root, safeSession, `${Date.now()}-${randomUUID()}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function formatOf(path: string): OfficeFormat {
  const extension = extname(path).toLowerCase()
  if (extension === '.docx') return 'docx'
  if (extension === '.xlsx') return 'xlsx'
  if (extension === '.pptx') return 'pptx'
  throw new Error(`不支持的 Office 扩展名：${extension || '无扩展名'}（仅支持 .docx/.xlsx/.pptx）`)
}

function assertFormatMatchesPath(format: OfficeFormat, path: string): void {
  const actual = formatOf(path)
  if (actual !== format) {
    throw new Error(`格式与扩展名不一致：format=${format}，path=${path}`)
  }
}

function defaultSaveAsPath(sourcePath: string): string {
  const extension = extname(sourcePath)
  const base = basename(sourcePath, extension)
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return join(dirname(sourcePath), `${base}-Aurora-${stamp}${extension}`)
}

function defaultPdfPath(sourcePath: string): string {
  const extension = extname(sourcePath)
  return join(dirname(sourcePath), `${basename(sourcePath, extension)}.pdf`)
}

function tempPathFor(outputPath: string): string {
  const extension = extname(outputPath)
  const base = basename(outputPath, extension)
  return join(
    dirname(outputPath),
    `.${base}.aurora-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}${extension}`,
  )
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

async function lstatOrUndefined(path: string) {
  try {
    return await fs.lstat(path)
  } catch {
    return undefined
  }
}

async function statSize(path: string): Promise<number> {
  return (await fs.stat(path)).size
}
