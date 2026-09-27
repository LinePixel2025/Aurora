<script setup lang="ts">
/**
 * 主界面右栏（BetaV2，Design/betav2-spec.md §3）：模式感知的上下文栏。
 *
 * - 通用（顶部）：任务清单卡（当前会话最后一次 todo_write 的结构化清单，App 传入；
 *   无清单时整卡不渲染）；
 * - classroom：当前/下节课卡（ClassIsland 桥接 status，非 classisland provider 时隐藏）、
 *   今日课程卡（perception lessons）、分类流水（ClassificationLedger 紧凑版）、打开感知文件夹；
 * - work：工作目录卡（workspaceDir + 打开 / 前往设置）、办公能力提示卡；
 * - 通用：当前项目卡（v13，docs/06 §5.1；无当前项目时不渲染）、文件备份卡
 *   （v14，docs/06 §11.8；空态也渲染，否则用户不知道有这个能力）、系统状态卡
 *   （时间 / 电量 / 网络 / 前台应用）。
 * 非当前模式的功能**一律不渲染**（不是 disabled）。
 *
 * 感知数据由本组件自取（chat 窗引导未开 trackPerception）：挂载时刷新 + 30s 轮询，
 * 组件卸载即停；`window.aurora` 的 Result 一律降级为空态文案，不抛错。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ClassIslandBridgeSnapshot, Lesson, SnapshotRef } from '@aurora/shared'
import ClassificationLedger from '../../shared/components/ClassificationLedger.vue'
import AgentTodoList from '../../shared/components/AgentTodoList.vue'
import AppButton from '../../shared/components/AppButton.vue'
import { ArchiveRestore, CalendarClock, FolderOpen, School } from '../../shared/icons.js'
import type { TodoRow } from '../../shared/agentTodo.js'
import { useSnapshots } from '../../shared/composables/snapshots.js'
import {
  useModeStore,
  usePerceptionStore,
  useSettingsStore,
  useWindowStore,
} from '../../shared/stores.js'

const settingsStore = useSettingsStore()
const modeStore = useModeStore()
const windowStore = useWindowStore()
const perception = usePerceptionStore()

/** 当前会话的任务清单（App.vue 从消息流里最后一次 todo_write 解析得出；空数组 = 无清单） */
const props = withDefaults(
  defineProps<{
    todos?: TodoRow[]
    /** 当前会话 id（「会话项目」卡的绑定目标；缺省 = 拿不到会话，整卡不渲染） */
    sessionId?: string
    /** 当前会话绑定的项目 id；`''` / 缺省 = 未绑定（跟随全局） */
    sessionProjectId?: string
  }>(),
  { todos: () => [], sessionId: '', sessionProjectId: '' },
)

/** 绑定 / 解绑会话项目（App.vue → useChat.setSessionProject；空串 = 清除绑定） */
const emit = defineEmits<{ (event: 'bindSessionProject', projectId: string): void }>()

// ───────────────────────── 会话项目（v17，docs/06 §5.1） ─────────────────────────

/**
 * 会话级项目（docs/06 §5.1）：本会话可以绑定 `projects.list` 里的某一项，
 * 绑定后该会话的缺省工作目录 / 项目根边界 / AGENTS.md 注入 / auto 档边界都以它为准；
 * 未绑定（下拉选「未指定」）回落全局当前项目，再按原有链回落。
 *
 * 没有可绑定的项目（`projects.list` 为空）时整卡不渲染 —— 绑定一个空列表没有意义，
 * 项目登记入口在设置页。center- 等远程会话与本会话同一条逻辑，不做特殊分支。
 */
const projectOptions = computed(() => settingsStore.settings?.projects.list ?? [])

function onSessionProjectChange(event: Event): void {
  const value = (event.target as HTMLSelectElement | null)?.value ?? ''
  emit('bindSessionProject', value)
}

/** 进度摘要：已完成 / 总数（清单卡头右上角） */
const todoProgress = computed(() => {
  const done = props.todos.filter((item) => item.status === 'completed').length
  return `${done}/${props.todos.length}`
})

