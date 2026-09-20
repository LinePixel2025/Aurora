/** @aurora/agent-core —— Agent 内核（纯 Node，不依赖 Electron / DOM）。 */

// LLM 提供者层
export * from './llm/types.js'
export * from './llm/sse.js'
export * from './llm/openai-compat.js'

// 会话层（docs/06 §4）
export * from './session/types.js'
export * from './session/history.js'
export * from './session/store.js'

// 执行层（docs/06 §5）
export * from './loop/agentLoop.js'

// 编排层（docs/06 §5）
export * from './context/systemPrompt.js'

// 能力层（docs/06 §6 / §7）
export * from './skills/parse.js'
export * from './skills/registry.js'
export * from './skills/bridge.js'
export * from './tools/registry.js'
// 电脑操控工具（docs/06 §11）：内核侧纯逻辑，真实系统调用在主进程注入。
export * from './tools/terminal.js'
export * from './mcp/errors.js'
export * from './mcp/jsonrpc.js'
export * from './mcp/transports.js'
export * from './mcp/client.js'
export * from './mcp/hub.js'

// 装配层（主进程用）
export * from './host/agentHost.js'
