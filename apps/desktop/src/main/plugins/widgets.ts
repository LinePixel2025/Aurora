/**
 * 桌面小组件窗口（docs/14 §5.3）。
 *
 * 每个可见的桌面小组件一张**无边框、透明、置顶、不占任务栏**的浮动卡片；
 * 位置 / 尺寸 / 显隐写在 `<userData>/plugin-widget-layout.json`，**不进 settings**。
 *
 * 本文件是**唯一**为小组件创建窗口、import electron 的访问层：
 * `PluginManager` 只给出声明式贡献，装配层（`main/index.ts`）负责把两者接起来。
 *
 * 非目标：壁纸层嵌入、任意全屏画布、点击穿透（见 docs/14 §5.3）。
 */
import { join } from 'node:path'
import { screen, BrowserWindow, type Session } from 'electron'
import {
  IPC,
  PLUGIN_WIDGET_WINDOW_LEVELS,
  type Logger,
  type PluginWidgetInfo,
  type PluginWidgetLayout,
  type PluginWidgetLayoutEntry,
  type PluginWidgetWindowLevel,
  type PluginWidgetWindowMaterial,
  type WidgetWindowDiagnostics,
} from '@aurora/shared'
import { ensurePluginPageProtocol, registerPluginPageGuest } from '../page-protocol.js'
import { isPluginPageUrl, pluginPageTargetOf } from '../plugin-page-url.js'
import {
  clampWidgetBounds,
  defaultWidgetEntry,
  readWidgetLayout,
  writeWidgetLayout,
  WIDGET_MIN_HEIGHT,
  WIDGET_MIN_WIDTH,
} from './widget-layout.js'
import { attachDesktopOwner, detachDesktopOwner } from './widget-desktop-layer.js'
import {
  nativeHandleToNumber,
  resolveWidgetWindowLevel,
  shouldUseWidgetMaterial,
  widgetRoundedShape,
  WIDGET_CARD_RADIUS,
} from './widget-window.js'

/** 同时存在的桌面小组件窗口上限（防失控常量，不做成设置项）。 */
export const PLUGIN_WIDGET_MAX_WINDOWS = 8

const PERSIST_DEBOUNCE_MS = 250

export interface WidgetManagerOptions {
  userData: string
  logger: Logger
  isDev: boolean
  /** 主 preload（暴露 `window.aurora`） */
  preloadPath: string
  /** 插件页面专用 preload */
  pluginPagePreloadPath?: string
  /** dev 下的 renderer 服务地址；为空表示加载打包后的 HTML */
  rendererUrl?: string
  rendererDir: string
  /** 按启用 + `ui.widgets` 权限过滤后的桌面小组件 */
  contributions: () => PluginWidgetInfo[]
  /** 用户外观总开关；false 时所有小组件保持不透明（v37） */
  glassAllowed: () => boolean
  /** 平台门控（默认 process.platform；单测 / 诊断可注入） */
  platform?: NodeJS.Platform
  /** 桌面层 owner 操作（默认走 PowerShell helper；测试可注入） */
  desktopLayer?: {
    attach(hwnd: number): Promise<boolean>
    detach(hwnd: number): Promise<boolean>
  }
}

interface WidgetRecord {
  info: PluginWidgetInfo
  win: BrowserWindow
  /** 入口 / 类型签名：开发目录热重载换了入口时重建内容 */
  signature: string
  /** 用户覆盖优先后的实际层级 */
  windowLevel: PluginWidgetWindowLevel
  /** 原生 Acrylic 是否真的挂上（false 时渲染层保持不透明） */
  materialActive: boolean
  /** desktop 层是否成功挂到桌面 shell owner */
  desktopOwner: boolean
  /** minimize 恢复守护连续失败，已按 normal 回落 */
  desktopGuardFailed: boolean
  /** 最近一次 Show Desktop 恢复尝试时刻（用于限频，避免死循环） */
  restoreAttempts: number[]
  persistTimer?: NodeJS.Timeout
  loadTask?: Promise<void>
}

const hardenedSessions = new WeakSet<Session>()

function hardenSession(session: Session): void {
  if (hardenedSessions.has(session)) return
  hardenedSessions.add(session)
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
  session.on('will-download', (event) => event.preventDefault())
}

