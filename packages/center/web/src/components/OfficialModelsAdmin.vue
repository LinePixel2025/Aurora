<script setup lang="ts">
/**
 * 管理端官方模型配置（docs/12 §12.1）。
 *
 * 上游 API Key 是 write-only：服务端只回 `apiKeySet`；`apiKey: ''` 表示不动、`null` 才是清除。
 * 四类能力的草稿各自一份（页签切换不丢），保存只提交**当前能力** —— 服务端也是一次一个能力、
 * 非法配置整条拒绝，所以这里不做「一次保存全部」。
 *
 * 纯逻辑（能力元数据 / 拉取合并 / 校验 / 脏值）在 `../lib/official-models.ts`，本组件只管渲染与请求；
 * 服务端报错原文照旧展示，前端校验只是把明显能拦的错误提前。
 */
import { computed, onMounted, ref } from 'vue'
import { Eye, Plus, RotateCw, Trash2, TriangleAlert } from '@aurora/shared/browser'
import type {
  CenterOfficialCapability,
  CenterOfficialModelEntry,
  CenterOfficialServiceConfig,
  CenterOfficialServicesConfig,
  ReasoningEffort,
} from '@aurora/shared'
import { api } from '../lib/api'
import {
  CAPABILITIES,
  capabilityMeta,
  capabilityTypes,
  createModelEntry,
  isDirty,
  mergeFetchedModels,
  modelRowIssues,
  validateDraft,
} from '../lib/official-models'

const active = ref<CenterOfficialCapability>('llm')
const services = ref<CenterOfficialServicesConfig | null>(null)
const drafts = ref<CenterOfficialServicesConfig | null>(null)
const apiKeys = ref<Record<CenterOfficialCapability, string>>({
  llm: '',
  imagegen: '',
  tts: '',
  stt: '',
})
/** 明文显示刚输入的 Key（服务端从不回显，这里只开关本次输入框的 type） */
const showKey = ref(false)
const loading = ref(true)
const saving = ref(false)
const fetching = ref(false)
const message = ref('')
const error = ref('')

const capability = computed(() => capabilityMeta(active.value))

function currentDraft(): CenterOfficialServiceConfig {
  return drafts.value![active.value]
}

function savedConfig(): CenterOfficialServiceConfig {
  return services.value![active.value]
}

// ── 派生状态：全部对「还没加载完」（drafts / services 为 null）做空值守卫 ──

const dirty = computed(() => {
  const draftsValue = drafts.value
  const servicesValue = services.value
  if (draftsValue === null || servicesValue === null) return false
  return isDirty(
    draftsValue[active.value],
    servicesValue[active.value],
    apiKeys.value[active.value],
  )
})

const openCount = computed(() => {
  const draft = drafts.value?.[active.value]
  return draft === undefined ? 0 : draft.models.filter((model) => model.enabled).length
})

const rowIssues = computed(() => {
  const draft = drafts.value?.[active.value]
  return draft === undefined ? new Map<number, string>() : modelRowIssues(draft.models)
})

/** 默认模型只能选已开放且填了 id 的条目（服务端也会回落首个开放模型） */
const openModelOptions = computed<CenterOfficialModelEntry[]>(() => {
  const draft = drafts.value?.[active.value]
  if (draft === undefined) return []
  return draft.models.filter((model) => model.enabled && model.id.trim() !== '')
})

const endpointHint = computed(() => {
  const draft = drafts.value?.[active.value]
  if (draft === undefined) return '上游端点路径'
  const type = capabilityTypes(active.value).find((item) => item.value === draft.type)
  return type === undefined ? '上游端点路径' : `请求发往 Base URL + ${type.endpoint}`
})

function tabEnabled(id: CenterOfficialCapability): boolean {
  return services.value?.[id].enabled === true
}

function tabOpenCount(id: CenterOfficialCapability): number {
  const draft = drafts.value?.[id]
  return draft === undefined ? 0 : draft.models.filter((model) => model.enabled).length
}

function tabDirty(id: CenterOfficialCapability): boolean {
  const draftsValue = drafts.value
  const servicesValue = services.value
  if (draftsValue === null || servicesValue === null) return false
  return isDirty(draftsValue[id], servicesValue[id], apiKeys.value[id])
}

function modelLabel(entry: CenterOfficialModelEntry): string {
  return entry.label === undefined || entry.label === '' ? entry.id : `${entry.label} · ${entry.id}`
}

