export const BROWSER_USER_AGENTS = [
  { id: 'chromium', label: 'Chromium（兼容默认）', value: '' },
  {
    id: 'chrome-windows',
    label: 'Chrome · Windows',
    value:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  },
  {
    id: 'chrome-mac',
    label: 'Chrome · macOS',
    value:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  },
  {
    id: 'chrome-android',
    label: 'Chrome · Android',
    value:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  },
  {
    id: 'safari-mac',
    label: 'Safari · macOS',
    value:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  },
  {
    id: 'safari-ios',
    label: 'Safari · iPhone',
    value:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  },
] as const

export const MAX_USER_AGENT_LENGTH = 512

export function validateCustomUserAgent(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '') return 'UA 不能为空'
  if (trimmed.length > MAX_USER_AGENT_LENGTH) return `UA 最多 ${MAX_USER_AGENT_LENGTH} 个字符`
  if (/\r|\n/.test(trimmed)) return 'UA 不能包含换行'
  return null
}

export function browserUserAgentId(value: string, defaultUserAgent: string): string {
  if (value === defaultUserAgent || value === '') return 'chromium'
  return BROWSER_USER_AGENTS.find((preset) => preset.value === value)?.id ?? 'custom'
}
