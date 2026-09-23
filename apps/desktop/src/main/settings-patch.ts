/**
 * 配置补丁的**纯合并逻辑**（`SettingsPatch` → `Settings`）。
 *
 * 从 `main/ipc.ts` 的 `applyPatch` 抽出来的两个理由：
 * 1. `ipc.ts` import electron（注册 IPC 必须），Node 环境的 vitest 加载不了它；
 *    抽成不依赖 electron 的模块后，「凭据保留 / 合并语义」才能被单测直接覆盖；
 * 2. 「合并」与「落库」分离：这里只改 `draft`、只**声明**该清哪些凭据路径，
 *    真正的加密落盘、清理与广播仍由 `ipc.ts` 的 `applyPatch` 统一做
 *    —— 它依然是配置写入的唯一落地点（docs/06 §12.4）。
 *
 * 两条反复踩过的语义（改之前先读 `settings-patch.test.ts`）：
 * - 渲染层**永远看不到密文**：`settings:get` 把 `apiKeyEnc` 置空串、`envEnc` 置空对象
 *   （docs/08 §1.1）。因此回传里的「空」只能理解为**本次不改凭据**，
 *   否则设置页保存一次就会把磁盘上的密文清空（同进程被 `memorySecrets` 掩盖，重启才暴露）。
 * - MCP 的 `envEnc` 是**逐键**合并的：空对象 = 一个键也不改；空串值 = 该键保留已有密文
 *   （新增服务器时它是「占位」，随后由 `settings:setSecrets` 写成真密文）。
 */
import {
  deepClone,
  type McpServerConfig,
  type SecretEntries,
  type Settings,
  type SettingsPatch,
} from '@aurora/shared'

export interface PatchSecrets {
  /** 抽走明文凭据字段（`apiKey` / `env`）后的 patch 副本（不改调用方对象） */
  patch: SettingsPatch
  /** 敏感路径 → 明文值，由 `SettingsStore.setSecret` 加密落盘 */
  secrets: SecretEntries
}

/**
 * 抽取 patch 里的**明文凭据**，返回不含凭据字段的副本。
 *
 * 纯函数（不就地 `delete` 调用方对象）：`SettingsPatch` 可能来自 IPC，
 * 也可能来自工具端口自己构造的对象，就地修改会改到调用方的数据。
 */
export function extractPatchSecrets(patch: SettingsPatch): PatchSecrets {
  if (patch.llm?.providers === undefined && patch.mcp?.servers === undefined) {
    return { patch, secrets: {} }
  }

  const next = deepClone(patch)
  const secrets: SecretEntries = {}

  for (const [id, provider] of Object.entries(next.llm?.providers ?? {})) {
    const draft = provider as unknown as Record<string, unknown>
    const apiKey = draft['apiKey']
    if (typeof apiKey === 'string') {
      delete draft['apiKey']
      if (apiKey !== '') secrets[`llm.providers.${id}.apiKey`] = apiKey
    }
  }

  for (const server of next.mcp?.servers ?? []) {
    const draft = server as unknown as Record<string, unknown>
    const env = draft['env']
    if (env !== null && typeof env === 'object') {
      for (const [name, value] of Object.entries(env as Record<string, string>)) {
        if (value !== '') secrets[`mcp.servers.${server.name}.env.${name}`] = value
      }
      delete draft['env']
    }
  }

  return { patch: next, secrets }
}

/**
 * 把 patch 按分组局部合并进 `draft`（就地修改），返回**必须 `clearSecret` 的路径**。
 *
 * 返回值存在的理由：删除条目（provider / MCP 服务器）时，密文随条目一起消失，
 * 但 `SettingsStore.memorySecrets` 里的**明文缓存**还在 —— 不清掉就会出现
 * 「`hasSecret` 说还有、可配置里已经没有这个条目」的幽灵凭据。
 */
