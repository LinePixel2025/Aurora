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
 * - MCP 的 `envEnc` / `headersEnc` 是**逐键**合并的：空对象 = 一个键也不改；空串值 = 该键保留已有密文
 *   （新增服务器时它是「占位」，随后由 `settings:setSecrets` 写成真密文）。
 * - 删除语义按容器类型区分：`llm.providers`（以及同构的 `tts` / `stt` / `imagegen` 的
 *   `providers`）是 **record**，缺项 ≠ 删除（必须显式声明各自的 `removedProviders`）；
 *   `mcp.servers` 是**数组**，整数组权威（不在数组里 = 删除）。
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
  if (
    patch.llm?.providers === undefined &&
    patch.mcp?.servers === undefined &&
    patch.tts?.providers === undefined &&
    patch.stt?.providers === undefined &&
    patch.imagegen?.providers === undefined
  ) {
    return { patch, secrets: {} }
  }

  const next = deepClone(patch)
  const secrets: SecretEntries = {}

  const extractProviderKeys = (
    providers: Record<string, unknown> | undefined,
    prefix: string,
  ): void => {
    for (const [id, provider] of Object.entries(providers ?? {})) {
      const draft = provider as Record<string, unknown>
      const apiKey = draft['apiKey']
      if (typeof apiKey === 'string') {
        delete draft['apiKey']
        if (apiKey !== '') secrets[`${prefix}.${id}.apiKey`] = apiKey
      }
    }
  }

  // llm / tts / stt / imagegen 四组 provider 同构：明文 `apiKey` 只经这里落库，
  // 合并进 draft 的副本里永远不带它（Schema 里只有 `apiKeyEnc` 字段）。
  extractProviderKeys(next.llm?.providers, 'llm.providers')
  extractProviderKeys(next.tts?.providers, 'tts.providers')
  extractProviderKeys(next.stt?.providers, 'stt.providers')
  extractProviderKeys(next.imagegen?.providers, 'imagegen.providers')

  for (const server of next.mcp?.servers ?? []) {
    const draft = server as unknown as Record<string, unknown>
    const env = draft['env']
    if (env !== null && typeof env === 'object') {
      for (const [name, value] of Object.entries(env as Record<string, string>)) {
        if (value !== '') secrets[`mcp.servers.${server.name}.env.${name}`] = value
      }
      delete draft['env']
    }
    // 明文 headers 与 env 同款：只经 setSecrets 落库（路径 `mcp.servers.<name>.headers.<key>`），
    // 合并进 draft 的副本里永远不带它（Schema 里只有 `headersEnc` 字段，docs/08 §1）。
    const headers = draft['headers']
    if (headers !== null && typeof headers === 'object') {
      for (const [name, value] of Object.entries(headers as Record<string, string>)) {
        if (value !== '') secrets[`mcp.servers.${server.name}.headers.${name}`] = value
      }
      delete draft['headers']
    }
  }

  return { patch: next, secrets }
}

/**
 * 把 patch 按分组局部合并进 `draft`（就地修改），返回**必须 `clearSecret` 的路径**。
 *
 * 返回值存在的理由：删除条目（provider / MCP 服务器）时，密文随条目一起消失，
 * 但 `SettingsStore.memorySecrets` 里的**明文缓存**还在 —— 不清掉就会出现
 * 「`hasSecret` 说还有、配置里已经没有这个条目」的幽灵凭据。
 */
