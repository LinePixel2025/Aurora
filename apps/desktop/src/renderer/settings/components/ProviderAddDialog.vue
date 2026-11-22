<script setup lang="ts">
/**
 * 模型 Provider 添加弹窗（2026-11 前端重构）。
 *
 * AI 模型 / TTS / STT / 生图四个页面共用同一套添加流程：选择预设（可选）、填写
 * provider id 与能力相关字段，提交后由父级落盘并打开编辑卡继续配置高级项。
 * 弹窗只做表单与本地校验，不直接写配置；凭据仍由父级走 `settings:setSecrets`。
 */
import { computed, reactive, ref } from 'vue'
import {
  IMAGEGEN_SIZES,
  Plus,
  RESOURCE_NAME_PATTERN,
  RESOURCE_NAME_RULE,
  TTS_FORMATS,
  TTS_INSTRUCTIONS_MAX_CHARS,
  TTS_LANGUAGES,
  TTS_LANGUAGE_LABELS,
  type TtsFormat,
} from '@aurora/shared/browser'
import AppButton from '../../shared/components/AppButton.vue'
import SettingField from '../../shared/components/SettingField.vue'
import SettingsDialog from './SettingsDialog.vue'

export type ProviderCapability = 'llm' | 'tts' | 'stt' | 'imagegen'

export interface ProviderPresetOption {
  id: string
  label: string
  type?: string
  baseUrl?: string
  model?: string
  voice?: string
  language?: string
  size?: string
}

export interface ProviderAddPayload {
  id: string
  type: string
  baseUrl: string
  apiKey: string
  model: string
  voice: string
  instructions: string
  language: string
  speed: number
  format: string
  size: string
}

const props = withDefaults(
  defineProps<{
    capability: ProviderCapability
    title: string
    presets: readonly ProviderPresetOption[]
    typeOptions?: readonly { value: string; label: string }[]
    /** 已存在的 provider id（含 `center-*` 保留 id），用于重名校验 */
    existingIds: readonly string[]
    /** 父级正在保存 */
    busy?: boolean
    /** 父级保存失败的错误文案 */
    error?: string
  }>(),
  { typeOptions: () => [], busy: false, error: '' },
)

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'submit', payload: ProviderAddPayload): void
}>()

const localError = ref('')
const shownError = computed(() => localError.value || props.error)

const form = reactive({
  id: '',
  type: props.typeOptions[0]?.value ?? 'openai-compat',
  baseUrl: '',
  apiKey: '',
  model: '',
  voice: '',
  instructions: '',
  language: props.capability === 'stt' ? 'zh' : 'auto',
  speed: 1,
  format: 'mp3' as TtsFormat,
  size: '1024x1024',
})

const withType = computed(() => props.capability !== 'imagegen')
const isTts = computed(() => props.capability === 'tts')
const isStt = computed(() => props.capability === 'stt')
const isImagegen = computed(() => props.capability === 'imagegen')

function applyPreset(preset: ProviderPresetOption): void {
  localError.value = ''
  if (form.id.trim() === '') form.id = preset.id
  if (preset.type !== undefined) form.type = preset.type
  if (preset.baseUrl !== undefined) form.baseUrl = preset.baseUrl
  if (preset.model !== undefined) form.model = preset.model
  if (preset.voice !== undefined) form.voice = preset.voice
  if (preset.language !== undefined) form.language = preset.language
  if (preset.size !== undefined) form.size = preset.size
}

function baseUrlHint(): string {
  if (props.capability === 'tts') {
    return form.type === 'openai-compat'
      ? 'OpenAI 兼容端点，例如 https://api.openai.com/v1'
      : 'DashScope 系根地址，如 https://maas.qianwenaiapi.com/api/v1'
  }
  if (props.capability === 'stt') {
    return form.type === 'dashscope-native'
      ? '阿里云百炼服务根地址，如 https://dashscope.aliyuncs.com'
      : 'OpenAI 兼容端点，例如 https://api.openai.com/v1'
  }
  if (props.capability === 'imagegen') return 'OpenAI 兼容端点，例如 https://api.openai.com/v1'
  return 'OpenAI 兼容端点，例如 https://api.deepseek.com/v1'
}

