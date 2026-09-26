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
  /** 语音合成（TTS 朗读，docs/06 §13） */
  tts: {
    synthesize: 'tts:synthesize',
    testConnection: 'tts:testConnection',
    /** 拉取模型列表（GET {baseUrl}/models，设置页「获取模型列表」） */
    listModels: 'tts:listModels',
  },
  /** 语音输入（STT 转写，docs/08 §1） */
  stt: {
    transcribe: 'stt:transcribe',
  },
  /** 图像生成（docs/08 §1）：`read` 仅允许 userData/generated 下的文件（主进程路径校验） */
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
    /** Windows 式标题栏：真最小化（进任务栏）与最大化切换（frame:false，渲染层自绘按钮） */
    minimize: 'window:minimize',
    toggleMaximize: 'window:toggleMaximize',
    stateChanged: 'window:stateChanged',
    getState: 'window:getState',
  },
  perception: {
    summary: 'perception:summary',
  },
  /** 项目机制（v13，docs/06 §5.1）：当前项目状态探测与目录选择 */
  project: {
    status: 'project:status',
    pickDirectory: 'project:pickDirectory',
  },
  /** 写前快照与一键回滚（v14，docs/06 §11.8） */
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
    /** 会话列表 / 新建会话（docs/06 §4） */
    sessions: 'chat:sessions',
    newSession: 'chat:newSession',
    /**
     * 归档 / 取消归档（docs/06 §4）。状态存在会话文件自身的 `meta` 里，
     * **不是**配置项，所以这条通道与 settings 无关、也不进 `SETTINGS_READONLY_PREFIXES`。
     */
    archiveSession: 'chat:archiveSession',
    /** Job（任务）列表 / 续跑 / 取消（v15，docs/06 §4.1） */
    jobs: 'chat:jobs',
    resumeJob: 'chat:resumeJob',
    cancelJob: 'chat:cancelJob',
  },
  /** 全局快捷键注册状态（docs/07 §5、docs/08 §1） */
  hotkey: {
    status: 'hotkey:status',
    changed: 'hotkey:changed',
  },
  /** ClassIsland 桥接（docs/05 §3.4 v2/v3） */
  classisland: {
    status: 'classisland:status',
    test: 'classisland:test',
    notify: 'classisland:notify',
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
  | (typeof IPC.tts)[keyof typeof IPC.tts]
  | (typeof IPC.stt)[keyof typeof IPC.stt]
  | (typeof IPC.imagegen)[keyof typeof IPC.imagegen]
  | (typeof IPC.window)[keyof typeof IPC.window]
  | (typeof IPC.perception)[keyof typeof IPC.perception]
  | (typeof IPC.project)[keyof typeof IPC.project]
  | (typeof IPC.snapshots)[keyof typeof IPC.snapshots]
  | (typeof IPC.skills)[keyof typeof IPC.skills]
  | (typeof IPC.chat)[keyof typeof IPC.chat]
  | (typeof IPC.hotkey)[keyof typeof IPC.hotkey]
  | (typeof IPC.classisland)[keyof typeof IPC.classisland]
  | (typeof IPC.classification)[keyof typeof IPC.classification]
  | (typeof IPC.proactive)[keyof typeof IPC.proactive]
  | (typeof IPC.mcp)[keyof typeof IPC.mcp]
  | (typeof IPC.update)[keyof typeof IPC.update]
