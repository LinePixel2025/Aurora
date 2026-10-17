<script setup lang="ts">
/**
 * 权限档浮层（2026-10-18，Center Web 输入卡）。
 *
 * 与桌面端 `ComposerPermissionSelect.vue` 同一套语义（docs/07 §2.3 / docs/06 §11.2）：
 * 三档 —— **只读** / **变更前确认** / **完全权限**；网页端这一处写的是**会话级覆盖**
 * （`session.setPermission`），不动客户端全局 `agent.permissionMode`，因此底部常驻一句
 * 「只影响本会话」。
 *
 * 「完全权限」沿用桌面端的警示色（闸门开着这件事必须一直看得见）；但桌面端那套
 * 「点两次才放宽」的防误触没有搬过来：网页端的**放宽**已经多了一道「先点开浮层、
 * 再选一档」的动作，而 `session.setPermission` 只作用于一个会话、不落盘。
 *
 * `data-field`：`chat.permission-mode-readonly` / `chat.permission-mode-confirm` /
 * `chat.permission-mode-full`（auto 档沿用桌面端的 `-full` 命名，不要改成 `-auto`）。
 */
import type { PermissionMode } from '@aurora/shared'
import { Check } from '@aurora/shared/browser'
import ComposerMenu from './ComposerMenu.vue'

const props = defineProps<{
  open: boolean
  /** 当前生效档位（会话覆盖 > 全局快照；未知 / 未上报为 `''`） */
  current: string
  disabled: boolean
  /** 相对 `.composer-box` 的 left（触发按钮实测） */
  left?: number
}>()

const emit = defineEmits<{ select: [mode: PermissionMode]; close: [] }>()

const MODES: Array<{ value: PermissionMode; field: string; label: string; hint: string }> = [
  {
    value: 'readonly',
    field: 'readonly',
    label: '只读',
    hint: '写文件 / 执行命令类工具根本不注册给模型',
  },
  {
    value: 'confirm',
    field: 'confirm',
    label: '变更前确认',
    hint: '敏感操作越界时先弹确认卡',
  },
  {
    value: 'auto',
    field: 'full',
    label: '完全权限',
    hint: '所有敏感操作直接执行，不再弹确认',
  },
]

function pick(mode: PermissionMode): void {
  if (props.disabled) return
  emit('select', mode)
}
</script>

<template>
  <ComposerMenu
    :open="open"
    :left="left"
    menu-field="chat.permission-menu"
    label="权限模式"
    @close="emit('close')"
  >
    <button
      v-for="mode in MODES"
      :key="mode.value"
      type="button"
      role="menuitemradio"
      class="menu-item"
      :class="{ caution: mode.value === 'auto' }"
      :aria-checked="current === mode.value"
      :disabled="disabled"
      :data-field="`chat.permission-mode-${mode.field}`"
      @click="pick(mode.value)"
    >
      <span class="menu-item-main">
        <span class="menu-item-label">{{ mode.label }}</span>
        <span class="menu-item-sub">{{ mode.hint }}</span>
      </span>
      <Check
        v-if="current === mode.value"
        class="menu-check"
        :size="13"
        :stroke-width="2"
        aria-hidden="true"
      />
    </button>
    <p class="menu-note">权限档只影响本会话，不改客户端全局设置。</p>
  </ComposerMenu>
</template>

<style scoped>
/* 完全权限：放宽闸门的那一档用警示色常驻（与桌面端同一语义） */
.caution .menu-item-label {
  color: var(--warning-text);
}
</style>
