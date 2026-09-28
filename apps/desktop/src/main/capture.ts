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
import { nativeTheme, type BrowserWindow } from 'electron'
import { createFileSnapshotPort } from '@aurora/agent-core'
import { createNoopLogger, nodeFileSystem, type Logger, type WindowName } from '@aurora/shared'
import type { WindowManager } from './window-manager.js'
/**
 * 设置页可深链的页面 id，需与 `renderer/settings/App.vue` 的 `PageId` 保持一致。
 *
 * BetaV2 六页 IA（spec §9）：8 页合并为 6 页 —— TtsPage 并入 voice（与 STT 同页）、
 * SkillsPage / McpPage 并入 agent。旧深链（`?page=tts|skills|mcp`）由渲染层的
 * `LEGACY_PAGE_ALIASES` 单向映射到新页，深链清单本身只保留新 id；
 * 别名映射由 `settings-legacy-tts-alias.png` 场景单独钉住（见 defaultCapturePlan）。
 * v0.2.0 起新增 Aurora Center 页共 7 页（docs/07 §2.5）。
 */
export const SETTINGS_PAGE_IDS = [
  'general',
  'modes',
  'llm',
  'voice',
  'agent',
  'center',
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
  /**
   * 截图后在**主进程侧**断言渲染层读不到的窗口属性（目前只有原生底色，见 docs/07 §5.3 双主题）。
   *
   * 为什么需要它：`prefers-color-scheme` 只改了 CSS，若原生底色没跟着换，窗口在浅色下仍会
   * 先闪一层深色底再画出页面 —— 而这件事在渲染层里根本读不到（`backgroundColor` 是 BrowserWindow 的）。
   * 返回值与 `check` 合并进**同一条** `checks` 记录（渲染层结果放原字段、主进程结果放 `native`），
   * `pass` 取两者相与，因此原有交互断言不会被替换、也不会多出一条记录。
   */
  nativeCheck?: () => { pass: boolean } & Record<string, unknown>
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
  /**
   * 该目标是否**配了**探针（`check` 或 `nativeCheck`）。
   *
   * 必须单列一个字段：`result` 为空有两种含义 —— 「本来就没配探针」（纯截图场景，正常）
   * 与「配了探针却没返回结果」（断言根本没生效）。只靠 `result` 分不出来，
   * 后者会被当成通过（见 `failed` 的判定与下面的注释）。
   */
  checked: boolean
  /** 该目标整体是否成功（截图写出 + check 无异常） */
  ok: boolean
  error?: string
}

export interface CaptureResult {
  dir: string
  files: string[]
  checks: CaptureCheck[]
  /** 是否存在失败项：探针 `pass === false`、截图/探针抛错，或**配了 check 却返回 undefined** */
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

      const rendererResult =
        target.check === undefined
          ? undefined
          : await win.webContents.executeJavaScript(target.check, true)
      checks.push({
        name: target.name,
        file,
        result: mergeCheckResults(rendererResult, target.nativeCheck?.()),
        checked: target.check !== undefined || target.nativeCheck !== undefined,
        ok: true,
      })
    } catch (error) {
      logger?.warn('窗口截图失败', { window: target.name, error: String(error) })
      checks.push({
        name: target.name,
        file,
        checked: target.check !== undefined || target.nativeCheck !== undefined,
        ok: false,
        error: String(error),
      })
    }
  }
  return {
    dir,
    files,
    checks,
    // 判定要同时覆盖三种情况：探针明确返回 `pass:false`；截图 / 探针抛错（`ok:false`）；
    // 以及**配了探针却没拿到结果**（脚本提前 return / 没写 return / 返回 `null` —— 断言等于没跑）。
    // 前两版只看 `pass === false`：`result` 为空时一律算通过，
    // 「静默丢一条」会以退出码 0 结束。所以 `checked` 字段必须参与判定
    //（`result` 为空且 `checked === false` 才是正常的纯截图场景）。
    // 空值判据用 `== null` 同时覆盖 `undefined` 与 `null`（ESLint 的 eqeqeq 允许 `== null` 写法）。
    failed: checks.some(
      (item) =>
        item.ok === false ||
        (item.checked && item.result == null) ||
        (item.result as { pass?: unknown } | undefined)?.pass === false,
    ),
  }
}

/**
 * 把渲染层 `check` 与主进程 `nativeCheck` 合成一条探针结果。
 *
 * 两者都在才要求双通过；只有 `nativeCheck`（没有渲染层 check）时以它为准。
 * 渲染层返回非对象（理论上不会）时降级成 `{ renderer, native, pass:false }`，
 * 避免静默把一次失败当成通过。
 */
function mergeCheckResults(
  renderer: unknown,
  native: ({ pass: boolean } & Record<string, unknown>) | undefined,
): unknown {
  if (native === undefined) return renderer
  if (renderer === undefined) return { native, pass: native.pass }
  const record =
    typeof renderer === 'object' && renderer !== null
      ? (renderer as Record<string, unknown>)
      : { renderer }
  return { ...record, native, pass: record['pass'] === true && native.pass === true }
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
    // 快速对话（2026-09）：面板必须带输入框与发送钮（可直接在提示条里对话），
    // 且 seed 的 quick 会话消息以气泡渲染出来
    const quickInput = panel.querySelectorAll('.qc-composer input').length
    const quickSend = panel.querySelectorAll('[data-action="edge-bar.quick-send"]').length
    const quickBubbles = panel.querySelectorAll('.qc-msg').length
    return {
      panel: true,
      windowWidth: width,
      windowHeight: document.documentElement.clientHeight,
      styled: getComputedStyle(panel).width,
      buttonCount: buttons.length,
      probes,
      quickInput,
      quickSend,
      quickBubbles,
      allClickable: probes.length > 0 && probes.every((p) => p.hit && p.insideWindow),
      pass:
        buttons.length === 3 &&
        width <= 228 &&
        quickInput > 0 &&
        quickSend > 0 &&
        quickBubbles > 0 &&
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
 * 按 `data-caption-btn="close"` 找按钮（Windows 式窗口按钮，2026-09 重构起取代旧「收起」文字钮；
 * 语义同为隐藏窗口）。找不到时把头部实际按钮清单回传（而不是静默成功），
 * 否则改了锚点会让这条断言变成空转。
 *
 * `primary === null` 是关键：残留的 `primary` 说明「隐藏」被实现成了「换成另一个主窗口」。
 * `getState()` 带 4s 超时兜底：窗口隐藏后渲染层可能被降频，万一读不回来也不能把整轮截图拖死。
 */
export const CHAT_COLLAPSE_CHECK = `(async () => {
  try {
    const button = document.querySelector('[data-caption-btn="close"]')
    if (button === null) {
      const labels = Array.from(document.querySelectorAll('.head button')).map(
        (item) =>
          (item.textContent || '').trim() ||
          item.getAttribute('aria-label') ||
          item.getAttribute('data-caption-btn') ||
          '',
      )
      return { pass: false, reason: 'no data-caption-btn=close button', labels }
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
      chatVisible: visible['chat'] === true,
      primary,
      state,
    }
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

/**
 * ClassIsland 课堂状态卡的现场准备（docs/05 §3.4 v3、docs/07 §2.3）。
 *
 * 状态卡只在「模式 = classroom **且** 课表来源 = classisland」时渲染，出厂配置下
 * 它整卡不存在 —— 所以要有真实桥接数据才能拍到它。这里在主进程侧写一份**符合桥接契约的
 * 假产出**（`version: 1` + 内嵌 `status.version: 3`）到隔离 userData 下，供捕获场景使用：
 * 文件模式读的是磁盘，因此不需要真的装 ClassIsland。
 */
export function classislandFixturePath(userData: string): string {
  return join(userData, 'classisland-fixture', 'schedule.json')
}

export async function seedClassIslandFixture(userData: string): Promise<string> {
  const path = classislandFixturePath(userData)
  const weekday = new Date().getDay()
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    lessons: [
      { weekday, startTime: '08:00', endTime: '08:45', subject: '数学' },
      { weekday, startTime: '09:20', endTime: '10:05', subject: '语文' },
    ],
    status: {
      version: 3,
      generatedAt: new Date().toISOString(),
      onClass: true,
      currentSubject: '数学',
      currentStartTime: '08:00',
      currentEndTime: '08:45',
      nextSubject: '语文',
      nextStartTime: '09:20',
      nextEndTime: '10:05',
    },
  }
  await mkdir(join(userData, 'classisland-fixture'), { recursive: true })
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf8')
  return path
}

/**
 * 自动化夹具（docs/13 §11）：种 1 份 Normal 定义 + 2 条历史 + 1 个 `auto-` 会话文件。
 *
 * - 定义 / 历史：`AutomationStore` 惰性首读（同 SessionStore 口径），**必须赶在**
 *   窗口第一次 `automation:list` 之前 —— runCapture 在打开窗口前调用本函数，时机正确；
 * - `auto-` 会话文件：给历史探针的「Agent 记录回放」供真实对话（`chat:history` 惰性读盘）。
 * 隔离 userData 退出即整体删除，不污染用户数据。
 */
export async function seedAutomationFixture(userData: string): Promise<void> {
  const now = Date.now()
  const definitions = [
    {
      id: 'am-capture1',
      name: '早读提醒',
      enabled: true,
      mode: 'normal',
      trigger: { kind: 'daily', params: { at: '07:30', weekdays: [] } },
      actions: [{ kind: 'system-notify', params: { title: '早读提醒', body: '该背单词了' } }],
      createdAt: new Date(now - 86_400_000).toISOString(),
      updatedAt: new Date(now - 86_400_000).toISOString(),
    },
  ]
  const runs = [
    {
      id: 'auto-capture-normal',
      automationId: 'am-capture1',
      automationName: '早读提醒',
      mode: 'normal',
      status: 'success',
      triggeredAt: new Date(now - 3_600_000).toISOString(),
      finishedAt: new Date(now - 3_600_000 + 120).toISOString(),
      durationMs: 120,
    },
    {
      id: 'auto-capture1',
      automationId: 'am-capture1',
      automationName: '早读提醒',
      mode: 'agent',
      status: 'success',
      triggeredAt: new Date(now - 1_800_000).toISOString(),
      finishedAt: new Date(now - 1_799_000).toISOString(),
      durationMs: 1000,
      sessionId: 'auto-capture1',
    },
  ]
  const session = {
    version: 2,
    sessionId: 'auto-capture1',
    updatedAt: new Date(now - 1_799_000).toISOString(),
    messages: [
      {
        id: 'capture-auto-u1',
        role: 'user',
        content: 'capture-automation-run：这是自动化触发种下的任务指令（早读提醒）。',
        createdAt: new Date(now - 1_800_000).toISOString(),
      },
      {
        id: 'capture-auto-a1',
        role: 'assistant',
        content: 'capture-automation-run：这是自动化会话里 Agent 的回复，历史回放应显示本条。',
        createdAt: new Date(now - 1_799_500).toISOString(),
      },
    ],
  }
  const automationDir = join(userData, 'automations')
  await mkdir(automationDir, { recursive: true })
  await writeFile(
    join(automationDir, 'automations.json'),
    JSON.stringify({ version: 1, definitions }, null, 2),
    'utf8',
  )
  await writeFile(
    join(automationDir, 'history.json'),
    JSON.stringify({ version: 1, runs }, null, 2),
    'utf8',
  )
  await mkdir(join(userData, 'sessions'), { recursive: true })
  await writeFile(
    join(userData, 'sessions', 'auto-capture1.json'),
    JSON.stringify(session, null, 2),
    'utf8',
  )
}

/**
 * 把课表来源切到「ClassIsland 联动 + 文件模式 + 夹具路径」，让课堂状态卡出现。
 *
 * 必须走 `settings:update` IPC：`SettingsStore.init()` 启动即把 config.json 读进内存并长期缓存，
 * 启动后写文件对运行中的进程无效。`check` 收尾会还原成 `manual`，后续场景读到的仍是出厂门控。
 */
export function chatClassislandAct(endpoint: string): string {
  return `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const state = await window.aurora.settings.get()
    if (!state.ok) return { ok: false, reason: state.message }
    const result = await window.aurora.settings.update({
      modes: {
        classroom: {
          ...state.value.modes.classroom,
          schedule: {
            ...state.value.modes.classroom.schedule,
            provider: 'classisland',
            classisland: {
              ...state.value.modes.classroom.schedule.classisland,
              source: 'file',
              endpoint: ${JSON.stringify(endpoint)},
            },
          },
        },
      },
    })
    if (!result.ok) return { ok: false, reason: result.message }
    // 等卡片按 watch(showClassislandCard) 拉一次 classisland:status
    for (let attempt = 0; attempt < 15; attempt += 1) {
      if (document.querySelector('[data-field="context.classisland-card"]') !== null) break
      await wait(150)
    }
    return { ok: true, endpoint: ${JSON.stringify(endpoint)} }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`
}

/**
 * 课堂状态卡探针：卡在、上课中徽章在、当前与下节课都带上了时段（v3 新增字段的落点）。
 * 收尾把课表来源还原成 `manual`，避免污染后续场景。
 */
export const CHAT_CLASSISLAND_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const text = (selector) => {
      const el = document.querySelector(selector)
      return el === null ? '' : (el.textContent || '').replace(/\\s+/g, ' ').trim()
    }
    const current = text('[data-field="context.classisland-current"]')
    const next = text('[data-field="context.classisland-next"]')
    const result = {
      card: count('[data-field="context.classisland-card"]'),
      onClass: count('[data-field="context.classisland-onclass"]'),
      current,
      next,
      empty: count('[data-field="context.classisland-empty"]'),
      pass:
        count('[data-field="context.classisland-card"]') === 1 &&
        count('[data-field="context.classisland-onclass"]') === 1 &&
        current.indexOf('数学') !== -1 &&
        current.indexOf('08:00') !== -1 &&
        next.indexOf('语文') !== -1 &&
        next.indexOf('09:20') !== -1 &&
        count('[data-field="context.classisland-empty"]') === 0,
    }
    const state = await window.aurora.settings.get()
    if (state.ok) {
      await window.aurora.settings.update({
        modes: {
          classroom: {
            ...state.value.modes.classroom,
            schedule: { ...state.value.modes.classroom.schedule, provider: 'manual' },
          },
        },
      })
    }
    await wait(250)
    result.restored = count('[data-field="context.classisland-card"]') === 0
    result.pass = result.pass === true && result.restored === true
    return result
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 项目机制探针用的临时项目根（v13，docs/06 §5.1）。
 *
 * 每次跑 capture 都用同一个 userData 下的固定目录，可重复跑；场景的 `prepare` 里先建出它，
 * 让"项目根可用"这个健康态成立 —— 否则右栏卡片会渲染成"项目目录不可用"警示态，
 * 那条 pass 断言就会把警示态当健康态通过（假 PASS）。
 */
export function captureProjectRoot(userData: string): string {
  return join(userData, 'capture-project')
}

/**
 * 与 `captureProjectRoot` 同父目录、但**从不创建**的路径（v13，docs/06 §5.1）。
 * 用来验"项目根失效要有可见提示"（假设 7）：把当前项目的 root 指向它，界面必须显示警示态。
 */
export function captureMissingProjectRoot(userData: string): string {
  return join(userData, 'capture-project-missing')
}

/**
 * 种一份**真实**的文件快照（v14，docs/06 §11.8），供快照相关场景断言
 * （`chat-snapshot-card-removed.png`：主界面右栏不再有快照卡；
 * `settings-snapshot-list.png`：设置页 Agent 页的备份列表）。
 *
 * 走真实端口（`createNodeFileSnapshotPort` 的默认实现）而不是手写 `index.json`：
 * 手写的夹具只能证明"界面会渲染 json"，证明不了"写文件时真的会留底"。
 */
export async function seedSnapshotFixture(userData: string): Promise<string> {
  const dir = join(userData, 'capture-snapshot-demo')
  await mkdir(dir, { recursive: true })
  const target = join(dir, '报告.txt')
  await writeFile(target, '这是被 Agent 改写之前的原文。\n', 'utf8')
  const port = createFileSnapshotPort({
    dir: join(userData, 'backups'),
    fs: nodeFileSystem,
    logger: createNoopLogger(),
  })
  await port.capture({
    sessionId: 'capture',
    path: target,
    origin: 'write_file',
    mode: 'overwrite',
  })
  // ⚠️ 索引是 300ms 防抖写的：不 flush 的话渲染层 reload 后读到的是**空索引**，
  // 场景就会以"没有记录"假 FAIL（验收标准里专门点了这一条）。
  await port.flush()
  return target
}

/**
 * 把「当前项目」指向临时目录（v13，docs/06 §5.1）。
 *
 * 必须走 `settings:update` IPC：`SettingsStore.init()` 启动即把 config.json 读进内存并长期缓存，
 * 启动后写文件对运行中的进程无效。`projects` 是顶层浅合并，但 `list` 是数组整体权威 ——
 * 所以这里显式给出**完整**的 projects 子树（其余键从当前配置展开，不动 `maxAgentsBytes`）。
 * `check` 收尾会还原成"无项目"，后续场景读到的仍是出厂门控。
 */
export function chatProjectAct(root: string, name: string): string {
  return `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const state = await window.aurora.settings.get()
    if (!state.ok) return { ok: false, reason: state.message }
    if (state.value.projects.current !== 'capture') {
      const result = await window.aurora.settings.update({
        projects: {
          ...state.value.projects,
          current: 'capture',
          list: [{ id: 'capture', name: ${JSON.stringify(name)}, root: ${JSON.stringify(root)} }],
        },
      })
      if (!result.ok) return { ok: false, reason: result.message }
      // 等渲染层 store 收到 settings:changed 广播后重算卡片
      await wait(400)
    }
    let cardShown = false
    for (let attempt = 0; attempt < 15 && !cardShown; attempt += 1) {
      cardShown = document.querySelector('[data-field="context.project-card"]') !== null
      if (!cardShown) await wait(200)
    }
    return { ok: true, cardShown }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`
}

/**
 * 右栏「当前项目」卡探针（v13，docs/06 §5.1）：卡恰好一张、文本含项目名与根目录、
 * **不是**"项目目录不可用"警示态；收尾还原成无项目并把 restored 并入 pass。
 */
export function chatProjectCardCheck(name: string, missingRoot: string): string {
  return `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const text = (selector) => {
      const el = document.querySelector(selector)
      return el === null ? '' : (el.textContent || '').replace(/\\s+/g, ' ').trim()
    }
    const cardText = text('[data-field="context.project-card"]')
    const result = {
      card: count('[data-field="context.project-card"]'),
      cardText,
      unavailable: count('[data-field="context.project-unavailable"]'),
      pass:
        count('[data-field="context.project-card"]') === 1 &&
        cardText.indexOf(${JSON.stringify(name)}) !== -1 &&
        cardText.indexOf('capture-project') !== -1 &&
        // prepare 已建出真实目录：这里必须是健康态，警示徽标一个都不该有
        count('[data-field="context.project-unavailable"]') === 0,
    }

    // 第二阶段（假设 7）：把项目根改成一个**不存在**的目录，断言警示态真的出现 ——
    // 只在日志里 warn 而界面没提示，用户会以为 AGENTS.md 生效了却什么都没发生。
    // 判据两条：卡仍在（项目还登记着）+ 警示徽标恰好一个 + 文案里出现「不可用」。
    const before = await window.aurora.settings.get()
    if (before.ok && before.value.projects.current === 'capture') {
      await window.aurora.settings.update({
        projects: {
          ...before.value.projects,
          list: [{ id: 'capture', name: ${JSON.stringify(name)}, root: ${JSON.stringify(missingRoot)} }],
        },
      })
      let warned = false
      for (let attempt = 0; attempt < 15 && !warned; attempt += 1) {
        warned = count('[data-field="context.project-unavailable"]') === 1
        if (!warned) await wait(200)
      }
      result.warningCard = count('[data-field="context.project-card"]')
      result.warningShown = warned
      result.warningText = text('[data-field="context.project-card"]').indexOf('项目目录不可用') !== -1
      result.pass = result.pass === true && warned === true && result.warningText === true
    } else {
      result.warningShown = null
      result.pass = false
    }

    const state = await window.aurora.settings.get()
    if (state.ok) {
      await window.aurora.settings.update({
        projects: { ...state.value.projects, current: '', list: [] },
      })
    }
    await wait(250)
    result.restored = count('[data-field="context.project-card"]') === 0
    result.pass = result.pass === true && result.restored === true
    return result
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`
}

/**
 * 「文件备份」卡移出主界面的探针（2026-09 UI 收拢，回滚 UI 迁设置页 Agent 页）。
 *
 * `prepare` 仍然种一份**真实**快照（见 `seedSnapshotFixture`）—— 反例现场必须有数据：
 * 即便备份存在，主界面右栏也不该再出现任何快照卡（`chat.snapshot-card`）。
 * 快照列表本身的正例断言见 `settings-snapshot-list.png` 场景（SETTINGS_SNAPSHOT_LIST_*）。
 */
export const CHAT_SNAPSHOT_CARD_REMOVED_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    // 等一拍：右栏是感知数据驱动渲染，稳定后再数，避免首帧竞态
    await wait(800)
    return {
      card: count('[data-field="chat.snapshot-card"]'),
      restore: count('[data-field="chat.snapshot-restore"]'),
      agentRestore: count('[data-field="agent.snapshot-restore"]'),
      pass:
        count('[data-field="chat.snapshot-card"]') === 0 &&
        count('[data-field="chat.snapshot-restore"]') === 0 &&
        // 设置页的新锚点也不该泄漏进主界面（防止有人把组件挂错了窗口）
        count('[data-field="agent.snapshot-restore"]') === 0,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 设置页「文件备份」列表探针（2026-09，回滚 UI 自主界面右栏迁入 Agent 页）。
 *
 * `prepare` 已种好一份真实快照（见 `seedSnapshotFixture`），这里断言：
 * 列表在、至少一条记录、条目的文件名与来源都渲染出来了，并且点一次「回滚」只停在
 * 「确认回滚？」（**两段式**）—— 截图正好拍到这个中间态；同时确认「刷新 / 立即清理」
 * 两个操作入口都在。锚点已从 `chat.snapshot-*` 统一改名 `agent.snapshot-*`。
 */
export const SETTINGS_SNAPSHOT_LIST_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    let button = null
    for (let attempt = 0; attempt < 15 && button === null; attempt += 1) {
      button = document.querySelector('[data-field="agent.snapshot-restore"]')
      if (button === null) await wait(200)
    }
    if (button === null) return { ok: false, reason: 'agent.snapshot-restore 未出现（快照没种上？）' }
    const before = (button.textContent || '').trim()
    button.click()
    await wait(200)
    const after = (document.querySelector('[data-field="agent.snapshot-restore"]').textContent || '').trim()
    return { ok: true, before, after }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`

export const SETTINGS_SNAPSHOT_LIST_CHECK = `(async () => {
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const list = document.querySelector('[data-field="agent.snapshot-list"]')
    const text = list === null ? '' : (list.textContent || '').replace(/\\s+/g, ' ').trim()
    const rows = count('[data-field="agent.snapshot-restore"]')
    const button = document.querySelector('[data-field="agent.snapshot-restore"]')
    const label = button === null ? '' : (button.textContent || '').trim()
    return {
      list: count('[data-field="agent.snapshot-list"]'),
      rows,
      prune: count('[data-field="agent.snapshot-prune"]'),
      refresh: count('[data-action="agent.snapshot-refresh"]'),
      text,
      label,
      pass:
        // 列表恰好一个 + 至少一条记录（不写死条数：环形保留的份数随配置走）
        count('[data-field="agent.snapshot-list"]') === 1 &&
        rows >= 1 &&
        text.indexOf('写文件') !== -1 &&
        // 种下的快照来自 write_file，来源列必须译成中文
        text.indexOf('回滚') !== -1 &&
        // 清理 / 刷新两个操作入口都得在（清理走两段式，按钮文案此刻仍是「立即清理」）
        count('[data-field="agent.snapshot-prune"]') === 1 &&
        count('[data-action="agent.snapshot-refresh"]') === 1 &&
        // 两段式：act 点过一次，这里必须是待确认文案（截图拍的就是这个状态）
        label.indexOf('确认回滚') !== -1,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 种一条 `paused` 的 job（v15，docs/06 §4.1），供 `chat-job-panel.png` 场景断言。
 *
 * 直接写文件（而不是走进程内的 `JobStore.create`）：这里要造的是「**上一次启动留下的** paused job」，
 * 这条记录必须先于进程内的 job 存储存在，才等价于"重启后还能续跑"的现场。
 * 场景的 `prepare` 会在种完之后 `reload('chat')`，让任务面板**重新挂载并首读**这份文件 ——
 * 面板只在挂载时拉一次列表，不 reload 就什么都看不到。
 */
export async function seedJobFixture(userData: string, sessionId = 'main'): Promise<string> {
  const dir = join(userData, 'jobs')
  await mkdir(dir, { recursive: true })
  const now = new Date().toISOString()
  const job = {
    id: 'job-capture-paused-1',
    sessionId,
    status: 'paused',
    origin: 'chat',
    text: '帮我把这份课表整理成一张表',
    round: 1,
    maxRounds: 2,
    stepsDone: [
      { round: 0, tool: 'read_file', ok: true, at: now },
      { round: 1, tool: 'write_file', ok: true, at: now },
    ],
    todos: [
      { id: 't1', text: '读取原始课表', status: 'completed' },
      { id: 't2', text: '生成整理后的表格', status: 'in_progress' },
    ],
    cursor: { nextRound: 2, note: '轮次用尽，等待用户继续' },
    budget: { maxTotalTokens: 0, usedTokens: 1284, autoContinued: 0 },
    pendingReason: 'max-rounds',
    createdAt: now,
    updatedAt: now,
  }
  await writeFile(
    join(dir, `${sessionId}.json`),
    JSON.stringify({ version: 1, jobs: [job] }),
    'utf8',
  )
  return join(dir, `${sessionId}.json`)
}

/**
 * 「任务」面板探针（v15，docs/06 §4.1）：**只读**断言 —— 面板在、状态是「已暂停」、
 * 暂停原因、步骤痕迹与「继续」按钮都渲染出来了。**不点任何按钮**：点「继续」会真的发起续跑，
 * 那需要模型服务，不是截图阶段该干的事。
 */
export const CHAT_JOB_PANEL_CHECK = `(async () => {
  try {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    let panel = null
    for (let attempt = 0; attempt < 20 && panel === null; attempt += 1) {
      panel = document.querySelector('[data-field="chat.job-panel"]')
      if (panel === null) await wait(150)
    }
    const text = panel === null ? '' : (panel.textContent || '').replace(/\\s+/g, ' ').trim()
    const items = document.querySelectorAll('[data-field="chat.job-item"]').length
    const resume = document.querySelector('[data-field="chat.job-resume"]')
    return {
      panel: panel === null ? 0 : 1,
      items,
      text,
      resume: resume === null ? 0 : 1,
      resumeLabel: resume === null ? '' : (resume.textContent || '').trim(),
      pass:
        panel !== null &&
        items >= 1 &&
        text.indexOf('已暂停') !== -1 &&
        // 暂停原因必须说清「停在哪」，而不是一句含糊的「未完成」
        text.indexOf('轮次上限') !== -1 &&
        // 面板的价值是「看得见进度」：步骤痕迹与 token 用量都要在
        text.indexOf('read_file') !== -1 &&
        text.indexOf('token') !== -1 &&
        resume !== null,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 综合概览卡的探针（step 5）：右栏同时出现「当前项目 + 任务」两张卡。
 *
 * 断言的是**布局不冲突**：两卡各自恰好一张、都渲染出来了，且任务卡显示的是真内容
 * （单独场景各自证明过"这张卡能出现"，这一张证明"多卡同时出现时不会互相挤掉"）。
 * 「文件备份」卡已迁设置页：这里顺带断言右栏不再出现快照卡（回归护栏）。
 */
export const CHAT_OVERVIEW_CHECK = `(async () => {
  try {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const count = (selector) => document.querySelectorAll(selector).length
    let ready = false
    for (let attempt = 0; attempt < 20 && !ready; attempt += 1) {
      ready =
        count('[data-field="context.project-card"]') === 1 &&
        count('[data-field="chat.job-panel"]') === 1
      if (!ready) await wait(150)
    }
    const panel = document.querySelector('[data-field="chat.job-panel"]')
    const text = panel === null ? '' : (panel.textContent || '').replace(/\\s+/g, ' ').trim()
    return {
      project: count('[data-field="context.project-card"]'),
      snapshots: count('[data-field="chat.snapshot-card"]'),
      jobs: count('[data-field="chat.job-panel"]'),
      text,
      pass:
        count('[data-field="context.project-card"]') === 1 &&
        count('[data-field="chat.job-panel"]') === 1 &&
        // 快照卡已迁设置页（SnapshotList），右栏必须为 0
        count('[data-field="chat.snapshot-card"]') === 0 &&
        text.indexOf('已暂停') !== -1,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 「子代理」页面探针（docs/07 §2.3：子代理独立页面记在主界面小节里；`§2.4` 那个编号
 * 随小 AI 交互窗删除而移除，见 docs/07 开头的编号说明）。
 *
 * act 点左栏固定项 `[data-field="chat.subagent-item"]` 把主区切到子代理页面；
 * check 断言：页面在、命中 seed 的那 1 次运行（`chat.subagent-run`）、轨迹有进度条 +
 * 步骤时间线 + 报告，并且**切回对话流**（后续场景依赖 composer 与消息区）。
 *
 * 快照来自 `seedChatTtsHistory` 种下的 `task` 工具卡（含 `subagent` 字段）——
 * 也就是说这条断言同时验证了「快照随工具卡持久化 → 由子代理页面读回」这条链路，
 * 而不只是「实时事件画得出来」。
 */
export const CHAT_SUBAGENT_OPEN_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const item = document.querySelector('[data-field="chat.subagent-item"]')
    if (item === null) return { clicked: false, reason: 'no [data-field="chat.subagent-item"]' }
    item.click()
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (document.querySelector('[data-field="chat.subagent-page"]') !== null) break
      await wait(100)
    }
    return { clicked: true }
  } catch (error) {
    return { clicked: false, reason: String(error) }
  }
})()`

export const CHAT_SUBAGENT_OPEN_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const page = document.querySelector('[data-field="chat.subagent-page"]')
    const runs = count('[data-field="chat.subagent-run"]')
    const steps = count('.trace-step')
    const reports = document.querySelectorAll('[data-field="chat.subagent-report"]')
    const reportText = reports.length > 0 ? (reports[0].textContent || '').trim() : ''
    const result = {
      page: page !== null,
      runs,
      steps,
      reportChars: reportText.length,
      bar: count('.trace-bar'),
      summary: count('[data-field="chat.subagent-summary"]'),
      // 导航项此时应是激活态（否则说明 view 状态没接上）
      navActive:
        document.querySelector('[data-field="chat.subagent-item"]') !== null &&
        document.querySelector('[data-field="chat.subagent-item"]').classList.contains('active'),
      pass:
        page !== null &&
        runs === 1 &&
        steps >= 3 &&
        reportText.length > 10 &&
        count('.trace-bar') === 1,
    }
    // 收尾：切回对话流（composer 与消息区必须在后续场景里可用）
    const back = document.querySelector('[data-action="chat.subagent-back"]')
    if (back !== null) back.click()
    await wait(250)
    result.restored = document.querySelector('[data-field="chat.subagent-page"]') === null
    result.pass = result.pass === true && result.navActive === true && result.restored === true
    return result
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 「自动化」页面探针组（docs/13 §11、docs/07 §5.3）：四个场景共用一次进入（chat-automation
 * 打开页面 → chat-automation-normal 切 Normal tab 看内置区 → chat-automation-editor 开编辑器
 * → chat-automation-history 开历史并回放 Agent 运行），最后一张收尾时点「返回对话」还原主区。
 *
 * 数据来自 `seedAutomationFixture` 种下的 1 份 Normal 定义 + 2 条历史（normal / agent 各一条，
 * agent 记录指向 seed 的 `auto-capture1` 会话），使列表 / 历史 / 回放都有可视证据。
 */
export const CHAT_AUTOMATION_OPEN_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const item = document.querySelector('[data-field="chat.auto-item"]')
    if (item === null) return { clicked: false, reason: 'no [data-field="chat.auto-item"]' }
    item.click()
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (document.querySelector('[data-field="automation.page"]') !== null) break
      await wait(100)
    }
    await wait(300)
    return { clicked: true }
  } catch (error) {
    return { clicked: false, reason: String(error) }
  }
})()`

export const CHAT_AUTOMATION_OPEN_CHECK = `(() => {
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const page = document.querySelector('[data-field="automation.page"]')
    const tabAgent = document.querySelector('[data-field="automation.tab-agent"]')
    const tabNormal = document.querySelector('[data-field="automation.tab-normal"]')
    const historyBtn = document.querySelector('[data-action="automation.history"]')
    const newBtn = document.querySelector('[data-action="automation.new"]')
    const backBtn = document.querySelector('[data-action="automation-back"]')
    return {
      page: page !== null,
      tabAgent: tabAgent !== null,
      tabNormal: tabNormal !== null,
      historyBtn: historyBtn !== null,
      newBtn: newBtn !== null,
      backBtn: backBtn !== null,
      navActive:
        document.querySelector('[data-field="chat.auto-item"]') !== null &&
        document.querySelector('[data-field="chat.auto-item"]').classList.contains('active'),
      pass:
        page !== null &&
        tabAgent !== null &&
        tabNormal !== null &&
        historyBtn !== null &&
        newBtn !== null &&
        backBtn !== null,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

export const CHAT_AUTOMATION_NORMAL_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const tab = document.querySelector('[data-field="automation.tab-normal"]')
    if (tab === null) return { clicked: false, reason: 'no tab-normal' }
    tab.click()
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (document.querySelector('[data-field="automation.builtin"]') !== null) break
      await wait(100)
    }
    await wait(250)
    return { clicked: true }
  } catch (error) {
    return { clicked: false, reason: String(error) }
  }
})()`

export const CHAT_AUTOMATION_NORMAL_CHECK = `(() => {
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const builtin = document.querySelector('[data-field="automation.builtin"]')
    const builtinToggles = count('[data-field="automation.builtin-toggle"]')
    // seed 的 Normal 定义（am-capture1）出现在列表里
    const seededItem = count('[data-field="automation.item-am-capture1"]')
    const toggles = count('[data-field="automation.toggle"]')
    return {
      builtin: builtin !== null,
      builtinToggles,
      seededItem,
      toggles,
      pass:
        builtin !== null &&
        builtinToggles === 2 &&
        seededItem === 1 &&
        toggles === 1,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

export const CHAT_AUTOMATION_EDITOR_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const btn = document.querySelector('[data-action="automation.new"]')
    if (btn === null) return { clicked: false, reason: 'no automation.new' }
    btn.click()
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (document.querySelector('[data-field="automation.editor"]') !== null) break
      await wait(100)
    }
    await wait(200)
    return { clicked: true }
  } catch (error) {
    return { clicked: false, reason: String(error) }
  }
})()`

export const CHAT_AUTOMATION_EDITOR_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const editor = document.querySelector('[data-field="automation.editor"]')
    const kindSelect = document.querySelector('[data-field="automation.trigger-kind"]')
    const optionCount = kindSelect === null ? 0 : kindSelect.querySelectorAll('option').length
    const actionSelect = count('[data-field^="automation.action-"] select')
    const nameInput = editor === null ? null : editor.querySelector('input[type="text"]')
    const numberField = count('[data-field="automation.editor"] input[type="number"]')
    const result = {
      editor: editor !== null,
      triggerOptions: optionCount,
      actionSelect,
      hasName: nameInput !== null,
      numberField,
    }
    // Esc 关闭（弹窗的标准键盘路径）：派发到 window，组件监听器接住后应关掉编辑器
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wait(200)
    result.escClosed = document.querySelector('[data-field="automation.editor"]') === null
    // 收尾：若 Esc 未生效（回归时）再点「取消」，保证后续场景能继续操作列表
    if (result.escClosed !== true) {
      const cancel = document.querySelector('[data-action="automation.editor-cancel"]')
      if (cancel !== null) cancel.click()
      await wait(200)
    }
    result.restored = document.querySelector('[data-field="automation.editor"]') === null
    result.pass =
      editor !== null &&
      optionCount >= 7 &&
      actionSelect >= 1 &&
      result.hasName === true &&
      result.escClosed === true &&
      result.restored === true
    return result
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

export const CHAT_AUTOMATION_HISTORY_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    // 历史面板按当前 tab 过滤（产品口径）：先切到 Agent tab，面板里才有可回放的 Agent 记录
    const tab = document.querySelector('[data-field="automation.tab-agent"]')
    if (tab !== null) {
      tab.click()
      await wait(200)
    }
    const btn = document.querySelector('[data-action="automation.history"]')
    if (btn === null) return { clicked: false, reason: 'no automation.history' }
    btn.click()
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (document.querySelector('[data-field="automation.history-panel"]') !== null) break
      await wait(100)
    }
    await wait(250)
    // 点开第一条可回放的 Agent 记录：截图本身要能看到「点记录 → 对话回放」这块证据
    const row = document.querySelector('.run-item.clickable')
    if (row !== null) {
      row.click()
      for (let attempt = 0; attempt < 25; attempt += 1) {
        if (document.querySelectorAll('.detail-message').length >= 2) break
        await wait(150)
      }
      await wait(200)
    }
    return { clicked: true, opened: row !== null }
  } catch (error) {
    return { clicked: false, reason: String(error) }
  }
})()`

