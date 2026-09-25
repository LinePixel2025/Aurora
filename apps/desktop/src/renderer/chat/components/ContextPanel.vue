<script setup lang="ts">
/**
 * 主界面右栏（BetaV2，Design/betav2-spec.md §3）：模式感知的上下文栏。
 *
 * - classroom：当前/下节课卡（ClassIsland 桥接 status，非 classisland provider 时隐藏）、
 *   今日课程卡（perception lessons）、分类流水（ClassificationLedger 紧凑版）、打开感知文件夹；
 * - work：工作目录卡（workspaceDir + 打开 / 前往设置）、办公能力提示卡；
 * - 通用：系统状态卡（时间 / 电量 / 网络 / 前台应用）。
 * 非当前模式的功能**一律不渲染**（不是 disabled）。
 *
 * 感知数据由本组件自取（chat 窗引导未开 trackPerception）：挂载时刷新 + 30s 轮询，
 * 组件卸载即停；`window.aurora` 的 Result 一律降级为空态文案，不抛错。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ClassIslandStatus, Lesson } from '@aurora/shared'
import ClassificationLedger from '../../shared/components/ClassificationLedger.vue'
import AppButton from '../../shared/components/AppButton.vue'
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
 * ClassIsland 桥接的实时课堂快照（v2 payload 的 `status` 组：onClass / currentSubject /
 * nextSubject / nextStartTime）。主进程 `classisland:status` 运行时会带出该组，
 * 但 shared 的 `ClassIslandStatus` 契约尚未收录（向后兼容旧桥接），这里做局部收窄：
 * 缺组 / 缺字段都按「暂无课堂状态」降级。
 */
interface ClassIslandBridgeSnapshot {
  onClass?: boolean
  currentSubject?: string
  nextSubject?: string
  nextStartTime?: string
}

const bridgeSnapshot = ref<ClassIslandBridgeSnapshot | null>(null)

async function refreshClassisland(): Promise<void> {
  if (!showClassislandCard.value) return
  const result = await window.aurora.classisland.status()
  if (!result.ok) {
    bridgeSnapshot.value = null
    return
  }
  const status = result.value as ClassIslandStatus & { status?: ClassIslandBridgeSnapshot }
  bridgeSnapshot.value = status.status ?? null
}

const onClass = computed(() => bridgeSnapshot.value?.onClass === true)
const currentSubject = computed(() => bridgeSnapshot.value?.currentSubject ?? '')
const nextSubject = computed(() => bridgeSnapshot.value?.nextSubject ?? '')
const nextStartTime = computed(() => bridgeSnapshot.value?.nextStartTime ?? '')

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

// ───────────────────────── 轮询 ─────────────────────────

let timer: number | null = null

function refreshAll(): void {
  void perception.refresh()
  void refreshClassisland()
}

onMounted(() => {
  refreshAll()
  timer = window.setInterval(refreshAll, 30_000)
})

onUnmounted(() => {
  if (timer !== null) window.clearInterval(timer)
  timer = null
})

// 模式 / provider 切换导致卡片出现时立即取一次，不等下一轮轮询
watch(showClassislandCard, (now) => {
  if (now) void refreshClassisland()
})
</script>

<template>
  <div class="ctx-inner">
    <p class="ctx-caption tiny muted">上下文</p>

    <!-- ── classroom：课堂上下文 ── -->
    <template v-if="mode === 'classroom'">
      <section v-if="showClassislandCard" class="ctx-card">
        <header class="ctx-head">
          <strong>课堂状态</strong>
          <span v-if="onClass" class="badge ok">上课中</span>
        </header>
        <p v-if="!classislandReady" class="tiny muted ctx-line">暂无课堂状态（等待桥接数据）</p>
        <template v-else>
          <div class="ctx-line">
            <span class="tiny muted">当前</span>
            <span class="ctx-value">{{
              onClass && currentSubject !== '' ? currentSubject : '—'
            }}</span>
          </div>
          <div class="ctx-line">
            <span class="tiny muted">下节</span>
            <span class="ctx-value">
              {{
                nextSubject !== ''
                  ? `${nextSubject}${nextStartTime !== '' ? ` · ${nextStartTime}` : ''}`
                  : '—'
              }}
            </span>
          </div>
        </template>
      </section>

      <section class="ctx-card">
        <header class="ctx-head">
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

      <AppButton size="sm" variant="secondary" block @click="openWatchDir"
        >打开感知文件夹</AppButton
      >
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
</style>
