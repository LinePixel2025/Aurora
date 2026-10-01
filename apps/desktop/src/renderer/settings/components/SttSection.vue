<script setup lang="ts">
/**
 * 语音输入（STT）区组（docs/08 §1、Betav2 规格 §9）：provider **目录行列表 + 一次只开一张编辑卡**。
 *
 * provider CRUD 与 `TtsSection.vue` 逐条同构（含 removedProviders 删除语义、
 * write-only 凭据、未落盘草稿的镜像合并），只是字段与预设换成 STT：
 * 协议可选 OpenAI 兼容的 `/audio/transcriptions` 或阿里云百炼原生接口，需要浏览器录音权限
 * （主进程 `session.setPermissionRequestHandler` 只对本窗放行 `media`）。
 *
 * 门控口径同 TTS：`stt.enabled && stt.active` 指向 baseUrl/model 齐全的 provider 时，
 * 对话窗才渲染麦克风按钮 —— 未配置时连按钮都不出现（不是 disabled）。
 */
import { computed, ref, watch } from 'vue'
import { ChevronRight } from '../../shared/icons.js'
import {
  RESOURCE_NAME_PATTERN,
  RESOURCE_NAME_RULE,
  STT_PRESETS,
  STT_PROVIDER_TYPE_LABELS,
  type SttProviderConfig,
} from '@aurora/shared/browser'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import SettingField from '../../shared/components/SettingField.vue'
import { useSettingsStore } from '../../shared/stores.js'

interface ProviderDraft extends SttProviderConfig {
  id: string
  /** 页面草稿里的明文 Key；`apiKeySet` 为 true 时留空表示「本次不改凭据」 */
  apiKey: string
  apiKeySet: boolean
}

/** 页面三态：目录列表 / 添加（选预设）/ 编辑（最多一张卡，由单值 `editingId` 决定是哪一张） */
type PageMode = 'list' | 'add' | 'edit'

/** 新建 provider 的页面默认识别语言（与 Schema 默认一致；空串 = 服务端自动检测） */
const DEFAULT_LANGUAGE = 'zh'

/** 新建 provider 的页面默认协议（与 Schema 的旧口径一致；阿里云那条由预设带过来） */
const DEFAULT_TYPE: SttProviderConfig['type'] = 'openai-compat'

/**
 * 两套协议的字段语义不同，提示词按当前协议切换（文案口径：短句、不引文档号）：
 * OpenAI 兼容那栏的 baseUrl 是**端点根**（页面拼 `/audio/transcriptions`），
 * 阿里云原生那栏是**服务根**（主进程拼 `/api/v1/services/aigc/multimodal-generation/generation`）。
 */
function baseUrlHint(draft: ProviderDraft): string {
  return draft.type === 'dashscope-native'
    ? '阿里云百炼服务根地址，如 https://dashscope.aliyuncs.com；也接受写到 /api 或完整端点'
    : 'OpenAI 兼容端点，例如 https://api.openai.com/v1'
}

function modelHint(draft: ProviderDraft): string {
  return draft.type === 'dashscope-native' ? '例：qwen3-asr-flash' : '例：whisper-1'
}

const settingsStore = useSettingsStore()

const newProviderId = ref('')
const message = ref<string | null>(null)
const error = ref<string | null>(null)

const mode = ref<PageMode>('list')
const editingId = ref<string | null>(null)
/** 删除的二次确认：待确认的 provider id（单值，同一时刻只确认一个） */
const pendingRemoveId = ref<string | null>(null)

/** 区组折叠状态（默认展开：字段与探针锚点常在 DOM 里） */
const open = ref(true)

const sttSettings = computed(() => settingsStore.settings?.stt ?? null)
const activeId = computed(() => sttSettings.value?.active ?? '')
const enabled = computed(() => sttSettings.value?.enabled ?? false)
const activeDraft = computed(
  () => drafts.value.find((draft) => draft.id === activeId.value) ?? null,
)

function isEditing(id: string): boolean {
  return mode.value === 'edit' && editingId.value === id
}

/** 当前编辑的 provider 是不是还没落盘的新建草稿 */
function isCreating(id: string): boolean {
  return localDrafts.value.some((draft) => draft.id === id)
}

