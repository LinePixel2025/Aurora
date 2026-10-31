/**
 * Computer Use 会话状态机（docs/06 §28）。
 *
 * 只做「授权 / 唯一会话 / 限额 / 事件 / 浮层协调」，不碰系统 API：
 * - 授权只在内存里：`start` 建立，stop / 切换设置 / 锁屏 / 退出撤销；
 * - **授权 ≠ 开始操作**：`start` 不建浮层，第一次工具调用（截图 / 读窗口 / 动作）才进入
 *   操作态并显示流光浮层与顶部过程面板；
 * - 同一时间只允许一个会话操控桌面（桌面只有一个指针与焦点）；
 * - 动作上限只计有副作用的调用；截图 / 等待不计；
 * - 事件同时驱动浮层过程面板与对话状态条，摘要只描述「正在做什么」，不含坐标 / 输入文字。
 * - **虚拟光标是 Agent 自己的光标**（2026-10-31）：位置只由动作层驱动（`moveCursor()`），
 *   不再轮询真实指针；用户自己晃鼠标时光环停在原地。真实指针只在动作需要时由端口移动。
 *
 * 依赖全部注入（settings / vision / overlay / 光标点 / 显示器），便于单测；
 * Electron 的 `screen` 与窗口创建留在装配层。
 */
import type {
  ComputerUseEvent,
  ComputerUseSettings,
  ComputerUseStatus,
  ComputerUseStep,
  Settings,
} from '@aurora/shared'
import type { Logger, PermissionMode } from '@aurora/shared'
import { rectContains, type Point, type Rect } from './coordinates.js'
import { canHoldComputerUseSession } from './session-policy.js'

/** 虚拟光标滑动的一帧（约 60fps：比原来的 30fps 跟随更顺，单次滑动只有十几帧）。 */
const CURSOR_FRAME_MS = 16
/** 单次滑动的上限：模型给的坐标再远也不需要更长，避免一次动作卡住整个回合。 */
const CURSOR_MOTION_MAX_MS = 2000

export interface ComputerUseDisplay {
  id: number
  bounds: Rect
}

export interface ComputerUseOverlayAdapter {
  /** 显示所有显示器上的浮层（并等待首次加载）。 */
  show(displays: readonly ComputerUseDisplay[]): Promise<void>
  hide(): void
  /** 动作 / 光标 / 状态事件（由装配层路由到浮层 / 对话窗）。 */
  emit(event: ComputerUseEvent): void
  /** 设置热更新（HUD 是否显示、是否重建浮层）。 */
  applyConfig(settings: ComputerUseSettings): void
  diagnostics(): { visible: boolean; displays: number }
}

export interface ComputerUseServiceOptions {
  settings: () => Settings
  logger: Logger
  overlay: ComputerUseOverlayAdapter
  /** 按会话解析生效模型是否支持图片输入（会话覆盖优先）。 */
  visionForSession: (sessionId: string) => boolean
  /** 全局生效模型是否支持图片输入（未激活时会话 id 为空时用）。 */
  visionEnabled: () => boolean
  /** 当前权限档（现读）。 */
  permissionMode: () => PermissionMode
  /** 当前显示器列表（DIP bounds）。 */
  displays: () => readonly ComputerUseDisplay[]
  /**
   * 光标 DIP 点（Electron screen.getCursorScreenPoint 的装配层封装）。
   *
   * **只在进入操作态时读一次**，作为虚拟光标的起始落点（否则第一次滑动会从屏幕左上角
   * 飞出来）；此后虚拟光标只由 Agent 动作驱动，不再跟随用户的鼠标。
   */
  cursorPoint: () => { x: number; y: number }
  now?: () => number
  /**
   * 会话结束时清理端口侧坐标空间（下一会话必须重新截图）。
   *
   * 带上 `reason` 是为了让装配层区分「Agent 主动完成任务退出」（需要把 Aurora 调回前台）
   * 与「用户 / 设置 / 锁屏 / 退出」等其它结束原因 —— 后者不该抢用户当前应用的焦点。
   */
  onStopped?: (sessionId: string, reason: ComputerUseStatusStopReason) => void
}

