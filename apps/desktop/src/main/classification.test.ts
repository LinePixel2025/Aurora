import { describe, expect, it } from 'vitest'
import type { ClassificationRecord, Logger, Settings } from '@aurora/shared'
import { ClassificationService } from './classification.js'
import type { ClassifyProvider } from './classify/llm.js'

const WATCH = 'D:\\感知'

/** 静默 Logger（`child()` 必须能自洽返回，否则会推导出循环类型） */
const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
}

/** 内存历史（与 ClassificationHistory 的结构面一致，避免测试依赖磁盘） */
function memoryHistory() {
  const records: ClassificationRecord[] = []
  return {
    records,
    append(record: ClassificationRecord) {
      const index = records.findIndex((item) => item.id === record.id)
      if (index >= 0) records.splice(index, 1)
      records.unshift({ ...record })
    },
    update(id: string, patch: Partial<ClassificationRecord>) {
      const index = records.findIndex((item) => item.id === id)
      if (index < 0) return undefined
      const next = { ...records[index]!, ...patch }
      records.splice(index, 1)
      records.unshift(next)
      return next
    },
    get(id: string) {
      return records.find((item) => item.id === id)
    },
    list() {
      return [...records]
    },
    corrected() {
      return records.filter((item) => item.corrected === true)
    },
    clear() {
      records.length = 0
    },
    async flush() {
      /* 内存实现无需落盘 */
    },
  }
}

/** 内存文件系统 */
function memoryFs(seed: Record<string, number> = {}) {
  const files = new Map<string, number>(Object.entries(seed))
  const dirs = new Set<string>()
  return {
    files,
    dirs,
    async exists(path: string) {
      return files.has(path) || dirs.has(path)
    },
    async ensureDir(path: string) {
      dirs.add(path)
    },
    async rename(from: string, to: string) {
      const size = files.get(from)
      if (size === undefined) throw new Error(`ENOENT: ${from}`)
      files.delete(from)
      files.set(to, size)
    },
    async copy(from: string, to: string) {
      const size = files.get(from)
      if (size === undefined) throw new Error(`ENOENT: ${from}`)
      files.set(to, size)
    },
    async remove(path: string) {
      files.delete(path)
    },
    async sizeOf(path: string) {
      return files.get(path)
    },
  }
}

function settingsWith(overrides: {
  autoMove?: boolean
  threshold?: number
  subjects?: Settings['modes']['classroom']['subjects']
}): Settings {
  return {
    version: 2,
    general: {
      language: 'zh-CN',
      launchAtLogin: false,
      hotkey: 'Alt+Space',
      edgeBar: { enabled: true, opacity: 0.9, quietHours: null },
      windowState: {},
    },
    llm: { active: 'x', providers: {} },
    modes: {
      current: 'classroom',
      classroom: {
        guideCompleted: true,
        watchDir: WATCH,
        subjects: overrides.subjects ?? [
          { name: '数学', folder: '分类/数学', keywords: ['方程'] },
          { name: '物理', folder: '分类/物理', keywords: ['电路'] },
        ],
        schedule: { provider: 'manual', lessons: [] },
        preClassReminder: true,
        classification: {
          autoMove: overrides.autoMove ?? true,
          confidenceThreshold: overrides.threshold ?? 0.6,
          fallbackFolder: '待分类',
        },
      },
      work: { guideCompleted: false },
      code: { guideCompleted: false },
    },
    skills: { userDir: '', disabled: [] },
    mcp: { servers: [], lazyConnect: false },
    advanced: {
      proxy: '',
      logLevel: 'info',
      quietHours: null,
      confirmSensitiveTools: true,
    },
  }
}

function scriptedProvider(responses: string[]): ClassifyProvider & { calls: number } {
  let index = 0
  const provider = {
    calls: 0,
    chat() {
      provider.calls += 1
      const text = responses[index] ?? ''
      index += 1
      return iterate(text)
    },
  }
  return provider
}

async function* iterate(text: string): AsyncIterable<{ type: string; delta?: string }> {
  if (text !== '') yield { type: 'text', delta: text }
  yield { type: 'done' }
}

interface Harness {
  service: ClassificationService
  fs: ReturnType<typeof memoryFs>
  history: ReturnType<typeof memoryHistory>
  notifications: Array<{ kind: string; fileName: string; subject?: string; reason?: string }>
  /** 事件同时记录 record.id：id 一致是渲染层能原地刷新"排队中"的前提 */
  events: Array<{ state: string; subject: string; recordId: string }>
  extractCalls: number[]
  suppressed: string[]
}

