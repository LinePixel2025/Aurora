<script setup lang="ts">
/**
 * 科目与目标文件夹（docs/05 §3.2）：`modes.classroom.subjects[]` 增删改。
 * 拆分自 `ClassroomSection.vue`；改科目名会同步改写课程表引用（原逻辑原样搬运）。
 */
import type { ClassroomModeConfig } from '@aurora/shared'
import AppButton from '../../../shared/components/AppButton.vue'
import type { ClassroomNotify, ClassroomPatch } from './types.js'

const props = defineProps<{
  classroom: ClassroomModeConfig
  patch: ClassroomPatch
  notify: ClassroomNotify
}>()

function uniqueSubjectName(existing: string[], base: string): string {
  if (!existing.includes(base)) return base
  let index = 2
  while (existing.includes(`${base}${index}`)) index += 1
  return `${base}${index}`
}

async function addSubject(): Promise<void> {
  const name = uniqueSubjectName(
    props.classroom.subjects.map((item) => item.name),
    '新科目',
  )
  await props.patch({
    subjects: [...props.classroom.subjects, { name, folder: `分类/${name}`, keywords: [] }],
  })
}

async function renameSubject(index: number, value: string): Promise<void> {
  const current = props.classroom
  const subject = current.subjects[index]
  if (subject === undefined) return
  const name = value.trim()
  if (name === '') {
    props.notify({ tone: 'error', text: '科目名不能为空' })
    return
  }
  if (name === subject.name) return
  if (current.subjects.some((item, i) => i !== index && item.name === name)) {
    props.notify({ tone: 'error', text: `科目「${name}」已存在` })
    return
  }
  const next = current.subjects.map((item, i) => (i === index ? { ...item, name } : item))
  // 课程表跟随改名，避免留下指向旧科目名的节次
  const nextLessons = current.schedule.lessons.map((lesson) =>
    lesson.subject === subject.name ? { ...lesson, subject: name } : lesson,
  )
  await props.patch({ subjects: next, schedule: { ...current.schedule, lessons: nextLessons } })
}

async function setSubjectFolder(index: number, value: string): Promise<void> {
  const current = props.classroom
  const subject = current.subjects[index]
  if (subject === undefined) return
  const folder = value.trim()
  if (folder === '') {
    props.notify({ tone: 'error', text: '目标文件夹不能为空' })
    return
  }
  if (folder === subject.folder) return
  await props.patch({
    subjects: current.subjects.map((item, i) => (i === index ? { ...item, folder } : item)),
  })
}

async function setSubjectKeywords(index: number, value: string): Promise<void> {
  const current = props.classroom
  if (current.subjects[index] === undefined) return
  const keywords = value
    .split(/[,，、;；]/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
  await props.patch({
    subjects: current.subjects.map((item, i) => (i === index ? { ...item, keywords } : item)),
  })
}

async function removeSubject(index: number): Promise<void> {
  const current = props.classroom
  const subject = current.subjects[index]
  if (subject === undefined) return
  const used = current.schedule.lessons.filter((lesson) => lesson.subject === subject.name).length
  const ok = await props.patch({ subjects: current.subjects.filter((_, i) => i !== index) })
  if (ok && used > 0) {
    props.notify({
      tone: 'warn',
      text: `已删除「${subject.name}」：课程表里还有 ${used} 个同名节次，需要手动调整`,
    })
  }
}

async function openSubjectFolder(name: string): Promise<void> {
  const result = await window.aurora.app.openPath({ kind: 'subject', subject: name })
  if (result.ok) props.notify({ tone: 'ok', text: `已打开：${result.value}` })
  else props.notify({ tone: 'error', text: result.message })
}
</script>

<template>
  <div class="row">
    <span class="section-desc grow">
      目标文件夹相对感知文件夹（也可填绝对路径）；关键词用于规则命中，多个关键词用逗号分隔。
    </span>
    <AppButton size="sm" data-field="modes.classroom.subjects" @click="addSubject">
      添加科目
    </AppButton>
  </div>

  <p
    v-if="classroom.subjects.length === 0"
    class="section-desc"
    data-empty="modes.classroom.subjects"
  >
    还没有科目：判定失败的文件会进入兜底文件夹（见「分类行为」）。
  </p>
  <div v-else class="scroll-x">
    <div class="subject-grid head tiny muted">
      <span>科目</span>
      <span>目标文件夹</span>
      <span>关键词（逗号分隔）</span>
      <span />
      <span />
    </div>
    <div
      v-for="(subject, index) in classroom.subjects"
      :key="index"
      class="subject-grid"
      :data-field="`modes.classroom.subjects[${index}]`"
    >
      <input
        class="input"
        type="text"
        spellcheck="false"
        placeholder="科目名"
        :data-field="`modes.classroom.subjects[${index}].name`"
        :value="subject.name"
        @change="renameSubject(index, ($event.target as HTMLInputElement).value)"
      />
      <input
        class="input mono"
        type="text"
        spellcheck="false"
        placeholder="分类/数学"
        :data-field="`modes.classroom.subjects[${index}].folder`"
        :value="subject.folder"
        @change="setSubjectFolder(index, ($event.target as HTMLInputElement).value)"
      />
      <input
        class="input"
        type="text"
        spellcheck="false"
        placeholder="数学，公式，习题"
        :data-field="`modes.classroom.subjects[${index}].keywords`"
        :value="subject.keywords.join('，')"
        @change="setSubjectKeywords(index, ($event.target as HTMLInputElement).value)"
      />
      <AppButton size="sm" variant="ghost" @click="openSubjectFolder(subject.name)">打开</AppButton>
      <AppButton size="sm" variant="danger" @click="removeSubject(index)">删除</AppButton>
    </div>
  </div>
</template>

<style scoped>
.scroll-x {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  overflow-x: auto;
  padding-bottom: var(--space-1);
}

.subject-grid {
  display: grid;
  grid-template-columns: 120px minmax(150px, 1fr) minmax(150px, 1fr) auto auto;
  gap: var(--space-2);
  align-items: center;
  min-width: 620px;
}

.subject-grid.head {
  padding: var(--space-1) var(--space-2);
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  letter-spacing: var(--tracking-eyebrow);
  border-bottom: 1px solid var(--border-subtle);
}

.subject-grid:not(.head) {
  padding: var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--fill-1);
  transition: background var(--transition-fast);
}

.subject-grid:not(.head):hover {
  background: var(--fill-2);
}
</style>
