/**
 * 窗口拖动区规则（docs/07 §1、§2.2 / §2.5）。
 *
 * 为什么要有这个东西：拖动能力此前靠各窗自己记得挂 `drag-region` class，
 * 结果 settings 窗只有侧栏里约 22-30px 的品牌行能拖，用户感知就是「有些窗口能拖、有些不行」
 * （问题 5）。现在把「哪些窗口能拖」收敛成一份显式清单 `DRAGGABLE_WINDOWS`，
 * 各窗模板统一用 `:class="dragClass"` 挂类，拖动区内部需要点击的元素挂 `:class="noDragClass"`。
 *
 * 本文件是**纯函数**，刻意不读 `window.aurora`：拖动由 Chromium 的 app-region 机制完成，
 * 主进程不需要新通道（位置记忆已有 `moved` → `persistGeometry`），
 * 因此渲染层组件挂载前也能用。只做类型导入，不引入 `@aurora/shared` 的运行时值。
 */
import type { WindowName } from '@aurora/shared/browser'

/** 允许用户拖动的窗口（显式清单，docs/07 §1）。 */
export const DRAGGABLE_WINDOWS = ['chat', 'settings', 'memory', 'onboarding', 'automation'] as const
export type DraggableWindow = (typeof DRAGGABLE_WINDOWS)[number]

/**
 * 该窗口是否允许用户拖动。
 * 提示条（`edge-bar`）不在清单里：它 `focusable: false`，几何由主进程按「工作区右缘 +
 * 垂直居中 + 折叠态」推导（`window-manager.ts` 的 `edge` 分支），**刻意不提供拖动**。
 */
export function isDraggableWindow(name: WindowName): name is DraggableWindow {
  return (DRAGGABLE_WINDOWS as readonly string[]).includes(name)
}

/**
 * 拖动区规则。
 *
 * 返回值是纯数据（窗口名在调用处是字面量，不需要响应式）：`dragClass` 挂拖动条元素，
 * `noDragClass` 挂拖动条内部必须能点击的元素。不可拖窗口两者都返回空串 ——
 * Vue 的 `:class="''"` 等价于不挂类，因此接线代码不必写 `v-if` 分支。
 */
export function useWindowDrag(name: WindowName): {
  draggable: boolean
  /** 挂在拖动条元素上的 class（不可拖窗口返回空串） */
  dragClass: string
  /** 挂在拖动条内部交互元素上的 class（不可拖窗口返回空串） */
  noDragClass: string
} {
  const draggable = isDraggableWindow(name)
  return {
    draggable,
    dragClass: draggable ? 'drag-region' : '',
    noDragClass: draggable ? 'no-drag' : '',
  }
}