const mode = computed(() => modeStore.current?.id ?? null)

// ───────────────────────── classroom ─────────────────────────

/** 只有课表 provider 是 classisland 时才显示「当前/下节课」卡（spec §3） */
const isClassislandProvider = computed(
  () => settingsStore.settings?.modes.classroom.schedule.provider === 'classisland',
)
const showClassislandCard = computed(
  () => mode.value === 'classroom' && isClassislandProvider.value,
)

/**
 * ClassIsland 桥接的实时课堂快照（`schedule.json` 内嵌的 `status`，契约见
 * `ClassIslandBridgeSnapshot`）：`onClass` / `currentSubject` / `nextSubject` 等。
 * 桥接 v3 起还带当前课与下节课的起止时间；缺失字段一律按「暂无」降级，不编造。
 */
const bridgeSnapshot = ref<ClassIslandBridgeSnapshot | null>(null)

async function refreshClassisland(): Promise<void> {
  if (!showClassislandCard.value) return
  const result = await window.aurora.classisland.status()
  if (!result.ok) {
    bridgeSnapshot.value = null
    return
  }
  bridgeSnapshot.value = result.value.status ?? null
}

const onClass = computed(() => bridgeSnapshot.value?.onClass === true)
const currentSubject = computed(() => bridgeSnapshot.value?.currentSubject ?? '')
const nextSubject = computed(() => bridgeSnapshot.value?.nextSubject ?? '')
/** 「下节 语文 · 09:20–10:05」的时段部分（桥接给出时间才拼，缺就只显示科目） */
const nextTimeRange = computed(() => {
  const start = bridgeSnapshot.value?.nextStartTime ?? ''
  const end = bridgeSnapshot.value?.nextEndTime ?? ''
  if (start === '' && end === '') return ''
  if (end === '') return start
  return start === '' ? `至 ${end}` : `${start}–${end}`
})
/** 当前课时段（上课中才显示） */
const currentTimeRange = computed(() => {
  const start = bridgeSnapshot.value?.currentStartTime ?? ''
  const end = bridgeSnapshot.value?.currentEndTime ?? ''
  if (start === '' && end === '') return ''
  if (end === '') return start
  return start === '' ? `至 ${end}` : `${start}–${end}`
})

const classislandReady = computed(
  () => onClass.value || currentSubject.value !== '' || nextSubject.value !== '',
)

/** 今日课程（感知 summary 的 lessons，按开始时间升序） */
const todayLessons = computed<Lesson[]>(() => {
  // Pinia store 的 ref 在实例上自动解包：`perception.summary` 直接就是数据
  const lessons = perception.summary?.lessons ?? []
  const weekday = new Date().getDay()
  return lessons
    .filter((lesson) => lesson.weekday === weekday)
    .sort((a, b) => a.startTime.localeCompare(b.startTime))
})

async function openWatchDir(): Promise<void> {
  await window.aurora.app.openPath({ kind: 'watchDir' })
}

// ───────────────────────── work ─────────────────────────

const workspaceDir = computed(() => settingsStore.settings?.modes.work.workspaceDir ?? '')

async function openWorkspace(): Promise<void> {
  await window.aurora.app.openPath({ kind: 'workspace' })
}

// ───────────────────────── 通用：系统状态 ─────────────────────────

const summary = computed(() => perception.summary)

const timeLabel = computed(() => {
  const item = summary.value
  if (item === null) return '--:--'
  return `${item.localTime} ${item.weekday}`.trim()
})

const batteryLabel = computed(() => {
  const battery = summary.value?.battery
  if (battery === undefined || !battery.hasBattery) return '不可用'
  return battery.isCharging ? `${battery.percent}%（充电中）` : `${battery.percent}%`
})

const networkLabel = computed(() => {
  const network = summary.value?.network
  if (network === undefined) return '不可用'
  return network.online ? `已连接 · ${network.type}` : `离线 · ${network.type}`
})

