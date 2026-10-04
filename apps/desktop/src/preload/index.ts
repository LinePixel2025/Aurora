/**
 * Preload：把主进程能力以白名单形式暴露给渲染层（docs/02 §2.1、§6）。
 *
 * 安全约定：`contextIsolation: true` + `sandbox: true` + `nodeIntegration: false`，
 * 渲染层只能看到 `window.aurora`，事件订阅返回解除函数（卸载时自动解绑）。
 *
 * 依赖约定：本文件必须**自包含**——只 `require('electron')`，
 * 通道常量取自 `./channels.js`（字符串字面量表，编译期与共享契约比对）。
 * 不要在这里 import `@aurora/shared`：沙箱化 preload 无法解析工作区包。
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AuroraApi, Result } from '@aurora/shared'
import { PRELOAD_CHANNELS as IPC } from './channels.js'

function invoke<T>(channel: string, ...args: unknown[]): Promise<Result<T>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<Result<T>>
}

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

/**
 * 取拖入文件的**绝对路径**（docs/07 §2.3）。
 *
 * Electron 32 起 `File.path` 已被移除，必须走 `webUtils.getPathForFile`。
 * 这个能力只能在 preload 里提供（渲染进程拿不到文件系统路径），
 * 因此单独暴露一个同步方法，而不是把 File 对象塞进 IPC
 * （File 不可结构化克隆，塞过去会直接抛错）。
 */
function filePathOf(file: File): string {
  try {
    return webUtils.getPathForFile(file)
  } catch {
    return ''
  }
}

