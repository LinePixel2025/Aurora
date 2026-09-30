<script setup lang="ts">
/**
 * 会话管理设置页（2026-09-30，docs/08 §7）：**项目管理 + 会话列表**两个区组。
 *
 * 项目管理由「通用」页迁入（docs/06 §5.1，v13 起原在 GeneralPage）——
 * 项目列表 / 设为当前 / 重选目录 / 删除 / 根可用性警示全部原样搬来，
 * `data-field="projects.*"` 锚点不变（capture 探针契约）。
 *
 * 会话列表（新增）：拉 `chat:sessions` 全量，按左栏三分口径分组
 * （项目对话 / 工作目录对话 / Agent对话 + 已归档），行内提供**归档 / 取消归档**
 * （可逆）与**删除**（不可逆，两步确认）。删除走 `chat:deleteSession`：
 * 主进程守卫「还有 running 任务」的会话（E_INVALID_STATE），落盘文件被真正删除。
 *
 * 列表类编辑沿用本仓库既定的**即时保存**口径（无「保存」按钮，与 WorkSection /
 * SubjectsEditor 一致），每次带**完整 `projects` 子树** —— `settings:update` 是顶层浅合并。
 */
import { computed, onMounted, ref, watch } from 'vue'
import type { ChatSessionSummary, ProjectConfig, ProjectStatus } from '@aurora/shared'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import SettingField from '../../shared/components/SettingField.vue'
import { useSettingsStore } from '../../shared/stores.js'
import { pickProjectEntry } from '../../shared/projects.js'

const settingsStore = useSettingsStore()

const saved = ref<string | null>(null)
const error = ref<string | null>(null)

// ───────────────────────── 项目管理（自 GeneralPage 迁入，docs/06 §5.1）─────────────────────────

const projects = computed(() => settingsStore.settings?.projects ?? null)

/** 主进程探测的「当前项目」状态：渲染层没有文件系统能力，根目录是否可用只能问主进程 */
const projectStatus = ref<ProjectStatus | null>(null)

/** 项目根不可用**且确实有当前项目**时才算警示态（无项目不是异常） */
const currentProjectUnavailable = computed(() => {
  const status = projectStatus.value
  return status !== null && status.currentId !== '' && !status.rootAvailable
})

async function refreshProjectStatus(): Promise<void> {
  const result = await window.aurora.project.status()
  // 探测失败按"无警示"处理：拿不到状态就显示假警报比不显示更糟
  projectStatus.value = result.ok ? result.value : null
}

/**
 * 保存项目改动：**必须带完整子树**（顶层浅合并），且未加载完不写 —— 否则等于用兜底默认值
 * 把已保存的项目列表整棵覆盖掉。
 */
async function saveProjects(
  next: Partial<{ current: string; list: ProjectConfig[] }>,
): Promise<void> {
  const current = projects.value
  if (!current) return
  error.value = null
  saved.value = null
  const ok = await settingsStore.update({ projects: { ...current, ...next } })
  if (ok) {
    saved.value = '已保存'
    await refreshProjectStatus()
  } else {
    error.value = settingsStore.error
  }
}

/**
 * 添加项目：目录由主进程弹系统选择框（渲染层没有文件系统能力），选中即设为当前项目。
 * id / 默认名规则与主界面「项目对话」标题行的添加钮同源（`shared/projects.ts`）。
 */
async function addProject(): Promise<void> {
  const current = projects.value
  if (!current) return
  const entry = await pickProjectEntry()
  if (entry === null) return // 用户取消：不是错误，什么都不做
  // 刚添加的项目就是用户想用的那一个，省掉一次点击
  await saveProjects({ list: [...current.list, entry], current: entry.id })
}

async function updateProjectField(id: string, patch: Partial<ProjectConfig>): Promise<void> {
  const current = projects.value
  if (!current) return
  await saveProjects({
    list: current.list.map((item) => (item.id === id ? { ...item, ...patch } : item)),
  })
}

async function setCurrentProject(id: string): Promise<void> {
  await saveProjects({ current: id })
}

/** 删除项目：删掉的正是当前项目时一并把 `current` 清空（否则它会指向一个不存在的 id） */
async function removeProject(id: string): Promise<void> {
  const current = projects.value
  if (!current) return
  await saveProjects({
    list: current.list.filter((item) => item.id !== id),
    current: current.current === id ? '' : current.current,
  })
}

/** 项目根失效时的「重新选择目录」（假设 7：失效必须有可见出口，不能只在日志里 warn） */
async function repickProjectRoot(id: string): Promise<void> {
  const picked = await window.aurora.project.pickDirectory()
  if (!picked.ok) {
    error.value = picked.message
    return
  }
  if (picked.value === null) return
  await updateProjectField(id, { root: picked.value })
}