/**
 * 思考等级：服务端的模型条目可以**没有** `reasoningEffort`（表示未指定，客户端按 auto 回落），
 * 而 `<select v-model>` 遇到 undefined 会一个都不选中 —— 显示成空白，管理员分不清"没设"还是"设坏了"。
 * 所以显式给一个 `''` 选项并手写赋值（保持"未指定"原样回写，不把草稿悄悄改成 auto 而误报脏）。
 */
function setReasoningEffort(model: CenterOfficialModelEntry, event: Event): void {
  const raw = (event.target as HTMLSelectElement).value
  model.reasoningEffort = raw === '' ? undefined : (raw as ReasoningEffort)
}

// ── 加载与页签 ──

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

function selectTab(id: CenterOfficialCapability): void {
  if (id === active.value) return
  active.value = id
  showKey.value = false
  error.value = ''
  message.value = ''
}

// ── 草稿操作（都不落盘，保存才提交） ──

function addModel(): void {
  currentDraft().models.push(createModelEntry(active.value))
  message.value = ''
}

function removeModel(index: number): void {
  currentDraft().models.splice(index, 1)
  message.value = ''
}

function setAllModels(enabled: boolean): void {
  for (const model of currentDraft().models) model.enabled = enabled
  message.value = ''
}

function clearKey(): void {
  const draft = currentDraft()
  if (!draft.apiKeySet) return
  if (!window.confirm('清除已保存的上游 API Key？保存后这类官方能力会立即不可用，直到重新填写。')) {
    return
  }
  draft.apiKeySet = false
  apiKeys.value[active.value] = ''
  message.value = '保存后清除已存 Key'
}

/** 丢弃当前能力的草稿，回到已保存快照 */
function resetDraft(): void {
  const snapshot = services.value?.[active.value]
  if (snapshot === undefined) return
  drafts.value![active.value] = structuredClone(snapshot)
  apiKeys.value[active.value] = ''
  showKey.value = false
  message.value = ''
  error.value = ''
}

// ── 请求 ──

async function fetchModels(): Promise<void> {
  fetching.value = true
  error.value = ''
  message.value = ''
  try {
    const draft = currentDraft()
    const result = await api.admin.fetchModelServiceModels(active.value, {
      type: draft.type,
      baseUrl: draft.baseUrl,
      ...(apiKeys.value[active.value] === '' ? {} : { apiKey: apiKeys.value[active.value] }),
    })
    // 合并而不是整表替换：上游没返回的已配置模型不能被冲掉（见 lib 里的说明）
    const merged = mergeFetchedModels(active.value, draft.models, result.models)
    draft.models = merged.models
    message.value = `已拉取 ${result.models.length} 个：新增 ${merged.added} 个（默认未开放）、保留 ${merged.kept} 个，保存后生效`
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '拉取失败'
  } finally {
    fetching.value = false
  }
}

