import { describe, expect, it } from 'vitest'
import { moveInto, resolvesToWatchRoot, uniqueTargetPath, type ClassifyFs } from './paths.js'

/** 内存文件系统假实现：只关心分类落盘用到的 6 个操作 */
function memoryFs(seed: Record<string, number> = {}): ClassifyFs & {
  files: Map<string, number>
  dirs: Set<string>
  failRename: boolean
  failCopy: boolean
  truncateCopy: boolean
} {
  const files = new Map<string, number>(Object.entries(seed))
  const dirs = new Set<string>()
  const fs = {
    files,
    dirs,
    failRename: false,
    failCopy: false,
    truncateCopy: false,
    async exists(path: string) {
      return files.has(path) || dirs.has(path)
    },
    async ensureDir(path: string) {
      dirs.add(path)
    },
    async rename(from: string, to: string) {
      if (fs.failRename) throw new Error('EPERM: 被占用')
      const size = files.get(from)
      if (size === undefined) throw new Error(`ENOENT: ${from}`)
      files.delete(from)
      files.set(to, size)
    },
    async copy(from: string, to: string) {
      if (fs.failCopy) throw new Error('EIO: 复制失败')
      const size = files.get(from)
      if (size === undefined) throw new Error(`ENOENT: ${from}`)
      files.set(to, fs.truncateCopy ? size - 1 : size)
    },
    async remove(path: string) {
      files.delete(path)
    },
    async sizeOf(path: string) {
      return files.get(path)
    },
  }
  return fs
}

describe('uniqueTargetPath', () => {
  it('无冲突时原样使用文件名', async () => {
    const fs = memoryFs()
    await fs.ensureDir('D:\\分类\\数学')
    expect(await uniqueTargetPath(fs, 'D:\\分类\\数学', 'a.pdf')).toBe('D:\\分类\\数学\\a.pdf')
  })

  it('重名时依次加 (1)、(2) 后缀（保留扩展名）', async () => {
    const fs = memoryFs({ 'D:\\分类\\数学\\a.pdf': 1, 'D:\\分类\\数学\\a (1).pdf': 1 })
    expect(await uniqueTargetPath(fs, 'D:\\分类\\数学', 'a.pdf')).toBe('D:\\分类\\数学\\a (2).pdf')
  })

  it('无扩展名文件的冲突后缀加在末尾', async () => {
    const fs = memoryFs({ 'D:\\分类\\数学\\README': 1 })
    expect(await uniqueTargetPath(fs, 'D:\\分类\\数学', 'README')).toBe(
      'D:\\分类\\数学\\README (1)',
    )
  })

  it('点开头的隐藏文件名不会被误当扩展名', async () => {
    const fs = memoryFs()
    expect(await uniqueTargetPath(fs, 'D:\\x', '.env')).toBe('D:\\x\\.env')
  })
})

