/**
 * Job（任务）类型与纯函数（docs/06 §4.1）。
 *
 * `Job` 是「一条用户请求在 Agent 循环里的完整生命周期记录」：
 * 跨重启可恢复的进度账本（轮次 / 已完成的工具步 / 用量 / 待办快照 / 游标），
 * 落盘布局与读写实现见 `store.ts`。本文件只放形状与纯映射，保持可独立单测。
 *
 * 几个刻意区分开的字段：
 * - `todos` 是 `todo_write` 清单的**快照**（不同一份数据，见 docs/06 §18）：
 *   清单工具写的是会话级清单文件，这里只是画时间线用的一份拷贝，两边不互相回写。
 * - `budget` v34 起只有 `usedTokens`（累计用量，只统计不限制）—— 预算上限与自动续轮额度
 *   随那两个概念一起退役，留着一个永远等于 0 的字段就是下一个"能写不生效"的死口子。
 * - `cursor.nextRound` 是续跑的落点：恢复时从这一轮继续，而不是从头再来。
 */

/** 落盘文件形状版本（独立于 SESSION_FILE_VERSION，读侧宽容） */
export const JOBS_FILE_VERSION = 1

/**
 * `stepsDone` 的保留条数（docs/06 §4.1）。
 *
 * 每一步都要落盘、而落盘是**整表重写**（`{ jobs: [...] }` 一次序列化），
 * 无上限会让一个长任务的 job 文件随轮次二次方地膨胀，最后一轮的写盘比第一轮贵几十倍。
 * 超限时**丢最早的**、保住最近的：时间线要回答的是"它刚刚在干什么"，
 * 第 1 轮到第 100 轮的逐条流水对排障没有意义，`round` / `budget.usedTokens` 才是进度真相。
 */
export const MAX_JOB_STEPS = 200

// 形状的**唯一定义在 `@aurora/shared`**（渲染层要经 IPC 读它、`AgentEvent` 也带它）；
// 这里只再导出，避免"界面看到的 job"和"内核写的 job"变成两个会漂移的类型。
export type {
  AgentJob,
  AgentJobStatus,
  JobPendingReason,
  JobStep,
  JobSummary,
} from '@aurora/shared'
import type { AgentJob, JobStep, JobSummary } from '@aurora/shared'

/**
 * job 里的待办快照条目（`todo_write` 清单的一份拷贝）。
 *
 * 类型名与 `AgentJob['todos']` 的元素保持一致：清单工具写的是**会话级清单文件**，
 * 这里只是画时间线用的一份拷贝，两边不互相回写（docs/06 §18）。
 */
export type JobTodoSnapshot = AgentJob['todos'][number]

/** 建 job 的入参 */
export interface CreateJobInput {
  sessionId: string
  text: string
  origin: AgentJob['origin']
  /** 本次请求实际生效的轮次上限（v34 起来自内核常量，不再是设置项） */
  maxRounds: number
  requestId?: string
  /** 缺省由本函数生成（保留给"从磁盘恢复后重建"这类场景） */
  id?: string
  createdAt?: string
}

export interface CreateJobOptions {
  /** 时钟注入（单测造确定性时间戳；缺省 `new Date()`） */
  clock?: () => Date
}

/** 模块级计数器：同一毫秒（甚至同一固定注入时钟）里连建多条也不会撞 id */
let jobCounter = 0

export function createJob(input: CreateJobInput, options: CreateJobOptions = {}): AgentJob {
  const clock = options.clock ?? ((): Date => new Date())
  const now = clock()
  const at = now.toISOString()
  jobCounter += 1
  return {
    // 计数器是模块级的：同一毫秒（甚至同一固定注入时钟）里连建多条也不会重 id
    id: input.id ?? `job-${now.getTime().toString(36)}-${jobCounter}`,
    sessionId: input.sessionId,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    status: 'running',
    origin: input.origin,
    text: input.text,
    round: 0,
    maxRounds: input.maxRounds,
    stepsDone: [],
    todos: [],
    cursor: { nextRound: 0 },
    budget: { usedTokens: 0 },
    createdAt: input.createdAt ?? at,
    updatedAt: at,
  }
}

/** AgentJob → JobSummary（界面与事件统一走它，避免两处各写一份字段映射） */
export function toJobSummary(job: AgentJob): JobSummary {
  const last = job.stepsDone[job.stepsDone.length - 1]
  return {
    id: job.id,
    sessionId: job.sessionId,
    status: job.status,
    round: job.round,
    maxRounds: job.maxRounds,
    usedTokens: job.budget.usedTokens,
    ...(job.pendingReason === undefined ? {} : { pendingReason: job.pendingReason }),
    stepCount: job.stepsDone.length,
    ...(last === undefined ? {} : { lastStep: formatStep(last) }),
    updatedAt: job.updatedAt,
    ...(job.error === undefined ? {} : { error: job.error }),
  }
}

/** 最近一步的一行摘要（`read_file ✓` / `run_command ✗`） */
function formatStep(step: JobStep): string {
  return `${step.tool} ${step.ok ? '✓' : '✗'}`
}
