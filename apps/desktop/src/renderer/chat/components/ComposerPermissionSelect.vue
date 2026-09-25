<script setup lang="ts">
/*
 * 权限模式选择（输入框工具行，2026-09 输入框重做：docs/07 §2.3）。
 *
 * 写的是 `advanced.confirmSensitiveTools`：`true` = 「变更前确认」，敏感工具
 * （`sensitivity === 'confirm'`，含全部 MCP 工具 / 写文件 / 执行命令 / 改设置）执行前
 * 弹确认卡；`false` = 「完全权限」，直接执行、只记日志留痕。
 *
 * 这个字段在 `SETTINGS_READONLY_PREFIXES` 里 —— AI 的 `set_setting` 一律拒绝改它
 * （否则等于 AI 自己摘掉确认闸门），**只有用户在界面上的这一条路径能关**。
 * 因此本组件是这条闸门的唯一入口之一（另一个是设置页「智能与工具」页的同名字段），
 * 两处读写的是同一份配置，没有第二份来源。
 *
 * 关掉确认是危险动作：下拉里那一项带警示色与一句后果说明，选中后还要再点一次
 * 「确认为完全权限」才算数 —— 一个误点不该把闸门摘掉。
 *
 * 值始终来自 props（配置 = 单一事实来源），组件不保存本地副本；
 * 落盘由调用方完成（`settings:update` 的 `advanced` 是顶层浅合并，patch 只需带这一个字段）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ChevronDown, ShieldCheck, ShieldOff } from '../../shared/icons.js'

const props = withDefaults(
  defineProps<{
    /** 是否要求敏感工具执行前确认（`advanced.confirmSensitiveTools`） */
    confirm: boolean
    /** 配置还没读回来时禁用（避免用户点了一个「保存后会覆盖真实值」的假开关） */
    disabled?: boolean
  }>(),
  { disabled: false },
)

const emit = defineEmits<{ change: [confirm: boolean] }>()

/** 下拉是否展开（点击外部 / Esc / 选中后收起） */
const open = ref(false)
/** 「切到完全权限」的二次确认态：第一次点只把那一项变成确认按钮 */
const pendingDanger = ref(false)
const rootEl = ref<HTMLElement | null>(null)

const label = computed(() => (props.confirm ? '变更前确认' : '完全权限'))

const title = computed(() =>
  props.confirm
    ? '变更前确认：读文件 / 写文件 / 执行命令 / MCP 工具 / 改设置执行前都会先弹确认卡'
    : '完全权限：敏感工具不再逐个确认，直接执行（仅写日志留痕）',
)

function toggle(): void {
  if (props.disabled) return
  open.value = !open.value
  if (!open.value) pendingDanger.value = false
}

/** 选「变更前确认」：立即生效并收起 */
function chooseConfirm(): void {
  open.value = false
  pendingDanger.value = false
  if (!props.confirm) emit('change', true)
}

/**
 * 选「完全权限」：两段式。第一下只翻成确认按钮（`pendingDanger`），
 * 第二下才真的提交 —— 这一项的唯一后果是「敏感操作不再问你」，值得一次确认。
 */
