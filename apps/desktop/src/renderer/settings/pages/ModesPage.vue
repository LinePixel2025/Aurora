<script setup lang="ts">
/** 模式设置页：三模式卡片 + 引导状态 + 重新引导 / 继续引导（docs/07 §2.5）。 */
import { computed, ref } from 'vue'
import type { ModeId } from '@aurora/shared'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import ClassroomSection from '../components/ClassroomSection.vue'
import { useModeStore, useSettingsStore, useWindowStore } from '../../shared/stores.js'

const modeStore = useModeStore()
const settingsStore = useSettingsStore()
const windowStore = useWindowStore()

const busy = ref<ModeId | null>(null)
const message = ref<string | null>(null)
const error = ref<string | null>(null)

/** ClassRoom 专属配置只在 ClassRoom 为当前模式时展示（docs/05 §3）。 */
const classroomActive = computed(() => settingsStore.settings?.modes.current === 'classroom')

async function choose(id: ModeId): Promise<void> {
  busy.value = id
  error.value = null
  message.value = null
  const ok = await modeStore.setCurrent(id)
  busy.value = null
  if (!ok) {
    error.value = modeStore.error ?? '切换失败'
    return
  }
  const summary = modeStore.modes.find((mode) => mode.id === id)
  message.value = summary?.guideCompleted
    ? `已切换到 ${summary.displayName}`
    : `已切换到 ${summary?.displayName}，接下来 AI 会引导你完成配置`
  if (summary && !summary.guideCompleted) await windowStore.showChat()
}

async function restartGuide(id: ModeId): Promise<void> {
  busy.value = id
  await modeStore.resetGuide(id)
  busy.value = null
  message.value = '已重置引导：可在对话窗口继续完成'
  await windowStore.showChat()
}

async function markDone(id: ModeId): Promise<void> {
  await modeStore.completeGuide(id)
  message.value = '已标记该模式引导为完成'
}
</script>

<template>
  <section class="page">
    <header>
      <h2>模式</h2>
      <p class="tiny muted">
        同一时刻只启用一个模式；切换后若引导未完成，AI 会在对话窗口主动发起引导。
      </p>
    </header>

    <AppToast v-if="message" tone="ok">{{ message }}</AppToast>
    <AppToast v-if="error" tone="error">{{ error }}</AppToast>

    <div class="cards">
      <article
        v-for="mode in modeStore.modes"
        :key="mode.id"
        class="card"
        :class="{ active: mode.active, placeholder: mode.placeholder }"
      >
        <header class="card-head">
          <strong>{{ mode.displayName }}</strong>
          <span v-if="mode.active" class="badge ok">当前</span>
          <span v-if="mode.placeholder" class="badge">建设中</span>
          <span v-else-if="!mode.guideCompleted" class="badge warn">待引导</span>
          <span v-else-if="!mode.ready" class="badge warn">未就绪</span>
        </header>
        <p class="tiny muted">{{ mode.description }}</p>
        <p v-if="mode.readinessHint" class="tiny warn-text">{{ mode.readinessHint }}</p>
        <ul class="fields tiny muted">
          <li v-for="field in mode.guideSteps" :key="field" class="mono">{{ field }}</li>
        </ul>
        <footer class="row">
          <AppButton
            size="sm"
            :variant="mode.active ? 'secondary' : 'primary'"
            :disabled="busy !== null || mode.active"
            @click="choose(mode.id)"
          >
            启用
          </AppButton>
          <AppButton
            size="sm"
            variant="ghost"
            :disabled="busy !== null"
            @click="restartGuide(mode.id)"
          >
            重新引导
          </AppButton>
          <AppButton
            v-if="!mode.guideCompleted"
            size="sm"
            variant="ghost"
            :disabled="busy !== null"
            @click="markDone(mode.id)"
          >
            标记完成
          </AppButton>
        </footer>
      </article>
    </div>

    <div v-if="classroomActive" class="divider" />
    <ClassroomSection v-if="classroomActive" />
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-width: 860px;
}

header h2 {
  margin: 0;
  font-size: 16px;
}

header p {
  margin: 4px 0 0;
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: var(--space-3);
}

.card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: rgba(255, 255, 255, 0.03);
}

.card.active {
  border-color: var(--aurora-blue);
  background: rgba(86, 132, 255, 0.08);
}

.card.placeholder {
  opacity: 0.78;
}

.card-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.card p {
  margin: 0;
}

.fields {
  margin: 0;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.warn-text {
  color: #f7c568;
}
</style>
