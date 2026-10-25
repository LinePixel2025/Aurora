import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  createDefaultSettings,
  PLUGIN_RPC_VERSION,
  type Logger,
  type PluginRpcMessage,
  type PluginUsageSummary,
  type Settings,
} from '@aurora/shared'
import { PluginManager } from './manager.js'
import { PluginRpcPeer } from './protocol.js'
import type {
  PluginProcessCallbacks,
  PluginProcessFactory,
  PluginProcessHandle,
} from './process.js'

const PLUGIN_ID = 'com.example.hello'

function silentLogger(): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  }
  return logger
}

type RequestMessage = Extract<PluginRpcMessage, { kind: 'req' }>
type ResponseMessage = Extract<PluginRpcMessage, { kind: 'res' }>

interface FakeBehavior {
  /** 这些方法不自动回包（用来测超时 / 取消） */
  silent: Set<string>
  /** `tool.invoke` 的返回值 */
  toolResult?: (input: unknown) => unknown
  /** `panel.invoke` 的返回值 */
  panelResult?: (panelId: string, method: string, params: unknown) => unknown
  /** `widget.invoke` 的返回值 */
  widgetResult?: (widgetId: string, method: string, params: unknown) => unknown
}

/** 假插件进程：自动回 init / activate / ping；可注入静默与工具返回值。 */
class FakePluginProcess implements PluginProcessHandle {
  readonly peer: PluginRpcPeer
  readonly sent: PluginRpcMessage[] = []
  killed = false
  started = false

  constructor(
    private readonly behavior: FakeBehavior,
    private readonly callbacks: PluginProcessCallbacks,
  ) {
    this.peer = new PluginRpcPeer({
      send: (message) => {
        this.sent.push(message)
        if (message.kind !== 'req') return
        if (this.behavior.silent.has(message.method)) return
        queueMicrotask(() => this.reply(message))
      },
    })
  }

  start(): void {
    this.started = true
  }

  kill(): void {
    this.killed = true
  }

  /** 模拟进程退出（utilityProcess 的 exit 事件） */
  crash(code = 1): void {
    this.callbacks.onExit(code)
  }

  private reply(message: RequestMessage): void {
    let result: unknown = {}
    if (message.method === 'tool.invoke') {
      const params = message.params as { input?: unknown } | undefined
      result = this.behavior.toolResult?.(params?.input) ?? { content: 'ok' }
    }
    if (message.method === 'panel.invoke') {
      const params = message.params as {
        panelId?: string
        method?: string
        params?: unknown
      }
      result =
        this.behavior.panelResult?.(params?.panelId ?? '', params?.method ?? '', params?.params) ??
        {}
    }
    if (message.method === 'widget.invoke') {
      const params = message.params as {
        widgetId?: string
        method?: string
        params?: unknown
      }
      result =
        this.behavior.widgetResult?.(
          params?.widgetId ?? '',
          params?.method ?? '',
          params?.params,
        ) ?? {}
    }
    this.peer.handleMessage({
      v: PLUGIN_RPC_VERSION,
      kind: 'res',
      id: message.id,
      ok: true,
      result,
    })
  }
}

function helloManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PLUGIN_ID,
    name: 'Hello',
    version: '1.0.0',
    apiVersion: 1,
    description: '测试插件',
    author: { name: 'Test' },
    main: 'main.js',
    activation: 'startup',
    permissions: ['tools', 'storage', 'automation.events'],
    contributes: {
      tools: [
        {
          name: 'echo',
          description: '回显输入',
          parameters: { type: 'object', properties: { text: { type: 'string' } } },
          sensitivity: 'safe',
          readonly: false,
          timeoutMs: 1000,
        },
      ],
      automation: {
        actions: [],
        events: [{ name: 'todo-added', title: '新增待办' }],
      },
    },
    ...overrides,
  }
}

