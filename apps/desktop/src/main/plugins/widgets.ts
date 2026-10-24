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
import type { Logger, PluginWidgetInfo, PluginWidgetLayout, PluginWidgetLayoutEntry } from '@aurora/shared'
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
}

interface WidgetRecord {
  info: PluginWidgetInfo
  win: BrowserWindow
  /** 入口 / 类型签名：开发目录热重载换了入口时重建内容 */
  signature: string
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
  private layout: PluginWidgetLayout = { version: 1, widgets: {} }
  private readonly records = new Map<string, WidgetRecord>()
  private persistTimer: NodeJS.Timeout | undefined
  private disposed = false
  private readonly onDisplayChange = (): void => {
    this.clampAllToDisplays()
  }

  constructor(options: WidgetManagerOptions) {
    this.options = options
  }

  async init(): Promise<void> {
    this.layout = await readWidgetLayout(this.options.userData)
    screen.on('display-metrics-changed', this.onDisplayChange)
    screen.on('display-added', this.onDisplayChange)
    screen.on('display-removed', this.onDisplayChange)
  }

  /** 按当前贡献创建缺失窗口、更新已有窗口、销毁多余窗口。 */
  sync(): void {
    if (this.disposed) return
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
    const win = new BrowserWindow({
      ...bounds,
      minWidth: WIDGET_MIN_WIDTH,
      minHeight: WIDGET_MIN_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
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
    win.setAlwaysOnTop(true, 'floating')

    const record: WidgetRecord = { info, win, signature }
    this.records.set(key, record)
    this.wireWebview(info, win)
    this.wireWindowEvents(key, record)
    record.loadTask = this.load(win, info).then(
      () => {
        if (!win.isDestroyed() && entry.visible && !this.disposed) win.showInactive()
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

  private async load(win: BrowserWindow, info: PluginWidgetInfo): Promise<void> {
    const { rendererUrl, rendererDir } = this.options
    const query = { pluginId: info.pluginId, widgetId: info.id }
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
    win.on('closed', () => {
      const current = this.records.get(key)
      if (current === record) this.records.delete(key)
      if (record.persistTimer !== undefined) clearTimeout(record.persistTimer)
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
        this.options.logger.warn('小组件页面加载失败', { pluginId: info.pluginId, code, description, url })
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
