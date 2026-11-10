/**
 * 插件临时对话框窗口（docs/14 §5.8）。
 *
 * 与桌面小组件的关键差异：
 * - **可激活**（`focusable: true`）：窗口的意义就是让用户键入文字；
 * - **不常驻**：确定 / 取消 / × / Esc / 超时 / 插件退出都会销毁窗口，不写几何布局；
 * - 每个插件同一时刻只允许 1 扇，全部插件合计 ≤ 4 扇（防失控常量）。
 *
 * 声明式对话框复用 `PluginSchemaRenderer`（宿主绘制确定 / 取消按钮）；页面型对话框内嵌
 * `aurora-plugin://` webview，沙箱口径与面板 / 小组件页面完全一致。
 *
 * 本文件是唯一为临时对话框创建窗口、import electron 的访问层；`PluginManager` 只负责
 * 权限 / 清单校验与 `ctx.ui.openDialog` 的转发，两者由装配层接起来。
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { BrowserWindow, nativeTheme, screen } from 'electron'
import {
  PLUGIN_DIALOG_MAX_LIFETIME_MS,
  PLUGIN_DIALOG_MAX_WINDOWS,
  type Logger,
  type PluginDialogInfo,
  type PluginDialogInfoResult,
  type PluginDialogOpenResult,
} from '@aurora/shared'
import { PluginRpcFailure } from './protocol.js'
import {
  ensurePluginPageProtocol,
  hardenPluginPageSession,
  registerPluginPageGuest,
} from '../page-protocol.js'
import { isPluginPageUrl, pluginPageTargetOf } from '../plugin-page-url.js'
import { centeredDialogBounds, resolveDialogSize } from './dialog-window.js'

export interface PluginDialogManagerOptions {
  logger: Logger
  isDev: boolean
  /** 主 preload（暴露 `window.aurora`） */
  preloadPath: string
  /** 插件页面专用 preload */
  pluginPagePreloadPath?: string
  rendererUrl?: string
  rendererDir: string
  /** 当前启用 + `ui.dialogs` 权限下的对话框声明 */
  dialogOf: (pluginId: string, dialogId: string) => PluginDialogInfo | undefined
}

interface DialogRecord {
  requestId: string
  info: PluginDialogInfo
  params: unknown
  win: BrowserWindow
  settled: boolean
  resolve: (result: PluginDialogOpenResult) => void
  reject: (error: unknown) => void
  timer?: NodeJS.Timeout
  loadTask: Promise<void>
}

function windowBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7'
}

export class PluginDialogManager {
  private readonly options: PluginDialogManagerOptions
  private readonly records = new Map<string, DialogRecord>()
  /** pluginId → requestId：同一插件只允许一个打开中的对话框 */
  private readonly byPlugin = new Map<string, string>()
  private ready = false
  private disposed = false
  private readonly readyPromise: Promise<void>
  private resolveReady!: () => void

  constructor(options: PluginDialogManagerOptions) {
    this.options = options
    this.readyPromise = new Promise<void>((resolve) => {
      this.resolveReady = resolve
    })
  }

  /** 装配层在 `registerIpc()` 之后调用：对话框渲染层挂载即调 `plugins:*`，必须已有 handler。 */
  markReady(): void {
    if (this.ready || this.disposed) return
    this.ready = true
    this.resolveReady()
  }

