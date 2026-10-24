'use strict'
/* global module */

/**
 * 最小插件模板（docs/15）。
 *
 * 清单优先：工具 / Skill / 命令都在 manifest.json 里声明，本文件只提供处理器。
 * `ctx` 是宿主注入的白名单 API（存储 / 网络 / 通知 / 配置 / 事件 / UI），
 * 未在清单里声明的权限会在宿主侧被拒绝。
 */

module.exports = {
  /** @param {import('./types/aurora-plugin').PluginContext} ctx */
  async activate(ctx) {
    ctx.log('info', 'hello 插件已激活', { plugin: ctx.plugin.id })
  },

  /**
   * @param {string} name 清单里的工具名（不含 `plugin.<id>.` 前缀）
   * @param {Record<string, unknown>} input 模型给出的参数
   * @param {import('./types/aurora-plugin').PluginContext} ctx
   */
  async invokeTool(name, input, ctx) {
    if (name !== 'ping') {
      throw new Error(`未知工具：${name}`)
    }
    const text = typeof input.text === 'string' ? input.text : ''
    ctx.log('debug', 'ping 被调用', { text })
    return {
      content: `pong${text === '' ? '' : `: ${text}`}`,
      summary: '已响应 ping',
    }
  },
}
