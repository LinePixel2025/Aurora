<script setup lang="ts">
/**
 * Aurora Center 连接状态区组（docs/12 §7）：挂载时与每 5 秒轮询
 * `center:status`，展示启用 / 连接状态 / 服务器地址 / 展示名与最近一次错误。
 *
 * 这里只读**连接器实时状态**（不读配置）：地址与展示名以连接器当前生效值为准，
 * 与上面两卡的草稿互不干扰 —— 配置改了没保存、或保存后连接器还没重连，两处不同是正常的。
 * 设置页此前没有轮询先例（MCP 用推送），Center 连接器只暴露 status 查询，
 * 每 5 秒轮询一次是 docs/12 §7 定下的最简单口径。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { ChevronRight } from '../../shared/icons.js'
import type { CenterConnectionStatus } from '@aurora/shared/browser'
import StatusDot from '../../shared/components/StatusDot.vue'

/** 轮询周期（docs/12 §7）：连接状态是低频变化量，5 秒足够 */
const POLL_MS = 5_000

/** 区组折叠状态（默认展开：状态与探针锚点常在 DOM 里） */
const open = ref(true)

const status = ref<CenterConnectionStatus | null>(null)

let timer: ReturnType<typeof setInterval> | undefined

async function refresh(): Promise<void> {
  const result = await window.aurora.center.status()
  // 拉取失败保留上一次状态（连接器暂不可用 ≠ 状态清空）
  if (result.ok) status.value = result.value
}

onMounted(() => {
  void refresh()
  timer = setInterval(() => void refresh(), POLL_MS)
})

onUnmounted(() => {
  if (timer !== undefined) clearInterval(timer)
  timer = undefined
})

const STATE_LABELS: Record<CenterConnectionStatus['state'], string> = {
  disabled: '未启用',
  connecting: '连接中…',
  connected: '已连接',
  error: '连接失败',
}

function stateLabel(): string {
  if (status.value === null) return '暂无状态'
  return STATE_LABELS[status.value.state]
}

/**
 * 状态灯走共享 `StatusDot`（docs/07 §1 的语义色），tone 映射与 `McpSection` 同款：
 * 连接中=黄（unread）、失败=红（error）、其余=灰（idle 基色）。
 * 「已连接」的**绿**用内联变量改写基色（`--status-ok`），不新增组件、不用 :deep 覆盖。
 */
function dotTone(): 'idle' | 'unread' | 'error' {
  switch (status.value?.state) {
    case 'error':
      return 'error'
    case 'connecting':
      return 'unread'
    default:
      return 'idle'
  }
}

function dotStyle(): Record<string, string> | undefined {
  return status.value?.state === 'connected' ? { '--status-idle': 'var(--status-ok)' } : undefined
}
</script>

<template>
  <section class="group section-card">
    <button class="group-head" type="button" :aria-expanded="open" @click="open = !open">
      <ChevronRight
        class="chevron"
        :class="{ open }"
        :size="14"
        :stroke-width="1.8"
        aria-hidden="true"
      />
      <span class="section-title">连接状态</span>
      <span class="group-summary tiny muted grow">{{ stateLabel() }}</span>
    </button>

    <Transition name="collapse">
      <div v-if="open" class="group-body">
        <p class="section-desc">
          每 5 秒刷新连接器实时状态；地址与展示名是当前生效值，改完配置要点「保存」才生效。
        </p>

        <div class="status-line" data-field="center.status">
          <StatusDot :tone="dotTone()" :style="dotStyle()" :title="stateLabel()" />
          <strong>{{ stateLabel() }}</strong>
          <span class="badge" :class="status?.enabled ? 'ok' : ''">
            {{ status?.enabled ? '已启用' : '已停用' }}
          </span>
        </div>

        <p class="tiny muted status-detail">
          服务器：{{ status?.serverUrl ? status.serverUrl : '未配置' }}
        </p>
        <p class="tiny muted status-detail">
          展示名：{{ status?.displayName ? status.displayName : '（使用主机名）' }}
        </p>
        <p v-if="status?.state === 'error' && status.lastError" class="tiny status-error">
          最近一次错误：{{ status.lastError }}
        </p>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.status-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) 0;
}

.status-detail {
  margin: 0;
  font-family: var(--font-mono);
}

.status-error {
  margin: 0;
  color: var(--status-error);
}
</style>
