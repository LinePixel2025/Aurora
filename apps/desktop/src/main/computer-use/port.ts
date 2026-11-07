/**
 * `ComputerUsePort` 的主进程实现（docs/06 §28）。
 *
 * 这一层负责把「模型意图」翻译成安全的系统动作：
 * 截屏 → 坐标空间 → 命中测试 → 应用策略 → PowerShell 宿主 → 回执 / 事件。
 *
 * 它 import electron（间接经 screenshots.ts），因此没有 vitest 单测；
 * 坐标 / 策略 / 会话状态等纯逻辑各自在独立文件里覆盖。
 */
import { screen } from 'electron'
import type { Logger, Settings } from '@aurora/shared'
import type {
  ComputerKeyboardInput,
  ComputerMouseInput,
  ComputerScreenshotInput,
  ComputerStartInput,
  ComputerStopInput,
  ComputerUiInput,
  ComputerUsePort,
  ComputerWaitInput,
  ComputerWindowInput,
  ToolResult,
} from '@aurora/agent-core'
import type { ComputerUseInputHost } from './input-host.js'
import {
  buildScreenView,
  displayAtPhysicalPoint,
  displayAtPoint,
  imageToPhysical,
  physicalToImage,
  rectContains,
  targetBoundsMoved,
  viewMatchesDisplay,
  type DisplayGeometry,
  type Point,
  type ScreenView,
} from './coordinates.js'
import {
  LAUNCH_WINDOW_WAIT_MS,
  describeActivateFailure,
  describeLaunchResult,
  launchKey,
  planLaunch,
  type LaunchHostResult,
} from './launch.js'
import {
  buttonLabel,
  describeKeyboardAction,
  describeMouseAction,
  describeUiAction,
  describeWindowAction,
  isAppAllowed,
  isLaunchableCommand,
  isProtectedWindow,
  isWindowOperable,
  normalizeExeName,
} from './policy.js'
import type { ComputerUseService } from './service.js'
import {
  captureDisplay,
  listDisplayGeometries,
  physicalToDip,
  primaryDisplayId,
} from './screenshots.js'

/**
 * 虚拟光标到位后到点击之间的停顿（毫秒）。
 *
 * 浮层光标的 CSS 过渡约 42ms，这一步留出「看得见光标停住」的一拍，用户才会把
 * 「移动」和「点击」看成一个先后动作，而不是一次跳变。
 */
const CURSOR_SETTLE_MS = 60

/**
 * 逐字输入的**总延迟预算**（毫秒，v39.1）。
 *
 * `typingDelayMs` 是「每字间隔」：500 字 × 10ms 就是 5 秒，用户看到的是「Agent 卡住了」。
 * 这里按文本长度反推可用间隔，让整段输入最多多花约 1.2 秒；短文本（约 ≤120 字）
 * 完全不受影响，仍是用户配置的逐字间隔（慢应用需要它）。
 */
const TYPE_TOTAL_DELAY_BUDGET_MS = 1200

/** 目标窗口矩形允许的漂移（像素）：超过就认为截图后窗口被移动 / 缩放了。 */
const TARGET_BOUNDS_TOLERANCE_PX = 6

interface WindowInfo {
  windowId: string
  title: string
  className: string
  pid: number
  exe: string
  bounds: { x: number; y: number; width: number; height: number }
  visible: boolean
  minimized: boolean
  maximized: boolean
  foreground: boolean
}

interface CursorPoint {
  x: number
  y: number
}

export interface ComputerUsePortOptions {
  settings: () => Settings
  service: ComputerUseService
  host: ComputerUseInputHost
  logger: Logger
  screenshotDir: string
  /** 当前进程 pid（Aurora 自身窗口保护） */
  selfPid?: number
}

export class DesktopComputerUsePort implements ComputerUsePort {
  private readonly options: ComputerUsePortOptions
  private readonly views = new Map<string, ScreenView>()
  /**
   * 每个会话最近一次「没检测到窗口」的启动（key = command + args）。
   *
   * 只用于 8s 冷却，防止模型因为「没看到窗口」立刻再 launch 一次（实测会重复打开同一应用）。
   * 产生窗口 / 换了 command 参数都不受冷却影响。
   */
  private readonly launchAttempts = new Map<string, Map<string, { key: string; at: number }>>()

  constructor(options: ComputerUsePortOptions) {
    this.options = options
  }

