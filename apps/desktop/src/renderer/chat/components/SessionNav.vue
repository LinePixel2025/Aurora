<script setup lang="ts">
/**
 * 主界面左栏（2026-09 重构，docs/07 §2.3；2026-09-30 会话三分）：品牌行 → 新对话 →
 * 固定项（子代理 / 自动化 / 任务）→ 会话滚动区**三区**（项目对话 / 工作目录对话 / Agent对话）→
 * 「已归档 · N」分组 → 底部（模式徽章 / 右栏开关 / 设置齿轮）。
 *
 * 会话三分（docs/06 §4 会话空间 / docs/07 §2.3）：三个分区的工作目录互不相同 ——
 * 项目对话（绑定 projectId，按项目子分组）= 项目根；工作目录对话（space:'work'，仅
 * Work 模式渲染）= 模式工作目录；Agent对话（space:'agent' 或未标记）= 桌面 Aurora。
 * 「快速对话」固定项随本轮移入 Agent对话区首行（`chat.quick-item` 锚点保留）。
 * 会话行统一用 SessionRow（四区共用同一视觉）。
 *
 * Agent区两项细分（2026-10-03，docs/07 §2.3）：
 * ① **Center 子分组**——`center-` 前缀会话（Aurora Center 网页端）拆成独立可折叠子分组
 * （与项目子分组同一套视觉，默认展开；无 center 会话不渲染），行内 Center 药丸保留；
 * ② **旧会话自动折叠**——本地会话与 Center 子分组各自只默认展示最近 8 条
 * （`RECENT_LIMIT`），溢出收进「更早 · N」折叠行（默认收起）；当前激活会话落在溢出里时
 * 强制可见（提到可见列表末尾），避免「切到旧会话后列表里找不到」。折叠态均为组件内
 * 视图偏好（同 `archiveOpen` 口径，不落配置）。
 *
 * 「任务」入口 2026-09-30 自 App.vue 收拢进这里——左栏固定项不再一处两式（去杂糅）。
 * 面板内的快速对话输入入口在**桌面提示条**（docs/07 §2.2），与本区首行共用同一会话。
 *
 * 会话归档（2026-09 新增，docs/07 §2.3）：会话项 hover 时右侧浮出「归档」图标钮
 * （可逆、不弹确认），归档后的会话从所属分区移入下方「已归档 · N」分组
 * （默认收起、仍可点开继续对话）。分组**由 App.vue 按空间与 archived 分好后传入**，
 * 本组件不做过滤，只负责展开态。
 *
 * 本组件只负责展示与上报意图（emit），会话切换 / 建会话 / 开窗口 / 归档都由 App.vue 落地；
 * `data-field` / `data-action` 锚点是 capture 探针契约（spec §5.3），不可改名。
 */
import { computed, ref } from 'vue'
import type { ChatSessionSummary } from '@aurora/shared'
import { CENTER_SESSION_PREFIX } from '@aurora/shared/browser'
import AppButton from '../../shared/components/AppButton.vue'
import { useWindowDrag } from '../../shared/composables/useWindowDrag.js'
import { useModeStore } from '../../shared/stores.js'
import {
  Bot,
  ChevronRight,
  ListChecks,
  PanelRight,
  Plus,
  SettingsGear,
  Sparkles,
  SquarePen,
  Workflow,
  Zap,
} from '@aurora/shared/browser'
import SessionRow from './SessionRow.vue'

/** 项目对话的子分组：一个项目一组（含还没有会话的项目 —— 组头 `+` 是新建入口） */
interface ProjectSessionGroup {
  id: string
  name: string
  sessions: ChatSessionSummary[]
}

const props = defineProps<{
  /** 项目对话（按项目分组的绑定会话；App.vue 已按 projectId 分好桶） */
  projectGroups: ProjectSessionGroup[]
  /** 工作目录对话（space:'work'，仅 Work 模式下由本组件渲染该区） */
  workSessions: ChatSessionSummary[]
  /** Agent对话（space:'agent' 或未标记；不含 quick —— quick 是本区固定首行。
   *  `center-` 前缀会话也在其中，由本组件按前缀拆出 Center 子分组） */
  agentSessions: ChatSessionSummary[]
  /** 已归档会话（同一 updatedAt 倒序；空数组时整个归档分组不渲染） */
  archivedSessions: ChatSessionSummary[]
  /** 当前会话 id（激活态判定） */
  activeId: string
  /** 右栏是否展开（开关图标的方向 / 激活态） */
  rightOpen: boolean
  /** 主区正在展示的内容：对话流 / 子代理页面 / 自动化页面（docs/13 §11） */
  view: 'chat' | 'subagents' | 'automations'
  /** 本会话已记录的子代理运行数（固定项上的角标） */
  subagentCount: number
  /** 其中是否还有在跑的（角标用 running 色） */
  subagentRunning: boolean
  /** 本会话任务条数（任务固定项角标；0 = 不渲染角标） */
  jobsCount: number
  /** 其中是否还有在跑的（角标用 running 色） */
  jobsRunning: boolean
  /** 任务面板是否展开（入口激活态） */
  jobsOpen: boolean
}>()

