'use strict'
/* global module */

/**
 * Hello Aurora 示例插件（docs/15）。
 *
 * 清单优先：工具 / Skill / 命令 / 自动化动作与事件 / 配置字段都在 manifest.json 里声明，
 * 本文件只提供处理器。插件运行在独立 utilityProcess 中，通过 `ctx` 使用宿主的白名单 API；
 * 未声明的权限在宿主侧直接拒绝。
 */

module.exports = {
  /** @param {import('./types/aurora-plugin').PluginContext} ctx */
  async activate(ctx) {
    const greeting = typeof ctx.config.greeting === 'string' ? ctx.config.greeting : '你好'
    ctx.log('info', 'hello-aurora 已激活', {
      plugin: ctx.plugin.id,
      greeting,
    })
  },

  async deactivate() {
    // 进程即将退出：这里只适合做同步收尾（落盘走 ctx.storage）。
  },

  /**
   * @param {string} name
   * @param {Record<string, unknown>} input
   */
  async invokeTool(name, input) {
    if (name !== 'echo') {
      return { content: `未知工具：${name}`, isError: true }
    }
    const text = typeof input.text === 'string' ? input.text : ''
    return {
      content: `Echo: ${text}`,
      summary: `回显 ${text.length} 个字符`,
    }
  },

  /**
   * @param {string} name
   * @param {string} args
   * @param {import('./types/aurora-plugin').PluginContext} ctx
   */
  async invokeCommand(name, args, ctx) {
    if (name === 'hello') {
      const extra = args.trim() === '' ? '（无补充）' : args.trim()
      return {
        prompt: `请用一句简短的话向用户打招呼。用户的补充要求：${extra}`,
      }
    }
    if (name === 'hello-count') {
      const count = await increment(ctx)
      // 触发清单里声明的自动化事件；没有匹配的自动化时宿主直接丢弃。
      await ctx.emitEvent('count-changed', { count })
      return { summary: `Hello Aurora 已执行 ${count} 次` }
    }
    if (name === 'hello-push') {
      const count = await increment(ctx)
      await pushAll(ctx, count)
      return { summary: `已推送刷新（计数 ${count}）` }
    }
    if (name === 'hello-usage') {
      // 本机用量统计（docs/15 §4.1.2）：只读聚合，不含任何内容或凭据。
      const stats = await ctx.usage.summary({ days: 7 })
      return {
        summary:
          `最近 ${stats.days} 天：Token ${stats.tokens.totalTokens}（缓存命中 ${stats.tokens.cachedTokens}）` +
          ` / 生图 ${stats.images.generated} 次 / 语音 ${stats.voice.tts + stats.voice.stt} 次`,
      }
    }
    throw new Error(`未知命令：${name}`)
  },

  /**
   * 自动化动作（清单 contributes.automation.actions）。
   *
   * @param {string} name
   * @param {Record<string, unknown>} params
   * @param {import('./types/aurora-plugin').PluginContext} ctx
   */
  async invokeAutomationAction(name, params, ctx) {
    if (name !== 'add-count') {
      throw new Error(`未知自动化动作：${name}`)
    }
    const count = await increment(ctx)
    await ctx.emitEvent('count-changed', { count })
    if (ctx.config.notifyOnCount === true) {
      const greeting = typeof ctx.config.greeting === 'string' ? ctx.config.greeting : '你好'
      await ctx.notify({ title: 'Hello Aurora', body: `${greeting}：计数更新为 ${count}` })
    }
    return { summary: `插件计数已更新为 ${count}` }
  },

  /**
   * 右栏面板（docs/14 §3.4）：`board` 是声明式 schema，`info` 是沙箱页面。
   * 页面型面板的返回值会原样交给页面（`data` 字段），声明式面板只认 schema / toast。
   *
   * @param {string} panelId
   * @param {string} method
   * @param {unknown} params
   * @param {import('./types/aurora-plugin').PluginContext} ctx
   */
  async invokePanel(panelId, method, params, ctx) {
    const count = await currentCount(ctx)
    if (panelId === 'board') {
      if (method === 'bump') {
        const next = await increment(ctx)
        await pushAll(ctx, next)
        return { schema: boardSchema(next), toast: `计数更新为 ${next}` }
      }
      return { schema: boardSchema(count) }
    }
    if (panelId === 'info') {
      if (method === 'toast') {
        await ctx.ui.toast('来自插件页面的问候')
        return {}
      }
      return { data: { count, greeting: ctx.config.greeting ?? '你好' } }
    }
    throw new Error(`未知面板：${panelId}`)
  },

  /**
   * 桌面 / 提示条小组件（docs/14 §5.3、§5.4）：与面板同一套声明式 schema。
   *
   * @param {string} widgetId
   * @param {string} method
   * @param {unknown} params
   * @param {import('./types/aurora-plugin').PluginContext} ctx
   */
  async invokeWidget(widgetId, method, params, ctx) {
    if (widgetId !== 'duty-week' && widgetId !== 'todo-strip') {
      throw new Error(`未知小组件：${widgetId}`)
    }
    if (method === 'bump') {
      const next = await increment(ctx)
      await pushAll(ctx, next)
      return { schema: widgetSchema(widgetId, next), toast: `计数更新为 ${next}` }
    }
    return { schema: widgetSchema(widgetId, await currentCount(ctx)) }
  },

  /**
   * 宿主事件（清单 `events` 声明后才投递）。
   *
   * @param {string} event
   * @param {unknown} payload
   * @param {import('./types/aurora-plugin').PluginContext} ctx
   */
  onEvent(event, payload, ctx) {
    ctx.log('debug', '收到宿主事件', { event, payload })
  },

  /**
   * 用户在设置页改插件配置。
   *
   * @param {Record<string, unknown>} config
   * @param {import('./types/aurora-plugin').PluginContext} ctx
   */
  onConfigChanged(config, ctx) {
    ctx.log('info', '插件配置已更新', { greeting: config.greeting })
  },
}