describe('moveInto', () => {
  it('优先 rename 移动文件', async () => {
    const fs = memoryFs({ 'D:\\感知\\a.pdf': 100 })
    const outcome = await moveInto({
      fs,
      sourcePath: 'D:\\感知\\a.pdf',
      targetDir: 'D:\\感知\\分类\\数学',
      fileName: 'a.pdf',
      autoMove: true,
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.method).toBe('rename')
    expect(outcome.moved).toBe(true)
    expect(fs.files.has('D:\\感知\\a.pdf')).toBe(false)
    expect(fs.files.get('D:\\感知\\分类\\数学\\a.pdf')).toBe(100)
    expect(fs.dirs.has('D:\\感知\\分类\\数学')).toBe(true)
  })

  it('rename 失败时回退 copy 并删除源文件', async () => {
    const fs = memoryFs({ 'D:\\感知\\a.pdf': 100 })
    fs.failRename = true
    const outcome = await moveInto({
      fs,
      sourcePath: 'D:\\感知\\a.pdf',
      targetDir: 'D:\\分类',
      fileName: 'a.pdf',
      autoMove: true,
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.method).toBe('copy')
    expect(fs.files.has('D:\\感知\\a.pdf')).toBe(false)
    expect(fs.files.get('D:\\分类\\a.pdf')).toBe(100)
    expect(outcome.warnings.join()).toContain('回退为复制')
  })

  it('复制大小不一致时保留原文件并报错（不丢数据）', async () => {
    const fs = memoryFs({ 'D:\\感知\\a.pdf': 100 })
    fs.failRename = true
    fs.truncateCopy = true
    const outcome = await moveInto({
      fs,
      sourcePath: 'D:\\感知\\a.pdf',
      targetDir: 'D:\\分类',
      fileName: 'a.pdf',
      autoMove: true,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('大小不一致')
    expect(fs.files.has('D:\\感知\\a.pdf')).toBe(true)
    expect(fs.files.has('D:\\分类\\a.pdf')).toBe(false)
  })

  it('复制失败时保留原文件并报错', async () => {
    const fs = memoryFs({ 'D:\\感知\\a.pdf': 100 })
    fs.failRename = true
    fs.failCopy = true
    const outcome = await moveInto({
      fs,
      sourcePath: 'D:\\感知\\a.pdf',
      targetDir: 'D:\\分类',
      fileName: 'a.pdf',
      autoMove: true,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('复制失败')
    expect(fs.files.has('D:\\感知\\a.pdf')).toBe(true)
  })

  it('autoMove=false 只解析目标路径、不动文件', async () => {
    const fs = memoryFs({ 'D:\\感知\\a.pdf': 100 })
    const outcome = await moveInto({
      fs,
      sourcePath: 'D:\\感知\\a.pdf',
      targetDir: 'D:\\分类',
      fileName: 'a.pdf',
      autoMove: false,
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.moved).toBe(false)
    expect(outcome.method).toBe('none')
    expect(fs.files.has('D:\\感知\\a.pdf')).toBe(true)
  })

  it('源文件已不存在 → ok=false 且不抛错（调用方记 skipped）', async () => {
    const fs = memoryFs()
    const outcome = await moveInto({
      fs,
      sourcePath: 'D:\\感知\\gone.pdf',
      targetDir: 'D:\\分类',
      fileName: 'gone.pdf',
      autoMove: true,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.moved).toBe(false)
    expect(outcome.error).toContain('源文件已不存在')
  })

  it('创建目录失败 → ok=false 且带可读原因', async () => {
    const fs = memoryFs({ 'D:\\感知\\a.pdf': 10 })
    fs.ensureDir = async () => {
      throw new Error('EACCES')
    }
    const outcome = await moveInto({
      fs,
      sourcePath: 'D:\\感知\\a.pdf',
      targetDir: 'D:\\分类',
      fileName: 'a.pdf',
      autoMove: true,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('创建目标目录失败')
  })

  it('删除源文件失败时仍算成功但给出告警（不丢文件优先）', async () => {
    const fs = memoryFs({ 'D:\\感知\\a.pdf': 100 })
    fs.failRename = true
    fs.remove = async () => {
      throw new Error('EBUSY')
    }
    const outcome = await moveInto({
      fs,
      sourcePath: 'D:\\感知\\a.pdf',
      targetDir: 'D:\\分类',
      fileName: 'a.pdf',
      autoMove: true,
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.warnings.join()).toContain('原文件删除失败')
  })
})

/**
 * 回归：目标目录落到感知文件夹**根**会造成无限自触发。
 *
 * `depth: 0` 只在子目录内移动时安全；同目录内 rename 会触发新的 add 事件
 * （`root/a.txt` → `root/a (1).txt` 在真实 chokidar 上实测会 emit `add`），
 * 于是"分类 → 重命名 → 又被当成新文件 → 再分类"永不停止。
 * 而 `SubjectSchema.folder` 只要求非空，`"."`、`"./"`、`"a/.."` 都会解析到根目录。
 */
describe('resolvesToWatchRoot（防自触发）', () => {
  it('同一路径与等价写法都判定为"就是根目录"', () => {
    expect(resolvesToWatchRoot('D:\\感知', 'D:\\感知')).toBe(true)
    expect(resolvesToWatchRoot('D:\\感知', 'D:\\感知\\.')).toBe(true)
    expect(resolvesToWatchRoot('D:\\感知', 'D:\\感知\\sub\\..')).toBe(true)
    expect(resolvesToWatchRoot('D:\\感知\\', 'D:\\感知')).toBe(true)
  })

  it('子目录不算根目录', () => {
    expect(resolvesToWatchRoot('D:\\感知', 'D:\\感知\\分类\\数学')).toBe(false)
    expect(resolvesToWatchRoot('D:\\感知', 'D:\\感知\\待分类')).toBe(false)
  })

  it('空路径一律返回 false（交给其它校验处理）', () => {
    expect(resolvesToWatchRoot('', 'D:\\感知')).toBe(false)
    expect(resolvesToWatchRoot('D:\\感知', '')).toBe(false)
  })

  it('moveInto 拒绝移动到感知文件夹根，且不动文件', async () => {
    const fs = memoryFs({ 'D:\\感知\\数学.pdf': 100 })
    const outcome = await moveInto({
      fs,
      sourcePath: 'D:\\感知\\数学.pdf',
      targetDir: 'D:\\感知\\.',
      fileName: '数学.pdf',
      autoMove: true,
      watchDir: 'D:\\感知',
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.moved).toBe(false)
    expect(outcome.error).toContain('智慧感知文件夹本身')
    // 关键：文件仍在原处，没有被改名成 "数学 (1).pdf" 触发循环
    expect(fs.files.has('D:\\感知\\数学.pdf')).toBe(true)
    expect([...fs.files.keys()]).toHaveLength(1)
  })

  it('autoMove=false 时不触发该拦截（本来就不动文件）', async () => {
    const fs = memoryFs({ 'D:\\感知\\数学.pdf': 100 })
    const outcome = await moveInto({
      fs,
      sourcePath: 'D:\\感知\\数学.pdf',
      targetDir: 'D:\\感知',
      fileName: '数学.pdf',
      autoMove: false,
      watchDir: 'D:\\感知',
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.moved).toBe(false)
  })

  it('未传 watchDir 时保持旧行为（不拦截）', async () => {
    const fs = memoryFs({ 'D:\\感知\\数学.pdf': 100 })
    const outcome = await moveInto({
      fs,
      sourcePath: 'D:\\感知\\数学.pdf',
      targetDir: 'D:\\感知',
      fileName: '数学.pdf',
      autoMove: true,
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.moved).toBe(true)
  })
})
