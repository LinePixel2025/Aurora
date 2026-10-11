/**
 * Aurora 主进程入口（docs/02 §1、§7）。
 *
 * 启动顺序：
 *  单实例锁 → 日志 → 配置（加密/迁移）→ 感知 → 窗口 → 模式装配 → IPC → 托盘
 *  → 首次引导判断（无可用模型配置则进入引导向导，否则显示服务窗与提示条）。
 */
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  promises as fs,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { hostname as osHostname, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  BrowserWindow,
  Notification,
  app,
  dialog,
  globalShortcut,
  nativeTheme,
  screen,
  session,
  shell,
  utilityProcess,
} from 'electron'
import {
  KernelAgentHost,
  SAFETY_RULES,
  SessionStore,
  SkillsBridge,
  ToolRegistry,
  VOLATILE_SECTION_TITLES,
  agentDesktopDir,
  createFileJobStore,
  createFileSnapshotPort,
  createProjectInstructionsSource,
  nodeProjectFs,
  type JobStore,
  type SnapshotPort,
  renderTodoList,
} from '@aurora/agent-core'
import type { AgentProviderFactory, SettingsToolPort, ToolDefinition } from '@aurora/agent-core'
import {
  COMPUTER_TOOL_NAMES,
  CENTER_OFFICIAL_PROVIDER_IDS,
  CENTER_SESSION_PREFIX,
  IPC,
  SettingsSchema,
  SettingsStore,
  nodeFileSystem,
  // 三档权限的生效档位（docs/06 §11.2）：确认判定与工具注册必须读同一个来源
  resolvePermissionMode,
  resolveModelParams,
  err,
  ok,
  type CenterConnectionStatus,
  type CenterDeviceLoginRequest,
  type CenterDeviceLoginResult,
  type CenterDeviceLoginStarted,
  type CenterOfficialModelCatalog,
  type CenterRuntimeNotice,
  type CenterLoginRequest,
  type CenterLoginResult,
  type CenterSessionHistoryMessage,
  type Result,
  type AutomationRun,
  type ClassIslandStatus,
  type ClassIslandTestResult,
  type Logger,
  type McpServerStatus,
  type ModeContext,
  type Settings,
  type SettingsPatch,
  type TokenUsage,
} from '@aurora/shared'
import {
  GuideRunner,
  ModeManager,
  createClassroomMode,
  createCodeMode,
  createWorkMode,
} from '@aurora/modes'
import { FileLogger } from './logger.js'
import { createSafeStorageCrypto } from './crypto.js'
import { WindowManager } from './window-manager.js'
import { PerceptionHub } from './perception.js'
import {
  DesktopAgentHost,
  createConfirmTool,
  createProviderFactory,
  type ConfirmToolDecision,
} from './agent-host.js'
import { McpController } from './mcp.js'
import { LlmTester } from './llm-tester.js'
import { llmSwitchRejection, withModelParams } from './llm-params.js'
import { TtsSynthesizer } from './tts.js'
import { createSttService } from './stt.js'
import { createImageGenService } from './imagegen.js'
import { SETTINGS_HINT } from './settings-hint.js'
// 图片附件读盘（多模态输入，docs/06 §3.1）：与渲染层预览同一套读法，上限不同
import { readImages } from './attachments.js'
import {
  registerIpc,
  createSettingsWriter,
  deleteSessionState,
  restoreSnapshot,
  type DesktopDeps,
} from './ipc.js'
import { TerminalService } from './terminal-service.js'
import { SessionTitleService } from './session-title.js'
import type { ProactiveLike, SettingsStoreLike } from './contracts.js'
import { isQuietHour, ProactiveScheduler } from './proactive.js'
import { EdgeBarScheduler } from './edge-bar-scheduler.js'
import { shouldShowAwarenessGlow } from './awareness-glow.js'
import { GameModeController, WindowsGameModeWatcher } from './game-mode.js'
import { HotkeyManager } from './hotkey.js'
import { SessionBridge, toConfirmRequest } from './center/session-bridge.js'
import { createAskRelay, createAskSettleRelay } from './center/ask-relay.js'
import { CenterConnector } from './center/connector.js'
import { DeviceLoginController, type DeviceLoginOutcome } from './center/device-login.js'
import { httpBaseUrlOf, requestClientLogin } from './center/client-login.js'
import { CenterModelServices } from './center/model-services.js'
import { resolveCapabilityRoute } from './center/service-routing.js'
import { uploadFileToCenter } from './center/ingest.js'
import { downloadFileFromCenter } from './center/deliver.js'
import {
  applyWhitelistedPaths,
  buildClientStatus,
  voiceReadiness,
} from './center/remote-control.js'
import { SkillsService } from './skills.js'
import { ClassIslandNotifier, ClassIslandProvider } from './classisland.js'
import { applyProxy, createNetFetch } from './net.js'
import { resolveScheduleProvider, type IScheduleProvider } from './schedule.js'
import { resolveSubjectFolder } from './paths.js'
import { AuroraFileWatcher } from './file-watcher.js'
import { ExtractPool, type ExtractWorkerChild } from './extract-pool.js'
import { OfficePool, type OfficeChildLike } from './office-pool.js'
import { SELF_AWARENESS_EVIDENCE_LIMIT_BYTES } from './extract.js'
import { ClassificationHistory } from './classification-history.js'
import { ClassificationService, type ClassifyProviderFactory } from './classification.js'
import { NotificationService } from './notifications.js'
import { createNodeOfficePort } from './tools/office-port.js'
import { UpdateService } from './updater.js'
import { createUpdaterPort } from './updater-port.js'
import { createTray, type TrayController } from './tray.js'
import { SMOKE_FLAG, SMOKE_RESULT_PREFIX, smokeScript } from './smoke.js'
import {
  BURST_REASONING_END_MARKER,
  BURST_REASONING_START_MARKER,
  BURST_TEXT_END_MARKER,
  BURST_TEXT_START_MARKER,
  REASONING_MARKER,
  SKILL_ONLY_MARKER,
  JOB_LOOP_MARKER,
  WRITE_FILE_CONTENT,
  WRITE_FILE_MARKER,
  STUB_API_KEY,
  STUB_MARKER,
  STUB_MODEL,
  startStubLlmServer,
  type StubChatRequestRecord,
  type StubLlmServer,
} from './smoke-llm.js'
import { EDGE_BAR_WIDTHS } from './edge-bar-geometry.js'
import {
  ASK_USER_CAPTURE_QUESTION,
  AWARENESS_GLOW_CAPTURE_CHECK,
  AWARENESS_GLOW_SETTLE_ACT,
  captureWindows,
  CHAT_AUTO_TITLE_CHECK,
  CHAT_TRACE_FOLD_CHECK,
  MEMORY_EXPIRE_ACT,
  MEMORY_EXPIRE_CHECK,
  MEMORY_WINDOW_CHECK,
  SETTINGS_AWARENESS_RECORDS_ACT,
  SETTINGS_AWARENESS_RECORDS_CHECK,
  chatStreamAct,
  chatAutoTitleAct,
  chatStreamBurstAct,
  chatStreamBurstCheck,
  chatStreamCheck,
  defaultCapturePlan,
  failedCaptureFiles,
  filterCapturePlan,
  nativeGlassCheck,
  parseCaptureTokens,
  registerAskUserSpawner,
  seedChatTtsHistory,
  seedMemoryFixture,
  seedJobFixture,
  seedClassIslandFixture,
  seedAutomationFixture,
  type CaptureTarget,
} from './capture.js'
import {
  registerAgentCoreTools,
  registerAutomationTools,
  registerAwarenessTools,
  registerCenterTools,
  registerClassIslandTools,
  registerComputerTools,
  registerExtensionTools,
  registerImageTools,
  registerSettingsTool,
  IMAGE_TOOL_NAMES,
  type AgentCoreToolsRegistry,
  type ClassIslandToolsRegistry,
  type ComputerTools,
  type ExtensionToolsRegistry,
  type ImageToolsRegistry,
  type SettingsToolRegistry,
} from './tools/index.js'
import { AutomationEngine } from './automation/engine.js'
import { AutomationStore } from './automation/store.js'
import { automationRunProfile } from './automation/run-profile.js'
import { ensureElevation, inspectElevatedUserData, disableRequireAdmin } from './elevation.js'
import type { AutomationActionPorts } from './automation/actions.js'
import { adaptForSubagent, createSessionProjectResolver } from './tools/session-project.js'
import { createFileTodoPort, type FileTodoPort } from './tools/todo-port.js'
// `ask_user` 的装配层实现（docs/06 §21）：卡片推送 + 等回执（3 分钟超时按"未回答"继续）
import { ASK_USER_TIMEOUT_MS, createAskUserService, type AskUserService } from './ask-user.js'
import { createNetWebFetchPort } from './tools/web-fetch.js'
import { createElectronClipboardImagePort, createElectronClipboardPort } from './tools/clipboard.js'
import { createNodeImageIo, createViewImagePort } from './tools/image-read-port.js'
import { OWNED_IMAGE_SUBDIRS } from './tools/image-read.js'
import { createScreenshotPort } from './tools/screenshot-port.js'
// 图片输入开关的**唯一判据**（docs/06 §3.1 / §25）：图像工具门控与附件降级共用同一份实现
import { visionEnabled } from './vision.js'
import { createNotificationPort } from './tools/notify.js'
import { createImageGenPort } from './tools/imagegen-port.js'
import { createImageDisplayPort } from './tools/image-display-port.js'
// 右栏成果展示（`show_preview`，docs/06 §14）：目标校验 + 推送到 chat 窗口
import { createPreviewPort } from './tools/preview-port.js'
import { createSettingsPort } from './tools/settings-port.js'
import { createCommandRunner } from './tools/command-runner.js'
import { createNodeFilePort } from './tools/file-port.js'
import { createShellOpenPort } from './tools/open-port.js'
import { FileAwarenessService } from './file-awareness.js'
import { FileAwarenessAnalyzer } from './file-awareness-agent.js'
import {
  FILE_AWARENESS_SESSION_PREFIX,
  fileAwarenessRunProfile,
  isFileAwarenessSession,
} from './file-awareness-run-profile.js'
import {
  fileAwarenessModelError,
  fileAwarenessModelOverride,
  hasExplicitFileAwarenessModel,
  resolveFileAwarenessModel,
} from './file-awareness-model.js'

const isDev = !app.isPackaged

/**
 * 自测模式（`AURORA_SMOKE=1`，仅开发态）。
 * 用来关闭有副作用的行为（如真的弹出资源管理器）并开放诊断回执。
 */
const smokeMode = isDev && process.env['AURORA_SMOKE'] === '1'

/** 自测诊断：课前提醒触发记录（最新在前） */
const preClassFired: Array<{
  subject: string
  minutesUntil: number
  targetDir: string
  opened: boolean
}> = []

/** 自测诊断：自动化运行记录（最新在前，v0.2.5 / docs/13 §13） */
const automationRunLog: AutomationRun[] = []

/**
 * 用户数据目录固定为 `%APPDATA%/Aurora`（docs/08 §2）。
 * 若不做这一步，Electron 会用 package.json 的 name（`@aurora/desktop`）作为目录名。
 */
app.setName('Aurora')

/**
 * 自测（AURORA_SMOKE=1）必须与开发者本机配置隔离：
 * 断言依赖"全新环境"（科目模板 9 科、classroom 未就绪、无历史会话），
 * 复用真实 userData 会被上一次运行的数据污染。这里改用临时目录，
 * 退出时由 `runSmokeTest` 删除；被强杀留下的目录由 `pruneSmokeWorkspaces` 兜底清理。
 */
/**
 * 自测（`AURORA_SMOKE=1`）与截图核对（`AURORA_CAPTURE=<目录>`）都必须与开发者本机配置隔离：
 * - 自测断言依赖"全新环境"（科目模板 9 科、classroom 未就绪、无历史会话）；
 * - 截图探针会**写真实配置**（切模式、翻 classroom 开关），不隔离就会改掉用户自己的设置。
 *
 * 两者都改用临时目录，退出时删除；被强杀留下的目录由 `pruneSmokeWorkspaces` 兜底清理。
 * 注意：`AURORA_CAPTURE` 单独使用（不带 `AURORA_SMOKE`）也要隔离 —— 这是默认行为，不是可选项。
 */
let smokeWorkspace: string | undefined
/**
 * 两次启动验证（v15，docs/06 §4.1）：把自测工作区**固定**到调用方给的目录，且退出时不删。
 *
 * 为什么需要它：`job` 的核心承诺是"**重启后**还能续跑"，而自测默认每次都用全新临时目录
 * （见上），跨进程的持久化根本无处验证。设了 `AURORA_SMOKE_WORKSPACE` 就复用它，
 * 于是「第一次启动跑到 paused → 退出 → 第二次启动接着跑完」成为可脚本化的两步。
 *
 * 只在 `AURORA_SMOKE=1` 下生效（`isolatedRun` 的判断已经把捕获模式算进来），
 * 且**只在开发态**（`app.isPackaged` 为假）—— 打包后的应用不会因为环境变量改 userData 位置。
 */
const pinnedSmokeWorkspace = ((): string | undefined => {
  if (app.isPackaged || process.env['AURORA_SMOKE'] !== '1') return undefined
  const value = (process.env['AURORA_SMOKE_WORKSPACE'] ?? '').trim()
  return value === '' ? undefined : value
})()
/**
 * 第二次启动的阶段标记：`resume` = 只跑"重启续跑"那一段断言（其余断言依赖全新环境，
 * 在同一个工作区上重跑必然失败 —— 那些断言的对象是"首次启动"的现场）。
 */
const smokePhase = (process.env['AURORA_SMOKE_PHASE'] ?? '').trim()
const isolatedRun =
  !app.isPackaged &&
  (process.env['AURORA_SMOKE'] === '1' || (process.env['AURORA_CAPTURE'] ?? '').trim() !== '')
if (isolatedRun) {
  smokeWorkspace =
    pinnedSmokeWorkspace ?? join(tmpdir(), `aurora-smoke-${process.pid}-${Date.now()}`)
  if (pinnedSmokeWorkspace === undefined) pruneSmokeWorkspaces()
  mkdirSync(smokeWorkspace, { recursive: true })
  app.setPath('userData', smokeWorkspace)
}

/** 清理 1 小时前的自测临时目录（正常退出会自行删除，这里只兜底强杀/崩溃）。 */
function pruneSmokeWorkspaces(): void {
  const root = tmpdir()
  const cutoff = Date.now() - 60 * 60 * 1000
  try {
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith('aurora-smoke-') || entry === 'aurora-smoke-logs') continue
      const target = join(root, entry)
      try {
        if (statSync(target).mtimeMs > cutoff) continue
        rmSync(target, { recursive: true, force: true })
      } catch {
        /* 单个目录清理失败不影响启动 */
      }
    }
  } catch {
    /* 临时目录不可读：忽略 */
  }
}

/**
 * 段级分片：`AURORA_SMOKE_ONLY=2.3,4` 只跑段号匹配的段（逗号分隔的子串，留空 = 全量）。
 *
 * 为什么按「段」切而不是按「条」：断言之间有状态依赖（2.2 设过项目、2.3 接着用），
 * 段内自带前置与收尾，段间互不残留 —— 逐条跳过会让后面的断言读到错的前置，那正是
 * 「夹具过期」那一族假 FAIL 的成因。未命中的段**整段不执行**（副作用一起跳过），
 * 所以单独跑一段时也不会白等 2.3 段里那两个确认卡的 60s 超时。
 *
 * 它只用来把「改一行 → 等三分钟」压成「改一行 → 等十几秒」；
 * 提交前的验收仍然跑全量（留空即全量，行为与引入本开关前逐字一致）。
 */
const smokeOnlyTokens = (process.env['AURORA_SMOKE_ONLY'] ?? '')
  .split(',')
  .map((token) => token.trim())
  .filter((token) => token !== '')

/** 该段是否在本轮分片范围内（留空 = 全选）。 */
function smokeSection(section: string): boolean {
  return smokeOnlyTokens.length === 0 || smokeOnlyTokens.some((token) => section.includes(token))
}

/**
 * 截图运行强制的主题档位（`AURORA_CAPTURE_THEME=dark|light`，docs/07 §5.3）。
 *
 * 只在「开发态 + 设了 `AURORA_CAPTURE`」时非空。它的优先级**高于** `appearance.theme`：
 * 两档主题截图基线不能被用户设置顶掉（设置里若是 `deep` 档，探针会全红而不是"跟着设置走"）。
 * 因此这里存的是**运行期独占标记**，`syncAppearance()` 见到它就整个跳过。
 */
let captureThemeOverride: 'dark' | 'light' | undefined
let logger: FileLogger | undefined
let settings: SettingsStore | undefined
let windows: WindowManager | undefined
let perception: PerceptionHub | undefined
let tray: TrayController | undefined
let agent: DesktopAgentHost | undefined
let sessions: SessionStore | undefined
let mcp: McpController | undefined
let updater: UpdateService | undefined
/** 分类管线（docs/05 §3）：监听 → 队列 → 提取 → 判定 → 落盘 → 通知 */
let classification: ClassificationService | undefined
let fileWatcher: AuroraFileWatcher | undefined
let extractPool: ExtractPool | undefined
/** 文件自感知独立提取池，避免与 ClassRoom 分类互相排队饿死（docs/06 §26）。 */
let awarenessExtractPool: ExtractPool | undefined
let fileAwareness: FileAwarenessService | undefined
let fileAwarenessAnalyzer: FileAwarenessAnalyzer | undefined
let agentActivityDetach: (() => void) | undefined
const activeAgentRequests = new Set<string>()
let notifications: NotificationService | undefined
let proactiveScheduler: ProactiveScheduler | undefined
// 自动化引擎（docs/13）：定义与历史存 `<userData>/automations/`，内置课前提醒由引擎承接
let automationStore: AutomationStore | undefined
let automationEngine: AutomationEngine | undefined
let automationTools: { sync(): string[] } | undefined
let awarenessTools: { sync(): string[] } | undefined
const automationDefinitionListeners = new Set<() => void>()
const automationHistoryListeners = new Set<() => void>()
let edgeBarScheduler: EdgeBarScheduler | undefined
let awarenessGlowHideTimer: ReturnType<typeof setTimeout> | undefined
/** Windows 游戏模式联动（docs/06 §8.3） */
let gameMode: GameModeController | undefined
let hotkeys: HotkeyManager | undefined
let skillsService: SkillsService | undefined
/** 当前生效的出网 fetch（按代理设置重建） */
let netFetch: typeof fetch | undefined
/** ClassIsland 桥接 provider（配置里选 classisland 且已填端点时才有值） */
let classIslandProvider: ClassIslandProvider | undefined
/** ClassIsland 提醒通道（v3，docs/05 §3.4）：进程内单例，状态经 `classisland:status` 回显 */
let classIslandNotifier: ClassIslandNotifier | undefined
/** 构造当前 provider 用的配置签名（变化时重建） */
let classIslandSignature = ''
let disposeIpc: (() => void) | undefined
/** PTY 终端服务（terminal:*，docs/07 §2.3）：每窗口一个常驻 shell，退出前统一 kill */
let terminalService: TerminalService | undefined
/** 工具表与电脑操控装配器提到模块级：`runSmokeTest` 要在真实进程里断言它们（docs/06 §11） */
let tools: ToolRegistry | undefined
/**
 * 三档权限的确认判定（v13，docs/06 §11.2）：同样提到模块级 ——
 * `runSmokeTest` 要拿**注入内核的那个实例**断言「auto 档完全权限 / confirm 档仍走确认」，
 * 另建一个 `createConfirmTool` 只会自证一个与生产无关的副本。
 */
let confirmTool: ConfirmToolDecision | undefined

// ───────── 写前快照（docs/06 §11.8，v14）─────────

/** 快照根目录（bootstrap 时设为 `<userData>/backups`） */
let snapshotDir = ''
let snapshotPort: SnapshotPort | undefined
/** 上次构造端口时的配置指纹：变了就换实例（让设置页改保留份数立刻生效） */
let snapshotConfigKey = ''
/**
 * 交给 `createNodeFilePort` 的**稳定代理**：file-port 在 `syncToolRegistries()` 里会被重建，
 * 但它手里的这个对象始终有效 —— 内部按需把调用转给当前的 `snapshotPort`。
 *
 * ⚠️ 必须**在模块作用域就初始化**（不能等 bootstrap 里赋值）：`registerComputerTools` 的调用点
 * 早于快照端口那段装配，晚赋值会让 file-port 拿到 `undefined` —— 症状是"写文件从不留底、
 * 却一条报错都没有"，是最难排查的一类静默失效。
 */
const filePortSnapshots: Pick<SnapshotPort, 'capture'> = {
  capture: (input) => ensureSnapshotPort().capture(input),
}
/**
 * IPC 依赖面（bootstrap 里装配）：自测要调**与界面同一条**回滚链路
 * （`restoreSnapshot` 是 ipc.ts 导出的那个函数），另写一份就只是自证副本。
 */
let desktopDeps: DesktopDeps | undefined
/** Job 存储（docs/06 §4.1，v15）：bootstrap 里装配到 <userData>/jobs */
let jobStore: JobStore | undefined
/**
 * `ask_user` 的提问服务（docs/06 §21）：bootstrap 里装配，同时作为
 * 内核端口（`ask`）与 ipc 依赖（`resolve` / `onRequest`）—— 两处**必须同一个实例**，
 * 否则回执会送到一个没有 pending 提问的服务上（表现是"点了提交没反应"，静默超时）。
 */
let askUserService: AskUserService | undefined

/**
 * 在途提问的原文（本轮，docs/12 §5）：`ask.settled` 只带 requestId / 作答 / 结算原因，
 * 而 Center 的提问留痕需要问题本身 —— 提问推出去时先在这记一份、结算时取用并删除。
 * 只记 `center-` 会话的（本地会话的提问卡是瞬时卡片，不落 sidecar）。
 */
const askQuestionText = new Map<
  string,
  {
    question: string
    header?: string
    options?: { label: string; description?: string }[]
    multiSelect: boolean
    createdAt: string
  }
>()

function createSnapshotPortFor(config: Settings['agent']['snapshots']): SnapshotPort {
  return createFileSnapshotPort({
    dir: snapshotDir,
    fs: nodeFileSystem,
    ...(logger === undefined ? {} : { logger: logger.child('snapshots') }),
    keepPerFile: config.keepPerFile,
    maxSnapshotBytes: config.maxSnapshotBytes,
    totalBudgetBytes: config.totalBudgetBytes,
    enabled: config.enabled,
    /**
     * 必须用 **lstat**（不跟随符号链接）：指向文件的软链若被当成普通文件，
     * 快照存的就变成链接目标的**内容**，而回滚会把内容写回链接路径（把链接变成普通文件）——
     * 那是静默的类型篡改。lstat 下软链不是普通文件，快照端口会按 `unreadable` 跳过。
     */
    stat: async (path: string) => {
      const info = await fs.lstat(path)
      return { isFile: info.isFile(), isDirectory: info.isDirectory(), size: info.size }
    },
  })
}

/**
 * 取当前配置对应的快照端口：配置指纹没变就复用，变了就换一个新实例。
 *
 * 旧实例在换掉之前先 `flush()`（best-effort）：索引是 300ms 防抖写的，
 * 直接丢弃实例会把刚写的几条快照留在磁盘上、却不在索引里（变成孤儿文件）。
 */
function ensureSnapshotPort(): SnapshotPort {
  const config = settings!.get().agent.snapshots
  const key = [
    config.enabled,
    config.keepPerFile,
    config.maxSnapshotBytes,
    config.totalBudgetBytes,
  ].join('|')
  if (snapshotPort === undefined) {
    snapshotConfigKey = key
    snapshotPort = createSnapshotPortFor(config)
    return snapshotPort
  }
  if (key === snapshotConfigKey) return snapshotPort
  const previous = snapshotPort
  void previous.flush().catch(() => undefined)
  snapshotConfigKey = key
  snapshotPort = createSnapshotPortFor(config)
  return snapshotPort
}

function ensureOfficePool(): OfficePool {
  officePool ??= new OfficePool({
    fork: () =>
      utilityProcess.fork(join(__dirname, 'office-worker.js'), [], {
        serviceName: 'aurora-office',
        env: {
          ...process.env,
          AURORA_OFFICECLI_PATH: resolveOfficeCliPath(),
          OFFICECLI_SKIP_UPDATE: '1',
          OFFICECLI_NO_AUTO_INSTALL: '1',
          OFFICECLI_NO_AUTO_RESIDENT: '1',
        },
      }) as unknown as OfficeChildLike,
    ...(logger === undefined ? {} : { logger: logger.child('office-worker') }),
  })
  return officePool
}

function resolveOfficeCliPath(): string {
  const override = process.env['AURORA_OFFICECLI_PATH']
  if (override !== undefined && override.trim() !== '') return override
  return app.isPackaged
    ? join(process.resourcesPath, 'officecli', 'officecli.exe')
    : join(app.getAppPath(), 'resources', 'officecli', 'officecli.exe')
}

function officeCliAvailable(): boolean {
  const binary = resolveOfficeCliPath()
  if (!existsSync(binary)) return false
  try {
    const version = readFileSync(join(binary, '..', 'VERSION.txt'), 'utf8')
    return version.includes('version=1.0.153')
  } catch {
    return false
  }
}

let computerTools: ComputerTools | undefined
/** Office worker 池：懒启动；超时 / 崩溃后下一次请求重建。 */
let officePool: OfficePool | undefined
/** `set_setting` 装配器（docs/06 §12）：与电脑操控工具分开注册，互不摘除 */
let settingsTool: SettingsToolRegistry | undefined
/** `classisland_remind` 装配器（docs/05 §3.4 v3）：按桥接可用性注册 / 摘除 */
let classIslandTools: ClassIslandToolsRegistry | undefined
// Aurora Center（docs/12）：连接器 / 会话桥 / 工具表
let centerConnector: CenterConnector | undefined
let centerModelServices: CenterModelServices | undefined
let sessionBridge: SessionBridge | undefined
let centerTools: { sync(): string[] } | undefined
/**
 * center- 会话确认卡 → Center 网页端的下发通道（docs/12 §5.1）。
 * 连接器 open 后由 bindSessionEmit 绑定（与 SessionBridge 共用同一个发送函数），断开时置 undefined。
 */
let centerConfirmEmit: ((message: unknown) => void) | undefined
/** 设备授权登录控制器（docs/12 §4.3）：懒创建，整个生命周期复用（start 自带取消旧轮询） */
let deviceLoginController: DeviceLoginController | undefined
/** 本次设备授权使用的服务器地址（approved 后按它落库 center.serverUrl） */
let deviceLoginServerUrl = ''
/** 设备授权登录最终结果的渲染层订阅（center:deviceLoginResult 推送） */
const deviceLoginListeners = new Set<(result: CenterDeviceLoginResult) => void>()
const centerModelServicesListeners = new Set<(catalog: CenterOfficialModelCatalog | null) => void>()
const centerRuntimeNoticeListeners = new Set<(notice: CenterRuntimeNotice) => void>()
const centerFallbackNoticeKeys = new Set<string>()

function emitCenterRuntimeNotice(notice: CenterRuntimeNotice): void {
  for (const listener of centerRuntimeNoticeListeners) listener(notice)
}

function emitOfficialFallback(capability: 'llm' | 'imagegen' | 'tts' | 'stt', label: string): void {
  const key = `global:${capability}`
  if (centerFallbackNoticeKeys.has(key)) return
  centerFallbackNoticeKeys.add(key)
  emitCenterRuntimeNotice({
    capability,
    message: `Aurora Center 官方${label}模型不可用，已回落到本机模型`,
    at: new Date().toISOString(),
  })
}

function createCenterAwareSettingsStore(base: SettingsStoreLike): SettingsStoreLike {
  const reservedSecretOf = (path: string): string | undefined => {
    for (const capability of ['tts', 'stt', 'imagegen'] as const) {
      const providerId = CENTER_OFFICIAL_PROVIDER_IDS[capability]
      if (
        path === `${capability}.providers.${providerId}.apiKey` ||
        path === `${capability}.providers.${providerId}.apiKeyEnc`
      ) {
        return base.getSecret('center.token')
      }
    }
    return undefined
  }
  const noticeFallback = (capability: 'llm' | 'tts' | 'stt' | 'imagegen'): void => {
    const key = `global:${capability}`
    if (centerFallbackNoticeKeys.has(key)) return
    centerFallbackNoticeKeys.add(key)
    const label =
      capability === 'llm'
        ? '语言'
        : capability === 'tts'
          ? '语音合成'
          : capability === 'stt'
            ? '语音识别'
            : '图像生成'
    emitCenterRuntimeNotice({
      capability,
      message: `Aurora Center 官方${label}模型不可用，已回落到本机模型`,
      at: new Date().toISOString(),
    })
  }
  const applyOfficialSelection = (next: Settings): Settings => {
    for (const capability of ['llm', 'tts', 'stt', 'imagegen'] as const) {
      const selection = next.center.officialModels[capability]
      if (!selection.enabled) continue
      const providerId = CENTER_OFFICIAL_PROVIDER_IDS[capability]
      const available =
        centerModelServices?.service(capability) !== undefined &&
        next[capability].providers[providerId] !== undefined
      if (available) {
        if (capability === 'llm') next.llm.active = providerId
        else next[capability].enabled = true
      } else {
        noticeFallback(capability)
      }
    }
    return next
  }
  return {
    get: () => applyOfficialSelection(base.get()),
    getSecret(path) {
      return reservedSecretOf(path) ?? base.getSecret(path)
    },
    setSecret(path, plain) {
      if (reservedSecretOf(path) !== undefined) return false
      return base.setSecret(path, plain)
    },
    clearSecret(path) {
      if (reservedSecretOf(path) !== undefined) return
      base.clearSecret(path)
    },
    mutate(mutator) {
      return base.mutate(mutator)
    },
    update(patch) {
      return base.update(patch)
    },
    isCryptoAvailable: () => base.isCryptoAvailable(),
    needsOnboarding: () => base.needsOnboarding(),
    exportRedacted: () => applyOfficialSelection(base.exportRedacted()),
    flush: () => base.flush(),
    onChange: (listener) => base.onChange(listener),
  }
}
/** 扩展工具七件套装配器（docs/06 §14）：与 set_setting 同级，不受 agent.tools.enabled 门控 */
let extensionTools: ExtensionToolsRegistry | undefined
let imageDisplayPort: ReturnType<typeof createImageDisplayPort> | undefined
/**
 * 图像工具装配器（看图 / 截屏 / 读剪贴板图片，docs/06 §25）：**按模型能力注册** ——
 * 当前生效模型没开图片输入时一个都不注册（判据与附件管线同源，见 `vision.ts`）。
 */
let imageTools: ImageToolsRegistry | undefined
/** Agent 内核自带工具装配器（todo / task，docs/06 §18/§19）：同样不受门控 */
let agentCoreTools: AgentCoreToolsRegistry | undefined
/** 任务清单端口（docs/06 §18）：`<userData>/todos/<sessionId>.json`，退出前 flush */
let todoPort: FileTodoPort | undefined
/** MCP 状态订阅（IPC 层与主进程内部共用，避免为状态再引入一次事件总线） */
const mcpStatusListeners = new Set<(statuses: McpServerStatus[]) => void>()

/**
 * 退出收尾是否已经跑起来（P1-12）。
 *
 * `before-quit` 会在一次退出里被**触发多次**（我们自己在 `finally` 里补发的 `app.quit()`、
 * 以及收尾期间用户再点一次「退出」）。收尾只能跑一遍，而**收尾进行中的那次退出必须继续挡住**
 * —— 否则重复的退出请求会让进程在 flush 落盘之前就退掉，正是 P1-12 要防的截断。
 */
let shuttingDown = false
/**
 * 收尾已完成、由我们主动补发 `app.quit()`（P1-12）。
 *
 * 这是 `before-quit` 里**唯一**放行退出的分支：没有它，补发的 `app.quit()` 会被自己的
 * `preventDefault()` 再次挡下 —— 收尾跑完进程也退不出去（半关停僵尸的另一种形态）。
 */
let quitAllowed = false

