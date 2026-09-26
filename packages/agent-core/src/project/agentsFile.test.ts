/**
 * 项目级 `AGENTS.md` 逐层收集器的内核单测（docs/06 §5.1）。
 *
 * 全程用**内存 fs 桩**（`ProjectFs` 实现，不碰真实磁盘）：这里钉的是内核这一侧的口径 ——
 * 目录链推导、override 优先、远→近拼接顺序、字节预算与 UTF-8 安全截断、
 * 各类降级都不抛错、以及「签名没变就不 readFile」的缓存语义。
 * 真实 `lstat` / `readFile` 的接线由 `nodeFs.ts` 承担（本文件末尾用注入桩覆盖它的形状）。
 */
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AGENTS_FILE_NAME,
  AGENTS_OVERRIDE_FILE_NAME,
  COLLECT_AGENTS_LIMITS,
  collectProjectInstructions,
} from './agentsFile.js'
import type {
  CollectProjectInstructionsOptions,
  ProjectFs,
  ProjectInstructions,
  ProjectStat,
} from './agentsFile.js'

/** 测试用项目根：绝对路径（由 cwd 解析而来），全程只有字符串与内存 Map */
const ROOT = resolve('__test__', 'agents-project')
const SUB = join(ROOT, 'sub')
const OUTSIDE = resolve('__test__', 'outside-project')

const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8')

function missingError(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), {
    code: 'ENOENT',
  })
}

type EntryKind = 'file' | 'dir' | 'symlink'

interface MemoryEntry {
  kind: EntryKind
  content: string
  mtimeMs: number
  size?: number
  /** stat 抛错（模拟权限 / IO 错误） */
  statError?: Error
  /** readFile 抛错（模拟读取失败） */
  readError?: Error
}

/**
 * 内存 fs 桩：`stat` 不存在即抛 ENOENT（与真实 `lstat` 同款），
 * `reads` 留痕用于断言「缓存命中时一次 readFile 都不做」。
 */
class MemoryProjectFs implements ProjectFs {
  readonly entries = new Map<string, MemoryEntry>()
  readonly reads: string[] = []

  writeFile(path: string, content: string, mtimeMs = 1_000): void {
    this.entries.set(path, { kind: 'file', content, mtimeMs })
  }

  mkdir(path: string): void {
    this.entries.set(path, { kind: 'dir', content: '', mtimeMs: 1_000 })
  }

  symlink(path: string): void {
    this.entries.set(path, { kind: 'symlink', content: '', mtimeMs: 1_000 })
  }

  /** 让某个路径的 `stat` 抛错（同时占位，保证它不是"不存在"） */
  failStat(path: string, error: Error): void {
    this.entries.set(path, { kind: 'file', content: '', mtimeMs: 1_000, statError: error })
  }

  /** 让某个已存在文件的 `readFile` 抛错 */
  failRead(path: string, error: Error): void {
    const entry = this.entries.get(path)
    if (entry === undefined) throw new Error(`先 writeFile 再 failRead：${path}`)
    entry.readError = error
  }

  touch(path: string, mtimeMs: number): void {
    const entry = this.entries.get(path)
    if (entry === undefined) throw new Error(`文件不存在：${path}`)
    entry.mtimeMs = mtimeMs
  }

  async readFile(path: string): Promise<string> {
    this.reads.push(path)
    const entry = this.entries.get(path)
    if (entry === undefined) throw missingError(path)
    if (entry.readError !== undefined) throw entry.readError
    return entry.content
  }

  async stat(path: string): Promise<ProjectStat> {
    const entry = this.entries.get(path)
    if (entry === undefined) throw missingError(path)
    if (entry.statError !== undefined) throw entry.statError
    return {
      isFile: entry.kind === 'file',
      isDirectory: entry.kind === 'dir',
      isSymbolicLink: entry.kind === 'symlink',
      mtimeMs: entry.mtimeMs,
      size: entry.size ?? utf8Bytes(entry.content),
    }
  }
}

function createFs(): MemoryProjectFs {
  return new MemoryProjectFs()
}

