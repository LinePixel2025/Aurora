/**
 * Agent 内置浏览器驱动（v35，docs/06 §27）。
 *
 * 职责：
 * - 维护 `sessionId → webview guest` 的会话表（渲染层上报 `webContentsId`，主进程校验归属）；
 * - 并发上限 / 空闲释放（纯逻辑在 `browser-agent-sessions.ts`，这里只做 Electron 侧）；
 * - 用 `guest.loadURL` / `executeJavaScript` / `webContents.debugger`（CDP）驱动页面；
 * - 截图落盘、控制台与网络环形缓冲；
 * - 向渲染层推送 `browser:agentStatus`（徽章 / 激活 / 释放）。
 *
 * 为什么驱动渲染层里的 webview 而不是另开窗口：产品要求「用户可以查看 Agent 操作浏览器」，
 * 且内置浏览器只有 chat 窗口开启 `webviewTag`（docs/07 §2.3）。guest 是独立进程，
 * 没有 Aurora preload / Node 能力，Agent 只能触及网页本身。
 *
 * 本文件 import electron，因此没有也不该有单测（vitest 的 Node 环境加载不了它）；
 * 纯逻辑已抽到 `browser-agent-sessions.ts`，端口策略在 `tools/browser-port.ts`。
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { nativeImage, webContents, type WebContents } from 'electron'
import type {
  BrowserConsoleEntry,
  BrowserEvalResult,
  BrowserNetworkEntry,
  BrowserReadInput,
  BrowserReadResult,
  BrowserScreenshotResult,
  BrowserSnapshot,
  BrowserWaitInput,
  BrowserWaitResult,
} from '@aurora/agent-core'
import type { Logger, Settings } from '@aurora/shared'
import {
  createBrowserSessionSlots,
  MAX_AGENT_BROWSER_SESSIONS_HARD,
  type BrowserSessionSlots,
} from './browser-agent-sessions.js'
import { imageFileName, selectExpiredFiles } from './tools/image-store.js'

/** 单页截图上限（超过就缩，避免把请求体顶爆；与截屏工具同一个 8 MiB 口径）。 */
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024
/** 截图目录只留最近多少张（与 screenshot 工具一致）。 */
const SCREENSHOT_KEEP = 50
/** 打开请求等待渲染层回执的上限。 */
const ATTACH_TIMEOUT_MS = 15_000
/** 单次导航 / 页面脚本执行的上限。 */
const NAVIGATION_TIMEOUT_MS = 20_000
const ACTION_TIMEOUT_MS = 15_000
/** 控制台 / 网络环形缓冲上限。 */
const LOG_RING = 200
/** 全页截图的最大高度（像素）与宽度，防止 10 万像素长的页面把内存打满。 */
const MAX_FULL_PAGE_DIMENSION = 8_000
/** 快照元素上限（与 agent-core 的展示口径一致，端口侧也留一道）。 */
const MAX_SNAPSHOT_ELEMENTS = 120
const MAX_SNAPSHOT_TEXT = 2_000

export interface BrowserAgentDeps {
  /** 配置 live 快照（每次操作现读，改设置不重启） */
  settings: () => Settings
  logger: Logger
  /** chat 窗口 webContents id（guest 归属校验；窗口未建时 undefined） */
  chatWebContentsId: () => number | undefined
  /** 主进程 → chat 渲染层推送 */
  sendToChat: (channel: string, payload: unknown) => void
  /**
   * 把 chat 窗口显示出来并**等到渲染层加载完成、事件订阅到位**再返回。
   *
   * 只 `showChat()` 再立刻推送会在「窗口还没建」时丢包（`window-manager` 的
   * `showWithPayload` 注释已记过这个坑）：自动化 / Center 会话第一次调浏览器工具时
   * chat 窗口往往还不存在，agentOpen 推送早于 Vue 订阅 → 等满 15s 超时。
   */
  presentChat: () => Promise<void>
  /** 页面自身发起的导航 / 弹窗是否允许（内网开关在这里生效，不只是首次 open） */
  allowNavigation: (url: string) => { ok: true } | { ok: false; reason: string }
  /** 截图落盘目录（`<userData>/screenshots`，同时是 view_image 的白名单根之一） */
  screenshotsDir: string
  /** 注入时钟（单测 / 自测可选） */
  now?: () => number
}

interface PendingOpen {
  requestId: string
  sessionId: string
  url: string
  resolve: (guest: WebContents, tabId: string) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface AgentSession {
  sessionId: string
  guest: WebContents
  tabId: string
  debuggerAttached: boolean
  consoleEntries: BrowserConsoleEntry[]
  networkEntries: BrowserNetworkEntry[]
  /** CDP requestId → 请求行（response 到达时合并成一条网络记录） */
  networkRequests: Map<string, { method: string; url: string; resourceType: string }>
  lastFailure: string | undefined
  /** 解绑函数（停止会话时统一调用，避免监听泄漏） */
  cleanups: Array<() => void>
}

interface CdpNetworkParams {
  requestId?: string
  request?: { method?: string; url?: string }
  type?: string
  response?: { status?: number; url?: string }
  url?: string
  errorText?: string
}

/**
 * 会话管理器（main/index.ts 单例）。
 *
 * 对外 API 与 `BrowserSessionPort` 同形，但**不做 URL / 开关策略**：那两条在
 * `tools/browser-port.ts`。原因是开发自测（capture / smoke）需要直接打开本地夹具页，
 * 而工具面必须是 http/https；把策略留在端口层，测试就不必伪造一个「假用户开关」。
 */
export class BrowserAgentManager {
  private readonly deps: BrowserAgentDeps
  private readonly slots: BrowserSessionSlots
  private readonly sessions = new Map<string, AgentSession>()
  private readonly pending = new Map<string, PendingOpen>()
  private disposed = false