function modelHint(): string {
  if (props.capability === 'tts') return '例：tts-1；保存后可在编辑卡里拉取候选'
  if (props.capability === 'stt') {
    return form.type === 'dashscope-native' ? '例：qwen3-asr-flash' : '例：whisper-1'
  }
  if (props.capability === 'imagegen') return '例：dall-e-3'
  return '例：deepseek-chat；保存后可拉取模型列表'
}

function voiceHint(): string {
  return '服务端定义的音色 id，例：alloy；可直接填写'
}

function languageHint(): string {
  if (isTts.value) {
    if (form.type === 'openai-compat') return '该协议无语言参数，此项不发送'
    if (form.type === 'dashscope-audio') return '以 language_hints 下发，建议与文本语种一致'
    return '指定语种显著提升质量，自动可能误判语种'
  }
  return '空串 = 服务端自动检测'
}

function speedHint(): string {
  if (form.type === 'dashscope') return 'DashScope 原生协议没有语速参数，此项不会发送'
  if (form.type === 'dashscope-audio') return '0.5 ～ 2.0（协议限制），默认 1；越小越慢'
  return '0.25 ～ 4，默认 1；越小越慢'
}

function formatHint(): string {
  if (form.type === 'dashscope') return 'DashScope 仅下发 wav / mp3 / opus，其余按服务端默认'
  if (form.type === 'dashscope-audio') return '仅 mp3 / wav / opus / pcm，其余按服务端默认'
  return '请求体的 response_format；决定播放时的 MIME 类型'
}

function validate(): string | null {
  const id = form.id.trim()
  if (id === '') return '请填写 provider id'
  if (!RESOURCE_NAME_PATTERN.test(id)) return `Provider「${id}」${RESOURCE_NAME_RULE}`
  if (props.existingIds.includes(id)) return `Provider「${id}」已存在`
  if (form.baseUrl.trim() === '') return '请填写 baseURL'
  if (form.model.trim() === '') return '请填写模型名'
  if (isTts.value && form.voice.trim() === '') return '请填写音色'
  return null
}

function submit(): void {
  if (props.busy) return
  const problem = validate()
  if (problem !== null) {
    localError.value = problem
    return
  }
  localError.value = ''
  emit('submit', {
    id: form.id.trim(),
    type: form.type,
    baseUrl: form.baseUrl.trim(),
    apiKey: form.apiKey,
    model: form.model.trim(),
    voice: form.voice.trim(),
    instructions: form.instructions.trim().slice(0, TTS_INSTRUCTIONS_MAX_CHARS),
    language: form.language.trim(),
    speed: Number(form.speed),
    format: form.format,
    size: form.size,
  })
}

function close(): void {
  if (props.busy) return
  emit('close')
}

function typeChanged(event: Event): void {
  form.type = (event.target as HTMLSelectElement).value
  localError.value = ''
}
</script>

