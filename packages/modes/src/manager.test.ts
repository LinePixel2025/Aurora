import { describe, expect, it } from 'vitest'
import {
  MODE_IDS,
  createDefaultSettings,
  createMemoryLogger,
  type IMode,
  type ModeContext,
  type ModeId,
  type Settings,
} from '@aurora/shared'
import { ModeManager } from './manager.js'
import { createClassroomMode } from './classroom.js'
import { createWorkMode } from './work.js'
import { createCodeMode } from './code.js'

interface Harness {
  manager: ModeManager
  ctx: ModeContext
  settings: Settings
  guideRequests: Array<{ mode: ModeId; reason: string }>
  logger: ReturnType<typeof createMemoryLogger>
}

function createHarness(settings: Settings = createDefaultSettings()): Harness {
  const guideRequests: Array<{ mode: ModeId; reason: string }> = []
  const logger = createMemoryLogger()
  const dirs = new Set<string>()

  const ctx: ModeContext = {
    settings: {
      // 直接返回内部对象：mutate 需要真正写回测试持有的 settings
      get: () => settings,
      mutate: (mutator) => {
        const draft = structuredClone(settings)
        mutator(draft)
        Object.assign(settings, draft)
        return structuredClone(settings)
      },
    },
    windows: { showChat: () => undefined, notify: () => undefined },
    proactive: {
      requestGuide: (mode, reason) => guideRequests.push({ mode, reason }),
      cancelGuide: () => undefined,
    },
    fs: {
      exists: () => Promise.resolve(false),
      isDirectory: () => Promise.resolve(false),
      ensureDir: (path) => {
        dirs.add(path)
        return Promise.resolve()
      },
      resolveUserPath: (path) => path,
    },
    logger,
    state: new Map<string, unknown>(),
  }

  const manager = new ModeManager(logger)
  manager.register(createClassroomMode())
  manager.register(createWorkMode())
  manager.register(createCodeMode())
  return { manager, ctx, settings, guideRequests, logger }
}

describe('ModeManager 注册与摘要', () => {
  it('未初始化就访问当前模式时给出明确错误', () => {
    const manager = new ModeManager()
    expect(() => manager.currentId()).toThrowError(/尚未初始化/)
  })

  it('init 装配三个模式并按 MODE_IDS 顺序返回（ClassRoom 在前）', async () => {
    const { manager, ctx } = createHarness()
    const list = await manager.init(ctx)
    // 与 docs/07 §2.5、docs/08 §3「ClassRoom 推荐」一致：首发模式排在最前
    expect(list.map((m) => m.id)).toEqual([...MODE_IDS])
    expect(list[0]?.id).toBe('classroom')
    const classroom = list.find((m) => m.id === 'classroom')
    expect(classroom).toMatchObject({
      displayName: 'ClassRoom Mode',
      active: true,
      placeholder: false,
      guideCompleted: false,
      guideResumeable: true,
    })
    expect(classroom?.guideSteps).toHaveLength(4)
    expect(list.find((m) => m.id === 'work')?.placeholder).toBe(true)
  })

  it('重复注册被忽略', async () => {
    const { manager, ctx, logger } = createHarness()
    await manager.init(ctx)
    manager.register(createClassroomMode())
    expect(logger.entries.some((l) => l.includes('模式重复注册'))).toBe(true)
  })

  it('启动时激活当前模式失败不阻塞启动', async () => {
    const settings = createDefaultSettings()
    settings.modes.current = 'work'
    const { ctx, logger } = createHarness(settings)
    const broken: IMode = {
      ...createWorkMode(),
      async onActivate() {
        throw new Error('激活失败')
      },
    }
    const manager = new ModeManager(logger)
    manager.register(broken)
    await expect(manager.init(ctx)).resolves.toBeDefined()
    expect(logger.entries.some((l) => l.includes('启动时激活当前模式失败'))).toBe(true)
  })

  it('未注册的当前模式只告警', async () => {
    const settings = createDefaultSettings()
    settings.modes.current = 'code'
    const manager = new ModeManager()
    const { ctx } = createHarness(settings)
    await manager.init(ctx)
    expect(manager.list()).toEqual([])
  })
})

