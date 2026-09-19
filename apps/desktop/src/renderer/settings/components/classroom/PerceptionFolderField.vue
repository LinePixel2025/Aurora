<script setup lang="ts">
/**
 * 感知文件夹（docs/05 §3.2）：`modes.classroom.watchDir` + 「打开文件夹」。
 * 拆分自 `ClassroomSection.vue`（原文件 682 行）；写盘语义见 `./types.js`。
 */
import type { ClassroomModeConfig } from '@aurora/shared'
import AppButton from '../../../shared/components/AppButton.vue'
import SettingField from '../../../shared/components/SettingField.vue'
import type { ClassroomNotify, ClassroomPatch } from './types.js'

const props = defineProps<{
  classroom: ClassroomModeConfig
  patch: ClassroomPatch
  notify: ClassroomNotify
}>()

async function setWatchDir(value: string): Promise<void> {
  const next = value.trim()
  if (next === props.classroom.watchDir) return
  await props.patch({ watchDir: next })
}

async function openWatchDir(): Promise<void> {
  const result = await window.aurora.app.openPath({ kind: 'watchDir' })
  if (result.ok) props.notify({ tone: 'ok', text: `已打开：${result.value}` })
  else props.notify({ tone: 'error', text: result.message })
}
</script>

<template>
  <SettingField
    data-field="modes.classroom.watchDir"
    label="感知文件夹"
    hint="监听该目录的新增文件（绝对路径）；留空表示不启用分类管线"
  >
    <span class="grow">
      <input
        class="input"
        type="text"
        spellcheck="false"
        placeholder="D:\感知"
        :value="classroom.watchDir"
        @change="setWatchDir(($event.target as HTMLInputElement).value)"
      />
    </span>
    <AppButton size="sm" @click="openWatchDir">打开文件夹</AppButton>
  </SettingField>

  <p class="section-desc">
    文件夹里的新文件会被自动提取内容 → 判定科目 → 移动到科目文件夹，并写入分类流水（docs/05 §3.2）。
  </p>
</template>
