/**
 * `client.event` 的聚合（docs/12 §4.2 / §10）。
 *
 * 每个 (clientId, sessionId) 一份 SessionState（未见过的会话补建空壳再应用，不再丢弃 ——
 * 丢弃会让「刷新页面后打开的会话」永远只有历史、看不到正在进行的事件）。
 * 聚合是**原地增量**：text 追加、reasoning 追加、tool 按 call.id 合并、job 一张卡覆盖、
 * subagent 按 callId 覆盖。渲染层按 `item` 身份缓存 Markdown / 折叠态，所以除了新增条目，
 * 不要整体替换数组或条目对象。
 */
import type { AgentEvent } from '@aurora/shared'
import { ensureSessionState, state, type ChatItem, type SessionState } from './store'
import { applyUsage } from './usage'

function ensureAssistant(session: SessionState, messageId: string): ChatItem {
  const existing = session.items.find((item) => item.kind === 'assistant' && item.id === messageId)
  if (existing) return existing
  const created: ChatItem = {
    id: messageId,
    kind: 'assistant',
    content: '',
    tools: [],
    streaming: true,
    startedAt: Date.now(),
  }
  session.items.push(created)
  return created
}

/** 工具输入的单行摘要：过长截断，工具行里不堆全量 JSON（docs/12 §10） */
export function summarizeInput(input: unknown): string {
  if (input === undefined || input === null) return ''
  if (typeof input === 'string') return input
  try {
    const json = JSON.stringify(input) ?? String(input)
    return json.length > 160 ? `${json.slice(0, 160)}…` : json
  } catch {
    return String(input)
  }
}

export function applyEvent(clientId: string, sessionId: string, event: AgentEvent): void {
  // usage 事件独立于消息流：会话未见（历史 center- 会话事件回落）也照常累计
  if (event.type === 'usage') {
    const entry = state.clients.get(clientId)
    if (entry) applyUsage(entry, sessionId, event)
    return
  }
  const session = ensureSessionState(clientId, sessionId)
  switch (event.type) {
    case 'user-message': {
      /*
       * 回显配对（P2-18）：本地发送时已乐观插入一条 `local-` 气泡，服务器随后把同一条
       * `user-message` 广播回来 —— 只能把这**一条**事件配对掉，不能"内容已存在就跳过"
       * （先后发两条相同内容的消息时，第二条会被当成第一条的回显整条丢掉）。
       * 配对口径与 mergeHistory 一致：内容 + 出现次数，逐条抵消且只认**本地乐观气泡**；
       * 配对成功就把气泡就地升级成带 seq 的权威 id，同一条事件重复到达时按 id 幂等。
       */
      if (session.items.some((item) => item.id === `user-${event.seq}`)) break
      const optimistic = session.items.find(
        (item) =>
          item.kind === 'user' && item.id.startsWith('local-') && item.content === event.content,
      )
      if (optimistic) {
        optimistic.id = `user-${event.seq}`
        break
      }
      session.items.push({
        id: `user-${event.seq}`,
        kind: 'user',
        content: event.content,
        tools: [],
      })
      break
    }
    case 'text': {
      const item = ensureAssistant(session, event.messageId)
      item.content += event.delta
      break
    }
    case 'reasoning': {
      const item = ensureAssistant(session, event.messageId)
      item.reasoning = (item.reasoning ?? '') + event.delta
      item.reasoningAt = Date.now()
      break
    }
    case 'tool': {
      const item = ensureAssistant(session, event.messageId)
      const call = event.call
      const existing = item.tools.find((tool) => tool.id === call.id)
      if (existing) {
        // 状态迁移到终态时补记结束时刻（工具行的耗时列用；历史回放条目没有这两个值）
        if (existing.state === 'running' && call.state !== 'running') existing.endedAt = Date.now()
        existing.state = call.state
        if (call.outputSummary) existing.outputSummary = call.outputSummary
        if (call.subagent) existing.subagent = call.subagent
      } else {
        item.tools.push({
          id: call.id,
          name: call.name,
          state: call.state,
          inputSummary: summarizeInput(call.input),
          ...(call.input === undefined ? {} : { input: call.input }),
          ...(call.outputSummary === undefined ? {} : { outputSummary: call.outputSummary }),
          ...(call.subagent === undefined ? {} : { subagent: call.subagent }),
          startedAt: Date.now(),
          ...(call.state === 'running' ? {} : { endedAt: Date.now() }),
        })
      }
      break
    }
    case 'job': {
      // 任务清单卡：一个会话只保留最新一条 job 摘要，后续事件原地覆盖
      const existing = session.items.find((item) => item.kind === 'job')
      if (existing) existing.job = event.job
      else
        session.items.push({
          id: `job-${event.job.id}`,
          kind: 'job',
          content: '',
          tools: [],
          job: event.job,
        })
      break
    }
    case 'subagent': {
      // 子代理快照：**优先挂到对应的工具行内部**（与桌面端同构：`task` 工具卡里展开看对话），
      // 找不到配套工具行（事件先到 / 历史里没有该调用）才落一张独立卡兜底。
      for (const item of session.items) {
        const tool = item.tools.find((entry) => entry.id === event.callId)
        if (tool !== undefined) {
          tool.subagent = event.subagent
          return
        }
      }
      const existing = session.items.find(
        (item) => item.kind === 'subagent' && item.subagent?.callId === event.callId,
      )
      if (existing) existing.subagent = event.subagent
      else
        session.items.push({
          id: `subagent-${event.callId}`,
          kind: 'subagent',
          content: '',
          tools: [],
          subagent: event.subagent,
        })
      break
    }
    case 'done': {
      session.pending = false
      const now = Date.now()
      for (const item of session.items) {
        item.streaming = false
        if (item.kind === 'assistant' && item.endedAt === undefined) item.endedAt = now
      }
      break
    }
    case 'error': {
      session.pending = false
      session.items.push({
        id: `error-${event.seq}`,
        kind: 'error',
        content: event.message,
        code: event.code,
        tools: [],
      })
      break
    }
    default:
      // queued / 未知类型：不渲染（协议只增不改）
      break
  }
}