export interface ComputerUseActionMeta {
  displayId?: number
  x?: number
  y?: number
}

/** 虚拟光标的目标落点（显示器内 DIP，与 `cursor` 事件同一坐标空间）。 */
export interface ComputerUseCursorTarget {
  displayId: number
  x: number
  y: number
  /** 平滑时长（毫秒，0 / 缺省 = 直接落点）。 */
  durationMs?: number
}

/** 缓出曲线：前段快、末段慢，落点更像人手而不是匀速机械臂。 */
function easeOutCubic(ratio: number): number {
  const clamped = Math.min(1, Math.max(0, ratio))
  return 1 - (1 - clamped) ** 3
}

export class ComputerUseError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ComputerUseError'
    this.code = code
  }
}

export class ComputerUseService {
  private readonly options: ComputerUseServiceOptions
  private sessionId: string | undefined
  private startedAt: string | undefined
  private actions = 0
  private lastAction: string | undefined
  private lastActionKind: string | undefined
  private lastActionAt: string | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private stopHotkeyAvailable = false
  /** 浮层是否已经为本次授权显示过（第一次工具调用时才置 true）。 */
  private overlayShown = false
  /** 最近几步动作描述（新 → 旧），供过程面板挂载时补齐历史。 */
  private recentActions: ComputerUseStep[] = []
  /**
   * 虚拟光标当前落点（显示器内 DIP，与 `cursor` 事件同一坐标空间）。
   *
   * **只由 `moveCursor()` 改**：这是 Agent 自己的光标，不跟随用户的鼠标。
   */
  private virtualCursor: { displayId: number; x: number; y: number } | undefined
  /** 进行中的滑动（新滑动 / 停止时取消，保证同一时刻只有一条轨迹）。 */
  private cursorMotion: { cancel: () => void } | undefined
  /** 本次操作态是否已经用真实指针播过种子（每个会话只播一次）。 */
  private cursorSeeded = false

  constructor(options: ComputerUseServiceOptions) {
    this.options = options
  }

  get activeSessionId(): string | undefined {
    return this.sessionId
  }

  setStopHotkeyAvailable(value: boolean): void {
    this.stopHotkeyAvailable = value
  }

  isAuthorized(sessionId: string): boolean {
    return this.sessionId !== undefined && this.sessionId === sessionId
  }

  status(): ComputerUseStatus {
    const current = this.options.settings()
    const overlay = this.options.overlay.diagnostics()
    const mode = this.options.permissionMode()
    const available = process.platform === 'win32'
    return {
      enabled: current.computerUse.enabled,
      available,
      platformSupported: available,
      vision:
        this.sessionId === undefined
          ? this.options.visionEnabled()
          : this.options.visionForSession(this.sessionId),
      permissionMode: mode,
      active: this.sessionId !== undefined,
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
      ...(this.startedAt === undefined ? {} : { startedAt: this.startedAt }),
      actions: this.actions,
      maxActions: current.computerUse.maxActions,
      ...(this.lastAction === undefined ? {} : { lastAction: this.lastAction }),
      ...(this.lastActionKind === undefined ? {} : { lastActionKind: this.lastActionKind }),
      ...(this.lastActionAt === undefined ? {} : { lastActionAt: this.lastActionAt }),
      ...(this.recentActions.length === 0 ? {} : { recentActions: [...this.recentActions] }),
      overlay,
      stopHotkeyAvailable: this.stopHotkeyAvailable,
      ...(this.disabledReason(current) === undefined
        ? {}
        : { disabledReason: this.disabledReason(current) }),
    }
  }

