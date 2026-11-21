<script setup lang="ts">
/**
 * 子代理区组（v46，docs/06 §19.6、docs/08 §1）：
 * 自定义子代理的增删改 + 每个子代理的工具权限档与独立模型。
 *
 * 三条与相邻区组一致的约定：
 * - 保存走 `settings:update` 的 `agent.subagents` **整数组**（数组权威：不在数组里 = 删除），
 *   只传这一个键，不动同级的 `tools` / `browser` / `snapshots`；
 * - 配置未水合时按空列表渲染（不伪造预设）；改动由主进程 `settings:changed` 回灌，
 *   下一次请求的 `task` 工具描述随之重建，无需重启；
 * - 回执经 `notify` 上抛给页级 Toast（本组件不自己渲染 Toast）。
 *
 * 为什么模型用两个下拉（来源 + 模型）而不是自由输入：模型 id 必须落在已配置的
 * `llm.providers` 里才有意义；`providerId` 与 `model` 都为空 = 跟随当前会话模型。
 */
import { computed, reactive, ref, watch } from 'vue'
import { ChevronRight } from '@aurora/shared/browser'
import type { SubagentAccess, SubagentConfig } from '@aurora/shared/browser'
import {
  DEFAULT_AGENT_SUBAGENTS,
  MAX_SUBAGENTS,
  SUBAGENT_ACCESS_LABELS,
  SUBAGENT_ACCESS_LEVELS,
} from '@aurora/shared/browser'
import AppButton from '../../shared/components/AppButton.vue'
import SettingField from '../../shared/components/SettingField.vue'
import { useSettingsStore } from '../../shared/stores.js'

type NotifyPayload = { tone: 'info' | 'warn' | 'error' | 'ok'; text: string }

const emit = defineEmits<{
  (event: 'notify', payload: NotifyPayload): void
}>()

const settingsStore = useSettingsStore()

const agents = computed<SubagentConfig[]>(() => settingsStore.settings?.agent.subagents ?? [])

/** 可选模型来源（`llm.providers`；凭据在 `settings:get` 里已脱敏，这里只读 id 与模型列表） */
const providers = computed(() =>
  Object.entries(settingsStore.settings?.llm.providers ?? {}).map(([id, provider]) => ({
    id,
    model: provider.model,
    modelList: provider.modelList,
  })),
)

/** 正在编辑「指令」的行（默认收起：列表要能一眼扫完） */
const editingId = ref<string | null>(null)
/** 待确认删除的子代理 id（同一时刻只确认一个，与 MCP / 模型页同款） */
const pendingRemoveId = ref<string | null>(null)
/** 新增表单是否展开（空列表时默认展开，见下） */
const showAdd = ref(false)

const form = reactive({
  name: '',
  description: '',
  instructions: '',
  access: 'read' as SubagentAccess,
})

watch(
  agents,
  (next) => {
    // 待确认 / 正在编辑的条目被别处删掉时收起对应 UI，避免指向不存在的行。
    if (pendingRemoveId.value !== null && !next.some((item) => item.id === pendingRemoveId.value)) {
      pendingRemoveId.value = null
    }
    if (editingId.value !== null && !next.some((item) => item.id === editingId.value)) {
      editingId.value = null
    }
    if (next.length === 0) showAdd.value = true
  },
  { immediate: true },
)

function notify(tone: NotifyPayload['tone'], text: string): void {
  emit('notify', { tone, text })
}

async function save(next: SubagentConfig[]): Promise<boolean> {
  const ok = await settingsStore.update({ agent: { subagents: next } })
  if (!ok) {
    notify('error', settingsStore.error ?? '子代理配置保存失败')
    return false
  }
  return true
}

/** 改一条（按 id 定位）：整数组回传，未列出的条目视为删除 —— 所以必须带上全部。 */
async function patch(id: string, change: Partial<SubagentConfig>): Promise<boolean> {
  const next = agents.value.map((item) => (item.id === id ? { ...item, ...change } : item))
  return save(next)
}

async function setEnabled(item: SubagentConfig, enabled: boolean): Promise<void> {
  if (await patch(item.id, { enabled })) {
    notify('ok', enabled ? `已启用「${item.name}」` : `已禁用「${item.name}」`)
  }
}

async function rename(item: SubagentConfig, name: string): Promise<void> {
  const next = name.trim()
  if (next === '' || next === item.name) return
  await patch(item.id, { name: next })
}