async function openProjectRoot(): Promise<void> {
  const result = await window.aurora.app.openPath({ kind: 'project' })
  if (!result.ok) error.value = result.message
}

// ───────────────────────── 会话列表（新增）─────────────────────────

const sessions = ref<ChatSessionSummary[]>([])
/** 正在等第二次确认删除的会话 id（两步确认：第一次点只翻状态，第二次才真删） */
const confirmingId = ref<string | null>(null)

async function loadSessions(): Promise<void> {
  const result = await window.aurora.chat.sessions()
  if (!result.ok) {
    error.value = result.message
    return
  }
  sessions.value = result.value
}

/** 会话空间标签：与左栏三分同一口径（projectId > space），用于行内来源标注 */
function spaceLabelOf(item: ChatSessionSummary): string {
  if (item.projectId !== undefined) {
    const project = projects.value?.list.find((entry) => entry.id === item.projectId)
    return project === undefined ? '项目' : `项目 · ${project.name}`
  }
  if (item.space === 'work') return '工作目录'
  return 'Agent'
}

/** 相对时间：与左栏会话行同一套文案口径（刚刚 / N 分钟前 / 当天时刻 / 昨天 / 月-日） */
function formatRelativeTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const diff = Date.now() - date.getTime()
  const minute = 60_000
  if (diff < minute) return '刚刚'
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  const yesterday = new Date(now.getTime() - 24 * 60 * minute)
  if (date.toDateString() === yesterday.toDateString()) return '昨天'
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

/** 分区：活动会话按三分归组、归档单独一组（与左栏口径一致，`quick` 也在 Agent 组里） */
interface SessionGroup {
  key: string
  title: string
  items: ChatSessionSummary[]
}

const sessionGroups = computed<SessionGroup[]>(() => {
  const groups: SessionGroup[] = [
    {
      key: 'project',
      title: '项目对话',
      items: sessions.value.filter(
        (item) => item.archived !== true && item.projectId !== undefined,
      ),
    },
    {
      key: 'work',
      title: '工作目录对话',
      items: sessions.value.filter(
        (item) => item.archived !== true && item.projectId === undefined && item.space === 'work',
      ),
    },
    {
      key: 'agent',
      title: 'Agent对话',
      items: sessions.value.filter(
        (item) => item.archived !== true && item.projectId === undefined && item.space !== 'work',
      ),
    },
    {
      key: 'archived',
      title: '已归档',
      items: sessions.value.filter((item) => item.archived === true),
    },
  ]
  return groups.filter((group) => group.items.length > 0)
})

async function setArchived(id: string, archived: boolean): Promise<void> {
  confirmingId.value = null
  const result = await window.aurora.chat.archiveSession({ sessionId: id, archived })
  if (!result.ok) {
    error.value = result.message
    return
  }
  await loadSessions()
}

/**
 * 删除会话（两步确认的第一步 / 第二步）：
 * 第一次点只把该行切到「确认删除」态（`confirmingId`），第二次点同一个 id 才真删。
 * 不用 `window.confirm` —— 它阻塞渲染进程且样式与全站不符。任何其它操作都会取消待确认态。
 */
async function onDelete(id: string): Promise<void> {
  if (confirmingId.value !== id) {
    confirmingId.value = id
    return
  }
  confirmingId.value = null
  const result = await window.aurora.chat.deleteSession(id)
  if (!result.ok) {
    error.value = result.message
    return
  }
  saved.value = '已删除'
  await loadSessions()
}

onMounted(() => {
  void refreshProjectStatus()
  void loadSessions()
})

/**
 * 配置一变就重探项目根：根可用性只有主进程知道（渲染层没有 fs），
 * 而它可能在别处被改（主界面「添加项目」、Center 远程命令、手工编辑 config.json 后重启）。
 * 失败静默 —— 按「无警示」处理，显示假警报比不显示更糟。
 */
watch(
  () => settingsStore.settings,
  (next) => {
    if (!next) return
    void refreshProjectStatus()
  },
)
</script>

