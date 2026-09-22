import { describe, expect, it } from 'vitest'
import {
  createDefaultSettings,
  createMemoryLogger,
  type ModeContext,
  type ModeId,
  type Settings,
} from '@aurora/shared'
import { ModeManager } from './manager.js'
import { GuideRunner } from './guide-runner.js'
import { createClassroomMode } from './classroom.js'
import { createWorkMode } from './work.js'
import { createCodeMode } from './code.js'

function createHarness(settings: Settings = createDefaultSettings()) {
  const logger = createMemoryLogger()
  const ctx: ModeContext = {
    settings: {
      get: () => settings,
      mutate: (mutator) => {
        const draft = structuredClone(settings)
        mutator(draft)
        Object.assign(settings, draft)
        return structuredClone(settings)
      },
    },
    windows: { showChat: () => undefined, notify: () => undefined },
    proactive: { requestGuide: () => undefined, cancelGuide: () => undefined },
    fs: {
      exists: () => Promise.resolve(false),
      isDirectory: () => Promise.resolve(false),
      ensureDir: () => Promise.resolve(),
      resolveUserPath: (path) => (path.startsWith('~') ? path.replace('~', 'C:\\Users\\t') : path),
    },
    logger,
    state: new Map<string, unknown>(),
  }

  const manager = new ModeManager(logger)
  manager.register(createClassroomMode())
  manager.register(createWorkMode())
  manager.register(createCodeMode())
  const runner = new GuideRunner({ manager, ctx, logger })
  return { manager, runner, ctx, settings, logger }
}

describe('GuideRunner', () => {
  it('start 返回第一步并带上已配置的当前值', async () => {
    const { manager, runner, ctx, settings } = createHarness()
    await manager.init(ctx)
    const session = runner.start('classroom')
    expect(session.nextIndex).toBe(0)
    expect(session.total).toBe(4)
    expect(session.completed).toBe(false)
    expect(session.step?.field).toBe('modes.classroom.watchDir')
    expect(session.step?.currentValue).toBeUndefined()

    settings.modes.classroom.watchDir = 'D:\\Aurora\\感知文件夹'
    const resumed = runner.start('classroom')
    expect(resumed.step?.currentValue).toBe('D:\\Aurora\\感知文件夹')
  })

  it('逐步回答推进游标并写入配置，最后置 guideCompleted', async () => {
    const { manager, runner, ctx, settings } = createHarness()
    await manager.init(ctx)

    let result = runner.answer('classroom', 'D:\\Aurora\\感知文件夹')
    expect(result.error).toBeUndefined()
    expect(result.session.nextIndex).toBe(1)
    expect(settings.modes.classroom.watchDir).toBe('D:\\Aurora\\感知文件夹')

    result = runner.answer('classroom', '数学,物理')
    expect(result.session.nextIndex).toBe(2)
    expect(settings.modes.classroom.subjects.map((s) => s.name)).toEqual(['数学', '物理'])

    result = runner.answer('classroom', '数学=D:\\课程\\数学')
    expect(result.session.nextIndex).toBe(3)

    result = runner.answer('classroom', '是')
    expect(result.session.completed).toBe(true)
    expect(result.session.step).toBeNull()
    expect(settings.modes.classroom.preClassReminder).toBe(true)
    expect(settings.modes.classroom.guideCompleted).toBe(true)
    expect(manager.list().find((m) => m.id === 'classroom')?.guideCompleted).toBe(true)
  })

  it('校验失败不推进游标、不写配置', async () => {
    const { manager, runner, ctx, settings } = createHarness()
    await manager.init(ctx)
    runner.start('classroom')
    const result = runner.answer('classroom', '   ')
    expect(result.error).toContain('不能为空')
    expect(result.session.nextIndex).toBe(0)
    expect(settings.modes.classroom.watchDir).toBe('')
  })

  it('任意时刻可中断并续接（docs/05 §2 第 4 点）', async () => {
    const { manager, runner, ctx } = createHarness()
    await manager.init(ctx)
    runner.start('classroom')
    runner.answer('classroom', 'D:\\感知')
    // 模拟窗口关闭后重新打开
    const resumed = runner.start('classroom')
    expect(resumed.nextIndex).toBe(1)
    expect(resumed.step?.stepId).toBe('subjects')
  })

  it('已完成引导再次 start 直接返回 completed', async () => {
    const { manager, runner, ctx, settings } = createHarness()
    settings.modes.classroom.guideCompleted = true
    await manager.init(ctx)
    const session = runner.start('classroom')
    expect(session.completed).toBe(true)
    expect(session.step).toBeNull()
  })

  it('reset 回到第一步并清除完成标记', async () => {
    const { manager, runner, ctx, settings } = createHarness()
    settings.modes.classroom.guideCompleted = true
    await manager.init(ctx)
    const session = runner.reset('classroom')
    expect(session.nextIndex).toBe(0)
    expect(session.completed).toBe(false)
    expect(settings.modes.classroom.guideCompleted).toBe(false)
  })

  it('answerAll 一次提交整份答案，遇到错误即停止', async () => {
    const { manager, runner, ctx, settings } = createHarness()
    await manager.init(ctx)
    const result = runner.answerAll('classroom', ['默认', '数学,英语', '默认', '否'])
    expect(result.error).toBeUndefined()
    expect(result.session.completed).toBe(true)
    expect(settings.modes.classroom.subjects.map((s) => s.name)).toEqual(['数学', '英语'])
    expect(settings.modes.classroom.preClassReminder).toBe(false)
  })

  it('answerAll 在非法输入处停止且不越界', async () => {
    const { manager, runner, ctx } = createHarness()
    await manager.init(ctx)
    // 第 2 步（科目列表）给空答案 → 校验失败，后续答案不再消费
    const result = runner.answerAll('classroom', ['默认', '， ，', '默认'])
    expect(result.error).toContain('至少需要一个科目')
    expect(result.session.nextIndex).toBe(1)
    expect(result.session.step?.stepId).toBe('subjects')
  })

  it('占位模式引导各含一步并可完成', async () => {
    const { manager, runner, ctx, settings } = createHarness()
    await manager.init(ctx)
    const session = runner.start('work')
    expect(session.total).toBe(1)
    const result = runner.answer('work', '知道了')
    expect(result.session.completed).toBe(true)
    expect(settings.modes.work.guideCompleted).toBe(true)

    settings.modes.current = 'code'
    runner.start('code')
    runner.answer('code', '知道了')
    expect(settings.modes.code.guideCompleted).toBe(true)
  })

  it('无引导流程的模式抛出明确错误', async () => {
    const { manager, runner, ctx } = createHarness()
    await manager.init(ctx)
    expect(() => runner.start('gaming' as ModeId)).toThrowError(/没有可用的引导流程/)
  })

  it('summaries 反映引导状态与就绪度', async () => {
    const { manager, runner, ctx } = createHarness()
    await manager.init(ctx)
    const classroom = runner.summaries().find((m) => m.id === 'classroom')
    expect(classroom?.ready).toBe(false)
    expect(classroom?.readinessHint).toContain('智慧感知文件夹')

    runner.answerAll('classroom', ['D:\\感知', '数学', '默认', '是'])
    const ready = runner.summaries().find((m) => m.id === 'classroom')
    expect(ready?.ready).toBe(true)
    expect(ready?.guideCompleted).toBe(true)
  })
})
