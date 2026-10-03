/**
 * WindowManager（docs/02 §2.2、docs/07 §2）：创建 / 显隐 / 置顶 / 贴边 / 位置记忆。
 *
 * 约定：
 * - 业务窗口不显示在任务栏；关闭按钮 = 隐藏，仅托盘「退出」真正退出；
 * - 交互窗是唯一主对话窗口（shared/windowState 负责状态机，这里同步真实窗口）；
 * - 位置 / 尺寸写入 `general.windowState`，跨启动保留。
 */
import { join } from 'node:path'
import { BrowserWindow, nativeTheme, screen, type Display } from 'electron'
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
  type EdgeBarSide,
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
  /** Windows 式标题栏：真最小化 / 最大化能力（渲染层自绘 caption 按钮，docs/07 §2.3/§2.5） */
  minimizable: boolean
  maximizable: boolean
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
    minimizable: false,
    maximizable: false,
    place: 'edge',
  },
  chat: {
    // BetaV2（Design/betav2-spec.md §2）：chat 从小交互窗升级为**主界面**，不再置顶、居中显示；
    // frame:false / 几何持久化 / 关闭=隐藏 机制不变。
    /**
     * 2026-10-03 二次修订（用户口径「调大默认窗口大小」）：**默认 1280×800、最小 1060×660**。
     * 上限刻意不取更大：`chat-stream-burst` 实测「主区越宽 → 消息里的图表画布每帧越大」，
     * 1360×860 下这台机器（ToDesk 虚拟显示 + 软件光栅）的流式帧距掉到 300ms 级、
     * 比 2026-09-26 修掉的回归还差；1280×800 是「明显变大且流式仍然跟手」的档位。
     *
     * 最小宽 **1060 = 左栏默认 240 + 主区下限 420 + 右栏默认 384 + 16 余量** —— 低于它，
     * 右栏就会被挤到 280（那时标签条只剩 132px 可用，虽然现在会正确让位、但毕竟不是
     * 「三栏各按默认宽并存」的舒适态）。高度从 600 抬到 660，给右栏的卡片列表一点余量。
     * 存量窗口有**两级抬底**：① 这里的 minWidth/minHeight 会把越界的旧几何夹上来；
     * ② `v25 → v26` 迁移把仍小于新默认的几何放大一次（**只放大、不缩小**）。
     */
    width: 1280,
    height: 800,
    minWidth: 1060,
    minHeight: 660,
    resizable: true,
    transparent: false,
    alwaysOnTop: false,
    // 主界面显示任务栏图标：Windows 式最小化需要可恢复入口（docs/02 §2.2，2026-09 起）
    skipTaskbar: false,
    focusable: true,
    minimizable: true,
    maximizable: true,
    place: 'center',
  },
  settings: {
    width: 900,
    height: 640,
    resizable: true,
    transparent: false,
    alwaysOnTop: false,
    skipTaskbar: false,
    focusable: true,
    minimizable: true,
    maximizable: true,
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
    minimizable: false,
    maximizable: false,
    place: 'center',
  },
}

const DARK_BACKGROUND = '#000000'
const LIGHT_BACKGROUND = '#f5f5f7'

/**
 * 几何落盘的**收尾去抖**间隔（ms，P2-08）。
 *
 * Windows 上拖动 / 缩放期间 `moved` / `resized` 每秒触发 30–60 次；每次落盘都会
 * `settings.mutate()` → 全量 zod 校验 + `redactSettings`（逐 provider DPAPI 解密）+
 * 全窗广播 + 托盘菜单重建 + Center WS 状态重发。250ms 是「手感上已经停手、又不会丢最后一帧」
 * 的惯用值：拖动期间只重排定时器，停手后落一次。
 */
const GEOMETRY_PERSIST_DEBOUNCE_MS = 250

