/**
 * 窗口截图核对工具（docs/07 §5；`AURORA_CAPTURE=<目录> pnpm dev`）。
 *
 * 为什么放在主进程：只有主进程能拿到 `BrowserWindow.webContents.capturePage()`，
 * 而且它截的是**真实窗口内容**（不依赖屏幕可见性 / 是否被别的窗口遮住），
 * 所以自动化验收能拿到和肉眼一致的 PNG，而不是靠"看上去没问题"。
 *
 * 三类动作，按顺序执行：
 * 1. `prepare()`：主进程侧准备（改窗口状态、切模式）；
 * 2. `act`：在目标窗口的**渲染层**里执行一段 JS —— 提示条的面板是悬停驱动的，
 *    只从主进程加宽窗口会拍到一个空窗口。`act` 让截图走真实的 hover / click 链路；
 * 3. `check`：截图后在渲染层取一份**可判定的结果**（DOM 命中测试、IPC 回执），
 *    与服务端的 `AURORA_SMOKE` 互补 —— 截图回答"长什么样"，check 回答"能不能点"。
 *
 * 设计取舍：
 * - 单窗失败只记日志、不中断整批 —— 截图是核对手段，不该因为某个窗口还没实现就全盘失败；
 * - 每个窗口之间留 `delayMs`（默认 700ms）让进场动画落位，否则会拍到过渡中间帧；
 * - 需要深链的窗口（设置页 `?page=`）用 reload 而不是新开窗口，避免堆一排窗口。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { Logger, WindowName } from '@aurora/shared'
import type { WindowManager } from './window-manager.js'

/** 设置页可深链的页面 id，需与 `renderer/settings/App.vue` 的 `PageId` 保持一致 */
export const SETTINGS_PAGE_IDS = ['general', 'modes', 'llm', 'skills', 'mcp', 'advanced'] as const

export type SettingsPageId = (typeof SETTINGS_PAGE_IDS)[number]

export interface CaptureTarget {
  name: WindowName
  /** 输出文件名（不含目录），默认 `<name>.png` */
  file?: string
  /** 需要深链时附带（如设置页 `{ page: 'llm' }`） */
  query?: Record<string, string>
  /** 截图前的主进程侧准备（展开提示条、切到某个模式等） */
  prepare?: () => Promise<void> | void
  /** 截图前在目标窗口渲染层执行的 JS（模拟 hover / click 等真实交互） */
  act?: string
  /** 截图后在目标窗口渲染层执行的 JS；返回值写入 `report.json` */
  check?: string
}

export interface CaptureOptions {
  dir: string
  targets: CaptureTarget[]
  manager: WindowManager
  logger?: Logger
  /** 每张截图前的等待（默认 700ms，等过渡动画结束） */
  delayMs?: number
}

export interface CaptureCheck {
  name: WindowName
  file: string
  /** `check` 脚本的返回值（未提供 check 时为空） */
  result?: unknown
  /** 该目标整体是否成功（截图写出 + check 无异常） */
  ok: boolean
  error?: string
}

export interface CaptureResult {
  dir: string
  files: string[]
  checks: CaptureCheck[]
  /** 是否存在 `pass === false` 的探针（主进程据此决定退出码，见 index.ts） */
  failed: boolean
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 截一张**非空**的图。
 *
 * `capturePage()` 在窗口刚 show 出来、合成器还没产出首帧时会返回空图（0 字节 PNG）。
 * 这类"截图命令成功、文件是空的"最难发现，所以这里重试几次，全空则明确报错。
 *
 * 注意**不要**用 `webContents.isLoading()` 做等待条件：dev 下设置窗口的 isLoading 会一直为 true
 * （实测每页白等 10s），页面其实早就渲染好了；等待交给 `manager.whenLoaded()`。
 */
async function captureNonEmpty(win: BrowserWindow, attempts = 4, gapMs = 600): Promise<Buffer> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const image = await win.webContents.capturePage()
    const png = image.toPNG()
    if (png.length > 0) return png
    await wait(gapMs)
  }
  throw new Error('capturePage 连续返回空图（窗口未渲染出内容）')
}

/**
 * 顺序截取多个窗口，返回写出的文件与 check 结果。
 *
 * 顺序执行而不是并发：`capturePage()` 依赖窗口已经渲染完成，
 * 多窗口同时 show 会让"谁在前台"变得不确定，截图内容也跟着不确定。
 */