  constructor(deps: BrowserAgentDeps) {
    this.deps = deps
    this.slots = createBrowserSessionSlots({
      maxCount: () => this.configuredMaxSessions(),
      idleMs: () => this.configuredIdleMs(),
      onIdle: (sessionId) => {
        const minutes = this.configuredIdleMinutes()
        this.stop(sessionId, `空闲 ${minutes} 分钟，已自动释放`)
      },
      ...(deps.now === undefined ? {} : { now: deps.now }),
    })
  }

  /** 会话开关 / 限额诊断（capture / smoke 与设置页摘要用）。 */
  diagnostics(): {
    enabled: boolean
    sessions: Array<{ sessionId: string; tabId: string; url: string; attached: boolean }>
    limit: number
  } {
    return {
      enabled: this.deps.settings().agent.browser.enabled,
      sessions: [...this.sessions.values()].map((session) => ({
        sessionId: session.sessionId,
        tabId: session.tabId,
        url: session.guest.isDestroyed() ? '' : session.guest.getURL(),
        attached: session.debuggerAttached,
      })),
      limit: this.configuredMaxSessions(),
    }
  }

  /** 某个 guest 是否属于 Agent 控制的会话（媒体权限判定用）。 */
  allowsMedia(webContentsId: number): boolean {
    if (this.findByGuestId(webContentsId) === undefined) return false
    return this.deps.settings().agent.browser.allowMedia
  }

  /**
   * 打开 / 复用会话并导航。端口层已做 URL 与开关校验；这里只负责资源与驱动。
   */
  async open(sessionId: string, url: string, title: string): Promise<void> {
    this.assertAlive()
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined && !existing.guest.isDestroyed()) {
      this.slots.touch(sessionId)
      // 复用也要回到前台：用户可能切走了标签，而 docs/06 §27 的承诺是
      // 「每次 browser_open 都让用户当场看到 Agent 在操作」。
      await this.deps.presentChat()
      this.emitStatus(sessionId, 'opening', '正在打开页面', true)
      await this.navigate(existing, url)
      this.emitStatus(sessionId, 'ready', '已就绪')
      return
    }
    if (existing !== undefined) this.stop(sessionId, '页面进程已退出')

    const acquired = this.slots.acquire(sessionId)
    if (!acquired.ok) {
      if (acquired.reason === 'duplicate') {
        throw new Error('该会话的浏览器正在打开，请稍候再试。')
      }
      throw new Error(
        `内置浏览器会话已达上限（${acquired.limit} 个），先调用 browser_close 结束一个，或复用已打开的会话。`,
      )
    }

    const requestId = randomUUID()
    let guest: WebContents
    let tabId = ''
    try {
      const opened = await this.requestGuest(sessionId, requestId, url, title)
      guest = opened.guest
      tabId = opened.tabId
    } catch (error) {
      this.slots.release(sessionId)
      this.emitStatus(sessionId, 'released', '打开浏览器标签失败')
      throw error
    }
    // 竞态兜底：等待渲染层回执期间，用户可能已经点了「停止」/ 关了标签 / 改了开关，
    // 对应路径会调 stop() 把槽位释放掉。这里若继续登记，就会留下一个「没人认领」的会话
    //（状态已被推成 released，但 manager 仍在驱动页面）。
    if (!this.slots.has(sessionId)) {
      this.emitStatus(sessionId, 'released', '浏览器会话在打开过程中被停止')
      throw new Error('浏览器会话在打开过程中被停止，请重新 browser_open。')
    }

    const session: AgentSession = {
      sessionId,
      guest,
      tabId,
      debuggerAttached: false,
      consoleEntries: [],
      networkEntries: [],
      networkRequests: new Map(),
      lastFailure: undefined,
      cleanups: [],
    }
    this.sessions.set(sessionId, session)
    this.installListeners(session)
    try {
      this.attachDebugger(session)
      await this.ensureNavigated(session, url)
    } catch (error) {
      // 打开失败不留半残会话：释放槽位并把 guest 交还给用户（标签保留）。
      this.stop(sessionId, '打开页面失败')
      throw error
    }
    this.slots.touch(sessionId)
    this.emitStatus(sessionId, 'ready', '已就绪')
  }

  async snapshot(sessionId: string): Promise<BrowserSnapshot> {
    const session = this.requireSession(sessionId)
    this.slots.touch(sessionId)
    const value = await this.evaluateValue(session, snapshotScript())
    return normalizeSnapshot(value)
  }

  async act(
    sessionId: string,
    action: 'click' | 'hover' | 'type' | 'press' | 'scroll' | 'select',
    params: {
      ref?: string
      text?: string
      key?: string
      direction?: 'up' | 'down' | 'left' | 'right'
      amount?: number
      value?: string
    },
  ): Promise<{ summary: string; url: string; title: string }> {
    const session = this.requireSession(sessionId)
    this.slots.touch(sessionId)
    this.emitStatus(sessionId, 'busy', describeAction(action, params), true)

    try {
      const summary = await this.runAction(session, action, params)
      return { summary, url: safeUrl(session.guest), title: safeTitle(session.guest) }
    } finally {
      if (this.sessions.has(sessionId)) this.emitStatus(sessionId, 'ready', '已就绪')
    }
  }

  async read(sessionId: string, what: BrowserReadInput['what']): Promise<BrowserReadResult> {
    const session = this.requireSession(sessionId)
    this.slots.touch(sessionId)
    if (what === 'console') return { console: [...session.consoleEntries] }
    if (what === 'network') return { network: [...session.networkEntries] }
    const page = await this.readPageText(session)
    return { page }
  }

