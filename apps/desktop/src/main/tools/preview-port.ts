/**
 * `PreviewPort` 的主进程实现（2026-10-03，docs/06 §14）：把内核的「展示这个目标」
 * 变成一次**受校验的**推送 —— 右栏「浏览器」tab 加载它。
 *
 * 目标校验（与 `file-preview.ts` / `file-list.ts` 同源）：
 * - `http(s)://` 直接放行（其它协议，含 `file:` 与 `javascript:`，在这里就被拒）；
 * - 其余按**本地文件**处理：相对路径以会话工作目录为基准，且必须落在会话**边界根**之内
 *   （复用 `resolveWithin` 的 realpath 前缀校验，与文件工具同一道闸门）；
 * - 文件必须存在且是普通文件；通过后转成 `file://` URL 交给渲染层。
 *
 * 本文件不 import electron：推送动作由装配层以 `present` 注入（那里才有窗口管理器）。
 */
import { promises as nodeFs } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parentSessionIdOf, type PreviewPort, type PreviewShowOutcome } from '@aurora/agent-core'
import type { Logger } from '@aurora/shared'
import { resolveWithin, isPathOutsideError, type WorkspaceGuardOptions } from './file-port.js'

/** 交给渲染层的展示请求（与 `@aurora/shared` 的 `PreviewShowEvent` 同形） */
export interface PreviewPresentPayload {
  sessionId: string
  url: string
  display: string
  title: string
}

export interface PreviewPortDeps {
  /** 会话**工作目录**（相对路径的解析基准；子代理由装配层剥回父会话） */
  workspaceDirOf: (sessionId: string) => string
  /** 会话**边界根**（本地文件必须落在其内；子代理由装配层剥回父会话） */
  boundaryRootOf: (sessionId: string | undefined) => string | undefined
  /** 把展示请求推给渲染层（装配层负责 showChat + 通道推送） */
  present: (payload: PreviewPresentPayload) => void
  logger: Logger
}

const URL_PATTERN = /^https?:\/\//i

export function createPreviewPort(deps: PreviewPortDeps): PreviewPort {
  return {
    async show(target, options): Promise<PreviewShowOutcome> {
      const trimmed = target.trim()
      if (trimmed === '') throw new Error('缺少要展示的目标（网址或文件路径）')

      if (URL_PATTERN.test(trimmed)) {
        let url: URL
        try {
          url = new URL(trimmed)
        } catch {
          throw new Error(`网址无法解析：${trimmed}`)
        }
        const href = url.toString()
        deps.present({
          sessionId: parentSessionIdOf(options.sessionId),
          url: href,
          display: href,
          title: options.title,
        })
        deps.logger.info('show_preview：已推送到右栏预览', { kind: 'url', url: href })
        return { url: href, display: href }
      }

      const root = deps.boundaryRootOf(options.sessionId)
      if (root === undefined || root.trim() === '') {
        throw new Error('当前会话没有可用的工作目录，无法展示本地文件；请先绑定项目')
      }
      const path = isAbsolute(trimmed)
        ? resolve(trimmed)
        : resolve(deps.workspaceDirOf(options.sessionId), trimmed)
      const guard: WorkspaceGuardOptions = { workspaceRoot: () => root }
      try {
        await resolveWithin(path, false, guard, options.sessionId)
      } catch (error) {
        if (isPathOutsideError(error)) {
          throw new Error(
            '该文件在当前会话的工作目录边界之外，不能展示（请把产物写在项目文件夹内）',
          )
        }
        throw error
      }
      const stat = await nodeFs.stat(path).catch(() => undefined)
      if (stat === undefined || !stat.isFile()) throw new Error('文件不存在或不是普通文件')

      const url = pathToFileURL(path).toString()
      deps.present({
        sessionId: parentSessionIdOf(options.sessionId),
        url,
        display: path,
        title: options.title,
      })
      deps.logger.info('show_preview：已推送到右栏预览', { kind: 'file', path })
      return { url, display: path }
    },
  }
}