export class WidgetManager {
  private readonly options: WidgetManagerOptions
  private readonly platform: NodeJS.Platform
  private readonly desktopLayer: NonNullable<WidgetManagerOptions['desktopLayer']>
  private layout: PluginWidgetLayout = { version: 1, widgets: {} }
  /**
   * IPC handler 是否已注册。桌面小组件窗口的渲染层在挂载时就会调用 `plugins:list` /
   * `settings:get`；若窗口早于 `registerIpc()` 创建，这两个 invoke 会因 "No handler registered"
   * 直接 reject，页面型小组件永久停在「暂无内容」（docs/14 §2.1，2026-10-24 实测）。
   * 因此 `sync()` 在 ready 前一律 no-op，由装配层在 `registerIpc()` 之后调 `markReady()`。
   */
  private ready = false
  private readonly records = new Map<string, WidgetRecord>()
  private persistTimer: NodeJS.Timeout | undefined
  private disposed = false
  private readonly onDisplayChange = (): void => {
    this.clampAllToDisplays()
  }

  constructor(options: WidgetManagerOptions) {
    this.options = options
    this.platform = options.platform ?? process.platform
    this.desktopLayer = options.desktopLayer ?? {
      attach: (hwnd) => attachDesktopOwner(hwnd, { logger: options.logger }),
      detach: (hwnd) => detachDesktopOwner(hwnd, { logger: options.logger }),
    }
  }

  async init(): Promise<void> {
    this.layout = await readWidgetLayout(this.options.userData)
    screen.on('display-metrics-changed', this.onDisplayChange)
    screen.on('display-added', this.onDisplayChange)
    screen.on('display-removed', this.onDisplayChange)
  }

  /** 装配层在 `registerIpc()` 之后调用：IPC 已就绪，允许创建窗口并补一次 sync。 */
  markReady(): void {
    if (this.ready || this.disposed) return
    this.ready = true
    this.sync()
  }

  /** 自测诊断：窗口创建门是否已打开。 */
  isReady(): boolean {
    return this.ready
  }

  /** 按当前贡献创建缺失窗口、更新已有窗口、销毁多余窗口。 */
  sync(): void {
    if (this.disposed || !this.ready) return
    const desktop = this.options
      .contributions()
      .filter((info) => info.slot === 'desktop')
      .slice(0, PLUGIN_WIDGET_MAX_WINDOWS)
    const nextKeys = new Set(desktop.map((info) => this.keyOf(info.pluginId, info.id)))

    for (const [key, record] of [...this.records]) {
      if (nextKeys.has(key)) continue
      this.destroyRecord(key, record)
    }

    for (const info of desktop) {
      const key = this.keyOf(info.pluginId, info.id)
      const entry = this.ensureEntry(key, info)
      if (!entry.visible) {
        const existing = this.records.get(key)
        if (existing !== undefined) this.destroyRecord(key, existing)
        continue
      }
      const existing = this.records.get(key)
      const signature = this.signatureOf(info)
      if (existing !== undefined && existing.signature === signature) {
        if (existing.win.getTitle() !== info.title) existing.win.setTitle(info.title)
        // 清单层级没变、但用户覆盖在别处被改过时，这里也兜底对齐一次（幂等）
        const level = resolveWidgetWindowLevel(info.windowLevel, entry.windowLevelOverride)
        if (existing.windowLevel !== level) this.applyWindowLevel(existing, level)
        continue
      }
      if (existing !== undefined) this.destroyRecord(key, existing)
      this.createRecord(info, entry, signature)
    }
  }

  /** 桌面小组件布局快照（含默认值补齐后的条目）。 */
  layoutSnapshot(): PluginWidgetLayout {
    return {
      version: 1,
      widgets: Object.fromEntries(
        Object.entries(this.layout.widgets).map(([key, entry]) => [key, { ...entry }]),
      ),
    }
  }

  /** 显示 / 隐藏一个桌面小组件；写入布局并立即生效。 */
  async setVisible(pluginId: string, widgetId: string, visible: boolean): Promise<boolean> {
    const info = this.options
      .contributions()
      .find((item) => item.pluginId === pluginId && item.id === widgetId && item.slot === 'desktop')
    if (info === undefined) return false
    const key = this.keyOf(pluginId, widgetId)
    const entry = this.ensureEntry(key, info)
    entry.visible = visible
    this.schedulePersist()
    this.sync()
    return true
  }