async function save(): Promise<void> {
  const draft = currentDraft()
  const snapshot = savedConfig()
  const issues = validateDraft(draft, apiKeys.value[active.value])
  if (issues.length > 0) {
    error.value = issues[0] as string
    message.value = ''
    return
  }
  saving.value = true
  error.value = ''
  message.value = ''
  try {
    // apiKeySet / error 是服务端的只读回执，不能进请求体
    const { apiKeySet, error: _serverReason, ...config } = draft
    const key = apiKeys.value[active.value].trim()
    const payload: Partial<CenterOfficialServiceConfig> & { apiKey?: string | null } = { ...config }
    if (key !== '') payload.apiKey = key
    else if (!apiKeySet && snapshot.apiKeySet) payload.apiKey = null
    const result = await api.admin.updateModelService(active.value, payload)
    services.value![active.value] = result.service
    drafts.value![active.value] = structuredClone(result.service)
    apiKeys.value[active.value] = ''
    showKey.value = false
    message.value = `「${capability.value.label}」配置已保存`
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
      <div class="official-head-copy">
        <h2>官方模型</h2>
        <p>每类能力配一个上游，开放后的模型供所有登录客户端选择；API Key 只写不回显。</p>
      </div>
      <div class="official-head-actions">
        <span v-if="dirty" class="official-dirty" data-field="official.dirty">有未保存的修改</span>
        <button
          class="ui-btn ui-btn--ghost"
          type="button"
          :disabled="!dirty || saving"
          data-action="official.reset"
          @click="resetDraft"
        >
          还原
        </button>
        <button
          class="ui-btn ui-btn--primary"
          type="button"
          :disabled="saving || loading"
          data-action="official.save"
          @click="save"
        >
          {{ saving ? '保存中…' : `保存「${capability.label}」` }}
        </button>
      </div>
    </header>

    <p v-if="error" class="ui-error" data-field="official.error">{{ error }}</p>
    <p v-if="message" class="ui-ok" data-field="official.message">{{ message }}</p>
    <p v-if="loading" class="official-loading">加载中…</p>

    <template v-if="drafts !== null && services !== null">
      <nav class="official-tabs" role="tablist" aria-label="官方能力">
        <button
          v-for="item in CAPABILITIES"
          :key="item.id"
          type="button"
          role="tab"
          class="official-tab"
          :class="{ 'official-tab--active': active === item.id }"
          :aria-selected="active === item.id"
          :data-action="`official.tab-${item.id}`"
          @click="selectTab(item.id)"
        >
          <span class="official-tab-label">{{ item.label }}</span>
          <span class="official-tab-state">
            <span
              class="official-dot"
              :class="{ 'official-dot--on': tabEnabled(item.id) }"
              aria-hidden="true"
            ></span>
            {{ tabEnabled(item.id) ? '已启用' : '未启用' }}
            <template v-if="tabOpenCount(item.id) > 0"> · {{ tabOpenCount(item.id) }} 个</template>
          </span>
          <span
            v-if="tabDirty(item.id)"
            class="official-tab-dirty"
            title="有未保存的修改"
            aria-label="有未保存的修改"
          ></span>
        </button>
      </nav>

      <p
        v-if="savedConfig().error !== undefined"
        class="official-warn"
        data-field="official.key-error"
      >
        <TriangleAlert :size="14" :stroke-width="1.9" aria-hidden="true" />
        <span>上游密钥当前不可用：{{ savedConfig().error }}</span>
      </p>

      <section class="official-connect">
        <div class="official-field official-field--switch">
          <label class="official-switch">
            <input v-model="currentDraft().enabled" type="checkbox" data-field="official.enabled" />
            <span>启用「{{ capability.label }}」</span>
          </label>
          <small>未启用时客户端目录里不会出现这类能力。</small>
        </div>

        <label class="official-field">
          <span class="official-field-label">协议</span>
          <select v-model="currentDraft().type" class="ui-input" data-field="official.type">
            <option v-for="item in capabilityTypes(active)" :key="item.value" :value="item.value">
              {{ item.label }}
            </option>
          </select>
          <small>{{ endpointHint }}</small>
        </label>

        <label class="official-field official-field--wide">
          <span class="official-field-label">Base URL</span>
          <input
            v-model="currentDraft().baseUrl"
            class="ui-input"
            spellcheck="false"
            placeholder="https://api.example.com/v1"
            data-field="official.baseurl"
          />
          <small>填到版本路径即可，末尾不要带 /。</small>
        </label>

        <div class="official-field official-field--wide">
          <span id="official-apikey-label" class="official-field-label">API Key</span>
          <div class="official-key-row">
            <input
              v-model="apiKeys[active]"
              class="ui-input"
              :type="showKey ? 'text' : 'password'"
              autocomplete="off"
              spellcheck="false"
              aria-labelledby="official-apikey-label"
              :placeholder="currentDraft().apiKeySet ? '已保存，留空不修改' : '至少填写一次'"
              data-field="official.apikey"
            />
            <button
              class="ui-btn ui-btn--ghost"
              type="button"
              :aria-pressed="showKey"
              data-action="official.reveal-key"
              @click="showKey = !showKey"
            >
              <Eye :size="14" :stroke-width="1.9" aria-hidden="true" />
              {{ showKey ? '隐藏' : '显示' }}
            </button>
            <button
              class="ui-btn ui-btn--ghost"
              type="button"
              :disabled="!currentDraft().apiKeySet"
              data-action="official.clear-key"
              @click="clearKey"
            >
              清除
            </button>
          </div>
          <small class="official-key-foot">
            <span
              class="ui-chip"
              :class="currentDraft().apiKeySet ? 'ui-chip--ok' : 'ui-chip--muted'"
              data-field="official.apikey-state"
            >
              {{ currentDraft().apiKeySet ? '已保存' : '未设置' }}
            </span>
            <span>服务端加密保存，网页不显示明文。</span>
          </small>
        </div>

        <label class="official-field official-field--wide">
          <span class="official-field-label">默认模型</span>
          <select
            v-model="currentDraft().defaultModel"
            class="ui-input"
            data-field="official.default-model"
          >
            <option value="">（自动：首个开放模型）</option>
            <option v-for="model in openModelOptions" :key="model.id" :value="model.id">
              {{ modelLabel(model) }}
            </option>
          </select>
          <small>客户端没有指定模型时用它。</small>
        </label>
      </section>

      <section class="official-models">
        <header class="official-models-head">
          <div>
            <h3>开放模型</h3>
            <p>只有勾选「开放」的条目会进客户端目录，未开放的留着备用。</p>
          </div>
          <div class="official-model-tools">
            <button
              class="ui-btn ui-btn--ghost"
              type="button"
              :disabled="fetching"
              data-action="official.fetch-models"
              @click="fetchModels"
            >
              <RotateCw :size="14" :stroke-width="1.9" aria-hidden="true" />
              {{ fetching ? '拉取中…' : '拉取模型' }}
            </button>
            <button
              class="ui-btn ui-btn--ghost"
              type="button"
              data-action="official.add-model"
              @click="addModel"
            >
              <Plus :size="14" :stroke-width="1.9" aria-hidden="true" />
              新增模型
            </button>
            <button
              class="ui-btn ui-btn--ghost"
              type="button"
              :disabled="currentDraft().models.length === 0 || openCount === 0"
              data-action="official.disable-all"
              @click="setAllModels(false)"
            >
              全部关闭
            </button>
            <button
              class="ui-btn ui-btn--ghost"
              type="button"
              :disabled="
                currentDraft().models.length === 0 || openCount === currentDraft().models.length
              "
              data-action="official.enable-all"
              @click="setAllModels(true)"
            >
              全部开放
            </button>
          </div>
        </header>

        <p v-if="currentDraft().models.length === 0" class="official-models-empty">
          还没有模型：先「拉取模型」拿上游目录，或手动「新增模型」。
        </p>
        <div v-else class="official-models-scroll">
          <table
            class="ui-table ui-table--cards official-models-table"
            data-field="official.models-table"
          >
            <thead>
              <tr>
                <th class="official-col-open">开放</th>
                <th>模型 ID</th>
                <th>显示名</th>
                <template v-if="active === 'llm'">
                  <th class="official-col-num">上下文窗口</th>
                  <th>思考等级</th>
                  <th class="official-col-flag">图片</th>
                </template>
                <template v-else-if="active === 'imagegen'">
                  <th>尺寸</th>
                </template>
                <template v-else-if="active === 'tts'">
                  <th>音色</th>
                  <th class="official-col-num">语速</th>
                  <th>格式</th>
                </template>
                <template v-else>
                  <th>语言</th>
                </template>
                <th class="official-col-ops">操作</th>
              </tr>
            </thead>
            <tbody>
              <!--
                key 必须用 index：模型 id 是可编辑字段，拿它当 key 会在每个按键上重建 <tr>，
                正在输入的输入框随之丢焦点（结果只落下一个字符）—— 验收场景真的踩到过。
              -->
              <tr
                v-for="(item, index) in currentDraft().models"
                :key="index"
                class="official-model-row"
                :class="{ 'official-model-row--off': !item.enabled }"
                data-field="official.model-row"
              >
                <td data-label="开放">
                  <input
                    v-model="item.enabled"
                    type="checkbox"
                    :aria-label="`开放 ${item.id === '' ? '新模型' : item.id}`"
                    data-field="official.model-enabled"
                  />
                </td>
                <td data-label="模型 ID">
                  <input
                    v-model="item.id"
                    class="ui-input"
                    spellcheck="false"
                    placeholder="例如 gpt-4o-mini"
                    aria-label="模型 ID"
                    data-field="official.model-id"
                  />
                  <small v-if="rowIssues.get(index)" class="official-row-error">
                    {{ rowIssues.get(index) }}
                  </small>
                </td>
                <td data-label="显示名">
                  <input
                    v-model="item.label"
                    class="ui-input"
                    placeholder="可选"
                    aria-label="显示名"
                    data-field="official.model-label"
                  />
                </td>
                <template v-if="active === 'llm'">
                  <td data-label="上下文窗口">
                    <input
                      v-model.number="item.contextWindow"
                      class="ui-input official-num"
                      type="number"
                      min="0"
                      step="1024"
                      aria-label="上下文窗口"
                    />
                  </td>
                  <td data-label="思考等级">
                    <select
                      class="ui-input"
                      :value="item.reasoningEffort ?? ''"
                      aria-label="思考等级"
                      @change="setReasoningEffort(item, $event)"
                    >
                      <option value="">未指定（按 auto）</option>
                      <option value="auto">auto</option>
                      <option value="low">low</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                    </select>
                  </td>
                  <td data-label="图片">
                    <input v-model="item.vision" type="checkbox" aria-label="支持图片" />
                  </td>
                </template>
                <template v-else-if="active === 'imagegen'">
                  <td data-label="尺寸">
                    <input
                      v-model="item.size"
                      class="ui-input"
                      placeholder="auto"
                      aria-label="尺寸"
                    />
                  </td>
                </template>
                <template v-else-if="active === 'tts'">
                  <td data-label="音色">
                    <input
                      v-model="item.voice"
                      class="ui-input"
                      placeholder="音色"
                      aria-label="音色"
                    />
                  </td>
                  <td data-label="语速">
                    <input
                      v-model.number="item.speed"
                      class="ui-input official-num"
                      type="number"
                      min="0.25"
                      max="4"
                      step="0.05"
                      aria-label="语速"
                    />
                  </td>
                  <td data-label="格式">
                    <select v-model="item.format" class="ui-input" aria-label="格式">
                      <option value="mp3">mp3</option>
                      <option value="opus">opus</option>
                      <option value="aac">aac</option>
                      <option value="flac">flac</option>
                      <option value="wav">wav</option>
                      <option value="pcm">pcm</option>
                    </select>
                  </td>
                </template>
                <template v-else>
                  <td data-label="语言">
                    <input
                      v-model="item.language"
                      class="ui-input"
                      placeholder="zh"
                      aria-label="语言"
                    />
                  </td>
                </template>
                <td class="official-col-ops" data-label="操作">
                  <button
                    class="ui-btn ui-btn--danger"
                    type="button"
                    :aria-label="`删除 ${item.id === '' ? '该模型' : item.id}`"
                    data-action="official.model-remove"
                    @click="removeModel(index)"
                  >
                    <Trash2 :size="14" :stroke-width="1.9" aria-hidden="true" />
                    删除
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <p class="official-models-count" data-field="official.models-count">
          已开放 {{ openCount }} / 共 {{ currentDraft().models.length }} 个模型
        </p>
      </section>
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
  flex-wrap: wrap;
  justify-content: space-between;
  gap: var(--space-3);
  align-items: flex-start;
}

.official-head h2 {
  margin: 0 0 var(--space-1);
}

.official-head p {
  margin: 0;
  max-width: 62ch;
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.official-head-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.official-dirty {
  padding: 2px var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--warning-fill);
  color: var(--warning-text);
  font-size: var(--text-xs);
  white-space: nowrap;
}

/* ── 能力页签：状态 + 开放数 + 脏点，一眼看清哪类能力被改过 ── */

.official-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.official-tab {
  position: relative;
  display: grid;
  gap: 2px;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--fill-1);
  color: var(--text-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast),
    color var(--transition-fast);
}

