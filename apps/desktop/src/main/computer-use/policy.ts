/**
 * Computer Use 应用策略与受保护目标（纯函数，docs/06 §28）。
 *
 * 两层：
 * 1. **硬编码保护目标**（不可配置）：Aurora 自身、终端、任务管理器、UAC / 锁屏等。
 *    这些窗口永远不可被 Agent 点击 / 输入 / 移动 / 关闭 —— 让 Agent 操作终端等于绕过
 *    应用层权限，操作 Aurora 自己等于自我提权。
 * 2. **用户 allow / deny 名单**：按 exe basename 大小写不敏感匹配；deny 优先；
 *    `allowedApps` 为空 = 除保护目标与禁止项外全部允许。
 *
 * 纯函数不 import electron，单测直接喂字符串。
 */

/** 永远不可操作的可执行文件名（basename，小写）。 */
export const PROTECTED_EXE_NAMES: readonly string[] = [
  // Aurora 自身由 pid 判定（见 isProtectedWindow），这里再放一个兜底名
  'aurora.exe',
  // 终端 / shell / 控制台宿主
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'conhost.exe',
  'windowsterminal.exe',
  'wt.exe',
  'openconsole.exe',
  'mintty.exe',
  // 系统安全 / 提权 / 锁屏
  'taskmgr.exe',
  'consent.exe',
  'logonui.exe',
  'lockapp.exe',
  'useraccountcontrol.exe',
  'securityhealthui.exe',
  'sechealthui.exe',
]

/** 永远不可操作的窗口类名（小写；与 exe 名单互补）。 */
export const PROTECTED_CLASS_NAMES: readonly string[] = [
  'consolewindowclass',
  'cascadia_hosting_window_class',
  'windows.ui.core.corewindow',
  '#32770', // 常见系统对话框（含 UAC）
]

export interface AppPolicy {
  allowedApps: readonly string[]
  deniedApps: readonly string[]
}

/** 去掉路径、引号、空白，取小写 basename。 */
export function normalizeExeName(value: string): string {
  const trimmed = value.trim().replace(/^"+|"+$/g, '')
  const parts = trimmed.split(/[\\/]/)
  return (parts[parts.length - 1] ?? '').trim().toLowerCase()
}

/** 保护目标判定：exe 命中、窗口类命中，或 pid 是 Aurora 自己。 */
export function isProtectedWindow(input: {
  exe: string
  className?: string
  pid?: number
  selfPid: number
}): boolean {
  if (input.pid !== undefined && input.pid === input.selfPid) return true
  const exe = normalizeExeName(input.exe)
  if (PROTECTED_EXE_NAMES.includes(exe)) return true
  const className = (input.className ?? '').trim().toLowerCase()
  return className !== '' && PROTECTED_CLASS_NAMES.includes(className)
}

/**
 * 用户名单判定（deny 优先；空 allow = 除 deny / 保护外全部允许）。
 * `exe` 可以是完整路径或 basename；匹配按 basename。
 */
export function isAppAllowed(exe: string, policy: AppPolicy): boolean {
  const name = normalizeExeName(exe)
  if (name === '') return false
  const denied = policy.deniedApps.map(normalizeExeName).filter((item) => item !== '')
  if (denied.includes(name)) return false
  const allowed = policy.allowedApps.map(normalizeExeName).filter((item) => item !== '')
  if (allowed.length === 0) return true
  return allowed.includes(name)
}

/** 组合判定：可操作 = 非保护目标 且 用户名单允许。 */
export function isWindowOperable(input: {
  exe: string
  className?: string
  pid?: number
  selfPid: number
  policy: AppPolicy
}): boolean {
  if (isProtectedWindow(input)) return false
  return isAppAllowed(input.exe, input.policy)
}

/** `launch` 只接受直接可执行文件，拒绝脚本 / 批处理（避免绕过 shell 限制）。 */
export function isLaunchableCommand(command: string): boolean {
  const name = normalizeExeName(command)
  return name.endsWith('.exe') || name.endsWith('.com')
}

/** 窗口是否值得列给模型（不可见 / 无标题 / 工具窗口由调用方再过滤）。 */
export function isListableWindow(input: {
  title: string
  visible: boolean
  width: number
  height: number
}): boolean {
  return input.visible && input.title.trim() !== '' && input.width > 1 && input.height > 1
}

/**
 * 动作摘要（给人看的过程说明，**不是给模型的坐标回执**）。
 *
 * 口径：一律「正在 …」的现在进行时，只说这一步在干什么；**不写坐标 / 矩形 / 尺寸**，
 * 也**绝不包含输入文字 / 剪贴板内容**。坐标只出现在工具结果里，供模型换算使用。
 */
export function describeMouseAction(input: { action: string; button?: string }): string {
  switch (input.action) {
    case 'move':
      return '正在移动鼠标'
    case 'click':
      return `正在${buttonLabel(input.button)}单击`
    case 'double_click':
      return `正在${buttonLabel(input.button)}双击`
    case 'right_click':
      return '正在右键单击'
    case 'middle_click':
      return '正在中键单击'
    case 'drag':
      return '正在拖拽'
    case 'scroll':
      return '正在滚动'
    case 'position':
      return '正在读取鼠标位置'
    default:
      return `正在执行鼠标动作（${input.action}）`
  }
}

export function buttonLabel(button: string | undefined): string {
  if (button === 'right') return '右键'
  if (button === 'middle') return '中键'
  return '左键'
}

export function describeKeyboardAction(input: {
  action: string
  chars?: number
  keys?: readonly string[]
}): string {
  if (input.action === 'type') {
    return `正在输入文字（${Math.max(0, input.chars ?? 0)} 个字符）`
  }
  return `正在按 ${(input.keys ?? []).join('+')}`
}

export function describeWindowAction(input: { action: string; title?: string }): string {
  const title = input.title === undefined ? '' : `「${truncateTitle(input.title)}」`
  switch (input.action) {
    case 'list':
      return '正在查看窗口列表'
    case 'active':
      return '正在查看前台窗口'
    case 'activate':
      return `正在切换到${title}`
    case 'move':
      return `正在移动窗口${title}`
    case 'resize':
      return `正在调整窗口大小${title}`
    case 'minimize':
      return `正在最小化${title}`
    case 'maximize':
      return `正在最大化${title}`
    case 'restore':
      return `正在还原${title}`
    case 'close':
      return `正在关闭${title}`
    case 'launch':
      return `正在启动应用${title}`
    default:
      return `正在执行窗口动作（${input.action}）${title}`
  }
}

export function describeUiAction(input: { action: string; name?: string }): string {
  const target = input.name === undefined ? '' : `「${truncateTitle(input.name)}」`
  switch (input.action) {
    case 'tree':
      return '正在读取界面控件'
    case 'find':
      return '正在查找界面控件'
    case 'invoke':
      return `正在点击控件${target}`
    case 'set_value':
      return `正在填写控件${target}`
    case 'focus':
      return `正在定位控件${target}`
    case 'expand':
      return `正在展开控件${target}`
    case 'collapse':
      return `正在折叠控件${target}`
    case 'select':
      return `正在选择控件${target}`
    default:
      return `正在操作界面控件（${input.action}）${target}`
  }
}

function truncateTitle(title: string): string {
  const trimmed = title.trim()
  return trimmed.length <= 40 ? trimmed : `${trimmed.slice(0, 39)}…`
}
