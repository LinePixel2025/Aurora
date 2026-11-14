/**
 * 右栏「文件」面板五条通道共用的路径边界判定（2026-11-12，docs/07 §2.3）。
 *
 * 为什么不直接用 `resolveWithin`：它在**边界根不可用时是放行的**（`file-port.ts` 的
 * `resolveWorkspaceRoot` 拿不到根就 `return target`，那是给 Agent 文件工具的宽容口径 ——
 * 根没建好时至少还能读）。但右栏这几条是**渲染层主动发起的任意路径通道**，
 * 缺根时放行等于把整个用户目录敞给渲染层，所以这里必须缺根即拒。
 *
 * `preview:read` / `preview:list` / `preview:render` / `preview:renderPage` / `preview:open`
 * 全部走这一个函数 —— 判据只写一份，新增通道不会再漏掉边界。
 */
import { resolveWithin, isPathOutsideError, type WorkspaceGuardOptions } from './tools/file-port.js'

export interface PreviewPathPort {
  /** 会话边界根（`sessionProjects.boundaryRoot` 回落链）；返回 undefined = 无法确定边界 */
  rootOf(sessionId: string): string | undefined
}

export interface PreviewPath {
  /** `resolve()` 后的绝对路径（**不是** realpath 形态：回带路径与调用方写的一致） */
  path: string
  /** 本次判定用的边界根，调用方（如列目录）要回填给渲染层 */
  root: string
}

export async function assertPreviewPath(
  port: PreviewPathPort,
  request: { sessionId: string; path: string },
): Promise<PreviewPath> {
  const root = port.rootOf(request.sessionId)
  if (root === undefined || root.trim() === '') {
    throw new Error('当前会话没有可用的工作目录，无法确定文件边界；请先绑定项目或检查工作目录设置')
  }
  const path = typeof request.path === 'string' ? request.path.trim() : ''
  if (path === '') throw new Error('请输入要访问的文件路径')
  const guard: WorkspaceGuardOptions = { workspaceRoot: () => root }
  try {
    const resolved = await resolveWithin(path, false, guard, request.sessionId)
    return { path: resolved, root }
  } catch (error) {
    if (isPathOutsideError(error)) {
      throw new Error('该路径在当前会话的工作目录边界之外，不能访问')
    }
    throw error
  }
}
