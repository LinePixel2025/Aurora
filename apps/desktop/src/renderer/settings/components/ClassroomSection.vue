<script setup lang="ts">
/**
 * ClassRoom 模式设置容器（docs/05 §3、docs/07 §2.5、docs/08 §7）。
 *
 * 本文件曾是 682 行的单文件平铺（感知文件夹 / 科目 / 课表 / 分类行为 / 流水全在一处），
 * 现在只保留三件职责：
 * 1. **读配置**：`modes.classroom` 的唯一读取点；
 * 2. **写配置**：唯一的 `patch()` —— `settings:update` 只做顶层分组浅合并，而
 *    `modes.classroom` 是整体替换的对象，所以必须「先展开当前值再覆盖改动」，
 *    把这件事集中在一处，子组件只描述「哪个字段变成什么」（见 `./classroom/types.ts`）；
 * 3. **折叠分组**：四个配置块各是一个手风琴分组，收起时仍显示状态摘要。
 *
 * 门控：整个组件由 `ModesPage` 在当前模式为 ClassRoom 时才渲染，
 * 因此非 ClassRoom 模式下 DOM 里不存在任何 `modes.classroom.*` 控件。
 */
import { computed, reactive, ref } from 'vue'
import type { ClassroomModeConfig } from '@aurora/shared'
import AppToast from '../../shared/components/AppToast.vue'
import ClassificationBehavior from './classroom/ClassificationBehavior.vue'
import PerceptionFolderField from './classroom/PerceptionFolderField.vue'
import ScheduleEditor from './classroom/ScheduleEditor.vue'
import SubjectsEditor from './classroom/SubjectsEditor.vue'
import type { ClassroomNotify, ClassroomPatch } from './classroom/types.js'
import { useSettingsStore } from '../../shared/stores.js'

const settingsStore = useSettingsStore()
const error = ref<string | null>(null)
const message = ref<string | null>(null)
const messageTone = ref<'ok' | 'warn'>('ok')

const modes = computed(() => settingsStore.settings?.modes ?? null)
const classroom = computed<ClassroomModeConfig | null>(() => modes.value?.classroom ?? null)

/**
 * 唯一的写盘入口：展开当前 `modes` 与 `classroom` 后覆盖改动。
 * 折叠分组拆文件后最容易踩的坑就是丢掉这一步 —— 子组件直接提交部分对象会静默丢字段。
 */
const patch: ClassroomPatch = async (change) => {
  const current = classroom.value
  const all = modes.value
  if (current === null || all === null) return false
  error.value = null
  const ok = await settingsStore.update({ modes: { ...all, classroom: { ...current, ...change } } })
  if (ok) {
    messageTone.value = 'ok'
    message.value = '已保存'
  } else {
    error.value = settingsStore.error
    message.value = null
  }
  return ok
}

/** 子组件的结果统一回到这一处展示，避免每块各飘一个提示 */
const notify: ClassroomNotify = ({ tone, text }) => {
  if (tone === 'error') {
    error.value = text
    return
  }
  error.value = null
  messageTone.value = tone
  message.value = text
}

// ───────────────────────── 折叠分组 ─────────────────────────

type GroupKey = 'perception' | 'subjects' | 'schedule' | 'classification'

/** 默认展开「感知文件夹」与「科目」（首次配置的必经两步），收起「课表」与「分类行为」 */
const open = reactive<Record<GroupKey, boolean>>({
  perception: true,
  subjects: true,
  schedule: false,
  classification: false,
})

function toggle(key: GroupKey): void {
  open[key] = !open[key]
}

/** 收起时也能看到「配了什么」——不强制用户逐个展开 */
const summary = computed(() => {
  const current = classroom.value
  if (current === null) return { perception: '', subjects: '', schedule: '', classification: '' }
  const provider = current.schedule.provider === 'classisland' ? 'ClassIsland' : '手动'
  return {
    perception: current.watchDir === '' ? '未配置感知文件夹' : current.watchDir,
    subjects: `${current.subjects.length} 个科目`,
    schedule: `${provider} · ${current.schedule.lessons.length} 节`,
    classification: `自动移动 ${current.classification.autoMove ? '开' : '关'} · 阈值 ${current.classification.confidenceThreshold.toFixed(2)}`,
  }
})
</script>

