/**
 * 配置补丁合并语义单测（`settings-patch.ts`）。
 *
 * 这些断言锁的是「反复踩过的坑」，不是实现细节：
 * - 渲染层永远看不到密文（`settings:get` / `settings:changed` 一律脱敏，docs/08 §1.1），
 *   所以回传里的空值只能是「本次不改凭据」；
 * - MCP 的 `envEnc` 逐键合并：空对象 = 一个键也不改，空串 = 该键保留已有密文。
 */
import { describe, expect, it } from 'vitest'
import { SettingsSchema, createDefaultSettings } from '@aurora/shared'
import type {
  LlmProviderConfig,
  McpServerConfig,
  Settings,
  SettingsPatch,
  TtsProviderConfig,
} from '@aurora/shared'
import { extractPatchSecrets, mergeSettingsPatch } from './settings-patch.js'

function mcpServer(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: 'demo',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'server'],
    envEnc: {},
    enabled: true,
    ...overrides,
  }
}

function provider(overrides: Partial<LlmProviderConfig> = {}): LlmProviderConfig {
  return {
    type: 'openai-compat',
    baseUrl: 'https://api.example.com',
    apiKeyEnc: 'CIPHER-KEY',
    model: 'demo-model',
    modelList: ['demo-model'],
    temperature: 0.7,
    reasoningEffort: 'auto',
    ...overrides,
  }
}

function ttsProvider(overrides: Partial<TtsProviderConfig> = {}): TtsProviderConfig {
  return {
    type: 'openai-compat',
    baseUrl: 'https://api.example.com/v1',
    apiKeyEnc: 'CIPHER-TTS',
    model: 'tts-model',
    voice: 'alloy',
    speed: 1,
    format: 'mp3',
    ...overrides,
  }
}

/** 造一份合法配置（走 Schema，保证与真实落盘形状一致）。 */
function settingsWith(
  overrides: {
    servers?: McpServerConfig[]
    providers?: Record<string, LlmProviderConfig>
    ttsProviders?: Record<string, TtsProviderConfig>
  } = {},
): Settings {
  const base = createDefaultSettings()
  if (overrides.servers !== undefined) base.mcp.servers = overrides.servers
  if (overrides.providers !== undefined) base.llm.providers = overrides.providers
  if (overrides.ttsProviders !== undefined) base.tts.providers = overrides.ttsProviders
  return SettingsSchema.parse(base)
}

describe('mergeSettingsPatch —— MCP envEnc 不能因脱敏回传而丢失', () => {
  it('回传空 envEnc（设置页保存的真实形状）保留已有密文，其余字段照常更新', () => {
    const draft = settingsWith({ servers: [mcpServer({ envEnc: { TOKEN: 'CIPHER-A' } })] })

    const cleared = mergeSettingsPatch(draft, {
      mcp: { servers: [mcpServer({ envEnc: {}, enabled: false })] },
    })

    expect(draft.mcp.servers[0]?.envEnc).toEqual({ TOKEN: 'CIPHER-A' })
    expect(draft.mcp.servers[0]?.enabled).toBe(false)
    expect(cleared).toEqual([])
  })

  it('envEnc 逐键合并：空串保留旧密文、非空覆盖、新键并入（并集）', () => {
    const draft = settingsWith({ servers: [mcpServer({ envEnc: { TOKEN: 'CIPHER-A' } })] })

    const cleared = mergeSettingsPatch(draft, {
      mcp: { servers: [mcpServer({ envEnc: { TOKEN: '', EXTRA: 'CIPHER-B' } })] },
    })

    expect(draft.mcp.servers[0]?.envEnc).toEqual({ TOKEN: 'CIPHER-A', EXTRA: 'CIPHER-B' })
    expect(cleared).toEqual([])
  })

  it('新增服务器：空串占位保留下来，等 setSecrets 写真密文', () => {
    const draft = settingsWith({ servers: [] })

    const cleared = mergeSettingsPatch(draft, {
      mcp: { servers: [mcpServer({ name: 'fresh', envEnc: { TOKEN: '' } })] },
    })

    expect(draft.mcp.servers).toHaveLength(1)
    expect(draft.mcp.servers[0]?.envEnc).toEqual({ TOKEN: '' })
    expect(cleared).toEqual([])
  })

  it('服务器被删（不在权威数组里）：条目消失，且每个环境变量都要求清理明文缓存', () => {
    const draft = settingsWith({
      servers: [
        mcpServer({ envEnc: { TOKEN: 'CIPHER-A', OTHER: 'CIPHER-B' } }),
        mcpServer({ name: 'keep', envEnc: { K: 'CIPHER-C' } }),
      ],
    })

    const cleared = mergeSettingsPatch(draft, { mcp: { servers: [mcpServer({ name: 'keep' })] } })

    expect(draft.mcp.servers.map((server) => server.name)).toEqual(['keep'])
    expect(cleared.sort()).toEqual(['mcp.servers.demo.env.OTHER', 'mcp.servers.demo.env.TOKEN'])
  })

  it('只改 mcp.lazyConnect（不带 servers）时服务器列表与密文一律不动', () => {
    const draft = settingsWith({ servers: [mcpServer({ envEnc: { TOKEN: 'CIPHER-A' } })] })

    const cleared = mergeSettingsPatch(draft, { mcp: { lazyConnect: true } })

    expect(draft.mcp.lazyConnect).toBe(true)
    expect(draft.mcp.servers[0]?.envEnc).toEqual({ TOKEN: 'CIPHER-A' })
    expect(cleared).toEqual([])
  })
})

