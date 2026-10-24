/**
 * 工具装配器合集（docs/06 §11、§12、§14、§18/§19）。
 *
 * 职责边界：本文件**不 import electron**，只做「把工具注册进工具表」这一件事，
 * 因此可以在 Node 环境里完整单测。真实系统调用（进程 / 文件系统 / shell）全部由
 * `command-runner.ts` / `file-port.ts` / `open-port.ts` 通过构造参数注入。
 * （`clipboard.ts` 是唯一的例外：它实现 Electron `clipboard` 端口，必须 import electron，
 * 因此不进本文件的依赖 —— 由 `main/index.ts` 直接构造后注入。）
 *
 * 本文件现有这些装配器：
 * - `registerComputerTools`：电脑操控工具（含 Office 与 `grep` / `glob`），受 `agent.tools.enabled` 门控
 *   （docs/06 §11）；
 * - `registerSettingsTool`：`set_setting` 与 `set_appearance`（v32 的外观三件套入口），
 *   两者都不受门控（docs/06 §12）；
 * - `registerExtensionTools`：扩展工具八件套（含 `show_preview` / `show_image` / `notify_banner`），
 *   不受门控（docs/06 §14）；
 * - `registerImageTools`：图像工具（看图 / 截屏 / 读剪贴板图片），**按模型能力注册** ——
 *   当前生效模型没开图片输入就一个都不注册（docs/06 §25）；
 * - `registerAgentCoreTools`：todo_write / todo_read / task / ask_user，不受门控（docs/06 §18/§19/§21）
 *   —— todo / task 是 Agent 自身的工作能力（维护任务清单、派生上下文隔离的子代理），
 *   不是「电脑操控」，与 set_setting / 扩展工具同级。
 *
 * 另有一条**横切**规则：`agent.permissionMode = 'readonly'`（只读档）时，「写 / 执行 /
 * 有系统副作用」的工具**根本不注册** —— `run_command` / `write_file` / `edit_file` /
 * `open_path` / `todo_write`。只读档的口径是「不在工具表里」而不是「注册后再拒绝」：
 * 模型在工具清单里看不到它们，就不会先答应用户、再在调用时被拒。
 * 各装配器自己的子开关照旧生效（只读档只会让工具表**更小**，不会让哪个开关失效）。
 *
 * `sync()` 是**唯一**的开关落地点：启动时调一次，`settings:changed` 时再调一次，
 * 于是「改开关 / 改档位 / 改上限」立即生效（下一次请求的系统提示词就会看到新的工具表），
 * 无需重启。每次都**重建**工具实例（构造很便宜），所以 cwd / 超时 / 上限也能热改。
 */
import {
  COMPUTER_TOOL_NAMES,
  resolvePermissionMode,
  type Logger,
  type PermissionMode,
  type Settings,
} from '@aurora/shared'
import {
  APPEARANCE_TOOL_NAME,
  createAppearanceTool,
  BROWSER_TOOL_NAMES,
  createBrowserTools,
  createClipboardTools,
  createClipboardImageTool,
  createEditTool,
  createFileTools,
  createImageGenTool,
  createShowImageTool,
  createBannerNotifyTool,
  createNotifyTool,
  createOfficeTools,
  createOpenTool,
  createScreenshotTool,
  createSearchTools,
  createSettingsTool,
  createShowPreviewTool,
  createAskUserTool,
  createTaskTool,
  createTerminalTool,
  createTodoTools,
  createViewImageTool,
  createWebFetchTool,
  TODO_WRITE_TOOL_NAME,
  createCenterSendFileTool,
  createCenterStatusTool,
  type AgentProviderFactory,
  type AskUserPort,
  type BrowserSessionPort,
  type BannerNotifyPort,
  type CenterPort,
  type ClipboardImagePort,
  type ClipboardPort,
  type CommandRunner,
  type FilePort,
  type ImageGenPort,
  type ImageDisplayPort,
  type NotifyPort,
  type OfficePort,
  type OpenPort,
  type PreviewPort,
  type ReadTracker,
  type ScreenshotPort,
  type SettingsToolPort,
  type TodoPort,
  type ToolRegistry,
  type ViewImagePort,
  type WebFetchPort,
} from '@aurora/agent-core'
import {
  CLASSISLAND_REMIND_TOOL_NAME,
  createClassIslandRemindTool,
  type ClassIslandNotifyPort,
} from './classisland-remind.js'
import {
  AUTOMATION_TOOL_NAMES,
  AUTOMATION_WRITE_TOOL_NAMES,
  createAutomationTools,
  type AutomationManagePort,
} from './automation-tools.js'
import {
  AWARENESS_ACTIVE_TOOL_NAMES,
  AWARENESS_STATUS_TOOL_NAME,
  AWARENESS_TOOL_NAMES,
  createAwarenessTools,
  type AwarenessToolPort,
} from './awareness-tools.js'
// 类型导入（编译期擦除，无运行期依赖）：`task` 子代理的写权限要把确认交回
// 主进程那条判定链，形状直接复用 `createConfirmTool` 的返回类型，不再抄第二份。
import type { ConfirmToolDecision } from './../agent-host.js'

