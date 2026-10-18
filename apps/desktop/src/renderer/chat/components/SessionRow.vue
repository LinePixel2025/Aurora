<script setup lang="ts">
/**
 * 左栏会话行（2026-09-30 会话三分时自 SessionNav 抽出）：单行标题 + 相对时间 + hover 归档钮，
 * 项目对话 / 工作目录对话 / Agent对话 / 已归档四个分区**共用同一行组件**（视觉完全一致）。
 *
 * 会话项 + hover 归档钮是**同一行里的两个兄弟 button**（不嵌套）：
 * `.nav-item` 是会话选择按钮本身，右侧 `.row-action` 只负责归档 / 取消归档；
 * 行的 hover 底色挂在外层 `.nav-row`（`.hover-fill`）上——按钮是兄弟而不是子元素，
 * 挂在 `.nav-item` 上的话鼠标移到归档钮上时行底色会闪掉。
 *
 * 归档（docs/07 §2.3）：可逆、不弹确认；`archived` 决定这一行的动作是归档还是取消归档。
 * 本组件只展示与上报意图（emit），切换 / 归档落地都在 App.vue。
 *
 * `data-session-id`（2026-10-10）：行身份的**稳定锚点**，给 capture 探针用。
 * 背景：`chat-archive` 探针原先拿整行文本（`.nav-item` 的 textContent）当身份键，
 * 而那一行里含 `.item-time` 的相对时间 —— 跨分钟时同一行的文本会从「刚刚」变成
 * 「1 分钟前」，于是"归属"判定在计数已经正确迁移的情况下仍然失配（实测 payload：
 * `afterArchive:{mainRows:2,archiveRows:2,inArchive:false,inMain:false}`）。
 * 会话 id 是这一行唯一不会随渲染时间漂移的身份键；`.item-title` 只作标题展示，
 * 空标题会回落成「新会话」而重复，不能单独当身份键。
 */
import { computed } from 'vue'
import type { ChatSessionSummary } from '@aurora/shared'
import { CENTER_SESSION_PREFIX } from '@aurora/shared/browser'
import { Archive, ArchiveRestore } from '@aurora/shared/browser'

const props = defineProps<{
  item: ChatSessionSummary
  /** 当前会话 id（激活态判定） */
  activeId: string
  /** 已归档行：动作按钮换成「取消归档」（列表容器 / 锚点由外层分区负责） */
  archived?: boolean
}>()

const emit = defineEmits<{
  (event: 'select', id: string): void
  (event: 'toggleArchive', id: string, archived: boolean): void
}>()

const isActive = computed(() => props.item.id === props.activeId)
const title = computed(() => (props.item.title.trim() === '' ? '新会话' : props.item.title))
const isCenter = computed(() => props.item.id.startsWith(CENTER_SESSION_PREFIX))

/** 相对时间：刚刚 / N 分钟前 / 当天时刻 / 昨天 / 月-日（会话摘要来自 ISO 时间戳） */
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
</script>

<template>
  <div class="nav-row hover-fill" :data-session-id="item.id" :class="{ active: isActive }">
    <button
      type="button"
      class="nav-item press"
      :class="{ active: isActive }"
      :title="title"
      @click="emit('select', item.id)"
    >
      <span class="item-title">{{ title }}</span>
      <span v-if="isCenter" class="item-tag tiny" title="来自 Aurora Center 网页端">Center</span>
      <!--
        会话级模型徽标（docs/06 §3，本轮）：**只在覆盖态出现** —— 跟随全局时不显示，
        否则每一行都挂一个「模型」标签，等于没信息。`item-llm` 用与 Center 标签同款的小字风格。
      -->
      <span v-if="item.llm" class="item-tag item-llm tiny" :title="`本会话模型：${item.llm.model}`">
        {{ item.llm.model }}
      </span>
      <span class="item-time tiny muted">{{ formatRelativeTime(item.updatedAt) }}</span>
    </button>
    <!--
      归档（可逆、不弹确认，docs/07 §2.3）：单击即切换归档态。
      `@click.stop` 是防御性的——两者已是兄弟按钮，但将来若有人把行包进可点容器，
      少了它就会「顺手把会话也切了」。
    -->
    <button
      type="button"
      class="row-action press"
      :data-action="props.archived ? 'chat.unarchive-session' : 'chat.archive-session'"
      :title="props.archived ? '取消归档' : '归档'"
      :aria-label="props.archived ? '取消归档' : '归档'"
      @click.stop="emit('toggleArchive', item.id, props.archived !== true)"
    >
      <ArchiveRestore v-if="props.archived" :size="13" :stroke-width="1.6" aria-hidden="true" />
      <Archive v-else :size="13" :stroke-width="1.6" aria-hidden="true" />
    </button>
  </div>
</template>

<style scoped>
/* ── 列表项：单行（标题省略 + 时间右对齐）；激活态保留强调色指示条 ── */

.nav-row {
  display: flex;
  align-items: center;
  border-radius: var(--radius-sm);
}

.nav-row.active {
  background: var(--fill-2);
}