describe('mergeSettingsPatch —— provider 密文保留', () => {
  it('已有 provider 收到空 apiKeyEnc 时保留密文，业务字段照常覆盖', () => {
    const draft = settingsWith({ providers: { demo: provider({ apiKeyEnc: 'CIPHER-P' }) } })

    const cleared = mergeSettingsPatch(draft, {
      llm: { providers: { demo: provider({ apiKeyEnc: '', model: 'next-model' }) } },
    })

    expect(draft.llm.providers['demo']?.apiKeyEnc).toBe('CIPHER-P')
    expect(draft.llm.providers['demo']?.model).toBe('next-model')
    expect(cleared).toEqual([])
  })

  it('全新 provider 允许带空 apiKeyEnc（Schema 要求该字段存在）', () => {
    const draft = settingsWith({ providers: {} })

    mergeSettingsPatch(draft, {
      llm: { providers: { fresh: provider({ apiKeyEnc: '', model: 'fresh-model' }) } },
    })

    expect(draft.llm.providers['fresh']?.apiKeyEnc).toBe('')
    expect(draft.llm.providers['fresh']?.model).toBe('fresh-model')
  })

  it('缺项的 providers 回传不会误删其它 provider（删除必须显式声明）', () => {
    const draft = settingsWith({
      providers: { a: provider(), b: provider({ model: 'b-model' }) },
    })

    const cleared = mergeSettingsPatch(draft, {
      llm: { providers: { a: provider({ model: 'a-next' }) } },
    })

    expect(Object.keys(draft.llm.providers).sort()).toEqual(['a', 'b'])
    expect(cleared).toEqual([])
  })
})