function harness(options: {
  seed?: Record<string, number>
  settings?: Settings
  provider?: ClassifyProvider
  extractEvidence?: string
  extractWarnings?: string[]
  noProvider?: boolean
}): Harness {
  const fs = memoryFs(options.seed ?? { [`${WATCH}\\a.pdf`]: 100 })
  const history = memoryHistory()
  const notifications: Harness['notifications'] = []
  const events: Harness['events'] = []
  const extractCalls: number[] = []
  const suppressed: string[] = []
  let counter = 0

  const service = new ClassificationService({
    getSettings: () => options.settings ?? settingsWith({}),
    extract: async () => {
      extractCalls.push(1)
      return {
        kind: 'document',
        evidence: options.extractEvidence ?? '内容证据',
        evidenceChars: 4,
        warnings: options.extractWarnings ?? [],
        degraded: (options.extractWarnings ?? []).length > 0,
      }
    },
    providerFactory: {
      create: () => {
        if (options.noProvider === true) return undefined
        const provider = options.provider ?? scriptedProvider([])
        return { provider, model: 'test-model' }
      },
    },
    history,
    notifications: {
      notifyClassified(input) {
        notifications.push({ kind: 'classified', fileName: input.fileName, subject: input.subject })
        return true
      },
      notifyFallback(input) {
        notifications.push({ kind: 'fallback', fileName: input.fileName, reason: input.reason })
        return true
      },
    },
    fs,
    logger: silentLogger,
    now: () => new Date('2025-01-01T00:00:00.000Z'),
    nextId: () => `rec-${++counter}`,
    suppressPath: (path) => suppressed.push(path),
  })

  service.reconfigure()
  service.onEvent((event) =>
    events.push({
      state: event.state,
      subject: event.record.subject,
      recordId: event.record.id,
    }),
  )

  return { service, fs, history, notifications, events, extractCalls, suppressed }
}

/** 让队列跑完 */
async function runToCompletion(
  harness: Harness,
  file: { path: string; fileName: string; ext: string; sizeBytes: number },
): Promise<void> {
  harness.service.handleFile(file)
  await harness.service.drain()
}

describe('ClassificationService · 规则命中路径', () => {
  it('文件名含科目名 → 直接移动，且不调用 LLM / 提取', async () => {
    const provider = scriptedProvider([])
    const h = harness({ seed: { [`${WATCH}\\数学作业.pdf`]: 100 }, provider })
    await runToCompletion(h, {
      path: `${WATCH}\\数学作业.pdf`,
      fileName: '数学作业.pdf',
      ext: 'pdf',
      sizeBytes: 100,
    })

    expect(h.fs.files.has(`${WATCH}\\分类\\数学\\数学作业.pdf`)).toBe(true)
    expect(h.fs.files.has(`${WATCH}\\数学作业.pdf`)).toBe(false)
    expect(provider.calls).toBe(0)
    expect(h.extractCalls).toHaveLength(0)
    expect(h.history.records[0]?.source).toBe('rule')
    expect(h.history.records[0]?.subject).toBe('数学')
    expect(h.notifications[0]?.kind).toBe('classified')
  })

  it('关键词命中同样跳过 LLM', async () => {
    const provider = scriptedProvider([])
    const h = harness({ seed: { [`${WATCH}\\一元二次方程.pdf`]: 100 }, provider })
    await runToCompletion(h, {
      path: `${WATCH}\\一元二次方程.pdf`,
      fileName: '一元二次方程.pdf',
      ext: 'pdf',
      sizeBytes: 100,
    })
    expect(h.history.records[0]?.subject).toBe('数学')
    expect(provider.calls).toBe(0)
  })

  it('移动后事件序列为 queued → … → done', async () => {
    const h = harness({ seed: { [`${WATCH}\\数学.pdf`]: 100 } })
    await runToCompletion(h, {
      path: `${WATCH}\\数学.pdf`,
      fileName: '数学.pdf',
      ext: 'pdf',
      sizeBytes: 100,
    })
    const states = h.events.map((event) => event.state)
    expect(states[0]).toBe('queued')
    expect(states).toContain('moving')
    expect(states.at(-1)).toBe('done')
  })
})

