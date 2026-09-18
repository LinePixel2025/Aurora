<script setup lang="ts">
/**
 * AI 服务窗（docs/07 §2.1）：无边框置顶，两态折叠。
 *
 * - 收起态：56×56 圆形浮球（深色玻璃底 + 极光渐变环 + 状态点），常态最小占地；
 * - 展开态：320×56 输入条（状态点 + 输入框 + 发送按钮）。
 *
 * 行为：
 * - 点球心 → 展开并聚焦输入框；Esc / 失焦且输入为空 / 发送完成 → 收起；
 * - 输入框以外区域点击 → 拉起迷你窗（沿用旧行为）；右键 → 打开完整交互窗；
 * - 尺寸切换由主进程执行（`window:setDockExpanded`），渲染层只发意图；
 *   主进程在每次显示服务窗时会重置为收起态，这里同步复位本地 `expanded`；
 * - `/`、`@` 前缀浮层（快捷指令 / Skill）；
 * - 状态点：闲置灰 / 思考中呼吸蓝 / 有未读橙 / 异常红。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { ModeId } from '@aurora/shared'
import StatusDot from '../shared/components/StatusDot.vue'
import { useChat } from '../shared/composables/useChat.js'
import {
  useModeStore,
  usePerceptionStore,
  useSettingsStore,
  useWindowStore,
} from '../shared/stores.js'

const windowStore = useWindowStore()
const settingsStore = useSettingsStore()
const modeStore = useModeStore()
const perception = usePerceptionStore()
const chat = useChat('service-dock')
const { statusTone, streaming, send: sendMessage, clear, hydrate } = chat

onMounted(() => {
  void hydrate()
})

const expanded = ref(false)
const input = ref('')
const inputEl = ref<HTMLInputElement | null>(null)
const hintVisible = computed(
  () => expanded.value && (input.value.startsWith('/') || input.value.startsWith('@')),
)

// 主进程「显示服务窗即收起」，渲染层跟随复位，避免本地态与真实尺寸不一致
watch(
  () => windowStore.state.visible['service-dock'],
  (visible, previous) => {
    if (visible === true && previous !== true) expanded.value = false
  },
)

const slashCommands = [
  { token: '/chat', label: '打开完整对话窗口', run: () => windowStore.showChat() },
  { token: '/mini', label: '打开小 AI 交互窗', run: () => windowStore.showMiniChat() },
  { token: '/settings', label: '打开设置', run: () => windowStore.show('settings') },
  { token: '/hide', label: '隐藏服务窗', run: () => windowStore.hide('service-dock') },
  { token: '/clear', label: '清空快速会话', run: () => clear() },
]

const skillHints = computed(() =>
  ['file-classify', 'system-status', 'timetable'].filter((name) =>
    input.value.startsWith('@') ? name.includes(input.value.slice(1)) : true,
  ),
)

const statusTitle = computed(() => {
  if (statusTone.value === 'error') return '上次请求失败'
  if (statusTone.value === 'running') return 'AI 思考 / 执行中'
  if (statusTone.value === 'unread') return '有未读回复'
  return settingsStore.needsOnboarding ? '未配置 AI 模型' : '闲置'
})

async function expandInput(): Promise<void> {
  if (expanded.value) {
    inputEl.value?.focus()
    return
  }
  expanded.value = true
  await windowStore.setDockExpanded(true)
  await nextTick()
  inputEl.value?.focus()
}

async function collapse(): Promise<void> {
  if (!expanded.value) return
  expanded.value = false
  input.value = ''
  await windowStore.setDockExpanded(false)
}

async function submit(): Promise<void> {
  const text = input.value.trim()
  if (text === '') return

  const command = slashCommands.find((item) => item.token === text)
  if (command) {
    input.value = ''
    await command.run()
    return
  }

  input.value = ''
  await sendMessage(text)
  await windowStore.showMiniChat()
  chat.markRead()
  void perception.refresh()
  await collapse()
}

async function onInputBlur(): Promise<void> {
  // 输入为空才收起；有内容则保留，避免切窗口丢输入
  if (input.value.trim() === '') await collapse()
}

function onBallClick(): void {
  void expandInput()
}

function onDockClick(event: MouseEvent): void {
  if (!expanded.value) return
  const target = event.target as HTMLElement
  if (target.closest('.input-area') || target.closest('.grip')) return
  void windowStore.showMiniChat()
}

function onContextMenu(event: MouseEvent): void {
  event.preventDefault()
  void windowStore.showChat()
}

void settingsStore.load()
void modeStore.load()

function modeLabel(mode: ModeId): string {
  return modeStore.modes.find((item) => item.id === mode)?.displayName ?? mode
}
</script>

<template>
  <div
    class="dock"
    :class="{ collapsed: !expanded }"
    @click="onDockClick"
    @contextmenu="onContextMenu"
  >
    <!-- 收起态：圆形浮球。外层渐变环作拖动区，中心按钮可点击 -->
    <div
      v-if="!expanded"
      class="ball drag-region"
      title="点击展开输入框，拖动移动服务窗，右键打开完整对话"
    >
      <button class="ball-core no-drag" type="button" @click="onBallClick">
        <span class="ball-glow" />
        <span class="ball-glyph">A</span>
        <StatusDot class="ball-dot" :tone="statusTone" :size="10" :title="statusTitle" />
      </button>
    </div>

    <!-- 展开态：输入条 -->
    <template v-else>
      <span class="grip drag-region" title="拖动移动服务窗" />

      <div class="input-area no-drag">
        <StatusDot :tone="statusTone" :title="statusTitle" />
        <input
          ref="inputEl"
          v-model="input"
          type="text"
          spellcheck="false"
          :placeholder="
            settingsStore.needsOnboarding ? '先完成 AI 模型配置…' : '问 Aurora 任何事，回车发送…'
          "
          @keydown.enter.prevent="submit"
          @keydown.esc.prevent="collapse"
          @blur="onInputBlur"
        />
        <button class="send" type="button" :disabled="streaming" @click="submit">
          {{ streaming ? '…' : '发送' }}
        </button>
      </div>
    </template>

    <div v-if="hintVisible" class="hint glass no-drag">
      <template v-if="input.startsWith('/')">
        <p class="tiny muted">快捷指令</p>
        <button
          v-for="item in slashCommands"
          :key="item.token"
          type="button"
          @click="input = item.token"
        >
          <span class="mono">{{ item.token }}</span>
          <span class="tiny muted">{{ item.label }}</span>
        </button>
      </template>
      <template v-else>
        <p class="tiny muted">Skill（P3 起可实际调用）</p>
        <button v-for="name in skillHints" :key="name" type="button" @click="input = `@${name} `">
          <span class="mono">@{{ name }}</span>
        </button>
      </template>
    </div>

    <div v-if="expanded" class="meta">
      <span class="tiny muted">{{ modeLabel(modeStore.current?.id ?? 'classroom') }}</span>
      <span v-if="perception.summary" class="tiny muted">{{ perception.summary.localTime }}</span>
    </div>
  </div>
</template>

<style scoped>
.dock {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 100vh;
  padding: 0 10px;
  border-radius: var(--radius-lg);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  overflow: visible;
}

/* ───────── 收起态：圆形浮球 ───────── */

