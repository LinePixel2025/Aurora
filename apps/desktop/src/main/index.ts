/**
 * Aurora 主进程入口（docs/02 §1、§7）。
 *
 * 启动顺序：
 *  单实例锁 → 日志 → 配置（加密/迁移）→ 感知 → 窗口 → 模式装配 → IPC → 托盘
 *  → 首次引导判断（无可用模型配置则进入引导向导，否则显示服务窗与提示条）。
 */
import { existsSync, mkdirSync, promises as fs, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  createFileJobStore,
  createFileSnapshotPort,
  createProjectInstructionsSource,
  nodeProjectFs,
  type JobStore,
  type SnapshotPort,
  renderTodoList,
  resolveProject,
} from '@aurora/agent-core'
import type { AgentProviderFactory, SettingsToolPort, ToolDefinition } from '@aurora/agent-core'
import {
  COMPUTER_TOOL_NAMES,
  SettingsSchema,
  SettingsStore,
  nodeFileSystem,
  // 三档权限的生效档位（docs/06 §11.2）：确认判定与工具注册必须读同一个来源
  resolvePermissionMode,
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
import { TtsSynthesizer } from './tts.js'
import { createSttService } from './stt.js'
import { createImageGenService } from './imagegen.js'
import { SETTINGS_HINT } from './settings-hint.js'
import { registerIpc, createSettingsWriter, restoreSnapshot, type DesktopDeps } from './ipc.js'
import type { ProactiveLike, SettingsStoreLike } from './contracts.js'
import { ProactiveScheduler } from './proactive.js'
import { PreClassReminder } from './pre-class-reminder.js'
import { EdgeBarScheduler } from './edge-bar-scheduler.js'
import { HotkeyManager } from './hotkey.js'
import { SkillsService } from './skills.js'
import { ClassIslandNotifier, ClassIslandProvider } from './classisland.js'
import { applyProxy, createNetFetch } from './net.js'
import { resolveScheduleProvider, type IScheduleProvider } from './schedule.js'
import { resolveSubjectFolder } from './paths.js'
import { AuroraFileWatcher } from './file-watcher.js'
import { ExtractPool, type ExtractWorkerChild } from './extract-pool.js'
import { ClassificationHistory } from './classification-history.js'
import { ClassificationService, type ClassifyProviderFactory } from './classification.js'
import { NotificationService } from './notifications.js'
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
  captureWindows,
  chatStreamAct,
  chatStreamBurstAct,
  chatStreamBurstCheck,
  chatStreamCheck,
  defaultCapturePlan,
  filterCapturePlan,
  seedChatTtsHistory,
  seedJobFixture,
  seedClassIslandFixture,
  type CaptureTarget,
} from './capture.js'
import {
  registerAgentCoreTools,
  registerClassIslandTools,
  registerComputerTools,
  registerExtensionTools,
  registerSettingsTool,
  type AgentCoreToolsRegistry,
  type ClassIslandToolsRegistry,
  type ComputerTools,
  type ExtensionToolsRegistry,
  type SettingsToolRegistry,
} from './tools/index.js'
import { createFileTodoPort, type FileTodoPort } from './tools/todo-port.js'
import { createNetWebFetchPort } from './tools/web-fetch.js'
import { createElectronClipboardPort } from './tools/clipboard.js'
import { createNotificationPort } from './tools/notify.js'
import { createImageGenPort } from './tools/imagegen-port.js'
import { createSettingsPort } from './tools/settings-port.js'
import { createCommandRunner } from './tools/command-runner.js'
import { createNodeFilePort } from './tools/file-port.js'
import { createShellOpenPort } from './tools/open-port.js'

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
let notifications: NotificationService | undefined
let proactiveScheduler: ProactiveScheduler | undefined
let preClassReminder: PreClassReminder | undefined
let edgeBarScheduler: EdgeBarScheduler | undefined
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
/** 工具表与电脑操控装配器提到模块级：`runSmokeTest` 要在真实进程里断言它们（docs/06 §11） */
let tools: ToolRegistry | undefined
/**
 * 三档权限的确认判定（v13，docs/06 §11.2）：同样提到模块级 ——
 * `runSmokeTest` 要拿**注入内核的那个实例**断言「auto 档根内免确认 / 根外仍弹卡」，
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
let computerTools: ComputerTools | undefined
/** `set_setting` 装配器（docs/06 §12）：与电脑操控工具分开注册，互不摘除 */
let settingsTool: SettingsToolRegistry | undefined
/** `classisland_remind` 装配器（docs/05 §3.4 v3）：按桥接可用性注册 / 摘除 */
let classIslandTools: ClassIslandToolsRegistry | undefined
/** 扩展工具五件套装配器（docs/06 §14）：与 set_setting 同级，不受 agent.tools.enabled 门控 */
let extensionTools: ExtensionToolsRegistry | undefined
/** Agent 内核自带工具装配器（todo / task，docs/06 §18/§19）：同样不受门控 */
let agentCoreTools: AgentCoreToolsRegistry | undefined
/** 任务清单端口（docs/06 §18）：`<userData>/todos/<sessionId>.json`，退出前 flush */
let todoPort: FileTodoPort | undefined
/** MCP 状态订阅（IPC 层与主进程内部共用，避免为状态再引入一次事件总线） */
const mcpStatusListeners = new Set<(statuses: McpServerStatus[]) => void>()

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

  app.on('before-quit', () => {
    void shutdown()
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
  nativeTheme.themeSource =
    captureTheme === 'dark' || captureTheme === 'light' ? captureTheme : 'system'

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
  //     两态各一条指令，缺任何一条都会让对应环境静音。
  const csp = isDev
    ? [
        "default-src 'self' data: blob: http://localhost:5173 ws://localhost:5173",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:5173",
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self' http://localhost:5173 ws://localhost:5173",
        "img-src 'self' data:",
        "media-src 'self' blob: data:",
      ].join('; ')
    : [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "media-src 'self' blob:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; ')

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
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

  // 7.1 电脑操控工具（docs/06 §11）：按 `agent.tools.*` 注册 8 个工具。
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
  })
  // 项目根边界（v13，docs/06 §11.1）：**只在配置了当前项目时启用** ——
  // `workspaceRoot()` 返回 undefined 时 file-port / command-runner 的行为与 v13 之前一字不差
  //（无项目 = 无边界），这也是 step 1「无项目时行为不变」那条完成标准的落点。
  // ⚠️ 声明顺序承重：`projectLogger` 必须在 `projectRoot` **之前**声明 —— 缺省工作目录接线后
  //（step 3，`registerComputerTools` 的 `sync()` 在下面的启动序里就会调用本 getter），
  // 若把它留在 764 行之后，这里就是 TDZ `Cannot access 'projectLogger' before initialization`，
  // 表现为**启动直接失败**（单测全用假装配器发现不了，只有 AURORA_SMOKE 抓得到）。
  const projectLogger = logger?.child('project')
  const projectRoot = (): string | undefined =>
    resolveProject(settings!.get(), {
      cwd: process.cwd(),
      ...(projectLogger === undefined ? {} : { logger: projectLogger }),
    }).root
  computerTools = registerComputerTools({
    tools,
    getSettings: () => settings!.get(),
    logger: logger.child('tools'),
    homeDir: () => app.getPath('home'),
    // 缺省工作目录 / 搜索根的三级回落最高优先级输入（docs/06 §5.1，与边界校验同一个 getter）
    projectRoot,
    run: createCommandRunner({
      defaultCwd: process.cwd(),
      maxOutputBytes: 1024 * 1024,
      workspaceRoot: projectRoot,
      logger: logger.child('tools'),
    }),
    files: createNodeFilePort({
      workspaceRoot: projectRoot,
      logger: logger.child('tools'),
      snapshots: filePortSnapshots,
    }),
    open: createShellOpenPort(),
  })
  settingsTool = registerSettingsTool({ tools, port: settingsPort, logger: logger.child('tools') })
  // 7.1.2 STT / 生图服务（docs/06 §15）：出网走注入的 netFetch（代理生效），
  //     生图落盘到 `userData/generated`（imagegen:read 的白名单根，见 ipc.ts 的路径校验）。
  const sttService = createSttService({
    settings,
    logger: logger.child('stt'),
    resolveFetch: () => netFetch,
  })
  const imageGenService = createImageGenService({
    settings,
    logger: logger.child('imagegen'),
    generatedDir: join(userData, 'generated'),
    resolveFetch: () => netFetch,
  })
  // 7.1.3 扩展工具五件套（docs/06 §14）：web_fetch / clipboard_read / clipboard_write /
  //     notify_user / generate_image。与 set_setting 同级——不受 `agent.tools.enabled` 门控，
  //     敏感动作靠工具自身的 `sensitivity: 'confirm'` 逐次确认。
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
  })
  // 7.1.4 Agent 内核自带工具（docs/06 §18/§19）：todo_write / todo_read / task。
  //     与 set_setting / 扩展工具五件套同级——不受 `agent.tools.enabled` 门控
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
  // 7.1.5 provider 工厂提取成常量：KernelAgentHost 与 `task` 子代理共享同一实例，
  //     「常规构造失败 → 临时回退可用条目」的启动自愈语义（docs/06 §12、step 02 第 6 条）
  //     两处一致；create() 每次请求即时构造，设置页改 Key 后无需重启即生效。
  const providerFactory = createProviderFactory(settings, logger.child('llm'), () => netFetch)
  const agentProvider: AgentProviderFactory = {
    create: () => {
      try {
        const config = providerFactory.create()
        if (config !== undefined) return config
        return providerFactory.create({ allowFallback: true })
      } catch (error) {
        logger?.warn('默认模型配置构造失败，尝试回退到可用条目', { error: String(error) })
        return providerFactory.create({ allowFallback: true })
      }
    },
  }
  agentCoreTools = registerAgentCoreTools({
    tools,
    logger: logger.child('tools'),
    todoPort,
    provider: agentProvider,
    // 只读档下摘掉 `todo_write`（safe 级但会往 userData/todos 落盘）——档位每次 sync 现读，
    // 用户切档后由 `settings:changed` → `syncToolRegistries()` 立即生效
    getSettings: () => settings!.get(),
  })
  // 7.1.6 ClassIsland 提醒工具（docs/05 §3.4 v3）：`classisland_remind`。
  //     与扩展工具五件套同级——不受 `agent.tools.enabled` 门控；但**按可用性注册**：
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
  syncToolRegistries()

  mcp = new McpController({
    settings,
    tools,
    logger: logger.child('mcp'),
    resolveFetch: () => netFetch,
    onStatusChanged: (statuses) => mcpStatusListeners.forEach((listener) => listener(statuses)),
  })
  await mcp.start()

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
    // 每次调用即时判断：设置页改档位无需重启（docs/06 §11.2）
    mode: () => resolvePermissionMode(settings!.get()),
    // 免确认命令模式（docs/06 §11.7）：与 `mode` 同款闭包 —— 每次调用即时读设置，
    // 用户在设置页加完模式立刻生效，无需重启（该字段是只读前缀，AI 改不动）。
    allowPatterns: () => settings!.get().agent.tools.terminal.allowPatterns,
    // auto 档的免确认边界 = 当前项目根（无项目时 auto 档与"关掉确认总开关"同义）
    projectRoot: () =>
      resolveProject(settings!.get(), {
        cwd: process.cwd(),
        ...(projectLogger === undefined ? {} : { logger: projectLogger }),
      }).root,
    logger: logger.child('confirm'),
  })

  // 项目机制（v13，docs/06 §5.1）：每轮按「项目根 → 当前工作目录」逐层收集 AGENTS.md
  // （同目录 AGENTS.override.md 优先）。取用器内部按 root + 文件 mtime 缓存，
  // 无项目 / 读不到文件一律降级为不注入 —— 装配层只提供"当前值"的取值闭包。
  // （`projectLogger` 已上移到 `projectRoot` 之前声明，原因见那里的承重注释。）
  const projectInstructions = createProjectInstructionsSource({
    fs: nodeProjectFs,
    ...(projectLogger === undefined ? {} : { logger: projectLogger }),
    resolveRoot: () =>
      resolveProject(settings!.get(), {
        cwd: process.cwd(),
        ...(projectLogger === undefined ? {} : { logger: projectLogger }),
      }).root,
    resolveCwd: () => process.cwd(),
    resolveMaxBytes: () => settings!.get().projects.maxAgentsBytes,
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
    modePrompt: () => modes.systemPrompt(),
    perceptionSummary: () => perception?.contextSummary() ?? Promise.resolve(''),
    // 长上下文摘要（docs/06 §4）：被截断的旧消息交给当前 provider 压成一段摘要。
    // 装配层实现、内核只接受注入 —— agent-core 保持不依赖网络与 Electron。
    summarize: createSummarizer(settings, logger.child('summary')),
    // 快速会话上下文只带最近 5 分钟，防旧上下文污染（docs/06 §4 滑动窗口）
    quickContextWindowMs: 5 * 60_000,
    confirmTool,
    // Job 持久化（docs/06 §4.1，v15）：一次请求 = 一条可查询 / 可续跑的 job。
    // 三个上限都走 **getter** —— 设置页改完下一次请求即生效（v15 之前 maxRounds 是常量值，
    // 改配置必须重启，属于"能写但不生效"的死字段）。
    jobs: jobStore,
    maxRounds: () => settings!.get().agent.loop.maxRounds,
    maxTotalTokens: () => settings!.get().agent.loop.maxTotalTokens,
    autoContinueRounds: () => settings!.get().agent.loop.autoContinueRounds,
  })
  agent = new DesktopAgentHost({
    settings,
    modes,
    perception,
    logger: logger.child('agent-host'),
    kernel,
    confirmTool,
  })
  const llm = new LlmTester({
    settings,
    logger: logger.child('llm'),
    resolveFetch: () => netFetch,
  })
  const tts = new TtsSynthesizer({
    settings,
    logger: logger.child('tts'),
    resolveFetch: () => netFetch,
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
    port: createUpdaterPort(logger.child('updater')),
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
  preClassReminder = new PreClassReminder({
    // 每次检查重新解析：`resolveScheduleProvider` 是**按值快照**的，
    // 只构造一次会导致"设置页改完课程表要重启才生效"。
    getProvider: () => currentScheduleProvider(),
    enabled: () => settings!.get().modes.classroom.preClassReminder,
    quietHours: () => settings!.get().advanced.quietHours,
    // 课前提前分钟数（v10，docs/05 §3.4）：**每次 tick 即时读取**（getter 而非构造期常量），
    // 因此设置页改完立即生效；此前恒为 schedule.ts 的 DEFAULT_LOOKAHEAD_MINUTES = 5。
    getLookaheadMinutes: () => settings!.get().modes.classroom.preClassLeadMinutes,
    // 自动打开科目文件夹受 `preClassOpenFolder` 门控（Design/betav2-spec.md §8.7）：
    // 通知照发，只是不再主动弹资源管理器
    openFolderEnabled: () => settings!.get().modes.classroom.preClassOpenFolder,
    notify: (title, body, openPath) => notify(title, body, openPath),
    openPath: async (target) => {
      if (smokeMode) {
        preClassOpened = true
        logger?.info('自测：跳过真实打开文件夹，已记录回执', { target })
        return
      }
      const error = await shell.openPath(target)
      if (error !== '') throw new Error(error)
    },
    resolveSubjectDir: (subjectName) => {
      const classroom = settings!.get().modes.classroom
      const subject = classroom.subjects.find((item) => item.name === subjectName)
      return resolveSubjectFolder(classroom.watchDir, subject?.folder ?? '')
    },
    logger: logger.child('pre-class'),
    ...(smokeMode
      ? {
          onFired: (info: { subject: string; minutesUntil: number; targetDir: string }) => {
            preClassFired.unshift({ ...info, opened: preClassOpened })
            if (preClassFired.length > 10) preClassFired.length = 10
          },
        }
      : {}),
  })

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
    classification,
    proactive: adaptProactive(proactiveScheduler),
    hotkey: hotkeys,
    // 写前快照（docs/06 §11.8）：ipc 的 snapshots:* 三条通道用它；配置变了由 ensureSnapshotPort 换实例
    jobs: jobStore,
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
    mcpStatus: () => mcp?.statuses() ?? [],
    onMcpStatusChanged: (listener) => {
      mcpStatusListeners.add(listener)
      return () => {
        mcpStatusListeners.delete(listener)
      }
    },
    updater,
    logger: logger.child('ipc'),
    paths,
    isDev,
    smokeMode,
    smokeDiagnostics: () => ({
      enabled: true,
      preClassFired: smokeMode ? [...preClassFired] : undefined,
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
    },
  }
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
  edgeBarScheduler = new EdgeBarScheduler({
    // 首次引导期间不显示提示条：那时用户还没配好模型，竖条只会挡视线
    enabled: () => settings!.get().general.edgeBar.enabled && settings!.needsOnboarding() === false,
    quietHours: () => settings!.get().general.edgeBar.quietHours,
    show: () => windows?.show('edge-bar'),
    hide: () => windows?.hide('edge-bar'),
    logger: logger.child('edge-bar'),
  })
  edgeBarScheduler.start()

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
  // ClassIsland 课堂状态卡的夹具（同上：必须在窗口首次读之前落盘）
  await seedClassIslandFixture(app.getPath('userData'))
  // 「任务」面板的 paused job 夹具（v15，docs/06 §4.1）：**同样必须在窗口首次读之前**——
  // 任务面板挂载时会调 `chat:jobs`，而 `FileJobStore` 首读即缓存（读到空表后再写文件它看不见，
  // 表现为"面板一直显示暂无任务"）。种在这里而不是场景 prepare 里，就是为了抢在那个首读之前。
  await seedJobFixture(app.getPath('userData'))
  // 输入框 → 真实（离线桩）模型往返场景：**排在计划最后**，因为它在 prepare 里把
  // `llm.active` 换成桩服务（前面的场景读到的是「未配置模型」的出厂态，不受影响）。
  // 为什么值得单列一个场景：`AURORA_SMOKE` 的断言跑在引导窗里、读不到对话窗 DOM，
  // 而两个模式互斥 —— 「事件层对了但界面没画出来」只有这里能抓到（见 capture.ts 的探针注释）。
  const chatStreamTarget: CaptureTarget = {
    name: 'chat',
    file: 'chat-stream.png',
    prepare: async () => {
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
              temperature: 0.7,
              reasoningEffort: 'auto',
              // 故意给一个窗口值：本场景顺带钉住「占用比例」那一半（分母来自配置）
              contextWindow: 128_000,
            },
          },
        },
      } as Partial<Settings>)
      settings?.setSecret('llm.providers.capture-stub.apiKey', STUB_API_KEY)
      await settings?.flush()
      // 配置改完必须 reload 让渲染层重新水合：`SettingsStore` 启动就把 config.json 读进内存，
      // 计划开始后再改文件对已运行的进程无效（AGENTS.md 的「两个缓存」那条）。
      await manager.reload('chat', {})
    },
    act: chatStreamAct('/system-status 我电脑现在什么状态'),
    check: chatStreamCheck(STUB_MARKER, REASONING_MARKER),
  }
  // 1-D 爆发场景：与 chat-stream 同一条离线桩链路，但按真实推理模型的密度（150 + 150 片、
  // 5ms 一片）喷思考与正文 —— 这是「渲染跟不上输出」唯一能复现的现场，measure 见探针注释。
  // 排在 chat-stream **之后**：它沿用同一条会话（main），前面的现场对后续无害。
  const burstProbeQuestion = 'burst-probe 请把这段话一字不差地念完'
  const chatBurstTarget: CaptureTarget = {
    name: 'chat',
    file: 'chat-stream-burst.png',
    prepare: async () => {
      captureStub ??= await startStubLlmServer(logger?.child('capture-llm'))
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
              temperature: 0.7,
              reasoningEffort: 'auto',
              contextWindow: 128_000,
            },
          },
        },
      } as Partial<Settings>)
      settings?.setSecret('llm.providers.capture-stub.apiKey', STUB_API_KEY)
      await settings?.flush()
      await manager.reload('chat', {})
    },
    act: chatStreamBurstAct(burstProbeQuestion),
    check: chatStreamBurstCheck({
      textStart: BURST_TEXT_START_MARKER,
      textEnd: BURST_TEXT_END_MARKER,
      reasoningStart: BURST_REASONING_START_MARKER,
      reasoningEnd: BURST_REASONING_END_MARKER,
    }),
  }
  const plan = filterCapturePlan(
    [
      ...defaultCapturePlan(manager, app.getPath('userData'), {
        // 综合概览场景要项目卡在场：由装配层改配置（capture.ts 不碰 SettingsStore）
        setProject: (project) => {
          const current = settings?.get().projects
          if (current === undefined) return
          settings?.update({
            projects:
              project === undefined
                ? { ...current, current: '', list: [] }
                : { ...current, current: project.id, list: [project] },
          })
        },
      }),
      chatStreamTarget,
      chatBurstTarget,
    ],
    process.env['AURORA_CAPTURE_WINDOWS'],
  )
  logger?.info('开始窗口截图', { dir, count: plan.length })
  const result = await captureWindows({
    dir,
    targets: plan,
    manager,
    logger: logger ?? undefined,
    delayMs: 700,
  })
  logger?.info('窗口截图完成', { written: result.files.length, dir })

  // 渲染层探针结果与截图一起落盘：截图回答"长什么样"，探针回答"能不能点"。
  // 用与 AURORA_SMOKE 相同的前缀，方便在同一条命令链里 grep 结果。
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
    await fs.rm(smokeWorkspace, { recursive: true, force: true }).catch(() => undefined)
  }
  if (result.files.length === 0) app.exit(1)
  else app.exit(result.failed ? 2 : 0)
}

