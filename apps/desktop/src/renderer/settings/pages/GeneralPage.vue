<script setup lang="ts">
/** 常规设置页（docs/08 §1 general / advanced 中的界面相关项）。 */
import { computed, ref, watch } from 'vue'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import SettingField from '../../shared/components/SettingField.vue'
import { usePerceptionStore, useSettingsStore, useWindowStore } from '../../shared/stores.js'

const settingsStore = useSettingsStore()
const windowStore = useWindowStore()
const perception = usePerceptionStore()

const general = computed(() => settingsStore.settings?.general ?? null)
const language = ref(general.value?.language ?? 'zh-CN')
const launchAtLogin = ref(general.value?.launchAtLogin ?? false)
const hotkey = ref(general.value?.hotkey ?? 'Alt+Space')
const edgeEnabled = ref(general.value?.edgeBar.enabled ?? true)
const edgeOpacity = ref(general.value?.edgeBar.opacity ?? 0.9)
const saved = ref<string | null>(null)
const error = ref<string | null>(null)

watch(
  () => settingsStore.settings,
  (next) => {
    if (!next) return
    language.value = next.general.language
    launchAtLogin.value = next.general.launchAtLogin
    hotkey.value = next.general.hotkey
    edgeEnabled.value = next.general.edgeBar.enabled
    edgeOpacity.value = next.general.edgeBar.opacity
  },
  { immediate: true },
)

async function save(): Promise<void> {
  error.value = null
  saved.value = null
  const ok = await settingsStore.update({
    general: {
      language: language.value,
      launchAtLogin: launchAtLogin.value,
      hotkey: hotkey.value.trim() === '' ? 'Alt+Space' : hotkey.value.trim(),
      edgeBar: {
        enabled: edgeEnabled.value,
        opacity: Number(edgeOpacity.value),
        quietHours: general.value?.edgeBar.quietHours ?? null,
      },
    },
  })
  if (ok) saved.value = '已保存'
  else error.value = settingsStore.error
}

async function toggleEdgeBar(): Promise<void> {
  await windowStore.toggle('edge-bar')
}
</script>

<template>
  <section class="page">
    <header>
      <h2>常规</h2>
      <p class="tiny muted">界面语言、开机自启、全局快捷键与右侧提示条。</p>
    </header>

    <SettingField label="界面语言">
      <select v-model="language">
        <option value="zh-CN">简体中文</option>
        <option value="en-US">English</option>
      </select>
    </SettingField>

    <SettingField label="开机自启" hint="登录 Windows 后自动在托盘常驻（P1 已接入）">
      <input v-model="launchAtLogin" type="checkbox" />
    </SettingField>

    <SettingField label="唤出快捷键" hint="全局快捷键在 P1 之后接入，这里先保存期望值">
      <input v-model="hotkey" type="text" spellcheck="false" placeholder="Alt+Space" />
    </SettingField>

    <div class="divider" />

    <SettingField label="右侧提示条" hint="桌面右缘常驻的 8px 提示条">
      <input v-model="edgeEnabled" type="checkbox" />
      <AppButton size="sm" variant="ghost" @click="toggleEdgeBar">立即显隐</AppButton>
    </SettingField>

    <SettingField label="提示条透明度" hint="0.2 ～ 1.0">
      <input v-model.number="edgeOpacity" type="number" min="0.2" max="1" step="0.05" />
    </SettingField>

    <div class="divider" />

    <SettingField label="系统感知预览" hint="P1 已接入时间 / 电源 / 网络；其余采集项在 P5 补齐">
      <div class="column grow">
        <AppToast v-if="perception.summary">
          {{ perception.summary.localTime }} {{ perception.summary.weekday }}
          <template v-if="perception.summary.battery">
            · 电量 {{ perception.summary.battery.percent }}%
          </template>
          <template v-if="perception.summary.network">
            · 网络 {{ perception.summary.network.online ? '在线' : '离线' }}
          </template>
          · 未实现：{{ perception.summary.unknown.join('、') || '无' }}
        </AppToast>
        <div class="row">
          <AppButton size="sm" @click="perception.refresh">刷新</AppButton>
        </div>
      </div>
    </SettingField>

    <footer class="row">
      <AppButton variant="primary" @click="save">保存</AppButton>
      <AppToast v-if="saved" tone="ok">{{ saved }}</AppToast>
      <AppToast v-if="error" tone="error">{{ error }}</AppToast>
    </footer>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-width: 720px;
}

header h2 {
  margin: 0;
  font-size: 16px;
}

header p {
  margin: 4px 0 0;
}

footer {
  margin-top: var(--space-4);
}
</style>
