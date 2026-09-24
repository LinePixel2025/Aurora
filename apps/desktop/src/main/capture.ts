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
export const SETTINGS_PAGE_IDS = [
  'general',
  'modes',
  'llm',
  'tts',
  'skills',
  'mcp',
  'agent',
  'advanced',
] as const

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
    // 判定要同时覆盖两种情况：探针明确返回 `pass:false`，以及**探针根本没跑起来**
    //（`executeJavaScript` 抛错 / 元素没拿到而提前 return → `result` 为 `undefined`）。
    // 只看后者 `pass === false` 的话，这类「静默丢一条」会以退出码 0 结束。
    failed: checks.some(
      (item) =>
        item.ok === false || (item.result as { pass?: unknown } | undefined)?.pass === false,
    ),
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
    if (!el) return { clicked: false, reason: 'no .strip', pass: false }
    el.click()
    await new Promise((resolve) => setTimeout(resolve, 500))
    const state = await window.aurora.window.getState()
    if (!state.ok) {
      // 拿不到状态不能算通过：这条探针存在的意义就是断言状态（早退分支必须带 pass:false）
      return { clicked: true, stateOk: false, message: state.message, pass: false }
    }
    return {
      clicked: true,
      stateOk: true,
      chatVisible: state.value.visible['chat'] === true,
      primary: state.value.primary,
      // 主对话窗口只剩交互窗：呼出后 primary 必须是 'chat'（注意：本段在模板字符串里，注释不能带反引号）
      pass: state.value.visible['chat'] === true && state.value.primary === 'chat',
    }
  } catch (error) {
    return { clicked: false, reason: String(error), pass: false }
  }
})()`

/**
 * 面板可用性探针：面板是否挂载、三个按钮是否**真的能被点到**
 * （`elementFromPoint` 命中测试）且完全落在窗口宽度内。
 *
 * 这一条是「侧边栏点击无效」这类 bug 的关键断言：DOM 里存在按钮 ≠ 用户点得到。
 */
export const EDGE_BAR_PANEL_SCRIPT = `(() => {
  try {
    const panel = document.querySelector('.panel')
    // 面板没挂载正是这条探针要防的故障，必须 pass:false（早退分支不能静默）
    if (!panel) return { panel: false, pass: false, reason: 'no .panel' }
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
        buttons.length === 3 &&
        width <= 228 &&
        probes.every((p) => p.hit && p.insideWindow && p.width > 0),
    }
  } catch (error) {
    return { panel: false, reason: String(error), pass: false }
  }
})()`

/**
 * 对话自动滚底探针（交互窗专用）。
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
 * 「收起 = 直接消失」探针（step-01）：点交互窗头部操作区的「收起」按钮，再断言窗口真的没了。
 *
 * 这一条钉住的是一个已修掉的 bug：原来的「收起」会**另外弹出一个快速对话窗口**
 * （`close()` 里调的是那条已被删除的「显示快速对话」IPC 通道），用户按「收起」却看到多出一个窗口。
 * 现在它必须等价于 `windowStore.hide('chat')`。
 *
 * ⚠️ 为什么**点击写在 check 里、而不是 `act` 里**（与 step-01 原计划不同，实测后改的）：
 * `act` 在截图**之前**跑（见 `captureWindows` 的顺序 show → act → wait → capturePage）。
 * 窗口一旦被真的 `hide()`，紧接着的 `capturePage()` 在 Windows 上**永不返回**——表现为
 * 整个 `AURORA_CAPTURE` 流程卡死、进程不退出、`report.json` 写不出来（实测 8 分钟无进展，已复现）。
 * 所以截图必须发生在窗口仍然可见的时候；而「点完之后窗口是否真的消失」由这条 check 断言，
 * 它跑在截图之后，点击与断言的因果链仍然是真实的（按钮 → Vue handler → IPC → 主进程 hide）。
 * 因此 `chat-collapse.png` 拍到的是**点之前的交互窗**（含那颗「收起」按钮），
 * 「收起后窗口消失」这件事由本探针的 `pass` 负责，不靠截图。
 *
 * 按文本找按钮而不是按 class：`.head-actions` 里的按钮是同一个 `AppButton` 渲染的，只有文案能区分；
 * 找不到时把实际文案回传（而不是静默成功），否则改了文案会让这条断言变成空转。
 *
 * `primary === null` 是关键：残留的 `primary` 说明「隐藏」被实现成了「换成另一个主窗口」。
 * `getState()` 带 4s 超时兜底：窗口隐藏后渲染层可能被降频，万一读不回来也不能把整轮截图拖死。
 */
export const CHAT_COLLAPSE_CHECK = `(async () => {
  try {
    const actions = document.querySelector('.head-actions')
    if (actions === null) return { pass: false, reason: 'no .head-actions' }
    const buttons = Array.from(actions.querySelectorAll('button'))
    const button = buttons.find((item) => (item.textContent || '').trim() === '收起')
    if (button === undefined) {
      return {
        pass: false,
        reason: 'no 收起 button',
        labels: buttons.map((item) => (item.textContent || '').trim()),
      }
    }

    button.click()
    await new Promise((resolve) => setTimeout(resolve, 600))

    const state = await Promise.race([
      window.aurora.window.getState(),
      new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
    ])
    if (state === null) {
      return { pass: false, reason: 'window.getState 超时（窗口隐藏后渲染层被降频？）' }
    }
    if (!state.ok) return { pass: false, state, reason: state.message }
    const visible = state.value.visible
    const primary = state.value.primary
    return {
      pass: visible['chat'] !== true && primary === null,
      clicked: true,
      label: (button.textContent || '').trim(),
      chatVisible: visible['chat'] === true,
      primary,
      state,
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

/**
 * 「电脑操控」设置页门控探针（docs/08 §6.1、step 5）。
 *
 * 与 `SETTINGS_FIELDS_SCRIPT` 同一套路：`data-field` 计数 + `data-empty` 列表，
 * 但这里要额外读**总开关的实际状态**——`agent.tools.enabled` 为 false 时三个分栏控件
 * 本来就该整块消失（只剩总开关与工作目录两个常显字段）。
 */
export const SETTINGS_AGENT_FIELDS_SCRIPT = `(() => {
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const toggle = document.querySelector('[data-field="agent.tools.enabled"] input[type="checkbox"]')
    const enabled = toggle === null ? null : toggle.checked
    const total = count('[data-field^="agent.tools"]')
    const terminalFields = count('[data-field^="agent.tools.terminal"]')
    const filesFields = count('[data-field^="agent.tools.files"]')
    const openFields = count('[data-field^="agent.tools.open"]')
    const emptyStates = Array.from(document.querySelectorAll('[data-empty]')).map((el) =>
      el.getAttribute('data-empty'),
    )
    const activeNav = document.querySelector('.nav-item.active')
    return {
      page: activeNav === null ? 'unknown' : (activeNav.textContent || '').trim(),
      togglePresent: toggle !== null,
      enabled,
      total,
      terminalFields,
      filesFields,
      openFields,
      emptyStates,
      // 总开关必须在（否则用户再也开不回来）；开着时三个分栏的详情字段都得在
      pass:
        toggle !== null &&
        (enabled !== true ||
          (terminalFields > 0 && filesFields > 0 && openFields > 0 && emptyStates.length === 0)),
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 「语音」设置页门控探针（docs/08 §6.1、step 5）。
 *
 * 与 `SETTINGS_AGENT_FIELDS_SCRIPT` 同一套路。**常显字段与列表空态是两件事，别混**：
 * - `tts.enabled` / `tts.autoRead` / `tts.maxChars` 都是**常显**的
 *   （总开关关掉也要能开回来；后两个是「语音」页的固定设置项，与有没有模型无关），
 *   三种状态下都必须存在 —— 它们**不**参与二选一。
 * - provider 列表为空时**多出来**的断言只有一个：`data-empty="tts.providers"` 必须在
 *   （空状态卡整块替换列表）；列表非空时反过来，空状态必须消失。
 *
 * ⚠️ 首版曾把 `autoRead` / `maxChars` 写进二选一（「列表为空 → 这两个必须为 0」），
 * 与 step-05「常显区」的要求自相矛盾，导致空列表下 `pass` **永远为 false**（实测抓到）。
 *
 * 「列表是否为空」的判据用**两个信号取或**（`emptyStates` 含 `tts.providers`，或存在
 * `tts.providers.<id>` 行容器）并把用到的判据回传在 `listState` 字段里 ——
 * 只认其中一个的话，页面把空状态从 `data-empty` 改成别的写法就会让探针假 FAIL。
 * 行容器的判定与 `SETTINGS_LLM_STRUCTURE_CHECK` 同构：`data-field` 以
 * `tts.providers.` 开头、且**后面不再有点**（卡内字段多一层，不会被算成行）。
 */
export const SETTINGS_TTS_FIELDS_SCRIPT = `(() => {
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const toggle = document.querySelector('[data-field="tts.enabled"] input[type="checkbox"]')
    const emptyStates = Array.from(document.querySelectorAll('[data-empty]')).map((el) =>
      el.getAttribute('data-empty'),
    )
    const providersEmpty = emptyStates.indexOf('tts.providers') !== -1
    const providerRows = Array.from(document.querySelectorAll('[data-field]')).filter((el) => {
      const value = el.getAttribute('data-field') || ''
      return value.indexOf('tts.providers.') === 0 && value.slice('tts.providers.'.length).indexOf('.') === -1
    }).length
    // 两个信号取或：任一成立都算「列表非空」；都看到空状态 / 都没有行才按空处理
    const listEmpty = providersEmpty || providerRows === 0
    const listState = providersEmpty ? 'empty-state' : providerRows > 0 ? 'rows' : 'neither'
    const autoReadFields = count('[data-field="tts.autoRead"]')
    const maxCharsFields = count('[data-field="tts.maxChars"]')
    const activeNav = document.querySelector('.nav-item.active')
    return {
      page: activeNav === null ? 'unknown' : (activeNav.textContent || '').trim(),
      togglePresent: toggle !== null,
      enabled: toggle === null ? null : toggle.checked,
      providerFields: count('[data-field^="tts.providers"]'),
      providerRows,
      autoReadFields,
      maxCharsFields,
      emptyStates,
      // 用的是哪条判据（排查假 FAIL 时先看它）
      listState,
      listEmpty,
      // 总开关与 autoRead / maxChars 都是**常显字段**（关掉就再也开不回来），
      // 因此三种列表状态下都必须存在 —— 它们**不**参与列表空/非空的二选一。
      // 空列表唯一多出来的断言是：data-empty 必须含 'tts.providers'。
      pass:
        toggle !== null &&
        autoReadFields > 0 &&
        maxCharsFields > 0 &&
        (listEmpty ? providersEmpty : !providersEmpty),
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
    // 与「对话窗思考等级」探针共用一份配置，两个场景谁先跑都要能自足：
    // 所以不是「没有 provider 才造」，而是「当前 provider 的 reasoningEffort 不是 high 就写成 high」。
    const providers = state.value.llm.providers
    const active = state.value.llm.active !== '' ? state.value.llm.active : 'capture'
    const existing = providers[active]
    // 记下原值：check 阶段要写回，避免把 'high' 永久留在配置里（本场景在真实 userData 下也会被跑）
    window.__auroraEffortSettingsProbe = {
      active,
      before: existing === undefined ? 'auto' : existing.reasoningEffort,
    }
    if (existing === undefined || existing.reasoningEffort !== 'high') {
      const result = await window.aurora.settings.update({
        llm: {
          active,
          providers: {
            ...providers,
            [active]: {
              type: 'openai-compat',
              baseUrl: 'https://api.deepseek.com/v1',
              apiKeyEnc: '',
              model: 'deepseek-chat',
              temperature: 0.7,
              ...(existing ?? {}),
              reasoningEffort: 'high',
            },
          },
        },
      })
      if (!result.ok) return { ok: false, reason: result.message }
      await new Promise((resolve) => setTimeout(resolve, 600))
    }
    // step-04 之后模型页是「provider 行列表 + 一次只开一张编辑卡」：高级参数区在**卡内**，
    // 列表态 querySelector('.more') 只会拿到 null。所以先按真实用户路径点开第一行的
    // 「编辑」（data-action="edit-provider"），再点卡内的 .more。行上刻意没有折叠箭头，
    // 就是为了让「展开高级参数」只有一个入口、一次仍只有一张卡。
    // 注意：本段在模板字符串里，注释不能出现反引号。
    const editButton = document.querySelector('[data-action="edit-provider"]')
    if (editButton === null) return { ok: false, reason: 'no edit-provider button' }
    editButton.click()
    await new Promise((resolve) => setTimeout(resolve, 500))

    const more = document.querySelector('.more')
    if (more === null) return { ok: false, reason: 'no .more after opening editor' }
    more.click()
    await new Promise((resolve) => setTimeout(resolve, 600))
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`

/**
 * 思考等级探针 · 后半：确认「写盘 → 回读 → 渲染」整条链路通了，并把原值写回。
 *
 * 只数 DOM 不够（一个写死的 `<select>` 也能数出来），所以要读下拉的**当前值**：
 * 它来自刚持久化的配置，`'high'` 才对得上。
 *
 * ⚠️ `pass` 含 `restored === true`：这条场景会把 `reasoningEffort` 写成 `high`（甚至为断言造一个 provider），
 * 必须写回原值 —— 否则在真实 userData 下跑 `AURORA_CAPTURE_WINDOWS=settings` 会永久改掉用户配置。
 */
export const SETTINGS_LLM_EFFORT_CHECK = `(async () => {
  try {
    const effortFields = document.querySelectorAll('[data-field$=".reasoningEffort"]')
    const temperatureFields = document.querySelectorAll('[data-field$=".temperature"]')
    const first = effortFields[0]
    const select = first === undefined ? null : first.querySelector('select')
    const value = select === null ? null : select.value
    const domOk = effortFields.length > 0 && temperatureFields.length > 0 && value === 'high'

    // DOM 断言必须先读（写回会触发 settings:changed 重新渲染，之后就读不到 high 了）
    const probe = window.__auroraEffortSettingsProbe
    let restored = null
    const state = await window.aurora.settings.get()
    if (state.ok && probe !== undefined) {
      const providers = state.value.llm.providers
      const target = providers[probe.active]
      if (target === undefined || target.reasoningEffort === probe.before) {
        restored = true
      } else {
        const result = await window.aurora.settings.update({
          llm: {
            active: state.value.llm.active,
            providers: { ...providers, [probe.active]: { ...target, reasoningEffort: probe.before } },
          },
        })
        restored = result.ok === true
      }
    }

    return {
      effortFields: effortFields.length,
      temperatureFields: temperatureFields.length,
      value,
      restored,
      pass: domOk && restored === true,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 对话窗思考等级探针 · 前半（step-03）：把交互窗输入区的「思考」下拉切到 `high`。
 *
 * 截图用**隔离 userData**，起步时一个 provider 都没有 —— 而「没有可用 provider」时渲染层按设计把控件
 * `disabled`（不隐藏），此时切不动。所以先像 `SETTINGS_LLM_EFFORT_ACT` 那样造一个 provider，再操作下拉。
 * 原值记到 `window.__auroraEffortProbe`，供 check 阶段**写回**，避免污染后面的截图场景。
 */
export const CHAT_THINKING_LEVEL_ACT = `(async () => {
  try {
    let state = await window.aurora.settings.get()
    if (!state.ok) return { changed: false, reason: 'settings.get failed' }
    if (Object.keys(state.value.llm.providers).length === 0) {
      const created = await window.aurora.settings.update({
        llm: {
          active: 'capture',
          providers: {
            capture: {
              type: 'openai-compat',
              baseUrl: 'https://api.deepseek.com/v1',
              apiKeyEnc: '',
              model: 'deepseek-chat',
              temperature: 0.7,
              reasoningEffort: 'auto',
            },
          },
        },
      })
      if (!created.ok) return { changed: false, reason: created.message }
      await new Promise((resolve) => setTimeout(resolve, 600))
      state = await window.aurora.settings.get()
      if (!state.ok) return { changed: false, reason: 'settings.get#2 failed' }
    }

    const active = state.value.llm.active
    const provider = active === '' ? undefined : state.value.llm.providers[active]
    window.__auroraEffortProbe = {
      active,
      before: provider === undefined ? null : provider.reasoningEffort,
    }

    // 轮询等控件可用：它的 disabled 取决于**渲染层 settingsStore 是否已水合**（不是配置本身），
    // 而 disabled 元素上的 change 事件不冒泡 → setEffort 根本不执行 → 探针会假 FAIL。
    // 最多等 2.5s，仍不可用就如实报错（不静默、不假装改过）。本段在模板字符串里，注释不能带反引号。
    let select = null
    for (let attempt = 0; attempt < 10 && select === null; attempt += 1) {
      const field = document.querySelector('[data-field="chat.reasoningEffort"]')
      const candidate =
        field === null ? null : field.tagName === 'SELECT' ? field : field.querySelector('select')
      if (candidate !== null && candidate.disabled !== true) {
        select = candidate
      } else {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    if (select === null) {
      return { changed: false, reason: 'chat.reasoningEffort 下拉始终不可用（settingsStore 未水合？）' }
    }

    select.value = 'high'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 600))
    return { changed: true, options: select.options.length, disabled: select.disabled === true }
  } catch (error) {
    return { changed: false, reason: String(error) }
  }
})()`

/**
 * 对话窗思考等级探针 · 后半：配置值、DOM 值、选项数三者对得上，并把原值写回。
 *
 * 只断言配置变了不够（可能界面根本没接线），只断言 DOM 也不够（可能只是本地 state）——
 * 所以两处都读，并要求 option 数量是 4（`auto/low/medium/high`）。
 *
 * ⚠️ `pass` **包含 `restored === true`**：写回原值是这个场景的责任（docs/07 §5.3 承诺会还原），
 * 只上报不判定等于没断言 —— 写回失败会把 `reasoningEffort: 'high'` 留给后面的场景。
 * 恢复目标用 ACT 记下的 `probe.active`（而不是此刻的 `llm.active`）：中途 active 若被别的场景改过，
 * 按当前 active 回写会写错 provider。
 */
export const CHAT_THINKING_LEVEL_CHECK = `(async () => {
  try {
    const state = await window.aurora.settings.get()
    if (!state.ok) return { pass: false, reason: 'settings.get failed' }
    const active = state.value.llm.active
    const provider = active === '' ? undefined : state.value.llm.providers[active]
    const configValue = provider === undefined ? null : provider.reasoningEffort

    const field = document.querySelector('[data-field="chat.reasoningEffort"]')
    const select =
      field === null ? null : field.tagName === 'SELECT' ? field : field.querySelector('select')
    const domValue = select === null ? null : select.value
    const optionCount = select === null ? 0 : select.options.length

    // 写回原值：本场景会改配置，后面还有别的截图场景，不能让它们看到 high
    const probe = window.__auroraEffortProbe
    let restored = null
    if (probe !== undefined && probe.active !== '' && probe.before !== null) {
      const providers = state.value.llm.providers
      const target = providers[probe.active]
      if (target === undefined || target.reasoningEffort === probe.before) {
        // 本来就是我们创建/没改动的值：无需写回，视为已还原
        restored = true
      } else {
        const result = await window.aurora.settings.update({
          llm: {
            active: state.value.llm.active,
            providers: { ...providers, [probe.active]: { ...target, reasoningEffort: probe.before } },
          },
        })
        restored = result.ok === true
      }
    }

    return {
      pass:
        configValue === 'high' && domValue === 'high' && optionCount === 4 && restored === true,
      configValue,
      domValue,
      optionCount,
      restored,
    }
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

/**
 * 窗口拖动探针（step-06）：能拖的窗口必须有一条**够大**的拖动区，且拖动区里的按钮仍点得到。
 *
 * 背景：拖动能力此前靠各窗自己记得挂 `drag-region`，settings 窗只有侧栏里约 22-30px 的 `.brand` 能拖，
 * 用户感知就是「有些能拖有些不行」。三个断言分别对应三类真实故障：
 * ① 一个可见拖动区都没有（没挂 class）；② 高度的最大值 < 32px（挂了但抓不住）；
 * ③ 拖动区里的按钮被 `-webkit-app-region: drag` 吃掉点击（`elementFromPoint` 命中的不是按钮自己）。
 *
 * 读数兼容两种属性名：Chromium 上生效值可能只认 `-webkit-app-region` 或 `app-region` 之一。
 * 若两者都读到空串，说明该属性**不可读**——此时不要把它改成永远 PASS：保留 `regionValue` 原值
 * 供排查，判定口径的取舍写在 docs/07 §5.3（`regions` 数组本身已经能说明「挂没挂、够不够大」）。
 */
export const WINDOW_DRAG_SCRIPT = `(() => {
  try {
    const regions = []
    let maxHeight = 0
    let biggest = null
    for (const el of Array.from(document.querySelectorAll('.drag-region'))) {
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      const region = (
        style.getPropertyValue('-webkit-app-region') || style.getPropertyValue('app-region') || ''
      ).trim()
      const visible = rect.width > 0 && rect.height > 0
      regions.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || ''),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        top: Math.round(rect.top),
        region,
        visible,
      })
      if (visible && rect.height > maxHeight) {
        maxHeight = rect.height
        biggest = el
      }
    }

    let regionValue = null
    let buttonLabel = null
    let buttonHit = null
    if (biggest !== null) {
      const style = getComputedStyle(biggest)
      regionValue = (
        style.getPropertyValue('-webkit-app-region') || style.getPropertyValue('app-region') || ''
      ).trim()
      const button = biggest.querySelector('button')
      if (button !== null) {
        const rect = button.getBoundingClientRect()
        buttonLabel = (button.textContent || '').trim()
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        buttonHit = hit !== null && (hit === button || button.contains(hit))
      }
    }

    return {
      regions,
      maxHeight: Math.round(maxHeight),
      regionValue,
      buttonLabel,
      buttonHit,
      pass: regions.some((item) => item.visible) && maxHeight >= 32 && regionValue === 'drag' && buttonHit === true,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 对话窗模型选择器探针 · 前半（step-05）：把 [data-field="chat.model"] 切到第二个模型。
 *
 * 与思考等级那条同构：隔离 userData 起步时没有 provider，而「没有可用 provider」时两个选择器
 * 都按设计禁用，所以先造一个**带候选列表**的 provider（modelList 至少两个 id）再操作。
 * 原值（model 与 modelList）记到 window.__auroraModelProbe，供 check 阶段写回、不污染后续场景。
 */
export const CHAT_MODEL_PICKER_ACT = `(async () => {
  try {
    const state = await window.aurora.settings.get()
    if (!state.ok) return { changed: false, reason: 'settings.get failed' }
    const providers = state.value.llm.providers
    const active = state.value.llm.active !== '' ? state.value.llm.active : 'capture'
    const existing = providers[active]
    const models = ['deepseek-chat', 'deepseek-reasoner']
    window.__auroraModelProbe = {
      active,
      before: existing === undefined ? null : existing.model,
      beforeList: existing === undefined ? null : existing.modelList,
    }

    const list = existing === undefined ? undefined : existing.modelList
    if (existing === undefined || list === undefined || list.length < models.length) {
      const result = await window.aurora.settings.update({
        llm: {
          active,
          providers: {
            ...providers,
            [active]: {
              type: 'openai-compat',
              baseUrl: 'https://api.deepseek.com/v1',
              apiKeyEnc: '',
              model: 'deepseek-chat',
              temperature: 0.7,
              ...(existing === undefined ? {} : existing),
              modelList: models,
            },
          },
        },
      })
      if (!result.ok) return { changed: false, reason: result.message }
      await new Promise((resolve) => setTimeout(resolve, 600))
    }

    // 轮询等控件可用（同思考等级那条）：disabled 取决于渲染层 store 是否已水合，
    // disabled 元素上的 change 事件不冒泡，会变成假 FAIL。本段在模板字符串里，注释不能带反引号。
    let select = null
    for (let attempt = 0; attempt < 10 && select === null; attempt += 1) {
      const field = document.querySelector('[data-field="chat.model"]')
      const candidate =
        field === null ? null : field.tagName === 'SELECT' ? field : field.querySelector('select')
      if (candidate !== null && candidate.disabled !== true) {
        select = candidate
      } else {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    if (select === null) {
      return { changed: false, reason: 'chat.model 下拉始终不可用（settingsStore 未水合？）' }
    }
    const optionValues = Array.from(select.options).map((item) => item.value)
    if (optionValues.indexOf('deepseek-reasoner') === -1) {
      // 目标不在选项里就不硬切：切开只会静默拿到一个不是我们想要的值
      return { changed: false, reason: 'deepseek-reasoner 不在选项里', options: optionValues }
    }
    select.value = 'deepseek-reasoner'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 600))
    return { changed: true, options: optionValues }
  } catch (error) {
    return { changed: false, reason: String(error) }
  }
})()`

/**
 * 对话窗模型选择器探针 · 后半：配置里的 model 与 DOM 的 value 必须都变成新模型。
 *
 * 两处都读的理由与思考等级那条一致：只读配置可能是界面没接线，只读 DOM 可能是本地 state。
 * 结束时把 model（与 modelList，如果这次是我们造出来的）写回原值。
 */
export const CHAT_MODEL_PICKER_CHECK = `(async () => {
  try {
    const state = await window.aurora.settings.get()
    if (!state.ok) return { pass: false, reason: 'settings.get failed' }
    const active = state.value.llm.active
    const provider = active === '' ? undefined : state.value.llm.providers[active]
    const configModel = provider === undefined ? null : provider.model

    const field = document.querySelector('[data-field="chat.model"]')
    const select =
      field === null ? null : field.tagName === 'SELECT' ? field : field.querySelector('select')
    const domValue = select === null ? null : select.value
    const optionCount = select === null ? 0 : select.options.length

    const probe = window.__auroraModelProbe
    let restored = null
    if (probe !== undefined && probe.active !== '' && probe.before !== null) {
      const providers = state.value.llm.providers
      const target = providers[probe.active]
      const list = target === undefined ? undefined : target.modelList
      const listSame =
        probe.beforeList === null ||
        (list !== undefined &&
          list.length === probe.beforeList.length &&
          list.every((item, index) => item === probe.beforeList[index]))
      if (target === undefined || (target.model === probe.before && listSame)) {
        // 本来就已经是原值（我们只是补了 modelList 的除外）：无需写回
        restored = true
      } else {
        const patch = { ...target, model: probe.before }
        if (probe.beforeList !== null) patch.modelList = probe.beforeList
        const result = await window.aurora.settings.update({
          llm: { active: state.value.llm.active, providers: { ...providers, [probe.active]: patch } },
        })
        restored = result.ok === true
      }
    }

    return {
      pass:
        configModel === 'deepseek-reasoner' &&
        domValue === 'deepseek-reasoner' &&
        optionCount >= 2 &&
        restored === true,
      configModel,
      domValue,
      optionCount,
      restored,
    }
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

/**
 * 对话窗「朗读」按钮探针 · 前半（step-06）：在渲染层点一次 [data-action="speak-message"]。
 *
 * ⚠️ **act 只负责触发点击**，不断言真的出声：截图跑在隔离 userData + 离线环境上，
 * 合成必然失败（且顺序上「缺 API Key」先于「请求失败」——`tts.error` 的文案与它无关）。
 * 「点完之后按钮有没有回到朗读态」由 check 断言。
 *
 * 按钮**没有强制造出来**，这是刻意的取舍：
 * - 不做配置改写：本场景在真实 userData 下也会被跑（`AURORA_CAPTURE_WINDOWS=chat`），
 *   从 0 造一个 TTS provider 再删掉会动到用户的 `tts.providers` / `tts.active` / 明文凭据缓存；
 * - 即便造了也未必成：按钮的出现取决于渲染层的 `ttsReady`，而它读的是**本窗口** `settingsStore`
 *   已水合的 settings。探针里点一次侧栏「新会话」会让 `chat.switchSession` 走一遍
 *   `hydrate` + `loadSessions` 的长往返，期间「对话」侧栏短暂空白，窗口宽度随之伸缩，反而更不稳。
 *
 * 所以「没有按钮」是**预期分支**：如实返回说明，交给 check 用退化判据处理（不抛错、不假 PASS）。
 */
export const CHAT_TTS_SPEAK_ACT = `(async () => {
  try {
    const buttons = () => Array.from(document.querySelectorAll('[data-action^="speak"]'))
    const snapshot = () =>
      buttons().map((item) => ({
        action: item.getAttribute('data-action'),
        label: (item.textContent || '').trim(),
        disabled: item.disabled === true,
      }))
    // 0) 先把 TTS 配置写成「可朗读」（总开关 + 三要素齐全的 provider），否则按钮按设计不渲染。
    //    必须走 settings:update IPC，不能像会话那样写文件：SettingsStore 在启动时就把
    //    config.json 读进内存并长期缓存，启动后写文件对运行中的进程无效（实测踩到）。
    //    凭据故意留空：离线合成必然失败，那正是本探针要验证的复位路径。
    const seeded = { ok: true, already: false, error: null }
    const state = await window.aurora.settings.get()
    if (!state.ok) {
      seeded.ok = false
      seeded.error = state.message
    } else if (state.value.tts.enabled !== true || state.value.tts.providers['capture'] === undefined) {
      const result = await window.aurora.settings.update({
        tts: {
          enabled: true,
          active: 'capture',
          providers: {
            ...state.value.tts.providers,
            capture: {
              type: 'openai-compat',
              baseUrl: 'https://api.openai.com/v1',
              apiKeyEnc: '',
              model: 'tts-1',
              voice: 'alloy',
              speed: 1,
              format: 'mp3',
            },
          },
        },
      })
      if (!result.ok) {
        seeded.ok = false
        seeded.error = result.message
      }
    } else {
      seeded.already = true
    }
    window.__auroraTtsSeed = seeded
    // 等渲染层 store 收到 settings:changed 广播并重算 ttsReady
    if (seeded.ok && !seeded.already) await new Promise((resolve) => setTimeout(resolve, 400))
    // 与 check 同款：等渲染层水合出助手消息上的朗读按钮（最多 2s，每 200ms 一次）
    let target = null
    for (let attempt = 0; attempt < 10 && target === null; attempt += 1) {
      const found = buttons().filter((item) => item.getAttribute('data-action') === 'speak-message')
      if (found.length > 0) target = found[0]
      else await new Promise((resolve) => setTimeout(resolve, 200))
    }
    if (target === null) {
      // 未配置 TTS 模型 / 没有助手消息时按钮**根本不渲染**（不是 disabled）：如实上报，不假 PASS
      return {
        clicked: false,
        seeded,
        reason: 'no [data-action="speak-message"]（没有助手消息，或 TTS 配置未生效？）',
        found: snapshot(),
      }
    }
    const label = (target.textContent || '').trim()
    target.click()
    // 点完不停顿：紧接着的 delayMs 与截图耗时正好留给合成走完（离线时会失败并复位）
    return { clicked: true, seeded, label }
  } catch (error) {
    return { clicked: false, reason: String(error) }
  }
})()`

/**
 * 对话窗「朗读」按钮探针 · 后半（step-06）：按钮存在，且点击后**回到「朗读」态**。
 *
 * 两条判据二选一，用到的哪条写在返回值的 `criterion` 里（排查假 FAIL 先看它）：
 * - `'ready'`（首选）：act 点过按钮之后，它必须在 1.5s 内回到 `data-action="speak-message"`
 *   且文案是「朗读」——说明 `useTts` 的 `loading` 有复位、没有卡死在「合成中…」。
 *   离线环境下合成会失败，但失败路径同样会清 `loading`，所以这条判据离线可跑。
 * - `'presence'`（退化）：页面上确实有助手消息（`.message.r-assistant` 非空），
 *   但 READY 所要求的前提不成立（act 没点到 / 渲染层 `settingsStore` 尚未水合出 TTS 配置），
 *   此时**只断言按钮存在性**，不去冤枉「loading 没复位」。
 *
 * `pass` 与判据解耦，两种情况下都是「该看到的按钮确实看到了」：
 * `'ready'` 要它存在**且**已复位，`'presence'` 只要它存在。
 * 注意这条断言不覆盖「没有回复时按钮不该有」这一面 —— 那个前提在 capture 计划里不成立
 *（见 `CHAT_TTS_SPEAK_ACT` 的注释），单靠本探针无法区分「按设计不渲染」与「渲染漏了」，
 * 所以不把它写进 `pass`，只在返回值里如实上报。
 *
 * ⚠️ 轮询是必须的，且**不能在 check 里重新点击**：check 跑在**截图之后**（见 `captureWindows`
 * 的顺序 show → act → wait → capturePage → check），此刻 `data-action` 可能已经被 act
 * 触发过状态变化。这里最多等 1.5s、每 100ms 查一次，与 `CHAT_THINKING_LEVEL_ACT` 的
 * 轮询同构。本段在模板字符串里，注释里不能出现反引号。
 */
export const CHAT_TTS_SPEAK_CHECK = `(async () => {
  try {
    const all = () => Array.from(document.querySelectorAll('[data-action^="speak"]'))
    const read = (item) => ({
      action: item.getAttribute('data-action'),
      label: (item.textContent || '').trim(),
      disabled: item.disabled === true,
    })
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    const assistantMessages = document.querySelectorAll('.message.r-assistant').length
    const findButton = (action) =>
      all().find((item) => item.getAttribute('data-action') === action) || null
    // 轮询前先看一次：已经复位就直接记 0 次等待
    let reviveMs = 0
    let ready = findButton('speak-message')
    while (ready === null && reviveMs < 1500) {
      await wait(100)
      reviveMs += 100
      ready = findButton('speak-message')
    }
    ready = findButton('speak-message') || null
    const speaking = findButton('stop-speak')
    const found = all().map(read)

    const present = ready !== null || speaking !== null
    const label = ready === null ? (speaking === null ? null : read(speaking).label) : read(ready).label
    // 首选用「回到朗读态」；它要求的前提不成立时退化成存在性
    const preferReady = present && assistantMessages > 0
    const criterion = preferReady ? 'ready' : 'presence'
    const result = {
      pass: preferReady ? ready !== null && label === '朗读' : present,
      criterion,
      present,
      assistantMessages,
      speakButtons: found.length,
      reviveMs,
      ready,
      found,
      seed: window.__auroraTtsSeed === undefined ? null : window.__auroraTtsSeed,
    }

    // 收尾：act 动过 TTS 配置（settings:update），这里把它摘掉。
    // 只在「是 act 自己造的那一个」时清，用户原有的配置一律不动。
    //
    // ⚠️ 必须带 removedProviders：tts.providers 是 record，「缺项 ≠ 删除」——
    // 只把键从传回去的对象里删掉，主进程合并时缺项会被当成「本次不动这一项」，
    // provider 照样留在配置里（实测 cleared=[] 且 providers 仍含该键）。
    // capture 目前恒跑在隔离 userData 下（index.ts 的 isolatedRun），这里属纵深防御。
    const seed = window.__auroraTtsSeed
    if (seed !== undefined && seed.ok === true && seed.already === false) {
      const state = await window.aurora.settings.get()
      if (state.ok) {
        const providers = { ...state.value.tts.providers }
        delete providers['capture']
        await window.aurora.settings.update({
          tts: {
            enabled: state.value.tts.enabled,
            // active 还指着被摘掉的 capture 时必须一起复位，否则会留下悬空引用
            active: state.value.tts.active === 'capture' ? '' : state.value.tts.active,
            providers,
            removedProviders: ['capture'],
          },
        })
      }
    }
    return result
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

/**
 * 「AI 模型」页「模型设置」区探针 · 前半（step-05）：点开第一行的「编辑」并点一次「+ 手动添加」。
 *
 * `+ 手动添加` 只改**本地 draft**（加一行空行，保存时才落盘），所以这一步不动配置；
 * 行数变化由 check 断言，恢复也由 check 收尾（删掉最后一行）。
 * 隔离 userData 起步时一个 provider 都没有（没有 provider 时列表区根本不在 DOM 里），
 * 所以先造一个带候选列表的。
 */
export const SETTINGS_LLM_MODELS_ACT = `(async () => {
  try {
    let state = await window.aurora.settings.get()
    if (!state.ok) return { ok: false, reason: 'settings.get failed' }
    if (Object.keys(state.value.llm.providers).length === 0) {
      const created = await window.aurora.settings.update({
        llm: {
          active: 'capture',
          providers: {
            capture: {
              type: 'openai-compat',
              baseUrl: 'https://api.deepseek.com/v1',
              apiKeyEnc: '',
              model: 'deepseek-chat',
              modelList: ['deepseek-chat'],
              temperature: 0.7,
              reasoningEffort: 'auto',
            },
          },
        },
      })
      if (!created.ok) return { ok: false, reason: created.message }
      await new Promise((resolve) => setTimeout(resolve, 600))
    }

    const edit = document.querySelector('[data-action="edit-provider"]')
    if (edit === null) return { ok: false, reason: 'no edit-provider button' }
    edit.click()
    await new Promise((resolve) => setTimeout(resolve, 500))

    const section = document.querySelector('[data-field$=".modelList"]')
    if (section === null) return { ok: false, reason: 'no model list section' }
    const countRows = () => document.querySelectorAll('[data-field*=".modelList."]').length
    const before = countRows()

    const add = document.querySelector('[data-action="add-model"]')
    if (add === null) return { ok: false, reason: 'no add-model button', before }
    add.click()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const after = countRows()

    window.__auroraLlmModelsProbe = { before, after }
    return { ok: true, before, after }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`

/**
 * 「模型设置」区探针 · 后半：区存在、列表行数 ≥ 1、「+ 手动添加」使行数恰好 +1，并删回原状。
 *
 * 这里同时也钉住「删除当前模型不静默换模型」的反面：**恢复动作必须只减行、不改 model**
 * （所以删的是刚加出来的那一行，不是当前使用的那行）。配置侧的一致性由
 * `chat-model-picker` 那条探针（配置值 === DOM 值）与设置页保存语义共同覆盖。
 */
export const SETTINGS_LLM_MODELS_CHECK = `(async () => {
  try {
    const section = document.querySelector('[data-field$=".modelList"]')
    const countRows = () => document.querySelectorAll('[data-field*=".modelList."]').length
    const probe = window.__auroraLlmModelsProbe
    const before = probe === undefined ? null : probe.before
    const after = probe === undefined ? null : probe.after

    // 恢复：删掉「+ 手动添加」加出来的最后一行（它是最新加的空行）
    const rows = Array.from(document.querySelectorAll('[data-field*=".modelList."]'))
    const last = rows[rows.length - 1]
    const remove = last === undefined ? null : last.querySelector('[data-action="remove-model"]')
    let restored = null
    if (remove !== null) {
      remove.click()
      await new Promise((resolve) => setTimeout(resolve, 300))
      restored = countRows()
    }

    return {
      pass: section !== null && before !== null && after === before + 1 && restored === before,
      sectionExists: section !== null,
      rowsBefore: before,
      rowsAfterAdd: after,
      rowsAfterRestore: restored,
      emptyState: document.querySelector('[data-empty$=".modelList"]') !== null,
    }
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

/**
 * 「AI 模型」页结构探针 · 前半（step-04）：点开第一行 provider 的「编辑」。
 *
 * 这一步刻意**不写配置**：`settings-llm-params` 那条会造 provider 并断言下拉真值，
 * 两条场景互相干扰的话失败原因很难定位。这里只点开一张卡，验证「一次只开一张」。
 * 优先用 `data-action="edit-provider"` 定位，找不到就按文案「编辑」兜底——
 * 兜底也失败时把行内实际按钮文案回传（而不是静默成功），否则改个文案这条断言就变成空转。
 */
export const SETTINGS_LLM_STRUCTURE_ACT = `(async () => {
  try {
    const state = await window.aurora.settings.get()
    if (!state.ok) {
      window.__auroraLlmStructureProbe = { clicked: false, reason: 'settings.get failed' }
      return window.__auroraLlmStructureProbe
    }
    // 行容器是唯一 data-field 恰好等于「llm.providers.<id>」的元素：
    // 卡内的字段会多一层（llm.providers.<id>.baseUrl），模型列表容器更是 <id>.modelList。
    // 所以拿配置里的 provider id 做白名单比对，而不是靠「后面还有没有点」去猜。
    // 注意：本段在模板字符串里，注释不能出现反引号。
    const ids = Object.keys(state.value.llm.providers)
    const rows = Array.from(document.querySelectorAll('[data-field]')).filter((el) => {
      const value = el.getAttribute('data-field') || ''
      if (value.indexOf('llm.providers.') !== 0) return false
      return ids.indexOf(value.slice('llm.providers.'.length)) !== -1
    })
    const first = rows[0]
    if (first === undefined) {
      window.__auroraLlmStructureProbe = { clicked: false, reason: 'no provider row' }
      return window.__auroraLlmStructureProbe
    }
    const buttons = Array.from(first.querySelectorAll('button'))
    const button =
      first.querySelector('[data-action="edit-provider"]') ||
      buttons.find((item) => (item.textContent || '').trim() === '编辑')
    if (button === null || button === undefined) {
      window.__auroraLlmStructureProbe = {
        clicked: false,
        reason: 'no edit button',
        labels: buttons.map((item) => (item.textContent || '').trim()),
      }
      return window.__auroraLlmStructureProbe
    }
    button.click()
    await new Promise((resolve) => setTimeout(resolve, 500))
    window.__auroraLlmStructureProbe = { clicked: true, label: (button.textContent || '').trim() }
    return window.__auroraLlmStructureProbe
  } catch (error) {
    return { clicked: false, reason: String(error) }
  }
})()`

/**
 * 「AI 模型」页结构探针 · 后半：行列表与配置一致，且**一次只开一张编辑卡**。
 *
 * 三个断言分别钉住重构后的信息架构：
 * ① 每个 provider 恰好一行（行容器的 `data-field` 恰好是 `llm.providers.<id>`，
 *    用配置里的 provider id 做白名单比对 —— 卡内字段与模型列表容器都多一层，不会被算成行）；
 * ② 点开「编辑」之后**恰好一张**可见编辑卡（用卡内必填字段 `.baseUrl` 的可见数量计数）——
 *    恒等 ≤1 会漏掉「一张都没开」这种假通过，所以要求 === 1；
 * ③ `providers` 为空时必须有 `[data-empty="llm.providers"]` 空状态（不再画一排空行）。
 */
export const SETTINGS_LLM_STRUCTURE_CHECK = `(async () => {
  try {
    const state = await window.aurora.settings.get()
    if (!state.ok) return { pass: false, reason: 'settings.get failed' }
    const expected = Object.keys(state.value.llm.providers).length
    const ids = Object.keys(state.value.llm.providers)

    // 行容器 = data-field 恰好是「llm.providers.<id>」（id 取自配置）的元素。
    // 卡内字段多一层（.baseUrl），模型列表容器是 <id>.modelList —— 都不会被算成行。
    const rows = Array.from(document.querySelectorAll('[data-field]')).filter((el) => {
      const value = el.getAttribute('data-field') || ''
      if (value.indexOf('llm.providers.') !== 0) return false
      return ids.indexOf(value.slice('llm.providers.'.length)) !== -1
    })
    const isVisible = (el) => {
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }
    const editors = Array.from(document.querySelectorAll('[data-field$=".baseUrl"]')).filter(
      isVisible,
    ).length
    const emptyState = document.querySelector('[data-empty="llm.providers"]') !== null
    const act = window.__auroraLlmStructureProbe

    return {
      pass: expected > 0 ? rows.length === expected && editors === 1 : emptyState,
      expected,
      rows: rows.length,
      rowIds: rows.map((el) => el.getAttribute('data-field')),
      editors,
      emptyState,
      act: act === undefined ? null : act,
    }
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

/**
 * 「语音」页编辑卡探针 · 前半（step-05）：进「添加」态 → 点「+ 空白配置」让编辑卡出现。
 *
 * ⚠️ 三条硬约束（第一条是首跑实测踩出来的）：
 * - **必须先进入添加态**：`+ 空白配置` 渲染在 `<section v-if="mode === 'add'">` 里，
 *   页面初始是列表态（列表为空时更是只有一张空状态卡），直接找这个按钮必然找不到
 *   （首跑实测 `act: null`、六字段全 0）。所以先点「添加 TTS 模型」/「+ 添加 TTS 模型」
 *   进添加态，再点「+ 空白配置」。
 * - **不得点「应用」**：capture 在真实 userData 下也会被跑（`AURORA_CAPTURE_WINDOWS=settings`），
 *   而「+ 空白配置」只往**本地 `drafts`** 里加一行、保存时才落盘，所以这一步不动配置
 *   （与 `SETTINGS_LLM_MODELS_ACT` 同一取舍）。因此这里**不需要任何恢复动作**。
 * - 定位优先按**按钮文案**：`data-action` 是 TtsPage 的加分项但**没有冻结进 DOM 契约**，
 *   靠它一条路会在页面没写这个属性时变成静默找不到。反过来「+ 空白配置」是 step-05 明确的
 *   用户可见文案，改了文案这条断言本就该失败并报出实际按钮文案（不静默成功）。
 *   匹配时统一去掉首尾空白与「+」前缀，`+ 空白配置` / `空白配置` 两种写法都命中。
 */
export const SETTINGS_TTS_ADD_ACT = `(async () => {
  try {
    const normalize = (text) => (text || '').replace(/\\s+/g, '').replace(/^\\+/, '')
    // ⚠️ 每次都**重新查询**按钮：进入添加态后会出现全新的按钮节点，
    //    在点击前查一次就把结果缓存下来的话，新节点永远不在那个数组里（首跑实测踩到）。
    const allButtons = () => Array.from(document.querySelectorAll('button'))
    const blankButton = () =>
      allButtons().find((item) => item.getAttribute('data-action') === 'add-blank-tts') ||
      allButtons().find((item) => normalize(item.textContent) === '空白配置')
    const record = (value) => {
      window.__auroraTtsActResult = value
      return value
    }
    // 1) 先进入「添加」态：「+ 空白配置」只在添加区（空状态里的「添加 TTS 模型」或
    //    工具行的「+ 添加 TTS 模型」点下去之后）才渲染 —— 直接找它会一无所获。
    let opened = null
    if (blankButton() === undefined) {
      const opener =
        allButtons().find((item) => normalize(item.textContent) === '添加TTS模型') ||
        allButtons().find((item) => item.getAttribute('data-action') === 'add-tts-provider')
      if (opener === undefined) {
        return record({
          ok: false,
          reason: 'no 添加 TTS 模型 opener',
          labels: allButtons()
            .map((item) => (item.textContent || '').trim())
            .filter((item) => item !== ''),
        })
      }
      opener.click()
      opened = normalize(opener.textContent)
      // 等添加区渲染（Vue 的 DOM 更新是微任务，这里留够一帧）
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    // 2) 再点「+ 空白配置」进编辑卡
    const target = blankButton()
    if (target === undefined) {
      return record({
        ok: false,
        reason: 'no 空白配置 button',
        opened,
        labels: allButtons()
          .map((item) => (item.textContent || '').trim())
          .filter((item) => item !== ''),
      })
    }
    target.click()
    // 等编辑卡渲染
    await new Promise((resolve) => setTimeout(resolve, 500))
    const rows = document.querySelectorAll('[data-field$=".baseUrl"]').length
    window.__auroraTtsCardProbe = { clicked: true, label: normalize(target.textContent) }
    return record({
      ok: true,
      opened,
      label: normalize(target.textContent),
      editorFields: rows,
    })
  } catch (error) {
    window.__auroraTtsActResult = { ok: false, reason: String(error) }
    return window.__auroraTtsActResult
  }
})()`

/**
 * 「语音」页编辑卡探针 · 后半（step-05）：六字段的 `data-field` 必须全在。
 *
 * 用**后缀**选择器（`[data-field$=".baseUrl"]`）而不是写死 provider id：
 * 点「+ 空白配置」之后 id 由页面决定（LlmPage 同款流程用的是 `custom`），
 * 探针假设 id 等于把契约里没冻结的东西当成事实。
 *
 * 「在」的判定是**可见**（`getBoundingClientRect` 有尺寸），不是只数选择器命中数：
 * 一个 `display:none` 的卡也数得出来，那样断言就退化成空转（与 `SETTINGS_LLM_STRUCTURE_CHECK` 同口径）。
 */
export const SETTINGS_TTS_CARD_CHECK = `(async () => {
  try {
    const fields = ['baseUrl', 'apiKey', 'model', 'voice', 'speed', 'format']
    const found = {}
    for (const name of fields) {
      const hit = Array.from(document.querySelectorAll('[data-field$=".' + name + '"]')).filter(
        (el) => {
          const rect = el.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        },
      )
      found[name] = hit.length
    }
    const missing = fields.filter((name) => found[name] === 0)
    const probe = window.__auroraTtsCardProbe
    return {
      pass: missing.length === 0,
      fields: found,
      missing,
      // act 的结论一并回传：失败时能一眼看出是「没进添加态」还是「没找到空白配置」，
      // 不用再改代码重跑一次（首跑就是靠它定位到缓存按钮节点的）。
      act: probe === undefined ? null : probe,
      actResult: window.__auroraTtsActResult === undefined ? null : window.__auroraTtsActResult,
    }
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

/**
 * 默认截图清单：四个窗口 + 提示条两态 + 设置页各页深链（含思考等级参数面板）+ 若干 DOM 断言场景
 * （门控计数 / 对话自动滚底 / 收起即消失 / 思考等级 / 电脑拖动区 / 电脑操控页，见下面各条的 `check`）。
 * 独立的快速对话窗口已从全仓删除：快速会话并入交互窗侧栏，故清单里不再有它的场景。
 * `AURORA_CAPTURE_WINDOWS` 可以只截其中一部分（逗号分隔）。
 *
 * ⚠️ 交互窗场景的**顺序约束**：凡是要在交互窗里操作 DOM 的场景，都必须排在 `chat-collapse.png` **之前**——
 * 收起会把窗口隐藏，之后再 `capturePage()` 只会卡死。因此顺序固定为
 * `chat-thinking-level` → `chat-model-picker`（step 5 加）→ `chat-tts`（step 6 加）→ `chat-drag`
 * → `chat-collapse` → `chat.png`。
 */
/**
 * 为 `chat-tts` 场景准备一条「可朗读」的历史（主进程侧，在跑计划之前调用一次）。
 *
 * 为什么必须种数据（而不是让探针去点出来）：
 * 隔离 userData 下 `chat:history` 必然是空的，而 `chat-tts` 需要**一条助手消息**
 * 才会渲染「朗读」按钮；离线环境 `chat:send` 只会回 error 事件（没有可用 LLM），
 * 不会产生助手消息。
 *
 * ⚠️ 只种**会话**，不种配置：`SettingsStore.init()` 在启动时就把 `config.json` 读进内存并
 * 长期缓存（`this.current`），启动之后再写文件对运行中的进程毫无影响（实测踩到）。
 * TTS 配置改由 `CHAT_TTS_SPEAK_ACT` 走 `settings:update` IPC 写 —— 那是唯一能让渲染层
 * 立刻看到新配置的路径（与 `CHAT_MODEL_PICKER_ACT` 同一套路）。
 *
 * 会话则相反：`SessionStore` 是按会话**惰性**读盘的，所以启动后写文件是安全的 ——
 * 但必须在交互窗第一次 `chat:history` 之前，否则缓存里已经是空数组。
 * 隔离目录退出时会被整体删除，因此不会污染用户数据。
 */
export async function seedChatTtsHistory(userData: string | undefined): Promise<void> {
  if (userData === undefined || userData === '') return
  /**
   * ⚠️ 会话 id 必须与交互窗用的那个一致：`chat/App.vue` 是 `useChat('chat', 'main')`，
   * 也就是 `main`。种成别的 id（首版种的 `capture-tts`）文件写成功了也没人读 ——
   * 窗口水合的是 `main.json`（首跑实测 `assistantMessages: 0` 就是这个原因）。
   */
  const sessionId = 'main'
  const now = new Date().toISOString()

  // 1) 会话历史：一条助手消息即可（`MessageList` 只对 assistant 渲染朗读按钮）
  const session = {
    version: 1,
    sessionId,
    updatedAt: now,
    messages: [
      {
        id: 'capture-tts-a1',
        role: 'assistant',
        content: '这是截图探针种下的一条助手回复，用来验证「朗读」按钮的渲染与状态复位。',
        createdAt: now,
      },
    ],
  }
  await mkdir(join(userData, 'sessions'), { recursive: true })
  await writeFile(
    join(userData, 'sessions', `${sessionId}.json`),
    JSON.stringify(session, null, 2),
    'utf8',
  )
}

export function defaultCapturePlan(manager: WindowManager): CaptureTarget[] {
  const plan: CaptureTarget[] = [
    { name: 'edge-bar', file: 'edge-bar.png' },
    {
      name: 'edge-bar',
      file: 'edge-bar-expanded.png',
      act: EDGE_BAR_HOVER_SCRIPT,
      check: EDGE_BAR_PANEL_SCRIPT,
    },
    // 交互窗的场景顺序见函数头注释：能在窗口里操作 DOM 的都排在 chat-collapse 之前。
    // 这些场景都沿用 `name: 'chat'`（`CaptureTarget.name` 的类型是 `WindowName`，且 `report.json`
    // 的 checks 是**数组**、靠 `file` 区分），所以靠文件名与 `AURORA_CAPTURE_WINDOWS=chat` 过滤。
    // 「收起即消失」**不设 act**：点击放在 check 里（原因见 `CHAT_COLLAPSE_CHECK` 的注释——
    // 窗口先被 hide 掉会让紧接着的 capturePage 永不返回，整轮截图卡死）。
    {
      name: 'chat',
      file: 'chat-thinking-level.png',
      act: CHAT_THINKING_LEVEL_ACT,
      check: CHAT_THINKING_LEVEL_CHECK,
    },
    {
      name: 'chat',
      file: 'chat-model-picker.png',
      act: CHAT_MODEL_PICKER_ACT,
      check: CHAT_MODEL_PICKER_CHECK,
    },
    // 朗读按钮（step-06）：act 点一次 [data-action="speak-message"]（离线合成必然失败，
    // 只触发点击、不断言出声），check 断言按钮存在且点击后回到「朗读」态；
    // 「没有可用助手消息」时退化成只断言按钮存在性，判据写在返回值的 criterion 里。
    // 同样排在 chat-collapse 之前（窗口一被 hide，紧接着的 capturePage 会永不返回）。
    {
      name: 'chat',
      file: 'chat-tts.png',
      // 现场由 `runCapture` 在跑计划前种好（见 `seedChatTtsHistory`）；这里只需要
      // reload 一次让渲染层重新水合 —— 本场景没有 `query`，`captureWindows` 不会替我们 reload。
      prepare: async () => {
        await manager.reload('chat', {})
      },
      act: CHAT_TTS_SPEAK_ACT,
      check: CHAT_TTS_SPEAK_CHECK,
    },
    { name: 'chat', file: 'chat-drag.png', check: WINDOW_DRAG_SCRIPT },
    { name: 'chat', file: 'chat-collapse.png', check: CHAT_COLLAPSE_CHECK },
    { name: 'chat', file: 'chat.png', check: CHAT_AUTO_SCROLL_SCRIPT },
    { name: 'onboarding', file: 'onboarding.png' },
  ]
  for (const page of SETTINGS_PAGE_IDS) {
    plan.push({
      name: 'settings',
      file: `settings-${page}.png`,
      query: { page },
      // 「常规」页是 `general.*` 门控的现场：死字段 general.language 必须为 0，
      // 提示条透明度 / 静默时段要跟着 general.edgeBar.enabled 出现或消失；
      // 「电脑操控」页同理，另加"总开关状态 → 分栏详情是否出现"的断言（step 5）；
      // 「语音」页是**互斥门控**（provider 列表空 → autoRead / maxChars 整块消失）
      check:
        page === 'general'
          ? SETTINGS_FIELDS_SCRIPT
          : page === 'agent'
            ? SETTINGS_AGENT_FIELDS_SCRIPT
            : page === 'tts'
              ? SETTINGS_TTS_FIELDS_SCRIPT
              : undefined,
    })
  }
  // 设置窗拖动区（step-06）：侧栏顶部 / `.brand` / 内容区顶部三处至少要有一条 ≥ 32px 的可见拖动区，
  // 且拖动区里的按钮仍能被 elementFromPoint 命中（不被 `-webkit-app-region: drag` 吃掉点击）。
  plan.push({
    name: 'settings',
    file: 'settings-drag.png',
    query: { page: 'general' },
    check: WINDOW_DRAG_SCRIPT,
  })
  // 模型设置区（step-05）：点开第一行的「编辑」→「+ 手动添加」使行数恰好 +1 → 删回原状。
  // 排在 `settings-llm-params` **之前**：它只动本地 draft、不改配置，先跑能少一次配置往返。
  plan.push({
    name: 'settings',
    file: 'settings-llm-models.png',
    query: { page: 'llm' },
    act: SETTINGS_LLM_MODELS_ACT,
    check: SETTINGS_LLM_MODELS_CHECK,
  })
  // 思考等级（step-02）：造一个 provider → 展开「高级参数」→ 断言下拉真值来自配置。
  // 刻意放在 SETTINGS_PAGE_IDS 循环**之外**：塞进循环会让每个设置页都多点一次。
  plan.push({
    name: 'settings',
    file: 'settings-llm-params.png',
    query: { page: 'llm' },
    act: SETTINGS_LLM_EFFORT_ACT,
    check: SETTINGS_LLM_EFFORT_CHECK,
  })
  // AI 模型页的新信息架构（step-04）：行列表 + 一次只开一张编辑卡 + 空状态。
  // 顺序在 `settings-llm-params` 之后；两者互不干扰——每个场景都会 `reload` 设置窗，
  // 页面回到列表态，且本场景自身**不改配置**（只点开一张卡）。
  plan.push({
    name: 'settings',
    file: 'settings-llm-structure.png',
    query: { page: 'llm' },
    act: SETTINGS_LLM_STRUCTURE_ACT,
    check: SETTINGS_LLM_STRUCTURE_CHECK,
  })
  // 「语音」页编辑卡（step-05）：点「+ 空白配置」→ 断言六个字段的 data-field 都在。
  // 只动**本地 draft**、不点「应用」，所以无需恢复动作。
  // ⚠️ `settings-tts.png` 不在这里 push：上面的 `SETTINGS_PAGE_IDS` 循环已经为每个 page
  // 生成 `settings-<page>.png`（含 `tts`），再 push 一张同名图会多截一次、`report.json` 里
  // 出现两条同名且后者把前者的 check 顶掉，所以要拍的只有这张卡场景。
  plan.push({
    name: 'settings',
    file: 'settings-tts-card.png',
    query: { page: 'tts' },
    act: SETTINGS_TTS_ADD_ACT,
    check: SETTINGS_TTS_CARD_CHECK,
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
    // ⚠️ 先**隐藏**交互窗再点击竖条：否则这条会退化成空转 —— 计划前面已经有一次 `manager.show('chat')`
    //（`chat.png` 场景），状态机里 `chat:true / primary:'chat'` 在点击**之前**就成立，探针不再依赖点击。
    // 删掉 `mini-chat.png` 场景后窗口互斥不再自动把它藏起来，所以这里显式复位。
    prepare: () => {
      manager.hide('chat')
    },
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
