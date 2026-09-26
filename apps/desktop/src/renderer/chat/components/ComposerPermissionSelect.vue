<script setup lang="ts">
/*
 * 权限档位选择（三档，v13；输入框工具行，2026-09 输入框重做：docs/07 §2.3）。
 *
 * 三档（`agent.permissionMode`，生效结果由调用方解析后传进来）：
 * - `readonly` 只读：写文件 / 执行命令类工具不会注册给模型；
 * - `confirm` 变更前确认（默认档，与三档之前的行为一字不差）：敏感工具执行前弹确认卡；
 * - `auto` 完全权限：仅在项目根之内免确认，越界仍会询问。
 *
 * 生效档位由调用方 `resolvePermissionMode(settingsStore.settings)` 算好传入，**不是**直接读
 * `agent.permissionMode`：v13 之前只有 `advanced.confirmSensitiveTools` 一个开关，老配置里
 * 它是 `false` 时由 auto 档承接 —— 界面必须显示成「完全权限」，否则用户看到的档位与实际生效的不一致。
 *
 * 写盘是**镜像规则**（两个字段同时写，见 chat/App.vue 的 setPermission）：选了某一档就把老开关
 * 一并置成 `mode !== 'auto'` —— 否则会出现「界面选 confirm、实际生效 auto」这类错位
 * （老开关优先级高于 `permissionMode` 的已登记值，见 packages/shared/src/config/permission.ts）。
 *
 * 这两个字段都在 `SETTINGS_READONLY_PREFIXES` 里 —— AI 的 `set_setting` 一律拒绝改它们
 * （否则等于 AI 自己摘掉确认闸门），**只有用户在界面上的路径能改**。
 * 因此本组件是这条闸门的入口之一（另一个是设置页「系统」页的同名字段），
 * 三处读写的是同一份配置，没有第二份来源。
 *
 * 放宽权限必须有摩擦，收紧不需要：`auto` 档**两段式**（第一次点只把那项翻成
 * 「再点一次确认」，第二下才落盘）；`readonly` / `confirm` 单击即提交。
 *
 * 探针锚点（一个元素一个锚点，别合并）：
 * - 触发器 `chat.permission`（文案随生效档位变）；
 * - 菜单 `chat.permission-menu`；
 * - 三个选项：`chat.permission-mode-readonly`（只读）/ `chat.permission-confirm`（变更前确认，
 *   **旧锚点名沿用**）/ `chat.permission-full`（**auto 档的唯一锚点**：旧锚点名沿用，
 *   且刻意**不**再加一个 `chat.permission-mode-auto` —— 一个元素挂两个锚点会破坏
 *   capture 的「按锚点数元素」口径。名字与档位的映射关系就写在这里，别再补别名）。
 *
 * 值始终来自 props（配置 = 单一事实来源），组件不保存本地副本；
 * 落盘由调用方完成。
 *
 * 展开状态是**受控**的（`open` + `update:open`）：输入区三个浮层锚在同一张输入卡上、
 * 共用 `--z-flyout`、必须互斥打开，因此「谁开着」只能有一个所有者 —— 归 `chat/App.vue`
 * 的 `openFlyout`（docs/07 §2.3「三个浮层的锚点与层级」）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { PermissionMode } from '@aurora/shared'
import { ChevronDown, ShieldCheck, ShieldOff } from '../../shared/icons.js'

const props = withDefaults(
  defineProps<{
    /** 当前**生效**档位（由调用方 `resolvePermissionMode` 解析，含老开关承接成 auto 的情况） */
    mode: PermissionMode
    /** 下拉是否展开（受控；由调用方保证与另外两个输入区浮层互斥） */
    open: boolean
    /** 配置还没读回来时禁用（避免用户点了一个「保存后会覆盖真实值」的假开关） */
    disabled?: boolean
  }>(),
  { disabled: false },
)

const emit = defineEmits<{
  change: [mode: PermissionMode]
  'update:open': [open: boolean]
}>()

/** 「切到完全权限」的二次确认态：第一次点只把那一项变成确认按钮 */
const pendingDanger = ref(false)
const rootEl = ref<HTMLElement | null>(null)

/**
 * 收起时丢掉半途的二次确认态。放在 watcher 里而不是每个关闭路径各写一遍：
 * 关闭可能来自点击外部 / Esc / 选中 / **别的浮层把它挤掉**，四条路径都要复位。
 */
watch(
  () => props.open,
  (open) => {
    if (!open) pendingDanger.value = false
  },
)

/** 触发器上的当前档位文案 */
const label = computed(() => {
  if (props.mode === 'readonly') return '只读'
  return props.mode === 'auto' ? '完全权限' : '变更前确认'
})

const title = computed(() => {
  if (props.mode === 'readonly') {
    return '只读：写文件 / 执行命令类工具不会注册给模型，模型看不到它们'
  }
  return props.mode === 'auto'
    ? '完全权限：仅在项目根之内免确认，越界仍会询问（仅写日志留痕）'
    : '变更前确认：读文件 / 写文件 / 执行命令 / MCP 工具 / 改设置执行前都会先弹确认卡'
})

/** 完全权限档用警示色常驻提醒「闸门是开着的」 */
const danger = computed(() => props.mode === 'auto')

function toggle(): void {
  if (props.disabled) return
  emit('update:open', !props.open)
}

