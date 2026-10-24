/**
 * 自动化组件目录（docs/13 §4.3 / §5）：触发器与操作组件的表单元数据 + 定义校验。
 *
 * **catalog 是唯一口径**：渲染层编辑器与 Center 网页的动态表单、AI 工具的参数说明、
 * 保存时的合法化校验（`validateDefinition`）都由它驱动 —— 新增组件只改这里。
 * 描述符对渲染层不可用时（如 ClassIsland 未配置）靠 `available` 门控「不渲染」。
 */
import type {
  AutomationActionDescriptor,
  AutomationActionKind,
  AutomationCatalog,
  AutomationConditionDescriptor,
  AutomationDefinition,
  AutomationDescriptorField,
  AutomationTriggerKind,
} from '@aurora/shared'
import { parseClock } from '../schedule.js'

// ───────────────────────── 触发器（条件组件） ─────────────────────────

export const CONDITION_DESCRIPTORS: AutomationConditionDescriptor[] = [
  {
    kind: 'daily',
    label: '每天定时',
    description: '在指定时刻（可限定星期几）触发一次。',
    fields: [
      { key: 'at', label: '触发时刻', type: 'time', placeholder: '08:00' },
      {
        key: 'weekdays',
        label: '生效星期',
        type: 'weekdays',
        hint: '留空 = 每天；0 = 周日',
      },
    ],
    requiresSchedule: false,
  },
  {
    kind: 'interval',
    label: '固定间隔',
    description: '每 N 分钟触发一次（5–1440）。',
    fields: [
      { key: 'everyMinutes', label: '间隔（分钟）', type: 'number', min: 5, max: 1440, step: 5 },
    ],
    requiresSchedule: false,
  },
  {
    kind: 'pre-class',
    label: '距上课不足 N 分钟',
    description: '某节课开始前 N 分钟内触发（每节课一次，manual / ClassIsland 课表皆可）。',
    fields: [{ key: 'leadMinutes', label: '提前（分钟）', type: 'number', min: 1, max: 120 }],
    requiresSchedule: true,
  },
  {
    kind: 'class-start',
    label: '上课时',
    description: '进入某节课的时刻触发（每节课一次）。',
    fields: [],
    requiresSchedule: true,
  },
  {
    kind: 'pre-end',
    label: '距下课不足 N 分钟',
    description: '正在上的课距离结束不足 N 分钟时触发（每节课一次）。',
    fields: [{ key: 'leadMinutes', label: '提前（分钟）', type: 'number', min: 1, max: 120 }],
    requiresSchedule: true,
  },
  {
    kind: 'class-end',
    label: '下课时',
    description: '某节课结束的时刻触发（每节课一次）。',
    fields: [],
    requiresSchedule: true,
  },
  {
    kind: 'next-lesson',
    label: '下节课是指定科目',
    description: '「下一节未开始的课」变为指定科目时触发（每节课一次）。',
    fields: [{ key: 'subject', label: '科目名', type: 'text', placeholder: '与课程表科目名一致' }],
    requiresSchedule: true,
  },
  {
    // 插件事件（docs/14 §3.5）：一个通用描述符，插件 id 与事件名都手填。
    // 不做动态下拉 —— catalog 是静态表，插件启停时重建会让已保存的定义失去可见性。
    kind: 'plugin-event',
    label: '插件事件',
    description: '插件触发它声明的自动化事件时运行（需在清单里声明事件）。',
    fields: [
      {
        key: 'pluginId',
        label: '插件 id',
        type: 'text',
        placeholder: 'com.example.todo',
        hint: '与插件清单的 id 一致',
      },
      {
        key: 'event',
        label: '事件名',
        type: 'text',
        placeholder: 'todo-added',
        hint: '与插件声明的事件名一致',
      },
    ],
    requiresSchedule: false,
  },
]

// ───────────────────────── 操作组件（Normal Mode 封闭能力集） ─────────────────────────

