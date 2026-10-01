/**
 * `createSettingsPort`（`set_setting` 的主进程端口，docs/06 §12）。
 *
 * 本文件不 import electron（`redactSettings` 已拆到 electron-free 的 `settings-redact.ts`
 * —— 此前 settings-port 值导入 `../ipc.js` 会让本文件传递性加载 electron、vitest 收不了）。
 *
 * 钉的行为：**写后校验失败 → 回滚（`mutate`）后必须补一次 `notifyChanged`**。
 * `mutate` 不触发 `onSettingsChanged`，不补广播的话工具闭包会停在坏值实例上
 * 直到下一次任意配置变更（2026-09 审查 P3）。
 */
import { describe, expect, it } from 'vitest'
import { createDefaultSettings, type Settings, type SettingsPatch } from '@aurora/shared'
import { createSettingsPort } from './settings-port.js'
import type { Logger, Result } from '@aurora/shared'
import type { SettingsStoreLike } from '../contracts.js'

/** 内存态假 store：只实现端口用到的三个方法，其余按接口形状置 no-op */
function createFakeStore(initial: Settings): {
  store: SettingsStoreLike
  mutateCount: () => number
} {
  let current = initial
  let mutateCount = 0
  const store: SettingsStoreLike = {
    get: () => current,
    mutate: (mutator) => {
      mutateCount += 1
      const draft = structuredClone(current)
      mutator(draft)
      current = draft
      return current
    },
    update: (patch) => {
      current = { ...current, ...patch }
      return current
    },
    getSecret: () => '',
    setSecret: () => true,
    clearSecret: () => undefined,
    isCryptoAvailable: () => false,
    needsOnboarding: () => false,
    exportRedacted: () => current,
    flush: async () => undefined,
    onChange: () => () => undefined,
  }
  return { store, mutateCount: () => mutateCount }
}

/** 假 logger：只留痕 error，别让回滚路径的日志真往外冒 */
function createFakeLogger(): Logger & { errors: string[] } {
  const errors: string[] = []
  const logger: Logger & { errors: string[] } = {
    errors,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (message) => errors.push(message),
    child: () => logger,
  }
  return logger
}

/**
 * 假 applyPatch：**绕过** sanitize 直接把 patch 深合并进内存（与真实 `applyPatch`
 * 的合并形状一致、但没有 Schema 校验）—— 用来制造「写后 safeParse 失败」的触发条件。
 */
function fakeApplyPatch(store: SettingsStoreLike) {
  return (patch: SettingsPatch): Result<Settings> => {
    store.mutate((draft) => {
      for (const [key, value] of Object.entries(patch)) {
        ;(draft as unknown as Record<string, unknown>)[key] = value
      }
    })
    return { ok: true, value: store.get() }
  }
}

describe('createSettingsPort 的写后校验与回滚', () => {
  it('写后校验失败 → 回滚后 notifyChanged 被调用一次（工具闭包按回滚值重建）', async () => {
    const { store, mutateCount } = createFakeStore(createDefaultSettings())
    const logger = createFakeLogger()
    let notifyCount = 0
    const port = createSettingsPort({
      settings: store,
      applyPatch: () => fakeApplyPatch(store),
      logger,
      notifyChanged: () => {
        notifyCount += 1
      },
    })

    // `advanced.logLevel` 是枚举字符串：塞数字进去，假 applyPatch 不校验地写入了，
    // 于是端口自己的写后 `SettingsSchema.safeParse` 必然失败 → 走回滚分支
    const outcome = await port.write([{ path: 'advanced.logLevel', value: 42 }])

    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('已回滚')
    // 回滚真的把值写回去了（mutate 共两次：假 applyPatch 的写入 + 回滚）
    expect(store.get().advanced.logLevel).not.toBe(42)
    expect(mutateCount()).toBe(2)
    // 关键断言：回滚后补了**一次**广播（缺了它工具闭包就停在坏值上）
    expect(notifyCount).toBe(1)
    expect(logger.errors.some((message) => message.includes('已回滚'))).toBe(true)
  })

  it('正常写入不触发 notifyChanged（广播由 applyPatch 自己负责，不重复）', async () => {
    const { store } = createFakeStore(createDefaultSettings())
    const logger = createFakeLogger()
    let notifyCount = 0
    const port = createSettingsPort({
      settings: store,
      applyPatch: () => fakeApplyPatch(store),
      logger,
      notifyChanged: () => {
        notifyCount += 1
      },
    })

    const outcome = await port.write([{ path: 'agent.tools.enabled', value: false }])

    expect(outcome.ok).toBe(true)
    expect(store.get().agent.tools.enabled).toBe(false)
    expect(notifyCount).toBe(0)
  })

  it('未注入 notifyChanged 时不抛错（回滚分支的依赖是可选的）', async () => {
    const { store } = createFakeStore(createDefaultSettings())
    const logger = createFakeLogger()
    const port = createSettingsPort({
      settings: store,
      applyPatch: () => fakeApplyPatch(store),
      logger,
    })

    const outcome = await port.write([{ path: 'advanced.logLevel', value: 42 }])

    expect(outcome.ok).toBe(false)
    expect(store.get().advanced.logLevel).not.toBe(42)
  })
})

