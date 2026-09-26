/**
 * 数据目录 JSON 持久化（docs/12 §2.2）。
 *
 * 沿用仓库约定：**原子写**（临时文件 + rename）——服务器进程被 kill -9 /
 * 断电时不会留下半截 JSON；读损坏时把坏文件备份为 `<名>.corrupt` 后重建。
 * 与桌面端 SettingsStore 的差异只在"无防抖"：Center 的写入频率低
 * （登录 / 配对 / 客户端注册），直接落盘即可。
 */
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Logger } from '@aurora/shared'

export class JsonStore<T> {
  constructor(
    private readonly file: string,
    private readonly fallback: () => T,
    private readonly logger?: Logger,
  ) {}

  /** 读入（文件不存在 / 损坏时回落默认值并重建）；进程生命周期内调用方自行缓存。 */
  async load(): Promise<T> {
    let raw: string
    try {
      raw = await fs.readFile(this.file, 'utf8')
    } catch {
      return this.fallback()
    }
    try {
      return JSON.parse(raw) as T
    } catch (error) {
      const backup = `${this.file}.corrupt`
      this.logger?.warn('数据文件损坏，已备份重建', {
        file: this.file,
        backup,
        error: String(error),
      })
      try {
        await fs.rename(this.file, backup)
      } catch {
        /* 备份失败也继续重建：旧内容已不可信 */
      }
      const fresh = this.fallback()
      await this.save(fresh)
      return fresh
    }
  }

  async save(data: T): Promise<void> {
    await fs.mkdir(dirname(this.file), { recursive: true })
    const tmp = join(dirname(this.file), `.${basename(this.file)}.${process.pid}.tmp`)
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await fs.rename(tmp, this.file)
  }
}

function basename(file: string): string {
  const index = file.lastIndexOf('/')
  const win = file.lastIndexOf('\\')
  return file.slice(Math.max(index, win) + 1)
}
