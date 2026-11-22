/**
 * Aurora 起草子代理（v0.8.1，docs/06 §19.6）。
 *
 * 设置页「新建子代理」弹窗里，用户用一句话描述想要的子代理，这里让模型生成一条
 * **草稿**（名称 / 用途说明 / 指令 / 工具档），回给渲染层预填表单。
 *
 * 三条边界：
 * - **只回草稿、不写配置**：用户的确认动作仍走 `settings:update({ agent: { subagents } })`，
 *   本服务不碰 `SettingsStore`，也不落会话历史；
 * - 与自动标题 / 智慧提醒汇总同一套「后台裸 provider 请求」形态：一次普通 `chat`，
 *   提示词首行带 `SUBAGENT_DRAFT_PROMPT_MARKER`（离线桩据此分流，不进对话请求计数）；
 * - 模型输出不可信：只认一个 JSON 对象，字段按 Schema 上限裁剪、`access` 非法回落 `read`；
 *   解析失败返回可读错误（不把原始输出拼进错误文案，也不静默给个空草稿）。
 */
import type { AgentProviderFactory, ChatEvent } from '@aurora/agent-core'
import type { Logger, SubagentAccess, SubagentDraft } from '@aurora/shared'
import { createNoopLogger } from '@aurora/shared'

/** 提示词首行标记：离线桩（`smoke-llm.ts`）据此把起草请求分流出去 */
export const SUBAGENT_DRAFT_PROMPT_MARKER = 'AURORA_SUBAGENT_DRAFT'

/** 用户需求正文上限：一句话需求，超长截断（不把整段文档塞进模型） */
const DRAFT_SOURCE_MAX = 2_000
/** 与 `SubagentSchema` 的上限逐字一致（见 shared config/schema.ts） */
const NAME_MAX = 40
const DESCRIPTION_MAX = 200
const INSTRUCTIONS_MAX = 4_000
/** 名册里列给模型的已存在名称上限（只是防重名提示，不需要全量） */
const EXISTING_NAMES_MAX = 20

/** 起草结果：成功带草稿，失败带可直接展示给用户的中文原因 */
export type SubagentDraftOutcome =
  { ok: true; draft: SubagentDraft } | { ok: false; message: string }

/** 构造起草提示词；导出供单测断言「标记 / 需求 / 已存在名称」都在里面。 */
export function buildSubagentDraftPrompt(
  description: string,
  existingNames: readonly string[] = [],
): string {
  const source = description.replace(/\s+/g, ' ').trim().slice(0, DRAFT_SOURCE_MAX)
  const taken = existingNames
    .map((name) => name.trim())
    .filter((name) => name !== '')
    .slice(0, EXISTING_NAMES_MAX)
  return [
    SUBAGENT_DRAFT_PROMPT_MARKER,
    '你是在 Aurora 设置页替用户起草一个「子代理」定义。',
    '子代理是主代理按需派发的独立小助手：它看不到主对话、不向用户提问、完成后只回一份报告。',
    '',
    '只输出一个 JSON 对象，不要 Markdown 代码围栏、不要解释、不要在 JSON 前后写任何文字。字段：',
    `- "name"：展示名，2–12 个汉字或一个英文词，最多 ${NAME_MAX} 个字符；`,
    `- "description"：什么时候派它（最多 ${DESCRIPTION_MAX} 字），写清适用与不适用的场合，` +
      '主代理据此选型；',
    `- "instructions"：子代理的系统提示词（最多 ${INSTRUCTIONS_MAX} 字），写清角色、工作方式、` +
      '输出要求；不要写「看不到父对话 / 不向用户提问」——这几条由系统统一追加；',
    '- "access"：工具权限档，只能是 "read"（默认，只读）、"write"（可改文件）或 ' +
      '"execute"（可改文件并执行命令）；用户没明确要求改文件 / 跑命令时用 "read"。',
    '',
    taken.length === 0
      ? '（当前还没有其他子代理。）'
      : `（已存在的子代理：${taken.join('、')}；新名字不要与它们重复。）`,
    '',
    '【用户想要的子代理】',
    source,
  ].join('\n')
}

/** 从模型输出里取出 JSON 对象：容忍代码围栏与前后废话，只取首个 `{` 到末个 `}` */
function extractJsonObject(raw: string): unknown {
  const text = raw.replaceAll(SUBAGENT_DRAFT_PROMPT_MARKER, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown
  } catch {
    return undefined
  }
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim()
}

