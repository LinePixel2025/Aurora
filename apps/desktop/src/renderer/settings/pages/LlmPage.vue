<script setup lang="ts">
/**
 * AI 模型设置页（docs/08 §5）：provider **目录行列表 + 一次只开一张编辑卡**。
 *
 * 信息架构（step-04）：页头摘要（当前默认 provider · 模型）→ 工具行（添加 Provider / 保存全部）
 * → provider 行列表（名称 + 凭据状态 + 是否默认 + 编辑 / 设为默认 / 删除）→ 空状态。
 * 危险操作走**就地二次确认**；凭据是 write-only 输入，页面永不回显明文（只显示「已保存 / 缺失」）。
 *
 * 编辑卡（`mode === 'edit' && editingId === id`，一次只渲染一张）从上到下是：
 * 必填区（baseURL / API Key / 模型名）→ **「模型设置」区**（候选模型列表：拉取 / 手动添加 /
 * 重命名 / 删除 / 点选「当前使用」/ **行内「参数」开关**）→ `.more`「高级参数与连接测试」折叠区
 * （**只剩**接口类型 + 连接测试 / 拉取按钮 + 模型 chips）→ 卡片底部「应用 / 取消」。
 *
 * **生成参数按模型走**（v23，docs/08 §1）：`llm.providers.<id>.modelParams.<模型 id>` 里的
 * 思考等级 / 上下文窗口 / 支持图片输入三项，编辑入口在每一行模型右上角的「参数」开关里；
 * 锚点是 `llm.providers.<id>.modelList.<index>.<字段>`，写入口只有 `patchParams` 一个
 * （它整份替换该键的对象 —— 只写一项会把另外两项静默重置成默认值）。
 * 「上下文窗口」是**可选信息**：非法输入一律归一化（见 `clampContextWindow`），**不阻断保存**
 * —— 缺了它对话窗只是不画占比进度条；当前使用的那一行还会在行内以小字展示一次窗口值
 * （0 = 未知，不渲染）。
 *
 * 「当前使用」与「候选列表」的关系（唯一生效值只有 `model`，列表 `modelList` 只是候选项）：
 * 在「模型名」里填的 id 会自动补进列表；删掉当前使用的那一项**不换模型**，只提示
 * 「当前模型已不在列表中」，改用哪个由用户自己点选 —— 见各 handler 的注释。
 *
 * 行上只有「名称 + 凭据状态 + 是否默认 + 编辑 / 设为默认 / 删除」四个动作，没有多余的折叠箭头：
 * 展开高级参数是**卡内**那颗 `.more` 的职责（capture 的 `SETTINGS_LLM_EFFORT_ACT` 会先点开卡再点它）。
 *
 * BetaV2 增量（spec §9）：页头下方新增「对话展示」小节（`general.chat.showThinking`）；
 * 页面底部新增「生图模型」区组（`ImageGenSection`，`imagegen.*`，独立 provider 体系）。
 */
import { computed, reactive, ref, watch } from 'vue'
import { formatTokenCount } from '@aurora/shared/browser'
import { ChevronRight } from '@aurora/shared/browser'
import {
  DEFAULT_REASONING_EFFORT,
  LLM_PROVIDER_TYPE_LABELS,
  LlmProviderTypes,
  PROVIDER_PRESETS,
  REASONING_EFFORT_LABELS,
  REASONING_EFFORT_LEVELS,
  RESOURCE_NAME_PATTERN,
  RESOURCE_NAME_RULE,
  isCenterOfficialProviderId,
  resolveModelParams,
  type LlmModelParams,
  type LlmProviderConfig,
  type ReasoningEffort,
  type TestConnectionResult,
} from '@aurora/shared/browser'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import SettingField from '../../shared/components/SettingField.vue'
import ImageGenSection from '../components/ImageGenSection.vue'
import { useSettingsStore } from '../../shared/stores.js'

interface ProviderDraft extends LlmProviderConfig {
  id: string
  apiKey: string
  apiKeySet: boolean
}

/** 页面三态：目录列表 / 添加（选预设）/ 编辑（最多一张卡，由单值 `editingId` 决定是哪一张） */
type PageMode = 'list' | 'add' | 'edit'

/**
 * 「接口类型」下拉的选项：取值来自 Schema 的枚举（**唯一来源**），文案来自同一份
 * `LLM_PROVIDER_TYPE_LABELS` —— 新增协议时这里不用改，界面也不会漏项。
 */
const PROVIDER_TYPE_OPTIONS = LlmProviderTypes.map((value) => ({
  value,
  label: LLM_PROVIDER_TYPE_LABELS[value],
}))

const settingsStore = useSettingsStore()

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
/**
 * 模型行内参数块的展开态：「<providerId>:<index>」→ 是否展开（默认收起）。
 * 与 `advancedOpen` / `renamingModel` 同一套「按 key 记」的写法；它只是行内的一块内容，
 * **不涉及浮层互斥**，所以允许多行同时展开（一次只开一张卡那条约束只针对 provider 编辑卡）。
 */
