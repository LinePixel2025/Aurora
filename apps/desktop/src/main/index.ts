/**
 * Aurora 主进程入口（docs/02 §1、§7）。
 *
 * 启动顺序：
 *  单实例锁 → 日志 → 配置（加密/迁移）→ 感知 → 窗口 → 模式装配 → IPC → 托盘
 *  → 首次引导判断（无可用模型配置则进入引导向导，否则显示服务窗与提示条）。
 */
import { existsSync, promises as fs, readdirSync, rmSync, statSync } from 'node:fs'
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
import { KernelAgentHost, SessionStore, SkillsBridge, ToolRegistry } from '@aurora/agent-core'
import type { SettingsToolPort, ToolDefinition } from '@aurora/agent-core'
import {
  COMPUTER_TOOL_NAMES,
  SettingsSchema,
  SettingsStore,
  type ClassIslandStatus,
  type ClassIslandTestResult,
  type Logger,
  type McpServerStatus,
  type ModeContext,
  type Settings,
  type SettingsPatch,
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
import { DesktopAgentHost, createConfirmTool, createProviderFactory } from './agent-host.js'
import { McpController } from './mcp.js'
import { LlmTester } from './llm-tester.js'
import { TtsSynthesizer } from './tts.js'
import { registerIpc, createSettingsWriter, type DesktopDeps } from './ipc.js'
import type { ProactiveLike, SettingsStoreLike } from './contracts.js'
import { ProactiveScheduler } from './proactive.js'
import { PreClassReminder } from './pre-class-reminder.js'
import { EdgeBarScheduler } from './edge-bar-scheduler.js'
import { HotkeyManager } from './hotkey.js'
import { SkillsService } from './skills.js'
import { ClassIslandProvider } from './classisland.js'
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
import { STUB_API_KEY, STUB_MODEL, startStubLlmServer, type StubLlmServer } from './smoke-llm.js'
import { EDGE_BAR_WIDTHS } from './edge-bar-geometry.js'
import {
  captureWindows,
  defaultCapturePlan,
  filterCapturePlan,
  seedChatTtsHistory,
} from './capture.js'
import {
  registerComputerTools,
  registerSettingsTool,
  type ComputerTools,
  type SettingsToolRegistry,
} from './tools/index.js'
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
const isolatedRun =
  !app.isPackaged &&
  (process.env['AURORA_SMOKE'] === '1' || (process.env['AURORA_CAPTURE'] ?? '').trim() !== '')
if (isolatedRun) {
  smokeWorkspace = join(tmpdir(), `aurora-smoke-${process.pid}-${Date.now()}`)
  pruneSmokeWorkspaces()
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
/** 构造当前 provider 用的配置签名（变化时重建） */
let classIslandSignature = ''
let disposeIpc: (() => void) | undefined
/** 工具表与电脑操控装配器提到模块级：`runSmokeTest` 要在真实进程里断言它们（docs/06 §11） */
let tools: ToolRegistry | undefined
let computerTools: ComputerTools | undefined
/** `set_setting` 装配器（docs/06 §12）：与电脑操控工具分开注册，互不摘除 */
let settingsTool: SettingsToolRegistry | undefined
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
  const captureTheme =
    isDev && (process.env['AURORA_CAPTURE'] ?? '').trim() !== ''
      ? process.env['AURORA_CAPTURE_THEME']
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

  // 7.1 电脑操控工具（docs/06 §11）：按 `agent.tools.*` 注册 5 个工具。
  //     必须在内核（KernelAgentHost）构造前装配，否则第一次请求的工具表是空的。
  //     `sync()` 是唯一的开关落地点：这里一次、`onSettingsChanged` 一次 → 改完立即生效。
  //     runner 的 `defaultCwd` 只作兜底，真正的工作目录由工具层每次按配置传入
  //     （于是 `agent.tools.workspaceDir` 改完不用重建 runner）。
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
  computerTools = registerComputerTools({
    tools,
    getSettings: () => settings!.get(),
    logger: logger.child('tools'),
    homeDir: () => app.getPath('home'),
    run: createCommandRunner({ defaultCwd: process.cwd(), maxOutputBytes: 1024 * 1024 }),
    files: createNodeFilePort(),
    open: createShellOpenPort(),
  })
  settingsTool = registerSettingsTool({ tools, port: settingsPort, logger: logger.child('tools') })
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
  const confirmTool = createConfirmTool({
    proactive: proactiveScheduler,
    // 每次调用即时判断：设置页改开关无需重启
    enabled: () => settings!.get().advanced.confirmSensitiveTools,
    logger: logger.child('confirm'),
  })

  const providerFactory = createProviderFactory(settings, logger.child('llm'), () => netFetch)
  const kernel = new KernelAgentHost({
    sessions,
    // 启动自愈（docs/06 §12、step 02 第 6 条）：常规构造失败时（`llm.active` 为空 / 指向不存在的
    // provider / 当前条目缺 Key），临时借一个可用条目把请求建起来，而不是让 Agent 彻底失能。
    // 回退只影响本次请求构造，不写配置。
    provider: {
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
    },
    tools,
    skills: skillBridge,
    logger: logger.child('agent'),
    modePrompt: () => modes.systemPrompt(),
    perceptionSummary: () => perception?.contextSummary() ?? Promise.resolve(''),
    // 长上下文摘要（docs/06 §4）：被截断的旧消息交给当前 provider 压成一段摘要。
    // 装配层实现、内核只接受注入 —— agent-core 保持不依赖网络与 Electron。
    summarize: createSummarizer(settings, logger.child('summary')),
    confirmTool,
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
    skills: skillsService,
    sessions,
    classification,
    proactive: adaptProactive(proactiveScheduler),
    hotkey: hotkeys,
    classisland: {
      enabled: () => isClassIslandActive(),
      status: () => classIslandStatus(),
      test: () => testClassIsland(),
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
  const plan = filterCapturePlan(defaultCapturePlan(manager), process.env['AURORA_CAPTURE_WINDOWS'])
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
    const report = { dir, files: result.files, checks: result.checks }
    await fs.writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
  } catch (error) {
    logger?.warn('截图报告写出失败', { error: String(error) })
  }
  for (const item of result.checks) {
    if (item.result === undefined) continue
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
  if (smokeWorkspace !== undefined) {
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

  let payload: { results?: Array<{ name: string; ok: boolean; detail: string }>; fatal?: string }
  try {
    payload = (await target.webContents.executeJavaScript(
      smokeScript(stub.baseUrl, STUB_MODEL, watchDir),
      true,
    )) as typeof payload
  } catch (error) {
    logger?.error('自测脚本执行异常', { error: String(error) })
    app.exit(1)
    return
  }

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
  // 第一轮 2 次（工具调用 + 最终回复）、第二轮 1 次（纯文本）= 3 次；
  // "第二次请求带回 tool 结果"证明工具循环真实走通。
  record('桩 LLM 收到 3 轮 chat 请求（工具循环成立）', chatRequests === 3, `count=${chatRequests}`)
  record('第二次请求带回了 tool 结果', stub.sawToolResult(), '')
  record('请求携带了工具清单（use_skill 已注册）', stub.sawTools(), '')
  // 分类管线确实调用过模型（低置信文件走了 LLM 分支）
  record(
    '分类管线调用过模型（结构化输出）',
    stub.classifyRequestCount() > 0,
    `classify=${stub.classifyRequestCount()}`,
  )

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
  {
    const names = tools ? tools.list().map((tool) => tool.name) : []
    const missing = COMPUTER_TOOL_NAMES.filter((name) => !names.includes(name))
    record(
      '电脑操控工具已注册（5 个）',
      missing.length === 0,
      `names=${names.join(',')}${missing.length === 0 ? '' : ` missing=${missing.join(',')}`}`,
    )

    // 敏感级直接钉住 step 1 文档里写的值：这两个工具的每一次调用都必须弹确认卡片
    const runCommand = tools?.get('run_command')
    const writeFile = tools?.get('write_file')
    const readFile = tools?.get('read_file')
    record(
      '敏感级与文档一致（run_command / write_file = confirm，read_file = safe）',
      runCommand?.sensitivity === 'confirm' &&
        writeFile?.sensitivity === 'confirm' &&
        readFile?.sensitivity === 'safe',
      `run_command=${runCommand?.sensitivity ?? 'missing'} write_file=${writeFile?.sensitivity ?? 'missing'} read_file=${readFile?.sensitivity ?? 'missing'}`,
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

    // 开关热生效：`settings:update` 是顶层浅合并，必须带**完整**的 agent.tools 子树，
    // 否则会把 files / open 配置写丢 —— 这条断言顺带回归这一点。
    let hotSwitchOk = false
    let subtreeKept = false
    if (settings !== undefined) {
      const before = settings.get().agent.tools
      settings.update({
        agent: { tools: { ...before, terminal: { ...before.terminal, enabled: false } } },
      })
      syncToolRegistries()
      const offSoFar =
        tools?.get('run_command') === undefined && tools?.get('open_path') !== undefined

      settings.update({
        agent: { tools: { ...before, terminal: { ...before.terminal, enabled: true } } },
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

    // 总开关：`00-index.md` 完成标准点名的那一条 —— 关闭后 5 个工具**一个都不剩**，
    // 且不能误伤其它工具（`unregister` 只按这 5 个名字摘，`use_skill` / `mcp.*` 不受影响）。
    let masterOffOk = false
    if (settings !== undefined) {
      const before = settings.get().agent.tools
      settings.update({ agent: { tools: { ...before, enabled: false } } })
      syncToolRegistries()
      const allGone = COMPUTER_TOOL_NAMES.every((name) => tools?.get(name) === undefined)
      const othersKept = tools?.get('use_skill') !== undefined

      settings.update({ agent: { tools: { ...before, enabled: true } } })
      syncToolRegistries()
      const restored = COMPUTER_TOOL_NAMES.every((name) => tools?.get(name) !== undefined)
      masterOffOk = allGone && othersKept && restored
    }
    record(
      '总开关热生效：关闭后 5 个工具全部从注册表移除（其它工具不受影响），改回即恢复',
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
      agent: { tools: { ...afterMatrix.agent.tools, enabled: true } },
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
  // 临时 userData 是整个自测的产物，清理掉避免堆在系统临时目录
  if (smokeWorkspace !== undefined) {
    await fs.rm(smokeWorkspace, { recursive: true, force: true }).catch(() => undefined)
  }
  app.exit(failed.length === 0 ? 0 : 2)
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
  const startTime = new Date(Date.now() + 3 * 60_000)
  const clock = `${pad2(startTime.getHours())}:${pad2(startTime.getMinutes())}`
  // 用 Date 推进 45 分钟：手算 `分钟 + 45` 在 [HH:15, HH:59] 会溢出成 "HH:60+"，
  // 被桥接解析器判为非法时间（endTime 需 HH:mm）而丢弃整节课，导致课前提醒断言假失败。
  const endTime = new Date(startTime.getTime() + 45 * 60_000)
  const endClock = `${pad2(endTime.getHours())}:${pad2(endTime.getMinutes())}`

  // 3. 桥接夹具：与真实插件写出的契约完全一致（docs/05 §3.4 v2）
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
        ],
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

function classIslandStatus(): ClassIslandStatus {
  const schedule = settings?.get().modes.classroom.schedule
  const config = schedule?.classisland ?? { source: 'file' as const, endpoint: '', timeoutMs: 3000 }
  const enabled = isClassIslandActive()
  const provider = enabled ? classIslandProviderFor() : undefined
  const status = provider?.getStatus()
  return {
    enabled,
    source: config.source,
    endpoint: config.endpoint,
    ok: status?.ok ?? false,
    lastSyncAt: status?.lastSyncAt ?? null,
    lessonCount: status?.lessonCount ?? 0,
    warnings: status?.warnings ?? [],
    ...(status?.error === undefined ? {} : { error: status.error }),
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
  // 会话与 MCP 子进程必须在退出前收尾（docs/06 §4 / §7）
  await sessions?.flush().catch((error: unknown) => {
    logger?.warn('退出前落盘会话失败', { error: String(error) })
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
    resolve: (confirmId, approved) => scheduler.resolve(confirmId, approved),
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
 * 工具注册表的**唯一**同步入口（docs/06 §11、§12）。 *
 * 两个装配器必须一起同步：
 * - `computerTools`：按 `agent.tools.*` 重建 5 个电脑操控工具；
 * - `settingsTool`：重建 `set_setting`（不受 `agent.tools.enabled` 影响，见 tools/index.ts）。
 *
 * 拆开写会让「改开关后工具表变化」的时机不一致：`set_setting` 是否注册不再依赖
 * `agent.tools.enabled`，但它读的是同一份配置，必须和电脑操控工具在同一拍完成重建。
 */
function syncToolRegistries(): void {
  computerTools?.sync()
  settingsTool?.sync()
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
