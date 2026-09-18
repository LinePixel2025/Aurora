/**
 * 开发自测用的**本地假 LLM 服务**（仅 `AURORA_SMOKE=1` 时启动）。
 *
 * 为什么需要它：P3 起对话走真实模型，自测必须离线可跑且可断言。
 * 这个桩服务实现最小 OpenAI 兼容 `/chat/completions`，按请求内容分流：
 *
 * 1. **对话**（默认）：第一次请求 → 返回一次 `use_skill` 工具调用；
 *    第二次请求 → 返回含标记文本的最终答案。
 *    因此"桩服务收到了 2 次请求"就等价于"工具调用循环真的跑起来了"。
 * 2. **分类**（请求带分类系统提示词）：返回结构化 JSON 判定。
 *    为了让自测能覆盖"低置信 → 待分类"分支，文件名含 `低置信` 时返回 `confidence: 0.1`。
 *
 * 两条分流都记在 `requests` 里并各自计数，因此还能断言
 * 「规则命中时**没有**产生新的分类请求」（跳过 LLM 的关键证据）。
 */
import { createServer, type Server, type ServerResponse } from 'node:http'
import { createNoopLogger, type Logger } from '@aurora/shared'

export const STUB_MARKER = 'AURORA_STUB_OK'
export const STUB_MODEL = 'aurora-smoke-model'
export const STUB_API_KEY = 'sk-smoke-plaintext-marker'

/** 分类请求的识别标记（与 `classify/llm.ts` 的 `CLASSIFY_SYSTEM_PROMPT` 首句一致） */
export const CLASSIFY_PROMPT_MARKER = '你是一个文件归类助手'

/** 文件名含此标记 → 桩服务返回低置信度，用于覆盖「待分类」兜底分支 */
export const LOW_CONFIDENCE_MARKER = '低置信'

export interface StubRequest {
  path: string
  body: { messages?: Array<{ role?: string; content?: unknown }>; tools?: unknown[] } | null
}

export interface StubLlmServer {
  baseUrl: string
  requests: StubRequest[]
  /** 第二次请求是否带回了 tool 结果（证明工具循环成立） */
  sawToolResult(): boolean
  /** 第一次请求是否带上了工具清单（use_skill 已注册） */
  sawTools(): boolean
  /** 分类请求次数（用于断言"规则命中跳过 LLM"） */
  classifyRequestCount(): number
  /** 对话请求次数 */
  chatRequestCount(): number
  close(): Promise<void>
}

export async function startStubLlmServer(logger?: Logger): Promise<StubLlmServer> {
  const log = logger ?? createNoopLogger()
  const requests: StubRequest[] = []

  const chatRequests = (): StubRequest[] =>
    requests.filter((item) => item.path.endsWith('/chat/completions') && !isClassifyRequest(item))
  const classifyRequests = (): StubRequest[] =>
    requests.filter((item) => item.path.endsWith('/chat/completions') && isClassifyRequest(item))

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: StubRequest['body'] = null
      try {
        body = JSON.parse(raw) as StubRequest['body']
      } catch {
        body = null
      }
      const path = req.url ?? ''
      const record: StubRequest = { path, body }
      requests.push(record)
      log.debug('桩 LLM 收到请求', { path, count: requests.length })

      if (path.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: STUB_MODEL, owned_by: 'aurora-smoke' }] }))
        return
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })

      // ── 分类分流 ──
      if (isClassifyRequest(record)) {
        // 只回一条文本事件即可：调用方按流式文本拼接后解析 JSON
        sendSse(res, {
          choices: [
            {
              index: 0,
              delta: { content: JSON.stringify(classifyVerdict(record)) },
              finish_reason: null,
            },
          ],
        })
        sendSse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      // ── 对话分流（沿用 P3 行为：第一次触发工具调用） ──
      const toolCallRound = chatRequests().length === 1
      if (toolCallRound) {
        sendSse(res, {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_smoke_1',
                    type: 'function',
                    function: { name: 'use_skill', arguments: '{"name":"system-status"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })
        sendSse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      } else {
        sendSse(res, {
          choices: [{ index: 0, delta: { content: `${STUB_MARKER} ` }, finish_reason: null }],
        })
        sendSse(res, {
          choices: [
            { index: 0, delta: { content: '已按技能指令读取系统状态。' }, finish_reason: null },
          ],
        })
        sendSse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    sawToolResult: () =>
      requests.some((item) =>
        (item.body?.messages ?? []).some((message) => message.role === 'tool'),
      ),
    sawTools: () =>
      requests.some((item) => Array.isArray(item.body?.tools) && item.body.tools.length > 0),
    classifyRequestCount: () => classifyRequests().length,
    chatRequestCount: () => chatRequests().length,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** 请求是否为分类请求：系统提示词里带分类标记 */
function isClassifyRequest(request: StubRequest): boolean {
  const messages = request.body?.messages ?? []
  return messages.some(
    (message) =>
      message.role === 'system' &&
      typeof message.content === 'string' &&
      message.content.includes(CLASSIFY_PROMPT_MARKER),
  )
}

/**
 * 桩服务的分类判定。
 *
 * 从用户消息里解析出文件名与科目清单，选**文件名中直接出现**的科目；
 * 找不到就返回空科目（走「待分类」）。文件名含 `低置信` 时返回 0.1 置信度，
 * 用来覆盖"低于阈值 → 待分类"的分支。
 */
function classifyVerdict(request: StubRequest): {
  subject: string
  confidence: number
  reason: string
} {
  const messages = request.body?.messages ?? []
  const userMessage = messages.find((message) => message.role === 'user')
  const prompt = typeof userMessage?.content === 'string' ? userMessage.content : ''

  const fileName = /文件名：(.+)/.exec(prompt)?.[1]?.trim() ?? ''
  // 科目清单形如：`- 数学（关键词：方程）` 或 `- 数学`
  const subjects = [...prompt.matchAll(/^- (.+?)(?:（关键词：.*）)?$/gm)].map((match) =>
    match[1]!.trim(),
  )

  if (fileName.includes(LOW_CONFIDENCE_MARKER)) {
    return { subject: subjects[0] ?? '', confidence: 0.1, reason: '桩服务：故意返回低置信度' }
  }

  const matched = subjects.find((subject) => subject !== '' && fileName.includes(subject))
  if (matched === undefined) {
    return { subject: '', confidence: 0, reason: '桩服务：文件名无法判定' }
  }
  return { subject: matched, confidence: 0.95, reason: `桩服务：文件名含「${matched}」` }
}

function sendSse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}