const paramsOpen = reactive<Record<string, boolean>>({})
/** 候选模型的行内重命名编辑态：「<providerId>:<index>」，同一时刻只允许一行在编辑 */
const renamingModel = ref<string | null>(null)
/** 行内重命名的输入值（与上面那条一一对应，所以共用一个 ref 就够） */
const renameValue = ref('')

const activeId = computed(() => settingsStore.settings?.llm.active ?? '')
const activeDraft = computed(
  () => drafts.value.find((draft) => draft.id === activeId.value) ?? null,
)

/**
 * 未落盘的新建草稿（`syncDrafts` 会把已保存的镜像整体换掉，
 * 所以「刚点预设、还没点应用」的那一条不能只活在镜像里，否则它会被下一次同步抹掉）。
 * 列表 = 已保存的镜像 + 这些草稿；落盘成功后草稿被移除，那一行就来自 settings 了。
 *
 * 与 `TtsSection.vue` / `SttSection.vue` / `ImageGenSection.vue` **同款结构**（P2-23）：
 * 之前只把草稿 push 进单一 `drafts` 数组，任一 `settings:changed` 广播都会连带把
 * 填了一半的 baseUrl / Key 整条丢掉、编辑器被强制关闭。
 */
const localDrafts = ref<ProviderDraft[]>([])

/** settings 的镜像；`syncDrafts` 只重写它，**不动**编辑卡正在改的那份对象引用 */
const savedDrafts = ref<ProviderDraft[]>([])

/** 列表 = 已保存的镜像 + 未落盘的新建草稿（重名不会出现：`addPreset` 先查重） */
const drafts = computed<ProviderDraft[]>(() => [...savedDrafts.value, ...localDrafts.value])

/** 该 id 是否已经在配置里（与「未落盘草稿」相对） */
function hasSaved(id: string): boolean {
  return savedDrafts.value.some((draft) => draft.id === id)
}

/** 当前编辑的 provider 是不是还没落盘的新建草稿 */
function isCreating(id: string): boolean {
  return localDrafts.value.some((draft) => draft.id === id)
}

/**
 * 「显示思考过程」（`general.chat.showThinking`，v8 新增）：对话窗思考折叠块的门控。
 * 保存走 `general` 分组的局部更新 —— 主进程 `applyPatch` 对分组做 Object.assign，
 * 只带 `chat` 子对象不会丢 `general` 的其它字段（launchAtLogin 等原样保留）。
 */
const showThinking = computed(() => settingsStore.settings?.general.chat.showThinking ?? true)

async function setShowThinking(next: boolean): Promise<void> {
  const settings = settingsStore.settings
  if (!settings) return
  const ok = await settingsStore.update({
    general: { chat: { ...settings.general.chat, showThinking: next } },
  })
  if (!ok) error.value = settingsStore.error
  else {
    message.value = '已保存'
    error.value = null
  }
}

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

/** 某一行模型参数块是否展开（按 `${draft.id}:${index}` 记）。 */
function paramsExpanded(draftId: string, index: number): boolean {
  return paramsOpen[`${draftId}:${index}`] === true
}

function toggleParams(draftId: string, index: number): void {
  const key = `${draftId}:${index}`
  paramsOpen[key] = paramsOpen[key] !== true
}

/**
 * 去重合并两组模型 id（「模型设置」区）：现有项保持原顺序在前、新 id 追加在后，
 * 首尾空白与空串一律丢掉。
 *
 * `syncDrafts` / `loadModels` / 落盘的 patch 都走这一个函数，「列表长什么样」只有一处定义。
 */
function mergeModelIds(current: readonly string[], incoming: readonly string[]): string[] {
  const merged: string[] = []
  for (const raw of [...current, ...incoming]) {
    const id = raw.trim()
    if (id !== '' && !merged.includes(id)) merged.push(id)
  }
  return merged
}

/** 当前使用的模型 id：比对一律用去掉首尾空白的值，免得一个空格让两边看起来不一致。 */
function currentModel(draft: ProviderDraft): string {
  return draft.model.trim()
}

/**
 * `model` 是**唯一生效值**，候选列表只是候选项：用户在「模型名」里填的 id 若不在列表里就自动追加，
 * 两者始终一致，而且用户看得见发生了什么（列表里当场多一行）。
 */
function adoptCurrentModel(draft: ProviderDraft): void {
  const model = currentModel(draft)
  if (model === '') return
  if (!draft.modelList.includes(model)) draft.modelList.push(model)
}

/** 某一行是不是「当前使用」的那一个。 */
function isCurrent(draft: ProviderDraft, id: string): boolean {
  return id !== '' && id === currentModel(draft)
}

/** 当前使用的模型不在候选列表里（删掉当前项之后就是这个状态）：只提示，不换模型。 */
function modelNotInList(draft: ProviderDraft): boolean {
  const model = currentModel(draft)
  return model !== '' && !draft.modelList.includes(model)
}

/**
 * 「模型名」输入框：写回 `draft.model` 与「自动补进候选列表」必须在同一个事件里按顺序发生，
 * 所以这里用 `:value` + `@input` 显式接管。不用 `v-model` 的原因是它给原生 input 挂的监听器
 * 注册在 `@input` **之后**，回调里读到的会是上一个值（补进列表的就会是旧 id）。
 */
