<script setup lang="ts">
/**
 * 控制台（docs/12 §10）：`设备列表 | 会话流 | 控制面板` 三栏。
 *
 * - 主区独占全高，内容列 860px 中轴（与桌面端同一阅读动线）；右侧面板可收起（存 localStorage）；
 * - 待办栏（确认卡 + 提问卡）常驻主区顶部 —— 本地会话来源的卡片没有会话视图，只能在这里处理；
 * - 吸底跟随复用共享的 `useStickToBottom`（语义与桌面端逐字一致：意图只由真实输入发起、
 *   250ms 窗口按之后的读数重判、非跟随时显示「回到最新」）；
 * - ≤720px 单栏：设备列表与控制面板收进覆盖式抽屉，点开会话自动收起。
 */
import { computed, ref, watch } from 'vue'
import {
  activeSession,
  clientsSorted,
  openRemoteSession,
  selectedEntry,
  selectClient,
  sendFile,
  sessionViewTick,
  showNotice,
  startSession,
  state,
} from '../state'
import { api } from '../lib/api'
import { PanelRight, Paperclip, Plus, useStickToBottom } from '@aurora/shared/browser'
import ClientRail from '../components/console/ClientRail.vue'
import MessageStream from '../components/console/MessageStream.vue'
import Composer from '../components/console/Composer.vue'
import SessionPanel from '../components/console/SessionPanel.vue'
import PendingBar from '../components/console/PendingBar.vue'
import UsageStrip from '../components/console/UsageStrip.vue'
import FileStrip from '../components/console/FileStrip.vue'

const PANEL_KEY = 'aurora-center-panel-collapsed'

const contentRef = ref<HTMLElement | null>(null)
const { following, stick } = useStickToBottom(() => contentRef.value)

const panelCollapsed = ref(window.localStorage.getItem(PANEL_KEY) === '1')
const drawer = ref<'none' | 'rail' | 'panel'>('none')
const creating = ref(false)
const createError = ref('')

watch(panelCollapsed, (collapsed) => {
  window.localStorage.setItem(PANEL_KEY, collapsed ? '1' : '0')
})

/* 打开会话（含新建）后收起移动端抽屉：手机上主区才是主角 */
watch(sessionViewTick, () => {
  drawer.value = 'none'
})

const entry = computed(() => selectedEntry.value)
const session = computed(() => activeSession.value)

const remoteDisabled = computed(() => entry.value?.status?.center.allowRemoteSession === false)
const offline = computed(() => entry.value !== null && !entry.value.client.online)

const emptyHint = computed(() => {
  if (entry.value === null) {
    return '左侧还没有设备。在客户端的设置页开启 Aurora Center 并登录后，它会出现在这里。'
  }
  if (offline.value) return '这台设备已离线。它重新上线后（客户端会自动重连）就能继续操作。'
  if (remoteDisabled.value) {
    return '这台设备没有允许「远程会话」。请在客户端的设置页打开 Aurora Center 的对应开关。'
  }
  return ''
})

async function create(): Promise<void> {
  const target = entry.value
  if (target === null || creating.value) return
  creating.value = true
  createError.value = ''
  try {
    await startSession(target.client.clientId)
  } catch (error) {
    createError.value = error instanceof Error ? error.message : String(error)
  } finally {
    creating.value = false
  }
}

function onSelect(clientId: string): void {
  selectClient(clientId)
  drawer.value = 'none'
}

/** 设备列表点「新建会话」：先切到该设备再建（列表项与当前选中项可能不是同一台） */
async function createFor(clientId: string): Promise<void> {
  if (state.selectedClientId !== clientId) selectClient(clientId)
  await create()
}

/**
 * 「回到最新」走平滑滚动，但尊重系统「减少动态效果」：命中的用户是**主动**关掉动画的，
 * 平滑滚动的时间轴对他们同样属于"多余的动态"（与桌面端 `MessageList.jumpToLatest` 同款）。
 */
function jumpToLatest(): void {
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  stick(reduceMotion ? 'auto' : 'smooth')
}

function openSession(sessionId: string): void {
  const clientId = entry.value?.client.clientId
  if (clientId === undefined) return
  openRemoteSession(clientId, sessionId)
}

const sessionList = computed(() => entry.value?.remoteSessions ?? [])

/* ── 发送文件给客户端（docs/12 §5，本轮）─────────────────────────────
 * 门控口径同语音：客户端没有允许文件传输（`center.allowFileTransfer`）时
 * **连按钮都不渲染**（不是 disabled）—— 能力位来自 `ClientStatus.center`。 */
const fileInput = ref<HTMLInputElement | null>(null)
const sendingFile = ref(false)
const canSendFile = computed(
  () =>
    entry.value !== null &&
    entry.value.client.online &&
    entry.value.status?.center.allowFileTransfer === true,
)

function pickFile(): void {
  fileInput.value?.click()
}

