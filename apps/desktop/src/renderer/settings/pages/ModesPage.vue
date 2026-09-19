<script setup lang="ts">
/**
 * 模式设置页（docs/07 §2.5）：三模式卡片 + 引导状态。
 *
 * 页面下半部分**只渲染当前模式**的内容：
 * - ClassRoom → 完整配置区（`ClassroomSection`）；
 * - Work / Code → 占位实现说明，不得出现任何 `modes.classroom.*` 控件（docs/05 §2）。
 * 卡片上的「重新引导 / 标记完成」是次级操作，默认收起，避免与「启用」抢视觉重心。
 */
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

/** 展开「次级操作」的卡片（同一时刻只展开一张） */
const openActions = ref<ModeId | null>(null)

/** 当前模式（未加载完成时为 null）：决定下方渲染哪一块配置 */
const currentMode = computed<ModeId | null>(() => settingsStore.settings?.modes.current ?? null)

const currentLabel = computed(
  () => modeStore.modes.find((mode) => mode.id === currentMode.value)?.displayName ?? '当前模式',
)

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
      <h1 class="page-title">模式</h1>
      <p class="page-sub">
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
            {{ mode.active ? '已启用' : '启用' }}
          </AppButton>
          <AppButton
            size="sm"
            variant="ghost"
            :aria-expanded="openActions === mode.id"
            @click="openActions = openActions === mode.id ? null : mode.id"
          >
            {{ openActions === mode.id ? '收起' : '引导设置…' }}
          </AppButton>
        </footer>

        <Transition name="collapse">
          <div v-if="openActions === mode.id" class="actions">
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
          </div>
        </Transition>
      </article>
    </div>

    <!-- 只渲染当前模式的内容：ClassRoom 是唯一有配置项的实现 -->
    <ClassroomSection v-if="currentMode === 'classroom'" />
    <section
      v-else-if="currentMode !== null"
      class="section-card empty-state"
      :data-empty="`modes.${currentMode}`"
    >
      <h2 class="section-title">{{ currentLabel }} 暂无可配置项</h2>
      <p class="section-desc">
        该模式仍是占位实现（docs/04 路线图）：对话可用，但没有专属设置项。切到 ClassRoom
        后这里会出现感知文件夹、科目与课表等配置。
      </p>
      <div class="row">
        <AppButton size="sm" :disabled="busy !== null" @click="choose('classroom')">
          切换到 ClassRoom
        </AppButton>
      </div>
    </section>
  </section>
</template>

<style scoped>
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: var(--space-3);
}

.card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast);
}

.card.active {
  border-color: var(--aurora-blue);
  background: var(--fill-2);
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

/* 次级操作：与主按钮同一行但视觉更弱，展开后单独占一行 */
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding-top: var(--space-1);
}

.warn-text {
  color: var(--status-unread);
}
</style>
