<script setup lang="ts">
/**
 * AI 交互窗口（docs/07 §2.3）：完整对话窗，约 420×640，贴右缘滑出。
 *
 * P3 范围：真实模型流式对话、工具执行卡片、会话历史水合（`chat:history`）、模式引导面板。
 * P5 追加：敏感工具确认卡片（docs/06 §5）与分类流水面板（docs/05 §3.3）——
 * 交互窗是主动引导的**主载体**，两者都挂在这里。
 * P6 追加：多会话列表 / 切换（docs/06 §4）与附件拖拽发送（docs/07 §2.3）。
 * 本轮：侧栏改为「快速 / 会话」双栏（快速会话与提示条共用同一会话），
 * 「收起」= 只隐藏窗口（`windowStore.hide('chat')`），不做任何会话动作、也不 abort 流式回复。
 * 本轮追加：输入区加「思考等级」下拉（与设置页 AI 模型卡写的是**同一个** `reasoningEffort`，
 * 改完对下一次请求立即生效，不用进设置页）。
 *
 * 视觉（docs/07 §5）：玻璃容器 + 分层头尾（`--fill-1`），用户气泡右对齐、助手正文铺开，
 * 输入区是独立的圆角容器（聚焦加品牌光晕），会话列表/工具卡片走 `.sheet-*` / `.collapse-*`。
 * 交互语义（会话切换、发送、中断、附件拖拽、工具卡片、敏感工具确认）保持不变。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { ChatMessageDto, LlmProviderConfig, SensitiveToolRequest } from '@aurora/shared'
import { DEFAULT_REASONING_EFFORT, type ReasoningEffort } from '@aurora/shared/browser'
import AppButton from '../shared/components/AppButton.vue'
import AppToast from '../shared/components/AppToast.vue'
import ClassificationLedger from '../shared/components/ClassificationLedger.vue'
import MessageList from '../shared/components/MessageList.vue'
import SensitiveToolCard from '../shared/components/SensitiveToolCard.vue'
import StatusDot from '../shared/components/StatusDot.vue'
import ThinkingLevelSelect from '../shared/components/ThinkingLevelSelect.vue'
import { useChat } from '../shared/composables/useChat.js'
import { useWindowDrag } from '../shared/composables/useWindowDrag.js'
import { useModeStore, useSettingsStore, useWindowStore } from '../shared/stores.js'

const chat = useChat('chat', 'main')
const {
  sessionId,
  messages,
  sessions,
  streaming,
  error: chatError,
  statusTone,
  send: sendMessage,
  abort,
  clear,
  hydrate,
  loadQuickPreview,
  loadSessions,
  switchSession,
  newSession,
} = chat
const windowStore = useWindowStore()
const settingsStore = useSettingsStore()
const modeStore = useModeStore()
// 拖动统一走显式清单（step 6）：交互窗可拖，按钮区显式 no-drag，不靠模板写死 class
const { dragClass, noDragClass } = useWindowDrag('chat')

const input = ref('')
/** 侧栏显隐（头部「历史」按钮切换）；默认收起，不挤占消息区 */
const showSidebar = ref(false)
/** 侧栏栏目：「快速」= 快速会话预览，「会话」= 完整会话列表 */
const sidebarTab = ref<'quick' | 'sessions'>('sessions')
/** 「快速」栏的只读预览（`loadQuickPreview()`，不改变当前会话） */
const quickPreview = ref<ChatMessageDto[]>([])

/** 待确认的敏感工具调用（主进程同一时刻最多推一条） */
const sensitiveRequest = ref<SensitiveToolRequest | null>(null)
let offSensitiveTool: (() => void) | null = null

/** 拖拽中的附件绝对路径（发送后清空） */
const attachments = ref<string[]>([])
/** 是否正有文件悬停在窗口上（用于描边提示） */
const dragging = ref(false)

onMounted(() => {
  offSensitiveTool = window.aurora.proactive.onSensitiveTool((request) => {
    sensitiveRequest.value = request
  })
  // 水合当前会话（main）→ 会话列表 → 快速会话预览：让侧栏「快速」栏一打开就有内容
  void hydrate().then(() => loadSessions())
  void refreshQuickPreview()
})

