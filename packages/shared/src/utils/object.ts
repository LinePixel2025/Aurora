/**
 * 递归 sanitize：以 `defaults` 为形状基准，逐字段校验 `value`，
 * 非法 / 缺失字段回退默认值（docs/08 §2「非法字段回退默认值」）。
 *
 * 设计取舍：整份配置解析失败才备份重建；单个字段非法只回退该字段，
 * 尽量保留用户已配置的其它内容。
 */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function deepClone<T>(value: T): T {
  return structuredCloneSafe(value)
}

function structuredCloneSafe<T>(value: T): T {
  if (typeof globalThis.structuredClone === 'function') {
    try {
      return globalThis.structuredClone(value)
    } catch {
      /* 含不可克隆值时退回 JSON 深拷贝 */
    }
  }
  return JSON.parse(JSON.stringify(value)) as T
}

export interface SanitizeIssue {
  path: string
  reason: string
}

/** `validate(path, candidate)` 返回 true 表示候选值可用（见 schema.ts 的 `fieldAccepts`）。 */
export type FieldValidator = (path: string, candidate: unknown) => boolean

/** 动态键字段（如 `llm.providers`）：跳过逐字段回退，整体保留候选对象。 */
export type DynamicPathTest = (path: string) => boolean

export function sanitizeWithDefaults(
  value: unknown,
  defaults: Record<string, unknown>,
  validate: FieldValidator,
  issues: SanitizeIssue[] = [],
  path = '',
  isDynamic?: DynamicPathTest,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const source = isPlainObject(value) ? value : {}

  for (const key of Object.keys(defaults)) {
    const fallback = defaults[key]
    const candidate = source[key]
    const fieldPath = path ? `${path}.${key}` : key

    if (candidate === undefined) {
      result[key] = deepClone(fallback)
      continue
    }

    if (!validate(fieldPath, candidate)) {
      issues.push({ path: fieldPath, reason: '值非法，已回退默认值' })
      result[key] = deepClone(fallback)
      continue
    }

    if (isPlainObject(fallback) && isPlainObject(candidate)) {
      // 动态键映射（z.record）的键不在 Schema 里，整体保留用户数据
      if (isDynamic?.(fieldPath)) {
        result[key] = deepClone(candidate)
        continue
      }
      result[key] = sanitizeWithDefaults(
        candidate,
        fallback,
        validate,
        issues,
        fieldPath,
        isDynamic,
      )
      continue
    }

    result[key] = deepClone(candidate)
  }

  return result
}

/** 浅层合并一层对象（用于用户局部更新配置）。 */
export function mergeShallow<T extends Record<string, unknown>>(
  base: T,
  patch: Record<string, unknown>,
): T {
  return { ...base, ...deepClone(patch) }
}
