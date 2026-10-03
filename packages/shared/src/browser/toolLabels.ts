/**
 * 工具行的**语义化行首标题**（2026-10-01 轨迹重塑，docs/07 §2.3 硬口径④）。
 *
 * 通用工具行的标题不再是裸 mono 工具名（`run_command`），而是「动词 + 关键参数」的可读短语
 * （「运行 pnpm test」）—— 一屏读下来是"这条轨迹做过了哪些事"，而不是一列内部标识符。
 * 纯函数、零依赖：可被 vitest 的 node 环境直接收单测（与 `toolIcons.ts` 同一套路）。
 *
 * 映射刻意**宽松**：模型输出的参数形状畸形时返回 null（行首回落工具名），绝不抛错 ——
 * 与 `AgentToolRow.todosOf` / `parseTaskInput` 的「解析失败回落通用行」同一条规矩。
 * 未登记的工具返回 null：新工具没接映射时行首保持工具名，不会渲染出残缺短语。
 */

/** 语义化标题：动词短语 + 可选的关键参数摘要 */
export interface ToolLabel {
  verb: string
  /** 关键参数（已截断）；没有可摘的参数时缺省 */
  object?: string
}

/** 关键参数摘要的最大长度：行首是单行省略的 flex 项，超长由 CSS 接管，这里只挡极端值 */
const OBJECT_MAX = 48

/** 从形状未知的入参里摘一个字符串值：按候选键序取第一个非空字符串 */
function pickObject(input: unknown, keys: string[]): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const record = input as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') {
      const text = value.trim().replace(/\s+/g, ' ')
      return text.length > OBJECT_MAX ? `${text.slice(0, OBJECT_MAX)}…` : text
    }
  }
  return undefined
}

/**
 * 工具名 → 语义化标题。返回 null = 未登记 / 参数里摘不出东西，行首回落工具名。
 *
 * 候选键按工具实际入参（docs/06 §11.5 / §18）：`run_command.command`、
 * `read_file.path`、`grep.pattern`…；`list_dir` / `clipboard_read` 这类没有值得摘的
 * 参数，标题就是动词本身。
 */
export function toolLabelOf(name: string, input: unknown): ToolLabel | null {
  switch (name) {
    case 'run_command':
      return { verb: '运行', object: pickObject(input, ['command', 'cmd']) }
    case 'read_file':
      return { verb: '读取', object: pickObject(input, ['path', 'file']) }
    case 'write_file':
      return { verb: '写入', object: pickObject(input, ['path', 'file']) }
    case 'edit_file':
      return { verb: '编辑', object: pickObject(input, ['path', 'file']) }
    case 'list_dir':
      return { verb: '列出目录', object: pickObject(input, ['path', 'dir']) }
    case 'open_path':
      return { verb: '打开', object: pickObject(input, ['path', 'target']) }
    case 'grep':
      return { verb: '搜索', object: pickObject(input, ['pattern', 'query']) }
    case 'glob':
      return { verb: '查找文件', object: pickObject(input, ['pattern']) }
    case 'web_fetch':
      return { verb: '抓取', object: pickObject(input, ['url', 'href']) }
    case 'notify_user':
      return { verb: '通知', object: pickObject(input, ['message', 'text', 'title']) }
    case 'clipboard_write':
      return { verb: '写入剪贴板', object: pickObject(input, ['text']) }
    case 'clipboard_read':
      return { verb: '读取剪贴板' }
    case 'generate_image':
      return { verb: '生成图片', object: pickObject(input, ['prompt']) }
    case 'show_preview':
      return { verb: '展示', object: pickObject(input, ['title', 'target']) }
    case 'show_image':
      return { verb: '展示图片', object: pickObject(input, ['caption', 'path']) }
    case 'use_skill':
      return { verb: '调用技能', object: pickObject(input, ['name', 'skill', 'id']) }
    case 'set_setting':
      return { verb: '调整设置', object: pickObject(input, ['path', 'key']) }
    case 'center_status':
      return { verb: '查询 Center 状态' }
    case 'center_send_file':
      return { verb: '发送文件', object: pickObject(input, ['path', 'file']) }
    case 'classisland_remind':
      return { verb: '课堂提醒', object: pickObject(input, ['message', 'text']) }
    case 'automation_run':
      return { verb: '运行自动化', object: pickObject(input, ['name', 'id']) }
    default:
      // automation_list / automation_create / automation_update / automation_delete /
      // automation_history / todo_write / task 各有结构化行首或独立视图，不走短语
      return null
  }
}
