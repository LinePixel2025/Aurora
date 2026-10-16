<script setup lang="ts">
/**
 * 自动化页（docs/13 §11，docs/07 §2.3）：主区第三种 view（与子代理页同构，不属任何会话）。
 *
 * 结构：顶部「Agent Mode / Normal Mode」双 tab + 新建 / 历史按钮 →
 * 按当前 tab 过滤的自动化卡片列表（名称 + 触发描述 + 启停 + 编辑 / 删除 / 立即运行）→
 * Normal tab 底部「内置」区（ClassRoom 既有自动操作，启停映射既有配置，docs/13 §6）。
 * 新建 / 编辑 / 历史均打开单例 `automation` BrowserWindow，不再在主区挂 Modal（docs/07 §2.2.1）。
 *
 * **2026-09 前端减负轮重做**（docs/07 §5.4）：
 * - **每个操作/条件都带图标**：条件磁贴、操作胶囊、历史状态、模式徽章、卡片摘要各有语义图标
 *   （`triggerIconOf` / `actionIconOf` / `statusIconOf`），不再靠纯文字区分；
 * - **不再出现原生 `<select>`**：条件选择从下拉改成图标磁贴网格（点一下即选、看得见全部选项），
 *   参数里的下拉 / 星期多选分别改成胶囊分段与星期胶囊（`AutomationFieldInput.vue`）；
 * - **说明文案离开版面**：可以压缩的解释一律挪进 `AppTooltip`，版面上只留标签与值。
 *
 * 门控口径：catalog 里 `available: false` 的操作组件**不渲染选项**（不是 disabled）；
 * 内置自动化的开关直接写 `modes.classroom.preClassReminder / preClassOpenFolder`——
 * 它们的启停条件本来就长在既有配置上，不另立状态（docs/13 §6）。
 * 历史窗口里 Normal 记录**只显示触发时间与状态**（不展开操作明细，产品口径）。
 *
 * `data-field` / `data-action` 锚点是 capture 探针契约（spec §5.3），不可改名；
 * 编辑器与历史的 `.run-item` 等契约锚点已随视图迁到 `automation` 窗口。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { Component } from 'vue'
import type { AutomationDefinition } from '@aurora/shared'
import AppButton from '../../shared/components/AppButton.vue'
import AppTooltip from '../../shared/components/AppTooltip.vue'
import { deepClone } from '@aurora/shared/browser'
import { useSettingsStore } from '../../shared/stores.js'
import {
  ArrowLeft,
  Bell,
  BellRing,
  BookOpen,
  Bot,
  CalendarClock,
  CircleCheck,
  CirclePlay,
  CircleStop,
  FolderOpen,
  History,
  Hourglass,
  Info,
  Pencil,
  Play,
  Plus,
  Repeat,
  School,
  Sparkles,
  Timer,
  Trash2,
  TriangleAlert,
  Workflow,
  Zap,
} from '@aurora/shared/browser'

const settingsStore = useSettingsStore()

/**
 * 「返回对话」与子代理页同款口径：主区替换内容不属任何会话，切走/切回都不动会话状态。
 */
const emit = defineEmits<{
  (event: 'back'): void
}>()

// ───────────────────────── 列表状态 ─────────────────────────

const tab = ref<'agent' | 'normal'>('agent')
const userDefs = ref<AutomationDefinition[]>([])
const builtinDefs = ref<AutomationDefinition[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
/** 两段式删除确认：正在等待二次点击的自动化 id */
const confirmingDelete = ref<string | null>(null)

const shownDefs = computed(() => userDefs.value.filter((item) => item.mode === tab.value))
const builtinShown = computed(() => (tab.value === 'normal' ? builtinDefs.value : []))

let offChanged: (() => void) | null = null
let noticeTimer: number | null = null
let deleteTimer: number | null = null

onMounted(() => {
  void refresh()
  offChanged = window.aurora.automation.onChanged(() => void refresh())
})
onUnmounted(() => {
  offChanged?.()
  if (noticeTimer !== null) window.clearTimeout(noticeTimer)
  if (deleteTimer !== null) window.clearTimeout(deleteTimer)
})

/** 成功反馈自动退场（避免一条「已保存」长期挂在版面上；错误则留到下一次操作） */
function flash(message: string): void {
  notice.value = message
  if (noticeTimer !== null) window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    notice.value = null
    noticeTimer = null
  }, 3200)
}

