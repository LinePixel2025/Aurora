<script setup lang="ts">
/**
 * 思考等级选择（对话窗输入区工具行，2026-10-18 改为自绘浮层，docs/07 §2.3）。
 *
 * 读写的是**同一个字段** `llm.providers.<active>.modelParams.<当前模型>.reasoningEffort`（v23 起按模型绑定，docs/06 §3）——
 * 与设置页「AI 模型」高级参数里的同名下拉没有第二份来源，因此本组件不保存本地状态：
 * 值始终来自 props（配置 = 单一事实来源），选择只 `emit` 出去，落盘由调用方完成
 * （分组级局部更新要求原样回传全部 provider，且不能带回渲染层的空 `apiKeyEnc`——
 * 那些坑都在调用方 `chat/App.vue` 的 `setEffort()` 里踩过并写明了）。
 *
 * `auto` 表示不下发 `reasoning_effort` 字段（兼容性最好），由主进程装配层映射成 `undefined`。
 * option 集合直接取 Schema 的 `REASONING_EFFORT_LEVELS`：以后加等级不会只漏掉这个入口；
 * 文案与 `settings/pages/LlmPage.vue` **逐字一致**——同一个值在两个入口不能有两套说法。
 *
 * 2026-10-18 从原生 `<select>` 换成「28px 零边框 pill 触发器 + `.composer-flyout` 菜单」：
 * 原因与模型那两枚一致（原生弹出列表在暗档不可控；固有宽度 = 最宽 option 让窄窗无法收缩）。
 * 触发器保留旧锚点 `chat.reasoningEffort`（capture 探针以后按新结构改写，不再读 `.value`）；
 * 菜单锚点 `chat.effort-menu`，四个选项逐档挂 `chat.effort-<level>`。
 *
 * 窄宽（`@container composer-bar (max-width: 430px)`）隐藏文字标签，只留图标 + 箭头；
 * 完整解释在每一项的第二行与触发器的 `title` 里，窄宽下不丢信息。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  Check,
  ChevronDown,
  REASONING_EFFORT_LABELS,
  REASONING_EFFORT_LEVELS,
  Sparkles,
  type ReasoningEffort,
  useComposerFlyoutLeft,
} from '@aurora/shared/browser'

const props = withDefaults(
  defineProps<{
    modelValue: ReasoningEffort
    disabled?: boolean
    title?: string
    /** 菜单是否展开（受控；父级保证与其余输入区浮层互斥） */
    open: boolean
  }>(),
  {
    disabled: false,
    title: '',
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: ReasoningEffort]
  'update:open': [open: boolean]
}>()

const rootEl = ref<HTMLElement | null>(null)
/** 触发器：浮层横向贴住它（不再是固定 left: 0） */
const triggerEl = ref<HTMLElement | null>(null)
const { left: menuLeft } = useComposerFlyoutLeft(
  () => triggerEl.value,
  () => props.open,
)

/** 触发器上的最小文案（与 `short` 同源，别在这里另写一套词） */
const label = computed(() => REASONING_EFFORT_LABELS[props.modelValue].short)

/**
 * 悬浮提示 = 当前等级的**完整解释** + 调用方给的参数说明
 * （无 provider 时那边给的是「先在设置里配一个模型」的修复路径）。
 */
const hoverTitle = computed(() => {
  const full = REASONING_EFFORT_LABELS[props.modelValue].full
  return props.title === '' ? full : `${full}｜${props.title}`
})

function toggle(): void {
  if (props.disabled) return
  emit('update:open', !props.open)
}

/**
 * 选一档：**值没变就不上报**（父级本来也会拦，但这里表达的是「点当前项 = 只收起菜单」）；
 * 无论选没选都一样收起 —— 一次点击要么落盘要么关掉，不给「点了没反应」的观感。
 */
