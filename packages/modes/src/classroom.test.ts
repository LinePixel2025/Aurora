import { describe, expect, it } from 'vitest'
import {
  createDefaultSettings,
  createMemoryLogger,
  type ModeContext,
  type Settings,
} from '@aurora/shared'
import {
  CLASSROOM_GUIDE_ID,
  classroomGuide,
  createClassroomMode,
  classroomReadiness,
} from './classroom.js'
import { WORK_GUIDE_ID, createWorkMode, workGuide, workReadiness } from './work.js'
import { createCodeMode } from './code.js'

function createContext(input: Settings = createDefaultSettings()) {
  const settings: Settings = input
  const dirs = new Set<string>()
  const notifications: string[] = []
  const guideRequests: Array<{ mode: string; reason: string }> = []
  const logger = createMemoryLogger()

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
    windows: {
      showChat: () => undefined,
      notify: (title, body, openPath) => {
        notifications.push([title, body, openPath ?? ''].join('|'))
      },
    },
    proactive: {
      requestGuide: (mode, reason) => guideRequests.push({ mode, reason }),
      cancelGuide: () => undefined,
    },
    fs: {
      exists: (path) => Promise.resolve(dirs.has(path)),
      isDirectory: (path) => Promise.resolve(dirs.has(path)),
      ensureDir: (path) => {
        dirs.add(path)
        return Promise.resolve()
      },
      resolveUserPath: (path) => {
        const trimmed = path.trim()
        if (trimmed.startsWith('~')) return trimmed.replace('~', 'C:\\Users\\tester')
        if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('/')) return trimmed
        return `C:\\Users\\tester\\${trimmed.replace(/\//g, '\\')}`
      },
    },
    logger,
    state: new Map<string, unknown>(),
  }

  return { ctx, settings, dirs, notifications, guideRequests, logger }
}

const step = (id: string) => {
  const found = classroomGuide.steps.find((s) => s.id === id)
  if (!found) throw new Error(`缺少引导步骤 ${id}`)
  return found
}

describe('ClassRoom 引导定义', () => {
  it('引导步骤覆盖 05 §2 的四步且可续接', () => {
    expect(classroomGuide.id).toBe(CLASSROOM_GUIDE_ID)
    expect(classroomGuide.resumeable).toBe(true)
    expect(classroomGuide.steps.map((s) => s.id)).toEqual([
      'watch-dir',
      'subjects',
      'subject-folders',
      'pre-class-reminder',
    ])
  })

  it('每一步都声明了配置字段与提问文案', () => {
    for (const item of classroomGuide.steps) {
      expect(item.field.length).toBeGreaterThan(0)
      expect(item.question.length).toBeGreaterThan(0)
    }
  })
})

describe('① 感知文件夹', () => {
  it('回复「默认」使用 用户目录\\Aurora\\感知文件夹', () => {
    const { ctx, settings } = createContext()
    expect(step('watch-dir').validate?.('默认', ctx)).toBeUndefined()
    step('watch-dir').apply?.('默认', ctx)
    expect(settings.modes.classroom.watchDir).toBe('C:\\Users\\tester\\Aurora\\感知文件夹')
  })

  it('接受绝对路径并原样写入', () => {
    const { ctx, settings } = createContext()
    step('watch-dir').apply?.('D:\\Aurora\\感知文件夹', ctx)
    expect(settings.modes.classroom.watchDir).toBe('D:\\Aurora\\感知文件夹')
  })

  it('空输入被拒绝', () => {
    const { ctx } = createContext()
    expect(step('watch-dir').validate?.('   ', ctx)).toContain('不能为空')
  })
})

describe('② 科目列表', () => {
  it('回复自定义列表时重建科目映射', () => {
    const { ctx, settings } = createContext()
    expect(step('subjects').validate?.('数学,物理', ctx)).toBeUndefined()
    step('subjects').apply?.('数学,物理', ctx)
    expect(settings.modes.classroom.subjects).toEqual([
      { name: '数学', folder: '分类/数学', keywords: [] },
      { name: '物理', folder: '分类/物理', keywords: [] },
    ])
  })

  it('回复「默认」使用九科模板', () => {
    const { ctx, settings } = createContext()
    step('subjects').apply?.('默认', ctx)
    expect(settings.modes.classroom.subjects).toHaveLength(9)
    expect(settings.modes.classroom.subjects[0]?.name).toBe('语文')
  })

  it('空白或全部为默认词时校验失败', () => {
    const { ctx } = createContext()
    expect(step('subjects').validate?.('， ，', ctx)).toBe('至少需要一个科目')
  })

  it('已存在科目的 keywords 被保留（P4 规则缓存）', () => {
    const settings = createDefaultSettings()
    settings.modes.classroom.subjects = [{ name: '数学', folder: '分类/数学', keywords: ['函数'] }]
    const { ctx } = createContext(settings)
    step('subjects').apply?.('数学,英语', ctx)
    expect(settings.modes.classroom.subjects).toEqual([
      { name: '数学', folder: '分类/数学', keywords: ['函数'] },
      { name: '英语', folder: '分类/英语', keywords: [] },
    ])
  })
})