/** 单实例：二次启动聚焦并唤起交互窗（docs/02 §2.1） */
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    windows?.showChat()
    windows?.focus('chat')
  })

  app.setAppUserModelId('com.aurora.desktop')

  app.whenReady().then(() => {
    void bootstrap().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      logger?.error('启动失败', { error: message })
      dialog.showErrorBox('Aurora 启动失败', message)
      app.quit()
    })
  })

  app.on('window-all-closed', () => {
    // 常驻托盘：窗口全部关闭不退出（docs/02 §7）
  })

  /**
   * 退出协议：**先挡住退出、收完再退**（P1-12，docs/02 §2.2）。
   *
   * 为什么不能是 `void shutdown()` 就走：Electron 的退出序列是
   * `before-quit → 逐窗 close → will-quit → quit`，任一窗口在 `close` 里 `preventDefault()`
   * 会**取消整次退出**；而 `shutdown()` 的第一个 `await` 就挂起了，各窗口的 `close` 会在
   * `quitting` 仍为 false 时到达 → 退出被取消、且**没有任何代码再调 `app.quit()`**：
   * 进程活着、托盘没了、窗口全隐藏、IPC 全失效、单实例锁仍被占（只能任务管理器杀）。
   * 即便时序侥幸，收尾（分类 drain 可等数秒 → 各 store flush）也会与退出序列并行竞速，
   * 最近几百毫秒的写入可能不落盘 —— 正是"退出前 flush"要防的事。
   *
   * 因此这里：
   * ① 同步 `prepareQuit()` 置位 `quitting`（各窗口 close 守卫据此放行，不再 preventDefault）；
   * ② `preventDefault()` 挡下本次退出（**同步**，不给窗口 close 任何插队机会）；
   * ③ 收尾跑完（`.finally`）再补发一次 `app.quit()`。
   *
   * ⚠️ 自动更新 `quitAndInstall` 与托盘退出**走同一个 before-quit**（electron-updater 的
   * `BaseUpdater.quitAndInstall` 只是 `setImmediate(() => app.quit())`，安装器已在此之前
   * spawn，且它只要求"应用最终退出"、不要求单次 quit 立即生效），所以本条对更新流程同样成立：
   * preventDefault 不会卡死安装，`finally` 一定会补上那一次 quit。
   */
  app.on('before-quit', (event) => {
    // 收尾完成后的那次 app.quit()：放行（这条分支之外一律不放行）
    if (quitAllowed) return
    // 收尾进行中：重复的退出请求继续挡住，绝不打断落盘
    if (shuttingDown) {
      event.preventDefault()
      return
    }
    shuttingDown = true
    // ① 先同步放行各窗口的 close 守卫（顺序不能与 ② 互换：中间任何一次 await 都会让
    //    窗口 close 在 quitting 仍为 false 时到达）
    windows?.prepareQuit()
    // ② 挡下本次退出
    event.preventDefault()
    // ③ 收完再退：`shutdown()` 内部逐段 catch，外面再兜一层，**保证 finally 无条件到达**
    //    （否则一次抛错就把进程永远留在"半关停"状态）
    void shutdown()
      .catch((error: unknown) => {
        logger?.error('退出收尾失败', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => {
        quitAllowed = true
        app.quit()
      })
  })
}

async function bootstrap(): Promise<void> {
  // 仅开发截图运行可强制主题；其余启动始终回到系统外观，且在建窗前生效。
  // 值两侧留空格也照收（`.trim()`）：否则 `AURORA_CAPTURE_THEME='dark '` 会静默回落 system，
  // 而 report.json 的 requestedTheme 又记着 `dark`，两边口径对不上（审查提出过）。
  const captureTheme =
    isDev && (process.env['AURORA_CAPTURE'] ?? '').trim() !== ''
      ? (process.env['AURORA_CAPTURE_THEME'] ?? '').trim()
      : undefined
  // 三档外观（v32）：截图运行由环境变量独占；其余启动由 `appearance.theme` 决定，
  // 这里先把「运行期独占标记」定下来，`syncAppearance()` 之后每次都要看它一眼（见该函数注释）。
  captureThemeOverride =
    captureTheme === 'dark' || captureTheme === 'light' ? captureTheme : undefined
  nativeTheme.themeSource = captureThemeOverride ?? 'system'

  // 1. 日志。自测的 userData 是临时目录且退出即删，因此自测日志写到固定位置，
  //    方便 `Get-Content "$env:TEMP\aurora-smoke-logs\aurora-*.log"` 查看断言结果。
  const userData = app.getPath('userData')
  const logsDir =
    smokeWorkspace === undefined ? join(userData, 'logs') : join(tmpdir(), 'aurora-smoke-logs')
  // 日志级别取自设置（docs/08 §6）：启动时读一次，之后由设置变更热更新。
  // 设置还没加载完，因此先用兜底值；第 2 步读完配置后立即同步（见 syncAdvanced）。
  logger = new FileLogger({ dir: logsDir, level: 'info', console: isDev })
  logger.info('Aurora 启动', {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    isDev,
    userData,
  })

  // 1.1 渲染层 CSP（docs/06 §10）。开发环境需放宽以允许 Vite dev server 的
  //     inline 预置脚本与 HMR websocket；生产环境只加载本地打包资源。
  //     放行 `blob:` 是 TTS 朗读的硬前提（docs/06 §13）：合成音频走 Blob 对象 URL，
  //     生产 CSP 的 `default-src 'self'` 会把它拦掉 —— 表现为「开发能播、打包不能播」。
  //     `font-src` 显式声明（P2 公式）：KaTeX 的字体随 bundle 本地化，file:// 下
  //     `'self'` 的匹配行为各浏览器有差异，写死 `'self' data:` 消除打包态隐患。
  //     两态各一条指令，缺任何一条都会让对应环境静音。
  const csp = isDev
    ? [
        "default-src 'self' data: blob: http://localhost:5173 ws://localhost:5173",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:5173",
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self' http://localhost:5173 ws://localhost:5173",
        "img-src 'self' data:",
        "media-src 'self' blob: data:",
        "font-src 'self' data: http://localhost:5173",
      ].join('; ')
    : [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "media-src 'self' blob:",
        "connect-src 'self'",
        "font-src 'self' data:",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; ')

  /**
   * 只给 **Aurora 自己的窗口页面**注入 CSP（2026-10-03 修复）。
   *
   * 此前无条件注入每条响应 —— 包括右栏内置浏览器（`webview`）里加载的外部页面：
   * 那些页面被强加了 `default-src 'self'; script-src 'self'`（相对于**它自己的**源），
   * 于是内联脚本、CDN 脚本、外域样式/图片全被 Chromium 拒绝，页面白屏或半残
   * （最小复现：`webview` 加载带内联脚本 + 外域脚本的本地页，实测两条都被拒）。
   *
   * 判据用 `webContentsId` 归属而不是 URL 前缀：guest 是独立 webContents，
   * 不在 `BrowserWindow.getAllWindows()` 里 —— 与协议 / 端口 / 开发态 URL 形态无关，
   * `file://` 预览页同样按"不是自家窗口"跳过。webview 里**没有** CSP 是正确语义：
   * 外域页面本该由它自己的 CSP 约束，不是由 Aurora 的。
   */
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const isOwnWindow = BrowserWindow.getAllWindows().some(
      (win) => !win.isDestroyed() && win.webContents.id === details.webContentsId,
    )
    callback({
      responseHeaders: isOwnWindow
        ? { ...details.responseHeaders, 'Content-Security-Policy': [csp] }
        : { ...details.responseHeaders },
    })
  })

  // 1.2 权限请求（Design/betav2-spec.md §8.6）：只显式放行**自身窗口**的 `media`
  //     （麦克风，STT 录音依赖 getUserMedia），其余权限维持 Electron / Chromium 的
  //     默认语义（callback(true) = 与没有 handler 时的现状一致，不额外收窄）。
  //     保守取舍的理由：此前从未注册过权限 handler，所有请求都走默认路径；
  //     这里如果改成「未列出一律拒绝」，会静默改变若干内嵌页面的行为（最难排查的一类回归）。
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      const isOwnWindow = BrowserWindow.getAllWindows().some(
        (win) => !win.isDestroyed() && win.webContents.id === webContents.id,
      )
      callback(isOwnWindow)
      return
    }
    callback(true)
  })

  // 1.5 提权换账户守卫（v0.2.8 审查修复）：UAC 若是**凭据**框（当前用户不在管理员组），
  //     提权实例会以另一个账户运行、%APPDATA% 随之切换 —— 界面上看起来像"配置与会话全丢了"
  //     （原数据其实躺在用户自己的 profile 里）。这里在**读配置之前**识别它：把原用户配置里的
  //     requireAdmin 关掉（自愈，下次启动就能正常跑），提示用户重启，然后退出 ——
  //     不进入"空配置 + 引导页"的假象。
  const switchedAccount = inspectElevatedUserData(process.argv, userData)
  if (switchedAccount !== undefined) {
    const fixed = disableRequireAdmin(join(switchedAccount.expected, 'config.json'))
    logger.warn('提权实例运行在另一个账户下，已阻止本次启动', {
      expected: switchedAccount.expected,
      actual: switchedAccount.actual,
      requireAdminDisabled: fixed,
    })
    dialog.showMessageBoxSync({
      type: 'warning',
      title: 'Aurora 未能以你的账户启动',
      message: fixed
        ? '提权把程序切到了另一个 Windows 账户，看不到你原来的数据。已为你关闭「以管理员身份运行」，请重新启动 Aurora。'
        : '提权把程序切到了另一个 Windows 账户，看不到你原来的数据。请手动关闭配置里的 general.requireAdmin（或改用本机管理员组账户）后重启。',
      buttons: ['退出'],
      noLink: true,
    })
    app.quit()
    return
  }

  // 2. 配置（Schema 校验 + 迁移 + safeStorage 凭据）
  const crypto = createSafeStorageCrypto()
  settings = new SettingsStore({
    dir: userData,
    crypto,
    logger: logger.child('settings'),
    onWriteError: (error) => logger?.error('配置写入失败', { error: error.message }),
  })
  const report = await settings.init()
  logger.info('配置就绪', {
    path: report.path,
    created: report.created,
    corrupted: report.corrupted,
    cryptoAvailable: report.cryptoAvailable,
    needsOnboarding: report.needsOnboarding,
    appliedMigrations: report.appliedMigrations,
  })
  if (!report.cryptoAvailable) {
    logger.warn('safeStorage 不可用，API Key 仅驻留内存')
  }

  // 2.1 高级页生效项（docs/08 §6）：日志级别、系统代理。
  //     这两项曾经只是「存进配置但无人消费」的假开关 —— 用户改了没效果、也查不出来。
  //     放在这里是因为必须在任何出网 / 写日志之前生效。
  logger.setLevel(settings.get().advanced.logLevel)
  netFetch = createNetFetch()
  await applyAdvancedNetwork(settings.get().advanced.proxy)

  // 2.2 管理员提权（v0.2.8，docs/08 §1、docs/09 §9）：未提权且配置要求时用 UAC 重新拉起
  //     一个管理员实例并退出自己 —— 必须在建窗 / 装托盘 / 连 Center **之前**，
  //     否则要多做一次"把已经起来的东西全部拆掉"的收尾（还可能有半截 WS 连接）。
  //     提权失败不阻断启动（继续以普通权限跑），失败原因进日志。
  const elevation = await ensureElevation({
    requireAdmin: settings.get().general.requireAdmin,
    packaged: app.isPackaged,
    argv: process.argv,
    execPath: process.execPath,
    userDataPath: userData,
    logger: logger.child('elevation'),
  })
  if (elevation === 'relaunched') {
    // 提权实例会接管单实例锁：**先把锁放开再退出**，否则子进程与"还没退干净的父进程"
    // 抢同一把锁，子进程会以"已有实例"为由立刻退出（用户看到的现象是双击后什么都没发生）。
    app.releaseSingleInstanceLock()
    app.quit()
    return
  }

  // 3. 系统感知（docs/06 §8.1）：时间 / 电源 / 网络 / 前台窗口 / 显示器 / 课程表
  //    显示器与课程表的数据源在主进程侧（Electron screen / 模式配置），以注入方式提供，
  //    使 `perception.ts` 保持不依赖 Electron、可单测。
  perception = new PerceptionHub({
    logger: logger.child('perception'),
    displayProvider: () => {
      try {
        const displays = screen.getAllDisplays()
        const primary = screen.getPrimaryDisplay()
        return {
          width: primary.size.width,
          height: primary.size.height,
          scaleFactor: primary.scaleFactor,
          count: displays.length,
        }
      } catch (error) {
        logger?.debug('显示器信息不可用，已降级为未知', { error: String(error) })
        return undefined
      }
    },
    scheduleProvider: async () => {
      try {
        return await currentScheduleProvider().getToday(new Date())
      } catch (error) {
        logger?.debug('课程表不可用，已降级为未知', { error: String(error) })
        return undefined
      }
    },
    // 课堂状态快照（docs/05 §3.4 v3）：取桥接 provider 缓存的最近一次快照。
    // 上面的 scheduleProvider 刚读过一次（内容变化时顺带刷新了缓存），
    // 因此这里拿到的是同一批数据；未启用桥接 / 桥接未提供 status 时为 undefined。
    classStatusProvider: () => {
      try {
        return classIslandProviderFor()?.getStatus().status
      } catch (error) {
        logger?.debug('课堂状态快照不可用，已降级为未知', { error: String(error) })
        return undefined
      }
    },
  })
  perception.start()

  // 4. 窗口
  const rendererDir = join(__dirname, '../renderer')
  windows = new WindowManager({
    settings,
    logger: logger.child('window'),
    preloadPath: join(__dirname, '../preload/index.js'),
    rendererUrl: process.env['ELECTRON_RENDERER_URL'],
    rendererDir,
    isDev,
    iconPath: resolveWindowIcon(),
    backgroundThrottling: !smokeMode,
  })

  // 5. Skill 注册表（内置 skills/ + 用户技能目录）
  //    用户目录来自 `skills.userDir`（空串回落 `userData/skills`）——在此之前该配置项
  //    只是个死字段，运行时永远读 `userData/skills`（docs/08 §6）。
  skillsService = new SkillsService(
    {
      builtinDir: resolveBuiltinSkillsDir(),
      userData,
      logger: logger.child('skills'),
    },
    settings.get(),
  )
  await skillsService.init(settings.get())
  // 用户技能目录监听（docs/06 §22.3）：create-skill / 手动放入的技能自动重扫
  skillsService.startWatching()
  const skills = skillsService.kernel
  if (skillsService.status().failed > 0) {
    logger.warn('部分技能解析失败，已跳过', { count: skillsService.status().failed })
  }

  // 6. 模式装配
  const modes = new ModeManager(logger.child('mode'))
  const modeContext: ModeContext = {
    settings: {
      get: () => settings!.get(),
      mutate: (mutator) => settings!.mutate(mutator),
    },
    windows: {
      showChat: () => windows?.showChat(),
      notify: (title, body, openPath) => notify(title, body, openPath),
    },
    proactive: {
      requestGuide: (mode, reason) => {
        logger?.info('请求主动引导', { mode, reason })
        windows?.showChat()
      },
      cancelGuide: (mode) => logger?.debug('取消主动引导', { mode }),
    },
    fs: {
      exists: async (path) => {
        try {
          await fs.access(path)
          return true
        } catch {
          return false
        }
      },
      isDirectory: async (path) => {
        try {
          return (await fs.stat(path)).isDirectory()
        } catch {
          return false
        }
      },
      ensureDir: async (path) => {
        await fs.mkdir(path, { recursive: true })
      },
      resolveUserPath: (path) => {
        const trimmed = path.trim()
        if (trimmed.startsWith('~'))
          return join(app.getPath('home'), trimmed.slice(1).replace(/^[\\/]/, ''))
        if (
          /^[a-zA-Z]:[\\/]/.test(trimmed) ||
          trimmed.startsWith('/') ||
          trimmed.startsWith('\\\\')
        )
          return trimmed
        return join(app.getPath('home'), trimmed)
      },
    },
    logger: logger.child('mode-ctx'),
    state: new Map<string, unknown>(),
  }
  modes.register(createClassroomMode())
  modes.register(createWorkMode())
  modes.register(createCodeMode())
  await modes.init(modeContext)
  const guides = new GuideRunner({
    manager: modes,
    ctx: modeContext,
    logger: logger.child('guide'),
  })

  // 7. 依赖装配 + IPC
  const paths = {
    userData,
    logs: logsDir,
    config: settings.path,
    builtinSkills: resolveBuiltinSkillsDir(),
  }

  // 7.1 Agent 内核装配（docs/06）：会话 → 工具表 → Skill → MCP → 内核 host
  sessions = new SessionStore({
    dir: join(userData, 'sessions'),
    logger: logger.child('session'),
    onWriteError: (error) => logger?.error('会话写入失败', { error: error.message }),
  })
  tools = new ToolRegistry()
  const skillBridge = new SkillsBridge(skills)
  skillBridge.registerInto(tools)

  // 7.1 电脑操控工具（docs/06 §11）：按 `agent.tools.*` 注册全部工具。
  //     必须在内核（KernelAgentHost）构造前装配，否则第一次请求的工具表是空的。
  //     `sync()` 是唯一的开关落地点：这里一次、`onSettingsChanged` 一次 → 改完立即生效。
  //     缺省工作目录 / 搜索根由装配层按 §5.1 三级回落现算（项目根 > workspaceDir > 主目录，
  //     `effectiveWorkspaceDir` 与下面 `projectRoot` 同源）；runner 的 `defaultCwd` 只是
  //     「缺省目录本身不存在」时的最后兜底，真正的边界校验在 command-runner / file-port
  //     的 `resolveWithin`（于是 `agent.tools.workspaceDir` 改完不用重建 runner）。
  //
  // 7.1.1 `set_setting`（docs/06 §12）：AI 修改自身配置的唯一入口。
  //     写入复用 IPC 层同一个 `applyPatch`（局部合并 + 凭据抽取 + 广播）；
  //     绑定它所需的 `DesktopDeps`（下面的 `deps`）在后半段才装配，因此这里传 getter，
  //     真正的取值发生在第一次写入时。
  const settingsPort: SettingsToolPort = createSettingsPort({
    settings,
    applyPatch: () => createSettingsWriter(deps),
    logger: logger.child('settings-tool'),
    // 回滚分支走 `mutate`（不广播）：补一次工具注册表重建，别让工具闭包停在坏值实例上
    notifyChanged: () => syncToolRegistries(),
  })
  // ⚠️ 声明顺序承重：`projectLogger` 必须在下方 `sessionProjects` / `registerComputerTools`
  // 装配**之前**声明 —— 这些装配的 `sync()` 在启动序就会取日志闭包，若留在装配之后才声明，
  // getter 执行时即 TDZ `Cannot access 'projectLogger' before initialization`，表现为
  // **启动直接失败**（单测全用假装配器，覆盖不到真实装配时序，只有 AURORA_SMOKE 抓得到）。
  const projectLogger = logger?.child('project')
  // 会话级项目解析（v17，docs/06 §5.1）：每个会话可绑定 projects.list 里的一项
  // （`sessions/<id>.json` 的 meta.projectId，经 `chat:setSessionProject` 写入）。
  // 2026-09-30 会话三分（docs/06 §4）起再插入会话空间一级（meta.space）：
  // Agent 空间（未标记 / 'agent'，含 quick 与历史会话）→ 固定 `桌面\Aurora`，
  // Work 空间（'work'）→ modes.work.workspaceDir（v25 起全局 current 已退役，无该回落级）。
  // 缺省 cwd / 搜索根、项目根边界（file-port / command-runner 的 workspaceRoot）、
  // 项目根边界与 AGENTS.md 注入**全部**走这一个解析器（session-project.ts）。
  // 同步取值走 `projectOf` / `spaceOf`（内存缓存；装配层不变量：会话的工具执行之前
  // agentLoop 必然已读过该会话）；确认钩子 / 指令注入允许 await，先 `projectIdOf` 预热再取。
  // Agent 空间目录懒创建：首次有 Agent 会话解析到它时建一次（失败只 warn —— 目录不存在时
  // file-port 的 realpath 校验退到最近存在的父目录，链路仍能工作）。
  const agentWorkspaceDir = agentDesktopDir(app.getPath('home'))
  let agentWorkspaceEnsured = false
  const ensureAgentWorkspaceDir = (): string => {
    if (!agentWorkspaceEnsured) {
      agentWorkspaceEnsured = true
      fs.mkdir(agentWorkspaceDir, { recursive: true })
        .then(() => logger?.debug('Agent 工作区目录就绪', { dir: agentWorkspaceDir }))
        .catch((error: unknown) => {
          logger?.warn('Agent 工作区目录创建失败（链路继续，落盘时按最近存在父目录校验）', {
            dir: agentWorkspaceDir,
            error: error instanceof Error ? error.message : String(error),
          })
        })
    }
    return agentWorkspaceDir
  }
  const sessionProjects = createSessionProjectResolver({
    getSettings: () => settings!.get(),
    getProjectId: (sessionId) =>
      sessionId === undefined || sessionId === '' ? undefined : sessions!.projectOf(sessionId),
    sessionSpaceOf: (sessionId) =>
      sessionId === undefined || sessionId === '' ? 'agent' : sessions!.spaceOf(sessionId),
    agentDir: ensureAgentWorkspaceDir,
    homeDir: () => app.getPath('home'),
    cwd: process.cwd(),
  })
  // 工具执行链的取值视图：子代理（task）的 `-sub` 会话 id 先剥回父会话再解析 ——
  // 缺省 cwd / 搜索根 / 边界根跟随**父会话**的工作目录（docs/06 §19，确认链同款钉回）；
  // todo 清单等状态隔离仍按 `-sub`（不经此视图）。确认 / AGENTS.md / workspaceHint
  // 不会收到 `-sub` id，继续直用 sessionProjects。
  const toolchainProjects = adaptForSubagent(sessionProjects)
  computerTools = registerComputerTools({
    tools,
    getSettings: () => settings!.get(),
    logger: logger.child('tools'),
    homeDir: () => app.getPath('home'),
    // 缺省工作目录 / 搜索根：**按会话**即时解析（会话绑定项目 > 全局链），工具执行期现调
    sessionWorkspaceDir: (sessionId) => toolchainProjects.workspaceDir(sessionId),
    run: createCommandRunner({
      defaultCwd: process.cwd(),
      maxOutputBytes: 1024 * 1024,
      // cwd 边界按会话解析（会话绑定项目 > 全局当前项目）；子代理剥回父会话
      workspaceRoot: (sessionId) => toolchainProjects.boundaryRoot(sessionId),
      logger: logger.child('tools'),
    }),
    files: createNodeFilePort({
      // 六个文件方法的项目根边界同样按会话解析（与 runner 同一个取值器，别再抄第三份；子代理剥回父会话）
      workspaceRoot: (sessionId) => toolchainProjects.boundaryRoot(sessionId),
      logger: logger.child('tools'),
      snapshots: filePortSnapshots,
    }),
    office: createNodeOfficePort({
      pool: ensureOfficePool(),
      snapshots: filePortSnapshots,
      workspaceRoot: (sessionId) => toolchainProjects.boundaryRoot(sessionId),
      renderRoot: join(userData, 'office-previews'),
      logger: logger.child('office'),
    }),
    officeAvailable: officeCliAvailable,
    open: createShellOpenPort({
      urlMode: () => settings!.get().agent.tools.open.urlMode,
      present: (target, sessionId) => {
        windows?.showChat()
        windows?.sendTo('chat', IPC.preview.show, {
          sessionId,
          url: target,
          display: target,
          title: '模型打开的网址',
        })
      },
    }),
  })
  settingsTool = registerSettingsTool({ tools, port: settingsPort, logger: logger.child('tools') })
  const centerSettings = createCenterAwareSettingsStore(settings)
  // 7.1.2 STT / 生图服务（docs/06 §15）：出网走注入的 netFetch（代理生效），
  //     生图落盘到 `userData/generated`（imagegen:read 的白名单根，见 ipc.ts 的路径校验）。
  const centerSttService = createSttService({
    settings: centerSettings,
    logger: logger.child('stt'),
    resolveFetch: () => netFetch,
  })
  const localSttService = createSttService({
    settings,
    logger: logger.child('stt-local'),
    resolveFetch: () => netFetch,
  })
  const sttService = {
    transcribe: async (input: Parameters<typeof centerSttService.transcribe>[0]) => {
      const current = settings!.get()
      const route = resolveCapabilityRoute(
        '语音输入',
        current.stt,
        current.center.officialModels.stt.enabled,
        CENTER_OFFICIAL_PROVIDER_IDS.stt,
        (providerId, provider) =>
          provider.baseUrl.trim() !== '' &&
          provider.model.trim() !== '' &&
          settings!.getSecret(`stt.providers.${providerId}.apiKey`) !== '',
      )
      if (route.mode === 'error') throw new Error(route.message)
      if (route.mode === 'local') {
        return localSttService.transcribe({ ...input, providerId: route.providerId })
      }
      try {
        return await centerSttService.transcribe(input)
      } catch (error) {
        emitOfficialFallback('stt', '语音识别')
        logger?.warn('Center 官方 STT 失败，回落本机模型', { error: String(error) })
        if (route.fallbackProviderId === undefined) throw error
        return localSttService.transcribe({ ...input, providerId: route.fallbackProviderId })
      }
    },
  }
  const centerImageGenService = createImageGenService({
    settings: centerSettings,
    logger: logger.child('imagegen'),
    generatedDir: join(userData, 'generated'),
    resolveFetch: () => netFetch,
  })
  const localImageGenService = createImageGenService({
    settings,
    logger: logger.child('imagegen-local'),
    generatedDir: join(userData, 'generated'),
    resolveFetch: () => netFetch,
  })
  const imageGenService = {
    generate: async (input: Parameters<typeof centerImageGenService.generate>[0]) => {
      const current = settings!.get()
      const route = resolveCapabilityRoute(
        '图像生成',
        current.imagegen,
        current.center.officialModels.imagegen.enabled,
        CENTER_OFFICIAL_PROVIDER_IDS.imagegen,
        (providerId, provider) =>
          provider.baseUrl.trim() !== '' &&
          provider.model.trim() !== '' &&
          settings!.getSecret(`imagegen.providers.${providerId}.apiKey`) !== '',
      )
      if (route.mode === 'error') throw new Error(route.message)
      if (route.mode === 'local') {
        return localImageGenService.generate({ ...input, providerId: route.providerId })
      }
      try {
        return await centerImageGenService.generate(input)
      } catch (error) {
        emitOfficialFallback('imagegen', '图像生成')
        logger?.warn('Center 官方生图失败，回落本机模型', { error: String(error) })
        if (route.fallbackProviderId === undefined) throw error
        return localImageGenService.generate({
          ...input,
          providerId: route.fallbackProviderId,
        })
      }
    },
    read: (input: Parameters<typeof centerImageGenService.read>[0]) =>
      centerImageGenService.read(input),
  }
  imageDisplayPort = createImageDisplayPort({
    workspaceDirOf: (sessionId) => toolchainProjects.workspaceDir(sessionId),
    boundaryRootOf: (sessionId) => toolchainProjects.boundaryRoot(sessionId),
    ownedDirs: OWNED_IMAGE_SUBDIRS.map((name) => join(userData, name)),
    logger: logger.child('tools'),
  })
  // 7.1.3 扩展工具七件套（docs/06 §14）：web_fetch / clipboard_read / clipboard_write /
  //     notify_user / generate_image / show_preview / show_image。与 set_setting 同级——不受
  //     `agent.tools.enabled` 门控，敏感动作靠工具自身的 `sensitivity: 'confirm'` 逐次确认。
  //     NotificationService 在下方 7.2 才装配，这里按调用时点取值（工具执行时必然已就绪）。
  extensionTools = registerExtensionTools({
    tools,
    logger: logger.child('tools'),
    webFetch: createNetWebFetchPort({ fetchImpl: () => netFetch }),
    clipboard: createElectronClipboardPort(),
    notify: createNotificationPort({
      notify: (request) => notifications?.notify(request) ?? false,
    }),
    imageGen: createImageGenPort(imageGenService),
    imageDisplay: imageDisplayPort,
    // `show_preview`（2026-10-03）：本地文件边界 / 相对路径基准都按**会话**解析
    //（`toolchainProjects` 即 file-port / command-runner 用的同一份取值器，子代理剥回父会话）；
    // 推送前先 showChat —— 窗口被隐藏时用户什么也看不到，展示就失去了意义。
    preview: createPreviewPort({
      workspaceDirOf: (sessionId) => toolchainProjects.workspaceDir(sessionId),
      boundaryRootOf: (sessionId) => toolchainProjects.boundaryRoot(sessionId),
      urlMode: () => settings!.get().agent.tools.open.urlMode,
      openExternal: (url) => shell.openExternal(url),
      present: (payload) => {
        windows?.showChat()
        windows?.sendTo('chat', IPC.preview.show, payload)
      },
      logger: logger.child('tools'),
    }),
  })
  // 7.1.3b 图像工具（docs/06 §25）：view_image / screenshot / clipboard_read_image。
  //     门控是**模型能力**而不是开关：当前生效模型没开图片输入就一个都不注册（判据见 vision.ts）。
  //     三个落盘目录（generated / screenshots / clipboard）同时是 view_image 的白名单根 ——
  //     它们由 Agent 自己写出，`<userData>` 又在任何项目根之外，边界校验必须先放行这三处。
  imageTools = registerImageTools({
    tools,
    logger: logger.child('tools'),
    visionEnabled: () => visionEnabled(centerSettings.get()),
    viewImage: createViewImagePort({
      io: createNodeImageIo(),
      // 与 file-port / command-runner **同一个**边界取值器（按会话解析项目根，docs/06 §5.1）
      guard: { workspaceRoot: (sessionId) => toolchainProjects.boundaryRoot(sessionId) },
      ownedDirs: OWNED_IMAGE_SUBDIRS.map((name) => join(userData, name)),
    }),
    screenshot: createScreenshotPort({
      dir: join(userData, 'screenshots'),
      logger: logger.child('tools'),
    }),
    clipboardImage: createElectronClipboardImagePort({
      dir: join(userData, 'clipboard'),
      logger: logger.child('tools'),
    }),
  })
  // 7.1.4 Agent 内核自带工具（docs/06 §18/§19）：todo_write / todo_read / task。
  //     与 set_setting / 扩展工具七件套同级——不受 `agent.tools.enabled` 门控
  //     （todo / task 是 Agent 自身能力，不是电脑操控）。
  //     清单按会话落盘到 `<userData>/todos/`（子代理用 `<sessionId>-sub` 独立清单）。
  todoPort = createFileTodoPort({
    dir: join(userData, 'todos'),
    logger: logger.child('todos'),
    onWriteError: (error) => logger?.error('任务清单写入失败', { error: error.message }),
  })
  // 7.1.4b 写前快照（docs/06 §11.8，v14）：`<userData>/backups/<sessionId>/` 下一条一个 `.snap`。
  //     挂给 file-port 的是**稳定的代理对象**（不是某个具体实例）：设置页改保留份数 / 上限后，
  //     `ensureSnapshotPort()` 会换一个新实例，而 file-port 手里的引用不变 ——
  //     否则「改配置要重启」会成为又一个静默失效的配置字段。
  snapshotDir = join(userData, 'backups')
  snapshotPort = createSnapshotPortFor(settings.get().agent.snapshots)
  // 7.1.4c Job（任务）持久化（docs/06 §4.1，v15）：`<userData>/jobs/<sessionId>.json`。
  //     一次请求一条 job，每轮结束落游标；轮次 / 预算用尽落 `paused`，重启后可续跑。
  jobStore = createFileJobStore({
    dir: join(userData, 'jobs'),
    fs: nodeFileSystem,
    logger: logger.child('jobs'),
  })
  // 7.1.4d Agent 向用户提问（docs/06 §21）：卡片推送 + 等回执，超时 3 分钟按"未回答"继续。
  //     在这里（工具装配**之前**）建：`ask_user` 的工具实例要注入它的 `ask` 端口。
  //     推送走 ipc 的 `askUser:request` 广播（见 registerIpc 的 deps.askUser），
  //     这里只负责"把卡片对应的窗口显示出来"——卡片无处可显示就是一次静默超时。
  askUserService = createAskUserService({
    logger: logger.child('askUser'),
    present: () => {
      windows?.showChat()
      windows?.focus('chat')
    },
  })
  centerModelServices = new CenterModelServices({
    settings: settings!,
    logger: logger.child('center-models'),
    fetchImpl: () => netFetch,
    config: () => {
      const center = settings!.get().center
      return {
        enabled: center.enabled,
        serverUrl: center.serverUrl,
        token: settings!.getSecret('center.token'),
        clientId: center.clientId,
      }
    },
    onChanged: (catalog) => {
      if (catalog !== null) centerFallbackNoticeKeys.clear()
      for (const listener of centerModelServicesListeners) listener(catalog)
    },
  })

  // 7.1.5 provider 工厂提取成常量：KernelAgentHost 与 `task` 子代理共享同一实例，
  //     「常规构造失败 → 临时回退可用条目」的启动自愈语义（docs/06 §12、step 02 第 6 条）
  //     两处一致；create() 每次请求即时构造，设置页改 Key 后无需重启即生效。
  // 会话级模型覆盖（docs/06 §3）：同步读会话 meta（`SessionStore.modelOverrideOf`）——
  // 覆盖失效 / 未装载一律回落全局档，回落语义与日志都在 `createProviderFactory` 里。
  const providerFactory = createProviderFactory(settings, logger.child('llm'), () => netFetch, {
    sessionModelOf: (sessionId) => {
      if (isFileAwarenessSession(sessionId)) return fileAwarenessModelOverride(settings!.get())
      return sessions?.modelOverrideOf(sessionId)
    },
    strictSessionModelOf: (sessionId) =>
      isFileAwarenessSession(sessionId) && hasExplicitFileAwarenessModel(settings!.get()),
    centerOfficial: {
      token: () => settings!.getSecret('center.token'),
      service: (capability) => centerModelServices?.service(capability),
      selection: (capability) => settings!.get().center.officialModels[capability],
      onFallback: (input) => {
        const key = `${input.sessionId ?? 'global'}:llm`
        if (centerFallbackNoticeKeys.has(key)) return
        centerFallbackNoticeKeys.add(key)
        emitCenterRuntimeNotice({
          capability: 'llm',
          message: `Aurora Center 官方语言模型不可用，已回落到 ${input.fallbackProviderId || '本机模型'}`,
          at: new Date().toISOString(),
        })
      },
    },
  })
  const agentProvider: AgentProviderFactory = {
    create: (options?: { allowFallback?: boolean; sessionId?: string }) => {
      try {
        const config = providerFactory.create(options)
        if (config !== undefined) return config
        if (
          options?.sessionId !== undefined &&
          isFileAwarenessSession(options.sessionId) &&
          hasExplicitFileAwarenessModel(settings!.get())
        ) {
          return undefined
        }
        return providerFactory.create({ ...options, allowFallback: true })
      } catch (error) {
        logger?.warn('默认模型配置构造失败，尝试回退到可用条目', { error: String(error) })
        if (
          options?.sessionId !== undefined &&
          isFileAwarenessSession(options.sessionId) &&
          hasExplicitFileAwarenessModel(settings!.get())
        ) {
          return undefined
        }
        return providerFactory.create({ ...options, allowFallback: true })
      }
    },
  }
  const sessionTitles = new SessionTitleService({
    sessions,
    provider: agentProvider,
    logger: logger.child('session-title'),
    // 标题落盘成功后才广播：渲染层看到标题时，重启 / Center 再拉列表也一定读得到。
    onTitle: (event) => windows?.sendTo('chat', IPC.chat.sessionTitleChanged, event),
  })
  agentCoreTools = registerAgentCoreTools({
    tools,
    logger: logger.child('tools'),
    todoPort,
    provider: agentProvider,
    // `ask_user` 的提问端口（docs/06 §21）：未接上时工具会如实回填"这里问不了人"
    askUserPort: askUserService,
    // 只读档下摘掉 `todo_write`（safe 级但会往 userData/todos 落盘）——档位每次 sync 现读，
    // 用户切档后由 `settings:changed` → `syncToolRegistries()` 立即生效
    getSettings: () => settings!.get(),
    // `task` 的 `permission: 'write'`（2026-09）用它把子代理的写操作确认交回同一条判定链
    // （档位 / 项目根 / 免确认模式）。给 getter 而不是值：`confirmTool` 在本行**之后**才创建
    // （装配顺序如此），取值发生在工具执行时，那时它已经就位。
    getConfirmTool: () => confirmTool,
  })
  // 7.1.6 ClassIsland 提醒工具（docs/05 §3.4 v3）：`classisland_remind`。
  //     与扩展工具七件套同级——不受 `agent.tools.enabled` 门控；但**按可用性注册**：
  //     桥接未配置时先不进工具表（模型看不到就不会承诺），用户填完端点后
  //     `settings:changed` 触发 `syncToolRegistries()` 自动补上，无需重启。
  classIslandTools = registerClassIslandTools({
    tools,
    logger: logger.child('tools'),
    port: {
      notify: (request) => classIslandNotifierFor().notify(request),
      available: () => isClassIslandActive(),
    },
  })
  centerTools = registerCenterTools({
    tools,
    logger: logger.child('tools'),
    port: {
      status: () =>
        centerConnector?.status() ?? {
          enabled: false,
          connected: false,
          serverUrl: '',
          displayName: '',
        },
      sendFile: (path, note) =>
        uploadFileToCenter({
          serverUrl: settings!.get().center.serverUrl,
          token: settings!.getSecret('center.token'),
          clientId: settings!.get().center.clientId,
          path,
          ...(note === undefined ? {} : { note }),
        }),
    },
    config: () => {
      const center = settings!.get().center
      return {
        enabled: center.enabled,
        serverUrl: center.serverUrl,
        allowFileTransfer: center.allowFileTransfer,
        maxFileMb: center.maxFileMb,
      }
    },
  })
  // 7.1.7 自动化管理工具（docs/13 §8）：automation_list / create / update / delete / run / history。
  //     不受 `agent.tools.enabled` 门控；只读档摘掉写类工具；create / update / delete / run
  //     自身 confirm 逐次确认。引擎在下方 7.x 才装配，端口经惰性闭包取值。
  automationTools = registerAutomationTools({
    tools,
    logger: logger.child('tools'),
    port: {
      list: async () => ({
        user: (await automationEngine?.listDefinitions()) ?? [],
        builtin: automationEngine?.listBuiltin() ?? [],
      }),
      save: (input) =>
        automationEngine === undefined
          ? Promise.resolve({ ok: false as const, error: '自动化引擎尚未装配' })
          : automationEngine.saveDefinition(input),
      delete: (id) =>
        automationEngine === undefined
          ? Promise.resolve({ ok: false as const, error: '自动化引擎尚未装配' })
          : automationEngine.deleteDefinition(id),
      run: (id) =>
        automationEngine === undefined
          ? Promise.resolve({ ok: false as const, error: '自动化引擎尚未装配' })
          : automationEngine.runNow(id),
      history: (query) => automationEngine?.history(query) ?? Promise.resolve([]),
      catalog: () => automationEngine?.catalog() ?? { conditions: [], actions: [] },
    },
    getSettings: () => settings!.get(),
  })
  // 文件自感知只读工具（docs/06 §26）：状态始终可见，其余三个按启用 / 授权动态注册。
  awarenessTools = registerAwarenessTools({
    tools,
    logger: logger.child('tools'),
    active: () => fileAwareness?.status().active === true,
    port: {
      status: () => {
        if (fileAwareness === undefined) throw new Error('文件自感知尚未装配')
        return fileAwareness.status()
      },
      notes: (limit) => fileAwareness?.agentNotes(limit) ?? [],
      records: (limit) => fileAwareness?.agentRecords(limit) ?? [],
      readNote: async (noteId) => {
        if (fileAwareness === undefined) throw new Error('文件自感知尚未装配')
        return await fileAwareness.readAgentNote(noteId)
      },
    },
  })
  syncToolRegistries()

  const mcpLogger = logger.child('mcp')
  mcp = new McpController({
    settings,
    tools,
    logger: mcpLogger,
    resolveFetch: () => netFetch,
    onStatusChanged: (statuses) => mcpStatusListeners.forEach((listener) => listener(statuses)),
  })
  /*
   * MCP 建连**不阻塞启动主链**（2026-09-29）：`start()` 会把每个已启用的服务器挨个握手，
   * 单台超时 30s（`agent-core/src/mcp/hub.ts` 的 timeoutMs）。`await` 它等于把后面所有
   * 启动步骤（含本函数末尾的 `centerConnector.start()`）一起推迟 —— 用户配了一台连不上的
   * MCP 服务器时，Center 网页端要等半分钟才看到设备上线，这正是「上线太慢」的成因之一。
   * 工具是**连上即注册**进同一个 `tools` 注册表（系统提示词按请求现组装），
   * 因此这里 fire-and-forget 只影响「MCP 工具多早可用」，不影响可用性本身。
   */
  void mcp.start().catch((error) => {
    mcpLogger.error('MCP 启动失败', { error: String(error) })
  })

  // 7.1 主动引导 / 敏感工具确认（docs/06 §5、§9）——必须在内核之前装配：
  //     内核的 `confirmTool` 钩子需要它作为确认载体。
  proactiveScheduler = new ProactiveScheduler({
    quietHours: () => settings!.get().advanced.quietHours,
    logger: logger.child('proactive'),
    // 推送本身走 IPC 广播（见 ipc.ts 的 proactive.sensitiveTool），
    // 但必须**先把交互窗显示出来**：否则用户在服务窗发起请求后交互窗若未打开，
    // 确认卡片无处可显示，60s 后会被当作拒绝——静默失败最难排查。
    present: () => {
      windows?.showChat()
      windows?.focus('chat')
    },
  })
  confirmTool = createConfirmTool({
    proactive: proactiveScheduler,
    // 每次调用即时判断：设置页改档位无需重启（docs/06 §11.2）。
    // v0.2.3 起按会话现解析：会话级覆盖（SessionMeta.permissionMode，docs/12 §6.3）
    // > 全局档（resolvePermissionMode）；会话 meta 惰性读盘，允许 await。
    mode: async (sessionId) => {
      if (sessionId !== '') {
        const overridden = await sessions!.permissionModeOf(sessionId)
        if (overridden !== undefined) return overridden
      }
      return resolvePermissionMode(settings!.get())
    },
    // 免确认命令模式（docs/06 §11.7）：与 `mode` 同款闭包 —— 每次调用即时读设置，
    // 用户在设置页加完模式立刻生效，无需重启（该字段是只读前缀，AI 改不动）。
    allowPatterns: () => settings!.get().agent.tools.terminal.allowPatterns,
    // confirm 档根内免确认边界 = 当前**会话**的项目根边界（会话绑定项目 > 会话空间目录 >
    // 激活模式目录；全局 `projects.current` 一级已于 v25 退役，docs/06 §5.1）。
    // 先 `projectIdOf` 预热（允许 await 读盘），再走与缺省 cwd / projectInstructions
    // 同源的解析器，别再抄第三份
    projectRoot: async (sessionId) => {
      await sessions!.projectIdOf(sessionId)
      return sessionProjects.boundaryRoot(sessionId)
    },
    logger: logger.child('confirm'),
  })

  // 项目机制（v13，docs/06 §5.1）：每轮按「项目根 → 当前工作目录」逐层收集 AGENTS.md
  // （同目录 AGENTS.override.md 优先）。取用器内部按 root + 文件 mtime 缓存，
  // 无项目 / 读不到文件一律降级为不注入 —— 装配层只提供"当前值"的取值闭包。
  // （`projectLogger` 已上移到 `projectRoot` 之前声明，原因见那里的承重注释。）
  const projectInstructions = createProjectInstructionsSource({
    fs: nodeProjectFs,
    ...(projectLogger === undefined ? {} : { logger: projectLogger }),
    // 复用上方解析器（与 confirmTool 的边界判定同源）：按**会话**解析项目根 ——
    // 会话绑定项目 > 会话空间目录 > 激活模式目录（docs/06 §5.1，v25 起无全局回落）
    resolveRoot: async (sessionId) => {
      await sessions!.projectIdOf(sessionId ?? '')
      return sessionProjects.boundaryRoot(sessionId)
    },
    resolveCwd: () => process.cwd(),
    resolveMaxBytes: () => settings!.snapshot().projects.maxAgentsBytes,
  })

  const kernel = new KernelAgentHost({
    sessions,
    // 启动自愈（docs/06 §12、step 02 第 6 条）：与 task 子代理共享同一 provider 实例
    // （见上方 agentProvider 注释），常规构造失败时回退到可用条目，不让 Agent 彻底失能。
    provider: agentProvider,
    tools,
    skills: skillBridge,
    logger: logger.child('agent'),
    // settingsHint / todoSummary / projectInstructions 走 agent-core 正式通道
    // （docs/06 §17/§18/§5.1）：前者是「Agent 可修改的设置」固定清单，后两者按会话 / 项目
    // 即时读取——空值一律由 buildSystemPrompt 自动省略对应小节。
    settingsHint: () => SETTINGS_HINT,
    todoSummary: async (sessionId) => renderTodoList(await todoPort!.read(sessionId)),
    projectInstructions,
    // 工作目录提示（docs/06 §4 会话三分，2026-09-30）：按会话现解析生效工作目录，
    // 渲染为「## 工作目录」易变小节 —— 模型要先知道「在哪干活」，再读「那片地方的约定」。
    workspaceHint: async (sessionId) => {
      if (sessionId === undefined || sessionId === '') return undefined
      await sessions!.projectIdOf(sessionId)
      const dir = sessionProjects.workspaceDir(sessionId)
      return dir.trim() === '' ? undefined : dir
    },
    modePrompt: () => modes.systemPrompt(),
    perceptionSummary: () => perception?.contextSummary() ?? Promise.resolve(''),
    // 长上下文摘要（docs/06 §4）：被截断的旧消息交给当前 provider 压成一段摘要。
    // 装配层实现、内核只接受注入 —— agent-core 保持不依赖网络与 Electron。
    summarize: createSummarizer(settings, logger.child('summary')),
    // 快速会话上下文只带最近 5 分钟，防旧上下文污染（docs/06 §4 滑动窗口）
    quickContextWindowMs: 5 * 60_000,
    confirmTool,
    // 图片附件读盘（多模态输入，docs/06 §3.1，v22）：内核不碰文件系统，端口在这里注入。
    // 与 `attachmentExtract` 同一套「降级不阻断」口径：读不出 / 超限的图如实记 warn，
    // 本轮按未读取处理（模型不会以为它看见过）。
    loadImages: async (paths) => {
      // io 与 `view_image` 的读盘端口**共用同一份**（`createNodeImageIo`）：
      // 单图 8 MiB 上限、空文件、读失败三种降级由 `readImages` 统一判定，两处不会漂移
      const loaded = await readImages(paths, createNodeImageIo())
      return loaded.map((item) => {
        if (item.image === undefined) {
          logger?.warn('图片附件未读入上下文', { path: item.path, note: item.note })
          return { path: item.path }
        }
        return { path: item.path, image: item.image }
      })
    },
    // Job 持久化（docs/06 §4.1，v15）：一次请求 = 一条可查询 / 可续跑的 job。
    // 三个上限都走 **getter** —— 设置页改完下一次请求即生效（v15 之前 maxRounds 是常量值，
    // 改配置必须重启，属于"能写但不生效"的死字段）。
    jobs: jobStore,
    // 上限类 getter 走 snapshot()（只读、不深拷贝）：每次 attempt / 每轮都会读，
    // `get()` 的整份深拷贝在这里是纯浪费（docs/08 §2，2026-10-04 性能轮）。
    maxRounds: () => settings!.snapshot().agent.loop.maxRounds,
    maxTotalTokens: () => settings!.snapshot().agent.loop.maxTotalTokens,
    autoContinueRounds: () => settings!.snapshot().agent.loop.autoContinueRounds,
    // 运行档（v0.2.8，docs/06 §5.2 / docs/13 §7.1）：自动化触发的会话换一套人设
    // （无人值守：不反问、自己决定、做完汇报）并摘掉写类自动化工具
    // （create / update / delete / run）——「自动化 → 会话 → 自动化」不得成为闭环。
    // 判据是 origin 或会话 id 前缀；普通会话返回 undefined，提示词与工具面与从前逐字一致。
    runProfileFor: (context) => fileAwarenessRunProfile(context) ?? automationRunProfile(context),
  })
  agent = new DesktopAgentHost({
    settings,
    modes,
    perception,
    logger: logger.child('agent-host'),
    kernel,
    confirmTool,
  })
  fileAwarenessAnalyzer = new FileAwarenessAnalyzer({
    agent,
    logger: logger.child('awareness-agent'),
  })
  awarenessExtractPool = new ExtractPool({
    fork: () =>
      utilityProcess.fork(join(__dirname, 'extract-worker.js'), [], {
        serviceName: 'aurora-awareness-extract',
      }) as unknown as ExtractWorkerChild,
    logger: logger.child('awareness-extract'),
    // 内嵌图片提取比纯正文多一轮附件解码；超时仍按期降级，不拖住后台队列。
    timeoutMs: 30_000,
  })
  const fileAwarenessCenterAvailability = (): {
    enabled: boolean
    available: boolean
    tokenSet: boolean
  } => {
    const current = settings!.get()
    return {
      enabled: current.center.officialModels.llm.enabled,
      available: centerModelServices?.service('llm') !== undefined,
      tokenSet: settings!.getSecret('center.token') !== '',
    }
  }
  fileAwareness = new FileAwarenessService({
    userData,
    settings: () => settings!.get(),
    logger: logger.child('file-awareness'),
    extract: (input) =>
      awarenessExtractPool!.extract({
        ...input,
        hashContent: true,
        extractDocumentImages: input.includeImages,
        extractImages: input.includeImages,
        evidenceLimitBytes: SELF_AWARENESS_EVIDENCE_LIMIT_BYTES,
      }),
    analyze: (input) => fileAwarenessAnalyzer!.analyze(input),
    initialUsage: () => sessions!.usageTotals(FILE_AWARENESS_SESSION_PREFIX),
    providerReady: () =>
      fileAwarenessModelError(
        settings!.get(),
        (path) => settings!.getSecret(path),
        fileAwarenessCenterAvailability(),
      ) === undefined,
    modelError: () =>
      fileAwarenessModelError(
        settings!.get(),
        (path) => settings!.getSecret(path),
        fileAwarenessCenterAvailability(),
      ),
    visionReady: () => {
      const current = settings!.get()
      const selected = resolveFileAwarenessModel(current)
      const provider = current.llm.providers[selected.providerId]
      if (provider === undefined || selected.model.trim() === '') return false
      return resolveModelParams(provider, selected.model).vision === true
    },
    canNotify: () => {
      const current = settings!.get()
      return (
        current.fileAwareness.suggestionsEnabled &&
        current.general.edgeBar.enabled &&
        windows?.isVisible('edge-bar') === true &&
        !isQuietHour(new Date(), current.advanced.quietHours) &&
        !isQuietHour(new Date(), current.general.edgeBar.quietHours)
      )
    },
    removeAwarenessSessions: async () => {
      const ids = (await sessions!.listSessions()).filter((id) =>
        id.startsWith(FILE_AWARENESS_SESSION_PREFIX),
      )
      for (const id of ids) await sessions!.remove(id)
    },
    openPath: async (path) => {
      const error = await shell.openPath(path)
      if (error !== '') throw new Error(error)
    },
  })
  agentActivityDetach = agent.onEvent((event) => {
    if (event.sessionId.startsWith(FILE_AWARENESS_SESSION_PREFIX)) return
    if (event.type === 'queued') activeAgentRequests.add(event.requestId)
    else if (event.type === 'done' || event.type === 'error') {
      activeAgentRequests.delete(event.requestId)
    }
    fileAwareness?.setAgentBusy(activeAgentRequests.size > 0)
  })
  fileAwareness.setAgentBusy(activeAgentRequests.size > 0)
  await fileAwareness.init()
  syncToolRegistries()
  const llm = new LlmTester({
    settings,
    logger: logger.child('llm'),
    resolveFetch: () => netFetch,
  })
  const centerTts = new TtsSynthesizer({
    settings: centerSettings,
    logger: logger.child('tts'),
    resolveFetch: () => netFetch,
  })
  const localTts = new TtsSynthesizer({
    settings,
    logger: logger.child('tts-local'),
    resolveFetch: () => netFetch,
  })
  const tts = {
    synthesize: async (request: Parameters<typeof centerTts.synthesize>[0]) => {
      if (request.providerId !== undefined) {
        return localTts.synthesize(request)
      }
      const current = settings!.get()
      const route = resolveCapabilityRoute(
        'TTS',
        current.tts,
        current.center.officialModels.tts.enabled,
        CENTER_OFFICIAL_PROVIDER_IDS.tts,
        (providerId, provider) =>
          provider.baseUrl.trim() !== '' &&
          provider.model.trim() !== '' &&
          provider.voice.trim() !== '' &&
          settings!.getSecret(`tts.providers.${providerId}.apiKey`) !== '',
      )
      if (route.mode === 'error') throw new Error(route.message)
      if (route.mode === 'local') {
        return localTts.synthesize({ ...request, providerId: route.providerId })
      }
      try {
        return await centerTts.synthesize(request)
      } catch (error) {
        emitOfficialFallback('tts', '语音合成')
        logger?.warn('Center 官方 TTS 失败，回落本机模型', { error: String(error) })
        if (route.fallbackProviderId === undefined) throw error
        return localTts.synthesize({ ...request, providerId: route.fallbackProviderId })
      }
    },
    test: (request: Parameters<typeof centerTts.test>[0]) => centerTts.test(request),
    listModels: (request: Parameters<typeof centerTts.listModels>[0]) =>
      centerTts.listModels(request),
  }

  // 7.1a Aurora Center 连接（docs/12）：出站 WS + 远程会话桥 + 远程配置。
  //     远程会话与本地 chat:send 走同一个 DesktopAgentHost；远程配置先在副本上
  //     演练再落库（mutate 的 draft 是活对象，半写会污染内存态）。
  sessionBridge = new SessionBridge({ agent, logger: logger.child('center-bridge') })
  centerConnector = new CenterConnector({
    logger: logger.child('center'),
    config: () => {
      const center = settings!.get().center
      return {
        enabled: center.enabled,
        serverUrl: center.serverUrl,
        token: settings!.getSecret('center.token'),
        clientId: center.clientId,
        displayName: center.displayName,
        allowRemoteSession: center.allowRemoteSession,
        allowRemoteConfig: center.allowRemoteConfig,
        allowFileTransfer: center.allowFileTransfer,
      }
    },
    statusSnapshot: () =>
      buildClientStatus(centerSettings.get(), app.getVersion(), process.platform),
    // 语音中转（docs/12 §6.4）：与 `stt:transcribe` / `tts:synthesize` IPC **同一实例**
    //（sttService / tts 都在上方装配）；门控判定与 ClientStatus.voice 能力位共用
    // voiceReadiness（remote-control.ts），不在 connector 里另写一套口径。
    voice: {
      readiness: () => voiceReadiness(centerSettings.get()),
      transcribe: async (input) => {
        return sttService.transcribe(input)
      },
      synthesize: async (text) => {
        const result = await tts.synthesize({ text })
        return { audioBase64: result.audioBase64, mimeType: result.mimeType }
      },
    },
    version: app.getVersion(),
    platform: process.platform,
    hostname: () => osHostname(),
    // 网页端对提问卡的作答（docs/12 §5，v0.3.3）走 AskUserService.resolve 结算；
    // 未知 / 已结算 requestId 幂等返回 false（本地卡与网页卡先到先得，settled=false 也算 ok）。
    resolveAsk: (input) => askUserService?.resolve(input) ?? false,
    // 服务器下发的文件落地（docs/12 §5，本轮 `file.send`）：拉回本机下载目录并通知用户。
    // 目标目录用系统「下载」目录（用户最熟悉的位置）；大小上限复用 `center.maxFileMb`。
    fileReceiver: {
      receive: async (input) => {
        const maxBytes = Math.max(1, settings!.get().center.maxFileMb) * 1024 * 1024
        try {
          const result = await downloadFileFromCenter({
            serverUrl: settings!.get().center.serverUrl,
            token: settings!.getSecret('center.token'),
            clientId: settings!.get().center.clientId,
            fileId: input.fileId,
            name: input.name,
            targetDir: app.getPath('downloads'),
            maxBytes,
          })
          logger?.info('已接收来自 Aurora Center 的文件', {
            fileId: input.fileId,
            name: input.name,
            size: result.size,
            path: result.path,
          })
          notify('已收到文件', `${input.name}\n${result.path}`, result.path)
          return { ok: true, path: result.path }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logger?.warn('接收来自 Aurora Center 的文件失败', {
            fileId: input.fileId,
            error: message,
          })
          return { ok: false, error: `E_IO: ${message}` }
        }
      },
    },
    applyRemotePatch: async (patch) => {
      const rehearsal = structuredClone(settings!.get())
      if (!applyWhitelistedPaths(rehearsal, patch)) return '配置结构无法应用该补丁'
      const updated = settings!.mutate((draft) => {
        void applyWhitelistedPaths(draft, patch)
      })
      if (updated === undefined) return '配置校验失败：请检查补丁内容'
      logger?.info('已应用来自 Aurora Center 的远程配置', { paths: Object.keys(patch) })
      return undefined
    },
    getRedactedConfig: () =>
      JSON.parse(JSON.stringify(centerSettings.exportRedacted())) as Record<string, unknown>,
    switchMode: async (mode) => {
      const result = await modes.setCurrent(mode)
      if (!result.ok) return result.message
      if (result.guideRequired) modes.requestGuideIfNeeded(mode, 'user-switch')
      logger?.info('已切换到来自 Aurora Center 的远程模式', { mode })
      return undefined
    },
    sessionHandler: {
      handleInput: async (message) => {
        const result = await sessionBridge!.handleInput(message)
        return {
          ok: result.ok,
          ...(result.data === undefined ? {} : { data: result.data }),
          ...(result.error === undefined ? {} : { error: result.error }),
        }
      },
      handleAbort: (message) => {
        const result = sessionBridge!.handleAbort(message)
        return {
          ok: result.ok,
          ...(result.data === undefined ? {} : { data: result.data }),
          ...(result.error === undefined ? {} : { error: result.error }),
        }
      },
    },
    // 远程会话管理（docs/12 §6.3，v0.2.3）：center- 前缀校验与门控在连接器，
    // 这里只管执行 —— 会话数据操作走 SessionStore，切换主界面走 chat:remoteActivate 推送。
    sessionManager: {
      listSessions: async () => {
        const all = await sessions!.summaries()
        return all
          .filter((summary) => summary.id.startsWith(CENTER_SESSION_PREFIX))
          .map((summary) => ({
            sessionId: summary.id,
            title: summary.title,
            updatedAt: summary.updatedAt,
            ...(summary.projectId === undefined ? {} : { projectId: summary.projectId }),
            ...(summary.permissionMode === undefined
              ? {}
              : { permissionMode: summary.permissionMode }),
            ...(summary.centerVisible === undefined
              ? {}
              : { centerVisible: summary.centerVisible }),
            // 会话级模型覆盖（docs/06 §3，本轮）：未覆盖不带键（网页端显示「跟随全局」）
            ...(summary.llm === undefined ? {} : { llm: summary.llm }),
          }))
      },
      activateSession: async (sessionId) => {
        // 兜底装载（docs/12 §6.3「会话未落盘时客户端兜底创建」）：get 会惰性读盘，
        // 盘上没有 = 登记为空会话（首条消息落盘时才真正创建文件，与本地新建同款）。
        await sessions!.get(sessionId)
        windows?.sendTo('chat', IPC.chat.remoteActivate, { sessionId })
        return { ok: true }
      },
      setVisibility: async (sessionId, visible) => {
        await sessions!.setCenterVisible(sessionId, visible)
        // 可见性变更同步（docs/12 §5 第 8 步，v0.2.4）：落盘成功后推 chat 渲染层
        // 重拉会话列表 —— 左栏按 `centerVisible === false` 过滤，不推送的话列表要等
        // 用户手动刷新才会消失/出现（与 activateSession 的推送套路相同）。
        windows?.sendTo('chat', IPC.chat.centerVisibilityChanged, { sessionId })
        return { ok: true }
      },
      setPermissionMode: async (sessionId, permissionMode) => {
        await sessions!.setPermissionMode(sessionId, permissionMode)
        return { ok: true }
      },
      setProject: async (sessionId, projectId) => {
        // 与 chat:setSessionProject 同一口径：绑到不存在的项目报错而不静默
        //（静默成功后解析链按「绑定已失效」回落全局，网页端却以为绑定生效了）
        if (
          projectId !== '' &&
          !settings!.get().projects.list.some((project) => project.id === projectId)
        ) {
          return { ok: false, error: 'E_INVALID_ARGUMENT: 项目不存在（可能已被删除）' }
        }
        await sessions!.setProject(sessionId, projectId)
        return { ok: true }
      },
      listProjects: () =>
        settings!.get().projects.list.map((project) => ({ id: project.id, name: project.name })),
      // 历史回放（docs/12 §5 第 7 步，v0.2.4；本轮加提问留痕）：
      // rendererHistoryWithAsks 过滤 tool/system 角色、把工具卡参数解析成对象，
      // 并把提问留痕按时间交错进去（`kind: 'ask'`），形状即协议的 CenterSessionHistoryMessage。
      // 上限 200 条防历史超长会话把回执 payload 撑爆；center- 前缀校验在连接器。
      history: async (sessionId) => {
        const messages = await sessions!.rendererHistoryWithAsks(sessionId, 200)
        return { ok: true, data: messages satisfies CenterSessionHistoryMessage[] }
      },
      readImage: async (sessionId, imageId) => {
        const image = await sessions!.displayImageOf(sessionId, imageId)
        if (image === undefined) return { ok: false, error: 'E_NOT_FOUND' }
        try {
          const data = await imageDisplayPort!.readImage({ path: image.path, sessionId })
          return { ok: true, data }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      },
      // llm.switch 的 handler（docs/12 §6.3）：只点改 active / model / reasoningEffort，
      // 绝不触碰 apiKeyEnc / baseUrl；settings.onChange 已驱动连接器重报 status。
      switchLlm: async (request) => {
        const current = settings!.get().llm
        const targetId = request.providerId ?? current.active
        // 四条前置守卫抽在 `llm-params.ts` 的纯函数里（`index.ts` 依赖 Electron，vitest 收不了，
        // 那段判定此前零覆盖）。语义与顺序见那个函数的注释。
        const rejection = llmSwitchRejection(current.providers, current.active, request)
        if (rejection !== undefined) return { ok: false, error: rejection }
        const updated = settings!.mutate((draft) => {
          if (request.providerId !== undefined) draft.llm.active = request.providerId
          const provider = draft.llm.providers[targetId]
          if (provider !== undefined) {
            // 先落 `model`，再写参数 —— 思考等级是**模型级**的（v23）：远端同时切模型与等级时，
            // 该等级要落在**新模型**名下，而不是留在旧模型那条上。
            if (request.model !== undefined) provider.model = request.model.trim()
            if (request.reasoningEffort !== undefined) {
              // 整份替换该模型条目（`withModelParams` 补齐缺的键）：`modelParams` 的
              // 三项一起写（半截条目会让另外两项被静默重置成默认值）。
              draft.llm.providers[targetId] = withModelParams(provider, {
                reasoningEffort: request.reasoningEffort,
              })
            }
          }
        })
        if (updated === undefined) return { ok: false, error: '配置校验失败：请检查补丁内容' }
        logger?.info('已应用来自 Aurora Center 的远程 LLM 切换', {
          providerId: request.providerId,
          modelChanged: request.model !== undefined,
          reasoningEffort: request.reasoningEffort,
        })
        return { ok: true }
      },
      // 会话级模型覆盖（docs/06 §3，本轮 `session.setModel`）：与 `chat:setSessionModel`
      // 同一口径 —— 写会话文件 meta.llm，不动全局 llm.active。`model` 空串 = 清除覆盖。
      setModel: async (sessionId, providerId, model) => {
        const trimmedModel = model.trim()
        const effectiveProviderId = providerId.trim() || settings!.get().llm.active
        // 清除路径（model 空）= 不校验 provider，直接删键
        if (trimmedModel === '') {
          await sessions!.setModelOverride(sessionId, null)
          return { ok: true }
        }
        if (settings!.get().llm.providers[effectiveProviderId] === undefined) {
          return { ok: false, error: 'E_INVALID_ARGUMENT: 模型配置不存在（可能已被删除）' }
        }
        await sessions!.setModelOverride(sessionId, {
          providerId: effectiveProviderId,
          model: trimmedModel,
        })
        return { ok: true }
      },
    },
    // 远程自动化管理（docs/13 §10）：复用自动化引擎的同一批方法（与 7.1.7 的
    // automationTools 端口同款闭包）。引擎在本函数下方 7.x 才装配，automationEngine
    // 是模块级变量 —— 全部经惰性闭包现取，不得在构造期解引用。
    automation: {
      list: async () => ({
        user: (await automationEngine?.listDefinitions()) ?? [],
        builtin: automationEngine?.listBuiltin() ?? [],
      }),
      catalog: () => automationEngine?.catalog() ?? { conditions: [], actions: [] },
      save: (input) =>
        automationEngine === undefined
          ? Promise.resolve({ ok: false as const, error: '自动化引擎尚未装配' })
          : automationEngine.saveDefinition(input),
      delete: (id) =>
        automationEngine === undefined
          ? Promise.resolve({ ok: false as const, error: '自动化引擎尚未装配' })
          : automationEngine.deleteDefinition(id),
      run: (id) =>
        automationEngine === undefined
          ? Promise.resolve({ ok: false as const, error: '自动化引擎尚未装配' })
          : automationEngine.runNow(id),
      history: (query) => automationEngine?.history(query) ?? Promise.resolve([]),
    },
    bindSessionEmit: (emit) => {
      sessionBridge?.bindEmit(emit)
      // 确认卡（docs/12 §5.1）与 session.event 共用同一条下发通道：连接器在线时
      // 绑定发送函数，断开时置 undefined —— center- 会话的确认请求据此静默跳过
      //（本地 chat 窗口的卡片照旧，确认不会挂起）。
      centerConfirmEmit = emit
    },
    // 网页端对确认卡的批复（docs/12 §5.1）走 proactive.resolve 结算；
    // 未知 / 已结算 confirmId 幂等返回 false（settled=false 也算 ok）。
    resolveConfirm: (confirmId, approved) =>
      proactiveScheduler?.resolve(confirmId, approved) ?? false,
    onStatusChange: (state) => {
      tray?.refresh()
      if (state === 'connected') void centerModelServices?.refresh()
    },
  })
  centerConnector.start()
  settings.onChange(() => centerConnector?.onConfigChanged())

  // 确认卡双通道（docs/12 §5 第 4 步）：center- 会话的敏感工具确认在本地卡片之外，
  // 同时经 CenterConnector 的 socket 推给 Center 网页端（路由给会话属主 + 管理员）。
  // v0.2.4 起 center_send_file 改为直接发送（不逐次确认），本地会话不再有需要推网页端
  // 的确认卡 —— 推送范围只剩 center- 前缀会话的其余敏感工具。
  // 两条通道并存、先到先得 —— proactive.resolve 对已结算 confirmId 幂等返回 false。
  proactiveScheduler.onRequest((request) => {
    if (!request.sessionId.startsWith(CENTER_SESSION_PREFIX)) return
    const emit = centerConfirmEmit
    if (emit === undefined) {
      // 连接器离线：入补发队列（FIFO 上限 20，重连后 flush），不再静默丢
      centerConnector?.enqueueConfirm(toConfirmRequest(request))
      return
    }
    try {
      emit(toConfirmRequest(request))
    } catch (error) {
      logger?.warn('向 Center 发送确认请求失败', { error: String(error) })
      centerConnector?.enqueueConfirm(toConfirmRequest(request))
    }
  })

  // 提问卡双通道（docs/12 §5，v0.3.3）：`center-` 会话里 `ask_user` 提问时，本地卡片之外
  // 同时经同一连接器推给 Center 网页端（路由给会话属主 + 管理员）。判定逻辑（前缀过滤 /
  // 闸门 / 离线入队）抽在 `center/ask-relay.ts` 里，理由见那个文件的头注释。
  // 与确认卡的区别是**闸门更严**：`center.allowRemoteSession` 关闭时整条通道静默
  //（不下行、也拒绝网页作答，见 connector 的 ask.resolve 分支）—— 本地卡照常显示，
  // 用户在本机答即可。
  askUserService?.onRequest(
    createAskRelay({
      emit: () => centerConfirmEmit,
      allowRemoteSession: () => settings!.get().center.allowRemoteSession,
      enqueue: (message) => centerConnector?.enqueueAsk(message),
      ...(logger === undefined ? {} : { logger }),
    }),
  )
  // 提问在本地结算（本轮，docs/12 §5）：上行 `ask.settled`，让网页端的卡片立即收起 ——
  // 此前网页卡只能靠自己的倒计时，本地先答了它也不知道。闸门与上行同源（仅 center- 会话
  // + allowRemoteSession），离线不入队（结算通知过期即无意义，见 createAskSettleRelay）。
  askUserService?.onSettle(
    createAskSettleRelay({
      emit: () => centerConfirmEmit,
      allowRemoteSession: () => settings!.get().center.allowRemoteSession,
      ...(logger === undefined ? {} : { logger }),
    }),
  )
  // 提问留痕（本轮，docs/12 §5）：**只对 `center-` 会话**落盘 —— 留痕的消费方是
  // Center 的历史回放（`session.history` 的 `kind: 'ask'` 条目）；本地会话的提问卡
  // 是刻意的瞬时卡片，给它们写 sidecar 只会让本地会话文件白长。
  //
  // 提问原文在这里先记一份（结算事件只带 requestId / 作答 / 结算原因），
  // 键是 requestId，结算后立刻删；上限 50 条兜住"提问后客户端直接退出"的泄漏。
  askUserService?.onRequest((request) => {
    if (!request.sessionId.startsWith(CENTER_SESSION_PREFIX)) return
    if (askQuestionText.size >= 50) {
      const oldest = askQuestionText.keys().next().value
      if (oldest !== undefined) askQuestionText.delete(oldest)
    }
    askQuestionText.set(request.requestId, {
      question: request.question,
      ...(request.header === undefined ? {} : { header: request.header }),
      ...(request.options === undefined ? {} : { options: request.options }),
      multiSelect: request.multiSelect,
      createdAt: new Date(request.expiresAt - ASK_USER_TIMEOUT_MS).toISOString(),
    })
  })
  askUserService?.onSettle((event) => {
    if (!event.sessionId.startsWith(CENTER_SESSION_PREFIX)) return
    const question = askQuestionText.get(event.requestId)
    const settledAt = new Date().toISOString()
    sessions?.appendAskRecord(event.sessionId, {
      requestId: event.requestId,
      question: question?.question ?? '',
      ...(question?.header === undefined ? {} : { header: question.header }),
      ...(question?.options === undefined ? {} : { options: question.options }),
      multiSelect: question?.multiSelect === true,
      answers: [...event.answers],
      ...(event.answersByQuestion === undefined
        ? {}
        : { answersByQuestion: event.answersByQuestion.map((group) => [...group]) }),
      outcome: event.outcome,
      createdAt: question?.createdAt ?? settledAt,
      settledAt,
    })
    askQuestionText.delete(event.requestId)
  })

  // 7.2 分类管线装配（docs/05 §3、docs/02 §5.2）
  //     chokidar 监听 → 并发队列 → utilityProcess 内容提取 → 规则/LLM 判定 → 落盘 → 通知
  notifications = new NotificationService({
    logger: logger.child('notify'),
    present: createNotificationPresenter(),
    openPath: (target) =>
      shell.openPath(target).then((error) => {
        if (error !== '') throw new Error(error)
      }),
  })
  extractPool = new ExtractPool({
    fork: () =>
      utilityProcess.fork(join(__dirname, 'extract-worker.js'), [], {
        serviceName: 'aurora-extract',
      }) as unknown as ExtractWorkerChild,
    logger: logger.child('extract'),
  })
  const classificationHistory = new ClassificationHistory({
    dir: userData,
    logger: logger.child('classification-history'),
  })
  await classificationHistory.init()
  classification = new ClassificationService({
    getSettings: () => settings!.get(),
    extract: (input) => extractPool!.extract(input),
    // 复用 Agent 的 provider 工厂：模型 / Key 改动后分类立即跟着变
    providerFactory: createClassifyFactory(createProviderFactory(settings, logger.child('llm'))),
    history: classificationHistory,
    notifications: notifications,
    fs: {
      exists: async (path) => {
        try {
          await fs.access(path)
          return true
        } catch {
          return false
        }
      },
      ensureDir: async (path) => {
        await fs.mkdir(path, { recursive: true })
      },
      rename: async (from, to) => {
        await fs.rename(from, to)
      },
      copy: async (from, to) => {
        await fs.copyFile(from, to)
      },
      remove: async (path) => {
        await fs.rm(path, { force: true })
      },
      sizeOf: async (path) => {
        try {
          const stat = await fs.stat(path)
          return stat.isDirectory() ? undefined : stat.size
        } catch {
          return undefined
        }
      },
    },
    logger: logger.child('classification'),
    suppressPath: (path) => fileWatcher?.suppress(path),
  })

  fileWatcher = new AuroraFileWatcher({ logger: logger.child('watcher') })
  fileWatcher.onAdd((file) => classification?.handleFile(file))

  // 7.3 自动更新（docs/09）：electron-updater 适配层 + 状态机
  updater = new UpdateService({
    port: createUpdaterPort(logger.child('updater'), {
      centerFeed: () => {
        const center = settings?.get().center
        if (center === undefined || !center.enabled || center.serverUrl.trim() === '') {
          return undefined
        }
        const base = httpBaseUrlOf(center.serverUrl)
        return base === undefined ? undefined : `${base.replace(/\/+$/, '')}/api/updates`
      },
    }),
    currentVersion: app.getVersion(),
    logger: logger.child('updater'),
    // 自测/发布验证用：允许把"启动后延迟自动检查"调短（默认 20s）
    ...(readAutoCheckDelay() === undefined ? {} : { autoCheckDelayMs: readAutoCheckDelay() }),
  })

  // 7.4 全局快捷键（docs/07 §5）：`general.hotkey` 之前只是个存了不注册的死字段
  hotkeys = new HotkeyManager({
    port: {
      register: (accelerator, handler) => globalShortcut.register(accelerator, handler),
      unregister: (accelerator) => globalShortcut.unregister(accelerator),
      unregisterAll: () => globalShortcut.unregisterAll(),
    },
    // 切换交互窗显隐：与托盘左键同一动作，用户习惯一致
    onTrigger: () => {
      logger?.debug('全局快捷键触发：切换交互窗')
      windows?.toggle('chat')
    },
    logger: logger.child('hotkey'),
  })
  hotkeys.apply(settings.get().general.hotkey)

  // 7.5 课前提醒（docs/05 §3.4）：按课程表在课前 5 分钟通知并打开科目文件夹
  //
  // 自测（smokeMode）下把"打开文件夹"记为**真实回执**而不是真的弹资源管理器：
  // 无头/CI 环境弹出资源管理器没有意义，但"到底有没有调用打开"必须可观测，
  // 否则"自动打开科目文件夹"这条验收就只能靠看代码。
  let preClassOpened = false
  // 7.x 自动化引擎（docs/13）：定义 / 历史存 `<userData>/automations/`，Agent 触发复用
  //     `agent`（origin: 'automation'），内置「课前提醒 / 课前打开科目文件夹」由引擎承接
  //     （旧 PreClassReminder 服务的语义等价迁移，启停条件现读既有配置字段）。
  automationStore = new AutomationStore({
    dir: join(userData, 'automations'),
    fs: nodeFileSystem,
    logger: logger.child('automations'),
  })
  const automationActionPorts: AutomationActionPorts = {
    notify: (request) => notifications?.notify(request) ?? false,
    classisland: {
      available: () => isClassIslandActive(),
      notify: (request) => classIslandNotifierFor().notify(request),
    },
    openPath: async (target) => {
      if (smokeMode) {
        preClassOpened = true
        logger?.info('自测：跳过真实打开文件夹，已记录回执', { target })
        return
      }
      const error = await shell.openPath(target)
      if (error !== '') throw new Error(error)
    },
    openExternal: async (url) => {
      if (smokeMode) {
        logger?.info('自测：跳过真实打开网址，已记录回执', { url })
        return
      }
      await shell.openExternal(url)
    },
    resolveSubjectDir: (subjectName) => {
      const classroom = settings!.get().modes.classroom
      const subject = classroom.subjects.find((item) => item.name === subjectName)
      return resolveSubjectFolder(classroom.watchDir, subject?.folder ?? '')
    },
    logger: logger.child('automation-actions'),
  }
  automationEngine = new AutomationEngine({
    store: automationStore,
    agent: agent!,
    settings: () => settings!.get(),
    provider: () => currentScheduleProvider(),
    actions: automationActionPorts,
    logger: logger.child('automation'),
    onDefinitionsChanged: () => {
      automationDefinitionListeners.forEach((listener) => listener())
    },
    onHistoryChanged: () => {
      automationHistoryListeners.forEach((listener) => listener())
    },
    // 自测诊断（docs/13 §13）：把每次运行的落库 / 收尾拷一份到内存环形缓冲
    onRunRecorded: (run) => {
      if (!smokeMode) return
      const index = automationRunLog.findIndex((item) => item.id === run.id)
      if (index === -1) automationRunLog.unshift(run)
      else automationRunLog[index] = run
      if (automationRunLog.length > 20) automationRunLog.length = 20
    },
    ...(smokeMode
      ? {
          onBuiltinFired: (info: {
            builtinId: string
            subject: string
            minutesUntil: number
            targetDir: string
          }) => {
            preClassFired.unshift({ ...info, opened: preClassOpened })
            if (preClassFired.length > 10) preClassFired.length = 10
          },
        }
      : {}),
  })
  automationEngine.start()

  const deps: DesktopDeps = {
    settings,
    windows,
    modes,
    guides,
    agent,
    perception,
    llm,
    tts,
    stt: sttService,
    imagegen: imageGenService,
    skills: skillsService,
    sessions,
    sessionTitles,
    readDisplayImage: async ({ sessionId, imageId }) => {
      const image = await sessions!.displayImageOf(sessionId, imageId)
      if (image === undefined) throw new Error('图片不存在或已被会话清理')
      return imageDisplayPort!.readImage({ path: image.path, sessionId })
    },
    classification,
    proactive: adaptProactive(proactiveScheduler),
    // Agent 向用户提问（docs/06 §21）：`ask:answer` 回执 + `askUser:request` 推送。
    // 与内核端口是**同一个实例**（见 askUserService 的声明处注释）。
    ...(askUserService === undefined ? {} : { askUser: askUserService }),
    hotkey: hotkeys,
    // 写前快照（docs/06 §11.8）：ipc 的 snapshots:* 三条通道用它；配置变了由 ensureSnapshotPort 换实例
    jobs: jobStore,
    // 删除会话时级联清理任务清单（docs/06 §18）：与 todo 工具共用同一个端口实例。
    ...(todoPort === undefined ? {} : { todoCleanup: todoPort }),
    // 快照**回滚**路径的项目根边界（P2-07，docs/06 §11.8）：与 file-port / run_command
    // 同一个取值器（别再抄第二份），按快照所属会话现解析
    snapshotGuard: {
      workspaceRoot: (sessionId) => sessionProjects.boundaryRoot(sessionId),
      logger: logger.child('snapshots'),
    },
    // `/init` 内置命令的生成目标目录（docs/06 §6）：同一条 boundaryRoot 回落链，
    // 与快照 guard、file-port 边界同源（别再抄第二份解析）
    workspaceRootOf: (sessionId) => sessionProjects.boundaryRoot(sessionId),
    snapshots: {
      capture: (input) => ensureSnapshotPort().capture(input),
      list: (query) => ensureSnapshotPort().list(query),
      readContent: (ref) => ensureSnapshotPort().readContent(ref),
      prune: (sessionId) => ensureSnapshotPort().prune(sessionId),
      flush: () => ensureSnapshotPort().flush(),
    },
    classisland: {
      enabled: () => isClassIslandActive(),
      status: () => classIslandStatus(),
      test: () => testClassIsland(),
      // 提醒通道（v3，docs/05 §3.4）：`classisland:notify` 与 `classisland_remind` 工具共用
      notify: (request) => classIslandNotifierFor().notify(request),
    },
    // 自动化（docs/13 §9）：引擎的 IPC 切片（list / save / delete / history / run / catalog + 两路推送）
    automation: {
      list: async () => ({
        user: (await automationEngine?.listDefinitions()) ?? [],
        builtin: automationEngine?.listBuiltin() ?? [],
      }),
      save: (input) =>
        automationEngine === undefined
          ? Promise.resolve({ ok: false as const, error: '自动化引擎尚未装配' })
          : automationEngine.saveDefinition(input),
      delete: (id) =>
        automationEngine === undefined
          ? Promise.resolve({ ok: false as const, error: '自动化引擎尚未装配' })
          : automationEngine.deleteDefinition(id),
      history: (query) => automationEngine?.history(query) ?? Promise.resolve([]),
      run: (id) =>
        automationEngine === undefined
          ? Promise.resolve({ ok: false as const, error: '自动化引擎尚未装配' })
          : automationEngine.runNow(id),
      catalog: () => automationEngine?.catalog() ?? { conditions: [], actions: [] },
      onDefinitionsChanged: (listener) => {
        automationDefinitionListeners.add(listener)
        return () => {
          automationDefinitionListeners.delete(listener)
        }
      },
      onHistoryChanged: (listener) => {
        automationHistoryListeners.add(listener)
        return () => {
          automationHistoryListeners.delete(listener)
        }
      },
    },
    awareness: fileAwareness!,
    mcpStatus: () => mcp?.statuses() ?? [],
    onMcpStatusChanged: (listener) => {
      mcpStatusListeners.add(listener)
      return () => {
        mcpStatusListeners.delete(listener)
      }
    },
    updater,
    center: {
      status: () => centerStatus(),
      login: (request) => centerLogin(request),
      // 设备授权登录（docs/12 §4.3）：触发后立即回执，最终结果走 deviceLoginResult 推送
      deviceLogin: (request) => startCenterDeviceLogin(request),
      onDeviceLoginResult: (listener) => {
        deviceLoginListeners.add(listener)
        return () => {
          deviceLoginListeners.delete(listener)
        }
      },
      deviceLoginCancel: () => {
        deviceLoginController?.cancel()
        return Promise.resolve(ok(true))
      },
      modelServices: () => centerModelServices?.current() ?? null,
      refreshModelServices: () => centerModelServices?.refresh() ?? Promise.resolve(null),
      onModelServicesChanged: (listener) => {
        centerModelServicesListeners.add(listener)
        return () => {
          centerModelServicesListeners.delete(listener)
        }
      },
      onRuntimeNotice: (listener) => {
        centerRuntimeNoticeListeners.add(listener)
        return () => {
          centerRuntimeNoticeListeners.delete(listener)
        }
      },
    },
    logger: logger.child('ipc'),
    paths,
    isDev,
    smokeMode,
    visionEnabled: () => visionEnabled(centerSettings.get()),
    smokeDiagnostics: () => ({
      enabled: true,
      preClassFired: smokeMode ? [...preClassFired] : undefined,
      automationRuns: smokeMode ? [...automationRunLog] : undefined,
    }),
    onQuit: () => app.quit(),
    // 附件提取（docs/07 §2.3）：复用分类管线的提取器（同一份 officeparser 能力），
    // 走 utilityProcess 池以免一个几十 MB 的 PDF 卡住主进程事件循环。
    attachmentExtract: async (path) => {
      const { basename, extname } = await import('node:path')
      const fileName = basename(path)
      const ext = extname(path).replace(/^\./, '').toLowerCase()
      try {
        const stat = await fs.stat(path)
        if (!stat.isFile()) return { path, fileName, note: '不是文件' }
        const result = await extractPool!.extract({
          path,
          ext,
          sizeBytes: stat.size,
        })
        const warnings = result.warnings ?? []
        return {
          path,
          fileName,
          ...(result.evidence.trim() === '' ? {} : { text: result.evidence }),
          ...(warnings.length > 0 ? { note: warnings.join('；') } : {}),
        }
      } catch (error) {
        return { path, fileName, note: `提取失败：${String(error)}` }
      }
    },
    onSettingsChanged: (next) => {
      // 高级页的三项「真生效」路径（docs/08 §6）：
      // 日志级别热改、代理即时重应用、提示条透明度重新取值。
      logger?.setLevel(next.advanced.logLevel)
      void applyAdvancedNetwork(next.advanced.proxy)
      windows?.applyEdgeBarOpacity(next.general.edgeBar.opacity)
      // 外观三件套（v32，docs/07 §5.1）：档位落到 `nativeTheme.themeSource`、
      // 毛玻璃开关即时摘 / 挂原生材质（幂等，值没变时内部直接返回）。
      // 渲染层那半走 `settings:changed` 广播 → settings store 的 watch，不需要在这里推。
      syncThemeSource()
      windows?.applyGlass(next.appearance.glass)
      // 快捷键改绑（幂等：值没变时内部直接返回，不会闪断）
      hotkeys?.apply(next.general.hotkey)
      if (!next.general.edgeBar.enabled) windows?.hide('edge-bar')
      // Skill 用户目录可能被改（`skills.userDir`），按新配置重解析并重扫
      void skillsService?.reconfigure(next)
      syncLaunchAtLogin(next.general.launchAtLogin)
      // 电脑操控工具（docs/06 §11）+ `set_setting`（docs/06 §12）：开关 / 超时 / 上限改完立即生效
      // ——重建工具实例，工具表变化会进下一次请求的系统提示词，无需重启。
      syncToolRegistries()
      tray?.refresh()
      // 感知文件夹 / 科目 / 阈值变更后，让分类管线按新配置重新武装
      syncClassification()
      void fileAwareness?.reconfigure()
      gameMode?.reconfigure()
    },
  }
  // 右栏「终端」（docs/07 §2.3）：PTY 常驻 shell 服务；cwd 走会话工作目录回落链。
  // 刻意在 registerIpc **之前**创建：handlers 在调用时才读 deps.terminal，
  // 但先建好能让「注册即注入」的顺序看得见，不留一个可被踩中的中间态。
  terminalService = new TerminalService({
    logger: logger.child('terminal'),
    rootOf: (sessionId) => sessionProjects.boundaryRoot(sessionId),
  })
  deps.terminal = terminalService
  desktopDeps = deps
  disposeIpc = registerIpc(deps)

  // 8. 托盘
  tray = createTray(deps, resolveTrayIcon())
  modes.onChange(() => {
    tray?.refresh()
    // 切到 / 离开 ClassRoom 都要调整文件监听
    syncClassification()
  })
  settings.onChange(() => tray?.refresh())

  // 8.1 分类管线：按当前模式与感知文件夹启动监听并武装队列（docs/05 §3.1）
  syncClassification()

  // 8.2 开机自启：必须在 ready 之后调用（docs/04 §P1）
  syncLaunchAtLogin(settings.get().general.launchAtLogin)

  // 8.2.1 提示条透明度与独立勿扰时段（docs/07 §2.2、docs/08 §1）：
  //       透明度立即应用；勿扰由 EdgeBarScheduler 每 30s 判定，与 advanced.quietHours 相互独立。
  windows.applyEdgeBarOpacity(settings.get().general.edgeBar.opacity)
  // 外观档位（v32）：建窗时 `WindowManager` 已按 `appearance.*` 取过值，这里补一次
  // 主题同步 —— `bootstrap()` 早期把 themeSource 定在 `system`，配置读完要落到用户档位。
  // 毛玻璃那半不需要：窗口还没创建时建窗路径就会读到正确值（`applyGlass` 只管已存在的窗口）。
  syncThemeSource()
  edgeBarScheduler = new EdgeBarScheduler({
    // 首次引导期间不显示提示条：那时用户还没配好模型，竖条只会挡视线
    enabled: () => settings!.get().general.edgeBar.enabled && settings!.needsOnboarding() === false,
    quietHours: () => settings!.get().general.edgeBar.quietHours,
    show: () => windows?.show('edge-bar'),
    hide: () => windows?.hide('edge-bar'),
    logger: logger.child('edge-bar'),
  })
  edgeBarScheduler.start()
  fileAwareness.onChanged(syncAwarenessGlow)
  windows.onStateChanged(syncAwarenessGlow)
  settings.onChange(syncAwarenessGlow)
  syncAwarenessGlow()

  // 8.2.2 游戏模式联动（docs/06 §8.3）：进入游戏时隐藏提示条并挂起文件自感知，
  //       退出后恢复。检测放在单条常驻 PowerShell 子进程里，避免周期性新建进程。
  let gameModeEdgeBarWasVisible = false
  gameMode = new GameModeController({
    enabled: () => settings!.get().general.gameMode.enabled,
    watcher: new WindowsGameModeWatcher({ logger: logger.child('game-mode') }),
    logger: logger.child('game-mode'),
    enter: async () => {
      gameModeEdgeBarWasVisible = windows?.isVisible('edge-bar') === true
      if (gameModeEdgeBarWasVisible) windows?.hide('edge-bar')
      await fileAwareness?.suspend()
      logger?.info('检测到游戏，已进入游戏模式', {
        edgeBarWasVisible: gameModeEdgeBarWasVisible,
      })
    },
    exit: async () => {
      await fileAwareness?.resume()
      const current = settings!.get()
      const canRestoreEdgeBar =
        gameModeEdgeBarWasVisible &&
        current.general.edgeBar.enabled &&
        settings!.needsOnboarding() === false &&
        !isQuietHour(new Date(), current.general.edgeBar.quietHours)
      if (canRestoreEdgeBar) windows?.show('edge-bar')
      logger?.info('游戏模式已退出，已恢复后台服务', {
        edgeBarRestored: canRestoreEdgeBar,
      })
      gameModeEdgeBarWasVisible = false
    },
  })
  gameMode.start()

  // 8.3 自动更新：延迟静默检查（不阻塞启动），并在有更新时通知托盘
  updater.scheduleAutoCheck()

  // 9. 首次引导 / 正常启动
  if (report.needsOnboarding) {
    logger.info('未配置 AI 模型，进入首次引导')
    windows.show('onboarding')
  } else {
    // 常驻入口收敛为提示条 + 托盘：提示条按配置显示，交互窗由用户按需呼出
    if (settings.get().general.edgeBar.enabled) windows.show('edge-bar')
    modes.requestGuideIfNeeded(settings.get().modes.current, 'startup')
  }

  // 引导刚结束（或本就在正常态）时立刻重算一次提示条可见性：
  // 上面的 `needsOnboarding()` 守卫会让首次启动的 tick 判定为不可见
  edgeBarScheduler?.tick()
  syncAwarenessGlow()

  logger.info('Aurora 就绪')

  // 10. 视觉核对（AURORA_CAPTURE=<目录>，仅开发态）：截完四个窗口 + 设置页各页后退出。
  //     与 AURORA_SMOKE 互斥：两者都会在结束时退出进程，同开只会互相抢窗口。
  const captureDir = process.env['AURORA_CAPTURE']
  if (isDev && captureDir !== undefined && captureDir.trim() !== '') {
    void runCapture(captureDir.trim())
  } else if (isDev && process.env[SMOKE_FLAG] === '1') {
    // 11. 开发自测（AURORA_SMOKE=1）：在真实渲染进程里跑一遍关键链路后退出
    void runSmokeTest(userData)
  }
}