/**
 * 未落盘的新建草稿（`syncDrafts` 会把已保存的镜像整体换掉，
 * 所以「刚点预设、还没点应用」的那一条不能只活在镜像里，否则它会被下一次同步抹掉）。
 * 列表 = 已保存的镜像 + 这些草稿；落盘成功后草稿被移除，那一行就来自 settings 了。
 */
const localDrafts = ref<ProviderDraft[]>([])

/** settings 的镜像；`syncDrafts` 只重写它，**不动**编辑卡正在改的那份对象引用 */
const savedDrafts = ref<ProviderDraft[]>([])

/** 列表 = 已保存的镜像 + 未落盘的新建草稿（重名不会出现：`addPreset` 先查重） */
const drafts = computed<ProviderDraft[]>(() => [...savedDrafts.value, ...localDrafts.value])

function syncDrafts(): void {
  const settings = settingsStore.settings
  if (!settings) return
  const previous = savedDrafts.value
  const editing = editingId.value
  savedDrafts.value = Object.entries(settings.stt.providers).map(([id, provider]) => {
    // 兑现上面那条注释：编辑卡正在改的那一份**按 id 复用旧对象引用** ——
    // 广播到达（或任何即时保存动作触发的 `settings:changed`）都不回退卡内内容、不关编辑器。
    // 其余行每次重建，别处改过的值照常反映到列表。
    const reused = editing === id ? previous.find((draft) => draft.id === id) : undefined
    if (reused !== undefined) return reused
    return {
      id,
      ...provider,
      apiKey: '',
      apiKeySet: Boolean((provider as unknown as { apiKeySet?: boolean }).apiKeySet),
    }
  })
  // provider 被别处删掉（如 `set_setting`）时，编辑卡 / 确认条不能指着一个不存在的行。
  // 未落盘的新建草稿不在 settings 里，所以先把它排除在判断之外。
  if (editing !== null && !isCreating(editing) && !hasSaved(editing)) closeEditor()
  if (
    pendingRemoveId.value !== null &&
    !drafts.value.some((draft) => draft.id === pendingRemoveId.value)
  ) {
    pendingRemoveId.value = null
  }
}

/** 该 id 是否已经在配置里（与「未落盘草稿」相对） */
function hasSaved(id: string): boolean {
  return savedDrafts.value.some((draft) => draft.id === id)
}

watch(
  () => settingsStore.settings,
  () => syncDrafts(),
  { immediate: true },
)

function openEditor(id: string): void {
  mode.value = 'edit'
  editingId.value = id
  pendingRemoveId.value = null
  error.value = null
}

