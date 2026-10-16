/**
 * 全部上行动作（命令 + 登录 / 启动 / 登出）。
 *
 * 每个动作都只做三件事：组命令 → 等 `result` 回执（`lib/socket.ts` 的 command）→
 * 按回执更新本地状态（乐观更新只在切模型那类"快照随后会推新值兜底"的场合用）。
 * 视图层不直接碰 socket。
 */
import type {
  AutomationCatalog,
  AutomationDefinition,
  AutomationHistoryQuery,
  AutomationListResult,
  AutomationRun,
  CenterProjectOption,
  CenterSessionHistoryMessage,
  ChatDisplayImageReadResult,
  CenterSessionSummary,
  CenterWebMessage,
  ClientStatus,
  PermissionMode,
  ReasoningEffort,
} from '@aurora/shared'
import { api, clearAuth, getToken, loadStoredAuth, saveAuth } from '../lib/api'
import { extractRemoteLlm, type RemoteLlmConfig } from '../lib/remote-llm'
import { command, nextRequestId, rejectAllCommands, socket } from '../lib/socket'
import { flushStreamDeltas, summarizeInput } from './events'
import {
  actionNotice,
  ensureSessionState,
  replaceClients,
  sessionKey,
  sessionViewTick,
  settleAsk,
  state,
  statusBuffer,
  type AskEntry,
  type ChatItem,
  type ClientEntry,
  type ConfirmEntry,
  type SessionState,
} from './store'

// ───────────────────────── 客户端与新建会话 ─────────────────────────

/** 新建远程会话：session.create → result 回执 data.sessionId → 进入会话视图 */
export async function startSession(clientId: string): Promise<void> {
  const data = await command<{ sessionId: string }>({
    type: 'session.create',
    requestId: nextRequestId(),
    clientId,
  })
  const entry = state.clients.get(clientId)
  const session: SessionState = {
    clientId,
    sessionId: data.sessionId,
    items: [],
    agentRequestId: null,
    pending: false,
    historyLoaded: true, // 新建的会话没有历史可拉
    title: '远程会话',
  }
  state.sessions.set(sessionKey(clientId, data.sessionId), session)
  // 移动端抽屉联动：新建会话同样算「打开了会话」（与 openRemoteSession 同口径）
  sessionViewTick.value += 1
  // 会话列表合并：本页签新建的会话若还没在 session.list 结果里，先插占位条目
  if (entry && !entry.remoteSessions.some((s) => s.sessionId === data.sessionId)) {
    mergeRemoteSessions(entry, [
      {
        sessionId: data.sessionId,
        title: '远程会话',
        updatedAt: new Date().toISOString(),
      },
    ])
  }
  state.activeSessionKey = sessionKey(clientId, data.sessionId)
}

/** 打开某个远程会话（含 session.list 拉回的历史会话）：无本地会话态时先建空壳再切过去 */
export function openRemoteSession(clientId: string, sessionId: string): void {
  const key = sessionKey(clientId, sessionId)
  const session = ensureSessionState(clientId, sessionId)
  const summary = state.clients
    .get(clientId)
    ?.remoteSessions.find((item) => item.sessionId === sessionId)
  if (summary?.title) session.title = summary.title
  state.activeSessionKey = key
  sessionViewTick.value += 1
  // 历史回放（docs/12 §5 第 7 步）：还没拉过历史就拉一次。回执到达时若实时事件已经落了
  // 条目（流式期间打开），mergeHistory 按 id / 内容去重后把历史排在实时条目之前。
  if (session.historyLoaded !== true) {
    session.historyLoaded = true
    void fetchSessionHistory(clientId, sessionId)
      .then((history) => {
        const target = state.sessions.get(key)
        if (target) mergeHistory(target, history)
      })
      .catch(() => {
        // 拉取失败且会话仍为空：回退标记，下次打开重试（失败时不闪错误，会话照常可用）
        const target = state.sessions.get(key)
        if (target && target.items.length === 0) target.historyLoaded = false
      })
  }
}

