import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CryptoPort, FileSystemPort } from '../config/ports.js'

/** 内存文件系统：用于在不落盘的前提下测试 SettingsStore 的读写与原子写行为。 */
export class MemoryFileSystem implements FileSystemPort {
  readonly files = new Map<string, string>()
  /** 记录每次 writeFileAtomic 的目标路径与内容，便于断言"从未落盘明文"。 */
  readonly writeLog: string[] = []
  readonly contentLog: string[] = []
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
    this.contentLog.push(content)
    if (this.failNextWrite) {
      this.failNextWrite = false
      return Promise.reject(new Error('EACCES: 模拟写盘失败'))
    }
    this.files.set(path, content)
    this.files.set(`${path}.tmp`, 'leftover')
    this.files.delete(`${path}.tmp`)
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

  mkdirp(path: string): Promise<void> {
    this.dirs.add(path)
    return Promise.resolve()
  }

  readonly dirs = new Set<string>()

  readdir(path: string): Promise<string[]> {
    const prefix = path.endsWith('\\') || path.endsWith('/') ? path : `${path}\\`
    const names = new Set<string>()
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix) && dirname(file) !== path) continue
      const relative =
        dirname(file) === path ? file.slice(path.length + 1) : file.slice(prefix.length)
      const first = relative.split(/[\\/]/)[0]
      if (first) names.add(first)
    }
    return Promise.resolve([...names])
  }
}

export function memoryPath(...segments: string[]): string {
  return join('C:\\aurora-test', ...segments)
}

/**
 * 可逆的假加密：密文形如 `fakestorage:v1:<base64>`。
 *
 * 关键点：密文**不包含**明文子串，因此"落盘内容不含明文"这类断言才有意义
 * （test-only 实现，与 safeStorage 的真实语义对齐：只要求可逆 + 不泄漏）。
 */
export const FAKE_CIPHER_PREFIX = 'fakestorage:v1:'

export function createFakeCrypto(available = true): CryptoPort & { encryptCalls: string[] } {
  const encryptCalls: string[] = []
  return {
    encryptCalls,
    isAvailable: () => available,
    encrypt: (plain: string) => {
      encryptCalls.push(plain)
      if (!available) return ''
      return `${FAKE_CIPHER_PREFIX}${Buffer.from(plain, 'utf8').toString('base64')}`
    },
    decrypt: (cipher: string) => {
      if (!cipher.startsWith(FAKE_CIPHER_PREFIX)) {
        throw new Error('Invalid ciphertext: 期望 fakestorage:v1: 前缀')
      }
      return Buffer.from(cipher.slice(FAKE_CIPHER_PREFIX.length), 'base64').toString('utf8')
    },
  }
}

/** 断言用：密文是否为假加密格式 */
export function isFakeCipher(value: string): boolean {
  return value.startsWith(FAKE_CIPHER_PREFIX)
}

export async function readJsonFile(fsPort: MemoryFileSystem, path: string): Promise<unknown> {
  return JSON.parse(await fsPort.readFile(path))
}

/** 断言真实磁盘上不存在明文（用于集成校验脚本可复用的工具）。 */
export async function fileContains(path: string, needle: string): Promise<boolean> {
  try {
    const content = await fs.readFile(path, 'utf8')
    return content.includes(needle)
  } catch {
    return false
  }
}