  /**
   * 设置 / 清除桌面小组件的层级覆盖（v37，docs/14 §5.3）。
   *
   * `auto` = 删除覆盖、跟随清单；其余值持久化到布局文件。已创建的窗口**原地**应用，
   * 不重建（位置 / 尺寸 / 页面状态都不丢）。隐藏中的 widget 只落盘，下次创建时生效。
   */
  async setWindowLevel(
    pluginId: string,
    widgetId: string,
    windowLevel: 'auto' | PluginWidgetWindowLevel,
  ): Promise<boolean> {
    const info = this.options
      .contributions()
      .find((item) => item.pluginId === pluginId && item.id === widgetId && item.slot === 'desktop')
    if (info === undefined) return false
    if (windowLevel !== 'auto' && !PLUGIN_WIDGET_WINDOW_LEVELS.includes(windowLevel)) {
      return false
    }
    const key = this.keyOf(pluginId, widgetId)
    const entry = this.ensureEntry(key, info)
    if (windowLevel === 'auto') delete entry.windowLevelOverride
    else entry.windowLevelOverride = windowLevel
    this.schedulePersist()
    const record = this.records.get(key)
    if (record !== undefined) {
      this.applyWindowLevel(
        record,
        resolveWidgetWindowLevel(info.windowLevel, entry.windowLevelOverride),
      )
    }
    return true
  }

  /**
   * 外观毛玻璃总开关即时生效（v37）：只动已创建窗口的**原生材质**；
   * 页面内的 `data-glass` 由现有的 `settings:changed` 广播负责，两侧同一份配置驱动。
   */
  applyGlass(enabled: boolean): void {
    if (this.disposed) return
    for (const record of this.records.values()) {
      if (record.win.isDestroyed()) continue
      this.applyRecordMaterial(record, enabled)
    }
  }

  /** 自测诊断：桌面小组件窗口的层级 / 置顶 / owner / 材质真实状态。 */
  diagnostics(): WidgetWindowDiagnostics[] {
    return [...this.records.values()]
      .filter((record) => !record.win.isDestroyed())
      .map((record) => ({
        pluginId: record.info.pluginId,
        widgetId: record.info.id,
        windowLevel: record.info.windowLevel,
        effectiveWindowLevel: record.windowLevel,
        alwaysOnTop: record.win.isAlwaysOnTop(),
        desktopOwner: record.desktopOwner,
        desktopGuardFailed: record.desktopGuardFailed,
        windowMaterial: record.info.windowMaterial,
        materialActive: record.materialActive,
      }))
  }

  /** 主进程广播 → 全部桌面小组件窗口（插件变化 / 重启后重载用）。 */
  broadcast(channel: string, payload: unknown): void {
    for (const record of this.records.values()) {
      if (record.win.isDestroyed()) continue
      record.win.webContents.send(channel, payload)
    }
  }

  /** 主进程推送 → 对应桌面小组件窗口。 */
  sendTo(pluginId: string, widgetId: string, channel: string, payload: unknown): boolean {
    const record = this.records.get(this.keyOf(pluginId, widgetId))
    if (record === undefined) return false
    if (record.win.isDestroyed()) return false
    record.win.webContents.send(channel, payload)
    return true
  }

  /** 捕获 / 诊断用：拿到指定小组件的窗口与加载 promise。 */
  windowOf(pluginId: string, widgetId: string): BrowserWindow | undefined {
    const record = this.records.get(this.keyOf(pluginId, widgetId))
    if (record === undefined || record.win.isDestroyed()) return undefined
    return record.win
  }

  async whenLoaded(pluginId: string, widgetId: string): Promise<void> {
    const record = this.records.get(this.keyOf(pluginId, widgetId))
    if (record?.loadTask !== undefined) await record.loadTask
  }

