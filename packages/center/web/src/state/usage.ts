/**
 * token 用量聚合（对齐桌面端 useChat 的防重思路，docs/06 §16.2）。
 *
 * - `latest` 直接覆盖（promptTokens 就是该轮的上下文占用，会话页的占比分母取它）；
 * - `totals` 逐轮累加，但同一 (requestId, round) 只累加一次 —— 事件重放 / 迟到事件
 *   不该把用量翻倍（round 会在新一轮请求里重新从小数起，所以键必须带 requestId）。
 */
import type { AgentEvent } from '@aurora/shared'
import type { ClientEntry, SessionUsage } from './store'

export function applyUsage(
  entry: ClientEntry,
  sessionId: string,
  event: Extract<AgentEvent, { type: 'usage' }>,
): void {
  let usage = entry.usageBySession.get(sessionId)
  if (!usage) {
    usage = emptyUsage()
    entry.usageBySession.set(sessionId, usage)
  }
  usage.latest = event.usage
  const key = `${event.requestId}#${event.round}`
  if (usage.counted.has(key)) return
  usage.counted.add(key)
  usage.totals = {
    promptTokens: usage.totals.promptTokens + event.usage.promptTokens,
    completionTokens: usage.totals.completionTokens + event.usage.completionTokens,
    totalTokens: usage.totals.totalTokens + event.usage.totalTokens,
  }
  if (usage.counted.size > 200) {
    // 防泄漏：只留最近 200 轮的防重键（正常远小于此；超限只影响极端重放场景）
    usage.counted = new Set([...usage.counted].slice(-200))
  }
}

export function emptyUsage(): SessionUsage {
  return {
    latest: null,
    totals: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    counted: new Set<string>(),
  }
}
