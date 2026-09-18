/**
 * IPC 注册层（docs/02 §6）：通道契约见 `@aurora/shared` 的 `IPC` / `AuroraApi`。
 *
 * 原则：
 * - 渲染层永不接触 Electron / 文件系统，只调用白名单方法；
 * - 返回值统一 `Result<T>`，异常不越过 IPC 边界；
 * - 密文字段不回传渲染层（只回传"是否已设置"）。
 */
import { join } from 'node:path'
import { promises as writeFs } from 'node:fs'
import { BrowserWindow, app, ipcMain, shell } from 'electron'
import { type SessionStore } from '@aurora/agent-core'
import {
  IPC,
  createDefaultSettings,
  err,
  ok,
  type AppInfo,
  type AuroraApi,
  type ChatHistoryRequest,
  type ChatMessageDto,
  type ClassificationCorrection,
  type ClassificationEvent,
  type ClassificationRecord,
  type GuideAnswerResult,
  type GuideSession,
  type Logger,
  type McpServerStatus,
  type ModeId,
  type ModeSummary,
  type OpenPathRequest,
  type Result,
  type SecretEntries,
  type SetSecretsOutcome,
  type Settings,
  type SettingsPatch,
  type SmokeDiagnostics,
  type UpdateState,
  type WindowName,
  type WindowState,
} from '@aurora/shared'
import type {
  AgentHost,
  ClassificationControllerLike,
  GuideRunnerLike,
  LlmTesterLike,
  ModeManagerLike,
  PerceptionLike,
  ProactiveLike,
  SettingsStoreLike,
  SkillsInfoLike,
  UpdateControllerLike,
  WindowManagerLike,
} from './contracts.js'
import { resolveSubjectFolder } from './paths.js'

export interface DesktopDeps {
  settings: SettingsStoreLike
  windows: WindowManagerLike
  modes: ModeManagerLike
  guides: GuideRunnerLike
  agent: AgentHost
  perception: PerceptionLike
  llm: LlmTesterLike
  skills: SkillsInfoLike
  /** 会话历史（chat:history 水合，docs/06 §4） */
  sessions: SessionStore
  /** 分类管线（classification:*，docs/05 §3） */
  classification: ClassificationControllerLike
  /** 敏感工具确认（proactive:*，docs/06 §5） */
  proactive: ProactiveLike
  /** MCP 状态（mcp:status，docs/06 §7） */
  mcpStatus: () => McpServerStatus[]
  onMcpStatusChanged: (listener: (statuses: McpServerStatus[]) => void) => () => void
  /** 自动更新（update:*，docs/09） */
  updater: UpdateControllerLike
  logger: Logger
  paths: { userData: string; logs: string; config: string; builtinSkills: string }
  isDev: boolean
  /** 仅自测（`AURORA_SMOKE=1`）为 true；控制诊断通道是否可用 */
  smokeMode?: boolean
  /** 自测诊断回执（仅 smokeMode 下被调用） */
  smokeDiagnostics?: () => SmokeDiagnostics
  onQuit: () => void
  onSettingsChanged?: (settings: Settings) => void
}

