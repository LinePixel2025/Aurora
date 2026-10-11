/**
 * `set_appearance` 工具（v32；v33 增至四字段，docs/06 §12.1）。
 *
 * 分层与 `set_setting` 完全一致：本文件是**纯逻辑**，真实读写由主进程注入的
 * `SettingsToolPort` 负责（`main/tools/settings-port.ts`），因此内核不依赖 Electron，
 * 也能在 Node 里完整单测。
 *
 * 为什么单开一个工具而不是只靠 `set_setting`：
 * - **无路径**：参数是四个固定字段（枚举 / 布尔），模型不需要记住 `appearance.*` 的写法，
 *   也不可能借它写到别的配置路径上；
 * - **不弹确认卡**：四项都是纯视觉、即时可撤销，不碰文件 / 路径 / 凭据，
 *   因此 `sensitivity: 'safe'`（`set_setting` 保持 `confirm`，它能改的是一整片可写面）；
 * - **可读**：一个字段都不传 = 报告当前四项，模型想问"现在是什么主题"不必换工具。
 *
 * 安全边界：真正写盘前仍然逐条过 `port.writable()`（与 `set_setting` 同一条判定，
 * 用户在 `advanced.readonlyPrefixes` 里追加 `appearance` 时这里同样会被拒），
 * 并且**有一个不可写就整体拒绝**，绝不写一半。
 */
import {
  APPEARANCE_ACCENT_KEYS,
  APPEARANCE_THEME_MODES,
  createNoopLogger,
  type AppearanceAccent,
  type AppearanceTheme,
  type Logger,
} from '@aurora/shared'
import type { ToolDefinition, ToolResult } from './registry.js'
import type { SettingsToolPort } from './settings.js'

/** 工具名固定：主进程装配层按它注册 / 摘除（与 `SETTINGS_TOOL_NAME` 同处一个 sync）。 */
export const APPEARANCE_TOOL_NAME = 'set_appearance'

/** 四条可写路径：路径本身不在模型参数里，只在这里出现一次。 */
const PATHS = {
  theme: 'appearance.theme',
  accent: 'appearance.accent',
  glass: 'appearance.glass',
  awarenessGlow: 'appearance.awarenessGlow',
} as const

type AppearanceField = keyof typeof PATHS

/** 中文名与三档的可读说法（回填给模型 / 用户都读得懂）。 */
const FIELD_LABELS: Record<AppearanceField, string> = {
  theme: '明暗档位',
  accent: '强调色',
  glass: '毛玻璃',
  awarenessGlow: '流光特效',
}

const THEME_LABELS: Record<AppearanceTheme, string> = {
  system: '跟随系统',
  light: '亮色',
  dark: '暗色',
}

const ACCENT_LABELS: Record<AppearanceAccent, string> = {
  aurora: '品牌蓝',
  teal: '青',
  violet: '紫',
  rose: '玫瑰',
  amber: '琥珀',
}

export interface AppearanceToolOptions {
  port: SettingsToolPort
  logger?: Logger
}

export function createAppearanceTool(options: AppearanceToolOptions): ToolDefinition {
  const port = options.port
  const logger = options.logger ?? createNoopLogger()

  return {
    name: APPEARANCE_TOOL_NAME,
    description:
      '查看或修改 Aurora 的界面外观。四个字段都可选：theme（明暗档位：system 跟随系统 / light 亮色 / dark 暗色）、' +
      'accent（强调色：aurora 品牌蓝 / teal / violet / rose / amber）、glass（毛玻璃效果开关，' +
      'false = 窗口与面板变实色）、awarenessGlow（文件自感知的四周流光特效开关，false = 分析期间完全不出流光）。' +
      '**一个字段都不传**时只回报当前外观，不做修改。' +
      '改动即时生效、无需重启（四个窗口一起跟随，用户能立刻看到），完成后请如实告知用户改了什么。',
    parameters: {
      type: 'object',
      properties: {
        theme: {
          type: 'string',
          enum: [...APPEARANCE_THEME_MODES],
          description: '明暗档位：system 跟随系统外观，light 亮色，dark 暗色',
        },
        accent: {
          type: 'string',
          enum: [...APPEARANCE_ACCENT_KEYS],
          description: '强调色档位：aurora 品牌蓝（默认）/ teal / violet / rose / amber',
        },
        glass: {
          type: 'boolean',
          description: '毛玻璃效果：true 开启（默认），false 关闭（窗口与面板变实色）',
        },
        awarenessGlow: {
          type: 'boolean',
          description: '文件自感知的四周流光特效：true 开启（默认），false 关闭（分析期间完全不出流光）',
        },
      },
      additionalProperties: false,
    },
    sensitivity: 'safe',
    execute: async (input, ctx): Promise<ToolResult> => {
      try {
        const record = asRecord(input)
        const parsed = parseAppearance(record)
        if ('error' in parsed) return fail(parsed.error)

        // 一个字段都没给 = 读当前外观（工具同时承担"现在是什么档"的读取入口）
        if (parsed.changes.length === 0) {
          return {
            content: `当前外观：\n${(Object.keys(PATHS) as AppearanceField[])
              .map(
                (field) =>
                  `- ${FIELD_LABELS[field]}：${describeValue(field, port.read(PATHS[field]))}`,
              )
              .join('\n')}`,
            summary: '读取界面外观',
          }
        }

        // 先逐条预检可写性：有一个不行就整体拒绝（用户可能把 appearance 追加进了只读黑名单）
        for (const change of parsed.changes) {
          const check = port.writable(change.path)
          if (!check.ok) {
            logger.warn('外观修改被拒绝', {
              sessionId: ctx.sessionId,
              path: change.path,
              reason: check.reason,
            })
            return fail(`不能修改 ${change.path}：${check.reason}`, '外观修改被拒绝')
          }
        }

        logger.info('Agent 请求修改界面外观', {
          sessionId: ctx.sessionId,
          paths: parsed.changes.map((change) => change.path),
        })

        let outcome
        try {
          outcome = await port.write(parsed.changes)
        } catch (error) {
          // 端口抛错绝不允许冒泡进工具循环（那会中断整轮对话）
          logger.warn('外观写入失败', { sessionId: ctx.sessionId, error: describeError(error) })
          return fail(`写入失败：${describeError(error)}`, '外观写入失败')
        }
        if (!outcome.ok) {
          const message =
            outcome.message === '' ? '外观写入失败（端口未给出原因）' : outcome.message
          logger.warn('外观修改未生效', { sessionId: ctx.sessionId, message })
          return fail(message, '外观写入失败')
        }

        const applied = new Set(outcome.applied)
        const lines = (Object.keys(PATHS) as AppearanceField[]).map((field) => {
          const path = PATHS[field]
          const changed = parsed.changes.some((change) => change.path === path)
          const value = describeValue(field, port.read(path))
          if (!changed) return `- ${FIELD_LABELS[field]}：${value}（未改动）`
          return `- ${FIELD_LABELS[field]}：${value}${applied.has(path) ? '' : '（未生效）'}`
        })
        const changedLabels = parsed.changes
          .map((change) => FIELD_LABELS[pathField(change.path)])
          .join('、')
        return {
          content: `界面外观已更新（即时生效）：\n${lines.join('\n')}`,
          summary: `已更新界面外观（${changedLabels}）`,
        }
      } catch (error) {
        logger.warn('set_appearance 执行失败', { error: describeError(error) })
        return fail(`外观操作失败：${describeError(error)}`)
      }
    },
  }
}

