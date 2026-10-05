<script setup lang="ts">
/**
 * 高级设置页（docs/08 §6，BetaV2 六页 IA）：网络（代理）、日志、安全（权限档位）、
 * 危险操作（打开目录 / 导出脱敏配置 / 重置）。
 *
 * 勿扰时段（`advanced.quietHours`）已迁往「通用」页（与提示条静默时段同区，spec §9），
 * 本页不再提供入口；字段本身仍在 Schema 里，其它写入路径不受影响。
 *
 * 「重置全部设置」必须二次确认：第一次点击只是把按钮就地变成「确认重置？」，
 * 再点一次才真的执行（原先走原生 `window.confirm`，在无边框窗口里观感割裂且不可测）。
 *
 * 安全区组的「敏感工具确认」复选框已在 v13 换成**三档权限**（只读 / 变更前确认 / 完全权限）：
 * - 锚点从 `advanced.confirmSensitiveTools` 改为 `agent.permissionMode` ——
 *   **旧锚点已随两档口径一起废弃**（档位字段才是这一行的语义；把旧锚点挂到说明文本上会让
 *   探针以为旧开关还在，属于误导），改探针请一起改；
 * - 写盘走**镜像规则**：`agent.permissionMode` 与老开关 `advanced.confirmSensitiveTools`
 *   同时写（`auto` ⇒ 老开关 `false`，其余 ⇒ `true`）。只写一个会出现「界面选变更前确认、
 *   实际生效 auto」这类错位（老开关优先级见 packages/shared/src/config/permission.ts）；
 * - 控件用原生下拉（与同页「日志级别」同一套 SettingField 样式），选完即存 ——
 *   对话窗 composer 的「完全权限」另有二次确认摩擦，设置页沿用原复选框的单击即存口径。
 */
import { computed, ref } from 'vue'
import type { PermissionMode } from '@aurora/shared'
import { resolvePermissionMode } from '@aurora/shared/browser'
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

/** 三档下拉的选项（顺序固定：由严到宽；出厂默认是「完全权限」，排在最后） */
const PERMISSION_MODES: ReadonlyArray<{ value: PermissionMode; label: string }> = [
  { value: 'readonly', label: '只读' },
  { value: 'confirm', label: '变更前确认' },
  { value: 'auto', label: '完全权限' },
]

/**
 * 当前**生效**档位：走 `resolvePermissionMode`，老配置里只有 `confirmSensitiveTools: false`
 * 的情况会被承接成 `auto`（否则下拉会显示成「变更前确认」，与主进程实际行为不符）。
 * 配置未水合时按更保守的 `confirm` 显示。
 */
const permissionMode = computed<PermissionMode>(() => {
  const settings = settingsStore.settings
  if (settings === null) return 'confirm'
  return resolvePermissionMode(settings)
})

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

/**
 * 保存权限档位：**镜像规则** —— 两个字段同时写。
 * `settings:update` 只有顶层浅合并语义，因此 `agent` / `advanced` 两组都整组展开，
 * 别把 `agent.tools` / `advanced.readonlyPrefixes` 这类兄弟键写丢。
 */
async function savePermissionMode(mode: PermissionMode): Promise<void> {
  const settings = settingsStore.settings
  if (settings === null) return
  const ok = await settingsStore.update({
    agent: { ...settings.agent, permissionMode: mode },
    advanced: { ...settings.advanced, confirmSensitiveTools: mode !== 'auto' },
  })
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
      <h1 class="page-title">系统</h1>
      <p class="page-sub">网络代理、日志与安全；排障时可导出脱敏配置。</p>
    </header>

    <AppToast v-if="error" tone="error">{{ error }}</AppToast>
    <AppToast v-if="message" tone="ok">{{ message }}</AppToast>

    <section class="section-card">
      <h2 class="section-title">网络</h2>
      <p class="section-desc">出网统一走 Electron 网络栈，因此代理对模型与 MCP 一并生效。</p>

      <SettingField
        data-field="advanced.proxy"
        label="系统代理"
        hint="留空表示直连，例 http://127.0.0.1:7890；保存后立即对模型与 MCP 生效"
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
      <h2 class="section-title">安全</h2>
      <p class="section-desc">
        敏感工具是否先问你：<strong>只读</strong>不注册写入与命令类工具，<strong>变更前确认</strong>项目根内直接执行、越界弹卡，<strong>完全权限</strong>不再弹卡。
      </p>

      <!--
        三档权限（v13）：data-field 用档位字段名 `agent.permissionMode`。
        两档时代的 `advanced.confirmSensitiveTools` 锚点已随口径一起废弃（见文件头注释）。
      -->
      <SettingField
        data-field="agent.permissionMode"
        label="权限档位"
        hint="改完无需重启，每次调用即时判断；该档位 AI 改不动，防自我提权"
      >
        <select
          :value="permissionMode"
          @change="savePermissionMode(($event.target as HTMLSelectElement).value as PermissionMode)"
        >
          <option v-for="item in PERMISSION_MODES" :key="item.value" :value="item.value">
            {{ item.label }}
          </option>
        </select>
      </SettingField>
    </section>

    <section class="section-card">
      <h2 class="section-title">危险操作</h2>
      <p class="section-desc">重置会恢复默认值并清除已保存凭据，不可撤销；导出均做脱敏处理。</p>

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
      API Key 与 MCP 环境变量经系统安全存储加密后仅存本机；日志与导出配置一律脱敏。
    </p>
  </section>
</template>

<style scoped>
.page > .section-card {
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-hairline);
}

.page > .section-card:last-of-type {
  border-color: var(--danger-border);
}

.page > .section-card :is(input[type='number'], .mono) {
  font-variant-numeric: var(--num-tabular);
}

.wrap {
  flex-wrap: wrap;
}

.export {
  max-height: 260px;
  overflow: auto;
  margin: 0;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}
</style>
