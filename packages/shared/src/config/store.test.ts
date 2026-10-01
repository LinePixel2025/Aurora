import { describe, expect, it } from 'vitest'
import { SettingsStore, canonicalSecretPath, redactKeys } from './store.js'
import { CONFIG_FILE_NAME } from './store.js'
import { CONFIG_VERSION, type LlmProviderConfig } from './schema.js'
import { createDefaultSettings } from './defaults.js'
import { createMemoryLogger } from '../utils/logger.js'
import { MemoryFileSystem, createFakeCrypto, memoryPath } from '../testing/memoryFs.js'

const DIR = memoryPath()

/**
 * 造一个 v23 形态的 LLM provider 条目：生成参数在 `modelParams.<modelId>` 下，
 * provider 级不再有 `temperature` / `reasoningEffort` / `contextWindow` / `vision`
 * （前者已从 Schema 删除，后三者已下沉）；`apiKeyEnc` 留空由用例自己 setSecret。
 */
function llmProvider(model = 'deepseek-chat'): LlmProviderConfig {
  return {
    type: 'openai-compat',
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnc: '',
    model,
    modelParams: {
      [model]: { reasoningEffort: 'auto', contextWindow: 0, vision: false },
    },
  }
}

function setup(
  options: { seed?: Record<string, string>; crypto?: boolean; debounceMs?: number } = {},
) {
  const fsPort = new MemoryFileSystem(options.seed ?? {})
  const logger = createMemoryLogger()
  const crypto = createFakeCrypto(options.crypto ?? true)
  const store = new SettingsStore({
    dir: DIR,
    fs: fsPort,
    logger,
    crypto,
    writeDebounceMs: options.debounceMs ?? 0,
  })
  return { store, fsPort, logger, crypto, configPath: memoryPath(CONFIG_FILE_NAME) }
}

