/**
 * 项目级指令取用器的内核单测（docs/06 §5.1）。
 *
 * 钉的是**取用器自己的口径**：无项目直接返回 undefined（连端口都不碰）、
 * 同一 root 且文件未变时只 readFile 一次、mtime 变了才重读、
 * 任何失败都折成 undefined（永不抛错），以及「取用器只回文本、不加任何标题」。
 * 逐层收集的细节由 `agentsFile.test.ts` 覆盖，这里只做最小内存桩。
 */
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createProjectInstructionsSource } from './instructions.js'
import type { ProjectFs, ProjectStat } from './agentsFile.js'

const ROOT = resolve('__test__', 'instructions-project')
const OTHER_ROOT = resolve('__test__', 'instructions-other')
const AGENTS = 'AGENTS.md'

interface MemoryEntry {
  content: string
  mtimeMs: number
}

/** 最小内存 fs 桩：只认 `AGENTS.md`，其余路径一律 ENOENT */
class MemoryFs implements ProjectFs {
  readonly entries = new Map<string, MemoryEntry>()
  readonly reads: string[] = []
  /** 置真后 readFile 整体抛错（模拟盘符掉线 / 权限全失） */
  failAllReads = false

  writeFile(path: string, content: string, mtimeMs = 1_000): void {
    this.entries.set(path, { content, mtimeMs })
  }

  touch(path: string, mtimeMs: number): void {
    const entry = this.entries.get(path)
    if (entry === undefined) throw new Error(`文件不存在：${path}`)
    entry.mtimeMs = mtimeMs
  }

  async readFile(path: string): Promise<string> {
    this.reads.push(path)
    if (this.failAllReads) throw new Error('EIO: 读取失败')
    const entry = this.entries.get(path)
    if (entry === undefined) throw new Error(`ENOENT: ${path}`)
    return entry.content
  }

  async stat(path: string): Promise<ProjectStat> {
    const entry = this.entries.get(path)
    if (entry === undefined) throw new Error(`ENOENT: ${path}`)
    return {
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      mtimeMs: entry.mtimeMs,
      size: Buffer.byteLength(entry.content, 'utf8'),
    }
  }
}

const rootAgents = join(ROOT, AGENTS)

describe('createProjectInstructionsSource（docs/06 §5.1）', () => {
  it('无项目 → undefined，且完全不碰 fs', async () => {
    const fs = new MemoryFs()
    fs.writeFile(rootAgents, 'RULES')
    const source = createProjectInstructionsSource({
      fs,
      resolveRoot: () => undefined,
      resolveCwd: () => ROOT,
    })

    await expect(source()).resolves.toBeUndefined()
    expect(fs.reads).toEqual([])
  })

  it('有项目 → 回注入文本，且不加任何标题（原样返回收集结果）', async () => {
    const fs = new MemoryFs()
    fs.writeFile(rootAgents, 'RULES')
    const source = createProjectInstructionsSource({
      fs,
      resolveRoot: () => ROOT,
      resolveCwd: () => ROOT,
    })

    const text = await source()

    expect(text).toBe('### AGENTS.md\nRULES')
    expect(text?.startsWith('## ')).toBe(false) // 取用器只回文本，不拼小节标题
  })

  it('同一 root 连续两次、文件未变 → readFile 只发生一次', async () => {
    const fs = new MemoryFs()
    fs.writeFile(rootAgents, 'RULES')
    const source = createProjectInstructionsSource({
      fs,
      resolveRoot: () => ROOT,
      resolveCwd: () => ROOT,
    })

    const first = await source()
    const second = await source()

    expect(first).toBe('### AGENTS.md\nRULES')
    expect(second).toBe(first)
    expect(fs.reads).toEqual([rootAgents])
  })

  it('文件变化（mtime 变）→ 重新读', async () => {
    const fs = new MemoryFs()
    fs.writeFile(rootAgents, 'RULES')
    const source = createProjectInstructionsSource({
      fs,
      resolveRoot: () => ROOT,
      resolveCwd: () => ROOT,
    })

    await source()
    fs.writeFile(rootAgents, 'NEW-RULES', 2_000)
    const second = await source()

    expect(second).toBe('### AGENTS.md\nNEW-RULES')
    expect(fs.reads).toEqual([rootAgents, rootAgents])
  })

  it('切换到另一个项目根 → 换缓存条目（互不串味）', async () => {
    const fs = new MemoryFs()
    fs.writeFile(rootAgents, 'ROOT-RULES')
    fs.writeFile(join(OTHER_ROOT, AGENTS), 'OTHER-RULES')
    let root = ROOT
    const source = createProjectInstructionsSource({
      fs,
      resolveRoot: () => root,
      resolveCwd: () => root,
    })

    expect(await source()).toBe('### AGENTS.md\nROOT-RULES')
    root = OTHER_ROOT
    expect(await source()).toBe('### AGENTS.md\nOTHER-RULES')
    root = ROOT
    expect(await source()).toBe('### AGENTS.md\nROOT-RULES') // 切回来命中旧条目
    expect(fs.reads).toEqual([rootAgents, join(OTHER_ROOT, AGENTS)])
  })

  it('fs.readFile 整体抛错 → 返回 undefined 且不抛', async () => {
    const fs = new MemoryFs()
    fs.writeFile(rootAgents, 'RULES')
    fs.failAllReads = true
    const source = createProjectInstructionsSource({
      fs,
      resolveRoot: () => ROOT,
      resolveCwd: () => ROOT,
    })

    await expect(source()).resolves.toBeUndefined()
  })

  it('收集结果为空 → undefined；项目里出现文件后又能拿到文本', async () => {
    const fs = new MemoryFs()
    const source = createProjectInstructionsSource({
      fs,
      resolveRoot: () => ROOT,
      resolveCwd: () => ROOT,
    })

    await expect(source()).resolves.toBeUndefined()

    fs.writeFile(rootAgents, 'RULES')
    await expect(source()).resolves.toBe('### AGENTS.md\nRULES')
  })

  it('resolveMaxBytes 会传下去：预算过小时按截断结果回文本', async () => {
    const fs = new MemoryFs()
    fs.writeFile(rootAgents, '中'.repeat(100))
    const source = createProjectInstructionsSource({
      fs,
      resolveRoot: () => ROOT,
      resolveCwd: () => ROOT,
      resolveMaxBytes: () => 34,
    })

    await expect(source()).resolves.toBe('### AGENTS.md\n中\n（已截断）')
  })

  it('resolveCwd 在项目根之外 → 只注入 root 那一层', async () => {
    const fs = new MemoryFs()
    fs.writeFile(rootAgents, 'ROOT-RULES')
    fs.writeFile(join(OTHER_ROOT, AGENTS), 'OTHER-RULES')
    const source = createProjectInstructionsSource({
      fs,
      resolveRoot: () => ROOT,
      resolveCwd: () => OTHER_ROOT,
    })

    await expect(source()).resolves.toBe('### AGENTS.md\nROOT-RULES')
  })
})
