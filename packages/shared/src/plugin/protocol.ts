/**
 * 插件 RPC 契约（docs/14 §2.3、docs/15 §5）。
 *
 * 传输是 `utilityProcess` 的 `parentPort` 结构化克隆消息 —— 不用 NDJSON，
 * 也就不存在转义 / 分帧问题；但结构化克隆同样要求「只传可克隆的纯数据」。
 *
 * 纯类型 + 常量，无 Node 依赖：主进程（宿主）、`plugin-host`（子进程 bootstrap）
 * 与文档模板共用同一份口径。
 */

export const PLUGIN_RPC_VERSION = 1 as const

/** 单条消息上限 1 MiB；超限的宿主侧一律视为故障帧并终止插件进程。 */
export const PLUGIN_RPC_MAX_FRAME_BYTES = 1024 * 1024

/** 单插件同时在途的请求上限。 */
export const PLUGIN_RPC_MAX_INFLIGHT = 32

/** 各类调用的默认超时（毫秒）。工具的超时由清单声明，且有硬上限。 */
export const PLUGIN_RPC_TIMEOUTS = {
  init: 10_000,
  activate: 10_000,
  command: 10_000,
  panel: 10_000,
  widget: 10_000,
  configChanged: 5_000,
  event: 10_000,
  automation: 120_000,
  toolDefault: 60_000,
  toolMax: 600_000,
  ping: 5_000,
} as const

/** 心跳间隔与连续失败上限（失败即重启）。 */
export const PLUGIN_HEARTBEAT = {
  intervalMs: 30_000,
  maxMisses: 2,
} as const

/** 同时运行的插件进程上限（防失控常量，不做成设置项）。 */
export const PLUGIN_MAX_RUNNING = 8

/** 崩溃重启节奏与窗口内次数上限；超过即标记 `crashed` 并停用。 */
export const PLUGIN_RESTART_BACKOFF = [1_000, 5_000, 15_000] as const
export const PLUGIN_RESTART_WINDOW_MS = 10 * 60 * 1000

export const PLUGIN_ERROR_CODES = [
  'E_PLUGIN_NOT_READY',
  'E_PLUGIN_CRASHED',
  'E_PLUGIN_TIMEOUT',
  'E_PLUGIN_CANCELLED',
  'E_PLUGIN_PERMISSION',
  'E_PLUGIN_TOOL_FAILED',
  'E_PLUGIN_INVALID_ARGS',
  'E_PLUGIN_FRAME_TOO_LARGE',
  'E_PLUGIN_TOO_MANY_INFLIGHT',
  'E_PLUGIN_DISABLED',
] as const

export type PluginRpcErrorCode = (typeof PLUGIN_ERROR_CODES)[number]

export interface PluginRpcError {
  code: PluginRpcErrorCode | string
  message: string
  detail?: string
}

export type PluginRpcMessage =
  | {
      v: typeof PLUGIN_RPC_VERSION
      kind: 'req'
      id: string
      method: string
      params: unknown
    }
  | { v: typeof PLUGIN_RPC_VERSION; kind: 'res'; id: string; ok: true; result: unknown }
  | {
      v: typeof PLUGIN_RPC_VERSION
      kind: 'res'
      id: string
      ok: false
      error: PluginRpcError
    }
  | { v: typeof PLUGIN_RPC_VERSION; kind: 'evt'; event: string; payload: unknown }
  | { v: typeof PLUGIN_RPC_VERSION; kind: 'cancel'; id: string }

/** 宿主 → 插件进程的调用名。 */
export const PLUGIN_HOST_CALLS = {
  init: 'plugin.init',
  activate: 'plugin.activate',
  deactivate: 'plugin.deactivate',
  ping: 'plugin.ping',
  tool: 'tool.invoke',
  command: 'command.invoke',
  automationAction: 'automation.action',
  panel: 'panel.invoke',
  widget: 'widget.invoke',
  event: 'event.deliver',
  configChanged: 'config.changed',
  /** 宿主主动推送的窗口 / 面板事件（插件页面 RPC 也复用它） */
  system: 'system.event',
} as const

/** 插件 → 宿主的白名单调用名（按权限逐条校验）。 */
export const PLUGIN_CLIENT_CALLS = {
  storageGet: 'storage.get',
  storageSet: 'storage.set',
  storageDelete: 'storage.delete',
  storageList: 'storage.list',
  netFetch: 'net.fetch',
  notify: 'notify',
  log: 'log',
  emitEvent: 'emitEvent',
  openPanel: 'ui.openPanel',
  toast: 'ui.toast',
  panelEvent: 'ui.panelEvent',
  getConfig: 'config.get',
  setConfig: 'config.set',
} as const

/** 宿主可投递给插件的事件名（清单 `events` 只能从这里选）。 */
export const PLUGIN_HOST_EVENTS = [
  'settings.changed',
  'message.user',
  'message.assistant',
  'tool.after',
  'session.created',
  'session.deleted',
  'theme.changed',
] as const

