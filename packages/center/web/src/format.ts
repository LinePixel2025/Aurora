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
