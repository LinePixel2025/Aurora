/**
 * 分类流水状态（docs/05 §3.2 / §3.3）。
 *
 * 与主进程的契约：`classification:event` 实时推送 + `classification:state` / `classification:history`
 * 挂载水合。同一条记录（同一 `record.id`）会随处理阶段被推送多次
 * （queued → extracting → classifying → moving → done / fallback / error），
 * 因此这里按 id **归并**而不是追加：已有记录原地更新（列表里不跳位），
 * 新记录插到最前（与主进程「新的在前」的流水顺序一致）。
 *
 * 订阅在 composable 创建时建立、随作用域销毁自动解绑，与 `useChat` 的写法保持一致。
 * 只做类型导入：渲染层不引入 `@aurora/shared` 的运行时值。
 */
import { computed, onScopeDispose, ref } from 'vue'
import type {
  ClassificationEvent,
  ClassificationRecord,
  ClassificationSource,
  ClassificationState,
} from '@aurora/shared'

/** 列表一行：主进程流水 + 该记录最近一次事件的阶段与队列深度。 */
export interface ClassificationRow {
  id: string
  record: ClassificationRecord
  state: ClassificationState
  queueDepth: number
  running: number
  /** 本地最近一次更新时间（ms）；`occurredAt` 不可解析时用于排序 */
  updatedAt: number
}

const STATE_LABELS: Record<ClassificationState, string> = {
  queued: '排队中',
  extracting: '提取内容',
  classifying: '判定科目',
  moving: '移动文件',
  done: '已归类',
  fallback: '待分类',
  skipped: '已跳过',
  error: '失败',
}

const SOURCE_LABELS: Record<ClassificationSource, string> = {
  rule: '规则命中',
  llm: '模型判定',
  fallback: '兜底',
  user: '你修正的',
}

export function classificationStateLabel(state: ClassificationState): string {
  return STATE_LABELS[state]
}

export function classificationSourceLabel(source: ClassificationSource): string {
  return SOURCE_LABELS[source]
}

/** 在途阶段：文件还在管线里（用于禁用修正、统计「处理中」）。 */
export function isClassificationActive(state: ClassificationState): boolean {
  return (
    state === 'queued' || state === 'extracting' || state === 'classifying' || state === 'moving'
  )
}

/**
 * 从持久化记录推导阶段：历史流水只有结果，没有中间态。
 * `error` 优先（移动失败也会写 error），其次兜底（未判定出科目），其余为已归类。
 */
export function classificationStateFromRecord(record: ClassificationRecord): ClassificationState {
  if (record.error !== undefined && record.error !== '') return 'error'
  if (record.corrected === true) return 'done'
  if (record.source === 'fallback' || record.subject === '') return 'fallback'
  return 'done'
}

export interface UseClassificationOptions {
  /** 读取并保留的流水条数上限（新的在前）。 */
  limit?: number
}

