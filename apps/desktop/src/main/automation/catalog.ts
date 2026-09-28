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

// ───────────────────────── 定义校验（保存入口的唯一合法化层） ─────────────────────────

export interface ValidationResult {
  ok: boolean
  error?: string
}

const NAME_MAX = 60
const PROMPT_MAX = 8000
const MAX_ACTIONS = 10

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
  return validateParams(record['params'], descriptor.fields, `触发器「${descriptor.label}」`)
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
    }
  }
  return { ok: true }
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === ''
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