/**
 * 现读「生效档位」（`agent.permissionMode` + `advanced.confirmSensitiveTools` 的双开关判定
 * 在 `@aurora/shared` 的 `resolvePermissionMode` 里，这里只补「没注入配置」的缺省值）。
 *
 * **绝不缓存**：`sync()` 在启动时调一次、每次 `settings:changed` 再调一次，档位若在装配时
 * 算一次存下来，用户把档位改回 `readonly` 后工具表就不会跟着收窄 ——
 * 那正是最坏的一类漂移（「界面说只读、实际还能写」）。
 *
 * `settings` 为 `undefined` 时按 `'confirm'` 处理：与三档权限落地**之前**的行为一字不差，
 * 且 `registerAgentCoreTools` 的配置取值是可选注入（单测可直接构造装配器）。
 */
function currentPermissionMode(settings: Settings | undefined): PermissionMode {
  return settings === undefined ? 'confirm' : resolvePermissionMode(settings)
}

export interface ComputerToolsDeps {
  tools: ToolRegistry
  getSettings: () => Settings
  logger: Logger
  /** 用户主目录（三级回落的最后一级：无项目且未配 `agent.tools.workspaceDir` 时才用到） */
  homeDir: () => string
  /**
   * 按会话解析**生效工作目录**（docs/06 §5.1 唯一口径，`session-project.ts` 的实现）：
   * 会话绑定项目 > 会话空间目录 > 激活模式目录 > `agent.tools.workspaceDir` > `homeDir`。
   * （全局 `projects.current` 一级已于 v25 退役。）
   *
   * 为什么是按会话的取值器而不是 sync() 里算好的字符串：工具执行时才知道 `ctx.sessionId`，
   * 而两个会话可以绑定不同项目 —— 缺省 cwd / 搜索根必须**每次执行即时解析**
   * （与 `agent.loop` 上限的 getter 注入同款套路，杜绝「改绑定要重启」的死值）。
   * `sessionId` 传 `undefined` 时按全局回落链解析（sync() 的日志用它）。
   */
  sessionWorkspaceDir: (sessionId: string | undefined) => string
  run: CommandRunner
  files: FilePort
  /** Office 结构化创建 / 读取 / 编辑端口（main/tools/office-port.ts）。 */
  office: OfficePort
  /** 包内 OfficeCLI 是否可用；缺省视为可用，便于纯装配单测。 */
  officeAvailable?: () => boolean
  open: OpenPort
}

export interface ComputerTools {
  /** 按当前配置重建工具表，返回本次注册的工具名 */
  sync(): string[]
}

