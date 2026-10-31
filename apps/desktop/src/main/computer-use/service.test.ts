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

function makeService(options: { settings: Settings; vision?: boolean; overlayVisible?: boolean }) {
  const events: string[] = []
  const showCalls: number[] = []
  const stopped: Array<{ sessionId: string; reason: string }> = []
  /** 虚拟光标事件（`cursor`）的完整负载，用于断言轨迹。 */
  const cursors: Array<{ displayId: number; x: number; y: number }> = []
  const service = new ComputerUseService({
    settings: () => options.settings,
    logger: logger() as never,
    overlay: {
      show: async (displays) => {
        showCalls.push(displays.length)
      },
      hide: () => undefined,
      emit: (event) => {
        events.push(event.type)
        if (event.type === 'cursor') {
          cursors.push({ displayId: event.displayId, x: event.x, y: event.y })
        }
      },
      applyConfig: () => undefined,
      diagnostics: () => ({ visible: options.overlayVisible === true, displays: 1 }),
    },
    visionForSession: () => options.vision !== false,
    visionEnabled: () => options.vision !== false,
    permissionMode: () => 'auto',
    displays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 100, height: 100 } }],
    cursorPoint: () => ({ x: 10, y: 10 }),
    onStopped: (sessionId, reason) => stopped.push({ sessionId, reason }),
  })
  return { service, events, showCalls, stopped, cursors }
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

  it('下一步计划（v39.1）：写入 status、发 next 事件；空串清空；撤权后 no-op', async () => {
    const settings = createDefaultSettings()
    settings.computerUse.enabled = true
    const { service, events } = makeService({ settings })
    await service.start('main')
    expect(service.status().nextAction).toBeUndefined()

    service.noteNextStep('main', '  点击「保存」 ')
    expect(service.status().nextAction).toBe('点击「保存」')
    expect(events).toContain('next')
    // 不计动作限额，也不因为它显示浮层（浮层仍由第一次动作调用触发）
    expect(service.status().actions).toBe(0)

    // 超长截断到 120（与端口摘要同口径，不因为是展示字段就无限长）
    service.noteNextStep('main', 'x'.repeat(200))
    expect(service.status().nextAction).toBe('x'.repeat(120))

    service.noteNextStep('main', undefined)
    expect(service.status().nextAction).toBeUndefined()

    // 别的会话 / 已结束的会话：静默 no-op（调用点紧跟 ensureCallAllowed，这里不该抛）
    service.noteNextStep('other', '不该出现')
    expect(service.status().nextAction).toBeUndefined()
    service.stop('user')
    service.noteNextStep('main', '停止之后')
    expect(service.status().nextAction).toBeUndefined()
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

  it('虚拟光标：进入操作态时只播一次种子，之后不跟随（不轮询真实指针）', async () => {
    const settings = createDefaultSettings()
    settings.computerUse.enabled = true
    const { service, cursors } = makeService({ settings })
    await service.start('main')
    service.ensureCallAllowed('main')
    await Promise.resolve()
    await Promise.resolve()
    // 种子 = 真实指针 (10,10) 的显示器内 DIP
    expect(cursors).toEqual([{ displayId: 1, x: 10, y: 10 }])
    const framesAfterSeed = cursors.length
    // 没有动作就不再发 `cursor`（旧实现是 30fps 轮询，用户晃鼠标浮层会跟着跑）
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(cursors).toHaveLength(framesAfterSeed)
  })

  it('虚拟光标：moveCursor 沿轨迹滑到落点，关闭视觉时直接落点', async () => {
    const settings = createDefaultSettings()
    settings.computerUse.enabled = true
    const { service, cursors } = makeService({ settings })
    await service.start('main')
    service.ensureCallAllowed('main')
    await Promise.resolve()
    await Promise.resolve()
    cursors.length = 0

    await service.moveCursor({ displayId: 1, x: 80, y: 40, durationMs: 120 })
    expect(cursors.length).toBeGreaterThan(2)
    expect(cursors.at(-1)).toEqual({ displayId: 1, x: 80, y: 40 })
    // 中间帧必须单调前进，且都落在起点与终点之间（不是瞬移后补几帧）
    const midway = cursors[Math.floor(cursors.length / 2)]!
    expect(midway.x).toBeGreaterThan(10)
    expect(midway.x).toBeLessThan(80)

    settings.computerUse.showVirtualCursor = false
    cursors.length = 0
    await service.moveCursor({ displayId: 1, x: 5, y: 5, durationMs: 120 })
    expect(cursors).toEqual([{ displayId: 1, x: 5, y: 5 }])
  })

  it('虚拟光标：新滑动取消上一段，停止会话也会取消（不留悬挂的动画）', async () => {
    const settings = createDefaultSettings()
    settings.computerUse.enabled = true
    const { service, cursors } = makeService({ settings })
    await service.start('main')
    service.ensureCallAllowed('main')
    await Promise.resolve()
    await Promise.resolve()
    cursors.length = 0

    const first = service.moveCursor({ displayId: 1, x: 90, y: 90, durationMs: 200 })
    await new Promise((resolve) => setTimeout(resolve, 40))
    const second = service.moveCursor({ displayId: 1, x: 20, y: 20, durationMs: 40 })
    await Promise.all([first, second])
    // 后一段的终点生效，前一段不会再把光标拽回 (90,90)
    expect(cursors.at(-1)).toEqual({ displayId: 1, x: 20, y: 20 })

    const pending = service.moveCursor({ displayId: 1, x: 70, y: 10, durationMs: 400 })
    await new Promise((resolve) => setTimeout(resolve, 40))
    service.stop('user')
    // 停止必须让在途滑动立刻结束，否则动作链会卡在动画上
    await expect(Promise.race([pending, timeout(300)])).resolves.toBeUndefined()
  })
})

function timeout(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))
}
