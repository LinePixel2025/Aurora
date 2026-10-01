/**
 * 配置版本迁移链（docs/08 §2「version 字段 + migrations 链式执行」）。
 *
 * 约定：每次 Schema 破坏性变更向 `MIGRATIONS` 追加一条，永不修改历史条目。
 */
import {
  CONFIG_VERSION,
  LlmProviderTypes,
  normalizeModelParams,
  REASONING_EFFORT_LEVELS,
  SETTINGS_READONLY_PREFIXES,
} from './schema.js'
import {
  DEFAULT_AGENT_TOOLS,
  DEFAULT_CLASSIFICATION,
  DEFAULT_CLASSISLAND_SCHEDULE,
  DEFAULT_IMAGEGEN,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_STT,
  DEFAULT_TTS,
} from './defaults.js'
import type { Logger } from '../utils/logger.js'

export interface Migration {
  from: number
  to: number
  describe: string
  transform(raw: Record<string, unknown>): Record<string, unknown>
}

/** v0（无 version 字段的早期草稿）→ v1 */
const migrateV0ToV1: Migration = {
  from: 0,
  to: 1,
  describe: 'v0 → v1：补齐 version；扁平模式字段归一到 modes.*；llm.apiKey → apiKeyEnc',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }

    // 旧的扁平模式字段
    const mode = raw['mode']
    if (typeof mode === 'string' && (mode === 'work' || mode === 'code' || mode === 'classroom')) {
      next['modes'] = { ...(asRecord(raw['modes']) ?? {}), current: mode }
      delete next['mode']
    }

    // 旧的扁平 LLM 字段
    const llm = asRecord(raw['llm'])
    if (llm) {
      const apiKey = llm['apiKey']
      if (typeof apiKey === 'string' && apiKey.length > 0) {
        const providers = asRecord(llm['providers']) ?? {}
        providers['deepseek'] = {
          type: 'openai-compat',
          baseUrl: typeof llm['baseUrl'] === 'string' ? llm['baseUrl'] : 'https://api.deepseek.com',
          apiKeyEnc: apiKey,
          model: typeof llm['model'] === 'string' ? llm['model'] : 'deepseek-chat',
          ...(asRecord(providers['deepseek']) ?? {}),
        }
        next['llm'] = { ...llm, providers, active: 'deepseek' }
        delete (next['llm'] as Record<string, unknown>)['apiKey']
        delete (next['llm'] as Record<string, unknown>)['baseUrl']
        delete (next['llm'] as Record<string, unknown>)['model']
      }
    }

    next['version'] = 1
    return next
  },
}

/**
 * v1 → v2：为 P4 分类管线与 P5 敏感工具确认补齐配置字段。
 *
 * 只补缺失字段，**不覆盖**用户已写入的值（幂等：重复执行结果一致）。
 */
const migrateV1ToV2: Migration = {
  from: 1,
  to: 2,
  describe: 'v1 → v2：补齐 modes.classroom.classification 与 advanced.confirmSensitiveTools',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }

    const modes = { ...(asRecord(raw['modes']) ?? {}) }
    const classroom = { ...(asRecord(modes['classroom']) ?? {}) }
    if (asRecord(classroom['classification']) === undefined) {
      classroom['classification'] = { ...DEFAULT_CLASSIFICATION }
    }
    modes['classroom'] = classroom
    next['modes'] = modes

    const advanced = { ...(asRecord(raw['advanced']) ?? {}) }
    if (typeof advanced['confirmSensitiveTools'] !== 'boolean') {
      advanced['confirmSensitiveTools'] = true
    }
    next['advanced'] = advanced

    next['version'] = 2
    return next
  },
}

/**
 * v2 → v3：为 ClassIsland 联动（docs/05 §3.4 v2）补齐 `schedule.classisland`。
 *
 * 只补缺失字段、**不覆盖**用户已写入的值（幂等）。
 */
const migrateV2ToV3: Migration = {
  from: 2,
  to: 3,
  describe: 'v2 → v3：补齐 modes.classroom.schedule.classisland（ClassIsland 桥接数据源）',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }

    const modes = { ...(asRecord(raw['modes']) ?? {}) }
    const classroom = { ...(asRecord(modes['classroom']) ?? {}) }
    const schedule = { ...(asRecord(classroom['schedule']) ?? {}) }
    if (asRecord(schedule['classisland']) === undefined) {
      schedule['classisland'] = { ...DEFAULT_CLASSISLAND_SCHEDULE }
    }
    classroom['schedule'] = schedule
    modes['classroom'] = classroom
    next['modes'] = modes

    next['version'] = 3
    return next
  },
}

/**
 * v3 → v4：AI 悬浮窗（`service-dock`）已删除，清掉它的窗口几何记录。
 *
 * 只删该 key，**不动**其它字段与其它窗口的几何（幂等）。
 */
