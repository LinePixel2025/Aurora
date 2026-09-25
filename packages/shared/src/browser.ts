/**
 * @aurora/shared/browser —— 渲染层专用入口。
 *
 * 为什么需要它：`@aurora/shared` 主入口包含 `SettingsStore` / `ports`（依赖 `node:fs`、
 * `node:path`），而 Electron 渲染进程是浏览器环境。渲染层只需要**类型**与**纯常量**
 * （Schema、默认值、窗口状态机），因此单独提供一个只含纯代码的入口。
 *
 * 约定：本文件及其依赖链**不得**出现任何 Node 内置模块导入。
 */

// 纯 Schema 与类型（zod 可在浏览器运行）
export * from './config/schema.js'
export * from './config/defaults.js'

// 纯状态机与工具
export * from './mode/windowState.js'
export * from './utils/object.js'
export * from './utils/format.js'
export * from './utils/result.js'
export * from './utils/logger.js'

// IPC 契约（仅类型）
export * from './ipc/channels.js'
export * from './ipc/types.js'

// 模式契约（仅类型）
export * from './mode/types.js'
export * from './agent/types.js'
