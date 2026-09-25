/**
 * WindowManager（docs/02 §2.2、docs/07 §2）：创建 / 显隐 / 置顶 / 贴边 / 位置记忆。
 *
 * 约定：
 * - 业务窗口不显示在任务栏；关闭按钮 = 隐藏，仅托盘「退出」真正退出；
 * - 交互窗是唯一主对话窗口（shared/windowState 负责状态机，这里同步真实窗口）；
 * - 位置 / 尺寸写入 `general.windowState`，跨启动保留。
 */
import { join } from 'node:path'
import { BrowserWindow, nativeTheme, screen } from 'electron'
import {
  WINDOW_NAMES,
  createInitialWindowState,
  hideWindow as hideInState,
  showWindow as showInState,
  type Logger,
  type SettingsStore,
  type WindowName,
  type WindowState,
} from '@aurora/shared'
import {
  EDGE_BAR_COLLAPSED_HEIGHT,
  EDGE_BAR_WIDTHS,
  expandedEdgeBarHeight,
  placeEdgeBar,
  resizeEdgeBarKeepingAnchor,
} from './edge-bar-geometry.js'

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
  /** 最小尺寸（可选；chat 主界面 940×600，见 betav2 规格 §2） */
  minWidth?: number
  minHeight?: number
  resizable: boolean
  transparent: boolean
  alwaysOnTop: boolean
  skipTaskbar: boolean
  focusable: boolean
  /** 单例窗口默认位置计算 */
  place: 'edge' | 'chat' | 'center'
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
    // BetaV2（Design/betav2-spec.md §2）：chat 从小交互窗升级为**主界面**（1120×720），
    // 不再置顶、居中显示；frame:false / 几何持久化 / 关闭=隐藏 机制不变。
    width: 1120,
    height: 720,
    minWidth: 940,
    minHeight: 600,
    resizable: true,
    transparent: false,
    alwaysOnTop: false,
    skipTaskbar: true,
    focusable: true,
    place: 'center',
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

const DARK_BACKGROUND = '#000000'
const LIGHT_BACKGROUND = '#f5f5f7'

function windowBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? DARK_BACKGROUND : LIGHT_BACKGROUND
}

export class WindowManager {
  private readonly windows = new Map<WindowName, BrowserWindow>()
  private state: WindowState = createInitialWindowState()
  private readonly listeners = new Set<(state: WindowState) => void>()
  private readonly options: WindowManagerOptions
  /** 各窗口当前这次加载的 in-flight promise（`whenLoaded()` 用；窗口销毁时清理） */
  private readonly loadTasks = new Map<WindowName, Promise<void>>()
  /** 提示条是否处于展开（面板）态；默认收起为 8px 竖条（docs/07 §2.2） */
  private edgeBarExpanded = false
  private themeListenerActive = true
  private readonly syncWindowBackgrounds = (): void => {
    const color = windowBackgroundColor()
    for (const name of ['chat', 'settings', 'onboarding'] as const) {
      const win = this.windows.get(name)
      if (win && !win.isDestroyed()) win.setBackgroundColor(color)
    }
    // 系统外观切换是低频事件，也是「浅色下先闪一层深色底」唯一能查的现场记录，因此按 info 落盘
    this.options.logger.info('系统外观已切换，同步窗口底色', {
      dark: nativeTheme.shouldUseDarkColors,
      color,
    })
  }

  constructor(options: WindowManagerOptions) {
    this.options = options
    nativeTheme.on('updated', this.syncWindowBackgrounds)
  }

