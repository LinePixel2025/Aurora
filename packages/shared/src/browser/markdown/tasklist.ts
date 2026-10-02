/**
 * 任务列表（P1）：`- [ ] 待办` / `- [x] 已完成` 的自写实现（只读渲染）。
 *
 * 输出：`<li class="md-task md-task-done?"><input type="checkbox" disabled …>文本</li>`。
 * checkbox 一律 `disabled` —— 对话是**只读**的，勾选状态只反映模型说了什么；
 * 交互式的任务清单是 `todo_*` 工具卡（docs/06 §18）的职责，不归 Markdown。
 *
 * 实现：core 后处理。渲染走的是 inline token 的 **children**（不是 content），
 * 任务前缀 `[ ] ` 是纯文本，必然落在首个 text 子 token 里 —— 在那里摘前缀、
 * 再往 children 头部插一个自定义的 checkbox token（由本插件注册的规则渲染）。
 */
import type { MarkdownIt, RendererRule, StateCore } from 'markdown-it'

const TASK_OPEN = /^\[([ xX])\]\s+/
const CHECKBOX_TOKEN = 'md_task_checkbox'

export function tasklistPlugin(md: MarkdownIt): void {
  md.core.ruler.push('md_tasklist', (state: StateCore) => {
    const tokens = state.tokens
    for (let i = 0; i < tokens.length; i += 1) {
      const itemOpen = tokens[i]
      if (itemOpen === undefined || itemOpen.type !== 'list_item_open') continue

      // 这个列表项的直接 inline（松散列表有 paragraph_open 包裹，紧凑列表直接相邻）
      let inlineIndex = -1
      for (let j = i + 1; j < tokens.length; j += 1) {
        const type = tokens[j]?.type
        if (type === 'inline') {
          inlineIndex = j
          break
        }
        if (
          type === 'list_item_open' ||
          type === 'bullet_list_close' ||
          type === 'ordered_list_close'
        )
          break
      }
      const inline = inlineIndex === -1 ? undefined : tokens[inlineIndex]
      const firstChild = inline?.children?.[0]
      if (inline === undefined || firstChild === undefined || firstChild.type !== 'text') continue

      const match = TASK_OPEN.exec(firstChild.content)
      if (match === null) continue
      const done = (match[1] ?? ' ') !== ' '

      itemOpen.attrJoin('class', done ? 'md-task md-task-done' : 'md-task')
      firstChild.content = firstChild.content.slice(match[0].length)

      const checkbox = new state.Token(CHECKBOX_TOKEN, '', 0)
      checkbox.attrSet('type', 'checkbox')
      checkbox.attrSet('disabled', '')
      if (done) checkbox.attrSet('checked', '')
      inline.children?.unshift(checkbox)
    }
  })

  const checkboxRule: RendererRule = (tokens, idx) => {
    const token = tokens[idx]
    const attrs = token?.attrs ?? []
    const rendered = attrs.map((attr) => ` ${attr[0]}="${String(attr[1] ?? '')}"`).join('')
    return `<input${rendered}>`
  }
  md.renderer.rules[CHECKBOX_TOKEN] = checkboxRule
}
