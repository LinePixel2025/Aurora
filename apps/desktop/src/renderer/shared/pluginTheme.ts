/**
 * 插件主题令牌的应用 / 清理（docs/14 §3.4，P3）。
 *
 * 插件主题是**额外一层**内联 CSS 变量，必须叠在 `applyAppearance()` 之后：
 * 外观设置负责强调色与毛玻璃，插件只允许覆盖表面 / 文字 / 边框 / 圆角。
 * 切换前先清掉上一组变量，避免插件禁用后残留一份"幽灵主题"。
 */
import { PLUGIN_THEME_TOKENS, type PluginThemeInfo } from '@aurora/shared/browser'

const TOKEN_SET = new Set<string>(PLUGIN_THEME_TOKENS)

let applied: string[] = []

/** 应用（theme 为 null = 只清理）。返回实际写入的令牌名。 */
export function applyPluginTheme(root: HTMLElement, theme: PluginThemeInfo | null): string[] {
  for (const token of applied) root.style.removeProperty(token)
  applied = []
  if (theme === null) return applied
  for (const [token, value] of Object.entries(theme.tokens)) {
    if (!TOKEN_SET.has(token)) continue
    root.style.setProperty(token, value)
    applied.push(token)
  }
  return applied
}

/** 仅供测试 / 诊断：当前已写入的令牌。 */
export function appliedPluginThemeTokens(): string[] {
  return [...applied]
}