const migrateV3ToV4: Migration = {
  from: 3,
  to: 4,
  describe: "v3 → v4：移除 general.windowState['service-dock']（AI 悬浮窗已删除）",
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }
    const general = { ...(asRecord(raw['general']) ?? {}) }
    const windowState = { ...(asRecord(general['windowState']) ?? {}) }
    delete windowState['service-dock']
    general['windowState'] = windowState
    next['general'] = general
    next['version'] = 4
    return next
  },
}

/**
 * v4 → v5：补齐思考等级（`llm.providers.*.reasoningEffort`）与电脑操控工具配置（`agent.tools.*`）。
 *
 * 只补**缺失**字段：用户已写入的 provider 字段、已改过的上限值一个都不动（幂等）。
 * 唯一例外是 `reasoningEffort` —— 它必须是四个合法枚举值之一，非法值（含手改配置文件写错的）
 * 统一回落 `'auto'`，否则会一路活到 `SettingsSchema.parse` 把整份配置判为损坏。
 */
const migrateV4ToV5: Migration = {
  from: 4,
  to: 5,
  describe: 'v4 → v5：补齐 llm.providers.*.reasoningEffort 与 agent.tools.*',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }

    // providers 里**已有**的条目逐条补 reasoningEffort；
    // 没有 providers 时不凭空造出这个键（保持「空的 llm 迁移后仍是空的」这一既有语义）。
    const llm = asRecord(raw['llm'])
    const providersRaw = asRecord(llm?.['providers'])
    if (llm !== undefined && providersRaw !== undefined) {
      const providers = { ...providersRaw }
      for (const [id, value] of Object.entries(providers)) {
        const provider = asRecord(value)
        if (provider === undefined) continue
        const effort = provider['reasoningEffort']
        if (typeof effort !== 'string' || !isReasoningEffort(effort)) {
          providers[id] = { ...provider, reasoningEffort: DEFAULT_REASONING_EFFORT }
        }
      }
      next['llm'] = { ...llm, providers }
    }

    const agent = { ...(asRecord(raw['agent']) ?? {}) }
    agent['tools'] = fillMissing(
      asRecord(agent['tools']) ?? {},
      DEFAULT_AGENT_TOOLS as unknown as Record<string, unknown>,
    )
    next['agent'] = agent

    next['version'] = 5
    return next
  },
}

function isReasoningEffort(value: string): boolean {
  return (REASONING_EFFORT_LEVELS as readonly string[]).includes(value)
}

/** 用默认值补齐 `target` 缺失的键（递归进嵌套对象）；已存在的值一律保留。 */
function fillMissing(
  target: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target }
  for (const [key, fallback] of Object.entries(defaults)) {
    const current = result[key]
    if (asRecord(fallback) !== undefined) {
      result[key] = fillMissing(asRecord(current) ?? {}, fallback as Record<string, unknown>)
      continue
    }
    if (current === undefined) result[key] = fallback
  }
  return result
}

/**
 * v5 → v6：独立小窗（`mini-chat`）已删除，清掉它的窗口几何记录；同时补上
 * `advanced.readonlyPrefixes`（AI 改配置的路径黑名单，见 `schema.ts`）与
 * `llm.providers.*.modelList`（模型候选列表，见 `schema.ts` / docs/08 §5）。
 *
 * 窗口几何半边：只删该 key，**不动**其它字段与其它窗口的几何（幂等）。
 * 与 v3 → v4 删 `service-dock` 的唯一差别：**只在 `general.windowState` 已存在时改写**，
 * 不给本来没有窗口几何的配置凭空造出一个空对象。
 * `advanced` 半边照 v4 → v5 对 `agent` 的做法**无条件**补默认值（用户已写入的黑名单一个都不动）。
 * `modelList` 半边照 v4 → v5 补 `reasoningEffort` 的做法：**遍历已有 provider、只补缺失键**，
 * 没有 `providers` 时不凭空造出 `llm.providers`（保持「空 llm 迁移后仍为空」这一既有语义）；
 * 唯一例外是非数组的 `modelList`（手改配置写错）统一归零 —— 同 `reasoningEffort` 的非法值回落。
 */