describe('ClassificationService · LLM 判定路径', () => {
  it('规则未命中 → 提取 + LLM 判定 → 移动', async () => {
    const provider = scriptedProvider(['{"subject":"物理","confidence":0.9,"reason":"电路图"}'])
    const h = harness({ seed: { [`${WATCH}\\扫描件001.pdf`]: 100 }, provider })
    await runToCompletion(h, {
      path: `${WATCH}\\扫描件001.pdf`,
      fileName: '扫描件001.pdf',
      ext: 'pdf',
      sizeBytes: 100,
    })

    expect(h.extractCalls).toHaveLength(1)
    expect(provider.calls).toBe(1)
    expect(h.fs.files.has(`${WATCH}\\分类\\物理\\扫描件001.pdf`)).toBe(true)
    expect(h.history.records[0]?.source).toBe('llm')
    expect(h.history.records[0]?.subject).toBe('物理')
    expect(h.events.map((e) => e.state)).toContain('extracting')
    expect(h.events.map((e) => e.state)).toContain('classifying')
  })

  it('置信度低于阈值 → 落「待分类」并通知用户确认', async () => {
    const provider = scriptedProvider(['{"subject":"物理","confidence":0.2,"reason":"不确定"}'])
    const h = harness({
      seed: { [`${WATCH}\\模糊.pdf`]: 100 },
      provider,
      settings: settingsWith({ threshold: 0.6 }),
    })
    await runToCompletion(h, {
      path: `${WATCH}\\模糊.pdf`,
      fileName: '模糊.pdf',
      ext: 'pdf',
      sizeBytes: 100,
    })

    expect(h.fs.files.has(`${WATCH}\\待分类\\模糊.pdf`)).toBe(true)
    expect(h.history.records[0]?.subject).toBe('')
    expect(h.history.records[0]?.source).toBe('fallback')
    expect(h.history.records[0]?.reason).toContain('低于阈值')
    expect(h.notifications[0]?.kind).toBe('fallback')
    expect(h.events.at(-1)?.state).toBe('fallback')
  })

  it('模型无法判断（空科目）→ 落「待分类」', async () => {
    const provider = scriptedProvider(['{"subject":"","confidence":0,"reason":"依据不足"}'])
    const h = harness({ seed: { [`${WATCH}\\无特征.pdf`]: 100 }, provider })
    await runToCompletion(h, {
      path: `${WATCH}\\无特征.pdf`,
      fileName: '无特征.pdf',
      ext: 'pdf',
      sizeBytes: 100,
    })
    expect(h.fs.files.has(`${WATCH}\\待分类\\无特征.pdf`)).toBe(true)
    expect(h.history.records[0]?.source).toBe('fallback')
  })

  it('没有可用模型 → 不发起请求，直接兜底', async () => {
    const h = harness({ seed: { [`${WATCH}\\扫描件002.pdf`]: 100 }, noProvider: true })
    await runToCompletion(h, {
      path: `${WATCH}\\扫描件002.pdf`,
      fileName: '扫描件002.pdf',
      ext: 'pdf',
      sizeBytes: 100,
    })
    expect(h.fs.files.has(`${WATCH}\\待分类\\扫描件002.pdf`)).toBe(true)
    expect(h.history.records[0]?.reason).toContain('未配置可用的 AI 模型')
    // 无模型时连内容提取都不该做（省时间）
    expect(h.extractCalls).toHaveLength(0)
  })

  it('提取降级告警被记入判定依据（可追溯）', async () => {
    const provider = scriptedProvider(['{"subject":"物理","confidence":0.9,"reason":"ok"}'])
    const h = harness({
      seed: { [`${WATCH}\\损坏的.pdf`]: 100 },
      provider,
      extractWarnings: ['解析失败，降级为文件名证据'],
    })
    await runToCompletion(h, {
      path: `${WATCH}\\损坏的.pdf`,
      fileName: '损坏的.pdf',
      ext: 'pdf',
      sizeBytes: 100,
    })
    expect(h.history.records[0]?.reason).toContain('提取降级')
  })
})

