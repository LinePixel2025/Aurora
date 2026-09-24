<script setup lang="ts">
/**
 * 课程表（docs/05 §3.4）：`schedule.provider` 切换、`lessons[]` 编辑、
 * ClassIsland 桥接子配置（`schedule.classisland.*`，含连接测试与状态），
 * 以及 `preClassReminder` 开关。拆分自 `ClassroomSection.vue`。
 *
 * 门控（step-06 B）：
 * - `classisland.*` 只在 `schedule.provider === 'classisland'` 时存在；
 * - `preClassReminder` 只在 `lessons.length > 0` 时存在（没有节次就没有「课前」）。
 */
import { onMounted, ref, watch } from 'vue'
import type {
  ClassIslandStatus,
  ClassIslandTestResult,
  ClassroomModeConfig,
  Lesson,
  ScheduleProviderId,
} from '@aurora/shared'
import AppButton from '../../../shared/components/AppButton.vue'
import AppToast from '../../../shared/components/AppToast.vue'
import SettingField from '../../../shared/components/SettingField.vue'
import type { ClassroomNotify, ClassroomPatch } from './types.js'

const props = defineProps<{
  classroom: ClassroomModeConfig
  patch: ClassroomPatch
  notify: ClassroomNotify
}>()

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const DEFAULT_CLASSISLAND = { source: 'file' as const, endpoint: '', timeoutMs: 3000 }

const classisland = () => props.classroom.schedule.classisland ?? DEFAULT_CLASSISLAND

async function setScheduleProvider(provider: ScheduleProviderId): Promise<void> {
  const current = props.classroom
  if (current.schedule.provider === provider) return
  await props.patch({ schedule: { ...current.schedule, provider } })
}

function onProviderChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  if (value === 'manual' || value === 'classisland') void setScheduleProvider(value)
}

// ───────────────────────── ClassIsland 桥接（docs/05 §3.4 v2） ─────────────────────────

/** 「测试连接」结果（每次点击覆盖）；改动端点或来源时清空 */
const testResult = ref<ClassIslandTestResult | null>(null)
const testing = ref(false)
/** 最近一次已知的桥接状态（选中 classisland 时拉一次，用于说明「尚未成功读取」的原因） */
const bridgeStatus = ref<ClassIslandStatus | null>(null)

async function refreshBridgeStatus(): Promise<void> {
  const status = await window.aurora.classisland.status()
  if (status.ok) bridgeStatus.value = status.value
}

onMounted(() => {
  // 只在选中 classisland 时查状态，避免每次打开设置页都多一次 IPC
  if (props.classroom.schedule.provider === 'classisland') void refreshBridgeStatus()
})

// 从 manual 切到 classisland 时同样要拉一次：否则只会显示「尚未成功读取」而没有原因
watch(
  () => props.classroom.schedule.provider,
  (next, previous) => {
    if (next === 'classisland' && previous !== 'classisland') void refreshBridgeStatus()
  },
)

async function patchClassisland(
  change: Partial<{ source: 'file' | 'http'; endpoint: string; timeoutMs: number }>,
): Promise<void> {
  const current = props.classroom
  // 改了端点/来源先清掉上次结果：否则会显示「上一个地址」的成功状态，误导人
  testResult.value = null
  await props.patch({
    schedule: {
      ...current.schedule,
      classisland: { ...current.schedule.classisland, ...change },
    },
  })
}

async function testClassisland(): Promise<void> {
  testing.value = true
  try {
    const result = await window.aurora.classisland.test()
    if (!result.ok) {
      props.notify({ tone: 'error', text: result.message })
      return
    }
    testResult.value = result.value
    bridgeStatus.value = {
      enabled: true,
      source: result.value.source,
      endpoint: result.value.endpoint,
      ok: result.value.ok,
      lastSyncAt: result.value.ok ? new Date().toISOString() : null,
      lessonCount: result.value.lessons.length,
      warnings: result.value.warnings,
      ...(result.value.error === undefined ? {} : { error: result.value.error }),
    }
  } finally {
    testing.value = false
  }
}

// ───────────────────────── 课程行 ─────────────────────────

async function addLesson(): Promise<void> {
  const current = props.classroom
  const lesson: Lesson = {
    weekday: 1,
    startTime: '08:00',
    endTime: '08:45',
    subject: current.subjects[0]?.name ?? '',
  }
  await props.patch({
    schedule: { ...current.schedule, lessons: [...current.schedule.lessons, lesson] },
  })
}