  async screenshot(input: ComputerScreenshotInput): Promise<ToolResult> {
    this.options.service.ensureCallAllowed(input.sessionId)
    this.noteNext(input)
    await this.options.host.ensureReady()
    const displays = listDisplayGeometries()
    // 指定窗口时直接按 HWND 查（快速设置这类弹出窗不一定在 window_list 里），不必全量枚举；
    // 未指定窗口时只查前台（截图是最频繁的动作，全量枚举在这里纯属浪费）。
    const requested =
      input.windowId === undefined ? undefined : await this.windowInfo(input.windowId)
    if (input.windowId !== undefined && requested === undefined) {
      return toolError(
        'E_CU_WINDOW_NOT_FOUND',
        `找不到窗口 ${input.windowId}，请先用 computer_window list / active 确认。`,
      )
    }
    if (requested !== undefined) this.assertOperable(requested)
    if (requested?.visible === false) {
      return toolError(
        'E_CU_WINDOW_NOT_VISIBLE',
        '目标窗口当前不可见，请先 computer_window restore。',
      )
    }
    if (requested?.minimized === true) {
      return toolError('E_CU_WINDOW_MINIMIZED', '目标窗口已最小化，请先 computer_window restore。')
    }
    const foreground = input.windowId === undefined ? await this.foregroundWindow() : undefined

    const display = await this.pickDisplay(displays, input, requested ?? foreground)
    // 截图是「只读步骤」：不进动作限额，但过程面板要能看见 Agent 正在看屏幕。
    this.options.service.noteStep(input.sessionId, 'screen.capture', '正在查看屏幕')
    const windowRect = requested?.bounds
    const maxWidth = input.maxWidth ?? this.options.settings().computerUse.screenshotMaxWidth
    let captured
    try {
      captured = await captureDisplay({
        dir: this.options.screenshotDir,
        logger: this.options.logger,
        display,
        ...(windowRect === undefined ? {} : { windowRect }),
        maxWidth,
      })
    } catch (error) {
      return toolError('E_CU_SCREENSHOT', `截屏失败：${String(error)}`)
    }
    const target =
      requested ??
      (foreground !== undefined && this.isOperable(foreground) ? foreground : undefined)
    const view = buildScreenView({
      display,
      imageWidth: captured.imageWidth,
      imageHeight: captured.imageHeight,
      physicalRect: captured.physicalRect,
      ...(target === undefined
        ? {}
        : {
            targetWindowId: target.windowId,
            targetPid: target.pid,
            targetExe: normalizeExeName(target.exe),
            targetBounds: target.bounds,
          }),
    })
    this.views.set(input.sessionId, view)
    const cursor = await this.options.host.request<CursorPoint>('cursor_get')
    const cursorImage = physicalToImage(view, cursor)
    const area = captured.physicalRect
    const targetText =
      requested !== undefined
        ? `目标窗口：「${requested.title}」（${normalizeExeName(requested.exe)}，id ${requested.windowId}）`
        : foreground === undefined
          ? '前台窗口：读取失败（仍可截图，但点击前会重新做命中测试）'
          : this.isOperable(foreground)
            ? `前台窗口：「${foreground.title}」（${normalizeExeName(foreground.exe)}，id ${foreground.windowId}）`
            : `前台窗口：「${foreground.title}」（${normalizeExeName(foreground.exe)}，受保护，不作为操作目标）`
    const text = [
      `截图：显示器 ${display.id}（物理 ${display.physicalSize.width}×${display.physicalSize.height}），` +
        `本次图像覆盖物理区域 (${Math.round(area.x)}, ${Math.round(area.y)}) ` +
        `${Math.round(area.width)}×${Math.round(area.height)}，图片 ${captured.imageWidth}×${captured.imageHeight}` +
        '（坐标空间 = 本次图片像素）。' +
        (captured.cropFailed ? '（窗口裁剪不可用，已改截整屏）' : ''),
      targetText,
      `鼠标：物理 (${Math.round(cursor.x)}, ${Math.round(cursor.y)}) → 图片 (${Math.round(cursorImage.x)}, ${Math.round(cursorImage.y)})。`,
      '浮层上的光环是 Agent 自己的虚拟光标（上次落点），可能与真实指针不同；动作仍按你给的坐标执行。',
      `换算：physical = origin(${view.origin.x.toFixed(2)}, ${view.origin.y.toFixed(2)}) + 图片像素 / ` +
        `scale(${view.scaleX.toFixed(4)}, ${view.scaleY.toFixed(4)})；` +
        `1 图片像素 ≈ ${(1 / view.scaleX).toFixed(2)}×${(1 / view.scaleY).toFixed(2)} 物理像素。` +
        ' computer_mouse 默认按图片像素给坐标。',
      '小控件建议先用 computer_ui find，或用 windowId + maxWidth=2560 放大截图后再点。',
      '截图顶部的 Aurora 状态胶囊 / 光环是 Aurora 自己的浮层，不属于被测应用，不要把它们当作点击目标。',
      `截图路径：${captured.path}`,
    ].join('\n')
    return {
      content: text,
      summary: '已截屏',
      images: [captured.image],
    }
  }

