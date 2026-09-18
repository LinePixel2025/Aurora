<script setup lang="ts">
/**
 * AI 模型设置页（docs/08 §5）：多 Provider 管理 + 测试连接 + 模型列表。
 * 凭据只以"已设置 / 未设置"呈现，明文永不回传渲染层。
 */
import { computed, reactive, ref, watch } from 'vue'
import {
  PROVIDER_PRESETS,
  type LlmProviderConfig,
  type TestConnectionResult,
} from '@aurora/shared/browser'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import SettingField from '../../shared/components/SettingField.vue'
import { useSettingsStore } from '../../shared/stores.js'

interface ProviderDraft extends LlmProviderConfig {
  id: string
  apiKey: string
  apiKeySet: boolean
}

const settingsStore = useSettingsStore()

const drafts = ref<ProviderDraft[]>([])
const newProviderId = ref('')
const testing = ref<string | null>(null)
const results = reactive<Record<string, TestConnectionResult>>({})
const models = reactive<Record<string, string[]>>({})
const message = ref<string | null>(null)
const error = ref<string | null>(null)

const activeId = computed(() => settingsStore.settings?.llm.active ?? '')

function resultOf(id: string): TestConnectionResult | undefined {
  return results[id]
}

function modelsOf(id: string): string[] {
  return models[id] ?? []
}

function syncDrafts(): void {
  const settings = settingsStore.settings
  if (!settings) return
  drafts.value = Object.entries(settings.llm.providers).map(([id, provider]) => ({
    id,
    ...provider,
    apiKey: '',
    apiKeySet: Boolean((provider as unknown as { apiKeySet?: boolean }).apiKeySet),
  }))
}

watch(
  () => settingsStore.settings,
  () => syncDrafts(),
  { immediate: true },
)

async function saveProvider(draft: ProviderDraft): Promise<boolean> {
  const settings = settingsStore.settings
  if (!settings) return false
  const ok = await settingsStore.update({
    llm: {
      active: settings.llm.active === '' ? draft.id : settings.llm.active,
      providers: {
        ...settings.llm.providers,
        [draft.id]: {
          type: 'openai-compat',
          baseUrl: draft.baseUrl.trim(),
          apiKeyEnc: '',
          model: draft.model.trim(),
          temperature: Number(draft.temperature),
        },
      },
    },
  })
  if (!ok) {
    error.value = settingsStore.error
    return false
  }
  if (draft.apiKey.trim() !== '') {
    const result = await window.aurora.settings.setSecrets({
      [`llm.providers.${draft.id}.apiKey`]: draft.apiKey.trim(),
    })
    if (!result.ok) {
      error.value = result.message
      return false
    }
    draft.apiKey = ''
    if (!result.value.persisted) {
      error.value = '安全存储不可用：API Key 只保留在本次运行的内存中'
    }
  }
  return true
}

async function saveAll(): Promise<void> {
  message.value = null
  error.value = null
  for (const draft of drafts.value) {
    const ok = await saveProvider(draft)
    if (!ok) return
  }
  message.value = '已保存'
}

function addPreset(id: string): void {
  const preset = PROVIDER_PRESETS.find((item) => item.id === id)
  const key = newProviderId.value.trim() === '' ? id : newProviderId.value.trim()
  if (drafts.value.some((draft) => draft.id === key)) {
    error.value = `Provider「${key}」已存在`
    return
  }
  drafts.value.push({
    id: key,
    type: 'openai-compat',
    baseUrl: preset?.baseUrl ?? '',
    apiKeyEnc: '',
    model: preset?.model ?? '',
    temperature: 0.7,
    apiKey: '',
    apiKeySet: false,
  })
  newProviderId.value = ''
  error.value = null
}

async function removeProvider(id: string): Promise<void> {
  const settings = settingsStore.settings
  if (!settings) return
  const next = { ...settings.llm.providers }
  delete next[id]
  const ok = await settingsStore.update({
    llm: {
      active: settings.llm.active === id ? '' : settings.llm.active,
      providers: next,
    },
  })
  if (!ok) {
    error.value = settingsStore.error
    return
  }
  await window.aurora.settings.clearSecret(`llm.providers.${id}.apiKey`)
  syncDrafts()
  message.value = `已删除 ${id}`
}

async function setActive(id: string): Promise<void> {
  const settings = settingsStore.settings
  if (!settings) return
  const ok = await settingsStore.update({
    llm: { active: id, providers: settings.llm.providers },
  })
  if (!ok) error.value = settingsStore.error
  else {
    message.value = `默认模型已切换为 ${id}`
    await settingsStore.refreshAppInfo()
  }
}

async function testProvider(draft: ProviderDraft): Promise<void> {
  testing.value = draft.id
  error.value = null
  const saved = await saveProvider(draft)
  if (!saved) {
    testing.value = null
    return
  }
  const result = await window.aurora.llm.testConnection({
    providerId: draft.id,
    baseUrl: draft.baseUrl,
    apiKey: draft.apiKey,
    model: draft.model,
    withModels: true,
  })
  testing.value = null
  if (result.ok) {
    results[draft.id] = result.value
    models[draft.id] = result.value.models ?? []
  } else {
    error.value = result.message
  }
}

