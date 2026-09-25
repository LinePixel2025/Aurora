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

/**
 * 爆发模式标记（`burst-probe`）：**本次请求最后一条 user 消息**含它才走爆发分流。
 *
 * 刻意按请求内容而不是环境变量分流：`AURORA_CAPTURE` 一轮里前面的场景（chat-stream /
 * 分类 / 子代理）都必须走各自的老路径，环境变量是进程级的、会一起改掉它们的行为。
 */
export const BURST_MARKER = 'burst-probe'

/**
 * 爆发分片的首末标记：探针据此断言「首片与末片都真的落到了渲染层」，
 * 而不是只证明「流式大体上跑通了」。
 */
export const BURST_REASONING_START_MARKER = '【爆发思考开始】'
export const BURST_REASONING_END_MARKER = '【爆发思考结束】'
export const BURST_TEXT_START_MARKER = '【爆发正文开始】'
export const BURST_TEXT_END_MARKER = '【爆发正文结束】'

/**
 * 爆发密度：150 片 × 5ms ≈ 0.75s 一阶段，思考 + 正文合计约 1.5s。
 *
 * 这个密度是**测量基线的一部分**，不是随便定的：它对应真实推理模型 100+ token/s 的
 * 分片节奏，缩水（比如降到 20 片）就测不出「每片一次全量重渲染」的累积代价。
 * 改它等于改基线的量纲，阈值必须重新标定。
 */
const BURST_CHUNK_COUNT = 150
const BURST_CHUNK_GAP_MS = 5

/**
 * 爆发场景的「前文堆量」：先跑几轮长回复，把 transcript 堆到真实长会话的量级。
 *
 * 为什么必须堆：本 BUG 的代价是「每片增量 × **整份 transcript** 的 markdown 全量重解析
 * （并连带整份 DOM 重建）」（见 MessageList.vue 的 `htmlOf`）。只有一条 1.2k 字的爆发消息时
 * 这个乘积太小 —— 实测修复前 longtask / 心跳 / 帧三组数值全是「空闲」水平，探针等于什么都没测到。
 * 长会话里真正被反复重解析的是那些**内容不再变**的旧助手消息，所以这里让它们先堆起来。
 *
 * 堆量的方式是「一次写完一条几十 KB 的回复」：它只负责把现场堆起来，不承担节奏复刻
 * （真实节奏由最后的爆发轮承担：150 + 150 片、5ms）。探针也只从爆发轮开始采样
 * （见 capture.ts 的 `reset` 注释），因此堆量轮自身的一次性开销不进基线数值。
 */
