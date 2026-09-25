<script setup lang="ts">
/**
 * 语音合成（TTS）区组（docs/06 §13、docs/08 §1/§5）：provider **目录行列表 + 一次只开一张编辑卡**。
 *
 * 由 `TtsPage.vue` 整体迁入（BetaV2 8 → 6 页，spec §9），provider CRUD 的行为与锚点
 * （`tts.*` 的 data-field / data-action）原样保留；信息架构与 `LlmPage.vue` 完全对齐：
 * 常显区（总开关 / 默认 provider / 自动朗读 / 字数上限）→ 工具行（+ 添加 TTS 模型）
 * → 行列表 → 空状态；危险操作走**就地二次确认**，凭据是 write-only 输入，页面永不回显明文。
 *
 * 为什么常显区**不跟着 `tts.enabled` 门控**：这四项里就有总开关自己 ——
 * 跟着它门控等于「一关就再也开不回来」，只能改配置文件自救。
 *
 * 为什么「连接测试」与「保存并试听」是两个按钮：
 * `tts:testConnection` 只回 `ok / latencyMs / message / bytes`，**不回音频**；
 * 试听必须走 `tts:synthesize`，而它只接受 `{ text, providerId }`（明文 key 永不进这条通道）。
 * 合成读的是**已落盘**的 provider 条目，所以「保存并试听」的顺序只能是
 * 先 `saveProvider` → 再 `synthesize`；两个动作合成一个按钮会让"测试通则播放"变成必然失败的路径。
 */
import { computed, reactive, ref, watch } from 'vue'
import {
  TTS_FORMATS,
  TTS_PRESETS,
  type TtsFormat,
  type TtsProviderConfig,
  type TtsTestResult,
} from '@aurora/shared/browser'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import SettingField from '../../shared/components/SettingField.vue'
import { useTts } from '../../shared/composables/useTts.js'
import { useSettingsStore } from '../../shared/stores.js'

interface ProviderDraft extends TtsProviderConfig {
  id: string
  /** 页面草稿里的明文 Key；`apiKeySet` 为 true 时留空表示「本次不改凭据」 */
  apiKey: string
  apiKeySet: boolean
}

/** 页面三态：目录列表 / 添加（选预设）/ 编辑（最多一张卡，由单值 `editingId` 决定是哪一张） */
type PageMode = 'list' | 'add' | 'edit'

/** 新建 provider 的页面默认值（`DEFAULT_TTS` 里没有 provider 级默认，所以在这里定义一次） */
const DEFAULT_SPEED = 1
const DEFAULT_FORMAT: TtsFormat = 'mp3'
/** 单次朗读上限的夹取范围，与 `TtsSchema.maxChars` 的 min/max 一致 */
const MIN_MAX_CHARS = 50
const MAX_MAX_CHARS = 4096

const settingsStore = useSettingsStore()
/** 播放实现只有 `useTts` 一份，本区组**不**自己 `new Audio` */
const tts = useTts()

const newProviderId = ref('')
const testing = ref<string | null>(null)
const results = reactive<Record<string, TtsTestResult>>({})
const message = ref<string | null>(null)
const error = ref<string | null>(null)

const mode = ref<PageMode>('list')
const editingId = ref<string | null>(null)
/** 删除的二次确认：待确认的 provider id（单值，同一时刻只确认一个） */
const pendingRemoveId = ref<string | null>(null)

/** 区组折叠状态（默认展开：字段与探针锚点常在 DOM 里） */
const open = ref(true)

const ttsSettings = computed(() => settingsStore.settings?.tts ?? null)
const activeId = computed(() => ttsSettings.value?.active ?? '')
const activeDraft = computed(
  () => drafts.value.find((draft) => draft.id === activeId.value) ?? null,
)
/** 总开关；settings 未加载完时按 Schema 默认（true）显示，保存时再确认配置已就绪 */
const enabled = computed(() => ttsSettings.value?.enabled ?? true)
const autoRead = computed(() => ttsSettings.value?.autoRead ?? false)
const maxChars = computed(() => ttsSettings.value?.maxChars ?? 2000)
/** 正在试听的 provider id（`useTts` 用它区分「合成中」与「播放中」） */
const previewing = computed(() =>
  tts.loading.value === 'preview' ? 'loading' : tts.speaking.value === 'preview' ? 'playing' : null,
)