/** 刷新「快速」栏预览（只读，不切换当前会话） */
async function refreshQuickPreview(): Promise<void> {
  quickPreview.value = await loadQuickPreview()
}

onUnmounted(() => {
  offSensitiveTool?.()
  offSensitiveTool = null
  if (effortHintTimer !== null) window.clearTimeout(effortHintTimer)
  effortHintTimer = null
})

function resolveSensitive(): void {
  sensitiveRequest.value = null
}

const guide = computed(() => {
  const mode = modeStore.current
  if (!mode || mode.guideCompleted) return null
  return mode
})

/** 标题栏里的当前会话名（空标题显示为「新会话」，与主进程摘要一致） */
const currentTitle = computed(() => {
  const current = sessions.value.find((item) => item.id === sessionId.value)
  return sessionTitle(current?.title ?? '')
})

// ───────────────────── 思考等级（docs/06 §3 / docs/07 §2.3） ─────────────────────

/**
 * 输入区的「思考等级」下拉：读写**当前生效 provider** 的 `llm.providers.<active>.reasoningEffort`。
 *
 * 与设置页「AI 模型」卡写的是同一个字段（单一事实来源），**没有按会话覆盖**；
 * 保存成功后 `settings:changed` 会把新配置推回 store，控件值随之更新，
 * 下一次请求由 `createProviderFactory()` 读到新值（`auto` → 不下发 `reasoning_effort`）。
 */
const activeProviderId = computed(() => settingsStore.settings?.llm.active ?? '')

/** 当前生效 provider 的思考等级；没有可用 provider 时为 `null`（此时控件禁用而不是隐藏） */
const effort = computed<ReasoningEffort | null>(() => {
  const settings = settingsStore.settings
  if (!settings) return null
  const provider = settings.llm.providers[activeProviderId.value]
  return provider ? provider.reasoningEffort : null
})

/** 下拉显示值：无 provider 时用默认等级占位——禁用态也要让用户看得见这个控件 */
const effortValue = computed<ReasoningEffort>(() => effort.value ?? DEFAULT_REASONING_EFFORT)

/** 下拉 tooltip：无 provider → 指向修复路径；有 provider → 说明这个参数的含义 */
const effortTitle = computed(() =>
  effort.value === null
    ? '先在「设置 → AI 模型」里配置并选中一个模型'
    : '思考等级（越高越深入，但更慢更贵）；auto 不下发该参数，兼容性最好',
)

/** 保存结果的一行轻提示（成功 2 秒后消失；失败走 chatError） */
const effortHint = ref<string | null>(null)
let effortHintTimer: number | null = null

function flashEffortHint(text: string): void {
  effortHint.value = text
  if (effortHintTimer !== null) window.clearTimeout(effortHintTimer)
  effortHintTimer = window.setTimeout(() => {
    effortHint.value = null
    effortHintTimer = null
  }, 2000)
}

/**
 * 去掉只在渲染层存在的两个字段，其余字段原样透传（将来给 provider 加业务字段不会被漏掉）。
 *
 * 为什么必须去掉：渲染层拿到的 `apiKeyEnc` 按设计永远是空串（主进程 `redactSettings()` 脱敏），
 * 而主进程 `applyPatch()` 对每个出现在 patch 里的 provider 做 `{ ...已有, ...patch }` 逐字段合并——
 * 把空串带回去就等于"把磁盘上的密文覆盖成空"。同进程内 `SettingsStore.setSecret` 写的
 * `memorySecrets` 缓存会继续供出正确凭据，所以现象是「用起来没事、重启后 API Key 没了」
 * （主进程 `smoke.ts` 的注释对 patch 有同样的要求）。
 */
function stripSecretFields(provider: LlmProviderConfig): LlmProviderConfig {
  const {
    apiKeyEnc: _cipher,
    apiKeySet: _keySet,
    ...rest
  } = provider as LlmProviderConfig & { apiKeySet?: boolean }
  return rest as LlmProviderConfig
}

/**
 * 写入当前 provider 的思考等级（只在用户真的改了值时写，挂载 / 切 provider 都不产生空写）。
 *
 * patch 必须**原样回传 `llm.active` 与全部 `providers`**（分组级局部更新，缺了会丢配置），
 * 但每一个 provider 都要先过 `stripSecretFields()`：只改当前那个，其余 provider 的**空密文**
 * 一样会覆盖磁盘上的对应凭据。
 */