describe('SettingsStore · 初始化', () => {
  it('首次运行：创建默认配置，标记需要引导', async () => {
    const { store, fsPort, configPath } = setup()
    const report = await store.init()
    expect(report.created).toBe(true)
    expect(report.corrupted).toBe(false)
    expect(report.needsOnboarding).toBe(true)
    expect(report.cryptoAvailable).toBe(true)
    await store.flush()
    const onDisk = JSON.parse((await fsPort.readFile(configPath)) as string) as Record<
      string,
      unknown
    >
    expect(onDisk['version']).toBe(CONFIG_VERSION)
    expect((onDisk['modes'] as Record<string, unknown>)['current']).toBe('classroom')
  })

  it('重复 init 幂等，不覆盖已有配置', async () => {
    const { store, fsPort, configPath } = setup()
    await store.init()
    store.update({ general: { ...store.get().general, language: 'en-US' } })
    await store.flush()
    const before = await fsPort.readFile(configPath)
    await store.init()
    expect(await fsPort.readFile(configPath)).toBe(before)
    expect(store.get().general.language).toBe('en-US')
  })

  it('损坏的 JSON：备份原文件、重建默认、报告 corrupted', async () => {
    const seed = { [memoryPath(CONFIG_FILE_NAME)]: '{ 这不是 JSON' }
    const { store, fsPort, logger } = setup({ seed })
    const report = await store.init()
    expect(report.corrupted).toBe(true)
    expect(report.backupPath).toContain('config.corrupt-')
    expect(await fsPort.exists(report.backupPath as string)).toBe(true)
    expect(store.get().version).toBe(CONFIG_VERSION)
    expect(logger.entries.some((l) => l.includes('配置文件解析失败'))).toBe(true)
  })

  it('已是当前版本、但残留已下线窗口几何：只摘掉该键，用户其它配置不动', async () => {
    // 真实踩到过：windowState 是 z.record(WindowNameSchema, …)，而动态键路径在 sanitize 里
    // 不校验键 → 旧键会活到 SettingsSchema.parse 并硬抛，应用**起不来**。
    const seeded = createDefaultSettings()
    seeded.modes.classroom.watchDir = 'D:\\感知文件夹'
    const seed = {
      [memoryPath(CONFIG_FILE_NAME)]: JSON.stringify({
        ...seeded,
        version: CONFIG_VERSION,
        general: {
          ...seeded.general,
          language: 'en-US',
          windowState: {
            chat: { x: 11, y: 22, width: 433, height: 650 },
            'service-dock': { x: 694, y: 938, width: 322, height: 59 },
          },
        },
      }),
    }
    const { store, fsPort, logger, configPath } = setup({ seed })
    const report = await store.init()
    expect(report.corrupted).toBe(false)
    const state = store.get().general.windowState as Record<string, unknown>
    expect(state['service-dock']).toBeUndefined()
    expect(state['chat']).toEqual({ x: 11, y: 22, width: 433, height: 650 })
    // 用户其它配置不受影响
    expect(store.get().general.language).toBe('en-US')
    expect(store.get().modes.classroom.watchDir).toBe('D:\\感知文件夹')
    expect(logger.entries.some((l) => l.includes('清理已下线窗口的几何记录'))).toBe(true)
    // 修复必须落盘（否则每次启动都要再修一遍）
    await store.flush()
    const onDisk = JSON.parse((await fsPort.readFile(configPath)) as string) as Record<
      string,
      unknown
    >
    const diskState = (onDisk['general'] as Record<string, unknown>)['windowState'] as Record<
      string,
      unknown
    >
    expect(diskState['service-dock']).toBeUndefined()
    expect(diskState['chat']).toEqual({ x: 11, y: 22, width: 433, height: 650 })
  })

  it('字段级非法值回退默认，合法字段保留', async () => {
    const seed = {
      [memoryPath(CONFIG_FILE_NAME)]: JSON.stringify({
        version: 1,
        general: { language: 123, hotkey: 'Ctrl+Alt+A' },
        modes: { current: 'work' },
      }),
    }
    const { store } = setup({ seed })
    const report = await store.init()
    expect(store.get().general.language).toBe('zh-CN')
    expect(store.get().general.hotkey).toBe('Ctrl+Alt+A')
    expect(store.get().modes.current).toBe('work')
    expect(report.sanitizeIssues.map((i) => i.path)).toContain('general.language')
    expect(report.needsOnboarding).toBe(true)
  })

  it('active 指向不存在的 provider 时重置为未配置并告警', async () => {
    const seed = {
      [memoryPath(CONFIG_FILE_NAME)]: JSON.stringify({ version: 1, llm: { active: 'ghost' } }),
    }
    const { store } = setup({ seed })
    const report = await store.init()
    expect(store.get().llm.active).toBe('')
    expect(report.warnings.some((w) => w.includes('ghost'))).toBe(true)
  })

  it('清理遗留的 .tmp 文件', async () => {
    const { store, fsPort } = setup({ seed: { [memoryPath('config.json.123.tmp')]: 'x' } })
    await store.init()
    expect(await fsPort.exists(memoryPath('config.json.123.tmp'))).toBe(false)
  })

  it('磁盘上的 v4 配置：迁移到 v5 后思考等级与电脑操控工具配置就绪', async () => {
    const seeded = createDefaultSettings()
    const seed = {
      [memoryPath(CONFIG_FILE_NAME)]: JSON.stringify({
        ...seeded,
        version: 4,
        llm: {
          active: 'legacy',
          providers: {
            legacy: {
              type: 'openai-compat',
              baseUrl: 'https://api.deepseek.com',
              apiKeyEnc: 'cipher',
              model: 'deepseek-chat',
              // v4 时代的旧字段（v23 已从 Schema 删除）：留在夹具里正是为了证明迁移链
              // 一路把它带到 v23 并丢掉 —— 别照抄到新夹具（新形态用 `llmProvider()`）。
              temperature: 0.7,
            },
          },
        },
        agent: undefined,
      }),
    }
    const { store } = setup({ seed })
    const report = await store.init()
    expect(report.fromVersion).toBe(4)
    expect(report.corrupted).toBe(false)
    expect(store.get().version).toBe(CONFIG_VERSION)
    // v23 终态：provider 级不再有 reasoningEffort，三个生成参数落在 `modelParams[<model>]` 下
    // （v4→v23 一路迁下来，缺的值按出厂默认补齐）
    expect(store.get().llm.providers['legacy']?.modelParams['deepseek-chat']).toEqual({
      reasoningEffort: 'auto',
      contextWindow: 0,
      vision: false,
    })
    expect(store.get().agent.tools).toEqual({
      enabled: true,
      workspaceDir: '',
      terminal: {
        enabled: true,
        timeoutMs: 60_000,
        maxOutputChars: 8000,
        allowPatterns: [],
      },
      files: { enabled: true, maxReadBytes: 262_144 },
      search: { enabled: true, maxResults: 200 },
      open: { enabled: true },
    })
  })

  it('磁盘上的 v6 provider 缺 modelList：读入补成 []，其余字段一个都不变', async () => {
    const seeded = createDefaultSettings()
    seeded.general.language = 'en-US'
    seeded.modes.classroom.watchDir = 'D:\\感知文件夹'
    // 旧版本写下的 provider：没有 modelList 这个键，`modelParams` 条目也只写了思考等级
    // （版本已声明为当前版本，迁移链不会跑）
    const legacyProvider = {
      type: 'openai-compat',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKeyEnc: '',
      model: 'qwen2.5:7b',
      modelParams: { 'qwen2.5:7b': { reasoningEffort: 'high' } },
    }
    const seed = {
      [memoryPath(CONFIG_FILE_NAME)]: JSON.stringify({
        ...seeded,
        version: CONFIG_VERSION,
        llm: { active: 'legacy', providers: { legacy: legacyProvider } },
      }),
    }
    const { store } = setup({ seed })
    const report = await store.init()
    expect(report.corrupted).toBe(false)
    expect(report.fromVersion).toBe(CONFIG_VERSION)
    expect(report.appliedMigrations).toEqual([])

    // 缺字段按各自 Schema 默认值补齐：`modelList` → []（设置页与对话窗无条件拿到数组）、
    // `modelParams.<model>` 内缺的 `contextWindow` → 0（v11 起，0 = 未知）、
    // `vision` → false（v22 起，出厂关；docs/06 §3.1 / docs/08 §1）；
    // v23 起这三项都在 `modelParams` 下，provider 级已无对应键。
    expect(store.get().llm.providers['legacy']).toEqual({
      ...legacyProvider,
      modelParams: {
        'qwen2.5:7b': { reasoningEffort: 'high', contextWindow: 0, vision: false },
      },
      modelList: [],
    })
    // 其余字段一个都不变
    expect(store.get().llm.active).toBe('legacy')
    expect(store.get().general.language).toBe('en-US')
    expect(store.get().modes.classroom.watchDir).toBe('D:\\感知文件夹')
  })

  it('磁盘上的 v22 配置：三个生成参数搬进 modelParams[model]，provider 级四个键都不在（v23）', async () => {
    // 「用户填过的上下文窗口 / 图片开关 / 思考等级不会在升级时丢」的端到端证据
    const seeded = createDefaultSettings()
    const seed = {
      [memoryPath(CONFIG_FILE_NAME)]: JSON.stringify({
        ...seeded,
        version: 22,
        llm: {
          active: 'legacy',
          providers: {
            legacy: {
              type: 'openai-compat',
              baseUrl: 'https://api.openai.com/v1',
              apiKeyEnc: 'cipher',
              model: 'gpt-4o',
              temperature: 0.7,
              reasoningEffort: 'high',
              contextWindow: 128_000,
              vision: true,
            },
          },
        },
      }),
    }
    const { store } = setup({ seed })
    const report = await store.init()
    expect(report.fromVersion).toBe(22)
    expect(report.corrupted).toBe(false)
    expect(store.get().version).toBe(CONFIG_VERSION)

    const provider = store.get().llm.providers['legacy']!
    // 三个值逐字搬到该 provider 生效模型的条目下
    expect(provider.modelParams).toEqual({
      'gpt-4o': { reasoningEffort: 'high', contextWindow: 128_000, vision: true },
    })
    // provider 级四个键（含已从 Schema 删除的 temperature）一个都不在了
    for (const key of ['temperature', 'reasoningEffort', 'contextWindow', 'vision']) {
      expect(provider, key).not.toHaveProperty(key)
    }
    // 连接字段与模型不受影响；存量明文凭据照旧被 init 补加密（与本次下沉无关的既有行为）
    expect(provider.baseUrl).toBe('https://api.openai.com/v1')
    expect(provider.model).toBe('gpt-4o')
    expect(provider.apiKeyEnc).toContain('fakestorage:v1:')
  })

  it('从 v0 旧配置迁移：明文 apiKey 被迁移并补加密', async () => {
    const seed = {
      [memoryPath(CONFIG_FILE_NAME)]: JSON.stringify({
        mode: 'classroom',
        llm: { apiKey: 'sk-legacy', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
      }),
    }
    const { store, fsPort, configPath, logger } = setup({ seed })
    const report = await store.init()
    expect(report.fromVersion).toBe(0)
    expect(report.appliedMigrations).toHaveLength(CONFIG_VERSION)
    await store.flush()
    const raw = (await fsPort.readFile(configPath)) as string
    expect(raw).toContain('fakestorage:v1:')
    expect(raw).not.toContain('sk-legacy')
    expect(raw).not.toContain('"apiKey"')
    expect(store.get().modes.current).toBe('classroom')
    expect(store.getSecret('llm.providers.deepseek.apiKey')).toBe('sk-legacy')
    expect(store.needsOnboarding()).toBe(false)
    expect(logger.entries.some((l) => l.includes('补加密'))).toBe(true)
  })
})

describe('SettingsStore · 更新与监听', () => {
  it('update 浅合并顶层分组并通知监听者', async () => {
    const { store } = setup()
    await store.init()
    const seen: string[] = []
    const off = store.onChange((settings) => seen.push(settings.general.language))
    store.update({ general: { ...store.get().general, language: 'ja-JP' } })
    off()
    store.update({ general: { ...store.get().general, language: 'ko-KR' } })
    expect(seen).toEqual(['ja-JP'])
    expect(store.get().general.language).toBe('ko-KR')
    await store.flush()
  })

  it('非法配置更新被拒绝，返回 undefined 且状态不变', async () => {
    const { store } = setup()
    await store.init()
    const before = store.get()
    const result = store.update({
      modes: { ...before.modes, current: 'gaming' as never },
    })
    expect(result).toBeUndefined()
    expect(store.get().modes.current).toBe('classroom')
  })

  it('mutate 在副本上修改并落盘', async () => {
    const { store, fsPort, configPath } = setup()
    await store.init()
    store.mutate((draft) => {
      draft.modes.work.guideCompleted = true
    })
    await store.flush()
    expect(await fsPort.readFile(configPath)).toContain('"guideCompleted": true')
    expect(store.get().modes.work.guideCompleted).toBe(true)
  })

  it('防抖写盘：多次更新只落盘最终结果', async () => {
    const { store, fsPort } = setup({ debounceMs: 50 })
    await store.init()
    const writesBefore = fsPort.writeLog.length
    store.update({ general: { ...store.get().general, language: 'en-US' } })
    store.update({ general: { ...store.get().general, language: 'ja-JP' } })
    store.update({ general: { ...store.get().general, language: 'ko-KR' } })
    expect(fsPort.writeLog.length).toBe(writesBefore) // 防抖期间尚未落盘
    await store.flush()
    const raw = (await fsPort.readFile(memoryPath(CONFIG_FILE_NAME))) as string
    expect(raw).toContain('"language": "ko-KR"')
    expect(raw).not.toContain('"language": "en-US"')
    expect(raw).not.toContain('"language": "ja-JP"')
  })

  it('写盘失败通过 onWriteError 上报，不抛给调用方', async () => {
    const errors: string[] = []
    const fsPort = new MemoryFileSystem()
    const store = new SettingsStore({
      dir: DIR,
      fs: fsPort,
      crypto: createFakeCrypto(),
      writeDebounceMs: 0,
      onWriteError: (error) => errors.push(error.message),
    })
    await store.init()
    fsPort.failNextWrite = true
    store.update({ general: { ...store.get().general, language: 'fr-FR' } })
    await store.flush()
    expect(errors.some((m) => m.includes('模拟写盘失败'))).toBe(true)
  })
})

describe('SettingsStore · 凭据安全', () => {
  it('setSecret 加密落盘，磁盘无明文，getSecret 可还原', async () => {
    const { store, fsPort, configPath, crypto } = setup()
    await store.init()
    store.mutate((draft) => {
      draft.llm.providers['deepseek'] = llmProvider()
      draft.llm.active = 'deepseek'
    })
    const persisted = store.setSecret('llm.providers.deepseek.apiKey', 'sk-secret-value')
    await store.flush()
    expect(persisted).toBe(true)
    // 任何一次落盘都不允许出现明文
    const leaked = fsPort.contentLog.filter((content) => content.includes('sk-secret-value'))
    expect(leaked).toEqual([])
    const raw = (await fsPort.readFile(configPath)) as string
    expect(raw).not.toContain('sk-secret-value')
    expect(raw).toContain('fakestorage:v1:')
    expect(store.getSecret('llm.providers.deepseek.apiKey')).toBe('sk-secret-value')
    expect(crypto.encryptCalls).toContain('sk-secret-value')
  })

  it('轮换 API Key 后旧密文不再残留', async () => {
    const { store, fsPort } = setup()
    await store.init()
    store.mutate((draft) => {
      draft.llm.providers['deepseek'] = llmProvider()
      draft.llm.active = 'deepseek'
    })
    store.setSecret('llm.providers.deepseek.apiKey', 'sk-first')
    await store.flush()
    const first = store.get().llm.providers['deepseek']?.apiKeyEnc
    store.setSecret('llm.providers.deepseek.apiKey', 'sk-second')
    await store.flush()
    const second = store.get().llm.providers['deepseek']?.apiKeyEnc
    expect(second).not.toBe(first)
    expect(store.getSecret('llm.providers.deepseek.apiKey')).toBe('sk-second')
    const raw = (await fsPort.readFile(memoryPath(CONFIG_FILE_NAME))) as string
    expect(raw).not.toContain('sk-first')
  })

  it('重启后仍能通过解密读回凭据', async () => {
    const { store, fsPort } = setup()
    await store.init()
    store.mutate((draft) => {
      draft.llm.providers['deepseek'] = llmProvider()
      draft.llm.active = 'deepseek'
    })
    store.setSecret('llm.providers.deepseek.apiKey', 'sk-persist')
    await store.flush()

    const reopened = new SettingsStore({
      dir: DIR,
      fs: fsPort,
      crypto: createFakeCrypto(),
      writeDebounceMs: 0,
    })
    await reopened.init()
    expect(reopened.needsOnboarding()).toBe(false)
    expect(reopened.getSecret('llm.providers.deepseek.apiKey')).toBe('sk-persist')
  })

  it('safeStorage 不可用：凭据只驻留内存，磁盘不出现明文', async () => {
    const { store, fsPort, configPath } = setup({ crypto: false })
    const report = await store.init()
    expect(report.cryptoAvailable).toBe(false)
    store.mutate((draft) => {
      draft.llm.providers['deepseek'] = llmProvider()
      draft.llm.active = 'deepseek'
    })
    const persisted = store.setSecret('llm.providers.deepseek.apiKey', 'sk-memory-only')
    await store.flush()
    expect(persisted).toBe(false)
    expect(store.getSecret('llm.providers.deepseek.apiKey')).toBe('sk-memory-only')
    const raw = (await fsPort.readFile(configPath)) as string
    expect(raw).not.toContain('sk-memory-only')
    expect(JSON.parse(raw).llm.providers.deepseek.apiKeyEnc).toBe('')
  })

  it('加密不可用时重写配置会清空磁盘上的密文字段', async () => {
    const { store, fsPort, configPath } = setup()
    await store.init()
    store.mutate((draft) => {
      draft.llm.providers['deepseek'] = llmProvider()
    })
    store.setSecret('llm.providers.deepseek.apiKey', 'sk-old')
    await store.flush()

    const degraded = new SettingsStore({
      dir: DIR,
      fs: fsPort,
      crypto: createFakeCrypto(false),
      writeDebounceMs: 0,
    })
    await degraded.init()
    degraded.update({ general: { ...degraded.get().general, language: 'en-US' } })
    await degraded.flush()
    const raw = (await fsPort.readFile(configPath)) as string
    expect(raw).not.toContain('fakestorage:v1:')
    expect(JSON.parse(raw).llm.providers.deepseek.apiKeyEnc).toBe('')
  })

  it('clearSecret 清空密文', async () => {
    const { store } = setup()
    await store.init()
    store.mutate((draft) => {
      draft.llm.providers['deepseek'] = llmProvider()
    })
    store.setSecret('llm.providers.deepseek.apiKey', 'sk-x')
    store.clearSecret('llm.providers.deepseek.apiKey')
    await store.flush()
    expect(store.getSecret('llm.providers.deepseek.apiKey')).toBe('')
    expect(store.get().llm.providers['deepseek']?.apiKeyEnc).toBe('')
  })

  it('无法识别的凭据路径抛出 SettingsSecretError', async () => {
    const { store } = setup()
    await store.init()
    expect(() => store.setSecret('general.language', 'x')).toThrowError(/无法识别/)
  })

  it('路径可识别但条目不存在时同样抛错，不静默成功', async () => {
    const { store } = setup()
    await store.init()
    expect(() => store.setSecret('llm.providers.ghost.apiKey', 'sk-x')).toThrowError(/无法识别/)
    expect(() => store.setSecret('mcp.servers.ghost.env.TOKEN', 'tok-x')).toThrowError(/无法识别/)
  })

  it('写入失败时不在内存里留下明文（llm / tts / mcp 三条路径）', async () => {
    const { store } = setup()
    await store.init()

    // 抛错的同时必须不留明文：否则 getSecret / hasSecret 会对着一个磁盘上没有密文的路径
    // 报「已有凭据」，且该路径之后真的建出同名条目时会凭空继承这份明文（磁盘仍是空的）。
    expect(() => store.setSecret('llm.providers.ghost.apiKey', 'sk-ghost-llm')).toThrowError()
    expect(store.getSecret('llm.providers.ghost.apiKey')).toBe('')

    expect(() => store.setSecret('tts.providers.ghost.apiKey', 'sk-ghost-tts')).toThrowError()
    expect(store.getSecret('tts.providers.ghost.apiKey')).toBe('')

    expect(() => store.setSecret('mcp.servers.ghost.env.TOKEN', 'tok-ghost-mcp')).toThrowError()
    expect(store.getSecret('mcp.servers.ghost.env.TOKEN')).toBe('')

    // 之后真的建出同名条目时，不继承任何幽灵明文
    seedTtsProvider(store, 'ghost')
    expect(store.getSecret('tts.providers.ghost.apiKey')).toBe('')
  })

  it('canonicalSecretPath 归一化各种写法', () => {
    expect(canonicalSecretPath('llm.providers.deepseek.apiKey')).toBe(
      'llm.providers.deepseek.apiKey',
    )
    expect(canonicalSecretPath('llm.providers.deepseek.apiKeyEnc')).toBe(
      'llm.providers.deepseek.apiKey',
    )
    expect(canonicalSecretPath('tts.providers.sf.apiKey')).toBe('tts.providers.sf.apiKey')
    expect(canonicalSecretPath('tts.providers.sf.apiKeyEnc')).toBe('tts.providers.sf.apiKey')
    expect(canonicalSecretPath('mcp.servers.foo.env.TOKEN')).toBe('mcp.servers.foo.env.TOKEN')
    expect(canonicalSecretPath('mcp.servers.foo.envEnc.TOKEN')).toBe('mcp.servers.foo.env.TOKEN')
    expect(canonicalSecretPath(' llm.providers.a.apiKey ')).toBe('llm.providers.a.apiKey')
  })

  it('exportRedacted 抹掉所有凭据字段', async () => {
    const { store } = setup()
    await store.init()
    store.mutate((draft) => {
      draft.llm.providers['deepseek'] = llmProvider()
      draft.mcp.servers.push({
        name: 'demo',
        transport: 'stdio',
        command: 'npx',
        args: [],
        envEnc: { TOKEN: '' },
        headersEnc: {},
        enabled: true,
      })
    })
    store.setSecret('llm.providers.deepseek.apiKey', 'sk-a')
    store.setSecret('mcp.servers.demo.env.TOKEN', 'tok-b')
    const redacted = store.exportRedacted()
    expect(redacted.llm.providers['deepseek']?.apiKeyEnc).toBe('***')
    expect(redacted.mcp.servers[0]?.envEnc['TOKEN']).toBe('***')
  })
})

describe('SettingsStore · MCP headers 凭据（v9）', () => {
  /** 建一个 MCP 服务器条目（凭据占位为空串，由用例自己 setSecret）。 */
  function seedMcpServer(store: SettingsStore, name: string): void {
    store.mutate((draft) => {
      draft.mcp.servers.push({
        name,
        transport: 'http',
        url: 'https://example.com/mcp',
        envEnc: {},
        headersEnc: { Authorization: '' },
        enabled: true,
      })
    })
  }

  it('headers 凭据 roundtrip：setSecret 加密落盘，磁盘无明文，getSecret 可还原', async () => {
    const { store, fsPort, configPath, crypto } = setup()
    await store.init()
    seedMcpServer(store, 'demo')

    const persisted = store.setSecret('mcp.servers.demo.headers.Authorization', 'Bearer sk-x')
    await store.flush()

    expect(persisted).toBe(true)
    expect(store.getSecret('mcp.servers.demo.headers.Authorization')).toBe('Bearer sk-x')
    const raw = (await fsPort.readFile(configPath)) as string
    expect(raw).not.toContain('Bearer sk-x')
    expect(raw).toContain('fakestorage:v1:')
    expect(crypto.encryptCalls).toContain('Bearer sk-x')
  })

  it('canonicalSecretPath 归一化 headers 与 headersEnc 两种写法', () => {
    expect(canonicalSecretPath('mcp.servers.foo.headers.AUTH')).toBe('mcp.servers.foo.headers.AUTH')
    expect(canonicalSecretPath('mcp.servers.foo.headersEnc.AUTH')).toBe(
      'mcp.servers.foo.headers.AUTH',
    )
  })

  it('clearSecret 清空该键的密文与占位', async () => {
    const { store } = setup()
    await store.init()
    seedMcpServer(store, 'demo')
    store.setSecret('mcp.servers.demo.headers.Authorization', 'Bearer sk-x')
    store.clearSecret('mcp.servers.demo.headers.Authorization')
    await store.flush()
    expect(store.getSecret('mcp.servers.demo.headers.Authorization')).toBe('')
    expect(store.get().mcp.servers[0]?.headersEnc['Authorization']).toBeUndefined()
  })

  it('服务器条目不存在时 setSecret 抛 SettingsSecretError', async () => {
    const { store } = setup()
    await store.init()
    expect(() =>
      store.setSecret('mcp.servers.ghost.headers.Authorization', 'Bearer x'),
    ).toThrowError(/无法识别/)
    expect(store.getSecret('mcp.servers.ghost.headers.Authorization')).toBe('')
  })

  it('exportRedacted 抹掉 headers 密文', async () => {
    const { store } = setup()
    await store.init()
    seedMcpServer(store, 'demo')
    store.setSecret('mcp.servers.demo.headers.Authorization', 'Bearer sk-x')
    const redacted = store.exportRedacted()
    expect(redacted.mcp.servers[0]?.headersEnc['Authorization']).toBe('***')
  })
})

/** 建一个 TTS provider 条目（凭据留空，由用例自己 setSecret）。 */
function seedTtsProvider(store: SettingsStore, id: string): void {
  store.mutate((draft) => {
    draft.tts.providers[id] = {
      type: 'openai-compat',
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKeyEnc: '',
      model: 'FunAudioLLM/CosyVoice2-0.5B',
      voice: 'alex',
      speed: 1,
      format: 'mp3',
    }
  })
}

describe('SettingsStore · TTS 凭据', () => {
  it('setSecret 加密落盘，磁盘无明文，getSecret 可还原', async () => {
    const { store, fsPort, configPath, crypto } = setup()
    await store.init()
    seedTtsProvider(store, 'sf')

    const persisted = store.setSecret('tts.providers.sf.apiKey', 'sk-plain')
    await store.flush()

    expect(persisted).toBe(true)
    expect(store.getSecret('tts.providers.sf.apiKey')).toBe('sk-plain')
    const raw = (await fsPort.readFile(configPath)) as string
    expect(raw).not.toContain('sk-plain')
    const parsed = JSON.parse(raw) as {
      tts: { providers: Record<string, { apiKeyEnc: string }> }
    }
    const enc = parsed.tts.providers['sf']?.apiKeyEnc
    expect(enc).not.toBe('')
    expect(enc).not.toBe('sk-plain')
    expect(crypto.encryptCalls).toContain('sk-plain')
  })

  it('clearSecret 后 getSecret 返回空串且落盘 apiKeyEnc 为空', async () => {
    const { store, fsPort, configPath } = setup()
    await store.init()
    seedTtsProvider(store, 'sf')
    store.setSecret('tts.providers.sf.apiKey', 'sk-plain')
    store.clearSecret('tts.providers.sf.apiKey')
    await store.flush()

    expect(store.getSecret('tts.providers.sf.apiKey')).toBe('')
    const raw = (await fsPort.readFile(configPath)) as string
    expect(JSON.parse(raw).tts.providers.sf.apiKeyEnc).toBe('')
  })

  it('exportRedacted 抹掉 TTS 密文', async () => {
    const { store } = setup()
    await store.init()
    seedTtsProvider(store, 'sf')
    store.setSecret('tts.providers.sf.apiKey', 'sk-plain')
    expect(store.exportRedacted().tts.providers['sf']?.apiKeyEnc).toBe('***')
  })

  it('加密不可用时 TTS 密文不落盘，重写配置会清空磁盘上的旧密文', async () => {
    const degraded = setup({ crypto: false })
    await degraded.store.init()
    seedTtsProvider(degraded.store, 'sf')
    const persisted = degraded.store.setSecret('tts.providers.sf.apiKey', 'sk-memory-only')
    await degraded.store.flush()

    expect(persisted).toBe(false)
    expect(degraded.store.getSecret('tts.providers.sf.apiKey')).toBe('sk-memory-only')
    const raw = (await degraded.fsPort.readFile(degraded.configPath)) as string
    expect(raw).not.toContain('sk-memory-only')
    expect(JSON.parse(raw).tts.providers.sf.apiKeyEnc).toBe('')

    // 已有密文的配置在加密不可用的实例里重写 → 密文被清空
    const healthy = setup()
    await healthy.store.init()
    seedTtsProvider(healthy.store, 'sf')
    healthy.store.setSecret('tts.providers.sf.apiKey', 'sk-old')
    await healthy.store.flush()
    expect(
      JSON.parse(await healthy.fsPort.readFile(healthy.configPath)).tts.providers.sf.apiKeyEnc,
    ).not.toBe('')

    const fallback = new SettingsStore({
      dir: DIR,
      fs: healthy.fsPort,
      crypto: createFakeCrypto(false),
      writeDebounceMs: 0,
    })
    await fallback.init()
    fallback.update({ general: { ...fallback.get().general, language: 'en-US' } })
    await fallback.flush()
    const raw2 = (await healthy.fsPort.readFile(healthy.configPath)) as string
    expect(raw2).not.toContain('fakestorage:v1:')
    expect(JSON.parse(raw2).tts.providers.sf.apiKeyEnc).toBe('')
  })

  it('手改配置里的存量 TTS 明文会被补加密', async () => {
    const { store, fsPort, configPath } = setup()
    await store.init()
    seedTtsProvider(store, 'sf')
    await store.flush()
    // 模拟用户手改配置文件写入明文
    const seeded = JSON.parse(await fsPort.readFile(configPath)) as Record<string, unknown> & {
      tts: { providers: Record<string, { apiKeyEnc: string }> }
    }
    seeded.tts.providers['sf']!.apiKeyEnc = 'sk-handwritten'
    await fsPort.writeFileAtomic(configPath, JSON.stringify(seeded, null, 2))

    const reopened = new SettingsStore({
      dir: DIR,
      fs: fsPort,
      crypto: createFakeCrypto(true),
      writeDebounceMs: 0,
    })
    await reopened.init()
    expect(reopened.getSecret('tts.providers.sf.apiKey')).toBe('sk-handwritten')
    await reopened.flush()
    const raw = (await fsPort.readFile(configPath)) as string
    expect(raw).not.toContain('sk-handwritten')
    expect(raw).toContain('fakestorage:v1:')
  })

  it('TTS provider 条目不存在时 setSecret 抛 SettingsSecretError', async () => {
    const { store } = setup()
    await store.init()
    expect(() => store.setSecret('tts.providers.ghost.apiKey', 'sk-x')).toThrowError(/无法识别/)
  })
})

describe('redactKeys', () => {
  it('递归脱敏敏感字段名，不动正常业务字段', () => {
    const redacted = redactKeys({
      apiKey: 'sk-1',
      keywords: ['函数', '导数'],
      nested: { Authorization: 'Bearer x', accessToken: 'y', normal: 'keep' },
      list: [{ secret: 'z' }],
    })
    expect(redacted).toEqual({
      apiKey: '***',
      keywords: ['函数', '导数'],
      nested: { Authorization: '***', accessToken: '***', normal: 'keep' },
      list: [{ secret: '***' }],
    })
  })

  it('apiKeyEnc / apiKeySet 这类派生字段也必须脱敏', () => {
    const redacted = redactKeys({
      tts: { providers: { sf: { apiKeyEnc: 'cipher', apiKeySet: true, voice: 'alex' } } },
    })
    expect(redacted).toEqual({
      tts: { providers: { sf: { apiKeyEnc: '***', apiKeySet: '***', voice: 'alex' } } },
    })
  })

  it('不含 api key 语义的字段名不受影响', () => {
    const redacted = redactKeys({
      monolingual: true,
      keywordCount: 3,
      keywords: ['函数'],
      hotkeys: ['Alt+Space'],
    })
    expect(redacted).toEqual({
      monolingual: true,
      keywordCount: 3,
      keywords: ['函数'],
      hotkeys: ['Alt+Space'],
    })
  })
})

describe('SettingsStore · Center 配对令牌（center.token 凭据路径）', () => {
  it('setSecret 加密落盘，getSecret 可还原；tokenEnc 的派生名也走同一条规范化', async () => {
    const { store, fsPort, configPath, crypto } = setup()
    await store.init()
    expect(store.setSecret('center.token', 'pair-token-plain')).toBe(true)
    // 派生名（tokenEnc）与明文名是同一条规范路径，读写等价
    expect(store.setSecret('center.tokenEnc', 'pair-token-plain')).toBe(true)
    await store.flush()
    const leaked = fsPort.contentLog.filter((content) => content.includes('pair-token-plain'))
    expect(leaked).toEqual([])
    const raw = (await fsPort.readFile(configPath)) as string
    expect(raw).not.toContain('pair-token-plain')
    expect(store.getSecret('center.token')).toBe('pair-token-plain')
    expect(store.getSecret('center.tokenEnc')).toBe('pair-token-plain')
    expect(crypto.encryptCalls).toContain('pair-token-plain')
  })

  it('清空令牌后落盘无残留；get 返回空串', async () => {
    const { store, fsPort } = setup()
    await store.init()
    store.setSecret('center.token', 'pair-token-plain')
    await store.flush()
    expect(store.setSecret('center.token', '')).toBe(true)
    await store.flush()
    expect(store.getSecret('center.token')).toBe('')
    const raw = fsPort.contentLog.join('\n')
    expect(raw).not.toContain('pair-token-plain')
  })
})

describe('SettingsStore · 含点名称的凭据路径（P1-07）', () => {
  /** 建一个含点 id 的 provider（`llm.providers` 是 record，键不受 Schema 约束）。 */
  function seedDottedProvider(store: SettingsStore, id: string): void {
    store.mutate((draft) => {
      draft.llm.providers[id] = llmProvider()
      draft.llm.active = id
    })
  }

  it('canonicalSecretPath 能归一化含点的 provider id 与 MCP 服务器名', () => {
    // provider：后缀 `.apiKey` 固定 → id 段贪婪，含点 id 原样保留
    expect(canonicalSecretPath('llm.providers.api.deepseek.apiKey')).toBe(
      'llm.providers.api.deepseek.apiKey',
    )
    expect(canonicalSecretPath('llm.providers.api.deepseek.apiKeyEnc')).toBe(
      'llm.providers.api.deepseek.apiKey',
    )
    // MCP：`mcp.servers.my.server.env.KEY` 要拆成服务器 `my.server` 的 env 键 `KEY`
    // （`envEnc` 写法归一化回 `env`，等价于识别出了两侧段）
    expect(canonicalSecretPath('mcp.servers.my.server.env.KEY')).toBe(
      'mcp.servers.my.server.env.KEY',
    )
    expect(canonicalSecretPath('mcp.servers.my.server.envEnc.KEY')).toBe(
      'mcp.servers.my.server.env.KEY',
    )
    expect(canonicalSecretPath('mcp.servers.my.server.headers.X.Api-Key')).toBe(
      'mcp.servers.my.server.headers.X.Api-Key',
    )
    expect(canonicalSecretPath('mcp.servers.my.server.headersEnc.X.Api-Key')).toBe(
      'mcp.servers.my.server.headers.X.Api-Key',
    )
    // 含点的键（env 键 / header 名不受 Schema 约束）也不能回归：名称段无点时按标记拆开
    expect(canonicalSecretPath('mcp.servers.foo.env.A.B')).toBe('mcp.servers.foo.env.A.B')
    expect(canonicalSecretPath('mcp.servers.foo.headers.X.Api-Key')).toBe(
      'mcp.servers.foo.headers.X.Api-Key',
    )
  })

  it('含点 provider id 的凭据可存取（writeSecretField → readSecretField 全链）', async () => {
    const { store, fsPort, configPath } = setup()
    await store.init()
    seedDottedProvider(store, 'api.deepseek')

    // 不抛「无法识别的凭据路径」；写成密文
    expect(store.setSecret('llm.providers.api.deepseek.apiKey', 'sk-dotted')).toBe(true)
    await store.flush()

    // 路径别名（apiKeyEnc）与明文名指向同一条规范路径
    expect(store.getSecret('llm.providers.api.deepseek.apiKey')).toBe('sk-dotted')
    expect(store.getSecret('llm.providers.api.deepseek.apiKeyEnc')).toBe('sk-dotted')
    expect(store.get().llm.providers['api.deepseek']?.apiKeyEnc).toContain('fakestorage:v1:')
    // 主进程的 `settings:hasSecret` 就是 `getSecret(path) !== ''`
    expect(store.getSecret('llm.providers.api.deepseek.apiKey') !== '').toBe(true)
    // 磁盘只有密文
    const raw = (await fsPort.readFile(configPath)) as string
    expect(raw).not.toContain('sk-dotted')
    expect(raw).toContain('fakestorage:v1:')
    // 内存缓存键也是规范路径（clearSecret 能一并清掉）
    store.clearSecret('llm.providers.api.deepseek.apiKey')
    await store.flush()
    expect(store.getSecret('llm.providers.api.deepseek.apiKey')).toBe('')
  })

  it('存量含点 MCP 服务器名：init 时规整为合法名，不把整份配置判为损坏', async () => {
    // `McpServerSchema.name` 现在禁 `.`，而 `mcp.servers` 是数组（sanitize 不逐项回退）：
    // 不先规整就会在 SettingsSchema.parse 硬抛 → 备份 + 重建出厂配置。
    const seeded = createDefaultSettings()
    seeded.llm.providers['deepseek'] = llmProvider()
    // 手写密文 = 假加密格式（`fakestorage:v1:` + base64），解密回 'tok-value'
    const tokCipher = 'fakestorage:v1:' + Buffer.from('tok-value', 'utf8').toString('base64')
    const seed = {
      [memoryPath(CONFIG_FILE_NAME)]: JSON.stringify({
        ...seeded,
        version: CONFIG_VERSION,
        mcp: {
          lazyConnect: false,
          servers: [
            {
              name: 'my.server',
              transport: 'http',
              url: 'https://example.com/mcp',
              envEnc: { TOKEN: tokCipher },
              headersEnc: {},
              enabled: true,
            },
          ],
        },
      }),
    }
    const { store, logger } = setup({ seed })
    const report = await store.init()

    expect(report.corrupted).toBe(false)
    expect(report.warnings.some((w) => w.includes('my.server'))).toBe(true)
    const server = store.get().mcp.servers[0]
    expect(server?.name).toBe('my-server')
    // 凭据密文随条目一起搬走 → 改名后仍读得到
    expect(server?.envEnc['TOKEN']).toContain('fakestorage:v1:')
    expect(store.getSecret('mcp.servers.my-server.env.TOKEN')).toBe('tok-value')
    expect(logger.entries.some((l) => l.includes('规整存量 MCP 服务器名称'))).toBe(true)
  })

  it('规整时不与既有合法名冲突（追加 -2）', async () => {
    const seeded = createDefaultSettings()
    const seedServer = (name: string) => ({
      name,
      transport: 'stdio' as const,
      command: 'npx',
      args: [],
      envEnc: {},
      headersEnc: {},
      enabled: true,
    })
    const seed = {
      [memoryPath(CONFIG_FILE_NAME)]: JSON.stringify({
        ...seeded,
        version: CONFIG_VERSION,
        mcp: { lazyConnect: false, servers: [seedServer('my-server'), seedServer('my.server')] },
      }),
    }
    const { store } = setup({ seed })
    const report = await store.init()
    expect(report.corrupted).toBe(false)
    const names = store.get().mcp.servers.map((s) => s.name)
    expect(names).toEqual(['my-server', 'my-server-2'])
  })
})

describe('SettingsStore · 键名含标记词的凭据路径（择优修复，2026-10-01）', () => {
  /**
   * P1-07 把名称段改成贪婪之后，`srv.headers.env.X` 这类「名称不含点、键含标记词」的路径会被
   * **最右标记**拆成服务器 `srv.headers` + 键 `X` —— 而基线（名称段 `[^.]+`）对它是正确的，
   * 属回归。修法是「候选拆法 + 按真实存在的服务器名择优」，本组用例钉住它。
   */
  function seedServer(store: SettingsStore, name: string): void {
    store.mutate((draft) => {
      draft.mcp.servers.push({
        name,
        transport: 'stdio',
        command: 'npx',
        args: [],
        envEnc: {},
        headersEnc: {},
        enabled: true,
      })
    })
  }

  it('名称不含点、键含标记词：择优命中真实服务器，不取最右标记', async () => {
    const { store } = setup()
    await store.init()
    seedServer(store, 'srv')

    // header 名 = `env.X`：最右标记是 `.env.`，旧实现会解析成服务器 `srv.headers`
    expect(store.setSecret('mcp.servers.srv.headers.env.X', 'v-headers')).toBe(true)
    expect(store.getSecret('mcp.servers.srv.headers.env.X')).toBe('v-headers')
    const afterHeaders = store.get().mcp.servers[0]
    expect(afterHeaders?.headersEnc['env.X']).toContain('fakestorage:v1:')
    expect(afterHeaders?.envEnc).toEqual({})

    // env 键 = `headers.X`：最右标记是 `.headers.`，旧实现会解析成服务器 `srv.env`
    expect(store.setSecret('mcp.servers.srv.env.headers.X', 'v-env')).toBe(true)
    expect(store.getSecret('mcp.servers.srv.env.headers.X')).toBe('v-env')
    const afterEnv = store.get().mcp.servers[0]
    expect(afterEnv?.envEnc['headers.X']).toContain('fakestorage:v1:')
    expect(afterEnv?.headersEnc['env.X']).toContain('fakestorage:v1:')
  })

  it('正常形状逐字不变（择优不改无歧义输入的解析）', async () => {
    const { store } = setup()
    await store.init()
    seedServer(store, 'srv')

    expect(store.setSecret('mcp.servers.srv.env.KEY', 'e1')).toBe(true)
    expect(store.setSecret('mcp.servers.srv.headers.Authorization', 'h1')).toBe(true)
    expect(store.getSecret('mcp.servers.srv.env.KEY')).toBe('e1')
    expect(store.getSecret('mcp.servers.srv.headers.Authorization')).toBe('h1')
    const server = store.get().mcp.servers[0]
    expect(server?.envEnc['KEY']).toContain('fakestorage:v1:')
    expect(server?.headersEnc['Authorization']).toContain('fakestorage:v1:')
  })

  it('别名写法（headersEnc / envEnc）与规范写法指向同一条路径', async () => {
    // 择优是**解析层**的改动，规范化后两侧必须仍是同一条路径，否则 set/get 会对不上。
    expect(canonicalSecretPath('mcp.servers.srv.headers.env.X')).toBe(
      'mcp.servers.srv.headers.env.X',
    )
    expect(canonicalSecretPath('mcp.servers.srv.headersEnc.env.X')).toBe(
      'mcp.servers.srv.headers.env.X',
    )
    expect(canonicalSecretPath('mcp.servers.srv.env.headers.X')).toBe(
      'mcp.servers.srv.env.headers.X',
    )
    expect(canonicalSecretPath('mcp.servers.srv.envEnc.headers.X')).toBe(
      'mcp.servers.srv.env.headers.X',
    )

    const { store } = setup()
    await store.init()
    seedServer(store, 'srv')
    expect(store.setSecret('mcp.servers.srv.headers.env.X', 'alias')).toBe(true)
    expect(store.getSecret('mcp.servers.srv.headersEnc.env.X')).toBe('alias')
    expect(store.getSecret('mcp.servers.srv.headers.env.X')).toBe('alias')
  })

  it('服务器不存在时回落到「最右标记」：不误写、只拒绝', async () => {
    const { store } = setup()
    await store.init()
    seedServer(store, 'srv')

    // 择优全部落空 → 回落最右：服务器 `ghost.headers`、键 `X` → 该服务器不存在
    expect(() => store.setSecret('mcp.servers.ghost.headers.env.X', 'nope')).toThrow(
      /无法识别的凭据路径/,
    )
    expect(store.getSecret('mcp.servers.ghost.headers.env.X')).toBe('')
    // 既有服务器一字未动（既没被误写、也没被误读）
    const server = store.get().mcp.servers[0]
    expect(server?.envEnc).toEqual({})
    expect(server?.headersEnc).toEqual({})
  })
})
