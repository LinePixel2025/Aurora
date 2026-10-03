<script setup lang="ts">
/*
 * 右栏「终端」面板（2026-10-03，docs/07 §2.3）：PTY 交互终端。
 *
 * 生命周期口径（与主进程 `terminal-service.ts` 配合，2026-10-03 二次修订）：
 * - **每个标签一条 PTY**：本组件实例挂载时 `terminal:create` 出一条新 shell（主进程按
 *   `terminalId` 记账、每窗口上限 6），卸载（= 关闭标签）时 `terminal:kill` + xterm `dispose`
 *   —— 浏览器式语义：关标签就是关那个 shell。此前是「模块级单例 + 容器 detach/attach」，
 *   那是「每窗口一个常驻 shell」时代的做法，多标签下会让两个终端共用同一条 PTY。
 * - **切标签不重建**由父级保证（面板首次激活挂载、之后常驻，切走只是 display:none），
 *   所以这里不需要任何 detach 技巧，scrollback 天然保留。
 *
 * 主题：**固定黑底**（2026-10-03 用户口径：终端就该是黑的，不随系统明暗切换）。
 */
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const props = defineProps<{ sessionId: string }>()
const emit = defineEmits<{ (event: 'title', title: string): void }>()

/** xterm 配色：黑底浅字（xterm 吃不了 CSS 变量，色值写在这里；容器底色见 `.tp-host`） */
const XTERM_THEME = {
  background: '#000000',
  foreground: '#e6e6e6',
  cursor: '#4c9fff',
  selectionBackground: '#31445f',
  black: '#1a1a1a',
  brightBlack: '#6b6b6b',
} as const

const hostEl = ref<HTMLElement | null>(null)
const exited = ref(false)
const starting = ref(false)
/** 本标签的 PTY id（创建回执；shell 退出后失效）—— 同时是探针读数（多终端互异） */
const terminalId = ref('')
/** shell 已退出时的重开入口文案（标题回落也用它） */
const shellLabel = ref('终端')

let term: Terminal | null = null
let fit: FitAddon | null = null
let offData: (() => void) | null = null
let offExit: (() => void) | null = null
let resizeObserver: ResizeObserver | null = null
let fitScheduled = false

/** 工作目录末段做标签标题（主进程 `TerminalCreateResult.cwd`）：多开时彼此可辨 */
function labelOfCwd(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '')
  const segment = trimmed.split(/[\\/]/).pop() ?? ''
  return segment === '' ? '终端' : segment
}

function fitNow(): void {
  if (term === null || fit === null || hostEl.value === null) return
  const rect = hostEl.value.getBoundingClientRect()
  if (rect.width < 40 || rect.height < 40) return
  fit.fit()
  const cols = term.cols
  const rows = term.rows
  if (terminalId.value !== '') {
    void window.aurora.terminal.resize({ terminalId: terminalId.value, cols, rows })
  }
}

/**
 * 尺寸跟随：**挂在容器上的 ResizeObserver** 是主路径 —— 左 / 右栏拖拽调宽、窗口缩放、
 * 标签激活（面板从 display:none 回来）都会让容器尺寸变化，只挂 window resize
 * 会让 PTY 停在旧列数。用 rAF 合并同一帧内的多次触发。
 */
function scheduleFit(): void {
  if (fitScheduled) return
  fitScheduled = true
  window.requestAnimationFrame(() => {
    fitScheduled = false
    fitNow()
  })
}

function onWindowResize(): void {
  scheduleFit()
}

async function startShell(): Promise<void> {
  if (term === null || terminalId.value !== '' || starting.value) return
  starting.value = true
  try {
    const result = await window.aurora.terminal.create({ sessionId: props.sessionId })
    if (!result.ok) {
      term.write(`\r\n\x1b[31m终端创建失败：${result.message}\x1b[0m\r\n`)
      return
    }
    terminalId.value = result.value.terminalId
    exited.value = false
    shellLabel.value = labelOfCwd(result.value.cwd)
    emit('title', shellLabel.value)
    // 创建成功后先对齐一次尺寸（PTY 起始 80×24，与本面板实际大小几乎必然不同）
    fitNow()
  } finally {
    starting.value = false
  }
}

