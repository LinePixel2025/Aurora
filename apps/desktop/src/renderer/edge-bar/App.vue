<script setup lang="ts">
/**
 * 右侧提示条（docs/07 §2.2）：贴屏幕右缘的 8px 竖条 + 悬停展开的全高面板。
 *
 * 行为契约（step-02 落地，本步只换外观与动效，事件绑定与 IPC 调用保持不变）：
 * - 悬停 → 主进程把窗口加宽到 228px（`window:setEdgeBarExpanded`），面板从右滑入；
 *   移开鼠标 → 面板淡出后再把窗口收回 8px（否则屏幕右侧会留一块看不见却挡鼠标的区域）；
 * - 点击竖条 → 呼出主界面（`window:showChat`，chat 窗即主界面）；展开态下竖条仍贴着屏幕右缘，
 *   仍是有效点击目标；
 * - 面板内容：AI 状态 → 当前模式 → **快速对话**（输入框直接在面板里与 Aurora 对话，
 *   2026-09 起取代只读的「最近消息」）→ 今日课程（仅 ClassRoom 模式）→ 系统状态，
 *   底部是三个操作入口。Work 等非 ClassRoom 模式下课堂卡不渲染，面板自然更矮；
 *   对话数据仍是快速会话（`sessionId = 'quick'`，独立 useChat 实例）。
 *   窗口创建时 `focusable: false`（悬停不抢焦点），**展开时主进程临时 setFocusable(true)**——
 *   否则输入框拿不到键盘焦点；收起时交还并失焦（见 window-manager）。
 *
 * 几何预算（不要突破）：展开窗口 228px = 竖条 8px + 面板 220px。
 * 面板宽度写死 220px，任何内部布局都在这个宽度内成立，否则会被窗口裁切。
 *
 * 拖动：**刻意不提供**。本窗 `focusable: false`，位置与尺寸完全由主进程按「工作区右缘 +
 * 垂直居中 + 当前折叠态」推导（`window-manager.ts` 的 `edge` 分支），不参与用户拖动，
 * 因此模板里不挂 `drag-region`（不在 `useWindowDrag` 的清单里，docs/07 §2.2）。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import AppButton from '../shared/components/AppButton.vue'
import StatusDot from '../shared/components/StatusDot.vue'
import { useChat } from '../shared/composables/useChat.js'
import {
  useModeStore,
  usePerceptionStore,
  useSettingsStore,
  useWindowStore,
} from '../shared/stores.js'

/** 悬停多久才展开：太短会被鼠标划过边缘误触发，太长显得迟钝 */
const EXPAND_DELAY_MS = 120
/** 移开多久才收起：给用户从竖条移到面板的容错时间 */
const COLLAPSE_DELAY_MS = 220
/** 面板退出动画时长，与 theme.css 的 --dur-base 对齐；收窗口必须晚于它，否则面板被裁掉 */
const PANEL_EXIT_MS = 250
const windowStore = useWindowStore()
const settingsStore = useSettingsStore()
const modeStore = useModeStore()
const perception = usePerceptionStore()
const chat = useChat('edge-bar', 'quick')
const { statusTone } = chat

const expanded = ref(false)
/** 鼠标是否在提示条窗口内（leave 触发后若输入框仍持有焦点，收起要等失焦再补） */
const mouseInside = ref(false)
/** 快速对话输入框是否持有焦点：聚焦期间移开鼠标**不收起面板**（正在打字） */
const quickFocused = ref(false)
let expandTimer: ReturnType<typeof setTimeout> | undefined
let collapseTimer: ReturnType<typeof setTimeout> | undefined
let shrinkTimer: ReturnType<typeof setTimeout> | undefined

function clearTimers(): void {
  clearTimeout(expandTimer)
  clearTimeout(collapseTimer)
  clearTimeout(shrinkTimer)
  expandTimer = undefined
  collapseTimer = undefined
  shrinkTimer = undefined
}

/**
 * 悬停进入：窗口先加宽，面板后出现 —— 反过来的话面板会先被 8px 窗口裁掉再跳出来。
 *
 * **不做 `if (expanded.value) return` 早退**：主进程可能在我们不知情时把提示条隐藏
 * （勿扰时段的 `EdgeBarScheduler`、设置页的「立即显隐」），窗口已被收回 8px 而渲染层的
 * `expanded` 仍是 true；早退会让面板渲染在 8px 窗口里被裁掉且无法自愈。
 * `setEdgeBarExpanded` 在主进程是幂等的，无条件调用即是最省事的自愈路径。
 */