const BURST_PRELUDE_ROUNDS = 2
const BURST_PRELUDE_CHARS = 20_000

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

      // ── 1-D 爆发分流：高密度思考 + 正文分片，测量渲染层跟不跟得上 ──
      // 必须排在下面的 `toolCallRound` 之前：那一支按「第几次对话请求」决定要不要发工具调用，
      // 而爆发场景只有一次请求、且要的是纯分片（不能先插一轮工具调用把时序搅乱）。
      if (isBurstRequest(record)) {
        void sendBurst(res, burstPreludesDone(record), log)
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
        // 分片之间必须隔开一帧再发：主进程的**事件合并缓冲**按 16ms 窗口把相邻的
        // text / reasoning 增量合并成一条（`main/event-buffer.ts`，那是刻意的降载设计），
        // 零延迟连发两片在这条链路上必然被合并成一条，「逐条增量下发」的判据就成了随机失败。
        // 隔开之后判据才是确定的：真出现「攒完整段发一次」的回归时，事件数仍然是 1。
        sendSseDelayed(
          res,
          {
            choices: [
              {
                index: 0,
                delta: { reasoning_content: '思考增量第二段：确认工具返回。' },
                finish_reason: null,
              },
            ],
          },
          FRAME_GAP_MS,
        )
        sendSseDelayed(
          res,
          { choices: [{ index: 0, delta: { content: `${STUB_MARKER} ` }, finish_reason: null }] },
          FRAME_GAP_MS * 2,
        )
        sendSseDelayed(
          res,
          {
            choices: [
              { index: 0, delta: { content: '已按技能指令读取系统状态。' }, finish_reason: null },
            ],
          },
          FRAME_GAP_MS * 3,
        )
        // 收尾（终态帧）压在最后一片之后：否则终态会越过它前面的增量先到
        setTimeout(() => {
          sendSseStop(res)
          res.write('data: [DONE]\n\n')
          res.end()
        }, FRAME_GAP_MS * 4)
        return
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

/** 请求是否为爆发模式：最后一条 user 消息含 `BURST_MARKER` */
function isBurstRequest(request: StubRequest): boolean {
  const lastUser = [...(request.body?.messages ?? [])]
    .reverse()
    .find((message) => message.role === 'user')
  return typeof lastUser?.content === 'string' && lastUser.content.includes(BURST_MARKER)
}

/**
 * 爆发模式：先按 `BURST_PRELUDE_ROUNDS` 轮堆起 transcript，再 150 片 `reasoning_content`、
 * 150 片 `content`，每片间隔 5ms。
 *
 * 用 `reasoning_content` / `content` 两条独立字段而不是一条混合流：
 * 渲染层的思考块与正文是两条不同的渲染路径（思考块是 `white-space: pre-wrap` 的纯文本，
 * 正文要过 markdown），混在一起就看不出「哪一条被拖慢」。
 *
 * 客户端中途断开（切会话 / 关窗）会让写失败：那是正常路径，**不是**桩服务异常，
 * 因此这里只销毁连接、不抛错（抛出去会变成未处理的 rejection，把整轮 capture 打断）。
 */
async function sendBurst(res: ServerResponse, preludesDone: number, log?: Logger): Promise<void> {
  // 桩服务这一侧的**发送耗时**要能测：探针测到的是「渲染层观察到流式收尾」的耗时，
  // 两者一比才知道那多出来的时间是渲染跟不上、还是发送侧本身就被拖慢了。
  const startedAt = Date.now()
  const logElapsed = (stage: 'prelude' | 'burst', chunks: number): void => {
    log?.info('爆发流发送完成', {
      stage,
      preludesDone,
      chunks,
      elapsedMs: Date.now() - startedAt,
    })
  }
  try {
    // 堆量轮：一条长正文 + 一次 `use_skill`（与默认分流同一个「能续下一轮」的抓手）
    if (preludesDone < BURST_PRELUDE_ROUNDS) {
      sendSse(res, {
        choices: [
          {
            index: 0,
            delta: { content: burstPreludeContent(preludesDone) },
            finish_reason: null,
          },
        ],
      })
      sendSse(res, {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: `call_burst_prelude_${preludesDone}`,
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
      res.write('data: [DONE]\n\n')
      res.end()
      logElapsed('prelude', 1)
      return
    }

    for (let index = 0; index < BURST_CHUNK_COUNT; index += 1) {
      const head = index === 0 ? BURST_REASONING_START_MARKER : ''
      const tail = index === BURST_CHUNK_COUNT - 1 ? BURST_REASONING_END_MARKER : ''
      sendSse(res, {
        choices: [
          {
            index: 0,
            delta: { reasoning_content: `${head}${burstChunk(index)}${tail}` },
            finish_reason: null,
          },
        ],
      })
      if (!(await gap(res, BURST_CHUNK_GAP_MS))) {
        res.destroy()
        return
      }
    }
    for (let index = 0; index < BURST_CHUNK_COUNT; index += 1) {
      const head = index === 0 ? BURST_TEXT_START_MARKER : ''
      const tail = index === BURST_CHUNK_COUNT - 1 ? BURST_TEXT_END_MARKER : ''
      sendSse(res, {
        choices: [
          {
            index: 0,
            delta: { content: `${head}${burstChunk(index)}${tail}` },
            finish_reason: null,
          },
        ],
      })
      if (!(await gap(res, BURST_CHUNK_GAP_MS))) {
        res.destroy()
        return
      }
    }
    // 结束片带 usage：与默认对话分流同口径，本次现场也能顺带覆盖用量链路
    sendSseStop(res)
    res.write('data: [DONE]\n\n')
    res.end()
    logElapsed('burst', BURST_CHUNK_COUNT * 2)
  } catch {
    res.destroy()
  }
}

/**
 * 本轮请求之前已经跑过几轮堆量。
 *
 * **只数最后一条 user 消息之后的 tool 结果**：会话历史里还留着更早的对话（chat-stream
 * 场景那一轮的 use_skill 结果），按整份 messages 数会把它们算进来 —— 现场直接从第 N 轮
 * 起步，堆量一片都不会发。
 */
function burstPreludesDone(request: StubRequest): number {
  const messages = request.body?.messages ?? []
  let lastUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      lastUserIndex = index
      break
    }
  }
  return messages.slice(lastUserIndex + 1).filter((message) => message.role === 'tool').length
}

/**
 * 堆量轮的正文：按行生成、条数确定，长度约 `BURST_PRELUDE_CHARS`。
 *
 * 刻意做成「带加粗 / 行内代码 / 链接的列表」——它就是 markdown 解析器的真实输入形状
 *（每行都要过 `inline()` 的三条正则），用纯文本堆同样长度会低估解析成本。
 */
function burstPreludeContent(round: number): string {
  const lines: string[] = []
  let length = 0
  while (length < BURST_PRELUDE_CHARS) {
    const line = `- 第 ${round + 1} 轮第 ${lines.length + 1} 条：已读完一份文件并记下要点，含 **加粗**、\`src/path/file.ts\` 与 https://example.com/doc/${lines.length} 。`
    lines.push(line)
    length += line.length
  }
  return lines.join('\n')
}

/** 一片 6–10 个字（首末片另外拼标记，因此会比这个区间略长）；长度按片号轮转 */
function burstChunk(index: number): string {
  const body = `推演${String(index % 100).padStart(2, '0')}`
  return body.padEnd(6 + (index % 5), '。')
}

/** 间隔 `ms` 毫秒；返回 false 表示连接已断，调用方应停止推进 */
function gap(res: ServerResponse, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(!res.writableEnded && !res.destroyed), ms)
  })
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

/** 分片间隔：必须大于主进程事件合并缓冲的 16ms 窗口（`main/event-buffer.ts`） */
const FRAME_GAP_MS = 40

function sendSse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

/** 隔 `delayMs` 再发一片（见「分片之间必须隔开一帧再发」的说明） */
function sendSseDelayed(res: ServerResponse, payload: unknown, delayMs: number): void {
  setTimeout(() => sendSse(res, payload), delayMs)
}