  /** 退出 / 关闭插件系统：关闭全部窗口并落盘。 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    screen.removeListener('display-metrics-changed', this.onDisplayChange)
    screen.removeListener('display-added', this.onDisplayChange)
    screen.removeListener('display-removed', this.onDisplayChange)
    for (const [key, record] of [...this.records]) this.destroyRecord(key, record)
    await this.flushPersist()
  }

  // ───────────────────────── 内部 ─────────────────────────

  private keyOf(pluginId: string, widgetId: string): string {
    return `${pluginId}/${widgetId}`
  }

  private signatureOf(info: PluginWidgetInfo): string {
    return JSON.stringify({
      kind: info.kind,
      entry: info.entry ?? '',
      defaultSize: info.defaultSize ?? null,
      title: info.title,
      windowLevel: info.windowLevel,
      windowMaterial: info.windowMaterial,
      hideCloseButton: info.hideCloseButton,
    })
  }

  private ensureEntry(key: string, info: PluginWidgetInfo): PluginWidgetLayoutEntry {
    const existing = this.layout.widgets[key]
    if (existing !== undefined) {
      // 标题 / 尺寸变化不覆盖用户位置；尺寸上限由窗口 minWidth/minHeight 与拖拽自然约束
      return existing
    }
    const area = screen.getPrimaryDisplay().workArea
    const entry = defaultWidgetEntry(area, this.records.size, info.defaultSize)
    this.layout.widgets[key] = entry
    this.schedulePersist()
    return entry
  }

  private createRecord(
    info: PluginWidgetInfo,
    entry: PluginWidgetLayoutEntry,
    signature: string,
  ): void {
    const key = this.keyOf(info.pluginId, info.id)
    const display = screen.getDisplayMatching(entry)
    const bounds = clampWidgetBounds(entry, display.workArea)
    if (
      bounds.x !== entry.x ||
      bounds.y !== entry.y ||
      bounds.width !== entry.width ||
      bounds.height !== entry.height
    ) {
      Object.assign(entry, bounds)
      this.schedulePersist()
    }
    const level = resolveWidgetWindowLevel(info.windowLevel, entry.windowLevelOverride)
    const win = new BrowserWindow({
      ...bounds,
      minWidth: WIDGET_MIN_WIDTH,
      minHeight: WIDGET_MIN_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      // floating = 0.5.1 的置顶卡片；normal / desktop 都按普通 z-order 参与层叠
      alwaysOnTop: level === 'floating',
      skipTaskbar: true,
      resizable: true,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      hasShadow: false,
      title: info.title,
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        // 页面型小组件内部还要嵌 `aurora-plugin://` webview
        webviewTag: info.kind === 'page',
        devTools: this.options.isDev,
      },
    })
    win.setMenuBarVisibility(false)
    if (level === 'floating') win.setAlwaysOnTop(true, 'floating')

    const record: WidgetRecord = {
      info,
      win,
      signature,
      windowLevel: level,
      materialActive: false,
      desktopOwner: false,
      desktopGuardFailed: false,
      restoreAttempts: [],
    }
    this.records.set(key, record)
    this.wireWebview(info, win)
    this.wireWindowEvents(key, record)
    const materialActive = this.applyInitialMaterial(record)
    if (level === 'desktop') this.attachDesktopOwner(record)
    record.loadTask = this.load(win, info, materialActive).then(
      () => {
        if (win.isDestroyed() || this.disposed) return
        // 建窗时窗口还没显示，contentBounds 可能尚未稳定；加载完成后再裁圆角，
        // 裁失败就按不透明卡片回落，避免「材质挂着、形状却是矩形」露角。
        if (record.materialActive && !this.tryApplyShape(win)) {
          this.dropMaterial(win)
          record.materialActive = false
          this.sendMaterial(record)
        }
        if (entry.visible) win.showInactive()
      },
      (error: unknown) => {
        this.options.logger.warn('桌面小组件加载失败', {
          pluginId: info.pluginId,
          widgetId: info.id,
          error: String(error),
        })
      },
    )
  }

  private async load(
    win: BrowserWindow,
    info: PluginWidgetInfo,
    materialActive: boolean,
  ): Promise<void> {
    const { rendererUrl, rendererDir } = this.options
    // 只有原生材质真的挂上时才告诉渲染层用玻璃令牌；失败时保持不透明，避免裸漏桌面。
    const query: Record<string, string> = { pluginId: info.pluginId, widgetId: info.id }
    if (materialActive) query['material'] = 'acrylic'
    if (info.hideCloseButton) query['hideCloseButton'] = '1'
    if (rendererUrl !== undefined && rendererUrl !== '') {
      const search = new URLSearchParams(query).toString()
      await win.loadURL(`${rendererUrl}/widget/index.html?${search}`)
    } else {
      await win.loadFile(join(rendererDir, 'widget', 'index.html'), { query })
    }
  }

  private wireWindowEvents(key: string, record: WidgetRecord): void {
    const { win } = record
    const schedule = (): void => {
      if (win.isDestroyed()) return
      const bounds = win.getBounds()
      const entry = this.layout.widgets[key]
      if (entry === undefined) return
      if (
        entry.x === bounds.x &&
        entry.y === bounds.y &&
        entry.width === bounds.width &&
        entry.height === bounds.height
      ) {
        return
      }
      Object.assign(entry, {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      })
      this.schedulePersist()
    }
    win.on('move', schedule)
    win.on('resize', schedule)
    // 材质开启时窗口 shape 必须跟着尺寸重算；`resized` 在拖拽结束后只触发一次，成本可控
    win.on('resized', () => {
      if (record.materialActive) this.tryApplyShape(win)
    })
    // desktop 层：Win+D / Win+M / 任务栏「显示桌面」会最小化普通窗口；这里立即恢复
    win.on('minimize', () => this.onWidgetMinimize(record))
    win.on('closed', () => {
      const current = this.records.get(key)
      if (current === record) this.records.delete(key)
      if (record.persistTimer !== undefined) clearTimeout(record.persistTimer)
      record.restoreAttempts = []
    })
    win.webContents.on('did-finish-load', () => {
      // 运行时切换玻璃时事件可能早于页面订阅；加载完成后再补一次确定态
      this.sendMaterial(record)
      if (record.materialActive && !this.tryApplyShape(win)) {
        this.dropMaterial(win)
        record.materialActive = false
        this.sendMaterial(record)
      }
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    if (this.options.isDev) {
      win.webContents.on('console-message', (details) => {
        this.options.logger.debug('[widget] ' + details.message, {
          pluginId: record.info.pluginId,
          widgetId: record.info.id,
          level: details.level,
        })
      })
    }
  }

  /** 应用层级（幂等）；desktop 与 floating/normal 互切不重建窗口。 */
  private applyWindowLevel(record: WidgetRecord, level: PluginWidgetWindowLevel): void {
    if (record.win.isDestroyed() || record.windowLevel === level) return
    record.windowLevel = level
    record.desktopGuardFailed = false
    record.restoreAttempts = []
    if (level === 'floating') {
      this.detachDesktopOwner(record)
      try {
        record.win.setAlwaysOnTop(true, 'floating')
      } catch (error) {
        this.options.logger.warn('设置小组件置顶失败', {
          pluginId: record.info.pluginId,
          widgetId: record.info.id,
          error: String(error),
        })
      }
      return
    }
    try {
      record.win.setAlwaysOnTop(false)
    } catch (error) {
      this.options.logger.debug('取消小组件置顶失败', {
        pluginId: record.info.pluginId,
        widgetId: record.info.id,
        error: String(error),
      })
    }
    if (level === 'desktop') this.attachDesktopOwner(record)
    else this.detachDesktopOwner(record)
  }

