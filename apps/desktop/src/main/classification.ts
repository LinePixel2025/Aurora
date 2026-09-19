/**
 * 分类管线装配（docs/05 §3.2、docs/02 §5.2）。
 *
 * 数据流：
 * ```
 * chokidar add → 稳定判定 → 队列（并发 2）→ 规则命中？
 *    ├─ 是 → 目标目录 → 移动 + 分类流水 + 通知
 *    └─ 否 → utilityProcess 内容提取 → LLM 结构化分类 → 阈值判定
 *             ├─ subject 非空且 confidence ≥ 阈值 → 目标目录 → 移动 + 流水 + 通知
 *             └─ 否则 → 「待分类」兜底 + 流水 + 通知
 * ```
 *
 * 设计原则：
 * - 所有外部能力（提取、LLM、文件系统、通知、历史）一律注入 → 可在单测里跑完整链路；
 * - 任何单点失败（提取超时、模型不可用、移动失败）都**不抛出**，而是落成一条带 `error`
 *   或 `fallback` 的流水，保证「一次拖入的文件一定有交代」。
 */
import type {
  ClassificationEvent,
  ClassificationRecord,
  ClassificationState,
  Logger,
  Settings,
} from '@aurora/shared'
import { ClassificationQueue, type QueueJob, type QueueProgress } from './classify/queue.js'
import { moveInto, type ClassifyFs } from './classify/paths.js'
import { learnRules, matchRules, type RuleVerdict } from './classify/rules.js'
import { classifyWithLlm, type ClassifyProvider } from './classify/llm.js'
import { resolveSubjectFolder } from './paths.js'
import type { ExtractPoolResult } from './extract-pool.js'

/** 每次请求即时构造 provider（设置页改 Key 后立即生效，与 Agent 内核一致） */
export interface ClassifyProviderFactory {
  create(): { provider: ClassifyProvider; model: string } | undefined
}

export interface ClassificationServiceDeps {
  getSettings(): Settings
  extract(input: { path: string; ext: string; sizeBytes: number }): Promise<ExtractPoolResult>
  providerFactory: ClassifyProviderFactory
  history: {
    append(record: ClassificationRecord): void
    update(id: string, patch: Partial<ClassificationRecord>): ClassificationRecord | undefined
    get(id: string): ClassificationRecord | undefined
    list(): ClassificationRecord[]
    corrected(): ClassificationRecord[]
    clear(): void
    flush(): Promise<void>
  }
  notifications: {
    notifyClassified(input: { fileName: string; subject: string; targetDir: string }): boolean
    notifyFallback(input: { fileName: string; reason: string; targetDir: string }): boolean
  }
  fs: ClassifyFs
  logger: Logger
  /**
   * 把「由本管线造成变动的路径」通知文件监听器，使其忽略随后的 add 事件。
   *
   * 正常情况下 `depth: 0` 已经足够（移动到子目录不会触发 add），
   * 但在「目标目录落到感知文件夹根」这类边界（见 `resolvesToWatchRoot`）以及
   * 某些文件系统的事件时序下仍会出现 add，这个抑制集是第二道保险。
   */
  suppressPath?: (path: string) => void
  /** 可注入以便测试得到确定 id / 时间戳 */
  now?: () => Date
  nextId?: () => string
  concurrency?: number
  /** 保留的「最近事件」条数，供渲染层挂载时水合 */
  eventBufferSize?: number
}

/** 单文件一次处理所需的运行期配置快照 */
interface RuntimeConfig {
  watchDir: string
  subjects: Settings['modes']['classroom']['subjects']
  classification: Settings['modes']['classroom']['classification']
}

export const DEFAULT_EVENT_BUFFER = 30

/**
 * 文件去重签名：`(路径, 大小, 修改时间)`（docs/05 §3.2）。
 *
 * 导出的理由：单测与「为什么这个文件被跳过」的排查都要用同一个算法，
 * 各写一份迟早会漂移。
 */
export function fileSignature(file: { path: string; sizeBytes: number; mtimeMs: number }): string {
  return `${file.path}|${file.sizeBytes}|${file.mtimeMs}`
}