  async mouse(input: ComputerMouseInput): Promise<ToolResult> {
    this.options.service.ensureCallAllowed(input.sessionId)
    this.noteNext(input)
    await this.options.host.ensureReady()
    const view = this.views.get(input.sessionId)
    if (input.action === 'position') {
      this.options.service.noteStep(input.sessionId, 'mouse.position', '正在读取鼠标位置')
      const cursor = await this.options.host.request<CursorPoint>('cursor_get')
      const image = view === undefined ? undefined : physicalToImage(view, cursor)
      return {
        content:
          `鼠标物理坐标 (${Math.round(cursor.x)}, ${Math.round(cursor.y)})` +
          (image === undefined
            ? '。尚未截图，坐标空间未建立。'
            : `；最近截图空间 (${Math.round(image.x)}, ${Math.round(image.y)})。`),
        summary: '读取鼠标位置',
      }
    }
    if (input.action === 'move' || input.action === 'drag' || input.action === 'scroll') {
      if (input.action !== 'scroll' || input.x !== undefined || input.y !== undefined) {
        requirePoint(input.x, input.y)
      }
    } else {
      requirePoint(input.x, input.y)
    }
    if (input.space !== 'screen' && (input.x !== undefined || input.toX !== undefined)) {
      // 图片坐标只对「最近的显示器几何」成立：分辨率 / 缩放 / 显示器增删后必须重截。
      this.assertViewFresh(view)
    }
    const start =
      input.x !== undefined && input.y !== undefined
        ? this.toPhysical(view, input.space, { x: input.x, y: input.y })
        : undefined
    const end =
      input.toX !== undefined && input.toY !== undefined
        ? this.toPhysical(view, input.space, { x: input.toX, y: input.toY })
        : undefined

    if (input.action === 'move' && start !== undefined) {
      this.options.service.beginAction(
        input.sessionId,
        'mouse.move',
        describeMouseAction({ action: 'move' }),
        { displayId: view?.displayId, x: input.x, y: input.y },
      )
      const [landed] = await Promise.all([
        this.movePointer(start, this.options.settings().computerUse.moveDurationMs),
        this.glideCursor(start, this.options.settings().computerUse.moveDurationMs),
      ])
      return {
        content: `已移动到物理 (${Math.round(landed.x)}, ${Math.round(landed.y)})。`,
        summary: '鼠标已移动',
      }
    }

    if (
      input.action === 'click' ||
      input.action === 'double_click' ||
      input.action === 'right_click' ||
      input.action === 'middle_click'
    ) {
      if (start === undefined) throw new Error('点击需要 x / y（或先截图后用图片坐标）')
      const button =
        input.action === 'right_click'
          ? 'right'
          : input.action === 'middle_click'
            ? 'middle'
            : (input.button ?? 'left')
      const count = input.action === 'double_click' ? 2 : (input.count ?? 1)
      await this.assertTargetAt(view, start)
      this.options.service.beginAction(
        input.sessionId,
        'mouse.click',
        describeMouseAction({ action: input.action, button }),
        { displayId: view?.displayId, x: input.x, y: input.y },
      )
      // **先移动光标，再点击**（2026-10-31）：滑行阶段只动浮层上的虚拟光标，**系统指针原地不动**
      // —— 否则用户会看到「Agent 移动虚拟光标时我的鼠标也跟着滑」。等光环到位、停一拍，
      // 才把系统指针瞬移到落点并立刻点击（Windows 只能在指针所在处点击，这一步无法省）。
      const moveMs = this.options.settings().computerUse.moveDurationMs
      const dip = await this.glideCursor(start, moveMs)
      await sleep(this.cursorSettleMs(), undefined)
      await this.movePointer(start, 0)
      await this.withModifiers(input.modifiers, async () => {
        const response = await this.options.host.request<CursorPoint>('mouse_click', {
          button,
          count,
        })
        if (response === undefined) throw new Error('点击没有回执')
      })
      // 涟漪按**显示器内 DIP** 发（浮层是 DIP 坐标）：直接拿图片像素会在缩放屏上偏移。
      const ripple = dip ?? this.dipOf(start)
      if (ripple !== undefined) {
        this.options.service.noteClick({ ...ripple, button })
      }
      return {
        content: `已${buttonLabel(button)}${count > 1 ? '双击' : '单击'}；指针落点物理 (${Math.round(start.x)}, ${Math.round(start.y)})。`,
        summary: count > 1 ? '已双击' : `已${buttonLabel(button)}单击`,
      }
    }

    if (input.action === 'drag') {
      if (start === undefined || end === undefined) throw new Error('拖拽需要 x/y 与 toX/toY')
      await this.assertTargetAt(view, start)
      this.options.service.beginAction(
        input.sessionId,
        'mouse.drag',
        describeMouseAction({ action: 'drag', button: input.button }),
        { displayId: view?.displayId, x: input.x, y: input.y },
      )
      const moveMs = this.options.settings().computerUse.moveDurationMs
      // 先把**虚拟光标**移到起点（看得见「去抓东西」）；系统指针等光标到位后才瞬移过去。
      await this.glideCursor(start, moveMs)
      await sleep(this.cursorSettleMs(), undefined)
      await this.movePointer(start, 0)
      const dragMs = moveMs * 2
      await this.withModifiers(input.modifiers, async () => {
        const drag = this.options.host.request('mouse_drag', {
          x: Math.round(start.x),
          y: Math.round(start.y),
          toX: Math.round(end.x),
          toY: Math.round(end.y),
          button: input.button ?? 'left',
          durationMs: dragMs,
        })
        // 拖拽轨迹由宿主合成；虚拟光标按同一时长跟到终点（两条视线同步，不各走各的）
        const follow = this.glideCursor(end, dragMs > 0 ? dragMs + 30 : 0)
        await Promise.all([drag, follow])
      })
      return {
        content: `已从物理 (${Math.round(start.x)}, ${Math.round(start.y)}) 拖到 (${Math.round(end.x)}, ${Math.round(end.y)})。`,
        summary: '拖拽完成',
      }
    }

    if (input.action === 'scroll') {
      // 带坐标时 start 是物理（已换算）；不带坐标时**必须**读宿主的物理指针 ——
      // `screen.getCursorScreenPoint()` 是 DIP，拿去给 `WindowFromPoint` 会命中错误窗口。
      let at = start
      if (at === undefined) {
        const cursor = await this.options.host.request<CursorPoint>('cursor_get')
        if (cursor === undefined) throw new Error('读取鼠标位置失败，已拒绝滚动。')
        at = cursor
      }
      await this.assertTargetAt(view, at)
      this.options.service.beginAction(
        input.sessionId,
        'mouse.scroll',
        describeMouseAction({ action: 'scroll' }),
        { displayId: view?.displayId, x: input.x, y: input.y },
      )
      if (start !== undefined) {
        const moveMs = this.options.settings().computerUse.moveDurationMs
        // 滚轮同样先让虚拟光标到位：系统指针只在真正滚动那一刻瞬移过去
        await this.glideCursor(start, moveMs)
        await sleep(this.cursorSettleMs(), undefined)
        await this.movePointer(start, 0)
      }
      await this.withModifiers(input.modifiers, async () => {
        await this.options.host.request('mouse_scroll', {
          dx: input.dx ?? 0,
          dy: input.dy ?? 0,
        })
      })
      return {
        content: `已滚动 dx=${input.dx ?? 0} dy=${input.dy ?? 0}（正 dy 向上）。`,
        summary: '已滚动',
      }
    }
    throw new Error(`不支持的鼠标动作 ${input.action}`)
  }

  async keyboard(input: ComputerKeyboardInput): Promise<ToolResult> {
    this.options.service.ensureCallAllowed(input.sessionId)
    this.noteNext(input)
    await this.options.host.ensureReady()
    const view = this.views.get(input.sessionId)
    const foreground = await this.foregroundWindow()
    if (foreground === undefined) {
      throw new Error('读取前台窗口失败，已拒绝键盘输入。')
    }
    this.assertOperable(foreground)
    if (!this.isSameTarget(view, foreground)) {
      throw new Error(
        `前台窗口已变成「${foreground.title}」(${normalizeExeName(foreground.exe)})，` +
          `与最近截图的目标「${view?.targetExe ?? '未知'}」不一致；已拒绝输入。` +
          '请先 computer_screenshot 确认现状，用 computer_window activate 或点击目标窗口把焦点切回去，再输入。' +
          '（E_CU_TARGET_CHANGED）',
      )
    }
    if (input.action === 'type') {
      const text = input.text ?? ''
      this.options.service.beginAction(
        input.sessionId,
        'keyboard.type',
        describeKeyboardAction({ action: 'type', chars: text.length }),
      )
      const response = await this.options.host.request<{ chars: number }>('key_type', {
        text,
        submit: input.submit === true,
        delayMs: this.typingDelayMs(
          input.delayMs ?? this.options.settings().computerUse.typingDelayMs,
          text.length,
        ),
      })
      return {
        content:
          `已输入 ${response?.chars ?? text.length} 个字符` +
          (input.submit === true ? '并按下 Enter' : '') +
          '（内容不回显）。',
        summary: `已输入 ${response?.chars ?? text.length} 个字符`,
      }
    }
    const keys = input.keys ?? []
    this.options.service.beginAction(
      input.sessionId,
      'keyboard.key',
      describeKeyboardAction({ action: 'key', keys }),
    )
    await this.options.host.request('key_chord', { keys })
    return { content: `已按键 ${keys.join('+')}。`, summary: `已按键 ${keys.join('+')}` }
  }