async function refresh(): Promise<void> {
  loading.value = true
  error.value = null
  const listResult = await window.aurora.automation.list()
  if (listResult.ok) {
    userDefs.value = listResult.value.user
    builtinDefs.value = listResult.value.builtin
  } else {
    error.value = listResult.message
  }
  loading.value = false
}

// ───────────────────────── 图标 / 展示文案 ─────────────────────────

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/**
 * 条件 kind → 图标。**与主进程 catalog 的 7 类一一对应**：新增条件组件时
 * 这里与 `apps/desktop/src/main/automation/catalog.ts` 一起补（漏了会退到兜底图标，
 * 不会渲染失败，但会丢掉「一眼分辨」的价值）。
 */
const TRIGGER_ICONS: Record<string, Component> = {
  daily: CalendarClock,
  interval: Timer,
  'pre-class': BellRing,
  'class-start': CirclePlay,
  'pre-end': Hourglass,
  'class-end': CircleStop,
  'next-lesson': BookOpen,
}

const ACTION_ICONS: Record<string, Component> = {
  'system-notify': Bell,
  'classisland-remind': School,
  'open-folder': FolderOpen,
}

const MODE_ICONS: Record<'agent' | 'normal', Component> = { agent: Bot, normal: Zap }

function triggerIconOf(kind: string): Component {
  return TRIGGER_ICONS[kind] ?? Timer
}

function actionIconOf(kind: string): Component {
  return ACTION_ICONS[kind] ?? Bell
}

function describeTrigger(def: AutomationDefinition): string {
  const params = def.trigger.params ?? {}
  switch (def.trigger.kind) {
    case 'daily': {
      const weekdays = Array.isArray(params['weekdays']) ? (params['weekdays'] as number[]) : []
      const days =
        weekdays.length === 0 ? '每天' : weekdays.map((d) => WEEKDAYS[d] ?? String(d)).join('、')
      return `${days} ${String(params['at'] ?? '')}`
    }
    case 'interval':
      return `每 ${String(params['everyMinutes'] ?? '?')} 分钟`
    case 'pre-class':
      return `距上课 ≤ ${String(params['leadMinutes'] ?? '?')} 分钟`
    case 'pre-end':
      return `距下课 ≤ ${String(params['leadMinutes'] ?? '?')} 分钟`
    case 'next-lesson':
      return `下节课是「${String(params['subject'] ?? '')}」时`
    case 'class-start':
      return '上课时'
    case 'class-end':
      return '下课时'
    default:
      return def.trigger.kind
  }
}

/** 卡片上的操作摘要：只给「图标 + 短名」，点开编辑才看参数（版面只留看一眼够用的量） */
function actionChips(def: AutomationDefinition): { icon: Component; text: string }[] {
  return (def.actions ?? []).map((action) => {
    const params = action.params ?? {}
    const kind = action.kind
    if (kind === 'open-folder' && params['target'] !== 'path') {
      const subject = String(params['subject'] ?? '').trim()
      return {
        icon: actionIconOf(kind),
        text: subject === '' ? '打开科目文件夹' : `打开「${subject}」`,
      }
    }
    const labels: Record<string, string> = {
      'system-notify': '系统通知',
      'classisland-remind': 'ClassIsland 提醒',
      'open-folder': '打开文件夹',
    }
    return { icon: actionIconOf(kind), text: labels[kind] ?? kind }
  })
}

// ───────────────────────── 调用次数（v0.2.8，docs/13 §3.1） ─────────────────────────

/** 调用次数上限（0 = 不限；内置自动化恒为 0） */
function runLimitOf(def: AutomationDefinition): number {
  return def.maxRuns ?? 0
}

/** 已调用次数用尽（判据与主进程 catalog 的 `isRunsExhausted` 同口径） */
function runsExhaustedOf(def: AutomationDefinition): boolean {
  const limit = runLimitOf(def)
  return limit > 0 && (def.runCount ?? 0) >= limit
}