function fixedUsageSummary(): PluginUsageSummary {
  return {
    days: 30,
    from: '2026-09-26',
    to: '2026-10-25',
    tokens: {
      promptTokens: 1200,
      completionTokens: 300,
      totalTokens: 1500,
      cachedTokens: 600,
      rounds: 4,
      cacheHitRate: 0.5,
      background: {
        promptTokens: 200,
        completionTokens: 50,
        totalTokens: 250,
        cachedTokens: 100,
        rounds: 1,
      },
    },
    images: { generated: 3 },
    voice: { tts: 2, ttsChars: 20, stt: 1, sttChars: 8 },
    daily: [],
  }
}

interface HarnessOptions {
  mode: 'dev' | 'installed'
  manifest?: Record<string, unknown>
  settings?: (settings: Settings) => void
}

interface Harness {
  manager: PluginManager
  userData: string
  created: FakePluginProcess[]
  behavior: FakeBehavior
  settings: Settings
  automationEvents: Array<{ pluginId: string; event: string; data: unknown }>
  /** 插件 `ctx.banner` 收到的请求（docs/07 §2.2.3） */
  banners: Array<{ title: string; body: string; speak?: boolean; sound?: boolean }>
  /** 插件 `ctx.usage.summary` 的入参（docs/14 §4.1） */
  usageQueries: Array<{ days?: number } | undefined>
  panelEvents: Array<{
    pluginId: string
    panelId?: string
    widgetId?: string
    event: string
    payload?: unknown
  }>
}

const harnesses: Harness[] = []

async function createHarness(options: HarnessOptions): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'aurora-plugin-manager-'))
  const userData = join(root, 'userData')
  const manifest = options.manifest ?? helloManifest()
  const pluginFilesRoot = join(root, options.mode === 'dev' ? 'plugin' : 'installed')
  await mkdir(pluginFilesRoot, { recursive: true })
  await writeFile(join(pluginFilesRoot, 'manifest.json'), JSON.stringify(manifest))
  await writeFile(join(pluginFilesRoot, 'main.js'), 'module.exports = {}')
  // 清单声明的面板 / 小组件路径必须真实存在（readPluginManifest 会逐项校验）
  const contributes = (manifest['contributes'] ?? {}) as {
    panels?: Array<{ schema?: string; entry?: string }>
    widgets?: Array<{ schema?: string; entry?: string }>
  }
  for (const item of [...(contributes.panels ?? []), ...(contributes.widgets ?? [])]) {
    const file = item.schema ?? item.entry
    if (file === undefined) continue
    const absolute = join(pluginFilesRoot, file)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(
      absolute,
      item.schema === undefined
        ? '<!doctype html><html><body>page</body></html>'
        : '{"version":1,"nodes":[]}',
    )
  }

  const settings = createDefaultSettings()
  if (options.mode === 'dev') {
    settings.plugins.devDirs = [pluginFilesRoot]
  } else {
    const versionDir = join(userData, 'plugins', PLUGIN_ID, 'versions', '1.0.0')
    await mkdir(versionDir, { recursive: true })
    await writeFile(join(versionDir, 'manifest.json'), JSON.stringify(manifest))
    await writeFile(join(versionDir, 'main.js'), 'module.exports = {}')
    await mkdir(join(userData, 'plugins'), { recursive: true })
    await writeFile(
      join(userData, 'plugins', 'registry.json'),
      JSON.stringify({
        version: 1,
        plugins: {
          [PLUGIN_ID]: {
            id: PLUGIN_ID,
            enabled: true,
            trusted: false,
            source: 'local',
            activeVersion: '1.0.0',
            installPath: versionDir,
            installedAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
        },
      }),
    )
  }
  options.settings?.(settings)

  const behavior: FakeBehavior = { silent: new Set() }
  const created: FakePluginProcess[] = []
  const factory: PluginProcessFactory = {
    create(_request, callbacks) {
      const handle = new FakePluginProcess(behavior, callbacks)
      created.push(handle)
      return handle
    },
  }
  const automationEvents: Harness['automationEvents'] = []
  const panelEvents: Harness['panelEvents'] = []
  const banners: Harness['banners'] = []
  const usageQueries: Harness['usageQueries'] = []
  const manager = new PluginManager({
    userData,
    hostVersion: '0.6.0',
    logger: silentLogger(),
    processFactory: factory,
    getSettings: () => structuredClone(settings),
    onAutomationEvent: (payload) => {
      automationEvents.push({
        pluginId: payload.pluginId,
        event: payload.event,
        data: payload.data,
      })
    },
    onPanelEvent: (event) => {
      panelEvents.push({
        pluginId: event.pluginId,
        ...(event.panelId === undefined ? {} : { panelId: event.panelId }),
        ...(event.widgetId === undefined ? {} : { widgetId: event.widgetId }),
        event: event.event,
        payload: event.payload,
      })
    },
    // 流光提醒（docs/07 §2.2.3）：记下宿主收到的请求，断言截断与缺省标题口径
    banner: (input) => {
      banners.push(input)
      return true
    },
    usageSummary: (query) => {
      usageQueries.push(query)
      return fixedUsageSummary()
    },
  })
  await manager.init()

  const harness: Harness = {
    manager,
    userData,
    created,
    behavior,
    settings,
    automationEvents,
    panelEvents,
    banners,
    usageQueries,
  }
  harnesses.push(harness)
  return harness
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('等待条件超时')
}