  async window(input: ComputerWindowInput): Promise<ToolResult> {
    this.options.service.ensureCallAllowed(input.sessionId)
    this.noteNext(input)
    await this.options.host.ensureReady()
    let windows = await this.windowList()
    if (input.windowId !== undefined && findWindow(windows, input.windowId) === undefined) {
      // 快速设置 / 系统弹出窗可能不在 EnumWindows 的可见窗口表里；直接按 HWND 补一条。
      const direct = await this.windowInfo(input.windowId)
      if (direct !== undefined) windows = [direct, ...windows]
    }
    if (input.action === 'list') {
      this.options.service.noteStep(input.sessionId, 'window.list', '正在查看窗口列表')
      const filter = (input.filter ?? '').trim().toLowerCase()
      const list = windows.filter(
        (item) =>
          filter === '' ||
          item.title.toLowerCase().includes(filter) ||
          item.exe.toLowerCase().includes(filter),
      )
      const lines = list.slice(0, 60).map((item) => {
        const operable = this.isOperable(item)
        return (
          `- ${item.windowId} ${item.foreground ? '[前台] ' : ''}「${item.title}」 ` +
          `${normalizeExeName(item.exe)} · ${item.bounds.width}×${item.bounds.height}` +
          `${item.minimized ? ' · 最小化' : item.maximized ? ' · 最大化' : ''}` +
          `${operable ? '' : ' · 不可操作'}`
        )
      })
      return {
        content:
          (lines.length === 0
            ? '没有匹配的窗口。'
            : `窗口（${lines.length}）：\n${lines.join('\n')}`) +
          '\n受保护 / 禁止的应用标为「不可操作」，对其执行动作会被拒绝。',
        summary: `列出 ${lines.length} 个窗口`,
      }
    }
    if (input.action === 'active') {
      this.options.service.noteStep(input.sessionId, 'window.active', '正在查看前台窗口')
      const foreground = await this.foregroundWindow()
      return {
        content:
          foreground === undefined
            ? '读取前台窗口失败。'
            : `前台窗口：「${foreground.title}」（${normalizeExeName(foreground.exe)}，id ${foreground.windowId}），` +
              `矩形 ${foreground.bounds.x},${foreground.bounds.y} ${foreground.bounds.width}×${foreground.bounds.height}。`,
        summary: '读取前台窗口',
      }
    }
    if (input.action === 'launch') {
      const command = input.command ?? ''
      if (!isLaunchableCommand(command)) {
        throw new Error('launch 只接受 .exe / .com 可执行文件（不接受脚本 / 批处理）')
      }
      const name = normalizeExeName(command)
      this.assertAppName(name)
      const args = input.args ?? []
      const attempts = this.launchAttempts.get(input.sessionId)
      const lastAttempt = attempts?.get(launchKey(command, args))
      const plan = planLaunch({
        command,
        args,
        windows,
        ...(lastAttempt === undefined ? {} : { lastAttempt }),
        now: Date.now(),
      })
      if (plan.kind === 'cooldown') {
        return {
          content:
            `刚刚已尝试启动「${name}」（${plan.seconds} 秒内冷却）；可能仍在加载，` +
            '先 computer_screenshot 确认，**不要重复 launch**。',
          summary: `等待 ${name} 启动`,
        }
      }
      if (plan.kind === 'reuse') {
        const reused = plan.window
        this.options.service.beginAction(
          input.sessionId,
          'window.launch',
          `正在切换到已运行的「${name}」`,
        )
        let restored = false
        if (reused.minimized) {
          try {
            await this.options.host.request('window_show', {
              windowId: reused.windowId,
              state: 'restore',
            })
            restored = true
          } catch {
            // 还原失败仍继续尝试激活；失败会落进 activationFailed
          }
        }
        let activationFailed = false
        try {
          const activation = await this.options.host.request<{
            activated?: boolean
            message?: string
          }>('window_activate', { windowId: reused.windowId })
          activationFailed = activation?.activated !== true
        } catch {
          activationFailed = true
        }
        return describeLaunchResult({
          name,
          reused,
          ...(restored ? { restored: true } : {}),
          ...(activationFailed ? { activationFailed: true } : {}),
        })
      }

      this.options.service.beginAction(
        input.sessionId,
        'window.launch',
        describeWindowAction({ action: 'launch', title: name }),
      )
      // 启动失败（路径 / 权限）直接回错误，不记冷却：模型可能只是命令写错，
      // 换对路径后应当立刻允许重试。
      const result = await this.options.host.request<LaunchHostResult>('app_launch', {
        command,
        args,
      })
      const launchedWindow = result?.window ?? undefined
      if (launchedWindow === undefined) {
        this.noteLaunchAttempt(input.sessionId, launchKey(command, args))
      } else {
        this.clearLaunchAttempt(input.sessionId, launchKey(command, args))
      }
      return describeLaunchResult({ name, result })
    }

    const target = this.resolveWindow(windows, input)
    this.assertOperable(target)
    const title = target.title
    if (input.action === 'activate') {
      this.options.service.beginAction(
        input.sessionId,
        'window.activate',
        describeWindowAction({ action: 'activate', title }),
      )
      const activation = await this.options.host.request<{ activated?: boolean; message?: string }>(
        'window_activate',
        { windowId: target.windowId },
      )
      if (activation?.activated !== true) {
        throw new Error(`${describeActivateFailure(activation?.message)}（E_CU_ACTIVATE_FAILED）`)
      }
      return { content: `已激活「${title}」。`, summary: '已激活窗口' }
    }
    if (input.action === 'move' || input.action === 'resize') {
      const view = this.views.get(input.sessionId)
      const space = input.space ?? 'image'
      if (
        space !== 'screen' &&
        (input.x !== undefined ||
          input.y !== undefined ||
          input.width !== undefined ||
          input.height !== undefined)
      ) {
        this.assertViewFresh(view)
      }
      const x =
        input.x === undefined ? target.bounds.x : this.scalarToPhysical(view, space, input.x, 'x')
      const y =
        input.y === undefined ? target.bounds.y : this.scalarToPhysical(view, space, input.y, 'y')
      const width =
        input.width === undefined
          ? target.bounds.width
          : Math.max(1, Math.round(this.sizeToPhysical(view, space, input.width, 'x')))
      const height =
        input.height === undefined
          ? target.bounds.height
          : Math.max(1, Math.round(this.sizeToPhysical(view, space, input.height, 'y')))
      this.options.service.beginAction(
        input.sessionId,
        `window.${input.action}`,
        describeWindowAction({ action: input.action, title }),
      )
      const updated = await this.options.host.request<WindowInfo>('window_move', {
        windowId: target.windowId,
        x: Math.round(x),
        y: Math.round(y),
        width,
        height,
      })
      return {
        content:
          `窗口「${title}」现在位于 (${updated?.bounds.x ?? Math.round(x)}, ${updated?.bounds.y ?? Math.round(y)})，` +
          `尺寸 ${updated?.bounds.width ?? width}×${updated?.bounds.height ?? height}。`,
        summary: input.action === 'move' ? '窗口已移动' : '窗口已缩放',
      }
    }
    if (input.action === 'minimize' || input.action === 'maximize' || input.action === 'restore') {
      this.options.service.beginAction(
        input.sessionId,
        `window.${input.action}`,
        describeWindowAction({ action: input.action, title }),
      )
      const updated = await this.options.host.request<WindowInfo>('window_show', {
        windowId: target.windowId,
        state: input.action,
      })
      return {
        content:
          `已${input.action === 'minimize' ? '最小化' : input.action === 'maximize' ? '最大化' : '还原'}「${title}」。` +
          (updated === undefined ? '' : ` 当前 ${updated.bounds.width}×${updated.bounds.height}。`),
        summary: '窗口状态已切换',
      }
    }
    if (input.action === 'close') {
      this.options.service.beginAction(
        input.sessionId,
        'window.close',
        describeWindowAction({ action: 'close', title }),
      )
      await this.options.host.request('window_close', { windowId: target.windowId })
      return {
        content: `已向「${title}」发送关闭请求（WM_CLOSE）；有未保存内容时应用可能弹出确认框。`,
        summary: '已请求关闭窗口',
      }
    }
    throw new Error(`不支持的窗口动作 ${input.action}`)
  }