.nav-item {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  /* 窄栏硬护栏（2026-10-18）：行内文字**绝不许**画到右侧归档钮底下。
     起因（用户实测）：左栏拖到 200px 时行内容宽只剩 118px，96px 的模型徽标把标题挤成 0，
     相对时间溢出 18px 正好压在归档图标上 —— 看起来就是「文字重叠」。
     `overflow: hidden` 只兜底（正常让位靠下面 .item-title / .item-tag / .item-llm 的规则），
     命中兜底说明让位顺序又坏了，`chat-nav-narrow` 场景（`CHAT_NAV_NARROW_CHECK`）会量出来。 */
  overflow: hidden;
  /* 容器查询的锚点：`.item-llm` 按**本行可用宽度**决定是否让位（见文件末尾 @container） */
  container-type: inline-size;
  /* 32px：固定项（子代理 / 自动化 / 任务）与会话行都是高频点击，
     量出来原来只有 30px（`chat-hit-targets` 探针），补到 32 的手感线 */
  min-height: 32px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px var(--space-2) 6px var(--space-3);
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--text-secondary);
}

.nav-item.active {
  background: var(--fill-2);
  color: var(--text-primary);
}

/* 当前项：左侧 3px 强调色指示条 */
.nav-item.active::before {
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

/**
 * 行内动作钮（归档 / 取消归档）：hover 行时淡入。
 *
 * 展开态用**固定占位**（width/opacity 过渡）而不是收起时压成 0 宽：宽度变化会让
 * 「标题省略号 + 相对时间」在每次移入移出时抖一下。占位恒定则布局不动，只有透明度变化。
 * 不挂 `pointer-events: none`——保持可命中，探针与键盘都能稳定点到它
 * （鼠标压到它上面时必然已触发行的 :hover，按钮此刻是可见的；键盘 Tab 到它时用
 * `:focus-visible` 同样显形）。
 */
.row-action {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  /* 24×24：WCAG 2.2 SC 2.5.8（AA）的指针目标下限 —— 22px 在鼠标/触控板上就是"点了没反应"
     （2026-09-29 用 `chat-hit-targets` 探针量出来的真实违例，别再压回去） */
  width: 24px;
  height: 24px;
  margin-right: var(--space-1);
  border-radius: var(--radius-xs);
  color: var(--text-muted);
  opacity: 0;
  transition:
    opacity var(--transition-fast),
    background var(--transition-fast),
    color var(--transition-fast);
}

/* 触摸屏没有 hover（归档钮永远等不到显形的那一下）：无 hover 指针设备上常显 */
@media (hover: none) {
  .row-action {
    opacity: 1;
  }
}

.row-action svg {
  flex: 0 0 auto;
  stroke: currentColor;
}

.nav-row:hover .row-action,
.nav-row:focus-within .row-action,
.row-action:focus-visible {
  opacity: 1;
}

.row-action:hover {
  background: var(--fill-3);
  color: var(--text-primary);
}

/**
 * 标题是这一行的**身份信息**，优先级最高（2026-10-18）：
 *
 * `flex: 1 1 0%` 的旧口径在空间不足时会把标题直接算成 0 宽（basis 0 没有可收缩的量，
 * 剩余空间只分给别的项）—— 左栏拖到 200px、行里有模型徽标时，标题整条消失、
 * 只看得见徽标和时间。现在改成 `auto` + `min-width: 3em`：标题按内容宽度参与收缩，
 * 且**永远保留至少约 3 个汉字**的可见宽度（省略号照旧）。
 */
.item-title {
  flex: 1 1 auto;
  min-width: 3em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 相对时间：不收缩、不换行 —— 它是这一行的第二优先级，宁可让药丸让位，也不许它被挤出去 */
.item-time {
  flex: 0 0 auto;
  white-space: nowrap;
  font-variant-numeric: var(--num-tabular);
}

/*
 * 远程会话来源标签（center-*，docs/12 §5）：轻量药丸，弱于激活指示条。
 * `flex: 0 1 auto`（不是 0 0 auto）：空间不足时药丸**可以收缩**，否则它会把
 * 相对时间顶出行内容盒、压到归档钮底下（2026-10-18 用户实测的「文字重叠」）。
 */
.item-tag {
  flex: 0 1 auto;
  min-width: 0;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--aurora-blue) 16%, transparent);
  color: var(--accent-text);
  line-height: 16px;
  letter-spacing: 0;
}

/*
 * 模型徽标：它只是「这个会话绑过模型」的提示 —— 完整值在行 `title` 与输入区下拉里
 * 都能看全（docs/07 §5.4：关键信息看全的路径要留在手边）。`max-width: 96px` 允许
 * 收缩并省略号；**窄栏时整枚让位**（见文件末尾 @container）—— 左栏 200px 夹取下限下
 * 行内容宽只剩 ~118px，标题（≥3em）+ 相对时间已吃掉大半，再塞 96px 徽标只会把标题
 * 挤没、把时间顶到归档钮底下（2026-10-18 用户实测的「文字重叠」）。
 */
.item-llm {
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/**
 * 窄栏让位顺序（2026-10-18）：会话行内优先级 = **标题 > 相对时间 > Center 药丸 > 模型徽标**。
 * `.nav-item` 是查询容器（文件顶部 `container-type: inline-size`），阈值按**行内容宽**取：
 * 左栏 200px（夹取下限）时内容宽 ~118px —— 徽标在这里没有可用空间，整枚隐藏；
 * 缺省 240px（内容宽 ~158px）起恢复显示（仍可收缩 + 省略号）。
 * 探针 `CHAT_NAV_NARROW_CHECK`（场景 `chat-nav-narrow.png`）在左栏 200px 的现场量
 * 「徽标让位 + 标题不归零 + 相对时间不压归档钮」，`overflow: hidden` 只是最后一道兜底。
 */
@container (max-width: 150px) {
  .item-llm {
    display: none;
  }
}
</style>