  private disposeThemeListener(): void {
    if (!this.themeListenerActive) return
    nativeTheme.off('updated', this.syncWindowBackgrounds)
    this.themeListenerActive = false
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

  /**
   * 读取窗口的**真实**几何（未创建 / 已销毁时返回 undefined）。
   *
   * 与 `getState()` 的区别：状态机只说"应该可见"，这里说的是窗口在桌面上的真实矩形，
   * 供自测（AURORA_SMOKE）断言 setBounds 真的生效，而不是只改了状态字段。
   */
  getBounds(name: WindowName): { x: number; y: number; width: number; height: number } | undefined {
    const win = this.windows.get(name)
    if (!win || win.isDestroyed()) return undefined
    return win.getBounds()
  }

  /** 截图核对读取真实原生底色；Electron 33 返回 #RRGGBB，不包含透明度。 */
  getBackgroundColor(name: WindowName): string | undefined {
    if (name === 'edge-bar') return undefined
    const win = this.windows.get(name)
    if (!win || win.isDestroyed()) return undefined
    return win.getBackgroundColor()
  }

  /**
   * 带 query 重新加载窗口（**仅截图场景使用**：设置页深链 `?page=<id>`，docs/07 §5）。
   *
   * 为什么是 reload 而不是新开窗口：截图工具要一次跑完 6 个设置页，
   * 每个页面都新建窗口会堆一排窗口，也会污染 `windowState` 的位置记忆。
   */
  async reload(name: WindowName, query: Record<string, string>): Promise<void> {
    const win = this.ensure(name)
    await this.trackLoad(name, win, query)
  }

  /**
   * 等窗口当前这次加载完成（截图核对用）。
   *
   * 为什么需要：`ensure()` 里的 `load()` 是 fire-and-forget，调用方返回时页面**还没开始**加载，
   * 此时 `webContents.isLoading()` 仍是 false —— 只靠 isLoading 判断会直接"认为加载完了"，
   * 截出一张 0 字节空图（实测踩到过）。
   */
  async whenLoaded(name: WindowName): Promise<void> {
    await this.loadTasks.get(name)
  }

  /**
   * 取窗口（不存在则创建），不改变可见性状态。
   *
   * `query` 只在**创建**时生效（已有窗口不会重新加载；需要换 query 用 `reload()`）；
   * 它服务于截图深链（`?page=<id>`），正常启动不传。
   */
  ensure(name: WindowName, query?: Record<string, string>): BrowserWindow {
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
      ...(spec.minWidth === undefined ? {} : { minWidth: spec.minWidth }),
      ...(spec.minHeight === undefined ? {} : { minHeight: spec.minHeight }),
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
      backgroundColor: name === 'edge-bar' ? '#00000000' : windowBackgroundColor(),
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
      this.loadTasks.delete(name)
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      this.options.logger.error('渲染进程异常退出', { window: name, reason: details.reason })
      this.hide(name)
    })

    void this.trackLoad(name, win, query)
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
    // 提示条隐藏时收回竖条尺寸：否则下次显示会残留展开态的 228px 宽，
    // 在鼠标移开后又变成一块「看不见但挡鼠标」的区域（docs/07 §2.2）。
    if (name === 'edge-bar') this.collapseEdgeBar()
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

  /** 状态机决定的"主对话窗口"（只有交互窗参与判定，docs/07 §2.3） */
  get primary(): 'chat' | null {
    return this.state.primary
  }

  showChat(): WindowState {
    return this.show('chat')
  }

  /**
   * 提示条收起态（8px 竖条）/ 展开态（228px 全高面板）切换（docs/07 §2.2）。
   *
   * 只改尺寸与位置，**不动可见性、不广播状态变化**——可见性没变，广播只会制造无意义的渲染层更新。
   * 展开 / 收起保持**右缘与垂直中心固定**（向左、向上下生长）；窗口尚未创建时只记录标记，
   * 下次 `show()` 会按标记建窗。
   *
   * 展开态要跟着长高：面板里的四块信息 + 四个操作按钮在 200px 高度里装不下，
   * 按钮会被挤到可视区之外（实测按钮 top=278、窗口高 202）——用户看得到面板却点不到按钮。
   */
  setEdgeBarExpanded(expanded: boolean): WindowState {
    this.edgeBarExpanded = expanded
    const win = this.windows.get('edge-bar')
    if (!win || win.isDestroyed()) return this.getState()
    win.setBounds(
      resizeEdgeBarKeepingAnchor(
        win.getBounds(),
        this.sizeFor('edge-bar'),
        screen.getPrimaryDisplay().workArea,
      ),
    )
    this.persistGeometry('edge-bar', win)
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
    this.disposeThemeListener()
    this.quitting = true
    for (const [name, win] of this.windows) {
      if (win.isDestroyed()) continue
      this.persistGeometry(name, win)
    }
  }

