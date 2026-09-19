/**
 * 日志级别热更新单测（docs/08 §6 `advanced.logLevel`）。
 *
 * 这一项曾经是死字段：`FileLogger` 每次 `new` 时把级别读成快照，
 * 而主进程的子 logger（几十个）不会随设置变更重建 ——
 * 用户改级别后实际只对"之后新建的" logger 生效，看起来就是「改了没用」。
 * 因此这里刻意断言 **子 logger 也会跟着变**。
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileLogger, formatDay } from './logger.js'

async function withLogger(
  run: (ctx: { logger: FileLogger; dir: string; read: () => Promise<string> }) => Promise<void>,
  options: { level?: 'debug' | 'info' | 'warn' | 'error' } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aurora-logger-'))
  const logger = new FileLogger({
    dir,
    ...(options.level === undefined ? {} : { level: options.level }),
    // 固定时间：避免跨天时读到另一个文件
    now: () => new Date('2026-09-19T10:00:00Z'),
  })
  try {
    await run({
      logger,
      dir,
      read: () =>
        readFile(join(dir, `aurora-${formatDay(new Date('2026-09-19T10:00:00Z'))}.log`), 'utf8'),
    })
  } finally {
    await logger.close()
    await rm(dir, { recursive: true, force: true })
  }
}

describe('FileLogger 级别热更新', () => {
  it('setLevel 后立即生效，无需重建 logger', async () => {
    await withLogger(async ({ logger, read }) => {
      logger.setLevel('error')
      logger.info('这条不该出现')
      logger.error('这条要出现')
      await logger.close()

      const content = await read()
      expect(content).not.toContain('这条不该出现')
      expect(content).toContain('这条要出现')
    })
  })

  it('子 logger 共享同一个级别引用（改父级即改子级）', async () => {
    await withLogger(async ({ logger, read }) => {
      // 子 logger 是与父级同类型的实例（只是对外暴露为 Logger 接口），
      // 因此需要单独 close 才能保证它自己的写入队列落盘。
      const child = logger.child('agent') as unknown as FileLogger
      logger.setLevel('error')
      child.info('子级 info 应被过滤')
      child.error('子级 error 应保留')
      await child.close()
      await logger.close()

      const content = await read()
      expect(content).not.toContain('子级 info 应被过滤')
      expect(content).toContain('[agent]')
      expect(content).toContain('子级 error 应保留')
    })
  })

  it('setLevel 放宽后立刻能打出低级别日志', async () => {
    await withLogger(
      async ({ logger, read }) => {
        logger.debug('放宽前的 debug')
        logger.setLevel('debug')
        logger.debug('放宽后的 debug')
        await logger.close()

        const content = await read()
        expect(content).not.toContain('放宽前的 debug')
        expect(content).toContain('放宽后的 debug')
      },
      { level: 'warn' },
    )
  })

  it('默认级别为 info，且 getLevel 反映当前值', () => {
    const logger = new FileLogger({ dir: tmpdir() })
    expect(logger.getLevel()).toBe('info')
    logger.setLevel('debug')
    expect(logger.getLevel()).toBe('debug')
    // 子 logger 实际也是 FileLogger 实例，共享同一级别引用
    const child = logger.child('x') as unknown as FileLogger
    expect(child.getLevel()).toBe('debug')
    logger.setLevel('warn')
    expect(child.getLevel()).toBe('warn')
  })

  it('敏感的 meta 字段在写盘前脱敏', async () => {
    await withLogger(async ({ logger, read }) => {
      logger.info('带凭据', { apiKey: 'sk-secret-value', other: 1 })
      await logger.close()

      const content = await read()
      expect(content).not.toContain('sk-secret-value')
      expect(content).toContain('***')
    })
  })
})
