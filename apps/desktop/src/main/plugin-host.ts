/**
 * 插件子进程 bootstrap（`utilityProcess.fork(out/main/plugin-host.js)`，docs/14 §2.2）。
 *
 * 进程边界：
 * - 本文件运行在**独立子进程**，只负责加载插件 `main.js`、注入 `ctx` 与转发 RPC；
 * - 权限白名单与配置 / 存储 / 网络的实际执行都在主进程（`PluginManager`），
 *   这里不判权限 —— 插件进程拿到的是「已经放行」的调用；
 * - 本进程不是 OS 沙箱：插件代码仍有当前用户的完整 Node 权限（docs/14 §2.6）。
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import {
  PLUGIN_CLIENT_CALLS,
  PLUGIN_HOST_CALLS,
  PLUGIN_STORAGE_VALUE_MAX_BYTES,
  PLUGIN_TOOL_CONTENT_MAX,
  type PluginContext,
  type PluginModule,
  type PluginRpcErrorCode,
} from '@aurora/shared'
import { PluginRpcFailure, PluginRpcPeer } from './plugins/protocol.js'

interface PluginInitParams {
  id: string
  version: string
  root: string
  main: string
  dataDir: string
  isDev: boolean
  config: Record<string, unknown>
  hostVersion: string
}

interface PluginState extends PluginInitParams {
  loadedAt: string
}

const port = process.parentPort
let state: PluginState | undefined
let pluginModule: PluginModule | undefined
let currentConfig: Record<string, unknown> = {}
const controllers = new Map<string, AbortController>()

function fail(code: PluginRpcErrorCode, message: string): never {
  throw new PluginRpcFailure(code, message)
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function requireState(): PluginState {
  if (state === undefined) fail('E_PLUGIN_NOT_READY', '插件尚未初始化')
  return state
}

function requireModule(): PluginModule {
  if (pluginModule === undefined) fail('E_PLUGIN_NOT_READY', '插件入口尚未加载')
  return pluginModule
}

function clientCall<T>(
  method: string,
  params: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return peer.request(method, params, {
    timeoutMs,
    ...(signal === undefined ? {} : { signal }),
  }) as Promise<T>
}

function makeContext(signal: AbortSignal): PluginContext {
  const current = requireState()
  // 每次调用新建 ctx（`signal` 独立）；`config` 用 getter 反映最新值，
  // 避免插件在长生命周期闭包里拿到第一次 init 的旧对象。
  const context = {
    plugin: {
      id: current.id,
      version: current.version,
      root: current.root,
      dataDir: current.dataDir,
      isDev: current.isDev,
    },
    storage: {
      get: (key: string) =>
        clientCall<unknown>(PLUGIN_CLIENT_CALLS.storageGet, { key }, 15_000, signal),
      set: async (key: string, value: unknown) => {
        const bytes = Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
        if (bytes > PLUGIN_STORAGE_VALUE_MAX_BYTES) {
          fail('E_PLUGIN_INVALID_ARGS', '单个存储值超过 256 KB')
        }
        await clientCall(PLUGIN_CLIENT_CALLS.storageSet, { key, value }, 15_000, signal)
      },
      delete: (key: string) =>
        clientCall(PLUGIN_CLIENT_CALLS.storageDelete, { key }, 15_000, signal),
      list: () => clientCall<string[]>(PLUGIN_CLIENT_CALLS.storageList, {}, 15_000, signal),
    },
    net: {
      fetch: (input: Parameters<PluginContext['net']['fetch']>[0]) =>
        clientCall(
          PLUGIN_CLIENT_CALLS.netFetch,
          input,
          Math.min(Math.max(input.timeoutMs ?? 30_000, 1_000) + 5_000, 120_000),
          signal,
        ),
    },
    notify: (input: Parameters<PluginContext['notify']>[0]) =>
      clientCall<boolean>(PLUGIN_CLIENT_CALLS.notify, input, 10_000, signal),
    log: (
      level: Parameters<PluginContext['log']>[0],
      message: Parameters<PluginContext['log']>[1],
      detail?: Parameters<PluginContext['log']>[2],
    ) => {
      // 日志不阻塞插件调用：失败只可能是宿主已经退出，没有补救价值。
      void peer
        .request(PLUGIN_CLIENT_CALLS.log, { level, message, detail }, { timeoutMs: 5_000 })
        .catch(() => undefined)
    },
    emitEvent: (name: Parameters<PluginContext['emitEvent']>[0], payload?: unknown) =>
      clientCall(PLUGIN_CLIENT_CALLS.emitEvent, { name, payload }, 10_000, signal),
    ui: {
      openPanel: (panelId: string) =>
        clientCall(PLUGIN_CLIENT_CALLS.openPanel, { panelId }, 10_000, signal),
      toast: (message: string, kind?: 'info' | 'error') =>
        clientCall(PLUGIN_CLIENT_CALLS.toast, { message, kind }, 10_000, signal),
      panelEvent: (input: Parameters<NonNullable<PluginContext['ui']['panelEvent']>>[0]) =>
        clientCall(PLUGIN_CLIENT_CALLS.panelEvent, input, 10_000, signal),
    },
    get config() {
      return currentConfig
    },
    signal,
  }
  return context as PluginContext
}

async function loadPluginModule(mainPath: string): Promise<PluginModule> {
  const localRequire = createRequire(mainPath)
  let raw: unknown
  try {
    raw = localRequire(mainPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_REQUIRE_ESM') throw error
    // 动态 import 在 CJS 产物里会被降级成 require，用 Function 保留真正的 import()。
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string,
    ) => Promise<unknown>
    raw = await dynamicImport(pathToFileURL(mainPath).href)
  }
  const record = asRecord(raw)
  const candidate =
    typeof record['default'] === 'object' && record['default'] !== null
      ? (record['default'] as Record<string, unknown>)
      : record
  return candidate as PluginModule
}

function truncateToolResult(value: unknown): unknown {
  const record = asRecord(value)
  const content = typeof record['content'] === 'string' ? record['content'] : ''
  const truncated =
    content.length > PLUGIN_TOOL_CONTENT_MAX
      ? `${content.slice(0, PLUGIN_TOOL_CONTENT_MAX)}\n\n[结果过长，已截断]`
      : content
  return {
    content: truncated,
    ...(record['isError'] === true ? { isError: true } : {}),
    ...(typeof record['summary'] === 'string' ? { summary: record['summary'] } : {}),
  }
}

async function dispatch(
  method: string,
  params: unknown,
  context: { id: string },
): Promise<unknown> {
  if (method === PLUGIN_HOST_CALLS.init) {
    if (pluginModule !== undefined) return { ok: true }
    const raw = asRecord(params)
    const id = typeof raw['id'] === 'string' ? raw['id'] : ''
    const root = typeof raw['root'] === 'string' ? raw['root'] : ''
    const main = typeof raw['main'] === 'string' ? raw['main'] : ''
    if (id === '' || root === '' || main === '') {
      fail('E_PLUGIN_INVALID_ARGS', '初始化参数不完整')
    }
    currentConfig = { ...asRecord(raw['config']) }
    state = {
      id,
      version: typeof raw['version'] === 'string' ? raw['version'] : '0.0.0',
      root,
      main,
      dataDir: typeof raw['dataDir'] === 'string' ? raw['dataDir'] : '',
      isDev: raw['isDev'] === true,
      config: currentConfig,
      hostVersion: typeof raw['hostVersion'] === 'string' ? raw['hostVersion'] : '',
      loadedAt: new Date().toISOString(),
    }
    try {
      pluginModule = await loadPluginModule(main)
    } catch (error) {
      pluginModule = undefined
      throw new PluginRpcFailure(
        'E_PLUGIN_NOT_READY',
        `插件入口加载失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return { ok: true, loadedAt: state.loadedAt }
  }

  requireState()

  if (method === PLUGIN_HOST_CALLS.ping) return { ok: true }

  if (method === PLUGIN_HOST_CALLS.activate) {
    const handler = pluginModule?.activate
    if (handler === undefined) return { ok: true }
    await handler.call(pluginModule, makeContext(new AbortController().signal))
    return { ok: true }
  }

  if (method === PLUGIN_HOST_CALLS.deactivate) {
    const handler = pluginModule?.deactivate
    if (handler !== undefined) await handler.call(pluginModule)
    return { ok: true }
  }

  if (method === PLUGIN_HOST_CALLS.configChanged) {
    currentConfig = { ...asRecord(asRecord(params)['config']) }
    const handler = pluginModule?.onConfigChanged
    if (handler !== undefined) {
      await handler.call(
        pluginModule,
        { ...currentConfig },
        makeContext(new AbortController().signal),
      )
    }
    return { ok: true }
  }

  const controller = new AbortController()
  controllers.set(context.id, controller)
  const signal = controller.signal
  try {
    if (method === PLUGIN_HOST_CALLS.tool) {
      const raw = asRecord(params)
      const handler = requireModule().invokeTool
      if (handler === undefined) fail('E_PLUGIN_INVALID_ARGS', '插件未实现 invokeTool')
      const result = await handler.call(
        pluginModule,
        typeof raw['name'] === 'string' ? raw['name'] : '',
        asRecord(raw['input']),
        makeContext(signal),
      )
      return truncateToolResult(result)
    }

    if (method === PLUGIN_HOST_CALLS.command) {
      const raw = asRecord(params)
      const handler = requireModule().invokeCommand
      if (handler === undefined) fail('E_PLUGIN_INVALID_ARGS', '插件未实现 invokeCommand')
      return await handler.call(
        pluginModule,
        typeof raw['name'] === 'string' ? raw['name'] : '',
        typeof raw['args'] === 'string' ? raw['args'] : '',
        makeContext(signal),
      )
    }

    if (method === PLUGIN_HOST_CALLS.automationAction) {
      const raw = asRecord(params)
      const handler = requireModule().invokeAutomationAction
      if (handler === undefined) {
        fail('E_PLUGIN_INVALID_ARGS', '插件未实现 invokeAutomationAction')
      }
      return await handler.call(
        pluginModule,
        typeof raw['name'] === 'string' ? raw['name'] : '',
        asRecord(raw['params']),
        makeContext(signal),
      )
    }

    if (method === PLUGIN_HOST_CALLS.panel) {
      const raw = asRecord(params)
      const handler = requireModule().invokePanel
      if (handler === undefined) fail('E_PLUGIN_INVALID_ARGS', '插件未实现 invokePanel')
      return await handler.call(
        pluginModule,
        typeof raw['panelId'] === 'string' ? raw['panelId'] : '',
        typeof raw['method'] === 'string' ? raw['method'] : '',
        raw['params'],
        makeContext(signal),
      )
    }

    if (method === PLUGIN_HOST_CALLS.widget) {
      const raw = asRecord(params)
      const handler = requireModule().invokeWidget
      if (handler === undefined) fail('E_PLUGIN_INVALID_ARGS', '插件未实现 invokeWidget')
      return await handler.call(
        pluginModule,
        typeof raw['widgetId'] === 'string' ? raw['widgetId'] : '',
        typeof raw['method'] === 'string' ? raw['method'] : '',
        raw['params'],
        makeContext(signal),
      )
    }

    if (method === PLUGIN_HOST_CALLS.event) {
      const raw = asRecord(params)
      const handler = pluginModule?.onEvent
      if (handler !== undefined) {
        await handler.call(
          pluginModule,
          typeof raw['event'] === 'string' ? raw['event'] : '',
          raw['payload'],
          makeContext(signal),
        )
      }
      return { ok: true }
    }

    fail('E_PLUGIN_INVALID_ARGS', `未知的插件调用：${method}`)
  } finally {
    controllers.delete(context.id)
  }
}

const peer = new PluginRpcPeer(
  { send: (message) => port.postMessage(message) },
  {
    label: 'plugin-host',
    onRequest: dispatch,
    onCancel: (id) => controllers.get(id)?.abort(),
    onEvent: (event, payload) => {
      const handler = pluginModule?.onEvent
      if (handler === undefined) return
      void Promise.resolve()
        .then(() =>
          handler.call(pluginModule, event, payload, makeContext(new AbortController().signal)),
        )
        .catch((error: unknown) => {
          void peer
            .request(
              PLUGIN_CLIENT_CALLS.log,
              {
                level: 'warn',
                message: 'onEvent 处理失败',
                detail: String(error),
              },
              { timeoutMs: 5_000 },
            )
            .catch(() => undefined)
        })
    },
  },
)

port.on('message', (event) => peer.handleMessage(event.data))

function reportFatal(error: unknown): void {
  try {
    port.postMessage({
      v: 1,
      kind: 'evt',
      event: 'plugin.fatal',
      payload: String(error),
    })
  } catch {
    /* 父进程已退出 */
  }
}

process.on('uncaughtException', (error) => {
  reportFatal(error)
  process.exit(1)
})
process.on('unhandledRejection', (error) => {
  reportFatal(error)
  process.exit(1)
})