  destroyAll(): void {
    this.disposeThemeListener()
    this.quitting = true
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.destroy()
    }
    this.windows.clear()
  }

  // ───────────────────────── 内部 ─────────────────────────

  private async load(
    win: BrowserWindow,
    name: WindowName,
    query?: Record<string, string>,
  ): Promise<void> {
    const { rendererUrl, rendererDir } = this.options
    const hasQuery = query !== undefined && Object.keys(query).length > 0
    try {
      if (rendererUrl) {
        const search = hasQuery ? `?${new URLSearchParams(query).toString()}` : ''
        await win.loadURL(`${rendererUrl}/${name}/index.html${search}`)
      } else {
        await win.loadFile(join(rendererDir, name, 'index.html'), hasQuery ? { query } : undefined)
      }
    } catch (error) {
      this.options.logger.error('窗口加载失败', { window: name, error: String(error) })
    }
  }

  /** 发起一次加载并登记 in-flight promise，供 `whenLoaded()` 等待。 */
  private trackLoad(
    name: WindowName,
    win: BrowserWindow,
    query?: Record<string, string>,
  ): Promise<void> {
    const task = this.load(win, name, query)
    this.loadTasks.set(name, task)
    return task
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

  /** 复位提示条折叠标记并同步收缩真实窗口（窗口不存在时只清标记）。 */
  private collapseEdgeBar(): void {
    if (!this.edgeBarExpanded) return
    this.edgeBarExpanded = false
    const win = this.windows.get('edge-bar')
    if (!win || win.isDestroyed()) return
    win.setBounds(
      resizeEdgeBarKeepingAnchor(
        win.getBounds(),
        this.sizeFor('edge-bar'),
        screen.getPrimaryDisplay().workArea,
      ),
    )
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
        // 提示条：右缘贴工作区右缘、垂直居中，宽度按折叠态（收起 8 / 展开 228）
        return placeEdgeBar(area, this.sizeFor(name))
      case 'chat':
        return {
          x: Math.round(area.x + area.width - width - 12),
          y: Math.round(area.y + (area.height - height) / 2),
          width,
          height,
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

  /** 窗口当前应采用的尺寸：提示条按折叠态，其余取 SPECS 固定尺寸。 */
  private sizeFor(name: WindowName): { width: number; height: number } {
    const spec = SPECS[name]
    if (name === 'edge-bar') {
      if (!this.edgeBarExpanded) {
        return { width: EDGE_BAR_WIDTHS.collapsed, height: EDGE_BAR_COLLAPSED_HEIGHT }
      }
      // 展开态高度跟工作区走（全高面板），所以这里要读屏幕
      return {
        width: EDGE_BAR_WIDTHS.expanded,
        height: expandedEdgeBarHeight(screen.getPrimaryDisplay().workArea),
      }
    }
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
    if (name === 'edge-bar') {
      // 提示条**完全不复用持久化几何**：它不参与用户拖动，位置与尺寸都由「工作区右缘 +
      // 垂直居中 + 当前折叠态」唯一决定（`computeBounds` 的 `edge` 分支）。
      // 复用会踩两个坑：收起态继承展开态的 228px 宽（屏幕右侧留下看不见却挡鼠标的区域）；
      // 展开态退出时存下的是 y=24，下次启动竖条跑到屏幕顶部而不是居中。
      return undefined
    }
    return {
      x: clamp(x, area.x - width + 40, area.x + area.width - 40),
      y: clamp(y, area.y, area.y + area.height - 40),
      // 旧版本持久化的尺寸可能小于 BetaV2 的最小规格（如升级前的 chat 420×640），
      // 这里按 spec 的 minWidth / minHeight 抬底，避免「恢复出来的窗口比最小值还小」。
      width: Math.max(SPECS[name].minWidth ?? 120, width),
      height: Math.max(SPECS[name].minHeight ?? 48, height),
    }
  }

  private persistGeometry(name: WindowName, win: BrowserWindow): void {
    const bounds = win.getBounds()
    // 提示条不落盘：它的几何完全由「右缘 + 垂直居中 + 折叠态」推导（`readGeometry` 也不读它）。
    // 若照写，鼠标每次掠过右缘的展开/收起都会触发一次配置写 + `settings:changed`，
    // 进而让主进程重建托盘菜单 —— 纯 UI 悬停不该有这种写入放大。
    if (name === 'edge-bar') return
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
    settings: 'Aurora 设置',
    onboarding: 'Aurora 首次引导',
  }
  return titles[name]
}