function closeEditor(): void {
  if (editingId.value !== null && isCreating(editingId.value)) {
    // 没落盘的新建草稿：取消 = 整条丢掉，否则它会一直挂在 `drafts` 里像个幽灵行
    localDrafts.value = localDrafts.value.filter((draft) => draft.id !== editingId.value)
    syncDrafts()
  }
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

/** 添加流程：预设 chips 来自 `STT_PRESETS`，选中即进编辑卡（必填项由卡内当场校验） */
function addPreset(id: string): void {
  const preset = STT_PRESETS.find((item) => item.id === id)
  const key = newProviderId.value.trim() === '' ? id : newProviderId.value.trim()
  // provider id 会作为凭据路径的段（`stt.providers.<id>.apiKey`），`.` 是分隔符 → 禁点。
  // 正则与文案与 `McpServerSchema.name` 同源（`@aurora/shared` 单一来源），不另写一份。
  if (!RESOURCE_NAME_PATTERN.test(key)) {
    error.value = `语音输入模型「${key}」${RESOURCE_NAME_RULE}`
    return
  }
  if (drafts.value.some((draft) => draft.id === key)) {
    error.value = `语音输入模型「${key}」已存在`
    return
  }
  localDrafts.value.push({
    id: key,
    // 协议由预设带过来：阿里云那条走原生接口，其余（含「空白配置」）默认 OpenAI 兼容
    type: preset?.type ?? DEFAULT_TYPE,
    baseUrl: preset?.baseUrl ?? '',
    apiKeyEnc: '',
    model: preset?.model ?? '',
    language: preset?.language ?? DEFAULT_LANGUAGE,
    apiKey: '',
    apiKeySet: false,
  })
  newProviderId.value = ''
  error.value = null
  message.value = null
  // 必填项前移：选中预设后直接进编辑卡，由卡内必填项当场校验（「空白配置」同理）
  openEditor(key)
}

/**
 * 保存一个 STT provider。写回语义与 `TtsSection.saveProvider` 逐条一致：
 * 顶层浅合并全量回传 provider、`apiKeyEnc: ''` = 本次不改凭据、明文只走 `settings:setSecrets`
 * 且先落条目再写凭据、patch 经 `settingsStore.update()`（内部 `deepClone`）防 DataCloneError。
 */
async function saveProvider(draft: ProviderDraft): Promise<boolean> {
  const settings = settingsStore.settings
  if (!settings) return false
  // 必填项当场校验：指出是谁的哪个字段，而不是保存后由 Schema 兜底
  if (draft.baseUrl.trim() === '') {
    error.value = `请填写 ${draft.id} 的 baseURL`
    return false
  }
  if (draft.model.trim() === '') {
    error.value = `请填写 ${draft.id} 的模型名`
    return false
  }
  const ok = await settingsStore.update({
    stt: {
      // 没有任何 provider 被设为默认时，第一个保存的自动成为默认
      active: settings.stt.active === '' ? draft.id : settings.stt.active,
      providers: {
        ...settings.stt.providers,
        [draft.id]: {
          type: draft.type,
          baseUrl: draft.baseUrl.trim(),
          apiKeyEnc: '',
          model: draft.model.trim(),
          // 识别语言可空（空串 = 服务端自动检测），不需要必填校验
          language: draft.language.trim(),
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
      [`stt.providers.${draft.id}.apiKey`]: draft.apiKey.trim(),
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
  // 落盘成功：新建草稿升级成普通行
  if (isCreating(draft.id)) localDrafts.value = localDrafts.value.filter((d) => d.id !== draft.id)
  syncDrafts()
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

/** 删除入口：先亮出确认条，不直接生效 */
function requestRemove(id: string): void {
  pendingRemoveId.value = pendingRemoveId.value === id ? null : id
  message.value = null
  error.value = null
}

/**
 * 删除一个 provider：record 缺项 ≠ 删除，必须显式声明 `removedProviders: [id]`；
 * 凭据清理由主进程在删除成功之后一并做，这里不再单独 `clearSecret`。
 */
async function removeProvider(id: string): Promise<void> {
  const settings = settingsStore.settings
  if (!settings) return
  const next = { ...settings.stt.providers }
  delete next[id]
  const ok = await settingsStore.update({
    stt: {
      active: settings.stt.active === id ? '' : settings.stt.active,
      providers: next,
      removedProviders: [id],
    },
  })
  if (!ok) {
    error.value = settingsStore.error
    return
  }
  localDrafts.value = localDrafts.value.filter((draft) => draft.id !== id)
  pendingRemoveId.value = null
  if (editingId.value === id) closeEditor()
  syncDrafts()
  message.value = `已删除 ${id}`
}

/**
 * 常显区的保存：`enabled` 是 `stt` 的顶层字段，而 `settings:update` 只做**顶层浅合并**
 * （`stt` 整对象被替换），所以每次都要显式带上 `active` 与**完整**的 `providers` ——
 * 漏掉 provider 表等于把已配置的模型一次性清空。
 */
async function saveEnabled(next: boolean): Promise<void> {
  const settings = settingsStore.settings
  if (!settings) return
  const ok = await settingsStore.update({
    stt: { enabled: next, active: settings.stt.active, providers: settings.stt.providers },
  })
  if (!ok) error.value = settingsStore.error
  else {
    message.value = '已保存'
    error.value = null
  }
}

/** 设为默认：只改 `active`，provider 表原样回传 */
async function setActive(id: string): Promise<void> {
  const settings = settingsStore.settings
  if (!settings) return
  const ok = await settingsStore.update({
    stt: { active: id, providers: settings.stt.providers },
  })
  if (!ok) error.value = settingsStore.error
  else message.value = `默认语音输入模型已切换为 ${id}`
}
</script>

<template>
  <section class="group section-card">
    <button class="group-head" type="button" :aria-expanded="open" @click="open = !open">
      <ChevronRight
        class="chevron"
        :class="{ open }"
        :size="14"
        :stroke-width="1.8"
        aria-hidden="true"
      />
      <span class="section-title">语音输入（STT）</span>
      <span class="group-summary tiny muted grow">
        {{ enabled ? '已启用' : '已停用' }} ·
        {{ activeDraft ? `${activeDraft.id} · ${activeDraft.model}` : '未配置' }}
      </span>
    </button>

    <Transition name="collapse">
      <div v-if="open" class="group-body">
        <p class="section-desc">
          在对话窗按麦克风说话，录音会转写成文本；需浏览器录音权限，未配置时按钮不出现。
          识别协议可选 OpenAI 兼容或阿里云百炼原生接口。
        </p>

        <AppToast v-if="message" tone="ok">{{ message }}</AppToast>
        <AppToast v-if="error" tone="error">{{ error }}</AppToast>

        <!-- 常显区：两项都不门控（总开关就在其中，跟着它藏起来就再也开不回来） -->
        <SettingField
          data-field="stt.enabled"
          label="启用语音输入"
          hint="关闭后对话窗不再提供麦克风入口"
        >
          <label class="row tiny">
            <input
              type="checkbox"
              :checked="enabled"
              @change="saveEnabled(($event.target as HTMLInputElement).checked)"
            />
            <span>允许语音输入转文字</span>
          </label>
        </SettingField>

        <SettingField
          data-field="stt.active"
          label="默认 STT 模型"
          hint="识别时默认使用它；留空表示尚未配置"
        >
          <select
            class="input"
            :value="activeId"
            :disabled="drafts.length === 0"
            @change="setActive(($event.target as HTMLSelectElement).value)"
          >
            <option value="">（未配置）</option>
            <option v-for="draft in drafts" :key="draft.id" :value="draft.id">
              {{ draft.id }}
            </option>
          </select>
        </SettingField>
        <p v-if="drafts.length === 0" class="tiny muted">
          还没有可选的模型：先在下面「添加语音输入模型」。
        </p>

        <!-- 空状态：没有模型时不摆一排空行，直接给主入口 -->
        <p v-if="drafts.length === 0" class="empty-inline" data-empty="stt.providers">
          还没有语音输入模型：添加一个并设为默认后，对话窗才出现麦克风按钮。
        </p>
        <div v-if="drafts.length === 0" class="row">
          <AppButton variant="primary" @click="startAdd">添加语音输入模型</AppButton>
        </div>

        <!-- 工具行：新增入口（列表非空时它才需要；空列表由上面的空状态承担） -->
        <div v-if="drafts.length > 0" class="row wrap toolbar">
          <AppButton size="sm" :disabled="mode === 'add'" @click="startAdd">
            + 添加语音输入模型
          </AppButton>
          <span class="grow" />
          <span class="tiny muted">{{ drafts.length }} 个语音输入模型</span>
        </div>

        <!-- 添加流程（mode === 'add'）：预设 chips 来自 STT_PRESETS，选中即进编辑卡 -->
        <section v-if="mode === 'add'" class="form-block">
          <div class="row">
            <h3 class="block-title grow">添加语音输入模型</h3>
            <AppButton size="sm" variant="ghost" @click="closeEditor">取消</AppButton>
          </div>
          <p class="section-desc">
            选一个预设快速填好 Base URL 与模型名，或填自定义 id 后手动配置。
          </p>
          <div class="add-row">
            <input
              v-model="newProviderId"
              class="input"
              type="text"
              spellcheck="false"
              placeholder="自定义 id（可选）"
            />
            <AppButton
              v-for="preset in STT_PRESETS"
              :key="preset.id"
              size="sm"
              @click="addPreset(preset.id)"
            >
              + {{ preset.label }}
            </AppButton>
            <AppButton size="sm" variant="ghost" @click="addPreset('custom')">+ 空白配置</AppButton>
          </div>
        </section>

        <!-- provider 目录行列表：容器上标 `stt.providers`，每行标 `stt.providers.<id>` -->
        <div v-if="drafts.length > 0" class="provider-list" data-field="stt.providers">
          <article
            v-for="draft in drafts"
            :key="draft.id"
            class="provider-row"
            :class="{ accent: activeId === draft.id, editing: isEditing(draft.id) }"
            :data-field="`stt.providers.${draft.id}`"
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
                data-action="edit-stt-provider"
                @click="openEditor(draft.id)"
              >
                编辑
              </AppButton>
              <AppButton
                size="sm"
                variant="ghost"
                :disabled="activeId === draft.id"
                @click="setActive(draft.id)"
              >
                {{ activeId === draft.id ? '已是默认' : '设为默认' }}
              </AppButton>
              <AppButton
                size="sm"
                :variant="pendingRemoveId === draft.id ? 'danger' : 'ghost'"
                data-action="remove-stt-provider"
                @click="requestRemove(draft.id)"
              >
                删除
              </AppButton>
            </header>

            <!-- 危险操作二次确认：确认条就地出现，点「确认删除」才真的删 -->
            <div v-if="pendingRemoveId === draft.id" class="confirm-bar">
              <span class="tiny confirm-text">
                删除语音输入模型「{{ draft.id }}」？{{
                  draft.apiKeySet ? '它的 API Key 密文会一并清除。' : '它还没有保存凭据。'
                }}
              </span>
              <AppButton
                size="sm"
                variant="danger"
                data-action="confirm-remove-stt-provider"
                @click="removeProvider(draft.id)"
              >
                确认删除
              </AppButton>
              <AppButton
                size="sm"
                variant="ghost"
                data-action="cancel-remove-stt-provider"
                @click="pendingRemoveId = null"
              >
                取消
              </AppButton>
            </div>

            <!-- 编辑卡：一次只渲染一张（editingId 是单值） -->
            <template v-if="isEditing(draft.id) && pendingRemoveId !== draft.id">
              <p v-if="isCreating(draft.id)" class="tiny pending-note">
                这条还没有保存：点「应用」后才写入配置。
              </p>

              <!-- 协议排在第一位：它决定 baseURL 与模型名的语义（两套接口的字段含义不同） -->
              <SettingField
                :data-field="`stt.providers.${draft.id}.type`"
                label="接口协议"
                hint="决定 baseURL 与模型名怎么下发；换协议请连带检查这两项的提示"
              >
                <select v-model="draft.type" class="input">
                  <option
                    v-for="(label, value) in STT_PROVIDER_TYPE_LABELS"
                    :key="value"
                    :value="value"
                  >
                    {{ label }}
                  </option>
                </select>
              </SettingField>

              <SettingField
                :data-field="`stt.providers.${draft.id}.baseUrl`"
                label="baseURL"
                required
                :hint="baseUrlHint(draft)"
              >
                <input v-model="draft.baseUrl" class="input" type="text" spellcheck="false" />
              </SettingField>

              <SettingField
                :data-field="`stt.providers.${draft.id}.apiKey`"
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
                :data-field="`stt.providers.${draft.id}.model`"
                label="模型名"
                required
                :hint="modelHint(draft)"
              >
                <input v-model="draft.model" class="input" type="text" spellcheck="false" />
              </SettingField>

              <SettingField
                :data-field="`stt.providers.${draft.id}.language`"
                label="识别语言"
                hint="BCP-47 短码，如 zh / en；留空交给服务端自动检测"
              >
                <input
                  v-model="draft.language"
                  class="input"
                  type="text"
                  spellcheck="false"
                  placeholder="zh"
                />
              </SettingField>

              <!-- 卡片底部：只提交这一张卡 -->
              <footer class="row wrap card-actions">
                <AppButton size="sm" variant="primary" @click="applyDraft(draft)">应用</AppButton>
                <AppButton size="sm" variant="ghost" @click="closeEditor">取消</AppButton>
              </footer>
            </template>
          </article>
        </div>

        <p v-if="drafts.length > 0" class="tiny muted">
          改动需点「应用」后落盘；API Key 留空表示不修改已保存的凭据。当前默认：{{
            activeDraft ? `${activeDraft.id} · ${activeDraft.model}` : '未配置'
          }}。
        </p>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
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

.block-title {
  margin: 0;
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
}

/* provider 行列表容器：只承担 `data-field` 抓手与行间距，本身不画卡片 */
.provider-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.provider-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.provider-head .mono {
  font-size: var(--text-base);
}

/* 目录行：区组内的轻量卡（比 section-card 小一号的半径与内边距，避免卡中卡） */
.provider-row {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--fill-1);
  transition: background var(--transition-fast);
}

.provider-row:hover,
.provider-row.editing {
  background: var(--fill-2);
}

/* 默认行沿用 .accent 描边 + 左侧 3px 强调色指示条 */
.provider-row.accent {
  border-color: var(--aurora-blue);
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

/* 未落盘的新建卡提示：用告警色说明「现在还不是配置的一部分」 */
.pending-note {
  margin: 0;
  color: var(--status-unread);
}

/* 删除的二次确认条 */
.confirm-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--danger-border);
  background: var(--danger-fill);
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

.wrap {
  flex-wrap: wrap;
}
</style>
