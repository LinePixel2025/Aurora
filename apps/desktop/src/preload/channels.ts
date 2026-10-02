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
    listModels: 'tts:listModels',
  },
  // v8 新增（Design/betav2-spec.md §5）：与 shared 的 IPC 同步维护，编译期双向断言会兜住
  stt: {
    transcribe: 'stt:transcribe',
  },
  imagegen: {
    generate: 'imagegen:generate',
    read: 'imagegen:read',
  },
  window: {
    show: 'window:show',
    hide: 'window:hide',
    toggle: 'window:toggle',
    showChat: 'window:showChat',
    setPosition: 'window:setPosition',
    setEdgeBarExpanded: 'window:setEdgeBarExpanded',
    minimize: 'window:minimize',
    toggleMaximize: 'window:toggleMaximize',
    stateChanged: 'window:stateChanged',
    getState: 'window:getState',
  },
  perception: {
    summary: 'perception:summary',
  },
  project: {
    status: 'project:status',
    pickDirectory: 'project:pickDirectory',
  },
  snapshots: {
    list: 'snapshots:list',
    restore: 'snapshots:restore',
    prune: 'snapshots:prune',
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
    // 远程会话激活推送（docs/12 §6.3）：与 shared 契约同构，编译期双向断言会兜住
    remoteActivate: 'chat:remoteActivate',
    // 远程会话可见性变更推送（docs/12 §5 第 8 步，v0.2.4）：同上，双向断言兜住
    centerVisibilityChanged: 'chat:centerVisibilityChanged',
    // 通道表与 shared 契约同构：新增通道必须两处同步（编译期双向断言会兜住）
    newSession: 'chat:newSession',
    archiveSession: 'chat:archiveSession',
    setSessionProject: 'chat:setSessionProject',
    // 会话级模型覆盖（docs/06 §3）：与 shared 契约同构，编译期双向断言兜住
    setSessionModel: 'chat:setSessionModel',
    // 真删除会话（docs/08 会话管理页）：与 shared 契约同构，编译期双向断言兜住
    deleteSession: 'chat:deleteSession',
    // 会话删除推送（docs/07 §2.3）：删除成功后主进程广播被删 id，同上，双向断言兜住
    sessionDeleted: 'chat:sessionDeleted',
    jobs: 'chat:jobs',
    resumeJob: 'chat:resumeJob',
    cancelJob: 'chat:cancelJob',
    // 附件缩略图（v22 多模态输入，docs/07 §2.3）：与 shared 契约同构，编译期双向断言兜住
    readAttachment: 'chat:readAttachment',
  },
  hotkey: {
    status: 'hotkey:status',
    changed: 'hotkey:changed',
  },
  classisland: {
    status: 'classisland:status',
    test: 'classisland:test',
    notify: 'classisland:notify',
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
  // Agent 向用户提问（`ask_user`，docs/06 §21）：与 proactive 分组语义不同
  //（协作问答 vs 敏感动作的确认闸门：超时口径、可否跳过都不一样），刻意分表。
  // 本文件与 `@aurora/shared` 的 `ipc/channels.ts` 有编译期双向断言，漏改一侧 typecheck 会挂。
  askUser: {
    request: 'askUser:request',
    answer: 'askUser:answer',
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
  center: {
    status: 'center:status',
    login: 'center:login',
    // 设备授权登录（docs/12 §4.3）：与 shared 契约同构，编译期双向断言会兜住
    deviceLogin: 'center:deviceLogin',
    deviceLoginResult: 'center:deviceLoginResult',
    deviceLoginCancel: 'center:deviceLoginCancel',
  },
  // 自动化（docs/13 §9）：与 shared 契约同构，编译期双向断言会兜住
  automation: {
    list: 'automation:list',
    save: 'automation:save',
    delete: 'automation:delete',
    history: 'automation:history',
    run: 'automation:run',
    catalog: 'automation:catalog',
    changed: 'automation:changed',
    historyChanged: 'automation:historyChanged',
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