export function mergeSettingsPatch(draft: Settings, patch: SettingsPatch): string[] {
  const cleared: string[] = []

  // provider 级：`llm.providers` 是 record，「缺项」表达不了删除 —— 删除必须由
  // `llm.removedProviders` 显式声明（缺项 ≠ 删除，见 `SettingsPatch` 的注释）。
  const providers = { ...draft.llm.providers }
  const removals = [...(patch.llm?.removedProviders ?? [])]
  for (const id of removals) delete providers[id]

  // 再逐个 provider 合并：渲染层永远看不到 `apiKeyEnc`（docs/08 §1.1），必须保留已有密文，
  // 否则设置页改一次模型名就会把凭据清空（Schema 也会因缺字段而校验失败）。
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

  // 被声明的删除：只要最终状态里没有密文（条目没了，或同一 patch 又把它建回来但没给密文），
  // 就要求清掉磁盘密文与内存明文缓存 —— 否则 `hasSecret` 会对着一个没有密文的 provider
  // 说"还有凭据"。同一 patch 里「删了又给出密文」则以给出为准，不清。
  for (const id of removals) {
    if ((providers[id]?.apiKeyEnc ?? '') === '') cleared.push(`llm.providers.${id}.apiKey`)
  }

  // TTS provider 级：与 `llm.providers` **同一套语义**（两者都是 record，缺项 ≠ 删除），
  // 因此这里逐句照搬上面的两个环节，只是容器换成 `draft.tts.providers`。
  const ttsProviders = { ...draft.tts.providers }
  const ttsRemovals = [...(patch.tts?.removedProviders ?? [])]
  for (const id of ttsRemovals) delete ttsProviders[id]

  for (const [id, provider] of Object.entries(patch.tts?.providers ?? {})) {
    const existing = ttsProviders[id]
    const incoming = { ...provider } as Record<string, unknown>
    // 空串只能理解为「本次不改凭据」；新建 provider 时保留空串（`TtsProviderSchema` 要求字段存在）。
    if (existing !== undefined && incoming['apiKeyEnc'] === '') delete incoming['apiKeyEnc']
    ttsProviders[id] = {
      ...(existing ?? {}),
      ...incoming,
    } as Settings['tts']['providers'][string]
  }

  for (const id of ttsRemovals) {
    if ((ttsProviders[id]?.apiKeyEnc ?? '') === '') cleared.push(`tts.providers.${id}.apiKey`)
  }

  // STT / 生图 provider 级：与 `tts.providers` **完全同一套** record 合并语义
  // （缺项 ≠ 删除、空 `apiKeyEnc` 回传 = 本次不改凭据、removedProviders 显式删除）。
  // 四组 provider（llm / tts / stt / imagegen）逐句照搬是刻意的：形状一致但配置独立，
  // 抽象成通用循环反而会把「每组都要有删除语义」这层契约藏进泛型里。

  const sttProviders = { ...draft.stt.providers }
  const sttRemovals = [...(patch.stt?.removedProviders ?? [])]
  for (const id of sttRemovals) delete sttProviders[id]

  for (const [id, provider] of Object.entries(patch.stt?.providers ?? {})) {
    const existing = sttProviders[id]
    const incoming = { ...provider } as Record<string, unknown>
    if (existing !== undefined && incoming['apiKeyEnc'] === '') delete incoming['apiKeyEnc']
    sttProviders[id] = {
      ...(existing ?? {}),
      ...incoming,
    } as Settings['stt']['providers'][string]
  }

  for (const id of sttRemovals) {
    if ((sttProviders[id]?.apiKeyEnc ?? '') === '') cleared.push(`stt.providers.${id}.apiKey`)
  }

  const imageGenProviders = { ...draft.imagegen.providers }
  const imageGenRemovals = [...(patch.imagegen?.removedProviders ?? [])]
  for (const id of imageGenRemovals) delete imageGenProviders[id]

  for (const [id, provider] of Object.entries(patch.imagegen?.providers ?? {})) {
    const existing = imageGenProviders[id]
    const incoming = { ...provider } as Record<string, unknown>
    if (existing !== undefined && incoming['apiKeyEnc'] === '') delete incoming['apiKeyEnc']
    imageGenProviders[id] = {
      ...(existing ?? {}),
      ...incoming,
    } as Settings['imagegen']['providers'][string]
  }

  for (const id of imageGenRemovals) {
    if ((imageGenProviders[id]?.apiKeyEnc ?? '') === '') {
      cleared.push(`imagegen.providers.${id}.apiKey`)
    }
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
      // headers 与 env 并列：删除服务器 / 清键时同样要丢弃内存明文缓存。
      for (const headerKey of Object.keys(server.headersEnc)) {
        const cipher = after?.headersEnc[headerKey]
        if (typeof cipher !== 'string' || cipher === '') {
          cleared.push(`mcp.servers.${server.name}.headers.${headerKey}`)
        }
      }
    }
  }

  if (patch.general !== undefined) Object.assign(draft.general, patch.general)
  if (patch.llm !== undefined) {
    // `removedProviders` 是删除指令、不是配置字段：不能落进 `draft.llm`
    //（否则会进 Zod 解析，将来换成严格 schema 就会直接抛错）。
    const llmPatch = { ...patch.llm } as Record<string, unknown>
    delete llmPatch['removedProviders']
    Object.assign(draft.llm, llmPatch)
  }
  draft.llm.providers = providers
  if (patch.tts !== undefined) {
    // 同 `llm`：`removedProviders` 是删除指令，落进 `draft.tts` 会进 Zod 解析。
    const ttsPatch = { ...patch.tts } as Record<string, unknown>
    delete ttsPatch['removedProviders']
    Object.assign(draft.tts, ttsPatch)
  }
  draft.tts.providers = ttsProviders
  if (patch.stt !== undefined) {
    // 同 `tts`：`removedProviders` 是删除指令，不能落进 `draft.stt` 进 Zod 解析。
    const sttPatch = { ...patch.stt } as Record<string, unknown>
    delete sttPatch['removedProviders']
    Object.assign(draft.stt, sttPatch)
  }
  draft.stt.providers = sttProviders
  if (patch.imagegen !== undefined) {
    const imageGenPatch = { ...patch.imagegen } as Record<string, unknown>
    delete imageGenPatch['removedProviders']
    Object.assign(draft.imagegen, imageGenPatch)
  }
  draft.imagegen.providers = imageGenProviders
  if (patch.advanced !== undefined) Object.assign(draft.advanced, patch.advanced)
  if (patch.skills !== undefined) Object.assign(draft.skills, patch.skills)
  if (patch.mcp !== undefined) Object.assign(draft.mcp, patch.mcp)
  draft.mcp.servers = servers
  if (patch.modes !== undefined) Object.assign(draft.modes, patch.modes)
  // 项目机制（v13）：顶层浅合并 —— 只传 `{ current }` 时 `list` / `maxAgentsBytes` 原样保留。
  if (patch.projects !== undefined) Object.assign(draft.projects, patch.projects)
  // 电脑操控工具：`SettingsPatch.agent` 是**整棵** tools 子树，直接覆盖即可
  // （只传 `{ terminal: {...} }` 会把 files / open 静默丢掉，设置页必须带完整的树）。
  if (patch.agent !== undefined) Object.assign(draft.agent, patch.agent)
  // Aurora Center（v16，docs/12）：顶层浅合并。补丁类型已排除 `tokenEnc`，
  // 这里再运行期剥一次 —— 配对令牌只走 `setSecrets`，构造出的 patch 洗不掉已存密文。
  if (patch.center !== undefined) {
    const center = { ...patch.center } as Record<string, unknown>
    delete center['tokenEnc']
    Object.assign(draft.center, center)
  }

  return cleared
}