/** 列表卡片上的次数徽章文案（未设上限时返回空串 = 不渲染） */
function runCountLabel(def: AutomationDefinition): string {
  const limit = runLimitOf(def)
  if (limit <= 0) return ''
  return `${def.runCount ?? 0}/${limit}`
}

/** 次数徽章的悬浮说明 */
function runCountHint(def: AutomationDefinition): string {
  if (runsExhaustedOf(def)) return '调用次数已用尽，已自动停用；提高上限或重置计数后可再次启用'
  return `已调用 ${def.runCount ?? 0} / ${runLimitOf(def)} 次；用满后自动停用`
}

// ───────────────────────── 启停 / 运行 / 删除 ─────────────────────────

async function setEnabled(def: AutomationDefinition, enabled: boolean): Promise<void> {
  const payload = deepClone(def)
  payload.enabled = enabled
  const result = await window.aurora.automation.save(payload)
  if (!result.ok) {
    error.value = result.message
    return
  }
  // 打开一条已用尽的自动化不会立刻报错，但下一次触发会被引擎停回去 ——
  // 如实提示，而不是让用户以为"开了就能用"（docs/13 §3.1）
  if (enabled && runsExhaustedOf(def)) {
    flash('次数已用尽：请提高上限或重置计数')
    await refresh()
    return
  }
  await refresh()
}

/**
 * 内置自动化的启停 = 既有配置开关（docs/13 §6）：`settings:update` 必须回传**完整的**
 * `modes.classroom` 子树（settings:update 只做顶层浅合并，丢子树 = 静默丢字段）。
 */
const BUILTIN_SETTING_KEYS: Record<string, 'preClassReminder' | 'preClassOpenFolder'> = {
  'builtin.pre-class-notify': 'preClassReminder',
  'builtin.pre-class-open-folder': 'preClassOpenFolder',
}

async function setBuiltinEnabled(def: AutomationDefinition, enabled: boolean): Promise<void> {
  const key = BUILTIN_SETTING_KEYS[def.id]
  const modes = settingsStore.settings?.modes
  if (key === undefined || modes === undefined) return
  const ok = await settingsStore.update({
    modes: { ...modes, classroom: { ...modes.classroom, [key]: enabled } },
  })
  if (!ok) {
    error.value = settingsStore.error ?? '保存失败'
    return
  }
  flash('已保存')
  await refresh()
}

async function runOnce(def: AutomationDefinition): Promise<void> {
  const result = await window.aurora.automation.run({ id: def.id })
  if (!result.ok) {
    error.value = result.message
    return
  }
  flash('已触发一次，可在历史里查看结果')
}

async function openHistoryWindow(): Promise<void> {
  const result = await window.aurora.automation.openWindow({ view: 'history', mode: tab.value })
  if (!result.ok) error.value = result.message
}

async function openEditorWindow(def?: AutomationDefinition): Promise<void> {
  const result = await window.aurora.automation.openWindow({
    view: 'editor',
    mode: def?.mode ?? tab.value,
    ...(def === undefined ? {} : { automationId: def.id }),
  })
  if (!result.ok) error.value = result.message
}

async function removeDef(def: AutomationDefinition): Promise<void> {
  if (confirmingDelete.value !== def.id) {
    confirmingDelete.value = def.id
    if (deleteTimer !== null) window.clearTimeout(deleteTimer)
    deleteTimer = window.setTimeout(() => {
      if (confirmingDelete.value === def.id) confirmingDelete.value = null
      deleteTimer = null
    }, 3000)
    return
  }
  confirmingDelete.value = null
  const result = await window.aurora.automation.delete({ id: def.id })
  if (!result.ok) {
    error.value = result.message
    return
  }
  flash('已删除')
  await refresh()
}
</script>