async function loadModels(draft: ProviderDraft): Promise<void> {
  testing.value = draft.id
  const result = await window.aurora.llm.listModels({
    providerId: draft.id,
    baseUrl: draft.baseUrl,
    model: draft.model,
  })
  testing.value = null
  if (result.ok) {
    const ids = result.value.map((item) => item.id)
    models[draft.id] = ids
    message.value = `已拉取 ${ids.length} 个模型`
  } else {
    error.value = result.message
  }
}
</script>

<template>
  <section class="page">
    <header>
      <h2>AI 模型</h2>
      <p class="tiny muted">
        支持任何 OpenAI 兼容服务。凭据使用系统安全存储加密后保存在本机，日志与导出均会脱敏。
      </p>
    </header>

    <AppToast v-if="message" tone="ok">{{ message }}</AppToast>
    <AppToast v-if="error" tone="error">{{ error }}</AppToast>

    <div class="add-row">
      <input
        v-model="newProviderId"
        type="text"
        spellcheck="false"
        placeholder="自定义 provider id（可选）"
      />
      <AppButton
        v-for="preset in PROVIDER_PRESETS"
        :key="preset.id"
        size="sm"
        @click="addPreset(preset.id)"
      >
        + {{ preset.label }}
      </AppButton>
      <AppButton size="sm" variant="ghost" @click="addPreset('custom')">+ 空白配置</AppButton>
    </div>

    <p v-if="drafts.length === 0" class="muted">
      还没有模型配置。至少添加一个并设为默认后，主功能才可用。
    </p>

    <article
      v-for="draft in drafts"
      :key="draft.id"
      class="provider"
      :class="{ active: activeId === draft.id }"
    >
      <header class="provider-head">
        <span class="mono">{{ draft.id }}</span>
        <span v-if="activeId === draft.id" class="badge ok">默认</span>
        <span v-else class="badge">非默认</span>
        <span v-if="draft.apiKeySet" class="badge ok">凭据已保存</span>
        <span v-else class="badge warn">缺少凭据</span>
        <span class="grow" />
        <AppButton
          size="sm"
          variant="ghost"
          :disabled="activeId === draft.id"
          @click="setActive(draft.id)"
        >
          设为默认
        </AppButton>
        <AppButton size="sm" variant="danger" @click="removeProvider(draft.id)">删除</AppButton>
      </header>

      <SettingField label="baseURL" required>
        <input v-model="draft.baseUrl" type="text" spellcheck="false" />
      </SettingField>
      <SettingField label="API Key" :hint="draft.apiKeySet ? '已保存（留空表示不修改）' : '必填'">
        <input v-model="draft.apiKey" type="password" spellcheck="false" placeholder="sk-..." />
      </SettingField>
      <SettingField label="模型名" required>
        <input v-model="draft.model" type="text" spellcheck="false" />
      </SettingField>
      <SettingField label="temperature">
        <input v-model.number="draft.temperature" type="number" min="0" max="2" step="0.1" />
      </SettingField>

      <footer class="row wrap">
        <AppButton size="sm" :disabled="testing !== null" @click="testProvider(draft)">
          {{ testing === draft.id ? '测试中…' : '保存并测试连接' }}
        </AppButton>
        <AppButton
          size="sm"
          variant="ghost"
          :disabled="testing !== null"
          @click="loadModels(draft)"
        >
          拉取模型列表
        </AppButton>
        <AppToast v-if="resultOf(draft.id)" :tone="resultOf(draft.id)?.ok ? 'ok' : 'error'">
          {{ resultOf(draft.id)?.message }}（{{ resultOf(draft.id)?.latencyMs }}ms）
        </AppToast>
      </footer>

      <div v-if="modelsOf(draft.id).length > 0" class="models">
        <button
          v-for="model in modelsOf(draft.id)"
          :key="model"
          type="button"
          class="model-chip"
          @click="draft.model = model"
        >
          {{ model }}
        </button>
      </div>
    </article>

    <footer v-if="drafts.length > 0" class="row">
      <AppButton variant="primary" @click="saveAll">保存全部</AppButton>
      <span class="tiny muted">默认模型 id：{{ activeId || '（未设置）' }}</span>
    </footer>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-width: 860px;
}

header h2 {
  margin: 0;
  font-size: 16px;
}

header p {
  margin: 4px 0 0;
}

.add-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
}

.add-row input {
  min-width: 200px;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  background: rgba(0, 0, 0, 0.28);
}

.provider {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: rgba(255, 255, 255, 0.03);
}

.provider.active {
  border-color: var(--aurora-green);
}

.provider-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
}

.provider-head .mono {
  font-size: 13px;
}

.wrap {
  flex-wrap: wrap;
}

.models {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: var(--space-2);
}

.model-chip {
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 12px;
  font-family: var(--font-mono);
  border: 1px solid var(--border-subtle);
  background: rgba(255, 255, 255, 0.04);
  transition: background var(--transition-fast);
}

.model-chip:hover {
  background: rgba(56, 209, 150, 0.16);
}
</style>
