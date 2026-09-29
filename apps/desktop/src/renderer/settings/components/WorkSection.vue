<script setup lang="ts">
/**
 * Work 模式设置区（docs/05 §4、docs/08 §1，BetaV2 新增）：办公工作目录。
 *
 * 由 ModesPage 在当前模式为 work 时渲染；非 work 模式下 DOM 里不存在
 * 任何 `modes.work.*` 控件（与 ClassRoom 区组同一套门控口径）。
 *
 * 写回沿用 modes 页的 patch 模式（top-level group 整组 shallow merge 语义）：
 * `settings:update` 只做顶层分组浅合并，`modes` 是整体替换的对象，
 * 必须「先展开当前 modes 再覆盖 work 子对象」，漏一步会静默丢掉其它模式配置。
 */
import { ref } from 'vue'
import AppToast from '../../shared/components/AppToast.vue'
import SettingField from '../../shared/components/SettingField.vue'
import { useSettingsStore } from '../../shared/stores.js'

const settingsStore = useSettingsStore()
const message = ref<string | null>(null)
const error = ref<string | null>(null)

/** 当前工作目录（settings 未加载完时显示空串，保存时再确认配置已就绪） */
function workspaceDir(): string {
  return settingsStore.settings?.modes.work.workspaceDir ?? ''
}

async function setWorkspaceDir(value: string): Promise<void> {
  const settings = settingsStore.settings
  if (!settings) return
  const next = value.trim()
  if (next === settings.modes.work.workspaceDir) return
  error.value = null
  message.value = null
  const ok = await settingsStore.update({
    modes: { ...settings.modes, work: { ...settings.modes.work, workspaceDir: next } },
  })
  if (ok) message.value = '已保存'
  else error.value = settingsStore.error
}
</script>

<template>
  <section class="work anim-rise">
    <header>
      <h2 class="section-title">Work 工作目录</h2>
      <p class="section-desc">
        办公产出（文档 / 表格 / 演示文稿）默认保存在这里，命令类工具的相对路径也按它解析。
      </p>
    </header>

    <AppToast v-if="error" tone="error">{{ error }}</AppToast>
    <AppToast v-else-if="message" tone="ok">{{ message }}</AppToast>

    <section class="section-card">
      <SettingField
        data-field="modes.work.workspaceDir"
        label="工作目录"
        hint="绝对路径；留空 = 未配置（AI 引导时会再次收集）"
      >
        <input
          class="input"
          type="text"
          spellcheck="false"
          placeholder="D:\办公"
          :value="workspaceDir()"
          @change="setWorkspaceDir(($event.target as HTMLInputElement).value)"
        />
      </SettingField>

      <p class="tiny muted">目录不存在时，下次激活 Work 模式会自动创建。</p>
    </section>
  </section>
</template>

<style scoped>
.work {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
</style>
