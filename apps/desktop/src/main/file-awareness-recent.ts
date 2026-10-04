/**
 * Windows「最近使用」探测（docs/06 §26）。
 *
 * 文件变化可以由 chokidar 观察，但“用户打开过文件”没有普通应用级回调。这里只轮询
 * `%APPDATA%\Microsoft\Windows\Recent` 的目录 mtime；只有 mtime 变化时才批量启动一次
 * PowerShell 解析 `.lnk`，避免空闲进程不断创建 PowerShell。
 */
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'

export interface RecentUsageEntry {
  target: string
  shortcutPath: string
  observedAt: string
}

export interface RecentUsageProbeResult {
  entries: RecentUsageEntry[]
  directoryMtimeMs: number
}

export interface RecentUsageProbeOptions {
  recentDir?: string
  exec?: (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr?: string }>
}

const OFFICE_EXTENSIONS = new Set(['.docx', '.pptx', '.doc', '.ppt'])

const RECENT_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$dir=Join-Path $env:APPDATA 'Microsoft\\Windows\\Recent'",
  'if (-not (Test-Path -LiteralPath $dir)) { @() | ConvertTo-Json -Compress; exit 0 }',
  '$shell=New-Object -ComObject WScript.Shell',
  '$items=Get-ChildItem -LiteralPath $dir -Filter *.lnk -File | ForEach-Object {',
  '  try { $shortcut=$shell.CreateShortcut($_.FullName) } catch { return }',
  '  if ([string]::IsNullOrWhiteSpace($shortcut.TargetPath)) { return }',
  '  [pscustomobject]@{ target=$shortcut.TargetPath; shortcutPath=$_.FullName; observedAt=$_.LastWriteTimeUtc.ToString("o") }',
  '}',
  '@($items) | ConvertTo-Json -Depth 3 -Compress',
].join('\n')

/** 解析 PowerShell 的 JSON 输出；任何畸形形状都降级为空数组。 */
export function parseRecentProbeOutput(raw: string): RecentUsageEntry[] {
  let value: unknown
  try {
    value = JSON.parse(raw.trim() === '' ? '[]' : raw)
  } catch {
    return []
  }
  const rows = Array.isArray(value) ? value : value === null ? [] : [value]
  const result: RecentUsageEntry[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const record = row as Record<string, unknown>
    const target = typeof record['target'] === 'string' ? record['target'] : ''
    const shortcutPath = typeof record['shortcutPath'] === 'string' ? record['shortcutPath'] : ''
    const observedAt = typeof record['observedAt'] === 'string' ? record['observedAt'] : ''
    if (target === '' || shortcutPath === '' || observedAt === '') continue
    if (!OFFICE_EXTENSIONS.has(extname(target).toLowerCase())) continue
    result.push({ target, shortcutPath, observedAt })
  }
  return result
}

export function createRecentUsageProbe(options: RecentUsageProbeOptions = {}) {
  const recentDir =
    options.recentDir ?? join(process.env['APPDATA'] ?? '', 'Microsoft', 'Windows', 'Recent')
  const exec =
    options.exec ??
    ((file: string, args: readonly string[]) =>
      new Promise<{ stdout: string; stderr?: string }>((resolve, reject) => {
        execFile(
          file,
          [...args],
          { windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error !== null) {
              reject(error)
              return
            }
            resolve({ stdout, stderr })
          },
        )
      }))

  return {
    async scan(): Promise<RecentUsageProbeResult> {
      let directoryMtimeMs = 0
      try {
        const stat = await fs.stat(recentDir)
        directoryMtimeMs = stat.mtimeMs
      } catch {
        return { entries: [], directoryMtimeMs: 0 }
      }
      try {
        const result = await exec('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          RECENT_SCRIPT,
        ])
        return {
          entries: parseRecentProbeOutput(result.stdout),
          directoryMtimeMs,
        }
      } catch {
        return { entries: [], directoryMtimeMs }
      }
    },
  }
}

export function recentEntryKey(entry: Pick<RecentUsageEntry, 'target' | 'observedAt'>): string {
  return `${entry.target.toLowerCase()}|${entry.observedAt}`
}

export function fileNameOf(path: string): string {
  return basename(path)
}