let hostCallCounter = 0

function hostCall(
  handle: FakePluginProcess,
  method: string,
  params: unknown,
): Promise<ResponseMessage> {
  const id = `host-${++hostCallCounter}`
  handle.peer.handleMessage({ v: PLUGIN_RPC_VERSION, kind: 'req', id, method, params })
  return waitFor(() =>
    handle.sent.some((message) => message.kind === 'res' && message.id === id),
  ).then(() => {
    const response = handle.sent.find(
      (message): message is ResponseMessage => message.kind === 'res' && message.id === id,
    )
    if (response === undefined) throw new Error(`宿主调用无响应：${method}`)
    return response
  })
}

afterEach(async () => {
  vi.useRealTimers()
  while (harnesses.length > 0) {
    const harness = harnesses.pop()!
    await harness.manager.stopAll().catch(() => undefined)
    // 等落盘收尾（stopAll / 自动停用会异步写 registry.json）
    await new Promise((resolve) => setTimeout(resolve, 30))
    await rm(join(harness.userData, '..'), { recursive: true, force: true }).catch(() => undefined)
  }
})

describe('PluginManager · 安装态与贡献', () => {
  it('安装态插件默认 confirm；信任后清单的 safe 工具才按 safe 注册（并持久化）', async () => {
    const h = await createHarness({ mode: 'installed' })
    expect(h.manager.get(PLUGIN_ID)?.trusted).toBe(false)
    expect(h.manager.toolContributions()[0]).toMatchObject({
      fullName: `plugin.${PLUGIN_ID}.echo`,
      sensitivity: 'confirm',
    })

    await h.manager.setTrusted(PLUGIN_ID, true)
    expect(h.manager.toolContributions()[0]?.sensitivity).toBe('safe')

    const registry = JSON.parse(
      await readFile(join(h.userData, 'plugins', 'registry.json'), 'utf8'),
    ) as { plugins: Record<string, { trusted: boolean }> }
    expect(registry.plugins[PLUGIN_ID]?.trusted).toBe(true)
  })

  it('停用后工具贡献消失、status=disabled；重新启用后 startup 插件自动回来', async () => {
    const h = await createHarness({ mode: 'installed' })
    await h.manager.start()
    await waitFor(() => h.manager.get(PLUGIN_ID)?.status === 'ready')
    const first = h.created[0]!
    expect(first.started).toBe(true)

    await h.manager.setEnabled(PLUGIN_ID, false)
    expect(h.manager.get(PLUGIN_ID)?.status).toBe('disabled')
    expect(h.manager.toolContributions()).toEqual([])
    expect(first.killed).toBe(true)

    await h.manager.setEnabled(PLUGIN_ID, true)
    await waitFor(() => h.manager.get(PLUGIN_ID)?.status === 'ready')
    expect(h.created).toHaveLength(2)
    expect(h.manager.toolContributions()).toHaveLength(1)
  })
})

