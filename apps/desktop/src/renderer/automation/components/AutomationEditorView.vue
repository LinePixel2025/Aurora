<script setup lang="ts">
/**
 * 自动化独立窗口的编辑器视图（docs/07 §2.2.1、docs/13 §11）。
 *
 * 主界面只保留自动化列表；新建 / 编辑经 `automation:openWindow` 进入本窗口。
 * 组件仍保留原 Modal 的 data-field 锚点，截图与验收从 Modal 迁到独立窗口。
 */
import { computed, onMounted, ref } from 'vue'
import type {
  AutomationAction,
  AutomationCatalog,
  AutomationDefinition,
  AutomationDescriptorField,
  AutomationMode,
} from '@aurora/shared'
import { deepClone } from '@aurora/shared/browser'
import AppButton from '../../shared/components/AppButton.vue'
import AppTooltip from '../../shared/components/AppTooltip.vue'
import AutomationFieldInput from '../../chat/components/AutomationFieldInput.vue'
import {
  Bell,
  Bot,
  FolderOpen,
  Info,
  Plus,
  School,
  Sparkles,
  Trash2,
  X,
  Zap,
} from '@aurora/shared/browser'

const props = defineProps<{
  mode: AutomationMode
  automationId?: string
}>()

const emit = defineEmits<{
  (event: 'close'): void
}>()

interface DraftAction {
  kind: string
  params: Record<string, unknown>
}

interface EditorDraft {
  id: string
  name: string
  mode: AutomationMode
  triggerKind: string
  triggerParams: Record<string, unknown>
  prompt: string
  actions: DraftAction[]
  enabled: boolean
  maxRuns: string
  runCount: number
}

const catalog = ref<AutomationCatalog | null>(null)
const draft = ref<EditorDraft | null>(null)
const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)

const conditions = computed(() => catalog.value?.conditions ?? [])
const actions = computed(() => catalog.value?.actions ?? [])
const availableActions = computed(() => actions.value.filter((item) => item.available))
const conditionOf = (kind: string) => conditions.value.find((item) => item.kind === kind)
const actionDescriptorOf = (kind: string) => actions.value.find((item) => item.kind === kind)
const selectedCondition = computed(() =>
  draft.value === null ? undefined : conditionOf(draft.value.triggerKind),
)

const ACTION_ICONS: Record<string, typeof Bell> = {
  'system-notify': Bell,
  'classisland-remind': School,
  'open-folder': FolderOpen,
}

function actionIconOf(kind: string): typeof Bell {
  return ACTION_ICONS[kind] ?? Bell
}

function triggerIconOf(kind: string): typeof Sparkles {
  switch (kind) {
    case 'pre-class':
      return Bell
    case 'next-lesson':
      return School
    default:
      return Sparkles
  }
}

function emptyTriggerParams(kind: string): Record<string, unknown> {
  switch (kind) {
    case 'daily':
      return { at: '08:00', weekdays: [] }
    case 'interval':
      return { everyMinutes: 30 }
    case 'pre-class':
    case 'pre-end':
      return { leadMinutes: 5 }
    case 'next-lesson':
      return { subject: '' }
    default:
      return {}
  }
}

function emptyAction(kind: string): DraftAction {
  const params: Record<string, unknown> = {}
  if (kind === 'system-notify') {
    params['title'] = ''
    params['body'] = ''
  } else if (kind === 'classisland-remind') {
    params['title'] = ''
    params['body'] = ''
    params['channel'] = 'custom'
  } else if (kind === 'open-folder') {
    params['target'] = 'subject'
    params['subject'] = ''
    params['path'] = ''
  }
  return { kind, params }
}

function ensureParamKeys(
  params: Record<string, unknown>,
  fields: AutomationDescriptorField[],
): void {
  for (const field of fields) {
    if (params[field.key] !== undefined) continue
    if (field.type === 'weekdays') params[field.key] = []
    else if (field.type === 'number') params[field.key] = field.min ?? 0
    else if (field.type === 'select') params[field.key] = field.options?.[0]?.value ?? ''
    else params[field.key] = ''
  }
}

