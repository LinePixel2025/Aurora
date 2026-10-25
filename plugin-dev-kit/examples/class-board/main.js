'use strict'
/* global module */

/**
 * 班级事务示例插件（docs/15）。
 *
 * 演示三件事：
 * 1. 桌面小组件（本周值日）与提示条小组件（今日事务）共用同一套声明式 schema；
 * 2. Agent 工具 `add_task` 写入插件存储后，用 `ctx.ui.panelEvent` 推送刷新，
 *    已打开的面板 / 小组件无需用户点「刷新」；
 * 3. 数据只存在插件私有存储（`ctx.storage`），不碰用户目录与 Aurora 凭据。
 */

const TASKS_KEY = 'tasks'
const DUTIES_KEY = 'duties'
const MAX_TASKS = 50

const DEFAULT_DUTIES = [
  { day: '周一', name: '张同学' },
  { day: '周二', name: '李同学' },
  { day: '周三', name: '王同学' },
  { day: '周四', name: '赵同学' },
  { day: '周五', name: '陈同学' },
]

module.exports = {
  async activate(ctx) {
    ctx.log('info', '班级事务示例插件已激活', { team: teamName(ctx.config) })
  },

  async invokeTool(name, input, ctx) {
    if (name === 'add_task') {
      const text = String(input.text ?? '').trim()
      if (text === '') return { content: '事务内容不能为空', isError: true }
      const task = await addTask(ctx, text, String(input.due ?? '').trim())
      await pushAll(ctx)
      return {
        content: `已添加事务：${task.text}${task.due === '' ? '' : `（截止 ${task.due}）`}`,
        summary: `班级事务 +1（共 ${(await readTasks(ctx)).length} 条）`,
      }
    }
    if (name === 'list_tasks') {
      const tasks = await readTasks(ctx)
      const duties = await readDuties(ctx)
      const lines = [
        `班级：${teamName(ctx.config)}`,
        `事务：${tasks.length} 条（未完成 ${tasks.filter((task) => !task.done).length} 条）`,
        ...tasks.map(
          (task) => `- [${task.done ? 'x' : ' '}] ${task.text}${task.due ? `（${task.due}）` : ''}`,
        ),
        `值日：${duties.map((duty) => `${duty.day} ${duty.name}`).join(' / ')}`,
      ]
      return { content: lines.join('\n'), summary: `${tasks.length} 条事务` }
    }
    return { content: `未知工具：${name}`, isError: true }
  },

  async invokeCommand(name, args, ctx) {
    if (name !== 'classboard') throw new Error(`未知命令：${name}`)
    await ctx.ui.openPanel('board')
    return { summary: '已打开班级事务面板' }
  },

  async invokePanel(panelId, method, params, ctx) {
    if (panelId !== 'board') throw new Error(`未知面板：${panelId}`)
    const values = params !== null && typeof params === 'object' ? (params.values ?? {}) : {}
    if (method === 'add') {
      const text = String(values.text ?? '').trim()
      if (text === '') return { schema: await boardSchema(ctx), toast: '请先填写事务内容' }
      await addTask(ctx, text, '')
      await pushAll(ctx)
      return { schema: await boardSchema(ctx), toast: '已添加事务' }
    }
    if (method === 'clear-done') {
      const tasks = await readTasks(ctx)
      await writeTasks(
        ctx,
        tasks.filter((task) => !task.done),
      )
      await pushAll(ctx)
      return { schema: await boardSchema(ctx), toast: '已清理完成项' }
    }
    return { schema: await boardSchema(ctx) }
  },

  async invokeWidget(widgetId, method, params, ctx) {
    if (widgetId === 'duty-week') {
      return { schema: await dutySchema(ctx) }
    }
    if (widgetId === 'today-tasks') {
      if (method === 'add-example') {
        await addTask(ctx, '整理明天的课程资料', '今天 18:00')
        await pushAll(ctx)
        return { schema: await taskSchema(ctx), toast: '已添加示例事务' }
      }
      return { schema: await taskSchema(ctx) }
    }
    throw new Error(`未知小组件：${widgetId}`)
  },

  onEvent(event, payload, ctx) {
    ctx.log('debug', '收到宿主事件', { event, payload })
  },
}

/** 插件主动推送：只发给本插件声明过的面板 / 小组件。 */
async function pushAll(ctx) {
  await ctx.ui.panelEvent({ panelId: 'board', event: 'classboard.changed' })
  await ctx.ui.panelEvent({ widgetId: 'duty-week', event: 'classboard.changed' })
  await ctx.ui.panelEvent({ widgetId: 'today-tasks', event: 'classboard.changed' })
}

