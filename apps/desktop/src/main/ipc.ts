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
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import {
  resolveProjectRootById,
  type JobStore,
  type SessionStore,
  type SnapshotPort,
} from '@aurora/agent-core'
import { resolveWorkspaceOpenTarget } from './tools/workspace-target.js'
import {
  buildAttachmentPreview,
  imageFallbackBlock,
  splitAttachments,
  type ImageReadPort,
} from './attachments.js'
import { isPathOutsideError, type WorkspaceGuardOptions } from './tools/file-port.js'
// 图片输入开关的**唯一判据**（docs/06 §3.1 / §25）：附件降级与图像工具门控共用同一份实现。
import { visionEnabled as resolveVisionEnabled } from './vision.js'
import {
  assertRestorablePath,
  isRestorePathRejectedError,
  writeRestoredFile,
} from './tools/restore-guard.js'
import {
  IPC,
  createDefaultSettings,
  err,
  ok,
  type AppInfo,
  type AskUserAnswerInput,
  type AuroraApi,
  type ChatArchiveRequest,
  type ChatAttachmentPreview,
  type ChatAttachmentPreviewRequest,
  type ChatHistoryRequest,
  type ChatMessageDto,
  type ChatSessionProjectRequest,
  type ChatSessionSummary,
  type CenterConnectionStatus,
  type CenterDeviceLoginRequest,
  type CenterDeviceLoginStarted,
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
} from './contracts.js'
import { resolveSubjectFolder } from './paths.js'
import { extractPatchSecrets, mergeSettingsPatch } from './settings-patch.js'
import { redactSettings } from './settings-redact.js'
import { createEventBuffer } from './event-buffer.js'

/** 附件正文入上下文的字符上限（超出截断，避免一个 PDF 吃掉整个上下文预算） */
const MAX_ATTACHMENT_CHARS = 8_000
/** 单条消息最多处理的附件数（图文合计；图片分片同样占这个额度） */
const MAX_ATTACHMENTS = 5

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
  /** 会话历史（chat:history 水合，docs/06 §4） */
  sessions: SessionStore
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
  /** Job 存储（chat:jobs / resumeJob / cancelJob，docs/06 §4.1，v15） */
  jobs?: JobStore
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
  onQuit: () => void
  onSettingsChanged?: (settings: Settings) => void
}

/** 单个附件提取结果（用文件名 + 截断正文入上下文） */
export interface AttachmentDigest {
  path: string
  fileName: string
  /** 提取到的文本（已截断）；无法提取时为 undefined */
  text?: string
  /** 提取失败 / 不支持时的原因（会一并告给模型，避免它假装读过） */
  note?: string
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
      const prepared = await prepareAttachments(deps, request.attachments)
      return await deps.agent
        .send({
          ...request,
          ...(prepared.extraContext === undefined ? {} : { extraContext: prepared.extraContext }),
          ...(prepared.images.length === 0 ? {} : { images: prepared.images }),
        })
        .then(ok, (error: unknown) =>
          err('E_UNKNOWN', error instanceof Error ? error.message : String(error)),
        )
    } catch (error) {
      return err('E_UNKNOWN', error instanceof Error ? error.message : String(error))
    }
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
    deps.sessions
      .summaries()
      .then(ok, (error: unknown) =>
        err('E_UNKNOWN', error instanceof Error ? error.message : String(error)),
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
  /**
   * 真删除会话（docs/08 会话管理页，`SessionStore.remove`）：删 `sessions/<id>.json`
   * + 清全部内存态，**不可逆** —— 渲染层负责两步确认，这里负责守卫：
   * 该会话还有 `running` 的 job（请求在跑或自动续轮中）时拒绝 `E_INVALID_STATE`（状态冲突）
   * （在跑的流随时会 append，删了会被下一轮写回来）；paused / 已结束的 job 随会话一起
   * 留在盘上无妨（会话没了它们也不可达，job 文件的 24h TTL 之外由会话删除兜底清理不在本轮范围）。
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
    const jobs = deps.jobs
    const guard =
      jobs === undefined
        ? Promise.resolve(false)
        : jobs
            .list({ sessionId, status: 'running' })
            .then((running) => running.length > 0)
            .catch(() => false)
    return guard.then((busy) => {
      if (busy) {
        return err('E_INVALID_STATE', '会话有正在运行的任务，先取消或等它结束再删除')
      }
      return deps.sessions.remove(sessionId).then(
        () => {
          // 广播在**删除成功之后**（失败/被守卫拒绝时不发，避免渲染层对着不存在的删除动作回落）
          broadcast(IPC.chat.sessionDeleted, { sessionId })
          return ok(true)
        },
        (error: unknown) =>
          err('E_UNKNOWN', error instanceof Error ? error.message : String(error)),
      )
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
    broadcast(IPC.chat.event, event)
  })
  const offAgent = deps.agent.onEvent((event) => {
    eventBuffer.push(event)
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
  // 自动化定义 / 历史变化（docs/13 §9）：多窗口同步靠这两个推送重拉
  const offAutomationDefinitions =
    deps.automation?.onDefinitionsChanged(() => {
      broadcast(IPC.automation.changed, undefined)
    }) ?? (() => {})
  const offAutomationHistory =
    deps.automation?.onHistoryChanged(() => {
      broadcast(IPC.automation.historyChanged, undefined)
    }) ?? (() => {})

  return () => {
    for (const [channel] of handlers) ipcMain.removeHandler(channel)
    offSettings?.()
    offModes()
    offWindows()
    offAgent()
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
  }
}

/** 广播到所有可见窗口（渲染层按需过滤）。 */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(channel, payload)
  }
}

