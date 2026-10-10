/**
 * 「首读不许盖掉更晚的广播」的纯逻辑（2026-10-10）。
 *
 * 背景（renderer 启动期的真实竞态）：`bootstrapApp` 旧接线是
 * `await Promise.all([settings.load(), modes.load()])` **之后**才 `bind()`。
 * 落在两者之间的广播**永久丢失**（`load()` 拿到的是切换**前**的快照，丢失的广播不会再补）
 * → 主进程当前模式已是新值、渲染层右栏**永久**停在旧模式；而 `mode.set` 在主进程已是
 * 目标值时是 no-op（`packages/modes/src/manager.ts` 相同 id 提前 return、不 emit），
 * 所以面板自己永远回不来。
 *
 * 接线改成「先订阅、再加载」之后，新问题变成"**加载应答可能比广播更晚返回**"：
 * 晚到的旧快照会盖掉早到的新广播。本助手把这一步判定收敛成可单测的纯逻辑：
 * **发起首读前**用 `snapshot()` 记下当前推送序号，读回来时先 `write(snapshot, value, apply)` ——
 * 这期间收到过推送就拒绝写入（推送的载荷同样是主进程的权威全量状态，而且比这份快照新）。
 *
 * 不持有业务状态、不碰 DOM / IPC，所以 node 环境（无 DOM、无 Electron）能直接测。
 */
export interface LoadGate {
  /** 当前推送序号（在发起首读**之前**调用） */
  snapshot(): number
  /** 写入首读结果：`snapshot` 之后收到过推送则不写值（返回 false） */
  write<T>(snapshot: number, value: T, apply: (value: T) => void): boolean
  /** 推送到达：调用方在订阅回调里调用一次 */
  onPush(): void
  /** 已收到的推送条数（排障 / 测试用） */
  readonly pushes: number
}

export function createLoadGate(): LoadGate {
  let pushes = 0
  return {
    snapshot(): number {
      return pushes
    },
    write<T>(snapshot: number, value: T, apply: (value: T) => void): boolean {
      if (pushes !== snapshot) return false
      apply(value)
      return true
    },
    onPush(): void {
      pushes += 1
    },
    get pushes(): number {
      return pushes
    },
  }
}