<template>
  <section class="classroom anim-rise">
    <header>
      <h2 class="section-title">ClassRoom 配置</h2>
      <p class="section-desc">
        感知文件夹里的新文件会被自动提取内容 → 判定科目 → 移动到科目文件夹，并写入分类流水 （docs/05
        §3.2）。分组可折叠，标题右侧是当前配置摘要。
      </p>
    </header>

    <AppToast v-if="error" tone="error">{{ error }}</AppToast>
    <AppToast v-else-if="message" :tone="messageTone">{{ message }}</AppToast>

    <template v-if="classroom">
      <section class="group section-card">
        <button
          class="group-head"
          type="button"
          :aria-expanded="open.perception"
          @click="toggle('perception')"
        >
          <span class="chevron" :class="{ open: open.perception }" aria-hidden="true">▸</span>
          <span class="section-title">感知文件夹</span>
          <span class="group-summary tiny muted grow">{{ summary.perception }}</span>
        </button>
        <Transition name="collapse">
          <div v-if="open.perception" class="group-body">
            <PerceptionFolderField :classroom="classroom" :patch="patch" :notify="notify" />
          </div>
        </Transition>
      </section>

      <section class="group section-card">
        <button
          class="group-head"
          type="button"
          :aria-expanded="open.subjects"
          @click="toggle('subjects')"
        >
          <span class="chevron" :class="{ open: open.subjects }" aria-hidden="true">▸</span>
          <span class="section-title">科目与目标文件夹</span>
          <span class="group-summary tiny muted grow">{{ summary.subjects }}</span>
        </button>
        <Transition name="collapse">
          <div v-if="open.subjects" class="group-body">
            <SubjectsEditor :classroom="classroom" :patch="patch" :notify="notify" />
          </div>
        </Transition>
      </section>

      <section class="group section-card">
        <button
          class="group-head"
          type="button"
          :aria-expanded="open.schedule"
          @click="toggle('schedule')"
        >
          <span class="chevron" :class="{ open: open.schedule }" aria-hidden="true">▸</span>
          <span class="section-title">课程表与课前提醒</span>
          <span class="group-summary tiny muted grow">{{ summary.schedule }}</span>
        </button>
        <Transition name="collapse">
          <div v-if="open.schedule" class="group-body">
            <ScheduleEditor :classroom="classroom" :patch="patch" :notify="notify" />
          </div>
        </Transition>
      </section>

      <section class="group section-card">
        <button
          class="group-head"
          type="button"
          :aria-expanded="open.classification"
          @click="toggle('classification')"
        >
          <span class="chevron" :class="{ open: open.classification }" aria-hidden="true">▸</span>
          <span class="section-title">分类行为与流水</span>
          <span class="group-summary tiny muted grow">{{ summary.classification }}</span>
        </button>
        <Transition name="collapse">
          <div v-if="open.classification" class="group-body">
            <ClassificationBehavior :classroom="classroom" :patch="patch" :notify="notify" />
          </div>
        </Transition>
      </section>
    </template>

    <p v-else class="section-desc">配置尚未加载完成。</p>
  </section>
</template>

<style scoped>
.classroom {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* 分组卡片沿用设置页描边与静止阴影；只有可交互的头部响应悬停。 */
.group {
  padding: 0;
  gap: 0;
  overflow: hidden;
}

.group-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: var(--control-h-lg);
  padding: var(--space-3) var(--space-4);
  text-align: left;
  transition: background var(--transition-fast);
}

.group-head:hover {
  background: var(--fill-2);
}

.chevron {
  display: inline-block;
  flex: none;
  color: var(--text-muted);
  transition: transform var(--transition-fast);
}

.chevron.open {
  transform: rotate(90deg);
}

.group-summary {
  text-align: right;
  font-variant-numeric: var(--num-tabular);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4) var(--space-4);
  border-top: 1px solid var(--border-subtle);
}
</style>
