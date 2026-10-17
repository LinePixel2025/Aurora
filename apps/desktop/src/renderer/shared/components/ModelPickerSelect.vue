<script setup lang="ts">
/**
 * 模型来源 + 模型选择（对话窗输入区工具行，2026-10-18 改为自绘浮层，docs/07 §2.3）。
 *
 * `selection` 是实际生效的 `(providerId, model)`；没有会话覆盖时由父级传入全局生效值，
 * 只有用户主动改来源 / 模型时才由父级落盘。组件不保存本地状态，避免和设置 / 会话
 * 两份事实打架。
 *
 * 为什么从原生 `<select>` 换成自绘浮层：
 * - 原生下拉的弹出列表由系统绘制（此前靠 `select option { background-color }` 给**收起态**反色，
 *   弹出列表本身仍受系统主题控制，暗档下不可控）；
 * - 两枚原生下拉的固有宽度是「最宽的那个 option」，窄窗只能靠写死 `min-width` 让位；
 * - 现在三者（权限 / 模型 / 思考）统一成同一套 `.composer-flyout` 锚点、宽度与层级令牌，
 *   浮层永远锚在整张 `.composer-box` 上方，不会盖住工具行（docs/07 §2.3「浮层的锚点与层级」）。
 *
 * 结构：两枚 28px 零边框 pill 触发器（`chat.modelSource` / `chat.model`，锚点沿用旧名）+
 * 一张受控菜单（`chat.model-menu`，含来源分段 `chat.model-source-center/local` 与
 * 模型项 `chat.model-option`）。菜单开合由父级 `open` + `update:open` 单点持有 ——
 * 输入区四个浮层（斜杠 / 权限 / 模型 / 思考 / 上下文）必须互斥。
 *
 * 窄宽（`@container composer-bar (max-width: 430px)`）隐藏两枚触发器的文字标签，只留
 * 图标 + 箭头；**权限档位文案不参与这条规则**（它是闸门状态，必须一直可见）。
 * `title` 悬浮提示在窄宽下承担标签的职责。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  Check,
  ChevronDown,
  Cpu,
  MonitorSmartphone,
  useComposerFlyoutLeft,
} from '@aurora/shared/browser'
import {
  modelChoiceKey,
  type ModelPickerChoice,
  type ModelPickerOption,
  type ModelPickerSource,
  type ModelPickerSourceId,
} from '../composables/modelPickerCore.js'

const props = withDefaults(
  defineProps<{
    selection: ModelPickerChoice | null
    sources: ModelPickerSource[]
    sourceId: ModelPickerSourceId | null
    disabled?: boolean
    title?: string
    /** 菜单是否展开（受控；父级保证与其余输入区浮层互斥） */
    open: boolean
  }>(),
  { disabled: false, title: '' },
)

const emit = defineEmits<{
  'update:source': [value: ModelPickerSourceId]
  'update:selection': [value: ModelPickerChoice]
  'update:open': [open: boolean]
}>()

/** 来源的固定顺序与兜底文案（某个来源不存在时仍渲染该项，只是禁用 —— 锚点要稳定） */
const SOURCE_IDS: readonly ModelPickerSourceId[] = ['center', 'local']
const SOURCE_FALLBACK_LABEL: Record<ModelPickerSourceId, string> = {
  center: 'Center 官方',
  local: '用户模型',
}

const rootEl = ref<HTMLElement | null>(null)
/** 这次是点了哪枚触发器打开的（决定箭头朝谁、aria-expanded 挂在谁身上） */
const activeTrigger = ref<'source' | 'model'>('model')
const sourceTriggerEl = ref<HTMLElement | null>(null)
const modelTriggerEl = ref<HTMLElement | null>(null)
const { left: menuLeft, update: updateMenuLeft } = useComposerFlyoutLeft(
  () => (activeTrigger.value === 'source' ? sourceTriggerEl.value : modelTriggerEl.value),
  () => props.open,
)

const currentSource = computed(
  () => props.sources.find((source) => source.id === props.sourceId) ?? null,
)

/** 触发器上的来源文案 */
const sourceLabel = computed(() => {
  const id = props.sourceId
  return currentSource.value?.label ?? (id === null ? '模型来源' : SOURCE_FALLBACK_LABEL[id])
})

/** 触发器上的模型文案：先找当前来源里的完整 label（本机带 provider 前缀），找不到就用裸 id */
const modelLabel = computed(() => {
  const selection = props.selection
  if (selection === null) return '未选择模型'
  const key = modelChoiceKey(selection)
  const option = currentSource.value?.options.find((item) => item.key === key)
  return option?.label ?? selection.model
})

const options = computed<ModelPickerOption[]>(() => currentSource.value?.options ?? [])