const foregroundLabel = computed(() => summary.value?.foreground?.app ?? '不可用')

// ───────────────────────── 通用：当前项目（v13） ─────────────────────────

/**
 * 当前项目（docs/06 §5.1）：从配置里取「当前那一条」，无项目 / id 对不上都不渲染。
 *
 * 与 `agent.tools.workspaceDir`（work 模式的「工作目录」卡）**不是一个东西**：
 * 项目根是 AGENTS.md 的注入来源，也是权限层判定「根内 / 根外」的边界。
 */
const project = computed(() => {
  const projects = settingsStore.settings?.projects
  if (!projects || projects.current === '') return null
  return projects.list.find((item) => item.id === projects.current) ?? null
})

/** 项目根是否可用由主进程探测（渲染层没有 fs）；拿不到状态时按「可用」处理，不显示假警报 */
const projectAvailable = ref(true)

async function refreshProjectStatus(): Promise<void> {
  if (project.value === null) return
  const result = await window.aurora.project.status()
  projectAvailable.value = result.ok ? result.value.rootAvailable : true
}

async function openProjectRoot(): Promise<void> {
  // 打不开时静默（右栏没有提示位）；设置页的项目区组才是排查入口
  await window.aurora.app.openPath({ kind: 'project' })
}

// ───────────────────────── 通用：文件备份（v14） ─────────────────────────

/**
 * 写前快照（docs/06 §11.8、docs/07 §2.3）：最近 5 条 + 逐条回滚。
 *
 * 刻意**不传 `sessionId`**：本组件拿不到"当前会话 id" —— `chat/App.vue` 里它是
 * `useChat()` 内部的局部 ref（既没有 Pinia store，也没有经 props 传进右栏：
 * ContextPanel 的 props 只有 `todos`）。不传时后端返回**全部会话**的最近若干条，
 * 因此这张卡展示的是"最近被 Agent 改过的文件"，而不是严格的本会话备份。
 * 想按会话过滤，需要 App.vue 把 `sessionId` 作为 prop 传进来（见 `snapshots.ts` 的注释）；
 * **不要**用 `chat.sessions()` 里"最近更新的那条"冒充当前会话。
 *
 * 数据只在挂载 + 手动刷新（以及回滚成功后）时取：**不并入 30s 轮询** ——
 * 主进程没有快照变更事件，跟着轮询拉只会白跑请求。
 */
const {
  items: snapshotItems,
  loading: snapshotsLoading,
  error: snapshotsError,
  refresh: refreshSnapshots,
  restore: restoreSnapshot,
} = useSnapshots({ limit: 5 })

/** 正在二次确认的行（快照 id）：第一次点只把按钮文案换成「确认回滚？」，第二下才执行 */
const confirmingSnapshotId = ref<string | null>(null)
/** 卡内回执（本文件没有 toast）：短暂显示，4 秒后自灭 */
const snapshotMessage = ref<string | null>(null)
let snapshotMessageTimer: number | null = null

/** `origin` 的中文口径：`rollback` 是**回滚前**留下的那一份（所以回滚也可再撤回） */
const SNAPSHOT_ORIGIN_LABELS: Record<SnapshotRef['origin'], string> = {
  write_file: '写文件',
  edit_file: '改文件',
  rollback: '回滚前',
}

/** 文件名：取 `path` 的 basename（Windows 反斜杠与 POSIX 斜杠都处理） */
function snapshotFileName(path: string): string {
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1] ?? path
}