async function setEffort(next: ReasoningEffort): Promise<void> {
  const settings = settingsStore.settings
  const id = activeProviderId.value
  if (!settings || id === '') return
  const provider = settings.llm.providers[id]
  if (!provider || provider.reasoningEffort === next) return
  const providers: Record<string, LlmProviderConfig> = {}
  for (const [providerId, item] of Object.entries(settings.llm.providers)) {
    providers[providerId] = stripSecretFields(item)
  }
  providers[id] = { ...stripSecretFields(provider), reasoningEffort: next }
  const ok = await settingsStore.update({
    llm: { active: settings.llm.active, providers },
  })
  if (!ok) {
    chatError.value = settingsStore.error
    return
  }
  flashEffortHint(`思考等级已改为 ${next}`)
}

// ───────────────────────── 附件拖拽（docs/07 §2.3） ─────────────────────────

/**
 * 取拖入文件路径。
 *
 * 路径解析必须走 preload（`webUtils.getPathForFile`）：Electron 32 起
 * `File.path` 已移除，渲染层自己拿不到本地路径。拿不到路径的条目（如从
 * 浏览器拖来的虚拟文件）直接跳过，不假装已附加。
 */
function onDrop(event: DragEvent): void {
  dragging.value = false
  const files = event.dataTransfer?.files
  if (files === undefined || files.length === 0) return
  const paths: string[] = []
  for (const file of Array.from(files)) {
    const path = window.aurora.chat.filePath(file)
    if (path !== '') paths.push(path)
  }
  if (paths.length === 0) {
    chatError.value = '无法读取拖入文件的本地路径（仅支持从资源管理器拖入的文件）'
    return
  }
  const next = new Set([...attachments.value, ...paths])
  attachments.value = [...next]
}

function removeAttachment(path: string): void {
  attachments.value = attachments.value.filter((item) => item !== path)
}

function fileNameOf(path: string): string {
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1] ?? path
}

async function send(): Promise<void> {
  const text = input.value.trim()
  if (text === '' && attachments.value.length === 0) return
  const files = attachments.value
  input.value = ''
  attachments.value = []
  await sendMessage(text, files)
  // 新会话此时才有标题，刷新列表让侧栏显示出来
  void loadSessions()
}

/**
 * 切换侧栏栏目。
 *
 * 切到「快速」时顺带刷新预览（只读，不影响当前会话）：否则在快速会话里发完消息后，
 * 预览会一直停在挂载时的那几条。
 */
function selectTab(tab: 'quick' | 'sessions'): void {
  sidebarTab.value = tab
  if (tab === 'quick') void refreshQuickPreview()
}

/** 「继续快速对话」：切到快速会话（栏目保持不变，用户还在「快速」栏里） */
async function openQuick(): Promise<void> {
  await switchSession('quick')
}

/** 「快速」栏的预览正文：折叠空白 + 截断（侧栏只有 152px 宽，不做多行渲染） */
function previewText(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat
}

async function startGuide(): Promise<void> {
  if (!guide.value) return
  const session = await window.aurora.mode.guideStart(guide.value.id)
  if (session.ok) {
    const step = session.value.step
    if (step) {
      const text = `【${guide.value.displayName} 引导 ${step.index + 1}/${step.total}】${step.question}`
      await chat.send(text)
    }
  }
}

async function markGuideDone(): Promise<void> {
  if (!guide.value) return
  await modeStore.completeGuide(guide.value.id)
}

/** 会话标题：空会话显示为「新会话」，与主进程的摘要保持一致 */
function sessionTitle(title: string): string {
  return title.trim() === '' ? '新会话' : title
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const today = new Date()
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  return sameDay
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}
</script>