function resultOf(id: string): TtsTestResult | undefined {
  return results[id]
}

function isEditing(id: string): boolean {
  return mode.value === 'edit' && editingId.value === id
}

/** 当前编辑的 provider 是不是还没落盘的新建草稿 */
function isCreating(id: string): boolean {
  return localDrafts.value.some((draft) => draft.id === id)
}

/** 编辑卡上「候选音色」chips：只有整套预设都对得上同一个 id 时才给候选（自定义 id 不猜音色） */
function voicesOf(id: string): string[] {
  return TTS_PRESETS.filter((preset) => preset.id === id).map((preset) => preset.voice)
}

/**
 * 音色输入框：`v-model` 给原生 input 挂的监听器注册在 `@input` **之后**，回调里读到的会是旧值，
 * 所以这里用 `:value` + `@input` 显式接管（与 LlmPage 的「模型名」同一个理由）。
 */
function onVoiceInput(draft: ProviderDraft, event: Event): void {
  draft.voice = (event.target as HTMLInputElement).value
}

/** 点候选音色 chip：填进「音色」输入框（音色 id 可以直接手打，chips 只是省事） */
function selectVoice(draft: ProviderDraft, voice: string): void {
  if (voice.trim() === '') return
  draft.voice = voice
  message.value = null
  error.value = null
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
  savedDrafts.value = Object.entries(settings.tts.providers).map(([id, provider]) => ({
    id,
    ...provider,
    apiKey: '',
    apiKeySet: Boolean((provider as unknown as { apiKeySet?: boolean }).apiKeySet),
  }))
  // provider 被别处删掉（如 `set_setting` 或对话窗）时，编辑卡 / 确认条不能指着一个不存在的行。
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

/** 添加流程：预设 chips 来自 `TTS_PRESETS`，选中即进编辑卡（必填项由卡内当场校验） */
function addPreset(id: string): void {
  const preset = TTS_PRESETS.find((item) => item.id === id)
  const key = newProviderId.value.trim() === '' ? id : newProviderId.value.trim()
  if (drafts.value.some((draft) => draft.id === key)) {
    error.value = `TTS 模型「${key}」已存在`
    return
  }
  localDrafts.value.push({
    id: key,
    type: 'openai-compat',
    baseUrl: preset?.baseUrl ?? '',
    apiKeyEnc: '',
    model: preset?.model ?? '',
    voice: preset?.voice ?? '',
    speed: DEFAULT_SPEED,
    format: DEFAULT_FORMAT,
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
 * 保存一个 TTS provider。
 *
 * 关键语义（踩过的坑，别退化）：
 * - `settings:update` 只有**顶层浅合并**，所以必须原样回传**全部** provider 再覆盖当前一个；
 * - patch 必须经 `settingsStore.update()`（内部 `deepClone`），直接把 `reactive`/`ref` 里的对象
 *   送出去会因 Proxy 不可结构化克隆而 `DataCloneError` 静默失败；
 * - `apiKeyEnc: ''` 留在 patch 里是**安全的**：主进程对「已有 provider + 空密文」按
 *   「本次不改凭据」处理（新建时 Schema 又要求该字段存在，所以必须带）；
 * - 明文 `apiKey` 只走 `settings:setSecrets`，永不进配置，且必须**先** update 落条目再写凭据
 *   —— 主进程给「配置里不存在的路径」写密文会直接抛错。
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
  if (draft.voice.trim() === '') {
    error.value = `请填写 ${draft.id} 的音色`
    return false
  }
  const ok = await settingsStore.update({
    tts: {
      // 没有任何 provider 被设为默认时，第一个保存的自动成为默认（否则用户得再点一次「设为默认」）
      active: settings.tts.active === '' ? draft.id : settings.tts.active,
      providers: {
        ...settings.tts.providers,
        [draft.id]: {
          type: 'openai-compat',
          baseUrl: draft.baseUrl.trim(),
          apiKeyEnc: '',
          model: draft.model.trim(),
          voice: draft.voice.trim(),
          // 越界值夹回 Schema 的 0.25 ～ 4，免得一次手滑输入让整次保存被 Zod 打回
          speed: clampSpeed(draft.speed),
          format: draft.format,
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
      [`tts.providers.${draft.id}.apiKey`]: draft.apiKey.trim(),
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
  // 落盘成功：新建草稿升级成普通行（编辑卡保持打开，方便接着试听）
  if (isCreating(draft.id)) localDrafts.value = localDrafts.value.filter((d) => d.id !== draft.id)
  syncDrafts()
  return true
}

/** `speed` 夹到 0.25 ～ 4（Schema 的同名约束）；非有限数回落 1 */
function clampSpeed(value: number): number {
  const speed = Number(value)
  if (!Number.isFinite(speed)) return DEFAULT_SPEED
  return Math.min(4, Math.max(0.25, speed))
}

/** 「应用」：只提交这一张卡；成功后回到列表态 */
async function applyDraft(draft: ProviderDraft): Promise<void> {
  message.value = null
  error.value = null
  if (!(await saveProvider(draft))) return
  message.value = `已保存 ${draft.id}`
  closeEditor()
}

/**
 * 「连接测试」：保存当前卡片后调 `tts:testConnection`，**只回文字结果**。
 * 明文 `apiKey` 随请求一起发（主进程优先用页面草稿里的那份），回包不含音频。
 */
async function testProvider(draft: ProviderDraft): Promise<void> {
  // `saveProvider` 成功后会把 `draft.apiKey` 清空（明文已经进安全存储了），
  // 所以要在保存**之前**把它取出来，否则这次测试只能用已保存的旧凭据。
  const inlineApiKey = draft.apiKey
  testing.value = draft.id
  error.value = null
  if (!(await saveProvider(draft))) {
    testing.value = null
    return
  }
  const result = await window.aurora.tts.testConnection({
    providerId: draft.id,
    baseUrl: draft.baseUrl.trim(),
    apiKey: inlineApiKey,
    model: draft.model.trim(),
    voice: draft.voice.trim(),
    speed: clampSpeed(draft.speed),
    format: draft.format,
  })
  testing.value = null
  if (result.ok) results[draft.id] = result.value
  else error.value = result.message
}

/**
 * 「保存并试听」：**先保存卡片、再** `synthesize`。
 *
 * `tts:synthesize` 只接受 `{ text, providerId }`（合成参数与凭据全部由主进程从已落盘的
 * provider 读），所以「没保存就试听」会合成出一个和卡片上不一样的声音 —— 顺序不能反。
 */
async function previewDraft(draft: ProviderDraft): Promise<void> {
  message.value = null
  error.value = null
  if (!(await saveProvider(draft))) return
  await tts.speak('你好，我是 Aurora。', 'preview')
  if (tts.error.value !== null) error.value = tts.error.value
}

/** 删除入口：先亮出确认条，不直接生效 */
function requestRemove(id: string): void {
  pendingRemoveId.value = pendingRemoveId.value === id ? null : id
  message.value = null
  error.value = null
}

/**
 * 删除一个 provider。
 *
 * 关键语义（别退化）：
 * - `tts.providers` 是 record，**缺项 ≠ 删除**：只在 `providers` 里少一项主进程不会删掉它
 *   （缺项是合法的局部更新形状）。删除必须显式声明 `removedProviders: [id]`。
 * - 凭据清理由主进程在删除**成功之后**一并做（清密文 + 内存明文缓存），这里不再单独
 *   `clearSecret` —— 删除失败时清凭据会把「provider 还在、密文没了」这个缺陷换个方向复现。
 */
async function removeProvider(id: string): Promise<void> {
  const settings = settingsStore.settings
  if (!settings) return
  const next = { ...settings.tts.providers }
  delete next[id]
  const ok = await settingsStore.update({
    tts: {
      active: settings.tts.active === id ? '' : settings.tts.active,
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
 * 常显区的保存：`enabled` / `autoRead` / `maxChars` 都是 `tts` 的顶层字段，
 * 而 `settings:update` 只有**顶层浅合并**（`tts` 整对象被替换），所以每次都要显式带上
 * `active` 与**完整**的 `providers` —— 漏掉 provider 表等于把已配置的模型一次性清空。
 *
 * `removedProviders` 是**删除指令**不是字段，这里不涉及删除，所以一个都不写。
 */
async function saveTts(patch: {
  enabled?: boolean
  autoRead?: boolean
  maxChars?: number
}): Promise<void> {
  const settings = settingsStore.settings
  if (!settings) return
  const ok = await settingsStore.update({
    tts: { ...patch, active: settings.tts.active, providers: settings.tts.providers },
  })
  if (!ok) error.value = settingsStore.error
  else {
    message.value = '已保存'
    error.value = null
  }
}

/** `maxChars` 输入解析：非数字回落原值，越界夹到 50 ～ 4096（主进程还会再校验一次） */
async function saveMaxChars(event: Event): Promise<void> {
  const raw = Number((event.target as HTMLInputElement).value)
  const next = Number.isFinite(raw)
    ? Math.min(MAX_MAX_CHARS, Math.max(MIN_MAX_CHARS, Math.round(raw)))
    : maxChars.value
  await saveTts({ maxChars: next })
}

/** 设为默认：只改 `active`，provider 表原样回传 */
async function setActive(id: string): Promise<void> {
  const settings = settingsStore.settings
  if (!settings) return
  const ok = await settingsStore.update({
    tts: { active: id, providers: settings.tts.providers },
  })
  if (!ok) error.value = settingsStore.error
  else message.value = `默认 TTS 模型已切换为 ${id}`
}

/** 停止试听（`useTts` 是唯一播放实现，这里只转发） */
function stopPreview(): void {
  tts.stop()
}
</script>

<template>
  <section class="group section-card">
    <button class="group-head" type="button" :aria-expanded="open" @click="open = !open">
      <span class="chevron" :class="{ open }" aria-hidden="true">▸</span>
      <span class="section-title">语音合成（TTS）</span>
      <span class="group-summary tiny muted grow">
        {{ activeDraft ? `${activeDraft.id} · ${activeDraft.model}` : '未配置' }}
      </span>
    </button>

    <Transition name="collapse">
      <div v-if="open" class="group-body">
        <p class="section-desc">
          让 Aurora 朗读回复。总开关决定对话窗里是否出现朗读按钮；关掉后已保存的模型不会被删除，
          随时可以再打开。
        </p>

        <AppToast v-if="message" tone="ok">{{ message }}</AppToast>
        <AppToast v-if="error" tone="error">{{ error }}</AppToast>

        <!-- 常显区：四项**都不门控**（总开关就在其中，跟着它藏起来就再也开不回来） -->
        <SettingField
          data-field="tts.enabled"
          label="启用语音朗读"
          hint="关闭后对话窗不再提供朗读入口（已保存的 TTS 模型保留）"
        >
          <label class="row tiny">
            <input
              type="checkbox"
              :checked="enabled"
              @change="saveTts({ enabled: ($event.target as HTMLInputElement).checked })"
            />
            <span>允许 Aurora 朗读回复</span>
          </label>
        </SettingField>

        <SettingField
          data-field="tts.active"
          label="默认 TTS 模型"
          hint="朗读时默认使用它；留空表示尚未配置"
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
          还没有可选的模型：先在下面「添加 TTS 模型」。
        </p>

        <SettingField
          data-field="tts.autoRead"
          label="自动朗读新回复"
          hint="回复结束后自动合成并播放；长回复按下面的上限截断"
        >
          <label class="row tiny">
            <input
              type="checkbox"
              :checked="autoRead"
              @change="saveTts({ autoRead: ($event.target as HTMLInputElement).checked })"
            />
            <span>新回复自动朗读</span>
          </label>
        </SettingField>

        <SettingField
          data-field="tts.maxChars"
          label="单次朗读文本上限"
          hint="按字符截断，50 ～ 4096；超出部分不合成，避免一次朗读消耗过多额度"
        >
          <input
            class="input"
            type="number"
            min="50"
            max="4096"
            step="50"
            :value="maxChars"
            @change="saveMaxChars($event)"
          />
        </SettingField>

        <!-- 空状态：没有 TTS 模型时不摆一排空行，直接给主入口 -->
        <p v-if="drafts.length === 0" class="empty-inline" data-empty="tts.providers">
          还没有 TTS 模型：添加一个 OpenAI 兼容的语音合成服务并设为默认后，就能朗读回复。
        </p>
        <div v-if="drafts.length === 0" class="row">
          <AppButton variant="primary" @click="startAdd">添加 TTS 模型</AppButton>
        </div>

        <!-- 工具行：新增入口（列表非空时它才需要；空列表由上面的空状态承担） -->
        <div v-if="drafts.length > 0" class="row wrap toolbar">
          <AppButton size="sm" :disabled="mode === 'add'" @click="startAdd">
            + 添加 TTS 模型
          </AppButton>
          <span class="grow" />
          <span class="tiny muted">{{ drafts.length }} 个 TTS 模型</span>
        </div>

        <!-- 添加流程（mode === 'add'）：预设 chips 来自 TTS_PRESETS，选中即进编辑卡 -->
        <section v-if="mode === 'add'" class="form-block">
          <div class="row">
            <h3 class="block-title grow">添加 TTS 模型</h3>
            <AppButton size="sm" variant="ghost" @click="closeEditor">取消</AppButton>
          </div>
          <p class="section-desc">
            选一个预设快速填好 Base URL、模型名与音色，或填自定义 id 后手动配置。
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
              v-for="preset in TTS_PRESETS"
              :key="preset.id"
              size="sm"
              @click="addPreset(preset.id)"
            >
              + {{ preset.label }}
            </AppButton>
            <AppButton size="sm" variant="ghost" @click="addPreset('custom')">+ 空白配置</AppButton>
          </div>
        </section>

        <!-- provider 目录行列表：容器上标 `tts.providers`，每行标 `tts.providers.<id>` -->
        <div v-if="drafts.length > 0" class="provider-list" data-field="tts.providers">
          <article
            v-for="draft in drafts"
            :key="draft.id"
            class="provider-row"
            :class="{ accent: activeId === draft.id, editing: isEditing(draft.id) }"
            :data-field="`tts.providers.${draft.id}`"
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
                data-action="edit-tts-provider"
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
                data-action="remove-tts-provider"
                @click="requestRemove(draft.id)"
              >
                删除
              </AppButton>
            </header>

            <!-- 危险操作二次确认：确认条就地出现，点「确认删除」才真的删 -->
            <div v-if="pendingRemoveId === draft.id" class="confirm-bar">
              <span class="tiny confirm-text">
                删除 TTS 模型「{{ draft.id }}」？{{
                  draft.apiKeySet ? '它的 API Key 密文会一并清除。' : '它还没有保存凭据。'
                }}
              </span>
              <AppButton
                size="sm"
                variant="danger"
                data-action="confirm-remove-tts-provider"
                @click="removeProvider(draft.id)"
              >
                确认删除
              </AppButton>
              <AppButton
                size="sm"
                variant="ghost"
                data-action="cancel-remove-tts-provider"
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
                :data-field="`tts.providers.${draft.id}.baseUrl`"
                label="baseURL"
                required
                hint="OpenAI 兼容端点，例如 https://api.openai.com/v1"
              >
                <input v-model="draft.baseUrl" class="input" type="text" spellcheck="false" />
              </SettingField>

              <SettingField
                :data-field="`tts.providers.${draft.id}.apiKey`"
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
                :data-field="`tts.providers.${draft.id}.model`"
                label="模型名"
                required
                hint="例：tts-1；SiliconFlow 例：FunAudioLLM/CosyVoice2-0.5B"
              >
                <input v-model="draft.model" class="input" type="text" spellcheck="false" />
              </SettingField>

              <SettingField
                :data-field="`tts.providers.${draft.id}.voice`"
                label="音色"
                required
                hint="服务端定义的音色 id，例：alloy / alex；可直接填写"
              >
                <!-- 刻意不用 `v-model`：与音色 chips 共用同一个写入口（见 onVoiceInput） -->
                <input
                  :value="draft.voice"
                  class="input"
                  type="text"
                  spellcheck="false"
                  @input="onVoiceInput(draft, $event)"
                />
              </SettingField>

              <!-- 候选音色 chips：只有整套预设都对得上同一个 id 时才给，自定义 id 不猜 -->
              <div v-if="voicesOf(draft.id).length > 0" class="voices">
                <button
                  v-for="voice in voicesOf(draft.id)"
                  :key="voice"
                  type="button"
                  class="model-chip interactive"
                  @click="selectVoice(draft, voice)"
                >
                  {{ voice }}
                </button>
              </div>

              <SettingField
                :data-field="`tts.providers.${draft.id}.speed`"
                label="语速"
                hint="0.25 ～ 4，默认 1；越小越慢"
              >
                <input
                  v-model.number="draft.speed"
                  class="input"
                  type="number"
                  min="0.25"
                  max="4"
                  step="0.05"
                />
              </SettingField>

              <SettingField
                :data-field="`tts.providers.${draft.id}.format`"
                label="输出格式"
                hint="请求体的 response_format；决定播放时的 MIME 类型"
              >
                <select v-model="draft.format" class="input">
                  <option v-for="format in TTS_FORMATS" :key="format" :value="format">
                    {{ format }}
                  </option>
                </select>
              </SettingField>

              <!-- 「连接测试」与「保存并试听」是两个独立按钮：前者只回文字，后者才出声音 -->
              <div class="row wrap">
                <AppButton size="sm" :disabled="testing !== null" @click="testProvider(draft)">
                  {{ testing === draft.id ? '测试中…' : '连接测试' }}
                </AppButton>
                <AppButton size="sm" :disabled="testing !== null" @click="previewDraft(draft)">
                  {{
                    previewing === 'loading'
                      ? '合成中…'
                      : previewing === 'playing'
                        ? '重新试听'
                        : '保存并试听'
                  }}
                </AppButton>
                <AppButton
                  v-if="previewing === 'playing'"
                  size="sm"
                  variant="ghost"
                  @click="stopPreview"
                >
                  停止
                </AppButton>
                <AppToast v-if="resultOf(draft.id)" :tone="resultOf(draft.id)?.ok ? 'ok' : 'error'">
                  {{ resultOf(draft.id)?.message }}（{{ resultOf(draft.id)?.latencyMs }}ms{{
                    resultOf(draft.id)?.bytes !== undefined
                      ? ` · ${resultOf(draft.id)?.bytes} 字节`
                      : ''
                  }}）
                </AppToast>
              </div>

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
        </div>

        <p v-if="drafts.length > 0" class="tiny muted">
          改动在点「应用」（保存这一张卡）后落盘；编辑卡里的 API Key
          留空表示不修改已保存的凭据，试听会使用已保存的模型配置。
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

.voices {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

/* 音色候选 chip：与 LlmPage 的模型 chip 同一套观感 */
.model-chip {
  padding: var(--space-1) var(--space-3);
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
