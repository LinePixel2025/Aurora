<script setup lang="ts">
/**
 * ClassRoom 模式设置（docs/05 §3、docs/08 §1）：感知文件夹、科目映射、课程表、
 * 课前提醒、分类行为与分类流水。
 *
 * 持久化：`settings.update({ modes: { ...当前 modes, classroom: { ...当前 classroom, 改动 } } })`。
 * `settings:update` 按**顶层分组**做局部合并，但 `modes.classroom` 是整体替换的对象，
 * 因此这里始终先展开当前值再覆盖被修改的字段（与旧版 `saveClassroomField` 同一模式）。
 */
import { computed, ref } from 'vue'
import type { ClassroomModeConfig, Lesson, ScheduleProviderId, SubjectConfig } from '@aurora/shared'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import ClassificationLedger from '../../shared/components/ClassificationLedger.vue'
import SettingField from '../../shared/components/SettingField.vue'
import { useSettingsStore } from '../../shared/stores.js'

const settingsStore = useSettingsStore()
const error = ref<string | null>(null)
const message = ref<string | null>(null)

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const modes = computed(() => settingsStore.settings?.modes ?? null)
const classroom = computed<ClassroomModeConfig | null>(() => modes.value?.classroom ?? null)
const subjects = computed<SubjectConfig[]>(() => classroom.value?.subjects ?? [])
const lessons = computed<Lesson[]>(() => classroom.value?.schedule.lessons ?? [])

/** 滑条拖动中的草稿值：松手才落盘，避免每拖一格都写配置。 */
const thresholdDraft = ref<number | null>(null)
const threshold = computed(
  () => thresholdDraft.value ?? classroom.value?.classification.confidenceThreshold ?? 0.6,
)

async function patch(change: Partial<ClassroomModeConfig>): Promise<boolean> {
  const current = classroom.value
  const all = modes.value
  if (current === null || all === null) return false
  error.value = null
  const ok = await settingsStore.update({ modes: { ...all, classroom: { ...current, ...change } } })
  if (ok) {
    message.value = '已保存'
  } else {
    error.value = settingsStore.error
    message.value = null
  }
  return ok
}

// ───────────────────────── 感知文件夹 ─────────────────────────

async function setWatchDir(value: string): Promise<void> {
  const next = value.trim()
  const current = classroom.value
  if (current === null || next === current.watchDir) return
  await patch({ watchDir: next })
}

async function openWatchDir(): Promise<void> {
  error.value = null
  const result = await window.aurora.app.openPath({ kind: 'watchDir' })
  if (result.ok) message.value = `已打开：${result.value}`
  else error.value = result.message
}

async function openSubjectFolder(name: string): Promise<void> {
  error.value = null
  const result = await window.aurora.app.openPath({ kind: 'subject', subject: name })
  if (result.ok) message.value = `已打开：${result.value}`
  else error.value = result.message
}

// ───────────────────────── 科目 ─────────────────────────

function uniqueSubjectName(existing: string[], base: string): string {
  if (!existing.includes(base)) return base
  let index = 2
  while (existing.includes(`${base}${index}`)) index += 1
  return `${base}${index}`
}

async function addSubject(): Promise<void> {
  const current = classroom.value
  if (current === null) return
  const name = uniqueSubjectName(
    current.subjects.map((item) => item.name),
    '新科目',
  )
  await patch({
    subjects: [...current.subjects, { name, folder: `分类/${name}`, keywords: [] }],
  })
}

async function renameSubject(index: number, value: string): Promise<void> {
  const current = classroom.value
  const subject = current?.subjects[index]
  if (current === null || subject === undefined) return
  const name = value.trim()
  if (name === '') {
    error.value = '科目名不能为空'
    return
  }
  if (name === subject.name) return
  if (current.subjects.some((item, i) => i !== index && item.name === name)) {
    error.value = `科目「${name}」已存在`
    return
  }
  const next = current.subjects.map((item, i) => (i === index ? { ...item, name } : item))
  // 课程表跟随改名，避免留下指向旧科目名的节次
  const nextLessons = current.schedule.lessons.map((lesson) =>
    lesson.subject === subject.name ? { ...lesson, subject: name } : lesson,
  )
  await patch({ subjects: next, schedule: { ...current.schedule, lessons: nextLessons } })
}

async function setSubjectFolder(index: number, value: string): Promise<void> {
  const current = classroom.value
  const subject = current?.subjects[index]
  if (current === null || subject === undefined) return
  const folder = value.trim()
  if (folder === '') {
    error.value = '目标文件夹不能为空'
    return
  }
  if (folder === subject.folder) return
  await patch({
    subjects: current.subjects.map((item, i) => (i === index ? { ...item, folder } : item)),
  })
}

