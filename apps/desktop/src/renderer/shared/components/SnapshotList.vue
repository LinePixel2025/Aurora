<script setup lang="ts">
/**
 * 文件备份列表（v14，docs/06 §11.8、docs/07 §2.3）：最近若干条快照 + 逐条两段式回滚。
 *
 * 2026-09 UI 收拢：从主界面右栏 ContextPanel 的「文件备份」卡整体迁出 —— 回滚属于
 * 「排查 / 补救」动作，主界面右栏放它挤占上下文空间，设置页 Agent 页才是它的家。
 * 迁移时逻辑（useSnapshots / 两段式确认 / 回执）原样搬动，锚点从 `chat.snapshot-*`
 * 统一改名为 `agent.snapshot-*`（capture 探针已同步，见 `main/capture.ts`）。
 *
 * 数据只在挂载 + 手动刷新（以及回滚 / 清理成功后）时取：**不轮询** ——
 * 主进程没有快照变更事件，跟着别的轮询拉只会白跑请求，所以「刷新」按钮是唯一的手动拉取点。
 * 不传 `sessionId`：本组件在设置页使用，没有"当前会话"的概念，列表展示的就是
 * 「全部会话的最近若干条」（见 `composables/snapshots.ts` 的注释）。
 *
 * 跨 IPC 只传字面量：类型从 `@aurora/shared` 导入（运行时值不经此组件，无需 browser 子路径）。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import type { SnapshotRef } from '@aurora/shared'
import AppButton from './AppButton.vue'
import { useSnapshots } from '../composables/snapshots.js'

const props = withDefaults(defineProps<{ limit?: number }>(), { limit: 5 })

const { items, loading, error, refresh, restore, prune } = useSnapshots({ limit: props.limit })

/** 正在二次确认的行（快照 id）：第一次点只把按钮文案换成「确认回滚？」，第二下才执行 */
const confirmingId = ref<string | null>(null)
/** 区块内回执（没有 toast）：短暂显示，4 秒后自灭 */
const message = ref<string | null>(null)
let messageTimer: number | null = null

/** 「立即清理」进行中标记：主进程按会话逐个淘汰可能要跑多轮，避免连点 */
const pruning = ref(false)
/** 「立即清理」的两段式确认标记（与逐条回滚的 `confirmingId` 分开，互不干扰） */
const confirmingPrune = ref(false)

/** `origin` 的中文口径：`rollback` 是**回滚前**留下的那一份（所以回滚也可再撤回） */
const SNAPSHOT_ORIGIN_LABELS: Record<SnapshotRef['origin'], string> = {
  write_file: '写文件',
  edit_file: '改文件',
  office_edit: 'Office 编辑',
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

function flashMessage(text: string): void {
  message.value = text
  if (messageTimer !== null) window.clearTimeout(messageTimer)
  messageTimer = window.setTimeout(() => {
    message.value = null
    messageTimer = null
  }, 4000)
}

/**
 * 两段式回滚（照 `AdvancedPage.vue` 的「确认重置？」写法）：
 * 第一次点进入确认态并清掉上一条回执，第二下才真的执行；成功后 hook 内部会 `refresh()`。
 */
async function onRestoreClick(id: string): Promise<void> {
  if (confirmingId.value !== id) {
    confirmingId.value = id
    message.value = null
    return
  }
  confirmingId.value = null
  const ok = await restore(id)
  flashMessage(ok ? '已回滚（回滚前的状态也留了一份备份）' : (error.value ?? '回滚失败'))
}

/**
 * 立即清理：本组件不传 `sessionId`，走 composable 的「全部会话」语义
 * （先列全量快照、按会话去重后逐个淘汰）。二次确认与回滚同款，防止手滑删光备份。
 */
async function onPruneClick(): Promise<void> {
  if (pruning.value) return
  if (!confirmingPrune.value) {
    confirmingPrune.value = true
    message.value = null
    return
  }
  confirmingPrune.value = false
  pruning.value = true
  const removed = await prune()
  pruning.value = false
  flashMessage(removed > 0 ? `已清理 ${removed} 份备份` : (error.value ?? '没有需要清理的备份'))
}

onMounted(() => {
  void refresh()
})

onUnmounted(() => {
  if (messageTimer !== null) window.clearTimeout(messageTimer)
  messageTimer = null
})
</script>

<template>
  <div class="snapshot-list" data-field="agent.snapshot-list">
    <!-- 操作行：刷新是唯一的手动拉取点（本组件不轮询）；清理走两段式确认 -->
    <div class="snapshot-actions">
      <button
        type="button"
        class="snapshot-refresh press"
        data-action="agent.snapshot-refresh"
        title="刷新（本列表不自动轮询）"
        :disabled="loading"
        @click="void refresh()"
      >
        刷新
      </button>
      <span class="grow" />
      <AppButton
        size="sm"
        variant="ghost"
        data-field="agent.snapshot-prune"
        title="按当前保留份数与总容量上限做一次淘汰（全部会话）"
        :disabled="pruning"
        @click="void onPruneClick()"
      >
        {{ confirmingPrune ? '确认清理？' : '立即清理' }}
      </AppButton>
    </div>

    <p v-if="items.length === 0" class="tiny muted snapshot-empty">
      还没有文件备份：Agent 写文件时会自动留底。
    </p>
    <ul v-else class="snapshot-rows">
      <li v-for="item in items" :key="item.id" class="snapshot-row">
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
          data-field="agent.snapshot-restore"
          :title="
            item.exists
              ? `回到 ${snapshotTime(item.createdAt)} 的这一份（回滚前也会先留一份）`
              : '这份快照记录的是「当时文件还不存在」：回滚会删除该文件'
          "
          @click="void onRestoreClick(item.id)"
        >
          {{ confirmingId === item.id ? '确认回滚？' : '回滚' }}
        </AppButton>
      </li>
    </ul>

    <!-- 回执 / 失败原因：用块内一行文案（成功那条 4 秒后自灭） -->
    <p v-if="message" class="tiny muted snapshot-message">{{ message }}</p>
    <p v-else-if="error" class="tiny snapshot-error">{{ error }}</p>
  </div>
</template>

<style scoped>
.snapshot-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--fill-1);
  box-shadow: var(--shadow-hairline);
}

.snapshot-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.snapshot-actions .grow {
  flex: 1;
  min-width: 0;
}

/* 条目列表：窄容器（约 260-300px）与设置页宽容器共用 —— 靠 meta 侧收缩让位，不横向溢出 */
.snapshot-rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
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

.snapshot-empty {
  margin: 0;
}

.snapshot-message {
  margin: 0;
}

/* 失败原因（回滚 / 读取 / 清理失败）：比空态文案重，用错误色 */
.snapshot-error {
  margin: 0;
  color: var(--status-error);
}

/* 刷新：纯文本小按钮，与操作行同高 —— 本列表不轮询，这个入口是唯一的手动拉取点 */
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