/**
 * 选某一档：
 * - `auto`（放宽）：两段式。第一下只翻成确认按钮（`pendingDanger`），第二下才提交 ——
 *   这一项的唯一后果是「敏感操作不再问」，值得一次确认；
 * - `readonly` / `confirm`（收紧 / 维持）：单击即提交；
 * - 已经是当前档：只收起，不重复写盘。
 */
function choose(mode: PermissionMode): void {
  if (mode === 'auto') {
    if (!pendingDanger.value) {
      pendingDanger.value = true
      return
    }
    emit('update:open', false)
    if (props.mode !== 'auto') emit('change', 'auto')
    return
  }
  emit('update:open', false)
  if (props.mode !== mode) emit('change', mode)
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!props.open) return
  const target = event.target
  if (target instanceof Node && rootEl.value?.contains(target) === true) return
  emit('update:open', false)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !props.open) return
  // 只收起自己的下拉，不冒泡到窗口层（那里 Esc 另有语义）
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
  <div ref="rootEl" class="perm" :class="{ open }">
    <button
      type="button"
      class="perm-btn"
      :class="{ danger, readonly: mode === 'readonly', disabled }"
      data-field="chat.permission"
      :disabled="disabled"
      :title="title"
      :aria-haspopup="'menu'"
      :aria-expanded="open"
      @click="toggle"
    >
      <ShieldOff v-if="danger" :size="13" :stroke-width="1.8" aria-hidden="true" />
      <ShieldCheck v-else :size="13" :stroke-width="1.8" aria-hidden="true" />
      <span class="perm-label">{{ label }}</span>
      <ChevronDown class="perm-chevron" :size="12" :stroke-width="2" aria-hidden="true" />
    </button>

    <Transition name="pop">
      <div v-if="open" class="perm-menu" role="menu" data-field="chat.permission-menu">
        <!-- 只读：最严的一档，收窄权限不需要二次确认（单击即提交） -->
        <button
          type="button"
          class="perm-item readonly"
          role="menuitemradio"
          :aria-checked="mode === 'readonly'"
          data-field="chat.permission-mode-readonly"
          @click="choose('readonly')"
        >
          <ShieldCheck class="perm-item-icon" :size="14" :stroke-width="1.8" aria-hidden="true" />
          <span class="perm-item-body">
            <span class="perm-item-title"
              >只读<em v-if="mode === 'readonly'" class="perm-item-now">当前</em></span
            >
            <span class="tiny muted">写文件 / 执行命令类工具不会注册给模型</span>
          </span>
        </button>

        <!-- 变更前确认：默认档；锚点沿用它两档时代的旧名字 -->
        <button
          type="button"
          class="perm-item"
          role="menuitemradio"
          :aria-checked="mode === 'confirm'"
          data-field="chat.permission-confirm"
          @click="choose('confirm')"
        >
          <ShieldCheck class="perm-item-icon" :size="14" :stroke-width="1.8" aria-hidden="true" />
          <span class="perm-item-body">
            <span class="perm-item-title"
              >变更前确认<em v-if="mode === 'confirm'" class="perm-item-now">当前</em></span
            >
            <span class="tiny muted"
              >写文件 / 执行命令 / MCP 工具 / 改设置都先弹确认卡，你点「允许一次」才执行</span
            >
          </span>
        </button>

        <!--
          完全权限 = auto 档：锚点是旧名 `chat.permission-full`（唯一锚点，别再加 mode-auto 别名），
          仍然是两段式 —— 第一次点只翻成「再点一次确认」。
        -->
        <button
          type="button"
          class="perm-item danger"
          role="menuitemradio"
          :aria-checked="mode === 'auto'"
          data-field="chat.permission-full"
          @click="choose('auto')"
        >
          <ShieldOff class="perm-item-icon" :size="14" :stroke-width="1.8" aria-hidden="true" />
          <span class="perm-item-body">
            <span class="perm-item-title">
              完全权限<em v-if="mode === 'auto'" class="perm-item-now">当前</em>
            </span>
            <span class="tiny muted">
              {{
                pendingDanger
                  ? '再点一次确认：项目根之内的敏感操作将不再询问，直接执行'
                  : '仅在项目根之内免确认，越界仍会询问（仅写日志留痕）'
              }}
            </span>
          </span>
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/*
 * 刻意**不设** `position: relative`：下拉要锚在整张输入卡（`.composer-box`）上，
 * 这样它永远浮在输入卡上方，绝不会盖住自己所在的这条工具行（docs/07 §2.3）。
 */
.perm {
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

/* 只读：最严的一档，不上强调色也不上警示色 —— 它是一个「收窄」状态，不该比默认档更抢眼 */
.perm-btn.readonly {
  color: var(--text-muted);
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

/*
 * 下拉向上弹、锚在**输入卡**上（输入框贴着窗口底部，向下弹会被裁掉）。
 * `left: 0` 相对的是 `.composer-box` 的左内边距 —— 与另外两个输入区浮层共用同一套锚点
 * 与 `--z-flyout` 层级；宽度保持紧凑，三个选项铺满整卡反而难扫读。
 */
.perm-menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 6px);
  z-index: var(--z-flyout);
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

/* 只读档的图标弱化：与触发器上的同一套语义（收窄状态不抢眼） */
.perm-item.readonly .perm-item-icon {
  color: var(--text-muted);
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
