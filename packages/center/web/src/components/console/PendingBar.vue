<script setup lang="ts">
/**
 * 待办栏（docs/12 §10）：确认卡与提问卡**同一条栏**、同款交互。
 *
 * 两种卡片来源不同但语义都是「有人在等一个答复」：
 * - `confirm.request`：敏感工具执行前的确认（60s，超时按拒绝）；
 * - `ask.request`：Agent 的提问（180s，超时按「用户未回答」继续）。
 *
 * 倒计时由这里的秒级心跳统一驱动（一张心跳服务两种卡），归零即按各自的收尾语义摘卡并提示。
 * 会话视图内的卡与本栏共用同一份 state，先到先得 —— 任意一处结算，另一处随 state 消失。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { askCardOf, expireAsk, expireConfirm, sessionKey, state } from '../../state'
import { remainingMs } from '../../lib/format'
import AskCard from './AskCard.vue'
import ConfirmCard from './ConfirmCard.vue'

/** 秒级心跳：驱动所有卡片的倒计时（1s 足够，卡片显示的是整秒） */
const now = ref(Date.now())
let timer: number | undefined

onMounted(() => {
  timer = window.setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onBeforeUnmount(() => {
  if (timer !== undefined) window.clearInterval(timer)
})

/** 未过期的待办（过期的在下面统一清理，不在这里过滤） */
const openConfirms = computed(() =>
  state.confirms.filter((entry) => remainingMs(entry.request.expiresAt, now.value) > 0),
)
/**
 * 提问卡的待办条目（本轮）：**正在看的那个会话里的提问不再列在这里** ——
 * 它已经渲染在那段对话的流内（可答、且答完会留痕），重复列一张同样的卡只会让人困惑。
 * 确认卡不受影响（它本来就只有这一条栏）。
 */
const openAsks = computed(() =>
  state.asks.filter((entry) => {
    if (remainingMs(entry.request.expiresAt, now.value) <= 0) return false
    return sessionKey(entry.clientId, entry.sessionId) !== state.activeSessionKey
  }),
)
const total = computed(() => openConfirms.value.length + openAsks.value.length)

/** 过期清理：客户端那边同样有超时收尾，这里只负责把卡从栏里摘掉并提示 */
function sweepExpired(): void {
  for (const entry of [...state.confirms]) {
    if (remainingMs(entry.request.expiresAt, now.value) <= 0) expireConfirm(entry)
  }
  for (const entry of [...state.asks]) {
    if (remainingMs(entry.request.expiresAt, now.value) <= 0) expireAsk(entry)
  }
}

watch(now, sweepExpired)

const clientNameOf = (clientId: string): string =>
  state.clients.get(clientId)?.client.name ?? clientId

/** 待办来源设备（去重，展示用） */
const sourceNames = computed(() =>
  [
    ...new Set(
      [...openConfirms.value, ...openAsks.value].map((item) => clientNameOf(item.clientId)),
    ),
  ].join('、'),
)
</script>

<template>
  <!--
    淡入淡出（本轮）：待办栏是「有人在等你」的信号，硬切出来会让人怀疑是不是自己点错了；
    `fade` 预设来自共享 theme.css（时长走令牌，`prefers-reduced-motion` 一并降级）。
  -->
  <Transition name="fade">
    <section v-if="total > 0" class="pending-bar" data-panel="pending-bar">
      <header class="bar-head">
        <strong>待处理（{{ total }}）</strong>
        <span class="bar-sub">确认与提问 · 与客户端上的卡片先到先得 · 超时按各自语义收尾</span>
        <span class="grow" />
        <span v-if="sourceNames !== ''" class="bar-src">来源 {{ sourceNames }}</span>
      </header>

      <div class="bar-list">
        <ConfirmCard
          v-for="entry in openConfirms"
          :key="`confirm-${entry.request.confirmId}`"
          :entry="entry"
          :remaining-ms="remainingMs(entry.request.expiresAt, now)"
          @resolved="sweepExpired()"
        />

        <AskCard
          v-for="entry in openAsks"
          :key="`ask-${entry.request.requestId}`"
          :ask="askCardOf(entry)"
          :client-id="entry.clientId"
          :session-id="entry.sessionId"
          :remaining-ms="remainingMs(entry.request.expiresAt, now)"
          @resolved="sweepExpired()"
        />
      </div>
    </section>
  </Transition>
</template>

<style scoped>
.pending-bar {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: 1px solid color-mix(in srgb, var(--status-unread) 40%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--status-unread) 8%, var(--bg-base));
}

.bar-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2);
  color: var(--text-primary);
  font-size: var(--text-sm);
}

.bar-sub {
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.bar-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.bar-note {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.grow {
  flex: 1 1 auto;
}

.bar-src {
  color: var(--text-muted);
  font-size: var(--text-xs);
}

@media (max-width: 720px) {
  .pending-bar {
    padding: var(--space-3);
  }
}
</style>
