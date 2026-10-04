/**
 * `OfficePort` 的主进程实现：路径边界、文件锁检查、worker 调用与原子替换。
 *
 * worker 只负责生成 / patch 与写临时文件；主进程负责把临时文件换到最终路径。
 * 因此任何解析失败、超时或崩溃都不会留下半截目标文件。
 */
import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { createNoopLogger, type Logger } from '@aurora/shared'
import type {
  OfficeCreateRequest,
  OfficeEditRequest,
  OfficeFormat,
  OfficePort,
  OfficeReadRequest,
  OfficeReadResult,
  OfficeWriteResult,
  SnapshotWriteOutcome,
} from '@aurora/agent-core'
import type { SnapshotPort } from '@aurora/agent-core'
import { resolveWithin, type OutsideOption, type WorkspaceGuardOptions } from './file-port.js'
import type { OfficePool } from '../office-pool.js'
import type { OfficeWorkerResponse, OfficeWorkerRunRequest } from '../office-protocol.js'

export interface NodeOfficePortOptions extends WorkspaceGuardOptions {
  pool: OfficePool
  snapshots?: Pick<SnapshotPort, 'capture'>
  logger?: Logger
  maxFileBytes?: number
}

export const DEFAULT_MAX_OFFICE_FILE_BYTES = 64 * 1024 * 1024

export function createNodeOfficePort(options: NodeOfficePortOptions): OfficePort {
  const logger = options.logger ?? createNoopLogger()
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_OFFICE_FILE_BYTES
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
        path: absolutePath,
        format,
        ...(request.target === undefined ? {} : { target: request.target }),
        offset: request.offset ?? 0,
        limit: request.limit ?? 80,
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
      const content =
        request.content === undefined
          ? undefined
          : await resolveOfficeAssets(request.content, request, guard)
      await fs.mkdir(dirname(outputPath), { recursive: true })
      const tempPath = tempPathFor(outputPath)
      try {
        const response = await runWorker(options.pool, {
          action: 'create',
          outputPath: tempPath,
          format: request.format,
          ...(content === undefined ? {} : { content }),
          ...(templatePath === undefined ? {} : { templatePath }),
          ...(request.templateData === undefined ? {} : { templateData: request.templateData }),
        })
        const bytes = response.write?.bytes ?? (await statSize(tempPath))
        const snapshot = exists
          ? await captureRequiredSnapshot(options, request, outputPath, logger)
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
      const outputPath =
        request.overwrite === true
          ? sourcePath
          : request.saveAs === undefined
            ? defaultSaveAsPath(sourcePath)
            : await resolve(request.saveAs, request)
      assertFormatMatchesPath(format, outputPath)
      const sameOutput = outputPath.toLowerCase() === sourcePath.toLowerCase()
      if (sameOutput && request.overwrite !== true) {
        throw new Error('saveAs 指向源文件；如需覆盖源文件请显式传 overwrite=true')
      }
      if (!sameOutput && (await fileExists(outputPath)) && request.overwrite !== true) {
        throw new Error(`另存目标已存在：${outputPath}；请换一个 saveAs，或显式传 overwrite=true`)
      }
      if (!sameOutput && (await fileExists(outputPath))) {
        await assertNotLocked(outputPath)
      }
      await fs.mkdir(dirname(outputPath), { recursive: true })
      const tempPath = tempPathFor(outputPath)
      try {
        const response = await runWorker(options.pool, {
          action: 'edit',
          sourcePath,
          outputPath: tempPath,
          format,
          operations: request.operations,
        })
        const bytes = response.write?.bytes ?? (await statSize(tempPath))
        const outputExists = await fileExists(outputPath)
        const snapshot = outputExists
          ? await captureRequiredSnapshot(options, request, outputPath, logger)
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
  }
}

async function runWorker(
  pool: OfficePool,
  request: OfficeWorkerRunRequest,
): Promise<OfficeWorkerResponse & { ok: true }> {
  const response = await pool.run(request)
  if (!response.ok) throw new Error(response.error ?? 'Office worker 执行失败')
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
  logger: Logger,
): Promise<SnapshotWriteOutcome> {
  const snapshots = options.snapshots
  if (snapshots === undefined) {
    throw new Error('写前快照尚未装配，已拒绝覆盖已有 Office 文件')
  }
  const bytes = new Uint8Array(await fs.readFile(path))
  const result = await snapshots.capture({
    sessionId: request.sessionId ?? 'office',
    path,
    ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
    origin: 'office_edit',
    mode: 'overwrite',
    bytes,
  })
  if (result.snapshot !== undefined) return { id: result.snapshot.id }
  const reason = result.skipped ?? 'unreadable'
  logger.warn('Office 覆盖前快照未成功，已拒绝写入', { path, reason })
  throw new Error(
    reason === 'too-large'
      ? '原文件超过 agent.snapshots.maxSnapshotBytes，已拒绝原地覆盖；请另存新文件或提高快照上限'
      : '写前快照不可用，已拒绝原地覆盖；请检查文件备份设置',
  )
}

async function replaceFile(tempPath: string, outputPath: string): Promise<void> {
  await fs.rename(tempPath, outputPath)
}

async function resolveOfficeAssets(
  value: unknown,
  request: OutsideOption,
  guard: WorkspaceGuardOptions,
): Promise<unknown> {
  if (Array.isArray(value)) {
    return await Promise.all(value.map((item) => resolveOfficeAssets(item, request, guard)))
  }
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  const isImageBlock =
    record['type'] === 'image' ||
    (typeof record['path'] === 'string' && record['imageType'] !== undefined)
  for (const [key, child] of Object.entries(record)) {
    if (
      (isImageBlock && key === 'path') ||
      (key === 'image' && typeof child === 'object' && child !== null)
    ) {
      if (key === 'path' && typeof child === 'string') {
        out[key] = await resolveOfficePath(child, request, guard)
        continue
      }
      const image = child as Record<string, unknown>
      if (typeof image['path'] === 'string') {
        out[key] = {
          ...((await resolveOfficeAssets(image, request, guard)) as Record<string, unknown>),
          path: await resolveOfficePath(image['path'], request, guard),
        }
        continue
      }
    }
    out[key] = await resolveOfficeAssets(child, request, guard)
  }
  return out
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

function tempPathFor(outputPath: string): string {
  return `${outputPath}.${process.pid}.${Date.now()}.office.tmp`
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
