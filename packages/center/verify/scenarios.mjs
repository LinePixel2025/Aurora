/**
 * 场景定义（harness 的探针层）—— 每条场景 = 「用桩机把界面推到某个状态」+「从 DOM 读数判定」。
 *
 * 设计口径（与桌面端 `apps/desktop/src/main/capture.ts` 同一套）：
 * - **每条场景自带前置与收尾**：开头一律 `fresh()`（清空桩机命令记录、恢复默认 status、
 *   reload 页面把上一场景的界面状态清干净）。绝不依赖"上一条场景留下的状态"——
 *   桌面端踩过「前一条探针把跟随关掉后没恢复」的坑，这里从结构上避免。
 * - **只断言真的读到的读数**：`verdict()` 的 pass 是 conditions 表的乘积，readings 里带原始值
 *   （计数、几何、文案），失败时报告里就能复盘；计数类失败还带前几个元素的 outerHTML 摘要。
 * - **等待一律用 waitForSelector / waitForFunction**，不用固定 sleep 硬等（只有"倒计时读数
 *   采样"这类必须观察时间过程的场合才轮询）。
 * - 会话一律用**桩机已知的夹具会话**（面板行点开），而不是点「新建远程会话」——
 *   新建的 sessionId 由服务器生成，桩机不知道它，就没法给那个会话发事件。
 *   只有 `session-create` 场景反过来验证「点了新建真的能进入会话视图」，并顺手把
 *   服务器生成的 sessionId 从面板行里读出来记录进报告。
 */
import { join } from 'node:path'
import {
  FIXTURE_HISTORY_SESSION_ID,
  FIXTURE_HISTORY_TITLE,
  FIXTURE_OPEN_SESSION_ID,
  fixtureHistoryMessages,
} from './stub-client.mjs'

const TIMEOUT = 10_000

/** 桌面 / 移动两套视口（移动场景的判据依赖 390×844） */
export const DESKTOP_VIEWPORT = { width: 1440, height: 900 }
export const MOBILE_VIEWPORT = { width: 390, height: 844 }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** pass = conditions 的乘积；readings 原样带进报告（口径见文件头） */
function verdict(conditions, readings = {}, notes = []) {
  return {
    pass: Object.values(conditions).every(Boolean),
    conditions,
    ...readings,
    ...(notes.length === 0 ? {} : { notes }),
  }
}

/** 页面侧统一的「可见性」读数：有尺寸才算真的渲染出来（v-if 命中但被裁掉不算） */
const boxReadable = (box) => box !== null && box.h > 0 && box.w > 0

/**
 * 轮询到期望状态，**超时返回最后一次读数**（而不是抛 TimeoutError）。
 *
 * 失败时报告里最需要的是"当时到底读到了什么"：`aria-expanded` 还是 false =
 * 点击没生效，这本身就是判据。用 `waitForFunction` 只会留一句 "Waiting failed"，
 * 复盘时没有信息量（AGENTS 里记着这条教训）。
 */
async function waitForTraceState(read, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  let last = await read()
  while (!predicate(last) && Date.now() < deadline) {
    await sleep(120)
    last = await read()
  }
  return last
}

// ───────────────────────── 页面侧小工具（Node 侧） ─────────────────────────

/** 清空桩机行为 → 恢复默认 status → reload 到指定 hash（每条场景的前置） */
async function fresh(ctx, options = {}) {
  const { hash = '#/console', expect = '[data-panel="console"]' } = options
  ctx.stub.commands.length = 0
  ctx.stub.resetStatus()
  await ctx.page.evaluate((target) => {
    window.location.hash = target
  }, hash)
  await ctx.page.reload({ waitUntil: 'domcontentloaded' })
  await ctx.page.waitForSelector(expect, { timeout: TIMEOUT })
  if (hash.startsWith('#/console')) await waitClientStatus(ctx.page)
}

/**
 * 等选中设备的状态快照到达。
 *
 * `rail.no-status`（「等待状态…」）只在 `entry.status === null` 时渲染 —— 它的消失就是
 * "status 快照已到"的**界面事实**，比 sleep 稳。语音按钮 / 模型下拉 / 权限芯片全都靠它。
 */
async function waitClientStatus(page) {
  await page.waitForFunction(
    () => document.querySelector('[data-field="rail.no-status"]') === null,
    {
      timeout: TIMEOUT,
    },
  )
}

/** 清登录态（`login-page` 场景用：它是唯一必须处于未登录状态的场景） */
async function freshLoggedOut(ctx) {
  ctx.stub.commands.length = 0
  await ctx.page.evaluate(() => window.localStorage.clear())
  await ctx.page.evaluate(() => {
    window.location.hash = '#/login'
  })
  await ctx.page.reload({ waitUntil: 'domcontentloaded' })
  await ctx.page.waitForSelector('[data-panel="login"]', { timeout: TIMEOUT })
}

/**
 * 等右栏会话面板真的拿到了会话行。
 *
 * 保留一条**恢复动作**（点面板自己的「刷新」）：这是用户遇到首拉失败时会走的真实路径。
 * 说明：那个「面板挂载时的首拉落在 WS 握手期、命令当场失败」的竞态**已修**
 * （`lib/socket.ts` 的 `command()` 现在会有界等待连接就绪再发），`panel-sessions` /
 * `panel-model` 两个场景断言首拉成功、不再需要这里兜底。留着它是因为面板本身还有
 * 「刷新」按钮，顺手当清场用，且能顺带覆盖那条按钮。
 */
async function ensurePanelSessions(page) {
  await page.waitForFunction(
    () => (document.querySelector('[data-field="shell.ws"]')?.textContent ?? '').includes('已连接'),
    { timeout: TIMEOUT },
  )
  const hadError = await page.evaluate(
    () => document.querySelector('[data-field="panel.error"]') !== null,
  )
  if (hadError) await page.click('[data-action="panel.refresh"]')
  await page.waitForSelector('[data-field="panel.session-row"]', { timeout: TIMEOUT })
  return { hadError }
}

/**
 * 清掉服务器**回放**进来的旧提问卡。
 *
 * 服务器把未过期的提问存在 `pendingAsks` 里，新网页连接一建立就回放（hub.sendPendingAsksTo）——
 * 于是"上一条 ask 场景留下的卡"会出现在下一条场景里，而卡上没有任何 requestId 锚点，
 * 探针只能靠"点第一张卡的按钮"猜是哪一张（踩过：`ask-submit` 提交成了上一条的卡）。
 * 这里点卡片自己的「跳过」（真实用户路径），顺带把服务器侧待答表也摘干净。
 */
async function dismissPendingAsks(page) {
  // 回放跟着 WS 连接一起来：先等链路就绪再清，否则清完又被回放一张
  await page.waitForFunction(
    () => (document.querySelector('[data-field="shell.ws"]')?.textContent ?? '').includes('已连接'),
    { timeout: TIMEOUT },
  )
  await sleep(300)
  for (let round = 0; round < 5; round += 1) {
    const remaining = await page.evaluate(() => {
      const button = document.querySelector('[data-action="chat.ask-skip"]')
      if (button === null) return 0
      button.click()
      return document.querySelectorAll('[data-field="chat.ask-user-card"]').length
    })
    if (remaining === 0) return
    await sleep(250)
  }
}

/**
 * 点开一台**桩机已知**的夹具会话（走会话面板的行点击 = 真实用户路径，顺带触发历史回放）。
 * 面板在 390px 视口下是离屏抽屉，因此移动场景不走这里。
 */
async function openFixtureSession(ctx, sessionId = FIXTURE_OPEN_SESSION_ID) {
  const panel = await ensurePanelSessions(ctx.page)
  const clicked = await ctx.page.evaluate((id) => {
    const rows = [...document.querySelectorAll('[data-field="panel.session-row"]')]
    const row = rows.find((item) => item.textContent.includes(id))
    if (row === undefined) return false
    row.querySelector('[data-action="panel.view"]').click()
    return true
  }, sessionId)
  if (!clicked) throw new Error(`会话面板里找不到夹具会话：${sessionId}`)
  await ctx.page.waitForSelector('[data-field="chat.composer-input"]', { timeout: TIMEOUT })
  return panel
}

/** 从面板行里解析服务器刚生成的 sessionId（`session-create` 场景用） */
async function panelSessionIds(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-field="panel.session-row"]')].map((row) => {
      const match = /center-[0-9a-zA-Z]+/.exec(row.textContent)
      return match === null ? '' : match[0]
    }),
  )
}

/** 轨迹容器在流式期间是 `chat.trace-live`，收尾后才是 `chat.trace` —— 两种都算"轨迹在" */
async function ensureTraceOpen(page) {
  return page.evaluate(() => {
    const toggle = document.querySelector('[data-action="chat.trace-toggle"]')
    if (toggle === null) return { found: false, wasExpanded: null, clicked: false }
    const wasExpanded = toggle.getAttribute('aria-expanded') === 'true'
    if (!wasExpanded) toggle.click()
    return { found: true, wasExpanded, clicked: !wasExpanded }
  })
}

/**
 * 失败时的 DOM 摘要（由 run.mjs 在 `pass === false` 时调用）：把所有 `data-*` 锚点的命中数
 * 与头几个元素的 outerHTML 摘录进报告 —— 没有它，一条计数断言失败时只能看到"期望 1 得到 0"。
 */
export async function domDigest(page) {
  return page
    .evaluate(() => {
      const attrs = ['data-panel', 'data-field', 'data-action', 'data-switch']
      const digest = {}
      for (const attr of attrs) {
        for (const node of document.querySelectorAll(`[${attr}]`)) {
          const value = node.getAttribute(attr)
          const key = `${attr}=${value}`
          const entry = digest[key] ?? { count: 0, samples: [] }
          entry.count += 1
          if (entry.samples.length < 2) entry.samples.push(node.outerHTML.slice(0, 200))
          digest[key] = entry
        }
      }
      return digest
    })
    .catch(() => ({}))
}

// ───────────────────────── 事件夹具（AgentEvent 形状取自 shared/ipc/types.ts） ─────────────────────────

const REQUEST_ID = 'req-verify-1'
const MESSAGE_ID = 'msg-verify-1'

const textEvent = (delta) => ({
  type: 'text',
  requestId: REQUEST_ID,
  round: 0,
  messageId: MESSAGE_ID,
  delta,
})

const reasoningEvent = (delta) => ({
  type: 'reasoning',
  requestId: REQUEST_ID,
  round: 0,
  messageId: MESSAGE_ID,
  delta,
})

const toolEvent = (call) => ({
  type: 'tool',
  requestId: REQUEST_ID,
  round: 0,
  messageId: MESSAGE_ID,
  call,
})

const doneEvent = () => ({ type: 'done', requestId: REQUEST_ID })

const userMessageEvent = (content) => ({
  type: 'user-message',
  requestId: REQUEST_ID,
  content,
  createdAt: Date.now(),
})

/** `task` 子代理快照夹具：permission=write、2 步、带报告与只读对话（对话里有一次工具调用） */
function subagentSnapshot() {
  const startedAt = Date.now() - 12_000
  return {
    taskId: 'sub-verify-1',
    callId: 'call-task-1',
    description: '整理本周课件',
    prompt: '把本月的课件按科目归类，并报告每科份数',
    status: 'success',
    startedAt,
    endedAt: startedAt + 11_500,
    steps: [
      { id: 'step-1', kind: 'tool', name: 'grep', state: 'success', summary: '扫描 12 个文件' },
      { id: 'step-2', kind: 'text', text: '已按科目分组，准备写回报告。' },
    ],
    toolCalls: 1,
    report: '共 12 份课件：数学 3、语文 2、英语 4、物理 3。',
    permission: 'write',
    tools: ['read_file', 'grep'],
    messages: [
      { id: 'sa-u-1', role: 'user', text: '把本月的课件按科目归类，并报告每科份数' },
      {
        id: 'sa-a-1',
        role: 'assistant',
        text: '先看目录里有哪些文件。',
        toolCalls: [
          {
            id: 'sa-t-1',
            name: 'grep',
            args: '{"pattern":"课件"}',
            state: 'success',
            summary: '命中 12 个文件',
            output: '12 个文件命中',
          },
        ],
      },
      { id: 'sa-a-2', role: 'assistant', text: '共 12 份课件：数学 3、语文 2、英语 4、物理 3。' },
    ],
  }
}

function jobSummary() {
  return {
    id: 'job-verify-1',
    sessionId: FIXTURE_OPEN_SESSION_ID,
    status: 'paused',
    round: 1,
    maxRounds: 3,
    usedTokens: 12_345,
    maxTotalTokens: 100_000,
    autoContinued: 0,
    pendingReason: 'max-rounds',
    stepCount: 4,
    lastStep: '写入归档清单',
    updatedAt: new Date().toISOString(),
  }
}