describe('③ 每科目标文件夹', () => {
  it('支持「科目=绝对路径」映射', () => {
    const { ctx, settings } = createContext()
    step('watch-dir').apply?.('D:\\Aurora\\感知文件夹', ctx)
    step('subjects').apply?.('数学,物理', ctx)
    expect(step('subject-folders').validate?.('数学=D:\\课程\\数学', ctx)).toBeUndefined()
    step('subject-folders').apply?.('数学=D:\\课程\\数学', ctx)
    expect(settings.modes.classroom.subjects).toEqual([
      { name: '数学', folder: 'D:\\课程\\数学', keywords: [] },
      { name: '物理', folder: '分类/物理', keywords: [] },
    ])
  })

  it('相对路径被拒绝', () => {
    const { ctx } = createContext()
    expect(step('subject-folders').validate?.('数学=课程/数学', ctx)).toContain('绝对路径')
  })

  it('非法格式被拒绝', () => {
    const { ctx } = createContext()
    expect(step('subject-folders').validate?.('随便写点什么', ctx)).toContain('格式示例')
  })

  it('回复「默认」保持既有映射', () => {
    const { ctx, settings } = createContext()
    step('subjects').apply?.('数学', ctx)
    step('subject-folders').apply?.('默认', ctx)
    expect(settings.modes.classroom.subjects[0]?.folder).toBe('分类/数学')
  })
})

describe('④ 课前提醒', () => {
  it('识别肯定 / 否定回答', () => {
    const { ctx, settings } = createContext()
    expect(step('pre-class-reminder').validate?.('是', ctx)).toBeUndefined()
    step('pre-class-reminder').apply?.('否', ctx)
    expect(settings.modes.classroom.preClassReminder).toBe(false)
    step('pre-class-reminder').apply?.('开启', ctx)
    expect(settings.modes.classroom.preClassReminder).toBe(true)
  })

  it('无法识别时给出提示', () => {
    const { ctx } = createContext()
    expect(step('pre-class-reminder').validate?.('大概吧', ctx)).toContain('是')
  })
})

describe('ClassRoom 模式行为', () => {
  it('激活时创建感知文件夹与科目文件夹', async () => {
    const settings = createDefaultSettings()
    settings.modes.classroom.watchDir = 'D:\\Aurora\\感知文件夹'
    settings.modes.classroom.subjects = [{ name: '数学', folder: '分类/数学', keywords: [] }]
    const { ctx, dirs } = createContext(settings)
    await createClassroomMode().onActivate(ctx)
    expect(dirs.has('D:\\Aurora\\感知文件夹')).toBe(true)
    expect(dirs.has('C:\\Users\\tester\\分类\\数学')).toBe(true)
  })

  it('未配置感知文件夹时不报错', async () => {
    const { ctx } = createContext()
    await expect(createClassroomMode().onActivate(ctx)).resolves.toBeUndefined()
  })

  it('单个科目文件夹创建失败不阻断激活', async () => {
    const settings = createDefaultSettings()
    settings.modes.classroom.subjects = [
      { name: '数学', folder: '分类/数学', keywords: [] },
      { name: '物理', folder: '分类/物理', keywords: [] },
    ]
    const { ctx, logger, dirs } = createContext(settings)
    const failing: ModeContext = {
      ...ctx,
      fs: {
        ...ctx.fs,
        ensureDir: (path) => {
          if (path.includes('数学')) return Promise.reject(new Error('EACCES'))
          dirs.add(path)
          return Promise.resolve()
        },
      },
    }
    await expect(createClassroomMode().onActivate(failing)).resolves.toBeUndefined()
    expect(logger.entries.some((l) => l.includes('科目文件夹创建失败'))).toBe(true)
    expect(dirs.has('C:\\Users\\tester\\分类\\物理')).toBe(true)
  })

  it('系统提示词包含模式、感知文件夹、科目与提醒状态', () => {
    const settings = createDefaultSettings()
    settings.modes.classroom.watchDir = 'D:\\Aurora\\感知文件夹'
    const { ctx } = createContext(settings)
    const prompt = createClassroomMode().systemPrompt(ctx)
    expect(prompt).toContain('ClassRoom Mode')
    expect(prompt).toContain('D:\\Aurora\\感知文件夹')
    expect(prompt).toContain('语文')
    expect(prompt).toContain('确认')
  })

  it('classroomReadiness 指出缺失项', () => {
    const settings = createDefaultSettings()
    settings.modes.classroom.watchDir = ''
    settings.modes.classroom.subjects = []
    expect(classroomReadiness(settings)).toEqual({
      ready: false,
      missing: ['智慧感知文件夹', '科目列表'],
    })
    settings.modes.classroom.watchDir = 'D:\\x'
    settings.modes.classroom.subjects = [{ name: '数学', folder: 'a', keywords: [] }]
    expect(classroomReadiness(settings)).toEqual({ ready: true, missing: [] })
  })
})

const workStep = (id: string) => {
  const found = workGuide.steps.find((s) => s.id === id)
  if (!found) throw new Error(`缺少引导步骤 ${id}`)
  return found
}