export function mergeSettingsPatch(draft: Settings, patch: SettingsPatch): string[] {
  const cleared: string[] = []

  // provider 级：渲染层永远看不到 `apiKeyEnc`（docs/08 §1.1），必须保留已有密文，
  // 否则设置页改一次模型名就会把凭据清空（Schema 也会因缺字段而校验失败）。
  const providers = { ...draft.llm.providers }
  for (const [id, provider] of Object.entries(patch.llm?.providers ?? {})) {
    const existing = providers[id]
    const incoming = { ...provider } as Record<string, unknown>
    // 空串只能理解为「本次不改凭据」；新建 provider（没有 existing）时保留空串：
    // `LlmProviderSchema` 要求该字段存在。
    if (existing !== undefined && incoming['apiKeyEnc'] === '') delete incoming['apiKeyEnc']
    providers[id] = {
      ...(existing ?? {}),
      ...incoming,
    } as Settings['llm']['providers'][string]
  }

  // MCP 级：`patch.mcp.servers` 是**整数组权威**（不在数组里 = 删除），
  // 但每个服务器的 `envEnc` 逐键合并（见 `mergeMcpServer`）。
  const before = draft.mcp.servers
  const incomingServers = patch.mcp?.servers
  const servers =
    incomingServers === undefined
      ? before
      : incomingServers.map((server) => mergeMcpServer(before, server))

  if (incomingServers !== undefined) {
    for (const server of before) {
      const after = servers.find((item) => item.name === server.name)
      for (const envKey of Object.keys(server.envEnc)) {
        // 服务器被删掉，或该键在新值里只剩空占位（值待 `setSecrets` 写入）：
        // 旧明文缓存都必须丢弃；密文被原样保留时则不能动。
        const cipher = after?.envEnc[envKey]
        if (typeof cipher !== 'string' || cipher === '') {
          cleared.push(`mcp.servers.${server.name}.env.${envKey}`)
        }
      }
    }
  }

  if (patch.general !== undefined) Object.assign(draft.general, patch.general)
  if (patch.llm !== undefined) Object.assign(draft.llm, patch.llm)
  draft.llm.providers = providers
  if (patch.advanced !== undefined) Object.assign(draft.advanced, patch.advanced)
  if (patch.skills !== undefined) Object.assign(draft.skills, patch.skills)
  if (patch.mcp !== undefined) Object.assign(draft.mcp, patch.mcp)
  draft.mcp.servers = servers
  if (patch.modes !== undefined) Object.assign(draft.modes, patch.modes)
  // 电脑操控工具：`SettingsPatch.agent` 是**整棵** tools 子树，直接覆盖即可
  // （只传 `{ terminal: {...} }` 会把 files / open 静默丢掉，设置页必须带完整的树）。
  if (patch.agent !== undefined) Object.assign(draft.agent, patch.agent)

  return cleared
}

/**
 * 单个 MCP 服务器的合并：字段级覆盖 + `envEnc` **逐键**合并。
 *
 * 「空对象 = 本次不改凭据」直接落在键上：以已有 `envEnc` 为底，incoming 里的键
 *  - 值为空串且已有密文 → 保留已有密文（渲染层的占位 / 未修改标记）；
 *  - 值为空串且没有密文 → 保留空占位（新增服务器时由 `settings:setSecrets` 写入真密文）；
 *  - 值为非空密文 → 覆盖。
 * 于是渲染层回传一份脱敏过的服务器列表（每个 `envEnc` 都是 `{}`）不会动任何密文。
 */
function mergeMcpServer(before: McpServerConfig[], incoming: McpServerConfig): McpServerConfig {
  const existing = before.find((server) => server.name === incoming.name)
  const envEnc: Record<string, string> = { ...(existing?.envEnc ?? {}) }
  for (const [envKey, cipher] of Object.entries(incoming.envEnc ?? {})) {
    if (cipher === '' && envEnc[envKey] !== undefined) continue
    envEnc[envKey] = cipher
  }
  return { ...(existing ?? {}), ...incoming, envEnc }
}