  /**
   * desktop 层 owner 亲和（Win32 最佳努力，v37）。
   *
   * 目标是把窗口 owner 指到桌面 `SHELLDLL_DefView`，让 Show Desktop 把它当桌面的一部分；
   * 不改父窗口、不改窗口样式，因此拖动 / 缩放 / 透明表面都不受影响。失败只记日志，
   * 继续依赖 `onWidgetMinimize()` 的恢复守护。
   */
  private attachDesktopOwner(record: WidgetRecord): void {
    if (this.platform !== 'win32' || record.win.isDestroyed()) return
    const hwnd = nativeHandleToNumber(record.win.getNativeWindowHandle())
    if (hwnd === undefined) {
      this.options.logger.warn('取小组件 HWND 失败，desktop 层按普通窗口显示', {
        pluginId: record.info.pluginId,
        widgetId: record.info.id,
      })
      return
    }
    void this.desktopLayer
      .attach(hwnd)
      .then((ok) => {
        if (record.win.isDestroyed()) return
        // 切换层级与 PowerShell 落定存在竞争：已经离开 desktop 就立刻解掉，别把 owner 留脏
        if (record.windowLevel !== 'desktop') {
          if (ok) void this.desktopLayer.detach(hwnd)
          return
        }
        record.desktopOwner = ok
        if (!ok) {
          this.options.logger.debug('小组件桌面 owner 亲和失败，依赖 minimize 守护', {
            pluginId: record.info.pluginId,
            widgetId: record.info.id,
          })
        }
      })
      .catch((error: unknown) => {
        this.options.logger.warn('小组件桌面 owner 亲和异常', {
          pluginId: record.info.pluginId,
          widgetId: record.info.id,
          error: String(error),
        })
      })
  }

