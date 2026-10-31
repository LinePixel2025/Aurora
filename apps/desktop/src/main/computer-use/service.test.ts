import { createDefaultSettings, type Settings } from '@aurora/shared'
import { describe, expect, it } from 'vitest'
import { ComputerUseService, ComputerUseError } from './service.js'
import { COMPUTER_USE_RUN_CONTEXT } from './run-profile.js'

function logger(): {
  info(): void
  warn(): void
  debug(): void
} {
  return { info: () => undefined, warn: () => undefined, debug: () => undefined }
}

function makeService(options: {
  settings: Settings
  vision?: boolean
  overlayVisible?: boolean
  interval?: typeof setInterval
}) {
  const events: string[] = []
  const showCalls: number[] = []
  const stopped: Array<{ sessionId: string; reason: string }> = []
  const service = new ComputerUseService({
    settings: () => options.settings,
    logger: logger() as never,
    overlay: {
      show: async (displays) => {
        showCalls.push(displays.length)
      },
      hide: () => undefined,
      emit: (event) => events.push(event.type),
      applyConfig: () => undefined,
      diagnostics: () => ({ visible: options.overlayVisible === true, displays: 1 }),
    },
    visionForSession: () => options.vision !== false,
    visionEnabled: () => options.vision !== false,
    permissionMode: () => 'auto',
    displays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 100, height: 100 } }],
    cursorPoint: () => ({ x: 10, y: 10 }),
    setInterval: () => ({ unref: () => undefined }) as never,
    clearInterval: () => undefined,
    onStopped: (sessionId, reason) => stopped.push({ sessionId, reason }),
  })
  return { service, events, showCalls, stopped }
}

describe('ComputerUseService', () => {
  it('默认关闭时 start 拒绝', async () => {
    const settings = createDefaultSettings()
    const { service } = makeService({ settings })
    await expect(service.start('main')).rejects.toBeInstanceOf(ComputerUseError)
  })

  it('开启 + 视觉后建立唯一会话，结束后可再次开始', async () => {
    const settings = createDefaultSettings()
    settings.computerUse.enabled = true
    const { service, events } = makeService({ settings, overlayVisible: true })
    const status = await service.start('main')
    expect(status.active).toBe(true)
    expect(status.sessionId).toBe('main')
    expect(events).toContain('started')
    const stopped = service.stop('user')
    expect(stopped.active).toBe(false)
    expect(events).toContain('ended')
    await service.start('main')
    expect(service.status().active).toBe(true)
  })

  it('授权本身不建浮层：第一次工具调用才进入操作态并记录过程', async () => {
    const settings = createDefaultSettings()
    settings.computerUse.enabled = true
    const { service, showCalls } = makeService({ settings })
    await service.start('main')
    expect(showCalls).toHaveLength(0)
    expect(service.status().recentActions).toBeUndefined()

    service.ensureCallAllowed('main')
    await Promise.resolve()
    await Promise.resolve()
    expect(showCalls).toHaveLength(1)

    // 只读步骤（截图 / 等控件）进过程面板，但不计动作限额；连续相同动作合并为 count
    service.noteStep('main', 'screen.capture', '正在查看屏幕')
    service.noteStep('main', 'screen.capture', '正在查看屏幕')
    expect(service.status().actions).toBe(0)
    expect(service.status().recentActions).toEqual([
      { action: 'screen.capture', summary: '正在查看屏幕', count: 2 },
    ])

    service.beginAction('main', 'mouse.click', '正在左键单击')
    expect(service.status().actions).toBe(1)
    expect(service.status().lastActionKind).toBe('mouse.click')
    expect(service.status().recentActions).toEqual([
      { action: 'mouse.click', summary: '正在左键单击', count: 1 },
      { action: 'screen.capture', summary: '正在查看屏幕', count: 2 },
    ])

    service.stop('user')
    expect(service.status().recentActions).toBeUndefined()
  })

  it('唯一会话：另一个会话 start 返回 E_CU_BUSY', async () => {
    const settings = createDefaultSettings()
    settings.computerUse.enabled = true
    const { service } = makeService({ settings })
    await service.start('main')
    await expect(service.start('other')).rejects.toMatchObject({ code: 'E_CU_BUSY' })
  })

  it('授权失败关闭：非视觉 / 只读由调用方前置，这里验证每次调用重查', async () => {
    const settings = createDefaultSettings()
    settings.computerUse.enabled = true
    const { service } = makeService({ settings, vision: false })
    await expect(service.start('main')).rejects.toMatchObject({ code: 'E_CU_VISION_REQUIRED' })
    expect(service.status().active).toBe(false)
  })

  it('动作上限：超限停止并拒绝后续', async () => {
    const settings = createDefaultSettings()
    settings.computerUse.enabled = true
    settings.computerUse.maxActions = 1
    const { service } = makeService({ settings })
    await service.start('main')
    expect(service.beginAction('main', 'mouse.move', '移动')).toEqual({ step: 1, maxSteps: 1 })
    expect(() => service.beginAction('main', 'mouse.click', '点击')).toThrow(ComputerUseError)
    expect(service.status().active).toBe(false)
  })

  it('Agent 主动退出：只结束本会话，并把 agent 原因交给装配层', async () => {
    const settings = createDefaultSettings()
    settings.computerUse.enabled = true
    const { service, stopped } = makeService({ settings })
    await service.start('main')
    // 别的会话调用 stop 是幂等 no-op：不能把 main 的授权夺走
    const other = service.stop('agent', 'other')
    expect(other.active).toBe(true)
    expect(other.sessionId).toBe('main')
    expect(stopped).toHaveLength(0)

    const ended = service.stop('agent', 'main')
    expect(ended.active).toBe(false)
    expect(stopped).toEqual([{ sessionId: 'main', reason: 'agent' }])
  })

  it('自动化 / 自感知 / 子代理会话不能开启', async () => {
    const settings = createDefaultSettings()
    settings.computerUse.enabled = true
    const { service } = makeService({ settings })
    for (const sessionId of ['auto-x', 'awareness-x', 'chat-1-sub', '   ']) {
      await expect(service.start(sessionId)).rejects.toMatchObject({ code: 'E_CU_SESSION' })
    }
    // 普通 / quick / center 会话可以
    await expect(service.start('center-abc')).resolves.toMatchObject({ active: true })
  })

  it('run context 常量存在（非视觉 / 未授权提示由 run profile 使用）', () => {
    expect(COMPUTER_USE_RUN_CONTEXT).toContain('Computer Use')
  })
})