export class ClassificationService {
  private readonly deps: ClassificationServiceDeps
  private readonly logger: Logger
  private readonly queue: ClassificationQueue
  private readonly listeners = new Set<(event: ClassificationEvent) => void>()
  private readonly events: ClassificationEvent[] = []
  private readonly eventBufferSize: number
  private readonly now: () => Date
  private counter = 0
  /** 当前是否处于「ClassRoom 激活 + 已配置感知文件夹」的可工作状态 */
  private active = false

  constructor(deps: ClassificationServiceDeps) {
    this.deps = deps
    this.logger = deps.logger
    this.now = deps.now ?? (() => new Date())
    this.eventBufferSize = deps.eventBufferSize ?? DEFAULT_EVENT_BUFFER
    this.queue = new ClassificationQueue({
      handler: (job, report) => this.process(job, report),
      ...(deps.concurrency === undefined ? {} : { concurrency: deps.concurrency }),
      logger: deps.logger,
    })
    this.queue.onEvent((event) => this.emit(event))
  }

  /**
   * 与当前配置对齐：报告当前是否处于可工作状态。
   *
   * 队列**不在这里销毁**——`dispose()` 是不可逆的，一旦按"未就绪"销毁，
   * 用户回头补上感知文件夹就再也不会入队了。真正的停止由调用方
   * （`index.ts` 的 `syncClassification`）通过停掉文件监听来实现，
   * 没有事件进来队列自然空转。
   */
  reconfigure(): boolean {
    const settings = this.deps.getSettings()
    const classroom = settings.modes.classroom
    const canWork = settings.modes.current === 'classroom' && classroom.watchDir.trim() !== ''
    if (canWork !== this.active) {
      this.active = canWork
      this.logger.info(canWork ? '分类管线已启用' : '分类管线已停用', {
        mode: settings.modes.current,
        watchDir: classroom.watchDir,
      })
    }
    return canWork
  }

  get isActive(): boolean {
    return this.active
  }

  /** 感知文件夹出现新稳定文件时调用（由 `FileWatcher` 转发）。 */
  handleFile(file: {
    path: string
    fileName: string
    ext: string
    sizeBytes: number
    /** 源文件修改时间（毫秒）；缺省表示未知，此时不参与去重（退化为旧行为） */
    mtimeMs?: number
  }): void {
    if (!this.active) {
      this.logger.debug('分类管线未启用，忽略文件', { path: file.path })
      return
    }

    // 去重（docs/05 §3.2）：文件**没被移动**时（`autoMove=false` / 移动失败 / 处理失败），
    // 它会留在感知文件夹里，而 chokidar 的 `ignoreInitial: false` 每次启动都会再次
    // 报出同一个文件 —— 不去重就会反复记流水、反复弹通知。
    // 已移动成功的文件天然不会再来（目录都换了），因此只需比对"未移动"的历史记录。
    const duplicate = this.findProcessed({
      path: file.path,
      sizeBytes: file.sizeBytes,
      mtimeMs: file.mtimeMs,
    })
    if (duplicate !== undefined) {
      this.logger.debug('该文件已处理过且未被移动，跳过重复处理', {
        path: file.path,
        recordId: duplicate.id,
      })
      this.emit({
        record: duplicate,
        state: 'skipped',
        queueDepth: this.queue.depth,
        running: this.queue.running,
      })
      return
    }

    // 记录在**入队时**就生成，并随 job 一路带到最终事件：
    // 渲染层按 record.id 归并进度，若入队与处理各造一条记录，
    // 那条 queued 行会永远停在「排队中」（幽灵行）。
    const record = this.makeRecord(file, {
      subject: '',
      confidence: 0,
      reason: '排队中',
      source: 'rule',
    })
    const accepted = this.queue.enqueue({ ...file, record })
    if (!accepted) return
    this.emit({
      record,
      state: 'queued',
      queueDepth: this.queue.depth,
      running: this.queue.running,
    })
  }

