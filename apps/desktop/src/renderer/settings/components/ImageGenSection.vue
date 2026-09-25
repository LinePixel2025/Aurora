<script setup lang="ts">
/**
 * 生图模型区组（docs/08 §1、Betav2 规格 §9）：provider **目录行列表 + 一次只开一张编辑卡**。
 *
 * 与 `LlmPage.vue` / `TtsSection.vue` 的 provider CRUD 完全同一套写法（那两处是模板）：
 * 页头摘要（启用状态 · 当前默认 provider）→ 常显区（总开关 / 默认 provider，**不门控**——
 * 总开关跟着自己藏起来就再也开不回来）→ 工具行（+ 添加生图模型）→ 行列表 → 空状态；
 * 危险操作走**就地二次确认**，凭据是 write-only 输入，页面永不回显明文。
 *
 * 写回语义（踩过的坑，别退化）：
 * - `settings:update` 只有**顶层浅合并**，`providers` 里已有的条目原样回传再覆盖当前一个；
 * - `apiKeyEnc: ''` 留在 patch 里是**安全的**：主进程对「已有 provider + 空密文」按
 *   「本次不改凭据」处理（新建时 Schema 要求该字段存在，所以必须带）；
 * - 明文 `apiKey` 只走 `settings:setSecrets`（`stt.providers.<id>.apiKey` 同款路径），
 *   且必须**先** update 落条目再写凭据 —— 主进程给「配置里不存在的路径」写密文会直接抛错；
 * - 删除必须显式声明 `removedProviders: [id]`（record 缺项 ≠ 删除）。
 */
import { computed, ref, watch } from 'vue'
import { ChevronRight } from '../../shared/icons.js'
import {
  IMAGEGEN_PRESETS,
  IMAGEGEN_SIZES,
  type ImageGenProviderConfig,
} from '@aurora/shared/browser'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import SettingField from '../../shared/components/SettingField.vue'
import { useSettingsStore } from '../../shared/stores.js'

interface ProviderDraft extends ImageGenProviderConfig {
  id: string
  /** 页面草稿里的明文 Key；`apiKeySet` 为 true 时留空表示「本次不改凭据」 */
  apiKey: string
  apiKeySet: boolean
}

/** 页面三态：目录列表 / 添加（选预设）/ 编辑（最多一张卡，由单值 `editingId` 决定是哪一张） */
type PageMode = 'list' | 'add' | 'edit'

/** 新建 provider 的页面默认尺寸（与 Schema 默认一致；空白配置也用它） */
const DEFAULT_SIZE = '1024x1024'

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

const imagegen = computed(() => settingsStore.settings?.imagegen ?? null)
const activeId = computed(() => imagegen.value?.active ?? '')
const enabled = computed(() => imagegen.value?.enabled ?? false)
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
  savedDrafts.value = Object.entries(settings.imagegen.providers).map(([id, provider]) => ({
    id,
    ...provider,
    apiKey: '',
    apiKeySet: Boolean((provider as unknown as { apiKeySet?: boolean }).apiKeySet),
  }))
  // provider 被别处删掉（如 `set_setting`）时，编辑卡 / 确认条不能指着一个不存在的行。
  // 未落盘的新建草稿不在 settings 里，所以先把它排除在判断之外。
  const editing = editingId.value
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