function collect(
  fs: ProjectFs,
  overrides: Partial<CollectProjectInstructionsOptions> = {},
): Promise<ProjectInstructions> {
  return collectProjectInstructions({ root: ROOT, cwd: ROOT, fs, ...overrides })
}

const rootAgents = join(ROOT, AGENTS_FILE_NAME)
const rootOverride = join(ROOT, AGENTS_OVERRIDE_FILE_NAME)

describe('collectProjectInstructions / override 优先（docs/06 §5.1）', () => {
  it('同目录两者都有时只出 override 的内容，且不读被顶掉的 AGENTS.md', async () => {
    const fs = createFs()
    fs.writeFile(rootAgents, 'PLAIN-RULE')
    fs.writeFile(rootOverride, 'OVERRIDE-RULE')

    const result = await collect(fs)

    expect(result.text).toBe(`### ${AGENTS_OVERRIDE_FILE_NAME}\nOVERRIDE-RULE`)
    expect(result.text).not.toContain('PLAIN-RULE')
    expect(result.files).toEqual([rootOverride])
    expect(fs.reads).toEqual([rootOverride])
  })

  it('override 不存在时回落 AGENTS.md', async () => {
    const fs = createFs()
    fs.writeFile(rootAgents, 'PLAIN-RULE')

    const result = await collect(fs)

    expect(result.text).toBe(`### ${AGENTS_FILE_NAME}\nPLAIN-RULE`)
    expect(result.files).toEqual([rootAgents])
  })

  it('每层目录最多一份：更近的层用 override、更远的层用 AGENTS.md', async () => {
    const fs = createFs()
    fs.writeFile(rootAgents, 'ROOT-PLAIN')
    fs.writeFile(join(SUB, AGENTS_OVERRIDE_FILE_NAME), 'SUB-OVERRIDE')

    const result = await collect(fs, { cwd: SUB })

    expect(result.text).toBe(
      `### ${AGENTS_FILE_NAME}\nROOT-PLAIN\n\n### sub/${AGENTS_OVERRIDE_FILE_NAME}\nSUB-OVERRIDE`,
    )
  })
})

describe('collectProjectInstructions / 目录链与拼接顺序（docs/06 §5.1）', () => {
  it('远 → 近：root 的内容在前、cwd 那层在后', async () => {
    const fs = createFs()
    fs.writeFile(rootAgents, 'ROOT-RULE')
    fs.writeFile(join(SUB, AGENTS_FILE_NAME), 'SUB-RULE')

    const result = await collect(fs, { cwd: SUB })

    expect(result.text).toBe('### AGENTS.md\nROOT-RULE\n\n### sub/AGENTS.md\nSUB-RULE')
    expect(result.text.indexOf('ROOT-RULE')).toBeLessThan(result.text.indexOf('SUB-RULE'))
    expect(result.files).toEqual([rootAgents, join(SUB, AGENTS_FILE_NAME)])
    expect(result.truncated).toBe(false)
  })

  it('cwd 就是 root 时只取一层', async () => {
    const fs = createFs()
    fs.writeFile(rootAgents, 'ROOT-RULE')

    const result = await collect(fs, { cwd: ROOT })

    expect(result.text).toBe('### AGENTS.md\nROOT-RULE')
    expect(fs.reads).toEqual([rootAgents])
  })

  it('cwd 在 root 之外时只取 root 一层（不收集 cwd 侧的约定）', async () => {
    const fs = createFs()
    fs.writeFile(rootAgents, 'ROOT-RULE')
    fs.writeFile(join(OUTSIDE, AGENTS_FILE_NAME), 'OUTSIDE-RULE')

    const result = await collect(fs, { cwd: OUTSIDE })

    expect(result.text).toBe('### AGENTS.md\nROOT-RULE')
    expect(result.text).not.toContain('OUTSIDE-RULE')
    expect(result.files).toEqual([rootAgents])
    expect(fs.reads).toEqual([rootAgents])
  })
})

