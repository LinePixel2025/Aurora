/**
 * Agent 浏览器标签映射（v35，docs/06 §27）：一个会话一个标签、一个标签一个会话、不可变更新。
 */
import { describe, expect, it } from 'vitest'
import {
  agentSessionOfTab,
  agentTabCount,
  agentTabIdOfSession,
  assignAgentTab,
  releaseAgentSession,
  releaseAgentTab,
  type AgentTabMap,
} from './agentBrowserTabs.js'

describe('agentBrowserTabs', () => {
  it('assign 建立映射并按会话唯一：同会话换标签会清掉旧映射', () => {
    let map: AgentTabMap = {}
    map = assignAgentTab(map, 'browser', 's1')
    expect(agentTabIdOfSession(map, 's1')).toBe('browser')
    expect(agentSessionOfTab(map, 'browser')).toBe('s1')

    map = assignAgentTab(map, 'browser-2', 's1')
    expect(agentTabIdOfSession(map, 's1')).toBe('browser-2')
    expect(agentSessionOfTab(map, 'browser')).toBeUndefined()
    expect(agentTabCount(map)).toBe(1)
  })

  it('assign 按标签唯一：同一标签换会话不会留下旧会话映射', () => {
    let map: AgentTabMap = assignAgentTab({}, 'browser', 's1')
    map = assignAgentTab(map, 'browser', 's2')
    expect(agentTabIdOfSession(map, 's1')).toBeUndefined()
    expect(agentTabIdOfSession(map, 's2')).toBe('browser')
    expect(agentTabCount(map)).toBe(1)
  })

  it('空 id 是 no-op（不制造幽灵映射）', () => {
    const map: AgentTabMap = {}
    expect(assignAgentTab(map, '', 's1')).toBe(map)
    expect(assignAgentTab(map, 'browser', '')).toBe(map)
  })

  it('releaseAgentSession 清掉该会话的标签，其它会话保留', () => {
    let map: AgentTabMap = assignAgentTab({}, 'browser', 's1')
    map = assignAgentTab(map, 'browser-2', 's2')
    const next = releaseAgentSession(map, 's1')
    expect(agentTabIdOfSession(next, 's1')).toBeUndefined()
    expect(agentTabIdOfSession(next, 's2')).toBe('browser-2')
    expect(next).not.toBe(map)
    // 不存在的会话返回原引用（避免无意义的重渲染）
    expect(releaseAgentSession(next, 'missing')).toBe(next)
  })

  it('releaseAgentTab 只删一个标签，未知标签返回原引用', () => {
    const map: AgentTabMap = assignAgentTab({}, 'browser', 's1')
    expect(agentSessionOfTab(releaseAgentTab(map, 'browser'), 'browser')).toBeUndefined()
    expect(releaseAgentTab(map, 'nope')).toBe(map)
  })

  it('count 统计被 Agent 控制的标签数', () => {
    let map: AgentTabMap = {}
    map = assignAgentTab(map, 'browser', 's1')
    map = assignAgentTab(map, 'browser-2', 's2')
    expect(agentTabCount(map)).toBe(2)
    expect(agentTabCount({})).toBe(0)
  })
})