async function updateLesson(index: number, change: Partial<Lesson>): Promise<void> {
  const current = props.classroom
  if (current.schedule.lessons[index] === undefined) return
  const next = current.schedule.lessons.map((lesson, i) =>
    i === index ? { ...lesson, ...change } : lesson,
  )
  await props.patch({ schedule: { ...current.schedule, lessons: next } })
}

async function removeLesson(index: number): Promise<void> {
  const current = props.classroom
  if (current.schedule.lessons[index] === undefined) return
  await props.patch({
    schedule: {
      ...current.schedule,
      lessons: current.schedule.lessons.filter((_, i) => i !== index),
    },
  })
}
</script>

<template>
  <SettingField
    data-field="modes.classroom.schedule.provider"
    label="课程表来源"
    hint="手动维护，或从 ClassIsland 桥接插件读取（桥接安装见 docs/10 用户手册）"
  >
    <select :value="classroom.schedule.provider" @change="onProviderChange">
      <option value="manual">手动维护（默认）</option>
      <option value="classisland">ClassIsland 联动</option>
    </select>
  </SettingField>

  <!-- ClassIsland 桥接配置：仅在选中该来源时存在（否则这些字段在 DOM 里不该出现） -->
  <template v-if="classroom.schedule.provider === 'classisland'">
    <SettingField
      data-field="modes.classroom.schedule.classisland.source"
      label="数据来源"
      hint="文件：桥接插件写出的 JSON；HTTP：桥接插件的本地回环端点"
    >
      <select
        :value="classisland().source"
        @change="
          patchClassisland({
            source: ($event.target as HTMLSelectElement).value as 'file' | 'http',
          })
        "
      >
        <option value="file">JSON 文件</option>
        <option value="http">本地 HTTP 端点</option>
      </select>
    </SettingField>

    <SettingField
      data-field="modes.classroom.schedule.classisland.endpoint"
      label="端点 / 文件路径"
      :hint="
        classisland().source === 'file'
          ? '桥接插件写出的 JSON 文件绝对路径（见桥接插件 README）'
          : '桥接插件的本地端点，例如 http://127.0.0.1:17945/schedule'
      "
    >
      <div class="row grow">
        <input
          class="input grow"
          type="text"
          spellcheck="false"
          :value="classisland().endpoint"
          placeholder="留空表示未配置（此时课表为空）"
          @change="patchClassisland({ endpoint: ($event.target as HTMLInputElement).value.trim() })"
        />
        <AppButton
          size="sm"
          data-field="modes.classroom.schedule.classisland"
          :disabled="testing"
          @click="testClassisland"
        >
          {{ testing ? '测试中…' : '测试连接' }}
        </AppButton>
      </div>
    </SettingField>

    <SettingField
      data-field="modes.classroom.schedule.classisland.timeoutMs"
      label="读取超时"
      hint="毫秒；桥接不可用时按此超时降级为空课表，不阻塞主流程"
    >
      <input
        class="input"
        type="number"
        min="200"
        max="30000"
        step="100"
        :value="classisland().timeoutMs"
        @change="patchClassisland({ timeoutMs: Number(($event.target as HTMLInputElement).value) })"
      />
    </SettingField>

    <AppToast v-if="testResult" :tone="testResult.ok ? 'ok' : 'error'">
      <template v-if="testResult.ok">
        读取成功（{{ testResult.elapsedMs }}ms）：今日 {{ testResult.lessons.length }} 节课
        <template v-if="testResult.lessons.length > 0">
          —— {{ testResult.lessons.map((l) => `${l.startTime} ${l.subject}`).join('、') }}
        </template>
      </template>
      <template v-else>读取失败：{{ testResult.error ?? '未知原因' }}</template>
      <template v-if="testResult.warnings.length > 0">
        <br />
        <span class="tiny muted">
          有 {{ testResult.warnings.length }} 条课程被跳过：{{ testResult.warnings[0] }}
        </span>
      </template>
    </AppToast>

    <AppToast v-else-if="bridgeStatus && !bridgeStatus.ok" tone="warn">
      {{
        classisland().endpoint.trim() === ''
          ? '尚未配置端点：课程表会保持为空，课前提醒不会触发。'
          : (bridgeStatus.error ?? '尚未成功读取桥接数据')
      }}
    </AppToast>

    <AppToast v-else-if="bridgeStatus" tone="ok">
      桥接正常：今日 {{ bridgeStatus.lessonCount }} 节课
      <template v-if="bridgeStatus.lastSyncAt">
        （最近同步 {{ new Date(bridgeStatus.lastSyncAt).toLocaleTimeString() }}）
      </template>
    </AppToast>
  </template>

  <div class="row">
    <span class="tiny muted grow">
      共 {{ classroom.schedule.lessons.length }} 个节次（星期按 0 = 周日 … 6 = 周六）
    </span>
    <AppButton size="sm" data-field="modes.classroom.schedule.lessons" @click="addLesson">
      添加节次
    </AppButton>
  </div>

  <p
    v-if="classroom.schedule.lessons.length === 0"
    class="section-desc"
    data-empty="modes.classroom.schedule.lessons"
  >
    还没有节次：课前提醒不会触发。
  </p>
  <div v-else class="scroll-x">
    <div class="lesson-grid head tiny muted">
      <span>星期</span>
      <span>开始</span>
      <span />
      <span>结束</span>
      <span>科目</span>
      <span />
    </div>
    <div
      v-for="(lesson, index) in classroom.schedule.lessons"
      :key="index"
      class="lesson-grid"
      :data-field="`modes.classroom.schedule.lessons[${index}]`"
    >
      <select
        class="input"
        :value="lesson.weekday"
        @change="
          updateLesson(index, { weekday: Number(($event.target as HTMLSelectElement).value) })
        "
      >
        <option v-for="(label, day) in WEEKDAYS" :key="day" :value="day">{{ label }}</option>
      </select>
      <input
        class="input"
        type="time"
        :value="lesson.startTime"
        @change="updateLesson(index, { startTime: ($event.target as HTMLInputElement).value })"
      />
      <span class="tiny muted dash">—</span>
      <input
        class="input"
        type="time"
        :value="lesson.endTime"
        @change="updateLesson(index, { endTime: ($event.target as HTMLInputElement).value })"
      />
      <select
        class="input"
        :value="lesson.subject"
        @change="updateLesson(index, { subject: ($event.target as HTMLSelectElement).value })"
      >
        <option value="">（未指定）</option>
        <option v-for="subject in classroom.subjects" :key="subject.name" :value="subject.name">
          {{ subject.name }}
        </option>
        <option
          v-if="
            lesson.subject !== '' &&
            !classroom.subjects.some((item) => item.name === lesson.subject)
          "
          :value="lesson.subject"
        >
          {{ lesson.subject }}（科目已删除）
        </option>
      </select>
      <AppButton size="sm" variant="danger" @click="removeLesson(index)">删除</AppButton>
    </div>
  </div>

  <template v-if="classroom.schedule.lessons.length > 0">
    <SettingField
      data-field="modes.classroom.preClassReminder"
      label="课前提醒"
      hint="课前 5 分钟系统通知 + 自动打开科目文件夹"
    >
      <label class="row tiny">
        <input
          type="checkbox"
          :checked="classroom.preClassReminder"
          @change="patch({ preClassReminder: ($event.target as HTMLInputElement).checked })"
        />
        <span>开启课前提醒</span>
      </label>
    </SettingField>
  </template>
  <p v-else class="section-desc" data-empty="modes.classroom.preClassReminder">
    先在课表里添加节次，才能开启课前提醒。
  </p>
</template>

<style scoped>
.scroll-x {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  overflow-x: auto;
  padding-bottom: var(--space-1);
}

.lesson-grid {
  display: grid;
  grid-template-columns: 96px 112px 16px 112px minmax(120px, 1fr) auto;
  gap: var(--space-2);
  align-items: center;
  min-width: 620px;
  font-variant-numeric: var(--num-tabular);
}

.lesson-grid.head {
  padding: var(--space-1) var(--space-2);
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  letter-spacing: var(--tracking-eyebrow);
  border-bottom: 1px solid var(--border-subtle);
}

.lesson-grid:not(.head) {
  padding: var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--fill-1);
  transition: background var(--transition-fast);
}

.lesson-grid:not(.head):hover {
  background: var(--fill-2);
}

.dash {
  text-align: center;
}
</style>
