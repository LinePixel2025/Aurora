/**
 * WindowManager（docs/02 §2.2、docs/07 §2）：创建 / 显隐 / 置顶 / 贴边 / 位置记忆。
 *
 * 约定：
 * - 业务窗口不显示在任务栏；关闭按钮 = 隐藏，仅托盘「退出」真正退出；
 * - 交互窗是唯一主对话窗口（shared/windowState 负责状态机，这里同步真实窗口）；
 * - 位置 / 尺寸写入 `general.windowState`，跨启动保留。
 */
import { join } from 'node:path'
import {
  BrowserWindow,
  nativeTheme,
  screen,
  shell,
  type Display,
  type Session,
  type WebPreferences,
} from 'electron'
import {
  BANNER_CARD_WIDTHS,
  IPC,
  WINDOW_NAMES,
  createInitialWindowState,
  hideWindow as hideInState,
  showWindow as showInState,
  type BannerShowPayload,
  type ComputerUseEvent,
  type ComputerUseSettings,
  type Logger,
  type SettingsStore,
  type WindowName,
  type WindowState,
} from '@aurora/shared'
import {
  EDGE_BAR_WIDTHS,
  edgeBarShape,
  expandedEdgeBarHeight,
  placeEdgeBar,
  type EdgeBarSide,
} from './edge-bar-geometry.js'
import { awarenessGlowBounds, type AwarenessGlowRect } from './awareness-glow.js'
import { zoomActionForInput } from './zoom-shortcuts.js'
import {
  ensurePluginPageProtocol,
  isPluginPageUrl,
  pluginPageTargetOf,
  queuePluginPageSrc,
  registerPluginPageGuest,
  takePluginPageSrcForSession,
} from './page-protocol.js'

export interface WindowManagerOptions {
  settings: SettingsStore
  logger: Logger
  preloadPath: string
  /** dev 下的 renderer 服务地址；为空表示加载打包后的 HTML */
  rendererUrl?: string
  rendererDir: string
  isDev: boolean
  /**
   * 窗口 / 任务栏图标（绝对路径）。dev 下 exe 是 `electron.exe`，不给这一项就会顶着
   * Electron 默认的原子图标；拿不到路径时留空，让 Electron 回落到 exe 自身图标。
   */
  iconPath?: string
  /** 自测时关闭后台节流，保证隐藏 / 后台窗口仍按正常时钟处理 IPC。 */
  backgroundThrottling?: boolean
  /**
   * 插件页面专用 preload（docs/14 §2.4）。为空时拒绝一切 `aurora-plugin://` webview。
   * 普通网页 webview 不受影响。
   */
  pluginPagePreloadPath?: string
}

export interface AwarenessGlowDiagnostics {
  exists: boolean
  visible: boolean
  bounds?: AwarenessGlowRect
  alwaysOnTop?: boolean
  focused?: boolean
  mousePassthrough: boolean
}

/**
 * 流光提醒的两个内部窗口的原生状态（自测 / 捕获用）。
 *
 * 两个窗口职责不同，诊断也**分开报**：卡片窗不可见可能是没建起来，也可能只是还在加载；
 * 合成一个字段会把「窗口没建」与「页面没好」混成同一条故障。
 */
export interface BannerWindowDiagnostics {
  exists: boolean
  visible: boolean
  bounds?: AwarenessGlowRect
  alwaysOnTop?: boolean
  focused?: boolean
  mousePassthrough: boolean
}

/** 内部窗口名：不属于 `WINDOW_NAMES`，没有窗口状态机，只由业务直接驱动。 */
type InternalWindowName = 'awareness-glow' | 'banner' | 'computer-use'

/**
 * 流光提醒卡片窗的几何（docs/07 §2.2.3）。
 *
 * 宽度来自用户设置的三档（`notifications.size` → `BANNER_CARD_WIDTHS`），高度按正文行数估算：
 * **窗口矩形必须与卡片一样大**，否则透明窗口多出来的那块区域会挡住下面窗口的点击
 * （透明 ≠ 可穿透）。卡片自带 12px 外边距画柔和阴影，所以窗口 = 卡片 + 上下左右各 12px。
 */
