<script setup lang="ts">
/**
 * Center 官方模型选择（docs/08 §8 / docs/12 §12）。
 *
 * 目录只由主进程从 Center 拉取；这里只写 `center.officialModels`，保留 Provider 与上游凭据
 * 均由主进程维护。
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import { ChevronRight } from '@aurora/shared/browser'
import type {
  CenterOfficialCapability,
  CenterOfficialModelCatalog,
  CenterRuntimeNotice,
  SettingsPatch,
} from '@aurora/shared/browser'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import SettingField from '../../shared/components/SettingField.vue'
import { useSettingsStore } from '../../shared/stores.js'

const settingsStore = useSettingsStore()
const open = ref(true)
const catalog = ref<CenterOfficialModelCatalog | null>(null)
const loading = ref(false)
const error = ref('')
const notice = ref('')

const CAPABILITIES: Array<{
  id: CenterOfficialCapability
  label: string
  hint: string
}> = [
  { id: 'llm', label: '语言模型', hint: '覆盖全局默认；会话级模型仍可单独覆盖' },
  { id: 'imagegen', label: '图像生成', hint: 'generate_image 默认使用该模型' },
  { id: 'tts', label: '语音合成', hint: '消息朗读使用该模型与管理员配置的音色' },
  { id: 'stt', label: '语音识别', hint: '录音转写使用该模型' },
]

const selections = computed(() => settingsStore.settings?.center.officialModels ?? null)
const tokenSet = ref(false)
const centerConnected = ref(false)

async function refreshSecretAndStatus(): Promise<void> {
  const [secret, status] = await Promise.all([
    window.aurora.settings.hasSecret('center.token'),
    window.aurora.center.status(),
  ])
  tokenSet.value = secret.ok && secret.value
  centerConnected.value = status.ok && status.value.connected
}

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  const result = await window.aurora.center.refreshModelServices()
  loading.value = false
  if (!result.ok) {
    error.value = result.message
    return
  }
  catalog.value = result.value
  if (result.value === null) error.value = '当前没有可用的 Center 官方模型目录'
  await refreshSecretAndStatus()
}

function serviceOf(capability: CenterOfficialCapability) {
  return catalog.value?.services[capability]
}

function optionLabel(capability: CenterOfficialCapability, id: string): string {
  const model = serviceOf(capability)?.models.find((item) => item.id === id)
  return model?.label ? `${model.label} · ${id}` : id
}

async function setSelection(
  capability: CenterOfficialCapability,
  enabled: boolean,
  model?: string,
): Promise<void> {
  const current = selections.value?.[capability]
  if (current === undefined) return
  const service = serviceOf(capability)
  const nextModel = model ?? current.model ?? service?.defaultModel ?? service?.models[0]?.id ?? ''
  const patch: SettingsPatch = {
    center: {
      officialModels: {
        ...selections.value!,
        [capability]: { enabled, model: nextModel },
      },
    },
  }
  const ok = await settingsStore.update(patch)
  if (!ok) error.value = settingsStore.error ?? '保存失败'
  else {
    error.value = ''
    notice.value = '已保存'
  }
}

watch(
  () => settingsStore.settings,
  () => {
    void refreshSecretAndStatus()
  },
  { immediate: true },
)

const offModelServices = window.aurora.center.onModelServicesChanged((next) => {
  catalog.value = next
})
const offRuntimeNotice = window.aurora.center.onRuntimeNotice((runtime: CenterRuntimeNotice) => {
  notice.value = runtime.message
})

onUnmounted(() => {
  offModelServices()
  offRuntimeNotice()
})

void refresh()
</script>

<template>
  <section class="group section-card">
    <button class="group-head" type="button" :aria-expanded="open" @click="open = !open">
      <ChevronRight
        class="chevron"
        :class="{ open }"
        :size="14"
        :stroke-width="1.8"
        aria-hidden="true"
      />
      <span class="section-title">官方模型</span>
      <span class="group-summary tiny muted grow">
        {{ tokenSet ? (centerConnected ? '已连接' : '已登录，未连接') : '登录后可用' }}
      </span>
    </button>

    <Transition name="collapse">
      <div v-if="open" class="group-body">
        <p class="section-desc">
          登录 Center 后可直接选择管理员开放的模型；请求经 Center 网关转发，上游密钥不落本机。
        </p>
        <div class="row wrap">
          <AppButton size="sm" :disabled="loading" @click="refresh">
            {{ loading ? '刷新中…' : '刷新模型目录' }}
          </AppButton>
          <AppToast v-if="notice" tone="ok">{{ notice }}</AppToast>
          <AppToast v-if="error" tone="error">{{ error }}</AppToast>
        </div>

        <SettingField
          v-for="item in CAPABILITIES"
          :key="item.id"
          :data-field="`center.officialModels.${item.id}`"
          :label="item.label"
          :hint="item.hint"
        >
          <div class="official-row">
            <label class="tiny">
              <input
                type="checkbox"
                :checked="selections?.[item.id]?.enabled ?? false"
                :disabled="!tokenSet || serviceOf(item.id) === undefined"
                @change="setSelection(item.id, ($event.target as HTMLInputElement).checked)"
              />
              使用 Center 官方服务
            </label>
            <select
              class="input"
              :value="selections?.[item.id]?.model ?? ''"
              :disabled="
                !tokenSet ||
                serviceOf(item.id) === undefined ||
                selections?.[item.id]?.enabled !== true
              "
              @change="setSelection(item.id, true, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">（未选择）</option>
              <option
                v-for="model in serviceOf(item.id)?.models ?? []"
                :key="model.id"
                :value="model.id"
              >
                {{ optionLabel(item.id, model.id) }}
              </option>
            </select>
          </div>
        </SettingField>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.official-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}

.official-row label {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.official-row select {
  min-width: min(100%, 320px);
}
</style>
