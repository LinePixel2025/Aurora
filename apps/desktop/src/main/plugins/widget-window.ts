/**
 * 桌面小组件窗口的纯函数判定（docs/14 §5.3，v37）—— **不 import electron**。
 *
 * 为什么单独拆出来：层级 / 材质 / 圆角 shape 都是「清单声明 + 用户覆盖 + 平台能力」
 * 的纯算术，而 `widgets.ts` 是唯一 import electron 的 widget 访问层（主进程测试不允许
 * 加载 electron），放在那里就没法用 vitest 覆盖。
 *
 * 三个判定各只有一处口径，`widgets.ts` 与本文件测试共用，别再手抄一份：
 * - 层级：`windowLevelOverride` 优先，缺省跟随清单 `windowLevel`；
 * - 材质：`acrylic` 声明 + 外观毛玻璃开启 + win32 三个条件同时成立才挂；
 * - shape：材质按窗口区域裁剪，圆角必须用区域也切出来（与 edge-bar 同一套阶梯算法）。
 */
import type { PluginWidgetWindowLevel, PluginWidgetWindowMaterial } from '@aurora/shared'

/** 窗口矩形（DIP / 窗口坐标），与 `widget-layout.ts` 的同形状结构兼容。 */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 小组件卡片圆角半径，与 `packages/shared/src/browser/theme.css` 的 `--radius-lg: 20px` 同值。
 *
 * 原生 Acrylic 按**窗口区域**裁剪（见 edge-bar 的实测记忆）：不把区域也切成圆角，
 * 卡片矩形四角被 CSS 圆角让出的三角就会露出矩形材质。CSS 的 `--radius-lg` 与这里的
 * `WIDGET_CARD_RADIUS` 是同一条弧，改一处必须同时改另一处。
 */
export const WIDGET_CARD_RADIUS = 20

/**
 * 实际窗口层级：用户覆盖优先，缺省跟随清单声明。
 *
 * `windowLevelOverride` 只存 `floating | normal | desktop`（`auto` 在 IPC 层翻译成删除字段），
 * 因此这里不再做兜底判定 —— 读取布局时已经丢弃非法值（`parseWidgetLayout`）。
 */
export function resolveWidgetWindowLevel(
  declared: PluginWidgetWindowLevel,
  override: PluginWidgetWindowLevel | undefined,
): PluginWidgetWindowLevel {
  return override ?? declared
}

/**
 * 是否挂原生 Acrylic 材质：声明的 `acrylic` 只是**意图**，还要外观毛玻璃开启且平台是 win32。
 *
 * 条件不成立时保持现有不透明卡片（渲染层按 `materialActive` 决定用玻璃令牌还是实底），
 * 避免出现「材质没挂上、窗口又是透明的」裸漏桌面。
 */
export function shouldUseWidgetMaterial(
  declared: PluginWidgetWindowMaterial,
  glassAllowed: boolean,
  platform: NodeJS.Platform,
): boolean {
  return declared === 'acrylic' && glassAllowed && platform === 'win32'
}

/**
 * 把矩形切成**四角 1px 阶梯**的圆角区域，返回若干矩形（窗口坐标）。
 *
 * 与 `edge-bar-geometry.ts` 的 `roundLeftCorners` 是同一套算法，区别是这里四角都切：
 * 逐行取圆方程的水平内缩量（左右对称），把连续相同内缩量的行合并成一个矩形，中间整宽。
 * 20px 半径约 12 块/角、共 25 块；半径按窗口宽高夹取，退化尺寸（`r === 0`）直接返回原矩形。
 *
 * 只在原生材质开启时使用：材质由 DWM 按窗口区域裁剪，区域即卡片圆角。
 */
export function widgetRoundedShape(rect: Rect, radius: number): Rect[] {
  const width = Math.max(0, rect.width)
  const height = Math.max(0, rect.height)
  const r = Math.max(0, Math.min(Math.floor(radius), Math.floor(width / 2), Math.floor(height / 2)))
  if (r === 0 || rect.width <= 0 || rect.height <= 0) return [rect]

  /** 距上（或下）边缘 row 行处，圆在该行的水平内缩量（左右对称） */
  const insetAt = (row: number): number => {
    const dy = r - (row + 0.5)
    return Math.round(r - Math.sqrt(Math.max(0, r * r - dy * dy)))
  }

  const out: Rect[] = []
  const rowsFrom = (edge: 'top' | 'bottom'): void => {
    let row = 0
    while (row < r) {
      const inset = insetAt(row)
      let span = 1
      while (row + span < r && insetAt(row + span) === inset) span += 1
      const y = edge === 'top' ? rect.y + row : rect.y + rect.height - row - span
      out.push({
        x: rect.x + inset,
        y,
        width: Math.max(0, rect.width - inset * 2),
        height: span,
      })
      row += span
    }
  }

  rowsFrom('top')
  const middleHeight = rect.height - 2 * r
  if (middleHeight > 0) {
    out.push({ x: rect.x, y: rect.y + r, width: rect.width, height: middleHeight })
  }
  rowsFrom('bottom')
  return out
}

/**
 * `BrowserWindow.getNativeWindowHandle()` 的 Buffer → 十进制 HWND 数值。
 *
 * Windows 上 Electron 给的是 `HWND`（64 位进程 8 字节、32 位进程 4 字节）。
 * 句柄解析失败（长度不足）返回 `undefined`，调用方按「拿不到句柄」降级，不要拿 0 当句柄用。
 */
export function nativeHandleToNumber(buffer: Buffer): number | undefined {
  if (buffer.length >= 8) return Number(buffer.readBigUInt64LE(0))
  if (buffer.length >= 4) return buffer.readUInt32LE(0)
  return undefined
}
