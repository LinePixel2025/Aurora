<script setup lang="ts">
/** 高级设置页：代理、日志级别、勿扰时段、日志与配置导出、重置（docs/08 §6）。 */
import { computed, ref } from 'vue'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import SettingField from '../../shared/components/SettingField.vue'
import { useSettingsStore } from '../../shared/stores.js'

const settingsStore = useSettingsStore()
const error = ref<string | null>(null)
const message = ref<string | null>(null)
const exported = ref('')

const advanced = computed(() => settingsStore.settings?.advanced ?? null)

async function save(patch: Partial<NonNullable<typeof advanced.value>>): Promise<void> {
  const current = advanced.value
  if (!current) return
  const ok = await settingsStore.update({ advanced: { ...current, ...patch } })
  if (!ok) error.value = settingsStore.error
  else {
    message.value = '已保存'
    error.value = null
  }
}

async function openLogs(): Promise<void> {
  const result = await window.aurora.app.openPath({ kind: 'logs' })
  if (result.ok) message.value = `日志目录：${result.value}`
  else error.value = result.message
}

async function openConfig(): Promise<void> {
  const result = await window.aurora.app.openPath({ kind: 'config' })
  if (result.ok) message.value = `配置目录：${result.value}`
  else error.value = result.message
}

async function exportRedacted(): Promise<void> {
  const result = await window.aurora.settings.exportRedacted()
  if (result.ok) {
    exported.value = JSON.stringify(result.value, null, 2)
    message.value = '已生成脱敏配置（凭据以 *** 代替）'
  } else {
    error.value = result.message
  }
}

async function resetAll(): Promise<void> {
  const confirmed = window.confirm('确定要重置全部配置吗？已保存的 API Key 也会被清除。')
  if (!confirmed) return
  const ok = await settingsStore.reset()
  if (ok) message.value = '配置已重置为默认值'
  else error.value = settingsStore.error
}
</script>

<template>
  <section class="page">
    <header>
      <h2>高级</h2>
      <p class="tiny muted">网络代理、日志与勿扰时段；排障时可导出脱敏配置。</p>
    </header>

    <AppToast v-if="error" tone="error">{{ error }}</AppToast>
    <AppToast v-if="message" tone="ok">{{ message }}</AppToast>

    <SettingField label="系统代理" hint="留空表示直连；例如 http://127.0.0.1:7890">
      <input
        type="text"
        spellcheck="false"
        :value="advanced?.proxy ?? ''"
        @change="save({ proxy: ($event.target as HTMLInputElement).value })"
      />
    </SettingField>

    <SettingField label="日志级别" hint="日志写入 用户数据目录/logs，保留 7 天且自动脱敏">
      <select
        :value="advanced?.logLevel ?? 'info'"
        @change="save({ logLevel: ($event.target as HTMLSelectElement).value as never })"
      >
        <option value="debug">debug</option>
        <option value="info">info</option>
        <option value="warn">warn</option>
        <option value="error">error</option>
      </select>
    </SettingField>

    <SettingField label="勿扰时段开始" hint="格式 HH:mm；留空表示不启用">
      <input
        type="text"
        spellcheck="false"
        placeholder="22:30"
        :value="advanced?.quietHours?.start ?? ''"
        @change="
          save({
            quietHours: ($event.target as HTMLInputElement).value
              ? {
                  start: ($event.target as HTMLInputElement).value,
                  end: advanced?.quietHours?.end ?? '07:00',
                }
              : null,
          })
        "
      />
    </SettingField>

    <SettingField label="勿扰时段结束">
      <input
        type="text"
        spellcheck="false"
        placeholder="07:00"
        :value="advanced?.quietHours?.end ?? ''"
        @change="
          save({
            quietHours: advanced?.quietHours?.start
              ? { start: advanced.quietHours.start, end: ($event.target as HTMLInputElement).value }
              : null,
          })
        "
      />
    </SettingField>

    <SettingField
      label="敏感工具确认"
      hint="移动 / 删除文件、命令执行等敏感工具（MCP 工具一律如此）执行前需要你确认；关闭后只写日志留痕、不拦截（docs/06 §5）"
    >
      <label class="row tiny">
        <input
          type="checkbox"
          :checked="advanced?.confirmSensitiveTools ?? true"
          @change="save({ confirmSensitiveTools: ($event.target as HTMLInputElement).checked })"
        />
        <span>执行前需要确认（默认开启）</span>
      </label>
    </SettingField>

    <div class="divider" />

    <SettingField label="日志与配置">
      <div class="row wrap">
        <AppButton size="sm" @click="openLogs">打开日志目录</AppButton>
        <AppButton size="sm" @click="openConfig">打开配置目录</AppButton>
        <AppButton size="sm" variant="ghost" @click="exportRedacted">导出脱敏配置</AppButton>
      </div>
    </SettingField>

    <pre v-if="exported" class="export mono">{{ exported }}</pre>

    <div class="divider" />

    <SettingField label="重置配置" hint="恢复默认值并清除已保存的凭据（不可撤销）">
      <AppButton variant="danger" @click="resetAll">重置为默认配置</AppButton>
    </SettingField>

    <p class="tiny muted">
      隐私说明：API Key 与 MCP 环境变量使用系统安全存储加密后仅保存在本机；日志、导出配置一律脱敏。
    </p>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-width: 780px;
}

header h2 {
  margin: 0;
  font-size: 16px;
}

header p {
  margin: 4px 0 0;
}

.wrap {
  flex-wrap: wrap;
}

.export {
  max-height: 260px;
  overflow: auto;
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  background: rgba(0, 0, 0, 0.3);
  font-size: 12px;
  line-height: 1.5;
}
</style>
