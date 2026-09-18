/** IPC 通道常量（docs/02 §6：命名 `namespace:action`）。 */

export const IPC = {
  app: {
    getInfo: 'app:getInfo',
    quit: 'app:quit',
    openLogs: 'app:openLogs',
    openPath: 'app:openPath',
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
    showMiniChat: 'window:showMiniChat',
    setPosition: 'window:setPosition',
    stateChanged: 'window:stateChanged',
    getState: 'window:getState',
  },
  perception: {
    summary: 'perception:summary',
  },
  skills: {
    list: 'skills:list',
  },
  chat: {
    send: 'chat:send',
    abort: 'chat:abort',
    event: 'chat:event',
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