// ───────────────────────── 历史回放（docs/12 §5 第 7 步） ─────────────────────────

/** 拉取某个远程会话的历史（客户端从 SessionStore 读盘回传，最近 200 条） */
async function fetchSessionHistory(
  clientId: string,
  sessionId: string,
): Promise<CenterSessionHistoryMessage[]> {
  const data = await command<CenterSessionHistoryMessage[]>({
    type: 'session.history',
    requestId: nextRequestId(),
    clientId,
    sessionId,
  })
  return Array.isArray(data) ? data : []
}

/** 按 imageId 让客户端现场读一张对话图片；服务器只转发，不缓存图片内容。 */
export async function readDisplayImage(
  clientId: string,
  sessionId: string,
  imageId: string,
): Promise<ChatDisplayImageReadResult> {
  const data = await command<ChatDisplayImageReadResult>({
    type: 'session.readImage',
    requestId: nextRequestId(),
    clientId,
    sessionId,
    imageId,
  })
  if (
    typeof data?.dataUrl !== 'string' ||
    typeof data.name !== 'string' ||
    typeof data.mime !== 'string'
  ) {
    throw new Error('客户端没有返回有效图片')
  }
  return data
}

/** 历史消息 → 助手 ChatItem（工具卡入参经 summarizeInput 压成单行，与实时聚合同口径） */
function historyToAssistant(msg: CenterSessionHistoryMessage): ChatItem {
  return {
    id: msg.id,
    kind: 'assistant',
    content: msg.content,
    ...(msg.requestId === undefined ? {} : { requestId: msg.requestId }),
    createdAt: Date.parse(msg.createdAt) || Date.now(),
    ...(msg.reasoning === undefined || msg.reasoning === '' ? {} : { reasoning: msg.reasoning }),
    tools: (msg.toolCalls ?? []).map((call) => ({
      id: call.id,
      name: call.name,
      state: call.state,
      inputSummary: summarizeInput(call.input),
      ...(call.input === undefined ? {} : { input: call.input }),
      ...(call.outputSummary === undefined ? {} : { outputSummary: call.outputSummary }),
      ...(call.subagent === undefined ? {} : { subagent: call.subagent }),
      ...(call.displayImages === undefined ? {} : { displayImages: call.displayImages }),
    })),
    streaming: false, // 历史条目都是已收尾的消息，不显示流式光标
  }
}

/**
 * 把历史合并进会话 items：历史条目排前、实时条目排后。
 *
 * 实时条目只可能来自页面打开后的事件（比历史快照新），所以这个顺序天然正确；
 * 去重保证流式期间拉取也不重复：
 * - 助手消息按**存储消息 id** 对齐（内核预领的 messageId 就是落盘 id，实时与历史同源）；
 * - 用户消息按「内容 + 出现次数」配对：live 里同内容的是**最新**的若干条，
 *   与历史里**末尾**同样多条配对跳过，更早的同内容历史条目照常保留
 *   （按纯内容 Set 去重会把「历史两条、live 一条」里的第一条也吞掉）。
 */