/**
 * 视觉核对（`AURORA_CAPTURE=<目录> pnpm dev`，docs/07 §5）：
 * 把四个窗口 + 提示条两态 + 设置页各页截成 PNG 后退出，供前端视觉验收用。
 *
 * 只用 `webContents.capturePage()`，不依赖屏幕是否可见 / 是否被别的窗口遮挡，
 * 因此可以在自动化流程里跑，也不会把用户的桌面状态当成断言依据。
 */
/** 截图模式下的本地桩 LLM（只有 `chat-stream.png` 场景会用；进程退出即结束） */
let captureStub: StubLlmServer | undefined

async function runCapture(dir: string): Promise<void> {
  if (windows === undefined) {
    logger?.error('截图失败：窗口管理器尚未就绪')
    app.exit(1)
    return
  }
  const manager = windows
  // TTS 场景的现场准备必须在跑计划**之前**做完：`SessionStore` 首次读会话即缓存，
  // 而交互窗 onMounted 就会读一次，计划开始后再写文件已经晚了（见 defaultCapturePlan 注释）。
  // `app.getPath('userData')` 在隔离模式下就是那个临时目录（见文件头注释）。
  await seedChatTtsHistory(app.getPath('userData'))
  /**
   * 自感知工作台截图现场：状态、最近理解、队列和记忆数都要有真实内容。
   * state.json 必须在 FileAwarenessService 首次读取前落地；配置更新后再 init()
   * 让运行中的服务重新读取夹具，而不是只让设置页看到开关。
   */
  const captureUserData = app.getPath('userData')
  await seedMemoryFixture(captureUserData)
  await fileAwareness?.init()
  if (settings !== undefined) {
    const current = settings.get()
    settings.update({
      fileAwareness: {
        ...current.fileAwareness,
        enabled: true,
        contentConsentAccepted: true,
        watchedDirs: [join(captureUserData, 'memory-fixture')],
        knowledgeDir: join(captureUserData, 'memory-fixture'),
        includeRecent: true,
        suggestionsEnabled: true,
      },
    })
    await settings.flush()
  }
  // ClassIsland 课堂状态卡的夹具（同上：必须在窗口首次读之前落盘）
  await seedClassIslandFixture(app.getPath('userData'))
  // 「任务」面板的 paused job 夹具（v15，docs/06 §4.1）：**同样必须在窗口首次读之前**——
  // 任务面板挂载时会调 `chat:jobs`，而 `FileJobStore` 首读即缓存（读到空表后再写文件它看不见，
  // 表现为"面板一直显示暂无任务"）。种在这里而不是场景 prepare 里，就是为了抢在那个首读之前。
  await seedJobFixture(app.getPath('userData'))
  // 自动化夹具（docs/13 §11）：1 份 Normal 定义 + 2 条历史 + 1 个 `auto-` 会话。
  // ⚠️ 与其它夹具不同，这里种完之后必须 **reload 一次**：引擎在 `bootstrap()` 里就已启动、
  // 首读即缓存空表（`AutomationStore.ensureLoaded` 的 in-flight 语义），
  // 不重读的话「夹具写了、界面照样是空的」（本场景首跑实测就是 0 条）。
  await seedAutomationFixture(app.getPath('userData'))
  await automationEngine?.reload()
  // `ask_user` 提问卡片场景（docs/06 §21）需要**主进程发起一次真实提问**：
  // capture.ts 拿不到这里的服务实例（循环依赖），所以由这边反向注册一个 spawner。
  // 注册的是同一个 `askUserService`（内核端口与 ipc 依赖的那个实例），
  // 因此探针点「回答」走的正是生产那条回执链。
  registerAskUserSpawner(async () => {
    const service = askUserService
    if (service === undefined) return { answers: [], skipped: true }
    return service.ask(ASK_USER_CAPTURE_QUESTION, { sessionId: 'main' })
  })
  // 输入框 → 真实（离线桩）模型往返场景：**排在计划最后**，因为它在 prepare 里把
  // `llm.active` 换成桩服务（前面的场景读到的是「未配置模型」的出厂态，不受影响）。
  // 为什么值得单列一个场景：`AURORA_SMOKE` 的断言跑在引导窗里、读不到对话窗 DOM，
  // 而两个模式互斥 —— 「事件层对了但界面没画出来」只有这里能抓到（见 capture.ts 的探针注释）。
  //
  // 桩配置抽成一处：下面三条场景（往返 / 爆发 / 轨迹折叠）**同走这条离线桩链路**，
  // 三条各自的 prepare 只该表达"用桩"，配置细节（provider 形状、凭据、reload 时机）只写一份。
  const useCaptureStub = async (): Promise<void> => {
    captureStub ??= await startStubLlmServer(logger?.child('capture-llm'))
    // `llm.providers` 是 record：给新 id 是「新增」，既有的 capture provider 不受影响
    settings?.update({
      llm: {
        active: 'capture-stub',
        providers: {
          'capture-stub': {
            type: 'openai-compat',
            baseUrl: captureStub.baseUrl,
            apiKeyEnc: '',
            model: STUB_MODEL,
            modelList: [STUB_MODEL],
            // 生成参数按**模型 id** 键（v23）。三项都要写全：`reasoningEffort` 是三个子字段里
            // 三项都写全，别留下半截条目。
            modelParams: {
              [STUB_MODEL]: {
                reasoningEffort: 'auto',
                // 故意给一个窗口值：本链路顺带钉住「占用比例」那一半（分母来自配置）
                contextWindow: 128_000,
                // 自测链路上关闭图片输入
                vision: false,
              },
            },
          },
        },
      },
    } as Partial<Settings>)
    settings?.setSecret('llm.providers.capture-stub.apiKey', STUB_API_KEY)
    await settings?.flush()
    // 配置改完必须 reload 让渲染层重新水合：`SettingsStore` 启动就把 config.json 读进内存，
    // 计划开始后再改文件对已运行的进程无效（AGENTS.md 的「两个缓存」那条）。
    await manager.reload('chat', {})
  }
  const chatStreamTarget: CaptureTarget = {
    name: 'chat',
    file: 'chat-stream.png',
    prepare: useCaptureStub,
    act: chatStreamAct('/system-status 我电脑现在什么状态'),
    check: chatStreamCheck(STUB_MARKER, REASONING_MARKER),
  }
  /**
   * 轨迹自动折叠（2026-10-01 用户实测的 bug）：**有工具调用、没有思考增量**的那一轮，
   * 流式结束后轨迹必须收成一行摘要。
   *
   * 为什么单列一条：桩服务的默认分流每轮都发 `reasoning_content`，而原先的收尾逻辑只收
   * 「思考增量到达时被打开过的」消息 —— 这个分支在既有场景里**一次都没被覆盖**，
   * 于是 bug 能在 34 条探针全 PASS 的情况下活下来（见 `CHAT_TRACE_FOLD_CHECK` 的注释）。
   * 提问走 `SKILL_ONLY_MARKER` 分流：第 1 轮只要一次 `use_skill`（无权限面），第 2 轮纯正文。
   */
  const chatTraceFoldTarget: CaptureTarget = {
    name: 'chat',
    file: 'chat-trace-fold.png',
    prepare: useCaptureStub,
    act: chatStreamAct(`${SKILL_ONLY_MARKER} 用一个技能查一下系统状态`),
    check: CHAT_TRACE_FOLD_CHECK,
  }
  // 1-D 爆发场景：与 chat-stream 同一条离线桩链路，但按真实推理模型的密度（150 + 150 片、
  // 5ms 一片）喷思考与正文 —— 这是「渲染跟不上输出」唯一能复现的现场，measure 见探针注释。
  // 排在 chat-stream **之后**：它沿用同一条会话（main），前面的现场对后续无害。
  const burstProbeQuestion = 'burst-probe 请把这段话一字不差地念完'
  const chatBurstTarget: CaptureTarget = {
    name: 'chat',
    file: 'chat-stream-burst.png',
    prepare: useCaptureStub,
    act: chatStreamBurstAct(burstProbeQuestion),
    check: chatStreamBurstCheck({
      textStart: BURST_TEXT_START_MARKER,
      textEnd: BURST_TEXT_END_MARKER,
      reasoningStart: BURST_REASONING_START_MARKER,
      reasoningEnd: BURST_REASONING_END_MARKER,
    }),
  }
  const chatAutoTitleTarget: CaptureTarget = {
    name: 'chat',
    file: 'chat-auto-title.png',
    prepare: useCaptureStub,
    act: chatAutoTitleAct('请帮我整理高数错题'),
    check: CHAT_AUTO_TITLE_CHECK,
  }
  // 场景级过滤：`AURORA_CAPTURE_ONLY=<文件名子串, ...>`；特殊值 `failed` = 只重跑上次
  // `report.json` 里没过的那几张（修完一轮只重验红的，不必全量重跑五六十张）。
  // ⚠️ `failed` 落在"上次全绿"时得到的是**空数组**，那表示"没有要重验的"，
  // 不是"没匹配上"—— 传空串会被 `filterCapturePlan` 当成全选，等于偷偷全量重跑。
  // ⚠️ 反过来，**没设** `AURORA_CAPTURE_ONLY` 必须解析成 `undefined`（= 不过滤），
  // 不能交给 `parseCaptureTokens('')` 得到 `[]` —— 空数组在 `filterCapturePlan` 里
  // 是「一个都不匹配」，于是 `AURORA_CAPTURE=<dir> pnpm dev`（文档里的标准全量用法）
  // 会静默一张都不截（实测：`开始窗口截图 {"count":0}` + 退出码 0）。
  const captureOnlyRaw = (process.env['AURORA_CAPTURE_ONLY'] ?? '').trim()
  const captureOnly =
    captureOnlyRaw === ''
      ? undefined
      : captureOnlyRaw === 'failed'
        ? await failedCaptureFiles(dir)
        : parseCaptureTokens(captureOnlyRaw)
  const plan = filterCapturePlan(
    [
      // 项目卡已下线（2026-09-30）：项目现场改由 capture.ts 内部的 settingsProjectAct
      // 走 `settings:update` IPC 自建，装配层不再注入配置层钩子
      ...defaultCapturePlan(manager, app.getPath('userData')),
      chatStreamTarget,
      chatTraceFoldTarget,
      chatBurstTarget,
      chatAutoTitleTarget,
      // 记忆库独立窗口放在性能场景之后：多一个可见渲染窗口会污染 burst 的帧间隔读数。
      {
        name: 'memory',
        file: 'memory-window.png',
        prepare: async () => {
          await seedMemoryFixture(app.getPath('userData'))
          await fileAwareness?.init()
          await manager.reload('memory', {})
        },
        check: MEMORY_WINDOW_CHECK,
        nativeCheck: nativeGlassCheck(manager, 'memory'),
      },
      {
        name: 'memory',
        file: 'memory-expire-now.png',
        act: MEMORY_EXPIRE_ACT,
        check: MEMORY_EXPIRE_CHECK,
      },
      {
        name: 'awareness-glow',
        file: 'awareness-glow.png',
        query: {
          preview: '1',
          holdMs: process.env['AURORA_GLOW_PREVIEW_MS'] ?? '1100',
        },
        act: AWARENESS_GLOW_SETTLE_ACT,
        check: AWARENESS_GLOW_CAPTURE_CHECK,
        nativeCheck: () => {
          const state = manager.getAwarenessGlowDiagnostics()
          // v33：四边流光的宿主前提是「窗口覆盖整块显示器」——渲染层读不到原生窗口矩形，
          // 所以这一条必须由主进程断言（只量矩形：72px 顶部条的旧几何会在这里立刻变红）。
          // 期望值取 `manager` 的同一个取屏口径（提示条可配置为跟随光标所在显示器）。
          // 容差 1px：Electron 给窗口矩形与显示器 bounds 之间留的这一像素差是既存行为，
          // 不是"没贴住"（贴边判定看的是窗口 ≥ 显示器，而不是逐像素相等）。
          const target = manager.getAwarenessGlowTargetBounds()
          const bounds = state.bounds
          const coversDisplay =
            bounds !== undefined &&
            bounds.x <= target.x &&
            bounds.y <= target.y &&
            bounds.x + bounds.width >= target.x + target.width &&
            bounds.y + bounds.height >= target.y + target.height
          return {
            pass:
              state.exists &&
              state.visible &&
              state.alwaysOnTop === true &&
              state.focused === false &&
              state.mousePassthrough &&
              coversDisplay,
            coversDisplay,
            targetBounds: `${target.x},${target.y},${target.width},${target.height}`,
            ...state,
          }
        },
      },
      {
        name: 'settings',
        file: 'settings-awareness-records.png',
        query: { page: 'awareness' },
        act: SETTINGS_AWARENESS_RECORDS_ACT,
        check: SETTINGS_AWARENESS_RECORDS_CHECK,
      },
    ],
    process.env['AURORA_CAPTURE_WINDOWS'],
    captureOnly,
  )
  const nothingDue = plan.length === 0 && captureOnlyRaw === 'failed'
  logger?.info('开始窗口截图', {
    dir,
    count: plan.length,
    only: captureOnlyRaw === '' ? undefined : captureOnlyRaw,
  })
  const result = await captureWindows({
    dir,
    targets: plan,
    manager,
    logger: logger ?? undefined,
    // `delayMs` 不在这里传：它是「等两帧渲染后再补多久」的 settle 值，
    // 缺省由 capture.ts 定义（原先写死 700 是"固定等待"，已随 waitForPaint 一起改语义）。
  })
  logger?.info('窗口截图完成', { written: result.files.length, dir })

  // 渲染层探针结果与截图一起落盘：截图回答"长什么样"，探针回答"能不能点"。
  // 用与 AURORA_SMOKE 相同的前缀，方便在同一条命令链里 grep 结果。
  //
  // ⚠️ 只在**真的跑过场景**时才写：`AURORA_CAPTURE_ONLY=failed` 碰上"上一轮全绿"时 plan 为空，
  // 照写就会把上一份"有失败项"的报告覆盖成空 checks —— 下次再 `failed` 就什么都读不到了。
  if (plan.length > 0) {
    try {
      const report = {
        dir,
        // 档位要能**自证**：`AURORA_CAPTURE_THEME` 拼错（如 'LIGHT'）会静默回落 system，
        // 只留 PNG 的话两份报告的目录名与实际档位对不上也看不出来，所以请求值与实际生效值都落盘。
        requestedTheme: (process.env['AURORA_CAPTURE_THEME'] ?? '').trim() || 'system',
        theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
        files: result.files,
        checks: result.checks,
      }
      await fs.writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
    } catch (error) {
      logger?.warn('截图报告写出失败', { error: String(error) })
    }
  }
  for (const item of result.checks) {
    if (item.result == null) {
      // 配了探针却没拿到结果（undefined / null）= 断言没生效，必须显式报出来
      //（`failed` 也会因此判失败）。日志带上文件名：8 条 settings-* 场景的 name 都是 settings，
      // 只打 name 时定位不到是哪张图。
      if (item.checked) {
        logger?.error(
          `${SMOKE_RESULT_PREFIX} FAIL 截图探针 ${item.name}（${basename(item.file)}）— 未返回结果（断言未生效）`,
        )
      }
      continue
    }
    // 探针脚本可以返回 `pass: boolean` 表达一条明确断言；没有 pass 时只当作信息记录
    const verdict = (item.result as { pass?: unknown }).pass
    const label = verdict === undefined ? 'INFO' : verdict === true ? 'PASS' : 'FAIL'
    logger?.[verdict === false ? 'error' : 'info'](
      `${SMOKE_RESULT_PREFIX} ${label} 截图探针 ${item.name} — ${JSON.stringify(item.result)}`,
    )
  }

  // 退出码必须反映探针结论：只写出一张图就 exit 0 会让脚本化的调用方
  // 把「5 条断言里有 FAIL」当成功。
  if (result.failed) logger?.error('截图探针存在失败项，退出码 2')

  // 一次性任务：写完就退出，不常驻（与 AURORA_SMOKE 同一约定）。
  // 隔离出来的临时 userData 也一并删掉，避免每跑一次截图就留一个目录。
  manager.prepareQuit()
  // 固定工作区（两次启动验证）**不删**：第二次启动还要读它；普通自测照旧一跑一清
  if (smokeWorkspace !== undefined && pinnedSmokeWorkspace === undefined) {
    // 先停技能目录监听再删树：app.exit() 不走 before-quit，shutdown() 的 stopWatching
    // 到不了这里，被监听的 userData/skills 会随整树删除触发一次 watcher EPERM
    //（skills 的 error 处理保证不弹窗，先停掉则连告警与收尾重扫都不发生）。
    skillsService?.stopWatching()
    await fs.rm(smokeWorkspace, { recursive: true, force: true }).catch(() => undefined)
  }
  if (result.files.length === 0) app.exit(nothingDue ? 0 : 1)
  else app.exit(result.failed ? 2 : 0)
}