const emit = defineEmits<{
  /** 顶部「新对话」：固定创建 Agent 会话（docs/07 §2.3，2026-09-30） */
  (event: 'newSession'): void
  /** Agent对话组头 `+`：新建 space:'agent' 的会话（与顶部按钮同效，docs/07 §2.3） */
  (event: 'newAgentSession'): void
  /** 项目分组头 `+`：新建会话并绑定到该项目 */
  (event: 'newProjectSession', projectId: string): void
  /** 项目对话区「添加项目」：弹目录选择框并加入 projects.list 且设为当前项目（docs/07 §2.3） */
  (event: 'addProject'): void
  /** 工作目录对话分组头 `+`：新建 space:'work' 的会话 */
  (event: 'newWorkSession'): void
  (event: 'select', id: string): void
  /** 归档 / 取消归档（`archived` 即目标状态；由 App.vue 调 useChat.setArchived 落地） */
  (event: 'archiveSession', id: string, archived: boolean): void
  (event: 'openSubagents'): void
  /** 切到自动化页面（docs/13 §11） */
  (event: 'openAutomations'): void
  (event: 'toggleRightPanel'): void
  /** 任务面板开关（原 App.vue 的 .nav-jobs，2026-09-30 收拢进本组件） */
  (event: 'toggleJobs'): void
  (event: 'openSettings'): void
}>()

const modeStore = useModeStore()
const { dragClass } = useWindowDrag('chat')

/** 归档分组展开态（组件内状态，默认收起；docs/07 §2.3 口径） */
const archiveOpen = ref(false)

/**
 * 项目分组折叠态（2026-09-30 新增，docs/07 §2.3）：点项目标题行折叠 / 展开**该项目下的全部会话**。
 *
 * 默认**全部展开**（与用户心智一致：刚登记的项目要能立刻看到里面的对话）；
 * 折叠态存组件内（同 `archiveOpen` 的口径，不落配置 —— 它是视图偏好，不是数据，
 * 重启后回到展开态比"记得你上次收起了哪个项目"更不容易让人误以为会话丢了）。
 */
const collapsedProjects = ref<Record<string, boolean>>({})

function isProjectCollapsed(id: string): boolean {
  return collapsedProjects.value[id] === true
}

function toggleProject(id: string): void {
  collapsedProjects.value = { ...collapsedProjects.value, [id]: !isProjectCollapsed(id) }
}

/**
 * 旧会话自动折叠的条数口径（2026-10-03，docs/07 §2.3）：本地会话与 Center 子分组各自
 * 只默认展示最近 8 条（传入数组已按 updatedAt 倒序，直接取前 8），其余收进「更早 · N」。
 */
const RECENT_LIMIT = 8

/** 「更早」折叠行展开态（组件内视图偏好，同 `archiveOpen` 口径，不落配置） */
const localOlderOpen = ref(false)
const centerOlderOpen = ref(false)

/** Center 子分组展开态：默认**展开**（用户要能立刻看到网页端会话），组件内视图偏好 */
const centerOpen = ref(true)

/** 按 updatedAt 倒序的数组拆成「最近 N 条 + 溢出」；激活会话在溢出里时提到可见列表末尾 */
function splitRecent(sessions: ChatSessionSummary[]): {
  recent: ChatSessionSummary[]
  older: ChatSessionSummary[]
} {
  if (sessions.length <= RECENT_LIMIT) return { recent: sessions, older: [] }
  const recent = sessions.slice(0, RECENT_LIMIT)
  const older = sessions.slice(RECENT_LIMIT)
  const activeIndex = older.findIndex((item) => item.id === props.activeId)
  if (activeIndex >= 0) recent.push(...older.splice(activeIndex, 1))
  return { recent, older }
}

/** Agent区的本地会话（拆掉 center- 前缀后的部分） */
const localAgentSessions = computed(() =>
  props.agentSessions.filter((item) => !item.id.startsWith(CENTER_SESSION_PREFIX)),
)

/** Center 子分组的数据源（`center-` 前缀会话；空则整个子分组不渲染） */
const centerSessions = computed(() =>
  props.agentSessions.filter((item) => item.id.startsWith(CENTER_SESSION_PREFIX)),
)