function onModelInput(draft: ProviderDraft, event: Event): void {
  const target = event.target as HTMLInputElement
  draft.model = target.value
  adoptCurrentModel(draft)
}

/** 点选「当前使用」（列表行与折叠区的模型 chips 共用这一个入口）：改的是唯一生效值 `model`。 */
function selectModel(draft: ProviderDraft, id: string): void {
  if (id.trim() === '') return
  draft.model = id
  adoptCurrentModel(draft)
}

/**
 * 「+ 手动添加」：立刻加一行空白项（行数当即 +1，capture 探针按行数断言），
 * 由用户点该行的「重命名」填 id；保存时空行会被丢掉，不会写进配置。
 */
function addModel(draft: ProviderDraft): void {
  draft.modelList.push('')
  message.value = null
  error.value = null
}

/** 第 index 行是否在行内编辑态。 */
function isRenaming(draftId: string, index: number): boolean {
  return renamingModel.value === `${draftId}:${index}`
}

function startRename(draft: ProviderDraft, index: number): void {
  renamingModel.value = `${draft.id}:${index}`
  renameValue.value = draft.modelList[index] ?? ''
  error.value = null
}

/** 只清编辑态：行内编辑按 index 定位，列表结构一变就必须收起来，否则输入框会串到别的行上。 */
function closeRename(): void {
  renamingModel.value = null
  renameValue.value = ''
}

/** 「取消」：待填写的空行顺手清掉（点了「+ 手动添加」又反悔，不该留下一个空行）。 */
function cancelRename(draft: ProviderDraft, index: number): void {
  if (draft.modelList[index] === '') draft.modelList.splice(index, 1)
  closeRename()
}

/**
 * 重命名提交：改的就是列表里的 id；**改的正是当前使用的那个时 `model` 同步改成新 id**
 * （否则两边就指不到同一个模型了）。空值按「取消」处理，重名拒绝。
 */
function commitRename(draft: ProviderDraft, index: number): void {
  const previous = draft.modelList[index] ?? ''
  const next = renameValue.value.trim()
  if (next === '' || next === previous) {
    cancelRename(draft, index)
    return
  }
  if (draft.modelList.some((id, i) => i !== index && id.trim() === next)) {
    error.value = `模型「${next}」已在列表中`
    return
  }
  draft.modelList[index] = next
  if (previous !== '' && previous === currentModel(draft)) draft.model = next
  // 参数是**按模型 id 键**的（v23）：重命名要把该模型的那份参数一起搬到新 id 下，
  // 否则「改了个名字」的模型会读回一份默认参数，用户填过的窗口 / 图片开关像凭空消失。
  transferModelParams(draft, previous, next)
  closeRename()
}

/**
 * 把 `from` 名下的参数搬到 `to`，并删掉旧键。
 * 目标已有条目时**以它为准**（只补它缺的键），与 v22 → v23 迁移同一套「不覆盖已写值」语义。
 */
function transferModelParams(draft: ProviderDraft, from: string, to: string): void {
  if (from === '' || from === to) return
  const source = draft.modelParams[from]
  if (source === undefined) return
  draft.modelParams[to] = { ...source, ...(draft.modelParams[to] ?? {}) }
  delete draft.modelParams[from]
}

/**
 * 从候选列表移除一行。
 *
 * 删的正是当前使用的模型时**不换模型**：`model` 原样保留（它是唯一生效值，改用哪个由用户决定），
 * 页面只在列表下方提示「当前模型已不在列表中」——静默换模型会让下一次请求悄悄用上别的模型。
 */
function removeModel(draft: ProviderDraft, index: number): void {
  draft.modelList.splice(index, 1)
  closeRename()
  // 行内参数块的展开态是**按下标**记的：删一行之后后面的行会整体上移，
  // 不收起来就会让下一行的参数块「自己展开」（看着像点错了）。
  closeParams(draft.id)
  message.value = null
  error.value = null
}

/** 收起某个 provider 下所有行的参数块（删行 / 重命名导致下标错位时用）。 */
function closeParams(draftId: string): void {
  for (const key of Object.keys(paramsOpen)) {
    if (key.startsWith(`${draftId}:`)) delete paramsOpen[key]
  }
}

/** 落盘的候选列表：去空白、去重，并保证当前使用的 `model` 一定在列表里。 */
function normalizedModelList(draft: ProviderDraft): string[] {
  return mergeModelIds(draft.modelList, [currentModel(draft)])
}

/**
 * 某个模型的生成参数（v23，docs/08 §1）：思考等级 / 上下文窗口 / 支持图片输入三项都按
 * **模型 id** 键放在 `modelParams` 下 —— 换个模型就是另一套值（同一个 provider 的不同模型
 * 窗口大小、能不能收图本就不同）。
 *
 * 这是**只读展示**入口，直接转调 shared 的 `resolveModelParams` —— 主进程 / 对话窗 /
 * Center 走的是同一个函数，避免「设置页显示 128K、对话窗按未知处理」这类分叉。
 */