  async wait(
    sessionId: string,
    input: Omit<BrowserWaitInput, 'sessionId'>,
  ): Promise<BrowserWaitResult> {
    const session = this.requireSession(sessionId)
    this.slots.touch(sessionId)
    const timeoutMs = Math.max(1_000, Math.min(30_000, input.timeoutMs ?? 10_000))
    const deadline = Date.now() + timeoutMs
    const done = (detail: string): BrowserWaitResult => ({
      matched: true,
      detail,
      url: safeUrl(session.guest),
      title: safeTitle(session.guest),
    })
    if (input.for === 'load') {
      if (!session.guest.isLoading()) return done('页面已加载完成')
      await this.waitForLoad(session, timeoutMs)
      return done('页面加载完成')
    }
    const value = input.value ?? ''
    while (Date.now() < deadline) {
      if (session.guest.isDestroyed()) throw new Error('浏览器标签已被关闭，请重新 browser_open。')
      if (input.for === 'url') {
        if (safeUrl(session.guest).includes(value)) return done(`地址包含 ${value}`)
      } else if (input.for === 'selector') {
        const found = await this.evaluateValue(
          session,
          `(() => { try { return document.querySelector(${JSON.stringify(value)}) !== null } catch (e) { return false } })()`,
        )
        if (found === true) return done(`元素已出现：${value}`)
      } else {
        const contains = await this.evaluateValue(
          session,
          `(() => { const t = document.body ? document.body.innerText : ''; return t.includes(${JSON.stringify(value)}) })()`,
        )
        if (contains === true) return done(`正文包含：${value}`)
      }
      await delay(120)
    }
    return {
      matched: false,
      detail: `等待 ${input.for} 条件超时：${value === '' ? '(无)' : value}`,
      url: safeUrl(session.guest),
      title: safeTitle(session.guest),
    }
  }

  async screenshot(sessionId: string, fullPage: boolean): Promise<BrowserScreenshotResult> {
    const session = this.requireSession(sessionId)
    this.slots.touch(sessionId)
    // 截图前把标签切到前台：隐藏标签可能不出帧，同时这也符合「让用户看见」的产品口径。
    this.emitStatus(sessionId, 'busy', '正在截图', true)
    try {
      const png = await this.capturePng(session, fullPage)
      return await this.persistScreenshot(png, fullPage)
    } finally {
      if (this.sessions.has(sessionId)) this.emitStatus(sessionId, 'ready', '已就绪')
    }
  }

  async evaluate(sessionId: string, expression: string): Promise<BrowserEvalResult> {
    const session = this.requireSession(sessionId)
    this.slots.touch(sessionId)
    this.emitStatus(sessionId, 'busy', '正在执行页面脚本')
    try {
      const value = await this.evaluateValue(session, expression)
      const serialized = serializeValue(value)
      return {
        value:
          serialized.length > 20_000 ? `${serialized.slice(0, 20_000)}\n…（已截断）` : serialized,
        truncated: serialized.length > 20_000,
      }
    } finally {
      if (this.sessions.has(sessionId)) this.emitStatus(sessionId, 'ready', '已就绪')
    }
  }

  /** 结束一个会话（关闭工具 / 用户停止 / 标签关闭 / 空闲 / 能力关闭）。标签页保留。 */
  stop(sessionId: string, reason: string): boolean {
    const pending = this.pendingFor(sessionId)
    if (pending !== undefined) {
      clearTimeout(pending.timer)
      this.pending.delete(pending.requestId)
      pending.reject(new Error(reason))
    }
    const session = this.sessions.get(sessionId)
    if (session === undefined) {
      const released = this.slots.release(sessionId)
      return released
    }
    this.sessions.delete(sessionId)
    for (const cleanup of session.cleanups.splice(0)) {
      try {
        cleanup()
      } catch {
        // 监听解绑失败不影响收尾
      }
    }
    if (session.debuggerAttached && !session.guest.isDestroyed()) {
      try {
        session.guest.debugger.removeAllListeners('message')
        session.guest.debugger.detach()
      } catch {
        // 已被 DevTools 或进程退出抢先解绑：忽略
      }
    }
    this.slots.release(sessionId)
    this.emitStatus(sessionId, 'released', reason)
    this.deps.logger.info('内置浏览器会话结束', { sessionId, reason })
    return true
  }

  /** 结束全部会话（关闭能力 / 应用退出）。 */
  stopAll(reason: string): void {
    for (const sessionId of [...this.sessions.keys()]) this.stop(sessionId, reason)
    for (const pending of [...this.pending.values()]) {
      clearTimeout(pending.timer)
      this.pending.delete(pending.requestId)
      pending.reject(new Error(reason))
    }
    for (const sessionId of this.slots.ids()) this.slots.release(sessionId)
  }

  /** 渲染层回执：成功带 guest id，失败带 error。 */
  report(request: {
    requestId: string
    sessionId: string
    tabId?: string
    webContentsId?: number
    error?: string
  }): void {
    const pending = this.pending.get(request.requestId)
    if (pending === undefined) {
      throw new Error('这次打开请求已过期，请重试。')
    }
    if (pending.sessionId !== request.sessionId) {
      throw new Error('打开请求与当前会话不匹配。')
    }
    clearTimeout(pending.timer)
    this.pending.delete(request.requestId)
    if (request.error !== undefined && request.error !== '') {
      pending.reject(new Error(request.error))
      return
    }
    const id = request.webContentsId
    if (id === undefined) {
      pending.reject(new Error('渲染层没有返回浏览器进程 id。'))
      return
    }
    const guest = webContents.fromId(id)
    if (guest === undefined || guest.isDestroyed()) {
      pending.reject(new Error('浏览器页面进程已退出，请重试。'))
      return
    }
    const chatId = this.deps.chatWebContentsId()
    if (chatId === undefined || guest.hostWebContents?.id !== chatId) {
      pending.reject(new Error('浏览器进程归属校验失败（不是主界面的内置浏览器）。'))
      return
    }
    const existing = this.sessions.get(request.sessionId)
    if (existing !== undefined && existing.guest.id !== guest.id) {
      pending.reject(new Error('该会话已有另一个浏览器标签在运行。'))
      return
    }
    pending.resolve(guest, request.tabId ?? '')
  }

