/**
 * Computer Use 工具组（v39，docs/06 §28）。
 *
 * 定位：让 Agent 通过**真实桌面**完成没有结构化接口的任务 —— 截屏、移动鼠标、
 * 点击、输入、拖拽、滚轮、窗口管理、启动应用、UI Automation 控件操作与等待。
 *
 * 分层与内置浏览器（§27）同一套：本文件只定义工具与**注入的端口**，保持纯 Node 可单测；
 * 真正的截屏、PowerShell 输入宿主、坐标换算、应用策略、指针回执全在主进程实现
 * （`apps/desktop/src/main/computer-use/`）。
 *
 * 安全口径（内核侧只能做到这些，真正的系统边界在主进程端口）：
 * - 动作工具只会在**已授权的会话**里出现（装配层 run profile 隐藏）；入口工具
 *   `computer_start` 在未授权时可见，让 Agent 不必等用户去敲 `/computer`；
 * - 入口是 `confirm`（用户选 confirm 档时逐次询问），退出 `computer_stop` 是 `safe`
 *   （收回桌面授权不能被确认链卡住）；
 * - 非截图/等待类动作是 `confirm`，由统一确认链逐次判定（`auto` 档直接放行）；
 * - 动作串行（`parallel` 缺省 false）：桌面同一时刻只能有一个指针 / 焦点；
 * - 工具描述明确「先截图再动作、坐标基于最近截图、受保护应用不可操作、不要操作 Aurora 自身」。
 */

import type { ToolContext, ToolDefinition, ToolResult } from './registry.js'

/** 工具名清单：装配器 / run profile / 测试 / 文档共用。 */
export const COMPUTER_USE_TOOL_NAMES = [
  'computer_screenshot',
  'computer_mouse',
  'computer_keyboard',
  'computer_window',
  'computer_ui',
  'computer_wait',
  'computer_stop',
] as const
export type ComputerUseToolName = (typeof COMPUTER_USE_TOOL_NAMES)[number]

/**
 * Agent 自入口（v39 优化）：**未授权时唯一可见**的 Computer Use 工具。
 *
 * 与 `computer_stop` 分开成常量：`COMPUTER_USE_TOOL_NAMES` 是「授权后才可见」的 7 个
 * 工具（6 动作 + 退出），入口只在未授权时出现；`COMPUTER_USE_ALL_TOOL_NAMES` 是注册 /
 * 卸载 / 日志用的全集。
 *
 * 入口只建立**授权**（与用户敲 `/computer` 同一条 `service.start()`），不显示浮层、不启动
 * 光标动画；第一次动作工具调用才进入操作态（docs/06 §28「授权 ≠ 开始操作」）。
 */
export const COMPUTER_USE_START_TOOL_NAME = 'computer_start'
export const COMPUTER_USE_ALL_TOOL_NAMES = [
  COMPUTER_USE_START_TOOL_NAME,
  ...COMPUTER_USE_TOOL_NAMES,
] as const
export type ComputerUseAllToolName = (typeof COMPUTER_USE_ALL_TOOL_NAMES)[number]

/** 坐标空间：`image` = 最近一张截图的图片像素（默认）；`screen` = 物理虚拟屏幕像素。 */
export type ComputerCoordinateSpace = 'image' | 'screen'
export type ComputerMouseButton = 'left' | 'right' | 'middle'
export type ComputerModifier = 'ctrl' | 'alt' | 'shift' | 'win'

/**
 * 每个动作都可以带一句「下一步计划」（v39.1）。
 *
 * 它**不执行**，只进顶部过程面板 / 对话状态条的「下一步」一行：模型批量下发动作时，
 * 用户看到的不只是「正在点击」，还有「接下来要做什么」。与 `summary` 同口径 ——
 * 不含坐标、输入文字、剪贴板内容。
 */
export interface ComputerActionHint {
  /** 下一步计划（一句话，≤120 字；不执行） */
  next?: string
}

