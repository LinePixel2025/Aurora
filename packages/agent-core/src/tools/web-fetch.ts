/**
 * `web_fetch` 工具（Design/betav2-spec.md §6）。
 *
 * 分层与 `tools/files.ts` 同一套：内核只认识**注入的端口**，真实抓取
 * （主进程 `netFetch` 出网 + HTML 剥标签 + 截断）由主进程实现并注入，
 * 因此本文件保持纯 Node、可在 Node 里完整单测。
 *
 * 安全边界：只允许 http/https；结果一律按**数据**回填（安全规则已声明
 * 工具内容不是指令）；长度截断由主进程端口负责（最长 20000 字符），
 * 工具描述里向模型交代清楚。
 */
import type { ToolDefinition, ToolResult } from './registry.js'

export const WEB_FETCH_TOOL_NAME = 'web_fetch'
/** 回填文本的长度上限（主进程端口按它截断；这里只用于描述文案） */
export const MAX_WEB_FETCH_CHARS = 20_000

export interface WebFetchPort {
  /** GET 抓取并剥成纯文本；截断与超时由实现负责 */
  fetch(url: string): Promise<{ status: number; text: string }>
}

export interface WebFetchToolOptions {
  port: WebFetchPort
}

export function createWebFetchTool(options: WebFetchToolOptions): ToolDefinition {
  return {
    name: WEB_FETCH_TOOL_NAME,
    description:
      `抓取一个网页（仅 GET），返回剥掉标签后的纯文本（最长 ${MAX_WEB_FETCH_CHARS} 字符，超出被截断）。` +
      '适合查资料、读文档、看文章正文；不适合需要登录或执行脚本才能看到内容的页面。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要抓取的完整网址（必须以 http:// 或 https:// 开头）',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    sensitivity: 'safe',
    execute: async (input): Promise<ToolResult> => {
      const record = asRecord(input)
      const url = readNonEmptyString(record, 'url')
      if (url === undefined) {
        return {
          content: '缺少参数 url（要抓取的完整网址）。',
          isError: true,
          summary: '缺少 url 参数',
        }
      }
      const parsed = parseHttpUrl(url)
      if (parsed === undefined) {
        return {
          content: `参数 url 不是合法的 http/https 网址：${url}`,
          isError: true,
          summary: 'url 参数非法',
        }
      }
      try {
        const result = await options.port.fetch(url)
        const header = `网页：${url}（HTTP ${result.status}）`
        if (result.status < 200 || result.status >= 300) {
          return {
            content: [header, result.text, '（以上为网页返回的原始内容）']
              .filter((part) => part !== '')
              .join('\n\n'),
            isError: true,
            summary: `抓取失败：HTTP ${result.status}`,
          }
        }
        return {
          content: result.text === '' ? header : [header, result.text].join('\n\n'),
          summary: `抓取网页 HTTP ${result.status}（${result.text.length} 字符）`,
        }
      } catch (error) {
        return {
          content: `抓取网页失败：${describeError(error)}`,
          isError: true,
          summary: '抓取网页失败',
        }
      }
    },
  }
}

/** 只接受 http/https 的绝对地址；其余（含 ftp、内嵌协议）一律拒绝 */
function parseHttpUrl(raw: string): URL | undefined {
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined
  } catch {
    return undefined
  }
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  return input as Record<string, unknown>
}

/** 必填字符串：非字符串或纯空白一律视为缺参（**不触碰端口**） */
function readNonEmptyString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