describe('PluginManager · 开发目录与调用', () => {
  it('开发目录插件原地加载；invokeTool 惰性启动并原样返回文本', async () => {
    const h = await createHarness({ mode: 'dev' })
    expect(h.manager.list()[0]).toMatchObject({ id: PLUGIN_ID, isDev: true, source: 'dev' })
    h.behavior.toolResult = (input) => ({
      content: `echo:${(input as { text?: string }).text ?? ''}`,
      summary: '已回显',
    })

    const result = await h.manager.invokeTool(PLUGIN_ID, 'echo', { text: '你好' })
    expect(result).toEqual({ content: 'echo:你好', summary: '已回显' })
    expect(h.manager.get(PLUGIN_ID)?.status).toBe('ready')
    // 进程只创建一次：第二次调用复用同一个 peer
    await h.manager.invokeTool(PLUGIN_ID, 'echo', { text: '再来' })
    expect(h.created).toHaveLength(1)
  })

  it('邀请函数签名正确：初始化请求带 id / main / dataDir', async () => {
    const h = await createHarness({ mode: 'dev' })
    await h.manager.invokeTool(PLUGIN_ID, 'echo', { text: 'x' })
    const init = h.created[0]!.sent.find(
      (message): message is RequestMessage =>
        message.kind === 'req' && message.method === 'plugin.init',
    )
    expect(init?.params).toMatchObject({
      id: PLUGIN_ID,
      main: expect.stringContaining('main.js'),
      isDev: true,
      hostVersion: '0.6.0',
    })
  })
})

describe('PluginManager · 宿主 API 权限白名单', () => {
  it('storage 有权限可读写；config / net / 未知方法一律 E_PLUGIN_PERMISSION', async () => {
    const h = await createHarness({ mode: 'dev' })
    await h.manager.invokeTool(PLUGIN_ID, 'echo', { text: 'x' })
    const handle = h.created[0]!

    const set = await hostCall(handle, 'storage.set', { key: 'k1', value: { a: 1 } })
    expect(set.ok).toBe(true)
    const got = await hostCall(handle, 'storage.get', { key: 'k1' })
    expect(got).toMatchObject({ ok: true, result: { a: 1 } })
    const list = await hostCall(handle, 'storage.list', {})
    expect(list).toMatchObject({ ok: true, result: ['k1'] })

    for (const method of [
      'config.get',
      'net.fetch',
      'notify',
      'banner',
      'usage.summary',
      'ui.openPanel',
      'unknown.method',
    ]) {
      const response = await hostCall(handle, method, {})
      expect(response.ok).toBe(false)
      if (!response.ok) expect(response.error.code).toBe('E_PLUGIN_PERMISSION')
    }
  })

  it('ctx.banner：notifications 权限下截断标题 / 正文，空标题回落插件名', async () => {
    const h = await createHarness({
      mode: 'dev',
      manifest: helloManifest({
        permissions: ['tools', 'storage', 'notifications', 'automation.events'],
      }),
    })
    await h.manager.invokeTool(PLUGIN_ID, 'echo', { text: 'x' })
    const handle = h.created[0]!

    const plain = await hostCall(handle, 'banner', { title: '构建完成', body: '产物已就绪' })
    expect(plain).toMatchObject({ ok: true, result: true })

    // 缺省标题用插件名；超长字段按 120 / 800 截断（与 ctx.notify 同一口径）
    const long = await hostCall(handle, 'banner', {
      title: '',
      body: 'x'.repeat(2000),
      speak: true,
      sound: false,
    })
    expect(long).toMatchObject({ ok: true, result: true })

    expect(h.banners).toHaveLength(2)
    expect(h.banners[0]).toEqual({ title: '构建完成', body: '产物已就绪' })
    expect(h.banners[1]?.title).toBe('Hello')
    expect(h.banners[1]?.body).toHaveLength(800)
    expect(h.banners[1]?.speak).toBe(true)
    expect(h.banners[1]?.sound).toBe(false)
  })

  it('ctx.usage.summary：usage 权限下透传 days，非法 days 拒绝（窗口夹取由账本负责）', async () => {
    const h = await createHarness({
      mode: 'dev',
      manifest: helloManifest({ permissions: ['tools', 'usage', 'automation.events'] }),
    })
    await h.manager.invokeTool(PLUGIN_ID, 'echo', { text: 'x' })
    const handle = h.created[0]!

    const response = await hostCall(handle, 'usage.summary', { days: 7 })
    expect(response).toMatchObject({
      ok: true,
      result: { images: { generated: 3 }, voice: { tts: 2, stt: 1 } },
    })
    expect(h.usageQueries).toEqual([{ days: 7 }])

    const missing = await hostCall(handle, 'usage.summary', {})
    expect(missing.ok).toBe(true)
    expect(h.usageQueries).toEqual([{ days: 7 }, undefined])

    const invalid = await hostCall(handle, 'usage.summary', { days: '7' })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error.code).toBe('E_PLUGIN_INVALID_ARGS')
  })

  it('storage 键非法 / 值超限被拒；emitEvent 只允许清单声明的事件', async () => {
    const h = await createHarness({ mode: 'dev' })
    await h.manager.invokeTool(PLUGIN_ID, 'echo', { text: 'x' })
    const handle = h.created[0]!

    const badKey = await hostCall(handle, 'storage.set', { key: '../escape', value: 1 })
    expect(badKey.ok).toBe(false)
    if (!badKey.ok) expect(badKey.error.code).toBe('E_PLUGIN_INVALID_ARGS')

    const declared = await hostCall(handle, 'emitEvent', { name: 'todo-added', payload: { id: 1 } })
    expect(declared.ok).toBe(true)
    expect(h.automationEvents).toEqual([
      { pluginId: PLUGIN_ID, event: 'todo-added', data: { id: 1 } },
    ])

    const undeclared = await hostCall(handle, 'emitEvent', { name: 'not-declared' })
    expect(undeclared.ok).toBe(false)
    if (!undeclared.ok) expect(undeclared.error.code).toBe('E_PLUGIN_INVALID_ARGS')
  })

  it('没有 tools 权限时 invokeTool 回报 E_PLUGIN_PERMISSION', async () => {
    const h = await createHarness({
      mode: 'dev',
      manifest: helloManifest({
        permissions: ['storage'],
        contributes: {
          tools: [],
          automation: { actions: [], events: [] },
        },
      }),
    })
    await expect(h.manager.invokeTool(PLUGIN_ID, 'echo', {})).rejects.toMatchObject({
      code: 'E_PLUGIN_PERMISSION',
    })
  })
})