const localSplit = computed(() => splitRecent(localAgentSessions.value))
const centerSplit = computed(() => splitRecent(centerSessions.value))

const modeName = computed(() => modeStore.current?.displayName ?? '未激活')

/** 工作目录对话区只在 Work 模式渲染（docs/07 §2.3：ClassRoom / Code 无此区） */
const isWorkMode = computed(() => modeStore.current?.id === 'work')

/** quick 行激活态：主区在对话流且当前会话就是 quick */
const quickActive = computed(() => props.view === 'chat' && props.activeId === 'quick')

/**
 * 空态判定：三区 + 归档组**全空**时才说「还没有会话」（Work 区在非 Work 模式下隐藏，
 * 不参与判定；项目对话区空态不渲染 —— 没有项目就没有分组，不再额外说一遍）。
 */
const noSessionsAtAll = computed(
  () =>
    props.agentSessions.length === 0 &&
    props.workSessions.length === 0 &&
    props.archivedSessions.length === 0 &&
    props.projectGroups.every((group) => group.sessions.length === 0),
)
</script>

<template>
  <div class="nav-inner">
    <!-- 品牌行：拖动区（窗口 frame:false）；区内按钮由全局规则自动 no-drag -->
    <div class="brand" :class="dragClass">
      <span class="brand-mark" aria-hidden="true">
        <Sparkles :size="13" :stroke-width="1.6" />
      </span>
      <strong class="brand-name">Aurora</strong>
    </div>

    <div class="new-session">
      <!-- capture 探针锚点（契约）：data-action="chat.new-session"；固定创建 Agent 会话 -->
      <AppButton
        variant="primary"
        size="sm"
        block
        data-action="chat.new-session"
        @click="emit('newSession')"
      >
        <SquarePen class="icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
        新对话
      </AppButton>
    </div>

    <!--
      固定顶置项：子代理（2026-09 新增，docs/07 §2.3）。
      主区切到子代理页面 —— 它不是会话（不能切换 sessionId），因此走独立的 view 状态。
      角标显示本会话记录到的运行数；有在跑的用 running 色 + 呼吸，一眼看出后台在干活。
    -->
    <button
      type="button"
      class="quick-item hover-fill press"
      data-field="chat.subagent-item"
      :class="{ active: props.view === 'subagents' }"
      @click="emit('openSubagents')"
    >
      <Bot class="icon" :size="14" :stroke-width="1.6" aria-hidden="true" />
      <span class="item-title">子代理</span>
      <span
        v-if="props.subagentCount > 0"
        class="count-badge tiny"
        :class="{ running: props.subagentRunning }"
        data-field="chat.subagent-count"
        >{{ props.subagentCount }}</span
      >
    </button>

    <!--
      固定顶置项：自动化（docs/13 §11）。主区切到自动化页面（Agent / Normal 双 tab +
      编辑器与历史弹窗都在组件内）。触发器/操作组件的语义见 docs/13 §4/§5。
    -->
    <button
      type="button"
      class="quick-item hover-fill press"
      data-field="chat.auto-item"
      :class="{ active: props.view === 'automations' }"
      @click="emit('openAutomations')"
    >
      <Workflow class="icon" :size="14" :stroke-width="1.6" aria-hidden="true" />
      <span class="item-title">自动化</span>
    </button>

    <!--
      固定顶置项：任务面板开关（原在 App.vue 的 .nav-jobs，2026-09-30 去杂糅收拢进本组件——
      左栏固定项不再一处两式）。角标 = 本会话任务条数；`chat.jobs-entry` 探针锚点随按钮迁入，
      面板容器锚点仍是 App.vue 的 `chat.jobs`（两者不同元素）。
    -->
    <button
      type="button"
      class="quick-item hover-fill press"
      data-field="chat.jobs-entry"
      :class="{ active: props.jobsOpen }"
      :aria-expanded="props.jobsOpen"
      :title="props.jobsOpen ? '收起任务面板' : '展开任务面板'"
      @click="emit('toggleJobs')"
    >
      <ListChecks class="icon" :size="14" :stroke-width="1.6" aria-hidden="true" />
      <span class="item-title">任务</span>
      <span
        v-if="props.jobsCount > 0"
        class="count-badge tiny"
        :class="{ running: props.jobsRunning }"
        >{{ props.jobsCount }}</span
      >
    </button>

    <nav class="nav-scroll">
      <!--
        空态只在三区 + 归档组全空时出现：归档分组还在、或任一分区有会话时都不说「还没有会话」。
      -->
      <p v-if="noSessionsAtAll" class="tiny muted nav-empty">还没有会话</p>

      <!--
        ── 分区一：项目对话（绑定项目的会话，按项目子分组）──
        **常显**：标题行的「添加项目」是主界面加入 projects.list 的唯一入口
        （弹目录选择框，docs/07 §2.3），没有项目时也不能没有它；
        每个项目分组头 `+` 新建即绑定该项目，**点标题行折叠 / 展开该项目的全部会话**。
      -->
      <section class="group" data-field="chat.project-group">
        <div class="group-head group-head-caption">
          <h3 class="group-caption">项目对话</h3>
          <button
            type="button"
            class="group-add press"
            data-action="chat.add-project"
            title="添加项目（选择一个文件夹）"
            aria-label="添加项目"
            @click="emit('addProject')"
          >
            <Plus :size="13" :stroke-width="1.8" aria-hidden="true" />
          </button>
        </div>
        <!--
          `TransitionGroup`：**新增 / 删除项目**时列表项淡入淡出（不是瞬间插入），
          与折叠动画共用同一套时长令牌。`:key` 用项目 id（重排时按 id 复用节点）。
        -->
        <TransitionGroup name="project-row" tag="div" class="project-groups">
          <div v-for="group in props.projectGroups" :key="group.id" class="project-group">
            <!--
              项目标题行 = **折叠开关**（2026-09-30）：点它收起 / 展开该项目的会话。
              与 `+`（新建）是**同一行的两个兄弟按钮**：`+` 带 `@click.stop`，
              否则点「新建」会顺带把分组收起来（刚新建的会话就看不见了）。
              `aria-expanded` 供读屏与探针读取。
            -->
            <div class="project-head-row">
              <button
                type="button"
                class="project-head hover-fill press"
                data-action="chat.toggle-project"
                :aria-expanded="!isProjectCollapsed(group.id)"
                :title="`${group.name}（点击${isProjectCollapsed(group.id) ? '展开' : '收起'}）`"
                @click="toggleProject(group.id)"
              >
                <ChevronRight
                  class="caret"
                  :class="{ open: !isProjectCollapsed(group.id) }"
                  :size="13"
                  :stroke-width="1.8"
                  aria-hidden="true"
                />
                <span class="project-name">{{ group.name }}</span>
                <span v-if="group.sessions.length > 0" class="count-badge tiny">{{
                  group.sessions.length
                }}</span>
              </button>
              <button
                type="button"
                class="group-add press"
                data-action="chat.new-project-session"
                :title="`在「${group.name}」中新建对话`"
                aria-label="在项目中新建对话"
                @click.stop="emit('newProjectSession', group.id)"
              >
                <Plus :size="13" :stroke-width="1.8" aria-hidden="true" />
              </button>
            </div>
            <!--
              折叠容器：`grid-template-rows: 0fr → 1fr` 的高度过渡（无需测量内容高度），
              内层 `overflow: hidden` 裁切；折叠时加 `inert` —— 视觉裁掉了但键盘还能 Tab 进去，
              否则用户会 focus 到一个看不见的会话项上。
            -->
            <div
              class="collapse"
              :class="{ open: !isProjectCollapsed(group.id) }"
              :inert="isProjectCollapsed(group.id) ? true : undefined"
            >
              <div class="collapse-inner">
                <div v-if="group.sessions.length > 0" class="session-list">
                  <SessionRow
                    v-for="item in group.sessions"
                    :key="item.id"
                    :item="item"
                    :active-id="props.activeId"
                    @select="emit('select', $event)"
                    @toggle-archive="(id, archived) => emit('archiveSession', id, archived)"
                  />
                </div>
                <p v-else class="tiny muted nav-empty">暂无对话</p>
              </div>
            </div>
          </div>
        </TransitionGroup>
      </section>

      <!--
        分区二：工作目录对话（space:'work'，docs/06 §4）。仅 Work 模式渲染 ——
        ClassRoom / Code 模式没有这一区；切走 Work 后该区隐藏（会话仍在，切回来照常显示）。
      -->
      <section v-if="isWorkMode" class="group" data-field="chat.work-group">
        <div class="group-head group-head-caption">
          <h3 class="group-caption">工作目录对话</h3>
          <button
            type="button"
            class="group-add press"
            data-action="chat.new-work-session"
            title="在工作目录中新建对话"
            aria-label="新建工作目录对话"
            @click="emit('newWorkSession')"
          >
            <Plus :size="13" :stroke-width="1.8" aria-hidden="true" />
          </button>
        </div>
        <div v-if="props.workSessions.length > 0" class="session-list">
          <SessionRow
            v-for="item in props.workSessions"
            :key="item.id"
            :item="item"
            :active-id="props.activeId"
            @select="emit('select', $event)"
            @toggle-archive="(id, archived) => emit('archiveSession', id, archived)"
          />
        </div>
        <p v-else class="tiny muted nav-empty">暂无对话</p>
      </section>

      <!-- ── 分区三：Agent对话（Agent 空间；首行固定 quick，与提示条面板共用同一会话） ── -->
      <section class="group" data-field="chat.agent-group">
        <div class="group-head group-head-caption">
          <h3 class="group-caption">Agent对话</h3>
          <button
            type="button"
            class="group-add press"
            data-action="chat.new-agent-session"
            title="新建 Agent 对话"
            aria-label="新建 Agent 对话"
            @click="emit('newAgentSession')"
          >
            <Plus :size="13" :stroke-width="1.8" aria-hidden="true" />
          </button>
        </div>
        <!--
          `chat.session-list` 锚点（capture 探针契约）随会话三分挂在本区的列表容器上：
          Agent 空间是未标记会话（含历史 main 等）的缺省分区，「主会话列表」的语义由它承接
          （docs/07 §2.3）。
        -->
        <div class="session-list" data-field="chat.session-list">
          <!--
            quick 固定首行（原左栏固定顶置项，2026-09-30 随会话三分下沉到这里；
            `chat.quick-item` 探针锚点保留）。它同时是提示条面板的输入会话（docs/07 §2.2）。
          -->
          <div class="nav-row hover-fill" :class="{ active: quickActive }">
            <button
              type="button"
              class="quick-row-btn press"
              data-field="chat.quick-item"
              :class="{ active: quickActive }"
              title="快速对话（提示条面板同样使用这段会话）"
              @click="emit('select', 'quick')"
            >
              <Zap class="icon" :size="14" :stroke-width="1.6" aria-hidden="true" />
              <span class="item-title">快速对话</span>
            </button>
          </div>
          <!--
            本地会话（2026-10-03 起只默认展示最近 `RECENT_LIMIT` 条）：`center-` 前缀会话
            已拆到下方 Center 子分组，不再混在本列表里。
          -->
          <SessionRow
            v-for="item in localSplit.recent"
            :key="item.id"
            :item="item"
            :active-id="props.activeId"
            @select="emit('select', $event)"
            @toggle-archive="(id, archived) => emit('archiveSession', id, archived)"
          />
          <!--
            「更早 · N」折叠行（默认收起；`:aria-expanded` 供探针读取）：溢出的旧会话收在这里，
            展开后显示全部。当前激活会话落在溢出里时已被 `splitRecent` 提到上面可见列表末尾。
          -->
          <button
            v-if="localSplit.older.length > 0"
            type="button"
            class="older-toggle hover-fill press"
            data-field="chat.older-toggle"
            :aria-expanded="localOlderOpen"
            :title="localOlderOpen ? '收起更早会话' : '展开更早会话'"
            @click="localOlderOpen = !localOlderOpen"
          >
            <ChevronRight
              class="caret"
              :class="{ open: localOlderOpen }"
              :size="13"
              :stroke-width="1.8"
              aria-hidden="true"
            />
            <span class="item-title">更早 · {{ localSplit.older.length }}</span>
          </button>
          <template v-if="localSplit.older.length > 0 && localOlderOpen">
            <SessionRow
              v-for="item in localSplit.older"
              :key="item.id"
              :item="item"
              :active-id="props.activeId"
              @select="emit('select', $event)"
              @toggle-archive="(id, archived) => emit('archiveSession', id, archived)"
            />
          </template>
        </div>

        <!--
          Center 子分组（2026-10-03）：Aurora Center 网页端的会话（`center-` 前缀）在本区内
          拆成独立可折叠子分组（与项目子分组同一套视觉：caret + 标题 + 数量徽标 +
          `grid-template-rows: 0fr → 1fr` 折叠容器）。默认**展开**；组内无会话时不渲染。
          SessionRow 行内的 Center 药丸保留不动。
        -->
        <div v-if="centerSessions.length > 0" class="center-group" data-field="chat.center-group">
          <button
            type="button"
            class="project-head hover-fill press"
            data-action="chat.toggle-center"
            :aria-expanded="centerOpen"
            :title="`Center（点击${centerOpen ? '收起' : '展开'}）`"
            @click="centerOpen = !centerOpen"
          >
            <ChevronRight
              class="caret"
              :class="{ open: centerOpen }"
              :size="13"
              :stroke-width="1.8"
              aria-hidden="true"
            />
            <span class="project-name">Center</span>
            <span class="count-badge tiny">{{ centerSessions.length }}</span>
          </button>
          <!-- 折叠时加 `inert`：视觉裁掉了但键盘还能 Tab 进去（与项目子分组同口径） -->
          <div
            class="collapse"
            :class="{ open: centerOpen }"
            :inert="centerOpen ? undefined : true"
          >
            <div class="collapse-inner">
              <div class="session-list">
                <SessionRow
                  v-for="item in centerSplit.recent"
                  :key="item.id"
                  :item="item"
                  :active-id="props.activeId"
                  @select="emit('select', $event)"
                  @toggle-archive="(id, archived) => emit('archiveSession', id, archived)"
                />
                <button
                  v-if="centerSplit.older.length > 0"
                  type="button"
                  class="older-toggle hover-fill press"
                  data-field="chat.center-older-toggle"
                  :aria-expanded="centerOlderOpen"
                  :title="centerOlderOpen ? '收起更早会话' : '展开更早会话'"
                  @click="centerOlderOpen = !centerOlderOpen"
                >
                  <ChevronRight
                    class="caret"
                    :class="{ open: centerOlderOpen }"
                    :size="13"
                    :stroke-width="1.8"
                    aria-hidden="true"
                  />
                  <span class="item-title">更早 · {{ centerSplit.older.length }}</span>
                </button>
                <template v-if="centerSplit.older.length > 0 && centerOlderOpen">
                  <SessionRow
                    v-for="item in centerSplit.older"
                    :key="item.id"
                    :item="item"
                    :active-id="props.activeId"
                    @select="emit('select', $event)"
                    @toggle-archive="(id, archived) => emit('archiveSession', id, archived)"
                  />
                </template>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!--
        归档分组（docs/07 §2.3）：三个分区的会话共用，会话列表之后、默认收起；
        `archivedSessions` 为空时整组不渲染（不占位）。归档项的视觉与普通会话项**完全一致**
        （同一个 SessionRow），只是列表容器换成 chat.archive-list、按钮换成「取消归档」；
        点会话项照常打开继续对话。
      -->
      <section
        v-if="props.archivedSessions.length > 0"
        class="archive"
        data-field="chat.archive-group"
      >
        <button
          type="button"
          class="archive-toggle hover-fill press"
          data-field="chat.archive-toggle"
          :aria-expanded="archiveOpen"
          :title="archiveOpen ? '收起已归档会话' : '展开已归档会话'"
          @click="archiveOpen = !archiveOpen"
        >
          <ChevronRight
            class="caret"
            :class="{ open: archiveOpen }"
            :size="13"
            :stroke-width="1.8"
            aria-hidden="true"
          />
          <span class="item-title">已归档 · {{ props.archivedSessions.length }}</span>
        </button>

        <div v-if="archiveOpen" class="session-list" data-field="chat.archive-list">
          <SessionRow
            v-for="item in props.archivedSessions"
            :key="item.id"
            :item="item"
            :active-id="props.activeId"
            archived
            @select="emit('select', $event)"
            @toggle-archive="(id, archived) => emit('archiveSession', id, archived)"
          />
        </div>
      </section>
    </nav>

    <footer class="nav-foot">
      <span class="badge" :title="`当前模式：${modeName}`">{{ modeName }}</span>
      <span class="grow" />
      <!-- 右栏开关：capture 探针锚点（契约）data-field="chat.right-panel-toggle" -->
      <button
        type="button"
        class="icon-btn press"
        data-field="chat.right-panel-toggle"
        :class="{ active: rightOpen }"
        :title="rightOpen ? '收起右栏' : '展开右栏'"
        @click="emit('toggleRightPanel')"
      >
        <PanelRight :size="15" :stroke-width="1.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="icon-btn press"
        title="设置"
        aria-label="设置"
        @click="emit('openSettings')"
      >
        <SettingsGear :size="15" :stroke-width="1.5" aria-hidden="true" />
      </button>
    </footer>
  </div>
