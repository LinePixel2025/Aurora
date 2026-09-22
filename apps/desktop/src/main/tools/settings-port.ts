/**
 * `set_setting` 工具的主进程端口实现（docs/06 §12）。
 *
 * 内核侧的 `createSettingsTool` 只有纯逻辑，真实读写全部落在这里。三条硬规则：
 * 1. **唯一的写入落地点是 `ipc.ts` 的 `applyPatch`** —— 它负责局部合并语义、凭据抽取
 *    （`apiKey` / `env` → `setSecret`）与 `onSettingsChanged` 广播。
 *    绕过它自己 `settings.mutate()` 会丢掉凭据保留与广播这两件事。
 * 2. **给模型看的快照必须脱敏**（`apiKeyEnc` / `envEnc` → 空串），复用 IPC 层同一个函数，
 *    避免出现"两份脱敏逻辑，改一处漏一处"。
 * 3. **写坏了一定要兜住**：`applyPatch` 成功后再按 `SettingsSchema` 二次校验，
 *    不合法就把写前快照整体写回——这是"AI 改设置导致应用下次启动崩"的最后一道闸。
 */
import {
  SettingsSchema,
  type Logger,
  type Result,
  type Settings,
  type SettingsPatch,
} from '@aurora/shared'
import { canWriteSettingPath, settingsReadonlyReason } from '@aurora/shared'
import type { SettingsToolPort, SettingsWriteOutcome } from '@aurora/agent-core'
import { redactSettings } from '../ipc.js'
import type { SettingsStoreLike } from '../contracts.js'

/**
 * `createSettingsPort` 依赖：`applyPatch` / 脱敏函数都由 `index.ts` 传入（主进程只有一份
 * `DesktopDeps`，端口不自己造第二份 store）。
 */
export interface SettingsPortDeps {
  settings: SettingsStoreLike
  /**
   * 与 `ipc.ts` 的 `applyPatch` 同形：局部合并 + 凭据抽取 + 广播。
   *
   * 用 getter（而非固定函数）是有原因的：`index.ts` 里工具端口必须在 `KernelAgentHost`
   * 构造前就位，而绑定 `applyPatch` 所需的 `DesktopDeps` 在那之后才装配完成。
   * 端口只在真正的写入时才会取它，那时赋值早已完成。
   */
  applyPatch: () => (patch: SettingsPatch) => Result<Settings>
  logger: Logger
}

/** 配置顶层分组：只有这些前缀能进 `SettingsPatch`（`version` 等一律拒绝）。 */
const TOP_LEVEL_GROUPS = ['general', 'llm', 'modes', 'skills', 'mcp', 'advanced', 'agent'] as const

/**
 * 主进程侧端口实现（docs/06 §12）。
 *
 * - `snapshot()` / `read()`：只回传脱敏快照（凭据永远读不回来）；
 * - `writable()`：先查用户可配置的黑名单 `advanced.readonlyPrefixes`，再查 Schema 兜底；
 * - `write()`：按顶层分组深合并成一个 `SettingsPatch` → `applyPatch` → 二次校验 → 审计留痕。
 */
