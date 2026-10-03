/**
 * PTY 终端服务（右栏「终端」标签，2026-10-03，docs/07 §2.3）。
 *
 * 设计口径：
 * - **每个终端标签一个 shell**（2026-10-03 二次修订）：右栏成了可多开的标签容器，
 *   每次 `terminal:create` 都 spawn 一个新的 PTY，按 `terminalId` 记账 ——
 *   此前是「每窗口一个 shell」（`Map<webContentsId>`），两个终端标签会共用同一条 PTY。
 *   每个窗口上限 `MAX_TERMINALS_PER_WINDOW`（防止一次点出十几个 PowerShell）；
 *   窗口销毁时该窗口**全部** shell 一起 kill，应用退出统一 dispose。
 * - 输出**只推给创建它的窗口**（`webContents.send` 直发，不走全窗口广播）：
 *   终端输出可能是每秒上百次的高频流，广播给提示条 / 设置窗纯属浪费。
 * - 终端是**用户的手动操作面**：不进 AI 工具面、不接确认闸门、cwd 只按会话工作目录
 *   回落链在**创建那一刻**解析一次（`sessionProjects.boundaryRoot`，解析不出落主目录）；
 *   关标签 = kill 那条 PTY（浏览器式语义），不做后台保活。
 * - @lydell/node-pty：node-pty 的预编译 fork（免本机 MSVC 工具链），
 *   打包时经 `asarUnpack` 解出（electron-builder.yml）。
 */
import { webContents } from 'electron'
import { homedir } from 'node:os'
import { spawn, type IPty } from '@lydell/node-pty'
import type { Logger } from '@aurora/shared'

interface TerminalEntry {
  pty: IPty
  /** 创建它的窗口（输出只回这个窗口；窗口销毁时按它成批收） */
  senderId: number
  terminalId: string
  /** 创建时解析出的工作目录（回执带给渲染层做标签标题） */
  cwd: string
}

/** 每个窗口的终端上限：右栏标签本身有 12 上限，这里再兜一层 shell 数量 */
export const MAX_TERMINALS_PER_WINDOW = 6

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
  /** 键 = terminalId（每标签一条 PTY） */
  private readonly terminals = new Map<string, TerminalEntry>()
  /** 已挂过 `destroyed` 钩子的窗口：每窗口只挂一次，避免按终端重复挂 */
  private readonly hookedSenders = new Set<number>()
  private counter = 0

  constructor(deps: TerminalServiceDeps) {
    this.deps = deps
  }

  /**
   * 新建一条 PTY（**不复用**：每次调用都是一个新 shell）。创建失败（窗口没了 / 到上限）
   * 抛中文错误，由 `ipc.ts` 折成 `E_INVALID_STATE` 回执 —— 渲染层面板据此显示原因。
   */
  create(senderId: number, sessionId: string): { terminalId: string; cwd: string } {
    const sender = webContents.fromId(senderId)
    if (sender === undefined || sender.isDestroyed()) {
      throw new Error('发起窗口已关闭，无法创建终端')
    }
    if (this.countOfSender(senderId) >= MAX_TERMINALS_PER_WINDOW) {
      throw new Error(
        `终端数量已达上限（每个窗口最多 ${MAX_TERMINALS_PER_WINDOW} 个），先关掉一个再开`,
      )
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
    this.terminals.set(terminalId, { pty, senderId, terminalId, cwd })

    pty.onData((data) => {
      const target = webContents.fromId(senderId)
      if (target === undefined || target.isDestroyed()) return
      target.send('terminal:data', { terminalId, data })
    })
    pty.onExit(({ exitCode }) => {
      this.terminals.delete(terminalId)
      const target = webContents.fromId(senderId)
      if (target === undefined || target.isDestroyed()) return
      target.send('terminal:exit', { terminalId, exitCode })
    })

    // 窗口销毁时该窗口的 shell 一起收掉（PTY 挂着孤儿 shell 直到应用退出才清理，
    // 是最差的默认）。**每窗口只挂一次**：钩子内部按 senderId 成批 kill。
    if (!this.hookedSenders.has(senderId)) {
      this.hookedSenders.add(senderId)
      sender.once('destroyed', () => {
        this.hookedSenders.delete(senderId)
        this.killOfSender(senderId)
      })
    }

    this.deps.logger.info('已创建 PTY 终端', { terminalId, shell, cwd, senderId })
    return { terminalId, cwd }
  }

  input(terminalId: string, data: string): void {
    const entry = this.terminals.get(terminalId)
    if (entry === undefined || data === '') return
    entry.pty.write(data)
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const entry = this.terminals.get(terminalId)
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

  /** 主动关闭一条终端（渲染层关闭标签 / 窗口销毁 / 应用退出都会走到这里） */
  kill(terminalId: string): void {
    const entry = this.terminals.get(terminalId)
    if (entry === undefined) return
    this.terminals.delete(terminalId)
    try {
      entry.pty.kill()
    } catch {
      /* 已退出的 shell kill 会抛：清理路径吞掉即可 */
    }
  }

  /** 渲染层 `terminal:kill` 入口（语义与 kill 相同；ipc.ts 按这个名字调用） */
  killByTerminalId(terminalId: string): void {
    this.kill(terminalId)
  }

  /** 应用退出前收掉全部 shell（index.ts 的 will-quit / before-quit 链上调用） */
  dispose(): void {
    for (const terminalId of [...this.terminals.keys()]) this.kill(terminalId)
  }

  private countOfSender(senderId: number): number {
    let count = 0
    for (const entry of this.terminals.values()) {
      if (entry.senderId === senderId) count += 1
    }
    return count
  }

  private killOfSender(senderId: number): void {
    for (const entry of [...this.terminals.values()]) {
      if (entry.senderId === senderId) this.kill(entry.terminalId)
    }
  }
}
