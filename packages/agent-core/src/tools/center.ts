/**
 * Aurora Center 工具组（docs/06 §22.1、docs/12 §8）。
 *
 * 分层与 `tools/notify.ts` 同一套：内核只认识**注入的 CenterPort**，
 * 真实连接状态与文件上传由主进程的 CenterConnector 实现并注入，本文件保持
 * 纯 Node 可单测。
 *
 * 门控口径（装配层负责，见 main/tools/index.ts）：`center.enabled` 且
 * `center.serverUrl` 非空**才注册**（未配置时连工具都不出现，与 STT/TTS 同口径）；
 * **不受** `agent.tools.enabled` 门控（与扩展工具五件套同口径）。
 * `center_send_file` 是对外发送文件的动作，`sensitivity: 'confirm'` 逐次确认。
 */
import { promises as fs } from 'node:fs'
import type { ToolDefinition, ToolResult } from './registry.js'

export const CENTER_STATUS_TOOL_NAME = 'center_status'
export const CENTER_SEND_FILE_TOOL_NAME = 'center_send_file'

export interface CenterStatusInfo {
  enabled: boolean
  /** 与 Aurora Center 的长连状态（未启用时为 false） */
  connected: boolean
  serverUrl: string
  /** 本客户端在 Center 展示的名字（未配置时为主机名，由主进程解析） */
  displayName: string
}

export interface CenterSendResult {
  fileId: string
  name: string
  size: number
  /** Center 网页端的相对下载路径（`/api/files/<id>`） */
  url: string
}

export interface CenterPort {
  status(): CenterStatusInfo
  /**
   * 上传本地文件到 Center；实现方负责鉴权与重试。
   * 文件不存在 / 超过大小上限时抛错（本工具在调用前会做一遍同样的预检）。
   */
  sendFile(path: string, note?: string): Promise<CenterSendResult>
}

export interface CenterToolOptions {
  port: CenterPort
  /** 单文件上传上限（字节）；每次调用即时读取，设置热改立即生效 */
  maxFileBytes: () => number
  /** `center.allowFileTransfer` 关闭时 `center_send_file` 明确拒绝而不是消失（工具表保持稳定） */
  fileTransferEnabled: () => boolean
}

export function createCenterStatusTool(options: CenterToolOptions): ToolDefinition {
  return {
    name: CENTER_STATUS_TOOL_NAME,
    description:
      '查询与 Aurora Center（网页控制中心）的连接状态：是否启用、是否在线、服务器地址与本机展示名。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    sensitivity: 'safe',
    execute: async (): Promise<ToolResult> => {
      const status = options.port.status()
      if (!status.enabled) {
        return {
          content: 'Aurora Center 未启用（设置页里没有开启连接）。',
          summary: 'Center 未启用',
        }
      }
      const line = status.connected
        ? `已连接到 Aurora Center：${status.serverUrl}（本机展示名：${status.displayName}）`
        : `Aurora Center 已启用但当前离线：${status.serverUrl}（会自动重连）`
      return { content: line, summary: status.connected ? 'Center 在线' : 'Center 离线' }
    },
  }
}

export function createCenterSendFileTool(options: CenterToolOptions): ToolDefinition {
  return {
    name: CENTER_SEND_FILE_TOOL_NAME,
    description:
      '把本机的一个文件上传到 Aurora Center，让网页端用户直接下载。适合远程会话里用户索要文件、' +
      '把工作产物交付给网页端等场景。单个文件有大小上限，超限会被拒绝。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要发送的文件的绝对路径' },
        note: { type: 'string', description: '一句话说明（可选），随文件展示在网页端' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    sensitivity: 'confirm',
    execute: async (input): Promise<ToolResult> => {
      const record = asRecord(input)
      const path = readNonEmptyString(record, 'path')
      if (path === undefined) {
        return {
          content: '缺少参数：path（要发送的文件的绝对路径）。',
          isError: true,
          summary: '发送文件参数缺失',
        }
      }
      if (!options.fileTransferEnabled()) {
        return {
          content:
            '文件发送已被禁用（center.allowFileTransfer = false）。请用户在设置页开启后再试。',
          isError: true,
          summary: '文件发送已禁用',
        }
      }
      let stat
      try {
        stat = await fs.stat(path)
      } catch {
        return {
          content: `文件不存在或不可访问：${path}`,
          isError: true,
          summary: '文件不存在',
        }
      }
      if (!stat.isFile()) {
        return { content: `路径不是普通文件：${path}`, isError: true, summary: '不是文件' }
      }
      const max = Math.max(1, options.maxFileBytes())
      if (stat.size > max) {
        return {
          content: `文件大小 ${(stat.size / 1024 / 1024).toFixed(1)} MB 超过上限 ${(
            max /
            1024 /
            1024
          ).toFixed(0)} MB。`,
          isError: true,
          summary: '文件超过上限',
        }
      }
      const note = readNonEmptyString(record, 'note')
      try {
        const result = await options.port.sendFile(path, note)
        return {
          content: `已发送到 Aurora Center：${result.name}（${(result.size / 1024).toFixed(1)} KB，fileId=${result.fileId}）。网页端用户现在可以直接下载。`,
          summary: `已发送 ${result.name}`,
        }
      } catch (error) {
        return {
          content: `发送失败：${describeError(error)}`,
          isError: true,
          summary: '发送失败',
        }
      }
    },
  }
}

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
