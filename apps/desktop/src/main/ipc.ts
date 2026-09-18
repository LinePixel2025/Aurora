/**
 * IPC 注册层（docs/02 §6）：通道契约见 `@aurora/shared` 的 `IPC` / `AuroraApi`。
 *
 * 原则：
 * - 渲染层永不接触 Electron / 文件系统，只调用白名单方法；
 * - 返回值统一 `Result<T>`，异常不越过 IPC 边界；
 * - 密文字段不回传渲染层（只回传"是否已设置"）。
 */
import { join } from 'node:path'
import { BrowserWindow, app, ipcMain, shell } from 'electron'
import {
  IPC,
  createDefaultSettings,
  err,
  ok,
  type AppInfo,
  type AuroraApi,
  type GuideAnswerResult,
  type GuideSession,
  type Logger,
  type ModeId,
  type ModeSummary,
  type OpenPathRequest,
  type Result,
  type SecretEntries,
  type SetSecretsOutcome,
  type Settings,
  type SettingsPatch,
  type WindowName,
  type WindowState,
} from '@aurora/shared'
import type {
  AgentHost,
  GuideRunnerLike,
  LlmTesterLike,
  ModeManagerLike,
  PerceptionLike,
  SettingsStoreLike,
  SkillsInfoLike,
  WindowManagerLike,
} from './contracts.js'

export interface DesktopDeps {
  settings: SettingsStoreLike
  windows: WindowManagerLike
  modes: ModeManagerLike
  guides: GuideRunnerLike
  agent: AgentHost
  perception: PerceptionLike
  llm: LlmTesterLike
  skills: SkillsInfoLike
  logger: Logger
  paths: { userData: string; logs: string; config: string; builtinSkills: string }
  isDev: boolean
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
  handle(IPC.skills.list, () => ok(deps.skills.list()))

  // ───────────────────────── 推送 ─────────────────────────

  const offSettings = deps.settings.onChange?.((settings) => {
    broadcast(IPC.settings.changed, settings)
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

  return () => {
    for (const [channel] of handlers) ipcMain.removeHandler(channel)
    offSettings?.()
    offModes()
    offWindows()
    offAgent()
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

  const updated = deps.settings.update(patch as Partial<Settings>)
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
  const settings = deps.settings.get()
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
export function resolveSubjectFolder(watchDir: string, folder: string): string {
  const trimmed = folder.trim()
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('\\\\')) {
    return trimmed
  }
  if (watchDir.trim() === '') return trimmed
  return join(watchDir, trimmed)
}

export type { AuroraApi }