export function registerComputerTools(deps: ComputerToolsDeps): ComputerTools {
  const toolNames = COMPUTER_TOOL_NAMES as readonly string[]

  // 会话级「读过哪些文件」守卫（docs/06 §11.6）：**在闭包里建一次**，于是整个进程只有这一份，
  // 且 `read_file` 与 `edit_file` 共享同一个实例。
  //
  // 为什么必须在 `sync()` **之外**建（关键时序）：`sync()` 会在每次 `settings:changed` 时
  // 重建全部工具实例（构造很便宜，是为了让上限 / cwd 热改）。守卫若跟着 `sync()` 一起重建，
  // 「本会话已读过的文件」就被清空 —— 表现是用户改一个**完全无关**的开关（比如关掉终端）后，
  // 模型刚 `read_file` 过的文件立刻被 `edit_file` 以「修改前必须先读」拒绝，看起来像工具坏了。
  // 所以守卫的生命周期是**装配器**（进程级），不是 `sync()`（每次配置变更）。
  /** 只保留最近 N 个会话的读记录（Map 的插入序天然是 LRU 近似），防无界增长 */
  const MAX_TRACKED_SESSIONS = 16
  const readFiles = new Map<string, Set<string>>()
  const readTracker: ReadTracker = {
    has: (sessionId, absolutePath) => readFiles.get(sessionId)?.has(absolutePath) === true,
    mark: (sessionId, absolutePath) => {
      const set = readFiles.get(sessionId) ?? new Set<string>()
      set.add(absolutePath)
      readFiles.set(sessionId, set)
      while (readFiles.size > MAX_TRACKED_SESSIONS) {
        const oldest = readFiles.keys().next().value
        if (oldest === undefined) break
        readFiles.delete(oldest)
      }
    },
    clear: (sessionId, absolutePath) => {
      readFiles.get(sessionId)?.delete(absolutePath)
    },
  }

  return {
    sync(): string[] {
      // 先全量摘掉全部电脑操控工具名（含上一次注册、以及被关掉的分支），再按当前配置重建。
      // 不存在的名字 `unregister` 返回 false，忽略即可。
      for (const name of toolNames) deps.tools.unregister(name)

      // 档位与配置**每次现读**（live getter）：`sync()` 是启动一次 + 每次 `settings:changed`
      // 一次，所以改档位 / 改开关后下一次请求的工具表就变了，无需重启。
      const settings = deps.getSettings()
      const mode = currentPermissionMode(settings)
      const readonly = mode === 'readonly'

      const cfg = settings.agent.tools
      if (!cfg.enabled) {
        // 既有第一条分支，**优先级高于档位**：总开关关掉时全部工具一个都不注册，
        // 与档位是 readonly 还是 auto 无关（本来就关得更彻底，不必再看档位）。
        deps.logger.info('电脑操控工具总开关已关闭：全部工具都不注册', {
          names: [...toolNames],
        })
        return []
      }

      // 缺省工作目录 / 搜索根的**唯一口径**（docs/06 §5.1）：回落链
      // 会话绑定项目 > 会话空间目录 > 激活模式目录 > `agent.tools.workspaceDir` > 主目录。
      // sync() 在启动 / `settings:changed` 时只取一次**全局链**（无会话上下文）做日志；
      // 工具实例里的缺省值是**按会话的取值器**（`sessionWorkspaceDir`），每次执行即时解析 ——
      // 两个会话绑定了不同项目时各用各的根，改绑定无需重建工具。
      const workspaceDir = deps.sessionWorkspaceDir(undefined)

      // 只读档：`run_command` 能执行任意命令（写盘 / 改注册表 / 起进程 / 装软件），
      // 是「有系统副作用」的典型，因此**整个分支跳过**——不在只读清单里的工具
      // 就是不进工具表，而不是「注册好、调用时再拒绝」。
      if (cfg.terminal.enabled && !readonly) {
        deps.tools.register(
          createTerminalTool({
            run: deps.run,
            timeoutMs: cfg.terminal.timeoutMs,
            maxOutputChars: cfg.terminal.maxOutputChars,
            defaultCwd: (sessionId) => deps.sessionWorkspaceDir(sessionId),
          }),
        )
      }

      if (cfg.files.enabled) {
        // 文件工具工厂返回 read_file / write_file / list_dir / open_path 四个；
        // 打开类工具受**独立开关**控制，因此这里按名字挑出前三个。
        // 只读档再摘掉 `write_file`（它落盘改文件）→ 只剩 `read_file` / `list_dir`，
        // 判定写法与下面跳过 `open_path` 完全一致（同一个循环里按名字过滤）。
        // `readTracker` 传进去：`read_file` 读成功就为本会话打标记（docs/06 §11.6）。
        for (const tool of createFileTools({
          files: deps.files,
          open: deps.open,
          maxReadBytes: cfg.files.maxReadBytes,
          readTracker,
        })) {
          if (tool.name === 'open_path') continue
          if (readonly && tool.name === 'write_file') continue
          deps.tools.register(tool)
        }
        // `edit_file` 由 `createEditTool` **单独**产出（`createFileTools` 的「恰好 4 个」契约不变），
        // 与 read_file / write_file / list_dir 共用 `files.enabled` 这一个开关，
        // **不单独加开关**（docs/06 §11、docs/08 §1）——它的安全边界是 `sensitivity: 'confirm'`。
        // 只读档**整行跳过**：它按 oldString/newString 改写既有文件，与 `write_file` 同类。
        if (!readonly) {
          deps.tools.register(createEditTool({ files: deps.files, readTracker }))
        }
        // Office 专用工具与文件工具共用 `files.enabled`。OfficeCLI 缺失时整组不注册；
        // 只读档只保留 safe 工具（read/help/render）。
        if (deps.officeAvailable?.() !== false) {
          for (const tool of createOfficeTools({ office: deps.office, readTracker })) {
            if (readonly && tool.sensitivity === 'confirm') continue
            deps.tools.register(tool)
          }
        }
      }

      // 搜索工具（grep / glob，docs/06 §11.5）**在只读档保留**：两者只读文件内容与目录名，
      // 不落盘、不起进程 —— 正是只读档该留下的能力。默认搜索根与 `run_command` 的缺省 cwd
      // 是同一个**按会话解析**的生效工作目录（上面回落链的产物：配了项目即项目根）。
      if (cfg.search.enabled) {
        for (const tool of createSearchTools({
          files: deps.files,
          maxResults: cfg.search.maxResults,
          defaultRoot: (sessionId) => deps.sessionWorkspaceDir(sessionId),
        })) {
          deps.tools.register(tool)
        }
      }

      // 打开类工具（`open_path`）**在只读档跳过**：它让系统用默认程序打开文件 / 目录 / URL
      // （可能拉起浏览器下载、启动外部程序），有系统副作用。
      if (cfg.open.enabled && !readonly) {
        deps.tools.register(createOpenTool({ open: deps.open }))
      }

      const names = toolNames.filter((name) => deps.tools.get(name) !== undefined)
      // `mode` 一并落日志：排查「为什么 write_file 不在表里」时第一眼就能看出是档位摘的，
      // 还是子开关关的。`workspaceDir` 是无会话上下文的全局链取值，排查「命令到底
      // 跑在哪个目录」时以此做基线（真实执行按会话即时解析）。
      deps.logger.info('已同步电脑操控工具', {
        names,
        workspaceDir,
        mode,
      })
      return names
    },
  }
}

export interface SettingsToolDeps {
  tools: ToolRegistry
  port: SettingsToolPort
  logger: Logger
}

export interface SettingsToolRegistry {
  /** 按当前配置重建工具表，返回本次注册的工具名 */
  sync(): string[]
}

