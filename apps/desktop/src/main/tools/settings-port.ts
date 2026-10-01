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
import {
  SETTINGS_READONLY_PREFIXES,
  canWriteSettingPath,
  settingsReadonlyReason,
} from '@aurora/shared'
import type { SettingsToolPort, SettingsWriteOutcome } from '@aurora/agent-core'
import { redactSettings } from '../settings-redact.js'
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
  /**
   * 回滚后的变更通知（可选）。正常写入走 `applyPatch` 自带的广播；回滚分支用
   * `settings.mutate` 把写前快照写回 —— `mutate` **不触发** `onSettingsChanged`，
   * 不补这一次通知的话，工具闭包（`registerComputerTools` / 边界 getter 等）会停在坏值
   * 实例上，直到下一次任意配置变更才恢复。
   */
  notifyChanged?: () => void
}

/**
 * 配置顶层分组：只有这些前缀能进 `SettingsPatch`（`version` 等一律拒绝）。
 *
 * `tts` / `stt` / `imagegen` 必须在列（docs/08 §1）：三组的非凭据叶子（`tts.enabled` 等）
 * 登记在 shared 的 `WRITABLE_PATH_OVERRIDES` 里，`writable()` 因此对模型承诺可写 ——
 * 分组清单若缺席，`write()` 会在下一道检查里整体拒绝，形成「承诺可写、写入必拒」的偏差。
 * `center` **刻意缺席**：它整组只读（`SETTINGS_READONLY_PREFIXES`），两侧口径一致。
 */
const TOP_LEVEL_GROUPS = [
  'general',
  'llm',
  'tts',
  'stt',
  'imagegen',
  'modes',
  'skills',
  'mcp',
  'advanced',
  'agent',
  'appearance',
] as const

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
   * 路径可写判定。**顺序与 docs/08 §1 写的一致：显式可写覆盖表先于黑名单前缀** ——
   * `canWriteSettingPath` 内部就是「覆盖表 → 硬编码前缀 → Schema 识别」这条链，所以先问它。
   *
   * ⚠️ 这里曾经把顺序弄反了：先拿用户配置的 `advanced.readonlyPrefixes` 做前缀匹配，再问
   * `canWriteSettingPath`。而该字段的**默认值就是硬编码前缀的镜像**（`defaults.ts` 里的
   * `[...SETTINGS_READONLY_PREFIXES]`），于是 `llm.providers` 这条默认项先命中，
   * **覆盖表对 `llm.providers.<id>.model / modelParams.<modelId>.reasoningEffort` 的放行一次都没生效过** ——
   * 工具描述、`settings-hint` 与三册文档都承诺「能改模型 / 思考等级」，实际每次都回
   * 「「llm.providers」属于不可修改的配置」。同一类「承诺可写、写入必拒」在
   * `TOP_LEVEL_GROUPS` 上修过一次（P1-06），这是第二处。
   *
   * 修正后的语义：硬编码规则是唯一权威；用户配置项**只认得硬编码清单之外的那些条目**
   * （默认值是镜像，逐条比对会把默认项误当成"用户额外加的"），因此「只能追加限制、不能放宽」
   * 这条承诺仍然成立 —— 凭据 / `contextWindow` / `vision` 依旧一个字都写不进去
   * （它们不在覆盖表里，仍然命中硬编码前缀）。
   */
  const reasonOf = (path: string): string | undefined => {
    if (canWriteSettingPath(path)) {
      const extra = (deps.settings.get().advanced.readonlyPrefixes ?? []).find(
        (prefix) =>
          !(SETTINGS_READONLY_PREFIXES as readonly string[]).includes(prefix) &&
          (path === prefix || path.startsWith(`${prefix}.`)),
      )
      return extra === undefined
        ? undefined
        : `「${extra}」属于用户追加的不可修改配置（见 docs/08 §1 的 advanced.readonlyPrefixes）`
    }
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

        // 段切分走 `splitSettingPath`：模型级参数的路径里，模型 id 本身可能带点
        // （`gpt-4.1` / `claude-3.5-sonnet`），盲切会把它写到错误的键上。
        const segments = splitSettingPath(item.path)
        const group = segments[0]
        if (group === undefined || !(TOP_LEVEL_GROUPS as readonly string[]).includes(group)) {
          return { ok: false, message: `${item.path}：不支持的配置分组`, applied: [] }
        }

        // 同分组内多个路径必须**逐层深合并**；而且 patch 里必须带**该分组的完整当前值** ——
        // `applyPatch` 对 `general` / `agent` / `modes` 等分组是**整棵子树覆盖**
        // （`Object.assign(draft[group], patch[group])`），只塞局部子树会把同分组的兄弟字段抹掉：
        // 实测写 `agent.tools.enabled` 会连带抹掉 `agent.tools.workspaceDir/terminal/files/open`，
        // 于是 Schema 校验失败、整次写入被拒（工具却只会收到一句「请检查填写内容」）。
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

        const currentGroup = (deps.settings.get() as unknown as Record<string, unknown>)[group]
        const base =
          typeof currentGroup === 'object' && currentGroup !== null
            ? (structuredClone(currentGroup) as Record<string, unknown>)
            : {}
        const accumulated = (patch[group] as Record<string, unknown> | undefined) ?? {}
        patch[group] = mergeDeep(mergeDeep(base, accumulated), branch)
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
        // 回滚走的是 `mutate`（不广播）：手动补一次通知，让依赖配置的工具闭包按回滚值重建
        deps.notifyChanged?.()
        return { ok: false, message: '配置写入后校验失败，已回滚到写入前的状态', applied: [] }
      }

      // `applied` 只保留**真的生效**的路径：`SettingsStore.sanitize` 会把非法值悄悄规范化
      //（例如 `llm.active` 指向不存在的 provider → 重置为 `''`）。若照旧把请求路径全算作「已修改」，
      // 模型会以为自己改成功了；这里剔掉与请求值不一致的，让工具回填 `未生效：…`。
      const requested = new Map(paths.map((item) => [item.path, item.value]))
      const effective = applied.filter((path) => {
        const actual = readDotted(after as unknown as Record<string, unknown>, path)
        return JSON.stringify(actual) === JSON.stringify(requested.get(path))
      })
      const normalized = applied.filter((path) => !effective.includes(path))
      if (normalized.length > 0) {
        // 只记路径，不记值（值可能被规范化成别的东西，但路径本身足以排查）
        deps.logger.warn('配置写入被规范化（请求值未原样生效）', { paths: normalized })
      }

      // 审计：只记本次改动路径的前后值（已脱敏），**绝不把整份配置写进日志**。
      // 前后各取一次快照，因此还能看出 `sanitize` 是否把某个值改写了（如 llm.active → ''）。
      deps.logger.info('AI 修改配置', {
        applied: effective,
        before: pickRedacted(redacted(before), effective),
        after: pickRedacted(redacted(after), effective),
      })

      return { ok: true, message: `已修改 ${effective.length} 项配置`, applied: effective }
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