  private detachDesktopOwner(record: WidgetRecord): void {
    if (this.platform !== 'win32' || !record.desktopOwner || record.win.isDestroyed()) return
    record.desktopOwner = false
    const hwnd = nativeHandleToNumber(record.win.getNativeWindowHandle())
    if (hwnd === undefined) return
    void this.desktopLayer.detach(hwnd).catch((error: unknown) => {
      this.options.logger.debug('解除小组件桌面 owner 失败', {
        pluginId: record.info.pluginId,
        widgetId: record.info.id,
        error: String(error),
      })
    })
  }

  /**
   * Show Desktop 恢复守护：普通窗口会被 Win+D / Win+M 最小化；desktop 层在 minimize
   * 后立即 restore + showInactive。2 秒内最多 3 次，超过则按 normal 回落并 stop。
   */
  private onWidgetMinimize(record: WidgetRecord): void {
    if (this.disposed || record.windowLevel !== 'desktop') return
    if (record.desktopGuardFailed) return
    const now = Date.now()
    record.restoreAttempts = record.restoreAttempts.filter((at) => now - at < 2_000)
    if (record.restoreAttempts.length >= 3) {
      record.desktopGuardFailed = true
      this.options.logger.warn('桌面小组件恢复守护连续失败，按普通窗口回落', {
        pluginId: record.info.pluginId,
        widgetId: record.info.id,
      })
      return
    }
    record.restoreAttempts.push(now)
    const restore = (): void => {
      const win = record.win
      if (win.isDestroyed() || this.disposed) return
      if (win.isMinimized()) win.restore()
      win.showInactive()
    }
    setImmediate(restore)
    // 部分系统在 Win+D 的动画帧后才落最小化，补一次短延迟
    const timer = setTimeout(restore, 80)
    timer.unref?.()
  }

  /** 按当前「声明 + 外观开关 + 平台」挂 / 摘原生材质，并通知渲染层。 */
  private applyRecordMaterial(record: WidgetRecord, glassAllowed: boolean): void {
    if (record.win.isDestroyed()) return
    const wanted = shouldUseWidgetMaterial(record.info.windowMaterial, glassAllowed, this.platform)
    if (wanted) {
      if (record.materialActive) return
      if (!this.tryApplyMaterial(record.win) || !this.tryApplyShape(record.win)) {
        this.dropMaterial(record.win)
        this.sendMaterial(record)
        return
      }
      record.materialActive = true
      this.sendMaterial(record)
      return
    }
    if (!record.materialActive) return
    this.dropMaterial(record.win)
    record.materialActive = false
    this.sendMaterial(record)
  }

  /** 建窗时尝试材质；任何一步失败都回落到不透明卡片。 */
  private applyInitialMaterial(record: WidgetRecord): boolean {
    if (
      !shouldUseWidgetMaterial(
        record.info.windowMaterial,
        this.options.glassAllowed(),
        this.platform,
      )
    ) {
      return false
    }
    if (!this.tryApplyMaterial(record.win)) return false
    record.materialActive = true
    return true
  }

  private tryApplyMaterial(win: BrowserWindow): boolean {
    try {
      win.setBackgroundColor('#00000000')
      win.setBackgroundMaterial('acrylic')
      return true
    } catch (error) {
      this.options.logger.debug('小组件原生材质不可用，保持不透明', { error: String(error) })
      return false
    }
  }

  /**
   * 把窗口 shape 裁成圆角。
   *
   * 坐标用**整个窗口矩形**（含 Windows 给无边框可缩放窗口补的不可见 resize 边框）：
   * 只按内容区裁会把边框切出 shape，用户就点不到边缘缩放。内容区相对窗口的内缩量
   * 加到圆角半径上，让材质的外缘弧与 CSS 卡片弧保持同一条曲线（多出的 1–2px 是
   * 无边框窗口的 resize 边框，材质会在卡片外形成极细的一圈，属可接受代价）。
   */
  private tryApplyShape(win: BrowserWindow): boolean {
    try {
      const windowBounds = win.getBounds()
      const content = win.getContentBounds()
      const inset = Math.max(
        0,
        Math.round((content.x - windowBounds.x + (content.y - windowBounds.y)) / 2),
      )
      win.setShape(
        widgetRoundedShape(
          { x: 0, y: 0, width: windowBounds.width, height: windowBounds.height },
          WIDGET_CARD_RADIUS + inset,
        ),
      )
      return true
    } catch (error) {
      this.options.logger.debug('小组件圆角 shape 应用失败', { error: String(error) })
      return false
    }
  }