  /**
   * 找出「同一文件已被处理、且当时没有移动它」的历史记录。
   *
   * 签名 = `(路径, 大小, 修改时间)`：比只看路径可靠（用户替换同名文件能识别出来），
   * 也比只看路径+大小可靠（改内容但大小不变的文件能识别出来）。
   * 只在 `movedTo` 缺失时才算命中：已移动的记录意味着文件已不在原处，
   * 此时原路径再出现同名同大小的文件属于**用户主动放回来的新文件**，必须重新处理。
   */
  private findProcessed(file: {
    path: string
    sizeBytes: number
    mtimeMs: number | undefined
  }): ClassificationRecord | undefined {
    // mtime 未知时不参与去重：宁可重复处理一次，也不要把用户的文件误判成"已处理"
    if (file.mtimeMs === undefined || !Number.isFinite(file.mtimeMs) || file.mtimeMs <= 0) {
      return undefined
    }
    const signature = fileSignature({ ...file, mtimeMs: file.mtimeMs })
    return this.deps.history.list().find(
      (record) =>
        record.movedTo === undefined &&
        record.modifiedAt !== undefined &&
        fileSignature({
          path: record.path,
          sizeBytes: record.sizeBytes,
          mtimeMs: Date.parse(record.modifiedAt),
        }) === signature,
    )
  }

  /** 用户就地修正分类结果（docs/05 §3.3）：移动文件 + 沉淀规则。 */
  async correct(recordId: string, subject: string): Promise<ClassificationRecord[]> {
    const record = this.deps.history.get(recordId)
    if (record === undefined) throw new Error(`未找到分类记录：${recordId}`)

    const config = this.runtime()
    const target = config.subjects.find((item) => item.name === subject)
    if (target === undefined) throw new Error(`未找到科目：${subject}`)

    const targetDir = resolveSubjectFolder(config.watchDir, target.folder)
    const sourcePath = record.movedTo ?? record.path
    const outcome = await moveInto({
      fs: this.deps.fs,
      sourcePath,
      targetDir,
      fileName: record.fileName,
      autoMove: config.classification.autoMove,
      watchDir: config.watchDir,
    })

    if (!outcome.ok) {
      this.logger.warn('修正分类时移动失败', { recordId, error: outcome.error ?? '' })
    }
    if (outcome.moved) this.deps.suppressPath?.(outcome.targetPath)

    const updated = this.deps.history.update(recordId, {
      subject,
      confidence: 1,
      reason: '你手动修正的科目（已记为规则）',
      source: 'user',
      corrected: true,
      ...(outcome.moved ? { movedTo: outcome.targetPath } : {}),
    })

    this.emit({
      record: updated ?? record,
      state: outcome.ok ? 'done' : 'error',
      queueDepth: this.queue.depth,
      running: this.queue.running,
    })
    return this.deps.history.list()
  }

  /** 清空分类流水。 */
  clear(): void {
    this.events.length = 0
    this.deps.history.clear()
  }

  list(): ClassificationRecord[] {
    return this.deps.history.list()
  }

  /** 最近事件（挂载水合）。 */
  recentEvents(): ClassificationEvent[] {
    return [...this.events]
  }

