/**
 * 基础工具类型（packages/shared）
 *
 * 约定：所有跨进程调用统一返回 `Result<T>`，避免 IPC 抛错时丢失结构化信息
 * （见 docs/02 §6、docs/08 §2）。
 */

export interface Ok<T> {
  ok: true
  value: T
}

/** 结构化失败：`code` 供程序判断，`message` 供 UI 展示。 */
export interface Err {
  ok: false
  code: ErrorCode
  message: string
  /** 可选附加信息（如 HTTP 状态码、provider id），已脱敏。 */
  detail?: string
}

export type Result<T> = Ok<T> | Err

export type ErrorCode =
  | 'E_NOT_FOUND'
  | 'E_INVALID_ARGUMENT'
  | 'E_INVALID_STATE'
  | 'E_NETWORK'
  | 'E_TIMEOUT'
  | 'E_ABORTED'
  | 'E_AUTH'
  | 'E_RATE_LIMIT'
  | 'E_UNSUPPORTED'
  | 'E_NOT_IMPLEMENTED'
  | 'E_CRYPTO_UNAVAILABLE'
  | 'E_IO'
  | 'E_UNKNOWN'

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value }
}

export function err(code: ErrorCode, message: string, detail?: string): Err {
  return detail === undefined ? { ok: false, code, message } : { ok: false, code, message, detail }
}

/** 把一个可能抛错的同步/异步操作收敛为 `Result`。 */
export async function attempt<T>(
  fn: () => Promise<T> | T,
  onError: (error: unknown) => Err,
): Promise<Result<T>> {
  try {
    return ok(await fn())
  } catch (error) {
    return onError(error)
  }
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