/** 本装配器负责的工具名集合：注册 / 摘除 / smoke 断言共用，避免多处各写一份字符串。 */
export const SETTINGS_TOOL_NAMES = ['set_setting', APPEARANCE_TOOL_NAME] as const

/**
 * 配置类工具装配器（docs/06 §12）：`set_setting` + `set_appearance`。
 *
 * 与 `registerComputerTools` 的关键差别：**不受 `agent.tools.enabled` 影响**。
 * 原因有两层：
 * 1. 这两个都不在 `COMPUTER_TOOL_NAMES` 里，`registerComputerTools.sync()` 只按那 5 个
 *    名字摘除，两者天然互不干扰；
 * 2. 这恰恰是安全边界的一部分——总开关关掉后 AI 仍能改回 `agent.tools.*`，
 *    但改不回别的（`llm.providers` 等本来就在黑名单里）。
 *
 * 即便 `advanced.readonlyPrefixes` 被用户清空，这里**依然注册**：
 * 黑名单为空 ≠ 全部可写，`canWriteSettingPath` 的「Schema 必须识别该路径」永远生效。
 *
 * `set_appearance`（v32）与 `set_setting` 同处一个 sync：两者共用同一个 `SettingsToolPort`，
 * 注册 / 摘除时机天然一致；区别只在参数形状与 sensitivity（外观是 `safe`，见 docs/06 §12.1）。
 */
export function registerSettingsTool(deps: SettingsToolDeps): SettingsToolRegistry {
  return {
    sync(): string[] {
      // 先摘再注册（幂等）：工具实例按每次调用即时读配置，重建很便宜，
      // 且能保证"上一次注册的实例不会因为配置改变而留下旧闭包"。
      for (const name of SETTINGS_TOOL_NAMES) deps.tools.unregister(name)
      deps.tools.register(createSettingsTool({ port: deps.port, logger: deps.logger }))
      deps.tools.register(createAppearanceTool({ port: deps.port, logger: deps.logger }))
      const names = SETTINGS_TOOL_NAMES.filter((name) => deps.tools.get(name) !== undefined)
      deps.logger.info('已同步配置类工具', { names: [...names] })
      return [...names]
    },
  }
}

/** 扩展工具的固定名字集合：注册 / 摘除 / 文档共用，避免多处各写一份字符串。 */
export const EXTENSION_TOOL_NAMES = [
  'web_fetch',
  'clipboard_read',
  'clipboard_write',
  'notify_user',
  'notify_banner',
  'generate_image',
  'show_preview',
  'show_image',
] as const

export interface ExtensionToolsDeps {
  tools: ToolRegistry
  logger: Logger
  /** 网页抓取端口（`web_fetch`，main/tools/web-fetch.ts 的 netFetch 实现） */
  webFetch: WebFetchPort
  /** 剪贴板端口（`clipboard_read` / `clipboard_write`，main/tools/clipboard.ts） */
  clipboard: ClipboardPort
  /** 系统通知端口（`notify_user`，main/tools/notify.ts → NotificationService） */
  notify: NotifyPort
  /** 流光提醒端口（`notify_banner`，main/tools/banner-notify.ts → BannerService） */
  banner: BannerNotifyPort
  /** 生图端口（`generate_image`，main/tools/imagegen-port.ts → ImageGenService） */
  imageGen: ImageGenPort
  /** 对话图片端口（`show_image`，main/tools/image-display-port.ts） */
  imageDisplay: ImageDisplayPort
  /** 右栏展示端口（`show_preview`，main/tools/preview-port.ts → 推送到 chat 窗口） */
  preview: PreviewPort
}

export interface ExtensionToolsRegistry {
  /** 重建扩展工具表，返回本次注册的工具名 */
  sync(): string[]
}

/**
 * 扩展工具装配器（Design/betav2-spec.md §6.2、docs/06 §14）。
 *
 * 与 `registerSettingsTool` 同级：**不受 `agent.tools.enabled` 门控**——
 * 它们不在 `COMPUTER_TOOL_NAMES` 里，且「看网页 / 收通知 / 生图 / 展示成果」不属于
 * 「电脑操控」的开关语义；其中会碰隐私或花钱的
 * （`clipboard_read` / `clipboard_write` / `generate_image`）由工具自身的
 * `sensitivity: 'confirm'` 逐次过用户确认。
 *
 * `notify_banner`（2026-10-24）与 `notify_user` 同级、同为 `safe`：它只是把一条提醒
 * 显示在屏幕顶端（流光 + 置顶卡片），不碰文件与系统状态，去重 / 排队都在 `BannerService` 里。
 *
 * `show_preview`（2026-10-03）是这一族里唯一**推事件给渲染层**的：本地文件目标
 * 必须落在会话边界根之内（校验在 `preview-port.ts`），推送通道走 `preview:show`。
 */
