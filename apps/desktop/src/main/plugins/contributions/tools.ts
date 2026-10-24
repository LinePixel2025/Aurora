/**
 * 插件工具装配器（docs/14 §3.1）：把清单声明的工具映射成内核 `ToolDefinition`。
 *
 * 口径：
 * - 工具名固定 `plugin.<id>.<name>`（清单已校验 ≤ 64 字符），天然与内置 / MCP 不撞名；
 * - **默认 `confirm`**：清单里的 `safe` 只在该插件被用户显式信任后才生效；
 * - 只读档只注册 `readonly: true` 的工具（与「只读档不注册写工具」同款口径）；
 * - 不受 `agent.tools.enabled` 门控（与扩展工具同组），只受 `plugins.enabled` 与插件自身开关约束。
 *
 * `sync()` 先按 `plugin.` 前缀全量摘除再重建：插件启停 / 信任变化 / 安装卸载都走同一条路。
 */
import { resolvePermissionMode, type Logger, type Settings } from '@aurora/shared'
import type { LlmToolParameterSchema, ToolDefinition, ToolRegistry } from '@aurora/agent-core'
import type { PluginManager, PluginToolContribution } from '../manager.js'

export interface PluginToolsDeps {
  tools: ToolRegistry
  manager: Pick<PluginManager, 'toolContributions' | 'invokeTool'>
  getSettings: () => Settings
  logger: Logger
}

export interface PluginToolsRegistry {
  sync(): string[]
}

function toToolDefinition(
  contribution: PluginToolContribution,
  manager: PluginToolsDeps['manager'],
): ToolDefinition {
  return {
    name: contribution.fullName,
    description: contribution.description,
    parameters: contribution.parameters as unknown as LlmToolParameterSchema,
    sensitivity: contribution.sensitivity,
    execute: async (input, ctx) => {
      try {
        const result = await manager.invokeTool(
          contribution.pluginId,
          contribution.name,
          input,
          ctx.signal,
        )
        return result
      } catch (error) {
        // 插件失败按工具错误回填：模型能读到原因并改走别的路，而不是整轮中断。
        const code =
          typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code
            : 'E_PLUGIN_TOOL_FAILED'
        const message = error instanceof Error ? error.message : String(error)
        return { content: `插件工具执行失败（${code}）：${message}`, isError: true }
      }
    },
  }
}

export function registerPluginTools(deps: PluginToolsDeps): PluginToolsRegistry {
  return {
    sync(): string[] {
      deps.tools.unregisterByPrefix('plugin.')

      const settings = deps.getSettings()
      if (!settings.plugins.enabled) {
        deps.logger.debug('插件总开关已关闭：插件工具不注册')
        return []
      }

      const readonly = resolvePermissionMode(settings) === 'readonly'
      const names: string[] = []
      for (const contribution of deps.manager.toolContributions()) {
        if (readonly && !contribution.readonly) continue
        deps.tools.register(toToolDefinition(contribution, deps.manager), 'plugin')
        names.push(contribution.fullName)
      }
      deps.logger.info('已同步插件工具', { names, mode: readonly ? 'readonly' : 'normal' })
      return names
    },
  }
}