function onPointerEnter(): void {
  mouseInside.value = true
  clearTimeout(collapseTimer)
  clearTimeout(shrinkTimer)
  collapseTimer = undefined
  shrinkTimer = undefined
  expandTimer = setTimeout(() => {
    expandTimer = undefined
    void (async () => {
      await windowStore.setEdgeBarExpanded(true)
      expanded.value = true
    })()
  }, EXPAND_DELAY_MS)
}

/** 收起链：面板先淡出，动画结束后再把窗口收回竖条（enter / leave / 失焦三条路径共用） */
function scheduleCollapse(): void {
  clearTimeout(expandTimer)
  expandTimer = undefined
  clearTimeout(collapseTimer)
  collapseTimer = setTimeout(() => {
    collapseTimer = undefined
    expanded.value = false
    clearTimeout(shrinkTimer)
    shrinkTimer = setTimeout(() => {
      shrinkTimer = undefined
      void windowStore.setEdgeBarExpanded(false)
    }, PANEL_EXIT_MS)
  }, COLLAPSE_DELAY_MS)
}

/** 移开鼠标：正在快速对话输入框里打字时不收起，等失焦再补收 */
function onPointerLeave(): void {
  mouseInside.value = false
  if (quickFocused.value) return
  scheduleCollapse()
}

/** 输入框失焦而鼠标早已离开窗口：补走一次收起，否则面板会悬在屏幕外等待不到离开事件 */
watch(quickFocused, (focused) => {
  if (focused || mouseInside.value || !expanded.value) return
  scheduleCollapse()
})

/** 面板内的操作：立即收起（用户已经明确做了选择，不需要动画缓冲） */
function collapseNow(): void {
  clearTimers()
  // 显式复位输入框聚焦态：收起守卫（onPointerLeave 的 quickFocused 分支）不能依赖
  // 「收起前 blur 必然先发生」这个隐含时序，否则残留 true 会让面板悬停不收
  quickFocused.value = false
  expanded.value = false
  void windowStore.setEdgeBarExpanded(false)
}

const statusLabel = computed(() =>
  statusTone.value === 'error'
    ? '异常'
    : statusTone.value === 'running'
      ? '思考中'
      : statusTone.value === 'unread'
        ? '有未读'
        : '闲置',
)

/** 快速对话输入内容（发送后清空） */
const quickInput = ref('')
/** 消息滚动容器（新内容贴底） */
const quickListEl = ref<HTMLElement | null>(null)

/**
 * 快速对话的消息（正序，最近 20 条）：220px 面板装不下长历史，
 * 更早的对话在主界面左栏点「快速对话」看全量。
 */
const quickMessages = computed(() =>
  chat.messages.value.filter((message) => message.content.trim() !== '').slice(-20),
)

/** 新消息 / 流式增量贴底：迷你视图不做「用户接管」复杂度 */
const quickTail = computed(() => {
  const last = quickMessages.value.at(-1)
  return `${quickMessages.value.length}:${last?.content.length ?? 0}`
})

watch(quickTail, () => {
  void scrollToQuickBottom()
})

async function scrollToQuickBottom(): Promise<void> {
  await nextTick()
  const el = quickListEl.value
  if (el !== null) el.scrollTop = el.scrollHeight
}

/** 快速会话自动刷新间隔（docs/07 §2.2）：面板展开期间每 5 分钟重拉一次 */
const QUICK_REFRESH_INTERVAL_MS = 5 * 60_000
let quickRefreshTimer: ReturnType<typeof setInterval> | undefined

/**
 * 展开态强制重拉快速会话（最近 20 条）并贴底（docs/07 §2.2）：
 * 窗口常驻，只在挂载时水合一次的话，主界面 / 其它窗口发出的新消息永远进不来。
 * 守卫：仅展开中且非流式时执行 —— 流式重拉会把正在输出的回复搅乱。
 */
