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

    // 形状校验（P2-26）：默认值是对象、候选却是标量 / 数组时，它不可能是合法的分组值。
    // 这条兜的是 `validate` 放行的两类路径：① `z.record` 动态键路径（`llm.providers` 的
    // 类型表是 'any'，`fieldAccepts` 一律放行）；② 任何对象型路径 —— 静态对象分组的形状校验
    // 已在 `schema.ts` 的 `fieldAccepts` 里补上（`objectPaths`），这里再兜一道不重叠的。
    // 不在这里回退的话，`general: 123` 这种手改 / 半损坏配置会一路活到 `SettingsSchema.parse`，
    // 把**整份配置**判为损坏并备份重建（用户所有 provider / 课表 / 项目同时消失），
    // 违背「单个字段非法只回退该字段」的承诺。
    if (isPlainObject(fallback) && !isPlainObject(candidate)) {
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
