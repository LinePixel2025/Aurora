<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ClientEntry } from '../store'
import { switchMode, updateConfig } from '../store'

const props = defineProps<{ entry: ClientEntry | null }>()

const MODES = [
  { id: 'classroom', label: '课堂' },
  { id: 'work', label: '工作' },
  { id: 'code', label: '代码' },
] as const

const TOOL_SWITCHES = [
  { path: 'agent.tools.enabled', label: '电脑操控工具（总开关）' },
  { path: 'agent.tools.files.enabled', label: '文件读写' },
  { path: 'agent.tools.search.enabled', label: '文件检索' },
  { path: 'agent.tools.open.enabled', label: '打开路径' },
  { path: 'agent.tools.terminal.enabled', label: '终端命令' },
] as const

const busy = ref(false)
const error = ref('')

const status = computed(() => props.entry?.status ?? null)
const online = computed(() => props.entry?.client.online ?? false)
const currentMode = computed(() => status.value?.mode ?? props.entry?.client.mode ?? '')

watch(
  () => props.entry?.client.clientId,
  () => {
    error.value = ''
  },
)

async function run(action: () => Promise<void>): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await action()
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    // 客户端侧闸门的拒绝口径翻译成人话（docs/12 §7）
    if (raw.startsWith('E_REMOTE_DISABLED')) {
      error.value = '客户端已关闭远程控制许可（在桌面端设置页可重新开启）'
    } else if (raw.startsWith('E_FORBIDDEN_PATH')) {
      error.value = '该配置不在远程白名单内（权限档位 / 免确认命令模式等不可远程改）'
    } else if (raw === 'E_CLIENT_OFFLINE') {
      error.value = '客户端当前离线，命令未送达'
    } else if (raw.startsWith('E_FORBIDDEN')) {
      error.value = '没有控制这台客户端的权限'
    } else {
      error.value = raw
    }
  } finally {
    busy.value = false
  }
}

function onMode(mode: string): void {
  if (!props.entry || mode === currentMode.value) return
  void run(() => switchMode(props.entry!.client.clientId, mode as ClientStatusMode))
}

function onToggle(path: string, event: Event): void {
  if (!props.entry) return
  const checked = (event.target as HTMLInputElement).checked
  void run(() => updateConfig(props.entry!.client.clientId, { [path]: checked }))
}

type ClientStatusMode = 'classroom' | 'work' | 'code'

function toolValue(path: string): boolean | undefined {
  const agent = status.value?.agent
  if (!agent) return undefined
  if (path === 'agent.tools.enabled') return agent.tools.enabled
  if (path === 'agent.tools.files.enabled') return agent.tools.files
  if (path === 'agent.tools.search.enabled') return agent.tools.search
  if (path === 'agent.tools.open.enabled') return agent.tools.open
  if (path === 'agent.tools.terminal.enabled') return agent.tools.terminal
  return undefined
}
</script>

<template>
  <section class="card remote-panel" data-panel="remote-control">
    <span class="panel-title">远程控制</span>
    <p v-if="!entry" class="text-2">先选择一个客户端。</p>
    <template v-else>
      <p v-if="!online" class="text-2">客户端离线——命令会在其上线后仍需重新发送。</p>
      <p v-else-if="!status" class="text-2">尚未收到客户端状态（可能旧版本），无法远程控制。</p>
      <template v-else>
        <div class="remote-block">
          <span class="remote-label">模式</span>
          <div class="mode-row">
            <button
              v-for="mode in MODES"
              :key="mode.id"
              type="button"
              class="btn btn-sm mode-btn"
              :class="{ primary: currentMode === mode.id }"
              :disabled="busy || currentMode === mode.id"
              :data-mode="mode.id"
              @click="onMode(mode.id)"
            >
              {{ mode.label }}
            </button>
          </div>
        </div>
        <div class="remote-block">
          <span class="remote-label">Agent 工具开关</span>
          <label v-for="item in TOOL_SWITCHES" :key="item.path" class="remote-switch">
            <input
              type="checkbox"
              :checked="toolValue(item.path)"
              :disabled="busy"
              :data-switch="item.path"
              @change="onToggle(item.path, $event)"
            />
            <span>{{ item.label }}</span>
          </label>
        </div>
        <p v-if="error" class="remote-error">{{ error }}</p>
      </template>
    </template>
  </section>
</template>

<style scoped>
.remote-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
}
.remote-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.remote-label {
  font-size: 12px;
  color: var(--text-2);
}
.mode-row {
  display: flex;
  gap: 8px;
}
.mode-btn.primary {
  background: var(--accent);
  color: #fff;
}
.remote-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}
.remote-switch input:disabled + span {
  color: var(--text-2);
}
.remote-error {
  font-size: 12px;
  color: var(--danger, #d70015);
}
</style>