.official-tab:hover {
  color: var(--text-primary);
}

.official-tab--active {
  border-color: var(--center-signal);
  background: var(--center-active);
  color: var(--text-primary);
}

.official-tab-label {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

.official-tab-state {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.official-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--status-idle);
}

.official-dot--on {
  background: var(--status-ok);
}

.official-tab-dirty {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 6px;
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--warning-text);
}

.official-warn {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--warning-fill);
  color: var(--warning-text);
  font-size: var(--text-sm);
  word-break: break-all;
}

/* ── 接入区：字段名 + 说明成对，窄屏单列 ── */

.official-connect {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

.official-field {
  display: grid;
  gap: var(--space-1);
  align-content: start;
}

.official-field-label {
  color: var(--text-secondary);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
}

.official-field small {
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}

.official-field--wide {
  grid-column: 1 / -1;
}

.official-switch {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-primary);
  font-size: var(--text-sm);
  cursor: pointer;
}

.official-key-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.official-key-row .ui-input {
  flex: 1 1 240px;
}

.official-key-row .ui-btn {
  flex: none;
}

.official-key-foot {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

/* ── 模型区 ── */

.official-models {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--fill-1);
}

.official-models-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: var(--space-2);
  align-items: flex-start;
}

.official-models-head h3 {
  margin: 0 0 2px;
  font-size: var(--text-base);
}