describe('Work 引导定义', () => {
  it('引导步骤为两步（工作目录 + 确认）且可续接', () => {
    expect(workGuide.id).toBe(WORK_GUIDE_ID)
    expect(workGuide.resumeable).toBe(true)
    expect(workGuide.steps.map((s) => s.id)).toEqual(['workspace-dir', 'acknowledge'])
  })

  it('每一步都声明了配置字段与提问文案', () => {
    for (const item of workGuide.steps) {
      expect(item.field.length).toBeGreaterThan(0)
      expect(item.question.length).toBeGreaterThan(0)
    }
  })
})

describe('Work 工作目录', () => {
  it('回复「默认」使用 用户目录\\Aurora\\工作目录', () => {
    const { ctx, settings } = createContext()
    expect(workStep('workspace-dir').validate?.('默认', ctx)).toBeUndefined()
    workStep('workspace-dir').apply?.('默认', ctx)
    expect(settings.modes.work.workspaceDir).toBe('C:\\Users\\tester\\Aurora\\工作目录')
  })

  it('接受绝对路径并原样写入', () => {
    const { ctx, settings } = createContext()
    workStep('workspace-dir').apply?.('D:\\办公', ctx)
    expect(settings.modes.work.workspaceDir).toBe('D:\\办公')
  })

  it('空输入被拒绝', () => {
    const { ctx } = createContext()
    expect(workStep('workspace-dir').validate?.('   ', ctx)).toContain('不能为空')
  })

  it('确认步骤任意非空回答均通过', () => {
    const { ctx } = createContext()
    expect(workStep('acknowledge').validate?.('知道了', ctx)).toBeUndefined()
    expect(workStep('acknowledge').validate?.('好', ctx)).toBeUndefined()
    expect(workStep('acknowledge').validate?.('   ', ctx)).toContain('知道了')
  })
})

describe('Work 模式行为', () => {
  it('标记为非占位、感知订阅为 60s 时钟', () => {
    const mode = createWorkMode()
    expect(mode.placeholder).toBe(false)
    expect(mode.displayName).toBe('工作模式')
    expect(mode.perceptionSubscriptions).toEqual([{ kind: 'clock', intervalMs: 60_000 }])
  })

  it('激活时创建工作目录', async () => {
    const settings = createDefaultSettings()
    settings.modes.work.workspaceDir = 'D:\\Aurora\\工作目录'
    const { ctx, dirs } = createContext(settings)
    await createWorkMode().onActivate(ctx)
    expect(dirs.has('D:\\Aurora\\工作目录')).toBe(true)
  })

  it('未配置工作目录时激活不报错', async () => {
    const { ctx } = createContext()
    await expect(createWorkMode().onActivate(ctx)).resolves.toBeUndefined()
  })

  it('工作目录创建失败不阻断激活', async () => {
    const settings = createDefaultSettings()
    settings.modes.work.workspaceDir = 'D:\\Aurora\\工作目录'
    const { ctx, logger } = createContext(settings)
    const failing: ModeContext = {
      ...ctx,
      fs: {
        ...ctx.fs,
        ensureDir: () => Promise.reject(new Error('EACCES')),
      },
    }
    await expect(createWorkMode().onActivate(failing)).resolves.toBeUndefined()
    expect(logger.entries.some((l) => l.includes('工作目录创建失败'))).toBe(true)
  })

  it('系统提示词包含办公职责、工作目录、确认约束与 ClassRoom 边界', () => {
    const settings = createDefaultSettings()
    settings.modes.work.workspaceDir = 'D:\\Aurora\\工作目录'
    const { ctx } = createContext(settings)
    const prompt = createWorkMode().systemPrompt(ctx)
    expect(prompt).toContain('工作模式')
    expect(prompt).toContain('D:\\Aurora\\工作目录')
    expect(prompt).toContain('PowerShell')
    expect(prompt).toContain('确认')
    expect(prompt).toContain('ClassRoom Mode')
  })

  it('未配置工作目录时提示词声明尚未配置', () => {
    const { ctx } = createContext()
    const prompt = createWorkMode().systemPrompt(ctx)
    expect(prompt).toContain('尚未配置')
  })

  it('workReadiness 指出缺失项', () => {
    const settings = createDefaultSettings()
    expect(workReadiness(settings)).toEqual({ ready: false, missing: ['工作目录'] })
    settings.modes.work.workspaceDir = 'D:\\x'
    expect(workReadiness(settings)).toEqual({ ready: true, missing: [] })
  })
})

describe('占位模式', () => {
  it('Code 标记为占位且提示词说明建设中', () => {
    const mode = createCodeMode()
    expect(mode.placeholder).toBe(true)
    expect(mode.systemPrompt({} as ModeContext)).toContain('建设中')
    expect(mode.guide?.steps).toHaveLength(1)
  })

  it('占位模式激活 / 停用不抛错', async () => {
    const { ctx } = createContext()
    await expect(createCodeMode().onActivate(ctx)).resolves.toBeUndefined()
    await expect(createCodeMode().onDeactivate(ctx)).resolves.toBeUndefined()
  })
})