export function createSettingsPort(deps: SettingsPortDeps): SettingsToolPort {
  /** 与渲染层 `settings:get` 完全同款的脱敏快照（复用 IPC 层同一个函数，不复制第二份） */
  const redacted = (source: Settings): Record<string, unknown> =>
    redactSettings(deps.settings, source) as unknown as Record<string, unknown>

  /**
   * 路径可写判定：黑名单（用户可在 `advanced.readonlyPrefixes` 里加减）优先，
   * 再用 `canWriteSettingPath` 的 Schema 兜底（「Schema 必须识别该路径」永远生效）。
   */
  const reasonOf = (path: string): string | undefined => {
    // 老配置 / 极端情况下该字段可能缺失：缺失按"没有额外黑名单"处理，
    // 后续的 Schema 兜底仍然拦截拼错与动态路径。
    const prefixes = deps.settings.get().advanced.readonlyPrefixes ?? []
    const hit = prefixes.find((prefix) => path === prefix || path.startsWith(`${prefix}.`))
    if (hit !== undefined) return `「${hit}」属于不可修改的配置（凭据 / 代理 / 窗口 / 版本等）`
    if (canWriteSettingPath(path)) return undefined
    return settingsReadonlyReason(path) ?? '未知配置路径'
  }

  return {
    snapshot(): Record<string, unknown> {
      return redacted(deps.settings.get())
    },

    read(path: string): unknown {
      // 凭据**明文**不在落盘数据里（`applyPatch` 会把 `apiKey` / `env` 摘走再交 `setSecret`），
      // 密文（`apiKeyEnc` / `envEnc`）则被 `redactSettings` 换成空串 / 标记位，
      // 因此这条路径读不回任何密钥；内核侧的 `redactValue` 是第二层。
      return readDotted(redacted(deps.settings.get()), path)
    },

    writable(path: string): { ok: true } | { ok: false; reason: string } {
      const reason = reasonOf(path)
      return reason === undefined ? { ok: true } : { ok: false, reason }
    },

    async write(paths: Array<{ path: string; value: unknown }>): Promise<SettingsWriteOutcome> {
      const patch: Record<string, unknown> = {}
      const applied: string[] = []

      for (const item of paths) {
        const reason = reasonOf(item.path)
        if (reason !== undefined) {
          // 动态路径（`llm.providers.*` / `mcp.servers.*`）也走这里：它们本来就在默认
          // 黑名单里，放任它们进聚合逻辑就等于"AI 能改凭据"。
          deps.logger.warn('拒绝写入配置路径', { path: item.path, reason })
          return { ok: false, message: `${item.path}：${reason}`, applied: [] }
        }

        const segments = item.path.split('.')
        const group = segments[0]
        if (group === undefined || !(TOP_LEVEL_GROUPS as readonly string[]).includes(group)) {
          return { ok: false, message: `${item.path}：不支持的配置分组`, applied: [] }
        }

        // 同分组内多个路径必须**逐层深合并**：`applyPatch` 只做顶层浅合并，
        // 直接把 `{ 'agent.tools.enabled': false }` 塞进去会写出畸形对象。
        const branch: Record<string, unknown> = {}
        let cursor = branch
        for (let i = 1; i < segments.length - 1; i++) {
          const next: Record<string, unknown> = {}
          cursor[segments[i] as string] = next
          cursor = next
        }
        // 值可能是数组 / 对象：先深拷贝，既避免与调用方共享引用，也防 `applyPatch`
        // 就地删凭据字段（`delete draft['apiKey']`）时改到调用方的对象。
        cursor[segments[segments.length - 1] as string] = structuredClone(item.value)

        const existing = patch[group]
        patch[group] =
          existing === undefined ? branch : mergeDeep(existing as Record<string, unknown>, branch)
        applied.push(item.path)
      }

      const before = deps.settings.get()
      const result = deps.applyPatch()(patch as SettingsPatch)
      if (!result.ok) {
        // 失败时**不做任何回滚**：`SettingsStore.sanitize` 拒绝时内存态压根没变，
        // 再用 `mutate` 写 `before` 反而会覆盖"内存里领先于磁盘"的其它改动。
        return { ok: false, message: `配置校验失败：${result.message}`, applied: [] }
      }

      const after = deps.settings.get()
      const parsed = SettingsSchema.safeParse(after)
      if (!parsed.success) {
        // 理论上不该发生（`applyPatch` 内部已过一遍 Schema）。真发生了说明合并语义
        // 与 Schema 之间有裂缝，宁可整份回滚也不能把非法配置留在内存里等它落盘。
        deps.logger.error('配置写入后校验失败，已回滚', {
          applied,
          issues: parsed.error.issues.slice(0, 5).map((issue) => issue.path.join('.')),
        })
        deps.settings.mutate((draft) => {
          Object.assign(draft, before)
        })
        return { ok: false, message: '配置写入后校验失败，已回滚到写入前的状态', applied: [] }
      }

      // 审计：只记本次改动路径的前后值（已脱敏），**绝不把整份配置写进日志**。
      // 前后各取一次快照，因此还能看出 `sanitize` 是否把某个值改写了（如 llm.active → ''）。
      deps.logger.info('AI 修改配置', {
        applied,
        before: pickRedacted(redacted(before), applied),
        after: pickRedacted(redacted(after), applied),
      })

      return { ok: true, message: `已修改 ${applied.length} 项配置`, applied }
    },
  }
}

/** 深合并：对象递归、数组与标量整体替换（数组按下标"合并"没有合理语义）。 */
function mergeDeep(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key]
    if (isPlainRecord(current) && isPlainRecord(value)) {
      target[key] = mergeDeep(current, value)
      continue
    }
    target[key] = value
  }
  return target
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 按 `applied` 路径从**脱敏后**的快照里取值（缺字段留空，不抛）。 */
function pickRedacted(snapshot: Record<string, unknown>, paths: string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {}
  for (const path of paths) picked[path] = readDotted(snapshot, path)
  return picked
}

function readDotted(source: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = source
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}
