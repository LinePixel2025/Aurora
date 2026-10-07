/**
 * 界面展示用的小工具：模式 / 平台 / 时间 / 字节数的中文标签。
 * 只做纯转换，方便将来补单测。
 */
import type { ModeId } from '@aurora/shared'

const MODE_LABELS: Record<ModeId, string> = {
  classroom: '课堂',
  work: '工作',
  code: '代码',
}

export function modeLabel(mode: string): string {
  return MODE_LABELS[mode as ModeId] ?? mode
}

export function platformLabel(platform: string): string {
  if (platform === 'win32') return 'Windows'
  if (platform === 'darwin') return 'macOS'
  if (platform === 'linux') return 'Linux'
  return platform
}

export function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return String(bytes)
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 'B'
  for (const next of units) {
    if (value < 1024) break
    value /= 1024
    unit = next
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${unit}`
}

/** Token 数的紧凑展示：1234567 → 1.2M，12345 → 12.3K（KPI 卡与图表轴共用）。 */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count)) return String(count)
  const abs = Math.abs(count)
  if (abs >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`
  }
  if (abs >= 1_000) {
    return `${(count / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`
  }
  return String(count)
}

// ───────────────────────── job / 子代理状态标签 ─────────────────────────

/** AgentJobStatus → 中文标签（docs/06 §4.1） */
export function jobStatusLabel(status: string): string {
  switch (status) {
    case 'queued':
      return '排队中'
    case 'running':
      return '进行中'
    case 'paused':
      return '已暂停'
    case 'done':
      return '已完成'
    case 'error':
      return '出错'
    case 'aborted':
      return '已中止'
    default:
      return status
  }
}

/** 暂停原因 → 中文说明 */
export function pendingReasonLabel(reason: string): string {
  switch (reason) {
    case 'max-rounds':
      return '已达轮次上限'
    case 'budget':
      return '已达 token 预算'
    case 'aborted':
      return '已被取消'
    default:
      return reason
  }
}

/** 子代理运行状态 → 中文标签 */
export function subagentStatusLabel(status: string): string {
  switch (status) {
    case 'running':
      return '运行中'
    case 'success':
      return '已完成'
    case 'error':
      return '失败'
    default:
      return status
  }
}

/**
 * 距过期时间点的剩余毫秒（已过期返回 0）；确认卡 / 提问卡倒计时与文件剩余有效期共用。
 * `now` 由调用方传入（组件里用秒级心跳驱动重渲染）。
 */
export function remainingMs(expiresAt: string | number, now = Date.now()): number {
  // 确认卡 / 文件的 `expiresAt` 是 ISO 串；提问卡的 `expiresAt` 是**毫秒时间戳**
  // （`AskUserRequest.expiresAt`，docs/12 §5）——两种形态都要吃得下
  const target = typeof expiresAt === 'number' ? expiresAt : new Date(expiresAt).getTime()
  if (Number.isNaN(target)) return 0
  return Math.max(0, target - now)
}

/** 剩余时间的人类可读文案：mm:ss（<1h）/ Xh Ym（<24h）/ X 天 */
export function formatRemaining(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000)
  if (totalSeconds <= 0) return '已过期'
  if (totalSeconds < 3600) {
    const m = Math.floor(totalSeconds / 60)
    const s = totalSeconds % 60
    return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`
  }
  const totalMinutes = Math.floor(totalSeconds / 60)
  const hours = Math.floor(totalMinutes / 60)
  if (hours < 24) return `${hours} 小时 ${totalMinutes % 60} 分`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
}
