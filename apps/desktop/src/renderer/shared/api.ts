/**
 * 渲染层接入口：所有系统能力只能经由 `window.aurora`（docs/02 §6）。
 *
 * 注意：`window.aurora` 在浏览器里（非 Electron）不存在，
 * 这里提供 `isAuroraAvailable()` 供页面降级提示，避免白屏。
 */
import { err, ok, type Result } from '@aurora/shared'

export function aurora() {
  const api = window.aurora
  if (!api) {
    throw new Error('window.aurora 不可用：请通过 Electron 启动 Aurora（pnpm dev）')
  }
  return api
}

export function isAuroraAvailable(): boolean {
  return typeof window !== 'undefined' && window.aurora !== undefined
}

/** 把 `Result<T>` 解包为值，失败时抛出（供 async/await 场景使用）。 */
export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value
  throw new Error(result.message)
}

/** 把 `Result<T>` 解包为 `{ data, error }`，适合在组件里渲染错误。 */
export function settle<T>(result: Result<T>): { data: T | null; error: string | null } {
  return result.ok ? { data: result.value, error: null } : { data: null, error: result.message }
}

/** 统一错误 Result，便于 UI 在非 IPC 场景复用。 */
export function localError(message: string): Result<never> {
  return err('E_UNKNOWN', message)
}

export function localOk<T>(value: T): Result<T> {
  return ok(value)
}