export function registerIpc(deps: DesktopDeps): () => void {
  const handlers: Array<[string, (...args: never[]) => unknown]> = []

  const handle = <T>(
    channel: string,
    fn: (...args: never[]) => Promise<Result<T>> | Result<T>,
  ): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      try {
        return await fn(...(args as never[]))
      } catch (error) {
        deps.logger.error('IPC 处理失败', { channel, error: String(error) })
        return err('E_UNKNOWN', error instanceof Error ? error.message : String(error))
      }
    })
    handlers.push([channel, fn as (...args: never[]) => unknown])
  }

  // ───────────────────────── app ─────────────────────────

  const buildAppInfo = (): AppInfo => ({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? 'unknown',
    platform: process.platform,
    arch: process.arch,
    isDev: deps.isDev,
    configPath: deps.paths.config,
    logDir: deps.paths.logs,
    userDataDir: deps.paths.userData,
    needsOnboarding: deps.settings.needsOnboarding(),
    cryptoAvailable: deps.settings.isCryptoAvailable(),
    defaultHotkey: deps.settings.get().general.hotkey,
  })

  handle<AppInfo>(IPC.app.getInfo, () => ok(buildAppInfo()))
  handle<void>(IPC.app.quit, () => {
    deps.onQuit()
    return ok(undefined)
  })
  handle<string>(IPC.app.openPath, (request: OpenPathRequest) => openPath(deps, request))
  handle<SmokeDiagnostics>(IPC.app.smokeDiagnostics, () =>
    // 生产环境（含打包态）不暴露任何诊断信息
    deps.isDev && deps.smokeMode === true
      ? ok(deps.smokeDiagnostics?.() ?? { enabled: true })
      : ok({ enabled: false }),
  )
  handle<string>(IPC.app.smokeDropFile, async (request: { fileName: string; content: string }) => {
    if (!deps.isDev || deps.smokeMode !== true) {
      return err('E_INVALID_STATE', '该接口仅在开发自测下可用')
    }
    const watchDir = deps.settings.get().modes.classroom.watchDir
    if (watchDir.trim() === '') return err('E_INVALID_STATE', '尚未配置智慧感知文件夹')
    // 只允许简单文件名，防路径穿越（自测专用接口也要守边界）
    if (request.fileName.includes('/') || request.fileName.includes('\\')) {
      return err('E_INVALID_ARGUMENT', '文件名不能包含路径分隔符')
    }
    const target = join(watchDir, request.fileName)
    try {
      await writeFs.writeFile(target, request.content, 'utf8')
      return ok(target)
    } catch (error) {
      return err('E_IO', error instanceof Error ? error.message : String(error))
    }
  })

  // ───────────────────────── settings ─────────────────────────

  handle<Settings>(IPC.settings.get, () => ok(toRendererSettings(deps)))
  handle<Settings>(IPC.settings.update, (patch: SettingsPatch) => {
    const result = applyPatch(deps, patch)
    if (!result.ok) return result
    return ok(toRendererSettings(deps))
  })
  handle<Settings>(IPC.settings.reset, () => {
    const defaults = createDefaultSettings()
    const updated = deps.settings.mutate((draft) => {
      Object.assign(draft, defaults)
    })
    if (!updated) return err('E_INVALID_STATE', '重置配置失败：校验未通过')
    deps.logger.warn('配置已重置为默认值')
    deps.onSettingsChanged?.(updated)
    return ok(toRendererSettings(deps))
  })
  handle<SetSecretsOutcome>(IPC.settings.setSecret, (entries: SecretEntries) => {
    const persisted: string[] = []
    const memoryOnly: string[] = []
    for (const [path, value] of Object.entries(entries)) {
      try {
        const written = deps.settings.setSecret(path, value)
        if (written) persisted.push(path)
        else memoryOnly.push(path)
      } catch (error) {
        return err('E_INVALID_ARGUMENT', error instanceof Error ? error.message : String(error))
      }
    }
    if (memoryOnly.length > 0) {
      deps.logger.warn('部分凭据无法加密落盘，仅保留在内存中', { paths: memoryOnly })
    }
    deps.onSettingsChanged?.(deps.settings.get())
    return ok({ persisted: memoryOnly.length === 0, paths: [...persisted, ...memoryOnly] })
  })
  handle<boolean>(IPC.settings.hasSecret, (path: string) =>
    ok(deps.settings.getSecret(path) !== ''),
  )
  handle<boolean>(IPC.settings.clearSecret, (path: string) => {
    deps.settings.clearSecret(path)
    return ok(true)
  })
  handle<Settings>(IPC.settings.exportRedacted, () => ok(deps.settings.exportRedacted()))

  // ───────────────────────── llm ─────────────────────────

  handle(IPC.llm.testConnection, (request: Parameters<LlmTesterLike['test']>[0]) => {
    return deps.llm
      .test(request)
      .then(ok, (error: unknown) =>
        err('E_NETWORK', error instanceof Error ? error.message : String(error)),
      )
  })
  handle(IPC.llm.listModels, (request: Parameters<LlmTesterLike['listModels']>[0]) => {
    return deps.llm
      .listModels(request)
      .then(ok, (error: unknown) =>
        err('E_NETWORK', error instanceof Error ? error.message : String(error)),
      )
  })

  // ───────────────────────── mode / guide ─────────────────────────

  handle<ModeSummary[]>(IPC.mode.list, () => ok(deps.modes.list()))
  handle<ModeSummary[]>(IPC.mode.set, async (id: ModeId) => {
    const result = await deps.modes.setCurrent(id)
    if (!result.ok) return err('E_INVALID_STATE', result.message)
    if (result.guideRequired) deps.modes.requestGuideIfNeeded(id, 'user-switch')
    return ok(result.modes)
  })
  handle<ModeSummary[]>(IPC.mode.completeGuide, (id: ModeId) => ok(deps.modes.completeGuide(id)))
  handle<ModeSummary[]>(IPC.mode.resetGuide, (id: ModeId) => ok(deps.modes.resetGuide(id)))
  handle<GuideSession>(IPC.mode.guideStart, (id: ModeId) => ok(deps.guides.start(id)))
  handle<GuideSession>(IPC.mode.guideReset, (id: ModeId) => ok(deps.guides.reset(id)))
  handle<GuideAnswerResult>(IPC.mode.guideAnswer, (id: ModeId, answer: string) =>
    ok(deps.guides.answer(id, answer)),
  )

  // ───────────────────────── window ─────────────────────────

  const withState = <T>(fn: () => T): Result<WindowState> => {
    fn()
    return ok(deps.windows.getState())
  }
  handle<WindowState>(IPC.window.getState, () => ok(deps.windows.getState()))
  handle<WindowState>(IPC.window.show, (name: WindowName) =>
    withState(() => deps.windows.show(name)),
  )
  handle<WindowState>(IPC.window.hide, (name: WindowName) =>
    withState(() => deps.windows.hide(name)),
  )
  handle<WindowState>(IPC.window.toggle, (name: WindowName) =>
    withState(() => deps.windows.toggle(name)),
  )
  handle<WindowState>(IPC.window.showChat, () => withState(() => deps.windows.showChat()))
  handle<WindowState>(IPC.window.showMiniChat, () => withState(() => deps.windows.showMiniChat()))
  handle<WindowState>(
    IPC.window.setPosition,
    (name: WindowName, position: { x: number; y: number }) =>
      withState(() => deps.windows.setPosition(name, position)),
  )
  handle<WindowState>(IPC.window.setDockExpanded, (expanded: boolean) =>
    withState(() => deps.windows.setDockExpanded(expanded)),
  )

  // ───────────────────────── perception / chat ─────────────────────────

  handle(IPC.perception.summary, () =>
    deps.perception
      .summary()
      .then(ok, (error: unknown) =>
        err('E_UNKNOWN', error instanceof Error ? error.message : String(error)),
      ),
  )
  handle(IPC.chat.send, (request: Parameters<AgentHost['send']>[0]) =>
    deps.agent
      .send(request)
      .then(ok, (error: unknown) =>
        err('E_UNKNOWN', error instanceof Error ? error.message : String(error)),
      ),
  )
  handle<boolean>(IPC.chat.abort, (requestId: string) => ok(deps.agent.abort(requestId)))
  handle<ChatMessageDto[]>(IPC.chat.history, (request: ChatHistoryRequest) => {
    const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : ''
    const limit = typeof request?.limit === 'number' ? request.limit : 100
    return deps.sessions
      .rendererHistory(sessionId, limit)
      .then((messages) => ok(messages as ChatMessageDto[]))
      .catch((error: unknown) =>
        err('E_UNKNOWN', error instanceof Error ? error.message : String(error)),
      )
  })
  handle(IPC.skills.list, () => ok(deps.skills.list()))
  handle<McpServerStatus[]>(IPC.mcp.status, () => ok(deps.mcpStatus()))

  // ───────────────────────── 分类管线（docs/05 §3） ─────────────────────────

  handle<ClassificationRecord[]>(IPC.classification.history, (limit?: number) => {
    const records = deps.classification.list()
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return ok(records)
    return ok(records.slice(0, Math.floor(limit)))
  })
  handle<ClassificationEvent[]>(IPC.classification.state, () =>
    ok(deps.classification.recentEvents()),
  )
  handle<ClassificationRecord[]>(
    IPC.classification.correct,
    async (input: ClassificationCorrection) => {
      try {
        return ok(await deps.classification.correct(input.recordId, input.subject))
      } catch (error) {
        return err('E_INVALID_ARGUMENT', error instanceof Error ? error.message : String(error))
      }
    },
  )
  handle<boolean>(IPC.classification.clear, () => {
    deps.classification.clear()
    return ok(true)
  })

  // ───────────────────────── 敏感工具确认（docs/06 §5） ─────────────────────────

  handle<boolean>(IPC.proactive.resolveSensitiveTool, (confirmId: string, approved: boolean) =>
    ok(deps.proactive.resolve(confirmId, approved)),
  )

  // ───────────────────────── 更新（docs/09） ─────────────────────────

  handle<UpdateState>(IPC.update.getState, () => ok(deps.updater.getState()))
  handle<UpdateState>(IPC.update.check, () =>
    deps.updater
      .check()
      .then(ok, (error: unknown) =>
        err('E_UNKNOWN', error instanceof Error ? error.message : String(error)),
      ),
  )
  handle<UpdateState>(IPC.update.download, () =>
    deps.updater
      .download()
      .then(ok, (error: unknown) =>
        err('E_UNKNOWN', error instanceof Error ? error.message : String(error)),
      ),
  )
  handle<boolean>(IPC.update.install, () => ok(deps.updater.install()))

  // ───────────────────────── 推送 ─────────────────────────

  const offSettings = deps.settings.onChange?.((settings) => {
    // 推送同样必须走脱敏：否则 ciphertext 会随广播绕过 toRendererSettings 进入渲染层
    broadcast(IPC.settings.changed, redactSettingsForRenderer(deps, settings))
  })
  const offModes = deps.modes.onChange((event) => {
    broadcast(IPC.mode.changed, event)
  })
  const offWindows = deps.windows.onStateChanged((state) => {
    broadcast(IPC.window.stateChanged, state)
  })
  const offAgent = deps.agent.onEvent((event) => {
    broadcast(IPC.chat.event, event)
  })
  const offClassification = deps.classification.onEvent((event) => {
    broadcast(IPC.classification.event, event)
  })
  const offSensitive = deps.proactive.onRequest((request) => {
    broadcast(IPC.proactive.sensitiveTool, request)
  })
  const offMcp = deps.onMcpStatusChanged((statuses) => {
    broadcast(IPC.mcp.statusChanged, statuses)
  })
  const offUpdate = deps.updater.onStateChanged((state) => {
    broadcast(IPC.update.stateChanged, state)
  })

  return () => {
    for (const [channel] of handlers) ipcMain.removeHandler(channel)
    offSettings?.()
    offModes()
    offWindows()
    offAgent()
    offClassification()
    offSensitive()
    offMcp()
    offUpdate()
  }
}