export async function captureWindows(options: CaptureOptions): Promise<CaptureResult> {
  const { dir, targets, manager, logger } = options
  const delayMs = options.delayMs ?? 700
  await mkdir(dir, { recursive: true })

  const files: string[] = []
  const checks: CaptureCheck[] = []
  for (const target of targets) {
    const file = join(dir, target.file ?? `${target.name}.png`)
    try {
      // 1) 先把窗口建出来并等首次加载结束（否则紧接着的 reload 会把它打断成 ERR_ABORTED）；
      // 2) query 目标再 reload 一次带上深链参数；
      // 3) 后续页面复用同一个窗口，只走 reload。
      const win = manager.ensure(target.name)
      await manager.whenLoaded(target.name)
      if (target.query !== undefined) await manager.reload(target.name, target.query)
      await target.prepare?.()
      manager.show(target.name)
      // ensure() 里的加载是 fire-and-forget，必须显式等它结束（否则会截到空图）
      await manager.whenLoaded(target.name)
      if (target.act !== undefined) {
        await wait(60)
        await win.webContents.executeJavaScript(target.act, true)
      }
      await wait(delayMs)
      const png = await captureNonEmpty(win)
      await writeFile(file, png)
      files.push(file)
      logger?.info('窗口截图已写出', { window: target.name, file, bytes: png.length })

      const result =
        target.check === undefined
          ? undefined
          : await win.webContents.executeJavaScript(target.check, true)
      checks.push({ name: target.name, file, result, ok: true })
    } catch (error) {
      logger?.warn('窗口截图失败', { window: target.name, error: String(error) })
      checks.push({ name: target.name, file, ok: false, error: String(error) })
    }
  }
  return {
    dir,
    files,
    checks,
    failed: checks.some((item) => (item.result as { pass?: unknown } | undefined)?.pass === false),
  }
}

/**
 * 渲染层探针脚本。
 *
 * 都写成"立即执行的表达式"字符串：`executeJavaScript` 需要返回值（而不是 undefined），
 * 且必须自带 try/catch —— 抛错会让整张截图算失败，而探针本身只是想说明状态。
 */

/** 模拟鼠标移入提示条（真实 hover 链路：120ms 后 IPC 加宽窗口 + 挂载面板） */
export const EDGE_BAR_HOVER_SCRIPT = `(() => {
  try {
    const el = document.querySelector('.edge')
    if (!el) return { hovered: false, reason: 'no .edge' }
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
    return { hovered: true }
  } catch (error) {
    return { hovered: false, reason: String(error) }
  }
})()`

/** 模拟鼠标移出提示条（面板淡出 → 窗口收回 8px） */
export const EDGE_BAR_LEAVE_SCRIPT = `(() => {
  try {
    const el = document.querySelector('.edge')
    if (!el) return { left: false, reason: 'no .edge' }
    el.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }))
    return { left: true }
  } catch (error) {
    return { left: false, reason: String(error) }
  }
})()`

/**
 * 点击竖条 → 应呼出完整交互窗（回归「点击无法呼出交互窗」）。
 * 直接 `.click()` 走的是真实 DOM 点击 → Vue handler → IPC → 主进程 show。
 */
export const EDGE_BAR_CLICK_SCRIPT = `(async () => {
  try {
    const el = document.querySelector('.strip')
    if (!el) return { clicked: false, reason: 'no .strip' }
    el.click()
    await new Promise((resolve) => setTimeout(resolve, 500))
    const state = await window.aurora.window.getState()
    if (!state.ok) return { clicked: true, stateOk: false, message: state.message }
    return {
      clicked: true,
      stateOk: true,
      chatVisible: state.value.visible['chat'] === true,
      miniChatVisible: state.value.visible['mini-chat'] === true,
      primary: state.value.primary,
      pass:
        state.value.visible['chat'] === true &&
        state.value.visible['mini-chat'] !== true &&
        state.value.primary === 'chat',
    }
  } catch (error) {
    return { clicked: false, reason: String(error), pass: false }
  }
})()`

/**
 * 面板可用性探针：面板是否挂载、四个按钮是否**真的能被点到**
 * （`elementFromPoint` 命中测试）且完全落在窗口宽度内。
 *
 * 这一条是「侧边栏点击无效」这类 bug 的关键断言：DOM 里存在按钮 ≠ 用户点得到。
 */
