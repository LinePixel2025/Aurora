<script setup lang="ts">
/**
 * AI 模型设置页（docs/08 §5）：多 Provider 管理 + 测试连接 + 模型列表。
 * 凭据只以"已设置 / 未设置"呈现，明文永不回传渲染层。
 *
 * 信息层次（step-06）：必填项常显；`temperature` 与「连接测试 / 拉取模型列表」收进
 * 「高级参数」折叠；删除 provider 是危险操作，单独放在卡片最底部。
 */
import { computed, reactive, ref, watch } from 'vue'
import {
  DEFAULT_REASONING_EFFORT,
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
/** 「添加 Provider」面板与每张卡片的「高级参数」都默认收起，页面首屏只留必填项 */
const showAdd = ref(false)
const advancedOpen = reactive<Record<string, boolean>>({})

const activeId = computed(() => settingsStore.settings?.llm.active ?? '')

function resultOf(id: string): TestConnectionResult | undefined {
  return results[id]
}

function modelsOf(id: string): string[] {
  return models[id] ?? []
}

function toggleAdvanced(id: string): void {
  advancedOpen[id] = !advancedOpen[id]
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
          reasoningEffort: draft.reasoningEffort,
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
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    apiKey: '',
    apiKeySet: false,
  })
  newProviderId.value = ''
  error.value = null
  showAdd.value = false
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
      <h1 class="page-title">AI 模型</h1>
      <p class="page-sub">
        支持任何 OpenAI 兼容服务。凭据使用系统安全存储加密后保存在本机，日志与导出均会脱敏。
      </p>
    </header>

    <AppToast v-if="message" tone="ok">{{ message }}</AppToast>
    <AppToast v-if="error" tone="error">{{ error }}</AppToast>

    <!-- 空状态：没有任何 provider 时不摆一排空卡片，直接给主入口 -->
    <section v-if="drafts.length === 0" class="section-card empty-state" data-empty="llm.providers">
      <h2 class="section-title">还没有 AI 模型配置</h2>
      <p class="section-desc">
        至少添加一个 Provider 并设为默认后，主功能才可用；未配置时启动会进入首次引导向导。
      </p>
      <div class="row">
        <AppButton variant="primary" @click="showAdd = true">添加 AI 模型</AppButton>
      </div>
    </section>

    <section v-if="showAdd" class="section-card">
      <h2 class="section-title">添加 Provider</h2>
      <p class="section-desc">选一个预设快速填好 Base URL 与模型名，或填自定义 id 后手动配置。</p>
      <div class="add-row">
        <input
          v-model="newProviderId"
          class="input"
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
        <AppButton size="sm" variant="ghost" @click="showAdd = false">取消</AppButton>
      </div>
    </section>

    <article
      v-for="draft in drafts"
      :key="draft.id"
      class="section-card"
      :class="{ accent: activeId === draft.id }"
      :data-field="`llm.providers.${draft.id}`"
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
          data-field="llm.active"
          :disabled="activeId === draft.id"
          @click="setActive(draft.id)"
        >
          {{ activeId === draft.id ? '已是默认' : '设为默认' }}
        </AppButton>
      </header>

      <!-- 必填项常显 -->
      <SettingField
        :data-field="`llm.providers.${draft.id}.baseUrl`"
        label="baseURL"
        required
        hint="OpenAI 兼容端点，例如 https://api.deepseek.com/v1"
      >
        <input v-model="draft.baseUrl" class="input" type="text" spellcheck="false" />
      </SettingField>
      <SettingField
        :data-field="`llm.providers.${draft.id}.apiKey`"
        label="API Key"
        :hint="draft.apiKeySet ? '已保存（留空表示不修改）' : '必填'"
      >
        <input
          v-model="draft.apiKey"
          class="input"
          type="password"
          spellcheck="false"
          placeholder="sk-..."
        />
      </SettingField>
      <SettingField
        :data-field="`llm.providers.${draft.id}.model`"
        label="模型名"
        required
        hint="例：deepseek-chat；拉取模型列表后可直接点选"
      >
        <input v-model="draft.model" class="input" type="text" spellcheck="false" />
      </SettingField>

      <button
        class="more"
        type="button"
        :aria-expanded="advancedOpen[draft.id] === true"
        @click="toggleAdvanced(draft.id)"
      >
        <span class="chevron" :class="{ open: advancedOpen[draft.id] === true }" aria-hidden="true"
          >▸</span
        >
        高级参数与连接测试
      </button>

      <Transition name="collapse">
        <div v-if="advancedOpen[draft.id] === true" class="advanced">
          <SettingField
            :data-field="`llm.providers.${draft.id}.temperature`"
            label="temperature"
            hint="0 ～ 2；越高越发散，默认 0.7"
          >
            <input
              v-model.number="draft.temperature"
              class="input"
              type="number"
              min="0"
              max="2"
              step="0.1"
            />
          </SettingField>

          <SettingField
            :data-field="`llm.providers.${draft.id}.reasoningEffort`"
            label="思考等级"
            hint="auto 不指定该参数，兼容性最好；越高越深入，但更慢更贵"
          >
            <select v-model="draft.reasoningEffort" class="input">
              <option value="auto">auto（不指定，兼容性最好）</option>
              <option value="low">low（更快）</option>
              <option value="medium">medium</option>
              <option value="high">high（更深入）</option>
            </select>
          </SettingField>

          <div class="row wrap">
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
          </div>

          <div v-if="modelsOf(draft.id).length > 0" class="models">
            <button
              v-for="model in modelsOf(draft.id)"
              :key="model"
              type="button"
              class="model-chip interactive"
              @click="draft.model = model"
            >
              {{ model }}
            </button>
          </div>
        </div>
      </Transition>

      <!-- 危险操作放卡片最底部，与必填项隔开 -->
      <footer class="danger-zone">
        <AppButton size="sm" variant="danger" @click="removeProvider(draft.id)">
          删除这个 Provider
        </AppButton>
      </footer>
    </article>

    <footer v-if="drafts.length > 0" class="row wrap">
      <AppButton variant="primary" @click="saveAll">保存全部</AppButton>
      <AppButton size="sm" variant="ghost" @click="showAdd = !showAdd">+ 添加 Provider</AppButton>
      <span class="tiny muted">默认模型 id：{{ activeId || '（未设置）' }}</span>
    </footer>
  </section>
</template>

<style scoped>
.add-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
}

.add-row .input {
  min-width: 200px;
  width: auto;
}

.provider-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.provider-head .mono {
  font-size: var(--text-base);
}

/* 折叠入口：与分组头一致的弱化按钮 */
.more {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  transition: color var(--transition-fast);
}

.more:hover {
  color: var(--text-primary);
}

.chevron {
  display: inline-block;
  color: var(--text-muted);
  transition: transform var(--transition-fast);
}

.chevron.open {
  transform: rotate(90deg);
}

.advanced {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  border-top: 1px solid var(--border-subtle);
  padding-top: var(--space-2);
}

.wrap {
  flex-wrap: wrap;
}

.models {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.model-chip {
  padding: 3px 9px;
  border-radius: var(--radius-pill);
  font-size: var(--text-sm);
  font-family: var(--font-mono);
  border: 1px solid var(--border-subtle);
  background: var(--fill-2);
}

.model-chip:hover {
  background: var(--fill-3);
}

.danger-zone {
  margin-top: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-subtle);
}
</style>