export type ComputerScreenshotDisplay = 'auto' | 'primary' | 'cursor' | 'foreground'
export type ComputerMouseAction =
  | 'move'
  | 'click'
  | 'double_click'
  | 'right_click'
  | 'middle_click'
  | 'drag'
  | 'scroll'
  | 'position'
export type ComputerKeyboardAction = 'type' | 'key'
export type ComputerWindowAction =
  | 'list'
  | 'active'
  | 'activate'
  | 'move'
  | 'resize'
  | 'minimize'
  | 'maximize'
  | 'restore'
  | 'close'
  | 'launch'
export type ComputerUiAction =
  'tree' | 'find' | 'invoke' | 'set_value' | 'focus' | 'expand' | 'collapse' | 'select'

export interface ComputerScreenshotInput extends ComputerActionHint {
  sessionId: string
  /** 目标显示器：auto（前台窗口所在屏，前台是 Aurora/受保护窗口时回落光标屏） */
  display?: ComputerScreenshotDisplay
  /** 指定显示器 id（Electron `Display.id`）；与 `display` 同时给时以本字段为准。 */
  displayId?: number
  /** 只截这个窗口（来自 `computer_window list`）；窗口最小化时失败。 */
  windowId?: string
  /** 本次截图的最长边（像素）；缺省读用户配置。 */
  maxWidth?: number
  signal?: AbortSignal
}

export interface ComputerMouseInput extends ComputerActionHint {
  sessionId: string
  action: ComputerMouseAction
  x?: number
  y?: number
  toX?: number
  toY?: number
  button?: ComputerMouseButton
  /** 点击次数（1–3；double_click 隐含 2） */
  count?: number
  /** 滚轮纵向格数（正 = 向上；一格 = 120） */
  dy?: number
  /** 滚轮横向格数（正 = 向右） */
  dx?: number
  modifiers?: ComputerModifier[]
  space?: ComputerCoordinateSpace
  signal?: AbortSignal
}

export interface ComputerKeyboardInput extends ComputerActionHint {
  sessionId: string
  action: ComputerKeyboardAction
  text?: string
  /** `type` 后是否补一个 Enter */
  submit?: boolean
  /** `key`：组合键，如 ['ctrl','s']；按顺序按下、反序释放 */
  keys?: string[]
  /** 逐字符间隔覆盖值（毫秒，0–200） */
  delayMs?: number
  signal?: AbortSignal
}

export interface ComputerWindowInput extends ComputerActionHint {
  sessionId: string
  action: ComputerWindowAction
  windowId?: string
  /** 按标题 / exe 子串匹配；必须唯一，否则返回候选列表 */
  titleMatch?: string
  /** list 的过滤子串 */
  filter?: string
  x?: number
  y?: number
  width?: number
  height?: number
  /** launch：可执行文件全路径或 exe 名（只接受 .exe / .com） */
  command?: string
  args?: string[]
  space?: ComputerCoordinateSpace
  signal?: AbortSignal
}

export interface ComputerUiInput extends ComputerActionHint {
  sessionId: string
  action: ComputerUiAction
  windowId?: string
  /** 控件路径（来自 tree / find），如 "0/2/1" */
  path?: string
  nameContains?: string
  role?: string
  value?: string
  maxDepth?: number
  maxNodes?: number
  signal?: AbortSignal
}

export interface ComputerWaitInput extends ComputerActionHint {
  sessionId: string
  seconds?: number
  signal?: AbortSignal
}

/** `computer_start`：Agent 主动建立 Computer Use 授权（只授权，不开始操作）。 */
export interface ComputerStartInput {
  sessionId: string
  /** 给确认卡 / 审计日志看的一句话理由（不含密码等敏感信息）。 */
  reason?: string
  signal?: AbortSignal
}

/** `computer_stop`：Agent 主动退出操作模式（任务完成 / 用户要求停止 / 交还桌面）。 */
export interface ComputerStopInput {
  sessionId: string
  signal?: AbortSignal
}

