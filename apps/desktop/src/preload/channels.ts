/**
 * preload 专用通道表（**零依赖**）。
 *
 * 为什么单独一份：preload 运行在**沙箱化**渲染进程里（`sandbox: true`），
 * 既没有 `node:fs` 之类能力，也无法解析 pnpm 的工作区包
 * （实测 `require('@aurora/shared')` → `Error: module not found`）。
 * 因此 preload 必须是自包含产物：只 `require('electron')` + 字符串常量。
 *
 * 一致性保障：下方的类型断言在编译期要求本表与 `@aurora/shared` 的 `IPC`
 * **双向**键集一致（共享包新增 / 删除通道而这里没跟上 → `pnpm typecheck` 直接报错）。
 * `import type` 会被完全擦除，不产生运行时依赖。
 */
import type { IPC as SharedIpc } from '@aurora/shared'

/** 规范化形状：`{ 分组: { 通道: string } }`（由共享契约推导） */
type Mirror<T> = {
  -readonly [K in keyof T]: { -readonly [A in keyof T[K]]: string }
}

const CHANNELS = {
  app: {
    getInfo: 'app:getInfo',
    quit: 'app:quit',
    openLogs: 'app:openLogs',
    openPath: 'app:openPath',
    smokeDiagnostics: 'app:smokeDiagnostics',
    smokeDropFile: 'app:smokeDropFile',
  },
  settings: {
    get: 'settings:get',
    update: 'settings:update',
    reset: 'settings:reset',
    setSecret: 'settings:setSecrets',
    hasSecret: 'settings:hasSecret',
    clearSecret: 'settings:clearSecret',
    exportRedacted: 'settings:exportRedacted',
    changed: 'settings:changed',
  },
  mode: {
    list: 'mode:list',
    set: 'mode:set',
    completeGuide: 'mode:completeGuide',
    resetGuide: 'mode:resetGuide',
    guideStart: 'guide:start',
    guideAnswer: 'guide:answer',
    guideReset: 'guide:reset',
    changed: 'mode:changed',
  },
  llm: {
    testConnection: 'llm:testConnection',
    listModels: 'llm:listModels',
  },
  tts: {
    synthesize: 'tts:synthesize',
    testConnection: 'tts:testConnection',
  },
  window: {
    show: 'window:show',
    hide: 'window:hide',
    toggle: 'window:toggle',
    showChat: 'window:showChat',
    setPosition: 'window:setPosition',
    setEdgeBarExpanded: 'window:setEdgeBarExpanded',
    stateChanged: 'window:stateChanged',
    getState: 'window:getState',
  },
  perception: {
    summary: 'perception:summary',
  },
  skills: {
    list: 'skills:list',
    rescan: 'skills:rescan',
    status: 'skills:status',
  },
  chat: {
    send: 'chat:send',
    abort: 'chat:abort',
    history: 'chat:history',
    event: 'chat:event',
    sessions: 'chat:sessions',
    // 通道表与 shared 契约同构：新增通道必须两处同步（编译期双向断言会兜住）
    newSession: 'chat:newSession',
  },
  hotkey: {
    status: 'hotkey:status',
    changed: 'hotkey:changed',
  },
  classisland: {
    status: 'classisland:status',
    test: 'classisland:test',
  },
  classification: {
    history: 'classification:history',
    state: 'classification:state',
    correct: 'classification:correct',
    clear: 'classification:clear',
    event: 'classification:event',
  },
  proactive: {
    sensitiveTool: 'proactive:sensitiveTool',
    resolveSensitiveTool: 'proactive:resolveSensitiveTool',
  },
  mcp: {
    status: 'mcp:status',
    statusChanged: 'mcp:statusChanged',
  },
  update: {
    getState: 'update:getState',
    check: 'update:check',
    download: 'update:download',
    install: 'update:install',
    stateChanged: 'update:stateChanged',
  },
} as const

/**
 * 编译期双向校验：
 * - 共享包的每个分组都必须在本地表中存在，且本地表不得有共享包没有的分组；
 * - 共享包的每个分组下，本地表必须**完全覆盖**其通道（反向多出的通道由运行时自测兜底）。
 */
type HasAllGroups<Local, Shared> = keyof Shared extends keyof Local ? true : never
type HasNoExtraGroups<Local, Shared> = keyof Local extends keyof Shared ? true : never
type HasAllChannels<Local, Shared> = {
  [G in keyof Shared]: G extends keyof Local
    ? keyof Shared[G] extends keyof Local[G]
      ? true
      : never
    : never
}[keyof Shared]

const _groupsCovered: HasAllGroups<typeof CHANNELS, Mirror<typeof SharedIpc>> = true
const _groupsExact: HasNoExtraGroups<typeof CHANNELS, Mirror<typeof SharedIpc>> = true
const _channelsCovered: HasAllChannels<typeof CHANNELS, Mirror<typeof SharedIpc>> = true
void _groupsCovered
void _groupsExact
void _channelsCovered

export const PRELOAD_CHANNELS = CHANNELS
export type PreloadChannels = typeof CHANNELS