export const CHAT_AUTOMATION_HISTORY_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const panel = document.querySelector('[data-field="automation.history-panel"]')
    const panelText = panel === null ? '' : panel.textContent || ''
    // Agent tab 的历史：记录可点开回放（点开 → 出现对话气泡，且能看到 seed 的探针标记）
    const agentRuns = count('.run-item')
    const clickable = count('.run-item.clickable')
    let detailMessages = 0
    const agentRow = document.querySelector('.run-item.clickable')
    if (agentRow !== null) {
      agentRow.click()
      for (let attempt = 0; attempt < 25; attempt += 1) {
        if (count('.detail-message') >= 2) break
        await wait(150)
      }
      detailMessages = count('.detail-message')
    }
    const panelAfter = document.querySelector('[data-field="automation.history-panel"]')
    const agentMarker =
      panelAfter !== null &&
      ((panelAfter.textContent || '').indexOf('capture-automation-run') !== -1)

    // Normal tab 的历史：**只显示触发时间与状态**（无详情层，产品口径 docs/13 §11）
    const closeAgent = document.querySelector('[data-action="automation.history-close"]')
    if (closeAgent !== null) closeAgent.click()
    await wait(200)
    const tabNormal = document.querySelector('[data-field="automation.tab-normal"]')
    if (tabNormal !== null) {
      tabNormal.click()
      await wait(200)
    }
    const historyBtn = document.querySelector('[data-action="automation.history"]')
    if (historyBtn !== null) historyBtn.click()
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (count('.run-item') > 0) break
      await wait(120)
    }
    const normalRuns = count('.run-item')
    const normalClickable = count('.run-item.clickable')
    const normalHasTime = count('.run-time') > 0
    const normalStatuses = Array.from(document.querySelectorAll('.run-status')).map((el) =>
      (el.textContent || '').trim(),
    )

    // 收尾：关弹窗 → 点「返回对话」还原主区（后续 chat-classisland-status 等场景依赖对话流）
    const closeNormal = document.querySelector('[data-action="automation.history-close"]')
    if (closeNormal !== null) closeNormal.click()
    await wait(200)
    const back = document.querySelector('[data-action="automation-back"]')
    if (back !== null) back.click()
    await wait(250)
    const restored = document.querySelector('[data-field="automation.page"]') === null
    const result = {
      panel: panel !== null,
      agentRuns,
      clickable,
      detailMessages,
      agentMarker,
      normalRuns,
      normalClickable,
      normalHasTime,
      normalStatuses,
      restored,
      pass:
        panel !== null &&
        agentRuns >= 1 &&
        clickable >= 1 &&
        detailMessages >= 2 &&
        agentMarker === true &&
        normalRuns >= 1 &&
        normalClickable === 0 &&
        normalHasTime === true &&
        restored === true,
    }
    void panelText
    return result
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 主界面左栏结构 + 门控探针（BetaV2，spec §11）：三栏重构后左栏的固定锚点必须全部在。
 *
 * 断言六件事：
 * ① 左栏三件套：`chat.quick-item`（固定顶置的「快速对话」）、`chat.session-list`（会话列表
 *    容器，且**有会话行**——隔离 userData 由 `seedChatTtsHistory` 种了 main 会话）、
 *    `data-action="chat.new-session"`；
 * ② 右栏开关 `chat.right-panel-toggle` 在，且右栏 `.context` 默认展开（1120px 宽三栏并存）、
 *    classroom 模式的「今日课程」与通用「系统状态」两张卡都渲染
 *    （ContextPanel 无 data-field 锚点，按卡头文案定位）；
 * ③ **麦克风门控**：`stt` 未配置时 `[data-field="chat.mic"]` 必须**不存在**
 *    （docs/07 §2.3 口径：连按钮都不渲染，不是 disabled）——反向断言，数到就是坏；
 * ④ 主区标题 `.head-name` 非空（默认 main 会话无用户消息 → 显示「新会话」，不作硬断言只回传）；
 * ⑤ **窗口按钮**：`data-caption-btn="minimize"` 与 `"close"` 两枚都渲染（Windows 式标题栏）；
 * ⑥ **结构化工具卡**：seed 的 todo_write 渲染 `data-field="chat.todo-card"`（3 行条目）、
 *    task 渲染 `data-field="chat.task-card"`；右栏任务清单卡 `context.todo-card` 必须在。
 *
 * 本场景不改任何状态，排在 chat 场景最前（theme-chat 之后、一切改配置/改会话的场景之前），
 * 保证读到的是出厂门控现场。
 */
export const CHAT_SIDEBAR_SCRIPT = `(() => {
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const visible = (el) => {
      if (el === null) return false
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }
    const quickItem = document.querySelector('[data-field="chat.quick-item"]')
    const sessionList = document.querySelector('[data-field="chat.session-list"]')
    const rightToggle = document.querySelector('[data-field="chat.right-panel-toggle"]')
    const context = document.querySelector('.context')
    const ctxCards = Array.from(
      document.querySelectorAll('.context .ctx-card .ctx-head strong'),
    ).map((el) => (el.textContent || '').trim())
    const headName = (
      (document.querySelector('.head-name') || {}).textContent || ''
    ).trim()
    const todoRows = count('[data-field="chat.todo-card"] .todo-row')
    return {
      headTitle: headName,
      quickItem: quickItem !== null,
      quickActive: quickItem === null ? null : quickItem.classList.contains('active'),
      subagentItem: count('[data-field="chat.subagent-item"]'),
      subagentCount: count('[data-field="chat.subagent-count"]'),
      sessionList: sessionList !== null,
      sessionListVisible: visible(sessionList),
      sessionRows: count('[data-field="chat.session-list"] .nav-item'),
      newSessionButton: count('[data-action="chat.new-session"]'),
      rightToggle: rightToggle !== null,
      contextCollapsed: context === null ? null : context.classList.contains('collapsed'),
      contextCards: ctxCards,
      todoCard: count('[data-field="chat.todo-card"]'),
      todoRows,
      taskCard: count('[data-field="chat.task-card"]'),
      // 工具卡语义图标（lucide）：每张卡头恰好一枚，数少了说明图标没渲染、
      // 数多了说明把状态点也画成了 svg（那会挤掉标题的横向空间）
      toolIcons: count('.tool-card .tool-head .tool-icon'),
      toolCards: count('.tool-card'),
      captionMinimize: count('[data-caption-btn="minimize"]'),
      captionClose: count('[data-caption-btn="close"]'),
      // stt 未配置（enabled=false 且无 provider）时麦克风必须不存在：探针不改 stt 配置，
      // 所以这里恒为 0；若渲染层把门控写成 disabled 而不是不渲染，这条就会失败。
      micCount: count('[data-field="chat.mic"]'),
      pass:
        quickItem !== null &&
        sessionList !== null &&
        visible(sessionList) &&
        count('[data-field="chat.session-list"] .nav-item') > 0 &&
        count('[data-action="chat.new-session"]') > 0 &&
        rightToggle !== null &&
        context !== null &&
        context.classList.contains('collapsed') === false &&
        ctxCards.some((name) => name.indexOf('系统状态') !== -1) &&
        ctxCards.some((name) => name.indexOf('今日课程') !== -1) &&
        ctxCards.some((name) => name.indexOf('任务清单') !== -1) &&
        count('[data-field="context.todo-card"]') > 0 &&
        todoRows === 3 &&
        count('[data-field="chat.task-card"]') > 0 &&
        count('[data-field="chat.subagent-item"]') === 1 &&
        count('[data-field="chat.subagent-count"]') === 1 &&
        count('.tool-card .tool-head .tool-icon') === count('.tool-card') &&
        count('[data-caption-btn="minimize"]') > 0 &&
        count('[data-caption-btn="close"]') > 0 &&
        count('[data-field="chat.mic"]') === 0,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 输入框（composer）探针 · 前半（2026-09 输入框重做，docs/07 §2.3）：斜杠命令浮层 + 权限钮 + 上下文条。
 *
 * act 把 textarea 的内容设成单个斜杠（走真实 input 事件 → v-model → slashQuery），
 * 截图即「命令浮层展开」现场。
 *
 * check 断言四件事：
 * ① 浮层 `chat.slash-menu` 在，且含内置命令项（`chat.slash-new`）与技能分组（有技能时）；
 * ② 权限钮 `chat.permission` 在，文案必须是「变更前确认」——隔离 userData 的默认值
 *    （`confirmSensitiveTools: true`），读错档位等于闸门状态显示错误；
 * ③ 上下文条 `chat.context` 在，且 `chat.context-usage` 显示「暂无用量数据」：
 *    离线跑没有真实 LLM，也就没有 usage 事件 —— 这条同时钉住「没有用量就不编造 token 数」；
 * ④ **textarea 自动增高**：塞 8 行文本后高度明显变大且不超过 CSS 上限，清空后回到一行高。
 *
 * 收尾清空输入框（后续场景依赖空输入），且本场景**不改任何配置**。
 */
export const CHAT_COMPOSER_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const box = document.querySelector('.composer-input')
    if (box === null) return { ready: false, reason: 'composer-input 不存在' }
    box.focus()
    box.value = '/'
    box.dispatchEvent(new Event('input', { bubbles: true }))
    // 技能清单来自 skills:list（渲染层 onMounted 发起）：轮询等技能分组出现再截图，
    // 否则扫描慢一点就会拍到一个只有命令组的浮层，check 里的技能断言随之假 FAIL。
    let skills = 0
    for (let attempt = 0; attempt < 12 && skills === 0; attempt += 1) {
      skills = document.querySelectorAll('[data-kind="skill"]').length
      if (skills === 0) await wait(250)
    }
    return { ready: true, skillItems: skills }
  } catch (error) {
    return { ready: false, reason: String(error) }
  }
})()`