/**
 * 写入闸门 = `canWriteSettingPath`（shared，黑名单 × 覆盖表）× `TOP_LEVEL_GROUPS`（本文件）。
 * 两道都必须过：只对第一道放行会让「工具描述承诺可写、写入必拒」（P1-06）。
 */
describe('createSettingsPort 的写入闸门（黑名单 × 顶层分组）', () => {
  function setup(): { store: SettingsStoreLike; port: ReturnType<typeof createSettingsPort> } {
    const { store } = createFakeStore(createDefaultSettings())
    const port = createSettingsPort({
      settings: store,
      applyPatch: () => fakeApplyPatch(store),
      logger: createFakeLogger(),
    })
    return { store, port }
  }

  it('modes.work.workspaceDir 拒写（权限边界根的一级，P1-01）', async () => {
    const { store, port } = setup()
    // 它是 boundaryRoot 回落链的一级：AI 改写它 = 把「根内免确认」扩到任意目录
    const check = port.writable('modes.work.workspaceDir')
    expect(check.ok).toBe(false)
    // 拒绝理由来自硬编码黑名单（该路径在 `SETTINGS_READONLY_PREFIXES` 里，且不在覆盖表内）——
    // 比端口那句泛化的「不可修改的配置」更具体，也说明判定走的是 `canWriteSettingPath`
    if (!check.ok) expect(check.reason).toContain('权限边界根')

    const outcome = await port.write([{ path: 'modes.work.workspaceDir', value: 'D:\\任意目录' }])
    expect(outcome.ok).toBe(false)
    expect(outcome.applied).toEqual([])
    // 盘上的值一字未动（拒绝发生在合并之前）
    expect(store.get().modes.work.workspaceDir).toBe('')

    // 同一 modes 组内的可写字段不受牵连（只收紧这一个路径）
    expect(port.writable('modes.current').ok).toBe(true)
    expect(port.writable('modes.work.guideCompleted').ok).toBe(true)
  })

  it('用户把 readonlyPrefixes 清空也放不开 modes.work.workspaceDir（硬编码黑名单兜底，P1-01）', () => {
    // 「只从 WRITABLE_PATH_OVERRIDES 删掉」不够 —— 那样会落回「Schema 登记过即默认可写」；
    // 反向也一样：用户配置项只能在默认黑名单之上追加，清空只代表回到默认项。
    const settings = createDefaultSettings()
    settings.advanced.readonlyPrefixes = []
    const { store } = createFakeStore(settings)
    const port = createSettingsPort({
      settings: store,
      applyPatch: () => fakeApplyPatch(store),
      logger: createFakeLogger(),
    })

    const check = port.writable('modes.work.workspaceDir')
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.reason).toContain('权限边界')
  })

  it('tts / stt / imagegen 三组可真写入（承诺可写 = 写入可写，P1-06）', async () => {
    const { store, port } = setup()
    for (const path of ['tts.enabled', 'stt.enabled', 'imagegen.enabled']) {
      expect(port.writable(path).ok, path).toBe(true)
    }

    const outcome = await port.write([
      { path: 'tts.enabled', value: false },
      { path: 'stt.enabled', value: true },
      { path: 'imagegen.enabled', value: true },
    ])
    // 修复前：writable 说可写（覆盖表命中），write 却在分组检查处整体拒绝
    expect(outcome.ok).toBe(true)
    expect(outcome.applied).toEqual(['tts.enabled', 'stt.enabled', 'imagegen.enabled'])
    expect(store.get().tts.enabled).toBe(false)
    expect(store.get().stt.enabled).toBe(true)
    expect(store.get().imagegen.enabled).toBe(true)
  })

  it('三组内的凭据子树与 center 整组仍被拒（新放行不扩大到凭据 / 外发通道）', async () => {
    const { store, port } = setup()
    expect(port.writable('tts.providers.siliconflow.apiKey').ok).toBe(false)
    expect(port.writable('stt.providers').ok).toBe(false)
    expect(port.writable('imagegen.providers.openai.apiKeyEnc').ok).toBe(false)
    // center 整组只读（`TOP_LEVEL_GROUPS` 刻意不含它，两侧口径一致）
    expect(port.writable('center.enabled').ok).toBe(false)

    const outcome = await port.write([{ path: 'center.enabled', value: true }])
    expect(outcome.ok).toBe(false)
    expect(store.get().center.enabled).toBe(false)
  })
})