/**
 * 主进程端口：所有系统能力都在这里。
 *
 * 端口返回 `ToolResult`（含图片分片与摘要），内核不再加工；这样坐标换算、动作回执、
 * 应用策略、事件上报都只在一处实现，工具层保持薄。
 */
export interface ComputerUsePort {
  screenshot(input: ComputerScreenshotInput): Promise<ToolResult>
  mouse(input: ComputerMouseInput): Promise<ToolResult>
  keyboard(input: ComputerKeyboardInput): Promise<ToolResult>
  window(input: ComputerWindowInput): Promise<ToolResult>
  ui(input: ComputerUiInput): Promise<ToolResult>
  wait(input: ComputerWaitInput): Promise<ToolResult>
  /** 建立本会话授权（与 `/computer` 同一条服务入口；不建浮层）。 */
  start(input: ComputerStartInput): Promise<ToolResult>
  /** 退出操作模式：撤销本会话授权、收起浮层与过程面板（幂等）。 */
  stop(input: ComputerStopInput): Promise<ToolResult>
}

const DISPLAY_VALUES = ['auto', 'primary', 'cursor', 'foreground'] as const
const MOUSE_ACTIONS = [
  'move',
  'click',
  'double_click',
  'right_click',
  'middle_click',
  'drag',
  'scroll',
  'position',
] as const
const KEYBOARD_ACTIONS = ['type', 'key'] as const
const WINDOW_ACTIONS = [
  'list',
  'active',
  'activate',
  'move',
  'resize',
  'minimize',
  'maximize',
  'restore',
  'close',
  'launch',
] as const
const UI_ACTIONS = [
  'tree',
  'find',
  'invoke',
  'set_value',
  'focus',
  'expand',
  'collapse',
  'select',
] as const
const BUTTONS = ['left', 'right', 'middle'] as const
const MODIFIERS = ['ctrl', 'alt', 'shift', 'win'] as const
const SPACES = ['image', 'screen'] as const

/**
 * 六个动作工具共用的 `next` 参数（v39.1）：一句「下一步做什么」，只进过程面板。
 *
 * 定义只写一份：六处各抄一遍描述，改口径时总会漏掉一两处。
 */
const NEXT_PROPERTY = {
  type: 'string',
  description:
    '下一步计划（一句话，≤120 字，用用户的语言）：只显示在过程面板的「下一步」，不执行；' +
    '不要写坐标或输入的文字。批量下发动作时每一步都填它。',
}

export interface ComputerUseToolOptions {
  port: ComputerUsePort
}

export function createComputerUseTools(options: ComputerUseToolOptions): ToolDefinition[] {
  const { port } = options
  return [
    startTool(port),
    screenshotTool(port),
    mouseTool(port),
    keyboardTool(port),
    windowTool(port),
    uiTool(port),
    waitTool(port),
    stopTool(port),
  ]
}

function startTool(port: ComputerUsePort): ToolDefinition {
  return {
    name: COMPUTER_USE_START_TOOL_NAME,
    description:
      '由 Agent 主动建立 Computer Use 授权（用户已在设置里开启总开关时可用）。' +
      '用于任务必须点真实桌面才能完成时：只有图形界面的应用、用户已打开的程序、系统设置界面；' +
      '结构化工具（文件 / 终端 / 内置浏览器 / 办公文档）能做时优先用它们。' +
      '调用前先想好后面 2–4 步与目标窗口。授权本身不显示浮层；**同一次请求的下一轮**动作工具' +
      '（computer_screenshot / mouse / keyboard / window / ui / wait）立即进入工具面 —— ' +
      '不要在同一轮里同时调用本工具与动作工具（那些调用会报「工具不存在」）。' +
      '下一轮先 computer_screenshot，再按顺序批量下发动作、每步填 next；' +
      '桌面交互完成后必须调用 computer_stop 退出，把桌面还给用户。',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description:
            '给用户确认卡与审计日志看的一句话理由（不超过 200 字；不要写密码等敏感信息）',
        },
      },
      required: [],
      additionalProperties: false,
    },
    sensitivity: 'confirm',
    execute: async (input, ctx) =>
      guard(async () => {
        const record = asRecord(input) ?? {}
        const reason = optionalString(record['reason'], 'reason', 200)
        return port.start({
          sessionId: ctx.sessionId,
          ...(reason === undefined ? {} : { reason }),
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        })
      }),
  }
}

