import { describe, expect, it } from 'vitest'
import { BASE_PERSONA, SAFETY_RULES, buildSystemPrompt, describeTools } from './systemPrompt.js'

describe('buildSystemPrompt', () => {
  it('小节顺序固定：人设 → 模式 → 感知 → Skill → 工具 → 安全规则', () => {
    const prompt = buildSystemPrompt({
      modePrompt: '课堂模式说明',
      perceptionSummary: '当前时间 08:00',
      skillCatalog: '- system-status：读状态',
      toolCatalog: '- use_skill：读技能',
    })
    const order = ['Aurora', '当前模式', '系统状态', '可用 Skill', '可用工具', '安全规则']
    const positions = order.map((token) => prompt.indexOf(token))
    expect(positions.every((value) => value >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('空片段与非字符串内容会被省略', () => {
    const prompt = buildSystemPrompt({ modePrompt: '   ', perceptionSummary: '' })
    expect(prompt).not.toContain('## 当前模式')
    expect(prompt).not.toContain('## 系统状态')
    expect(prompt).not.toContain('## 可用 Skill')
    expect(prompt).not.toContain('## 可用工具')
    expect(prompt).toContain(BASE_PERSONA)
  })

  it('始终包含安全规则', () => {
    expect(buildSystemPrompt().endsWith(SAFETY_RULES)).toBe(true)
  })

  it('自定义人设覆盖默认', () => {
    expect(buildSystemPrompt({ persona: '你是助教' }).startsWith('你是助教')).toBe(true)
  })

  it('settingsHint 渲染为「Agent 可修改的设置」小节，位于可用工具之后、安全规则之前', () => {
    const prompt = buildSystemPrompt({
      toolCatalog: '- web_fetch：抓网页',
      settingsHint: '- general.chat.showThinking\n- tts.enabled',
    })
    expect(prompt).toContain('## Agent 可修改的设置')
    expect(prompt).toContain('- general.chat.showThinking')

    const hint = prompt.indexOf('## Agent 可修改的设置')
    const tools = prompt.indexOf('## 可用工具')
    const safety = prompt.indexOf('## 安全规则')
    expect(tools).toBeGreaterThanOrEqual(0)
    expect(tools).toBeLessThan(hint)
    expect(hint).toBeLessThan(safety)
  })

  it('settingsHint 缺省或为空白时不渲染该小节', () => {
    expect(buildSystemPrompt()).not.toContain('Agent 可修改的设置')
    expect(buildSystemPrompt({ settingsHint: '   ' })).not.toContain('Agent 可修改的设置')
  })
})

describe('describeTools', () => {
  it('空清单返回 undefined', () => {
    expect(describeTools([])).toBeUndefined()
  })

  it('输出「名称：描述」清单', () => {
    expect(describeTools([{ name: 'use_skill', description: '读技能' }])).toBe(
      '- use_skill：读技能',
    )
  })
})