function createDraft(def?: AutomationDefinition): EditorDraft {
  if (def !== undefined) {
    return {
      id: def.id,
      name: def.name,
      mode: def.mode,
      triggerKind: def.trigger.kind,
      triggerParams: deepClone(def.trigger.params ?? {}),
      prompt: def.prompt ?? '',
      actions: (def.actions ?? []).map((action) => ({
        kind: action.kind,
        params: deepClone(action.params ?? {}),
      })),
      enabled: def.enabled,
      maxRuns: String(def.maxRuns ?? 0),
      runCount: def.runCount ?? 0,
    }
  }
  const triggerKind = props.mode === 'normal' ? 'pre-class' : 'daily'
  return {
    id: '',
    name: '',
    mode: props.mode,
    triggerKind,
    triggerParams: emptyTriggerParams(triggerKind),
    prompt: '',
    actions: [emptyAction('system-notify')],
    enabled: true,
    maxRuns: '0',
    runCount: 0,
  }
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  const [listResult, catalogResult] = await Promise.all([
    window.aurora.automation.list(),
    window.aurora.automation.catalog(),
  ])
  loading.value = false
  if (!listResult.ok) {
    error.value = listResult.message
    return
  }
  if (!catalogResult.ok) {
    error.value = catalogResult.message
    return
  }
  catalog.value = catalogResult.value
  const def =
    props.automationId === undefined
      ? undefined
      : listResult.value.user.find((item) => item.id === props.automationId)
  if (props.automationId !== undefined && def === undefined) {
    error.value = '该自动化已不存在，可能已被删除。'
    return
  }
  draft.value = createDraft(def)
  ensureParamKeys(draft.value.triggerParams, conditionOf(draft.value.triggerKind)?.fields ?? [])
  for (const action of draft.value.actions) {
    ensureParamKeys(action.params, actionDescriptorOf(action.kind)?.fields ?? [])
  }
}

function switchTriggerKind(kind: string): void {
  if (draft.value === null || draft.value.triggerKind === kind) return
  draft.value.triggerKind = kind
  draft.value.triggerParams = emptyTriggerParams(kind)
  ensureParamKeys(draft.value.triggerParams, conditionOf(kind)?.fields ?? [])
}

function removeAction(index: number): void {
  draft.value?.actions.splice(index, 1)
}

function switchActionKind(index: number, kind: string): void {
  const current = draft.value
  if (current === null || current.actions[index]?.kind === kind) return
  const next = emptyAction(kind)
  ensureParamKeys(next.params, actionDescriptorOf(kind)?.fields ?? [])
  current.actions[index] = next
}

function setParam(params: Record<string, unknown>, key: string, value: unknown): void {
  params[key] = value
}

function parseMaxRuns(raw: string): number {
  const parsed = Number(raw.trim())
  if (raw.trim() === '' || !Number.isFinite(parsed)) return 0
  return Math.max(0, Math.floor(parsed))
}

async function save(): Promise<void> {
  const current = draft.value
  if (current === null) return
  if (current.name.trim() === '') {
    error.value = '名称不能为空'
    return
  }
  saving.value = true
  error.value = null
  const payload: AutomationDefinition = {
    id: current.id,
    name: current.name.trim(),
    enabled: current.enabled,
    mode: current.mode,
    trigger: {
      kind: current.triggerKind as AutomationDefinition['trigger']['kind'],
      params: deepClone(current.triggerParams),
    },
    maxRuns: parseMaxRuns(current.maxRuns),
    runCount: current.runCount,
    createdAt: '',
    updatedAt: '',
  }
  if (current.mode === 'agent') payload.prompt = current.prompt
  else {
    payload.actions = current.actions.map((action) => ({
      kind: action.kind as AutomationAction['kind'],
      params: deepClone(action.params),
    }))
  }
  const result = await window.aurora.automation.save(deepClone(payload))
  saving.value = false
  if (!result.ok) {
    error.value = result.message
    return
  }
  emit('close')
}

onMounted(() => void load())
</script>

