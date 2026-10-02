/* global Buffer */
/**
 * Aurora Center Web 验收的**桩客户端**（`verify/run.mjs` 专用）。
 *
 * 为什么需要它：Center Web 的几乎每个界面元素都由**客户端上报的数据**驱动 ——
 * 麦克风 / 朗读按钮看 `status.voice`、模型下拉看 `config.get` 回执、自动化页看
 * `automation.list` / `automation.catalog` 回执、历史回放看 `session.history` 回执。
 * 没有一台"会答话的客户端"，这些界面根本渲染不出来，断言就无从谈起。
 * 本文件用**真实协议**（`packages/shared/src/center/protocol.ts`）模拟一台已登录的
 * Aurora 客户端：`hello` → 立刻 `status` 快照 → 对每条 `cmd` 回 `result`。
 *
 * 三条硬性约定（漏掉任何一条都会以"界面不渲染"的形式失败）：
 * 1. **必须回 `pong`**：服务器心跳 15s × 2 拍判死（server.ts 的 heartbeat），不回就当掉线；
 * 2. **未知命令也要回 `ok: true` + `{}`**：网页端的待回执表按 requestId 配对
 *    （`lib/socket.ts` 的 30s 超时），漏答会让「点了没反应」的假象混进验收结果；
 * 3. **status 是整体覆盖**：`client.status` 到达时网页端 `entry.status = message.status`
 *    （不做字段合并），所以每次上报都要给全量快照（`pushStatus` 的浅合并只是桩机自己方便）。
 */
import { WebSocket } from 'ws'

/** 桩机客户端 id（登录时绑定；hello 必须报同一个，否则服务器 4001 拒连） */
export const STUB_CLIENT_ID = 'cweb-stub-1'
export const STUB_CLIENT_NAME = '验收桩机'

/** 默认状态快照：全部能力位为真，语音位在（场景 5 会临时摘掉它验证门控） */
export function defaultStatus() {
  return {
    mode: 'classroom',
    version: '0.0.0-verify',
    platform: 'win32',
    agent: {
      permissionMode: 'auto',
      tools: { enabled: true, files: true, search: true, open: true, terminal: true },
    },
    center: { allowRemoteSession: true, allowRemoteConfig: true, allowFileTransfer: true },
    llm: { activeProviderId: 'p1', model: 'aurora-test-1', reasoningEffort: 'medium' },
    voice: { stt: true, tts: true },
  }
}

/** hello 上报的能力位（与 status.center 一致） */
const CAPABILITIES = { session: true, remoteConfig: true, fileTransfer: true }

/**
 * `config.get` 的脱敏回执（网页端只读 `llm` 这一段，见 `web/src/lib/remote-llm.ts`）：
 * - `active` 决定模型段默认选中的 provider；
 * - `providers.<id>.modelList` 决定「对话模型」下拉的候选；
 * - `contextWindow` / `reasoningEffort` 在 **modelParams[该 provider 的 model]** 之下
 *   （v23 起是模型级口径，键必须命中，否则回落 0 / 'auto'）。
 */
export const FIXTURE_LLM_CONFIG = {
  llm: {
    active: 'p1',
    providers: {
      p1: {
        model: 'aurora-test-1',
        modelList: ['aurora-test-1', 'aurora-test-2'],
        modelParams: {
          'aurora-test-1': { contextWindow: 128000, vision: true, reasoningEffort: 'medium' },
          'aurora-test-2': { contextWindow: 64000, vision: false, reasoningEffort: 'high' },
        },
      },
      p2: {
        model: 'aurora-alt-1',
        modelList: ['aurora-alt-1'],
        modelParams: { 'aurora-alt-1': { contextWindow: 32000, reasoningEffort: 'low' } },
      },
    },
  },
}

/** 会话列表夹具：`[空会话（流式场景用）, 历史会话（回放场景用）]` */
export const FIXTURE_OPEN_SESSION_ID = 'center-aaaaaaaaaa'
export const FIXTURE_HISTORY_SESSION_ID = 'center-bbbbbbbbbb'
export const FIXTURE_HISTORY_TITLE = '历史会话（回放）'

export function fixtureSessionList() {
  const now = new Date()
  return [
    {
      sessionId: FIXTURE_OPEN_SESSION_ID,
      title: '远程会话',
      updatedAt: new Date(now.getTime() - 60_000).toISOString(),
      permissionMode: 'confirm',
      projectId: 'proj-1',
      centerVisible: true,
    },
    {
      sessionId: FIXTURE_HISTORY_SESSION_ID,
      title: FIXTURE_HISTORY_TITLE,
      updatedAt: new Date(now.getTime() - 3_600_000).toISOString(),
      centerVisible: true,
    },
  ]
}