/**
 * 在 onboarding 窗口的渲染进程里执行自测脚本：
 * 覆盖 preload 暴露面、IPC 往返、凭据加密、模式引导、窗口状态机、真实对话循环。
 *
 * 对话部分使用本地假 LLM 服务（`smoke-llm.ts`）：自测**离线可跑**，
 * 且"桩服务收到 3 轮 chat 请求 + 其中一轮带回 tool 结果"能证明工具循环真的执行了。
 */
/**
 * 给自测会话绑定一个临时项目根。
 *
 * v17 起项目根**按会话解析**（`tools/session-project.ts`），链是「会话绑定项目 >
 * 会话空间目录 > 激活模式目录」；未标记的会话恒落 Agent 空间、其目录固定为
 * 「桌面\Aurora」—— 全局 `projects.current` 一级已于 v25 退役，凡是走真实文件链路的
 * 自测段都必须先绑定会话。凡是走真实文件链路的自测段都必须先绑定，否则写进 userData / %TEMP%
 * 的夹具一律被判越界，断言测的就成了「越界拒绝」而不是被测行为；
 * 落进等待确认卡的那条分支时还会白挂一个 60s 超时（2026-09-30 的口径变更 smoke 没跟着改，
 * 13 条断言因此连续多轮恒红）。
 *
 * `projectId` 复用同一个 key：本函数替换同 id 的旧项，同一段里改绑不同目录不会让
 * `projects.list` 越积越长。
 */