describe('collectProjectInstructions / 目录层数上限（docs/06 §5.1）', () => {
  const A = join(ROOT, 'a')
  const B = join(A, 'b')
  const C = join(B, 'c')

  function seed(): MemoryProjectFs {
    const fs = createFs()
    fs.writeFile(rootAgents, 'R')
    fs.writeFile(join(A, AGENTS_FILE_NAME), 'A')
    fs.writeFile(join(B, AGENTS_FILE_NAME), 'B')
    fs.writeFile(join(C, AGENTS_FILE_NAME), 'C')
    return fs
  }

  it('超过 maxDirs 时停止向近端走并置 truncated', async () => {
    const fs = seed()

    const result = await collect(fs, { cwd: C, maxDirs: 2 })

    expect(result.truncated).toBe(true)
    expect(result.text).toBe('### AGENTS.md\nR\n\n### a/AGENTS.md\nA')
    expect(fs.reads).toEqual([rootAgents, join(A, AGENTS_FILE_NAME)])
  })

  it('层数在上限内时不截断', async () => {
    const fs = seed()

    const result = await collect(fs, { cwd: C, maxDirs: COLLECT_AGENTS_LIMITS.maxDirs })

    expect(result.truncated).toBe(false)
    expect(result.files).toEqual([
      rootAgents,
      join(A, AGENTS_FILE_NAME),
      join(B, AGENTS_FILE_NAME),
      join(C, AGENTS_FILE_NAME),
    ])
  })

  it('maxDirs = 0 时一份都不收集且置 truncated', async () => {
    const fs = seed()

    const result = await collect(fs, { cwd: C, maxDirs: 0 })

    expect(result.text).toBe('')
    expect(result.truncated).toBe(true)
    expect(fs.reads).toEqual([])
  })
})

describe('collectProjectInstructions / 字节预算（docs/06 §5.1）', () => {
  it('单份文件超出预算时按 UTF-8 截断、追加（已截断）并置 truncated', async () => {
    const fs = createFs()
    fs.writeFile(rootAgents, '中'.repeat(100))

    // 固定开销 = 标题 13 + 换行 1 + 标注行 16 = 30 字节，预算 34 ⇒ 正文只剩 4 字节（一个「中」）
    const result = await collect(fs, { maxBytes: 34 })

    expect(result.truncated).toBe(true)
    expect(result.text).toBe('### AGENTS.md\n中\n（已截断）')
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(34)
    // 截断处没有半个字符（无替换字符、无孤立代理项）
    expect(result.text).not.toContain('\uFFFD')
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result.text)).toBe(false)
  })

  it('代理对（emoji）不会被截成半个字符', async () => {
    const fs = createFs()
    fs.writeFile(rootAgents, '😀'.repeat(20))

    const result = await collect(fs, { maxBytes: 35 }) // 正文预算 5 字节 ⇒ 只放得下 1 个 emoji（4 字节）

    expect(result.truncated).toBe(true)
    expect(result.text).toBe('### AGENTS.md\n😀\n（已截断）')
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(35)
  })

  it('预算在第二份文件上截断：第一份完整，第二份截断后停止', async () => {
    const fs = createFs()
    fs.writeFile(rootAgents, 'AAAA') // 块 = 13 + 1 + 4 = 18 字节
    fs.writeFile(join(SUB, AGENTS_FILE_NAME), 'B'.repeat(50))

    // 18（第一块）+ 2（空行）+ 17（标题）+ 1（换行）+ 16（标注）= 54，预算 60 ⇒ 正文 6 字节
    const result = await collect(fs, { cwd: SUB, maxBytes: 60 })

    expect(result.truncated).toBe(true)
    expect(result.text).toBe('### AGENTS.md\nAAAA\n\n### sub/AGENTS.md\nBBBBBB\n（已截断）')
    expect(utf8Bytes(result.text)).toBeLessThanOrEqual(60)
    expect(result.files).toEqual([rootAgents, join(SUB, AGENTS_FILE_NAME)])
  })

  it('剩余预算不够放标题与标注时，该文件整份不注入（其余文件照常）', async () => {
    const fs = createFs()
    fs.writeFile(rootAgents, 'AAAA')
    fs.writeFile(join(SUB, AGENTS_FILE_NAME), 'B'.repeat(50))

    const result = await collect(fs, { cwd: SUB, maxBytes: 30 })

    expect(result.truncated).toBe(true)
    expect(result.text).toBe('### AGENTS.md\nAAAA')
    expect(result.files).toEqual([rootAgents])
  })

  it('预算充足时既不截断也不标注', async () => {
    const fs = createFs()
    fs.writeFile(rootAgents, 'SHORT')

    const result = await collect(fs, { maxBytes: COLLECT_AGENTS_LIMITS.maxBytes })

    expect(result.truncated).toBe(false)
    expect(result.text).toBe('### AGENTS.md\nSHORT')
    expect(result.text).not.toContain('（已截断）')
  })
})

