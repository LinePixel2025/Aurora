/**
 * Computer Use 结束后的前台化判据（docs/06 §28）。
 *
 * 只有 Agent 主动退出（`agent` = 任务完成，由 `computer_stop` 触发）才把主界面
 * 调回前台：这是「Agent 完成任务后把 Aurora 调到前台」的落点。
 *
 * 其余结束原因都不抢焦点：
 * - `user`：用户自己点的停止 / 快捷键，他本来就在机器前；
 * - `settings` / `permission`：用户正在设置页改配置，弹对话窗会盖住他正在操作的表单；
 * - `system`：锁屏 / 休眠，桌面不可见；
 * - `quit`：应用正在退出；
 * - `idle` / `budget` / `error` / `model`：被动结束，保持既有「不打扰」口径。
 */
import type { ComputerUseStopReason } from '@aurora/shared'

export function shouldBringAuroraToFront(reason: ComputerUseStopReason): boolean {
  return reason === 'agent'
}
