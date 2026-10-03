/**
 * 对话图片展示的主进程实现（docs/06 §14）。
 *
 * `show_image` 与 `generate_image` 共用这里：校验图片路径、格式与大小，生成无路径
 * 元数据；渲染层 / Center 之后只按 `imageId` 读取 data URL，不接触本机路径。
 */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import type { ImageDisplayPort, ToolDisplayImage } from '@aurora/agent-core'
import type { Logger } from '@aurora/shared'
import { resolveWithin } from './file-port.js'

export const MAX_DISPLAY_IMAGE_BYTES = 10 * 1024 * 1024

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}

export interface ImageDisplayPortDeps {
  /** 会话工作目录（相对路径基准；子代理由装配层剥回父会话） */
  workspaceDirOf: (sessionId: string) => string
  /** 会话边界根；为空 / 不存在时不允许任意路径 */
  boundaryRootOf: (sessionId: string) => string | undefined
  /** Aurora 自有图片目录（generated / screenshots / clipboard） */
  ownedDirs: readonly string[]
  logger: Logger
}

export function createImageDisplayPort(deps: ImageDisplayPortDeps): ImageDisplayPort {
  return {
    async prepareImage(input): Promise<ToolDisplayImage> {
      const target = isAbsolute(input.path)
        ? resolve(input.path)
        : resolve(deps.workspaceDirOf(input.sessionId), input.path)
      const allowed = await isAllowedDisplayPath(target, input.sessionId, deps)
      if (!allowed) {
        throw new Error(
          '该图片在当前会话的工作目录之外，无法展示；请把图片放到项目文件夹内，' +
            '或先由 Aurora 生成后再展示',
        )
      }
      return buildDisplayImage(target, input.caption, deps.logger)
    },
    async readImage(input) {
      const target = resolve(input.path)
      // imageId 只能命中会话里登记过的工具卡，调用方无法传任意路径；
      // 读取时仍做格式 / 大小 / 文件存在性校验。项目绑定后续变化不应让已登记成果失效。
      return readDisplayImageDataUrl(target)
    },
  }
}

/**
 * 图像生成端口生成成功后调用：路径应当来自 Aurora 自有 generated 目录，
 * 但这里仍复用同一套校验，避免未来改落盘位置后绕过格式 / 大小检查。
 */
export async function buildDisplayImage(
  path: string,
  caption: string | undefined,
  logger?: Logger,
): Promise<ToolDisplayImage> {
  let stat
  try {
    stat = await fs.stat(path)
  } catch {
    throw new Error('图片文件不存在或不可读')
  }
  if (!stat.isFile()) throw new Error('目标不是普通文件')
  if (stat.size > MAX_DISPLAY_IMAGE_BYTES) {
    throw new Error(
      `图片大小 ${(stat.size / 1024 / 1024).toFixed(1)} MB 超过展示上限 ${(
        MAX_DISPLAY_IMAGE_BYTES /
        1024 /
        1024
      ).toFixed(0)} MB`,
    )
  }
  const ext = extname(path).toLowerCase()
  const mime = MIME_BY_EXTENSION[ext]
  if (mime === undefined) {
    throw new Error(`不支持的图片格式：${ext === '' ? '无扩展名' : ext}`)
  }
  logger?.info('对话图片已登记展示', { path, bytes: stat.size, mime })
  return {
    id: randomUUID(),
    path,
    name: basename(path),
    mime,
    ...(caption === undefined || caption.trim() === '' ? {} : { caption: caption.trim() }),
  }
}

export async function readDisplayImageDataUrl(path: string): Promise<{
  dataUrl: string
  name: string
  mime: string
}> {
  const image = await buildDisplayImage(path, undefined)
  const bytes = await fs.readFile(path)
  return {
    dataUrl: `data:${image.mime};base64,${bytes.toString('base64')}`,
    name: image.name,
    mime: image.mime,
  }
}

async function isAllowedDisplayPath(
  path: string,
  sessionId: string,
  deps: ImageDisplayPortDeps,
): Promise<boolean> {
  const declaredBoundary = deps.boundaryRootOf(sessionId)
  if (declaredBoundary !== undefined && (await isExistingDirectory(declaredBoundary))) {
    if (await isWithin(path, declaredBoundary, sessionId)) return true
  }
  for (const owned of deps.ownedDirs) {
    if (!(await isExistingDirectory(owned))) continue
    if (await isWithin(path, owned, sessionId)) return true
  }
  return false
}

async function isWithin(path: string, root: string, sessionId: string): Promise<boolean> {
  try {
    await resolveWithin(path, false, { workspaceRoot: () => root }, sessionId)
    return true
  } catch {
    return false
  }
}

async function isExistingDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory()
  } catch {
    return false
  }
}
