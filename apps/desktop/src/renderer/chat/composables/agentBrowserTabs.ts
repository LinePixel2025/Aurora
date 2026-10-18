/**
 * Agent 内置浏览器的「标签 ↔ 会话」映射（v35，docs/06 §27）。
 *
 * 右栏标签条是标签的唯一记账方（`useCtxTabs`），主进程只认识 `sessionId`；
 * 两边靠这份**纯映射**对齐：`browser:agentOpen` 到达时分配标签、`agentStatus: released`
 * 或用户关标签时释放。放在独立模块是为了能在 vitest 里直接测（App.vue 本身依赖 DOM）。
 *
 * 不变式：
 * - 一个 `sessionId` 最多映射一个标签；
 * - 一个标签最多属于一个 `sessionId`（新会话绝不会复用别的会话的标签）；
 * - 映射不可变更新（返回新对象），与 Vue `ref` 的赋值语义一致。
 */
export type AgentTabMap = Readonly<Record<string, string>>

/** 把某个标签分配给会话（同时清掉该会话可能存在的旧映射） */
export function assignAgentTab(map: AgentTabMap, tabId: string, sessionId: string): AgentTabMap {
  if (tabId === '' || sessionId === '') return map
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(map)) {
    if (key === tabId || value === sessionId || value === '') continue
    next[key] = value
  }
  next[tabId] = sessionId
  return next
}

/** 按会话释放映射（会话结束 / 用户停止 / 空闲释放） */
export function releaseAgentSession(map: AgentTabMap, sessionId: string): AgentTabMap {
  const next: Record<string, string> = {}
  let changed = false
  for (const [tabId, value] of Object.entries(map)) {
    if (value === sessionId) {
      changed = true
      continue
    }
    next[tabId] = value
  }
  return changed ? next : map
}

/** 按标签释放映射（用户关掉这个标签） */
export function releaseAgentTab(map: AgentTabMap, tabId: string): AgentTabMap {
  if (map[tabId] === undefined) return map
  const next: Record<string, string> = { ...map }
  delete next[tabId]
  return next
}

/** 会话对应的标签 id（没有映射返回 undefined） */
export function agentTabIdOfSession(map: AgentTabMap, sessionId: string): string | undefined {
  for (const [tabId, value] of Object.entries(map)) {
    if (value === sessionId) return tabId
  }
  return undefined
}

/** 标签所属的会话（普通标签返回 undefined） */
export function agentSessionOfTab(map: AgentTabMap, tabId: string): string | undefined {
  return map[tabId]
}

/** 当前被 Agent 控制的标签数（诊断 / 上限提示用） */
export function agentTabCount(map: AgentTabMap): number {
  return Object.keys(map).length
}
