/**
 * 插件面板事件总线（docs/12 §6.5）。
 *
 * `plugin.event` 是**推送**而非命令回执：它没有 requestId、也不落在全局状态里。
 * 只有一个打开中的面板视图关心它，因此用一条极小的订阅表转发，
 * 视图按 `clientId + pluginId + panelId` 自行过滤（多设备同名面板时不能串台）。
 */
export interface CenterPluginEvent {
  clientId: string
  pluginId: string
  panelId: string
  event: string
  payload?: unknown
}

type Listener = (event: CenterPluginEvent) => void

const listeners = new Set<Listener>()

export function onPluginEvent(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitPluginEvent(event: CenterPluginEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // 单个视图的异常不影响其他订阅者
    }
  }
}
