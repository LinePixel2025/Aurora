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

/**
 * 用户消息含此标记 → 对话分流改走**子代理链路**（docs/06 §19）：
 * 父对话第 1 轮派 `task` → 子代理跑两轮（先要一次工具、再给报告）→ 父对话第 2 轮收尾。
 * 自测用它把「子代理进度事件 + 快照持久化」跑到真实 IPC 上（而不只是夹具）。
 */
export const SUBAGENT_TASK_MARKER = 'STUB_TASK_MARKER'

/** 桩服务产出的思考链标记（断言「思考增量绑到了它自己那条助手消息」用） */
export const REASONING_MARKER = 'STUB_REASONING_OK'
/** 子代理最终报告里的标记 */
export const SUBAGENT_REPORT_MARKER = 'STUB_SUB_OK'

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
        sendSseStop(res)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      // ── 子代理分流（docs/06 §19）：第 1 轮要一次工具，第 2 轮给报告 ──
      if (isSubagentRequest(record)) {
        const hasToolResult = (record.body?.messages ?? []).some(
          (message) => message.role === 'tool',
        )
        if (!hasToolResult) {
          sendSse(res, {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_smoke_sub_1',
                      type: 'function',
                      function: { name: 'list_dir', arguments: '{"path":"."}' },
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
            choices: [
              {
                index: 0,
                delta: { content: `已列出目录。${SUBAGENT_REPORT_MARKER} 子代理报告完成。` },
                finish_reason: null,
              },
            ],
          })
          sendSseStop(res)
        }
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      // ── 父对话的 task 分流：用户消息带标记时派一次子代理，拿到结果后收尾 ──
      const lastUser = [...(record.body?.messages ?? [])]
        .reverse()
        .find((message) => message.role === 'user')
      const wantsTask =
        typeof lastUser?.content === 'string' && lastUser.content.includes(SUBAGENT_TASK_MARKER)
      if (wantsTask) {
        const taskDone = (record.body?.messages ?? []).some((message) => message.role === 'tool')
        if (!taskDone) {
          sendSse(res, {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_smoke_task_1',
                      type: 'function',
                      function: {
                        name: 'task',
                        arguments: JSON.stringify({
                          description: '冒烟子代理',
                          prompt: '列一下当前目录并给一句汇总。',
                        }),
                      },
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
            choices: [
              {
                index: 0,
                delta: { content: `${STUB_MARKER} 子代理已完成。` },
                finish_reason: null,
              },
            ],
          })
          sendSseStop(res)
        }
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
        // 思考链增量（docs/06 §16）：桩服务也产出 `reasoning_content`，端到端自测与截图探针
        // 才能验证「思考增量绑到**它自己那条**助手消息上」—— 纯正文的桩永远测不到这条链路。
        sendSse(res, {
          choices: [
            { index: 0, delta: { reasoning_content: REASONING_MARKER + ' ' }, finish_reason: null },
          ],
        })
        sendSse(res, {
          choices: [
            {
              index: 0,
              delta: { reasoning_content: '思考增量第二段：确认工具返回。' },
              finish_reason: null,
            },
          ],
        })
        sendSse(res, {
          choices: [{ index: 0, delta: { content: `${STUB_MARKER} ` }, finish_reason: null }],
        })
        sendSse(res, {
          choices: [
            { index: 0, delta: { content: '已按技能指令读取系统状态。' }, finish_reason: null },
          ],
        })
        sendSseStop(res)
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

/**
 * 子代理人设里的独有句（`SUBAGENT_PERSONA` 第二句）。
 *
 * **不能只搜「子代理」三个字**：主对话的系统提示词里有「子代理使用规范」小节
 * （`buildToolGuidance` 在注册了 `task` 时生成），只按两个字判断会把普通对话
 * 误判成子代理请求 —— 实测直接把整条对话链路带偏。
 */
const SUBAGENT_PROMPT_MARKER = '你看不到主对话的任何上下文'

/** 请求是否为子代理请求：系统提示词里带子代理人设的独有句 */
function isSubagentRequest(request: StubRequest): boolean {
  const messages = request.body?.messages ?? []
  return messages.some(
    (message) =>
      message.role === 'system' &&
      typeof message.content === 'string' &&
      message.content.includes(SUBAGENT_PROMPT_MARKER),
  )
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

/**
 * 「本轮结束」分片：附一份 token 用量。
 *
 * 真实服务在这一片回传 usage（且流式下要先在请求体里要 `stream_options.include_usage`，
 * 见 06 §16.2），桩服务跟着给出，端到端自测才能覆盖 `usage` 事件这条链路 ——
 * 不附的话 `AURORA_SMOKE` 永远只验证「拿不到用量时界面降级」那一半。
 */
function sendSseStop(res: ServerResponse): void {
  sendSse(res, {
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 128, completion_tokens: 16, total_tokens: 144 },
  })
}

function sendSse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}
