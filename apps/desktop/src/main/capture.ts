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
 *    只从主进程扩大 shape 会拍到一个空窗口。`act` 让截图走真实的 hover / touch / click 链路；
 * 3. `check`：截图后在渲染层取一份**可判定的结果**（DOM 命中测试、IPC 回执），
 *    与服务端的 `AURORA_SMOKE` 互补 —— 截图回答"长什么样"，check 回答"能不能点"。
 *
 * 设计取舍：
 * - 单窗失败只记日志、不中断整批 —— 截图是核对手段，不该因为某个窗口还没实现就全盘失败；
 * - 每个窗口之间留 `delayMs`（默认 700ms）让进场动画落位，否则会拍到过渡中间帧；
 * - 需要深链的窗口（设置页 `?page=`）用 reload 而不是新开窗口，避免堆一排窗口。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { nativeTheme, webContents, type BrowserWindow } from 'electron'
import {
  createFileSnapshotPort,
  type AskUserAnswer,
  type AskUserQuestion,
} from '@aurora/agent-core'
import {
  IPC,
  createNoopLogger,
  nodeFileSystem,
  type AutomationRun,
  type Logger,
  type WindowName,
} from '@aurora/shared'
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
  // 会话管理（2026-09-30 新增：项目管理自"通用"页迁入 + 会话列表）
  'sessions',
  'modes',
  'llm',
  'voice',
  'agent',
  'awareness',
  'center',
  'plugins',
  'advanced',
] as const

export type SettingsPageId = (typeof SETTINGS_PAGE_IDS)[number]

/**
 * `ask_user` 提问卡片的**作用域注入点**（capture 专用，2026-09）。
 *
 * 为什么需要它：提问只能由**主进程**发起（内核工具 → 装配层服务的 `ask`），
 * 渲染层的探针脚本无法凭空造出一张请求卡片。capture.ts 又拿不到 `index.ts` 的
 * 模块级服务实例（那会是循环依赖），因此由 `index.ts` 在截图模式下反向注册一个"发起一次提问"
 * 的函数 —— 与 `seedAutomationFixture` 由 index.ts 调用是同一个方向。
 *
 * 未注册时场景的 `prepare` 什么都不做，check 会如实报 FAIL（不是静默通过）。
 */
let askUserSpawner: (() => Promise<AskUserAnswer>) | null = null

export function registerAskUserSpawner(spawn: () => Promise<AskUserAnswer>): void {
  askUserSpawner = spawn
}

/** 截图场景里那次提问的回执（nativeCheck 断言它 —— 证明"点回答"真的回到了内核） */
let askUserCaptureAnswer: AskUserAnswer | undefined

/**
 * Agent 内置浏览器的自测执行器（v35，docs/06 §27）。
 *
 * `capture.ts` 拿不到 `index.ts` 的 `BrowserAgentManager` 实例（反向依赖会成环），
 * 因此由 `index.ts` 在截图模式下反向注册一个「跑一轮真实驱动」的函数 ——
 * 与 `registerAskUserSpawner` 同一个方向、同一个理由。
 * 未注册时场景的 `mainAct` 如实返回失败（不是静默通过）。
 */
export interface BrowserAgentCaptureOutcome {
  ok: boolean
  reason?: string
  detail?: Record<string, unknown>
}

let browserAgentCaptureRunner: (() => Promise<BrowserAgentCaptureOutcome>) | undefined
let browserAgentCaptureCleanup: (() => void) | undefined

export function registerBrowserAgentCaptureRunner(
  run: () => Promise<BrowserAgentCaptureOutcome>,
  cleanup: () => void,
): void {
  browserAgentCaptureRunner = run
  browserAgentCaptureCleanup = cleanup
}

/**
 * 截图用的提问内容（3 个选项、单选）：
 * 选项文案固定，好让探针断言"选中的就是第 2 个"以及回执里的答案与之一致。
 */
export const ASK_USER_CAPTURE_QUESTION: AskUserQuestion = {
  question: '要把归档后的课件放到哪个目录？',
  header: '目标目录',
  options: [
    { label: '科目资料文件夹', description: '按课程表科目分类存放' },
    { label: '桌面"本周课件"', description: '先堆在桌面，手动再整理' },
    { label: '先别移动文件', description: '只生成清单，文件留在原地' },
  ],
  multiSelect: false,
}

/** 第二个选项的 label（探针用它断言"点哪个就回哪个"） */
export const ASK_USER_CAPTURE_SECOND = ASK_USER_CAPTURE_QUESTION.options?.[1]?.label ?? ''

export type CaptureWindowName = WindowName | 'awareness-glow' | 'widget'

export interface CaptureTarget {
  name: CaptureWindowName
  /**
   * 桌面小组件窗口（不在 `WindowName` 里）：由 `CaptureOptions.widgetWindow` 现取。
   * 给了这一项就不再走 `WindowManager.ensure/show`。
   */
  widget?: { pluginId: string; widgetId: string }
  /** 输出文件名（不含目录），默认 `<name>.png` */
  file?: string
  /** 需要深链时附带（如设置页 `{ page: 'llm' }`） */
  query?: Record<string, string>
  /** 截图前的主进程侧准备（展开提示条、切到某个模式等） */
  prepare?: () => Promise<void> | void
  /** 截图前在目标窗口渲染层执行的 JS（模拟 hover / click 等真实交互） */
  act?: string
  /**
   * 本场景独有的"等两帧渲染之后还要多久"覆盖值（缺省用 `CaptureOptions.delayMs`）。
   *
   * 只有**动到窗口本身**的场景才需要它：`act` 是 await 的，但"提示条展开"走的是
   * 主进程 shape + IPC，属于**跨进程**异步 —— act 返回时画面还停在收起态
   *（2026-10-01 实测：把缺省等待从 700ms 收到 292ms 后，`edge-bar-expanded.png`
   * 从 79KB 掉到 7.6KB，画面是竖条、DOM 却已是展开态 —— 探针 PASS 但图是错的）。
   */
  settleMs?: number
  /**
   * 截图前在**主进程侧**执行的动作（拿到 `BrowserWindow`）。
   *
   * 存在的理由：**JS 合成事件测不到原生输入管线** —— `dispatchEvent(new WheelEvent(...))`
   * 能驱动得了监听器，却不触发合成器滚动，"程序把用户刚滚出去的视口吸回去"这类失效
   * 在合成事件面前必然 PASS。真实滚轮要走 CDP `Input.dispatchMouseEvent`
   * （`webContents.debugger`），只有主进程能挂 —— 见 `chat-trace-wheel` 场景
   * 与 docs/07 §5.3"真实滚轮跟随"。返回值必须带 `pass`，与渲染层结果合并进同一条 checks 记录。
   */
  mainAct?: (
    win: BrowserWindow,
  ) =>
    | Promise<{ pass: boolean } & Record<string, unknown>>
    | ({ pass: boolean } & Record<string, unknown>)
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
  /** 桌面小组件窗口取用（插件系统未装配时为空 → 对应场景如实 FAIL） */
  widgetWindow?: (pluginId: string, widgetId: string) => BrowserWindow | undefined
  /** 等小组件窗口首次加载结束 */
  widgetLoaded?: (pluginId: string, widgetId: string) => Promise<void>
  logger?: Logger
  /** 每张截图前的等待（默认 700ms，等过渡动画结束） */
  delayMs?: number
}
export interface CaptureCheck {
  name: CaptureWindowName
  file: string
  /** `check` 脚本的返回值（未提供 check 时为空） */
  result?: unknown
  /**
   * 该目标是否**配了**探针（`check` 或 `nativeCheck`）。
   *
   * 必须单列一个字段：`result` 为空有两种含义 —— "本来就没配探针"（纯截图场景，正常）
   * 与"配了探针却没返回结果"（断言根本没生效）。只靠 `result` 分不出来，
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
 * "等两帧渲染"的脚本：`executeJavaScript(task, true)` 本身是 await 的，act 里所有异步
 * （写配置、reload、IPC 往返）在它返回时都已结束，差的只是浏览器把 DOM 变更画出来。
 * 窗口被隐藏时 rAF 不派发（promise 永不 settle），调用方必须配超时兜底。
 */
const PAINT_WAIT_SCRIPT =
  'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'

/**
 * 等这一场景的画面真的落到帧上。
 *
 * 两帧 rAF 保证 DOM 变更已渲染；场景里还可能带 CSS transition（提示条展开 220ms 一类），
 * rAF 之后仍需一段，所以再补一个 `settleMs`。原先是无条件 `wait(700)`：
 * **59 个场景里 51 个带 act**，那段固定等待接近一轮时长的一半
 *（2026-10-01 实测：70 张图相邻间隔合计 105.6s，其中固定等待约 49s）。
 */
async function waitForPaint(win: BrowserWindow, settleMs: number): Promise<void> {
  await Promise.race([
    win.webContents
      .executeJavaScript(PAINT_WAIT_SCRIPT, true)
      // 窗口已被 hide 的场景：拿不到结果就由下面的 settle 兜底，不要在这里抛错卡住整轮
      .catch(() => undefined),
    wait(1000),
  ])
  await wait(settleMs)
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
  // `delayMs` 的语义是"rAF 之后额外等多久让动画收尾"，不是"固定等待总时长"
  //（总等待 = 两帧 rAF + 它）。缺省值按场景里最长的 CSS transition（220ms 级）留余量。
  const delayMs = options.delayMs ?? 260
  await mkdir(dir, { recursive: true })

  const files: string[] = []
  const checks: CaptureCheck[] = []
  for (const target of targets) {
    const file = join(dir, target.file ?? `${target.name}.png`)
    try {
      // 1) 先把窗口建出来并等首次加载结束（否则紧接着的 reload 会把它打断成 ERR_ABORTED）；
      // 2) query 目标再 reload 一次带上深链参数；
      // 3) 后续页面复用同一个窗口，只走 reload。
      const requestedName = target.name
      const internalGlow = requestedName === 'awareness-glow'
      const widgetTarget = target.widget
      // 走 WindowManager 的目标名（widget 目标单独走下面的分支，不会到这里）
      const windowName = requestedName as WindowName
      let win: BrowserWindow
      if (widgetTarget !== undefined) {
        const resolved = options.widgetWindow?.(widgetTarget.pluginId, widgetTarget.widgetId)
        if (resolved === undefined) throw new Error('桌面小组件窗口不存在')
        win = resolved
        await options.widgetLoaded?.(widgetTarget.pluginId, widgetTarget.widgetId)
      } else if (internalGlow) {
        win = manager.ensureAwarenessGlowForCapture()
        await manager.whenAwarenessGlowLoaded()
      } else {
        win = manager.ensure(windowName)
        await manager.whenLoaded(windowName)
      }
      if (widgetTarget !== undefined) {
        await target.prepare?.()
      } else if (target.query !== undefined) {
        if (internalGlow) await manager.reloadAwarenessGlow(target.query)
        else await manager.reload(windowName, target.query)
      }
      if (widgetTarget === undefined) {
        await target.prepare?.()
        if (internalGlow) manager.showAwarenessGlow()
        else manager.show(windowName)
        // ensure() 里的加载是 fire-and-forget，必须显式等它结束（否则会截到空图）
        if (internalGlow) await manager.whenAwarenessGlowLoaded()
        else await manager.whenLoaded(windowName)
      }
      if (target.act !== undefined) {
        await wait(60)
        await win.webContents.executeJavaScript(target.act, true)
      }
      let mainActResult: ({ pass: boolean } & Record<string, unknown>) | undefined
      if (target.mainAct !== undefined) {
        await wait(60)
        mainActResult = await target.mainAct(win)
      }
      await waitForPaint(win, target.settleMs ?? delayMs)
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
        result: mergeCheckResults(
          mergeCheckResults(rendererResult, mainActResult, 'main'),
          target.nativeCheck?.(),
        ),
        checked:
          target.check !== undefined ||
          target.nativeCheck !== undefined ||
          target.mainAct !== undefined,
        ok: true,
      })
    } catch (error) {
      logger?.warn('窗口截图失败', { window: target.name, error: String(error) })
      checks.push({
        name: target.name,
        file,
        checked:
          target.check !== undefined ||
          target.nativeCheck !== undefined ||
          target.mainAct !== undefined,
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
    // "静默丢一条"会以退出码 0 结束。所以 `checked` 字段必须参与判定
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
 * 把渲染层 `check` 与主进程侧结果（`mainAct` / `nativeCheck`）合成一条探针结果。
 *
 * 两者都在才要求双通过；只有主进程侧结果（没有渲染层 check）时以它为准。
 * 渲染层返回非对象（理论上不会）时降级成 `{ renderer, …, pass:false }`，
 * 避免静默把一次失败当成通过。`key` 是主进程侧结果在报告里的字段名
 * （`nativeCheck` 用 `native`、`mainAct` 用 `main`，排障时一眼分得出哪边说话）。
 */
function mergeCheckResults(
  renderer: unknown,
  extra: ({ pass: boolean } & Record<string, unknown>) | undefined,
  key = 'native',
): unknown {
  if (extra === undefined) return renderer
  if (renderer === undefined) return { [key]: extra, pass: extra.pass }
  const record =
    typeof renderer === 'object' && renderer !== null
      ? (renderer as Record<string, unknown>)
      : { renderer }
  return { ...record, [key]: extra, pass: record['pass'] === true && extra.pass === true }
}

/**
 * 渲染层探针脚本。
 *
 * 都写成"立即执行的表达式"字符串：`executeJavaScript` 需要返回值（而不是 undefined），
 * 且必须自带 try/catch —— 抛错会让整张截图算失败，而探针本身只是想说明状态。
 */

/** 模拟鼠标移入提示条（真实 hover 链路：120ms 后 IPC 扩大 shape + 挂载面板） */
export const EDGE_BAR_HOVER_SCRIPT = `(() => {
  try {
    const el = document.querySelector('.edge')
    if (!el) return { hovered: false, reason: 'no .edge' }
    el.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false, pointerType: 'mouse' }))
    return { hovered: true }
  } catch (error) {
    return { hovered: false, reason: String(error) }
  }
})()`

/** 模拟鼠标移出提示条（面板淡出 → shape 收回 8px） */
export const EDGE_BAR_LEAVE_SCRIPT = `(() => {
  try {
    const el = document.querySelector('.edge')
    if (!el) return { left: false, reason: 'no .edge' }
    el.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false, pointerType: 'mouse' }))
    return { left: true }
  } catch (error) {
    return { left: false, reason: String(error) }
  }
})()`

/**
 * 弹出动效探针：从头走一遍"收起 → 鼠标悬停展开"，记录过渡进行中与终态。
 *
 * 结果存在渲染层全局供后续 check 读取；act 返回时动画已经收尾，不会把采样压力留给截图等待。
 */
export const EDGE_BAR_ANIMATION_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const root = document.querySelector('.edge')
    if (!root) return { ok: false, reason: 'no .edge' }
    root.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false, pointerType: 'mouse' }))
    await wait(650)
    root.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false, pointerType: 'mouse' }))
    await wait(190)
    const panel = document.querySelector('[data-field="edge-bar.panel"]')
    if (!panel) return { ok: false, reason: 'panel not mounted' }
    const read = () => {
      const node = document.querySelector('[data-field="edge-bar.panel"]')
      if (!node) return null
      const style = getComputedStyle(node)
      return { opacity: style.opacity, transform: style.transform }
    }
    const probe = {
      mounted: true,
      running: panel.getAnimations().some((animation) => animation.playState === 'running'),
      samples: [],
      final: null,
      stillMounted: false,
    }
    window.__auroraEdgeBarAnimationProbe = probe
    for (let index = 0; index < 4; index += 1) {
      await wait(40)
      const sample = read()
      if (sample) probe.samples.push(sample)
    }
    await wait(300)
    probe.final = read()
    probe.stillMounted = document.querySelector('[data-field="edge-bar.panel"]') !== null
    return { ok: true }
  } catch (error) {
    window.__auroraEdgeBarAnimationProbe = { mounted: false, reason: String(error) }
    return { ok: false, reason: String(error) }
  }
})()`

export const EDGE_BAR_ANIMATION_CHECK = `(() => {
  try {
    const probe = window.__auroraEdgeBarAnimationProbe
    const panel = document.querySelector('[data-field="edge-bar.panel"]')
    const final = probe && probe.final ? probe.final : null
    const moved =
      probe && Array.isArray(probe.samples) && final
        ? probe.samples.some((sample) => sample && (sample.transform !== final.transform || sample.opacity !== final.opacity))
        : false
    const settled =
      final !== null &&
      final.opacity === '1' &&
      (final.transform === 'none' || final.transform === 'matrix(1, 0, 0, 1, 0, 0)')
    return {
      mounted: probe ? probe.mounted === true : false,
      running: probe ? probe.running === true : false,
      sampleCount: probe && Array.isArray(probe.samples) ? probe.samples.length : 0,
      moved,
      settled,
      panel: panel !== null,
      pass:
        probe !== null &&
        probe.mounted === true &&
        probe.running === true &&
        Array.isArray(probe.samples) &&
        probe.samples.length >= 3 &&
        moved &&
        settled &&
        probe.stillMounted === true &&
        panel !== null,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 触摸探针：先确保收起，再派发一次 pointerType=touch 的按下。
 * 期望面板展开且主界面保持隐藏，并等待超过任何 hover 收起延迟后仍然保持。
 */
export const EDGE_BAR_TOUCH_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const root = document.querySelector('.edge')
    const strip = document.querySelector('.strip')
    if (!root || !strip) return { activated: false, reason: 'no edge bar' }
    root.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false, pointerType: 'mouse' }))
    await wait(650)
    strip.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerType: 'touch',
        pointerId: 1,
        isPrimary: true,
        buttons: 1,
      }),
    )
    strip.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        pointerType: 'touch',
        pointerId: 1,
        isPrimary: true,
      }),
    )
    // 真实触摸结束后兼容层可能补一条 pointerleave；触摸分支必须忽略它。
    root.dispatchEvent(
      new PointerEvent('pointerleave', { bubbles: false, pointerType: 'touch' }),
    )
    await wait(450)
    return { activated: true }
  } catch (error) {
    return { activated: false, reason: String(error) }
  }
})()`

export const EDGE_BAR_TOUCH_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    await wait(900)
    const panel = document.querySelector('[data-field="edge-bar.panel"]')
    const root = document.querySelector('.edge')
    const state = await window.aurora.window.getState()
    const style = panel === null ? null : getComputedStyle(panel)
    const expanded = root !== null && root.classList.contains('expanded')
    const chatVisible = state.ok === true && state.value.visible['chat'] === true
    return {
      panel: panel !== null,
      expanded,
      chatVisible,
      opacity: style ? style.opacity : null,
      transform: style ? style.transform : null,
      pass:
        panel !== null &&
        expanded &&
        !chatVisible &&
        style !== null &&
        style.opacity === '1' &&
        (style.transform === 'none' || style.transform === 'matrix(1, 0, 0, 1, 0, 0)'),
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 点击竖条 → 应呼出完整交互窗（回归"点击无法呼出交互窗"）。
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
 * 这一条是"侧边栏点击无效"这类 bug 的关键断言：DOM 里存在按钮 ≠ 用户点得到。
 */
export const EDGE_BAR_PANEL_SCRIPT = `(() => {
  try {
    const panel = document.querySelector('.panel')
    // 面板没挂载正是这条探针要防的故障，必须 pass:false（早退分支不能静默）
    if (!panel) return { panel: false, pass: false, reason: 'no .panel' }
    const width = document.documentElement.clientWidth
    const panelStyle = getComputedStyle(panel)
    const panelBackdrop = panelStyle.backdropFilter || panelStyle.webkitBackdropFilter || ''
    const panelBackground = panelStyle.backgroundColor
    const backgroundMatch = panelStyle.backgroundColor.match(/rgba?\\(([^)]+)\\)/)
    const backgroundParts =
      backgroundMatch === null
        ? []
        : backgroundMatch[1].split(/[,\\s]+/).filter((item) => item !== '')
    const slashAlpha = /\\/\\s*([\\d.]+)\\s*\\)/.exec(panelStyle.backgroundColor)
    const panelAlpha =
      slashAlpha !== null
        ? Number(slashAlpha[1])
        : backgroundParts.length > 3
          ? Number(backgroundParts[3])
          : 1
    const frosted = panelBackdrop.indexOf('blur') !== -1 && panelAlpha < 0.7
    // 2026-10-11：提示条改回**原生 Acrylic**（桌面模糊由 DWM 提供，页面 backdrop-filter 仍是 none）。
    // DOM 侧能证明两件事：① 面板 tint 真的半透明（退回不透明就把材质盖死、看着仍是实色条）；
    // ② 面板铺满**整个客户区**（系统材质裁不出圆角，只能让窗口矩形 == 想看到的矩形，
    //    见 edge-bar/App.vue 的 .panel）。材质到底挂没挂，由主进程的 nativeGlassCheck
    //    （窗口名 edge-bar）单独断言 —— 渲染层看不到 DWM。
    const panelRect = panel.getBoundingClientRect()
    // 面板铺满客户区、只让出右缘 8px 竖条列（2026-10-11：圆角面板 + 窗口区域阶梯近似，
    // 面板必须把「除竖条以外」的整窗盖住，材质才不会从面板边缘露出来）
    const coversWindow =
      Math.abs(panelRect.left) <= 1 &&
      Math.abs(panelRect.top) <= 1 &&
      Math.abs(panelRect.height - document.documentElement.clientHeight) <= 1 &&
      Math.abs(panelRect.right - (width - 8)) <= 2
    const translucentTint = panelAlpha > 0 && panelAlpha < 0.85
    const surfaceReady = panelBackdrop === 'none' && translucentTint && coversWindow
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
    // 提示条不再承载快速对话；快速会话只保留在主界面左栏固定项。
    const quickAbsent = panel.querySelector('.qc-composer, .qc-msg, .recent-card') === null
    const awarenessStatus = panel.querySelector('[data-field="edge-bar.awareness-status"]') !== null
    const analysisProgress = panel.querySelector('[data-field="edge-bar.analysis-progress"]')
    const analysisBar = analysisProgress?.querySelector('.progress-track')
    const analysisValue = Number(analysisBar?.getAttribute('aria-valuenow') ?? Number.NaN)
    const analysisText = analysisProgress?.querySelector('.live-file span')?.textContent?.trim() ?? ''
    const quotaBarAbsent = panel.querySelector('.awareness-hero > .progress-track') === null
    const insights = panel.querySelector('[data-field="edge-bar.insights"]') !== null
    const insightRows = panel.querySelectorAll('.insight-row').length
    const insightMore = panel.querySelectorAll('[data-field="edge-bar.insights-more"]').length
    const insightScroller = panel.querySelector('.insight-list')
    const insightScrollable =
      insightScroller !== null &&
      insightScroller.scrollHeight >= insightScroller.clientHeight &&
      getComputedStyle(insightScroller).overflowY === 'auto'
    // 安全区（docs/07 §5.4）：面板里任何元素都不许探出窗口左右边界 ——
    // 提示条收起只有 8px 宽（展开态 328px），溢出的元素会被直接裁掉、用户点不到。
    let overflow = 0
    const offenders = []
    for (const node of panel.querySelectorAll('*')) {
      const rect = node.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) continue
      if (rect.right > width + 1 || rect.left < -1) {
        overflow += 1
        if (offenders.length < 3) {
          offenders.push(String(node.className).split(' ')[0] + '@' + Math.round(rect.left) + '-' + Math.round(rect.right))
        }
      }
    }
    return {
      panel: true,
      windowWidth: width,
      windowHeight: document.documentElement.clientHeight,
      styled: panelStyle.width,
      panelBackdrop,
      panelBackground,
      panelAlpha,
      frosted,
      translucentTint,
      coversWindow,
      buttonCount: buttons.length,
      probes,
      quickAbsent,
      awarenessStatus,
      analysisProgress: analysisProgress !== null,
      analysisValue,
      analysisText,
      quotaBarAbsent,
      insights,
      insightRows,
      insightMore,
      insightScrollable,
      overflow,
      offenders,
      allClickable: probes.length > 0 && probes.every((p) => p.hit && p.insideWindow),
      pass:
        buttons.length === 3 &&
        coversWindow &&
        quickAbsent &&
        awarenessStatus &&
        analysisProgress !== null &&
        Number.isFinite(analysisValue) &&
        analysisValue > 0 &&
        analysisText !== '' &&
        quotaBarAbsent &&
        insights &&
        insightRows === 5 &&
        insightMore === 1 &&
        insightScrollable &&
        overflow === 0 &&
        surfaceReady &&
        probes.every((p) => p.hit && p.insideWindow && p.width > 0),
    }
  } catch (error) {
    return { panel: false, reason: String(error), pass: false }
  }
})()`

/** 多文件提醒：默认折叠，点击展开后可逐条忽略；忽略后排前面的提醒不再占一整组。 */
export const EDGE_BAR_SUGGESTIONS_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const toggle = document.querySelector('[data-field="edge-bar.suggestions-toggle"]')
    const collapsedItems = count('[data-field="edge-bar.awareness-item"]')
    if (toggle === null) return { toggle: false, collapsedItems, pass: false }
    toggle.click()
    await wait(150)
    const expandedItems = count('[data-field="edge-bar.awareness-item"]')
    const title = document.querySelector('[data-field="edge-bar.awareness-item"] .suggestion-title')
    const body = document.querySelector('[data-field="edge-bar.awareness-item"] .suggestion-body')
    const longTextUnclipped =
      title !== null &&
      body !== null &&
      getComputedStyle(title).whiteSpace !== 'nowrap' &&
      body.scrollHeight <= body.clientHeight + 1
    const ignore = document.querySelector('[data-field="edge-bar.awareness-item"] .suggestion-action.muted')
    if (ignore !== null) ignore.click()
    await wait(150)
    const remainingItems = count('[data-field="edge-bar.awareness-item"]')
    const single = count('[data-field="edge-bar.awareness"] .suggestion-title')
    return {
      toggle: true,
      collapsedItems,
      expandedItems,
      longTextUnclipped,
      remainingItems,
      single,
      pass:
        collapsedItems === 0 &&
        expandedItems === 2 &&
        longTextUnclipped &&
        remainingItems === 0 &&
        single === 1,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/** 切到 Work 并展开提示条：课堂"下一节"属于 ClassRoom 专属，不能在 Work 模式残留。 */
export const EDGE_BAR_WORK_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const switched = await window.aurora.mode.set('work')
    const el = document.querySelector('.edge')
    if (el !== null) {
      el.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false, pointerType: 'mouse' }))
    }
    await wait(350)
    return { ok: switched.ok }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`

export const EDGE_BAR_WORK_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const modes = await window.aurora.mode.list()
    const active = modes.ok ? modes.value.find((mode) => mode.active)?.id || '' : ''
    const labels = Array.from(document.querySelectorAll('.context-label')).map((node) =>
      (node.textContent || '').trim(),
    )
    const noNextLesson = labels.indexOf('下一节') === -1
    const restored = await window.aurora.mode.set('classroom')
    // 还原确认改成**有界轮询**（旧写法只 await wait(120) 就返回）。
    // 旧值 120ms 是"够本窗口重渲染"的猜测，而不是确认 —— 这个窗口的还原会广播
    // mode:changed，别的窗口（chat 被 hide / 后台时）什么时候重渲染完全不在它的保证里。
    // 新写法只负责"本窗口的还原动作确实生效"，并在返回值里写下等了多久
    //（restoreWaitedMs），供 chat-sidebar 的假 FAIL 排查区分
    //"还原没生效"与"别的窗口还没来得及重渲染"。真正的保证由各 chat 场景
    // 自带前置承担（见 CHAT_SIDEBAR_ENSURE_CLASSROOM_ACT），不依赖本场景。
    const startedAt = performance.now()
    let restoreConfirmed = false
    for (let attempt = 0; attempt < 12 && !restoreConfirmed; attempt += 1) {
      const list = await window.aurora.mode.list()
      restoreConfirmed = list.ok ? list.value.some((mode) => mode.active && mode.id === 'classroom') : false
      if (!restoreConfirmed) await wait(120)
    }
    await wait(150)
    const restoreWaitedMs = Math.round(performance.now() - startedAt)
    return {
      active,
      labels,
      noNextLesson,
      restored: restored.ok,
      restoreConfirmed,
      restoreWaitedMs,
      pass: active === 'work' && noNextLesson && restored.ok && restoreConfirmed,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 对话自动滚底探针（交互窗专用）。
 *
 * 钉住的是"新消息不会自动拉到最新"这个 bug：滚动容器是窗口的 `.thread`，
 * 内容变高时渲染层必须自己滚到底。这里不去驱动真实模型（截图跑在默认配置上，
 * 没有可用的 LLM），而是向 `.messages` 追加一个 1600px 的探针节点 ——
 * 对滚动逻辑而言与"新消息 / 流式增量把内容撑高"完全等价。
 *
 * 两个必须注意的点（都踩过）：
 * - 探针节点要 `flex-shrink: 0`：`.messages` 是 `.thread`（固定高）的 flex 子项，
 *   一个没有内容的空 div 会被压扁回窗口高度，探针就变成"没有可滚动内容"的空转断言。
 *   真实消息是有文字的，`min-height: auto` 不会让它被压掉，所以这里显式禁掉收缩。
 * - `pass` 里带 `maxScroll >= 200` 守卫：先确认"内容确实比窗口高"，再看"是否滚到了底"，
 *   否则一旦探针没撑开内容，`distance === 0` 会假 PASS。
 *
 * 2026-09-30（"跟丢"修复轮）把这条探针改成**可验证的三段**：
 * ① 追加内容 → 必须自动到底（跟随的默认行为，实测通过）；
 * ② 位置在离底处 + 派发**真实 `wheel`** → "↓ 回到最新"胶囊出现且落在可视区内
 *    （`position: sticky` 在"`.messages` 盒子被钉住、内容按溢出渲染"的布局里未必吸附得住）；
 * ③ 滚回底部（`scrollTop = max`）→ 胶囊消失（滞回的另一端）。
 *
 * 两条**已知缺口**（如实记下，别当成实现承诺 —— 2026-09-30 排查记录）：
 * 1. "只程序改 `scrollTop`、不派发输入事件时跟随不被关掉"**没有**断言：实测该场景下
 *    `following` 被关掉了，但 `onUserIntent`（`:root` 层的意图中转）从未被调用 ——
 *    而同时**捕获阶段**能确认 `wheel` 事件确实到达 `.thread`、`bindScroller` 也确实拿到了
 *    `.thread` 并挂了监听。即"意图回调没被触发、跟随却变了"这条矛盾尚未查清。
 * 2. 因为 ①，本探针末尾那一次 `wheel` 之后跟随仍处于暂停态（`restored` 为假），
 *    所以**跨场景状态**在 `chat-follow-burst` 之前可能是"暂停跟随"—— 那一条自带
 *    `scrollTop = scrollHeight` 与真实滚轮的收尾，独立可判，不受影响。
 * 在查清之前把 ① 写成断言只会得到一条长期 FAIL 的探针；持续跟进的防线由
 * `CHAT_FOLLOW_BURST_SCRIPT` 承担（它已实测能抓住"跟到一半就停"）。
 *
 * 放在 `check` 里（截图**之后**执行），所以不会出现在 PNG 中；执行完立刻移除节点、恢复跟随。
 */
export const CHAT_AUTO_SCROLL_SCRIPT = `(async () => {
  try {
    const thread = document.querySelector('.thread')
    const list = document.querySelector('.messages')
    if (thread === null || list === null) {
      return { pass: false, reason: 'no .thread/.messages' }
    }
    // 等两帧渲染（**有界**，2026-10-10）：窗口被隐藏时 Chromium 不派发 rAF，
    // 裸 requestAnimationFrame 的 promise 永不 settle → 整轮截图卡死且不写 report.json。
    // 配 120ms 兜底 + 页面不可见时走定时器快路径：可见时行为与原来一致。
    const frame = () =>
      document.hidden === true
        ? new Promise((resolve) => setTimeout(resolve, 32))
        : Promise.race([
            new Promise((resolve) => requestAnimationFrame(() => resolve())),
            new Promise((resolve) => setTimeout(resolve, 120)),
          ])
    const settle = async (count) => {
      for (let index = 0; index < count; index += 1) await frame()
    }
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const distanceToBottom = () =>
      Math.round(thread.scrollHeight - thread.scrollTop - thread.clientHeight)
    // 真实滚轮输入（程序改 scrollTop **不**产生它）—— 跟随状态只认这个
    const wheel = (deltaY) => {
      thread.dispatchEvent(new WheelEvent('wheel', { deltaY: deltaY, bubbles: true }))
    }

    const filler = document.createElement('div')
    filler.setAttribute('data-probe', 'auto-scroll')
    filler.style.height = '1600px'
    filler.style.flexShrink = '0'
    list.appendChild(filler)
    // 等吸底跟上：**有界轮询**，不是固定 150ms（2026-10-10 改）。
    //
    // 旧值 150ms → 新值"最多 1000ms、每 50ms 一轮"，依据与边界：
    // - 旧写法的隐含假设是"150ms 内一定跟上"，而吸底是渲染层的观察者 + 一帧对齐才落位，
    //   机器一忙（本机是虚拟显示适配器压低合成器帧率）就会晚于 150ms —— 实测失败态
    //   followed 恰好等于填充高度（1613），即吸底一次都没跟上，而**下一轮同一条探针
    //   又报 followed 1**，说明这是时序抖动而不是功能坏掉。
    // - 因此这里改成**等真实结果**（followed <= 4）而不是等时间；followed 仍取
    //   **等待结束后的最终读数**，pass 判据一字未改（仍要求 followed <= 4）。
    // - 为什么仍能抓住真回归：等待是**有界**的 —— 1000ms 到期就如实把
    //   followedAfterWait / timedOut 写进 payload 并判 FAIL。反向复核**不是**在探针里叠一段
    //   阻塞（那样证不出东西：阻塞期间定时器排队、阻塞一结束吸底已落位，旧读法也会绿），
    //   而是临时把产品里吸底调度的入口关掉（stickToBottomCore 的 schedule 直接 return）→
    //   followed 1966 / timedOut true / FAIL；该对照轮也证明"慢"不会被等成"对"
    //   （探针不派发任何输入事件，等待期间没有东西会替它把视口拨到底）。见 step-04 执行记录。
    let followed = 0
    let attempts = 0
    let timedOut = false
    for (; attempts < 20; attempts += 1) {
      followed = Math.round(thread.scrollHeight - thread.scrollTop - thread.clientHeight)
      if (followed <= 4) break
      await wait(50)
    }
    timedOut = followed > 4
    // 排障：填充前后各读一次读数与"跟随胶囊是否存在"（气泡在 = following 已被关掉）
    const jumpBeforeProgrammatic = list.querySelector('.jump-latest') !== null
    const maxScroll = Math.round(thread.scrollHeight - thread.clientHeight)
    const scrolled = Math.round(thread.scrollTop)
    const scrollHeight = Math.round(thread.scrollHeight)
    const clientHeight = thread.clientHeight

    // ② 位置在离底处 + 真实滚轮 → 用户接管：胶囊必须出现
    thread.scrollTop = 0
    wheel(-240)
    await settle(4)
    const jumpAfterScroll = list.querySelector('.jump-latest') !== null

    // ③ 真实滚轮 + 位置在离底处：胶囊必须出现且落在可视区内
    thread.scrollTop = 0
    wheel(-240)
    await wait(200)
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
    // ④ 收尾：**恢复跟随**，让后续场景拿到干净状态。
    //
    // 点击真实的"↓ 回到最新"胶囊（走 jumpToLatest → stick）而不是"再派发一次滚轮"：
    // 胶囊是应用自己的恢复入口，语义明确、不依赖意图回调（那条在本环境下不可靠，见头部注释）。
    // 这一步是必须的 —— 本探针在 ② 里把跟随关掉了，不收尾就会把后续场景
    //（实测：chat-follow-burst）整段留在"暂停跟随"里。
    thread.scrollTop = maxScroll
    const jumpButton = list.querySelector('.jump-latest')
    if (jumpButton !== null) jumpButton.click()
    else thread.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }))
    await wait(250)
    const restored =
      list.querySelector('.jump-latest') === null && distanceToBottom() <= 4

    filler.remove()
    thread.scrollTop = maxScroll
    return {
      pass: maxScroll >= 200 && followed <= 4 && jumpAfterScroll && jump.present && jump.inView && restored,
      scrollable: maxScroll >= 200,
      followed,
      // 轮询的见证：等了多久 / 等了几轮 / 是不是等到超时（超时即"吸底一次都没跟上"）
      awaitedMs: attempts * 50,
      attempts,
      timedOut,
      jumpAfterScroll,
      scrolled,
      maxScroll,
      scrollHeight,
      clientHeight,
      restored,
      jumpBeforeProgrammatic,
      jump,
    }
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

/**
 * 高密度流式的"自动跟随"探针（交互窗专用，2026-09-30 跟丢修复轮新增）。
 *
 * 与 `CHAT_AUTO_SCROLL_SCRIPT` 的分工：那条钉**语义**（谁能改跟随状态），这条钉**持续跟进**。
 * 按 6 帧每帧长高约 120px 持续追加内容 —— 正是真实流式下 markdown 块 / 工具行密集插入的形态：
 * 每帧都要看到"帧末已经到底"，且**不必等任何 `transitionend`**（旧实现只在过渡结束时补一次，
 * 高度增长期间一直落后）。`maxDistance` 同时给出"是不是真的撑高了内容"的旁证
 * （没撑开时 distance 恒为 0，也能拿到 0 分，所以另有 `grown` 字段供人工核对）。
 *
 * 收尾把探针节点移除并贴回底部，窗口恢复原状。
 */
export const CHAT_FOLLOW_BURST_SCRIPT = `(async () => {
  try {
    const thread = document.querySelector('.thread')
    const list = document.querySelector('.messages')
    if (thread === null || list === null) {
      return { pass: false, reason: 'no .thread/.messages' }
    }
    // 等两帧渲染（**有界**，2026-10-10）：窗口被隐藏时 Chromium 不派发 rAF，
    // 裸 requestAnimationFrame 的 promise 永不 settle → 整轮截图卡死且不写 report.json
    //（本轮实测：g-full-dark-1 在 chat.png 之后挂死 20 分钟、report.json 一张没写）。
    // 配 120ms 兜底 + 页面不可见时走定时器快路径：可见时行为与原来一致。
    const frame = () =>
      document.hidden === true
        ? new Promise((resolve) => setTimeout(resolve, 32))
        : Promise.race([
            new Promise((resolve) => requestAnimationFrame(() => resolve())),
            new Promise((resolve) => setTimeout(resolve, 120)),
          ])
    const distanceToBottom = () =>
      Math.round(thread.scrollHeight - thread.scrollTop - thread.clientHeight)

    // 前置：**先恢复跟随**。
    //
    // 这条探针要求"内容增长时每帧都跟到底"，只有**跟随态**才成立；而它前面那个
    // CHAT_AUTO_SCROLL_SCRIPT 会主动把跟随关掉（那正是它在测的语义）。本探针
    // 不能依赖别人有没有收尾干净 —— 点一次应用自己的"↓ 回到最新"胶囊（stick()），
    // 把状态归位再开始量（2026-09-30 实测：缺这一步时 samples 从第一帧起就落后）。
    thread.scrollTop = thread.scrollHeight
    const jumpButton = list.querySelector('.jump-latest')
    if (jumpButton !== null) jumpButton.click()
    await frame()
    await frame()

    const growth = document.createElement('div')
    growth.setAttribute('data-probe', 'follow-burst')
    growth.style.flexShrink = '0'
    list.appendChild(growth)

    const samples = []
    const trace = []
    for (let step = 0; step < 6; step += 1) {
      growth.style.height = String((step + 1) * 120) + 'px'
      await frame()
      await frame()
      const distance = distanceToBottom()
      samples.push(distance)
      trace.push({
        step: step,
        distance: distance,
        // 跟随被关掉时右下角会浮出"回到最新"胶囊：拿它当"跟丢"的现场证据
        paused: list.querySelector('.jump-latest') !== null,
        scrollTop: Math.round(thread.scrollTop),
        growthHeight: Math.round(growth.getBoundingClientRect().height),
        maxScroll: Math.round(thread.scrollHeight - thread.clientHeight),
      })
    }
    const maxDistance = samples.reduce((max, value) => Math.max(max, value), 0)
    const last = samples.length === 0 ? -1 : samples[samples.length - 1]
    const grown = Math.round(thread.scrollHeight)
    growth.remove()
    thread.scrollTop = thread.scrollHeight
    await frame()
    return {
      pass: samples.length === 6 && maxDistance <= 4 && last !== -1 && last <= 4,
      samples,
      maxDistance,
      grown,
      trace,
    }
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

/**
 * "视口贴在底部时上滚"探针（2026-10-01 用户实测：模型答完后**翻不动历史**）。
 *
 * 与 `CHAT_AUTO_SCROLL_SCRIPT` 的分工：那条把 `scrollTop` 先拨到 0 **再**发滚轮 ——
 * 意图判定那一刻离底已经很远，天然能判出"用户接管"；而真实用户是**从底部**开始滚的：
 * 输入事件到达主线程时，合成器线程通常还没把视口挪上去（`passive: true` 的 wheel 尤其如此），
 * 那一刻读数仍在底部，只看它就会判成"用户还在底部继续滚"，紧跟着浏览器派发的 `scroll`
 * 排出一帧对齐，把这一滚**原样抹回底部** —— 每一次滚轮都被吞，界面永远钉在底部。
 *
 * 因此本探针如实复刻这两拍（**这正是合成器滚动的时序**，不是人为制造的边角）：
 * ① 贴底 → 派发真实 `wheel`（此刻仍读到底部）；
 * ② 浏览器把视口挪上去 + 派发 `scroll`；
 * 判据：这一滚必须**留在用户滚到的位置**（没被对齐帧拽回）且"↓ 回到最新"胶囊出现。
 *
 * 收尾自带（摘掉探针节点 + 点应用自己的胶囊恢复跟随），不把状态留给后面的场景 ——
 * 本仓在这类"探针之间互相污染"上踩过（见 AGENTS.md 的排查教训）。
 */
export const CHAT_FOLLOW_WHEEL_UP_SCRIPT = `(async () => {
  try {
    const thread = document.querySelector('.thread')
    const list = document.querySelector('.messages')
    if (thread === null || list === null) {
      return { pass: false, reason: 'no .thread/.messages' }
    }
    // 等两帧渲染（**有界**，2026-10-10）：窗口被隐藏时 Chromium 不派发 rAF，
    // 裸 requestAnimationFrame 的 promise 永不 settle → 整轮截图卡死且不写 report.json。
    // 这里配 120ms 兜底 + 页面不可见时走定时器快路径：可见时行为与原来一致。
    const frame = () =>
      document.hidden === true
        ? new Promise((resolve) => setTimeout(resolve, 32))
        : Promise.race([
            new Promise((resolve) => requestAnimationFrame(() => resolve())),
            new Promise((resolve) => setTimeout(resolve, 120)),
          ])
    const settle = async (count) => {
      for (let index = 0; index < count; index += 1) await frame()
    }
    const distanceToBottom = () =>
      Math.round(thread.scrollHeight - thread.scrollTop - thread.clientHeight)

    // 前置：撑高内容 + 归位到跟随态（点应用自己的胶囊，不依赖别的场景收尾）
    const filler = document.createElement('div')
    filler.setAttribute('data-probe', 'wheel-up')
    filler.style.height = '1600px'
    filler.style.flexShrink = '0'
    list.appendChild(filler)
    thread.scrollTop = thread.scrollHeight
    const jumpButton = list.querySelector('.jump-latest')
    if (jumpButton !== null) jumpButton.click()
    await settle(4)

    const atBottomBefore = distanceToBottom()
    const maxScroll = Math.round(thread.scrollHeight - thread.clientHeight)

    // ① 真实滚轮：主线程收到输入时读数通常还在底部
    thread.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true }))
    const distanceAfterInput = distanceToBottom()

    // ② 浏览器把视口挪上去并派发 scroll（合成器滚动的可见结果）
    thread.scrollTop = maxScroll - 240
    thread.dispatchEvent(new Event('scroll'))
    await settle(4)

    const distanceAfter = distanceToBottom()
    const capsule = list.querySelector('.jump-latest') !== null

    // 收尾：摘掉探针节点，点胶囊恢复跟随
    filler.remove()
    const restoreButton = list.querySelector('.jump-latest')
    if (restoreButton !== null) restoreButton.click()
    else thread.scrollTop = thread.scrollHeight
    await settle(3)
    const restored = list.querySelector('.jump-latest') === null && distanceToBottom() <= 4

    return {
      pass: maxScroll >= 200 && atBottomBefore <= 4 && distanceAfter >= 200 && capsule && restored,
      atBottomBefore: atBottomBefore,
      distanceAfterInput: distanceAfterInput,
      distanceAfter: distanceAfter,
      capsule: capsule,
      maxScroll: maxScroll,
      restored: restored,
    }
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

/**
 * "展开轨迹后**真实滚轮**仍滚得动"探针 · 前半（2026-10-01，docs/07 §5.3"真实滚轮跟随"）。
 *
 * 既有 `CHAT_FOLLOW_WHEEL_UP_SCRIPT` 用 JS `dispatchEvent` 合成 wheel —— 它驱动得了**意图链路**
 * （监听器照收、判定照跑），却**绕过了原生滚轮管线**：合成事件不触发合成器滚动，
 * "贴底时程序把用户刚滚出去的视口吸回去"这一类失效（意图与对齐帧的竞速、吸底补齐的时机）
 * 全都发生在合成器与主线程之间，合成事件面前必然 PASS。
 *
 * 本场景分三段：本 act 造现场（跟随态 + 展开一条折叠轨迹 = `restick()` 结算帧在途 +
 * 探针填充块保证有得滚），把滚轮坐标与基线挂 window；主进程侧的 `chatTraceWheelMainAct`
 * 经 CDP `Input.dispatchMouseEvent`（type `mouseWheel`）发**真实滚轮**（走完整合成器管线）；
 * check 断言视口单调上移、离底超过阈值、"回到最新"胶囊出现，最后收尾还原。
 */
export const CHAT_TRACE_WHEEL_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const thread = document.querySelector('.thread')
    const list = document.querySelector('.messages')
    if (thread === null || list === null) return { ok: false, reason: 'no .thread/.messages' }
    // 前置：撑高内容 + 归位到跟随态（点应用自己的胶囊，不依赖别的场景收尾）
    const filler = document.createElement('div')
    filler.setAttribute('data-probe', 'trace-wheel')
    filler.style.height = '1200px'
    filler.style.flexShrink = '0'
    list.appendChild(filler)
    thread.scrollTop = thread.scrollHeight
    const jumpButton = list.querySelector('.jump-latest')
    if (jumpButton !== null) jumpButton.click()
    await wait(350)
    // 展开一条折叠的轨迹（复现 restick 结算帧在途的现场）；已展开就不动它（那会把它收起来）
    const trace = document.querySelector('.message.r-assistant .trace')
    if (trace !== null && trace.classList.contains('open') === false) {
      const head = trace.querySelector('.trace-head')
      if (head !== null) head.click()
      await wait(450)
    }
    // 滚轮坐标：**thread 内部**靠上的一点（旧实现取填充块矩形的中心 —— 贴底后填充块
    // 大部分在视口之上，中心算出来落在标题栏上，滚轮打在非滚动区，scrollTop 纹丝不动）。
    // thread 内任意点都安全：即便落在展开体的内滚区，overscroll 默认会链回 .thread。
    const threadRect = thread.getBoundingClientRect()
    const x = Math.max(1, Math.min(window.innerWidth - 2, Math.round(threadRect.left + threadRect.width / 2)))
    const y = Math.max(
      Math.round(threadRect.top + 80),
      Math.min(window.innerHeight - 2, Math.round(threadRect.top + threadRect.height * 0.5)),
    )
    window.__auroraTraceWheelProbe = {
      x: x,
      y: y,
      baseline: Math.round(thread.scrollTop),
      maxScroll: Math.round(thread.scrollHeight - thread.clientHeight),
      samples: [],
    }
    return { ok: true, x: x, y: y, baseline: window.__auroraTraceWheelProbe.baseline, maxScroll: window.__auroraTraceWheelProbe.maxScroll }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`

/**
 * 真实滚轮的**主进程侧**执行体：CDP `Input.dispatchMouseEvent` 发 14 步小幅上滚
 * （每步 `deltaY: -12`，位移小于跟随阈值 24px —— 触控板 / 高分辨率滚轮的真实步长），
 * 每步之间等 45ms（让合成器滚动与在途对齐帧真正竞速），逐次采样 `scrollTop`。
 *
 * 判据在渲染层 check 里做（含胶囊、轨迹保持展开、收尾还原）；这里只把采样结果
 * 挂回 window 并返回粗判（总位移 ≥ 48px）供 report 合并。
 */
async function chatTraceWheelMainAct(
  win: BrowserWindow,
): Promise<{ pass: boolean } & Record<string, unknown>> {
  const info = (await win.webContents.executeJavaScript(
    '(() => { const p = window.__auroraTraceWheelProbe; return p === undefined ? null : { x: p.x, y: p.y, baseline: p.baseline, maxScroll: p.maxScroll } })()',
    true,
  )) as { x: number; y: number; baseline: number; maxScroll: number } | null
  if (info === null) {
    return { pass: false, reason: 'CHAT_TRACE_WHEEL_ACT 未运行（缺 __auroraTraceWheelProbe）' }
  }
  if (info.maxScroll < 200) {
    return { pass: false, reason: '内容不足一屏，滚轮无处可滚', baseline: info.baseline }
  }
  const dbg = win.webContents.debugger
  try {
    dbg.attach('1.3')
  } catch {
    // 已附加（例如 devtools 开着）就直接复用，attach 抛错不阻断
  }
  const samples: number[] = []
  try {
    for (let step = 0; step < 14; step += 1) {
      await dbg.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: info.x,
        y: info.y,
        deltaX: 0,
        deltaY: -12,
      })
      await wait(45)
      const top = (await win.webContents.executeJavaScript(
        'Math.round(document.querySelector(".thread").scrollTop)',
        true,
      )) as number
      samples.push(top)
    }
  } finally {
    try {
      dbg.detach()
    } catch {
      // 未附加时 detach 会抛，忽略
    }
  }
  const finalTop =
    samples.length === 0 ? info.baseline : (samples[samples.length - 1] ?? info.baseline)
  const moved = info.baseline - finalTop
  await win.webContents.executeJavaScript(
    `(() => { const p = window.__auroraTraceWheelProbe; if (p !== undefined) p.main = { samples: ${JSON.stringify(samples)}, baseline: ${info.baseline} } })()`,
    true,
  )
  return {
    pass: moved >= 48,
    moved: moved,
    samples: samples,
    baseline: info.baseline,
    x: info.x,
    y: info.y,
  }
}

/**
 * 真实滚轮探针 · 后半：断言 + 收尾。
 *
 * ① **滚得动**：总位移 ≥ 48px（14 步 × 12px，若有一步被吸回去就到不了这个数）；
 * ② **单调**：逐次采样不出现"视口被按回去"（相邻两步容差 1px 亚像素）；
 * ③ **接管成立**：结束时离底 ≥ 24px（跟随已翻成接管）且"回到最新"胶囊在场；
 * ④ **轨迹保持展开**：展开态没被这次滚动意外收掉（`toggleTrace` 的互斥语义没被扰动）。
 * 收尾摘掉探针填充块并点胶囊恢复跟随，不把接管态留给后面的场景。
 */
export const CHAT_TRACE_WHEEL_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const probe = window.__auroraTraceWheelProbe
    if (probe === undefined || probe.main === undefined) {
      return { pass: false, reason: 'chatTraceWheelMainAct 未运行（缺 __auroraTraceWheelProbe.main）' }
    }
    const thread = document.querySelector('.thread')
    const list = document.querySelector('.messages')
    if (thread === null || list === null) return { pass: false, reason: 'no .thread/.messages' }
    const samples = probe.main.samples
    const baseline = probe.main.baseline
    const finalTop = samples.length === 0 ? baseline : samples[samples.length - 1]
    const moved = baseline - finalTop
    let monotonic = true
    for (let index = 1; index < samples.length; index += 1) {
      if (samples[index] > samples[index - 1] + 1) {
        monotonic = false
        break
      }
    }
    const distanceToBottom = Math.round(thread.scrollHeight - thread.scrollTop - thread.clientHeight)
    const capsule = list.querySelector('.jump-latest') !== null
    const trace = document.querySelector('.message.r-assistant .trace')
    const traceStillOpen = trace === null ? false : trace.classList.contains('open')
    // 收尾：摘掉探针节点，点胶囊恢复跟随
    const filler = list.querySelector('[data-probe="trace-wheel"]')
    if (filler !== null) filler.remove()
    const restoreButton = list.querySelector('.jump-latest')
    if (restoreButton !== null) restoreButton.click()
    else thread.scrollTop = thread.scrollHeight
    await wait(300)
    const restored = list.querySelector('.jump-latest') === null
    const conditions = {
      enoughScroll: probe.maxScroll >= 200,
      movedBeyondThreshold: moved >= 48,
      monotonic: monotonic,
      tookOver: distanceToBottom >= 24,
      capsule: capsule,
      traceStillOpen: traceStillOpen,
      restored: restored,
    }
    return {
      conditions: conditions,
      samples: samples,
      baseline: baseline,
      finalTop: finalTop,
      moved: moved,
      distanceToBottom: distanceToBottom,
      capsule: capsule,
      traceStillOpen: traceStillOpen,
      pass: Object.values(conditions).every((value) => value === true),
    }
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

/**
 * "收起 = 直接消失"探针（step-01）：点交互窗头部操作区的"收起"按钮，再断言窗口真的没了。
 *
 * 这一条钉住的是一个已修掉的 bug：原来的"收起"会**另外弹出一个快速对话窗口**
 * （`close()` 里调的是那条已被删除的"显示快速对话"IPC 通道），用户按"收起"却看到多出一个窗口。
 * 现在它必须等价于 `windowStore.hide('chat')`。
 *
 * ⚠️ 为什么**点击写在 check 里、而不是 `act` 里**（与 step-01 原计划不同，实测后改的）：
 * `act` 在截图**之前**跑（见 `captureWindows` 的顺序 show → act → wait → capturePage）。
 * 窗口一旦被真的 `hide()`，紧接着的 `capturePage()` 在 Windows 上**永不返回**——表现为
 * 整个 `AURORA_CAPTURE` 流程卡死、进程不退出、`report.json` 写不出来（实测 8 分钟无进展，已复现）。
 * 所以截图必须发生在窗口仍然可见的时候；而"点完之后窗口是否真的消失"由这条 check 断言，
 * 它跑在截图之后，点击与断言的因果链仍然是真实的（按钮 → Vue handler → IPC → 主进程 hide）。
 * 因此 `chat-collapse.png` 拍到的是**点之前的交互窗**（含那颗"收起"按钮），
 * "收起后窗口消失"这件事由本探针的 `pass` 负责，不靠截图。
 *
 * 按 `data-caption-btn="close"` 找按钮（Windows 式窗口按钮，2026-09 重构起取代旧"收起"文字钮；
 * 语义同为隐藏窗口）。找不到时把头部实际按钮清单回传（而不是静默成功），
 * 否则改了锚点会让这条断言变成空转。
 *
 * `primary === null` 是关键：残留的 `primary` 说明"隐藏"被实现成了"换成另一个主窗口"。
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
 * 状态卡只在"模式 = classroom **且** 课表来源 = classisland"时渲染，出厂配置下
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
 * - `auto-` 会话文件：给历史探针的"Agent 记录回放"供真实对话（`chat:history` 惰性读盘）。
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
      // 调用次数（v0.2.8，docs/13 §3.1）：夹具带一段"还没用满"的计数，卡片应显示 3/10 徽章
      maxRuns: 10,
      runCount: 3,
      createdAt: new Date(now - 86_400_000).toISOString(),
      updatedAt: new Date(now - 86_400_000).toISOString(),
    },
    {
      id: 'am-capture2',
      name: '每周整理（已用尽）',
      enabled: false,
      mode: 'normal',
      trigger: { kind: 'daily', params: { at: '20:00', weekdays: [] } },
      actions: [{ kind: 'open-folder', params: { target: 'path', path: 'C:\\' } }],
      // 已用尽：引擎会把它自动停用（enabled=false + 计数到顶），徽章应转警示色
      maxRuns: 5,
      runCount: 5,
      createdAt: new Date(now - 86_400_000).toISOString(),
      updatedAt: new Date(now - 3_600_000).toISOString(),
    },
  ]
  const runs: AutomationRun[] = [
    {
      id: 'auto-capture-normal',
      automationId: 'am-capture1',
      automationName: '早读提醒',
      mode: 'normal',
      status: 'success',
      triggeredAt: new Date(now - 3_600_000).toISOString(),
      finishedAt: new Date(now - 3_600_000 + 120).toISOString(),
      durationMs: 120,
      triggerDetail: '手动触发',
      steps: [
        {
          kind: 'system-notify',
          label: '系统通知',
          ok: true,
          summary: '已发出通知「早读提醒」',
        },
        {
          kind: 'open-folder',
          label: '打开文件夹',
          ok: false,
          error: '科目「语文」未映射文件夹',
        },
      ],
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
      toolCallCount: 1,
      summary: '已确认明早有课，提醒已发出',
    },
  ]
  /**
   * 追加多天 / 多条 Agent 记录（2026-10-17）：**刻意不带 `sessionId`**（这些行不可展开，
   * 「点开第一条可回放的记录」仍命中上面种下的那条）。
   *
   * 目的只有一个：让列表真的能滚起来。分组标题吸顶时的表现（底色透不透、上沿留不留缝）
   * 只有滚起来才看得见、量得到 —— 此前种 2 条记录、1 个分组，截图与探针都覆盖不到那条路径，
   * 于是「标题压住滚过去的行 → 时间标识叠字」一路漏到了用户手上。
   */
  for (let index = 0; index < 16; index += 1) {
    const at = new Date(now - (Math.floor(index / 6) + 1) * 86_400_000)
    at.setHours(9 + (index % 6), (index * 7) % 60, 0, 0)
    const failed = index % 5 === 4
    runs.push({
      id: `auto-capture-filler-${index + 1}`,
      automationId: 'am-capture1',
      automationName: '早读提醒',
      mode: 'agent',
      status: failed ? 'failed' : 'success',
      triggeredAt: at.toISOString(),
      finishedAt: new Date(at.getTime() + 4200).toISOString(),
      durationMs: 4200 + index * 130,
      triggerDetail: '定时触发',
      toolCallCount: (index % 4) + 1,
      summary: `第 ${index + 1} 条历史记录的结论摘要（capture 夹具）`,
      ...(failed ? { error: '模型调用超时（capture 夹具）' } : {}),
    })
  }
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
        requestId: 'capture-auto-req',
      },
      {
        id: 'capture-auto-a1',
        role: 'assistant',
        content: 'capture-automation-run：这是自动化会话里 Agent 的回复，历史回放应显示本条。',
        createdAt: new Date(now - 1_799_500).toISOString(),
        requestId: 'capture-auto-req',
        reasoning: 'capture-automation-run：这段思考应折叠在执行轨迹里。',
        toolCalls: [
          {
            id: 'capture-auto-call-1',
            name: 'read_file',
            arguments: '{"path":"C:/capture/早读.txt"}',
            state: 'success',
            outputSummary: 'capture-automation-run：工具结果摘要',
            startedAt: new Date(now - 1_799_800).toISOString(),
            endedAt: new Date(now - 1_799_600).toISOString(),
          },
        ],
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
 * 把课表来源切到"ClassIsland 联动 + 文件模式 + 夹具路径"，让课堂状态卡出现。
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
 * 记忆库截图夹具：写一份真实笔记与 `file-awareness/state.json`。
 *
 * FileAwarenessService 在 bootstrap 阶段已读过一次状态，调用方写完后需再 `init()` 一次
 * 才会让运行中的实例读到这份夹具；这不是产品路径，只服务 `AURORA_CAPTURE`。
 */
export async function seedMemoryFixture(userData: string): Promise<void> {
  const now = new Date().toISOString()
  const pptxNoteId = 'memory-capture-pptx'
  const docxNoteId = 'memory-capture-docx'
  const pptxNotePath = join(
    userData,
    'memory-fixture',
    'pptx',
    '2026-10-04',
    '电路课程笔记--memory-capture-pptx.md',
  )
  const docxNotePath = join(
    userData,
    'memory-fixture',
    'docx',
    '2026-10-03',
    '数学复习笔记--memory-capture-docx.md',
  )
  await mkdir(join(pptxNotePath, '..'), { recursive: true })
  await mkdir(join(docxNotePath, '..'), { recursive: true })
  await writeFile(
    pptxNotePath,
    [
      '# 电路课程笔记',
      '',
      '## 摘要',
      '',
      '这份讲义涵盖欧姆定律、串联电路与并联电路。',
      '',
      '## 关键信息',
      '',
      '- 电压、电流与电阻的关系',
      '- 电路图中的电源与负载标注',
      '',
      '## 代码示例',
      '',
      '```ts',
      'const voltage = current * resistance',
      '```',
      '',
    ].join('\n'),
    'utf8',
  )
  await writeFile(
    docxNotePath,
    ['# 数学复习笔记', '', '## 摘要', '', '这份文档整理了二次函数与一元二次方程。', ''].join('\n'),
    'utf8',
  )
  await mkdir(join(userData, 'file-awareness'), { recursive: true })
  await writeFile(
    join(userData, 'file-awareness', 'state.json'),
    JSON.stringify(
      {
        version: 3,
        notes: {
          [pptxNoteId]: {
            id: pptxNoteId,
            title: '电路课程笔记',
            sourcePath: 'D:\\感知\\电路课程.pptx',
            sourceHash: 'memory-capture-hash',
            sizeBytes: 1024,
            mtimeMs: Date.now(),
            ext: 'pptx',
            notePath: pptxNotePath,
            createdAt: now,
            updatedAt: now,
            sourceAvailable: true,
            conflict: false,
            usageCount: 3,
            summary: '涵盖欧姆定律与电路图的课程笔记。',
            tags: ['物理', '电路'],
            relatedNoteIds: [],
            expiry: { mode: 'inherit' },
          },
          [docxNoteId]: {
            id: docxNoteId,
            title: '数学复习笔记',
            sourcePath: 'D:\\感知\\数学复习.docx',
            sourceHash: 'memory-capture-docx-hash',
            sizeBytes: 2048,
            mtimeMs: Date.now() - 86_400_000,
            ext: 'docx',
            notePath: docxNotePath,
            createdAt: '2026-10-03T08:00:00.000Z',
            updatedAt: '2026-10-03T08:00:00.000Z',
            sourceAvailable: true,
            conflict: false,
            usageCount: 1,
            summary: '二次函数与一元二次方程的复习笔记。',
            tags: ['数学'],
            relatedNoteIds: [],
            expiry: {
              mode: 'at',
              at: '2020-01-01T00:00:00.000Z',
            },
          },
        },
        queue: [
          {
            id: 'memory-capture-queued',
            sourcePath: 'D:\\感知\\待分析课程.pdf',
            ext: 'pdf',
            kind: 'add',
            sizeBytes: 4096,
            mtimeMs: Date.now(),
            enqueuedAt: now,
          },
        ],
        records: Array.from({ length: 7 }, (_, index) => ({
          id: `memory-capture-record-${index + 1}`,
          sourcePath: `D:\\感知\\记录-${index + 1}.${index % 2 === 0 ? 'pptx' : 'docx'}`,
          fileName: `记录-${index + 1}.${index % 2 === 0 ? 'pptx' : 'docx'}`,
          ext: index % 2 === 0 ? 'pptx' : 'docx',
          kind: 'change',
          status: 'done',
          occurredAt: new Date(Date.now() - index * 3_600_000).toISOString(),
          sourceAvailable: true,
          summary: `第 ${index + 1} 条文件自感知记录。`,
        })),
        recent: [],
        suggestions: [
          {
            id: 'memory-capture-suggestion-1',
            noteId: pptxNoteId,
            sourcePath: 'D:\\感知\\电路课程.pptx',
            sourceHash: 'memory-capture-hash',
            headline: '电路笔记可补充公式',
            body: '建议把欧姆定律整理成复习卡片。',
            createdAt: now,
            confidence: 0.9,
            action: { label: '整理卡片', prompt: '请整理电路课程笔记中的公式。' },
          },
          {
            id: 'memory-capture-suggestion-2',
            noteId: docxNoteId,
            sourcePath: 'D:\\感知\\数学复习.docx',
            sourceHash: 'memory-capture-docx-hash',
            headline: '数学复习可生成练习',
            body: '二次函数缺少对应例题。',
            createdAt: now,
            confidence: 0.85,
          },
        ],
        ignoredSuggestionIds: [],
        dayKey: '2026-10-04',
        todayAnalyzed: 1,
        queueOverflow: 0,
        usage: {
          promptTokens: 1200,
          completionTokens: 260,
          totalTokens: 1460,
          cachedTokens: 400,
          rounds: 3,
        },
        usageBackfilled: true,
        recentDirectoryMtimeMs: 0,
      },
      null,
      2,
    ),
    'utf8',
  )
}

/**
 * 设置页"会话管理"的项目区组探针（v13 项目机制，2026-09-30 自右栏迁入设置页）。
 *
 * 必须走 `settings:update` IPC：`SettingsStore.init()` 启动即把 config.json 读进内存并长期缓存，
 * 启动后写文件对运行中的进程无效。`projects` 是顶层浅合并，但 `list` 是数组整体权威 ——
 * 所以这里显式给出**完整**的 projects 子树（其余键从当前配置展开，不动 `maxAgentsBytes`）。
 *
 * ACT 把"当前项目"指向真实临时目录并等渲染层重算；两个 `projects.*` 锚点
 * （`projects.name` / `projects.root`）随项目管理整组迁到 `?page=sessions`，
 * 本场景的 query 已钉住那个页面。
 */
export function settingsProjectAct(root: string, name: string): string {
  return `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const state = await window.aurora.settings.get()
    if (!state.ok) return { ok: false, reason: state.message }
    if (!state.value.projects.list.some((item) => item.id === 'capture')) {
      const result = await window.aurora.settings.update({
        projects: {
          ...state.value.projects,
          list: [{ id: 'capture', name: ${JSON.stringify(name)}, root: ${JSON.stringify(root)} }],
        },
      })
      if (!result.ok) return { ok: false, reason: result.message }
      // 等渲染层 store 收到 settings:changed 广播后重算项目行
      await wait(400)
    }
    let rowShown = false
    for (let attempt = 0; attempt < 15 && !rowShown; attempt += 1) {
      rowShown = document.querySelector('[data-field="projects.root"]') !== null
      if (!rowShown) await wait(200)
    }
    return { ok: true, rowShown }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`
}

/**
 * 右栏"当前项目"卡探针（v13，docs/06 §5.1）：卡恰好一张、文本含项目名与根目录、
 * **不是**"项目目录不可用"警示态；收尾还原成无项目并把 restored 并入 pass。
 */
/**
 * 项目区组探针 · 后半（设置页版，假设 7 的现场）：项目行渲染出项目名与根路径、
 * **不是**警示态；随后把根改成一个**不存在**的目录，断言警示文案真的出现
 * （只在日志里 warn 而界面没提示，用户会以为 AGENTS.md 生效了却什么都没发生）。
 * 判据：项目区组文案里出现"项目目录不可用"。收尾还原成无项目。
 */
export function settingsProjectCheck(name: string, missingRoot: string): string {
  return `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const text = (selector) => {
      const el = document.querySelector(selector)
      return el === null ? '' : (el.textContent || '').replace(/\\s+/g, ' ').trim()
    }
    const pageText = text('.sessions-page')
    // ⚠️ 项目名与根路径渲染在 <input :value> 里，**不在 textContent 中** ——
    // 旧右栏卡用的是 <p> 文本节点，抄那套 textContent 断言会恒假（首跑实测）。
    const fieldValue = (selector) => {
      const input = document.querySelector(selector + ' input')
      return input === null ? '' : input.value || ''
    }
    const nameValue = fieldValue('[data-field="projects.name"]')
    const rootValue = fieldValue('[data-field="projects.root"]')
    const result = {
      nameField: count('[data-field="projects.name"]'),
      rootField: count('[data-field="projects.root"]'),
      addButton: count('[data-field="projects.add"]'),
      nameValue,
      rootValueLen: rootValue.length,
      pageText: pageText.slice(0, 200),
      pass:
        count('[data-field="projects.name"]') === 1 &&
        count('[data-field="projects.root"]') === 1 &&
        count('[data-field="projects.add"]') === 1 &&
        nameValue === ${JSON.stringify(name)} &&
        rootValue.indexOf('capture-project') !== -1 &&
        // prepare 已建出真实目录：这里必须是健康态，警示文案一个都不该有
        pageText.indexOf('项目目录不可用') === -1,
    }

    // 第二阶段（假设 7）：把项目根改成一个**不存在**的目录，断言警示文案出现
    const before = await window.aurora.settings.get()
    if (before.ok && before.value.projects.list.some((item) => item.id === 'capture')) {
      await window.aurora.settings.update({
        projects: {
          ...before.value.projects,
          list: [{ id: 'capture', name: ${JSON.stringify(name)}, root: ${JSON.stringify(missingRoot)} }],
        },
      })
      let warned = false
      for (let attempt = 0; attempt < 15 && !warned; attempt += 1) {
        warned = text('.sessions-page').indexOf('项目目录不可用') !== -1
        if (!warned) await wait(200)
      }
      result.warningShown = warned
      result.pass = result.pass === true && warned === true
    } else {
      result.warningShown = null
      result.pass = false
    }

    // 收尾：还原成无项目，后续场景读到的仍是出厂门控
    const state = await window.aurora.settings.get()
    if (state.ok) {
      await window.aurora.settings.update({
        projects: { ...state.value.projects, list: [] },
      })
    }
    await wait(250)
    result.restored = count('[data-field="projects.name"]') === 0
    result.pass = result.pass === true && result.restored === true
    return result
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`
}

/**
 * "会话管理"页的**会话列表**探针（2026-09-30 新增）：列表渲染 + 归档往返 + 删除两步确认。
 *
 * 现场：seed 的 main 会话（Agent 空间）+ `chat-seed-archived`（已归档）—— 隔离 userData 里
 * 至少两行，`sessions.row` 数 ≥ 2 顺带验证"归档会话照常列出、只是归到已归档组"。
 *
 * ACT 做一次完整的可逆往返（归档 → 取消归档）与一次**只到第一步**的删除
 * （点"删除"后断言出现"确认删除"而没有真的删）：真删会毁掉后续场景依赖的 seed 现场，
 * 因此删除的**执行**只断言到确认态为止（真正删文件的那条路径由 store 单测覆盖）。
 */
export const SETTINGS_SESSIONS_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const rowsNow = () => document.querySelectorAll('[data-field="sessions.row"]').length
    const rows = () => Array.from(document.querySelectorAll('[data-field="sessions.row"]'))
    // 选一行**未归档**的（归档钮文案为"归档"）：不依赖 seed 标题文本，
    // 探针与夹具的文案解耦（标题随首条用户消息变，钉标题是最脆的一种写法）
    const activeRow = () =>
      rows().find((row) => {
        const button = row.querySelector('[data-field="sessions.archive"]')
        return button !== null && (button.textContent || '').trim() === '归档'
      }) || null
    const clickIn = (row, selector) => {
      if (row === null) return false
      const button = row.querySelector(selector)
      if (button !== null) button.click()
      return button !== null
    }
    const rowsBefore = rowsNow()
    const titleOf = (row) => {
      const el = row.querySelector('.session-title')
      return el === null ? '' : (el.textContent || '').trim()
    }
    // ⚠️ 按**标题**而不是下标找行：归档后该行会移进"已归档"组（分组重排），
    // 下标会指向另一行（首跑实测 archivedNow=false 的成因）。
    const findByTitle = (value) =>
      rows().find((row) => titleOf(row) === value) || null

    // ① 归档往返：点"归档"后该行应带"取消归档"（同一次重拉列表后）
    const targetBefore = activeRow()
    const targetTitle = targetBefore === null ? null : titleOf(targetBefore)
    const archiveClicked = clickIn(targetBefore, '[data-field="sessions.archive"]')
    await wait(700)
    const afterArchive = targetTitle === null ? null : findByTitle(targetTitle)
    const archivedNow =
      afterArchive !== null && (afterArchive.textContent || '').indexOf('取消归档') !== -1
    if (archivedNow === true) clickIn(afterArchive, '[data-field="sessions.archive"]')
    await wait(700)
    const afterRestore = targetTitle === null ? null : findByTitle(targetTitle)
    const unarchivedNow =
      afterRestore !== null && (afterRestore.textContent || '').indexOf('取消归档') === -1

    // ② 删除两步确认：第一次点只翻状态（出现"确认删除"，行数不变、没有真删）
    const deleteClicked = clickIn(afterRestore, '[data-field="sessions.delete"]')
    await wait(350)
    const confirmShown = Array.from(
      document.querySelectorAll('[data-field="sessions.delete"]'),
    ).some((button) => (button.textContent || '').trim() === '确认删除')
    const rowsAfterDeleteStep = rowsNow()
    window.__auroraSessionsListProbe = {
      rowsBefore,
      targetTitle,
      archiveClicked,
      archivedNow,
      unarchivedNow,
      deleteClicked,
      confirmShown,
      rowsAfterDeleteStep,
    }
    return window.__auroraSessionsListProbe
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`

export const SETTINGS_SESSIONS_CHECK = `(() => {
  try {
    const probe = window.__auroraSessionsListProbe
    if (probe === undefined) return { pass: false, reason: 'no act probe' }
    return {
      ...probe,
      pass:
        probe.rowsBefore >= 2 &&
        probe.archiveClicked === true &&
        probe.archivedNow === true &&
        probe.unarchivedNow === true &&
        probe.deleteClicked === true &&
        probe.confirmShown === true &&
        probe.rowsAfterDeleteStep === probe.rowsBefore,
    }
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

/**
 * "文件备份"卡移出主界面的探针（2026-09 UI 收拢，回滚 UI 迁设置页 Agent 页）。
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
 * 设置页"文件备份"列表探针（2026-09，回滚 UI 自主界面右栏迁入 Agent 页）。
 *
 * `prepare` 已种好一份真实快照（见 `seedSnapshotFixture`），这里断言：
 * 列表在、至少一条记录、条目的文件名与来源都渲染出来了，并且点一次"回滚"只停在
 * "确认回滚？"（**两段式**）—— 截图正好拍到这个中间态；同时确认"刷新 / 立即清理"
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
        // 清理 / 刷新两个操作入口都得在（清理走两段式，按钮文案此刻仍是"立即清理"）
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
 * 直接写文件（而不是走进程内的 `JobStore.create`）：这里要造的是"**上一次启动留下的** paused job"，
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
    budget: { usedTokens: 1284 },
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
 * "任务"面板探针（v15，docs/06 §4.1）：**只读**断言 —— 面板在、状态是"已暂停"、
 * 暂停原因、步骤痕迹与"继续"按钮都渲染出来了。**不点任何按钮**：点"继续"会真的发起续跑，
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
        // 暂停原因必须说清"停在哪"，而不是一句含糊的"未完成"
        text.indexOf('轮次上限') !== -1 &&
        // 面板的价值是"看得见进度"：步骤痕迹与 token 用量都要在
        text.indexOf('read_file') !== -1 &&
        text.indexOf('token') !== -1 &&
        resume !== null,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 右栏功能 tab 场景（2026-10-03，docs/07 §2.3；同日二次修订为多标签）。
 *
 * act 顺序刻意是"先终端、后文件、**停在文件 tab 不再切走**"：
 * - 文件预览的越界拒绝现场要留在截图里（输入框里的路径 + 红色错误文案）——
 *   切走再切回会让 `FilePreviewPanel` 的输入框与错误文案随历史栈复位（第一版就踩了
 *   这个：切回 files 之后截图里输入框是空的、errorText 也是空串）；
 * - 终端只是**初始化**（等 `.xterm` 挂上即返回，PTY 输出是异步的，不等 banner）；
 *   切标签往返存活的断言在 check 里做。
 *
 * 切标签一律直接点 `chat.ctx-tab-<id>` 锚点（**折叠时锚点在 ＋N 菜单里，仍是可点的
 * 元素** —— `.click()` 与可见性无关）；标签条自身的折叠 / 菜单交互由 `chat-ctx-tabs`
 * 场景用真实 UI 覆盖，两者分工见那条的场景注释。
 *
 * 越界路径选 `C:\\Windows\\win.ini`：越界判定发生在 stat **之前**，因此路径是否存在
 * 无关（离线可跑），也**不写任何用户目录** —— Agent 空间会话的边界根是真实桌面，
 * 不该被截屏流程污染。成功路径（真实读盘 / 截断 / 二进制探测 / 目录与缺失文件报错）
 * 已由 `file-preview.test.ts` 用真实临时目录覆盖。
 */
export const CHAT_RIGHT_TABS_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const clickTab = (id) => {
      const el = document.querySelector('[data-field="chat.ctx-tab-' + id + '"]')
      if (el === null) return false
      el.click()
      return true
    }
    // 终端 tab：等 xterm 的根节点挂上（面板**首次激活挂载**，之后常驻）
    clickTab('terminal')
    let xterm = false
    for (let attempt = 0; attempt < 40 && !xterm; attempt += 1) {
      xterm = document.querySelector('[data-field="chat.terminal-host"] .xterm') !== null
      if (!xterm) await wait(150)
    }
    await wait(600)
    // 文件 tab：输入越界路径并点预览，等错误文案出现；**停在这里截图**
    const filesOk = clickTab('files')
    await wait(300)
    const input = document.querySelector('.fp-input')
    let typed = false
    if (input !== null) {
      input.value = ${JSON.stringify('C:\\Windows\\win.ini')}
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(150)
      const go = document.querySelector('.fp-go')
      if (go !== null) {
        go.click()
        typed = true
      }
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (document.querySelector('[data-field="chat.file-preview-error"]') !== null) break
        await wait(150)
      }
    }
    return { ready: true, filesOk, typed, xterm }
  } catch (error) {
    return { ready: false, reason: String(error) }
  }
})()`

/**
 * 右栏功能 tab 探针（2026-10-03，docs/07 §2.3）。
 *
 * 断言五件事：
 * ① tab 条（4 个锚点）与拖拽把手（`chat.ctx-resizer`）都在，右栏宽度落在
 *    280–560px（`--ctx-w` 变量真的驱动了布局，而不是内联宽度写死）；
 * ② 越界文案含"边界"（安全拒绝在渲染层链路可见，act 留下的现场）；
 * ③ tab 互斥：切到 files 时 `chat.jobs`（上下文 tab 的 DOM）不在，切回 context 时恢复 ——
 *    "旧探针零改动兼容"正依赖这条：上下文 tab 的 DOM 结构逐字保留；
 * ④ 终端 `xterm` 跨标签往返存活（面板首次激活挂载、之后常驻，切走只是 `display:none`）：
 *    切走再切回后 `.xterm` 仍在、行文本长度不减少（缓冲没有丢）；
 * ⑤ 浏览器 tab 面板出现（webview 不等待网络加载 —— 离线可跑）。
 */
export const CHAT_RIGHT_TABS_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const has = (selector) => document.querySelector(selector) !== null
    const clickTab = (id) => {
      const el = document.querySelector('[data-field="chat.ctx-tab-' + id + '"]')
      if (el === null) return false
      el.click()
      return true
    }
    const rowText = () => {
      const rows = document.querySelector('[data-field="chat.terminal-host"] .xterm-rows')
      return rows === null ? '' : (rows.textContent || '').trim()
    }
    const tabsPresent = ['files', 'terminal', 'browser', 'context'].every((id) =>
      has('[data-field="chat.ctx-tab-' + id + '"]'),
    )
    const resizer = has('[data-field="chat.ctx-resizer"]')
    const aside = document.querySelector('aside.context')
    const asideWidth = aside === null ? 0 : aside.getBoundingClientRect().width
    // 左栏调宽（2026-10-03）：把手在 + 宽度真的由 --nav-w 驱动（内联变量与实测宽度一致）
    const navEl = document.querySelector('aside.nav')
    const navResizer = has('[data-field="chat.nav-resizer"]')
    const navWidth = navEl === null ? 0 : navEl.getBoundingClientRect().width
    const navInlineVar = navEl === null ? '' : navEl.style.getPropertyValue('--nav-w') || ''
    const navResizerOk =
      navResizer && navInlineVar !== '' && Math.abs(Number.parseFloat(navInlineVar) - navWidth) < 2
    // 诊断字段（不进 pass）：宽度记忆的持久值 + 布局链路的三个读数 ——
    // "右栏莫名变窄"时要能一眼看出是 localStorage 残值、变量没生效，还是被 grid 压缩
    let storedWidth = null
    try {
      storedWidth = window.localStorage.getItem('aurora.chat.ctxWidth')
    } catch {
      storedWidth = 'unavailable'
    }
    const inlineWidthVar = aside === null ? '' : (aside.style.getPropertyValue('--ctx-w') || '')
    const shellWidth =
      document.querySelector('.app-shell')?.getBoundingClientRect().width ?? 0
    const asideMinWidth = aside === null ? '' : getComputedStyle(aside).minWidth
    // 现场（act 停在 files）：越界拒绝的文案
    const errorEl = document.querySelector('[data-field="chat.file-preview-error"]')
    const errorText = errorEl === null ? '' : (errorEl.textContent || '').trim()
    const filePanelOn = has('[data-field="chat.file-preview"]')
    const jobsHiddenOnFiles = !has('[data-field="chat.jobs"]')
    // 文件管理器（2026-10-03）：目录条（根标签 + 相对路径）恒在 ——
    // 列表容器只在列表视图里（act 停在**预览态**：越界拒绝的现场就是预览视图的错误行），
    // 所以先点"返回"切回列表再断言容器与条目。条目内容取决于会话边界根，这里不追究具体文件
    // （项目现场的断言见 chat-file-project）。
    const fileDirBar = has('[data-field="chat.file-root"]')
    let fileListBack = false
    // 预览态点"返回列表"（锚点 chat.file-exit）：**不是**工具条上的历史"后退"——
    // 这次预览是越界拒绝（没有成功导航），历史里没有可退的一步，退出按钮必须能兜底。
    if (has('[data-field="chat.file-exit"]')) {
      const exit = document.querySelector('[data-field="chat.file-exit"]')
      if (exit !== null) exit.click()
      await wait(250)
      fileListBack = has('[data-field="chat.file-list"]')
    } else {
      fileListBack = has('[data-field="chat.file-list"]')
    }
    // 布局护栏（2026-10-03 用户实测）：右栏内容不得横向撑破 —— 撑破时工具条按钮会被
    // 推到 aside 可视区之外（DOM 在、探针绿、用户看不见）。这里量两个事实：
    // aside 的 scrollWidth 不超 clientWidth，且四枚工具条按钮的矩形落在 aside 矩形内。
    const asideEl = document.querySelector('aside.context')
    const asideOverflowX = asideEl === null ? -1 : asideEl.scrollWidth - asideEl.clientWidth
    // 矩形每次现取（下面还有"拖到上限再量一次"的用法）
    const toolbarInView = () => {
      const panel = document.querySelector('aside.context')
      if (panel === null) return false
      const panelRect = panel.getBoundingClientRect()
      return [
        '[data-field="chat.file-back"]',
        '[data-field="chat.file-forward"]',
        '[data-field="chat.file-up"]',
        '[data-field="chat.file-refresh"]',
      ].every((selector) => {
        const el = document.querySelector(selector)
        if (el === null) return false
        const r = el.getBoundingClientRect()
        return (
          r.width > 0 &&
          r.height > 0 &&
          r.left >= panelRect.left - 1 &&
          r.right <= panelRect.right + 1
        )
      })
    }
    const fileToolbarInView = toolbarInView()

    // 终端标签：切过去读行文本（act 已初始化过，常驻面板应直接可见）
    clickTab('terminal')
    await wait(300)
    const terminalOn = has('[data-field="chat.terminal"]')
    const xtermOn = has('[data-field="chat.terminal-host"] .xterm')
    const textBefore = rowText()
    // 终端黑底（2026-10-03 用户口径）：容器必须是纯黑 —— 此前跟随 prefers-color-scheme，
    // 浅色系统下拿到白底，这条把口径钉死在"黑"。xterm 自己的元素底色是**透明**的
    // （它把 theme.background 画进 canvas，CSS 链上看是透明），所以断言的是
    // "容器纯黑 + viewport 不引入别的颜色"：有效底色 = 容器色，就是黑。
    const hostEl = document.querySelector('[data-field="chat.terminal-host"]')
    const xtermEl = document.querySelector('[data-field="chat.terminal-host"] .xterm')
    const viewportEl = document.querySelector('[data-field="chat.terminal-host"] .xterm-viewport')
    const hostBg = hostEl === null ? '' : getComputedStyle(hostEl).backgroundColor
    const xtermBg = xtermEl === null ? '' : getComputedStyle(xtermEl).backgroundColor
    const viewportBg = viewportEl === null ? '' : getComputedStyle(viewportEl).backgroundColor
    const terminalBgOk =
      hostBg === 'rgb(0, 0, 0)' &&
      (viewportBg === '' || viewportBg === 'rgba(0, 0, 0, 0)' || viewportBg === 'rgb(0, 0, 0)')

    // 切走再切回：xterm 必须仍在、缓冲不丢
    clickTab('files')
    await wait(250)
    clickTab('terminal')
    await wait(300)
    const xtermBack = has('[data-field="chat.terminal-host"] .xterm')
    const textAfter = rowText()

    // 浏览器 tab：只断言面板出现（webview 加载不等待）
    clickTab('browser')
    await wait(300)
    const browserOn = has('[data-field="chat.browser"]')

    // 上下文 tab：旧 DOM（任务面板 + 模式感知卡）恢复
    clickTab('context')
    await wait(300)
    const contextOn = has('[data-field="chat.jobs"]') && has('.ctx-inner')

    // 侧栏拖拽调宽（2026-10-03）：**拖一次真的改宽度**才算数 ——
    // "把手在 + 变量驱动布局"推不出拖动可用（此前踩过：合成 PointerEvent 会被
    // buttons===0 的守卫吞掉、setPointerCapture 在合成事件上会抛）。这里如实复刻
    // down → move → up（buttons 恒为 1），把宽度拖到目标值再双击复位。
    const dragResizer = (selector, toX) => {
      const el = document.querySelector(selector)
      if (el === null) return false
      const opts = { bubbles: true, pointerId: 7, clientX: el.getBoundingClientRect().left }
      el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, button: 0, buttons: 1 }))
      el.dispatchEvent(new PointerEvent('pointermove', { ...opts, button: 0, buttons: 1, clientX: toX }))
      el.dispatchEvent(new PointerEvent('pointerup', { ...opts, button: 0, buttons: 0, clientX: toX }))
      return true
    }
    const dbl = (selector) => {
      const el = document.querySelector(selector)
      if (el !== null) el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    }
    const navResizerEl = has('[data-field="chat.nav-resizer"]')
    // 主区宽度读数：两侧栏再宽也不许把它压到 420 以下（App.vue 的 MAIN_MIN_WIDTH）
    const mainEl = document.querySelector('main.main')
    const mainWidth = () => (mainEl === null ? 0 : Math.round(mainEl.getBoundingClientRect().width))
    dragResizer('[data-field="chat.nav-resizer"]', 320)
    await wait(300)
    const navElNow = document.querySelector('aside.nav')
    const navDragged = navElNow === null ? 0 : Math.round(navElNow.getBoundingClientRect().width)
    const navMainKept = mainWidth() >= 380
    dbl('[data-field="chat.nav-resizer"]')
    await wait(300)
    const navBack = navElNow === null ? 0 : Math.round(navElNow.getBoundingClientRect().width)
    dragResizer('[data-field="chat.ctx-resizer"]', Math.round(window.innerWidth) - 420)
    await wait(300)
    const asideNow = document.querySelector('aside.context')
    const ctxDragged = asideNow === null ? 0 : Math.round(asideNow.getBoundingClientRect().width)
    const ctxMainKept = mainWidth() >= 380
    dbl('[data-field="chat.ctx-resizer"]')
    await wait(300)
    const ctxBack = asideNow === null ? 0 : Math.round(asideNow.getBoundingClientRect().width)

    // 上限提高（2026-10-03 用户点名"最大宽度不够"）：往左拖 900px（远超旧上限 560）——
    // 实际宽度取 **min(绝对上限 720, 窗口 − 左栏 − 主区下限 420)**，且此时
    // ① 主区仍在 380 以上（用户实测踩过：主区被挤成一条、标题栏按钮压到右栏 tab 上）
    // ② 文件工具条按钮仍在右栏可视区内。
    // 先切回"文件"tab：探针此刻停在 context tab 上，文件工具条根本不在 DOM 里。
    clickTab('files')
    await wait(250)
    dragResizer('[data-field="chat.ctx-resizer"]', Math.round(window.innerWidth) - 900)
    await wait(300)
    const ctxMaxDrag = asideNow === null ? 0 : Math.round(asideNow.getBoundingClientRect().width)
    // 期望值 = min(绝对上限 720, 窗口 − 左栏（此刻 240）− 主区下限 420)；探针侧手算同一口径
    const navWidthNow =
      navElNow === null ? 0 : Math.round(navElNow.getBoundingClientRect().width)
    const ctxMaxRoom = Math.round(window.innerWidth) - navWidthNow - 420
    const ctxMaxAtCap = ctxMaxDrag >= 720 - 1 || ctxMaxDrag >= ctxMaxRoom - 1
    const ctxMaxMainKept = mainWidth() >= 380
    const toolbarAtMax = toolbarInView()
    dbl('[data-field="chat.ctx-resizer"]')
    await wait(300)

    // 窗口按钮固定挂在窗口右上角（2026-10-03 用户口径）：三枚都在窗口右缘的横带里，
    // 且**不与右栏 tab 条重叠**（此前按钮跟着主区标题栏排，右栏一宽就被推过去压在 tab 上）。
    const captionRects = ['minimize', 'maximize', 'close'].map((id) => {
      const el = document.querySelector('[data-caption-btn="' + id + '"]')
      return el === null ? null : el.getBoundingClientRect()
    })
    // 窗口右缘取 app-shell 的右边界（fixed 元素贴的是这个可视区，不是 documentElement）
    const shellEl = document.querySelector('.app-shell')
    const viewportRight = shellEl === null ? window.innerWidth : shellEl.getBoundingClientRect().right
    const captionGeometry = captionRects.map((r) =>
      r === null ? 'null' : Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height),
    )
    const captionPinned =
      captionRects.every((r) => r !== null) &&
      // 只有最后一枚（关闭）贴窗口右缘；三枚都贴顶（top ≤ 4）
      captionRects[2].right >= viewportRight - 2 &&
      captionRects.every((r) => r.top <= 4)
    const tabRects = Array.from(document.querySelectorAll('.ctx-tab')).map((el) =>
      el.getBoundingClientRect(),
    )
    const captionTabOverlap = captionRects.some((c) =>
      tabRects.some(
        (t) =>
          c !== null &&
          c.left < t.right - 1 &&
          c.right > t.left + 1 &&
          c.top < t.bottom - 1 &&
          c.bottom > t.top + 1,
      ),
    )

    return {
      tabsPresent,
      resizer,
      asideWidth,
      storedWidth,
      inlineWidthVar,
      shellWidth,
      asideMinWidth,
      errorText,
      filePanelOn,
      jobsHiddenOnFiles,
      fileDirBar,
      fileListBack,
      asideOverflowX,
      fileToolbarInView,
      navResizer,
      navWidth,
      navInlineVar,
      navResizerEl,
      navDragged,
      navBack,
      ctxDragged,
      ctxBack,
      ctxMaxDrag,
      ctxMaxRoom,
      ctxMaxAtCap,
      ctxMaxMainKept,
      navMainKept,
      captionPinned,
      captionGeometry,
      captionTabOverlap,
      toolbarAtMax,
      hostBg,
      xtermBg,
      viewportBg,
      terminalOn,
      xtermOn,
      xtermBack,
      textBeforeLength: textBefore.length,
      textAfterLength: textAfter.length,
      browserOn,
      contextOn,
      pass:
        tabsPresent &&
        resizer &&
        // 宽度：无记忆值（首次跑）时必须就是缺省 384px（Number(null) === 0 被 clamp 到
        // 下限那个 bug 靠这条钉住）；有记忆值则落在 280–720 的合法区间
        (storedWidth === null
          ? Math.abs(asideWidth - 384) < 2
          : asideWidth >= 280 && asideWidth <= 720) &&
        filePanelOn &&
        // 文件管理器：目录条恒在，预览态点"返回列表"后列表容器回来
        fileDirBar &&
        fileListBack &&
        // 布局护栏：右栏不横向撑破，工具条按钮都在可视区内
        asideOverflowX <= 0 &&
        fileToolbarInView &&
        // 左栏把手在，且宽度由 --nav-w 内联变量真正驱动
        navResizerOk &&
        // 两侧拖拽真的改宽度，双击各回缺省（240 / 384）——
        // "把手在"推不出"拖得动"；同时主区不许被挤到 380 以下
        navDragged >= 300 &&
        navMainKept &&
        navBack === 240 &&
        ctxDragged >= 400 &&
        ctxMainKept &&
        ctxBack === 384 &&
        // 上限提高（2026-10-03）：拖到极限时宽度取 min(720, 窗口 − 左栏 − 主区下限)，
        // 主区仍在 380 以上，工具条按钮在可视区内
        ctxMaxAtCap &&
        ctxMaxDrag > 400 &&
        ctxMaxMainKept &&
        toolbarAtMax &&
        // 窗口按钮固定在窗口右上角，且不与右栏 tab 条重叠（用户实测的现场）
        captionPinned &&
        captionTabOverlap === false &&
        // 终端黑底（容器纯黑 + viewport 不引入别的颜色）
        terminalBgOk &&
        // 越界必须被拒且说清原因（file-preview.ts 的文案）
        errorText.indexOf('边界') !== -1 &&
        // tab 互斥：上下文 tab 的 DOM 在 files 下必须缺席（v-if 切换是真的）
        jobsHiddenOnFiles &&
        terminalOn &&
        xtermOn &&
        xtermBack &&
        textAfter.length >= textBefore.length &&
        browserOn &&
        contextOn,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 在夹具页里**真点**那个 `target="_blank"` 链接（2026-10-03，docs/07 §2.3）。
 *
 * 为什么不能用 `element.click()`：Chromium 的弹窗拦截只看**用户手势**，脚本合成、
 * 没有激活的 `target="_blank"` 导航会被直接丢掉 —— 实测 `blankOpened` 恒为 false。
 * 这里走与 `chat-trace-wheel` 同一套 CDP：attach 到**夹具页那个 guest**，
 * 用 `Input.dispatchMouseEvent` 在链接中心发一对真实的 mousePressed / mouseReleased。
 */
async function clickFixtureBlankLink(
  win: BrowserWindow,
): Promise<{ ok: boolean; reason?: string; rect?: string }> {
  // mainAct 在 act 之后、check 之前跑：此刻夹具页可能还在加载，先等它出现
  let guest: Electron.WebContents | null = null
  for (let attempt = 0; attempt < 40 && guest === null; attempt += 1) {
    const found = webContents.getAllWebContents().find((wc) => {
      try {
        return (wc.getURL() ?? '').indexOf('fixture.html') !== -1
      } catch {
        return false
      }
    })
    guest = found ?? null
    if (guest === null) await wait(200)
  }
  if (guest === null) return { ok: false, reason: '没找到夹具页的 guest' }

  const point = (await guest.executeJavaScript(
    '(() => { const a = document.getElementById("probe-blank"); if (a === null) return null; const r = a.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()',
    true,
  )) as { x: number; y: number } | null
  if (point === null) return { ok: false, reason: '夹具页里没有 probe-blank 链接' }

  const dbg = guest.debugger
  try {
    dbg.attach('1.3')
  } catch {
    // 已附加（例如 devtools 开着）就直接复用
  }
  try {
    await dbg.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    })
    await wait(60)
    await dbg.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    })
  } finally {
    try {
      dbg.detach()
    } catch {
      // 未附加时 detach 会抛，忽略
    }
  }
  void win
  return { ok: true, rect: `${point.x},${point.y}` }
}

/**
 * 右栏多标签场景（2026-10-03 二次修订，docs/07 §2.3）。
 *
 * 与 `chat-right-tabs` 的分工：那条场景直接点 `chat.ctx-tab-<id>` 锚点切标签
 * （折叠时锚点在 ＋N 菜单里，`.click()` 照样派发 —— 它覆盖的是面板生命周期 / 宽度 /
 * caption 互斥），**标签条自身的开 / 折叠 / 关闭交互由本场景走真实 UI 覆盖**。
 *
 * 现场（截图停在这里）：用"＋"菜单开出第二个浏览器标签后，**展开"＋N"菜单** ——
 * 截图要一眼看到三件事：可见标签 + "＋N"按钮 + 被折叠标签的菜单（菜单在 48px 顶带
 * **之下**，不碰窗口三键）。后续的激活 / 关闭 / 第二个终端都在 check 里做（截图之后）。
 */
export const CHAT_CTX_TABS_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const report = { ok: false, reason: '', opened: false, menuOpen: false }
  window.__auroraCtxTabsAct = report
  try {
    // ① "＋"菜单 → 新建浏览器标签（第二个浏览器实例）
    const plus = document.querySelector('[data-field="chat.ctx-new-tab"]')
    if (plus === null) { report.reason = '没有 ＋ 按钮'; return report }
    plus.click()
    await wait(200)
    const item = document.querySelector('[data-field="chat.ctx-new-browser"]')
    if (item === null) { report.reason = '新建菜单里没有浏览器项'; return report }
    item.click()
    await wait(500)
    report.opened = document.querySelector('[data-tab-id="browser-2"]') !== null
    if (!report.opened) { report.reason = '第二个浏览器标签没有出现'; return report }
    // ② 展开"＋N"菜单（截图停在这里）
    const more = document.querySelector('[data-field="chat.ctx-tab-more"]')
    if (more === null) { report.reason = '没有 ＋N 按钮（标签没被折叠？）'; return report }
    more.click()
    await wait(300)
    const menu = document.querySelector('[data-field="chat.ctx-more-menu"]')
    report.menuOpen = menu !== null && getComputedStyle(menu).display !== 'none'
    report.ok = report.opened && report.menuOpen
    if (!report.ok) report.reason = '＋N 菜单没有展开'
    return report
  } catch (error) {
    report.reason = String(error)
    return report
  }
})()`

/**
 * 右栏多标签的断言（2026-10-03 二次修订，docs/07 §2.3）。
 *
 * 六件事（现场由 ACT 留下：第二个浏览器标签 + 展开的 ＋N 菜单）：
 * ① **折叠计数**：＋N 的文案 = 标签总数 − 可见数（可见 = 矩形宽 > 8 的那些 ——
 *    被折叠的标签在菜单里，`display:none` 的矩形宽是 0）；
 * ② **菜单不碰三键**：菜单打开时的矩形与任意 caption 按钮矩形**无交集**，且菜单整体在
 *    48px 顶带之下（`top >= 44`）—— 用户点名的"不要遮挡三键"就钉在这两条上；
 * ③ **滑动窗口**：从菜单激活一个被折叠的标签后，它必须回到可见区（否则用户会看着别的
 *    标签、内容却是另一个的）；
 * ④ **关闭**：点它的 ✕ → 标签总数回落；
 * ⑤ **多终端是不同 PTY**：再开一个终端标签后，两个 `chat.terminal-host` 的
 *    `data-terminal-id` 互异且非空 —— 只数 DOM 个数是数不出"两个标签共用一条 shell"的
 *    （那正是"每窗口一个 shell"时代的失效形态）；
 * ⑥ **收尾**：把多开的两个标签关掉、激活回"上下文"，标签总数回到初始 4 ——
 *    本场景不 reload，收尾不干净会污染后面的场景（docs/07 §5.3 的教训）。
 */
export const CHAT_CTX_TABS_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const act = window.__auroraCtxTabsAct || { ok: false, reason: 'act 没有留下读数' }
    // 标签条**可见区**里有哪些标签：只看列表里的（菜单打开时，被折叠的标签也在 DOM 且
    // 有尺寸 —— 按"矩形宽 > 8"判会把菜单项一起数进来，那正是这一版探针踩过的坑）
    const stripTabs = () =>
      Array.from(document.querySelectorAll('[data-field="chat.ctx-tab-list"] [data-tab-id]'))
    const visibleIds = () =>
      stripTabs()
        .filter((el) => el.getBoundingClientRect().width > 8)
        .map((el) => el.getAttribute('data-tab-id'))
    /**
     * 全部标签（可见 + 被折叠）：用"chat.ctx-tab-"前缀 + data-tab-id 两个条件一起选 ——
     * 窗格也有 data-tab-id，只按后者数会把窗格一起数进来（这一版探针踩过）。
     */
    const allTabs = () =>
      Array.from(document.querySelectorAll('[data-field^="chat.ctx-tab-"][data-tab-id]'))
    const textOf = (selector) => {
      const el = document.querySelector(selector)
      return el === null ? '' : (el.textContent || '').trim()
    }
    const overlap = (a, b) =>
      a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1

    const total = allTabs().length
    const visible = visibleIds()
    const folded = total - visible.length
    const moreLabel = textOf('[data-field="chat.ctx-tab-more"]')
    const countOk = folded > 0 && moreLabel === '+' + folded

    // 菜单（act 展开的现场）：向下弹、不碰三键
    const menu = document.querySelector('[data-field="chat.ctx-more-menu"]')
    const menuOpen = menu !== null && getComputedStyle(menu).display !== 'none'
    const menuRect = menu === null ? null : menu.getBoundingClientRect()
    const captionRects = Array.from(document.querySelectorAll('[data-caption-btn]')).map((el) =>
      el.getBoundingClientRect()
    )
    const menuClearOfCaption =
      menuRect !== null && captionRects.every((rect) => !overlap(menuRect, rect))
    const menuBelowHead = menuRect !== null && menuRect.top >= 44
    const menuItems = menu === null ? [] : Array.from(menu.querySelectorAll('[data-tab-id]'))
    const menuCountsFolded = menuItems.length === folded

    // ③ 从菜单激活一个被折叠的标签 → 滑动窗口把它带回可见区
    const pickId = menuItems.length === 0 ? '' : menuItems[0].getAttribute('data-tab-id')
    if (menuItems.length > 0) menuItems[0].click()
    await wait(400)
    const pickedVisible = pickId !== '' && visibleIds().indexOf(pickId) !== -1
    const pickedEl = pickId === '' ? null : document.querySelector('[data-tab-id="' + pickId + '"]')
    const pickedActive = pickedEl !== null && (pickedEl.className || '').indexOf('active') !== -1

    // ④ 关掉它（✕）
    const closeBtn = pickId === '' ? null : document.querySelector('[data-field="chat.ctx-tab-close-' + pickId + '"]')
    if (closeBtn !== null) closeBtn.click()
    await wait(400)
    const afterClose = allTabs().length
    const closed = afterClose === total - 1

    // ⑤ 再开一个终端标签 → 两个终端必须是不同的 PTY
    // 先把**默认**终端标签激活并等它的 PTY 就绪（本场景可能单独跑，那时它还没挂载过），
    // 再开第二个 —— 两个 host 都就绪才谈得上"是不是同一条 shell"。
    const defaultTerm = document.querySelector('[data-field="chat.ctx-tab-terminal"]')
    if (defaultTerm !== null) defaultTerm.click()
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const host = document.querySelector('[data-field="chat.terminal-host"]')
      if (host !== null && (host.getAttribute('data-terminal-id') || '') !== '') break
      await wait(250)
    }
    const plus = document.querySelector('[data-field="chat.ctx-new-tab"]')
    if (plus !== null) plus.click()
    await wait(200)
    const termItem = document.querySelector('[data-field="chat.ctx-new-terminal"]')
    if (termItem !== null) termItem.click()
    let twoTerms = false
    let terminalIds = []
    for (let attempt = 0; attempt < 40 && !twoTerms; attempt += 1) {
      const hosts = Array.from(document.querySelectorAll('[data-field="chat.terminal-host"]'))
      terminalIds = hosts.map((el) => el.getAttribute('data-terminal-id') || '')
      twoTerms =
        hosts.length >= 2 &&
        terminalIds.every((id) => id !== '') &&
        new Set(terminalIds).size === terminalIds.length
      if (!twoTerms) await wait(250)
    }

    // ⑤′ 容量随宽度变化：把右栏拖宽 → 同时可见的标签变多。
    // "固定数量"是**按标签条实测宽度算出来的**（固定 88px 不缩窄 → 宽度里能塞几个就显示几个），
    // 不是写死的 2 —— 这一条把它钉住。拖完双击复位（与 chat-right-tabs 同款，收尾不留脏宽度）。
    const dragResizer = (selector, toX) => {
      const el = document.querySelector(selector)
      if (el === null) return false
      const opts = { bubbles: true, pointerId: 9, clientX: el.getBoundingClientRect().left }
      el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, button: 0, buttons: 1 }))
      el.dispatchEvent(
        new PointerEvent('pointermove', { ...opts, button: 0, buttons: 1, clientX: toX }),
      )
      el.dispatchEvent(new PointerEvent('pointerup', { ...opts, button: 0, buttons: 0, clientX: toX }))
      return true
    }
    dragResizer('[data-field="chat.ctx-resizer"]', Math.round(window.innerWidth) - 560)
    await wait(450)
    const wideVisible = visibleIds().length
    const widenWorks = wideVisible > visible.length
    const resizerEl = document.querySelector('[data-field="chat.ctx-resizer"]')
    if (resizerEl !== null) resizerEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await wait(450)
    const asideEl = document.querySelector('aside.context')
    const resetWidth = asideEl === null ? 0 : Math.round(asideEl.getBoundingClientRect().width)
    const widthRestored = Math.abs(resetWidth - 384) < 2

    // ⑤″ 最窄局面（2026-10-03 用户实测："加号按钮会变得不可用"）：
    // 把右栏拖到最小宽 280 → 标签条只剩 132px 可用。判据不能只量"元素在不在"，
    // 要量**矩形落在标签条可视区内** + **elementFromPoint 真的命中它** ——
    // 之前标签按 88px 起步、按钮跟在后面，标签条的 overflow:hidden 把"＋"整枚裁掉：
    // DOM 在、矩形也在（只是不在可视区），点不到，看着就是"按钮没了"。
    const inListView = (selector) => {
      const el = document.querySelector(selector)
      const list = document.querySelector('[data-field="chat.ctx-tab-list"]')
      if (el === null || list === null) return false
      const r = el.getBoundingClientRect()
      const lr = list.getBoundingClientRect()
      return r.width > 8 && r.height > 8 && r.right <= lr.right + 1 && r.left >= lr.left - 1
    }
    dragResizer('[data-field="chat.ctx-resizer"]', Math.round(window.innerWidth) - 280)
    await wait(450)
    const narrowEl = document.querySelector('aside.context')
    const narrowWidth = narrowEl === null ? 0 : Math.round(narrowEl.getBoundingClientRect().width)
    const narrowVisible = visibleIds().length
    const narrowTabWidth = (() => {
      const el = document.querySelector('[data-field="chat.ctx-tab-list"] [data-tab-id]')
      return el === null ? 0 : Math.round(el.getBoundingClientRect().width)
    })()
    const narrowMoreInView = inListView('[data-field="chat.ctx-tab-more"]')
    const narrowPlusInView = inListView('[data-field="chat.ctx-new-tab"]')
    let narrowPlusUsable = false
    const plusEl = document.querySelector('[data-field="chat.ctx-new-tab"]')
    if (plusEl !== null) {
      const r = plusEl.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      const hitOk = hit !== null && (hit === plusEl || plusEl.contains(hit))
      plusEl.click()
      await wait(250)
      const menu = document.querySelector('[data-field="chat.ctx-new-menu"]')
      const menuOpen = menu !== null && getComputedStyle(menu).display !== 'none'
      narrowPlusUsable = hitOk && menuOpen
      plusEl.click()
      await wait(200)
    }
    dragResizer('[data-field="chat.ctx-resizer"]', Math.round(window.innerWidth) - 384)
    await wait(300)
    const narrowResetEl = document.querySelector('[data-field="chat.ctx-resizer"]')
    if (narrowResetEl !== null)
      narrowResetEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await wait(450)

    // ⑤‴ 左栏缩到最小（200px）时，左栏自己的"＋"入口仍然可点（同一句反馈的另一半）：
    // 逐个量矩形 + elementFromPoint 命中测试；存在但不满足可见/命中的一律记进未就绪名单。
    dragResizer('[data-field="chat.nav-resizer"]', 200)
    await wait(450)
    const navAside = document.querySelector('aside.nav')
    const navRect = navAside === null ? null : navAside.getBoundingClientRect()
    const navPlusIds = [
      'chat.add-project',
      'chat.new-agent-session',
      'chat.new-project-session',
      'chat.new-work-session',
    ]
    let navPlusPresent = 0
    const navPlusMissing = []
    for (const id of navPlusIds) {
      const el = document.querySelector('[data-action="' + id + '"]')
      if (el === null) continue
      navPlusPresent += 1
      const r = el.getBoundingClientRect()
      const inside = navRect !== null && r.right <= navRect.right + 1 && r.left >= navRect.left - 1
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      const hitOk = hit !== null && (hit === el || el.contains(hit))
      if (!(r.width > 8 && r.height > 8 && inside && hitOk)) navPlusMissing.push(id)
    }
    const navMinPlusOk = navPlusPresent > 0 && navPlusMissing.length === 0
    const navResetEl = document.querySelector('[data-field="chat.nav-resizer"]')
    if (navResetEl !== null) navResetEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await wait(450)

    // ⑥ 收尾：关掉多开的两个标签（browser-2 / terminal-2），把步骤 ④ 关掉的那个默认标签
    // 补回来（种类 id 会复用，补回来的就是原来那个 id），再激活回"上下文"——
    // 本场景**不 reload**，收尾不干净会污染后面的场景（docs/07 §5.3 的教训）。
    for (const id of ['browser-2', 'terminal-2']) {
      const btn = document.querySelector('[data-field="chat.ctx-tab-close-' + id + '"]')
      if (btn !== null) {
        btn.click()
        await wait(300)
      }
    }
    for (const kind of ['context', 'files', 'terminal', 'browser']) {
      if (document.querySelector('[data-tab-id="' + kind + '"]') !== null) continue
      const reopen = document.querySelector('[data-field="chat.ctx-new-tab"]')
      if (reopen === null) break
      reopen.click()
      await wait(200)
      const item = document.querySelector('[data-field="chat.ctx-new-' + kind + '"]')
      if (item === null) break
      item.click()
      await wait(350)
    }
    const contextTab = document.querySelector('[data-field="chat.ctx-tab-context"]')
    if (contextTab !== null) {
      contextTab.click()
      await wait(300)
    }
    const restoredCount = allTabs().length
    const contextEl = document.querySelector('[data-field="chat.ctx-tab-context"]')
    const restored =
      restoredCount === 4 &&
      contextEl !== null &&
      (contextEl.className || '').indexOf('active') !== -1

    return {
      actOk: act.ok,
      actReason: act.reason || '',
      moreLabel,
      total,
      visible,
      folded,
      countOk,
      menuOpen,
      menuCountsFolded,
      menuClearOfCaption,
      menuBelowHead,
      pickId,
      pickedVisible,
      pickedActive,
      afterClose,
      closed,
      terminalIds,
      twoTerms,
      wideVisible,
      widenWorks,
      resetWidth,
      widthRestored,
      narrowWidth,
      narrowVisible,
      narrowTabWidth,
      narrowMoreInView,
      narrowPlusInView,
      narrowPlusUsable,
      navPlusPresent,
      navPlusMissing,
      navMinPlusOk,
      restoredCount,
      restored,
      pass:
        act.ok === true &&
        countOk &&
        menuOpen &&
        menuCountsFolded &&
        menuClearOfCaption &&
        menuBelowHead &&
        pickId !== '' &&
        pickedVisible &&
        pickedActive &&
        closed &&
        twoTerms &&
        // 容量确实随宽度变（不是写死的可见数），且收尾把宽度与标签集都复原
        widenWorks &&
        widthRestored &&
        // 最窄局面：标签让位，两枚按钮完整可见且"＋"真的点得开（用户实测的失效现场）
        narrowWidth <= 282 &&
        narrowVisible >= 1 &&
        narrowTabWidth >= 40 &&
        narrowMoreInView &&
        narrowPlusInView &&
        narrowPlusUsable &&
        // 左栏缩到最小时，左栏自己的"＋"入口仍可点
        navMinPlusOk &&
        restored,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 右栏"文件"tab＝会话项目文件夹的现场准备（2026-10-03，docs/07 §2.3）。
 *
 * 三步：① 经 `settings:update` 登记项目"截图项目"指向 prepare 建出的目录
 * （与 settingsProjectAct 同一条口径 —— 启动后写 config.json 对运行中的进程无效）；
 * ② 切到**绑定了该项目的会话**（`sessions/chat-seed-project.json` 的种子会话，
 *    `meta.projectId = 'capture'`）；切之前记下当前激活行，收尾由 check 点它回来；
 * ③ 切到"文件"tab 并等 prepare 种的那份文件出现。
 *
 * act 的返回值不进 report，所以把现场读数挂在 `window` 上（check 里读）——
 * act 里的失败（没找到会话行 / 没等到列表）必须能被 check 看见，否则会静默假 PASS。
 */
export function chatFileProjectAct(root: string): string {
  return `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const report = { ok: false, reason: '', switched: false, listed: false }
  window.__auroraFileProjectAct = report
  try {
    const state = await window.aurora.settings.get()
    if (!state.ok) { report.reason = state.message; return report }
    const updated = await window.aurora.settings.update({
      projects: {
        ...state.value.projects,
        list: [{ id: 'capture', name: '截图项目', root: ${JSON.stringify(root)} }],
      },
    })
    if (!updated.ok) { report.reason = updated.message; return report }
    await wait(400)
    // 收尾要回到原来那条会话：用应用自己的行按钮（active 类即当前会话），不猜标题
    const activeRow = document.querySelector('button.nav-item.active')
    window.__auroraFileProjectPrevText = activeRow === null ? '' : activeRow.textContent || ''
    let target = null
    for (let attempt = 0; attempt < 20 && target === null; attempt += 1) {
      const rows = Array.from(document.querySelectorAll('button.nav-item'))
      target = rows.find((row) => (row.textContent || '').indexOf('project-seed') !== -1) || null
      if (target === null) await wait(200)
    }
    if (target === null) { report.reason = '没有找到 project-seed 会话行'; return report }
    target.click()
    report.switched = true
    await wait(500)
    const tab = document.querySelector('[data-field="chat.ctx-tab-files"]')
    if (tab === null) { report.reason = '没有文件 tab'; return report }
    tab.click()
    for (let attempt = 0; attempt < 25 && !report.listed; attempt += 1) {
      const listText = document.querySelector('[data-field="chat.file-list"]')?.textContent || ''
      report.listed = listText.indexOf('报告.md') !== -1
      if (!report.listed) await wait(200)
    }
    if (!report.listed) report.reason = '文件列表里没有出现 prepare 种的文件'
    report.ok = report.listed
    return report
  } catch (error) {
    report.reason = String(error)
    return report
  }
})()`
}

/**
 * 无标签页时的右栏工具快捷入口（2026-10-03，docs/07 §2.3）。
 *
 * 现场（截图停在这里）：reload 回初始四标签后，**走真实 ✕ 按钮**把四个标签逐个关掉 ——
 * 右栏标签条只剩"＋"，右栏正文区出现"工具"分组（四张卡片）。
 * 截图要一眼看到：卡片长什么样、右栏确实是空的。
 * 后续（check 里）：卡片矩形与命中、点"文件"卡片把标签开回来、卡片区随之消失。
 */
export const CHAT_CTX_EMPTY_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const report = { ok: false, reason: '', closed: 0 }
  window.__auroraCtxEmptyAct = report
  try {
    // 关一个标签后标签条会重排 —— 每轮重新取"第一个关闭钮"，直到一个都不剩
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const close = document.querySelector('[data-field^="chat.ctx-tab-close-"]')
      if (close === null) break
      close.click()
      report.closed += 1
      await wait(200)
    }
    await wait(400)
    const shortcuts = document.querySelector('[data-field="chat.tool-shortcuts"]')
    report.ok = shortcuts !== null
    if (!report.ok) report.reason = '关完所有标签后右栏没有出现工具快捷卡片'
    return report
  } catch (error) {
    report.reason = String(error)
    return report
  }
})()`

/**
 * 插件声明式面板 / 沙箱页面（P3，docs/14 §3.4）。
 *
 * 示例插件由 `runCapture` 预装（dev 仓库内的 examples/plugins/hello-aurora）；
 * act 走真实「＋」菜单点击，check 读面板文本 / 在 guest 里读页面文本 —— 面板与页面
 * 两条渲染路径都要求真实 IPC（`plugins:panelData` / `plugins:pageRpc`）走通。
 */
export const CHAT_PLUGIN_PANEL_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const click = (selector) => {
    const el = document.querySelector(selector)
    if (el === null) return false
    el.click()
    return true
  }
  if (!click('[data-field="chat.ctx-new-tab"]')) return { ok: false, reason: '新建标签按钮缺失' }
  await wait(250)
  if (!click('[data-field="chat.ctx-new-plugin-com.example.hello.board"]')) {
    return { ok: false, reason: '插件面板菜单项缺失' }
  }
  await wait(900)
  return { ok: document.querySelector('.plugin-panel') !== null }
})()`

export const CHAT_PLUGIN_PANEL_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const panel = document.querySelector('.plugin-panel')
    const text = panel === null ? '' : panel.innerText
    if (panel !== null && text.includes('Hello Aurora') && text.includes('计数 +1')) {
      return { pass: true, detail: text.slice(0, 120) }
    }
    await wait(150)
  }
  const panel = document.querySelector('.plugin-panel')
  return {
    pass: false,
    reason: '插件声明式面板没有渲染出期望内容',
    detail: panel === null ? 'no .plugin-panel' : panel.innerText.slice(0, 200),
  }
})()`

/** 提示条小组件场景：先走真实 hover 展开，再把面板滚到底部让「小组件」区完整入镜。 */
export const EDGE_BAR_PLUGIN_WIDGET_ACT = `(async () => {
  try {
    const el = document.querySelector('.edge')
    if (!el) return { hovered: false, reason: 'no .edge' }
    el.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false, pointerType: 'mouse' }))
    await new Promise((resolve) => setTimeout(resolve, 900))
    const scroll = document.querySelector('.panel-scroll')
    if (scroll !== null) scroll.scrollTop = scroll.scrollHeight
    await new Promise((resolve) => setTimeout(resolve, 500))
    // 小组件是挂载后才异步拉取的：高度稳定前先滚一次可能没到底，这里再补一次
    if (scroll !== null) scroll.scrollTop = scroll.scrollHeight
    await new Promise((resolve) => setTimeout(resolve, 200))
    return { hovered: true }
  } catch (error) {
    return { hovered: false, reason: String(error) }
  }
})()`

/**
 * 面板事件推送（docs/14 §5.5）：打开声明式面板 → 插件 `ctx.ui.panelEvent` 推送 →
 * 面板不点刷新就换上新 schema。act 里记下推送前后的计数，check 在截图后读回。
 */
export const CHAT_PLUGIN_PANEL_PUSH_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const click = (selector) => {
    const el = document.querySelector(selector)
    if (el === null) return false
    el.click()
    return true
  }
  if (!click('[data-field="chat.ctx-new-tab"]')) return { ok: false, reason: '新建标签按钮缺失' }
  await wait(250)
  if (!click('[data-field="chat.ctx-new-plugin-com.example.hello.board"]')) {
    return { ok: false, reason: '插件面板菜单项缺失' }
  }
  await wait(600)
  const readCount = () => {
    const values = [...document.querySelectorAll('.plugin-panel .kv-value')].map(
      (node) => node.textContent?.trim() ?? '',
    )
    return values[0] ?? ''
  }
  const before = readCount()
  const pushed = await window.aurora.plugins.runCommand({
    pluginId: 'com.example.hello',
    name: 'hello-push',
  })
  let after = before
  for (let attempt = 0; attempt < 30; attempt += 1) {
    after = readCount()
    if (after !== '' && after !== before) break
    await wait(100)
  }
  window.__auroraPushProbe = { before, after, pushed: pushed && pushed.ok === true }
  return { ok: after !== before, before, after }
})()`

export const CHAT_PLUGIN_PANEL_PUSH_CHECK = `(() => {
  const probe = window.__auroraPushProbe ?? {}
  const panel = document.querySelector('.plugin-panel')
  const text = panel === null ? '' : panel.innerText
  return {
    pass:
      panel !== null &&
      probe.pushed === true &&
      probe.before !== '' &&
      probe.after !== probe.before &&
      text.includes('计数'),
    probe,
    detail: text.slice(0, 180),
  }
})()`

/** 桌面小组件（docs/14 §5.3）：独立窗口里的浮动卡片。 */
export const WIDGET_DESKTOP_PLUGIN_CHECK = `(() => {
  const card = document.querySelector('.widget-card')
  const text = card === null ? '' : card.innerText
  return {
    pass:
      card !== null &&
      text.includes('本周值日') &&
      text.includes('完成一项') &&
      (card.dataset.widgetId ?? '') === 'duty-week',
    widgetId: card === null ? '' : card.dataset.widgetId ?? '',
    material: card === null ? '' : card.dataset.material ?? '',
    detail: text.slice(0, 160),
  }
})()`

/** 提示条小组件（docs/14 §5.4）：展开面板底部、只渲染声明式条目、单条高度有上限。 */
export const EDGE_BAR_PLUGIN_WIDGET_SCRIPT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const section = document.querySelector('[data-field="edge-bar.plugin-widgets"]')
    const item = section === null ? null : section.querySelector('.widget-item')
    if (section !== null && item !== null) {
      const rect = item.getBoundingClientRect()
      const text = section.innerText
      return {
        pass:
          text.includes('事务') &&
          rect.height > 0 &&
          rect.height <= 220 &&
          document.querySelector('webview') === null,
        detail: text.slice(0, 160),
        height: Math.round(rect.height),
      }
    }
    await wait(150)
  }
  return { pass: false, reason: '提示条没有渲染插件小组件' }
})()`

export const CHAT_PLUGIN_PAGE_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const click = (selector) => {
    const el = document.querySelector(selector)
    if (el === null) return false
    el.click()
    return true
  }
  if (!click('[data-field="chat.ctx-new-tab"]')) return { ok: false, reason: '新建标签按钮缺失' }
  await wait(250)
  if (!click('[data-field="chat.ctx-new-plugin-com.example.hello.info"]')) {
    return { ok: false, reason: '插件页面菜单项缺失' }
  }
  await wait(1800)
  return { ok: document.querySelector('webview[src^="aurora-plugin://"]') !== null }
})()`

export const CHAT_PLUGIN_PAGE_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const withTimeout = (promise, ms) =>
    Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve('__TIMEOUT__'), ms)),
    ])
  let view = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    view = document.querySelector('webview[src^="aurora-plugin://"]')
    if (view !== null) break
    await wait(150)
  }
  if (view === null) return { pass: false, reason: '插件页面 webview 没有出现' }
  const info = { url: '', loading: null, src: '', outer: '', guest: -1, error: '' }
  try {
    info.url = view.getURL()
    info.loading = view.isLoading()
    info.src = view.src
    info.outer = view.outerHTML.slice(0, 300)
    try {
      info.guest = view.getWebContentsId()
    } catch (error) {
      info.error = String(error)
    }
  } catch (error) {
    info.url = 'getURL failed: ' + String(error)
  }
  try {
    const text = await withTimeout(
      view.executeJavaScript(
        '(async () => {' +
          'for (let i = 0; i < 20; i += 1) {' +
          '  const t = document.body ? document.body.innerText : "";' +
          '  if (t.indexOf("计数：") >= 0) return t;' +
          '  await new Promise((r) => setTimeout(r, 150));' +
          '}' +
          'return document.body ? document.body.innerText : "";' +
          '})()',
      ),
      5000,
    )
    return {
      pass:
        typeof text === 'string' && text.includes('Hello Aurora') && text.includes('计数：'),
      detail: { info, text: typeof text === 'string' ? text.slice(0, 160) : String(text) },
    }
  } catch (error) {
    return { pass: false, reason: String(error), detail: { info } }
  }
})()`

/** 设置页插件「已安装」视图（P3）：示例插件由 runCapture 预装 */
/**
 * 插件「已安装」列表是异步拉取的（`plugins:list` + 布局），截图前必须等条目落定，
 * 否则会截到「正在读取插件列表…」而探针仍因 tab 文案通过。
 */
export const SETTINGS_PLUGINS_INSTALLED_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (document.querySelector('.plugin-item') !== null) return { ok: true }
    await wait(150)
  }
  return { ok: false, reason: '插件列表未加载' }
})()`

export const SETTINGS_PLUGINS_INSTALLED_CHECK = `(() => {
  const text = document.body ? document.body.innerText : ''
  const tab = document.querySelector('[data-field="plugins.tab-installed"]')
  const active = tab !== null && tab.classList.contains('active')
  const item = document.querySelector('.plugin-item')
  return {
    pass:
      active &&
      text.includes('Hello Aurora') &&
      text.includes('安装插件包') &&
      item !== null &&
      (item.innerText.includes('配置') || item.innerText.includes('停用')),
    detail: text.slice(0, 200),
  }
})()`

/** 设置页列表的「配置」入口：点击后由主进程打开独立的 plugin-config 窗口。 */
export const SETTINGS_PLUGINS_DETAIL_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const button = document.querySelector('[data-field="plugins.config.com.example.hello"]')
    if (button !== null) {
      button.click()
      await wait(500)
      return { ok: true }
    }
    await wait(150)
  }
  return { ok: false, reason: '配置按钮未出现' }
})()`

export const SETTINGS_PLUGINS_DETAIL_CHECK = `(() => {
  const item = document.querySelector('.plugin-item')
  const text = item === null ? '' : item.innerText
  const configButton = document.querySelector('[data-field="plugins.config.com.example.hello"]')
  const inlineForm = document.querySelector('.plugin-config-form')
  return {
    pass:
      item !== null &&
      text.includes('Hello Aurora') &&
      configButton !== null &&
      inlineForm === null,
    detail: text.slice(0, 220),
  }
})()`

/** 独立插件配置窗口（docs/07 §2.2.2）：配置 / 小组件 / 权限 / 管理动作。 */
export const PLUGIN_CONFIG_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const page = document.querySelector('[data-field="plugin-config.page"]')
    const greeting = document.querySelector('[data-field="plugin-config.config.greeting"]')
    if (page !== null && greeting !== null) break
    await wait(150)
  }
  const page = document.querySelector('[data-field="plugin-config.page"]')
  const text = document.body ? document.body.innerText : ''
  const greeting = document.querySelector('[data-field="plugin-config.config.greeting"]')
  const save = document.querySelector('[data-field="plugin-config.save"]')
  const restart = document.querySelector('[data-field="plugin-config.restart"]')
  const level = document.querySelector('[data-field="plugins.widget-level.duty-week"]')
  const permissions = document.querySelector('[data-field="plugin-config.permissions"]')
  return {
    pass:
      page !== null &&
      text.includes('Hello Aurora') &&
      text.includes('配置') &&
      greeting !== null &&
      save !== null &&
      restart !== null &&
      permissions !== null &&
      level !== null,
    detail: text.slice(0, 240),
  }
})()`

/** 设置页插件「市场」tab（P3；Center 未接入时是明确空态，不放假数据） */
export const SETTINGS_PLUGINS_MARKET_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const tab = document.querySelector('[data-field="plugins.tab-market"]')
  if (tab === null) return { ok: false, reason: '插件市场 tab 缺失' }
  tab.click()
  await wait(400)
  return { ok: tab.classList.contains('active') }
})()`

export const SETTINGS_PLUGINS_MARKET_CHECK = `(() => {
  const marketTab = document.querySelector('[data-field="plugins.tab-market"]')
  const text = document.body ? document.body.innerText : ''
  const active = marketTab !== null && marketTab.classList.contains('active')
  // P4 之前 / 未配置 Center 时市场是明确空态（不是假数据）：空态块里必须有文案
  const emptyState = document.querySelector('.page-plugins .empty-state')
  const empty = emptyState !== null && (emptyState.textContent ?? '').trim().length > 0
  const entries = document.querySelectorAll('.plugin-item').length
  return { pass: active && (empty || entries > 0), detail: { active, empty, entries } }
})()`

/** 无标签页工具快捷卡片的断言（2026-10-03，docs/07 §2.3）。
 *
 * 现场（act 留下）：右栏标签全关、右栏"工具"四张卡片在。
 * 断言：① 标签确实一个不剩；② 四张卡片锚点齐（context / files / terminal / browser）；
 * ③ 每张卡片**矩形** ≥ 80×30；④ 卡片中心
 * `elementFromPoint` 真的命中卡片（只查 DOM 存在会漏"被裁掉 / 被盖住"这一类失效）；
 * ⑤ 卡片区位于右栏而不是左栏；⑥ 点"文件"卡片 → 文件标签回来、卡片区消失、文件窗格挂上 —— 闭环。
 * 本场景排在 chat 组末尾，收尾不再有 chat 场景依赖初始标签集。
 */
export const CHAT_CTX_EMPTY_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const report = { ok: false, reason: '' }
  try {
    const act = window.__auroraCtxEmptyAct || { ok: false, reason: 'act 没有留下读数' }
    const kinds = ['context', 'files', 'terminal', 'browser']
    const allTabs = () => document.querySelectorAll('[data-field^="chat.ctx-tab-"][data-tab-id]').length
    const cards = kinds.map((k) => document.querySelector('[data-action="chat.tool-open-' + k + '"]'))
    const cardPresent = cards.every((el) => el !== null)
    const rectOk = cards.every((el) => {
      if (el === null) return false
      const r = el.getBoundingClientRect()
      return r.width >= 80 && r.height >= 30
    })
    const hitOk = cards.every((el) => {
      if (el === null) return false
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return hit !== null && (el === hit || el.contains(hit))
    })
    const emptyBefore = allTabs() === 0
    const shortcuts = document.querySelector('[data-field="chat.tool-shortcuts"]')
    const inRightPane = shortcuts !== null && shortcuts.closest('.context') !== null
    const leftNavAbsent = shortcuts !== null && shortcuts.closest('.nav') === null
    const fileCard = document.querySelector('[data-action="chat.tool-open-files"]')
    if (fileCard !== null) fileCard.click()
    let reopened = false
    for (let attempt = 0; attempt < 25 && !reopened; attempt += 1) {
      reopened = document.querySelector('[data-field="chat.ctx-tab-files"]') !== null
      if (!reopened) await wait(200)
    }
    const shortcutsGone = document.querySelector('[data-field="chat.tool-shortcuts"]') === null
    const paneShown = document.querySelector('[data-tab-kind="files"]') !== null
    report.detail = {
      closed: act.closed,
      emptyBefore,
      cardPresent,
      rectOk,
      hitOk,
      inRightPane,
      leftNavAbsent,
      reopened,
      shortcutsGone,
      paneShown,
    }
    report.ok =
      act.ok &&
      emptyBefore &&
      cardPresent &&
      rectOk &&
      hitOk &&
      inRightPane &&
      leftNavAbsent &&
      reopened &&
      shortcutsGone &&
      paneShown
    if (!report.ok && report.reason === '') report.reason = '工具快捷卡片的开标签链路没有闭环'
    return report
  } catch (error) {
    report.reason = String(error)
    return report
  }
})()`

/**
 * 右栏文件面板＝项目文件夹的断言（2026-10-03，docs/07 §2.3；同日补导航与布局护栏）。
 *
 * 现场（act 留下）：会话切到绑项目的种子会话、停在"文件"tab、列表已出。
 * 断言：① 面包屑根段是"项目：截图项目"（绑定生效的**可见**证据）；
 * ② 根目录列出 prepare 种的目录与文件（目录排在前）；
 * ③ 进目录 → 面包屑出现该段；**后退**回根（面包屑只剩根段、后退置灰）→
 *    **前进**再进一层 → "上级"回根（用户点名"进入文件夹后无法返回"）；
 * ④ 点文件在面板内预览（markdown 正文可见 + "返回列表"按钮在），点它回列表；
 * ⑤ **布局护栏**：预览"宽内容.md"（长 URL / 长标识符 / 长代码行）时 ——
 *    aside 与面板都不许横向溢出，且工具条五枚按钮的矩形必须落在 aside 可视矩形内。
 *    这一条是对着用户实测症状写的：内容撑破右栏后按钮被推到可视区之外，
 *    **只查 DOM 存在的探针会全绿**（按钮在 DOM 里、`getBoundingClientRect` 也有值）。
 * 收尾：点回原来的会话行 + 撤销项目登记（后续场景读到的仍是出厂门控）。
 */
export const CHAT_FILE_PROJECT_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const text = (selector) => {
    const el = document.querySelector(selector)
    return el === null ? '' : (el.textContent || '').replace(/\\s+/g, ' ').trim()
  }
  try {
    const act = window.__auroraFileProjectAct || { ok: false, reason: 'act 没有留下读数' }
    const rootLabel = text('[data-field="chat.file-root"]')
    // 面包屑各段文本（根段 = "项目：截图项目"，其后逐级目录）
    const crumbs = () =>
      Array.from(document.querySelectorAll('[data-field="chat.file-crumbs"] .fp-crumb')).map(
        (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim(),
      )
    const rows = () => Array.from(document.querySelectorAll('[data-field="chat.file-list"] .fp-row'))
    const rowNamed = (name) => rows().find((row) => (row.textContent || '').indexOf(name) !== -1)
    const rootCrumbs = crumbs()
    const rootEntries = rows().map((row) => (row.textContent || '').replace(/\\s+/g, ' ').trim())
    const assetsRow = rowNamed('assets')
    const reportRow = rowNamed('报告.md')
    const wideRow = rowNamed('宽内容.md')
    // 目录在前（第一行必须是 assets 这个目录）
    const dirsFirst = rows().length > 0 && (rows()[0].className || '').indexOf('dir') !== -1

    // ③ 进目录 → 后退回根 → 前进再进一层 → 上级回根
    let intoDir = false
    let backToRoot = false
    let forwardIntoTarget = false
    if (assetsRow) {
      assetsRow.click()
      for (let attempt = 0; attempt < 20 && crumbs().length < 2; attempt += 1) await wait(150)
      intoDir = crumbs().join('>').indexOf('assets') !== -1
      const back = document.querySelector('[data-field="chat.file-back"]')
      if (back !== null) back.click()
      for (let attempt = 0; attempt < 20 && crumbs().length > 1; attempt += 1) await wait(150)
      // 回到根：面包屑只剩根段
      backToRoot = crumbs().length === 1
      // 前进按钮此时应可用，点它回到 assets 层
      const forward = document.querySelector('[data-field="chat.file-forward"]')
      if (forward !== null) forward.click()
      for (let attempt = 0; attempt < 20 && crumbs().length < 2; attempt += 1) await wait(150)
      forwardIntoTarget = crumbs().join('>').indexOf('assets') !== -1
      const up = document.querySelector('[data-field="chat.file-up"]')
      if (up !== null) up.click()
      for (let attempt = 0; attempt < 20 && crumbs().length > 1; attempt += 1) await wait(150)
    }
    const upBackToRoot = crumbs().length === 1

    // ④ 点文件 → 面板内预览 → "返回列表"
    let previewText = ''
    let exitButton = false
    let backToList = false
    if (reportRow) {
      reportRow.click()
      for (let attempt = 0; attempt < 25 && previewText.indexOf('文件面板') === -1; attempt += 1) {
        previewText = text('.fp-markdown') || text('.fp-text')
        if (previewText.indexOf('文件面板') === -1) await wait(150)
      }
      exitButton = document.querySelector('[data-field="chat.file-exit"]') !== null
      const exit = document.querySelector('[data-field="chat.file-exit"]')
      if (exit !== null) exit.click()
      await wait(250)
      backToList = document.querySelector('[data-field="chat.file-list"]') !== null
    }

    // ⑤ 宽内容：预览它，量"有没有横向撑破"+ 工具条按钮是否真的在可视区内
    let wideText = ''
    let overflowX = -1
    let panelOverflowX = -1
    let toolbarInView = false
    let wideExitOk = false
    if (wideRow) {
      wideRow.click()
      for (let attempt = 0; attempt < 25 && wideText.indexOf('宽内容夹具') === -1; attempt += 1) {
        wideText = text('.fp-markdown') || text('.fp-text')
        if (wideText.indexOf('宽内容夹具') === -1) await wait(150)
      }
      await wait(200)
      const aside = document.querySelector('aside.context')
      const panel = document.querySelector('[data-field="chat.file-preview"]')
      overflowX = aside === null ? -1 : aside.scrollWidth - aside.clientWidth
      panelOverflowX = panel === null ? -1 : panel.scrollWidth - panel.clientWidth
      const asideRect = aside === null ? null : aside.getBoundingClientRect()
      const inView = (selector) => {
        const el = document.querySelector(selector)
        if (el === null || asideRect === null) return false
        const r = el.getBoundingClientRect()
        return (
          r.width > 0 &&
          r.height > 0 &&
          r.left >= asideRect.left - 1 &&
          r.right <= asideRect.right + 1 &&
          r.top >= asideRect.top - 1 &&
          r.bottom <= asideRect.bottom + 1
        )
      }
      toolbarInView = [
        '[data-field="chat.file-back"]',
        '[data-field="chat.file-forward"]',
        '[data-field="chat.file-up"]',
        '[data-field="chat.file-refresh"]',
        '[data-field="chat.file-exit"]',
      ].every(inView)
      const exit = document.querySelector('[data-field="chat.file-exit"]')
      if (exit !== null) exit.click()
      await wait(250)
      wideExitOk = document.querySelector('[data-field="chat.file-list"]') !== null
    }

    // 收尾：切回原会话 + 撤销项目登记（两条都要成功才认 restored）
    let restored = false
    const prevText = window.__auroraFileProjectPrevText || ''
    if (prevText !== '') {
      const rowsAll = Array.from(document.querySelectorAll('button.nav-item'))
      const prev = rowsAll.find((row) => (row.textContent || '') === prevText)
      if (prev) { prev.click(); await wait(400) }
    }
    const state = await window.aurora.settings.get()
    if (state.ok) {
      await window.aurora.settings.update({ projects: { ...state.value.projects, list: [] } })
      await wait(300)
    }
    // 还原判据：项目分组标签消失（项目登记确实撤掉了）
    restored = text('.nav').indexOf('截图项目') === -1

    return {
      actOk: act.ok,
      actReason: act.reason || '',
      rootLabel,
      rootCrumbs,
      rootEntries,
      dirsFirst,
      intoDir,
      backToRoot,
      forwardIntoTarget,
      upBackToRoot,
      previewShown: previewText.indexOf('文件面板') !== -1,
      exitButton,
      backToList,
      wideShown: wideText.indexOf('宽内容夹具') !== -1,
      overflowX,
      panelOverflowX,
      toolbarInView,
      wideExitOk,
      restored,
      pass:
        act.ok === true &&
        rootLabel.indexOf('项目：截图项目') !== -1 &&
        rootCrumbs.length === 1 &&
        rootEntries.join('|').indexOf('assets') !== -1 &&
        rootEntries.join('|').indexOf('报告.md') !== -1 &&
        rootEntries.join('|').indexOf('宽内容.md') !== -1 &&
        dirsFirst &&
        intoDir &&
        backToRoot &&
        forwardIntoTarget &&
        upBackToRoot &&
        previewText.indexOf('文件面板') !== -1 &&
        exitButton &&
        backToList &&
        wideText.indexOf('宽内容夹具') !== -1 &&
        // 布局护栏：右栏与面板都不横向溢出，工具条按钮全在可视区内
        overflowX <= 0 &&
        panelOverflowX <= 0 &&
        toolbarInView &&
        wideExitOk &&
        restored,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * `show_preview` 推送链路的断言（2026-10-03，docs/06 §14）。
 *
 * 分流的口径：**主进程侧**的目标校验（http(s) / 边界根内的本地文件 / 越界拒绝）由
 * `preview-port.test.ts` 覆盖；这里断言**渲染层那半条链**：收到 `preview:show` 后
 * 右栏自动切到"浏览器"tab、webview 真的加载了目标（`getURL()` 是 file:// 且指向夹具）、
 * 地址栏显示原始路径而不是 file:// URL。
 *
 * 推送由 `mainAct` 合成（与工具实际走的 `windows.sendTo('chat', IPC.preview.show, …)`
 * 是同一条通道、同一个 payload 形状）；会话 id 必须与当前会话一致才被渲染层采纳 ——
 * 这也正是本场景先切到种子会话的原因。
 */
export const CHAT_PREVIEW_TOOL_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const text = (selector) => {
    const el = document.querySelector(selector)
    return el === null ? '' : (el.textContent || '').replace(/\\s+/g, ' ').trim()
  }
  try {
    const act = window.__auroraFileProjectAct || { ok: false, reason: 'act 没有留下读数' }
    // ⚠️ 场景里可能**同时开着多个浏览器标签**（本场景最后那段会由链接另开一个）：
    // 所有查询都必须按标签 id 定位，querySelector 会抓到 DOM 里第一个（可能是
    // display:none 的隐藏面板，矩形为 0 → 断言假 FAIL）。
    const primaryPane = document.querySelector('.ctx-pane[data-tab-id="browser"]')
    const inPrimary = (selector) => (primaryPane === null ? null : primaryPane.querySelector(selector))
    const activeTabNow = () => {
      const el = document.querySelector(
        '[data-field="chat.ctx-tab-list"] [data-tab-id][class*="active"]',
      )
      return el === null ? '' : el.getAttribute('data-tab-id') || ''
    }
    // "推送把右栏切到浏览器"：激活的是**某个**浏览器标签（推送先到、链接后点 ——
    // 夹具页能加载出来本身就依赖这条链路）
    const browserActive = activeTabNow().indexOf('browser') === 0
    const panelOn = primaryPane !== null
    const urlInput = inPrimary('.bp-url')
    const urlValue = urlInput === null ? '' : urlInput.value || ''
    // webview 的 getURL()：加载完成的唯一可信读数（DOM 在而没导航过去是最可能的失效）。
    // 按 **URL** 找那个 guest：它可能不是当前激活标签里的那一个。
    const findGuest = (part) => {
      for (const el of document.querySelectorAll('webview')) {
        try {
          if (typeof el.getURL === 'function' && (el.getURL() || '').indexOf(part) !== -1) return el
        } catch (error) {
          /* 还没导航完的 guest 读不到 URL：忽略 */
        }
      }
      return null
    }
    let loaded = ''
    let guest = null
    for (let attempt = 0; attempt < 30; attempt += 1) {
      guest = findGuest('fixture.html')
      loaded = guest === null ? '' : guest.getURL() || ''
      if (loaded.indexOf('fixture.html') !== -1) break
      await wait(200)
    }

    // 导航工具条（2026-10-03）：后退 / 前进 / 刷新 / 主页 —— 存在且量得出尺寸
    // 工具条断言：**存在性**按主标签的 pane 查（唯一的那份），**尺寸**必须在
    // "当前可见的那个浏览器 pane"里量 —— 隐藏的 pane 是 display:none，矩形恒为 0，
    // 拿它量尺寸必然假 FAIL（本场景此刻激活的可能是链接另开的那个标签）。
    const toolbarIds = ['back', 'forward', 'reload', 'home', 'new-tab'].filter(
      (id) => inPrimary('[data-field="chat.browser-' + id + '"]') !== null,
    )
    const visibleBrowserPane = () =>
      Array.from(document.querySelectorAll('.ctx-pane[data-tab-kind="browser"]')).find(
        (el) => el.getBoundingClientRect().width > 8,
      ) ?? null
    const browserBarSized = ['back', 'forward', 'reload', 'home', 'new-tab'].every((id) => {
      const pane = visibleBrowserPane()
      const el = pane === null ? null : pane.querySelector('[data-field="chat.browser-' + id + '"]')
      if (el === null) return false
      const r = el.getBoundingClientRect()
      return r.width > 8 && r.height > 8
    })

    // **切标签不重载**（2026-10-03 二次修订，docs/07 §2.3）：浏览器面板随标签常驻，
    // 切走只是 display:none。判据取两个**实测事实**：
    // ① 先在页面里打一个标记，切到文件标签再切回来，标记仍在 —— 页面没有被重新加载
    //    （旧版"webview 重挂载即重载"的失效形态会让标记消失）；
    // ② 回来后 guest 的 innerWidth 仍是面板宽度量级 —— 从 display:none 回来时视口没被
    //    塌成 0（那是"切回来一片空白"的典型失效）。
    let noReload = false
    let guestInnerWidth = 0
    if (guest !== null && typeof guest.executeJavaScript === 'function') {
      try {
        await guest.executeJavaScript('window.__auroraNoReload = 42')
        const filesTab = document.querySelector('[data-field="chat.ctx-tab-files"]')
        if (filesTab !== null) { filesTab.click(); await wait(500) }
        const backTab = document.querySelector('[data-field="chat.ctx-tab-browser"]')
        if (backTab !== null) { backTab.click(); await wait(500) }
        const raw = await guest.executeJavaScript(
          'JSON.stringify({ marker: window.__auroraNoReload || 0, width: window.innerWidth })',
        )
        const parsed = JSON.parse(raw)
        noReload = parsed.marker === 42
        guestInnerWidth = typeof parsed.width === 'number' ? parsed.width : 0
      } catch (error) {
        noReload = false
      }
    }
    const guestSized = guestInnerWidth > 120

    // **浏览器标签页自己的"新建标签"**（2026-10-03 用户口径）：工具条右端那枚 ＋ 与
    // 网页里的 target="_blank" 链接，都必须**另开一个浏览器标签**，而不是把当前页顶掉。
    const browserTabIds = () =>
      Array.from(document.querySelectorAll('[data-field="chat.ctx-tab-list"] [data-tab-id]'))
        .map((el) => el.getAttribute('data-tab-id') || '')
        .filter((id) => id.indexOf('browser') === 0)
    const activeTabId = () => {
      const el = document.querySelector(
        '[data-field="chat.ctx-tab-list"] [data-tab-id][class*="active"]',
      )
      return el === null ? '' : el.getAttribute('data-tab-id') || ''
    }
    const closeTabById = async (id) => {
      const btn = document.querySelector('[data-field="chat.ctx-tab-close-' + id + '"]')
      if (btn !== null) {
        btn.click()
        await wait(350)
      }
    }
    // ① 工具条 ＋
    const beforePlus = browserTabIds().length
    let toolbarOpened = false
    let toolbarNewId = ''
    const newTabBtn = inPrimary('[data-field="chat.browser-new-tab"]')
    if (newTabBtn !== null) {
      newTabBtn.click()
      for (let attempt = 0; attempt < 30 && !toolbarOpened; attempt += 1) {
        const ids = browserTabIds()
        if (ids.length > beforePlus) {
          toolbarOpened = true
          toolbarNewId = ids[ids.length - 1]
        } else {
          await wait(200)
        }
      }
    }
    const toolbarNewActive = toolbarNewId !== '' && activeTabId() === toolbarNewId
    await closeTabById(toolbarNewId)

    // ② 网页里的 target="_blank" 链接（mainAct 已用 CDP 真点过 → 这里只读结果）：
    //    新标签必须**新开**出来并加载该地址，而当前页原地不动。
    let blankOpened = false
    let blankNewId = ''
    let blankUrl = ''
    let fixtureKept = false
    for (let attempt = 0; attempt < 30 && !blankOpened; attempt += 1) {
      for (const el of document.querySelectorAll('[data-field="chat.browser-host"] webview')) {
        try {
          const url = typeof el.getURL === 'function' ? el.getURL() || '' : ''
          if (url.indexOf('probe-blank') !== -1) {
            blankUrl = url
            blankOpened = true
          }
        } catch (error) {
          /* 还没导航完的 guest 读不到 URL：忽略 */
        }
      }
      if (!blankOpened) await wait(250)
    }
    // 新标签是"追加实例"（browser-2…）且被激活；主标签（browser）保持自己的夹具页
    const activeAfterBlank = activeTabId()
    const blankNewActive = blankOpened && activeAfterBlank.indexOf('browser-') === 0
    blankNewId = blankNewActive ? activeAfterBlank : ''
    try {
      fixtureKept = guest !== null && (guest.getURL() || '').indexOf('fixture.html') !== -1
    } catch (error) {
      fixtureKept = false
    }
    await closeTabById(blankNewId)

    // 收尾：切回原会话 + 撤销项目登记（与 chat-file-project 同一套）
    let restored = false
    const prevText = window.__auroraFileProjectPrevText || ''
    if (prevText !== '') {
      const rowsAll = Array.from(document.querySelectorAll('button.nav-item'))
      const prev = rowsAll.find((row) => (row.textContent || '') === prevText)
      if (prev) { prev.click(); await wait(400) }
    }
    const state = await window.aurora.settings.get()
    if (state.ok) {
      await window.aurora.settings.update({ projects: { ...state.value.projects, list: [] } })
      await wait(300)
    }
    const contextTab = document.querySelector('[data-field="chat.ctx-tab-context"]')
    if (contextTab !== null) { contextTab.click(); await wait(300) }
    restored = text('.nav').indexOf('截图项目') === -1

    return {
      actOk: act.ok,
      actReason: act.reason || '',
      browserActive,
      panelOn,
      urlValue,
      guestUrl: loaded,
      browserBar: toolbarIds,
      browserBarSized: browserBarSized,
      noReload,
      guestInnerWidth,
      guestSized,
      toolbarOpened,
      toolbarNewId,
      toolbarNewActive,
      blankOpened,
      blankNewId,
      blankUrl,
      blankNewActive,
      fixtureKept,
      restored,
      pass:
        act.ok === true &&
        browserActive &&
        panelOn &&
        loaded.indexOf('fixture.html') !== -1 &&
        loaded.indexOf('file://') === 0 &&
        urlValue.indexOf('fixture.html') !== -1 &&
        // 导航工具条四枚按钮都在且有实际尺寸（2026-10-03：此前是字形按钮，
        // 又细又淡到被当成"没有按钮"——这里钉住"有尺寸的按钮"这个事实）
        toolbarIds.join('|') === 'back|forward|reload|home|new-tab' &&
        browserBarSized &&
        // 切标签往返：页面没重载（标记仍在）且回来后 guest 视口没塌成 0
        noReload &&
        guestSized &&
        // 浏览器标签页自己的"新建标签"：工具条 ＋ 与 target=_blank 链接都另开标签，
        // 且原页面原地不动（当前页被顶掉正是旧口径的失效形态）
        toolbarOpened &&
        toolbarNewActive &&
        blankOpened &&
        blankUrl.indexOf('probe-blank') !== -1 &&
        blankNewActive &&
        fixtureKept,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * Agent 内置浏览器（v35，docs/06 §27）：主进程侧驱动 + 渲染层可见性。
 *
 * 本场景的 mainAct 走**真实的** `BrowserAgentManager`（与工具同一条链路：
 * open → snapshot → type → click → read → screenshot），check 只断言渲染层事实
 * （右栏激活 Agent 浏览器标签、徽章可见、停止按钮量得出尺寸、webview 落在夹具页）。
 */
export const CHAT_BROWSER_AGENT_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const browserPane = () =>
      Array.from(document.querySelectorAll('.ctx-pane[data-tab-kind="browser"]')).find(
        (el) => el.getBoundingClientRect().width > 8,
      ) || null
    const activeTabId = () => {
      const el = document.querySelector(
        '[data-field="chat.ctx-tab-list"] [data-tab-id][class*="active"]',
      )
      return el === null ? '' : el.getAttribute('data-tab-id') || ''
    }
    const activeTabText = () => {
      const el = document.querySelector(
        '[data-field="chat.ctx-tab-list"] [data-tab-id][class*="active"]',
      )
      return el === null ? '' : (el.textContent || '').replace(/\\s+/g, ' ').trim()
    }
    let badge = null
    let stop = null
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const pane = browserPane()
      badge = pane === null ? null : pane.querySelector('[data-field="chat.browser-agent-badge"]')
      stop = pane === null ? null : pane.querySelector('[data-field="chat.browser-agent-stop"]')
      if (badge !== null && stop !== null) break
      await wait(150)
    }
    const badgeRect = badge === null ? null : badge.getBoundingClientRect()
    const stopRect = stop === null ? null : stop.getBoundingClientRect()
    const samePane = badge !== null && stop !== null && badge.contains(stop)
    let loaded = ''
    for (let attempt = 0; attempt < 50; attempt += 1) {
      for (const el of document.querySelectorAll('webview')) {
        try {
          const url = typeof el.getURL === 'function' ? el.getURL() || '' : ''
          if (url.indexOf('capture-browser-agent.html') !== -1) loaded = url
        } catch (error) {
          /* 还没导航完的 guest 读不到 URL：忽略 */
        }
      }
      if (loaded !== '') break
      await wait(150)
    }
    const badgeText = badge === null ? '' : (badge.textContent || '').replace(/\\s+/g, ' ').trim()
    const conditions = [
      activeTabId().indexOf('browser') === 0,
      badge !== null,
      stop !== null,
      badgeRect !== null && badgeRect.width > 60 && badgeRect.height >= 12,
      stopRect !== null && stopRect.width >= 20 && stopRect.height >= 20,
      samePane,
      badgeText.indexOf('Agent') !== -1,
      activeTabText().indexOf('Agent') === 0,
      loaded !== '' && loaded.indexOf('file://') === 0,
    ]
    const result = {
      pass: conditions.every(Boolean),
      conditions,
      badgeText,
      activeTabText: activeTabText(),
      loaded,
      stopSize:
        stopRect === null ? null : { width: stopRect.width, height: stopRect.height },
    }
    // 收尾：关掉这个 Agent 标签，避免后续截图场景在「多出来的标签 + 已释放会话」残局上跑
    // （场景之间互相污染是 capture 最常见的假红来源，见 Memory/2026-10-03-capture-probe-gotchas.md）。
    const agentTabId = activeTabId()
    const closeBtn =
      agentTabId === ''
        ? null
        : document.querySelector('[data-field="chat.ctx-tab-close-' + agentTabId + '"]')
    if (closeBtn !== null) {
      closeBtn.click()
      await wait(300)
    }
    return result
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 右栏"终端"tab 的截图现场（2026-10-03，docs/07 §2.3）。
 *
 * ACT 只切到终端 tab（切走再切回由 `chat-right-tabs` 的 check 覆盖往返存活）；
 * CHECK 断言 **xterm 在 + 容器与 viewport 的底色是纯黑** —— 2026-10-03 的用户口径
 * （此前跟随 `prefers-color-scheme`，浅色系统下是白底黑字）。
 * 行文本只作诊断字段（不进 pass）：本场景**不 reload**，终端是上一个场景初始化过的
 * 常驻 shell，截图里通常带着 PowerShell 提示符；单独跑本场景（ONLY=terminal）时
 * 新 shell 可能还没有输出，不该因此判 FAIL。
 */
export const CHAT_TERMINAL_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const tab = document.querySelector('[data-field="chat.ctx-tab-terminal"]')
    if (tab === null) return { ok: false, reason: '没有终端 tab' }
    tab.click()
    for (let attempt = 0; attempt < 25; attempt += 1) {
      if (document.querySelector('[data-field="chat.terminal-host"] .xterm') !== null) break
      await wait(200)
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`

export const CHAT_TERMINAL_CHECK = `(async () => {
  const bgOf = (selector) => {
    const el = document.querySelector(selector)
    return el === null ? '' : getComputedStyle(el).backgroundColor
  }
  try {
    const xtermOn = document.querySelector('[data-field="chat.terminal-host"] .xterm') !== null
    const hostBg = bgOf('[data-field="chat.terminal-host"]')
    const viewportBg = bgOf('[data-field="chat.terminal-host"] .xterm-viewport')
    const rows = document.querySelector('[data-field="chat.terminal-host"] .xterm-rows')
    const rowText = rows === null ? '' : (rows.textContent || '').trim()
    return {
      xtermOn,
      hostBg,
      viewportBg,
      rowTextLength: rowText.length,
      rowTextHead: rowText.slice(0, 60),
      pass:
        xtermOn &&
        hostBg === 'rgb(0, 0, 0)' &&
        viewportBg === 'rgb(0, 0, 0)',
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 综合概览卡的探针（step 5）：右栏出现"任务"面板 + 上下文卡，用于人工核对布局。
 *
 * 断言的是**布局不冲突**：任务面板在且显示真内容（"已暂停"），同时断言两类
 * **已下线卡片**的缺席（回归护栏）：快照卡（2026-09 迁设置页）与两张项目卡
 * （2026-09-30 迁"会话管理"页 —— `context.project-card` / `context.session-project-card`）。
 */
export const CHAT_OVERVIEW_CHECK = `(async () => {
  try {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const count = (selector) => document.querySelectorAll(selector).length
    let ready = false
    for (let attempt = 0; attempt < 20 && !ready; attempt += 1) {
      ready = count('[data-field="chat.job-panel"]') === 1
      if (!ready) await wait(150)
    }
    const panel = document.querySelector('[data-field="chat.job-panel"]')
    const text = panel === null ? '' : (panel.textContent || '').replace(/\\s+/g, ' ').trim()
    return {
      project: count('[data-field="context.project-card"]'),
      sessionProject: count('[data-field="context.session-project-card"]'),
      snapshots: count('[data-field="chat.snapshot-card"]'),
      jobs: count('[data-field="chat.job-panel"]'),
      text,
      pass:
        count('[data-field="chat.job-panel"]') === 1 &&
        // 快照卡已迁设置页（SnapshotList），右栏必须为 0
        count('[data-field="chat.snapshot-card"]') === 0 &&
        // 两张项目卡已迁"会话管理"页（2026-09-30），右栏必须为 0
        count('[data-field="context.project-card"]') === 0 &&
        count('[data-field="context.session-project-card"]') === 0 &&
        text.indexOf('已暂停') !== -1,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * "子代理"页面探针（docs/07 §2.3：子代理独立页面记在主界面小节里；`§2.4` 那个编号
 * 随小 AI 交互窗删除而移除，见 docs/07 开头的编号说明）。
 *
 * act 点左栏固定项 `[data-field="chat.subagent-item"]` 把主区切到子代理页面；
 * check 断言：页面在、命中 seed 的 **2** 次运行（`chat.subagent-run`，2026-10-18 起一条 write
 * 一条 read）、轨迹有进度条 + 步骤时间线 + 报告，并且**切回对话流**（后续场景依赖 composer 与消息区）。
 *
 * 快照来自 `seedChatTtsHistory` 种下的 `task` 工具卡（含 `subagent` 字段）——
 * 也就是说这条断言同时验证了"快照随工具卡持久化 → 由子代理页面读回"这条链路，
 * 而不只是"实时事件画得出来"。
 */
/**
 * `ask_user` 提问卡片场景（`chat-ask-user.png`，2026-09，docs/06 §21 / docs/07 §2.3）。
 *
 * act 只**选中**第二个选项（截图要拍到"选中态 + 问题 + 选项"，不拍提交后的空场）；
 * check 里才点"回答"并断言卡片消失；`nativeCheck` 断言主进程侧拿到的回执就是第二个选项的文案
 * —— 三段合起来才证明"点回答 → IPC 回执 → 服务 resolve → 内核拿到答案"这条往返真的通了
 * （只看卡片消失不够：回执失败时卡片也会收起）。
 */
export const CHAT_ASK_USER_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const card = document.querySelector('[data-field="chat.ask-user-card"]')
    if (card === null) return { clicked: false, reason: 'no ask-user card' }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (card.querySelectorAll('.option').length >= 3) break
      await wait(50)
    }
    const options = card.querySelectorAll('.option')
    if (options.length < 2) return { clicked: false, reason: 'options < 2' }
    options[1].click()
    await wait(200)
    return { clicked: true }
  } catch (error) {
    return { clicked: false, reason: String(error) }
  }
})()`

export const CHAT_ASK_USER_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const card = document.querySelector('[data-field="chat.ask-user-card"]')
    const questionEl = document.querySelector('[data-field="chat.ask-user-question"]')
    const options = card === null ? [] : Array.from(card.querySelectorAll('.option'))
    const titleEl = card === null ? null : card.querySelector('.ask-title')
    const result = {
      card: card !== null,
      options: options.length,
      activeOptions: options.filter((item) => item.classList.contains('active')).length,
      question: questionEl === null ? '' : (questionEl.textContent || '').trim(),
      header: titleEl === null ? '' : (titleEl.textContent || '').trim(),
      // 选了选项后提交键应可用（未选时 disabled 是"别手滑提交空回答"的闸门）
      submitEnabled:
        card !== null &&
        card.querySelector('[data-action="chat.ask-user-submit"]')?.disabled === false,
      // 自由输入框在（给了选项也能自己写）
      hasFreeInput: card !== null && card.querySelector('.free-input') !== null,
    }
    // 提交：点"回答"，卡片应自行收起（回执往返的渲染层证据）
    const submit = card === null ? null : card.querySelector('[data-action="chat.ask-user-submit"]')
    if (submit !== null) submit.click()
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (document.querySelector('[data-field="chat.ask-user-card"]') === null) break
      await wait(50)
    }
    result.dismissed = document.querySelector('[data-field="chat.ask-user-card"]') === null
    result.pass =
      result.card === true &&
      result.options >= 3 &&
      result.activeOptions === 1 &&
      result.question.length > 5 &&
      result.header.length > 0 &&
      result.submitEnabled === true &&
      result.hasFreeInput === true &&
      result.dismissed === true
    return result
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

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
    // 展开**独立对话视图**（截图要拍的就是它 —— 断言留在 check，但证据必须在图上）。
    // 2026-10-18：seed 有两条运行（write / read），列表按开始时间倒序 → 第一条是 read。
    // 这里明确挑「可读写」那条（write），断言仍是“有 2 个工具调用的对话视图”。
    const runs = Array.from(document.querySelectorAll('[data-field="chat.subagent-run"]'))
    const writeRun =
      runs.find((card) => {
        const chip = card.querySelector('[data-field="chat.subagent-perm"]')
        return chip !== null && (chip.textContent || '').includes('可读写')
      }) ?? runs[0]
    const toggle =
      writeRun === undefined
        ? null
        : writeRun.querySelector('[data-action="chat.subagent-conversation-toggle"]')
    if (toggle === null) return { clicked: false, reason: 'no conversation toggle' }
    toggle.click()
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (document.querySelector('[data-field="chat.subagent-conversation"]') !== null) break
      await wait(50)
    }
    await wait(200)
    return { clicked: true }
  } catch (error) {
    return { clicked: false, reason: String(error) }
  }
})()`

export const CHAT_SUBAGENT_OPEN_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const convEl = () => document.querySelector('[data-field="chat.subagent-conversation"]')
    const page = document.querySelector('[data-field="chat.subagent-page"]')
    const runs = count('[data-field="chat.subagent-run"]')
    // 2026-10-18：seed 两条运行（一条 write、一条 read；列表按开始时间倒序，read 在前）。
    // 断言不依赖顺序：徽章数组做集合判断，对话展开明确挑「可读写」那条。
    const runCards = Array.from(document.querySelectorAll('[data-field="chat.subagent-run"]'))
    const permTexts = runCards.map((card) => {
      const chip = card.querySelector('[data-field="chat.subagent-perm"]')
      return chip === null ? '' : (chip.textContent || '').trim()
    })
    const writeRun =
      runCards.find((card) => {
        const chip = card.querySelector('[data-field="chat.subagent-perm"]')
        return chip !== null && (chip.textContent || '').includes('可读写')
      }) ?? runCards[0] ?? null
    const permText = permTexts.find((text) => text.includes('可读写')) ?? permTexts[0] ?? ''
    const toggle =
      writeRun === null
        ? null
        : writeRun.querySelector('[data-action="chat.subagent-conversation-toggle"]')
    const result = {
      page: page !== null,
      runs,
      toggleFound: toggle !== null,
      permText,
      permTexts,
      summary: count('[data-field="chat.subagent-summary"]'),
      // 导航项此时应是激活态（否则说明 view 状态没接上）
      navActive:
        document.querySelector('[data-field="chat.subagent-item"]') !== null &&
        document.querySelector('[data-field="chat.subagent-item"]').classList.contains('active'),
    }
    // ① 折叠态 = 紧凑轨迹（act 里已展开对话，先收起再断言）：进度条 + 步骤时间线 + 报告
    if (toggle !== null && convEl() !== null) toggle.click()
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (convEl() === null) break
      await wait(50)
    }
    const reports =
      writeRun === null ? [] : writeRun.querySelectorAll('[data-field="chat.subagent-report"]')
    result.traceSteps = writeRun === null ? 0 : writeRun.querySelectorAll('.trace-step').length
    result.traceBar = writeRun === null ? 0 : writeRun.querySelectorAll('.trace-bar').length
    result.traceReportChars = reports.length > 0 ? (reports[0].textContent || '').trim().length : 0
    result.traceHiddenWhenOpen = convEl() === null
    // ② 展开态 = 独立对话视图：任务指令气泡 / 工具行 / 最终报告，且**只读**（无输入控件）
    if (toggle !== null) toggle.click()
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (convEl() !== null) break
      await wait(50)
    }
    const conv = convEl()
    const promptEl = conv === null ? null : conv.querySelector('.conv-bubble.user')
    const reportBubble = conv === null ? null : conv.querySelector('.conv-bubble.report')
    result.convOpened = conv !== null
    result.convTurns = count('[data-field="chat.subagent-conversation"] .conv-turn')
    result.convTools = count('[data-field="chat.subagent-conversation"] .conv-tool')
    result.convPrompt = promptEl === null ? '' : (promptEl.textContent || '').trim().slice(0, 20)
    result.convReportChars = reportBubble === null ? 0 : (reportBubble.textContent || '').trim().length
    result.convReadonly =
      conv === null
        ? false
        : conv.querySelector('textarea, input, [contenteditable="true"]') === null
    result.convReport = count('[data-field="chat.subagent-conversation"] .conv-report-tag')
    // 展开态下**这条运行**的轨迹必须让位（两个缩放级别不同时出现）。
    // 注意只量第一条运行：seed 有两条，全局的 .trace-step 还会包含另一条折叠卡的轨迹。
    result.traceDeduped =
      writeRun !== null && writeRun.querySelectorAll('.trace-step').length === 0
    result.pass =
      result.page === true &&
      result.runs === 2 &&
      result.permText.includes('可读写') &&
      result.permTexts.some((text) => text.includes('只读')) &&
      result.navActive === true &&
      result.toggleFound === true &&
      result.traceSteps >= 3 &&
      result.traceBar === 1 &&
      result.traceReportChars > 10 &&
      result.convOpened === true &&
      result.convTurns >= 3 &&
      result.convTools >= 2 &&
      result.convPrompt.length > 5 &&
      result.convReportChars > 10 &&
      result.convReadonly === true &&
      result.convReport === 1 &&
      result.traceDeduped === true
    // 收尾：切回对话流（composer 与消息区必须在后续场景里可用）
    const back = document.querySelector('[data-action="chat.subagent-back"]')
    if (back !== null) back.click()
    await wait(250)
    result.restored = document.querySelector('[data-field="chat.subagent-page"]') === null
    result.pass = result.pass === true && result.restored === true
    return result
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * "自动化"探针组（docs/13 §11、docs/07 §5.3）：主界面看列表 /
 * 内置区，`automation` 独立窗口看编辑器 / 历史与 Agent 回放。
 *
 * 数据来自 `seedAutomationFixture` 种下的 2 份 Normal 定义（一份计数 3/10、一份已用尽 5/5，
 * 用于次数徽章）+ 2 条历史（normal / agent 各一条，agent 记录指向 seed 的 `auto-capture1` 会话），
 * 使列表 / 历史 / 回放都有可视证据。
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
    // 卡片内不许有元素探出边界（前端减负轮的"安全区"口径：文字/组件不冲出容器）
    const overflowOf = (root) => {
      const box = root.getBoundingClientRect()
      let bad = 0
      for (const node of root.querySelectorAll('*')) {
        const rect = node.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) continue
        if (rect.right > box.right + 1 || rect.left < box.left - 1) bad += 1
      }
      return bad
    }
    const builtin = document.querySelector('[data-field="automation.builtin"]')
    const builtinToggles = count('[data-field="automation.builtin-toggle"]')
    // seed 的 Normal 定义（am-capture1）出现在列表里
    const seededItem = count('[data-field="automation.item-am-capture1"]')
    const toggles = count('[data-field="automation.toggle"]')
    // 调用次数徽章（v0.2.8，docs/13 §3.1）：两份 seed 定义各一枚（3/10 与 5/5），
    // 其中 5/5 那份已用尽 —— 文本与警示样式都要真的落到 DOM 上（数值判据，不看截图猜）
    const runsChips = Array.from(document.querySelectorAll('[data-field="automation.runs"]'))
    const runsText = runsChips.map((chip) => (chip.textContent || '').trim())
    const exhaustedChips = document.querySelectorAll('[data-field="automation.runs"].exhausted').length
    // 每张卡摘要行都有语义图标（"每个操作都配上图标"的回归护栏）
    const cards = Array.from(document.querySelectorAll('.card'))
    const iconsPerCard = cards.map((card) => card.querySelectorAll('.card-meta svg').length)
    const cardOverflow = cards.reduce((total, card) => total + overflowOf(card), 0)
    return {
      builtin: builtin !== null,
      builtinToggles,
      seededItem,
      toggles,
      runsChips: runsChips.length,
      runsText,
      exhaustedChips,
      iconsPerCard,
      cardOverflow,
      pass:
        builtin !== null &&
        builtinToggles === 2 &&
        seededItem === 1 &&
        toggles === 2 &&
        runsChips.length === 2 &&
        runsText.includes('3/10') &&
        runsText.includes('5/5') &&
        exhaustedChips === 1 &&
        cards.every((card) => card.querySelectorAll('.card-meta svg').length >= 2) &&
        cardOverflow === 0,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

export const CHAT_AUTOMATION_EDITOR_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const opened = await window.aurora.automation.openWindow({ view: 'editor', mode: 'normal' })
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (document.querySelector('[data-field="automation.editor"]') !== null) break
      await wait(100)
    }
    await wait(200)
    return {
      opened: opened.ok,
      editor: document.querySelector('[data-field="automation.editor"]') !== null,
    }
  } catch (error) {
    return { opened: false, reason: String(error) }
  }
})()`

export const CHAT_AUTOMATION_EDITOR_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const editor = document.querySelector('[data-field="automation.editor"]')
    // 条件选择器是"图标磁贴网格"（2026-09 前端减负轮）：数磁贴而不是数 option
    const kindGroup = document.querySelector('[data-field="automation.trigger-kind"]')
    const tiles = kindGroup === null ? [] : Array.from(kindGroup.querySelectorAll('[data-kind]'))
    const tileIcons = tiles.filter((tile) => tile.querySelector('svg') !== null).length
    // 操作行：每行一个组件胶囊组，胶囊自带图标（"每个操作都配上图标"的回归护栏）
    const actionRows = Array.from(document.querySelectorAll('[data-field^="automation.action-"]'))
    const actionIcons = actionRows.filter((row) => row.querySelector('.chip svg') !== null).length
    const nameInput = editor === null ? null : editor.querySelector('input[type="text"]')
    const numberField = count('[data-field="automation.editor"] input[type="number"]')
    // 调用次数上限输入（v0.2.8）：字段在、能输入（写 42 后读回同一值 = 双向绑定真的接上了），
    // 且几何合规 —— 输入是窄的、说明占剩下的大部分（.input 的 width:100% 曾把说明挤成竖排字）
    const runsInput = editor === null ? null : editor.querySelector('[data-field="automation.max-runs"]')
    const runsRow = runsInput === null ? null : runsInput.closest('.runs-row')
    const runsNote = runsRow === null ? null : runsRow.querySelector('.runs-note')
    const runsInputWidth =
      runsInput === null ? 0 : Math.round(runsInput.getBoundingClientRect().width)
    const runsNoteWidth = runsNote === null ? 0 : Math.round(runsNote.getBoundingClientRect().width)
    let runsInputValue = ''
    if (runsInput !== null) {
      runsInput.value = '42'
      runsInput.dispatchEvent(new Event('input', { bubbles: true }))
      await wait(80)
      runsInputValue = runsInput.value
    }
    // 原生下拉应当绝迹（条件 / 参数下拉都改成了磁贴与胶囊）
    const nativeSelect = count('[data-field="automation.editor"] select')
    // 磁贴里的标签必须留在磁贴内（"文字冲出组件"的几何护栏）
    const tileOverflow = tiles.reduce((total, tile) => {
      const box = tile.getBoundingClientRect()
      let bad = 0
      for (const node of tile.querySelectorAll('*')) {
        const rect = node.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) continue
        if (rect.right > box.right + 1 || rect.bottom > box.bottom + 1) bad += 1
      }
      return total + bad
    }, 0)
    const result = {
      editor: editor !== null,
      triggerTiles: tiles.length,
      tileIcons,
      tileOverflow,
      actionRows: actionRows.length,
      actionIcons,
      nativeSelect,
      hasName: nameInput !== null,
      numberField,
      runsInput: runsInput !== null,
      runsInputValue,
      runsInputWidth,
      runsNoteWidth,
    }
    // 悬浮提示（前端减负轮的核心交互）：pointerenter 后 body 下应出现 .app-tip，
    // 文案非空、且不探出视口；pointerleave 后应自行收回（fixed 定位不留残影）
    const firstTile = tiles[0]
    const host = firstTile === undefined ? null : firstTile.closest('.tip-host')
    let tipText = ''
    let tipInside = false
    if (host !== null) {
      host.dispatchEvent(new PointerEvent('pointerenter'))
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const tip = document.querySelector('body > .app-tip')
        if (tip !== null) {
          tipText = (tip.textContent || '').trim()
          const rect = tip.getBoundingClientRect()
          tipInside =
            rect.left >= -1 &&
            rect.right <= window.innerWidth + 1 &&
            rect.top >= -1 &&
            rect.bottom <= window.innerHeight + 1
          break
        }
        await wait(50)
      }
      host.dispatchEvent(new PointerEvent('pointerleave'))
    }
    result.tipText = tipText
    result.tipInside = tipInside
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (document.querySelector('body > .app-tip') === null) break
      await wait(50)
    }
    result.tipClosed = document.querySelector('body > .app-tip') === null
    // Esc 关闭（弹窗的标准键盘路径）：派发到 window，组件监听器接住后应关掉编辑器。
    // v0.2.9 起弹窗有 250ms 淡出过渡（Transition fade），过渡期间元素还在 DOM 里 ——
    // 等 500ms 再断言，别把"正在退场"误判成"没关掉"。
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wait(500)
    result.escClosed = document.querySelector('[data-field="automation.editor"]') === null
    // 收尾：若 Esc 未生效（回归时）再点"取消"，保证后续场景能继续操作列表
    if (result.escClosed !== true) {
      const cancel = document.querySelector('[data-action="automation.editor-cancel"]')
      if (cancel !== null) cancel.click()
      await wait(500)
    }
    result.restored = document.querySelector('[data-field="automation.editor"]') === null
    result.pass =
      editor !== null &&
      tiles.length >= 7 &&
      tileIcons === tiles.length &&
      tileOverflow === 0 &&
      actionRows.length >= 1 &&
      actionIcons === actionRows.length &&
      nativeSelect === 0 &&
      result.hasName === true &&
      runsInput !== null &&
      runsInputValue === '42' &&
      runsInputWidth > 0 &&
      runsInputWidth <= 120 &&
      runsNoteWidth >= 120 &&
      tipText.length > 0 &&
      tipInside === true &&
      result.tipClosed === true &&
      result.escClosed === true &&
      result.restored === true
    return result
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

export const CHAT_AUTOMATION_HISTORY_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const count = (selector) => document.querySelectorAll(selector).length
  try {
    const opened = await window.aurora.automation.openWindow({ view: 'history', mode: 'agent' })
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (document.querySelector('[data-field="automation.history-panel"]') !== null) break
      await wait(100)
    }
    await wait(250)
    // 点开第一条可回放的 Agent 记录：截图要能看到「行 → 就地展开的对话回放」这块证据
    const row = document.querySelector('.run-item.clickable')
    if (row !== null) {
      row.click()
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (count('[data-field="automation.replay"] .message') >= 2) break
        await wait(150)
      }
      await wait(200)
    }
    // 再滚一小段，让分组标题吸在滚动区上沿：截图要停在这个状态 —— 标题条压在滚过去的
    // 记录上（2026-10-17 用户报的「时间标识叠字」就出在这里，不滚起来根本拍不到）
    const body = document.querySelector('[data-field="automation.history-panel"] .view-body')
    if (body !== null) {
      body.scrollTop = 90
      await wait(150)
    }
    return {
      opened:
        opened.ok && document.querySelector('[data-field="automation.history-panel"]') !== null,
      detail: row !== null,
    }
  } catch (error) {
    return { opened: false, reason: String(error) }
  }
})()`

export const CHAT_AUTOMATION_HISTORY_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const count = (selector) => document.querySelectorAll(selector).length
  try {
    const panel = document.querySelector('[data-field="automation.history-panel"]')
    // Agent tab：按日期分组 + 记录就地展开（回放复用主界面同款消息流：气泡 / 轨迹 / 工具卡）
    const agentRuns = count('.run-item')
    const clickable = count('.run-item.clickable')
    const dayHeads = count('.day-head')
    const metaLines = count('.run-meta')
    const agentRow = document.querySelector('.run-item.clickable')
    if (agentRow !== null && document.querySelector('[data-field="automation.replay"]') === null) {
      agentRow.click()
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (count('[data-field="automation.replay"] .message') >= 2) break
        await wait(150)
      }
    }
    await wait(150)
    const replayMessages = count('[data-field="automation.replay"] .message')
    const traceCards = count('[data-field="automation.replay"] .tool-card')
    const panelAfter = document.querySelector('[data-field="automation.history-panel"]')
    const agentMarker =
      panelAfter !== null &&
      ((panelAfter.textContent || '').indexOf('capture-automation-run') !== -1)

    // ── 回放里的点击不许把记录收起来（2026-10-17 用户报「点折叠的工具调用记录，历史对话就关了」）──
    // 整行挂着 toggleRow，而明细是行内的一块 —— 明细里的点击一旦冒泡上去就把记录收起了。
    // 走真实链路：先展开轨迹，再点开一条工具行；两步之后明细都必须还在。
    const replayRoot = document.querySelector('[data-field="automation.replay"]')
    const traceHead = replayRoot === null ? null : replayRoot.querySelector('.trace-head')
    if (traceHead !== null) {
      traceHead.click()
      await wait(200)
    }
    const keptAfterTrace = document.querySelector('[data-field="automation.run-detail"]') !== null
    const toolHead = replayRoot === null ? null : replayRoot.querySelector('.tool-card .tool-head')
    if (toolHead !== null) {
      toolHead.click()
      await wait(220)
    }
    const keptAfterTool = document.querySelector('[data-field="automation.run-detail"]') !== null
    const toolOpened = replayRoot !== null && replayRoot.querySelector('.tool-card.open') !== null
    /** 两次点击都必须保住明细 —— 这条就是「点折叠的工具调用记录会把记录收起来」的回归护栏 */
    const detailKept = keptAfterTrace === true && keptAfterTool === true

    // ── 吸顶的分组标题（2026-10-17）：底色必须不透明、吸顶时必须与滚动区上沿齐平 ──
    // 半透明底会把滚过去的记录透出来；吸顶盒上方的外间距（或容器上边距把首组往下顶）会留出
    // 一条没上色的缝，记录照样从缝里露出来 —— 两者都让标题文字与行里的时间叠成花屏
    // （用户报的「时间标识 ui 错乱」）。这里量的是「吸顶那条离上沿多远」。
    const viewBody = panelAfter === null ? null : panelAfter.querySelector('.view-body')
    let headOpaque = null
    let headGap = null
    let headGaps = null
    let headOnTop = null
    if (viewBody !== null) {
      const firstHead = document.querySelector('.day-head')
      if (firstHead !== null) {
        // 「不透明」不看字面：算出来的颜色有 3 段（rgb）或第 4 段 alpha 为 1 才算盖得住
        const raw = getComputedStyle(firstHead).backgroundColor
        const inside = raw.slice(raw.indexOf('(') + 1, raw.indexOf(')'))
        const parts = inside.split(',').map((part) => Number(part.trim()))
        headOpaque = parts.length === 3 || (parts.length === 4 && parts[3] === 1)
      }
      // 两个位置各量一次：浅处（首组内）与深处（列表中部，后面某个分组内）——
      // 每个位置都得有一条标题贴住上沿（离上沿最近的那条 ≤ 1px）
      const gapsAt = async (top) => {
        viewBody.scrollTop = top
        await wait(160)
        const portTop = viewBody.getBoundingClientRect().top
        return Array.from(document.querySelectorAll('.day-head')).map(
          (head) => Math.round((head.getBoundingClientRect().top - portTop) * 10) / 10,
        )
      }
      const shallow = await gapsAt(200)
      const deep = await gapsAt(Math.round(viewBody.scrollHeight / 2))
      headGaps = { shallow, deep }
      const nearest = (gaps) => Math.min(...gaps.map((gap) => Math.abs(gap)))
      headGap = Math.max(nearest(shallow), nearest(deep))
      // 还得真的压在上面：吸顶那条矩形内取样，命中测试的最上层必须是标题自己
      // （底色不透明 + 位置齐平仍可能被后来居上的兄弟元素盖住，这条把「压住」也钉住）
      const portTop = viewBody.getBoundingClientRect().top
      const stuck = Array.from(document.querySelectorAll('.day-head')).find(
        (head) => Math.abs(head.getBoundingClientRect().top - portTop) <= 1,
      )
      if (stuck !== undefined) {
        const box = stuck.getBoundingClientRect()
        headOnTop = [
          [box.left + box.width / 2, box.top + 3],
          [box.left + box.width / 2, box.top + box.height / 2],
          [box.left + 4, box.top + box.height - 3],
        ].every(([x, y]) => {
          const hit = document.elementsFromPoint(x, y)[0]
          return hit !== undefined && (hit === stuck || stuck.contains(hit))
        })
      }
    }

    // Normal tab：一行摘要 + 就地展开逐个操作组件的结果（不再「无详情层」，docs/13 §11）
    const tabNormal = document.querySelector('[data-field="automation.tab-normal"]')
    if (tabNormal !== null) {
      tabNormal.click()
      await wait(200)
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (count('.run-item') > 0) break
      await wait(120)
    }
    const normalRuns = count('.run-item')
    const normalClickable = count('.run-item.clickable')
    const normalHasTime = count('.run-time') > 0
    const normalRow = document.querySelector('.run-item.clickable')
    if (normalRow !== null) {
      normalRow.click()
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (count('[data-field="automation.run-detail"] .step-item') > 0) break
        await wait(120)
      }
    }
    await wait(120)
    const detail = document.querySelector('[data-field="automation.run-detail"]')
    const stepItems = count('[data-field="automation.run-detail"] .step-item')
    const detailText = detail === null ? '' : detail.textContent || ''
    const stepFailureShown = detailText.indexOf('未映射文件夹') !== -1

    const result = {
      panel: panel !== null,
      agentRuns,
      clickable,
      dayHeads,
      metaLines,
      replayMessages,
      traceCards,
      agentMarker,
      keptAfterTrace,
      keptAfterTool,
      toolOpened,
      detailKept,
      headOpaque,
      headGap,
      headGaps,
      headOnTop,
      normalRuns,
      normalClickable,
      normalHasTime,
      stepItems,
      stepFailureShown,
      pass:
        panel !== null &&
        agentRuns >= 1 &&
        clickable >= 1 &&
        // 两个分组起：夹具种了跨天的记录，列表才滚得起来（吸顶那两条断言依赖它）
        dayHeads >= 2 &&
        metaLines >= 1 &&
        replayMessages >= 2 &&
        traceCards >= 1 &&
        agentMarker === true &&
        // 明细里的两次点击都不许把记录收起来，且工具行真的开出来了
        detailKept === true &&
        toolOpened === true &&
        headOpaque === true &&
        headGap !== null &&
        headGap <= 1 &&
        headOnTop === true &&
        normalRuns >= 1 &&
        normalClickable >= 1 &&
        normalHasTime === true &&
        stepItems === 2 &&
        stepFailureShown === true,
    }
    await window.aurora.window.hide('automation')
    result.hidden = true
    return result
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 主界面左栏结构 + 门控探针（BetaV2，spec §11）：三栏重构后左栏的固定锚点必须全部在。
 *
 * 断言六件事：
 * ① 左栏三件套：`chat.quick-item`（固定顶置的"快速对话"）、`chat.session-list`（会话列表
 *    容器，且**有会话行**——隔离 userData 由 `seedChatTtsHistory` 种了 main 会话）、
 *    `data-action="chat.new-session"`；
 * ② 右栏开关 `chat.right-panel-toggle` 在，且右栏 `.context` 默认展开（1120px 宽三栏并存）、
 *    classroom 模式的"今日课程"与通用"系统状态"两张卡都渲染
 *    （ContextPanel 无 data-field 锚点，按卡头文案定位）；
 * ③ **麦克风门控**：`stt` 未配置时 `[data-field="chat.mic"]` 必须**不存在**
 *    （docs/07 §2.3 口径：连按钮都不渲染，不是 disabled）——反向断言，数到就是坏；
 * ④ 主区标题 `.head-name` 非空（默认 main 会话无用户消息 → 显示"新会话"，不作硬断言只回传）；
 * ⑤ **窗口按钮**：`data-caption-btn="minimize"` 与 `"close"` 两枚都渲染（Windows 式标题栏）；
 * ⑥ **结构化工具卡**：seed 的 todo_write 渲染 `data-field="chat.todo-card"`（3 行条目）、
 *    task 渲染 `data-field="chat.task-card"`；右栏任务清单卡 `context.todo-card` 必须在。
 *
 * 本场景不改任何状态，排在 chat 场景最前（theme-chat 之后、一切改配置/改会话的场景之前），
 * 保证读到的是出厂门控现场。
 */
/**
 * 主界面**点击成本**盘点（`chat-hit-targets.png`，2026-09-29，docs/07 §5.4）。
 *
 * 起因：用户反馈"主界面按钮的位置不太合理，用户点击的成本大"。位置属于偏好，但
 * **命中面积**是客观可量的 —— 小到 22×22 的按钮在鼠标/触控板上就是"点了没反应"。
 * 本探针把四个区（左栏 / 标题栏 / 输入区 / 消息区）里**所有可见的可交互控件**量一遍，
 * 按两条标准判定：
 * - **WCAG 2.2 SC 2.5.8（AA）**：任何指针目标 ≥ **24×24 CSS px** —— 硬性下限；
 * - **本仓的 `--hit-target: 40px` 口径的降级版**：主要动作（新建会话 / 固定项 /
 *   输入区的发送与麦克风 / 标题栏 caption）≥ **32×32** —— 高频点击的手感线。
 *
 * 探针只量**渲染出来的目标**（按钮 / 下拉 / 链接），不量里面的图标 ——
 * 图标小不是问题，它所在的按钮才是命中区（这条区分是"别把装饰当控件"）。
 * 透明但占位的控件（会话行的归档钮，`opacity: 0` + 悬停显形）**照样要量**：
 * 它保持着可命中性，尺寸不达标同样是坏手感。
 */
export const CHAT_HIT_TARGETS_CHECK = `(() => {
  try {
    const ABS_MIN = 24
    const PRIMARY_MIN = 32
    const items = []
    const seen = new Set()
    const zoneOf = (el) => {
      if (el.closest('.nav') !== null) return 'sidebar'
      if (el.closest('.head') !== null) return 'header'
      // 窗口按钮在窗口右上角（fixed），语义上仍属标题栏
      if (el.closest('.window-caption') !== null) return 'header'
      if (el.closest('.composer-box') !== null) return 'composer'
      if (el.closest('.thread') !== null) return 'thread'
      return 'other'
    }
    const consider = (el) => {
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      const style = window.getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') return
      // 只统计视口内的（滚出可视区的会话行不算：用户当下点不到它）
      if (rect.bottom < 0 || rect.top > window.innerHeight) return
      if (rect.right < 0 || rect.left > window.innerWidth) return
      const label =
        el.getAttribute('data-field') ||
        el.getAttribute('data-action') ||
        el.getAttribute('data-caption-btn') ||
        el.getAttribute('aria-label') ||
        (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 14) ||
        el.className
      const key = label + '@' + Math.round(rect.left) + ',' + Math.round(rect.top)
      if (seen.has(key)) return
      seen.add(key)
      items.push({
        zone: zoneOf(el),
        label,
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      })
    }
    document.querySelectorAll('.nav button, .nav a').forEach(consider)
    document.querySelectorAll('.head button').forEach(consider)
    // 窗口按钮已移到窗口右上角（.window-caption，fixed）—— 照样要量命中面积
    document.querySelectorAll('.window-caption button, [data-caption-btn]').forEach(consider)
    document.querySelectorAll('.composer-box button, .composer-box select').forEach(consider)
    document.querySelectorAll('.thread button').forEach(consider)

    // 主要动作：按锚点/文案点名（这些是高频点击，要求 32）
    const PRIMARY_KEYS = [
      'chat.new-session',
      'chat.quick-item',
      'chat.subagent-item',
      'chat.auto-item',
      'chat.jobs-entry',
      'chat.right-panel-toggle',
      'chat.settings-open',
      'chat.mic',
      'send',
      'minimize',
      'close',
    ]
    const isPrimary = (item) =>
      PRIMARY_KEYS.some((key) => item.label === key || item.label.indexOf(key) !== -1)
    // 可访问性（docs/07 §5.4）：消息区必须是 polite 的 live 区，且**不允许 assertive**；
    // 非流式时 aria-busy 必须为 false（流式期间为 true 的那条在 chat-stream 场景断言）
    const messages = document.querySelector('[data-field="chat.messages"]')
    const ariaLive = messages === null ? '' : messages.getAttribute('aria-live') || ''
    const ariaAtomic = messages === null ? '' : messages.getAttribute('aria-atomic') || ''
    const ariaBusy = messages === null ? '' : messages.getAttribute('aria-busy') || ''
    const belowAbsolute = items.filter((item) => item.w < ABS_MIN || item.h < ABS_MIN)
    const belowPrimary = items.filter(
      (item) => isPrimary(item) && (item.w < PRIMARY_MIN || item.h < PRIMARY_MIN),
    )
    return {
      total: items.length,
      belowAbsolute,
      belowPrimary,
      ariaLive,
      ariaAtomic,
      ariaBusy,
      sizes: items.map((item) => item.zone + '|' + item.label + '|' + item.w + 'x' + item.h),
      pass:
        belowAbsolute.length === 0 &&
        belowPrimary.length === 0 &&
        ariaLive === 'polite' &&
        ariaAtomic === 'false' &&
        ariaBusy === 'false',
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 左栏结构探针 · 自带前置（2026-10-10）：**自己把 classroom 模式落实到位**再交给 check。
 *
 * 为什么必须有这一步：`CHAT_SIDEBAR_SCRIPT` 断言右栏上下文卡里有"今日课程"，
 * 而"今日课程"只存在于 classroom 模式（`ContextPanel.vue` 里它是恒渲染的，不是条件渲染
 * —— 所以卡片缺失只可能是模式不对）。此前这条场景**没有 act**，完全依赖前面
 * `edge-bar-work` 场景把模式还原干净：实测 run2 的失败态是
 * `contextCards:["任务清单","工作目录","系统状态"]`（= work 模式），而同一轮
 * `edge-bar-work` 自己是 PASS 的。
 *
 * 真根因（2026-10-10 代码核实 + 本文件的哨兵）：**渲染层启动期会永久丢 `mode:changed`**
 * —— `apps/desktop/src/renderer/shared/bootstrap.ts` 旧接线是先 `load()` 再 `bind()`，
 * 落在两者之间的广播**没有任何补偿**，而 `mode.set` 在"主进程已是目标值"时是 no-op
 * （`packages/modes/src/manager.ts` 相同 id 提前 return、不 emit）→ 面板自己永远回不来。
 * 触发条件是这个窗口在 work 期间被建窗 / 重载（`edge-bar-work` →
 * `requestGuideIfNeeded` → proactive `showChat()` → `WindowManager.show()` 会 `ensure()`）。
 * 产品侧已在 bootstrap.ts 改成 **先订阅、再加载**（各 store 的 `loadGate` 兜住"晚到的应答
 * 不许盖掉更晚的广播"），本文件里也补了**哨兵**：`CHAT_SIDEBAR_SCRIPT` 断言
 * `forcedToggle === false` 且面板卡片推出的模式 === `mode.list()` 报的模式。
 *
 * 那为什么本 act 还要保留？两层：① check 里也带了自愈（面板与主进程不一致时做一次
 * **真实的状态变化** classroom → work → classroom 把面板拉回来）—— 只为让截图好看，
 * 自愈一旦被触发哨兵就 FAIL（见上面那段）；② 本 act 负责**确认前置真的生效**再截图：
 * 判据不写"等固定毫秒"，而是**有界轮询真实结果**（等到"今日课程"真的在为止，
 * 最多 20 × 150ms = 3s），超时如实回报 `ok:false` 与当前卡片列表。
 *
 * 收尾：本 act **不改别的状态**（只切模式），切到 classroom 正是 chat 组其余场景的
 * 出厂现场（`chat-sidebar` 排在 chat 组最前，见计划注释），所以它天然是自恢复的。
 */
export const CHAT_SIDEBAR_ENSURE_CLASSROOM_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const readCards = () =>
    Array.from(document.querySelectorAll('.context .ctx-card .ctx-head strong')).map((el) =>
      (el.textContent || '').trim(),
    )
  try {
    const switched = await window.aurora.mode.set('classroom')
    let cards = readCards()
    let attempts = 0
    for (; attempts < 20; attempts += 1) {
      if (cards.indexOf('今日课程') !== -1) break
      await wait(150)
      cards = readCards()
    }
    const ok = cards.indexOf('今日课程') !== -1
    // 多给一拍：卡片已出现后再让 Vue 把其余卡片（任务清单 / 系统状态）也刷完，
    // 免得 check 读到"课程卡在、别的卡还没回来"的中间态。
    if (ok) await wait(150)
    return {
      ok,
      attempts,
      cards,
      switched: switched.ok,
      reason: ok ? '' : 'classroom 前置未在 3s 内生效（右栏仍读不到"今日课程"）',
    }
  } catch (error) {
    return { ok: false, reason: String(error), cards: readCards() }
  }
})()`

/**
 * 左栏结构 + 出厂门控现场探针（2026-10-10 起改 async）。
 *
 * 与"前置"的分工：截图前的前置由同一场景的 act（`CHAT_SIDEBAR_ENSURE_CLASSROOM_ACT`）保证；
 * 本探针自己负责**哨兵**——面板卡片推出的模式必须与 `mode.list()` 报的主进程模式一致，
 * 且 `forcedToggle` 必须为 false（面板本来就该是对的）。不一致时先做一次真实状态变化
 * 把面板拉回来（只为截图好看），但那条判据照旧 FAIL，并回传 `probeAttempts` / `probeWaitedMs`
 * 便于区分"产品竞态又回来了"与"探针脚手架坏了"。
 *
 * 历史失败（2026-10-10 run2）：`contextCards` 里是 `工作目录`、缺 `今日课程` = 本探针跑在
 * **work 模式**的残局上。真根因是**渲染层启动期永久丢 `mode:changed`**
 *（`renderer/shared/bootstrap.ts` 旧接线先 load 再 bind，无补偿；
 * 且 `mode.set` 同值是 no-op），触发条件是窗口在 work 期间被建窗。
 * 产品侧已改成先订阅再加载，本探针补哨兵。classroom 的既有判据**一分没松**。
 */
export const CHAT_SIDEBAR_SCRIPT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const readCards = () =>
    Array.from(document.querySelectorAll('.context .ctx-card .ctx-head strong')).map((el) =>
      (el.textContent || '').trim(),
    )
  const panelOfCards = (cards) =>
    cards.some((name) => name.indexOf('工作目录') !== -1)
      ? 'work'
      : cards.some((name) => name.indexOf('今日课程') !== -1)
        ? 'classroom'
        : 'unknown'
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const visible = (el) => {
      if (el === null) return false
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }
    // ── 前置（自带，2026-10-10）：面板模式必须与**主进程**报的模式一致 ──
    // 旧写法只依赖前一个场景（edge-bar-work）把模式还原干净；而模式切换是**跨窗口广播**，
    // 落在渲染层启动窗口期（先 load 再 bind）的那一条会**永久丢失** —— 现场就是
    // "主进程已是 classroom、右栏却永久停在 work"。本探针**不做自愈**：
    // 只记录事实（"window.__auroraSidebarProbe"）并由哨兵判 FAIL ——
    // **面板本来就该是对的**，一旦不一致就说明产品竞态又回来了。
    //
    // ⚠️ 为什么**不**自愈（2026-10-10 独立审查）：① "mode.set('work') → mode.set('classroom')"
    // 是**真实的产品状态变化**（会走 "requestGuideIfNeeded"、可能建窗 / 抬引导），与本场景
    // "不改任何状态"的承诺冲突；② "location.reload()" 会直接掐掉这段 check 脚本
    // （外层 "executeJavaScript" 以页面被换掉结束），截图链路会变得不可预测。
    // 前置由同一场景的 act（"CHAT_SIDEBAR_ENSURE_CLASSROOM_ACT"）保证，这里只需如实判定。
    const listed = await window.aurora.mode.list()
    const mainMode =
      listed && listed.ok === true
        ? (listed.value.find((mode) => mode.active)?.id ?? '')
        : ''
    const cards = readCards()
    const forcedToggle = panelOfCards(cards) !== mainMode
    window.__auroraSidebarProbe = {
      forcedToggle,
      attempts: 0,
      waitedMs: 0,
      mainMode,
    }
    const probe = window.__auroraSidebarProbe
    const panelMode = panelOfCards(cards)
    const panelMatchesMain = mainMode !== '' && panelMode === mainMode
    const quickItem = document.querySelector('[data-field="chat.quick-item"]')
    const sessionList = document.querySelector('[data-field="chat.session-list"]')
    const rightToggle = document.querySelector('[data-field="chat.right-panel-toggle"]')
    const nav = document.querySelector('.nav')
    const shell = document.querySelector('.app-shell')
    const context = document.querySelector('.context')
    const ctxCards = cards
    const headName = (
      (document.querySelector('.head-name') || {}).textContent || ''
    ).trim()
    const todoRows = count('[data-field="chat.todo-card"] .todo-row')
    const navBg = nav === null ? '' : getComputedStyle(nav).backgroundColor
    const shellBg = shell === null ? '' : getComputedStyle(shell).backgroundColor
    const navBorder = nav === null ? '' : getComputedStyle(nav).borderRightColor
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
      navBg,
      shellBg,
      navBorder,
      sidebarLayered: navBg !== '' && shellBg !== '' && navBg !== shellBg,
      contextCollapsed: context === null ? null : context.classList.contains('collapsed'),
      contextCards: ctxCards,
      // 模式一致性（护栏）：主进程报的模式 + 面板卡片推出的模式 + 是否被迫自愈
      mainMode,
      panelMode,
      panelMatchesMain,
      forcedToggle: probe === undefined ? null : probe.forcedToggle,
      probeAttempts: probe === undefined ? null : probe.attempts,
      probeWaitedMs: probe === undefined ? null : probe.waitedMs,
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
        navBg !== '' &&
        shellBg !== '' &&
        navBg !== shellBg &&
        navBorder !== '' &&
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
        count('[data-field="chat.mic"]') === 0 &&
        // 哨兵（2026-10-10）：面板本来就该与主进程一致 —— 需要自愈即产品竞态复现
        probe !== undefined &&
        probe.forcedToggle === false &&
        panelMatchesMain,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/** 记忆库独立窗口：双栏结构、窗口按钮与空态都在，且列表 / 预览没有横向互压。 */
export const MEMORY_WINDOW_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    for (let attempt = 0; attempt < 20 && count('.note-row') === 0; attempt += 1) {
      await wait(100)
    }
    for (let attempt = 0; attempt < 20 && count('.note-md') === 0; attempt += 1) {
      await wait(100)
    }
    const shell = document.querySelector('.memory')
    const head = document.querySelector('.memory-head')
    const list = document.querySelector('.note-list')
    const detail = document.querySelector('.note-detail')
    const search = document.querySelector('.note-filters .search')
    const searchStyle = search === null ? null : getComputedStyle(search)
    const searchVisible =
      searchStyle !== null &&
      searchStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
      searchStyle.backgroundColor !== 'transparent' &&
      Number.parseFloat(searchStyle.borderTopWidth) > 0
    const filters = document.querySelector('.note-filters')
    const filterStyle = filters === null ? null : getComputedStyle(filters)
    const filterOpaque =
      filterStyle !== null &&
      filterStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
      filterStyle.backgroundColor !== 'transparent'
    if (list !== null) list.scrollTop = 240
    await wait(100)
    const filterRect = filters === null ? null : filters.getBoundingClientRect()
    const filterHit =
      filterRect === null
        ? false
        : (() => {
            const hit = document.elementFromPoint(filterRect.left + 8, filterRect.top + 8)
            return hit !== null && hit.closest('.note-filters') !== null
          })()
    const bodyBackground = getComputedStyle(document.body).backgroundColor
    const listRect = list === null ? null : list.getBoundingClientRect()
    const detailRect = detail === null ? null : detail.getBoundingClientRect()
    const noOverlap =
      listRect !== null &&
      detailRect !== null &&
      listRect.width > 0 &&
      detailRect.width > 0 &&
      listRect.right <= detailRect.left + 1
    const initialRows = count('.note-row')
    const initialExpanded = count('.date-head.expanded')
    const initialCollapsed = count('.date-head:not(.expanded)')
    const docxFilter = document.querySelector('[data-field="memory.filter-format-docx"]')
    if (docxFilter !== null) docxFilter.click()
    await wait(150)
    const docxFormats = count('.format-group')
    const allFilter = document.querySelector('[data-field="memory.filter-format-all"]')
    if (allFilter !== null) allFilter.click()
    await wait(150)
    const notesResult = await window.aurora.awareness.notes({ limit: 500 })
    const activeId = document.querySelector('.note-row.active')?.getAttribute('data-note-id') || ''
    const target = notesResult.ok
      ? notesResult.value.find((note) => note.id !== activeId) || null
      : null
    const presented = target === null
      ? { ok: false }
      : await window.aurora.awareness.presentNote({ noteId: target.id })
    await wait(250)
    const presentedRow = document.querySelector('.note-row.active')
    const presentedDate = presentedRow === null ? null : presentedRow.closest('.date-group')?.querySelector('.date-head')
    const presentedSelection =
      target !== null &&
      presented.ok === true &&
      presentedRow?.getAttribute('data-note-id') === target.id &&
      presentedDate?.classList.contains('expanded') === true
    const expiryControl = count('[data-field="memory.note-expiry"]')
    const expiryState =
      (document.querySelector('[data-field="memory.note-expiry-state"]')?.textContent || '').trim()
    const expiredRows = count('.note-row.expired')
    return {
      shell: shell !== null,
      head: head !== null,
      list: list !== null,
      detail: detail !== null,
      searchVisible,
      searchBackground: searchStyle === null ? '' : searchStyle.backgroundColor,
      filterOpaque,
      filterBackground: filterStyle === null ? '' : filterStyle.backgroundColor,
      filterHit,
      bodyBackground,
      rows: initialRows,
      initialExpanded,
      initialCollapsed,
      formatGroups: count('.format-group'),
      dateGroups: count('.date-group'),
      docxFormats,
      presentedSelection,
      expiryControl,
      expiryState,
      expiredRows,
      markdown: count('.note-md'),
      captionMinimize: count('[data-caption-btn="minimize"]'),
      captionMaximize: count('[data-caption-btn="maximize"]'),
      captionClose: count('[data-caption-btn="close"]'),
      empty: count('.empty') > 0,
      noOverlap,
      pass:
        shell !== null &&
        head !== null &&
        list !== null &&
        detail !== null &&
        searchVisible &&
        filterOpaque &&
        filterHit &&
        (bodyBackground === 'rgba(0, 0, 0, 0)' || bodyBackground === 'transparent') &&
        initialRows === 1 &&
        initialExpanded === 1 &&
        initialCollapsed >= 1 &&
        count('.format-group') >= 2 &&
        count('.date-group') >= 2 &&
        docxFormats === 1 &&
        presentedSelection &&
        expiryControl === 1 &&
        expiryState !== '' &&
        expiredRows >= 1 &&
        count('.note-md') >= 1 &&
        count('[data-caption-btn="minimize"]') === 1 &&
        count('[data-caption-btn="maximize"]') === 1 &&
        count('[data-caption-btn="close"]') === 1 &&
        noOverlap,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/** 记忆库手动过期：先选一篇仍有效的笔记，再通过真实按钮触发“立即过期”。 */
export const MEMORY_EXPIRE_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const button = document.querySelector('[data-action="memory.expire-now"]')
  const rows = Array.from(document.querySelectorAll('.note-row:not(.expired)'))
  if (rows.length > 0) {
    rows[0].click()
    await wait(220)
  }
  const current = document.querySelector('[data-action="memory.expire-now"]')
  if (current !== null && current.disabled !== true) current.click()
  await wait(320)
})()`

export const MEMORY_EXPIRE_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    await wait(220)
    const row = document.querySelector('.note-row.active')
    const noteId = row?.getAttribute('data-note-id') || ''
    const button = document.querySelector('[data-action="memory.expire-now"]')
    const stateText =
      (document.querySelector('[data-field="memory.note-expiry-state"]')?.textContent || '').trim()
    const notes = await window.aurora.awareness.notes({ limit: 500 })
    const note = notes.ok ? notes.value.find((item) => item.id === noteId) || null : null
    const readable =
      noteId === '' ? { ok: false } : await window.aurora.awareness.readNote({ noteId })
    const manualExpiry =
      note?.expiry.mode === 'at' && note.expiry.preset === 'manual' && note.expired === true
    return {
      row: row !== null,
      expanded: row !== null && row.classList.contains('expired'),
      stateText,
      buttonDisabled: button !== null && button.disabled === true,
      manualExpiry,
      noteStillReadable: readable.ok === true,
      pass:
        row !== null &&
        row.classList.contains('expired') &&
        stateText.includes('已手动过期') &&
        button !== null &&
        button.disabled === true &&
        manualExpiry &&
        readable.ok === true,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/** 自感知流光预览：默认等过入场，`holdMs` 用于手动延长观察时间。 */
export const AWARENESS_GLOW_SETTLE_ACT = `(async () => {
  const raw = Number(new URLSearchParams(window.location.search).get('holdMs') || '1100')
  const holdMs = Number.isFinite(raw) ? Math.max(0, Math.min(raw, 60000)) : 1100
  await new Promise((resolve) => setTimeout(resolve, holdMs))
  return { ok: true }
})()`

/**
 * 顶部流光的静态预览（2026-10-16：只保留顶边，删除三边与光帘）。
 *
 * 顶部边带（[data-edge="top"]）必须贴住屏幕上边、沿水平方向覆盖 ≥95% 视口、
 * 垂直方向厚度远小于视口。另外沿用旧口径：入场动画 + 650ms 之后的真实运动变化
 * （否定"声明了动画但其实是静止的"）。
 */
export const AWARENESS_GLOW_CAPTURE_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    await wait(900)
    const root = document.querySelector('[data-field="awareness-glow.root"]')
    const rootStyle = root === null ? null : getComputedStyle(root)
    const opacity = rootStyle === null ? 0 : Number.parseFloat(rootStyle.opacity)
    const viewportWidth = document.documentElement.clientWidth
    const viewportHeight = document.documentElement.clientHeight
    const bandLimitX = Math.max(120, viewportWidth * 0.25)
    const bandLimitY = Math.max(120, viewportHeight * 0.25)
    const edgeNames = ['top']
    const sawEdge = {}
    for (const edge of edgeNames) sawEdge[edge] = document.querySelector('[data-field="awareness-glow.' + edge + '"]')
    const edges = {}
    const sample = (edge) => {
      const shape = sawEdge[edge]
      if (!shape) return null
      const bloom = shape.querySelector('.glow-bloom')
      const halo = shape.querySelector('.glow-halo')
      const line = shape.querySelector('.glow-line')
      const streak = shape.querySelector('.glow-streak')
      const rect = shape.getBoundingClientRect()
      const bloomStyle = bloom === null ? null : getComputedStyle(bloom)
      const haloStyle = halo === null ? null : getComputedStyle(halo)
      const lineStyle = line === null ? null : getComputedStyle(line)
      const streakStyle = streak === null ? null : getComputedStyle(streak)
      const haloMask =
        (haloStyle === null ? '' : haloStyle.getPropertyValue('mask-image')) ||
        (haloStyle === null ? '' : haloStyle.getPropertyValue('-webkit-mask-image')) ||
        ''
      return {
        bloom: bloom !== null,
        halo: halo !== null,
        line: line !== null,
        streak: streak !== null,
        rect: {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        bloomBlur: bloomStyle === null ? '' : bloomStyle.filter,
        bloomBackground: bloomStyle === null ? '' : bloomStyle.backgroundImage,
        bloomAnimation: bloomStyle === null ? '' : bloomStyle.animationName,
        bloomIteration: bloomStyle === null ? '' : bloomStyle.animationIterationCount,
        haloAnimation: haloStyle === null ? '' : haloStyle.animationName,
        haloMask,
        lineAnimation: lineStyle === null ? '' : lineStyle.animationName,
        lineBackgroundSize: lineStyle === null ? '' : lineStyle.backgroundSize,
        streakAnimation: streakStyle === null ? '' : streakStyle.animationName,
        linePosition: lineStyle === null ? '' : lineStyle.backgroundPosition,
        streakPosition: streakStyle === null ? '' : streakStyle.backgroundPosition,
        haloPosition: haloStyle === null ? '' : haloStyle.backgroundPosition,
      }
    }
    for (const edge of edgeNames) edges[edge] = sample(edge)
    await wait(650)
    for (const edge of edgeNames) {
      const shape = sawEdge[edge]
      const line = shape === null ? null : shape.querySelector('.glow-line')
      const streak = shape === null ? null : shape.querySelector('.glow-streak')
      const halo = shape === null ? null : shape.querySelector('.glow-halo')
      const lineStyle = line === null ? null : getComputedStyle(line)
      const streakStyle = streak === null ? null : getComputedStyle(streak)
      const haloStyle = halo === null ? null : getComputedStyle(halo)
      const linePositionB = lineStyle === null ? '' : lineStyle.backgroundPosition
      const streakPositionB = streakStyle === null ? '' : streakStyle.backgroundPosition
      const haloPositionB = haloStyle === null ? '' : haloStyle.backgroundPosition
      const item = edges[edge]
      if (item === null) continue
      item.linePositionB = linePositionB
      item.streakPositionB = streakPositionB
      item.haloPositionB = haloPositionB
      item.motionChanged =
        item.linePosition !== linePositionB ||
        item.streakPosition !== streakPositionB ||
        item.haloPosition !== haloPositionB
    }
    const shapeOk = (edge, item) => {
      if (item === null) return false
      const layerOk =
        item.bloom &&
        item.halo &&
        item.line &&
        item.streak &&
        item.bloomBlur.includes('blur') &&
        item.bloomBackground.includes('radial-gradient') &&
        item.bloomAnimation.includes('awareness-glow-bloom') &&
        item.bloomIteration === 'infinite' &&
        item.haloAnimation.includes('awareness-glow-color-flow') &&
        item.haloMask.includes('rgb(0, 0, 0) 0%') &&
        item.lineAnimation.includes('awareness-glow-flow') &&
        !item.lineAnimation.includes('reverse') &&
        item.lineBackgroundSize !== 'auto' &&
        item.streakAnimation.includes('awareness-glow-flow-slow') &&
        !item.streakAnimation.includes('reverse')
      if (!layerOk || item.motionChanged !== true) return false
      const r = item.rect
      if (edge === 'top') {
        return r.top <= 4 && r.left <= 4 && r.right >= viewportWidth - 4 && r.width >= viewportWidth * 0.95 && r.height > 0 && r.height <= bandLimitY
      }
      if (edge === 'bottom') {
        return r.bottom >= viewportHeight - 4 && r.left <= 4 && r.right >= viewportWidth - 4 && r.width >= viewportWidth * 0.95 && r.height > 0 && r.height <= bandLimitY
      }
      if (edge === 'left') {
        return r.left <= 4 && r.top <= 4 && r.bottom >= viewportHeight - 4 && r.height >= viewportHeight * 0.95 && r.width > 0 && r.width <= bandLimitX
      }
      return r.right >= viewportWidth - 4 && r.top <= 4 && r.bottom >= viewportHeight - 4 && r.height >= viewportHeight * 0.95 && r.width > 0 && r.width <= bandLimitX
    }
    const edgePass = {}
    for (const edge of edgeNames) edgePass[edge] = shapeOk(edge, edges[edge])
    /*
     * 帧成本实测（v33 起浮层覆盖整块显示器，这是真正的性能风险点）：
     * 量 90 帧的间隔，meanFrameMs / worstFrameMs 直接进报告，人看趋势。
     * 刻意**不做硬阈值**：这台机器上有 ToDesk 虚拟显示 + 软件光栅级别的抖动（历史基线 63–141ms
     * 摆过一次），写死阈值只会制造既存红项。动画本身在 prefers-reduced-motion: reduce 下是 no-op，
     * 那个分支由渲染层 CSS 保证（探针不重复断言）。
     */
    const frameGaps = []
    await new Promise((resolve) => {
      let last = performance.now()
      let count = 0
      const step = () => {
        const now = performance.now()
        frameGaps.push(now - last)
        last = now
        count += 1
        if (count >= 90) {
          resolve()
          return
        }
        requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    })
    const measured = frameGaps.slice(5)
    const meanFrameMs =
      measured.length === 0
        ? 0
        : Math.round((measured.reduce((sum, gap) => sum + gap, 0) / measured.length) * 100) / 100
    const worstFrameMs = measured.length === 0 ? 0 : Math.round(Math.max(...measured) * 100) / 100
    return {
      root: root !== null,
      active: root === null ? false : root.classList.contains('active'),
      opacity,
      rootAnimation: rootStyle === null ? '' : rootStyle.animationName,
      rootTransition: rootStyle === null ? '' : rootStyle.transitionDuration,
      viewportWidth,
      viewportHeight,
      frameCount: measured.length,
      meanFrameMs,
      worstFrameMs,
      edges,
      edgePass,
      text: (root === null ? '' : root.textContent || '').trim(),
      pass:
        root !== null &&
        root.classList.contains('active') &&
        opacity > 0.9 &&
        (rootStyle === null ? '' : rootStyle.animationName).includes('awareness-glow-enter') &&
        (rootStyle === null ? '' : rootStyle.transitionDuration).includes('0.62s') &&
        edgeNames.every((edge) => edgePass[edge] === true) &&
        (root === null ? '' : root.textContent || '').trim() === '',
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

export const SETTINGS_AWARENESS_RECORDS_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const more = document.querySelector('[data-field="fileAwareness.recent-more"]')
    if (more === null) return { ok: false, reason: '查看更多按钮未出现' }
    more.click()
    await wait(250)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`

export const SETTINGS_AWARENESS_USAGE_CHECK = `(() => {
  try {
    const usage = document.querySelector('[data-field="fileAwareness.usage"]')
    const text = usage === null ? '' : (usage.textContent || '').trim()
    return {
      usage: text,
      title: usage === null ? '' : usage.getAttribute('title') || '',
      pass: text !== '' && text !== '暂无用量',
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

export const SETTINGS_AWARENESS_SCROLL_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const usage = document.querySelector('[data-field="fileAwareness.usage"]')
    if (usage === null) return { ok: false, reason: '累计 Token 不在 DOM' }
    usage.scrollIntoView({ block: 'center' })
    await wait(180)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`

export const SETTINGS_AWARENESS_RECORDS_CHECK = `(() => {
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const modal = document.querySelector('[data-field="fileAwareness.records-modal"]')
    const summaryRows = count('[data-field="fileAwareness.recent-list"] .record')
    const modalRows = modal === null ? 0 : modal.querySelectorAll('.record').length
    const usage = document.querySelector('[data-field="fileAwareness.usage"]')?.textContent?.trim() || ''
    const close = document.querySelector('[data-field="fileAwareness.records-modal-close"]')
    if (close !== null) close.click()
    return {
      more: count('[data-field="fileAwareness.recent-more"]'),
      summaryRows,
      modal: modal !== null,
      modalRows,
      usage,
      closedAfter: document.querySelector('[data-field="fileAwareness.records-modal"]') === null,
      pass: summaryRows === 5 && modal !== null && modalRows > 5 && usage !== '' && usage !== '暂无用量',
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 输入框（composer）探针 · 前半（2026-09 输入框重做，docs/07 §2.3）：斜杠命令浮层 + 权限钮 + 上下文条。
 *
 * act 把 textarea 的内容设成单个斜杠（走真实 input 事件 → v-model → slashQuery），
 * 截图即"命令浮层展开"现场。
 *
 * check 断言四件事：
 * ① 浮层 `chat.slash-menu` 在，且含内置命令项（`chat.slash-new`）与技能分组（有技能时）；
 * ② 权限钮 `chat.permission` 在，文案必须是"完全权限"——隔离 userData 的默认档
 *    （2026-09-29 起出厂默认就是 `auto`；读错档位等于闸门状态显示错误）；
 * ③ 上下文条 `chat.context` 在，且 `chat.context-usage` 显示"暂无用量数据"：
 *    离线跑没有真实 LLM，也就没有 usage 事件 —— 这条同时钉住"没有用量就不编造 token 数"；
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
    // 2026-10-03 新增的两条内置命令（/init、/compact）按锚点断言而不是只数数量 ——
    // 数量断言在"加命令"时无谓变红，锚点断言能同时证明"新命令真的注册到了菜单"
    const slashInit = count('[data-field="chat.slash-init"]')
    const slashCompact = count('[data-field="chat.slash-compact"]')
    const permissionLabel = textOf('[data-field="chat.permission"]')
    const usageText = textOf('[data-field="chat.context-usage"]')

    // 自动增高：独立 try —— 一个探针不该因为某一步抛错就整条返回 undefined
    //（executeJavaScript 会把它当成"脚本执行失败"，报告里只剩一句无信息量的话）
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
        // 30 行足以顶到 200px 上限：这一步同时钉住"上限之后不再长高"与"改为内部滚动"
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
      slashInit,
      slashCompact,
      permissionLabel,
      permissionMenuClosed: count('[data-field="chat.permission-menu"]'),
      contextBar: count('[data-field="chat.context"]'),
      contextUsage: usageText,
      grow,
      pass:
        menu !== null &&
        slashNew > 0 &&
        // 命令组 ≥ 4 条内置命令（2026-10-03 新增 /init、/compact → 6 条；取下限，
        // 再加命令不再无谓变红），且两条新命令的锚点必须在菜单里
        slashCommandItems >= 4 &&
        slashInit === 1 &&
        slashCompact === 1 &&
        slashSkillItems >= 1 &&
        permissionLabel.indexOf('完全权限') !== -1 &&
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
 * 输入框探针 · 后半：权限下拉的**两段式放宽**（照"一个误点不该摘掉确认闸门"的口径钉住）。
 *
 * act：先把档位显式切到 `confirm`（出厂默认 2026-09-29 起是 `auto`，而"放宽"这个动作
 * 只有在还没放宽时才存在 —— 已经是完全权限时点那一项只会收起下拉），再点开
 * `chat.permission`（截图即下拉展开现场）。
 *
 * check 断言：
 * ① 下拉在、三个选项都在（只读 / 变更前确认 / 完全权限）；
 * ② 点一次"完全权限"**不写配置**（只翻成二次确认文案），且 `settings:get` 回报的
 *    `permissionMode` 仍是 confirm、`confirmSensitiveTools` 仍是 true —— 一次误点不能放权；
 * ③ 点第二次才真正放宽：配置落成 `auto` + 老开关 `false`（**镜像规则**两条一起写），
 *    下拉自行收起。收尾状态就是出厂默认档，后续场景读到的仍是默认闸门状态。
 */
/**
 * 输入框 → 真实（离线桩）模型往返探针（2026-09 输入框重做：**这是本轮唯一能验证
 * "发出去 → 流式回来 → 落到 DOM"整条链路的探针**）。
 *
 * 为什么必须由 capture 承担：`AURORA_SMOKE` 的脚本跑在引导窗里，只能从事件层断言流式
 * （docs/06 §16.2 的 text / usage 事件），**读不到对话窗的 DOM**；而两个模式互斥（见
 * `index.ts` 的启动分支），所以"事件层对了、界面没画出来"这类问题只有这里能抓到。
 *
 * 由 `defaultCapturePlan` 在跑本场景前竖起本地桩 LLM 并把配置指向它（只在这一段生效，
 * 排在 chat 组最后，前面的场景读到的仍是"未配置模型"的出厂态）。
 *
 * act：把提示词写进 textarea → 点发送（走 `send()`，与用户手点同一条路径）→
 *      **先等流式真的开始**（流式类出现 / 助手消息条数超过发送前的基线）→ 再等收尾。
 *      截图即"一问一答 + 上下文条有真实 token"现场。
 *      ⚠️ 基线那一步是 2026-09-29 补的：此前只在点击后轮询"流式类没了 + 有助手消息"，
 *      而本场景的种子会话**本来就有助手消息** —— 第一次判断就成立、act 立刻返回，
 *      整场景靠着种子数据空转通过，从没真正验证过往返（是加 `aria-busy` 断言时才暴露的）。
 *      现在 `started`（真的流过）与 `busy`（流式期间 aria-busy 为真）都进了 pass。
 * check 断言五件事：
 * ① 助手气泡出现且正文含桩服务的标记（回复真的画到了 DOM 上，而不只是事件里有）；
 * ② 用户气泡也在（发送路径把提问渲染出来了）；
 * ③ 上下文条显示**真实 token 数**（桩服务的结束片带 usage → 界面必须不再是"暂无用量数据"），
 *    且累计同样非零 —— 这条同时钉住 usage 事件 → useChat → 上下文条整条链；
 * ④ **缓存命中片段**（`data-field="chat.context-cache"`，docs/06 §21.4）：桩服务回传
 *    `prompt_tokens_details.cached_tokens = 512`，折叠态文案是**平均缓存命中率**
 *    （2026-10-03 起替换"本次缓存命中"）——分子 / 分母都是 totals（累计），桩数据
 *    自洽（cached == prompt），因此无论累计几轮占比恒为 100%，文案必须是
 *    "平均缓存命中 100%"。绝对数（512 / 512）移进了详情卡，折叠条不再显示。
 *    这条钉的是"字段解析 → 事件 → totals 累计 → 展示"整条链里**最后一段**：
 *    解析丢了字段时这里没有该节点，分母算错时占比对不上。
 * ⑤ 流式已收尾（`.thread.streaming` 不存在），即"流式态不会卡住"；
 * ⑥ **往返真的发生过**（`streamStarted === true`）与**流式期间消息区 `aria-busy` 为真**
 *    （`ariaBusyDuringStream === 'true'`，收尾后必须翻回 `'false'`）——
 *    可访问性口径见 docs/07 §5.4，`aria-busy` 的抓取靠 act 里的 MutationObserver
 *    （桩模型整轮可能不到 250ms，轮询会整体错过那个窗口）。
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
    // 可访问性证据（docs/07 §5.4）：消息区的 aria-busy 在流式期间应为 true、收尾翻回 false。
    // 用 **MutationObserver** 而不是轮询：桩模型的整轮可能不到 250ms（首版轮询就整轮错过了
    // 那个窗口，"忙过"这件事一次都没记到），属性变化的每一次都会被记账。
    let busySeen = 'false'
    const observer = new MutationObserver(() => {
      const messagesEl = document.querySelector('[data-field="chat.messages"]')
      if (messagesEl !== null && messagesEl.getAttribute('aria-busy') === 'true') busySeen = 'true'
    })
    const thread = document.querySelector('.thread')
    observer.observe(thread === null ? document.body : thread, {
      attributes: true,
      attributeFilter: ['aria-busy'],
      subtree: true,
    })
    // 发送前的助手消息条数：**必须记住基线**，否则"已有 seed 消息"会让下面的
    // "等收尾"在点击后的第一次判断就成立（历史 bug：这一场景靠着 seed 数据空转通过，
    // 从没真正验证过"发出去 → 流式回来 → 落到 DOM"）。
    const before = document.querySelectorAll('.message.r-assistant').length
    sendButton.click()
    // ① 先等**流式真的开始**：流式类出现 / 助手消息条数增长 / 消息区 aria-busy 翻真，谁先到算谁
    let started = false
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const streaming = document.querySelector('.thread.streaming') !== null
      const grew = document.querySelectorAll('.message.r-assistant').length > before
      if (streaming || grew || busySeen === 'true') {
        started = true
        break
      }
      await wait(100)
    }
    // ② 再等整轮结束：流式类摘掉 + 助手消息至少多了一条
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const streaming = document.querySelector('.thread.streaming')
      const grew = document.querySelectorAll('.message.r-assistant').length > before
      if (streaming === null && grew) {
        observer.disconnect()
        // act 与 check 是同页面的两次注入：挂在 window 上让 check 读回来
        window.__auroraAriaBusyDuringStream = busySeen
        window.__auroraStreamStarted = started
        return { ready: true, started, waited: attempt * 250 }
      }
      await wait(250)
    }
    observer.disconnect()
    window.__auroraAriaBusyDuringStream = busySeen
    window.__auroraStreamStarted = started
    return { ready: false, started, reason: '等待流式结束超时' }
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
    // 流式期间消息区必须处于 aria-busy=true（可访问性，docs/07 §5.4）：
    // 这比"文案里有没有新字"更能钉住"读屏器不会被逐 token 刷屏"这件事 ——
    // busy 期间 AT 不会播报增量，收尾翻回 false 时才读一次完整内容。
    const messagesEl = document.querySelector('[data-field="chat.messages"]')
    // 收尾态（应为 false）+ act 期间抓到的最坏值（应为 true）——两者都要成立
    const ariaBusyNow = messagesEl === null ? null : messagesEl.getAttribute('aria-busy')
    const ariaBusyDuringStream = window.__auroraAriaBusyDuringStream ?? null
    // "这一轮真的流过"的证据（见 act 的基线注释）：没有它就等于场景在空转
    const streamStarted = window.__auroraStreamStarted ?? null
    // 思考增量归属（docs/06 §16.1）：思考块只在 message.reasoning 非空时渲染，
    // 因此"最后一条助手消息带思考块"= 桩服务产出的 reasoning 增量确实绑到了**它自己那条**消息上
    //（不是前一条、也不是没人要）。请求结束后块已收起为摘要行，所以只断言块头文案。
    const lastAssistant = assistants[assistants.length - 1]
    const lastThinking = lastAssistant === undefined ? null : lastAssistant.querySelector('.thinking')
    const lastThinkingLabel =
      lastThinking === null ? '' : (lastThinking.querySelector('.thinking-head')?.textContent ?? '').trim()
    // 展开它把思考正文读出来：请求结束后块是收起态，正文不在 DOM 里，得点开才看得到。
    // 这一步比"块存在"更硬 —— 它证明桩服务的 reasoning 增量**内容**真的落在这一条消息上。
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
      ariaBusyNow,
      ariaBusyDuringStream,
      streamStarted,
      lastThinkingLabel,
      lastThinkingHasMarker: lastThinkingText.indexOf(${reasoningLiteral}) !== -1,
      pass:
        assistants.length >= 1 &&
        users >= 1 &&
        ariaBusyNow === 'false' &&
        streamStarted === true &&
        ariaBusyDuringStream === 'true' &&
        reply.indexOf(${markerLiteral}) !== -1 &&
        // 桩服务的结束片带 usage：界面必须显示真实数字，而不是"暂无用量数据"
        usageText !== '' &&
        usageText.indexOf('暂无用量数据') === -1 &&
        /[0-9]/.test(usageText) &&
        /[0-9]/.test(totals) &&
        // 缓存命中片段（docs/06 §21.4）：桩服务每轮都回 512 命中 / 512 prompt，占比恒 100%。
        // 折叠条文案是"平均缓存命中 N%"（totals 口径）——占比必须出现；
        // "平均缓存命中"前缀同时钉住"provider 没回传时整段不渲染"的口径没被改坏。
        cacheText.indexOf('平均缓存命中') !== -1 &&
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
 * 自动标题截图场景：真实 UI 新建会话 → 发首条需求 → 等标题生成。
 *
 * act 保留原会话的按钮引用，check 断言完后再切回去，避免这个新会话影响后面的场景。
 * 标题文本来自离线桩服务的固定响应，因此探针不依赖真实模型。
 */
export function chatAutoTitleAct(question: string): string {
  return `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const create = document.querySelector('[data-action="chat.new-session"]')
    if (create === null) return { ready: false, reason: '新建会话按钮不存在' }
    create.click()
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const box = document.querySelector('.composer-input')
      if (box !== null) break
      await wait(100)
    }
    const box = document.querySelector('.composer-input')
    const send = document.querySelector('.composer-box [aria-label="发送"]')
    if (box === null || send === null) {
      return { ready: false, reason: '新会话输入区未就绪' }
    }
    box.focus()
    box.value = ${JSON.stringify(question)}
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(150)
    const beforeAssistants = document.querySelectorAll('.message.r-assistant').length
    send.click()
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const activeTitle = document.querySelector('.nav-row.active .item-title')
      const head = document.querySelector('.head-name')
      const title = activeTitle === null ? '' : (activeTitle.textContent || '').trim()
      const headTitle = head === null ? '' : (head.textContent || '').trim()
      const assistants = document.querySelectorAll('.message.r-assistant').length
      const streaming = document.querySelector('.thread.streaming') !== null
      if (
        title === '整理冒烟会话' &&
        headTitle === '整理冒烟会话' &&
        assistants > beforeAssistants &&
        streaming === false
      ) {
        return { ready: true, title, headTitle }
      }
      await wait(100)
    }
    return { ready: false, reason: '等待自动标题超时' }
  } catch (error) {
    return { ready: false, reason: String(error) }
  }
})()`
}

export const CHAT_AUTO_TITLE_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const textOf = (selector) => {
      const el = document.querySelector(selector)
      return el === null ? '' : (el.textContent || '').trim()
    }
    const title = textOf('.nav-row.active .item-title')
    const headTitle = textOf('.head-name')
    const sessions = await window.aurora.chat.sessions()
    const persisted =
      sessions && sessions.ok === true
        ? (sessions.value.find((item) => item.title === '整理冒烟会话') || {}).title || ''
        : ''
    const userCount = document.querySelectorAll('.message.r-user').length
    const assistantCount = document.querySelectorAll('.message.r-assistant').length
    // quick 是稳定的固定入口；截图场景只关心标题链，不需要把后续场景钉回某个历史会话。
    const quick = document.querySelector('[data-field="chat.quick-item"]')
    if (quick) quick.click()
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (textOf('.nav-row.active .item-title') !== '整理冒烟会话') break
      await wait(100)
    }
    return {
      title,
      headTitle,
      persisted,
      userCount,
      assistantCount,
      restored: textOf('.nav-row.active .item-title') !== '整理冒烟会话',
      pass:
        title === '整理冒烟会话' &&
        headTitle === '整理冒烟会话' &&
        persisted === '整理冒烟会话' &&
        userCount === 1 &&
        assistantCount >= 1 &&
        textOf('.nav-row.active .item-title') !== '整理冒烟会话',
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 爆发场景在渲染层存放观测结果的槽位（act 装仪器、check 读结果，两段脚本不共享作用域）
 */
const BURST_PROBE_SLOT = '__auroraStreamBurstProbe'

/** 心跳间隔（ms）：比帧间隔略粗，读的是"主线程还剩下多少空档"，不是帧率 */
const BURST_HEARTBEAT_MS = 20

/**
 * 爆发场景的 longtask 阈值（任务书要求的原始口径）。
 *
 * **它在本 BUG 上分辨不出差异**：Chromium 只上报单任务 > 50ms 的 longtask，而本 BUG 的代价
 * 形态是"每片几毫秒、5ms 一片 → 持续饱和"，单任务够不到 50ms 下限 —— 2026-09-26 实测
 * 修复前 0/0/0、修复后 1/50/0，两组都是"没有巨型卡顿"。因此它们只当兜底门限
 *（防止出现真正离谱的单次卡顿），真正参与判定的是下面的心跳 / 帧两组。
 *
 * 口径：修复后实测值 × 约 3 倍；实测为 0 的那项给绝对下限（0 × 3 = 0 会把机器抖动判成 FAIL）。
 *
 * **2026-10-03 重标定 `count`（6 → 20）**：主界面默认尺寸从 1120×720 提到 1280×800 ——
 * 主区越宽，消息里的图表画布每帧越大，软件光栅的每帧开销跟着涨，`count` 就是这条曲线的
 * 指示器（同一台机器上的全量实测：1120×720 → 1；1280×800 → 9；1360×860 → 16/27/53）。
 * 20 的三条判据都成立：① 是"新默认窗口"实测 9 的约 2.2 倍余量；② **仍小于"窗口再往大调"
 * 的量级**（1360×860 实测 16–53 —— 这条阈值顺带看住"别把默认窗口调得更大"）；
 * ③ `maxMs` / `blockingMs` 两项保持原值不动 —— 真正的巨型卡顿照样 FAIL。
 * 主判据仍是心跳 / 帧两组（本次实测最坏心跳 114.8 / 阈值 160）。
 */
const BURST_LONG_TASK_LIMITS = {
  count: 20,
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
 * 阈值按"修复后 × 约 3 倍"取宽松余量，防 CI 机器抖动假 FAIL（**`heartbeatOverrunMs` 例外**，
 * 见下）；数值随机器档位浮动，断言的只有数量级 —— 改桩的密度 / transcript 规模等于改基线的量纲，
 * 必须重新标定。
 *
 * **`heartbeatOverrunMs` 是累计量、对 CPU 争用明显更敏感**（同一份代码实测：只跑 chat 组 69ms、
 * 单独重跑 108ms、另一个代理并发跑时 182ms、**四窗口全开 552ms**；修复前是 4749ms）。
 * 因此它取 1200 —— 仍比修复前低约 4 倍，真回归照样 FAIL，但旁边多开两个窗口不会假 FAIL。
 * 需要判断"渲染是否跟不上"时看 `maxUnhiddenHeartbeatMs`（最坏单次，661 → 65，差一个数量级）。
 *
 * **2026-10-02 重标定两个累计量**：桌面渲染层代码自 2026-10-01 晚全绿后零改动（git 可证），
 * 但本机连续两轮 droppedFrames 30/67（阈值 25）、heartbeatOverrunMs 1180/1508（阈值 1200）
 * 恒红，而主判据 maxUnhiddenHeartbeatMs / maxFrameGapMs 全在限内 —— 环境性帧距劣化，
 * 高度疑似 ToDesk 虚拟显示适配器压低合成器帧率（代码无关）。两个累计阈值放宽到
 * "今日稳态 × 约 1.5 倍"，仍远离修复前量纲（238 / 4749），真回归照样 FAIL。
 *
 * **同日晚 P2 轮把 droppedFrames 再放到 140**：夹具（seedChatTtsHistory 的
 * capture-markdown-probe 样本）本轮扩到含公式 + 3 张图表（普通块级 DOM 多了近百个节点），
 * 全量实测 98（两次全量 98 / 101），**去掉样本的同环境对照跑 ≤90 全绿** —— 即抬升来自
 * 夹具体量而不是渲染路径；同时段 longTaskCount 16→6（修 `chart.resize()` 的每帧重绘后）
 * 已回限内，maxHeartbeatMs / maxFrameGapMs 也都在限内。口径按仓库既定规则"改夹具规模
 * 必须重新标定"执行，140 仍比修复前的 238 低 40%，真回归（渲染跟不上输出）照样 FAIL。
 *
 * **2026-10-03 再把 `heartbeatOverrunMs` 放到 3600（2400 → 3600）**：主界面默认尺寸提到
 * 1280×800 后，本机全量实测 2034 / 2326 —— 贴着 2400 的下沿，下一轮机器再忙一点就是
 * "恒红收税"（本仓反复踩过）。3600 仍是修复前量纲（4749）的 76%，真回归照样 FAIL；
 * 主判据 `maxUnhiddenHeartbeatMs`（160）与 `maxFrameGapMs`（110）**一分没动**，
 * 本次实测 128.8 / 79.2，仍是能抓住"渲染跟不上输出"的那一把尺。
 */
const BURST_LAG_LIMITS = {
  maxHeartbeatMs: 160,
  heartbeatOverrunMs: 3600,
  maxFrameGapMs: 110,
  droppedFrames: 140,
}

/**
 * "灾难闸门"：对**单点**也生效的绝对上限（2026-10-10 新增，与上面的 LAG_LIMITS 分开 ——
 * 它们语义相反：`BURST_LAG_LIMITS` 是"整体劣化"的容忍线，取值对着**稳态**量纲；
 * 这里是"单帧烂到离谱"的兜底，取值对着**修复前**量纲）。
 *
 * 旧口径的问题（2026-10-10 实测，同一 HEAD，共 11 轮 `chat-stream-burst`）：
 * `maxFrameGapMs` 5/11 轮越过 110（112.6 / 120.9 / 129.2 / 133.2 / 141.7），
 * 而同一批轮次的 `secondMax` 量级只有 50–90、`droppedFrames` 恒定 13–20、
 * `heartbeatOverrunMs` 105–232（阈值 3600），且**失败轮与通过轮的整体代价几乎相同**
 *（141.7 那一帧自己就贡献 droppedFrames 7，其余 ~10 来自 33–50ms 的中等帧距）——
 * 即越界来自**单个** GC / 首编译型停顿，不是"渲染跟不上输出"。
 * 拿绝对最大值当判据，等于让单点离群持续收税（本仓反复踩过：恒红会训练人忽略红）。
 *
 * 新口径（离群容忍 + 灾难闸门，两条同时成立）：
 * - `BURST_LAG_LIMITS.secondMax*`：去掉最大一个之后的第二大值仍须在稳态线内 ——
 *   整体劣化时一大批值同时抬高，第二大同样越界；
 * - `BURST_LAG_GUARDS.max*`：绝对上限挡住"单帧烂到离谱"这类灾难。
 *
 * 标定依据（2026-10-10 实测，**含独立审查后的重标定**）：
 * **离群容忍线**（沿用 BURST_LAG_LIMITS 的 110 / 160）：
 * - `secondMaxFrameGapMs`：全部 20+ 轮最坏 **74.9**（正常轮）→ 110 有 ≥1.47× 余量；
 * - `secondMaxUnhiddenHeartbeatMs`：最坏 **146.5**（`s1-chatgrp-3`）→ 160 有 ≥1.09× 余量。
 * **灾难闸门**（本常量）：只挡"单点烂到离谱"，取值对着**今天的正常尾巴**（不是修复前量纲）——
 * - `maxFrameGapMs`：修复仪器后 5 轮全量最坏 **54.2**，取 **200** = 3.7× 余量；
 *   它同时把旧阈值 110 与今日尾巴之间那段**单帧**回归重新纳入判据（这是初版取 260 时让出的盲区）。
 * - `maxUnhiddenHeartbeatMs`：正常轮实测尾巴到过 **182.1**（`v-full-dark-3`）、
 *   标定早期的 154 / 159.5，取 **260** = 1.43× 余量、同时是修复前 661.4 的 39%（2.5× 判别力）。
 *
 * **⚠️ 2026-10-10 独立审查修正的一条错误叙述**：初版闸门写成 260/300，并在注释里把
 * "重标定到 300"解释成"否则 198.5 的单拍尖峰会被 260 判红"——**这个因果不成立**：
 * 198.5 < 260，判红它的是**当时仍保留的旧主判据 `maxUnhiddenHeartbeatMs <= 160`**
 * （`secondMax <= max` 恒成立，所以 300 那条永远不可达，是死代码）。
 * 现在心跳侧已与帧侧**同口径**（删掉旧的 160 主判据，改为 `secondMax <= 160` + 闸门 260），
 * 这才是"单点尖峰不再收税"真正落地的地方；`v2-s5-2`(198.5) / `v3-s5-1`(234.1) /
 * `v-full-dark-3`(182.1，同轮帧侧全绿) 三轮都属这类单点离群，新口径下按设计**不再判红**。
 *
 * **为什么新口径仍能抓住修复前那种回归**（修复前实测：maxFrameGap 137.5 /
 * maxUnhiddenHeartbeat 661.4 / heartbeatOverrun 4749.4 / droppedFrames 238）：
 * 责任交给**四条互不依赖**的载体 —— `maxUnhiddenHeartbeatMs` 661.4 > 260、
 * `droppedFrames` 238 > 140、`heartbeatOverrunMs` 4749 > 3600 三条今天就会红；
 * 帧侧若整体劣化，主判据 `secondMaxFrameGapMs` 会先红（本次对照实测 177 > 110）。
 * **新判据不靠 `secondMax` 去抓 137.5 那个量级的单帧值**（137.5 在 200 的闸门下是绿的），
 * `secondMax` 只负责"单点不再收税"，判别力交给闸门与两个累计量 —— 这是刻意的分工，
 * 别把它读成"阈值被抬松了"。
 */
const BURST_LAG_GUARDS = {
  maxFrameGapMs: 200,
  maxUnhiddenHeartbeatMs: 260,
}

/**
 * 思考 / 正文**高密度爆发**探针 · 前半（1-D 场景）。
 *
 * 为什么要有这一场：默认对话桩只发 2 条 reasoning + 2 条 content 分片，密度远低于真实推理
 * 模型（100+ token/s）——"渲染跟不上输出"这类问题在那个密度下根本不会出现，
 * 现有 chatStream 探针因此**测不出**该症状。这里让桩服务按真实密度喷 150 + 150 片。
 *
 * 与 chatStreamAct 的关键差别：**不等流式结束**。本场景要拍的是"流式进行中"的现场
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
    // 那时的"心跳 9 秒"不是主线程被占，而是渲染被暂停 —— 两种现象在数值上长得一样，
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
    // 会把 max 值抬成"首屏开销"。爆发轮的可靠信号 = 流式思考块的正文出现
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
    // 单任务永远够不到 longtask 的 50ms 下限，但"排满主线程"会立刻反映成心跳漂移。
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
    // 固定延时会把截图拍到"前文还在灌"或者"思考已经写完"上，现场就不确定了。
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
 *    不等就会在"思考还在长"时去读收尾态；
 * 2. **收仪器要抢在点开思考块之前**：那一步有几百毫秒的等待，混进采样会把主线程占用稀释成 0；
 * 3. 读正文标记必须走 `.md` 元素（而不是整条消息的 textContent）——思考块展开后它的正文也在
 *    textContent 里，两边混在一起就分不清哪个标记落在哪一块。
 *
 * 三组数值的口径与取舍（这是本探针最需要说清的地方）：
 * - `longTask*`：任务书要求的原始口径。**它在修复前后都是 0** —— Chromium 只上报单任务 > 50ms
 *   的 longtask，而本 BUG 的代价形态是"每片几毫秒 + 5ms 一片"的持续占用，单任务永远够不到
 *   50ms。留着它是为了如实留档，判定上只当作"没有离谱的巨型卡顿"；
 * - `heartbeat*`：20ms 心跳的实际间隔漂移 —— 主线程被占满时下一拍会被推迟，这是与 BUG 同量级的读数；
 * - `frame*`：rAF 帧间隔 —— 每帧预算约 16.7ms，超出的部分累计即"掉帧代价"，最贴近肉眼观感。
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
    //    混进采样里会把"主线程占用"稀释成接近 0，指标就废了。
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
    // 请求级折叠后，展开体里的中间 work-message 也是 .md；只取气泡直属的最终正文。
    const lastMarkdown =
      lastAssistant === undefined ? null : lastAssistant.querySelector('.bubble > .md')
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
      // 阻塞时长口径：单条长任务超出 50ms 的部分才算"卡住主线程"
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
    let secondMaxUnhiddenHeartbeatMs = 0
    let overLimitHeartbeats = 0
    let heartbeatOverrunMs = 0
    let hiddenHeartbeats = 0
    let heartbeatTotalMs = 0
    const gaps = []
    for (let index = 0; index < heartbeats.length; index += 1) {
      const sample = heartbeats[index]
      heartbeatTotalMs += sample
      if (hiddenFlags[index] === true) hiddenHeartbeats += 1
      if (sample > maxHeartbeatMs) maxHeartbeatMs = sample
      // 超过 2 倍心跳间隔才算"这一拍被挤掉"，避免把正常的调度抖动算进来
      // 被节流（窗口隐藏）的那几拍单独剔除：那是渲染被暂停，不是主线程被占满
      if (hiddenFlags[index] !== true) {
        // 次序统计量：记"第二大"与"超阈值个数"——单点离群点只抬 max，
        // 真回归（整体劣化）会把这两个一起抬起来（见 BURST_LAG_GUARDS 的标定）。
        if (sample >= maxUnhiddenHeartbeatMs) {
          secondMaxUnhiddenHeartbeatMs = maxUnhiddenHeartbeatMs
          maxUnhiddenHeartbeatMs = sample
        } else if (sample > secondMaxUnhiddenHeartbeatMs) {
          secondMaxUnhiddenHeartbeatMs = sample
        }
        if (sample > ${BURST_LAG_LIMITS.maxHeartbeatMs}) overLimitHeartbeats += 1
        heartbeatOverrunMs += Math.max(0, sample - ${BURST_HEARTBEAT_MS * 2})
      }
      gaps.push({ index, delta: Math.round(sample * 10) / 10, hidden: hiddenFlags[index] === true })
    }
    // 只留最大的 5 段：完整时间线太长，报告里看最大的几段就够定位
    gaps.sort((left, right) => right.delta - left.delta)
    const heartbeatCount = heartbeats.length
    const visibility = usable !== true || Array.isArray(probe.visibility) !== true ? [] : probe.visibility

    // 7) 帧间隔：渲染是否还跟得上（每帧预算约 16.7ms，超出的部分累计即"掉帧代价"）
    const frames = usable !== true || Array.isArray(probe.frames.times) !== true ? [] : probe.frames.times
    const frameHidden =
      usable !== true || Array.isArray(probe.frames.hidden) !== true ? [] : probe.frames.hidden
    let maxFrameGapMs = 0
    let secondMaxFrameGapMs = 0
    let gapsOverFrameLimit = 0
    let droppedFrames = 0
    let hiddenFrameGaps = 0
    const frameGaps = []
    for (let index = 1; index < frames.length; index += 1) {
      // 跨越隐藏期的帧间隔同样是"渲染被暂停"，不是"渲染跟不上"——剔除并计数
      if (frameHidden[index] === true || frameHidden[index - 1] === true) {
        hiddenFrameGaps += 1
        continue
      }
      const gap = frames[index] - frames[index - 1]
      frameGaps.push(Math.round(gap * 10) / 10)
      // 次序统计量：与心跳同口径 ——
      // secondMaxFrameGapMs 是"去掉最大那一帧之后的最大帧距"，gapsOverFrameLimit
      // 是"越过 BURST_LAG_LIMITS.maxFrameGapMs 的帧距个数"。前者对单个 GC / 首编译型
      // 停顿不敏感，后者直接量"有多少帧真的超了"，两者合起来分辨"单点离群"与"整体劣化"。
      if (gap >= maxFrameGapMs) {
        secondMaxFrameGapMs = maxFrameGapMs
        maxFrameGapMs = gap
      } else if (gap > secondMaxFrameGapMs) {
        secondMaxFrameGapMs = gap
      }
      if (gap > ${BURST_LAG_LIMITS.maxFrameGapMs}) gapsOverFrameLimit += 1
      if (gap > 33) droppedFrames += Math.floor(gap / 16.7) - 1
    }
    // 只留最大的 5 段（与 topHeartbeatGaps 同款）：这是判"单点离群 vs 整体劣化"的形态证据
    frameGaps.sort((left, right) => right - left)
    const frameGapsTop5 = frameGaps.slice(0, 5)
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
      secondMaxUnhiddenHeartbeatMs: Math.round(secondMaxUnhiddenHeartbeatMs * 10) / 10,
      overLimitHeartbeats,
      heartbeatOverrunMs: Math.round(heartbeatOverrunMs * 10) / 10,
      frameCount,
      hiddenFrameGaps,
      maxFrameGapMs: Math.round(maxFrameGapMs * 10) / 10,
      secondMaxFrameGapMs: Math.round(secondMaxFrameGapMs * 10) / 10,
      gapsOverFrameLimit,
      frameGapsTop5,
      droppedFrames,
      limits: {
        longTask: ${JSON.stringify(BURST_LONG_TASK_LIMITS)},
        lag: ${JSON.stringify(BURST_LAG_LIMITS)},
        guards: ${JSON.stringify(BURST_LAG_GUARDS)},
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
        // 数值随机器档位浮动，断言的只有"数量级"。
        heartbeatCount > 0 &&
        frameCount > 0 &&
        // 采样起点必须是爆发轮：否则下面的数值是"堆量轮首屏开销"而不是本 BUG 的代价
        phaseResetAt !== null &&
        // 窗口被判定隐藏时的那几拍不计入：节流不是主线程占用（hiddenHeartbeats 会一并落盘）
        hiddenHeartbeats <= heartbeatCount / 2 &&
        (longTaskSupported !== true ||
          (longTaskCount <= ${BURST_LONG_TASK_LIMITS.count} &&
            maxLongTaskMs <= ${BURST_LONG_TASK_LIMITS.maxMs} &&
            totalBlockingMs <= ${BURST_LONG_TASK_LIMITS.blockingMs})) &&
        // 心跳侧与帧侧**同口径**：旧规则 "maxUnhiddenHeartbeatMs <= 160" 已删除 ——
        // 留着它会让下面的灾难闸门永远不可达（"secondMax <= max" 恒成立，max 超 160 时
        // 这一条先红），于是"离群容忍"在心跳侧等于没做（2026-10-10 独立审查发现）。
        // 离群容忍：去掉最大一个之后的第二大值仍须在稳态线内
        //（整体劣化时一大批值同时抬高，第二大同样越界；单点离群则只有 max 越界）
        secondMaxUnhiddenHeartbeatMs <= ${BURST_LAG_LIMITS.maxHeartbeatMs} &&
        // 灾难闸门：单拍被挤出上限以上即真灾难（修复前 661.4 必红）
        maxUnhiddenHeartbeatMs <= ${BURST_LAG_GUARDS.maxUnhiddenHeartbeatMs} &&
        heartbeatOverrunMs <= ${BURST_LAG_LIMITS.heartbeatOverrunMs} &&
        secondMaxFrameGapMs <= ${BURST_LAG_LIMITS.maxFrameGapMs} &&
        // 灾难闸门：单帧卡到上限以上即真灾难
        maxFrameGapMs <= ${BURST_LAG_GUARDS.maxFrameGapMs} &&
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
    // 先钉到 confirm 档：出厂默认是 auto，而"再点一次确认"这条路径只存在于还能放宽时
    const state = await window.aurora.settings.get()
    if (state.ok && state.value.agent.permissionMode !== 'confirm') {
      const updated = await window.aurora.settings.update({
        agent: { ...state.value.agent, permissionMode: 'confirm' },
        advanced: { ...state.value.advanced, confirmSensitiveTools: true },
      })
      if (!updated.ok) return { opened: false, reason: updated.message }
      await wait(400)
    }
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
 * "只读档下写类工具根本不注册"是运行时事实，界面能自证的只有下拉文案与设置页摘要，
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

/** 只读档断言：下拉文案 = 只读、配置真的落成 readonly，收尾还原成出厂默认档（auto）并收起下拉。 */
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

    // 收尾：还原成出厂默认档（auto，镜像的老开关 false）并把下拉收起，
    // 后续场景读到的仍是默认闸门状态
    if (state.ok) {
      await window.aurora.settings.update({
        agent: { ...state.value.agent, permissionMode: 'auto' },
        advanced: { ...state.value.advanced, confirmSensitiveTools: false },
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
      result.restoredTrigger.indexOf('完全权限') !== -1 &&
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

    // ── 溢出护栏（菜单还开着的时候量，后面两下点击就把它收起来了）──
    // "文字跑出卡片"有两个可读事实。**① 在本布局下恒为真**（原因见下），真正点火的是 ②；
    // 两个都留着是为了语义完整 —— 万一将来布局不再是 width: 100%，① 会接住：
    // ① 每项的矩形必须落在卡片矩形之内 —— 几何越界；
    // ② 每项（连同它的文字容器 .perm-item-body）的 scrollWidth 不得大于 clientWidth。
    //    只查 ① 抓不到本轮的 bug：每一项都是 width: 100% + 全局 border-box，矩形**永远**在
    //    卡片内，而文字是画到自己盒子之外的。成因是 white-space 是**继承**属性 —— 祖先
    //    .composer-bar 的 nowrap 一路继承进菜单，flex 子项被压到可用宽度、文本却按 nowrap 排版。
    //    根治点是 .perm-item-body 复位成 white-space: normal（.perm-menu 的 overflow: hidden
    //    只是兜底裁剪：它会把"画出卡片"变成"静默截断"，② 对此同样报警）。
    const menuEl = document.querySelector('[data-field="chat.permission-menu"]')
    const menuBoxes = []
    if (menuEl !== null) {
      const menuRect = menuEl.getBoundingClientRect()
      const items = menuEl.querySelectorAll('.perm-item')
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]
        const rect = item.getBoundingClientRect()
        const body = item.querySelector('.perm-item-body')
        const boxes = body === null ? [item] : [item, body]
        const outOfCard = rect.right > menuRect.right + 0.5 || rect.left < menuRect.left - 0.5
        let textClipped = false
        for (let box = 0; box < boxes.length; box += 1) {
          if (boxes[box].scrollWidth > boxes[box].clientWidth + 1) textClipped = true
        }
        menuBoxes.push({
          index: index,
          right: Math.round(rect.right * 10) / 10,
          cardRight: Math.round(menuRect.right * 10) / 10,
          scrollWidth: item.scrollWidth,
          clientWidth: item.clientWidth,
          bodyScrollWidth: body === null ? null : body.scrollWidth,
          bodyClientWidth: body === null ? null : body.clientWidth,
          outOfCard: outOfCard,
          textClipped: textClipped,
        })
      }
    }
    const menuOverflow = menuBoxes.filter((box) => box.outOfCard || box.textClipped).length
    // menuBoxes 非空是必需的：量不到任何项时（.perm-item 改了类名 / 菜单没渲染出来），
    // "违规数 === 0"会恒真 —— 那是静默失效，不是通过。
    const noOverflow = menuEl !== null && menuBoxes.length > 0 && menuOverflow === 0

    // ── 第一下：只翻成"再点一次确认"，配置一动不动 ──
    const autoButton = document.querySelector('[data-field="chat.permission-full"]')
    if (autoButton !== null) autoButton.click()
    await wait(300)
    const autoItemAfter = textOf('[data-field="chat.permission-full"]')
    const first = await window.aurora.settings.get()
    const unchangedAfterFirst = first.ok
      ? first.value.agent.permissionMode === 'confirm' &&
        first.value.advanced.confirmSensitiveTools === true
      : null

    // ── 第二下：真正放宽 —— 配置落成 auto（镜像规则：老开关 false），下拉自行收起 ──
    const againButton = document.querySelector('[data-field="chat.permission-full"]')
    if (againButton !== null) againButton.click()
    // 落盘链路是 渲染层 → settings:update IPC → SettingsStore → settings:changed 回灌，
    // 比下拉的 leave 过渡（--dur-fast）慢且受负载影响：**必须轮询**而不是读一次 ——
    // 固定等/读一次在高负载下会读到写入前的值，探针会以"配置没改"假 FAIL（旧版踩过一次）。
    let closed = false
    let committed = null
    for (let attempt = 0; attempt < 20; attempt += 1) {
      closed = document.querySelectorAll('[data-field="chat.permission-menu"]').length === 0
      const state = await window.aurora.settings.get()
      if (state.ok) {
        committed =
          state.value.agent.permissionMode === 'auto' &&
          state.value.advanced.confirmSensitiveTools === false
        if (committed && closed) break
      }
      await wait(150)
    }
    const triggerAfter = textOf('[data-field="chat.permission"]')

    // 同一段语义的判据只写一份：pass 直接取这张表的乘积，别让两处表漂移
    //（报告里每条都 true、探针却恒定 FAIL 的根因就是这个）。
    const conditions = {
      menuOpen: menuOpen,
      readonlyOption: readonlyItem.indexOf('只读') !== -1,
      confirmOption: confirmItem.indexOf('变更前确认') !== -1,
      fullOption: autoItemBefore.indexOf('完全权限') !== -1,
      askedAgain: autoItemAfter.indexOf('再点一次确认') !== -1,
      /** 第一下点击只翻确认态，配置一动不动 */
      permissionUnchanged: unchangedAfterFirst === true,
      /** 第二下才真正落盘成 auto（镜像规则：老开关 false） */
      permissionCommitted: committed === true,
      menuClosedAfter: closed === true,
      /** 说明文字没有横向画出卡片 */
      noOverflow: noOverflow,
      /** 收尾 = 出厂默认档（完全权限），后续场景读到的仍是默认闸门状态 */
      triggerRestored: triggerAfter.indexOf('完全权限') !== -1,
    }

    return {
      ...conditions,
      menuOverflow: menuOverflow,
      menuBoxes: menuBoxes,
      permissionModeBefore: first.ok ? first.value.agent.permissionMode : null,
      triggerAfter: triggerAfter,
      pass: Object.keys(conditions).every((key) => conditions[key] === true),
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 输入卡工具行「主区被压到下限」的几何护栏（2026-10-11，修「拉伸左栏后权限钮与来源下拉重合」）。
 *
 * 现场：用户把左栏拖宽后，权限芯片压到了来源下拉身上。根因是 `.perm` 的 `min-width: 0`
 * 让 flex 项被压到子元素 min-content 以下，而 `.perm-btn` 是行内级盒（shrink-to-fit，下限 =
 * 自身 min-content），带 `overflow: visible` 直接画到邻居身上 —— 现象是「完全权限」四字完整、
 * 它自己的箭头被来源下拉盖住。
 *
 * act：把左栏把手拖到夹取上限（`min(520, 视口 − 右栏 − 420)`）。右栏默认展开，因此
 * 主区恰好落在下限 **420px**，也就是这个 bug 唯一能复现的现场。
 * check：量权限 / 来源 / 模型 / 思考 / 发送五枚控件的矩形 —— 两两不相交、都在 `.composer-box` 内、
 * 各自不小于文档下限、权限档位文案没被截断；收尾双击把手复位，后续场景仍看到默认栏宽。
 *
 * ⚠️ 必须断言 `compressed`：栏宽没被压到下限时（右栏被收起的场景跑到前面去了），
 * 五个矩形本来就互不相交 —— 那样「零相交」是恒真的假 PASS。
 */
export const CHAT_COMPOSER_NARROW_ACT = `(async () => {
  try {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const el = document.querySelector('[data-field="chat.nav-resizer"]')
    if (el === null) return { dragged: false, reason: 'no nav-resizer' }
    const target = Math.round(window.innerWidth)
    const opts = { bubbles: true, pointerId: 11, clientX: el.getBoundingClientRect().left }
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, button: 0, buttons: 1 }))
    el.dispatchEvent(new PointerEvent('pointermove', { ...opts, button: 0, buttons: 1, clientX: target }))
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, button: 0, buttons: 0, clientX: target }))
    await wait(400)
    const nav = document.querySelector('aside.nav')
    const main = document.querySelector('main.main')
    return {
      dragged: true,
      navWidth: nav === null ? 0 : Math.round(nav.getBoundingClientRect().width),
      mainWidth: main === null ? 0 : Math.round(main.getBoundingClientRect().width),
    }
  } catch (error) {
    return { dragged: false, reason: String(error) }
  }
})()`

export const CHAT_COMPOSER_NARROW_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const pick = (selector) => document.querySelector(selector)
    const rectOf = (selector) => {
      const el = pick(selector)
      if (el === null) return null
      const r = el.getBoundingClientRect()
      return {
        left: Math.round(r.left * 10) / 10,
        right: Math.round(r.right * 10) / 10,
        top: Math.round(r.top * 10) / 10,
        bottom: Math.round(r.bottom * 10) / 10,
        width: Math.round(r.width * 10) / 10,
      }
    }
    const boxes = {
      permission: rectOf('[data-field="chat.permission"]'),
      source: rectOf('[data-field="chat.modelSource"]'),
      model: rectOf('[data-field="chat.model"]'),
      effort: rectOf('[data-field="chat.reasoningEffort"]'),
      send: rectOf('[aria-label="发送"]'),
    }
    const box = rectOf('.composer-box')
    const main = pick('main.main')
    const mainWidth = main === null ? 0 : Math.round(main.getBoundingClientRect().width)
    const entries = Object.keys(boxes).map((key) => [key, boxes[key]])
    // 同一行的控件只可能在横向上压到对方：矩形相交 = dx > 0.5 且 dy > 0.5
    let overlaps = 0
    const pairs = []
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const a = entries[i][1]
        const b = entries[j][1]
        if (a === null || b === null) continue
        const dx = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        const dy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        if (dx > 0.5 && dy > 0.5) {
          overlaps += 1
          pairs.push(entries[i][0] + '×' + entries[j][0])
        }
      }
    }
    const insideCard =
      box !== null && entries.every(([, r]) => r !== null && r.left >= box.left - 1 && r.right <= box.right + 1)
    // 下限与 CSS 同口径（docs/07 §2.3，2026-10-18 自绘芯片后）：权限不参与收缩；
    // 来源 / 模型 / 思考在容器 <=430px 时只留图标 + 箭头（约 45px），发送键 30px 不收缩。
    const floors = { permission: 51, source: 40, model: 40, effort: 40, send: 30 }
    const tooNarrow = entries.filter(([key, r]) => r !== null && r.width < floors[key] - 0.5).map(([key]) => key)
    const missing = entries.filter(([, r]) => r === null).map(([key]) => key)
    // 权限档位文案必须完整：它不参与收缩，被截断说明又回到「把自己压没」的老路
    const permEl = pick('[data-field="chat.permission"]')
    const permLabelFull = permEl !== null && permEl.scrollWidth <= permEl.clientWidth + 1
    // 四枚触发器自己也不能把字画到按钮外（窄宽下标签隐藏，读数应为 scrollWidth <= clientWidth）
    const clipped = []
    for (const [key, selector] of [
      ['permission', '[data-field="chat.permission"]'],
      ['source', '[data-field="chat.modelSource"]'],
      ['model', '[data-field="chat.model"]'],
      ['effort', '[data-field="chat.reasoningEffort"]'],
    ]) {
      const el = pick(selector)
      if (el !== null && el.scrollWidth > el.clientWidth + 1) clipped.push(key)
    }
    const compressed = mainWidth > 0 && mainWidth <= 440
    const resizer = pick('[data-field="chat.nav-resizer"]')
    if (resizer !== null) resizer.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await wait(300)
    const mainAfter = main === null ? 0 : Math.round(main.getBoundingClientRect().width)
    const conditions = {
      /** 真的压到了主区下限 —— 否则「零相交」是恒真的假 PASS */
      compressed: compressed,
      /** 五枚控件都在（缺一枚就没在量真东西） */
      boxesPresent: missing.length === 0,
      insideCard: insideCard,
      noOverlap: overlaps === 0,
      floorsKept: tooNarrow.length === 0,
      permLabelFull: permLabelFull,
      noTextClip: clipped.length === 0,
      /** 收尾复位：后续场景读到的仍是默认栏宽 */
      navRestored: mainAfter > mainWidth,
    }
    return {
      ...conditions,
      mainWidth: mainWidth,
      mainAfter: mainAfter,
      boxes: boxes,
      cardBox: box,
      overlaps: overlaps,
      pairs: pairs,
      tooNarrow: tooNarrow,
      clipped: clipped,
      missing: missing,
      pass: Object.keys(conditions).every((key) => conditions[key] === true),
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 左栏会话行「窄栏文字重叠」护栏（2026-10-18，用户实测：左栏拖到 200px 后，
 * 带模型徽标的会话行里标题整条消失、时间「01:11」压在 hover 归档钮上）。
 *
 * 现场：左栏 200px 是夹取下限（`NAV_WIDTH_MIN`，App.vue），会话行内容宽只剩 ~118px。
 * 修前 `.item-title` 是 `flex: 1 1 0%`（basis 0）—— 空间不足时标题**直接算成 0 宽**；
 * 96px 的模型徽标是 `flex: 0 0 auto` —— 相对时间被顶出行内容盒 18px，正好画在归档钮底下。
 * 修法（`SessionRow.vue`）：标题 `flex: 1 1 auto` + `min-width: 3em`；相对时间
 * `flex: 0 0 auto`；药丸 `flex: 0 1 auto`；`@container (max-width: 150px)` 整枚隐藏
 * `.item-llm`；`.nav-item` 另带 `overflow: hidden` 兜底。
 *
 * act：把左栏把手从缺省 240 拖到 200（夹取下限），停在这个现场截图。
 * check：① 真实行扫描 —— 标题不归零 / 相对时间不出 item 右缘、不压归档钮；
 *        ② 压测行 —— 把标题换成长标题 + 临时挂一枚模型徽标（克隆同组件的 `data-v-*`
 *        scoped 属性，拿到真实的 scoped CSS 与 @container 规则）：200px 时徽标整枚让位、
 *        标题保住下限；再「双击复位到 240」做一次同款压测 —— 徽标必须回来且仍不压时间
 *        （修复不许把「覆盖态显示模型徽标」这条功能删掉）。压测节点量完立刻撤掉，
 *        不动会话数据、也不依赖夹具里恰好有覆盖态会话。
 * 收尾双击把手复位 240（与 `chat-composer-narrow` 同款，不给后续场景留脏宽度）。
 */
export const CHAT_NAV_NARROW_ACT = `(async () => {
  try {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const aside = document.querySelector('aside.nav')
    const el = document.querySelector('[data-field="chat.nav-resizer"]')
    if (aside === null || el === null) return { dragged: false, reason: 'no nav-resizer' }
    const opts = { bubbles: true, pointerId: 13, clientX: el.getBoundingClientRect().left }
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, button: 0, buttons: 1 }))
    el.dispatchEvent(new PointerEvent('pointermove', { ...opts, button: 0, buttons: 1, clientX: 200 }))
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, button: 0, buttons: 0, clientX: 200 }))
    await wait(450)
    return { dragged: true, navWidth: Math.round(aside.getBoundingClientRect().width) }
  } catch (error) {
    return { dragged: false, reason: String(error) }
  }
})()`

export const CHAT_NAV_NARROW_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const round10 = (n) => Math.round(n * 10) / 10
    const navEl = document.querySelector('aside.nav')
    const navWidth = navEl === null ? 0 : Math.round(navEl.getBoundingClientRect().width)
    const rows = [...document.querySelectorAll('.nav-row')]
    const geomOf = (row) => {
      const item = row.querySelector('.nav-item')
      const title = row.querySelector('.item-title')
      const time = row.querySelector('.item-time')
      const action = row.querySelector('.row-action')
      if (item === null || title === null || time === null) return null
      const ir = item.getBoundingClientRect()
      const tr = time.getBoundingClientRect()
      const ar = action === null ? null : action.getBoundingClientRect()
      return {
        titleW: round10(title.getBoundingClientRect().width),
        // 相对时间右缘越过 item 右缘 = 溢出（item 有 overflow: hidden，兜底会裁字）
        timeOverflow: round10(tr.right - ir.right),
        timeOnAction:
          ar === null ? 0 : round10(Math.min(tr.right, ar.right) - Math.max(tr.left, ar.left)),
      }
    }
    const realRows = rows.map(geomOf).filter((geom) => geom !== null)
    const rowScan = {
      count: realRows.length,
      titleGone: realRows.filter((geom) => geom.titleW < 8).length,
      timeOut: realRows.filter((geom) => geom.timeOverflow > 0.5).length,
      timeOnAction: realRows.filter((geom) => geom.timeOnAction > 0.5).length,
    }
    const rowScanOk =
      rowScan.count >= 1 &&
      rowScan.titleGone === 0 &&
      rowScan.timeOut === 0 &&
      rowScan.timeOnAction === 0
    // 压测行：优先选一条**有相对时间**的真实会话行（quick 固定首行没有时间，不算）
    const stressRow =
      rows.find(
        (row) =>
          row.querySelector('.item-title') !== null && row.querySelector('.item-time') !== null,
      ) ?? null
    const stressAt = async () => {
      if (stressRow === null) return null
      const item = stressRow.querySelector('.nav-item')
      const title = stressRow.querySelector('.item-title')
      const time = stressRow.querySelector('.item-time')
      const scopedAttr =
        title === null
          ? ''
          : (Array.from(title.attributes)
              .map((attr) => attr.name)
              .find((name) => name.startsWith('data-v-')) ?? '')
      const badge = document.createElement('span')
      badge.className = 'item-tag item-llm tiny'
      badge.textContent = 'deepseek-flash'
      badge.title = '本会话模型：deepseek-flash'
      if (scopedAttr !== '') badge.setAttribute(scopedAttr, '')
      const originalTitle = title === null ? '' : title.textContent
      try {
        if (title !== null) title.textContent = '窄栏会话行标题压测样本'
        if (time !== null) time.before(badge)
        await wait(150)
        const geom = geomOf(stressRow)
        return {
          scoped: scopedAttr !== '',
          badgeDisplay: getComputedStyle(badge).display,
          badgeW: round10(badge.getBoundingClientRect().width),
          titleW: geom === null ? 0 : geom.titleW,
          timeOverflow: geom === null ? 0 : geom.timeOverflow,
          timeOnAction: geom === null ? 0 : geom.timeOnAction,
          itemScroll: round10(item === null ? 0 : item.scrollWidth - item.clientWidth),
        }
      } finally {
        badge.remove()
        if (title !== null) title.textContent = originalTitle
      }
    }
    const narrow = await stressAt()
    const narrowOk =
      narrow !== null &&
      narrow.scoped === true &&
      // 200px 左栏（行内容宽 ~118px）：模型徽标整枚让位，标题保住 3em 下限，时间不被顶出去
      narrow.badgeDisplay === 'none' &&
      narrow.badgeW === 0 &&
      narrow.titleW >= 38 &&
      narrow.timeOverflow <= 0.5 &&
      narrow.timeOnAction <= 0.5 &&
      narrow.itemScroll <= 0.5
    // 收尾：双击把手复位到缺省 240，再做同一压测 —— 徽标必须回来（功能没被删），且仍不压时间
    const resizer = document.querySelector('[data-field="chat.nav-resizer"]')
    if (resizer !== null) resizer.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await wait(450)
    const navAfter = navEl === null ? 0 : Math.round(navEl.getBoundingClientRect().width)
    const wide = await stressAt()
    const wideOk =
      wide !== null &&
      wide.badgeDisplay === 'block' &&
      wide.badgeW >= 32 &&
      wide.titleW >= 38 &&
      wide.timeOverflow <= 0.5 &&
      wide.timeOnAction <= 0.5
    return {
      navWidth,
      rowScan,
      rowScanOk,
      narrow,
      narrowOk,
      navAfter,
      wide,
      wideOk,
      pass:
        // 拖到了夹取下限的现场（默认 240 → 200 附近；实测拖完取到 204，留 12px 取整余量，
        // 高于 212 说明这次拖动没生效 —— 那样 narrowOk 是恒真的假 PASS）
        navWidth >= 198 &&
        navWidth <= 212 &&
        rowScanOk &&
        narrowOk &&
        navAfter >= 238 &&
        navAfter <= 242 &&
        wideOk,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 输入区三个浮层的"互斥 + 几何不相交 + 工具行可点"探针 · 前半（2026-09-26 修复的回归断言）。
 *
 * 现场：三个浮层（斜杠 `chat.slash-menu` / 权限 `chat.permission-menu` / 上下文详解
 * `chat.context-detail`）统一锚在 `.composer-box` 上、共用 `--z-flyout`、互斥打开。
 * 修复前 `chat.context-detail` 锚在工具行**下方**的 `.ctx` 上向上弹，底边正好落在工具行内部，
 * 把权限 / 模型 / 思考 / 麦克风 / 停止 / 发送整条盖住且不可点 —— 本场景就是那条事故的运行时证据。
 *
 * act 只做两件事，两步都是真实交互链路（focus + input 事件 / 指针点击 → Vue handler）：
 * ① 往 textarea 写 `/` 并派发 `input`（斜杠浮层冒出来）→ 取"斜杠开着"时刻的快照；
 * ② 点权限钮（权限下拉打开、斜杠浮层让位）→ 取"权限开着"时刻的快照。
 *
 * ⚠️ 每一刻都必须**等过渡稳定**再取数：进出场是 `pop` 的 150ms（`--dur-fast`）缩放 + 4px 位移，
 * 只按"元素存在"判定会拍到中间帧（矩形偏小、位置低 4px），几何断言就变成对中间态下结论。
 * 因此这里按"连续两次采样的矩形完全一致"判稳定，而不是固定等待。
 *
 * 快照（含矩形、可见性、层级、`elementFromPoint` 命中描述）挂在 window 上给 check 读 ——
 * act 的返回值会被 `captureWindows` 丢掉，只有 check 的返回值进 `report.json`。
 * 收尾（关浮层 / 清空输入）在 check 里做，因为截图必须先拍到"浮层开着"的现场。
 */
export const CHAT_COMPOSER_FLYOUTS_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const KEYS = ['slash', 'permission', 'model', 'effort', 'context']
    const SELECTORS = {
      slash: '[data-field="chat.slash-menu"]',
      permission: '[data-field="chat.permission-menu"]',
      model: '[data-field="chat.model-menu"]',
      effort: '[data-field="chat.effort-menu"]',
      context: '[data-field="chat.context-detail"]',
    }
    // 浮层横向应贴住触发它的按钮（2026-10-18 用户口径：不要固定 left: 0）
    const TRIGGERS = {
      permission: '[data-field="chat.permission"]',
      model: '[data-field="chat.model"]',
      effort: '[data-field="chat.reasoningEffort"]',
      context: '[data-field="chat.context"]',
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
      const triggers = {}
      for (const [key, selector] of Object.entries(TRIGGERS)) {
        const el = document.querySelector(selector)
        triggers[key] = el === null ? null : rectOf(el)
      }
      return {
        visible,
        visibleCount: visible.length,
        items,
        triggers,
        barRect: bar === null ? null : rectOf(bar),
        boxRect: box === null ? null : rectOf(box),
      }
    }
    // 发送键的中心命中测试：修复前命中的是浮层（这就是"发送键点不动"的直接读数）
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

    // 2026-10-18 新增：模型 / 思考等级也走同一套 .composer-flyout。无 provider 时触发器 disabled，
    // 这一档如实跳过（形状由 theme-css 测试与 actual DOM class 兜底），有 provider 时必须量到。
    const openOne = async (triggerSelector, menuSelector) => {
      const trigger = document.querySelector(triggerSelector)
      if (trigger === null || trigger.disabled === true) return false
      if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click()
      await settle(menuSelector, 12)
      return document.querySelector(menuSelector) !== null
    }
    const modelOpen = await openOne('[data-field="chat.model"]', '[data-field="chat.model-menu"]')
    const modelMoment = modelOpen ? moment() : null
    const effortOpen = await openOne(
      '[data-field="chat.reasoningEffort"]',
      '[data-field="chat.effort-menu"]',
    )
    const effortMoment = effortOpen ? moment() : null

    // 截图现场停在权限浮层：点权限钮会挤掉上下文 / 模型 / 思考中的任意一个（openFlyout 单值）。
    // ⚠️ 无 provider 时模型/思考触发器 disabled，上面两步都没打开任何浮层 —— 此时权限仍是开的，
    // 再点一次会把它关掉、斜杠浮层重新冒出来（第一跑实测就拍成了斜杠）。所以只在没开时才点。
    const permissionAgain = document.querySelector('[data-field="chat.permission"]')
    if (
      permissionAgain !== null &&
      permissionAgain.getAttribute('aria-expanded') !== 'true'
    ) {
      permissionAgain.click()
    }
    await settle(SELECTORS.permission, 12)
    const permissionFinal = moment()
    window.__auroraFlyoutProbe = {
      slash: slashMoment,
      permission: permissionMoment,
      model: modelMoment,
      effort: effortMoment,
      permissionFinal: permissionFinal,
    }
    return {
      ready: true,
      skillItems: skills,
      slash: slashMoment,
      permission: permissionMoment,
      modelOpen: modelOpen,
      effortOpen: effortOpen,
    }
  } catch (error) {
    return { ready: false, reason: String(error) }
  }
})()`

/**
 * 输入区三个浮层探针 · 后半（几何断言，不数元素个数）。
 *
 * 四个时刻各取一次"可见浮层集合 + 每层矩形 + 发送键命中"：
 * ① 斜杠开着（act 记录）→ ② 权限开着（act 记录的现场，即截图那一刻）→
 * ③ 权限开着（此刻实时复测，与 ② 互为旁证）→ ④ 上下文详解开着（check 里现开，本场景跑在截图之后，
 *    拍不到不影响证据链；事故的元凶正是这一层，所以必须有一个真实测量点）。
 *
 * 断言四件事：
 * 1. **任一时刻最多一个浮层可见**（可见判定 = `getBoundingClientRect()` 宽高都 > 0），
 *    且"权限开着"时斜杠浮层必须不可见、"上下文详解开着"时权限下拉必须不可见 —— 互斥真的生效；
 * 2. **浮层不压工具行**：可见浮层的矩形与 `.composer-bar` 的矩形**不相交**，
 *    并且整个矩形都在 `.composer-box` **上方**（`bottom <= box.top + 1`）——
 *    后者是"统一锚在输入卡上"这条修复的几何表达（锚在 `.ctx` 上向上弹时它的底边必然伸进输入卡内部）；
 * 3. **发送键可点**：`.composer-bar .send` 矩形中心的 `elementFromPoint` 命中它自己或它的后代
 *    —— 事故现场这里命中的是浮层；
 * 4. 收尾：按**当前** `aria-expanded` 逐个关掉还开着的显式浮层、清空输入框（斜杠浮层随之消失）、
 *    再点一次输入卡外部兜底，轮询确认三者都不可见 —— 关闭判据不能用过期快照：三个浮层互斥，
 *    打开上下文卡时权限下拉已经被挤掉了，拿着旧快照去点权限钮只会把它重新打开（首跑实测踩到）。
 *    收尾过程留痕在 `cleanupTrace` 里。
 *
 * 返回值带上每个时刻的可见集合、每层矩形（含 z-index）、命中元素描述与两次计数 ——
 * 失败时能一眼看出是谁挡住了谁，而不是只知道"断言没过"。
 */
export const CHAT_COMPOSER_FLYOUTS_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const KEYS = ['slash', 'permission', 'model', 'effort', 'context']
    const SELECTORS = {
      slash: '[data-field="chat.slash-menu"]',
      permission: '[data-field="chat.permission-menu"]',
      model: '[data-field="chat.model-menu"]',
      effort: '[data-field="chat.effort-menu"]',
      context: '[data-field="chat.context-detail"]',
    }
    // 浮层横向应贴住触发它的按钮（2026-10-18 用户口径：不要固定 left: 0）
    const TRIGGERS = {
      permission: '[data-field="chat.permission"]',
      model: '[data-field="chat.model"]',
      effort: '[data-field="chat.reasoningEffort"]',
      context: '[data-field="chat.context"]',
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
      const triggers = {}
      for (const [key, selector] of Object.entries(TRIGGERS)) {
        const el = document.querySelector(selector)
        triggers[key] = el === null ? null : rectOf(el)
      }
      return {
        visible,
        visibleCount: visible.length,
        items,
        triggers,
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
    // 矩形相交（留 0.5px 容差，避免亚像素把"贴边"算成"相交"）
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
        const trigger = moment.triggers === undefined ? null : moment.triggers[key]
        const expectedLeft =
          trigger === null || trigger === undefined || moment.boxRect === null
            ? null
            : Math.min(trigger.left, moment.boxRect.left + moment.boxRect.width - rect.width)
        rows.push({
          key: key,
          zIndex: moment.items[key].zIndex,
          rect: rect,
          triggerLeft: trigger === null || trigger === undefined ? null : trigger.left,
          expectedLeft: expectedLeft,
          // 浮层左缘贴住触发按钮；靠右时按「卡右缘 - 浮层宽」夹取
          triggerAligned:
            expectedLeft === null || Math.abs(rect.left - expectedLeft) <= 1.5,
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
        triggerAligned: rows.every((row) => row.triggerAligned === true),
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
    //    "aria-expanded"是"组件自认为开着"的权威信号，比矩形可靠：leaving 中的节点矩形仍 > 0，
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

    // ── 详解卡的形状断言（此刻卡是展开的）──
    // capture 的顺序是"先拍 PNG、后跑 check"，而展开详解卡的代码就在 check 里 ——
    // 没有任何截图能拍到它的展开态，所以"只有这几行"这件事只能在这里客观钉住：
    // 标签集合恰为四行且顺序一致、说明里不再出现"消息条数"（统计项已随精简移除）。
    // 2026-10-03：缓存命中从折叠条搬进详解卡（折叠条改显示平均命中率）→ 3 行变 4 行。
    const detailCard = document.querySelector('[data-field="chat.context-detail"]')
    const detailLabels =
      detailCard === null
        ? []
        : Array.from(detailCard.querySelectorAll('.ctx-grid dt')).map((el) =>
            (el.textContent || '').trim(),
          )
    const detailRows = detailLabels.length
    const detailNote =
      detailCard === null
        ? ''
        : ((detailCard.querySelector('.ctx-note') || {}).textContent || '').trim()
    const expectedLabels = ['输入（最近一轮）', '上下文窗口', '模型', '平均缓存命中']
    const detailShape =
      detailCard !== null &&
      detailRows === expectedLabels.length &&
      detailLabels.every((label, index) => label === expectedLabels[index]) &&
      detailNote.indexOf('消息条数') === -1

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
    ]
    if (probe.model !== null && probe.model !== undefined) {
      audits.push(audit('model-open(act)', probe.model))
    }
    if (probe.effort !== null && probe.effort !== undefined) {
      audits.push(audit('effort-open(act)', probe.effort))
    }
    audits.push(audit('permission-final(act)', probe.permissionFinal))
    audits.push(audit('permission-open(now)', permissionNow))
    audits.push(audit('context-open(check)', contextMoment))
    const oneAtMost = audits.every((row) => row.visibleCount <= 1)
    const mutual =
      audits[0].visible.indexOf('slash') !== -1 &&
      audits[1].visible.indexOf('permission') !== -1 &&
      audits[1].visible.indexOf('slash') === -1 &&
      audits[audits.length - 1].visible.indexOf('context') !== -1 &&
      audits[audits.length - 1].visible.indexOf('permission') === -1
    // 2026-10-18：五个浮层必须同锚点 / 同宽 —— 这是「都对齐权限弹窗」的几何判据。
    // 只在真的量到可见浮层时比（无 provider 时 model/effort 触发器 disabled，如实跳过）。
    const geometryRows = audits.flatMap((row) => row.rows)
    const baseRect = geometryRows.length === 0 ? null : geometryRows[0].rect
    const sameAnchor =
      baseRect !== null &&
      geometryRows.every((row) => Math.abs(row.rect.bottom - baseRect.bottom) <= 1)
    // 2026-10-18 用户口径：浮层横向贴住自己的触发按钮，不再固定 left: 0。
    const triggerAligned = audits.every((row) => row.triggerAligned === true)
    const sameWidth =
      baseRect !== null &&
      geometryRows.every((row) => Math.abs(row.rect.width - baseRect.width) <= 1)
    const modelVisibleOk =
      probe.model === null ||
      probe.model === undefined ||
      audits.some(
        (row) => row.moment === 'model-open(act)' && row.visible.indexOf('model') !== -1,
      )
    const effortVisibleOk =
      probe.effort === null ||
      probe.effort === undefined ||
      audits.some(
        (row) => row.moment === 'effort-open(act)' && row.visible.indexOf('effort') !== -1,
      )
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
      sameAnchor,
      sameWidth,
      triggerAligned,
      flyoutCount: geometryRows.length,
      barClear,
      aboveComposerBox,
      sendClickable,
      cleared,
      cleanupTrace,
      finalVisible: finalMoment.visible,
      detailRows,
      detailLabels,
      detailNoteClean: detailNote.indexOf('消息条数') === -1,
      inputAfter:
        box === null ? null : box.value === '' ? 'empty' : JSON.stringify(box.value.slice(0, 24)),
      pass:
        oneAtMost &&
        mutual &&
        modelVisibleOk &&
        effortVisibleOk &&
        sameAnchor &&
        sameWidth &&
        triggerAligned &&
        barClear &&
        aboveComposerBox &&
        sendClickable &&
        cleared === true &&
        // 详解卡只留三行（输入 / 上下文窗口 / 模型）+ 一句说明
        detailShape === true,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 输入卡粘贴图片（2026-10-18，docs/07 §2.3）· 前半。
 *
 * 为什么用合成 `ClipboardEvent`：本机 Electron 44 的 `clipboard` 已改成异步
 * `read()/write(ClipboardItem[])`，不再提供 `writeImage`；而本场景真正要验证的是
 * **渲染层 paste 处理器 → chat:stageImage 落盘 → 缩略图回填** 这条链，合成事件同样会
 * 走 `onComposerPaste`（`event.clipboardData.files` 由 `DataTransfer` 提供），
 * 不会因为绕开 OS 剪贴板而漏掉应用代码。先清掉已有附件再粘贴，避免前面场景残留把计数弄成 >1。
 */
const PASTE_TEST_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

export async function chatComposerPasteMainAct(
  win: BrowserWindow,
): Promise<{ pass: boolean; thumbnails: number; reason?: string }> {
  try {
    await win.webContents.executeJavaScript(
      'for (const b of document.querySelectorAll(\'[data-field="chat.attachment-remove"]\')) b.click();',
      true,
    )
    // 先聚焦输入框，确保 paste 事件落在 textarea 的监听上
    await win.webContents.executeJavaScript(
      "const el = document.querySelector('.composer-input'); if (el) { el.focus(); }",
      true,
    )
    const pngBase64 = PASTE_TEST_PNG.split(',')[1] || ''
    await win.webContents.executeJavaScript(
      `(() => {
        const input = document.querySelector('.composer-input')
        if (input === null) return false
        const binary = atob(${JSON.stringify(pngBase64)})
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
        const file = new File([bytes], 'capture-paste.png', { type: 'image/png' })
        const transfer = new DataTransfer()
        transfer.items.add(file)
        input.dispatchEvent(
          new ClipboardEvent('paste', {
            clipboardData: transfer,
            bubbles: true,
            cancelable: true,
          }),
        )
        return true
      })()`,
      true,
    )
    let thumbnails = 0
    for (let attempt = 0; attempt < 40 && thumbnails === 0; attempt += 1) {
      thumbnails = (await win.webContents.executeJavaScript(
        'document.querySelectorAll(\'[data-field="chat.attachment-thumb"]\').length',
        true,
      )) as number
      if (thumbnails === 0) await wait(100)
    }
    return {
      pass: thumbnails === 1,
      thumbnails,
      ...(thumbnails === 1 ? {} : { reason: '粘贴后没有出现 1 张附件缩略图' }),
    }
  } catch (error) {
    return { pass: false, thumbnails: 0, reason: String(error) }
  }
}

/**
 * 粘贴图片探针 · 后半：缩略图必须在 textarea **上方**、卡片内部，且移除按钮真的能删掉。
 * 只量矩形，不量存在：一张 `src` 为空的 `<img>` 或一个被浮层盖住的缩略图都不算数。
 */
export const CHAT_COMPOSER_PASTE_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const round = (value) => Math.round(value * 10) / 10
    const rectOf = (el) => {
      const rect = el.getBoundingClientRect()
      return { top: round(rect.top), bottom: round(rect.bottom), left: round(rect.left), right: round(rect.right) }
    }
    const card = document.querySelector('.composer-box')
    const input = document.querySelector('.composer-input')
    const thumb = document.querySelector('[data-field="chat.attachment-thumb"]')
    const remove = document.querySelector('[data-field="chat.attachment-remove"]')
    const before = document.querySelectorAll('[data-field="chat.attachment"]').length
    if (card === null || input === null || thumb === null || remove === null) {
      return {
        pass: false,
        reason: '缺少 .composer-box / .composer-input / 缩略图 / 移除按钮',
        attachments: before,
      }
    }
    const cardRect = rectOf(card)
    const inputRect = rectOf(input)
    const thumbRect = rectOf(thumb)
    const thumbAboveInput = thumbRect.bottom <= inputRect.top + 1
    const thumbInsideCard =
      thumbRect.top >= cardRect.top - 1 &&
      thumbRect.bottom <= cardRect.bottom + 1 &&
      thumbRect.left >= cardRect.left - 1 &&
      thumbRect.right <= cardRect.right + 1
    const src = thumb.getAttribute('src') || ''
    const thumbIsDataUrl = src.indexOf('data:image/') === 0
    const removeRect = remove.getBoundingClientRect()
    const hit = document.elementFromPoint(
      removeRect.left + removeRect.width / 2,
      removeRect.top + removeRect.height / 2,
    )
    const removeClickable = hit === remove || (hit !== null && remove.contains(hit))
    remove.click()
    await wait(300)
    const after = document.querySelectorAll('[data-field="chat.attachment"]').length
    return {
      attachments: before,
      thumbAboveInput,
      thumbInsideCard,
      thumbIsDataUrl,
      removeClickable,
      removed: after === 0,
      thumbRect,
      inputRect,
      cardRect,
      pass:
        before === 1 &&
        thumbAboveInput &&
        thumbInsideCard &&
        thumbIsDataUrl &&
        removeClickable &&
        after === 0,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 工具卡展开高度的"实测终点"探针 · 前半（2026-09-26 修复的回归断言）。
 *
 * 背景：`.collapse-*` 的终点此前写死 `70vh`，内容只有约 140px 的工具卡对 504px 的终点做动画，
 * 可见位移全挤在时间轴前一小段（展开"飞快长满再空转"、收起"先空转、末尾猛缩"）。
 * 现在终点取实测值：`useCollapseTransition` 的 **`@enter`** / `@before-leave` 钩子在量之前
 * 先把元素内联的 `max-height` 临时摘成 `none`（否则被钳制的 flex 列容器会把可收缩子项
 * `.tool-args` 压扁、量少 66px），量完立刻还原，把真实内容高度写进 `--collapse-h`，
 * 全局 CSS 用 `var(--collapse-h, 70vh)`。**进入方向不能挂 `before-enter`** ——
 * 那时元素还没插入文档、`scrollHeight` 恒为 0（2026-09-26 实测踩过）。
 *
 * act 点 seed 出来的工具卡卡头（优先 `task` 卡，展开体最大：运行轨迹 + 指令 + 参数 + 结果），
 * 中途按 60 / 120 / 180 / 280 / 400ms 采样可见高度，最后轮询到"连续两次高度一致且 > 0"
 * 才算稳定，把采样与稳定高度挂 window 给 check 读（act 的返回值进不了 report.json）。
 * 采样里 **60ms 那次参与 pass 判定**（必须严格小于稳定高度）：终值在"正常过渡"与
 * "退化成瞬跳"两种实现下相同，只有中间样本能区分它们。
 *
 * **不在这里收起卡片**：截图就是展开现场，且展开态只影响这张卡自身，后续场景不受影响
 *（`chat-tts` 自带 reload）。
 */
export const CHAT_TOOL_CARD_OPEN_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    // ⚠️ 先确保**轨迹是展开的**（2026-09-30 轨迹重构后新增）：工具行住在轨迹展开体里，
    // 历史水合出的轨迹默认折叠 —— 折叠态下展开体是 display: none，卡头点击后
    // "展开体高度"恒为 0，本探针的"实测高度"断言会整条 FAIL。
    const trace = document.querySelector('.message.r-assistant .trace')
    if (trace !== null && trace.classList.contains('open') === false) {
      const traceHead = trace.querySelector('.trace-head')
      if (traceHead !== null) traceHead.click()
      await wait(400)
    }
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
 * 工具卡展开探针 · 后半（"实测高度"这条机制的直接断言）。
 *
 * 断言：
 * ① 卡处于展开态（`.open` + `aria-expanded="true"`）且展开体 `.tool-body` 在且可见；
 * ② 展开体的**内联** `--collapse-h` 存在、是可解析的 px 数值，且与该元素的 `scrollHeight`
 *    相差 ≤ 2px —— 有人把钩子摘掉（回落 70vh）或改回写死值，这条立刻 FAIL；
 * ③ 稳定后展开体的可见高度 ≈ `scrollHeight`（没有被 `max-height` 截住）；
 * ④ 中途采样只回传、不参与判定（曲线平滑度不能从快照断言）。
 * ② 的口径**刻意从严**：它同时是"测量发生在何时"的回归防线 —— 首跑就靠它抓到
 * "进入方向把 `scrollHeight` 量在**游离**元素上 → `--collapse-h: 0px`"这个真实 bug
 * （Vue 的 `beforeEnter` 在 `hostInsert` 之前调用；已由渲染层改挂 `enter` 修掉）。
 * 因此这里的 `≤ 2px` 不能放宽成"接受 0 / 接受一个区间"。
 *
 * 场景自带两条**只回传、不参与 pass** 的诊断（`diagnostic` / `detachedMeasureProbe`），
 * 用来把"钩子量到了什么"变成可复核的读数：
 * - `diagnostic.leaveVar`：收起方向（`before-leave` 时元素尚在文档里）写下的实测值；
 * - `diagnostic.mid` / `diagnostic.settled`：再展开时"进入后约 70ms"与"稳定后"两次布局快照
 *   （`--collapse-h`、元素宽度、`scrollHeight`、`.thread` 的 clientWidth / 有无滚动条、各子元素高度）
 *   —— 用于区分"钩子量错了"与"量的时候布局还没稳"；
 * - `detachedMeasureProbe`：现造一个同款盒子，未入文档 / 已入文档各量一次 `scrollHeight`
 *   （钉住"游离元素 scrollHeight 恒为 0"这条前提）。
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
    // 保留这段快照是为了让"f77a842 之前 enter 侧少写 66px"那个坑可复现：
    // 当时中途与稳定后的宽度、.thread 的滚动条状态两次**完全一致**，只有 .tool-args
    // 从 13px 变成 79px（正好 66px）。原因是 .tool-body 是 flex 列容器：enter 钩子跑的时候
    // .collapse-enter-from 的 max-height:0 已经挂上，容器没有可用高度，flex 收缩把
    // 唯一的滚动容器子项（.tool-args，overflow:auto，其 min-height:auto 对滚动容器
    // 解析为 0）压到 padding + 边框的最小高度 —— 量到的是"被钳制后的布局"而不是真实内容高，
    // 而且该偏差在整段过渡期间恒定，所以"逐帧轮询到连续两帧相等"也追不到它。
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
        // 再展开：中途（enter 之后约 70ms）与稳定后各取一次布局，把"量得早"这件事显影
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
    // 现场造一个与 .tool-body 同款（flex 列 + 同 padding）的盒子，先量"未入文档"、
    // 再量"已入文档"：前者为 0、后者是真实内容高。这条守着"进入方向不能挂 @before-enter"
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
    // 终值在"正常过渡"与"退化成瞬跳"两种实现下相同（都已等于内容高），
    // 所以只有中间样本能区分它们 —— 把"过渡类挂上了但 max-height 不可插值 → 直接落位"
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
 * 截图即"分组展开、已归档会话列在里面"的现场。归档 / 取消归档这条会改状态的往返放在 check 里
 * （截图先拍，动作后做），并由 check 收尾还原 —— 否则后面的场景看到的会是被改过的左栏。
 *
 * **2026-10-10 加冷窗前置**：分组 toggle 是 `v-if="archivedSessions.length > 0"` 渲染的
 * （`SessionNav.vue`），会话列表是异步水合的 —— act 在 `capture.ts` 只等了 60ms 就执行，
 * 于是**单场景筛选跑**（`AURORA_CAPTURE_ONLY='chat-archive'`）会稳定拿到 `toggle === null`：
 * 4/4 轮 `ariaExpanded:"false"` / `archiveRows:0`，看着像探针坏了，其实是前置没就绪。
 * 现在改成**有界轮询等 toggle 出现**（最多 40 × 100ms）再点，并把就绪状态写进
 * `window.__auroraArchiveProbe` —— **不能只靠返回值**：`capture.ts` 的 act 返回值被丢弃
 *（只合并 `mainAct`），所以 check 通过这个全局变量读取。
 */
export const CHAT_ARCHIVE_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    let toggle = null
    let toggleAttempts = 0
    for (; toggleAttempts < 40; toggleAttempts += 1) {
      toggle = document.querySelector('[data-field="chat.archive-toggle"]')
      if (toggle !== null) break
      await wait(100)
    }
    if (toggle === null) {
      const failed = {
        ready: false,
        toggleFound: false,
        rows: 0,
        toggleAttempts,
        attempts: 0,
        reason: 'no [data-field="chat.archive-toggle"]（seed 的已归档会话没被读到？）',
      }
      window.__auroraArchiveProbe = failed
      return failed
    }
    toggle.click()
    let rows = 0
    let attempts = 0
    for (; attempts < 20 && rows === 0; attempts += 1) {
      rows = document.querySelectorAll('[data-field="chat.archive-list"] .nav-item').length
      if (rows === 0) await wait(120)
    }
    const probe = {
      ready: rows > 0,
      toggleFound: true,
      rows,
      toggleAttempts,
      attempts,
      expanded: toggle.getAttribute('aria-expanded'),
      label: (toggle.textContent || '').replace(/\\s+/g, ' ').trim(),
      reason: rows > 0 ? '' : '点了 toggle 但归档列表仍没有行',
    }
    window.__auroraArchiveProbe = probe
    return probe
  } catch (error) {
    const failed = { ready: false, reason: String(error) }
    window.__auroraArchiveProbe = failed
    return failed
  }
})()`

/**
 * 左栏归档探针 · 后半：分组结构 + "不混进主列表"+ **通过真实 UI 走一遍归档 / 取消归档**。
 *
 * 断言五件事：
 * 1. `chat.archive-group` 在、`chat.archive-toggle` 的 `aria-expanded === 'true'`、
 *    `chat.archive-list` 里的 `.nav-item` ≥ 1、分组标题带计数（"已归档 · N"）；
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
    // act 前置的就绪状态（act 的返回值会被丢弃，所以它写在 window 上）：
    // ready !== true 必须变成**显式失败** —— 否则"前置没就绪"会像以前那样静默退化成一堆
    // 看着像探针坏了的报错（实测：单场景筛选跑 4/4 轮 ariaExpanded=false / archiveRows=0）。
    const actProbe = window.__auroraArchiveProbe
    const result = {
      actProbe: actProbe === undefined ? null : actProbe,
      actReady: actProbe !== undefined && actProbe.ready === true,
      groupPresent: count('[data-field="chat.archive-group"]') === 1,
      togglePresent: toggle !== null,
      ariaExpanded: toggle === null ? null : toggle.getAttribute('aria-expanded'),
      toggleLabel: toggle === null ? '' : textOf(toggle),
      mainRows: count(MAIN),
      archiveRows: count(ARCH),
      seedInMain: textOf(document.querySelector('[data-field="chat.session-list"]')).indexOf('archive-seed') !== -1,
      seedInArchive: textOf(document.querySelector('[data-field="chat.archive-list"]')).indexOf('archive-seed') !== -1,
    }
    if (result.actReady !== true) {
      problems.push(
        '归档分组前置未就绪（act 未拿到 toggle / 行）：' +
          JSON.stringify(actProbe === undefined ? null : actProbe),
      )
    }
    if (result.groupPresent !== true) problems.push('chat.archive-group 不存在')
    if (result.togglePresent !== true) problems.push('chat.archive-toggle 不存在')
    if (result.ariaExpanded !== 'true') problems.push('归档分组未展开（aria-expanded=' + result.ariaExpanded + '）')
    if (result.archiveRows < 1) problems.push('归档列表里没有会话行')
    // 计数与锚点（标题文案"已归档 · N"里的 N 必须与实际行数一致）
    const countMatch = /已归档[^0-9]*([0-9]+)/.exec(result.toggleLabel)
    result.toggleCount = countMatch === null ? null : Number(countMatch[1])
    if (result.toggleCount !== result.archiveRows) {
      problems.push('分组计数与实际行数不符：' + result.toggleCount + ' vs ' + result.archiveRows)
    }
    if (result.seedInMain === true) problems.push('seed 的已归档会话仍出现在主列表')
    if (result.seedInArchive !== true) problems.push('seed 的已归档会话不在归档列表里')

    // 3) 通过真实 UI 归档一条未归档会话（**优先取当前正在看的那条**）
    //    为什么优先 active 行：归档当前会话时，主区头部必须出现"已归档 + 取消归档"提示条
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
    const movedTitle = targetRow === null ? '' : textOf(targetRow.querySelector('.item-title'))
    // 身份键 = data-session-id（SessionRow.vue 的 .nav-row 上，2026-10-10 新增）。
    // 旧口径取整行文本，而那一行含 .item-time 相对时间：跨分钟时同一行的文本从"刚刚"
    // 变成"N 分钟前"，于是"归属"判定在**计数已经正确迁移**时仍然两边查找都失配
    //（实测 payload：movedTitle"新会话刚刚"、
    // afterArchive {mainRows:2,archiveRows:2,inArchive:false,inMain:false}）。
    // 会话 id 才是唯一不会随渲染时间漂移的身份键；
    // movedNavText 只作为排障信息回传（旧口径的文本快照，一眼看出是不是文本漂移）。
    const movedSessionId = targetRow === null ? '' : targetRow.getAttribute('data-session-id') || ''
    const rowBySessionId = (selector, sessionId) =>
      Array.from(document.querySelectorAll(selector + ' .nav-row')).find(
        (row) => row.getAttribute('data-session-id') === sessionId,
      ) || null
    const rowInArchive = (sessionId) =>
      rowBySessionId('[data-field="chat.archive-list"]', sessionId) !== null
    const rowInMain = (sessionId) =>
      rowBySessionId('[data-field="chat.session-list"]', sessionId) !== null
    // 身份键真取到时才用它做归属判定；取不到（行结构变了 / 没渲染出 data-session-id）
    // 必须如实报出来，不能静默降级成"跳过归属判定"——那等于把断言变成永远通过。
    const identityUsable = movedSessionId !== ''
    if (identityUsable !== true) {
      problems.push('行结构或探针契约变了：.nav-row 上没有 data-session-id（无法做归属判定）')
    }
    result.movedSessionId = movedSessionId
    result.movedTitle = movedTitle
    result.movedNavText = targetRow === null ? '' : textOf(targetRow.querySelector('.nav-item'))
    // 反向复核读数：旧口径里"会漂移的那一段"（.item-time 的相对时间）+ 旧口径的整行文本。
    // 用来证明身份键换掉的原因 —— 同一行的相对时间跨分钟就会变，而计数断言仍是对的。
    result.movedNavTime = targetRow === null ? '' : textOf(targetRow.querySelector('.item-time'))
    result.identityUsable = identityUsable
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
          rowInArchive(movedSessionId)
      }
      result.afterArchive = {
        mainRows: count(MAIN),
        archiveRows: count(ARCH),
        inArchive: rowInArchive(movedSessionId),
        inMain: rowInMain(movedSessionId),
      }
      if (
        result.afterArchive.mainRows !== beforeMain - 1 ||
        result.afterArchive.archiveRows !== beforeArchive + 1 ||
        result.afterArchive.inArchive !== true ||
        result.afterArchive.inMain === true
      ) {
        problems.push('归档后计数 / 归属不符：' + JSON.stringify(result.afterArchive))
      }

      // 3b) 归档的是当前会话 → 主区头部必须出现"已归档 + 取消归档"提示条
      if (result.targetWasActive === true) {
        const banner = document.querySelector('[data-field="chat.archived-banner"]')
        result.bannerAfterArchive = {
          present: banner !== null,
          text: banner === null ? '' : textOf(banner),
          hasUnarchive:
            banner !== null && banner.querySelector('[data-action="chat.unarchive-current"]') !== null,
        }
        if (result.bannerAfterArchive.present !== true) {
          problems.push('归档当前会话后头部没有"已归档"提示条')
        } else if (result.bannerAfterArchive.text.indexOf('已归档') === -1) {
          problems.push('提示条文案不含"已归档"：' + result.bannerAfterArchive.text)
        } else if (result.bannerAfterArchive.hasUnarchive !== true) {
          problems.push('提示条上没有"取消归档"按钮')
        }
      }

      // 4) 再点一次撤销（必须做：后面的场景不该看到被改过的左栏）
      //    定位同样用 data-session-id（旧写法按 .nav-item 文本前缀匹配，同一条漂移链）。
      const movedRow = rowBySessionId('[data-field="chat.archive-list"]', movedSessionId)
      const unarchiveButton = movedRow === null ? null : movedRow.querySelector('[data-action="chat.unarchive-session"]')
      if (unarchiveButton === null) {
        problems.push('归档列表里没找到刚归档那条的"取消归档"按钮')
      } else {
        unarchiveButton.click()
        let restored = false
        for (let attempt = 0; attempt < 25 && !restored; attempt += 1) {
          await wait(120)
          restored =
            count(MAIN) === beforeMain &&
            count(ARCH) === beforeArchive &&
            rowInMain(movedSessionId)
        }
        result.afterUnarchive = {
          mainRows: count(MAIN),
          archiveRows: count(ARCH),
          inMain: rowInMain(movedSessionId),
          inArchive: rowInArchive(movedSessionId),
        }
        if (
          result.afterUnarchive.mainRows !== beforeMain ||
          result.afterUnarchive.archiveRows !== beforeArchive ||
          result.afterUnarchive.inMain !== true ||
          result.afterUnarchive.inArchive === true
        ) {
          problems.push('撤销归档后计数 / 归属不符：' + JSON.stringify(result.afterUnarchive))
        }
        // 撤销之后提示条必须消失（否则它会常驻挂着，误导"这个会话还是归档的"）
        if (result.targetWasActive === true) {
          let bannerGone = false
          for (let attempt = 0; attempt < 15 && !bannerGone; attempt += 1) {
            bannerGone = count('[data-field="chat.archived-banner"]') === 0
            if (!bannerGone) await wait(120)
          }
          result.bannerGoneAfterUnarchive = bannerGone
          if (bannerGone !== true) problems.push('撤销归档后"已归档"提示条没有消失')
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
 * 右栏开关探针 · 前半（BetaV2）：点两次 `chat.right-panel-toggle` 走"展开 → 收起 → 展开"。
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
    // 收起态的顶部横带（2026-10-03 用户口径"三键固定在窗口右上角、别破坏协调性"）：
    // 此刻主区右缘就是窗口右缘 —— 窗口按钮仍贴右缘贴顶，且标题栏的"清空"按钮
    // 必须已经让位（靠 .head--corner 的 padding-right），两者的矩形不许相交。
    const rectOf = (el) => (el === null ? null : el.getBoundingClientRect())
    const trashRect = rectOf(document.querySelector('.head-actions button'))
    const closeRect = rectOf(document.querySelector('[data-caption-btn="close"]'))
    const shellRight =
      document.querySelector('.app-shell')?.getBoundingClientRect().right ?? window.innerWidth
    const collapsedCaptionPinned =
      closeRect !== null && closeRect.top <= 4 && closeRect.right >= shellRight - 2
    const collapsedOverlap =
      trashRect !== null && closeRect !== null && trashRect.right > closeRect.left + 2
    toggle.click()
    await wait(600)
    const afterShow = isOpen()
    window.__auroraRightPanelProbe = {
      before,
      afterHide,
      afterShow,
      collapsedCaptionPinned,
      collapsedOverlap,
    }
    return { ok: true, before, afterHide, afterShow, collapsedCaptionPinned, collapsedOverlap }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`

/**
 * 右栏开关探针 · 后半：act 记录的"收起又展开"三态必须全部成立，且此刻右栏仍是展开的
 * （展开态 = 截图里的布局，收起只允许存在于两次点击之间的瞬时）。
 * 另断言**收起态**的顶部横带：窗口按钮固定在窗口右上角（贴顶贴右缘），
 * 标题栏的"清空"按钮已按 `--caption-w` 让位、两者矩形不相交。
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
        // 收起态：窗口按钮仍固定在右上角，且标题栏的"清空"已让位（不叠）
        probe.collapsedCaptionPinned === true &&
        probe.collapsedOverlap === false &&
        openNow,
    }
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

/**
 * 右栏模式感知探针（BetaV2，spec §3/§11）：把模式切到 Work，右栏必须整体换成办公卡片。
 *
 * "非当前模式的功能一律不渲染"钉的是这条：work 态右栏要有"工作目录"卡、
 * 不得再有 classroom 的"今日课程"卡。ContextPanel 没有 data-field 锚点（按卡头文案定位）；
 * 切模式走 `window.aurora.mode.set`（与设置页"启用"同一条 IPC），主进程会广播
 * mode:changed → 渲染层 modeStore / ContextPanel 随之更新。
 *
 * ⚠️ 引导副作用是安全的：work 引导未完成时 `mode.set` 会触发 `requestGuideIfNeeded`，
 * 但主进程的 proactive 实现只是 `showChat()` + 日志（见 index.ts），不写会话、不弹窗体，
 * 不会污染 seed 会话。check 收尾把模式切回 classroom 并等"今日课程"卡回来，
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
 * 会话三分探针（2026-09-30，docs/06 §4 会话空间 / docs/07 §2.3）：左栏必须分成
 * 项目对话 / 工作目录对话 / Agent对话 三区，且分区随项目与模式门控。
 *
 * ACT 三个阶段：
 * ① 出厂现场（无项目、classroom）：`chat.agent-group` / `chat.session-list` /
 *    `chat.quick-item` 必须在，`chat.work-group` / `chat.project-group` 必须不在 ——
 *    工作目录对话区是 Work 模式专属、项目对话区只在登记了项目时渲染（"无则整区不渲染"）；
 * ② 登记两个截图项目（与 chat-project-card 同一条 `settings:update` 通道，`list` 整体权威；
 *    `chat.project-group` 出现、组头 `+`（`chat.new-project-session`）恰好两枚，
 *    且退役标记 `chat.project-current` **一枚都不许出现**（v25 已整体删除该徽标）；
 * ③ 切 Work 模式（与右栏模式感知探针同一条 `mode.set` IPC）：`chat.work-group` 出现
 *    且组头 `+`（`chat.new-work-session`）恰好一枚，项目对话区不受影响。
 *
 * CHECK 断言三阶段现场后收尾还原（模式切回 classroom、项目清空），
 * 后续场景（chat-tts / archive）读到的仍是出厂门控。seed 的 main 会话是未标记会话
 * （Agent 空间），因此 `chat.session-list .nav-item` ≥ 1 顺带验证"历史会话归 Agent对话区"。
 */
export const CHAT_SESSION_GROUPS_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const count = (selector) => document.querySelectorAll(selector).length
  try {
    const rows = () =>
      Array.from(document.querySelectorAll('[data-field="chat.project-group"] .session-list'))
        .map((el) => el.querySelectorAll('.nav-item').length)
        .reduce((sum, value) => sum + value, 0)
    const factory = {
      agentGroup: count('[data-field="chat.agent-group"]'),
      sessionList: count('[data-field="chat.session-list"]'),
      quickItem: count('[data-field="chat.quick-item"]'),
      workGroup: count('[data-field="chat.work-group"]'),
      // 项目区**常显**（标题行有"添加项目"钮）：出厂现场判定看"有没有项目子分组"
      projectGroup: count('[data-field="chat.project-group"]'),
      projectAddButton: count('[data-action="chat.add-project"]'),
      projectRows: rows(),
      agentRows: count('[data-field="chat.session-list"] .nav-item'),
      agentAddButton: count('[data-action="chat.new-agent-session"]'),
    }
    // 阶段 B：登记截图项目（projects.list 是数组整体权威，显式给完整子树）。
    // **两条**（v25 起无全局 current，两条等价，只是名字不同）。
    const state = await window.aurora.settings.get()
    if (!state.ok) return { ok: false, reason: state.message }
    const update = await window.aurora.settings.update({
      projects: {
        ...state.value.projects,
        list: [
          { id: 'capture', name: '截图项目', root: 'C:\\\\capture-project' },
          { id: 'capture-other', name: '非当前项目', root: 'C:\\\\capture-project-2' },
        ],
      },
    })
    if (!update.ok) return { ok: false, reason: update.message }
    // 等待条件 = **两条项目子分组头都出现**（+ 钮）而不是"子分组里有会话行"：
    // 刚登记的项目还没有任何会话，子分组下自然没有行（这是正确行为，不是缺陷）。
    const projectText = () => {
      const el = document.querySelector('[data-field="chat.project-group"]')
      return el === null ? '' : (el.textContent || '').replace(/\\s+/g, ' ').trim()
    }
    let projectHeader = 0
    for (let attempt = 0; attempt < 15 && projectHeader < 2; attempt += 1) {
      projectHeader = count('[data-action="chat.new-project-session"]')
      if (projectHeader < 2) await wait(200)
    }
    const projectGroup = count('[data-field="chat.project-group"]')
    const projectAdd = count('[data-action="chat.new-project-session"]')
    const projectRows = rows()
    const projectNameShown = projectText().indexOf('截图项目') !== -1
    // 退役徽标哨兵（v25）：chat.project-current 随全局 projects.current 退役整体删除，
    // 两条项目分组在场时它必须一枚都不出现 —— 防止有人把徽标"顺手"加回来。
    const currentBadge = count('[data-field="chat.project-current"]')
    // 阶段 C：切 Work 模式
    const mode = await window.aurora.mode.set('work')
    if (!mode.ok) return { ok: false, reason: 'mode.set failed: ' + mode.message }
    let workGroup = 0
    for (let attempt = 0; attempt < 20 && workGroup === 0; attempt += 1) {
      workGroup = count('[data-field="chat.work-group"]')
      if (workGroup === 0) await wait(200)
    }
    const workAdd = count('[data-action="chat.new-work-session"]')

    // 阶段 D（2026-09-30）：**项目分组折叠往返**。夹具里 chat-seed-project 绑定
    // 项目 'capture'（见 seedChatTtsHistory 第 4 步），上面阶段 B 登记的同 id 项目
    // 因此有了 1 条会话 —— 折叠它、量高度与可见性，再展开还原。
    const firstProjectGroup = () => document.querySelector('[data-field="chat.project-group"] .project-group')
    const projectListOf = (groupEl) => (groupEl === null ? null : groupEl.querySelector('.collapse'))
    const collapseHeight = () => {
      const el = projectListOf(firstProjectGroup())
      return el === null ? -1 : Math.round(el.getBoundingClientRect().height)
    }
    const toggleButton = firstProjectGroup() === null
      ? null
      : firstProjectGroup().querySelector('[data-action="chat.toggle-project"]')
    const expandedHeight = collapseHeight()
    const expandedAria = toggleButton === null ? null : toggleButton.getAttribute('aria-expanded')
    let collapseClicked = false
    if (toggleButton !== null) {
      toggleButton.click()
      collapseClicked = true
    }
    await wait(600)
    const collapsedHeight = collapseHeight()
    const collapsedAria = toggleButton === null ? null : toggleButton.getAttribute('aria-expanded')
    // 展开还原（后续场景读到的是展开态）
    if (toggleButton !== null) toggleButton.click()
    await wait(600)
    const restoredHeight = collapseHeight()

    window.__auroraSessionGroupsProbe = {
      collapseClicked,
      expandedHeight,
      collapsedHeight,
      restoredHeight,
      expandedAria,
      collapsedAria,
      factory,
      projectGroup,
      projectAdd,
      projectRows,
      projectNameShown,
      currentBadge,
      workGroup,
      workAdd,
    }
    return { ok: true, factory, projectGroup, projectAdd, workGroup, workAdd }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`

export const CHAT_SESSION_GROUPS_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const count = (selector) => document.querySelectorAll(selector).length
  try {
    const probe = window.__auroraSessionGroupsProbe
    const factory = probe === undefined ? null : probe.factory
    const factoryOk =
      factory !== null &&
      factory.agentGroup === 1 &&
      factory.sessionList === 1 &&
      factory.quickItem === 1 &&
      factory.workGroup === 0 &&
      // 项目区常显（添加项目入口），但出厂现场**没有项目子分组**
      factory.projectGroup === 1 &&
      factory.projectAddButton === 1 &&
      factory.projectRows === 0 &&
      factory.agentAddButton === 1 &&
      factory.agentRows >= 1
    // 项目已登记：**两条**子分组头在场、项目名出现在分组标题里、退役徽标零出现。
    // 不断言"子分组里有会话行"—— 新登记的项目本来就没有会话（新建入口就是那个 +）。
    const projectOk =
      probe !== undefined &&
      probe.projectGroup === 1 &&
      probe.projectAdd === 2 &&
      probe.projectNameShown === true &&
      probe.currentBadge === 0
    const workOk = probe !== undefined && probe.workGroup === 1 && probe.workAdd === 1

    // 阶段 D 断言：折叠后高度归零 → 展开还原（两个方向都验，避免"点了没反应"漏判）
    const collapseOk =
      probe !== undefined &&
      probe.collapseClicked === true &&
      probe.expandedHeight > 20 &&
      probe.collapsedHeight === 0 &&
      probe.restoredHeight === probe.expandedHeight &&
      probe.expandedAria === 'true' &&
      probe.collapsedAria === 'false'

    // 分区标题可读性（2026-09-30 用户反馈"不够醒目"）：字号 ≥ 13px、字重 ≥ 600、
    // 且**带左侧强调色竖条**（::before 伪元素 —— 用 getComputedStyle 读背景色判定）。
    const captionStyle = (() => {
      const el = document.querySelector('.group-caption')
      if (el === null) return null
      const style = window.getComputedStyle(el)
      const before = window.getComputedStyle(el, '::before')
      return {
        text: (el.textContent || '').trim(),
        fontSize: parseFloat(style.fontSize) || 0,
        fontWeight: parseInt(style.fontWeight, 10) || 0,
        transform: style.textTransform,
        barWidth: parseFloat(before.width) || 0,
        barColor: before.backgroundColor,
      }
    })()
    const captionOk =
      captionStyle !== null &&
      captionStyle.fontSize >= 13 &&
      captionStyle.fontWeight >= 600 &&
      // 中文分区标题不再被 uppercase 拉稀
      captionStyle.transform === 'none' &&
      captionStyle.barWidth >= 2 &&
      captionStyle.barColor !== 'rgba(0, 0, 0, 0)'

    // 收尾还原：模式切回 classroom、项目清空，两区随之消失（还原结果并入 pass）
    let restored = false
    const state = await window.aurora.settings.get()
    if (state.ok) {
      const back = await window.aurora.mode.set('classroom')
      const clear = await window.aurora.settings.update({
        projects: { ...state.value.projects, list: [] },
      })
      if (back.ok && clear.ok) {
        const projectRowsNow = () =>
          Array.from(document.querySelectorAll('[data-field="chat.project-group"] .session-list'))
            .map((el) => el.querySelectorAll('.nav-item').length)
            .reduce((sum, value) => sum + value, 0)
        // 轮询**直到还原生效**（条件写 && !restored）：写成 && restored 是"已经好了才继续等"，
        // 需要等一等的场合会在第一轮直接退出并判 FAIL（本探针首跑的 restored:false 即此）。
        for (let attempt = 0; attempt < 15 && !restored; attempt += 1) {
          // 项目区常显（添加项目钮），还原的判据是"工作目录区消失 + 项目子分组清空"
          restored = count('[data-field="chat.work-group"]') === 0 && projectRowsNow() === 0
          if (!restored) await wait(200)
        }
      }
    }
    return {
      factory,
      projectGroup: probe === undefined ? null : probe.projectGroup,
      projectAdd: probe === undefined ? null : probe.projectAdd,
      projectRows: probe === undefined ? null : probe.projectRows,
      projectNameShown: probe === undefined ? null : probe.projectNameShown,
      currentBadge: probe === undefined ? null : probe.currentBadge,
      workGroup: probe === undefined ? null : probe.workGroup,
      workAdd: probe === undefined ? null : probe.workAdd,
      collapse: probe === undefined
        ? null
        : {
            expanded: probe.expandedHeight,
            collapsed: probe.collapsedHeight,
            restored: probe.restoredHeight,
            aria: [probe.expandedAria, probe.collapsedAria],
          },
      caption: captionStyle,
      restored,
      pass: factoryOk && projectOk && workOk && collapseOk && captionOk && restored,
    }
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

/**
 * 思考过程折叠块探针（BetaV2，spec §9/§11）：MessageList 对带 `reasoning` 的助手消息
 * 渲染可折叠"思考过程"块，受 `general.chat.showThinking` 门控。
 *
 * 前提由 `seedChatTtsHistory` 提供：main 会话的助手消息带 `reasoning`（含探针标记文本），
 * `rendererHistory` 会把它透传回渲染层（agent-core store 的 StoredMessage 支持 `reasoning?`）。
 * 历史水合出的思考块**默认收起**（"已深度思考"摘要行）——act 先记录收起态再点开，
 * 截图拍到展开后的全文；check 断言"曾收起 + 现已展开 + 正文含标记 + 块在正文上方"。
 */
export const CHAT_THINKING_BLOCK_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    // ⚠️ 先确保**轨迹是展开的**（2026-09-30 轨迹重构后新增）：思考块住在轨迹展开体里，
    // 历史水合出的轨迹默认折叠 —— 折叠态下展开体是 display: none，元素在 DOM 里但不可见、
    // 高度为 0，后面的"展开后必须可见"会直接 FAIL（2026-09-30 实测就是这么失败的）。
    // 轨迹已经是展开态时不要点（那会把它收起来）。
    const trace = document.querySelector('.message.r-assistant .trace')
    if (trace !== null && trace.classList.contains('open') === false) {
      const traceHead = trace.querySelector('.trace-head')
      if (traceHead !== null) traceHead.click()
      await wait(400)
    }
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
/**
 * Markdown P1 渲染核对（docs/07 §2.3）：固定样本（capture-markdown-probe）的 DOM 结构。
 *
 * 断言的是**渲染器真的产出了那类节点**（存在性 / 结构），不量解析后的样式值 ——
 * 样式值随主题与浏览器版本漂移，量它只会制造假 FAIL（docs/AGENTS 的教训）。
 * 样本由 seedChatTtsHistory 种在那条助手消息末尾（见那边的注释）。
 */
/**
 * Markdown 渲染场景 · 前半：把样本滚进视口并**等图表水合到终态**再放行截图。
 *
 * 为什么需要它：mermaid / echarts 是懒加载 + 视口内才渲染，首次加载 chunk 到出图
 * 要一两秒 —— 不等就截图会拍到"只有工具栏、画布还空着"的中间态（2026-10-02 筛选跑实测）。
 * 断言不受影响（CHECK 自己也会等），这一步是为了让**截图本身**成为可核对的证据。
 */
export const CHAT_MARKDOWN_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const msg = Array.from(document.querySelectorAll('.message.r-assistant')).find(
      (el) => (el.textContent || '').indexOf('capture-markdown-probe') !== -1,
    )
    if (msg === undefined) return { ready: false, reason: 'sample message not found' }
    msg.scrollIntoView({ block: 'center' })
    let states = []
    for (let attempt = 0; attempt < 40; attempt += 1) {
      states = Array.from(msg.querySelectorAll('.md-chart')).map((el) => el.getAttribute('data-state'))
      const settled =
        states.length >= 3 && states.every((state) => state === 'ready' || state === 'failed')
      if (settled) break
      await wait(250)
    }
    return { ready: true, states }
  } catch (error) {
    return { ready: false, reason: String(error) }
  }
})()`

export const CHAT_MARKDOWN_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const msg = Array.from(document.querySelectorAll('.message.r-assistant')).find(
      (el) => (el.textContent || '').indexOf('capture-markdown-probe') !== -1,
    )
    if (msg === undefined) return { pass: false, reason: 'sample message not found' }
    const q = (sel) => msg.querySelectorAll(sel).length
    const table = msg.querySelector('.md-table-wrap > table.md-table')
    const rows = table === null ? 0 : table.querySelectorAll('tbody tr').length
    const headerCells = table === null ? 0 : table.querySelectorAll('thead th').length
    const alignRight = table === null
      ? ''
      : (table.querySelectorAll('thead th')[1] || { style: {} }).style.textAlign
    const link = msg.querySelector('a.md-link[target="_blank"]')
    const rel = link === null ? '' : (link.getAttribute('rel') || '')
    const admonition = msg.querySelector('.md-admonition')
    const checkbox = msg.querySelector('.md-task input[type="checkbox"]')
    const checked = msg.querySelector('.md-task-done input[type="checkbox"]')
    const code = msg.querySelector('.code-block .md-code code.hljs')
    const copyBtn = msg.querySelector('.code-block .code-copy')

    // P2：图表是异步水合的（懒加载 + 视口内才渲染）—— 先滚动到样本并轮询等待终态
    msg.scrollIntoView({ block: 'center' })
    const chartStates = () => {
      const nodes = msg.querySelectorAll('.md-chart')
      return Array.from(nodes).map((el) => el.getAttribute('data-state'))
    }
    let states = chartStates()
    for (let attempt = 0; attempt < 40; attempt += 1) {
      states = chartStates()
      const settled =
        states.length >= 3 && states.every((state) => state === 'ready' || state === 'failed')
      if (settled) break
      await wait(250)
    }
    // 样本里三张图：mermaid 合法 / echarts / mermaid 非法（期望 failed 且源码仍可见）
    const svgReady = msg.querySelector('.md-chart[data-chart="mermaid"][data-state="ready"] svg') !== null
    const canvasReady = msg.querySelector('.md-chart[data-chart="echarts"][data-state="ready"] canvas') !== null
    const failedChart = msg.querySelector('.md-chart[data-state="failed"]')
    const failedSrcVisible = failedChart !== null && failedChart.querySelector('.md-chart-src') !== null

    const conditions = {
      // 三号标题映射为 h5（# → h3 … #### → h6）；判据只要"有带 .md-h 的标题节点"
      heading: q('.md-h') >= 1,
      orderedList: q('ol.md-list.md-ol') >= 1,
      tableShape: rows === 2 && headerCells === 3,
      tableAlign: alignRight === 'right',
      taskList: q('li.md-task') >= 2 && checkbox !== null,
      taskDone: checked !== null,
      admonition: admonition !== null && admonition.className.indexOf('md-admonition-warning') !== -1,
      quote: q('blockquote.md-quote') >= 1,
      strike: q('s') >= 1,
      hr: q('hr.md-hr') >= 1,
      linkBlank: link !== null && rel.indexOf('noopener') !== -1 && rel.indexOf('noreferrer') !== -1,
      codeLang: code !== null,
      highlighted: q('.hljs-keyword') >= 1,
      copyButton: copyBtn !== null,
      mathInline: q('.md-math-inline .katex') >= 1,
      mathBlock: q('.md-math-block .katex') >= 1,
      mermaidSvg: svgReady,
      echartsCanvas: canvasReady,
      chartDegraded: failedChart !== null && failedSrcVisible,
      chartToolbar: q('.md-chart [data-chart-action="copy"]') >= 3,
    }
    return {
      conditions,
      pass: Object.keys(conditions).every((key) => conditions[key] === true),
      counts: {
        tables: q('.md-table'),
        admonitions: q('.md-admonition'),
        tasks: q('li.md-task'),
        charts: q('.md-chart'),
        chartStates: states,
      },
    }
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

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
    // 块在正文上方（docs/07 §2.3）：DOM 顺序上 .thinking 必须先于同气泡内的 .md。
    // ⚠️ 取样范围要收在**这条消息**里（closest('.message')）：整份文档里还有别处带
    // .md 的节点（右栏 / 侧栏的预览），按父级或全局取都会拿错比较对象
    //（2026-09-30 实测：父级取法得到 aboveContent: false 的假 FAIL）。
    const scope = block.closest('.message') ?? block.parentElement ?? document.body
    const content = scope.querySelector('.md')
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
 * 执行轨迹展开探针 · 前半（2026-09-30 轨迹视觉重构，docs/07 §2.3 / §5.2）。
 *
 * 本轮把"思考块 + 一摞工具卡"收成一个 `AgentTrace`：折叠态是**软胶囊**
 * （`--fill-1` 底 + 圆角、无描边），展开态是**左缘连续竖脊 + 节点圆点**，
 * 展开走 grid `0fr ↔ 1fr` 高度过渡（docs/07 §2.3 / §5.2）。
 * 这条 act 负责把折叠态的胶囊点开（已是展开态就不重复点，避免又收回去），
 * 并把展开后的几何量出来挂 window 给后半读 —— **act 的返回值进不了 report.json**。
 *
 * **只点 DOM，不写配置**（与 task-1 的口径一致）：它不依赖任何 settings 变更，
 * 因此可以安全地排在一众读配置的场景之间；改完的现场只影响这条消息自己的展开态。
 *
 * 首选 `.message.r-assistant .trace`（轨迹容器的稳定锚点）：它是 `AgentTrace.vue` 的根，
 * 与 `.thinking` / `.tool-card` 是祖先-后代关系（后两者在这条轨迹的展开体里）。
 */
export const CHAT_TRACE_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const trace = document.querySelector('.message.r-assistant .trace')
    if (trace === null) {
      return { ok: false, reason: 'no .message.r-assistant .trace（seed 的助手消息没渲染轨迹？）' }
    }
    const head = trace.querySelector('.trace-head')
    if (head === null) return { ok: false, reason: 'no .trace-head' }
    // 诊断：展开体在折叠态下的真实形态（inert / 高度 / open 类）。
    // inert 挂在 .trace-clip（grid 过渡层）上，不再挂在 .trace-body —— 2026-10-01 重塑后。
    const diagnose = () => {
      const el = trace.querySelector('.trace-body')
      const clip = trace.querySelector('.trace-clip')
      return {
        openClass: trace.classList.contains('open'),
        hidden: clip === null ? null : clip.hasAttribute('inert'),
        display: el === null ? null : window.getComputedStyle(el).display,
        height: el === null ? -1 : Math.round(el.getBoundingClientRect().height),
      }
    }
    // 前置：**先把轨迹收成折叠态**（2026-09-30 复核加固）。
    // 场景顺序里前面的 chat-thinking-block / chat-tool-card-open 为了点开思考块与工具行
    // 已经把轨迹展开过（实测跑到这里 openClass: true），而本探针要断言的是
    // "折叠 → 展开"这条边沿 + 折叠态的几何 —— 必须自己先把状态造出来，不依赖别人的收尾。
    if (trace.classList.contains('open')) {
      head.click()
      await wait(400)
    }
    const beforeShape = diagnose()
    const openBefore = trace.classList.contains('open')
    /*
     * 折叠态的判据是"展开体**看不见**"，不是"展开体不在 DOM 里"。
     *
     * 展开体常驻 DOM（.thinking / .tool-card 这些锚点在折叠态也必须查得到，
     * 见 AgentTrace 的模板注释），折叠由 grid 0fr 轨道收成零高度表达 ——
     * 所以这里量可见性（高度为 0），并且**必须在这一刻量**（act 记录的值是点击之前的快照，
     * 而 check 跑在 act 之后，用它当"折叠态证据"会永远为假：2026-09-30 实测踩到）。
     */
    const collapsedBodyEl = trace.querySelector('.trace-body')
    const collapsedBodyHidden =
      collapsedBodyEl === null ||
      window.getComputedStyle(collapsedBodyEl).display === 'none' ||
      Math.round(collapsedBodyEl.getBoundingClientRect().height) === 0
    // 折叠态的几何与"历史是否真的被折叠"的证据必须**点之前**读（点完就换成展开态了）。
    // collapsedHeight 就是"任务完成后只剩一行摘要"的硬证据：折叠态若把思考块与工具行
    // 留在布局里，这里会随消息内容涨到几百像素（2026-09-30 复核发现的实现缺陷）。
    // grid 0fr 下这条判据天然成立：轨道高度 0，内部内容再高也被展开体的 overflow hidden
    // 裁掉，不占布局。
    const collapsedHeight = Math.round(trace.getBoundingClientRect().height)
    const headHeight = Math.round(head.getBoundingClientRect().height)
    const headStyle = window.getComputedStyle(head)
    const collapsedTools = trace.querySelector('.tools')
    const collapsedToolsCards = collapsedTools === null ? 0 : collapsedTools.querySelectorAll('.tool-card').length
    const collapsedToolsVisibility =
      collapsedTools === null ? '' : window.getComputedStyle(collapsedTools).visibility
    // 一行摘要：折叠态时它必须是有文字的（"已深度思考 · N 步"之类）
    const summary = (head.textContent || '').trim()
    if (openBefore === false) head.click()
    // 展开是 grid 0fr 到 1fr 的高度过渡（250ms 量级）：等一拍再量几何
    await wait(450)
    const body = trace.querySelector('.trace-body')
    const traceRect = trace.getBoundingClientRect()
    const row = body === null ? null : body.querySelector('.tool-card')
    const iconCount = row === null ? 0 : row.querySelectorAll('.tool-head .tool-icon').length
    const thinking = body === null ? null : body.querySelector('.thinking')
    const thinkingBody = thinking === null ? null : thinking.querySelector('.thinking-body')
    const thinkingText = thinkingBody === null ? null : thinkingBody.querySelector('.thinking-text')
    let thinkingDistance = null
    if (thinking !== null && row !== null) {
      const thinkingRect = thinking.getBoundingClientRect()
      const rowRect = row.getBoundingClientRect()
      thinkingDistance = Math.round((rowRect.top - thinkingRect.top) * 10) / 10
    }
    const open = trace.classList.contains('open')
    window.__auroraTraceProbe = {
      summary: summary,
      beforeShape: beforeShape,
      afterShape: diagnose(),
      openBefore: openBefore,
      bodyBefore: collapsedBodyHidden,
      collapsedHeight: collapsedHeight,
      headHeight: headHeight,
      headBg: headStyle.backgroundColor,
      headRadius: headStyle.borderTopLeftRadius,
      collapsedToolsCards: collapsedToolsCards,
      collapsedToolsVisibility: collapsedToolsVisibility,
      collapsedToolsInDom: collapsedTools !== null,
      collapsedBodyHidden: collapsedBodyHidden,
      open: open,
      bodyMounted: body !== null,
      bodyVisibleHeight: body === null ? 0 : Math.round(body.getBoundingClientRect().height),
      traceHeight: Math.round(traceRect.height),
      rowCount: body === null ? 0 : body.querySelectorAll('.tool-card').length,
      iconCount: iconCount,
      thinkingPresent: thinking !== null,
      thinkingHeight: thinking === null ? 0 : Math.round(thinking.getBoundingClientRect().height),
      thinkingBodyMounted: thinkingBody !== null,
      thinkingTextHeight:
        thinkingText === null ? 0 : Math.round(thinkingText.getBoundingClientRect().height),
      // 展开体常驻 DOM（grid 折叠不再摘显示）：这条读数用来区分
      // "块被摘掉了"与"块在、只是被裁剪"，两者在截图上看不出来，在排查时差别很大。
      thinkingVisibility: thinking === null ? '' : window.getComputedStyle(thinking).visibility,
      thinkingBeforeRow: thinkingDistance,
      summaryChars: summary.length,
    }
    return { ok: true, ...window.__auroraTraceProbe }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`

/**
 * 执行轨迹探针 · 后半：几何与结构断言（"软胶囊 + 左缘竖脊 + 节点圆点"的直接证据）。
 *
 * 断言链：
 * ① **点开生效**：act 记录"点之前是折叠的"（`.trace` 无 `open` 类、展开体高度为 0），
 *    点完 `.trace` 有 `open` 类且 `.trace-body` 在文档里、可见高度 > 0；
 * ② **折叠态是"一行软胶囊"**：`.trace-head` 有底色（`--fill-1`）、有圆角（`--radius-sm`），
 *    `.trace` 自身四边无边框，`.trace-head` 里的摘要文字非空 —— 这条钉的是"软胶囊"这个观感口径
 *    （有人改回无底色灰字行 / 加回描边，这里就 FAIL）。⚠️ 背景色判据别用颜色字面量比对
 *    （两套主题值不同），只断言"非透明"；描边判据量**宽度**而不是颜色（无边框时
 *    `border-top-color` 解析成 `currentColor`，量颜色恒定误报 —— 2026-09-30 实测踩过）；
 * ③ **折叠态真的只剩一行**：展开体折叠高度为 0（grid `0fr`）且整条轨迹高度 ≈ 胶囊高度；
 * ④ **展开态是"竖脊 + 节点"**：`.trace-body::before` 是一条 1px 竖脊（高度 > 0），
 *    且行的 `.tool-card` 有左内边距 ≥ 8px（节点圆点骑在竖脊上所需的让位）；
 * ⑤ **工具行结构没退化**：每行恰好一枚 `.tool-icon`（与 `CHAT_SIDEBAR_SCRIPT` 同口径）、
 *    `.tool-body` 不存在或带可解析的 `--collapse-h`；
 * ⑥ **轨迹内顺序**：思考块在工具行**之上**（`thinkingBeforeRow` > 0）——
 *    与 docs/07 §2.3"思考 → 工具 → 回答"的阅读顺序同一条约束。
 *
 * ④ 用 `getComputedStyle(…, '::before')` 量伪元素：竖脊是画在展开体上的，
 * 不是独立节点，选择器查不到它。
 */
export const CHAT_TRACE_CHECK = `(() => {
  try {
    const probe = window.__auroraTraceProbe
    if (probe === undefined) return { pass: false, reason: 'CHAT_TRACE_ACT 未运行（缺 __auroraTraceProbe）' }
    const trace = document.querySelector('.message.r-assistant .trace')
    if (trace === null) return { pass: false, reason: 'no .message.r-assistant .trace' }
    const head = trace.querySelector('.trace-head')
    const body = trace.querySelector('.trace-body')
    const open = trace.classList.contains('open')
    const spine = body === null ? null : window.getComputedStyle(body, '::before')
    const spineWidth = spine === null ? 0 : parseFloat(spine.width) || 0
    const spineHeight = spine === null ? 0 : parseFloat(spine.height) || 0
    /*
     * 行内边距与"每行一枚图标"的取样要落在**展开体内部**：折叠态下展开体被 grid 轨道
     * 收成零高度（元素仍在 DOM、但几何全为 0），此时量出来的是 0，
     * 而本探针的几何断言必须在展开态下取（act 已经点开了）。
     */
    const row = body === null ? null : body.querySelector('.tool-card')
    const rowPadding = row === null ? null : window.getComputedStyle(row)
    const rowIconCount = row === null ? null : row.querySelectorAll('.tool-head .tool-icon').length
    const rowBody = row === null ? null : row.querySelector('.tool-body')
    const collapseVar = rowBody === null ? null : rowBody.style.getPropertyValue('--collapse-h')
    const collapseOk =
      collapseVar === null ? true : /^[0-9]+(\\.[0-9]+)?px$/.test(collapseVar.trim())
    // 摘要文字非空：折叠态那一行必须说得出"做了什么"
    const summaryNow = head === null ? '' : (head.textContent || '').trim()
    // 点开生效：act 记录过"点之前是折叠的"，现在必须是展开且有可见高度
    const bodyHeight = body === null ? 0 : Math.round(body.getBoundingClientRect().height)
    /*
     * "软胶囊"的判据是**有底色、有圆角、容器无描边**。
     *
     * ⚠️ 背景色只断言"非透明"，不比对颜色字面量（明暗两套主题值不同）；
     * 描边量**宽度**而不是颜色（无边框时 border-top-color 解析成 currentColor，
     * 量颜色恒定误报 —— 2026-09-30 实测踩过）。宽度 / 圆角在展开态量也成立：
     * 它们不随开合变化（底色 hover 才会浮 --fill-2，无 hover 的截图不受影响）。
     */
    const transparent = 'rgba(0, 0, 0, 0)'
    const headStyleNow = head === null ? null : window.getComputedStyle(head)
    const headBgPainted =
      headStyleNow !== null && headStyleNow.backgroundColor !== transparent
    const headRadius =
      headStyleNow === null ? 0 : parseFloat(headStyleNow.borderTopLeftRadius) || 0
    const traceStyleNow = window.getComputedStyle(trace)
    const traceBorderWidths = [
      parseFloat(traceStyleNow.borderTopWidth) || 0,
      parseFloat(traceStyleNow.borderBottomWidth) || 0,
      parseFloat(traceStyleNow.borderLeftWidth) || 0,
      parseFloat(traceStyleNow.borderRightWidth) || 0,
    ]
    const traceBorderless = traceBorderWidths.every((width) => width === 0)
    /*
     * "任务完成后自动折叠思考与调用历史"这条诉求的硬断言 —— 折叠态必须**真的只剩一行**：
     * 思考块与工具行都还在 DOM 里（探针与结构计数依赖它们），但整条轨迹的高度只能是
     * "一行软胶囊"这一档（grid 0fr 轨道把展开体收成零高度）。给 12px 余量覆盖过渡与亚像素。
     * 旧判据里的 collapsedToolsVisibility === 'hidden' 已删：grid 折叠不再需要把内容
     * 摘出布局（轨道收 0 即可），.tools 保持可见是**新口径的正常形态**。
     */
    const singleLine =
      probe.collapsedToolsInDom === true &&
      probe.collapsedToolsCards > 0 &&
      probe.collapsedHeight <= probe.headHeight + 12
    // 逐条摊开（排障与可读性双用）：pass 只看下面这份布尔表的乘积，
    // 少写一条或多写一条在报告里一眼可见，不用回头读源码。
    const conditions = {
      openBeforeFalse: probe.openBefore === false,
      bodyBeforeFalse: probe.collapsedBodyHidden === true,
      summaryChars: probe.summaryChars > 0,
      singleLine: singleLine,
      open: open === true,
      bodyPresent: body !== null,
      bodyHeight: bodyHeight > 0,
      headBgPainted: headBgPainted,
      headRounded: headRadius >= 8,
      traceBorderless: traceBorderless,
      spineWidth: spineWidth >= 1,
      spineHeight: spineHeight > 0,
      rowPresent: row !== null,
      rowIconCount: rowIconCount === 1,
      rowPadding: (parseFloat(rowPadding === null ? '' : rowPadding.paddingLeft) || 0) >= 8,
      collapseOk: collapseOk,
      thinkingBeforeRow:
        probe.thinkingPresent === false ||
        probe.thinkingBeforeRow === null ||
        probe.thinkingBeforeRow > 0,
    }
    return {
      act: probe,
      conditions: conditions,
      open: open,
      bodyHeight: bodyHeight,
      summaryNow: summaryNow,
      collapsedHeight: probe.collapsedHeight,
      collapsedHeadHeight: probe.headHeight,
      collapsedToolsCards: probe.collapsedToolsCards,
      collapsedToolsVisibility: probe.collapsedToolsVisibility,
      // 展开态里工具行必须是可见的（折叠由 grid 轨道收 0 表达，别把展开态一起藏了）
      toolsVisibilityOpen:
        body === null || body.querySelector('.tools') === null
          ? ''
          : window.getComputedStyle(body.querySelector('.tools')).visibility,
      spine: {
        width: spineWidth,
        height: spineHeight,
        color: spine === null ? '' : spine.backgroundColor,
      },
      rowIconCount: rowIconCount,
      rowPaddingLeft: rowPadding === null ? null : parseFloat(rowPadding.paddingLeft) || 0,
      collapseVar: collapseVar,
      headBg: headStyleNow === null ? '' : headStyleNow.backgroundColor,
      headRadius: headRadius,
      traceBorderWidths: traceBorderWidths,
      /*
       * 单一事实来源：pass 就是上面那张布尔表的乘积。
       * 不在这里重抄一遍条件 —— 2026-09-30 实测踩过：两份判据漂移之后
       * （conditions 已改用折叠态量到的描边宽度，pass 里还留着旧写法），
       * 报告里每条都是 true、探针却恒定 FAIL，排查成本极高。
       */
      pass: Object.values(conditions).every((value) => value === true),
    }
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

/**
 * "工具轮（**没有思考增量**）结束后轨迹必须自动收起"探针（2026-10-01 用户实测的折叠 bug）。
 *
 * 与 `CHAT_TRACE_CHECK` 的分工：那条钉**几何**（折叠态一行、展开态竖脊 + 节点），而且它
 * 自己会"先把轨迹收起来"再量（见 `CHAT_TRACE_ACT` 的前置）；这条钉**状态机**——
 * 完全不碰 DOM 状态，只读"流式结束后应用**自己**留下的那个状态"。
 *
 * 为什么必须单独一条：原先的收尾逻辑只收"这一轮被打开过的"消息，而消息只有思考增量到达
 * 时才会被打开。桩服务默认分流每轮都发 `reasoning_content`，于是**现有全部探针都覆盖不到**
 * "有工具调用、没有思考增量"的那一轮 —— 它的轨迹永远停在展开态，用户看到的就是
 * "模型答完了，工作过程还摊着不折叠"（2026-10-01 实测；现场由 `SKILL_ONLY_MARKER` 分流造出）。
 *
 * `pass` 的三段：① 现场成立（这一轮有工具卡、**没有**思考块）；② 轨迹是折叠态
 * （无 `.open` 类 + 展开体不可见）；③ 摘要行有文字（"N 步"这类可读摘要）。
 * 缺任何一段都 FAIL —— 前两段一起才能区分"收到位了"与"压根没有可收的东西"。
 */
export const CHAT_TRACE_FOLD_CHECK = `(async () => {
  try {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    // 收尾边沿的 patch 需要落一帧再看：act 判定"流式已结束"与这里读 DOM 之间隔着同一轮 Vue
    // 刷新的尾巴，不等就可能读到"还在展开"的中间态（那是假 FAIL）。
    await wait(150)
    const assistants = Array.from(document.querySelectorAll('.message.r-assistant'))
    if (assistants.length === 0) return { pass: false, reason: '没有助手消息' }
    /*
     * 目标现场从**全部**助手消息里筛，不取"最后一条"：
     * 一轮请求可能落成多条助手消息（要工具的那轮 / 给正文的那轮），最后一条未必带轨迹。
     * 判据是"这条消息有轨迹、有工具卡、**没有**思考块" —— 正是本探针要测的那个分支。
     */
    const shapeOf = (el) => {
      const trace = el.querySelector('.trace')
      const body = trace === null ? null : trace.querySelector('.trace-body')
      const bodyHidden =
        body === null ||
        window.getComputedStyle(body).display === 'none' ||
        Math.round(body.getBoundingClientRect().height) === 0
      const head = trace === null ? null : trace.querySelector('.trace-head')
      return {
        trace: trace !== null,
        cards: el.querySelectorAll('.tool-card').length,
        thinking: el.querySelector('.thinking') !== null,
        open: trace === null ? null : trace.classList.contains('open'),
        bodyHidden: trace === null ? null : bodyHidden,
        summary: head === null ? '' : (head.textContent || '').trim(),
        height: trace === null ? 0 : Math.round(trace.getBoundingClientRect().height),
      }
    }
    const rows = assistants.map(shapeOf)
    const targets = rows.filter((row) => row.trace && row.cards > 0 && row.thinking === false)
    const openRows = rows.filter((row) => row.open === true)
    const conditions = {
      // ① 现场成立：**有工具卡、没有思考块**的那一轮真的发生了（否则本探针什么都没测到）
      targetExists: targets.length > 0,
      // ② 它已经收起（无 .open 类 + 展开体不可见 + 摘要行有文字）
      targetCollapsed: targets.every(
        (row) => row.open === false && row.bodyHidden === true && row.summary.length > 0,
      ),
      // ③ 全表没有别的轨迹还摊着（本探针之前没人点开过任何一条，"答完都收起"是用户口径）
      allCollapsed: openRows.length === 0,
    }
    return {
      conditions: conditions,
      rows: rows,
      targets: targets,
      openRows: openRows.length,
      pass: Object.values(conditions).every((value) => value === true),
    }
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

/**
 * 快速会话探针（BetaV2 口径不变，2026-09 重构确认）：点左栏固定项"快速对话"
 * 必须切到 sessionId='quick'（提示条输入入口已于 2026-10 移除，主界面左栏是唯一入口；
 * 主界面左栏固定项沿用"点击切主区会话"）。
 *
 * 激活的判据有二：`chat.quick-item` 拿到 `.active` 态，且主区标题 `.head-name` 变成
 * 固定名"快速对话"（`currentTitle` 对 quick 会话短路返回）。act 里轮询等标题变化
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

/** 快速会话探针 · 后半：固定项激活 + 主区标题为"快速对话"。 */
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
 * 这一条钉住的是用户原话里的第三个诉求："用户无法设置的内容不要显示"。
 *
 * BetaV2（六页 IA）："勿扰时段"（`advanced.quietHours`）自 AdvancedPage 迁到 general 页，
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
    // v20：管理员提权开关（docs/08 §1）常显 —— 它是"会不会被权限卡住"的唯一开关，
    // 被顺手删掉/改名时这里立刻报 FAIL（与 general.launchAtLogin 同款常显口径）
    const requireAdminField = count('[data-field="general.requireAdmin"]')
    // v30：游戏模式开关常显（docs/06 §8.3）
    const gameModeField = count('[data-field="general.gameMode.enabled"]')
    // v32："外观"区组三件套常显（主题三档 / 强调色 / 毛玻璃开关）；v33 加流光特效开关。
    // 主题那档是**两个**锚点同名（区组里只有一组按钮），按数量 1 断言；
    // 强调色沿用 v21 的锚点，毛玻璃与流光是后来新增的 —— 四者一起挡住"新控件没接线"这类静默回归。
    const appearanceTheme = count('[data-field="appearance.theme"]')
    const appearanceAccent = count('[data-field="appearance.accent"]')
    const appearanceGlass = count('[data-field="appearance.glass"]')
    const appearanceAwarenessGlow = count('[data-field="appearance.awarenessGlow"]')
    // v13 项目机制（docs/06 §5.1）：项目区组常显，列表可空可非空 —— 只断言"空态或至少一行"，
    // 不写死条数（用户有几个项目都能过）。
    const projectsFields = count('[data-field^="projects."]')
    const projectsRows = count('[data-field="projects.name"]')
    const projectsEmpty = emptyStates.indexOf('projects.list') !== -1
    // 本页**预期**会出现的 data-empty：只剩"提示条停用"那一条（项目区组已于 2026-09-30
    // 迁"会话管理"页，它的空态不在这页）。
    // 其余任何空态出现都是回归（照 SETTINGS_AGENT_FIELDS_SCRIPT 的白名单口径）。
    // ⚠️ 这里曾留下一行多余的")"（删项目白名单时的残渣）：整段探针字符串是 template
    // literal，语法错**不经过 tsc**，症状是运行时 Script failed to execute、
    // 而 pnpm typecheck / pnpm test 全绿（capture.probe-strings.test.ts 的第一条只查
    // "反引号提前终止后被解析成字符串拼接"，查不到这类残渣）。2026-10-01 修掉。
    // ⚠️ 本注释也踩过同一个坑：注释里写反引号会把 template literal 提前终止 ——
    // 字符串内部的注释一律用""或单引号（见 AGENTS.md）。
    const unexpected = emptyStates.filter((name) => name !== 'general.edgeBar')
    const activeMode = document.querySelector('.cards .card.active .card-head strong')
    const activeNav = document.querySelector('.nav-item.active')
    return {
      page: activeNav === null ? 'unknown' : (activeNav.textContent || '').trim(),
      classroomFields,
      languageFields,
      edgeBarToggle,
      edgeBarDetail,
      quietHoursFields,
      requireAdminField,
      gameModeField,
      appearanceTheme,
      appearanceAccent,
      appearanceGlass,
      appearanceAwarenessGlow,
      projectsFields,
      projectsRows,
      projectsEmpty,
      unexpected,
      activeMode: activeMode === null ? null : (activeMode.textContent || '').trim(),
      emptyStates,
      // 死字段（general.language）在任何页面都不该出现；提示条详情跟着开关走；
      // 全局勿扰时段两个字段必须随页常在；且不得出现预期空态之外的 data-empty。
      // **项目区组已于 2026-09-30 迁"会话管理"页**：本页 projects.* 锚点必须为 0
      // （回归护栏 —— 区组在原处留下的话，两处入口会各自写一遍 projects 子树），
      // 项目正例断言见 settings-sessions-project.png。
      pass:
        languageFields === 0 &&
        quietHoursFields === 2 &&
        requireAdminField === 1 &&
        gameModeField === 1 &&
        appearanceTheme === 1 &&
        appearanceAccent === 1 &&
        appearanceGlass === 1 &&
        appearanceAwarenessGlow === 1 &&
        (edgeBarToggle === 0 ? edgeBarDetail === 0 : edgeBarDetail > 0) &&
        projectsFields === 0 &&
        projectsRows === 0 &&
        unexpected.length === 0,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * "Agent 设置"（原"智能与工具"）设置页门控探针（docs/08 §6.1、step 5；BetaV2 六页 IA）。
 *
 * 与 `SETTINGS_FIELDS_SCRIPT` 同一套路：`data-field` 计数 + `data-empty` 列表，
 * 但这里要额外读**总开关的实际状态**——`agent.tools.enabled` 为 false 时三个分栏控件
 * 本来就该整块消失（只剩总开关与工作目录两个常显字段）。
 *
 * ⚠️ BetaV2 变更（spec §9）：技能页与 MCP 页并入本页，"空配置下 emptyStates 为空"的旧断言
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
 * ⚠️ 2026-09 step 5：终端栏下新增"免确认命令模式"列表（`agent.tools.terminal.allowPatterns`，
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
    // v15 新增、v34 收窄：Agent 循环字段常显（不跟 agent.tools.enabled 门控）
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
    // 必须走 settings:update（SettingsStore 启动即缓存），收尾还原成出厂默认档（auto）。
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
      // 只断言"当前生效工具"那一块列出的名字：页面上别处仍会提到写类工具（各个工具箱的标题、
      // 门控说明），拿整页文本判定会把正常的说明文字当成违规。
      const activeBlock = Array.from(document.querySelectorAll('.sub')).find((el) => {
        const title = el.querySelector('.sub-title')
        return title !== null && (title.textContent || '').indexOf('当前生效工具') !== -1
      })
      const listed = activeBlock === undefined
        ? []
        : Array.from(activeBlock.querySelectorAll('code')).map((el) => (el.textContent || '').trim())
      const forbidden = [
        'run_command',
        'write_file',
        'edit_file',
        'office_create',
        'office_edit',
        'office_pdf',
        'office_raw_edit',
        'open_path',
        'todo_write',
      ]
      readonlyTools =
        listed.indexOf('read_file') !== -1 &&
        listed.indexOf('office_read') !== -1 &&
        listed.indexOf('office_help') !== -1 &&
        listed.indexOf('office_render') !== -1 &&
        listed.indexOf('list_dir') !== -1 &&
        forbidden.every((name) => listed.indexOf(name) === -1)
      await window.aurora.settings.update({
        agent: { ...before.value.agent, permissionMode: 'auto' },
        advanced: { ...before.value.advanced, confirmSensitiveTools: false },
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
      // （终端 / 文件 / 文件检索 / 打开），MCP 区组必须给出"空状态或行"之一，
      // 且不得出现两块预期空态之外的 data-empty。
      // v12 起终端栏下多一个"免确认命令模式"容器（allowPatternsFields）——
      // 它挂在终端卡片之后并跟随总开关渲染，所以断言写进 enabled !== true 的那一支；
      // ⚠️ terminalFields 刻意**不写死数值**（> 0 即可）：这个子前缀下还会继续加字段，
      // 写死数值会让探针在下一次扩展时无谓变红，而它要守的只是"终端栏的详情字段在不在"。
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
        // v34：Agent 循环只剩「同轮并行上限」一项，且常显（关掉工具总开关也必须在）
        loopFields >= 1 &&
        unexpected.length === 0,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * "语音"设置页门控探针（docs/08 §6.1、BetaV2 六页 IA；原 `SETTINGS_TTS_FIELDS_SCRIPT` 扩展）。
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
 * "列表是否为空"的判据用**两个信号取或**（`emptyStates` 含对应键，或存在
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
 * "Aurora Center"页探针（v0.2.2 设备授权登录改造后的卡片结构）：
 * 连接设置卡必须含 开关 / 服务器地址 / 展示名 / 账号 / 密码（write-only）/"登录账户"
 * （设备授权主按钮）/"密码登录"（直登回落按钮）/ clientId 只读位；隔离 userData 无令牌 →
 * 徽章必须是"未登录"、clientId 显示"尚未生成"；连接状态卡（5s 轮询）必须常在。
 */
export const SETTINGS_CENTER_FIELDS_SCRIPT = `(async () => {
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
    const deviceLoginField = document.querySelector('[data-field="center.deviceLogin"]')
    const deviceLoginRootTag = deviceLoginField === null ? '' : deviceLoginField.tagName
    const deviceLoginLabel = deviceLoginField === null ? null : deviceLoginField.querySelector('.label')
    if (deviceLoginLabel instanceof HTMLElement) deviceLoginLabel.click()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const labelClickError = Array.from(document.querySelectorAll('.toast')).some((node) =>
      ((node.textContent || '').indexOf('请先填写服务器地址') !== -1),
    )

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
        labelClickIgnored: !labelClickError,
        deviceLoginRootTag: deviceLoginRootTag,
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
        statusField > 0 &&
        !labelClickError &&
        deviceLoginRootTag === 'DIV',
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * Center 官方 TTS / STT / 生图在 Provider 页的夹具。
 *
 * 目录事件在截图环境里没有真实 Center 服务，因此 UI 会显示 `Center 暂不可用` 分支；
 * 场景仍可钉住"官方条目出现、默认项存在、无编辑/删除、本地覆盖与切回官方"。
 */
export const SETTINGS_CENTER_PROVIDER_ACT = `(async () => {
  try {
    const state = await window.aurora.settings.get()
    if (!state.ok) return { ok: false, reason: 'settings.get failed' }
    const s = state.value
    const ttsId = 'capture-local-tts'
    const sttId = 'capture-local-stt'
    const imageId = 'capture-local-image'
    window.__auroraCenterProviderProbe = {
      before: {
        center: s.center,
        tts: s.tts,
        stt: s.stt,
        imagegen: s.imagegen,
      },
      ids: [ttsId, sttId, imageId, 'center-tts', 'center-stt', 'center-imagegen'],
    }
    const result = await window.aurora.settings.update({
      center: {
        ...s.center,
        officialModels: {
          ...s.center.officialModels,
          tts: { enabled: true, model: 'center-tts-model' },
          stt: { enabled: true, model: 'center-stt-model' },
          imagegen: { enabled: true, model: 'center-image-model' },
        },
      },
      tts: {
        ...s.tts,
        enabled: true,
        active: 'center-tts',
        providers: {
          ...s.tts.providers,
          [ttsId]: {
            type: 'openai-compat',
            baseUrl: 'https://tts.example.test/v1',
            apiKeyEnc: '',
            model: 'local-tts-model',
            voice: 'alloy',
            speed: 1,
            format: 'mp3',
          },
          'center-tts': {
            type: 'openai-compat',
            baseUrl: 'http://127.0.0.1:8787/api/model-gateway/tts',
            apiKeyEnc: '',
            model: 'center-tts-model',
            voice: 'center-voice',
            speed: 1,
            format: 'mp3',
          },
        },
      },
      stt: {
        ...s.stt,
        enabled: true,
        active: 'center-stt',
        providers: {
          ...s.stt.providers,
          [sttId]: {
            type: 'openai-compat',
            baseUrl: 'https://stt.example.test/v1',
            apiKeyEnc: '',
            model: 'local-stt-model',
            language: 'zh',
          },
          'center-stt': {
            type: 'openai-compat',
            baseUrl: 'http://127.0.0.1:8787/api/model-gateway/stt',
            apiKeyEnc: '',
            model: 'center-stt-model',
            language: 'zh',
          },
        },
      },
      imagegen: {
        ...s.imagegen,
        enabled: true,
        active: 'center-imagegen',
        providers: {
          ...s.imagegen.providers,
          [imageId]: {
            type: 'openai-compat',
            baseUrl: 'https://image.example.test/v1',
            apiKeyEnc: '',
            model: 'local-image-model',
            size: '1024x1024',
          },
          'center-imagegen': {
            type: 'openai-compat',
            baseUrl: 'http://127.0.0.1:8787/api/model-gateway/imagegen',
            apiKeyEnc: '',
            model: 'center-image-model',
            size: '1024x1024',
          },
        },
      },
    })
    if (!result.ok) return { ok: false, reason: result.message }
    await new Promise((resolve) => setTimeout(resolve, 700))
    const target =
      document.querySelector('[data-field="tts.providers.center-tts"]') ||
      document.querySelector('[data-field="stt.providers.center-stt"]') ||
      document.querySelector('[data-field="imagegen.providers.center-imagegen"]')
    if (target !== null) {
      target.scrollIntoView({ block: 'center' })
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return { ok: true, seeded: true }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`

function centerProviderCheck(
  capability: 'tts' | 'stt' | 'imagegen',
  officialId: string,
  localId: string,
  restoreSettings = true,
): string {
  return `(async () => {
    try {
      const row = document.querySelector('[data-field="${capability}.providers.${officialId}"]')
      const activeField = document.querySelector('[data-field="${capability}.active"] select')
      const probe = window.__auroraCenterProviderProbe
      const text = row === null ? '' : (row.textContent || '').trim()
      const hasEdit = row === null ? true : row.querySelector('[data-action*="edit-"]') !== null
      const hasRemove = row === null ? true : row.querySelector('[data-action*="remove-"]') !== null
      const hasButton = row === null ? true : row.querySelector('button') !== null
      const option = activeField === null
        ? null
        : Array.from(activeField.options).find((item) => item.value === '${officialId}')
      const officialOption = option !== null && option !== undefined
      const initialActive = activeField === null ? '' : activeField.value

      let localOverride = false
      if (activeField !== null) {
        activeField.value = '${localId}'
        activeField.dispatchEvent(new Event('change', { bubbles: true }))
        await new Promise((resolve) => setTimeout(resolve, 350))
        localOverride =
          activeField.value === '${localId}' && row.classList.contains('accent') === false
      }
      let restored = !${restoreSettings}
      if (${restoreSettings} && probe !== undefined) {
        const removed = probe.ids.filter((id) => {
          const group = id.indexOf('center-tts') === 0
            ? probe.before.tts
            : id.indexOf('center-stt') === 0
              ? probe.before.stt
              : id.indexOf('center-imagegen') === 0
                ? probe.before.imagegen
                : null
          return group === null || group.providers[id] === undefined
        })
        const result = await window.aurora.settings.update({
          center: probe.before.center,
          tts: { ...probe.before.tts, removedProviders: removed.filter((id) => id.indexOf('tts') !== -1) },
          stt: { ...probe.before.stt, removedProviders: removed.filter((id) => id.indexOf('stt') !== -1) },
          imagegen: {
            ...probe.before.imagegen,
            removedProviders: removed.filter((id) => id.indexOf('image') !== -1),
          },
        })
        restored = result.ok === true
      }

      return {
        pass:
          row !== null &&
          activeField !== null &&
          officialOption &&
          initialActive === '${officialId}' &&
          text.indexOf('Center 官方') !== -1 &&
          text.indexOf('默认') === -1 &&
          text.indexOf('Center 暂不可用') !== -1 &&
          !hasEdit &&
          !hasRemove &&
          !hasButton &&
          localOverride &&
          restored,
        row: row !== null,
        officialOption,
        initialActive,
        hasEdit,
        hasRemove,
        hasButton,
        localOverride,
        restored,
        text,
      }
    } catch (error) {
      return { pass: false, reason: String(error) }
    }
  })()`
}

export const SETTINGS_CENTER_TTS_STT_CHECK = `(async () => {
  try {
    const tts = await ${centerProviderCheck('tts', 'center-tts', 'capture-local-tts', false)}
    const stt = await ${centerProviderCheck('stt', 'center-stt', 'capture-local-stt', false)}
    const restore = await (async () => {
      const probe = window.__auroraCenterProviderProbe
      if (probe === undefined) return false
      const removed = probe.ids.filter((id) => {
        const group = id.indexOf('center-tts') === 0
          ? probe.before.tts
          : id.indexOf('center-stt') === 0
            ? probe.before.stt
            : id.indexOf('center-imagegen') === 0
              ? probe.before.imagegen
              : null
        return group === null || group.providers[id] === undefined
      })
      const result = await window.aurora.settings.update({
        center: probe.before.center,
        tts: { ...probe.before.tts, removedProviders: removed.filter((id) => id.indexOf('tts') !== -1) },
        stt: { ...probe.before.stt, removedProviders: removed.filter((id) => id.indexOf('stt') !== -1) },
        imagegen: {
          ...probe.before.imagegen,
          removedProviders: removed.filter((id) => id.indexOf('image') !== -1),
        },
      })
      return result.ok === true
    })()
    return {
      pass: tts.pass === true && stt.pass === true && restore,
      tts,
      stt,
      restore,
    }
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

export const SETTINGS_CENTER_IMAGEGEN_CHECK = centerProviderCheck(
  'imagegen',
  'center-imagegen',
  'capture-local-image',
)

/**
 * "AI 模型"页新区组探针（BetaV2，spec §9）："对话展示"与"生图模型"。
 *
 * - `general.chat.showThinking`（v8 新字段）：对话窗思考折叠块的唯一门控，开关必须常在；
 * - `imagegen.enabled` / `imagegen.active`（v8 新 provider 体系）：同样常在；
 * - 生图 provider 列表与 TTS / STT 同一套二选一：空 → `data-empty="imagegen.providers"`，
 *   非空 → 行容器（`imagegen.providers.<id>`，后面不再有点）。
 */
/**
 * "AI 模型"页的拍图前置（step-06）：把**生图模型区组**滚进视口。
 *
 * 它在该页**最底部**，而设置窗是固定高度 + 内部滚动 —— 不滚的话这张 PNG 永远停在页头，
 * "生图空状态里有可点的『+ 添加生图模型』按钮"这条人工核对项就无从核对
 *（`SETTINGS_LLM_FIELDS_SCRIPT` 只证明空态元素在 DOM 里，不看它在不在视口内）。
 *
 * 只滚 DOM、不改任何配置，因此不影响同一场景的 check 判据。
 */
export const SETTINGS_LLM_SCROLL_ACT = `(async () => {
  try {
    const anchor = document.querySelector('[data-empty="imagegen.providers"]')
    if (anchor === null) return { ok: false, reason: 'no imagegen empty state' }
    anchor.scrollIntoView({ block: 'center' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    return { ok: true, scrolled: true }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`

export const SETTINGS_LLM_FIELDS_SCRIPT = `(() => {
  try {
    const count = (selector) => document.querySelectorAll(selector).length
    const emptyStates = Array.from(document.querySelectorAll('[data-empty]')).map((el) =>
      el.getAttribute('data-empty'),
    )
    const imagegenEmpty = emptyStates.indexOf('imagegen.providers') !== -1
    // 生图空态里的主入口（step-06）：空配置下它必须是**可点的**，不是 disabled ——
    // "空态有按钮"是本轮的视觉验收项，只靠人看 PNG 就成了一次性检查。
    const imagegenAddButtons = Array.from(
      document.querySelectorAll('[data-action="add-imagegen-provider"]'),
    ).filter((el) => el.disabled !== true)
    // v23 起设置页**不该再有** temperature 字段（配置里也删了）：反向断言，防它被加回来。
    const temperatureFields = count('[data-field$=".temperature"]')
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
      imagegenAddButtons: imagegenAddButtons.length,
      temperatureFields,
      emptyStates,
      pass:
        count('[data-field="general.chat.showThinking"]') > 0 &&
        count('[data-field="imagegen.enabled"]') > 0 &&
        count('[data-field="imagegen.active"]') > 0 &&
        (imagegenEmpty || imagegenRows > 0) &&
        // 空态时必须能看到并点到添加入口
        (!imagegenEmpty || imagegenAddButtons.length > 0) &&
        // 已废除的字段不许回来
        temperatureFields === 0,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * "模式"页探针 · 前半（BetaV2）：展开"课程表与课前提醒"分组。
 *
 * ClassroomSection 的四个分组里"课表"与"分类行为"**默认收起**（组件局部状态，非配置），
 * `modes.classroom.preClassOpenFolder`（含其空状态替身 `data-empty="modes.classroom.preClassReminder"`）
 * 只在分组展开后才进 DOM —— 不展开的话"课前提醒组二选一"断言两侧都是 0，探针必然假 FAIL。
 * 按分组标题定位（与 `SETTINGS_TTS_ADD_ACT` 的"用户可见文案优先"同一取舍，class 索引会随
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
    // 等分组体渲染出课前提醒字段（或其"先添加节次"空状态），最多 2s
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
    // 展开"课表与课前提醒"分组（提前分钟数与提醒通道都在这一组里）
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
 * check 收尾把课表来源还原成 manual、课表清空 —— 否则后续场景会带着"classisland 端点"
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
 * 毛玻璃关闭（v32）的现场准备：把 `appearance.glass` 关掉并等渲染层挂上 `data-glass="off"`。
 *
 * 只走 `settings:update`（SettingsStore 启动即把 config.json 读进内存缓存，直接改文件对运行中的
 * 进程无效）。渲染层那半由 `settings:changed` → settings store 的 watch 应用，
 * 原生材质那半由主进程 `onSettingsChanged` → `WindowManager.applyGlass(false)` 摘掉。
 */
export const APPEARANCE_GLASS_OFF_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const result = await window.aurora.settings.update({ appearance: { glass: false } })
    if (!result.ok) return { ok: false, reason: result.message }
    // 等广播回到渲染层：data-glass 是这一节的可观测证据
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (document.documentElement.getAttribute('data-glass') === 'off') break
      await wait(50)
    }
    await wait(250)
    return { ok: true, marked: document.documentElement.getAttribute('data-glass') }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`

/**
 * 毛玻璃关闭探针（v32）：**渲染层**那半 + 收尾还原。
 *
 * 三件事：
 * 1. 文档根标记为 `off`（`renderer/shared/appearance.ts` 的落点）；
 * 2. 降级真生效 —— `--glass-filter` 的计算值是 `none`，且提示条面板用的
 *    `--glass-fallback` 被压成实色（`--glass-content` 也换成了基座色，这里是抽两档代表）；
 * 3. 收尾把 `appearance.glass` 还原成 `true` —— 后续场景（含两档主题截图）必须看到默认档，
 *    否则 `theme-settings.png` 的原生材质断言会连带变红。
 *
 * 原生材质那半渲染层读不到（DWM 材质不在 DOM 里），由同一场景的 `mainAct`
 * （`nativeGlassGoneCheck`）在主进程侧断言 —— 它必须跑在 check 的**还原动作之前**。
 */
export const APPEARANCE_GLASS_OFF_CHECK = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const root = document.documentElement
    const style = getComputedStyle(root)
    const read = (name) => style.getPropertyValue(name).trim()
    const marked = root.getAttribute('data-glass')
    const filter = read('--glass-filter')
    const thick = read('--glass-filter-thick')
    const content = read('--glass-content')
    const base = read('--bg-base')
    const result = {
      marked,
      filter,
      thick,
      content,
      base,
      pass: marked === 'off' && filter === 'none' && thick === 'none' && content === base,
    }
    // 收尾还原：外观回默认档（毛玻璃开），并等标记切回 on
    const restored = await window.aurora.settings.update({ appearance: { glass: true } })
    result.restored = restored.ok === true
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (root.getAttribute('data-glass') === 'on') break
      await wait(50)
    }
    result.restoredMark = root.getAttribute('data-glass')
    result.pass = result.pass === true && result.restored === true && result.restoredMark === 'on'
    return result
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * "模式"页（ClassRoom 生效态）结构探针（BetaV2）：模式卡下方只渲染当前模式的配置区。
 *
 * 前半由 `SETTINGS_MODES_EXPAND_ACT` 展开"课表"分组，否则课前提醒字段不在 DOM。
 * 三个断言：
 * ① ClassRoom 生效 → classroom 区组在（`modes.classroom.watchDir` 恰好一行，"感知文件夹"
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
 * 落到合并后的"语音"页 —— TTS 与 STT 两个区组的常显开关都要在。
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
      // BetaV2 的 displayName 是"工作模式"（旧版是 Work Mode）：两种写法都认，
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
 * BetaV2 起 Work 模式**实装**（`WorkSection`）：切过去之后不再是"暂无可配置项"空状态卡，
 * 而是 `modes.work.workspaceDir` 字段出现、classroom 区组整块消失。三个断言：
 * ① classroom 字段数必须为 0；② `modes.work.workspaceDir` 恰好一行；
 * ③ 任何 `data-empty^="modes."` 的空状态卡（占位模式的"暂无可配置项"）都不该有 ——
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
 * 走完整的用户路径：展开"分类行为"分组 → 点 `classification.autoMove` 复选框 →
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
 * 思考等级探针 · 前半（step-02；step-05 起改写**模型行内**的参数）：走真实用户路径把"思考等级"写进配置。
 *
 * 截图用的是**隔离 userData**（`index.ts` 的 `AURORA_CAPTURE` 分支），起步时一个
 * provider 都没有，所以先经 `settings.update` 造一个带 `modelParams[<模型>].reasoningEffort: 'high'`
 * 的（v23 起参数按**模型 id** 键，provider 级 temperature / reasoningEffort 已删除）；
 * 等 `settings:changed` 推送把卡片画出来，再点开**生效 provider 那一行**的"编辑"与卡内 `.more`
 *（"高级参数与连接测试"，现在只剩接口类型与连接测试按钮），最后点**当前使用模型那一行**的
 * 参数开关 —— 思考等级下拉只在模型行展开后才在 DOM 里。
 */
export const SETTINGS_LLM_EFFORT_ACT = `(async () => {
  try {
    const state = await window.aurora.settings.get()
    if (!state.ok) return { ok: false, reason: 'settings.get failed' }
    // 与"对话窗思考等级"探针共用一份配置，两个场景谁先跑都要能自足：
    // 所以不是"没有 provider 才造"，而是"当前 provider 的思考等级不是 high 就写成 high"。
    const providers = state.value.llm.providers
    const active = state.value.llm.active !== '' ? state.value.llm.active : 'capture'
    const existing = providers[active]
    // v23 起生成参数按**模型 id** 键：先算出合并后真正生效的模型 id，再写它的三个子字段。
    const modelId = (existing ?? {}).model ?? 'deepseek-chat'
    const table = (existing ?? {}).modelParams ?? {}
    const entry = table[modelId] ?? {}
    // 记下原值：check 阶段要写回，避免把 'high' 永久留在配置里（本场景在真实 userData 下也会被跑）。
    // 缺省必须是 'auto'，**不能**记 undefined —— 否则 CHECK 的 target === probe.before
    // 会因两边都是 undefined 而误判 restored = true，把 high 永久留在配置里。
    window.__auroraEffortSettingsProbe = {
      active,
      modelId,
      before: entry.reasoningEffort ?? 'auto',
    }
    if (existing === undefined || entry.reasoningEffort !== 'high') {
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
              ...(existing ?? {}),
              // 整份替换该键的对象，但**保留该模型已有的兄弟字段** —— 写死成 0 / false 会把
              // 用户（或别的场景）填过的窗口与图片开关一起抹掉，本段收尾虽会写回，但也只写回
              // reasoningEffort 那一项。三项齐全仍是硬要求（缺 reasoningEffort 会被 Schema 判非法）。
              modelParams: {
                ...table,
                [modelId]: {
                  ...(table[modelId] ?? { reasoningEffort: 'auto', contextWindow: 0, vision: false }),
                  reasoningEffort: 'high',
                },
              },
            },
          },
        },
      })
      if (!result.ok) return { ok: false, reason: result.message }
      await new Promise((resolve) => setTimeout(resolve, 600))
    }
    // step-04 之后模型页是"provider 行列表 + 一次只开一张编辑卡"：高级参数区在**卡内**，
    // 列表态 querySelector('.more') 只会拿到 null。所以先按真实用户路径点开"编辑"，
    // 再点卡内的 .more。行上刻意没有折叠箭头，就是为了让"展开高级参数"只有一个入口、
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

    // step-05 起三个生成参数（思考等级 / 上下文窗口 / 图片输入）在**模型行内**：
    // provider 折叠区只剩接口类型与连接测试。必须点**当前使用模型那一行**的参数开关，
    // 不能取第一个 —— 隔离 userData 与全量截图里 onboarding 会先种一个 local provider，
    // 第一行未必是当前使用的那行（本段在模板字符串里，注释不能出现反引号）。
    const currentRow = row.querySelector('.model-row.current')
    if (currentRow === null) {
      return { ok: false, reason: '当前模型行未找到（.model-row.current 不存在）' }
    }
    const paramsToggle = currentRow.querySelector('[data-action="toggle-model-params"]')
    if (paramsToggle === null) return { ok: false, reason: 'no toggle-model-params in current row' }
    paramsToggle.click()
    await new Promise((resolve) => setTimeout(resolve, 300))
    // 拍图前把刚展开的参数块滚进视口：设置窗是**固定高度 + 内部滚动**，不滚的话
    // 这张 PNG 停在页头，人工核对"三个参数控件在模型行内"根本看不到它们。
    const paramsBox = currentRow.querySelector('.model-params')
    if (paramsBox !== null) paramsBox.scrollIntoView({ block: 'center' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`

/**
 * 思考等级探针 · 后半：确认"写盘 → 回读 → 渲染"整条链路通了，并把原值写回。
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
    // 与 ACT 同一套定位：step-05 起三个生成参数在**当前使用模型那一行内**
    //（类名 model-row 且带 current），整张编辑卡仍渲染在 [data-field="llm.providers.<id>"] 内部，
    // 所以先按生效 provider 限定范围、再在它的当前模型行里找。
    // 全局 querySelectorAll 会数到别人的卡：全量截图里 onboarding 先种了 local provider，
    // 行首未必是 active 那个 —— 那时会读到别人的 auto，探针假 FAIL（真实缺陷，已实测复现）。
    const scope =
      probe === undefined
        ? document
        : document.querySelector('[data-field="llm.providers.' + probe.active + '"]')
    const currentRow = scope === null ? null : scope.querySelector('.model-row.current')
    const effortFields =
      scope === null
        ? []
        : scope.querySelectorAll('.model-row.current [data-field$=".reasoningEffort"]')
    const first = effortFields[0]
    const select = first === undefined ? null : first.querySelector('select')
    const value = select === null ? null : select.value
    const domOk = effortFields.length > 0 && value === 'high'

    // DOM 断言必须先读（写回会触发 settings:changed 重新渲染，之后就读不到 high 了）
    let restored = null
    const state = await window.aurora.settings.get()
    if (state.ok && probe !== undefined) {
      const providers = state.value.llm.providers
      const target = providers[probe.active]
      const table = (target ?? {}).modelParams ?? {}
      const entry = table[probe.modelId] ?? {}
      if (target === undefined || entry.reasoningEffort === probe.before) {
        restored = true
      } else {
        const result = await window.aurora.settings.update({
          llm: {
            active: state.value.llm.active,
            providers: {
              ...providers,
              [probe.active]: {
                ...target,
                // 写回时整份替换该键的对象、三项一起写全（reasoningEffort 没有 .default()）
                modelParams: {
                  ...table,
                  [probe.modelId]: {
                    reasoningEffort: probe.before,
                    contextWindow: entry.contextWindow ?? 0,
                    vision: entry.vision === true,
                  },
                },
              },
            },
          },
        })
        restored = result.ok === true
      }
    }

    return {
      active: probe === undefined ? null : probe.active,
      modelId: probe === undefined ? null : probe.modelId,
      // 这条是"当前模型行存在"的直接证据：harness 会把 ACT 的返回值丢掉（只留 check 的），
      // 只写进 ACT 的失败文案在报告里看不到 —— 所以在这里如实回传一次。
      currentRow: currentRow !== null,
      effortFields: effortFields.length,
      value,
      restored,
      pass: domOk && restored === true,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 对话窗思考等级探针 · 前半（step-03）：把交互窗输入区的"思考"下拉切到 `high`。
 *
 * 截图用**隔离 userData**，起步时一个 provider 都没有 —— 而"没有可用 provider"时渲染层按设计把控件
 * `disabled`（不隐藏），此时切不动。所以先像 `SETTINGS_LLM_EFFORT_ACT` 那样造一个 provider，再操作下拉。
 * 原值记到 `window.__auroraEffortProbe`，供 check 阶段**写回**，避免污染后面的截图场景。
 *
 * v23 起思考等级按**模型 id** 键（`llm.providers.<id>.modelParams.<modelId>.reasoningEffort`，
 * provider 级字段已删除）：种子 provider 的 `modelParams` 要与 `model` 同键，`before` 记
 * "该模型的原值（缺省 `'auto'`）"——**不能**记 `undefined`，否则 CHECK 的
 * `current === probe.before` 会因两边都是 `undefined` 而误判已还原，把 `high` 留在配置里。
 */
export const CHAT_THINKING_LEVEL_ACT = `(async () => {
  try {
    let state = await window.aurora.settings.get()
    if (!state.ok) return { changed: false, reason: 'settings.get failed' }
    if (Object.keys(state.value.llm.providers).length === 0) {
      // 生成参数是按**模型 id** 键的（v23）：种子条目必须与 provider.model 同键，
      // 且三项一起写全，别留下半截条目（provider 级已无 reasoningEffort / temperature）。
      const seedModel = 'deepseek-chat'
      const created = await window.aurora.settings.update({
        llm: {
          active: 'capture',
          providers: {
            capture: {
              type: 'openai-compat',
              baseUrl: 'https://api.deepseek.com/v1',
              apiKeyEnc: '',
              model: seedModel,
              modelParams: {
                [seedModel]: { reasoningEffort: 'auto', contextWindow: 0, vision: false },
              },
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
    // 取值口径与渲染层一致（resolveModelParams，v23）：按**模型 id** 键，缺省 'auto'。
    // **不能**把 before 记成 undefined —— 那样 CHECK 里 current === probe.before
    // 会因两边都是 undefined 而误判 restored = true，把探针写进去的 high 永久留在配置里。
    const paramsOf = (target) => {
      if (target === undefined || target === null) return null
      const table = target.modelParams === undefined ? {} : target.modelParams
      const entry = table[target.model]
      return entry === undefined || entry === null
        ? { reasoningEffort: 'auto', contextWindow: 0, vision: false }
        : entry
    }
    const beforeParams = paramsOf(provider)
    window.__auroraEffortProbe = {
      active: active,
      modelId: provider === undefined ? null : provider.model,
      before: beforeParams === null ? null : beforeParams.reasoningEffort || 'auto',
    }

    // 轮询等触发器可用：它的 disabled 取决于**渲染层 settingsStore 是否已水合**（不是配置本身），
    // 而 disabled 元素上的 click 不触发处理函数 → 探针会假 FAIL。最多等 2.5s。
    // 2026-10-18：思考等级从原生 select 改成自绘浮层（触发器 + chat.effort-menu），
    // 这里走真实点击链路：点触发器 → 等 chat.effort-high 选项 → 点它。
    let trigger = null
    for (let attempt = 0; attempt < 10 && trigger === null; attempt += 1) {
      const candidate = document.querySelector('[data-field="chat.reasoningEffort"]')
      if (candidate !== null && candidate.disabled !== true) {
        trigger = candidate
      } else {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    if (trigger === null) {
      return { changed: false, reason: 'chat.reasoningEffort 触发器始终不可用（settingsStore 未水合？）' }
    }

    trigger.click()
    let highOption = null
    let optionCount = 0
    for (let attempt = 0; attempt < 12 && highOption === null; attempt += 1) {
      const menu = document.querySelector('[data-field="chat.effort-menu"]')
      optionCount = menu === null ? 0 : menu.querySelectorAll('[data-level]').length
      const candidate = document.querySelector('[data-field="chat.effort-high"]')
      if (candidate !== null) highOption = candidate
      else await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (highOption === null) {
      return { changed: false, reason: 'chat.effort-high 选项没有出现（浮层未打开？）' }
    }
    highOption.click()
    window.__auroraEffortProbe.options = optionCount
    await new Promise((resolve) => setTimeout(resolve, 600))
    return {
      changed: true,
      options: optionCount,
      triggerText: (trigger.textContent || '').trim(),
      disabled: trigger.disabled === true,
    }
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
 *
 * v23：配置值改读 `modelParams[provider.model].reasoningEffort`（与渲染层的
 * `resolveModelParams` 同口径，缺省 `'auto'`），写回时**整份替换该键对象且三项写全**——
 * 三个子字段都有默认值兜底，三项一起写只是防御纵深（别留下半截条目）。
 */
export const CHAT_THINKING_LEVEL_CHECK = `(async () => {
  try {
    const state = await window.aurora.settings.get()
    if (!state.ok) return { pass: false, reason: 'settings.get failed' }
    const active = state.value.llm.active
    const provider = active === '' ? undefined : state.value.llm.providers[active]
    // 取值口径同渲染层的 resolveModelParams（v23）：按**模型 id** 键，缺省 'auto'。
    // 再读 provider 级的 reasoningEffort 只会恒读到 undefined → 假 FAIL（该字段已删除）。
    const paramsOf = (target) => {
      if (target === undefined || target === null) return null
      const table = target.modelParams === undefined ? {} : target.modelParams
      const entry = table[target.model]
      return entry === undefined || entry === null
        ? { reasoningEffort: 'auto', contextWindow: 0, vision: false }
        : entry
    }
    const configParams = paramsOf(provider)
    const configValue = configParams === null ? null : configParams.reasoningEffort || 'auto'

    const field = document.querySelector('[data-field="chat.reasoningEffort"]')
    const domValue = field === null ? null : field.getAttribute('data-value')
    const probeForOptions = window.__auroraEffortProbe
    const optionCount =
      probeForOptions === undefined || probeForOptions === null
        ? 0
        : probeForOptions.options || 0

    // 写回原值：本场景会改配置，后面还有别的截图场景，不能让它们看到 high。
    // 写回落在**模型 id** 那一项上（provider 级字段已随 v23 删除），且整份替换该键对象、
    // 三项都写全，别留下半截条目。
    const probe = window.__auroraEffortProbe
    let restored = null
    if (probe !== undefined && probe.active !== '' && probe.before !== null) {
      const providers = state.value.llm.providers
      const target = providers[probe.active]
      const targetParams = paramsOf(target)
      const current = targetParams === null ? null : targetParams.reasoningEffort || 'auto'
      if (target === undefined || current === probe.before) {
        // 本来就是我们创建/没改动的值：无需写回，视为已还原
        restored = true
      } else {
        const modelId = target.model
        const table = target.modelParams === undefined ? {} : target.modelParams
        const result = await window.aurora.settings.update({
          llm: {
            active: state.value.llm.active,
            providers: {
              ...providers,
              [probe.active]: {
                ...target,
                modelParams: {
                  ...table,
                  [modelId]: {
                    reasoningEffort: probe.before,
                    contextWindow: targetParams === null ? 0 : targetParams.contextWindow || 0,
                    vision: targetParams !== null && targetParams.vision === true,
                  },
                },
              },
            },
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
 * 用户感知就是"有些能拖有些不行"。三个断言分别对应三类真实故障：
 * ① 一个可见拖动区都没有（没挂 class）；② 高度的最大值 < 32px（挂了但抓不住）；
 * ③ 拖动区里的按钮被 `-webkit-app-region: drag` 吃掉点击（`elementFromPoint` 命中的不是按钮自己）。
 *
 * 读数兼容两种属性名：Chromium 上生效值可能只认 `-webkit-app-region` 或 `app-region` 之一。
 * 若两者都读到空串，说明该属性**不可读**——此时不要把它改成永远 PASS：保留 `regionValue` 原值
 * 供排查，判定口径的取舍写在 docs/07 §5.3（`regions` 数组本身已经能说明"挂没挂、够不够大"）。
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
    const settingsShell = document.querySelector('.settings') !== null
    const fullWidthAtTop =
      !settingsShell ||
      regions.some(
        (item) =>
          item.visible &&
          item.top <= 1 &&
          item.w >= document.documentElement.clientWidth - 1 &&
          item.h >= 32,
      )
    if (biggest !== null) {
      const style = getComputedStyle(biggest)
      regionValue = (
        style.getPropertyValue('-webkit-app-region') || style.getPropertyValue('app-region') || ''
      ).trim()
      // 按钮命中检验有两个现场：按钮**在拖动区内**（chat 头部，验证 no-drag 不被 drag 吃掉）
      // 与按钮**不在任何拖动区内**（设置窗 2026-10 起 caption 贴窗口右上缘 fixed 定位，
      // 不在拖动区里）——后者回退到全局关闭按钮，验证的语义变成"没被别的浮层盖住"。
      const button =
        biggest.querySelector('button') || document.querySelector('[data-caption-btn="close"]')
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
      fullWidthAtTop,
      buttonLabel,
      buttonHit,
      pass:
        regions.some((item) => item.visible) &&
        maxHeight >= 32 &&
        regionValue === 'drag' &&
        fullWidthAtTop &&
        buttonHit === true,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

/**
 * 对话窗模型选择器探针 · 前半：造本机 + Center 两个来源，依次切 Center / 用户模型。
 * 全局默认为本机时初始来源必须是 local（官方开启不再抢占，2026-10-24）。
 *
 * 双下拉后 [data-field="chat.modelSource"] 管来源，[data-field="chat.model"] 管具体模型。
 * 探针用 reserved id `capture-source` 和 `center-llm`，原值记到 window.__auroraModelProbe，
 * check 阶段完整还原；不依赖会话已经有覆盖。
 */
export const CHAT_MODEL_PICKER_ACT = `(async () => {
  try {
    const state = await window.aurora.settings.get()
    if (!state.ok) return { changed: false, reason: 'settings.get failed' }
    const providers = state.value.llm.providers
    const localId = 'capture-source'
    const centerId = 'center-llm'
    const beforeLocal = providers[localId] === undefined ? null : providers[localId]
    const beforeCenter = providers[centerId] === undefined ? null : providers[centerId]
    const beforeOfficial = state.value.center.officialModels.llm
    window.__auroraModelProbe = {
      active: state.value.llm.active,
      beforeLocal,
      beforeCenter,
      beforeOfficial,
    }

    const initialSessions = await window.aurora.chat.sessions()
    const priorOverride =
      initialSessions.ok === true
        ? initialSessions.value.find((item) => item.llm !== undefined)
        : undefined
    window.__auroraModelProbe.priorOverride =
      priorOverride === undefined || priorOverride.llm === undefined
        ? null
        : { sessionId: priorOverride.id, llm: priorOverride.llm }
    if (priorOverride !== undefined) {
      await window.aurora.chat.setSessionModel({
        sessionId: priorOverride.id,
        providerId: '',
        model: '',
      })
      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    const seeded = await window.aurora.settings.update({
      llm: {
        active: localId,
        providers: {
          [localId]: {
            type: 'openai-compat',
            baseUrl: 'https://api.deepseek.com/v1',
            apiKeyEnc: '',
            model: 'deepseek-chat',
            modelList: ['deepseek-chat', 'deepseek-reasoner'],
            modelParams: {},
          },
          [centerId]: {
            type: 'openai-compat',
            baseUrl: 'http://127.0.0.1:8787/api/model-gateway/llm',
            apiKeyEnc: '',
            model: 'center-a',
            modelList: ['center-a', 'center-b'],
            modelParams: {},
          },
        },
      },
      center: {
        ...state.value.center,
        officialModels: {
          ...state.value.center.officialModels,
          llm: { enabled: true, model: 'center-a' },
        },
      },
    })
    if (!seeded.ok) return { changed: false, reason: seeded.message }
    await new Promise((resolve) => setTimeout(resolve, 700))

    const sessionsAfterSeed = await window.aurora.chat.sessions()
    window.__auroraModelProbe.overriddenAfterSeed =
      sessionsAfterSeed.ok === true &&
      sessionsAfterSeed.value.some((item) => item.llm !== undefined)

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const triggerOf = (field) => {
      const node = document.querySelector('[data-field="' + field + '"]')
      return node !== null && node.tagName === 'BUTTON' ? node : null
    }
    const menuOf = () => document.querySelector('[data-field="chat.model-menu"]')
    const optionByKey = (key) =>
      Array.from(document.querySelectorAll('[data-field="chat.model-option"]')).find(
        (el) => el.getAttribute('data-model-key') === key,
      )
    // 2026-10-18：模型来源 / 模型从原生 select 改成自绘浮层。这里走真实交互：
    // 点触发器 → 等 chat.model-menu → 点来源 / 模型项；aria-expanded 是"组件自认为开着"的权威信号。
    const openMenu = async (which) => {
      const trigger = triggerOf(which === 'source' ? 'chat.modelSource' : 'chat.model')
      if (trigger === null) return false
      if (trigger.getAttribute('aria-expanded') !== 'true') {
        trigger.click()
        await wait(180)
      }
      return menuOf() !== null
    }
    const chooseSource = async (id) => {
      if (!(await openMenu('source'))) return false
      const node = document.querySelector('[data-field="chat.model-source-' + id + '"]')
      if (node === null) return false
      node.click()
      await wait(700)
      return true
    }
    const chooseModel = async (providerId, model) => {
      if (!(await openMenu('model'))) return false
      const key = JSON.stringify([providerId, model])
      let node = null
      for (let attempt = 0; attempt < 20 && node === null; attempt += 1) {
        node = optionByKey(key)
        if (node === null) await wait(100)
      }
      if (node === null) return false
      node.click()
      await wait(600)
      return true
    }

    let sourceTrigger = null
    let modelTrigger = null
    for (
      let attempt = 0;
      attempt < 12 && (sourceTrigger === null || modelTrigger === null);
      attempt += 1
    ) {
      const sourceCandidate = triggerOf('chat.modelSource')
      const modelCandidate = triggerOf('chat.model')
      if (
        sourceCandidate !== null &&
        modelCandidate !== null &&
        sourceCandidate.disabled !== true &&
        modelCandidate.disabled !== true
      ) {
        sourceTrigger = sourceCandidate
        modelTrigger = modelCandidate
      } else {
        await wait(250)
      }
    }
    if (sourceTrigger === null || modelTrigger === null) {
      return { changed: false, reason: '模型来源 / 模型触发器始终不可用' }
    }

    if (!(await openMenu('source'))) {
      return { changed: false, reason: '模型菜单没有打开' }
    }
    const sourceValues = ['center', 'local'].filter(
      (id) => document.querySelector('[data-field="chat.model-source-' + id + '"]') !== null,
    )
    if (sourceValues.indexOf('center') === -1 || sourceValues.indexOf('local') === -1) {
      return { changed: false, reason: '双来源没有同时出现', sourceValues }
    }
    window.__auroraModelProbe.initialSource = sourceTrigger.getAttribute('data-source-id') || ''

    if (!(await chooseSource('local'))) {
      return { changed: false, reason: '点不到本机来源' }
    }
    window.__auroraModelProbe.localOptionCount =
      document.querySelectorAll('[data-field="chat.model-option"]').length
    if (!(await chooseSource('center'))) {
      return { changed: false, reason: '点不到 Center 来源' }
    }
    const centerSessions = await window.aurora.chat.sessions()
    const centerOverride =
      centerSessions.ok === true ? centerSessions.value.find((item) => item.llm !== undefined) : undefined

    if (!(await chooseModel('center-llm', 'center-b'))) {
      return { changed: false, reason: 'Center 候选 center-b 不存在' }
    }
    const centerModelSessions = await window.aurora.chat.sessions()
    const centerModelOverride =
      centerModelSessions.ok === true
        ? centerModelSessions.value.find((item) => item.llm !== undefined)
        : undefined

    if (!(await chooseSource('local'))) {
      return { changed: false, reason: '切不回本机来源' }
    }
    if (!(await chooseModel(localId, 'deepseek-reasoner'))) {
      return { changed: false, reason: '本机候选 deepseek-reasoner 不存在' }
    }
    window.__auroraModelProbe.centerProvider =
      centerOverride === undefined || centerOverride.llm === undefined
        ? null
        : centerOverride.llm.providerId
    window.__auroraModelProbe.centerModel =
      centerOverride === undefined || centerOverride.llm === undefined
        ? null
        : centerOverride.llm.model
    window.__auroraModelProbe.centerSelectedProvider =
      centerModelOverride === undefined || centerModelOverride.llm === undefined
        ? null
        : centerModelOverride.llm.providerId
    window.__auroraModelProbe.centerSelectedModel =
      centerModelOverride === undefined || centerModelOverride.llm === undefined
        ? null
        : centerModelOverride.llm.model
    return {
      changed: true,
      sourceValues,
      initialSource: window.__auroraModelProbe.initialSource,
      overriddenAfterSeed: window.__auroraModelProbe.overriddenAfterSeed,
      centerProvider: window.__auroraModelProbe.centerProvider,
      centerModel: window.__auroraModelProbe.centerModel,
      centerSelectedProvider: window.__auroraModelProbe.centerSelectedProvider,
      centerSelectedModel: window.__auroraModelProbe.centerSelectedModel,
    }
  } catch (error) {
    return { changed: false, reason: String(error) }
  }
})()`

/**
 * 对话窗模型选择器探针 · 后半：断言双下拉的会话覆盖、全局不变和来源还原。
 */
export const CHAT_MODEL_PICKER_CHECK = `(async () => {
  try {
    const state = await window.aurora.settings.get()
    if (!state.ok) return { pass: false, reason: 'settings.get failed' }
    const localId = 'capture-source'
    const centerId = 'center-llm'
    const globalProvider = state.value.llm.providers[localId]
    const globalModel = globalProvider === undefined ? null : globalProvider.model

    const field = document.querySelector('[data-field="chat.model"]')
    const sourceField = document.querySelector('[data-field="chat.modelSource"]')
    const domKey = field === null ? '' : field.getAttribute('data-model-key') || ''
    let domValue = null
    try {
      domValue = domKey === '' ? null : JSON.parse(domKey)
    } catch {
      domValue = null
    }
    const sourceValue = sourceField === null ? null : sourceField.getAttribute('data-source-id')
    const probeForOptions = window.__auroraModelProbe
    const optionCount =
      probeForOptions === undefined || probeForOptions === null
        ? 0
        : probeForOptions.localOptionCount || 0

    const sessions = await window.aurora.chat.sessions()
    const overridden =
      sessions.ok === true ? sessions.value.find((item) => item.llm !== undefined) : undefined
    const sessionProvider =
      overridden === undefined || overridden.llm === undefined ? null : overridden.llm.providerId
    const sessionModel =
      overridden === undefined || overridden.llm === undefined ? null : overridden.llm.model

    const cleared = await window.aurora.chat.setSessionModel({
      sessionId: overridden === undefined ? 'main' : overridden.id,
      providerId: '',
      model: '',
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const afterSessions = await window.aurora.chat.sessions()
    const stillOverridden =
      afterSessions.ok === true && afterSessions.value.some((item) => item.llm !== undefined)

    let restored = cleared.ok === true && !stillOverridden
    const probe = window.__auroraModelProbe
    if (probe !== undefined) {
      if (probe.priorOverride !== null) {
        const prior = await window.aurora.chat.setSessionModel({
          sessionId: probe.priorOverride.sessionId,
          providerId: probe.priorOverride.llm.providerId,
          model: probe.priorOverride.llm.model,
        })
        restored = restored && prior.ok === true
      }
      const removedProviders = []
      const providers = {}
      if (probe.beforeLocal === null) removedProviders.push(localId)
      else providers[localId] = probe.beforeLocal
      if (probe.beforeCenter === null) removedProviders.push(centerId)
      else providers[centerId] = probe.beforeCenter
      const result = await window.aurora.settings.update({
        llm: { active: probe.active, providers, removedProviders },
        center: {
          ...state.value.center,
          officialModels: {
            ...state.value.center.officialModels,
            llm: probe.beforeOfficial,
          },
        },
      })
      restored = restored && result.ok === true
    }

    return {
      pass:
        probe !== undefined &&
        probe.overriddenAfterSeed === false &&
        // 全局默认在本机（capture-source）时，官方开启也不得抢占；官方仍作为可选来源。
        probe.initialSource === 'local' &&
        probe.centerProvider === 'center-llm' &&
        probe.centerModel === 'center-a' &&
        probe.centerSelectedProvider === 'center-llm' &&
        probe.centerSelectedModel === 'center-b' &&
        globalModel === 'deepseek-chat' &&
        sessionProvider === localId &&
        sessionModel === 'deepseek-reasoner' &&
        sourceValue === 'local' &&
        domValue !== null &&
        domValue[0] === localId &&
        domValue[1] === 'deepseek-reasoner' &&
        optionCount >= 2 &&
        restored === true,
      globalModel,
      sessionProvider,
      sessionModel,
      domValue,
      sourceValue,
      optionCount,
      cleared: cleared.ok === true,
      stillOverridden,
      restored,
      probe,
    }
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

/**
 * 对话窗"朗读"按钮探针 · 前半（step-06）：在渲染层点一次 [data-action="speak-message"]。
 *
 * ⚠️ **act 只负责触发点击**，不断言真的出声：截图跑在隔离 userData + 离线环境上，
 * 合成必然失败（且顺序上"缺 API Key"先于"请求失败"——`tts.error` 的文案与它无关）。
 * "点完之后按钮有没有回到朗读态"由 check 断言。
 *
 * 按钮**没有强制造出来**，这是刻意的取舍：
 * - 不做配置改写：本场景在真实 userData 下也会被跑（`AURORA_CAPTURE_WINDOWS=chat`），
 *   从 0 造一个 TTS provider 再删掉会动到用户的 `tts.providers` / `tts.active` / 明文凭据缓存；
 * - 即便造了也未必成：按钮的出现取决于渲染层的 `ttsReady`，而它读的是**本窗口** `settingsStore`
 *   已水合的 settings。探针里点一次侧栏"新会话"会让 `chat.switchSession` 走一遍
 *   `hydrate` + `loadSessions` 的长往返，期间"对话"侧栏短暂空白，窗口宽度随之伸缩，反而更不稳。
 *
 * 所以"没有按钮"是**预期分支**：如实返回说明，交给 check 用退化判据处理（不抛错、不假 PASS）。
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
    // 0) 先把 TTS 配置写成"可朗读"（总开关 + 三要素齐全的 provider），否则按钮按设计不渲染。
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
 * 对话窗"朗读"按钮探针 · 后半（step-06）：按钮存在，且点击后**回到"朗读"态**。
 *
 * 两条判据二选一，用到的哪条写在返回值的 `criterion` 里（排查假 FAIL 先看它）：
 * - `'ready'`（首选）：act 点过按钮之后，它必须在 1.5s 内回到 `data-action="speak-message"`
 *   且文案是"朗读"——说明 `useTts` 的 `loading` 有复位、没有卡死在"合成中…"。
 *   离线环境下合成会失败，但失败路径同样会清 `loading`，所以这条判据离线可跑。
 * - `'presence'`（退化）：页面上确实有助手消息（`.message.r-assistant` 非空），
 *   但 READY 所要求的前提不成立（act 没点到 / 渲染层 `settingsStore` 尚未水合出 TTS 配置），
 *   此时**只断言按钮存在性**，不去冤枉"loading 没复位"。
 *
 * `pass` 与判据解耦，两种情况下都是"该看到的按钮确实看到了"：
 * `'ready'` 要它存在**且**已复位，`'presence'` 只要它存在。
 * 注意这条断言不覆盖"没有回复时按钮不该有"这一面 —— 那个前提在 capture 计划里不成立
 *（见 `CHAT_TTS_SPEAK_ACT` 的注释），单靠本探针无法区分"按设计不渲染"与"渲染漏了"，
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
    // 首选用"回到朗读态"；它要求的前提不成立时退化成存在性
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
    // 只在"是 act 自己造的那一个"时清，用户原有的配置一律不动。
    //
    // ⚠️ 必须带 removedProviders：tts.providers 是 record，"缺项 ≠ 删除"——
    // 只把键从传回去的对象里删掉，主进程合并时缺项会被当成"本次不动这一项"，
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
 * "AI 模型"页"模型设置"区探针 · 前半（step-05）：点开第一行的"编辑"并点一次"+ 手动添加"。
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
              // "+ 手动添加加一行"的行数断言需要**确定的起点**：候选列表写死一行，
              // 不依赖 syncDrafts 的自动补行。
              modelList: ['deepseek-chat'],
              // 生成参数按**模型 id** 键（v23）：三项一起写全（reasoningEffort 没有 .default()）。
              modelParams: {
                'deepseek-chat': { reasoningEffort: 'auto', contextWindow: 0, vision: false },
              },
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
    // 行 = 模型列表区（[data-field$=".modelList"]）里的 .model-row。两个限定都不能省：
    // ⚠️ 不能用 [data-field*=".modelList."] —— step-05 起行内还有三个参数子字段锚点
    //（同样以 .modelList. 开头）会让行数虚高，"after === before + 1"当场变假 FAIL；
    // ⚠️ 不能用 [data-field*=".modelList."] 数行：行内的三个参数子字段锚点也以 .modelList.
    //    开头，会数虚高。这里按行容器类名数；判据是**相对增量**（after === before + 1），
    //    所以即便 DOM 上同时存在两张卡也不会假 FAIL（本段在模板字符串里，注释不能出现反引号）。
    const countRows = () => document.querySelectorAll('[data-field$=".modelList"] .model-row').length
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
 * "模型设置"区探针 · 后半：区存在、列表行数 ≥ 1、"+ 手动添加"使行数恰好 +1，并删回原状。
 *
 * 这里同时也钉住"删除当前模型不静默换模型"的反面：**恢复动作必须只减行、不改 model**
 * （所以删的是刚加出来的那一行，不是当前使用的那行）。配置侧的一致性由
 * `chat-model-picker` 那条探针（配置值 === DOM 值）与设置页保存语义共同覆盖。
 */
export const SETTINGS_LLM_MODELS_CHECK = `(async () => {
  try {
    const section = document.querySelector('[data-field$=".modelList"]')
    // 与 ACT 同一套计数口径：模型列表区里的 .model-row（行内参数子字段同样以 .modelList. 开头，
    // 用 [data-field*=".modelList."] 会虚高）。
    const countRows = () => document.querySelectorAll('[data-field$=".modelList"] .model-row').length
    const probe = window.__auroraLlmModelsProbe
    const before = probe === undefined ? null : probe.before
    const after = probe === undefined ? null : probe.after

    // 恢复：删掉"+ 手动添加"加出来的最后一行（它是最新加的空行）
    const rows = Array.from(document.querySelectorAll('[data-field$=".modelList"] .model-row'))
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
 * 「默认模型」下拉探针 · 前半（v37，docs/08 §5）。
 *
 * 真实用户路径：在设置页选中另一个模型 → 配置里 `llm.active` 与
 * `llm.providers.<id>.model` 同时变化。隔离 userData 起步可能没有 provider，
 * 所以先像其它 LLM 探针一样自足地造一个；随后把同一 provider 的第二个模型
 * 加进候选列表（没有就临时加，check 收尾时删掉），再**通过下拉本身**切换。
 */
export const SETTINGS_LLM_DEFAULT_ACT = `(async () => {
  try {
    let state = await window.aurora.settings.get()
    if (!state.ok) return { ok: false, reason: 'settings.get failed' }
    let settings = state.value
    if (Object.keys(settings.llm.providers).length === 0) {
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
              modelParams: {
                'deepseek-chat': { reasoningEffort: 'auto', contextWindow: 0, vision: false },
              },
            },
          },
        },
      })
      if (!created.ok) return { ok: false, reason: created.message }
      await new Promise((resolve) => setTimeout(resolve, 600))
      state = await window.aurora.settings.get()
      if (!state.ok) return { ok: false, reason: 'settings.get#2 failed' }
      settings = state.value
    }

    const ids = Object.keys(settings.llm.providers)
    const active = settings.llm.active !== '' ? settings.llm.active : ids[0]
    const provider = settings.llm.providers[active]
    if (provider === undefined) return { ok: false, reason: 'no provider for default model' }
    const beforeModel = provider.model
    const beforeList = (provider.modelList || []).slice()
    const second =
      beforeList.find((item) => item !== '' && item !== beforeModel) || 'capture-model-2'
    const added = !beforeList.includes(second)
    window.__auroraDefaultProbe = {
      active,
      beforeActive: settings.llm.active,
      beforeModel,
      beforeList,
      second,
      added,
    }

    if (added) {
      const table = provider.modelParams || {}
      const result = await window.aurora.settings.update({
        llm: {
          active: settings.llm.active,
          providers: {
            ...settings.llm.providers,
            [active]: {
              ...provider,
              modelList: beforeList.concat([second]),
              modelParams: {
                ...table,
                [second]: table[second] || {
                  reasoningEffort: 'auto',
                  contextWindow: 0,
                  vision: false,
                },
              },
            },
          },
        },
      })
      if (!result.ok) return { ok: false, reason: result.message }
      await new Promise((resolve) => setTimeout(resolve, 600))
    }

    const select = document.querySelector('[data-field="llm.defaultModel"]')
    if (select === null) return { ok: false, reason: 'no default model select' }
    const value = JSON.stringify([active, second])
    const hasOption = Array.from(select.options).some((option) => option.value === value)
    if (!hasOption) return { ok: false, reason: 'second model not in default options' }
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 600))
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`

/**
 * 「默认模型」下拉探针 · 后半：DOM 值 === 配置值，并写回原默认与候选列表。
 *
 * 只断言"选中有反应"不够（写死一个 `<select>` 也能有 value），所以两边都读：
 * ① DOM 的当前值；② `settings.get()` 里的 `llm.active` 与对应 `model`。
 * 恢复顺序先读 DOM 再写配置 —— 写回会触发 settings:changed 重渲染，之后 DOM 值就变了。
 */
export const SETTINGS_LLM_DEFAULT_CHECK = `(async () => {
  try {
    const probe = window.__auroraDefaultProbe
    const select = document.querySelector('[data-field="llm.defaultModel"]')
    const expected = probe === undefined ? null : JSON.stringify([probe.active, probe.second])
    const domValue = select === null ? null : select.value
    const state = await window.aurora.settings.get()
    const target = state.ok && probe !== undefined ? state.value.llm.providers[probe.active] : null
    const configOk =
      state.ok &&
      probe !== undefined &&
      state.value.llm.active === probe.active &&
      target !== null &&
      target !== undefined &&
      target.model === probe.second

    let restored = null
    if (state.ok && probe !== undefined && target !== null && target !== undefined) {
      const table = { ...(target.modelParams || {}) }
      if (probe.added) delete table[probe.second]
      const result = await window.aurora.settings.update({
        llm: {
          active: probe.beforeActive,
          providers: {
            ...state.value.llm.providers,
            [probe.active]: {
              ...target,
              model: probe.beforeModel,
              modelList: probe.beforeList.slice(),
              modelParams: table,
            },
          },
        },
      })
      restored = result.ok
    }

    return {
      pass:
        select !== null &&
        expected !== null &&
        domValue === expected &&
        configOk === true &&
        restored === true,
      selectExists: select !== null,
      domValue,
      expected,
      configOk,
      restored,
    }
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

/**
 * "AI 模型"页结构探针 · 前半（step-04）：点开第一行 provider 的"编辑"。
 *
 * 这一步刻意**不写配置**：`settings-llm-params` 那条会造 provider 并断言下拉真值，
 * 两条场景互相干扰的话失败原因很难定位。这里只点开一张卡，验证"一次只开一张"。
 * 优先用 `data-action="edit-provider"` 定位，找不到就按文案"编辑"兜底——
 * 兜底也失败时把行内实际按钮文案回传（而不是静默成功），否则改个文案这条断言就变成空转。
 */
export const SETTINGS_LLM_STRUCTURE_ACT = `(async () => {
  try {
    const state = await window.aurora.settings.get()
    if (!state.ok) {
      window.__auroraLlmStructureProbe = { clicked: false, reason: 'settings.get failed' }
      return window.__auroraLlmStructureProbe
    }
    // 行容器是唯一 data-field 恰好等于"llm.providers.<id>"的元素：
    // 卡内的字段会多一层（llm.providers.<id>.baseUrl），模型列表容器更是 <id>.modelList。
    // 所以拿配置里的 provider id 做白名单比对，而不是靠"后面还有没有点"去猜。
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
 * "AI 模型"页结构探针 · 后半：行列表与配置一致，且**一次只开一张编辑卡**。
 *
 * 三个断言分别钉住重构后的信息架构：
 * ① 每个 provider 恰好一行（行容器的 `data-field` 恰好是 `llm.providers.<id>`，
 *    用配置里的 provider id 做白名单比对 —— 卡内字段与模型列表容器都多一层，不会被算成行）；
 * ② 点开"编辑"之后**恰好一张**可见编辑卡（用卡内必填字段 `.baseUrl` 的可见数量计数）——
 *    恒等 ≤1 会漏掉"一张都没开"这种假通过，所以要求 === 1；
 * ③ `providers` 为空时必须有 `[data-empty="llm.providers"]` 空状态（不再画一排空行）。
 */
export const SETTINGS_LLM_STRUCTURE_CHECK = `(async () => {
  try {
    const state = await window.aurora.settings.get()
    if (!state.ok) return { pass: false, reason: 'settings.get failed' }
    const expected = Object.keys(state.value.llm.providers).length
    const ids = Object.keys(state.value.llm.providers)

    // 行容器 = data-field 恰好是"llm.providers.<id>"（id 取自配置）的元素。
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
 * AI 模型页"接口类型 + 图片输入"探针 · 前半（v22 多模态轮，docs/06 §3.1 / §3.2；step-05 起图片输入搬到模型行内）。
 *
 * 先把当前生效 provider 的 `type` 写成 `openai-responses`、把**当前生效模型**的
 * `modelParams[<模型>].vision` 写成 `true`，再按真实用户路径打开它的编辑卡、卡内"高级参数"
 * 折叠区（只剩接口类型与连接测试）以及**当前使用模型那一行的参数开关** —— 后半只读 DOM 与回读配置。
 *
 * 两条与 `SETTINGS_LLM_EFFORT_ACT` 同款的取舍：
 * - **必须点当前生效 provider 那一行的编辑按钮**：全量截图里 onboarding 会先种一个 local
 *   provider，行首未必是 active 那个，取错行会读到别人的卡（假 FAIL）；
 * - **原值先记进 `window.__auroraMultimodalProbe`**：后半要写回，否则在真实 userData 下跑
 *   （`AURORA_CAPTURE_WINDOWS=settings`）会把用户的协议与开关永久改掉。
 *
 * ⚠️ 本段在模板字符串里，注释里不能出现反引号（用""）。
 */
export const SETTINGS_LLM_MULTIMODAL_ACT = `(async () => {
  try {
    const state = await window.aurora.settings.get()
    if (!state.ok) return { ok: false, reason: 'settings.get failed' }
    const providers = state.value.llm.providers
    const active = state.value.llm.active !== '' ? state.value.llm.active : 'capture'
    const existing = providers[active]
    // v23 起"支持图片输入"按**模型 id** 键（provider 级 temperature / vision 已删除）：
    // 合并后真正生效的模型 id 是 existing.model（缺 provider 时用种子的 deepseek-chat），
    // 写进去的键必须与它对上 —— 否则"当前使用"那一行读的是别的模型的参数，断言必然落空
    //（全量截图里 onboarding 先种的 local provider 用的是别的模型，这条不是理论风险）。
    const modelId = (existing ?? {}).model ?? 'deepseek-chat'
    const table = (existing ?? {}).modelParams ?? {}
    const entry = table[modelId] ?? {}
    window.__auroraMultimodalProbe = {
      active,
      modelId,
      // 缺 provider 时（隔离 userData 起步）按出厂档记录：写回时把这两项恢复成
      // "openai-compat + 关"即可，不必删整条（它与 EFFORT 探针共用同一份配置）。
      beforeType: existing === undefined ? 'openai-compat' : existing.type,
      beforeVision: entry.vision === true,
    }
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
            modelList: [],
            ...(existing ?? {}),
            type: 'openai-responses',
            // 三项一起写全、整份替换该键的对象（别留下半截条目）
            modelParams: {
              ...table,
              [modelId]: {
                ...(table[modelId] ?? { reasoningEffort: 'auto', contextWindow: 0, vision: false }),
                vision: true,
              },
            },
          },
        },
      },
    })
    if (!result.ok) return { ok: false, reason: result.message }
    await new Promise((resolve) => setTimeout(resolve, 600))

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

    // step-05 起"支持图片输入"在**模型行内**（折叠区只剩接口类型）：再点当前使用模型那一行的
    // 参数开关，复选框才会进 DOM。本段在模板字符串里，注释不能出现反引号。
    const currentRow = row.querySelector('.model-row.current')
    if (currentRow === null) {
      return { ok: false, reason: '当前模型行未找到（.model-row.current 不存在）' }
    }
    const paramsToggle = currentRow.querySelector('[data-action="toggle-model-params"]')
    if (paramsToggle === null) return { ok: false, reason: 'no toggle-model-params in current row' }
    paramsToggle.click()
    await new Promise((resolve) => setTimeout(resolve, 300))
    // 拍图前把刚展开的参数块滚进视口：设置窗是**固定高度 + 内部滚动**，不滚的话
    // 这张 PNG 停在页头，人工核对"三个参数控件在模型行内"根本看不到它们。
    const paramsBox = currentRow.querySelector('.model-params')
    if (paramsBox !== null) paramsBox.scrollIntoView({ block: 'center' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
})()`

/**
 * "接口类型 + 图片输入"探针 · 后半：读 DOM 真值 + 回读配置 + 写回原值。
 *
 * 判据刻意同时要两样：
 * - **DOM**：折叠区里 `type` 是 `<select>` 且当前值 `openai-responses`、
 *   **当前使用模型那一行**的图片输入是勾上的复选框 —— 只数元素不够（写死的控件也能数出来）；
 * - **配置回读**：`settings.get()` 里这两项确实是刚写进去的值（图片输入按模型 id 键）。
 *   `restored` 必须为真：本场景会改用户的协议与开关，不写回就是污染。
 */
export const SETTINGS_LLM_MULTIMODAL_CHECK = `(async () => {
  try {
    const probe = window.__auroraMultimodalProbe
    const scope =
      probe === undefined
        ? document
        : document.querySelector('[data-field="llm.providers.' + probe.active + '"]')
    if (scope === null) return { pass: false, reason: 'no row after act' }
    const typeField = scope.querySelector('[data-field$=".type"] select')
    // step-05 起"支持图片输入"在**当前使用模型那一行内**：先限定到 .model-row.current
    //（全局取第一个 .vision 会读到别的模型行的参数），再要它展开块里的复选框。
    const currentRow = scope.querySelector('.model-row.current')
    const visionField = scope.querySelector(
      '.model-row.current [data-field$=".vision"] input[type=checkbox]',
    )
    const typeValue = typeField === null ? null : typeField.value
    const visionChecked = visionField === null ? null : visionField.checked
    const domOk = typeValue === 'openai-responses' && visionChecked === true

    const state = await window.aurora.settings.get()
    if (!state.ok || probe === undefined) return { pass: false, reason: 'settings.get failed' }
    const saved = state.value.llm.providers[probe.active]
    const table = (saved ?? {}).modelParams ?? {}
    const entry = table[probe.modelId] ?? {}
    const savedOk = saved !== undefined && saved.type === 'openai-responses' && entry.vision === true

    const restored = await window.aurora.settings.update({
      llm: {
        active: state.value.llm.active,
        providers: {
          ...state.value.llm.providers,
          [probe.active]: {
            ...saved,
            type: probe.beforeType,
            // 写回时三项一起写全、整份替换该键的对象（reasoningEffort 没有 .default()）
            modelParams: {
              ...table,
              [probe.modelId]: {
                reasoningEffort: entry.reasoningEffort ?? 'auto',
                contextWindow: entry.contextWindow ?? 0,
                vision: probe.beforeVision === true,
              },
            },
          },
        },
      },
    })
    return {
      typeValue,
      visionChecked,
      modelId: probe.modelId,
      // "当前模型行存在"的直接证据（harness 丢掉 ACT 的返回值，只留 check 的）
      currentRow: currentRow !== null,
      savedOk,
      restored: restored.ok === true,
      pass: domOk && savedOk && restored.ok === true,
    }
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

/**
 * "语音"页编辑卡探针 · 前半（step-05）：进"添加"态 → 点"+ 空白配置"让编辑卡出现。
 *
 * ⚠️ 三条硬约束（第一条是首跑实测踩出来的）：
 * - **必须先进入添加态**：`+ 空白配置` 渲染在 `<section v-if="mode === 'add'">` 里，
 *   页面初始是列表态（列表为空时更是只有一张空状态卡），直接找这个按钮必然找不到
 *   （首跑实测 `act: null`、六字段全 0）。所以先点"添加 TTS 模型"/"+ 添加 TTS 模型"
 *   进添加态，再点"+ 空白配置"。
 * - **不得点"应用"**：capture 在真实 userData 下也会被跑（`AURORA_CAPTURE_WINDOWS=settings`），
 *   而"+ 空白配置"只往**本地 `drafts`** 里加一行、保存时才落盘，所以这一步不动配置
 *   （与 `SETTINGS_LLM_MODELS_ACT` 同一取舍）。因此这里**不需要任何恢复动作**。
 * - 定位优先按**按钮文案**：`data-action` 是 TtsPage 的加分项但**没有冻结进 DOM 契约**，
 *   靠它一条路会在页面没写这个属性时变成静默找不到。反过来"+ 空白配置"是 step-05 明确的
 *   用户可见文案，改了文案这条断言本就该失败并报出实际按钮文案（不静默成功）。
 *   匹配时统一去掉首尾空白与"+"前缀，`+ 空白配置` / `空白配置` 两种写法都命中。
 */
/**
 * 设置页"安全区"巡检（`settings-overflow.png`，2026-09-29，docs/07 §5.4）。
 *
 * 用户反馈"文字与组件位置没协调好、许多文字冲出组件"时，此前的几何护栏只覆盖了
 * 自动化页（卡片 / 磁贴内不探出边界）。设置页有 9 个页面、几十个区组，是最可能出现
 * "长标签 + 窄控件"的场合，因此单列一条**横向溢出**巡检（纵向滚动是正常行为，不算）：
 * act 依次点开左侧每一个导航项、量当前页内容区（`main.content`）内**每个元素**的矩形，
 * 把探出内容区左右边界超过 1px 的节点记下来；check 断言所有页面都是 0，
 * 且**页数校验**（少于 7 页说明导航没点全，防止"巡检了个寂寞"仍判 PASS）。
 */
export const SETTINGS_OVERFLOW_ACT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    const items = Array.from(document.querySelectorAll('nav .nav-item'))
    if (items.length === 0) return { pages: 0, reason: 'no nav items' }
    const report = []
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      const label = (item.textContent || '').trim()
      item.click()
      await wait(320)
      const content = document.querySelector('main.content')
      if (content === null) {
        report.push({ label, bad: -1, offenders: ['no main.content'] })
        continue
      }
      const box = content.getBoundingClientRect()
      let bad = 0
      const offenders = []
      const nodes = content.querySelectorAll('*')
      for (let n = 0; n < nodes.length; n += 1) {
        const node = nodes[n]
        const rect = node.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) continue
        // 只查**横向**：纵向溢出就是滚动，属正常
        if (rect.right > box.right + 1 || rect.left < box.left - 1) {
          bad += 1
          if (offenders.length < 3) {
            const name = typeof node.className === 'string' && node.className !== ''
              ? node.className.split(' ')[0]
              : node.tagName
            offenders.push(name + '@' + Math.round(rect.left) + '-' + Math.round(rect.right))
          }
        }
      }
      // 2026-10-04 用户实测：透明原生窗口 + out-in 页面切换偶发停在空过渡态。
      // 逐页把“当前页真的有可见内容”也记下来，避免巡检只查溢出、空白页照样 PASS。
      // 页面根类不保证都叫 page（SessionsPage 用 sessions-page）：取内容区第一个
      // 非拖动带 / 非顶栏提示的直接子节点，才是当前路由页组件根。
      const page = content.querySelector(':scope > :not(.content-drag):not(.banner)')
      const pageRect = page === null ? null : page.getBoundingClientRect()
      const pageOpacity = page === null ? 0 : Number(getComputedStyle(page).opacity)
      const pageVisible =
        pageRect !== null && pageRect.width > 0 && pageRect.height > 0 && pageOpacity >= 0.5
      const textLength = (content.textContent || '').trim().length
      report.push({
        label,
        bad,
        box: Math.round(box.width),
        offenders,
        pageVisible,
        textLength,
        pageOpacity,
        pageHeight: pageRect === null ? 0 : Math.round(pageRect.height),
        pageClass: page === null ? '' : String(page.className),
      })
    }
    window.__auroraSettingsOverflow = report
    return { pages: report.length }
  } catch (error) {
    return { reason: String(error) }
  }
})()`

export const SETTINGS_OVERFLOW_CHECK = `(() => {
  try {
    const report = window.__auroraSettingsOverflow ?? []
    const bad = report.filter((item) => (item.bad ?? 0) !== 0)
    const blank = report.filter(
      (item) => item.pageVisible !== true || Number(item.textLength || 0) < 20,
    )
    return {
      pages: report.length,
      labels: report.map((item) => item.label),
      bad,
      blank,
      pass: report.length >= 9 && bad.length === 0 && blank.length === 0,
    }
  } catch (error) {
    return { reason: String(error), pass: false }
  }
})()`

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
    // 1) 先进入"添加"态："+ 空白配置"只在添加区（空状态里的"添加 TTS 模型"或
    //    工具行的"+ 添加 TTS 模型"点下去之后）才渲染 —— 直接找它会一无所获。
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
    // 2) 再点"+ 空白配置"进编辑卡
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
 * "语音"页编辑卡探针 · 后半（step-05）：六字段的 `data-field` 必须全在。
 *
 * 用**后缀**选择器（`[data-field$=".baseUrl"]`）而不是写死 provider id：
 * 点"+ 空白配置"之后 id 由页面决定（LlmPage 同款流程用的是 `custom`），
 * 探针假设 id 等于把契约里没冻结的东西当成事实。
 *
 * "在"的判定是**可见**（`getBoundingClientRect` 有尺寸），不是只数选择器命中数：
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
      // act 的结论一并回传：失败时能一眼看出是"没进添加态"还是"没找到空白配置"，
      // 不用再改代码重跑一次（首跑就是靠它定位到缓存按钮节点的）。
      act: probe === undefined ? null : probe,
      actResult: window.__auroraTtsActResult === undefined ? null : window.__auroraTtsActResult,
    }
  } catch (error) {
    return { pass: false, reason: String(error) }
  }
})()`

/**
 * "语音"页 STT 编辑卡探针 · 前半（v24 阿里云原生 ASR）：点开 STT 区组的编辑卡。
 *
 * 与 TTS 那条同款，但**必须先锁定 STT 区组容器**再找按钮：两栏同页、且都有"空白配置"，
 * 按文案全页找会点到 TTS 那张卡上去。区组按 `.section-title` 里的"语音输入"识别。
 */
export const SETTINGS_STT_ADD_ACT = `(async () => {
  try {
    // ⚠️ 这里刻意**不用任何带反斜杠的正则**（要匹配空白与行首的加号，改成逐字符判定）：
    // 探针是 template literal 字符串，反斜杠要先被模板层吃掉一层，写错一层就退化成非法正则、
    // 渲染层直接"Script failed to execute"，报告里只剩一句没信息量的话（本轮实测栽在这里）。
    // 注释里也**不要**写反斜杠转义（如"反斜杠 + s"那种写法）：ESLint 的 no-useless-escape
    // 照字符串内容报错，模板串里的注释照样命中（本轮被 lint 抓过一次）。
    const normalize = (text) => {
      const joined = (text || '')
        .split('')
        .filter((ch) => ch.trim() !== '')
        .join('')
      return joined.charAt(0) === '+' ? joined.slice(1) : joined
    }
    const record = (value) => {
      window.__auroraSttActResult = value
      return value
    }
    const section = () =>
      Array.from(document.querySelectorAll('section.group')).find((el) => {
        const title = el.querySelector('.section-title')
        return title !== null && (title.textContent || '').indexOf('语音输入') !== -1
      })
    // 每次都重新查询按钮：进入添加态后是全新节点，缓存下来的数组里不会有它（TTS 那条首跑踩过）
    const allButtons = () =>
      section() === undefined ? [] : Array.from(section().querySelectorAll('button'))
    const blankButton = () => allButtons().find((item) => normalize(item.textContent) === '空白配置')

    let opened = null
    if (blankButton() === undefined) {
      const opener = allButtons().find(
        (item) => normalize(item.textContent) === '添加语音输入模型',
      )
      if (opener === undefined) {
        return record({
          ok: false,
          reason: 'no 添加语音输入模型 opener',
          labels: allButtons()
            .map((item) => (item.textContent || '').trim())
            .filter((item) => item !== ''),
        })
      }
      opener.click()
      opened = normalize(opener.textContent)
      await new Promise((resolve) => setTimeout(resolve, 300))
    }

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
    await new Promise((resolve) => setTimeout(resolve, 500))
    // 把这张卡滚进视野：设置页很长，不滚的话截图里只有上面的 TTS 区组，
    // 探针量的是"控件有尺寸"（折叠线以下也算），截出来的图却没有它 —— 视觉证据就断了。
    const card = section().querySelector('[data-field$=".baseUrl"]')
    if (card !== null) card.scrollIntoView({ block: 'center' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    return record({
      ok: true,
      opened,
      label: normalize(target.textContent),
      editorFields: section().querySelectorAll('[data-field$=".baseUrl"]').length,
    })
  } catch (error) {
    window.__auroraSttActResult = { ok: false, reason: String(error) }
    return window.__auroraSttActResult
  }
})()`

/**
 * "语音"页 STT 编辑卡探针 · 后半（v24）：五个字段在，且"接口协议"真接在草稿上。
 *
 * 只断言"控件在"是不够的：新建一个 provider、把一个下拉摆上去，测试照样绿而功能是坏的。
 * 所以这里跑一条**行为**断言 —— 把协议切到 `dashscope-native`，baseURL 的提示词必须
 * 跟着改写（两套接口的 baseURL 语义不同），切回后必须逐字复原。
 * 本场景只动本地 draft、**不点"应用"**，因此配置一个字都不写。
 */
export const SETTINGS_STT_CARD_CHECK = `(async () => {
  try {
    const section = () =>
      Array.from(document.querySelectorAll('section.group')).find((el) => {
        const title = el.querySelector('.section-title')
        return title !== null && (title.textContent || '').indexOf('语音输入') !== -1
      })
    const visible = (el) => {
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }
    const pick = (suffix) =>
      Array.from(section().querySelectorAll('[data-field$=".' + suffix + '"]')).filter(visible)[0]
    const hintOf = (root) => {
      const hint = root === undefined ? null : root.querySelector('.hint')
      return hint === null ? '' : (hint.textContent || '').trim()
    }

    const fields = ['type', 'baseUrl', 'apiKey', 'model', 'language']
    const found = {}
    for (const name of fields) {
      found[name] = Array.from(
        section().querySelectorAll('[data-field$=".' + name + '"]'),
      ).filter(visible).length
    }
    const missing = fields.filter((name) => found[name] === 0)

    const select = pick('type') === undefined ? null : pick('type').querySelector('select')
    const options =
      select === null
        ? []
        : Array.from(select.options).map((item) => item.value + '|' + (item.textContent || '').trim())

    const hintBefore = hintOf(pick('baseUrl'))
    let hintAfter = ''
    let hintRestored = ''
    if (select !== null) {
      select.value = 'dashscope-native'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 300))
      hintAfter = hintOf(pick('baseUrl'))
      select.value = 'openai-compat'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 300))
      hintRestored = hintOf(pick('baseUrl'))
    }

    return {
      pass:
        missing.length === 0 &&
        options.length === 2 &&
        options.some(
          (item) => item.indexOf('dashscope-native') !== -1 && item.indexOf('阿里云') !== -1,
        ) &&
        options.some((item) => item.indexOf('openai-compat') !== -1) &&
        hintAfter !== '' &&
        hintAfter !== hintBefore &&
        hintAfter.indexOf('阿里云') !== -1 &&
        hintRestored === hintBefore,
      fields: found,
      missing,
      options,
      hintBefore,
      hintAfter,
      hintRestored,
      act: window.__auroraSttActResult === undefined ? null : window.__auroraSttActResult,
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
 * "浅色下先闪一层深色底"的真正防线。
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
 * 颜色归一化走"挂一个临时元素读 computed style"，比手写 hex/rgba 解析稳：令牌值可能是
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

/** 原生玻璃窗口的材质断言（渲染层看不到 DWM 材质，只能从主进程读真实启用态）。 */
export function nativeGlassCheck(
  manager: WindowManager,
  name: WindowName,
): () => { pass: boolean } & Record<string, unknown> {
  return () => {
    const nativeGlass = manager.usesNativeGlass(name)
    return { pass: nativeGlass, window: name, material: 'acrylic', nativeGlass }
  }
}

/**
 * 关闭毛玻璃后的**原生侧**断言（v32）：材质必须真的摘掉了。
 *
 * 为什么必须由主进程断言：`appearance.glass = false` 的渲染层那半（`data-glass="off"` +
 * 令牌降级）在页面里可读，但"Acrylic 卸没卸"只存在于 DWM 与 `WindowManager` 的内部状态里。
 * 与 `nativeGlassCheck` 一起构成一对：**开着时必须挂上、关掉时必须摘掉** —— 只断言一半的话，
 * "开关接线错了但两端都看不出"这类回归会漏过去（例如只改了配置没驱动材质）。
 */
export function nativeGlassGoneCheck(
  manager: WindowManager,
  name: WindowName,
): () => { pass: boolean } & Record<string, unknown> {
  return () => {
    const nativeGlass = manager.usesNativeGlass(name)
    return { pass: !nativeGlass, window: name, material: 'none', nativeGlass }
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
      if (!hit) throw new Error('引导页脚缺少按钮"' + label + '"：' +
        Array.from(document.querySelectorAll('.foot button')).map((el) => (el.textContent || '').trim()).join('、'))
      if (hit.disabled) throw new Error('引导按钮"' + label + '"已禁用')
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
    // 采集环境里窗口可能被遮挡 / 未被合成，此时截图会拍到"布局好了但整块透明"的 pane，
    // 后续 check 也会因为 opacity=0 判 FAIL（实测出现过"期望与实际是同一串标题却 FAIL"的偶发失败）。
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
      // 那时标题的几何与透明度都不满足下面的条件 —— 实测出现过"期望与实际都是同一串标题、
      // 却判 FAIL"的偶发失败（一轮 0 FAIL、下一轮红一条）。断言本身不放宽：
      // 1.5s 内始终不可见照样 FAIL，并报出真实几何（rect / 视口 / 滚动位置 / opacity）。
      let waitedMs = 0
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (visible(document.querySelector('.pane .pane-title'))) break
        await new Promise((resolve) => setTimeout(resolve, 50))
        waitedMs += 50
      }
      // act 已经把进场动画推到终态；这里再兜一次（check 可能被单独调试、或窗口恰好在这一刻失焦），
      // 仍然只处理"动画没跑完"这一种情况 —— 真被样式藏起来的元素 finish() 也救不回来，照样 FAIL。
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
        // 报出真实几何：失败原因里只写"期望 X，实际 X"时两条字符串长得一模一样，根本没法排查
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
      // 安全区（docs/07 §5.4）：当前阶段的 pane 内不允许元素横向探出 pane 边界 ——
      // 引导页五段共用这一个 check，因此五段都被这一条覆盖（此前只断言了主 CTA 的可见性与命中）。
      const paneEl = document.querySelector('.pane')
      let outside = 0
      const overflowNodes = []
      if (paneEl !== null) {
        const box = paneEl.getBoundingClientRect()
        for (const node of paneEl.querySelectorAll('*')) {
          const rect = node.getBoundingClientRect()
          if (rect.width === 0 && rect.height === 0) continue
          if (rect.right > box.right + 1 || rect.left < box.left - 1) {
            outside += 1
            if (overflowNodes.length < 3) {
              overflowNodes.push(String(node.className).split(' ')[0] + '@' + Math.round(rect.left) + '-' + Math.round(rect.right))
            }
          }
        }
      }
      if (outside > 0) {
        reasons.push('内容横向溢出（' + outside + ' 处）：' + overflowNodes.join('、'))
      }
      if (!cta) reasons.push('缺少页脚主 CTA"' + expected.cta + '"')
      else {
        if (!visible(cta)) reasons.push('主 CTA"' + expected.cta + '"超出窗口或不可见')
        if (!clickable) reasons.push('主 CTA"' + expected.cta + '"禁用或中心无法命中')
      }
      return { pass: reasons.length === 0, stage: label, active, title, cta: (cta?.textContent || '').trim(), visible: visible(cta), clickable, overflow: outside, waitedMs, reason: reasons.join('；') || null }
    } catch (error) {
      return { pass: false, reason: '引导阶段检查异常：' + String(error) }
    }
  })()`
}

/**
 * 默认截图清单：四个窗口 + 提示条两态 + 设置页六页深链（含各页门控探针）+ 若干 DOM 断言场景
 * （门控计数 / 左栏与右栏 / 思考块 / 执行轨迹 / 快速会话 / 对话自动滚底 / 收起即消失 / 思考等级 /
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
 * 互斥与几何）→ `chat-tool-card-open`（reload 回 main 后展开工具卡）→ `chat-trace`
 * （2026-09-30 轨迹重构：展开 `AgentTrace`，断言一行摘要 / 竖脊 / 节点几何）→
 * `chat-archive`（左栏归档分组，
 * 自还原）→ `chat-tts`（step 6 加，自带 reload 回到 main 会话）→ `chat-subagent-page`
 * → `chat-classisland-status` → `chat-drag` → `chat-collapse` → `chat.png`。
 * 三个新场景都排在 chat-collapse 之前，且都排在不改配置 / 不用模型的那一段里；
 * `chat-archive` 会改左栏状态（归档再撤销），它自己收尾还原。
 *
 * 双主题（step 6）另在 edge-bar / chat / settings / onboarding 各加一张 `theme-*.png`：
 * 期望档位由 `activeTheme()` 读取（`bootstrap()` 已按 `AURORA_CAPTURE_THEME` 设好 `themeSource`）。
 */
/**
 * 为 chat 窗口的多个场景准备"可朗读 / 可展开思考"的历史（主进程侧，在跑计划之前调用一次）。
 *
 * 为什么必须种数据（而不是让探针去点出来）：
 * 隔离 userData 下 `chat:history` 必然是空的，而 `chat-tts` 需要**一条助手消息**
 * 才会渲染"朗读"按钮、`chat-thinking-block` 需要一条带 `reasoning` 的助手消息
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

  // 1) 会话历史：一条助手消息即可（"MessageList" 只对 assistant 渲染朗读按钮与思考块）
  //    内容里刻意带一个**裸 URL** 与行内代码："markdown.ts" 只把裸 URL 转成 ".md-link"
  //    （不认 "[文字](url)" 语法），而链接色必须用可读的 "--accent-text"
  //    （浅色档直接写品牌蓝只有 3.14:1）—— 这样两处样式都能在 "theme-chat.png" /
  //    "chat.png" 里被逐张目视核对，否则它们在两份报告里没有任何可视证据。
  // 2) "reasoning"（BetaV2）："StoredMessage" / "ChatMessageDto" 的可选字段，经
  //    "rendererHistory" 透传后由 MessageList 渲染成思考折叠块。正文里带探针标记
  //    "capture-reasoning-probe"，"CHAT_THINKING_BLOCK_CHECK" 靠它确认"展开后看到的就是
  //    seed 的思考全文"而不是别的节点文本。
  const session = {
    version: 1,
    sessionId,
    updatedAt: now,
    messages: [
      {
        id: 'capture-tts-a1',
        role: 'assistant',
        content:
          '这是截图探针种下的一条助手回复，用来验证"朗读"按钮的渲染与状态复位。' +
          '参考 https://example.com/aurora 与 `pnpm typecheck` 的说明。' +
          // P1 渲染升级的固定样本（capture-markdown-probe）：表格 / 有序与任务列表 /
          // 提示块与引用 / 删除线与水平线 / 外链 / 带语言围栏代码，CHAT_MARKDOWN_CHECK
          // 逐项断言 DOM 结构。样本追加在末尾，不影响既有探针对该消息的其余判据。
          '\n\n### 渲染样本 capture-markdown-probe\n\n' +
          '1. 有序第一步\n2. 有序第二步\n\n' +
          '| 名称 | 数量 | 备注 |\n| --- | ---: | :---: |\n| 甲 | 12 | 正常 |\n| 乙 | 3 | 待办 |\n\n' +
          '- [ ] 未完成项\n- [x] 已完成项\n\n' +
          '> [!WARNING]\n> 这是一条警示提示块。\n\n' +
          '> 普通引用。\n\n' +
          '~~已废弃~~ 与 [外链](https://example.com/doc)\n\n' +
          '---\n\n' +
          '```ts\nconst answer: number = 42\n```' +
          // P2：公式 + 两类图表 + 一条**故意非法**的 mermaid（降级用例）
          '\n\n行内公式 $a^2 + b^2 = c^2$ 与块级：\n\n' +
          '$$\nE = mc^2\n$$\n\n' +
          '```mermaid\nflowchart LR\n  A[开始] --> B[结束]\n```\n\n' +
          '```echarts\n{"xAxis":{"type":"category","data":["一","二"]},"yAxis":{"type":"value"},"series":[{"type":"bar","data":[3,7]}]}\n```\n\n' +
          '```mermaid\nflowchart LR\n  A[[[ 非法  --> B\n```',
        reasoning:
          'capture-reasoning-probe：这是探针种下的思考过程全文。' +
          '历史水合出的思考块默认收起为"已深度思考"摘要行，点开应能看到本段全文。',
        // 2026-09：一条 todo_write（3 项清单）+ 一条 task（子代理，已完成）——
        // 2026-10-18：再加一条只读 task，子代理页因此同时展示 write / read 两种权限徽章。
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
            // 截图与探针证据：工具卡展开体里的**独立对话视图**，以及"子代理"独立页面的
            // 权限徽章 / 对话展开（2026-09：快照带 permission / tools / messages）。
            subagent: {
              taskId: 'sub-capture-1',
              callId: 'capture-task-1',
              description: '汇总系统状态',
              prompt: '读取当前的系统状态（时间 / 电量 / 网络 / 前台应用），汇总成一段话。',
              status: 'success',
              startedAt: Date.parse(now),
              endedAt: Date.parse(now) + 4200,
              toolCalls: 2,
              permission: 'write',
              tools: ['edit_file', 'list_dir', 'read_file', 'write_file'],
              steps: [
                { id: 's1', kind: 'text', text: '先看系统状态采集项，再各取一次。' },
                {
                  id: 'capture-tool-1',
                  kind: 'tool',
                  name: 'list_dir',
                  state: 'success',
                  summary: '已列出 12 个条目',
                  args: '{"path":"."}',
                },
                {
                  id: 'capture-tool-2',
                  kind: 'tool',
                  name: 'read_file',
                  state: 'success',
                  summary: '已读取 1.2 KB',
                  args: '{"path":"status.json"}',
                },
              ],
              messages: [
                {
                  id: 'capture-sub-u1',
                  role: 'user',
                  text: '读取当前的系统状态（时间 / 电量 / 网络 / 前台应用），汇总成一段话。',
                },
                {
                  id: 'capture-sub-a1',
                  role: 'assistant',
                  text: '先看系统状态采集项，再各取一次。',
                  toolCalls: [
                    {
                      id: 'capture-tool-1',
                      name: 'list_dir',
                      state: 'success',
                      args: '{"path":"."}',
                      summary: '已列出 12 个条目',
                      output: 'status.json\\nschedule.json',
                    },
                    {
                      id: 'capture-tool-2',
                      name: 'read_file',
                      state: 'success',
                      args: '{"path":"status.json"}',
                      summary: '已读取 1.2 KB',
                      output: '{"power":"ac","battery":82,"network":"wifi"}',
                    },
                  ],
                },
                {
                  id: 'capture-sub-a2',
                  role: 'assistant',
                  text:
                    '当前时间 09:20，已接通电源（82%，非充电）；网络在线（Wi-Fi）；' +
                    '前台应用为 Code.exe。整体状态正常，未发现需要处理的事项。',
                },
              ],
              report:
                '当前时间 09:20，已接通电源（82%，非充电）；网络在线（Wi-Fi）；' +
                '前台应用为 Code.exe。整体状态正常，未发现需要处理的事项。',
            },
          },
          // 2026-10-18：第二条 task（只读）—— 同轮多子代理的列表 / 双权限徽章证据。
          // 与上面那条 write 运行并排出现在「子代理」页（探针断言 runs=2、一条可读写一条只读）。
          {
            id: 'capture-task-2',
            name: 'task',
            input: {
              description: '核对课程表',
              prompt: '读取今天的课程安排，核对是否有课并给出结论。',
            },
            state: 'success',
            outputSummary: '子代理：核对课程表',
            subagent: {
              taskId: 'sub-capture-2',
              callId: 'capture-task-2',
              description: '核对课程表',
              prompt: '读取今天的课程安排，核对是否有课并给出结论。',
              status: 'success',
              startedAt: Date.parse(now) + 5_000,
              endedAt: Date.parse(now) + 6_500,
              toolCalls: 1,
              permission: 'read',
              tools: ['grep', 'read_file'],
              steps: [
                { id: 's1', kind: 'text', text: '先读课表再核对。' },
                {
                  id: 'capture-tool-3',
                  kind: 'tool',
                  name: 'read_file',
                  state: 'success',
                  summary: '已读取 0.4 KB',
                  args: '{"path":"schedule.json"}',
                },
              ],
              messages: [
                {
                  id: 'capture-sub2-u1',
                  role: 'user',
                  text: '读取今天的课程安排，核对是否有课并给出结论。',
                },
                {
                  id: 'capture-sub2-a1',
                  role: 'assistant',
                  text: '先读课表再核对。',
                  toolCalls: [
                    {
                      id: 'capture-tool-3',
                      name: 'read_file',
                      state: 'success',
                      args: '{"path":"schedule.json"}',
                      summary: '已读取 0.4 KB',
                      output: '{"lessons":[{"subject":"数学","start":"00:15"}]}',
                    },
                  ],
                },
                {
                  id: 'capture-sub2-a2',
                  role: 'assistant',
                  text: '今天两节课：数学 00:15、语文 01:00；无冲突。',
                },
              ],
              report: '今天两节课：数学 00:15、语文 01:00；无冲突。',
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

  // 快速会话（BetaV2）：主界面左栏"快速对话"读取 "quick.json"。
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
  //    （"meta.archived = true"），让左栏"已归档 · N"分组在隔离 userData 里就有内容 ——
  //    "chat-archive.png" 场景点开分组要看到它，且它**不得**出现在主列表容器
  //    "chat.session-list" 里（渲染层按 "archived === true" 分两份，storage 层不过滤）。
  //    标题取首条用户消息前 24 字（"SessionStore.titleFor"）：这里把标记写在开头，
  //    且整段文本恰好 23 字（不触发省略号），探针按唯一的子串 "archive-seed" 定位它。
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

  // 4) 绑定项目的会话（2026-09-30 项目分组折叠探针用）："meta.projectId" 指向探针
  //    随后登记的那个项目 id（'capture'，见 settingsProjectAct）。出厂现场该项目还不存在，
  //    因此这条会话**先是孤儿绑定**（展示层归 Agent对话区，见 App.vue 的 knownProjectIds），
  //    等 chat-session-groups 场景登记项目后才移进"项目对话"子分组 —— 探针在那一刻
  //    折叠它、断言列表收成 0 高再展开，折叠能力才有真实对象可测。
  const projectSeedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
  const projectSeed = {
    version: 2,
    sessionId: 'chat-seed-project',
    updatedAt: projectSeedAt,
    messages: [
      {
        id: 'capture-project-u1',
        role: 'user',
        content: 'project-seed 绑定项目的会话',
        createdAt: projectSeedAt,
      },
      {
        id: 'capture-project-a1',
        role: 'assistant',
        content: '这条会话绑定到 capture 项目，用来验证项目分组的折叠与展开。',
        createdAt: projectSeedAt,
      },
    ],
    meta: { projectId: 'capture' },
  }
  await writeFile(
    join(userData, 'sessions', 'chat-seed-project.json'),
    JSON.stringify(projectSeed, null, 2),
    'utf8',
  )

  // 5) 对话图片区（2026-10-04）：真实 PNG + 一条带 displayImages 的助手工具卡。
  //    图片读取走 chat:readDisplayImage，不把路径送进渲染层。
  const imageRoot = captureProjectRoot(userData)
  await mkdir(imageRoot, { recursive: true })
  const imagePath = join(imageRoot, 'display-image-proof.png')
  await writeFile(
    imagePath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  )
  const imageSeedAt = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString()
  const imageSeed = {
    version: 7,
    sessionId: 'chat-seed-images',
    updatedAt: imageSeedAt,
    messages: [
      {
        id: 'capture-image-u1',
        role: 'user',
        content: '展示一下生成结果',
        createdAt: imageSeedAt,
        requestId: 'capture-image-request',
      },
      {
        id: 'capture-image-a1',
        role: 'assistant',
        content: '我来生成一张教学图，完成后核对内容。',
        createdAt: imageSeedAt,
        requestId: 'capture-image-request',
        toolCalls: [
          {
            id: 'capture-image-t1',
            name: 'show_image',
            arguments: JSON.stringify({ path: imagePath, caption: '最终效果' }),
            state: 'success',
            outputSummary: '已展示图片',
            displayImages: [
              {
                id: 'capture-display-image-1',
                path: imagePath,
                name: 'display-image-proof.png',
                mime: 'image/png',
                caption: '最终效果',
              },
            ],
          },
        ],
      },
      {
        id: 'capture-image-a2',
        role: 'assistant',
        content: '图已生成，内容与标题、方程式和装置标注均已核对。',
        createdAt: new Date(Date.parse(imageSeedAt) + 1_000).toISOString(),
        requestId: 'capture-image-request',
      },
    ],
    meta: { projectId: 'capture' },
  }
  await writeFile(
    join(userData, 'sessions', 'chat-seed-images.json'),
    JSON.stringify(imageSeed, null, 2),
    'utf8',
  )
}

export function defaultCapturePlan(manager: WindowManager, userData: string): CaptureTarget[] {
  const theme = activeTheme()
  const plan: CaptureTarget[] = [
    { name: 'edge-bar', file: 'edge-bar.png' },
    // 双主题（step-06）：每窗一张主题场景，断言令牌档位、正文背景与原生底色一致。
    // 提示条整窗透明，所以只断言渲染层（"body" 背景 alpha 必须为 0）+ 不挂原生底色断言。
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
      // 2026-10-11：提示条改回原生 Acrylic —— 面板 tint 的半透明只是「材质有没有被盖死」的
      // DOM 证据，材质本身只有主进程知道（`usesNativeGlass`），所以两端各断言一次。
      nativeCheck: nativeGlassCheck(manager, 'edge-bar'),
      // 展开要等主进程 shape 与渲染层面板挂载走完（跨进程异步，rAF 等不到它）
      settleMs: 700,
    },
    {
      // 插件小组件（docs/14 §5.4）：展开面板底部的声明式条目；列表与 widgetData 都是异步拉取
      name: 'edge-bar',
      file: 'edge-bar-plugin-widget.png',
      act: EDGE_BAR_PLUGIN_WIDGET_ACT,
      check: EDGE_BAR_PLUGIN_WIDGET_SCRIPT,
      settleMs: 1200,
    },
    {
      name: 'edge-bar',
      file: 'edge-bar-animation.png',
      prepare: () => {
        manager.hide('chat')
      },
      act: EDGE_BAR_ANIMATION_ACT,
      check: EDGE_BAR_ANIMATION_CHECK,
    },
    {
      name: 'edge-bar',
      file: 'edge-bar-touch.png',
      prepare: () => {
        manager.hide('chat')
      },
      act: EDGE_BAR_TOUCH_ACT,
      check: EDGE_BAR_TOUCH_CHECK,
    },
    {
      name: 'edge-bar',
      file: 'edge-bar-suggestions.png',
      prepare: () => {
        const now = new Date().toISOString()
        manager.sendTo('edge-bar', IPC.awareness.suggestion, {
          id: 'capture-suggestion-1',
          noteId: 'memory-capture-pptx',
          sourcePath: 'D:\\感知\\电路课程.pptx',
          sourceHash: 'memory-capture-hash',
          headline: '电路笔记可补充公式并整理成复习卡',
          body: '建议把欧姆定律、串联与并联电路、电压电流关系和常见题型整理成复习卡，再补一份自测题。',
          createdAt: now,
          confidence: 0.9,
          action: { label: '整理', prompt: '请整理电路课程笔记。' },
        })
        manager.sendTo('edge-bar', IPC.awareness.suggestion, {
          id: 'capture-suggestion-2',
          noteId: 'memory-capture-docx',
          sourcePath: 'D:\\感知\\数学复习.docx',
          sourceHash: 'memory-capture-docx-hash',
          headline: '数学复习可生成练习',
          body: '补充二次函数例题。',
          createdAt: now,
          confidence: 0.85,
        })
      },
      act: EDGE_BAR_HOVER_SCRIPT,
      check: EDGE_BAR_SUGGESTIONS_CHECK,
      settleMs: 700,
    },
    {
      name: 'edge-bar',
      file: 'edge-bar-work.png',
      act: EDGE_BAR_WORK_ACT,
      check: EDGE_BAR_WORK_CHECK,
      settleMs: 700,
    },
    // 交互窗的场景顺序见函数头注释：能在窗口里操作 DOM 的都排在 chat-collapse 之前。
    // 这些场景都沿用 "name: 'chat'"（"CaptureTarget.name" 的类型是 "WindowName"，且 "report.json"
    // 的 checks 是**数组**、靠 "file" 区分），所以靠文件名与 "AURORA_CAPTURE_WINDOWS=chat" 过滤。
    // "收起即消失"**不设 act**：点击放在 check 里（原因见 "CHAT_COLLAPSE_CHECK" 的注释——
    // 窗口先被 hide 掉会让紧接着的 capturePage 永不返回，整轮截图卡死）。
    {
      name: 'chat',
      file: 'theme-chat.png',
      check: themeProbeScript({ theme, transparent: true }),
      nativeCheck: nativeGlassCheck(manager, 'chat'),
    },
    // 左栏结构 + 出厂门控现场（BetaV2）：quick-item / session-list / new-session 锚点、
    // 右栏默认展开且 classroom 卡在、麦克风按钮**不存在**（stt 未配置时连按钮都不渲染）。
    // 必须排在一会改配置/改会话的场景之前，保证读到的是隔离 userData 的默认状态。
    {
      name: 'chat',
      file: 'chat-sidebar.png',
      // 自带前置（2026-10-10）：先自己确保 classroom 生效再截图 / 判据 ——
      // 不再依赖前面 "edge-bar-work" 场景的跨窗口还原广播是否已经渲染到本窗口。
      act: CHAT_SIDEBAR_ENSURE_CLASSROOM_ACT,
      check: CHAT_SIDEBAR_SCRIPT,
    },
    // 主界面点击成本盘点（2026-09-29）：只量尺寸、不改状态，紧跟 chat-sidebar 读同一份出厂现场
    {
      name: 'chat',
      file: 'chat-hit-targets.png',
      check: CHAT_HIT_TARGETS_CHECK,
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
    // 会话三分（2026-09-30，docs/07 §2.3）：三区结构 + 项目/Work 门控 + 组头新建入口；
    // act 登记"截图项目"并切 work，check 断言后还原（classroom + 无项目）。
    {
      name: 'chat',
      file: 'chat-session-groups.png',
      act: CHAT_SESSION_GROUPS_ACT,
      check: CHAT_SESSION_GROUPS_CHECK,
    },
    // "文件备份"卡移出主界面（2026-09，回滚 UI 迁设置页 Agent 页）：
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
    // 右栏"任务"面板（v15，docs/06 §4.1）：
    // 现场由 runCapture 在跑计划前种好（seedJobFixture，**必须早于面板首读** —— job 存储
    // 首读即缓存，读到空表后再写文件面板是看不见的）；act 什么都不点（点"继续"会真的
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
    // 右栏功能 tab（2026-10-03，docs/07 §2.3）：文件预览的越界拒绝现场（截图停在 files）
    // + 终端 xterm 初始化 + tab 互斥与跨 tab 往返存活。越界判定在 stat 之前，离线可跑、
    // 不碰任何用户目录；成功路径由 file-preview.test.ts 覆盖。
    {
      name: 'chat',
      file: 'chat-right-tabs.png',
      prepare: async () => {
        await manager.reload('chat', {})
      },
      act: CHAT_RIGHT_TABS_ACT,
      check: CHAT_RIGHT_TABS_CHECK,
    },
    // 右栏多标签（2026-10-03 二次修订，docs/07 §2.3）：**不 reload** —— 走真实 UI 用
    // "＋"菜单开出第二个浏览器标签、展开"＋N"菜单（截图停在这里），check 再验证
    // 折叠计数、菜单不碰三键、滑动窗口、关闭回落、两个终端是不同 PTY，收尾回初始四标签。
    {
      name: 'chat',
      file: 'chat-ctx-tabs.png',
      act: CHAT_CTX_TABS_ACT,
      check: CHAT_CTX_TABS_CHECK,
    },
    // 终端 tab 的视觉证据（2026-10-03）：黑底 + xterm 在。**不 reload** —— 复用上一个
    // 场景初始化好的常驻 shell，截图里带着提示符；单独跑本场景也不会 FAIL（见 CHECK 注释）。
    {
      name: 'chat',
      file: 'chat-terminal.png',
      act: CHAT_TERMINAL_ACT,
      check: CHAT_TERMINAL_CHECK,
    }, // 文件 tab ＝ 会话项目文件夹（2026-10-03，docs/07 §2.3）：prepare 在项目根建出目录与
    // 一份 markdown；act 登记项目 + 切到绑项目的种子会话 + 打开文件 tab；check 断言
    // 根标签"项目：截图项目"、目录在前、逐层进出（含后退/前进历史）、点文件预览、
    // 返回列表，**外加一条布局护栏**：预览带长行的宽内容时右栏不许横向撑破
    // （2026-10-03 用户实测：撑破后工具条按钮被推出可视区，看着像"完全没有按钮"）。
    // 收尾切回原会话并撤销项目登记（后续场景读到的仍是出厂门控）。
    {
      name: 'chat',
      file: 'chat-file-project.png',
      prepare: async () => {
        const root = captureProjectRoot(userData)
        await mkdir(join(root, 'assets'), { recursive: true })
        await writeFile(join(root, '报告.md'), '# 项目报告\n\n文件面板应该看到这份文件。\n', 'utf8')
        // 宽内容夹具：长 URL + 长标识符 + 长代码行 —— 三样都是"不许撑破右栏"的现场
        await writeFile(
          join(root, '宽内容.md'),
          [
            '# 宽内容夹具',
            '',
            '长 URL：https://example.com/' + 'very-long-path-segment-'.repeat(6) + 'end',
            '',
            '长标识符：' + 'unbreakable_token_'.repeat(10),
            '',
            '代码块：',
            '',
            '```js',
            'const long = "' + 'x'.repeat(160) + '"',
            '```',
            '',
            '结尾一段，用来确认正文仍然正常渲染。',
          ].join('\n') + '\n',
          'utf8',
        )
        await manager.reload('chat', {})
      },
      act: chatFileProjectAct(captureProjectRoot(userData)),
      check: CHAT_FILE_PROJECT_CHECK,
    },
    // "show_preview" 推送链路的渲染层半边（2026-10-03，docs/06 §14）：act 与上一条同款
    // （切到绑项目的会话），mainAct 合成一条 "preview:show"（通道与 payload 形状与工具
    // 实际推送一致），check 断言右栏自动切到"浏览器"tab、webview 真的加载了 file:// 夹具、
    // 地址栏显示原始路径。主进程侧的目标校验由 preview-port.test.ts 覆盖。
    {
      name: 'chat',
      file: 'chat-preview-tool.png',
      prepare: async () => {
        const root = captureProjectRoot(userData)
        await mkdir(join(root, 'assets'), { recursive: true })
        await writeFile(
          join(root, 'assets', 'fixture.html'),
          [
            '<!doctype html><meta charset="utf-8"><h1>项目夹具页</h1>',
            // 站点"另开一个标签页"的现场：target=_blank 的 http(s) 链接
            // （右栏必须**新开**一个浏览器标签加载它，当前页原地不动）
            '<a id="probe-blank" href="https://example.com/probe-blank" target="_blank">另开标签</a>',
          ].join('\n'),
          'utf8',
        )
        await manager.reload('chat', {})
      },
      act: chatFileProjectAct(captureProjectRoot(userData)),
      mainAct: async (win) => {
        const fixture = join(captureProjectRoot(userData), 'assets', 'fixture.html')
        win.webContents.send(IPC.preview.show, {
          sessionId: 'chat-seed-project',
          url: pathToFileURL(fixture).toString(),
          display: fixture,
          title: '项目夹具页',
        })
        // 站点自开标签：用 CDP 在夹具页里**真点**那个 target="_blank" 链接
        // （合成 click 没有用户手势，会被 Chromium 的弹窗拦截丢掉）
        const blankClick = await clickFixtureBlankLink(win)
        return { pass: blankClick.ok, sent: fixture, blankClick }
      },
      check: CHAT_PREVIEW_TOOL_CHECK,
    },
    // Agent 内置浏览器（v35，docs/06 §27）：真实驱动 + 渲染层可见性。
    // mainAct 由 index.ts 注册的 runner 完成 open → snapshot → 输入 → 点击 → 读结果 → 截图；
    // check 只看渲染层事实（Agent 标签激活、徽章、停止按钮尺寸、webview 落到夹具页）。
    {
      name: 'chat',
      file: 'chat-browser-agent.png',
      prepare: async () => {
        // 清掉上一场景可能留下的 Agent 标签/会话（reload 会销毁 webview，这里再兜一层）
        await manager.reload('chat', {})
      },
      mainAct: async () => {
        const run = browserAgentCaptureRunner
        if (run === undefined) {
          return { pass: false, reason: '浏览器自测执行器未注册' }
        }
        let outcome: BrowserAgentCaptureOutcome
        try {
          outcome = await run()
        } catch (error) {
          // 失败时立刻收尾，别把半开的会话留给下一个场景
          browserAgentCaptureCleanup?.()
          return { pass: false, reason: error instanceof Error ? error.message : String(error) }
        }
        if (!outcome.ok) browserAgentCaptureCleanup?.()
        return { pass: outcome.ok, ...outcome.detail, reason: outcome.reason ?? '' }
      },
      check: CHAT_BROWSER_AGENT_CHECK,
      nativeCheck: () => {
        // 收尾：结束会话（标签保留），并断言清理器确实注册了 —— 未注册时不能静默通过
        const registered = browserAgentCaptureCleanup !== undefined
        browserAgentCaptureCleanup?.()
        return { pass: registered }
      },
    },
    // 对话图片区（2026-10-04）：夹具会话带 show_image 工具卡，图片从主进程按 id 读取。
    // 同时核对 HarmonyOS Sans 已应用到消息区、mono 令牌未被替换。
    {
      name: 'chat',
      file: 'chat-display-images.png',
      prepare: async () => {
        await manager.reload('chat', {})
      },
      act: `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const button = Array.from(document.querySelectorAll('.nav-item')).find((item) =>
            (item.textContent || '').includes('展示一下生成结果'),
          )
          if (button && !button.classList.contains('active')) button.click()
          const image = document.querySelector('[data-field="chat.display-images"] img')
          const figure = document.querySelector('[data-field="chat.display-images"] figure')
          if (image || figure) {
            if (image) image.scrollIntoView({ block: 'center' })
            else figure.scrollIntoView({ block: 'center' })
            return { ok: true }
          }
          await wait(150)
        }
        return { ok: false, reason: '会话中没有出现图片区' }
      })()`,
      check: `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        let reading = null
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const image = document.querySelector('[data-field="chat.display-images"] img')
          const figure = document.querySelector('[data-field="chat.display-images"] figure')
          const fallback = document.querySelector(
            '[data-field="chat.display-images"] .display-image-fallback',
          )
          const trace = document.querySelector('.message.r-assistant .trace')
          const finalMd = Array.from(
            document.querySelectorAll('.message.r-assistant .bubble > .md'),
          ).find((node) => (node.textContent || '').includes('图已生成'))
          const work = trace === null ? null : trace.querySelector('.work-message')
          const traceBody = trace === null ? null : trace.querySelector('.trace-body')
          const root = getComputedStyle(document.documentElement)
          reading = {
            count: document.querySelectorAll('[data-field="chat.display-images"] figure').length,
            imageCount: document.querySelectorAll('[data-field="chat.display-images"] img').length,
            complete: image !== null && image.complete,
            naturalWidth: image === null ? 0 : image.naturalWidth,
            caption: figure === null ? '' : (figure.querySelector('figcaption')?.textContent || '').trim(),
            assistantCount: document.querySelectorAll('.message.r-assistant').length,
            traceCount: document.querySelectorAll('.message.r-assistant .trace').length,
            traceCollapsed:
              trace !== null &&
              !trace.classList.contains('open') &&
              traceBody !== null &&
              Math.round(traceBody.getBoundingClientRect().height) === 0,
            workDetail:
              work !== null && (work.textContent || '').includes('我来生成一张教学图'),
            finalBeforeImage:
              finalMd !== null &&
              image !== null &&
              finalMd.getBoundingClientRect().top <= image.getBoundingClientRect().top,
            traceBeforeFinal:
              trace !== null &&
              finalMd !== null &&
              trace.getBoundingClientRect().top <= finalMd.getBoundingClientRect().top,
            summary: trace === null ? '' : (trace.querySelector('.trace-summary')?.textContent || '').trim(),
            duration: trace === null ? '' : (trace.querySelector('.trace-duration')?.textContent || '').trim(),
            leakedPath:
              (document.body.textContent || '').includes('capture-project') &&
              (document.body.textContent || '').includes('display-image-proof.png'),
            error: fallback === null ? '' : fallback.getAttribute('data-error') || '',
            bodyFont: getComputedStyle(document.body).fontFamily,
            monoFont: root.getPropertyValue('--font-mono').trim(),
          }
          if (reading.naturalWidth > 0) break
          await wait(200)
        }
        const conditions = {
          count: reading !== null && reading.count === 1,
          decoded: reading !== null && reading.complete && reading.naturalWidth > 0,
          caption: reading !== null && reading.caption === '最终效果',
          singleAssistant: reading !== null && reading.assistantCount === 1,
          singleTrace: reading !== null && reading.traceCount === 1,
          collapsed: reading !== null && reading.traceCollapsed === true,
          workDetail: reading !== null && reading.workDetail === true,
          order: reading !== null && reading.traceBeforeFinal && reading.finalBeforeImage,
          stepSummary: reading !== null && reading.summary.includes('1 步'),
          totalDuration: reading !== null && reading.duration.includes('总用时'),
          noPathLeak: reading !== null && reading.leakedPath === false,
          harmonyFont: reading !== null && reading.bodyFont.includes('HarmonyOS Sans'),
          monoPreserved:
            reading !== null &&
            (reading.monoFont.includes('Cascadia') || reading.monoFont.includes('monospace')),
        }
        return {
          pass: Object.values(conditions).every(Boolean),
          conditions,
          reading,
          reason: '',
        }
      })()`,
    },
    // 综合概览（step 5）：右栏挂"任务"面板 + 上下文卡，用于人工核对布局。
    // "当前项目"卡已随项目管理迁设置页（2026-09-30）：这里改为断言右栏**不再有**项目卡
    // （"context.project-card" / "context.session-project-card" 恒为 0，回归护栏）。
    // 现场要现种一份 paused job，然后 reload 让面板水合；项目根仍建出来是因为
    // verify 的 AGENTS.md 假设依赖它存在。
    {
      name: 'chat',
      file: 'chat-agent-prod-overview.png',
      prepare: async () => {
        await mkdir(captureProjectRoot(userData), { recursive: true })
        await seedJobFixture(userData)
        await manager.reload('chat', {})
      },
      check: CHAT_OVERVIEW_CHECK,
    },
    // 思考过程折叠块（BetaV2）：seed 会话的助手消息带 "reasoning"，历史水合后默认收起；
    // act 点开展开态拍进截图，check 断言"曾收起 + 现已展开 + 全文可见 + 块在正文上方"。
    {
      name: 'chat',
      file: 'chat-thinking-block.png',
      // 现场由 "runCapture" 在跑计划前种好（见 "seedChatTtsHistory"）；这里 reload 一次
      // 让渲染层重新水合 main 会话 —— 本场景没有 "query"，"captureWindows" 不会替我们 reload。
      prepare: async () => {
        await manager.reload('chat', {})
      },
      act: CHAT_THINKING_BLOCK_ACT,
      check: CHAT_THINKING_BLOCK_CHECK,
    },
    // Markdown P1 渲染（2026-10-02）：固定样本（seedChatTtsHistory 的 capture-markdown-probe
    // 段）在真实 DOM 上的结构核对 —— 表格 / 列表 / 提示块 / 链接属性 / 高亮 / 复制按钮。
    // 无需 act 与 prepare：样本随历史水合进入消息区，前面 chat-thinking-block 已 reload 过。
    {
      name: 'chat',
      file: 'chat-markdown-render.png',
      // 消息区先滚到样本并等图表水合终态（截图取证），CHECK 再逐项断言 DOM 结构
      act: CHAT_MARKDOWN_ACT,
      check: CHAT_MARKDOWN_CHECK,
      prepare: async () => {
        await manager.reload('chat', {})
        await new Promise((resolve) => setTimeout(resolve, 300))
      },
    },
    // 快速会话（BetaV2）：点左栏固定项切到 sessionId='quick'，主区标题变"快速对话"。
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
    // 工具行几何护栏（2026-10-11）：把左栏拖到夹取上限 → 主区压到下限 420px 的现场，
    // 量五枚控件的矩形。必须排在 chat-collapse 之前（窗口一被 hide，DOM 操作就没了）。
    {
      name: 'chat',
      file: 'chat-composer-narrow.png',
      act: CHAT_COMPOSER_NARROW_ACT,
      check: CHAT_COMPOSER_NARROW_CHECK,
    },
    // 左栏会话行几何护栏（2026-10-18 用户实测「左栏拖到 200px 后文字重叠」）：act 把左栏
    // 拖到夹取下限 200（行内容宽 ~118px）并停在这个现场截图；check 量「标题不归零 /
    // 相对时间不出 item、不压归档钮」，再用临时注入的模型徽标做 200 / 240 两点压测。
    // 必须排在 chat-collapse 之前（窗口一被 hide，DOM 操作就没了）。
    {
      name: 'chat',
      file: 'chat-nav-narrow.png',
      act: CHAT_NAV_NARROW_ACT,
      check: CHAT_NAV_NARROW_CHECK,
    },
    // 粘贴图片（2026-10-18）：主进程侧真实剪贴板 + webContents.paste()，验证
    // paste → chat:stageImage 落盘 → 卡内缩略图 → 移除 的整条链。
    {
      name: 'chat',
      file: 'chat-composer-paste.png',
      mainAct: chatComposerPasteMainAct,
      check: CHAT_COMPOSER_PASTE_CHECK,
    },
    // 只读档现场（v13，docs/06 §11.2）：切到 readonly + 展开下拉，断言文案与配置一致后还原。
    // 必须排在 chat-collapse 之前（窗口一被 hide，后面的 DOM 操作就没了）。
    {
      name: 'chat',
      file: 'chat-permission-readonly.png',
      act: CHAT_PERMISSION_READONLY_ACT,
      check: CHAT_PERMISSION_READONLY_CHECK,
    },
    // 输入区三个浮层（2026-09-26 修复）：统一锚在 ".composer-box" 上、共用 "--z-flyout"、互斥打开。
    // act 走"输入 / → 点权限钮"，check 对两个时刻 + 实时复测 + 上下文详解卡共四个时刻做几何断言
    //（最多一个可见 / 不与 ".composer-bar" 相交 / 整个矩形在输入卡上方 / 发送键中心命中的是它自己）。
    // 必须排在 chat-collapse 之前（窗口一被 hide，后面的 DOM 操作就没了）。
    {
      name: 'chat',
      file: 'chat-composer-flyouts.png',
      act: CHAT_COMPOSER_FLYOUTS_ACT,
      check: CHAT_COMPOSER_FLYOUTS_CHECK,
    },
    // 工具卡展开的"实测高度"终点（2026-09-26 修复）："--collapse-h" 必须是内联 px 且等于 scrollHeight。
    // 需要 main 会话里的 seed 工具卡（todo_write / task），而前面的 "chat-quick-session" 停在 quick 会话
    //（quick 没有工具卡），所以这里像 "chat-tts" 那样 reload 一次回到 main。
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
    // 执行轨迹（2026-09-30 轨迹视觉重构）：折叠态"一行摘要（1px 上下描边、无盒子）"
    // → 点开 → 展开态"左缘连续竖脊 + 节点圆点"。act 只点 DOM（**不写配置**），
    // check 断言上面那两组几何 / 结构（见两条探针的注释）。
    // 与 "chat-tool-card-open" 同为"main 会话 + reload 后默认折叠"的现场，
    // 放在它后面不必再 reload 一次（这条消息的轨迹在每个场景开头都是折叠的）。
    {
      name: 'chat',
      file: 'chat-trace.png',
      act: CHAT_TRACE_ACT,
      check: CHAT_TRACE_CHECK,
    },
    // 左栏归档分组（2026-09 新增）：act 展开分组拍图，check 在做完"真实 UI 归档 → 撤销归档"
    // 的往返后收尾（收起分组、清残留），不留被改过的左栏给后续场景。
    {
      name: 'chat',
      file: 'chat-archive.png',
      act: CHAT_ARCHIVE_ACT,
      check: CHAT_ARCHIVE_CHECK,
    },
    // 朗读按钮（step-06）：act 点一次 [data-action="speak-message"]（离线合成必然失败，
    // 只触发点击、不断言出声），check 断言按钮存在且点击后回到"朗读"态；
    // "没有可用助手消息"时退化成只断言按钮存在性，判据写在返回值的 criterion 里。
    // 同样排在 chat-collapse 之前（窗口一被 hide，紧接着的 capturePage 会永不返回）。
    {
      name: 'chat',
      file: 'chat-tts.png',
      // 现场由 "runCapture" 在跑计划前种好（见 "seedChatTtsHistory"）；这里只需要
      // reload 一次让渲染层重新水合 —— 本场景没有 "query"，"captureWindows" 不会替我们 reload。
      prepare: async () => {
        await manager.reload('chat', {})
      },
      act: CHAT_TTS_SPEAK_ACT,
      check: CHAT_TTS_SPEAK_CHECK,
    },
    // 自动滚底四条：语义（谁能改跟随状态）+ 持续跟进（每帧都到底）+ **底部上滚**（2026-10-01，
    // 真实用户从底部滚起来时不能被那帧对齐抹回底部 —— 用户实测"答完翻不动历史"）+
    // **真实滚轮**（2026-10-01，CDP "Input.dispatchMouseEvent" 走原生管线：合成事件测不到
    // "对齐帧 / 吸底补齐把用户滚出去的视口吸回去"这类失效，见 docs/07 §5.3"真实滚轮跟随"）。
    // 必须排在 `chat-subagent-page` / `chat-automation` 之前（它们会把主区切到别的 view，
    // `.thread` 整个不渲染），也必须排在 `chat-collapse` / `chat-drag` 之前（窗口一 hide 就没了）。
    { name: 'chat', file: 'chat.png', check: CHAT_AUTO_SCROLL_SCRIPT },
    { name: 'chat', file: 'chat-follow-burst.png', check: CHAT_FOLLOW_BURST_SCRIPT },
    { name: 'chat', file: 'chat-follow-wheel-up.png', check: CHAT_FOLLOW_WHEEL_UP_SCRIPT },
    {
      name: 'chat',
      file: 'chat-trace-wheel.png',
      act: CHAT_TRACE_WHEEL_ACT,
      mainAct: chatTraceWheelMainAct,
      check: CHAT_TRACE_WHEEL_CHECK,
    },
    {
      name: 'chat',
      file: 'chat-subagent-page.png',
      act: CHAT_SUBAGENT_OPEN_ACT,
      check: CHAT_SUBAGENT_OPEN_CHECK,
    },
    // Agent 提问卡片（"ask_user"，docs/06 §21）：由 index.ts 注册的 spawner 发起一次真实提问，
    // act 选中第二个选项 → 截图 → check 点"回答"并断言卡片收起 → nativeCheck 断言回执内容。
    {
      name: 'chat',
      file: 'chat-ask-user.png',
      prepare: async () => {
        const spawn = askUserSpawner
        if (spawn === null) return
        // 刻意**不 await**：这一轮提问要等界面上的回答，await 会把整个 capture 卡住
        void spawn().then((answer) => {
          askUserCaptureAnswer = answer
        })
        await new Promise((resolve) => setTimeout(resolve, 300))
      },
      act: CHAT_ASK_USER_ACT,
      check: CHAT_ASK_USER_CHECK,
      nativeCheck: () => ({
        // 回执必须是"被选中的第二个选项"，且不是超时 / 跳过
        answered: askUserCaptureAnswer?.answers[0] ?? '',
        pass:
          askUserCaptureAnswer !== undefined &&
          askUserCaptureAnswer.answers[0] === ASK_USER_CAPTURE_SECOND &&
          askUserCaptureAnswer.timedOut !== true &&
          askUserCaptureAnswer.skipped !== true,
      }),
    },
    // 自动化页与详情窗口（docs/13 §11）：进入页面 → Normal tab（内置区）→
    // automation 窗口编辑器 → automation 窗口历史 + Agent 回放。数据来自 seedAutomationFixture。
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
      name: 'automation',
      file: 'automation-editor.png',
      act: CHAT_AUTOMATION_EDITOR_ACT,
      check: CHAT_AUTOMATION_EDITOR_CHECK,
    },
    {
      name: 'automation',
      file: 'automation-history.png',
      act: CHAT_AUTOMATION_HISTORY_ACT,
      check: CHAT_AUTOMATION_HISTORY_CHECK,
      mainAct: async () => {
        const chat = webContents
          .getAllWebContents()
          .find((contents) => contents.getTitle() === 'Aurora 对话')
        if (chat === undefined) return { pass: false, reason: 'no chat webContents' }
        const restored = await chat.executeJavaScript(
          `(async () => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
            const back = document.querySelector('[data-action="automation-back"]')
            if (back === null) return { ok: false, reason: 'no automation-back' }
            back.click()
            for (let attempt = 0; attempt < 20; attempt += 1) {
              if (document.querySelector('.thread, [data-field="chat.subagent-page"]') !== null) break
              await wait(100)
            }
            return {
              ok: document.querySelector('[data-field="automation.page"]') === null,
            }
          })()`,
          true,
        )
        return { pass: restored.ok === true, restored }
      },
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
    // 收起窗口放在自动滚底四条之后（四条都要读 .thread/.messages，窗口一 hide 就没了）。
    { name: 'chat', file: 'chat-collapse.png', check: CHAT_COLLAPSE_CHECK },
    // 插件面板（P3，docs/14 §3.4）：声明式 schema 与沙箱页面两条渲染路径。
    // 示例插件由 runCapture 预装；这两条都通过真实「＋」菜单打开标签。
    {
      name: 'chat',
      file: 'chat-plugin-panel.png',
      act: CHAT_PLUGIN_PANEL_ACT,
      check: CHAT_PLUGIN_PANEL_CHECK,
    },
    {
      name: 'chat',
      file: 'chat-plugin-page.png',
      act: CHAT_PLUGIN_PAGE_ACT,
      check: CHAT_PLUGIN_PAGE_CHECK,
      // webview 的 guest 首次加载 + RPC 往返比普通 DOM 慢
      settleMs: 900,
    },
    {
      name: 'chat',
      file: 'chat-plugin-panel-push.png',
      act: CHAT_PLUGIN_PANEL_PUSH_ACT,
      check: CHAT_PLUGIN_PANEL_PUSH_CHECK,
      settleMs: 500,
    },
    {
      // 桌面小组件窗口不在 WindowName 里：由 captureWindows 的 widgetWindow 现取。
      name: 'widget',
      file: 'widget-desktop-plugin.png',
      widget: { pluginId: 'com.example.hello', widgetId: 'duty-week' },
      check: WIDGET_DESKTOP_PLUGIN_CHECK,
      settleMs: 600,
    },
    // 无标签页时的右栏工具快捷入口（2026-10-03，docs/07 §2.3）：prepare reload 回
    // 初始四标签 → act 走真实 ✕ 关掉全部（截图停在这里：右栏四张卡片）→
    // check 验证卡片矩形 / 命中，并点"文件"卡片把标签开回来。
    // **排在 chat 组末尾**：它把标签集与面板挂载状态改过了，后面不应再有 chat 场景。
    {
      name: 'chat',
      file: 'chat-ctx-empty-tools.png',
      prepare: async () => {
        await manager.reload('chat', {})
      },
      act: CHAT_CTX_EMPTY_ACT,
      check: CHAT_CTX_EMPTY_CHECK,
    },
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
  // 双主题（step-06）：设置窗先落在"常规"页拍一张主题场景，后面的深链循环不受影响。
  plan.push({
    name: 'settings',
    file: 'theme-settings.png',
    query: { page: 'general' },
    check: themeProbeScript({ theme, transparent: true }),
    nativeCheck: nativeGlassCheck(manager, 'settings'),
  })
  // ClassIsland 联动（v3）：新增的设置项只在"provider = classisland + 至少一节课程"时渲染，
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
  // 毛玻璃开关（v32）：先经 settings:update 关掉，检查渲染层令牌降级 + **原生材质真的摘掉**，
  // check 收尾还原成开。刻意排在 "SETTINGS_PAGE_IDS" 循环**之后**：这一节会改配置，
  // 而上面那批图（含 "theme-settings.png" 的原生材质断言）都要求默认档。
  //
  // ⚠️ 原生材质那半走 "mainAct"（在截图之前、还原之前跑），**不能**用 "nativeCheck" ——
  // 后者的执行点在渲染层 "check" **之后**，而 check 收尾已经把 glass 改回 true，
  // 那样只会读到"已经还原"的假结果（判据看似通过，实际什么都没证明）。
  plan.push({
    name: 'settings',
    file: 'settings-appearance-glass-off.png',
    query: { page: 'general' },
    act: APPEARANCE_GLASS_OFF_ACT,
    mainAct: async () => {
      // 2026-10-11：提示条也进了材质名单，两窗一起断言「关掉毛玻璃后材质真的摘掉」。
      const settings = await nativeGlassGoneCheck(manager, 'settings')()
      const edgeBar = await nativeGlassGoneCheck(manager, 'edge-bar')()
      return { ...settings, edgeBar, pass: settings.pass === true && edgeBar.pass === true }
    },
    check: APPEARANCE_GLASS_OFF_CHECK,
  })
  for (const page of SETTINGS_PAGE_IDS) {
    plan.push({
      name: 'settings',
      file: `settings-${page}.png`,
      query: { page },
      // "常规"页是 "general.*" 门控的现场：死字段 general.language 必须为 0，
      // 提示条透明度 / 静默时段要跟着 general.edgeBar.enabled 出现或消失，
      // BetaV2 迁入的全局勿扰时段（advanced.quietHours）两字段必须常在；
      // "模式"页（ClassRoom 生效）：classroom 区组在、work 区组整块不在（BetaV2 互斥渲染），
      // 前置 act 展开"课表"分组（默认收起，否则课前提醒字段不在 DOM）；
      // "AI 模型"页（BetaV2）：对话展示开关 + 生图模型区组；
      // "语音"页（BetaV2 合并 TTS + STT）：两个区组各自的常显字段与列表空态二选一；
      // "Agent 设置"页（BetaV2 合并技能 + MCP）：预期空状态见 SETTINGS_AGENT_FIELDS_SCRIPT；
      // 技能 / MCP 区组默认收起（docs/07 §2.5），探针在 check 里自己先展开再计数（async），
      // 所以这里**不需要**像 modes 页那样配 act —— PNG 拍到的正是默认收起态。
      // "AI 模型"页也配一个拍图前置（step-06）：把页面**底部**的生图区组滚进视口 ——
      // 设置窗是固定高度 + 内部滚动，不滚的话这张 PNG 只拍得到页头，而
      // "生图空状态里有可点的『+ 添加生图模型』按钮"正是要在这张图上人工核对的一条。
      act:
        page === 'modes'
          ? SETTINGS_MODES_EXPAND_ACT
          : page === 'llm'
            ? SETTINGS_LLM_SCROLL_ACT
            : page === 'awareness'
              ? SETTINGS_AWARENESS_SCROLL_ACT
              : undefined,
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
                    : page === 'awareness'
                      ? SETTINGS_AWARENESS_USAGE_CHECK
                      : undefined,
    })
  }
  // 旧深链别名（BetaV2）："?page=tts" 应映射到"语音"页（TTS + STT 都在）；
  // skills|mcp → agent 走同一张 LEGACY_PAGE_ALIASES 映射表，机制由本场景代表验证。
  plan.push({
    name: 'settings',
    file: 'settings-legacy-tts-alias.png',
    query: { page: 'tts' },
    check: SETTINGS_LEGACY_ALIAS_SCRIPT,
  })
  // 插件（P3，docs/14 §5）：已安装视图 + 市场占位。示例插件由 `runCapture` 预装；
  // 「已安装」页同时钉住主题选择区组与「安装插件包」入口在 DOM 里。
  plan.push({
    name: 'settings',
    file: 'settings-plugins-installed.png',
    query: { page: 'plugins' },
    act: SETTINGS_PLUGINS_INSTALLED_ACT,
    check: SETTINGS_PLUGINS_INSTALLED_CHECK,
  })
  plan.push({
    name: 'settings',
    file: 'settings-plugins-detail.png',
    query: { page: 'plugins' },
    act: SETTINGS_PLUGINS_DETAIL_ACT,
    check: SETTINGS_PLUGINS_DETAIL_CHECK,
  })
  // 上一条 act 已通过真实「配置」按钮打开了单例 plugin-config 窗口；这一条直接截它。
  plan.push({
    name: 'plugin-config',
    file: 'plugin-config.png',
    check: PLUGIN_CONFIG_CHECK,
    settleMs: 500,
  })
  plan.push({
    name: 'settings',
    file: 'settings-plugins-marketplace.png',
    query: { page: 'plugins' },
    act: SETTINGS_PLUGINS_MARKET_ACT,
    check: SETTINGS_PLUGINS_MARKET_CHECK,
  })
  // Center 官方 TTS / STT / 生图在 Provider 页的只读卡片（目录不可用时也要常显）。
  plan.push({
    name: 'settings',
    file: 'settings-center-official-voice.png',
    query: { page: 'voice' },
    act: SETTINGS_CENTER_PROVIDER_ACT,
    check: SETTINGS_CENTER_TTS_STT_CHECK,
  })
  plan.push({
    name: 'settings',
    file: 'settings-center-official-imagegen.png',
    query: { page: 'llm' },
    act: SETTINGS_CENTER_PROVIDER_ACT,
    check: SETTINGS_CENTER_IMAGEGEN_CHECK,
  })
  // "会话管理"页 · 项目区组（2026-09-30 自"通用"页迁入，docs/06 §5.1）：
  // prepare 先建出真实项目根（让"根可用"这个健康态成立），act 把项目登记进 projects.list，
  // check 断言两个字段锚点在、显示项目名与根路径，再把根改成不存在的目录断言
  // **警示文案**出现（假设 7 的可见提示），最后还原成无项目。
  plan.push({
    name: 'settings',
    file: 'settings-sessions-project.png',
    query: { page: 'sessions' },
    prepare: async () => {
      await mkdir(captureProjectRoot(userData), { recursive: true })
    },
    act: settingsProjectAct(captureProjectRoot(userData), '截图项目'),
    check: settingsProjectCheck('截图项目', captureMissingProjectRoot(userData)),
  })
  // "会话管理"页 · 会话列表（2026-09-30 新增）：列表渲染 + 归档往返 + 删除两步确认。
  // 现场依赖 seed 的 main 会话与已归档会话（runCapture 在跑计划前种好）；本场景带 query，
  // 设置窗会重新挂载，列表在 onMounted 自有首读，不需要额外 reload。
  plan.push({
    name: 'settings',
    file: 'settings-sessions-list.png',
    query: { page: 'sessions' },
    act: SETTINGS_SESSIONS_ACT,
    check: SETTINGS_SESSIONS_CHECK,
  })
  // 设置页"文件备份"列表（2026-09，回滚 UI 自主界面右栏迁入 Agent 页）：
  // prepare 种一份真实快照（走真实端口 + flush，不是手写 json），随后**带 query 重载**
  // 设置窗让 SnapshotList 重新挂载并首读（列表只在挂载 / 手动刷新时拉取）；
  // act 点一次"回滚"（两段式的第一下），check 断言列表在、有记录、来源文案、
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
  // 设置窗拖动区（step-06）：侧栏顶部 / ".brand" / 内容区顶部三处至少要有一条 ≥ 32px 的可见拖动区，
  // 且窗口按钮仍能被 elementFromPoint 命中 —— 按钮在拖动区内验证 no-drag（chat），
  // 不在拖动区内则回退到全局关闭按钮、验证没被浮层盖住（设置窗 caption 已贴窗口右上缘）。
  plan.push({
    name: 'settings',
    file: 'settings-drag.png',
    query: { page: 'general' },
    check: WINDOW_DRAG_SCRIPT,
  })
  // 模型设置区（step-05）：点开第一行的"编辑"→"+ 手动添加"使行数恰好 +1 → 删回原状。
  // 排在 "settings-llm-params" **之前**：它只动本地 draft、不改配置，先跑能少一次配置往返。
  plan.push({
    name: 'settings',
    file: 'settings-llm-models.png',
    query: { page: 'llm' },
    act: SETTINGS_LLM_MODELS_ACT,
    check: SETTINGS_LLM_MODELS_CHECK,
  })
  // 默认模型下拉（v37）：通过下拉真实切换一次 → DOM 与配置都为新值 → 写回原默认。
  // 排在 models 之后（那时已有 provider），并在 params 之前（params 会读 active 那一行）。
  plan.push({
    name: 'settings',
    file: 'settings-llm-default.png',
    query: { page: 'llm' },
    act: SETTINGS_LLM_DEFAULT_ACT,
    check: SETTINGS_LLM_DEFAULT_CHECK,
  })
  // 思考等级（step-02）：造一个 provider → 展开"高级参数"→ 断言下拉真值来自配置。
  // 刻意放在 SETTINGS_PAGE_IDS 循环**之外**：塞进循环会让每个设置页都多点一次。
  plan.push({
    name: 'settings',
    file: 'settings-llm-params.png',
    query: { page: 'llm' },
    act: SETTINGS_LLM_EFFORT_ACT,
    check: SETTINGS_LLM_EFFORT_CHECK,
  })
  // AI 模型页的新信息架构（step-04）：行列表 + 一次只开一张编辑卡 + 空状态。
  // 顺序在 "settings-llm-params" 之后；两者互不干扰——每个场景都会 "reload" 设置窗，
  // 页面回到列表态，且本场景自身**不改配置**（只点开一张卡）。
  plan.push({
    name: 'settings',
    file: 'settings-llm-structure.png',
    query: { page: 'llm' },
    act: SETTINGS_LLM_STRUCTURE_ACT,
    check: SETTINGS_LLM_STRUCTURE_CHECK,
  })
  // 接口类型 + 图片输入（v22 多模态轮，docs/06 §3.1 / §3.2）：把生效 provider 的协议写成
  // "openai-responses"、图片输入打开 → 展开折叠区，断言两个控件在 DOM 里且真值来自配置，
  // 随后写回原值。排在 "settings-llm-structure" 之后（它只点开卡、不改配置，先跑更安全）。
  plan.push({
    name: 'settings',
    file: 'settings-llm-multimodal.png',
    query: { page: 'llm' },
    act: SETTINGS_LLM_MULTIMODAL_ACT,
    check: SETTINGS_LLM_MULTIMODAL_CHECK,
  })
  // "语音"页编辑卡（step-05）：点"+ 空白配置"→ 断言六个字段的 data-field 都在。
  // 只动**本地 draft**、不点"应用"，所以无需恢复动作。
  // ⚠️ "settings-voice.png" 不在这里 push：上面的 "SETTINGS_PAGE_IDS" 循环已经为每个 page
  // 生成 "settings-<page>.png"（含 "voice"），再 push 一张同名图会多截一次、"report.json" 里
  // 出现两条同名且后者把前者的 check 顶掉，所以要拍的只有这张卡场景。
  // 深链用旧 id "tts"（别名场景同款）：顺带覆盖"旧链接打开的页面上编辑卡流程照常可用"。
  plan.push({
    name: 'settings',
    file: 'settings-tts-card.png',
    query: { page: 'tts' },
    act: SETTINGS_TTS_ADD_ACT,
    check: SETTINGS_TTS_CARD_CHECK,
  })
  // "语音"页 STT 编辑卡（v24 阿里云原生 ASR）：点"+ 空白配置"→ 断言五字段在，
  // 且"接口协议"下拉切到阿里云原生时 baseURL 提示词被改写（行为断言，不是只看控件在）。
  // 同样只动本地 draft、不点"应用"；用**新页 id** "voice"（与上面 TTS 那条的旧别名 "tts" 相对）。
  plan.push({
    name: 'settings',
    file: 'settings-stt-card.png',
    query: { page: 'voice' },
    act: SETTINGS_STT_ADD_ACT,
    check: SETTINGS_STT_CARD_CHECK,
  })
  // 真实写盘：改一个 classroom 字段后其它字段不能丢（浅合并语义回归）。
  // 必须排在"切到 Work"之前 —— 切走之后 classroom 控件就不在 DOM 里了。
  // （ClassRoom 生效态的结构断言已由上面循环里的 "settings-modes.png" 承担，
  // 这里只保留"真实写盘"与"切 Work 门控"两个会改状态的动作场景。）
  plan.push({
    name: 'settings',
    file: 'settings-classroom-patch.png',
    query: { page: 'modes' },
    act: SETTINGS_CLASSROOM_PATCH_ACT,
    check: SETTINGS_CLASSROOM_PATCH_CHECK,
  })
  // 模式页门控（BetaV2 重写）：切到 Work 后 "modes.work.workspaceDir" 必须出现，
  // classroom 区组与 modes.* 空状态卡必须消失 —— Work 已实装，不再是"暂无可配置项"。
  plan.push({
    name: 'settings',
    file: 'settings-modes-work-gating.png',
    query: { page: 'modes' },
    act: SETTINGS_SWITCH_TO_WORK_SCRIPT,
    check: SETTINGS_WORK_GATING_SCRIPT,
  })
  // 设置页"安全区"横向溢出巡检（docs/07 §5.4）：一次点击走完 7 个页面，
  // 断言内容区里没有元素探出左右边界。排在所有会改配置的设置页场景**之后**：
  // 它只量几何，读哪一版配置都一样，放最后不用担心影响别人。
  plan.push({
    name: 'settings',
    file: 'settings-overflow.png',
    query: { page: 'general' },
    act: SETTINGS_OVERFLOW_ACT,
    check: SETTINGS_OVERFLOW_CHECK,
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
    // ⚠️ 先**隐藏**交互窗再点击竖条：否则这条会退化成空转 —— 计划前面已经有一次 "manager.show('chat')"
    //（"chat.png" 场景），状态机里 "chat:true / primary:'chat'" 在点击**之前**就成立，探针不再依赖点击。
    // 删掉 "mini-chat.png" 场景后窗口互斥不再自动把它藏起来，所以这里显式复位。
    prepare: () => {
      manager.hide('chat')
    },
  })
  return plan
}

/** 把逗号分隔的取值切成去空 token（两个过滤开关共用）。 */
export function parseCaptureTokens(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/**
 * 按窗口名（`AURORA_CAPTURE_WINDOWS`）与场景文件名（`AURORA_CAPTURE_ONLY`）过滤截图清单。
 *
 * 两级过滤各管一件事：窗口名只能粗到某一类用户窗口（另有内部 `awareness-glow`），
 * 通常没法只跑"会话三分那一张"；`only` 按 `file` 做**子串**匹配 —— 写 `session-groups`
 * 或 `chat-session-groups.png` 都能命中，它才是把一轮五六十张收敛成"改到哪张跑哪张"的那级。
 *
 * `only` 的取值用 `string[] | undefined` 而不是 `string | undefined`，是为了让
 * **"空数组"与"不传"语义分开**：`undefined` = 不按场景筛（全选），`[]` = 一张都不选。
 * 揉成空串的话，`AURORA_CAPTURE_ONLY=failed` 碰上"上次全绿"就会静默退化成全量重跑
 * —— 那正是这个开关最不该做的事。窗口名沿用空串 = 全选（`AURORA_CAPTURE_WINDOWS`
 * 的既有语义，不能改）。
 */
export function filterCapturePlan(
  plan: CaptureTarget[],
  requested: string | undefined,
  only: readonly string[] | undefined = undefined,
): CaptureTarget[] {
  const names = parseCaptureTokens(requested)
  return plan.filter((target) => {
    if (names.length > 0 && !names.includes(target.name)) return false
    if (only === undefined) return true
    const file = target.file ?? `${target.name}.png`
    return only.some((token) => file.includes(token))
  })
}

/**
 * 读上次 `report.json` 里**没通过**的场景文件名（截图/探针抛错 `ok:false`，或探针 `pass:false`），
 * 供 `AURORA_CAPTURE_ONLY=failed` 只重验红掉的那几张。
 *
 * 没有报告 / 报告损坏时返回空数组，**由调用方决定怎么办** —— 这里刻意不回落成"全量重跑"：
 * 把"重验失败项"悄悄变成"重跑五六十张"是最坏的结果（一轮三五分钟，用户以为很快）。
 */
export async function failedCaptureFiles(dir: string): Promise<string[]> {
  try {
    const raw = await readFile(join(dir, 'report.json'), 'utf8')
    const parsed = JSON.parse(raw) as {
      checks?: Array<{ file?: unknown; ok?: unknown; result?: unknown }>
    }
    const names = (parsed.checks ?? [])
      .filter(
        (item) =>
          item.ok === false || (item.result as { pass?: unknown } | undefined)?.pass === false,
      )
      .map((item) => (typeof item.file === 'string' ? basename(item.file) : ''))
      .filter((name) => name !== '')
    return [...new Set(names)]
  } catch {
    return []
  }
}
