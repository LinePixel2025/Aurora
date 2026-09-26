/**
 * 自更新（docs/12 §9）：以 npm 为发布 / 更新通道。
 *
 * `--check` 只查询不动作；实际更新 = `npm install -g @aurora/center@latest`
 * （经 child_process，透传 --registry）。**没有**自替换二进制的黑魔法 ——
 * 那既不可移植（Windows 上运行中的 exe 不能覆盖自己）也不诚实。
 */

export interface UpdateCheckResult {
  current: string
  latest?: string
  /** true = latest > current */
  updateAvailable: boolean
  error?: string
}

/** 语义化版本比较（只取 major.minor.patch；预发布标签忽略，按发布版对待） */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const pb = b.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export async function fetchLatestVersion(registry: string): Promise<string> {
  const url = `${registry.replace(/\/$/, '')}/@aurora%2fcenter/latest`
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`registry 返回 ${response.status}`)
  const body = (await response.json()) as { version?: unknown }
  if (typeof body.version !== 'string' || body.version === '') {
    throw new Error('registry 响应缺少 version 字段')
  }
  return body.version
}

export async function checkUpdate(
  current: string,
  registry: string,
): Promise<UpdateCheckResult> {
  try {
    const latest = await fetchLatestVersion(registry)
    return { current, latest, updateAvailable: compareVersions(latest, current) > 0 }
  } catch (error) {
    return {
      current,
      updateAvailable: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