  async start(sessionId: string): Promise<ComputerUseStatus> {
    const current = this.options.settings()
    const cfg = current.computerUse
    if (!cfg.enabled) throw new ComputerUseError('E_CU_DISABLED', 'Computer Use 未启用')
    if (process.platform !== 'win32') {
      throw new ComputerUseError('E_CU_PLATFORM', 'Computer Use 目前只支持 Windows')
    }
    if (!this.options.visionForSession(sessionId)) {
      throw new ComputerUseError(
        'E_CU_VISION_REQUIRED',
        '当前模型未开启图片输入，不能使用 Computer Use',
      )
    }
    if (this.options.permissionMode() === 'readonly') {
      throw new ComputerUseError('E_CU_READONLY', '只读档下不能使用 Computer Use')
    }
    if (!canHoldComputerUseSession(sessionId)) {
      throw new ComputerUseError('E_CU_SESSION', '该会话不能开启 Computer Use')
    }
    if (this.sessionId !== undefined) {
      if (this.sessionId === sessionId) return this.status()
      throw new ComputerUseError('E_CU_BUSY', '另一个会话正在使用 Computer Use，请先停止')
    }

    this.sessionId = sessionId
    const startedAt = new Date(this.options.now?.() ?? Date.now()).toISOString()
    this.startedAt = startedAt
    this.actions = 0
    this.lastAction = undefined
    this.lastActionKind = undefined
    this.lastActionAt = undefined
    this.recentActions = []
    this.overlayShown = false
    this.cancelCursorMotion()
    this.virtualCursor = undefined
    this.cursorSeeded = false
    const displays = this.options.displays()
    // 授权本身**不**建浮层：用户刚敲 /computer 时屏幕上还没有任何操作，突然满屏流光会像
    // 「已经开始乱点」。浮层由第一次工具调用经 `ensureOperating()` 显示。
    this.emit({
      type: 'started',
      sessionId,
      startedAt,
      displayIds: displays.map((display) => display.id),
    })
    this.armIdleTimer()
    this.options.logger.info('Computer Use 授权已建立', {
      sessionId,
      displays: displays.map((display) => display.id),
    })
    return this.status()
  }

  /**
   * 结束当前会话。
   *
   * `onlySessionId` 给「Agent 自己退出」用：只有调用者就是当前持有者时才结束；
   * 别的会话调 stop 必须是幂等的 no-op —— 否则一个会话就能把另一个会话的桌面操控夺走。
   */
  stop(reason: ComputerUseStatusStopReason = 'user', onlySessionId?: string): ComputerUseStatus {
    if (this.sessionId === undefined) return this.status()
    if (onlySessionId !== undefined && this.sessionId !== onlySessionId) return this.status()
    const sessionId = this.sessionId
    const wasShown = this.overlayShown
    this.overlayShown = false
    this.clearTimers()
    this.sessionId = undefined
    this.startedAt = undefined
    this.actions = 0
    this.lastAction = undefined
    this.lastActionKind = undefined
    this.lastActionAt = undefined
    this.recentActions = []
    this.cancelCursorMotion()
    this.virtualCursor = undefined
    this.cursorSeeded = false
    if (wasShown) {
      try {
        this.options.overlay.hide()
      } catch (error) {
        this.options.logger.warn('Computer Use 浮层收起失败', { error: String(error) })
      }
    }
    this.options.onStopped?.(sessionId, reason)
    this.emit({ type: 'ended', sessionId, reason })
    this.options.logger.info('Computer Use 会话已结束', { sessionId, reason })
    return this.status()
  }

