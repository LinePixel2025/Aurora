<script setup lang="ts">
/**
 * AI 模型设置页（docs/08 §5）：provider **目录行列表 + 一次只开一张编辑卡**。
 *
 * 信息架构（step-04）：页头摘要（当前默认 provider · 模型）→ 工具行（添加 Provider / 保存全部）
 * → provider 行列表（名称 + 凭据状态 + 是否默认 + 编辑 / 设为默认 / 删除）→ 空状态。
 * 危险操作走**就地二次确认**；凭据是 write-only 输入，页面永不回显明文（只显示「已保存 / 缺失」）。
 *
 * 编辑卡（`mode === 'edit' && editingId === id`，一次只渲染一张）从上到下是：
 * 必填区（baseURL / API Key / 模型名）→ **模型分组预留位**（step 5 的模型列表插在这里）
 * → `.more`「高级参数与连接测试」折叠区（temperature / 思考等级 / 连接测试 / 模型 chips，默认收起）
 * → 卡片底部「应用 / 取消」。
 *
 * 行上只有「名称 + 凭据状态 + 是否默认 + 编辑 / 设为默认 / 删除」四个动作，没有多余的折叠箭头：
 * 展开高级参数是**卡内**那颗 `.more` 的职责（capture 的 `SETTINGS_LLM_EFFORT_ACT` 会先点开卡再点它）。
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

/** 页面三态：目录列表 / 添加（选预设）/ 编辑（最多一张卡，由单值 `editingId` 决定是哪一张） */
type PageMode = 'list' | 'add' | 'edit'

const settingsStore = useSettingsStore()

const drafts = ref<ProviderDraft[]>([])
const newProviderId = ref('')
const testing = ref<string | null>(null)
const results = reactive<Record<string, TestConnectionResult>>({})
const models = reactive<Record<string, string[]>>({})
const message = ref<string | null>(null)
const error = ref<string | null>(null)

const mode = ref<PageMode>('list')
const editingId = ref<string | null>(null)
/** 删除的二次确认：待确认的 provider id（单值，同一时刻只确认一个） */
const pendingRemoveId = ref<string | null>(null)
/** 高级参数折叠状态（按 provider 记，默认收起） */
const advancedOpen = reactive<Record<string, boolean>>({})

const activeId = computed(() => settingsStore.settings?.llm.active ?? '')
const activeDraft = computed(
  () => drafts.value.find((draft) => draft.id === activeId.value) ?? null,
)

function resultOf(id: string): TestConnectionResult | undefined {
  return results[id]
}

function modelsOf(id: string): string[] {
  return models[id] ?? []
}

function isEditing(id: string): boolean {
  return mode.value === 'edit' && editingId.value === id
}

function advancedOf(id: string): boolean {
  return advancedOpen[id] === true
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
  // provider 被别处删掉（如 `set_setting` 或对话窗）时，编辑卡 / 确认条不能指着一个不存在的行
  if (editingId.value !== null && !drafts.value.some((draft) => draft.id === editingId.value)) {
    closeEditor()
  }
  if (
    pendingRemoveId.value !== null &&
    !drafts.value.some((draft) => draft.id === pendingRemoveId.value)
  ) {
    pendingRemoveId.value = null
  }
}

watch(
  () => settingsStore.settings,
  () => syncDrafts(),
  { immediate: true },
)

function openEditor(id: string, options: { advanced?: boolean } = {}): void {
  mode.value = 'edit'
  editingId.value = id
  pendingRemoveId.value = null
  if (options.advanced === true) advancedOpen[id] = true
  error.value = null
}

function closeEditor(): void {
  if (editingId.value !== null) advancedOpen[editingId.value] = false
  mode.value = 'list'
  editingId.value = null
  pendingRemoveId.value = null
}

function startAdd(): void {
  mode.value = 'add'
  editingId.value = null
  pendingRemoveId.value = null
  message.value = null
  error.value = null
}

function toggleAdvanced(id: string): void {
  advancedOpen[id] = !advancedOf(id)
}

/**
 * 保存一个 provider。
 *
 * 关键语义（踩过的坑，别退化）：
 * - `settings:update` 只有**顶层浅合并**，所以必须原样回传全部 provider 再覆盖当前一个；
 * - patch 必须经 `settingsStore.update()`（内部 `deepClone`），直接把 `reactive`/`ref` 里的对象
 *   送出去会因 Proxy 不可结构化克隆而 `DataCloneError` 静默失败；
 * - `apiKeyEnc: ''` 留在 patch 里是**安全的**：主进程对「已有 provider + 空密文」按
 *   「本次不改凭据」处理（新建时 Schema 又要求该字段存在，所以必须带）；
 * - 明文 `apiKey` 只走 `settings:setSecrets`，永不进配置。
 */