function refreshQuickSession(): void {
  if (!expanded.value || chat.streaming.value) return
  void chat.hydrate({ force: true, limit: 20 }).then(() => scrollToQuickBottom())
}

watch(expanded, (isOpen) => {
  // 收起：停掉自动刷新，避免后台空转
  if (!isOpen) {
    clearInterval(quickRefreshTimer)
    quickRefreshTimer = undefined
    return
  }
  if (!chat.streaming.value)
    void chat.hydrate({ force: true, limit: 20 }).then(() => scrollToQuickBottom())
  clearInterval(quickRefreshTimer)
  quickRefreshTimer = setInterval(refreshQuickSession, QUICK_REFRESH_INTERVAL_MS)
})

/** 面板里发送快速对话：同一 `quick` 会话，主界面左栏固定项点开即见全量 */
async function sendQuick(): Promise<void> {
  const text = quickInput.value.trim()
  if (text === '' || chat.streaming.value) return
  quickInput.value = ''
  await chat.send(text)
}

const modelLabel = computed(() => settingsStore.activeProvider?.model ?? '未配置模型')

/** 模式提示：未完成引导 / 未就绪时给一句话，正常时为空串（不占版面） */
const modeHint = computed(() => {
  const current = modeStore.current
  if (!current) return '尚未激活任何模式'
  if (!current.guideCompleted) return '引导未完成：点「打开主界面」继续'
  if (!current.ready) return current.readinessHint ?? ''
  return ''
})

const isClassroom = computed(() => modeStore.current?.id === 'classroom')
const classroom = computed(() => settingsStore.settings?.modes.classroom ?? null)
const subjectCount = computed(() => classroom.value?.subjects.length ?? 0)
const watchDir = computed(() => {
  const dir = classroom.value?.watchDir ?? ''
  if (dir === '') return '未设置'
  const segments = dir.split(/[\\/]/).filter((part) => part !== '')
  return segments[segments.length - 1] ?? dir
})

const lessons = computed(() => perception.summary?.lessons ?? [])

/** 系统状态：逐项成行（值缺失的采集项直接不出现，不做假数据） */
const statusRows = computed<Array<{ label: string; value: string }>>(() => {
  const summary = perception.summary
  if (!summary) return []
  const rows: Array<{ label: string; value: string }> = [
    { label: '时间', value: `${summary.localTime} ${summary.weekday}` },
  ]
  if (summary.battery) {
    rows.push({
      label: '电源',
      value: summary.battery.hasBattery
        ? `${summary.battery.percent}%${summary.battery.isCharging ? ' · 充电中' : ''}`
        : '已接通交流电',
    })
  }
  if (summary.network) {
    const type =
      summary.network.type === '' || summary.network.type === '未知' ? '' : summary.network.type
    rows.push({
      label: '网络',
      value: summary.network.online ? `在线${type === '' ? '' : ` · ${type}`}` : '离线',
    })
  }
  if (summary.foreground) {
    rows.push({ label: '前台', value: summary.foreground.title || summary.foreground.app })
  }
  if (summary.display) {
    rows.push({
      label: '显示器',
      value: `${summary.display.width}×${summary.display.height} · ${summary.display.count} 屏`,
    })
  }
  return rows
})

async function openChat(): Promise<void> {
  collapseNow()
  await windowStore.showChat()
}

async function openSettings(): Promise<void> {
  collapseNow()
  await windowStore.show('settings')
}

async function hideSelf(): Promise<void> {
  collapseNow()
  await windowStore.hide('edge-bar')
}

// 面板的「最近消息」要真有内容：挂载时按快速会话水合一次（只读；不改变提示条自身状态）
onMounted(() => {
  void chat.hydrate()
})

onUnmounted(() => {
  clearTimers()
  clearInterval(quickRefreshTimer)
})
</script>