.dock.collapsed {
  padding: 0;
  border-radius: 50%;
  background: transparent;
  box-shadow: none;
  justify-content: center;
}

.ball {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  padding: 3px;
  border-radius: 50%;
  background: var(--aurora-gradient);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.5);
}

.ball-core {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background: #0b0d12;
  transition: background var(--transition-fast);
}

.ball-core:hover {
  background: #14171f;
}

.ball-glow {
  position: absolute;
  inset: 20%;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, rgba(86, 132, 255, 0.4), transparent 70%);
  pointer-events: none;
}

.ball-glyph {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  pointer-events: none;
}

.ball-dot {
  position: absolute;
  right: 6px;
  bottom: 6px;
  pointer-events: none;
}

/* ───────── 展开态：输入条 ───────── */

.grip {
  width: 10px;
  height: 26px;
  border-radius: 5px;
  background: repeating-linear-gradient(
    180deg,
    rgba(255, 255, 255, 0.28) 0 2px,
    transparent 2px 5px
  );
  cursor: grab;
}

.input-area {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
}

.input-area input {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  background: rgba(0, 0, 0, 0.3);
  outline: none;
}

.input-area input:focus {
  border-color: var(--aurora-blue);
}

.send {
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  background: var(--aurora-gradient);
  color: #08131a;
  font-size: 12px;
  font-weight: 600;
}

.send:disabled {
  opacity: 0.6;
}

.hint {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: calc(100% + 8px);
  padding: var(--space-2);
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 220px;
  overflow-y: auto;
}

.hint p {
  margin: 0 0 4px;
}

.hint button {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 5px 6px;
  border-radius: 6px;
  text-align: left;
}

.hint button:hover {
  background: rgba(255, 255, 255, 0.08);
}

.meta {
  position: absolute;
  right: 12px;
  bottom: 2px;
  display: flex;
  gap: 6px;
  pointer-events: none;
  opacity: 0.75;
}
</style>