export const CHAT_COMPOSER_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const textOf = (selector) => {
      const el = document.querySelector(selector)
      return el === null ? '' : (el.textContent || '').trim()
    }
    // 浮层相关的计数必须在**动 textarea 之前**取完：下面测自动增高时会把输入清空，
    // 一清空斜杠浮层就自行关闭（slashQuery 不再匹配），此时再查就是 0（这条踩过一次）。
    const menu = document.querySelector('[data-field="chat.slash-menu"]')
    const slashItems = count('[data-field="chat.slash-menu"] .slash-item')
    const slashNew = count('[data-field="chat.slash-new"]')
    const slashCommandItems = count('[data-field="chat.slash-menu"] [data-kind="command"]')
    const slashSkillItems = count('[data-field="chat.slash-menu"] [data-kind="skill"]')
    const permissionLabel = textOf('[data-field="chat.permission"]')
    const usageText = textOf('[data-field="chat.context-usage"]')

    // 自动增高：独立 try —— 一个探针不该因为某一步抛错就整条返回 undefined
    //（executeJavaScript 会把它当成「脚本执行失败」，报告里只剩一句无信息量的话）
    const grow = { oneLine: 0, grown: 0, capped: 0, reset: 0, scrolls: false, error: null }
    const box = document.querySelector('.composer-input')
    if (box === null) {
      grow.error = 'no .composer-input'
    } else {
      try {
        const fill = async (count) => {
          const lines = []
          for (let index = 0; index < count; index += 1) lines.push('第' + (index + 1) + ' 行内容')
          box.value = lines.join(String.fromCharCode(10))
          box.dispatchEvent(new Event('input', { bubbles: true }))
          await wait(300)
          return box.getBoundingClientRect().height
        }
        grow.oneLine = box.getBoundingClientRect().height
        grow.grown = await fill(8)
        // 30 行足以顶到 200px 上限：这一步同时钉住「上限之后不再长高」与「改为内部滚动」
        grow.capped = await fill(30)
        grow.scrolls = box.scrollHeight > box.clientHeight + 1
        box.value = ''
        box.dispatchEvent(new Event('input', { bubbles: true }))
        await wait(300)
        grow.reset = box.getBoundingClientRect().height
      } catch (inner) {
        grow.error = String(inner)
      }
    }

    return {
      slashMenu: menu !== null,
      slashItems,
      slashNew,
      slashCommandItems,
      slashSkillItems,
      permissionLabel,
      permissionMenuClosed: count('[data-field="chat.permission-menu"]'),
      contextBar: count('[data-field="chat.context"]'),
      contextUsage: usageText,
      grow,
      pass:
        menu !== null &&
        slashNew > 0 &&
        // 命令组恒有 4 条内置命令；技能组取决于内置 skills 目录（扫到几个列几个）
        slashCommandItems === 4 &&
        slashSkillItems >= 1 &&
        permissionLabel.indexOf('变更前确认') !== -1 &&
        count('[data-field="chat.permission-menu"]') === 0 &&
        count('[data-field="chat.context"]') === 1 &&
        usageText.indexOf('暂无用量数据') !== -1 &&
        grow.error === null &&
        grow.grown > grow.oneLine * 1.5 &&
        // 上限：30 行时必须停在 200px 附近（不能继续长高），且 overflow 生效（内部可滚）
        grow.capped >= 190 &&
        grow.capped <= 205 &&
        grow.grown <= grow.capped + 1 &&
        grow.scrolls === true &&
        grow.reset <= grow.oneLine + 2,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 输入框探针 · 后半：权限下拉的**两段式**关闭（照「一个误点不该摘掉确认闸门」的口径钉住）。
 *
 * act 点开 `chat.permission`（截图即下拉展开现场）；check 断言：
 * ① 下拉在、两个选项都在（变更前确认 / 完全权限）；
 * ② 点一次「完全权限」**不写配置**（只翻成二次确认文案），且 `settings:get` 回报的
 *    `confirmSensitiveTools` 仍是 true —— 这是本探针的核心：一次误点不能放权；
 * ③ 收尾再点一次权限钮把下拉关掉，**并确认配置一字未改**（为后续场景留干净状态）。
 */
/**
 * 输入框 → 真实（离线桩）模型往返探针（2026-09 输入框重做：**这是本轮唯一能验证
 * 「发出去 → 流式回来 → 落到 DOM」整条链路的探针**）。
 *
 * 为什么必须由 capture 承担：`AURORA_SMOKE` 的脚本跑在引导窗里，只能从事件层断言流式
 * （docs/06 §16.2 的 text / usage 事件），**读不到对话窗的 DOM**；而两个模式互斥（见
 * `index.ts` 的启动分支），所以「事件层对了、界面没画出来」这类问题只有这里能抓到。
 *
 * 由 `defaultCapturePlan` 在跑本场景前竖起本地桩 LLM 并把配置指向它（只在这一段生效，
 * 排在 chat 组最后，前面的场景读到的仍是「未配置模型」的出厂态）。
 *
 * act：把提示词写进 textarea → 点发送（走 `send()`，与用户手点同一条路径）→ 轮询等
 *      流式结束（`.thread.streaming` 摘掉）。截图即「一问一答 + 上下文条有真实 token」现场。
 * check 断言五件事：
 * ① 助手气泡出现且正文含桩服务的标记（回复真的画到了 DOM 上，而不只是事件里有）；
 * ② 用户气泡也在（发送路径把提问渲染出来了）；
 * ③ 上下文条显示**真实 token 数**（桩服务的结束片带 usage → 界面必须不再是「暂无用量数据」），
 *    且累计同样非零 —— 这条同时钉住 usage 事件 → useChat → 上下文条整条链；
 * ④ **缓存命中片段**（`data-field="chat.context-cache"`，docs/06 §21.4）：桩服务回传
 *    `prompt_tokens_details.cached_tokens = 512`，折叠态文案里必须出现「缓存命中 512（100%）」
 *    —— 512 = 分母 `promptTokens`，因此占比恰好 100%（桩数据自洽：`cached <= prompt`）。
 *    这条钉的是「字段解析 → 事件 → 展示」整条链里**最后一段**：解析丢了字段时这里没有该节点，
 *    百分比算错时数字对不上（`Math.min(100, …)` 夹住的那类荒谬值也因此不可能出现）；
 * ⑤ 流式已收尾（`.thread.streaming` 不存在），即「流式态不会卡住」。
 */
export function chatStreamAct(question: string): string {
  return `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const box = document.querySelector('.composer-input')
    if (box === null) return { ready: false, reason: 'composer-input 不存在' }
    const sendButton = document.querySelector('.composer-box [aria-label="发送"]')
    if (sendButton === null) return { ready: false, reason: '发送按钮不存在' }
    box.focus()
    box.value = ${JSON.stringify(question)}
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(200)
    sendButton.click()
    // 等整轮结束：流式类摘掉 + 至少一条助手消息
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const streaming = document.querySelector('.thread.streaming')
      const replied = document.querySelectorAll('.message.r-assistant').length > 0
      if (streaming === null && replied) return { ready: true, waited: attempt * 250 }
      await wait(250)
    }
    return { ready: false, reason: '等待流式结束超时' }
  } catch (error) {
    return { ready: false, reason: String(error) }
  }
})()`
}

export function chatStreamCheck(marker: string, reasoningMarker: string): string {
  // 先把两个标记求值成**真实 JS 字面量**（模板里只能插值，ESLint 看不到字符串里的引用）
  const markerLiteral = JSON.stringify(marker)
  const reasoningLiteral = JSON.stringify(reasoningMarker)
  return `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const textOf = (selector) => {
      const el = document.querySelector(selector)
      return el === null ? '' : (el.textContent || '').trim()
    }
    const assistants = Array.from(document.querySelectorAll('.message.r-assistant'))
    const reply = assistants.map((el) => (el.textContent || '').trim()).join(' | ')
    const users = document.querySelectorAll('.message.r-user').length
    const usageText = textOf('[data-field="chat.context-usage"]')
    const cacheText = textOf('[data-field="chat.context-cache"]')
    const totals = textOf('.ctx-total')
    const stillStreaming = document.querySelector('.thread.streaming') !== null
    // 思考增量归属（docs/06 §16.1）：思考块只在 message.reasoning 非空时渲染，
    // 因此「最后一条助手消息带思考块」= 桩服务产出的 reasoning 增量确实绑到了**它自己那条**消息上
    //（不是前一条、也不是没人要）。请求结束后块已收起为摘要行，所以只断言块头文案。
    const lastAssistant = assistants[assistants.length - 1]
    const lastThinking = lastAssistant === undefined ? null : lastAssistant.querySelector('.thinking')
    const lastThinkingLabel =
      lastThinking === null ? '' : (lastThinking.querySelector('.thinking-head')?.textContent ?? '').trim()
    // 展开它把思考正文读出来：请求结束后块是收起态，正文不在 DOM 里，得点开才看得到。
    // 这一步比「块存在」更硬 —— 它证明桩服务的 reasoning 增量**内容**真的落在这一条消息上。
    let lastThinkingText = ''
    if (lastThinking !== null) {
      const head = lastThinking.querySelector('.thinking-head')
      if (head !== null) head.click()
      await wait(350)
      const body = lastThinking.querySelector('.thinking-text')
      lastThinkingText = body === null ? '' : (body.textContent || '').trim()
      if (head !== null) head.click()
      await wait(150)
    }
    return {
      assistantCount: assistants.length,
      userCount: users,
      replyHasMarker: reply.indexOf(${markerLiteral}) !== -1,
      replyHead: reply.slice(0, 60),
      usageText,
      cacheText,
      totals,
      stillStreaming,
      lastThinkingLabel,
      lastThinkingHasMarker: lastThinkingText.indexOf(${reasoningLiteral}) !== -1,
      pass:
        assistants.length >= 1 &&
        users >= 1 &&
        reply.indexOf(${markerLiteral}) !== -1 &&
        // 桩服务的结束片带 usage：界面必须显示真实数字，而不是「暂无用量数据」
        usageText !== '' &&
        usageText.indexOf('暂无用量数据') === -1 &&
        /[0-9]/.test(usageText) &&
        /[0-9]/.test(totals) &&
        // 缓存命中片段（docs/06 §21.4）：桩服务固定回 512 命中 / 512 prompt，占比 100%。
        // 三个子串都要在 —— 只断言「含缓存命中」时，算错的分母（或丢了命中量只剩标题）
        // 照样能过；数字与占比是这条探针真正的信息量。
        cacheText.indexOf('缓存命中') !== -1 &&
        cacheText.indexOf('512') !== -1 &&
        cacheText.indexOf('100%') !== -1 &&
        stillStreaming === false &&
        lastThinkingLabel.indexOf('已深度思考') !== -1 &&
        lastThinkingText.indexOf(${reasoningLiteral}) !== -1,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`
}

/**
 * 爆发场景在渲染层存放观测结果的槽位（act 装仪器、check 读结果，两段脚本不共享作用域）
 */
const BURST_PROBE_SLOT = '__auroraStreamBurstProbe'

/** 心跳间隔（ms）：比帧间隔略粗，读的是「主线程还剩下多少空档」，不是帧率 */
const BURST_HEARTBEAT_MS = 20

/**
 * 爆发场景的 longtask 阈值（任务书要求的原始口径）。
 *
 * **它在本 BUG 上分辨不出差异**：Chromium 只上报单任务 > 50ms 的 longtask，而本 BUG 的代价
 * 形态是「每片几毫秒、5ms 一片 → 持续饱和」，单任务够不到 50ms 下限 —— 2026-09-26 实测
 * 修复前 0/0/0、修复后 1/50/0，两组都是「没有巨型卡顿」。因此它们只当兜底门限
 *（防止出现真正离谱的单次卡顿），真正参与判定的是下面的心跳 / 帧两组。
 *
 * 口径：修复后实测值 × 约 3 倍；实测为 0 的那项给绝对下限（0 × 3 = 0 会把机器抖动判成 FAIL）。
 */
const BURST_LONG_TASK_LIMITS = {
  count: 6,
  maxMs: 160,
  blockingMs: 150,
}

/**
 * 心跳 / 帧的口径阈值（2026-09-26 本机实测标定，修复后值 → 阈值）：
 *
 * | 指标 | 修复前 | 修复后 | 阈值 | 说明 |
 * | --- | --- | --- | --- | --- |
 * | maxUnhiddenHeartbeatMs | 661.4 | 51.0（四窗口全开 65） | 160 | **主判据**：3.1 倍余量 |
 * | heartbeatOverrunMs | 4749.4 | 108.8 | 1200 | 累计量，见下面的争用说明 |
 * | maxFrameGapMs | 137.5 | 29.2 | 110 | 3.8 倍余量，仍低于修复前值（能抓住回归） |
 * | droppedFrames | 238 | 0 | 25 | 修复后为 0，只能给绝对下限（约 0.4s 的掉帧代价） |
 *
 * 阈值按「修复后 × 约 3 倍」取宽松余量，防 CI 机器抖动假 FAIL（**`heartbeatOverrunMs` 例外**，
 * 见下）；数值随机器档位浮动，断言的只有数量级 —— 改桩的密度 / transcript 规模等于改基线的量纲，
 * 必须重新标定。
 *
 * **`heartbeatOverrunMs` 是累计量、对 CPU 争用明显更敏感**（同一份代码实测：只跑 chat 组 69ms、
 * 单独重跑 108ms、另一个代理并发跑时 182ms、**四窗口全开 552ms**；修复前是 4749ms）。
 * 因此它取 1200 —— 仍比修复前低约 4 倍，真回归照样 FAIL，但旁边多开两个窗口不会假 FAIL。
 * 需要判断「渲染是否跟不上」时看 `maxUnhiddenHeartbeatMs`（最坏单次，661 → 65，差一个数量级）。
 */
const BURST_LAG_LIMITS = {
  maxHeartbeatMs: 160,
  heartbeatOverrunMs: 1200,
  maxFrameGapMs: 110,
  droppedFrames: 25,
}

/**
 * 思考 / 正文**高密度爆发**探针 · 前半（1-D 场景）。
 *
 * 为什么要有这一场：默认对话桩只发 2 条 reasoning + 2 条 content 分片，密度远低于真实推理
 * 模型（100+ token/s）——「渲染跟不上输出」这类问题在那个密度下根本不会出现，
 * 现有 chatStream 探针因此**测不出**该症状。这里让桩服务按真实密度喷 150 + 150 片。
 *
 * 与 chatStreamAct 的关键差别：**不等流式结束**。本场景要拍的是「流式进行中」的现场
 *（思考块已展开、正文还在长），所以点完发送只等 600ms 就返回。
 *
 * 仪器必须在这里装好（而不是 check 里）：check 跑在流式收尾之后，
 * 那时再装 PerformanceObserver / 心跳只能观测到空气。结果挂在 window 上给 check 读。
 */
export function chatStreamBurstAct(question: string): string {
  return `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const box = document.querySelector('.composer-input')
    if (box === null) return { ready: false, reason: 'composer-input 不存在' }
    const sendButton = document.querySelector('.composer-box [aria-label="发送"]')
    if (sendButton === null) return { ready: false, reason: '发送按钮不存在' }

    const probe = {
      entries: [],
      supported: true,
      error: null,
      observer: null,
      heartbeat: { samples: [], hidden: [], last: performance.now(), timer: 0 },
      frames: { times: [], hidden: [], handle: 0 },
      visibility: [],
    }
    window['${BURST_PROBE_SLOT}'] = probe
    try {
      probe.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          probe.entries.push({ start: entry.startTime, duration: entry.duration })
        }
      })
      probe.observer.observe({ entryTypes: ['longtask'] })
    } catch (error) {
      // 环境不支持 longtask：如实标记，不让它把功能断言一起拖失败
      probe.supported = false
      probe.error = String(error)
    }

    // 可见性变化必须留痕：窗口一旦被判定为隐藏/遮挡，Chromium 会把定时器与 rAF 双双节流，
    // 那时的「心跳 9 秒」不是主线程被占，而是渲染被暂停 —— 两种现象在数值上长得一样，
    // 不记下来就没法判断这轮数据是否有效。
    probe.visibility.push({ at: 0, state: document.hidden === true ? 'hidden' : 'visible' })
    document.addEventListener('visibilitychange', () => {
      probe.visibility.push({
        at: Math.round(performance.now()),
        state: document.hidden === true ? 'hidden' : 'visible',
      })
    })

    // 只从**爆发轮**开始采样：前面还有几轮堆量（一次性往里灌几十 KB 的旧消息），
    // 那几轮的一次性开销（首次解析 / 首次布局）不是本 BUG 要测的东西，留在样本里
    // 会把 max 值抬成「首屏开销」。爆发轮的可靠信号 = 流式思考块的正文出现
    //（堆量轮只发正文、不发 reasoning，因此思考块只在爆发轮存在）。
    probe.armed = true
    probe.reset = () => {
      if (probe.armed !== true) return
      if (document.querySelector('.thinking.streaming') === null) return
      probe.armed = false
      probe.entries.length = 0
      probe.heartbeat.samples.length = 0
      probe.heartbeat.hidden.length = 0
      probe.frames.times.length = 0
      probe.frames.hidden.length = 0
      probe.heartbeat.last = performance.now()
      probe.resetAt = Math.round(performance.now())
    }

    // 主线程占用度的读数：心跳的实际间隔被拉长多少。5ms 一片的流式下，
    // 单任务永远够不到 longtask 的 50ms 下限，但「排满主线程」会立刻反映成心跳漂移。
    probe.heartbeat.timer = setInterval(() => {
      probe.reset()
      const now = performance.now()
      probe.heartbeat.samples.push(now - probe.heartbeat.last)
      probe.heartbeat.hidden.push(document.hidden === true)
      probe.heartbeat.last = now
    }, ${BURST_HEARTBEAT_MS})

    // 帧间隔的读数：渲染被拖慢最直接的证据（每帧的预算只有约 16.7ms）
    const onFrame = (stamp) => {
      probe.reset()
      probe.frames.times.push(stamp)
      probe.frames.hidden.push(document.hidden === true)
      probe.frames.handle = requestAnimationFrame(onFrame)
    }
    probe.frames.handle = requestAnimationFrame(onFrame)

    box.focus()
    box.value = ${JSON.stringify(question)}
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(200)
    sendButton.click()

    // 等**思考块开始长字**再返回（而不是固定等 600ms）：本场景前面还有几轮堆量，
    // 固定延时会把截图拍到「前文还在灌」或者「思考已经写完」上，现场就不确定了。
    // 判据是流式思考块里的正文有了一小段内容；拿不到（桩挂了 / 思考没开始）也不阻塞，
    // 固定等一次后照样返回，让 check 去报失败原因。
    let reasoningChars = 0
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const live = document.querySelector('.thinking.streaming .thinking-text')
      reasoningChars = live === null ? 0 : (live.textContent || '').length
      if (reasoningChars >= 120) break
      await wait(100)
    }
    await wait(220)
    return {
      ready: true,
      streaming: document.querySelector('.thread.streaming') !== null,
      reasoningChars,
      observed: probe.entries.length,
      heartbeats: probe.heartbeat.samples.length,
      frames: probe.frames.times.length,
    }
  } catch (error) {
    return { ready: false, reason: String(error) }
  }
})()`
}

/**
 * 爆发场景 · 后半：等收尾 → 收仪器 → 先断言首末标记都到了 → 返回观测原始数值。
 *
 * 三步顺序不能换：
 * 1. **先等流式收尾**（`.thread.streaming` 摘除）。check 在截图之后跑，而截图落在流式中段，
 *    不等就会在「思考还在长」时去读收尾态；
 * 2. **收仪器要抢在点开思考块之前**：那一步有几百毫秒的等待，混进采样会把主线程占用稀释成 0；
 * 3. 读正文标记必须走 `.md` 元素（而不是整条消息的 textContent）——思考块展开后它的正文也在
 *    textContent 里，两边混在一起就分不清哪个标记落在哪一块。
 *
 * 三组数值的口径与取舍（这是本探针最需要说清的地方）：
 * - `longTask*`：任务书要求的原始口径。**它在修复前后都是 0** —— Chromium 只上报单任务 > 50ms
 *   的 longtask，而本 BUG 的代价形态是「每片几毫秒 + 5ms 一片」的持续占用，单任务永远够不到
 *   50ms。留着它是为了如实留档，判定上只当作「没有离谱的巨型卡顿」；
 * - `heartbeat*`：20ms 心跳的实际间隔漂移 —— 主线程被占满时下一拍会被推迟，这是与 BUG 同量级的读数；
 * - `frame*`：rAF 帧间隔 —— 每帧预算约 16.7ms，超出的部分累计即「掉帧代价」，最贴近肉眼观感。
 *
 * 阈值在 BURST_LAG_LIMITS / BURST_LONG_TASK_LIMITS，按 2026-09-26 本机实测留约 3 倍余量。
 */
export function chatStreamBurstCheck(markers: {
  textStart: string
  textEnd: string
  reasoningStart: string
  reasoningEnd: string
}): string {
  const markerLiteral = JSON.stringify(markers)
  return `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    // 1) 等流式收尾（爆发流约 1.5s，给足 20s 余量：机器抖动 / 首帧 markdown 解析都可能慢）
    let stillStreaming = true
    for (let attempt = 0; attempt < 80 && stillStreaming; attempt += 1) {
      stillStreaming = document.querySelector('.thread.streaming') !== null
      if (stillStreaming) await wait(250)
    }

    // 2) 立刻收掉仪器再读 DOM：下面点开思考块会引入几百毫秒的空闲等待，
    //    混进采样里会把「主线程占用」稀释成接近 0，指标就废了。
    const probe = window['${BURST_PROBE_SLOT}']
    const usable = probe !== null && probe !== undefined
    if (usable) {
      if (probe.observer !== null && probe.observer !== undefined) {
        probe.observer.disconnect()
        probe.observer = null
      }
      if (probe.heartbeat !== null && probe.heartbeat !== undefined) {
        clearInterval(probe.heartbeat.timer)
      }
      if (probe.frames !== null && probe.frames !== undefined) {
        cancelAnimationFrame(probe.frames.handle)
      }
    }

    // 3) 正文首末标记：只看最后一条助手消息的 .md（思考块正文不在这个节点里）
    const markers = ${markerLiteral}
    const assistants = Array.from(document.querySelectorAll('.message.r-assistant'))
    const lastAssistant = assistants[assistants.length - 1]
    const lastMarkdown = lastAssistant === undefined ? null : lastAssistant.querySelector('.md')
    const lastContent = lastMarkdown === null ? '' : (lastMarkdown.textContent || '')
    const contentHasStart = lastContent.indexOf(markers.textStart) !== -1
    const contentHasEnd = lastContent.indexOf(markers.textEnd) !== -1

    // 4) 思考块首末标记：收尾后块已收起为摘要行，正文不在 DOM 里，得点开才读得到
    const lastThinking = lastAssistant === undefined ? null : lastAssistant.querySelector('.thinking')
    const lastThinkingLabel =
      lastThinking === null ? '' : (lastThinking.querySelector('.thinking-head')?.textContent ?? '').trim()
    let lastThinkingText = ''
    if (lastThinking !== null) {
      const head = lastThinking.querySelector('.thinking-head')
      if (head !== null) head.click()
      await wait(400)
      const body = lastThinking.querySelector('.thinking-text')
      lastThinkingText = body === null ? '' : (body.textContent || '').trim()
      if (head !== null) head.click()
      await wait(150)
    }
    const thinkingHasStart = lastThinkingText.indexOf(markers.reasoningStart) !== -1
    const thinkingHasEnd = lastThinkingText.indexOf(markers.reasoningEnd) !== -1

    // 5) longtask 口径（任务书要求的三个原始数值）
    const entries =
      usable !== true || Array.isArray(probe.entries) !== true ? [] : probe.entries
    let maxLongTaskMs = 0
    let totalBlockingMs = 0
    for (const entry of entries) {
      if (entry.duration > maxLongTaskMs) maxLongTaskMs = entry.duration
      // 阻塞时长口径：单条长任务超出 50ms 的部分才算「卡住主线程」
      totalBlockingMs += Math.max(0, entry.duration - 50)
    }
    const longTaskCount = entries.length
    const longTaskSupported = usable !== true ? false : probe.supported !== false

    // 6) 心跳漂移：主线程在流式期间被占掉多少（单任务够不到 longtask 下限时的替代口径）
    const heartbeats =
      usable !== true || Array.isArray(probe.heartbeat.samples) !== true ? [] : probe.heartbeat.samples
    const hiddenFlags =
      usable !== true || Array.isArray(probe.heartbeat.hidden) !== true ? [] : probe.heartbeat.hidden
    let maxHeartbeatMs = 0
    let maxUnhiddenHeartbeatMs = 0
    let heartbeatOverrunMs = 0
    let hiddenHeartbeats = 0
    let heartbeatTotalMs = 0
    const gaps = []
    for (let index = 0; index < heartbeats.length; index += 1) {
      const sample = heartbeats[index]
      heartbeatTotalMs += sample
      if (hiddenFlags[index] === true) hiddenHeartbeats += 1
      if (sample > maxHeartbeatMs) maxHeartbeatMs = sample
      // 超过 2 倍心跳间隔才算「这一拍被挤掉」，避免把正常的调度抖动算进来
      // 被节流（窗口隐藏）的那几拍单独剔除：那是渲染被暂停，不是主线程被占满
      if (hiddenFlags[index] !== true) {
        if (sample > maxUnhiddenHeartbeatMs) maxUnhiddenHeartbeatMs = sample
        heartbeatOverrunMs += Math.max(0, sample - ${BURST_HEARTBEAT_MS * 2})
      }
      gaps.push({ index, delta: Math.round(sample * 10) / 10, hidden: hiddenFlags[index] === true })
    }
    // 只留最大的 5 段：完整时间线太长，报告里看最大的几段就够定位
    gaps.sort((left, right) => right.delta - left.delta)
    const heartbeatCount = heartbeats.length
    const visibility = usable !== true || Array.isArray(probe.visibility) !== true ? [] : probe.visibility

    // 7) 帧间隔：渲染是否还跟得上（每帧预算约 16.7ms，超出的部分累计即「掉帧代价」）
    const frames = usable !== true || Array.isArray(probe.frames.times) !== true ? [] : probe.frames.times
    const frameHidden =
      usable !== true || Array.isArray(probe.frames.hidden) !== true ? [] : probe.frames.hidden
    let maxFrameGapMs = 0
    let droppedFrames = 0
    let hiddenFrameGaps = 0
    for (let index = 1; index < frames.length; index += 1) {
      // 跨越隐藏期的帧间隔同样是「渲染被暂停」，不是「渲染跟不上」——剔除并计数
      if (frameHidden[index] === true || frameHidden[index - 1] === true) {
        hiddenFrameGaps += 1
        continue
      }
      const gap = frames[index] - frames[index - 1]
      if (gap > maxFrameGapMs) maxFrameGapMs = gap
      if (gap > 33) droppedFrames += Math.floor(gap / 16.7) - 1
    }
    const frameCount = frames.length

    // 采样是否真的从爆发轮开始（false = 样本里混着堆量轮的首屏开销，数值不可信）
    const phaseResetAt = usable !== true || typeof probe.resetAt !== 'number' ? null : probe.resetAt

    return {
      assistantCount: assistants.length,
      reasoningChars: lastThinkingText.length,
      contentChars: lastContent.length,
      contentHasStart,
      contentHasEnd,
      thinkingHasStart,
      thinkingHasEnd,
      lastThinkingLabel,
      stillStreaming,
      phaseResetAt,
      longTaskSupported,
      longTaskCount,
      maxLongTaskMs: Math.round(maxLongTaskMs * 10) / 10,
      totalBlockingMs: Math.round(totalBlockingMs * 10) / 10,
      heartbeatCount,
      heartbeatTotalMs: Math.round(heartbeatTotalMs),
      hiddenHeartbeats,
      visibility,
      topHeartbeatGaps: gaps.slice(0, 5),
      maxHeartbeatMs: Math.round(maxHeartbeatMs * 10) / 10,
      maxUnhiddenHeartbeatMs: Math.round(maxUnhiddenHeartbeatMs * 10) / 10,
      heartbeatOverrunMs: Math.round(heartbeatOverrunMs * 10) / 10,
      frameCount,
      hiddenFrameGaps,
      maxFrameGapMs: Math.round(maxFrameGapMs * 10) / 10,
      droppedFrames,
      limits: {
        longTask: ${JSON.stringify(BURST_LONG_TASK_LIMITS)},
        lag: ${JSON.stringify(BURST_LAG_LIMITS)},
      },
      pass:
        assistants.length >= 1 &&
        lastThinking !== null &&
        // 首末标记都到齐 = 桩服务的 150 片既没丢、也没被合并逻辑吃掉
        contentHasStart &&
        contentHasEnd &&
        thinkingHasStart &&
        thinkingHasEnd &&
        stillStreaming === false &&
        lastThinkingLabel.indexOf('已深度思考') !== -1 &&
        // 性能门限：按 2026-09-26 实测留约 3 倍余量（防止 CI 机器抖动假 FAIL），
        // 数值随机器档位浮动，断言的只有「数量级」。
        heartbeatCount > 0 &&
        frameCount > 0 &&
        // 采样起点必须是爆发轮：否则下面的数值是「堆量轮首屏开销」而不是本 BUG 的代价
        phaseResetAt !== null &&
        // 窗口被判定隐藏时的那几拍不计入：节流不是主线程占用（hiddenHeartbeats 会一并落盘）
        hiddenHeartbeats <= heartbeatCount / 2 &&
        (longTaskSupported !== true ||
          (longTaskCount <= ${BURST_LONG_TASK_LIMITS.count} &&
            maxLongTaskMs <= ${BURST_LONG_TASK_LIMITS.maxMs} &&
            totalBlockingMs <= ${BURST_LONG_TASK_LIMITS.blockingMs})) &&
        maxUnhiddenHeartbeatMs <= ${BURST_LAG_LIMITS.maxHeartbeatMs} &&
        heartbeatOverrunMs <= ${BURST_LAG_LIMITS.heartbeatOverrunMs} &&
        maxFrameGapMs <= ${BURST_LAG_LIMITS.maxFrameGapMs} &&
        droppedFrames <= ${BURST_LAG_LIMITS.droppedFrames},
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`
}

export const CHAT_PERMISSION_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    // 轮询等钮可用：它的 disabled 取决于渲染层 settingsStore 是否已水合（不是配置本身），
    // 而 disabled 元素上的 click 不触发处理函数 → 探针会假 FAIL（同 chat.reasoningEffort 的教训）。
    let button = null
    for (let attempt = 0; attempt < 10 && button === null; attempt += 1) {
      const candidate = document.querySelector('[data-field="chat.permission"]')
      if (candidate !== null && candidate.disabled !== true) button = candidate
      else await wait(250)
    }
    if (button === null) return { opened: false, reason: 'chat.permission 始终不可用（settingsStore 未水合？）' }
    button.click()
    await wait(300)
    return { opened: document.querySelector('[data-field="chat.permission-menu"]') !== null }
  } catch (error) {
    return { opened: false, reason: String(error) }
  }
})()`

/**
 * 只读档现场（v13，docs/06 §11.2）：把 `agent.permissionMode` 切到 `readonly` 并展开权限下拉。
 *
 * 必须走 `settings:update` IPC（`SettingsStore` 启动即缓存配置），并把下拉**打开**再截图 ——
 * 「只读档下写类工具根本不注册」是运行时事实，界面能自证的只有下拉文案与设置页摘要，
 * 所以这一条同时钉住"界面没说谎"。
 */
export const CHAT_PERMISSION_READONLY_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const state = await window.aurora.settings.get()
    if (!state.ok) return { ok: false, reason: state.message }
    if (state.value.agent.permissionMode !== 'readonly') {
      const result = await window.aurora.settings.update({
        agent: { ...state.value.agent, permissionMode: 'readonly' },
        advanced: { ...state.value.advanced, confirmSensitiveTools: true },
      })
      if (!result.ok) return { ok: false, reason: result.message }
      // 等渲染层 store 收到 settings:changed 广播后重算下拉文案
      await wait(400)
    }
    const button = document.querySelector('[data-field="chat.permission"]')
    if (button !== null && button.disabled !== true) button.click()
    await wait(300)
    return { ok: true, opened: document.querySelector('[data-field="chat.permission-menu"]') !== null }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`

