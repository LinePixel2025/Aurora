/**
 * 写前快照的端口与数据形状（docs/06 §11.8，v14）。
 *
 * 本文件**只定义契约**：不 import electron、不 import node:fs ——
 * 内核保持纯 Node 可单测，真实落盘由主进程注入（`createFileSnapshotPort`）。
 *
 * 为什么要有它：`write_file` / `edit_file` 会直接改写用户的文件，而模型改错一次就可能不可逆。
 * 快照是"改前留底"，让用户在界面上把某个文件回到某一份快照；**回滚本身也先打一份快照**，
 * 所以回滚同样是可撤回的。
 *
 * ⚠️ `SnapshotRef` 的**唯一定义在 `@aurora/shared`**（它跨 IPC 序列化，渲染层要用同一个形状），
 * 这里只做再导出 —— 两处各写一份迟早会漂移（界面显示的快照与内核写下的不是同一个东西）。
 */
import type { SnapshotRef } from '@aurora/shared'

export type { SnapshotRef }

/** 捕获时跳过（未产生快照）的原因；调用方必须把它回带进工具结果，**不许静默** */
export type SnapshotSkipReason = 'too-large' | 'disabled' | 'unreadable'

export interface SnapshotCaptureInput {
  sessionId: string
  path: string
  toolCallId?: string
  origin: SnapshotRef['origin']
  mode?: 'overwrite' | 'append'
  /**
   * 已读取的二进制原内容。Office 工具已在 worker 前读过源文件，
   * 这份字节让快照层不必再做一次 UTF-8 往返；缺省时仍按文本路径读取。
   */
  bytes?: Uint8Array
}

export interface SnapshotCaptureResult {
  snapshot?: SnapshotRef
  skipped?: SnapshotSkipReason
}

export interface SnapshotListQuery {
  sessionId?: string
  /** 只看某个文件的快照（绝对路径） */
  path?: string
  limit?: number
}

export interface SnapshotPort {
  /** 把**磁盘上的当前内容**存成一份快照（写盘之前调用） */
  capture(input: SnapshotCaptureInput): Promise<SnapshotCaptureResult>
  list(query: SnapshotListQuery): Promise<SnapshotRef[]>
  /** 读回快照内容（`exists: false` 的快照没有内容，返回 undefined） */
  readContent(ref: SnapshotRef): Promise<{ bytes: Uint8Array; truncated: boolean } | undefined>
  /** 按当前配置做一次环形 + 总量淘汰 */
  prune(sessionId: string): Promise<{ removed: number }>
  /** 把防抖中的索引落到磁盘（退出 / 自测前必须调） */
  flush(): Promise<void>
}