export const ACTION_DESCRIPTORS: Omit<AutomationActionDescriptor, 'available'>[] = [
  {
    kind: 'system-notify',
    label: '系统通知',
    description: '弹一条 Windows 系统通知，可选点击打开某个目录。',
    fields: [
      { key: 'title', label: '标题', type: 'text', placeholder: '通知标题' },
      { key: 'body', label: '正文', type: 'text', placeholder: '通知正文' },
      {
        key: 'openPath',
        label: '点击打开的目录',
        type: 'text',
        placeholder: '绝对路径（可选）',
        hint: '留空 = 点击不做任何事',
      },
    ],
    requiresClassIsland: false,
  },
  {
    kind: 'classisland-remind',
    label: 'ClassIsland 提醒',
    description: '经 ClassIsland 桥接弹出提醒（需已配置桥接端点）。',
    fields: [
      { key: 'title', label: '标题', type: 'text', placeholder: '提醒标题' },
      { key: 'body', label: '正文', type: 'text', placeholder: '提醒正文' },
      {
        key: 'channel',
        label: '提醒渠道',
        type: 'select',
        options: [
          { value: 'custom', label: '自定义提醒' },
          { value: 'class-started', label: '上课提醒' },
          { value: 'pre-class', label: '课前提醒' },
        ],
      },
    ],
    requiresClassIsland: true,
  },
  {
    kind: 'open-folder',
    label: '打开文件夹',
    description: '用系统默认方式打开一个文件夹（科目文件夹或任意绝对路径）。',
    fields: [
      {
        key: 'target',
        label: '目标类型',
        type: 'select',
        options: [
          { value: 'subject', label: '科目文件夹' },
          { value: 'path', label: '指定路径' },
        ],
      },
      {
        key: 'subject',
        label: '科目名',
        type: 'text',
        placeholder: '与「模式」设置里的科目一致',
        hint: 'target = 科目文件夹 时必填',
      },
      {
        key: 'path',
        label: '文件夹路径',
        type: 'text',
        placeholder: '绝对路径',
        hint: 'target = 指定路径 时必填',
      },
    ],
    requiresClassIsland: false,
  },
  {
    kind: 'open-url',
    label: '打开网址',
    description: '用系统默认浏览器打开一个 http(s) 网址（其他协议一律拒绝）。',
    fields: [
      {
        key: 'url',
        label: '网址',
        type: 'text',
        placeholder: 'https://…',
        hint: '仅支持 http:// 与 https:// 开头',
      },
    ],
    requiresClassIsland: false,
  },
  {
    kind: 'open-app',
    label: '打开应用',
    description: '用系统默认方式打开一个应用（可执行文件或 .lnk 快捷方式的绝对路径）。',
    fields: [
      {
        key: 'path',
        label: '应用路径',
        type: 'text',
        placeholder: '如 C:\\Program Files\\…\\app.exe',
        hint: '仅路径本身，不支持附加命令行参数',
      },
    ],
    requiresClassIsland: false,
  },
  {
    // 插件动作（docs/14 §3.5）：参数是自由 JSON，交给插件自己解释。
    // 字段用 text + json 而非动态下拉（catalog 不随插件启停重建）。
    kind: 'plugin-action',
    label: '插件动作',
    description: '调用已启用插件声明的自动化动作（插件需声明自动化权限）。',
    fields: [
      {
        key: 'pluginId',
        label: '插件 id',
        type: 'text',
        placeholder: 'com.example.todo',
        hint: '与插件清单的 id 一致',
      },
      {
        key: 'action',
        label: '动作名',
        type: 'text',
        placeholder: 'add',
        hint: '与插件声明的动作名一致',
      },
      {
        key: 'params',
        label: '参数（JSON）',
        type: 'json',
        placeholder: '{}',
        hint: '传给插件动作的对象，可留空',
      },
    ],
    requiresClassIsland: false,
  },
]

/** 组装 catalog；`classislandAvailable` 决定 classisland-remind 的 `available`。 */
export function buildCatalog(classislandAvailable: boolean): AutomationCatalog {
  return {
    conditions: CONDITION_DESCRIPTORS,
    actions: ACTION_DESCRIPTORS.map((descriptor) => ({
      ...descriptor,
      available: !descriptor.requiresClassIsland || classislandAvailable,
    })),
  }
}

