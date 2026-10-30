/**
 * Computer Use 运行档（docs/06 §5.2 / §28）。
 *
 * 工具是否注册是进程级的（总开关 / 平台 / vision / 权限档），而「这个会话能不能用」
 * 是请求级的：未授权的会话用 `hiddenTools` 把 6 个工具从工具面摘掉，模型在系统提示词、
 * `tools` 数组和循环里都看不到它们。
 *
 * 未授权但功能已启用时只给一句 `runContext`：告诉模型「用户还没授权，请让用户点输入框
 * 的『操作电脑』」，不产生任何调用能力。
 */
import { COMPUTER_USE_TOOL_NAMES, type RunProfile } from '@aurora/agent-core'

export const COMPUTER_USE_RUN_CONTEXT = [
  '## 本次运行：Computer Use',
  '- 用户已在本会话显式授权你操作真实桌面（截屏 + 鼠标 + 键盘 + 窗口）。',
  '- 先 `computer_screenshot` 看屏幕并建立坐标空间；坐标默认按最近截图的像素。',
  '- 优先用 `computer_ui` 的控件名 / 快捷键，不要盲点坐标；每次动作后复核界面。',
  '- 不得操作 Aurora 自身、终端、任务管理器、UAC / 锁屏等受保护窗口。',
  '- 用户手动移动鼠标或键盘时任务继续，不要因此停止或重复已成功的动作。',
].join('\n')

export const COMPUTER_USE_UNAUTHORIZED_CONTEXT = [
  '## 本次运行：Computer Use 未授权',
  '- 用户在设置里启用了 Computer Use，但本会话尚未授权。',
  '- 如果用户要求你操作电脑，请让用户点击输入框工具行的「操作电脑」按钮授权；不要假装已经操作。',
].join('\n')

export interface ComputerUseProfileInput {
  /** 设置里的总开关 */
  enabled: boolean
  /** 当前会话生效模型是否支持图片输入 */
  vision: boolean
  /** 该会话是否持有当前唯一的 Computer Use 授权 */
  authorized: boolean
}

export function computerUseRunProfile(input: ComputerUseProfileInput): RunProfile | undefined {
  if (!input.enabled) return undefined
  // 会话级模型覆盖到非视觉模型时，即使全局 vision 开着也要把工具从本次请求摘掉
  if (!input.vision) {
    return { hiddenTools: COMPUTER_USE_TOOL_NAMES }
  }
  if (!input.authorized) {
    return {
      hiddenTools: COMPUTER_USE_TOOL_NAMES,
      runContext: COMPUTER_USE_UNAUTHORIZED_CONTEXT,
    }
  }
  return { runContext: COMPUTER_USE_RUN_CONTEXT }
}

/**
 * 合并多个运行档：persona 取第一个，runContext 拼接，hiddenTools 取并集，
 * allowedTools 取交集（多个白名单同时存在时按最严格的那个）。
 */
export function composeRunProfiles(
  ...profiles: ReadonlyArray<RunProfile | undefined>
): RunProfile | undefined {
  const present = profiles.filter((profile): profile is RunProfile => profile !== undefined)
  if (present.length === 0) return undefined
  if (present.length === 1) return present[0]

  const persona = present.find((profile) => profile.persona !== undefined)?.persona
  const contexts = present
    .map((profile) => profile.runContext)
    .filter((text): text is string => text !== undefined && text.trim() !== '')
  const hidden = new Set<string>()
  for (const profile of present) {
    for (const name of profile.hiddenTools ?? []) hidden.add(name)
  }
  const allowLists = present
    .map((profile) => profile.allowedTools)
    .filter((list): list is readonly string[] => list !== undefined)
  let allowed: readonly string[] | undefined
  if (allowLists.length > 0) {
    allowed = allowLists.reduce<readonly string[]>((acc, list) => {
      const permitted = new Set(list)
      return acc.filter((name) => permitted.has(name))
    }, allowLists[0] ?? [])
  }

  return {
    ...(persona === undefined ? {} : { persona }),
    ...(contexts.length === 0 ? {} : { runContext: contexts.join('\n\n') }),
    ...(hidden.size === 0 ? {} : { hiddenTools: [...hidden] }),
    ...(allowed === undefined ? {} : { allowedTools: allowed }),
  }
}
