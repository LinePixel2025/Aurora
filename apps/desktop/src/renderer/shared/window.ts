/** 当前窗口名（由 electron-vite 的目录名决定，见 electron.vite.config.ts）。 */
import type { WindowName } from '@aurora/shared'

export function currentWindowName(): WindowName {
  const segments = window.location.pathname.split('/').filter(Boolean)
  // prod: /out/renderer/<window>/index.html ；dev: /<window>/index.html
  const index = segments.lastIndexOf('index.html')
  const candidate = index > 0 ? segments[index - 1] : segments[segments.length - 1]
  return (candidate ?? 'chat') as WindowName
}

export function isTransparentWindow(name: WindowName): boolean {
  return name === 'edge-bar'
}