/** 只读档断言：下拉文案 = 只读、配置真的落成 readonly，收尾还原成 confirm 并收起下拉。 */
export const CHAT_PERMISSION_READONLY_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const textOf = (selector) => {
      const el = document.querySelector(selector)
      return el === null ? '' : (el.textContent || '').replace(/\\s+/g, ' ').trim()
    }
    const result = {
      trigger: textOf('[data-field="chat.permission"]'),
      readonlyOption: textOf('[data-field="chat.permission-mode-readonly"]'),
    }
    const state = await window.aurora.settings.get()
    result.permissionMode = state.ok ? state.value.agent.permissionMode : null
    result.pass =
      result.permissionMode === 'readonly' &&
      result.trigger.indexOf('只读') !== -1 &&
      result.readonlyOption.indexOf('只读') !== -1

    // 收尾：还原成默认档（confirm）并把下拉收起，后续场景读到的仍是出厂门控
    if (state.ok) {
      await window.aurora.settings.update({
        agent: { ...state.value.agent, permissionMode: 'confirm' },
        advanced: { ...state.value.advanced, confirmSensitiveTools: true },
      })
    }
    const button = document.querySelector('[data-field="chat.permission"]')
    if (button !== null) button.click()
    let closed = false
    for (let attempt = 0; attempt < 12 && !closed; attempt += 1) {
      closed = count('[data-field="chat.permission-menu"]') === 0
      if (!closed) await wait(150)
    }
    result.restoredTrigger = textOf('[data-field="chat.permission"]')
    result.restored =
      closed &&
      result.restoredTrigger.indexOf('变更前确认') !== -1 &&
      count('[data-field="chat.permission-mode-readonly"]') === 0
    result.pass = result.pass === true && result.restored === true
    return result
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

export const CHAT_PERMISSION_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const textOf = (selector) => {
      const el = document.querySelector(selector)
      return el === null ? '' : (el.textContent || '').trim()
    }
    const menuOpen = count('[data-field="chat.permission-menu"]') === 1
    // 三档（v13）：只读 / 变更前确认 / 完全权限（= auto，仍锚在 chat.permission-full 上）
    const readonlyItem = textOf('[data-field="chat.permission-mode-readonly"]')
    const confirmItem = textOf('[data-field="chat.permission-confirm"]')
    const autoItemBefore = textOf('[data-field="chat.permission-full"]')

    const autoButton = document.querySelector('[data-field="chat.permission-full"]')
    if (autoButton !== null) autoButton.click()
    await wait(300)
    const autoItemAfter = textOf('[data-field="chat.permission-full"]')

    const state = await window.aurora.settings.get()
    // 放宽权限是两段式：点一次只应停在「再点一次确认」，配置里的档位必须一动没动
    const modeUnchanged = state.ok ? state.value.agent.permissionMode === 'confirm' : null
    const legacyUnchanged = state.ok ? state.value.advanced.confirmSensitiveTools === true : null

    // 收尾：再点一次权限钮收起下拉（不影响配置），并轮询确认它真的关掉了 ——
    // leave transition 是 --dur-fast（150ms），固定等 200ms 在高负载下余量太小会假 FAIL。
    const button = document.querySelector('[data-field="chat.permission"]')
    if (button !== null) button.click()
    let closed = false
    for (let attempt = 0; attempt < 12 && !closed; attempt += 1) {
      closed = document.querySelectorAll('[data-field="chat.permission-menu"]').length === 0
      if (!closed) await wait(150)
    }

    return {
      menuOpen,
      readonlyOption: readonlyItem.indexOf('只读') !== -1,
      confirmOption: confirmItem.indexOf('变更前确认') !== -1,
      fullOption: autoItemBefore.indexOf('完全权限') !== -1,
      askedAgain: autoItemAfter.indexOf('再点一次确认') !== -1,
      permissionMode: state.ok ? state.value.agent.permissionMode : null,
      confirmSensitiveTools: legacyUnchanged,
      menuClosedAfter: closed,
      pass:
        menuOpen &&
        readonlyItem.indexOf('只读') !== -1 &&
        confirmItem.indexOf('变更前确认') !== -1 &&
        autoItemBefore.indexOf('完全权限') !== -1 &&
        autoItemAfter.indexOf('再点一次确认') !== -1 &&
        modeUnchanged === true &&
        legacyUnchanged === true &&
        count('[data-field="chat.permission-menu"]') === 0,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 输入区三个浮层的「互斥 + 几何不相交 + 工具行可点」探针 · 前半（2026-09-26 修复的回归断言）。
 *
 * 现场：三个浮层（斜杠 `chat.slash-menu` / 权限 `chat.permission-menu` / 上下文详解
 * `chat.context-detail`）统一锚在 `.composer-box` 上、共用 `--z-flyout`、互斥打开。
 * 修复前 `chat.context-detail` 锚在工具行**下方**的 `.ctx` 上向上弹，底边正好落在工具行内部，
 * 把权限 / 模型 / 思考 / 麦克风 / 停止 / 发送整条盖住且不可点 —— 本场景就是那条事故的运行时证据。
 *
 * act 只做两件事，两步都是真实交互链路（focus + input 事件 / 指针点击 → Vue handler）：
 * ① 往 textarea 写 `/` 并派发 `input`（斜杠浮层冒出来）→ 取「斜杠开着」时刻的快照；
 * ② 点权限钮（权限下拉打开、斜杠浮层让位）→ 取「权限开着」时刻的快照。
 *
 * ⚠️ 每一刻都必须**等过渡稳定**再取数：进出场是 `pop` 的 150ms（`--dur-fast`）缩放 + 4px 位移，
 * 只按「元素存在」判定会拍到中间帧（矩形偏小、位置低 4px），几何断言就变成对中间态下结论。
 * 因此这里按「连续两次采样的矩形完全一致」判稳定，而不是固定等待。
 *
 * 快照（含矩形、可见性、层级、`elementFromPoint` 命中描述）挂在 window 上给 check 读 ——
 * act 的返回值会被 `captureWindows` 丢掉，只有 check 的返回值进 `report.json`。
 * 收尾（关浮层 / 清空输入）在 check 里做，因为截图必须先拍到「浮层开着」的现场。
 */
export const CHAT_COMPOSER_FLYOUTS_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const KEYS = ['slash', 'permission', 'context']
    const SELECTORS = {
      slash: '[data-field="chat.slash-menu"]',
      permission: '[data-field="chat.permission-menu"]',
      context: '[data-field="chat.context-detail"]',
    }
    const round = (value) => Math.round(value * 10) / 10
    const rectOf = (el) => {
      const rect = el.getBoundingClientRect()
      return {
        top: round(rect.top),
        bottom: round(rect.bottom),
        left: round(rect.left),
        right: round(rect.right),
        width: round(rect.width),
        height: round(rect.height),
      }
    }
    const snapshot = () => {
      const items = {}
      const visible = []
      for (const key of KEYS) {
        const el = document.querySelector(SELECTORS[key])
        if (el === null) {
          items[key] = { present: false, visible: false, rect: null, zIndex: null }
          continue
        }
        const rect = el.getBoundingClientRect()
        const shown = rect.width > 0 && rect.height > 0
        items[key] = {
          present: true,
          visible: shown,
          rect: rectOf(el),
          zIndex: getComputedStyle(el).zIndex,
        }
        if (shown) visible.push(key)
      }
      const bar = document.querySelector('.composer-bar')
      const box = document.querySelector('.composer-box')
      return {
        visible,
        visibleCount: visible.length,
        items,
        barRect: bar === null ? null : rectOf(bar),
        boxRect: box === null ? null : rectOf(box),
      }
    }
    // 发送键的中心命中测试：修复前命中的是浮层（这就是「发送键点不动」的直接读数）
    const sendHit = () => {
      const send = document.querySelector('.composer-bar .send')
      if (send === null) return { found: false, hitSelf: false, hit: 'no .composer-bar .send' }
      const rect = send.getBoundingClientRect()
      const x = Math.round(rect.left + rect.width / 2)
      const y = Math.round(rect.top + rect.height / 2)
      const hit = document.elementFromPoint(x, y)
      const classes =
        hit === null ? '' : String(hit.className || '').split(' ').filter(Boolean).join('.')
      const field = hit === null ? null : hit.getAttribute('data-field')
      return {
        found: true,
        x,
        y,
        hitSelf: hit === send || send.contains(hit),
        hit:
          hit === null
            ? 'null'
            : hit.tagName.toLowerCase() +
              (classes === '' ? '' : '.' + classes) +
              (field === null ? '' : ' [' + field + ']'),
        sendRect: rectOf(send),
      }
    }
    const moment = () => {
      const snap = snapshot()
      snap.hit = sendHit()
      return snap
    }
    /** 等某浮层出现且矩形连续两次采样一致（进出场 150ms，拍中间帧会让几何断言失真） */
    const settle = async (selector, attempts) => {
      let last = null
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const el = document.querySelector(selector)
        const rect = el === null ? null : el.getBoundingClientRect()
        if (rect !== null && rect.width > 0 && rect.height > 0) {
          const key =
            Math.round(rect.top * 10) +
            ':' +
            Math.round(rect.bottom * 10) +
            ':' +
            Math.round(rect.width * 10)
          if (key === last) return true
          last = key
        } else {
          last = null
        }
        await wait(80)
      }
      return false
    }
    const box = document.querySelector('.composer-input')
    if (box === null) return { ready: false, reason: 'composer-input 不存在' }
    box.focus()
    box.value = '/'
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await settle(SELECTORS.slash, 12)
    // 技能候选来自 skills:list（异步）：等它到了再取快照，浮层高度才是最终态（与 chat-composer-slash 同款）
    let skills = 0
    for (let attempt = 0; attempt < 12 && skills === 0; attempt += 1) {
      skills = document.querySelectorAll('[data-kind="skill"]').length
      if (skills === 0) await wait(250)
    }
    await settle(SELECTORS.slash, 6)
    const slashMoment = moment()

    // 权限钮可能因 settingsStore 未水合而 disabled（禁用元素上的 click 不触发处理函数）
    let button = null
    for (let attempt = 0; attempt < 10 && button === null; attempt += 1) {
      const candidate = document.querySelector('[data-field="chat.permission"]')
      if (candidate !== null && candidate.disabled !== true) button = candidate
      else await wait(250)
    }
    if (button === null) {
      window.__auroraFlyoutProbe = { slash: slashMoment }
      return { ready: false, reason: 'chat.permission 始终不可用（settingsStore 未水合？）', slashMoment }
    }
    button.click()
    await settle(SELECTORS.permission, 12)
    const permissionMoment = moment()
    window.__auroraFlyoutProbe = { slash: slashMoment, permission: permissionMoment }
    return { ready: true, skillItems: skills, slash: slashMoment, permission: permissionMoment }
  } catch (error) {
    return { ready: false, reason: String(error) }
  }
})()`

/**
 * 输入区三个浮层探针 · 后半（几何断言，不数元素个数）。
 *
 * 四个时刻各取一次「可见浮层集合 + 每层矩形 + 发送键命中」：
 * ① 斜杠开着（act 记录）→ ② 权限开着（act 记录的现场，即截图那一刻）→
 * ③ 权限开着（此刻实时复测，与 ② 互为旁证）→ ④ 上下文详解开着（check 里现开，本场景跑在截图之后，
 *    拍不到不影响证据链；事故的元凶正是这一层，所以必须有一个真实测量点）。
 *
 * 断言四件事：
 * 1. **任一时刻最多一个浮层可见**（可见判定 = `getBoundingClientRect()` 宽高都 > 0），
 *    且「权限开着」时斜杠浮层必须不可见、「上下文详解开着」时权限下拉必须不可见 —— 互斥真的生效；
 * 2. **浮层不压工具行**：可见浮层的矩形与 `.composer-bar` 的矩形**不相交**，
 *    并且整个矩形都在 `.composer-box` **上方**（`bottom <= box.top + 1`）——
 *    后者是「统一锚在输入卡上」这条修复的几何表达（锚在 `.ctx` 上向上弹时它的底边必然伸进输入卡内部）；
 * 3. **发送键可点**：`.composer-bar .send` 矩形中心的 `elementFromPoint` 命中它自己或它的后代
 *    —— 事故现场这里命中的是浮层；
 * 4. 收尾：按**当前** `aria-expanded` 逐个关掉还开着的显式浮层、清空输入框（斜杠浮层随之消失）、
 *    再点一次输入卡外部兜底，轮询确认三者都不可见 —— 关闭判据不能用过期快照：三个浮层互斥，
 *    打开上下文卡时权限下拉已经被挤掉了，拿着旧快照去点权限钮只会把它重新打开（首跑实测踩到）。
 *    收尾过程留痕在 `cleanupTrace` 里。
 *
 * 返回值带上每个时刻的可见集合、每层矩形（含 z-index）、命中元素描述与两次计数 ——
 * 失败时能一眼看出是谁挡住了谁，而不是只知道「断言没过」。
 */
export const CHAT_COMPOSER_FLYOUTS_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const KEYS = ['slash', 'permission', 'context']
    const SELECTORS = {
      slash: '[data-field="chat.slash-menu"]',
      permission: '[data-field="chat.permission-menu"]',
      context: '[data-field="chat.context-detail"]',
    }
    const round = (value) => Math.round(value * 10) / 10
    const rectOf = (el) => {
      const rect = el.getBoundingClientRect()
      return {
        top: round(rect.top),
        bottom: round(rect.bottom),
        left: round(rect.left),
        right: round(rect.right),
        width: round(rect.width),
        height: round(rect.height),
      }
    }
    const snapshot = () => {
      const items = {}
      const visible = []
      for (const key of KEYS) {
        const el = document.querySelector(SELECTORS[key])
        if (el === null) {
          items[key] = { present: false, visible: false, rect: null, zIndex: null }
          continue
        }
        const rect = el.getBoundingClientRect()
        const shown = rect.width > 0 && rect.height > 0
        items[key] = {
          present: true,
          visible: shown,
          rect: rectOf(el),
          zIndex: getComputedStyle(el).zIndex,
        }
        if (shown) visible.push(key)
      }
      const bar = document.querySelector('.composer-bar')
      const box = document.querySelector('.composer-box')
      return {
        visible,
        visibleCount: visible.length,
        items,
        barRect: bar === null ? null : rectOf(bar),
        boxRect: box === null ? null : rectOf(box),
      }
    }
    const sendHit = () => {
      const send = document.querySelector('.composer-bar .send')
      if (send === null) return { found: false, hitSelf: false, hit: 'no .composer-bar .send' }
      const rect = send.getBoundingClientRect()
      const x = Math.round(rect.left + rect.width / 2)
      const y = Math.round(rect.top + rect.height / 2)
      const hit = document.elementFromPoint(x, y)
      const classes =
        hit === null ? '' : String(hit.className || '').split(' ').filter(Boolean).join('.')
      const field = hit === null ? null : hit.getAttribute('data-field')
      return {
        found: true,
        x,
        y,
        hitSelf: hit === send || send.contains(hit),
        hit:
          hit === null
            ? 'null'
            : hit.tagName.toLowerCase() +
              (classes === '' ? '' : '.' + classes) +
              (field === null ? '' : ' [' + field + ']'),
        sendRect: rectOf(send),
      }
    }
    // 矩形相交（留 0.5px 容差，避免亚像素把「贴边」算成「相交」）
    const intersects = (left, right) =>
      left !== null &&
      right !== null &&
      left.left < right.right - 0.5 &&
      right.left < left.right - 0.5 &&
      left.top < right.bottom - 0.5 &&
      right.top < left.bottom - 0.5
    const audit = (label, moment) => {
      const rows = []
      for (const key of moment.visible) {
        const rect = moment.items[key].rect
        rows.push({
          key: key,
          zIndex: moment.items[key].zIndex,
          rect: rect,
          barClear: intersects(rect, moment.barRect) === false,
          aboveComposerBox: moment.boxRect !== null && rect.bottom <= moment.boxRect.top + 1,
        })
      }
      return {
        moment: label,
        visible: moment.visible,
        visibleCount: moment.visibleCount,
        hidden: KEYS.filter((key) => moment.visible.indexOf(key) === -1),
        rows: rows,
        barClear: rows.every((row) => row.barClear === true),
        aboveComposerBox: rows.every((row) => row.aboveComposerBox === true),
        hit: moment.hit,
      }
    }
    const probe = window.__auroraFlyoutProbe
    if (probe === undefined || probe === null || probe.slash === undefined) {
      return { pass: false, reason: 'act 未留下 __auroraFlyoutProbe（浮层从未出现？），无几何可断言' }
    }
    // ③ 权限下拉（截图现场）此刻的实时复测：act 的快照与它互为旁证
    const permissionNow = snapshot()
    permissionNow.hit = sendHit()
    // ④ 第三个时刻：上下文详解卡 —— 事故的元凶，必须有一次真实测量。
    //    「aria-expanded」是「组件自认为开着」的权威信号，比矩形可靠：leaving 中的节点矩形仍 > 0，
    //    只看矩形会对着一个正在消失的浮层下结论（甚至把已关掉的再点开）。
    const triggered = (selector) => {
      const el = document.querySelector(selector)
      return el !== null && el.getAttribute('aria-expanded') === 'true'
    }
    const contextButton = document.querySelector('[data-field="chat.context"]')
    if (contextButton !== null && triggered('[data-field="chat.context"]') === false) {
      contextButton.click()
    }
    await wait(450)
    const contextMoment = snapshot()
    contextMoment.hit = sendHit()

    // 收尾：反复按**当前**状态关掉可见浮层 —— 不能用过期快照决定点谁：
    // 打开上下文卡时权限下拉已经被挤掉了（openFlyout 只有一个值），此时再点权限钮会把它又打开。
    const box = document.querySelector('.composer-input')
    const cleanupTrace = []
    let cleared = false
    for (let round = 0; round < 6 && !cleared; round += 1) {
      const contextOpen = triggered('[data-field="chat.context"]')
      const permissionOpen = triggered('[data-field="chat.permission"]')
      cleanupTrace.push({
        round: round,
        contextOpen: contextOpen,
        permissionOpen: permissionOpen,
        visible: snapshot().visible,
      })
      if (contextOpen) {
        const button = document.querySelector('[data-field="chat.context"]')
        if (button !== null) button.click()
      }
      if (permissionOpen) {
        const button = document.querySelector('[data-field="chat.permission"]')
        if (button !== null) button.click()
      }
      // 斜杠浮层由输入内容隐含触发、没有关闭按钮：清空输入即消失
      if (box !== null && box.value !== '') {
        box.value = ''
        box.dispatchEvent(new Event('input', { bubbles: true }))
      }
      await wait(160)
      cleared =
        snapshot().visibleCount === 0 &&
        triggered('[data-field="chat.context"]') === false &&
        triggered('[data-field="chat.permission"]') === false
    }
    // 兜底：点一次输入卡外部（两个显式浮层各自的 pointerdown 关闭路径）
    const outside = document.querySelector('.thread') || document.body
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    for (let attempt = 0; attempt < 20 && !cleared; attempt += 1) {
      cleared = snapshot().visibleCount === 0
      if (!cleared) await wait(120)
    }
    // 清空输入（后续场景依赖空输入）：收尾里可能又因为某次点击把斜杠浮层带出来
    if (box !== null && box.value !== '') {
      box.value = ''
      box.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(200)
    }
    const finalMoment = snapshot()


    const audits = [
      audit('slash-open(act)', probe.slash),
      audit('permission-open(act)', probe.permission),
      audit('permission-open(now)', permissionNow),
      audit('context-open(check)', contextMoment),
    ]
    const oneAtMost = audits.every((row) => row.visibleCount <= 1)
    const mutual =
      audits[0].visible.indexOf('slash') !== -1 &&
      audits[2].visible.indexOf('permission') !== -1 &&
      audits[2].visible.indexOf('slash') === -1 &&
      audits[3].visible.indexOf('context') !== -1 &&
      audits[3].visible.indexOf('permission') === -1
    const barClear = audits.every((row) => row.barClear === true)
    const aboveComposerBox = audits.every((row) => row.aboveComposerBox === true)
    const sendClickable = audits.every(
      (row) =>
        row.hit !== undefined && row.hit !== null && row.hit.found === true && row.hit.hitSelf === true,
    )
    return {
      audits,
      oneAtMost,
      mutual,
      barClear,
      aboveComposerBox,
      sendClickable,
      cleared,
      cleanupTrace,
      finalVisible: finalMoment.visible,
      inputAfter:
        box === null ? null : box.value === '' ? 'empty' : JSON.stringify(box.value.slice(0, 24)),
      pass:
        oneAtMost && mutual && barClear && aboveComposerBox && sendClickable && cleared === true,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 工具卡展开高度的「实测终点」探针 · 前半（2026-09-26 修复的回归断言）。
 *
 * 背景：`.collapse-*` 的终点此前写死 `70vh`，内容只有约 140px 的工具卡对 504px 的终点做动画，
 * 可见位移全挤在时间轴前一小段（展开「飞快长满再空转」、收起「先空转、末尾猛缩」）。
 * 现在终点取实测值：`useCollapseTransition` 的 **`@enter`** / `@before-leave` 钩子在量之前
 * 先把元素内联的 `max-height` 临时摘成 `none`（否则被钳制的 flex 列容器会把可收缩子项
 * `.tool-args` 压扁、量少 66px），量完立刻还原，把真实内容高度写进 `--collapse-h`，
 * 全局 CSS 用 `var(--collapse-h, 70vh)`。**进入方向不能挂 `before-enter`** ——
 * 那时元素还没插入文档、`scrollHeight` 恒为 0（2026-09-26 实测踩过）。
 *
 * act 点 seed 出来的工具卡卡头（优先 `task` 卡，展开体最大：运行轨迹 + 指令 + 参数 + 结果），
 * 中途按 60 / 120 / 180 / 280 / 400ms 采样可见高度，最后轮询到「连续两次高度一致且 > 0」
 * 才算稳定，把采样与稳定高度挂 window 给 check 读（act 的返回值进不了 report.json）。
 * 采样里 **60ms 那次参与 pass 判定**（必须严格小于稳定高度）：终值在「正常过渡」与
 * 「退化成瞬跳」两种实现下相同，只有中间样本能区分它们。
 *
 * **不在这里收起卡片**：截图就是展开现场，且展开态只影响这张卡自身，后续场景不受影响
 *（`chat-tts` 自带 reload）。
 */
export const CHAT_TOOL_CARD_OPEN_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    // 优先 task 卡（有子代理轨迹 + 指令 + 参数 + 结果，展开体最长），回落 todo 卡再回落任意工具卡
    const card =
      document.querySelector('[data-field="chat.task-card"]') ||
      document.querySelector('[data-field="chat.todo-card"]') ||
      document.querySelector('.tool-card')
    if (card === null) {
      return { ready: false, reason: '没有 .tool-card（seed 的工具卡没渲染？）' }
    }
    const head = card.querySelector('.tool-head')
    if (head === null) return { ready: false, reason: 'no .tool-head' }
    const field = card.getAttribute('data-field')
    const openBefore = card.classList.contains('open')
    const bodyBefore = card.querySelector('.tool-body') !== null
    if (openBefore === true) {
      // 已经展开（默认是折叠的，走到这里说明前面的场景动过）：不再点，避免把它收起来
      window.__auroraToolCardProbe = { field, openBefore, bodyBefore, samples: [], stableHeight: 0, clicked: false }
      return { ready: true, field, openBefore, clicked: false }
    }
    const started = Date.now()
    head.click()
    const samples = []
    for (const target of [60, 120, 180, 280, 400]) {
      const elapsed = Date.now() - started
      if (target > elapsed) await wait(target - elapsed)
      const body = card.querySelector('.tool-body')
      const rect = body === null ? null : body.getBoundingClientRect()
      samples.push({
        at: Date.now() - started,
        height: rect === null ? 0 : Math.round(rect.height * 10) / 10,
      })
    }
    // 稳定判据：连续两次采样高度一致且 > 0（0 是过渡起点，不能当成稳定）
    let stableHeight = 0
    let last = -1
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const body = card.querySelector('.tool-body')
      const height = body === null ? -1 : Math.round(body.getBoundingClientRect().height)
      if (height > 0 && height === last) {
        stableHeight = height
        break
      }
      last = height
      await wait(80)
    }
    const probe = {
      field: field,
      openBefore: openBefore,
      bodyBefore: bodyBefore,
      clicked: true,
      samples: samples,
      stableHeight: stableHeight,
      waitedMs: Date.now() - started,
    }
    window.__auroraToolCardProbe = probe
    return { ready: true, ...probe }
  } catch (error) {
    return { ready: false, reason: String(error) }
  }
})()`

/**
 * 工具卡展开探针 · 后半（「实测高度」这条机制的直接断言）。
 *
 * 断言：
 * ① 卡处于展开态（`.open` + `aria-expanded="true"`）且展开体 `.tool-body` 在且可见；
 * ② 展开体的**内联** `--collapse-h` 存在、是可解析的 px 数值，且与该元素的 `scrollHeight`
 *    相差 ≤ 2px —— 有人把钩子摘掉（回落 70vh）或改回写死值，这条立刻 FAIL；
 * ③ 稳定后展开体的可见高度 ≈ `scrollHeight`（没有被 `max-height` 截住）；
 * ④ 中途采样只回传、不参与判定（曲线平滑度不能从快照断言）。
 * ② 的口径**刻意从严**：它同时是「测量发生在何时」的回归防线 —— 首跑就靠它抓到
 * 「进入方向把 `scrollHeight` 量在**游离**元素上 → `--collapse-h: 0px`」这个真实 bug
 * （Vue 的 `beforeEnter` 在 `hostInsert` 之前调用；已由渲染层改挂 `enter` 修掉）。
 * 因此这里的 `≤ 2px` 不能放宽成「接受 0 / 接受一个区间」。
 *
 * 场景自带两条**只回传、不参与 pass** 的诊断（`diagnostic` / `detachedMeasureProbe`），
 * 用来把「钩子量到了什么」变成可复核的读数：
 * - `diagnostic.leaveVar`：收起方向（`before-leave` 时元素尚在文档里）写下的实测值；
 * - `diagnostic.mid` / `diagnostic.settled`：再展开时「进入后约 70ms」与「稳定后」两次布局快照
 *   （`--collapse-h`、元素宽度、`scrollHeight`、`.thread` 的 clientWidth / 有无滚动条、各子元素高度）
 *   —— 用于区分「钩子量错了」与「量的时候布局还没稳」；
 * - `detachedMeasureProbe`：现造一个同款盒子，未入文档 / 已入文档各量一次 `scrollHeight`
 *   （钉住「游离元素 scrollHeight 恒为 0」这条前提）。
 */