function paramsOf(draft: ProviderDraft, id: string): LlmModelParams {
  return resolveModelParams(draft, id)
}

/**
 * 写某个模型参数的**唯一入口**：整体替换该键的对象，**不要**原地改 `draft.modelParams[id].xxx`。
 *
 * 两个理由：① `modelParams`
 * 落在 `llm.providers`（`z.record`）之下、`SettingsStore` 的字段级回退**不下钻**这棵子树 ——
 * 「只写被改的那一项」会让整份配置在下次启动被判损坏并重建出厂；② 整体替换能让 Vue 的
 * 变更追踪看得见（原地改嵌套对象同样能被追踪，但替换更不容易漏掉）。
 */
function patchParams(draft: ProviderDraft, id: string, patch: Partial<LlmModelParams>): void {
  draft.modelParams[id] = { ...paramsOf(draft, id), ...patch }
}

/**
 * 落盘的参数表：键表 = 归一化后的模型列表（含当前使用的 `model`），值缺省回落默认。
 *
 * 列表里没有的键**丢弃** —— 删掉一行模型，它的参数就在保存时自然清掉，不必在
 * `removeModel` 里另外清理（那条路径还要处理「删了又取消」，两处维护必然分叉）。
 */
function normalizedModelParams(draft: ProviderDraft): Record<string, LlmModelParams> {
  const table: Record<string, LlmModelParams> = {}
  for (const id of normalizedModelList(draft)) table[id] = { ...paramsOf(draft, id) }
  return table
}

/** 上下文窗口的上界：与 `LlmModelParamsSchema.contextWindow` 的 `.max(2_000_000)` 对齐。 */
const CONTEXT_WINDOW_MAX = 2_000_000

/**
 * 「上下文窗口」的**唯一归一化入口**（输入框提交与落盘前各过一次）。
 *
 * 归一规则：空 / 非数字（NaN）→ 0；负数 → 0；小数四舍五入成整数；超过 2000000 → 截断到上限。
 * 0 = 未知是**合法值**（Schema 的 `.min(0)` 同样允许），所以它不该像 baseURL / 模型名那样拦保存。
 */
/**
 * 只读态那行小字里的 token 数显示：**复用 `@aurora/shared` 的唯一口径**
 * （`utils/format.ts` 的 `formatTokenCount`，带单测，与对话窗底部「上下文详解」同款写法）——
 * 这里刻意不再写第二份格式化：同一个「token 数 → K/M」在两处各写一遍，边界行为必然分叉。
 */
const formatContextWindow = formatTokenCount

function clampContextWindow(value: unknown): number {
  const raw = Number(value)
  if (!Number.isFinite(raw)) return 0
  return Math.min(CONTEXT_WINDOW_MAX, Math.max(0, Math.round(raw)))
}

/**
 * 「上下文窗口」输入框：`@change` 提交（与 AgentPage 的 `clampNumber` 同一套路），
 * **不逐键改写** —— `type=number` 下 `1.` / `-` 这类中间态的 `input.value` 是空串，
 * 逐键钳成 0 会把用户正在敲的字符擦掉、连小数都打不进去。
 */
function commitContextWindow(draft: ProviderDraft, id: string, event: Event): void {
  patchParams(draft, id, {
    contextWindow: clampContextWindow((event.target as HTMLInputElement).value),
  })
}

