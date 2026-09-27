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
    newSession: () => invoke(IPC.chat.newSession),
    archiveSession: (request) => invoke(IPC.chat.archiveSession, request),
    setSessionProject: (request) => invoke(IPC.chat.setSessionProject, request),
    jobs: (request) => invoke(IPC.chat.jobs, request),
    resumeJob: (request) => invoke(IPC.chat.resumeJob, request),
    cancelJob: (request) => invoke(IPC.chat.cancelJob, request),
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
}

contextBridge.exposeInMainWorld('aurora', api)