export const EDGE_BAR_PANEL_SCRIPT = `(() => {
  try {
    const panel = document.querySelector('.panel')
    if (!panel) return { panel: false }
    const width = document.documentElement.clientWidth
    const buttons = Array.from(panel.querySelectorAll('.actions button'))
    const probes = buttons.map((button) => {
      const rect = button.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return {
        label: (button.textContent || '').trim(),
        hit: hit === button || button.contains(hit),
        hitTag: hit === null ? 'null' : hit.tagName.toLowerCase() + '.' + String(hit.className),
        insideWindow: rect.left >= 0 && rect.right <= width + 1,
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
      }
    })
    return {
      panel: true,
      windowWidth: width,
      windowHeight: document.documentElement.clientHeight,
      styled: getComputedStyle(panel).width,
      buttonCount: buttons.length,
      probes,
      allClickable: probes.length > 0 && probes.every((p) => p.hit && p.insideWindow),
      pass:
        buttons.length === 4 &&
        width <= 228 &&
        probes.every((p) => p.hit && p.insideWindow && p.width > 0),
    }
  } catch (error) {
    return { panel: false, reason: String(error), pass: false }
  }
})()`

/**
 * 对话自动滚底探针（交互窗 / 小窗共用）。
 *
 * 钉住的是「新消息不会自动拉到最新」这个 bug：滚动容器是窗口的 `.thread`，
 * 内容变高时渲染层必须自己滚到底。这里不去驱动真实模型（截图跑在默认配置上，
 * 没有可用的 LLM），而是向 `.messages` 追加一个 1600px 的探针节点 ——
 * 对滚动逻辑而言与「新消息 / 流式增量把内容撑高」完全等价。
 *
 * 两个必须注意的点（都踩过）：
 * - 探针节点要 `flex-shrink: 0`：`.messages` 是 `.thread`（固定高）的 flex 子项，
 *   一个没有内容的空 div 会被压扁回窗口高度，探针就变成"没有可滚动内容"的空转断言。
 *   真实消息是有文字的，`min-height: auto` 不会让它被压掉，所以这里显式禁掉收缩。
 * - `pass` 里带 `maxScroll >= 200` 守卫：先确认"内容确实比窗口高"，再看"是否滚到了底"，
 *   否则一旦探针没撑开内容，`distance === 0` 会假 PASS。
 *
 * 同一条探针还顺带核对「回到最新」胶囊（用户主动上滚后才出现的入口）：
 * 把 `scrollTop` 归零模拟上滚，断言胶囊出现且**落在滚动容器可视区内**。
 * `position: sticky` 在交互窗那种"`.messages` 盒子被钉住、内容按溢出渲染"的布局里
 * 未必吸附得住，这条断言就是钉这个的。
 *
 * 放在 `check` 里（截图**之后**执行），所以不会出现在 PNG 中；执行完立刻移除节点。
 */