async function onFilePicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // 同一个文件连发两次也要触发 change
  const target = entry.value
  if (!file || target === null || sendingFile.value) return
  sendingFile.value = true
  try {
    const uploaded = await api.uploadFile(file, target.client.clientId)
    await sendFile(target.client.clientId, uploaded.fileId)
  } catch (error) {
    showNotice(`发送文件失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    sendingFile.value = false
  }
}
</script>

<template>
  <div class="console" data-panel="console">
    <aside
      class="rail-drawer"
      data-field="rail-container"
      :class="{ 'drawer-open': drawer === 'rail' }"
    >
      <ClientRail
        :entries="clientsSorted"
        :selected-id="state.selectedClientId"
        @select="onSelect"
        @create="createFor"
      />
    </aside>
    <Transition name="fade">
      <div v-if="drawer !== 'none'" class="scrim" @click="drawer = 'none'" />
    </Transition>

    <section class="main">
      <div class="main-head">
        <button
          type="button"
          class="head-btn rail-toggle"
          data-action="console.open-rail"
          @click="drawer = drawer === 'rail' ? 'none' : 'rail'"
        >
          设备
        </button>
        <span class="main-title">{{ entry?.client.name ?? '未选择设备' }}</span>
        <span v-if="entry" class="main-sub">
          {{ entry.client.online ? '在线' : '离线' }} ·
          {{ entry.status?.mode ?? entry.client.mode }}
        </span>
        <span class="grow" />
        <button
          v-if="canSendFile"
          type="button"
          class="head-btn"
          data-action="console.send-file"
          :disabled="sendingFile"
          title="选择本机文件并发送到该客户端（保存到它的下载目录）"
          @click="pickFile"
        >
          <Paperclip :size="14" :stroke-width="1.8" aria-hidden="true" />
          发送文件
        </button>
        <input
          ref="fileInput"
          type="file"
          class="hidden-file-input"
          data-field="console.send-file-input"
          @change="onFilePicked"
        />
        <button
          v-if="session"
          type="button"
          class="head-btn"
          data-action="console.jump-latest"
          @click="jumpToLatest()"
        >
          回到最新
        </button>
        <button
          type="button"
          class="head-btn panel-toggle"
          data-action="console.toggle-panel"
          :title="panelCollapsed ? '展开控制面板' : '收起控制面板'"
          @click="panelCollapsed = !panelCollapsed"
        >
          <PanelRight :size="14" :stroke-width="1.8" aria-hidden="true" />
        </button>
      </div>

      <div class="stack">
        <PendingBar />

        <!-- data-session-id：给验证 harness 一个"当前会话是哪一个"的稳定读数
             （新建会话的 id 由服务器分配，网页这边只能从 DOM 上取） -->
        <div class="thread" :data-session-id="session?.sessionId ?? ''">
          <div ref="contentRef" class="thread-inner">
            <template v-if="session && entry">
              <UsageStrip :entry="entry" :session="session" />
              <FileStrip :entry="entry" />
              <MessageStream
                :session="session"
                :entry="entry"
                :following="following"
                @jump-latest="jumpToLatest()"
              />
            </template>

            <div v-else class="centered-note">
              <template v-if="emptyHint === '' && entry !== null">
                <p>这台设备还没有打开的会话。</p>
                <button
                  type="button"
                  class="btn-primary"
                  :disabled="creating"
                  data-action="console.new-session"
                  @click="create()"
                >
                  <Plus :size="14" :stroke-width="1.8" aria-hidden="true" />
                  {{ creating ? '正在创建…' : '新建远程会话' }}
                </button>
                <p v-if="createError" class="err">{{ createError }}</p>
                <ul v-if="sessionList.length > 0" class="session-choices">
                  <li v-for="item in sessionList.slice(0, 6)" :key="item.sessionId">
                    <button
                      type="button"
                      class="session-choice"
                      data-action="console.open-session"
                      @click="openSession(item.sessionId)"
                    >
                      {{ item.title || item.sessionId }}
                    </button>
                  </li>
                </ul>
              </template>
              <p v-else>{{ emptyHint }}</p>
            </div>
          </div>
        </div>

        <Composer v-if="session && entry" :session="session" :entry="entry" />
      </div>
    </section>

    <aside
      class="panel-drawer"
      data-field="panel-container"
      :class="{ collapsed: panelCollapsed, 'drawer-open': drawer === 'panel' }"
    >
      <SessionPanel :entry="entry" :session="session" />
    </aside>

    <nav class="mobile-tabs">
      <button
        type="button"
        class="head-btn"
        data-action="console.open-rail-mobile"
        @click="drawer = drawer === 'rail' ? 'none' : 'rail'"
      >
        设备
      </button>
      <button
        type="button"
        class="head-btn"
        data-action="console.open-panel-mobile"
        @click="drawer = drawer === 'panel' ? 'none' : 'panel'"
      >
        控制面板
      </button>
    </nav>
  </div>
</template>

<style scoped>
.console {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.rail-drawer {
  width: 264px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--fill-1);
  border-right: 1px solid var(--border-subtle);
  overflow: hidden;
}

.main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.main-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
  min-height: 44px;
}

.main-title {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.main-sub {
  color: var(--text-muted);
  font-size: var(--text-xs);
  flex: 0 0 auto;
}

.grow {
  flex: 1 1 auto;
}

.head-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: var(--control-h-sm);
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--text-xs);
  cursor: pointer;
  flex: 0 0 auto;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.head-btn:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.rail-toggle {
  display: none;
}

/*
 * 「发送文件」用的隐藏 file input（本轮 docs/12 §5）：`display: none` 的元素
 * 仍然可以被 `.click()` 程序化触发，因此不必用「视觉隐藏但占位」那套写法。
 */
.hidden-file-input {
  display: none;
}

.stack {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0 var(--space-4);
  gap: var(--space-2);
}

/* 会话流的滚动容器（吸底状态机从内容根向上找到的它） */
.thread {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-anchor: none;
}

.thread-inner {
  max-width: 860px;
  margin: 0 auto;
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.thread-inner > * {
  min-width: 0;
}

.session-choices {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  justify-content: center;
  margin: var(--space-2) 0 0;
  padding: 0;
  list-style: none;
}

.session-choice {
  min-height: var(--control-h-xs);
  padding: 0 var(--space-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-pill);
  background: var(--fill-1);
  color: var(--text-secondary);
  font-size: var(--text-xs);
  cursor: pointer;
  transition: background var(--transition-fast);
}

.session-choice:hover {
  background: var(--fill-2);
  color: var(--text-primary);
}

.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: var(--control-h-md);
  padding: 0 var(--space-4);
  border: none;
  border-radius: var(--radius-pill);
  background: var(--aurora-blue);
  color: var(--on-accent);
  font-size: var(--text-sm);
  cursor: pointer;
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: default;
}

.err {
  color: var(--danger-text);
  font-size: var(--text-xs);
}

.panel-drawer {
  width: 300px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border-subtle);
  background: var(--fill-1);
  overflow: hidden;
  /* 展开 / 收起是**布局级**过渡（宽度参与主区排版），提前提一层合成提示省掉首帧的抖动；
     只给这一处（及窄屏那两枚抽屉）——全站铺 `will-change` 会白占显存。 */
  will-change: width;
  transition:
    width var(--dur-base) var(--ease-spring),
    opacity var(--transition-fast);
}

.panel-drawer.collapsed {
  width: 0;
  opacity: 0;
  border-color: transparent;
}

.mobile-tabs,
.scrim {
  display: none;
}

@media (max-width: 960px) {
  .panel-drawer {
    width: 260px;
  }
}

@media (max-width: 720px) {
  .console {
    grid-template-columns: minmax(0, 1fr);
    /* 两行：主区吃掉剩余高度、底部标签栏按内容高（不写这一行，grid 的默认 stretch 会把
       标签栏拉成半屏高的巨型胶囊 —— harness 的 tabsHeight 读数实测 245px） */
    grid-template-rows: minmax(0, 1fr) auto;
    position: relative;
  }

  .rail-drawer,
  .panel-drawer {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: var(--z-flyout);
    width: min(84vw, 320px);
    box-shadow: var(--shadow-3);
    /* 移动端抽屉浮在消息流上（身后只有半透明 scrim），半透明 `--fill-1` 会把底下
       内容透出来 —— 换成它的不透明等价物 `--bg-raised`（桌面观感 = bg-base + fill-1 叠加） */
    background: var(--bg-raised);
    opacity: 0;
    pointer-events: none;
    /* 窄屏两枚抽屉走的是 transform + opacity（合成器属性），覆盖掉桌面那份 `width` 提示 */
    will-change: transform, opacity;
    transition:
      transform var(--dur-base) var(--ease-spring),
      opacity var(--transition-fast);
  }

  .rail-drawer {
    left: 0;
    border-right: 1px solid var(--border-subtle);
    transform: translateX(-8px);
  }

  .panel-drawer {
    right: 0;
    border-left: 1px solid var(--border-subtle);
    transform: translateX(8px);
    width: min(84vw, 320px);
  }

  .rail-drawer.drawer-open,
  .panel-drawer.drawer-open {
    opacity: 1;
    pointer-events: auto;
    transform: translateX(0);
  }

  .scrim {
    display: block;
    position: absolute;
    inset: 0;
    z-index: var(--z-sticky);
    background: var(--overlay-scrim);
  }

  .stack {
    padding: 0 var(--space-3);
  }

  .rail-toggle {
    display: inline-flex;
    min-height: var(--hit-target);
  }

  .panel-toggle {
    display: none;
  }

  .mobile-tabs {
    display: flex;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-3) var(--space-2);
    border-top: 1px solid var(--border-subtle);
  }

  .mobile-tabs .head-btn {
    flex: 1 1 0;
    justify-content: center;
    min-height: var(--hit-target);
    background: var(--fill-1);
  }
}
</style>
