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
import type { Logger, WindowName } from '@aurora/shared'
import type { WindowManager } from './window-manager.js'
/**
 * 设置页可深链的页面 id，需与 `renderer/settings/App.vue` 的 `PageId` 保持一致。
 *
 * BetaV2 六页 IA（spec §9）：8 页合并为 6 页 —— TtsPage 并入 voice（与 STT 同页）、
 * SkillsPage / McpPage 并入 agent。旧深链（`?page=tts|skills|mcp`）由渲染层的
 * `LEGACY_PAGE_ALIASES` 单向映射到新页，深链清单本身只保留新 id；
 * 别名映射由 `settings-legacy-tts-alias.png` 场景单独钉住（见 defaultCapturePlan）。
 */
export const SETTINGS_PAGE_IDS = ['general', 'modes', 'llm', 'voice', 'agent', 'advanced'] as const

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
 * 「子代理」页面探针（docs/07 §2.4）。
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
 * check 断言四件事：
 * ① 助手气泡出现且正文含桩服务的标记（回复真的画到了 DOM 上，而不只是事件里有）；
 * ② 用户气泡也在（发送路径把提问渲染出来了）；
 * ③ 上下文条显示**真实 token 数**（桩服务的结束片带 usage → 界面必须不再是「暂无用量数据」），
 *    且累计同样非零 —— 这条同时钉住 usage 事件 → useChat → 上下文条整条链；
 * ④ 流式已收尾（`.thread.streaming` 不存在），即「流式态不会卡住」。
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
        stillStreaming === false &&
        lastThinkingLabel.indexOf('已深度思考') !== -1 &&
        lastThinkingText.indexOf(${reasoningLiteral}) !== -1,
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

export const CHAT_PERMISSION_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const textOf = (selector) => {
      const el = document.querySelector(selector)
      return el === null ? '' : (el.textContent || '').trim()
    }
    const menuOpen = count('[data-field="chat.permission-menu"]') === 1
    const confirmItem = textOf('[data-field="chat.permission-confirm"]')
    const fullItemBefore = textOf('[data-field="chat.permission-full"]')

    const fullButton = document.querySelector('[data-field="chat.permission-full"]')
    if (fullButton !== null) fullButton.click()
    await wait(300)
    const fullItemAfter = textOf('[data-field="chat.permission-full"]')

    const state = await window.aurora.settings.get()
    const stillConfirm = state.ok ? state.value.advanced.confirmSensitiveTools === true : null

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
      confirmOption: confirmItem.indexOf('变更前确认') !== -1,
      fullOption: fullItemBefore.indexOf('完全权限') !== -1,
      askedAgain: fullItemAfter.indexOf('再点一次确认') !== -1,
      confirmSensitiveTools: stillConfirm,
      menuClosedAfter: closed,
      pass:
        menuOpen &&
        confirmItem.indexOf('变更前确认') !== -1 &&
        fullItemBefore.indexOf('完全权限') !== -1 &&
        fullItemAfter.indexOf('再点一次确认') !== -1 &&
        stillConfirm === true &&
        count('[data-field="chat.permission-menu"]') === 0,
    }
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
    const activeMode = document.querySelector('.cards .card.active .card-head strong')
    const activeNav = document.querySelector('.nav-item.active')
    return {
      page: activeNav === null ? 'unknown' : (activeNav.textContent || '').trim(),
      classroomFields,
      languageFields,
      edgeBarToggle,
      edgeBarDetail,
      quietHoursFields,
      activeMode: activeMode === null ? null : (activeMode.textContent || '').trim(),
      emptyStates,
      // 死字段（general.language）在任何页面都不该出现；提示条详情跟着开关走；
      // 全局勿扰时段两个字段必须随页常在
      pass:
        languageFields === 0 &&
        quietHoursFields === 2 &&
        (edgeBarToggle === 0 ? edgeBarDetail === 0 : edgeBarDetail > 0),
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
    const openFields = count('[data-field^="agent.tools.open"]')
    const emptyStates = Array.from(document.querySelectorAll('[data-empty]')).map((el) =>
      el.getAttribute('data-empty'),
    )
    // 合并区组的预期空状态：MCP 无服务器（空状态）或有服务器（行容器）二选一；
    // 技能同理（内置技能发现不到才会有 skills.disabled 空状态）
    const mcpEmpty = emptyStates.indexOf('mcp.servers') !== -1
    const mcpRows = count('[data-field^="mcp.servers."]')
    const skillsEmpty = emptyStates.indexOf('skills.disabled') !== -1
    const skillsRows = count('[data-field^="skills.disabled."]')
    const unexpected = emptyStates.filter(
      (name) => name !== 'mcp.servers' && name !== 'skills.disabled',
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
      mcpEmpty,
      mcpRows,
      skillsEmpty,
      skillsRows,
      unexpected,
      emptyStates,
      // 总开关必须在（否则用户再也开不回来）；开着时三个分栏的详情字段都得在，
      // MCP 区组必须给出「空状态或行」之一，且不得出现两块预期空态之外的 data-empty
      pass:
        toggle !== null &&
        (enabled !== true ||
          (terminalFields > 0 &&
            filesFields > 0 &&
            openFields > 0 &&
            (mcpEmpty || mcpRows > 0) &&
            unexpected.length === 0)),
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
      emptyStates,
      pass:
        classroomFields > 0 &&
        watchDir === 1 &&
        workFields === 0 &&
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
    return { stage: expected.label, action: ${JSON.stringify(action ?? 'ready')} }
  })()`
}

function onboardingCheckScript(index: number): string {
  return `(() => {
    try {
      const expected = ${JSON.stringify(ONBOARDING_STAGES[index])}
      const label = (document.querySelector('.progress-text')?.textContent || '').trim()
      const active = Array.from(document.querySelectorAll('.progress-item')).findIndex((el) => el.classList.contains('active'))
      const titleEl = document.querySelector('.pane .pane-title')
      const title = (titleEl?.textContent || '').trim()
      const cta = Array.from(document.querySelectorAll('.foot button')).find((el) =>
        (el.textContent || '').trim() === expected.cta)
      const visible = (el) => {
        if (!el) return false
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 &&
          rect.right <= innerWidth && rect.bottom <= innerHeight &&
          style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
      }
      const rect = cta?.getBoundingClientRect()
      const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null
      const clickable = !!cta && !cta.disabled && !!hit && (hit === cta || cta.contains(hit))
      const reasons = []
      if (label !== expected.label || active !== ${index}) reasons.push('阶段标识不符：期望 ' + expected.label + ' / ' + ${index} + '，实际 ' + label + ' / ' + active)
      if (!title.includes(expected.title) || !visible(titleEl)) reasons.push('标题不可见或不符：期望 ' + expected.title + '，实际 ' + title)
      if (!cta) reasons.push('缺少页脚主 CTA「' + expected.cta + '」')
      else {
        if (!visible(cta)) reasons.push('主 CTA「' + expected.cta + '」超出窗口或不可见')
        if (!clickable) reasons.push('主 CTA「' + expected.cta + '」禁用或中心无法命中')
      }
      return { pass: reasons.length === 0, stage: label, active, title, cta: (cta?.textContent || '').trim(), visible: visible(cta), clickable, reason: reasons.join('；') || null }
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
 * → `chat-thinking-level` → `chat-model-picker`（step 5 加）→ `chat-tts`（step 6 加，
 * 自带 reload 回到 main 会话）→ `chat-drag` → `chat-collapse` → `chat.png`。
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
}

export function defaultCapturePlan(manager: WindowManager, userData: string): CaptureTarget[] {
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
