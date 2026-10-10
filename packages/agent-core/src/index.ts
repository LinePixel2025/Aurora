/** @aurora/agent-core —— Agent 内核（纯 Node，不依赖 Electron / DOM）。 */

// LLM 提供者层
export * from './llm/types.js'
export * from './llm/sse.js'
export * from './llm/openai-compat.js'
// Responses API（docs/06 §3.2，v22）：第二个 provider 实现。
// 共享传输层（`llm/transport.ts`）**不在这里二次导出**：`openai-compat.js` 已经把它们
// 逐个再导出（`normalizeBaseUrl` / `statusToCode` / `toLlmError` / `describeError`），
// 两个 `export *` 撞同名会让该名字在根导出里**静默消失**（ESM 的歧义导出语义），
// 反而弄丢主进程的既有导入。
export * from './llm/responses.js'

// 会话层（docs/06 §4）
export * from './session/types.js'
export * from './session/history.js'
export * from './session/store.js'

// 执行层（docs/06 §5）
export * from './loop/agentLoop.js'

// 编排层（docs/06 §5）
export * from './context/systemPrompt.js'

// 项目机制（docs/06 §5.1，v13）：当前项目解析 + 项目级 AGENTS.md 逐层收集
export * from './config/project.js'
export * from './config/effectiveWorkspace.js'
// Agent 空间的固定工作目录（docs/06 §4 会话三分，2026-09-30）
export * from './config/agentWorkspace.js'
export * from './project/agentsFile.js'
export * from './project/instructions.js'
export * from './project/nodeFs.js'

// 写前快照（docs/06 §11.8，v14）：端口与 DTO；真实落盘实现由主进程注入（磁盘布局在 agent-core，见 §11.8）
export * from './snapshots/types.js'
export * from './snapshots/snapshot-port.js'

// Job（任务）持久化（docs/06 §4.1，v15）：类型 + 纯映射 + 文件存储
export * from './jobs/types.js'
export * from './jobs/store.js'

// 能力层（docs/06 §6 / §7）
export * from './skills/parse.js'
export * from './skills/registry.js'
export * from './skills/bridge.js'
export * from './tools/registry.js'
// 电脑操控工具（docs/06 §11）：内核侧纯逻辑，真实系统调用在主进程注入。
export * from './tools/terminal.js'
export * from './tools/files.js'
// glob 模式编译器（docs/06 §11.5）：`grep` / `glob` / `run_command` 免确认列表共用同一份纯函数。
export * from './tools/globPattern.js'
// run_command 免确认模式列表（docs/06 §11.7）：匹配器与校验，复用上面那个 glob 编译器。
export * from './tools/command-allow.js'
// 搜索工具（docs/06 §11.5）：grep / glob，同样只做参数校验与结果格式化，遍历在主进程。
export * from './tools/search.js'
// 精确替换工具（docs/06 §11.6）：edit_file + 会话级「改前先读」守卫契约。
export * from './tools/edit.js'
// Office 专用工具（docs/06 §11）：结构化创建 / 读取 / 常用编辑，端口由主进程 worker 注入。
export * from './tools/office.js'
// 扩展工具（Design/betav2-spec.md §6）：同上，端口由主进程注入。
export * from './tools/web-fetch.js'
export * from './tools/clipboard.js'
export * from './tools/notify.js'
// 右栏成果展示（2026-10-03，docs/06 §14）：`show_preview` —— 同一条端口注入套路。
export * from './tools/preview.js'
export * from './tools/image-display.js'
export * from './tools/center.js'
export * from './tools/imagegen.js'
// 图像工具（docs/06 §25）：看图 / 截屏（剪贴板图片工具与上面 clipboard 同文件）。
// 只在当前生效模型开启图片输入（`modelParams.<模型>.vision`）时被注册，门控在主进程装配层。
export * from './tools/image.js'
export * from './tools/screenshot.js'
// Agent 核心能力工具（docs/06 §18/§19/§21）：任务清单、子代理派生、向用户提问。
export * from './tools/todo.js'
export * from './tools/task.js'
export * from './tools/ask-user.js'
// AI 修改自身配置（docs/06 §12）：同上，真实配置读写由主进程端口注入。
export * from './tools/settings.js'
// 外观三件套的语义化入口（v32，docs/06 §12.1）：复用同一个 SettingsToolPort。
export * from './tools/appearance.js'
export * from './mcp/errors.js'
export * from './mcp/jsonrpc.js'
export * from './mcp/transports.js'
export * from './mcp/client.js'
export * from './mcp/hub.js'

// 装配层（主进程用）
export * from './host/agentHost.js'