/**
 * 单个 MCP 服务器的合并：字段级覆盖 + `envEnc` / `headersEnc` **逐键**合并。
 *
 * 「空对象 = 本次不改凭据」直接落在键上：以已有密文为底，incoming 里的键
 *  - 值为空串且已有密文 → 保留已有密文（渲染层的占位 / 未修改标记）；
 *  - 值为空串且没有密文 → 保留空占位（新增服务器时由 `settings:setSecrets` 写入真密文）；
 *  - 值为非空密文 → 覆盖。
 * 于是渲染层回传一份脱敏过的服务器列表（每个 `envEnc` / `headersEnc` 都是 `{}`）不会动任何密文。
 */
function mergeMcpServer(before: McpServerConfig[], incoming: McpServerConfig): McpServerConfig {
  const existing = before.find((server) => server.name === incoming.name)
  const envEnc: Record<string, string> = { ...(existing?.envEnc ?? {}) }
  for (const [envKey, cipher] of Object.entries(incoming.envEnc ?? {})) {
    if (cipher === '' && envEnc[envKey] !== undefined) continue
    envEnc[envKey] = cipher
  }
  // `headersEnc` 与 `envEnc` 完全同款（v9，docs/08 §1.1）：逐键合并，空串 = 保留已有密文。
  const headersEnc: Record<string, string> = { ...(existing?.headersEnc ?? {}) }
  for (const [headerKey, cipher] of Object.entries(incoming.headersEnc ?? {})) {
    if (cipher === '' && headersEnc[headerKey] !== undefined) continue
    headersEnc[headerKey] = cipher
  }
  return { ...(existing ?? {}), ...incoming, envEnc, headersEnc }
}
