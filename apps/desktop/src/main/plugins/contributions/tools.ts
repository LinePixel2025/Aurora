/**
 * 插件工具装配器（docs/14 §3.1 / §3.1.1）：把清单声明的工具映射成内核 `ToolDefinition`。
 *
 * 口径：
 * - 工具名固定 `plugin.<id>.<name>`（清单已校验 ≤ 64 字符），天然与内置 / MCP 不撞名；
 * - **默认 `confirm`**：清单里的 `safe` 只在该插件被用户显式信任后才生效；
 * - 只读档只注册 `readonly: true` 的工具（与「只读档不注册写工具」同款口径）；
 * - **全局上限 64**（`PLUGIN_TOOL_FACE_LIMIT`）：只读档过滤后按名字字典序截断，
 *   超出部分**不注册**（模型看不见、调不到），插件本身继续运行（docs/14 §3.1.1）；
 * - 不受 `agent.tools.enabled` 门控（与扩展工具同组），只受 `plugins.enabled` 与插件自身开关约束。
 *
 * `sync()` 先按 `plugin.` 前缀全量摘除再重建：插件启停 / 信任变化 / 安装卸载都走同一条路。
 */
import {
  PLUGIN_TOOL_FACE_LIMIT,
  resolvePermissionMode,
  type Logger,
  type Settings,
} from '@aurora/shared'
import type { LlmToolParameterSchema, ToolDefinition, ToolRegistry } from '@aurora/agent-core'
import type { PluginManager, PluginToolContribution } from '../manager.js'
import {
  emptyPluginToolFaceSnapshot,
  selectPluginTools,
  type PluginToolFaceSnapshot,
} from '../tool-face.js'

export interface PluginToolsDeps {
  tools: ToolRegistry
  manager: Pick<PluginManager, 'toolContributions' | 'invokeTool'>
  getSettings: () => Settings
  logger: Logger
}

export interface PluginToolsRegistry {
  sync(): PluginToolFaceSnapshot
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
  /** 上一次被截断的工具名（有序）：只在集合变化时 warn，避免设置变更触发 sync 时刷屏 */
  let lastSkippedKey = ''

  return {
    sync(): PluginToolFaceSnapshot {
      deps.tools.unregisterByPrefix('plugin.')

      const settings = deps.getSettings()
      if (!settings.plugins.enabled) {
        deps.logger.debug('插件总开关已关闭：插件工具不注册')
        lastSkippedKey = ''
        return emptyPluginToolFaceSnapshot()
      }

      const readonly = resolvePermissionMode(settings) === 'readonly'
      const { kept, skipped } = selectPluginTools(deps.manager.toolContributions(), {
        readonlyMode: readonly,
      })
      for (const contribution of kept) {
        deps.tools.register(toToolDefinition(contribution, deps.manager), 'plugin')
      }

      const snapshot: PluginToolFaceSnapshot = {
        registered: kept.map((item) => item.fullName),
        skipped: skipped.map((item) => item.fullName),
      }
      deps.logger.info('已同步插件工具', {
        registered: snapshot.registered.length,
        skipped: snapshot.skipped.length,
        limit: PLUGIN_TOOL_FACE_LIMIT,
        mode: readonly ? 'readonly' : 'normal',
      })
      const skippedKey = snapshot.skipped.join('\n')
      if (skippedKey !== '' && skippedKey !== lastSkippedKey) {
        deps.logger.warn('插件工具超过全局上限，已按名字截断', {
          limit: PLUGIN_TOOL_FACE_LIMIT,
          skipped: snapshot.skipped,
        })
      }
      lastSkippedKey = skippedKey
      return snapshot
    },
  }
}
