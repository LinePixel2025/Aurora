<script setup lang="ts">
/**
 * 首次安装引导（docs/08 §3）：
 *  欢迎 → AI 模型（必填）→ 模式选择 → ClassRoom 模式引导（表单式）→ 完成
 *
 * 规则：AI 模型未完成不允许进入主界面；测试连接失败允许先保存但持续提示。
 */
import { computed, reactive, ref } from 'vue'
import { PROVIDER_PRESETS, type ModeId, type TestConnectionResult } from '@aurora/shared/browser'
import AppButton from '../shared/components/AppButton.vue'
import AppToast from '../shared/components/AppToast.vue'
import SettingField from '../shared/components/SettingField.vue'
import { useModeStore, useSettingsStore } from '../shared/stores.js'

const settingsStore = useSettingsStore()
const modeStore = useModeStore()

const stepIndex = ref(0)
const steps = ['欢迎', 'AI 模型', '选择模式', '模式设置', '完成'] as const

const form = reactive({
  language: 'zh-CN',
  providerId: PROVIDER_PRESETS[0].id as string,
  baseUrl: PROVIDER_PRESETS[0].baseUrl as string,
  model: PROVIDER_PRESETS[0].model as string,
  apiKey: '',
  temperature: 0.7,
  mode: 'classroom' as ModeId,
  watchDir: '',
  subjects: '语文,数学,英语,物理,化学,生物,历史,地理,政治',
  preClassReminder: true,
})

const testing = ref(false)
const testResult = ref<TestConnectionResult | null>(null)
const saving = ref(false)
const error = ref<string | null>(null)

const selectedMode = computed(() => modeStore.modes.find((mode) => mode.id === form.mode) ?? null)
const modelReady = computed(
  () => form.baseUrl.trim() !== '' && form.model.trim() !== '' && form.apiKey.trim() !== '',
)

function applyPreset(id: string): void {
  const preset = PROVIDER_PRESETS.find((item) => item.id === id)
  if (!preset) return
  form.providerId = preset.id
  form.baseUrl = preset.baseUrl
  form.model = preset.model
  testResult.value = null
}

async function testConnection(): Promise<void> {
  testing.value = true
  testResult.value = null
  error.value = null
  const result = await window.aurora.llm.testConnection({
    baseUrl: form.baseUrl,
    apiKey: form.apiKey,
    model: form.model,
    withModels: true,
  })
  testing.value = false
  if (result.ok) testResult.value = result.value
  else error.value = result.message
}

async function persistModel(): Promise<boolean> {
  const providerKey = form.providerId.trim() === '' ? 'custom' : form.providerId
  const okSettings = await settingsStore.update({
    llm: {
      active: providerKey,
      providers: {
        ...(settingsStore.settings?.llm.providers ?? {}),
        [providerKey]: {
          type: 'openai-compat',
          baseUrl: form.baseUrl.trim(),
          apiKeyEnc: '',
          model: form.model.trim(),
          temperature: form.temperature,
        },
      },
    },
  })
  if (!okSettings) return false

  const secretResult = await window.aurora.settings.setSecrets({
    [`llm.providers.${providerKey}.apiKey`]: form.apiKey.trim(),
  })
  if (!secretResult.ok) {
    error.value = secretResult.message
    return false
  }
  if (!secretResult.value.persisted) {
    error.value = '当前系统未提供安全存储，API Key 只在本次运行中有效（不会写入磁盘）'
  }
  await settingsStore.refreshAppInfo()
  return true
}

async function next(): Promise<void> {
  error.value = null
  if (steps[stepIndex.value] === 'AI 模型') {
    if (!modelReady.value) {
      error.value = 'AI 模型为必填项：请填写 baseURL、API Key 与模型名'
      return
    }
    saving.value = true
    const saved = await persistModel()
    saving.value = false
    if (!saved) return
  }
  if (steps[stepIndex.value] === '选择模式') {
    const changed = await modeStore.setCurrent(form.mode)
    if (!changed) {
      error.value = modeStore.error ?? '模式切换失败'
      return
    }
  }
  stepIndex.value = Math.min(stepIndex.value + 1, steps.length - 1)
}