function chooseFullAccess(): void {
  if (!pendingDanger.value) {
    pendingDanger.value = true
    return
  }
  open.value = false
  pendingDanger.value = false
  if (props.confirm) emit('change', false)
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) return
  const target = event.target
  if (target instanceof Node && rootEl.value?.contains(target) === true) return
  open.value = false
  pendingDanger.value = false
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !open.value) return
  // 只收起自己的下拉，不冒泡到窗口层（那里 Esc 另有语义）
  event.stopPropagation()
  open.value = false
  pendingDanger.value = false
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
  <div ref="rootEl" class="perm" :class="{ open }">
    <button
      type="button"
      class="perm-btn"
      :class="{ danger: !confirm, disabled }"
      data-field="chat.permission"
      :disabled="disabled"
      :title="title"
      :aria-haspopup="'menu'"
      :aria-expanded="open"
      @click="toggle"
    >
      <ShieldOff v-if="!confirm" :size="13" :stroke-width="1.8" aria-hidden="true" />
      <ShieldCheck v-else :size="13" :stroke-width="1.8" aria-hidden="true" />
      <span class="perm-label">{{ label }}</span>
      <ChevronDown class="perm-chevron" :size="12" :stroke-width="2" aria-hidden="true" />
    </button>

    <Transition name="pop">
      <div v-if="open" class="perm-menu" role="menu" data-field="chat.permission-menu">
        <button
          type="button"
          class="perm-item"
          role="menuitemradio"
          :aria-checked="confirm"
          data-field="chat.permission-confirm"
          @click="chooseConfirm"
        >
          <ShieldCheck class="perm-item-icon" :size="14" :stroke-width="1.8" aria-hidden="true" />
          <span class="perm-item-body">
            <span class="perm-item-title"
              >变更前确认<em v-if="confirm" class="perm-item-now">当前</em></span
            >
            <span class="tiny muted"
              >写文件 / 执行命令 / MCP 工具 / 改设置都先弹确认卡，你点「允许一次」才执行</span
            >
          </span>
        </button>
        <button
          type="button"
          class="perm-item danger"
          role="menuitemradio"
          :aria-checked="!confirm"
          data-field="chat.permission-full"
          @click="chooseFullAccess"
        >
          <ShieldOff class="perm-item-icon" :size="14" :stroke-width="1.8" aria-hidden="true" />
          <span class="perm-item-body">
            <span class="perm-item-title">
              完全权限<em v-if="!confirm" class="perm-item-now">当前</em>
            </span>
            <span class="tiny muted">
              {{
                pendingDanger
                  ? '再点一次确认：敏感操作将不再询问，直接执行'
                  : '敏感工具不再询问，直接执行（仅写日志留痕）'
              }}
            </span>
          </span>
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.perm {
  position: relative;
  flex: 0 0 auto;
}

/* 与模型 / 思考等级两个下拉同高同边框，看起来是同一条工具带上的控件 */
.perm-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: var(--control-h-md);
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  color: var(--text-secondary);
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

.perm-btn:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--text-primary);
}

.perm-btn:focus-visible {
  outline: none;
  border-color: var(--focus-ring);
  box-shadow: 0 0 0 1px var(--accent-ring);
}

/* 完全权限：用警示色常驻提醒「闸门是开着的」，不做成一闪而过的 toast */
.perm-btn.danger {
  border-color: color-mix(in srgb, var(--warning-text) 45%, var(--border-subtle));
  color: var(--warning-text);
}

.perm-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.perm-label {
  max-width: 84px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.perm-chevron {
  flex: 0 0 auto;
  opacity: 0.7;
  transition: transform var(--transition-base);
}

/* 下拉向上弹：展开时把箭头转向面板所在的方向（与相邻两个原生下拉的收起态箭头保持一致） */
.perm.open .perm-chevron {
  transform: rotate(180deg);
}

/* 下拉向上弹（输入框贴着窗口底部，向下弹会被裁掉） */
.perm-menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 6px);
  z-index: 20;
  width: 320px;
  padding: var(--space-1);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-strong);
  background: var(--bg-raised);
  box-shadow: var(--shadow-2);
}

.perm-item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  width: 100%;
  padding: 6px var(--space-2);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-primary);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast);
}

.perm-item:hover {
  background: var(--fill-2);
}

.perm-item.danger:hover {
  background: var(--warning-fill);
}

.perm-item.danger .perm-item-icon {
  color: var(--warning-text);
}

.perm-item-icon {
  flex: 0 0 auto;
  margin-top: 2px;
  color: var(--accent-text);
}

.perm-item-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.perm-item-title {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-sm);
}

.perm-item.danger .perm-item-title {
  color: var(--warning-text);
}

.perm-item-now {
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--fill-3);
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-style: normal;
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