  async ui(input: ComputerUiInput): Promise<ToolResult> {
    this.options.service.ensureCallAllowed(input.sessionId)
    this.noteNext(input)
    await this.options.host.ensureReady()
    // 传了 windowId 就直接按 HWND 取（快速设置这类弹出窗不在 window_list 里，不能因此拒绝）；
    // 没传才取前台。两条路都失败时给出能区分的错误文案。
    const target =
      input.windowId === undefined
        ? await this.foregroundWindow()
        : await this.windowInfo(input.windowId)
    if (target === undefined) {
      throw new Error(
        input.windowId === undefined
          ? '读取前台窗口失败；请传 windowId（来自 computer_window list / active）。'
          : `找不到窗口 ${input.windowId}；请重新 computer_window list / active 确认 id。`,
      )
    }
    this.assertOperable(target)
    const windowId = target.windowId
    if (input.action === 'tree') {
      this.options.service.noteStep(input.sessionId, 'ui.tree', '正在读取界面控件')
      const tree = await this.options.host.request<{
        nodes: Array<Record<string, unknown>>
        truncated: boolean
      }>('ui_tree', {
        windowId,
        maxDepth: input.maxDepth ?? 8,
        maxNodes: input.maxNodes ?? 1200,
      })
      const lines = (tree?.nodes ?? [])
        .slice(0, 200)
        .map((node) => formatUiNode(node, this.views.get(input.sessionId)))
      return {
        content:
          `控件树（${lines.length} 个节点${tree?.truncated === true ? '，已截断' : ''}）：\n` +
          (lines.length === 0 ? '（空）' : lines.join('\n')),
        summary: `读取控件树（${lines.length}）`,
      }
    }
    if (input.action === 'find') {
      this.options.service.noteStep(input.sessionId, 'ui.find', '正在查找界面控件')
      const result = await this.options.host.request<{
        candidates: Array<Record<string, unknown>>
      }>('ui_find', {
        windowId,
        nameContains: input.nameContains ?? '',
        role: input.role ?? '',
      })
      const candidates = result?.candidates ?? []
      const lines = candidates.map(
        (node, index) => `${index + 1}. ${formatUiNode(node, this.views.get(input.sessionId))}`,
      )
      return {
        content:
          (lines.length === 0 ? '没有匹配的控件。' : `候选控件：\n${lines.join('\n')}`) +
          '\n用 computer_ui action=invoke/set_value/focus 并传 path 操作。',
        summary: `找到 ${lines.length} 个控件`,
      }
    }
    if (input.path === undefined || input.path.trim() === '') {
      throw new Error(`${input.action} 需要 path（先 tree / find）`)
    }
    this.options.service.beginAction(
      input.sessionId,
      `ui.${input.action}`,
      describeUiAction({ action: input.action }),
    )
    const node = await this.options.host.request<Record<string, unknown>>('ui_action', {
      windowId,
      path: input.path,
      action: input.action,
      value: input.value,
    })
    return {
      content:
        `已对控件 ${input.path} 执行 ${input.action}。` +
        (node === undefined ? '' : ` ${formatUiNode(node, this.views.get(input.sessionId))}`),
      summary: `控件 ${input.action} 完成`,
    }
  }

  async wait(input: ComputerWaitInput): Promise<ToolResult> {
    this.options.service.ensureCallAllowed(input.sessionId)
    this.noteNext(input)
    const seconds = Math.max(0, Math.min(30, input.seconds ?? 1))
    this.options.service.noteStep(input.sessionId, 'wait', `正在等待 ${seconds} 秒`)
    await sleep(seconds * 1000, input.signal)
    return { content: `已等待 ${seconds} 秒。`, summary: `等待 ${seconds}s` }
  }