function back(): void {
  error.value = null
  stepIndex.value = Math.max(stepIndex.value - 1, 0)
}

async function finishClassroomGuide(): Promise<void> {
  // 表单式引导：直接写入配置并置 guideCompleted（对话式引导在 ClassRoom Mode 内随时可重跑）
  const subjectNames = form.subjects
    .split(/[,，、;；\n]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '')

  const updated = await settingsStore.update({
    modes: {
      ...(settingsStore.settings?.modes ?? ({} as never)),
      classroom: {
        ...(settingsStore.settings?.modes.classroom ?? ({} as never)),
        guideCompleted: true,
        watchDir: form.watchDir.trim(),
        subjects:
          subjectNames.length > 0
            ? subjectNames.map((name) => ({
                name,
                folder: `分类/${name}`,
                keywords: [],
              }))
            : (settingsStore.settings?.modes.classroom.subjects ?? []),
        preClassReminder: form.preClassReminder,
      },
    },
  } as never)
  if (!updated) {
    error.value = settingsStore.error ?? '保存模式设置失败'
    return
  }
  await modeStore.load()
  stepIndex.value = steps.length - 1
}

async function complete(): Promise<void> {
  await settingsStore.refreshAppInfo()
  await window.aurora.window.show('service-dock')
  await window.aurora.window.show('chat')
  await window.aurora.window.hide('onboarding')
}

function skipClassroomGuide(): void {
  stepIndex.value = steps.length - 1
}
</script>