const migrateV5ToV6: Migration = {
  from: 5,
  to: 6,
  describe:
    "v5 → v6：移除 general.windowState['mini-chat']；补齐 llm.providers.*.modelList 与 advanced.readonlyPrefixes",
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }
    const general = asRecord(raw['general'])
    const windowState = asRecord(general?.['windowState'])
    if (general !== undefined && windowState !== undefined) {
      const cleaned = { ...windowState }
      delete cleaned['mini-chat']
      next['general'] = { ...general, windowState: cleaned }
    }

    // providers 里**已有**的条目逐条补 modelList：只补缺失的键（`fillMissing` 已存在的值一律保留），
    // 因此用户/设置页写入的候选列表在重复执行时一个都不动（幂等）。
    const llm = asRecord(raw['llm'])
    const providersRaw = asRecord(llm?.['providers'])
    if (llm !== undefined && providersRaw !== undefined) {
      const providers = { ...providersRaw }
      for (const [id, value] of Object.entries(providers)) {
        const provider = asRecord(value)
        if (provider === undefined) continue
        // 每轮新建 `[]`：不同 provider 之间不共享同一个数组实例
        const filled = fillMissing(provider, { modelList: [] })
        // 非数组（用户手改配置写错）一律归零：`llm.providers.*` 是 `z.record`，
        // `sanitizeWithDefaults` 对这棵子树**不做逐字段回退**，非法值会一路活到
        // `SettingsSchema.parse`，把整份配置判成损坏（备份 + 重建）。
        // v4 → v5 为 `reasoningEffort` 专门做「非法枚举回落 auto」就是同一个理由。
        const list = filled['modelList']
        if (list !== undefined && !Array.isArray(list)) filled['modelList'] = []
        providers[id] = filled
      }
      next['llm'] = { ...llm, providers }
    }

    next['advanced'] = fillMissing(asRecord(raw['advanced']) ?? {}, {
      readonlyPrefixes: [...SETTINGS_READONLY_PREFIXES],
    })

    next['version'] = 6
    return next
  },
}

/**
 * v6 → v7：为语音合成（TTS 朗读）补齐 `tts.*`（docs/06 §13、docs/08 §1）。
 *
 * 照 v4 → v5 对 `agent` 的做法**无条件**补默认值：`fillMissing` 对**已存在**的值一律保留，
 * 所以用户/设置页写过的 `enabled` / `active` / `autoRead` / `maxChars` 与已有 provider 条目
 * 一个都不动，重复执行结果也一致（幂等）。
 * 唯一被补出来的是缺失字段——老配置因此拿到「关闭自动朗读、无 provider」的干净默认态，
 * 不会被凭空打开朗读。
 */
const migrateV6ToV7: Migration = {
  from: 6,
  to: 7,
  describe:
    'v6 → v7：补齐 tts.*（语音合成配置：总开关 / 默认模型 / 自动朗读 / 截断上限 / providers）',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }

    next['tts'] = fillMissing(
      asRecord(raw['tts']) ?? {},
      DEFAULT_TTS as unknown as Record<string, unknown>,
    )

    next['version'] = 7
    return next
  },
}

/**
 * v7 → v8：补齐语音输入（`stt.*`）、图像生成（`imagegen.*`）、Work 模式工作目录
 * （`modes.work.workspaceDir`）、课前提醒打开文件夹（`modes.classroom.preClassOpenFolder`）
 * 与对话思考过程开关（`general.chat.showThinking`）（Betav2 规格 §4）。
 *
 * 分三种既有套路：
 * - `stt` / `imagegen` 是**新增顶层分组**：照 v6 → v7 对 `tts` 的做法**无条件**补默认值
 *   （`fillMissing` 对已存在的值一律保留，幂等）；
 * - `modes.classroom` / `modes.work` 是**已存在分组里的新字段**：照 v5 → v6 对 `llm.providers`
 *   的做法**只在分组已存在时**补缺失键，不凭空造出半截对象（缺失时由默认配置兜底）；
 * - `general.chat` 是**已存在分组里的新子组**：同样只在 `general` 已存在时补，
 *   保持「缺少 general 分组时迁移不凭空造出 general」的既有语义。
 */
const migrateV7ToV8: Migration = {
  from: 7,
  to: 8,
  describe:
    'v7 → v8：补齐 stt.* 与 imagegen.*（语音输入 / 生图）、modes.work.workspaceDir、modes.classroom.preClassOpenFolder、general.chat.showThinking',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }

    next['stt'] = fillMissing(
      asRecord(raw['stt']) ?? {},
      DEFAULT_STT as unknown as Record<string, unknown>,
    )
    next['imagegen'] = fillMissing(
      asRecord(raw['imagegen']) ?? {},
      DEFAULT_IMAGEGEN as unknown as Record<string, unknown>,
    )

    const modes = asRecord(raw['modes'])
    if (modes !== undefined) {
      const nextModes = { ...modes }
      const classroom = asRecord(nextModes['classroom'])
      if (classroom !== undefined) {
        nextModes['classroom'] = fillMissing(classroom, { preClassOpenFolder: true })
      }
      const work = asRecord(nextModes['work'])
      if (work !== undefined) {
        nextModes['work'] = fillMissing(work, { workspaceDir: '' })
      }
      next['modes'] = nextModes
    }

    const general = asRecord(raw['general'])
    if (general !== undefined) {
      next['general'] = fillMissing(general, { chat: { showThinking: true } })
    }

    next['version'] = 8
    return next
  },
}