/** 窗口几何（与 `BrowserWindow.getBounds()` 同形，单独命名只为让短路比较读得懂） */
interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 几何是否与基准**逐字段**相同（P2-08 的短路判据） */
function sameBounds(base: WindowBounds | undefined, next: WindowBounds): boolean {
  return (
    base !== undefined &&
    base.x === next.x &&
    base.y === next.y &&
    base.width === next.width &&
    base.height === next.height
  )
}

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
  /** 几何事件的收尾去抖定时器（每个窗口一个，P2-08） */
  private readonly geometryTimers = new Map<WindowName, ReturnType<typeof setTimeout>>()
  /**
   * 每个窗口**最近一次已调度 / 已落盘**的几何（P2-08 的短路基准）。
   *
   * 与它逐字段相同的 `moved` / `resized` 直接返回 —— 连重排定时器都省了
   *（拖动停手后系统还会补几帧同样的 bounds，那些帧就是靠这里挡掉的）。
   */
  private readonly geometryBounds = new Map<WindowName, WindowBounds>()
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
    // maximized 现算（不进状态机）：它描述的是窗口的真实几何，不是「应该可见」的意图
    const maximized: Partial<Record<WindowName, boolean>> = {}
    for (const name of WINDOW_NAMES) {
      const win = this.windows.get(name)
      if (win && !win.isDestroyed() && win.isMaximized()) maximized[name] = true
    }
    return { visible: { ...this.state.visible }, primary: this.state.primary, maximized }
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
      minimizable: spec.minimizable,
      maximizable: spec.maximizable,
      fullscreenable: false,
      backgroundColor: name === 'edge-bar' ? '#00000000' : windowBackgroundColor(),
      title: titleFor(name),
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        // 右栏「浏览器」tab（2026-10-03，docs/07 §2.3）：webview 标签在
        // contextIsolation + sandbox 下可用（guest 是独立进程，不破坏沙箱）；
        // 只对 chat 窗口开启（唯一有浏览器面板的窗口）
        webviewTag: name === 'chat',
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
    /**
     * 右栏内置浏览器的「新窗口」语义（2026-10-03，docs/07 §2.3）。
     *
     * webview 刻意不带 `allowpopups`，于是 `window.open` / `target="_blank"` 默认被整个
     * 丢弃 —— 用户在搜索结果页点一条链接毫无反应（看起来就像"浏览器坏了"）。
     * 这里把它改成**同窗内导航**：不新开窗口（沙箱与窗口管理语义都保持不变），
     * 但链接点得动。只放行 http(s)：其它协议（file: / 自定义协议）一律拒绝，
     * 与地址栏的入口校验同一口径。
     */
    if (name === 'chat') {
      win.webContents.on('did-attach-webview', (_event, guest) => {
        guest.setWindowOpenHandler(({ url }) => {
          if (/^https?:\/\//i.test(url)) {
            // 不能在处理函数里同步 loadURL（导航会被这次拒绝打断），挪到下一拍
            setImmediate(() => {
              guest.loadURL(url).catch(() => undefined)
            })
          }
          return { action: 'deny' }
        })
      })
    }
    // 几何事件走**去抖 + 短路**入口（P2-08）：拖动期间不再每帧全量 mutate / 广播一次
    win.on('moved', () => this.scheduleGeometryPersist(name, win))
    win.on('resized', () => this.scheduleGeometryPersist(name, win))
    // 最大化态变化要广播：渲染层 caption 的「最大化 / 还原」图标据此切换
    //（含标题栏拖动区双击这条不经 toggleMaximize 的原生路径）
    win.on('maximize', () => this.emit())
    win.on('unmaximize', () => this.emit())
    win.on('closed', () => {
      // 先收掉待落盘的几何定时器：窗口没了，它再去改配置就是一次"幽灵写入"
      this.cancelGeometryTimer(name)
      this.geometryBounds.delete(name)
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
    this.applyEdgeBarFocusable(win, expanded)
    win.setBounds(
      resizeEdgeBarKeepingAnchor(
        win.getBounds(),
        this.sizeFor('edge-bar'),
        this.edgeBarDisplay().workArea,
        this.edgeBarSide(),
      ),
    )
    this.persistGeometry('edge-bar', win)
    return this.getState()
  }

  /**
   * 提示条的可聚焦态跟随展开 / 收起切换（2026-09 快速对话上线）。
   *
   * 面板里有快速对话输入框，`focusable: false` 的窗口无法被激活，点输入框也拿不到键盘焦点；
   * 展开时临时允许聚焦（**悬停仍不抢焦点**——setFocusable 不会主动取焦，只有用户真点输入框
   * 才会激活窗口），收起时交还并主动失焦，避免 8px 竖条残留键盘焦点。
   */
  private applyEdgeBarFocusable(win: BrowserWindow, focusable: boolean): void {
    try {
      win.setFocusable(focusable)
      if (!focusable && win.isFocused()) win.blur()
    } catch (error) {
      this.options.logger.debug('切换提示条可聚焦状态失败', {
        focusable,
        error: String(error),
      })
    }
  }

  /**
   * Windows 式标题栏：真最小化（进任务栏，可从任务栏恢复）。
   * 只有 spec 允许的窗口（chat / settings）响应；不可最小化窗口是 no-op（渲染层不渲染按钮）。
   */
  minimize(name: WindowName): WindowState {
    const win = this.windows.get(name)
    if (win === undefined || win.isDestroyed() || !SPECS[name].minimizable) {
      return this.getState()
    }
    win.minimize()
    return this.getState()
  }

  /** 切换最大化（标题栏双击 / caption 按钮）。最大化期间 `persistGeometry` 会跳过落盘。 */
  toggleMaximize(name: WindowName): WindowState {
    const win = this.windows.get(name)
    if (win === undefined || win.isDestroyed() || !SPECS[name].maximizable) {
      return this.getState()
    }
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
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

  /**
   * 向指定窗口推送事件（主进程 → 渲染层单向，docs/12 §6.3 `chat:remoteActivate` 用）。
   *
   * 与 `ensure` 不同，这里**绝不顺手创建窗口**：推送是"尽力而为"——
   * 窗口未创建 / 已销毁时静默跳过（渲染层下次拉状态自会看到最新值）。
   */
  sendTo(name: WindowName, channel: string, payload: unknown): void {
    const win = this.windows.get(name)
    if (win === undefined || win.isDestroyed()) return
    win.webContents.send(channel, payload)
  }

  /** 退出前：允许窗口真正关闭并落盘几何信息。 */
  prepareQuit(): void {
    this.disposeThemeListener()
    this.quitting = true
    // 待落盘的几何先按真实窗口现读一次落盘，再清掉去抖定时器 —— 否则最后一帧拖动会留在
    // 定时器里，等它触发时窗口已经不在（`persistGeometry` 会因 isDestroyed 直接跳过）。
    for (const name of [...this.geometryTimers.keys()]) {
      const win = this.windows.get(name)
      if (win !== undefined && !win.isDestroyed()) this.persistGeometry(name, win)
      this.cancelGeometryTimer(name)
    }
    for (const [name, win] of this.windows) {
      if (win.isDestroyed()) continue
      this.persistGeometry(name, win)
    }
  }

  destroyAll(): void {
    this.disposeThemeListener()
    this.quitting = true
    for (const name of [...this.geometryTimers.keys()]) this.cancelGeometryTimer(name)
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
    this.applyEdgeBarFocusable(win, false)
    win.setBounds(
      resizeEdgeBarKeepingAnchor(
        win.getBounds(),
        this.sizeFor('edge-bar'),
        this.edgeBarDisplay().workArea,
        this.edgeBarSide(),
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
        // 提示条：贴工作区配置侧边缘、垂直居中，宽度按折叠态（收起 8 / 展开 228）。
        // 显示器与屏幕侧 v21 起可配置（general.edgeBar.display / position，现读即生效）
        return placeEdgeBar(this.edgeBarDisplay().workArea, this.sizeFor(name), this.edgeBarSide())
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
      // 展开态高度跟工作区走（全高面板），所以这里要读屏幕（贴附显示器，v21）
      return {
        width: EDGE_BAR_WIDTHS.expanded,
        height: expandedEdgeBarHeight(this.edgeBarDisplay().workArea),
      }
    }
    return { width: spec.width, height: spec.height }
  }

  /**
   * 提示条贴附的显示器（v21，`general.edgeBar.display`）：主显示器 / 光标所在显示器。
   * 创建 / 显示 / 两态切换时现读（改完即生效）；光标坐标取不到时回落主显示器。
   */
  private edgeBarDisplay(): Display {
    if (this.options.settings.get().general.edgeBar.display === 'cursor') {
      try {
        return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      } catch (error) {
        this.options.logger.debug('取光标所在显示器失败，回落主显示器', { error: String(error) })
      }
    }
    return screen.getPrimaryDisplay()
  }

  /** 提示条贴附的屏幕侧（v21，`general.edgeBar.position`，现读配置）。 */
  private edgeBarSide(): EdgeBarSide {
    return this.options.settings.get().general.edgeBar.position
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

  /**
   * 几何事件入口（`moved` / `resized`，P2-08）：**短路 + 收尾去抖**。
   *
   * 修在这里（事件的**源头**）而不是消费方：`index.ts` 的 `settings.onChange` 与
   * `ipc.ts` 的全窗广播都是**监听者**，它们无法分辨"这次配置变更是拖动引起的"；
   * 把去重搬进去只会得到三份互不相同的口径（AGENTS.md 的既有教训）。
   *
   * 两条判据缺一不可：
   * ① **bounds 未变短路** —— 拖动停手后系统还会补几帧同样的几何，这些帧连定时器都不排；
   * ② **收尾去抖** —— 拖动期间只更新待落盘几何并重排定时器，停手 250ms 后才真正写一次。
   */
  private scheduleGeometryPersist(name: WindowName, win: BrowserWindow): void {
    if (!this.isPersistableGeometry(name, win)) return
    const bounds = win.getBounds()
    if (sameBounds(this.geometryBounds.get(name), bounds)) return
    this.geometryBounds.set(name, bounds)
    const existing = this.geometryTimers.get(name)
    if (existing !== undefined) clearTimeout(existing)
    this.geometryTimers.set(
      name,
      setTimeout(() => {
        this.geometryTimers.delete(name)
        this.writeGeometry(name, bounds)
      }, GEOMETRY_PERSIST_DEBOUNCE_MS),
    )
  }

  /** 取消某窗口的待落盘几何（窗口关闭 / 进程退出前调用） */
  private cancelGeometryTimer(name: WindowName): void {
    const timer = this.geometryTimers.get(name)
    if (timer === undefined) return
    clearTimeout(timer)
    this.geometryTimers.delete(name)
  }

  /**
   * 这个窗口的几何**该不该落盘**（三条既有口径，`persistGeometry` 与去抖路径共用一份）：
   * - 提示条不落盘：几何完全由「右缘 + 垂直居中 + 折叠态」推导（`readGeometry` 也不读它）。
   *   若照写，鼠标每次掠过右缘的展开/收起都会触发一次配置写 + `settings:changed`，
   *   进而让主进程重建托盘菜单 —— 纯 UI 悬停不该有这种写入放大；
   * - 已销毁：`getBounds` 会抛，且写进去的几何没有任何意义；
   * - 最大化态：工作区尺寸是系统给的，落盘会把「还原后的窗口」撑满整屏 —— 只记录用户手动
   *   调整出来的常规几何，还原尺寸交给 `isMaximized` 判定。
   */
  private isPersistableGeometry(name: WindowName, win: BrowserWindow): boolean {
    if (name === 'edge-bar') return false
    if (win.isDestroyed()) return false
    return !win.isMaximized()
  }

  /** 立即落盘（`setPosition` / 提示条两态切换 / 退出前）：与去抖路径共用 `writeGeometry` */
  private persistGeometry(name: WindowName, win: BrowserWindow): void {
    if (!this.isPersistableGeometry(name, win)) return
    const bounds = win.getBounds()
    // 记进短路基准：紧跟其后的 `moved` / `resized` 若几何未变就不必再排一次定时器
    this.geometryBounds.set(name, bounds)
    this.writeGeometry(name, bounds)
  }

  /** 真正写配置（`settings.mutate` → 广播链路；调用点只有上面两处，别再散落第三处） */
  private writeGeometry(name: WindowName, bounds: WindowBounds): void {
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
