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
// 三档权限的纯判定（docs/06 §11.2）：主进程与渲染层必须看到同一个"生效档位"
export * from './config/permission.js'

// 纯状态机与工具
export * from './mode/windowState.js'
export * from './utils/object.js'
export * from './utils/format.js'

// Agent 输出的 Markdown 渲染（纯浏览器、零 Node 依赖；样式文件 md.css 由
// build 脚本拷进 dist，两端经 `@aurora/shared/browser/markdown/md.css` 引入）
export * from './browser/markdown/index.js'
export * from './browser/markdown/codeBlock.js'
export * from './utils/result.js'
export * from './utils/logger.js'

// ── 两端共用的渲染层资产（2026-10-02 起单源：桌面与 Center Web 同一份实现）──
// 设计令牌 / 暗浅主题 / keyframes / 过渡预设 / 原子类在 `@aurora/shared/browser/theme.css`
// （CSS 不是 JS 模块，由 build 脚本拷进 dist，两端各自 import 该路径）；
// 视觉资产改这里就必须同时核对两端截图（与改 md.css 同一条规矩）。
export * from './browser/icons.js'
export * from './browser/toolIcons.js'
export * from './browser/toolLabels.js'
// 吸底状态机（core 纯逻辑 + Vue 薄壳）与实测高度折叠动画钩子：
// core 的语义（意图只由真实输入发起、250ms 窗口按之后读数重判）两端必须逐字一致。
export * from './browser/composables/stickToBottomCore.js'
export * from './browser/composables/useStickToBottom.js'
export * from './browser/composables/useCollapseTransition.js'
// 流式增量的按帧合并缓冲（2026-10-02 迁入）：桌面端 `useChat` 与网页端 `state/events` 共用一份
// —— 四条语义（同 key 合并 / 一帧一次 apply / 顺序保持 / flush 立即）两端必须逐字一致。
export * from './browser/composables/deltaBuffer.js'
// 请求级工作分组（桌面与 Center 共用同一份边界语义）。
export * from './browser/agentTurns.js'

// IPC 契约（仅类型）
export * from './ipc/channels.js'
export * from './ipc/types.js'

// 模式契约（仅类型）
export * from './mode/types.js'
export * from './agent/types.js'

// Center 协议（CENTER_SESSION_PREFIX 等常量；该文件只有类型与字面量常量，无 Node 依赖）
export * from './center/protocol.js'
