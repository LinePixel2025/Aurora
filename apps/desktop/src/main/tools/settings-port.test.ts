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