/**
 * 把附件整理成「本轮要额外给模型看的内容」（docs/07 §2.3、docs/06 §3.1）。
 *
 * 分流规则：图片（`png / jpg / jpeg / webp / gif / bmp`）**不提取文本**，而是作为图片分片下发；
 * 其余文件走分类管线的 `extract.ts` 提取文本。两类可以同时存在于一轮消息里。
 *
 * 降级策略（一律**不阻断发送**）：
 * - 关闭了图片输入（当前模型的 `modelParams.<modelId>.vision` 为假）→ 图片写成一行「未读取」说明，
 *   请求体里不出现图片分片（对不支持视觉的模型发图片会被服务端 400）；
 * - 无法提取的文档 → 同样如实写明「内容未读取」，避免模型以为读过而编造。
 *
 * 返回的 `images` 是**路径**（读盘在内核的 `loadImages` 端口里发生，一处读、一处缓存），
 * 只有真正要下发时才是非空。
 */
async function prepareAttachments(
  deps: DesktopDeps,
  attachments: string[] | undefined,
): Promise<{ extraContext?: string; images: string[] }> {
  if (attachments === undefined || attachments.length === 0) return { images: [] }

  const targets = attachments.slice(0, MAX_ATTACHMENTS)
  if (attachments.length > MAX_ATTACHMENTS) {
    deps.logger.warn('附件数量超过上限，多余的已忽略', {
      provided: attachments.length,
      limit: MAX_ATTACHMENTS,
    })
  }

  const { images, documents } = splitAttachments(targets)
  const blocks: string[] = []

  // 图片：能力开关决定「下发」还是「降级成一行说明」
  const vision = visionEnabled(deps)
  for (const path of images) {
    if (!vision) {
      blocks.push(imageFallbackBlock(fileNameOf(path), '当前模型未开启图片输入'))
    }
  }

  // 文档：沿用既有提取链（officeparser / 纯文本读取器）
  const extract = deps.attachmentExtract
  if (documents.length > 0 && extract === undefined) {
    // 未装配提取能力（例如精简场景）：如实说明，不静默假装附件存在
    blocks.push(`【附件】${documents.length} 个文件未读取内容（当前环境未启用附件解析）`)
  } else if (extract !== undefined) {
    for (const path of documents) {
      try {
        const digest = await extract(path)
        if (digest === undefined) {
          blocks.push(`【附件】${fileNameOf(path)}：内容未读取（不支持的格式）`)
          continue
        }
        if (digest.text === undefined || digest.text.trim() === '') {
          blocks.push(
            `【附件】${digest.fileName}：内容未读取${digest.note === undefined ? '' : `（${digest.note}）`}`,
          )
          continue
        }
        blocks.push(
          [
            `【附件】${digest.fileName}`,
            digest.text.length > MAX_ATTACHMENT_CHARS
              ? `${digest.text.slice(0, MAX_ATTACHMENT_CHARS)}\n（内容过长，已截断）`
              : digest.text,
          ].join('\n'),
        )
      } catch (error) {
        deps.logger.warn('附件提取失败，按未读取处理', { path, error: String(error) })
        blocks.push(`【附件】${fileNameOf(path)}：内容未读取（提取失败）`)
      }
    }
  }

  return {
    ...(blocks.length === 0
      ? {}
      : {
          extraContext: [
            '以下是用户随消息一起发送的本地文件内容，仅供本次回复参考。',
            ...blocks,
          ].join('\n\n'),
        }),
    images: vision ? images : [],
  }
}

/**
 * 当前默认 provider 的**当前生效模型**是否开了**图片输入**（docs/06 §3.1）。
 *
 * 判据只有一处，实现搬到了 `main/vision.ts`：图像工具的门控（`tools/index.ts` 的
 * `registerImageTools`）用的是**同一个函数**，两边不会漂移。
 */
function visionEnabled(deps: DesktopDeps): boolean {
  return resolveVisionEnabled(deps.settings.get())
}

/** 从绝对路径取文件名（渲染层传来的路径可能含 Windows 反斜杠） */
function fileNameOf(path: string): string {
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1] ?? path
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

/** 相对路径按感知文件夹解析（docs/05 §2 ③ 的默认规则） */
export { resolveSubjectFolder } from './paths.js'

export type { AuroraApi }