function syncDrafts(): void {
  const settings = settingsStore.settings
  if (!settings) return
  const previous = savedDrafts.value
  const editing = editingId.value
  savedDrafts.value = Object.entries(settings.llm.providers)
    .filter(([id]) => !isCenterOfficialProviderId(id))
    .map(([id, provider]) => {
      // 编辑卡正在改的那一份：按 id 复用**旧对象引用** —— 广播到达（或任何一个即时保存动作
      // 触发的 `settings:changed`）都不回退卡内内容、不关编辑器。未落盘的新建草稿在
      // `localDrafts` 里，不参与这里的重建，所以填了一半的内容也不会被抹掉。
      // （其余行每次重建，别处改过的值——如另一个窗口改 baseURL——照常反映到列表。）
      const reused = editing === id ? previous.find((draft) => draft.id === id) : undefined
      if (reused !== undefined) {
        // 复用的编辑草稿同样只在这张卡打开时渲染模型行，所以也要过一遍补行
        // （用户删掉「当前使用」那一行后，下一次同步把它补回来 —— 这正是既有语义）。
        adoptCurrentModel(reused)
        return reused
      }
      const draft: ProviderDraft = {
        id,
        ...provider,
        // 候选列表**深拷贝成新数组**：`{ ...provider }` 只浅拷贝，卡里直接改会和 store 里
        // 尚未落盘的配置共用同一个数组（下一次 setActive / saveProvider 就把它一起写盘了）。
        // 顺手把当前使用的模型补进去：它本来就是候选项之一，用户看得见两者是一致的。
        modelList: mergeModelIds(provider.modelList, [provider.model.trim()]),
        // 参数表同样**深拷贝成新对象**：只浅拷贝的话，卡里 `patchParams` 改的就是 settings
        // 快照里那一份（下一次任意广播就把它带出去，且和「取消」的语义打架）。
        modelParams: Object.fromEntries(
          Object.entries(provider.modelParams ?? {}).map(([key, value]) => [key, { ...value }]),
        ),
        apiKey: '',
        apiKeySet: Boolean((provider as unknown as { apiKeySet?: boolean }).apiKeySet),
      }
      // 「当前使用的模型」始终在候选列表里占一行（空列表 → 行数 1）。引导页落盘的 provider 是
      // `modelList: []`，不补这一步，模型行内那三枚参数（第 6 条的唯一入口）在默认路径下
      // 根本不渲染。`model` 为空时 `adoptCurrentModel` 原样不动，空白配置仍显示空态。
      adoptCurrentModel(draft)
      return draft
    })
  // provider 被别处删掉（如 `set_setting` 或对话窗）时，编辑卡 / 确认条不能指着一个不存在的行。
  // 未落盘的新建草稿不在 settings 里，所以先把它排除在判断之外。
  if (editing !== null && !isCreating(editing) && !hasSaved(editing)) closeEditor()
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
          // 接口协议（v22，docs/06 §3.2）：用户在折叠区选的值原样落盘 ——
          // `openai-compat` 走 /chat/completions，`openai-responses` 走 /responses。
          // 改它会换端点，因此保存后建议点一次「保存并测试连接」（测的就是这个 type）。
          type: draft.type,
          baseUrl: draft.baseUrl.trim(),
          apiKeyEnc: '',
          model: draft.model.trim(),
          // 候选列表是数组：跨 IPC 前**深拷贝成新数组**（`reactive` 里的数组是 Proxy，
          // 直接传会 DataCloneError）。`normalizedModelList` 每次都新建数组，顺带去空白 / 去重。
          modelList: normalizedModelList(draft),
          // 生成参数按**模型 id** 键（v23，docs/08 §1）：键表 = 归一化后的候选列表，
          // 值缺省回落默认、**列表之外的键丢弃**。`normalizedModelParams` 每次都新建对象，
          // 跨 IPC 前天然没有 Proxy 共享问题；落盘前也不再需要单独的兜底（值已在
          // `paramsOf` / `patchParams` 里归一过）。
          modelParams: normalizedModelParams(draft),
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
  // 落盘成功：新建草稿升级成普通行（从 `localDrafts` 移除后再同步，那一行就来自 settings 了）
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
  // provider id 会作为凭据路径的段（`llm.providers.<id>.apiKey`），`.` 是分隔符 → 禁点。
  // 正则与文案取自 `@aurora/shared` 的单一来源（同 `McpServerSchema.name`），不另写一份。
  if (!RESOURCE_NAME_PATTERN.test(key)) {
    error.value = `Provider「${key}」${RESOURCE_NAME_RULE}`
    return
  }
  if (drafts.value.some((draft) => draft.id === key)) {
    error.value = `Provider「${key}」已存在`
    return
  }
  const model = preset?.model ?? ''
  // 未落盘的新建草稿进 `localDrafts`（不能 push 进 `savedDrafts` 那份会被广播重建的镜像，
  // 否则填了一半的 baseUrl / Key 会被下一次 `syncDrafts` 整条抹掉）。
  localDrafts.value.push({
    id: key,
    // 新建一律从最通行的 `openai-compat` 起步（与 Schema 默认值、迁移口径一致）：
    // 需要 Responses API 的网关是少数，用户会在折叠区自己切。
    type: 'openai-compat',
    baseUrl: preset?.baseUrl ?? '',
    apiKeyEnc: '',
    model,
    // 与 `syncDrafts` 同一口径：当前使用的模型就是列表里的第一个候选项
    modelList: model === '' ? [] : [model],
    // 生成参数按**模型 id** 键（v23）；三项写全 —— `reasoningEffort` 是三个子字段里
    // 三项都写全。图片输入出厂**关**（docs/06 §3.1）：打开之前先确认
    // 这个模型确实能看图，否则每一轮带图的消息都会被服务端 400 拒掉。
    // `model` 为空（自定义 id + 还没填模型名）时不造条目，与迁移的语义一致。
    modelParams:
      model === ''
        ? {}
        : {
            [model]: {
              reasoningEffort: DEFAULT_REASONING_EFFORT,
              contextWindow: 0,
              vision: false,
            },
          },
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

/**
 * 删除一个 provider。
 *
 * 关键语义（别退化）：
 * - `llm.providers` 是 record，**缺项 ≠ 删除**：只在 `providers` 里少一项，
 *   `applyPatch` 不会删掉它（缺项是合法的局部更新形状）。删除必须显式声明
 *   `removedProviders: [id]`。
 * - 凭据清理由主进程在删除**成功之后**一并做（清密文 + 内存明文缓存），这里不再单独
 *   `clearSecret` —— 删除失败时清凭据会把「provider 还在、密文没了」这个缺陷换个方向复现。
 */
async function removeProvider(id: string): Promise<void> {
  const settings = settingsStore.settings
  if (!settings) return
  const next = { ...settings.llm.providers }
  delete next[id]
  const ok = await settingsStore.update({
    llm: {
      active: settings.llm.active === id ? '' : settings.llm.active,
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
    // 把**当前选中的**接口协议一并送去（v22）：用户刚从 chat-completions 切到 Responses、
    // 还没改完就想先测一下端点，测的必须是新协议 —— 否则会出现「测通了但对话仍然 404」。
    // `saveProvider` 在上面已经把 draft.type 落库，这里传的是同一个值（未保存草稿也能测）。
    type: draft.type,
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
    // 去重合并（不覆盖已有项）：拉到的 id 追加进候选列表，当前使用的模型本来就已在其中
    draft.modelList = mergeModelIds(draft.modelList, ids)
    // 列表长度变了，行内编辑按 index 定位会串行，先收起来
    closeRename()
    message.value = `已拉取 ${ids.length} 个，列表共 ${draft.modelList.length} 个`
  } else {
    error.value = result.message
  }
}
</script>

<template>
  <section class="page">
    <header>
      <h1 class="page-title">AI 模型</h1>
      <p class="page-sub">支持任何 OpenAI 兼容服务；凭据加密保存在本机，日志与导出均脱敏。</p>
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

    <!-- 「显示思考过程」（v8 新增）：独立小节，改动即时保存 -->
    <section class="section-card">
      <h2 class="section-title">对话展示</h2>
      <p class="section-desc">对话窗里模型推理内容的呈现方式。</p>

      <SettingField
        data-field="general.chat.showThinking"
        label="显示思考过程"
        hint="展示模型的思考过程，需模型支持 reasoning 输出"
      >
        <label class="row tiny">
          <input
            type="checkbox"
            :checked="showThinking"
            @change="setShowThinking(($event.target as HTMLInputElement).checked)"
          />
          <span>在回复上方显示可折叠的思考过程</span>
        </label>
      </SettingField>
    </section>

    <!-- 空状态：没有任何 provider 时不摆一排空行，直接给主入口（文案与主按钮保持不变） -->
    <section v-if="drafts.length === 0" class="section-card empty-state" data-empty="llm.providers">
      <h2 class="section-title">还没有 AI 模型配置</h2>
      <p class="section-desc">
        添加一个 Provider 并设为默认后主功能才可用；未配置时启动会进入首次引导向导。
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
        <p v-if="isCreating(draft.id)" class="tiny pending-note">
          这条还没有保存：点「应用」后才写入配置。
        </p>
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
          <!-- 刻意不用 `v-model`：填的 id 要**同时**写回 `model` 与候选列表（见 onModelInput） -->
          <input
            :value="draft.model"
            class="input"
            type="text"
            spellcheck="false"
            @input="onModelInput(draft, $event)"
          />
        </SettingField>
        <p class="tiny model-note">这里填当前使用的模型 id；模型列表只是候选项</p>

        <!-- 「模型设置」区（step 5）：候选模型列表。真正生效的仍是上面那个「模型名」 -->
        <section class="model-section" :data-field="`llm.providers.${draft.id}.modelList`">
          <div class="row wrap">
            <h3 class="model-title grow">模型列表</h3>
            <AppButton
              size="sm"
              variant="ghost"
              :disabled="testing !== null"
              @click="loadModels(draft)"
            >
              {{ testing === draft.id ? '拉取中…' : '拉取模型列表' }}
            </AppButton>
            <AppButton size="sm" variant="ghost" data-action="add-model" @click="addModel(draft)">
              + 手动添加
            </AppButton>
          </div>

          <!-- 空态：列表为空就用一句话说清两条路（手动填 / 拉取），不摆一排空行 -->
          <p
            v-if="draft.modelList.length === 0"
            class="model-empty"
            :data-empty="`llm.providers.${draft.id}.modelList`"
          >
            还没有模型列表：先在下面填一个模型名，或点「拉取模型列表」
          </p>

          <div v-else class="model-list">
            <div
              v-for="(item, index) in draft.modelList"
              :key="`${draft.id}:${index}`"
              class="model-row"
              :class="{ current: isCurrent(draft, item) }"
              :data-field="`llm.providers.${draft.id}.modelList.${index}`"
            >
              <div class="model-line">
                <template v-if="isRenaming(draft.id, index)">
                  <input
                    v-model="renameValue"
                    class="input model-rename"
                    type="text"
                    spellcheck="false"
                    @keydown.enter="commitRename(draft, index)"
                    @keydown.esc="cancelRename(draft, index)"
                  />
                  <AppButton
                    size="sm"
                    data-action="commit-rename-model"
                    @click="commitRename(draft, index)"
                  >
                    确定
                  </AppButton>
                  <AppButton
                    size="sm"
                    variant="ghost"
                    data-action="cancel-rename-model"
                    @click="cancelRename(draft, index)"
                  >
                    取消
                  </AppButton>
                </template>
                <template v-else>
                  <label class="model-pick">
                    <input
                      type="radio"
                      :name="`model-of-${draft.id}`"
                      :checked="isCurrent(draft, item)"
                      :disabled="item === ''"
                      data-action="select-model"
                      @change="selectModel(draft, item)"
                    />
                    <span class="mono model-id" :class="{ pending: item === '' }">
                      {{ item === '' ? '（未命名）' : item }}
                    </span>
                  </label>
                  <span v-if="isCurrent(draft, item)" class="badge ok">当前使用</span>
                  <!-- 只读态的窗口读数（v11）；0 = 未知不渲染，编辑入口在行内参数块里 -->
                  <span
                    v-if="isCurrent(draft, item) && paramsOf(draft, item).contextWindow > 0"
                    class="tiny muted"
                    :data-field="`llm.providers.${draft.id}.modelList.${index}.readout`"
                  >
                    窗口 {{ formatContextWindow(paramsOf(draft, item).contextWindow) }}
                  </span>
                  <span class="grow" />
                  <AppButton
                    size="sm"
                    variant="ghost"
                    data-action="toggle-model-params"
                    :aria-expanded="paramsExpanded(draft.id, index)"
                    @click="toggleParams(draft.id, index)"
                  >
                    参数
                  </AppButton>
                  <AppButton
                    size="sm"
                    variant="ghost"
                    data-action="rename-model"
                    @click="startRename(draft, index)"
                  >
                    重命名
                  </AppButton>
                  <AppButton
                    size="sm"
                    variant="ghost"
                    data-action="remove-model"
                    @click="removeModel(draft, index)"
                  >
                    删除
                  </AppButton>
                </template>
              </div>
              <!--
                行内参数（v23，docs/08 §1）：思考等级 / 上下文窗口 / 支持图片输入三项**随模型绑定**
                —— 同一个 provider 下不同模型的窗口大小、能不能收图本就不同。锚点
                `llm.providers.<id>.modelList.<index>.<字段>` 供 capture 抓手。
                展开态按 `${id}:${index}` 记，允许多行同时展开（这里不涉及浮层互斥）。
              -->
              <div v-if="paramsExpanded(draft.id, index)" class="model-params">
                <!--
                  三个 `data-field` 都挂在**外层 label** 上、控件在它内部：这既是 `SettingField`
                  的既有口径（探针按 `[data-field$=".xxx"] select` / `input[type=checkbox]` 往下钻），
                  也让 label 的原生「点文字即聚焦控件」生效。
                -->
                <label
                  class="param-field"
                  :data-field="`llm.providers.${draft.id}.modelList.${index}.reasoningEffort`"
                >
                  <span class="tiny muted">思考等级</span>
                  <select
                    class="input"
                    :value="paramsOf(draft, item).reasoningEffort"
                    @change="
                      patchParams(draft, item, {
                        reasoningEffort: ($event.target as HTMLSelectElement)
                          .value as ReasoningEffort,
                      })
                    "
                  >
                    <option v-for="level in REASONING_EFFORT_LEVELS" :key="level" :value="level">
                      {{ REASONING_EFFORT_LABELS[level].full }}
                    </option>
                  </select>
                </label>
                <label
                  class="param-field"
                  :data-field="`llm.providers.${draft.id}.modelList.${index}.contextWindow`"
                >
                  <span class="tiny muted">上下文窗口</span>
                  <input
                    class="input input-num"
                    type="number"
                    min="0"
                    max="2000000"
                    step="1000"
                    :value="paramsOf(draft, item).contextWindow"
                    @change="commitContextWindow(draft, item, $event)"
                  />
                </label>
                <label
                  class="param-field"
                  :data-field="`llm.providers.${draft.id}.modelList.${index}.vision`"
                >
                  <input
                    type="checkbox"
                    data-action="toggle-vision"
                    :checked="paramsOf(draft, item).vision"
                    @change="
                      patchParams(draft, item, {
                        vision: ($event.target as HTMLInputElement).checked,
                      })
                    "
                  />
                  <span class="tiny">把拖入的图片交给这个模型</span>
                </label>
                <span class="tiny muted param-hint">
                  窗口单位 token，仅作对话窗「上下文占用比例」的分母，留空或 0 =
                  未知（不显示占比），上限
                  2000000；图片输入开启后这个模型的图片附件才会作为图片发出去（需该模型支持视觉），
                  并给模型开放看图 / 截屏 / 读剪贴板图片三个工具
                </span>
              </div>
            </div>
          </div>

          <!-- 删掉当前使用的那一项之后：`model` 原样保留，只在这里提示，不静默换成列表里的别的模型 -->
          <p v-if="modelNotInList(draft)" class="tiny model-missing">
            当前模型已不在列表中：生效值仍是「{{
              draft.model.trim()
            }}」，请点选列表或改上面的「模型名」
          </p>
        </section>

        <button
          class="more"
          type="button"
          :aria-expanded="advancedOf(draft.id)"
          @click="toggleAdvanced(draft.id)"
        >
          <ChevronRight
            class="chevron"
            :class="{ open: advancedOf(draft.id) }"
            :size="14"
            :stroke-width="1.8"
            aria-hidden="true"
          />
          高级参数与连接测试
        </button>

        <Transition name="collapse">
          <div v-if="advancedOf(draft.id)" class="advanced">
            <!--
              接口协议（v22，docs/06 §3.2）：`openai-compat` = POST /chat/completions（最通行，
              也是旧配置与新建条目的默认），`openai-responses` = POST /responses（OpenAI Responses API）。
              改它等于换端点，因此放在折叠区第一项、并紧挨着「保存并测试连接」——
              改完立刻能测；`data-field` 供 capture 抓手。
            -->
            <SettingField
              :data-field="`llm.providers.${draft.id}.type`"
              label="接口类型"
              hint="openai-compat 走 /chat/completions（默认）；openai-responses 走 /responses。改完请点下面的「保存并测试连接」验一次"
            >
              <select v-model="draft.type" class="input">
                <option v-for="item in PROVIDER_TYPE_OPTIONS" :key="item.value" :value="item.value">
                  {{ item.label }}
                </option>
              </select>
            </SettingField>

            <!--
              这里**刻意只剩接口类型**：思考等级 / 上下文窗口 / 支持图片输入三项都随**模型**走
              （v23，docs/08 §1），编辑入口在「模型列表」每一行右上角的「参数」开关里 ——
              它们描述的是「这个模型能做什么」，放在 provider 级会让切模型时显示出另一套谎话。
            -->
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

            <!-- 折叠区的模型 chips 与「模型列表」共用 selectModel：点选即改生效值并补进候选列表 -->
            <div v-if="modelsOf(draft.id).length > 0" class="models">
              <button
                v-for="model in modelsOf(draft.id)"
                :key="model"
                type="button"
                class="model-chip interactive"
                @click="selectModel(draft, model)"
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
      改动需点「应用」或工具行的「保存全部」后落盘；API Key 留空表示不修改已保存的凭据。
    </p>

    <!-- 生图模型区组（v8 新增）：独立 provider 体系，与聊天模型互不绑定 -->
    <ImageGenSection />
  </section>
</template>

<style scoped>
.page > .section-card,
.page > .provider-list .section-card {
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-hairline);
}

.page > .empty-state {
  padding-block: var(--space-6);
}

.page :is(input[type='number'], .badge) {
  font-variant-numeric: var(--num-tabular);
}

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

/* 折叠入口：与分组头一致的弱化按钮。**只在编辑卡内**出现（行上只有编辑 / 设为默认 / 删除三个动作，
   行内那颗只留 chevron 的展开按钮已撤掉），所以这颗带 chevron + 文案 */
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

/* 「模型设置」区（step 5）：候选模型列表。真正生效的仍是必填区的「模型名」 */
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

/* 「模型名」输入框下面那行小字：说清谁是生效值、谁只是候选项 */
.model-note {
  margin: 0;
  color: var(--text-muted);
}

.model-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 一行候选模型：hover 用分层填充（与 provider 行列表同一套观感），不做上浮位移，免得行跟着跳 */
/* 一行模型 = 行内容 + 可展开的参数块：外层竖向排列，行内容自成一个横向 flex 行 */
.model-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast);
}

.model-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

/*
 * 行内参数块：与行内容用一条左侧竖线区分（它是该模型的下级信息）。
 * 这里**不用** `SettingField` —— 那是竖向「标签在上、控件在下」的分组卡，
 * 放进已有一行里会把行高撑成三倍。
 */
.model-params {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1) var(--space-3);
  margin-left: var(--space-3);
  padding-left: var(--space-3);
  border-left: 2px solid var(--border-subtle);
}

.param-field {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

/* 参数块里的控件压缩到与行同高（全局 `.input` 是 36px + 100% 宽，放这一行会顶开布局） */
.model-params .input {
  width: auto;
  min-width: 220px;
  min-height: 28px;
  padding: 0 var(--space-2);
}

.model-params .input.input-num {
  min-width: 120px;
  width: 120px;
}

.param-hint {
  flex: 1 1 100%;
}

.model-row:hover {
  background: var(--fill-2);
}

.model-pick {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  cursor: pointer;
}

.model-pick input[type='radio'] {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  accent-color: var(--aurora-blue);
  cursor: pointer;
}

.model-pick input[type='radio']:disabled {
  cursor: default;
}

.model-id {
  font-size: var(--text-sm);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 当前使用的那一行：文字回到主色（标记已由 radio + badge 表达，不再加重背景，免得和 hover 打架） */
.model-row.current .model-id {
  color: var(--text-primary);
}

.model-id.pending {
  font-style: italic;
  color: var(--text-muted);
}

.model-rename {
  min-width: 0;
  max-width: 260px;
}

/* 空态：一句话说清两条路，不摆一排空行（与 provider 空状态同一套虚线观感，弱化到行内尺寸） */
.model-empty {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  border: 1px dashed var(--border-strong);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

/* 删掉当前使用的那一项之后的提示：不换模型，只把状态说清楚（用告警色令牌，不写死颜色） */
.model-missing {
  margin: 0;
  color: var(--status-unread);
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

.advanced {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  border-top: 1px solid var(--border-subtle);
  padding-top: var(--space-2);
}

/* 开关行（图片输入，v22）：与设置页其它复选框同款排布 —— 方框在当前色，文字在次色 */
.switch-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  cursor: pointer;
}

.wrap {
  flex-wrap: wrap;
}

.models {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

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