describe('PluginManager · 超时 / 取消 / 崩溃', () => {
  it('工具超时（清单 timeoutMs）拒绝为 E_PLUGIN_TIMEOUT', async () => {
    const h = await createHarness({ mode: 'dev' })
    // 先用真实计时器把进程拉起来，再切假计时器，只让工具请求超时走假时钟
    await h.manager.invokeTool(PLUGIN_ID, 'echo', { text: 'warmup' })
    h.behavior.silent.add('tool.invoke')
    vi.useFakeTimers()

    const promise = h.manager.invokeTool(PLUGIN_ID, 'echo', { text: 'x' })
    promise.catch(() => undefined)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(promise).rejects.toMatchObject({ code: 'E_PLUGIN_TIMEOUT' })
  })

  it('AbortSignal 取消：拒绝为 E_PLUGIN_CANCELLED，并向插件发 cancel 帧', async () => {
    const h = await createHarness({ mode: 'dev' })
    // 先正常拉起进程；再把 tool.invoke 设为静默，让请求停在途中等取消
    await h.manager.invokeTool(PLUGIN_ID, 'echo', { text: 'warmup' })
    h.behavior.silent.add('tool.invoke')

    const controller = new AbortController()
    const pending = h.manager.invokeTool(PLUGIN_ID, 'echo', { text: 'x' }, controller.signal)
    pending.catch(() => undefined)
    await waitFor(
      () =>
        h.created[0]!.sent.filter(
          (message) => message.kind === 'req' && message.method === 'tool.invoke',
        ).length === 2,
    )
    const requests = h.created[0]!.sent.filter(
      (message): message is RequestMessage =>
        message.kind === 'req' && message.method === 'tool.invoke',
    )
    const request = requests[requests.length - 1]!
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'E_PLUGIN_CANCELLED' })
    expect(h.created[0]!.sent).toContainEqual({
      v: PLUGIN_RPC_VERSION,
      kind: 'cancel',
      id: request.id,
    })
  })

  it('10 分钟内反复崩溃：按 1s / 5s / 15s 重启，第 4 次自动停用并持久化 enabled=false', async () => {
    const h = await createHarness({ mode: 'installed' })
    await h.manager.start()
    await waitFor(() => h.manager.get(PLUGIN_ID)?.status === 'ready')
    vi.useFakeTimers()

    for (const [index, delay] of [1000, 5000, 15000].entries()) {
      const handle = h.created[h.created.length - 1]!
      handle.crash(1)
      expect(h.manager.get(PLUGIN_ID)?.status).toBe('crashed')
      await vi.advanceTimersByTimeAsync(delay)
      expect(h.manager.get(PLUGIN_ID)?.status).toBe('ready')
      expect(h.created).toHaveLength(index + 2)
    }

    h.created[h.created.length - 1]!.crash(1)
    await vi.advanceTimersByTimeAsync(0)
    const summary = h.manager.get(PLUGIN_ID)
    // 自动停用后 record.enabled=false，summary 按「停用」呈现，理由留在 lastError
    expect(summary?.status).toBe('disabled')
    expect(summary?.lastError).toContain('已自动停用')
    expect(summary?.enabled).toBe(false)

    // 落盘是异步的（handleExit 不能 await）：切回真实计时器轮询 registry 文件
    vi.useRealTimers()
    let persisted: { plugins: Record<string, { enabled: boolean }> } | undefined
    for (let i = 0; i < 100; i += 1) {
      persisted = JSON.parse(
        await readFile(join(h.userData, 'plugins', 'registry.json'), 'utf8'),
      ) as { plugins: Record<string, { enabled: boolean }> }
      if (persisted.plugins[PLUGIN_ID]?.enabled === false) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(persisted?.plugins[PLUGIN_ID]?.enabled).toBe(false)
  })

  it('总开关关闭：进程被杀、状态 disabled；重新打开后 startup 插件自动恢复', async () => {
    const h = await createHarness({ mode: 'dev' })
    await h.manager.start()
    await waitFor(() => h.manager.get(PLUGIN_ID)?.status === 'ready')
    const first = h.created[0]!

    h.settings.plugins.enabled = false
    await h.manager.onSettingsChanged()
    expect(first.killed).toBe(true)
    expect(h.manager.get(PLUGIN_ID)?.status).toBe('disabled')
    expect(h.manager.toolContributions()).toEqual([])

    h.settings.plugins.enabled = true
    await h.manager.onSettingsChanged()
    await waitFor(() => h.manager.get(PLUGIN_ID)?.status === 'ready')
    expect(h.created).toHaveLength(2)
    expect(h.manager.toolContributions()).toHaveLength(1)
  })
})