export function registerExtensionTools(deps: ExtensionToolsDeps): ExtensionToolsRegistry {
  return {
    sync(): string[] {
      // 先全量摘掉再重建（幂等），与电脑操控工具同一套时序约定
      for (const name of EXTENSION_TOOL_NAMES) deps.tools.unregister(name)

      deps.tools.register(
        createWebFetchTool({
          port: deps.webFetch,
        }),
      )
      for (const tool of createClipboardTools({ port: deps.clipboard })) {
        deps.tools.register(tool)
      }
      deps.tools.register(createNotifyTool({ port: deps.notify }))
      deps.tools.register(createBannerNotifyTool({ port: deps.banner }))
      deps.tools.register(createImageGenTool({ port: deps.imageGen }))
      deps.tools.register(createShowPreviewTool({ port: deps.preview }))
      deps.tools.register(createShowImageTool({ port: deps.imageDisplay }))

      const names = EXTENSION_TOOL_NAMES.filter((name) => deps.tools.get(name) !== undefined)
      deps.logger.info('已同步扩展工具', { names: [...names] })
      return [...names]
    },
  }
}

/** 图像工具的固定名字集合：注册 / 摘除 / smoke 断言 / 文档共用，避免多处各写一份字符串。 */
export const IMAGE_TOOL_NAMES = ['view_image', 'screenshot', 'clipboard_read_image'] as const

export interface ImageToolsDeps {
  tools: ToolRegistry
  logger: Logger
  /**
   * 当前生效模型是否支持**图片输入**（live getter，唯一判据在 `main/vision.ts`）。
   *
   * 为什么是 getter 而不是布尔值：它与 `registerComputerTools` 的开关一样必须**现读** ——
   * `sync()` 在启动与每次 `settings:changed` 时被调用，用户在对话窗的模型下拉里换个模型
   * （写 `llm.providers.<active>.model`）就走这条链，下一次请求的工具表即随之变化，无需重启。
   */
  visionEnabled: () => boolean
  /** 看图端口（`view_image`，`tools/image-read-port.ts` → 项目根边界 + app 自有目录白名单） */
  viewImage: ViewImagePort
  /** 截屏端口（`screenshot`，`tools/screenshot-port.ts` → Electron desktopCapturer） */
  screenshot: ScreenshotPort
  /** 剪贴板图片端口（`clipboard_read_image`，`tools/clipboard.ts` → Electron clipboard） */
  clipboardImage: ClipboardImagePort
}

export interface ImageToolsRegistry {
  /** 重建图像工具表，返回本次注册的工具名 */
  sync(): string[]
}

/**
 * 图像工具装配器（看图 / 截屏 / 读剪贴板图片，docs/06 §25）。
 *
 * 门控口径与其它装配器都不同：**按模型能力注册**。当前生效模型的
 * `llm.providers.<id>.modelParams.<模型 id>.vision` 关着时，三个工具一个都不注册 ——
 * 模型在系统提示词的「## 可用工具」里看不到它们，请求体的 `tools` 数组里也没有，
 * 调用会回填「工具不存在」。这与 ClassIsland / Center 工具的「按可用性注册」同款，
 * 而**不是**「注册好、调用时再拒绝」：把看不懂图的工具摆在模型面前，只会诱使它先答应
 * 用户「我看看」、再在调用时失败。
 *
 * 它与图片附件管线共用**同一份判据**（`main/vision.ts`）：附件降级而工具照给，
 * 或反过来，都是自相矛盾的组合。
 *
 * 不受 `agent.tools.enabled` 门控（与扩展工具七件套同口径：「看图」不属于电脑操控的开关语义），
 * 也不按 `readonly` 档摘除（`view_image` 纯读；截屏与剪贴板读写的都是 app 自己的目录）。
 */
export function registerImageTools(deps: ImageToolsDeps): ImageToolsRegistry {
  return {
    sync(): string[] {
      // 先全量摘掉再重建（幂等），与其它装配器同一套时序约定
      for (const name of IMAGE_TOOL_NAMES) deps.tools.unregister(name)

      if (!deps.visionEnabled()) {
        deps.logger.debug('当前模型未开启图片输入：图像工具不注册', {
          names: [...IMAGE_TOOL_NAMES],
        })
        return []
      }

      deps.tools.register(createViewImageTool({ port: deps.viewImage }))
      deps.tools.register(createScreenshotTool({ port: deps.screenshot }))
      deps.tools.register(createClipboardImageTool({ port: deps.clipboardImage }))

      const names = IMAGE_TOOL_NAMES.filter((name) => deps.tools.get(name) !== undefined)
      deps.logger.info('已同步图像工具', { names: [...names] })
      return [...names]
    },
  }
}

/**
 * Agent 内核自带工具的固定名字集合：注册 / 摘除 / 文档共用，避免多处各写一份字符串。
 */
export const AGENT_CORE_TOOL_NAMES = ['todo_write', 'todo_read', 'task', 'ask_user'] as const

