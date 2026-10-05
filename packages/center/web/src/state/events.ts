/**
 * `client.event` 的聚合（docs/12 §4.2 / §10）。
 *
 * 每个 (clientId, sessionId) 一份 SessionState（未见过的会话补建空壳再应用，不再丢弃 ——
 * 丢弃会让「刷新页面后打开的会话」永远只有历史、看不到正在进行的事件）。
 * 聚合是**原地增量**：text 追加、reasoning 追加、tool 按 call.id 合并、job 一张卡覆盖、
 * subagent 按 callId 覆盖。渲染层按 `item` 身份缓存 Markdown / 折叠态，所以除了新增条目，
 * 不要整体替换数组或条目对象。
 *
 * **流式增量按帧合并**（2026-10-02）：`text` / `reasoning` 不再每条 WS 帧直接改 `items`，
 * 而是入队到共享的 `createDeltaBuffer`（与桌面端同一份实现，docs/07 §2.3），一帧只 apply
 * 一次 —— 一个 token 就是一条 WS 帧，100+ token/s 时渲染层每秒被叫醒上百次，每次都要重跑
 * 组件渲染 + Markdown 全量重解析 + `innerHTML` 替换。四条语义（同 key 合并 / 一帧一次 /
 * 顺序保持 / **终态前先 flush**）见 `deltaBuffer.ts`。
 */
import type { AgentEvent } from '@aurora/shared'
import { createDeltaBuffer } from '@aurora/shared/browser'
import { ensureSessionState, sessionKey, state, type ChatItem, type SessionState } from './store'
import { applyUsage } from './usage'

/** 一条待合并的流式增量（同一条消息的 text / reasoning 各自按入队顺序累加） */
type PendingDelta = { kind: 'text' | 'reasoning'; requestId: string; delta: string }

/** 缓冲键：会话与消息三元组用 NUL 分隔（会话 id 是 `center-*` / uuid，不含 NUL） */
function streamKeyOf(clientId: string, sessionId: string, messageId: string): string {
  return `${clientId}\u0000${sessionId}\u0000${messageId}`
}

/**
 * 按帧合并缓冲：apply 时才按 id 找回条目（**不能**在入队时找 —— 消息条目可能还没建出来，
 * 提前解析会把「入队顺序」换成「到达顺序」，帧边界上的插入位置就会漂）。
 */
const streamBuffer = createDeltaBuffer<PendingDelta>(
  (batches) => {
    for (const batch of batches) {
      const [clientId, sessionId, messageId] = batch.key.split('\u0000')
      if (clientId === undefined || sessionId === undefined || messageId === undefined) continue
      const session = state.sessions.get(sessionKey(clientId, sessionId))
      if (session === undefined) continue
      const requestId = batch.values[0]?.requestId ?? ''
      const item = ensureAssistant(session, messageId, requestId)
      for (const value of batch.values) {
        if (value.kind === 'text') {
          item.content += value.delta
          continue
        }
        item.reasoning = (item.reasoning ?? '') + value.delta
        item.reasoningAt = Date.now()
      }
    }
  },
  {
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (handle) => window.cancelAnimationFrame(handle),
  },
)

/** 立即应用已入队的增量（终态事件 / 历史合并之前调用，见 deltaBuffer 的语义 4） */
export function flushStreamDeltas(): void {
  streamBuffer.flush()
}

function ensureAssistant(session: SessionState, messageId: string, requestId: string): ChatItem {
  const existing = session.items.find((item) => item.kind === 'assistant' && item.id === messageId)
  if (existing) {
    if (existing.requestId === undefined && requestId !== '') existing.requestId = requestId
    return existing
  }
  const created: ChatItem = {
    id: messageId,
    kind: 'assistant',
    content: '',
    tools: [],
    ...(requestId === '' ? {} : { requestId }),
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
        optimistic.requestId = event.requestId
        optimistic.createdAt = event.createdAt
        break
      }
      session.items.push({
        id: `user-${event.seq}`,
        kind: 'user',
        content: event.content,
        tools: [],
        requestId: event.requestId,
        createdAt: event.createdAt,
      })
      break
    }
    case 'text': {
      // 入队而非直接写：同一帧内的多条增量合并成一次 apply（见文件头的流式合并说明）
      streamBuffer.push(streamKeyOf(clientId, sessionId, event.messageId), {
        kind: 'text',
        requestId: event.requestId,
        delta: event.delta,
      })
      break
    }
    case 'reasoning': {
      streamBuffer.push(streamKeyOf(clientId, sessionId, event.messageId), {
        kind: 'reasoning',
        requestId: event.requestId,
        delta: event.delta,
      })
      break
    }
    case 'tool': {
      const item = ensureAssistant(session, event.messageId, event.requestId)
      const call = event.call
      const existing = item.tools.find((tool) => tool.id === call.id)
      if (existing) {
        // 状态迁移到终态时补记结束时刻（工具行的耗时列用；历史回放条目没有这两个值）
        if (existing.state === 'running' && call.state !== 'running') existing.endedAt = Date.now()
        existing.state = call.state
        if (call.outputSummary) existing.outputSummary = call.outputSummary
        if (call.subagent) existing.subagent = call.subagent
        if (call.displayImages) existing.displayImages = call.displayImages
      } else {
        item.tools.push({
          id: call.id,
          name: call.name,
          state: call.state,
          inputSummary: summarizeInput(call.input),
          ...(call.input === undefined ? {} : { input: call.input }),
          ...(call.outputSummary === undefined ? {} : { outputSummary: call.outputSummary }),
          ...(call.subagent === undefined ? {} : { subagent: call.subagent }),
          ...(call.displayImages === undefined ? {} : { displayImages: call.displayImages }),
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
      // 终态前先 flush：否则这一帧还在缓存的正文会**晚于** done 落地，
      // 「收尾时读到的内容」就不是最终内容（deltaBuffer 语义 4）
      flushStreamDeltas()
      session.pending = false
      const now = Date.now()
      for (const item of session.items) {
        item.streaming = false
        if (item.kind === 'assistant' && item.endedAt === undefined) item.endedAt = now
      }
      break
    }
    case 'error': {
      flushStreamDeltas()
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