<template>
  <section class="auto-page" data-field="automation.page">
    <header class="page-head">
      <Workflow :size="16" :stroke-width="1.7" aria-hidden="true" class="head-icon" />
      <h2 class="page-title">自动化</h2>
      <AppTooltip
        text="定时或满足课堂条件时自动执行：Agent Mode 触发后跑一次完整会话，Normal Mode 按预设操作执行。"
      >
        <button type="button" class="hint-dot" aria-label="自动化说明">
          <Info :size="13" :stroke-width="1.8" aria-hidden="true" />
        </button>
      </AppTooltip>

      <div class="tabs" role="tablist">
        <button
          type="button"
          class="tab press"
          data-field="automation.tab-agent"
          :class="{ active: tab === 'agent' }"
          role="tab"
          :aria-selected="tab === 'agent'"
          @click="tab = 'agent'"
        >
          <Bot :size="13" :stroke-width="1.7" aria-hidden="true" />
          Agent Mode
        </button>
        <button
          type="button"
          class="tab press"
          data-field="automation.tab-normal"
          :class="{ active: tab === 'normal' }"
          role="tab"
          :aria-selected="tab === 'normal'"
          @click="tab = 'normal'"
        >
          <Zap :size="13" :stroke-width="1.7" aria-hidden="true" />
          Normal Mode
        </button>
      </div>

      <div class="head-actions">
        <AppButton
          variant="secondary"
          size="sm"
          data-action="automation.history"
          @click="openHistoryWindow()"
        >
          <History :size="13" :stroke-width="1.7" aria-hidden="true" />
          历史
        </AppButton>
        <AppButton
          variant="primary"
          size="sm"
          data-action="automation.new"
          @click="openEditorWindow()"
        >
          <Plus :size="14" :stroke-width="1.9" aria-hidden="true" />
          新建
        </AppButton>
        <AppTooltip text="返回对话" placement="bottom">
          <button
            type="button"
            class="icon-btn press"
            data-action="automation-back"
            aria-label="返回对话"
            @click="emit('back')"
          >
            <ArrowLeft :size="15" :stroke-width="1.7" aria-hidden="true" />
          </button>
        </AppTooltip>
      </div>
    </header>

    <p v-if="error !== null" class="feedback error" role="alert">
      <TriangleAlert :size="13" :stroke-width="1.8" aria-hidden="true" />
      {{ error }}
    </p>
    <p v-if="notice !== null" class="feedback ok">
      <CircleCheck :size="13" :stroke-width="1.8" aria-hidden="true" />
      {{ notice }}
    </p>

    <div class="list" data-field="automation.list">
      <p v-if="loading && userDefs.length === 0" class="tiny muted empty-hint">加载中…</p>
      <div v-else-if="shownDefs.length === 0" class="empty-state">
        <component
          :is="tab === 'agent' ? Bot : Zap"
          :size="22"
          :stroke-width="1.4"
          aria-hidden="true"
          class="empty-icon"
        />
        <p class="tiny muted">
          {{
            tab === 'agent'
              ? '还没有 Agent Mode 自动化——触发后会由 Agent 执行一次完整任务。'
              : '还没有 Normal Mode 自动化——触发后按预设操作执行，快而确定。'
          }}
        </p>
      </div>

      <article
        v-for="def in shownDefs"
        :key="def.id"
        class="card interactive"
        :class="{ disabled: !def.enabled }"
        :data-field="'automation.item-' + def.id"
      >
        <label class="switch" :title="def.enabled ? '停用' : '启用'">
          <input
            type="checkbox"
            data-field="automation.toggle"
            :checked="def.enabled"
            @change="setEnabled(def, ($event.target as HTMLInputElement).checked)"
          />
          <span class="track" aria-hidden="true"><span class="thumb" /></span>
        </label>
        <div class="card-main">
          <div class="card-title-row">
            <strong class="card-title">{{ def.name }}</strong>
            <span class="mode-chip" :class="def.mode">
              <component
                :is="MODE_ICONS[def.mode]"
                :size="11"
                :stroke-width="1.8"
                aria-hidden="true"
              />
              {{ def.mode === 'agent' ? 'Agent' : 'Normal' }}
            </span>
            <!-- 调用次数（v0.2.8，docs/13 §3.1）：只在上限 > 0 时显示；用尽时整枚转警示色 -->
            <AppTooltip v-if="runCountLabel(def) !== ''" :text="runCountHint(def)">
              <span
                class="runs-chip"
                :class="{ exhausted: runsExhaustedOf(def) }"
                data-field="automation.runs"
              >
                <Repeat :size="11" :stroke-width="1.8" aria-hidden="true" />
                {{ runCountLabel(def) }}
              </span>
            </AppTooltip>
          </div>
          <div class="card-meta">
            <span class="meta-item">
              <component
                :is="triggerIconOf(def.trigger.kind)"
                :size="12"
                :stroke-width="1.7"
                aria-hidden="true"
              />
              {{ describeTrigger(def) }}
            </span>
            <span class="meta-sep" aria-hidden="true" />
            <span v-if="def.mode === 'agent'" class="meta-item clamp">
              <Sparkles :size="12" :stroke-width="1.7" aria-hidden="true" />
              {{ def.prompt }}
            </span>
            <span v-else class="meta-item wrap">
              <span v-for="(chip, index) in actionChips(def)" :key="index" class="act-chip">
                <component :is="chip.icon" :size="11" :stroke-width="1.7" aria-hidden="true" />
                {{ chip.text }}
              </span>
            </span>
          </div>
        </div>
        <div class="card-actions">
          <AppTooltip text="立即运行一次">
            <button
              type="button"
              class="icon-btn press"
              aria-label="立即运行一次"
              @click="runOnce(def)"
            >
              <Play :size="14" :stroke-width="1.7" aria-hidden="true" />
            </button>
          </AppTooltip>
          <AppTooltip text="编辑">
            <button
              type="button"
              class="icon-btn press"
              aria-label="编辑"
              @click="openEditorWindow(def)"
            >
              <Pencil :size="14" :stroke-width="1.7" aria-hidden="true" />
            </button>
          </AppTooltip>
          <AppTooltip :text="confirmingDelete === def.id ? '再点一次确认删除' : '删除'">
            <button
              type="button"
              class="icon-btn press danger"
              :class="{ confirming: confirmingDelete === def.id }"
              data-action="automation.delete"
              :aria-label="confirmingDelete === def.id ? '再点一次确认删除' : '删除'"
              @click="removeDef(def)"
            >
              <Trash2 :size="14" :stroke-width="1.7" aria-hidden="true" />
            </button>
          </AppTooltip>
        </div>
      </article>

      <!-- 内置区：仅 Normal tab；启停映射 ClassRoom 既有配置（docs/13 §6） -->
      <section v-if="tab === 'normal'" class="builtin" data-field="automation.builtin">
        <div class="section-head">
          <School :size="13" :stroke-width="1.7" aria-hidden="true" />
          <span>内置</span>
          <AppTooltip
            text="沿用 ClassRoom 的设置（提前分钟数 / 勿扰时段），在「设置 → 模式」里调整。"
          >
            <button type="button" class="hint-dot" aria-label="内置自动化的说明">
              <Info :size="12" :stroke-width="1.8" aria-hidden="true" />
            </button>
          </AppTooltip>
        </div>
        <article
          v-for="def in builtinShown"
          :key="def.id"
          class="card"
          :class="{ disabled: !def.enabled }"
        >
          <label class="switch" :title="def.enabled ? '停用' : '启用'">
            <input
              type="checkbox"
              data-field="automation.builtin-toggle"
              :checked="def.enabled"
              @change="setBuiltinEnabled(def, ($event.target as HTMLInputElement).checked)"
            />
            <span class="track" aria-hidden="true"><span class="thumb" /></span>
          </label>
          <div class="card-main">
            <div class="card-title-row">
              <strong class="card-title">{{ def.name }}</strong>
              <span class="mode-chip locked">内置</span>
            </div>
            <div class="card-meta">
              <span class="meta-item">
                <component
                  :is="triggerIconOf(def.trigger.kind)"
                  :size="12"
                  :stroke-width="1.7"
                  aria-hidden="true"
                />
                {{ describeTrigger(def) }}
              </span>
              <span class="meta-sep" aria-hidden="true" />
              <span class="meta-item wrap">
                <span v-for="(chip, index) in actionChips(def)" :key="index" class="act-chip">
                  <component :is="chip.icon" :size="11" :stroke-width="1.7" aria-hidden="true" />
                  {{ chip.text }}
                </span>
              </span>
            </div>
          </div>
        </article>
      </section>
    </div>
  </section>
