/**
 * 外观自定义（v21，docs/08 §1）：把用户选的强调色主题应用到文档根。
 *
 * 四个窗口共用（`bootstrapApp` 统一接线，settings 任何一路落回都会经过
 * settings store 的 ref → 在那里统一调用）。`aurora`（默认）= 内置品牌蓝：
 * **移除**内联覆盖，让主题自己的明暗档规则生效；其余档位用内联样式覆盖
 * `--aurora-blue` —— `--aurora-gradient` / `--accent-*` / `--status-running`
 * 都引用它，会自动跟随，不需要逐个覆盖。
 */
const ACCENT_PRESETS = {
  aurora: '#0a84ff',
  teal: '#14b8a6',
  violet: '#8b5cf6',
  rose: '#f43f5e',
  amber: '#f59e0b',
} as const

export type AccentKey = keyof typeof ACCENT_PRESETS

export function applyAppearance(accent: string | undefined): void {
  const key = accent as AccentKey | undefined
  const root = document.documentElement.style
  if (key === undefined || key === 'aurora' || !(key in ACCENT_PRESETS)) {
    root.removeProperty('--aurora-blue')
    return
  }
  root.setProperty('--aurora-blue', ACCENT_PRESETS[key])
}