/**
 * 在 onboarding 窗口的渲染进程里执行自测脚本：
 * 覆盖 preload 暴露面、IPC 往返、凭据加密、模式引导、窗口状态机、真实对话循环。
 *
 * 对话部分使用本地假 LLM 服务（`smoke-llm.ts`）：自测**离线可跑**，
 * 且"桩服务收到 3 轮 chat 请求 + 其中一轮带回 tool 结果"能证明工具循环真的执行了。
 */
async function runSmokeTest(userData: string): Promise<void> {
  const target = BrowserWindow.getAllWindows()[0]
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
            temperature: 0.7,
            reasoningEffort: 'auto',
            // `contextWindow` 同为 output 必填（zod `.default(0)`）：0 = 未知，
            // 界面此时只显示 token 数、不显示占用比例
            contextWindow: 0,
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
  // "第二次请求带回 tool 结果"证明工具循环真实走通。
  const expectedChatRequests = 3 + 4 + 2 * 2
  record(
    `桩 LLM 收到 ${expectedChatRequests} 轮 chat 请求（工具循环 + 子代理成立）`,
    chatRequests === expectedChatRequests,
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
  {
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
  {
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
            current: 'smoke-project',
            list: [{ id: 'smoke-project', name: '自测项目', root: projectRoot }],
          },
        })

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
        settings.update({ projects: { ...settings.get().projects, current: '', list: [] } })
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

  // 2.3 三档权限（v13，docs/06 §11.2）：只读档"根本不在工具表里"、auto 档根内免确认 / 根外仍确认。
  //     这里断言的是**真实装配实例**（`syncToolRegistries()` 重建出的注册表 + 注入内核的同一个
  //     `confirmTool`）——单测各自覆盖过函数，但"改设置 → 注册表跟着变 → 确认判定跟着变"这条
  //     生效路径只有整机跑得出来。
  {
    let readonlyToolNames: string[] = []
    let readonlyRemoved = false
    let autoInsideApproved = false
    let autoInsideNoCard = false
    let autoInsideWritten = false
    let autoOutsideCard = false
    let outsideBlocked = false
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
        const projectsBefore = settings.get().projects
        // 设一个当前项目：没有项目时 auto 档没有"根内"判据（那是老开关的等价路径）
        settings.update({
          projects: {
            ...projectsBefore,
            current: 'smoke-perm',
            list: [{ id: 'smoke-perm', name: '权限自测', root: projectRoot }],
          },
        })

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

        // ② auto 档 + 项目根内：确认判定直接放行（**不产生在途卡片**），且真的写得进去
        settings.update({ agent: { ...agentBefore, permissionMode: 'auto' } })
        syncToolRegistries()
        autoInsideApproved =
          (await confirmTool({
            name: 'write_file',
            input: { path: insideFile },
            sessionId: 'smoke-permission',
            sensitivity: 'confirm',
          })) !== false
        autoInsideNoCard = scheduler.pendingCount === 0
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

        // ③ auto 档 + 项目根外：仍要弹卡片（有在途确认），且未经放行时写不进去。
        // ⚠️ 不能直接 `await confirmTool(...)`：它会一直等着用户回执（60s 超时）——
        // 先把 Promise 挂起、轮询「有在途卡片」，再 rejectAll 收尾并回收那个 Promise。
        const outsidePromise = confirmTool({
          name: 'write_file',
          input: { path: outsideFile },
          sessionId: 'smoke-permission',
          sensitivity: 'confirm',
        })
        let cardSeen = false
        for (let attempt = 0; attempt < 40 && !cardSeen; attempt += 1) {
          cardSeen = scheduler.pendingCount === 1
          if (!cardSeen) await new Promise((resolve) => setTimeout(resolve, 25))
        }
        scheduler.rejectAll('smoke-permission')
        const outsideDecision = await outsidePromise
        autoOutsideCard = cardSeen && outsideDecision === false
        const blocked = await tools
          ?.get('write_file')
          ?.execute(
            { path: outsideFile, content: 'AURORA_PERMISSION_OUTSIDE' },
            { sessionId: 'smoke-permission' },
          )
        outsideBlocked =
          blocked?.isError === true &&
          (await fs.readFile(outsideFile, 'utf8').catch(() => '')) === ''

        // 收尾：档位与项目都还原
        settings.update({ agent: { ...agentBefore, permissionMode: 'confirm' } })
        settings.update({ projects: { ...settings.get().projects, current: '', list: [] } })
        syncToolRegistries()
        detail =
          `readonlyKept=[${readonlyToolNames.join(',')}] ` +
          `autoInside=approve:${autoInsideApproved} noCard:${autoInsideNoCard} written:${autoInsideWritten} ` +
          `autoOutside=card:${autoOutsideCard} blocked:${outsideBlocked}`
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
      'auto 档：项目根内免确认且真的写成功；根外仍弹确认卡且未放行时写不进去',
      autoInsideApproved &&
        autoInsideNoCard &&
        autoInsideWritten &&
        autoOutsideCard &&
        outsideBlocked,
      detail,
    )
  }

  // 2.4 写前快照与一键回滚（v14，docs/06 §11.8）：走**真实链路** —— 注册表里的 write_file /
  //     edit_file 工具 → file-port 的写前钩子 → 真实快照端口 → 磁盘。
  //     这是"回滚能救回原内容"的端到端证据：单测各自覆盖了端口与端口钩子，
  //     但"工具层带上 snapshot 参数、装配层真的注入了端口"这条链只有整机跑得出来。
  {
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
  {
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

  // 2.6 跨特性集成（step 5）：把四步串成一条链 —— 选项目 → 设权限档 → Agent 真的写文件（留快照）
  //     → 只读档写不动 → 一键回滚。每条断言都必须能回答"这个特性坏了它会失败吗"：
  //     于是写文件走**真实桩驱动**（标记之后那一行是目标路径），而不是直接调工具注册表。
  {
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
            current: projectId,
            list: [{ id: projectId, name: '集成自测项目', root: projectRoot }],
          },
          // 一轮工具就够：第 0 轮写文件、第 1 轮收尾；关掉自动续轮让行为确定
          agent: {
            ...previousAgent,
            loop: { maxRounds: 2, maxTotalTokens: 0, autoContinueRounds: 0 },
          },
        })

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
        readonlyOk = blockedContent === 'UNTOUCHED'

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
          projects: { ...settings.get().projects, current: '', list: [] },
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
  {
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

  // 3. 提示条两态：断言**真实 BrowserWindow 的几何**（不只状态机）。
  //    纯函数由 edge-bar-geometry.test.ts 覆盖；这里证明 setBounds 在主进程链路里真的生效，
  //    且展开/收起保持右缘与 y 不变（docs/07 §2.2）。
  //
  //    注意：Windows 上 `getBounds()` 会带上窗口的不可见边框（实测 8px 请求 → 10px 返回，
  //    且随 DPI 缩放变化），所以这里断言**不变量 + 容差**，而不是精确相等 ——
  //    精确的几何算术由纯函数单测保证。
  const near = (a: number, b: number, tolerance: number): boolean => Math.abs(a - b) <= tolerance
  const workArea = screen.getPrimaryDisplay().workArea
  const rightEdge = workArea.x + workArea.width
  windows?.setEdgeBarExpanded(false)
  const barCollapsed = windows?.getBounds('edge-bar')
  windows?.setEdgeBarExpanded(true)
  const barExpanded = windows?.getBounds('edge-bar')
  windows?.setEdgeBarExpanded(false)
  const barBack = windows?.getBounds('edge-bar')
  record(
    '提示条收起态真实窗口约 8px 宽且贴右缘',
    barCollapsed !== undefined &&
      near(barCollapsed.width, EDGE_BAR_WIDTHS.collapsed, 4) &&
      near(barCollapsed.x + barCollapsed.width, rightEdge, 4),
    JSON.stringify(barCollapsed),
  )
  record(
    '提示条展开态真实窗口约 228px 宽、右缘与垂直中心不变',
    barCollapsed !== undefined &&
      barExpanded !== undefined &&
      near(barExpanded.width, EDGE_BAR_WIDTHS.expanded, 4) &&
      near(barExpanded.x + barExpanded.width, barCollapsed.x + barCollapsed.width, 3) &&
      near(barExpanded.y + barExpanded.height / 2, barCollapsed.y + barCollapsed.height / 2, 3) &&
      barExpanded.height > barCollapsed.height,
    JSON.stringify(barExpanded),
  )
  record(
    '提示条展开态占满工作区高度（面板按钮不会被挤出可视区）',
    barExpanded !== undefined &&
      barExpanded.height >= workArea.height - 2 * 24 - 6 &&
      barExpanded.height <= workArea.height,
    barExpanded !== undefined ? `height=${barExpanded.height}, workArea=${workArea.height}` : '',
  )
  record(
    '提示条展开比收起宽出约 220px（8 -> 228）',
    barCollapsed !== undefined &&
      barExpanded !== undefined &&
      near(
        barExpanded.width - barCollapsed.width,
        EDGE_BAR_WIDTHS.expanded - EDGE_BAR_WIDTHS.collapsed,
        4,
      ),
    barCollapsed !== undefined && barExpanded !== undefined
      ? `delta=${barExpanded.width - barCollapsed.width}`
      : 'undefined',
  )
  record(
    '提示条收起后真实窗口回到初始矩形（往返幂等）',
    barBack !== undefined &&
      barCollapsed !== undefined &&
      barBack.x === barCollapsed.x &&
      barBack.width === barCollapsed.width &&
      barBack.height === barCollapsed.height,
    JSON.stringify(barBack),
  )

  // 4. 电脑操控工具（docs/06 §11）：用**真实的 Windows 进程与文件系统**证明
  //    「模型真的能操控电脑」这条链路在主进程装配下是通的。
  //
  //    这里断言的是**已装配**的清单而不是 `COMPUTER_TOOL_NAMES` 全量：后者是「开关要认的名字」，
  //    它的元素要等对应工具真正被创建出来才算数（v12 起 8 个全部交付，两处一致但仍显式列出）。
  //    显式列出而不写死长度：新增工具时同步加名字，断言仍是逐条精确的。
  const SMOKE_IMPLEMENTED_TOOLS = [
    'run_command',
    'read_file',
    'write_file',
    'edit_file',
    'list_dir',
    'open_path',
    'grep',
    'glob',
  ] as const
  {
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
    const grep = tools?.get('grep')
    const glob = tools?.get('glob')
    record(
      '敏感级与文档一致（run_command / write_file / edit_file = confirm，read_file / grep / glob = safe）',
      runCommand?.sensitivity === 'confirm' &&
        writeFile?.sensitivity === 'confirm' &&
        editFile?.sensitivity === 'confirm' &&
        readFile?.sensitivity === 'safe' &&
        grep?.sensitivity === 'safe' &&
        glob?.sensitivity === 'safe',
      `run_command=${runCommand?.sensitivity ?? 'missing'} write_file=${writeFile?.sensitivity ?? 'missing'} edit_file=${editFile?.sensitivity ?? 'missing'} read_file=${readFile?.sensitivity ?? 'missing'} grep=${grep?.sensitivity ?? 'missing'} glob=${glob?.sensitivity ?? 'missing'}`,
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
    let commandDetail = ''
    try {
      await fs.mkdir(probeDir, { recursive: true })
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
    } catch (error) {
      commandDetail = `异常：${String(error)}`
    }

    record(
      '真实执行 run_command 后 read_file 能读回产物',
      executed && readBackOk,
      `exit=${executed ? 'ok' : 'fail'} readBack=${readBackOk ? 'ok' : 'fail'} file=${probeFile}`,
    )
    record('list_dir 能在该目录看到刚写入的文件', listedOk, commandDetail)
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
      grepOk =
        grepped !== undefined &&
        grepped.isError !== true &&
        grepText.includes('src/deep/marker.txt:2: AURORA_GREP_OK')
      grepIgnoredOk = !grepText.includes('skipped.txt')
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
  }

  // 5. `set_setting` 的 crash 矩阵（docs/06 §12、step 02 第 8 条）：
  //    逐条写入「AI 可能写出的坏值」，每条都断言**四件事**：
  //    ① 工具的接受 / 拒绝符合预期；② `set_setting` 自己没被写没；
  //    ③ 期望生效的值**真的生效**（含三层路径与同分组兄弟字段是否被抹掉）；
  //    ④ **磁盘上**的 config.json 仍是 `SettingsSchema` 能解析的合法配置。
  //    第 ④ 条刻意读盘、而不是 `safeParse(settings.get())` —— 后者恒真：
  //    `SettingsStore.get()` 的内存态本来就只装「通过了 safeParse」的候选值，
  //    拿它当证据等于什么都没测；而「AI 改设置导致应用崩」的真实风险正是**下次启动读盘**时炸。
  if (settings !== undefined && tools !== undefined) {
    const setSetting = tools.get('set_setting')
    const configPath = join(userData, 'config.json')
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
      { path: 'agent.loop.maxRounds', value: 64, expectReject: true },
      { path: 'agent.snapshots.enabled', value: false, expectReject: true },
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
              temperature: 0.7,
              reasoningEffort: 'auto',
              contextWindow: 0,
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

async function shutdown(): Promise<void> {
  logger?.info('Aurora 退出中')
  disposeIpc?.()
  perception?.stop()
  agent?.dispose()
  updater?.dispose()
  // 全局快捷键必须在退出前注销，否则会残留到进程消亡（Electron 只在正常退出时自动清）
  hotkeys?.dispose()
  edgeBarScheduler?.stop()
  // 主动引导：让在途的敏感工具确认立即失败，不留下悬挂的 Promise
  proactiveScheduler?.dispose()
  preClassReminder?.stop()
  windows?.prepareQuit()
  // 分类管线：先停监听（不再进新文件），再排在途任务，最后落盘流水
  await fileWatcher?.stop().catch(() => undefined)
  await classification?.drain().catch(() => undefined)
  await classification?.close().catch(() => undefined)
  extractPool?.close()
  // 会话与任务清单必须在退出前收尾（docs/06 §4 / §18，同一套防抖 + flush 约定）
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
 * - `computerTools`：按 `agent.tools.*` 重建 8 个电脑操控工具；
 * - `settingsTool`：重建 `set_setting`（不受 `agent.tools.enabled` 影响，见 tools/index.ts）；
 * - `extensionTools`：重建扩展工具五件套（同样不受 `agent.tools.enabled` 影响）；
 * - `agentCoreTools`：重建 todo_write / todo_read / task（同样不受门控，见 tools/index.ts）。
 *
 * 拆开写会让「改开关后工具表变化」的时机不一致：后三者不依赖 `agent.tools.enabled`，
 * 但都与电脑操控工具共用同一张注册表，必须在同一拍完成重建。
 */
function syncToolRegistries(): void {
  computerTools?.sync()
  settingsTool?.sync()
  extensionTools?.sync()
  agentCoreTools?.sync()
  // ClassIsland 提醒工具（v3）：端点填了 / 改了就即时注册或摘除（无需重启）
  classIslandTools?.sync()
}

function syncClassification(): void {
  const service = classification
  const watcher = fileWatcher
  if (service === undefined || watcher === undefined || settings === undefined) return

  const current = settings.get()
  const classroom = current.modes.classroom
  const shouldWatch = current.modes.current === 'classroom' && classroom.watchDir !== ''

  // 课前提醒与分类监听同源：都由「当前是否处于 ClassRoom 且配置就绪」决定
  if (shouldWatch) preClassReminder?.start()
  else preClassReminder?.stop()

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