describe('ClassificationService · 边界与失败', () => {
  it('文件已不存在 → 记 skipped，不抛错', async () => {
    const h = harness({ seed: {} })
    await runToCompletion(h, {
      path: `${WATCH}\\gone.pdf`,
      fileName: 'gone.pdf',
      ext: 'pdf',
      sizeBytes: 100,
    })
    expect(h.events.at(-1)?.state).toBe('skipped')
    expect(h.history.records[0]?.reason).toContain('文件已不存在')
  })

  it('autoMove=false → 只记录流水，文件不移动', async () => {
    const h = harness({
      seed: { [`${WATCH}\\数学.pdf`]: 100 },
      settings: settingsWith({ autoMove: false }),
    })
    await runToCompletion(h, {
      path: `${WATCH}\\数学.pdf`,
      fileName: '数学.pdf',
      ext: 'pdf',
      sizeBytes: 100,
    })
    expect(h.fs.files.has(`${WATCH}\\数学.pdf`)).toBe(true)
    expect(h.history.records[0]?.movedTo).toBeUndefined()
    expect(h.history.records[0]?.reason).toContain('关闭自动移动')
  })

  it('管线未启用（非 classroom）→ 不入队', async () => {
    const settings = settingsWith({})
    settings.modes.current = 'work'
    const h = harness({ seed: { [`${WATCH}\\数学.pdf`]: 100 }, settings })
    expect(h.service.isActive).toBe(false)
    h.service.handleFile({
      path: `${WATCH}\\数学.pdf`,
      fileName: '数学.pdf',
      ext: 'pdf',
      sizeBytes: 100,
    })
    await h.service.drain()
    expect(h.events).toEqual([])
    expect(h.history.records).toEqual([])
  })

  it('感知文件夹未配置 → 不入队', async () => {
    const settings = settingsWith({})
    settings.modes.classroom.watchDir = ''
    const h = harness({ settings })
    expect(h.service.isActive).toBe(false)
  })

  it('reconfigure 可在补齐配置后重新启用（不被永久关闭）', () => {
    const settings = settingsWith({})
    settings.modes.classroom.watchDir = ''
    const h = harness({ settings })
    expect(h.service.reconfigure()).toBe(false)
    settings.modes.classroom.watchDir = WATCH
    expect(h.service.reconfigure()).toBe(true)
  })

  it('同目录重名文件自动加后缀，不覆盖已有文件', async () => {
    const h = harness({
      seed: {
        [`${WATCH}\\数学.pdf`]: 100,
        [`${WATCH}\\分类\\数学\\数学.pdf`]: 555,
      },
    })
    await runToCompletion(h, {
      path: `${WATCH}\\数学.pdf`,
      fileName: '数学.pdf',
      ext: 'pdf',
      sizeBytes: 100,
    })
    expect(h.fs.files.get(`${WATCH}\\分类\\数学\\数学.pdf`)).toBe(555)
    expect(h.fs.files.get(`${WATCH}\\分类\\数学\\数学 (1).pdf`)).toBe(100)
  })
})

describe('ClassificationService · 用户修正', () => {
  it('修正后文件移到新科目，并标记 corrected', async () => {
    const provider = scriptedProvider(['{"subject":"物理","confidence":0.2,"reason":"不确定"}'])
    const h = harness({ seed: { [`${WATCH}\\扫描件003.pdf`]: 100 }, provider })
    await runToCompletion(h, {
      path: `${WATCH}\\扫描件003.pdf`,
      fileName: '扫描件003.pdf',
      ext: 'pdf',
      sizeBytes: 100,
    })
    const recordId = h.history.records[0]!.id
    expect(h.fs.files.has(`${WATCH}\\待分类\\扫描件003.pdf`)).toBe(true)

    await h.service.correct(recordId, '数学')

    expect(h.fs.files.has(`${WATCH}\\分类\\数学\\扫描件003.pdf`)).toBe(true)
    expect(h.fs.files.has(`${WATCH}\\待分类\\扫描件003.pdf`)).toBe(false)
    const corrected = h.history.get(recordId)
    expect(corrected?.corrected).toBe(true)
    expect(corrected?.subject).toBe('数学')
    expect(corrected?.source).toBe('user')
    expect(corrected?.movedTo).toBe(`${WATCH}\\分类\\数学\\扫描件003.pdf`)
  })

  it('修正沉淀出规则：同名文件再次出现时跳过 LLM', async () => {
    const provider = scriptedProvider(['{"subject":"","confidence":0,"reason":"依据不足"}'])
    const h = harness({ seed: { [`${WATCH}\\周期性试卷.pdf`]: 100 }, provider })

    // 第一次：走 LLM，落入待分类
    await runToCompletion(h, {
      path: `${WATCH}\\周期性试卷.pdf`,
      fileName: '周期性试卷.pdf',
      ext: 'pdf',
      sizeBytes: 100,
    })
    expect(provider.calls).toBe(1)

    // 用户修正为物理
    await h.service.correct(h.history.records[0]!.id, '物理')

    // 第二次：同名文件再次出现，应当命中学习规则，不再调用 LLM
    h.fs.files.set(`${WATCH}\\周期性试卷.pdf`, 100)
    await runToCompletion(h, {
      path: `${WATCH}\\周期性试卷.pdf`,
      fileName: '周期性试卷.pdf',
      ext: 'pdf',
      sizeBytes: 100,
    })

    expect(provider.calls).toBe(1) // 没有新增调用
    expect(h.fs.files.has(`${WATCH}\\分类\\物理\\周期性试卷.pdf`)).toBe(true)
    expect(h.history.records[0]?.source).toBe('rule')
  })

  it('修正到不存在的科目 → 抛错（IPC 层转成结构化错误）', async () => {
    const h = harness({ seed: { [`${WATCH}\\数学.pdf`]: 100 } })
    await runToCompletion(h, {
      path: `${WATCH}\\数学.pdf`,
      fileName: '数学.pdf',
      ext: 'pdf',
      sizeBytes: 100,
    })
    await expect(h.service.correct(h.history.records[0]!.id, '不存在的科目')).rejects.toThrow(
      /未找到科目/,
    )
  })

  it('修正不存在的记录 → 抛错', async () => {
    const h = harness({})
    await expect(h.service.correct('ghost', '数学')).rejects.toThrow(/未找到分类记录/)
  })
})

