/**
 * 电脑操控工具装配器（docs/06 §11、step 5）。
 *
 * 职责边界：本文件**不 import electron**，只做「按配置把工具注册进工具表」这一件事，
 * 因此可以在 Node 环境里完整单测。真实系统调用（进程 / 文件系统 / shell）全部由
 * `command-runner.ts` / `file-port.ts` / `open-port.ts` 通过构造参数注入。
 *
 * `sync()` 是**唯一**的开关落地点：启动时调一次，`settings:changed` 时再调一次，
 * 于是「改开关 / 改上限」立即生效（下一次请求的系统提示词就会看到新的工具表），无需重启。
 * 每次都用当前配置**重建**工具实例（构造很便宜），所以 cwd / 超时 / 上限也能热改。
 */
import { COMPUTER_TOOL_NAMES, type Logger, type Settings } from '@aurora/shared'
import {
  createFileTools,
  createOpenTool,
  createSettingsTool,
  createTerminalTool,
  type CommandRunner,
  type FilePort,
  type OpenPort,
  type SettingsToolPort,
  type ToolRegistry,
} from '@aurora/agent-core'

export interface ComputerToolsDeps {
  tools: ToolRegistry
  getSettings: () => Settings
  logger: Logger
  /** 用户主目录（`agent.tools.workspaceDir` 为空串时的默认工作目录） */
  homeDir: () => string
  run: CommandRunner
  files: FilePort
  open: OpenPort
  /** `set_setting`（docs/06 §12）的真实读写端口；与 `getSettings` 是两码事 */
  settingsPort: SettingsToolPort
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
