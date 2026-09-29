<script setup lang="ts">
/**
 * 常规设置页（docs/08 §1/§6，BetaV2 六页 IA）：启动、提示条、勿扰时段、系统感知、关于与更新。
 *
 * 勿扰时段（`advanced.quietHours`）从 AdvancedPage 迁来：与「提示条」自己的静默时段
 * （`general.edgeBar.quietHours`）在视觉上是两个小组，但同在这一页 —— 前者拦截主动打扰
 * （课前提醒、敏感工具确认），后者只控制提示条本身的显隐，两者互不影响。
 *
 * `general.language` 是**没有 i18n 消费方的死字段**（docs/08 §1）：
 * 本页不再提供任何入口，但保存时仍原样回传当前值 —— `settings:update` 是
 * 顶层分组浅合并，`general` 整对象被替换，漏掉 language 会被 Schema 默认值重置。
 *
 * v13 起新增「项目」区组（docs/06 §5.1）：项目 = 名字 + 根目录，`projects.current` 指当前那一个。
 * 它同时决定「每轮注入哪份项目级 AGENTS.md」与「权限层认定的项目根」，因此是**只读前缀**
 * （AI 改不动），只能在这里维护。列表类编辑沿用本仓库既定的**即时保存**口径（无「保存」按钮，
 * 与 WorkSection / SubjectsEditor 一致），并且每次都带**完整子树** —— `projects` 是顶层浅合并。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { HotkeyStatus, ProjectConfig, ProjectStatus } from '@aurora/shared'
import AppButton from '../../shared/components/AppButton.vue'
import AppToast from '../../shared/components/AppToast.vue'
import SettingField from '../../shared/components/SettingField.vue'
import {
  usePerceptionStore,
  useSettingsStore,
  useUpdateStore,
  useWindowStore,
} from '../../shared/stores.js'

const settingsStore = useSettingsStore()
const windowStore = useWindowStore()
const perception = usePerceptionStore()
const update = useUpdateStore()

let detachUpdate: (() => void) | null = null
onUnmounted(() => {
  detachUpdate?.()
  detachUpdate = null
  detachHotkey?.()
  detachHotkey = null
})

/** 更新状态 → 用户可读文案（docs/09 §5） */
const updateLabel = computed(() => {
  const state = update.state
  if (!state) return '正在读取…'
  switch (state.status) {
    case 'disabled':
      return '当前为开发模式 / 未打包运行，自动更新不可用'
    case 'idle':
      return '尚未检查'
    case 'checking':
      return '正在检查更新…'
    case 'up-to-date':
      return `已是最新版本（v${state.currentVersion}）`
    case 'available':
      return `发现新版本 v${state.availableVersion ?? ''}（当前 v${state.currentVersion}）`
    case 'downloading':
      return `正在下载 v${state.availableVersion ?? ''}（${state.progressPercent ?? 0}%）`
    case 'downloaded':
      return `v${state.availableVersion ?? ''} 已下载，重启后安装`
    case 'error':
      return state.error ?? '检查更新失败'
    default:
      return ''
  }
})

const updateTone = computed<'ok' | 'error' | 'info'>(() => {
  const status = update.state?.status
  if (status === 'error') return 'error'
  if (status === 'available' || status === 'downloaded') return 'ok'
  return 'info'
})

const general = computed(() => settingsStore.settings?.general ?? null)
const launchAtLogin = ref(general.value?.launchAtLogin ?? false)
const hotkey = ref(general.value?.hotkey ?? 'Alt+Space')
const edgeEnabled = ref(general.value?.edgeBar.enabled ?? true)
const edgeOpacity = ref(general.value?.edgeBar.opacity ?? 0.9)
const saved = ref<string | null>(null)
const error = ref<string | null>(null)

/** 全局快捷键的**真实注册状态**（由主进程回传，非配置里的期望值） */
const hotkeyStatus = ref<HotkeyStatus | null>(null)
let detachHotkey: (() => void) | null = null

const edgeQuietStart = computed(() => general.value?.edgeBar.quietHours?.start ?? '')
const edgeQuietEnd = computed(() => general.value?.edgeBar.quietHours?.end ?? '')