describe('ClassificationService · 事件与状态', () => {
  /**
   * 回归：入队事件与最终事件必须共用**同一个 record.id**。
   * 渲染层按 id 归并进度；若两处各造一条记录，那条 queued 行永远收不到后续事件，
   * 会留下一条永久「排队中」的幽灵行并让"处理中"计数一直虚高。
   */
  it('同一次处理的所有事件共用同一个 recordId', async () => {
    const h = harness({ seed: { [`${WATCH}\\数学.pdf`]: 100 } })
    await runToCompletion(h, {
      path: `${WATCH}\\数学.pdf`,
      fileName: '数学.pdf',
      ext: 'pdf',
      sizeBytes: 100,
    })

    const ids = new Set(h.events.map((event) => event.recordId))
    expect(h.events.length).toBeGreaterThan(1)
    expect(ids.size).toBe(1)

    // 首个事件是 queued，末个是终态；id 相同才能原地刷新
    expect(h.events[0]?.state).toBe('queued')
    expect(h.events.at(-1)?.state).toBe('done')
    expect(h.events[0]?.recordId).toBe(h.events.at(-1)?.recordId)
  })

  it('queued 事件与流水里的记录 id 一致（不会多出一条孤儿记录）', async () => {
    const h = harness({ seed: { [`${WATCH}\\数学.pdf`]: 100 } })
    await runToCompletion(h, {
      path: `${WATCH}\\数学.pdf`,
      fileName: '数学.pdf',
      ext: 'pdf',
      sizeBytes: 100,
    })
    // 每个文件只应产生一条流水记录
    expect(h.history.records).toHaveLength(1)
    expect(h.history.records[0]?.id).toBe(h.events[0]?.recordId)
  })

  it('落盘后把目标路径交给抑制集（防文件系统把 rename 报成 add）', async () => {
    const h = harness({ seed: { [`${WATCH}\\数学.pdf`]: 100 } })
    await runToCompletion(h, {
      path: `${WATCH}\\数学.pdf`,
      fileName: '数学.pdf',
      ext: 'pdf',
      sizeBytes: 100,
    })
    expect(h.suppressed).toContain(`${WATCH}\\分类\\数学\\数学.pdf`)
  })
  it('recentEvents 有上限，保留最近的', async () => {
    const h = harness({ seed: { [`${WATCH}\\数学.pdf`]: 100 } })
    await runToCompletion(h, {
      path: `${WATCH}\\数学.pdf`,
      fileName: '数学.pdf',
      ext: 'pdf',
      sizeBytes: 100,
    })
    expect(h.service.recentEvents().length).toBeGreaterThan(0)
    expect(h.service.recentEvents().length).toBeLessThanOrEqual(30)
  })

  it('clear 清空流水与事件缓冲', async () => {
    const h = harness({ seed: { [`${WATCH}\\数学.pdf`]: 100 } })
    await runToCompletion(h, {
      path: `${WATCH}\\数学.pdf`,
      fileName: '数学.pdf',
      ext: 'pdf',
      sizeBytes: 100,
    })
    h.service.clear()
    expect(h.service.list()).toEqual([])
    expect(h.service.recentEvents()).toEqual([])
  })

  it('重复入队同一路径只处理一次（去重）', async () => {
    const provider = scriptedProvider(['{"subject":"物理","confidence":0.9,"reason":"ok"}'])
    const h = harness({ seed: { [`${WATCH}\\扫描件004.pdf`]: 100 }, provider })
    const file = {
      path: `${WATCH}\\扫描件004.pdf`,
      fileName: '扫描件004.pdf',
      ext: 'pdf',
      sizeBytes: 100,
    }
    h.service.handleFile(file)
    h.service.handleFile(file)
    await h.service.drain()
    expect(provider.calls).toBe(1)
  })
})