async function bindSmokeProject(sessionId: string, projectId: string, root: string): Promise<void> {
  if (settings === undefined || sessions === undefined) return
  const projects = settings.get().projects
  settings.update({
    projects: {
      ...projects,
      list: [
        ...projects.list.filter((item) => item.id !== projectId),
        { id: projectId, name: '自测项目', root },
      ],
    },
  })
  await sessions.setProject(sessionId, projectId)
}

async function runSmokeTest(userData: string): Promise<void> {
  // 断言覆盖真实对话链，脚本必须注入 chat 窗口；不能依赖 `getAllWindows()` 的顺序
  //（onboarding / edge-bar 谁先创建会随后续窗口改动漂移）。
  const target = windows?.ensure('chat') ?? BrowserWindow.getAllWindows()[0]
  if (!target) {
    logger?.error('自测失败：没有可用窗口')
    return
  }

  // 第二次启动（`AURORA_SMOKE_PHASE=resume` + 固定工作区）：只跑"重启续跑"这一段。
  // 其余断言的对象是"首次启动的全新现场"（科目模板、无历史会话、桩服务计数），
  // 在同一个工作区上重跑必然红 —— 那不是缺陷，是断言写错了对象。因此按阶段分流，
  // 而不是把整套自测跑两遍。
  if (smokePhase === 'resume') {
    await runResumePhase(userData)
    return
  }

  logger?.info('开始开发自测（真实 Electron / preload / IPC）')

  // 1. 启本地桩 LLM，并把配置指向它（凭据走 safeStorage 加密路径）
  let stub: StubLlmServer | undefined
  let watchDir = ''
  try {
    stub = await startStubLlmServer(logger?.child('smoke-llm'))
    const smokePatch: SettingsPatch = {
      llm: {
        active: 'smoke',
        providers: {
          smoke: {
            type: 'openai-compat',
            baseUrl: stub.baseUrl,
            apiKeyEnc: '',
            model: STUB_MODEL,
            // `LlmProviderConfig.modelList` 是 output 必填字段（zod `.default([])` 只放宽输入类型），
            // 这里显式给出候选列表：自测也顺带覆盖「选择器能列出两个模型」的场景。
            modelList: [STUB_MODEL, `${STUB_MODEL}-alt`],
            // 生成参数按**模型 id** 键（v23）；三项都写全，别留半截条目
            modelParams: {
              [STUB_MODEL]: {
                reasoningEffort: 'auto',
                // 0 = 未知：界面此时只显示 token 数、不显示占用比例
                contextWindow: 0,
                // 自测链路上关闭图片输入
                vision: false,
              },
            },
          },
        },
      },
    }
    settings?.update(smokePatch as Partial<Settings>)
    settings?.setSecret('llm.providers.smoke.apiKey', STUB_API_KEY)
    // 自测断言依赖确定的会话长度：每次运行前清空快速会话
    await sessions?.clear('quick')
    await sessions?.flush()
    // P4/P5 断言的前置：把感知文件夹指向本轮临时目录、配好科目与一节即将开始的课。
    // 待分类文件**不在这里**预放——由渲染层脚本在订阅事件后经 app:smokeDropFile 实时投放，
    // 这样验证的是真实的 chokidar add 链路（而不是启动扫描）。
    watchDir = await seedSmokeClassroom(userData)
    await settings?.flush()
  } catch (error) {
    logger?.error('自测准备失败：无法启动桩 LLM 服务', { error: String(error) })
    app.exit(1)
    return
  }

  // 2.0 主进程侧另订一份 Agent 事件流，收集整轮自测的 token 用量。
  //
  //     为什么主进程要自己订：`usage` 事件的形状由渲染层脚本断言（"有事件、轮次是整数"），
  //     但**解析结果**（provider 回传的缓存命中量有没有变成 `cachedTokens`）只有这里能看 ——
  //     渲染层拿到的是同一份 payload，读不出"解析丢了字段"与"provider 没回传"的区别。
  //     订阅必须赶在渲染层脚本**之前**：`executeJavaScript` 是 await 整段跑完的，
  //     等它返回再订就只能收到空气。
  const usageEvents: TokenUsage[] = []
  const offUsage = agent?.onEvent((event) => {
    if (event.type === 'usage') usageEvents.push(event.usage)
  })

  let payload: { results?: Array<{ name: string; ok: boolean; detail: string }>; fatal?: string }
  try {
    payload = (await target.webContents.executeJavaScript(
      smokeScript(stub.baseUrl, STUB_MODEL, watchDir),
      true,
    )) as typeof payload
  } catch (error) {
    logger?.error('自测脚本执行异常', { error: String(error) })
    offUsage?.()
    app.exit(1)
    return
  }
  offUsage?.()

  if (payload.fatal) {
    logger?.error(`${SMOKE_RESULT_PREFIX} FATAL ${payload.fatal}`)
    app.exit(1)
    return
  }

  const results = payload.results ?? []
  const record = (name: string, ok: boolean, detail = ''): void => {
    results.push({ name, ok, detail })
  }

  // 1.1 凭据保真的**磁盘**断言。
  //     渲染层看不到密文（`settings:get` 一律回空串），而 `hasSecret` 走 `getSecret()` 会**先读
  //     `memorySecrets` 缓存** —— 即使磁盘密文被空串覆盖，同一进程里它照样返回 true。
  //     所以「带空 `apiKeyEnc` 回传不会清掉凭据」这条只有读盘才能证明：脚本里那个 `fresh-*`
  //     provider 写完 key 之后又被回传过一次空串，此刻磁盘上必须仍是密文。
  try {
    await settings?.flush()
    const disk = JSON.parse(await fs.readFile(join(userData, 'config.json'), 'utf8')) as {
      llm?: { providers?: Record<string, { apiKeyEnc?: unknown }> }
      mcp?: { servers?: Array<{ name?: string; envEnc?: Record<string, unknown> }> }
    }
    const providers = disk.llm?.providers ?? {}
    const fresh = Object.entries(providers).find(([id]) => id.startsWith('fresh-'))
    const cipher = fresh?.[1]?.apiKeyEnc
    record(
      '磁盘上的 fresh provider 仍是密文（空 apiKeyEnc 回传没有清掉凭据）',
      typeof cipher === 'string' && cipher !== '',
      fresh === undefined
        ? `未找到 fresh-* provider（实际 provider：${Object.keys(providers).join(',') || '空'}）`
        : `${fresh[0]}: apiKeyEnc 长度=${typeof cipher === 'string' ? cipher.length : String(cipher)}`,
    )

    // MCP 侧同类断言：脚本把脱敏后的服务器列表（envEnc 为空对象）原样回传过一次，
    // 此刻磁盘上该服务器的 env 密文必须还在 —— 与 provider 一样，只有读盘才能证明。
    const mcpServers = disk.mcp?.servers ?? []
    const smokeMcp = mcpServers.find((server) => (server.name ?? '').startsWith('smoke-mcp-'))
    const envCipher = smokeMcp?.envEnc?.['TOKEN']
    record(
      '磁盘上的 smoke-mcp 仍有 env 密文（空 envEnc 回传没有清掉凭据）',
      typeof envCipher === 'string' && envCipher !== '',
      smokeMcp === undefined
        ? `未找到 smoke-mcp-* 服务器（实际：${mcpServers.map((server) => server.name ?? '?').join(',') || '空'}）`
        : `${smokeMcp.name}: envEnc.TOKEN 长度=${typeof envCipher === 'string' ? envCipher.length : String(envCipher)}`,
    )

    // 删除 provider 的落盘证据：脚本经 `removedProviders` 删掉的那个 provider
    // 必须从磁盘上消失（旧行为是「provider 还在、密文被清掉」）。
    const leakedRemoval = Object.keys(providers).find((id) => id.startsWith('remove-'))
    record(
      '磁盘上没有已删除的 provider（removedProviders 真正落盘生效）',
      leakedRemoval === undefined,
      leakedRemoval === undefined ? 'config.json 里已无 remove-*' : `仍存在：${leakedRemoval}`,
    )
  } catch (error) {
    record(
      '磁盘上的 fresh provider 仍是密文（空 apiKeyEnc 回传没有清掉凭据）',
      false,
      `读盘失败：${String(error)}`,
    )
  }

  // 2. 主进程侧断言：工具循环真的走了两轮，且第二轮带回了 tool 结果
  //    只统计**对话**请求：分类管线也会打桩服务，不能混在一起数。
  const chatRequests = stub.chatRequestCount()
  // 基础对话 3 次：第一轮 2 次（工具调用 + 最终回复）、第二轮 1 次（纯文本）；
  // 子代理场景（renderer 侧 9.4）另加 4 次：父对话 2 次（派 task + 收尾）
  // + 子代理自己 2 次（先要一次 list_dir、再给报告）；
  // 免确认命令模式的两条断言（renderer 侧 9.5）各加 2 次：run_command 工具调用轮 + 收尾轮
  // （未命中那条命令被拒后循环照常继续，同样要一次收尾轮）。
  // 自动化场景（docs/13）另加 1 次：手动触发一条 Agent 模式自动化，会真的起一轮会话。
  // "第二次请求带回 tool 结果"证明工具循环真实走通。
  const expectedChatRequests = 3 + 4 + 2 * 2 + 1
  record(
    `桩 LLM 收到 ${expectedChatRequests} 轮 chat 请求（工具循环 + 子代理 + 自动化成立）`,
    // 口径是**至少**这些轮：下面的用例只增不减，写死等号会让每条新用例都变成假失败
    chatRequests >= expectedChatRequests,
    `count=${chatRequests}`,
  )
  record('第二次请求带回了 tool 结果', stub.sawToolResult(), '')
  record('请求携带了工具清单（use_skill 已注册）', stub.sawTools(), '')
  // 分类管线确实调用过模型（低置信文件走了 LLM 分支）
  record(
    '分类管线调用过模型（结构化输出）',
    stub.classifyRequestCount() > 0,
    `classify=${stub.classifyRequestCount()}`,
  )

  // 2.1 缓存前缀稳定性与命中量（docs/06 §21.1 / §21.4）：三条**端到端**断言，读的是桩服务
  //     实际收到的字节（请求体历史）与内核解析后的用量（上面那份事件订阅）。
  //     单测覆盖不到这两条：`systemPrompt.test.ts` 那对确定性构造的 a / b 只证组装函数
  //     正确，证不了「请求真的这么发出去了」；`toLlmTools()` 的排序单测同理证不了
  //     agentLoop 的**生效路径**用的是它（step 6 的已知风险 ③）。
  if (smokeSection('2.1')) {
    // 只取**父对话**请求：分类与子代理各走自己的分流，系统提示词不是同一份，混进来必然假 FAIL。
    // 再要求"整份组装结果"（含安全规则 + 系统状态）才对：桩服务是公用的，将来若有别的场景
    // 在对话之前打它（设置页的"测试连接"这类只发最小提示词），不筛就会拿它当第一轮。
    // 这两条 `includes` 同时是断言的一部分（少一个小节会匹配不到 → 条数不足直接红），
    // 不存在"筛掉之后就恒真"的口子。
    const conversation = stub
      .getRecordedRequests()
      .filter(
        (item) =>
          !item.classify &&
          !item.subagent &&
          item.systemPrompt.includes(SAFETY_TITLE) &&
          item.systemPrompt.includes(PERCEPTION_SECTION_TITLE),
      )
    // 「连续两轮」取前两条：第 1 轮的两个请求（带工具调用那一轮 + 拿到工具结果后的收尾轮）
    // ——同一会话、同一轮上下文，静态段必然一致，且它们相隔最近。
    const [first, second] = conversation
    const promptA = first?.systemPrompt ?? ''
    const promptB = second?.systemPrompt ?? ''
    const sharedPrefix = commonPrefixLength(promptA, promptB)
    const volatileAt = firstVolatileIndex(promptA)
    // 静态段的末尾：安全规则小节是最后一个静态小节（易变段一律在它之后）
    const safetyEnd = promptA.indexOf(SAFETY_TITLE) + SAFETY_TITLE.length
    // 判据用 `公共前缀长度 >= 首个易变小节的位置`，**不是** `===`：`## 系统状态` 里的时间只到
    // 分钟，两轮隔几秒时整份提示词可能一字不差（此时公共前缀 = 全长 > 该位置）。
    // 反过来断言「两轮必须不同」才是随机失败 —— 假 FAIL 比假 PASS 更坏。
    // 这个式子仍抓得住真回归：静态段少了/多了一个字节，公共前缀就会停在静态段中间。
    // 防恒真由 `systemPrompt.test.ts` 那对构造的 a / b 承担（那里两轮**必然**不同），不靠这里。
    record(
      '两轮系统提示词静态前缀逐字节相同',
      conversation.length >= 2 &&
        volatileAt >= 0 &&
        sharedPrefix >= volatileAt &&
        volatileAt >= safetyEnd &&
        promptA.includes(PERCEPTION_SECTION_TITLE) &&
        promptB.includes(PERCEPTION_SECTION_TITLE),
      `commonPrefix=${sharedPrefix} aLen=${promptA.length} bLen=${promptB.length} ` +
        `firstVolatile@${volatileAt} safetyEnd@${safetyEnd} identical=${promptA === promptB}`,
    )

    // 工具顺序稳定（docs/06 §21.2）：排序的生效点在 `agentLoop`（走 `toLlmTools()`），
    // 只改 registry 而漏改生效路径时，单测照样绿、这里必红。
    const toolNamesA = toolNamesOf(first)
    const toolNamesB = toolNamesOf(second)
    // 与 `ToolRegistry.toLlmTools()` 同一条排序口径（**不用 localeCompare**：它依赖 locale，
    // 跨机器可能给出不同结果）
    const ordered = [...toolNamesA]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .every((name, index) => name === toolNamesA[index])
    record(
      '两轮 tools 顺序相同且已排序',
      toolNamesA.length > 0 &&
        toolNamesA.length === toolNamesB.length &&
        toolNamesA.every((name, index) => name === toolNamesB[index]) &&
        ordered,
      `a=[${toolNamesA.join(',')}] b=[${toolNamesB.join(',')}]`,
    )

    // 缓存命中可观测（docs/06 §21.4）：桩服务固定回 512（OpenAI 形态
    // `prompt_tokens_details.cached_tokens`），内核必须把它解析成 `cachedTokens` 再发出来
    // ——渲染层那侧只断言"有 usage 事件"，解析丢字段在那边看不出来。
    record(
      'usage 事件带 cachedTokens=512',
      usageEvents.length > 0 && usageEvents.every((usage) => usage.cachedTokens === 512),
      `events=${usageEvents.length} cached=${JSON.stringify(usageEvents.map((usage) => usage.cachedTokens ?? null))}`,
    )
  }

  // 2.2 项目机制（v13，docs/06 §5.1）：端到端证明「项目级 AGENTS.md 真的进了请求体」，
  //     并且同目录的 `AGENTS.override.md` 顶掉了 `AGENTS.md`。
  //     走的是**真实链路**：写盘 → `settings.update` → 发一轮真实对话（桩服务记录请求体）
  //     → 从桩的 `systemPrompt` 里读回注入文本。单测只证收集器与渲染顺序，
  //     证不了「装配层的闭包 + 每轮即时读取」这条生效路径。
  //     位置必须在上面那组断言**之后**：那里有一条"桩共收到 11 轮 chat 请求"的精确计数，
  //     本轮会多打一次桩 —— 让 record 先跑完就不会互相影响。
  if (smokeSection('2.2')) {
    const projectRoot = join(userData, 'smoke-project')
    const agentsMarker = 'AURORA_AGENTS_MD_MARKER'
    const overrideMarker = 'AURORA_AGENTS_OVERRIDE_MARKER'
    let injected = false
    let overrideWins = false
    let agentsDropped = false
    let detail = ''
    try {
      await fs.mkdir(projectRoot, { recursive: true })
      await fs.writeFile(join(projectRoot, 'AGENTS.md'), `# 项目约定\n${agentsMarker}\n`, 'utf8')
      await fs.writeFile(
        join(projectRoot, 'AGENTS.override.md'),
        `# 覆盖约定\n${overrideMarker}\n`,
        'utf8',
      )

      if (settings !== undefined && agent !== undefined) {
        // 收窄到局部常量：下面有闭包（事件回调）要引用它，`let` 的可变绑定会让 TS 丢掉收窄
        const host = agent
        const projectsBefore = settings.get().projects
        settings.update({
          projects: {
            ...projectsBefore,
            list: [{ id: 'smoke-project', name: '自测项目', root: projectRoot }],
          },
        })
        // v17 起边界根按**会话**解析（v25 起更无全局 current 一级）——
        // 必须绑定会话，夹具才落得到根上（详见 `bindSmokeProject` 注释）。
        await bindSmokeProject('smoke-project', 'smoke-project', projectRoot)

        // 等这一轮的 done 再断言：`send` 只入队，事件流才是"请求真的发出去了"的证据
        let offDone: (() => void) | undefined
        const done = new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            offDone?.()
            resolve()
          }, 15_000)
          offDone = host.onEvent((event) => {
            if (event.type === 'done' && event.sessionId === 'smoke-project') {
              clearTimeout(timer)
              offDone?.()
              resolve()
            }
          })
        })
        const before = stub.getRecordedRequests().length
        await host.send({ sessionId: 'smoke-project', text: '项目约定自测', origin: 'chat' })
        await done

        // 只看本轮新增、且是父对话的请求（子代理 / 分流各走自己的系统提示词）
        const fresh = stub
          .getRecordedRequests()
          .slice(before)
          .filter((item) => !item.classify && !item.subagent)
        const prompt = fresh[0]?.systemPrompt ?? ''
        injected = prompt.includes('## 项目约定') && prompt.includes(overrideMarker)
        overrideWins = prompt.includes(overrideMarker)
        agentsDropped = !prompt.includes(agentsMarker)
        detail = `rounds=${fresh.length} markerAgents=${prompt.includes(agentsMarker)} markerOverride=${overrideWins}`

        // 收尾：把项目还原成"无项目"，免得带进后面的断言
        settings.update({ projects: { ...settings.get().projects, list: [] } })
      } else {
        detail = 'settings / agent 不可用'
      }
    } catch (error) {
      detail = `异常：${String(error)}`
    }
    record(
      '项目级 AGENTS.md 进了请求体且 override 优先（AGENTS.md 内容被顶掉）',
      injected && overrideWins && agentsDropped,
      detail,
    )
  }

  // 2.3 三档权限（v13，docs/06 §11.2）：只读档"根本不在工具表里"、auto 档完全权限不再弹卡、
  //     confirm 档保留旧 auto 的根内免确认与越界确认。
  //     这里断言的是**真实装配实例**（`syncToolRegistries()` 重建出的注册表 + 注入内核的同一个
  //     `confirmTool`）——单测各自覆盖过函数，但"改设置 → 注册表跟着变 → 确认判定跟着变"这条
  //     生效路径只有整机跑得出来。
  if (smokeSection('2.3')) {
    let readonlyToolNames: string[] = []
    let readonlyRemoved = false
    let autoInsideNoCard = false
    let autoInsideWritten = false
    let autoOutsideNoCard = false
    let autoOutsideWritten = false
    let confirmBoundaryOk = false
    let confirmBoundaryDetail = '前置不可用'
    let detail = ''
    const projectRoot = join(userData, 'smoke-permission-project')
    try {
      await fs.mkdir(projectRoot, { recursive: true })
      const insideFile = join(projectRoot, 'inside.txt')
      const outsideFile = join(userData, 'smoke-permission-outside.txt')
      await fs.rm(insideFile, { force: true })
      await fs.rm(outsideFile, { force: true })

      if (settings !== undefined && confirmTool !== undefined && proactiveScheduler !== undefined) {
        const scheduler = proactiveScheduler
        const agentBefore = settings.get().agent
        const advancedBefore = settings.get().advanced
        const projectsBefore = settings.get().projects
        // 登记权限自测项目：confirm 档的「根内」判据来自**会话绑定**的项目根
        settings.update({
          projects: {
            ...projectsBefore,
            list: [{ id: 'smoke-perm', name: '权限自测', root: projectRoot }],
          },
        })
        // 会话 id 与项目 id 在这里**必须分开写**：绑的是会话，解析出来的根才是夹具根。
        // 不绑的话下面 confirm 档的链接取证落不到「根内」分支，会去等 60s 确认超时。
        await bindSmokeProject('smoke-permission', 'smoke-perm', projectRoot)

        // ① 只读档：写 / 执行 / 有副作用的工具必须从注册表里消失
        settings.update({ agent: { ...agentBefore, permissionMode: 'readonly' } })
        syncToolRegistries()
        const mustBeGone = ['run_command', 'write_file', 'edit_file', 'open_path', 'todo_write']
        const gone = mustBeGone.filter((name) => tools?.get(name) === undefined)
        readonlyRemoved = gone.length === mustBeGone.length
        const kept = ['read_file', 'list_dir', 'grep', 'glob', 'todo_read'].filter(
          (name) => tools?.get(name) !== undefined,
        )
        readonlyToolNames = kept

        // ② auto 档 + 项目根内：完全权限直接放行（**不产生在途卡片**），且真的写得进去
        settings.update({ agent: { ...agentBefore, permissionMode: 'auto' } })
        syncToolRegistries()
        const insideDecision = await confirmTool({
          name: 'write_file',
          input: { path: insideFile },
          sessionId: 'smoke-permission',
          sensitivity: 'confirm',
        })
        autoInsideNoCard = insideDecision === true && scheduler.pendingCount === 0
        // 完全权限返回 true，内核会置 approvedByUser；这里直接模拟同一授权形态。
        const written = await tools
          ?.get('write_file')
          ?.execute(
            { path: insideFile, content: 'AURORA_PERMISSION_INSIDE' },
            { sessionId: 'smoke-permission', approvedByUser: true },
          )
        autoInsideWritten =
          written?.isError !== true &&
          (await fs.readFile(insideFile, 'utf8').catch(() => '')).includes(
            'AURORA_PERMISSION_INSIDE',
          )

        // ②b auto 档 + 项目根外：完全权限直接放行、零弹卡，且把文件真的写进去。
        const outsideDecision = await confirmTool({
          name: 'write_file',
          input: { path: outsideFile },
          sessionId: 'smoke-permission',
          sensitivity: 'confirm',
        })
        autoOutsideNoCard = outsideDecision === true && scheduler.pendingCount === 0
        const outsideWrite = await tools
          ?.get('write_file')
          ?.execute(
            { path: outsideFile, content: 'AURORA_PERMISSION_OUTSIDE' },
            { sessionId: 'smoke-permission', approvedByUser: true },
          )
        autoOutsideWritten =
          outsideWrite?.isError !== true &&
          (await fs.readFile(outsideFile, 'utf8').catch(() => '')).includes(
            'AURORA_PERMISSION_OUTSIDE',
          )

        // ②c confirm 档 + 根内指向根外的链接：判定端机器放行，执行端仍由 realpath 拒绝。
        settings.update({
          agent: { ...agentBefore, permissionMode: 'confirm' },
          advanced: { ...advancedBefore, confirmSensitiveTools: true },
        })
        syncToolRegistries()
        const escapeTargetDir = join(userData, 'smoke-escape-target')
        const escapeLink = join(projectRoot, 'escape-link')
        const escapeProbe = join(escapeTargetDir, 'probe.txt')
        let linkCreated = true
        try {
          await fs.mkdir(escapeTargetDir, { recursive: true })
          await fs.rm(escapeProbe, { force: true })
          await fs.rm(escapeLink, { force: true, recursive: true })
          try {
            // junction 不需要管理员；realpath 穿透到目标（file-port.test.ts 实测锚定）
            await fs.symlink(escapeTargetDir, escapeLink, 'junction')
          } catch {
            await fs.symlink(escapeTargetDir, escapeLink, 'dir')
          }
        } catch {
          linkCreated = false
        }
        if (linkCreated) {
          const boundaryDecision = await confirmTool({
            name: 'write_file',
            input: { path: join(escapeLink, 'probe.txt') },
            sessionId: 'smoke-permission',
            sensitivity: 'confirm',
          })
          const boundaryNoCard = scheduler.pendingCount === 0
          const escaped = await tools
            ?.get('write_file')
            ?.execute(
              { path: join(escapeLink, 'probe.txt'), content: 'AURORA_ESCAPE' },
              { sessionId: 'smoke-permission' },
            )
          const escapeBlocked =
            escaped?.isError === true &&
            (await fs.readFile(escapeProbe, 'utf8').catch(() => '')) === ''
          confirmBoundaryOk = boundaryDecision === 'machine' && boundaryNoCard && escapeBlocked
          confirmBoundaryDetail = `machine:${boundaryDecision === 'machine'} noCard:${boundaryNoCard} blocked:${escapeBlocked}`
          await fs.rm(escapeLink, { force: true, recursive: true })
          await fs.rm(escapeTargetDir, { force: true, recursive: true })
        } else {
          confirmBoundaryOk = true
          confirmBoundaryDetail = 'SKIP:建不出link'
        }

        // 收尾：档位与项目都还原
        settings.update({ agent: agentBefore, advanced: advancedBefore, projects: projectsBefore })
        syncToolRegistries()
        detail =
          `readonlyKept=[${readonlyToolNames.join(',')}] ` +
          `autoInside=noCard:${autoInsideNoCard} written:${autoInsideWritten} ` +
          `autoOutside=noCard:${autoOutsideNoCard} written:${autoOutsideWritten} ` +
          `confirmBoundary=${confirmBoundaryDetail}`
      } else {
        detail = 'settings / confirmTool 不可用'
      }
    } catch (error) {
      detail = `异常：${String(error)}`
    }
    record(
      '只读档：写 / 执行类工具不进注册表（含 todo_write），只读工具保留',
      readonlyRemoved && readonlyToolNames.length >= 4,
      detail,
    )
    record(
      'auto 档：项目根内外都直接放行、零弹卡，并且文件真的写入',
      autoInsideNoCard && autoInsideWritten && autoOutsideNoCard && autoOutsideWritten,
      detail,
    )
    record(
      'confirm 档根内经指向根外的链接写入仍被 realpath 兜底拒绝',
      confirmBoundaryOk,
      `confirmBoundary=${confirmBoundaryDetail}`,
    )
  }

  // 2.4 写前快照与一键回滚（v14，docs/06 §11.8）：走**真实链路** —— 注册表里的 write_file /
  //     edit_file 工具 → file-port 的写前钩子 → 真实快照端口 → 磁盘。
  //     这是"回滚能救回原内容"的端到端证据：单测各自覆盖了端口与端口钩子，
  //     但"工具层带上 snapshot 参数、装配层真的注入了端口"这条链只有整机跑得出来。
  if (smokeSection('2.4')) {
    const snapshotDemoDir = join(userData, 'smoke-snapshot')
    const snapshotDemoFile = join(snapshotDemoDir, 'note.txt')
    let snapshotOnWrite = false
    let contentRestored = false
    let rollbackHasOwnSnapshot = false
    let appendKeepsBefore = false
    let editAlsoSnapshots = false
    let ringKept = -1
    let detail = ''
    try {
      await fs.mkdir(snapshotDemoDir, { recursive: true })
      await fs.writeFile(snapshotDemoFile, 'V1', 'utf8')
      // 快照存储本身不走 file-port、不受边界约束；受约束的是 write_file / edit_file /
      // read_file —— 让它们落在绑定的项目根内，测到的才是快照链路而不是越界拒绝。
      await bindSmokeProject('smoke-snapshot', 'smoke-snapshot', snapshotDemoDir)
      const port = ensureSnapshotPort()
      const write = tools?.get('write_file')
      const edit = tools?.get('edit_file')
      const read = tools?.get('read_file')
      if (write !== undefined && edit !== undefined && desktopDeps !== undefined) {
        // ① write_file（overwrite）→ 写前留底的是 V1，结果文本里回带快照 id
        const first = await write.execute(
          { path: snapshotDemoFile, content: 'V2' },
          { sessionId: 'smoke-snapshot' },
        )
        snapshotOnWrite = (first.content ?? '').includes('已保存快照：')
        await port.flush()
        const listed = await port.list({ path: snapshotDemoFile })

        // ② 回滚到第一份快照 → 磁盘内容回到 V1；③ 回滚自身留下 origin:'rollback'
        const restored = await restoreSnapshot(desktopDeps, port, {
          snapshotId: listed[0]?.id ?? '',
        })
        contentRestored = restored.ok && (await fs.readFile(snapshotDemoFile, 'utf8')) === 'V1'
        await port.flush()
        const afterRestore = await port.list({ path: snapshotDemoFile })
        rollbackHasOwnSnapshot = afterRestore.some((item) => item.origin === 'rollback')

        // ④ append 的快照是**追加前**的内容（V1），且 edit_file 同样留底
        await write.execute(
          { path: snapshotDemoFile, content: '+追加', mode: 'append' },
          { sessionId: 'smoke-snapshot' },
        )
        await port.flush()
        const afterAppend = await port.list({ path: snapshotDemoFile })
        const appended = afterAppend.find((item) => item.mode === 'append')
        if (appended !== undefined) {
          const content = await port.readContent(appended)
          appendKeepsBefore =
            content !== undefined && Buffer.from(content.bytes).toString('utf8') === 'V1'
        }
        // `edit_file` 有"改前必须先读"的守卫：先真的读一次（与生产路径一致）
        await read?.execute({ path: snapshotDemoFile }, { sessionId: 'smoke-snapshot' })
        const edited = await edit.execute(
          { path: snapshotDemoFile, oldString: 'V1', newString: 'V3' },
          { sessionId: 'smoke-snapshot' },
        )
        editAlsoSnapshots = (edited.content ?? '').includes('已保存快照：')

        // ⑤ 环形上限真的生效：同一文件连写 30 次（默认每文件保留 20 份）
        for (let index = 0; index < 30; index += 1) {
          await write.execute(
            { path: snapshotDemoFile, content: `V${index}` },
            { sessionId: 'smoke-snapshot' },
          )
        }
        await port.flush()
        const snapDir = join(snapshotDir, 'smoke-snapshot')
        const snaps = (await fs.readdir(snapDir).catch(() => [] as string[])).filter((name) =>
          name.endsWith('.snap'),
        )
        ringKept = snaps.length
        detail = `listed=${listed.length} restored=${contentRestored} rollback=${rollbackHasOwnSnapshot} append=${appendKeepsBefore} edit=${editAlsoSnapshots} snaps=${ringKept}`
      } else {
        detail = 'tools / deps 不可用'
      }
    } catch (error) {
      detail = `异常：${String(error)}`
    }
    record(
      '写前快照：write_file 结果回带快照 id，且索引里能查到该文件的那一份',
      snapshotOnWrite,
      detail,
    )
    record(
      '一键回滚：内容还原到写前，且回滚自身留下 origin=rollback 的快照（可再撤回）',
      contentRestored && rollbackHasOwnSnapshot,
      detail,
    )
    record(
      'append 的快照是追加前内容；edit_file 同样留底',
      appendKeepsBefore && editAlsoSnapshots,
      detail,
    )
    record(
      `每文件环形保留生效（连写 30 次后 .snap 数 ≤ ${settings?.get().agent.snapshots.keepPerFile ?? 20}）`,
      ringKept >= 0 && ringKept <= (settings?.get().agent.snapshots.keepPerFile ?? 20),
      detail,
    )
  }

  // 2.5 Job 持久化与续跑（v15，docs/06 §4.1）：走**真实链路** —— `kernel.send()` → 真循环 →
  //     真 job 存储 → 磁盘。桩服务按 JOB_LOOP_MARKER 一直要工具，"轮次用尽 → paused"
  //     因此是**确定发生**的，不依赖模型自觉。
  if (smokeSection('2.5')) {
    const jobSession = 'smoke-job'
    let pausedOk = false
    let resumeOk = false
    let singleUserMessage = false
    let budgetOk = false
    let cancelOk = false
    let cursorOk = false
    let jobDetail = ''
    const previousLoop = settings?.get().agent.loop
    // 收窄到局部常量：下面有闭包（事件回调）要引用它们，`let` 的可变绑定会让 TS 丢掉收窄
    const host = agent
    const store = jobStore
    const settingsStore = settings
    const sessionStore = sessions
    /** 等某个会话的请求跑完（done 事件；30s 兜底，避免自测整体挂死） */
    const waitDone = async (sessionId: string): Promise<void> => {
      if (host === undefined) return
      await new Promise<void>((resolve) => {
        const off = host.onEvent((event) => {
          if (event.sessionId !== sessionId || event.type !== 'done') return
          off()
          resolve()
        })
        setTimeout(() => {
          off()
          resolve()
        }, 30_000)
      })
    }
    try {
      if (
        store !== undefined &&
        settingsStore !== undefined &&
        sessionStore !== undefined &&
        host !== undefined
      ) {
        const setLoop = (loop: {
          maxRounds: number
          maxTotalTokens: number
          autoContinueRounds: number
        }): void => {
          settingsStore.update({ agent: { ...settingsStore.get().agent, loop } })
        }

        // ① 轮次用尽 → paused + pendingReason='max-rounds'（关掉自动续轮，否则它会自己跑完）
        setLoop({ maxRounds: 2, maxTotalTokens: 0, autoContinueRounds: 0 })
        await host.send({ sessionId: jobSession, text: JOB_LOOP_MARKER, origin: 'chat' })
        await waitDone(jobSession)
        await store.flush()
        const first = (await store.list({ sessionId: jobSession }))[0]
        pausedOk = first?.status === 'paused' && first.pendingReason === 'max-rounds'
        cursorOk = (first?.cursor.nextRound ?? 0) > 0 && (first?.stepsDone.length ?? 0) > 0

        // ② 续跑：跑到 done，且那条用户消息**只有一条**（续跑最容易踩的重复落盘）
        const userBefore = (await sessionStore.get(jobSession)).filter(
          (m) => m.role === 'user',
        ).length
        if (first !== undefined) {
          await host.send({
            sessionId: jobSession,
            text: first.text,
            origin: 'chat',
            resumeJobId: first.id,
          })
          await waitDone(jobSession)
          await store.flush()
          const second = await store.get(first.id)
          const userAfter = (await sessionStore.get(jobSession)).filter(
            (m) => m.role === 'user',
          ).length
          resumeOk = second?.status === 'done'
          singleUserMessage = userBefore === 1 && userAfter === 1
        }

        // ③ 预算触顶 → paused + pendingReason='budget'（桩每轮都带 usage）
        setLoop({ maxRounds: 8, maxTotalTokens: 1, autoContinueRounds: 0 })
        await host.send({ sessionId: 'smoke-job-budget', text: JOB_LOOP_MARKER, origin: 'chat' })
        await waitDone('smoke-job-budget')
        await store.flush()
        const budgetJob = (await store.list({ sessionId: 'smoke-job-budget' }))[0]
        budgetOk = budgetJob?.status === 'paused' && budgetJob.pendingReason === 'budget'

        // ④ 取消 → aborted（不是 paused）：先等 job 真进入 running 再 abort
        setLoop({ maxRounds: 8, maxTotalTokens: 0, autoContinueRounds: 0 })
        const cancelSend = await host.send({
          sessionId: 'smoke-job-cancel',
          text: JOB_LOOP_MARKER,
          origin: 'chat',
        })
        let runningJob = (await store.list({ sessionId: 'smoke-job-cancel' }))[0]
        for (let attempt = 0; attempt < 40 && runningJob?.status !== 'running'; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50))
          runningJob = (await store.list({ sessionId: 'smoke-job-cancel' }))[0]
        }
        host.abort(cancelSend.requestId)
        await waitDone('smoke-job-cancel')
        await store.flush()
        cancelOk = (await store.list({ sessionId: 'smoke-job-cancel' }))[0]?.status === 'aborted'

        jobDetail = `paused=${pausedOk} cursor=${cursorOk} resume=${resumeOk} oneUserMsg=${singleUserMessage} budget=${budgetOk} cancel=${cancelOk}`
      } else {
        jobDetail = 'jobStore / settings / agent 不可用'
      }
    } catch (error) {
      jobDetail = `异常：${String(error)}`
    } finally {
      // 还原循环配置：后面的场景（提示条 / 分类）不该被 maxRounds=2 之类的临时值影响
      if (previousLoop !== undefined && settings !== undefined) {
        try {
          settings.update({ agent: { ...settings.get().agent, loop: previousLoop } })
        } catch {
          // 还原失败不影响本次自测结论（配置本来就在临时 userData 里）
        }
      }
    }
    record(
      "Job：轮次用尽落 paused 且 pendingReason='max-rounds'，游标与已完成步骤都已落盘",
      pausedOk && cursorOk,
      jobDetail,
    )
    record(
      'Job 续跑：跑到 done，且会话文件里那条用户消息**只有一条**（不重复落盘）',
      resumeOk && singleUserMessage,
      jobDetail,
    )
    record("Job：预算触顶落 paused 且 pendingReason='budget'", budgetOk, jobDetail)
    record('Job：取消后状态是 aborted（不是 paused）', cancelOk, jobDetail)
  }

  // 2.5.1 会话删除级联清理 todo（docs/06 §18）：running job 仍拒绝；守卫通过后
  //       主清单与 -sub 清单随会话一起删除，避免固定会话 id 重建后复活旧任务。
  if (smokeSection('2.5.1')) {
    const sessionId = 'smoke-delete-todo'
    const jobId = 'job-smoke-delete-todo'
    let guardOk = false
    let cascadeOk = false
    let detail = ''
    const sessionStore = sessions
    const store = jobStore
    const todos = todoPort
    const deps = desktopDeps
    try {
      if (
        sessionStore !== undefined &&
        store !== undefined &&
        todos !== undefined &&
        deps !== undefined
      ) {
        const now = new Date().toISOString()
        await sessionStore.append(sessionId, { role: 'user', content: '删除会话 Todo 级联测试' })
        await todos.write(sessionId, [{ id: 't1', content: '主任务', status: 'in_progress' }])
        await todos.write(`${sessionId}-sub`, [
          { id: 't1', content: '子代理任务', status: 'pending' },
        ])
        await todos.flush()
        await store.create({
          id: jobId,
          sessionId,
          status: 'running',
          origin: 'chat',
          text: '删除会话 Todo 级联测试',
          round: 0,
          maxRounds: 8,
          stepsDone: [],
          todos: [],
          cursor: { nextRound: 0 },
          budget: { maxTotalTokens: 0, usedTokens: 0, autoContinued: 0 },
          createdAt: now,
          updatedAt: now,
        })

        const blocked = await deleteSessionState(deps, sessionId)
        guardOk =
          !blocked.ok &&
          (await todos.read(sessionId)).length > 0 &&
          (await sessionStore.get(sessionId)).length > 0

        await store.update(jobId, {
          status: 'aborted',
          pendingReason: 'aborted',
          updatedAt: new Date().toISOString(),
        })
        const deleted = await deleteSessionState(deps, sessionId)
        await sessionStore.flush()
        await todos.flush()
        cascadeOk =
          deleted.ok &&
          !existsSync(join(userData, 'sessions', `${sessionId}.json`)) &&
          !existsSync(join(todos.directory, `${sessionId}.json`)) &&
          !existsSync(join(todos.directory, `${sessionId}-sub.json`)) &&
          !(await sessionStore.listSessions()).includes(sessionId) &&
          (await todos.read(sessionId)).length === 0
        detail = `guard=${guardOk} cascade=${cascadeOk} result=${deleted.ok ? 'ok' : deleted.message}`
      } else {
        detail = 'sessionStore / jobStore / todoPort / desktopDeps 不可用'
      }
    } catch (error) {
      detail = `异常：${String(error)}`
    }
    record('会话删除：running job 仍拒绝，且不会提前清掉 todo', guardOk, detail)
    record('会话删除：守卫通过后级联清理主 todo 与 -sub todo', cascadeOk, detail)
  }

  // 2.6 跨特性集成（step 5）：把四步串成一条链 —— 选项目 → 设权限档 → Agent 真的写文件（留快照）
  //     → 只读档写不动 → 一键回滚。每条断言都必须能回答"这个特性坏了它会失败吗"：
  //     于是写文件走**真实桩驱动**（标记之后那一行是目标路径），而不是直接调工具注册表。
  if (smokeSection('2.6')) {
    const outerMarker = 'AURORA_AGENTS_OUTER_MARKER'
    const innerMarker = 'AURORA_AGENTS_INNER_MARKER'
    let scopeOk = false
    let autoOk = false
    let readonlyOk = false
    let rollbackOk = false
    let eventsOk = false
    /** 本次观察到的所有事件类型（用于"白名单没被放宽"的断言） */
    const seenTypes = new Set<string>()
    let integrationDetail = ''
    /** 等某个会话的请求跑完（done 事件；30s 兜底，避免自测整体挂死） */
    const waitForSessionDone = async (
      h: NonNullable<typeof agent>,
      sessionId: string,
    ): Promise<void> => {
      await new Promise<void>((resolve) => {
        const off = h.onEvent((event) => {
          if (event.sessionId !== sessionId || event.type !== 'done') return
          off()
          resolve()
        })
        setTimeout(() => {
          off()
          resolve()
        }, 30_000)
      })
    }
    try {
      const host = agent
      const snapshotStore = ensureSnapshotPort()
      const projectRoot = join(userData, 'smoke-integration-project')
      const target = join(projectRoot, 'note.txt')
      const readonlyTarget = join(projectRoot, 'blocked.txt')
      const previousProjects = settings?.get().projects
      const previousLoop = settings?.get().agent.loop
      const previousAgent = settings?.get().agent
      const projectId = 'smoke-integration'
      if (
        host !== undefined &&
        settings !== undefined &&
        desktopDeps !== undefined &&
        previousProjects !== undefined &&
        previousLoop !== undefined &&
        previousAgent !== undefined
      ) {
        // AGENTS.md 两层：项目根里的必须进提示词，**项目根的父目录**里的绝不能进
        // （收集范围是"项目根 → 当前工作目录"，父目录的内容漏进来就是边界破了）
        await fs.mkdir(projectRoot, { recursive: true })
        await fs.writeFile(join(projectRoot, 'AGENTS.md'), `# 项目内约定\n${innerMarker}\n`, 'utf8')
        await fs.writeFile(join(userData, 'AGENTS.md'), `# 项目外约定\n${outerMarker}\n`, 'utf8')
        await fs.writeFile(target, 'ORIGINAL', 'utf8')
        await fs.writeFile(readonlyTarget, 'UNTOUCHED', 'utf8')

        const off = host.onEvent((event) => seenTypes.add(event.type))
        settings.update({
          projects: {
            ...previousProjects,
            list: [{ id: projectId, name: '集成自测项目', root: projectRoot }],
          },
          // 一轮工具就够：第 0 轮写文件、第 1 轮收尾；关掉自动续轮让行为确定
          agent: {
            ...previousAgent,
            loop: { maxRounds: 2, maxTotalTokens: 0, autoContinueRounds: 0 },
          },
        })
        // 会话绑定（v17 口径）：项目边界与 AGENTS.md 注入都按**会话**解析根，
        // 只设全局 current 落不到夹具根上 —— 断言会退化成"越界拒绝"。
        await bindSmokeProject('smoke-integration', projectId, projectRoot)

        // ① auto 档：根内写文件**不弹卡**、真的落盘、并且留下了快照
        settings.update({
          agent: {
            ...settings.get().agent,
            permissionMode: 'auto',
            tools: settings.get().agent.tools,
          },
        })
        const beforeSnapshots = await snapshotStore.list({ path: target })
        const beforeRequests = stub.getRecordedRequests().length
        await host.send({
          sessionId: 'smoke-integration',
          text: `${WRITE_FILE_MARKER}\n${target}`,
          origin: 'chat',
        })
        await waitForSessionDone(host, 'smoke-integration')
        await snapshotStore.flush()
        const prompt = stub
          .getRecordedRequests()
          .slice(beforeRequests)
          .find((item) => !item.classify && !item.subagent)?.systemPrompt
        scopeOk =
          (prompt ?? '').includes(innerMarker) &&
          (prompt ?? '').includes('## 项目约定') &&
          !(prompt ?? '').includes(outerMarker)
        const written = await fs.readFile(target, 'utf8').catch(() => '')
        const afterSnapshots = await snapshotStore.list({ path: target })
        autoOk =
          written === WRITE_FILE_CONTENT &&
          (proactiveScheduler?.pendingCount ?? 0) === 0 &&
          afterSnapshots.length > beforeSnapshots.length

        // ③ readonly 档：同一条提问，工具不在清单 → 写不进去（文件内容一字未变）
        settings.update({
          agent: {
            ...settings.get().agent,
            permissionMode: 'readonly',
            tools: settings.get().agent.tools,
          },
        })
        await host.send({
          sessionId: 'smoke-integration',
          text: `${WRITE_FILE_MARKER}\n${readonlyTarget}`,
          origin: 'chat',
        })
        await waitForSessionDone(host, 'smoke-integration')
        const blockedContent = await fs.readFile(readonlyTarget, 'utf8').catch(() => '')
        // 判据挂在 `autoOk` 上：只读档"写不动"只有在**同一链路在 auto 档下确实写得动**的
        // 前提下才有证明力。否则这条是空真 —— 文件从头到尾没被碰过（因为 auto 那段就没写成）
        // 时 `blockedContent === 'UNTOUCHED'` 照样成立，它在 2026-09-30 之后就一直这么"假绿"着。
        readonlyOk = autoOk && blockedContent === 'UNTOUCHED'

        // ⑤ 回滚：把 ① 里的写操作撤回，且回滚自身留下 origin:'rollback' 的快照
        const first = afterSnapshots[0]
        if (first !== undefined) {
          const restored = await restoreSnapshot(desktopDeps, snapshotStore, {
            snapshotId: first.id,
          })
          await snapshotStore.flush()
          const backContent = await fs.readFile(target, 'utf8').catch(() => '')
          const afterRollback = await snapshotStore.list({ path: target })
          rollbackOk =
            restored.ok &&
            backContent === 'ORIGINAL' &&
            afterRollback.some((item) => item.origin === 'rollback')
        }

        // ⑥ 事件白名单：本轮新增的 `job` 必须在其中，且断言不是"任意类型都算过"
        const allowed = new Set([
          'queued',
          'user-message',
          'reasoning',
          'text',
          'tool',
          'subagent',
          'usage',
          'job',
          'done',
          'error',
        ])
        const unknown = [...seenTypes].filter((type) => !allowed.has(type))
        eventsOk = seenTypes.has('job') && unknown.length === 0

        off()
        settings.update({
          projects: { ...settings.get().projects, list: [] },
          agent: { ...settings.get().agent, loop: previousLoop, permissionMode: 'confirm' },
        })
        integrationDetail = `scope=${scopeOk} auto=${autoOk} readonly=${readonlyOk} rollback=${rollbackOk} events=[${[...seenTypes].join(',')}] unknown=[${unknown.join(',')}]`
      } else {
        integrationDetail = 'settings / agent / deps 不可用'
      }
    } catch (error) {
      integrationDetail = `异常：${String(error)}`
    }
    record(
      '集成①：项目根的 AGENTS.md 进了请求体，**项目根父目录**的没进（收集边界没破）',
      scopeOk,
      integrationDetail,
    )
    record(
      '集成②：auto 档根内写文件 —— 不弹确认卡、内容真的落盘、并留下快照',
      autoOk,
      integrationDetail,
    )
    record(
      '集成③：只读档同一条提问写不动文件（工具不在清单，内容一字未变）',
      readonlyOk,
      integrationDetail,
    )
    record(
      "集成⑤：一键回滚把内容还原，且新增一条 origin:'rollback' 的快照",
      rollbackOk,
      integrationDetail,
    )
    record(
      '集成⑥：事件类型白名单含本轮新增的 job，且没有放宽到"任意类型"',
      eventsOk,
      integrationDetail,
    )
  }

  // 2.7 给"第二次启动"留一条 paused 的 job（step 5 的跨进程续跑验证前置）：
  //     轮次用尽 + 关掉自动续轮 + 这里**不**续跑 → 它就停在这个工作区里等下一次启动。
  //     跨进程证据的另一半在 `runResumePhase`（`AURORA_SMOKE_PHASE=resume`）。
  if (smokeSection('2.7')) {
    let prepared = false
    let detail = ''
    try {
      const host = agent
      const store = jobStore
      const loopBefore = settings?.get().agent.loop
      if (host !== undefined && store !== undefined && settings !== undefined) {
        settings.update({
          agent: {
            ...settings!.get().agent,
            loop: { maxRounds: 2, maxTotalTokens: 0, autoContinueRounds: 0 },
          },
        })
        await host.send({ sessionId: 'smoke-job-restart', text: JOB_LOOP_MARKER, origin: 'chat' })
        await new Promise<void>((resolve) => {
          const off = host.onEvent((event) => {
            if (event.sessionId !== 'smoke-job-restart' || event.type !== 'done') return
            off()
            resolve()
          })
          setTimeout(() => {
            off()
            resolve()
          }, 30_000)
        })
        await store.flush()
        const job = (await store.list({ sessionId: 'smoke-job-restart' }))[0]
        // 落盘自检：这是"第二次启动能读到"的前提，必须当场确认文件真的在磁盘上 ——
        // 只断言内存态的话，跨进程验证会在下一次启动以 `found=0` 的形式失败，且看不出原因。
        const jobFile = join(userData, 'jobs', 'smoke-job-restart.json')
        const onDisk = existsSync(jobFile)
        prepared = job?.status === 'paused' && (job.cursor.nextRound ?? 0) > 0 && onDisk
        detail = `status=${job?.status ?? '-'} cursor=${job?.cursor.nextRound ?? -1} steps=${job?.stepsDone.length ?? -1} file=${onDisk ? 'yes' : 'NO'}`
        if (!onDisk) logger?.error('job 未落盘：第二次启动的续跑验证会失败', { jobFile })
        if (loopBefore !== undefined) {
          settings.update({ agent: { ...settings.get().agent, loop: loopBefore } })
        }
      } else {
        detail = 'agent / jobStore / settings 不可用'
      }
    } catch (error) {
      detail = `异常：${String(error)}`
    }
    record('为第二次启动留下一条 paused 的 job（重启续跑验证的前置）', prepared, detail)
  }

  // 3. 提示条两态：断言**真实 BrowserWindow + 原生 shape**（不只状态机）。
  //    纯函数由 edge-bar-geometry.test.ts 覆盖；这里证明稳定宿主只换 shape，
  //    两态切换不会触发布局跳动，且收起态没有不可见的鼠标遮挡区（docs/07 §2.2）。
  //
  //    注意：Windows 的 `getBounds()` / `getShape()` 会带 DPI 或平台 inset 舍入，
  //    因此这里断言**不变量 + 容差**，而不是精确相等。
  if (smokeSection('3')) {
    const near = (a: number, b: number, tolerance: number): boolean => Math.abs(a - b) <= tolerance
    const workArea = screen.getPrimaryDisplay().workArea
    const rightEdge = workArea.x + workArea.width
    // 2026-10-11：两态 shape 都是**多块**（圆角用 1px 阶梯近似成原生区域，DWM 材质按窗口区域
    // 裁剪，见 edge-bar-geometry.ts 的 roundLeftCorners），因此这里一律量**并集**、不取第 0 块。
    const union = (rects: readonly { x: number; y: number; width: number; height: number }[]) => ({
      left: Math.min(...rects.map((r) => r.x)),
      top: Math.min(...rects.map((r) => r.y)),
      right: Math.max(...rects.map((r) => r.x + r.width)),
      bottom: Math.max(...rects.map((r) => r.y + r.height)),
    })
    windows?.setEdgeBarExpanded(false)
    const barCollapsed = windows?.getBounds('edge-bar')
    const collapsedRects = windows?.getEdgeBarShape() ?? []
    const collapsedUnion = union(collapsedRects)
    windows?.setEdgeBarExpanded(true)
    const barExpanded = windows?.getBounds('edge-bar')
    const expandedRects = windows?.getEdgeBarShape() ?? []
    const expandedUnion = union(expandedRects)
    windows?.setEdgeBarExpanded(false)
    const barBack = windows?.getBounds('edge-bar')
    const backRects = windows?.getEdgeBarShape() ?? []
    const backUnion = union(backRects)
    record(
      '提示条收起态只暴露贴右缘且垂直居中的 8×200px shape',
      barCollapsed !== undefined &&
        near(collapsedUnion.right - collapsedUnion.left, EDGE_BAR_WIDTHS.collapsed, 1) &&
        near(collapsedUnion.bottom - collapsedUnion.top, 200, 1) &&
        near(collapsedUnion.top, (barCollapsed.height - 200) / 2, 1) &&
        near(collapsedUnion.left, barCollapsed.width - EDGE_BAR_WIDTHS.collapsed, 1) &&
        near(barCollapsed.x + barCollapsed.width, rightEdge, 4),
      JSON.stringify({ bounds: barCollapsed, union: collapsedUnion, count: collapsedRects.length }),
    )
    record(
      '提示条展开只换 shape：宿主几何不变，展开 shape 铺满面板列 + 竖条（并集贴满整窗）',
      barCollapsed !== undefined &&
        barExpanded !== undefined &&
        near(barExpanded.x, barCollapsed.x, 2) &&
        near(barExpanded.y, barCollapsed.y, 2) &&
        near(barExpanded.width, barCollapsed.width, 2) &&
        near(barExpanded.height, barCollapsed.height, 2) &&
        expandedRects.length > 2 &&
        near(expandedUnion.left, 0, 1) &&
        near(expandedUnion.top, 0, 1) &&
        near(expandedUnion.right, barExpanded.width, 1) &&
        near(expandedUnion.bottom, barExpanded.height, 1),
      JSON.stringify({
        bounds: barExpanded,
        shape: expandedRects.slice(0, 3),
        count: expandedRects.length,
      }),
    )
    record(
      '提示条展开态占满工作区高度（面板按钮不会被挤出可视区）',
      barExpanded !== undefined &&
        barExpanded.height >= workArea.height - 2 * 24 - 6 &&
        barExpanded.height <= workArea.height,
      barExpanded !== undefined ? `height=${barExpanded.height}, workArea=${workArea.height}` : '',
    )
    record(
      '提示条展开 shape 的首块被圆角内缩、收起后重新收成 8×200px',
      (expandedRects[0]?.x ?? 0) > 0 &&
        near(backUnion.right - backUnion.left, EDGE_BAR_WIDTHS.collapsed, 1) &&
        near(backUnion.bottom - backUnion.top, 200, 1),
      JSON.stringify({ firstExpanded: expandedRects[0], backUnion }),
    )
    record(
      '提示条收起后宿主仍稳定且可见 shape 回到初始档位（往返幂等）',
      barBack !== undefined &&
        barCollapsed !== undefined &&
        near(barBack.x, barCollapsed.x, 2) &&
        near(barBack.y, barCollapsed.y, 2) &&
        near(barBack.width, barCollapsed.width, 2) &&
        near(barBack.height, barCollapsed.height, 2) &&
        // 宿主宽度会被 Electron 的透明 inset 抖动 ±2px，因此断言「相对宿主右缘的关系」而不是绝对 x
        near(backUnion.right, barBack.width, 2) &&
        near(backUnion.right - backUnion.left, EDGE_BAR_WIDTHS.collapsed, 1) &&
        near(backUnion.top, (barBack.height - 200) / 2, 1) &&
        near(backUnion.bottom - backUnion.top, 200, 1),
      JSON.stringify({ before: barCollapsed, after: barBack, union: backUnion }),
    )
    const nativeEdge = BrowserWindow.getAllWindows().find(
      (win) => win.getTitle() === 'Aurora 提示条',
    )
    const edgeTopBefore = nativeEdge?.isAlwaysOnTop() === true
    nativeEdge?.setAlwaysOnTop(false)
    const edgeTopRestored = windows?.reassertEdgeBarTopForDiagnostics() === true
    record(
      '提示条置顶丢失后可立即恢复为 screen-saver 置顶',
      edgeTopBefore && edgeTopRestored && nativeEdge?.isAlwaysOnTop() === true,
      JSON.stringify({
        before: edgeTopBefore,
        restored: edgeTopRestored,
        nativeAfter: nativeEdge?.isAlwaysOnTop() ?? null,
      }),
    )

    const automationEditorState = await windows?.showWithPayload(
      'automation',
      IPC.automation.windowRequest,
      {
        requestId: 'smoke-automation-editor',
        view: 'editor',
        mode: 'normal',
      },
    )
    await windows?.whenLoaded('automation')
    const firstAutomationWindow = BrowserWindow.getAllWindows().find(
      (win) => win.getTitle() === 'Aurora 自动化',
    )
    const automationEditorVisible = automationEditorState?.visible['automation'] === true
    const automationHistoryState = await windows?.showWithPayload(
      'automation',
      IPC.automation.windowRequest,
      {
        requestId: 'smoke-automation-history',
        view: 'history',
        mode: 'agent',
      },
    )
    const automationWindows = BrowserWindow.getAllWindows().filter(
      (win) => win.getTitle() === 'Aurora 自动化',
    )
    const automationReused =
      firstAutomationWindow !== undefined &&
      automationWindows.length === 1 &&
      automationWindows[0] === firstAutomationWindow
    windows?.hide('automation')
    const automationHidden = windows?.getState().visible['automation'] !== true
    record(
      '自动化详情窗口单例复用，可依次切换编辑器 / 历史并在关闭后隐藏',
      automationEditorVisible &&
        automationHistoryState?.visible['automation'] === true &&
        automationReused &&
        automationHidden,
      JSON.stringify({
        editorVisible: automationEditorVisible,
        historyVisible: automationHistoryState?.visible['automation'] === true,
        windowCount: automationWindows.length,
        reused: automationReused,
        hidden: automationHidden,
      }),
    )

    windows?.ensure('chat')
    const nativeChat = BrowserWindow.getAllWindows().find((win) => win.getTitle() === 'Aurora 对话')
    const nativeBeforeMaximize = windows?.usesNativeGlass('chat') === true
    const boundsBeforeMaximize = windows?.getBounds('chat')
    windows?.toggleMaximize('chat')
    await new Promise((resolve) => setTimeout(resolve, 350))
    const maximizedState = windows?.getState().maximized ?? {}
    const maximized = maximizedState.chat === true
    const nativeWhileMaximized = windows?.usesNativeGlass('chat') === true
    const nativeMaximized = nativeChat?.isMaximized() === true
    windows?.toggleMaximize('chat')
    await new Promise((resolve) => setTimeout(resolve, 350))
    const nativeAfterRestore = windows?.usesNativeGlass('chat') === true
    const restoredMaximized = windows?.getState().maximized?.chat === true
    const boundsAfterRestore = windows?.getBounds('chat')
    const restoredGeometry =
      boundsBeforeMaximize !== undefined &&
      boundsAfterRestore !== undefined &&
      near(boundsAfterRestore.x, boundsBeforeMaximize.x, 8) &&
      near(boundsAfterRestore.y, boundsBeforeMaximize.y, 8) &&
      near(boundsAfterRestore.width, boundsBeforeMaximize.width, 8) &&
      near(boundsAfterRestore.height, boundsBeforeMaximize.height, 8)
    record(
      '毛玻璃窗口使用系统最大化，还原后仍保持 Acrylic',
      nativeBeforeMaximize &&
        maximized &&
        nativeMaximized &&
        nativeWhileMaximized &&
        nativeAfterRestore &&
        restoredMaximized !== true &&
        restoredGeometry,
      JSON.stringify({
        nativeBeforeMaximize,
        maximized,
        nativeMaximized,
        nativeWhileMaximized,
        nativeAfterRestore,
        restoredMaximized,
        restoredGeometry,
        boundsBeforeMaximize,
        boundsAfterRestore,
      }),
    )

    // 拖动区双击 / Win+↑ 直接触发原生 maximize，也必须保持原生最大化语义与材质。
    if (nativeChat !== undefined) {
      nativeChat.maximize()
      await new Promise((resolve) => setTimeout(resolve, 350))
      const nativeEntryMaximized = windows?.getState().maximized?.chat === true
      const nativeEntryStayedNative = nativeChat.isMaximized() === true
      windows?.toggleMaximize('chat')
      await new Promise((resolve) => setTimeout(resolve, 350))
      const nativeRestoreBounds = windows?.getBounds('chat')
      const nativeEntryRestored =
        nativeRestoreBounds !== undefined &&
        boundsBeforeMaximize !== undefined &&
        near(nativeRestoreBounds.x, boundsBeforeMaximize.x, 8) &&
        near(nativeRestoreBounds.y, boundsBeforeMaximize.y, 8) &&
        near(nativeRestoreBounds.width, boundsBeforeMaximize.width, 8) &&
        near(nativeRestoreBounds.height, boundsBeforeMaximize.height, 8)
      record(
        '原生 maximize 入口保持系统最大化语义，关闭后还原几何',
        nativeEntryMaximized &&
          nativeEntryStayedNative &&
          windows?.usesNativeGlass('chat') === true &&
          nativeEntryRestored,
        JSON.stringify({
          nativeEntryMaximized,
          nativeEntryStayedNative,
          nativeGlassAfterRestore: windows?.usesNativeGlass('chat') === true,
          nativeEntryRestored,
          boundsAfterNativeEntryRestore: windows?.getBounds('chat'),
        }),
      )
    }
  }

  // 4. 电脑操控工具（docs/06 §11）：用**真实的 Windows 进程与文件系统**证明
  //    「模型真的能操控电脑」这条链路在主进程装配下是通的。
  //
  //    这里断言的是**已装配**的清单而不是 `COMPUTER_TOOL_NAMES` 全量：后者是「开关要认的名字」，
  //    它的元素要等对应工具真正被创建出来才算数（当前 15 个全部交付，两处一致但仍显式列出）。
  //    显式列出而不写死长度：新增工具时同步加名字，断言仍是逐条精确的。
  const SMOKE_IMPLEMENTED_TOOLS = [
    'run_command',
    'read_file',
    'write_file',
    'edit_file',
    'office_read',
    'office_help',
    'office_create',
    'office_edit',
    'office_render',
    'office_pdf',
    'office_raw_edit',
    'list_dir',
    'open_path',
    'grep',
    'glob',
  ] as const
  if (smokeSection('4')) {
    const names = tools ? tools.list().map((tool) => tool.name) : []
    const missing = SMOKE_IMPLEMENTED_TOOLS.filter((name) => !names.includes(name))
    record(
      `电脑操控工具已注册（${SMOKE_IMPLEMENTED_TOOLS.length} 个）`,
      missing.length === 0,
      `names=${names.join(',')}${missing.length === 0 ? '' : ` missing=${missing.join(',')}`}`,
    )

    // 敏感级直接钉住 step 1 文档里写的值：这几个工具的每一次调用都必须弹确认卡片
    const runCommand = tools?.get('run_command')
    const writeFile = tools?.get('write_file')
    const editFile = tools?.get('edit_file')
    const readFile = tools?.get('read_file')
    const officeRead = tools?.get('office_read')
    const officeHelp = tools?.get('office_help')
    const officeCreate = tools?.get('office_create')
    const officeEdit = tools?.get('office_edit')
    const officeRender = tools?.get('office_render')
    const officePdf = tools?.get('office_pdf')
    const officeRawEdit = tools?.get('office_raw_edit')
    const grep = tools?.get('grep')
    const glob = tools?.get('glob')
    record(
      '敏感级与文档一致（写类 Office / PDF / raw = confirm，read/help/render = safe）',
      runCommand?.sensitivity === 'confirm' &&
        writeFile?.sensitivity === 'confirm' &&
        editFile?.sensitivity === 'confirm' &&
        officeCreate?.sensitivity === 'confirm' &&
        officeEdit?.sensitivity === 'confirm' &&
        officePdf?.sensitivity === 'confirm' &&
        officeRawEdit?.sensitivity === 'confirm' &&
        readFile?.sensitivity === 'safe' &&
        officeRead?.sensitivity === 'safe' &&
        officeHelp?.sensitivity === 'safe' &&
        officeRender?.sensitivity === 'safe' &&
        grep?.sensitivity === 'safe' &&
        glob?.sensitivity === 'safe',
      `office_create=${officeCreate?.sensitivity ?? 'missing'} office_edit=${officeEdit?.sensitivity ?? 'missing'} office_pdf=${officePdf?.sensitivity ?? 'missing'} office_raw_edit=${officeRawEdit?.sensitivity ?? 'missing'} office_read=${officeRead?.sensitivity ?? 'missing'} office_help=${officeHelp?.sensitivity ?? 'missing'} office_render=${officeRender?.sensitivity ?? 'missing'}`,
    )

    // 真实执行一条命令并读回产物。
    // 注 1：这里**直接调 `execute` 而不走确认链路** —— 自测下没有渲染层点击确认，
    //       走状态机会白等 60s 然后被拒；确认链路本身已由 `proactive.test.ts` 与既有 smoke 覆盖。
    // 注 2：产物写在**专用空目录**里，而不是直接丢进 `%TEMP%`：`list_dir` 的默认上限是 200 条
    //       且目录排在文件前面，系统临时目录里有上千个子目录时文件会被整段截掉 ——
    //       那会变成"断言永远失败"，而不是"功能坏了"。
    const probeDir = join(tmpdir(), `aurora-smoke-tools-${Date.now()}`)
    const probeFile = join(probeDir, 'aurora-ctrl-ok.txt')
    let executed = false
    let readBackOk = false
    let listedOk = false
    let officeOk = false
    let officeDetail = ''
    let commandDetail = ''
    try {
      await fs.mkdir(probeDir, { recursive: true })
      // 探针目录即本段的"临时项目根"：文件类工具的边界按会话解析，未绑定会话恒落
      // Agent 空间（桌面\Aurora），%TEMP% 下的探针会被整片拒掉 —— 那测到的就不是
      //「工具能不能用」而是「越界拒绝」了。
      await bindSmokeProject('smoke', 'smoke-tools', probeDir)
      const command = await runCommand?.execute(
        {
          // PowerShell 单引号字面量里的单引号要写成两个：路径来自 tmpdir()，正常不会含引号，
          // 但拼接前先转义，免得将来换成用户可控路径时这里变成一个注入点。
          command: `Set-Content -LiteralPath '${probeFile.replace(/'/g, "''")}' -Value AURORA_CTRL_OK -Encoding UTF8`,
        },
        { sessionId: 'smoke' },
      )
      executed = command !== undefined && command.isError !== true
      commandDetail = command === undefined ? 'run_command 未注册' : command.content.slice(0, 80)

      const readBack = await readFile?.execute({ path: probeFile }, { sessionId: 'smoke' })
      readBackOk = readBack !== undefined && readBack.content.includes('AURORA_CTRL_OK')

      const listed = await tools
        ?.get('list_dir')
        ?.execute({ path: probeDir }, { sessionId: 'smoke' })
      listedOk =
        listed !== undefined &&
        listed.isError !== true &&
        listed.content.includes(basename(probeFile))
      if (!listedOk && listed !== undefined) commandDetail = listed.content.slice(0, 120)

      const officeFile = join(probeDir, 'aurora-office-smoke.docx')
      const created = await officeCreate?.execute(
        {
          path: officeFile,
          format: 'docx',
          commands: [
            {
              command: 'add',
              parent: '/body',
              type: 'paragraph',
              props: { text: 'AURORA_OFFICE_OK' },
            },
          ],
        },
        { sessionId: 'smoke' },
      )
      const officeReadBack = await officeRead?.execute(
        { path: officeFile, mode: 'text' },
        { sessionId: 'smoke' },
      )
      const officeEdited = await officeEdit?.execute(
        {
          path: officeFile,
          overwrite: true,
          commands: [
            {
              command: 'set',
              path: '/',
              props: { find: 'AURORA_OFFICE_OK', replace: 'AURORA_OFFICE_EDITED' },
            },
          ],
        },
        { sessionId: 'smoke' },
      )
      const officeRendered = await officeRender?.execute(
        { path: officeFile, mode: 'screenshot', pageStart: 1, pageEnd: 1, maxPages: 1 },
        { sessionId: 'smoke' },
      )
      const pdfPath = join(probeDir, 'aurora-office-smoke.pdf')
      const officePdfResult = await officePdf?.execute(
        { path: officeFile, outputPath: pdfPath },
        { sessionId: 'smoke' },
      )
      officeOk =
        created !== undefined &&
        created.isError !== true &&
        officeReadBack !== undefined &&
        officeReadBack.isError !== true &&
        officeReadBack.content.includes('AURORA_OFFICE_OK') &&
        officeEdited !== undefined &&
        officeEdited.isError !== true &&
        officeRendered !== undefined &&
        officeRendered.isError !== true &&
        (officeRendered.images?.length ?? 0) > 0 &&
        officePdfResult !== undefined &&
        officePdfResult.isError !== true &&
        existsSync(pdfPath)
      officeDetail =
        officePdfResult?.content.slice(0, 140) ??
        officeEdited?.content.slice(0, 140) ??
        created?.content.slice(0, 140) ??
        ''
    } catch (error) {
      commandDetail = `异常：${String(error)}`
    }

    record(
      '真实执行 run_command 后 read_file 能读回产物',
      executed && readBackOk,
      `exit=${executed ? 'ok' : 'fail'} readBack=${readBackOk ? 'ok' : 'fail'} file=${probeFile}`,
    )
    record('list_dir 能在该目录看到刚写入的文件', listedOk, commandDetail)
    record('Office 专用工具在真实 worker 中创建、读取并另存编辑', officeOk, officeDetail)
    await fs.rm(probeDir, { recursive: true, force: true }).catch(() => undefined)

    // 4.1 搜索层（docs/06 §11.5）：`glob` 按名字找、`grep` 按内容找，都走真实文件系统。
    //     两层子目录 + 一个 node_modules 里的同名文件，用来同时证明「递归」与「忽略目录」。
    let globOk = false
    let grepOk = false
    let grepIgnoredOk = false
    let searchDetail = ''
    const searchDir = join(tmpdir(), `aurora-smoke-search-${Date.now()}`)
    try {
      await fs.mkdir(join(searchDir, 'src', 'deep'), { recursive: true })
      // 复用同一个项目 id 改绑到搜索目录（`bindSmokeProject` 会替换同 id 的旧项）。
      await bindSmokeProject('smoke', 'smoke-tools', searchDir)
      await fs.mkdir(join(searchDir, 'node_modules', 'pkg'), { recursive: true })
      await fs.writeFile(
        join(searchDir, 'src', 'deep', 'marker.txt'),
        'first\nAURORA_GREP_OK\n',
        'utf8',
      )
      await fs.writeFile(
        join(searchDir, 'node_modules', 'pkg', 'skipped.txt'),
        'AURORA_GREP_OK\n',
        'utf8',
      )

      const globbed = await tools
        ?.get('glob')
        ?.execute({ path: searchDir, pattern: '**/*.txt' }, { sessionId: 'smoke' })
      const globText = globbed?.content ?? ''
      globOk =
        globbed !== undefined &&
        globbed.isError !== true &&
        globText.includes('src/deep/marker.txt') &&
        // 忽略目录整棵子树跳过：node_modules 里的文件不该出现在结果里
        !globText.includes('skipped.txt')

      const grepped = await tools
        ?.get('grep')
        ?.execute({ path: searchDir, pattern: 'AURORA_GREP_OK' }, { sessionId: 'smoke' })
      const grepText = grepped?.content ?? ''
      // 命中行格式是 `<相对路径>:<行号>: <内容>`，行号 1 起始（marker.txt 的命中在第 2 行）
      // 负对照（"没扫 node_modules"）必须建立在**调用真的成功**之上：grep 失败时返回的是
      // 错误文案，里面当然不含 `skipped.txt` —— 那样 `grepIgnoredOk` 恒真，这半条断言
      // 等于没跑（2026-09-30 起 grep 被边界拒绝，它就是靠这个空真一直报 ok 的）。
      const grepSucceeded = grepped !== undefined && grepped.isError !== true
      grepOk = grepSucceeded && grepText.includes('src/deep/marker.txt:2: AURORA_GREP_OK')
      grepIgnoredOk = grepSucceeded && !grepText.includes('skipped.txt')
      searchDetail = globText.slice(0, 100)
    } catch (error) {
      searchDetail = `异常：${String(error)}`
    }
    record('glob 递归找到嵌套文件（正斜杠相对路径）且不扫 node_modules', globOk, searchDetail)
    record(
      'grep 命中行带「相对路径:行号」且不扫 node_modules',
      grepOk && grepIgnoredOk,
      `match=${grepOk ? 'ok' : 'fail'} ignored=${grepIgnoredOk ? 'ok' : 'fail'}`,
    )
    await fs.rm(searchDir, { recursive: true, force: true }).catch(() => undefined)

    // 开关热生效：`settings:update` 是顶层浅合并，必须带**完整**的 agent.tools 子树，
    // 否则会把 files / open 配置写丢 —— 这条断言顺带回归这一点。
    // ⚠️ v13 起 `agent` 组还多了 `permissionMode`，而 `SettingsStore.update` 的 `Partial<Settings>`
    // 只放宽顶层键、**值仍是完整类型**：少带一个兄弟键就会被 Schema 的默认值补回，
    // 等于把用户选的 readonly / auto 档静默重置成 confirm。所以整组展开，别只写 tools。
    let hotSwitchOk = false
    let subtreeKept = false
    if (settings !== undefined) {
      const agentBefore = settings.get().agent
      const before = agentBefore.tools
      settings.update({
        agent: {
          ...agentBefore,
          tools: { ...before, terminal: { ...before.terminal, enabled: false } },
        },
      })
      syncToolRegistries()
      const offSoFar =
        tools?.get('run_command') === undefined && tools?.get('open_path') !== undefined

      settings.update({
        agent: {
          ...agentBefore,
          tools: { ...before, terminal: { ...before.terminal, enabled: true } },
        },
      })
      syncToolRegistries()
      const backOn = tools?.get('run_command') !== undefined

      const after = settings.get().agent.tools
      subtreeKept =
        after.files.maxReadBytes === before.files.maxReadBytes &&
        after.open.enabled === before.open.enabled
      hotSwitchOk = offSoFar && backOn && subtreeKept
    }
    record(
      '开关热生效：关掉终端立刻摘掉 run_command（open_path 仍在），改回即恢复且 files/open 没被写丢',
      hotSwitchOk,
      hotSwitchOk ? '' : `subtreeKept=${subtreeKept}`,
    )

    // 总开关：`00-index.md` 完成标准点名的那一条 —— 关闭后全部电脑操控工具**一个都不剩**，
    // 且不能误伤其它工具（`unregister` 只按 `COMPUTER_TOOL_NAMES` 摘，`use_skill` / `mcp.*` 不受影响）。
    let masterOffOk = false
    if (settings !== undefined) {
      // 同「开关热生效」：`agent` 整组展开，别把 permissionMode 这类兄弟键写丢
      const agentBefore = settings.get().agent
      const before = agentBefore.tools
      settings.update({ agent: { ...agentBefore, tools: { ...before, enabled: false } } })
      syncToolRegistries()
      // 「关掉后一个都不剩」按 `COMPUTER_TOOL_NAMES` 全量断言（比已装配清单更宽：
      // 连将来才装配的名字也要求被摘掉）；「改回即恢复」只能按**已装配**清单断言。
      const allGone = COMPUTER_TOOL_NAMES.every((name) => tools?.get(name) === undefined)
      const othersKept = tools?.get('use_skill') !== undefined

      settings.update({ agent: { ...agentBefore, tools: { ...before, enabled: true } } })
      syncToolRegistries()
      const restored = SMOKE_IMPLEMENTED_TOOLS.every((name) => tools?.get(name) !== undefined)
      masterOffOk = allGone && othersKept && restored
    }
    record(
      `总开关热生效：关闭后 ${SMOKE_IMPLEMENTED_TOOLS.length} 个工具全部从注册表移除（其它工具不受影响），改回即恢复`,
      masterOffOk,
      masterOffOk ? '' : '总开关断言失败',
    )

    // 图像工具的门控（docs/06 §25）：它是**按模型能力**注册的，而不是按开关 ——
    // 这里在真实的 `syncToolRegistries()` 链上钉「注册表里有没有这三个工具」，
    // 单测只覆盖了装配器本身，覆盖不到「settings:changed → sync」这段接线。
    let imageGateOk = false
    let imageGateDetail = '配置存储未就绪'
    if (settings !== undefined) {
      // 收进局部常量：闭包里的窄化不会保留（`settings` 是可能为 undefined 的 let）
      const store = settings
      const llmBefore = store.get().llm
      const writeVision = (vision: boolean): void => {
        const current = store.get().llm
        store.update({
          llm: {
            active: 'smoke-image',
            providers: {
              ...current.providers,
              'smoke-image': {
                type: 'openai-compat',
                baseUrl: 'http://127.0.0.1:1/v1',
                apiKeyEnc: '',
                model: 'vision-model',
                modelList: ['vision-model'],
                // 只写三个必填子字段：本段要的是 vision 这一位的效果，别的取值无关
                modelParams: {
                  'vision-model': { reasoningEffort: 'auto', contextWindow: 0, vision },
                },
              },
            },
          },
        })
        syncToolRegistries()
      }
      const present = (): boolean[] =>
        IMAGE_TOOL_NAMES.map((name) => tools?.get(name) !== undefined)

      writeVision(false)
      const off = present()
      writeVision(true)
      const on = present()

      // 复原：把 `llm` 整组写回（`settings:update` 是顶层浅合并，少带一个键就丢配置）
      store.update({ llm: { active: llmBefore.active, providers: llmBefore.providers } })
      syncToolRegistries()

      imageGateOk = off.every((value) => !value) && on.every((value) => value)
      imageGateDetail = imageGateOk ? '' : `off=${off.join(',')} on=${on.join(',')}`
    }
    record(
      '图像工具按模型能力注册：vision 关着时三个工具都不在表里，打开后全部出现',
      imageGateOk,
      imageGateDetail,
    )
  }

  // 5. `set_setting` 的 crash 矩阵（docs/06 §12、step 02 第 8 条）：
  //    逐条写入「AI 可能写出的坏值」，每条都断言**四件事**：
  //    ① 工具的接受 / 拒绝符合预期；② `set_setting` 自己没被写没；
  //    ③ 期望生效的值**真的生效**（含三层路径与同分组兄弟字段是否被抹掉）；
  //    ④ **磁盘上**的 config.json 仍是 `SettingsSchema` 能解析的合法配置。
  //    第 ④ 条刻意读盘、而不是 `safeParse(settings.get())` —— 后者恒真：
  //    `SettingsStore.get()` 的内存态本来就只装「通过了 safeParse」的候选值，
  //    拿它当证据等于什么都没测；而「AI 改设置导致应用崩」的真实风险正是**下次启动读盘**时炸。
  if (smokeSection('5') && settings !== undefined && tools !== undefined) {
    const setSetting = tools.get('set_setting')
    const configPath = join(userData, 'config.json')
    // 「拒绝后逐字未变」的判据取**改动前**的实测值，不写死数字：
    // `agent.loop.maxRounds` 的默认值历史上是 8，v0.2.4 放宽到 32 —— 写死数字的断言
    // 会在默认值调整时变成假失败（本轮实测就踩到）。
    const loopMaxRoundsBefore = settings.get().agent.loop.maxRounds
    const crashMatrix: Array<{
      path: string
      value: unknown
      expectReject: boolean
      /** 接受后的**可观测**结果（含被 `sanitize` 规范化的情形） */
      expect?: (current: Settings) => boolean
      expectNote?: string
    }> = [
      {
        path: 'agent.tools.enabled',
        value: false,
        expectReject: false,
        expect: (current) => current.agent.tools.enabled === false,
        expectNote: '总开关确实被关掉（深合并没有抹掉同分组兄弟字段）',
      },
      {
        path: 'agent.tools.terminal.timeoutMs',
        value: 20_000,
        expectReject: false,
        expect: (current) => current.agent.tools.terminal.timeoutMs === 20_000,
        expectNote: '三层路径可写',
      },
      {
        path: 'general.edgeBar.opacity',
        value: 0.5,
        expectReject: false,
        expect: (current) => current.general.edgeBar.opacity === 0.5,
        expectNote: 'general 分组深合并',
      },
      { path: 'advanced.logLevel', value: 'verbose', expectReject: true },
      {
        path: 'llm.active',
        value: 'nope',
        expectReject: false,
        expect: (current) => current.llm.active === '',
        expectNote: '指向不存在的 provider 被 sanitize 规范化成空串（工具应如实回报「未生效」）',
      },
      { path: 'modes.classroom.typo', value: 1, expectReject: true },
      { path: 'llm.providers.x.apiKeyEnc', value: 'leak', expectReject: true },
      {
        path: 'agent.loop.maxRounds',
        value: 64,
        expectReject: true,
        expect: (current) => current.agent.loop.maxRounds === loopMaxRoundsBefore,
        expectNote: '拒绝后配置逐字未变',
      },
      {
        path: 'agent.snapshots.enabled',
        value: false,
        expectReject: true,
        expect: (current) => current.agent.snapshots.enabled === true,
        expectNote: '拒绝后配置逐字未变',
      },
    ]

    for (const item of crashMatrix) {
      const outcome =
        setSetting === undefined
          ? { rejected: false, note: 'set_setting 未注册' }
          : await writeSettingThroughTool(setSetting, item.path, item.value)
      await settings.flush()
      let diskOk = false
      let diskNote = ''
      try {
        diskOk = SettingsSchema.safeParse(JSON.parse(await fs.readFile(configPath, 'utf8'))).success
      } catch (error) {
        diskNote = `磁盘配置不可解析：${String(error)}`
      }
      const toolKept = tools.get('set_setting') !== undefined
      const rejectOk = item.expectReject ? outcome.rejected : true
      const effectOk = item.expect === undefined ? true : item.expect(settings.get())
      record(
        `配置写入不会写坏（${item.path}）`,
        diskOk && toolKept && rejectOk && effectOk,
        [
          `accepted=${outcome.rejected ? 'no' : 'yes'}`,
          `expected=${item.expectReject ? 'reject' : 'accept'}`,
          `effect=${effectOk ? 'ok' : 'FAIL'}`,
          `disk=${diskOk ? 'ok' : 'FAIL'}`,
          `toolKept=${toolKept ? 'yes' : 'no'}`,
          item.expectNote ?? '',
          outcome.note,
          diskNote,
        ]
          .filter((part) => part !== '')
          .join(' '),
      )
    }

    // 复位：第 1 条故意关了总开关、`llm.active` 那条会被 sanitize 清空，都复原回去，
    // 让收尾清理与下一次 dev 运行看到的是正常状态。
    const afterMatrix = settings.get()
    settings.update({
      // `agent` 整组展开（同「开关热生效」那条）：少带 permissionMode 会被默认值补回
      agent: { ...afterMatrix.agent, tools: { ...afterMatrix.agent.tools, enabled: true } },
      llm: { active: 'smoke', providers: afterMatrix.llm.providers },
    })
    syncToolRegistries()

    // 5.1 「AI 用 run_command 手改配置文件」这条路径：直接把 config.json 写成非法 JSON，
    //     重新走一遍 `SettingsStore.init()` 的读取链路后，`settings.get()` 必须仍是一份
    //     合法配置（损坏文件走「备份后重建」，见 packages/shared 的 store.ts）。
    //     没有这条断言，"AI 绕过一切校验改配置"就只是文档里的承诺。
    let corruptRecovered = false
    let corruptDetail = ''
    try {
      await fs.writeFile(configPath, '{ 这不是合法 JSON ---', 'utf8')
      const report = await settings.init()
      const parsedAfter = SettingsSchema.safeParse(settings.get())
      corruptRecovered = report.corrupted && parsedAfter.success
      corruptDetail = `corrupted=${report.corrupted} backup=${report.backupPath ?? 'none'}`
      // 内存里已是重建后的合法配置，但落盘是防抖的：显式 flush 一次，
      // 让"损坏文件已被合法配置替换"在磁盘上也立刻成立（下面的收尾清理依赖它）。
      await settings.flush()
    } catch (error) {
      corruptDetail = `异常：${String(error)}`
    }
    record('损坏 config.json 仍能恢复为合法配置', corruptRecovered, corruptDetail)
  }

  // 2.8 多模态输入（docs/06 §3.1，v22）：真实图片文件 → 主进程读盘 → 内核组装 → 真实 HTTP 桩。
  //     两个方向都断言，因为**少任何一半都测不出这条链的价值**：
  //     ① 开关打开时请求体里必须出现 `image_url` 分片（否则"图片进模型"只是文档里的承诺）；
  //     ② 开关关闭时**一个分片都不许有**（对不支持视觉的模型发图片会被服务端 400，
  //        这个开关就是为此存在的 —— 退化方向错了等于把可用性事故引回来）。
  if (smokeSection('2.8') && settings !== undefined && agent !== undefined && stub !== undefined) {
    const imagePath = join(userData, 'smoke-image.png')
    let detail = ''
    let multimodalOk = false
    try {
      // 1×1 透明 PNG：不需要真的能解码 —— 这条链验的是「字节被读成 base64 并作为图片分片下发」
      await fs.writeFile(
        imagePath,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
          'base64',
        ),
      )
      const sendWithImages = async (
        sessionId: string,
        images: readonly string[],
      ): Promise<string> => {
        let outcome = ''
        const off = agent!.onEvent((event) => {
          if (event.sessionId !== sessionId) return
          if (event.type === 'done') outcome = 'done'
          else if (event.type === 'error') outcome = `error:${event.code}:${event.message}`
        })
        await agent!.send({ sessionId, text: '多模态自测', origin: 'chat', images })
        const deadline = Date.now() + 20_000
        while (outcome === '' && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        off()
        return outcome === '' ? 'timeout' : outcome
      }
      /** 最后一个请求里那条 user 消息的 `content`（形状取决于是不是带图片的那一轮） */
      const lastUserContentOf = (): unknown => {
        for (const request of [...stub.requests].reverse()) {
          if (!request.path.endsWith('/chat/completions')) continue
          const messages = request.body?.messages ?? []
          const user = [...messages].reverse().find((message) => message.role === 'user')
          if (user !== undefined) return user.content
        }
        return undefined
      }
      /**
       * 写开关。这里做三件事，缺一条都会让本段以**看着像图片链路坏了**的方式失败：
       * ① `llm.active` 拽回 `smoke` —— 第 5 段的 crash 矩阵会把 `llm.active` 写成不存在的 id，
       *    `sanitize` 随后把它规范化成**空串**；
       * ② 重新写回 `smoke` 的 API Key —— 渲染层脚本收尾时按卫生习惯 `clearSecret` 过它，
       *    没有 Key 时 `createProviderFactory` 会**静默回退**到另一个可用条目
       *    （日志里是一条 `默认模型配置不可用，已回退到可用条目`），而那一条的 `vision` 是关的，
       *    于是请求照发、图却没进请求体；
       * ③ 设 `vision` 本身。
       */
      /**
       * 写开关。这里做三件事，缺一条都会让本段以**看着像图片链路坏了**的方式失败：
       * ① `llm.active` 拽回 `smoke` —— 第 5 段的 crash 矩阵会把 `llm.active` 写成不存在的 id，
       *    `sanitize` 随后把它规范化成**空串**；
       * ② **把 `smoke` 条目整体写回去**（而不是只改 `vision`）—— 前面的段可能已经把它删了，
       *    条目不存在时 `setSecret` 会以「无法识别的凭据路径」抛错，整段直接进 catch；
       * ③ 重新写回 API Key —— 渲染层脚本收尾时按卫生习惯 `clearSecret` 过它，没有 Key 时
       *    `createProviderFactory` 会**静默回退**到另一个可用条目（日志里是
       *    `默认模型配置不可用，已回退到可用条目`），而那一条的 `vision` 是关的，
       *    于是请求照发、图却没进请求体。
       * 顺序不可换：`setSecret` 要求该 provider 已经存在于配置里。
       */
      const setVision = (vision: boolean): void => {
        settings!.update({
          llm: {
            active: 'smoke',
            providers: {
              ...settings!.get().llm.providers,
              smoke: {
                type: 'openai-compat',
                baseUrl: stub!.baseUrl,
                apiKeyEnc: '',
                model: STUB_MODEL,
                modelList: [STUB_MODEL],
                // 开关落在**当前生效模型**的参数里（v23）；三项写全，别只翻 vision
                modelParams: {
                  [STUB_MODEL]: { reasoningEffort: 'auto', contextWindow: 0, vision },
                },
              },
            },
          },
        })
        settings!.setSecret('llm.providers.smoke.apiKey', STUB_API_KEY)
      }

      /** 请求体里那条 user 消息的形状摘要（失败详情用：看得见「有没有图片分片」即可） */
      const shapeOf = (content: unknown): string => {
        if (typeof content === 'string') return `string(${content.length})`
        if (!Array.isArray(content)) return String(content)
        const kinds = content
          .map((part) => String((part as { type?: unknown }).type ?? '?'))
          .join('+')
        return `array:${kinds}`
      }

      setVision(true)
      const requestsBefore = stub.requests.length
      const onOutcome = await sendWithImages('smoke-image-on', [imagePath])
      const withImages = lastUserContentOf()
      const onRequests = stub.requests.slice(requestsBefore).length
      const onShape = shapeOf(withImages)
      const onOk =
        onOutcome === 'done' &&
        Array.isArray(withImages) &&
        withImages.some(
          (part) =>
            (part as { type?: unknown }).type === 'image_url' &&
            typeof (part as { image_url?: { url?: unknown } }).image_url?.url === 'string' &&
            (part as { image_url: { url: string } }).image_url.url.startsWith(
              'data:image/png;base64,',
            ),
        )

      setVision(false)
      const offOutcome = await sendWithImages('smoke-image-off', [imagePath])
      const withoutImages = lastUserContentOf()
      const offRequests = stub.requests.slice(requestsBefore).length - onRequests
      const offShape = shapeOf(withoutImages)
      const offOk = offOutcome === 'done' && typeof withoutImages === 'string'

      // 会话历史里存的是**路径**（跨轮次重放的前提）：一张 4 MB 的图 base64 后是 5.3 MB，
      // 存内容会把 sessions/*.json 顶成几十 MB
      const stored = await sessions!.get('smoke-image-on')
      const storedUser = stored.find((message) => message.role === 'user')
      const storedOk = Array.isArray(storedUser?.images) && storedUser?.images[0] === imagePath

      multimodalOk = onOk && offOk && storedOk
      detail =
        `on=${onOk}(${onOutcome},${onShape}) off=${offOk}(${offOutcome},${offShape})` +
        ` storedPath=${storedOk} req=${onRequests}+${offRequests}`
    } catch (error) {
      detail = `异常：${String(error)}`
    }
    record(
      '多模态输入：开启时图片作为 image_url 分片下发且历史只存路径；关闭时不下发图片分片',
      multimodalOk,
      detail,
    )
    // 收尾：把开关与默认 provider 复原（后续清理与磁盘不变量断言都假设配置是"干净"的）。
    // 注意 `llm.active` 也一并写回：本段开头为了绕开第 5 段留下的空 active 而把它设成了 `smoke`。
    try {
      const llm = settings.get().llm
      const smoke = llm.providers['smoke']
      settings.update({
        llm: {
          ...llm,
          active: 'smoke',
          providers:
            smoke === undefined
              ? { ...llm.providers }
              : { ...llm.providers, smoke: withModelParams(smoke, { vision: false }) },
        },
      })
    } catch {
      /* 复原失败不影响断言结果 */
    }
  }

  for (const item of results) {
    const line = `${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail === '' ? '' : ` — ${item.detail}`}`
    if (item.ok) logger?.info(`${SMOKE_RESULT_PREFIX} ${line}`)
    else logger?.error(`${SMOKE_RESULT_PREFIX} ${line}`)
  }

  // 磁盘不变量：任何时刻都不得出现明文凭据。
  // 注：这里刻意**不再**断言"apiKeyEnc 非空" —— 脚本最后一步会主动 clearSecret
  // （正确的卫生习惯），因此该时点已无密文；"密文确实落库且可解密"由
  // 脚本内的 hasSecret#smoke / update(llm#stub) 断言在清理**之前**覆盖。
  try {
    const raw = await fs.readFile(join(userData, 'config.json'), 'utf8')
    const leaked =
      raw.includes('sk-smoke-plaintext-marker') ||
      raw.includes('sk-fresh-marker') ||
      raw.includes('sk-mcp-plaintext-marker') ||
      raw.includes('sk-remove-marker') ||
      /"apiKey"\s*:/.test(raw)
    logger?.[leaked ? 'error' : 'info'](
      `${SMOKE_RESULT_PREFIX} ${leaked ? 'FAIL' : 'PASS'} 磁盘无明文 API Key`,
    )
  } catch (error) {
    logger?.error(`${SMOKE_RESULT_PREFIX} FAIL 读取配置文件 — ${String(error)}`)
  }

  const failed = results.filter((item) => !item.ok)
  logger?.info(
    `${SMOKE_RESULT_PREFIX} SUMMARY ${results.length - failed.length}/${results.length} passed`,
  )

  // 清理：关闭桩服务、移除自测 provider 与其凭据
  await stub.close().catch(() => undefined)
  try {
    settings?.clearSecret('llm.providers.smoke.apiKey')
    const cleanup = settings?.mutate((draft) => {
      delete draft.llm.providers['smoke']
      if (draft.llm.active === 'smoke') draft.llm.active = ''
    })
    void cleanup
    await settings?.flush()
  } catch (error) {
    logger?.warn('自测清理失败', { error: String(error) })
  }

  await logger?.close()
  // 临时 userData 是整个自测的产物，清理掉避免堆在系统临时目录。
  // ⚠️ 固定工作区（两次启动验证）**绝不能删**：第二次启动正要读它 ——
  // 不排除的话症状是"第一次启动明明 file=yes，第二次却 found=0"，而且因为是 `rm -rf`
  // 与收尾写入抢时序，偶尔还能剩下几个文件，看起来像随机丢数据（实测踩过）。
  if (smokeWorkspace !== undefined && pinnedSmokeWorkspace === undefined) {
    // 同 runCapture：先停技能目录监听再删树（app.exit 不走 before-quit，见彼处注释）
    skillsService?.stopWatching()
    await fs.rm(smokeWorkspace, { recursive: true, force: true }).catch(() => undefined)
  }
  app.exit(failed.length === 0 ? 0 : 2)
}