</template>

<style scoped>
/* 固定 240px：外层 aside 折叠时宽度收 0，这里保持内容不被压缩换行 */
.nav-inner {
  display: flex;
  flex-direction: column;
  width: 240px;
  height: 100%;
  padding: var(--space-3);
  gap: var(--space-2);
}

/* ── 品牌行 ── */
.brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 36px;
  padding: 0 var(--space-1);
}

.brand-mark {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-xs);
  background: var(--aurora-gradient);
  box-shadow: var(--shadow-hairline);
}

/* 单色 mark：强调色底 + 白色光芒线，BetaV2 禁用双色品牌渐变 */
.brand-mark svg {
  flex: 0 0 auto;
  stroke: var(--on-accent);
}

.brand-name {
  font-family: var(--font-display);
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-display);
}

.new-session {
  flex: 0 0 auto;
}

/* 按钮里的图标：lucide 自带 width/height 属性，这里只保证不被 flex 压缩 */
.new-session :deep(svg.icon) {
  flex: none;
}

/* ── 固定项（子代理 / 自动化 / 任务）：单行图标 + 文案 ── */
.quick-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  /* 32px 下限：左栏固定项是高频点击，量出来原来只有 30px
     （`chat-hit-targets` 探针；类名是历史命名，别被 `.quick-item` 误导成"只给快速对话用"） */
  min-height: 32px;
  padding: 6px var(--space-2) 6px var(--space-3);
  border-radius: var(--radius-sm);
  font-weight: var(--weight-medium);
  color: var(--text-secondary);
  text-align: left;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.quick-item .icon {
  flex: 0 0 auto;
  stroke: currentColor;
}