<template>
  <div class="chat glass">
    <header class="head" :class="dragClass">
      <div class="head-title">
        <StatusDot :tone="statusTone" title="AI 状态" />
        <strong class="head-name">对话</strong>
        <span class="badge">{{ modeStore.current?.displayName ?? '未激活' }}</span>
        <span v-if="settingsStore.needsOnboarding" class="badge warn">未配置模型</span>
        <span class="tiny muted session">{{ currentTitle }}</span>
      </div>
      <div class="head-actions" :class="noDragClass">
        <AppButton size="sm" variant="ghost" @click="showSidebar = !showSidebar">历史</AppButton>
        <AppButton size="sm" variant="ghost" @click="newSession">新建</AppButton>
        <AppButton size="sm" variant="ghost" @click="clear">清空</AppButton>
        <AppButton size="sm" variant="ghost" @click="windowStore.show('settings')">设置</AppButton>
        <!--
          收起 = **直接隐藏窗口**：只隐藏，正在进行的流式回复不会被 abort
          （`hide()` 不触碰 `chat:abort`，docs/02 §2.2「关闭 = 隐藏」）。
        -->
        <AppButton
          size="sm"
          variant="ghost"
          title="收起对话窗口（对话仍在后台继续）"
          @click="windowStore.hide('chat')"
        >
          收起
        </AppButton>
      </div>
    </header>

    <SensitiveToolCard
      v-if="sensitiveRequest"
      :key="sensitiveRequest.confirmId"
      :request="sensitiveRequest"
      class="sensitive-host"
      @resolved="resolveSensitive"
    />

    <div class="body">
      <Transition name="sheet">
        <aside v-if="showSidebar" class="history">
          <!-- 双栏：「快速」= 快速会话预览（与提示条共用同一会话），「会话」= 完整会话列表 -->
          <div class="sidebar-tabs">
            <button
              type="button"
              class="tab interactive"
              :class="{ active: sidebarTab === 'quick' }"
              @click="selectTab('quick')"
            >
              快速
            </button>
            <button
              type="button"
              class="tab interactive"
              :class="{ active: sidebarTab === 'sessions' }"
              @click="selectTab('sessions')"
            >
              会话
            </button>
          </div>

          <template v-if="sidebarTab === 'quick'">
            <p v-if="quickPreview.length === 0" class="tiny muted">快速会话还没有消息</p>
            <div v-for="item in quickPreview" :key="item.id" class="history-item quick-item">
              <strong class="tiny">{{ item.role === 'user' ? '我' : 'Aurora' }}</strong>
              <span class="tiny muted">{{ previewText(item.content) }}</span>
            </div>
            <div class="sidebar-foot">
              <AppButton size="sm" variant="primary" block @click="openQuick">
                继续快速对话
              </AppButton>
            </div>
          </template>

          <template v-else>
            <div class="row">
              <strong class="tiny grow">会话</strong>
              <AppButton size="sm" variant="ghost" @click="newSession">新建</AppButton>
            </div>
            <p v-if="sessions.length === 0" class="tiny muted">还没有会话</p>
            <button
              v-for="item in sessions"
              :key="item.id"
              type="button"
              class="history-item interactive"
              :class="{ active: item.id === sessionId }"
              @click="switchSession(item.id)"
            >
              <strong class="tiny">{{ sessionTitle(item.title) }}</strong>
              <span class="tiny muted">
                {{ formatTime(item.updatedAt) }} · {{ item.messageCount }} 条
              </span>
            </button>
          </template>
        </aside>
      </Transition>

      <main
        class="thread"
        :class="{ dragging, streaming }"
        @dragenter.prevent="dragging = true"
        @dragover.prevent
        @dragleave="dragging = false"
        @drop.prevent="onDrop"
      >
        <AppToast v-if="settingsStore.needsOnboarding" tone="warn">
          还没有可用的 AI 模型配置：当前只能返回占位回复。
          <AppButton size="sm" variant="ghost" @click="windowStore.show('settings')"
            >去配置</AppButton
          >
        </AppToast>

        <AppToast v-if="guide" tone="info">
          {{ guide.displayName }} 引导未完成（{{ guide.readinessHint ?? '按步骤完成设置' }}）。
          <AppButton size="sm" variant="ghost" @click="startGuide">开始引导</AppButton>
          <AppButton size="sm" variant="ghost" @click="markGuideDone">标记完成</AppButton>
        </AppToast>

        <p v-if="dragging" class="drop-hint tiny">松开即可把文件内容附带发送</p>

        <MessageList
          :messages="messages"
          empty-hint="这是完整对话窗口：可以问系统状态、让 Aurora 帮忙整理资料，也可以直接把文件拖进来。"
        />
      </main>
    </div>

    <ClassificationLedger class="ledger-host" :limit="20" />

    <footer class="composer">
      <div v-if="attachments.length > 0" class="attachments">
        <span v-for="path in attachments" :key="path" class="chip tiny">
          {{ fileNameOf(path) }}
          <button
            type="button"
            class="chip-remove"
            aria-label="移除附件"
            @click="removeAttachment(path)"
          >
            ×
          </button>
        </span>
      </div>

      <div class="composer-box">
        <textarea
          v-model="input"
          spellcheck="false"
          placeholder="输入消息，Ctrl + Enter 发送；可直接把文件拖进来"
          @keydown.enter.exact.prevent="send"
          @keydown.ctrl.enter.prevent="send"
        />
        <div class="composer-bar">
          <span class="tiny muted meta"> 会话：{{ sessionId }} · 可调用 Skill 与 MCP 工具 </span>
          <label class="tiny muted effort-label" for="chat-thinking-level">思考</label>
          <!-- 下拉自己带 `data-field="chat.reasoningEffort"`：capture 探针与 UI 断言的唯一抓手 -->
          <ThinkingLevelSelect
            id="chat-thinking-level"
            :model-value="effortValue"
            :disabled="effort === null"
            :title="effortTitle"
            @update:model-value="setEffort"
          />
          <!--
            无可用 provider 时控件**保持可见**（只禁用、不隐藏）：用户抱怨的正是「找不到按钮」。
            提示文字与 tooltip 都指向修复路径；tooltip 挂在这行提示上是因为 Chromium 不给
            禁用态的原生控件弹 title。
          -->
          <span v-if="effort === null" class="tiny muted effort-hint" :title="effortTitle">
            未配置模型
          </span>
          <span v-else-if="effortHint" class="tiny muted effort-hint">{{ effortHint }}</span>
          <AppButton v-if="streaming" size="sm" @click="abort">停止</AppButton>
          <span class="send-slot">
            <AppButton
              class="send"
              size="sm"
              variant="primary"
              aria-label="发送"
              title="发送（Ctrl + Enter）"
              :disabled="streaming || (input.trim() === '' && attachments.length === 0)"
              @click="send"
            >
              <svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 13V3.6M8 3.6 4.2 7.4M8 3.6l3.8 3.8" />
              </svg>
            </AppButton>
          </span>
        </div>
      </div>

      <AppToast v-if="chatError" tone="error">{{ chatError }}</AppToast>
    </footer>
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  height: 100vh;
  border-radius: var(--radius-lg);
  overflow: hidden;
}

