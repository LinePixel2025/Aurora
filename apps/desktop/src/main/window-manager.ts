/**
 * WindowManager（docs/02 §2.2、docs/07 §2）：创建 / 显隐 / 置顶 / 贴边 / 位置记忆。
 *
 * 约定：
 * - 业务窗口不显示在任务栏；关闭按钮 = 隐藏，仅托盘「退出」真正退出；
 * - 迷你窗与交互窗同屏互斥（shared/windowState 负责状态机，这里同步真实窗口）；
 * - 位置 / 尺寸写入 `general.windowState`，跨启动保留。
 */
import { join } from 'node:path'
import { BrowserWindow, screen } from 'electron'
import {
  WINDOW_NAMES,
  createInitialWindowState,
  hideWindow as hideInState,
  showWindow as showInState,
  type Logger,
  type PrimaryWindow,
  type SettingsStore,
  type WindowName,
  type WindowState,
} from '@aurora/shared'

export interface WindowManagerOptions {
  settings: SettingsStore
  logger: Logger
  preloadPath: string
  /** dev 下的 renderer 服务地址；为空表示加载打包后的 HTML */
  rendererUrl?: string
  rendererDir: string
  isDev: boolean
}

interface WindowSpec {
  width: number
  height: number
  resizable: boolean
  transparent: boolean
  alwaysOnTop: boolean
  skipTaskbar: boolean
  focusable: boolean
  /** 单例窗口默认位置计算 */
  place: 'edge' | 'chat' | 'anchor-dock' | 'center'
}

const SPECS: Record<WindowName, WindowSpec> = {
  'edge-bar': {
    width: 8,
    height: 200,
    resizable: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    place: 'edge',
  },
  chat: {
    width: 420,
    height: 640,
    resizable: true,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    place: 'chat',
  },
  'mini-chat': {
    width: 320,
    height: 480,
    resizable: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    place: 'anchor-dock',
  },
  settings: {
    width: 900,
    height: 640,
    resizable: true,
    transparent: false,
    alwaysOnTop: false,
    skipTaskbar: true,
    focusable: true,
    place: 'center',
  },
  onboarding: {
    width: 720,
    height: 560,
    resizable: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    focusable: true,
    place: 'center',
  },
}

export class WindowManager {
  private readonly windows = new Map<WindowName, BrowserWindow>()
  private state: WindowState = createInitialWindowState()
  private readonly listeners = new Set<(state: WindowState) => void>()
  private readonly options: WindowManagerOptions

  constructor(options: WindowManagerOptions) {
    this.options = options
  }

  getState(): WindowState {
    return { visible: { ...this.state.visible }, primary: this.state.primary }
  }