/**
 * 第二次启动的续跑验证（step 5，`AURORA_SMOKE_PHASE=resume` + `AURORA_SMOKE_WORKSPACE=<同一个目录>`）。
 *
 * 这是 job 的核心承诺（docs/06 §4.1「重启后还能接着跑」）唯一的**跨进程**证据：
 * 第一次启动把一条任务跑到 `paused` 就退出，第二次启动在**同一个 userData** 上把它读回来、
 * 点「继续」跑完。前四步的断言都在同一次启动内，"进程内续跑"证明不了"重启后还在"。
 *
 * 只跑这一段：其余断言依赖全新环境（科目模板 9 科、无历史会话、桩请求计数），
 * 在同一个工作区上重跑必然红 —— 那是断言写错了对象，不是缺陷。
 */
async function runResumePhase(userData: string): Promise<void> {
  logger?.info('开始第二次启动的续跑验证（AURORA_SMOKE_PHASE=resume）')
  const results: Array<{ label: string; ok: boolean; detail: string }> = []
  const record = (label: string, ok: boolean, detail: string): void => {
    results.push({ label, ok, detail })
    logger?.[ok ? 'info' : 'error'](
      `${SMOKE_RESULT_PREFIX} ${ok ? 'PASS' : 'FAIL'} ${label} — ${detail}`,
    )
  }
  const host = agent
  const store = jobStore
  const sessionStore = sessions
  const sessionId = 'smoke-job-restart'
  // 第二次启动同样要有一个可用的模型：上一个进程的桩服务端口已经随进程消失，
  // 而配置里记的还是那个死端口 —— 不重新起一个桩并改指向，续跑只会回 `E_NO_MODEL`，
  // 表现为"点了继续但什么都没发生"（这正是本阶段第一版的现象）。
  let resumeStub: StubLlmServer | undefined
  try {
    resumeStub = await startStubLlmServer(logger?.child('smoke-llm'))
    if (settings !== undefined) {
      settings.update({
        llm: {
          ...settings.get().llm,
          active: 'smoke',
          providers: {
            ...settings.get().llm.providers,
            smoke: {
              type: 'openai-compat',
              baseUrl: resumeStub.baseUrl,
              apiKeyEnc: '',
              model: STUB_MODEL,
              modelList: [STUB_MODEL, `${STUB_MODEL}-alt`],
              // 生成参数按**模型 id** 键（v23）；三项写全，别留半截条目
              modelParams: {
                [STUB_MODEL]: { reasoningEffort: 'auto', contextWindow: 0, vision: false },
              },
            },
          },
        },
      })
      settings.setSecret('llm.providers.smoke.apiKey', STUB_API_KEY)
      await settings.flush()
    }
  } catch (error) {
    logger?.error('续跑验证准备失败：无法启动桩 LLM 服务', { error: String(error) })
  }
  // 读盘前的现场自检：把工作区与 jobs 目录的实际内容打进日志，
  // 「第二次启动读不到」时一眼能区分"文件没写"还是"工作区不对"。
  const jobsDir = join(userData, 'jobs')
  logger?.info('续跑验证的工作区', {
    userData,
    jobFiles: await fs.readdir(jobsDir).catch(() => [] as string[]),
  })
  let persistedOk = false
  let resumeOk = false
  let stepsGrew = false
  let oneUserMsg = false
  let cursorMonotonic = false
  let detail = ''
  try {
    if (host !== undefined && store !== undefined && sessionStore !== undefined) {
      // 读盘：这一步本身就在证明"上一个进程写的 job 还在"
      const paused = (await store.list({ sessionId })).find((item) => item.status === 'paused')
      persistedOk =
        paused !== undefined && paused.cursor.nextRound > 0 && paused.stepsDone.length > 0
      detail = `found=${paused === undefined ? 0 : 1} status=${paused?.status ?? '-'}`
      if (paused !== undefined) {
        const stepsBefore = paused.stepsDone.length
        const cursorBefore = paused.cursor.nextRound
        const usersBefore = (await sessionStore.get(sessionId)).filter(
          (item) => item.role === 'user',
        ).length
        const done = new Promise<void>((resolve) => {
          const off = host.onEvent((event) => {
            if (event.sessionId !== sessionId || event.type !== 'done') return
            off()
            resolve()
          })
          setTimeout(() => {
            off()
            resolve()
          }, 30_000)
        })
        await host.send({
          sessionId,
          text: paused.text,
          origin: 'chat',
          resumeJobId: paused.id,
        })
        await done
        await store.flush()
        const after = await store.get(paused.id)
        const usersAfter = (await sessionStore.get(sessionId)).filter(
          (item) => item.role === 'user',
        ).length
        resumeOk = after?.status === 'done'
        stepsGrew = (after?.stepsDone.length ?? 0) > stepsBefore
        cursorMonotonic = (after?.cursor.nextRound ?? 0) >= cursorBefore
        oneUserMsg = usersBefore === 1 && usersAfter === 1
        detail = `${detail} → status=${after?.status ?? '-'} steps=${stepsBefore}→${after?.stepsDone.length ?? -1} cursor=${cursorBefore}→${after?.cursor.nextRound ?? -1} users=${usersBefore}→${usersAfter}`
      }
    } else {
      detail = 'agent / jobStore / sessions 不可用'
    }
  } catch (error) {
    detail = `异常：${String(error)}`
  }
  record('重启①：上一次启动留下的 paused job 仍能读回（游标与已完成步骤都在）', persistedOk, detail)
  record(
    '重启②：chat:resumeJob 之后这条 job 跑到 done，且已完成步骤增加',
    resumeOk && stepsGrew,
    detail,
  )
  record(
    '重启③：游标单调不减，且会话文件里那条用户消息**仍然只有一条**',
    cursorMonotonic && oneUserMsg,
    detail,
  )

  const failed = results.filter((item) => !item.ok)
  logger?.info(
    `${SMOKE_RESULT_PREFIX} SUMMARY ${results.length - failed.length}/${results.length} passed`,
  )
  await resumeStub?.close().catch(() => undefined)
  await logger?.close()
  // 固定工作区**不删**：它是这两次启动的共同产物，留着便于人工复核 job 文件
  void userData
  app.exit(failed.length === 0 ? 0 : 2)
}

