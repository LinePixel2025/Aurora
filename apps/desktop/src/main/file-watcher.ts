/**
 * 智慧感知文件夹监听（docs/05 §3.1、ADR-006）。
 *
 * 关键点：
 * - **只监听第一层**（`depth: 0`）：科目文件夹就建在感知文件夹内，
 *   若递归监听，每移动一次文件都会触发新一轮事件，形成自触发循环；
 * - **稳定判定**：`awaitWriteFinish` 要求文件大小在 `stabilityThreshold` 内保持不变，
 *   等价于 docs/05 §3.1 的「连续两次 stat 尺寸不变」，避免把"还在复制中"的文件提前处理；
 * - **忽略**：隐藏文件、Office 临时文件（`~$*`）、下载中间态（`*.crdownload`/`*.part`）、
 *   系统缩略图缓存（`Thumbs.db`/`.DS_Store`）；
 * - **抑制集**：刚被本管线移走的路径不再入队（双保险，防 chokidar 延迟事件）。
 */
import { basename, relative } from 'node:path'
import { promises as fs } from 'node:fs'
import chokidar from 'chokidar'

export interface WatchedFile {
  path: string
  fileName: string
  ext: string
  sizeBytes: number
}

/** chokidar 的最小结构面（便于单测注入假实现） */
export interface WatcherLike {
  on(event: 'add', listener: (path: string) => void): unknown
  on(event: 'error', listener: (error: unknown) => void): unknown
  close(): Promise<void>
}

export interface FileWatcherOptions {
  logger?: {
    info(message: string, detail?: Record<string, unknown>): void
    debug(message: string, detail?: Record<string, unknown>): void
    warn(message: string, detail?: Record<string, unknown>): void
  }
  /** 新建监听实例；默认用 chokidar。单测注入假实现。 */
  createWatcher?: (dir: string) => WatcherLike
  /** 读取文件大小；默认 fs.stat。读不到（文件已消失）返回 undefined → 跳过 */
  statSize?: (path: string) => Promise<number | undefined>
  /** 文件稳定判定窗口，默认 800ms（docs/05 §3.1） */
  stabilityThresholdMs?: number
  /** 轮询间隔，默认 100ms */
  pollIntervalMs?: number
}

/** docs/05 §3.1 忽略规则 */
export function shouldIgnore(fileName: string): boolean {
  const lower = fileName.toLowerCase()
  if (fileName.startsWith('.')) return true
  if (fileName.startsWith('~$')) return true
  if (lower.endsWith('.tmp') || lower.endsWith('.temp')) return true
  if (lower.endsWith('.part') || lower.endsWith('.crdownload') || lower.endsWith('.download')) {
    return true
  }
  if (lower === 'thumbs.db' || lower === 'desktop.ini' || lower === '.ds_store') return true
  // 编辑器 / 工具的原子写残留
  if (lower.endsWith('.swp') || lower.endsWith('.swo')) return true
  return false
}

export class AuroraFileWatcher {
  private readonly options: FileWatcherOptions
  private watcher: WatcherLike | undefined
  private dir = ''
  /**
   * 当前有效的监听代次。`stop()` / 换目录时自增，
   * 使**旧 watcher 迟到的事件**被丢弃（chokidar 关闭后仍可能投递已排队事件）。
   */
  private generation = 0
  /** 刚被管线移走的路径：忽略其后续事件 */
  private readonly suppressed = new Set<string>()

  constructor(options: FileWatcherOptions = {}) {
    this.options = options
  }

  /** 开始监听 `dir`；重复调用会先停掉旧监听（幂等）。 */
  async watch(dir: string): Promise<void> {
    await this.stop()
    this.dir = dir
    const generation = ++this.generation
    const watcher = this.createWatcher(dir)
    watcher.on('add', (path) => void this.handleAdd(path, generation))
    watcher.on('error', (error) => {
      this.options.logger?.warn('文件监听出错（不影响其它功能）', { error: String(error) })
    })
    this.watcher = watcher
    this.options.logger?.info('已开始监听智慧感知文件夹', { dir })
  }

