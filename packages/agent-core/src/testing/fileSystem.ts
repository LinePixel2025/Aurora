/**
 * agent-core 测试用内存文件系统。
 *
 * 与 `@aurora/shared` 内部那份重复：agent-core 只从 shared 的**公开入口**导入，
 * 而 `testing/memoryFs` 不在导出面内，因此这里保留一份最小实现。
 */
import { dirname } from 'node:path'
import type { FileSystemPort } from '@aurora/shared'

export class TestFileSystem implements FileSystemPort {
  readonly files = new Map<string, string>()
  readonly writeLog: string[] = []
  failNextWrite = false

  constructor(seed: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(seed)) this.files.set(path, content)
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path))
  }

  readFile(path: string): Promise<string> {
    const content = this.files.get(path)
    if (content === undefined) return Promise.reject(new Error(`ENOENT: ${path}`))
    return Promise.resolve(content)
  }

  writeFileAtomic(path: string, content: string): Promise<void> {
    this.writeLog.push(path)
    if (this.failNextWrite) {
      this.failNextWrite = false
      return Promise.reject(new Error('EACCES: 模拟写盘失败'))
    }
    this.files.set(path, content)
    return Promise.resolve()
  }

  rename(from: string, to: string): Promise<void> {
    const content = this.files.get(from)
    if (content === undefined) return Promise.reject(new Error(`ENOENT: ${from}`))
    this.files.set(to, content)
    this.files.delete(from)
    return Promise.resolve()
  }

  remove(path: string): Promise<void> {
    this.files.delete(path)
    return Promise.resolve()
  }

  mkdirp(): Promise<void> {
    return Promise.resolve()
  }

  readdir(path: string): Promise<string[]> {
    const prefix = path.endsWith('\\') || path.endsWith('/') ? path : `${path}\\`
    const names = new Set<string>()
    for (const file of this.files.keys()) {
      if (dirname(file) === path) {
        names.add(file.slice(path.length + 1))
        continue
      }
      if (!file.startsWith(prefix)) continue
      const first = file.slice(prefix.length).split(/[\\/]/)[0]
      if (first) names.add(first)
    }
    return Promise.resolve([...names])
  }
}

/** 固定测试目录，避免不同平台的路径分隔符差异影响断言 */
export const SESSION_DIR = 'C:\\aurora-test\\sessions'