/** 提示条勿扰时段：两端都填才生效（只填一端等于没配，存下来只会让人困惑） */
async function saveEdgeQuiet(which: 'start' | 'end', value: string): Promise<void> {
  const current = general.value?.edgeBar.quietHours
  const next = {
    start: which === 'start' ? value.trim() : (current?.start ?? ''),
    end: which === 'end' ? value.trim() : (current?.end ?? ''),
  }
  const ok = await settingsStore.update({
    general: {
      ...general.value!,
      edgeBar: {
        enabled: edgeEnabled.value,
        opacity: Number(edgeOpacity.value),
        quietHours: next.start === '' || next.end === '' ? null : next,
      },
    },
  })
  if (ok) saved.value = '已保存'
  else error.value = settingsStore.error
}

/** 全局勿扰时段（`advanced.quietHours`，自 AdvancedPage 迁入）：保存语义与其原实现一致 */
async function saveQuiet(which: 'start' | 'end', value: string): Promise<void> {
  const current = settingsStore.settings?.advanced ?? null
  if (!current) return
  let next: { start: string; end: string } | null
  if (which === 'start') {
    const start = value.trim()
    // 留空 = 不启用；只填开始时结束时间先按默认「07:00」落一个完整时段
    next = start === '' ? null : { start, end: current.quietHours?.end ?? '07:00' }
  } else {
    const end = value.trim()
    next = current.quietHours?.start ? { start: current.quietHours.start, end } : null
  }
  const ok = await settingsStore.update({ advanced: { ...current, quietHours: next } })
  if (ok) saved.value = '已保存'
  else error.value = settingsStore.error
}

onMounted(async () => {
  detachUpdate = update.bind()
  await update.load()
  // 快捷键状态：先取一次当前值，再订阅变化（改绑 / 冲突时会推送）
  const status = await window.aurora.hotkey.status()
  if (status.ok) hotkeyStatus.value = status.value
  detachHotkey = window.aurora.hotkey.onChanged((next) => {
    hotkeyStatus.value = next
  })
  // 项目根是否可用只有主进程知道（渲染层没有 fs）；进页面取一次，配置变化后再取
  await refreshProjectStatus()
})

watch(
  () => settingsStore.settings,
  (next) => {
    if (!next) return
    launchAtLogin.value = next.general.launchAtLogin
    hotkey.value = next.general.hotkey
    edgeEnabled.value = next.general.edgeBar.enabled
    edgeOpacity.value = next.general.edgeBar.opacity
    // 项目配置一变就重新探测根目录（失败静默：按"无警示"处理）
    void refreshProjectStatus()
  },
  { immediate: true },
)

async function save(): Promise<void> {
  error.value = null
  saved.value = null
  const ok = await settingsStore.update({
    general: {
      // 死字段原样回传：UI 不提供入口，但也不该被保存动作重置（docs/08 §1）
      language: general.value?.language ?? 'zh-CN',
      launchAtLogin: launchAtLogin.value,
      hotkey: hotkey.value.trim() === '' ? 'Alt+Space' : hotkey.value.trim(),
      edgeBar: {
        enabled: edgeEnabled.value,
        opacity: Number(edgeOpacity.value),
        quietHours: general.value?.edgeBar.quietHours ?? null,
      },
    },
  })
  if (ok) saved.value = '已保存'
  else error.value = settingsStore.error
}

async function toggleEdgeBar(): Promise<void> {
  await windowStore.toggle('edge-bar')
}

// ───────────────────────── 项目机制（v13，docs/06 §5.1）─────────────────────────

const projects = computed(() => settingsStore.settings?.projects ?? null)

/** 主进程探测的「当前项目」状态：渲染层没有文件系统能力，根目录是否可用只能问主进程 */
const projectStatus = ref<ProjectStatus | null>(null)

/** 项目根不可用**且确实有当前项目**时才算警示态（无项目不是异常） */
const currentProjectUnavailable = computed(() => {
  const status = projectStatus.value
  return status !== null && status.currentId !== '' && !status.rootAvailable
})