function mergeHistory(session: SessionState, history: CenterSessionHistoryMessage[]): void {
  if (history.length === 0) return
  // 先落在途的流式增量：历史是按 `id` / 内容与实时条目配对的，缓存里的正文还没写进
  // `items` 时配对判据会看不到它（虽然本会话 id 命中时不重复，但顺序会漂）——
  // 与 `done` / `error` 之前那条 flush 同一理由（deltaBuffer 语义 4）。
  flushStreamDeltas()
  const liveUserCounts = new Map<string, number>()
  for (const item of session.items) {
    if (item.kind !== 'user') continue
    liveUserCounts.set(item.content, (liveUserCounts.get(item.content) ?? 0) + 1)
  }
  const historyUserTotals = new Map<string, number>()
  for (const msg of history) {
    if (msg.role !== 'user') continue
    historyUserTotals.set(msg.content, (historyUserTotals.get(msg.content) ?? 0) + 1)
  }
  const historyUserSeen = new Map<string, number>()
  const liveAssistantIds = new Set(
    session.items.filter((item) => item.kind === 'assistant').map((item) => item.id),
  )
  const prefix: ChatItem[] = []
  for (const msg of history) {
    // 提问留痕（本轮，docs/12 §5）：客户端把提问与作答持久化在会话文件里，
    // 随历史回放成 `kind: 'ask'` 条目 —— 渲染成**只读的已结算卡**。
    // 已由实时路径落过同一张卡的（requestId 相同）跳过，避免刷新后出现两张。
    if (msg.kind === 'ask') {
      const ask = msg.ask
      if (ask === undefined) continue
      const id = `ask-${ask.requestId}`
      if (session.items.some((item) => item.id === id)) continue
      prefix.push({
        id,
        kind: 'ask',
        content: ask.question,
        tools: [],
        ask: {
          requestId: ask.requestId,
          question: ask.question,
          ...(ask.header === undefined ? {} : { header: ask.header }),
          ...(ask.options === undefined ? {} : { options: ask.options }),
          multiSelect: ask.multiSelect,
          // 历史条目都是已结算的：没有倒计时，expiresAt 用一个已过去的值占位
          expiresAt: 0,
          settled: {
            outcome: ask.outcome,
            answers: ask.answers,
            ...(ask.answersByQuestion === undefined
              ? {}
              : { answersByQuestion: ask.answersByQuestion }),
          },
        },
      })
      continue
    }
    if (msg.role === 'user') {
      const seen = (historyUserSeen.get(msg.content) ?? 0) + 1
      historyUserSeen.set(msg.content, seen)
      // 倒数第 N 条（N = live 同内容条数）之内才跳过：live 对应历史的末尾若干条
      const remaining = (historyUserTotals.get(msg.content) ?? 0) - seen
      if (remaining < (liveUserCounts.get(msg.content) ?? 0)) continue
      prefix.push({
        id: `user-hist-${msg.id}`,
        kind: 'user',
        content: msg.content,
        tools: [],
        ...(msg.requestId === undefined ? {} : { requestId: msg.requestId }),
        createdAt: Date.parse(msg.createdAt) || Date.now(),
      })
      continue
    }
    if (liveAssistantIds.has(msg.id)) continue
    prefix.push(historyToAssistant(msg))
  }
  if (prefix.length === 0) return
  session.items = [...prefix, ...session.items]
}

// ───────────────────────── 远程会话管理（docs/12 §6.3） ─────────────────────────

