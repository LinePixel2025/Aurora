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
  displayAtPoint,
  imageToPhysical,
  physicalToImage,
  rectContains,
  type DisplayGeometry,
  type Point,
  type ScreenView,
} from './coordinates.js'
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
import { captureDisplay, listDisplayGeometries, primaryDisplayId } from './screenshots.js'

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

  constructor(options: ComputerUsePortOptions) {
    this.options = options
  }

  async screenshot(input: ComputerScreenshotInput): Promise<ToolResult> {
    this.options.service.ensureCallAllowed(input.sessionId)
    await this.options.host.ensureReady()
    const displays = listDisplayGeometries()
    const windows = await this.windowList()
    const foreground = windows.find((item) => item.foreground)
    const requested = input.windowId === undefined ? undefined : findWindow(windows, input.windowId)
    if (input.windowId !== undefined && requested === undefined) {
      return toolError(
        'E_CU_WINDOW_NOT_FOUND',
        `找不到窗口 ${input.windowId}，请先用 computer_window list。`,
      )
    }
    if (requested !== undefined) this.assertOperable(requested)
    if (requested?.minimized === true) {
      return toolError('E_CU_WINDOW_MINIMIZED', '目标窗口已最小化，请先 computer_window restore。')
    }

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
      ...(target === undefined ? {} : { targetWindowId: target.windowId, targetPid: target.pid }),
    })
    this.views.set(input.sessionId, view)
    const cursor = await this.options.host.request<CursorPoint>('cursor_get')
    const cursorImage = physicalToImage(view, cursor)
    const targetText =
      target === undefined
        ? '前台窗口：读取失败（仍可截图，但点击前会重新做命中测试）'
        : `前台窗口：「${target.title}」（${normalizeExeName(target.exe)}，id ${target.windowId}）`
    const text = [
      `截图：显示器 ${display.id}，物理 ${display.physicalSize.width}×${display.physicalSize.height}，` +
        `图片 ${captured.imageWidth}×${captured.imageHeight}（坐标空间 = 图片像素）。`,
      targetText,
      `鼠标：物理 (${Math.round(cursor.x)}, ${Math.round(cursor.y)}) → 图片 (${Math.round(cursorImage.x)}, ${Math.round(cursorImage.y)})。`,
      `换算：physical = origin(${view.origin.x}, ${view.origin.y}) + 图片像素 / scale(${view.scaleX.toFixed(4)}, ${view.scaleY.toFixed(4)})。` +
        ' computer_mouse 默认按图片像素给坐标。',
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
      const landed = await this.movePointer(
        start,
        this.options.settings().computerUse.moveDurationMs,
      )
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
      await this.movePointer(start, 0)
      await this.withModifiers(input.modifiers, async () => {
        const response = await this.options.host.request<CursorPoint>('mouse_click', {
          button,
          count,
        })
        if (response === undefined) throw new Error('点击没有回执')
      })
      if (view !== undefined) {
        this.options.service.noteClick({
          displayId: view.displayId,
          x: input.x ?? 0,
          y: input.y ?? 0,
          button,
        })
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
      await this.withModifiers(input.modifiers, async () => {
        await this.options.host.request('mouse_drag', {
          x: Math.round(start.x),
          y: Math.round(start.y),
          toX: Math.round(end.x),
          toY: Math.round(end.y),
          button: input.button ?? 'left',
          durationMs: this.options.settings().computerUse.moveDurationMs * 2,
        })
      })
      return {
        content: `已从物理 (${Math.round(start.x)}, ${Math.round(start.y)}) 拖到 (${Math.round(end.x)}, ${Math.round(end.y)})。`,
        summary: '拖拽完成',
      }
    }

    if (input.action === 'scroll') {
      const at = start ?? (await this.cursorDipPoint())
      await this.assertTargetAt(view, at)
      this.options.service.beginAction(
        input.sessionId,
        'mouse.scroll',
        describeMouseAction({ action: 'scroll' }),
        { displayId: view?.displayId, x: input.x, y: input.y },
      )
      if (start !== undefined) await this.movePointer(start, 0)
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
    await this.options.host.ensureReady()
    const view = this.views.get(input.sessionId)
    const foreground = await this.options.host.request<WindowInfo>('window_active')
    if (foreground === undefined) {
      throw new Error('读取前台窗口失败，已拒绝键盘输入。')
    }
    this.assertOperable(foreground)
    if (view?.targetPid !== undefined && foreground.pid !== view.targetPid) {
      throw new Error(
        `前台窗口已变成「${foreground.title}」(${normalizeExeName(foreground.exe)})，` +
          '与最近截图的目标不一致；已拒绝输入。请重新截图并激活目标窗口。',
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
        delayMs: input.delayMs ?? this.options.settings().computerUse.typingDelayMs,
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
    await this.options.host.ensureReady()
    const windows = await this.windowList()
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
      const foreground = windows.find((item) => item.foreground)
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
      this.options.service.beginAction(
        input.sessionId,
        'window.launch',
        describeWindowAction({ action: 'launch', title: name }),
      )
      const result = await this.options.host.request<{
        pid: number
        process: string
        window?: WindowInfo
      }>('app_launch', { command, args: input.args ?? [] })
      return {
        content:
          `已启动 ${result?.process ?? name}（pid ${result?.pid ?? '?'}）` +
          (result?.window === undefined
            ? '；5 秒内未检测到窗口，可能需要等待或手动激活。'
            : `；窗口「${result.window.title}」（id ${result.window.windowId}）。`),
        summary: `已启动 ${result?.process ?? name}`,
      }
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
      const foreground = await this.options.host.request<WindowInfo>('window_activate', {
        windowId: target.windowId,
      })
      if (foreground === undefined || foreground.windowId !== target.windowId) {
        throw new Error('系统拒绝把目标窗口切到前台（可能是前台锁 / 权限不足）。')
      }
      return { content: `已激活「${title}」。`, summary: '已激活窗口' }
    }
    if (input.action === 'move' || input.action === 'resize') {
      const view = this.views.get(input.sessionId)
      const space = input.space ?? 'image'
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
    await this.options.host.ensureReady()
    const windows = await this.windowList()
    const target =
      input.windowId === undefined
        ? windows.find((item) => item.foreground)
        : findWindow(windows, input.windowId)
    if (target === undefined) throw new Error('读取前台窗口失败，请先传 windowId。')
    this.assertOperable(target)
    const windowId = target?.windowId
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
    const seconds = Math.max(0, Math.min(30, input.seconds ?? 1))
    this.options.service.noteStep(input.sessionId, 'wait', `正在等待 ${seconds} 秒`)
    await sleep(seconds * 1000, input.signal)
    return { content: `已等待 ${seconds} 秒。`, summary: `等待 ${seconds}s` }
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
    this.options.service.stop('agent')
    return {
      content: '已退出 Computer Use 操作模式：授权已撤销，屏幕上的流光与过程面板已收起。',
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
  }

  private async windowList(): Promise<WindowInfo[]> {
    const result = await this.options.host.request<{ windows: WindowInfo[] }>('window_list', {})
    return result?.windows ?? []
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
        const display = displays.find((item) => rectContains(item.bounds, center))
        if (display !== undefined) return display
      }
      if (mode === 'foreground') throw new Error('读取前台窗口所在显示器失败')
    }
    return displayAtPoint(displays, this.cursorDipPoint(), primaryDisplayId()) ?? displays[0]!
  }

  private async foregroundWindow(): Promise<WindowInfo | undefined> {
    try {
      return await this.options.host.request<WindowInfo>('window_active')
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

  private async assertTargetAt(view: ScreenView | undefined, point: Point): Promise<void> {
    const hit = await this.options.host.request<WindowInfo>('hit_test', {
      x: Math.round(point.x),
      y: Math.round(point.y),
    })
    if (hit === undefined || hit.windowId === '0') throw new Error('目标点下没有窗口。')
    this.assertOperable(hit)
    if (view?.targetPid !== undefined && hit.pid !== view.targetPid) {
      throw new Error(
        `目标点当前属于「${hit.title}」(${normalizeExeName(hit.exe)})，与最近截图的目标不一致；` +
          '已取消点击。请重新截图确认要操作哪个窗口。',
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