  /** 每次工具调用的二次校验（防请求开始后授权被撤销 / 模型被切走）。 */
  ensureCallAllowed(sessionId: string): void {
    if (this.sessionId === undefined) {
      throw new ComputerUseError(
        'E_CU_NOT_ACTIVE',
        'Computer Use 未授权：请让用户输入 /computer，或由你调用 computer_start 进入',
      )
    }
    if (this.sessionId !== sessionId) {
      throw new ComputerUseError('E_CU_NOT_AUTHORIZED', '本会话没有 Computer Use 授权')
    }
    const current = this.options.settings()
    if (!current.computerUse.enabled) {
      this.stop('settings')
      throw new ComputerUseError('E_CU_DISABLED', 'Computer Use 已在设置中关闭')
    }
    if (!this.options.visionForSession(sessionId)) {
      this.stop('model')
      throw new ComputerUseError('E_CU_VISION_REQUIRED', '当前模型不再支持图片输入')
    }
    if (this.options.permissionMode() === 'readonly') {
      this.stop('permission')
      throw new ComputerUseError('E_CU_READONLY', '只读档下不能使用 Computer Use')
    }
    this.armIdleTimer()
    // 第一次工具调用 = 真正开始操作：到这时才建浮层 / 播虚拟光标种子。
    this.ensureOperating()
  }

  /**
   * 记录一次有副作用的动作：预算检查 → 发事件 → 返回当前步数。
   *
   * `summary` 由端口生成，只描述「正在做什么」，必须**不含坐标 / 输入文字 / 剪贴板内容**。
   */
  beginAction(
    sessionId: string,
    action: string,
    summary: string,
    meta: ComputerUseActionMeta = {},
  ): { step: number; maxSteps: number } {
    this.ensureCallAllowed(sessionId)
    const cfg = this.options.settings().computerUse
    if (this.actions + 1 > cfg.maxActions) {
      this.stop('budget')
      throw new ComputerUseError('E_CU_BUDGET', `已达到单会话动作上限（${cfg.maxActions}），已停止`)
    }
    this.actions += 1
    const at = this.recordStep(action, summary)
    this.emit({
      type: 'action',
      sessionId,
      action,
      summary,
      step: this.actions,
      maxSteps: cfg.maxActions,
      at,
      ...(meta.displayId === undefined ? {} : { displayId: meta.displayId }),
      ...(meta.x === undefined ? {} : { x: meta.x }),
      ...(meta.y === undefined ? {} : { y: meta.y }),
    })
    return { step: this.actions, maxSteps: cfg.maxActions }
  }

  /**
   * 记录一次**只读步骤**（截图 / 读窗口 / 等控件）：计入过程面板与状态条，但不计动作限额。
   * 这些调用本身没有副作用，却正是用户最需要看到的「Agent 现在在干嘛」。
   */
  noteStep(sessionId: string, action: string, summary: string): void {
    this.ensureCallAllowed(sessionId)
    const cfg = this.options.settings().computerUse
    const at = this.recordStep(action, summary)
    this.emit({
      type: 'action',
      sessionId,
      action,
      summary,
      step: this.actions,
      maxSteps: cfg.maxActions,
      at,
    })
  }

  noteClick(input: {
    displayId: number
    x: number
    y: number
    button: 'left' | 'right' | 'middle'
  }): void {
    this.emit({ type: 'click', ...input })
  }

  /**
   * 把虚拟光标滑到目标点（**Agent 自己的光标**，与用户的鼠标无关）。
   *
   * 点击 / 拖拽 / 滚轮在合成输入前先 `await` 这里：用户看到的是「光标先滑过去，
   * 到位后才点下去」，而不是原地冒出一圈涟漪。同一时刻只有一条轨迹 ——
   * 新调用取消上一段未完成的滑动（`stop()` 也会取消，避免动作卡在动画上）。
   *
   * 坐标是**显示器内 DIP**（与浮层窗口同一坐标空间）；关闭 `showVirtualCursor`
   * 时不播动画、直接落点，点击也就没有额外的等待。
   */
  async moveCursor(target: ComputerUseCursorTarget): Promise<void> {
    this.cancelCursorMotion()
    const to = {
      displayId: target.displayId,
      x: Math.round(target.x * 100) / 100,
      y: Math.round(target.y * 100) / 100,
    }
    const durationMs = Math.max(
      0,
      Math.min(CURSOR_MOTION_MAX_MS, Math.round(target.durationMs ?? 0)),
    )
    const from = this.virtualCursor
    // 换显示器时不跨屏滑（会在上一块屏留下一条跑出边界的轨迹），直接在新屏落点。
    const start = from !== undefined && from.displayId === to.displayId ? from : { ...to }
    const distance = Math.hypot(to.x - start.x, to.y - start.y)
    const animate = durationMs > 0 && distance >= 1 && this.virtualCursorVisible()
    if (!animate) {
      this.setVirtualCursor(to)
      return
    }
    await this.runCursorMotion(start, to, durationMs)
  }