/** session.list 结果 ∪ 已有列表（含本页签占位），按 updatedAt 倒序 */
function mergeRemoteSessions(entry: ClientEntry, list: CenterSessionSummary[]): void {
  const merged = new Map<string, CenterSessionSummary>()
  for (const item of entry.remoteSessions) merged.set(item.sessionId, item)
  for (const item of list) merged.set(item.sessionId, item)
  entry.remoteSessions = [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** 拉取客户端的 center- 会话列表并合并进本地状态 */
export async function listSessions(clientId: string): Promise<CenterSessionSummary[]> {
  const data = await command<CenterSessionSummary[]>({
    type: 'session.list',
    requestId: nextRequestId(),
    clientId,
  })
  const entry = state.clients.get(clientId)
  if (entry && Array.isArray(data)) mergeRemoteSessions(entry, data)
  return Array.isArray(data) ? data : []
}

/** 让客户端主界面切到指定会话 */
export async function activateSession(clientId: string, sessionId: string): Promise<void> {
  await command({
    type: 'session.activate',
    requestId: nextRequestId(),
    clientId,
    sessionId,
  })
}

/** 开关会话在客户端左栏的可见性（缺省可见；隐藏仍可远程输入） */
export async function setSessionVisibility(
  clientId: string,
  sessionId: string,
  visible: boolean,
): Promise<void> {
  await command({
    type: 'session.visibility',
    requestId: nextRequestId(),
    clientId,
    sessionId,
    visible,
  })
  // 回执成功后再落本地视图状态（失败时组件侧会重新拉列表对齐）
  const summary = state.clients.get(clientId)?.remoteSessions.find((s) => s.sessionId === sessionId)
  if (summary) summary.centerVisible = visible
}

/**
 * 会话级权限档覆盖（不动全局 `agent.permissionMode`）。
 * 「跟随全局」没有对应的清除命令，网页端只做展示提示（见会话面板）。
 */
export async function setSessionPermission(
  clientId: string,
  sessionId: string,
  permissionMode: PermissionMode,
): Promise<void> {
  await command({
    type: 'session.setPermission',
    requestId: nextRequestId(),
    clientId,
    sessionId,
    permissionMode,
  })
  const summary = state.clients.get(clientId)?.remoteSessions.find((s) => s.sessionId === sessionId)
  if (summary) summary.permissionMode = permissionMode
}

/** 会话绑定项目（'' = 清除绑定） */
export async function setSessionProject(
  clientId: string,
  sessionId: string,
  projectId: string,
): Promise<void> {
  await command({
    type: 'session.setProject',
    requestId: nextRequestId(),
    clientId,
    sessionId,
    projectId,
  })
  const summary = state.clients.get(clientId)?.remoteSessions.find((s) => s.sessionId === sessionId)
  if (summary) summary.projectId = projectId
}

/** 客户端项目选项（绑定下拉用） */
export async function listProjects(clientId: string): Promise<CenterProjectOption[]> {
  const data = await command<CenterProjectOption[]>({
    type: 'project.list',
    requestId: nextRequestId(),
    clientId,
  })
  return Array.isArray(data) ? data : []
}

/**
 * 会话级模型覆盖（docs/06 §3，本轮）：`model` 空串 = 清除覆盖（回落全局 `llm.active`）。
 * 成功后乐观更新会话摘要上的 `llm`（`session.list` 的刷新会兜底）。
 */
export async function setSessionModel(
  clientId: string,
  sessionId: string,
  providerId: string,
  model: string,
): Promise<void> {
  await command({
    type: 'session.setModel',
    requestId: nextRequestId(),
    clientId,
    sessionId,
    ...(providerId === '' ? {} : { providerId }),
    model,
  })
  const summary = state.clients.get(clientId)?.remoteSessions.find((s) => s.sessionId === sessionId)
  if (!summary) return
  if (model === '' || providerId === '') delete summary.llm
  else summary.llm = { providerId, model }
}

/**
 * 远程切模型 / 思考等级（专用命令，不走 config.update 白名单，docs/12 §6.3）。
 * 成功后乐观更新本地 llm 快照（client.status 随后也会推新值兜底），并**补拉一次配置切片**：
 * contextWindow 只能从 `config.get` 的 modelParams[模型] 拿到，不在 status 快照里。
 */
export async function switchLlm(
  clientId: string,
  patch: { providerId?: string; model?: string; reasoningEffort?: ReasoningEffort },
): Promise<void> {
  await command({
    type: 'llm.switch',
    requestId: nextRequestId(),
    clientId,
    ...patch,
  })
  const entry = state.clients.get(clientId)
  const llm = entry?.status?.llm
  if (!entry || !llm) return
  if (patch.providerId) {
    llm.activeProviderId = patch.providerId
    // 切 provider 时把该 provider 的默认模型 / 思考等级一并带上，避免展示串位
    const provider = entry.remoteLlm?.providers[patch.providerId]
    if (provider) {
      llm.model = patch.model ?? provider.model
      llm.reasoningEffort = patch.reasoningEffort ?? provider.reasoningEffort
    }
  }
  if (patch.model) llm.model = patch.model
  if (patch.reasoningEffort) llm.reasoningEffort = patch.reasoningEffort
  await fetchRemoteConfig(clientId).catch(() => {})
}

/** config.get（脱敏全量配置）→ 解析出网页端关心的 LLM 切片并缓存到客户端条目 */
export async function fetchRemoteConfig(clientId: string): Promise<RemoteLlmConfig | null> {
  const data = await command<unknown>({
    type: 'config.get',
    requestId: nextRequestId(),
    clientId,
  })
  const llm = extractRemoteLlm(data)
  const entry = state.clients.get(clientId)
  if (entry) entry.remoteLlm = llm
  return llm
}

// ───────────────────────── 远程自动化管理（docs/13 §10） ─────────────────────────

/** 拉取客户端的自动化列表（user + builtin）并缓存到展示状态 */
export async function listAutomations(clientId: string): Promise<AutomationListResult> {
  const data = await command<AutomationListResult>({
    type: 'automation.list',
    requestId: nextRequestId(),
    clientId,
  })
  if (data && typeof data === 'object') {
    state.automationsByClient.set(clientId, {
      user: Array.isArray(data.user) ? data.user : [],
      builtin: Array.isArray(data.builtin) ? data.builtin : [],
    })
  }
  return {
    user: Array.isArray(data?.user) ? data.user : [],
    builtin: Array.isArray(data?.builtin) ? data.builtin : [],
  }
}

/** 拉取客户端的组件目录（触发器 / 操作表单元数据）并缓存 */
export async function fetchAutomationCatalog(clientId: string): Promise<AutomationCatalog> {
  const data = await command<AutomationCatalog>({
    type: 'automation.catalog',
    requestId: nextRequestId(),
    clientId,
  })
  const catalog: AutomationCatalog = {
    conditions: Array.isArray(data?.conditions) ? data.conditions : [],
    actions: Array.isArray(data?.actions) ? data.actions : [],
  }
  state.automationCatalogByClient.set(clientId, catalog)
  return catalog
}

/**
 * 新建 / 修改一份自动化（id 为空 = 新建；启停开关也走它 —— 整份定义回传）。
 * 成功后重拉列表，让本地视图对齐客户端的真实落盘结果。
 */
export async function saveAutomation(
  clientId: string,
  definition: AutomationDefinition,
): Promise<AutomationDefinition> {
  const data = await command<AutomationDefinition>({
    type: 'automation.save',
    requestId: nextRequestId(),
    clientId,
    definition,
  })
  await listAutomations(clientId).catch(() => {})
  return data
}

/** 删除一份自动化；成功后重拉列表 */
export async function deleteAutomation(clientId: string, id: string): Promise<void> {
  await command({
    type: 'automation.delete',
    requestId: nextRequestId(),
    clientId,
    id,
  })
  await listAutomations(clientId).catch(() => {})
}

/** 手动触发一次；返回 runId（Agent Mode 下同时是会话 id） */
export async function runAutomation(clientId: string, id: string): Promise<string> {
  const data = await command<{ runId: string }>({
    type: 'automation.run',
    requestId: nextRequestId(),
    clientId,
    id,
  })
  return typeof data?.runId === 'string' ? data.runId : ''
}

/** 拉取运行历史（triggeredAt 倒序）；缓存最后一次结果供列表读 */
export async function fetchAutomationHistory(
  clientId: string,
  query?: AutomationHistoryQuery,
): Promise<AutomationRun[]> {
  const data = await command<AutomationRun[]>({
    type: 'automation.history',
    requestId: nextRequestId(),
    clientId,
    ...(query?.automationId === undefined ? {} : { automationId: query.automationId }),
    ...(query?.mode === undefined ? {} : { mode: query.mode }),
    ...(query?.limit === undefined ? {} : { limit: query.limit }),
    ...(query?.offset === undefined ? {} : { offset: query.offset }),
  })
  const list = Array.isArray(data) ? data : []
  state.automationHistoryByClient.set(clientId, list)
  return list
}

/**
 * 自动化某次运行的对话回放（docs/13 §10）：按 run 里的 `auto-` sessionId 走 `session.history`
 * 拉正文，落进一个**只读**的 SessionState（不进 `activeSessionKey`、不收实时事件），
 * 交给 `MessageStream` 与远程会话同款渲染。已拉过的会话直接复用缓存。
 */
export async function loadRunTranscript(
  clientId: string,
  sessionId: string,
): Promise<SessionState> {
  const session = ensureSessionState(clientId, sessionId)
  if (session.historyLoaded === true) return session
  session.historyLoaded = true
  try {
    const history = await fetchSessionHistory(clientId, sessionId)
    mergeHistory(session, history)
  } catch (error) {
    // 失败要回退标记：否则重开同一条记录永远显示空回放
    session.historyLoaded = false
    throw error
  }
  return session
}

// ───────────────────────── 语音中转（docs/12 §6.4） ─────────────────────────

/**
 * 语音命令的回执等待放宽到 60s（docs/12 §6.4）：STT 转写 / TTS 合成在客户端本机可能比
 * 普通命令慢得多，30s 的默认超时会误报「未在时限内回执」。
 */
const VOICE_COMMAND_TIMEOUT_MS = 60_000

/** 语音识别中转：录音 base64 送客户端本机 STT，回转写文本 */
export async function transcribeAudio(
  clientId: string,
  audioBase64: string,
  mime: string,
): Promise<string> {
  const data = await command<{ text?: string }>(
    { type: 'stt.transcribe', requestId: nextRequestId(), clientId, audioBase64, mime },
    VOICE_COMMAND_TIMEOUT_MS,
  )
  return typeof data?.text === 'string' ? data.text : ''
}

/** 朗读合成中转：文本送客户端本机 TTS，回音频 base64 + 容器类型 */
export async function synthesizeSpeech(
  clientId: string,
  text: string,
): Promise<{ audioBase64: string; mimeType: string }> {
  const data = await command<{ audioBase64?: string; mimeType?: string }>(
    { type: 'tts.synthesize', requestId: nextRequestId(), clientId, text },
    VOICE_COMMAND_TIMEOUT_MS,
  )
  return {
    audioBase64: typeof data?.audioBase64 === 'string' ? data.audioBase64 : '',
    mimeType: typeof data?.mimeType === 'string' ? data.mimeType : 'audio/mpeg',
  }
}

// ───────────────────────── 会话输入 ─────────────────────────

/**
 * 把服务器上的一份暂存文件推给客户端落盘（docs/12 §5，本轮）。
 *
 * 两条入口共用：控制台「发送文件」（先 `api.uploadFile` 拿到 fileId 再调它）与
 * 文件页「发送到客户端」（已有 fileId 直接调）。回执 `data.path` 是客户端侧的
 * 落盘绝对路径，提示里带上它用户才知道去哪儿找 —— 只回一句"成功"等于没说。
 *
 * 大文件下载较慢（服务器侧待回执超时给到 10 分钟），这里用同一量级的等待。
 */
export async function sendFile(clientId: string, fileId: string): Promise<string> {
  const data = await command<{ path?: string }>(
    { type: 'file.send', requestId: nextRequestId(), clientId, fileId },
    FILE_COMMAND_TIMEOUT_MS,
  )
  const path = typeof data?.path === 'string' ? data.path : ''
  const text = path === '' ? '已发送到客户端' : `已保存到客户端：${path}`
  showNotice(text)
  return text
}

/** 文件下发的等待窗口（毫秒）：与服务器侧 `FILE_KINDS` 的超时同量级（10 分钟略短一点） */
const FILE_COMMAND_TIMEOUT_MS = 9 * 60_000

/** 发送输入：乐观插入用户气泡（后续 user-message 事件按「内容 + 出现次数」逐条配对） */
export async function sendInput(session: SessionState, text: string): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed || session.pending) return
  session.items.push({
    id: `local-${Date.now()}-${session.items.length}`,
    kind: 'user',
    content: trimmed,
    tools: [],
    createdAt: Date.now(),
  })
  session.pending = true
  try {
    const data = await command<{ agentRequestId?: string }>({
      type: 'session.input',
      requestId: nextRequestId(),
      clientId: session.clientId,
      sessionId: session.sessionId,
      text: trimmed,
    })
    if (typeof data?.agentRequestId === 'string') session.agentRequestId = data.agentRequestId
  } catch (error) {
    session.pending = false
    session.items.push({
      id: `error-${Date.now()}`,
      kind: 'error',
      content: error instanceof Error ? error.message : String(error),
      tools: [],
    })
  }
}