type ParsedAppearance =
  { changes: Array<{ path: string; value: string | boolean }> } | { error: string }

/**
 * 解析三个可选字段。
 *
 * 只认**合法枚举 / 布尔**：模型给了枚举外的值就地失败（不写半个字段，也不把非法值丢给 Schema ——
 * 那会以「配置校验失败」这种看不出因果的文案回来）。
 */
function parseAppearance(record: Record<string, unknown> | undefined): ParsedAppearance {
  const changes: Array<{ path: string; value: string | boolean }> = []

  const theme = record?.['theme']
  if (theme !== undefined) {
    if (typeof theme !== 'string' || !isTheme(theme)) {
      return { error: `theme 只能是 ${APPEARANCE_THEME_MODES.join(' / ')} 之一。` }
    }
    changes.push({ path: PATHS.theme, value: theme })
  }

  const accent = record?.['accent']
  if (accent !== undefined) {
    if (typeof accent !== 'string' || !isAccent(accent)) {
      return { error: `accent 只能是 ${APPEARANCE_ACCENT_KEYS.join(' / ')} 之一。` }
    }
    changes.push({ path: PATHS.accent, value: accent })
  }

  const glass = record?.['glass']
  if (glass !== undefined) {
    if (typeof glass !== 'boolean') return { error: 'glass 只能是布尔值（true / false）。' }
    changes.push({ path: PATHS.glass, value: glass })
  }

  const awarenessGlow = record?.['awarenessGlow']
  if (awarenessGlow !== undefined) {
    if (typeof awarenessGlow !== 'boolean') {
      return { error: 'awarenessGlow 只能是布尔值（true / false）。' }
    }
    changes.push({ path: PATHS.awarenessGlow, value: awarenessGlow })
  }

  return { changes }
}

function isTheme(value: string): value is AppearanceTheme {
  return (APPEARANCE_THEME_MODES as readonly string[]).includes(value)
}

function isAccent(value: string): value is AppearanceAccent {
  return (APPEARANCE_ACCENT_KEYS as readonly string[]).includes(value)
}

/** 路径反查字段名（回填文案用；路径常量只有一份，这里只是它的逆查表）。 */
function pathField(path: string): AppearanceField {
  for (const field of Object.keys(PATHS) as AppearanceField[]) {
    if (PATHS[field] === path) return field
  }
  return 'theme'
}

/** 回填成中文可读值；读不到（配置还没加载等）如实说，不编默认值。 */
function describeValue(field: AppearanceField, value: unknown): string {
  if (value === undefined) return '（未设置）'
  if (field === 'theme') {
    return typeof value === 'string'
      ? (THEME_LABELS[value as AppearanceTheme] ?? value)
      : String(value)
  }
  if (field === 'accent') {
    return typeof value === 'string'
      ? (ACCENT_LABELS[value as AppearanceAccent] ?? value)
      : String(value)
  }
  return value === true ? '开启' : value === false ? '关闭' : String(value)
}

function fail(content: string, summary = '外观操作失败'): ToolResult {
  return { content, isError: true, summary }
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  return input as Record<string, unknown>
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
