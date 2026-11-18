/**
 * DWM 原生 Acrylic 的平台判据：**Windows 11 22H2（build 22621）及以上**。
 *
 * 为什么必须单独判版本：Electron 的 `setBackgroundMaterial` 在更低版本
 * **静默 no-op、不抛错**（`shell/browser/native_window_views.cc` 里
 * `GetVersion() < WIN11_22H2` 直接 return），把 try/catch 当降级判据会得到
 * 「窗口记成已挂材质、实际透明无模糊」的假成功（2026-11-18 修复）。
 *
 * 本文件不 import electron，单测可直接跑；渲染层的同一判据在
 * `preload/index.ts`（沙箱 preload 不能 import 工作区包，两处手抄，改动必须同步）。
 */
export function supportsNativeWindowMaterial(
  platform: NodeJS.Platform = process.platform,
  version: string = process.getSystemVersion(),
): boolean {
  if (platform !== 'win32') return false
  const build = Number(version.split('.')[2] ?? '')
  return Number.isInteger(build) && build >= 22621
}