const hoverTitle = computed(() => {
  const full =
    props.selection === null
      ? '未选择模型'
      : `${props.selection.providerId} · ${props.selection.model}`
  return props.title === '' ? full : `${full}｜${props.title}`
})

const sourceTitle = computed(() => {
  const base = '模型来源：Center 官方 / 用户模型（选择只写入本会话）'
  return props.title === '' ? base : `${base}｜${props.title}`
})

function sourceOf(id: ModelPickerSourceId): ModelPickerSource | undefined {
  return props.sources.find((source) => source.id === id)
}

function sourceOptionLabel(id: ModelPickerSourceId): string {
  return sourceOf(id)?.label ?? SOURCE_FALLBACK_LABEL[id]
}

function isSelected(option: ModelPickerOption): boolean {
  const selection = props.selection
  return (
    selection !== null &&
    selection.providerId === option.providerId &&
    selection.model === option.model
  )
}

function toggle(which: 'source' | 'model'): void {
  if (props.disabled) return
  if (props.open && activeTrigger.value === which) {
    emit('update:open', false)
    return
  }
  activeTrigger.value = which
  emit('update:open', true)
  // 同一组件里两枚触发器：从「来源」切到「模型」时浮层还开着，必须手动重算 left
  if (props.open) void nextTick(updateMenuLeft)
}

/**
 * 换来源：只往上报来源，菜单**保持展开** —— 用户接下来大概率要在这个来源里挑模型，
 * 关掉再点一次是无谓的一步（旧原生下拉也是「选来源 → 选模型」两步）。
 */
function chooseSource(id: ModelPickerSourceId): void {
  if (sourceOf(id) === undefined) return
  if (props.sourceId === id) return
  emit('update:source', id)
}