/** 广播到所有可见窗口（渲染层按需过滤）。 */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(channel, payload)
  }
}

// ───────────────────────── 辅助 ─────────────────────────

function applyPatch(deps: DesktopDeps, patch: SettingsPatch): Result<Settings> {
  const secrets: SecretEntries = {}

  if (patch.llm?.providers) {
    for (const [id, provider] of Object.entries(patch.llm.providers)) {
      const draft = provider as Record<string, unknown>
      const apiKey = draft['apiKey']
      if (typeof apiKey === 'string') {
        delete draft['apiKey']
        if (apiKey !== '') secrets[`llm.providers.${id}.apiKey`] = apiKey
      }
    }
  }
  if (patch.mcp?.servers) {
    for (const server of patch.mcp.servers) {
      const draft = server as unknown as Record<string, unknown>
      const env = draft['env']
      if (env && typeof env === 'object') {
        const entries = env as Record<string, string>
        for (const [name, value] of Object.entries(entries)) {
          if (value !== '') secrets[`mcp.servers.${server.name}.env.${name}`] = value
        }
        delete draft['env']
      }
    }
  }

  // `SettingsPatch` 的分组是**局部**更新（如只传 `mcp.servers` 或只改 provider 的 model），
  // 而 SettingsStore.update 是顶层浅合并；这里逐层把未提及的子字段补回当前值：
  // - 分组级：未提及的顶层子字段（如 `mcp.lazyConnect`）；
  // - provider 级：渲染层永远看不到 `apiKeyEnc`（docs/08 §1.1），必须保留已有密文，
  //   否则设置页改一次模型名就会把凭据清空（Schema 也会因缺字段而校验失败）；
  // - MCP server 级：同理由 `envEnc` 保存凭据。
  //
  // 关键：合并必须在 `mutate` 的 mutator **内部**读取当前值。
  // `SettingsStore.mutate` 会把 mutator 收到的 draft 用 `update()` 再浅合并一次，
  // 若在 mutator 之外提前取快照，写入凭据（`setSecret` → `mutate`）时
  // 会被旧快照覆盖回 `apiKeyEnc: ''` —— 即"先存模型配置、再存 API Key"的
  // 设置页流程会静默丢掉凭据。
  const updated = deps.settings.mutate((draft) => {
    const providers = { ...draft.llm.providers }
    for (const [id, provider] of Object.entries(patch.llm?.providers ?? {})) {
      providers[id] = {
        ...(providers[id] ?? {}),
        ...provider,
      } as Settings['llm']['providers'][string]
    }

    const servers = (patch.mcp?.servers ?? draft.mcp.servers).map((server) => {
      const existing = draft.mcp.servers.find((item) => item.name === server.name)
      return existing === undefined ? server : { ...existing, ...server }
    })

    if (patch.general !== undefined) Object.assign(draft.general, patch.general)
    if (patch.llm !== undefined) Object.assign(draft.llm, patch.llm)
    draft.llm.providers = providers
    if (patch.advanced !== undefined) Object.assign(draft.advanced, patch.advanced)
    if (patch.skills !== undefined) Object.assign(draft.skills, patch.skills)
    if (patch.mcp !== undefined) Object.assign(draft.mcp, patch.mcp)
    draft.mcp.servers = servers
    if (patch.modes !== undefined) Object.assign(draft.modes, patch.modes)
  })
  if (!updated) return err('E_INVALID_ARGUMENT', '配置校验失败：请检查填写内容')

  for (const [path, value] of Object.entries(secrets)) {
    try {
      deps.settings.setSecret(path, value)
    } catch (error) {
      return err('E_INVALID_ARGUMENT', error instanceof Error ? error.message : String(error))
    }
  }

  if (patch.skills?.disabled) deps.skills.setDisabled(patch.skills.disabled)
  deps.onSettingsChanged?.(updated)
  return ok(updated)
}