<template>
  <div class="edge" :class="{ expanded }" @mouseenter="onPointerEnter" @mouseleave="onPointerLeave">
    <button class="strip" type="button" title="打开 Aurora 主界面" @click="openChat">
      <span class="strip-dot">
        <StatusDot :tone="statusTone" :size="6" :title="statusLabel" />
      </span>
      <span class="strip-label">AURORA</span>
    </button>

    <transition name="sheet">
      <aside v-if="expanded" class="panel glass">
        <div class="panel-scroll">
          <!-- ① AI 状态 -->
          <section class="card anim-rise">
            <div class="row">
              <StatusDot :tone="statusTone" :title="statusLabel" />
              <strong class="status-text">{{ statusLabel }}</strong>
              <span class="grow" />
              <span class="meta">{{ settingsStore.appInfo?.appVersion ?? '' }}</span>
            </div>
            <p class="meta">模型 · {{ modelLabel }}</p>
          </section>

          <!-- ② 当前模式 -->
          <section class="card anim-rise" style="animation-delay: 30ms">
            <p class="card-title">当前模式</p>
            <strong class="mode-name">{{ modeStore.current?.displayName ?? '未激活' }}</strong>
            <p v-if="modeHint !== ''" class="warn">{{ modeHint }}</p>
            <div v-if="isClassroom" class="key-value">
              <span class="meta">感知文件夹</span>
              <span class="value">{{ watchDir }}</span>
            </div>
            <div v-if="isClassroom" class="key-value">
              <span class="meta">科目</span>
              <span class="value">{{ subjectCount }} 个</span>
            </div>
          </section>

          <!--
            ③ 快速对话（2026-09 取代只读的「最近消息」）：输入框直接在面板里与 Aurora 对话。
            撑满中部（flex 吸收剩余高度），消息列表内部滚动、新内容贴底；
            输入框聚焦期间移开鼠标不收起（见 onPointerLeave / quickFocused 守卫）。
          -->
          <section class="card recent-card anim-rise" style="animation-delay: 60ms">
            <div class="card-head">
              <p class="card-title">快速对话</p>
              <span v-if="quickMessages.length > 0" class="badge">{{ quickMessages.length }}</span>
            </div>
            <div ref="quickListEl" class="qc-list">
              <p v-if="quickMessages.length === 0 && !chat.streaming.value" class="empty">
                直接输入，与 Aurora 快速对话
              </p>
              <div
                v-for="message in quickMessages"
                :key="message.id"
                class="qc-msg"
                :class="`r-${message.role}`"
              >
                <p class="qc-text">{{ message.content.replace(/\s+/g, ' ').trim() }}</p>
              </div>
              <span v-if="chat.streaming.value" class="qc-typing"><i /><i /><i /></span>
            </div>
            <p v-if="chat.error.value !== null" class="qc-error">{{ chat.error.value }}</p>
            <div class="qc-composer">
              <input
                v-model="quickInput"
                type="text"
                placeholder="快速提问…"
                aria-label="快速对话输入"
                @keydown.enter.prevent="sendQuick"
                @focus="quickFocused = true"
                @blur="quickFocused = false"
              />
              <button
                v-if="chat.streaming.value"
                type="button"
                class="qc-send stop press"
                title="停止"
                aria-label="停止回复"
                @click="chat.abort()"
              >
                <svg viewBox="0 0 12 12" aria-hidden="true">
                  <rect x="2.5" y="2.5" width="7" height="7" rx="1.4" />
                </svg>
              </button>
              <button
                v-else
                type="button"
                class="qc-send press"
                data-action="edge-bar.quick-send"
                :disabled="quickInput.trim() === ''"
                title="发送（Enter）"
                aria-label="发送快速对话"
                @click="sendQuick"
              >
                <svg viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M6 10V2.2M6 2.2 2.8 5.4M6 2.2l3.2 3.2" />
                </svg>
              </button>
            </div>
          </section>

          <!-- ④ 今日课程（仅 ClassRoom 模式） -->
          <section v-if="isClassroom" class="card anim-rise" style="animation-delay: 90ms">
            <div class="card-head">
              <p class="card-title">今日课程</p>
              <span v-if="lessons.length > 0" class="badge">{{ lessons.length }}</span>
            </div>
            <ul v-if="lessons.length > 0" class="lesson-list">
              <li v-for="(lesson, index) in lessons" :key="`${lesson.startTime}-${index}`">
                <span class="lesson-time">{{ lesson.startTime }}</span>
                <span class="lesson-subject">{{ lesson.subject }}</span>
              </li>
            </ul>
            <p v-else class="empty">今天没有更多课程</p>
          </section>

          <!-- ⑤ 系统状态 -->
          <section
            class="card anim-rise"
            :style="{ animationDelay: isClassroom ? '120ms' : '90ms' }"
          >
            <p class="card-title">系统状态</p>
            <dl v-if="statusRows.length > 0" class="status-list">
              <div v-for="row in statusRows" :key="row.label" class="status-row">
                <dt>{{ row.label }}</dt>
                <dd>{{ row.value }}</dd>
              </div>
            </dl>
            <p v-else class="empty">感知数据尚未就绪</p>
          </section>
        </div>

        <!-- 操作区：3 个入口，主入口用 primary（capture 面板探针按 `.actions button` 做命中测试） -->
        <section class="actions">
          <AppButton variant="primary" size="sm" block class="press" @click="openChat">
            <svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M3 3.5h10a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H7.6L4.6 13v-2.5H3a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Z"
              />
            </svg>
            打开主界面
          </AppButton>
          <AppButton variant="ghost" size="sm" block class="press" @click="openSettings">
            <svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="2.2" />
              <path
                d="M8 1.8v1.5M8 12.7v1.5M1.8 8h1.5M12.7 8h1.5M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1"
              />
            </svg>
            设置
          </AppButton>
          <AppButton variant="ghost" size="sm" block class="press" @click="hideSelf">
            <svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M6 3.5 10.5 8 6 12.5" />
            </svg>
            隐藏提示条
          </AppButton>
        </section>
      </aside>
    </transition>
  </div>