/**
 * v8 → v9：为每个已有 `mcp.servers` 条目补 `headersEnc: {}`（HTTP 传输自定义请求头，
 * docs/08 §1 / docs/06 §7）。
 *
 * 照 v7 → v8 对「已存在分组里的新字段」的口径：**只在 `mcp` 分组已存在时**补，
 * 不凭空造出半截对象（缺失时由默认配置兜底）；`headersEnc` 已存在的条目原样保留（幂等）。
 */
const migrateV8ToV9: Migration = {
  from: 8,
  to: 9,
  describe: 'v8 → v9：为每个已有 mcp.servers 条目补 headersEnc: {}（HTTP 传输自定义请求头）',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }

    const mcp = asRecord(raw['mcp'])
    const serversRaw = mcp?.['servers']
    if (mcp !== undefined && Array.isArray(serversRaw)) {
      const servers = serversRaw.map((value) => {
        const server = asRecord(value)
        if (server === undefined) return value
        // 每轮新建 `{}`：不同服务器之间不共享同一个对象实例
        if (asRecord(server['headersEnc']) === undefined) {
          return { ...server, headersEnc: {} }
        }
        return server
      })
      next['mcp'] = { ...mcp, servers }
    }

    next['version'] = 9
    return next
  },
}

/**
 * v9 → v10：为已存在的 `modes.classroom` 补 `preClassLeadMinutes: 5`（课前提早分钟数，
 * docs/05 §3.4、docs/08 §1）。
 *
 * 照 v7 → v8 对「已存在分组里的新字段」的口径：**只在 `modes.classroom` 已存在时**补，
 * 不凭空造出半截对象（缺失时由默认配置兜底）；已写过的值原样保留（幂等）。
 * 这里**不做范围修正** —— 越界值由 Schema 校验回退默认（迁移只负责补缺）。
 */
const migrateV9ToV10: Migration = {
  from: 9,
  to: 10,
  describe: 'v9 → v10：为 modes.classroom 补 preClassLeadMinutes: 5（课前提前分钟数）',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }

    const modes = asRecord(raw['modes'])
    if (modes !== undefined) {
      const nextModes = { ...modes }
      const classroom = asRecord(nextModes['classroom'])
      if (classroom !== undefined) {
        nextModes['classroom'] = fillMissing(classroom, { preClassLeadMinutes: 5 })
      }
      next['modes'] = nextModes
    }

    next['version'] = 10
    return next
  },
}

/**
 * v10 → v11：为每个 `llm.providers.<id>` 补 `contextWindow: 0`（上下文窗口，docs/08 §1）。
 *
 * 补 `0`（= 未知）而不是某个猜测的窗口值：这个字段唯一的用途是「上下文占用比例」的分母，
 * 猜错一个数量级会让用户以为快爆上下文了（或以为还很空）。用户在设置页填了才算数。
 *
 * 照 v9 → v10 的口径：只在 `llm.providers` 已存在时补，不凭空造出 provider；
 * 已写过的值原样保留（幂等）。
 */
const migrateV10ToV11: Migration = {
  from: 10,
  to: 11,
  describe: 'v10 → v11：为 llm.providers 各条目补 contextWindow: 0（上下文窗口，0 = 未知）',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }

    const llm = asRecord(raw['llm'])
    if (llm !== undefined) {
      const providers = asRecord(llm['providers'])
      if (providers !== undefined) {
        const nextProviders: Record<string, unknown> = {}
        for (const [id, provider] of Object.entries(providers)) {
          const entry = asRecord(provider)
          nextProviders[id] =
            entry === undefined ? provider : fillMissing(entry, { contextWindow: 0 })
        }
        next['llm'] = { ...llm, providers: nextProviders }
      }
    }

    next['version'] = 11
    return next
  },
}

/**
 * v11 → v12：为已存在的 `agent.tools` 补 `search.*`（文件检索工具开关与结果上限）
 * 与 `terminal.allowPatterns`（免确认命令模式，docs/06 §11.5 / §11.7、docs/08 §1）。
 *
 * 照 v9 → v10 对「已存在分组里的新字段」的口径：**只在 `agent.tools` 已存在时**补，
 * 不凭空造出半截对象（缺失时由默认配置兜底）；两个字段都**只补缺不覆盖**，
 * 用户已写过的模式列表与上限值原样保留（幂等）。这里**不做范围修正** ——
 * 越界值由 Schema 校验回退默认（迁移只负责补缺）。
 */