const BANNER_CARD = {
  margin: 12,
  /** 标题行 20 + 上下内边距 11×2 = 42；正文每行 19 + 与标题的间距 6 */
  baseHeight: 48,
  lineHeight: 19,
  gap: 6,
  maxLines: 3,
  /** 顶到屏幕上边缘的距离（卡片「从流光里落下」，不是贴死第 0 像素） */
  topOffset: 16,
  /** 卡片高度区间：46 只够标题 + 内边距；200 已能放 3 行正文还有余量（再高必然是误报） */
  minHeight: 46,
  maxHeight: 200,
} as const

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
    /*
     * 2026-10-11：挂原生 Acrylic 时**保持** `transparent: true`（本次实测结论）。
     *
     * 排查过程（同日逐项 A/B）要点，避免下次重复踩：
     * - 材质在这台机器上确实挂上了（DWM 的 `DWMWA_SYSTEMBACKDROP_TYPE` 读到 3 = Acrylic），
     *   页面也照常渲染（`PrintWindow(PW_RENDERFULLCONTENT)` 有 96% 非黑像素）；
     * - ⚠️ 桌面抓屏 `Graphics.CopyFromScreen`（BitBlt）**拍不到这个窗口**：它带
     *   `WS_EX_NOREDIRECTIONBITMAP`（DirectComposition），内容只在 DWM/GPU 合成里。
     *   用 BitBlt 会误判成「窗口没渲染」。要 OS 级取证就用 `desktopCapturer`（DXGI）
     *   或系统截图工具（Win+Shift+S 走 Windows.Graphics.Capture）；窗口内容用 `PrintWindow(hwnd, dc, 2)`；
     * - ⚠️ 重启后 ~15s 内页面还没加载完，那时的「悬停没展开」是**假阴性**，A/B 必须等热态。
     */
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
  memory: {
    width: 1040,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    resizable: true,
    transparent: false,
    alwaysOnTop: false,
    skipTaskbar: false,
    focusable: true,
    minimizable: true,
    maximizable: true,
    place: 'center',
  },
  automation: {
    width: 780,
    height: 720,
    minWidth: 560,
    minHeight: 480,
    resizable: true,
    transparent: false,
    alwaysOnTop: false,
    skipTaskbar: false,
    focusable: true,
    minimizable: true,
    maximizable: true,
    place: 'center',
  },
  /** 插件配置窗口（docs/07 §2.2.2）：设置列表的「配置」入口打开的单例管理面。 */
  'plugin-config': {
    width: 880,
    height: 760,
    minWidth: 620,
    minHeight: 520,
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
 * 需要真实采样桌面内容的系统毛玻璃窗口。
 *
 * CSS `backdrop-filter` 只能采样同一渲染页面的内容；主界面要看见后方桌面 / 窗口，
 * 必须由 Windows DWM 的 Acrylic 提供底层材质。Windows 11 22H2 以下或其它平台会自动
 * 回退原有不透明底色，渲染层 body 保持透明但不会裸漏桌面。
 */
/**
 * 2026-10-04 修订：提示条曾退出原生 Acrylic。
 *
 * 当时的根因是 Acrylic 与窗口阴影都按 BrowserWindow 的矩形区域绘制，面板自身再圆角
 * 也只能盖住中间，左上 / 左下会露出矩形材质或阴影。
 *
 * **2026-10-11 恢复**：两个前提都已不成立 ——
 * ① 阴影已由 `hasShadow: false` 关掉；
 * ② 圆角由「原生窗口区域按 1px 阶梯近似」解决（`edgeBarShape` 的 `roundLeftCorners`）：
 *    实测 DWM 的系统材质**按窗口区域裁剪**（收起态 shape 只有 8×200 时材质也只画在那 8×200 里），
 *    所以把区域切成圆弧，圆角外就不会露出矩形材质。材质**只在展开态挂**
 *（收起态页面只有 8px 竖条，见 `syncEdgeBarMaterial`）。
 *
 * 2026-10（v32）：以上「要不要挂材质」还多一道用户开关 —— `appearance.glass`
 * （设置页「通用 → 外观」，见 `glassAllowed()`）。它影响这五个窗口的**原生材质**，
 * 页面内的 CSS 玻璃由渲染层的 `data-glass="off"` 令牌降级负责，两侧同一时刻生效。
 */
const NATIVE_GLASS_WINDOWS = new Set<WindowName>([
  'chat',
  'settings',
  'memory',
  'automation',
  'plugin-config',
  'edge-bar',
])

/** 常规窗口使用 Acrylic；Electron 44 起系统最大化已能稳定保持材质。 */
const NATIVE_WINDOW_MATERIAL = 'acrylic' as const

/**
 * 几何落盘的**收尾去抖**间隔（ms，P2-08）。
 *
 * Windows 上拖动 / 缩放期间 `moved` / `resized` 每秒触发 30–60 次；每次落盘都会
 * `settings.mutate()` → 全量 zod 校验 + `redactSettings`（逐 provider DPAPI 解密）+
 * 全窗广播 + 托盘菜单重建 + Center WS 状态重发。250ms 是「手感上已经停手、又不会丢最后一帧」
 * 的惯用值：拖动期间只重排定时器，停手后落一次。
 */
const GEOMETRY_PERSIST_DEBOUNCE_MS = 250

/** 已加固过的插件页面 session（按插件 partition；授权、下载与弹窗只关一次） */
const hardenPluginSessions = new WeakSet<Session>()

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
  /** 每个 webContents 当前的缩放倍率；刷新 / 重载后重新应用。 */
  private readonly zoomFactors = new Map<number, number>()
  /** 提示条是否处于展开（面板）态；默认收起为 8px 竖条（docs/07 §2.2） */
  private edgeBarExpanded = false
  /** 提示条当前的原生 shape（窗口坐标，供自测断言可见区域）。 */
  private edgeBarShape: WindowBounds[] = []
  /** 自感知顶部流光：内部透明窗口，不属于 `WINDOW_NAMES`，也不参与状态机 / 几何持久化。 */
  private awarenessGlowWindow: BrowserWindow | undefined
  private awarenessGlowLoad: Promise<void> | undefined
  private awarenessGlowMousePassthrough = false
  /**
   * 流光提醒（docs/07 §2.2.3）：两个内部窗口 —— 顶部流光带（整屏透明、鼠标穿透）与
   * 置顶卡片（紧凑、可点）。都不在 `WINDOW_NAMES` 里、无状态机，也不写几何持久化：
   * 它们的位置由「提示条所在显示器 + 内容高度」唯一决定。
   */
  private bannerGlowWindow: BrowserWindow | undefined
  private bannerGlowLoad: Promise<void> | undefined
  private bannerGlowMousePassthrough = false
  private bannerCardWindow: BrowserWindow | undefined
  private bannerCardLoad: Promise<void> | undefined
  /**
   * Computer Use 浮层（v39，docs/06 §28）：每块显示器一扇透明置顶窗 + 一扇 HUD。
   * 都不在 `WINDOW_NAMES` 里、不写几何、不占任务栏；**不做内容保护**（远程桌面会看不到），
   * 进入操作模式后持续显示、实时更新（模型截图里会带上浮层，这是持续可见的取舍）。
   */
  private readonly computerUseOverlays = new Map<
    number,
    {
      win: BrowserWindow
      load: Promise<void>
      mousePassthrough: boolean
      contentProtected: boolean
    }
  >()
  private computerUseHudWindow: BrowserWindow | undefined
  private computerUseHudLoad: Promise<void> | undefined
  private computerUseHudMousePassthrough = false
  private computerUseDisplayListener: (() => void) | undefined
  /** 已成功启用原生材质的窗口；失败时同步回到不透明回退。 */
  private readonly nativeGlassWindows = new Set<WindowName>()
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
  /** 提示条置顶 watchdog：只在原生置顶状态意外丢失时恢复。 */
  private edgeBarTopWatchdog: ReturnType<typeof setInterval> | undefined
  private static readonly EDGE_BAR_TOP_LEVEL = 'screen-saver' as const
  private static readonly EDGE_BAR_TOP_WATCHDOG_MS = 10_000
  private readonly syncWindowBackgrounds = (): void => {
    const color = windowBackgroundColor()
    for (const name of [
      'chat',
      'settings',
      'memory',
      'automation',
      'plugin-config',
      'onboarding',
    ] as const) {
      const win = this.windows.get(name)
      if (!win || win.isDestroyed() || this.nativeGlassWindows.has(name)) continue
      win.setBackgroundColor(color)
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
    this.edgeBarTopWatchdog = setInterval(() => {
      const win = this.windows.get('edge-bar')
      if (
        win === undefined ||
        win.isDestroyed() ||
        this.state.visible['edge-bar'] !== true ||
        win.isAlwaysOnTop()
      ) {
        return
      }
      this.options.logger.debug('提示条置顶状态丢失，watchdog 恢复')
      this.reassertEdgeBarTopmost('watchdog')
    }, WindowManager.EDGE_BAR_TOP_WATCHDOG_MS)
  }

  private disposeThemeListener(): void {
    if (!this.themeListenerActive) return
    nativeTheme.off('updated', this.syncWindowBackgrounds)
    this.themeListenerActive = false
  }

  /**
   * 这个窗口**当前是否该挂原生材质**（v32）：平台 + 窗口名单 + 用户在「外观」里的毛玻璃开关。
   *
   * 三处共用同一份判据（建窗时的 `backgroundColor` / `backgroundMaterial`、最大化还原后的
   * 重新挂载、`applyGlass()` 的即时切换）—— 别在某一处再写一份条件。
   */
  private glassAllowed(name: WindowName): boolean {
    if (process.platform !== 'win32' || !NATIVE_GLASS_WINDOWS.has(name)) return false
    return this.options.settings.get().appearance.glass
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
   * 供自测（AURORA_SMOKE）断言宿主几何与原生 shape 都真的生效，而不是只改了状态字段。
   */
  getBounds(name: WindowName): { x: number; y: number; width: number; height: number } | undefined {
    const win = this.windows.get(name)
    if (!win || win.isDestroyed()) return undefined
    return win.getBounds()
  }

  /** 提示条当前原生 shape；空数组表示恢复为整窗矩形。 */
  getEdgeBarShape(): readonly WindowBounds[] {
    return this.edgeBarShape
  }

  /**
   * 显示自感知四周流光，并在目标显示器变化时重新定位。
   * 内部窗口没有窗口状态机：调用方只表达“当前是否应该显示”。
   *
   * v33 起浮层覆盖**整块显示器**（此前是 72px 的顶部条），因此「工作区是否变了」的比较
   * 仍然是整块显示器 bounds —— 换显示器 / 改分辨率都会重新 `setBounds`。
   */
  showAwarenessGlow(): boolean {
    const win = this.ensureAwarenessGlow()
    if (win.isDestroyed()) return false
    const bounds = awarenessGlowBounds(this.edgeBarDisplay().bounds)
    if (!sameBounds(win.getBounds(), bounds)) win.setBounds(bounds)
    // 分析阶段切换会频繁触发 sync；已可见时不再重复 show / 置顶，避免原生合成面被扰动。
    if (win.isVisible()) return true
    this.reassertAwarenessGlowTopmost('shown', win)
    win.showInactive()
    return true
  }

  /** 自感知流光的**期望**几何：与 `showAwarenessGlow` / `ensureAwarenessGlow` 同一个来源
   *（自测断言用，避免在探针里另写一套 `screen` 取屏口径 —— 提示条可以跟随光标所在显示器）。 */
  getAwarenessGlowTargetBounds(): AwarenessGlowRect {
    return awarenessGlowBounds(this.edgeBarDisplay().bounds)
  }

  hideAwarenessGlow(): void {
    const win = this.awarenessGlowWindow
    if (win !== undefined && !win.isDestroyed()) win.hide()
  }

  isAwarenessGlowVisible(): boolean {
    const win = this.awarenessGlowWindow
    return win !== undefined && !win.isDestroyed() && win.isVisible()
  }

  /** 自测诊断：读取内部浮层的真实原生状态，不经过用户窗口 API。 */
  getAwarenessGlowDiagnostics(): AwarenessGlowDiagnostics {
    const win = this.awarenessGlowWindow
    if (win === undefined || win.isDestroyed()) {
      return { exists: false, visible: false, mousePassthrough: this.awarenessGlowMousePassthrough }
    }
    return {
      exists: true,
      visible: win.isVisible(),
      bounds: win.getBounds(),
      alwaysOnTop: win.isAlwaysOnTop(),
      focused: win.isFocused(),
      mousePassthrough: this.awarenessGlowMousePassthrough,
    }
  }

  /** 截图核对等待内部浮层首次加载完成。 */
  async whenAwarenessGlowLoaded(): Promise<void> {
    await this.awarenessGlowLoad
  }

  /** 截图核对取内部浮层窗口；正常业务只通过 show / hide 驱动，不直接操作窗口。 */
  ensureAwarenessGlowForCapture(): BrowserWindow {
    return this.ensureAwarenessGlow()
  }

  /** 截图核对给内部浮层加 query（例如 `preview=1` 强制展示静止效果）。 */
  async reloadAwarenessGlow(query: Record<string, string>): Promise<void> {
    const win = this.ensureAwarenessGlow()
    const task = this.load(win, 'awareness-glow', query)
    this.awarenessGlowLoad = task
    await task
  }

  // ───────────────────────── 流光提醒（docs/07 §2.2.3） ─────────────────────────

  /**
   * 显示一条流光提醒（`BannerService` 注入的 `present` 载体）。
   *
   * 两扇窗的分工：`banner-glow` 只在屏幕顶端画光带、整屏鼠标穿透；
   * `banner-card` 是可点的置顶卡片（关闭按钮 / 点击卡片关闭），因此**不做穿透**。
   * 合成一扇窗要么挡住整屏点击，要么卡片点不到 —— 分开是经过取舍的方案，别为了「少一扇窗」合并。
   *
   * 返回值表示「请求已交给两扇窗」：窗口加载是异步的，这里同步返回 true，
   * 真正把画面推出去在 `deliverBanner()` 里等两扇窗首次加载完成之后。
   */
  showBanner(payload: BannerShowPayload): boolean {
    const glow = this.ensureBannerGlow()
    const card = this.ensureBannerCard()
    if (glow.isDestroyed() || card.isDestroyed()) return false
    const displayBounds = this.edgeBarDisplay().bounds
    const glowBounds = awarenessGlowBounds(displayBounds)
    if (!sameBounds(glow.getBounds(), glowBounds)) glow.setBounds(glowBounds)
    const cardBounds = this.bannerCardBounds(payload, displayBounds)
    if (!sameBounds(card.getBounds(), cardBounds)) card.setBounds(cardBounds)
    void this.deliverBanner(glow, card, payload)
    return true
  }

  /** 收起流光提醒（幂等；`BannerService` 注入的 `hide` 载体）。 */
  hideBanner(): void {
    const card = this.bannerCardWindow
    if (card !== undefined && !card.isDestroyed()) card.hide()
    const glow = this.bannerGlowWindow
    if (glow !== undefined && !glow.isDestroyed()) glow.hide()
  }

  isBannerVisible(): boolean {
    const card = this.bannerCardWindow
    return card !== undefined && !card.isDestroyed() && card.isVisible()
  }

  /** 自测诊断：两个内部窗口的真实原生状态（不经过用户窗口 API）。 */
  getBannerDiagnostics(): { glow: BannerWindowDiagnostics; card: BannerWindowDiagnostics } {
    return {
      glow: this.bannerWindowDiagnostics(this.bannerGlowWindow, this.bannerGlowMousePassthrough),
      card: this.bannerWindowDiagnostics(this.bannerCardWindow, false),
    }
  }

  /** 流光提醒光带窗的**期望**几何：与 `showBanner` / `ensureBannerGlow` 同一个取屏口径。 */
  getBannerGlowTargetBounds(): AwarenessGlowRect {
    return awarenessGlowBounds(this.edgeBarDisplay().bounds)
  }

  /** 截图核对：取卡片窗（内部窗口不在 `WINDOW_NAMES` 里，只能现取）。 */
  ensureBannerForCapture(kind: 'card' | 'glow'): BrowserWindow {
    return kind === 'card' ? this.ensureBannerCard() : this.ensureBannerGlow()
  }

  /** 截图核对：等对应窗口首次加载完成。 */
  async whenBannerLoaded(kind: 'card' | 'glow'): Promise<void> {
    await (kind === 'card' ? this.bannerCardLoad : this.bannerGlowLoad)
  }

  /** 截图核对：带 query 重载（`preview=1` 让卡片渲染固定的示例内容）。 */
  async reloadBannerForCapture(
    kind: 'card' | 'glow',
    query: Record<string, string>,
  ): Promise<void> {
    const win = this.ensureBannerForCapture(kind)
    const task = this.load(win, 'banner', { layer: kind, ...query })
    if (kind === 'card') this.bannerCardLoad = task
    else this.bannerGlowLoad = task
    await task
  }

  /**
   * 按渲染层量出的**卡片内容高度**调整卡片窗（`banner:measure`）。
   *
   * 两个关键点：
   * - 窗口高度 = 卡片高度 + 24（上下各 12px 阴影外边距）**再加窗口边框差**：
   *   Windows 上无边框窗口的 `getBounds()` 比 `getContentBounds()` 多出几个像素，
   *   直接按「+24」算会让页面底部空出那几像素 —— 卡片下方就出现一条挡点击的透明死区。
   *   这里用当前窗口两种矩形的差值自校准，不写死数字。
   * - 只调高度、不动 x / y：水平居中与「贴顶下浮」由 `bannerCardBounds` 决定。
   */
  resizeBannerCard(cardHeight: number): boolean {
    const win = this.bannerCardWindow
    if (win === undefined || win.isDestroyed()) return false
    const height = Math.round(
      Math.min(BANNER_CARD.maxHeight, Math.max(BANNER_CARD.minHeight, cardHeight)),
    )
    const bounds = win.getBounds()
    const contentHeight = win.getContentBounds().height
    const frameDelta = Math.max(0, bounds.height - contentHeight)
    const target = height + BANNER_CARD.margin * 2 + frameDelta
    if (Math.abs(bounds.height - target) <= 1) return true
    win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: target })
    this.options.logger.debug('流光提醒卡片窗高度已调整', { cardHeight: height, target })
    return true
  }

  /** 截图核对：把对应窗口显示出来（不推数据，内容由 query / preview 决定）。 */
  showBannerForCapture(kind: 'card' | 'glow'): void {
    const win = kind === 'card' ? this.ensureBannerCard() : this.ensureBannerGlow()
    if (win.isDestroyed()) return
    if (kind === 'card') {
      // 卡片窗**不动几何**：高度由渲染层量完回报（`resizeBannerCard`），
      // 这里要是按估算值再 setBounds 一次，就会把刚量好的高度覆盖回估算值。
      this.reassertBannerTopmost('card', win)
      if (!win.isVisible()) win.showInactive()
      return
    }
    const bounds = awarenessGlowBounds(this.edgeBarDisplay().bounds)
    if (!sameBounds(win.getBounds(), bounds)) win.setBounds(bounds)
    this.reassertBannerTopmost('glow', win)
    if (!win.isVisible()) win.showInactive()
  }

  /**
   * 把展示载荷推给两扇窗并显示它们。
   *
   * 两条顺序都是硬要求：
   * 1. **先显示、再推送**：卡片/光带的入场是 CSS transition —— 元素必须在一个**已经可见**的
   *    页面里被插入，浏览器才会画出初始帧再过渡。窗口还藏着时先推载荷，页面拿不到绘制帧，
   *    等窗口真的 show 出来时动画已经"走完"，观感就是「啪一下出现、没有动效」。
   *    （页面在无载荷时是全透明的，先显示不会闪出空白卡片。）
   * 2. 先流光、后卡片：卡片要在流光**之上**，否则光谱光带会盖住卡片顶部。
   *
   * 推送还必须等首次加载完成 —— `show()` 之后立刻 `webContents.send` 时渲染层的
   * `onShow` 监听还没挂上，消息会被丢掉（与 `showWithPayload` 同一个坑）。
   */
  private async deliverBanner(
    glow: BrowserWindow,
    card: BrowserWindow,
    payload: BannerShowPayload,
  ): Promise<void> {
    await Promise.all([this.bannerGlowLoad, this.bannerCardLoad])
    if (glow.isDestroyed() || card.isDestroyed()) return
    // 已可见时不重复 show：反复 show 会扰动原生合成面（同 `showAwarenessGlow` 的理由）
    if (!glow.isVisible()) {
      this.reassertBannerTopmost('glow', glow)
      glow.showInactive()
    }
    if (!card.isVisible()) {
      this.reassertBannerTopmost('card', card)
      card.showInactive()
    }
    // 窗口已可见后再推载荷：渲染层插入卡片时才会有"初始态 → 终态"这一帧过渡
    glow.webContents.send(IPC.banner.show, payload)
    card.webContents.send(IPC.banner.show, payload)
  }

  /**
   * 卡片窗几何：水平居中、贴顶下浮。
   *
   * 宽度取用户设置的三档（`notifications.size`，v38）；高度仍是「内容量出来 + 24px」——
   * 这一处只给**首帧**估算（渲染层随后用 `banner:measure` 回报真实高度并覆盖它），
   * 所以按当前宽度折算每行字数，别用固定 28 字（360px 的紧凑卡会估矮、480px 的会估高）。
   */
  private bannerCardBounds(
    payload: BannerShowPayload | undefined,
    displayBounds: AwarenessGlowRect,
  ): AwarenessGlowRect {
    const body = payload?.body ?? ''
    const cardWidth = this.bannerCardWidth()
    const charsPerLine = Math.max(16, Math.floor((cardWidth - 76) / 12.6))
    const lines =
      body === ''
        ? 0
        : Math.min(BANNER_CARD.maxLines, Math.max(1, Math.ceil(body.length / charsPerLine)))
    const cardHeight =
      BANNER_CARD.baseHeight + (lines === 0 ? 0 : BANNER_CARD.gap + lines * BANNER_CARD.lineHeight)
    const width = cardWidth + BANNER_CARD.margin * 2
    const height = cardHeight + BANNER_CARD.margin * 2
    return {
      x: Math.round(displayBounds.x + (displayBounds.width - width) / 2),
      y: Math.round(displayBounds.y + BANNER_CARD.topOffset),
      width,
      height,
    }
  }

  /** 当前生效的卡片宽度（读设置，现读即生效；未知值回落标准档） */
  private bannerCardWidth(): number {
    const size = this.options.settings.get().notifications.size
    return BANNER_CARD_WIDTHS[size] ?? BANNER_CARD_WIDTHS.standard
  }

  private bannerWindowDiagnostics(
    win: BrowserWindow | undefined,
    mousePassthrough: boolean,
  ): BannerWindowDiagnostics {
    if (win === undefined || win.isDestroyed()) {
      return { exists: false, visible: false, mousePassthrough }
    }
    return {
      exists: true,
      visible: win.isVisible(),
      bounds: win.getBounds(),
      alwaysOnTop: win.isAlwaysOnTop(),
      focused: win.isFocused(),
      mousePassthrough,
    }
  }

  private reassertBannerTopmost(
    reason: 'created' | 'shown' | 'glow' | 'card',
    win: BrowserWindow,
  ): void {
    if (win.isDestroyed()) return
    try {
      win.setAlwaysOnTop(true, WindowManager.EDGE_BAR_TOP_LEVEL)
    } catch (error) {
      this.options.logger.warn('恢复流光提醒置顶失败', { reason, error: String(error) })
    }
  }

  /** 截图核对读取真实原生底色；原生玻璃窗口由材质断言接管，返回 undefined。 */
  getBackgroundColor(name: WindowName): string | undefined {
    if (this.nativeGlassWindows.has(name)) return undefined
    const win = this.windows.get(name)
    if (!win || win.isDestroyed()) return undefined
    return win.getBackgroundColor()
  }

  /** 当前窗口是否已启用 Windows 系统毛玻璃材质（供视觉验收断言）。 */
  usesNativeGlass(name: WindowName): boolean {
    return this.nativeGlassWindows.has(name)
  }

  /** 自测诊断：读取窗口原生置顶位。 */
  isAlwaysOnTop(name: WindowName): boolean | undefined {
    const win = this.windows.get(name)
    if (!win || win.isDestroyed()) return undefined
    return win.isAlwaysOnTop()
  }

  /** 自测诊断：立即走一次提示条置顶恢复逻辑并返回恢复后的原生状态。 */
  reassertEdgeBarTopForDiagnostics(): boolean | undefined {
    this.reassertEdgeBarTopmost('watchdog')
    return this.isAlwaysOnTop('edge-bar')
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
   * 显示窗口，并在**渲染层加载完成且事件订阅到位后**推送一次 payload。
   *
   * 自动化详情窗口首次创建时如果先 `show()` 再立刻 `sendTo()`，推送会早于 preload / Vue 监听，
   * 表现是“点了历史但窗口空白”。这里把顺序固定为：ensure → await load → send → show。
   */
  async showWithPayload(name: WindowName, channel: string, payload: unknown): Promise<WindowState> {
    const win = this.ensure(name)
    await this.loadTasks.get(name)
    if (win.isDestroyed()) return this.getState()

    const before = this.state
    const next = showInState(this.state, name)
    this.state = next
    for (const other of WINDOW_NAMES) {
      if (before.visible[other] === true && next.visible[other] !== true) {
        this.applyVisibility(other, false)
      }
    }
    this.sendTo(name, channel, payload)
    this.applyVisibility(name, true, win)
    this.emit()
    return this.getState()
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
      ...(this.options.iconPath === undefined ? {} : { icon: this.options.iconPath }),
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
      // 提示条是纯透明窗口：Acrylic 与系统窗口阴影都按矩形绘制，会从圆角面板后漏出来。
      // 同时关闭 thickFrame：Electron 41.3 起 frameless 窗口的外部 resize inset 会把
      // 请求的 8px 收起态夹到 33px；提示条本身不参与原生拖拽缩放，不需要这层边框。
      ...(name === 'edge-bar' ? { hasShadow: false, thickFrame: false } : {}),
      // 提示条（2026-10-11，挂原生 Acrylic 后）：**有材质才靠透明窗口看桌面**。
      // 没有材质的三条路（非 win32 / 旧 Windows / `appearance.glass = false`）一律给主题实色底，
      // 免得半透明 tint 叠在「什么都没有」的透明窗口上直接裸漏桌面。
      // 页面侧还有第二条腿：`:root[data-glass='off']` 会把 `--edge-bar-tint` 压成 `--bg-base`。
      // 其它窗口维持原语义：透明窗口与毛玻璃窗口透明，其余用主题实色。
      backgroundColor:
        name === 'edge-bar'
          ? this.glassAllowed(name)
            ? '#00000000'
            : windowBackgroundColor()
          : spec.transparent || this.glassAllowed(name)
            ? '#00000000'
            : windowBackgroundColor(),
      // Windows 的桌面模糊由系统材质提供；透明窗口里的 CSS backdrop-filter 只能模糊
      // 页面自身内容，无法模糊桌面。失败时保留 CSS `.glass` 回退。
      // ⚠️ 提示条要跟着**展开态**走（收起态页面只有 8px 竖条，别挂材质）——这里的条件必须与
      // `syncEdgeBarMaterial()` 完全一致，否则建窗时挂上、内部状态却记成「没挂」，
      // 之后收起就再也不会摘（2026-10-11 实测踩过：收起态 DWM 仍是 Acrylic）。
      ...(this.glassAllowed(name) && (name !== 'edge-bar' || this.edgeBarExpanded)
        ? { backgroundMaterial: NATIVE_WINDOW_MATERIAL }
        : {}),
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
        backgroundThrottling: this.options.backgroundThrottling ?? true,
      },
    })

    win.setMenuBarVisibility(false)
    if (name === 'edge-bar') {
      this.normalizeEdgeBarBounds(win)
      this.applyEdgeBarShape(win)
      this.reassertEdgeBarTopmost('created', false, win)
      // 提示条的材质与两态绑定（只在展开态挂），因此走同一个同步口而不是通用的 applyWindowMaterial
      this.syncEdgeBarMaterial()
    } else if (this.glassAllowed(name)) {
      this.applyWindowMaterial(name, win)
    }
    // 提示条透明度取自设置（docs/08 §1）；窗口创建时即应用，避免一次可见的跳变
    if (name === 'edge-bar') {
      this.applyEdgeBarOpacity(this.options.settings.get().general.edgeBar.opacity)
    }
    if (this.options.isDev) {
      const name$ = name
      // dev：把渲染层日志转发到主进程终端，便于排查白屏 / CSP / 脚本错误
      win.webContents.on('console-message', (details) => {
        this.options.logger.debug('[renderer] ' + details.message, {
          window: name$,
          level: details.level,
          source: `${details.sourceId}:${details.lineNumber}`,
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
     * 右栏内置浏览器的「新窗口」语义（2026-10-03，docs/07 §2.3；同日二次修订）。
     *
     * webview 刻意不带 `allowpopups`，于是 `window.open` / `target="_blank"` 默认被整个
     * 丢弃 —— 用户在搜索结果页点一条链接毫无反应（看起来就像"浏览器坏了"）。
     * 第一版把它改成**同窗内导航**（把当前页顶掉）；2026-10-03 按用户口径改为
     * **另开一个浏览器标签**：主进程只负责把 URL 转给渲染层（`browser:openTab`），
     * 由右栏标签条开出新标签 —— 站点本来要「新窗口」的语义因此被如实满足，
     * 再也不会有「点一下当前页就没了」。
     * **只放行 http(s)**：file: / 自定义协议 / `about:blank` 一律拒绝（与地址栏同一口径），
     * 沙箱与窗口管理语义不变（仍然不新开 Electron 窗口）。
     */
    if (name === 'chat') {
      /**
       * 插件页面（docs/14 §2.4）：凡是 `aurora-plugin://` 源，一律覆盖 webPreferences ——
       * 专用 preload、按插件隔离的非持久 partition、sandbox + contextIsolation、
       * 关掉 Node 与 insecure content。调用方自带的 preload / partition 不接受。
       * 普通浏览器 webview（http/https）原样放行，不受这条影响。
       */
      win.webContents.on(
        'will-attach-webview',
        (event, webPreferences: WebPreferences, params: Record<string, string>) => {
          const src = params['src'] ?? ''
          if (!isPluginPageUrl(src)) return
          const target = pluginPageTargetOf(src)
          const preload = this.options.pluginPagePreloadPath
          this.options.logger.debug('插件页面 webview 挂载请求', {
            src,
            pluginId: target?.pluginId ?? '',
            preload: preload ?? '',
          })
          if (target === null || preload === undefined) {
            event.preventDefault()
            return
          }
          delete params['preload']
          params['partition'] = `plugin-${target.pluginId}`
          // 按插件 partition 排队：同插件多标签并发挂载时仍按 will-attach 顺序取回自己的 src
          queuePluginPageSrc(params['partition'] ?? '', src)
          webPreferences.preload = preload
          webPreferences.partition = `plugin-${target.pluginId}`
          webPreferences.sandbox = true
          webPreferences.contextIsolation = true
          webPreferences.nodeIntegration = false
          webPreferences.nodeIntegrationInSubFrames = false
          webPreferences.webviewTag = false
          webPreferences.webSecurity = true
          webPreferences.allowRunningInsecureContent = false
          webPreferences.devTools = false
        },
      )
      win.webContents.on('did-attach-webview', (_event, guest) => {
        const src = takePluginPageSrcForSession(guest.session)
        this.options.logger.debug('webview 已挂载', { url: guest.getURL(), pending: src })
        if (isPluginPageUrl(src)) {
          registerPluginPageGuest(guest, win.webContents, src)
          // 独立 partition 有自己的 session：协议处理器必须逐 session 注册
          ensurePluginPageProtocol(guest.session)
          guest.on('did-fail-load', (_e, code, description, url) => {
            this.options.logger.warn('插件页面加载失败', { code, description, url })
          })
          if (this.options.isDev) {
            guest.on('console-message', (details) => {
              this.options.logger.debug('[plugin-page] ' + details.message, {
                level: details.level,
                source: `${details.sourceId}:${details.lineNumber}`,
              })
            })
          }
          const pluginId = pluginPageTargetOf(src)?.pluginId ?? ''
          void guest.loadURL(src).catch((error: unknown) => {
            this.options.logger.warn('插件页面 loadURL 失败', { src, error: String(error) })
          })
          guest.setWindowOpenHandler(() => ({ action: 'deny' }))
          guest.on('will-navigate', (event, url) => {
            if (pluginPageTargetOf(url)?.pluginId !== pluginId) event.preventDefault()
          })
          const session = guest.session
          if (!hardenPluginSessions.has(session)) {
            hardenPluginSessions.add(session)
            session.setPermissionRequestHandler((_contents, _permission, callback) =>
              callback(false),
            )
            session.setPermissionCheckHandler(() => false)
            session.on('will-download', (event) => event.preventDefault())
          }
          return
        }
        guest.setWindowOpenHandler(({ url }) => {
          if (/^https?:\/\//i.test(url)) {
            // 处理函数里 return deny 之后 guest 就与这次请求脱钩了，转交渲染层开新标签
            const target = win.webContents
            setImmediate(() => {
              if (!target.isDestroyed()) target.send(IPC.browser.openTab, { url })
            })
          }
          return { action: 'deny' }
        })
      })
    }
    if (name === 'memory') {
      // 记忆库里的 Markdown 链接不接管当前窗口：http(s) 交给系统浏览器，其余一律拒绝。
      const openExternal = (url: string): void => {
        if (!/^https?:\/\//i.test(url)) return
        void shell.openExternal(url).catch((error: unknown) => {
          this.options.logger.warn('打开记忆库外链失败', { url, error: String(error) })
        })
      }
      win.webContents.setWindowOpenHandler(({ url }) => {
        openExternal(url)
        return { action: 'deny' }
      })
      win.webContents.on('will-navigate', (event, url) => {
        const current = win.webContents.getURL()
        if (url === current) return
        event.preventDefault()
        openExternal(url)
      })
    }
    // 几何事件走**去抖 + 短路**入口（P2-08）：拖动期间不再每帧全量 mutate / 广播一次
    win.on('moved', () => this.scheduleGeometryPersist(name, win))
    win.on('resized', () => this.scheduleGeometryPersist(name, win))
    // 最大化态变化要广播：渲染层 caption 的「最大化 / 还原」图标据此切换
    //（含标题栏拖动区双击这条不经 toggleMaximize 的原生路径）
    win.on('maximize', () => this.emit())
    win.on('unmaximize', () => {
      if (this.glassAllowed(name)) this.applyWindowMaterial(name, win)
      this.emit()
    })
    if (name === 'edge-bar') {
      win.on('always-on-top-changed', (_event, isAlwaysOnTop) => {
        if (isAlwaysOnTop) return
        setImmediate(() => this.reassertEdgeBarTopmost('changed'))
      })
    }
    win.on('closed', () => {
      // 先收掉待落盘的几何定时器：窗口没了，它再去改配置就是一次"幽灵写入"
      this.cancelGeometryTimer(name)
      this.geometryBounds.delete(name)
      this.windows.delete(name)
      this.nativeGlassWindows.delete(name)
      if (name === 'edge-bar') this.edgeBarShape = []
      this.loadTasks.delete(name)
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      this.options.logger.error('渲染进程异常退出', { window: name, reason: details.reason })
      this.hide(name)
    })

    void this.trackLoad(name, win, query)
    this.installZoomShortcuts(win)
    this.windows.set(name, win)
    this.options.logger.debug('窗口已创建', { window: name, bounds })
    return win
  }

  private ensureAwarenessGlow(): BrowserWindow {
    const existing = this.awarenessGlowWindow
    if (existing !== undefined && !existing.isDestroyed()) return existing

    // 与 `showAwarenessGlow()` 同口径：建窗几何就是整块显示器（改一处要同时改两处）。
    //
    // v33（2026-10-11）：浮层从「72px 顶部条」扩到**整块显示器**以便四边流光。中部在
    // 渲染层保持全透明，窗口继续 `setIgnoreMouseEvents(true, { forward: true })`，
    // 因此它虽然覆盖全屏，仍然只做状态可视化：不截获点击、不挡提示条悬停、不挡桌面与任务栏。
    const bounds = awarenessGlowBounds(this.edgeBarDisplay().bounds)
    const win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      resizable: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      thickFrame: false,
      backgroundColor: '#00000000',
      title: 'Aurora 自感知流光',
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        devTools: this.options.isDev,
        backgroundThrottling: this.options.backgroundThrottling ?? true,
      },
    })

    win.setMenuBarVisibility(false)
    try {
      // 浮层只是状态可视化：绝不能挡住顶端标题栏、桌面图标或窗口按钮。
      win.setIgnoreMouseEvents(true, { forward: true })
      this.awarenessGlowMousePassthrough = true
    } catch (error) {
      this.awarenessGlowMousePassthrough = false
      this.options.logger.warn('自感知流光鼠标穿透不可用', { error: String(error) })
    }
    this.reassertAwarenessGlowTopmost('created', win)

    win.on('always-on-top-changed', (_event, isAlwaysOnTop) => {
      if (isAlwaysOnTop) return
      setImmediate(() => this.reassertAwarenessGlowTopmost('changed', this.awarenessGlowWindow))
    })
    win.on('closed', () => {
      if (this.awarenessGlowWindow === win) {
        this.awarenessGlowWindow = undefined
        this.awarenessGlowLoad = undefined
        this.awarenessGlowMousePassthrough = false
      }
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      this.options.logger.error('自感知流光渲染进程异常退出', { reason: details.reason })
      if (!win.isDestroyed()) win.destroy()
    })

    this.awarenessGlowWindow = win
    this.awarenessGlowLoad = this.load(win, 'awareness-glow')
    this.options.logger.debug('自感知流光窗口已创建', { bounds })
    return win
  }

  /**
   * 流光提醒的**光带窗**（docs/07 §2.2.3）：覆盖整块显示器、完全鼠标穿透，
   * 只在屏幕顶端画一条光谱流光带。窗口参数照抄 `ensureAwarenessGlow`（同一套已验证的形状），
   * 但**不复用它的窗口、类名或关键帧** —— 两者各自独立驱动，避免互相污染。
   */
  private ensureBannerGlow(): BrowserWindow {
    const existing = this.bannerGlowWindow
    if (existing !== undefined && !existing.isDestroyed()) return existing

    const bounds = awarenessGlowBounds(this.edgeBarDisplay().bounds)
    const win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      resizable: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      thickFrame: false,
      backgroundColor: '#00000000',
      title: 'Aurora 流光提醒',
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        devTools: this.options.isDev,
        backgroundThrottling: this.options.backgroundThrottling ?? true,
      },
    })

    win.setMenuBarVisibility(false)
    try {
      // 覆盖整屏的浮层绝不能截获点击（同 `setIgnoreMouseEvents(true, { forward: true })` 的既有口径）
      win.setIgnoreMouseEvents(true, { forward: true })
      this.bannerGlowMousePassthrough = true
    } catch (error) {
      this.bannerGlowMousePassthrough = false
      this.options.logger.warn('流光提醒光带窗鼠标穿透不可用', { error: String(error) })
    }
    this.reassertBannerTopmost('created', win)

    win.on('always-on-top-changed', (_event, isAlwaysOnTop) => {
      if (isAlwaysOnTop) return
      setImmediate(() => {
        const current = this.bannerGlowWindow
        if (current !== undefined && !current.isDestroyed()) {
          this.reassertBannerTopmost('glow', current)
        }
      })
    })
    win.on('closed', () => {
      if (this.bannerGlowWindow === win) {
        this.bannerGlowWindow = undefined
        this.bannerGlowLoad = undefined
        this.bannerGlowMousePassthrough = false
      }
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      this.options.logger.error('流光提醒光带窗渲染进程异常退出', { reason: details.reason })
      if (!win.isDestroyed()) win.destroy()
    })

    this.bannerGlowWindow = win
    this.bannerGlowLoad = this.load(win, 'banner', { layer: 'glow' })
    this.options.logger.debug('流光提醒光带窗已创建', { bounds })
    return win
  }

  /**
   * 流光提醒的**卡片窗**：紧凑置顶卡片，`focusable: false` + `showInactive()`（不抢焦点），
   * 但**不做鼠标穿透** —— 卡片上的关闭按钮要能点。
   */
  private ensureBannerCard(): BrowserWindow {
    const existing = this.bannerCardWindow
    if (existing !== undefined && !existing.isDestroyed()) return existing

    const bounds = this.bannerCardBounds(undefined, this.edgeBarDisplay().bounds)
    const win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      resizable: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      thickFrame: false,
      backgroundColor: '#00000000',
      title: 'Aurora 流光提醒卡片',
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        devTools: this.options.isDev,
        backgroundThrottling: this.options.backgroundThrottling ?? true,
      },
    })

    win.setMenuBarVisibility(false)
    this.reassertBannerTopmost('created', win)
    win.on('always-on-top-changed', (_event, isAlwaysOnTop) => {
      if (isAlwaysOnTop) return
      setImmediate(() => {
        const current = this.bannerCardWindow
        if (current !== undefined && !current.isDestroyed()) {
          this.reassertBannerTopmost('card', current)
        }
      })
    })
    win.on('closed', () => {
      if (this.bannerCardWindow === win) {
        this.bannerCardWindow = undefined
        this.bannerCardLoad = undefined
      }
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      this.options.logger.error('流光提醒卡片窗渲染进程异常退出', { reason: details.reason })
      if (!win.isDestroyed()) win.destroy()
    })

    this.bannerCardWindow = win
    this.bannerCardLoad = this.load(win, 'banner', { layer: 'card' })
    this.options.logger.debug('流光提醒卡片窗已创建', { bounds })
    return win
  }

  /**
   * 应用提示条透明度（docs/07 §2.2、docs/08 §1 `general.edgeBar.opacity`）。
   *
   * 只对已创建的窗口生效；窗口尚未创建时跳过（创建时会在 `ensure()` 里按当前值设置），
   * 因此这里不需要「记住待应用值」——`index.ts` 在每次设置变更与启动时都会调用一次。
   */
  // ───────────────────────── Computer Use 浮层（v39，docs/06 §28） ─────────────────────────

  /**
   * 显示 Computer Use 浮层：每块显示器一扇透明窗 + 一块**顶部**操作过程面板。
   *
   * 三条硬口径：`showInactive()`（绝不抢用户当前应用的焦点）、
   * `setIgnoreMouseEvents(true, { forward: true })`（透明 ≠ 穿透，必须显式开）、
   * **不用内容保护**（远程桌面 / 屏幕共享下会完全不可见）；进入操作模式后一直显示，
   * 用户要求「特效与提示框一直在场、实时更新」，因此不再在截屏时隐藏它们。
   */
  async showComputerUseOverlays(
    displays: ReadonlyArray<{ id: number; bounds: WindowBounds }>,
  ): Promise<void> {
    const cfg = this.options.settings.get().computerUse
    const loads: Promise<void>[] = []
    const wanted = new Set(displays.map((display) => display.id))
    if (cfg.showVirtualCursor || cfg.glow) {
      for (const display of displays) {
        const entry = this.ensureComputerUseOverlay(display.id, display.bounds)
        loads.push(entry.load)
      }
      for (const [id, entry] of this.computerUseOverlays) {
        if (wanted.has(id)) continue
        if (!entry.win.isDestroyed()) entry.win.hide()
      }
    }
    if (cfg.showHud) {
      const hud = this.ensureComputerUseHud()
      loads.push(this.computerUseHudLoad ?? Promise.resolve())
      if (!hud.isDestroyed()) {
        hud.setBounds(this.computerUseHudBounds())
      }
    } else {
      this.hideComputerUseHud()
    }
    await Promise.all(loads)
    if (cfg.showVirtualCursor || cfg.glow) {
      for (const display of displays) {
        const entry = this.computerUseOverlays.get(display.id)
        if (entry === undefined || entry.win.isDestroyed()) continue
        if (!entry.win.isVisible()) {
          this.reassertComputerUseTopmost(entry.win)
          entry.win.showInactive()
        }
      }
    }
    if (cfg.showHud) {
      const hud = this.computerUseHudWindow
      if (hud !== undefined && !hud.isDestroyed() && !hud.isVisible()) {
        this.reassertComputerUseTopmost(hud)
        hud.showInactive()
      }
    }
    this.installComputerUseDisplayListener()
    this.options.logger.debug('Computer Use 浮层已显示', {
      displays: displays.map((display) => display.id),
      hud: cfg.showHud,
      cursor: cfg.showVirtualCursor,
      glow: cfg.glow,
    })
  }

  hideComputerUseOverlays(): void {
    for (const entry of this.computerUseOverlays.values()) {
      if (!entry.win.isDestroyed()) entry.win.hide()
    }
    this.hideComputerUseHud()
    this.removeComputerUseDisplayListener()
  }

  /** 把 Computer Use 事件推给需要的窗口；光标事件只发浮层（避免 30fps 打醒对话窗）。 */
  emitComputerUse(event: ComputerUseEvent): void {
    if (event.type === 'cursor') {
      for (const entry of this.computerUseOverlays.values()) {
        if (!entry.win.isDestroyed()) entry.win.webContents.send(IPC.computerUse.event, event)
      }
      return
    }
    this.broadcast(IPC.computerUse.event, event)
  }

  applyComputerUseConfig(config: ComputerUseSettings): void {
    if (!config.showHud) this.hideComputerUseHud()
    if (!config.showVirtualCursor && !config.glow) {
      for (const entry of this.computerUseOverlays.values()) {
        if (!entry.win.isDestroyed()) entry.win.hide()
      }
      if (!config.showHud) return
    }
    const displays = screen.getAllDisplays().map((display) => ({
      id: display.id,
      bounds: {
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
      },
    }))
    void this.showComputerUseOverlays(displays)
  }

  getComputerUseDiagnostics(): {
    visible: boolean
    displays: number
    overlays: Array<{
      displayId: number
      visible: boolean
      alwaysOnTop: boolean
      focusable: boolean
      contentProtected: boolean
      mousePassthrough: boolean
      bounds?: WindowBounds
    }>
    hud: {
      exists: boolean
      visible: boolean
      focusable: boolean
      contentProtected: boolean
      mousePassthrough: boolean
      bounds?: WindowBounds
    }
  } {
    const overlays = [...this.computerUseOverlays.entries()].map(([displayId, entry]) => ({
      displayId,
      visible: !entry.win.isDestroyed() && entry.win.isVisible(),
      alwaysOnTop: !entry.win.isDestroyed() && entry.win.isAlwaysOnTop(),
      focusable: !entry.win.isDestroyed() && entry.win.isFocusable(),
      contentProtected: entry.contentProtected,
      mousePassthrough: entry.mousePassthrough,
      ...(entry.win.isDestroyed() ? {} : { bounds: entry.win.getBounds() }),
    }))
    const hud = this.computerUseHudWindow
    return {
      visible:
        overlays.some((item) => item.visible) ||
        (hud !== undefined && !hud.isDestroyed() && hud.isVisible()),
      displays: overlays.length,
      overlays,
      hud:
        hud === undefined || hud.isDestroyed()
          ? {
              exists: false,
              visible: false,
              focusable: false,
              contentProtected: false,
              mousePassthrough: this.computerUseHudMousePassthrough,
            }
          : {
              exists: true,
              visible: hud.isVisible(),
              focusable: hud.isFocusable(),
              contentProtected: this.computerUseHudContentProtected,
              mousePassthrough: this.computerUseHudMousePassthrough,
              bounds: hud.getBounds(),
            },
    }
  }

  /** 截图核对：取主显示器浮层 / HUD。 */
  ensureComputerUseForCapture(kind: 'overlay' | 'hud'): BrowserWindow {
    if (kind === 'hud') return this.ensureComputerUseHud()
    const display = this.edgeBarDisplay()
    return this.ensureComputerUseOverlay(display.id, display.bounds).win
  }

  async whenComputerUseLoaded(kind: 'overlay' | 'hud'): Promise<void> {
    if (kind === 'hud') {
      await this.computerUseHudLoad
      return
    }
    const display = this.edgeBarDisplay()
    const entry = this.computerUseOverlays.get(display.id)
    await entry?.load
  }

  async reloadComputerUseForCapture(
    kind: 'overlay' | 'hud',
    query: Record<string, string>,
  ): Promise<void> {
    if (kind === 'hud') {
      const win = this.ensureComputerUseHud()
      const task = this.load(win, 'computer-use', { layer: 'hud', ...query })
      this.computerUseHudLoad = task
      await task
      return
    }
    const display = this.edgeBarDisplay()
    const entry = this.ensureComputerUseOverlay(display.id, display.bounds)
    const task = this.load(entry.win, 'computer-use', {
      layer: 'overlay',
      displayId: String(display.id),
      ...query,
    })
    entry.load = task
    await task
  }

  showComputerUseForCapture(kind: 'overlay' | 'hud'): void {
    const win = this.ensureComputerUseForCapture(kind)
    if (win.isDestroyed()) return
    if (kind === 'overlay') {
      const display = this.edgeBarDisplay()
      if (!sameBounds(win.getBounds(), display.bounds)) win.setBounds(display.bounds)
    } else {
      win.setBounds(this.computerUseHudBounds())
    }
    this.reassertComputerUseTopmost(win)
    if (!win.isVisible()) win.showInactive()
  }

  private computerUseHudContentProtected = false

  private ensureComputerUseOverlay(
    displayId: number,
    bounds: WindowBounds,
  ): {
    win: BrowserWindow
    load: Promise<void>
    mousePassthrough: boolean
    contentProtected: boolean
  } {
    const existing = this.computerUseOverlays.get(displayId)
    if (existing !== undefined && !existing.win.isDestroyed()) {
      if (!sameBounds(existing.win.getBounds(), bounds)) existing.win.setBounds(bounds)
      return existing
    }
    const win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      resizable: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      thickFrame: false,
      backgroundColor: '#00000000',
      title: 'Aurora Computer Use',
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        devTools: this.options.isDev,
        backgroundThrottling: false,
      },
    })
    win.setMenuBarVisibility(false)
    let mousePassthrough = false
    try {
      win.setIgnoreMouseEvents(true, { forward: true })
      mousePassthrough = true
    } catch (error) {
      this.options.logger.warn('Computer Use 浮层鼠标穿透不可用', { error: String(error) })
    }
    // 不再使用 `setContentProtection(true)`：WDA_EXCLUDEFROMCAPTURE 会让窗口在远程桌面 /
    // 屏幕共享（本机实测 RustDesk）里直接不可见，用户就看不到光标、流光与过程面板。
    // 浮层在操作期间**持续显示**，不再为截图隐藏。
    const contentProtected = false
    this.reassertComputerUseTopmost(win)
    win.on('always-on-top-changed', (_event, isAlwaysOnTop) => {
      if (isAlwaysOnTop) return
      setImmediate(() => this.reassertComputerUseTopmost(win))
    })
    win.on('closed', () => {
      this.computerUseOverlays.delete(displayId)
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      this.options.logger.error('Computer Use 浮层渲染进程异常退出', { reason: details.reason })
      if (!win.isDestroyed()) win.destroy()
    })
    const entry = {
      win,
      load: this.load(win, 'computer-use', {
        layer: 'overlay',
        displayId: String(displayId),
      }),
      mousePassthrough,
      contentProtected,
    }
    this.computerUseOverlays.set(displayId, entry)
    this.options.logger.debug('Computer Use 浮层窗口已创建', { displayId, bounds })
    return entry
  }

  private ensureComputerUseHud(): BrowserWindow {
    const existing = this.computerUseHudWindow
    if (existing !== undefined && !existing.isDestroyed()) return existing
    const bounds = this.computerUseHudBounds()
    const win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      resizable: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      thickFrame: false,
      backgroundColor: '#00000000',
      title: 'Aurora Computer Use HUD',
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        devTools: this.options.isDev,
        backgroundThrottling: false,
      },
    })
    win.setMenuBarVisibility(false)
    try {
      win.setIgnoreMouseEvents(true, { forward: true })
      this.computerUseHudMousePassthrough = true
    } catch (error) {
      this.computerUseHudMousePassthrough = false
      this.options.logger.warn('Computer Use HUD 鼠标穿透不可用', { error: String(error) })
    }
    // 同浮层：内容保护会让远程桌面看不到过程面板；改由截图前临时隐藏来保证不进截图。
    this.computerUseHudContentProtected = false
    this.reassertComputerUseTopmost(win)
    win.on('closed', () => {
      if (this.computerUseHudWindow === win) {
        this.computerUseHudWindow = undefined
        this.computerUseHudLoad = undefined
      }
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      this.options.logger.error('Computer Use HUD 渲染进程异常退出', { reason: details.reason })
      if (!win.isDestroyed()) win.destroy()
    })
    this.computerUseHudWindow = win
    this.computerUseHudLoad = this.load(win, 'computer-use', { layer: 'hud' })
    return win
  }

  private hideComputerUseHud(): void {
    const win = this.computerUseHudWindow
    if (win !== undefined && !win.isDestroyed()) win.hide()
  }

  private computerUseHudBounds(): WindowBounds {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    // 置顶操作过程面板：贴在目标显示器顶部居中（不是底部）。窗口 = 卡片，透明区不拦截鼠标。
    const width = 560
    const height = 116
    return {
      x: Math.round(display.bounds.x + (display.bounds.width - width) / 2),
      y: Math.round(display.bounds.y + 20),
      width,
      height,
    }
  }

  private reassertComputerUseTopmost(win: BrowserWindow): void {
    if (win.isDestroyed()) return
    try {
      win.setAlwaysOnTop(true, 'screen-saver')
    } catch (error) {
      this.options.logger.warn('恢复 Computer Use 浮层置顶失败', { error: String(error) })
    }
  }

  private installComputerUseDisplayListener(): void {
    if (this.computerUseDisplayListener !== undefined) return
    const rebuild = (): void => {
      if (this.computerUseOverlays.size === 0) return
      const displays = screen.getAllDisplays().map((display) => ({
        id: display.id,
        bounds: {
          x: display.bounds.x,
          y: display.bounds.y,
          width: display.bounds.width,
          height: display.bounds.height,
        },
      }))
      void this.showComputerUseOverlays(displays)
    }
    screen.on('display-added', rebuild)
    screen.on('display-removed', rebuild)
    screen.on('display-metrics-changed', rebuild)
    this.computerUseDisplayListener = rebuild
  }

  private removeComputerUseDisplayListener(): void {
    const listener = this.computerUseDisplayListener
    if (listener === undefined) return
    screen.off('display-added', listener)
    screen.off('display-removed', listener)
    screen.off('display-metrics-changed', listener)
    this.computerUseDisplayListener = undefined
  }

  /** 全窗口广播（Computer Use 状态条 / 设置页 / 插件面板都能收到）。 */
  broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  }

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

  /**
   * 应用窗口原生材质。
   *
   * 常规窗口使用 Acrylic。Electron 44 已修复系统最大化期间的 DWM 材质更新，
   * 因此最大化不再需要退出材质或改写窗口几何。
   */
  private applyWindowMaterial(name: WindowName, win: BrowserWindow): void {
    if (!this.glassAllowed(name) || win.isDestroyed()) return
    try {
      win.setBackgroundColor('#00000000')
      win.setBackgroundMaterial(NATIVE_WINDOW_MATERIAL)
      this.nativeGlassWindows.add(name)
    } catch (error) {
      this.nativeGlassWindows.delete(name)
      // 回退判据就是「这个窗口本来在材质名单里」——不要再手抄一份名单：
      // 漏掉某一个（2026-10-11 的 edge-bar 就是这种）会让它落在「既不透明也没材质」的裸漏态。
      if (NATIVE_GLASS_WINDOWS.has(name)) {
        win.setBackgroundColor(windowBackgroundColor())
      }
      this.options.logger.debug('系统毛玻璃材质不可用，回退不透明窗口底色', {
        window: name,
        error: String(error),
      })
    }
  }

  /**
   * 摘掉窗口原生材质，改回不透明主题底色（v32 的「关闭毛玻璃」）。
   *
   * 两步分开 try：`setBackgroundMaterial` 在非 win32 / 旧 Windows 上可能抛错，
   * 但那**不能**拦住底色回退 —— 否则会出现"材质没挂上、底色又是透明的"的裸漏桌面。
   */
  private dropWindowMaterial(name: WindowName, win: BrowserWindow): void {
    try {
      win.setBackgroundMaterial('none')
    } catch (error) {
      this.options.logger.debug('卸载窗口材质失败，继续回退底色', {
        window: name,
        error: String(error),
      })
    }
    try {
      win.setBackgroundColor(windowBackgroundColor())
    } catch (error) {
      this.options.logger.debug('回退窗口底色失败', { window: name, error: String(error) })
    }
    this.nativeGlassWindows.delete(name)
  }

  /**
   * 提示条的材质开关（2026-10-11）：**只在展开态挂**。
   *
   * 收起态页面里只有 8px 竖条，而 DWM 的系统材质会铺满**整个窗口矩形**
   *（实测 `setWindowRgn` 裁不住它：收起态 shape 只有 8×200 时，材质仍铺满 337×976），
   * 不摘掉就会在桌面右缘留下一条「看不见内容却看得见模糊」的带子。
   *
   * 刻意**不复用** `dropWindowMaterial`：那个会把窗口底色设成不透明主题色（对普通窗口是对的，
   * 对提示条会变成一块实色矩形）。这里摘材质时把底色恢复成透明。
   */
  private syncEdgeBarMaterial(): void {
    const win = this.windows.get('edge-bar')
    if (win === undefined || win.isDestroyed()) return
    const wanted = this.glassAllowed('edge-bar') && this.edgeBarExpanded
    if (wanted === this.nativeGlassWindows.has('edge-bar')) return
    if (wanted) {
      this.applyWindowMaterial('edge-bar', win)
      return
    }
    try {
      win.setBackgroundMaterial('none')
    } catch (error) {
      this.options.logger.debug('卸载提示条材质失败', { error: String(error) })
    }
    try {
      win.setBackgroundColor('#00000000')
    } catch (error) {
      this.options.logger.debug('恢复提示条透明底色失败', { error: String(error) })
    }
    this.nativeGlassWindows.delete('edge-bar')
  }

  /**
   * 按 `appearance.glass` 即时切换**已创建窗口**的原生材质（v32，docs/07 §5.1）。
   *
   * 三条口径：
   * - **幂等**：目标状态与当前一致就什么都不做 —— 任何一次配置变更都会走到这里，
   *   反复重挂 Acrylic 会白白触发 DWM 材质更新（历史上最大化灰态正是这条路线的副作用）；
   * - 未创建的窗口不处理：`ensure()` 建窗时会现读 `glassAllowed()` 取正确值；
   * - 只碰原生材质，页面内的 CSS 玻璃由渲染层的 `data-glass="off"` 降级负责（同一份配置驱动）。
   */
  applyGlass(enabled: boolean): void {
    for (const name of NATIVE_GLASS_WINDOWS) {
      const win = this.windows.get(name)
      if (win === undefined || win.isDestroyed()) continue
      // 提示条多一道「展开态」条件（收起态不该有材质），统一交给它的同步口
      if (name === 'edge-bar') {
        this.syncEdgeBarMaterial()
        continue
      }
      if (enabled === this.nativeGlassWindows.has(name)) continue
      if (enabled) this.applyWindowMaterial(name, win)
      else this.dropWindowMaterial(name, win)
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
    // 提示条隐藏时收回竖条尺寸：否则下次显示会残留展开态的 328px 宽，
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
   * 提示条收起态（8px 竖条）/ 展开态（328px 全高面板）切换（docs/07 §2.2）。
   *
   * 宿主窗口始终保持在展开态尺寸，这里只换原生 shape，**不动可见性、不广播状态变化**。
   * 这样面板的滑入 / 淡出完全由渲染层合成动画完成，不会出现原生窗口尺寸瞬切。
   * 窗口尚未创建时只记录标记，下次 `show()` 会按标记建窗。
   *
   * 展开态要跟着长高：面板里的四块信息 + 三个操作按钮在 200px 高度里装不下，
   * 按钮会被挤到可视区之外（实测按钮 top=278、窗口高 202）——用户看得到面板却点不到按钮。
   */
  setEdgeBarExpanded(expanded: boolean): WindowState {
    this.edgeBarExpanded = expanded
    const win = this.windows.get('edge-bar')
    if (!win || win.isDestroyed()) return this.getState()
    this.normalizeEdgeBarBounds(win)
    this.applyEdgeBarShape(win)
    // 材质只在展开态挂（收起态页面只有 8px 竖条，材质却会铺满整窗 —— 见 syncEdgeBarMaterial）
    this.syncEdgeBarMaterial()
    this.reassertEdgeBarTopmost(expanded ? 'expanded' : 'collapsed')
    return this.getState()
  }

  /**
   * 把提示条按可见锚点贴回工作区边缘。
   *
   * 宿主始终按展开尺寸请求，Electron 44 的透明窗口最小宽度不会再参与两态切换。
   * 布局仍把 `.strip` 放在窗口右缘，因此这里以**实际宽度**重算 x：
   * 右侧模式让窗口右缘贴工作区右缘，左侧模式让窗口左缘贴工作区左缘；多余透明区域
   * 由 `applyEdgeBarShape()` 裁掉，既不可见也不接收鼠标。
   */
  private normalizeEdgeBarBounds(win: BrowserWindow): void {
    if (win.isDestroyed()) return
    const area = this.edgeBarDisplay().workArea
    const current = win.getBounds()
    const x = this.edgeBarSide() === 'left' ? area.x : area.x + area.width - current.width
    const maxY = Math.max(area.y, area.y + area.height - current.height)
    const y = clamp(Math.round(area.y + (area.height - current.height) / 2), area.y, maxY)
    if (current.x !== x || current.y !== y) win.setBounds({ ...current, x, y })
  }

  /** 按当前两态切换原生 shape；收起只留 8×200px，展开覆盖完整面板。 */
  private applyEdgeBarShape(win: BrowserWindow): void {
    if (win.isDestroyed()) return
    if (process.platform !== 'win32' && process.platform !== 'linux') return
    const bounds = win.getBounds()
    const shape = edgeBarShape(bounds, this.edgeBarExpanded)
    win.setShape(shape)
    this.edgeBarShape = shape
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

  /** 切换系统最大化（标题栏双击 / caption 按钮）。最大化期间几何不落盘。 */
  toggleMaximize(name: WindowName): WindowState {
    const win = this.windows.get(name)
    if (win === undefined || win.isDestroyed() || !SPECS[name].maximizable) {
      return this.getState()
    }
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    this.emit()
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
   * 把窗口带回前台（显式抢焦点）：状态机显示 → 从最小化恢复 → 激活。
   *
   * 与 `focus()` 的分工：`focus()` 是「确保可见并请求焦点」，不还原最小化状态
   * （Windows 下对最小化窗口调 `show()` 不会退出最小化）。任务完成要把结果送到用户
   * 眼前，而用户很可能把主界面最小化在任务栏里，必须显式 `restore()`。
   *
   * 只给「Agent 主动退出 Computer Use」这类**用户明确期待被打断**的场景用；
   * 小组件 / 提醒 / 普通推送仍走 `showInactive()`，不得抢焦点。
   */
  bringToFront(name: WindowName): WindowState {
    const state = this.show(name)
    const win = this.ensure(name)
    if (win.isMinimized()) win.restore()
    win.focus()
    return state
  }

  /**
   * 窗口当前是否持有键盘焦点（未创建 / 已销毁 = false）。
   *
   * 与 `isVisible` 的区别：可见但被压在下层（用户点了别的应用）时它是 false ——
   * `ask_user` 的流光提醒正靠这条判定「用户是不是正看着卡片」，两条都要用上。
   */
  isFocused(name: WindowName): boolean {
    const win = this.windows.get(name)
    return win !== undefined && !win.isDestroyed() && win.isFocused()
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

  /**
   * 指定窗口的 `webContents.id`（未创建 / 已销毁时 undefined）。
   *
   * 内置浏览器用它校验渲染层上报的 webview guest 归属
   * （`guest.hostWebContents.id` 必须等于 chat 的 id，docs/06 §27）——
   * 不能只信渲染层上报的数字，否则主进程会把任意 guest 当成自己的浏览器。
   */
  webContentsId(name: WindowName): number | undefined {
    const win = this.windows.get(name)
    if (win === undefined || win.isDestroyed()) return undefined
    return win.webContents.id
  }

  /** 退出前：允许窗口真正关闭并落盘几何信息。 */
  prepareQuit(): void {
    this.disposeThemeListener()
    this.disposeEdgeBarTopWatchdog()
    this.quitting = true
    const glow = this.awarenessGlowWindow
    if (glow !== undefined && !glow.isDestroyed()) glow.hide()
    // 流光提醒的内部窗口同样只隐藏（退出流程里不销毁窗口，避免拖慢 app.quit）
    this.hideBanner()
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
    this.disposeEdgeBarTopWatchdog()
    this.quitting = true
    for (const name of [...this.geometryTimers.keys()]) this.cancelGeometryTimer(name)
    const glow = this.awarenessGlowWindow
    if (glow !== undefined && !glow.isDestroyed()) glow.destroy()
    this.awarenessGlowWindow = undefined
    this.awarenessGlowLoad = undefined
    for (const win of [this.bannerGlowWindow, this.bannerCardWindow]) {
      if (win !== undefined && !win.isDestroyed()) win.destroy()
    }
    this.bannerGlowWindow = undefined
    this.bannerGlowLoad = undefined
    this.bannerGlowMousePassthrough = false
    this.bannerCardWindow = undefined
    this.bannerCardLoad = undefined
    this.removeComputerUseDisplayListener()
    for (const entry of this.computerUseOverlays.values()) {
      if (!entry.win.isDestroyed()) entry.win.destroy()
    }
    this.computerUseOverlays.clear()
    if (this.computerUseHudWindow !== undefined && !this.computerUseHudWindow.isDestroyed()) {
      this.computerUseHudWindow.destroy()
    }
    this.computerUseHudWindow = undefined
    this.computerUseHudLoad = undefined
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.destroy()
    }
    this.windows.clear()
  }

  // ───────────────────────── 内部 ─────────────────────────

  private async load(
    win: BrowserWindow,
    name: WindowName | InternalWindowName,
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
      if (name === 'edge-bar') {
        win.showInactive()
        this.reassertEdgeBarTopmost('shown', true)
      } else win.show()
    } else {
      win.hide()
    }
  }

  /**
   * 自家窗口的缩放快捷键。
   *
   * Electron 默认菜单被隐藏后，`Ctrl + 加号` 在不同键盘布局下不一定走 Chromium 内置动作；
   * 这里统一接管 `Ctrl +/-/0`，并在刷新后恢复当前倍率。
   */
  private installZoomShortcuts(win: BrowserWindow): void {
    const contents = win.webContents
    const contentsId = contents.id
    contents.on('before-input-event', (event, input) => {
      const action = zoomActionForInput(input)
      if (action === undefined) return
      event.preventDefault()
      const current = contents.getZoomFactor()
      const next = action === 'reset' ? 1 : clamp(current + (action === 'in' ? 0.1 : -0.1), 0.5, 3)
      contents.setZoomFactor(next)
      this.zoomFactors.set(contentsId, next)
      this.options.logger.debug('窗口缩放快捷键', {
        window: win.getTitle(),
        action,
        factor: next,
      })
    })
    contents.on('did-finish-load', () => {
      const factor = this.zoomFactors.get(contentsId)
      if (factor !== undefined && factor !== 1) contents.setZoomFactor(factor)
    })
    contents.once('destroyed', () => {
      this.zoomFactors.delete(contentsId)
    })
  }

  /** 复位提示条折叠标记并收回原生 shape（窗口不存在时只清标记）。 */
  private collapseEdgeBar(): void {
    if (!this.edgeBarExpanded) return
    this.edgeBarExpanded = false
    const win = this.windows.get('edge-bar')
    if (!win || win.isDestroyed()) return
    this.normalizeEdgeBarBounds(win)
    this.applyEdgeBarShape(win)
    this.reassertEdgeBarTopmost('collapsed')
  }

  private disposeEdgeBarTopWatchdog(): void {
    if (this.edgeBarTopWatchdog === undefined) return
    clearInterval(this.edgeBarTopWatchdog)
    this.edgeBarTopWatchdog = undefined
  }

  private reassertEdgeBarTopmost(
    reason: 'created' | 'shown' | 'expanded' | 'collapsed' | 'changed' | 'watchdog',
    moveTop = false,
    winOverride?: BrowserWindow,
  ): void {
    const win = winOverride ?? this.windows.get('edge-bar')
    if (win === undefined || win.isDestroyed()) return
    try {
      win.setAlwaysOnTop(true, WindowManager.EDGE_BAR_TOP_LEVEL)
      if (moveTop) win.moveTop()
    } catch (error) {
      this.options.logger.warn('恢复提示条置顶失败', { reason, error: String(error) })
    }
  }

  private reassertAwarenessGlowTopmost(
    reason: 'created' | 'shown' | 'changed',
    winOverride?: BrowserWindow,
  ): void {
    const win = winOverride ?? this.awarenessGlowWindow
    if (win === undefined || win.isDestroyed()) return
    try {
      win.setAlwaysOnTop(true, WindowManager.EDGE_BAR_TOP_LEVEL)
    } catch (error) {
      this.options.logger.warn('恢复自感知流光置顶失败', { reason, error: String(error) })
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
        // 提示条：贴工作区配置侧边缘、垂直居中，宽度按折叠态（收起 8 / 展开 328）。
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

  /** 窗口当前应采用的尺寸：提示条固定使用展开态宿主，其余取 SPECS 固定尺寸。 */
  private sizeFor(name: WindowName): { width: number; height: number } {
    const spec = SPECS[name]
    if (name === 'edge-bar') {
      // 宿主高度跟工作区走（全高面板），两态只换 shape，所以这里始终读贴附显示器。
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
      // 复用会踩两个坑：收起态继承展开态的 328px 宽（屏幕右侧留下看不见却挡鼠标的区域）；
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
   * - 最大化态：工作区尺寸不是用户拖出来的，落盘会把「还原后的窗口」撑满整屏 —— 只记录用户手动
   *   调整出来的常规几何，还原尺寸交给逻辑最大化 / `isMaximized` 判定。
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
    memory: 'Aurora 记忆库',
    automation: 'Aurora 自动化',
    'plugin-config': 'Aurora 插件配置',
    onboarding: 'Aurora 首次引导',
  }
  return titles[name]
}
