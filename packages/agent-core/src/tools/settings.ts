/**
 * `set_setting` 工具（docs/06 §12）。
 *
 * 分层：本文件是**纯逻辑**——工具定义、参数校验、可写性预检、结果回填与脱敏。
 * 真实的配置读写由主进程实现（`apps/desktop/src/main/tools/settings-port.ts`），
 * 经构造参数 `port` 注入，因此内核既不依赖 Electron，也能在 Node 里完整单测
 * （`settings.test.ts`）。
 *
 * 安全边界（docs/06 §12）：
 * - `sensitivity: 'confirm'`，改配置属于敏感操作，复用确认卡片链路；
 * - 写入前**逐个**路径过 `port.writable`，有一个不可写就整体拒绝——绝不写一半；
 * - 回填值统一过 `redactValue`：路径疑似凭据一律 `***`，绝不把密文回显给模型；
 * - 端口抛出的异常就地转成工具错误，**不允许冒泡进工具循环**（那会中断整轮对话，
 *   正是「AI 改设置导致崩溃」的表现之一）。
 */
import { createNoopLogger, type Logger } from '@aurora/shared'
import type { ToolDefinition, ToolResult } from './registry.js'

/** 工具名固定：主进程装配层按它注册 / 摘除（step-02 §3）。 */
export const SETTINGS_TOOL_NAME = 'set_setting'

/** 单条 value 回显上限：再长就截断，避免一份配置刷爆上下文。 */
export const MAX_SETTING_VALUE_CHARS = 200
/** `list` 整体回填上限：超出后截断，并提示用 `group` 收窄。 */
export const MAX_SETTINGS_LIST_CHARS = 4_000
/** 截断时为尾部提示预留的字符数（保证最终 content 不超过整体上限）。 */
const TRUNCATION_RESERVE = 120
/** 路径疑似凭据 / 密文的特征：命中一律不回显值（docs/06 §12）。 */
const SENSITIVE_PATH_PATTERN = /apiKey|Enc|env|secret|token|key/i
/** 脱敏占位符（与日志、导出脱敏配置同一套口径）。 */
const REDACTED = '***'
/** 收窄 `list` 的示例，出现在截断提示与参数说明里。 */
const GROUP_EXAMPLE = 'group="agent.tools"'

export interface SettingsToolPort {
  /** 当前配置的可序列化快照（调用方负责脱敏：密文必须已被替换为空串） */
  snapshot(): Record<string, unknown>
  /** 读取一个路径的当前值；路径不可读时返回 undefined */
  read(path: string): unknown
  /** 路径是否可写；不可写时给出中文原因 */
  writable(path: string): { ok: true } | { ok: false; reason: string }
  /** 把多个路径的改动写回；返回实际生效的路径与人类可读摘要 */
  write(paths: Array<{ path: string; value: unknown }>): Promise<SettingsWriteOutcome>
}

export interface SettingsWriteOutcome {
  ok: boolean
  /** 失败原因（ok=false 时必填） */
  message: string
  /** 实际被改动的路径（ok=true 时用于回填与审计） */
  applied: string[]
}

export interface SettingsToolOptions {
  port: SettingsToolPort
  logger?: Logger
}

export function createSettingsTool(options: SettingsToolOptions): ToolDefinition {
  const port = options.port
  const logger = options.logger ?? createNoopLogger()

  return {
    name: SETTINGS_TOOL_NAME,
    description:
      '读取或修改 Aurora 自身的配置。先用 action=list 查可写字段与当前值（字段多时用 group 收窄，' +
      `例如 ${GROUP_EXAMPLE}），action=get 读单个字段，action=set 批量写入（values 为 { path, value } 数组）。` +
      '修改立即生效，无需重启。可写范围：模型 provider 的 model / reasoningEffort / temperature，' +
      '语音 TTS（tts.enabled / active / autoRead / maxChars）与语音输入 STT（stt.enabled / active），' +
      '生图（imagegen.enabled / active），提示条（general.edgeBar.*）与「显示思考过程」（general.chat.showThinking），' +
      '模式切换与参数（modes.current / modes.work.workspaceDir / modes.classroom.*），' +
      '工具开关与参数（agent.tools.*），技能（skills.userDir / skills.disabled），勿扰时段（advanced.quietHours）。' +
      '凭据（API Key 等）、代理、窗口位置、Schema 版本与开机自启 / 全局快捷键等敏感字段不可修改：' +
      '命中黑名单或路径不被 Schema 识别时会被整体拒绝（只要有一个字段不可写，本次一个字段都不会写入）。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'list', 'set'],
          description:
            'list：列出全部可写字段与当前值（可用 group 收窄）；get：读取单个字段；set：批量写入字段',
        },
        path: {
          type: 'string',
          description: 'action=get 要读取的配置路径（点分，如 agent.tools.enabled）',
        },
        group: {
          type: 'string',
          description: 'action=list 的路径前缀，如 agent.tools；缺省返回全部可写字段',
        },
        values: {
          type: 'array',
          description: 'action=set 要写入的字段列表；value 只支持字符串 / 数字 / 布尔',
          items: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: '配置路径（点分，如 agent.tools.terminal.timeoutMs）',
              },
              value: {
                type: ['string', 'number', 'boolean'],
                description: '新值（必须与 Schema 的类型一致，否则整体写入失败）',
              },
            },
            required: ['path', 'value'],
            additionalProperties: false,
          },
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    sensitivity: 'confirm',
    execute: async (input, ctx): Promise<ToolResult> => {
      try {
        const record = asRecord(input)
        const action = readNonEmptyString(record, 'action')
        if (action === undefined) {
          return fail('缺少参数 action（可用：get / list / set）。')
        }
        switch (action) {
          case 'get':
            return getSetting(port, record)
          case 'list':
            return listSettings(port, record)
          case 'set':
            return await setSettings({ port, logger, sessionId: ctx.sessionId, record })
          default:
            return fail(`未知 action：${action}（可用：get / list / set）。`)
        }
      } catch (error) {
        // 兜底：端口抛错也绝不冒泡进工具循环（那会中断整轮对话）
        logger.warn('set_setting 执行失败', { error: describeError(error) })
        return fail(`配置操作失败：${describeError(error)}`)
      }
    },
  }
}

