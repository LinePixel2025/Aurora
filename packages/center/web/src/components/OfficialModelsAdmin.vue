<script setup lang="ts">
/**
 * 管理端官方模型配置（docs/12 §12.1）。
 *
 * 上游 API Key 是 write-only；服务端只返回 apiKeySet。
 */
import { onMounted, ref } from 'vue'
import type {
  CenterOfficialCapability,
  CenterOfficialModelEntry,
  CenterOfficialServiceConfig,
  CenterOfficialServicesConfig,
} from '@aurora/shared'
import { api } from '../lib/api'

const CAPABILITIES: Array<{
  id: CenterOfficialCapability
  label: string
  types: Array<{ value: string; label: string }>
}> = [
  {
    id: 'llm',
    label: '语言模型',
    types: [
      { value: 'openai-compat', label: 'OpenAI 兼容 /chat/completions' },
      { value: 'openai-responses', label: 'OpenAI Responses /responses' },
    ],
  },
  {
    id: 'imagegen',
    label: '图像生成',
    types: [{ value: 'openai-compat', label: 'OpenAI 兼容 /images/generations' }],
  },
  {
    id: 'tts',
    label: '语音合成',
    types: [
      { value: 'openai-compat', label: 'OpenAI 兼容 /audio/speech' },
      { value: 'dashscope', label: 'DashScope 原生' },
    ],
  },
  {
    id: 'stt',
    label: '语音识别',
    types: [
      { value: 'openai-compat', label: 'OpenAI 兼容 /audio/transcriptions' },
      { value: 'dashscope-native', label: 'DashScope 原生' },
    ],
  },
]

const active = ref<CenterOfficialCapability>('llm')
const services = ref<CenterOfficialServicesConfig | null>(null)
const drafts = ref<Record<CenterOfficialCapability, CenterOfficialServiceConfig> | null>(null)
const apiKeys = ref<Record<CenterOfficialCapability, string>>({
  llm: '',
  imagegen: '',
  tts: '',
  stt: '',
})
const loading = ref(true)
const saving = ref(false)
const fetching = ref(false)
const message = ref('')
const error = ref('')

function capabilityConfig() {
  return CAPABILITIES.find((item) => item.id === active.value)!
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const result = await api.admin.modelServices()
    services.value = result.services
    drafts.value = structuredClone(result.services)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '加载失败'
  } finally {
    loading.value = false
  }
}

function currentDraft(): CenterOfficialServiceConfig {
  return drafts.value![active.value]
}

function addModel(): void {
  const service = currentDraft()
  service.models.push(defaultModel(active.value))
}

function removeModel(index: number): void {
  currentDraft().models.splice(index, 1)
}

function modelLabel(entry: CenterOfficialModelEntry): string {
  return entry.label === undefined || entry.label === '' ? entry.id : `${entry.label} (${entry.id})`
}

function defaultModel(capability: CenterOfficialCapability): CenterOfficialModelEntry {
  const base: CenterOfficialModelEntry = { id: '', enabled: true }
  if (capability === 'llm') {
    base.reasoningEffort = 'auto'
    base.contextWindow = 0
    base.vision = false
  } else if (capability === 'imagegen') {
    base.size = 'auto'
  } else if (capability === 'tts') {
    base.voice = ''
    base.speed = 1
    base.format = 'mp3'
  } else {
    base.language = 'zh'
  }
  return base
}

async function fetchModels(): Promise<void> {
  fetching.value = true
  error.value = ''
  try {
    const service = currentDraft()
    const result = await api.admin.fetchModelServiceModels(active.value, {
      type: service.type,
      baseUrl: service.baseUrl,
      ...(apiKeys.value[active.value] === '' ? {} : { apiKey: apiKeys.value[active.value] }),
    })
    const existing = new Map(service.models.map((item) => [item.id, item]))
    service.models = result.models.map(
      (id) => existing.get(id) ?? { ...defaultModel(active.value), id },
    )
    message.value = `已拉取 ${result.models.length} 个模型`
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '拉取失败'
  } finally {
    fetching.value = false
  }
}

async function save(): Promise<void> {
  saving.value = true
  error.value = ''
  message.value = ''
  try {
    const service = currentDraft()
    const result = await api.admin.updateModelService(active.value, {
      ...service,
      ...(apiKeys.value[active.value] === '' ? {} : { apiKey: apiKeys.value[active.value] }),
    })
    services.value![active.value] = result.service
    drafts.value![active.value] = structuredClone(result.service)
    apiKeys.value[active.value] = ''
    message.value = `${capabilityConfig().label}配置已保存`
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存失败'
  } finally {
    saving.value = false
  }
}

onMounted(() => void load())
</script>