  /**
   * Agent 主动建立 Computer Use 授权（`computer_start`，v39 优化）。
   *
   * 与用户敲 `/computer` 走**同一条** `service.start()`：只建立内存授权，不建浮层、
   * 不播光标动画（「授权 ≠ 开始操作」）。真正的门控（总开关 / 平台 / 视觉 / 只读档 /
   * 会话资格 / 同时一个会话）全部在 service 里，这里只转发 + 记审计理由。
   */
  async start(input: ComputerStartInput): Promise<ToolResult> {
    await this.options.service.start(input.sessionId)
    const reason = input.reason?.trim()
    if (reason !== undefined && reason !== '') {
      this.options.logger.info('Agent 主动请求 Computer Use 授权', {
        sessionId: input.sessionId,
        reason: reason.slice(0, 200),
      })
    }
    // 先把「屏幕有多大」告诉模型：规划点击位置 / 窗口摆放时不必为了尺寸先截一张图。
    // 只读几何，不碰输入宿主，也不建浮层（授权 ≠ 开始操作）。
    const displays = listDisplayGeometries()
    const displayText =
      displays.length === 0
        ? '显示器：读取失败，请用 computer_screenshot 重新确认。'
        : [
            `显示器（${displays.length} 块）：`,
            ...displays.map((item) => {
              const primary = item.id === primaryDisplayId() ? '（主屏）' : ''
              return (
                `- id ${item.id}${primary}：物理 ${item.physicalSize.width}×${item.physicalSize.height}，` +
                `缩放 ${Math.round(item.scaleFactor * 100)}%，左上角物理 (${item.physicalOrigin.x}, ${item.physicalOrigin.y})`
              )
            }),
          ].join('\n')
    return {
      content: [
        '已获得 Computer Use 授权（授权 ≠ 开始操作，浮层尚未显示）。',
        displayText,
        '动作工具（computer_screenshot / computer_mouse / computer_keyboard / computer_window / ' +
          'computer_ui / computer_wait）**在同一次请求的下一轮立即可用**；' +
          '不要在下一轮之前、也不要和本工具放在同一轮里发动作调用。',
        '下一轮先想好 2–4 步，用 computer_screenshot 截图建立坐标空间，再按顺序批量下发动作；' +
          '每个动作**必须填 next**（一句话的下一步计划，过程面板会显示；漏填时系统用下一条动作补）。',
        '启动应用前先 computer_window list 查同一 exe 是否已运行；已运行就 activate / restore，' +
          '**不要重复 launch**。launch 返回「' +
          `${LAUNCH_WINDOW_WAIT_MS / 1000} 秒内没有检测到新窗口」时也不代表失败：先截图确认，` +
          '不要再次 launch（可能是单实例应用把窗口交给了现有进程）。',
        '小控件定位：先用 computer_ui find，或用 windowId + maxWidth=2560 放大截图后再坐标点击；' +
          '截图后窗口被移动 / 缩放 / 显示器变化，旧坐标作废，要重新截图。',
        '不要每个动作后都 computer_wait；桌面交互完成后必须调用 computer_stop 退出（Aurora 会回到前台）。',
      ].join('\n'),
      summary: '已获得 Computer Use 授权',
    }
  }

  /**
   * Agent 主动退出操作模式（`computer_stop`，2026-10-31）。
   *
   * 与用户点停止走**同一条** `service.stop()`：撤销授权、收起浮层与过程面板、清坐标空间。
   * 这里不做 `ensureCallAllowed`：已经停下（或从未授权）时再调一次应当是**幂等成功**，
   * 不该给模型一个误导性的错误。
   */
  async stop(input: ComputerStopInput): Promise<ToolResult> {
    if (!this.options.service.isAuthorized(input.sessionId)) {
      return { content: '当前会话没有 Computer Use 授权，无需退出。', summary: '未在操作模式' }
    }
    this.options.service.stop('agent', input.sessionId)
    return {
      content:
        '已退出 Computer Use 操作模式：授权已撤销，屏幕上的流光与过程面板已收起；Aurora 已回到前台。',
      summary: '已退出操作模式',
    }
  }

  /** 设置页 / 诊断用：列出窗口（不执行动作）。 */
  async apps(): Promise<
    Array<{
      windowId: string
      title: string
      exe: string
      pid: number
      foreground: boolean
      operable: boolean
    }>
  > {
    await this.options.host.ensureReady()
    const windows = await this.windowList()
    return windows.slice(0, 80).map((item) => ({
      windowId: item.windowId,
      title: item.title,
      exe: normalizeExeName(item.exe),
      pid: item.pid,
      foreground: item.foreground,
      operable: this.isOperable(item),
    }))
  }

  clearSession(sessionId: string): void {
    this.views.delete(sessionId)
    this.launchAttempts.delete(sessionId)
  }

  private async windowList(): Promise<WindowInfo[]> {
    const result = await this.options.host.request<{ windows: WindowInfo[] }>('window_list', {})
    return result?.windows ?? []
  }

  /** 按 HWND 直接查一个窗口（弹出窗 / 目标 bounds 校验用）；查不到返回 undefined。 */
  private async windowInfo(windowId: string): Promise<WindowInfo | undefined> {
    try {
      return await this.options.host.request<WindowInfo>('window_info', { windowId })
    } catch {
      return undefined
    }
  }

  private noteLaunchAttempt(sessionId: string, key: string): void {
    let attempts = this.launchAttempts.get(sessionId)
    if (attempts === undefined) {
      attempts = new Map()
      this.launchAttempts.set(sessionId, attempts)
    }
    attempts.set(key, { key, at: Date.now() })
  }

  private clearLaunchAttempt(sessionId: string, key: string): void {
    const attempts = this.launchAttempts.get(sessionId)
    if (attempts === undefined) return
    attempts.delete(key)
    if (attempts.size === 0) this.launchAttempts.delete(sessionId)
  }

  private async pickDisplay(
    displays: DisplayGeometry[],
    input: ComputerScreenshotInput,
    target: WindowInfo | undefined,
  ): Promise<DisplayGeometry> {
    if (input.displayId !== undefined) {
      const found = displays.find((item) => item.id === input.displayId)
      if (found === undefined) throw new Error(`显示器 ${input.displayId} 不存在`)
      return found
    }
    const mode = input.display ?? 'auto'
    if (mode === 'primary') {
      return displays.find((item) => item.id === primaryDisplayId()) ?? displays[0]!
    }
    if (mode === 'cursor') {
      return displayAtPoint(displays, this.cursorDipPoint(), primaryDisplayId()) ?? displays[0]!
    }
    const foreground = target ?? (await this.foregroundWindow())
    if (mode === 'foreground' || mode === 'auto') {
      if (foreground !== undefined && (mode === 'foreground' || !this.isProtected(foreground))) {
        const center = {
          x: foreground.bounds.x + foreground.bounds.width / 2,
          y: foreground.bounds.y + foreground.bounds.height / 2,
        }
        // 窗口 rect 是物理像素，display.bounds 是 DIP —— 必须用物理矩形命中。
        const display = displayAtPhysicalPoint(displays, center, primaryDisplayId())
        if (display !== undefined) return display
      }
      if (mode === 'foreground') throw new Error('读取前台窗口所在显示器失败')
    }
    return displayAtPoint(displays, this.cursorDipPoint(), primaryDisplayId()) ?? displays[0]!
  }

  private async foregroundWindow(): Promise<WindowInfo | undefined> {
    try {
      const active = await this.options.host.request<WindowInfo | null>('window_active')
      if (active != null) return active
    } catch {
      // window_active 偶发拿不到（前台切换瞬间 / 系统弹层），回落到列表里的 foreground 项
    }
    try {
      const windows = await this.windowList()
      return windows.find((item) => item.foreground)
    } catch {
      return undefined
    }
  }

