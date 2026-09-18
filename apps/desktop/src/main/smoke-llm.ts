/**
 * 开发自测用的**本地假 LLM 服务**（仅 `AURORA_SMOKE=1` 时启动）。
 *
 * 为什么需要它：P3 起对话走真实模型，自测必须离线可跑且可断言。
 * 这个桩服务实现最小 OpenAI 兼容 `/chat/completions`：
 * - 第一次请求 → 返回一次 `use_skill` 工具调用；
 * - 第二次请求 → 返回含标记文本的最终答案。
 *
 * 因此"桩服务收到了 2 次请求"就等价于"工具调用循环真的跑起来了"。
 */
import { createServer, type Server, type ServerResponse } from 'node:http'
import { createNoopLogger, type Logger } from '@aurora/shared'

export const STUB_MARKER = 'AURORA_STUB_OK'
export const STUB_MODEL = 'aurora-smoke-model'
export const STUB_API_KEY = 'sk-smoke-plaintext-marker'

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
  close(): Promise<void>
}

export async function startStubLlmServer(logger?: Logger): Promise<StubLlmServer> {
  const log = logger ?? createNoopLogger()
  const requests: StubRequest[] = []

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
      requests.push({ path, body })
      log.debug('桩 LLM 收到请求', { path, count: requests.length })

      if (path.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: STUB_MODEL, owned_by: 'aurora-smoke' }] }))
        return
      }

      const toolCallRound =
        requests.filter((item) => item.path.endsWith('/chat/completions')).length === 1
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })

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
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function sendSse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}