.official-models-head p {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

.official-model-tools {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.official-models-scroll {
  max-height: 420px;
  overflow: auto;
}

.official-models-table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bg-raised);
}

.official-models-table td {
  vertical-align: top;
}

.official-models-table .ui-input {
  min-width: 132px;
}

.official-num {
  max-width: 108px;
}

.official-col-open,
.official-col-flag {
  width: 56px;
}

.official-col-num {
  width: 116px;
}

.official-col-ops {
  width: 96px;
  text-align: right;
}

.official-model-row--off {
  opacity: 0.6;
}

.official-row-error {
  display: block;
  margin-top: 2px;
  color: var(--danger-text) !important;
}

.official-models-empty {
  margin: 0;
  padding: var(--space-4) 0;
  color: var(--text-muted);
  font-size: var(--text-sm);
  text-align: center;
}

.official-models-count {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
  font-variant-numeric: var(--num-tabular);
}

.ui-ok {
  margin: 0;
  color: var(--ok-text);
  font-size: var(--text-sm);
}

.official-loading {
  color: var(--text-secondary);
}

/* ───────── 基础件（与 AdminView / FilesView 同一份配方；半径交给 #app 覆盖） ───────── */

.ui-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  height: var(--control-h-sm);
  padding: 0 var(--space-3);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-size: var(--text-sm);
  line-height: var(--leading-tight);
  white-space: nowrap;
  cursor: pointer;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast),
    opacity var(--transition-fast),
    transform var(--dur-press) var(--ease-standard);
}