/**
 * 计数 +1 并落进插件私有存储（5 MB 配额、不需要用户目录权限）。
 *
 * @param {import('./types/aurora-plugin').PluginContext} ctx
 * @returns {Promise<number>}
 */
async function increment(ctx) {
  const previous = await ctx.storage.get('count')
  const count = (typeof previous === 'number' ? previous : 0) + 1
  await ctx.storage.set('count', count)
  return count
}

/**
 * @param {import('./types/aurora-plugin').PluginContext} ctx
 * @returns {Promise<number>}
 */
async function currentCount(ctx) {
  const previous = await ctx.storage.get('count')
  return typeof previous === 'number' ? previous : 0
}

/**
 * 向所有已打开的声明式面板与小组件推送一次计数事件（无需用户点刷新）。
 *
 * 宿主会校验目标确实在本插件清单里；没打开的窗口收不到也无副作用。
 *
 * @param {import('./types/aurora-plugin').PluginContext} ctx
 * @param {number} count
 */
async function pushAll(ctx, count) {
  const payload = { count }
  for (const panelId of ['board']) {
    await ctx.ui.panelEvent({ panelId, event: 'count-changed', payload })
  }
  for (const widgetId of ['duty-week', 'todo-strip']) {
    await ctx.ui.panelEvent({ widgetId, event: 'count-changed', payload })
  }
}

/**
 * 声明式面板 schema（`PluginUiNode[]`，docs/15 §6）。
 *
 * @param {number} count
 */
function boardSchema(count) {
  return {
    version: 1,
    nodes: [
      { type: 'heading', text: 'Hello Aurora' },
      {
        type: 'text',
        text: '这是一个声明式面板：没有 HTML、没有脚本，只有受控组件。',
        tone: 'muted',
      },
      {
        type: 'keyValue',
        items: [
          { label: '计数', value: String(count) },
          { label: '来源', value: '插件存储' },
        ],
      },
      {
        type: 'button',
        text: '计数 +1',
        action: { method: 'bump', toast: '已更新' },
      },
    ],
  }
}

/**
 * 小组件 schema：桌面卡片与提示条条目共用同一套受控组件。
 *
 * @param {'duty-week' | 'todo-strip'} widgetId
 * @param {number} count
 */
function widgetSchema(widgetId, count) {
  if (widgetId === 'todo-strip') {
    return {
      version: 1,
      nodes: [
        {
          type: 'row',
          children: [
            { type: 'badge', text: '事务', tone: 'muted' },
            { type: 'badge', text: '数学作业', tone: 'ok' },
            { type: 'badge', text: '值日', tone: 'warn' },
          ],
        },
        {
          type: 'keyValue',
          items: [{ label: '计数', value: String(count) }],
        },
        {
          type: 'button',
          text: '计数 +1',
          action: { method: 'bump', toast: '已更新' },
        },
      ],
    }
  }
  return {
    version: 1,
    nodes: [
      {
        type: 'keyValue',
        items: [
          { label: '今日', value: '数学 · 物理' },
          { label: '计数', value: String(count) },
        ],
      },
      {
        type: 'button',
        text: '完成一项',
        action: { method: 'bump', toast: '已更新' },
      },
    ],
  }
}