</template>

<style scoped>
.edge {
  position: relative;
  height: 100vh;
  display: flex;
  justify-content: flex-end;
  align-items: stretch;
  /* 窗口宽度就是内容宽度（收起 8 / 展开 228）；保留 hidden 兜住圆角与滑入动画的溢出 */
  overflow: hidden;
}

/* ───────── 收起态竖条（8px，贴屏幕右缘；展开态下仍可见、仍可点） ───────── */

.strip {
  position: relative;
  flex: 0 0 auto;
  width: 8px;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  background: var(--aurora-gradient);
  border-radius: 6px 0 0 6px;
  box-shadow: var(--shadow-1);
  /* 常驻元素：静置时压暗一点，别在桌面右缘挂着一条刺眼的亮条 */
  filter: brightness(0.82);
  transition:
    width var(--dur-fast) var(--ease-spring),
    filter var(--transition-fast);
}

.strip:hover {
  /* 可交互提示：加亮 + 微增宽（--ease-spring 让增长带一点弹性） */
  width: 10px;
  filter: brightness(1.12);
}

/* 状态点外面套一圈深色底座，否则在极光渐变上看不清 */
.strip-dot {
  display: grid;
  place-items: center;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--bg-overlay);
  box-shadow: var(--shadow-1);
}

.strip-label {
  writing-mode: vertical-rl;
  font-size: 8px;
  font-weight: var(--weight-semibold);
  letter-spacing: 2px;
  /* 极光渐变上的文字在明暗两档都使用专用深色前景。 */
  color: var(--on-accent);
}

/* ───────── 展开面板（220px 预算） ───────── */

.panel {
  position: absolute;
  top: 0;
  bottom: 0;
  /* 右缘留出 8px 竖条，面板正好占满 228 - 8 = 220px；再宽会被窗口裁切 */
  right: 8px;
  width: 220px;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-lg) 0 0 var(--radius-lg);
  box-shadow: var(--shadow-3);
  overflow: hidden;
}

/* 品牌识别元素：面板顶部 1px 极光高光（只此一处，不满屏渐变） */
.panel::before {
  content: '';
  position: absolute;
  top: 0;
  left: var(--space-3);
  right: var(--space-3);
  height: 1px;
  background: var(--aurora-gradient);
  opacity: 0.8;
}

.panel-scroll {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  overflow-y: auto;
  overflow-x: hidden;
}

.panel-scroll::-webkit-scrollbar,
.qc-list::-webkit-scrollbar {
  width: 6px;
}

/* 分组卡片：全面板统一用 --fill-1 卡片分组，不用分隔线（二选一，不混用） */
.card {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--fill-1);
}

.card-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.card-title {
  margin: 0;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  letter-spacing: var(--tracking-eyebrow);
  text-transform: uppercase;
  color: var(--text-muted);
}

