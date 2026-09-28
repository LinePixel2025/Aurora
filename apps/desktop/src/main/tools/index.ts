/**
 * 工具装配器合集（docs/06 §11、§12、§14、§18/§19）。
 *
 * 职责边界：本文件**不 import electron**，只做「把工具注册进工具表」这一件事，
 * 因此可以在 Node 环境里完整单测。真实系统调用（进程 / 文件系统 / shell）全部由
 * `command-runner.ts` / `file-port.ts` / `open-port.ts` 通过构造参数注入。
 * （`clipboard.ts` 是唯一的例外：它实现 Electron `clipboard` 端口，必须 import electron，
 * 因此不进本文件的依赖 —— 由 `main/index.ts` 直接构造后注入。）
 *
 * 本文件现有四个装配器：
 * - `registerComputerTools`：电脑操控工具（8 个，含 `grep` / `glob`），受 `agent.tools.enabled` 门控
 *   （docs/06 §11）；
 * - `registerSettingsTool`：`set_setting`，不受门控（docs/06 §12）；
 * - `registerExtensionTools`：扩展工具五件套，不受门控（docs/06 §14）；
 * - `registerAgentCoreTools`：todo_write / todo_read / task，不受门控（docs/06 §18/§19）
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
  createClipboardTools,
  createEditTool,
  createFileTools,
  createImageGenTool,
  createNotifyTool,
  createOpenTool,
  createSearchTools,
  createSettingsTool,
  createTaskTool,
  createTerminalTool,
  createTodoTools,
  createWebFetchTool,
  TODO_WRITE_TOOL_NAME,
  createCenterSendFileTool,
  createCenterStatusTool,
  type AgentProviderFactory,
  type CenterPort,
  type ClipboardPort,
  type CommandRunner,
  type FilePort,
  type ImageGenPort,
  type NotifyPort,
  type OpenPort,
  type ReadTracker,
  type SettingsToolPort,
  type TodoPort,
  type ToolRegistry,
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
   * 全局当前项目根（`resolveProject().root`，无项目时 undefined）。
   * 会话级项目（v17）引入后它退居**回落位**：会话绑定项目失效 / 未绑定时才用
   * （回落链由 `sessionWorkspaceDir` 与端口 guard 内部承担，见 `session-project.ts`）。
   * 保留它主要是给 `sync()` 的日志与「无会话上下文」场景一个明确的取值源。
   */
  projectRoot: () => string | undefined
  /**
   * 按会话解析**生效工作目录**（docs/06 §5.1 唯一口径，`session-project.ts` 的实现）：
   * 会话绑定项目 > 全局当前项目 > `agent.tools.workspaceDir` > `homeDir`。
   *
   * 为什么是按会话的取值器而不是 sync() 里算好的字符串：工具执行时才知道 `ctx.sessionId`，
   * 而两个会话可以绑定不同项目 —— 缺省 cwd / 搜索根必须**每次执行即时解析**
   * （与 `agent.loop` 上限的 getter 注入同款套路，杜绝「改绑定要重启」的死值）。
   * `sessionId` 传 `undefined` 时按全局回落链解析（sync() 的日志用它）。
   */
  sessionWorkspaceDir: (sessionId: string | undefined) => string
  run: CommandRunner
  files: FilePort
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
      // 先全量摘掉全部 8 个名字（含上一次注册、以及被关掉的分支），再按当前配置重建。
      // 不存在的名字 `unregister` 返回 false，忽略即可。
      for (const name of toolNames) deps.tools.unregister(name)

      // 档位与配置**每次现读**（live getter）：`sync()` 是启动一次 + 每次 `settings:changed`
      // 一次，所以改档位 / 改开关后下一次请求的工具表就变了，无需重启。
      const settings = deps.getSettings()
      const mode = currentPermissionMode(settings)
      const readonly = mode === 'readonly'

      const cfg = settings.agent.tools
      if (!cfg.enabled) {
        // 既有第一条分支，**优先级高于档位**：总开关关掉时 8 个工具一个都不注册，
        // 与档位是 readonly 还是 auto 无关（本来就关得更彻底，不必再看档位）。
        deps.logger.info('电脑操控工具总开关已关闭：全部工具都不注册', {
          names: [...toolNames],
        })
        return []
      }

      // 缺省工作目录 / 搜索根的**唯一口径**（docs/06 §5.1）：回落链
      // 会话绑定项目 > 当前项目根 > `agent.tools.workspaceDir` > 用户主目录。
      // sync() 在启动 / `settings:changed` 时只取一次**全局链**（无会话上下文）做日志；
      // 工具实例里的缺省值是**按会话的取值器**（`sessionWorkspaceDir`），每次执行即时解析 ——
      // 两个会话绑定了不同项目时各用各的根，改绑定无需重建工具。
      const projectRoot = deps.projectRoot()
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
      // 还是子开关关的。`projectRoot` 也落进来：排查「命令到底跑在哪个目录」时，
      // 三级回落里最高优先级的输入一眼可辨（空串 = 无项目）。
      deps.logger.info('已同步电脑操控工具', {
        names,
        workspaceDir,
        projectRoot: projectRoot ?? '',
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

/** `set_setting` 的固定名字：注册 / 摘除 / smoke 断言共用，避免三处各写一份字符串。 */
const SETTINGS_TOOL_NAME = 'set_setting'

/**
 * `set_setting` 装配器（docs/06 §12）。
 *
 * 与 `registerComputerTools` 的关键差别：**不受 `agent.tools.enabled` 影响**。
 * 原因有两层：
 * 1. `set_setting` 不在 `COMPUTER_TOOL_NAMES` 里，`registerComputerTools.sync()` 只按那 5 个
 *    名字摘除，两者天然互不干扰；
 * 2. 这恰恰是安全边界的一部分——总开关关掉后 AI 仍能改回 `agent.tools.*`，
 *    但改不回别的（`llm.providers` 等本来就在黑名单里）。
 *
 * 即便 `advanced.readonlyPrefixes` 被用户清空，这里**依然注册**：
 * 黑名单为空 ≠ 全部可写，`canWriteSettingPath` 的「Schema 必须识别该路径」永远生效。
 */
export function registerSettingsTool(deps: SettingsToolDeps): SettingsToolRegistry {
  return {
    sync(): string[] {
      // 先摘再注册（幂等）：工具实例按每次调用即时读配置，重建很便宜，
      // 且能保证"上一次注册的实例不会因为配置改变而留下旧闭包"。
      deps.tools.unregister(SETTINGS_TOOL_NAME)
      deps.tools.register(createSettingsTool({ port: deps.port, logger: deps.logger }))
      deps.logger.info('已同步 set_setting 工具', { name: SETTINGS_TOOL_NAME })
      return [SETTINGS_TOOL_NAME]
    },
  }
}

/** 扩展工具的固定名字集合：注册 / 摘除 / 文档共用，避免多处各写一份字符串。 */
export const EXTENSION_TOOL_NAMES = [
  'web_fetch',
  'clipboard_read',
  'clipboard_write',
  'notify_user',
  'generate_image',
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
  /** 生图端口（`generate_image`，main/tools/imagegen-port.ts → ImageGenService） */
  imageGen: ImageGenPort
}

export interface ExtensionToolsRegistry {
  /** 重建扩展工具表，返回本次注册的工具名 */
  sync(): string[]
}

/**
 * 扩展工具五件套装配器（Design/betav2-spec.md §6.2、docs/06 §14）。
 *
 * 与 `registerSettingsTool` 同级：**不受 `agent.tools.enabled` 门控**——
 * 它们不在 `COMPUTER_TOOL_NAMES` 里，且「看网页 / 收通知 / 生图」不属于
 * 「电脑操控」的开关语义；其中会碰隐私或花钱的
 * （`clipboard_read` / `clipboard_write` / `generate_image`）由工具自身的
 * `sensitivity: 'confirm'` 逐次过用户确认。
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
      deps.tools.register(createImageGenTool({ port: deps.imageGen }))

      const names = EXTENSION_TOOL_NAMES.filter((name) => deps.tools.get(name) !== undefined)
      deps.logger.info('已同步扩展工具', { names: [...names] })
      return [...names]
    },
  }
}

/**
 * Agent 内核自带工具的固定名字集合：注册 / 摘除 / 文档共用，避免多处各写一份字符串。
 */
export const AGENT_CORE_TOOL_NAMES = ['todo_write', 'todo_read', 'task'] as const
export interface AgentCoreToolsDeps {
  tools: ToolRegistry
  logger: Logger
  /** 任务清单端口（`todo_write` / `todo_read` 的按会话落盘实现，main/tools/todo-port.ts） */
  todoPort: TodoPort
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
      deps.tools.register(
        createTaskTool({ provider: deps.provider, tools: deps.tools, logger: deps.logger }),
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
 * （与扩展工具五件套同口径）。`sync()` 每次重建实例：设置热改（开关 / 上限 /
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
 * `sensitivity: 'confirm'`（逐次确认），AI 想给自己排程后台动作必须用户点头。
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
