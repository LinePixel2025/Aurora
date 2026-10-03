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
  /** 右栏「文件」预览（2026-10-03）：主进程读盘，路径受会话边界根约束（docs/07 §2.3） */
  preview: {
    read: 'preview:read',
    /**
     * 列目录（2026-10-03）：右栏「文件」tab 变成小文件管理器 —— 缺省列出**会话项目根**
     * （未绑定项目时是会话空间目录），可在边界根内逐层进入。
     */
    list: 'preview:list',
    /**
     * Agent 展示推送（`show_preview` 工具，2026-10-03，主进程 → 渲染层，on/off 成对）：
     * 主进程校验目标（http(s) 或边界根内的本地文件）后，让主界面右栏切到「浏览器」tab
     * 并展示它 —— 成果直接出现在对话旁边，而不是把大段内容贴进消息里。
     */
    show: 'preview:show',
  },
  /**
   * 内置浏览器的**站点自开标签**（2026-10-03，主进程 → 渲染层，on/off 成对）。
   *
   * 网页里 `target="_blank"` / `window.open` 的 http(s) 目标不再把当前页顶掉（旧口径是
   * 「同窗导航」），而是让右栏**另开一个浏览器标签**加载它 —— 用户口径「网站需要单独跳出
   * 一个标签页的话可以单开」。非 http(s)（file: / 自定义协议 / about:blank）仍一律拒绝。
   */
  browser: {
    /** 站点请求另开标签：{ url }（地址栏回显同一个 URL） */
    openTab: 'browser:openTab',
  },
  /**
   * 右栏「终端」tab（2026-10-03，docs/07 §2.3）：PTY 交互终端。
   * `data` / `exit` 是主进程 → 渲染层的推送（on/off 成对），且**只推给创建终端的窗口**。
   */
  terminal: {
    /** 创建（或复用）发起窗口的常驻 shell */
    create: 'terminal:create',
    /** 向 shell 写入（键盘输入） */
    input: 'terminal:input',
    /** 尺寸变化（cols/rows） */
    resize: 'terminal:resize',
    /** 主动关闭 shell */
    kill: 'terminal:kill',
    /** shell 输出推送：{ terminalId, data } */
    data: 'terminal:data',
    /** shell 退出推送：{ terminalId, exitCode } */
    exit: 'terminal:exit',
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
    /** 远程会话激活推送（docs/12 §6.3，主进程 → 渲染层，on/off 成对） */
    remoteActivate: 'chat:remoteActivate',
    /**
     * 远程会话可见性变更推送（docs/12 §5 第 8 步，v0.2.4，on/off 成对）：
     * Center 的 `session.visibility` 在客户端落盘成功后，主进程经此通道通知
     * chat 渲染层重拉会话列表（左栏立即按新可见性过滤）。
     */
    centerVisibilityChanged: 'chat:centerVisibilityChanged',
    newSession: 'chat:newSession',
    /**
     * 归档 / 取消归档（docs/06 §4）。状态存在会话文件自身的 `meta` 里，
     * **不是**配置项，所以这条通道与 settings 无关、也不进 `SETTINGS_READONLY_PREFIXES`。
     */
    archiveSession: 'chat:archiveSession',
    /** 绑定 / 解绑会话项目（docs/06 §5.1 会话级项目）：写会话文件 meta.projectId，与 settings 无关 */
    setSessionProject: 'chat:setSessionProject',
    /**
     * 会话级模型覆盖（docs/06 §3，本轮）：写会话文件 `meta.llm = { providerId, model }`，
     * 与 settings 无关（全局默认仍由设置页 / `settings:update` 维护）。`model` 空串 = 清除覆盖。
     */
    setSessionModel: 'chat:setSessionModel',
    /**
     * 真删除会话（docs/08 会话管理页）：删 `sessions/<id>.json` 文件 + 清全部内存态，
     * **不可逆**。主进程守卫：该会话有 running 状态的 job 时拒绝（E_INVALID_STATE）。
     */
    deleteSession: 'chat:deleteSession',
    /**
     * 手动压缩会话上下文（`/compact`，docs/06 §4）：把全部消息压成摘要写进 `meta.compact`，
     * 此后组装请求只取压缩点之后的消息。消息本体不删。在跑的会话拒绝（E_BUSY 文案）。
     */
    compact: 'chat:compact',
    /**
     * 真删除会话成功后的跨窗口推送（on/off 成对，docs/07 §2.3）：
     * 主进程在 `chat:deleteSession` 删除成功后向所有窗口广播 `{ sessionId }`，
     * chat 窗口据此重拉会话列表，当前会话被删时按「最近会话 / 新建」回落。
     */
    sessionDeleted: 'chat:sessionDeleted',
    /** Job（任务）列表 / 续跑 / 取消（v15，docs/06 §4.1） */
    jobs: 'chat:jobs',
    resumeJob: 'chat:resumeJob',
    cancelJob: 'chat:cancelJob',
    /**
     * 附件缩略图（v22 多模态输入，docs/07 §2.3）：把本地图片附件读成 `data:` URL
     * 供渲染层在 chip 上显示缩略图。**只读、只回数据 URL**（渲染层拿不到任意文件内容，
     * 上限 `PREVIEW_MAX_BYTES`，超出即如实回 `note` 不返回半张图）。
     */
    readAttachment: 'chat:readAttachment',
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
  /**
   * Agent 向用户提问（`ask_user`，docs/06 §21）：请求推送 + 回答回执。
   *
   * 与 `proactive:*` 分开而不是塞进去：那个分组的语义是「**敏感动作**的确认闸门」
   * （超时按拒绝、有 always 记忆），提问是**协作**（超时不算拒绝、可跳过）——
   * 语义不同、超时口径不同，混在一组里迟早会被谁按错语义改一处。
   */
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
  /** Aurora Center 连接（docs/12）：状态查询 + 账号登录（v0.2.1，§3/§7）+ 设备授权登录（§4.3） */
  center: {
    status: 'center:status',
    login: 'center:login',
    /** 设备授权登录：触发后立即回执（已打开浏览器），最终结果走 deviceLoginResult 推送 */
    deviceLogin: 'center:deviceLogin',
    /** 设备授权登录的最终结果推送（on/off 成对） */
    deviceLoginResult: 'center:deviceLoginResult',
    /** 取消在途的设备授权轮询（设置页关闭时调用；幂等） */
    deviceLoginCancel: 'center:deviceLoginCancel',
  },
  /**
   * 自动化（v0.2.5，docs/13 §9）：定义 CRUD + 历史 + 手动触发 + 组件目录。
   * 定义与历史存储在 `<userData>/automations/*.json`（不进配置）；
   * 内置自动化的启停走既有 `settings:update`（`modes.classroom.preClass*`），不经这里。
   */
  automation: {
    list: 'automation:list',
    save: 'automation:save',
    delete: 'automation:delete',
    history: 'automation:history',
    run: 'automation:run',
    catalog: 'automation:catalog',
    /** 定义变化推送（on/off 成对）：各窗口重拉 list */
    changed: 'automation:changed',
    /** 运行记录落库 / 状态变化推送（on/off 成对）：历史面板开着时重拉 */
    historyChanged: 'automation:historyChanged',
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
  | (typeof IPC.preview)[keyof typeof IPC.preview]
  | (typeof IPC.terminal)[keyof typeof IPC.terminal]
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
  | (typeof IPC.askUser)[keyof typeof IPC.askUser]
  | (typeof IPC.mcp)[keyof typeof IPC.mcp]
  | (typeof IPC.update)[keyof typeof IPC.update]
  | (typeof IPC.automation)[keyof typeof IPC.automation]
