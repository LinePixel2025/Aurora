<script setup lang="ts">
/**
 * 敏感工具确认卡片（docs/06 §5 / §9.1）。
 *
 * 工具 `sensitivity === 'confirm'` 时（MCP 工具一律如此）主进程先推送确认请求，
 * 由本卡片回执后放行或拒绝。主进程在 `expiresAt` 之后按「拒绝」处理，
 * 因此倒计时结束时卡片自行收起——用户不会看到一个已经失效的确认框。
 *
 * 视觉（docs/07 §5）：悬浮在对话区之上（`--shadow-3`）+ `.anim-pop` 弹入，
 * 倒计时 ≤15s 转 `--status-error`；确认 / 拒绝用 AppButton 的 primary / danger。
 * 行为链路（IPC 回执、超时按拒绝）保持原样。
 */
import { computed, onUnmounted, ref } from 'vue'
import type { SensitiveToolRequest } from '@aurora/shared'
import AppButton from './AppButton.vue'
import StatusDot from './StatusDot.vue'

const props = defineProps<{ request: SensitiveToolRequest }>()
const emit = defineEmits<{ resolved: [approved: boolean] }>()

const now = ref(Date.now())
const busy = ref(false)
const error = ref<string | null>(null)

const parsed = Date.parse(props.request.expiresAt)
const deadline = Number.isFinite(parsed) ? parsed : Date.now() + 60_000
/** 进度条基准：主进程默认 60s 超时，取卡片创建时刻到截止时刻 */
const totalMs = Math.max(1, deadline - Date.now())

const remainingMs = computed(() => Math.max(0, deadline - now.value))
const remainingSeconds = computed(() => Math.ceil(remainingMs.value / 1000))
const progressPercent = computed(() =>
  Math.min(100, Math.max(0, Math.round((remainingMs.value / totalMs) * 100))),
)
const urgent = computed(() => remainingSeconds.value <= 15)

const inputText = computed(() => prettyPrint(props.request.input))

function prettyPrint(input: unknown): string {
  if (input === undefined || input === null) return '（无参数）'
  if (typeof input === 'string') return input
  try {
    const text = JSON.stringify(input, null, 2)
    if (text === undefined) return String(input)
    return text.length > 1600 ? `${text.slice(0, 1600)}\n…（内容过长已截断）` : text
  } catch {
    return String(input)
  }
}

const timer = window.setInterval(() => {
  now.value = Date.now()
  if (now.value >= deadline) {
    window.clearInterval(timer)
    // 主进程已按超时拒绝：收起卡片，不再回执
    emit('resolved', false)
  }
}, 250)

onUnmounted(() => {
  window.clearInterval(timer)
})

async function decide(approved: boolean): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = null
  const result = await window.aurora.proactive.resolveSensitiveTool(
    props.request.confirmId,
    approved,
  )
  busy.value = false
  if (!result.ok) {
    error.value = result.message
    return
  }
  // `value === false` 表示该确认已超时或 id 未知：主进程已按拒绝处理，直接收起
  emit('resolved', result.value ? approved : false)
}
</script>

<template>
  <article class="sensitive anim-pop" :class="{ urgent }">
    <header class="row">
      <StatusDot tone="error" title="敏感工具确认" />
      <strong>敏感工具执行前需确认</strong>
      <span class="badge">会话 {{ request.sessionId }}</span>
      <span class="grow" />
      <span class="tiny countdown" :class="{ urgent }"> {{ remainingSeconds }} 秒后自动拒绝 </span>
    </header>

    <p class="tiny muted intro">
      工具 <span class="mono tool">{{ request.toolName }}</span>
      属于敏感操作（文件移动 / 删除、命令执行、MCP 工具等），需要你确认后才会执行。
    </p>

    <pre class="args mono">{{ inputText }}</pre>

    <div
      class="progress"
      role="progressbar"
      :aria-valuenow="progressPercent"
      aria-valuemin="0"
      aria-valuemax="100"
    >
      <span :style="{ width: `${progressPercent}%` }" />
    </div>

    <p v-if="error" class="tiny err">{{ error }}</p>

    <footer class="row">
      <span class="tiny muted grow">超时、关闭窗口或会话中止一律按「拒绝」处理。</span>
      <AppButton size="sm" variant="danger" :disabled="busy" @click="decide(false)">拒绝</AppButton>
      <AppButton size="sm" variant="primary" :disabled="busy" @click="decide(true)">
        允许一次
      </AppButton>
    </footer>
  </article>
</template>

<style scoped>
.sensitive {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0 var(--space-3) var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid color-mix(in srgb, var(--status-error) 32%, transparent);
  background: color-mix(in srgb, var(--status-error) 10%, var(--bg-raised));
  box-shadow: var(--shadow-3);
  transition: border-color var(--transition-base);
}

.sensitive.urgent {
  border-color: color-mix(in srgb, var(--status-error) 60%, transparent);
}

.intro {
  margin: 0;
  line-height: var(--leading-normal);
}

.tool {
  padding: 1px 5px;
  border-radius: var(--radius-xs);
  background: var(--bg-base);
  color: var(--text-primary);
}

.args {
  margin: 0;
  max-height: 160px;
  overflow: auto;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  background: var(--bg-base);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  white-space: pre-wrap;
  word-break: break-word;
}

.countdown {
  color: var(--text-secondary);
  flex: 0 0 auto;
}

/* ≤15s：倒计时与进度条转错误语义色（docs/06 §5） */
.countdown.urgent {
  color: var(--status-error);
}

.progress {
  height: 4px;
  border-radius: var(--radius-pill);
  overflow: hidden;
  background: var(--fill-3);
}

.progress span {
  display: block;
  height: 100%;
  border-radius: var(--radius-pill);
  background: var(--aurora-gradient);
  transition: width var(--dur-base) linear;
}

.sensitive.urgent .progress span {
  background: var(--status-error);
}

.err {
  margin: 0;
  color: var(--status-error);
}

footer {
  gap: var(--space-2);
}
</style>
