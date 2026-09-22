/** IPC 通道常量（docs/02 §6：命名 `namespace:action`）。 */

export const IPC = {
  app: {
    getInfo: 'app:getInfo',
    quit: 'app:quit',
    openLogs: 'app:openLogs',
    openPath: 'app:openPath',
    /** 仅开发态自测用（`AURORA_SMOKE=1`），生产环境返回 enabled: false */
    smokeDiagnostics: 'app:smokeDiagnostics',
    /** 仅开发态自测用：把文件放进感知文件夹，触发真实的 chokidar add 事件 */
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
    /** 会话列表 / 新建会话（docs/06 §4） */
    sessions: 'chat:sessions',
    newSession: 'chat:newSession',
  },
  /** 全局快捷键注册状态（docs/07 §5、docs/08 §1） */
  hotkey: {
    status: 'hotkey:status',
    changed: 'hotkey:changed',
  },
  /** ClassIsland 桥接（docs/05 §3.4 v2） */
  classisland: {
    status: 'classisland:status',
    test: 'classisland:test',
  },
  /** ClassRoom 分类管线（docs/05 §3、docs/02 §5.2） */
  classification: {
    history: 'classification:history',
    state: 'classification:state',
    correct: 'classification:correct',
    clear: 'classification:clear',
    event: 'classification:event',
  },
  /** 主动引导与敏感工具确认（docs/06 §5、§9） */
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

export type IpcChannel =
  | (typeof IPC.app)[keyof typeof IPC.app]
  | (typeof IPC.settings)[keyof typeof IPC.settings]
  | (typeof IPC.mode)[keyof typeof IPC.mode]
  | (typeof IPC.llm)[keyof typeof IPC.llm]
  | (typeof IPC.window)[keyof typeof IPC.window]
  | (typeof IPC.perception)[keyof typeof IPC.perception]
  | (typeof IPC.skills)[keyof typeof IPC.skills]
  | (typeof IPC.chat)[keyof typeof IPC.chat]
  | (typeof IPC.hotkey)[keyof typeof IPC.hotkey]
  | (typeof IPC.classisland)[keyof typeof IPC.classisland]
  | (typeof IPC.classification)[keyof typeof IPC.classification]
  | (typeof IPC.proactive)[keyof typeof IPC.proactive]
  | (typeof IPC.mcp)[keyof typeof IPC.mcp]
  | (typeof IPC.update)[keyof typeof IPC.update]