export const CHAT_TOOL_CARD_OPEN_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const probe = window.__auroraToolCardProbe
    const pick = () =>
      document.querySelector('[data-field="chat.task-card"]') ||
      document.querySelector('[data-field="chat.todo-card"]') ||
      document.querySelector('.tool-card')
    const card = pick()
    if (card === null) return { pass: false, reason: 'no .tool-card' }
    const head = card.querySelector('.tool-head')
    const body = card.querySelector('.tool-body')
    const raw = body === null ? '' : body.style.getPropertyValue('--collapse-h')
    const match = /^([0-9]+(\\.[0-9]+)?)px$/.exec(raw.trim())
    const measuredPx = match === null ? null : Number(match[1])
    const scrollHeight = body === null ? 0 : body.scrollHeight
    const visibleHeight =
      body === null ? 0 : Math.round(body.getBoundingClientRect().height * 10) / 10
    const open = card.classList.contains('open')
    const ariaExpanded = head === null ? null : head.getAttribute('aria-expanded')
    const varMatches = measuredPx !== null && Math.abs(measuredPx - scrollHeight) <= 2
    const notClipped = body !== null && visibleHeight > 0 && Math.abs(visibleHeight - scrollHeight) <= 2

    // ── 诊断（信息，不参与 pass）：展开中途 / 稳定后的布局对比 ──
    // 保留这段快照是为了让「f77a842 之前 enter 侧少写 66px」那个坑可复现：
    // 当时中途与稳定后的宽度、.thread 的滚动条状态两次**完全一致**，只有 .tool-args
    // 从 13px 变成 79px（正好 66px）。原因是 .tool-body 是 flex 列容器：enter 钩子跑的时候
    // .collapse-enter-from 的 max-height:0 已经挂上，容器没有可用高度，flex 收缩把
    // 唯一的滚动容器子项（.tool-args，overflow:auto，其 min-height:auto 对滚动容器
    // 解析为 0）压到 padding + 边框的最小高度 —— 量到的是「被钳制后的布局」而不是真实内容高，
    // 而且该偏差在整段过渡期间恒定，所以「逐帧轮询到连续两帧相等」也追不到它。
    // 修法：量之前把元素内联的 max-height 临时摘成 none（见 useCollapseTransition）。
    // 注意：本文件这些探针是模板字面量字符串，字符串**内部**的注释不能出现反引号。
    let diagnostic = null
    if (head !== null && body !== null) {
      try {
        const layoutOf = (label) => {
          const current = card.querySelector('.tool-body')
          const thread = document.querySelector('.thread')
          if (current === null) return { label: label, missing: true }
          return {
            label: label,
            var: current.style.getPropertyValue('--collapse-h'),
            width: Math.round(current.getBoundingClientRect().width * 10) / 10,
            scrollHeight: current.scrollHeight,
            threadClientWidth: thread === null ? null : thread.clientWidth,
            threadScrollbar:
              thread === null ? null : thread.offsetWidth - thread.clientWidth > 0,
            children: Array.from(current.children).map((child) => ({
              cls: String(child.className || '').split(' ')[0],
              height: Math.round(child.getBoundingClientRect().height),
            })),
          }
        }
        head.click()
        await wait(80) // 收起刚开始：此时 before-leave 已把实测高度写进内联变量
        const leavingBody = card.querySelector('.tool-body')
        const leaveVar = leavingBody === null ? null : leavingBody.style.getPropertyValue('--collapse-h')
        for (let attempt = 0; attempt < 15 && card.querySelector('.tool-body') !== null; attempt += 1) {
          await wait(80)
        }
        const collapsedTo = card.querySelector('.tool-body') === null ? 'unmounted' : 'still-present'
        // 再展开：中途（enter 之后约 70ms）与稳定后各取一次布局，把「量得早」这件事显影
        head.click()
        await wait(70)
        const mid = layoutOf('enter+70ms')
        await wait(700)
        const settled = layoutOf('settled')
        diagnostic = {
          leaveVar: leaveVar,
          collapsedTo: collapsedTo,
          mid: mid,
          settled: settled,
          reexpandedVar: settled.missing === true ? null : settled.var,
          reexpandedHeight: settled.missing === true ? 0 : settled.scrollHeight,
          reexpandedScrollHeight: settled.missing === true ? 0 : settled.scrollHeight,
        }
      } catch (inner) {
        diagnostic = { error: String(inner) }
      }
    }
    // ── 旁证（信息，不参与 pass）：游离元素的 scrollHeight 恒为 0 ──
    // 现场造一个与 .tool-body 同款（flex 列 + 同 padding）的盒子，先量「未入文档」、
    // 再量「已入文档」：前者为 0、后者是真实内容高。这条守着「进入方向不能挂 @before-enter」
    // 那个坑 —— Vue 的 beforeEnter 在 hostInsert **之前**调用，量到的是游离元素。
    let detachedMeasureProbe = null
    try {
      const sample = document.createElement('div')
      sample.style.cssText = 'display:flex;flex-direction:column;gap:4px;padding:0 8px 8px;'
      const inner = document.createElement('div')
      inner.style.cssText = 'height:120px;'
      sample.appendChild(inner)
      const whileDetached = sample.scrollHeight
      document.body.appendChild(sample)
      const whileAttached = sample.scrollHeight
      sample.remove()
      detachedMeasureProbe = { whileDetached, whileAttached }
    } catch (inner) {
      detachedMeasureProbe = { error: String(inner) }
    }

    const stillExpanded = card.classList.contains('open') === true && card.querySelector('.tool-body') !== null
    // 展开**确实在动**的判据：第一帧采样（点击后 60ms）必须严格小于稳定高度。
    // 终值在「正常过渡」与「退化成瞬跳」两种实现下相同（都已等于内容高），
    // 所以只有中间样本能区分它们 —— 把「过渡类挂上了但 max-height 不可插值 → 直接落位」
    // 这一档也钉住（这种退化的终值照样正确，但观感是瞬跳）。
    // 只取 60ms 那一帧：更晚的样本在慢机器上可能已越过 250ms 的过渡窗口而误判。
    const samples = probe === undefined || probe === null ? [] : probe.samples || []
    const firstSample = samples.length > 0 ? samples[0].height : null
    const animating = firstSample !== null && firstSample < visibleHeight - 2
    return {
      act: probe === undefined ? null : probe,
      cardField: card.getAttribute('data-field'),
      open,
      ariaExpanded,
      collapseVar: raw,
      measuredPx,
      scrollHeight,
      visibleHeight,
      varMatchesScrollHeight: varMatches,
      notClipped,
      firstSampleHeight: firstSample,
      animating,
      diagnostic,
      detachedMeasureProbe,
      stillExpanded,
      pass:
        probe !== undefined &&
        open === true &&
        ariaExpanded === 'true' &&
        body !== null &&
        varMatches === true &&
        notClipped === true &&
        animating === true &&
        stillExpanded === true,
    }
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

/**
 * 左栏归档分组探针 · 前半（2026-09-26 归档 UI 的运行时证据）。
 *
 * act 只展开归档分组（点 `chat.archive-toggle`，轮询等 `chat.archive-list` 出现），
 * 截图即「分组展开、已归档会话列在里面」的现场。归档 / 取消归档这条会改状态的往返放在 check 里
 * （截图先拍，动作后做），并由 check 收尾还原 —— 否则后面的场景看到的会是被改过的左栏。
 */
export const CHAT_ARCHIVE_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const toggle = document.querySelector('[data-field="chat.archive-toggle"]')
    if (toggle === null) {
      return {
        ready: false,
        reason: 'no [data-field="chat.archive-toggle"]（seed 的已归档会话没被读到？）',
      }
    }
    toggle.click()
    let rows = 0
    for (let attempt = 0; attempt < 15 && rows === 0; attempt += 1) {
      rows = document.querySelectorAll('[data-field="chat.archive-list"] .nav-item').length
      if (rows === 0) await wait(120)
    }
    return {
      ready: true,
      expanded: toggle.getAttribute('aria-expanded'),
      label: (toggle.textContent || '').replace(/\\s+/g, ' ').trim(),
      rows: rows,
    }
  } catch (error) {
    return { ready: false, reason: String(error) }
  }
})()`

/**
 * 左栏归档探针 · 后半：分组结构 + 「不混进主列表」+ **通过真实 UI 走一遍归档 / 取消归档**。
 *
 * 断言五件事：
 * 1. `chat.archive-group` 在、`chat.archive-toggle` 的 `aria-expanded === 'true'`、
 *    `chat.archive-list` 里的 `.nav-item` ≥ 1、分组标题带计数（「已归档 · N」）；
 * 2. seed 的那条已归档会话**不在** `chat.session-list` 里（按它的唯一标题文本判定），
 *    而在 `chat.archive-list` 里 —— 归档分组不是把同一条渲染两遍；
 * 3. 点主列表某一行的 `[data-action="chat.archive-session"]`（真实 DOM click → Vue emit →
 *    `chat:archiveSession` IPC → 重拉列表）后：它离开主列表、出现在归档列表，两边计数各 ±1；
 * 4. 再点该行 `[data-action="chat.unarchive-session"]` 撤销：回到主列表、计数还原
 *    —— 这一步必须做，否则后面的场景看到的就是被改过的左栏；
 * 5. 收尾收起归档分组（不留展开态）、确认没有浮层与输入残留。
 *
 * 计数变化与最终状态一并回传，失败时不用去猜是哪一步偏了。
 */
export const CHAT_ARCHIVE_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const MAIN = '[data-field="chat.session-list"] .nav-item'
    const ARCH = '[data-field="chat.archive-list"] .nav-item'
    const count = (selector) => document.querySelectorAll(selector).length
    const textOf = (el) => ((el === null ? '' : el.textContent) || '').replace(/\\s+/g, ' ').trim()
    const toggle = document.querySelector('[data-field="chat.archive-toggle"]')
    const problems = []
    const result = {
      groupPresent: count('[data-field="chat.archive-group"]') === 1,
      togglePresent: toggle !== null,
      ariaExpanded: toggle === null ? null : toggle.getAttribute('aria-expanded'),
      toggleLabel: toggle === null ? '' : textOf(toggle),
      mainRows: count(MAIN),
      archiveRows: count(ARCH),
      seedInMain: textOf(document.querySelector('[data-field="chat.session-list"]')).indexOf('archive-seed') !== -1,
      seedInArchive: textOf(document.querySelector('[data-field="chat.archive-list"]')).indexOf('archive-seed') !== -1,
    }
    if (result.groupPresent !== true) problems.push('chat.archive-group 不存在')
    if (result.togglePresent !== true) problems.push('chat.archive-toggle 不存在')
    if (result.ariaExpanded !== 'true') problems.push('归档分组未展开（aria-expanded=' + result.ariaExpanded + '）')
    if (result.archiveRows < 1) problems.push('归档列表里没有会话行')
    // 计数与锚点（标题文案「已归档 · N」里的 N 必须与实际行数一致）
    const countMatch = /已归档[^0-9]*([0-9]+)/.exec(result.toggleLabel)
    result.toggleCount = countMatch === null ? null : Number(countMatch[1])
    if (result.toggleCount !== result.archiveRows) {
      problems.push('分组计数与实际行数不符：' + result.toggleCount + ' vs ' + result.archiveRows)
    }
    if (result.seedInMain === true) problems.push('seed 的已归档会话仍出现在主列表')
    if (result.seedInArchive !== true) problems.push('seed 的已归档会话不在归档列表里')

    // 3) 通过真实 UI 归档一条未归档会话（**优先取当前正在看的那条**）
    //    为什么优先 active 行：归档当前会话时，主区头部必须出现「已归档 + 取消归档」提示条
    //    —— 那是这条链路上唯一会显示提示条的时机，也是 docs/07 §2.3 明确写下的行为。
    //    取第一行的话，被归档的可能不是当前会话，提示条那条判据就永远测不到。
    const beforeMain = result.mainRows
    const beforeArchive = result.archiveRows
    const activeRow = document.querySelector('[data-field="chat.session-list"] .nav-row.active')
    const targetRow =
      activeRow !== null ? activeRow : document.querySelector('[data-field="chat.session-list"] .nav-row')
    result.targetWasActive = activeRow !== null
    const archiveButton =
      targetRow === null ? null : targetRow.querySelector('[data-action="chat.archive-session"]')
    const movedTitle = targetRow === null ? '' : textOf(targetRow.querySelector('.nav-item'))
    result.movedTitle = movedTitle
    if (archiveButton === null) {
      problems.push('主列表里没有可归档的行（archive-session 按钮未找到）')
    } else {
      archiveButton.click()
      let archived = false
      for (let attempt = 0; attempt < 25 && !archived; attempt += 1) {
        await wait(120)
        archived =
          count(MAIN) === beforeMain - 1 &&
          count(ARCH) === beforeArchive + 1 &&
          textOf(document.querySelector('[data-field="chat.archive-list"]')).indexOf(movedTitle) !== -1
      }
      result.afterArchive = {
        mainRows: count(MAIN),
        archiveRows: count(ARCH),
        inArchive: textOf(document.querySelector('[data-field="chat.archive-list"]')).indexOf(movedTitle) !== -1,
        inMain: textOf(document.querySelector('[data-field="chat.session-list"]')).indexOf(movedTitle) !== -1,
      }
      if (
        result.afterArchive.mainRows !== beforeMain - 1 ||
        result.afterArchive.archiveRows !== beforeArchive + 1 ||
        result.afterArchive.inArchive !== true ||
        result.afterArchive.inMain === true
      ) {
        problems.push('归档后计数 / 归属不符：' + JSON.stringify(result.afterArchive))
      }

      // 3b) 归档的是当前会话 → 主区头部必须出现「已归档 + 取消归档」提示条
      if (result.targetWasActive === true) {
        const banner = document.querySelector('[data-field="chat.archived-banner"]')
        result.bannerAfterArchive = {
          present: banner !== null,
          text: banner === null ? '' : textOf(banner),
          hasUnarchive:
            banner !== null && banner.querySelector('[data-action="chat.unarchive-current"]') !== null,
        }
        if (result.bannerAfterArchive.present !== true) {
          problems.push('归档当前会话后头部没有「已归档」提示条')
        } else if (result.bannerAfterArchive.text.indexOf('已归档') === -1) {
          problems.push('提示条文案不含「已归档」：' + result.bannerAfterArchive.text)
        } else if (result.bannerAfterArchive.hasUnarchive !== true) {
          problems.push('提示条上没有「取消归档」按钮')
        }
      }

      // 4) 再点一次撤销（必须做：后面的场景不该看到被改过的左栏）
      const archiveRows = Array.from(document.querySelectorAll('[data-field="chat.archive-list"] .nav-row'))
      let movedRow = null
      for (const candidate of archiveRows) {
        const item = candidate.querySelector('.nav-item')
        if (item !== null && textOf(item).indexOf(movedTitle) === 0) {
          movedRow = candidate
          break
        }
      }
      const unarchiveButton = movedRow === null ? null : movedRow.querySelector('[data-action="chat.unarchive-session"]')
      if (unarchiveButton === null) {
        problems.push('归档列表里没找到刚归档那条的「取消归档」按钮')
      } else {
        unarchiveButton.click()
        let restored = false
        for (let attempt = 0; attempt < 25 && !restored; attempt += 1) {
          await wait(120)
          restored =
            count(MAIN) === beforeMain &&
            count(ARCH) === beforeArchive &&
            textOf(document.querySelector('[data-field="chat.session-list"]')).indexOf(movedTitle) !== -1
        }
        result.afterUnarchive = {
          mainRows: count(MAIN),
          archiveRows: count(ARCH),
          inMain: textOf(document.querySelector('[data-field="chat.session-list"]')).indexOf(movedTitle) !== -1,
          inArchive: textOf(document.querySelector('[data-field="chat.archive-list"]')).indexOf(movedTitle) !== -1,
        }
        if (
          result.afterUnarchive.mainRows !== beforeMain ||
          result.afterUnarchive.archiveRows !== beforeArchive ||
          result.afterUnarchive.inMain !== true ||
          result.afterUnarchive.inArchive === true
        ) {
          problems.push('撤销归档后计数 / 归属不符：' + JSON.stringify(result.afterUnarchive))
        }
        // 撤销之后提示条必须消失（否则它会常驻挂着，误导「这个会话还是归档的」）
        if (result.targetWasActive === true) {
          let bannerGone = false
          for (let attempt = 0; attempt < 15 && !bannerGone; attempt += 1) {
            bannerGone = count('[data-field="chat.archived-banner"]') === 0
            if (!bannerGone) await wait(120)
          }
          result.bannerGoneAfterUnarchive = bannerGone
          if (bannerGone !== true) problems.push('撤销归档后「已归档」提示条没有消失')
        }
      }
    }

    // 5) 收尾：收起归档分组 + 清掉任何浮层 / 输入残留
    if (toggle !== null && toggle.getAttribute('aria-expanded') === 'true') toggle.click()
    let collapsed = false
    for (let attempt = 0; attempt < 15 && !collapsed; attempt += 1) {
      collapsed = count('[data-field="chat.archive-list"]') === 0
      if (!collapsed) await wait(120)
    }
    const outside = document.querySelector('.thread') || document.body
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    const box = document.querySelector('.composer-input')
    if (box !== null && box.value !== '') {
      box.value = ''
      box.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await wait(200)
    const leftovers = [
      '[data-field="chat.slash-menu"]',
      '[data-field="chat.permission-menu"]',
      '[data-field="chat.context-detail"]',
    ].filter((selector) => count(selector) > 0)
    result.collapsed = collapsed
    result.leftovers = leftovers
    result.inputEmpty = box === null ? null : box.value === ''
    result.problems = problems
    if (collapsed !== true) problems.push('归档分组没收起（会留下展开态给后续场景）')
    if (leftovers.length > 0) problems.push('仍有浮层残留：' + leftovers.join(','))
    if (result.inputEmpty !== true) problems.push('输入框有残留内容')
    result.pass = problems.length === 0
    return result
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 右栏开关探针 · 前半（BetaV2）：点两次 `chat.right-panel-toggle` 走「展开 → 收起 → 展开」。
 *
 * 点击走真实 DOM 链路（按钮 → emit → App.vue 的 `contextOpen` → `.context.collapsed` 宽度过渡）。
 * 两次点击让场景**自恢复**：截图时右栏回到展开态（截图本身就是三栏默认布局的证据），
 * 收起态只活在 act 内部的记录里，由 check 判定 —— 不用为它多拍一张图。
 */
export const CHAT_RIGHT_PANEL_TOGGLE_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const toggle = document.querySelector('[data-field="chat.right-panel-toggle"]')
    const panel = document.querySelector('.context')
    if (toggle === null || panel === null) {
      return { ok: false, reason: 'no right-panel toggle or .context' }
    }
    const isOpen = () => panel.classList.contains('collapsed') === false
    const before = isOpen()
    toggle.click()
    await wait(600)
    const afterHide = !isOpen()
    toggle.click()
    await wait(600)
    const afterShow = isOpen()
    window.__auroraRightPanelProbe = { before, afterHide, afterShow }
    return { ok: true, before, afterHide, afterShow }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`

/**
 * 右栏开关探针 · 后半：act 记录的「收起又展开」三态必须全部成立，且此刻右栏仍是展开的
 * （展开态 = 截图里的布局，收起只允许存在于两次点击之间的瞬时）。
 */
export const CHAT_RIGHT_PANEL_TOGGLE_CHECK = `(() => {
  try {
    const probe = window.__auroraRightPanelProbe
    const panel = document.querySelector('.context')
    const openNow = panel !== null && panel.classList.contains('collapsed') === false
    return {
      act: probe === undefined ? null : probe,
      openNow,
      contextWidth: panel === null ? null : Math.round(panel.getBoundingClientRect().width),
      pass:
        probe !== undefined &&
        probe.before === true &&
        probe.afterHide === true &&
        probe.afterShow === true &&
        openNow,
    }
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

/**
 * 右栏模式感知探针（BetaV2，spec §3/§11）：把模式切到 Work，右栏必须整体换成办公卡片。
 *
 * 「非当前模式的功能一律不渲染」钉的是这条：work 态右栏要有「工作目录」卡、
 * 不得再有 classroom 的「今日课程」卡。ContextPanel 没有 data-field 锚点（按卡头文案定位）；
 * 切模式走 `window.aurora.mode.set`（与设置页「启用」同一条 IPC），主进程会广播
 * mode:changed → 渲染层 modeStore / ContextPanel 随之更新。
 *
 * ⚠️ 引导副作用是安全的：work 引导未完成时 `mode.set` 会触发 `requestGuideIfNeeded`，
 * 但主进程的 proactive 实现只是 `showChat()` + 日志（见 index.ts），不写会话、不弹窗体，
 * 不会污染 seed 会话。check 收尾把模式切回 classroom 并等「今日课程」卡回来，
 * 后续场景（chat-tts / auto-scroll）的 classroom 现场不受影响。
 */
export const CHAT_RIGHT_PANEL_WORK_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const state = await window.aurora.settings.get()
    if (!state.ok) return { ok: false, reason: 'settings.get failed' }
    window.__auroraWorkPanelProbe = { previousMode: state.value.modes.current }
    if (state.value.modes.current === 'work') return { ok: true, alreadyWork: true }
    const result = await window.aurora.mode.set('work')
    if (!result.ok) return { ok: false, reason: 'mode.set failed: ' + result.message }
    let found = false
    for (let attempt = 0; attempt < 20 && !found; attempt += 1) {
      const heads = Array.from(
        document.querySelectorAll('.context .ctx-card .ctx-head strong'),
      ).map((el) => (el.textContent || '').trim())
      found = heads.some((name) => name.indexOf('工作目录') !== -1)
      if (!found) await wait(200)
    }
    return { ok: true, workCardShown: found }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`

