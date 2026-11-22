import { describe, expect, it } from 'vitest'
import { createMemoryLogger } from '@aurora/shared'
import type {
  AgentProviderFactory,
  ChatEvent,
  ChatRequest,
  ProviderConfig,
} from '@aurora/agent-core'
import {
  SUBAGENT_DRAFT_PROMPT_MARKER,
  SubagentDraftService,
  buildSubagentDraftPrompt,
  normalizeDraftAccess,
  parseSubagentDraft,
} from './subagent-draft.js'

/** 依次返回给定回复的假 provider（与 `session-title.test.ts` 同一套写法） */
function textProvider(
  replies: string[],
  onRequest?: (request: ChatRequest) => void,
): AgentProviderFactory {
  let call = 0
  return {
    create: (): ProviderConfig | undefined => {
      const reply = replies[Math.min(call, replies.length - 1)] ?? ''
      call += 1
      return {
        model: 'draft-model',
        provider: {
          id: 'draft-provider',
          chat: (request): AsyncIterable<ChatEvent> => ({
            async *[Symbol.asyncIterator]() {
              onRequest?.(request)
              yield { type: 'text', delta: reply }
              yield { type: 'done', finishReason: 'stop' }
            },
          }),
        },
      }
    },
  }
}

const VALID_JSON = JSON.stringify({
  name: '代码审查员',
  description: '审查代码改动，检查风险与遗漏的测试，只读不改。',
  instructions: '你是代码审查员。先读改动，再按风险排序给结论，必须给出文件与行号。',
  access: 'read',
})

describe('buildSubagentDraftPrompt', () => {
  it('首行是分流标记，含用户需求、上限与已存在名称', () => {
    const prompt = buildSubagentDraftPrompt('做一个只读的代码审查员', ['Searcher', 'Coder'])
    expect(prompt.startsWith(SUBAGENT_DRAFT_PROMPT_MARKER)).toBe(true)
    expect(prompt).toContain('做一个只读的代码审查员')
    expect(prompt).toContain('Searcher、Coder')
    expect(prompt).toContain('"name"')
    expect(prompt).toContain('"access"')
    expect(prompt).toContain('40')
    expect(prompt).toContain('200')
    expect(prompt).toContain('4000')
  })

  it('没有已存在名称时给空名册提示；需求压缩空白并截断', () => {
    const prompt = buildSubagentDraftPrompt(`  ${'需求'.repeat(3000)}  `)
    expect(prompt).toContain('当前还没有其他子代理')
    // 正文被截到 2000 字符量级（不把整段文档塞进模型）
    expect(prompt.length).toBeLessThan(2_500)
  })
})

describe('normalizeDraftAccess', () => {
  it('英文三档直接认，中文说法兼容，其余回落只读', () => {
    expect(normalizeDraftAccess('read')).toBe('read')
    expect(normalizeDraftAccess('WRITE')).toBe('write')
    expect(normalizeDraftAccess('execute')).toBe('execute')
    expect(normalizeDraftAccess('可写文件')).toBe('write')
    expect(normalizeDraftAccess('可执行命令')).toBe('execute')
    expect(normalizeDraftAccess('只读')).toBe('read')
    expect(normalizeDraftAccess('admin')).toBe('read')
    expect(normalizeDraftAccess('')).toBe('read')
  })
})

describe('parseSubagentDraft', () => {
  it('容忍代码围栏与前后废话，只取首个 JSON 对象', () => {
    const raw = `好的，草稿如下：\n\`\`\`json\n${VALID_JSON}\n\`\`\`\n请查收。`
    expect(parseSubagentDraft(raw)).toEqual({
      name: '代码审查员',
      description: '审查代码改动，检查风险与遗漏的测试，只读不改。',
      instructions: '你是代码审查员。先读改动，再按风险排序给结论，必须给出文件与行号。',
      access: 'read',
    })
  })

  it('超长字段按 Schema 上限截断，非法 access 回落 read', () => {
    const draft = parseSubagentDraft(
      JSON.stringify({
        name: '名'.repeat(60),
        description: '描'.repeat(400),
        instructions: '指'.repeat(5_000),
        access: 'admin',
      }),
    )
    expect(draft?.name.length).toBe(40)
    expect(draft?.description.length).toBe(200)
    expect(draft?.instructions.length).toBe(4_000)
    expect(draft?.access).toBe('read')
  })

  it('必填字段缺失 / 空串 / 非对象：判失败（不返回半截草稿）', () => {
    expect(parseSubagentDraft('没有 JSON 的普通回复')).toBeUndefined()
    expect(parseSubagentDraft('{')).toBeUndefined()
    expect(parseSubagentDraft(JSON.stringify({ name: '只有名字' }))).toBeUndefined()
    expect(
      parseSubagentDraft(JSON.stringify({ name: '  ', description: 'x', instructions: 'y' })),
    ).toBeUndefined()
    expect(parseSubagentDraft(JSON.stringify([1, 2, 3]))).toBeUndefined()
  })
})

describe('SubagentDraftService', () => {
  it('成功：把需求与名册送进提示词，返回规范化草稿', async () => {
    const requests: string[] = []
    const service = new SubagentDraftService({
      provider: textProvider([`\`\`\`json\n${VALID_JSON}\n\`\`\``], (request) => {
        requests.push(request.messages[0]?.content ?? '')
      }),
      logger: createMemoryLogger(),
      existingNames: () => ['Searcher'],
    })
    const outcome = await service.draft('帮我做一个只读的代码审查员')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.draft.name).toBe('代码审查员')
    expect(outcome.draft.access).toBe('read')
    expect(requests[0]).toContain(SUBAGENT_DRAFT_PROMPT_MARKER)
    expect(requests[0]).toContain('帮我做一个只读的代码审查员')
    expect(requests[0]).toContain('Searcher')
  })

  it('没有可用模型：回可读原因，不发请求', async () => {
    let called = 0
    const service = new SubagentDraftService({
      provider: {
        create: () => {
          called += 1
          return undefined
        },
      },
      logger: createMemoryLogger(),
    })
    const outcome = await service.draft('做一个审查员')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.message).toContain('AI 模型')
    expect(called).toBe(1)
  })

  it('模型流里出现 error：回失败原因', async () => {
    const provider: AgentProviderFactory = {
      create: () => ({
        model: 'draft-model',
        provider: {
          id: 'draft-provider',
          chat: (): AsyncIterable<ChatEvent> => ({
            async *[Symbol.asyncIterator]() {
              yield { type: 'error', code: 'E_NETWORK', message: 'upstream 502' }
            },
          }),
        },
      }),
    }
    const outcome = await new SubagentDraftService({ provider }).draft('做一个审查员')
    expect(outcome.ok).toBe(false)
  })

  it('输出无法解析：明确回失败，不把原始输出当草稿', async () => {
    const service = new SubagentDraftService({
      provider: textProvider(['我只是随便聊聊，不是 JSON']),
    })
    const outcome = await service.draft('做一个审查员')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.message).toContain('不是有效定义')
  })

  it('空需求直接失败，不构造 provider 请求', async () => {
    let called = 0
    const service = new SubagentDraftService({
      provider: {
        create: () => {
          called += 1
          return undefined
        },
      },
    })
    const outcome = await service.draft('   ')
    expect(outcome.ok).toBe(false)
    expect(called).toBe(0)
  })
})