/** 添加流程：预设 chips 来自 `IMAGEGEN_PRESETS`，选中即进编辑卡（必填项由卡内当场校验） */
function addPreset(id: string): void {
  const preset = IMAGEGEN_PRESETS.find((item) => item.id === id)
  const key = newProviderId.value.trim() === '' ? id : newProviderId.value.trim()
  if (drafts.value.some((draft) => draft.id === key)) {
    error.value = `生图模型「${key}」已存在`
    return
  }
  localDrafts.value.push({
    id: key,
    type: 'openai-compat',
    baseUrl: preset?.baseUrl ?? '',
    apiKeyEnc: '',
    model: preset?.model ?? '',
    size: preset?.size ?? DEFAULT_SIZE,
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
 * 保存一个生图 provider。写回语义与 `TtsSection.saveProvider` 逐条一致（见文件头注释）。
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
    imagegen: {
      // 没有任何 provider 被设为默认时，第一个保存的自动成为默认
      active: settings.imagegen.active === '' ? draft.id : settings.imagegen.active,
      providers: {
        ...settings.imagegen.providers,
        [draft.id]: {
          type: 'openai-compat',
          baseUrl: draft.baseUrl.trim(),
          apiKeyEnc: '',
          model: draft.model.trim(),
          size: draft.size,
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
      [`imagegen.providers.${draft.id}.apiKey`]: draft.apiKey.trim(),
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
  const next = { ...settings.imagegen.providers }
  delete next[id]
  const ok = await settingsStore.update({
    imagegen: {
      active: settings.imagegen.active === id ? '' : settings.imagegen.active,
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
 * 常显区的保存：`enabled` 是 `imagegen` 的顶层字段，而 `settings:update` 只做**顶层浅合并**
 * （`imagegen` 整对象被替换），所以每次都要显式带上 `active` 与**完整**的 `providers` ——
 * 漏掉 provider 表等于把已配置的模型一次性清空。`removedProviders` 是删除指令，这里不写。
 */
async function saveEnabled(next: boolean): Promise<void> {
  const settings = settingsStore.settings
  if (!settings) return
  const ok = await settingsStore.update({
    imagegen: {
      enabled: next,
      active: settings.imagegen.active,
      providers: settings.imagegen.providers,
    },
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
    imagegen: { active: id, providers: settings.imagegen.providers },
  })
  if (!ok) error.value = settingsStore.error
  else message.value = `默认生图模型已切换为 ${id}`
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
      <span class="section-title">生图模型</span>
      <span class="group-summary tiny muted grow">
        {{ enabled ? '已启用' : '已停用' }} ·
        {{ drafts.length === 0 ? '未配置' : `${drafts.length} 个模型` }}
      </span>
    </button>

    <Transition name="collapse">
      <div v-if="open" class="group-body">
        <p class="section-desc">
          让 Agent 能用 <code class="mono">generate_image</code>
          工具生成图片（花 API 费用，执行前需要确认）。支持任何 OpenAI 兼容的
          <code class="mono">/images/generations</code> 服务；凭据加密保存在本机。
        </p>

        <AppToast v-if="message" tone="ok">{{ message }}</AppToast>
        <AppToast v-if="error" tone="error">{{ error }}</AppToast>

        <!-- 常显区：两项都不门控（总开关就在其中，跟着它藏起来就再也开不回来） -->
        <SettingField
          data-field="imagegen.enabled"
          label="启用图像生成"
          hint="关闭后 Agent 的 generate_image 工具不再注册（已保存的模型保留）"
        >
          <label class="row tiny">
            <input
              type="checkbox"
              :checked="enabled"
              @change="saveEnabled(($event.target as HTMLInputElement).checked)"
            />
            <span>允许 Agent 生成图片</span>
          </label>
        </SettingField>

        <SettingField
          data-field="imagegen.active"
          label="默认生图模型"
          hint="生成时默认使用它；留空表示尚未配置"
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
          还没有可选的模型：先在下面「添加生图模型」。
        </p>

        <!-- 空状态：没有模型时不摆一排空行，直接给主入口 -->
        <p v-if="drafts.length === 0" class="empty-inline" data-empty="imagegen.providers">
          还没有生图模型：添加一个 OpenAI 兼容服务并设为默认后，Agent 才能生成图片。
        </p>

        <!-- 工具行 + 添加流程（mode === 'add'）：预设 chips 来自 IMAGEGEN_PRESETS -->
        <div v-if="drafts.length > 0 || mode === 'add'" class="row wrap toolbar">
          <AppButton size="sm" :disabled="mode === 'add'" @click="startAdd">
            + 添加生图模型
          </AppButton>
          <span class="grow" />
          <span v-if="drafts.length > 0" class="tiny muted">{{ drafts.length }} 个生图模型</span>
        </div>

        <section v-if="mode === 'add'" class="form-block">
          <div class="row">
            <h3 class="block-title grow">添加生图模型</h3>
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
              v-for="preset in IMAGEGEN_PRESETS"
              :key="preset.id"
              size="sm"
              @click="addPreset(preset.id)"
            >
              + {{ preset.label }}
            </AppButton>
            <AppButton size="sm" variant="ghost" @click="addPreset('custom')">+ 空白配置</AppButton>
          </div>
        </section>

        <!-- provider 目录行列表：容器上标 `imagegen.providers`，每行标 `imagegen.providers.<id>` -->
        <div v-if="drafts.length > 0" class="provider-list" data-field="imagegen.providers">
          <article
            v-for="draft in drafts"
            :key="draft.id"
            class="provider-row"
            :class="{ accent: activeId === draft.id, editing: isEditing(draft.id) }"
            :data-field="`imagegen.providers.${draft.id}`"
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
                data-action="edit-imagegen-provider"
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
                data-action="remove-imagegen-provider"
                @click="requestRemove(draft.id)"
              >
                删除
              </AppButton>
            </header>

            <!-- 危险操作二次确认：确认条就地出现，点「确认删除」才真的删 -->
            <div v-if="pendingRemoveId === draft.id" class="confirm-bar">
              <span class="tiny confirm-text">
                删除生图模型「{{ draft.id }}」？{{
                  draft.apiKeySet ? '它的 API Key 密文会一并清除。' : '它还没有保存凭据。'
                }}
              </span>
              <AppButton
                size="sm"
                variant="danger"
                data-action="confirm-remove-imagegen-provider"
                @click="removeProvider(draft.id)"
              >
                确认删除
              </AppButton>
              <AppButton
                size="sm"
                variant="ghost"
                data-action="cancel-remove-imagegen-provider"
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

              <SettingField
                :data-field="`imagegen.providers.${draft.id}.baseUrl`"
                label="baseURL"
                required
                hint="OpenAI 兼容端点，例如 https://api.openai.com/v1"
              >
                <input v-model="draft.baseUrl" class="input" type="text" spellcheck="false" />
              </SettingField>

              <SettingField
                :data-field="`imagegen.providers.${draft.id}.apiKey`"
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
                :data-field="`imagegen.providers.${draft.id}.model`"
                label="模型名"
                required
                hint="例：dall-e-3"
              >
                <input v-model="draft.model" class="input" type="text" spellcheck="false" />
              </SettingField>

              <SettingField
                :data-field="`imagegen.providers.${draft.id}.size`"
                label="生成尺寸"
                hint="请求体的 size 参数；auto 表示由服务端决定"
              >
                <select v-model="draft.size" class="input">
                  <option v-for="size in IMAGEGEN_SIZES" :key="size" :value="size">
                    {{ size }}
                  </option>
                </select>
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
          改动在点「应用」（保存这一张卡）后落盘；编辑卡里的 API Key
          留空表示不修改已保存的凭据。当前默认：{{
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
