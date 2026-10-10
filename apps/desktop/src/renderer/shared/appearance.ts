/**
 * 外观自定义（v21 强调色；v32 扩为「明暗档位 / 强调色 / 毛玻璃」三件套，docs/08 §1）。
 *
 * 四个窗口共用（`bootstrapApp` 统一接线，settings 任何一路落回都会经过
 * settings store 的 ref → 在那里统一调用）。
 *
 * 三件套各自落在哪一层，别搞混：
 * - **强调色**：这里写内联 `--aurora-blue` —— `aurora`（默认）= 内置品牌蓝，
 *   **移除**内联覆盖，让主题自己的明暗档规则生效；其余档位用内联样式覆盖
 *   `--aurora-blue` —— `--aurora-gradient` / `--accent-*` / `--status-running`
 *   都引用它，会自动跟随，不需要逐个覆盖。
 * - **毛玻璃**：这里在文档根挂 `data-glass`，具体降级令牌在 `browser/theme.css`
 *   （`:root[data-glass='off']`，与 `prefers-reduced-transparency` 同一份口径）；
 *   原生 Acrylic 那半由主进程 `WindowManager.applyGlass()` 摘掉，两侧同一份配置驱动。
 * - **明暗档位**：**不经过这里** —— 主进程把它写到 `nativeTheme.themeSource`，
 *   渲染层照旧只读 `prefers-color-scheme`（没有 `data-theme` 属性，别引入第二套口径）。
 */
const ACCENT_PRESETS = {
  aurora: '#0a84ff',
  teal: '#14b8a6',
  violet: '#8b5cf6',
  rose: '#f43f5e',
  amber: '#f59e0b',
} as const

export type AccentKey = keyof typeof ACCENT_PRESETS

/** 与 `AppearanceSchema` 同形的宽松入参：只取本模块关心的两个字段，允许缺省。 */
export interface AppearanceInput {
  accent?: string | undefined
  glass?: boolean | undefined
}

/** 把外观应用到文档根；`undefined`（配置还没加载）按默认档处理。 */
export function applyAppearance(appearance: AppearanceInput | undefined): void {
  const style = document.documentElement.style
  const key = appearance?.accent as AccentKey | undefined
  if (key === undefined || key === 'aurora' || !(key in ACCENT_PRESETS)) {
    style.removeProperty('--aurora-blue')
  } else {
    style.setProperty('--aurora-blue', ACCENT_PRESETS[key])
  }
  // 显式写 'on' 而不是删属性：样式与探针都能读到确定态（关闭时才是 'off'）。
  document.documentElement.setAttribute('data-glass', appearance?.glass === false ? 'off' : 'on')
}