describe('collectProjectInstructions / 降级路径都不抛错（docs/06 §5.1）', () => {
  it('文件不存在：记 warning，其余文件照常注入', async () => {
    const fs = createFs()
    fs.writeFile(rootAgents, 'ROOT-RULE')

    const result = await collect(fs, { cwd: SUB })

    expect(result.text).toBe('### AGENTS.md\nROOT-RULE')
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings.join('\n')).toContain(`${join(SUB, AGENTS_FILE_NAME)} 不存在`)
    expect(result.files).toEqual([rootAgents])
  })

  it('readFile 抛错：跳过该文件、记 warning，其余文件照常注入', async () => {
    const fs = createFs()
    fs.writeFile(rootAgents, 'ROOT-RULE')
    fs.writeFile(join(SUB, AGENTS_FILE_NAME), 'SUB-RULE')
    fs.failRead(join(SUB, AGENTS_FILE_NAME), new Error('EACCES: permission denied'))

    const result = await collect(fs, { cwd: SUB })

    expect(result.text).toBe('### AGENTS.md\nROOT-RULE')
    expect(result.warnings.join('\n')).toContain('读取失败，已跳过：EACCES: permission denied')
    expect(result.files).toEqual([rootAgents])
  })

  it('stat 抛错：记 warning 并回落同目录的 AGENTS.md', async () => {
    const fs = createFs()
    fs.writeFile(rootAgents, 'ROOT-RULE')
    fs.failStat(join(SUB, AGENTS_OVERRIDE_FILE_NAME), new Error('EIO: i/o error'))
    fs.writeFile(join(SUB, AGENTS_FILE_NAME), 'SUB-RULE')

    const result = await collect(fs, { cwd: SUB })

    expect(result.text).toBe('### AGENTS.md\nROOT-RULE\n\n### sub/AGENTS.md\nSUB-RULE')
    expect(result.warnings.join('\n')).toContain('无法获取文件状态（EIO: i/o error）')
  })

  it('不是文本文件（含 NUL）→ 跳过并记 warning', async () => {
    const fs = createFs()
    fs.writeFile(rootAgents, `BIN\u0000ARY`)

    const result = await collect(fs)

    expect(result.text).toBe('')
    expect(result.files).toEqual([])
    expect(result.warnings.join('\n')).toContain('不是文本文件（含 NUL 字节）')
  })

  it('内容为空白 → 不注入（不留下光秃秃的标题行）', async () => {
    const fs = createFs()
    fs.writeFile(rootAgents, '   \n\n')

    const result = await collect(fs)

    expect(result.text).toBe('')
    expect(result.files).toEqual([])
    expect(result.warnings.join('\n')).toContain('不存在') // override 那条仍在，但没有任何降级异常
  })
})

describe('collectProjectInstructions / 目录与符号链接（docs/06 §5.1）', () => {
  it('同名目录 → 跳过并记 warning', async () => {
    const fs = createFs()
    fs.mkdir(rootAgents)

    const result = await collect(fs)

    expect(result.text).toBe('')
    expect(result.files).toEqual([])
    expect(fs.reads).toEqual([])
    expect(result.warnings.join('\n')).toContain(`${rootAgents} 是目录（不是文件），已跳过`)
  })

  it('AGENTS.md 是符号链接 → 跳过并记 warning', async () => {
    const fs = createFs()
    fs.symlink(rootAgents)

    const result = await collect(fs)

    expect(result.text).toBe('')
    expect(result.warnings.join('\n')).toContain(`${rootAgents} 是符号链接，出于安全考虑已跳过`)
  })

  it('override 是符号链接 → 跳过并回落同目录的 AGENTS.md', async () => {
    const fs = createFs()
    fs.symlink(rootOverride)
    fs.writeFile(rootAgents, 'PLAIN-RULE')

    const result = await collect(fs)

    expect(result.text).toBe('### AGENTS.md\nPLAIN-RULE')
    expect(result.files).toEqual([rootAgents])
    expect(result.warnings.join('\n')).toContain('是符号链接，出于安全考虑已跳过')
  })
})