<template>
  <section class="ui-card official-admin" data-panel="official-models">
    <header class="official-head">
      <div>
        <h2>官方模型</h2>
        <p>每类能力配置一个上游，模型开放后所有登录客户端都可选择；API Key 只写不回显。</p>
      </div>
      <button class="ui-btn ui-btn--primary" type="button" :disabled="saving" @click="save">
        {{ saving ? '保存中…' : '保存当前能力' }}
      </button>
    </header>

    <p v-if="error" class="ui-error">{{ error }}</p>
    <p v-if="message" class="ui-ok">{{ message }}</p>
    <p v-if="loading" class="official-loading">加载中…</p>

    <template v-if="drafts !== null">
      <nav class="official-tabs">
        <button
          v-for="item in CAPABILITIES"
          :key="item.id"
          type="button"
          class="ui-btn"
          :class="{ 'ui-btn--primary': active === item.id }"
          @click="active = item.id"
        >
          {{ item.label }}
        </button>
      </nav>

      <div class="official-form">
        <label>
          <span>启用</span>
          <input v-model="currentDraft().enabled" type="checkbox" />
        </label>
        <label>
          <span>协议</span>
          <select v-model="currentDraft().type" class="ui-input">
            <option v-for="item in capabilityConfig().types" :key="item.value" :value="item.value">
              {{ item.label }}
            </option>
          </select>
        </label>
        <label class="official-wide">
          <span>Base URL</span>
          <input v-model="currentDraft().baseUrl" class="ui-input" spellcheck="false" />
        </label>
        <label>
          <span>API Key</span>
          <input
            v-model="apiKeys[active]"
            class="ui-input"
            type="password"
            autocomplete="off"
            :placeholder="currentDraft().apiKeySet ? '已保存，留空不修改' : '至少填写一次'"
          />
        </label>
        <label>
          <span>默认模型</span>
          <select v-model="currentDraft().defaultModel" class="ui-input">
            <option value="">（自动选择首个开放模型）</option>
            <option v-for="item in currentDraft().models" :key="item.id" :value="item.id">
              {{ item.id }}
            </option>
          </select>
        </label>
      </div>

      <div class="official-model-tools">
        <button class="ui-btn" type="button" :disabled="fetching" @click="fetchModels">
          {{ fetching ? '拉取中…' : '拉取模型' }}
        </button>
        <button class="ui-btn" type="button" @click="addModel">新增模型</button>
      </div>

      <div class="official-models">
        <article
          v-for="(item, index) in currentDraft().models"
          :key="`${item.id}-${index}`"
          class="official-model-row"
        >
          <label class="official-enable">
            <input v-model="item.enabled" type="checkbox" />
          </label>
          <input v-model="item.id" class="ui-input" placeholder="模型 id" spellcheck="false" />
          <input v-model="item.label" class="ui-input" placeholder="显示名（可选）" />
          <template v-if="active === 'llm'">
            <input
              v-model.number="item.contextWindow"
              class="ui-input official-num"
              type="number"
              min="0"
              placeholder="窗口"
            />
            <select v-model="item.reasoningEffort" class="ui-input">
              <option value="auto">auto</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
            <label class="official-vision"
              ><input v-model="item.vision" type="checkbox" /> 支持图片</label
            >
          </template>
          <template v-else-if="active === 'imagegen'">
            <input v-model="item.size" class="ui-input" placeholder="尺寸 / auto" />
          </template>
          <template v-else-if="active === 'tts'">
            <input v-model="item.voice" class="ui-input" placeholder="音色" />
            <input
              v-model.number="item.speed"
              class="ui-input official-num"
              type="number"
              min="0.25"
              max="4"
              step="0.05"
            />
            <select v-model="item.format" class="ui-input">
              <option value="mp3">mp3</option>
              <option value="opus">opus</option>
              <option value="aac">aac</option>
              <option value="flac">flac</option>
              <option value="wav">wav</option>
              <option value="pcm">pcm</option>
            </select>
          </template>
          <template v-else>
            <input v-model="item.language" class="ui-input" placeholder="语言 / zh" />
          </template>
          <button class="ui-btn ui-btn--danger" type="button" @click="removeModel(index)">
            删除
          </button>
          <span class="official-model-label">{{ modelLabel(item) }}</span>
        </article>
      </div>
    </template>
  </section>
</template>

<style scoped>
.official-admin {
  display: grid;
  gap: var(--space-4);
  padding: var(--space-4);
}

.official-head {
  display: flex;
  justify-content: space-between;
  gap: var(--space-4);
  align-items: start;
}

.official-head h2 {
  margin: 0 0 var(--space-1);
}

.official-head p {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.official-tabs,
.official-model-tools {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.official-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

.official-form label {
  display: grid;
  gap: var(--space-1);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.official-wide {
  grid-column: 1 / -1;
}

.official-models {
  display: grid;
  gap: var(--space-2);
}

.official-model-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--fill-1);
}

.official-model-row .ui-input {
  width: auto;
  min-width: 140px;
}

.official-num {
  width: 100px !important;
}

.official-enable,
.official-vision {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.official-model-label {
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.ui-ok {
  margin: 0;
  color: var(--ok-text);
  font-size: var(--text-sm);
}

.official-loading {
  color: var(--text-secondary);
}

@media (max-width: 760px) {
  .official-head,
  .official-form {
    grid-template-columns: 1fr;
    flex-direction: column;
  }
}
</style>