export function useClassification(options: UseClassificationOptions = {}) {
  const limit = Math.max(1, options.limit ?? 50)
  const rows = ref<ClassificationRow[]>([])
  const queueDepth = ref(0)
  const running = ref(0)
  const loading = ref(false)
  const error = ref<string | null>(null)
  let hydrated = false

  /** 处理中的条数（事件阶段而非队列深度：与列表一一对应）。 */
  const activeCount = computed(
    () => rows.value.filter((row) => isClassificationActive(row.state)).length,
  )

  const dispose = window.aurora.classification.onEvent(applyEvent)
  onScopeDispose(dispose)

  function mergeRecord(
    previous: ClassificationRecord | undefined,
    next: ClassificationRecord,
  ): ClassificationRecord {
    return previous === undefined ? next : { ...previous, ...next }
  }

  /** 实时事件：同 id 原地更新，新 id 插到最前。 */
  function applyEvent(event: ClassificationEvent): void {
    const index = rows.value.findIndex((row) => row.id === event.record.id)
    const previous = index >= 0 ? rows.value[index] : undefined
    const row: ClassificationRow = {
      id: event.record.id,
      record: mergeRecord(previous?.record, event.record),
      state: event.state,
      queueDepth: event.queueDepth,
      running: event.running,
      updatedAt: Date.now(),
    }
    if (index >= 0) rows.value[index] = row
    else rows.value = [row, ...rows.value].slice(0, limit)
    queueDepth.value = event.queueDepth
    running.value = event.running
  }

  function rowFromRecord(record: ClassificationRecord): ClassificationRow {
    return {
      id: record.id,
      record,
      state: classificationStateFromRecord(record),
      queueDepth: 0,
      running: 0,
      updatedAt: Date.now(),
    }
  }

  /**
   * 用主进程返回的完整流水重建列表（`correct` 的回包）。
   * 在途阶段只在事件里出现，因此保留「处理中」的行，其余按记录重新推导阶段。
   */
  function applyRecords(records: ClassificationRecord[]): void {
    const previous = new Map(rows.value.map((row) => [row.id, row]))
    rows.value = records.slice(0, limit).map((record) => {
      const row = previous.get(record.id)
      if (row === undefined) return rowFromRecord(record)
      const state = isClassificationActive(row.state)
        ? row.state
        : classificationStateFromRecord(record)
      return {
        ...row,
        record: mergeRecord(row.record, record),
        state,
      }
    })
  }

  /** 挂载水合：先铺历史流水，再用在途事件覆盖（事件按时间顺序，最后一条即最新）。 */
  async function hydrate(): Promise<void> {
    if (hydrated) return
    hydrated = true
    loading.value = true
    const [stateResult, historyResult] = await Promise.all([
      window.aurora.classification.state(),
      window.aurora.classification.history(limit),
    ])
    loading.value = false

    if (historyResult.ok) {
      const base = historyResult.value.map(rowFromRecord)
      const index = new Map(base.map((row) => [row.id, row]))
      const events = stateResult.ok ? stateResult.value : []
      for (const event of events) {
        const row = index.get(event.record.id)
        if (row === undefined) {
          const created: ClassificationRow = {
            id: event.record.id,
            record: event.record,
            state: event.state,
            queueDepth: event.queueDepth,
            running: event.running,
            updatedAt: Date.now(),
          }
          index.set(created.id, created)
          base.unshift(created)
        } else {
          row.record = mergeRecord(row.record, event.record)
          row.state = event.state
          row.queueDepth = event.queueDepth
          row.running = event.running
        }
      }
      // 读取期间可能已经收到实时推送：并进结果，避免被水合结果覆盖
      const known = new Set(base.map((row) => row.id))
      const live = rows.value.filter((row) => !known.has(row.id))
      for (const row of [...live].reverse()) base.unshift(row)
      rows.value = base.slice(0, limit)

      const latest = events[events.length - 1]
      queueDepth.value = latest?.queueDepth ?? 0
      running.value = latest?.running ?? 0
    } else {
      error.value = historyResult.message
    }
    if (!stateResult.ok && error.value === null) error.value = stateResult.message
  }

  /** 就地修正科目（docs/05 §3.2：主进程同步沉淀规则并返回更新后的流水）。 */
  async function correct(recordId: string, subject: string): Promise<boolean> {
    error.value = null
    const result = await window.aurora.classification.correct({ recordId, subject })
    if (!result.ok) {
      error.value = result.message
      return false
    }
    applyRecords(result.value)
    return true
  }

  async function clear(): Promise<boolean> {
    error.value = null
    const result = await window.aurora.classification.clear()
    if (!result.ok) {
      error.value = result.message
      return false
    }
    rows.value = []
    queueDepth.value = 0
    running.value = 0
    return true
  }

  /**
   * 打开该记录所在文件夹：科目已判定 → 科目目录，否则退化到感知文件夹
   * （docs/05 §3.3 的通知点击行为一致）。科目被改名 / 删除时同样退化。
   */
  async function openFolder(record: ClassificationRecord): Promise<boolean> {
    error.value = null
    if (record.subject !== '') {
      const result = await window.aurora.app.openPath({ kind: 'subject', subject: record.subject })
      if (result.ok) return true
    }
    const fallback = await window.aurora.app.openPath({ kind: 'watchDir' })
    if (!fallback.ok) {
      error.value = fallback.message
      return false
    }
    return true
  }

  return {
    rows,
    queueDepth,
    running,
    loading,
    error,
    activeCount,
    hydrate,
    correct,
    clear,
    openFolder,
  }
}