export interface AgentCoreToolsDeps {
  tools: ToolRegistry
  logger: Logger
  /** 任务清单端口（`todo_write` / `todo_read` 的按会话落盘实现，main/tools/todo-port.ts） */
  todoPort: TodoPort
  /**
   * 提问端口（`ask_user` 的卡片推送 + 等回执实现，`main/ask-user.ts`）。
   * 未注入时工具会如实回填「这里问不了人」（不静默失败），单测可直接构造装配器。
   */
  askUserPort?: AskUserPort
  /** provider 工厂：`task` 子代理按次即时构造；与 KernelAgentHost 共享同一实例（含启动自愈） */
  provider: AgentProviderFactory
  /**
   * 配置取值（live getter）。**只用来判定 `readonly` 档**该不该摘掉 `todo_write` ——
   * 本装配器不受 `agent.tools.enabled` 门控，因此不读 `agent.tools.*` 的任何子开关。
   *
   * 可选：不注入时按 `'confirm'` 档处理（= 三档权限之前的行为），单测可以直接构造装配器；
   * 生产接线（`main/index.ts`）**必须**注入，否则只读档摘不掉 todo_write（构造时会 warn）。
   */
  getSettings?: () => Settings
  /**
   * 父会话的敏感工具确认回调（live getter，2026-09）：`task` 子代理在
   * `permission: 'write'` 下用它把写入类工具的确认**交回同一条判定链**
   * （档位 / 项目根 / 免确认模式全在 `createConfirmTool` 里，内核不重复实现）。
   *
   * 为什么是 getter 而不是值：`registerAgentCoreTools` 的调用点在 `confirmTool` 赋值**之前**
   * （装配顺序如此），取值必须发生在工具执行时（远晚于构造），否则永远拿到 undefined。
   * 不注入 = 子代理一律只读：写入授权降级，并在工具结果里如实说明。
   */
  getConfirmTool?: () => ConfirmToolDecision | undefined
}

export interface AgentCoreToolsRegistry {
  /** 重建 Agent 内核自带工具表，返回本次注册的工具名 */
  sync(): string[]
}

/**
 * Agent 内核自带工具装配器（todo_write / todo_read / task，docs/06 §18/§19）。
 *
 * 与 `registerSettingsTool` / `registerExtensionTools` 同级：**不受
 * `agent.tools.enabled` 门控**——任务清单与子代理是 Agent 自身的工作能力，
 * 不属于「电脑操控」的开关语义；`task` 消耗模型调用但不碰系统，
 * 子代理的工具面在执行时从父表过滤（confirm 敏感工具 / task 自身 / mcp.*
 * 一律不可见，过滤逻辑在 agent-core 的 `tools/task.ts`，装配层只负责注册）。
 *
 * 唯一的例外是**只读档**：`todo_write` 的 `sensitivity` 虽是 `safe`，但它会往
 * `<userData>/todos/<sid>.json` 落盘 —— 档位叫「只读」就必须真的没有系统副作用，
 * 否则口号是假的。`todo_read` / `task` 不碰系统，照常注册。
 */
export function registerAgentCoreTools(deps: AgentCoreToolsDeps): AgentCoreToolsRegistry {
  if (deps.getSettings === undefined) {
    // 不给配置取值时 `currentPermissionMode` 按 confirm 档处理，于是只读档摘不掉 todo_write。
    // 这里 warn 一次（构造期，不是每次 sync）：生产接线漏注入时能在启动日志里立刻看见。
    deps.logger.warn('registerAgentCoreTools 未注入 getSettings：readonly 档不会摘掉 todo_write')
  }

  return {
    sync(): string[] {
      // 先全量摘掉再重建（幂等），与电脑操控 / 扩展工具同一套时序约定
      for (const name of AGENT_CORE_TOOL_NAMES) deps.tools.unregister(name)

      // 档位现读（live getter，绝不缓存）：先 confirm 后切 readonly 时，第二次 `sync()`
      // 就把 `todo_write` 摘掉，用户不必重启。
      const readonly = currentPermissionMode(deps.getSettings?.()) === 'readonly'

      for (const tool of createTodoTools({ port: deps.todoPort })) {
        // 只读档：摘 `todo_write`（落盘），留 `todo_read`（纯读文件）。
        // 名字比对用 agent-core 导出的常量，不手写字面量 —— 改名时由类型系统兜住。
        if (readonly && tool.name === TODO_WRITE_TOOL_NAME) continue
        deps.tools.register(tool)
      }
      // `task` 照常注册：它自己不碰系统（只派生一个上下文隔离的子代理），而且子代理的工具面
      // 是执行时从**父表**过滤出来的（agent-core `tools/task.ts`）——只读档下父表里本就没有
      // 写 / 执行类工具，子代理自然也拿不到。
      //
      // `permission: 'write'`（2026-09）不是新通道：写类工具进子表后仍由**同一个**确认回调
      // 逐次判定（档位 / 项目根 / 免确认模式），这里注入的只是"把确认交回那条链"的入口。
      deps.tools.register(
        createTaskTool({
          provider: deps.provider,
          tools: deps.tools,
          logger: deps.logger,
          ...(deps.getConfirmTool === undefined
            ? {}
            : {
                // 只做转发：`info.sessionId` 已由 `task` 工具钉成父会话 id（不是 `-sub`）
                confirmTool: async (info) => {
                  const decide = deps.getConfirmTool?.()
                  if (decide === undefined) return false
                  return decide(info)
                },
              }),
        }),
      )
      // `ask_user`（2026-09，docs/06 §21）：Agent 向用户提问并等回答。
      // 与 todo / task 同级**不受 `agent.tools.enabled` 门控**，也不按权限档摘除 ——
      // 提问没有系统副作用（不写盘、不执行命令），"危险"只是打扰用户，
      // 那由工具描述与「超时即继续」的语义约束。
      // 端口未注入时工具会明确回填「这里问不了人」，不会静默假装问过了。
      deps.tools.register(
        createAskUserTool({
          ...(deps.askUserPort === undefined ? {} : { port: deps.askUserPort }),
          logger: deps.logger,
        }),
      )

      const names = AGENT_CORE_TOOL_NAMES.filter((name) => deps.tools.get(name) !== undefined)
      deps.logger.info('已同步 Agent 内核工具', { names: [...names] })
      return [...names]
    },
  }
}

