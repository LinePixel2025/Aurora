/**
 * 文件系统与加密端口（Ports）。
 *
 * shared 保持纯 Node / 可单测：主进程注入真实 fs 与 Electron safeStorage，
 * 单测注入内存实现（见 `*.test.ts`）。
 */

import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

export interface FileSystemPort {
  exists(path: string): Promise<boolean>
  readFile(path: string): Promise<string>
  /** 二进制读；Office 快照与回滚必须走它，不能借 UTF-8 往返。 */
  readFileBytes?(path: string): Promise<Uint8Array>
  /** 原子写：写临时文件后 rename（docs/08 §2）。 */
  writeFileAtomic(path: string, content: string): Promise<void>
  /** 二进制原子写；与 `writeFileAtomic` 同一套临时文件 + rename 约定。 */
  writeFileAtomicBytes?(path: string, content: Uint8Array): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
  mkdirp(path: string): Promise<void>
  readdir(path: string): Promise<string[]>
}

export const nodeFileSystem: FileSystemPort = {
  async exists(path) {
    try {
      await fs.access(path)
      return true
    } catch {
      return false
    }
  },
  async readFile(path) {
    return fs.readFile(path, 'utf8')
  },
  async readFileBytes(path) {
    return fs.readFile(path)
  },
  async writeFileAtomic(path, content) {
    await fs.mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    try {
      await fs.writeFile(tmp, content, 'utf8')
      await fs.rename(tmp, path)
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw error
    }
  },
  async writeFileAtomicBytes(path, content) {
    await fs.mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    try {
      await fs.writeFile(tmp, content)
      await fs.rename(tmp, path)
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw error
    }
  },
  async rename(from, to) {
    await fs.rename(from, to)
  },
  async remove(path) {
    await fs.rm(path, { force: true })
  },
  async mkdirp(path) {
    await fs.mkdir(path, { recursive: true })
  },
  async readdir(path) {
    return fs.readdir(path)
  },
}

/** 清理历史遗留的临时文件（`.tmp` 残留，通常来自写入中断）。 */
export async function cleanupTempFiles(fsPort: FileSystemPort, dir: string): Promise<string[]> {
  const removed: string[] = []
  let entries: string[] = []
  try {
    entries = await fsPort.readdir(dir)
  } catch {
    return removed
  }
  for (const entry of entries) {
    if (!entry.endsWith('.tmp')) continue
    try {
      await fsPort.remove(join(dir, entry))
      removed.push(entry)
    } catch {
      /* 忽略：可能已被并发删除 */
    }
  }
  return removed
}

export interface CryptoPort {
  /** 能否安全加密；false 时凭据只驻留内存，绝不落盘明文。 */
  isAvailable(): boolean
  encrypt(plain: string): string
  decrypt(cipher: string): string
}

/** 加密不可达时的实现：加密返回空串（调用方据此拒绝落盘）。 */
export const nullCrypto: CryptoPort = {
  isAvailable: () => false,
  encrypt: () => '',
  decrypt: () => '',
}

/** 仅供测试 / 无敏感数据的场景使用。 */
export const identityCrypto: CryptoPort = {
  isAvailable: () => true,
  encrypt: (plain) => plain,
  decrypt: (cipher) => cipher,
}
