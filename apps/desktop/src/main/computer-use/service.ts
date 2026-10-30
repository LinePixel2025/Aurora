/**
 * Computer Use 会话状态机（docs/06 §28）。
 *
 * 只做「授权 / 唯一会话 / 限额 / 事件 / 浮层协调」，不碰系统 API：
 * - 授权只在内存里：start 建立，stop / 切换设置 / 锁屏 / 退出撤销；
 * - 同一时间只允许一个会话操控桌面（桌面只有一个指针与焦点）；
 * - 动作上限只计有副作用的调用；截图 / 等待不计；
 * - 事件同时驱动浮层 HUD 与对话状态条，摘要不含输入文字。
 *
 * 依赖全部注入（settings / vision / overlay / 光标点 / 显示器），便于单测；
 * Electron 的 `screen` 与窗口创建留在装配层。
 */
import type {
  ComputerUseEvent,
  ComputerUseSettings,
  ComputerUseStatus,
  Settings,
} from '@aurora/shared'
import type { Logger, PermissionMode } from '@aurora/shared'
import type { Rect } from './coordinates.js'

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
  /** 光标 DIP 点（Electron screen.getCursorScreenPoint 的装配层封装）。 */
  cursorPoint: () => { x: number; y: number }
  now?: () => number
  /** 单测可注入定时器；缺省用全局。 */
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
  /** 会话结束时清理端口侧坐标空间（下一会话必须重新截图）。 */
  onStopped?: (sessionId: string) => void
}

export interface ComputerUseActionMeta {
  displayId?: number
  x?: number
  y?: number
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
  private lastActionAt: string | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private cursorTimer: ReturnType<typeof setInterval> | undefined
  private lastCursor: { x: number; y: number } | undefined
  private lastDisplayId: number | undefined
  private stopHotkeyAvailable = false

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
      ...(this.lastActionAt === undefined ? {} : { lastActionAt: this.lastActionAt }),
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
    if (
      sessionId.trim() === '' ||
      sessionId.startsWith('auto-') ||
      sessionId.startsWith('awareness-') ||
      sessionId.endsWith('-sub')
    ) {
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
    this.lastActionAt = undefined
    const displays = this.options.displays()
    try {
      await this.options.overlay.show(displays)
    } catch (error) {
      this.sessionId = undefined
      this.startedAt = undefined
      this.options.logger.warn('Computer Use 浮层启动失败', { error: String(error) })
      throw new ComputerUseError('E_CU_OVERLAY', `浮层启动失败：${String(error)}`)
    }
    this.options.overlay.applyConfig(cfg)
    this.emit({
      type: 'started',
      sessionId,
      startedAt,
      displayIds: displays.map((display) => display.id),
    })
    this.startCursorLoop()
    this.armIdleTimer()
    this.options.logger.info('Computer Use 会话已开始', {
      sessionId,
      displays: displays.map((display) => display.id),
    })
    return this.status()
  }

  stop(reason: ComputerUseStatusStopReason = 'user'): ComputerUseStatus {
    if (this.sessionId === undefined) return this.status()
    const sessionId = this.sessionId
    this.clearTimers()
    this.sessionId = undefined
    this.startedAt = undefined
    this.actions = 0
    this.lastAction = undefined
    this.lastActionAt = undefined
    this.lastCursor = undefined
    this.lastDisplayId = undefined
    try {
      this.options.overlay.hide()
    } catch (error) {
      this.options.logger.warn('Computer Use 浮层收起失败', { error: String(error) })
    }
    this.options.onStopped?.(sessionId)
    this.emit({ type: 'ended', sessionId, reason })
    this.options.logger.info('Computer Use 会话已结束', { sessionId, reason })
    return this.status()
  }

  /** 每次工具调用的二次校验（防请求开始后授权被撤销 / 模型被切走）。 */
  ensureCallAllowed(sessionId: string): void {
    if (this.sessionId === undefined) {
      throw new ComputerUseError(
        'E_CU_NOT_ACTIVE',
        'Computer Use 未授权，请先在输入框点击「操作电脑」',
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
  }

  /**
   * 记录一次有副作用的动作：预算检查 → 发事件 → 返回当前步数。
   *
   * `summary` 由端口生成，必须**不含输入文字 / 剪贴板内容**。
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
    const at = new Date(this.options.now?.() ?? Date.now()).toISOString()
    this.lastAction = summary
    this.lastActionAt = at
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

  noteClick(input: {
    displayId: number
    x: number
    y: number
    button: 'left' | 'right' | 'middle'
  }): void {
    this.emit({ type: 'click', ...input })
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
    this.options.overlay.applyConfig(cfg)
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

  private startCursorLoop(): void {
    this.clearCursorTimer()
    const setIntervalFn = this.options.setInterval ?? setInterval
    this.cursorTimer = setIntervalFn(() => {
      if (this.sessionId === undefined) return
      let point: { x: number; y: number }
      try {
        point = this.options.cursorPoint()
      } catch {
        return
      }
      const display = this.options.displays().find((item) => {
        const x = point.x
        const y = point.y
        return (
          x >= item.bounds.x &&
          x <= item.bounds.x + item.bounds.width &&
          y >= item.bounds.y &&
          y <= item.bounds.y + item.bounds.height
        )
      })
      if (display === undefined) return
      if (
        this.lastCursor !== undefined &&
        Math.abs(this.lastCursor.x - point.x) < 0.5 &&
        Math.abs(this.lastCursor.y - point.y) < 0.5 &&
        this.lastDisplayId === display.id
      ) {
        return
      }
      this.lastCursor = point
      this.lastDisplayId = display.id
      this.emit({
        type: 'cursor',
        displayId: display.id,
        x: point.x - display.bounds.x,
        y: point.y - display.bounds.y,
        visible: true,
      })
    }, 33)
    this.cursorTimer.unref?.()
  }

  private clearCursorTimer(): void {
    if (this.cursorTimer === undefined) return
    const clear = this.options.clearInterval ?? clearInterval
    clear(this.cursorTimer)
    this.cursorTimer = undefined
  }

  private clearTimers(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
    this.clearCursorTimer()
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
  'user' | 'settings' | 'model' | 'permission' | 'idle' | 'budget' | 'error' | 'system' | 'quit'