async function setDescription(item: SubagentConfig, description: string): Promise<void> {
  const next = description.trim()
  if (next === '' || next === item.description) return
  await patch(item.id, { description: next })
}

async function setInstructions(item: SubagentConfig, instructions: string): Promise<void> {
  const next = instructions.trim()
  if (next === '' || next === item.instructions) return
  await patch(item.id, { instructions: next })
}

async function setAccess(item: SubagentConfig, access: SubagentAccess): Promise<void> {
  if (access === item.access) return
  await patch(item.id, { access })
}

/**
 * 改模型来源：model 同步落到该来源的 `model`（沿用「所选来源的默认模型」口径）；
 * 选「跟随当前会话模型」（空值）时两个字段一起清空。
 */
async function setProvider(item: SubagentConfig, providerId: string): Promise<void> {
  const provider = providers.value.find((entry) => entry.id === providerId)
  const model = providerId === '' ? '' : (provider?.model.trim() ?? '')
  await patch(item.id, { model: { providerId, model } })
}

async function setModel(item: SubagentConfig, model: string): Promise<void> {
  await patch(item.id, { model: { providerId: item.model.providerId, model } })
}

/** 该行的模型候选：当前值 + 来源的 `model` + `modelList`（去重、去空白） */
function modelsOf(item: SubagentConfig): string[] {
  const provider = providers.value.find((entry) => entry.id === item.model.providerId)
  const out: string[] = []
  for (const candidate of [
    item.model.model,
    provider?.model ?? '',
    ...(provider?.modelList ?? []),
  ]) {
    const value = candidate.trim()
    if (value !== '' && !out.includes(value)) out.push(value)
  }
  return out
}

/** 行摘要：只读 / 可写 / 可执行 + 模型归属 */
function rowSummary(item: SubagentConfig): string {
  const access = SUBAGENT_ACCESS_LABELS[item.access]
  const model =
    item.model.providerId === '' || item.model.model === ''
      ? '跟随会话模型'
      : `${item.model.providerId} · ${item.model.model}`
  return `${access} · ${model}`
}

/** 新增行的 id：`custom-1` / `custom-2`…（用户不手写 id；冲突时顺延） */
function nextCustomId(): string {
  const taken = new Set(agents.value.map((item) => item.id.toLowerCase()))
  let index = 1
  while (taken.has(`custom-${index}`)) index += 1
  return `custom-${index}`
}

async function addAgent(): Promise<void> {
  const name = form.name.trim()
  const description = form.description.trim()
  const instructions = form.instructions.trim()
  if (name === '' || description === '' || instructions === '') {
    notify('warn', '名称、用途说明与指令都要填')
    return
  }
  if (agents.value.length >= MAX_SUBAGENTS) {
    notify('warn', `子代理最多 ${MAX_SUBAGENTS} 个`)
    return
  }
  const item: SubagentConfig = {
    id: nextCustomId(),
    name,
    description,
    instructions,
    enabled: true,
    access: form.access,
    model: { providerId: '', model: '' },
    builtin: false,
  }
  if (!(await save([...agents.value, item]))) return
  form.name = ''
  form.description = ''
  form.instructions = ''
  form.access = 'read'
  showAdd.value = false
  notify('ok', `已添加子代理「${name}」`)
}

async function removeAgent(item: SubagentConfig): Promise<void> {
  const next = agents.value.filter((entry) => entry.id !== item.id)
  if (!(await save(next))) return
  pendingRemoveId.value = null
  notify('ok', `已删除子代理「${item.name}」`)
}

/** 内置预设恢复：按 id 找回出厂定义（用户改过的名称 / 指令 / 档位都还原，模型清空 = 跟随会话）。 */
async function resetBuiltin(item: SubagentConfig): Promise<void> {
  const preset = DEFAULT_AGENT_SUBAGENTS.find((entry) => entry.id === item.id)
  if (preset === undefined) return
  const ok = await patch(item.id, {
    name: preset.name,
    description: preset.description,
    instructions: preset.instructions,
    access: preset.access,
    model: { ...preset.model },
  })
  if (ok) notify('ok', `已恢复「${preset.name}」的预设`)
}

function toggleEditing(id: string): void {
  editingId.value = editingId.value === id ? null : id
}
</script>