  onStateChanged(listener: (state: WindowState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  exists(name: WindowName): boolean {
    const win = this.windows.get(name)
    return win !== undefined && !win.isDestroyed()
  }

  /** 取窗口（不存在则创建），不改变可见性状态。 */
  ensure(name: WindowName): BrowserWindow {
    const existing = this.windows.get(name)
    if (existing && !existing.isDestroyed()) return existing

    const spec = SPECS[name]
    const size = this.sizeFor(name)
    const saved = this.readGeometry(name)
    const bounds = saved ?? this.computeBounds(name, { ...spec, ...size })

    const win = new BrowserWindow({
      ...bounds,
      width: bounds.width ?? size.width,
      height: bounds.height ?? size.height,
      show: false,
      frame: false,
      resizable: spec.resizable,
      transparent: spec.transparent,
      alwaysOnTop: spec.alwaysOnTop,
      skipTaskbar: spec.skipTaskbar,
      focusable: spec.focusable,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      backgroundColor: name === 'edge-bar' ? '#00000000' : '#12141a',
      title: titleFor(name),
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        devTools: this.options.isDev,
      },
    })

    win.setMenuBarVisibility(false)
    // 提示条透明度取自设置（docs/08 §1）；窗口创建时即应用，避免一次可见的跳变
    if (name === 'edge-bar') {
      this.applyEdgeBarOpacity(this.options.settings.get().general.edgeBar.opacity)
    }
    if (this.options.isDev) {
      const name$ = name
      // dev：把渲染层日志转发到主进程终端，便于排查白屏 / CSP / 脚本错误
      win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
        this.options.logger.debug('[renderer] ' + message, {
          window: name$,
          level,
          source: `${sourceId}:${line}`,
        })
      })
      win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
        this.options.logger.error('渲染层加载失败', {
          window: name$,
          errorCode,
          errorDescription,
          validatedURL,
        })
      })
      // 需要时用 AURORA_DEVTOOLS=1 pnpm dev 打开 DevTools（默认不打扰）
      if (process.env['AURORA_DEVTOOLS'] === '1') {
        win.webContents.openDevTools({ mode: 'detach' })
      }
    }
    // 关闭 = 隐藏（docs/02 §2.2）
    win.on('close', (event) => {
      if (this.quitting) return
      event.preventDefault()
      this.hide(name)
    })
    win.on('moved', () => this.persistGeometry(name, win))
    win.on('resized', () => this.persistGeometry(name, win))
    win.on('closed', () => {
      this.windows.delete(name)
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      this.options.logger.error('渲染进程异常退出', { window: name, reason: details.reason })
      this.hide(name)
    })

    void this.load(win, name)
    this.windows.set(name, win)
    this.options.logger.debug('窗口已创建', { window: name, bounds })
    return win
  }

  /**
   * 应用提示条透明度（docs/07 §2.2、docs/08 §1 `general.edgeBar.opacity`）。
   *
   * 只对已创建的窗口生效；窗口尚未创建时跳过（创建时会在 `ensure()` 里按当前值设置），
   * 因此这里不需要「记住待应用值」——`index.ts` 在每次设置变更与启动时都会调用一次。
   */
  applyEdgeBarOpacity(opacity: number): void {
    const win = this.windows.get('edge-bar')
    if (win === undefined || win.isDestroyed()) return
    const clamped = Math.min(1, Math.max(0.2, Number.isFinite(opacity) ? opacity : 0.9))
    try {
      win.setOpacity(clamped)
    } catch (error) {
      this.options.logger.debug('设置提示条透明度失败', { opacity: clamped, error: String(error) })
    }
  }

  private quitting = false

  show(name: WindowName): WindowState {
    const before = this.state
    const next = showInState(this.state, name)
    this.state = next
    // 状态机把另一个主对话窗口置为不可见时，**真实窗口必须同步隐藏**，
    // 否则旧窗口会继续盖在新窗口上（hide() 一直有这一步，show() 此前漏了）。
    for (const other of WINDOW_NAMES) {
      if (before.visible[other] === true && next.visible[other] !== true) {
        this.applyVisibility(other, false)
      }
    }
    const win = this.ensure(name)
    this.applyVisibility(name, true, win)
    this.emit()
    return this.getState()
  }

  hide(name: WindowName): WindowState {
    const before = this.state
    this.state = hideInState(this.state, name)
    this.applyVisibility(name, false)
    if (before.primary !== this.state.primary && this.state.primary === null) {
      this.applyVisibility('chat', false)
    }
    this.emit()
    return this.getState()
  }

  toggle(name: WindowName): WindowState {
    return this.isVisible(name) ? this.hide(name) : this.show(name)
  }

  isVisible(name: WindowName): boolean {
    return this.state.visible[name] === true
  }

  /** 状态机决定的"主对话窗口"（迷你窗 / 交互窗二选一） */
  get primary(): PrimaryWindow | null {
    return this.state.primary
  }

  showChat(): WindowState {
    return this.show('chat')
  }

  showMiniChat(): WindowState {
    const win = this.ensure('mini-chat')
    if (!win.isVisible()) this.anchorToEdgeBar(win, this.windows.get('edge-bar'))
    return this.show('mini-chat')
  }

  /**
   * 提示条收起态（8px 竖条）/ 展开态（面板）切换（docs/07 §2.2）。
   *
   * 契约已打通（渲染层 → preload → ipc → 此处）；真实的两态尺寸与右缘固定逻辑
   * 在后续步骤实现，当前只回传状态。
   */
  setEdgeBarExpanded(_expanded: boolean): WindowState {
    return this.getState()
  }

  /** 把外部传入的坐标写回（渲染层拖拽结束时调用）。 */
  setPosition(name: WindowName, position: { x: number; y: number }): WindowState {
    const win = this.ensure(name)
    win.setPosition(Math.round(position.x), Math.round(position.y))
    this.persistGeometry(name, win)
    return this.getState()
  }

  focus(name: WindowName): void {
    const win = this.ensure(name)
    win.showInactive()
    win.focus()
  }

  /** 退出前：允许窗口真正关闭并落盘几何信息。 */
  prepareQuit(): void {
    this.quitting = true
    for (const [name, win] of this.windows) {
      if (win.isDestroyed()) continue
      this.persistGeometry(name, win)
    }
  }

  destroyAll(): void {
    this.quitting = true
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.destroy()
    }
    this.windows.clear()
  }

  // ───────────────────────── 内部 ─────────────────────────

  private async load(win: BrowserWindow, name: WindowName): Promise<void> {
    const { rendererUrl, rendererDir } = this.options
    try {
      if (rendererUrl) {
        await win.loadURL(`${rendererUrl}/${name}/index.html`)
      } else {
        await win.loadFile(join(rendererDir, name, 'index.html'))
      }
    } catch (error) {
      this.options.logger.error('窗口加载失败', { window: name, error: String(error) })
    }
  }

  private applyVisibility(name: WindowName, visible: boolean, existing?: BrowserWindow): void {
    const win = existing ?? this.windows.get(name)
    if (!win || win.isDestroyed()) {
      if (visible) this.show(name)
      return
    }
    if (visible) {
      if (name === 'edge-bar') win.showInactive()
      else win.show()
    } else {
      win.hide()
    }
  }

  private computeBounds(
    name: WindowName,
    spec: WindowSpec,
  ): { x: number; y: number; width: number; height: number } {
    const display = screen.getPrimaryDisplay()
    const area = display.workArea
    const { width, height } = spec

    switch (spec.place) {
      case 'edge':
        return {
          x: Math.round(area.x + area.width - width),
          y: Math.round(area.y + (area.height - height) / 2),
          width,
          height,
        }
      case 'chat':
        return {
          x: Math.round(area.x + area.width - width - 12),
          y: Math.round(area.y + (area.height - height) / 2),
          width,
          height,
        }
      case 'anchor-dock': {
        // 迷你窗左缘贴提示条左缘，垂直中心与提示条一致；提示条未创建时回落工作区右下角（docs/07 §2.4）
        const edgeBounds = this.existingWindow('edge-bar')?.getBounds()
        if (edgeBounds === undefined) return this.bottomRightBounds(width, height)
        return {
          x: Math.round(clamp(edgeBounds.x, area.x, area.x + area.width - width)),
          y: Math.round(
            clamp(
              edgeBounds.y + (edgeBounds.height - height) / 2,
              area.y,
              area.y + area.height - height,
            ),
          ),
          width,
          height,
        }
      }
      default:
        return {
          x: Math.round(area.x + (area.width - width) / 2),
          y: Math.round(area.y + (area.height - height) / 2),
          width,
          height,
        }
    }
  }

  /** 提示条窗口不存在时的回落位置：工作区右下角（留 12px 边距）。 */
  private bottomRightBounds(
    width: number,
    height: number,
  ): {
    x: number
    y: number
    width: number
    height: number
  } {
    const area = screen.getPrimaryDisplay().workArea
    return {
      x: Math.round(area.x + area.width - width - 12),
      y: Math.round(area.y + area.height - height - 12),
      width,
      height,
    }
  }

  /** 取已创建且未销毁的窗口（不创建：锚定只认现有提示条，没建就回落）。 */
  private existingWindow(name: WindowName): BrowserWindow | undefined {
    const win = this.windows.get(name)
    return win !== undefined && !win.isDestroyed() ? win : undefined
  }

  private anchorToEdgeBar(win: BrowserWindow, edge: BrowserWindow | undefined): void {
    const area = screen.getPrimaryDisplay().workArea
    const { width, height } = win.getBounds()
    const edgeBounds = edge !== undefined && !edge.isDestroyed() ? edge.getBounds() : undefined
    if (edgeBounds === undefined) {
      const fallback = this.bottomRightBounds(width, height)
      win.setPosition(fallback.x, fallback.y)
      return
    }
    win.setPosition(
      Math.round(clamp(edgeBounds.x, area.x, area.x + area.width - width)),
      Math.round(
        clamp(
          edgeBounds.y + (edgeBounds.height - height) / 2,
          area.y,
          area.y + area.height - height,
        ),
      ),
    )
  }

  /** 窗口当前应采用的尺寸：取 SPECS 固定尺寸。 */
  private sizeFor(name: WindowName): { width: number; height: number } {
    const spec = SPECS[name]
    return { width: spec.width, height: spec.height }
  }

  private readGeometry(
    name: WindowName,
  ): { x: number; y: number; width: number; height: number } | undefined {
    const stored = this.options.settings.get().general.windowState[name]
    if (!stored) return undefined
    const x = toNumber(stored['x'])
    const y = toNumber(stored['y'])
    const width = toNumber(stored['width'])
    const height = toNumber(stored['height'])
    if (x === undefined || y === undefined || width === undefined || height === undefined)
      return undefined
    const area = screen.getPrimaryDisplay().workArea
    return {
      x: clamp(x, area.x - width + 40, area.x + area.width - 40),
      y: clamp(y, area.y, area.y + area.height - 40),
      width: Math.max(120, width),
      height: Math.max(48, height),
    }
  }

  private persistGeometry(name: WindowName, win: BrowserWindow): void {
    const bounds = win.getBounds()
    this.options.settings.mutate((draft) => {
      draft.general.windowState[name] = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      }
    })
  }

  private emit(): void {
    const snapshot = this.getState()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        this.options.logger.warn('窗口状态监听器抛错', { error: String(error) })
      }
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function titleFor(name: WindowName): string {
  const titles: Record<WindowName, string> = {
    'edge-bar': 'Aurora 提示条',
    chat: 'Aurora 对话',
    'mini-chat': 'Aurora 快速对话',
    settings: 'Aurora 设置',
    onboarding: 'Aurora 首次引导',
  }
  return titles[name]
}