describe('PluginManager · 小组件与事件推送', () => {
  function widgetManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return helloManifest({
      permissions: ['ui.panels', 'ui.widgets'],
      contributes: {
        panels: [{ id: 'board', title: '面板', schema: 'ui/panel.json' }],
        widgets: [
          {
            id: 'duty-week',
            title: '本周值日',
            slot: 'desktop',
            schema: 'ui/widget.json',
            defaultSize: { width: 300, height: 200 },
          },
          { id: 'todo-strip', title: '事务', slot: 'edge-bar', schema: 'ui/strip.json' },
        ],
      },
      ...overrides,
    })
  }

  async function readyHarness(): Promise<Harness & { handle: FakePluginProcess }> {
    const h = await createHarness({ mode: 'dev', manifest: widgetManifest() })
    await h.manager.start()
    await waitFor(() => h.manager.get(PLUGIN_ID)?.status === 'ready')
    return { ...h, handle: h.created[0]! }
  }

  it('widgetContributions 按权限过滤，摘要带 slot / kind；invokeWidget 转发 widget.invoke', async () => {
    const h = await readyHarness()
    expect(
      h.manager.widgetContributions().map((widget) => [widget.id, widget.slot, widget.kind]),
    ).toEqual([
      ['duty-week', 'desktop', 'schema'],
      ['todo-strip', 'edge-bar', 'schema'],
    ])
    expect(h.manager.get(PLUGIN_ID)?.widgets).toHaveLength(2)
    expect(h.manager.widgetContributions()[0]).toMatchObject({ hideCloseButton: false })
    expect(h.manager.get(PLUGIN_ID)?.widgets[0]).toMatchObject({ hideCloseButton: false })

    h.behavior.widgetResult = (widgetId, method) => ({
      schema: { version: 1, nodes: [{ type: 'text', text: `${widgetId}:${method}` }] },
      toast: '已更新',
    })
    const result = await h.manager.invokeWidget(PLUGIN_ID, 'duty-week', 'bump', {})
    expect(result).toMatchObject({ toast: '已更新' })
    expect(result.schema).toMatchObject({ nodes: [{ text: 'duty-week:bump' }] })

    await expect(h.manager.invokeWidget(PLUGIN_ID, 'missing', 'refresh', {})).rejects.toMatchObject(
      {
        code: 'E_PLUGIN_INVALID_ARGS',
      },
    )
  })

  it('总开关关闭后小组件贡献消失、invokeWidget 被拒', async () => {
    const h = await readyHarness()
    h.settings.plugins.enabled = false
    await h.manager.onSettingsChanged()
    expect(h.manager.widgetContributions()).toEqual([])
    await expect(
      h.manager.invokeWidget(PLUGIN_ID, 'duty-week', 'refresh', {}),
    ).rejects.toMatchObject({ code: 'E_PLUGIN_DISABLED' })
  })

  it('页面型小组件（entry）也走 invokeWidget，供 plugins:pageRpc 调用', async () => {
    const h = await createHarness({
      mode: 'dev',
      manifest: helloManifest({
        permissions: ['ui.widgets'],
        contributes: {
          widgets: [
            {
              id: 'page-card',
              title: '页面小组件',
              slot: 'desktop',
              entry: 'ui/widget-page.html',
              defaultSize: { width: 320, height: 300 },
            },
          ],
        },
      }),
    })
    await h.manager.start()
    await waitFor(() => h.manager.get(PLUGIN_ID)?.status === 'ready')
    expect(h.manager.widgetContributions()).toEqual([
      expect.objectContaining({ id: 'page-card', kind: 'page' }),
    ])

    h.behavior.widgetResult = (widgetId, method) => ({
      data: { widgetId, method },
      message: '已添加事务',
    })
    await expect(h.manager.invokeWidget(PLUGIN_ID, 'page-card', 'load', {})).resolves.toEqual({
      data: { widgetId: 'page-card', method: 'load' },
      message: '已添加事务',
    })

    h.behavior.widgetResult = () => ({ error: '这条事务已不存在，请刷新后重试' })
    await expect(
      h.manager.invokeWidget(PLUGIN_ID, 'page-card', 'toggle-task', {}),
    ).resolves.toEqual({ error: '这条事务已不存在，请刷新后重试' })
  })

  it('hideCloseButton 透传到 widgetContributions 与插件摘要', async () => {
    const h = await createHarness({
      mode: 'dev',
      manifest: helloManifest({
        permissions: ['ui.widgets'],
        contributes: {
          widgets: [
            {
              id: 'bare',
              title: '无关闭键',
              slot: 'desktop',
              schema: 'ui/widget.json',
              hideCloseButton: true,
            },
          ],
        },
      }),
    })
    await h.manager.start()
    await waitFor(() => h.manager.get(PLUGIN_ID)?.status === 'ready')

    expect(h.manager.widgetContributions()[0]).toMatchObject({
      id: 'bare',
      hideCloseButton: true,
    })
    expect(h.manager.get(PLUGIN_ID)?.widgets[0]).toMatchObject({
      id: 'bare',
      hideCloseButton: true,
    })
  })

  it('ui.panelEvent：只投给自己声明过的目标，载荷 / 二选一 / 事件名逐项校验', async () => {
    const h = await readyHarness()
    const ok = await hostCall(h.handle, 'ui.panelEvent', {
      panelId: 'board',
      event: 'count-changed',
      payload: { count: 1 },
    })
    expect(ok.ok).toBe(true)
    expect(h.panelEvents).toEqual([
      { pluginId: PLUGIN_ID, panelId: 'board', event: 'count-changed', payload: { count: 1 } },
    ])

    const widget = await hostCall(h.handle, 'ui.panelEvent', {
      widgetId: 'todo-strip',
      event: 'count-changed',
    })
    expect(widget.ok).toBe(true)
    expect(h.panelEvents[1]).toMatchObject({ pluginId: PLUGIN_ID, widgetId: 'todo-strip' })

    // 跨插件 / 未声明目标
    const forged = await hostCall(h.handle, 'ui.panelEvent', {
      panelId: 'other-plugin-panel',
      event: 'count-changed',
    })
    expect(forged).toMatchObject({ ok: false, error: { code: 'E_PLUGIN_INVALID_ARGS' } })

    // 二者都给 / 都不给
    const both = await hostCall(h.handle, 'ui.panelEvent', {
      panelId: 'board',
      widgetId: 'todo-strip',
      event: 'count-changed',
    })
    expect(both).toMatchObject({ ok: false, error: { code: 'E_PLUGIN_INVALID_ARGS' } })
    const neither = await hostCall(h.handle, 'ui.panelEvent', { event: 'count-changed' })
    expect(neither).toMatchObject({ ok: false, error: { code: 'E_PLUGIN_INVALID_ARGS' } })

    // 事件名 / 载荷上限
    const badName = await hostCall(h.handle, 'ui.panelEvent', {
      panelId: 'board',
      event: '../bad',
    })
    expect(badName).toMatchObject({ ok: false, error: { code: 'E_PLUGIN_INVALID_ARGS' } })
    const big = await hostCall(h.handle, 'ui.panelEvent', {
      panelId: 'board',
      event: 'count-changed',
      payload: { text: 'x'.repeat(70 * 1024) },
    })
    expect(big).toMatchObject({ ok: false, error: { code: 'E_PLUGIN_INVALID_ARGS' } })
    expect(h.panelEvents).toHaveLength(2)
  })

  it('ui.panelEvent：每秒超过 20 条时丢弃并回执 dropped，不抛错', async () => {
    const h = await readyHarness()
    for (let index = 0; index < 20; index += 1) {
      const response = await hostCall(h.handle, 'ui.panelEvent', {
        panelId: 'board',
        event: 'tick',
        payload: { index },
      })
      expect(response.ok).toBe(true)
    }
    const overflow = await hostCall(h.handle, 'ui.panelEvent', {
      panelId: 'board',
      event: 'tick',
      payload: { index: 20 },
    })
    expect(overflow).toMatchObject({ ok: true, result: { ok: true, dropped: true } })
    expect(h.panelEvents).toHaveLength(20)
  })
})

describe('PluginManager · 页面反馈透传', () => {
  it('invokePanel 把 message / error 原样交给页面', async () => {
    const h = await createHarness({
      mode: 'dev',
      manifest: helloManifest({
        permissions: ['ui.panels'],
        contributes: {
          panels: [{ id: 'board', title: '面板', schema: 'ui/panel.json' }],
        },
      }),
    })
    await h.manager.start()
    await waitFor(() => h.manager.get(PLUGIN_ID)?.status === 'ready')

    h.behavior.panelResult = (panelId, method) => ({
      data: { panelId, method },
      message: '已保存通知',
    })
    await expect(
      h.manager.invokePanel(PLUGIN_ID, 'board', 'save-announcement', {}),
    ).resolves.toEqual({
      data: { panelId: 'board', method: 'save-announcement' },
      message: '已保存通知',
    })

    h.behavior.panelResult = () => ({ error: '过去周只读，不能修改' })
    await expect(h.manager.invokePanel(PLUGIN_ID, 'board', 'delete-task', {})).resolves.toEqual({
      error: '过去周只读，不能修改',
    })
  })
})