/**
 * 值回显前的脱敏（docs/06 §12）。
 *
 * 路径命中 `apiKey|Enc|env|secret|token|key` 一律返回 `***`（连长度都不透露）；
 * 其余按可读文本渲染，超过 `MAX_SETTING_VALUE_CHARS` 截断。
 */
export function redactValue(path: string, value: unknown): string {
  if (isSensitiveSettingPath(path)) return REDACTED
  return truncateValue(describeValue(value))
}

/** 路径是否疑似凭据 / 密文（命中即不回显值）。 */
export function isSensitiveSettingPath(path: string): boolean {
  return SENSITIVE_PATH_PATTERN.test(path)
}

// ───────────────────────── action: get ─────────────────────────

function getSetting(
  port: SettingsToolPort,
  record: Record<string, unknown> | undefined,
): ToolResult {
  const path = readNonEmptyString(record, 'path')
  if (path === undefined) {
    return fail('缺少参数 path（要读取的配置路径）。')
  }
  // 读也要过可写性：凭据与未知路径一律不回读，连「有没有这个字段」都不告诉模型
  const writable = port.writable(path)
  if (!writable.ok) {
    return { content: '该路径不可读', isError: true, summary: '该路径不可读' }
  }
  const value = port.read(path)
  return { content: `${path} = ${redactValue(path, value)}`, summary: `读取 ${path}` }
}

// ───────────────────────── action: list ─────────────────────────

function listSettings(
  port: SettingsToolPort,
  record: Record<string, unknown> | undefined,
): ToolResult {
  const rawGroup = readNonEmptyString(record, 'group')
  const group = rawGroup === undefined ? undefined : normalizeGroup(rawGroup)
  const entries = flattenSnapshot(port.snapshot()).filter(
    (entry) =>
      (group === undefined || matchesGroup(entry.path, group)) && port.writable(entry.path).ok,
  )

  if (entries.length === 0) {
    return {
      content:
        group === undefined ? '没有可写的配置字段。' : `没有匹配 group="${group}" 的可写配置字段。`,
      summary: '没有可写字段',
    }
  }

  const scope = group === undefined ? '' : `，group="${group}"`
  const header = `可写配置字段（共 ${entries.length} 项${scope}；写回用 action=set，values=[{ path, value }]）：`
  const lines = entries.map((entry) => `${entry.path} = ${redactValue(entry.path, entry.value)}`)
  const full = [header, ...lines].join('\n')
  if (full.length <= MAX_SETTINGS_LIST_CHARS) {
    return { content: full, summary: `列出 ${entries.length} 个可写字段` }
  }

  // 超长：只保留放得下的前缀，尾部提示用 group 收窄（否则模型会把上下文刷爆）
  const kept: string[] = [header]
  let chars = header.length
  for (const line of lines) {
    if (chars + line.length + 1 > MAX_SETTINGS_LIST_CHARS - TRUNCATION_RESERVE) break
    kept.push(line)
    chars += line.length + 1
  }
  const shown = kept.length - 1
  kept.push(
    `…（已截断，共 ${entries.length} 个字段，仅显示前 ${shown} 个；请用 group 参数收窄范围，例如 ${GROUP_EXAMPLE}）`,
  )
  return {
    content: kept.join('\n'),
    summary: `列出 ${shown} / ${entries.length} 个可写字段（已截断）`,
  }
}

// ───────────────────────── action: set ─────────────────────────

interface SetSettingsArgs {
  port: SettingsToolPort
  logger: Logger
  sessionId: string
  record: Record<string, unknown> | undefined
}