/**
 * `classisland_remind` 的固定名字：注册 / 摘除 / 文档共用，避免多处各写一份字符串。
 */
export const CLASSISLAND_TOOL_NAMES = [CLASSISLAND_REMIND_TOOL_NAME] as const

export interface ClassIslandToolsDeps {
  tools: ToolRegistry
  logger: Logger
  /** 提醒端口（`main/classisland.ts` 的 `ClassIslandNotifier` 适配） */
  port: ClassIslandNotifyPort
}

export interface ClassIslandToolsRegistry {
  /** 重建 ClassIsland 工具表，返回本次注册的工具名 */
  sync(): string[]
}

/**
 * `classisland_remind` 装配器（docs/05 §3.4 v3、docs/06 §14 同款口径）。
 *
 * 两条与既有装配器一致的约定：
 * - **不受 `agent.tools.enabled` 门控** —— 它不在 `COMPUTER_TOOL_NAMES` 里，
 *   且「发一条课表提醒」不属于「电脑操控」的开关语义（与 `notify_user` 同级）；
 * - **按可用性注册**（而不是无条件注册后让调用失败）：桥接未配置 / 未选 classisland 来源时
 *   把工具从表里摘掉 —— 模型看不到用不了的工具，就不会先承诺再报错。
 *   `sync()` 在启动与每次 `settings:changed` 时被调用，因此用户填完端点**无需重启**即可用。
 */
export function registerClassIslandTools(deps: ClassIslandToolsDeps): ClassIslandToolsRegistry {
  return {
    sync(): string[] {
      for (const name of CLASSISLAND_TOOL_NAMES) deps.tools.unregister(name)

      if (!deps.port.available()) {
        deps.logger.debug('ClassIsland 桥接未配置：classisland_remind 不注册')
        return []
      }

      deps.tools.register(createClassIslandRemindTool({ port: deps.port }))
      const names = CLASSISLAND_TOOL_NAMES.filter((name) => deps.tools.get(name) !== undefined)
      deps.logger.info('已同步 ClassIsland 工具', { names: [...names] })
      return [...names]
    },
  }
}

/**
 * Aurora Center 工具组（docs/12 §8、docs/06 §22.1）。
 *
 * 门控口径：`center.enabled` 且 `center.serverUrl` 非空**才注册**（未配置时连
 * 工具都不出现，与 STT/TTS 同口径）；**不受** `agent.tools.enabled` 门控
 * （与扩展工具七件套同口径）。`sync()` 每次重建实例：设置热改（开关 / 上限 /
 * 传输许可）立即生效，无需重启。
 */
export interface CenterToolsDeps {
  tools: ToolRegistry
  logger: Logger
  port: CenterPort
  /** 每次调用即时取值（sync 之外的工具执行期也用它判定） */
  config: () => {
    enabled: boolean
    serverUrl: string
    allowFileTransfer: boolean
    maxFileMb: number
  }
}

export const CENTER_TOOL_NAMES = ['center_status', 'center_send_file'] as const

export function registerCenterTools(deps: CenterToolsDeps): { sync(): string[] } {
  return {
    sync(): string[] {
      for (const name of CENTER_TOOL_NAMES) deps.tools.unregister(name)

      const config = deps.config()
      if (!config.enabled || config.serverUrl.trim() === '') {
        deps.logger.debug('Aurora Center 未启用：center_* 工具不注册')
        return []
      }
      const maxFileBytes = (): number => Math.max(1, deps.config().maxFileMb) * 1024 * 1024
      const options = {
        port: deps.port,
        maxFileBytes,
        fileTransferEnabled: () => deps.config().allowFileTransfer,
      }
      deps.tools.register(createCenterStatusTool(options))
      deps.tools.register(createCenterSendFileTool(options))
      const names = CENTER_TOOL_NAMES.filter((name) => deps.tools.get(name) !== undefined)
      deps.logger.info('已同步 Aurora Center 工具', { names: [...names] })
      return [...names]
    },
  }
}

/**
 * 自动化管理工具的名字集合（docs/13 §8）：注册 / 摘除 / 文档共用。
 */
export { AUTOMATION_TOOL_NAMES, AUTOMATION_WRITE_TOOL_NAMES }

export interface AutomationToolsDeps {
  tools: ToolRegistry
  logger: Logger
  /** 管理端口（`main/automation/engine.ts` 的 AutomationEngine 适配，main/index.ts 接线） */
  port: AutomationManagePort
  /**
   * 配置取值（live getter），只用来判定 `readonly` 档该不该摘掉写类工具 ——
   * 本装配器不受 `agent.tools.enabled` 门控（自动化是元数据管理，不是本机操控）。
   * 可选：不注入时按 `'confirm'` 档处理（单测可直接构造装配器）。
   */
  getSettings?: () => Settings
}