describe('ModeManager 切换', () => {
  it('切换成功：落盘 + 广播 + 提示需要引导', async () => {
    const { manager, ctx, settings } = createHarness()
    await manager.init(ctx)
    const events: Array<{ current: string; previous: string | null; reason: string }> = []
    manager.onChange((event) => {
      events.push({ current: event.current, previous: event.previous, reason: event.reason })
    })

    const result = await manager.setCurrent('work')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.guideRequired).toBe(true)
    expect(settings.modes.current).toBe('work')
    expect(manager.currentId()).toBe('work')
    expect(events).toEqual([{ current: 'work', previous: 'classroom', reason: 'user' }])
  })

  it('切换到同一模式是幂等的，不广播', async () => {
    const { manager, ctx } = createHarness()
    await manager.init(ctx)
    let emitted = 0
    manager.onChange(() => {
      emitted += 1
    })
    const result = await manager.setCurrent('classroom')
    expect(result.ok).toBe(true)
    expect(emitted).toBe(0)
  })

  it('未注册模式返回失败且不改变配置', async () => {
    const { manager, ctx, settings } = createHarness()
    await manager.init(ctx)
    const result = await manager.setCurrent('gaming' as ModeId)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('未注册')
    expect(settings.modes.current).toBe('classroom')
  })

  it('onActivate 抛错时回滚到旧模式', async () => {
    const { manager, ctx, settings, logger } = createHarness()
    await manager.init(ctx)
    const broken = {
      ...createWorkMode(),
      id: 'work' as const,
      displayName: 'Work Mode',
      async onActivate() {
        throw new Error('磁盘不可写')
      },
    }
    // 重新构造一个只含坏 work 的 manager，避免重复注册
    const brokenManager = new ModeManager(logger)
    brokenManager.register(createClassroomMode())
    brokenManager.register(broken)
    await brokenManager.init(ctx)

    const result = await brokenManager.setCurrent('work')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('磁盘不可写')
      expect(result.current).toBe('classroom')
    }
    expect(settings.modes.current).toBe('classroom')
    expect(logger.entries.some((l) => l.includes('模式激活失败，回滚'))).toBe(true)
  })

  it('onDeactivate 抛错同样回滚', async () => {
    const settings = createDefaultSettings()
    settings.modes.current = 'work'
    const { ctx, logger } = createHarness(settings)
    const failingWork: IMode = {
      ...createWorkMode(),
      async onDeactivate() {
        throw new Error('停用失败')
      },
    }
    const custom = new ModeManager(logger)
    custom.register(createClassroomMode())
    custom.register(failingWork)
    await custom.init(ctx)

    const result = await custom.setCurrent('classroom')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('停用失败')
    expect(settings.modes.current).toBe('work')
    expect(logger.entries.some((l) => l.includes('模式激活失败，回滚'))).toBe(true)
  })
})

describe('ModeManager 引导状态', () => {
  it('completeGuide 落盘并广播', async () => {
    const { manager, ctx, settings } = createHarness()
    await manager.init(ctx)
    const list = manager.completeGuide('classroom')
    expect(settings.modes.classroom.guideCompleted).toBe(true)
    expect(list.find((m) => m.id === 'classroom')?.guideCompleted).toBe(true)
  })

  it('resetGuide 支持设置页「重新引导」', async () => {
    const { manager, ctx, settings } = createHarness()
    settings.modes.classroom.guideCompleted = true
    await manager.init(ctx)
    manager.resetGuide('classroom')
    expect(settings.modes.classroom.guideCompleted).toBe(false)
    expect(manager.isGuideCompleted('classroom')).toBe(false)
  })

  it('requestGuideIfNeeded：未完成时请求，完成后不再请求', async () => {
    const { manager, ctx, settings, guideRequests } = createHarness()
    await manager.init(ctx)
    expect(manager.requestGuideIfNeeded('classroom', 'mode-switch')).toBe(true)
    expect(guideRequests).toEqual([{ mode: 'classroom', reason: 'mode-switch' }])

    settings.modes.classroom.guideCompleted = true
    expect(manager.requestGuideIfNeeded('classroom', 'mode-switch')).toBe(false)
    expect(guideRequests).toHaveLength(1)
  })

  it('占位模式也有可比对的引导状态', async () => {
    const { manager, ctx, settings } = createHarness()
    await manager.init(ctx)
    expect(manager.isGuideCompleted('work')).toBe(false)
    manager.completeGuide('work')
    expect(settings.modes.work.guideCompleted).toBe(true)
    manager.completeGuide('code')
    expect(settings.modes.code.guideCompleted).toBe(true)
  })

  it('systemPrompt 返回当前模式片段', async () => {
    const { manager, ctx } = createHarness()
    await manager.init(ctx)
    expect(manager.systemPrompt()).toContain('ClassRoom Mode')
    await manager.setCurrent('work')
    expect(manager.systemPrompt()).toContain('Work Mode')
  })
})