<template>
  <section class="editor-view" data-field="automation.editor">
    <header class="view-head">
      <component
        :is="mode === 'agent' ? Bot : Zap"
        :size="15"
        :stroke-width="1.7"
        aria-hidden="true"
      />
      <h2>{{ automationId === undefined ? '新建自动化' : '编辑自动化' }}</h2>
      <span class="grow" />
      <AppTooltip text="关闭" placement="bottom">
        <button type="button" class="icon-btn press" aria-label="关闭" @click="emit('close')">
          <X :size="15" :stroke-width="1.7" aria-hidden="true" />
        </button>
      </AppTooltip>
    </header>

    <p v-if="loading" class="feedback muted">加载中…</p>
    <p v-if="error !== null" class="feedback error" role="alert">{{ error }}</p>

    <div v-if="draft !== null" class="view-body">
      <div class="field-row">
        <span class="field-label">名称</span>
        <input v-model="draft.name" class="input" type="text" placeholder="例如：上课前提醒我" />
      </div>

      <div class="field-row">
        <span class="field-label">模式</span>
        <div class="mode-picker">
          <button
            type="button"
            class="mode-option press"
            :class="{ active: draft.mode === 'agent' }"
            @click="draft.mode = 'agent'"
          >
            <span class="mode-head">
              <Bot :size="13" :stroke-width="1.8" aria-hidden="true" />
              Agent Mode
            </span>
            <span class="tiny muted">触发后由 Agent 执行任务</span>
          </button>
          <button
            type="button"
            class="mode-option press"
            :class="{ active: draft.mode === 'normal' }"
            @click="draft.mode = 'normal'"
          >
            <span class="mode-head">
              <Zap :size="13" :stroke-width="1.8" aria-hidden="true" />
              Normal Mode
            </span>
            <span class="tiny muted">按预设操作执行</span>
          </button>
        </div>
      </div>

      <div class="field-row">
        <span class="field-label">调用次数</span>
        <div class="runs-row">
          <input
            v-model="draft.maxRuns"
            class="input"
            data-field="automation.max-runs"
            type="number"
            min="0"
            step="1"
            placeholder="0"
          />
          <span class="tiny muted runs-note">
            上限（0 = 不限）；用满自动停用<template v-if="draft.id !== ''">
              。已调用 {{ draft.runCount }} 次</template
            >
          </span>
          <AppButton
            v-if="draft.id !== '' && draft.runCount > 0"
            variant="ghost"
            size="sm"
            data-action="automation.reset-runs"
            @click="draft.runCount = 0"
          >
            重置计数
          </AppButton>
        </div>
      </div>

      <section class="section">
        <div class="section-head">
          <component
            :is="triggerIconOf(draft.triggerKind)"
            :size="13"
            :stroke-width="1.7"
            aria-hidden="true"
          />
          <span>触发条件</span>
          <AppTooltip text="课堂类条件依赖课程表数据（来源与节次在「设置 → 模式」里配置）。">
            <button type="button" class="hint-dot" aria-label="触发条件的说明">
              <Info :size="12" :stroke-width="1.8" aria-hidden="true" />
            </button>
          </AppTooltip>
        </div>

        <div class="tile-grid" role="radiogroup" data-field="automation.trigger-kind">
          <AppTooltip v-for="item in conditions" :key="item.kind" :text="item.description">
            <button
              type="button"
              class="tile press"
              role="radio"
              :data-kind="item.kind"
              :aria-checked="draft.triggerKind === item.kind"
              :class="{ active: draft.triggerKind === item.kind }"
              @click="switchTriggerKind(item.kind)"
            >
              <component
                :is="triggerIconOf(item.kind)"
                :size="16"
                :stroke-width="1.7"
                aria-hidden="true"
              />
              <span class="tile-label">{{ item.label }}</span>
            </button>
          </AppTooltip>
        </div>

        <p v-if="selectedCondition !== undefined" class="section-note">
          {{ selectedCondition.description }}
        </p>

        <div v-if="(selectedCondition?.fields ?? []).length > 0" class="param-grid">
          <AutomationFieldInput
            v-for="field in selectedCondition?.fields ?? []"
            :key="field.key"
            :field="field"
            :params="draft.triggerParams"
            @update="setParam(draft.triggerParams, $event.key, $event.value)"
          />
        </div>
      </section>

      <section v-if="draft.mode === 'agent'" class="section">
        <div class="section-head">
          <Sparkles :size="13" :stroke-width="1.7" aria-hidden="true" />
          <span>任务指令</span>
          <AppTooltip text="写清楚目标、步骤与产出；触发时间等上下文会自动附带。">
            <button type="button" class="hint-dot" aria-label="任务指令的说明">
              <Info :size="12" :stroke-width="1.8" aria-hidden="true" />
            </button>
          </AppTooltip>
        </div>
        <textarea
          v-model="draft.prompt"
          class="input textarea"
          rows="5"
          placeholder="例如：把桌面上今天新增的课件按科目归档到资料文件夹"
        />
      </section>

      <section v-else class="section">
        <div class="section-head">
          <Zap :size="13" :stroke-width="1.7" aria-hidden="true" />
          <span>操作（按顺序执行）</span>
          <AppTooltip
            text="操作是封闭清单（通知 / ClassIsland 提醒 / 打开文件夹）——要更复杂的任务请改用 Agent Mode。"
          >
            <button type="button" class="hint-dot" aria-label="操作清单的说明">
              <Info :size="12" :stroke-width="1.8" aria-hidden="true" />
            </button>
          </AppTooltip>
          <span class="grow" />
          <span class="tiny muted step-count">{{ draft.actions.length }}/10</span>
        </div>

        <article
          v-for="(action, index) in draft.actions"
          :key="index"
          class="action-row"
          :data-field="'automation.action-' + index"
        >
          <div class="action-head">
            <span class="action-index mono" aria-hidden="true">{{ index + 1 }}</span>
            <div class="chip-group">
              <button
                v-for="item in availableActions"
                :key="item.kind"
                type="button"
                class="chip press"
                :class="{ active: action.kind === item.kind }"
                :aria-pressed="action.kind === item.kind"
                @click="switchActionKind(index, item.kind)"
              >
                <component
                  :is="actionIconOf(item.kind)"
                  :size="11"
                  :stroke-width="1.8"
                  aria-hidden="true"
                />
                {{ item.label }}
              </button>
            </div>
            <span class="grow" />
            <AppTooltip text="移除该操作">
              <button
                type="button"
                class="icon-btn press danger"
                aria-label="移除该操作"
                @click="removeAction(index)"
              >
                <Trash2 :size="13" :stroke-width="1.7" aria-hidden="true" />
              </button>
            </AppTooltip>
          </div>
          <div v-if="(actionDescriptorOf(action.kind)?.fields ?? []).length > 0" class="param-grid">
            <AutomationFieldInput
              v-for="field in actionDescriptorOf(action.kind)?.fields ?? []"
              :key="field.key"
              :field="field"
              :params="action.params"
              @update="setParam(action.params, $event.key, $event.value)"
            />
          </div>
        </article>

        <AppButton
          variant="secondary"
          size="sm"
          data-action="automation.add-action"
          :disabled="draft.actions.length >= 10"
          @click="draft.actions.push(emptyAction(availableActions[0]?.kind ?? 'system-notify'))"
        >
          <Plus :size="13" :stroke-width="1.9" aria-hidden="true" />
          添加操作
        </AppButton>
      </section>
    </div>

    <footer class="view-foot">
      <AppButton
        variant="secondary"
        size="sm"
        data-action="automation.editor-cancel"
        @click="emit('close')"
      >
        取消
      </AppButton>
      <AppButton variant="primary" size="sm" :disabled="saving || draft === null" @click="save()">
        {{ saving ? '保存中…' : '保存' }}
      </AppButton>
    </footer>
  </section>
