/**
 * 文件备份（写前快照）状态：docs/06 §11.8、docs/07 §2.3。
 *
 * 定位：**每会话一份缓存 + 手动刷新**的轻量实现，**不是全局 store** ——
 * 目前只有主界面右栏的「文件备份」卡用它（挂载时取一次、回滚成功后再取一次）。
 * 因此刻意不引入 Pinia、也不订阅任何推送通道：主进程没有"快照变更"事件，
 * 列表天然只能在手动刷新时更新（挂载 / 回滚后 / 用户点刷新）。
 *
 * 会话过滤：调用方可以传 `sessionId` 只看某个会话；**不传 = 全部会话的最近若干条**。
 * 主界面右栏目前拿不到"当前会话 id"：`chat/App.vue` 里它是 `useChat()` 内部的 ref，
 * 既没有 store、也没有经 props 传进 ContextPanel（右栏的 props 只有 `todos`）。
 * 宁可不过滤，也不用"最近更新的那条会话"冒充当前会话（那会让人以为备份是别的会话的）。
 *
 * 跨 IPC 只传字面量：三个方法的入参都在这里现构成纯对象，绝不把 `items` 里的对象
 * （Vue 响应式代理）回传 —— `ipcRenderer.invoke` 用结构化克隆，Proxy 会抛
 * `DataCloneError`（见 AGENTS.md 的踩坑清单，`settings:update` / `chat:send` 都踩过）。
 */
import { ref, type Ref } from 'vue'
import type { SnapshotRef } from '@aurora/shared'

/** 右栏卡片只展示最近 5 条；也是 `list` 的缺省条数 */
const DEFAULT_LIMIT = 5

export interface SnapshotsOptions {
  /** 只看这个会话的快照；不传（或空串）= 全部会话的最近若干条 */
  sessionId?: string
  /** 拉取条数上限（缺省 5） */
  limit?: number
}

export interface UseSnapshots {
  /** 最近一次 `refresh()` 的结果（失败时保留旧列表，不置空） */
  items: Ref<SnapshotRef[]>
  loading: Ref<boolean>
  error: Ref<string | null>
  /** 按当前会话 + 条数重新拉取；失败只写 `error`，旧列表照旧显示 */
  refresh: () => Promise<void>
  /** 回滚到某一份快照；成功后自动 `refresh()`（列表里会多出一条 `origin: 'rollback'`） */
  restore: (id: string) => Promise<boolean>
  /** 立即清理（主进程按保留份数与总预算做一次淘汰）；返回删除条数，失败 / 无法执行返回 0 */
  prune: () => Promise<number>
}

/**
 * 模块级状态（同一窗口内的多处调用共享同一份列表）。
 * 本窗只有右栏一处消费，所以不做按会话分桶的多份缓存 —— 需要时再升级成 Map。
 */
const items = ref<SnapshotRef[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

/** 最近一次 `useSnapshots()` 传入的查询条件；`refresh` / `prune` 复用它 */
let query: { sessionId?: string; limit: number } = { limit: DEFAULT_LIMIT }

export function useSnapshots(options: SnapshotsOptions = {}): UseSnapshots {
  const sessionId = options.sessionId
  query = {
    ...(sessionId === undefined || sessionId === '' ? {} : { sessionId }),
    limit: Math.max(1, options.limit ?? DEFAULT_LIMIT),
  }

  /** 拉取最近若干条快照：失败时**保留旧列表**，只把 `result.message` 写进 `error` */
  async function refresh(): Promise<void> {
    loading.value = true
    // 只传字面量：`undefined` 的 sessionId 不进请求体（后端据此返回全部会话的最近若干条）
    const request =
      query.sessionId === undefined
        ? { limit: query.limit }
        : { sessionId: query.sessionId, limit: query.limit }
    try {
      const result = await window.aurora.snapshots.list(request)
      if (result.ok) {
        items.value = result.value
        error.value = null
      } else {
        // 旧列表刻意留着：一次读取失败不该把界面上已经看到的条目抹掉
        error.value = result.message
      }
    } catch (cause) {
      // invoke 本身也可能抛（序列化失败等），与 `chat:send` 同款兜底，不让它冒到组件外
      error.value = String(cause)
    } finally {
      loading.value = false
    }
  }

  /** 回滚：成功后重新拉取（回滚本身也会在主进程里留一份 `origin: 'rollback'` 的快照） */
  async function restore(id: string): Promise<boolean> {
    error.value = null
    try {
      const result = await window.aurora.snapshots.restore({ snapshotId: id })
      if (!result.ok) {
        error.value = result.message
        return false
      }
    } catch (cause) {
      error.value = String(cause)
      return false
    }
    await refresh()
    return true
  }

  /** 立即清理：`prune` 的契约要求 `sessionId`，不知道会话时**什么都不做**（宁可不动也不误删） */
  async function prune(): Promise<number> {
    const sessionId = query.sessionId
    if (sessionId === undefined) {
      error.value = '无法清理：还不知道要清理哪个会话的备份'
      return 0
    }
    error.value = null
    try {
      const result = await window.aurora.snapshots.prune({ sessionId })
      if (!result.ok) {
        error.value = result.message
        return 0
      }
      await refresh()
      return result.value
    } catch (cause) {
      error.value = String(cause)
      return 0
    }
  }

  return { items, loading, error, refresh, restore, prune }
}
