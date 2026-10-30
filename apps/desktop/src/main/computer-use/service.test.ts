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
  const service = new ComputerUseService({
    settings: () => options.settings,
    logger: logger() as never,
    overlay: {
      show: async () => undefined,
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
  })
  return { service, events }
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

  it('run context 常量存在（非视觉 / 未授权提示由 run profile 使用）', () => {
    expect(COMPUTER_USE_RUN_CONTEXT).toContain('Computer Use')
  })
})