.quick-item.active {
  background: var(--fill-2);
  color: var(--text-primary);
}

/* 子代理运行数角标：有在跑的用 running 色并呼吸，否则中性灰 */
.count-badge {
  flex: 0 0 auto;
  min-width: 18px;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--fill-3);
  color: var(--text-muted);
  text-align: center;
  font-variant-numeric: var(--num-tabular);
}

.count-badge.running {
  background: color-mix(in srgb, var(--aurora-blue) 22%, transparent);
  color: var(--accent-text);
  animation: aurora-confirm var(--dur-base) var(--ease-spring) both;
}

/* ── 会话滚动区（三分区 + 归档组） ── */
.nav-scroll {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  padding-right: 2px;
}

.nav-caption {
  margin: var(--space-2) 0 2px;
  padding: 0 var(--space-2);
  letter-spacing: var(--tracking-eyebrow);
  text-transform: uppercase;
}

/**
 * 分区标题（项目对话 / 工作目录对话 / Agent对话，2026-09-30 两轮可读性口径）。
 *
 * 第一轮：撤掉 `.nav-caption` 的「eyebrow 小标签」样式 —— 中文没有大小写，
 * `text-transform: uppercase` + 大字距只会把「AGENT对话」拉得又稀又淡。
 * 第二轮（用户反馈「不够醒目」）：加**左侧强调色短竖条** + 加粗到 semibold +
 * 提到 `--text-base` + 主文字色 —— 分区标题是左栏的**结构骨架**，扫读时应该先看到它，
 * 再看到会话行；与 `.nav-item.active` 的 3px 指示条同一套视觉语言（不引入新形状）。
 */