function teamName(config) {
  return typeof config.teamName === 'string' && config.teamName.trim() !== ''
    ? config.teamName.trim()
    : '高一(3)班'
}

async function readTasks(ctx) {
  const value = await ctx.storage.get(TASKS_KEY)
  return Array.isArray(value)
    ? value.filter(
        (task) =>
          task !== null &&
          typeof task === 'object' &&
          typeof task.id === 'string' &&
          typeof task.text === 'string',
      )
    : []
}

async function writeTasks(ctx, tasks) {
  await ctx.storage.set(TASKS_KEY, tasks.slice(0, MAX_TASKS))
}

async function addTask(ctx, text, due) {
  const tasks = await readTasks(ctx)
  const task = {
    id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    text: text.slice(0, 200),
    due: due.slice(0, 60),
    done: false,
    createdAt: new Date().toISOString(),
  }
  await writeTasks(ctx, [task, ...tasks])
  return task
}

async function readDuties(ctx) {
  const value = await ctx.storage.get(DUTIES_KEY)
  if (Array.isArray(value) && value.length > 0) {
    return value.filter(
      (duty) =>
        duty !== null &&
        typeof duty === 'object' &&
        typeof duty.day === 'string' &&
        typeof duty.name === 'string',
    )
  }
  await ctx.storage.set(DUTIES_KEY, DEFAULT_DUTIES)
  return DEFAULT_DUTIES
}

function todayLabel() {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date().getDay()] ?? '周五'
}

async function boardSchema(ctx) {
  const tasks = await readTasks(ctx)
  const pending = tasks.filter((task) => !task.done).length
  return {
    version: 1,
    nodes: [
      { type: 'heading', text: teamName(ctx.config) },
      { type: 'text', text: '这里的事务会同步到桌面与提示条小组件。', tone: 'muted' },
      {
        type: 'row',
        children: [
          { type: 'input', bind: 'text', placeholder: '要加的事务，例如：收物理作业' },
          { type: 'button', text: '添加', action: { method: 'add', toast: '已添加事务' } },
        ],
      },
      {
        type: 'keyValue',
        items: [
          { label: '未完成', value: String(pending), tone: pending > 0 ? 'warn' : 'ok' },
          { label: '已完成', value: String(tasks.length - pending) },
        ],
      },
      {
        type: 'list',
        items:
          tasks.length === 0
            ? [{ label: '暂无事务', value: '用工具或上面的输入框添加', tone: 'muted' }]
            : tasks.slice(0, 10).map((task) => ({
                label: task.text,
                value: task.done ? '已完成' : task.due || '待办',
                tone: task.done ? 'muted' : 'warn',
              })),
      },
      {
        type: 'button',
        text: '清理已完成',
        action: { method: 'clear-done', confirm: '确定删除所有已完成事务？' },
      },
    ],
  }
}

async function dutySchema(ctx) {
  const duties = await readDuties(ctx)
  const today = todayLabel()
  return {
    version: 1,
    nodes: [
      { type: 'text', text: `${teamName(ctx.config)} · 本周值日`, tone: 'muted' },
      {
        type: 'list',
        items: duties.map((duty) => ({
          label: duty.day,
          value: duty.name,
          tone: duty.day === today ? 'ok' : 'default',
        })),
      },
    ],
  }
}

async function taskSchema(ctx) {
  const tasks = await readTasks(ctx)
  const pending = tasks.filter((task) => !task.done)
  return {
    version: 1,
    nodes: [
      {
        type: 'row',
        children: [
          {
            type: 'badge',
            text: `待办 ${pending.length}`,
            tone: pending.length > 0 ? 'warn' : 'ok',
          },
          { type: 'badge', text: `完成 ${tasks.length - pending.length}`, tone: 'muted' },
        ],
      },
      {
        type: 'list',
        items:
          pending.length === 0
            ? [{ label: '今天没有待办', value: '去面板里加一条', tone: 'muted' }]
            : pending.slice(0, 4).map((task) => ({
                label: task.text,
                value: task.due || '待办',
                tone: 'warn',
              })),
      },
      {
        type: 'button',
        text: '添加示例事务',
        action: { method: 'add-example', toast: '已添加示例事务' },
      },
    ],
  }
}
