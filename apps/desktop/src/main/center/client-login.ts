/**
 * Aurora Center 客户端账号登录（docs/12 §3/§7，v0.2.1）：把设置页的
 * 服务器地址 + 账号 + 密码换成客户端令牌（`POST /api/client/login`）。
 *
 * 本文件保持纯 Node（不 import electron）：`fetchImpl` 由主进程注入
 * （生产 = `main/net.ts` 的 `netFetch`，走 Chromium 网络栈受代理设置约束；
 * 单测 = 假 fetch），与内核「只接受注入」的套路一致。
 */
import type { Logger } from '@aurora/shared'

export interface CenterLoginInput {
  serverUrl: string
  username: string
  password: string
  clientId: string
}

export type CenterLoginOutcome =
  { ok: true; token: string; account: string } | { ok: false; message: string }

/** 登录请求整体超时：Center 不可达时快速失败，别让设置页转圈 30 秒 */
const LOGIN_TIMEOUT_MS = 15_000

/** ws(s)/http(s) 统一换算成 http(s) 基址（REST 登录用，与连接器 `wsUrlOf` 对偶） */
export function httpBaseUrlOf(serverUrl: string): string | undefined {
  try {
    const url = new URL(serverUrl)
    if (url.protocol === 'https:') url.protocol = 'https:'
    else if (url.protocol === 'http:') url.protocol = 'http:'
    else if (url.protocol === 'wss:') url.protocol = 'https:'
    else if (url.protocol === 'ws:') url.protocol = 'http:'
    else return undefined
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

export interface CenterLoginDeps {
  fetchImpl: typeof fetch
  logger?: Logger
  /** 整体超时（毫秒）；缺省 15s。测试注入小值，不必真等 */
  timeoutMs?: number
}

/**
 * 调 Center 的 `/api/client/login`：成功返回客户端令牌明文（调用方负责立即写入
 * 凭据链路）；失败返回用户可读的中文原因。密码只出现在请求体里，不进日志。
 */
export async function requestClientLogin(
  input: CenterLoginInput,
  deps: CenterLoginDeps,
): Promise<CenterLoginOutcome> {
  const base = httpBaseUrlOf(input.serverUrl)
  if (base === undefined) {
    return { ok: false, message: `无法解析服务器地址：${input.serverUrl}` }
  }
  const timeoutMs = deps.timeoutMs ?? LOGIN_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const response = await deps.fetchImpl(`${base.replace(/\/+$/, '')}/api/client/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: input.username,
        password: input.password,
        clientId: input.clientId,
      }),
      signal: controller.signal,
    })
    const body = (await response.json().catch(() => ({}))) as {
      token?: unknown
      error?: unknown
    }
    if (!response.ok) {
      const reason = typeof body['error'] === 'string' ? body['error'] : `HTTP ${response.status}`
      return { ok: false, message: `登录失败：${reason}` }
    }
    const token = body['token']
    if (typeof token !== 'string' || token === '') {
      return { ok: false, message: '登录失败：服务器响应缺少令牌' }
    }
    deps.logger?.info('Aurora Center 账号登录成功', { clientId: input.clientId })
    return { ok: true, token, account: input.username }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    deps.logger?.warn('Aurora Center 账号登录失败', { error: String(error) })
    return {
      ok: false,
      message: aborted
        ? `连接服务器超时（${Math.round(timeoutMs / 1000)} 秒）`
        : `无法连接服务器：${String(error)}`,
    }
  } finally {
    clearTimeout(timer)
  }
}
