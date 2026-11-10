/**
 * 插件 RPC 契约（docs/14 §2.3、docs/15 §5）。
 *
 * 传输是 `utilityProcess` 的 `parentPort` 结构化克隆消息 —— 不用 NDJSON，
 * 也就不存在转义 / 分帧问题；但结构化克隆同样要求「只传可克隆的纯数据」。
 *
 * 纯类型 + 常量，无 Node 依赖：主进程（宿主）、`plugin-host`（子进程 bootstrap）
 * 与文档模板共用同一份口径。
 */
import type { PluginUsageQuery, PluginUsageSummary } from './usage.js'

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
  dialog: 10_000,
  configChanged: 5_000,
  event: 10_000,
  automation: 120_000,
  toolDefault: 60_000,
  toolMax: 600_000,
  ping: 5_000,
} as const

/**
 * 临时对话框（docs/14 §5.8）：
 * - 同时最多 4 扇窗（防失控常量）；每个插件同一时刻只允许 1 扇；
 * - 单次 `openDialog` 的入参 ≤ 64 KB；
 * - 最长存活 10 分钟：到点由宿主关闭并按「取消」结算，绝不常驻。
 */
export const PLUGIN_DIALOG_MAX_WINDOWS = 4
export const PLUGIN_DIALOG_MAX_LIFETIME_MS = 10 * 60 * 1000
export const PLUGIN_DIALOG_PARAMS_MAX_BYTES = 64 * 1024

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
  dialog: 'dialog.invoke',
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
  /** 流光提醒（2026-10-24，docs/07 §2.2.3）：与 `notify` 同属 `notifications` 权限 */
  banner: 'banner',
  log: 'log',
  emitEvent: 'emitEvent',
  openPanel: 'ui.openPanel',
  toast: 'ui.toast',
  panelEvent: 'ui.panelEvent',
  /** 打开临时对话框（`ui.dialogs` 权限，docs/14 §5.8）；参数与返回值见 `PluginDialogOpenResult` */
  openDialog: 'ui.openDialog',
  getConfig: 'config.get',
  setConfig: 'config.set',
  /** 本机用量统计（`usage` 权限，docs/14 §4.1）：只读聚合 */
  usageSummary: 'usage.summary',
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

/**
 * `invokeDialog(dialogId, method, params, ctx)` 的返回值（docs/14 §5.8）。
 *
 * - `schema`：替换声明式对话框的内容（可选）；
 * - `toast`：一句话反馈；
 * - `data`：交给 `ctx.ui.openDialog()` 调用方（页面型常用）；
 * - `close`：`true` 关闭窗口；`false` 保持打开（表单校验失败）；
 * - `submitted`：关闭时是否算「提交」（缺省 `true`；取消路径固定为 `false`）。
 */
export interface PluginDialogResult extends PluginPanelResult {
  close?: boolean
  submitted?: boolean
  /** `close: false` 时给用户看的一句话错误（渲染层保留窗口） */
  message?: string
  error?: string
}

/** `ctx.ui.openDialog()` 入参：对话框必须是清单里声明过的。 */
export interface PluginDialogOpenInput {
  dialogId: string
  /** 初始参数（≤ 64 KB）；会随每次 `invokeDialog` 以 `init` 字段提供给插件 */
  params?: unknown
}

/**
 * `ctx.ui.openDialog()` 的结算结果：窗口销毁后返回。
 *
 * - 声明式：`values` 是控件值（`bind` → 值），`data` 可被 `invokeDialog` 返回；
 * - 页面型：`values` 为空对象，页面传入的值由插件在 `invokeDialog` 里自行取用。
 */
export interface PluginDialogOpenResult {
  /** true = 通过「确定 / 提交」关闭；false = 取消 / × / Esc / 超时 / 插件退出 */
  submitted: boolean
  values: Record<string, unknown>
  data?: unknown
}

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
  /**
   * 本机用量统计（2026-10，docs/14 §4.1）：需要 `usage` 权限。
   *
   * 只返回计数（Token / 缓存命中 / 生图次数 / 语音次数），不含提示词、图片、音频与凭据；
   * 数据从支持该接口的版本起累积，不回溯历史会话。
   */
  usage: {
    summary(query?: PluginUsageQuery): Promise<PluginUsageSummary>
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
  /**
   * 流光提醒（2026-10-24，docs/07 §2.2.3）：在屏幕顶端弹一条置顶卡片 + 流光（可选朗读 / 提示音）。
   *
   * 与 `ctx.notify`（系统通知中心）是**两条独立通道**，谁也不能降级成对方。
   * 需要 `notifications` 权限；返回 `false` 表示没显示（去重合并 / 队列满 / 窗口不可用），
   * 不是异常 —— 插件应把它当"提醒已尽力"而不是重试。
   */
  banner(input: { title: string; body: string; speak?: boolean; sound?: boolean }): Promise<boolean>
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, detail?: unknown): void
  emitEvent(name: string, payload?: unknown): Promise<void>
  ui: {
    openPanel(panelId: string): Promise<void>
    toast(message: string, kind?: 'info' | 'error'): Promise<void>
    /** 向自己的面板 / 小组件推送事件（无需用户点刷新） */
    panelEvent(input: PluginPanelEventInput): Promise<void>
    /**
     * 唤起临时对话框（docs/14 §5.8）：需要 `ui.dialogs` 权限，且对话框已在清单声明。
     *
     * 窗口**常驻到用户处理完**（确定 / 取消 / 关闭 / 最长 10 分钟），结算后立即销毁；
     * 同一插件同一时刻只能打开一个。
     */
    openDialog(input: PluginDialogOpenInput): Promise<PluginDialogOpenResult>
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
  /** 临时对话框的内容 / 动作（声明式与页面型共用）；未实现时声明式对话框仍可用宿主按钮 */
  invokeDialog?(
    dialogId: string,
    method: string,
    params: unknown,
    ctx: PluginContext,
  ): PluginDialogResult | Promise<PluginDialogResult>
  onEvent?(event: string, payload: unknown, ctx: PluginContext): void | Promise<void>
  onConfigChanged?(config: Record<string, unknown>, ctx: PluginContext): void | Promise<void>
}