  notice(tone: 'info' | 'warn', text: string): void {
    this.emit({ type: 'notice', tone, text })
  }

  /** 宿主崩溃 / 超时：失败关闭，不留下半截控制。 */
  fail(reason: string): void {
    if (this.sessionId === undefined) return
    this.options.logger.warn('Computer Use 失败关闭', { reason })
    this.stop('error')
  }

  reconfigure(next: Settings): void {
    if (this.sessionId === undefined) return
    const cfg = next.computerUse
    if (!cfg.enabled) {
      this.stop('settings')
      return
    }
    if (this.options.permissionMode() === 'readonly') {
      this.stop('permission')
      return
    }
    // 只有已经进入操作态才需要重建 / 调整浮层；仅授权时改视觉设置不应突然弹出满屏流光。
    if (this.overlayShown) this.options.overlay.applyConfig(cfg)
  }

  dispose(): void {
    this.stop('quit')
  }

  private disabledReason(settings: Settings): string | undefined {
    if (!settings.computerUse.enabled) return '在设置页开启 Computer Use'
    if (process.platform !== 'win32') return '仅支持 Windows'
    if (this.options.permissionMode() === 'readonly') return '只读档下不可用'
    if (!this.options.visionEnabled()) {
      return '当前模型未开启图片输入（AI 模型页 → 支持图片输入）'
    }
    return undefined
  }

  /**
   * 记一条过程（新 → 旧，最多 6 条）并更新状态条的「最近动作」。
   *
   * 分组：**连续**的同一 `action + summary` 合并成一条并累加 `count`（面板显示 ×N）；
   * 中间隔了别的步骤就保留为新的一条，不丢时间顺序。
   */
  private recordStep(action: string, summary: string): string {
    const at = new Date(this.options.now?.() ?? Date.now()).toISOString()
    this.lastAction = summary
    this.lastActionKind = action
    this.lastActionAt = at
    const head = this.recentActions[0]
    if (head !== undefined && head.action === action && head.summary === summary) {
      this.recentActions = [{ ...head, count: head.count + 1 }, ...this.recentActions.slice(1)]
    } else {
      this.recentActions = [{ action, summary, count: 1 }, ...this.recentActions].slice(0, 6)
    }
    return at
  }

  /**
   * 第一次工具调用时显示浮层；失败只降级成「没有视觉效果」，**不阻断操作**
   * （有的显卡 / 远程桌面会话拿不到透明窗，不能因此让整个能力不可用）。
   */
  private ensureOperating(): void {
    if (this.overlayShown || this.sessionId === undefined) return
    this.overlayShown = true
    const displays = this.options.displays()
    const cfg = this.options.settings().computerUse
    void this.options.overlay
      .show(displays)
      .then(() => {
        if (this.sessionId === undefined) {
          // 浮层还没加载完用户就停止了：别把窗口留在屏幕上
          this.options.overlay.hide()
          return
        }
        this.options.overlay.applyConfig(cfg)
        // 虚拟光标从「真实指针当前位置」起步**一次**：否则第一段滑动会从屏幕左上角飞出来。
        // 之后它只跟 Agent 的动作走 —— 用户再晃鼠标，光环留在原地（2026-10-31 口径）。
        this.seedVirtualCursor()
        this.options.logger.info('Computer Use 开始操作，浮层已显示', {
          displays: displays.map((display) => display.id),
        })
      })
      .catch((error) => {
        this.overlayShown = false
        this.options.logger.warn('Computer Use 浮层显示失败（操作继续）', {
          error: String(error),
        })
      })
  }