  dispose(): void {
    this.stopAll('应用退出')
    this.slots.dispose()
    this.disposed = true
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private assertAlive(): void {
    if (this.disposed) throw new Error('浏览器会话管理器已关闭。')
  }

  private configuredMaxSessions(): number {
    const raw = this.deps.settings().agent.browser.maxSessions
    const value = Number.isFinite(raw) ? Math.floor(raw) : 1
    return Math.min(MAX_AGENT_BROWSER_SESSIONS_HARD, Math.max(1, value))
  }

  private configuredIdleMinutes(): number {
    const raw = this.deps.settings().agent.browser.idleMinutes
    const value = Number.isFinite(raw) ? Math.floor(raw) : 10
    return Math.min(60, Math.max(1, value))
  }

  private configuredIdleMs(): number {
    return this.configuredIdleMinutes() * 60_000
  }

  private findByGuestId(webContentsId: number): AgentSession | undefined {
    for (const session of this.sessions.values()) {
      if (!session.guest.isDestroyed() && session.guest.id === webContentsId) return session
    }
    return undefined
  }

  private pendingFor(sessionId: string): PendingOpen | undefined {
    for (const pending of this.pending.values()) {
      if (pending.sessionId === sessionId) return pending
    }
    return undefined
  }

  private requireSession(sessionId: string): AgentSession {
    this.assertAlive()
    const session = this.sessions.get(sessionId)
    if (session === undefined || session.guest.isDestroyed()) {
      if (session !== undefined) this.stop(sessionId, '页面进程已退出')
      throw new Error('还没有打开内置浏览器会话，请先调用 browser_open。')
    }
    return session
  }

  private async requestGuest(
    sessionId: string,
    requestId: string,
    url: string,
    title: string,
  ): Promise<{ guest: WebContents; tabId: string }> {
    // 先等窗口真正加载完（而不是 showChat 之后立刻推）：首次创建 chat 窗口时
    // 渲染层还没订阅 `browser:agentOpen`，推送会静默丢弃 → 等满 15s 超时。
    await this.deps.presentChat()
    this.emitStatus(sessionId, 'opening', '正在打开浏览器标签')
    return new Promise<{ guest: WebContents; tabId: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('浏览器标签在 15 秒内没有就绪（窗口可能被隐藏或渲染层未响应）。'))
      }, ATTACH_TIMEOUT_MS)
      this.pending.set(requestId, {
        requestId,
        sessionId,
        url,
        resolve: (guest, tabId) => resolve({ guest, tabId }),
        reject,
        timer,
      })
      this.deps.sendToChat('browser:agentOpen', { requestId, sessionId, url, title })
    })
  }

  private installListeners(session: AgentSession): void {
    const guest = session.guest

    /**
     * 页面自身发起的导航也要过一遍策略（v35 审查修复）：
     * 首次 `browser_open` 的放行只代表那一跳，页面里的 `location=…` / 链接跳转 /
     * 服务端 302 仍可能落到内网。`will-navigate` / `will-redirect` 里逐次判定，
     * 拒绝就 `preventDefault()` 并在徽章上给出原因（不静默）。
     */
    const guardNavigation = (details: {
      url?: string
      isMainFrame?: boolean
      isSameDocument?: boolean
      preventDefault: () => void
    }): void => {
      if (details.isMainFrame !== true || details.isSameDocument === true) return
      const target = details.url ?? ''
      if (target === '' || target === 'about:blank') return
      const verdict = this.deps.allowNavigation(target)
      if (verdict.ok) return
      details.preventDefault()
      session.lastFailure = verdict.reason
      this.emitStatus(session.sessionId, 'ready', `已阻止：${verdict.reason}`)
      this.deps.logger.warn('内置浏览器已阻止页面导航', {
        sessionId: session.sessionId,
        reason: verdict.reason,
      })
    }
    guest.on('will-navigate', guardNavigation)
    session.cleanups.push(() => guest.off('will-navigate', guardNavigation))
    guest.on('will-redirect', guardNavigation)
    session.cleanups.push(() => guest.off('will-redirect', guardNavigation))

    // 弹窗：Agent 标签里的 window.open 也走同一条策略；放行的 http(s) 仍交给
    // 渲染层另开普通标签（与 window-manager 对用户标签的语义一致）。
    guest.setWindowOpenHandler(({ url: target }) => {
      const verdict = this.deps.allowNavigation(target)
      if (!verdict.ok) {
        this.emitStatus(session.sessionId, 'ready', `已阻止弹窗：${verdict.reason}`)
        return { action: 'deny' }
      }
      if (/^https?:\/\//i.test(target)) {
        this.deps.sendToChat('browser:openTab', { url: target })
      }
      return { action: 'deny' }
    })

    const onConsole = (details: {
      level?: 'info' | 'warning' | 'error' | 'debug'
      message?: string
      sourceId?: string
      lineNumber?: number
    }): void => {
      const level =
        details.level === 'error'
          ? 'error'
          : details.level === 'warning'
            ? 'warning'
            : details.level === 'info'
              ? 'info'
              : 'verbose'
      pushRing(session.consoleEntries, {
        level,
        message: details.message ?? '',
        source: details.sourceId ?? '',
        line: details.lineNumber ?? 0,
      })
    }
    guest.on('console-message', onConsole)
    session.cleanups.push(() => guest.off('console-message', onConsole))

    const onStartNavigation = (details: {
      isMainFrame?: boolean
      isSameDocument?: boolean
    }): void => {
      if (details.isMainFrame !== true || details.isSameDocument === true) return
      session.consoleEntries.length = 0
      session.networkEntries.length = 0
      session.networkRequests.clear()
      session.lastFailure = undefined
    }
    guest.on('did-start-navigation', onStartNavigation)
    session.cleanups.push(() => guest.off('did-start-navigation', onStartNavigation))

    const onFailLoad = (
      _event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ): void => {
      // -3 = ERR_ABORTED：被新导航打断，不是失败（与 BrowserPanel 同口径）
      if (isMainFrame !== true || errorCode === -3) return
      session.lastFailure = `无法加载 ${validatedURL}：${errorDescription}（${errorCode}）`
    }
    guest.on('did-fail-load', onFailLoad)
    session.cleanups.push(() => guest.off('did-fail-load', onFailLoad))

    const onDestroyed = (): void => {
      this.stop(session.sessionId, '浏览器标签已被关闭')
    }
    guest.once('destroyed', onDestroyed)
    session.cleanups.push(() => guest.off('destroyed', onDestroyed))
  }

  private attachDebugger(session: AgentSession): void {
    const guest = session.guest
    try {
      guest.debugger.attach('1.3')
      session.debuggerAttached = true
    } catch (error) {
      session.debuggerAttached = false
      this.deps.logger.warn('内置浏览器调试器附加失败，降级为 JS 模式（点击/输入不可用）', {
        sessionId: session.sessionId,
        error: String(error),
      })
      return
    }
    try {
      void guest.debugger.sendCommand('Network.enable').catch(() => undefined)
    } catch {
      // Network 域不可用只影响 network 读取
    }
    const onMessage = (_event: unknown, method: string, params: unknown): void => {
      this.handleCdpEvent(session, method, params)
    }
    guest.debugger.on('message', onMessage)
    session.cleanups.push(() => guest.debugger.removeAllListeners('message'))
  }

  private handleCdpEvent(session: AgentSession, method: string, params: unknown): void {
    if (method === 'Network.requestWillBeSent') {
      const value = params as CdpNetworkParams
      const id = value.requestId
      const url = value.request?.url
      if (id === undefined || url === undefined) return
      session.networkRequests.set(id, {
        method: value.request?.method ?? 'GET',
        url,
        resourceType: value.type ?? 'Other',
      })
      if (session.networkRequests.size > LOG_RING) {
        const first = session.networkRequests.keys().next().value
        if (first !== undefined) session.networkRequests.delete(first)
      }
      return
    }
    if (method === 'Network.responseReceived') {
      const value = params as CdpNetworkParams
      const id = value.requestId
      if (id === undefined) return
      const request = session.networkRequests.get(id)
      const status = value.response?.status ?? 0
      pushRing(session.networkEntries, {
        method: request?.method ?? 'GET',
        url: request?.url ?? value.response?.url ?? '',
        status,
        resourceType: request?.resourceType ?? 'Other',
        ok: status >= 200 && status < 400,
      })
      session.networkRequests.delete(id)
      return
    }
    if (method === 'Network.loadingFailed') {
      const value = params as CdpNetworkParams
      const id = value.requestId
      if (id === undefined) return
      const request = session.networkRequests.get(id)
      pushRing(session.networkEntries, {
        method: request?.method ?? 'GET',
        url: request?.url ?? '',
        status: 0,
        resourceType: request?.resourceType ?? 'Other',
        ok: false,
      })
      session.networkRequests.delete(id)
    }
  }

  private async ensureNavigated(session: AgentSession, url: string): Promise<void> {
    const guest = session.guest
    if (guest.isDestroyed()) throw new Error('浏览器标签已被关闭，请重试。')
    const current = guest.getURL()
    if (!sameUrl(current, url) && current !== '') {
      await this.loadUrl(session, url)
      return
    }
    if (current === '') {
      await this.loadUrl(session, url)
      return
    }
    await this.waitForLoad(session, NAVIGATION_TIMEOUT_MS)
    if (session.lastFailure !== undefined) throw new Error(session.lastFailure)
  }

  private async navigate(session: AgentSession, url: string): Promise<void> {
    if (!sameUrl(session.guest.getURL(), url)) {
      await this.loadUrl(session, url)
      return
    }
    await this.waitForLoad(session, NAVIGATION_TIMEOUT_MS)
    if (session.lastFailure !== undefined) throw new Error(session.lastFailure)
  }

  private async loadUrl(session: AgentSession, url: string): Promise<void> {
    const guest = session.guest
    try {
      await withTimeout(guest.loadURL(url), NAVIGATION_TIMEOUT_MS, () => {
        return new Error(`打开 ${url} 超时（${NAVIGATION_TIMEOUT_MS}ms）。`)
      })
    } catch (error) {
      throw new Error(`打开 ${url} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (session.lastFailure !== undefined) throw new Error(session.lastFailure)
  }

  private waitForLoad(session: AgentSession, timeoutMs: number): Promise<void> {
    const guest = session.guest
    if (!guest.isLoading()) {
      return session.lastFailure === undefined
        ? Promise.resolve()
        : Promise.reject(new Error(session.lastFailure))
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          cleanup()
          reject(new Error(`等待页面加载超时（${timeoutMs}ms）。`))
        },
        Math.max(1_000, timeoutMs),
      )
      const onFinish = (): void => {
        cleanup()
        if (session.lastFailure !== undefined) reject(new Error(session.lastFailure))
        else resolve()
      }
      const onFail = (): void => {
        cleanup()
        reject(new Error(session.lastFailure ?? '页面加载失败。'))
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        guest.off('did-finish-load', onFinish)
        guest.off('did-fail-load', onFail)
      }
      guest.on('did-finish-load', onFinish)
      guest.on('did-fail-load', onFail)
      if (!guest.isLoading()) onFinish()
    })
  }

  private async runAction(
    session: AgentSession,
    action: 'click' | 'hover' | 'type' | 'press' | 'scroll' | 'select',
    params: {
      ref?: string
      text?: string
      key?: string
      direction?: 'up' | 'down' | 'left' | 'right'
      amount?: number
      value?: string
    },
  ): Promise<string> {
    if (action === 'select') {
      const ref = params.ref ?? ''
      const value = params.value ?? ''
      const result = await this.evaluateValue(
        session,
        `(() => {
          const el = document.querySelector('[data-aurora-ref="' + ${JSON.stringify(ref)} + '"]');
          if (!el) return { ok: false, reason: 'missing' };
          const options = Array.from(el.options || []);
          const match = options.find((item) => item.value === ${JSON.stringify(value)} || item.text === ${JSON.stringify(value)});
          if (!match) return { ok: false, reason: 'no-option', options: options.map((item) => item.text) };
          el.value = match.value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, selected: match.text };
        })()`,
      )
      const record = result as {
        ok?: boolean
        reason?: string
        selected?: string
        options?: string[]
      }
      if (record?.ok !== true) {
        if (record?.reason === 'missing')
          throw new Error('元素已不在页面上，请重新 browser_snapshot。')
        const options = (record?.options ?? []).slice(0, 20).join(' / ')
        throw new Error(`下拉框里没有这个选项：${value}（可选：${options || '无'}）`)
      }
      return `已选择 [${ref}] ${record.selected ?? value}`
    }

    if (action === 'press') {
      const mapped = KEY_MAP[params.key ?? '']
      if (mapped === undefined) {
        throw new Error(
          `不支持的按键：${params.key ?? '(空)'}（可用 Enter / Tab / Escape / Backspace / Delete / ArrowUp / ArrowDown / ArrowLeft / ArrowRight / Space）。`,
        )
      }
      this.requiresCdp(session)
      await this.sendKey(session, mapped)
      return `已按下 ${mapped.key}`
    }

    if (action === 'scroll') {
      const direction = params.direction ?? 'down'
      const amount = Math.max(1, Math.min(5_000, Math.round(params.amount ?? 600)))
      this.requiresCdp(session)
      let x = 100
      let y = 100
      if (params.ref !== undefined) {
        const rect = await this.elementRect(session, params.ref)
        x = rect.x
        y = rect.y
      } else {
        const viewport = await this.evaluateValue(
          session,
          '(() => ({ w: Math.max(1, window.innerWidth), h: Math.max(1, window.innerHeight) }))()',
        )
        const size = viewport as { w?: number; h?: number }
        x = Math.round((size?.w ?? 800) / 2)
        y = Math.round((size?.h ?? 600) / 2)
      }
      const delta =
        direction === 'up'
          ? { x: 0, y: -amount }
          : direction === 'down'
            ? { x: 0, y: amount }
            : direction === 'left'
              ? { x: -amount, y: 0 }
              : { x: amount, y: 0 }
      await this.cdp(session, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX: delta.x,
        deltaY: delta.y,
      })
      return `已滚动 ${direction} ${amount}px`
    }

    if (action === 'click' || action === 'hover') {
      const ref = params.ref ?? ''
      const rect = await this.elementRect(session, ref)
      this.requiresCdp(session)
      if (rect.disabled)
        throw new Error(`元素 [${ref}] 处于禁用状态，无法${action === 'click' ? '点击' : '悬停'}。`)
      await this.cdp(session, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: rect.x,
        y: rect.y,
      })
      if (action === 'hover') return `已悬停 [${ref}]`
      await this.cdp(session, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: rect.x,
        y: rect.y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      })
      await this.cdp(session, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: rect.x,
        y: rect.y,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      })
      return `已点击 [${ref}]`
    }

    // type
    const ref = params.ref ?? ''
    const text = params.text ?? ''
    const focused = await this.evaluateValue(
      session,
      `(() => {
        const el = document.querySelector('[data-aurora-ref="' + ${JSON.stringify(ref)} + '"]');
        if (!el) return false;
        el.focus();
        if (typeof el.select === 'function' && el.tagName !== 'TEXTAREA') el.select();
        return document.activeElement === el;
      })()`,
    )
    if (focused !== true) throw new Error('元素已不在页面上，请重新 browser_snapshot。')
    this.requiresCdp(session)
    try {
      session.guest.focus()
    } catch {
      // 窗口已销毁 / 不可聚焦：继续走 CDP，失败时由下方回落兜住
    }
    // 逐字符 `Input.dispatchKeyEvent(type:'char')` 而不是 `Input.insertText`：
    // 后者在 Electron 的 webview guest 上实测**不落到输入框**（冒烟里 type 后读到空值），
    // 而 char 事件走的是真实键盘输入管线（React 受控输入也会收到 input 事件）。
    for (const char of [...text]) {
      if (char === '\n') {
        await this.sendKey(
          session,
          KEY_MAP['Enter'] ?? { key: 'Enter', code: 'Enter', keyCode: 13 },
        )
        continue
      }
      await this.cdp(session, 'Input.dispatchKeyEvent', {
        type: 'char',
        text: char,
        unmodifiedText: char,
        key: char,
      })
    }
    // 真实输入不一定在所有宿主环境都落进元素（窗口未获得键盘焦点时 CDP 的 char 事件
    // 会被丢弃，实测冒烟里读回空值）。这里**校验一次**，没落进去就回落到原生 setter +
    // input/change 事件（受控组件也能感知），并如实标注 `inputMode` 交给结果文案 ——
    // 静默地"以为输入了"比失败更糟。
    const landed = await this.evaluateValue(
      session,
      `(() => {
        const el = document.querySelector('[data-aurora-ref="' + ${JSON.stringify(ref)} + '"]');
        if (!el) return false;
        const value = typeof el.value === 'string' ? el.value : (el.isContentEditable ? (el.textContent || '') : '');
        return value.indexOf(${JSON.stringify(text)}) !== -1;
      })()`,
    )
    if (landed === true) return `已在 [${ref}] 输入 ${text.length} 个字符`
    const applied = await this.evaluateValue(
      session,
      `(() => {
        const el = document.querySelector('[data-aurora-ref="' + ${JSON.stringify(ref)} + '"]');
        if (!el) return false;
        const text = ${JSON.stringify(text)};
        if (el.isContentEditable) {
          el.textContent = text;
        } else {
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
          if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(el, text);
          else el.value = text;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
    )
    if (applied !== true) throw new Error('输入失败：元素已不在页面上，请重新 browser_snapshot。')
    return `已在 [${ref}] 输入 ${text.length} 个字符（键盘事件未落到元素，已用原生赋值兜底）`
  }

  private requiresCdp(session: AgentSession): void {
    if (session.debuggerAttached) return
    throw new Error(
      '浏览器调试器未附加（该标签可能开着开发者工具），点击 / 输入暂时不可用；请关闭该标签的开发者工具后重试。',
    )
  }

  private async elementRect(
    session: AgentSession,
    ref: string,
  ): Promise<{ x: number; y: number; disabled: boolean }> {
    const value = await this.evaluateValue(
      session,
      `(() => {
        const el = document.querySelector('[data-aurora-ref="' + ${JSON.stringify(ref)} + '"]');
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, disabled: el.disabled === true };
      })()`,
    )
    if (value === null || value === undefined) {
      throw new Error('元素已不在页面上（或不可见），请重新 browser_snapshot。')
    }
    const rect = value as { x?: number; y?: number; disabled?: boolean }
    return {
      x: Math.max(0, Math.round(rect.x ?? 0)),
      y: Math.max(0, Math.round(rect.y ?? 0)),
      disabled: rect.disabled === true,
    }
  }

  private async sendKey(session: AgentSession, mapped: KeyDefinition): Promise<void> {
    const base = {
      key: mapped.key,
      code: mapped.code,
      windowsVirtualKeyCode: mapped.keyCode,
      nativeVirtualKeyCode: mapped.keyCode,
    }
    await this.cdp(session, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base })
    await this.cdp(session, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  private async cdp(session: AgentSession, method: string, params: unknown): Promise<unknown> {
    if (!session.debuggerAttached) this.requiresCdp(session)
    return withTimeout(
      session.guest.debugger.sendCommand(method, params as Record<string, unknown>),
      ACTION_TIMEOUT_MS,
      () => new Error(`浏览器操作超时（${method}）。`),
    )
  }

  private async evaluateValue(session: AgentSession, expression: string): Promise<unknown> {
    const guest = session.guest
    try {
      return await withTimeout(
        guest.executeJavaScript(expression, true),
        ACTION_TIMEOUT_MS,
        () => new Error('页面脚本执行超时。'),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/context was destroyed|Execution context|Cannot find context/i.test(message)) {
        // 导航把执行上下文换掉了：等页面稳定后重试一次
        await this.waitForLoad(session, 5_000).catch(() => undefined)
        return withTimeout(
          guest.executeJavaScript(expression, true),
          ACTION_TIMEOUT_MS,
          () => new Error('页面脚本执行超时。'),
        )
      }
      throw error
    }
  }

  private async readPageText(session: AgentSession): Promise<{
    url: string
    title: string
    text: string
    truncated: boolean
  }> {
    const value = (await this.evaluateValue(
      session,
      `(() => {
        const text = document.body ? document.body.innerText : '';
        return { url: location.href, title: document.title, text: text.slice(0, ${MAX_SNAPSHOT_TEXT}), truncated: text.length > ${MAX_SNAPSHOT_TEXT} };
      })()`,
    )) as { url?: string; title?: string; text?: string; truncated?: boolean } | undefined
    return {
      url: value?.url ?? safeUrl(session.guest),
      title: value?.title ?? safeTitle(session.guest),
      text: value?.text ?? '',
      truncated: value?.truncated === true,
    }
  }

  private async capturePng(session: AgentSession, fullPage: boolean): Promise<Buffer> {
    if (session.debuggerAttached) {
      try {
        const params: Record<string, unknown> = { format: 'png', fromSurface: true }
        if (fullPage) {
          const metrics = (await this.cdp(session, 'Page.getLayoutMetrics', {})) as {
            cssContentSize?: { width?: number; height?: number }
            contentSize?: { width?: number; height?: number }
          }
          const rawWidth = metrics?.cssContentSize?.width ?? metrics?.contentSize?.width ?? 0
          const rawHeight = metrics?.cssContentSize?.height ?? metrics?.contentSize?.height ?? 0
          if (rawWidth > 0 && rawHeight > 0) {
            const width = Math.min(MAX_FULL_PAGE_DIMENSION, Math.max(1, Math.ceil(rawWidth)))
            const height = Math.min(MAX_FULL_PAGE_DIMENSION, Math.max(1, Math.ceil(rawHeight)))
            params['captureBeyondViewport'] = true
            params['clip'] = { x: 0, y: 0, width, height, scale: 1 }
          }
          // 度量拿不到（老版本 / 特殊页面）就不加 clip，退回可视区域截图 ——
          // 截 1×1 的图比"没截整页"更像故障。
        }
        const result = (await this.cdp(session, 'Page.captureScreenshot', params)) as {
          data?: string
        }
        if (typeof result?.data === 'string' && result.data !== '') {
          return Buffer.from(result.data, 'base64')
        }
      } catch (error) {
        this.deps.logger.warn('CDP 截图失败，回落到 capturePage', {
          sessionId: session.sessionId,
          error: String(error),
        })
      }
    }
    const image = await session.guest.capturePage()
    if (image.isEmpty()) throw new Error('截图失败：页面没有可截取的画面。')
    return image.toPNG()
  }

  private async persistScreenshot(
    png: Buffer,
    fullPage: boolean,
  ): Promise<BrowserScreenshotResult> {
    if (png.byteLength === 0) throw new Error('截图失败：得到空图片。')
    let image = nativeImage.createFromBuffer(png)
    let bytes = png
    for (let round = 0; round < 3 && bytes.byteLength > MAX_SCREENSHOT_BYTES; round += 1) {
      const size = image.getSize()
      image = image.resize({
        width: Math.max(1, Math.round(size.width * 0.7)),
        quality: 'good',
      })
      bytes = image.toPNG()
    }
    if (bytes.byteLength > MAX_SCREENSHOT_BYTES) {
      throw new Error('截图失败：缩放后仍超过单图上限。')
    }
    const dir = this.deps.screenshotsDir
    await fs.mkdir(dir, { recursive: true })
    const filePath = join(dir, imageFileName(Date.now(), randomBytes(3).toString('hex')))
    await fs.writeFile(filePath, bytes)
    void pruneScreenshots(dir)
    const size = image.getSize()
    return {
      path: filePath,
      image: {
        path: filePath,
        image: {
          mimeType: 'image/png',
          dataBase64: bytes.toString('base64'),
          name: basename(filePath),
        },
      },
      width: size.width,
      height: size.height,
      bytes: bytes.byteLength,
      fullPage,
    }
  }

  private emitStatus(
    sessionId: string,
    state: 'opening' | 'ready' | 'busy' | 'released',
    detail: string,
    focus = false,
  ): void {
    const session = this.sessions.get(sessionId)
    const tabId = session?.tabId ?? ''
    this.deps.sendToChat('browser:agentStatus', {
      sessionId,
      ...(tabId === '' ? {} : { tabId }),
      state,
      detail,
      ...(focus ? { focus: true } : {}),
    })
  }
}

interface KeyDefinition {
  key: string
  code: string
  keyCode: number
}

const KEY_MAP: Record<string, KeyDefinition> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Space: { key: ' ', code: 'Space', keyCode: 32 },
}

function describeAction(
  action: string,
  params: { ref?: string; key?: string; direction?: string },
): string {
  if (action === 'press') return `按键 ${params.key ?? ''}`
  if (action === 'scroll') return `滚动 ${params.direction ?? 'down'}`
  if (action === 'type') return `输入 [${params.ref ?? ''}]`
  return `${action === 'click' ? '点击' : action === 'hover' ? '悬停' : action} [${params.ref ?? ''}]`
}

/** 快照脚本：纯 executeJavaScript（不依赖调试器），元素打 `data-aurora-ref` 供后续动作定位。 */
function snapshotScript(): string {
  return `(() => {
  const MAX_ELEMENTS = ${MAX_SNAPSHOT_ELEMENTS};
  const MAX_TEXT = ${MAX_SNAPSHOT_TEXT};
  const selector = 'a[href],button,input,textarea,select,summary,[role],[contenteditable=""],[contenteditable="true"],[tabindex]';
  document.querySelectorAll('[data-aurora-ref]').forEach((el) => el.removeAttribute('data-aurora-ref'));
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  };
  const roleOf = (el) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      return 'textbox';
    }
    if (el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '') return 'textbox';
    return el.getAttribute('role') || tag;
  };
  const nameOf = (el) => {
    const candidate = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('name') || (el.innerText || '').trim();
    return String(candidate || '').replace(/[\\n\\r\\t]+/g, ' ').slice(0, 80);
  };
  const valueOf = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return undefined;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'password') return '***';
    const value = el.value;
    return typeof value === 'string' && value.length <= 120 ? value : undefined;
  };
  const elements = [];
  let count = 0;
  for (const el of document.querySelectorAll(selector)) {
    if (count >= MAX_ELEMENTS) break;
    if (!isVisible(el)) continue;
    if (el.disabled === true && el.tagName.toLowerCase() === 'input' && (el.getAttribute('type') || '') === 'hidden') continue;
    const ref = 'e' + (count + 1);
    el.setAttribute('data-aurora-ref', ref);
    count += 1;
    const value = valueOf(el);
    elements.push({ ref, role: roleOf(el), name: nameOf(el), tag: el.tagName.toLowerCase(), disabled: el.disabled === true, ...(value === undefined ? {} : { value }) });
  }
  const active = document.activeElement;
  const activeRef = active && active.getAttribute ? active.getAttribute('data-aurora-ref') : null;
  const rawText = document.body ? document.body.innerText : '';
  const text = rawText.slice(0, MAX_TEXT);
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    ...(activeRef ? { activeRef } : {}),
    elements,
    text,
    truncated: rawText.length > MAX_TEXT || count >= MAX_ELEMENTS,
  };
})()`
}

function normalizeSnapshot(value: unknown): BrowserSnapshot {
  const record = value as {
    url?: unknown
    title?: unknown
    readyState?: unknown
    activeRef?: unknown
    elements?: unknown
    text?: unknown
    truncated?: unknown
  }
  const elements = Array.isArray(record?.elements)
    ? record.elements.filter((item): item is Record<string, unknown> => {
        return typeof item === 'object' && item !== null
      })
    : []
  return {
    url: typeof record?.url === 'string' ? record.url : '',
    title: typeof record?.title === 'string' ? record.title : '',
    readyState: typeof record?.readyState === 'string' ? record.readyState : 'unknown',
    ...(typeof record?.activeRef === 'string' && record.activeRef !== ''
      ? { activeRef: record.activeRef }
      : {}),
    elements: elements.slice(0, MAX_SNAPSHOT_ELEMENTS).map((item) => {
      return {
        ref: String(item['ref'] ?? ''),
        role: String(item['role'] ?? ''),
        name: String(item['name'] ?? ''),
        tag: String(item['tag'] ?? ''),
        ...(typeof item['value'] === 'string' ? { value: item['value'] } : {}),
        ...(item['disabled'] === true ? { disabled: true } : {}),
      }
    }),
    text: typeof record?.text === 'string' ? record.text : '',
    truncated: record?.truncated === true,
  }
}

function serializeValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function pushRing<T>(list: T[], item: T): void {
  list.push(item)
  if (list.length > LOG_RING) list.splice(0, list.length - LOG_RING)
}

function sameUrl(current: string, target: string): boolean {
  if (current === target) return true
  try {
    return new URL(current).href === new URL(target).href
  } catch {
    return current === target
  }
}

function safeUrl(guest: WebContents): string {
  try {
    return guest.isDestroyed() ? '' : guest.getURL()
  } catch {
    return ''
  }
}

function safeTitle(guest: WebContents): string {
  try {
    return guest.isDestroyed() ? '' : guest.getTitle()
  } catch {
    return ''
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorFactory: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(errorFactory()), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function pruneScreenshots(dir: string): Promise<void> {
  try {
    const names = (await fs.readdir(dir)).filter((name) => name.endsWith('.png'))
    const expired = selectExpiredFiles(names, SCREENSHOT_KEEP)
    for (const name of expired) await fs.rm(join(dir, name), { force: true })
  } catch {
    // 清理是维护动作，失败不影响这次截图
  }
}