onMounted(() => {
  const element = new Terminal({
    fontSize: 12,
    fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
    cursorBlink: true,
    convertEol: false,
    scrollback: 5000,
    theme: XTERM_THEME,
  })
  const addon = new FitAddon()
  element.loadAddon(addon)
  term = element
  fit = addon

  element.onData((data) => {
    if (terminalId.value === '') return
    void window.aurora.terminal.input({ terminalId: terminalId.value, data })
  })
  // 输出订阅：**按 terminalId 过滤**（同窗口可能同时开着多个终端，别人的输出不许串进来）
  offData = window.aurora.terminal.onData((event) => {
    if (event.terminalId !== terminalId.value) return
    element.write(event.data)
  })
  offExit = window.aurora.terminal.onExit((event) => {
    if (event.terminalId !== terminalId.value) return
    terminalId.value = ''
    exited.value = true
    element.write(`\r\n\x1b[2m[shell 已退出，exit code ${event.exitCode}]\x1b[0m\r\n`)
  })

  if (hostEl.value !== null) {
    // xterm 自己把它的 DOM 挂进宿主：面板常驻（首次激活挂载），不需要 detach/attach 技巧
    element.open(hostEl.value)
  }
  emit('title', shellLabel.value)
  void startShell()
  window.addEventListener('resize', onWindowResize)
  if (typeof ResizeObserver === 'function' && hostEl.value !== null) {
    resizeObserver = new ResizeObserver(() => scheduleFit())
    resizeObserver.observe(hostEl.value)
  }
  // 首帧布局后 fit 一次（挂载时容器尺寸可能还是 0）
  window.requestAnimationFrame(() => fitNow())
})

onUnmounted(() => {
  window.removeEventListener('resize', onWindowResize)
  resizeObserver?.disconnect()
  resizeObserver = null
  offData?.()
  offData = null
  offExit?.()
  offExit = null
  // 关标签 = 关 shell（浏览器式语义）：PTY 由主进程收掉，xterm 自己 dispose
  if (terminalId.value !== '') {
    void window.aurora.terminal.kill({ terminalId: terminalId.value })
    terminalId.value = ''
  }
  term?.dispose()
  term = null
  fit = null
})

/** shell 退出后的「重新打开」：清掉旧标记再走 create（主进程会 spawn 新 shell） */
function restart(): void {
  if (terminalId.value !== '') return
  exited.value = false
  void startShell()
}

watch(hostEl, (el) => {
  if (el !== null) window.requestAnimationFrame(() => fitNow())
  else window.removeEventListener('resize', onWindowResize)
})
</script>

<template>
  <div class="tp" data-field="chat.terminal">
    <div class="tp-bar">
      <span class="tiny muted">{{ shellLabel }}</span>
      <span class="grow" />
      <button
        v-if="exited"
        type="button"
        class="tp-restart tiny"
        data-field="chat.terminal-restart"
        @click="restart"
      >
        重新打开
      </button>
    </div>
    <!-- `data-terminal-id` 挂在宿主上：capture 的 `chat-ctx-tabs` 探针靠它证明
         「两个终端标签是两条不同的 PTY」（只数 DOM 个数是数不出共用一条 shell 的） -->
    <div
      ref="hostEl"
      class="tp-host"
      data-field="chat.terminal-host"
      :data-terminal-id="terminalId"
    />
  </div>
</template>

<style scoped>
.tp {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  padding: var(--space-2);
  gap: var(--space-1);
}

.tp-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.tp-restart {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-secondary);
  padding: 1px 8px;
  cursor: pointer;
}

.tp-restart:hover {
  color: var(--text-primary);
  border-color: var(--border-strong);
}

.tp-host {
  flex: 1 1 auto;
  min-height: 0;
  border-radius: var(--radius-sm);
  overflow: hidden;
  /* 固定黑底（终端容器与 xterm 的 theme.background 同色）：挂载首帧 / shell 启动前
     也不会闪一块浅色底（浅色系统下此前正是白底） */
  background: #000000;
}

.tp-host :deep(.xterm) {
  height: 100%;
  padding: 4px;
}
</style>