.group-caption {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-3) 0 2px;
  padding: 0 var(--space-2) 0 calc(var(--space-2) + 7px);
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
  letter-spacing: 0.01em;
  text-transform: none;
}

/* 左侧 3px 强调色竖条：与激活项的指示条同宽同色，一眼认出「这是一级分区」 */
.group-caption::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 13px;
  border-radius: var(--radius-pill);
  background: var(--aurora-blue);
  opacity: 0.85;
}

/* ── 项目分组：可折叠的标题行 + 会话列表 ── */
.project-groups {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.project-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 标题行容器：折叠按钮（占满剩余宽）+ `+`（右侧固定） */
.project-head-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

/**
 * 项目标题行（折叠开关）：可点、hover 有底色 —— 它是**按钮**而不是标题文本，
 * 视觉上必须给出可点线索（否则用户不知道这里能收起）。
 */
.project-head {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-height: 28px;
  padding: 2px var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  text-align: left;
}

.project-head .caret {
  flex: 0 0 auto;
  stroke: currentColor;
  /* 折叠箭头：收起态指右、展开态转 90° 指下（与归档分组同一套动效） */
  transition: transform var(--transition-base);
}

.project-head .caret.open {
  transform: rotate(90deg);
}

.project-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
}

/**
 * 折叠容器：`grid-template-rows: 0fr → 1fr` 的高度过渡。
 *
 * 相比「测量 scrollHeight 再写 max-height」，这个写法不需要知道内容高度、
 * 不会在内容变化时算错，也天然支持两边都缓动（Chromium 105+ 支持 fr 过渡；
 * 本仓 Electron 33 = Chromium 130）。内层 `overflow: hidden` 负责裁切。
 */
.collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition:
    grid-template-rows var(--dur-base) var(--ease-spring),
    opacity var(--transition-fast);
  opacity: 0;
}

.collapse.open {
  grid-template-rows: 1fr;
  opacity: 1;
}

.collapse-inner {
  min-height: 0;
  overflow: hidden;
}

/**
 * 项目行进出场（`TransitionGroup`）：新增 / 删除项目时淡入淡出 + 轻微位移，
 * 避免列表「啪」地一下多出一整块。
 */
.project-row-enter-active,
.project-row-leave-active {
  transition:
    opacity var(--transition-base),
    transform var(--transition-base);
}

.project-row-enter-from,
.project-row-leave-to {
  opacity: 0;
  transform: translateX(-6px);
}

/* 离场时不再占位（否则折叠动画与离场动画会打架） */
.project-row-leave-active {
  position: absolute;
  width: 100%;
}

.nav-empty {
  margin: var(--space-1) 0 0;
  padding: 0 var(--space-2);
}

.session-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/**
 * quick 固定首行（Agent对话区）：会话行样式已随三分搬进 SessionRow（scoped），
 * 这一行是 SessionNav 自己渲染的特例（Zap 图标 + 无归档钮），尺寸与状态样式
 * **逐字对齐** SessionRow 的 `.nav-row` / `.nav-item` —— `chat-hit-targets` 探针把它
 * 当主要动作量（32px 手感线），缩水就是 FAIL。
 */