/**
 * 「承诺可写 = 写入可写」（P1-06 的同一条教训，这是第二处）。
 *
 * `reasonOf` 曾经把顺序弄反：先拿 `advanced.readonlyPrefixes`（默认值＝硬编码黑名单的**镜像**）
 * 做前缀匹配，于是 `llm.providers` 这条默认项先命中，覆盖表对
 * `llm.providers.<id>.model` 与 `...modelParams.<modelId>.reasoningEffort` 的放行**一次都没生效过** ——
 * 而工具描述 / `settings-hint` / 三册文档都承诺这两条可写（docs/08 §1 更明确写着
 * 「覆盖表的判定**先于** advanced.readonlyPrefixes 黑名单」）。
 *
 * 模型 id 可以带点（`gpt-4.1` / `claude-3.5-sonnet`），所以这一组两条都覆盖：
 * 不带点的走普通分段、带点的走 `splitSettingPath` 的还原。
 */
describe('createSettingsPort 写 llm.providers 的模型行为字段（覆盖表先于黑名单）', () => {
  function setup(): { store: SettingsStoreLike; port: ReturnType<typeof createSettingsPort> } {
    const initial = createDefaultSettings()
    const modelId = 'gpt-4.1'
    initial.llm.active = 'deepseek'
    initial.llm.providers['deepseek'] = {
      type: 'openai-compat',
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnc: 'CIPHER',
      model: modelId,
      modelList: [modelId, 'deepseek-chat'],
      modelParams: { [modelId]: { reasoningEffort: 'auto', contextWindow: 128_000, vision: true } },
    }
    const { store } = createFakeStore(initial)
    const port = createSettingsPort({
      settings: store,
      applyPatch: () => fakeApplyPatch(store),
      logger: createFakeLogger(),
    })
    return { store, port }
  }

  it('含点模型 id 的思考等级：permission 与 write 一致，且落在该模型自己的键下', async () => {
    const { store, port } = setup()
    const path = 'llm.providers.deepseek.modelParams.gpt-4.1.reasoningEffort'
    expect(port.writable(path).ok).toBe(true)

    const outcome = await port.write([{ path, value: 'high' }])
    expect(outcome.ok).toBe(true)
    expect(outcome.applied).toEqual([path])

    const provider = store.get().llm.providers['deepseek']
    expect(provider?.modelParams['gpt-4.1']?.reasoningEffort).toBe('high')
    // 关键：**没有**被切成 `modelParams['gpt-4'] = { '1': … }` 那种两层残骸
    expect(Object.keys(provider?.modelParams ?? {})).toEqual(['gpt-4.1'])
    // 兄弟字段不被这次写入抹掉
    expect(provider?.modelParams['gpt-4.1']?.contextWindow).toBe(128_000)
    expect(provider?.modelParams['gpt-4.1']?.vision).toBe(true)
    // 读回走同一条分段口径（否则端口会把「写成功」判成「未生效」）
    expect(port.read(path)).toBe('high')
  })

  it('切模型（llm.providers.<id>.model）也可写 —— 覆盖表里的另一条', async () => {
    const { store, port } = setup()
    const path = 'llm.providers.deepseek.model'
    expect(port.writable(path).ok).toBe(true)
    const outcome = await port.write([{ path, value: 'deepseek-chat' }])
    expect(outcome.ok).toBe(true)
    expect(store.get().llm.providers['deepseek']?.model).toBe('deepseek-chat')
  })

  it('凭据与模型能力事实仍被硬编码前缀拒（覆盖表赢了黑名单，但不放宽任何安全面）', async () => {
    const { store, port } = setup()
    for (const path of [
      'llm.providers.deepseek.apiKeyEnc',
      'llm.providers.deepseek.baseUrl',
      'llm.providers.deepseek.modelList',
      'llm.providers.deepseek.modelParams.gpt-4.1.contextWindow',
      'llm.providers.deepseek.modelParams.gpt-4.1.vision',
      'llm.providers.deepseek.modelParams',
      'llm.providers.deepseek',
    ]) {
      expect(port.writable(path).ok).toBe(false)
      expect((await port.write([{ path, value: 'x' }])).ok).toBe(false)
    }
    const provider = store.get().llm.providers['deepseek']
    expect(provider?.apiKeyEnc).toBe('CIPHER')
    expect(provider?.modelParams['gpt-4.1']?.contextWindow).toBe(128_000)
  })

  it('用户**追加**的黑名单前缀仍然生效（只能追加限制，不能放宽）', async () => {
    const { store, port } = setup()
    store.mutate((draft) => {
      draft.advanced.readonlyPrefixes = [
        ...draft.advanced.readonlyPrefixes,
        'llm.providers.deepseek.modelParams',
      ]
    })
    expect(port.writable('llm.providers.deepseek.modelParams.gpt-4.1.reasoningEffort').ok).toBe(
      false,
    )
    // 同组的另一条不受影响（前缀匹配只作用于被追加的那条）
    expect(port.writable('llm.providers.deepseek.model').ok).toBe(true)
  })
})
