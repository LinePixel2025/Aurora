/**
 * 会话自动标题（docs/06 §4）。
 *
 * 首条用户需求发出后异步生成标题：不阻塞主回复、不新增消息、不进会话历史。
 * 失败时保留 pending，后续用户发送会再次尝试；成功落盘后由装配层广播
 * `chat:sessionTitleChanged`。
 */
import { basename } from 'node:path'
import type { AgentProviderFactory, ChatEvent, StoredMessage } from '@aurora/agent-core'
import type { Logger } from '@aurora/shared'
import { createNoopLogger } from '@aurora/shared'

export const TITLE_PROMPT_MARKER = 'AURORA_SESSION_TITLE'
export const TITLE_TARGET_MIN = 6
export const TITLE_TARGET_MAX = 14
const TITLE_HARD_MAX = 24
const TITLE_SOURCE_MAX = 2_000

export interface SessionTitleState {
  title?: string
  pending: boolean
}

/** 标题服务需要的最小会话存储面（SessionStore 结构化满足）。 */
export interface SessionTitleStore {
  titleStateOf(sessionId: string): Promise<SessionTitleState>
  markTitlePending(sessionId: string): Promise<boolean>
  setTitle(sessionId: string, title: string): Promise<boolean>
  get(sessionId: string): Promise<StoredMessage[]>
}

export interface SessionTitleServiceOptions {
  sessions: SessionTitleStore
  provider: AgentProviderFactory
  logger?: Logger
  /** 用户可见会话判定；缺省排除 `awareness-` / `auto-` / `-sub`。 */
  isEligible?: (sessionId: string) => boolean
  /** 标题落盘成功后的回调（装配层广播 IPC）。 */
  onTitle?: (event: { sessionId: string; title: string }) => void
}

/**
 * 可见会话判定：后台自感知、自动化与 task 子代理都不生成标题。
 *
 * Center / quick / 普通 `chat-*` / `main` 都保留 —— 它们会出现在至少一个用户界面里。
 */
export function isAutoTitleSession(sessionId: string): boolean {
  if (sessionId.startsWith('awareness-')) return false
  if (sessionId === 'auto' || sessionId.startsWith('auto-')) return false
  if (sessionId.endsWith('-sub')) return false
  return true
}

/**
 * 构造标题输入：正常消息取用户文本；纯附件消息退到附件文件名。
 * 不把附件正文或图片送进标题请求，避免额外读盘与放大隐私面。
 */
export function buildTitleSource(text: string, attachments: readonly string[] = []): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed !== '') return trimmed.slice(0, TITLE_SOURCE_MAX)
  const names = attachments
    .map((path) => basename(path.trim()))
    .filter((name) => name !== '')
    .slice(0, 5)
  return names.join('、').slice(0, TITLE_SOURCE_MAX)
}

/** 标题生成提示词；标记行供离线桩模型分流，真实模型按正文要求只输出标题。 */
export function buildTitlePrompt(source: string): string {
  return [
    TITLE_PROMPT_MARKER,
    '请把下面这条用户需求概括成会话标题。',
    `要求：${TITLE_TARGET_MIN}–${TITLE_TARGET_MAX} 个汉字；只输出标题；不要标点、引号、客套话或解释；`,
    '保留文件名、产品名、技术名等专有名词。',
    '',
    '【用户需求】',
    source,
  ].join('\n')
}

/**
 * 清洗模型输出：只接受单行、非空、硬上限 24 个字符的标题。
 *
 * 目标长度在提示词里约束；后处理只负责阻绝整段解释、换行、Markdown 包装与标点，
 * 超长输出直接判失败，回退已有摘要标题。
 */
export function normalizeGeneratedTitle(raw: string): string | undefined {
  const withoutMarker = raw.replaceAll(TITLE_PROMPT_MARKER, '')
  const line =
    withoutMarker
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => item !== '') ?? ''
  if (line === '') return undefined
  const withoutLabel = line.replace(/^(?:会话)?标题\s*[:：]\s*/u, '')
  const cleaned = withoutLabel
    .replace(/^[#*"'“”‘’《》【】]+/u, '')
    .replace(/[#*"'“”‘’《》【】]+$/u, '')
    .replace(/[^\p{L}\p{N}._-]+/gu, '')
    .trim()
  if (cleaned === '') return undefined
  if ([...cleaned].length > TITLE_HARD_MAX) return undefined
  return cleaned
}

/**
 * 自动标题服务。`schedule` 用于热路径（立即返回），`generate` 供单测直接 await。
 */
export class SessionTitleService {
  private readonly sessions: SessionTitleStore
  private readonly provider: AgentProviderFactory
  private readonly logger: Logger
  private readonly isEligible: (sessionId: string) => boolean
  private readonly onTitle: ((event: { sessionId: string; title: string }) => void) | undefined
  private readonly inFlight = new Set<string>()

  constructor(options: SessionTitleServiceOptions) {
    this.sessions = options.sessions
    this.provider = options.provider
    this.logger = options.logger ?? createNoopLogger()
    this.isEligible = options.isEligible ?? isAutoTitleSession
    this.onTitle = options.onTitle
  }

  /** 请求热路径入口：不 await，失败只写 debug，绝不影响聊天。 */
  schedule(sessionId: string, firstUserText?: string, attachments: readonly string[] = []): void {
    void this.generate(sessionId, firstUserText, attachments)
  }

  /** 执行一次标题生成；返回是否真的写入了标题。 */
  async generate(
    sessionId: string,
    firstUserText?: string,
    attachments: readonly string[] = [],
  ): Promise<boolean> {
    if (!this.isEligible(sessionId) || this.inFlight.has(sessionId)) return false
    this.inFlight.add(sessionId)
    try {
      const state = await this.sessions.titleStateOf(sessionId)
      if (state.title !== undefined && state.title.trim() !== '') return false
      if (!state.pending && firstUserText === undefined) return false
      if (!(await this.sessions.markTitlePending(sessionId))) return false

      const source = await this.resolveSource(sessionId, firstUserText, attachments)
      if (source === '') return false

      const config = this.provider.create({ sessionId })
      if (config === undefined) return false

      let raw = ''
      for await (const event of config.provider.chat({
        model: config.model,
        messages: [{ role: 'user', content: buildTitlePrompt(source) }],
      })) {
        if (event.type === 'text') raw += event.delta
        if (event.type === 'error') throw new Error(event.message)
      }
      const title = normalizeGeneratedTitle(raw)
      if (title === undefined) {
        this.logger.debug('标题输出无效，保留回退标题', { sessionId })
        return false
      }
      const written = await this.sessions.setTitle(sessionId, title)
      if (written) this.onTitle?.({ sessionId, title })
      return written
    } catch (error) {
      this.logger.debug('会话标题生成失败，保留回退标题', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    } finally {
      this.inFlight.delete(sessionId)
    }
  }

  private async resolveSource(
    sessionId: string,
    firstUserText: string | undefined,
    attachments: readonly string[],
  ): Promise<string> {
    const provided = firstUserText === undefined ? '' : buildTitleSource(firstUserText, attachments)
    if (provided !== '') return provided
    const messages = await this.sessions.get(sessionId)
    const firstUser = messages.find((message) => message.role === 'user')
    if (firstUser === undefined) return ''
    return buildTitleSource(firstUser.content, firstUser.images ?? [])
  }
}

/** 标题服务与 provider 共享的 ChatEvent 类型出口（避免测试从内核包直接 import）。 */
export type SessionTitleChatEvent = ChatEvent