async function setSubjectKeywords(index: number, value: string): Promise<void> {
  const current = classroom.value
  if (current === null || current.subjects[index] === undefined) return
  const keywords = value
    .split(/[,，、;；]/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
  await patch({
    subjects: current.subjects.map((item, i) => (i === index ? { ...item, keywords } : item)),
  })
}

async function removeSubject(index: number): Promise<void> {
  const current = classroom.value
  const subject = current?.subjects[index]
  if (current === null || subject === undefined) return
  const used = current.schedule.lessons.filter((lesson) => lesson.subject === subject.name).length
  const ok = await patch({ subjects: current.subjects.filter((_, i) => i !== index) })
  if (ok && used > 0) {
    message.value = `已删除「${subject.name}」：课程表里还有 ${used} 个同名节次，需要手动调整`
  }
}

// ───────────────────────── 课程表 ─────────────────────────

async function setScheduleProvider(provider: ScheduleProviderId): Promise<void> {
  const current = classroom.value
  if (current === null || current.schedule.provider === provider) return
  await patch({ schedule: { ...current.schedule, provider } })
}

function onProviderChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  if (value === 'manual' || value === 'classisland') void setScheduleProvider(value)
}

async function addLesson(): Promise<void> {
  const current = classroom.value
  if (current === null) return
  const lesson: Lesson = {
    weekday: 1,
    startTime: '08:00',
    endTime: '08:45',
    subject: current.subjects[0]?.name ?? '',
  }
  await patch({ schedule: { ...current.schedule, lessons: [...current.schedule.lessons, lesson] } })
}

async function updateLesson(index: number, change: Partial<Lesson>): Promise<void> {
  const current = classroom.value
  if (current === null || current.schedule.lessons[index] === undefined) return
  const next = current.schedule.lessons.map((lesson, i) =>
    i === index ? { ...lesson, ...change } : lesson,
  )
  await patch({ schedule: { ...current.schedule, lessons: next } })
}

async function removeLesson(index: number): Promise<void> {
  const current = classroom.value
  if (current === null || current.schedule.lessons[index] === undefined) return
  await patch({
    schedule: {
      ...current.schedule,
      lessons: current.schedule.lessons.filter((_, i) => i !== index),
    },
  })
}

// ───────────────────────── 分类行为 ─────────────────────────

async function patchClassification(
  change: Partial<ClassroomModeConfig['classification']>,
): Promise<void> {
  const current = classroom.value
  if (current === null) return
  await patch({ classification: { ...current.classification, ...change } })
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Math.round(value * 100) / 100))
}

function onThresholdInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(value)) thresholdDraft.value = value
}

async function commitThreshold(): Promise<void> {
  const value = thresholdDraft.value
  if (value === null) return
  await patchClassification({ confidenceThreshold: clamp01(value) })
  thresholdDraft.value = null
}

async function setFallbackFolder(value: string): Promise<void> {
  const current = classroom.value
  if (current === null) return
  const folder = value.trim()
  if (folder === '' || folder === current.classification.fallbackFolder) return
  await patchClassification({ fallbackFolder: folder })
}
</script>