const migrateV11ToV12: Migration = {
  from: 11,
  to: 12,
  describe:
    'v11 → v12：为 agent.tools 补 search.* 与 terminal.allowPatterns（文件检索与免确认模式）',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }

    const agent = asRecord(raw['agent'])
    const tools = agent === undefined ? undefined : asRecord(agent['tools'])
    if (agent !== undefined && tools !== undefined) {
      // 每轮新建对象与数组：不与 `DEFAULT_AGENT_TOOLS` 共享实例
      const terminal = asRecord(tools['terminal'])
      const filled =
        terminal === undefined
          ? tools
          : { ...tools, terminal: fillMissing(terminal, { allowPatterns: [] }) }
      // `search` 缺失时由 `fillMissing` 递归补出整组；已存在时只补缺键
      next['agent'] = {
        ...agent,
        tools: fillMissing(filled, { search: { enabled: true, maxResults: 200 } }),
      }
    }

    next['version'] = 12
    return next
  },
}

/**
 * v12 → v13：新增 `projects`（项目机制）与 `agent.permissionMode`（三档权限）
 * （docs/06 §5.1 / §12.2、docs/08 §1）。
 *
 * 口径与 v9 → v10 / v11 → v12 一致：**只补缺、不覆盖**。
 * - `projects` 整组缺失时不凭空造半截对象（由默认配置兜底），已存在时只补缺键；
 * - `agent` 已存在时只补 `permissionMode`，用户已写过的档位原样保留（幂等）；
 * - 两者都缺失时什么都不做 —— 默认配置会把它们补齐（默认 = 无项目 + `confirm` 档，
 *   即与 v12 的行为完全一致）。
 */
const migrateV12ToV13: Migration = {
  from: 12,
  to: 13,
  describe: 'v12 → v13：新增 projects（项目机制）与 agent.permissionMode（三档权限）',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }

    const projects = asRecord(raw['projects'])
    if (projects !== undefined) {
      next['projects'] = fillMissing(projects, { current: '', list: [], maxAgentsBytes: 32768 })
    }

    const agent = asRecord(raw['agent'])
    if (agent !== undefined) {
      next['agent'] = fillMissing(agent, { permissionMode: 'confirm' })
    }

    next['version'] = 13
    return next
  },
}

/**
 * v13 → v14：为已存在的 `agent` 补 `snapshots.*`（写前快照与保留策略，docs/06 §11.8）。
 *
 * 口径与 v12 → v13 一致：**只在 `agent` 已存在时补，只补缺不覆盖**（用户已调过的保留份数
 * 原样保留，幂等）；`agent` 整组缺失时交给默认配置兜底，不凭空造半截对象。
 */
const migrateV13ToV14: Migration = {
  from: 13,
  to: 14,
  describe: 'v13 → v14：为 agent 补 snapshots.*（写前快照的开关、保留份数与容量上限）',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }

    const agent = asRecord(raw['agent'])
    if (agent !== undefined) {
      next['agent'] = fillMissing(agent, {
        snapshots: {
          enabled: true,
          keepPerFile: 20,
          maxSnapshotBytes: 524288,
          totalBudgetBytes: 200 * 1024 * 1024,
        },
      })
    }

    next['version'] = 14
    return next
  },
}

/**
 * v14 → v15：为已存在的 `agent` 补 `loop.*`（轮次上限、token 预算、自动续轮，docs/06 §5 / §4.1）。
 *
 * 口径同 v13 → v14：只在 `agent` 已存在时补、只补缺不覆盖、幂等；`agent` 缺失时交默认配置兜底。
 * 默认值刻意等于 v15 之前写死的行为（`maxRounds: 8`、预算不限、自动续 2 轮），
 * 因此升级后既有的长任务表现不变 —— 只是现在"停下来"会明确说是停在哪。
 */
const migrateV14ToV15: Migration = {
  from: 14,
  to: 15,
  describe: 'v14 → v15：为 agent 补 loop.*（轮次上限、token 预算与自动续轮）',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }

    const agent = asRecord(raw['agent'])
    if (agent !== undefined) {
      next['agent'] = fillMissing(agent, {
        loop: { maxRounds: 8, maxTotalTokens: 0, autoContinueRounds: 2 },
      })
    }

    next['version'] = 15
    return next
  },
}

/**
 * v15 → v16：新增顶层分组 `center`（Aurora Center 连接，docs/12）。
 *
 * 口径同 v12 → v13 的新增分组：`center` 已存在时只补缺失键（幂等，用户已填的
 * serverUrl / 令牌原样保留）；整组缺失时**不凭空造对象**，交给默认配置兜底。
 * `tokenEnc` 是凭据路径（`center.token`），迁移只补空串默认值，不碰已有密文。
 */
