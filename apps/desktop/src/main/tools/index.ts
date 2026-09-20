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
  createTerminalTool,
  type CommandRunner,
  type FilePort,
  type OpenPort,
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