</template>

<style scoped>
.auto-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  height: 100%;
  min-height: 0;
  padding: var(--space-4);
  overflow-y: auto;
}

/* 页头：标题 + tab + 右侧动作**一行**（放不下时整体折行，任何窗口宽度都不溢出/重叠） */
.page-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-secondary);
}

.head-icon {
  flex: 0 0 auto;
}

.page-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-display);
  color: var(--text-primary);
}

/* 「说明」标记：文案离开版面后，靠它把解释留在手边 */
.hint-dot {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  color: var(--text-muted);
  transition:
    color var(--transition-fast),
    background var(--transition-fast);
}

.hint-dot:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.head-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  /* 折行后仍贴右（比放一个 flex 撑开的空元素更稳：空元素自己也会占一行） */
  margin-left: auto;
}

.tabs {
  display: inline-flex;
  padding: 2px;
  border-radius: var(--radius-md);
  background: var(--fill-2);
  gap: 2px;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.tab.active {
  background: var(--bg-raised);
  color: var(--text-primary);
  box-shadow: var(--shadow-hairline);
}

.grow {
  flex: 1;
}

.feedback {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: 0;
  padding: 6px var(--space-3);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
}

.feedback.error {
  background: var(--error-fill);
  color: var(--error-text);
}

.feedback.ok {
  background: var(--ok-fill);
  color: var(--ok-text);
}

.list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.empty-hint {
  padding: var(--space-4);
  text-align: center;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-6) var(--space-4);
  text-align: center;
}

