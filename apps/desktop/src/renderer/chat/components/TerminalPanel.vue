<script setup lang="ts">
/*
 * 右栏「终端」面板（2026-10-03，docs/07 §2.3）：PTY 交互终端。
 *
 * 生命周期口径（与主进程 `terminal-service.ts` 配合）：
 * - **主进程**每个窗口一个常驻 PTY shell（按窗口记账，切 tab 不杀、窗口销毁才 kill）；
 * - **渲染层** xterm 实例是**模块级单例**：tab 切走时本组件卸载，但 xterm 挂在
 *   一个模块级持有的容器元素上（detach 而不是 dispose），scrollback / 会话状态原样保留，
 *   切回来重新 attach。这就是「终端是持续存在的会话」而不是「每次点开的新输入框」。
 *
 * 主题：**固定黑底**（2026-10-03 用户口径：终端就该是黑的，不随系统明暗切换）。
 * 此前跟随 `prefers-color-scheme`，浅色系统下拿到白底黑字 —— 与「终端」的视觉预期不符。
 */
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const props = defineProps<{ sessionId: string }>()

/** xterm 配色：黑底浅字（xterm 吃不了 CSS 变量，色值写在这里；容器底色见 `.tp-host`） */
const XTERM_THEME = {
  background: '#000000',
  foreground: '#e6e6e6',
  cursor: '#4c9fff',
  selectionBackground: '#31445f',
  black: '#1a1a1a',
  brightBlack: '#6b6b6b',
} as const

interface TerminalSession {
  term: Terminal
  fit: FitAddon
  container: HTMLElement
  /** 主进程的终端 id（create 回执；exit 后失效） */
  terminalId: string | null
  /** shell 已退出：面板显示「已退出」状态条，重开走 create（新 shell） */
  exited: boolean
}

/**
 * 模块级单例：主窗口的终端会话。detach 后 DOM 树仍在内存里，xterm 的输出缓冲
 * 与滚动位置都保留；edge-bar / 设置窗没有终端 tab，不会与主窗口争用。
 */
let session: TerminalSession | null = null

const hostEl = ref<HTMLElement | null>(null)
const exited = ref(false)
const starting = ref(false)

function ensureSession(): TerminalSession {
  if (session !== null) return session
  const term = new Terminal({
    fontSize: 12,
    fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
    cursorBlink: true,
    convertEol: false,
    scrollback: 5000,
    theme: XTERM_THEME,
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.onData((data) => {
    if (session?.terminalId !== null && session?.terminalId !== undefined) {
      void window.aurora.terminal.input({ terminalId: session.terminalId, data })
    }
  })
  const container = document.createElement('div')
  container.className = 'aurora-terminal-host'
  container.style.width = '100%'
  container.style.height = '100%'
  term.open(container)
  session = { term, fit, container, terminalId: null, exited: false }

  // 输出订阅挂在模块级（跟随 PTY 生命周期而不是组件挂载）：tab 切走时输出照常入缓冲
  window.aurora.terminal.onData((event) => {
    if (session === null || event.terminalId !== session.terminalId) return
    session.term.write(event.data)
  })
  window.aurora.terminal.onExit((event) => {
    if (session === null || event.terminalId !== session.terminalId) return
    session.exited = true
    session.terminalId = null
    exited.value = true
    session.term.write(`\r\n\x1b[2m[shell 已退出，exit code ${event.exitCode}]\x1b[0m\r\n`)
  })
  return session
}

async function startShell(): Promise<void> {
  const current = ensureSession()
  if (current.terminalId !== null || starting.value) return
  starting.value = true
  try {
    const result = await window.aurora.terminal.create({ sessionId: props.sessionId })
    if (!result.ok) {
      current.term.write(`\r\n\x1b[31m终端创建失败：${result.message}\x1b[0m\r\n`)
      return
    }
    current.terminalId = result.value.terminalId
    current.exited = false
    exited.value = false
    // 创建成功后先对齐一次尺寸（PTY 起始 80×24，与本面板实际大小几乎必然不同）
    fitNow()
  } finally {
    starting.value = false
  }
}

function fitNow(): void {
  if (session === null || hostEl.value === null) return
  const rect = hostEl.value.getBoundingClientRect()
  if (rect.width < 40 || rect.height < 40) return
  session.fit.fit()
  const cols = session.term.cols
  const rows = session.term.rows
  if (session.terminalId !== null) {
    void window.aurora.terminal.resize({ terminalId: session.terminalId, cols, rows })
  }
}

/**
 * 尺寸跟随：**挂在容器上的 ResizeObserver** 是主路径 —— 左 / 右栏拖拽调宽、窗口缩放、
 * 面板重挂载都会让容器尺寸变化，而窗口 `resize` 事件在这三种里只覆盖第二种
 * （2026-10-03 起两侧侧栏都可拖拽，只靠 window resize 会让 PTY 停留在旧列数）。
 * 用 rAF 合并同一帧内的多次触发。
 */
let resizeObserver: ResizeObserver | null = null
let fitScheduled = false

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

onMounted(() => {
  const current = ensureSession()
  // attach：模块级容器挪进本组件的挂载点（切 tab 回来时 DOM 回到文档流）
  if (hostEl.value !== null && current.container.parentElement !== hostEl.value) {
    hostEl.value.appendChild(current.container)
  }
  exited.value = current.exited
  void startShell()
  fitNow()
  window.addEventListener('resize', onWindowResize)
  if (typeof ResizeObserver === 'function' && hostEl.value !== null) {
    resizeObserver = new ResizeObserver(() => scheduleFit())
    resizeObserver.observe(hostEl.value)
  }
})

onUnmounted(() => {
  window.removeEventListener('resize', onWindowResize)
  resizeObserver?.disconnect()
  resizeObserver = null
  // detach（不 dispose）：xterm 与容器留在模块级，下次挂载原样接回
  session?.container.remove()
})

/** shell 退出后的「重新打开」：清掉旧标记再走 create（主进程会 spawn 新 shell） */
function restart(): void {
  if (session === null || session.terminalId !== null) return
  exited.value = false
  void startShell()
}
watch(hostEl, (el) => {
  if (el !== null) {
    // 首帧布局后 fit 一次（挂载时容器尺寸可能还是 0）
    window.requestAnimationFrame(() => fitNow())
  } else {
    window.removeEventListener('resize', onWindowResize)
  }
})
</script>

<template>
  <div class="tp" data-field="chat.terminal">
    <div class="tp-bar">
      <span class="tiny muted">PowerShell</span>
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
    <div ref="hostEl" class="tp-host" data-field="chat.terminal-host" />
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