/** 操作组件的中文名（运行历史落库时用，渲染端不必再拉 catalog）；未知 kind 回落原值。 */
export function actionLabelOf(kind: AutomationActionKind): string {
  return ACTION_DESCRIPTORS.find((descriptor) => descriptor.kind === kind)?.label ?? kind
}

/**
 * open-url 的协议白名单（docs/13 §5）：只放 http / https —— `file:` / 自定义协议
 * 一律视为非法，防「打开网址」变成协议逃逸面。保存校验与执行器共用这一个口径。
 */
export function isWebUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

// ───────────────────────── 定义校验（保存入口的唯一合法化层） ─────────────────────────

export interface ValidationResult {
  ok: boolean
  error?: string
}

const NAME_MAX = 60
const PROMPT_MAX = 8000
const MAX_ACTIONS = 10
/** 插件动作参数 JSON 的文本上限（8 KB，与 docs/14 §3.5 同口径） */
export const JSON_FIELD_MAX = 8 * 1024
/** 调用次数上限的取值区间（0 = 不限；与工具层 `MAX_RUNS_MAX` 同源口径） */
export const MAX_RUNS_MAX = 100_000

/**
 * 校验一份自动化定义（docs/13 §8 / §9 的保存入口共用）。
 * 组件 kind 必须在 catalog 内、参数按字段类型逐个校验；
 * Normal Mode 的 ClassIsland 组件在桥接不可用时直接拒绝（不保存跑不了的自动化）。
 */
export function validateDefinition(input: unknown, catalog: AutomationCatalog): ValidationResult {
  if (typeof input !== 'object' || input === null) return fail('定义必须是对象')
  const raw = input as Record<string, unknown>

  const name = raw['name']
  if (typeof name !== 'string' || name.trim() === '') return fail('名称不能为空')
  if (name.trim().length > NAME_MAX) return fail(`名称不能超过 ${NAME_MAX} 个字符`)

  const mode = raw['mode']
  if (mode !== 'agent' && mode !== 'normal') return fail('mode 必须是 agent 或 normal')

  const enabled = raw['enabled']
  if (enabled !== undefined && typeof enabled !== 'boolean') return fail('enabled 必须是布尔值')

  const maxRuns = raw['maxRuns']
  if (maxRuns !== undefined && maxRuns !== null) {
    if (typeof maxRuns !== 'number' || !Number.isInteger(maxRuns)) {
      return fail('调用次数上限必须是整数（0 = 不限）')
    }
    if (maxRuns < 0 || maxRuns > MAX_RUNS_MAX) {
      return fail(`调用次数上限必须在 0–${MAX_RUNS_MAX} 之间（0 = 不限）`)
    }
  }

  const runCount = raw['runCount']
  if (runCount !== undefined && runCount !== null) {
    if (typeof runCount !== 'number' || !Number.isInteger(runCount) || runCount < 0) {
      return fail('已调用次数必须是非负整数')
    }
  }

  const trigger = raw['trigger']
  if (typeof trigger !== 'object' || trigger === null) return fail('缺少触发器')
  const triggerResult = validateTrigger(trigger, catalog)
  if (!triggerResult.ok) return triggerResult

  if (mode === 'agent') {
    const prompt = raw['prompt']
    if (typeof prompt !== 'string' || prompt.trim() === '')
      return fail('Agent 模式必须填写任务指令')
    if (prompt.length > PROMPT_MAX) return fail(`任务指令不能超过 ${PROMPT_MAX} 个字符`)
  } else {
    const actions = raw['actions']
    if (!Array.isArray(actions) || actions.length === 0) return fail('普通模式至少需要一个操作')
    if (actions.length > MAX_ACTIONS) return fail(`操作数量不能超过 ${MAX_ACTIONS} 个`)
    for (const action of actions) {
      const result = validateAction(action, catalog)
      if (!result.ok) return result
    }
  }
  return { ok: true }
}