</template>

<style scoped>
.editor-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--glass-content);
}

.view-head,
.view-foot {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
}

.view-head h2 {
  margin: 0;
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
}

.view-foot {
  justify-content: flex-end;
  border-top: 1px solid var(--border-subtle);
  border-bottom: 0;
}

.view-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.grow {
  flex: 1;
}

.feedback {
  margin: 0 var(--space-4);
  padding: 6px var(--space-3);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
}

.feedback.error {
  background: var(--error-fill);
  color: var(--error-text);
}

.field-row {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  align-items: center;
  gap: var(--space-2);
}

.field-label {
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.input {
  width: 100%;
  min-width: 0;
  height: var(--control-h-sm);
  padding: 0 var(--space-2);
  border-radius: var(--radius-xs);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  color: var(--text-primary);
}

.input:hover {
  background: var(--fill-2);
}

.input:focus-visible {
  outline: none;
  border-color: var(--aurora-blue);
  box-shadow: 0 0 0 2px var(--accent-ring);
}

.textarea {
  height: auto;
  padding: var(--space-2);
  line-height: var(--leading-relaxed);
  resize: vertical;
}

.runs-row,
.section-head,
.action-head,
.chip-group {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.runs-row .input {
  width: 84px;
  flex: 0 0 auto;
}

.runs-note {
  flex: 1;
}

.section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}

.section-head {
  color: var(--text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

.section-note {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.tile-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: var(--space-2);
}

.tile {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  color: var(--text-secondary);
  text-align: left;
}

.tile.active {
  border-color: var(--aurora-blue);
  background: color-mix(in srgb, var(--aurora-blue) 10%, transparent);
  color: var(--text-primary);
}

.tile-label {
  font-size: var(--text-xs);
}

.mode-picker {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--space-2);
}

.mode-option {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  text-align: left;
}

.mode-option.active {
  border-color: var(--aurora-blue);
  background: color-mix(in srgb, var(--aurora-blue) 8%, transparent);
}

.mode-head {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-primary);
  font-weight: var(--weight-medium);
}

.param-grid {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.action-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--fill-1);
  border: 1px solid var(--border-subtle);
}

.action-index {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--fill-3);
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

.chip-group {
  flex-wrap: wrap;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  color: var(--text-secondary);
  font-size: var(--text-xs);
}

.chip.active {
  border-color: var(--aurora-blue);
  background: color-mix(in srgb, var(--aurora-blue) 16%, transparent);
  color: var(--text-primary);
}

.icon-btn,
.hint-dot {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-xs);
  color: var(--text-muted);
}

.icon-btn:hover,
.hint-dot:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.icon-btn.danger:hover {
  color: var(--status-error);
}
</style>
