/**
 * `screenshot` 工具（图像工具，docs/06 §25）。
 *
 * 分层同一套：内核只认识注入的端口，真实截屏（Electron `desktopCapturer` + `screen`）
 * 与落盘由主进程实现并注入，本文件保持纯 Node 可单测。
 *
 * 安全边界：屏幕内容是最敏感的一类隐私（可能正开着密码管理器 / 私信），因此
 * `sensitivity: 'confirm'`，逐次过 `confirmTool` 钩子 —— 与 `clipboard_read` 同款口径。
 */
import type { ToolDefinition, ToolImage, ToolResult } from './registry.js'

export const SCREENSHOT_TOOL_NAME = 'screenshot'

/** 截屏范围：主显示器（缺省）或全部显示器。 */
export type ScreenshotDisplay = 'primary' | 'all'

export interface ScreenshotPort {
  /**
   * 截屏并在落盘后返回路径与图片内容；失败直接抛错（工具层折成错误结果）。
   *
   * 返回**数组**：`all` 时每个显示器各一张（Electron 的 `desktopCapturer` 一张缩略图
   * 只能对应一个屏，拼接需要额外的图像合成，而多屏各自的原始分辨率更有用）。
   * 空数组 = 一块屏都没截到（调用方按失败处理）。
   */
  capture(input: { display: ScreenshotDisplay }): Promise<ToolImage[]>
}

export interface ScreenshotToolOptions {
  port: ScreenshotPort
}

export function createScreenshotTool(options: ScreenshotToolOptions): ToolDefinition {
  return {
    name: SCREENSHOT_TOOL_NAME,
    description:
      '截取当前屏幕并把截图交给你看（默认主显示器，display 传 all 可截全部显示器，每块屏一张图）。' +
      '截屏会弹确认卡片请求用户批准；适合回答「屏幕上是什么」「帮我看看这个报错」这类问题。',
    parameters: {
      type: 'object',
      properties: {
        display: {
          type: 'string',
          description: '截屏范围：primary（主显示器，缺省）或 all（全部显示器，每块屏一张图）',
          enum: ['primary', 'all'],
        },
      },
      required: [],
      additionalProperties: false,
    },
    sensitivity: 'confirm',
    execute: async (input): Promise<ToolResult> => {
      const record = asRecord(input)
      const raw = record?.['display']
      if (raw !== undefined && raw !== 'primary' && raw !== 'all') {
        return {
          content: `参数 display 只能是 primary 或 all（实际收到 ${JSON.stringify(raw)}）。`,
          isError: true,
          summary: 'display 参数非法',
        }
      }
      const display: ScreenshotDisplay = raw === 'all' ? 'all' : 'primary'

      try {
        const shots = await options.port.capture({ display })
        if (shots.length === 0) {
          return { content: '截屏失败：没有截到任何屏幕。', isError: true, summary: '截屏失败' }
        }
        const paths = shots.map((shot) => shot.path)
        return {
          content:
            `已截屏并保存到 ${paths.join('；')}` +
            '（图片内容随本条结果一起提供，请直接看图作答）。',
          summary: shots.length === 1 ? '已截屏' : `已截屏 ${shots.length} 块屏幕`,
          images: shots,
        }
      } catch (error) {
        return {
          content: `截屏失败：${describeError(error)}`,
          isError: true,
          summary: '截屏失败',
        }
      }
    },
  }
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  return input as Record<string, unknown>
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
