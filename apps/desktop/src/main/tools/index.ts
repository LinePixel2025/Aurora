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
 * - `registerComputerTools`：电脑操控五件套，受 `agent.tools.enabled` 门控（docs/06 §11）；
 * - `registerSettingsTool`：`set_setting`，不受门控（docs/06 §12）；
 * - `registerExtensionTools`：扩展工具五件套，不受门控（docs/06 §14）；
 * - `registerAgentCoreTools`：todo_write / todo_read / task，不受门控（docs/06 §18/§19）
 *   —— todo / task 是 Agent 自身的工作能力（维护任务清单、派生上下文隔离的子代理），
 *   不是「电脑操控」，与 set_setting / 扩展工具同级。
 *
 * `sync()` 是**唯一**的开关落地点：启动时调一次，`settings:changed` 时再调一次，
 * 于是「改开关 / 改上限」立即生效（下一次请求的系统提示词就会看到新的工具表），无需重启。
 * 每次都**重建**工具实例（构造很便宜），所以 cwd / 超时 / 上限也能热改。
 */
import { COMPUTER_TOOL_NAMES, type Logger, type Settings } from '@aurora/shared'
import {
  createClipboardTools,
  createFileTools,
  createImageGenTool,
  createNotifyTool,
  createOpenTool,
  createSettingsTool,
  createTaskTool,
  createTerminalTool,
  createTodoTools,
  createWebFetchTool,
  type AgentProviderFactory,
  type ClipboardPort,
  type CommandRunner,
  type FilePort,
  type ImageGenPort,
  type NotifyPort,
  type OpenPort,
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

export interface ComputerToolsDeps {
  tools: ToolRegistry
  getSettings: () => Settings
  logger: Logger
  /** 用户主目录（`agent.tools.workspaceDir` 为空串时的默认工作目录） */
  homeDir: () => string
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

  return {
    sync(): string[] {
      // 先全量摘掉这 5 个名字（含上一次注册、以及被关掉的分支），再按当前配置重建。
      // 不存在的名字 `unregister` 返回 false，忽略即可。
      for (const name of toolNames) deps.tools.unregister(name)

      const cfg = deps.getSettings().agent.tools
      if (!cfg.enabled) {
        deps.logger.info('电脑操控工具总开关已关闭：5 个工具全部不注册', {
          names: [...toolNames],
        })
        return []
      }

      const workspaceDir = cfg.workspaceDir.trim() === '' ? deps.homeDir() : cfg.workspaceDir.trim()

      if (cfg.terminal.enabled) {
        deps.tools.register(
          createTerminalTool({
            run: deps.run,
            timeoutMs: cfg.terminal.timeoutMs,
            maxOutputChars: cfg.terminal.maxOutputChars,
            defaultCwd: workspaceDir,
          }),
        )
      }

      if (cfg.files.enabled) {
        // 文件工具工厂返回 read_file / write_file / list_dir / open_path 四个；
        // 打开类工具受**独立开关**控制，因此这里按名字挑出前三个。
        for (const tool of createFileTools({
          files: deps.files,
          open: deps.open,
          maxReadBytes: cfg.files.maxReadBytes,
        })) {
          if (tool.name !== 'open_path') deps.tools.register(tool)
        }
      }

      if (cfg.open.enabled) {
        deps.tools.register(createOpenTool({ open: deps.open }))
      }

      const names = toolNames.filter((name) => deps.tools.get(name) !== undefined)
      deps.logger.info('已同步电脑操控工具', { names, workspaceDir })
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
 */
export function registerAgentCoreTools(deps: AgentCoreToolsDeps): AgentCoreToolsRegistry {
  return {
    sync(): string[] {
      // 先全量摘掉再重建（幂等），与电脑操控 / 扩展工具同一套时序约定
      for (const name of AGENT_CORE_TOOL_NAMES) deps.tools.unregister(name)

      for (const tool of createTodoTools({ port: deps.todoPort })) {
        deps.tools.register(tool)
      }
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