export const CHAT_AUTO_SCROLL_SCRIPT = `(async () => {
  try {
    const thread = document.querySelector('.thread')
    const list = document.querySelector('.messages')
    if (thread === null || list === null) {
      return { pass: false, reason: 'no .thread/.messages' }
    }
    const filler = document.createElement('div')
    filler.setAttribute('data-probe', 'auto-scroll')
    filler.style.height = '1600px'
    filler.style.flexShrink = '0'
    list.appendChild(filler)
    await new Promise((resolve) => setTimeout(resolve, 150))
    const maxScroll = Math.round(thread.scrollHeight - thread.clientHeight)
    const scrolled = Math.round(thread.scrollTop)
    const distance = maxScroll - scrolled
    const scrollHeight = Math.round(thread.scrollHeight)
    const clientHeight = thread.clientHeight
    // 2) 「回到最新」胶囊：模拟用户主动上滚 → 必须出现，且吸附在可视区内（可点）
    thread.scrollTop = 0
    await new Promise((resolve) => setTimeout(resolve, 200))
    const button = list.querySelector('.jump-latest')
    const rect = button === null ? null : button.getBoundingClientRect()
    const threadRect = thread.getBoundingClientRect()
    const jump = {
      present: button !== null,
      top: rect === null ? null : Math.round(rect.top),
      bottom: rect === null ? null : Math.round(rect.bottom),
      inView:
        rect !== null &&
        rect.height > 0 &&
        rect.top >= threadRect.top - 1 &&
        rect.bottom <= threadRect.bottom + 1,
    }
    filler.remove()
    thread.scrollTop = 0
    return {
      pass: maxScroll >= 200 && distance <= 4 && jump.present && jump.inView,
      scrollable: maxScroll >= 200,
      distance,
      scrolled,
      maxScroll,
      scrollHeight,
      clientHeight,
      jump,
    }
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

/**
 * 设置页门控探针（docs/08 §6.1）：每个控件带 `data-field="<配置路径>"`，
 * 条件不成立时**整个控件不在 DOM 里**（不是 disabled、也不是靠 CSS 藏），位置改为 `data-empty` 说明块。
 *
 * 这一条钉住的是用户原话里的第三个诉求：「用户无法设置的内容不要显示」。
 */
export const SETTINGS_FIELDS_SCRIPT = `(() => {
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const emptyStates = Array.from(document.querySelectorAll('[data-empty]')).map((el) =>
      el.getAttribute('data-empty'),
    )
    const classroomFields = count('[data-field^="modes.classroom"]')
    const languageFields = count('[data-field="general.language"]')
    const edgeBarToggle = count('[data-field="general.edgeBar.enabled"]')
    const edgeBarDetail = count(
      '[data-field="general.edgeBar.opacity"],[data-field^="general.edgeBar.quietHours"]',
    )
    const activeMode = document.querySelector('.cards .card.active .card-head strong')
    const activeNav = document.querySelector('.nav-item.active')
    return {
      page: activeNav === null ? 'unknown' : (activeNav.textContent || '').trim(),
      classroomFields,
      languageFields,
      edgeBarToggle,
      edgeBarDetail,
      activeMode: activeMode === null ? null : (activeMode.textContent || '').trim(),
      emptyStates,
      // 死字段（general.language）在任何页面都不该出现；提示条详情跟着开关走
      pass:
        languageFields === 0 &&
        (edgeBarToggle === 0 ? edgeBarDetail === 0 : edgeBarDetail > 0),
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/** 把模式切到 Work（未选中 ClassRoom 时不应出现任何 classroom 控件） */
export const SETTINGS_SWITCH_TO_WORK_SCRIPT = `(() => {
  try {
    const cards = Array.from(document.querySelectorAll('.cards .card'))
    const target = cards.find((card) =>
      ((card.querySelector('.card-head strong') || {}).textContent || '').toLowerCase().includes('work'),
    )
    if (target === undefined) return { switched: false, reason: 'no work card' }
    const button = Array.from(target.querySelectorAll('button')).find(
      (item) => (item.textContent || '').trim() === '启用',
    )
    if (button === undefined) return { switched: false, reason: 'no enable button (already active?)' }
    button.click()
    return { switched: true }
  } catch (error) {
    return { switched: false, reason: String(error) }
  }
})()`

/**
 * 切到非 ClassRoom 模式后：classroom 字段必须为 0，并出现「暂无可配置项」空状态。
 * 这条是 step-06 的核心验收，靠真实 DOM 而不是"看代码应该有 v-if"。
 */
export const SETTINGS_CLASSROOM_GATING_SCRIPT = `(() => {
  try {
    const classroomFields = document.querySelectorAll('[data-field^="modes.classroom"]').length
    const empty = document.querySelector('[data-empty^="modes."]')
    const active = document.querySelector('.cards .card.active .card-head strong')
    return {
      classroomFields,
      emptyState: empty === null ? null : empty.getAttribute('data-empty'),
      activeMode: active === null ? null : (active.textContent || '').trim(),
      pass: classroomFields === 0 && empty !== null,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 真实写盘探针（step-06 拆分 `ClassroomSection` 后最容易踩的坑）：
 * `settings:update` 只做**顶层浅合并**，子组件若直接传 `{ classroom: change }` 会静默丢字段。
 *
 * 走完整的用户路径：展开「分类行为」分组 → 点 `classification.autoMove` 复选框 →
 * 经组件的 `patch()` → IPC → `SettingsStore` 落盘。前后快照在渲染层暂存，由 check 比对。
 */
export const SETTINGS_CLASSROOM_PATCH_ACT = `(async () => {
  const record = (value) => {
    window.__auroraPatchProbe = Object.assign(window.__auroraPatchProbe || {}, { act: value })
    return value
  }
  try {
    const state = await window.aurora.settings.get()
    if (!state.ok) return record({ ok: false, reason: 'settings.get failed' })
    window.__auroraPatchProbe = { before: state.value.modes.classroom }
    const heads = Array.from(document.querySelectorAll('.group-head'))
    if (heads.length < 4) return record({ ok: false, reason: 'group heads=' + heads.length })
    heads[3].click()
    await new Promise((resolve) => setTimeout(resolve, 600))
    const field = document.querySelector('[data-field="modes.classroom.classification.autoMove"]')
    const box = field === null ? null : field.querySelector('input[type="checkbox"]')
    if (box === null) return record({ ok: false, reason: 'no autoMove checkbox' })
    box.click()
    await new Promise((resolve) => setTimeout(resolve, 900))
    return record({ ok: true, checked: box.checked })
  } catch (error) {
    return record({ ok: false, reason: String(error) })
  }
})()`

export const SETTINGS_CLASSROOM_PATCH_CHECK = `(async () => {
  try {
    const probe = window.__auroraPatchProbe
    if (probe === undefined) return { pass: false, reason: 'act 未记录 before 快照' }
    const state = await window.aurora.settings.get()
    if (!state.ok) return { pass: false, reason: 'settings.get failed' }
    const before = probe.before
    const now = state.value.modes.classroom
    const lostKeys = Object.keys(before).filter((key) => !(key in now))
    const scheduleKept = JSON.stringify(before.schedule) === JSON.stringify(now.schedule)
    const subjectsKept = JSON.stringify(before.subjects) === JSON.stringify(now.subjects)
    const toggled = before.classification.autoMove !== now.classification.autoMove
    return {
      act: probe.act === undefined ? null : probe.act,
      lostKeys,
      scheduleKept,
      subjectsKept,
      toggled,
      autoMove: now.classification.autoMove,
      pass: lostKeys.length === 0 && scheduleKept && subjectsKept && toggled,
    }
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

/**
 * 思考等级探针 · 前半（step-02）：走真实用户路径把「思考等级」写进配置。
 *
 * 截图用的是**隔离 userData**（`index.ts` 的 `AURORA_CAPTURE` 分支），起步时一个
 * provider 都没有，所以先经 `settings.update` 造一个带 `reasoningEffort: 'high'` 的；
 * 等 `settings:changed` 推送把卡片画出来，再点开第一张卡片上的 `.more`
 * （「高级参数与连接测试」）—— 下拉只在折叠区展开后才在 DOM 里。
 */
export const SETTINGS_LLM_EFFORT_ACT = `(async () => {
  try {
    const state = await window.aurora.settings.get()
    if (!state.ok) return { ok: false, reason: 'settings.get failed' }
    if (Object.keys(state.value.llm.providers).length === 0) {
      const result = await window.aurora.settings.update({
        llm: {
          active: 'capture',
          providers: {
            capture: {
              type: 'openai-compat',
              baseUrl: 'https://api.deepseek.com/v1',
              apiKeyEnc: '',
              model: 'deepseek-chat',
              temperature: 0.7,
              reasoningEffort: 'high',
            },
          },
        },
      })
      if (!result.ok) return { ok: false, reason: result.message }
      await new Promise((resolve) => setTimeout(resolve, 600))
    }
    const more = document.querySelector('.more')
    if (more === null) return { ok: false, reason: 'no .more' }
    more.click()
    await new Promise((resolve) => setTimeout(resolve, 600))
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`

/**
 * 思考等级探针 · 后半：确认「写盘 → 回读 → 渲染」整条链路通了。
 *
 * 只数 DOM 不够（一个写死的 `<select>` 也能数出来），所以要读下拉的**当前值**：
 * 它来自刚持久化的配置，`'high'` 才对得上。
 */
export const SETTINGS_LLM_EFFORT_CHECK = `(() => {
  try {
    const effortFields = document.querySelectorAll('[data-field$=".reasoningEffort"]')
    const temperatureFields = document.querySelectorAll('[data-field$=".temperature"]')
    const first = effortFields[0]
    const select = first === undefined ? null : first.querySelector('select')
    const value = select === null ? null : select.value
    return {
      effortFields: effortFields.length,
      temperatureFields: temperatureFields.length,
      value,
      pass: effortFields.length > 0 && temperatureFields.length > 0 && value === 'high',
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 默认截图清单：五个窗口 + 提示条两态 + 设置页各页深链 + 四条 DOM 断言。
 * `AURORA_CAPTURE_WINDOWS` 可以只截其中一部分（逗号分隔）。
 */
export function defaultCapturePlan(manager: WindowManager): CaptureTarget[] {
  const plan: CaptureTarget[] = [
    { name: 'edge-bar', file: 'edge-bar.png' },
    {
      name: 'edge-bar',
      file: 'edge-bar-expanded.png',
      act: EDGE_BAR_HOVER_SCRIPT,
      check: EDGE_BAR_PANEL_SCRIPT,
    },
    // 交互窗 / 小窗各带一条自动滚底断言（回归「对话不会自动拉到最新」）
    { name: 'chat', file: 'chat.png', check: CHAT_AUTO_SCROLL_SCRIPT },
    { name: 'mini-chat', file: 'mini-chat.png', check: CHAT_AUTO_SCROLL_SCRIPT },
    { name: 'onboarding', file: 'onboarding.png' },
  ]
  for (const page of SETTINGS_PAGE_IDS) {
    plan.push({
      name: 'settings',
      file: `settings-${page}.png`,
      query: { page },
      // 「常规」页是 `general.*` 门控的现场：死字段 general.language 必须为 0，
      // 提示条透明度 / 静默时段要跟着 general.edgeBar.enabled 出现或消失
      check: page === 'general' ? SETTINGS_FIELDS_SCRIPT : undefined,
    })
  }
  // 思考等级（step-02）：造一个 provider → 展开「高级参数」→ 断言下拉真值来自配置。
  // 刻意放在 SETTINGS_PAGE_IDS 循环**之外**：塞进循环会让每个设置页都多点一次。
  plan.push({
    name: 'settings',
    file: 'settings-llm-params.png',
    query: { page: 'llm' },
    act: SETTINGS_LLM_EFFORT_ACT,
    check: SETTINGS_LLM_EFFORT_CHECK,
  })
  // 设置页门控断言：classroom 配置在；切到 Work 后 classroom 配置必须消失
  plan.push({
    name: 'settings',
    file: 'settings-modes-classroom-gating.png',
    query: { page: 'modes' },
    check: SETTINGS_FIELDS_SCRIPT,
  })
  // 真实写盘：改一个 classroom 字段后其它字段不能丢（浅合并语义回归）。
  // 必须排在「切到 Work」之前 —— 切走之后 classroom 控件就不在 DOM 里了。
  plan.push({
    name: 'settings',
    file: 'settings-classroom-patch.png',
    query: { page: 'modes' },
    act: SETTINGS_CLASSROOM_PATCH_ACT,
    check: SETTINGS_CLASSROOM_PATCH_CHECK,
  })
  plan.push({
    name: 'settings',
    file: 'settings-modes-work-gating.png',
    query: { page: 'modes' },
    act: SETTINGS_SWITCH_TO_WORK_SCRIPT,
    check: SETTINGS_CLASSROOM_GATING_SCRIPT,
  })
  // 收尾两件事：面板收起（不留展开态）、点击竖条能呼出交互窗（回归 line 1 的 bug）
  plan.push({
    name: 'edge-bar',
    file: 'edge-bar-collapsed-final.png',
    act: EDGE_BAR_LEAVE_SCRIPT,
    prepare: () => {
      manager.setEdgeBarExpanded(false)
    },
  })
  plan.push({
    name: 'edge-bar',
    file: 'edge-bar-after-click.png',
    act: EDGE_BAR_CLICK_SCRIPT,
    check: EDGE_BAR_CLICK_SCRIPT,
  })
  return plan
}

/** 按 `AURORA_CAPTURE_WINDOWS` 过滤清单；未设置或为空表示全选。 */
export function filterCapturePlan(
  plan: CaptureTarget[],
  requested: string | undefined,
): CaptureTarget[] {
  const names = (requested ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
  if (names.length === 0) return plan
  return plan.filter((target) => names.includes(target.name))
}
