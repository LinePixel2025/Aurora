<script setup lang="ts">
/**
 * 模型浮层（2026-10-18，Center Web 输入卡）。
 *
 * 写的是**会话级模型覆盖**（`session.setModel`，docs/12 §6.3）：第一项是「跟随全局」（清除覆盖，
 * 命令里 `providerId` / `model` 都传空串），其余按 `remoteLlm.providers` **展平**成
 * 「provider × modelList」的选项 —— 空 providerId 只增不减，因此一个下拉就能跨 provider 切。
 *
 * 候选来自 `config.get` 的脱敏回执（`remoteLlm`）；打开浮层时若还没拉过，父级会补拉一次
 * （`fetchRemoteConfig`）。没有候选时给"去客户端配置"的修复路径，而不是一枚永远转圈的占位。
 *
 * `data-field`：`chat.model-follow-global`（跟随全局）、`chat.model-option`（每项，
 * 带 `data-provider-id` / `data-model` 供探针按值选择）。
 */
import { Check } from '@aurora/shared/browser'
import ComposerMenu from './ComposerMenu.vue'

interface ModelOption {
  providerId: string
  model: string
  /** 是不是当前生效的那个（覆盖优先，缺省 = 全局模型） */
  active: boolean
}

const props = defineProps<{
  open: boolean
  /** 会话级覆盖；null = 跟随全局 */
  override: { providerId: string; model: string } | null
  globalModel: string
  options: ModelOption[]
  /** 配置切片还在路上（显示"拉取模型列表…"而不是空态） */
  loading: boolean
  disabled: boolean
  /** 相对 `.composer-box` 的 left（触发按钮实测） */
  left?: number
}>()

const emit = defineEmits<{
  select: [choice: { providerId: string; model: string }]
  followGlobal: []
  close: []
}>()

function pick(option: ModelOption): void {
  if (props.disabled) return
  emit('select', { providerId: option.providerId, model: option.model })
}
</script>

<template>
  <ComposerMenu
    :open="open"
    :left="left"
    menu-field="chat.model-menu"
    label="切换模型"
    @close="emit('close')"
  >
    <button
      type="button"
      role="menuitemradio"
      class="menu-item"
      :aria-checked="override === null"
      :disabled="disabled"
      data-field="chat.model-follow-global"
      @click="emit('followGlobal')"
    >
      <span class="menu-item-main">
        <span class="menu-item-label">跟随全局</span>
        <span class="menu-item-sub">{{ globalModel === '' ? '客户端当前模型' : globalModel }}</span>
      </span>
      <Check
        v-if="override === null"
        class="menu-check"
        :size="13"
        :stroke-width="2"
        aria-hidden="true"
      />
    </button>

    <p v-if="loading" class="menu-empty">拉取模型列表…</p>
    <p v-else-if="options.length === 0" class="menu-empty">
      客户端没有上报可用模型；先在客户端设置的「AI 模型」里配置。
    </p>
    <template v-else>
      <p class="menu-section-title">本会话使用的模型</p>
      <button
        v-for="option in options"
        :key="`${option.providerId}/${option.model}`"
        type="button"
        role="menuitemradio"
        class="menu-item"
        :aria-checked="option.active"
        :disabled="disabled"
        data-field="chat.model-option"
        :data-provider-id="option.providerId"
        :data-model="option.model"
        @click="pick(option)"
      >
        <span class="menu-item-main">
          <span class="menu-item-label">{{ option.model }}</span>
          <span class="menu-item-sub">{{ option.providerId }}</span>
        </span>
        <Check
          v-if="option.active"
          class="menu-check"
          :size="13"
          :stroke-width="2"
          aria-hidden="true"
        />
      </button>
    </template>
    <p class="menu-note">只改本会话的模型，客户端全局默认不变。</p>
  </ComposerMenu>
</template>
