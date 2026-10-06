<script setup lang="ts">
/** 文件自感知设置页（v28，docs/06 §26、docs/07 §2.5）。 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { FileAwarenessNote, FileAwarenessRecord, FileAwarenessStatus } from '@aurora/shared'
import { formatTokenCount } from '@aurora/shared/browser'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import SettingField from '../../shared/components/SettingField.vue'
import { useSettingsStore, useWindowStore } from '../../shared/stores.js'
import FileAwarenessRecordList from '../components/FileAwarenessRecordList.vue'

const settingsStore = useSettingsStore()
const windowStore = useWindowStore()
const status = ref<FileAwarenessStatus | null>(null)
const records = ref<FileAwarenessRecord[]>([])
const notes = ref<FileAwarenessNote[]>([])
const error = ref<string | null>(null)
const message = ref<string | null>(null)
const recordsOpen = ref(false)
const resetConfirming = ref(false)
const resetting = ref(false)
let offChanged: (() => void) | null = null

const config = computed(() => settingsStore.settings?.fileAwareness ?? null)
const providers = computed(() =>
  Object.entries(settingsStore.settings?.llm.providers ?? {}).map(([id, provider]) => ({
    id,
    ...provider,
  })),
)
const backgroundProvider = computed(() => {
  const id = config.value?.backgroundModel.providerId ?? ''
  return providers.value.find((provider) => provider.id === id) ?? null
})
const backgroundModels = computed(() => {
  const provider = backgroundProvider.value
  const selected = config.value?.backgroundModel.model.trim() ?? ''
  const models: string[] = []
  for (const id of [selected, provider?.model ?? '', ...(provider?.modelList ?? [])]) {
    const value = id.trim()
    if (value !== '' && !models.includes(value)) models.push(value)
  }
  return models
})
const usageLabel = computed(() => {
  const usage = status.value?.usage
  return usage === undefined || usage.rounds <= 0 ? '暂无用量' : formatTokenCount(usage.totalTokens)
})
const usageTitle = computed(() => {
  const usage = status.value?.usage
  if (usage === undefined || usage.rounds <= 0) return '模型尚未回传 token 用量'
  return `输入 ${usage.promptTokens} / 输出 ${usage.completionTokens} / 缓存 ${usage.cachedTokens} / ${usage.rounds} 轮`
})
const readyToEnable = computed(
  () =>
    config.value !== null &&
    config.value.watchedDirs.length > 0 &&
    config.value.knowledgeDir.trim() !== '' &&
    config.value.contentConsentAccepted,
)

async function save(patch: Partial<NonNullable<typeof config.value>>): Promise<void> {
  const current = config.value
  if (current === null) return
  const ok = await settingsStore.update({ fileAwareness: { ...current, ...patch } })
  if (!ok) error.value = settingsStore.error
  else {
    error.value = null
    message.value = '已保存'
    await refresh()
  }
}

async function setBackgroundProvider(providerId: string): Promise<void> {
  const provider = providers.value.find((item) => item.id === providerId)
  await save({
    backgroundModel: {
      providerId,
      model: providerId === '' ? '' : (provider?.model.trim() ?? ''),
    },
  })
}

async function setBackgroundModel(model: string): Promise<void> {
  const current = config.value
  if (current === null) return
  await save({
    backgroundModel: {
      providerId: current.backgroundModel.providerId,
      model,
    },
  })
}

async function refresh(): Promise<void> {
  const [statusResult, recordsResult, notesResult] = await Promise.all([
    window.aurora.awareness.status(),
    window.aurora.awareness.records({ limit: 100 }),
    window.aurora.awareness.notes({ limit: 100 }),
  ])
  if (statusResult.ok) status.value = statusResult.value
  else error.value = statusResult.message
  if (recordsResult.ok) records.value = recordsResult.value
  if (notesResult.ok) notes.value = notesResult.value
}

async function addDirectory(): Promise<void> {
  const current = config.value
  if (current === null || current.watchedDirs.length >= 3) return
  const picked = await window.aurora.project.pickDirectory()
  if (!picked.ok) {
    error.value = picked.message
    return
  }
  if (picked.value === null) return
  if (current.watchedDirs.some((dir) => dir.toLowerCase() === picked.value!.toLowerCase())) return
  await save({ watchedDirs: [...current.watchedDirs, picked.value] })
}

async function removeDirectory(path: string): Promise<void> {
  const current = config.value
  if (current === null) return
  await save({ watchedDirs: current.watchedDirs.filter((item) => item !== path) })
}

async function pickKnowledgeDir(): Promise<void> {
  const picked = await window.aurora.project.pickDirectory()
  if (!picked.ok) {
    error.value = picked.message
    return
  }
  if (picked.value === null) return
  await save({ knowledgeDir: picked.value })
}

async function setEnabled(enabled: boolean): Promise<void> {
  if (enabled && !readyToEnable.value) {
    error.value = '请先选择监控目录、知识库，并确认正文分析授权'
    return
  }
  await save({ enabled })
}

async function setConsent(accepted: boolean): Promise<void> {
  await save(
    accepted ? { contentConsentAccepted: true } : { contentConsentAccepted: false, enabled: false },
  )
}

async function openKnowledge(): Promise<void> {
  const result = await window.aurora.awareness.openKnowledge()
  if (!result.ok) error.value = result.message
}

async function openMemory(): Promise<void> {
  await windowStore.show('memory')
}

async function scanNow(): Promise<void> {
  const result = await window.aurora.awareness.scanNow()
  if (!result.ok) error.value = result.message
  else message.value = `已扫描并排队 ${result.value} 个文件`
  await refresh()
}

async function clearHistory(): Promise<void> {
  const result = await window.aurora.awareness.clearHistory()
  if (!result.ok) error.value = result.message
  else {
    message.value = '已清空运行记录'
    await refresh()
  }
}

function requestReset(): void {
  error.value = null
  message.value = null
  resetConfirming.value = true
}

function cancelReset(): void {
  resetConfirming.value = false
}

async function resetSystem(): Promise<void> {
  if (resetting.value) return
  resetting.value = true
  try {
    const result = await window.aurora.awareness.reset()
    if (!result.ok) {
      error.value = result.message
      return
    }
    resetConfirming.value = false
    recordsOpen.value = false
    message.value = '已重置自感知系统'
    await refresh()
  } finally {
    resetting.value = false
  }
}

async function analyzeRecord(record: FileAwarenessRecord): Promise<void> {
  const result = await window.aurora.awareness.analyzeNow({ path: record.sourcePath })
  if (!result.ok) error.value = result.message
  else message.value = result.value ? '已加入分析队列' : '该文件不支持内容分析'
}

function closeRecords(): void {
  recordsOpen.value = false
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !recordsOpen.value) return
  event.stopImmediatePropagation()
  closeRecords()
}

onMounted(() => {
  void refresh()
  offChanged = window.aurora.awareness.onChanged(() => void refresh())
  window.addEventListener('keydown', onKeydown, true)
})

onUnmounted(() => {
  offChanged?.()
  offChanged = null
  window.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <section class="page">
    <header>
      <h1 class="page-title">文件自感知</h1>
      <p class="page-sub">记录图片与常见文档变化，并生成可长期查阅的 Markdown 笔记。</p>
    </header>

    <AppToast v-if="error" tone="error">{{ error }}</AppToast>
    <AppToast v-if="message" tone="ok">{{ message }}</AppToast>

    <section class="section-card">
      <h2 class="section-title">启用与授权</h2>
      <p class="section-desc">
        开启后，图片和可解析文档会发给所选后台模型；老式 doc/ppt/xls 只记录使用与变化。
      </p>
      <SettingField
        data-field="fileAwareness.contentConsentAccepted"
        label="正文分析授权"
        hint="只对本页选定目录生效；关闭后停止提取与出网"
      >
        <label class="check">
          <input
            type="checkbox"
            :checked="config?.contentConsentAccepted ?? false"
            @change="setConsent(($event.target as HTMLInputElement).checked)"
          />
          我同意把选定目录内文档正文和图片发送给所选后台模型
        </label>
      </SettingField>
      <SettingField
        data-field="fileAwareness.enabled"
        label="文件自感知"
        hint="修改配置后即时生效；关闭时队列暂停但不会丢"
      >
        <label class="check">
          <input
            type="checkbox"
            :checked="config?.enabled ?? false"
            @change="setEnabled(($event.target as HTMLInputElement).checked)"
          />
          启用后台监听与分析
        </label>
      </SettingField>
    </section>

    <section class="section-card">
      <h2 class="section-title">扫描位置</h2>
      <p class="section-desc">最多选择 3 个目录；首次扫描会把已有图片和可解析文档加入队列。</p>
      <SettingField data-field="fileAwareness.watchedDirs" label="监控目录">
        <div class="stack">
          <div v-for="dir in config?.watchedDirs ?? []" :key="dir" class="row spread">
            <code class="mono path">{{ dir }}</code>
            <AppButton size="sm" variant="ghost" @click="removeDirectory(dir)">移除</AppButton>
          </div>
          <AppButton
            size="sm"
            :disabled="(config?.watchedDirs.length ?? 0) >= 3"
            @click="addDirectory"
          >
            添加目录
          </AppButton>
        </div>
      </SettingField>
      <SettingField
        data-field="fileAwareness.knowledgeDir"
        label="Markdown 知识库"
        hint="按文件格式与首次感知日期分文件夹，建议放在 Documents/Aurora/文件记忆"
      >
        <div class="row spread">
          <code class="mono path">{{ config?.knowledgeDir || '尚未选择' }}</code>
          <AppButton size="sm" @click="pickKnowledgeDir">选择目录</AppButton>
        </div>
      </SettingField>
      <SettingField
        data-field="fileAwareness.includeRecent"
        label="Windows 最近使用"
        hint="只记录目录外 Office 文件路径，不自动分析正文"
      >
        <input
          type="checkbox"
          :checked="config?.includeRecent ?? false"
          @change="save({ includeRecent: ($event.target as HTMLInputElement).checked })"
        />
      </SettingField>
      <SettingField
        data-field="fileAwareness.suggestionsEnabled"
        label="服务气泡"
        hint="只在模型给出可行动建议时显示"
      >
        <input
          type="checkbox"
          :checked="config?.suggestionsEnabled ?? false"
          @change="save({ suggestionsEnabled: ($event.target as HTMLInputElement).checked })"
        />
      </SettingField>
    </section>

    <section class="section-card">
      <h2 class="section-title">后台模型</h2>
      <p class="section-desc">用于文件后台分析；显式选择不可用时暂停，不静默改用主模型。</p>
      <SettingField
        data-field="fileAwareness.backgroundModel.providerId"
        label="模型服务"
        hint="跟随主模型时不单独指定；显式选择后文件正文只发给这个模型"
      >
        <select
          class="input"
          :value="config?.backgroundModel.providerId ?? ''"
          @change="setBackgroundProvider(($event.target as HTMLSelectElement).value)"
        >
          <option value="">跟随主模型</option>
          <option
            v-if="(config?.backgroundModel.providerId ?? '') !== '' && backgroundProvider === null"
            :value="config?.backgroundModel.providerId ?? ''"
          >
            所选服务不存在（{{ config?.backgroundModel.providerId }}）
          </option>
          <option v-for="provider in providers" :key="provider.id" :value="provider.id">
            {{ provider.id }}
          </option>
        </select>
      </SettingField>
      <SettingField
        v-if="(config?.backgroundModel.providerId ?? '') !== ''"
        data-field="fileAwareness.backgroundModel.model"
        label="分析模型"
        hint="从所选服务的模型列表中选择"
      >
        <select
          class="input"
          :value="config?.backgroundModel.model ?? ''"
          @change="setBackgroundModel(($event.target as HTMLSelectElement).value)"
        >
          <option value="">请选择模型</option>
          <option v-for="model in backgroundModels" :key="model" :value="model">
            {{ model }}
          </option>
        </select>
      </SettingField>
    </section>

    <section class="section-card">
      <h2 class="section-title">后台预算</h2>
      <p class="section-desc">每日额度和单文件上限控制模型成本；队列跨重启保留。</p>
      <SettingField
        data-field="fileAwareness.defaultMemoryTtlDays"
        label="记忆默认有效期（天）"
        hint="0 = 永不过期；跟随默认的记忆在重新分析后自动续期"
      >
        <input
          class="input input-num"
          type="number"
          min="0"
          max="3650"
          step="1"
          :value="config?.defaultMemoryTtlDays ?? 0"
          @change="
            save({
              defaultMemoryTtlDays: Number(($event.target as HTMLInputElement).value),
            })
          "
        />
      </SettingField>
      <SettingField data-field="fileAwareness.dailyAnalysisLimit" label="每日分析上限">
        <input
          class="input"
          type="number"
          min="1"
          max="200"
          :value="config?.dailyAnalysisLimit ?? 20"
          @change="save({ dailyAnalysisLimit: Number(($event.target as HTMLInputElement).value) })"
        />
      </SettingField>
      <SettingField data-field="fileAwareness.maxFileMb" label="单文件上限（MB）">
        <input
          class="input"
          type="number"
          min="1"
          max="500"
          :value="config?.maxFileMb ?? 100"
          @change="save({ maxFileMb: Number(($event.target as HTMLInputElement).value) })"
        />
      </SettingField>
      <div class="row wrap">
        <AppButton size="sm" @click="scanNow">立即扫描</AppButton>
        <AppButton size="sm" variant="ghost" @click="openKnowledge">打开知识库文件夹</AppButton>
        <AppButton size="sm" variant="ghost" @click="clearHistory">清空历史</AppButton>
        <AppButton
          v-if="!resetConfirming"
          size="sm"
          variant="danger"
          data-action="awareness.reset"
          :disabled="resetting"
          @click="requestReset"
        >
          重置自感知系统
        </AppButton>
      </div>
      <div v-if="resetConfirming" class="reset-confirm">
        <p>将删除全部笔记、分析历史、用量与后台分析会话；配置和源文件保留，重置后不会自动重建。</p>
        <div class="row wrap">
          <AppButton
            size="sm"
            variant="danger"
            data-action="awareness.reset-confirm"
            :disabled="resetting"
            @click="resetSystem"
          >
            {{ resetting ? '正在重置…' : '确认重置' }}
          </AppButton>
          <AppButton size="sm" variant="ghost" :disabled="resetting" @click="cancelReset">
            取消
          </AppButton>
        </div>
      </div>
    </section>

    <section class="section-card">
      <h2 class="section-title">运行状态</h2>
      <dl class="status-grid">
        <div>
          <dt>监听</dt>
          <dd>
            {{
              status?.waitingForAgent
                ? '等待 Agent'
                : status?.active
                  ? '运行中'
                  : status?.waitingForModel
                    ? '等待模型'
                    : '未运行'
            }}
          </dd>
        </div>
        <div>
          <dt>今日分析</dt>
          <dd>{{ status?.todayAnalyzed ?? 0 }} / {{ status?.dailyAnalysisLimit ?? 0 }}</dd>
        </div>
        <div>
          <dt>队列</dt>
          <dd>{{ status?.queueDepth ?? 0 }}</dd>
        </div>
        <div>
          <dt>笔记冲突</dt>
          <dd>{{ status?.conflictCount ?? 0 }}</dd>
        </div>
        <div>
          <dt>过期记忆</dt>
          <dd>{{ status?.expiredNoteCount ?? 0 }}</dd>
        </div>
        <div>
          <dt>图片识别</dt>
          <dd>{{ status?.visionEnabled ? '已开启' : '仅分析文字' }}</dd>
        </div>
        <div title="自感知后台分析的累计真实用量">
          <dt>累计 Token</dt>
          <dd data-field="fileAwareness.usage" :title="usageTitle">{{ usageLabel }}</dd>
        </div>
      </dl>
      <p v-if="status?.modelError" class="warn">{{ status.modelError }}</p>
      <p v-if="status?.current" class="tiny muted">正在分析：{{ status.current.fileName }}</p>
      <p v-if="status?.lastError" class="warn">{{ status.lastError }}</p>
    </section>

    <section class="section-card">
      <div class="row spread">
        <h2 class="section-title">最近记录</h2>
        <AppButton
          v-if="records.length > 5"
          size="sm"
          variant="ghost"
          data-field="fileAwareness.recent-more"
          @click="recordsOpen = true"
        >
          查看更多
        </AppButton>
      </div>
      <div data-field="fileAwareness.recent-list">
        <FileAwarenessRecordList :records="records.slice(0, 5)" @analyze="analyzeRecord" />
      </div>
    </section>

    <section class="section-card">
      <div class="row spread">
        <div>
          <h2 class="section-title">记忆库</h2>
          <p class="section-desc">
            {{ status?.noteCount ?? notes.length }} 篇笔记 ·
            {{ status?.conflictCount ?? 0 }} 个手工修改冲突
          </p>
        </div>
        <AppButton size="sm" @click="openMemory">打开记忆库</AppButton>
      </div>
    </section>
  </section>

  <Teleport to="body">
    <div v-if="recordsOpen" class="modal-scrim" @click.self="closeRecords">
      <section
        class="records-modal glass-panel anim-pop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="awareness-records-title"
        data-field="fileAwareness.records-modal"
      >
        <header class="modal-head">
          <div>
            <h2 id="awareness-records-title" class="modal-title">最近记录</h2>
            <p class="tiny muted">共 {{ records.length }} 条</p>
          </div>
          <AppButton
            size="sm"
            variant="ghost"
            data-field="fileAwareness.records-modal-close"
            @click="closeRecords"
          >
            关闭
          </AppButton>
        </header>
        <div class="modal-body">
          <FileAwarenessRecordList :records="records" @analyze="analyzeRecord" />
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.page {
  display: grid;
  gap: var(--space-4);
  max-width: 880px;
}

.check {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.stack {
  display: grid;
  gap: var(--space-2);
}

.row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.row.wrap {
  flex-wrap: wrap;
}

.spread {
  justify-content: space-between;
}

.path {
  min-width: 0;
  overflow-wrap: anywhere;
}

.status-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: var(--space-2);
}

.status-grid div {
  border: 1px solid var(--glass-border);
  border-radius: 8px;
  padding: var(--space-3);
  background: var(--fill-1);
}

.status-grid dt {
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.status-grid dd {
  margin: var(--space-1) 0 0;
  font-weight: var(--weight-semibold);
}

.warn {
  color: var(--status-unread);
}

.reset-confirm {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--danger-border);
  border-radius: var(--radius-md);
  background: var(--danger-fill);
}

.reset-confirm p {
  margin: 0;
  color: var(--danger-text);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}

.modal-scrim {
  position: fixed;
  inset: 0;
  z-index: var(--z-popover);
  display: grid;
  place-items: center;
  padding: var(--space-5);
  background: var(--overlay-scrim);
}

.records-modal {
  width: min(760px, calc(100vw - 48px));
  max-height: min(720px, calc(100vh - 80px));
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--glass-panel);
  box-shadow: var(--shadow-3);
}

.modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
}

.modal-title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
}

.modal-head p {
  margin: var(--space-1) 0 0;
}

.modal-body {
  min-height: 0;
  overflow-y: auto;
  padding: 0 var(--space-4) var(--space-4);
}

@media (max-width: 760px) {
  .status-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