describe('mergeSettingsPatch —— 删除 provider 必须显式声明', () => {
  it('removedProviders 真的删掉 provider，并声明清理它的凭据', () => {
    const draft = settingsWith({
      providers: { a: provider({ apiKeyEnc: 'CIPHER-A' }), b: provider({ model: 'b-model' }) },
    })

    const cleared = mergeSettingsPatch(draft, {
      llm: { removedProviders: ['a'], providers: { b: provider({ model: 'b-model' }) } },
    })

    expect(Object.keys(draft.llm.providers)).toEqual(['b'])
    expect(cleared).toEqual(['llm.providers.a.apiKey'])
  })

  it('声明删除一个不存在的 id：不误删别的 provider，清理路径幂等（主进程侧是 no-op）', () => {
    const draft = settingsWith({ providers: { a: provider() } })

    const cleared = mergeSettingsPatch(draft, { llm: { removedProviders: ['ghost'] } })

    expect(Object.keys(draft.llm.providers)).toEqual(['a'])
    expect(cleared).toEqual(['llm.providers.ghost.apiKey'])
  })

  it('同一 patch 里「删了又给出空密文」：按新建处理，旧密文与缓存都要清', () => {
    const draft = settingsWith({ providers: { a: provider({ apiKeyEnc: 'OLD-CIPHER' }) } })

    const cleared = mergeSettingsPatch(draft, {
      llm: {
        removedProviders: ['a'],
        providers: { a: provider({ apiKeyEnc: '', model: 'next' }) },
      },
    })

    expect(draft.llm.providers['a']?.apiKeyEnc).toBe('')
    expect(draft.llm.providers['a']?.model).toBe('next')
    expect(cleared).toEqual(['llm.providers.a.apiKey'])
  })

  it('同一 patch 里「删了又给出新密文」：以给出的为准，不清凭据', () => {
    const draft = settingsWith({ providers: { a: provider({ apiKeyEnc: 'OLD-CIPHER' }) } })

    const cleared = mergeSettingsPatch(draft, {
      llm: { removedProviders: ['a'], providers: { a: provider({ apiKeyEnc: 'NEW-CIPHER' }) } },
    })

    expect(draft.llm.providers['a']?.apiKeyEnc).toBe('NEW-CIPHER')
    expect(cleared).toEqual([])
  })

  it('removedProviders 是删除指令，不会渗进配置对象', () => {
    const draft = settingsWith({ providers: { a: provider() } })

    mergeSettingsPatch(draft, { llm: { removedProviders: ['a'] } })

    expect('removedProviders' in (draft.llm as unknown as Record<string, unknown>)).toBe(false)
  })
})

describe('mergeSettingsPatch —— TTS provider 与 llm 同一套合并 / 删除语义', () => {
  it('回传空 apiKeyEnc 时保留已有密文，其余字段照常覆盖（改一次音色不该清凭据）', () => {
    const draft = settingsWith({
      ttsProviders: { demo: ttsProvider({ apiKeyEnc: 'CIPHER-TTS' }) },
    })

    const cleared = mergeSettingsPatch(draft, {
      tts: { providers: { demo: ttsProvider({ apiKeyEnc: '', voice: 'nova' }) } },
    })

    expect(draft.tts.providers['demo']?.apiKeyEnc).toBe('CIPHER-TTS')
    expect(draft.tts.providers['demo']?.voice).toBe('nova')
    expect(cleared).toEqual([])
  })

  it('缺项的 providers 回传不会误删其它 TTS provider（删除必须显式声明）', () => {
    const draft = settingsWith({
      ttsProviders: { a: ttsProvider(), b: ttsProvider({ model: 'b-model' }) },
    })

    const cleared = mergeSettingsPatch(draft, {
      tts: { providers: { a: ttsProvider({ model: 'a-next' }) } },
    })

    expect(Object.keys(draft.tts.providers).sort()).toEqual(['a', 'b'])
    expect(cleared).toEqual([])
  })

  it('removedProviders 真的删掉 TTS provider，并声明清理它的凭据', () => {
    const draft = settingsWith({
      ttsProviders: { a: ttsProvider({ apiKeyEnc: 'CIPHER-A' }), b: ttsProvider() },
    })

    const cleared = mergeSettingsPatch(draft, {
      tts: { removedProviders: ['a'], providers: { b: ttsProvider() } },
    })

    expect(Object.keys(draft.tts.providers)).toEqual(['b'])
    expect(cleared).toEqual(['tts.providers.a.apiKey'])
  })

  it('被删的 id 在最终状态里没有密文才清；同一 patch 里「删了又给出新密文」则不清', () => {
    const draft = settingsWith({
      ttsProviders: { a: ttsProvider({ apiKeyEnc: 'OLD-CIPHER' }) },
    })

    const cleared = mergeSettingsPatch(draft, {
      tts: { removedProviders: ['a'], providers: { a: ttsProvider({ apiKeyEnc: 'NEW-CIPHER' }) } },
    })

    expect(draft.tts.providers['a']?.apiKeyEnc).toBe('NEW-CIPHER')
    expect(cleared).toEqual([])
  })

  it('removedProviders 是删除指令，不会渗进 tts 配置对象；其它字段照常浅合并', () => {
    const draft = settingsWith({ ttsProviders: { a: ttsProvider() } })

    mergeSettingsPatch(draft, {
      tts: { removedProviders: ['a'], enabled: false, autoRead: true, maxChars: 500 },
    })

    expect('removedProviders' in (draft.tts as unknown as Record<string, unknown>)).toBe(false)
    expect(draft.tts.enabled).toBe(false)
    expect(draft.tts.autoRead).toBe(true)
    expect(draft.tts.maxChars).toBe(500)
    // 只改开关的 patch 不带 providers，也不该碰 provider 列表
    expect('a' in draft.tts.providers).toBe(false)
  })
})