<template>
  <section class="classroom">
    <header>
      <h3>ClassRoom 模式设置</h3>
      <p class="tiny muted">
        感知文件夹里的新文件会被自动提取内容 → 判定科目 → 移动到科目文件夹，并写入分类流水 （docs/05
        §3.2）。
      </p>
    </header>

    <AppToast v-if="error" tone="error">{{ error }}</AppToast>
    <AppToast v-if="message" tone="ok">{{ message }}</AppToast>

    <template v-if="classroom">
      <SettingField
        label="感知文件夹"
        hint="监听该目录的新增文件（绝对路径）；留空表示不启用分类管线"
      >
        <span class="grow">
          <input
            type="text"
            spellcheck="false"
            placeholder="D:\感知"
            :value="classroom.watchDir"
            @change="setWatchDir(($event.target as HTMLInputElement).value)"
          />
        </span>
        <AppButton size="sm" @click="openWatchDir">打开文件夹</AppButton>
      </SettingField>

      <div class="divider" />
      <div class="row">
        <h3 class="grow">科目与目标文件夹</h3>
        <AppButton size="sm" @click="addSubject">添加科目</AppButton>
      </div>
      <p class="tiny muted">
        目标文件夹相对感知文件夹（也可填绝对路径）；关键词用于规则命中，多个关键词用逗号分隔。
      </p>

      <p v-if="subjects.length === 0" class="tiny muted">
        还没有科目：判定失败的文件会进入兜底文件夹（见下方「分类行为」）。
      </p>
      <div v-else class="scroll-x">
        <div class="subject-grid head tiny muted">
          <span>科目</span>
          <span>目标文件夹</span>
          <span>关键词（逗号分隔）</span>
          <span />
          <span />
        </div>
        <div v-for="(subject, index) in subjects" :key="index" class="subject-grid">
          <input
            class="input"
            type="text"
            spellcheck="false"
            placeholder="科目名"
            :value="subject.name"
            @change="renameSubject(index, ($event.target as HTMLInputElement).value)"
          />
          <input
            class="input mono"
            type="text"
            spellcheck="false"
            placeholder="分类/数学"
            :value="subject.folder"
            @change="setSubjectFolder(index, ($event.target as HTMLInputElement).value)"
          />
          <input
            class="input"
            type="text"
            spellcheck="false"
            placeholder="数学，公式，习题"
            :value="subject.keywords.join('，')"
            @change="setSubjectKeywords(index, ($event.target as HTMLInputElement).value)"
          />
          <AppButton size="sm" variant="ghost" @click="openSubjectFolder(subject.name)">
            打开
          </AppButton>
          <AppButton size="sm" variant="danger" @click="removeSubject(index)">删除</AppButton>
        </div>
      </div>

      <div class="divider" />
      <h3>课程表</h3>
      <p class="tiny muted">课前 5 分钟提醒并自动打开该科目文件夹（docs/05 §3.4）。</p>

      <SettingField
        label="课程表来源"
        hint="classisland 为 P7 预留：当前返回空课程表，不抛错也不阻塞"
      >
        <select :value="classroom.schedule.provider" @change="onProviderChange">
          <option value="manual">手动维护（默认）</option>
          <option value="classisland">ClassIsland 联动（P7）</option>
        </select>
      </SettingField>

      <div class="row">
        <span class="tiny muted grow">
          共 {{ lessons.length }} 个节次（星期按 0 = 周日 … 6 = 周六）
        </span>
        <AppButton size="sm" @click="addLesson">添加节次</AppButton>
      </div>

      <p v-if="lessons.length === 0" class="tiny muted">还没有节次：课前提醒不会触发。</p>
      <div v-else class="scroll-x">
        <div class="lesson-grid head tiny muted">
          <span>星期</span>
          <span>开始</span>
          <span />
          <span>结束</span>
          <span>科目</span>
          <span />
        </div>
        <div v-for="(lesson, index) in lessons" :key="index" class="lesson-grid">
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
            <option v-for="subject in subjects" :key="subject.name" :value="subject.name">
              {{ subject.name }}
            </option>
            <option
              v-if="lesson.subject !== '' && !subjects.some((item) => item.name === lesson.subject)"
              :value="lesson.subject"
            >
              {{ lesson.subject }}（科目已删除）
            </option>
          </select>
          <AppButton size="sm" variant="danger" @click="removeLesson(index)">删除</AppButton>
        </div>
      </div>

      <div class="divider" />
      <SettingField label="课前提醒" hint="课前 5 分钟系统通知 + 自动打开科目文件夹">
        <label class="row tiny">
          <input
            type="checkbox"
            :checked="classroom.preClassReminder"
            @change="patch({ preClassReminder: ($event.target as HTMLInputElement).checked })"
          />
          <span>开启课前提醒</span>
        </label>
      </SettingField>

      <div class="divider" />
      <h3>分类行为</h3>

      <SettingField label="自动移动文件" hint="关闭后只记录流水、不移动文件（原地保留）">
        <label class="row tiny">
          <input
            type="checkbox"
            :checked="classroom.classification.autoMove"
            @change="
              patchClassification({
                autoMove: ($event.target as HTMLInputElement).checked,
              })
            "
          />
          <span>判定成功后自动归类</span>
        </label>
      </SettingField>

      <SettingField label="置信阈值" hint="低于该置信度的判定不猜，直接进兜底文件夹（0 ～ 1）">
        <input
          class="slider"
          type="range"
          min="0"
          max="1"
          step="0.05"
          :value="threshold"
          @input="onThresholdInput"
          @change="commitThreshold"
        />
        <span class="badge">{{ threshold.toFixed(2) }}</span>
      </SettingField>

      <SettingField label="兜底文件夹" hint="未判定出科目时的去处，相对感知文件夹或绝对路径">
        <input
          type="text"
          spellcheck="false"
          placeholder="待分类"
          :value="classroom.classification.fallbackFolder"
          @change="setFallbackFolder(($event.target as HTMLInputElement).value)"
        />
      </SettingField>

      <div class="divider" />
      <h3>分类流水</h3>
      <p class="tiny muted">
        最近 50 条记录；可直接改到其他科目，用户修正会同步沉淀为分类规则（docs/05 §3.2）。
      </p>
      <ClassificationLedger :limit="50" start-open />
    </template>

    <p v-else class="tiny muted">配置尚未加载完成。</p>
  </section>
</template>

<style scoped>
.classroom {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

header h3 {
  margin: 0;
}

header p {
  margin: 4px 0 0;
}

h3 {
  margin: 0;
  font-size: 14px;
}

.scroll-x {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 2px;
}

.subject-grid {
  display: grid;
  grid-template-columns: 120px minmax(150px, 1fr) minmax(150px, 1fr) auto auto;
  gap: var(--space-2);
  align-items: center;
  min-width: 620px;
}

.lesson-grid {
  display: grid;
  grid-template-columns: 96px 112px 16px 112px minmax(120px, 1fr) auto;
  gap: var(--space-2);
  align-items: center;
  min-width: 620px;
}

.subject-grid.head,
.lesson-grid.head {
  padding-bottom: 2px;
}

.input {
  width: 100%;
  padding: 6px 9px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  background: rgba(0, 0, 0, 0.28);
  outline: none;
  transition: border-color var(--transition-fast);
}

.input:focus {
  border-color: var(--aurora-blue);
}

.slider {
  flex: 1;
  accent-color: var(--aurora-blue);
}

.dash {
  text-align: center;
}
</style>
