/**
 * 计划模式的只读工具白名单（docs/06 §29）。
 *
 * 用**白名单而不是黑名单**：新工具（插件 / MCP / 未来内置）默认不可见；将来新增
 * 一个真正只读的工具时，需要显式加进这里 —— 忘记加的代价是「计划时用不了」，
 * 而不是「计划时能写盘」，两个方向不对称，所以宁可保守。
 *
 * 刻意**不包含**：
 * - `task`：子代理工具面来自**全局** ToolRegistry（不是父会话的过滤视图），
 *   `permission: 'write'` 可能绕过计划模式的只读约束；
 * - `run_command`：Aurora 没有命令级沙箱，无法可靠区分只读命令；
 * - `browser_act` / `browser_eval`：会对外部系统产生副作用 / 执行任意 JS；
 * - 全部写盘、Office 写、设置、Computer Use、通知、展示、自动化、Center 发送类工具；
 * - 全部 `plugin.*` 与 `mcp.*`（未知副作用）。
 */
export const PLAN_READONLY_TOOL_NAMES: readonly string[] = [
  // 文件读取与检索
  'read_file',
  'list_dir',
  'grep',
  'glob',
  // Office 只读
  'office_read',
  'office_help',
  // 网络调研
  'web_fetch',
  // 内置浏览器：只保留 navigate / snapshot / read / wait / screenshot / close
  'browser_open',
  'browser_snapshot',
  'browser_read',
  'browser_wait',
  'browser_screenshot',
  'browser_close',
  // 图片 / 剪贴板读取
  'view_image',
  'screenshot',
  'clipboard_read',
  'clipboard_read_image',
  // 技能正文（只注入指令，不执行 scripts）
  'use_skill',
  // 文件自感知只读
  'awareness_status',
  'awareness_recent',
  'awareness_search',
  'awareness_read',
  // Center 只读状态
  'center_status',
  // 计划阶段的本地任务清单（写 userData/todos，不碰项目文件 / 设置）
  'todo_read',
  'todo_write',
  // 向用户澄清（计划前允许提问）
  'ask_user',
]

/**
 * 计划模式**明确禁止**的工具名（文档 / 测试对照用；不在白名单里的都不可见）。
 *
 * 这里列的是最容易被误以为"只读"的工具；`ALL` 校验由
 * `plan/run-profile.test.ts` 的白名单断言兜底。
 */
export const PLAN_DENIED_TOOL_NAMES: readonly string[] = [
  'task',
  'run_command',
  'write_file',
  'edit_file',
  'open_path',
  'office_create',
  'office_edit',
  'office_render',
  'office_pdf',
  'office_raw_edit',
  'clipboard_write',
  'notify_user',
  'notify_banner',
  'show_preview',
  'show_image',
  'generate_image',
  'set_setting',
  'set_appearance',
  'browser_act',
  'browser_eval',
  'center_send_file',
  'classisland_remind',
  'computer_start',
  'computer_screenshot',
  'computer_mouse',
  'computer_keyboard',
  'computer_window',
  'computer_ui',
  'computer_wait',
  'computer_stop',
]
