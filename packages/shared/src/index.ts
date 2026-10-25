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
export * from './center/protocol.js'

// 插件契约（docs/14）：清单 schema、权限、RPC、标识、声明式 UI 与主题令牌
export * from './plugin/ids.js'
export * from './plugin/permissions.js'
export * from './plugin/protocol.js'
export * from './plugin/usage.js'
export * from './plugin/ui.js'
export * from './plugin/themes.js'
export * from './plugin/icons.js'
export * from './plugin/manifest.js'
