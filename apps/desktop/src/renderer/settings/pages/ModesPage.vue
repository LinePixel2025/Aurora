<script setup lang="ts">
/**
 * 模式设置页（docs/07 §2.5，BetaV2 六页 IA）：三模式卡片 + 引导状态。
 *
 * 页面下半部分**只渲染当前模式**的内容：
 * - ClassRoom → 完整配置区（`ClassroomSection`）；
 * - Work → 办公工作目录（`WorkSection`，BetaV2 实装）；
 * - Code → 占位实现说明，不得出现任何 `modes.classroom.*` / `modes.work.*` 控件（docs/05 §2）。
 * 卡片上的「重新引导 / 标记完成」是次级操作，默认收起，避免与「启用」抢视觉重心。
 */
import { computed, ref } from 'vue'
import type { ModeId } from '@aurora/shared'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import ClassroomSection from '../components/ClassroomSection.vue'
import WorkSection from '../components/WorkSection.vue'
import { useModeStore, useSettingsStore, useWindowStore } from '../../shared/stores.js'

const modeStore = useModeStore()
const settingsStore = useSettingsStore()
const windowStore = useWindowStore()

const busy = ref<ModeId | null>(null)
const message = ref<string | null>(null)
const error = ref<string | null>(null)

/** 自动化总开关（v19，docs/13 §2.2）：本地镜像 + 显式保存（与其它页同一写盘链） */
const automationsEnabled = ref(settingsStore.settings?.automations.enabled ?? true)

async function saveAutomationsEnabled(): Promise<void> {
  const ok = await settingsStore.update({
    automations: { enabled: automationsEnabled.value },
  })
  if (ok) {
    message.value = '已保存'
    error.value = null
  } else {
    error.value = settingsStore.error ?? '保存失败'
    automationsEnabled.value = settingsStore.settings?.automations.enabled ?? true
  }
}

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
      <p class="page-sub">同一时刻只启用一个模式；引导未完成时，AI 会在对话窗主动发起引导。</p>
    </header>

    <AppToast v-if="message" tone="ok">{{ message }}</AppToast>
    <AppToast v-if="error" tone="error">{{ error }}</AppToast>

    <!-- 自动化总开关（v19，docs/13 §2.2）：管理入口在主界面左栏「自动化」 -->
    <section class="section-card auto-section" data-field="automations">
      <div class="auto-row">
        <div class="auto-text">
          <strong>自动化</strong>
          <p class="tiny muted">
            按定时或课堂条件自动执行任务；关闭后已有自动化暂停评估，入口在主界面左栏。
          </p>
        </div>
        <label class="auto-switch" :title="automationsEnabled ? '关闭自动化' : '开启自动化'">
          <input
            v-model="automationsEnabled"
            type="checkbox"
            data-field="automations.enabled"
            @change="saveAutomationsEnabled"
          />
          <span class="track" aria-hidden="true"><span class="thumb" /></span>
        </label>
      </div>
    </section>

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
            :variant="mode.active || mode.placeholder ? 'secondary' : 'primary'"
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

    <!-- 只渲染当前模式的内容：ClassRoom 与 Work 各有配置区，Code 仍是占位 -->
    <ClassroomSection v-if="currentMode === 'classroom'" />
    <WorkSection v-else-if="currentMode === 'work'" />
    <section
      v-else-if="currentMode !== null"
      class="section-card empty-state"
      :data-empty="`modes.${currentMode}`"
    >
      <h2 class="section-title">{{ currentLabel }} 暂无可配置项</h2>
      <p class="section-desc">该模式仍是占位实现：对话可用，但没有专属设置项。</p>
      <div class="row">
        <AppButton size="sm" :disabled="busy !== null" @click="choose('classroom')">
          切换到 ClassRoom
        </AppButton>
      </div>
    </section>
  </section>
</template>

<style scoped>
.page > .empty-state {
  padding-block: var(--space-6);
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
  border-style: dashed;
}

.card.placeholder .badge {
  color: var(--text-secondary);
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
  padding-left: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  line-height: var(--leading-normal);
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

/* 自动化总开关区组：单行「说明 + 开关」，弱于模式卡片的视觉重心 */
.auto-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.auto-row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.auto-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.auto-text p {
  margin: 0;
}

.auto-switch {
  position: relative;
  display: inline-flex;
  flex: 0 0 auto;
  cursor: pointer;
}

.auto-switch input {
  position: absolute;
  opacity: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  cursor: pointer;
}

.auto-switch .track {
  display: inline-flex;
  align-items: center;
  width: 34px;
  height: 20px;
  padding: 2px;
  border-radius: var(--radius-pill);
  background: var(--fill-3);
  transition: background var(--transition-fast);
}

.auto-switch .thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  /* 原来写的是不存在的 `--surface-1`（令牌清单里没有这个名字），滑块透明 → 开关看起来
     像一条没有圆点的蓝色胶囊。滑块在两种明暗档都应是强调色上的前景白。 */
  background: var(--on-accent);
  box-shadow: var(--shadow-hairline);
  transition: transform var(--transition-fast);
}

.auto-switch input:checked + .track {
  background: var(--aurora-blue);
}

.auto-switch input:checked + .track .thumb {
  transform: translateX(14px);
}

.auto-switch input:focus-visible + .track {
  outline: 2px solid var(--aurora-blue);
  outline-offset: 2px;
}
</style>