function screenshotTool(port: ComputerUsePort): ToolDefinition {
  return {
    name: 'computer_screenshot',
    description:
      '截取当前显示器（或指定窗口）并**更新坐标空间**。任何坐标动作前先截图；' +
      '窗口被移动 / 缩放 / 激活、弹窗出现、显示器变化后必须重新截图（旧坐标会失效）。' +
      '其后的 computer_mouse 坐标默认是这张图的图片像素。' +
      '结果给出显示器尺寸、图片尺寸、换算关系、前台窗口与鼠标位置，不需要自己换算物理坐标。' +
      '小控件看不清时用 windowId 只截目标窗口（同样 maxWidth 下细节更多），或调大 maxWidth。',
    parameters: {
      type: 'object',
      properties: {
        display: {
          type: 'string',
          enum: [...DISPLAY_VALUES],
          description: 'auto（缺省，前台窗口所在屏）/ primary / cursor / foreground',
        },
        displayId: { type: 'integer', description: '指定显示器 id；给了它时忽略 display' },
        windowId: {
          type: 'string',
          description: '只截这个窗口（来自 computer_window 的 list）；最小化窗口会失败',
        },
        maxWidth: {
          type: 'integer',
          minimum: 640,
          maximum: 2560,
          description: '本次截图最长边像素；缺省用设置里的值',
        },
        next: NEXT_PROPERTY,
      },
      required: [],
      additionalProperties: false,
    },
    sensitivity: 'safe',
    execute: async (input, ctx) => guard(() => port.screenshot(parseScreenshot(input, ctx))),
  }
}

function mouseTool(port: ComputerUsePort): ToolDefinition {
  return {
    name: 'computer_mouse',
    description:
      '移动 / 点击 / 双击 / 右键 / 中键 / 拖拽 / 滚轮 / 读取指针。x/y 默认是最近一张截图的图片像素；' +
      '也可 space:"screen" 用物理屏幕坐标。点击前会做命中测试与指针回执，并先滑 Agent 的虚拟光标再点击，' +
      '不需要先单独 move。action:"position" 只读当前位置、不产生副作用。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...MOUSE_ACTIONS], description: '要执行的动作' },
        x: { type: 'integer', description: '目标点 x（image 或 screen 空间）' },
        y: { type: 'integer', description: '目标点 y' },
        toX: { type: 'integer', description: 'drag 终点 x' },
        toY: { type: 'integer', description: 'drag 终点 y' },
        button: { type: 'string', enum: [...BUTTONS], description: '鼠标键，缺省 left' },
        count: {
          type: 'integer',
          minimum: 1,
          maximum: 3,
          description: '点击次数；double_click 固定 2',
        },
        dy: { type: 'integer', description: '纵向滚轮格数（正 = 向上）' },
        dx: { type: 'integer', description: '横向滚轮格数（正 = 向右）' },
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: [...MODIFIERS] },
          description: '按住这些修饰键（如 ctrl + 点击）',
        },
        space: { type: 'string', enum: [...SPACES], description: '坐标空间，缺省 image' },
        next: NEXT_PROPERTY,
      },
      required: ['action'],
      additionalProperties: false,
    },
    sensitivity: 'confirm',
    execute: async (input, ctx) => guard(() => port.mouse(parseMouse(input, ctx))),
  }
}