async function setSettings(args: SetSettingsArgs): Promise<ToolResult> {
  const { port, logger, sessionId, record } = args
  const parsed = parseValues(record)
  if ('error' in parsed) return fail(parsed.error)
  const items = parsed.items

  // 先逐个预检：有一个不可写就整体拒绝，绝不写一半（docs/06 §12）
  for (const item of items) {
    const check = port.writable(item.path)
    if (!check.ok) {
      logger.warn('配置写入被拒绝', { sessionId, path: item.path, reason: check.reason })
      return fail(`不能修改 ${item.path}：${check.reason}`, '配置写入被拒绝')
    }
  }

  // 旧值必须在写之前取（写回填要用它做对比）
  const before = new Map<string, unknown>(items.map((item) => [item.path, port.read(item.path)]))
  logger.info('Agent 请求修改配置', { sessionId, paths: items.map((item) => item.path) })

  let outcome: SettingsWriteOutcome
  try {
    // 只写一次：聚合语义与凭据抽取由主进程端口负责
    outcome = await port.write(items.map((item) => ({ path: item.path, value: item.value })))
  } catch (error) {
    logger.warn('配置写入失败', {
      sessionId,
      paths: items.map((item) => item.path),
      error: describeError(error),
    })
    return fail(`写入失败：${describeError(error)}`, '配置写入失败')
  }

  if (!outcome.ok) {
    const message = outcome.message === '' ? '配置写入失败（端口未给出原因）' : outcome.message
    logger.warn('配置写入未生效', { sessionId, message })
    return fail(message, '配置写入失败')
  }

  const applied = new Set(outcome.applied)
  const lines = items.map(
    (item) =>
      `已修改：${item.path} = ${redactValue(item.path, item.value)}` +
      `（旧值：${redactValue(item.path, before.get(item.path))}）`,
  )
  if (applied.size > 0) {
    const missed = items.filter((item) => !applied.has(item.path)).map((item) => item.path)
    if (missed.length > 0) lines.push(`未生效：${missed.join('、')}`)
  }
  return { content: lines.join('\n'), summary: `已修改 ${items.length} 项配置` }
}

type ParsedValues =
  { items: Array<{ path: string; value: string | number | boolean }> } | { error: string }

function parseValues(record: Record<string, unknown> | undefined): ParsedValues {
  const raw = record?.['values']
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: '缺少要修改的字段：参数 values 必须是非空数组，元素形如 { path, value }。' }
  }
  const items: Array<{ path: string; value: string | number | boolean }> = []
  for (let index = 0; index < raw.length; index += 1) {
    const entry = asRecord(raw[index])
    const path = readNonEmptyString(entry, 'path')
    if (path === undefined) {
      return { error: `values[${index}] 非法：缺少非空字符串字段 path。` }
    }
    const value = readScalar(entry?.['value'])
    if (value === undefined) {
      return { error: `values[${index}] 非法：value 只能是字符串 / 数字 / 布尔。` }
    }
    items.push({ path, value })
  }
  return { items }
}

/** 只接受配置能承载的标量：对象 / 数组 / null / NaN 一律拒绝，让模型改成合法写法。 */
function readScalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

// ───────────────────────── 快照摊平与渲染 ─────────────────────────

interface SettingEntry {
  path: string
  value: unknown
}

/** 把配置快照摊平成 `a.b.c` → 叶子值；数组与标量都算叶子，空对象丢弃。 */
function flattenSnapshot(snapshot: Record<string, unknown>, prefix = ''): SettingEntry[] {
  const entries: SettingEntry[] = []
  for (const [key, value] of Object.entries(snapshot)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (!isPlainObject(value)) {
      entries.push({ path, value })
      continue
    }
    const nested = flattenSnapshot(value, path)
    if (nested.length > 0) entries.push(...nested)
  }
  return entries
}

/** `group` 是路径前缀：`agent.tools` 命中自身与 `agent.tools.*`。 */
function matchesGroup(path: string, group: string): boolean {
  return path === group || path.startsWith(`${group}.`)
}

/** 容错：模型可能带尾点（`agent.tools.`）或多写空白 */
function normalizeGroup(group: string): string {
  return group.replace(/\.+$/, '')
}

function describeValue(value: unknown): string {
  if (value === undefined) return '（未设置）'
  if (value === null) return 'null'
  if (typeof value === 'string') return value === '' ? '（空字符串）' : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    const json = JSON.stringify(value)
    return json === undefined ? String(value) : json
  } catch {
    return String(value)
  }
}

function truncateValue(text: string): string {
  if (text.length <= MAX_SETTING_VALUE_CHARS) return text
  const omitted = text.length - MAX_SETTING_VALUE_CHARS
  return `${safeHead(text, MAX_SETTING_VALUE_CHARS)}…（已截断 ${omitted} 字符）`
}

/** 不在代理对中间切开（emoji 等非 BMP 字符），否则尾部会出现替换字符。 */
function safeHead(text: string, length: number): string {
  const code = text.charCodeAt(length - 1)
  const isHighSurrogate = code >= 0xd800 && code <= 0xdbff
  return text.slice(0, isHighSurrogate ? length - 1 : length)
}

function fail(content: string, summary = '配置操作失败'): ToolResult {
  return { content, isError: true, summary }
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  return input as Record<string, unknown>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 必填字符串：非字符串或纯空白一律视为缺参（**不触碰端口**） */
function readNonEmptyString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
