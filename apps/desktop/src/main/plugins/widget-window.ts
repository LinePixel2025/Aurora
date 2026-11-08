/** 桌面小组件窗口的纯函数判定（docs/14 §5.3），不依赖 Electron。 */
import type { PluginWidgetWindowLevel, PluginWidgetWindowMaterial } from '@aurora/shared'

/** 实际窗口层级：用户覆盖优先，缺省跟随清单声明。 */
export function resolveWidgetWindowLevel(
  declared: PluginWidgetWindowLevel,
  override: PluginWidgetWindowLevel | undefined,
): PluginWidgetWindowLevel {
  return override ?? declared
}

/** 兼容旧清单字段；桌面小组件运行时一律使用不透明材质。 */
export function resolveWidgetWindowMaterial(
  _declared: PluginWidgetWindowMaterial,
): PluginWidgetWindowMaterial {
  return 'none'
}

/** `BrowserWindow.getNativeWindowHandle()` 的 Buffer → 十进制 HWND 数值。 */
export function nativeHandleToNumber(buffer: Buffer): number | undefined {
  if (buffer.length >= 8) return Number(buffer.readBigUInt64LE(0))
  if (buffer.length >= 4) return buffer.readUInt32LE(0)
  return undefined
}