/**
 * 安全规则小节的标题（`## 安全规则`）——静态段的**末尾**。取自 `SAFETY_RULES` 的首行，
 * 不在自测里另写一份字面量：那个字符串就是被断言的产物本身，两处一旦漂移，
 * 「易变段在静态段之后」这条断言会变成对着一份过期口径的自我确认。
 */
const SAFETY_TITLE = SAFETY_RULES.split('\n')[0] ?? ''

/**
 * 系统状态小节标题（`## 系统状态`）：易变段的最后一个，断言它确实渲染了（证明易变段在）。
 *
 * ⚠️ 取**末位**而不是写死下标：`VOLATILE_SECTION_TITLES` 会随新易变小节增减
 * （v13 就插入了「## 项目约定」），写死 `[2]` 会在加小节时静默指向别人
 * ——`as const` 的字面量类型跟着变，编译器一句话都不会说。
 */
const PERCEPTION_SECTION_TITLE = VOLATILE_SECTION_TITLES.at(-1) ?? ''

/**
 * 两个字符串的**最长公共前缀长度**（逐字符比较）——缓存前缀断言的核心量。
 *
 * 刻意不复用 agent-core 测试里的同名私有实现：那是被测侧的测试工具，
 * 主进程侧再引一份就成了「自己证明自己」，独立实现才有互相印证的价值。
 */
function commonPrefixLength(left: string, right: string): number {
  const max = Math.min(left.length, right.length)
  let index = 0
  while (index < max && left[index] === right[index]) index += 1
  return index
}

/**
 * 文本里**第一个易变小节**的起始位置（`VOLATILE_SECTION_TITLES` 中位置最小的那个；
 * 一个小节都没渲染时返回 `-1`）。
 *
 * 它是「静态前缀该有多长」的期望值：静态段逐字节相同 ⇔ 公共前缀至少覆盖到该位置。
 */
