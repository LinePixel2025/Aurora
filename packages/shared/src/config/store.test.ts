import { describe, expect, it } from 'vitest'
import { SettingsStore, canonicalSecretPath, redactKeys } from './store.js'
import { CONFIG_FILE_NAME } from './store.js'
import { CONFIG_VERSION } from './schema.js'
import { createDefaultSettings } from './defaults.js'
import { createMemoryLogger } from '../utils/logger.js'
import { MemoryFileSystem, createFakeCrypto, memoryPath } from '../testing/memoryFs.js'

const DIR = memoryPath()

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
    expect(store.get().llm.providers['legacy']?.reasoningEffort).toBe('auto')
    expect(store.get().agent.tools).toEqual({
      enabled: true,
      workspaceDir: '',
      terminal: { enabled: true, timeoutMs: 60_000, maxOutputChars: 8000 },
      files: { enabled: true, maxReadBytes: 262_144 },
      open: { enabled: true },
    })
  })

  it('磁盘上的 v6 provider 缺 modelList：读入补成 []，其余字段一个都不变', async () => {
    const seeded = createDefaultSettings()
    seeded.general.language = 'en-US'
    seeded.modes.classroom.watchDir = 'D:\\感知文件夹'
    // 旧版本写下的 provider：没有 modelList 这个键（版本已声明为 v6，迁移链不会跑）
    const legacyProvider = {
      type: 'openai-compat',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKeyEnc: '',
      model: 'qwen2.5:7b',
      temperature: 1.4,
      reasoningEffort: 'high',
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

    // 缺字段由 `z.array(z.string()).default([])` 补齐：设置页与对话窗无条件拿到数组
    expect(store.get().llm.providers['legacy']).toEqual({ ...legacyProvider, modelList: [] })
    // 其余字段一个都不变
    expect(store.get().llm.active).toBe('legacy')
    expect(store.get().general.language).toBe('en-US')
    expect(store.get().modes.classroom.watchDir).toBe('D:\\感知文件夹')
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
      draft.llm.providers['deepseek'] = {
        type: 'openai-compat',
        baseUrl: 'https://api.deepseek.com',
        apiKeyEnc: '',
        model: 'deepseek-chat',
        temperature: 0.7,
        reasoningEffort: 'auto',
      }
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
      draft.llm.providers['deepseek'] = {
        type: 'openai-compat',
        baseUrl: 'https://api.deepseek.com',
        apiKeyEnc: '',
        model: 'deepseek-chat',
        temperature: 0.7,
        reasoningEffort: 'auto',
      }
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
      draft.llm.providers['deepseek'] = {
        type: 'openai-compat',
        baseUrl: 'https://api.deepseek.com',
        apiKeyEnc: '',
        model: 'deepseek-chat',
        temperature: 0.7,
        reasoningEffort: 'auto',
      }
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
      draft.llm.providers['deepseek'] = {
        type: 'openai-compat',
        baseUrl: 'https://api.deepseek.com',
        apiKeyEnc: '',
        model: 'deepseek-chat',
        temperature: 0.7,
        reasoningEffort: 'auto',
      }
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
      draft.llm.providers['deepseek'] = {
        type: 'openai-compat',
        baseUrl: 'https://api.deepseek.com',
        apiKeyEnc: '',
        model: 'deepseek-chat',
        temperature: 0.7,
        reasoningEffort: 'auto',
      }
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
      draft.llm.providers['deepseek'] = {
        type: 'openai-compat',
        baseUrl: 'https://api.deepseek.com',
        apiKeyEnc: '',
        model: 'deepseek-chat',
        temperature: 0.7,
        reasoningEffort: 'auto',
      }
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

  it('canonicalSecretPath 归一化各种写法', () => {
    expect(canonicalSecretPath('llm.providers.deepseek.apiKey')).toBe(
      'llm.providers.deepseek.apiKey',
    )
    expect(canonicalSecretPath('llm.providers.deepseek.apiKeyEnc')).toBe(
      'llm.providers.deepseek.apiKey',
    )
    expect(canonicalSecretPath('mcp.servers.foo.env.TOKEN')).toBe('mcp.servers.foo.env.TOKEN')
    expect(canonicalSecretPath('mcp.servers.foo.envEnc.TOKEN')).toBe('mcp.servers.foo.env.TOKEN')
    expect(canonicalSecretPath(' llm.providers.a.apiKey ')).toBe('llm.providers.a.apiKey')
  })

  it('exportRedacted 抹掉所有凭据字段', async () => {
    const { store } = setup()
    await store.init()
    store.mutate((draft) => {
      draft.llm.providers['deepseek'] = {
        type: 'openai-compat',
        baseUrl: 'https://api.deepseek.com',
        apiKeyEnc: '',
        model: 'deepseek-chat',
        temperature: 0.7,
        reasoningEffort: 'auto',
      }
      draft.mcp.servers.push({
        name: 'demo',
        transport: 'stdio',
        command: 'npx',
        args: [],
        envEnc: { TOKEN: '' },
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
})