<template>
  <SettingsDialog
    :title="props.title"
    subtitle="填写连接信息；带 * 的为必填项。"
    anchor="settings.add-provider"
    :busy="props.busy"
    :width="720"
    @close="close"
  >
    <template #icon>
      <Plus :size="15" :stroke-width="1.8" />
    </template>
    <div class="preset-row">
      <span class="tiny muted">预设</span>
      <button
        v-for="preset in props.presets"
        :key="preset.id"
        type="button"
        class="preset-chip"
        :data-action="`preset-${preset.id}`"
        @click="applyPreset(preset)"
      >
        {{ preset.label }}
      </button>
    </div>

    <p v-if="shownError !== ''" class="form-error" role="alert">{{ shownError }}</p>

    <SettingField
      data-field="settings.add-provider.id"
      label="Provider ID"
      required
      hint="用于凭据路径与列表展示，不能重复"
    >
      <input
        v-model="form.id"
        class="input"
        type="text"
        spellcheck="false"
        placeholder="例如：deepseek"
        data-field="settings.add-provider.id-input"
      />
    </SettingField>

    <SettingField
      v-if="withType"
      data-field="settings.add-provider.type"
      label="接口类型"
      hint="决定按哪套协议发请求；保存后仍可在编辑卡里切换"
    >
      <select :value="form.type" class="input" @change="typeChanged">
        <option v-for="item in props.typeOptions" :key="item.value" :value="item.value">
          {{ item.label }}
        </option>
      </select>
    </SettingField>

    <SettingField
      data-field="settings.add-provider.baseUrl"
      label="baseURL"
      required
      :hint="baseUrlHint()"
    >
      <input v-model="form.baseUrl" class="input" type="text" spellcheck="false" />
    </SettingField>

    <SettingField
      data-field="settings.add-provider.apiKey"
      label="API Key"
      hint="明文只写入系统安全存储，页面不回显"
    >
      <input
        v-model="form.apiKey"
        class="input"
        type="password"
        spellcheck="false"
        placeholder="sk-..."
      />
    </SettingField>

    <SettingField
      data-field="settings.add-provider.model"
      label="模型名"
      required
      :hint="modelHint()"
    >
      <input v-model="form.model" class="input" type="text" spellcheck="false" />
    </SettingField>

    <template v-if="isTts">
      <SettingField
        data-field="settings.add-provider.voice"
        label="音色"
        required
        :hint="voiceHint()"
      >
        <input
          v-model="form.voice"
          class="input"
          type="text"
          spellcheck="false"
          placeholder="alloy"
        />
      </SettingField>

      <SettingField
        data-field="settings.add-provider.instructions"
        label="语气指令"
        hint="自然语言描述语气情感，仅支持指令控制的模型生效"
      >
        <textarea
          v-model="form.instructions"
          class="input"
          rows="2"
          spellcheck="false"
          :maxlength="TTS_INSTRUCTIONS_MAX_CHARS"
          placeholder="例：用温柔平缓的语气朗读"
        />
      </SettingField>

      <SettingField data-field="settings.add-provider.language" label="语言" :hint="languageHint()">
        <select v-model="form.language" class="input">
          <option v-for="code in TTS_LANGUAGES" :key="code" :value="code">
            {{ TTS_LANGUAGE_LABELS[code] }}
          </option>
        </select>
      </SettingField>

      <SettingField data-field="settings.add-provider.speed" label="语速" :hint="speedHint()">
        <input
          v-model.number="form.speed"
          class="input input-num"
          type="number"
          :min="form.type === 'dashscope-audio' ? 0.5 : 0.25"
          :max="form.type === 'dashscope-audio' ? 2 : 4"
          step="0.05"
        />
      </SettingField>

      <SettingField data-field="settings.add-provider.format" label="输出格式" :hint="formatHint()">
        <select v-model="form.format" class="input">
          <option v-for="format in TTS_FORMATS" :key="format" :value="format">
            {{ format }}
          </option>
        </select>
      </SettingField>
    </template>

    <template v-else-if="isStt">
      <SettingField
        data-field="settings.add-provider.language"
        label="识别语言"
        :hint="languageHint()"
      >
        <input
          v-model="form.language"
          class="input"
          type="text"
          spellcheck="false"
          placeholder="zh"
        />
      </SettingField>
    </template>

    <template v-else-if="isImagegen">
      <SettingField
        data-field="settings.add-provider.size"
        label="生成尺寸"
        hint="请求体的 size 参数；auto = 服务端决定"
      >
        <select v-model="form.size" class="input">
          <option v-for="size in IMAGEGEN_SIZES" :key="size" :value="size">
            {{ size }}
          </option>
        </select>
      </SettingField>
    </template>

    <template #footer>
      <span class="tiny muted">保存后会打开编辑卡，可继续配置模型列表与高级参数</span>
      <span class="grow" />
      <AppButton
        size="sm"
        variant="ghost"
        :disabled="props.busy"
        data-action="cancel-add-provider"
        @click="close"
      >
        取消
      </AppButton>
      <AppButton
        variant="primary"
        size="sm"
        :disabled="props.busy"
        data-action="submit-add-provider"
        @click="submit"
      >
        {{ props.busy ? '保存中…' : '添加' }}
      </AppButton>
    </template>
  </SettingsDialog>
</template>

<style scoped>
.preset-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.preset-chip {
  padding: 3px 10px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  line-height: 18px;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.preset-chip:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.form-error {
  margin: 0;
  padding: 6px 9px;
  border-radius: var(--radius-xs);
  background: var(--error-fill);
  color: var(--error-text);
  font-size: var(--text-xs);
}

.grow {
  flex: 1;
}
</style>
