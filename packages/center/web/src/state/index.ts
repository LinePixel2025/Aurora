/**
 * 状态层的装配与消息分发（`@aurora/shared` 契约 → 本地状态的唯一入口）。
 *
 * 视图与组件一律 `import { … } from '../state'`（本文件是桶）；本文件持有三条装配：
 * 1. `socket.onStatus` → `wsStatus`（顶栏的连接指示）；
 * 2. `socket.onMessage` → `handleServerMessage`（下面那张 switch，未知 type 一律忽略）；
 * 3. `state.booted` 的启动流程（`boot()` 在 `App.vue` 挂载时调用）。
 */
import type { CenterWebServerMessage } from '@aurora/shared'
import { socket, settleCommand } from '../lib/socket'
import { applyEvent } from './events'
import { replaceClients, state, statusBuffer, wsStatus } from './store'

export * from './store'
export * from './events'
export * from './commands'
export * from './usage'

socket.onStatus = (status) => {
  wsStatus.value = status
}
socket.onMessage = (message) => handleServerMessage(message)

function handleServerMessage(message: CenterWebServerMessage): void {
  switch (message.type) {
    case 'clients':
      replaceClients(message.clients)
      break
    case 'client.status': {
      // 整体覆盖（不做字段裁剪）：`llm` 快照与 `voice` 能力位都在里面，会话页 / 面板直接读。
      const entry = state.clients.get(message.clientId)
      if (entry) entry.status = message.status
      // 条目还没建出来（status 早于 clients 快照到达）：先进暂存区，
      // `replaceClients` 建条目时补投 —— 旧实现直接丢弃，会让该客户端在本次
      // 页面停留期间一直显示不出模式 / 模型 / 语音按钮（Bug 1 的网页端一环）。
      else statusBuffer.set(message.clientId, message.status)
      break
    }
    case 'client.event':
      applyEvent(message.clientId, message.sessionId, message.event)
      break
    case 'result':
      settleCommand(message.requestId, message.ok, message.data, message.error)
      break
    case 'file.received': {
      const entry = state.clients.get(message.clientId)
      if (entry) {
        entry.files.unshift({
          fileId: message.fileId,
          name: message.name,
          size: message.size,
          note: message.note,
          at: message.at,
        })
        if (entry.files.length > 50) entry.files.length = 50
      }
      break
    }
    case 'confirm.request': {
      // 敏感工具确认卡：同一 confirmId 只入列一次（服务器可能向属主与管理员各转发一份）
      if (!state.confirms.some((c) => c.request.confirmId === message.request.confirmId)) {
        state.confirms.push({
          clientId: message.clientId,
          sessionId: message.sessionId,
          request: message.request,
        })
      }
      break
    }
    case 'ask.request': {
      // 提问卡（v0.3.3）：同一 requestId 只入列一次；服务器在网页刷新后会回放未过期项，
      // 因此这里必须按 requestId 幂等（回放与实时推送可能都到）
      const requestId = message.request?.requestId
      if (typeof requestId !== 'string' || requestId === '') break
      if (state.asks.some((entry) => entry.request.requestId === requestId)) break
      state.asks.push({
        clientId: message.clientId,
        sessionId: message.sessionId,
        request: message.request,
      })
      break
    }
    default:
      // 未知消息类型一律忽略（协议只增不改）
      break
  }
}
