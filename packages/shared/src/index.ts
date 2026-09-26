/** @aurora/shared —— Aurora 共享类型、配置 Schema、SettingsStore 与 IPC 契约。 */

// 基础工具
export * from './utils/result.js'
export * from './utils/logger.js'
export * from './utils/object.js'
export * from './utils/format.js'

// 配置
export * from './config/schema.js'
export * from './config/defaults.js'
// 三档权限的纯判定（docs/06 §11.2）：主进程与渲染层共用同一份，避免"界面说只读、实际还能写"
export * from './config/permission.js'
export * from './config/migrations.js'
export * from './config/ports.js'
export * from './config/store.js'

// 契约
export * from './ipc/channels.js'
export * from './ipc/types.js'
export * from './mode/types.js'
export * from './mode/windowState.js'
export * from './agent/types.js'