describe('extractPatchSecrets', () => {
  it('抽出 TTS provider 的 apiKey 明文并摘掉字段，空串不入 secrets', () => {
    const patch = {
      tts: {
        providers: {
          a: { ...ttsProvider(), apiKey: 'tts-plain' },
          b: { ...ttsProvider(), apiKey: '' },
        },
      },
    } as unknown as SettingsPatch

    const { patch: cleaned, secrets } = extractPatchSecrets(patch)

    expect(secrets).toEqual({ 'tts.providers.a.apiKey': 'tts-plain' })
    expect('apiKey' in (cleaned.tts?.providers?.['a'] as unknown as Record<string, unknown>)).toBe(
      false,
    )
    expect('apiKey' in (cleaned.tts?.providers?.['b'] as unknown as Record<string, unknown>)).toBe(
      false,
    )
    // 纯函数：不改调用方对象
    const original = patch.tts?.providers?.['a'] as unknown as Record<string, unknown>
    expect('apiKey' in original).toBe(true)
  })

  it('抽出非空 MCP env 明文，并从 patch 副本里摘掉 env 字段', () => {
    // `env`（明文）只存在于 IPC 进站数据里，不在 Schema 上，因此这里显式构造 + 断言
    const incoming = { ...mcpServer({ name: 'demo' }), env: { TOKEN: 'plain-token', EMPTY: '' } }
    const patch = { mcp: { servers: [incoming] } } as unknown as SettingsPatch

    const { patch: cleaned, secrets } = extractPatchSecrets(patch)

    expect(secrets).toEqual({ 'mcp.servers.demo.env.TOKEN': 'plain-token' })
    const cleanedServer = cleaned.mcp?.servers?.[0] as unknown as Record<string, unknown>
    expect('env' in cleanedServer).toBe(false)
    // 纯函数：不改调用方对象（否则工具端口自己构造的 patch 会被就地改坏）
    const originalServer = patch.mcp?.servers?.[0] as unknown as Record<string, unknown>
    expect('env' in originalServer).toBe(true)
  })

  it('抽出 provider 的 apiKey 明文并摘掉字段，空串不入 secrets', () => {
    const patch = {
      llm: {
        providers: {
          a: { ...provider(), apiKey: 'sk-plain' },
          b: { ...provider(), apiKey: '' },
        },
      },
    } as unknown as SettingsPatch

    const { patch: cleaned, secrets } = extractPatchSecrets(patch)

    expect(secrets).toEqual({ 'llm.providers.a.apiKey': 'sk-plain' })
    expect('apiKey' in (cleaned.llm?.providers?.['a'] as unknown as Record<string, unknown>)).toBe(
      false,
    )
    expect('apiKey' in (cleaned.llm?.providers?.['b'] as unknown as Record<string, unknown>)).toBe(
      false,
    )
  })

  it('没有 provider / MCP 分组的 patch 原样返回', () => {
    const patch: SettingsPatch = { general: { hotkey: 'Alt+Q' } }
    const { patch: cleaned, secrets } = extractPatchSecrets(patch)
    expect(cleaned).toBe(patch)
    expect(secrets).toEqual({})
  })
})