  async open(
    pluginId: string,
    dialogId: string,
    params?: unknown,
  ): Promise<PluginDialogOpenResult> {
    await this.readyPromise
    if (this.disposed) {
      throw new PluginRpcFailure('E_PLUGIN_NOT_READY', '插件系统正在退出')
    }
    // ready 之后现查：等待 IPC 就绪期间插件可能被停用 / 卸载。
    const info = this.options.dialogOf(pluginId, dialogId)
    if (info === undefined) {
      throw new PluginRpcFailure('E_PLUGIN_INVALID_ARGS', `插件未声明对话框：${dialogId}`)
    }
    if (this.byPlugin.has(pluginId)) {
      throw new PluginRpcFailure('E_PLUGIN_INVALID_ARGS', '该插件已有打开的临时窗口')
    }
    if (this.records.size >= PLUGIN_DIALOG_MAX_WINDOWS) {
      throw new PluginRpcFailure(
        'E_PLUGIN_INVALID_ARGS',
        `同时打开的临时窗口已达上限 ${PLUGIN_DIALOG_MAX_WINDOWS}`,
      )
    }

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const bounds = centeredDialogBounds(
      resolveDialogSize(info.defaultSize, display.workArea),
      display.workArea,
    )
    const requestId = randomUUID()
    const win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: false,
      backgroundColor: windowBackgroundColor(),
      resizable: false,
      minimizable: true,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: false,
      title: info.title,
      // 与桌面小组件相反：这扇窗的唯一目的就是输入文字，必须能拿键盘焦点。
      focusable: true,
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        // 页面型对话框内部要嵌 `aurora-plugin://` webview
        webviewTag: info.kind === 'page',
        devTools: this.options.isDev,
      },
    })
    win.setMenuBarVisibility(false)

    return await new Promise<PluginDialogOpenResult>((resolve, reject) => {
      const record: DialogRecord = {
        requestId,
        info,
        params,
        win,
        settled: false,
        resolve,
        reject,
        loadTask: Promise.resolve(),
      }
      this.records.set(requestId, record)
      this.byPlugin.set(pluginId, requestId)
      const timer = setTimeout(() => {
        this.options.logger.info('插件对话框超过最长存活时间，自动关闭', {
          pluginId,
          dialogId,
          requestId,
        })
        this.finish(requestId, { submitted: false, values: {} })
      }, PLUGIN_DIALOG_MAX_LIFETIME_MS)
      timer.unref?.()
      record.timer = timer

      this.wireWindow(record)
      this.wireWebview(record)
      record.loadTask = this.load(record).catch((error: unknown) => {
        this.options.logger.warn('插件对话框加载失败', {
          pluginId,
          dialogId,
          requestId,
          error: String(error),
        })
        this.rejectRecord(requestId, error)
      })
    })
  }

  /** 渲染层按 requestId 取窗口参数。 */
  info(requestId: string): PluginDialogInfoResult | undefined {
    const record = this.records.get(requestId)
    if (record === undefined) return undefined
    return this.toInfoResult(record)
  }

  /** 页面 RPC 按 (pluginId, dialogId) 找当前打开的对话框。 */
  infoByTarget(pluginId: string, dialogId: string): PluginDialogInfoResult | undefined {
    const requestId = this.byPlugin.get(pluginId)
    if (requestId === undefined) return undefined
    const record = this.records.get(requestId)
    if (record === undefined || record.info.id !== dialogId) return undefined
    return this.toInfoResult(record)
  }

  /** 渲染层主动关闭（确定 / 取消 / × / Esc）。 */
  close(
    requestId: string,
    input: {
      submitted?: boolean
      values?: Record<string, unknown>
      data?: unknown
    },
  ): boolean {
    return this.finish(requestId, {
      submitted: input.submitted === true,
      values: input.values ?? {},
      ...(input.data === undefined ? {} : { data: input.data }),
    })
  }

  /** 插件进程退出 / 停用：该插件的对话框一律按取消结算并销毁。 */
  closePlugin(pluginId: string): void {
    for (const [requestId, record] of [...this.records]) {
      if (record.info.pluginId !== pluginId) continue
      this.finish(requestId, { submitted: false, values: {} })
    }
  }

  /** 捕获 / 诊断：按 requestId 取窗口。 */
  windowOf(requestId: string): BrowserWindow | undefined {
    const record = this.records.get(requestId)
    if (record === undefined || record.win.isDestroyed()) return undefined
    return record.win
  }

  /** 捕获 / 诊断：某插件当前打开的对话框 requestId（每个插件最多 1 扇）。 */
  activeRequestOf(pluginId: string): string | undefined {
    return this.byPlugin.get(pluginId)
  }

  async whenLoaded(requestId: string): Promise<void> {
    await this.records.get(requestId)?.loadTask
  }

  /** 退出 / 关闭插件系统：全部按取消结算。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // 尚未 markReady 时也要放行在等的 open()，让它看到 disposed 后如实报错而不是挂住。
    this.resolveReady()
    for (const requestId of [...this.records.keys()]) {
      this.finish(requestId, { submitted: false, values: {} })
    }
  }

  // ───────────────────────── 内部 ─────────────────────────

  private toInfoResult(record: DialogRecord): PluginDialogInfoResult {
    return {
      requestId: record.requestId,
      pluginId: record.info.pluginId,
      pluginName: record.info.pluginName,
      dialogId: record.info.id,
      title: record.info.title,
      kind: record.info.kind,
      ...(record.info.entry === undefined ? {} : { entry: record.info.entry }),
      ...(record.params === undefined ? {} : { params: record.params }),
    }
  }

  private async load(record: DialogRecord): Promise<void> {
    const { rendererUrl, rendererDir } = this.options
    const query = { requestId: record.requestId }
    if (rendererUrl !== undefined && rendererUrl !== '') {
      await record.win.loadURL(`${rendererUrl}/dialog/index.html?${new URLSearchParams(query)}`)
    } else {
      await record.win.loadFile(join(rendererDir, 'dialog', 'index.html'), { query })
    }
  }

  private wireWindow(record: DialogRecord): void {
    const { win } = record
    win.once('ready-to-show', () => {
      if (record.settled || win.isDestroyed() || this.disposed) return
      win.show()
      win.focus()
    })
    win.on('closed', () => {
      if (record.settled) return
      // Alt+F4 / 系统关闭：按取消结算（不重复 destroy）
      this.settle(record, { submitted: false, values: {} })
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    if (this.options.isDev) {
      win.webContents.on('console-message', (details) => {
        this.options.logger.debug('[dialog] ' + details.message, {
          pluginId: record.info.pluginId,
          dialogId: record.info.id,
          level: details.level,
        })
      })
    }
  }

  private wireWebview(record: DialogRecord): void {
    const { win } = record
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
        if (target === null || preload === undefined || target.pluginId !== record.info.pluginId) {
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
      hardenPluginPageSession(guest.session)
      guest.setWindowOpenHandler(() => ({ action: 'deny' }))
      guest.on('will-navigate', (event, url) => {
        if (pluginPageTargetOf(url)?.pluginId !== record.info.pluginId) event.preventDefault()
      })
      guest.on('did-fail-load', (_event, code, description, url) => {
        this.options.logger.warn('对话框页面加载失败', {
          pluginId: record.info.pluginId,
          dialogId: record.info.id,
          code,
          description,
          url,
        })
      })
      void guest.loadURL(src).catch((error: unknown) => {
        this.options.logger.warn('对话框页面 loadURL 失败', {
          pluginId: record.info.pluginId,
          dialogId: record.info.id,
          error: String(error),
        })
      })
    })
  }

  private finish(requestId: string, result: PluginDialogOpenResult): boolean {
    const record = this.records.get(requestId)
    if (record === undefined || record.settled) return false
    this.settle(record, result)
    if (!record.win.isDestroyed()) record.win.destroy()
    return true
  }

  private rejectRecord(requestId: string, error: unknown): void {
    const record = this.records.get(requestId)
    if (record === undefined || record.settled) return
    record.settled = true
    this.cleanup(record)
    if (!record.win.isDestroyed()) record.win.destroy()
    record.reject(error)
  }

  /** 只结算 / 清理，不动窗口（`closed` 事件里窗口已经没了）。 */
  private settle(record: DialogRecord, result: PluginDialogOpenResult): void {
    if (record.settled) return
    record.settled = true
    this.cleanup(record)
    record.resolve(result)
  }

  private cleanup(record: DialogRecord): void {
    this.records.delete(record.requestId)
    if (this.byPlugin.get(record.info.pluginId) === record.requestId) {
      this.byPlugin.delete(record.info.pluginId)
    }
    if (record.timer !== undefined) {
      clearTimeout(record.timer)
      record.timer = undefined
    }
  }
}