/* ── 标题栏：两行（标题 / 操作），靠分层填充与内容区区分，不加粗边框 ── */
.head {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  background: var(--fill-1);
  border-bottom: 1px solid var(--border-subtle);
}

.head-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.head-name {
  flex: 0 0 auto;
  font-weight: var(--weight-semibold);
}

/* 标题栏只有会话名可被压缩（窄窗时不挤掉状态点与 badge） */
.head-title .badge,
.head-title .status-dot {
  flex: 0 0 auto;
}

.session {
  flex: 0 1 auto;
  margin-left: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.head-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-1);
}

/* 头部本身是 --fill-1 层：中性 badge 要再亮一层才有底（语义色 badge 保留全局样式） */
.head .badge:not(.warn):not(.error):not(.ok) {
  background: var(--fill-2);
}

.body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.sensitive-host {
  flex: 0 0 auto;
}

.ledger-host {
  flex: 0 0 auto;
}

/* ── 侧栏：快速 / 会话双栏 ── */
.history {
  flex: 0 0 auto;
  width: 152px;
  padding: var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  overflow-y: auto;
  background: var(--fill-1);
  border-right: 1px solid var(--border-subtle);
}

.history-item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 6px 8px 6px 12px;
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--text-secondary);
  /* 会话标题来自首条用户消息，可能是长 URL：允许在任意位置折行，不撑破 152px 侧栏 */
  overflow-wrap: anywhere;
}

.history-item.active {
  background: var(--fill-2);
  color: var(--text-primary);
}