/** 选模型：上报选择并收起菜单（一次明确的落盘动作，收起是给用户的完成反馈） */
function chooseModel(option: ModelPickerOption): void {
  emit('update:selection', { providerId: option.providerId, model: option.model })
  emit('update:open', false)
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

/*
 * 注意：**不要**用 watcher 在 `open` 变 true 时重置 `activeTrigger` —— 点来源那枚触发器时
 * `toggle()` 先把 activeTrigger 设成 'source' 再 emit，父级回写 `open` 会触发 watcher 把它
 * 重置成 'model'，箭头与 aria-expanded 就永远指在模型那一枚上。
 */

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
  <div ref="rootEl" class="model-picker-group" :class="{ open }">
    <button
      ref="sourceTriggerEl"
      type="button"
      class="picker-trigger picker-source"
      data-field="chat.modelSource"
      :data-source-id="sourceId ?? ''"
      aria-label="模型来源"
      aria-haspopup="menu"
      :aria-expanded="open && activeTrigger === 'source'"
      :disabled="disabled || sources.length <= 1"
      :title="sourceTitle"
      @click="toggle('source')"
    >
      <MonitorSmartphone class="picker-icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
      <span class="picker-label">{{ sourceLabel }}</span>
      <ChevronDown class="picker-chevron" :size="12" :stroke-width="2" aria-hidden="true" />
    </button>

    <button
      ref="modelTriggerEl"
      type="button"
      class="picker-trigger picker-model"
      data-field="chat.model"
      :data-source-id="sourceId ?? ''"
      :data-model-key="selection === null ? '' : modelChoiceKey(selection)"
      aria-label="模型"
      aria-haspopup="menu"
      :aria-expanded="open && activeTrigger === 'model'"
      :disabled="disabled || currentSource === null"
      :title="hoverTitle"
      @click="toggle('model')"
    >
      <Cpu class="picker-icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
      <span class="picker-label">{{ modelLabel }}</span>
      <ChevronDown class="picker-chevron" :size="12" :stroke-width="2" aria-hidden="true" />
    </button>

    <Transition name="pop">
      <div
        v-if="open"
        class="model-menu glass-panel composer-flyout"
        :style="{ left: `${menuLeft}px` }"
        role="menu"
        data-field="chat.model-menu"
      >
        <p class="menu-caption tiny muted">模型来源</p>
        <div class="source-row">
          <button
            v-for="id in SOURCE_IDS"
            :key="id"
            type="button"
            class="source-option"
            role="menuitemradio"
            :class="{ active: sourceId === id }"
            :aria-checked="sourceId === id"
            :data-field="`chat.model-source-${id}`"
            :data-source-id="id"
            :disabled="sourceOf(id) === undefined"
            @click="chooseSource(id)"
          >
            <MonitorSmartphone
              v-if="id === 'center'"
              class="source-icon"
              :size="13"
              :stroke-width="1.8"
              aria-hidden="true"
            />
            <Cpu v-else class="source-icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
            <span class="source-name">{{ sourceOptionLabel(id) }}</span>
          </button>
        </div>

        <p class="menu-caption tiny muted">模型</p>
        <p v-if="options.length === 0" class="menu-empty tiny muted">这个来源下还没有可用模型</p>
        <button
          v-for="option in options"
          :key="option.key"
          type="button"
          class="model-option"
          role="menuitemradio"
          :class="{ active: isSelected(option) }"
          :aria-checked="isSelected(option)"
          data-field="chat.model-option"
          :data-model-key="option.key"
          :data-provider-id="option.providerId"
          :data-model="option.model"
          @click="chooseModel(option)"
        >
          <span class="model-option-name">{{ option.label }}</span>
          <Check
            v-if="isSelected(option)"
            class="model-option-check"
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
/*
 * 一组两枚芯片（来源 + 模型）。不设 `min-width` 下限：窄窗靠隐藏文字标签让位，
 * 而不是把控件压到互相重叠（旧实现写死 `min-width: 140px` 是为了让两枚**原生**下拉
 * 不再溢出 —— 自绘触发器没有「固有宽度 = 最宽 option」这个问题了）。
 */
.model-picker-group {
  flex: 0 1 auto;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}

/*
 * 28px 零边框 pill 触发器：与权限 / 思考等级三枚控件逐字对齐
 * （`--control-h-xs` + pill 圆角 + 静止态无边框无底色，悬停浮 `--fill-2`）。
 * 文字用省略号收敛（模型 id 可能很长），`title` 给全量值。
 */
.picker-trigger {
  flex: 0 1 auto;
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 168px;
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

/* 来源标签最长是「Center 官方」，比模型名短，上限收窄一档 */
.picker-source {
  max-width: 128px;
}

.picker-trigger:hover:not(:disabled) {
  background: var(--fill-2);
  color: var(--text-primary);
}

.picker-trigger:focus-visible {
  outline: none;
  border-color: var(--focus-ring);
  background: var(--fill-2);
  color: var(--text-primary);
}

/* 无可用 provider / 只有单一来源时保持可见但禁用（藏起来会让「找不到控件」的抱怨复现） */
.picker-trigger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.picker-icon {
  flex: 0 0 auto;
  opacity: 0.9;
}

.picker-label {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.picker-chevron {
  flex: 0 0 auto;
  opacity: 0.7;
  transition: transform var(--transition-base);
}

/* 展开态箭头翻转（只翻真正打开菜单的那一枚 —— 另一枚的 aria-expanded 是 false） */
.picker-trigger[aria-expanded='true'] .picker-chevron {
  transform: rotate(180deg);
}

/*
 * 窄宽让位（与工具行同一口径）：`@container composer-bar` 由 `chat/App.vue` 的
 * `.composer-bar` 提供（`container: composer-bar / inline-size`）。
 * 只隐藏文字标签，图标与箭头保留 —— 窄窗下仍有可点的控件与可读的 title。
 * ⚠️ 权限档位文案**不参与**这条规则（它是闸门状态，任何宽度下都必须完整可见）。
 */
@container composer-bar (max-width: 430px) {
  .picker-label {
    display: none;
  }

  .picker-trigger {
    max-width: none;
  }
}

/* ── 菜单（`.composer-flyout` 提供定位 / 宽度 / 层级 / 材质，这里只管内容排布） ── */
.model-menu {
  padding: var(--space-1);
  /* 祖先 `.composer-bar` 的 nowrap 会继承进来：菜单正文必须复位成可换行 */
  white-space: normal;
}

.menu-caption {
  margin: 4px var(--space-2) 2px;
  letter-spacing: 0.02em;
}

.source-row {
  display: flex;
  gap: var(--space-1);
  padding: 0 var(--space-1);
}

/* 来源分段：两枚 28px 胶囊，选中态用填充层级而不是描边（与工具行芯片同一套语言） */
.source-option {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  flex: 1 1 0;
  min-width: 0;
  height: var(--control-h-xs);
  padding: 0 var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  background: var(--fill-1);
  color: var(--text-secondary);
  font-family: inherit;
  font-size: var(--text-xs);
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.source-option:hover:not(:disabled) {
  background: var(--fill-2);
  color: var(--text-primary);
}

.source-option.active {
  background: var(--fill-3);
  color: var(--text-primary);
}

.source-option:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.source-icon {
  flex: 0 0 auto;
}

.source-name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.menu-empty {
  margin: 2px var(--space-2) 4px;
}

/* 模型项：32px 行高（≥ WCAG 24 命中下限），长模型 id 省略号收敛 */
.model-option {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 32px;
  padding: 4px var(--space-2);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast);
}

.model-option:hover {
  background: var(--fill-2);
}

.model-option.active {
  color: var(--accent-text);
}

.model-option-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.model-option-check {
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