/** 右栏模式感知探针 · 后半：work 卡在、课堂卡不在，收尾切回 classroom 并等课堂卡恢复。 */
export const CHAT_RIGHT_PANEL_WORK_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const ctxCards = () =>
    Array.from(document.querySelectorAll('.context .ctx-card .ctx-head strong')).map((el) =>
      (el.textContent || '').trim(),
    )
  try {
    const probe = window.__auroraWorkPanelProbe
    const cards = ctxCards()
    const hasWork = cards.some((name) => name.indexOf('工作目录') !== -1)
    const hasClassroom = cards.some((name) => name.indexOf('今日课程') !== -1)

    // 收尾：切回 classroom（模式是全局状态，不还原会带进后面的场景）
    let restored = null
    const state = await window.aurora.settings.get()
    if (state.ok && state.value.modes.current === 'work') {
      const back = await window.aurora.mode.set('classroom')
      if (!back.ok) {
        restored = false
      } else {
        restored = false
        for (let attempt = 0; attempt < 10 && !restored; attempt += 1) {
          restored = ctxCards().some((name) => name.indexOf('今日课程') !== -1)
          if (!restored) await wait(200)
        }
      }
    } else if (state.ok) {
      restored = true
    }
    return {
      previousMode: probe === undefined ? null : probe.previousMode,
      workCards: cards,
      hasWork,
      hasClassroom,
      restored,
      pass: probe !== undefined && hasWork && !hasClassroom && restored === true,
    }
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

/**
 * 思考过程折叠块探针（BetaV2，spec §9/§11）：MessageList 对带 `reasoning` 的助手消息
 * 渲染可折叠「思考过程」块，受 `general.chat.showThinking` 门控。
 *
 * 前提由 `seedChatTtsHistory` 提供：main 会话的助手消息带 `reasoning`（含探针标记文本），
 * `rendererHistory` 会把它透传回渲染层（agent-core store 的 StoredMessage 支持 `reasoning?`）。
 * 历史水合出的思考块**默认收起**（「已深度思考」摘要行）——act 先记录收起态再点开，
 * 截图拍到展开后的全文；check 断言「曾收起 + 现已展开 + 正文含标记 + 块在正文上方」。
 */
export const CHAT_THINKING_BLOCK_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const block = document.querySelector('.message.r-assistant .thinking')
    if (block === null) {
      return {
        ok: false,
        reason: 'no .thinking block（seed 会话缺 reasoning，或 general.chat.showThinking 被关？）',
      }
    }
    const head = block.querySelector('.thinking-head')
    if (head === null) return { ok: false, reason: 'no .thinking-head' }
    const collapsedBefore =
      block.classList.contains('open') === false && block.querySelector('.thinking-body') === null
    const label = (head.textContent || '').trim()
    const labelOk = label.indexOf('已深度思考') !== -1
    head.click()
    await wait(500)
    window.__auroraThinkingProbe = { collapsedBefore, label, labelOk }
    return { ok: true, collapsedBefore, label, labelOk }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`

/** 思考过程折叠块探针 · 后半：展开态全文可见、文本是 seed 的标记内容，且块位于正文上方。 */
export const CHAT_THINKING_BLOCK_CHECK = `(() => {
  try {
    const probe = window.__auroraThinkingProbe
    const block = document.querySelector('.message.r-assistant .thinking')
    if (block === null) return { pass: false, reason: 'no .thinking block' }
    const open = block.classList.contains('open')
    const body = block.querySelector('.thinking-body')
    const textNode = body === null ? null : body.querySelector('.thinking-text')
    const text = textNode === null ? '' : (textNode.textContent || '')
    const rect = textNode === null ? null : textNode.getBoundingClientRect()
    const visible = rect !== null && rect.width > 0 && rect.height > 0
    // 块在正文上方（docs/07 §2.3）：DOM 顺序上 .thinking 必须先于同气泡内的 .md
    const content = block.parentElement === null ? null : block.parentElement.querySelector('.md')
    const aboveContent =
      content !== null &&
      (block.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    return {
      act: probe === undefined ? null : probe,
      open,
      bodyVisible: visible,
      textLength: text.length,
      textPreview: text.slice(0, 48),
      aboveContent,
      pass:
        probe !== undefined &&
        probe.collapsedBefore === true &&
        probe.labelOk === true &&
        open === true &&
        visible &&
        text.indexOf('capture-reasoning-probe') !== -1 &&
        aboveContent,
    }
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

/**
 * 快速会话探针（BetaV2 口径不变，2026-09 重构确认）：点左栏固定项「快速对话」
 * 必须切到 sessionId='quick'（快速对话的**输入入口在桌面提示条面板**，docs/07 §2.2；
 * 主界面左栏固定项沿用「点击切主区会话」）。
 *
 * 激活的判据有二：`chat.quick-item` 拿到 `.active` 态，且主区标题 `.head-name` 变成
 * 固定名「快速对话」（`currentTitle` 对 quick 会话短路返回）。act 里轮询等标题变化
 * （switchSession 的水合是异步往返），check 再读一次激活态兜住时序。
 *
 * 场景结束后停在 quick 会话：后续场景里 `chat-tts` 自带 reload（回到默认 main 会话），
 * 思考等级 / 模型选择两条只依赖 provider 配置、与会话无关，因此无需专门还原。
 */
export const CHAT_QUICK_SESSION_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const item = document.querySelector('[data-field="chat.quick-item"]')
    if (item === null) return { ok: false, reason: 'no chat.quick-item' }
    item.click()
    let title = ''
    for (let attempt = 0; attempt < 15; attempt += 1) {
      title = (((document.querySelector('.head-name') || {}).textContent || '')).trim()
      if (title === '快速对话') break
      await wait(200)
    }
    return { ok: true, headTitle: title }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`

/** 快速会话探针 · 后半：固定项激活 + 主区标题为「快速对话」。 */
export const CHAT_QUICK_SESSION_CHECK = `(() => {
  try {
    const item = document.querySelector('[data-field="chat.quick-item"]')
    const title = (((document.querySelector('.head-name') || {}).textContent || '')).trim()
    return {
      quickActive: item !== null && item.classList.contains('active'),
      headTitle: title,
      pass: item !== null && item.classList.contains('active') && title === '快速对话',
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
 *
 * BetaV2（六页 IA）：「勿扰时段」（`advanced.quietHours`）自 AdvancedPage 迁到 general 页，
 * 与提示条自己的静默时段同区 —— 所以这里**新增** `advanced.quietHours.start/.end` 两个字段的
 * 存在性断言（AdvancedPage 不再渲染它们， 数到 >0 才是回归）。
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
    // BetaV2：全局勿扰时段（advanced.quietHours.start/.end）迁到 general 页且常显
    const quietHoursFields = count('[data-field^="advanced.quietHours"]')
    // v13 项目机制（docs/06 §5.1）：项目区组常显，列表可空可非空 —— 只断言「空态或至少一行」，
    // 不写死条数（用户有几个项目都能过）。
    const projectsFields = count('[data-field^="projects."]')
    const projectsRows = count('[data-field="projects.name"]')
    const projectsEmpty = emptyStates.indexOf('projects.list') !== -1
    // 本页**预期**会出现的 data-empty：提示条停用时那一条，与"还没有项目"那一条。
    // 其余任何空态出现都是回归（照 SETTINGS_AGENT_FIELDS_SCRIPT 的白名单口径）。
    const unexpected = emptyStates.filter(
      (name) => name !== 'general.edgeBar' && name !== 'projects.list',
    )
    const activeMode = document.querySelector('.cards .card.active .card-head strong')
    const activeNav = document.querySelector('.nav-item.active')
    return {
      page: activeNav === null ? 'unknown' : (activeNav.textContent || '').trim(),
      classroomFields,
      languageFields,
      edgeBarToggle,
      edgeBarDetail,
      quietHoursFields,
      projectsFields,
      projectsRows,
      projectsEmpty,
      unexpected,
      activeMode: activeMode === null ? null : (activeMode.textContent || '').trim(),
      emptyStates,
      // 死字段（general.language）在任何页面都不该出现；提示条详情跟着开关走；
      // 全局勿扰时段两个字段必须随页常在；项目区组要么给出空态、要么至少渲染一行；
      // 且不得出现两块预期空态之外的 data-empty。
      pass:
        languageFields === 0 &&
        quietHoursFields === 2 &&
        (edgeBarToggle === 0 ? edgeBarDetail === 0 : edgeBarDetail > 0) &&
        (projectsEmpty || projectsRows > 0) &&
        (projectsEmpty || projectsFields > 0) &&
        unexpected.length === 0,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 「智能与工具」设置页门控探针（docs/08 §6.1、step 5；BetaV2 六页 IA）。
 *
 * 与 `SETTINGS_FIELDS_SCRIPT` 同一套路：`data-field` 计数 + `data-empty` 列表，
 * 但这里要额外读**总开关的实际状态**——`agent.tools.enabled` 为 false 时三个分栏控件
 * 本来就该整块消失（只剩总开关与工作目录两个常显字段）。
 *
 * ⚠️ BetaV2 变更（spec §9）：技能页与 MCP 页并入本页，「空配置下 emptyStates 为空」的旧断言
 * 不再成立 —— MCP 无服务器时整页**必然**多出 `data-empty="mcp.servers"`（空状态卡整块替换
 * 列表），技能一个都没发现时还会有 `data-empty="skills.disabled"`。所以断言改成：
 * 这两个**预期**空状态允许出现（MCP 必须二选一：空状态或服务器行），
 * 之外的任何 `data-empty` 都算回归（比如 agent.tools.* 的分栏空态在总开关开启时不该出现）。
 *
 * ⚠️ 2026-09 收拢轮（docs/07 §2.5）：技能与 MCP 区组**默认收起**，折叠体是 v-if 不渲染 ——
 * 上面的锚点与 `data-empty` 在收起态不在 DOM，直接计数会全 0、探针假 FAIL。所以本脚本改成
 * **async IIFE**：先点开两组（`[data-group]` 组锚点 → `.group-head`），等 Vue 渲染 +
 * collapse 动画（max-height 过渡）走完，再做全部计数与断言。`executeJavaScript` 会 await
 * 这里返回的 Promise（captureWindows 的 check 调用点无需改动）；点击发生在截图**之后**，
 * `settings-agent.png` 拍到的仍是默认收起态。工具组默认展开，无需处理。
 *
 * ⚠️ 2026-09 step 5：终端栏下新增「免确认命令模式」列表（`agent.tools.terminal.allowPatterns`，
 * v12）。探针只数**容器**（`allowPatternsFields === 1`）—— 列表行与输入框都在容器内部且不带
 * 同前缀的 `data-field`，所以这个数在空列表 / 非空列表下都恒为 1；列表的空状态用的是普通
 * 文案元素（**不是** `data-empty`），否则本页会多出一块 `unexpected` 直接 FAIL。
 */
export const SETTINGS_AGENT_FIELDS_SCRIPT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    for (const group of ['skills', 'mcp']) {
      const head = document.querySelector('[data-group="' + group + '"] .group-head')
      if (head !== null && head.getAttribute('aria-expanded') === 'false') head.click()
    }
    // 等两组的 v-if 渲染 + collapse 折叠动画走完（动画是 max-height 过渡，见 theme.css）
    await wait(400)
    const count = (selector) => document.querySelectorAll(selector).length
    const toggle = document.querySelector('[data-field="agent.tools.enabled"] input[type="checkbox"]')
    const enabled = toggle === null ? null : toggle.checked
    const total = count('[data-field^="agent.tools"]')
    const terminalFields = count('[data-field^="agent.tools.terminal"]')
    const filesFields = count('[data-field^="agent.tools.files"]')
    const searchFields = count('[data-field^="agent.tools.search"]')
    const openFields = count('[data-field^="agent.tools.open"]')
    // 免确认命令模式容器（v12，docs/06 §11.7）：**恰好一个** ——
    // 列表行与输入框都在它内部，都**不带**这个前缀的 data-field，所以这里永远该是 1。
    const allowPatternsFields = count('[data-field^="agent.tools.terminal.allowPatterns"]')
    const emptyStates = Array.from(document.querySelectorAll('[data-empty]')).map((el) =>
      el.getAttribute('data-empty'),
    )
    // 合并区组的预期空状态：MCP 无服务器（空状态）或有服务器（行容器）二选一；
    // 技能同理（内置技能发现不到才会有 skills.disabled 空状态）
    const mcpEmpty = emptyStates.indexOf('mcp.servers') !== -1
    const mcpRows = count('[data-field^="mcp.servers."]')
    const skillsEmpty = emptyStates.indexOf('skills.disabled') !== -1
    const skillsRows = count('[data-field^="skills.disabled."]')
    // v14 写前快照（docs/06 §11.8）：四个字段常显（enabled=false 时三块换成 data-empty="agent.snapshots"）
    const snapshotFields = count('[data-field^="agent.snapshots."]')
    const snapshotEmpty = emptyStates.indexOf('agent.snapshots') !== -1
    // v15 Agent 循环（docs/06 §4.1）：三个字段常显（不跟 agent.tools.enabled 门控）
    const loopFields = count('[data-field^="agent.loop."]')
    const unexpected = emptyStates.filter(
      (name) =>
        name !== 'mcp.servers' &&
        name !== 'skills.disabled' &&
        // 本页预期空态：关掉文件备份时那一条（默认开启，通常不出现）
        name !== 'agent.snapshots',
    )
    const activeNav = document.querySelector('.nav-item.active')
    const page = activeNav === null ? 'unknown' : (activeNav.textContent || '').trim()

    // 只读档摘要（v13，docs/06 §11.2）：切到 readonly 后，区组摘要必须说"仅注册只读工具"，
    // 且生效工具名集合里不能出现写 / 执行类。这一条是"界面摘要不骗人"的运行时证据 ——
    // 设置页的摘要与实际注册表是两套代码，只断言主进程注册表的话，摘要写错也没人发现。
    // 必须走 settings:update（SettingsStore 启动即缓存），收尾还原成 confirm。
    let readonlySummary = null
    let readonlyTools = null
    let readonlyRestored = null
    const before = await window.aurora.settings.get()
    if (before.ok) {
      await window.aurora.settings.update({
        agent: { ...before.value.agent, permissionMode: 'readonly' },
      })
      await wait(400)
      const bodyText = (document.body.textContent || '').replace(/\\s+/g, ' ')
      readonlySummary = bodyText.indexOf('只读模式：仅注册只读工具（不含写入与命令）') !== -1
      // 只断言「当前生效工具」那一块列出的名字：页面上别处仍会提到写类工具（各个工具箱的标题、
      // 门控说明），拿整页文本判定会把正常的说明文字当成违规。
      const activeBlock = Array.from(document.querySelectorAll('.sub')).find((el) => {
        const title = el.querySelector('.sub-title')
        return title !== null && (title.textContent || '').indexOf('当前生效工具') !== -1
      })
      const listed = activeBlock === undefined
        ? []
        : Array.from(activeBlock.querySelectorAll('code')).map((el) => (el.textContent || '').trim())
      const forbidden = ['run_command', 'write_file', 'edit_file', 'open_path', 'todo_write']
      readonlyTools =
        listed.indexOf('read_file') !== -1 &&
        listed.indexOf('list_dir') !== -1 &&
        forbidden.every((name) => listed.indexOf(name) === -1)
      await window.aurora.settings.update({
        agent: { ...before.value.agent, permissionMode: 'confirm' },
      })
      await wait(300)
      readonlyRestored =
        (document.body.textContent || '').indexOf('只读模式：仅注册只读工具（不含写入与命令）') === -1
    }

    return {
      page,
      togglePresent: toggle !== null,
      enabled,
      total,
      terminalFields,
      allowPatternsFields,
      filesFields,
      searchFields,
      openFields,
      mcpEmpty,
      mcpRows,
      skillsEmpty,
      skillsRows,
      unexpected,
      emptyStates,
      readonlySummary,
      readonlyTools,
      readonlyRestored,
      snapshotFields,
      snapshotEmpty,
      loopFields,
      // 总开关必须在（否则用户再也开不回来）；开着时四个分栏的详情字段都得在
      // （终端 / 文件 / 文件检索 / 打开），MCP 区组必须给出「空状态或行」之一，
      // 且不得出现两块预期空态之外的 data-empty。
      // v12 起终端栏下多一个「免确认命令模式」容器（allowPatternsFields）——
      // 它挂在终端卡片之后并跟随总开关渲染，所以断言写进 enabled !== true 的那一支；
      // ⚠️ terminalFields 刻意**不写死数值**（> 0 即可）：这个子前缀下还会继续加字段，
      // 写死数值会让探针在下一次扩展时无谓变红，而它要守的只是「终端栏的详情字段在不在」。
      pass:
        toggle !== null &&
        (enabled !== true ||
          (terminalFields > 0 &&
            allowPatternsFields === 1 &&
            filesFields > 0 &&
            searchFields >= 2 &&
            openFields > 0 &&
            (mcpEmpty || mcpRows > 0) &&
            unexpected.length === 0)) &&
        readonlySummary === true &&
        readonlyTools === true &&
        readonlyRestored === true &&
        // 文件备份区组：开着时四个字段都在，关掉时是空态（两种形态都算过，不写死数字）
        (snapshotFields >= 4 || snapshotEmpty === true) &&
        // v15：Agent 循环三个字段常显（关掉工具总开关也必须在）
        loopFields >= 3 &&
        unexpected.length === 0,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 「语音」设置页门控探针（docs/08 §6.1、BetaV2 六页 IA；原 `SETTINGS_TTS_FIELDS_SCRIPT` 扩展）。
 *
 * BetaV2（spec §9）：voice 页 = TTS 区组（原 TtsPage 整体迁入，`tts.*` 锚点不变）
 * + STT 区组（新增，`stt.*`）。两组各自折叠（默认展开）、各自为**常显字段 + 列表空态二选一**：
 * - `tts.enabled` / `tts.autoRead` / `tts.maxChars` 与 `stt.enabled` / `stt.active` 都是**常显**
 *   （总开关关掉也要能开回来），任何列表状态下都必须存在；
 * - 列表为空时**多出来**的断言是 `data-empty="tts.providers"` / `data-empty="stt.providers"`
 *   必须在；列表非空时反过来，空状态必须消失。
 *
 * ⚠️ 首版（旧 TtsPage 探针）曾把 `autoRead` / `maxChars` 写进二选一，导致空列表下 `pass`
 * 永远为 false（实测抓到）—— 常显字段与列表空态是两件事，别再混。
 *
 * 「列表是否为空」的判据用**两个信号取或**（`emptyStates` 含对应键，或存在
 * `tts|stt.providers.<id>` 行容器）；行容器判定与 `SETTINGS_LLM_STRUCTURE_CHECK` 同构：
 * `data-field` 以 `tts.providers.` / `stt.providers.` 开头、且**后面不再有点**。
 */
export const SETTINGS_VOICE_FIELDS_SCRIPT = `(() => {
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const emptyStates = Array.from(document.querySelectorAll('[data-empty]')).map((el) =>
      el.getAttribute('data-empty'),
    )
    const countRows = (prefix) =>
      Array.from(document.querySelectorAll('[data-field]')).filter((el) => {
        const value = el.getAttribute('data-field') || ''
        return value.indexOf(prefix) === 0 && value.slice(prefix.length).indexOf('.') === -1
      }).length
    const activeNav = document.querySelector('.nav-item.active')

    // ── TTS 区组（原 TtsPage 锚点，逐字未动） ──
    const ttsToggle = document.querySelector('[data-field="tts.enabled"] input[type="checkbox"]')
    const ttsProvidersEmpty = emptyStates.indexOf('tts.providers') !== -1
    const ttsRows = countRows('tts.providers.')
    const ttsListEmpty = ttsProvidersEmpty || ttsRows === 0
    const autoReadFields = count('[data-field="tts.autoRead"]')
    const maxCharsFields = count('[data-field="tts.maxChars"]')

    // ── STT 区组（BetaV2 新增） ──
    const sttToggle = document.querySelector('[data-field="stt.enabled"] input[type="checkbox"]')
    const sttActiveFields = count('[data-field="stt.active"]')
    const sttProvidersEmpty = emptyStates.indexOf('stt.providers') !== -1
    const sttRows = countRows('stt.providers.')
    const sttListEmpty = sttProvidersEmpty || sttRows === 0

    return {
      page: activeNav === null ? 'unknown' : (activeNav.textContent || '').trim(),
      tts: {
        togglePresent: ttsToggle !== null,
        enabled: ttsToggle === null ? null : ttsToggle.checked,
        providerFields: count('[data-field^="tts.providers"]'),
        providerRows: ttsRows,
        autoReadFields,
        maxCharsFields,
        listEmpty: ttsListEmpty,
        emptyStateMarked: ttsProvidersEmpty,
      },
      stt: {
        togglePresent: sttToggle !== null,
        enabled: sttToggle === null ? null : sttToggle.checked,
        activeFields: sttActiveFields,
        providerFields: count('[data-field^="stt.providers"]'),
        providerRows: sttRows,
        listEmpty: sttListEmpty,
        emptyStateMarked: sttProvidersEmpty,
      },
      emptyStates,
      pass:
        ttsToggle !== null &&
        autoReadFields > 0 &&
        maxCharsFields > 0 &&
        (ttsListEmpty ? ttsProvidersEmpty : !ttsProvidersEmpty) &&
        sttToggle !== null &&
        sttActiveFields > 0 &&
        (sttListEmpty ? sttProvidersEmpty : !sttProvidersEmpty),
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 「Aurora Center」页探针（v0.2.2 设备授权登录改造后的卡片结构）：
 * 连接设置卡必须含 开关 / 服务器地址 / 展示名 / 账号 / 密码（write-only）/「登录账户」
 * （设备授权主按钮）/「密码登录」（直登回落按钮）/ clientId 只读位；隔离 userData 无令牌 →
 * 徽章必须是「未登录」、clientId 显示「尚未生成」；连接状态卡（5s 轮询）必须常在。
 */
export const SETTINGS_CENTER_FIELDS_SCRIPT = `(() => {
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const activeNav = document.querySelector('.nav-item.active')
    const enabledToggle = document.querySelector('[data-field="center.enabled"] input[type="checkbox"]')
    const serverUrl = document.querySelector('[data-field="center.serverUrl"] input[type="text"]')
    const displayName = document.querySelector('[data-field="center.displayName"] input[type="text"]')
    const account = document.querySelector('[data-field="center.account"] input[type="text"]')
    const password = document.querySelector('[data-field="center.password"] input[type="password"]')
    const buttons = Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || '').trim())
    const deviceLoginButton = buttons.indexOf('登录账户')
    const passwordLoginButton = buttons.indexOf('密码登录')
    const badges = Array.from(document.querySelectorAll('.badge')).map((b) => (b.textContent || '').trim())
    const statusField = count('[data-field="center.status"]')

    return {
      page: activeNav === null ? 'unknown' : (activeNav.textContent || '').trim(),
      center: {
        togglePresent: enabledToggle !== null,
        serverUrlPresent: serverUrl !== null,
        displayNamePresent: displayName !== null,
        accountPresent: account !== null,
        passwordWriteOnly: password !== null && password.getAttribute('type') === 'password',
        deviceLoginButtonPresent: deviceLoginButton !== -1,
        passwordLoginButtonPresent: passwordLoginButton !== -1,
        badgeNotLoggedIn: badges.indexOf('未登录') !== -1,
        badgeLoggedInAbsent: badges.indexOf('已登录') === -1,
        clientIdPlaceholder: (document.body.textContent || '').indexOf('尚未生成') !== -1,
        statusSectionPresent: statusField > 0,
      },
      pass:
        enabledToggle !== null &&
        serverUrl !== null &&
        displayName !== null &&
        account !== null &&
        password !== null &&
        deviceLoginButton !== -1 &&
        passwordLoginButton !== -1 &&
        badges.indexOf('未登录') !== -1 &&
        badges.indexOf('已登录') === -1 &&
        statusField > 0,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 「AI 模型」页新区组探针（BetaV2，spec §9）：「对话展示」与「生图模型」。
 *
 * - `general.chat.showThinking`（v8 新字段）：对话窗思考折叠块的唯一门控，开关必须常在；
 * - `imagegen.enabled` / `imagegen.active`（v8 新 provider 体系）：同样常在；
 * - 生图 provider 列表与 TTS / STT 同一套二选一：空 → `data-empty="imagegen.providers"`，
 *   非空 → 行容器（`imagegen.providers.<id>`，后面不再有点）。
 */
export const SETTINGS_LLM_FIELDS_SCRIPT = `(() => {
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const emptyStates = Array.from(document.querySelectorAll('[data-empty]')).map((el) =>
      el.getAttribute('data-empty'),
    )
    const imagegenEmpty = emptyStates.indexOf('imagegen.providers') !== -1
    const imagegenRows = Array.from(document.querySelectorAll('[data-field]')).filter((el) => {
      const value = el.getAttribute('data-field') || ''
      return value.indexOf('imagegen.providers.') === 0 && value.slice('imagegen.providers.'.length).indexOf('.') === -1
    }).length
    const activeNav = document.querySelector('.nav-item.active')
    return {
      page: activeNav === null ? 'unknown' : (activeNav.textContent || '').trim(),
      showThinkingFields: count('[data-field="general.chat.showThinking"]'),
      imagegenEnabledFields: count('[data-field="imagegen.enabled"]'),
      imagegenActiveFields: count('[data-field="imagegen.active"]'),
      imagegenEmpty,
      imagegenRows,
      emptyStates,
      pass:
        count('[data-field="general.chat.showThinking"]') > 0 &&
        count('[data-field="imagegen.enabled"]') > 0 &&
        count('[data-field="imagegen.active"]') > 0 &&
        (imagegenEmpty || imagegenRows > 0),
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 「模式」页探针 · 前半（BetaV2）：展开「课程表与课前提醒」分组。
 *
 * ClassroomSection 的四个分组里「课表」与「分类行为」**默认收起**（组件局部状态，非配置），
 * `modes.classroom.preClassOpenFolder`（含其空状态替身 `data-empty="modes.classroom.preClassReminder"`）
 * 只在分组展开后才进 DOM —— 不展开的话「课前提醒组二选一」断言两侧都是 0，探针必然假 FAIL。
 * 按分组标题定位（与 `SETTINGS_TTS_ADD_ACT` 的「用户可见文案优先」同一取舍，class 索引会随
 * 分组增删漂移）；点开的是组件局部状态，`settings-modes.png` 场景之间各自 reload，互不影响、
 * 无需还原。
 */
export const SETTINGS_MODES_EXPAND_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const heads = Array.from(document.querySelectorAll('.group-head'))
    const target = heads.find((head) =>
      (((head.querySelector('.section-title') || {}).textContent || '')).indexOf('课程表与课前提醒') !== -1,
    )
    if (target === undefined) {
      return { ok: false, reason: 'no 课程表与课前提醒 group head' }
    }
    target.click()
    // 等分组体渲染出课前提醒字段（或其「先添加节次」空状态），最多 2s
    let ready = false
    for (let attempt = 0; attempt < 10 && !ready; attempt += 1) {
      ready =
        document.querySelectorAll('[data-field="modes.classroom.preClassOpenFolder"]').length > 0 ||
        document.querySelectorAll('[data-empty="modes.classroom.preClassReminder"]').length > 0
      if (!ready) await wait(200)
    }
    return { ok: true, preClassVisible: ready }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`

/**
 * ClassIsland 联动（v3）新设置项的现场准备：把课表来源切成 classisland 并塞一节今天的课。
 *
 * 两个新项的门控是 `provider === 'classisland'`（提醒通道）与 `lessons.length > 0`
 * （提前分钟数），出厂配置（manual + 空课表）下它们**根本不渲染**，因此必须造现场。
 * 只能走 `settings:update` IPC（SettingsStore 启动即把 config.json 读进内存缓存，
 * 直接写文件对运行中的进程无效）。
 */
export const SETTINGS_CLASSISLAND_SEED_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const state = await window.aurora.settings.get()
    if (!state.ok) return { ok: false, reason: state.message }
    const weekday = new Date().getDay()
    const result = await window.aurora.settings.update({
      modes: {
        classroom: {
          ...state.value.modes.classroom,
          schedule: {
            ...state.value.modes.classroom.schedule,
            provider: 'classisland',
            lessons: [{ weekday, startTime: '08:00', endTime: '08:45', subject: '数学' }],
            classisland: {
              ...state.value.modes.classroom.schedule.classisland,
              source: 'http',
              endpoint: 'http://127.0.0.1:17945/schedule',
            },
          },
        },
      },
    })
    if (!result.ok) return { ok: false, reason: result.message }
    // 等渲染层 store 收到 settings:changed 后重算门控
    await wait(400)
    // 展开「课表与课前提醒」分组（提前分钟数与提醒通道都在这一组里）
    const heads = Array.from(document.querySelectorAll('.group-head'))
    const head = heads.find((item) =>
      (((item.querySelector('.section-title') || {}).textContent || '')).indexOf('课程表与课前提醒') !== -1,
    )
    if (head !== undefined) head.click()
    await wait(300)
    // 把两个新字段一起滚进视野：设置窗只有 720 高，ClassRoom 配置在折叠区下方，
    // 不滚动的话截图拍不到它们（探针能数到，但视觉验收看不到证据）。
    // 逐个 scrollIntoView 只会让最后一个可见，因此按两者中点定位一次。
    const anchors = [
      document.querySelector('[data-field="modes.classroom.preClassLeadMinutes"]'),
      document.querySelector('[data-field="settings.classisland-notify-test"]'),
    ].filter((el) => el !== null)
    if (anchors.length > 0) {
      const rects = anchors.map((el) => el.getBoundingClientRect())
      const middle = (Math.min(...rects.map((r) => r.top)) + Math.max(...rects.map((r) => r.bottom))) / 2
      window.scrollBy({ top: middle - window.innerHeight / 2 })
    }
    await wait(250)
    return { ok: true, anchors: anchors.length }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`

/**
 * ClassIsland 联动（v3）设置项探针：提前分钟数 + 提醒通道（状态回显 + 发送测试按钮）两处都在。
 *
 * check 收尾把课表来源还原成 manual、课表清空 —— 否则后续场景会带着「classisland 端点」
 * 继续跑（那些场景断言的是出厂门控）。
 */
export const SETTINGS_CLASSISLAND_FIELDS_SCRIPT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const lead = count('[data-field="modes.classroom.preClassLeadMinutes"]')
    const notify = count('[data-field="settings.classisland-notify-test"]')
    const notifyState = count('[data-field="settings.classisland-notify-state"]')
    const notifyButton = count('[data-field="settings.classisland-notify-test-button"]')
    const result = {
      leadMinutes: lead,
      notifyGroup: notify,
      notifyState,
      notifyButton,
      pass: lead === 1 && notify === 1 && notifyState === 1 && notifyButton === 1,
    }
    // 收尾还原：provider 回 manual、清空课表（端点留着无妨，门控看的是 provider）
    const state = await window.aurora.settings.get()
    if (state.ok) {
      await window.aurora.settings.update({
        modes: {
          classroom: {
            ...state.value.modes.classroom,
            schedule: {
              ...state.value.modes.classroom.schedule,
              provider: 'manual',
              lessons: [],
            },
          },
        },
      })
    }
    await wait(200)
    result.restored = count('[data-field="settings.classisland-notify-test"]') === 0
    result.pass = result.pass === true && result.restored === true
    return result
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 「模式」页（ClassRoom 生效态）结构探针（BetaV2）：模式卡下方只渲染当前模式的配置区。
 *
 * 前半由 `SETTINGS_MODES_EXPAND_ACT` 展开「课表」分组，否则课前提醒字段不在 DOM。
 * 三个断言：
 * ① ClassRoom 生效 → classroom 区组在（`modes.classroom.watchDir` 恰好一行，「感知文件夹」
 *    分组默认展开，可直接数）；
 * ② **work 区组整块不在**（WorkSection 只在当前模式为 work 时渲染，BetaV2 起它有真字段，
 *    数到 `modes.work.*` 说明互斥渲染被破坏）；
 * ③ 课前提醒组按课表节次二选一：默认配置 `lessons: []` → `preClassOpenFolder` 不渲染
 *    （ScheduleEditor 门控），取而代之的是 `data-empty="modes.classroom.preClassReminder"`；
 *    用户配了节次则反过来 —— 探针对两种形态都接受，但必须出现其一。
 */
export const SETTINGS_MODES_CLASSROOM_SCRIPT = `(() => {
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const emptyStates = Array.from(document.querySelectorAll('[data-empty]')).map((el) =>
      el.getAttribute('data-empty'),
    )
    const classroomFields = count('[data-field^="modes.classroom"]')
    const watchDir = count('[data-field="modes.classroom.watchDir"]')
    const workFields = count('[data-field^="modes.work"]')
    const preClassOpen = count('[data-field="modes.classroom.preClassOpenFolder"]')
    const preClassEmpty = emptyStates.indexOf('modes.classroom.preClassReminder') !== -1
    const automationsToggle = count('[data-field="automations.enabled"]')
    const activeMode = document.querySelector('.cards .card.active .card-head strong')
    const activeNav = document.querySelector('.nav-item.active')
    return {
      page: activeNav === null ? 'unknown' : (activeNav.textContent || '').trim(),
      activeMode: activeMode === null ? null : (activeMode.textContent || '').trim(),
      classroomFields,
      watchDir,
      workFields,
      preClassOpen,
      preClassEmpty,
      automationsToggle,
      emptyStates,
      pass:
        classroomFields > 0 &&
        watchDir === 1 &&
        workFields === 0 &&
        automationsToggle === 1 &&
        (preClassOpen > 0 || preClassEmpty),
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 设置页旧深链别名探针（BetaV2）：`?page=tts` 必须经渲染层 `LEGACY_PAGE_ALIASES`
 * 落到合并后的「语音」页 —— TTS 与 STT 两个区组的常显开关都要在。
 * 深链清单（`SETTINGS_PAGE_IDS`）只保留新 id，旧链接的兼容行为由本场景单独钉住；
 * `skills|mcp → agent` 走同一张映射表，机制验证一条即可代表。
 */
export const SETTINGS_LEGACY_ALIAS_SCRIPT = `(() => {
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const title = (((document.querySelector('.page-title') || {}).textContent || '')).trim()
    return {
      pageTitle: title,
      ttsToggle: count('[data-field="tts.enabled"]'),
      sttToggle: count('[data-field="stt.enabled"]'),
      pass: count('[data-field="tts.enabled"]') > 0 && count('[data-field="stt.enabled"]') > 0,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/** 把模式切到 Work：切换后 Work 区组应出现、classroom 区组应消失（见 `SETTINGS_WORK_GATING_SCRIPT`） */
export const SETTINGS_SWITCH_TO_WORK_SCRIPT = `(() => {
  try {
    const cards = Array.from(document.querySelectorAll('.cards .card'))
    const target = cards.find((card) => {
      const head = (((card.querySelector('.card-head strong') || {}).textContent || '')).trim()
      // BetaV2 的 displayName 是「工作模式」（旧版是 Work Mode）：两种写法都认，
      // 只认英文会在改名后静默找不到卡片（探针空转比失败更糟）
      return head.indexOf('工作模式') !== -1 || head.toLowerCase().indexOf('work') !== -1
    })
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
 * 切到 Work 模式后的门控探针（BetaV2 重写；原 `SETTINGS_CLASSROOM_GATING_SCRIPT`）。
 *
 * BetaV2 起 Work 模式**实装**（`WorkSection`）：切过去之后不再是「暂无可配置项」空状态卡，
 * 而是 `modes.work.workspaceDir` 字段出现、classroom 区组整块消失。三个断言：
 * ① classroom 字段数必须为 0；② `modes.work.workspaceDir` 恰好一行；
 * ③ 任何 `data-empty^="modes."` 的空状态卡（占位模式的「暂无可配置项」）都不该有 ——
 *    Work 不再是占位实现，出现空状态说明互斥渲染或模式实装被破坏。
 */
export const SETTINGS_WORK_GATING_SCRIPT = `(() => {
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const classroomFields = count('[data-field^="modes.classroom"]')
    const workFields = count('[data-field^="modes.work"]')
    const workspaceDir = count('[data-field="modes.work.workspaceDir"]')
    const empty = document.querySelector('[data-empty^="modes."]')
    const active = document.querySelector('.cards .card.active .card-head strong')
    return {
      classroomFields,
      workFields,
      workspaceDir,
      modesEmptyState: empty === null ? null : empty.getAttribute('data-empty'),
      activeMode: active === null ? null : (active.textContent || '').trim(),
      pass: classroomFields === 0 && workFields > 0 && workspaceDir === 1 && empty === null,
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
 * 等 `settings:changed` 推送把卡片画出来，再点开**生效 provider 那一行**的「编辑」与卡内 `.more`
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
    // 列表态 querySelector('.more') 只会拿到 null。所以先按真实用户路径点开「编辑」，
    // 再点卡内的 .more。行上刻意没有折叠箭头，就是为了让「展开高级参数」只有一个入口、
    // 一次仍只有一张卡。
    // ⚠️ 必须点**当前生效 provider 那一行**的编辑按钮，不能取第一个 data-action="edit-provider"：
    // 全量截图里 onboarding 会先种一个 local provider，行首未必是 active 的那个 ——
    // 取错行会打开别人的卡，断言读到的是别人的 reasoningEffort（实测全量跑必 FAIL、单跑 settings 反而 PASS）。
    // 注意：本段在模板字符串里，注释不能出现反引号。
    const row = document.querySelector('[data-field="llm.providers.' + active + '"]')
    if (row === null) return { ok: false, reason: 'no row for active provider ' + active }
    const editButton = row.querySelector('[data-action="edit-provider"]')
    if (editButton === null) return { ok: false, reason: 'no edit-provider button' }
    editButton.click()
    await new Promise((resolve) => setTimeout(resolve, 500))

    const more = row.querySelector('.more')
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
 *
 * ⚠️ DOM 读数**按 ACT 记录的生效 provider 限定在那一行内部**（`[data-field="llm.providers.<active>"]`）：
 * 全量截图里 onboarding 会先种一个 local provider，行首未必是 active 那个，
 * 全局取第一个 `.reasoningEffort` 会读到别人的卡 → 假 FAIL（已在全量捕获里复现并修掉）。
 */
export const SETTINGS_LLM_EFFORT_CHECK = `(async () => {
  try {
    const probe = window.__auroraEffortSettingsProbe
    // 与 ACT 同一套定位：编辑卡（含 .reasoningEffort / .temperature）渲染在
    // [data-field="llm.providers.<id>"] 这一行**内部**，所以按生效 provider 限定范围。
    // 全局 querySelectorAll 会数到别人的卡：全量截图里 onboarding 先种了 local provider，
    // 行首未必是 active 那个 —— 那时会读到别人的 auto，探针假 FAIL（真实缺陷，已实测复现）。
    const scope =
      probe === undefined
        ? document
        : document.querySelector('[data-field="llm.providers.' + probe.active + '"]')
    const effortFields = scope === null ? [] : scope.querySelectorAll('[data-field$=".reasoningEffort"]')
    const temperatureFields = scope === null ? [] : scope.querySelectorAll('[data-field$=".temperature"]')
    const first = effortFields[0]
    const select = first === undefined ? null : first.querySelector('select')
    const value = select === null ? null : select.value
    const domOk = effortFields.length > 0 && temperatureFields.length > 0 && value === 'high'

    // DOM 断言必须先读（写回会触发 settings:changed 重新渲染，之后就读不到 high 了）
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
      active: probe === undefined ? null : probe.active,
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
 * 双主题探针（step-06，docs/07 §5.3）。
 *
 * 深/浅两档各跑一遍完整截图时，每窗多一张 `theme-*.png`，用同一条探针回答三件事：
 * ① 渲染层真的处在目标档位（`matchMedia` + 文档根 `color-scheme`）；
 * ② 语义令牌与正文背景是目标档位（`--bg-base` 等于该档基座、非透明窗的 `body` 背景不透明且同色）；
 * ③ 正文与基座的对比度 ≥ 4.5:1、且明暗极性正确（浅色不许白字、深色不许黑字）。
 *
 * 原生窗口底色渲染层读不到，所以那半条由 `themeNativeCheck()` 在主进程侧断言 —— 它才是
 * 「浅色下先闪一层深色底」的真正防线。
 */
export type ThemeName = 'dark' | 'light'

/** 与 `window-manager.ts` 的 `DARK_BACKGROUND` / `LIGHT_BACKGROUND` 及 theme.css 基座一致 */
const THEME_BASE_COLORS: Record<ThemeName, string> = {
  dark: '#000000',
  light: '#f5f5f7',
}

/** 目标档位对应的基座色（`null` 之外的调用方都能拿到确定值）。 */
export function themeBaseColor(theme: ThemeName): string {
  return THEME_BASE_COLORS[theme]
}

/** 当前运行档位：`bootstrap()` 已按 `AURORA_CAPTURE_THEME` 设好 `themeSource`，这里读的就是真值。 */
export function activeTheme(): ThemeName {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/**
 * 生成主题探针脚本。
 *
 * 写成工厂而不是常量：期望档位要注入进去，探针才可能**失败**（否则它只会复述"当前是当前"）。
 * 颜色归一化走「挂一个临时元素读 computed style」，比手写 hex/rgba 解析稳：令牌值可能是
 * `var(--neutral-850)`、hex 或 `rgba()`，交给 Chromium 统一输出 `rgb()/rgba()`。
 * 注意本段在模板字符串里，注释里不能出现反引号。
 */
export function themeProbeScript(options: { theme: ThemeName; transparent: boolean }): string {
  const expected = {
    theme: options.theme,
    base: THEME_BASE_COLORS[options.theme],
    transparent: options.transparent,
  }
  return `(() => {
  const normalizer = document.createElement('div')
  try {
    const expected = ${JSON.stringify(expected)}
    const root = document.documentElement
    const body = document.body
    const rootStyle = getComputedStyle(root)
    const bodyStyle = getComputedStyle(body)

    normalizer.style.display = 'none'
    document.body.appendChild(normalizer)
    const toRgba = (value) => {
      normalizer.style.color = ''
      normalizer.style.color = value
      const computed = getComputedStyle(normalizer).color
      const match = computed.match(/rgba?\\(([^)]+)\\)/)
      if (match === null) return null
      const parts = match[1].split(/[,\\s]+/).filter((item) => item !== '')
      if (parts.length < 3) return null
      return {
        r: Number(parts[0]),
        g: Number(parts[1]),
        b: Number(parts[2]),
        a: parts.length > 3 ? Number(parts[3]) : 1,
        css: computed,
      }
    }
    const sameRgb = (a, b) => a !== null && b !== null && a.r === b.r && a.g === b.g && a.b === b.b
    const channel = (value) => {
      const v = value / 255
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
    }
    const luminance = (color) => 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
    const contrast = (a, b) => {
      const la = luminance(a)
      const lb = luminance(b)
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
    }

    const mediaLight = window.matchMedia('(prefers-color-scheme: light)').matches
    const mediaDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const colorScheme = (rootStyle.colorScheme || '').trim()
    const baseToken = toRgba(rootStyle.getPropertyValue('--bg-base').trim())
    const textToken = toRgba(rootStyle.getPropertyValue('--text-primary').trim())
    const expectedBase = toRgba(expected.base)
    const bodyBackground = toRgba(bodyStyle.backgroundColor)
    const bodyColor = toRgba(bodyStyle.color)

    const themeOk = expected.theme === 'dark' ? mediaDark && !mediaLight : mediaLight && !mediaDark
    const schemeOk = colorScheme === expected.theme
    const baseOk = sameRgb(baseToken, expectedBase)
    // 提示条必须整窗透明；其余窗口的正文背景必须不透明且与原生底色同色，否则会闪底
    const bodyOk = expected.transparent
      ? bodyBackground !== null && bodyBackground.a === 0
      : bodyBackground !== null && bodyBackground.a === 1 && sameRgb(bodyBackground, expectedBase)
    const ratio =
      textToken === null || expectedBase === null
        ? null
        : Math.round(contrast(textToken, expectedBase) * 100) / 100
    const polarityOk =
      textToken !== null &&
      expectedBase !== null &&
      (expected.theme === 'dark'
        ? luminance(textToken) > luminance(expectedBase)
        : luminance(textToken) < luminance(expectedBase))
    const textOk = ratio !== null && ratio >= 4.5 && polarityOk

    const reasons = []
    if (!themeOk) reasons.push('matchMedia 不是 ' + expected.theme + '（light=' + mediaLight + ' dark=' + mediaDark + '）')
    if (!schemeOk) reasons.push('color-scheme=' + colorScheme + '，期望 ' + expected.theme)
    if (!baseOk) reasons.push('--bg-base=' + (baseToken === null ? 'unparsed' : baseToken.css) + '，期望 ' + expected.base)
    if (!bodyOk) reasons.push('正文背景=' + (bodyBackground === null ? 'unparsed' : bodyBackground.css) + '（transparent=' + expected.transparent + '）')
    if (!textOk) reasons.push('正文对比度=' + ratio + '，极性=' + polarityOk)

    return {
      pass: themeOk && schemeOk && baseOk && bodyOk && textOk,
      expectedTheme: expected.theme,
      transparent: expected.transparent,
      mediaLight,
      mediaDark,
      colorScheme,
      baseToken: baseToken === null ? null : baseToken.css,
      textToken: textToken === null ? null : textToken.css,
      bodyBackground: bodyBackground === null ? null : bodyBackground.css,
      bodyColor: bodyColor === null ? null : bodyColor.css,
      expectedBase: expected.base,
      contrastRatio: ratio,
      polarityOk,
      checks: { themeOk, schemeOk, baseOk, bodyOk, textOk },
      reason: reasons.join('；') || null,
    }
  } catch (error) {
    return { pass: false, reason: '主题探针异常：' + String(error) }
  } finally {
    normalizer.remove()
  }
})()`
}

/**
 * 主进程侧断言：非透明窗口的**真实原生底色**必须是目标档位。
 *
 * 提示条传 `transparent: true` 时 Electron 读不到底色（`getBackgroundColor()` 对
 * `#00000000` 无意义），所以那种窗口不挂这条断言 —— 它的透明由渲染层探针的 `bodyOk` 管。
 */
export function themeNativeCheck(
  manager: WindowManager,
  name: WindowName,
  theme: ThemeName,
): () => { pass: boolean } & Record<string, unknown> {
  const expected = THEME_BASE_COLORS[theme]
  return () => {
    const observed = manager.getBackgroundColor(name)
    return {
      pass:
        observed !== undefined && observed.trim().toLowerCase() === expected.trim().toLowerCase(),
      window: name,
      expected,
      observed: observed ?? null,
    }
  }
}

/**
 * 引导的五张图复用同一个窗口实例：各 target 都不带 query，也不调用 reload，
 * 否则 Vue 的 stepIndex 会在每张图之间复位。每段只通过页面现有按钮前进。
 * 等待进度与 pane 标题同时出现，避免 Vue 的 out-in 过渡期拍到上一段或空白。
 */
const ONBOARDING_STAGES = [
  { label: '欢迎', title: '欢迎使用 Aurora', cta: '下一步' },
  { label: 'AI 模型', title: '配置 AI 模型', cta: '下一步' },
  { label: '选择模式', title: '选择使用模式', cta: '下一步' },
  { label: '模式设置', title: 'ClassRoom Mode 设置', cta: '保存并继续' },
  { label: '完成', title: '一切就绪', cta: '开始使用' },
] as const

function onboardingWaitScript(index: number, action?: 'next' | 'skip' | 'model'): string {
  const previous = index > 0 ? ONBOARDING_STAGES[index - 1] : undefined
  return `(async () => {
    const stages = ${JSON.stringify(ONBOARDING_STAGES)}
    const expected = stages[${index}]
    const previous = ${previous === undefined ? 'null' : JSON.stringify(previous)}
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const state = () => ({
      label: (document.querySelector('.progress-text')?.textContent || '').trim(),
      title: (document.querySelector('.pane .pane-title')?.textContent || '').trim(),
      active: Array.from(document.querySelectorAll('.progress-item')).findIndex((el) => el.classList.contains('active')),
    })
    async function ready(stage, number) {
      for (let attempt = 0; attempt < 160; attempt += 1) {
        const found = state()
        if (found.label === stage.label && found.active === number && found.title.includes(stage.title)) return
        await pause(50)
      }
      const feedback = (document.querySelector('.foot-note .toast')?.textContent || '').trim()
      throw new Error('引导阶段未就绪：预期 ' + stage.label + ' / ' + stage.title + '，实际 ' + JSON.stringify(state()) + (feedback ? '；页脚提示：' + feedback : ''))
    }
    function button(label) {
      const hit = Array.from(document.querySelectorAll('.foot button')).find((el) =>
        (el.textContent || '').trim() === label)
      if (!hit) throw new Error('引导页脚缺少按钮「' + label + '」：' +
        Array.from(document.querySelectorAll('.foot button')).map((el) => (el.textContent || '').trim()).join('、'))
      if (hit.disabled) throw new Error('引导按钮「' + label + '」已禁用')
      return hit
    }
    ${action === undefined ? '' : `await ready(previous, ${index - 1})`}
    ${
      action === 'model'
        ? `
    const preset = Array.from(document.querySelectorAll('.pane button')).find((el) =>
      (el.textContent || '').includes('本地 / 自定义'))
    if (!preset) throw new Error('AI 模型页缺少本地 / 自定义预设')
    preset.click()
    await pause(50)
    const key = document.querySelector('input[placeholder="sk-..."]')
    if (!key) throw new Error('AI 模型页缺少 API Key 输入框')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(key, 'capture-local-placeholder')
    key.dispatchEvent(new Event('input', { bubbles: true }))
    await pause(50)
    button('下一步').click()
    `
        : action === 'skip'
          ? `button('稍后设置').click()`
          : action === 'next'
            ? `button('下一步').click()`
            : ''
    }
    await ready(expected, ${index})
    // 进场动画（.anim-rise 的 aurora-rise-in）在窗口不产生帧时会**停在起始帧**（opacity: 0）：
    // 采集环境里窗口可能被遮挡 / 未被合成，此时截图会拍到「布局好了但整块透明」的 pane，
    // 后续 check 也会因为 opacity=0 判 FAIL（实测出现过「期望与实际是同一串标题却 FAIL」的偶发失败）。
    // 这里把本步 pane 的进场动画显式推到终态 —— 不改变任何样式定义，只是不等那一帧。
    for (const el of document.querySelectorAll('.pane .anim-rise')) {
      for (const animation of el.getAnimations()) {
        try {
          animation.finish()
        } catch {
          /* 无限循环的动画不能 finish：忽略 */
        }
      }
    }
    await pause(50)
    return { stage: expected.label, action: ${JSON.stringify(action ?? 'ready')} }
  })()`
}

function onboardingCheckScript(index: number): string {
  return `(async () => {
    try {
      const expected = ${JSON.stringify(ONBOARDING_STAGES[index])}
      const visible = (el) => {
        if (!el) return false
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 &&
          rect.right <= innerWidth && rect.bottom <= innerHeight &&
          style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
      }
      // ⚠️ 这里必须**先等到标题真正可见再断言**，不能进函数就采样：
      // act 返回时 pane 的 .anim-rise 进场动画可能还没结束（opacity / transform 中途），
      // 那时标题的几何与透明度都不满足下面的条件 —— 实测出现过「期望与实际都是同一串标题、
      // 却判 FAIL」的偶发失败（一轮 0 FAIL、下一轮红一条）。断言本身不放宽：
      // 1.5s 内始终不可见照样 FAIL，并报出真实几何（rect / 视口 / 滚动位置 / opacity）。
      let waitedMs = 0
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (visible(document.querySelector('.pane .pane-title'))) break
        await new Promise((resolve) => setTimeout(resolve, 50))
        waitedMs += 50
      }
      // act 已经把进场动画推到终态；这里再兜一次（check 可能被单独调试、或窗口恰好在这一刻失焦），
      // 仍然只处理「动画没跑完」这一种情况 —— 真被样式藏起来的元素 finish() 也救不回来，照样 FAIL。
      if (!visible(document.querySelector('.pane .pane-title'))) {
        for (const el of document.querySelectorAll('.pane .anim-rise')) {
          for (const animation of el.getAnimations()) {
            try {
              animation.finish()
            } catch {
              /* 无限循环的动画不能 finish：忽略 */
            }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      // 等完之后**重新取一次**元素：Vue 可能在这一小段时间里换掉了 pane 节点，
      // 沿用等待前的引用会读到已卸载元素（几何为 0 → 又会是一条看不懂的 FAIL）
      const titleEl = document.querySelector('.pane .pane-title')
      const label = (document.querySelector('.progress-text')?.textContent || '').trim()
      const active = Array.from(document.querySelectorAll('.progress-item')).findIndex((el) => el.classList.contains('active'))
      const title = (titleEl?.textContent || '').trim()
      const cta = Array.from(document.querySelectorAll('.foot button')).find((el) =>
        (el.textContent || '').trim() === expected.cta)
      const rect = cta?.getBoundingClientRect()
      const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null
      const clickable = !!cta && !cta.disabled && !!hit && (hit === cta || cta.contains(hit))
      const reasons = []
      if (label !== expected.label || active !== ${index}) reasons.push('阶段标识不符：期望 ' + expected.label + ' / ' + ${index} + '，实际 ' + label + ' / ' + active)
      if (!title.includes(expected.title) || !visible(titleEl)) {
        // 报出真实几何：失败原因里只写「期望 X，实际 X」时两条字符串长得一模一样，根本没法排查
        // （真凶往往是被滚动容器推出可视区、透明度恰为 0、或元素还没布局出尺寸）
        const box = titleEl === null ? null : titleEl.getBoundingClientRect()
        const body = document.querySelector('.body')
        reasons.push(
          '标题不可见或不符：期望 ' + expected.title + '，实际 ' + title +
            '；几何 ' + JSON.stringify(box === null ? null : {
              top: Math.round(box.top), bottom: Math.round(box.bottom),
              left: Math.round(box.left), right: Math.round(box.right),
              width: Math.round(box.width), height: Math.round(box.height),
            }) +
            '；视口 ' + innerWidth + 'x' + innerHeight +
            '；body.scrollTop=' + (body === null ? 'n/a' : String(body.scrollTop)) +
            '；opacity=' + (titleEl === null ? 'n/a' : getComputedStyle(titleEl).opacity),
        )
      }
      if (!cta) reasons.push('缺少页脚主 CTA「' + expected.cta + '」')
      else {
        if (!visible(cta)) reasons.push('主 CTA「' + expected.cta + '」超出窗口或不可见')
        if (!clickable) reasons.push('主 CTA「' + expected.cta + '」禁用或中心无法命中')
      }
      return { pass: reasons.length === 0, stage: label, active, title, cta: (cta?.textContent || '').trim(), visible: visible(cta), clickable, waitedMs, reason: reasons.join('；') || null }
    } catch (error) {
      return { pass: false, reason: '引导阶段检查异常：' + String(error) }
    }
  })()`
}

/**
 * 默认截图清单：四个窗口 + 提示条两态 + 设置页六页深链（含各页门控探针）+ 若干 DOM 断言场景
 * （门控计数 / 左栏与右栏 / 思考块 / 快速会话 / 对话自动滚底 / 收起即消失 / 思考等级 /
 * 模型列表 / tts seed / 窗口拖动区 / 模式页门控与真实写盘，见下面各条的 `check`）
 * + 每窗一张双主题场景（`theme-*.png`，深/浅各跑一遍整批）。
 * BetaV2（spec §11）：设置页 8 → 6 页；旧深链 `?page=tts` 的别名映射由
 * `settings-legacy-tts-alias.png` 单独钉住；chat 主界面（三栏）新增左栏 / 右栏 /
 * 思考块 / 快速会话四个场景，麦克风门控（未配置时按钮不存在）并入 `chat-sidebar` 场景。
 * `AURORA_CAPTURE_WINDOWS` 可以只截其中一部分（逗号分隔）。
 *
 * ⚠️ 交互窗场景的**顺序约束**：凡是要在交互窗里操作 DOM 的场景，都必须排在 `chat-collapse.png` **之前**——
 * 收起会把窗口隐藏，之后再 `capturePage()` 只会卡死。因此顺序固定为
 * `theme-chat`（step 6 双主题）→ `chat-sidebar`（BetaV2 左栏结构 + 麦克风门控）
 * → `chat-right-panel-toggle` → `chat-right-panel-work`（两者自恢复，不动会话）
 * → `chat-thinking-block`（reload 后展开 seed 的思考块）→ `chat-quick-session`（切到 quick 会话）
 * → `chat-thinking-level` → `chat-model-picker`（step 5 加）
 * → `chat-composer-slash` → `chat-composer-permission` → `chat-composer-flyouts`（输入区三浮层的
 * 互斥与几何）→ `chat-tool-card-open`（reload 回 main 后展开工具卡）→ `chat-archive`（左栏归档分组，
 * 自还原）→ `chat-tts`（step 6 加，自带 reload 回到 main 会话）→ `chat-subagent-page`
 * → `chat-classisland-status` → `chat-drag` → `chat-collapse` → `chat.png`。
 * 三个新场景都排在 chat-collapse 之前，且都排在不改配置 / 不用模型的那一段里；
 * `chat-archive` 会改左栏状态（归档再撤销），它自己收尾还原。
 *
 * 双主题（step 6）另在 edge-bar / chat / settings / onboarding 各加一张 `theme-*.png`：
 * 期望档位由 `activeTheme()` 读取（`bootstrap()` 已按 `AURORA_CAPTURE_THEME` 设好 `themeSource`）。
 */
/**
 * 为 chat 窗口的多个场景准备「可朗读 / 可展开思考」的历史（主进程侧，在跑计划之前调用一次）。
 *
 * 为什么必须种数据（而不是让探针去点出来）：
 * 隔离 userData 下 `chat:history` 必然是空的，而 `chat-tts` 需要**一条助手消息**
 * 才会渲染「朗读」按钮、`chat-thinking-block` 需要一条带 `reasoning` 的助手消息
 * 才会渲染思考折叠块；离线环境 `chat:send` 只会回 error 事件（没有可用 LLM），
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

  // 1) 会话历史：一条助手消息即可（`MessageList` 只对 assistant 渲染朗读按钮与思考块）
  //    内容里刻意带一个**裸 URL** 与行内代码：`markdown.ts` 只把裸 URL 转成 `.md-link`
  //    （不认 `[文字](url)` 语法），而链接色必须用可读的 `--accent-text`
  //    （浅色档直接写品牌蓝只有 3.14:1）—— 这样两处样式都能在 `theme-chat.png` /
  //    `chat.png` 里被逐张目视核对，否则它们在两份报告里没有任何可视证据。
  // 2) `reasoning`（BetaV2）：`StoredMessage` / `ChatMessageDto` 的可选字段，经
  //    `rendererHistory` 透传后由 MessageList 渲染成思考折叠块。正文里带探针标记
  //    `capture-reasoning-probe`，`CHAT_THINKING_BLOCK_CHECK` 靠它确认「展开后看到的就是
  //    seed 的思考全文」而不是别的节点文本。
  const session = {
    version: 1,
    sessionId,
    updatedAt: now,
    messages: [
      {
        id: 'capture-tts-a1',
        role: 'assistant',
        content:
          '这是截图探针种下的一条助手回复，用来验证「朗读」按钮的渲染与状态复位。' +
          '参考 https://example.com/aurora 与 `pnpm typecheck` 的说明。',
        reasoning:
          'capture-reasoning-probe：这是探针种下的思考过程全文。' +
          '历史水合出的思考块默认收起为「已深度思考」摘要行，点开应能看到本段全文。',
        // 2026-09：一条 todo_write（3 项清单）+ 一条 task（子代理，已完成）——
        // MessageList 的结构化任务清单卡与子代理卡由此获得截图与探针证据
        // （CHAT_SIDEBAR_SCRIPT 断言 chat.todo-card 恰好 3 行 + chat.task-card 在）。
        toolCalls: [
          {
            id: 'capture-todo-1',
            name: 'todo_write',
            input: {
              todos: [
                { content: '整理本周课程资料', status: 'completed' },
                { content: '汇总系统状态报告', status: 'in_progress' },
                { content: '检查感知文件夹新文件', status: 'pending' },
              ],
            },
            state: 'success',
            outputSummary: '已更新任务清单（3 项）',
          },
          {
            id: 'capture-task-1',
            name: 'task',
            input: {
              description: '汇总系统状态',
              prompt: '读取当前的系统状态（时间 / 电量 / 网络 / 前台应用），汇总成一段话。',
            },
            state: 'success',
            outputSummary: '子代理：汇总系统状态',
            // 子代理运行快照（docs/06 §19）：随工具卡持久化，重启后仍能回看。
            // 截图与探针证据：工具卡展开体里的「运行轨迹」，以及「子代理」独立页面。
            subagent: {
              taskId: 'sub-capture-1',
              callId: 'capture-task-1',
              description: '汇总系统状态',
              prompt: '读取当前的系统状态（时间 / 电量 / 网络 / 前台应用），汇总成一段话。',
              status: 'success',
              startedAt: Date.parse(now),
              endedAt: Date.parse(now) + 4200,
              toolCalls: 2,
              steps: [
                { id: 's1', kind: 'text', text: '先看系统状态采集项，再各取一次。' },
                {
                  id: 'capture-tool-1',
                  kind: 'tool',
                  name: 'list_dir',
                  state: 'success',
                  summary: '已列出 12 个条目',
                },
                {
                  id: 'capture-tool-2',
                  kind: 'tool',
                  name: 'read_file',
                  state: 'success',
                  summary: '已读取 1.2 KB',
                },
              ],
              report:
                '当前时间 09:20，已接通电源（82%，非充电）；网络在线（Wi-Fi）；' +
                '前台应用为 Code.exe。整体状态正常，未发现需要处理的事项。',
            },
          },
        ],
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

  // 快速会话（BetaV2）：提示条「最近消息」与主界面左栏「快速对话」都读 `quick.json`。
  // 不种的话 edge-bar-expanded.png 的最近消息卡是一片大空白（视觉验收判过 fail）。
  const quick = {
    version: 1,
    sessionId: 'quick',
    updatedAt: now,
    messages: [
      {
        id: 'capture-quick-u1',
        role: 'user',
        content: '帮我看看现在系统状态怎么样？',
        createdAt: now,
      },
      {
        id: 'capture-quick-a1',
        role: 'assistant',
        content: '系统一切正常：电量 99%（充电中），网络已连接。有需要随时叫我。',
        createdAt: now,
      },
    ],
  }
  await writeFile(join(userData, 'sessions', 'quick.json'), JSON.stringify(quick, null, 2), 'utf8')

  // 3) 归档分组（2026-09 归档 UI，docs/07 §2.3）：再种一条**已归档**会话
  //    （`meta.archived = true`），让左栏「已归档 · N」分组在隔离 userData 里就有内容 ——
  //    `chat-archive.png` 场景点开分组要看到它，且它**不得**出现在主列表容器
  //    `chat.session-list` 里（渲染层按 `archived === true` 分两份，storage 层不过滤）。
  //    标题取首条用户消息前 24 字（`SessionStore.titleFor`）：这里把标记写在开头，
  //    且整段文本恰好 23 字（不触发省略号），探针按唯一的子串 `archive-seed` 定位它。
  //    时间戳比 main 早两天：主列表里 main 仍排第一，归档分组自身的顺序不受影响。
  const archivedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
  const archived = {
    version: 2,
    sessionId: 'chat-seed-archived',
    updatedAt: archivedAt,
    messages: [
      {
        id: 'capture-archived-u1',
        role: 'user',
        content: 'archive-seed 探针种下的已归档会话',
        createdAt: archivedAt,
      },
      {
        id: 'capture-archived-a1',
        role: 'assistant',
        content: '这条会话已被归档，用来验证左栏归档分组的分组、计数与可逆往返。',
        createdAt: archivedAt,
      },
    ],
    meta: { archived: true, archivedAt },
  }
  await writeFile(
    join(userData, 'sessions', 'chat-seed-archived.json'),
    JSON.stringify(archived, null, 2),
    'utf8',
  )
}

/**
 * 场景可用的**配置层钩子**：`capture.ts` 本身不碰 `SettingsStore`（它只负责截图与 DOM 探针），
 * 需要改配置的场景由装配层（`index.ts` 的 `runCapture`）把动作注进来。
 *
 * 目前只有"切换当前项目"一项：综合概览卡要同时展示项目卡 / 快照卡 / 任务卡，
 * 而项目卡只在**配置了当前项目**时渲染。
 */
export interface CapturePlanHooks {
  /** 把当前项目切到给定条目；传 `undefined` 表示还原成"无项目" */
  setProject?(project: { id: string; name: string; root: string } | undefined): void
}

export function defaultCapturePlan(
  manager: WindowManager,
  userData: string,
  hooks: CapturePlanHooks = {},
): CaptureTarget[] {
  const theme = activeTheme()
  const plan: CaptureTarget[] = [
    { name: 'edge-bar', file: 'edge-bar.png' },
    // 双主题（step-06）：每窗一张主题场景，断言令牌档位、正文背景与原生底色一致。
    // 提示条整窗透明，所以只断言渲染层（`body` 背景 alpha 必须为 0）+ 不挂原生底色断言。
    {
      name: 'edge-bar',
      file: 'theme-edge-bar.png',
      check: themeProbeScript({ theme, transparent: true }),
    },
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
      file: 'theme-chat.png',
      check: themeProbeScript({ theme, transparent: false }),
      nativeCheck: themeNativeCheck(manager, 'chat', theme),
    },
    // 左栏结构 + 出厂门控现场（BetaV2）：quick-item / session-list / new-session 锚点、
    // 右栏默认展开且 classroom 卡在、麦克风按钮**不存在**（stt 未配置时连按钮都不渲染）。
    // 必须排在一会改配置/改会话的场景之前，保证读到的是隔离 userData 的默认状态。
    {
      name: 'chat',
      file: 'chat-sidebar.png',
      check: CHAT_SIDEBAR_SCRIPT,
    },
    // 右栏开关（BetaV2）：act 内点两次（收起 → 展开）自恢复，截图回到三栏默认布局，
    // 收起态由 check 依据 act 的记录判定。
    {
      name: 'chat',
      file: 'chat-right-panel-toggle.png',
      act: CHAT_RIGHT_PANEL_TOGGLE_ACT,
      check: CHAT_RIGHT_PANEL_TOGGLE_CHECK,
    },
    // 右栏模式感知（BetaV2）：mode.set('work') 后右栏整体换成工作目录卡、课堂卡消失；
    // check 收尾切回 classroom，不影响后续场景。
    {
      name: 'chat',
      file: 'chat-right-panel-work.png',
      act: CHAT_RIGHT_PANEL_WORK_ACT,
      check: CHAT_RIGHT_PANEL_WORK_CHECK,
    },
    // 右栏「当前项目」卡（v13，docs/06 §5.1；docs/07 §2.3）：
    // prepare 先在 userData 下建出真实项目根（让"根可用"这个健康态成立），
    // act 把 projects.current 指过去，check 先断言卡片出现且不是警示态、
    // 再把根改成一个**不存在**的目录断言警示态出现（假设 7 的可见提示），最后还原成无项目。
    {
      name: 'chat',
      file: 'chat-project-card.png',
      prepare: async () => {
        await mkdir(captureProjectRoot(userData), { recursive: true })
      },
      act: chatProjectAct(captureProjectRoot(userData), '截图项目'),
      check: chatProjectCardCheck('截图项目', captureMissingProjectRoot(userData)),
    },
    // 「文件备份」卡移出主界面（2026-09，回滚 UI 迁设置页 Agent 页）：
    // prepare 仍种一份真实快照（反例现场必须有数据）并 reload，check 断言右栏
    // **不再出现**快照卡（chat.snapshot-card / chat.snapshot-restore 均为 0）；
    // 正例断言（列表 + 两段式回滚）见 settings-snapshot-list.png 场景。
    {
      name: 'chat',
      file: 'chat-snapshot-card-removed.png',
      prepare: async () => {
        await seedSnapshotFixture(userData)
        await manager.reload('chat', {})
      },
      check: CHAT_SNAPSHOT_CARD_REMOVED_CHECK,
    },
    // 右栏「任务」面板（v15，docs/06 §4.1）：
    // 现场由 runCapture 在跑计划前种好（seedJobFixture，**必须早于面板首读** —— job 存储
    // 首读即缓存，读到空表后再写文件面板是看不见的）；act 什么都不点（点「继续」会真的
    // 发起续跑），check 只读断言面板与状态文案。
    {
      name: 'chat',
      file: 'chat-job-panel.png',
      // 本场景没有 query，captureWindows 不会替我们 reload：这里 reload 一次让面板重新挂载。
      prepare: async () => {
        await manager.reload('chat', {})
      },
      check: CHAT_JOB_PANEL_CHECK,
    },
    // 综合概览（step 5）：右栏同时挂「当前项目 + 任务」两张卡，用于人工核对布局。
    // 现场两样都要现种：项目根 + 一份 paused job，然后 reload 让两张卡一起水合。
    // （「文件备份」卡已迁设置页：右栏不再有快照卡，check 里附带断言它的缺席。）
    {
      name: 'chat',
      file: 'chat-agent-prod-overview.png',
      prepare: async () => {
        await mkdir(captureProjectRoot(userData), { recursive: true })
        await seedJobFixture(userData)
        hooks.setProject?.({
          id: 'capture-overview',
          name: '截图项目',
          root: captureProjectRoot(userData),
        })
        await manager.reload('chat', {})
      },
      check: CHAT_OVERVIEW_CHECK,
    },
    // 思考过程折叠块（BetaV2）：seed 会话的助手消息带 `reasoning`，历史水合后默认收起；
    // act 点开展开态拍进截图，check 断言「曾收起 + 现已展开 + 全文可见 + 块在正文上方」。
    {
      name: 'chat',
      file: 'chat-thinking-block.png',
      // 现场由 `runCapture` 在跑计划前种好（见 `seedChatTtsHistory`）；这里 reload 一次
      // 让渲染层重新水合 main 会话 —— 本场景没有 `query`，`captureWindows` 不会替我们 reload。
      prepare: async () => {
        await manager.reload('chat', {})
      },
      act: CHAT_THINKING_BLOCK_ACT,
      check: CHAT_THINKING_BLOCK_CHECK,
    },
    // 快速会话（BetaV2）：点左栏固定项切到 sessionId='quick'，主区标题变「快速对话」。
    // 停在 quick 会话没有影响：chat-tts 自带 reload 回到 main，其余场景只依赖 provider 配置。
    {
      name: 'chat',
      file: 'chat-quick-session.png',
      act: CHAT_QUICK_SESSION_ACT,
      check: CHAT_QUICK_SESSION_CHECK,
    },
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
    // 输入区（2026-09 输入框重做）：斜杠命令浮层 + 权限钮 + 上下文条，以及权限下拉的两段式关闭。
    // 两段都自己收尾（清空输入框 / 收起下拉），不改任何配置，因此可以插在朗读场景之前。
    {
      name: 'chat',
      file: 'chat-composer-slash.png',
      act: CHAT_COMPOSER_ACT,
      check: CHAT_COMPOSER_CHECK,
    },
    {
      name: 'chat',
      file: 'chat-composer-permission.png',
      act: CHAT_PERMISSION_ACT,
      check: CHAT_PERMISSION_CHECK,
    },
    // 只读档现场（v13，docs/06 §11.2）：切到 readonly + 展开下拉，断言文案与配置一致后还原。
    // 必须排在 chat-collapse 之前（窗口一被 hide，后面的 DOM 操作就没了）。
    {
      name: 'chat',
      file: 'chat-permission-readonly.png',
      act: CHAT_PERMISSION_READONLY_ACT,
      check: CHAT_PERMISSION_READONLY_CHECK,
    },
    // 输入区三个浮层（2026-09-26 修复）：统一锚在 `.composer-box` 上、共用 `--z-flyout`、互斥打开。
    // act 走「输入 / → 点权限钮」，check 对两个时刻 + 实时复测 + 上下文详解卡共四个时刻做几何断言
    //（最多一个可见 / 不与 `.composer-bar` 相交 / 整个矩形在输入卡上方 / 发送键中心命中的是它自己）。
    // 必须排在 chat-collapse 之前（窗口一被 hide，后面的 DOM 操作就没了）。
    {
      name: 'chat',
      file: 'chat-composer-flyouts.png',
      act: CHAT_COMPOSER_FLYOUTS_ACT,
      check: CHAT_COMPOSER_FLYOUTS_CHECK,
    },
    // 工具卡展开的「实测高度」终点（2026-09-26 修复）：`--collapse-h` 必须是内联 px 且等于 scrollHeight。
    // 需要 main 会话里的 seed 工具卡（todo_write / task），而前面的 `chat-quick-session` 停在 quick 会话
    //（quick 没有工具卡），所以这里像 `chat-tts` 那样 reload 一次回到 main。
    // 截图即展开现场，**不收卡片**；展开态只影响这张卡自身，后续场景不受影响（chat-tts 自带 reload）。
    {
      name: 'chat',
      file: 'chat-tool-card-open.png',
      prepare: async () => {
        await manager.reload('chat', {})
      },
      act: CHAT_TOOL_CARD_OPEN_ACT,
      check: CHAT_TOOL_CARD_OPEN_CHECK,
    },
    // 左栏归档分组（2026-09 新增）：act 展开分组拍图，check 在做完「真实 UI 归档 → 撤销归档」
    // 的往返后收尾（收起分组、清残留），不留被改过的左栏给后续场景。
    {
      name: 'chat',
      file: 'chat-archive.png',
      act: CHAT_ARCHIVE_ACT,
      check: CHAT_ARCHIVE_CHECK,
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
    {
      name: 'chat',
      file: 'chat-subagent-page.png',
      act: CHAT_SUBAGENT_OPEN_ACT,
      check: CHAT_SUBAGENT_OPEN_CHECK,
    },
    // 自动化页四连（docs/13 §11）：进入页面 → Normal tab（内置区）→ 编辑器弹窗 →
    // 历史 + Agent 回放；最后一张收尾时还原主区。数据来自 seedAutomationFixture。
    {
      name: 'chat',
      file: 'chat-automation.png',
      act: CHAT_AUTOMATION_OPEN_ACT,
      check: CHAT_AUTOMATION_OPEN_CHECK,
    },
    {
      name: 'chat',
      file: 'chat-automation-normal.png',
      act: CHAT_AUTOMATION_NORMAL_ACT,
      check: CHAT_AUTOMATION_NORMAL_CHECK,
    },
    {
      name: 'chat',
      file: 'chat-automation-editor.png',
      act: CHAT_AUTOMATION_EDITOR_ACT,
      check: CHAT_AUTOMATION_EDITOR_CHECK,
    },
    {
      name: 'chat',
      file: 'chat-automation-history.png',
      act: CHAT_AUTOMATION_HISTORY_ACT,
      check: CHAT_AUTOMATION_HISTORY_CHECK,
    },
    // ClassIsland 课堂状态卡：需要真实桥接产出，因此主进程侧先种夹具（见 seedClassIslandFixture），
    // 再由 act 把课表来源切到 classisland + 文件模式指向它；check 收尾还原成 manual。
    {
      name: 'chat',
      file: 'chat-classisland-status.png',
      act: chatClassislandAct(classislandFixturePath(userData)),
      check: CHAT_CLASSISLAND_CHECK,
    },
    { name: 'chat', file: 'chat-drag.png', check: WINDOW_DRAG_SCRIPT },
    { name: 'chat', file: 'chat-collapse.png', check: CHAT_COLLAPSE_CHECK },
    { name: 'chat', file: 'chat.png', check: CHAT_AUTO_SCROLL_SCRIPT },
    // 五段共用同一窗口，不能加 query / reload；本地占位凭据只在隔离 userData 中保存，绝不测试连接。
    // 双主题场景（step-06）刻意排在五段**之前**：它只等第 0 段就位、不点任何页脚按钮，
    // 因此引导的阶段推进与既有五条断言完全不受影响。
    {
      name: 'onboarding',
      file: 'theme-onboarding.png',
      act: onboardingWaitScript(0),
      check: themeProbeScript({ theme, transparent: false }),
      nativeCheck: themeNativeCheck(manager, 'onboarding', theme),
    },
    {
      name: 'onboarding',
      file: 'onboarding-welcome.png',
      act: onboardingWaitScript(0),
      check: onboardingCheckScript(0),
    },
    {
      name: 'onboarding',
      file: 'onboarding-llm.png',
      act: onboardingWaitScript(1, 'next'),
      check: onboardingCheckScript(1),
    },
    {
      name: 'onboarding',
      file: 'onboarding-modes.png',
      act: onboardingWaitScript(2, 'model'),
      check: onboardingCheckScript(2),
    },
    {
      name: 'onboarding',
      file: 'onboarding-guide.png',
      act: onboardingWaitScript(3, 'next'),
      check: onboardingCheckScript(3),
    },
    {
      name: 'onboarding',
      file: 'onboarding-done.png',
      act: onboardingWaitScript(4, 'skip'),
      check: onboardingCheckScript(4),
    },
  ]
  // 双主题（step-06）：设置窗先落在「常规」页拍一张主题场景，后面的深链循环不受影响。
  plan.push({
    name: 'settings',
    file: 'theme-settings.png',
    query: { page: 'general' },
    check: themeProbeScript({ theme, transparent: false }),
    nativeCheck: themeNativeCheck(manager, 'settings', theme),
  })
  // ClassIsland 联动（v3）：新增的设置项只在「provider = classisland + 至少一节课程」时渲染，
  // 出厂默认（manual + lessons: []) 数不到它们，因此单独补一个场景：
  // 先经 settings:update 造出该现场并拍图，check 断言两项都在、随后**还原配置**。
  // 必须排在 settings-modes.png 之前吗？不必 —— 它由自己的 query 重新落页，
  // 且 check 收尾已还原，后续场景读到的仍是出厂门控。
  plan.push({
    name: 'settings',
    file: 'settings-classisland-notify.png',
    query: { page: 'modes' },
    act: SETTINGS_CLASSISLAND_SEED_ACT,
    check: SETTINGS_CLASSISLAND_FIELDS_SCRIPT,
  })
  for (const page of SETTINGS_PAGE_IDS) {
    plan.push({
      name: 'settings',
      file: `settings-${page}.png`,
      query: { page },
      // 「常规」页是 `general.*` 门控的现场：死字段 general.language 必须为 0，
      // 提示条透明度 / 静默时段要跟着 general.edgeBar.enabled 出现或消失，
      // BetaV2 迁入的全局勿扰时段（advanced.quietHours）两字段必须常在；
      // 「模式」页（ClassRoom 生效）：classroom 区组在、work 区组整块不在（BetaV2 互斥渲染），
      // 前置 act 展开「课表」分组（默认收起，否则课前提醒字段不在 DOM）；
      // 「AI 模型」页（BetaV2）：对话展示开关 + 生图模型区组；
      // 「语音」页（BetaV2 合并 TTS + STT）：两个区组各自的常显字段与列表空态二选一；
      // 「智能与工具」页（BetaV2 合并技能 + MCP）：预期空状态见 SETTINGS_AGENT_FIELDS_SCRIPT；
      // 技能 / MCP 区组默认收起（docs/07 §2.5），探针在 check 里自己先展开再计数（async），
      // 所以这里**不需要**像 modes 页那样配 act —— PNG 拍到的正是默认收起态。
      act: page === 'modes' ? SETTINGS_MODES_EXPAND_ACT : undefined,
      check:
        page === 'general'
          ? SETTINGS_FIELDS_SCRIPT
          : page === 'modes'
            ? SETTINGS_MODES_CLASSROOM_SCRIPT
            : page === 'llm'
              ? SETTINGS_LLM_FIELDS_SCRIPT
              : page === 'voice'
                ? SETTINGS_VOICE_FIELDS_SCRIPT
                : page === 'center'
                  ? SETTINGS_CENTER_FIELDS_SCRIPT
                  : page === 'agent'
                    ? SETTINGS_AGENT_FIELDS_SCRIPT
                    : undefined,
    })
  }
  // 旧深链别名（BetaV2）：`?page=tts` 应映射到「语音」页（TTS + STT 都在）；
  // skills|mcp → agent 走同一张 LEGACY_PAGE_ALIASES 映射表，机制由本场景代表验证。
  plan.push({
    name: 'settings',
    file: 'settings-legacy-tts-alias.png',
    query: { page: 'tts' },
    check: SETTINGS_LEGACY_ALIAS_SCRIPT,
  })
  // 设置页「文件备份」列表（2026-09，回滚 UI 自主界面右栏迁入 Agent 页）：
  // prepare 种一份真实快照（走真实端口 + flush，不是手写 json），随后**带 query 重载**
  // 设置窗让 SnapshotList 重新挂载并首读（列表只在挂载 / 手动刷新时拉取）；
  // act 点一次「回滚」（两段式的第一下），check 断言列表在、有记录、来源文案、
  // 清理 / 刷新入口与待确认文案。
  plan.push({
    name: 'settings',
    file: 'settings-snapshot-list.png',
    query: { page: 'agent' },
    prepare: async () => {
      await seedSnapshotFixture(userData)
      await manager.reload('settings', { page: 'agent' })
    },
    act: SETTINGS_SNAPSHOT_LIST_ACT,
    check: SETTINGS_SNAPSHOT_LIST_CHECK,
  })
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
  // ⚠️ `settings-voice.png` 不在这里 push：上面的 `SETTINGS_PAGE_IDS` 循环已经为每个 page
  // 生成 `settings-<page>.png`（含 `voice`），再 push 一张同名图会多截一次、`report.json` 里
  // 出现两条同名且后者把前者的 check 顶掉，所以要拍的只有这张卡场景。
  // 深链用旧 id `tts`（别名场景同款）：顺带覆盖「旧链接打开的页面上编辑卡流程照常可用」。
  plan.push({
    name: 'settings',
    file: 'settings-tts-card.png',
    query: { page: 'tts' },
    act: SETTINGS_TTS_ADD_ACT,
    check: SETTINGS_TTS_CARD_CHECK,
  })
  // 真实写盘：改一个 classroom 字段后其它字段不能丢（浅合并语义回归）。
  // 必须排在「切到 Work」之前 —— 切走之后 classroom 控件就不在 DOM 里了。
  // （ClassRoom 生效态的结构断言已由上面循环里的 `settings-modes.png` 承担，
  // 这里只保留「真实写盘」与「切 Work 门控」两个会改状态的动作场景。）
  plan.push({
    name: 'settings',
    file: 'settings-classroom-patch.png',
    query: { page: 'modes' },
    act: SETTINGS_CLASSROOM_PATCH_ACT,
    check: SETTINGS_CLASSROOM_PATCH_CHECK,
  })
  // 模式页门控（BetaV2 重写）：切到 Work 后 `modes.work.workspaceDir` 必须出现，
  // classroom 区组与 modes.* 空状态卡必须消失 —— Work 已实装，不再是「暂无可配置项」。
  plan.push({
    name: 'settings',
    file: 'settings-modes-work-gating.png',
    query: { page: 'modes' },
    act: SETTINGS_SWITCH_TO_WORK_SCRIPT,
    check: SETTINGS_WORK_GATING_SCRIPT,
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