const migrateV15ToV16: Migration = {
  from: 15,
  to: 16,
  describe: 'v15 → v16：新增 center 分组（Aurora Center 连接，docs/12）',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }

    const center = asRecord(raw['center'])
    if (center !== undefined) {
      next['center'] = fillMissing(center, {
        enabled: false,
        serverUrl: '',
        tokenEnc: '',
        clientId: '',
        displayName: '',
        allowRemoteSession: true,
        allowRemoteConfig: true,
        allowFileTransfer: true,
        maxFileMb: 64,
      })
    }

    next['version'] = 16
    return next
  },
}

/**
 * v16 → v17：为 `center` 补 `account: ''`（账号登录后记住的账号名，docs/12 §7）。
 *
 * 口径同 v15 → v16：`center` 已存在时只补缺失键（幂等，令牌 / 服务器地址原样保留）；
 * 整组缺失时**不凭空造对象**，交给默认配置兜底。`account` 非凭据，与 `tokenEnc` 互不干扰。
 */
const migrateV16ToV17: Migration = {
  from: 16,
  to: 17,
  describe: 'v16 → v17：center 补 account（账号登录记住的账号名，docs/12 §7）',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }

    const center = asRecord(raw['center'])
    if (center !== undefined) {
      next['center'] = fillMissing(center, { account: '' })
    }

    next['version'] = 17
    return next
  },
}

/**
 * v17 → v18：放宽 Agent 循环上限（docs/06 §5）。
 *
 * v15 的迁移把当时的默认值（`maxRounds: 8`、`autoContinueRounds: 2`）**显式写进了**
 * 已存在的配置里，因此单改 Schema 默认值对老用户无效 —— 这里把**恰好等于旧默认值**的
 * 两个哨兵抬到新默认值（32 / 8）。用户若显式改过（哪怕就填了 8 / 2）也会被抬升：
 * 这是「放宽」方向的迁移，宁可多放不误收紧，已在 docs/08 §1 说明。
 */
const migrateV17ToV18: Migration = {
  from: 17,
  to: 18,
  describe: 'v17 → v18：放宽 agent.loop 轮次上限（maxRounds 8→32，autoContinueRounds 2→8）',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }

    const agent = asRecord(raw['agent'])
    const loop = asRecord(agent?.['loop'])
    if (loop !== undefined) {
      const patched: Record<string, unknown> = { ...loop }
      if (patched['maxRounds'] === 8) patched['maxRounds'] = 32
      if (patched['autoContinueRounds'] === 2) patched['autoContinueRounds'] = 8
      if (agent !== undefined) {
        next['agent'] = { ...agent, loop: patched }
      }
    }

    next['version'] = 18
    return next
  },
}

/**
 * v18 → v19：新增自动化分组（docs/13）。
 *
 * 只有一个总开关 `automations.enabled`（默认 true）——自动化的定义与历史是用户数据，
 * 落在 `<userData>/automations/` 独立存储，不走迁移链。迁移只补默认值、
 * 不覆盖用户已写值；缺分组补整组，已有分组原样保留（幂等）。
 */
const migrateV18ToV19: Migration = {
  from: 18,
  to: 19,
  describe: 'v18 → v19：新增 automations 分组（自动化总开关，默认开启）',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }
    if (next['automations'] === undefined) {
      next['automations'] = { enabled: true }
    }
    next['version'] = 19
    return next
  },
}

/**
 * v19 → v20：新增 `general.requireAdmin`（要求管理员身份启动，docs/08 §1）。
 *
 * 幂等：只补缺字段，用户已写值（false）原样保留；`general` 整组缺失时留给 Schema 兜底
 * （那时会出现一次"整体保留候选对象"的路径，默认值由 defaults.ts 提供）。
 */
const migrateV19ToV20: Migration = {
  from: 19,
  to: 20,
  describe: 'v19 → v20：新增 general.requireAdmin（要求管理员身份启动，默认开启）',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }
    const general = asRecord(next['general'])
    if (general !== undefined && general['requireAdmin'] === undefined) {
      next['general'] = { ...general, requireAdmin: true }
    }
    next['version'] = 20
    return next
  },
}

/**
 * v20 → v21：新增 `general.edgeBar.display` / `general.edgeBar.position`
 * （提示条贴附的显示器与屏幕侧，docs/08 §1 / docs/07 §2.2）。
 *
 * 幂等：只为**已有 `general.edgeBar`** 补缺字段（默认主显示器 + 右缘），已写值原样保留；
 * `edgeBar` 整组缺失时留给 Schema 兜底，不凭空造半截对象。
 */