/** `project.list` 回执：两条选项（会话面板的「绑定项目」下拉） */
export const FIXTURE_PROJECTS = [
  { id: 'proj-1', name: '课堂资料' },
  { id: 'proj-2', name: '个人项目' },
]

/**
 * 历史回放夹具：1 条用户消息 + 1 条带工具调用的助手消息。
 *
 * 助手消息**故意只带工具、不带正文**：这样轨迹容器必然渲染（`hasTrace` = tools 非空），
 * 而"历史条目默认折叠"这条状态机语义才是被真正验证的那条（探针读 aria-expanded）。
 */
export function fixtureHistoryMessages() {
  return [
    {
      id: 'hist-u-1',
      role: 'user',
      content: '把课件按科目归类到对应的文件夹里',
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    },
    {
      id: 'hist-a-1',
      role: 'assistant',
      content: '已按课程表把 12 份课件归入对应科目文件夹。',
      createdAt: new Date(Date.now() - 3_590_000).toISOString(),
      reasoning: '先读取课程表，再按文件名里的科目关键字分组。',
      toolCalls: [
        {
          id: 'hist-t-1',
          name: 'read_file',
          state: 'success',
          input: { path: 'D:/课件/高等数学-第3讲.pdf' },
          outputSummary: '已读取文件（2.1 MB）',
        },
      ],
    },
  ]
}

/** `automation.list` 回执：1 条用户定义（Agent Mode）+ 1 条内置 */
export const FIXTURE_AUTOMATION_ID = 'auto-user-1'
export function fixtureAutomationList() {
  const at = new Date(Date.now() - 86_400_000).toISOString()
  return {
    user: [
      {
        id: FIXTURE_AUTOMATION_ID,
        name: '每天整理课件',
        enabled: true,
        mode: 'agent',
        trigger: { kind: 'daily', params: { at: '20:30', weekdays: [1, 2, 3, 4, 5] } },
        prompt: '把今天的课件按科目归档',
        maxRuns: 0,
        runCount: 0,
        createdAt: at,
        updatedAt: at,
      },
    ],
    builtin: [
      {
        id: 'builtin.pre-class-notify',
        name: '课前提醒',
        enabled: true,
        mode: 'normal',
        trigger: { kind: 'pre-class', params: { leadMinutes: 5 } },
        actions: [{ kind: 'system-notify', params: { text: '快上课了' } }],
        createdAt: at,
        updatedAt: at,
      },
    ],
  }
}

/**
 * `automation.catalog` 回执：编辑器按它渲染动态表单。
 *
 * 第一条条件**必须有 ≥ 2 个字段** —— 编辑器默认选中 `conditions[0]`，
 * 场景 25 的 `[data-field^="automation."] ≥ 2` 直接由它决定。
 */
export function fixtureAutomationCatalog() {
  return {
    conditions: [
      {
        kind: 'daily',
        label: '每天定时',
        description: '按星期与时间点触发',
        requiresSchedule: false,
        fields: [
          { key: 'at', label: '触发时间', type: 'time', placeholder: '08:00' },
          { key: 'weekdays', label: '星期', type: 'weekdays' },
        ],
      },
      {
        kind: 'pre-class',
        label: '课前',
        description: '距上课若干分钟时触发',
        requiresSchedule: true,
        fields: [{ key: 'leadMinutes', label: '提前分钟', type: 'number', min: 1, max: 60 }],
      },
    ],
    actions: [
      {
        kind: 'system-notify',
        label: '系统通知',
        description: '弹一条系统通知',
        requiresClassIsland: false,
        available: true,
        fields: [{ key: 'text', label: '通知内容', type: 'text' }],
      },
      {
        kind: 'open-folder',
        label: '打开文件夹',
        description: '用资源管理器打开一个目录',
        requiresClassIsland: false,
        available: true,
        fields: [{ key: 'path', label: '目录', type: 'text' }],
      },
    ],
  }
}