  private dropMaterial(win: BrowserWindow): void {
    try {
      win.setBackgroundMaterial('none')
    } catch (error) {
      this.options.logger.debug('摘除小组件材质失败', { error: String(error) })
    }
    try {
      win.setShape([])
    } catch (error) {
      this.options.logger.debug('恢复小组件矩形失败', { error: String(error) })
    }
  }

  private sendMaterial(record: WidgetRecord): void {
    if (record.win.isDestroyed()) return
    const payload = {
      pluginId: record.info.pluginId,
      widgetId: record.info.id,
      material: (record.materialActive ? 'acrylic' : 'none') as PluginWidgetWindowMaterial,
    }
    const send = (): void => {
      if (record.win.isDestroyed()) return
      record.win.webContents.send(IPC.plugins.widgetMaterial, payload)
    }
    if (record.win.webContents.isLoading()) record.win.webContents.once('did-finish-load', send)
    else send()
  }

  /**
   * 页面型小组件内部嵌的 `aurora-plugin://` webview：与 chat 里的插件页面同一套强制口径
   * （专用 preload、逐插件 partition、sandbox + contextIsolation、禁弹窗 / 下载）。
   */
  private wireWebview(info: PluginWidgetInfo, win: BrowserWindow): void {
    let pendingSrc = ''
    win.webContents.on(
      'will-attach-webview',
      (event, webPreferences, params: Record<string, string>) => {
        const src = params['src'] ?? ''
        if (!isPluginPageUrl(src)) {
          event.preventDefault()
          return
        }
        const target = pluginPageTargetOf(src)
        const preload = this.options.pluginPagePreloadPath
        if (target === null || preload === undefined || target.pluginId !== info.pluginId) {
          event.preventDefault()
          return
        }
        pendingSrc = src
        delete params['preload']
        params['partition'] = `plugin-${target.pluginId}`
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
      const src = pendingSrc
      pendingSrc = ''
      if (!isPluginPageUrl(src)) {
        guest.setWindowOpenHandler(() => ({ action: 'deny' }))
        return
      }
      registerPluginPageGuest(guest, win.webContents, src)
      ensurePluginPageProtocol(guest.session)
      hardenSession(guest.session)
      guest.setWindowOpenHandler(() => ({ action: 'deny' }))
      guest.on('will-navigate', (event, url) => {
        if (pluginPageTargetOf(url)?.pluginId !== info.pluginId) event.preventDefault()
      })
      guest.on('did-fail-load', (_event, code, description, url) => {
        this.options.logger.warn('小组件页面加载失败', {
          pluginId: info.pluginId,
          code,
          description,
          url,
        })
      })
      void guest.loadURL(src).catch((error: unknown) => {
        this.options.logger.warn('小组件页面 loadURL 失败', {
          pluginId: info.pluginId,
          widgetId: info.id,
          error: String(error),
        })
      })
    })
  }

  private destroyRecord(key: string, record: WidgetRecord): void {
    if (record.persistTimer !== undefined) clearTimeout(record.persistTimer)
    this.records.delete(key)
    if (!record.win.isDestroyed()) record.win.destroy()
  }

  private clampAllToDisplays(): void {
    let changed = false
    for (const [key, record] of this.records) {
      if (record.win.isDestroyed()) continue
      const entry = this.layout.widgets[key]
      if (entry === undefined) continue
      const current = record.win.getBounds()
      const clamped = clampWidgetBounds(current, screen.getDisplayMatching(current).workArea)
      if (
        clamped.x !== current.x ||
        clamped.y !== current.y ||
        clamped.width !== current.width ||
        clamped.height !== current.height
      ) {
        record.win.setBounds(clamped)
        if (record.materialActive) this.tryApplyShape(record.win)
        Object.assign(entry, clamped)
        changed = true
      }
    }
    if (changed) this.schedulePersist()
  }

  private schedulePersist(): void {
    if (this.disposed) return
    if (this.persistTimer !== undefined) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      void this.flushPersist()
    }, PERSIST_DEBOUNCE_MS)
    this.persistTimer.unref?.()
  }

  private async flushPersist(): Promise<void> {
    try {
      await writeWidgetLayout(this.options.userData, this.layout)
    } catch (error) {
      this.options.logger.warn('小组件布局写入失败', { error: String(error) })
    }
  }
}