function keyboardTool(port: ComputerUsePort): ToolDefinition {
  return {
    name: 'computer_keyboard',
    description:
      '向当前前台窗口输入文字（支持中文 / emoji）或按组合键。输入前会校验「前台窗口 == 最近截图目标」，' +
      '不一致直接拒绝 —— 先点击 / 激活目标输入框并截图确认，再输入。submit=true 会在文字后补一个 Enter；' +
      '长文本的逐字间隔有总延迟上限，不会卡住整个回合。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...KEYBOARD_ACTIONS], description: 'type 或 key' },
        text: { type: 'string', description: 'type 的完整文本' },
        submit: { type: 'boolean', description: 'type 后补一个 Enter' },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'key 的组合键，如 ["ctrl","s"] / ["alt","tab"]',
        },
        delayMs: { type: 'integer', minimum: 0, maximum: 200, description: '逐字符间隔覆盖值' },
        next: NEXT_PROPERTY,
      },
      required: ['action'],
      additionalProperties: false,
    },
    sensitivity: 'confirm',
    execute: async (input, ctx) => guard(() => port.keyboard(parseKeyboard(input, ctx))),
  }
}

function windowTool(port: ComputerUsePort): ToolDefinition {
  return {
    name: 'computer_window',
    description:
      '列出 / 查询 / 激活 / 移动 / 缩放 / 最小化 / 最大化 / 还原 / 关闭窗口，或启动应用。' +
      '窗口 id 来自 list，titleMatch 必须唯一。启动应用用 launch（只接受 .exe / .com，等窗约 2 秒），' +
      '不要到桌面 / 开始菜单找图标。移动 / 缩放的 x/y/width/height 默认按最近截图换算。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...WINDOW_ACTIONS], description: '要执行的动作' },
        windowId: { type: 'string', description: '窗口 id（来自 list）' },
        titleMatch: { type: 'string', description: '按标题或 exe 子串匹配；必须唯一' },
        filter: { type: 'string', description: 'list 的过滤子串' },
        x: { type: 'integer', description: 'move 的新 x' },
        y: { type: 'integer', description: 'move 的新 y' },
        width: { type: 'integer', description: 'resize 的新宽度' },
        height: { type: 'integer', description: 'resize 的新高度' },
        command: { type: 'string', description: 'launch 的可执行文件（.exe / .com）' },
        args: { type: 'array', items: { type: 'string' }, description: 'launch 的参数数组' },
        space: { type: 'string', enum: [...SPACES], description: '坐标空间，缺省 image' },
        next: NEXT_PROPERTY,
      },
      required: ['action'],
      additionalProperties: false,
    },
    sensitivity: 'confirm',
    execute: async (input, ctx) => guard(() => port.window(parseWindow(input, ctx))),
  }
}

function uiTool(port: ComputerUsePort): ToolDefinition {
  return {
    name: 'computer_ui',
    description:
      '用 Windows UI Automation 读取控件树、按名称查找控件并直接操作 —— 比坐标点击稳，能用就优先用。' +
      '**先 find**（nameContains / role），不要每次都拉整棵树（可能上百节点）；' +
      'path 来自 find / tree，页面布局变化后会失效，需要重新查找。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...UI_ACTIONS], description: '要执行的动作' },
        windowId: { type: 'string', description: '目标窗口；缺省前台窗口' },
        path: { type: 'string', description: '控件路径，如 "0/2/1"' },
        nameContains: { type: 'string', description: 'find：名称 / AutomationId / Value 子串' },
        role: { type: 'string', description: 'find：控件类型，如 Button / Edit / MenuItem' },
        value: { type: 'string', description: 'set_value 的文本' },
        maxDepth: { type: 'integer', minimum: 1, maximum: 20, description: 'tree 深度，缺省 8' },
        maxNodes: {
          type: 'integer',
          minimum: 1,
          maximum: 5000,
          description: 'tree 节点上限，缺省 1200',
        },
        next: NEXT_PROPERTY,
      },
      required: ['action'],
      additionalProperties: false,
    },
    sensitivity: 'confirm',
    execute: async (input, ctx) => guard(() => port.ui(parseUi(input, ctx))),
  }
}

