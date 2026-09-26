/**
 * 数据目录 JSON 持久化（docs/12 §2.2）。
 *
 * 沿用仓库约定：**原子写**（临时文件 + rename）——服务器进程被 kill -9 /
 * 断电时不会留下半截 JSON；读损坏时把坏文件备份为 `<名>.corrupt` 后重建。
 * 与桌面端 SettingsStore 的差异只在"无防抖"：Center 的写入频率低
 * （登录 / 配对 / 客户端注册），直接落盘即可。
 */
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Logger } from '@aurora/shared'

export class JsonStore<T> {
  constructor(
    private readonly file: string,
    private readonly fallback: () => T,
    private readonly logger?: Logger,
  ) {}

  /**
   * save 串行化（真实事故，2026-09-27）：同文件的两个 save 并发时共享同一个
   * `.{名}.{PID}.tmp`，先走者 rename 掉 tmp，后者 rename ENOENT → 登录间歇性 500。
   * 同实例的 save 排队执行；tmp 名另带随机后缀，即使不同实例同文件也不会互踩。
   */
  private saveChain: Promise<void> = Promise.resolve()

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
    const run = this.saveChain.then(() => this.doSave(data))
    // 链上吞掉失败（不阻塞后续 save），异常仍向本次调用方抛出
    this.saveChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async doSave(data: T): Promise<void> {
    await fs.mkdir(dirname(this.file), { recursive: true })
    const tmp = join(
      dirname(this.file),
      `.${basename(this.file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
    )
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await fs.rename(tmp, this.file)
  }
}

function basename(file: string): string {
  const index = file.lastIndexOf('/')
  const win = file.lastIndexOf('\\')
  return file.slice(Math.max(index, win) + 1)
}
