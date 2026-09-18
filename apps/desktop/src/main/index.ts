/**
 * Aurora 主进程入口（docs/02 §1、§7）。
 *
 * 启动顺序：
 *  单实例锁 → 日志 → 配置（加密/迁移）→ 感知 → 窗口 → 模式装配 → IPC → 托盘
 *  → 首次引导判断（无可用模型配置则进入引导向导，否则显示服务窗与提示条）。
 */
import { existsSync, promises as fs, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BrowserWindow,
  Notification,
  app,
  dialog,
  screen,
  session,
  shell,
  utilityProcess,
} from 'electron'
import {
  KernelAgentHost,
  SessionStore,
  SkillsBridge,
  SkillsRegistry,
  ToolRegistry,
} from '@aurora/agent-core'
import {
  SettingsStore,
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
import { registerIpc, type DesktopDeps } from './ipc.js'
import type { ProactiveLike } from './contracts.js'
import { ProactiveScheduler } from './proactive.js'
import { PreClassReminder } from './pre-class-reminder.js'
import { resolveScheduleProvider } from './schedule.js'
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
let smokeWorkspace: string | undefined
if (!app.isPackaged && process.env['AURORA_SMOKE'] === '1') {
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
let disposeIpc: (() => void) | undefined
/** MCP 状态订阅（IPC 层与主进程内部共用，避免为状态再引入一次事件总线） */
const mcpStatusListeners = new Set<(statuses: McpServerStatus[]) => void>()

/** 单实例：二次启动聚焦并唤起服务窗（docs/02 §2.1） */
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    windows?.show('service-dock')
    windows?.focus('service-dock')
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
  // 1. 日志。自测的 userData 是临时目录且退出即删，因此自测日志写到固定位置，
  //    方便 `Get-Content "$env:TEMP\aurora-smoke-logs\aurora-*.log"` 查看断言结果。
  const userData = app.getPath('userData')
  const logsDir =
    smokeWorkspace === undefined ? join(userData, 'logs') : join(tmpdir(), 'aurora-smoke-logs')
  logger = new FileLogger({ dir: logsDir, level: isDev ? 'debug' : 'info', console: isDev })
  logger.info('Aurora 启动', {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    isDev,
    userData,
  })

  // 1.1 渲染层 CSP（docs/06 §10）。开发环境需放宽以允许 Vite dev server 的
  //     inline 预置脚本与 HMR websocket；生产环境只加载本地打包资源。
  const csp = isDev
    ? [
        "default-src 'self' data: blob: http://localhost:5173 ws://localhost:5173",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:5173",
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self' http://localhost:5173 ws://localhost:5173",
        "img-src 'self' data:",
      ].join('; ')
    : [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
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
        return await resolveScheduleProvider(settings!.get().modes.classroom).getToday(new Date())
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
  const skills = new SkillsRegistry({
    builtinDir: resolveBuiltinSkillsDir(),
    userDir: join(userData, 'skills'),
    logger: logger.child('skills'),
  })
  await skills.scan().catch((error: unknown) => {
    logger?.warn('技能扫描失败', { error: String(error) })
  })
  skills.setDisabled(settings.get().skills.disabled)

  // 6. 模式装配
  const modes = new ModeManager(logger.child('mode'))
  const modeContext: ModeContext = {
    settings: {
      get: () => settings!.get(),
      mutate: (mutator) => settings!.mutate(mutator),
    },
    windows: {
      showChat: () => windows?.showChat(),
      showMiniChat: () => windows?.showMiniChat(),
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
  const tools = new ToolRegistry()
  const skillBridge = new SkillsBridge(skills)
  skillBridge.registerInto(tools)

  mcp = new McpController({
    settings,
    tools,
    logger: logger.child('mcp'),
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

  const kernel = new KernelAgentHost({
    sessions,
    provider: createProviderFactory(settings, logger.child('llm')),
    tools,
    skills: skillBridge,
    logger: logger.child('agent'),
    modePrompt: () => modes.systemPrompt(),
    perceptionSummary: () => perception?.contextSummary() ?? Promise.resolve(''),
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
  const llm = new LlmTester({ settings, logger: logger.child('llm') })

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

  // 7.5 课前提醒（docs/05 §3.4）：按课程表在课前 5 分钟通知并打开科目文件夹
  //
  // 自测（smokeMode）下把"打开文件夹"记为**真实回执**而不是真的弹资源管理器：
  // 无头/CI 环境弹出资源管理器没有意义，但"到底有没有调用打开"必须可观测，
  // 否则"自动打开科目文件夹"这条验收就只能靠看代码。
  let preClassOpened = false
  preClassReminder = new PreClassReminder({
    // 每次检查重新解析：`resolveScheduleProvider` 是**按值快照**的，
    // 只构造一次会导致"设置页改完课程表要重启才生效"。
    getProvider: () => resolveScheduleProvider(settings!.get().modes.classroom),
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
    skills,
    sessions,
    classification,
    proactive: adaptProactive(proactiveScheduler),
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
    onSettingsChanged: (next) => {
      if (!next.general.edgeBar.enabled) windows?.hide('edge-bar')
      syncLaunchAtLogin(next.general.launchAtLogin)
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

  // 8.3 自动更新：延迟静默检查（不阻塞启动），并在有更新时通知托盘
  updater.scheduleAutoCheck()

  // 9. 首次引导 / 正常启动
  if (report.needsOnboarding) {
    logger.info('未配置 AI 模型，进入首次引导')
    windows.show('onboarding')
  } else {
    windows.show('service-dock')
    if (settings.get().general.edgeBar.enabled) windows.show('edge-bar')
    modes.requestGuideIfNeeded(settings.get().modes.current, 'startup')
  }

  logger.info('Aurora 就绪')

  // 10. 开发自测（AURORA_SMOKE=1）：在真实渲染进程里跑一遍关键链路后退出
  if (isDev && process.env[SMOKE_FLAG] === '1') {
    void runSmokeTest(userData)
  }
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
            temperature: 0.7,
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
 * 3. 放一节 **4 分钟后开始** 的数学课，让课前 5 分钟窗口立刻命中
 *    （无需等待真实课前时间）。
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
      provider: 'manual',
      lessons: [
        {
          weekday: startTime.getDay(),
          startTime: clock,
          endTime: `${pad2(startTime.getHours())}:${pad2(startTime.getMinutes())}`,
          subject: '数学',
        },
      ],
    }
  })
  logger?.info('自测已配置 ClassRoom（待分类文件由渲染层实时投放）', { watchDir, lesson: clock })
  return watchDir
}

function pad2(value: number): string {
  return `${value}`.padStart(2, '0')
}

async function shutdown(): Promise<void> {
  logger?.info('Aurora 退出中')
  disposeIpc?.()
  perception?.stop()
  agent?.dispose()
  updater?.dispose()
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