/** Markdown 夹具：围栏 ts 代码块 + GFM 表格 + 外链（三样都是渲染契约的硬点） */
const MARKDOWN_FIXTURE = [
  '# 渲染夹具',
  '',
  '代码块与表格都要能在远程会话里正确落版：',
  '',
  '```ts',
  'const answer: number = 42',
  'console.log(answer)',
  '```',
  '',
  '| 科目 | 份数 |',
  '| --- | --- |',
  '| 数学 | 3 |',
  '| 语文 | 2 |',
  '',
  '[外部文档](https://example.com/docs)',
].join('\n')

const CONFIRM_REQUEST = (confirmId, ttlMs = 60_000) => ({
  confirmId,
  sessionId: FIXTURE_OPEN_SESSION_ID,
  toolName: 'run_command',
  input: { command: 'Remove-Item -Recurse temp' },
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + ttlMs).toISOString(),
})

const ASK_OPTIONS = [
  { label: '科目资料文件夹', description: '按课程表科目分类存放' },
  { label: '桌面「本周课件」', description: '先堆在桌面，手动再整理' },
  { label: '先别移动文件' },
]

const askRequest = (requestId, ttlMs = 180_000) => ({
  requestId,
  sessionId: FIXTURE_OPEN_SESSION_ID,
  question: '要把归档后的课件放到哪个目录？',
  header: '目标目录',
  options: ASK_OPTIONS,
  multiSelect: false,
  expiresAt: Date.now() + ttlMs,
})

// ───────────────────────── 场景表 ─────────────────────────