  private cursorDipPoint(): Point {
    try {
      return screen.getCursorScreenPoint()
    } catch {
      return { x: 0, y: 0 }
    }
  }

  private toPhysical(
    view: ScreenView | undefined,
    space: ComputerMouseInput['space'],
    point: Point,
  ): Point {
    if (space === 'screen') return point
    if (view === undefined) {
      throw new Error('尚未截图，坐标空间未建立；请先 computer_screenshot（或显式 space:"screen"）')
    }
    return imageToPhysical(view, point)
  }

  private scalarToPhysical(
    view: ScreenView | undefined,
    space: 'image' | 'screen' | undefined,
    value: number,
    axis: 'x' | 'y',
  ): number {
    if (space === 'screen') return value
    if (view === undefined) throw new Error('尚未截图；窗口坐标请先截图，或显式 space:"screen"')
    return axis === 'x' ? view.origin.x + value / view.scaleX : view.origin.y + value / view.scaleY
  }

  private sizeToPhysical(
    view: ScreenView | undefined,
    space: 'image' | 'screen' | undefined,
    value: number,
    axis: 'x' | 'y',
  ): number {
    if (space === 'screen') return value
    if (view === undefined) throw new Error('尚未截图；窗口尺寸请先截图，或显式 space:"screen"')
    return axis === 'x' ? value / view.scaleX : value / view.scaleY
  }

  /** 用户关掉虚拟光标时不画动画，也就不该为「看不见的停顿」多等一程。 */
  private cursorSettleMs(): number {
    return this.options.settings().computerUse.showVirtualCursor === false ? 0 : CURSOR_SETTLE_MS
  }

  /**
   * 有效逐字间隔（v39.1）：配置值 / 模型入参仍然是**上限**，总延迟另有封顶。
   * 目标是「长文本不要变成几秒的静默等待」，而不是取消慢应用需要的逐字节奏。
   */
  private typingDelayMs(configured: number, length: number): number {
    if (length <= 0) return 0
    const budgeted = Math.floor(TYPE_TOTAL_DELAY_BUDGET_MS / length)
    return Math.max(0, Math.min(Math.round(configured), budgeted))
  }

  /**
   * 把动作参数里的 `next` 交给会话层（v39.1）：只进过程面板 / 状态条的「下一步」。
   *
   * 缺省时发空计划（清空上一行）——留着上一步的计划会让用户以为「下一步」还是那个
   * 已经做完的动作。展示层的问题不该让系统动作失败，因此这里兜一层 warn。
   */
  private noteNext(input: { sessionId: string; next?: string }): void {
    try {
      this.options.service.noteNextStep(input.sessionId, input.next)
    } catch (error) {
      this.options.logger.warn('Computer Use 下一步计划记录失败', { error: String(error) })
    }
  }

  /**
   * 把**虚拟光标**滑到物理点对应的显示器内 DIP 落点（「先移动光标，再点击」的下半句）。
   *
   * 物理 → DIP 走 `screen.screenToDipPoint`（多屏不同缩放下也准）；找不到显示器就返回
   * `undefined`，调用方据此不画涟漪 —— 宁可少一圈特效，也不在错误位置画。
   */
  private async glideCursor(
    physical: Point,
    durationMs: number,
  ): Promise<{ displayId: number; x: number; y: number } | undefined> {
    const dip = this.dipOf(physical)
    if (dip === undefined) return undefined
    await this.options.service.moveCursor({ ...dip, durationMs })
    return dip
  }

  /** 物理点 → 所在显示器的 id + 显示器内 DIP 坐标（浮层窗口的坐标空间）。 */
  private dipOf(physical: Point): { displayId: number; x: number; y: number } | undefined {
    let dip: Point
    try {
      dip = physicalToDip(physical)
    } catch {
      return undefined
    }
    const display = listDisplayGeometries().find((item) => rectContains(item.bounds, dip))
    if (display === undefined) return undefined
    return { displayId: display.id, x: dip.x - display.bounds.x, y: dip.y - display.bounds.y }
  }

  private async movePointer(point: Point, durationMs: number): Promise<Point> {
    const requested = { x: Math.round(point.x), y: Math.round(point.y) }
    const first = await this.options.host.request<CursorPoint>('mouse_move', {
      ...requested,
      durationMs,
    })
    if (first !== undefined && distance(first, requested) <= 2) return first
    const second = await this.options.host.request<CursorPoint>('mouse_move', {
      ...requested,
      durationMs: 0,
    })
    if (second === undefined || distance(second, requested) > 2) {
      throw new Error('指针没有落到目标位置（可能被系统 / 其他程序拦截），已取消后续动作。')
    }
    return second
  }

  /** 图片坐标只对最近截图的显示器几何成立；分辨率 / 缩放 / 显示器增删后必须重新截图。 */
  private assertViewFresh(view: ScreenView | undefined): void {
    if (view === undefined) return
    const display = listDisplayGeometries().find((item) => item.id === view.displayId)
    if (display === undefined || !viewMatchesDisplay(view, display)) {
      throw new Error(
        '显示器几何已变化（分辨率 / 缩放 / 显示器增删），最近截图的坐标空间已失效；' +
          '请重新 computer_screenshot。（E_CU_VIEW_STALE）',
      )
    }
  }

  /**
   * 目标匹配：同一窗口 / 同一 pid / **同一 exe** 都算同一目标。
   *
   * 多进程应用（微信 / 浏览器）会为同一个应用开不同 pid 的窗口；只比 pid 会把合法点击误判成
   * 「目标被换掉」。真正要拒绝的是「换成别的应用」。
   */
  private isSameTarget(view: ScreenView | undefined, hit: WindowInfo): boolean {
    if (view === undefined) return true
    if (view.targetWindowId === undefined && view.targetPid === undefined) return true
    if (view.targetWindowId !== undefined && hit.windowId === view.targetWindowId) return true
    if (view.targetPid !== undefined && hit.pid === view.targetPid) return true
    if (view.targetExe !== undefined && normalizeExeName(hit.exe) === view.targetExe) return true
    return false
  }