.empty-state p {
  margin: 0;
  max-width: 380px;
}

.empty-icon {
  color: var(--text-muted);
  opacity: 0.7;
}

.card {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--fill-1);
  border: 1px solid var(--border-subtle);
  transition: opacity var(--transition-fast);
}

.card.disabled {
  opacity: 0.62;
}

/* 悬停时把边界提亮一档（`.interactive` 负责上浮与阴影），一眼知道这张卡可操作 */
.card:hover {
  border-color: var(--border-strong);
}

.card-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.card-title-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.card-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-base);
}

.mode-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: 0 0 auto;
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  font-size: var(--text-xs);
  line-height: 15px;
  background: var(--fill-3);
  color: var(--text-muted);
}

.mode-chip.agent {
  background: color-mix(in srgb, var(--aurora-blue) 16%, transparent);
  color: var(--accent-text);
}

.mode-chip.locked {
  background: var(--fill-2);
}

/* 调用次数徽章（与模式徽章同形，用尽时转警示色） */
.runs-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: 0 0 auto;
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  font-size: var(--text-xs);
  line-height: 15px;
  background: var(--fill-2);
  color: var(--text-muted);
}

.runs-chip.exhausted {
  background: var(--danger-fill);
  color: var(--danger-text);
}

/* 元信息行：条件 + 分隔点 + 摘要（摘要过长时截断，绝不撑破卡片） */
.card-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px var(--space-2);
  min-width: 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

.meta-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.meta-item.clamp {
  flex: 1 1 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta-item.wrap {
  flex-wrap: wrap;
  gap: 4px;
}

.meta-sep {
  flex: 0 0 auto;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--text-muted);
  opacity: 0.6;
}

/* 操作摘要胶囊：一屏看清「这条自动化会做什么」，不用读整句 */
.act-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  background: var(--fill-2);
  color: var(--text-secondary);
  line-height: 15px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}

.icon-btn {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-xs);
  color: var(--text-muted);
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.icon-btn:hover {
  background: var(--fill-3);
  color: var(--text-primary);
}

.icon-btn.danger:hover,
.icon-btn.danger.confirming {
  color: var(--status-error);
}

/* 两段式删除的中间态：边框一圈红，配合悬浮提示说清「再点一次」 */
.icon-btn.confirming {
  box-shadow: inset 0 0 0 1px var(--danger-border);
  background: var(--danger-fill);
}

.builtin {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}

/* 区组头（内置 / 弹窗内的「触发条件」「任务指令」共用）：图标 + 标题 + 说明标记 */
.section-head {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}

