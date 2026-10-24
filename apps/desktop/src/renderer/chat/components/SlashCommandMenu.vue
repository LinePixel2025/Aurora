<script setup lang="ts">
/*
 * 斜杠命令浮层（输入框，2026-09 输入框重做：docs/07 §2.3）。
 *
 * 纯展示组件：**列表由调用方过滤好后传进来**，键盘（↑↓ / Enter / Tab / Esc）也由调用方
 * 在 textarea 上处理 —— 焦点自始至终留在输入框里，浮层只是键位操作的可视反馈。
 * 组件自己只做两件带 DOM 的事：把高亮项滚进可视区，以及鼠标悬停 / 点击时回报选中项。
 *
 * 条目分三类（`kind`，视觉上分组）：
 * - `command`：客户端命令（新对话 / 清空 / 停止 / 打开设置 / 子代理）—— 选中即执行；
 * - `plugin-command`：插件斜杠命令（docs/14 §3.3）—— `action` 选中即执行，`prompt` 只补全；
 * - `skill`：Skill 显式调用（`/技能名`）—— 选中只把 `/技能名 ` 填进输入框，用户接着写需求。
 */
import { computed, ref, watch } from 'vue'
import type { SlashItem } from '../slashCommands.js'
import { Blocks, ChevronRight, Command, Puzzle } from '@aurora/shared/browser'

const props = defineProps<{
  /** 已过滤 + 排序的候选（空数组时整块不渲染） */
  items: SlashItem[]
  /** 当前高亮项下标（由调用方的键盘处理维护） */
  activeIndex: number
}>()

const emit = defineEmits<{
  (event: 'select', item: SlashItem): void
  (event: 'hover', index: number): void
}>()

const listEl = ref<HTMLElement | null>(null)

/** 是否已输入到「命令名」区间：调用方过滤后可能把 `command` 与 `skill` 混在一起 */
const commands = computed(() => props.items.filter((item) => item.kind === 'command'))
const pluginCommands = computed(() => props.items.filter((item) => item.kind === 'plugin-command'))
const skills = computed(() => props.items.filter((item) => item.kind === 'skill'))

/**
 * 高亮项滚进可视区。
 *
 * `block: 'nearest'` 而不是 `center`：键盘连按时不该让列表整体跳动，只需保证当前项可见。
 * 用 `scrollIntoView` 前先确认元素是浮层的后代 —— 分组渲染下 `children` 的索引与
 * `items` 的下标不是一一对应（有分组标题节点），因此按 `data-index` 查找。
 */