function choose(level: ReasoningEffort): void {
  emit('update:open', false)
  if (level !== props.modelValue) emit('update:modelValue', level)
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!props.open) return
  const target = event.target
  if (target instanceof Node && rootEl.value?.contains(target) === true) return
  emit('update:open', false)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !props.open) return
  event.stopPropagation()
  emit('update:open', false)
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div ref="rootEl" class="thinking-level" :class="{ open }">
    <button
      ref="triggerEl"
      type="button"
      class="thinking-trigger"
      data-field="chat.reasoningEffort"
      :data-value="modelValue"
      aria-label="思考等级"
      aria-haspopup="menu"
      :aria-expanded="open"
      :disabled="disabled"
      :title="hoverTitle"
      @click="toggle"
    >
      <Sparkles class="thinking-icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
      <span class="thinking-label">{{ label }}</span>
      <ChevronDown class="thinking-chevron" :size="12" :stroke-width="2" aria-hidden="true" />
    </button>

    <Transition name="pop">
      <div
        v-if="open"
        class="effort-menu glass-panel composer-flyout"
        :style="{ left: `${menuLeft}px` }"
        role="menu"
        data-field="chat.effort-menu"
      >
        <button
          v-for="level in REASONING_EFFORT_LEVELS"
          :key="level"
          type="button"
          class="effort-option"
          role="menuitemradio"
          :class="{ active: modelValue === level }"
          :aria-checked="modelValue === level"
          :data-field="`chat.effort-${level}`"
          :data-level="level"
          @click="choose(level)"
        >
          <span class="effort-body">
            <span class="effort-name">{{ REASONING_EFFORT_LABELS[level].short }}</span>
            <span class="tiny muted effort-desc">{{ REASONING_EFFORT_LABELS[level].full }}</span>
          </span>
          <Check
            v-if="modelValue === level"
            class="effort-check"
            :size="13"
            :stroke-width="2.2"
            aria-hidden="true"
          />
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* 包裹层是工具行里的一个 flex 项；触发器自己不再参与外层收缩（外壳负责） */
.thinking-level {
  flex: 0 1 auto;
  display: flex;
  align-items: center;
  min-width: 0;
}

/*
 * 与权限 / 来源 / 模型三枚芯片逐字对齐（28px + pill 圆角 + 静止态零边框），
 * 窄窗靠隐藏文字标签让位，不再靠写死 `min-width: 56px`。
 */
.thinking-trigger {
  flex: 0 1 auto;
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 132px;
  height: var(--control-h-xs);
  padding: 0 var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-muted);
  font-family: inherit;
  font-size: var(--text-xs);
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast),
    color var(--transition-fast);
}

.thinking-trigger:hover:not(:disabled) {
  background: var(--fill-2);
  color: var(--text-primary);
}

.thinking-trigger:focus-visible {
  outline: none;
  border-color: var(--focus-ring);
  background: var(--fill-2);
  color: var(--text-primary);
}

/* 无可用 provider / Center 官方模型（参数由目录托管）时保持可见但禁用 */
.thinking-trigger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.thinking-icon {
  flex: 0 0 auto;
  opacity: 0.9;
}

.thinking-label {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.thinking-chevron {
  flex: 0 0 auto;
  opacity: 0.7;
  transition: transform var(--transition-base);
}

.thinking-level.open .thinking-chevron {
  transform: rotate(180deg);
}

/* 窄宽让位：只藏文字标签，图标 + 箭头 + title 仍能表达控件身份与当前档位 */
@container composer-bar (max-width: 430px) {
  .thinking-label {
    display: none;
  }

  .thinking-trigger {
    max-width: none;
  }
}

/* ── 菜单（定位 / 宽度 / 层级 / 材质来自 `.composer-flyout`） ── */
.effort-menu {
  padding: var(--space-1);
  /* 祖先 `.composer-bar` 的 nowrap 会继承进来：菜单正文必须复位成可换行 */
  white-space: normal;
}

.effort-option {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 40px;
  padding: 5px var(--space-2);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-primary);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast);
}

.effort-option:hover {
  background: var(--fill-2);
}

.effort-option.active {
  color: var(--accent-text);
}

.effort-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1 1 auto;
  min-width: 0;
}

.effort-name {
  font-size: var(--text-sm);
}

.effort-desc {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.effort-check {
  flex: 0 0 auto;
}

.pop-enter-active,
.pop-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-spring);
}

.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: translateY(4px) scale(0.985);
}
</style>
