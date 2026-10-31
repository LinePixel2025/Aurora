/**
 * Computer Use 运行档（docs/06 §5.2 / §28）。
 *
 * 工具是否注册是进程级的（总开关 / 平台 / vision / 权限档），而「这个会话能不能用」
 * 是请求级的。v39 优化后 Agent 有了自己的入口，因此请求级不再只是「藏工具」：
 *
 * | 状态 | 可见工具 | 运行说明 |
 * | --- | --- | --- |
 * | 未授权、会话合格 | `computer_start` | 告诉模型可以直接进入，不必让用户敲 `/computer` |
 * | 已授权 | 6 个动作工具 + `computer_stop` | 操作规范 + 任务完成必须退出 |
 * | 非视觉 / 会话不合格 | 一个都不留 | 没有任何调用能力 |
 *
 * 「会话合格」的唯一口径在 `session-policy.ts`（自动化 / 自感知 / 子代理会话不合格），
 * 这里只消费它，不在另一处再写一套前缀判断。
 */
import {
  COMPUTER_USE_ALL_TOOL_NAMES,
  COMPUTER_USE_START_TOOL_NAME,
  COMPUTER_USE_TOOL_NAMES,
  type RunProfile,
} from '@aurora/agent-core'

export const COMPUTER_USE_RUN_CONTEXT = [
  '## 本次运行：Computer Use',
  '- 本会话已获得 Computer Use 授权（用户 `/computer` 或你调用 `computer_start`）。',
  '- 需要操作图形界面时**必须优先调用 `computer_*` 工具**，不要用 `run_command` / 内置浏览器替代' +
    '（除非用户明确说不要动桌面）。',
  '- 先 `computer_screenshot` 看屏幕并建立坐标空间；坐标默认按最近截图的像素。',
  '- 优先用 `computer_ui` 的控件名 / 快捷键，不要盲点坐标；每次动作后复核界面。',
  '- 不得操作 Aurora 自身、终端、任务管理器、UAC / 锁屏等受保护窗口。',
  '- 用户手动移动鼠标或键盘时任务继续，不要因此停止或重复已成功的动作。',
  '- **任务完成（或用户要求停止）时必须调用 `computer_stop` 退出**：退出后 Aurora 会自动回到前台向用户汇报；不要一直占着桌面。',
].join('\n')

export const COMPUTER_USE_UNAUTHORIZED_CONTEXT = [
  '## 本次运行：Computer Use 未进入',
  '- 用户在设置里启用了 Computer Use，但本会话尚未获得授权。',
  '- 如果用户要求你操作电脑（点击 / 输入 / 窗口 / 桌面应用），直接调用 `computer_start` 进入；不要要求用户去敲 `/computer`。',
  '- 授权本身不显示浮层，**下一次请求**才会出现 `computer_*` 动作工具：先 `computer_screenshot` 截图，再动作。',
  '- 结构化工具（文件 / 终端 / 内置浏览器）能做时优先用它们；Computer Use 只用于没有结构化接口的界面操作。',
].join('\n')

export interface ComputerUseProfileInput {
  /** 设置里的总开关 */
  enabled: boolean
  /** 当前会话生效模型是否支持图片输入 */
  vision: boolean
  /** 该会话是否持有当前唯一的 Computer Use 授权 */
  authorized: boolean
  /** 该会话能否持有授权（自动化 / 自感知 / 子代理会话不能） */
  eligible: boolean
}

export function computerUseRunProfile(input: ComputerUseProfileInput): RunProfile | undefined {
  if (!input.enabled) return undefined
  // 会话级模型覆盖到非视觉模型、或本会话根本不能持有授权时，整组从请求面摘掉。
  if (!input.vision || !input.eligible) {
    return { hiddenTools: COMPUTER_USE_ALL_TOOL_NAMES }
  }
  if (!input.authorized) {
    return {
      hiddenTools: COMPUTER_USE_TOOL_NAMES,
      runContext: COMPUTER_USE_UNAUTHORIZED_CONTEXT,
    }
  }
  return {
    // 已进入模式：入口工具没有意义，摘掉能省一次误调用；动作工具与退出工具必须留着。
    hiddenTools: [COMPUTER_USE_START_TOOL_NAME],
    runContext: COMPUTER_USE_RUN_CONTEXT,
  }
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
