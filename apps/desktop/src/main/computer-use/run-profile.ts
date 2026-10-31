/**
 * Computer Use 运行档（docs/06 §5.2 / §28）。
 *
 * 工具是否注册是进程级的（总开关 / 平台 / vision / 权限档），而「这个会话能不能用」
 * 是请求级的。v39 优化后 Agent 有了自己的入口，因此请求级不再只是「藏工具」：
 *
 * | 状态 | 可见工具 | 运行说明 |
 * | --- | --- | --- |
 * | 未授权、会话合格 | `computer_start` | 告诉模型可以直接进入，不必让用户敲 `/computer` |
 * | 已授权 | 6 个动作工具 + `computer_stop` | 操作规范：先看再动、定位优先、同轮批量、每步写 `next`、失败先重看 |
 * | 非视觉 / 会话不合格 | 一个都不留 | 没有任何调用能力 |
 *
 * **工具面每轮现取**（v39.1，`KernelAgentHost` 的 `onRoundStart`）：Agent 调
 * `computer_start` 建立授权后，动作工具在**同一次请求的下一轮**就进入工具面，
 * 不需要用户再发一条消息；提示词仍按请求开始时的快照定稿。
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
  '## 本次运行：Computer Use（已授权操作真实桌面）',
  '- 需要操作图形界面时**必须优先调用 `computer_*` 工具**，不要用 `run_command` / 内置浏览器替代' +
    '（除非用户明确说不要动桌面）。',
  '操作循环：**截图看清现状 → 定位目标 → 同轮批量执行 2–4 步 → 截图验收**。',
  '- **先看再动**：开局先 `computer_screenshot`；窗口被移动 / 缩放 / 激活、弹窗出现、' +
    '显示器变化后坐标就失效，必须重新截图。坐标一律用**最近一张截图**的图片像素，' +
    '结果里已经给出换算关系，不要自己算物理坐标。',
  '- **定位优先级**：`computer_ui`（按控件名 / 角色操作，最稳）→ `computer_window activate` + ' +
    '快捷键 → 最后才用坐标点击。启动应用用 `computer_window launch`，不要到桌面 / 开始菜单找图标。',
  '- **键盘输入前确认前台**：`computer_keyboard` 会核对「前台窗口 == 最近截图目标」，' +
    '不一致会直接拒绝。点开新窗口 / 对话框后先截图，激活或点击目标输入框，再输入。',
  '- **批量执行**：在同一条回复里按顺序发 2–4 个动作（例：点击输入框 → 输入文字 → 按 Enter），' +
    '整批结束后截图验收一次；只有弹窗、界面与预期不符、目标窗口被换掉时才中途停下单独判断。',
  '- **每个动作都填 `next`**：一句话写下一步要做什么（不执行，只显示在过程面板的「下一步」）；' +
    '一批的最后一个写批后的核对动作（如「截图确认结果」）。不要写坐标 / 输入文字 / 剪贴板内容。',
  '- **失败先重看，不要盲重试**：目标窗口变了 / 命中测试失败 / 指针没落位 / 输入被拦 → ' +
    '先截图确认现状再调整；同一手段连续两次失败就换（UIA 控件 / 快捷键 / 请用户处理 UAC）。',
  '- **少等待**：只在明确知道应用需要加载时 `computer_wait`（尽量 ≤1 秒），' +
    '不要每个动作后都等；界面变化用截图核对。',
  '- **受保护目标**：Aurora 自身、终端 / shell、任务管理器、UAC / 锁屏 / 登录界面不可操作；' +
    '遇到需要管理员权限的弹窗要停下说明，请用户处理。',
  '- **用户干扰不打断**：用户手动移动鼠标或键盘时任务继续，不要因此停止或重复已成功的动作。',
  '- **收尾**：桌面交互一结束就调用 `computer_stop`（不必等总结写完）—— 退出后授权撤销、' +
    '浮层收起，Aurora 自动回到前台；随后用几句话说明做了什么、结果在哪。',
].join('\n')

export const COMPUTER_USE_UNAUTHORIZED_CONTEXT = [
  '## 本次运行：Computer Use 未进入',
  '- 用户在设置里启用了 Computer Use，但本会话尚未获得授权。',
  '- 判断标准：任务**必须点真实桌面**才能完成时（只有图形界面的应用、用户已打开的程序、' +
    '系统设置界面、需要拖拽 / 截图对话），直接调用 `computer_start` 进入；' +
    '不要要求用户去敲 `/computer`，也不要把任务推回给用户。',
  '- 结构化工具（文件 / 终端 / 内置浏览器 / 办公文档）能做时优先用它们；Computer Use 是最后手段。',
  '- 调用 `computer_start` 成功后，动作工具（`computer_screenshot` / `computer_mouse` / ' +
    '`computer_keyboard` / `computer_window` / `computer_ui` / `computer_wait`）会在' +
    '**同一次请求的下一轮立即进入工具面** —— 不必等用户再发一条消息。',
  '- **不要在同一轮里同时发 `computer_start` 和动作工具**：那一轮的工具面里还没有它们，' +
    '会得到「工具不存在」。',
  '- 进入后先想好 2–4 步、先 `computer_screenshot`，再按顺序批量下发动作；每个动作填 `next`' +
    '（一句话的下一步计划，过程面板会显示）。',
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