function waitTool(port: ComputerUsePort): ToolDefinition {
  return {
    name: 'computer_wait',
    description:
      '等待 0–30 秒（缺省 1 秒）让应用 / 页面完成加载。只在明确知道要加载时用（启动后、打开大文件后），' +
      '**不要每个动作后都等**；连续动作直接排在同一轮里，界面变化用截图核对。',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', minimum: 0, maximum: 30, description: '等待秒数，缺省 1' },
        next: NEXT_PROPERTY,
      },
      required: [],
      additionalProperties: false,
    },
    sensitivity: 'safe',
    execute: async (input, ctx) => guard(() => port.wait(parseWait(input, ctx))),
  }
}

function stopTool(port: ComputerUsePort): ToolDefinition {
  return {
    name: 'computer_stop',
    description:
      '主动退出 Computer Use 操作模式：桌面交互完成、用户要求停止，或准备把桌面交还用户时调用。' +
      '退出后本会话授权立即失效、浮层与过程面板收起，Aurora 会回到前台；' +
      '**做完就立即调用**，不要一直占着桌面；下次操作由你再次调用 computer_start 进入。',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    sensitivity: 'safe',
    execute: async (_input, ctx) =>
      guard(() =>
        port.stop({
          sessionId: ctx.sessionId,
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        }),
      ),
  }
}

// ───────────────────────── 参数解析（失败折成工具错误） ─────────────────────────

function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  return Promise.resolve()
    .then(run)
    .catch((error: unknown) => ({
      content: `Computer Use 执行失败：${describeError(error)}`,
      isError: true,
      summary: 'Computer Use 失败',
    }))
}

function parseScreenshot(input: unknown, ctx: ToolContext): ComputerScreenshotInput {
  const record = asRecord(input) ?? {}
  const display = optionalEnum(record['display'], DISPLAY_VALUES, 'display')
  const displayId = optionalInt(record['displayId'], 'displayId', 0, Number.MAX_SAFE_INTEGER)
  const windowId = optionalString(record['windowId'], 'windowId', 128)
  const maxWidth = optionalInt(record['maxWidth'], 'maxWidth', 640, 2560)
  return {
    sessionId: ctx.sessionId,
    ...optionalNext(record),
    ...(display === undefined ? {} : { display }),
    ...(displayId === undefined ? {} : { displayId }),
    ...(windowId === undefined ? {} : { windowId }),
    ...(maxWidth === undefined ? {} : { maxWidth }),
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  }
}

function parseMouse(input: unknown, ctx: ToolContext): ComputerMouseInput {
  const record = asRecord(input) ?? {}
  const action = optionalEnum(record['action'], MOUSE_ACTIONS, 'action')
  if (action === undefined) throw new Error('参数 action 必填')
  const button = optionalEnum(record['button'], BUTTONS, 'button')
  const space = optionalEnum(record['space'], SPACES, 'space')
  const modifiers = optionalModifiers(record['modifiers'])
  return {
    sessionId: ctx.sessionId,
    action,
    ...optionalNext(record),
    ...(optionalInt(record['x'], 'x', -1_000_000, 1_000_000) === undefined
      ? {}
      : { x: numberValue(record['x'], 'x') }),
    ...(optionalInt(record['y'], 'y', -1_000_000, 1_000_000) === undefined
      ? {}
      : { y: numberValue(record['y'], 'y') }),
    ...(optionalInt(record['toX'], 'toX', -1_000_000, 1_000_000) === undefined
      ? {}
      : { toX: numberValue(record['toX'], 'toX') }),
    ...(optionalInt(record['toY'], 'toY', -1_000_000, 1_000_000) === undefined
      ? {}
      : { toY: numberValue(record['toY'], 'toY') }),
    ...(button === undefined ? {} : { button }),
    ...(optionalInt(record['count'], 'count', 1, 3) === undefined
      ? {}
      : { count: numberValue(record['count'], 'count') }),
    ...(optionalInt(record['dy'], 'dy', -100, 100) === undefined
      ? {}
      : { dy: numberValue(record['dy'], 'dy') }),
    ...(optionalInt(record['dx'], 'dx', -100, 100) === undefined
      ? {}
      : { dx: numberValue(record['dx'], 'dx') }),
    ...(modifiers === undefined ? {} : { modifiers }),
    ...(space === undefined ? {} : { space }),
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  }
}