  onEvent(listener: (event: ClassificationEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 等待在途任务清空（退出与测试用）。 */
  async drain(): Promise<void> {
    await this.queue.drain()
  }

  /** 退出：排空队列并落盘流水。 */
  async close(): Promise<void> {
    this.queue.dispose()
    await this.deps.history.flush().catch(() => undefined)
  }

  // ───────────────────────── 单文件处理 ─────────────────────────

  private async process(
    job: QueueJob,
    report: (progress: QueueProgress) => void,
  ): Promise<QueueProgress> {
    const config = this.runtime()
    // 每次处理都用**最新**配置：处理期间用户可能改了科目列表
    // 记录复用入队时生成的那条（id 一致），保证渲染层能原地把「排队中」刷新成终态。
    let record =
      job.record ??
      this.makeRecord(job, {
        subject: '',
        confidence: 0,
        reason: '处理中',
        source: 'rule',
      })

    // 0. 源文件是否还在（用户可能已手动移走 / 删除）
    if ((await this.deps.fs.sizeOf(job.path)) === undefined) {
      record = { ...record, reason: '文件已不存在，跳过' }
      this.deps.history.append(record)
      return this.finalize(record, 'skipped', report)
    }

    // 1. 规则优先：命中即跳过 LLM，省 token 提速（docs/05 §3.2 ④）
    const verdict = matchRules({
      fileName: job.fileName,
      subjects: config.subjects,
      learned: learnRules(this.deps.history.corrected()),
    })
    if (verdict !== undefined && verdict.subject !== '') {
      this.logger.info('规则命中，跳过模型分类', {
        fileName: job.fileName,
        subject: verdict.subject,
      })
      return this.land({ job, record, verdict, config, report })
    }

    // 1.1 走到模型这一步前再确认一次文件仍在原处。
    // 为什么需要：用户在设置页/流水里**修正**分类时会把文件移到新科目目录，
    // 此时在途任务再去读它会失败，最终被记成一条"未能确定科目"的兜底记录——
    // 那是**误导**（文件已按用户意愿归类），因此这里按 skipped 记流水。
    if ((await this.deps.fs.sizeOf(job.path)) === undefined) {
      this.logger.info('文件在处理期间已被移动或删除，按跳过处理', { path: job.path })
      record = { ...record, reason: '文件在处理期间已被移动或删除，已跳过' }
      this.deps.history.append(record)
      return this.finalize(record, 'skipped', report)
    }

    // 2. 没有可用模型就**不要**去解析文件：解析一个几十 MB 的 PDF 只为发现
    //    "无法判定"是纯浪费（对齐 `E_NO_MODEL` 的失败降级语义）。
    const built = this.deps.providerFactory.create()
    if (built === undefined) {
      record = { ...record, reason: '未配置可用的 AI 模型，无法判定科目' }
      return this.land({
        job,
        record,
        verdict: {
          subject: '',
          confidence: 0,
          reason: record.reason,
          source: 'fallback',
          matched: '',
        },
        config,
        report,
      })
    }

    // 3. 内容提取（utilityProcess，失败自动降级为文件名证据）
    record = { ...record, reason: '正在读取内容' }
    report({ record, state: 'extracting' })

    const extracted = await this.deps.extract({
      path: job.path,
      ext: job.ext,
      sizeBytes: job.sizeBytes,
    })

    // 4. 模型结构化分类
    record = { ...record, reason: '正在判定科目' }
    report({ record, state: 'classifying' })

    const llm = await classifyWithLlm(
      {
        fileName: job.fileName,
        evidence: extracted.evidence,
        subjects: config.subjects,
        examples: this.deps.history
          .corrected()
          .slice(0, 5)
          .map((item) => ({ fileName: item.fileName, subject: item.subject })),
      },
      { provider: built.provider, model: built.model, signal: undefined, logger: this.logger },
    )

    const threshold = config.classification.confidenceThreshold
    const accepted = llm.subject !== '' && llm.confidence >= threshold
    const reasonParts = [llm.reason]
    if (llm.subject !== '' && !accepted) {
      reasonParts.push(`置信度 ${llm.confidence.toFixed(2)} 低于阈值 ${threshold}`)
    }
    for (const warning of extracted.warnings) reasonParts.push(`提取降级：${warning}`)

    return this.land({
      job,
      record,
      verdict: {
        subject: accepted ? llm.subject : '',
        confidence: llm.confidence,
        reason: reasonParts.join('；'),
        source: accepted ? 'llm' : 'fallback',
        matched: '',
      },
      config,
      report,
    })
  }

  /** 判定完成 → 落盘 + 记录 + 通知。 */
  private async land(input: {
    job: QueueJob
    record: ClassificationRecord
    verdict: RuleVerdict
    config: RuntimeConfig
    report: (progress: QueueProgress) => void
  }): Promise<QueueProgress> {
    const { job, verdict, config } = input
    const threshold = config.classification.confidenceThreshold

    // 决定目标目录：判定成功 → 科目目录；否则 → 待分类兜底
    const decided =
      verdict.subject !== '' && verdict.confidence >= threshold
        ? config.subjects.find((item) => item.name === verdict.subject)
        : undefined

    const isFallback = decided === undefined
    const folder = decided?.folder ?? config.classification.fallbackFolder
    const targetDir = resolveSubjectFolder(config.watchDir, folder)

    let record: ClassificationRecord = {
      ...input.record,
      subject: decided?.name ?? '',
      confidence: verdict.confidence,
      reason: verdict.reason,
      source: isFallback ? 'fallback' : verdict.source,
    }

    this.deps.history.append(record)
    input.report({ record, state: 'moving' })

    const outcome = await moveInto({
      fs: this.deps.fs,
      sourcePath: job.path,
      targetDir,
      fileName: job.fileName,
      autoMove: config.classification.autoMove,
      watchDir: config.watchDir,
    })

    // 去重签名只在**文件留在原处**时写（autoMove 关闭 / 移动失败）：
    // 此时 chokidar 的 `ignoreInitial: false` 下次启动会再报一次同一个文件，
    // 靠签名跳过重复的流水与通知（见 `findProcessed`）。
    // 移动成功则**不写** —— 文件已不在原处，原路径再出现同名文件属于用户放回来的新文件，
    // 必须重新分类。
    // 位置也重要：必须等 moveInto 之后才决定，因为"移动失败"只有跑完才知道。
    if (!outcome.moved) record = { ...record, ...this.modifiedAtOf(job) }

    const state: ClassificationState = outcome.ok ? (isFallback ? 'fallback' : 'done') : 'error'
    // 落盘后抑制目标路径：避免文件系统把 rename 报成 add 时被当成新文件重复分类
    if (outcome.moved) this.deps.suppressPath?.(outcome.targetPath)
    const notes: string[] = []
    if (outcome.warnings.length > 0) notes.push(...outcome.warnings)
    if (!outcome.ok && outcome.error !== undefined) notes.push(outcome.error)
    if (!config.classification.autoMove) notes.push('已按设置关闭自动移动，仅记录流水')

    record = {
      ...record,
      ...(outcome.moved ? { movedTo: outcome.targetPath } : {}),
      ...(notes.length === 0 ? {} : { reason: `${record.reason}；${notes.join('；')}` }),
      ...(outcome.ok ? {} : { error: outcome.error ?? '移动失败' }),
    }
    this.deps.history.update(record.id, record)

    // 通知：成功 → 分类完成；兜底 / 失败 → 请用户确认
    try {
      if (outcome.ok && !isFallback) {
        this.deps.notifications.notifyClassified({
          fileName: job.fileName,
          subject: record.subject,
          targetDir,
        })
      } else {
        this.deps.notifications.notifyFallback({
          fileName: job.fileName,
          reason: record.reason,
          targetDir,
        })
      }
    } catch (error) {
      this.logger.warn('分类通知失败（不影响分类结果）', { error: String(error) })
    }

    return this.finalize(record, state, input.report)
  }

  private finalize(
    record: ClassificationRecord,
    state: ClassificationState,
    report: (progress: QueueProgress) => void,
  ): QueueProgress {
    const progress: QueueProgress = { record, state }
    report(progress)
    return progress
  }

  private makeRecord(
    job: QueueJob,
    verdict: {
      subject: string
      confidence: number
      reason: string
      source: ClassificationRecord['source']
    },
  ): ClassificationRecord {
    return {
      id: this.deps.nextId?.() ?? `cls-${Date.now()}-${++this.counter}`,
      occurredAt: this.now().toISOString(),
      path: job.path,
      fileName: job.fileName,
      ext: job.ext,
      sizeBytes: job.sizeBytes,
      subject: verdict.subject,
      confidence: verdict.confidence,
      reason: verdict.reason,
      source: verdict.source,
      // 注意：**不在这里**写 `modifiedAt`。
      // 该字段是"这个文件已处理过"的去重签名（见 `findProcessed`），
      // 只有**判定真正完成且文件留在原处**时才有意义 —— 由 `land()` 在移动结束后补写。
      // 若在入队时就写，那么"文件在处理期间被移走 → skipped"这类审计记录
      // 也会带上签名，用户把同名文件重新放回来时就会被误判为"已处理"而永不重新分类。
    }
  }

  /**
   * 源文件修改时间的去重签名字段（docs/05 §3.2）。
   *
   * 非法 / 缺失时间返回空对象：宁可不去重（重复处理一次），
   * 也不要把用户的文件误判成"已处理"而永不分类。
   */
  private modifiedAtOf(job: QueueJob): { modifiedAt?: string } {
    const mtime = job.mtimeMs
    if (mtime === undefined || !Number.isFinite(mtime) || mtime <= 0) return {}
    return { modifiedAt: new Date(mtime).toISOString() }
  }

  private runtime(): RuntimeConfig {
    const classroom = this.deps.getSettings().modes.classroom
    return {
      watchDir: classroom.watchDir,
      subjects: classroom.subjects,
      classification: classroom.classification,
    }
  }

  private emit(event: ClassificationEvent): void {
    this.events.push(event)
    if (this.events.length > this.eventBufferSize) {
      this.events.splice(0, this.events.length - this.eventBufferSize)
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        this.logger.warn('分类事件监听器抛错', { error: String(error) })
      }
    }
  }
}