/** 本地 HH:mm:ss（`createdAt` 是 ISO 串；解析不出来时原样回显，不显示 NaN） */
function snapshotTime(createdAt: string): string {
  const parsed = new Date(createdAt)
  if (Number.isNaN(parsed.getTime())) return createdAt
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`
}

function flashSnapshotMessage(text: string): void {
  snapshotMessage.value = text
  if (snapshotMessageTimer !== null) window.clearTimeout(snapshotMessageTimer)
  snapshotMessageTimer = window.setTimeout(() => {
    snapshotMessage.value = null
    snapshotMessageTimer = null
  }, 4000)
}

/**
 * 两段式回滚（照 `AdvancedPage.vue` 的「确认重置？」写法）：
 * 第一次点进入确认态并清掉上一条回执，第二下才真的执行；成功后 hook 内部会 `refresh()`。
 */
async function onRestoreClick(id: string): Promise<void> {
  if (confirmingSnapshotId.value !== id) {
    confirmingSnapshotId.value = id
    snapshotMessage.value = null
    return
  }
  confirmingSnapshotId.value = null
  const ok = await restoreSnapshot(id)
  flashSnapshotMessage(
    ok ? '已回滚（回滚前的状态也留了一份备份）' : (snapshotsError.value ?? '回滚失败'),
  )
}

// ───────────────────────── 轮询 ─────────────────────────

let timer: number | null = null

function refreshAll(): void {
  void perception.refresh()
  void refreshClassisland()
  void refreshProjectStatus()
}

onMounted(() => {
  refreshAll()
  timer = window.setInterval(refreshAll, 30_000)
  // 文件备份单独取一次：**不放进 refreshAll**，否则它会跟着 30s 轮询一起拉（见上面的说明）
  void refreshSnapshots()
})

onUnmounted(() => {
  if (timer !== null) window.clearInterval(timer)
  timer = null
  if (snapshotMessageTimer !== null) window.clearTimeout(snapshotMessageTimer)
  snapshotMessageTimer = null
})

// 模式 / provider 切换导致卡片出现时立即取一次，不等下一轮轮询
watch(showClassislandCard, (now) => {
  if (now) void refreshClassisland()
})

// 项目卡出现（切项目 / 新登记）时立刻探测一次根目录
watch(project, () => {
  void refreshProjectStatus()
})
</script>

<template>
  <div class="ctx-inner">
    <p class="ctx-caption tiny muted">上下文</p>

    <!-- ── 任务清单（2026-09 新增）：Agent 在会话里 todo_write 驱动，无清单不渲染 ── -->
    <section v-if="props.todos.length > 0" class="ctx-card" data-field="context.todo-card">
      <header class="ctx-head">
        <strong>任务清单</strong>
        <span class="grow" />
        <span class="tiny muted ctx-progress">{{ todoProgress }}</span>
      </header>
      <AgentTodoList :todos="props.todos" />
    </section>

    <!-- ── classroom：课堂上下文 ── -->
    <template v-if="mode === 'classroom'">
      <section v-if="showClassislandCard" class="ctx-card" data-field="context.classisland-card">
        <header class="ctx-head">
          <School :size="15" :stroke-width="1.6" class="ctx-icon" aria-hidden="true" />
          <strong>课堂状态</strong>
          <span v-if="onClass" class="badge ok" data-field="context.classisland-onclass"
            >上课中</span
          >
        </header>
        <p
          v-if="!classislandReady"
          class="tiny muted ctx-line"
          data-field="context.classisland-empty"
        >
          暂无课堂状态（等待桥接数据）
        </p>
        <template v-else>
          <div class="ctx-line">
            <span class="tiny muted">当前</span>
            <span class="ctx-value" data-field="context.classisland-current">
              {{ onClass && currentSubject !== '' ? currentSubject : '—' }}
              <span v-if="onClass && currentTimeRange !== ''" class="tiny muted ctx-range">
                {{ currentTimeRange }}
              </span>
            </span>
          </div>
          <div class="ctx-line">
            <span class="tiny muted">下节</span>
            <span class="ctx-value" data-field="context.classisland-next">
              {{
                nextSubject !== ''
                  ? `${nextSubject}${nextTimeRange !== '' ? ` · ${nextTimeRange}` : ''}`
                  : '—'
              }}
            </span>
          </div>
        </template>
      </section>

      <section class="ctx-card" data-field="context.lesson-card">
        <header class="ctx-head">
          <CalendarClock :size="15" :stroke-width="1.6" class="ctx-icon" aria-hidden="true" />
          <strong>今日课程</strong>
          <span v-if="todayLessons.length > 0" class="badge">{{ todayLessons.length }} 节</span>
        </header>
        <p v-if="todayLessons.length === 0" class="tiny muted ctx-line">今天没有查到的课程安排</p>
        <div v-else class="lesson-list">
          <div
            v-for="lesson in todayLessons"
            :key="`${lesson.startTime}-${lesson.subject}`"
            class="lesson"
          >
            <span class="mono tiny lesson-time">{{ lesson.startTime }}</span>
            <span class="lesson-subject">{{ lesson.subject }}</span>
          </div>
        </div>
      </section>

      <ClassificationLedger :limit="8" class="ctx-ledger" />

      <AppButton size="sm" variant="secondary" block @click="openWatchDir">
        <FolderOpen :size="13" :stroke-width="1.7" aria-hidden="true" />
        打开感知文件夹
      </AppButton>
    </template>

    <!-- ── work：办公上下文 ── -->
    <template v-else-if="mode === 'work'">
      <section class="ctx-card">
        <header class="ctx-head">
          <strong>工作目录</strong>
        </header>
        <p class="tiny muted ctx-line">电脑操控与文件工具的默认工作目录：</p>
        <p class="ctx-path mono tiny" :title="workspaceDir">
          {{ workspaceDir === '' ? '未配置' : workspaceDir }}
        </p>
        <div class="ctx-actions">
          <AppButton
            size="sm"
            variant="secondary"
            :disabled="workspaceDir === ''"
            @click="openWorkspace"
          >
            打开目录
          </AppButton>
          <!-- window.show 暂不支持深链查询参数：直接打开设置页（modes 页在其中） -->
          <AppButton size="sm" variant="ghost" @click="windowStore.show('settings')">
            在设置中修改
          </AppButton>
        </div>
      </section>

      <section class="ctx-card">
        <header class="ctx-head">
          <strong>办公能力</strong>
        </header>
        <ul class="ctx-tips tiny muted">
          <li>文档 / 表格 / 演示文稿：通过 run_command 驱动 Office 自动化</li>
          <li>read_file / write_file / list_dir 组合处理本地资料</li>
          <li>覆盖或删除文件前会先向你确认</li>
        </ul>
      </section>
    </template>

    <!--
      ── 通用：会话项目（v17，docs/06 §5.1；任何模式都渲染，无可绑定项目整卡不渲染） ──
      本会话绑定 projects.list 里的某一项：缺省工作目录 / 项目根边界 / AGENTS.md / auto 档
      边界都以它为准；「未指定」回落全局当前项目（上面的「当前项目」卡显示的就是那份）。
    -->
    <section
      v-if="props.sessionId !== '' && projectOptions.length > 0"
      class="ctx-card"
      data-field="context.session-project-card"
    >
      <header class="ctx-head">
        <FolderOpen :size="15" :stroke-width="1.6" class="ctx-icon" aria-hidden="true" />
        <strong>会话项目</strong>
      </header>
      <p class="tiny muted ctx-line">本会话绑定的项目（未指定时跟随全局当前项目）：</p>
      <select
        class="session-project-select"
        data-field="context.session-project"
        :value="props.sessionProjectId"
        @change="onSessionProjectChange"
      >
        <option value="">未指定（跟随全局）</option>
        <option v-for="item in projectOptions" :key="item.id" :value="item.id">
          {{ item.name }}
        </option>
      </select>
    </section>

    <!-- ── 通用：当前项目（v13，docs/06 §5.1；任何模式都渲染，无项目整卡不渲染） ── -->
    <section v-if="project !== null" class="ctx-card" data-field="context.project-card">
      <header class="ctx-head">
        <FolderOpen :size="15" :stroke-width="1.6" class="ctx-icon" aria-hidden="true" />
        <strong>当前项目</strong>
        <span v-if="!projectAvailable" class="badge error" data-field="context.project-unavailable">
          项目目录不可用
        </span>
      </header>
      <p class="tiny muted ctx-line">
        {{
          projectAvailable
            ? '每轮对话都会注入「项目根 → 当前工作目录」的 AGENTS.md：'
            : '项目根不存在或不是目录，AGENTS.md 不会被注入：'
        }}
      </p>
      <div class="ctx-line">
        <span class="tiny muted">项目</span>
        <span class="ctx-value" :title="project.name">{{ project.name }}</span>
      </div>
      <p class="ctx-path mono tiny" :title="project.root">{{ project.root }}</p>
      <!-- 项目根失效时不提供「打开」：点了只会弹系统错误，反而让人以为路径没问题 -->
      <div v-if="projectAvailable" class="ctx-actions">
        <AppButton size="sm" variant="secondary" @click="openProjectRoot">打开文件夹</AppButton>
      </div>
      <div v-else class="ctx-actions">
        <AppButton size="sm" variant="secondary" @click="windowStore.show('settings')">
          去设置里重新选择目录
        </AppButton>
      </div>
    </section>

    <!--
      ── 通用：文件备份（v14，docs/06 §11.8；与「当前项目」同属通用档，不受模式门控） ──
      空态整卡仍然渲染（否则用户根本不知道有这个能力）。锚点 `chat.snapshot-card` 是
      capture 探针与 docs 已按此名写死的名字（本文件其它卡片用 `context.*` 前缀），保持不动。
    -->
    <section class="ctx-card" data-field="chat.snapshot-card">
      <header class="ctx-head">
        <ArchiveRestore :size="15" :stroke-width="1.6" class="ctx-icon" aria-hidden="true" />
        <strong>文件备份</strong>
        <span class="grow" />
        <!-- 手动刷新入口：本卡不轮询，所以必须有一个显式拉取的地方（锚点用 data-action，不占 data-field） -->
        <button
          type="button"
          class="snapshot-refresh press"
          data-action="chat.snapshot-refresh"
          title="刷新（本卡不自动轮询）"
          :disabled="snapshotsLoading"
          @click="void refreshSnapshots()"
        >
          刷新
        </button>
      </header>

      <p v-if="snapshotItems.length === 0" class="tiny muted ctx-line snapshot-empty">
        还没有文件备份：Agent 写文件时会自动留底。
      </p>
      <div v-else class="snapshot-list">
        <div v-for="item in snapshotItems" :key="item.id" class="snapshot-row">
          <div class="snapshot-meta">
            <span class="snapshot-name" :title="item.path">{{ snapshotFileName(item.path) }}</span>
            <span class="tiny muted snapshot-sub">
              {{ snapshotTime(item.createdAt) }} ·
              {{ SNAPSHOT_ORIGIN_LABELS[item.origin] }}
              <!-- exists:false = 记的是"当时文件还不存在"：回滚它会**删除**该文件，必须说清楚 -->
              <span v-if="!item.exists" class="snapshot-missing">· 当时不存在</span>
            </span>
          </div>
          <AppButton
            size="sm"
            variant="ghost"
            data-field="chat.snapshot-restore"
            :title="
              item.exists
                ? `回到 ${snapshotTime(item.createdAt)} 的这一份（回滚前也会先留一份）`
                : '这份快照记录的是「当时文件还不存在」：回滚会删除该文件'
            "
            @click="void onRestoreClick(item.id)"
          >
            {{ confirmingSnapshotId === item.id ? '确认回滚？' : '回滚' }}
          </AppButton>
        </div>
      </div>

      <!-- 回执 / 失败原因：本文件没有 toast，用卡内一行文案（成功那条 4 秒后自灭） -->
      <p v-if="snapshotMessage" class="tiny muted ctx-line">{{ snapshotMessage }}</p>
      <p v-else-if="snapshotsError" class="tiny ctx-line snapshot-error">{{ snapshotsError }}</p>
    </section>

    <!-- ── 通用：系统状态（任何模式都渲染） ── -->
    <section class="ctx-card">
      <header class="ctx-head">
        <strong>系统状态</strong>
      </header>
      <div class="ctx-line">
        <span class="tiny muted">时间</span>
        <span class="ctx-value" :title="timeLabel">{{ timeLabel }}</span>
      </div>
      <div class="ctx-line">
        <span class="tiny muted">电量</span>
        <span class="ctx-value">{{ batteryLabel }}</span>
      </div>
      <div class="ctx-line">
        <span class="tiny muted">网络</span>
        <span class="ctx-value">{{ networkLabel }}</span>
      </div>
      <div class="ctx-line">
        <span class="tiny muted">前台</span>
        <span class="ctx-value" :title="foregroundLabel">{{ foregroundLabel }}</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* 固定 264px：外层 aside 折叠时宽度收 0，这里保持内容不被压缩换行 */
.ctx-inner {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  width: 264px;
  height: 100%;
  padding: var(--space-3);
  overflow-y: auto;
}

.ctx-caption {
  margin: 0;
  padding: 0 var(--space-1);
  letter-spacing: var(--tracking-eyebrow);
  text-transform: uppercase;
}

/* 卡片：分层填充 + 细边界（与全局 .surface-card 同一观感，但按栏内排版定制） */
.ctx-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--fill-1);
  box-shadow: var(--shadow-hairline);
}

.ctx-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
}

.ctx-head .grow {
  flex: 1;
  min-width: 0;
}

.ctx-progress {
  font-variant-numeric: var(--num-tabular);
}

/* 卡头图标：次要信息，比标题低一档存在感 */
.ctx-icon {
  flex: 0 0 auto;
  color: var(--text-muted);
}

/* 当前课的时间段跟在科目后面，比科目弱一档 */
.ctx-range {
  margin-left: 6px;
}

.ctx-line {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}

.ctx-value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: var(--num-tabular);
}

.ctx-path {
  margin: 0;
  padding: 6px var(--space-2);
  border-radius: var(--radius-xs);
  background: var(--fill-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ctx-actions {
  display: flex;
  gap: var(--space-2);
}

/* 会话项目下拉：与卡片内文案同宽，观感对齐 ctx-path（细边框 + 次级填充） */
.session-project-select {
  width: 100%;
  padding: 6px var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xs);
  background: var(--fill-2);
  color: var(--text-primary);
  font-size: var(--text-xs);
}

.ctx-tips {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  line-height: var(--leading-normal);
}

/* 今日课程列表 */
.lesson-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 220px;
  overflow-y: auto;
}

.lesson {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 3px var(--space-2);
  border-radius: var(--radius-xs);
}

.lesson:hover {
  background: var(--fill-2);
}

.lesson-time {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-variant-numeric: var(--num-tabular);
}

.lesson-subject {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 分类流水在右栏里占满宽度；内部样式由组件自带 */
.ctx-ledger {
  flex: 0 0 auto;
}

/* ── 文件备份卡（v14） ── */

/* 条目行：左「文件名 + 时间 · 来源」/ 右「回滚」（264px 宽，靠 meta 侧压缩让位） */
.snapshot-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.snapshot-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.snapshot-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.snapshot-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 时间与来源：等宽数字（时间逐行对齐）+ 比文件名弱一档 */
.snapshot-sub {
  font-variant-numeric: var(--num-tabular);
}

/* 「当时不存在」：回滚它会删掉文件，比普通说明重一档颜色 */
.snapshot-missing {
  color: var(--warning-text);
}

/* 失败原因（回滚 / 读取失败）：比空态文案重，用错误色 */
.snapshot-error {
  color: var(--status-error);
}

/* 刷新：纯文本小按钮，与卡头同高 —— 本卡不轮询，这个入口是唯一的手动拉取点 */
.snapshot-refresh {
  flex: 0 0 auto;
  font-size: var(--text-xs);
  color: var(--text-muted);
  transition: color var(--transition-fast);
}

.snapshot-refresh:hover:not(:disabled) {
  color: var(--text-primary);
}

.snapshot-refresh:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
