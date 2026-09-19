<script setup lang="ts">
/**
 * 高级设置页（docs/08 §6）：网络（代理）、日志、勿扰、安全（敏感工具确认）、
 * 危险操作（打开目录 / 导出脱敏配置 / 重置）。
 *
 * 「重置全部设置」必须二次确认：第一次点击只是把按钮就地变成「确认重置？」，
 * 再点一次才真的执行（原先走原生 `window.confirm`，在无边框窗口里观感割裂且不可测）。
 */
import { computed, ref } from 'vue'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import SettingField from '../../shared/components/SettingField.vue'
import { useSettingsStore } from '../../shared/stores.js'

const settingsStore = useSettingsStore()
const error = ref<string | null>(null)
const message = ref<string | null>(null)
const exported = ref('')
/** 重置的二次确认态：true 时按钮文案变为「确认重置？」 */
const confirmingReset = ref(false)

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
  // 走专用通道（与托盘「打开日志目录」同一实现）
  const result = await window.aurora.app.openLogs()
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

/** 第一次点击只进入确认态，第二次点击才真正重置 */
function onResetClick(): void {
  if (!confirmingReset.value) {
    confirmingReset.value = true
    message.value = null
    error.value = null
    return
  }
  void resetAll()
}

async function resetAll(): Promise<void> {
  confirmingReset.value = false
  const ok = await settingsStore.reset()
  if (ok) message.value = '配置已重置为默认值'
  else error.value = settingsStore.error
}
</script>

<template>
  <section class="page">
    <header>
      <h1 class="page-title">高级</h1>
      <p class="page-sub">网络代理、日志与勿扰时段；排障时可导出脱敏配置。</p>
    </header>

    <AppToast v-if="error" tone="error">{{ error }}</AppToast>
    <AppToast v-if="message" tone="ok">{{ message }}</AppToast>

    <section class="section-card">
      <h2 class="section-title">网络</h2>
      <p class="section-desc">出网统一走 Electron 网络栈，因此代理对模型与 MCP 一并生效。</p>

      <SettingField
        data-field="advanced.proxy"
        label="系统代理"
        hint="留空表示直连；例如 http://127.0.0.1:7890（也可只写 127.0.0.1:7890）。保存后立即对模型与 MCP 生效"
      >
        <input
          class="input"
          type="text"
          spellcheck="false"
          :value="advanced?.proxy ?? ''"
          @change="save({ proxy: ($event.target as HTMLInputElement).value })"
        />
      </SettingField>
    </section>

    <section class="section-card">
      <h2 class="section-title">日志</h2>
      <p class="section-desc">
        日志写入用户数据目录 / <code class="mono">logs</code>，保留 7 天且自动脱敏。
      </p>

      <SettingField data-field="advanced.logLevel" label="日志级别" hint="保存后立即生效">
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

      <div class="row">
        <AppButton size="sm" @click="openLogs">打开日志目录</AppButton>
      </div>
    </section>

    <section class="section-card">
      <h2 class="section-title">勿扰</h2>
      <p class="section-desc">
        仅拦截主动打扰（课前提醒、敏感工具确认），不影响提示条显示；两端都填才生效。
      </p>

      <SettingField
        data-field="advanced.quietHours.start"
        label="勿扰时段开始"
        hint="格式 HH:mm；留空表示不启用"
      >
        <input
          class="input"
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

      <SettingField data-field="advanced.quietHours.end" label="勿扰时段结束">
        <input
          class="input"
          type="text"
          spellcheck="false"
          placeholder="07:00"
          :value="advanced?.quietHours?.end ?? ''"
          @change="
            save({
              quietHours: advanced?.quietHours?.start
                ? {
                    start: advanced.quietHours.start,
                    end: ($event.target as HTMLInputElement).value,
                  }
                : null,
            })
          "
        />
      </SettingField>
    </section>

    <section class="section-card">
      <h2 class="section-title">安全</h2>
      <p class="section-desc">
        移动 / 删除文件、命令执行等敏感工具（MCP 工具一律如此）执行前需要你确认（docs/06 §5）。
      </p>

      <SettingField
        data-field="advanced.confirmSensitiveTools"
        label="敏感工具确认"
        hint="关闭后只写日志留痕、不拦截；每次调用即时判断，改完无需重启"
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
    </section>

    <section class="section-card">
      <h2 class="section-title">危险操作</h2>
      <p class="section-desc">
        重置会恢复默认值并清除已保存的凭据，不可撤销；配置与日志导出均做脱敏处理。
      </p>

      <div class="row wrap">
        <AppButton size="sm" @click="openConfig">打开配置目录</AppButton>
        <AppButton size="sm" variant="ghost" @click="exportRedacted">导出脱敏配置</AppButton>
      </div>

      <pre v-if="exported" class="export mono">{{ exported }}</pre>

      <div class="row wrap">
        <AppButton variant="danger" @click="onResetClick">
          {{ confirmingReset ? '确认重置？' : '重置为默认配置' }}
        </AppButton>
        <AppButton
          v-if="confirmingReset"
          size="sm"
          variant="ghost"
          @click="confirmingReset = false"
        >
          取消
        </AppButton>
        <span v-if="confirmingReset" class="tiny muted">再点一次「确认重置？」才会执行</span>
      </div>
    </section>

    <p class="tiny muted">
      隐私说明：API Key 与 MCP 环境变量使用系统安全存储加密后仅保存在本机；日志、导出配置一律脱敏。
    </p>
  </section>
</template>

<style scoped>
.wrap {
  flex-wrap: wrap;
}

.export {
  max-height: 260px;
  overflow: auto;
  margin: 0;
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}
</style>