/* ── 开关（与设置页 checkbox 口径一致的迷你 switch） ── */
.switch {
  position: relative;
  display: inline-flex;
  flex: 0 0 auto;
  cursor: pointer;
}

.switch input {
  position: absolute;
  opacity: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  cursor: pointer;
}

.switch .track {
  display: inline-flex;
  align-items: center;
  width: 30px;
  height: 18px;
  padding: 2px;
  border-radius: var(--radius-pill);
  background: var(--fill-3);
  transition: background var(--transition-fast);
}

.switch .thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--bg-raised);
  box-shadow: var(--shadow-hairline);
  transition: transform var(--transition-fast);
}

.switch input:checked + .track {
  background: var(--aurora-blue);
}

.switch input:checked + .track .thumb {
  transform: translateX(12px);
}

.switch input:focus-visible + .track {
  outline: 2px solid var(--aurora-blue);
  outline-offset: 2px;
}

/* ── 弹窗（遮罩 + --z-popover；底色必须用弹层专用令牌 --bg-overlay） ── */
.modal-scrim {
  position: fixed;
  inset: 0;
  z-index: var(--z-popover);
  display: grid;
  place-items: center;
  background: var(--overlay-scrim);
}

.modal {
  display: flex;
  flex-direction: column;
  width: min(640px, calc(100vw - 48px));
  max-height: min(660px, calc(100vh - 56px));
  border-radius: var(--radius-lg);
  /* 弹层专用底色令牌（`--surface-1` 不存在 —— 用了它弹窗会透明、页面内容透进来） */
  background: var(--glass-panel);
  border: 1px solid var(--glass-border);
  box-shadow: var(--shadow-2);
  animation: aurora-pop-in var(--dur-base) var(--ease-spring) both;
}

.modal-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-secondary);
}

.modal-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

.modal-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border-subtle);
}

/* ── 表单：左标签 / 右控件（标签列定宽，两侧都在自己的格子里） ── */
.field-row {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.field-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
}

/* 调用次数一行：窄输入 + 说明 +（编辑既有定义时）重置按钮。
   宽度写在 `.runs-row .input` 里（两级选择器）：`.input` 的 `width: 100%` 定义在本段之后，
   只写 `.runs-input` 会被它按源码顺序压过去 —— 症状是输入框占满整行、说明被挤成一列竖排字。 */
.runs-row {
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
  flex: 1 1 auto;
  min-width: 0;
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
  font-size: var(--text-sm);
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast);
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

/* 区组：条件 / 执行两大块，块之间用细分隔线（不靠堆文字制造层级） */
.section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}

.section-note {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}

.param-grid {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.step-count {
  font-variant-numeric: var(--num-tabular);
}

/* 条件磁贴：图标在上、文字在下；选中态用强调色边界 + 淡填充 */
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
  height: 100%;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
  background: var(--fill-1);
  color: var(--text-secondary);
  text-align: left;
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast),
    color var(--transition-fast);
}

/* 磁贴外层的提示锚点：撑满网格格，磁贴本体才能等高 */
.tile-grid > .tip-host {
  display: flex;
}

.tile:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.tile.active {
  border-color: var(--aurora-blue);
  background: color-mix(in srgb, var(--aurora-blue) 10%, transparent);
  color: var(--text-primary);
}

.tile-label {
  font-size: var(--text-xs);
  line-height: 1.35;
  overflow-wrap: anywhere;
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
  transition:
    border-color var(--transition-fast),
    background var(--transition-fast);
}

.mode-option:hover {
  background: var(--fill-2);
}

.mode-option.active {
  border-color: var(--aurora-blue);
  background: color-mix(in srgb, var(--aurora-blue) 8%, transparent);
}

.mode-head {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--text-primary);
}

/* 操作行：序号 + 组件胶囊 + 参数网格，一行一块的视觉分组 */
.action-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--fill-1);
  border: 1px solid var(--border-subtle);
}

.action-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
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
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
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
  line-height: 1.4;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);
}

.chip:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.chip.active {
  border-color: var(--aurora-blue);
  background: color-mix(in srgb, var(--aurora-blue) 16%, transparent);
  color: var(--text-primary);
}

</style>