function parseKeyboard(input: unknown, ctx: ToolContext): ComputerKeyboardInput {
  const record = asRecord(input) ?? {}
  const action = optionalEnum(record['action'], KEYBOARD_ACTIONS, 'action')
  if (action === undefined) throw new Error('参数 action 必填')
  const text = optionalString(record['text'], 'text', 20_000)
  if (action === 'type' && text === undefined) throw new Error('action=type 时 text 必填')
  const keys = optionalStringArray(record['keys'], 'keys')
  if (action === 'key' && (keys === undefined || keys.length === 0)) {
    throw new Error('action=key 时 keys 必填')
  }
  return {
    sessionId: ctx.sessionId,
    action,
    ...optionalNext(record),
    ...(text === undefined ? {} : { text }),
    ...(record['submit'] === undefined ? {} : { submit: booleanValue(record['submit'], 'submit') }),
    ...(keys === undefined ? {} : { keys }),
    ...(optionalInt(record['delayMs'], 'delayMs', 0, 200) === undefined
      ? {}
      : { delayMs: numberValue(record['delayMs'], 'delayMs') }),
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  }
}

function parseWindow(input: unknown, ctx: ToolContext): ComputerWindowInput {
  const record = asRecord(input) ?? {}
  const action = optionalEnum(record['action'], WINDOW_ACTIONS, 'action')
  if (action === undefined) throw new Error('参数 action 必填')
  const command = optionalString(record['command'], 'command', 1024)
  if (action === 'launch' && command === undefined) throw new Error('action=launch 时 command 必填')
  const space = optionalEnum(record['space'], SPACES, 'space')
  const args = optionalStringArray(record['args'], 'args', 64)
  return {
    sessionId: ctx.sessionId,
    action,
    ...optionalNext(record),
    ...(optionalString(record['windowId'], 'windowId', 128) === undefined
      ? {}
      : { windowId: stringValue(record['windowId'], 'windowId') }),
    ...(optionalString(record['titleMatch'], 'titleMatch', 256) === undefined
      ? {}
      : { titleMatch: stringValue(record['titleMatch'], 'titleMatch') }),
    ...(optionalString(record['filter'], 'filter', 256) === undefined
      ? {}
      : { filter: stringValue(record['filter'], 'filter') }),
    ...(optionalInt(record['x'], 'x', -1_000_000, 1_000_000) === undefined
      ? {}
      : { x: numberValue(record['x'], 'x') }),
    ...(optionalInt(record['y'], 'y', -1_000_000, 1_000_000) === undefined
      ? {}
      : { y: numberValue(record['y'], 'y') }),
    ...(optionalInt(record['width'], 'width', 1, 100_000) === undefined
      ? {}
      : { width: numberValue(record['width'], 'width') }),
    ...(optionalInt(record['height'], 'height', 1, 100_000) === undefined
      ? {}
      : { height: numberValue(record['height'], 'height') }),
    ...(command === undefined ? {} : { command }),
    ...(args === undefined ? {} : { args }),
    ...(space === undefined ? {} : { space }),
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  }
}