  private async assertTargetAt(view: ScreenView | undefined, point: Point): Promise<void> {
    // 截图后目标窗口被移动 / 缩放 / 最小化 → 旧图片坐标不再对应原来的控件位置。
    if (
      view !== undefined &&
      view.targetWindowId !== undefined &&
      view.targetBounds !== undefined
    ) {
      const current = await this.windowInfo(view.targetWindowId)
      if (current !== undefined) {
        if (current.minimized) {
          throw new Error(
            '目标窗口在截图后已最小化，旧坐标失效；请先 computer_window restore 并重新截图。' +
              '（E_CU_TARGET_MOVED）',
          )
        }
        if (targetBoundsMoved(view.targetBounds, current.bounds, TARGET_BOUNDS_TOLERANCE_PX)) {
          throw new Error(
            '目标窗口在截图后已移动 / 缩放，旧图片坐标不再对应原来的控件位置；' +
              '请重新 computer_screenshot，不要重试同一个坐标。（E_CU_TARGET_MOVED）',
          )
        }
      }
    }
    const hit = await this.options.host.request<WindowInfo>('hit_test', {
      x: Math.round(point.x),
      y: Math.round(point.y),
    })
    if (hit === undefined || hit.windowId === '0') throw new Error('目标点下没有窗口。')
    this.assertOperable(hit)
    if (!this.isSameTarget(view, hit)) {
      throw new Error(
        `目标点当前属于「${hit.title}」(${normalizeExeName(hit.exe)})，与最近截图的目标` +
          `（${view?.targetExe ?? '未知'}）不是同一个应用；已取消点击。` +
          '请重新 computer_screenshot 确认目标窗口，不要重试同一个坐标。（E_CU_TARGET_CHANGED）',
      )
    }
  }

  private async withModifiers(
    modifiers: string[] | undefined,
    run: () => Promise<void>,
  ): Promise<void> {
    const keys = modifiers ?? []
    try {
      for (const key of keys) await this.options.host.request('key_down', { key })
      await run()
    } finally {
      for (const key of [...keys].reverse()) {
        try {
          await this.options.host.request('key_up', { key })
        } catch {
          // 释放失败不掩盖主错误；宿主退出前还有 release_all
        }
      }
    }
  }

  private isProtected(window: WindowInfo): boolean {
    return isProtectedWindow({
      exe: window.exe,
      className: window.className,
      pid: window.pid,
      selfPid: this.options.selfPid ?? process.pid,
    })
  }

  private isOperable(window: WindowInfo): boolean {
    return isWindowOperable({
      exe: window.exe,
      className: window.className,
      pid: window.pid,
      selfPid: this.options.selfPid ?? process.pid,
      policy: this.options.settings().computerUse,
    })
  }

  private assertOperable(window: WindowInfo): void {
    if (this.isProtected(window)) {
      throw new Error(
        `「${window.title}」是受保护窗口（Aurora / 终端 / 系统安全界面），不允许操作。`,
      )
    }
    if (!isAppAllowed(window.exe, this.options.settings().computerUse)) {
      throw new Error(
        `应用 ${normalizeExeName(window.exe)} 不在允许名单（或在禁止名单）中，已拒绝操作。`,
      )
    }
  }

  private assertAppName(name: string): void {
    if (
      isProtectedWindow({ exe: name, selfPid: this.options.selfPid ?? process.pid }) ||
      !isAppAllowed(name, this.options.settings().computerUse)
    ) {
      throw new Error(`应用 ${name} 受保护或被用户禁止，不能启动。`)
    }
  }

  private resolveWindow(windows: WindowInfo[], input: ComputerWindowInput): WindowInfo {
    if (input.windowId !== undefined) {
      const found = findWindow(windows, input.windowId)
      if (found === undefined) throw new Error(`找不到窗口 ${input.windowId}`)
      return found
    }
    if (input.titleMatch !== undefined && input.titleMatch.trim() !== '') {
      const needle = input.titleMatch.trim().toLowerCase()
      const matches = windows.filter(
        (item) =>
          item.title.toLowerCase().includes(needle) || item.exe.toLowerCase().includes(needle),
      )
      if (matches.length === 0) throw new Error(`没有标题 / 进程包含「${input.titleMatch}」的窗口`)
      if (matches.length > 1) {
        const list = matches
          .slice(0, 8)
          .map((item) => `${item.windowId}「${item.title}」`)
          .join('；')
        throw new Error(`titleMatch 匹配到多个窗口，请改用 windowId：${list}`)
      }
      return matches[0]!
    }
    const foreground = windows.find((item) => item.foreground)
    if (foreground === undefined) throw new Error('没有前台窗口，请传 windowId 或 titleMatch')
    return foreground
  }
}

function findWindow(windows: WindowInfo[], windowId: string): WindowInfo | undefined {
  const normalized = windowId.trim().toLowerCase()
  return windows.find((item) => item.windowId.toLowerCase() === normalized)
}

function requirePoint(x: number | undefined, y: number | undefined): void {
  if (x === undefined || y === undefined) throw new Error('需要 x / y 坐标（先截图后用图片像素）')
}

function distance(left: Point, right: Point): number {
  return Math.hypot(left.x - right.x, left.y - right.y)
}

function formatUiNode(node: Record<string, unknown>, view: ScreenView | undefined): string {
  const path = String(node['path'] ?? '')
  const role = String(node['role'] ?? '')
  const name = String(node['name'] ?? '')
  const automationId = String(node['automationId'] ?? '')
  const bounds = node['bounds'] as
    { x?: number; y?: number; width?: number; height?: number } | undefined
  const center = node['center'] as { x?: number; y?: number } | undefined
  const image =
    view !== undefined && center?.x !== undefined && center.y !== undefined
      ? physicalToImage(view, { x: center.x, y: center.y })
      : undefined
  const rect =
    bounds === undefined
      ? ''
      : ` rect=${Math.round(bounds.x ?? 0)},${Math.round(bounds.y ?? 0)},${Math.round(bounds.width ?? 0)}x${Math.round(bounds.height ?? 0)}`
  const imageText =
    image === undefined ? '' : ` image=(${Math.round(image.x)},${Math.round(image.y)})`
  return `path=${path} ${role}${name === '' ? '' : ` "${name}"`}${automationId === '' ? '' : ` #${automationId}`}${rect}${imageText}`
}

function toolError(code: string, message: string): ToolResult {
  return { content: `${message}（${code}）`, isError: true, summary: 'Computer Use 失败' }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('操作已取消'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('操作已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 让 TypeScript 知道这个是端口实现的导出别名（装配层按接口注入）。 */
export type { ComputerUsePort }
