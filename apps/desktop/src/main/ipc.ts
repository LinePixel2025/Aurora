/**
 * IPC 注册层（docs/02 §6）：通道契约见 `@aurora/shared` 的 `IPC` / `AuroraApi`。
 *
 * 原则：
 * - 渲染层永不接触 Electron / 文件系统，只调用白名单方法；
 * - 返回值统一 `Result<T>`，异常不越过 IPC 边界；
 * - 密文字段不回传渲染层（只回传"是否已设置"）。
 */
import { dirname, join } from 'node:path'
import { promises as nodeFs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { BrowserWindow, app, dialog, ipcMain, nativeImage, shell } from 'electron'
import {
  resolveProjectRootById,
  type JobStore,
  type SessionStore,
  type SnapshotPort,
} from '@aurora/agent-core'
import { resolveWorkspaceOpenTarget } from './tools/workspace-target.js'
import { executeFileAwarenessSuggestion } from './file-awareness-execute.js'
import { buildFileList } from './file-list.js'
import { buildAttachmentPreview, type ImageReadPort } from './attachments.js'
// 附件链路与 Center 远程会话共用一份实现（docs/07 §2.3）：从 ipc.ts 抽出，行为不变。
import { prepareAttachments, type AttachmentDigest } from './attachment-prepare.js'
import { PastedImageError, writePastedImage } from './pasted-image.js'
import type { PluginManager } from './plugins/manager.js'
import type { WidgetManager } from './plugins/widgets.js'
import type { PluginMarketplaceClient } from './plugins/marketplace.js'
import { pluginPageGuestOf } from './page-protocol.js'
import { isPathOutsideError, type WorkspaceGuardOptions } from './tools/file-port.js'
import {
  assertRestorablePath,
  isRestorePathRejectedError,
  writeRestoredFile,
} from './tools/restore-guard.js'
import {
  IPC,
  PLUGIN_WIDGET_WINDOW_LEVELS,
  createDefaultSettings,
  err,
  ok,
  type AppInfo,
  type AskUserAnswerInput,
  type AuroraApi,
  type BrowserAgentReportRequest,
  type BrowserAgentStopRequest,
  type ChatArchiveRequest,
  type ChatAttachmentPreview,
  type ChatAttachmentPreviewRequest,
  type ChatDisplayImageReadRequest,
  type ChatDisplayImageReadResult,
  type ChatHistoryRequest,
  type ChatMessageDto,
  type FileListRequest,
  type FileListResult,
  type FilePreviewRequest,
  type FilePreviewResult,
  type FileAwarenessAnalyzeRequest,
  type FileAwarenessExecution,
  type FileAwarenessListRequest,
  type FileAwarenessNote,
  type FileAwarenessNoteContent,
  type FileAwarenessNoteExpiry,
  type FileAwarenessNoteRequest,
  type FileAwarenessSetNoteExpiryRequest,
  type FileAwarenessSuggestionAction,
  type TerminalCreateRequest,
  type TerminalInputRequest,
  type TerminalResizeRequest,
  type ChatSessionModelRequest,
  type ChatSessionProjectRequest,
  type ChatSessionSummary,
  type ChatStageImageRequest,
  type ChatStageImageResult,
  type CenterConnectionStatus,
  type CenterDeviceLoginRequest,
  type CenterDeviceLoginStarted,
  type CenterOfficialModelCatalog,
  type CenterRuntimeNotice,
  type CenterLoginRequest,
  type CenterLoginResult,
  type ClassIslandNotifyRequest,
  type ClassIslandNotifyResult,
  type ClassIslandStatus,
  type ClassIslandTestResult,
  type ClassificationCorrection,
  type ClassificationEvent,
  type ClassificationRecord,
  type GuideAnswerResult,
  type GuideSession,
  type HotkeyStatus,
  type ImageGenReadRequest,
  type Logger,
  type McpServerStatus,
  type ModeId,
  type ModeSummary,
  type OpenPathRequest,
  // 插件系统（docs/14）
  type PluginCommandInfo,
  type PluginConfigValues,
  type PluginInstallPreview,
  type PluginMarketplaceInstallRequest,
  type PluginMarketplaceListResult,
  type PluginPackageRef,
  type PluginPageRpcRequest,
  type PluginPanelDataRequest,
  type PluginPanelDataResult,
  type PluginPanelSchema,
  type PluginRunCommandRequest,
  type PluginRunCommandResult,
  type PluginSetWidgetVisibleRequest,
  type PluginSetWidgetWindowLevelRequest,
  type PluginSummary,
  type PluginUninstallRequest,
  type PluginUpdateInfo,
  type PluginWidgetDataRequest,
  type PluginWidgetDataResult,
  type PluginWidgetLayout,
  type ProjectStatus,
  type ProjectRuntimeStatus,
  type SnapshotListRequest,
  type AgentJob,
  type AgentJobStatus,
  type SnapshotRef,
  type SnapshotRestoreRequest,
  type Result,
  type SecretEntries,
  type SendMessageRequest,
  type SetSecretsOutcome,
  type Settings,
  type SettingsPatch,
  type SkillSummary,
  type SkillsStatus,
  type SmokeDiagnostics,
  type UpdateState,
  type WindowName,
  type WindowState,
  type AutomationCatalog,
  type AutomationDefinition,
  type AutomationHistoryQuery,
  type AutomationListResult,
  type AutomationRun,
  type AutomationWindowRequest,
} from '@aurora/shared'
import type {
  AgentHost,
  AutomationControllerLike,
  ClassIslandControllerLike,
  ClassificationControllerLike,
  GuideRunnerLike,
  HotkeyControllerLike,
  ImageGenServiceLike,
  LlmTesterLike,
  SttServiceLike,
  TtsSynthesizerLike,
  ModeManagerLike,
  PerceptionLike,
  ProactiveLike,
  AskUserLike,
  SettingsStoreLike,
  SkillsInfoLike,
  UpdateControllerLike,
  WindowManagerLike,
  CenterConnectionLike,
  FileAwarenessControllerLike,
} from './contracts.js'
import { resolveSubjectFolder } from './paths.js'
import { buildInitCommandContext, isInitCommand } from './agent-commands.js'
import { buildFilePreview } from './file-preview.js'
import type { TerminalService } from './terminal-service.js'
import { extractPatchSecrets, mergeSettingsPatch } from './settings-patch.js'
import { redactSettings } from './settings-redact.js'
import { createEventBuffer } from './event-buffer.js'
import { isFileAwarenessSession } from './file-awareness-run-profile.js'

/** 快速会话 id（`useChat` 的 `sessionIdFor('quick')` 与 docs/06 §4 同一口径）。 */

/**
 * 附件缩略图的读盘端口（docs/07 §2.3）。
 *
 * 与 `index.ts` 里给内核的 `loadImages` 是两个端口但**同一套读法**（`stat` + `readFile`）：
 * 前者给渲染层预览（2 MiB 上限、只回 data URL），后者给模型（8 MiB 上限、读进内核缓存）。
 * 分开是因为上限与消费方都不同 —— 但都只读、都不写。
 */
const previewReadPort: ImageReadPort = {
  sizeOf: async (path) => {
    try {
      const stat = await nodeFs.stat(path)
      return stat.isFile() ? stat.size : undefined
    } catch {
      return undefined
    }
  },
  readFile: (path) => nodeFs.readFile(path),
}

/**
 * Agent 内置浏览器的 IPC 切片（v35，docs/06 §27）。
 *
 * 只收两条渲染层 → 主进程的回执：建标签结果（report）与用户停止（stop）；
 * 反向的状态推送由 `BrowserAgentManager` 经 `windows.sendTo('chat', …)` 做，
 * 不经过这里（推送不需要 IPC handler）。
 */
export interface BrowserAgentIpcLike {
  report(request: BrowserAgentReportRequest): void
  stop(sessionId: string, reason: string): boolean
}

export interface DesktopDeps {
  settings: SettingsStoreLike
  windows: WindowManagerLike
  modes: ModeManagerLike
  guides: GuideRunnerLike
  agent: AgentHost
  perception: PerceptionLike
  llm: LlmTesterLike
  /** 语音合成（tts:*，docs/06 §13） */
  tts: TtsSynthesizerLike
  /** 语音输入（stt:transcribe，Design/betav2-spec.md §8.2、docs/06 §15） */
  stt: SttServiceLike
  /** 图像生成（imagegen:*，Design/betav2-spec.md §8.3、docs/06 §15） */
  imagegen: ImageGenServiceLike
  skills: SkillsInfoLike
  /**
   * 插件系统（docs/14，`plugins:*`）。未装配时各通道如实回 `E_INVALID_STATE`
   * （不静默成功）——安装 / 启停 / 配置都要求用户能看到失败原因。
   */
  plugins?: PluginManager
  /** 桌面小组件窗口（docs/14 §5.3）；插件系统未装配时为空 */
  widgets?: WidgetManager
  /** 插件市场客户端（P4）；未装配时市场通道回 E_INVALID_STATE */
  pluginMarketplace?: PluginMarketplaceClient
  /** 会话历史（chat:history 水合，docs/06 §4） */
  sessions: SessionStore
  /**
   * 会话自动标题（docs/06 §4）。chat:send 接受首条 / pending 重试请求后异步调用；
   * 不注入时退化为旧的“首条消息前 24 字”标题。
   */
  sessionTitles?: {
    schedule(sessionId: string, firstUserText?: string, attachments?: readonly string[]): void
  }
  /** 对话图片读取（chat:readDisplayImage，docs/06 §14） */
  readDisplayImage: (request: ChatDisplayImageReadRequest) => Promise<ChatDisplayImageReadResult>
  /** 分类管线（classification:*，docs/05 §3） */
  classification: ClassificationControllerLike
  /** 敏感工具确认（proactive:*，docs/06 §5） */
  proactive: ProactiveLike
  /**
   * Agent 向用户提问（askUser:*，docs/06 §21）。未注入时回执通道返回 `false`
   * （与"已结算/未知 id"同款语义），推送通道自然不发 —— 工具侧另有"端口缺失"的兜底文案。
   */
  askUser?: AskUserLike
  /** 全局快捷键状态（hotkey:*，docs/07 §5） */
  hotkey: HotkeyControllerLike
  /**
   * 写前快照与一键回滚（snapshots:*，docs/06 §11.8，v14）。
   * 未注入时三条通道返回 `E_INVALID_STATE`（而不是静默成功）—— 界面据此如实报错。
   */
  snapshots?: SnapshotPort
  /**
   * 快照**回滚**路径的项目根边界 guard（docs/06 §11.8，P2-07）：与 file-port / run_command
   * 是**同一个** `sessionProjects.boundaryRoot`（装配层注入），边界按快照所属会话现解析。
   * 未注入 = 不做边界校验（与 `resolveWithin` 未配根时逐字一致）。
   */
  snapshotGuard?: WorkspaceGuardOptions
  /**
   * 会话边界根（`sessionProjects.boundaryRoot` 的回落链，docs/06 §5.1）：`/init` 内置命令
   * 生成 AGENTS.md 的目标目录。未注入时 `/init` 原样透传（模型只看到三个字符，按普通提问处理）。
   */
  workspaceRootOf?: (sessionId?: string) => string | undefined
  /** PTY 终端（terminal:*，docs/07 §2.3）。未装配时四条通道按 E_INVALID_STATE 如实报错 */
  terminal?: TerminalService
  /**
   * Agent 内置浏览器（browser:agentReport / browser:agentStop，v35，docs/06 §27）。
   * 未装配时两条回执通道按 E_INVALID_STATE 如实报错（不静默成功）。
   */
  browserAgent?: BrowserAgentIpcLike
  /** Job 存储（chat:jobs / resumeJob / cancelJob，docs/06 §4.1，v15） */
  jobs?: JobStore
  /** 删除会话时级联清理任务清单（docs/06 §18）。未注入时保留旧的单删会话行为。 */
  todoCleanup?: { removeSession(sessionId: string): Promise<void> }
  /** ClassIsland 桥接（classisland:*，docs/05 §3.4 v2/v3） */
  classisland: ClassIslandController
  /** MCP 状态（mcp:status，docs/06 §7） */
  mcpStatus: () => McpServerStatus[]
  onMcpStatusChanged: (listener: (statuses: McpServerStatus[]) => void) => () => void
  /** 自动更新（update:*，docs/09） */
  updater: UpdateControllerLike
  /** Aurora Center 连接（center:status，docs/12）。未装配时（理论上不会）按未启用回答 */
  center?: CenterConnectionLike
  /** 自动化引擎（automation:*，docs/13 §9）。未装配时六条通道按 E_INVALID_STATE 如实报错 */
  automation?: AutomationControllerLike
  /** 文件自感知（awareness:*，docs/06 §26）。未装配时按不可用状态回答。 */
  awareness?: FileAwarenessControllerLike
  logger: Logger
  paths: { userData: string; logs: string; config: string; builtinSkills: string }
  isDev: boolean
  /** 仅自测（`AURORA_SMOKE=1`）为 true；控制诊断通道是否可用 */
  smokeMode?: boolean
  /** 自测诊断回执（仅 smokeMode 下被调用） */
  smokeDiagnostics?: () => SmokeDiagnostics
  /**
   * 附件提取（docs/07 §2.3）：把拖进对话窗的本地文件转成可入上下文的文本。
   * 由主进程注入（复用分类管线的 `extract.ts`，不引入第二条提取路径）。
   * 返回 `undefined` 表示该文件无法提取文本（按「仅文件名」降级处理）。
   */
  attachmentExtract?: (path: string) => Promise<AttachmentDigest | undefined>
  /** 当前生效模型是否支持图片输入；缺省按持久化 settings 判定（测试兼容）。 */
  visionEnabled?: () => boolean
  onQuit: () => void
  onSettingsChanged?: (settings: Settings) => void
}

/** 附件提取结果（实现与 `chat:send` 共用 `attachment-prepare.ts`；这里保留导出以稳定消费方）。 */
export type { AttachmentDigest }

/** 插件斜杠命令：`/name args`（命令名规则与清单一致，见 `PLUGIN_COMMAND_NAME_PATTERN`）。 */
const PLUGIN_COMMAND_PATTERN = /^\/([a-z][a-z0-9_-]{0,31})(?:\s+([\s\S]*))?$/

/** `message.assistant` 投递给插件的正文上限（16 KB；再长对事件订阅方也没有意义） */
const PLUGIN_ASSISTANT_TEXT_MAX = 16 * 1024

function matchPluginCommand(
  text: string,
  commands: PluginCommandInfo[],
): { command: PluginCommandInfo; args: string } | undefined {
  const match = PLUGIN_COMMAND_PATTERN.exec(text.trim())
  if (match === null) return undefined
  const name = match[1] ?? ''
  const command = commands.find((item) => item.name === name)
  if (command === undefined) return undefined
  return { command, args: (match[2] ?? '').trim() }
}

/**
 * ClassIsland 控制器（`ClassIslandControllerLike` + v3 的提醒通道）。
 *
 * 提醒方法在这里**就地扩展**而不是改 `contracts.ts` 的 `ClassIslandControllerLike`：
 * 那个接口是「主进程对 IPC 层的稳定切片」，`notify` 目前只有本文件一个消费方，
 * 扩展留在消费方一侧可把改动面收在 IPC 层内（本任务的文件归属要求）。
 */
type ClassIslandController = ClassIslandControllerLike & {
  /** 让 ClassIsland 弹出提醒（docs/05 §3.4 v3，`classisland:notify`） */
  notify(request: ClassIslandNotifyRequest): Promise<ClassIslandNotifyResult>
}

/**
 * 归一 IPC 传来的提醒请求：只取三个已知字段、逐字段校验类型。
 *
 * 跨 IPC 的入参来自渲染层，**不能假设形状正确**；显式挑字段也顺手避免把未知字段透到桥接端。
 */
function normalizeNotifyRequest(input: unknown): ClassIslandNotifyRequest {
  const record =
    typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
  const normalized: ClassIslandNotifyRequest = {
    title: typeof record['title'] === 'string' ? record['title'] : '',
    body: typeof record['body'] === 'string' ? record['body'] : '',
  }
  const channel = record['channel']
  if (channel === 'class-started' || channel === 'pre-class' || channel === 'custom') {
    normalized.channel = channel
  }
  return normalized
}

export function registerIpc(deps: DesktopDeps): () => void {
  const handlers: Array<[string, (...args: never[]) => unknown]> = []
  const snapshots = deps.snapshots
  const jobs = deps.jobs
  const plugins = deps.plugins

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
  // 死通道收尾：`app:openLogs` 之前只有通道常量与 preload 镜像、没有 handler，
  // 任何调用都会挂起到超时。这里补上，与托盘「打开日志目录」同一实现。
  handle<string>(IPC.app.openLogs, () => openPath(deps, { kind: 'logs' }))
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
      await nodeFs.writeFile(target, request.content, 'utf8')
      return ok(target)
    } catch (error) {
      return err('E_IO', error instanceof Error ? error.message : String(error))
    }
  })

  // ───────────────────────── project（v13，docs/06 §5.1）─────────────────────────

  handle<ProjectStatus>(IPC.project.status, async () => ok(await projectStatus(deps)))
  handle<string | null>(IPC.project.pickDirectory, async () => {
    // 渲染层没有文件系统能力（docs/07 §2.3 同款限制），目录只能由主进程弹选择框
    const picked = await dialog.showOpenDialog({
      title: '选择项目根目录',
      buttonLabel: '选择此目录',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (picked.canceled) return ok(null)
    return ok(picked.filePaths[0] ?? null)
  })

  // ───────────────────────── snapshots（v14，docs/06 §11.8）─────────────────────────

  handle<SnapshotRef[]>(IPC.snapshots.list, (request: SnapshotListRequest | undefined) =>
    snapshots
      ? snapshots.list(request ?? {}).then(ok, (error: unknown) => err('E_IO', String(error)))
      : err('E_INVALID_STATE', '快照端口尚未装配'),
  )
  handle<SnapshotRef>(IPC.snapshots.restore, (request: SnapshotRestoreRequest) =>
    restoreSnapshot(deps, snapshots, request),
  )
  handle<number>(IPC.snapshots.prune, (request: { sessionId: string }) =>
    snapshots
      ? snapshots.prune(request.sessionId).then(
          (result) => ok(result.removed),
          (error: unknown) => err('E_IO', String(error)),
        )
      : err('E_INVALID_STATE', '快照端口尚未装配'),
  )

  // ───────────────────────── jobs（v15，docs/06 §4.1）─────────────────────────

  handle<AgentJob[]>(
    IPC.chat.jobs,
    (request: { sessionId?: string; status?: AgentJobStatus; limit?: number } | undefined) =>
      jobs === undefined
        ? err('E_INVALID_STATE', '任务存储尚未装配')
        : jobs.list(request ?? {}).then(ok, (error: unknown) => err('E_IO', String(error))),
  )
  handle<{ requestId: string }>(
    IPC.chat.resumeJob,
    (request: { sessionId: string; jobId: string }) => resumeJob(deps, jobs, request),
  )
  handle<boolean>(IPC.chat.cancelJob, (request: { sessionId: string; jobId: string }) =>
    cancelJob(deps, jobs, request),
  )

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

  // ───────────────────────── tts（语音合成，docs/06 §13） ─────────────────────────

  handle(IPC.tts.synthesize, (request: Parameters<TtsSynthesizerLike['synthesize']>[0]) => {
    return deps.tts
      .synthesize(request)
      .then(ok, (error: unknown) =>
        err('E_INVALID_STATE', error instanceof Error ? error.message : String(error)),
      )
  })
  handle(IPC.tts.testConnection, (request: Parameters<TtsSynthesizerLike['test']>[0]) => {
    return deps.tts
      .test(request)
      .then(ok, (error: unknown) =>
        err('E_UNKNOWN', error instanceof Error ? error.message : String(error)),
      )
  })
  handle(IPC.tts.listModels, (request: Parameters<TtsSynthesizerLike['listModels']>[0]) => {
    return deps.tts
      .listModels(request)
      .then(ok, (error: unknown) =>
        err('E_UNKNOWN', error instanceof Error ? error.message : String(error)),
      )
  })

  // ───────────────── stt / imagegen（v8 新增，Design/betav2-spec.md §5 / §8） ─────────────────

  handle(IPC.stt.transcribe, (request: Parameters<SttServiceLike['transcribe']>[0]) => {
    return deps.stt
      .transcribe(request)
      .then(ok, (error: unknown) =>
        err('E_INVALID_STATE', error instanceof Error ? error.message : String(error)),
      )
  })
  handle(IPC.imagegen.generate, (request: Parameters<ImageGenServiceLike['generate']>[0]) => {
    return deps.imagegen
      .generate(request)
      .then(ok, (error: unknown) =>
        err('E_INVALID_STATE', error instanceof Error ? error.message : String(error)),
      )
  })
  handle(IPC.imagegen.read, (request: ImageGenReadRequest) => {
    return deps.imagegen
      .read(request)
      .then(ok, (error: unknown) =>
        err('E_INVALID_ARGUMENT', error instanceof Error ? error.message : String(error)),
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
  handle<WindowState>(
    IPC.window.setPosition,
    (name: WindowName, position: { x: number; y: number }) =>
      withState(() => deps.windows.setPosition(name, position)),
  )
  handle<WindowState>(IPC.window.setEdgeBarExpanded, (expanded: boolean) =>
    withState(() => deps.windows.setEdgeBarExpanded(expanded)),
  )
  handle<WindowState>(IPC.window.minimize, (name: WindowName) =>
    withState(() => deps.windows.minimize(name)),
  )
  handle<WindowState>(IPC.window.toggleMaximize, (name: WindowName) =>
    withState(() => deps.windows.toggleMaximize(name)),
  )

  // ───────────────────────── perception / chat ─────────────────────────

  handle(IPC.perception.summary, () =>
    deps.perception
      .summary()
      .then(ok, (error: unknown) =>
        err('E_UNKNOWN', error instanceof Error ? error.message : String(error)),
      ),
  )
  handle(IPC.chat.send, async (request: SendMessageRequest) => {
    // 附件（docs/07 §2.3）：在主进程分流 —— 图片交多模态链路（docs/06 §3.1，是否真的下发
    // 取决于 `llm.providers.<id>.modelParams.<模型>.vision`），其余提取成文本后拼进本轮消息。
    // 刻意**不在渲染层**读文件 —— 渲染进程没有 fs 能力，也不该有。
    try {
      // 首条用户消息判定必须在 agent.send 之前完成：send 返回后内核已经异步开跑，
      // 再读历史会把刚追加的这条也算进去；pending 重试则由标题服务自行判断。
      const hadUserMessage = (await deps.sessions.get(request.sessionId)).some(
        (message) => message.role === 'user',
      )
      const prepared = await prepareAttachments(deps, request.attachments)
      // 插件斜杠命令（docs/14）：`action` 立即执行并回 `handled`，不进入 Agent；
      // `prompt` 把插件返回的提示词并入 extraContext，用户气泡仍显示 `/name args`。
      const pluginCommand = matchPluginCommand(request.text, plugins?.commands() ?? [])
      if (pluginCommand !== undefined && pluginCommand.command.mode === 'action') {
        if (plugins === undefined) {
          return err('E_INVALID_STATE', '插件系统尚未装配')
        }
        try {
          const result = await plugins.invokeCommand(
            pluginCommand.command.pluginId,
            pluginCommand.command.name,
            pluginCommand.args,
          )
          return ok({
            requestId: randomUUID(),
            handled: result.summary === undefined ? {} : { summary: result.summary },
          })
        } catch (error) {
          return err('E_UNKNOWN', error instanceof Error ? error.message : String(error))
        }
      }
      // 内置命令 `/init`（docs/06 §6）：指令正文拼进 extraContext（与技能正文同一通道），
      // 用户气泡显示的仍是三个字符 `/init`。边界根解析不出时原样透传，不造一个假目录。
      const extraSections: Array<string | undefined> = [prepared.extraContext]
      if (pluginCommand !== undefined && pluginCommand.command.mode === 'prompt') {
        if (plugins === undefined) {
          return err('E_INVALID_STATE', '插件系统尚未装配')
        }
        try {
          const result = await plugins.invokeCommand(
            pluginCommand.command.pluginId,
            pluginCommand.command.name,
            pluginCommand.args,
          )
          if (result.prompt !== undefined && result.prompt.trim() !== '') {
            extraSections.push(result.prompt)
          }
        } catch (error) {
          return err('E_UNKNOWN', error instanceof Error ? error.message : String(error))
        }
      }
      if (isInitCommand(request.text)) {
        const root = deps.workspaceRootOf?.(request.sessionId) ?? ''
        if (root !== '') {
          const projectId = await deps.sessions.projectIdOf(request.sessionId)
          extraSections.push(
            buildInitCommandContext({ root, isProjectRoot: projectId !== undefined }),
          )
        }
      }
      const extraContext = extraSections
        .map((section) => section?.trim() ?? '')
        .filter((section) => section !== '')
        .join('\n\n')
      return await deps.agent
        .send({
          ...request,
          ...(extraContext === '' ? {} : { extraContext }),
          ...(prepared.images.length === 0 ? {} : { images: prepared.images }),
        })
        .then((result) => {
          // 不 await 标题：它与主回复并行，且失败绝不影响这次对话。
          deps.sessionTitles?.schedule(
            request.sessionId,
            hadUserMessage ? undefined : request.text,
            hadUserMessage ? [] : (request.attachments ?? []),
          )
          // 宿主事件（docs/14 §3.5）：正文按上限截断后再投递
          void deps.plugins?.deliverEvent('message.user', {
            sessionId: request.sessionId,
            text: request.text.slice(0, PLUGIN_ASSISTANT_TEXT_MAX),
          })
          return result
        })
        .then(ok, (error: unknown) =>
          err('E_UNKNOWN', error instanceof Error ? error.message : String(error)),
        )
    } catch (error) {
      return err('E_UNKNOWN', error instanceof Error ? error.message : String(error))
    }
  })
  /**
   * 手动压缩会话上下文（`/compact`，docs/06 §4）：渲染层斜杠命令**选中即调**这条通道
   * （不进 `chat:send` —— 压缩不产生流式回复，走发送链会让输入区永远停在「流式中」）。
   * 结局用 `CompactOutcome` 表达（不抛错），失败原因原样回给渲染层展示。
   */
  handle<{ summaryChars: number; coveredMessages: number }>(
    IPC.chat.compact,
    (request: { sessionId?: string }) => {
      const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : ''
      if (sessionId === '') {
        return Promise.resolve(err('E_INVALID_ARGUMENT', '缺少 sessionId'))
      }
      return deps.agent
        .compact(sessionId)
        .then((outcome) =>
          outcome.ok
            ? ok({ summaryChars: outcome.summaryChars, coveredMessages: outcome.coveredMessages })
            : err('E_UNKNOWN', outcome.error),
        )
        .catch((error: unknown) =>
          err('E_UNKNOWN', error instanceof Error ? error.message : String(error)),
        )
    },
  )
  /**
   * 右栏「文件」预览（2026-10-03，docs/07 §2.3）：路径边界 / 大小上限 / 二进制探测
   * 全在主进程侧（`file-preview.ts`），渲染层只拿结果。
   */
  handle<FilePreviewResult>(IPC.preview.read, (request: FilePreviewRequest) => {
    const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : ''
    if (sessionId === '') {
      return Promise.resolve(err('E_INVALID_ARGUMENT', '缺少 sessionId'))
    }
    return buildFilePreview(
      { rootOf: (id) => deps.workspaceRootOf?.(id) },
      { sessionId, path: request?.path ?? '' },
    )
      .then(ok)
      .catch((error: unknown) =>
        err('E_UNKNOWN', error instanceof Error ? error.message : String(error)),
      )
  })
  /**
   * 右栏「文件」tab 的目录列表（2026-10-03，docs/07 §2.3）：缺省列出会话边界根
   * （绑定了项目 → 项目文件夹），逐层进入。边界判定与读盘同样全在主进程侧（`file-list.ts`）。
   */
  handle<FileListResult>(IPC.preview.list, (request: FileListRequest) => {
    const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : ''
    if (sessionId === '') {
      return Promise.resolve(err('E_INVALID_ARGUMENT', '缺少 sessionId'))
    }
    return buildFileList(
      { rootOf: (id) => deps.workspaceRootOf?.(id) },
      {
        sessionId,
        ...(typeof request?.path === 'string' ? { path: request.path } : {}),
      },
    )
      .then(ok)
      .catch((error: unknown) =>
        err('E_UNKNOWN', error instanceof Error ? error.message : String(error)),
      )
  })
  /**
   * Agent 内置浏览器（v35，docs/06 §27）：渲染层建好 webview 后回报 `webContentsId`。
   *
   * 主进程在这里校验 guest 归属（`hostWebContents` 必须是 chat 窗口）并交付给
   * `BrowserAgentManager`；失败要**明确回错**，否则 Agent 会一直等到 15s 超时。
   */
  handle<void>(IPC.browser.agentReport, (request: BrowserAgentReportRequest) => {
    if (deps.browserAgent === undefined) {
      return Promise.resolve(err('E_INVALID_STATE', '内置浏览器服务不可用'))
    }
    try {
      deps.browserAgent.report(request)
      return Promise.resolve(ok(undefined))
    } catch (error) {
      return Promise.resolve(
        err('E_INVALID_STATE', error instanceof Error ? error.message : String(error)),
      )
    }
  })
  /** 用户点「停止」/ 关闭标签：结束该会话的 Agent 控制（标签保留）。 */
  handle<void>(IPC.browser.agentStop, (request: BrowserAgentStopRequest) => {
    if (deps.browserAgent === undefined) {
      return Promise.resolve(err('E_INVALID_STATE', '内置浏览器服务不可用'))
    }
    try {
      deps.browserAgent.stop(request?.sessionId ?? '', '用户停止了 Agent 浏览器操作')
      return Promise.resolve(ok(undefined))
    } catch (error) {
      return Promise.resolve(
        err('E_UNKNOWN', error instanceof Error ? error.message : String(error)),
      )
    }
  })
  /**
   * 右栏「终端」（2026-10-03，docs/07 §2.3）：PTY 交互终端。
   * 刻意**不走上面的 `handle` 封装**：create 需要发起窗口的 `event.sender.id`
   * （输出只推给创建它的窗口 + 按窗口记账的销毁清理），而封装把 event 吞掉了。
   * 其余三条不需要 sender，直接透传给服务。
   * 2026-10-03 二次修订：**一个标签一条 PTY**（create 不再复用），到上限时服务抛中文错误，
   * 这里折成 `E_UNKNOWN` 回执，渲染层面板原样显示原因。
   */
  ipcMain.handle(IPC.terminal.create, (event, request: TerminalCreateRequest) => {
    const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : ''
    if (sessionId === '' || deps.terminal === undefined) {
      return Promise.resolve(err('E_INVALID_STATE', '终端服务不可用'))
    }
    try {
      return ok(deps.terminal.create(event.sender.id, sessionId))
    } catch (error) {
      return err('E_UNKNOWN', error instanceof Error ? error.message : String(error))
    }
  })
  handle<boolean>(IPC.terminal.input, (request: TerminalInputRequest) => {
    if (deps.terminal === undefined) return err('E_INVALID_STATE', '终端服务不可用')
    if (typeof request?.terminalId !== 'string' || typeof request?.data !== 'string') {
      return err('E_INVALID_ARGUMENT', '终端输入参数不完整')
    }
    deps.terminal.input(request.terminalId, request.data)
    return ok(true)
  })
  handle<boolean>(IPC.terminal.resize, (request: TerminalResizeRequest) => {
    if (deps.terminal === undefined) return err('E_INVALID_STATE', '终端服务不可用')
    if (
      typeof request?.terminalId !== 'string' ||
      typeof request?.cols !== 'number' ||
      typeof request?.rows !== 'number'
    ) {
      return err('E_INVALID_ARGUMENT', '终端尺寸参数不完整')
    }
    deps.terminal.resize(request.terminalId, request.cols, request.rows)
    return ok(true)
  })
  handle<boolean>(IPC.terminal.kill, (request: { terminalId?: string }) => {
    if (deps.terminal === undefined) return err('E_INVALID_STATE', '终端服务不可用')
    const terminalId = typeof request?.terminalId === 'string' ? request.terminalId : ''
    if (terminalId === '') return err('E_INVALID_ARGUMENT', '缺少 terminalId')
    deps.terminal.killByTerminalId(terminalId)
    return ok(true)
  })
  /**
   * 附件缩略图（v22 多模态输入，docs/07 §2.3）：渲染层 chip 上那张 48×48 的图。
   *
   * 渲染进程拿不到 fs，这是唯一通道；**只回 data URL**（不回来路 / 目录信息），
   * 非图片、超过 `PREVIEW_MAX_BYTES`、读失败都退回纯文字 chip 并附原因，
   * 绝不让渲染层显示一张裂图。
   */
  handle<ChatAttachmentPreview>(
    IPC.chat.readAttachment,
    (request: ChatAttachmentPreviewRequest) => {
      const path = typeof request?.path === 'string' ? request.path : ''
      if (path === '') return Promise.resolve(err('E_INVALID_ARGUMENT', '缺少附件路径'))
      return buildAttachmentPreview(path, previewReadPort)
        .then(ok)
        .catch((error: unknown) =>
          err('E_UNKNOWN', error instanceof Error ? error.message : String(error)),
        )
    },
  )
  /**
   * 粘贴图片暂存（`chat:stageImage`，2026-10-18，docs/07 §2.3）：paste 拿到的 `File`
   * 没有本地路径，主进程写进 `<userData>/pasted/` 后回路径 + 96px 预览图 ——
   * 之后与拖拽进来的图片走完全相同的附件链路（`chat:readAttachment` / `chat:send`）。
   *
   * 渲染层传来的 mime / 大小一律不可信：白名单、空内容、8 MiB 上限都在
   * `pasted-image.ts` 里再判一次；失败按 `Result.code` 如实回，不写半个文件。
   */
  handle<ChatStageImageResult>(IPC.chat.stageImage, async (request: ChatStageImageRequest) => {
    const mimeType = typeof request?.mimeType === 'string' ? request.mimeType : ''
    const raw = (request as { data?: unknown } | undefined)?.data
    const bytes =
      raw instanceof ArrayBuffer
        ? Buffer.from(raw)
        : ArrayBuffer.isView(raw)
          ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
          : undefined
    if (bytes === undefined) return err('E_INVALID_ARGUMENT', '缺少图片数据')
    try {
      const staged = await writePastedImage({
        dir: join(deps.paths.userData, 'pasted'),
        mimeType,
        data: bytes,
        logger: deps.logger,
      })
      const previewDataUrl = buildPastedPreview(bytes, staged.mimeType)
      return ok({
        path: staged.path,
        name: staged.name,
        ...(previewDataUrl === undefined ? {} : { previewDataUrl }),
      })
    } catch (error) {
      if (error instanceof PastedImageError) return err(error.code, error.message)
      return err('E_UNKNOWN', error instanceof Error ? error.message : String(error))
    }
  })
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
  // 「当前会话」由渲染层判定：不同窗口用的是不同会话（quick / main），
  // 主进程不知道哪个正在被看，因此不在这里标 active。
  handle<ChatSessionSummary[]>(IPC.chat.sessions, () =>
    deps.sessions.summaries().then(
      (items) => ok(items.filter((item) => !isFileAwarenessSession(item.id))),
      (error: unknown) => err('E_UNKNOWN', error instanceof Error ? error.message : String(error)),
    ),
  )
  /**
   * 新建会话（docs/06 §4 会话三分，2026-09-30）。
   *
   * 可选参数打「空间戳」：`space: 'work'` = 工作目录对话（Work 模式专属），
   * 其余（缺省 / `'agent'`）= Agent对话；`projectId` 传入则绑定到该项目
   * （校验存在性，同 `chat:setSessionProject`；绑定优先于 space）。非法 space 报错而不静默
   * —— 静默成功后左栏分组与实际工作目录会落到错误分区，最难排查。
   * `createSession` 只写内存：空会话不落盘，首条消息落盘时 meta 随消息一起写入。
   */
  handle<string>(IPC.chat.newSession, (request?: { space?: string; projectId?: string }) => {
    const space = request?.space
    if (space !== undefined && space !== 'agent' && space !== 'work') {
      return Promise.resolve(err('E_INVALID_ARGUMENT', `非法的会话空间：${String(space)}`))
    }
    const projectId = request?.projectId?.trim() ?? ''
    if (
      projectId !== '' &&
      !deps.settings.get().projects.list.some((project) => project.id === projectId)
    ) {
      return Promise.resolve(err('E_INVALID_ARGUMENT', '项目不存在（可能已被删除）'))
    }
    return deps.sessions
      .createSession(space === undefined ? undefined : { space })
      .then(async (sessionId) => {
        // 宿主事件（docs/14 §3.5）：会话已创建即投递，绑定项目失败不影响这条事实
        void deps.plugins?.deliverEvent('session.created', { sessionId })
        if (projectId !== '') await deps.sessions.setProject(sessionId, projectId)
        return sessionId
      })
      .then(ok, (error: unknown) =>
        err('E_UNKNOWN', error instanceof Error ? error.message : String(error)),
      )
  })
  /**
   * 归档 / 取消归档（docs/06 §4）。
   *
   * `setArchived` **幂等且 await 落盘完成**，所以调用方（渲染层）在拿到 ok 之后立刻
   * 再拉一次 `chat:sessions` 就能读到新状态 —— 探针的「归档 → 列表里带标记」正是靠这条确定性。
   * 归档不做任何删除：消息仍在、会话仍可继续对话，只是多了个标记。
   */
  handle<{ archived: boolean }>(IPC.chat.archiveSession, (request: ChatArchiveRequest) => {
    const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : ''
    const archived = request?.archived === true
    // 空 id 是调用方的错误，如实报错而不是静默 ok（静默成功会掩盖渲染层的 bug）
    if (sessionId === '') {
      return Promise.resolve(err('E_INVALID_ARGUMENT', 'sessionId 不能为空'))
    }
    return deps.sessions.setArchived(sessionId, archived).then(
      () => ok({ archived }),
      (error: unknown) => err('E_UNKNOWN', error instanceof Error ? error.message : String(error)),
    )
  })
  /**
   * 绑定 / 解绑会话项目（docs/06 §5.1 会话级项目，v17）。
   *
   * 与归档同一条惯例：状态写在会话文件自身的 `meta` 里（**不是配置项**，与 settings 无关），
   * `setProject` **幂等且 await 落盘完成**，渲染层拿到 ok 后立刻拉 `chat:sessions` 就能读到
   * 新绑定。`projectId` 空串 = 清除绑定；绑定到 `projects.list` 里不存在的项目**报错而不静默**
   * ——静默成功后工具链会按「绑定已失效」回落全局项目，用户却以为绑定生效了，最难排查。
   */
  handle<{ projectId: string }>(
    IPC.chat.setSessionProject,
    (request: ChatSessionProjectRequest) => {
      const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : ''
      const projectId = typeof request?.projectId === 'string' ? request.projectId.trim() : ''
      if (sessionId === '') {
        return Promise.resolve(err('E_INVALID_ARGUMENT', 'sessionId 不能为空'))
      }
      if (
        projectId !== '' &&
        !deps.settings.get().projects.list.some((project) => project.id === projectId)
      ) {
        return Promise.resolve(err('E_INVALID_ARGUMENT', '项目不存在（可能已被删除）'))
      }
      return deps.sessions.setProject(sessionId, projectId).then(
        () => ok({ projectId }),
        (error: unknown) =>
          err('E_UNKNOWN', error instanceof Error ? error.message : String(error)),
      )
    },
  )
  handle<ChatDisplayImageReadResult>(
    IPC.chat.readDisplayImage,
    (request: ChatDisplayImageReadRequest) => {
      const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : ''
      const imageId = typeof request?.imageId === 'string' ? request.imageId : ''
      if (sessionId === '' || imageId === '') {
        return Promise.resolve(err('E_INVALID_ARGUMENT', '缺少 sessionId 或 imageId'))
      }
      const maxDimension =
        typeof request?.maxDimension === 'number' && Number.isFinite(request.maxDimension)
          ? Math.floor(request.maxDimension)
          : 0
      return deps
        .readDisplayImage({ sessionId, imageId })
        .then((result) => ok(shrinkDisplayImage(result, maxDimension)))
        .catch((error: unknown) =>
          err('E_UNKNOWN', error instanceof Error ? error.message : String(error)),
        )
    },
  )
  /**
   * 覆盖 / 清除会话级模型（docs/06 §3，本轮）。
   *
   * 与 `chat:setSessionProject` 同一条惯例：状态写在会话文件自身的 `meta.llm` 里
   * （**不是配置项**，与 settings 无关），`setModelOverride` 幂等且 await 落盘完成，
   * 渲染层拿到 ok 后立刻拉 `chat:sessions` 就能读到新覆盖。
   * `model` / `providerId` 空串 = **清除覆盖**（回落全局 `llm.active`）；
   * providerId 不在 `llm.providers` 里**报错而不静默** —— 静默成功后请求仍走全局档，
   * 用户却以为会话绑上了模型，最难排查。
   */
  handle<{ providerId: string; model: string }>(
    IPC.chat.setSessionModel,
    (request: ChatSessionModelRequest) => {
      const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : ''
      const providerId = typeof request?.providerId === 'string' ? request.providerId.trim() : ''
      const model = typeof request?.model === 'string' ? request.model.trim() : ''
      if (sessionId === '') {
        return Promise.resolve(err('E_INVALID_ARGUMENT', 'sessionId 不能为空'))
      }
      // 清除路径：model 或 providerId 为空都按「清除覆盖」处理（不校验 provider 存在性）
      const clearing = providerId === '' || model === ''
      if (!clearing && deps.settings.get().llm.providers[providerId] === undefined) {
        return Promise.resolve(err('E_INVALID_ARGUMENT', '模型配置不存在（可能已被删除）'))
      }
      const value = clearing ? null : { providerId, model }
      return deps.sessions.setModelOverride(sessionId, value).then(
        () => ok(clearing ? { providerId: '', model: '' } : { providerId, model }),
        (error: unknown) =>
          err('E_UNKNOWN', error instanceof Error ? error.message : String(error)),
      )
    },
  )
  /**
   * 真删除会话（docs/08 会话管理页，`SessionStore.remove`）：删 `sessions/<id>.json`
   * + 清全部内存态，**不可逆** —— 渲染层负责两步确认，这里负责守卫：
   * 该会话还有 `running` 的 job（请求在跑或自动续轮中）时拒绝 `E_INVALID_STATE`（状态冲突）
   * （在跑的流随时会 append，删了会被下一轮写回来）；paused / 已结束的 job 随会话一起
   * 留在盘上无妨（会话没了它们也不可达，job 文件的 24h TTL 之外由会话删除兜底清理不在本轮范围）。
   * 守卫通过后先清理该会话及其子代理的 todo，再删会话；todo 清理失败时不删会话、不广播。
   * 文件不存在（从未落盘的空会话）幂等返回 ok。
   *
   * **删除成功后**广播 `chat:sessionDeleted`（载荷带 sessionId，docs/07 §2.3）：
   * chat 窗口据此重拉会话列表，当前会话被删时按「最近会话 / 新建」回落
   * —— 否则被删会话会一直留在左栏、`activeId` 仍指向它。
   */
  handle<boolean>(IPC.chat.deleteSession, (request: { sessionId: string }) => {
    const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : ''
    if (sessionId === '') {
      return Promise.resolve(err('E_INVALID_ARGUMENT', 'sessionId 不能为空'))
    }
    return deleteSessionState(deps, sessionId).then((result) => {
      if (result.ok) {
        // 广播在**删除成功之后**（失败/被守卫拒绝时不发，避免渲染层对着不存在的删除动作回落）
        broadcast(IPC.chat.sessionDeleted, { sessionId })
        void deps.plugins?.deliverEvent('session.deleted', { sessionId })
      }
      return result
    })
  })
  handle<SkillSummary[]>(IPC.skills.list, () => ok(deps.skills.list()))
  handle<SkillsStatus>(IPC.skills.rescan, () =>
    deps.skills
      .rescan()
      .then(ok, (error: unknown) =>
        err('E_UNKNOWN', error instanceof Error ? error.message : String(error)),
      ),
  )
  handle<SkillsStatus>(IPC.skills.status, () => ok(deps.skills.status()))

  // ───────────────────────── plugins（docs/14）─────────────────────────
  // 安装 / 启停 / 信任 / 配置全部经 `PluginManager`；未装配时如实回错，不静默成功。
  const pluginsMissing = <T>(): Result<T> => err('E_INVALID_STATE', '插件系统尚未装配')
  const pluginError = (error: unknown): Result<never> =>
    err('E_INVALID_ARGUMENT', error instanceof Error ? error.message : String(error))

  handle<PluginSummary[]>(IPC.plugins.list, () =>
    plugins === undefined ? pluginsMissing<PluginSummary[]>() : ok(plugins.list()),
  )
  handle<PluginInstallPreview>(IPC.plugins.inspect, (ref: PluginPackageRef) =>
    plugins === undefined
      ? Promise.resolve(pluginsMissing<PluginInstallPreview>())
      : plugins.inspect(ref).then(ok, pluginError),
  )
  handle<PluginSummary>(IPC.plugins.install, (ref: PluginPackageRef) =>
    plugins === undefined
      ? Promise.resolve(pluginsMissing<PluginSummary>())
      : plugins.install(ref).then(ok, pluginError),
  )
  handle<boolean>(IPC.plugins.uninstall, (request: PluginUninstallRequest) =>
    plugins === undefined
      ? Promise.resolve(pluginsMissing<boolean>())
      : plugins.uninstall(request.pluginId, request.deleteData === true).then(ok, pluginError),
  )
  handle<PluginSummary>(
    IPC.plugins.setEnabled,
    (request: { pluginId: string; enabled: boolean }) =>
      plugins === undefined
        ? Promise.resolve(pluginsMissing<PluginSummary>())
        : plugins.setEnabled(request.pluginId, request.enabled).then(ok, pluginError),
  )
  handle<PluginSummary>(
    IPC.plugins.setTrusted,
    (request: { pluginId: string; trusted: boolean }) =>
      plugins === undefined
        ? Promise.resolve(pluginsMissing<PluginSummary>())
        : plugins.setTrusted(request.pluginId, request.trusted).then(ok, pluginError),
  )
  handle<PluginSummary>(IPC.plugins.restart, (request: { pluginId: string }) =>
    plugins === undefined
      ? Promise.resolve(pluginsMissing<PluginSummary>())
      : plugins.restart(request.pluginId).then(ok, pluginError),
  )
  handle<PluginSummary>(IPC.plugins.rollback, (request: { pluginId: string }) =>
    plugins === undefined
      ? Promise.resolve(pluginsMissing<PluginSummary>())
      : plugins.rollback(request.pluginId).then(ok, pluginError),
  )
  /**
   * 插件配置窗口（docs/07 §2.2.2）：设置列表的「配置」按钮 → 单例 `plugin-config` 窗口。
   * 已打开时复用同一窗口，经 `showWithPayload` 等页面加载完成后再推参数，避免首开空白。
   */
  handle<WindowState>(IPC.plugins.openWindow, async (request: { pluginId: string }) => {
    if (plugins === undefined) return pluginsMissing<WindowState>()
    const pluginId = typeof request?.pluginId === 'string' ? request.pluginId.trim() : ''
    if (pluginId === '' || plugins.get(pluginId) === undefined) {
      return err('E_INVALID_ARGUMENT', '插件不存在')
    }
    return ok(
      await deps.windows.showWithPayload('plugin-config', IPC.plugins.windowRequest, {
        requestId: randomUUID(),
        pluginId,
      }),
    )
  })
  handle<string | null>(IPC.plugins.choosePackage, async () => {
    const picked = await dialog.showOpenDialog({
      title: '选择 Aurora 插件包',
      buttonLabel: '选择插件包',
      properties: ['openFile'],
      filters: [{ name: 'Aurora 插件包', extensions: ['aurora-plugin', 'zip'] }],
    })
    return ok(picked.canceled ? null : (picked.filePaths[0] ?? null))
  })
  handle<string | null>(IPC.plugins.chooseDir, async () => {
    const picked = await dialog.showOpenDialog({
      title: '选择插件开发目录',
      buttonLabel: '使用此目录',
      properties: ['openDirectory'],
    })
    return ok(picked.canceled ? null : (picked.filePaths[0] ?? null))
  })
  handle<string>(IPC.plugins.openFolder, (request: { pluginId: string }) => {
    if (plugins === undefined) return pluginsMissing<string>()
    const path = plugins.installPathOf(request?.pluginId ?? '')
    if (path === undefined) return err('E_INVALID_ARGUMENT', '插件不存在')
    shell.showItemInFolder(path)
    return ok(path)
  })
  handle<string>(IPC.plugins.openLog, async (request: { pluginId: string }) => {
    if (plugins === undefined) return pluginsMissing<string>()
    const pluginId = request?.pluginId ?? ''
    if (plugins.get(pluginId) === undefined) return err('E_INVALID_ARGUMENT', '插件不存在')
    const file = plugins.logFileOf(pluginId)
    await nodeFs.mkdir(dirname(file), { recursive: true }).catch(() => undefined)
    const failure = await shell.openPath(file)
    if (failure !== '') return err('E_IO', failure)
    return ok(file)
  })
  handle<Record<string, unknown>>(IPC.plugins.getConfig, (request: { pluginId: string }) =>
    plugins === undefined
      ? Promise.resolve(pluginsMissing<Record<string, unknown>>())
      : plugins.getConfig(request.pluginId).then(ok, pluginError),
  )
  handle<Record<string, unknown>>(IPC.plugins.setConfig, (request: PluginConfigValues) =>
    plugins === undefined
      ? Promise.resolve(pluginsMissing<Record<string, unknown>>())
      : plugins.setConfig(request.pluginId, request.values).then(ok, pluginError),
  )
  handle<PluginCommandInfo[]>(IPC.plugins.listCommands, () =>
    plugins === undefined ? pluginsMissing<PluginCommandInfo[]>() : ok(plugins.commands()),
  )
  handle<PluginRunCommandResult>(IPC.plugins.runCommand, (request: PluginRunCommandRequest) =>
    plugins === undefined
      ? Promise.resolve(pluginsMissing<PluginRunCommandResult>())
      : plugins
          .invokeCommand(request.pluginId, request.name, request.args ?? '')
          .then(ok, pluginError),
  )
  handle<PluginPanelDataResult>(IPC.plugins.panelData, async (request: PluginPanelDataRequest) => {
    if (plugins === undefined) return pluginsMissing<PluginPanelDataResult>()
    const pluginId = typeof request?.pluginId === 'string' ? request.pluginId : ''
    const panelId = typeof request?.panelId === 'string' ? request.panelId : ''
    if (pluginId === '' || panelId === '') {
      return err('E_INVALID_ARGUMENT', '缺少插件或面板 id')
    }
    const panel = plugins.get(pluginId)?.panels.find((item) => item.id === panelId)
    if (panel === undefined) return err('E_INVALID_ARGUMENT', '插件面板不存在')
    if (panel.kind === 'page') {
      return err('E_INVALID_ARGUMENT', '页面型面板请通过插件页面打开')
    }
    try {
      let schema: PluginPanelSchema | undefined
      const file = await plugins.panelSchemaFile(pluginId, panelId)
      if (file !== undefined) schema = JSON.parse(file) as PluginPanelSchema
      // 插件可以返回动态 schema；失败时保留静态 schema（面板不至于整块打不开）
      try {
        const result = await plugins.invokePanel(pluginId, panelId, request.method ?? 'refresh', {
          params: request.params,
          values: request.values ?? {},
        })
        if (result.schema !== undefined) schema = result.schema as PluginPanelSchema
        return ok({
          ...(schema === undefined ? {} : { schema }),
          ...(result.toast === undefined ? {} : { toast: result.toast }),
        })
      } catch (error) {
        if (schema === undefined) throw error
        return ok({ schema })
      }
    } catch (error) {
      return pluginError(error)
    }
  })
  handle<PluginWidgetDataResult>(
    IPC.plugins.widgetData,
    async (request: PluginWidgetDataRequest) => {
      if (plugins === undefined) return pluginsMissing<PluginWidgetDataResult>()
      const pluginId = typeof request?.pluginId === 'string' ? request.pluginId : ''
      const widgetId = typeof request?.widgetId === 'string' ? request.widgetId : ''
      if (pluginId === '' || widgetId === '') {
        return err('E_INVALID_ARGUMENT', '缺少插件或小组件 id')
      }
      const widget = plugins.get(pluginId)?.widgets.find((item) => item.id === widgetId)
      if (widget === undefined) return err('E_INVALID_ARGUMENT', '插件小组件不存在')
      if (widget.kind === 'page') {
        return err('E_INVALID_ARGUMENT', '页面型小组件请通过小组件页面打开')
      }
      const paramsBytes = JSON.stringify(request.params ?? null).length
      if (paramsBytes > 256 * 1024) {
        return err('E_INVALID_ARGUMENT', '小组件参数超过 256 KB')
      }
      try {
        let schema: PluginPanelSchema | undefined
        const file = await plugins.widgetSchemaFile(pluginId, widgetId)
        if (file !== undefined) schema = JSON.parse(file) as PluginPanelSchema
        try {
          const result = await plugins.invokeWidget(
            pluginId,
            widgetId,
            request.method ?? 'refresh',
            { params: request.params, values: request.values ?? {} },
          )
          if (result.schema !== undefined) schema = result.schema as PluginPanelSchema
          return ok({
            ...(schema === undefined ? {} : { schema }),
            ...(result.toast === undefined ? {} : { toast: result.toast }),
          })
        } catch (error) {
          if (schema === undefined) throw error
          return ok({ schema })
        }
      } catch (error) {
        return pluginError(error)
      }
    },
  )
  handle<PluginWidgetLayout>(IPC.plugins.widgetLayout, () => {
    if (deps.widgets === undefined) {
      return pluginsMissing<PluginWidgetLayout>()
    }
    return ok(deps.widgets.layoutSnapshot())
  })
  handle<boolean>(IPC.plugins.setWidgetVisible, (request: PluginSetWidgetVisibleRequest) => {
    if (deps.widgets === undefined) return pluginsMissing<boolean>()
    const pluginId = typeof request?.pluginId === 'string' ? request.pluginId : ''
    const widgetId = typeof request?.widgetId === 'string' ? request.widgetId : ''
    if (pluginId === '' || widgetId === '') {
      return err('E_INVALID_ARGUMENT', '缺少插件或小组件 id')
    }
    return deps.widgets
      .setVisible(pluginId, widgetId, request.visible === true)
      .then(ok, pluginError)
  })
  handle<boolean>(
    IPC.plugins.setWidgetWindowLevel,
    (request: PluginSetWidgetWindowLevelRequest) => {
      if (deps.widgets === undefined) return pluginsMissing<boolean>()
      const pluginId = typeof request?.pluginId === 'string' ? request.pluginId : ''
      const widgetId = typeof request?.widgetId === 'string' ? request.widgetId : ''
      if (pluginId === '' || widgetId === '') {
        return err('E_INVALID_ARGUMENT', '缺少插件或小组件 id')
      }
      const level = request?.windowLevel
      if (
        level !== 'auto' &&
        (typeof level !== 'string' ||
          !(PLUGIN_WIDGET_WINDOW_LEVELS as readonly string[]).includes(level))
      ) {
        return err('E_INVALID_ARGUMENT', '小组件层级必须是 auto / floating / normal / desktop')
      }
      return deps.widgets.setWindowLevel(pluginId, widgetId, level).then(ok, pluginError)
    },
  )
  handle<unknown>(IPC.plugins.pageRpc, async (request: PluginPageRpcRequest) => {
    if (plugins === undefined) return pluginsMissing<unknown>()
    const pluginId = typeof request?.pluginId === 'string' ? request.pluginId : ''
    const method = typeof request?.method === 'string' ? request.method : ''
    if (pluginId === '' || method === '' || method.length > 64) {
      return err('E_INVALID_ARGUMENT', '插件页面请求无效')
    }
    // 只接受自家窗口里真实挂载过的插件页面（`did-attach-webview` 登记）；
    // 主渲染层冒充别的插件 id 也过不了这一关。
    const guest = pluginPageGuestOf(request?.guestId ?? -1)
    if (guest === undefined) {
      return err('E_INVALID_STATE', '插件页面请求必须来自已登记的页面')
    }
    if (guest.pluginId !== pluginId) {
      return err('E_INVALID_STATE', '插件页面归属不匹配')
    }
    const summary = plugins.get(pluginId)
    if (summary === undefined) return err('E_INVALID_ARGUMENT', '插件不存在')
    const paramsBytes = JSON.stringify(request.params ?? null).length
    if (paramsBytes > 256 * 1024) {
      return err('E_INVALID_ARGUMENT', '插件页面请求超过 256 KB')
    }
    // 桌面小组件里的页面：guest 登记的是 widgetId，必须与请求一致，
    // 且目标确实是该插件的页面型小组件。
    const widgetId = typeof request.widgetId === 'string' ? request.widgetId : ''
    if (widgetId !== '') {
      if (guest.widgetId !== widgetId) {
        return err('E_INVALID_STATE', '小组件页面归属不匹配')
      }
      const widget = summary.widgets.find((item) => item.id === widgetId && item.kind === 'page')
      if (widget === undefined) return err('E_INVALID_ARGUMENT', '插件没有该页面型小组件')
      try {
        return ok(await plugins.invokeWidget(pluginId, widgetId, method, request.params ?? {}))
      } catch (error) {
        return pluginError(error)
      }
    }
    if (guest.widgetId !== undefined) {
      return err('E_INVALID_STATE', '小组件页面必须声明 widgetId')
    }
    const panelId =
      typeof request.panelId === 'string' && request.panelId !== ''
        ? request.panelId
        : summary.panels.find((item) => item.kind === 'page')?.id
    if (panelId === undefined) return err('E_INVALID_ARGUMENT', '插件没有页面型面板')
    try {
      const result = await plugins.invokePanel(pluginId, panelId, method, request.params ?? {})
      return ok(result)
    } catch (error) {
      return pluginError(error)
    }
  })
  handle<PluginMarketplaceListResult>(
    IPC.plugins.marketplaceList,
    (request?: { refresh?: boolean }) =>
      deps.pluginMarketplace === undefined
        ? pluginsMissing<PluginMarketplaceListResult>()
        : deps.pluginMarketplace
            .list(request?.refresh === true)
            .then(ok, (error: unknown) => pluginError(error)),
  )
  handle<PluginSummary>(
    IPC.plugins.marketplaceInstall,
    (request: PluginMarketplaceInstallRequest) =>
      deps.pluginMarketplace === undefined
        ? Promise.resolve(pluginsMissing<PluginSummary>())
        : deps.pluginMarketplace
            .install(request.pluginId, request.version)
            .then(ok, (error: unknown) => pluginError(error)),
  )
  handle<PluginUpdateInfo[]>(IPC.plugins.checkUpdates, () =>
    deps.pluginMarketplace === undefined
      ? pluginsMissing<PluginUpdateInfo[]>()
      : deps.pluginMarketplace.checkUpdates().then(ok, (error: unknown) => pluginError(error)),
  )
  handle<HotkeyStatus>(IPC.hotkey.status, () => ok(deps.hotkey.getStatus()))
  // 状态接口会按需重读桥接（缓存 15 秒，见 `STATUS_MAX_AGE_MS`）：因此是异步的
  handle<ClassIslandStatus>(IPC.classisland.status, () =>
    deps.classisland
      .status()
      .then(ok, (error: unknown) =>
        err('E_UNKNOWN', error instanceof Error ? error.message : String(error)),
      ),
  )
  handle<ClassIslandTestResult>(IPC.classisland.test, () =>
    deps.classisland
      .test()
      .then(ok, (error: unknown) =>
        err('E_NETWORK', error instanceof Error ? error.message : String(error)),
      ),
  )
  // 让 ClassIsland 弹提醒（docs/05 §3.4 v3）：与 `classisland:test` 同款 Result 口径，
  // 但**失败原因走 result.value.error**（`ok: false` 是通道的业务结果，例如插件不是 v3、
  // 命令通道关闭、等待回执超时），只有依赖注入缺失这类意外才落到 `E_UNKNOWN`。
  handle<ClassIslandNotifyResult>(IPC.classisland.notify, (request?: ClassIslandNotifyRequest) =>
    Promise.resolve(deps.classisland.notify(normalizeNotifyRequest(request))).then(
      ok,
      (error: unknown) => err('E_UNKNOWN', error instanceof Error ? error.message : String(error)),
    ),
  )
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

  handle<boolean>(
    IPC.proactive.resolveSensitiveTool,
    (confirmId: string, approved: boolean, always = false) =>
      ok(deps.proactive.resolve(confirmId, approved, always)),
  )

  // ───────────────────────── Agent 向用户提问（docs/06 §21） ─────────────────────────

  handle<boolean>(IPC.askUser.answer, (input: AskUserAnswerInput) =>
    ok(deps.askUser?.resolve(input) ?? false),
  )

  // ───────────────────────── Aurora Center（docs/12） ─────────────────────────

  handle<CenterConnectionStatus>(IPC.center.status, () =>
    ok(
      deps.center?.status() ?? {
        enabled: false,
        connected: false,
        serverUrl: '',
        displayName: '',
        state: 'disabled' as const,
      },
    ),
  )
  // 账号登录（docs/12 §7）：实现装配在 index.ts（需要 settings / netFetch / logger），
  // 这里只做转发；未装配时如实报错而不是静默失败。
  handle<CenterLoginResult>(
    IPC.center.login,
    (request: CenterLoginRequest) =>
      deps.center?.login(request) ??
      Promise.resolve(err('E_INVALID_STATE', 'Aurora Center 连接尚未装配')),
  )
  // 设备授权登录（docs/12 §4.3）：触发后立即回执（已打开浏览器并开始轮询），
  // 最终结果经 deps.center.onDeviceLoginResult 推送（见下方订阅）。
  handle<CenterDeviceLoginStarted>(
    IPC.center.deviceLogin,
    (request: CenterDeviceLoginRequest) =>
      deps.center?.deviceLogin(request) ??
      Promise.resolve(err('E_INVALID_STATE', 'Aurora Center 连接尚未装配')),
  )
  // 取消在途的设备授权轮询（幂等）：设置页关闭 / 重新发起时由渲染层调用
  handle<boolean>(
    IPC.center.deviceLoginCancel,
    () => deps.center?.deviceLoginCancel() ?? Promise.resolve(ok(true)),
  )
  handle<CenterOfficialModelCatalog | null>(IPC.center.modelServices, () =>
    ok(deps.center?.modelServices() ?? null),
  )
  handle<CenterOfficialModelCatalog | null>(IPC.center.refreshModelServices, async () => {
    if (deps.center === undefined) return ok(null)
    return ok(await deps.center.refreshModelServices())
  })

  // ───────────────────────── 自动化（docs/13 §9） ─────────────────────────

  // 未装配（精简场景）时如实报错（E_INVALID_STATE），而不是静默成功让界面空转。
  handle<AutomationListResult>(IPC.automation.list, async () => {
    if (deps.automation === undefined) return err('E_INVALID_STATE', '自动化引擎尚未装配')
    return ok(await deps.automation.list())
  })
  handle<AutomationDefinition>(IPC.automation.save, async (definition: unknown) => {
    if (deps.automation === undefined) {
      return err('E_INVALID_STATE', '自动化引擎尚未装配')
    }
    const result = await deps.automation.save(definition)
    if (!result.ok) return err('E_INVALID_ARGUMENT', result.error)
    return ok(result.definition)
  })
  handle<boolean>(IPC.automation.delete, async (request: { id: string }) => {
    if (deps.automation === undefined) return err('E_INVALID_STATE', '自动化引擎尚未装配')
    const id =
      typeof (request as { id?: unknown })?.['id'] === 'string'
        ? (request as { id: string }).id
        : ''
    const result = await deps.automation.delete(id)
    if (!result.ok) return err('E_INVALID_STATE', result.error ?? '删除失败')
    return ok(true)
  })
  handle<AutomationRun[]>(IPC.automation.history, async (request: unknown) => {
    if (deps.automation === undefined) return err('E_INVALID_STATE', '自动化引擎尚未装配')
    const query =
      typeof request === 'object' && request !== null ? (request as AutomationHistoryQuery) : {}
    return ok(await deps.automation.history(query))
  })
  handle<{ runId: string }>(IPC.automation.run, async (request: { id: string }) => {
    if (deps.automation === undefined) return err('E_INVALID_STATE', '自动化引擎尚未装配')
    const id =
      typeof (request as { id?: unknown })?.['id'] === 'string'
        ? (request as { id: string }).id
        : ''
    const result = await deps.automation.run(id)
    if (!result.ok) return err('E_INVALID_STATE', result.error)
    return ok({ runId: result.runId })
  })
  handle<AutomationCatalog>(IPC.automation.catalog, async () => {
    if (deps.automation === undefined) return err('E_INVALID_STATE', '自动化引擎尚未装配')
    return ok(deps.automation.catalog())
  })
  handle<WindowState>(IPC.automation.openWindow, async (request: unknown) => {
    const raw =
      typeof request === 'object' && request !== null
        ? (request as Record<string, unknown>)
        : ({} as Record<string, unknown>)
    const view = raw['view']
    const mode = raw['mode']
    if ((view !== 'history' && view !== 'editor') || (mode !== 'agent' && mode !== 'normal')) {
      return err('E_INVALID_ARGUMENT', '自动化窗口参数无效')
    }
    const automationId =
      view === 'editor' &&
      typeof raw['automationId'] === 'string' &&
      raw['automationId'].trim() !== ''
        ? raw['automationId'].trim()
        : undefined
    const normalized: AutomationWindowRequest = {
      requestId: randomUUID(),
      view,
      mode,
      ...(automationId === undefined ? {} : { automationId }),
    }
    return ok(
      await deps.windows.showWithPayload('automation', IPC.automation.windowRequest, normalized),
    )
  })

  // ───────────────────────── 文件自感知（docs/06 §26） ─────────────────────────

  handle(IPC.awareness.status, async () => {
    if (deps.awareness === undefined) return err('E_INVALID_STATE', '文件自感知尚未装配')
    return ok(deps.awareness.status())
  })
  handle(IPC.awareness.records, async (request: FileAwarenessListRequest = {}) => {
    if (deps.awareness === undefined) return ok([])
    return ok(deps.awareness.records(request.limit))
  })
  handle(IPC.awareness.notes, async (request: FileAwarenessListRequest = {}) => {
    if (deps.awareness === undefined) return ok([])
    return ok(deps.awareness.notes(request.limit))
  })
  handle<FileAwarenessNoteContent>(
    IPC.awareness.readNote,
    async (request: FileAwarenessNoteRequest) => {
      if (deps.awareness === undefined) return err('E_INVALID_STATE', '文件自感知尚未装配')
      const noteId = typeof request?.noteId === 'string' ? request.noteId.trim() : ''
      if (noteId === '') return err('E_INVALID_ARGUMENT', '缺少笔记 id')
      try {
        return ok(await deps.awareness.readNote(noteId))
      } catch (error) {
        return err('E_IO', error instanceof Error ? error.message : String(error))
      }
    },
  )
  handle<FileAwarenessNote>(
    IPC.awareness.setNoteExpiry,
    async (request: FileAwarenessSetNoteExpiryRequest) => {
      if (deps.awareness === undefined) return err('E_INVALID_STATE', '文件自感知尚未装配')
      const noteId = typeof request?.noteId === 'string' ? request.noteId.trim() : ''
      if (noteId === '') return err('E_INVALID_ARGUMENT', '缺少笔记 id')
      const expiry = parseFileAwarenessNoteExpiry(request?.expiry)
      if (expiry === undefined) return err('E_INVALID_ARGUMENT', '过期策略无效')
      try {
        return ok(deps.awareness.setNoteExpiry(noteId, expiry))
      } catch (error) {
        return err('E_IO', error instanceof Error ? error.message : String(error))
      }
    },
  )
  handle<boolean>(IPC.awareness.presentNote, async (request: FileAwarenessNoteRequest) => {
    if (deps.awareness === undefined) return err('E_INVALID_STATE', '文件自感知尚未装配')
    const noteId = typeof request?.noteId === 'string' ? request.noteId.trim() : ''
    if (noteId === '') return err('E_INVALID_ARGUMENT', '缺少笔记 id')
    deps.windows.show('memory')
    deps.windows.sendTo('memory', IPC.awareness.notePresented, { noteId })
    return ok(true)
  })
  handle<boolean>(IPC.awareness.analyzeNow, async (request: FileAwarenessAnalyzeRequest) => {
    if (deps.awareness === undefined) return err('E_INVALID_STATE', '文件自感知尚未装配')
    if (typeof request?.path !== 'string' || request.path.trim() === '') {
      return err('E_INVALID_ARGUMENT', '缺少文件路径')
    }
    return ok(await deps.awareness.analyzeNow(request.path))
  })
  handle<boolean>(IPC.awareness.ignore, async (request: FileAwarenessSuggestionAction) => {
    if (deps.awareness === undefined) return err('E_INVALID_STATE', '文件自感知尚未装配')
    if (typeof request?.suggestionId !== 'string') {
      return err('E_INVALID_ARGUMENT', '缺少建议 id')
    }
    return ok(deps.awareness.ignoreSuggestion(request.suggestionId))
  })
  handle<FileAwarenessExecution>(
    IPC.awareness.execute,
    (request: FileAwarenessSuggestionAction) => {
      if (deps.awareness === undefined) return err('E_INVALID_STATE', '文件自感知尚未装配')
      const awareness = deps.awareness
      return executeFileAwarenessSuggestion(
        typeof request?.suggestionId === 'string' ? request.suggestionId : '',
        {
          suggestion: (id) => awareness.suggestion(id),
          createSession: () => deps.sessions.createSession({ space: 'agent' }),
          // 先把空会话落盘，再允许主界面按 id 激活；否则 activate 会先于会话列表刷新，
          // 目标 id 在磁盘 / 列表里都不存在，界面会停在原会话或落到错误现场。
          persistSession: (sessionId) => deps.sessions.persistEmptySession(sessionId),
          presentSession: (sessionId) => {
            // 先打开并切主界面，再发送首条消息；事件即使早到也只会落进新会话历史，
            // remoteActivate 到达后渲染层会按同一 sessionId 水合出完整轮次。
            deps.windows.showChat()
            deps.windows.sendTo('chat', IPC.chat.remoteActivate, { sessionId })
          },
          send: (input) => deps.agent.send(input),
          removeSession: (sessionId) => deps.sessions.remove(sessionId),
        },
      )
    },
  )
  handle<string>(IPC.awareness.openKnowledge, async () => {
    const dir = deps.awareness?.knowledgeDir().trim() ?? ''
    if (dir === '') return err('E_INVALID_STATE', '尚未配置知识库目录')
    const error = await shell.openPath(dir)
    return error === '' ? ok(dir) : err('E_IO', error)
  })
  handle<string>(IPC.awareness.openNote, async (request: FileAwarenessNoteRequest) => {
    if (deps.awareness === undefined) return err('E_INVALID_STATE', '文件自感知尚未装配')
    try {
      return ok(await deps.awareness.openNote(request.noteId))
    } catch (error) {
      return err('E_UNKNOWN', error instanceof Error ? error.message : String(error))
    }
  })
  handle<string>(IPC.awareness.openSource, async (request: FileAwarenessNoteRequest) => {
    if (deps.awareness === undefined) return err('E_INVALID_STATE', '文件自感知尚未装配')
    try {
      return ok(await deps.awareness.openSource(request.noteId))
    } catch (error) {
      return err('E_UNKNOWN', error instanceof Error ? error.message : String(error))
    }
  })
  handle<boolean>(IPC.awareness.clearHistory, async () => {
    if (deps.awareness === undefined) return err('E_INVALID_STATE', '文件自感知尚未装配')
    deps.awareness.clearHistory()
    return ok(true)
  })
  handle<boolean>(IPC.awareness.reset, async () => {
    if (deps.awareness === undefined) return err('E_INVALID_STATE', '文件自感知尚未装配')
    try {
      await deps.awareness.resetAll()
      return ok(true)
    } catch (error) {
      return err('E_UNKNOWN', error instanceof Error ? error.message : String(error))
    }
  })
  handle<number>(IPC.awareness.scanNow, async () => {
    if (deps.awareness === undefined) return err('E_INVALID_STATE', '文件自感知尚未装配')
    return ok(await deps.awareness.scanNow())
  })

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
  // 对话事件是**逐 token** 到达的：这里不逐条直发，而是按约一帧的窗口合并后再广播
  //（一个 token = 一次广播 = 每个窗口一次渲染，100+ token/s 时渲染层直接被叫垮）。
  // 合并只作用于相邻的 text / reasoning；done / error / user-message 先 flush 再同步发，
  // 保证终态不会越过它前面的增量先到（见 event-buffer.ts 的语义说明）。
  const eventBuffer = createEventBuffer((event) => {
    const eventSessionId = event.type === 'job' ? event.job.sessionId : event.sessionId
    // 文件自感知会话只在设置页展示运行记录，不唤醒 chat / edge-bar。
    if (isFileAwarenessSession(eventSessionId)) return
    // 对话事件只有主界面订阅；提示条已移除快速对话，设置与引导也没有 useChat，
    // 不应被高密度流式 IPC 无谓唤醒。窗口不存在时 sendTo 会静默跳过。
    deps.windows.sendTo('chat', IPC.chat.event, event)
  })
  // 插件宿主事件（docs/14 §3.5）：助手正文按请求聚合到 done 再投递（逐 token 投递没有意义），
  // 工具结算即时投递。缓冲只在主进程内存、上限 16 KB / 64 个在途请求。
  const pluginAssistantText = new Map<string, { sessionId: string; text: string }>()
  const offAgent = deps.agent.onEvent((event) => {
    eventBuffer.push(event)
    if (deps.plugins === undefined) return
    if (event.type === 'text') {
      const key = `${event.sessionId}:${event.requestId}`
      const buffered = pluginAssistantText.get(key) ?? { sessionId: event.sessionId, text: '' }
      buffered.text = (buffered.text + event.delta).slice(0, PLUGIN_ASSISTANT_TEXT_MAX)
      pluginAssistantText.delete(key)
      pluginAssistantText.set(key, buffered)
      if (pluginAssistantText.size > 64) {
        const oldest = pluginAssistantText.keys().next()
        if (oldest.done !== true) pluginAssistantText.delete(oldest.value)
      }
      return
    }
    if (event.type === 'done' || event.type === 'error') {
      const key = `${event.sessionId}:${event.requestId}`
      const buffered = pluginAssistantText.get(key)
      pluginAssistantText.delete(key)
      if (event.type === 'done' && buffered !== undefined && buffered.text.trim() !== '') {
        void deps.plugins.deliverEvent('message.assistant', {
          sessionId: buffered.sessionId,
          text: buffered.text,
        })
      }
      return
    }
    if (event.type === 'tool' && event.call.state !== 'running') {
      void deps.plugins.deliverEvent('tool.after', {
        sessionId: event.sessionId,
        name: event.call.name,
        state: event.call.state,
        ...(event.call.outputSummary === undefined ? {} : { summary: event.call.outputSummary }),
      })
    }
  })
  const offClassification = deps.classification.onEvent((event) => {
    broadcast(IPC.classification.event, event)
  })
  const offSensitive = deps.proactive.onRequest((request) => {
    broadcast(IPC.proactive.sensitiveTool, request)
  })
  const offAskUser = deps.askUser?.onRequest((request) => {
    broadcast(IPC.askUser.request, request)
  })
  const offMcp = deps.onMcpStatusChanged((statuses) => {
    broadcast(IPC.mcp.statusChanged, statuses)
  })
  const offUpdate = deps.updater.onStateChanged((state) => {
    broadcast(IPC.update.stateChanged, state)
  })
  const offHotkey = deps.hotkey.onChange((status) => {
    broadcast(IPC.hotkey.changed, status)
  })
  // 设备授权登录的最终结果（docs/12 §4.3）：主进程轮询结束 / 拿到令牌后推给渲染层
  const offDeviceLogin =
    deps.center?.onDeviceLoginResult((result) => {
      broadcast(IPC.center.deviceLoginResult, result)
    }) ?? (() => {})
  const offModelServices =
    deps.center?.onModelServicesChanged((catalog) => {
      broadcast(IPC.center.modelServicesChanged, catalog)
    }) ?? (() => {})
  const offRuntimeNotice =
    deps.center?.onRuntimeNotice((notice: CenterRuntimeNotice) => {
      broadcast(IPC.center.runtimeNotice, notice)
    }) ?? (() => {})
  // 自动化定义 / 历史变化（docs/13 §9）：多窗口同步靠这两个推送重拉
  const offAutomationDefinitions =
    deps.automation?.onDefinitionsChanged(() => {
      broadcast(IPC.automation.changed, undefined)
    }) ?? (() => {})
  const offAutomationHistory =
    deps.automation?.onHistoryChanged(() => {
      broadcast(IPC.automation.historyChanged, undefined)
    }) ?? (() => {})
  const offAwareness =
    deps.awareness?.onChanged(() => {
      broadcast(IPC.awareness.changed, undefined)
    }) ?? (() => {})
  const offAwarenessSuggestion =
    deps.awareness?.onSuggestion((suggestion) => {
      deps.windows.sendTo('edge-bar', IPC.awareness.suggestion, suggestion)
    }) ?? (() => {})

  return () => {
    for (const [channel] of handlers) ipcMain.removeHandler(channel)
    offSettings?.()
    offModelServices()
    offRuntimeNotice()
    offModes()
    offWindows()
    offAgent()
    pluginAssistantText.clear()
    // 在途增量不再下发（窗口正在销毁 / 进程要退出）
    eventBuffer.dispose()
    offClassification()
    offSensitive()
    offAskUser?.()
    offMcp()
    offUpdate()
    offHotkey()
    offDeviceLogin()
    offAutomationDefinitions()
    offAutomationHistory()
    offAwareness()
    offAwarenessSuggestion()
  }
}

/**
 * 对话图片缩略（docs/06 §14，2026-10-04 性能轮）。
 *
 * `readDisplayImage` 回的是原图 data URL（单图上限 10MB）；列表缩略图只需要长边
 * `maxDimension` 像素，用 `nativeImage` 解码后重采样再转回 PNG data URL。
 * 任何解码 / 缩放失败都**原样放行**：宁可回一次大图，也不能让图片展示整体挂掉。
 */
function shrinkDisplayImage(
  result: ChatDisplayImageReadResult,
  maxDimension: number,
): ChatDisplayImageReadResult {
  if (maxDimension <= 0) return result
  try {
    const image = nativeImage.createFromDataURL(result.dataUrl)
    if (image.isEmpty()) return result
    const size = image.getSize()
    const longest = Math.max(size.width, size.height)
    if (longest <= maxDimension || longest === 0) return result
    const scale = maxDimension / longest
    const resized = image.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: 'good',
    })
    return { ...result, dataUrl: resized.toDataURL(), mime: 'image/png' }
  } catch {
    return result
  }
}

/** 粘贴图片预览图的长边（像素；`chat:stageImage` 随结果回传的那张）。 */
const PASTED_PREVIEW_MAX_DIMENSION = 96

/**
 * 粘贴图片的 96px 预览（`chat:stageImage`，2026-10-18）。
 *
 * 粘贴图可能超过 `PREVIEW_MAX_BYTES`（2 MiB），此时 `chat:readAttachment` 拿不到缩略图；
 * 这里在落盘时顺手缩一张随结果回传，保证「粘贴进去就看得见」。
 * 解码 / 缩放失败一律返回 `undefined`（结果里省略该字段）—— 预览只是锦上添花，
 * 不能因为某个格式 `nativeImage` 解不开就让整次粘贴失败。
 */
function buildPastedPreview(bytes: Buffer, mimeType: string): string | undefined {
  try {
    let image = nativeImage.createFromBuffer(bytes)
    if (image.isEmpty()) {
      image = nativeImage.createFromDataURL(`data:${mimeType};base64,${bytes.toString('base64')}`)
    }
    if (image.isEmpty()) return undefined
    const size = image.getSize()
    const longest = Math.max(size.width, size.height)
    if (longest === 0) return undefined
    const scale = Math.min(1, PASTED_PREVIEW_MAX_DIMENSION / longest)
    if (scale >= 1) return image.toDataURL()
    return image
      .resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: 'good',
      })
      .toDataURL()
  } catch {
    return undefined
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

/**
 * `applyPatch` 需要的最小依赖面。
 *
 * 抽出来是为了让「写配置的第二个调用方」——`tools/settings-port.ts`（AI 的 `set_setting`）——
 * 能拿到**同一个实现**（`applyPatch` 仍只在本文件内被真正读写），
 * 而不是自己 `settings.mutate()` 重写一套合并 / 凭据 / 广播逻辑。
 */
export type SettingsWriteDeps = Pick<
  DesktopDeps,
  'settings' | 'skills' | 'logger' | 'onSettingsChanged'
>

/** 把 `applyPatch` 绑成 `(patch) => Result<Settings>`，供 `set_setting` 端口复用。 */
export function createSettingsWriter(
  deps: SettingsWriteDeps,
): (patch: SettingsPatch) => Result<Settings> {
  return (patch) => applyPatch(deps as DesktopDeps, patch)
}

function applyPatch(deps: DesktopDeps, patch: SettingsPatch): Result<Settings> {
  // 凭据抽取与合并语义都在 `settings-patch.ts`（纯逻辑、有单测）：这里只负责
  // 校验失败的处理、凭据的加密落盘 / 清理，以及 `settings:changed` 广播。
  const { patch: cleaned, secrets } = extractPatchSecrets(patch)
  /** 需要清掉内存明文缓存的凭据路径（被删条目 / 只剩空占位的键），由合并逻辑给出 */
  let cleared: string[] = []

  // 合并必须在 `mutate` 的 mutator **内部**读取当前值。
  // `SettingsStore.mutate` 会把 mutator 收到的 draft 用 `update()` 再合并一次，
  // 若在 mutator 之外提前取快照，写入凭据（`setSecret` → `mutate`）时
  // 会被旧快照覆盖回 `apiKeyEnc: ''` —— 即"先存模型配置、再存 API Key"的
  // 设置页流程会静默丢掉凭据。
  const updated = deps.settings.mutate((draft) => {
    cleared = mergeSettingsPatch(draft, cleaned)
  })
  if (!updated) return err('E_INVALID_ARGUMENT', '配置校验失败：请检查填写内容')

  // 先清（被删条目 / 只剩空占位的旧明文缓存）再写（本次提交的明文凭据）：
  // 同一个 patch 里「删了又重建」时，以后写入的凭据为准。
  for (const path of cleared) deps.settings.clearSecret(path)
  for (const [path, value] of Object.entries(secrets)) {
    try {
      deps.settings.setSecret(path, value)
    } catch (error) {
      return err('E_INVALID_ARGUMENT', error instanceof Error ? error.message : String(error))
    }
  }

  if (patch.skills?.disabled) deps.skills.setDisabled(patch.skills.disabled)
  // 取 store 的最新快照：上面的 `clearSecret` 也会走一次 `mutate`，`updated` 可能已不是最新。
  const current = deps.settings.get()
  deps.onSettingsChanged?.(current)
  return ok(current)
}

/** 回传渲染层前把密文替换为"是否已设置"。 */
function toRendererSettings(deps: DesktopDeps): Settings {
  return redactSettingsForRenderer(deps, deps.settings.get())
}

/**
 * 密文 → "是否已设置"标记。
 * `settings:get` 与 `settings:changed` 广播共用，保证任何路径都不把
 * `apiKeyEnc` / `envEnc` / `headersEnc` 的值送进渲染进程（docs/08 §1.1）。
 */
function redactSettingsForRenderer(deps: DesktopDeps, source: Settings): Settings {
  return redactSettings(deps.settings, source)
}

/**
 * 读项目清单的运行时状态（v25，docs/06 §5.1）。
 *
 * 渲染层没有文件系统能力，而项目根失效必须有**可见**提示（不能只在日志里 warn），
 * 所以"根目录是否存在且是目录"由主进程逐项探测后回传；根不可读一律降级为
 * `rootAvailable: false`（不抛错、不影响对话）。相对 root 按进程 cwd 归一。
 */
async function projectStatus(deps: DesktopDeps): Promise<ProjectStatus> {
  const settings = deps.settings.get()
  const items: ProjectRuntimeStatus[] = []
  for (const entry of settings.projects.list) {
    const root = resolveProjectRootById(settings, entry.id, { cwd: process.cwd() })
    let rootAvailable = false
    if (root !== undefined) {
      try {
        rootAvailable = (await nodeFs.stat(root)).isDirectory()
      } catch {
        rootAvailable = false
      }
    }
    items.push({ id: entry.id, name: entry.name, root: root ?? '', rootAvailable })
  }
  return { items }
}

/**
 * 回滚一个文件到某份快照（v14，docs/06 §11.8）。
 *
 * 顺序是**有意**的：先把"现在的磁盘状态"存成一份 `origin:'rollback'` 的快照，再把旧内容写回 ——
 * 于是"回滚"本身也可撤回（用户点错了还能回到回滚前的样子）。
 *
 * `exists: false` 的快照表示"当时这个文件还不存在"，回滚它 = **删除该文件**（不是清空）。
 *
 * **路径确实过项目根边界**（P2-07 前这条只是注释里的承诺，实现没有）：写回前先过
 * `assertRestorablePath`（`tools/restore-guard.ts`）——`lstat` 拒绝符号链接 / junction +
 * 与 file-port 六个方法**同一个** `resolveWithin`（realpath 前缀校验）。守卫放在**留底之前**：
 * `capture` 会读一次目标内容，那一步本身就已经在跟随链接了。写回走 tmp + rename 原子写
 * （裸 `writeFile` 中途崩溃会留下半截文件，比没有回滚更糟）。
 */
export async function restoreSnapshot(
  deps: DesktopDeps,
  snapshots: SnapshotPort | undefined,
  request: SnapshotRestoreRequest,
): Promise<Result<SnapshotRef>> {
  if (snapshots === undefined) return err('E_INVALID_STATE', '快照端口尚未装配')
  const all = await snapshots.list({ limit: 500 })
  const target = all.find((item) => item.id === request.snapshotId)
  if (target === undefined) return err('E_NOT_FOUND', `未找到快照：${request.snapshotId}`)

  // ① 边界与符号链接守卫（越界 / 链接一律拒绝，且**什么都不做** —— 连留底都不做）
  let absolutePath: string
  try {
    absolutePath = await assertRestorablePath(target.path, {
      guard: deps.snapshotGuard,
      sessionId: target.sessionId,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (isPathOutsideError(error) || isRestorePathRejectedError(error)) {
      deps.logger.warn('已拒绝回滚快照：目标未通过路径守卫', {
        snapshotId: target.id,
        path: target.path,
        reason,
      })
      return err('E_INVALID_ARGUMENT', `回滚被拒绝：${reason}`)
    }
    return err('E_IO', `回滚失败：${reason}`)
  }

  // ② 回滚前状态留底（读不到内容时仍然记一条 exists:false）
  const before = await snapshots.capture({
    sessionId: target.sessionId,
    path: absolutePath,
    origin: 'rollback',
  })
  // ③ 写回旧内容
  try {
    if (!target.exists) {
      await nodeFs.rm(absolutePath, { force: true })
    } else {
      const content = await snapshots.readContent(target)
      if (content === undefined) return err('E_NOT_FOUND', '快照内容已丢失（可能被手动清理过）')
      await nodeFs.mkdir(dirname(absolutePath), { recursive: true })
      await writeRestoredFile(absolutePath, content.bytes)
    }
  } catch (error) {
    return err('E_IO', `回滚失败：${error instanceof Error ? error.message : String(error)}`)
  }
  deps.logger.info('已回滚文件快照', {
    snapshotId: target.id,
    path: absolutePath,
    rollbackSnapshotId: before.snapshot?.id ?? '',
  })
  // 回滚前那一份（`capture` 没留底时退回被回滚的那一份，保证调用方拿到一个 ref）
  return ok(before.snapshot ?? target)
}

/**
 * 续跑一条 `paused` 的 job（v15，docs/06 §4.1）。
 *
 * 这里**不自己跑循环**：把 `resumeJobId` 交给与「发送」同一条 `agent.send()` 通路，
 * 于是 `E_BUSY` / `E_NO_MODEL` / 事件顺序全都和用户在输入框里发一句话完全一致 ——
 * 另开一条"续跑专用"通路迟早会和主通路漂移。
 */
async function resumeJob(
  deps: DesktopDeps,
  jobs: JobStore | undefined,
  request: { sessionId: string; jobId: string },
): Promise<Result<{ requestId: string }>> {
  if (jobs === undefined) return err('E_INVALID_STATE', '任务存储尚未装配')
  const job = await jobs.get(request.jobId)
  if (job === undefined) return err('E_NOT_FOUND', `未找到任务：${request.jobId}`)
  if (job.sessionId !== request.sessionId) {
    return err('E_INVALID_ARGUMENT', '该任务不属于这个会话')
  }
  if (job.status !== 'paused') {
    return err('E_JOB_STATE', `任务当前状态是 ${job.status}，只有「已暂停」的任务可以继续`)
  }
  // 续跑不再重复落盘那条用户消息（job.text 就是原文；内核按 resumeJobId 走 appendUserMessage=false）
  const result = await deps.agent.send({
    sessionId: request.sessionId,
    text: job.text,
    origin: 'chat',
    resumeJobId: request.jobId,
  })
  return ok(result)
}

/**
 * 删除一条会话的持久化状态。
 *
 * 顺序固定为：running job guard → 清理 todo（含子代理）→ 删除 session。
 * 前一步失败时后续都不执行，调用方也不能广播 `chat:sessionDeleted`。
 */
export async function deleteSessionState(
  deps: DesktopDeps,
  sessionId: string,
): Promise<Result<boolean>> {
  const jobs = deps.jobs
  const busy =
    jobs === undefined
      ? false
      : await jobs
          .list({ sessionId, status: 'running' })
          .then((running) => running.length > 0)
          .catch(() => false)
  if (busy) {
    return err('E_INVALID_STATE', '会话有正在运行的任务，先取消或等它结束再删除')
  }
  try {
    await deps.todoCleanup?.removeSession(sessionId)
    await deps.sessions.remove(sessionId)
    return ok(true)
  } catch (error) {
    return err('E_UNKNOWN', error instanceof Error ? error.message : String(error))
  }
}

/** 取消一条未结束的 job：先 abort 正在跑的那条请求，再让 job 落 `aborted` */
async function cancelJob(
  deps: DesktopDeps,
  jobs: JobStore | undefined,
  request: { sessionId: string; jobId: string },
): Promise<Result<boolean>> {
  if (jobs === undefined) return err('E_INVALID_STATE', '任务存储尚未装配')
  const job = await jobs.get(request.jobId)
  if (job === undefined) return err('E_NOT_FOUND', `未找到任务：${request.jobId}`)
  if (job.status !== 'running' && job.status !== 'paused' && job.status !== 'queued') {
    return err('E_JOB_STATE', `任务已经结束（${job.status}），无需取消`)
  }
  if (job.status === 'running' && job.requestId !== undefined) {
    deps.agent.abort(job.requestId)
  }
  // 渲染层几毫秒后就会重新拉列表，所以这里等落盘完成再返回（避免"点了取消却还显示进行中"）
  await jobs.update(job.id, {
    status: 'aborted',
    pendingReason: 'aborted',
    updatedAt: new Date().toISOString(),
  })
  return ok(true)
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
    case 'workspace': {
      // 设置页「打开工作目录」按钮：与工具执行链走**同一个**回落
      //（激活模式工作目录 > agent.tools.workspaceDir > 用户主目录，docs/06 §5.1）——
      // 与不显式传 `cwd` 的命令落地目录一致。全局 `projects.current` 一级已于 v25 退役。
      // 解析逻辑抽在 `tools/workspace-target.ts`（纯函数、不 import electron，可单测）。
      target = resolveWorkspaceOpenTarget(settings, {
        homeDir: () => app.getPath('home'),
      })
      break
    }
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

function parseFileAwarenessNoteExpiry(value: unknown): FileAwarenessNoteExpiry | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record['mode'] === 'inherit') return { mode: 'inherit' }
  if (record['mode'] === 'never') return { mode: 'never' }
  if (record['mode'] !== 'at' || typeof record['at'] !== 'string') return undefined
  const at = record['at'].trim()
  if (at === '' || !Number.isFinite(Date.parse(at))) return undefined
  const preset = record['preset']
  return {
    mode: 'at',
    at: new Date(at).toISOString(),
    ...(preset === 'at24' || preset === 'at7' || preset === 'at30' || preset === 'manual'
      ? { preset }
      : {}),
  }
}

/** 相对路径按感知文件夹解析（docs/05 §2 ③ 的默认规则） */
export { resolveSubjectFolder } from './paths.js'

export type { AuroraApi }