/** `automation.history` 回执：2 次运行（一次成功、一次失败） */
export function fixtureAutomationHistory() {
  const base = Date.now() - 7_200_000
  return [
    {
      id: 'run-2',
      automationId: FIXTURE_AUTOMATION_ID,
      automationName: '每天整理课件',
      mode: 'agent',
      status: 'success',
      triggeredAt: new Date(base + 3_600_000).toISOString(),
      finishedAt: new Date(base + 3_660_000).toISOString(),
      durationMs: 60_000,
      sessionId: 'auto-verify-1',
    },
    {
      id: 'run-1',
      automationId: 'builtin.pre-class-notify',
      automationName: '课前提醒',
      mode: 'normal',
      status: 'failed',
      triggeredAt: new Date(base).toISOString(),
      finishedAt: new Date(base + 1_000).toISOString(),
      durationMs: 1_000,
      error: '通知被系统拦截（夹具）',
    },
  ]
}

/**
 * 1KB 静音的 WAV（base64）：`tts.synthesize` 的回执要真的能解码播放
 * （`MessageStream.speak` 会 `atob` + `new Blob` + `audio.play()`），
 * 空数据会在断言之前就被 SPA 拒绝。
 */
export function silenceWavBase64(bytes = 1024) {
  const buffer = Buffer.alloc(bytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(bytes - 8, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // 单声道
  buffer.writeUInt32LE(8000, 24)
  buffer.writeUInt32LE(8000, 28)
  buffer.writeUInt16LE(1, 32)
  buffer.writeUInt16LE(8, 34) // 8bit
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(bytes - 44, 40)
  return buffer.toString('base64')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 桩客户端。
 *
 * 生命周期：`start()` → 登录（REST）→ 连 WS → hello + status → 应答一切命令。
 * 场景侧只碰三类方法：`pushStatus`（改上报的快照）、`sendEvent` / `sendConfirm` /
 * `sendAsk`（造界面状态）、`waitForCommand`（读"网页真的发了什么"）。
 */
export class StubClient {
  constructor(options) {
    this.baseUrl = options.baseUrl
    this.username = options.username
    this.password = options.password
    this.clientId = options.clientId ?? STUB_CLIENT_ID
    this.token = ''
    this.ws = null
    this.commands = []
    this.status = defaultStatus()
    this.seq = 0
    /** sessionId → CenterSessionHistoryMessage[]（缺省 = 空历史） */
    this.history = new Map()
    this.welcome = null
    this.welcomeWaiters = []
  }

  // ───────────────── 连接 ─────────────────

  async start() {
    await this.login()
    await this.connect()
  }

  async login() {
    const response = await fetch(`${this.baseUrl}/api/client/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: this.username,
        password: this.password,
        clientId: this.clientId,
      }),
    })
    if (!response.ok) {
      throw new Error(`客户端登录失败：HTTP ${response.status} ${await response.text()}`)
    }
    const data = await response.json()
    this.token = data.token
  }

  connect() {
    return new Promise((resolve, reject) => {
      const url = `${this.baseUrl.replace(/^http/, 'ws')}/api/client`
      const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${this.token}` } })
      this.ws = socket
      socket.on('open', () => {
        this.sendRaw({
          type: 'hello',
          hello: {
            clientId: this.clientId,
            name: STUB_CLIENT_NAME,
            version: '0.0.0-verify',
            platform: 'win32',
            mode: this.status.mode,
            capabilities: CAPABILITIES,
          },
        })
        this.sendRaw({ type: 'status', status: this.status })
        resolve()
      })
      socket.on('message', (data) => this.handleMessage(data))
      socket.on('error', (error) => reject(error))
      socket.on('close', (code, reason) => {
        this.closed = { code, reason: String(reason) }
      })
    })
  }

  /** 等 `welcome`（服务器确认 hello 通过）—— 断线场景可用来确认桩机还活着 */
  async waitWelcome(timeout = 5000) {
    if (this.welcome !== null) return this.welcome
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeout)
      this.welcomeWaiters.push((value) => {
        clearTimeout(timer)
        resolve(value)
      })
    })
  }

  handleMessage(data) {
    let message
    try {
      message = JSON.parse(String(data))
    } catch {
      return
    }
    if (message.type === 'ping') {
      this.sendRaw({ type: 'pong' })
      return
    }
    if (message.type === 'welcome') {
      this.welcome = message
      for (const resolve of this.welcomeWaiters.splice(0)) resolve(message)
      return
    }
    if (message.type !== 'cmd') return
    const cmd = message.cmd
    this.commands.push({ kind: cmd.kind, cmd, at: Date.now() })
    this.respond(cmd)
  }

  sendRaw(payload) {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload))
    }
  }

  /** 每类命令的回执数据（形状取自 protocol.ts 的注释与 docs/12；未知一律 `{}`） */
  respond(cmd) {
    const data = this.dataFor(cmd)
    this.sendRaw({ type: 'result', requestId: cmd.requestId, ok: true, data })
  }

  dataFor(cmd) {
    switch (cmd.kind) {
      case 'session.input':
        return { agentRequestId: 'req-1' }
      case 'session.list':
        return fixtureSessionList()
      case 'session.history':
        return this.history.get(cmd.sessionId) ?? []
      case 'project.list':
        return FIXTURE_PROJECTS
      case 'config.get':
        return FIXTURE_LLM_CONFIG
      case 'automation.list':
        return fixtureAutomationList()
      case 'automation.catalog':
        return fixtureAutomationCatalog()
      case 'automation.history':
        return fixtureAutomationHistory()
      case 'automation.save':
        return cmd.definition
      case 'automation.run':
        return { runId: 'auto-verify-1' }
      case 'stt.transcribe':
        return { text: '识别出的文本' }
      case 'tts.synthesize':
        return { audioBase64: silenceWavBase64(), mimeType: 'audio/wav' }
      default:
        return {}
    }
  }

  close() {
    this.ws?.close()
  }

  // ───────────────── 上报与造帧 ─────────────────

  /** 深合并一层状态并整体重发（`client.status` 在网页端是整体覆盖） */
  pushStatus(patch) {
    this.status = {
      ...this.status,
      ...patch,
      agent: { ...this.status.agent, ...(patch.agent ?? {}) },
      center: { ...this.status.center, ...(patch.center ?? {}) },
      ...(patch.llm === undefined ? {} : { llm: { ...this.status.llm, ...patch.llm } }),
    }
    this.sendRaw({ type: 'status', status: this.status })
  }

  /** 恢复默认快照（每个场景开头调用：上一个场景的"摘掉语音位"不许渗到下一个） */
  resetStatus() {
    this.status = defaultStatus()
    this.sendRaw({ type: 'status', status: this.status })
  }

  nextSeq() {
    this.seq += 1
    return this.seq
  }

  sendEvent(sessionId, event) {
    this.sendRaw({
      type: 'session.event',
      sessionId,
      event: { sessionId, seq: this.nextSeq(), ...event },
    })
  }

  sendConfirm(request) {
    this.sendRaw({ type: 'confirm.request', request })
  }

  sendAsk(request) {
    this.sendRaw({ type: 'ask.request', request })
  }

  setHistory(sessionId, messages) {
    this.history.set(sessionId, messages)
  }

  // ───────────────── 读取网页发了什么 ─────────────────

  mark() {
    return Date.now()
  }

  commandsSince(since, kind) {
    return this.commands.filter(
      (entry) => entry.at >= since && (kind === undefined || entry.kind === kind),
    )
  }

  /**
   * 等一条网页端命令到达（默认 4s）。
   *
   * 用轮询而不是事件回调：命令是"网页真的发了什么"的事实来源，探针要能在任意时刻
   * 回头看（`since` 让同一场景里的两次断言互不串台）。超时返回 `null`，**不抛错** ——
   * 让场景把"没收到"写进 readings 而不是变成一句没有上下文的异常。
   */
  async waitForCommand(kind, options = {}) {
    const { since = 0, timeout = 4000, where } = options
    const deadline = Date.now() + timeout
    for (;;) {
      const hit = this.commands.find(
        (entry) =>
          entry.kind === kind && entry.at >= since && (where === undefined || where(entry.cmd)),
      )
      if (hit !== undefined) return hit.cmd
      if (Date.now() > deadline) return null
      await sleep(50)
    }
  }

  // ───────────────── 上传（file.received 的来源） ─────────────────

  /**
   * 走真实的 `/api/ingest/files`：客户端令牌 + `X-Client-Id` 双因子，**原始 body 就是文件内容**
   * （不是 multipart，见 server.ts 的 handleIngest）。文件名走 `X-File-Name`（URI 编码）。
   */
  async uploadFile({ name, content = 'verify fixture', note }) {
    const query = note === undefined ? '' : `?note=${encodeURIComponent(note)}`
    const response = await fetch(`${this.baseUrl}/api/ingest/files${query}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'X-Client-Id': this.clientId,
        'X-File-Name': encodeURIComponent(name),
        'Content-Type': 'application/octet-stream',
      },
      body: content,
    })
    if (!response.ok) {
      throw new Error(`上传夹具文件失败：HTTP ${response.status} ${await response.text()}`)
    }
    return response.json()
  }
}