describe('collectProjectInstructions / 签名缓存（docs/06 §5.1）', () => {
  it('签名由「路径 + mtimeMs + size」拼成；未命中的层写 missing', async () => {
    const fs = createFs()
    fs.writeFile(rootAgents, 'RULES')

    const result = await collect(fs, { cwd: SUB })

    expect(result.signature).toContain(`${rootAgents}|1000|5`)
    expect(result.signature).toContain(`${join(SUB, AGENTS_OVERRIDE_FILE_NAME)}|missing`)
    expect(result.signature).toContain(`${join(SUB, AGENTS_FILE_NAME)}|missing`)
    expect(result.signature).toContain(`limits|${COLLECT_AGENTS_LIMITS.maxDirs}`)
  })

  it('桩省略 mtime / size 时签名写 ?', async () => {
    const minimalFs: ProjectFs = {
      readFile: async () => 'MINIMAL',
      stat: async (path) => {
        if (path.endsWith(AGENTS_OVERRIDE_FILE_NAME)) throw new Error(`ENOENT: ${path}`)
        return { isFile: true, isDirectory: false, isSymbolicLink: false }
      },
    }

    const result = await collect(minimalFs)

    expect(result.text).toBe('### AGENTS.md\nMINIMAL')
    expect(result.signature).toContain(`${rootAgents}|?|?`)
  })

  it('签名不变 → 一次 readFile 都不做，text 与第一轮相同；mtime 变了才重读', async () => {
    const fs = createFs()
    fs.writeFile(rootAgents, 'RULES')

    const first = await collect(fs)
    expect(fs.reads).toEqual([rootAgents])

    const second = await collect(fs, {
      previous: { signature: first.signature, text: first.text },
    })

    expect(fs.reads).toEqual([rootAgents]) // 未新增：缓存命中
    expect(second.text).toBe(first.text)
    expect(second.signature).toBe(first.signature)
    expect(second.files).toEqual(first.files)
    expect(second.truncated).toBe(first.truncated)

    fs.touch(rootAgents, 2_000)
    const third = await collect(fs, {
      previous: { signature: first.signature, text: first.text },
    })

    expect(third.signature).not.toBe(first.signature)
    expect(fs.reads).toEqual([rootAgents, rootAgents]) // 重新读了一次
  })

  it('缓存命中时按本轮探测结果回带 files（新出现的层也进 files）', async () => {
    const fs = createFs()
    fs.writeFile(rootAgents, 'ROOT-RULE')

    const first = await collect(fs, { cwd: SUB })
    expect(first.files).toEqual([rootAgents])

    fs.writeFile(join(SUB, AGENTS_FILE_NAME), 'SUB-RULE')
    const second = await collect(fs, {
      cwd: SUB,
      previous: { signature: first.signature, text: first.text },
    })

    expect(second.signature).not.toBe(first.signature)
    expect(second.text).toBe('### AGENTS.md\nROOT-RULE\n\n### sub/AGENTS.md\nSUB-RULE')
    expect(second.files).toEqual([rootAgents, join(SUB, AGENTS_FILE_NAME)])
  })

  it('预算变化会改签名（避免把上一轮的超预算文本误当命中）', async () => {
    const fs = createFs()
    fs.writeFile(rootAgents, 'RULES')

    const wide = await collect(fs, { maxBytes: 1_000 })
    const narrow = await collect(fs, { maxBytes: 20 })

    expect(narrow.signature).not.toBe(wide.signature)
  })
})
