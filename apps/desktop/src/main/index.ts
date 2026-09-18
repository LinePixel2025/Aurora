/**
 * Aurora 主进程入口（docs/02 §1、§7）。
 *
 * 启动顺序：
 *  单实例锁 → 日志 → 配置（加密/迁移）→ 感知 → 窗口 → 模式装配 → IPC → 托盘
 *  → 首次引导判断（无可用模型配置则进入引导向导，否则显示服务窗与提示条）。
 */
import { existsSync, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, app, dialog, session } from 'electron'
import { SkillsRegistry } from '@aurora/agent-core'
import { SettingsStore, type ModeContext } from '@aurora/shared'
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
import { PlaceholderAgentHost } from './agent-host.js'
import { LlmTester } from './llm-tester.js'
import { registerIpc, type DesktopDeps } from './ipc.js'
import { createTray, type TrayController } from './tray.js'
import { SMOKE_FLAG, SMOKE_RESULT_PREFIX, SMOKE_SCRIPT } from './smoke.js'

const isDev = !app.isPackaged

/**
 * 用户数据目录固定为 `%APPDATA%/Aurora`（docs/08 §2）。
 * 若不做这一步，Electron 会用 package.json 的 name（`@aurora/desktop`）作为目录名。
 */
app.setName('Aurora')

let logger: FileLogger | undefined
let settings: SettingsStore | undefined
let windows: WindowManager | undefined
let perception: PerceptionHub | undefined
let tray: TrayController | undefined
let disposeIpc: (() => void) | undefined

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
  // 1. 日志
  const userData = app.getPath('userData')
  const logsDir = join(userData, 'logs')
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

  // 3. 系统感知（P1：时间 / 电源 / 网络）
  perception = new PerceptionHub({ logger: logger.child('perception') })
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
  const agent = new PlaceholderAgentHost({
    settings,
    modes,
    perception,
    logger: logger.child('agent'),
  })
  const llm = new LlmTester({ settings, logger: logger.child('llm') })

  const deps: DesktopDeps = {
    settings,
    windows,
    modes,
    guides,
    agent,
    perception,
    llm,
    skills,
    logger: logger.child('ipc'),
    paths,
    isDev,
    onQuit: () => app.quit(),
    onSettingsChanged: (next) => {
      if (!next.general.edgeBar.enabled) windows?.hide('edge-bar')
      syncLaunchAtLogin(next.general.launchAtLogin)
      tray?.refresh()
    },
  }
  disposeIpc = registerIpc(deps)

  // 8. 托盘
  tray = createTray(deps, resolveTrayIcon())
  modes.onChange(() => tray?.refresh())
  settings.onChange(() => tray?.refresh())

  // 8.1 开机自启：必须在 ready 之后调用（docs/04 §P1）
  syncLaunchAtLogin(settings.get().general.launchAtLogin)

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
 * 覆盖 preload 暴露面、IPC 往返、凭据加密、模式引导、窗口状态机、对话流式。
 */
async function runSmokeTest(userData: string): Promise<void> {
  const target = BrowserWindow.getAllWindows()[0]
  if (!target) {
    logger?.error('自测失败：没有可用窗口')
    return
  }

  logger?.info('开始开发自测（真实 Electron / preload / IPC）')
  let payload: { results?: Array<{ name: string; ok: boolean; detail: string }>; fatal?: string }
  try {
    payload = (await target.webContents.executeJavaScript(SMOKE_SCRIPT, true)) as typeof payload
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
  for (const item of results) {
    const line = `${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail === '' ? '' : ` — ${item.detail}`}`
    if (item.ok) logger?.info(`${SMOKE_RESULT_PREFIX} ${line}`)
    else logger?.error(`${SMOKE_RESULT_PREFIX} ${line}`)
  }

  // 校验凭据加密：磁盘上不得出现明文
  try {
    const raw = await fs.readFile(join(userData, 'config.json'), 'utf8')
    const leaked = raw.includes('sk-smoke-plaintext-marker')
    const encrypted = raw.includes('"apiKeyEnc": "') && !raw.includes('"apiKeyEnc": ""')
    logger?.[leaked ? 'error' : 'info'](
      `${SMOKE_RESULT_PREFIX} ${leaked ? 'FAIL' : 'PASS'} 磁盘无明文 API Key`,
    )
    logger?.[!leaked && encrypted ? 'info' : 'error'](
      `${SMOKE_RESULT_PREFIX} ${!leaked && encrypted ? 'PASS' : 'FAIL'} API Key 已加密落盘`,
    )
  } catch (error) {
    logger?.error(`${SMOKE_RESULT_PREFIX} FAIL 读取配置文件 — ${String(error)}`)
  }

  const failed = results.filter((item) => !item.ok)
  logger?.info(
    `${SMOKE_RESULT_PREFIX} SUMMARY ${results.length - failed.length}/${results.length} passed`,
  )
  await logger?.close()
  app.exit(failed.length === 0 ? 0 : 2)
}

async function shutdown(): Promise<void> {
  logger?.info('Aurora 退出中')
  disposeIpc?.()
  perception?.stop()
  windows?.prepareQuit()
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

function notify(title: string, body: string, openPath?: string): void {
  // P1 仅日志；系统通知与点击打开文件夹在 P4 分类管线落地
  logger?.info('通知', { title, body, openPath })
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