  private armIdleTimer(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    const minutes = this.options.settings().computerUse.idleStopMinutes
    this.idleTimer = setTimeout(
      () => {
        if (this.sessionId === undefined) return
        this.options.logger.info('Computer Use 闲置超时，自动结束', { minutes })
        this.stop('idle')
      },
      Math.max(1, minutes) * 60_000,
    )
    this.idleTimer.unref?.()
  }

  /**
   * 用真实指针给虚拟光标播一次种子（每个操作态只播一次）。
   *
   * 只读一次位置、不做轮询：这样「光环出现在鼠标现在的位置」符合直觉，又不会变成
   * 「虚拟光标 = 用户鼠标的影子」。读不到指针（远程会话 / 权限）就静默跳过，
   * 第一次 `moveCursor()` 会直接从落点开始。
   */
  private seedVirtualCursor(): void {
    if (this.cursorSeeded || this.sessionId === undefined) return
    this.cursorSeeded = true
    let point: Point
    try {
      point = this.options.cursorPoint()
    } catch {
      return
    }
    const display = this.options.displays().find((item) => rectContains(item.bounds, point))
    if (display === undefined) return
    this.setVirtualCursor({
      displayId: display.id,
      x: point.x - display.bounds.x,
      y: point.y - display.bounds.y,
    })
  }

  /** 把落点写进状态并发一条 `cursor` 事件（浮层按 `displayId` 挑自己那一扇窗）。 */
  private setVirtualCursor(point: { displayId: number; x: number; y: number }): void {
    this.virtualCursor = point
    if (this.sessionId === undefined) return
    this.emit({
      type: 'cursor',
      displayId: point.displayId,
      x: point.x,
      y: point.y,
      visible: true,
    })
  }

  /** 播一段滑动：约 60fps 发 `cursor` 事件，缓出曲线（先快后慢，像人手的落点）。 */
  private runCursorMotion(
    from: { displayId: number; x: number; y: number },
    to: { displayId: number; x: number; y: number },
    durationMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const startedAt = this.now()
      let done = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (): void => {
        if (done) return
        done = true
        if (timer !== undefined) clearTimeout(timer)
        if (this.cursorMotion?.cancel === finish) this.cursorMotion = undefined
        resolve()
      }
      const step = (): void => {
        timer = undefined
        if (done) return
        const ratio = Math.min(1, (this.now() - startedAt) / durationMs)
        const eased = easeOutCubic(ratio)
        this.setVirtualCursor({
          displayId: to.displayId,
          x: from.x + (to.x - from.x) * eased,
          y: from.y + (to.y - from.y) * eased,
        })
        if (ratio >= 1) {
          finish()
          return
        }
        timer = setTimeout(step, CURSOR_FRAME_MS)
        timer.unref?.()
      }
      this.cursorMotion = { cancel: finish }
      step()
    })
  }

  private cancelCursorMotion(): void {
    const motion = this.cursorMotion
    this.cursorMotion = undefined
    motion?.cancel()
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /** 用户关掉虚拟光标时不播动画：既不画，也不该为「看不见的滑动」多等一程。 */
  private virtualCursorVisible(): boolean {
    return this.options.settings().computerUse.showVirtualCursor !== false
  }

  private clearTimers(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
    this.cancelCursorMotion()
  }

  private emit(event: ComputerUseEvent): void {
    try {
      this.options.overlay.emit(event)
    } catch (error) {
      this.options.logger.warn('Computer Use 事件发送失败', { error: String(error) })
    }
  }
}

export type ComputerUseStatusStopReason =
  | 'user'
  | 'agent'
  | 'settings'
  | 'model'
  | 'permission'
  | 'idle'
  | 'budget'
  | 'error'
  | 'system'
  | 'quit'
