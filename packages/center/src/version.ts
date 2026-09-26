/**
 * 服务器版本号：运行时读同包 `package.json`（dist/server.js 的上一级），
 * 与源码里写一份常量相比不会漂移。CLI 与握手 `welcome` 共用。
 */
import { readFileSync } from 'node:fs'

let cached: string | undefined

export function serverVersion(): string {
  if (cached !== undefined) return cached
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    cached = typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    cached = '0.0.0'
  }
  return cached
}