function firstVolatileIndex(text: string): number {
  let found = -1
  for (const title of VOLATILE_SECTION_TITLES) {
    const at = text.indexOf(title)
    if (at < 0) continue
    if (found < 0 || at < found) found = at
  }
  return found
}

/** 一次请求里 `tools` 数组的工具名（名字非字符串的一律丢弃；请求缺失时为空数组） */
function toolNamesOf(record: StubChatRequestRecord | undefined): string[] {
  return (record?.tools ?? [])
    .map((tool) => tool.function?.name)
    .filter((name): name is string => typeof name === 'string')
}

/**
 * 自测前置（仅 `AURORA_SMOKE=1`，docs/04 §P4/§P5 验收）：
 * 1. 把感知文件夹指向自测临时目录（不碰开发者的真实目录）；
 * 2. 科目只留「数学 / 物理 / 语文」，使断言不受默认九科模板干扰；
 * 3. 课表来源切成 **ClassIsland 桥接**（file 模式），并写一份夹具 JSON，
 *    里面放一节 **3 分钟后开始** 的数学课 —— 落在课前 5 分钟窗口内，
 *    首轮 tick 就会命中，无需等待真实课前时间。
 *
 * 第 3 条把「桥接 JSON → provider 解析 → 感知摘要 → 课前提醒」整条链路
 * 串起来验证：只测解析器无法证明装配真的接通了。
 *
 * **刻意不预先放入待分类文件**：文件由渲染层脚本经 `app:smokeDropFile` 在
 * 订阅了分类事件之后写入，这样才真正验证了「新文件拖入 → 自动归类」的
 * 实时链路（chokidar add），而不是启动时的兜底扫描。
 */
async function seedSmokeClassroom(userData: string): Promise<string> {
  const watchDir = join(userData, '感知文件夹')
  await fs.mkdir(watchDir, { recursive: true })

  // 2. 一节 3 分钟后开始的课：落在课前 5 分钟窗口内，
  //    首轮 tick（默认 30s 间隔）就会命中，无需等待真实时刻
  //
  //
  //    跨零点：这一节课按**今天与明天各写一份**（weekday 两个值），因为两个消费方的「天」口径不同 ——
  //    `classisland:test` 只返回**今日**课程（`getTodayLessons()` 按 `now.getDay()` 过滤），
  //    而 `preClassTrigger` 同时看今天与明天（dayOffset [0, 1]）。只写一份时，
  //    「3 分钟后」在 23:57 之后属于次日：今日课程里没有它（断言假 FAIL），
  //    或反过来今天有它但提醒窗口落在明天（提醒断言假 FAIL）。两份覆盖两种口径，
  //    且任一时刻只有一份能被 `getTodayLessons` 选中（同一 clock 只有一个日期匹配）。
  const now = new Date()
  const startTime = new Date(now.getTime() + 3 * 60_000)
  const clock = `${pad2(startTime.getHours())}:${pad2(startTime.getMinutes())}`
  // 用 Date 推进 45 分钟：手算 `分钟 + 45` 在 [HH:15, HH:59] 会溢出成 "HH:60+"，
  // 被桥接解析器判为非法时间（endTime 需 HH:mm）而丢弃整节课，导致课前提醒断言假失败。
  const endTime = new Date(startTime.getTime() + 45 * 60_000)
  const endClock = `${pad2(endTime.getHours())}:${pad2(endTime.getMinutes())}`

  // 3. 桥接夹具：与真实插件写出的契约完全一致（docs/05 §3.4 v2/v3）。
  //    夹具里带上 status v3（含 v3 新增的三个时间字段），这样自测能断言
  //    「桥接快照 → provider 缓存 → 感知摘要（classStatus + 课堂状态行）」整条链路，
  //    而不只是课表数组。onClass / 当前科目与夹具的那节课一致（同一份数据两处输出）。
  const bridgePath = join(userData, 'classisland-bridge.json')
  await fs.writeFile(
    bridgePath,
    JSON.stringify(
      {
        version: 1,
        generatedAt: new Date().toISOString(),
        lessons: [
          {
            weekday: startTime.getDay(),
            startTime: clock,
            endTime: endClock,
            subject: '数学',
          },
          {
            // 明天那一份（跨零点的兜底，见上）：weekday 取次日
            weekday: (startTime.getDay() + 1) % 7,
            startTime: clock,
            endTime: endClock,
            subject: '数学',
          },
        ],
        status: {
          version: 3,
          generatedAt: new Date().toISOString(),
          onClass: true,
          currentSubject: '数学',
          currentStartTime: clock,
          currentEndTime: endClock,
          nextSubject: '语文',
          nextStartTime: endClock,
          nextEndTime: endClock,
        },
      },
      null,
      2,
    ),
    'utf8',
  )

  settings?.mutate((draft) => {
    draft.modes.current = 'classroom'
    draft.modes.classroom.watchDir = watchDir
    draft.modes.classroom.subjects = [
      { name: '数学', folder: '分类/数学', keywords: ['方程'] },
      { name: '物理', folder: '分类/物理', keywords: ['电路'] },
      { name: '语文', folder: '分类/语文', keywords: [] },
    ]
    draft.modes.classroom.preClassReminder = true
    draft.modes.classroom.schedule = {
      provider: 'classisland',
      // 手动课表留空：走 classisland 时它不参与解析，但 Schema 要求字段存在
      lessons: [],
      classisland: {
        source: 'file',
        endpoint: bridgePath,
        timeoutMs: 2000,
      },
    }
  })
  logger?.info('自测已配置 ClassRoom（课表来自 ClassIsland 桥接夹具）', {
    watchDir,
    lesson: clock,
    bridgePath,
  })
  return watchDir
}

function pad2(value: number): string {
  return `${value}`.padStart(2, '0')
}

/**
 * 应用系统代理（docs/08 §6 `advanced.proxy`）。
 *
 * 同时做两件事：把代理交给 Chromium 会话（`session.setProxy`），并按新配置重建
 * 出网 fetch —— LLM / MCP HTTP / 连接测试都读这个引用，因此改完即刻生效。
 * 任何失败只记日志：代理配错不应该让应用起不来。
 */
async function applyAdvancedNetwork(proxy: string): Promise<void> {
  try {
    netFetch = createNetFetch()
    await applyProxy(proxy)
    logger?.info('系统代理已应用', { proxy: proxy.trim() === '' ? '（直连）' : proxy.trim() })
  } catch (error) {
    logger?.warn('应用系统代理失败，保持原设置', { error: String(error) })
  }
}

/** ClassIsland 联动是否启用（选了 classisland 且填了端点）。 */
function isClassIslandActive(): boolean {
  const schedule = settings?.get().modes.classroom.schedule
  if (schedule === undefined || schedule.provider !== 'classisland') return false
  return schedule.classisland.endpoint.trim() !== ''
}

/**
 * ClassIsland provider 单例（按配置签名缓存）。
 *
 * provider 内部持有「上次读取的原文」，缓存它才能让「内容未变则跳过重复解析」生效；
 * 端点变化时重建，避免继续读旧地址。
 */
function classIslandProviderFor(): ClassIslandProvider | undefined {
  const schedule = settings?.get().modes.classroom.schedule
  if (schedule === undefined) return undefined
  const config = schedule.classisland
  if (config.endpoint.trim() === '') {
    classIslandProvider = undefined
    return undefined
  }
  const signature = `${config.source}|${config.endpoint}|${config.timeoutMs}`
  if (classIslandProvider !== undefined && classIslandSignature === signature) {
    return classIslandProvider
  }
  classIslandProvider = new ClassIslandProvider({
    ...config,
    // 桥接插件默认输出位置（v0.2.4，docs/05 §3.4）：端点读不到时回落试一次，
    // 让「Aurora 端点与插件 outputPath 对不上」从静默空课表变成带告警的诊断信息
    fallbackFilePath: join(app.getPath('appData'), 'ClassIsland', 'aurora-bridge', 'schedule.json'),
    logger: logger?.child('classisland'),
  })
  classIslandSignature = signature
  return classIslandProvider
}

/**
 * ClassIsland 提醒通道单例（v3，docs/05 §3.4）。
 *
 * 与 provider **分开实例**：提醒通道不依赖课表读取（端点填了就能用），
 * 且「最近一次结果」要跨设置页反复开合长期保留，因此不随 provider 的配置签名重建。
 * 配置每次调用即时读取（`getConfig`），端点 / 来源改完无需重启。
 * 出网走 `netFetch`（`advanced.proxy` 对它生效）。
 */
function classIslandNotifierFor(): ClassIslandNotifier {
  classIslandNotifier ??= new ClassIslandNotifier({
    getConfig: () =>
      settings?.get().modes.classroom.schedule.classisland ?? {
        source: 'file' as const,
        endpoint: '',
        timeoutMs: 3000,
      },
    fetchImpl: () => netFetch ?? globalThis.fetch,
    logger: logger?.child('classisland-notify'),
  })
  return classIslandNotifier
}

async function classIslandStatus(): Promise<ClassIslandStatus> {
  const schedule = settings?.get().modes.classroom.schedule
  const config = schedule?.classisland ?? { source: 'file' as const, endpoint: '', timeoutMs: 3000 }
  const enabled = isClassIslandActive()
  const provider = enabled ? classIslandProviderFor() : undefined
  // 缓存过期就重读一次：右栏课堂状态卡是 30 秒轮询这个接口的，
  // 不主动刷新的话，刚切到 ClassIsland 时卡片会空着等下一次感知摘要（见 provider.refreshIfStale）
  await provider?.refreshIfStale()
  const status = provider?.getStatus()
  const notifier = classIslandNotifierFor()
  // 端点变化时刷新「通道是否可用」的回显（未配置端点 = 不可用）
  notifier.refreshAvailability()
  return {
    enabled,
    source: config.source,
    endpoint: config.endpoint,
    ok: status?.ok ?? false,
    lastSyncAt: status?.lastSyncAt ?? null,
    lessonCount: status?.lessonCount ?? 0,
    warnings: status?.warnings ?? [],
    ...(status?.error === undefined ? {} : { error: status.error }),
    // 桥接 v2 起内嵌的当前课状态快照（payload.status，docs/05 §3.4）：
    // `ClassIslandStatus.status` 已是 shared 的具名字段（v3 契约），不再是运行时透传。
    ...(status?.status === undefined ? {} : { status: status.status }),
    // 提醒通道状态（v3）：可用性与最近一次结果，设置页就地回显
    notify: notifier.getState(),
  }
}

/** 设置页「测试连接」：立即按当前配置解析一次（临时实例，不影响缓存中的 provider）。 */
async function testClassIsland(): Promise<ClassIslandTestResult> {
  const schedule = settings?.get().modes.classroom.schedule
  const config = schedule?.classisland ?? { source: 'file' as const, endpoint: '', timeoutMs: 3000 }
  const provider = new ClassIslandProvider({ ...config, logger: logger?.child('classisland') })
  const result = await provider.test(new Date())
  return {
    ok: result.ok,
    source: config.source,
    endpoint: config.endpoint,
    lessons: result.lessons,
    warnings: result.warnings,
    ...(result.error === undefined ? {} : { error: result.error }),
    // 桥接快照（v2/v3）：测试连接时一并回传，设置页可以顺手显示「当前 / 下节课」
    ...(result.status === undefined ? {} : { status: result.status }),
    elapsedMs: result.elapsedMs,
  }
}

/**
 * 当前课程表 provider（`manual` / `classisland`，docs/05 §3.4）。
 * 感知摘要与课前提醒共用此函数，保证两处看到同一份课表。
 */
function currentScheduleProvider(): IScheduleProvider {
  const classroom = settings!.get().modes.classroom
  return resolveScheduleProvider(classroom, { classisland: classIslandProviderFor() })
}

/**
 * 长上下文摘要器（docs/06 §4）。
 *
 * 复用当前 provider：摘要是一次普通的非流式对话请求，因此天然继承
 * 用户配置的模型 / 代理 / 重试策略。失败向上抛，由 `compressHistory`
 * 退回纯截断 —— 摘要失败绝不能拖垮用户这次提问。
 */
function createSummarizer(
  store: SettingsStoreLike,
  log: Logger,
): (input: {
  dropped: Array<{ role: string; content: string }>
  previousSummary?: string
}) => Promise<string> {
  return async (input) => {
    const config = createProviderFactory(store, log, () => netFetch).create()
    if (config === undefined) throw new Error('尚无可用模型配置，跳过摘要')
    const transcript = input.dropped
      .map((message) => `${message.role === 'user' ? '用户' : '助手'}：${message.content}`)
      .join('\n')
    const prompt = [
      input.previousSummary === undefined
        ? '请把下面这段对话压缩成要点摘要。'
        : '这是对话的累计摘要与新增片段，请合并更新为一份要点摘要。',
      '要求：保留用户的目标、已确认的结论、未完成事项与关键事实；',
      '去掉寒暄与重复；用中文；不超过 300 字；只输出摘要正文。',
      input.previousSummary === undefined ? '' : `\n【已有摘要】\n${input.previousSummary}`,
      `\n【新增对话】\n${transcript}`,
    ]
      .filter((part) => part !== '')
      .join('\n')

    let text = ''
    for await (const event of config.provider.chat({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
    })) {
      if (event.type === 'text') text += event.delta
      if (event.type === 'error') throw new Error(event.message)
    }
    return text
  }
}

/**
 * 退出收尾（P1-12：调用方是 `before-quit` 的「先挡后退」协议）。
 *
 * ⚠️ 这里**不再**调用 `windows.prepareQuit()`（旧实现在首个 `await automationStore.flush()`
 * **之后**才调，于是置位 `quitting` 被推到了异步之后 —— 各窗口 close 早已到达并取消了整次退出，
 * 见 `before-quit` 的注释）。置位已提前到 `before-quit` 的同步段，本函数只负责**收尾落盘**：
 * 段落顺序（先停在途、再逐层 flush、最后关日志）保持不变。
 *
 * 调用方必须 `.finally(() => app.quit())`：本函数**不是**退出动作，只是退出前的收尾。
 */
async function shutdown(): Promise<void> {
  logger?.info('Aurora 退出中')
  disposeIpc?.()
  // PTY shell 先收掉：孤儿 conpty 进程会一直挂着，比任何落盘失败都难看
  terminalService?.dispose()
  centerConnector?.dispose()
  sessionBridge?.dispose()
  agentActivityDetach?.()
  agentActivityDetach = undefined
  activeAgentRequests.clear()
  perception?.stop()
  agent?.dispose()
  updater?.dispose()
  // 全局快捷键必须在退出前注销，否则会残留到进程消亡（Electron 只在正常退出时自动清）
  hotkeys?.dispose()
  edgeBarScheduler?.stop()
  if (awarenessGlowHideTimer !== undefined) {
    clearTimeout(awarenessGlowHideTimer)
    awarenessGlowHideTimer = undefined
  }
  windows?.hideAwarenessGlow()
  gameMode?.stop()
  // 主动引导：让在途的敏感工具确认立即失败，不留下悬挂的 Promise
  proactiveScheduler?.dispose()
  // 自动化引擎：停评估、清在途 Agent 运行监听，并落盘定义与历史
  automationEngine?.stop()
  await automationStore?.flush().catch((error: unknown) => {
    logger?.warn('退出前落盘自动化数据失败', { error: String(error) })
  })
  // 分类管线：先停监听（不再进新文件），再排在途任务，最后落盘流水
  await fileWatcher?.stop().catch(() => undefined)
  await classification?.drain().catch(() => undefined)
  await classification?.close().catch(() => undefined)
  fileAwarenessAnalyzer?.dispose()
  await fileAwareness?.close().catch((error: unknown) => {
    logger?.warn('退出前关闭文件自感知失败', { error: String(error) })
  })
  extractPool?.close()
  awarenessExtractPool?.close()
  officePool?.close()
  // 会话与任务清单必须在退出前收尾（docs/06 §4 / §18，同一套防抖 + flush 约定）
  skillsService?.stopWatching()
  await sessions?.flush().catch((error: unknown) => {
    logger?.warn('退出前落盘会话失败', { error: String(error) })
  })
  await todoPort?.flush().catch((error: unknown) => {
    logger?.warn('退出前落盘任务清单失败', { error: String(error) })
  })
  await snapshotPort?.flush().catch((error: unknown) => {
    logger?.warn('退出前落盘快照索引失败', { error: String(error) })
  })
  await jobStore?.flush().catch((error: unknown) => {
    logger?.warn('退出前落盘任务失败', { error: String(error) })
  })
  await mcp?.close().catch((error: unknown) => {
    logger?.warn('退出前关闭 MCP 连接失败', { error: String(error) })
  })
  try {
    await settings?.flush()
  } catch (error) {
    logger?.warn('退出前落盘配置失败', { error: String(error) })
  }
  tray?.destroy()
  await logger?.close()
}

/**
 * 同步「开机自启」到系统（Windows 注册表 Run 项，由 Electron 维护）。
 * 幂等：仅在当前状态与期望不一致时写入，避免每次启动都改注册表。
 */
/** 流光渲染层退场动画约 620ms；原生窗口多留一帧再隐藏，避免裁掉尾段。 */
const AWARENESS_GLOW_FADE_OUT_MS = 680

function awarenessGlowShouldShow(): boolean {
  if (settings === undefined || windows === undefined || fileAwareness === undefined) return false
  const current = settings.get()
  const status = fileAwareness.status()
  return shouldShowAwarenessGlow({
    edgeBarEnabled: current.general.edgeBar.enabled,
    edgeBarVisible: windows.isVisible('edge-bar'),
    needsOnboarding: settings.needsOnboarding(),
    edgeBarQuiet: isQuietHour(new Date(), current.general.edgeBar.quietHours),
    systemQuiet: isQuietHour(new Date(), current.advanced.quietHours),
    awarenessEnabled: status.enabled,
    consentAccepted: status.consentAccepted,
    knowledgeDirAvailable: status.knowledgeDirAvailable,
    // v33：流光特效总开关。缺字段按开启兜底（`!== false`）—— 与 Schema 的 `.default(true)`
    // 同一口径，不允许出现「Schema 说开、这里按关」的第二套默认值。
    awarenessGlow: current.appearance.awarenessGlow !== false,
    ...(status.analysisProgress === undefined ? {} : { stage: status.analysisProgress.stage }),
  })
}

/**
 * 四周流光的唯一显隐入口。
 *
 * 主进程只负责创建 / 显示 / 收起透明浮层；动画本身在渲染层用合成分层完成。分析结束后
 * 等一帧级的淡出窗口再隐藏，若同一时间重新开始分析则直接取消隐藏。
 */
function syncAwarenessGlow(): void {
  if (windows === undefined) return
  if (awarenessGlowHideTimer !== undefined) {
    clearTimeout(awarenessGlowHideTimer)
    awarenessGlowHideTimer = undefined
  }
  if (awarenessGlowShouldShow()) {
    windows.showAwarenessGlow()
    return
  }
  if (!windows.isAwarenessGlowVisible()) return
  awarenessGlowHideTimer = setTimeout(() => {
    awarenessGlowHideTimer = undefined
    if (!awarenessGlowShouldShow()) windows?.hideAwarenessGlow()
  }, AWARENESS_GLOW_FADE_OUT_MS)
  awarenessGlowHideTimer.unref?.()
}

/**
 * 界面明暗档位的唯一落地入口（v32，docs/07 §5.1）。
 *
 * `appearance.theme` → `nativeTheme.themeSource`；渲染层不经过这里，它照旧只读
 * `prefers-color-scheme`（`nativeTheme` 变更会同步过去），因此「改完即时生效」不需要重建窗口。
 *
 * 三条口径：
 * - **截图运行独占**：`AURORA_CAPTURE_THEME` 有值时整个跳过（两档主题基线不被用户设置顶掉）；
 * - 值没变就不赋值：避免无谓的 `updated` 广播与四窗底色同步；
 * - 配置还没加载（`settings === undefined`）时直接返回 —— 启动时序上它先于窗口创建。
 */
function syncThemeSource(): void {
  const current = settings?.get()
  if (current === undefined || captureThemeOverride !== undefined) return
  const theme = current.appearance.theme
  if (nativeTheme.themeSource === theme) return
  nativeTheme.themeSource = theme
  logger?.info('界面明暗档位已切换', { theme })
}

function syncLaunchAtLogin(enabled: boolean): void {
  try {
    const current = app.getLoginItemSettings()
    if (current.openAtLogin === enabled) return
    app.setLoginItemSettings({ openAtLogin: enabled })
    logger?.info('已更新开机自启设置', { openAtLogin: enabled })
  } catch (error) {
    logger?.warn('设置开机自启失败（不影响主流程）', { error: String(error) })
  }
}

/**
 * `ProactiveScheduler` → IPC 依赖面（`ProactiveLike`）的适配。
 *
 * 只做命名对齐（`onSensitiveTool` ↔ `onRequest`）：调度器是纯 `agent-core` 风格的
 * 业务实现，IPC 契约用的是名字更中性的 `onRequest`，两者不必强绑。
 */
function adaptProactive(scheduler: ProactiveScheduler): ProactiveLike {
  return {
    requestSensitiveToolConfirm: (input) => scheduler.requestSensitiveToolConfirm(input),
    resolve: (confirmId, approved, always) => scheduler.resolve(confirmId, approved, always),
    rejectAll: (reason) => scheduler.rejectAll(reason),
    onRequest: (listener) => scheduler.onRequest(listener),
  }
}

/**
 * 让分类管线与当前配置对齐（docs/05 §3.1）：
 * 仅在 ClassRoom 激活且已配置感知文件夹时监听；否则停掉，避免无谓的 I/O。
 * 感知文件夹变化时重建监听（`watch()` 本身幂等）。
 */
/**
 * 工具注册表的**唯一**同步入口（docs/06 §11、§12、§14、§18/§19）。 *
 * 四个装配器必须一起同步：
 * - `computerTools`：按 `agent.tools.*` 重建全部电脑操控工具；
 * - `settingsTool`：重建 `set_setting`（不受 `agent.tools.enabled` 影响，见 tools/index.ts）；
 * - `extensionTools`：重建扩展工具七件套（同样不受 `agent.tools.enabled` 影响）；
 * - `agentCoreTools`：重建 todo_write / todo_read / task（同样不受门控，见 tools/index.ts）。
 *
 * 拆开写会让「改开关后工具表变化」的时机不一致：后三者不依赖 `agent.tools.enabled`，
 * 但都与电脑操控工具共用同一张注册表，必须在同一拍完成重建。
 */
/** Aurora Center 连接状态（center:status IPC 的展示口径，docs/12） */
function centerStatus(): CenterConnectionStatus {
  const info = centerConnector?.status()
  const conn = centerConnector?.connectionState()
  return {
    enabled: info?.enabled ?? false,
    connected: info?.connected ?? false,
    serverUrl: info?.serverUrl ?? '',
    displayName: info?.displayName ?? '',
    state: conn?.state ?? 'disabled',
    ...(conn?.lastError === undefined ? {} : { lastError: conn.lastError }),
  }
}

/**
 * 取（必要时生成并持久化）本机 clientId。
 *
 * 旧版只有设置页展示、没有任何生成逻辑，连接器因 clientId 为空永远停在
 * 「尚未配置」——那正是「配对两端没反应」的根因。账号登录与设备授权登录
 * 共用这一份，避免两处漂移。
 */
function ensureCenterClientId(): Result<string> {
  if (settings === undefined) return err('E_INVALID_STATE', '配置存储尚未就绪')
  const existing = settings.get().center.clientId.trim()
  if (existing !== '') return ok(existing)
  const clientId = `aurora-${randomUUID()}`
  const saved = settings.mutate((draft) => {
    draft.center.clientId = clientId
  })
  if (saved === undefined) return err('E_IO', '无法保存客户端 ID，请重试')
  return ok(clientId)
}

/**
 * 登录成功的**公共落库**（账号登录与设备授权登录共用，docs/12 §3/§4.3）：
 * 令牌先进凭据链路（safeStorage 不可用时留在内存 = 本次运行有效），再落普通配置；
 * enabled / serverUrl / account 变化经 settings:changed 驱动连接器自动重连。
 */
async function persistCenterLogin(
  token: string,
  account: string,
  serverUrl: string,
): Promise<Result<CenterLoginResult>> {
  if (settings === undefined) {
    return err('E_INVALID_STATE', '配置存储尚未就绪')
  }
  const persisted = settings.setSecret('center.token', token)
  const mutated = settings.mutate((draft) => {
    draft.center.enabled = true
    draft.center.serverUrl = serverUrl
    draft.center.account = account
  })
  if (mutated === undefined) {
    return err('E_IO', '登录成功但配置保存失败，请重试')
  }
  void centerModelServices?.refresh()
  return ok({ account, tokenPersisted: persisted })
}

/**
 * Aurora Center 账号登录（center:login IPC，docs/12 §3/§7，v0.2.1）：
 * 密码换客户端令牌（凭据链路落库）+ 记住账号名 + 自动启用连接。
 * 密码只在本次请求里使用，不落配置、不进日志；`center:login` 不对 AI 的
 * `set_setting` 通道开放（`center.*` 整组只读前缀不变）。
 */
async function centerLogin(request: CenterLoginRequest): Promise<Result<CenterLoginResult>> {
  const serverUrl = request.serverUrl.trim()
  const username = request.username.trim()
  const password = request.password
  if (serverUrl === '' || username === '' || password === '') {
    return err('E_INVALID_ARGUMENT', '请填写服务器地址、账号与密码')
  }
  if (settings === undefined) {
    return err('E_INVALID_STATE', '配置存储尚未就绪')
  }
  const clientIdResult = ensureCenterClientId()
  if (!clientIdResult.ok) return clientIdResult
  const outcome = await requestClientLogin(
    { serverUrl, username, password, clientId: clientIdResult.value },
    { fetchImpl: netFetch ?? fetch, logger: logger?.child('center') },
  )
  if (!outcome.ok) return err('E_AUTH', outcome.message)
  return persistCenterLogin(outcome.token, outcome.account, serverUrl)
}

/**
 * 广播设备授权登录的最终结果给渲染层（center:deviceLoginResult 推送）。
 * 监听器异常互不影响（设置页未打开时集合为空，结果只进日志）。
 */
function emitDeviceLoginResult(result: CenterDeviceLoginResult): void {
  for (const listener of deviceLoginListeners) {
    try {
      listener(result)
    } catch (error) {
      logger?.warn('设备授权登录结果监听器抛错', { error: String(error) })
    }
  }
}

/** 设备授权最终结果 → 落库 + 推送（approved 才落库；expired / denied / error 只推送） */
async function handleDeviceLoginOutcome(outcome: DeviceLoginOutcome): Promise<void> {
  if (outcome.status === 'approved') {
    const result = await persistCenterLogin(outcome.token, outcome.username, deviceLoginServerUrl)
    if (result.ok) {
      emitDeviceLoginResult({ status: 'approved' })
    } else {
      emitDeviceLoginResult({ status: 'error', message: result.message })
    }
    return
  }
  emitDeviceLoginResult(
    outcome.status === 'error'
      ? { status: 'error', message: outcome.message }
      : { status: outcome.status },
  )
}

/**
 * Aurora Center 设备授权登录（center:deviceLogin IPC，docs/12 §4.3）：
 * 打开确认页 + 后台轮询，**立即**回执；最终结果经 deviceLoginResult 推送。
 * 令牌拿到后的落库走 `persistCenterLogin`（与账号登录同一份），连接器自动重连。
 */
async function startCenterDeviceLogin(
  request: CenterDeviceLoginRequest,
): Promise<Result<CenterDeviceLoginStarted>> {
  const serverUrl = request.serverUrl.trim()
  if (serverUrl === '') {
    return err('E_INVALID_ARGUMENT', '请先填写服务器地址')
  }
  if (settings === undefined) {
    return err('E_INVALID_STATE', '配置存储尚未就绪')
  }
  const clientIdResult = ensureCenterClientId()
  if (!clientIdResult.ok) return clientIdResult
  // 懒创建：控制器持有 netFetch / shell.openExternal 等注入，整个生命周期复用
  //（start() 内部会先取消上一次的轮询，重复点击天然安全）。
  if (deviceLoginController === undefined) {
    deviceLoginController = new DeviceLoginController({
      fetchImpl: netFetch ?? fetch,
      logger: logger?.child('center'),
      openExternal: (url) => shell.openExternal(url),
      onResult: (outcome) => void handleDeviceLoginOutcome(outcome),
    })
  }
  deviceLoginServerUrl = serverUrl
  const started = await deviceLoginController.start({ serverUrl, clientId: clientIdResult.value })
  if (!started.started) return err('E_NETWORK', started.message)
  logger?.info('设备授权登录已发起', { serverUrl })
  return ok({ started: true, verifyUrl: started.verifyUrl })
}

function syncToolRegistries(): void {
  computerTools?.sync()
  settingsTool?.sync()
  extensionTools?.sync()
  // 图像工具（docs/06 §25）：换模型 / 改「支持图片输入」开关后即时注册或摘除
  imageTools?.sync()
  agentCoreTools?.sync()
  // ClassIsland 提醒工具（v3）：端点填了 / 改了就即时注册或摘除（无需重启）
  classIslandTools?.sync()
  // Aurora Center 工具（docs/12 §8）：enabled / serverUrl 变了就即时注册或摘除
  centerTools?.sync()
  // 自动化管理工具（docs/13 §8）：只读档切档即时生效
  automationTools?.sync()
  // 文件自感知工具（docs/06 §26）：启用 / 授权 / 知识库可用性变化即时生效
  awarenessTools?.sync()
}

function syncClassification(): void {
  const service = classification
  const watcher = fileWatcher
  if (service === undefined || watcher === undefined || settings === undefined) return

  const current = settings.get()
  const classroom = current.modes.classroom
  const shouldWatch = current.modes.current === 'classroom' && classroom.watchDir !== ''

  // 课前提醒（内置自动化）由常驻的自动化引擎承接（docs/13 §6）：引擎每次 tick 现读
  // 「当前模式 + preClassReminder / preClassOpenFolder」，不再在这里做启停同步。

  if (!shouldWatch) {
    void watcher.stop()
    service.reconfigure()
    return
  }
  if (watcher.watchDir === classroom.watchDir) {
    service.reconfigure()
    return
  }
  void watcher
    .watch(classroom.watchDir)
    .then(() => service.reconfigure())
    .catch((error: unknown) => {
      logger?.warn('启动文件监听失败（分类功能不可用，不影响其它功能）', {
        error: String(error),
      })
    })
}

/**
 * 走**真实工具**写一条配置（自测用）。
 *
 * 刻意调 `set_setting.execute` 而不是 `settingsPort.write`：这样 crash 矩阵覆盖的
 * 是模型真正会走到的那条链路（内核工具的参数解析 / 可写性前置校验 / 异常收敛），
 * 而不是只测端口。确认卡片不在自测里弹（`execute` 由内核在循环中调用 `confirmTool` 之前
 * 就已经过参数校验），因此不会白等 60s。
 */
async function writeSettingThroughTool(
  tool: ToolDefinition,
  path: string,
  value: unknown,
): Promise<{ rejected: boolean; note: string }> {
  try {
    const result = await tool.execute(
      { action: 'set', values: [{ path, value }] },
      { sessionId: 'smoke' },
    )
    return {
      rejected: result.isError === true,
      note: result.content.slice(0, 120).replace(/\s+/g, ' '),
    }
  } catch (error) {
    // 工具把内建异常收敛成 isError；真抛出来说明**异常冒泡进了工具循环**，
    // 正是本步要防的「AI 改设置导致整轮对话中断」，如实记成失败。
    return { rejected: false, note: `异常冒泡：${String(error)}` }
  }
}

/** 模式层（`ModeWindowPort`）发起的通知（docs/05 §3.3）。 */
function notify(title: string, body: string, openPath?: string): void {
  if (notifications === undefined) {
    logger?.info('通知（通知服务尚未就绪）', { title, body, openPath })
    return
  }
  notifications.notify({ title, body, ...(openPath === undefined ? {} : { openPath }) })
}

/** 系统通知载体（docs/05 §3.3）。展示失败返回 false，由 NotificationService 记日志降级。 */
function createNotificationPresenter(): (request: {
  title: string
  body: string
  openPath?: string
}) => boolean {
  return (request) => {
    if (!Notification.isSupported()) return false
    try {
      const notification = new Notification({ title: request.title, body: request.body })
      notification.on('click', () => {
        void notifications?.handleClick(request.openPath)
      })
      notification.show()
      return true
    } catch (error) {
      logger?.warn('系统通知不可用，已降级为日志', { error: String(error) })
      return false
    }
  }
}

/**
 * 把 Agent 的 provider 工厂适配成分类管线需要的形状（docs/05 §3.2 ②）。
 * `OpenAiCompatProvider.chat()` 已满足 `ClassifyProvider`，这里只做结构收窄。
 */
function createClassifyFactory(
  factory: ReturnType<typeof createProviderFactory>,
): ClassifyProviderFactory {
  return {
    create: () => {
      const config = factory.create()
      if (config === undefined) return undefined
      return { provider: config.provider, model: config.model }
    },
  }
}

/** `AURORA_UPDATE_AUTODELAY_MS`：仅用于自测/发布验证，缩短启动后的自动检查延迟 */
function readAutoCheckDelay(): number | undefined {
  const raw = (process.env['AURORA_UPDATE_AUTODELAY_MS'] ?? '').trim()
  if (raw === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

function resolveTrayIcon(): string {
  const candidates = [
    join(process.resourcesPath ?? '', 'tray.png'),
    join(__dirname, '../../resources/tray.png'),
    join(app.getAppPath(), 'resources/tray.png'),
  ]
  for (const candidate of candidates) {
    if (candidate !== '' && existsSync(candidate)) return candidate
  }
  logger?.warn('未找到托盘图标，使用内置兜底图标')
  return ''
}

/**
 * 窗口 / 任务栏图标。用 256px 那张而不是 `tray.png`（16px 在任务栏上糊）。
 * 候选顺序与 `resolveTrayIcon` 一致：打包后先看 `resources/`（extraResources 带过来的），
 * 再看 dev 下的仓库资源目录。找不到就返回 undefined，交给 Electron 回落到 exe 图标。
 */
function resolveWindowIcon(): string | undefined {
  const candidates = [
    join(process.resourcesPath ?? '', 'icon-256.png'),
    join(__dirname, '../../resources/icon-256.png'),
    join(app.getAppPath(), 'resources/icon-256.png'),
  ]
  for (const candidate of candidates) {
    if (candidate !== '' && existsSync(candidate)) return candidate
  }
  logger?.warn('未找到窗口图标，任务栏沿用可执行文件图标')
  return undefined
}

function resolveBuiltinSkillsDir(): string {
  const candidates = [
    join(process.resourcesPath ?? '', 'skills'),
    join(__dirname, '../../skills'),
    join(app.getAppPath(), '..', '..', 'skills'),
    join(process.cwd(), 'skills'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return join(process.cwd(), 'skills')
}