<template>
  <div class="sessions-page">
    <!-- 项目机制（v13，docs/06 §5.1）：项目根同时决定注入的 AGENTS.md 与权限边界 -->
    <section class="section-card">
      <h2 class="section-title">项目</h2>
      <p class="section-desc">
        登记后注入项目根的 AGENTS.md；项目根也是「根内 / 根外」的权限边界。不添加 = 无项目。
      </p>

      <div v-for="item in projects?.list ?? []" :key="item.id" class="project-row">
        <SettingField data-field="projects.name" label="项目名">
          <input
            class="input grow"
            type="text"
            spellcheck="false"
            placeholder="例如：Aurora"
            :value="item.name"
            @change="
              updateProjectField(item.id, {
                name: ($event.target as HTMLInputElement).value.trim(),
              })
            "
          />
        </SettingField>

        <SettingField
          data-field="projects.root"
          label="项目根目录"
          hint="绝对路径，或相对当前工作目录的路径；目录不存在时该项目降级为无项目"
        >
          <input
            class="input grow"
            type="text"
            spellcheck="false"
            placeholder="D:\Projects\Aurora"
            :value="item.root"
            @change="
              updateProjectField(item.id, {
                root: ($event.target as HTMLInputElement).value.trim(),
              })
            "
          />
        </SettingField>

        <div class="row project-actions">
          <AppButton
            data-field="projects.current"
            size="sm"
            :disabled="item.id === (projects?.current ?? '')"
            @click="setCurrentProject(item.id)"
          >
            {{ item.id === (projects?.current ?? '') ? '已启用' : '设为当前' }}
          </AppButton>
          <AppButton
            data-field="projects.repick"
            size="sm"
            variant="ghost"
            @click="repickProjectRoot(item.id)"
          >
            重新选择目录
          </AppButton>
          <AppButton
            data-field="projects.remove"
            size="sm"
            variant="ghost"
            @click="removeProject(item.id)"
          >
            删除
          </AppButton>
        </div>

        <AppToast
          v-if="item.id === (projects?.current ?? '') && currentProjectUnavailable"
          tone="error"
        >
          项目目录不可用：{{ item.root }} 不存在或不是目录，AGENTS.md
          不会被注入。请重新选择目录或改正路径。
        </AppToast>
      </div>

      <p v-if="(projects?.list.length ?? 0) === 0" class="section-desc" data-empty="projects.list">
        尚未添加项目
      </p>

      <div class="row project-actions">
        <AppButton data-field="projects.add" size="sm" variant="primary" @click="addProject">
          添加项目
        </AppButton>
        <AppButton
          size="sm"
          variant="ghost"
          :disabled="(projects?.current ?? '') === ''"
          @click="openProjectRoot"
        >
          打开当前项目目录
        </AppButton>
        <span class="tiny muted">
          AGENTS.md 注入上限 {{ projects?.maxAgentsBytes ?? 32768 }} 字节
        </span>
      </div>
    </section>

    <!-- 会话列表：按左栏三分口径分组；归档可逆，删除不可逆（两步确认） -->
    <section class="section-card" data-field="sessions.section">
      <h2 class="section-title">会话</h2>
      <p class="section-desc">
        归档只把会话移出左栏主列表（可取消）；删除会移除会话文件与其历史，**不可恢复**。
      </p>

      <p v-if="sessionGroups.length === 0" class="section-desc" data-empty="sessions.list">
        还没有会话
      </p>

      <div v-for="group in sessionGroups" :key="group.key" class="session-group">
        <p class="group-label">{{ group.title }} · {{ group.items.length }}</p>
        <div
          v-for="item in group.items"
          :key="item.id"
          class="session-row"
          data-field="sessions.row"
        >
          <div class="session-main">
            <span class="session-title" :title="item.title">
              {{ item.title.trim() === '' ? '新会话' : item.title }}
            </span>
            <span class="tiny muted session-meta">
              {{ spaceLabelOf(item) }} · {{ formatRelativeTime(item.updatedAt) }}
            </span>
          </div>
          <div class="row session-actions">
            <AppButton
              size="sm"
              variant="ghost"
              data-field="sessions.archive"
              @click="setArchived(item.id, item.archived !== true)"
            >
              {{ item.archived === true ? '取消归档' : '归档' }}
            </AppButton>
            <template v-if="confirmingId === item.id">
              <AppButton
                size="sm"
                variant="danger"
                data-field="sessions.delete"
                @click="onDelete(item.id)"
              >
                确认删除
              </AppButton>
              <AppButton size="sm" variant="ghost" @click="confirmingId = null">取消</AppButton>
            </template>
            <AppButton
              v-else
              size="sm"
              variant="ghost"
              data-field="sessions.delete"
              @click="onDelete(item.id)"
            >
              删除
            </AppButton>
          </div>
        </div>
      </div>
    </section>

    <div class="row">
      <AppToast v-if="saved !== null" tone="ok">{{ saved }}</AppToast>
      <AppToast v-if="error !== null" tone="error">{{ error }}</AppToast>
    </div>
  </div>
</template>

<style scoped>
.sessions-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

/* 项目列表：一行一个项目，行间用发丝线分隔（最后一行不留线） */
.project-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--border-subtle);
}

.project-row:last-of-type {
  border-bottom: none;
}

.project-actions {
  flex-wrap: wrap;
  align-items: center;
}

/* ── 会话列表 ── */
.session-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-2);
}

.group-label {
  margin: 0;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--text-muted);
}

.session-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--fill-1);
}

.session-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.session-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
  font-size: var(--text-sm);
}

.session-meta {
  white-space: nowrap;
}

.session-actions {
  flex: 0 0 auto;
  align-items: center;
  gap: var(--space-1);
}
</style>
