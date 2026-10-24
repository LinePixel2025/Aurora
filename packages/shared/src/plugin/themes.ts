/**
 * 插件主题令牌白名单（docs/14 §3.4、docs/15 §6）。
 *
 * 只允许**表面 / 文字 / 边框 / 圆角 / 状态色**：强调色（`--aurora-blue`）与毛玻璃
 * （`--glass-*` / `--blur-*`）由用户的「外观」设置独占 —— 插件改这两类会让
 * 主题切换、可读性与全局观感失控，v1 明确不开放。
 */

/** 颜色类令牌（值必须是颜色字面量）。 */
export const PLUGIN_THEME_COLOR_TOKENS = [
  '--bg-base',
  '--bg-raised',
  '--bg-overlay',
  '--bg-glass',
  '--fill-1',
  '--fill-2',
  '--fill-3',
  '--border-subtle',
  '--border-strong',
  '--text-primary',
  '--text-secondary',
  '--text-muted',
  '--ok-text',
  '--ok-fill',
  '--error-text',
  '--error-fill',
  '--danger-text',
  '--danger-fill',
  '--selection-fill',
  '--scrollbar-hover',
] as const

/** 圆角类令牌（值必须是长度或 0）。 */
export const PLUGIN_THEME_RADIUS_TOKENS = [
  '--radius-xs',
  '--radius-sm',
  '--radius-md',
  '--radius-lg',
  '--radius-xl',
  '--radius-pill',
] as const

export const PLUGIN_THEME_TOKENS = [
  ...PLUGIN_THEME_COLOR_TOKENS,
  ...PLUGIN_THEME_RADIUS_TOKENS,
] as const

export type PluginThemeToken = (typeof PLUGIN_THEME_TOKENS)[number]

/** 单个主题的令牌上限（与清单 schema 一致）。 */
export const PLUGIN_THEME_MAX_TOKENS = 64

const COLOR_PATTERN =
  /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\(\s*(?:\d{1,3}%?\s*,\s*){2}\d{1,3}%?\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)|hsla?\(\s*-?\d{1,3}(?:deg)?\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\))$/i

const LENGTH_PATTERN = /^(?:0|\d+(?:\.\d+)?(?:px|rem|em|%))$/

function isColorToken(token: string): boolean {
  return (PLUGIN_THEME_COLOR_TOKENS as readonly string[]).includes(token)
}

function isRadiusToken(token: string): boolean {
  return (PLUGIN_THEME_RADIUS_TOKENS as readonly string[]).includes(token)
}

/**
 * 校验一组主题令牌；返回中文错误列表（空数组 = 通过）。
 * 渲染层在应用前也会调一次（不信任主进程之外来的数据）。
 */
export function validateThemeTokens(tokens: Record<string, string>): string[] {
  const errors: string[] = []
  const entries = Object.entries(tokens)
  if (entries.length > PLUGIN_THEME_MAX_TOKENS) {
    errors.push(`主题令牌不能超过 ${PLUGIN_THEME_MAX_TOKENS} 个`)
  }
  for (const [token, value] of entries) {
    if (!isColorToken(token) && !isRadiusToken(token)) {
      errors.push(`不允许覆盖令牌 ${token}`)
      continue
    }
    if (isColorToken(token) && !COLOR_PATTERN.test(value.trim())) {
      errors.push(`令牌 ${token} 的值不是合法颜色`)
      continue
    }
    if (isRadiusToken(token) && !LENGTH_PATTERN.test(value.trim())) {
      errors.push(`令牌 ${token} 的值必须是长度（如 12px）`)
    }
  }
  return errors
}

/** 渲染层「应用主题」时的安全取值：校验不通过就整组丢弃（不做部分应用）。 */
export function sanitizeThemeTokens(tokens: Record<string, string>): Record<string, string> {
  if (validateThemeTokens(tokens).length > 0) return {}
  const result: Record<string, string> = {}
  for (const [token, value] of Object.entries(tokens)) result[token] = value.trim()
  return result
}
