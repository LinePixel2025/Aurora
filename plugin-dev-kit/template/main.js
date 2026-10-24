'use strict'
/* global module */

/**
 * Aurora 插件模板（插件 API v1）。
 *
 * 演示：工具、声明式面板、桌面小组件、提示条小组件、事件推送。
 * 复制本目录后：改 manifest.json 的 id / name / version，再替换下面的处理器。
 */

const COUNT_KEY = 'count'

module.exports = {
  async activate(ctx) {
    ctx.log('info', '示例插件已激活', { plugin: ctx.plugin.id })
  },

  async invokeTool(name, input) {
    if (name !== 'echo') return { content: `未知工具：${name}`, isError: true }
    const text = typeof input.text === 'string' ? input.text : ''
    return { content: `Echo: ${text}`, summary: `回显 ${text.length} 个字符` }
  },

  async invokePanel(panelId, method, params, ctx) {
    if (panelId !== 'home') throw new Error(`未知面板：${panelId}`)
    if (method === 'bump') {
      const next = await bump(ctx)
      await pushAll(ctx)
      return { schema: panelSchema(ctx, next), toast: `计数更新为 ${next}` }
    }
    return { schema: panelSchema(ctx, await current(ctx)) }
  },

  async invokeWidget(widgetId, method, params, ctx) {
    if (widgetId !== 'card' && widgetId !== 'strip') {
      throw new Error(`未知小组件：${widgetId}`)
    }
    if (method === 'bump') {
      const next = await bump(ctx)
      await pushAll(ctx)
      return { schema: widgetSchema(widgetId, next), toast: `计数更新为 ${next}` }
    }
    return { schema: widgetSchema(widgetId, await current(ctx)) }
  },
}

/** 事件推送：只发给本插件声明过的目标，用户无需刷新。 */
async function pushAll(ctx) {
  await ctx.ui.panelEvent({ panelId: 'home', event: 'demo.changed' })
  await ctx.ui.panelEvent({ widgetId: 'card', event: 'demo.changed' })
  await ctx.ui.panelEvent({ widgetId: 'strip', event: 'demo.changed' })
}

function titleOf(config) {
  return typeof config.title === 'string' && config.title.trim() !== ''
    ? config.title.trim()
    : '我的插件'
}

async function current(ctx) {
  const value = await ctx.storage.get(COUNT_KEY)
  return typeof value === 'number' ? value : 0
}

async function bump(ctx) {
  const next = (await current(ctx)) + 1
  await ctx.storage.set(COUNT_KEY, next)
  return next
}

function panelSchema(ctx, count) {
  return {
    version: 1,
    nodes: [
      { type: 'heading', text: titleOf(ctx.config) },
      { type: 'text', text: '模板面板：受控组件，没有 HTML。', tone: 'muted' },
      { type: 'keyValue', items: [{ label: '计数', value: String(count) }] },
      { type: 'button', text: '计数 +1', action: { method: 'bump', toast: '已更新' } },
    ],
  }
}

function widgetSchema(widgetId, count) {
  if (widgetId === 'strip') {
    return {
      version: 1,
      nodes: [
        { type: 'badge', text: `计数 ${count}`, tone: count > 0 ? 'ok' : 'muted' },
        { type: 'button', text: '计数 +1', action: { method: 'bump', toast: '已更新' } },
      ],
    }
  }
  return {
    version: 1,
    nodes: [
      { type: 'text', text: '桌面小组件示例', tone: 'muted' },
      { type: 'keyValue', items: [{ label: '计数', value: String(count) }] },
      { type: 'button', text: '计数 +1', action: { method: 'bump', toast: '已更新' } },
    ],
  }
}