/* 卡片内的计数徽标要浮在卡片底色之上，否则和 --fill-1 同色看不见 */
.card .badge {
  background: var(--fill-2);
  font-variant-numeric: var(--num-tabular);
}

.status-text {
  font-weight: var(--weight-medium);
}

.meta {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.mode-name {
  font-weight: var(--weight-medium);
}

.warn {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--status-unread);
}

.key-value {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}

.key-value .value {
  flex: 1;
  min-width: 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  text-align: right;
  font-variant-numeric: var(--num-tabular);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 快速对话卡吸收面板剩余高度，让全高面板看起来是刻意排版而不是留白 */
.recent-card {
  flex: 1 1 auto;
  min-height: 132px;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* 空态在吸收来的高度里居中，避免出现「卡片很高、文字贴在顶上」 */
.recent-card > .empty {
  margin: auto 0;
  text-align: center;
}

/* 消息列表：占满卡片剩余高度，内部滚动、新内容贴底 */
.qc-list {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  overflow-y: auto;
  padding-right: 2px;
}

.qc-msg {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.qc-msg.r-user {
  align-items: flex-end;
}

/* 气泡：用户强调色浅填充右对齐，助手分层填充左对齐（与主界面 QuickChat 同一套语义） */
.qc-text {
  margin: 0;
  max-width: 94%;
  padding: 4px 9px;
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.r-user .qc-text {
  background: color-mix(in srgb, var(--aurora-blue) 20%, transparent);
}

.r-assistant .qc-text {
  background: var(--fill-1);
}

.qc-typing {
  display: inline-flex;
  gap: 4px;
  padding: 2px 2px 0;
}

.qc-typing i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--aurora-blue);
  animation: qc-bounce 1s infinite ease-in-out;
}

.qc-typing i:nth-child(2) {
  animation-delay: 0.15s;
}

.qc-typing i:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes qc-bounce {
  0%,
  100% {
    opacity: 0.35;
    transform: translateY(0);
  }
  50% {
    opacity: 1;
    transform: translateY(-2px);
  }
}

.qc-error {
  margin: 0;
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
  color: var(--error-text);
  overflow-wrap: anywhere;
}

/* 输入行：紧凑输入框 + 圆形发送 / 停止钮（面板宽只有 220px，控件必须收窄） */
.qc-composer {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.qc-composer input {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-pill);
  background: var(--fill-1);
  font-size: var(--text-sm);
  color: var(--text-primary);
  outline: none;
  transition: border-color var(--transition-fast);
}

.qc-composer input:focus {
  border-color: var(--aurora-blue);
}

.qc-composer input::placeholder {
  color: var(--text-muted);
}

.qc-send {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-pill);
  background: var(--aurora-gradient);
  color: var(--on-accent);
  transition:
    opacity var(--transition-fast),
    background var(--transition-fast);
}

.qc-send:disabled {
  opacity: 0.45;
  cursor: default;
}

.qc-send svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* 停止态：中性填充 + 方块图标（停止不是主动作，不抢强调色） */
.qc-send.stop {
  background: var(--fill-3);
  color: var(--text-primary);
}

.lesson-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.lesson-list li {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--text-sm);
}

.lesson-time {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-variant-numeric: var(--num-tabular);
}

.lesson-subject {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
}

.status-row {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.status-row dt {
  flex: 0 0 auto;
  color: var(--text-muted);
}

.status-row dd {
  flex: 1;
  min-width: 0;
  margin: 0;
  text-align: right;
  font-variant-numeric: var(--num-tabular);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-muted);
}

/* 操作区：同样用 --fill-1 卡片分组，主入口（打开主界面）用 primary 变体 */
.actions {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-1);
  border-radius: var(--radius-md);
  background: var(--fill-1);
}

/* 整行左对齐（覆盖 AppButton 的居中；选择器带上 .block 保证优先级高于子组件） */
.actions :deep(.aurora-button.block) {
  justify-content: flex-start;
  padding-inline: var(--space-3);
}

/* ghost 悬停改用 --fill-2：比默认的 --fill-1 更明确一点 */
.actions :deep(.aurora-button.v-ghost.block):hover:not(:disabled) {
  background: var(--fill-2);
  color: var(--text-primary);
}

.icon {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