.nav-row.hover-fill {
  display: flex;
  align-items: center;
  border-radius: var(--radius-sm);
}

.nav-row.hover-fill.active {
  background: var(--fill-2);
}

.quick-row-btn {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 32px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px var(--space-2) 6px var(--space-3);
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--text-secondary);
}

.quick-row-btn.active {
  background: var(--fill-2);
  color: var(--text-primary);
}

.quick-row-btn.active::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 55%;
  border-radius: var(--radius-pill);
  background: var(--aurora-blue);
}

.quick-row-btn .icon {
  flex: 0 0 auto;
  stroke: currentColor;
}

/* ── 分区结构：caption（或组头）+ 会话列表 ── */
.group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/**
 * 项目子分组的组头：项目名（省略）+ 右侧 `+` 新建钮。
 * `+` 是项目对话区**唯一**的新建入口（顶部「新对话」固定创建 Agent 会话），要常显可命中。
 */
.group-head {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-2);
}

.group-head-caption {
  /* 分区标题行的组头把分区 caption 收进同一行（`+` 与 caption 对齐）：
     上间距收到容器一级，两个子元素的独立上边距归零 —— 否则 caption 与 24px 的 `+`
     各带一份不同的 margin-top，align-items: center 也消不齐那 2px 错位 */
  justify-content: space-between;
  padding-top: var(--space-2);
}

.group-head-caption .group-caption,
/* 标题行里的 `+`：上边距归零（与标题同轴心），缩放微交互给出「可点」反馈 */
.group-head-caption .group-add,
.project-head-row .group-add {
  margin-top: 0;
}

.group-add:active,
.project-head:active {
  transform: scale(0.94);
}

.group-add {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  /* 24×24：与 SessionRow 的行动作钮同一条 WCAG 指针目标下限 */
  width: 24px;
  height: 24px;
  margin-top: var(--space-1);
  border-radius: var(--radius-xs);
  color: var(--text-muted);
  transition:
    background var(--transition-fast),
    color var(--transition-fast),
    transform var(--transition-fast);
}

.group-add svg {
  flex: 0 0 auto;
  stroke: currentColor;
}

.group-add:hover {
  background: var(--fill-3);
  color: var(--text-primary);
}

/* ── Center 子分组（Agent区内，复用 .project-head / .collapse 的折叠视觉） ── */
.center-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* 与上方本地会话列表拉开一点：它是「另一来源」的会话 */
  margin-top: var(--space-1);
}

/* ── 「更早 · N」折叠行：溢出旧会话的开关（样式对齐归档分组 toggle） ── */
.older-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: 5px var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  text-align: left;
}

.older-toggle:hover {
  color: var(--text-secondary);
}

.older-toggle .caret {
  flex: 0 0 auto;
  stroke: currentColor;
  transition: transform var(--transition-fast);
}

.older-toggle .caret.open {
  transform: rotate(90deg);
}

.older-toggle .item-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 归档分组：可点击的切换行（默认收起）+ 展开后的列表 ── */
.archive {
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* 与上方会话列表拉开一点：它是「另一类会话」，不是同一条流里的项 */
  margin-top: var(--space-2);
}

.archive-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: 5px var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  text-align: left;
}

.archive-toggle:hover {
  color: var(--text-secondary);
}

/* 折叠箭头：展开时转 90°（时长走令牌，不写死 ms） */
.archive-toggle .caret {
  flex: 0 0 auto;
  stroke: currentColor;
  transition: transform var(--transition-fast);
}

.archive-toggle .caret.open {
  transform: rotate(90deg);
}

.archive-toggle .item-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 底部：模式徽章 + 右栏开关 + 设置齿轮 ── */
.nav-foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-subtle);
}

.icon-btn {
  position: relative;
  display: grid;
  place-items: center;
  /* 32px：底部工具行（右栏开关 / 设置）与固定项同级，量出来原来 28px */
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.icon-btn:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.icon-btn.active {
  color: var(--aurora-blue);
  background: var(--fill-2);
}

.icon-btn svg {
  flex: 0 0 auto;
  stroke: currentColor;
}
</style>