/** 名称清洗：去掉模型偶尔带上的引号 / 代码标记，再按上限截断（按 UTF-16 长度，与 Schema 同口径） */
function normalizeName(raw: string): string {
  const cleaned = raw
    .replace(/^[`'"#*“”‘’《》【】]+/u, '')
    .replace(/[`'"#*“”‘’《》【】]+$/u, '')
    .trim()
  return cleaned.slice(0, NAME_MAX)
}

/** 用途说明 / 指令：按 UTF-16 长度截断到 Schema 上限（含 emoji 时也不会超出） */
function normalizeText(raw: string, max: number): string {
  return raw.trim().slice(0, max)
}

/** 权限档：英文三档直接认，另兼容模型偶尔回的中文说法；其余一律回落 `read` */
export function normalizeDraftAccess(raw: string): SubagentAccess {
  const value = raw.trim().toLowerCase()
  if (value === 'read' || value.includes('只读')) return 'read'
  if (value === 'write' || value.includes('可写') || value.includes('读写')) return 'write'
  if (value === 'execute' || value.includes('执行')) return 'execute'
  return 'read'
}

/** 解析模型输出为草稿；任何必填字段缺失 / 为空都判失败（不返回半截草稿） */
export function parseSubagentDraft(raw: string): SubagentDraft | undefined {
  const parsed = extractJsonObject(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const name = normalizeName(readString(record, 'name'))
  const description = normalizeText(readString(record, 'description'), DESCRIPTION_MAX)
  const instructions = normalizeText(readString(record, 'instructions'), INSTRUCTIONS_MAX)
  if (name === '' || description === '' || instructions === '') return undefined
  return {
    name,
    description,
    instructions,
    access: normalizeDraftAccess(readString(record, 'access')),
  }
}

export interface SubagentDraftServiceOptions {
  provider: AgentProviderFactory
  logger?: Logger
  /** 已存在的子代理名称（装配层从 `agent.subagents` 现读；缺省空 = 不提示重名） */
  existingNames?: () => readonly string[]
}

/**
 * 起草服务。刻意**不缓存**、不并发去重：这是用户点一下才发生的一次性动作，
 * 连点两次最多多花一次小请求；加去重只会让第二次点击静默无响应。
 */
export class SubagentDraftService {
  private readonly provider: AgentProviderFactory
  private readonly logger: Logger
  private readonly existingNames: () => readonly string[]

  constructor(options: SubagentDraftServiceOptions) {
    this.provider = options.provider
    this.logger = options.logger ?? createNoopLogger()
    this.existingNames = options.existingNames ?? (() => [])
  }

  async draft(description: string): Promise<SubagentDraftOutcome> {
    const source = description.replace(/\s+/g, ' ').trim()
    if (source === '') return { ok: false, message: '请先描述你想要的子代理' }

    const config = this.provider.create()
    if (config === undefined) {
      return {
        ok: false,
        message: '还没有可用的 AI 模型：请先在「设置 → AI 模型」配置并选中一个模型',
      }
    }

    let raw = ''
    try {
      for await (const event of config.provider.chat({
        model: config.model,
        messages: [
          {
            role: 'user',
            content: buildSubagentDraftPrompt(source, this.existingNames()),
          },
        ],
      })) {
        if (event.type === 'text') raw += event.delta
        if (event.type === 'error') throw new Error(event.message)
      }
    } catch (error) {
      this.logger.debug('子代理草稿生成失败', {
        error: error instanceof Error ? error.message : String(error),
      })
      return { ok: false, message: '生成草稿失败：模型请求没有完成，请再试一次' }
    }

    const draft = parseSubagentDraft(raw)
    if (draft === undefined) {
      this.logger.debug('子代理草稿输出无法解析', { chars: raw.length })
      return { ok: false, message: '生成草稿失败：模型返回的内容不是有效定义，请换个描述再试' }
    }
    this.logger.info('已生成子代理草稿', { access: draft.access, chars: draft.instructions.length })
    return { ok: true, draft }
  }
}

/** 与 `session-title.ts` 同款出口：避免测试从内核包直接 import ChatEvent */
export type SubagentDraftChatEvent = ChatEvent