function validateTrigger(trigger: unknown, catalog: AutomationCatalog): ValidationResult {
  if (typeof trigger !== 'object' || trigger === null) return fail('触发器必须是对象')
  const record = trigger as Record<string, unknown>
  const descriptor = catalog.conditions.find((item) => item.kind === record['kind'])
  if (descriptor === undefined) return fail('不支持的触发器类型')
  const result = validateParams(
    record['params'],
    descriptor.fields,
    `触发器「${descriptor.label}」`,
  )
  if (!result.ok) return result
  if (descriptor.kind === 'plugin-event') {
    const params = isRecord(record['params']) ? record['params'] : {}
    if (isBlank(params['pluginId'])) return fail('触发器「插件事件」：必须填写插件 id')
    if (isBlank(params['event'])) return fail('触发器「插件事件」：必须填写事件名')
  }
  return { ok: true }
}

function validateAction(action: unknown, catalog: AutomationCatalog): ValidationResult {
  if (typeof action !== 'object' || action === null) return fail('操作必须是对象')
  const record = action as Record<string, unknown>
  const descriptor = catalog.actions.find((item) => item.kind === record['kind'])
  if (descriptor === undefined) return fail('不支持的操作组件')
  if (!descriptor.available)
    return fail(`操作组件「${descriptor.label}」当前不可用（未配置 ClassIsland 桥接）`)
  const result = validateParams(record['params'], descriptor.fields, `操作「${descriptor.label}」`)
  if (!result.ok) return result
  // 组件级业务约束：open-folder 的目标路径字段二选一
  if (descriptor.kind === 'open-folder') {
    const params = isRecord(record['params']) ? record['params'] : {}
    const target = params['target']
    if (target === 'subject' && isBlank(params['subject'])) {
      return fail('操作「打开文件夹」：目标类型为科目文件夹时必须填写科目名')
    }
    if (target === 'path' && isBlank(params['path'])) {
      return fail('操作「打开文件夹」：目标类型为指定路径时必须填写路径')
    }
    if (target !== 'subject' && target !== 'path') return fail('操作「打开文件夹」：目标类型无效')
  }
  // open-url：网址必填且只放 http(s)（与执行器共用 isWebUrl 一个口径，docs/13 §5）
  if (descriptor.kind === 'open-url') {
    const params = isRecord(record['params']) ? record['params'] : {}
    if (isBlank(params['url'])) return fail('操作「打开网址」：必须填写网址')
    if (!isWebUrl(String(params['url']))) return fail('操作「打开网址」：仅支持 http(s) 网址')
  }
  // open-app：路径必填（扩展名不做白名单——能落进这里的手已经只有用户 UI，
  // automations.* 是 AI 只读前缀；执行器同样不经 shell、无参数拼接面）
  if (descriptor.kind === 'open-app') {
    const params = isRecord(record['params']) ? record['params'] : {}
    if (isBlank(params['path'])) return fail('操作「打开应用」：必须填写应用路径')
  }
  // plugin-action：插件 id / 动作名必填；params 的 JSON 合法性由字段类型（json）校验
  if (descriptor.kind === 'plugin-action') {
    const params = isRecord(record['params']) ? record['params'] : {}
    if (isBlank(params['pluginId'])) return fail('操作「插件动作」：必须填写插件 id')
    if (isBlank(params['action'])) return fail('操作「插件动作」：必须填写动作名')
  }
  return { ok: true }
}