<template>
  <div class="subagents" data-field="agent.subagents">
    <p class="section-desc">
      让 Agent 按场合把任务派给不同子代理；每个子代理可单独指定模型与工具权限。
    </p>

    <p v-if="agents.length === 0" class="subagents-empty tiny muted">
      还没有子代理。添加一个后，主代理会根据「用途说明」判断什么时候派它。
    </p>

    <article
      v-for="item in agents"
      :key="item.id"
      class="subagent-row"
      :class="{ off: !item.enabled }"
      :data-field="`agent.subagents.${item.id}`"
    >
      <header class="row-head">
        <label class="row-toggle">
          <input
            type="checkbox"
            :checked="item.enabled"
            :data-field="`agent.subagents.${item.id}.enabled`"
            @change="setEnabled(item, ($event.target as HTMLInputElement).checked)"
          />
          <span class="row-name">{{ item.name }}</span>
        </label>
        <code class="mono tiny row-id">{{ item.id }}</code>
        <span v-if="item.builtin" class="row-badge">内置</span>
        <span class="grow" />
        <span class="tiny muted row-summary">{{ rowSummary(item) }}</span>
        <button
          type="button"
          class="icon-btn"
          :aria-expanded="editingId === item.id"
          :title="editingId === item.id ? '收起指令' : '编辑指令'"
          :data-field="`agent.subagents.${item.id}.edit`"
          @click="toggleEditing(item.id)"
        >
          <ChevronRight class="chev" :class="{ open: editingId === item.id }" :size="14" />
        </button>
      </header>

      <div class="row-fields">
        <SettingField
          :data-field="`agent.subagents.${item.id}.name`"
          label="名称"
          hint="展示名，报告与卡片徽章都用它"
        >
          <input
            class="input"
            type="text"
            maxlength="40"
            :value="item.name"
            @change="rename(item, ($event.target as HTMLInputElement).value)"
          />
        </SettingField>

        <SettingField
          :data-field="`agent.subagents.${item.id}.description`"
          label="用途说明"
          hint="主代理据此判断什么时候派它，写清适用场合"
        >
          <input
            class="input"
            type="text"
            maxlength="200"
            :value="item.description"
            @change="setDescription(item, ($event.target as HTMLInputElement).value)"
          />
        </SettingField>

        <SettingField
          :data-field="`agent.subagents.${item.id}.access`"
          label="工具权限"
          hint="写入与命令仍按当前权限档逐次确认"
        >
          <select
            class="input"
            :value="item.access"
            @change="setAccess(item, ($event.target as HTMLSelectElement).value as SubagentAccess)"
          >
            <option v-for="level in SUBAGENT_ACCESS_LEVELS" :key="level" :value="level">
              {{ SUBAGENT_ACCESS_LABELS[level] }}
            </option>
          </select>
        </SettingField>

        <SettingField
          :data-field="`agent.subagents.${item.id}.model.providerId`"
          label="模型来源"
          hint="默认跟随当前会话模型；独立指定可降低子任务成本"
        >
          <select
            class="input"
            :value="item.model.providerId"
            @change="setProvider(item, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">跟随当前会话模型</option>
            <option
              v-if="
                item.model.providerId !== '' &&
                !providers.some((provider) => provider.id === item.model.providerId)
              "
              :value="item.model.providerId"
            >
              所选来源不存在（{{ item.model.providerId }}）
            </option>
            <option v-for="provider in providers" :key="provider.id" :value="provider.id">
              {{ provider.id }}
            </option>
          </select>
        </SettingField>

        <SettingField
          v-if="item.model.providerId !== ''"
          :data-field="`agent.subagents.${item.id}.model.model`"
          label="模型"
          hint="从所选来源的模型列表中选择"
        >
          <select
            class="input"
            :value="item.model.model"
            @change="setModel(item, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">请选择模型</option>
            <option v-for="model in modelsOf(item)" :key="model" :value="model">
              {{ model }}
            </option>
          </select>
        </SettingField>
      </div>

      <div v-if="editingId === item.id" class="row-instructions">
        <span class="tiny muted">子代理指令</span>
        <textarea
          class="input instructions"
          rows="6"
          maxlength="4000"
          spellcheck="false"
          :value="item.instructions"
          :data-field="`agent.subagents.${item.id}.instructions`"
          @change="setInstructions(item, ($event.target as HTMLTextAreaElement).value)"
        />
        <p class="tiny muted">
          这段是子代理的系统提示词：写清角色、工作方式与报告要求；「看不到父对话、不向用户提问」由
          Aurora 统一追加。
        </p>
      </div>

      <footer class="row-actions">
        <AppButton
          v-if="item.builtin"
          size="sm"
          :data-field="`agent.subagents.${item.id}.reset`"
          @click="resetBuiltin(item)"
        >
          恢复预设
        </AppButton>
        <span class="grow" />
        <template v-if="pendingRemoveId === item.id">
          <span class="tiny">确定删除「{{ item.name }}」？</span>
          <AppButton size="sm" @click="pendingRemoveId = null">取消</AppButton>
          <AppButton size="sm" @click="removeAgent(item)">删除</AppButton>
        </template>
        <AppButton
          v-else
          size="sm"
          :data-field="`agent.subagents.${item.id}.remove`"
          @click="pendingRemoveId = item.id"
        >
          删除
        </AppButton>
      </footer>
    </article>

    <div class="add-area">
      <AppButton size="sm" :data-field="`agent.subagents.add`" @click="showAdd = !showAdd">
        {{ showAdd ? '收起新增' : '添加子代理' }}
      </AppButton>
      <span class="tiny muted">最多 {{ MAX_SUBAGENTS }} 个；新子代理默认只读、跟随会话模型</span>
    </div>

    <div v-if="showAdd" class="add-form" data-field="agent.subagents.addForm">
      <SettingField label="名称" hint="展示名，例如 Reviewer">
        <input
          v-model="form.name"
          class="input"
          type="text"
          maxlength="40"
          :data-field="`agent.subagents.add.name`"
        />
      </SettingField>
      <SettingField label="用途说明" hint="什么时候派它：写清适用与不适用的场合">
        <input
          v-model="form.description"
          class="input"
          type="text"
          maxlength="200"
          :data-field="`agent.subagents.add.description`"
        />
      </SettingField>
      <SettingField label="工具权限" hint="写入与命令仍按当前权限档逐次确认">
        <select
          class="input"
          :value="form.access"
          :data-field="`agent.subagents.add.access`"
          @change="form.access = ($event.target as HTMLSelectElement).value as SubagentAccess"
        >
          <option v-for="level in SUBAGENT_ACCESS_LEVELS" :key="level" :value="level">
            {{ SUBAGENT_ACCESS_LABELS[level] }}
          </option>
        </select>
      </SettingField>
      <div class="add-instructions">
        <span class="tiny muted">指令（系统提示词）</span>
        <textarea
          v-model="form.instructions"
          class="input instructions"
          rows="5"
          maxlength="4000"
          spellcheck="false"
          :data-field="`agent.subagents.add.instructions`"
        />
      </div>
      <div class="row-actions">
        <AppButton size="sm" :data-field="`agent.subagents.add.confirm`" @click="addAgent">
          添加
        </AppButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 本组件独占类名（不依赖 AgentToolsPage 的 scoped `.sub` / `.row`）：跨组件复用会互相打穿样式。 */
.subagents {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.subagents-empty {
  margin: 0;
}

.subagent-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-raised);
}

/* 禁用行整体降透明度，但保留可点（用户要能重新勾上） */
.subagent-row.off {
  opacity: 0.6;
}

.row-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.row-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.row-name {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.row-id {
  color: var(--text-muted);
  white-space: nowrap;
}

.row-badge {
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid var(--border-subtle);
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: 18px;
  white-space: nowrap;
}

.row-summary {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 46%;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-xs);
  color: var(--text-muted);
}

.icon-btn:hover {
  background: var(--fill-1);
  color: var(--text-primary);
}

.chev {
  transition: transform var(--transition-fast);
}

.chev.open {
  transform: rotate(90deg);
}

/* 字段单列铺满：`SettingField` 的标签列最小 140px，塞进多列网格时输入框只剩几十像素
 * （2026-11-21 首跑截图实测）。设置页其余区组也都是单列，这里保持一致。 */
.row-fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0 var(--space-3);
}

.row-instructions {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.instructions {
  width: 100%;
  resize: vertical;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.6;
}

.row-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.add-area {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.add-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px dashed var(--border-subtle);
  border-radius: var(--radius-sm);
}

.add-instructions {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.grow {
  flex: 1;
}
</style>