const migrateV20ToV21: Migration = {
  from: 20,
  to: 21,
  describe: 'v20 → v21：新增 general.edgeBar.display / position 与 appearance.accent',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }
    const general = asRecord(next['general'])
    const edgeBar = general === undefined ? undefined : asRecord(general['edgeBar'])
    if (edgeBar !== undefined) {
      next['general'] = {
        ...general,
        edgeBar: {
          ...edgeBar,
          display: edgeBar['display'] ?? 'primary',
          position: edgeBar['position'] ?? 'right',
        },
      }
    }
    // 外观分组：整组缺失补默认（与 v18 → v19 的 automations 同套路），已存在原样保留
    if (next['appearance'] === undefined) {
      next['appearance'] = { accent: 'aurora' }
    }
    next['version'] = 21
    return next
  },
}

/**
 * v21 → v22：**多模态输入 + Responses API**（docs/06 §3.1 / §3.2、docs/08 §1）。
 *
 * 为**每个已有的** `llm.providers.<id>` 补两件事：
 * - `vision: false`（该模型是否支持图片输入，出厂关：对不支持视觉的模型发图片会被 400）；
 * - 缺失或非法的 `type` 归一为 `openai-compat`（v21 及更早的配置写的本来就是这个值，
 *   因此**不改正值**、只补缺字段与不可识别的值 —— 旧配置升级后请求体逐字不变）。
 *
 * 与 v10 → v11 给 `llm.providers` 补 `contextWindow` 是同一条口径：只在
 * `llm.providers` 已存在时逐条目补缺，`llm` 分组整个缺失时留给 Schema 兜底，
 * 不凭空造半截对象。既有的 `type` 与 `vision` 一律原样保留（幂等）。
 */
const migrateV21ToV22: Migration = {
  from: 21,
  to: 22,
  describe:
    'v21 → v22：为 llm.providers 各条目补 vision: false 并归一 type（多模态输入 / Responses API）',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }

    const llm = asRecord(raw['llm'])
    if (llm !== undefined) {
      const providers = asRecord(llm['providers'])
      if (providers !== undefined) {
        const nextProviders: Record<string, unknown> = {}
        for (const [id, provider] of Object.entries(providers)) {
          const entry = asRecord(provider)
          if (entry === undefined) {
            nextProviders[id] = provider
            continue
          }
          const patched = fillMissing(entry, { vision: false })
          // `type` 是被 Schema 扩过的枚举：只把「缺 / 不是已知取值」的归一为旧协议，
          // 已是 `openai-responses` 的**不动**（迁移不替用户改协议）。
          const type = patched['type']
          if (typeof type !== 'string' || !(LlmProviderTypes as readonly string[]).includes(type)) {
            patched['type'] = 'openai-compat'
          }
          nextProviders[id] = patched
        }
        next['llm'] = { ...llm, providers: nextProviders }
      }
    }

    next['version'] = 22
    return next
  },
}

/**
 * v22 → v23：把 provider 级的三项生成参数搬进**按模型 id 键**的 `modelParams`，
 * 并删除 provider 级的 `temperature`（docs/08 §1 / §2）。
 *
 * 四条语义：
 * ① **幂等** —— 重复执行结果一致；
 * ② **不覆盖已写值** —— 该模型在 `modelParams` 里已有条目时以它为准，旧值只补它缺的键；
 * ③ **`model` 为空串时不造模型条目** —— 此时 `modelParams` 为空表，四个旧键照删
 *   （不凭一个不存在的模型名编出条目）；
 * ④ **旧非法值归一到默认** —— `reasoningEffort: 'ultra'` / `contextWindow: '128k'` /
 *   `vision: 'yes'` 一律回落 `auto` / `0` / `false`。
 *
 * ④ 不是洁癖：`llm.providers` 是 `z.record`，`SettingsStore` 的字段级回退对这类动态键
 * **整体保留候选对象**（`store.ts` 的 `sanitizeWithDefaults`）—— 非法值没法被逐字段回退，
 * 一旦原样搬进 `modelParams` 就会让 `SettingsSchema.parse` 抛错，走「备份 + 重建出厂配置」，
 * 用户的 provider / 凭据 / 项目配置一起消失。归一统一走 `normalizeModelParams`（schema.ts），
 * 保证「什么算合法」只有一份口径。
 *
 * 与 v10 → v11 / v21 → v22 同一条口径：只在 `llm.providers` 已存在时逐条目处理，
 * `llm` 或 `providers` 缺失时留给默认配置兜底，不凭空造半截对象。
 */
const migrateV22ToV23: Migration = {
  from: 22,
  to: 23,
  describe:
    'v22 → v23：把 provider 级 reasoningEffort / contextWindow / vision 搬进 modelParams[model]，删除 temperature',
  transform(raw) {
    const next: Record<string, unknown> = { ...raw }

    const llm = asRecord(raw['llm'])
    if (llm !== undefined) {
      const providers = asRecord(llm['providers'])
      if (providers !== undefined) {
        const nextProviders: Record<string, unknown> = {}
        for (const [id, provider] of Object.entries(providers)) {
          const entry = asRecord(provider)
          nextProviders[id] = entry === undefined ? provider : migrateProviderToModelParams(entry)
        }
        next['llm'] = { ...llm, providers: nextProviders }
      }
    }

    next['version'] = 23
    return next
  },
}

