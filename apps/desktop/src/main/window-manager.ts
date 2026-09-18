/**
 * WindowManager（docs/02 §2.2、docs/07 §2）：创建 / 显隐 / 置顶 / 贴边 / 位置记忆。
 *
 * 约定：
 * - 业务窗口不显示在任务栏；关闭按钮 = 隐藏，仅托盘「退出」真正退出；
 * - 迷你窗与交互窗同屏互斥；隐藏服务窗时迷你窗一并隐藏（shared/windowState 负责状态机）；
 * - 位置 / 尺寸写入 `general.windowState`，跨启动保留；服务窗例外，只记位置（docs/07 §2.1）。
 */
import { join } from 'node:path'
import { BrowserWindow, screen } from 'electron'
import {
  createInitialWindowState,
  hideWindow as hideInState,
  showWindow as showInState,
  type Logger,
  type PrimaryWindow,
  type SettingsStore,
  type WindowName,
  type WindowState,
} from '@aurora/shared'
import { dockAnchorRect, resizeDockKeepingAnchor, restoreDockBounds } from './dock-geometry.js'

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
  place: 'dock' | 'edge' | 'chat' | 'anchor-dock' | 'center'
}

/**
 * 服务窗两态尺寸（docs/07 §2.1）：常态为 56×56 圆形浮球，点击后展开为 320×56 输入条。
 * 尺寸由折叠态决定，**不随窗口几何持久化来回切换**（否则收起态会继承上一次输入条的宽高）。
 */
const DOCK_SIZES: Record<'collapsed' | 'expanded', { width: number; height: number }> = {
  collapsed: { width: 56, height: 56 },
  expanded: { width: 320, height: 56 },
}

const SPECS: Record<WindowName, WindowSpec> = {
  'service-dock': {
    ...DOCK_SIZES.collapsed,
    resizable: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    place: 'dock',
  },
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
  /** 服务窗是否处于展开（输入条）态；默认收起为圆形浮球（docs/07 §2.1） */
  private dockExpanded = false

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
      backgroundColor: name === 'service-dock' || name === 'edge-bar' ? '#00000000' : '#12141a',
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

  private quitting = false

  show(name: WindowName): WindowState {
    // 服务窗每次重新显示都回到收起态（圆球），避免上次的输入条形态残留（docs/07 §2.1）。
    // 先于 applyVisibility 同步尺寸，避免「先显示大窗再缩回」的闪烁。
    if (name === 'service-dock') this.resizeDock(false)
    const win = this.ensure(name)
    this.state = showInState(this.state, name)
    this.applyVisibility(name, true, win)
    this.emit()
    return this.getState()
  }

  hide(name: WindowName): WindowState {
    const before = this.state
    this.state = hideInState(this.state, name)
    // 服务窗隐藏时迷你窗一并隐藏（状态机已处理），这里同步真实窗口
    if (name === 'service-dock') this.applyVisibility('mini-chat', false)
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
    const dock = this.ensure('service-dock')
    const win = this.ensure('mini-chat')
    if (!win.isVisible()) this.anchorToDock(win, dock)
    return this.show('mini-chat')
  }

  /**
   * 服务窗收起态（圆形浮球）/ 展开态（输入条）切换（docs/07 §2.1）。
   *
   * 只改尺寸与位置，**不动可见性、不广播状态变化**（可见性没变，广播只会制造无意义的渲染层更新）。
   * 展开 / 收起保持浮球水平中心不变、底边不变。窗口处于收起态时调用无副作用。
   */
  setDockExpanded(expanded: boolean): WindowState {
    this.resizeDock(expanded)
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
      if (name === 'edge-bar' || name === 'service-dock') win.showInactive()
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
      case 'dock':
        return {
          x: Math.round(area.x + (area.width - width) / 2),
          y: Math.round(area.y + area.height - height - 24),
          width,
          height,
        }
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
        // 迷你窗水平居中于服务窗，垂直留 12px 间隙（docs/07 §2.4）
        const dock = this.windows.get('service-dock')
        const dockBounds = dock?.getBounds()
        const anchorCenterX =
          dockBounds !== undefined ? dockBounds.x + dockBounds.width / 2 : area.x + area.width / 2
        const anchorY = dockBounds?.y ?? area.y + area.height - 24
        return {
          x: Math.round(clamp(anchorCenterX - width / 2, area.x, area.x + area.width - width)),
          y: Math.round(clamp(anchorY - height - 12, area.y, area.y + area.height - height)),
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

  private anchorToDock(win: BrowserWindow, dock: BrowserWindow): void {
    const area = screen.getPrimaryDisplay().workArea
    const dockBounds = dock.getBounds()
    const { width, height } = win.getBounds()
    const centerX = dockBounds.x + dockBounds.width / 2
    win.setPosition(
      Math.round(clamp(centerX - width / 2, area.x, area.x + area.width - width)),
      Math.round(clamp(dockBounds.y - height - 12, area.y, area.y + area.height - height)),
    )
  }

  /** 窗口当前应采用的尺寸：服务窗按折叠态，其余取 SPECS 固定尺寸。 */
  private sizeFor(name: WindowName): { width: number; height: number } {
    if (name === 'service-dock') {
      return DOCK_SIZES[this.dockExpanded ? 'expanded' : 'collapsed']
    }
    const spec = SPECS[name]
    return { width: spec.width, height: spec.height }
  }

  /**
   * 把服务窗切到指定折叠态：保持水平中心与底边不变、clamp 进工作区。
   * 窗口尚未创建时只更新标记（没有窗口就没有尺寸可改），下次 show 会按标记建窗。
   */
  private resizeDock(expanded: boolean): void {
    this.dockExpanded = expanded
    const win = this.windows.get('service-dock')
    if (!win || win.isDestroyed()) return
    const size = DOCK_SIZES[expanded ? 'expanded' : 'collapsed']
    const next = resizeDockKeepingAnchor(win.getBounds(), size, screen.getPrimaryDisplay().workArea)
    win.setBounds(next)
    this.persistGeometry('service-dock', win)
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
    if (name === 'service-dock') {
      // 服务窗只恢复位置：尺寸由折叠态决定。若沿用持久化尺寸，收起态会继承上次
      // 输入条的宽高（320×56 的球），圆球形态就被破坏（docs/07 §2.1）。
      return restoreDockBounds({ x, y }, this.sizeFor(name), area)
    }
    return {
      x: clamp(x, area.x - width + 40, area.x + area.width - 40),
      y: clamp(y, area.y, area.y + area.height - 40),
      width: Math.max(120, width),
      height: Math.max(48, height),
    }
  }

  private persistGeometry(name: WindowName, win: BrowserWindow): void {
    // 服务窗存「收起态锚点」而非当前左上角：窗口可能在展开态退出，
    // 直接存会把输入条的左边缘当成下次圆球的定位基准（docs/07 §2.1）。
    const bounds =
      name === 'service-dock'
        ? dockAnchorRect(win.getBounds(), DOCK_SIZES.collapsed)
        : win.getBounds()
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
    'service-dock': 'Aurora AI 服务窗',
    'edge-bar': 'Aurora 提示条',
    chat: 'Aurora 对话',
    'mini-chat': 'Aurora 快速对话',
    settings: 'Aurora 设置',
    onboarding: 'Aurora 首次引导',
  }
  return titles[name]
}
