/**
 * 右栏「文件」面板把目标交给系统（2026-11-12，docs/07 §2.3）。
 *
 * 两个 mode：`default` = 系统默认程序打开（要求普通文件）、`reveal` = 资源管理器定位
 * （允许目录）。边界判定与 `preview:read` **共用 `assertPreviewPath`** —— 这是渲染层
 * 主动发起的通道，缺根即拒、越界即拒。
 *
 * 这是**用户直接点击的手动操作面**（同 `plugins:openLog` 口径）：不走工具确认闸门，
 * 也不暴露给 Agent —— Agent 侧的 `open_path` 是另一条带 confirm 的工具。
 *
 * `shell` 由调用方注入，因此本模块可在 vitest 里直接测（不必加载 electron）。
 */
import { promises as nodeFs } from 'node:fs'
import { assertPreviewPath, type PreviewPathPort } from './preview-path.js'

export interface FileOpenShell {
  /** Electron 约定：返回**非空字符串**即失败原因，空串才是成功 */
  openPath(path: string): Promise<string>
  showItemInFolder(path: string): void
}

export async function openWithSystem(
  port: PreviewPathPort,
  shellApi: FileOpenShell,
  request: { sessionId: string; path: string; mode: 'default' | 'reveal' },
  timeoutMs = OPEN_TIMEOUT_MS,
): Promise<void> {
  const { path } = await assertPreviewPath(port, request)

  const stat = await nodeFs.lstat(path).catch(() => undefined)
  if (stat === undefined) throw new Error('文件不存在或无法访问')
  if (stat.isSymbolicLink()) throw new Error('不支持打开符号链接')

  if (request.mode === 'reveal') {
    shellApi.showItemInFolder(path)
    return
  }

  if (!stat.isFile()) throw new Error('不是普通文件（目录 / 设备等无法用默认程序打开）')
  const failure = await openWithTimeout(shellApi, path, timeoutMs)
  if (failure !== '') throw new Error(`系统无法打开该文件：${failure}`)
}

/**
 * `shell.openPath` 的 Promise 由目标程序启动完成才结算 —— 没有关联程序时 Windows 会弹
 * 「选取应用」模态，实测这个 Promise 可以**一直不回来**（2026-11-14），面板的「打开」
 * 按钮就会永远停在禁用态。超时后按失败报出来，把控制权还给用户。
 */
export const OPEN_TIMEOUT_MS = 10_000

async function openWithTimeout(
  shellApi: FileOpenShell,
  path: string,
  timeoutMs: number,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve('等待系统响应超时，可在资源管理器中手动打开'), timeoutMs)
  })
  try {
    return await Promise.race([shellApi.openPath(path), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