function parseUi(input: unknown, ctx: ToolContext): ComputerUiInput {
  const record = asRecord(input) ?? {}
  const action = optionalEnum(record['action'], UI_ACTIONS, 'action')
  if (action === undefined) throw new Error('参数 action 必填')
  return {
    sessionId: ctx.sessionId,
    action,
    ...optionalNext(record),
    ...(optionalString(record['windowId'], 'windowId', 128) === undefined
      ? {}
      : { windowId: stringValue(record['windowId'], 'windowId') }),
    ...(optionalString(record['path'], 'path', 512) === undefined
      ? {}
      : { path: stringValue(record['path'], 'path') }),
    ...(optionalString(record['nameContains'], 'nameContains', 256) === undefined
      ? {}
      : { nameContains: stringValue(record['nameContains'], 'nameContains') }),
    ...(optionalString(record['role'], 'role', 64) === undefined
      ? {}
      : { role: stringValue(record['role'], 'role') }),
    ...(optionalString(record['value'], 'value', 20_000) === undefined
      ? {}
      : { value: stringValue(record['value'], 'value') }),
    ...(optionalInt(record['maxDepth'], 'maxDepth', 1, 20) === undefined
      ? {}
      : { maxDepth: numberValue(record['maxDepth'], 'maxDepth') }),
    ...(optionalInt(record['maxNodes'], 'maxNodes', 1, 5000) === undefined
      ? {}
      : { maxNodes: numberValue(record['maxNodes'], 'maxNodes') }),
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  }
}

function parseWait(input: unknown, ctx: ToolContext): ComputerWaitInput {
  const record = asRecord(input) ?? {}
  const seconds = record['seconds']
  if (seconds !== undefined && (typeof seconds !== 'number' || !Number.isFinite(seconds))) {
    throw new Error('参数 seconds 必须是数字')
  }
  if (typeof seconds === 'number' && (seconds < 0 || seconds > 30)) {
    throw new Error('参数 seconds 超出 0–30')
  }
  return {
    sessionId: ctx.sessionId,
    ...optionalNext(record),
    ...(typeof seconds === 'number' ? { seconds } : {}),
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  }
}

// ───────────────────────── 通用校验 ─────────────────────────

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  return input as Record<string, unknown>
}

function optionalEnum<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`参数 ${field} 只能是 ${allowed.join(' / ')}（实际 ${JSON.stringify(value)}）`)
  }
  return value as T[number]
}

function optionalString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`参数 ${field} 必须是字符串`)
  if (value.length > maxLength) throw new Error(`参数 ${field} 超过 ${maxLength} 字符`)
  return value
}

/**
 * `next`（v39.1）→ 可直接展开的补丁：trim 后为空视为「没给计划」（清空面板的下一步），
 * 超长仍按参数校验报错（与其它字段同一口径，不静默截断模型输入）。
 */
function optionalNext(record: Record<string, unknown>): Record<string, string> {
  const raw = optionalString(record['next'], 'next', 120)
  const next = raw?.trim()
  return next === undefined || next === '' ? {} : { next }
}

function stringValue(value: unknown, field: string): string {
  const parsed = optionalString(value, field, 1_000_000)
  if (parsed === undefined) throw new Error(`参数 ${field} 必填`)
  return parsed
}

function optionalInt(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`参数 ${field} 必须是整数`)
  }
  if (value < min || value > max) throw new Error(`参数 ${field} 超出 ${min}–${max}`)
  return value
}

function numberValue(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`参数 ${field} 必须是数字`)
  }
  return value
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`参数 ${field} 必须是布尔值`)
  return value
}

function optionalStringArray(value: unknown, field: string, maxItems = 100): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error(`参数 ${field} 必须是字符串数组`)
  if (value.length > maxItems) throw new Error(`参数 ${field} 最多 ${maxItems} 项`)
  return value.map((item) => {
    if (typeof item !== 'string') throw new Error(`参数 ${field} 必须是字符串数组`)
    return item
  })
}

function optionalModifiers(value: unknown): ComputerModifier[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error('参数 modifiers 必须是数组')
  return value.map((item) => {
    if (typeof item !== 'string' || !MODIFIERS.includes(item as (typeof MODIFIERS)[number])) {
      throw new Error(`参数 modifiers 只能包含 ${MODIFIERS.join(' / ')}`)
    }
    return item as ComputerModifier
  })
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