<template>
  <div class="onboarding glass">
    <header class="head drag-region">
      <div class="brand">
        <span class="brand-mark" />
        <div>
          <h1>Aurora</h1>
          <p class="tiny muted">把 Windows 接入 AI 生态 · 首次引导</p>
        </div>
      </div>
      <ol class="steps no-drag">
        <li
          v-for="(step, index) in steps"
          :key="step"
          :class="{ active: index === stepIndex, done: index < stepIndex }"
        >
          <span class="index">{{ index + 1 }}</span>
          {{ step }}
        </li>
      </ol>
    </header>

    <main class="body">
      <!-- ① 欢迎 -->
      <section v-if="stepIndex === 0" class="pane">
        <h2>欢迎使用 Aurora</h2>
        <p class="muted">
          Aurora 常驻系统托盘，提供无感、自主的 AI 服务：顶置 AI 服务窗、屏幕右侧提示条、
          完整对话窗口与智慧感知文件夹。整个引导约 2 分钟。
        </p>
        <div class="cards">
          <article class="card">
            <h3>ClassRoom Mode</h3>
            <p class="tiny muted">
              课堂学习：把新文件拖入「智慧感知文件夹」，自动分析并归类到对应科目；课前提醒并打开科目文件夹。
            </p>
          </article>
          <article class="card dim">
            <h3>Work Mode</h3>
            <p class="tiny muted">办公场景（建设中）：日程、文档摘要、会议纪要。</p>
          </article>
          <article class="card dim">
            <h3>Code Mode</h3>
            <p class="tiny muted">编码场景（建设中）：工作区识别、Git 感知、终端工具组。</p>
          </article>
        </div>
        <SettingField label="界面语言">
          <select v-model="form.language">
            <option value="zh-CN">简体中文</option>
            <option value="en-US">English</option>
          </select>
        </SettingField>
      </section>

      <!-- ② AI 模型（必填） -->
      <section v-else-if="stepIndex === 1" class="pane">
        <h2>配置 AI 模型 <span class="badge warn">必填</span></h2>
        <p class="muted tiny">
          支持任何 OpenAI 兼容服务（DeepSeek / OpenAI / Ollama /
          vLLM…），凭据使用系统安全存储加密后仅保存在本机。
        </p>

        <div class="row wrap">
          <AppButton
            v-for="preset in PROVIDER_PRESETS"
            :key="preset.id"
            size="sm"
            :variant="form.providerId === preset.id ? 'primary' : 'secondary'"
            @click="applyPreset(preset.id)"
          >
            {{ preset.label }}
          </AppButton>
        </div>

        <SettingField
          label="baseURL"
          required
          hint="多数服务需要以 /v1 结尾，例如 https://api.deepseek.com"
        >
          <input
            v-model="form.baseUrl"
            type="text"
            spellcheck="false"
            placeholder="https://api.deepseek.com"
          />
        </SettingField>
        <SettingField label="API Key" required hint="仅本机加密存储，不会上传">
          <input v-model="form.apiKey" type="password" spellcheck="false" placeholder="sk-..." />
        </SettingField>
        <SettingField label="模型名" required>
          <input v-model="form.model" type="text" spellcheck="false" placeholder="deepseek-chat" />
        </SettingField>
        <SettingField label="temperature" hint="0 更确定，2 更发散">
          <input v-model.number="form.temperature" type="number" min="0" max="2" step="0.1" />
        </SettingField>

        <div class="row">
          <AppButton :disabled="testing || !modelReady" @click="testConnection">
            {{ testing ? '测试中…' : '测试连接' }}
          </AppButton>
          <AppToast v-if="testResult" :tone="testResult.ok ? 'ok' : 'error'">
            {{ testResult.message }}（{{ testResult.latencyMs }}ms）
            <template v-if="testResult.models && testResult.models.length > 0">
              · 可用模型 {{ testResult.models.length }} 个
            </template>
          </AppToast>
        </div>
      </section>

      <!-- ③ 模式选择 -->
      <section v-else-if="stepIndex === 2" class="pane">
        <h2>选择使用模式</h2>
        <p class="muted tiny">
          同一时刻只启用一个模式；之后可在设置中随时切换，切换后 AI 会引导你完成该模式的配置。
        </p>
        <div class="mode-list">
          <button
            v-for="mode in modeStore.modes"
            :key="mode.id"
            class="mode-card"
            :class="{ active: form.mode === mode.id, placeholder: mode.placeholder }"
            type="button"
            @click="form.mode = mode.id"
          >
            <strong>{{ mode.displayName }}</strong>
            <span v-if="mode.placeholder" class="badge">建设中</span>
            <span v-else-if="mode.id === 'classroom'" class="badge ok">推荐</span>
            <p class="tiny muted">{{ mode.description }}</p>
          </button>
        </div>
      </section>

      <!-- ④ 模式引导 -->
      <section v-else-if="stepIndex === 3" class="pane">
        <h2>{{ selectedMode?.displayName ?? form.mode }} 设置</h2>
        <template v-if="form.mode === 'classroom'">
          <p class="muted tiny">
            设置「智慧感知文件夹」与科目列表；也可以稍后通过对话式引导完成（设置 → 模式 →
            重新引导）。
          </p>
          <SettingField
            label="智慧感知文件夹"
            hint="留空则在首次激活时使用 用户目录\Aurora\感知文件夹"
          >
            <input
              v-model="form.watchDir"
              type="text"
              spellcheck="false"
              placeholder="D:\Aurora\感知文件夹"
            />
          </SettingField>
          <SettingField label="科目列表" hint="用逗号分隔；每科目标文件夹默认为 分类/<科目>">
            <textarea v-model="form.subjects" spellcheck="false" />
          </SettingField>
          <SettingField label="上课前提醒" hint="课前 5 分钟提醒并打开科目文件夹（P5 落地）">
            <input v-model="form.preClassReminder" type="checkbox" />
          </SettingField>
        </template>
        <p v-else class="muted">
          该模式目前为占位实现，无需额外配置；激活后仅注入提示词片段，具体能力将在后续版本提供。
        </p>
      </section>

      <!-- ⑤ 完成 -->
      <section v-else class="pane center">
        <span class="brand-mark large" />
        <h2>配置完成</h2>
        <p class="muted">
          Aurora 已常驻系统托盘。默认模型：<strong>{{
            settingsStore.activeProvider?.model ?? '未配置'
          }}</strong>
          ；当前模式：<strong>{{ modeStore.current?.displayName ?? form.mode }}</strong
          >。
        </p>
        <p class="tiny muted">
          提示：顶置服务窗输入即可提问；屏幕右侧提示条可拉出完整对话窗口；托盘右键可切换模式与打开设置。
        </p>
      </section>
    </main>

    <footer class="foot">
      <div class="grow">
        <AppToast v-if="error" tone="error">{{ error }}</AppToast>
        <AppToast v-else-if="!settingsStore.cryptoAvailable" tone="warn">
          系统安全存储不可用：API Key 只在本次运行中有效，不会写入磁盘。
        </AppToast>
        <AppToast v-else-if="testResult && !testResult.ok" tone="warn">
          连接测试未通过，可先继续，稍后在设置中修正。
        </AppToast>
        <span v-else class="tiny muted">步骤 {{ stepIndex + 1 }} / {{ steps.length }}</span>
      </div>
      <AppButton v-if="stepIndex > 0 && stepIndex < steps.length - 1" variant="ghost" @click="back"
        >上一步</AppButton
      >
      <AppButton
        v-if="stepIndex === 3 && form.mode === 'classroom'"
        variant="ghost"
        @click="skipClassroomGuide"
      >
        稍后设置
      </AppButton>
      <AppButton
        v-if="stepIndex === 3 && form.mode === 'classroom'"
        variant="primary"
        :disabled="saving"
        @click="finishClassroomGuide"
      >
        保存并继续
      </AppButton>
      <AppButton
        v-else-if="stepIndex < steps.length - 1"
        variant="primary"
        :disabled="saving"
        @click="next"
      >
        {{ saving ? '保存中…' : '下一步' }}
      </AppButton>
      <AppButton v-else variant="primary" @click="complete">开始使用</AppButton>
    </footer>
  </div>