watch(
  () => props.activeIndex,
  (index) => {
    const node = listEl.value?.querySelector<HTMLElement>(`[data-index="${index}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  },
)

function indexOf(item: SlashItem): number {
  return props.items.findIndex((candidate) => candidate.id === item.id)
}
</script>

<template>
  <div
    v-if="items.length > 0"
    class="slash glass-panel composer-flyout"
    role="listbox"
    data-field="chat.slash-menu"
  >
    <div ref="listEl" class="slash-list">
      <template v-if="commands.length > 0">
        <p class="slash-group tiny muted">命令</p>
        <button
          v-for="item in commands"
          :key="item.id"
          type="button"
          class="slash-item"
          role="option"
          :aria-selected="indexOf(item) === activeIndex"
          :class="{ active: indexOf(item) === activeIndex }"
          :data-index="indexOf(item)"
          :data-field="`chat.slash-${item.name}`"
          :data-kind="item.kind"
          @mouseenter="emit('hover', indexOf(item))"
          @click="emit('select', item)"
        >
          <Command class="slash-icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
          <span class="slash-body">
            <span class="slash-name mono">/{{ item.name }}</span>
            <span class="tiny muted slash-desc">{{ item.label }} — {{ item.description }}</span>
          </span>
          <ChevronRight class="slash-go" :size="12" :stroke-width="2" aria-hidden="true" />
        </button>
      </template>

      <template v-if="pluginCommands.length > 0">
        <p class="slash-group tiny muted">插件命令</p>
        <button
          v-for="item in pluginCommands"
          :key="item.id"
          type="button"
          class="slash-item"
          role="option"
          :aria-selected="indexOf(item) === activeIndex"
          :class="{ active: indexOf(item) === activeIndex }"
          :data-index="indexOf(item)"
          :data-field="`chat.slash-${item.name}`"
          :data-kind="item.kind"
          @mouseenter="emit('hover', indexOf(item))"
          @click="emit('select', item)"
        >
          <Blocks class="slash-icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
          <span class="slash-body">
            <span class="slash-name mono">/{{ item.name }}</span>
            <span class="tiny muted slash-desc">{{ item.description }}</span>
          </span>
          <ChevronRight class="slash-go" :size="12" :stroke-width="2" aria-hidden="true" />
        </button>
      </template>

      <template v-if="skills.length > 0">
        <p class="slash-group tiny muted">技能</p>
        <button
          v-for="item in skills"
          :key="item.id"
          type="button"
          class="slash-item"
          role="option"
          :aria-selected="indexOf(item) === activeIndex"
          :class="{ active: indexOf(item) === activeIndex }"
          :data-index="indexOf(item)"
          :data-field="`chat.slash-${item.name}`"
          :data-kind="item.kind"
          @mouseenter="emit('hover', indexOf(item))"
          @click="emit('select', item)"
        >
          <Puzzle class="slash-icon" :size="13" :stroke-width="1.8" aria-hidden="true" />
          <span class="slash-body">
            <span class="slash-name mono">/{{ item.name }}</span>
            <span class="tiny muted slash-desc">{{ item.description }}</span>
          </span>
          <ChevronRight class="slash-go" :size="12" :stroke-width="2" aria-hidden="true" />
        </button>
      </template>
    </div>
    <p class="slash-hint tiny muted">
      <span class="slash-hint-group"><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
      <span class="slash-hint-sep" aria-hidden="true">·</span>
      <span class="slash-hint-group">
        <kbd>Enter</kbd> 确认<template v-if="commands.length > 0">（命令直接执行）</template>
      </span>
      <span class="slash-hint-sep" aria-hidden="true">·</span>
      <span class="slash-hint-group"><kbd>Esc</kbd> 关闭</span>
    </p>
  </div>
</template>

<style scoped>
/*
 * 浮层贴在**输入卡**（`.composer-box`，唯一的定位祖先）上方：
 * 输入框在窗口底部，向下弹没有空间。
 * 2026-10-18：定位 / 宽度 / 层级 / 材质来自共享的 `.composer-flyout`（与权限 / 模型 /
 * 思考 / 上下文详解**同一份**锚点与 `--composer-flyout-width`，docs/07 §2.3）。
 * 这里只补一层「卡片内部怎么排」：列表自己滚、键位提示钉在底部（长列表时提示不跟着滚走）。
 * `overflow: hidden` 覆盖 flyout 的纵向 auto —— 滚动交给内层列表，避免双重滚动条。
 */
.slash {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 列表是唯一的滚动区：高度上限由 `.composer-flyout` 的 max-height 决定，这里只管溢出滚动 */
.slash-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--space-1);
}

.slash-group {
  margin: 4px var(--space-2) 2px;
  letter-spacing: 0.02em;
}

.slash-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 5px var(--space-2);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-primary);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

/* 高亮态是键盘与鼠标共用的一处状态：鼠标悬停只是把同一条高亮移过来 */
.slash-item.active {
  background: var(--fill-2);
}

.slash-icon {
  flex: 0 0 auto;
  color: var(--text-muted);
}

.slash-item.active .slash-icon {
  color: var(--accent-text);
}

.slash-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1 1 auto;
}

.slash-name {
  font-size: var(--text-sm);
  color: var(--text-primary);
}

.slash-desc {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slash-go {
  flex: 0 0 auto;
  color: var(--text-muted);
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.slash-item.active .slash-go {
  opacity: 1;
}

/*
 * 键位提示：浮层宽度固定为 `--composer-flyout-width`（320px，2026-10-18 起与权限 / 模型 /
 * 思考 / 上下文同宽），一行放不下时只在**组之间**换行 —— 每一组用 nowrap 包住，
 * 否则中文会在「命令直接执 / 行」这种词中间断开（视觉上像文本被裁了）。
 */
.slash-hint {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 4px;
  margin: 0;
  padding: 5px var(--space-3);
  border-top: 1px solid var(--border-subtle);
  background: var(--fill-1);
}

.slash-hint-group,
.slash-hint-sep {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.slash-hint kbd {
  padding: 0 4px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--border-subtle);
  background: var(--fill-2);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
</style>