async function saveProvider(draft: ProviderDraft): Promise<boolean> {
  const settings = settingsStore.settings
  if (!settings) return false
  // 必填项当场校验（step-04 第 4 条）：指出是谁的哪个字段，而不是保存后由 Schema 兜底
  if (draft.baseUrl.trim() === '') {
    error.value = `请填写 ${draft.id} 的 baseURL`
    return false
  }
  if (draft.model.trim() === '') {
    error.value = `请填写 ${draft.id} 的模型名`
    return false
  }
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

/** 「应用」：只提交这一张卡；成功后回到列表态 */
async function applyDraft(draft: ProviderDraft): Promise<void> {
  message.value = null
  error.value = null
  if (!(await saveProvider(draft))) return
  message.value = `已保存 ${draft.id}`
  closeEditor()
}

async function saveAll(): Promise<void> {
  message.value = null
  error.value = null
  for (const draft of drafts.value) {
    const ok = await saveProvider(draft)
    if (!ok) return
  }
  closeEditor()
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
  message.value = null
  // 必填项前移：选中预设后直接进编辑卡，由卡内必填项当场校验（「空白配置」同理）
  openEditor(key)
}

/** 删除入口：先亮出确认条，不直接生效 */
function requestRemove(id: string): void {
  pendingRemoveId.value = pendingRemoveId.value === id ? null : id
  message.value = null
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
  // provider 都没了，凭据不能留在 safeStorage 里
  await window.aurora.settings.clearSecret(`llm.providers.${id}.apiKey`)
  pendingRemoveId.value = null
  if (editingId.value === id) closeEditor()
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
    // needsOnboarding 靠它刷新：设为默认之后主功能才算可用
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
      <!-- 页头摘要：当前默认模型来自哪个 provider，一眼可见 -->
      <p class="summary tiny">
        <template v-if="activeDraft">
          当前默认：<span class="mono">{{ activeDraft.id }}</span> ·
          <span class="mono">{{ activeDraft.model }}</span>
        </template>
        <template v-else>尚未选择默认模型</template>
      </p>
    </header>

    <AppToast v-if="message" tone="ok">{{ message }}</AppToast>
    <AppToast v-if="error" tone="error">{{ error }}</AppToast>

    <!-- 空状态：没有任何 provider 时不摆一排空行，直接给主入口（文案与主按钮保持不变） -->
    <section v-if="drafts.length === 0" class="section-card empty-state" data-empty="llm.providers">
      <h2 class="section-title">还没有 AI 模型配置</h2>
      <p class="section-desc">
        至少添加一个 Provider 并设为默认后，主功能才可用；未配置时启动会进入首次引导向导。
      </p>
      <div class="row">
        <AppButton variant="primary" @click="startAdd">添加 AI 模型</AppButton>
      </div>
    </section>

    <!-- 工具行：新增与整体保存 -->
    <div v-if="drafts.length > 0" class="row wrap toolbar">
      <AppButton size="sm" :disabled="mode === 'add'" @click="startAdd">+ 添加 Provider</AppButton>
      <AppButton size="sm" variant="primary" @click="saveAll">保存全部</AppButton>
      <span class="grow" />
      <span class="tiny muted">{{ drafts.length }} 个 Provider</span>
    </div>

    <!-- 添加流程（mode === 'add'）：预设 chips 沿用 PROVIDER_PRESETS，选中即进编辑卡 -->
    <section v-if="mode === 'add'" class="section-card">
      <div class="row">
        <h2 class="section-title grow">添加 Provider</h2>
        <AppButton size="sm" variant="ghost" @click="closeEditor">取消</AppButton>
      </div>
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
      </div>
    </section>

    <!-- provider 目录行列表：行上只有名称 / 凭据状态 / 是否默认 / 行操作 -->
    <article
      v-for="draft in drafts"
      :key="draft.id"
      class="section-card provider-row"
      :class="{ accent: activeId === draft.id, editing: isEditing(draft.id) }"
      :data-field="`llm.providers.${draft.id}`"
    >
      <header class="provider-head">
        <strong class="mono">{{ draft.id }}</strong>
        <span v-if="draft.apiKeySet" class="badge ok">凭据已保存</span>
        <span v-else class="badge warn">缺少凭据</span>
        <span v-if="activeId === draft.id" class="badge ok">默认</span>
        <span class="grow" />
        <AppButton
          size="sm"
          variant="ghost"
          data-action="edit-provider"
          @click="openEditor(draft.id)"
        >
          编辑
        </AppButton>
        <AppButton
          size="sm"
          variant="ghost"
          data-field="llm.active"
          :disabled="activeId === draft.id"
          @click="setActive(draft.id)"
        >
          {{ activeId === draft.id ? '已是默认' : '设为默认' }}
        </AppButton>
        <AppButton
          size="sm"
          :variant="pendingRemoveId === draft.id ? 'danger' : 'ghost'"
          data-action="remove-provider"
          @click="requestRemove(draft.id)"
        >
          删除
        </AppButton>
      </header>

      <!-- 危险操作二次确认：确认条就地出现，点「确认删除」才真的删 -->
      <div v-if="pendingRemoveId === draft.id" class="confirm-bar">
        <span class="tiny confirm-text">
          删除 provider「{{ draft.id }}」？依赖它的会话将无法再请求模型。
        </span>
        <AppButton
          size="sm"
          variant="danger"
          data-action="confirm-remove-provider"
          @click="removeProvider(draft.id)"
        >
          确认删除
        </AppButton>
        <AppButton
          size="sm"
          variant="ghost"
          data-action="cancel-remove-provider"
          @click="pendingRemoveId = null"
        >
          取消
        </AppButton>
      </div>

      <!-- 编辑卡：一次只渲染一张（editingId 是单值） -->
      <template v-if="isEditing(draft.id) && pendingRemoveId !== draft.id">
        <!-- 必填区：三个 `data-field` 与重构前逐字一致（capture 抓手） -->
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
          :hint="
            draft.apiKeySet
              ? '已保存（留空表示不修改）'
              : '必填；明文只写入系统安全存储，页面不回显'
          "
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

        <!-- 模型分组预留位（step 5 的模型列表插在必填区与 `.more` 之间，别把 `.more` 顶到 model 输入框上） -->
        <section class="model-section" :data-field="`llm.providers.${draft.id}.modelList`">
          <h3 class="model-title">模型</h3>
          <p class="tiny muted">
            这里是模型列表的位置：候选模型会在列表里直接点选（当前使用哪个模型仍由上面的「模型名」决定）。
          </p>
        </section>

        <button
          class="more"
          type="button"
          :aria-expanded="advancedOf(draft.id)"
          @click="toggleAdvanced(draft.id)"
        >
          <span class="chevron" :class="{ open: advancedOf(draft.id) }" aria-hidden="true">▸</span>
          高级参数与连接测试
        </button>

        <Transition name="collapse">
          <div v-if="advancedOf(draft.id)" class="advanced">
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

        <!-- 卡片底部：只提交这一张卡 -->
        <footer class="row wrap card-actions">
          <AppButton
            size="sm"
            variant="primary"
            :disabled="testing !== null"
            @click="applyDraft(draft)"
          >
            应用
          </AppButton>
          <AppButton size="sm" variant="ghost" @click="closeEditor">取消</AppButton>
        </footer>
      </template>
    </article>

    <p v-if="drafts.length > 0" class="tiny muted">
      改动在点「应用」（保存这一张卡）或工具行的「保存全部」后落盘；编辑卡里的 API Key
      留空表示不修改已保存的凭据。
    </p>
  </section>
</template>

<style scoped>
.summary {
  margin: var(--space-2) 0 0;
  color: var(--text-secondary);
}

.toolbar {
  align-items: center;
}

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

/* 目录行：hover 用分层填充；默认行沿用 .accent 描边，再补左侧 3px 品牌色指示条 */
.provider-row {
  position: relative;
  transition: background var(--transition-fast);
}

.provider-row:hover,
.provider-row.editing {
  background: var(--fill-2);
}

.provider-row.accent::before {
  content: '';
  position: absolute;
  left: 6px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 60%;
  border-radius: var(--radius-pill);
  background: var(--aurora-blue);
}

/* 折叠入口：与分组头一致的弱化按钮（行内那颗只留 chevron，卡内那颗带文案） */
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

/* 模型分组的预留位（step 5 在这里放模型列表） */
.model-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}

.model-title {
  margin: 0;
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  color: var(--text-secondary);
}

/* 删除的二次确认条 */
.confirm-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-xs);
  border: 1px solid var(--status-error);
  background: var(--fill-1);
}

.confirm-text {
  flex: 1;
  min-width: 220px;
}

.card-actions {
  margin-top: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
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
</style>