</template>

<style scoped>
.onboarding {
  display: flex;
  flex-direction: column;
  height: 100vh;
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  gap: var(--space-5);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--border-subtle);
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.brand h1 {
  margin: 0;
  font-size: 18px;
  letter-spacing: 0.5px;
}

.brand p {
  margin: 0;
}

.brand-mark {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--aurora-gradient);
  box-shadow: 0 0 18px rgba(86, 132, 255, 0.45);
}

.brand-mark.large {
  width: 56px;
  height: 56px;
}

.steps {
  display: flex;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
  margin-left: auto;
}

.steps li {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-muted);
}

.steps li.active {
  color: var(--text-primary);
}

.steps li.done {
  color: var(--aurora-green);
}

.index {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.08);
  font-size: 11px;
}

.steps li.active .index {
  background: var(--aurora-gradient);
  color: #08131a;
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-5);
}

.pane h2 {
  margin: 0 0 var(--space-2);
  font-size: 16px;
}

.pane.center {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
  gap: var(--space-3);
}

.cards,
.mode-list {
  display: grid;
  gap: var(--space-3);
  margin: var(--space-4) 0;
}

.cards {
  grid-template-columns: repeat(3, 1fr);
}

.card,
.mode-card {
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: rgba(255, 255, 255, 0.03);
  text-align: left;
}

.card h3,
.mode-card strong {
  margin: 0 0 4px;
  font-size: 14px;
}

.card.dim {
  opacity: 0.6;
}

.mode-card {
  display: grid;
  grid-template-columns: auto auto 1fr;
  grid-template-areas:
    'title tag spacer'
    'desc desc desc';
  gap: 4px var(--space-2);
  cursor: pointer;
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast);
}

.mode-card strong {
  grid-area: title;
}

.mode-card .badge {
  grid-area: tag;
  justify-self: start;
}

.mode-card p {
  grid-area: desc;
  margin: 0;
}

.mode-card.active {
  border-color: var(--aurora-blue);
  background: rgba(86, 132, 255, 0.1);
}

.mode-card.placeholder {
  opacity: 0.75;
}

.wrap {
  flex-wrap: wrap;
  margin-bottom: var(--space-3);
}

.foot {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-5);
  border-top: 1px solid var(--border-subtle);
}
</style>