/**
 * 把点分路径切成段 —— **模型级参数那一条要特殊对待**。
 *
 * `llm.providers.<id>.modelParams.<模型 id>.<字段>` 里的模型 id **可以带点**
 * （`gpt-4.1` / `claude-3.5-sonnet` / `qwen2.5:7b` 都是常见写法：Schema 对 `model` 没有任何
 * 字符集约束，设置页重命名也只查非空与重名）。盲切段会把它拆成两层嵌套
 * （`modelParams['gpt-4'] = { '1': { … } }`）—— 于是往**错误的键**上写：真正的 `gpt-4.1`
 * 一个字没动、配置里还多出一条垃圾条目，回读又是 `undefined`（工具只会报「未生效」）。
 * 覆盖表已用 `**` 段承认这类路径可写，写路径必须能把它还原回来。
 *
 * 这个形状是**固定的**（`modelParams` 就是 `Record<模型 id, {三个字段}>` 的两层结构），
 * 所以按已知结构把中间那些段重新拼回一个模型 id。其余路径一律原样按 `.` 切，语义不变。
 */
export function splitSettingPath(path: string): string[] {
  const segments = path.split('.')
  const isModelParamPath =
    segments.length >= 6 &&
    segments[0] === 'llm' &&
    segments[1] === 'providers' &&
    segments[3] === 'modelParams'
  if (!isModelParamPath) return segments
  return [
    ...segments.slice(0, 4),
    segments.slice(4, segments.length - 1).join('.'),
    segments[segments.length - 1] as string,
  ]
}

function readDotted(source: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = source
  for (const segment of splitSettingPath(path)) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}