/* 当前项：左侧 3px 品牌色指示条 */
.history-item.active::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 60%;
  border-radius: var(--radius-pill);
  background: var(--aurora-blue);
}

/* ── 侧栏栏目切换（快速 / 会话）：分段控件，与全局 .interactive 悬停共用 ── */
.sidebar-tabs {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-sm);
  background: var(--fill-2);
}

.tab {
  flex: 1;
  padding: 3px 0;
  border-radius: var(--radius-xs);
  font-size: var(--text-xs);
  color: var(--text-muted);
  text-align: center;
}

.tab.active {
  background: var(--fill-1);
  color: var(--text-primary);
}

/* 「快速」栏的预览条目是只读快照，不响应点击（切换走底部主按钮） */
.quick-item {
  cursor: default;
}

/* 「继续快速对话」贴侧栏底部，与上方预览拉开距离 */
.sidebar-foot {
  margin-top: auto;
  padding-top: var(--space-1);
}

.thread {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  overflow-y: auto;
  padding: var(--space-3);
}

/* 拖拽悬停反馈：对话区整体描边，避免用户不确定有没有拖对地方 */
.thread.dragging {
  outline: 1px dashed var(--aurora-blue);
  outline-offset: -6px;
  background: color-mix(in srgb, var(--aurora-blue) 8%, transparent);
}

.drop-hint {
  margin: 0;
  text-align: center;
  color: var(--aurora-blue);
}

/**
 * 流式光标：只挂在**最后一条助手消息**正文的末尾。
 * 用父级 `.streaming` + `::after` 实现，不碰 MessageList 的 props，也不会在每条 delta
 * 上重放整段进场动画（`.rise-*` 只在插入新消息时生效）。
 */
.thread.streaming :deep(.message.r-assistant:last-of-type .md > :last-child)::after {
  content: '';
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  vertical-align: -0.15em;
  border-radius: 1px;
  background: var(--aurora-blue);
  animation: caret 1.1s steps(1, end) infinite;
}

@keyframes caret {
  0%,
  45% {
    opacity: 1;
  }
  46%,
  100% {
    opacity: 0.15;
  }
}

/* ── 输入区 ── */
.composer {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3) var(--space-3);
  background: var(--bg-raised);
  border-top: 1px solid var(--border-subtle);
}

.attachments {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--aurora-blue) 18%, transparent);
}

.chip-remove {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: var(--text-base);
  line-height: 1;
  padding: 0;
}

.composer-box {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  transition:
    border-color var(--transition-base),
    box-shadow var(--transition-base);
}

/* 聚焦：边框转品牌色 + 柔和光晕（docs/07 §5 允许的品牌精确值） */
.composer-box:focus-within {
  border-color: var(--aurora-blue);
  box-shadow: 0 0 0 3px rgba(86, 132, 255, 0.18);
}

.composer textarea {
  width: 100%;
  min-height: 44px;
  max-height: 160px;
  padding: var(--space-1) 0;
  border: 0;
  background: transparent;
  line-height: var(--leading-normal);
  resize: vertical;
  outline: none;
}

.composer textarea::placeholder {
  color: var(--text-muted);
}

.composer-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.meta {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/**
 * 「思考」标签与提示（docs/07 §2.3）。
 *
 * 420px 宽的交互窗里这一行已经很紧，压缩的**只能**是可省略的文本：
 * 标签、下拉（组件内 `flex: 0 0 auto`）与发送按钮都不收缩，
 * 提示自己可以收缩并省略——否则它会把发送按钮顶出行外。
 * `white-space: nowrap` 是必须的：CJK 允许逐字断行，标签被压时会折成两行撑高输入区。
 */
.effort-label {
  flex: 0 0 auto;
  white-space: nowrap;
}

.effort-hint {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 发送按钮不允许被压缩：它被挤出圆角输入框是这一行最容易破的版 */
.send-slot {
  flex: 0 0 auto;
}

/* 发送按钮：渐变圆形（AppButton 的 primary 底色 + 这里的尺寸覆盖） */
.send-slot :deep(.aurora-button) {
  width: 30px;
  height: 30px;
  padding: 0;
  border-radius: var(--radius-pill);
}

.icon {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
