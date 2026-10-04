/**
 * 文件自感知建议 → Agent 会话的唯一执行逻辑（docs/06 §26）。
 *
 * IPC 层只提供 Electron / Agent 端口；这里保持纯逻辑，便于验证「先建会话、再激活、
 * 最后发送」的顺序，以及发送失败时回收空会话。工具权限仍由新会话自己的确认链决定。
 */
import {
  err,
  ok,
  type FileAwarenessExecution,
  type FileAwarenessSuggestion,
  type Result,
} from '@aurora/shared'

export interface FileAwarenessExecutionDeps {
  suggestion(id: string): FileAwarenessSuggestion | undefined
  createSession(): Promise<string>
  /** 让新会话先出现在会话列表 / 磁盘，再允许主界面按 id 激活。 */
  persistSession(sessionId: string): Promise<void>
  presentSession(sessionId: string): void
  send(input: {
    sessionId: string
    text: string
    origin: 'edge-bar'
    extraContext: string
  }): Promise<unknown>
  removeSession(sessionId: string): Promise<void>
}

export async function executeFileAwarenessSuggestion(
  suggestionId: string,
  deps: FileAwarenessExecutionDeps,
): Promise<Result<FileAwarenessExecution>> {
  const id = suggestionId.trim()
  if (id === '') return err('E_INVALID_ARGUMENT', '缺少建议 id')

  const suggestion = deps.suggestion(id)
  if (suggestion === undefined) return err('E_NOT_FOUND', '建议已不存在')
  if (suggestion.action === undefined) {
    return err('E_INVALID_STATE', '这条建议没有可执行的 Agent 操作')
  }

  const sessionId = await deps.createSession()
  await deps.persistSession(sessionId)
  deps.presentSession(sessionId)
  try {
    await deps.send({
      sessionId,
      text: suggestion.action.prompt,
      origin: 'edge-bar',
      extraContext: buildFileAwarenessExecutionContext(suggestion),
    })
  } catch (error) {
    await deps.removeSession(sessionId).catch(() => undefined)
    return err('E_UNKNOWN', error instanceof Error ? error.message : String(error))
  }
  return ok({ sessionId })
}

/** 建议执行会话的附加上下文：只给模型事实，不放宽任何工具权限。 */
function buildFileAwarenessExecutionContext(suggestion: FileAwarenessSuggestion): string {
  return [
    '以下内容来自文件自感知建议，用户刚刚点击了执行按钮。',
    `来源文件：${suggestion.sourcePath}`,
    `建议标题：${suggestion.headline}`,
    `建议说明：${suggestion.body}`,
    `用户选择的执行动作：${suggestion.action?.label ?? '继续处理'}`,
    '请按当前会话的工具权限继续处理；涉及写入或执行的工具仍走既有确认链。',
  ].join('\n')
}