/** 项目 id 只是本机标识（`projects.current` 引用它），不必全局唯一，但要够随机以免撞车 */
function newProjectId(): string {
  return `proj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 目录末段作为默认项目名（同时兼容 `\` 与 `/`；全是分隔符时回落成路径原文） */
function folderNameOf(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part !== '')
  return parts[parts.length - 1] ?? path
}

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

/** 添加项目：目录由主进程弹系统选择框（渲染层没有文件系统能力），选中即设为当前项目 */
async function addProject(): Promise<void> {
  const current = projects.value
  if (!current) return
  const picked = await window.aurora.project.pickDirectory()
  if (!picked.ok) {
    error.value = picked.message
    return
  }
  if (picked.value === null) return // 用户取消：不是错误，什么都不做
  const root = picked.value
  const id = newProjectId()
  await saveProjects({
    list: [...current.list, { id, name: folderNameOf(root), root }],
    // 刚添加的项目就是用户想用的那一个，省掉一次点击
    current: id,
  })
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
</script>

<template>
  <section class="page">
    <header>
      <h1 class="page-title">通用</h1>
      <p class="page-sub">开机自启、全局快捷键、提示条与勿扰时段，以及系统感知与更新。</p>
    </header>

    <section class="section-card">
      <h2 class="section-title">启动</h2>
      <p class="section-desc">登录 Windows 后常驻托盘，并用全局快捷键随时唤出交互窗。</p>

      <SettingField
        data-field="general.launchAtLogin"
        label="开机自启"
        hint="登录 Windows 后自动在托盘常驻"
      >
        <input v-model="launchAtLogin" type="checkbox" />
      </SettingField>

      <SettingField
        data-field="general.hotkey"
        label="唤出快捷键"
        :hint="
          hotkeyStatus === null
            ? '读取注册状态…'
            : hotkeyStatus.registered
              ? `已在系统注册（${hotkeyStatus.hotkey}），按下即可显示 / 收起交互窗`
              : (hotkeyStatus.message ?? '未注册')
        "
      >
        <div class="column grow">
          <input v-model="hotkey" type="text" spellcheck="false" placeholder="Alt+Space" />
          <AppToast v-if="hotkeyStatus !== null && !hotkeyStatus.registered" tone="warn">
            {{ hotkeyStatus.message ?? '该快捷键未注册成功' }}
          </AppToast>
        </div>
      </SettingField>
    </section>

    <!-- 项目机制（v13，docs/06 §5.1）：项目根同时决定注入的 AGENTS.md 与权限边界 -->
    <section class="section-card">
      <h2 class="section-title">项目</h2>
      <p class="section-desc">
        登记后每轮对话会注入项目根逐层收集的 AGENTS.md，项目根也是权限判定「根内 / 根外」的边界；
        不添加 = 无项目。
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

    <section class="section-card">
      <h2 class="section-title">提示条</h2>
      <p class="section-desc">桌面右缘常驻的 8px 提示条：悬停展开面板，点击呼出主界面。</p>

      <SettingField
        data-field="general.edgeBar.enabled"
        label="启用提示条"
        hint="关闭后提示条从屏幕隐藏，透明度与静默时段一并收起"
      >
        <input v-model="edgeEnabled" type="checkbox" />
        <AppButton size="sm" variant="ghost" @click="toggleEdgeBar">立即显隐</AppButton>
      </SettingField>

      <template v-if="edgeEnabled">
        <SettingField
          data-field="general.edgeBar.opacity"
          label="提示条透明度"
          hint="0.2 ～ 1.0；保存后立即应用"
        >
          <input v-model.number="edgeOpacity" type="number" min="0.2" max="1" step="0.05" />
        </SettingField>

        <SettingField
          data-field="general.edgeBar.quietHours.start"
          label="提示条开始隐藏"
          hint="格式 HH:mm；留空表示不限，仅影响提示条本身"
        >
          <input
            type="text"
            spellcheck="false"
            placeholder="22:30"
            :value="edgeQuietStart"
            @change="saveEdgeQuiet('start', ($event.target as HTMLInputElement).value)"
          />
        </SettingField>

        <SettingField
          data-field="general.edgeBar.quietHours.end"
          label="提示条恢复显示"
          hint="格式 HH:mm；跨午夜时开始时间大于结束时间"
        >
          <input
            type="text"
            spellcheck="false"
            placeholder="07:00"
            :value="edgeQuietEnd"
            @change="saveEdgeQuiet('end', ($event.target as HTMLInputElement).value)"
          />
        </SettingField>
      </template>

      <p v-else class="section-desc" data-empty="general.edgeBar">
        提示条已停用：透明度与静默时段不可配，重新启用后可继续调整。
      </p>
    </section>

    <!-- 全局勿扰时段（advanced.quietHours）：与提示条静默时段同区但分属两组（spec §9） -->
    <section class="section-card">
      <h2 class="section-title">勿扰时段</h2>
      <p class="section-desc">
        全局勿扰只拦截主动打扰（课前提醒、敏感工具确认），两端都填才生效；提示条的静默时段在上方单独设置。
      </p>

      <SettingField
        data-field="advanced.quietHours.start"
        label="勿扰时段开始"
        hint="格式 HH:mm；留空表示不启用"
      >
        <input
          class="input"
          type="text"
          spellcheck="false"
          placeholder="22:30"
          :value="settingsStore.settings?.advanced?.quietHours?.start ?? ''"
          @change="saveQuiet('start', ($event.target as HTMLInputElement).value)"
        />
      </SettingField>

      <SettingField data-field="advanced.quietHours.end" label="勿扰时段结束">
        <input
          class="input"
          type="text"
          spellcheck="false"
          placeholder="07:00"
          :value="settingsStore.settings?.advanced?.quietHours?.end ?? ''"
          @change="saveQuiet('end', ($event.target as HTMLInputElement).value)"
        />
      </SettingField>
    </section>

    <section class="section-card">
      <h2 class="section-title">系统感知</h2>
      <p class="section-desc">时间、电源与网络已接入，其余采集项后续补齐。</p>

      <SettingField label="当前感知快照">
        <div class="column grow">
          <AppToast v-if="perception.summary">
            {{ perception.summary.localTime }} {{ perception.summary.weekday }}
            <template v-if="perception.summary.battery">
              · 电量 {{ perception.summary.battery.percent }}%
            </template>
            <template v-if="perception.summary.network">
              · 网络 {{ perception.summary.network.online ? '在线' : '离线' }}
            </template>
            · 未实现：{{ perception.summary.unknown.join('、') || '无' }}
          </AppToast>
          <div class="row">
            <AppButton size="sm" @click="perception.refresh">刷新</AppButton>
          </div>
        </div>
      </SettingField>
    </section>

    <section class="section-card">
      <h2 class="section-title">关于与更新</h2>
      <p class="section-desc">版本信息、更新状态与手动检查入口。</p>

      <SettingField
        label="当前版本"
        :hint="
          update.state?.feed
            ? `更新源：${update.state.feed}`
            : '更新源：打包后内置（公开 releases 仓库）'
        "
      >
        <div class="column grow">
          <span class="mono tiny"
            >v{{ settingsStore.appInfo?.appVersion ?? update.state?.currentVersion ?? '—' }}</span
          >
        </div>
      </SettingField>

      <SettingField label="更新状态">
        <div class="column grow">
          <AppToast :tone="updateTone">{{ updateLabel }}</AppToast>
          <div
            v-if="update.state?.status === 'downloading'"
            class="progress"
            role="progressbar"
            :aria-valuenow="update.state.progressPercent ?? 0"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <span :style="{ width: `${update.state.progressPercent ?? 0}%` }" />
          </div>
          <div class="row wrap">
            <AppButton
              size="sm"
              :disabled="
                update.busy || !update.state?.enabled || update.state?.status === 'downloading'
              "
              @click="update.check()"
            >
              检查更新
            </AppButton>
            <AppButton
              v-if="update.state?.status === 'available'"
              size="sm"
              variant="primary"
              :disabled="update.busy"
              @click="update.download()"
            >
              下载更新
            </AppButton>
            <AppButton
              v-if="update.state?.status === 'downloaded'"
              size="sm"
              variant="primary"
              @click="update.install()"
            >
              安装并重启
            </AppButton>
          </div>
          <p v-if="update.state?.enabled === false" class="tiny muted">
            自动更新只在安装版中可用；开发态可用
            <code class="mono">AURORA_UPDATE_FEED</code> 指向本地更新源验证。
          </p>
        </div>
      </SettingField>
    </section>

    <footer class="row">
      <AppButton variant="primary" @click="save">保存</AppButton>
      <span class="tiny muted">启动与提示条的改动需点击保存后生效</span>
      <AppToast v-if="saved" tone="ok">{{ saved }}</AppToast>
      <AppToast v-if="error" tone="error">{{ error }}</AppToast>
    </footer>
  </section>
</template>

<style scoped>
/* 页面骨架由设置窗口提供；页面卡片沿用同一半径和静止边界。 */
.page > .section-card {
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-hairline);
}

.page [data-empty] {
  padding: var(--space-3);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
}

.page :is(input[type='number'], .mono, .progress) {
  font-variant-numeric: var(--num-tabular);
}

.progress {
  position: relative;
  height: 6px;
  border-radius: var(--radius-pill);
  overflow: hidden;
  background: var(--fill-2);
}

.progress span {
  display: block;
  height: 100%;
  background: var(--aurora-gradient);
  transition: width var(--transition-base);
}

.wrap {
  flex-wrap: wrap;
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

footer {
  align-items: center;
  flex-wrap: wrap;
}
</style>