/**
 * 自动化管理工具装配器（automation_list / create / update / delete / run / history）。
 *
 * 与 `registerAgentCoreTools` 同级、同口径：不受 `agent.tools.enabled` 门控；
 * **只读档摘掉写类工具**（create / update / delete / run），保留 list / history ——
 * 档位叫「只读」就必须真的没有副作用。`create` / `update` / `delete` / `run` 自身是
 * `sensitivity: 'confirm'` 进入确认链，具体是否弹卡由权限档与项目边界决定。
 */
export function registerAutomationTools(deps: AutomationToolsDeps): { sync(): string[] } {
  if (deps.getSettings === undefined) {
    deps.logger.warn(
      'registerAutomationTools 未注入 getSettings：readonly 档不会摘掉写类自动化工具',
    )
  }
  return {
    sync(): string[] {
      for (const name of AUTOMATION_TOOL_NAMES) deps.tools.unregister(name)

      const readonly = currentPermissionMode(deps.getSettings?.()) === 'readonly'
      const writeNames: readonly string[] = AUTOMATION_WRITE_TOOL_NAMES
      for (const tool of createAutomationTools(deps.port)) {
        if (readonly && writeNames.includes(tool.name)) continue
        deps.tools.register(tool)
      }

      const names = AUTOMATION_TOOL_NAMES.filter((name) => deps.tools.get(name) !== undefined)
      deps.logger.info('已同步自动化工具', { names: [...names] })
      return [...names]
    },
  }
}

export interface AwarenessToolsDeps {
  tools: ToolRegistry
  logger: Logger
  port: AwarenessToolPort
  /** 仅在自感知启用、已授权且知识库可用时注册非状态工具。 */
  active: () => boolean
}

/**
 * 文件自感知只读工具装配器（docs/06 §26）。
 *
 * `awareness_status` 始终可见，便于 Agent 解释“为什么现在没有记忆能力”；
 * 其余三个会读取笔记内容，因此在功能未启用 / 未授权时从工具表摘除。
 */
export function registerAwarenessTools(deps: AwarenessToolsDeps): { sync(): string[] } {
  return {
    sync(): string[] {
      for (const name of AWARENESS_TOOL_NAMES) deps.tools.unregister(name)
      const all = createAwarenessTools(deps.port)
      const active = deps.active()
      for (const tool of all) {
        if (
          !active &&
          tool.name !== AWARENESS_STATUS_TOOL_NAME &&
          AWARENESS_ACTIVE_TOOL_NAMES.includes(
            tool.name as (typeof AWARENESS_ACTIVE_TOOL_NAMES)[number],
          )
        ) {
          continue
        }
        deps.tools.register(tool)
      }
      const names = AWARENESS_TOOL_NAMES.filter((name) => deps.tools.get(name) !== undefined)
      deps.logger.info('已同步文件自感知工具', { names: [...names] })
      return [...names]
    },
  }
}

export interface BrowserToolsDeps {
  tools: ToolRegistry
  logger: Logger
  /** 浏览器会话端口（`tools/browser-port.ts` → `browser-agent.ts`） */
  port: BrowserSessionPort
  /**
   * `agent.browser.enabled`（live getter）。关闭时**整组不注册**（模型看不到工具），
   * 同时由装配层调用 `onDisabled` 结束全部会话，避免留下 Agent 徽章与后台 webview。
   */
  enabled: () => boolean
  /** 当前生效权限档（live getter）：`readonly` 档整组摘除，与 `open_path` 同口径。 */
  permissionMode: () => PermissionMode
  /** 能力被关闭 / 降为只读时收掉所有会话（幂等） */
  onDisabled: () => void
}

/**
 * 内置浏览器工具装配器（v35，docs/06 §27）。
 *
 * 与 `registerExtensionTools` 同级：**不受 `agent.tools.enabled` 门控** —— 它不是
 * 「电脑操控」（不碰文件 / 进程 / 配置），而是一组独立的网页测试能力，由
 * `agent.browser.enabled` 自己控制。`readonly` 档整组不注册：直接在外部网页上
 * 点击输入属于有外部副作用的动作，与 `open_path` 的口径保持一致。
 */
export function registerBrowserTools(deps: BrowserToolsDeps): { sync(): string[] } {
  return {
    sync(): string[] {
      for (const name of BROWSER_TOOL_NAMES) deps.tools.unregister(name)

      if (!deps.enabled() || deps.permissionMode() === 'readonly') {
        deps.onDisabled()
        deps.logger.debug('内置浏览器工具不注册（开关关闭或只读档）', {
          names: [...BROWSER_TOOL_NAMES],
        })
        return []
      }

      for (const tool of createBrowserTools({ port: deps.port })) deps.tools.register(tool)
      const names = BROWSER_TOOL_NAMES.filter((name) => deps.tools.get(name) !== undefined)
      deps.logger.info('已同步内置浏览器工具', { names: [...names] })
      return [...names]
    },
  }
}
