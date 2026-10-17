<script setup lang="ts">
/**
 * 思考等级浮层（2026-10-18，Center Web 输入卡）。
 *
 * 写的是客户端**全局** `llm.switch({ reasoningEffort })`（docs/12 §6.3 的专用命令），
 * 与右栏「模型」页签改的是同一份值 —— 这里没有"会话级思考等级"。
 *
 * 等级字符串与文案统一取自 `@aurora/shared/browser` 的 `REASONING_EFFORT_LEVELS` /
 * `REASONING_EFFORT_LABELS`（桌面端设置页与输入卡共用同一份，新增等级不会只漏一处）：
 * `short` 给芯片，`full` 给浮层里那一行说明。
 *
 * `data-field`：`chat.effort-auto|low|medium|high`（`chat.effort-<level>`）。
 */
import { REASONING_EFFORT_LABELS, REASONING_EFFORT_LEVELS, Check } from '@aurora/shared/browser'
import type { ReasoningEffort } from '@aurora/shared'
import ComposerMenu from './ComposerMenu.vue'

const props = defineProps<{
  open: boolean
  /** 客户端当前生效等级；未上报时 `''` */
  current: string
  disabled: boolean
  /** 相对 `.composer-box` 的 left（触发按钮实测） */
  left?: number
}>()

const emit = defineEmits<{ select: [level: ReasoningEffort]; close: [] }>()

function pick(level: ReasoningEffort): void {
  if (props.disabled) return
  emit('select', level)
}
</script>

<template>
  <ComposerMenu
    :open="open"
    :left="left"
    menu-field="chat.effort-menu"
    label="思考等级"
    @close="emit('close')"
  >
    <button
      v-for="level in REASONING_EFFORT_LEVELS"
      :key="level"
      type="button"
      role="menuitemradio"
      class="menu-item"
      :aria-checked="current === level"
      :disabled="disabled"
      :data-field="`chat.effort-${level}`"
      @click="pick(level)"
    >
      <span class="menu-item-main">
        <span class="menu-item-label">{{ REASONING_EFFORT_LABELS[level].short }}</span>
        <span class="menu-item-sub">{{ REASONING_EFFORT_LABELS[level].full }}</span>
      </span>
      <Check
        v-if="current === level"
        class="menu-check"
        :size="13"
        :stroke-width="2"
        aria-hidden="true"
      />
    </button>
    <p class="menu-note">思考等级对客户端全局生效（与右栏「模型」页签同一份值）。</p>
  </ComposerMenu>
</template>