export const SCENARIOS = [
  // ── 1. 登录页（必须处于未登录态，先于登录执行） ──
  {
    name: 'login-page',
    loggedOut: true,
    async run(ctx) {
      await freshLoggedOut(ctx)
      const reading = await ctx.page.evaluate(() => ({
        login: document.querySelectorAll('[data-panel="login"]').length,
        username: document.querySelectorAll('[data-field="login.username"]').length,
        password: document.querySelectorAll('[data-field="login.password"]').length,
        submit: document.querySelectorAll('[data-action="login.submit"]').length,
        console: document.querySelectorAll('[data-panel="console"]').length,
      }))
      return verdict(
        {
          loginPanel: reading.login === 1,
          username: reading.username === 1,
          password: reading.password === 1,
          submit: reading.submit === 1,
          noConsole: reading.console === 0,
        },
        { reading },
      )
    },
  },

  // ── 2. 设备授权页（假展示码 → 链接无效） ──
  {
    name: 'device-page',
    async run(ctx) {
      await fresh(ctx)
      await ctx.page.evaluate(() => {
        window.location.hash = '#/device?code=ABCD-1234'
      })
      await ctx.page.waitForFunction(() => document.body.innerText.includes('链接无效'), {
        timeout: TIMEOUT,
      })
      const reading = await ctx.page.evaluate(() => ({
        devicePanel: document.querySelectorAll('[data-panel="device"]').length,
        title: document.querySelector('.device-title')?.textContent?.trim() ?? '',
        hasInvalidText: document.body.innerText.includes('链接无效'),
      }))
      return verdict(
        {
          devicePanel: reading.devicePanel === 1,
          invalidText: reading.hasInvalidText,
        },
        { reading },
      )
    },
  },

  // ── 3. 控制台空态 ──
  {
    name: 'console-empty',
    async run(ctx) {
      await fresh(ctx)
      const reading = await ctx.page.evaluate(() => {
        const button = document.querySelector('[data-action="console.new-session"]')
        const rect = button === null ? null : button.getBoundingClientRect()
        return {
          console: document.querySelectorAll('[data-panel="console"]').length,
          pendingBar: document.querySelectorAll('[data-panel="pending-bar"]').length,
          newSession: document.querySelectorAll('[data-action="console.new-session"]').length,
          newSessionBox:
            rect === null ? null : { w: Math.round(rect.width), h: Math.round(rect.height) },
          composer: document.querySelectorAll('[data-field="chat.composer-input"]').length,
        }
      })
      return verdict(
        {
          console: reading.console === 1,
          noPendingBar: reading.pendingBar === 0,
          newSessionButton: reading.newSession === 1,
          // 「按钮在空态里可见」：有尺寸才算真的渲染出来（v-if 命中但被裁掉不算）
          newSessionVisible: boxReadable(reading.newSessionBox),
          noComposerWhenNoSession: reading.composer === 0,
        },
        { reading },
      )
    },
  },

  // ── 4. 左栏设备行与能力位芯片 ──
  {
    name: 'rail-clients',
    async run(ctx) {
      await fresh(ctx)
      await ctx.page.waitForSelector('[data-field="rail.client-row"]', { timeout: TIMEOUT })
      const reading = await ctx.page.evaluate(() => ({
        clientRow: document.querySelectorAll('[data-field="rail.client-row"]').length,
        onlineDot: document.querySelectorAll('[data-field="rail.online-dot"]').length,
        onlineDotOn: document.querySelectorAll('[data-field="rail.online-dot"].on').length,
        voiceStt: document.querySelectorAll('[data-field="rail.voice-stt"]').length,
        voiceSttText:
          document.querySelector('[data-field="rail.voice-stt"]')?.textContent?.trim() ?? '',
        voiceTts: document.querySelectorAll('[data-field="rail.voice-tts"]').length,
        remoteSession: document.querySelectorAll('[data-field="rail.remote-session"]').length,
      }))
      return verdict(
        {
          clientRow: reading.clientRow >= 1,
          onlineDot: reading.onlineDot >= 1,
          voiceStt: reading.voiceStt >= 1,
          voiceSttLabel: reading.voiceSttText === '语音输入',
          voiceTts: reading.voiceTts >= 1,
        },
        { reading },
      )
    },
  },

  // ── 5. 语音门控：未上报 voice → 连按钮都不渲染 ──
  {
    name: 'voice-gating-off',
    async run(ctx) {
      await fresh(ctx)
      // 先把会话开起来：否则 `chat.mic` 的 0 是"组件根本没渲染"这种恒真的负对照
      await openFixtureSession(ctx)
      await ctx.page.waitForSelector('[data-field="chat.mic"]', { timeout: TIMEOUT })
      // status 是整体覆盖：把 voice 置为 undefined 即"旧客户端不上报该字段"
      ctx.stub.pushStatus({ voice: undefined })
      await ctx.page
        .waitForFunction(() => document.querySelector('[data-field="chat.mic"]') === null, {
          timeout: TIMEOUT,
        })
        .catch(() => undefined)
      const reading = await ctx.page.evaluate(() => ({
        mic: document.querySelectorAll('[data-field="chat.mic"]').length,
        railVoiceStt: document.querySelectorAll('[data-field="rail.voice-stt"]').length,
        railVoiceTts: document.querySelectorAll('[data-field="rail.voice-tts"]').length,
        railRemoteSession: document.querySelectorAll('[data-field="rail.remote-session"]').length,
        composer: document.querySelectorAll('[data-field="chat.composer-input"]').length,
        railRow: document.querySelectorAll('[data-field="rail.client-row"]').length,
      }))
      return verdict(
        {
          // 负对照必须挂在"别的都还在"之上：composer / 设备行 / 其它能力位都在
          composerPresent: reading.composer === 1,
          railRowPresent: reading.railRow >= 1,
          otherCapabilityStillThere: reading.railRemoteSession >= 1,
          micGone: reading.mic === 0,
          railVoiceGone: reading.railVoiceStt === 0 && reading.railVoiceTts === 0,
        },
        { reading },
      )
    },
  },

  // ── 6. 语音门控：上报 voice → 麦克风与朗读按钮都在 ──
  {
    name: 'voice-gating-on',
    async run(ctx) {
      await fresh(ctx)
      await openFixtureSession(ctx)
      await ctx.page.waitForSelector('[data-field="chat.mic"]', { timeout: TIMEOUT })
      ctx.stub.sendEvent(FIXTURE_OPEN_SESSION_ID, textEvent('这条消息用于验证朗读按钮。'))
      await ctx.page.waitForFunction(
        () =>
          (document.querySelector('[data-field="chat.markdown"]')?.textContent ?? '').includes(
            '朗读按钮',
          ),
        { timeout: TIMEOUT },
      )
      ctx.stub.sendEvent(FIXTURE_OPEN_SESSION_ID, doneEvent())
      await ctx.page.waitForSelector('[data-action="speak-message"]', { timeout: TIMEOUT })
      const reading = await ctx.page.evaluate(() => ({
        mic: document.querySelectorAll('[data-field="chat.mic"]').length,
        speak: document.querySelectorAll('[data-action="speak-message"]').length,
        speakText:
          document.querySelector('[data-action="speak-message"]')?.textContent?.trim() ?? '',
      }))
      return verdict({ mic: reading.mic === 1, speakButton: reading.speak === 1 }, { reading })
    },
  },

  // ── 7. 新建远程会话 → 会话视图三件套 ──
  {
    name: 'session-create',
    async run(ctx) {
      await fresh(ctx)
      // 先记下夹具会话（session.list 的回执），新建后的**差集**才是服务器的 create 真的生效 ——
      // 只判"面板里有 center- 开头的行"会被夹具本身喂饱（恒真的负对照）
      await ensurePanelSessions(ctx.page)
      const idsBefore = await panelSessionIds(ctx.page)
      await ctx.page.click('[data-action="console.new-session"]')
      await ctx.page.waitForSelector('[data-field="chat.composer-input"]', { timeout: TIMEOUT })
      const reading = await ctx.page.evaluate(() => ({
        messages: document.querySelectorAll('[data-field="chat.messages"]').length,
        composer: document.querySelectorAll('[data-field="chat.composer-input"]').length,
        permission: document.querySelectorAll('[data-field="chat.permission"]').length,
        model: document.querySelectorAll('[data-field="chat.model"]').length,
        effort: document.querySelectorAll('[data-field="chat.reasoningEffort"]').length,
        modelText: document.querySelector('[data-field="chat.model"]')?.textContent?.trim() ?? '',
        permissionText:
          document.querySelector('[data-field="chat.permission"]')?.textContent?.trim() ?? '',
      }))
      const idsAfter = await panelSessionIds(ctx.page)
      const created = idsAfter.find((id) => !idsBefore.includes(id))
      return verdict(
        {
          stream: reading.messages === 1,
          composer: reading.composer === 1,
          permissionChip: reading.permission === 1,
          modelChip: reading.model === 1,
          effortChip: reading.effort === 1,
          // 服务器生成的 center- 会话 id 真的进了面板（新建链路走通）
          serverSessionId: created !== undefined && created.startsWith('center-'),
        },
        { reading, idsBefore, idsAfter, created },
      )
    },
  },

  // ── 8. 用户消息胶囊 ──
  {
    name: 'user-message',
    async run(ctx) {
      await fresh(ctx)
      await openFixtureSession(ctx)
      ctx.stub.sendEvent(FIXTURE_OPEN_SESSION_ID, userMessageEvent('帮我把课件按科目归档'))
      await ctx.page.waitForSelector('[data-field="chat.user-message"]', { timeout: TIMEOUT })
      const reading = await ctx.page.evaluate(() => {
        const row = document.querySelector('[data-field="chat.user-message"]')
        const bubble = row?.querySelector('.bubble') ?? null
        const radiusRaw = bubble === null ? '' : getComputedStyle(bubble).borderRadius
        const radius = Number.parseFloat(radiusRaw)
        return {
          count: document.querySelectorAll('[data-field="chat.user-message"]').length,
          text: row?.textContent?.trim() ?? '',
          radiusRaw,
          radius,
        }
      })
      return verdict(
        {
          rendered: reading.count >= 1,
          capsule: Number.isFinite(reading.radius) && reading.radius >= 12,
        },
        { reading },
      )
    },
  },

  // ── 9. 流式正文：增量合并 + 流式光标（光标要在 done 之前断言） ──
  {
    name: 'streaming-text',
    async run(ctx) {
      await fresh(ctx)
      await openFixtureSession(ctx)
      ctx.stub.sendEvent(FIXTURE_OPEN_SESSION_ID, textEvent('第一段增量'))
      const caretDuringStreaming = await ctx.page
        .waitForFunction(
          () => {
            const bodies = document.querySelectorAll('.assistant-body')
            const last = bodies[bodies.length - 1]
            return last !== undefined && last.querySelector('.streaming-caret') !== null
          },
          { timeout: TIMEOUT },
        )
        .then(() => true)
        .catch(() => false)
      ctx.stub.sendEvent(FIXTURE_OPEN_SESSION_ID, textEvent('、第二段增量'))
      await ctx.page.waitForFunction(
        () => {
          const markdown = document.querySelector('[data-field="chat.markdown"]')
          return (markdown?.textContent ?? '').includes('第一段增量、第二段增量')
        },
        { timeout: TIMEOUT },
      )
      const textDuring = await ctx.page.evaluate(
        () => document.querySelector('[data-field="chat.markdown"]')?.textContent?.trim() ?? '',
      )
      ctx.stub.sendEvent(FIXTURE_OPEN_SESSION_ID, doneEvent())
      const caretAfter = await ctx.page
        .waitForFunction(() => document.querySelector('.streaming-caret') === null, {
          timeout: TIMEOUT,
        })
        .then(() => true)
        .catch(() => false)
      const reading = await ctx.page.evaluate(() => ({
        markdown: document.querySelectorAll('[data-field="chat.markdown"]').length,
        text: document.querySelector('[data-field="chat.markdown"]')?.textContent?.trim() ?? '',
        carets: document.querySelectorAll('.streaming-caret').length,
      }))
      return verdict(
        {
          markdown: reading.markdown >= 1,
          bothDeltas: reading.text === '第一段增量、第二段增量',
          caretDuringStreaming,
          caretGoneAfterDone: caretAfter && reading.carets === 0,
        },
        { reading, textDuring },
      )
    },
  },

  // ── 10. Markdown 渲染契约：代码块 / 表格 / 外链 / 复制按钮 ──
  {
    name: 'markdown-code',
    async run(ctx) {
      await fresh(ctx)
      await openFixtureSession(ctx)
      ctx.stub.sendEvent(FIXTURE_OPEN_SESSION_ID, textEvent(MARKDOWN_FIXTURE))
      await ctx.page.waitForSelector('.code-block', { timeout: TIMEOUT })
      ctx.stub.sendEvent(FIXTURE_OPEN_SESSION_ID, doneEvent())
      const counts = await ctx.page.evaluate(() => ({
        codeBlock: document.querySelectorAll('.code-block').length,
        codeCopy: document.querySelectorAll('.code-copy').length,
        table: document.querySelectorAll('.md-table').length,
        link: document.querySelectorAll('.md-link[target="_blank"][rel*="noopener"]').length,
        linkRel: document.querySelector('.md-link')?.getAttribute('rel') ?? '',
      }))
      // 点复制：`navigator.clipboard`（localhost 是安全上下文）或 execCommand 回落
      await ctx.page.hover('.code-block').catch(() => undefined)
      await ctx.page.click('.code-copy')
      const labelCopied = await ctx.page
        .waitForFunction(
          () => (document.querySelector('.code-copy-label')?.textContent ?? '').trim() === '已复制',
          { timeout: 2500 },
        )
        .then(() => true)
        .catch(() => false)
      const labelAfterClick = await ctx.page.evaluate(() =>
        (document.querySelector('.code-copy-label')?.textContent ?? '').trim(),
      )
      // 1.4s 后回退成「复制」（MessageStream 的 setTimeout 口径）
      const labelReverted = await ctx.page
        .waitForFunction(
          () => (document.querySelector('.code-copy-label')?.textContent ?? '').trim() === '复制',
          { timeout: 4000 },
        )
        .then(() => true)
        .catch(() => false)
      return verdict(
        {
          codeBlock: counts.codeBlock >= 1,
          codeCopy: counts.codeCopy >= 1,
          table: counts.table >= 1,
          externalLink: counts.link >= 1,
          copyLabel: labelCopied,
          copyReverts: labelReverted,
        },
        { counts, labelAfterClick },
      )
    },
  },

  // ── 11. 轨迹收尾折叠（思考 + 2 步工具 + 正文） ──
  {
    name: 'trace-collapsed',
    async run(ctx) {
      await fresh(ctx)
      await openFixtureSession(ctx)
      ctx.stub.sendEvent(FIXTURE_OPEN_SESSION_ID, reasoningEvent('先读课程表，再按科目分组。'))
      await sleep(60)
      ctx.stub.sendEvent(
        FIXTURE_OPEN_SESSION_ID,
        toolEvent({
          id: 'call-1',
          name: 'read_file',
          state: 'running',
          input: { path: 'D:/课件/a.pdf' },
        }),
      )
      await sleep(60)
      ctx.stub.sendEvent(
        FIXTURE_OPEN_SESSION_ID,
        toolEvent({
          id: 'call-1',
          name: 'read_file',
          state: 'success',
          input: { path: 'D:/课件/a.pdf' },
          outputSummary: '已读取（2.1 MB）',
        }),
      )
      await sleep(60)
      ctx.stub.sendEvent(
        FIXTURE_OPEN_SESSION_ID,
        toolEvent({
          id: 'call-2',
          name: 'write_file',
          state: 'running',
          input: { path: 'D:/归档/a.pdf' },
        }),
      )
      await sleep(60)
      ctx.stub.sendEvent(
        FIXTURE_OPEN_SESSION_ID,
        toolEvent({
          id: 'call-2',
          name: 'write_file',
          state: 'success',
          input: { path: 'D:/归档/a.pdf' },
          outputSummary: '已写入',
        }),
      )
      await sleep(60)
      ctx.stub.sendEvent(FIXTURE_OPEN_SESSION_ID, textEvent('归档完成。'))
      await ctx.page.waitForFunction(
        () =>
          (document.querySelector('[data-field="chat.markdown"]')?.textContent ?? '').includes(
            '归档完成',
          ),
        { timeout: TIMEOUT },
      )
      ctx.stub.sendEvent(FIXTURE_OPEN_SESSION_ID, doneEvent())
      await ctx.page.waitForFunction(
        () => document.querySelectorAll('[data-field="chat.trace"]').length === 1,
        { timeout: TIMEOUT },
      )
      // 给折叠状态机 1.5s（折叠过渡 250ms 级 + 状态更新）——先等到"折了"再判定，
      // 免得把一个慢一拍的折叠判成"没折"
      const foldedInTime = await ctx.page
        .waitForFunction(
          () => {
            const head = document.querySelector('[data-action="chat.trace-toggle"]')
            return head !== null && head.getAttribute('aria-expanded') === 'false'
          },
          { timeout: 1500 },
        )
        .then(() => true)
        .catch(() => false)
      await sleep(400) // 折叠过渡走完再量高度
      const reading = await ctx.page.evaluate(() => {
        const trace = document.querySelector('[data-field="chat.trace"]')
        const head = trace?.querySelector('[data-action="chat.trace-toggle"]') ?? null
        const clip = trace?.querySelector('.trace-clip') ?? null
        const body = trace?.querySelector('.trace-body') ?? null
        return {
          traceCount: document.querySelectorAll('[data-field="chat.trace"]').length,
          liveCount: document.querySelectorAll('[data-field="chat.trace-live"]').length,
          summary:
            trace?.querySelector('[data-field="chat.trace-summary"]')?.textContent?.trim() ?? '',
          ariaExpanded: head?.getAttribute('aria-expanded') ?? null,
          classes: trace?.className ?? '',
          headHeight: head === null ? 0 : Math.round(head.getBoundingClientRect().height),
          clipHeight: clip === null ? 0 : Math.round(clip.getBoundingClientRect().height * 10) / 10,
          bodyHeight: body === null ? 0 : Math.round(body.getBoundingClientRect().height * 10) / 10,
          toolCards: document.querySelectorAll('.tool-card').length,
        }
      })
      return verdict(
        {
          trace: reading.traceCount === 1,
          summaryMentionsThinking: reading.summary.includes('已深度思考'),
          summaryMentionsSteps: reading.summary.includes('2 步'),
          foldedAfterDone:
            foldedInTime && reading.ariaExpanded === 'false' && reading.bodyHeight <= 1,
          headStillTall: reading.headHeight >= 28,
        },
        { reading, foldedInTime },
      )
    },
  },

  // ── 12. 展开后的阅读顺序 + 轨迹左缘竖脊 ──
  {
    name: 'trace-open-order',
    async run(ctx) {
      await fresh(ctx)
      await openFixtureSession(ctx)
      ctx.stub.sendEvent(FIXTURE_OPEN_SESSION_ID, reasoningEvent('先看目录，再决定怎么归类。'))
      await sleep(60)
      ctx.stub.sendEvent(
        FIXTURE_OPEN_SESSION_ID,
        toolEvent({
          id: 'call-1',
          name: 'write_file',
          state: 'success',
          input: { path: 'D:/归档/a.pdf' },
          outputSummary: '已写入',
        }),
      )
      await sleep(60)
      ctx.stub.sendEvent(FIXTURE_OPEN_SESSION_ID, textEvent('归档完成。'))
      await ctx.page.waitForFunction(
        () =>
          document.querySelector('.tool-card') !== null &&
          document.querySelector('.thinking') !== null,
        { timeout: TIMEOUT },
      )
      await sleep(60)
      const toggle = await ensureTraceOpen(ctx.page)
      await ctx.page.waitForFunction(
        () => {
          const head = document.querySelector('[data-action="chat.trace-toggle"]')
          return head !== null && head.getAttribute('aria-expanded') === 'true'
        },
        { timeout: TIMEOUT },
      )
      await sleep(400) // 展开过渡
      const reading = await ctx.page.evaluate(() => {
        const body = document.querySelector('.assistant-body')
        const nodes =
          body === null
            ? []
            : [...body.querySelectorAll('.thinking, .tool-card, [data-field="chat.markdown"]')]
        const order = nodes.map((node) => {
          if (node.classList.contains('thinking')) return 'thinking'
          if (node.classList.contains('tool-card')) return 'tool'
          return 'markdown'
        })
        const traceBody = document.querySelector('.trace-body')
        const spineWidth = traceBody === null ? '' : getComputedStyle(traceBody, '::before').width
        const clip = document.querySelector('.trace-clip')
        return {
          order,
          spineWidth,
          spinePx: Number.parseFloat(spineWidth),
          bodyHeight: clip === null ? 0 : Math.round(clip.getBoundingClientRect().height),
        }
      })
      return verdict(
        {
          orderThinkingFirst: reading.order[0] === 'thinking',
          orderToolSecond: reading.order[1] === 'tool',
          orderMarkdownLast: reading.order[reading.order.length - 1] === 'markdown',
          spineOnePixel: reading.spinePx === 1,
          bodyExpanded: reading.bodyHeight > 0,
        },
        { reading, toggle },
      )
    },
  },

  // ── 13. 思考块：块头文案、正文限高、流式秒数 ──
  {
    name: 'thinking-block',
    async run(ctx) {
      await fresh(ctx)
      await openFixtureSession(ctx)
      ctx.stub.sendEvent(FIXTURE_OPEN_SESSION_ID, reasoningEvent('第一步：读取课程表；'))
      const liveReading = await ctx.page
        .waitForFunction(
          () => document.querySelector('[data-field="chat.thinking-live"]') !== null,
          { timeout: TIMEOUT },
        )
        .then(() => true)
        .catch(() => false)
      const elapsedText = await ctx.page.evaluate(
        () => document.querySelector('.thinking-elapsed')?.textContent?.trim() ?? '',
      )
      const thinkingBody = await ctx.page.evaluate(
        () => document.querySelectorAll('[data-field="chat.thinking-body"]').length,
      )
      ctx.stub.sendEvent(FIXTURE_OPEN_SESSION_ID, reasoningEvent('第二步：按科目分组。'))
      await ctx.page.waitForFunction(
        () => (document.querySelector('.thinking-text')?.textContent ?? '').includes('第二步'),
        { timeout: TIMEOUT },
      )
      ctx.stub.sendEvent(FIXTURE_OPEN_SESSION_ID, textEvent('已整理完。'))
      await sleep(60)
      ctx.stub.sendEvent(FIXTURE_OPEN_SESSION_ID, doneEvent())
      await sleep(300)
      const toggle = await ensureTraceOpen(ctx.page)
      await ctx.page.waitForSelector('[data-field="chat.thinking-body"]', { timeout: TIMEOUT })
      const reading = await ctx.page.evaluate(() => {
        const label = document.querySelector('.thinking-label')
        const text = document.querySelector('[data-field="chat.thinking-text"]')
        return {
          labelText: label?.textContent?.trim() ?? '',
          labelAnchor: document.querySelectorAll('[data-field="chat.thinking-label"]').length,
          maxHeightRaw: text === null ? '' : getComputedStyle(text).maxHeight,
          maxHeightPx: text === null ? 0 : Number.parseFloat(getComputedStyle(text).maxHeight),
          reasoningText: text?.textContent?.trim() ?? '',
          liveCount: document.querySelectorAll('[data-field="chat.thinking-live"]').length,
        }
      })
      return verdict(
        {
          liveWhileStreaming: liveReading,
          elapsedLooksLikeSeconds: /\d+(\.\d+)?s/.test(elapsedText),
          bodyOpenWhileStreaming: thinkingBody >= 1,
          label: reading.labelText === '已深度思考',
          maxHeight220: reading.maxHeightPx === 220,
        },
        {
          reading,
          elapsedText,
          // 探针锚点说明：SPA 的块头是 `.thinking-label`（没有 `chat.thinking-label` 这个 data-field），
          // 这里按"块头文案"的真实锚点读；labelAnchor 记录同名 data-field 的命中数（当前为 0）
          notes: ['思考块头锚点为 .thinking-label（SPA 未提供 data-field="chat.thinking-label"）'],
          toggle,
        },
      )
    },
  },

  // ── 14. 工具行三态：图标唯一、状态点颜色、运行中扫光 ──
  {
    name: 'tool-states',
    async run(ctx) {
      await fresh(ctx)
      await openFixtureSession(ctx)
      ctx.stub.sendEvent(
        FIXTURE_OPEN_SESSION_ID,
        toolEvent({ id: 'call-run', name: 'grep', state: 'running', input: { pattern: '课件' } }),
      )
      await sleep(60)
      ctx.stub.sendEvent(
        FIXTURE_OPEN_SESSION_ID,
        toolEvent({
          id: 'call-ok',
          name: 'read_file',
          state: 'success',
          input: { path: 'D:/课件/a.pdf' },
          outputSummary: '已读取（2.1 MB）',
        }),
      )
      await sleep(60)
      ctx.stub.sendEvent(
        FIXTURE_OPEN_SESSION_ID,
        toolEvent({
          id: 'call-err',
          name: 'run_command',
          state: 'error',
          input: { command: 'dir D:/不存在' },
          outputSummary: '目录不存在',
        }),
      )
      await ctx.page.waitForFunction(() => document.querySelectorAll('.tool-card').length === 3, {
        timeout: TIMEOUT,
      })
      // 三行全部展开（spec：all expanded）
      await ctx.page.evaluate(() => {
        for (const head of document.querySelectorAll(
          '.tool-card [data-action="chat.tool-toggle"]',
        )) {
          head.click()
        }
      })
      await ctx.page.waitForFunction(
        () => document.querySelectorAll('[data-field="chat.tool-body"]').length === 3,
        { timeout: TIMEOUT },
      )
      await sleep(400)
      const reading = await ctx.page.evaluate(() => {
        const token = (name) => {
          const probe = document.createElement('span')
          probe.style.color = `var(${name})`
          document.documentElement.appendChild(probe)
          const value = getComputedStyle(probe).color
          probe.remove()
          return value
        }
        const cards = [...document.querySelectorAll('.tool-card')]
        const rows = cards.map((card) => {
          const dot = card.querySelector('.tool-dot')
          return {
            classes: card.className,
            icons: card.querySelectorAll('.tool-icon').length,
            shimmer: card.querySelector('.tool-head')?.classList.contains('shimmer') ?? false,
            dotColor: dot === null ? '' : getComputedStyle(dot, '::before').backgroundColor,
            nodeDotColor: getComputedStyle(card, '::before').backgroundColor,
            title: card.querySelector('.tool-title')?.textContent?.trim() ?? '',
          }
        })
        return {
          rows,
          toolCard: cards.length,
          toolIcon: document.querySelectorAll('.tool-card .tool-icon').length,
          tokens: {
            running: token('--status-running'),
            ok: token('--status-ok'),
            error: token('--status-error'),
          },
        }
      })
      const byState = (state) => reading.rows.find((row) => row.classes.includes(`t-${state}`))
      const run = byState('running')
      const ok = byState('success')
      const error = byState('error')
      const readingOut = {
        reading: {
          ...reading,
          matched: { run: run ?? null, ok: ok ?? null, error: error ?? null },
        },
      }
      return verdict(
        {
          threeCards: reading.toolCard === 3,
          oneIconEach:
            reading.toolIcon === reading.toolCard && reading.rows.every((row) => row.icons === 1),
          runningColor: run !== undefined && run.dotColor === reading.tokens.running,
          okColor: ok !== undefined && ok.dotColor === reading.tokens.ok,
          errorColor: error !== undefined && error.dotColor === reading.tokens.error,
          runningShimmer: run !== undefined && run.shimmer === true,
          settledNoShimmer:
            ok !== undefined && error !== undefined && !ok.shimmer && !error.shimmer,
        },
        readingOut,
      )
    },
  },

  // ── 15. 工具行展开体：实测高度（--collapse-h）与 scrollHeight 一致 ──
  {
    name: 'tool-collapse',
    async run(ctx) {
      await fresh(ctx)
      await openFixtureSession(ctx)
      ctx.stub.sendEvent(
        FIXTURE_OPEN_SESSION_ID,
        toolEvent({
          id: 'call-1',
          name: 'write_file',
          state: 'running',
          input: { path: 'D:/归档/高等数学-第3讲.pdf' },
        }),
      )
      await sleep(60)
      ctx.stub.sendEvent(
        FIXTURE_OPEN_SESSION_ID,
        toolEvent({
          id: 'call-1',
          name: 'write_file',
          state: 'success',
          input: { path: 'D:/归档/高等数学-第3讲.pdf', mode: 'overwrite' },
          outputSummary: '已写入 2.1 MB（写前快照已留存）',
        }),
      )
      await ctx.page.waitForFunction(() => document.querySelector('.tool-card.settled') !== null, {
        timeout: TIMEOUT,
      })
      await ctx.page.click('.tool-card [data-action="chat.tool-toggle"]')
      await ctx.page.waitForSelector('[data-field="chat.tool-body"]', { timeout: TIMEOUT })
      await ctx.page.waitForFunction(
        () => {
          const body = document.querySelector('[data-field="chat.tool-body"]')
          return body !== null && body.style.getPropertyValue('--collapse-h') !== ''
        },
        { timeout: TIMEOUT },
      )
      await sleep(400) // 过渡（250ms 级）走完再量可见高度
      const reading = await ctx.page.evaluate(() => {
        const body = document.querySelector('[data-field="chat.tool-body"]')
        if (body === null) return { exists: false }
        const raw = body.style.getPropertyValue('--collapse-h').trim()
        const match = /^([0-9]+(\.[0-9]+)?)px$/.exec(raw)
        const measuredPx = match === null ? null : Number(match[1])
        const scrollHeight = body.scrollHeight
        return {
          exists: true,
          raw,
          measuredPx,
          scrollHeight,
          delta: measuredPx === null ? null : Math.abs(measuredPx - scrollHeight),
          visibleHeight: Math.round(body.getBoundingClientRect().height * 10) / 10,
        }
      })
      return verdict(
        {
          bodyExists: reading.exists === true,
          collapseVarParses: reading.measuredPx !== null,
          matchesScrollHeight: reading.delta !== null && reading.delta <= 2,
          notClipped:
            reading.exists === true && Math.abs(reading.visibleHeight - reading.scrollHeight) <= 2,
        },
        { reading },
      )
    },
  },

  // ── 16. 子代理卡：只读镜像（可读写徽章、报告、对话里没有任何输入控件） ──
  {
    name: 'subagent-card',
    async run(ctx) {
      await fresh(ctx)
      await openFixtureSession(ctx)
      const snapshot = subagentSnapshot()
      ctx.stub.sendEvent(
        FIXTURE_OPEN_SESSION_ID,
        toolEvent({
          id: 'call-task-1',
          name: 'task',
          state: 'success',
          input: { description: '整理本周课件' },
          outputSummary: '子代理完成：12 份课件已归类',
          subagent: snapshot,
        }),
      )
      await sleep(80)
      ctx.stub.sendEvent(FIXTURE_OPEN_SESSION_ID, {
        type: 'subagent',
        requestId: REQUEST_ID,
        round: 0,
        messageId: MESSAGE_ID,
        callId: 'call-task-1',
        subagent: snapshot,
      })
      await ctx.page.waitForSelector('[data-action="chat.subagent-toggle"]', { timeout: TIMEOUT })
      const toggle = await ensureTraceOpen(ctx.page)
      await ctx.page.waitForFunction(
        () => {
          const head = document.querySelector('[data-action="chat.trace-toggle"]')
          return head !== null && head.getAttribute('aria-expanded') === 'true'
        },
        { timeout: TIMEOUT },
      )
      await ctx.page.click('[data-action="chat.subagent-toggle"]')
      await ctx.page.waitForSelector('[data-field="chat.subagent-conversation"]', {
        timeout: TIMEOUT,
      })
      const reading = await ctx.page.evaluate(() => {
        const inner = document.querySelector('.subagent[data-field="chat.task-card"]')
        const outer = document.querySelector('.tool-card[data-field="chat.task-card"]')
        const conversation = document.querySelector('[data-field="chat.subagent-conversation"]')
        return {
          taskCardTotal: document.querySelectorAll('[data-field="chat.task-card"]').length,
          taskCardOuter: outer === null ? 0 : 1,
          taskCardInner: inner === null ? 0 : 1,
          taskCardAnchors: [...document.querySelectorAll('[data-field="chat.task-card"]')].map(
            (node) => node.className,
          ),
          permText:
            document.querySelector('[data-field="chat.subagent-perm"]')?.textContent?.trim() ?? '',
          conversation: conversation === null ? 0 : 1,
          inputsInConversation:
            conversation === null
              ? -1
              : conversation.querySelectorAll('textarea, input, [contenteditable]').length,
          report: document.querySelectorAll('[data-field="chat.subagent-report"]').length,
          reportText:
            document.querySelector('[data-field="chat.subagent-report"]')?.textContent?.trim() ??
            '',
          subagentToolRows: document.querySelectorAll('[data-action="chat.subagent-tool"]').length,
          progress: document.querySelectorAll('[data-field="chat.subagent-progress"]').length,
        }
      })
      return verdict(
        {
          // ⚠️ 同名锚点在 SPA 里嵌套出现（外层 .tool-card 与内层 .subagent 都带
          // data-field="chat.task-card"），因此判据取"子代理卡恰好一张"这个语义，
          // 原始计数一并记录（见 readings.taskCardAnchors）
          exactlyOneSubagentCard: reading.taskCardInner === 1,
          permWritable: reading.permText === '可读写',
          conversationPresent: reading.conversation === 1,
          conversationReadOnly: reading.inputsInConversation === 0,
          reportPresent: reading.report >= 1 && reading.reportText !== '',
        },
        {
          reading,
          toggle,
          notes: [
            'SPA：data-field="chat.task-card" 在外层 .tool-card 与内层 .subagent 上各出现一次（嵌套重复锚点）',
          ],
        },
      )
    },
  },

  // ── 17. 任务清单卡（job） ──
  {
    name: 'job-card',
    async run(ctx) {
      await fresh(ctx)
      await openFixtureSession(ctx)
      ctx.stub.sendEvent(FIXTURE_OPEN_SESSION_ID, {
        type: 'job',
        requestId: REQUEST_ID,
        job: jobSummary(),
      })
      await ctx.page.waitForSelector('[data-field="chat.job-card"]', { timeout: TIMEOUT })
      const reading = await ctx.page.evaluate(() => {
        const card = document.querySelector('[data-field="chat.job-card"]')
        return {
          count: document.querySelectorAll('[data-field="chat.job-card"]').length,
          status:
            document.querySelector('[data-field="chat.job-status"]')?.textContent?.trim() ?? '',
          text: card?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        }
      })
      return verdict(
        {
          card: reading.count === 1,
          statusNonEmpty: reading.status !== '',
          roundShape: /第\s*1\s*\/\s*3\s*轮/.test(reading.text),
        },
        { reading },
      )
    },
  },

  // ── 18. 历史回放：折叠轨迹 + 不挂 pending ──
  {
    name: 'history-replay',
    async run(ctx) {
      await fresh(ctx)
      ctx.stub.setHistory(FIXTURE_HISTORY_SESSION_ID, fixtureHistoryMessages())
      await openFixtureSession(ctx, FIXTURE_HISTORY_SESSION_ID)
      await ctx.page.waitForSelector('[data-field="chat.trace"]', { timeout: TIMEOUT })
      await sleep(400)
      const reading = await ctx.page.evaluate(() => {
        const trace = document.querySelector('[data-field="chat.trace"]')
        const head = trace?.querySelector('[data-action="chat.trace-toggle"]') ?? null
        const clip = trace?.querySelector('.trace-clip') ?? null
        return {
          userMessages: document.querySelectorAll('[data-field="chat.user-message"]').length,
          markdown: document.querySelectorAll('[data-field="chat.markdown"]').length,
          traceCount: document.querySelectorAll('[data-field="chat.trace"]').length,
          liveCount: document.querySelectorAll('[data-field="chat.trace-live"]').length,
          ariaExpanded: head?.getAttribute('aria-expanded') ?? null,
          clipHeight: clip === null ? 0 : Math.round(clip.getBoundingClientRect().height),
          pending: document.querySelectorAll('[data-field="chat.pending"]').length,
          title: document.querySelector('.main-title')?.textContent?.trim() ?? '',
        }
      })
      return verdict(
        {
          itemsReplayed: reading.userMessages >= 1 && reading.markdown >= 1,
          collapsedTrace:
            reading.traceCount === 1 && reading.ariaExpanded === 'false' && reading.clipHeight <= 1,
          noPending: reading.pending === 0,
        },
        { reading, historyTitle: FIXTURE_HISTORY_TITLE },
      )
    },
  },

  // ── 19. 确认卡（60s 倒计时） ──
  {
    name: 'pending-confirm',
    async run(ctx) {
      await fresh(ctx)
      ctx.stub.sendConfirm(CONFIRM_REQUEST('conf-verify-1'))
      await ctx.page.waitForSelector('[data-field="chat.confirm-card"]', { timeout: TIMEOUT })
      const reading = await ctx.page.evaluate(() => ({
        bar: document.querySelectorAll('[data-panel="pending-bar"]').length,
        card: document.querySelectorAll('[data-field="chat.confirm-card"]').length,
        countdown: document.querySelector('.countdown')?.textContent?.trim() ?? '',
        approve: document.querySelectorAll('[data-action="chat.confirm-approve"]').length,
        reject: document.querySelectorAll('[data-action="chat.confirm-reject"]').length,
      }))
      return verdict(
        {
          bar: reading.bar === 1,
          card: reading.card === 1,
          countdown: /\d+ 秒后自动拒绝/.test(reading.countdown),
          buttons: reading.approve === 1 && reading.reject === 1,
        },
        { reading },
      )
    },
  },

  // ── 20. 批准确认卡 → 命令回到客户端 ──
  {
    name: 'confirm-approve',
    async run(ctx) {
      await fresh(ctx)
      const since = ctx.stub.mark()
      ctx.stub.sendConfirm(CONFIRM_REQUEST('conf-verify-2'))
      await ctx.page.waitForSelector('[data-action="chat.confirm-approve"]', { timeout: TIMEOUT })
      await ctx.page.click('[data-action="chat.confirm-approve"]')
      const gone = await ctx.page
        .waitForFunction(
          () => document.querySelector('[data-field="chat.confirm-card"]') === null,
          {
            timeout: 2000,
          },
        )
        .then(() => true)
        .catch(() => false)
      const resolved = await ctx.stub.waitForCommand('confirm.resolve', { since, timeout: 3000 })
      const reading = await ctx.page.evaluate(() => ({
        card: document.querySelectorAll('[data-field="chat.confirm-card"]').length,
        bar: document.querySelectorAll('[data-panel="pending-bar"]').length,
      }))
      return verdict(
        {
          cardGoneIn2s: gone && reading.card === 0,
          commandSent: resolved !== null,
          approvedTrue: resolved !== null && resolved.approved === true,
          sameConfirmId: resolved !== null && resolved.confirmId === 'conf-verify-2',
        },
        { reading, resolvedCommand: resolved },
      )
    },
  },

  // ── 21. 提问卡（3 选项 + 自由回答 + 180s 倒计时） ──
  {
    name: 'pending-ask',
    async run(ctx) {
      await fresh(ctx)
      await dismissPendingAsks(ctx.page)
      ctx.stub.sendAsk(askRequest('ask-verify-1'))
      await ctx.page.waitForSelector('[data-field="chat.ask-user-card"]', { timeout: TIMEOUT })
      const reading = await ctx.page.evaluate(() => ({
        card: document.querySelectorAll('[data-field="chat.ask-user-card"]').length,
        question:
          document.querySelector('[data-field="chat.ask-user-question"]')?.textContent?.trim() ??
          '',
        options: document.querySelectorAll('[data-action="chat.ask-option"]').length,
        optionTexts: [...document.querySelectorAll('[data-action="chat.ask-option"]')].map((node) =>
          node.textContent.replace(/\s+/g, ' ').trim(),
        ),
        free: document.querySelectorAll('[data-field="chat.ask-free"]').length,
        countdown: document.querySelector('.countdown')?.textContent?.trim() ?? '',
      }))
      return verdict(
        {
          card: reading.card === 1,
          questionMatches: reading.question === '要把归档后的课件放到哪个目录？',
          threeOptions: reading.options === 3,
          freeInput: reading.free === 1,
          countdown: /\d+ 秒后按未回答继续/.test(reading.countdown),
        },
        { reading },
      )
    },
  },

  // ── 22. 选第 2 个选项并提交 → ask.resolve 带回答 ──
  {
    name: 'ask-submit',
    async run(ctx) {
      await fresh(ctx)
      await dismissPendingAsks(ctx.page)
      const since = ctx.stub.mark()
      ctx.stub.sendAsk(askRequest('ask-verify-2'))
      await ctx.page.waitForSelector('[data-field="chat.ask-user-card"]', { timeout: TIMEOUT })
      await ctx.page.evaluate(() => {
        const options = document.querySelectorAll('[data-action="chat.ask-option"]')
        options[1].click()
      })
      await ctx.page.click('[data-action="chat.ask-submit"]')
      const gone = await ctx.page
        .waitForFunction(
          () => document.querySelector('[data-field="chat.ask-user-card"]') === null,
          {
            timeout: 2500,
          },
        )
        .then(() => true)
        .catch(() => false)
      const resolved = await ctx.stub.waitForCommand('ask.resolve', { since, timeout: 3000 })
      const picked = ASK_OPTIONS[1].label
      return verdict(
        {
          cardGone: gone,
          commandSent: resolved !== null,
          sameRequestId: resolved !== null && resolved.requestId === 'ask-verify-2',
          answersIncludePicked: resolved !== null && (resolved.answers ?? []).includes(picked),
        },
        { resolvedCommand: resolved, picked },
      )
    },
  },

  // ── 23. 提问超时：卡片消失、待办栏收起（倒计时读数采样） ──
  {
    name: 'ask-expired',
    async run(ctx) {
      await fresh(ctx)
      await dismissPendingAsks(ctx.page)
      ctx.stub.sendAsk(askRequest('ask-verify-3', 2000))
      await ctx.page.waitForSelector('[data-field="chat.ask-user-card"]', { timeout: TIMEOUT })
      // 采样倒计时文案：卡在 remainingMs<=0 的那一刻就被父级摘掉，
      // 所以这里记录"最后一次看到的文案"，而不是断言某一帧
      const samples = []
      const deadline = Date.now() + 3600
      while (Date.now() < deadline) {
        const sample = await ctx.page.evaluate(() => ({
          card: document.querySelectorAll('[data-field="chat.ask-user-card"]').length,
          countdown: document.querySelector('.countdown')?.textContent?.trim() ?? '',
        }))
        if (sample.card > 0 && sample.countdown !== '') samples.push(sample.countdown)
        await sleep(250)
      }
      const gone = await ctx.page
        .waitForFunction(
          () =>
            document.querySelector('[data-field="chat.ask-user-card"]') === null &&
            document.querySelector('[data-panel="pending-bar"]') === null,
          { timeout: 3000 },
        )
        .then(() => true)
        .catch(() => false)
      const reading = await ctx.page.evaluate(() => ({
        card: document.querySelectorAll('[data-field="chat.ask-user-card"]').length,
        bar: document.querySelectorAll('[data-panel="pending-bar"]').length,
      }))
      const sawExpiredText = samples.some((text) => text.includes('已过期'))
      const reachedZero = samples.some((text) => /[01] 秒/.test(text))
      return verdict(
        {
          cardGone: gone && reading.card === 0,
          barHidden: reading.bar === 0,
          // 「已过期-ish」：文案出现过"已过期"，或倒计时走到 ≤1 秒（父级在归零那一刻就摘卡，
          // 见 notes —— 「已过期」分支在待办栏里不可达）
          expiredIndicator: sawExpiredText || reachedZero,
        },
        {
          reading,
          countdownSamples: samples,
          sawExpiredText,
          notes: [
            'SPA：待办栏按 remainingMs>0 过滤，归零那一拍整卡摘除；AskCard 的「已过期」分支在栏里不可达（这里记录最后几次倒计时文案）',
          ],
        },
      )
    },
  },

  // ── 24. 文件条 + 文件页 ──
  {
    name: 'files-strip-and-page',
    async run(ctx) {
      await fresh(ctx)
      await openFixtureSession(ctx)
      await ctx.stub.uploadFile({
        name: '高等数学-第3讲.pdf',
        content: 'verify fixture content',
        note: '夹具文件',
      })
      await ctx.page.waitForSelector('[data-field="chat.file-chip"]', { timeout: TIMEOUT })
      const strip = await ctx.page.evaluate(() => ({
        chip: document.querySelectorAll('[data-field="chat.file-chip"]').length,
        text: document.querySelector('[data-field="chat.file-chip"]')?.textContent?.trim() ?? '',
      }))
      await ctx.page.evaluate(() => {
        window.location.hash = '#/files'
      })
      await ctx.page.waitForSelector('[data-panel="files-table"]', { timeout: TIMEOUT })
      const pageReading = await ctx.page.evaluate(() => ({
        panel: document.querySelectorAll('[data-panel="files-table"]').length,
        rows: document.querySelectorAll('[data-field="files.row"]').length,
        del: document.querySelectorAll('[data-action="files.delete"]').length,
        firstName:
          document
            .querySelector('[data-field="files.row"]')
            ?.textContent?.replace(/\s+/g, ' ')
            .trim() ?? '',
      }))
      return verdict(
        {
          stripChip: strip.chip >= 1,
          filesTable: pageReading.panel === 1,
          filesRow: pageReading.rows >= 1,
          deleteButton: pageReading.del >= 1,
        },
        { strip, filesPage: pageReading },
      )
    },
  },

  // ── 25. 自动化页：列表 / 触发 / 编辑器 ──
  {
    name: 'automations',
    async run(ctx) {
      await fresh(ctx, { hash: '#/automations', expect: '[data-panel="automations-page"]' })
      // 首拉要么出卡、要么出错误行（SPA 的「WS 未就绪就发命令」竞态会落进后者）
      await ctx.page.waitForFunction(
        () =>
          document.querySelector('[data-field="automations.card"]') !== null ||
          document.querySelector('.ui-error') !== null,
        { timeout: TIMEOUT },
      )
      const firstLoadError = await ctx.page.evaluate(
        () => document.querySelector('.ui-error')?.textContent?.trim() ?? '',
      )
      // 首拉失败时点页面自己的「刷新」继续（用户路径）；失败本身记进 conditions，不被藏掉
      if (firstLoadError !== '') {
        await ctx.page.click('.ui-btn--ghost')
        await ctx.page.waitForSelector('[data-field="automations.card"]', { timeout: TIMEOUT })
      }
      const list = await ctx.page.evaluate(() => ({
        page: document.querySelectorAll('[data-panel="automations-page"]').length,
        cards: document.querySelectorAll('[data-field="automations.card"]').length,
        builtin: document.querySelectorAll('[data-field="automations.builtin-card"]').length,
      }))
      const since = ctx.stub.mark()
      await ctx.page.click('[data-action="automations.run"]')
      const runCommand = await ctx.stub.waitForCommand('automation.run', { since, timeout: 4000 })
      const stillAlive = await ctx.page.evaluate(
        () => document.querySelectorAll('[data-panel="automations-page"]').length === 1,
      )
      // 触发一次会走 loading 态（列表被替换成 spinner），等编辑按钮回来再点
      await ctx.page.waitForSelector('[data-action="automations.edit"]', { timeout: TIMEOUT })
      await ctx.page.click('[data-action="automations.edit"]')
      await ctx.page.waitForSelector('[data-panel="automation-editor"]', { timeout: TIMEOUT })
      const editor = await ctx.page.evaluate(() => ({
        panel: document.querySelectorAll('[data-panel="automation-editor"]').length,
        fields: document.querySelectorAll('[data-field^="automation."]').length,
        fieldNames: [...document.querySelectorAll('[data-field^="automation."]')].map((node) =>
          node.getAttribute('data-field'),
        ),
      }))
      return verdict(
        {
          page: list.page === 1,
          cards: list.cards >= 1,
          runCommandSent: runCommand !== null,
          runCommandId: runCommand !== null && runCommand.id !== '',
          pageSurvivesRun: stillAlive,
          editor: editor.panel === 1,
          editorFields: editor.fields >= 2,
          firstLoadOk: firstLoadError === '',
        },
        { list, editor, runCommand, firstLoadError },
      )
    },
  },

  // ── 26. 管理端：用户表 + 客户端表（在线） ──
  {
    name: 'admin',
    async run(ctx) {
      await fresh(ctx, { hash: '#/admin', expect: '[data-panel="admin-page"]' })
      await ctx.page.waitForSelector('[data-panel="admin-users"]', { timeout: TIMEOUT })
      await ctx.page.waitForSelector('[data-field="admin.client-online"]', { timeout: TIMEOUT })
      const reading = await ctx.page.evaluate(() => ({
        usersPanel: document.querySelectorAll('[data-panel="admin-users"]').length,
        userRows: document.querySelectorAll('[data-field="admin.user-row"]').length,
        clientsPanel: document.querySelectorAll('[data-panel="admin-clients"]').length,
        onlineChips: document.querySelectorAll('[data-field="admin.client-online"]').length,
        onlineText:
          document.querySelector('[data-field="admin.client-online"]')?.textContent?.trim() ?? '',
        clientRows: document.querySelectorAll('[data-field="admin.client-row"]').length,
        officialModels: document.querySelectorAll('[data-panel="official-models"]').length,
        releaseAdmin: document.querySelectorAll('[data-panel="release-admin"]').length,
      }))
      return verdict(
        {
          usersPanel: reading.usersPanel === 1,
          userRows: reading.userRows >= 1,
          clientsPanel: reading.clientsPanel === 1,
          onlineChip: reading.onlineChips >= 1 && reading.onlineText === '在线',
          officialModels: reading.officialModels === 1,
          releaseAdmin: reading.releaseAdmin === 1,
        },
        { reading },
      )
    },
  },

  // ── 26b. 用量：普通用户视图与折线图画布 ──
  {
    name: 'usage',
    async run(ctx) {
      await fresh(ctx, { hash: '#/usage', expect: '[data-panel="usage-page"]' })
      await ctx.page.waitForSelector('[data-field="usage.chart"] canvas', { timeout: TIMEOUT })
      const reading = await ctx.page.evaluate(() => ({
        page: document.querySelectorAll('[data-panel="usage-page"]').length,
        cards: document.querySelectorAll('.usage-card').length,
        canvas: document.querySelectorAll('[data-field="usage.chart"] canvas').length,
        userFilter: document.querySelectorAll('input[aria-label="用户 ID"]').length,
      }))
      return verdict(
        {
          page: reading.page === 1,
          cards: reading.cards === 3,
          chart: reading.canvas === 1,
          adminFilter: reading.userFilter === 1,
        },
        { reading },
      )
    },
  },

  // ── 27. 右栏「会话管理」：会话行 + 权限 / 项目下拉 ──
  {
    name: 'panel-sessions',
    async run(ctx) {
      await fresh(ctx)
      await ctx.page.click('[data-action="panel.tab-sessions"]')
      // 首拉要么出行、要么出 panel.error（SPA 的「WS 未就绪就首拉」竞态会落进后者）
      await ctx.page.waitForFunction(
        () =>
          document.querySelector('[data-field="panel.session-row"]') !== null ||
          document.querySelector('[data-field="panel.error"]') !== null,
        { timeout: TIMEOUT },
      )
      const reading = await ctx.page.evaluate(() => ({
        rows: document.querySelectorAll('[data-field="panel.session-row"]').length,
        permission: document.querySelectorAll('select[data-field="panel.permission"]').length,
        project: document.querySelectorAll('select[data-field="panel.project"]').length,
        projectOptions: document.querySelectorAll('[data-field="panel.project"] option').length,
        panelError: document.querySelector('[data-field="panel.error"]')?.textContent?.trim() ?? '',
        wsChip: document.querySelector('[data-field="shell.ws"]')?.textContent?.trim() ?? '',
        sessionIds: [...document.querySelectorAll('[data-field="panel.session-row"]')].map(
          (row) => /center-[0-9a-zA-Z]+/.exec(row.textContent)?.[0] ?? '',
        ),
      }))
      return verdict(
        {
          rows: reading.rows >= 1,
          permissionSelect: reading.permission >= 1,
          projectSelect: reading.project >= 1,
          // 首拉不许报错（这里**不点刷新** —— 点刷新就是替应用兜底，缺陷会被永久藏住）
          noPanelError: reading.panelError === '',
        },
        { reading },
      )
    },
  },

  // ── 28. 右栏「模型」：三枚下拉 + 切模型真的发 llm.switch ──
  {
    name: 'panel-model',
    async run(ctx) {
      await fresh(ctx)
      await ctx.page.click('[data-action="panel.tab-llm"]')
      await ctx.page.waitForSelector('[data-field="panel.provider"]', { timeout: TIMEOUT })
      // 等配置切片就位（`config.get` 回执 → remoteLlm 非空 → 模型下拉有候选）；
      // 若首拉竞态命中，等待会落在 panel.error 上而不是白等 10s
      await ctx.page.waitForFunction(
        () => {
          const select = document.querySelector('[data-field="panel.model"]')
          return (
            (select !== null && !select.disabled && select.options.length >= 2) ||
            document.querySelector('[data-field="panel.error"]') !== null
          )
        },
        { timeout: TIMEOUT },
      )
      const before = await ctx.page.evaluate(() => {
        const model = document.querySelector('[data-field="panel.model"]')
        return {
          provider: document.querySelectorAll('[data-field="panel.provider"]').length,
          model: document.querySelectorAll('[data-field="panel.model"]').length,
          effort: document.querySelectorAll('[data-field="panel.effort"]').length,
          modelValue: model?.value ?? '',
          modelDisabled: model?.disabled ?? null,
          modelOptions: model === null ? [] : [...model.options].map((option) => option.value),
          activeProvider: document.querySelector('[data-field="panel.provider"]')?.value ?? '',
          panelError:
            document.querySelector('[data-field="panel.error"]')?.textContent?.trim() ?? '',
        }
      })
      const configLoaded = !before.modelDisabled && before.modelOptions.includes('aurora-test-2')
      let switched = null
      if (configLoaded) {
        const since = ctx.stub.mark()
        await ctx.page.select('[data-field="panel.model"]', 'aurora-test-2')
        switched = await ctx.stub.waitForCommand('llm.switch', { since, timeout: 4000 })
      }
      return verdict(
        {
          provider: before.provider >= 1,
          model: before.model >= 1,
          effort: before.effort >= 1,
          configLoaded,
          switchCommand: switched !== null,
          switchModel: switched !== null && switched.model === 'aurora-test-2',
        },
        { before, switched, switchAttempted: configLoaded },
      )
    },
  },

  // ── 29. 右栏「远程配置」：模式按钮 + agent.tools 开关发 config.update ──
  {
    name: 'panel-config',
    async run(ctx) {
      await fresh(ctx)
      await ctx.page.click('[data-action="panel.tab-config"]')
      await ctx.page.waitForSelector('[data-action="panel.mode-classroom"]', { timeout: TIMEOUT })
      const modeButtons = await ctx.page.evaluate(() => ({
        count: document.querySelectorAll('[data-action^="panel.mode-"]').length,
        classroom: document.querySelectorAll('[data-action="panel.mode-classroom"]').length,
        switches: document.querySelectorAll('[data-switch]').length,
        enabledChecked:
          document.querySelector('[data-switch="agent.tools.enabled"]')?.checked ?? null,
      }))
      const since = ctx.stub.mark()
      await ctx.page.click('[data-switch="agent.tools.enabled"]')
      const update = await ctx.stub.waitForCommand('config.update', { since, timeout: 4000 })
      const patch = update === null ? null : (update.patch ?? null)
      return verdict(
        {
          modeClassroom: modeButtons.classroom >= 1,
          switchPresent: modeButtons.switches >= 1,
          configUpdateSent: update !== null,
          exactPath:
            patch !== null && Object.prototype.hasOwnProperty.call(patch, 'agent.tools.enabled'),
          toggledToFalse: patch !== null && patch['agent.tools.enabled'] === false,
        },
        { modeButtons, update },
      )
    },
  },

  // ── 30. 主题：body 背景必须等于该主题的 --bg-base ──
  {
    name: 'theme-dark',
    theme: 'dark',
    async run(ctx) {
      return themeCheck(ctx, 'dark')
    },
  },
  {
    name: 'theme-light',
    theme: 'light',
    async run(ctx) {
      return themeCheck(ctx, 'light')
    },
  },

  // ── 31. 会话管理面板要能滚（会话一多，最后一条必须够得着） ──
  {
    name: 'panel-sessions-scroll',
    async run(ctx) {
      // 先把会话列表撑到 24 条：两条夹具 + 22 条占位（见 fixtureSessionList(count)）
      ctx.stub.setSessionCount(24)
      await fresh(ctx)
      await ctx.page.click('[data-action="panel.tab-sessions"]')
      await ensurePanelSessions(ctx.page)
      await ctx.page.waitForFunction(
        () => document.querySelectorAll('[data-field="panel.session-row"]').length >= 20,
        { timeout: TIMEOUT },
      )
      // 可见性一律相对**被裁剪的祖先**（右侧抽屉）：拿面板体自己的盒子比是恒真的假判据 ——
      // 面板体在被裁之前能长到 3380px，"最后一行落在 body 盒子里"毫无信息量（首版实测如此）。
      const sampleScroll = () =>
        ctx.page.evaluate(() => {
          const body = document.querySelector('[data-panel="panel.sessions"]')
          const drawer = document.querySelector('[data-field="panel-container"]')
          if (body === null) return null
          const rows = [...body.querySelectorAll('[data-field="panel.session-row"]')]
          const last = rows[rows.length - 1]
          const clip = (drawer ?? body).getBoundingClientRect()
          const lastBox = last?.getBoundingClientRect()
          return {
            rows: rows.length,
            clientHeight: body.clientHeight,
            scrollHeight: body.scrollHeight,
            scrollTop: Math.round(body.scrollTop),
            overflowY: getComputedStyle(body).overflowY,
            clipHeight: Math.round(clip.height),
            lastBottom: lastBox === undefined ? null : Math.round(lastBox.bottom),
            clipBottom: Math.round(clip.bottom),
            lastVisibleInClip:
              lastBox === undefined
                ? null
                : lastBox.bottom <= clip.bottom + 1 && lastBox.top >= clip.top - 1,
          }
        })
      const before = await sampleScroll()
      // 滚到底（真实用户是滚轮/拖滚条；这里直接挪 scrollTop 读事实）
      await ctx.page.evaluate(() => {
        const body = document.querySelector('[data-panel="panel.sessions"]')
        if (body !== null) body.scrollTop = body.scrollHeight
      })
      await sleep(200)
      const after = await sampleScroll()
      ctx.stub.setSessionCount(2)
      return verdict(
        {
          rowsRendered: (before?.rows ?? 0) >= 20,
          // 关键：容器必须真的可滚（内容高 > 可视高 + overflow 允许滚动）
          scrollable:
            before !== null &&
            ['auto', 'scroll'].includes(before.overflowY) &&
            before.scrollHeight > before.clientHeight,
          scrollTopMoves: (after?.scrollTop ?? 0) > 0,
          // 滚到底后最后一行必须真的落在抽屉可见区内（用户"够不着"的就是这一条）
          lastRowReachable: after?.lastVisibleInClip === true,
        },
        { before, after },
        [
          '用户报「会话管理无法滚动」：面板体原本没有 flex/min-height/overflow 三件套，' +
            '内容被外层 overflow: hidden 裁掉且滚不动 —— 这条场景把它钉住。',
        ],
      )
    },
  },

  // ── 32. 折叠的轨迹必须能手动展开（点开后能再收起） ──
  {
    name: 'trace-toggle-folded',
    async run(ctx) {
      await fresh(ctx)
      await openFixtureSession(ctx)
      // 造一条**已收尾**的助手消息（思考 + 工具 + 正文）→ 收尾自动折叠
      ctx.stub.sendEvent(FIXTURE_OPEN_SESSION_ID, {
        type: 'reasoning',
        messageId: 'm-fold',
        round: 0,
        delta: '先读课表，再按科目分组。',
      })
      await sleep(120)
      ctx.stub.sendEvent(FIXTURE_OPEN_SESSION_ID, {
        type: 'tool',
        messageId: 'm-fold',
        round: 0,
        call: {
          id: 't-fold',
          name: 'read_file',
          state: 'success',
          input: { path: 'D:/课表.md' },
          outputSummary: '已读取',
        },
      })
      await sleep(120)
      ctx.stub.sendEvent(FIXTURE_OPEN_SESSION_ID, {
        type: 'text',
        messageId: 'm-fold',
        round: 0,
        delta: '整理完了。',
      })
      await sleep(120)
      ctx.stub.sendEvent(FIXTURE_OPEN_SESSION_ID, { type: 'done' })
      const head = '[data-action="chat.trace-toggle"]'
      // 先等收尾真的落定（`chat.trace-live` 变成 `chat.trace` = streaming 已被观察为 false），
      // 再考"手动展开/收起"这件事本身 —— 否则展开失败与折叠慢一拍会混在一起说不清
      await ctx.page.waitForFunction(
        () => document.querySelectorAll('[data-field="chat.trace"]').length === 1,
        { timeout: TIMEOUT },
      )
      await ctx.page.waitForSelector(head, { timeout: TIMEOUT })
      /** 读当前轨迹状态：不硬等，状态没变就让读数说话（超时也带读数回报告） */
      const readTrace = () =>
        ctx.page.evaluate(() => {
          const trace = document.querySelector('[data-field="chat.trace"]')
          const clip = trace?.querySelector('.trace-clip')
          return {
            expanded:
              trace
                ?.querySelector('[data-action="chat.trace-toggle"]')
                ?.getAttribute('aria-expanded') ?? null,
            clipHeight:
              clip === null || clip === undefined
                ? null
                : Math.round(clip.getBoundingClientRect().height),
            thinkingVisible: (trace?.querySelector('.thinking') ?? null) !== null,
            toolVisible: (trace?.querySelector('.tool-card') ?? null) !== null,
          }
        })
      // ⚠️ 状态机看 `aria-expanded`，**几何量必须等过渡走完**再量：轨迹容器是
      // `grid-template-rows: 0fr ↔ 1fr` 的 250ms 过渡，属性先变、高度后到 ——
      // 首版在属性变化那一刻量 clipHeight，读到的永远是中间值（93px），把"已折叠"判成没折。
      const settle = async (predicate) => {
        const reading = await waitForTraceState(readTrace, predicate)
        await sleep(400)
        return { ...reading, ...(await readTrace()) }
      }
      const collapsed = await settle((state) => state.expanded === 'false')
      // 点击展开（用户的真实路径）
      await ctx.page.click(head)
      const expanded = await settle((state) => state.expanded === 'true')
      // 再点一次收回：展开 / 收起两个方向都要真的生效
      await ctx.page.click(head)
      const recollapsed = await settle((state) => state.expanded === 'false')
      return verdict(
        {
          collapsedAfterDone: collapsed.expanded === 'false' && (collapsed.clipHeight ?? 99) <= 1,
          expandsOnClick:
            expanded.expanded === 'true' &&
            (expanded.clipHeight ?? 0) > 40 &&
            (expanded.clipHeight ?? 0) > (collapsed.clipHeight ?? 0) + 30,
          showsThinkingAndTools: expanded.thinkingVisible && expanded.toolVisible,
          collapsesAgain: recollapsed.expanded === 'false' && (recollapsed.clipHeight ?? 99) <= 1,
        },
        { collapsed, expanded, recollapsed },
        [
          '用户报「无法展开 Agent 折叠起来的对话」：展开状态用了普通 Set（Vue 不追踪），' +
            'toggle 改了状态却不重渲染 —— 这条场景把「点开能展开、再点能收回」两侧都钉住。',
        ],
      )
    },
  },

  // ── 31. 移动端单栏：设备栏是离屏抽屉 ──
  {
    name: 'mobile-single-column',
    viewport: 'mobile',
    async run(ctx) {
      await fresh(ctx)
      const railOf = () =>
        ctx.page.evaluate(() => {
          const rail = document.querySelector('[data-field="rail-container"]')
          if (rail === null) return null
          const rect = rail.getBoundingClientRect()
          const style = getComputedStyle(rail)
          return {
            left: Math.round(rect.left),
            width: Math.round(rect.width),
            opacity: style.opacity,
            pointerEvents: style.pointerEvents,
            transform: style.transform,
          }
        })
      const settledClosed = await ctx.page
        .waitForFunction(
          () => {
            const rail = document.querySelector('[data-field="rail-container"]')
            return rail !== null && getComputedStyle(rail).opacity === '0'
          },
          { timeout: 3000 },
        )
        .then(() => true)
        .catch(() => false)
      const hidden = await railOf()
      let clickPath = ''
      const button = await ctx.page.evaluate(() => {
        const node = document.querySelector('[data-action="console.open-rail-mobile"]')
        if (node === null) return null
        const rect = node.getBoundingClientRect()
        return {
          h: Math.round(rect.height),
          w: Math.round(rect.width),
          text: node.textContent.trim(),
        }
      })
      await ctx.page.click('[data-action="console.open-rail-mobile"]')
      await ctx.page
        .waitForFunction(
          () =>
            getComputedStyle(document.querySelector('[data-field="rail-container"]')).opacity ===
            '1',
          {
            timeout: 3000,
          },
        )
        .catch(() => undefined)
      const shown = await railOf()
      // 抽屉底色必须不透明（用户报「二级菜单透明无底色」）：移动端抽屉浮在消息流上，
      // 身后只有半透明 scrim —— 半透明填充令牌（--fill-1）会把底下消息透出来。
      // 量 computed background-color 的 alpha：抽屉开着才量（收起态读数无意义）。
      const drawerBg = await ctx.page.evaluate(() => {
        const node = document.querySelector('[data-field="rail-container"]')
        if (node === null) return null
        return getComputedStyle(node).backgroundColor
      })
      // 抽屉内容的可见/可点必须在**抽屉还开着**的这一刻量：会话一建出来抽屉就自动收起，
      // 那时外层 `pointer-events: none` 会继承到内层（读出来恒为 false —— 这是本探针
      // 第一版真实踩到的坑：量的是"收起后的展开体"）。
      const drawerContent = await ctx.page.evaluate(() => {
        const inner = document.querySelector('[data-panel="rail"]')
        if (inner === null) return null
        const style = getComputedStyle(inner)
        return {
          opacity: style.opacity,
          pointerEvents: style.pointerEvents,
          position: style.position,
        }
      })
      // 抽屉打开的这一刻抓一张（内容是否真的可见，只有图能一眼看出）；带主题后缀，
      // 免得两轮主题互相覆盖同一张图
      const drawerShot = join(ctx.outDir, `mobile-single-column-drawer-${ctx.theme}.png`)
      await ctx.page.screenshot({ path: drawerShot, fullPage: false }).catch(() => undefined)
      // 抽屉里点「新建会话」：移动端也要能真正建出会话（顺带验证打开会话后抽屉自动收起）
      // 先量一下这枚按钮的**命中事实**（位置 / 是否在视口内 / 该点上真正接事件的是谁）：
      // 坐标点按拿不到的话要能区分"被遮住"与"不在视口内"，否则只剩一句 TimeoutError
      const hit = await ctx.page.evaluate(() => {
        const node = document.querySelector('[data-action="rail.new-session"]')
        if (node === null) return null
        const rect = node.getBoundingClientRect()
        const x = rect.left + rect.width / 2
        const y = rect.top + rect.height / 2
        const top = document.elementFromPoint(x, y)
        const list = document.querySelector('.rail-list')
        const rails = [
          ...document.querySelectorAll('[data-field="rail-container"], [data-panel="rail"]'),
        ].map((node) => {
          const box = node.getBoundingClientRect()
          const style = getComputedStyle(node)
          return {
            className: String(node.className),
            rect: {
              left: Math.round(box.left),
              top: Math.round(box.top),
              w: Math.round(box.width),
              h: Math.round(box.height),
            },
            overflow: `${style.overflowX}/${style.overflowY}`,
            opacity: style.opacity,
            pointerEvents: style.pointerEvents,
            position: style.position,
          }
        })
        return {
          rect: {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          },
          viewport: { w: window.innerWidth, h: window.innerHeight },
          inViewport:
            rect.top >= 0 &&
            rect.bottom <= window.innerHeight &&
            rect.left >= 0 &&
            rect.right <= window.innerWidth,
          topElement:
            top === null
              ? null
              : `${top.tagName}.${String(top.className)}[${top.getAttribute('data-action') ?? ''}]`,
          topIsButton: top === node || (top !== null && node.contains(top)),
          stack: document
            .elementsFromPoint(x, y)
            .map((item) => `${item.tagName}.${String(item.className)}`),
          rails,
          listBox:
            list === null
              ? null
              : {
                  clientH: list.clientHeight,
                  scrollH: list.scrollHeight,
                  clientW: list.clientWidth,
                  scrollW: list.scrollWidth,
                },
        }
      })
      if (hit !== null && hit.topIsButton) {
        await ctx.page.click('[data-action="rail.new-session"]')
        clickPath = 'coordinate'
      } else if (hit !== null) {
        // 坐标点按拿不到：交给应用自己的事件（读数里保留"为什么坐标点按没走）
        await ctx.page.evaluate(() =>
          document.querySelector('[data-action="rail.new-session"]').click(),
        )
        clickPath = 'js-fallback'
      }
      // 要么出会话视图、要么空态里给出 createError —— 直接等 chat.messages 会把
      // "命令失败"这类原因丢进一句无信息量的 TimeoutError 里
      await ctx.page.waitForFunction(
        () =>
          document.querySelector('[data-field="chat.messages"]') !== null ||
          document.querySelector('.err') !== null,
        { timeout: TIMEOUT },
      )
      await sleep(400)
      const afterCreate = await ctx.page.evaluate(() => ({
        drawerOpen: document.querySelector('.rail.drawer-open') !== null,
        messages: document.querySelectorAll('[data-field="chat.messages"]').length,
        mobileTabs: document.querySelectorAll('.mobile-tabs').length,
        tabsHeight: Math.round(
          document.querySelector('.mobile-tabs')?.getBoundingClientRect().height ?? 0,
        ),
        createError: document.querySelector('.err')?.textContent?.trim() ?? '',
      }))
      return verdict(
        {
          offCanvasWhenClosed:
            settledClosed &&
            hidden !== null &&
            (hidden.left < 0 || Number(hidden.opacity) === 0) &&
            hidden.pointerEvents === 'none',
          toggleButton: button !== null && button.h >= 39.5,
          drawerOpens: shown !== null && Number(shown.opacity) === 1,
          // 「透明无底色」回归防线：抽屉底色必须完全不透明（rgb 无第四位 alpha 或 alpha === 1）
          drawerOpaque:
            drawerBg !== null &&
            (drawerBg.startsWith('rgb(') || drawerBg.includes(', 1)')) &&
            !drawerBg.includes('rgba('),
          sessionCreatedInDrawer: afterCreate.messages === 1,
          drawerAutoClosed: afterCreate.drawerOpen === false,
          // 打开抽屉后，里面的设备列表必须真的可见可点（这里的读数是"内层 ClientRail 根节点"）
          drawerContentInteractive:
            drawerContent !== null &&
            Number(drawerContent.opacity) > 0 &&
            drawerContent.pointerEvents !== 'none',
        },
        {
          hidden,
          settledClosed,
          button,
          shown,
          afterCreate,
          hit,
          drawerContent,
          drawerBg,
          clickPath,
          drawerShot,
          notes: ['移动端：移动标签栏被 grid 行高拉伸成巨型胶囊（tabsHeight 读数 + 截图可核对）'],
        },
      )
    },
  },
  // ── 34. 会话行模型下拉：显示生效模型并真的发 session.setModel（本轮 docs/06 §3） ──
  {
    name: 'panel-session-model',
    async run(ctx) {
      await fresh(ctx)
      await ensurePanelSessions(ctx.page)
      // 等配置切片就位：会话行的候选来自「生效 provider 的 modelList」，
      // 而它只能从 `config.get` 的脱敏回执拿到（与「模型」页签同一条链）。
      await ctx.page.waitForFunction(
        () => {
          const select = document.querySelector('[data-field="panel.session-model"]')
          return (
            (select !== null && !select.disabled && select.options.length >= 2) ||
            document.querySelector('[data-field="panel.error"]') !== null
          )
        },
        { timeout: TIMEOUT },
      )
      const before = await ctx.page.evaluate(() => {
        const selects = [...document.querySelectorAll('[data-field="panel.session-model"]')]
        const first = selects[0]
        return {
          count: selects.length,
          value: first?.value ?? '',
          firstOption: first?.options?.[0]?.textContent?.trim() ?? '',
          options: first === undefined ? [] : [...first.options].map((option) => option.value),
          panelError:
            document.querySelector('[data-field="panel.error"]')?.textContent?.trim() ?? '',
        }
      })
      // 「跟随全局（<全局模型>）」：未覆盖的会话必须显示这一条，而不是空白
      const followGlobal = before.value === '' && /^跟随全局/.test(before.firstOption)
      const candidates = before.options.includes('aurora-test-2')

      let sent = null
      if (candidates) {
        const since = ctx.stub.mark()
        await ctx.page.select('[data-field="panel.session-model"]', 'aurora-test-2')
        sent = await ctx.stub.waitForCommand('session.setModel', { since, timeout: 4000 })
      }
      // 成功后网页端乐观更新该行的 llm（session.list 的刷新会兜底）→ 下拉值应变成新模型
      const after = await ctx.page.evaluate(
        () => document.querySelector('[data-field="panel.session-model"]')?.value ?? '',
      )
      return verdict(
        {
          perRowSelect: before.count >= 1,
          followGlobalOption: followGlobal,
          candidatesFromProvider: candidates,
          commandSent: sent !== null,
          commandModel: sent !== null && sent.model === 'aurora-test-2',
          commandProvider: sent !== null && sent.providerId === 'p1',
          valueApplied: after === 'aurora-test-2',
        },
        { before, sent, after, followGlobal },
      )
    },
  },

  // ── 35. 提问卡进会话流 + 客户端结算后立即收起（本轮 docs/12 §5） ──
  {
    name: 'ask-in-stream',
    async run(ctx) {
      await fresh(ctx)
      // 打开夹具会话：这条提问的目标会话就是它 —— 卡应该出现在**流内**，
      // 而不是顶部待办栏（同一张卡不重复出现，见 PendingBar 的过滤规则）。
      await openFixtureSession(ctx)
      ctx.stub.sendAsk(askRequest('ask-stream-1'))
      await ctx.page.waitForSelector('[data-field="chat.ask-user-card"]', { timeout: TIMEOUT })

      const inStream = await ctx.page.evaluate(() => ({
        cards: document.querySelectorAll('[data-field="chat.ask-user-card"]').length,
        inThread: document.querySelectorAll('.thread [data-field="chat.ask-user-card"]').length,
        pendingBar: document.querySelectorAll('[data-panel="pending-bar"]').length,
        options: document.querySelectorAll('[data-action="chat.ask-option"]').length,
        progress: document.querySelectorAll('.ask-card .progress').length,
      }))

      // 客户端本地作答 → 服务器广播 ask.settled → 卡片原地切成只读
      ctx.stub.sendAskSettled({
        requestId: 'ask-stream-1',
        sessionId: FIXTURE_OPEN_SESSION_ID,
        outcome: 'answered',
        answers: ['科目资料文件夹'],
      })
      const settledVisible = await ctx.page
        .waitForSelector('[data-field="chat.ask-settled"]', { timeout: 3000 })
        .then(() => true)
        .catch(() => false)
      const after = await ctx.page.evaluate(() => ({
        settledLabel:
          document.querySelector('[data-field="chat.ask-settled"]')?.textContent?.trim() ?? '',
        answers: [...document.querySelectorAll('[data-field="chat.ask-answers"] .answer-chip')].map(
          (node) => node.textContent.trim(),
        ),
        // 只读卡不再渲染输入与按钮（留痕是"记录"，不是"待办"）
        inputs: document.querySelectorAll('[data-field="chat.ask-free"]').length,
        submit: document.querySelectorAll('[data-action="chat.ask-submit"]').length,
        cards: document.querySelectorAll('[data-field="chat.ask-user-card"]').length,
      }))
      return verdict(
        {
          cardInStream: inStream.cards === 1 && inStream.inThread === 1,
          notInPendingBar: inStream.pendingBar === 0,
          optionsRendered: inStream.options === 3,
          progressBar: inStream.progress === 1,
          settledShown: settledVisible && after.settledLabel === '已作答',
          answersKept: after.answers.includes('科目资料文件夹'),
          readOnlyAfterSettle: after.inputs === 0 && after.submit === 0,
          cardStaysAsRecord: after.cards === 1,
        },
        { inStream, after, settledLabel: after.settledLabel },
      )
    },
  },

  // ── 36. 文件页「发送到客户端」：选目标设备 → 发出 file.send（本轮 docs/12 §5） ──
  {
    name: 'files-send-to-client',
    async run(ctx) {
      await fresh(ctx)
      const uploaded = await ctx.stub.uploadFile({ name: '发给客户端.txt', content: 'fixture' })
      await ctx.page.evaluate(() => {
        window.location.hash = '#/files'
      })
      await ctx.page.waitForSelector('[data-panel="files-table"]', { timeout: TIMEOUT })

      const before = await ctx.page.evaluate(() => ({
        targets: document.querySelectorAll('[data-field="files.target-client"]').length,
        buttons: document.querySelectorAll('[data-action="files.send-to-client"]').length,
        sourceCell:
          document.querySelector('[data-field="files.source"]')?.textContent?.trim() ?? '',
      }))

      // 未选目标设备时按钮禁用（提示"先选设备"），选了之后才可点
      await ctx.page.select('[data-field="files.target-client"]', ctx.stub.clientId)
      const since = ctx.stub.mark()
      await ctx.page.click('[data-action="files.send-to-client"]')
      const sent = await ctx.stub.waitForCommand('file.send', { since, timeout: 4000 })
      // 客户端（桩机）回执后网页端给一条提示 —— 读 DOM 里出现过"已保存到客户端"即算送达
      const notice = await ctx.page
        .waitForFunction(() => (document.body.textContent ?? '').includes('已保存到客户端'), {
          timeout: 4000,
        })
        .then(() => true)
        .catch(() => false)

      return verdict(
        {
          targetPicker: before.targets === 1,
          sendButtons: before.buttons >= 1,
          sourceLabel: before.sourceCell === '客户端',
          commandSent: sent !== null,
          commandFileId: sent !== null && sent.fileId === uploaded.fileId,
          noticeShown: notice,
        },
        { before, sent, uploaded, notice },
      )
    },
  },

  // ── 37. 对话图片：实时事件 → data URL 懒加载，且本地路径不外泄 ──
  {
    name: 'message-images-live',
    async run(ctx) {
      await fresh(ctx)
      await openFixtureSession(ctx)
      ctx.stub.sendEvent(FIXTURE_OPEN_SESSION_ID, {
        type: 'tool',
        messageId: 'm-image-live',
        round: 0,
        call: {
          id: 't-image-live',
          name: 'show_image',
          state: 'success',
          input: { path: 'D:/secret/proof.png', caption: '最终效果' },
          outputSummary: '已展示图片',
          displayImages: [
            { id: 'img-live-1', name: 'proof.png', mime: 'image/png', caption: '最终效果' },
          ],
        },
      })
      ctx.stub.sendEvent(FIXTURE_OPEN_SESSION_ID, {
        type: 'text',
        messageId: 'm-image-live',
        round: 0,
        delta: '图片已生成。',
      })
      ctx.stub.sendEvent(FIXTURE_OPEN_SESSION_ID, { type: 'done' })
      const selector = '[data-field="chat.display-images"] img'
      const loaded = await ctx.page
        .waitForFunction(
          (target) => {
            const image = document.querySelector(target)
            return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
          },
          { timeout: TIMEOUT },
          selector,
        )
        .then(() => true)
        .catch(() => false)
      const reading = await ctx.page.evaluate((target) => {
        const image = document.querySelector(target)
        const text = document.body.textContent ?? ''
        const trace = document.querySelector('.assistant-body .trace')
        const markdown = document.querySelector('.assistant-body > [data-field="chat.markdown"]')
        return {
          count: document.querySelectorAll(target).length,
          naturalWidth: image instanceof HTMLImageElement ? image.naturalWidth : 0,
          caption: image?.closest('figure')?.querySelector('figcaption')?.textContent?.trim() ?? '',
          traceBeforeFinal:
            trace !== null &&
            markdown !== null &&
            trace.getBoundingClientRect().top <= markdown.getBoundingClientRect().top,
          finalBeforeImage:
            markdown !== null &&
            image !== null &&
            markdown.getBoundingClientRect().top <= image.getBoundingClientRect().top,
          duration: trace?.querySelector('.trace-duration')?.textContent?.trim() ?? '',
          leakedPath: text.includes('D:/secret/proof.png'),
        }
      }, selector)
      const readImage = await ctx.stub.waitForCommand('session.readImage', {
        timeout: 3000,
      })
      return verdict(
        {
          loaded,
          count: reading.count === 1,
          decoded: reading.naturalWidth > 0,
          caption: reading.caption === '最终效果',
          order: reading.traceBeforeFinal && reading.finalBeforeImage,
          totalDuration: reading.duration.includes('总用时'),
          commandSent: readImage?.imageId === 'img-live-1',
          noPathLeak: !reading.leakedPath,
        },
        { reading, readImage },
      )
    },
  },

  // ── 38. 对话图片历史回放：刷新后仍按 imageId 从客户端读取 ──
  {
    name: 'message-images-history',
    async run(ctx) {
      const history = fixtureHistoryMessages()
      history[1].toolCalls[0].displayImages = [
        { id: 'img-hist-1', name: 'report.png', mime: 'image/png', caption: '历史成果' },
      ]
      ctx.stub.history.set(FIXTURE_HISTORY_SESSION_ID, history)
      await fresh(ctx)
      await openFixtureSession(ctx, FIXTURE_HISTORY_SESSION_ID)
      const selector = '[data-field="chat.display-images"] img'
      const loaded = await ctx.page
        .waitForFunction(
          (target) => {
            const image = document.querySelector(target)
            return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
          },
          { timeout: TIMEOUT },
          selector,
        )
        .then(() => true)
        .catch(() => false)
      const readImage = await ctx.stub.waitForCommand('session.readImage', {
        timeout: 3000,
      })
      return verdict(
        {
          loaded,
          imageId: readImage?.imageId === 'img-hist-1',
        },
        { readImage },
      )
    },
  },

  // ── 39. HarmonyOS Sans：两端共享令牌与字体文件真的加载 ──
  {
    name: 'font-harmonyos',
    async run(ctx) {
      await fresh(ctx)
      const reading = await ctx.page.evaluate(async () => {
        await document.fonts.ready
        const ui = getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim()
        const mono = getComputedStyle(document.documentElement)
          .getPropertyValue('--font-mono')
          .trim()
        const loaded = Array.from(document.fonts).filter(
          (font) => font.family.includes('HarmonyOS') && font.status === 'loaded',
        )
        return {
          ui,
          mono,
          body: getComputedStyle(document.body).fontFamily,
          loaded: loaded.map((font) => font.family),
          fontStarts: getComputedStyle(document.body).fontFamily.startsWith('"HarmonyOS Sans"'),
        }
      })
      return verdict(
        {
          tokenHarmony: reading.ui.includes('HarmonyOS Sans'),
          monoPreserved: reading.mono.includes('Cascadia') || reading.mono.includes('monospace'),
          bodyHarmony: reading.fontStarts,
          fontLoaded: reading.loaded.length > 0,
        },
        { reading },
      )
    },
  },

  // ── 40. prefers-reduced-motion：共享兜底真的把过渡压到 1ms（本轮 docs/07 §5.3） ──
  {
    name: 'reduced-motion',
    async run(ctx) {
      await fresh(ctx)
      // 只保留 reduce 会**清掉** harness 设的 prefers-color-scheme，因此两个特征一起给
      await ctx.page.emulateMediaFeatures([
        { name: 'prefers-color-scheme', value: ctx.theme },
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ])
      const reading = await ctx.page.evaluate(() => {
        const root = getComputedStyle(document.documentElement)
        const body = getComputedStyle(document.body)
        return {
          matches: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
          durBase: root.getPropertyValue('--dur-base').trim(),
          durFast: root.getPropertyValue('--dur-fast').trim(),
          bodyTransition: body.transitionDuration,
          bodyAnimation: body.animationDuration,
        }
      })
      // 还原（同一主题下后续场景还要跑正常动效的判据）
      await ctx.page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: ctx.theme }])
      return verdict(
        {
          emulateApplied: reading.matches,
          tokensCollapsed: reading.durBase === '1ms' && reading.durFast === '1ms',
          // `* { transition-duration: 1ms !important }` 的兜底：body 上没有声明过渡也吃到了
          blanketTransition: reading.bodyTransition === '0.001s',
          blanketAnimation: reading.bodyAnimation === '0.001s',
        },
        { reading },
        ['time 场景只读令牌与计算值，不依赖观感：任一环失效都会让这四个读数至少一个不成立'],
      )
    },
  },
]

/** 主题断言：body 背景 = `--bg-base` 解析值，且 `prefers-color-scheme` 与预期一致 */
async function themeCheck(ctx, expected) {
  await fresh(ctx)
  const reading = await ctx.page.evaluate(() => {
    const token = getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim()
    const probe = document.createElement('div')
    probe.style.backgroundColor = 'var(--bg-base)'
    document.documentElement.appendChild(probe)
    const resolved = getComputedStyle(probe).backgroundColor
    probe.remove()
    return {
      token,
      resolved,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      matchesLight: window.matchMedia('(prefers-color-scheme: light)').matches,
    }
  })
  return verdict(
    {
      tokenPresent: reading.token !== '',
      schemeApplied: reading.matchesLight === (expected === 'light'),
      bodyMatchesToken: reading.resolved === reading.bodyBackground,
    },
    { reading, expected },
  )
}

/** 场景名 → 是否属于本次选择（`--only` 用子串匹配，桌面端 harness 同款语义） */
export function scenarioMatches(name, selectors) {
  if (selectors.length === 0) return true
  return selectors.some((selector) => name.includes(selector))
}

export { sleep, TIMEOUT }