/** 回传渲染层前把密文替换为"是否已设置"。 */
function toRendererSettings(deps: DesktopDeps): Settings {
  return redactSettingsForRenderer(deps, deps.settings.get())
}

/**
 * 密文 → "是否已设置"标记。
 * `settings:get` 与 `settings:changed` 广播共用，保证任何路径都不把
 * `apiKeyEnc` / `envEnc` 的值送进渲染进程（docs/08 §1.1）。
 */
function redactSettingsForRenderer(deps: DesktopDeps, source: Settings): Settings {
  const settings = structuredClone(source)
  for (const [id, provider] of Object.entries(settings.llm.providers)) {
    const draft = provider as unknown as Record<string, unknown>
    draft['apiKeySet'] = deps.settings.getSecret(`llm.providers.${id}.apiKey`) !== ''
    draft['apiKeyEnc'] = ''
  }
  for (const server of settings.mcp.servers) {
    const draft = server as unknown as Record<string, unknown>
    const env = (server as unknown as { envEnc?: Record<string, string> }).envEnc ?? {}
    draft['envSet'] = Object.keys(env)
    draft['envEnc'] = {}
  }
  return settings
}

async function openPath(deps: DesktopDeps, request: OpenPathRequest): Promise<Result<string>> {
  const settings = deps.settings.get()
  let target = ''
  switch (request.kind) {
    case 'logs':
      target = deps.paths.logs
      break
    case 'config':
      target = deps.paths.config
      break
    case 'watchDir':
      target = settings.modes.classroom.watchDir
      break
    case 'subject': {
      const subject = settings.modes.classroom.subjects.find(
        (item) => item.name === request.subject,
      )
      if (!subject) return err('E_NOT_FOUND', `未找到科目：${request.subject ?? ''}`)
      target = resolveSubjectFolder(settings.modes.classroom.watchDir, subject.folder)
      break
    }
    default:
      return err('E_INVALID_ARGUMENT', `不支持的目标：${String(request.kind)}`)
  }

  if (target.trim() === '') return err('E_INVALID_STATE', '该路径尚未配置')
  try {
    const error = await shell.openPath(target)
    if (error !== '') return err('E_IO', `打开失败：${error}`)
    return ok(target)
  } catch (error) {
    return err('E_IO', error instanceof Error ? error.message : String(error))
  }
}

/** 相对路径按感知文件夹解析（docs/05 §2 ③ 的默认规则） */
export { resolveSubjectFolder } from './paths.js'

export type { AuroraApi }
