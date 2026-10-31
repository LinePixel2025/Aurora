/**
 * Computer Use 结束后的前台化判据（docs/06 §28）。
 *
 * 2026-11-01 口径：**操作一结束就把 Aurora 调回前台**（用户明确要求「ComputerUse 结束后
 * 将 Aurora 调至前台」）—— 任务完成（`agent`）、用户点停止 / 快捷键 / 托盘（`user`）、
 * 闲置超时（`idle`）、动作预算触顶（`budget`）与宿主 / 输入失败（`error`）都算「结束」，
 * 用户总该在屏幕上看到收尾结果或失败原因。
 *
 * 不抢焦点的情况：
 * - `settings` / `permission` / `model`：用户正在设置页改配置 / 切模型，
 *   把主界面提到前台会盖住他正在操作的表单；
 * - `system`：锁屏 / 休眠，桌面本来就不可见；
 * - `quit`：应用正在退出。
 */
import type { ComputerUseStopReason } from '@aurora/shared'

export function shouldBringAuroraToFront(reason: ComputerUseStopReason): boolean {
  return (
    reason === 'agent' ||
    reason === 'user' ||
    reason === 'idle' ||
    reason === 'budget' ||
    reason === 'error'
  )
}