const api: AuroraApi = {
  app: {
    getInfo: () => invoke(IPC.app.getInfo),
    quit: () => ipcRenderer.invoke(IPC.app.quit) as Promise<void>,
    openPath: (request) => invoke(IPC.app.openPath, request),
    openLogs: () => invoke(IPC.app.openLogs),
    getSmokeDiagnostics: () => invoke(IPC.app.smokeDiagnostics),
    smokeDropFile: (request) => invoke(IPC.app.smokeDropFile, request),
  },
  project: {
    status: () => invoke(IPC.project.status),
    pickDirectory: () => invoke(IPC.project.pickDirectory),
  },
  snapshots: {
    list: (request) => invoke(IPC.snapshots.list, request),
    restore: (request) => invoke(IPC.snapshots.restore, request),
    prune: (request) => invoke(IPC.snapshots.prune, request),
  },
  settings: {
    get: () => invoke(IPC.settings.get),
    update: (patch) => invoke(IPC.settings.update, patch),
    reset: () => invoke(IPC.settings.reset),
    setSecrets: (entries) => invoke(IPC.settings.setSecret, entries),
    hasSecret: (path) => invoke(IPC.settings.hasSecret, path),
    clearSecret: (path) => invoke(IPC.settings.clearSecret, path),
    exportRedacted: () => invoke(IPC.settings.exportRedacted),
    onChanged: (listener) => subscribe(IPC.settings.changed, listener),
  },
  mode: {
    list: () => invoke(IPC.mode.list),
    set: (id) => invoke(IPC.mode.set, id),
    completeGuide: (id) => invoke(IPC.mode.completeGuide, id),
    resetGuide: (id) => invoke(IPC.mode.resetGuide, id),
    guideStart: (id) => invoke(IPC.mode.guideStart, id),
    guideAnswer: (id, answer) => invoke(IPC.mode.guideAnswer, id, answer),
    guideReset: (id) => invoke(IPC.mode.guideReset, id),
    onChanged: (listener) => subscribe(IPC.mode.changed, listener),
  },
  llm: {
    testConnection: (request) => invoke(IPC.llm.testConnection, request),
    listModels: (request) => invoke(IPC.llm.listModels, request),
  },
  tts: {
    synthesize: (request) => invoke(IPC.tts.synthesize, request),
    testConnection: (request) => invoke(IPC.tts.testConnection, request),
    listModels: (request) => invoke(IPC.tts.listModels, request),
  },
  stt: {
    transcribe: (request) => invoke(IPC.stt.transcribe, request),
  },
  imagegen: {
    generate: (request) => invoke(IPC.imagegen.generate, request),
    read: (request) => invoke(IPC.imagegen.read, request),
  },
  preview: {
    // 右栏「文件」预览（docs/07 §2.3）：路径边界与大小上限都在主进程侧判定
    read: (request) => invoke(IPC.preview.read, request),
    // 列目录（小文件管理器，2026-10-03）：同样只在主进程侧解析边界与读盘
    list: (request) => invoke(IPC.preview.list, request),
    // Agent 展示推送（show_preview 工具）：主进程 → 渲染层，on/off 成对
    onShow: (listener) => subscribe(IPC.preview.show, listener),
  },
  browser: {
    // 站点自开标签（target="_blank" / window.open 的 http(s) 目标）：主进程 → 渲染层，成对
    onOpenTab: (listener) => subscribe(IPC.browser.openTab, listener),
  },
  terminal: {
    // 右栏「终端」（docs/07 §2.3）：PTY 交互终端，输出经 data/exit 推送（on/off 成对）
    create: (request) => invoke(IPC.terminal.create, request),
    input: (request) => invoke(IPC.terminal.input, request),
    resize: (request) => invoke(IPC.terminal.resize, request),
    kill: (request) => invoke(IPC.terminal.kill, request),
    onData: (listener) => subscribe(IPC.terminal.data, listener),
    onExit: (listener) => subscribe(IPC.terminal.exit, listener),
  },
  window: {
    show: (name) => invoke(IPC.window.show, name),
    hide: (name) => invoke(IPC.window.hide, name),
    toggle: (name) => invoke(IPC.window.toggle, name),
    showChat: () => invoke(IPC.window.showChat),
    setPosition: (name, position) => invoke(IPC.window.setPosition, name, position),
    setEdgeBarExpanded: (expanded) => invoke(IPC.window.setEdgeBarExpanded, expanded),
    minimize: (name) => invoke(IPC.window.minimize, name),
    toggleMaximize: (name) => invoke(IPC.window.toggleMaximize, name),
    getState: () => invoke(IPC.window.getState),
    onStateChanged: (listener) => subscribe(IPC.window.stateChanged, listener),
  },
  perception: {
    summary: () => invoke(IPC.perception.summary),
  },
  skills: {
    list: () => invoke(IPC.skills.list),
    rescan: () => invoke(IPC.skills.rescan),
    status: () => invoke(IPC.skills.status),
  },
  hotkey: {
    status: () => invoke(IPC.hotkey.status),
    onChanged: (listener) => subscribe(IPC.hotkey.changed, listener),
  },
  classisland: {
    status: () => invoke(IPC.classisland.status),
    test: () => invoke(IPC.classisland.test),
    notify: (request) => invoke(IPC.classisland.notify, request),
  },
  chat: {
    send: (request) => invoke(IPC.chat.send, request),
    abort: (requestId) => invoke(IPC.chat.abort, requestId),
    onEvent: (listener) => subscribe(IPC.chat.event, listener),
    history: (request) => invoke(IPC.chat.history, request),
    sessions: () => invoke(IPC.chat.sessions),
    // 远程会话激活推送（docs/12 §6.3）：Center 让主界面切会话时由主进程推
    onRemoteActivate: (listener) => subscribe(IPC.chat.remoteActivate, listener),
    // 远程会话可见性变更推送（docs/12 §5 第 8 步）：Center 开关左栏可见性后由主进程推
    onCenterVisibilityChanged: (listener) => subscribe(IPC.chat.centerVisibilityChanged, listener),
    // 会话删除推送（docs/07 §2.3）：主进程删成功后广播被删 id，各窗口重拉列表并对齐当前会话
    onSessionDeleted: (listener) => subscribe(IPC.chat.sessionDeleted, listener),
    // 会话三分（docs/06 §4）：space / projectId 只透传（纯字面量，无 Proxy 克隆问题）
    newSession: (options) => invoke(IPC.chat.newSession, options),
    // 真删除会话（docs/08 会话管理页）：不可逆，二次确认由调用方负责
    deleteSession: (sessionId) => invoke(IPC.chat.deleteSession, { sessionId }),
    // 手动压缩上下文（/compact，docs/06 §4）：渲染层斜杠命令直接调，不进 chat:send
    compact: (sessionId: string) => invoke(IPC.chat.compact, { sessionId }),
    archiveSession: (request) => invoke(IPC.chat.archiveSession, request),
    setSessionProject: (request) => invoke(IPC.chat.setSessionProject, request),
    // 会话级模型覆盖（docs/06 §3，本轮）：model 空串 = 清除覆盖
    setSessionModel: (request) => invoke(IPC.chat.setSessionModel, request),
    jobs: (request) => invoke(IPC.chat.jobs, request),
    resumeJob: (request) => invoke(IPC.chat.resumeJob, request),
    cancelJob: (request) => invoke(IPC.chat.cancelJob, request),
    // 附件缩略图（v22 多模态输入，docs/07 §2.3）：主进程读盘 → data URL，渲染层只拿结果
    readAttachment: (request) => invoke(IPC.chat.readAttachment, request),
    // 助手消息图片区：同样只回 data URL，原图路径不进入渲染层
    readDisplayImage: (request) => invoke(IPC.chat.readDisplayImage, request),
    // 附件拖拽：同步返回路径，渲染层再把它放进 chat.send 的 attachments
    filePath: (file) => filePathOf(file),
  },
  classification: {
    history: (limit) => invoke(IPC.classification.history, limit),
    state: () => invoke(IPC.classification.state),
    correct: (input) => invoke(IPC.classification.correct, input),
    clear: () => invoke(IPC.classification.clear),
    onEvent: (listener) => subscribe(IPC.classification.event, listener),
  },
  proactive: {
    onSensitiveTool: (listener) => subscribe(IPC.proactive.sensitiveTool, listener),
    // `always` 缺省时显式传 false：主进程侧的判定是 `always === true`，不依赖 undefined 的序列化
    resolveSensitiveTool: (confirmId, approved, always) =>
      invoke(IPC.proactive.resolveSensitiveTool, confirmId, approved, always === true),
  },
  askUser: {
    onRequest: (listener) => subscribe(IPC.askUser.request, listener),
    // 把 skipped 归一成布尔再传：主进程按 `skipped === true` 判定，不依赖 undefined 的序列化
    answer: (input) =>
      invoke(IPC.askUser.answer, {
        requestId: input.requestId,
        answers: input.answers,
        // 多问的分组作答（本轮）：只在给定时带上，未给定时保持旧形状
        ...(input.answersByQuestion === undefined
          ? {}
          : { answersByQuestion: input.answersByQuestion }),
        skipped: input.skipped === true,
      }),
  },
  mcp: {
    status: () => invoke(IPC.mcp.status),
    onStatusChanged: (listener) => subscribe(IPC.mcp.statusChanged, listener),
  },
  update: {
    getState: () => invoke(IPC.update.getState),
    check: () => invoke(IPC.update.check),
    download: () => invoke(IPC.update.download),
    install: () => invoke(IPC.update.install),
    onStateChanged: (listener) => subscribe(IPC.update.stateChanged, listener),
  },
  center: {
    status: () => invoke(IPC.center.status),
    login: (request) => invoke(IPC.center.login, request),
    // 设备授权登录（docs/12 §4.3）：触发后立即回执，最终结果走独立推送通道
    deviceLogin: (request) => invoke(IPC.center.deviceLogin, request),
    onDeviceLoginResult: (listener) => subscribe(IPC.center.deviceLoginResult, listener),
    deviceLoginCancel: () => invoke(IPC.center.deviceLoginCancel),
  },
  // 自动化（docs/13 §9）：定义 CRUD + 历史 + 手动触发 + 组件目录
  automation: {
    list: () => invoke(IPC.automation.list),
    save: (definition) => invoke(IPC.automation.save, definition),
    delete: (request) => invoke(IPC.automation.delete, request),
    history: (request) => invoke(IPC.automation.history, request),
    run: (request) => invoke(IPC.automation.run, request),
    catalog: () => invoke(IPC.automation.catalog),
    onChanged: (listener) => subscribe(IPC.automation.changed, listener),
    onHistoryChanged: (listener) => subscribe(IPC.automation.historyChanged, listener),
  },
  awareness: {
    status: () => invoke(IPC.awareness.status),
    records: (request) => invoke(IPC.awareness.records, request),
    notes: (request) => invoke(IPC.awareness.notes, request),
    readNote: (request) => invoke(IPC.awareness.readNote, request),
    setNoteExpiry: (request) => invoke(IPC.awareness.setNoteExpiry, request),
    presentNote: (request) => invoke(IPC.awareness.presentNote, request),
    onNotePresented: (listener) => subscribe(IPC.awareness.notePresented, listener),
    analyzeNow: (request) => invoke(IPC.awareness.analyzeNow, request),
    ignore: (request) => invoke(IPC.awareness.ignore, request),
    execute: (request) => invoke(IPC.awareness.execute, request),
    openKnowledge: () => invoke(IPC.awareness.openKnowledge),
    openNote: (request) => invoke(IPC.awareness.openNote, request),
    openSource: (request) => invoke(IPC.awareness.openSource, request),
    clearHistory: () => invoke(IPC.awareness.clearHistory),
    scanNow: () => invoke(IPC.awareness.scanNow),
    onSuggestion: (listener) => subscribe(IPC.awareness.suggestion, listener),
    onChanged: (listener) => subscribe(IPC.awareness.changed, listener),
  },
}

contextBridge.exposeInMainWorld('aurora', api)