function validateParams(
  params: unknown,
  fields: AutomationDescriptorField[],
  scope: string,
): ValidationResult {
  if (!isRecord(params)) return fail(`${scope}：参数必须是对象`)
  for (const field of fields) {
    const value = params[field.key]
    const empty = value === undefined || value === null || value === ''
    if (empty) continue // 缺省字段由执行侧兜底；必填约束由组件级业务校验补
    switch (field.type) {
      case 'text':
        if (typeof value !== 'string') return fail(`${scope}：${field.label} 必须是文本`)
        if (value.length > 500) return fail(`${scope}：${field.label} 不能超过 500 个字符`)
        break
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          return fail(`${scope}：${field.label} 必须是数字`)
        }
        if (field.min !== undefined && value < field.min) {
          return fail(`${scope}：${field.label} 不能小于 ${field.min}`)
        }
        if (field.max !== undefined && value > field.max) {
          return fail(`${scope}：${field.label} 不能大于 ${field.max}`)
        }
        break
      case 'time':
        if (typeof value !== 'string' || parseClock(value) === undefined) {
          return fail(`${scope}：${field.label} 必须是 HH:mm 格式`)
        }
        break
      case 'weekdays':
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'number')) {
          return fail(`${scope}：${field.label} 必须是数字数组`)
        }
        if (value.some((item) => item < 0 || item > 6)) {
          return fail(`${scope}：${field.label} 只能是 0–6（0 = 周日）`)
        }
        break
      case 'select':
        if (
          typeof value !== 'string' ||
          field.options?.some((option) => option.value === value) !== true
        ) {
          return fail(`${scope}：${field.label} 的取值无效`)
        }
        break
      case 'json': {
        if (typeof value !== 'string') return fail(`${scope}：${field.label} 必须是 JSON 文本`)
        if (value.length > JSON_FIELD_MAX) {
          return fail(`${scope}：${field.label} 不能超过 8 KB`)
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(value)
        } catch {
          return fail(`${scope}：${field.label} 不是合法 JSON`)
        }
        if (!isRecord(parsed) || Array.isArray(parsed)) {
          return fail(`${scope}：${field.label} 必须是 JSON 对象`)
        }
        break
      }
    }
  }
  return { ok: true }
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === ''
}

/** 取一个非负整数（0 = 不限 / 未计）；非法或缺失一律回落 0（校验层已拦过非法值） */
function readNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return 0
  return Math.min(value, MAX_RUNS_MAX)
}

/**
 * 调用次数是否已用尽（v0.2.8，docs/13 §3.1）。
 *
 * `maxRuns` 为 0 / 缺省 = 不限，永远不算用尽。判据只有"已调用次数 ≥ 上限"一条，
 * **不做任何副作用**：引擎据此决定"要不要再跑一次 / 要不要顺手停用"，
 * 工具层（`tools/automation-tools.ts`）据此把"已用尽"如实呈现给模型 —— 判据只此一份。
 *
 * 入参只要这两个字段（不是整份定义）：判据只依赖它们，调用方（工具层的假件、单测）
 * 因此不必凑出一整份 `AutomationDefinition`。
 */
export function isRunsExhausted(
  definition: Pick<AutomationDefinition, 'maxRuns' | 'runCount'>,
): boolean {
  const maxRuns = definition.maxRuns ?? 0
  if (maxRuns <= 0) return false
  return (definition.runCount ?? 0) >= maxRuns
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function fail(error: string): ValidationResult {
  return { ok: false, error }
}

/** 归一化一份已通过校验的定义：裁字符串、补 enabled 缺省，返回干净形状。 */
export function normalizeDefinition(input: Record<string, unknown>): AutomationDefinition {
  const mode = input['mode'] === 'agent' ? 'agent' : 'normal'
  const trigger = input['trigger'] as Record<string, unknown>
  const definition: AutomationDefinition = {
    id: typeof input['id'] === 'string' ? input['id'] : '',
    name: String(input['name']).trim(),
    enabled: input['enabled'] === undefined ? true : input['enabled'] === true,
    mode,
    trigger: {
      kind: trigger['kind'] as AutomationTriggerKind,
      params: isRecord(trigger['params']) ? structuredClone(trigger['params']) : {},
    },
    // 调用次数（v0.2.8）：上限缺省 = 0（不限）；计数缺省 = 0。
    // 两个都只在"给了合法值"时取用，非法值已在 validateDefinition 里被拒。
    maxRuns: readNonNegativeInt(input['maxRuns']),
    runCount: readNonNegativeInt(input['runCount']),
    createdAt: typeof input['createdAt'] === 'string' ? input['createdAt'] : '',
    updatedAt: typeof input['updatedAt'] === 'string' ? input['updatedAt'] : '',
  }
  if (mode === 'agent') definition.prompt = String(input['prompt'] ?? '')
  if (mode === 'normal') {
    const rawActions = Array.isArray(input['actions']) ? input['actions'] : []
    definition.actions = rawActions.map((action) => {
      const record = isRecord(action) ? action : {}
      return {
        kind: record['kind'] as AutomationActionKind,
        params: isRecord(record['params']) ? structuredClone(record['params']) : {},
      }
    })
  }
  return definition
}