.ui-btn:active:not(:disabled) {
  transform: scale(0.97);
}

.ui-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.ui-btn--primary {
  background: var(--aurora-blue);
  color: var(--on-accent);
}

.ui-btn--primary:hover:not(:disabled) {
  filter: brightness(1.08);
}

.ui-btn--ghost {
  border-color: var(--border-subtle);
}

.ui-btn--ghost:hover:not(:disabled) {
  background: var(--fill-2);
}

.ui-btn--danger {
  color: var(--text-secondary);
}

.ui-btn--danger:hover:not(:disabled) {
  background: var(--danger-fill);
  color: var(--danger-text);
}

.ui-input {
  height: var(--control-h-sm);
  min-width: 0;
  padding: 0 var(--space-3);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--text-sm);
  outline: none;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast),
    box-shadow var(--transition-fast);
}

.ui-input::placeholder {
  color: var(--text-muted);
}

.ui-input:focus {
  border-color: var(--aurora-blue);
  box-shadow: 0 0 0 3px var(--accent-ring);
}

select.ui-input {
  cursor: pointer;
}

.ui-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--fill-2);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  white-space: nowrap;
}

.ui-chip--ok {
  background: var(--ok-fill);
  color: var(--ok-text);
}

.ui-chip--muted {
  color: var(--text-muted);
}

.ui-error {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--error-fill);
  color: var(--error-text);
  font-size: var(--text-sm);
}

/* ───────── 窄屏：单列 + 表格卡片化（全局 .ui-table--cards 接管） ───────── */

@media (max-width: 760px) {
  .official-admin {
    padding: var(--space-3);
  }

  .official-connect {
    grid-template-columns: 1fr;
  }

  .official-head,
  .official-models-head {
    flex-direction: column;
  }

  .official-head-actions {
    width: 100%;
  }

  .official-head-actions .ui-btn {
    flex: 1 1 auto;
    min-height: var(--hit-target);
  }

  .official-tab {
    flex: 1 1 calc(50% - var(--space-2));
  }

  .official-models-scroll {
    max-height: none;
    overflow: visible;
  }

  .official-models-table {
    background: transparent;
  }

  .official-models-table .ui-input {
    width: 100%;
    min-width: 0;
    min-height: var(--hit-target);
  }

  .official-model-tools .ui-btn,
  .official-key-row .ui-btn {
    flex: 1 1 auto;
    min-height: var(--hit-target);
  }
}
</style>