export type PluginHostEventName = (typeof PLUGIN_HOST_EVENTS)[number]

/** 插件工具 / 命令 / 自动化动作的返回值形状（只允许文本，见 docs/14 §2.4）。 */
export interface PluginToolResult {
  content: string
  isError?: boolean
  summary?: string
}

export interface PluginCommandResult {
  /** `mode: 'prompt'` 的命令把这段文本追加给 Agent（等价于用户消息 + 额外上下文） */
  prompt?: string
  /** 给用户看的一句话回执 */
  summary?: string
}

export interface PluginAutomationActionResult {
  summary?: string
}

export interface PluginPanelResult {
  /** 新的声明式面板 schema（可选；不返回表示沿用当前） */
  schema?: unknown
  /** 一句话 toast */
  toast?: string
  /**
   * 任意只读数据（仅页面型面板：`auroraPlugin.request()` 的返回值原样回给页面）。
   * 声明式面板忽略这个字段；大小仍受 RPC 的 1 MiB 帧上限约束。
   */
  data?: unknown
}

/** 小组件调用与面板同形（`invokeWidget` 的返回值）。 */
export type PluginWidgetResult = PluginPanelResult

/** 插件 → 宿主 → 渲染层的事件推送输入（`ctx.ui.panelEvent`）。 */
export interface PluginPanelEventInput {
  /** 与 widgetId 二选一 */
  panelId?: string
  widgetId?: string
  /** 事件名：`^[a-z][a-z0-9_.-]{0,63}$` */
  event: string
  payload?: unknown
}

/** 推送事件名与载荷限制（主进程判定，渲染层不信任）。 */
export const PLUGIN_PANEL_EVENT = {
  namePattern: /^[a-z][a-z0-9_.-]{0,63}$/,
  payloadMaxBytes: 64 * 1024,
  /** 每插件每秒最多投递条数；超出丢弃并记 warn，不打断插件 */
  ratePerSecond: 20,
} as const

/** 工具结果的文本上限；超出由宿主截断并标注。 */
export const PLUGIN_TOOL_CONTENT_MAX = 100 * 1024
/** 插件键值存储的总配额（单值另限 256 KB）。 */
export const PLUGIN_STORAGE_MAX_BYTES = 5 * 1024 * 1024
export const PLUGIN_STORAGE_VALUE_MAX_BYTES = 256 * 1024
/** `net.fetch` 的响应体上限。 */
export const PLUGIN_NET_MAX_RESPONSE_BYTES = 5 * 1024 * 1024

/**
 * 插件进程内的 `ctx`（宿主 bootstrap 注入，不是 RPC 代理）。
 * 每次调用拿到的是同一份对象，`signal` 是本次调用的独立 AbortSignal。
 */
export interface PluginContext {
  plugin: {
    id: string
    version: string
    root: string
    dataDir: string
    isDev: boolean
  }
  config: Readonly<Record<string, unknown>>
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
    list(): Promise<string[]>
  }
  net: {
    fetch(input: {
      url: string
      method?: string
      headers?: Record<string, string>
      body?: string
      timeoutMs?: number
    }): Promise<{ status: number; headers: Record<string, string>; body: string }>
  }
  notify(input: { title: string; body: string }): Promise<boolean>
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, detail?: unknown): void
  emitEvent(name: string, payload?: unknown): Promise<void>
  ui: {
    openPanel(panelId: string): Promise<void>
    toast(message: string, kind?: 'info' | 'error'): Promise<void>
    /** 向自己的面板 / 小组件推送事件（无需用户点刷新） */
    panelEvent(input: PluginPanelEventInput): Promise<void>
  }
  signal: AbortSignal
}

/**
 * 插件 `main.js` 的导出契约（全部可选）。
 * 宿主按 `PLUGIN_HOST_CALLS` 找对应方法，缺哪个就回 `E_PLUGIN_INVALID_ARGS`。
 */
export interface PluginModule {
  activate?(ctx: PluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
  invokeTool?(
    name: string,
    input: Record<string, unknown>,
    ctx: PluginContext,
  ): PluginToolResult | Promise<PluginToolResult>
  invokeCommand?(
    name: string,
    args: string,
    ctx: PluginContext,
  ): PluginCommandResult | Promise<PluginCommandResult>
  invokeAutomationAction?(
    name: string,
    params: Record<string, unknown>,
    ctx: PluginContext,
  ): PluginAutomationActionResult | Promise<PluginAutomationActionResult>
  invokePanel?(
    panelId: string,
    method: string,
    params: unknown,
    ctx: PluginContext,
  ): PluginPanelResult | Promise<PluginPanelResult>
  invokeWidget?(
    widgetId: string,
    method: string,
    params: unknown,
    ctx: PluginContext,
  ): PluginWidgetResult | Promise<PluginWidgetResult>
  onEvent?(event: string, payload: unknown, ctx: PluginContext): void | Promise<void>
  onConfigChanged?(
    config: Record<string, unknown>,
    ctx: PluginContext,
  ): void | Promise<void>
}