  /** 停止监听（模式停用 / 关闭时调用）。 */
  async stop(): Promise<void> {
    const watcher = this.watcher
    this.watcher = undefined
    this.dir = ''
    // 自增代次：此后旧 watcher 的任何迟到事件一律丢弃
    this.generation += 1
    if (watcher) {
      await watcher.close().catch(() => undefined)
      this.options.logger?.debug('已停止监听智慧感知文件夹')
    }
  }

  get watching(): boolean {
    return this.watcher !== undefined
  }

  get watchDir(): string {
    return this.dir
  }

  /**
   * 标记路径为「管线自己造成的变动」。
   * 分类落盘后调用，避免目标路径的 add 事件被当成新文件。
   */
  suppress(path: string): void {
    this.suppressed.add(path)
    // 抑制集不需要永久保留：chokidar 的延迟事件通常在秒级到达
    setTimeout(() => this.suppressed.delete(path), 30_000).unref?.()
  }

  // ───────────────────────── 内部 ─────────────────────────

  private createWatcher(dir: string): WatcherLike {
    if (this.options.createWatcher) return this.options.createWatcher(dir)
    const instance = chokidar.watch(dir, {
      // 只看第一层：科目文件夹在内部，递归监听会造成自触发
      depth: 0,
      // 启动时已在文件夹里的文件也要处理：用户可能在 Aurora 启动前就拖了进去，
      // 这些文件同样需要被归类（否则要等下次重启或手动再拖一次）。
      ignoreInitial: false,
      // 稳定判定：尺寸在窗口内不再变化才判定为"写完"
      awaitWriteFinish: {
        stabilityThreshold: this.options.stabilityThresholdMs ?? 800,
        pollInterval: this.options.pollIntervalMs ?? 100,
      },
      ignored: (target: string) => {
        const name = basename(target)
        // 目录本身不忽略（否则根目录会被过滤掉）
        if (name === basename(dir)) return false
        return shouldIgnore(name)
      },
    })
    return instance as unknown as WatcherLike
  }

  private async handleAdd(path: string, generation: number): Promise<void> {
    // 旧代次的迟到事件（已 stop / 已换目录）一律丢弃
    if (generation !== this.generation) {
      this.options.logger?.debug('忽略已失效监听的迟到事件', { path })
      return
    }
    if (this.suppressed.has(path)) {
      this.options.logger?.debug('忽略管线自身造成的变动', { path })
      return
    }

    const fileName = basename(path)
    if (shouldIgnore(fileName)) {
      this.options.logger?.debug('忽略文件（临时 / 隐藏）', { fileName })
      return
    }

    // depth: 0 已限制层级，这里再做一次防御性校验
    if (this.dir !== '') {
      const rel = relative(this.dir, path)
      if (rel.includes('\\') || rel.includes('/')) {
        this.options.logger?.debug('忽略子目录中的文件', { path })
        return
      }
    }

    const sizeBytes = await this.statSize(path)
    if (sizeBytes === undefined) {
      this.options.logger?.debug('文件已消失，跳过', { path })
      return
    }

    const ext = extOf(fileName)
    this.emitAdd({ path, fileName, ext, sizeBytes })
  }

  private async statSize(path: string): Promise<number | undefined> {
    if (this.options.statSize) return this.options.statSize(path)
    try {
      const stat = await fs.stat(path)
      return stat.isDirectory() ? undefined : stat.size
    } catch {
      return undefined
    }
  }

  private listeners: Array<(file: WatchedFile) => void> = []

  onAdd(listener: (file: WatchedFile) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener)
    }
  }

  private emitAdd(file: WatchedFile): void {
    for (const listener of this.listeners) {
      try {
        listener(file)
      } catch (error) {
        this.options.logger?.warn('文件监听回调抛错', { error: String(error) })
      }
    }
  }
}

export function extOf(fileName: string): string {
  const index = fileName.lastIndexOf('.')
  if (index <= 0 || index === fileName.length - 1) return ''
  return fileName.slice(index + 1).toLowerCase()
}
