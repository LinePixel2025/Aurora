/**
 * PTY 终端服务（右栏「终端」tab，2026-10-03，docs/07 §2.3）。
 *
 * 设计口径：
 * - **每个窗口一个常驻 shell**（按发起窗口的 `webContents.id` 记账）：切 tab 不杀 ——
 *   渲染层的 xterm 实例同样按模块级单例跨重挂载存活（scrollback 不丢），
 *   两边合起来才是「终端是持续存在的会话」；窗口销毁时 shell 一起 kill。
 * - 输出**只推给创建它的窗口**（`webContents.send` 直发，不走全窗口广播）：
 *   终端输出可能是每秒上百次的高频流，广播给提示条 / 设置窗纯属浪费。
 * - 终端是**用户的手动操作面**：不进 AI 工具面、不接确认闸门、cwd 只按会话工作目录
   回落链解析一次（`sessionProjects.boundaryRoot`，解析不出落主目录）。
 * - @lydell/node-pty：node-pty 的预编译 fork（免本机 MSVC 工具链），
 *   打包时经 `asarUnpack` 解出（electron-builder.yml）。
 */
import { webContents } from 'electron'
import { homedir } from 'node:os'
import { spawn, type IPty } from '@lydell/node-pty'
import type { Logger } from '@aurora/shared'

interface TerminalEntry {
  pty: IPty
  senderId: number
  terminalId: string
}

export interface TerminalServiceDeps {
  logger: Logger
  /** 会话工作目录回落链（docs/06 §5.1）；解析不出 / 为空时落用户主目录 */
  rootOf(sessionId: string): string | undefined
}

/** shell 选择：Windows 全系自带 PowerShell；其它平台（将来）回落 $SHELL / bash */
function pickShell(): string {
  if (process.platform === 'win32') return 'powershell.exe'
  return process.env.SHELL ?? '/bin/bash'
}

export class TerminalService {
  private readonly deps: TerminalServiceDeps
  /** 键 = 发起窗口的 webContents.id（每窗口一个 shell） */
  private readonly terminals = new Map<number, TerminalEntry>()
  private counter = 0

  constructor(deps: TerminalServiceDeps) {
    this.deps = deps
  }

  /**
   * 取（或创建）发起窗口的常驻 shell。窗口已有 shell 时直接复用 ——
   * 渲染层重挂载（切 tab 回来）会重新订阅输出，PTY 侧的会话状态原样保留。
   */
  create(senderId: number, sessionId: string): { terminalId: string } {
    const existing = this.terminals.get(senderId)
    if (existing !== undefined) return { terminalId: existing.terminalId }

    const sender = webContents.fromId(senderId)
    if (sender === undefined || sender.isDestroyed()) {
      throw new Error('发起窗口已关闭，无法创建终端')
    }

    const cwd = this.deps.rootOf(sessionId) || homedir()
    const shell = pickShell()
    const pty = spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: process.env as Record<string, string>,
      // conpty 专门给终端宿主用的闭环：让 shell 知道自己跑在 PTY 里
      useConpty: process.platform === 'win32',
    })

    const terminalId = `term-${senderId}-${(this.counter += 1)}`
    const entry: TerminalEntry = { pty, senderId, terminalId }
    this.terminals.set(senderId, entry)

    pty.onData((data) => {
      const target = webContents.fromId(senderId)
      if (target === undefined || target.isDestroyed()) return
      target.send('terminal:data', { terminalId, data })
    })
    pty.onExit(({ exitCode }) => {
      this.terminals.delete(senderId)
      const target = webContents.fromId(senderId)
      if (target === undefined || target.isDestroyed()) return
      target.send('terminal:exit', { terminalId, exitCode })
    })
    // 窗口销毁时 shell 一起收掉：PTY 挂着孤儿 shell 直到应用退出才清理，是最差的默认
    sender.once('destroyed', () => {
      const current = this.terminals.get(senderId)
      if (current?.pty === pty) this.kill(senderId)
    })

    this.deps.logger.info('已创建 PTY 终端', { terminalId, shell, cwd, senderId })
    return { terminalId }
  }

  input(terminalId: string, data: string): void {
    const entry = this.findByTerminalId(terminalId)
    if (entry === undefined || data === '') return
    entry.pty.write(data)
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const entry = this.findByTerminalId(terminalId)
    if (entry === undefined) return
    // 夹取到 PTY 能接受的 sane 范围（0 或负数会被 conpty 拒绝）
    const safeCols = Math.min(500, Math.max(2, Math.floor(cols)))
    const safeRows = Math.min(300, Math.max(2, Math.floor(rows)))
    try {
      entry.pty.resize(safeCols, safeRows)
    } catch (error) {
      this.deps.logger.warn('终端 resize 失败（shell 可能刚退出）', {
        terminalId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** 主动关闭（渲染层「关闭终端」/ 窗口销毁 / 应用退出） */
  kill(senderId: number): void {
    const entry = this.terminals.get(senderId)
    if (entry === undefined) return
    this.terminals.delete(senderId)
    try {
      entry.pty.kill()
    } catch {
      /* 已退出的 shell kill 会抛：清理路径吞掉即可 */
    }
  }

  /** 渲染层 `terminal:kill` 入口：按 terminalId 反查后收掉 */
  killByTerminalId(terminalId: string): void {
    const entry = this.findByTerminalId(terminalId)
    if (entry === undefined) return
    this.kill(entry.senderId)
  }

  /** 应用退出前收掉全部 shell（index.ts 的 will-quit / before-quit 链上调用） */
  dispose(): void {
    for (const senderId of [...this.terminals.keys()]) this.kill(senderId)
  }

  private findByTerminalId(terminalId: string): TerminalEntry | undefined {
    for (const entry of this.terminals.values()) {
      if (entry.terminalId === terminalId) return entry
    }
    return undefined
  }
}
