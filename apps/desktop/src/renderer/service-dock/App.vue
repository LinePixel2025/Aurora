<script setup lang="ts">
/**
 * AI 服务窗（docs/07 §2.1）：无边框置顶输入框，320×56。
 *
 * 行为：
 * - 回车发送到「快速会话」，回复由小 AI 交互窗口展示；
 * - 输入框以外区域点击 → 拉起迷你窗；
 * - `/`、`@` 前缀浮层（快捷指令 / Skill，P2 起逐项生效）；
 * - 状态点：闲置灰 / 思考中呼吸蓝 / 有未读橙 / 异常红。
 */
import { computed, nextTick, ref } from 'vue'
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
const { statusTone, streaming, send: sendMessage, clear } = chat

const input = ref('')
const inputEl = ref<HTMLInputElement | null>(null)
const hintVisible = computed(() => input.value.startsWith('/') || input.value.startsWith('@'))

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
}

function onDockClick(event: MouseEvent): void {
  const target = event.target as HTMLElement
  if (target.closest('.input-area')) return
  void windowStore.showMiniChat()
}

function onContextMenu(event: MouseEvent): void {
  event.preventDefault()
  void windowStore.showChat()
}

async function focusInput(): Promise<void> {
  await nextTick()
  inputEl.value?.focus()
}

void focusInput()
void settingsStore.load()
void modeStore.load()

function modeLabel(mode: ModeId): string {
  return modeStore.modes.find((item) => item.id === mode)?.displayName ?? mode
}
</script>

<template>
  <div class="dock glass" @click="onDockClick" @contextmenu="onContextMenu">
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
      />
      <button class="send" type="button" :disabled="streaming" @click="submit">
        {{ streaming ? '…' : '发送' }}
      </button>
    </div>

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

    <div class="meta">
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