/** 中止本轮：需要 session.input 回执带出的 agentRequestId */
export async function abortSession(session: SessionState): Promise<void> {
  if (!session.agentRequestId) {
    throw new Error('尚未取得可中止的请求（客户端还没受理本轮输入）')
  }
  await command({
    type: 'session.abort',
    requestId: nextRequestId(),
    clientId: session.clientId,
    sessionId: session.sessionId,
    agentRequestId: session.agentRequestId,
  })
}

// ───────────────────────── 待办栏：确认卡与提问卡 ─────────────────────────

let noticeTimer: number | undefined

/** 非阻断提示（待办栏批复 / 过期共用；6s 自动消隐） */
export function showNotice(text: string): void {
  actionNotice.value = text
  if (noticeTimer !== undefined) window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    actionNotice.value = ''
    noticeTimer = undefined
  }, 6000)
}

function removeConfirm(confirmId: string): void {
  const index = state.confirms.findIndex((c) => c.request.confirmId === confirmId)
  if (index >= 0) state.confirms.splice(index, 1)
}

/** 批复一张确认卡；result 回执成功才静默移除，失败按拒绝处理并提示（docs/12 §5.1） */
export async function resolveConfirm(entry: ConfirmEntry, approved: boolean): Promise<void> {
  try {
    await command({
      type: 'confirm.resolve',
      requestId: nextRequestId(),
      clientId: entry.clientId,
      confirmId: entry.request.confirmId,
      approved,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    showNotice(approved ? `确认批复未生效，已按拒绝处理：${reason}` : `拒绝批复未送达：${reason}`)
  } finally {
    removeConfirm(entry.request.confirmId)
  }
}

/** 倒计时归零：客户端侧超时同样按拒绝收尾，这里把卡摘掉并提示 */
export function expireConfirm(entry: ConfirmEntry): void {
  removeConfirm(entry.request.confirmId)
  showNotice('确认请求已过期，客户端会按拒绝处理')
}

/**
 * 作答一张提问卡（v0.3.3，docs/12 §5）。
 *
 * `requestId` 就是**提问卡 id**（客户端分配）——服务器原样转发给客户端并作为回执关联键，
 * 两条页签答同一张卡时各记一条 pending，按命令顺序 FIFO 配对（hub 的既有语义）。
 * `settled: false` = 本地卡已作答 / 已超时 / id 未知：也算成功回执，网页端如实提示「已失效」
 * 并收起卡片，不当错误（先到先得的另一侧）。
 */
export async function resolveAsk(
  target: { clientId: string; sessionId: string; requestId: string },
  answers: string[],
  skipped = false,
  answersByQuestion?: string[][],
): Promise<boolean> {
  let settled = false
  try {
    const data = await command<{ settled?: boolean }>({
      type: 'ask.resolve',
      requestId: target.requestId,
      clientId: target.clientId,
      sessionId: target.sessionId,
      answers,
      // 多问的分组作答（本轮）：只在给定时带上，单问保持旧形状
      ...(answersByQuestion === undefined ? {} : { answersByQuestion }),
      ...(skipped ? { skipped: true } : {}),
    })
    settled = data?.settled !== false
    if (!settled) showNotice('这张提问已在客户端被作答或已超时，网页端的作答未生效')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    showNotice(`作答未送达：${reason}`)
  } finally {
    // 收卡片：`settled` 命中时流内那张同步切成只读（显示答了什么）；未命中（先到先得输了）
    // 就按已结算记一条，同样不要再让人对着倒计时等
    settleAsk(target.clientId, target.requestId, {
      outcome: settled ? (skipped || answers.length === 0 ? 'skipped' : 'answered') : 'timedOut',
      answers: settled ? answers : [],
      ...(settled && answersByQuestion !== undefined ? { answersByQuestion } : {}),
    })
  }
  return settled
}

/** 倒计时归零：客户端侧 180s 超时按「用户未回答」收尾（模型说明假设后继续），摘掉卡片并提示 */
export function expireAsk(entry: AskEntry): void {
  settleAsk(entry.clientId, entry.request.requestId, { outcome: 'timedOut', answers: [] })
  showNotice('提问已过期，Agent 会按「用户未回答」继续')
}

// ───────────────────────── 模式 / 配置 ─────────────────────────

/** 远程切换客户端模式（docs/12 §6.2：客户端侧白名单最终裁决） */
export async function switchMode(clientId: string, mode: ClientStatus['mode']): Promise<void> {
  await command<void>({
    type: 'mode.switch',
    requestId: nextRequestId(),
    clientId,
    mode,
  })
  // 成功后客户端会回推新的 client.status；这里不重复改本地状态
}

/** 远程更新客户端配置（仅白名单路径：agent.tools.* 开关等） */
export async function updateConfig(
  clientId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await command<void>({
    type: 'config.update',
    requestId: nextRequestId(),
    clientId,
    patch,
  })
}

// ───────────────────────── 登录 / 启动 ─────────────────────────

/** 页面加载时调用：恢复本地登录态（过期则清除），并尝试水合客户端列表 */
export async function boot(): Promise<void> {
  const stored = loadStoredAuth()
  if (stored) {
    try {
      state.user = await api.me()
      // WS 快照到达前先用 REST 水合一次（离线也能立刻看到设备）；失败不阻塞启动
      try {
        const data = await api.clients()
        replaceClients(data.clients)
      } catch {
        // 等 WS 快照兜底
      }
      connectSocket()
    } catch {
      clearAuth() // 令牌无效 / 已过期
    }
  }
  state.booted = true
}

export async function login(username: string, password: string): Promise<void> {
  const result = await api.login(username, password)
  saveAuth(result.token, result.user)
  state.user = result.user
  connectSocket()
}

/** 自助注册：成功即登录（响应与 login 同形状），调用方进入控制台 */
export async function register(username: string, password: string): Promise<void> {
  const result = await api.register(username, password)
  saveAuth(result.token, result.user)
  state.user = result.user
  connectSocket()
}

export function logout(): void {
  socket.close()
  rejectAllCommands(new Error('已退出登录'))
  showNotice('')
  clearAuth()
  state.user = null
  state.clients.clear()
  state.sessions.clear()
  state.confirms.splice(0)
  state.asks.splice(0)
  state.automationsByClient.clear()
  state.automationCatalogByClient.clear()
  state.automationHistoryByClient.clear()
  statusBuffer.clear()
  state.selectedClientId = ''
  state.activeSessionKey = ''
  window.location.hash = '#/'
}

function connectSocket(): void {
  const token = getToken()
  if (token) socket.connect(token)
}

/** 供 `state/index.ts` 的分发层用的类型放宽（`CenterWebMessage` 的构造分散在各动作里） */
export type { CenterWebMessage }