/** 单个 provider 的 v22 → v23 搬运（语义见 `migrateV22ToV23`）。 */
function migrateProviderToModelParams(entry: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = { ...entry }

  // 先把四个旧键摘出来（provider 级一律删除）：三个值待会儿搬进 modelParams，
  // `temperature` 直接丢弃 —— v23 起请求体不再下发它，配置里也就不该留着。
  const legacy = {
    reasoningEffort: patch['reasoningEffort'],
    contextWindow: patch['contextWindow'],
    vision: patch['vision'],
  }
  delete patch['reasoningEffort']
  delete patch['contextWindow']
  delete patch['vision']
  delete patch['temperature']

  // 已有的 modelParams 只可能是手改出来的（v22 及更早没有任何代码写过它）：
  // 逐条目**归一**而不是逐字保留，理由见 `migrateV22ToV23` 的语义 ④。
  const table: Record<string, unknown> = { ...(asRecord(patch['modelParams']) ?? {}) }
  for (const [key, value] of Object.entries(table)) table[key] = normalizeModelParams(value)

  const model = patch['model']
  if (typeof model !== 'string' || model.length === 0) {
    // ③ 没有生效模型：写下（可能为空的）表，四个旧键照删。
    patch['modelParams'] = table
    return patch
  }

  // ② 不覆盖已写值：先把旧值归一（补齐三个键），再用该模型**已写**的原始值盖上去，
  // 最后整体归一一次 —— 于是「缺的键拿旧值、旧值非法拿默认、已写值原样保留」同时成立。
  const current = asRecord(table[model]) ?? {}
  table[model] = normalizeModelParams({ ...normalizeModelParams(legacy), ...current })
  patch['modelParams'] = table
  return patch
}

export const MIGRATIONS: Migration[] = [
  migrateV0ToV1,
  migrateV1ToV2,
  migrateV2ToV3,
  migrateV3ToV4,
  migrateV4ToV5,
  migrateV5ToV6,
  migrateV6ToV7,
  migrateV7ToV8,
  migrateV8ToV9,
  migrateV9ToV10,
  migrateV10ToV11,
  migrateV11ToV12,
  migrateV12ToV13,
  migrateV13ToV14,
  migrateV14ToV15,
  migrateV15ToV16,
  migrateV16ToV17,
  migrateV17ToV18,
  migrateV18ToV19,
  migrateV19ToV20,
  migrateV20ToV21,
  migrateV21ToV22,
  migrateV22ToV23,
]

export interface MigrationOutcome {
  data: Record<string, unknown>
  /** 从哪个版本开始迁移 */
  fromVersion: number
  applied: string[]
  warnings: string[]
}

export function readVersion(raw: Record<string, unknown>): number {
  const version = raw['version']
  if (typeof version === 'number' && Number.isInteger(version) && version >= 0) return version
  return 0
}

export function migrate(
  raw: Record<string, unknown>,
  logger?: Logger,
  targetVersion: number = CONFIG_VERSION,
): MigrationOutcome {
  const warnings: string[] = []
  const applied: string[] = []
  const fromVersion = readVersion(raw)

  if (fromVersion > targetVersion) {
    warnings.push(
      `配置版本 ${fromVersion} 高于当前程序支持的 ${targetVersion}，已按当前版本读取（可能丢失新字段）`,
    )
    logger?.warn('配置版本高于程序支持版本', { fromVersion, targetVersion })
    return { data: raw, fromVersion, applied, warnings }
  }

  let data = raw
  let version = fromVersion
  let guard = 0

  while (version < targetVersion) {
    const step = MIGRATIONS.find((m) => m.from === version)
    if (!step) {
      warnings.push(`缺少 v${version} → v${targetVersion} 的迁移规则，已按默认值重建缺失字段`)
      logger?.warn('缺少迁移规则', { version, targetVersion })
      break
    }
    try {
      data = step.transform(data)
      applied.push(`v${step.from} → v${step.to}：${step.describe}`)
      logger?.info('已执行配置迁移', { describe: step.describe })
    } catch (error) {
      warnings.push(`迁移 v${step.from} → v${step.to} 失败：${String(error)}`)
      logger?.error('配置迁移失败', { error: String(error) })
      break
    }
    version = step.to
    if (++guard > MIGRATIONS.length + 1) break
  }

  data['version'] = targetVersion
  return { data, fromVersion, applied, warnings }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
