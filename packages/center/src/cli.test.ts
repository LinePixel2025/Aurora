import { describe, expect, it } from 'vitest'
import { mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  evaluateServerLock,
  inspectServerLock,
  SERVER_LOCK_STALE_MS,
  serverLockPath,
} from './server.js'
import { runCli } from './cli.js'

/**
 * CLI 侧的并发写护栏（P2-17，docs/12 §9）：运行中的服务器与 CLI 各自缓存整份
 * users.json，谁后写谁整文件覆盖 —— CLI 的改密会被服务器下一次落盘静默回滚。
 * 判定口径是数据目录里的 `server.lock`（服务器监听成功后创建、退出时删除，
 * 并每 15s 刷 mtime），崩溃残留的陈旧锁按 mtime 超时视为无服务器。
 */
describe('CLI · 服务器锁检测（P2-17）', () => {
  it('evaluateServerLock 三态：无锁放行 / 新鲜锁拒绝 / 陈旧锁放行', () => {
    const nowMs = 1_700_000_000_000
    expect(evaluateServerLock({ exists: false, mtimeMs: 0, nowMs })).toBe('none')
    expect(evaluateServerLock({ exists: true, mtimeMs: nowMs, nowMs })).toBe('running')
    expect(evaluateServerLock({ exists: true, mtimeMs: nowMs - SERVER_LOCK_STALE_MS, nowMs })).toBe(
      'running',
    )
    expect(
      evaluateServerLock({ exists: true, mtimeMs: nowMs - SERVER_LOCK_STALE_MS - 1, nowMs }),
    ).toBe('stale')
  })

  it('inspectServerLock 读盘：无锁 → none；新鲜锁 → running；陈旧锁 → stale', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aurora-center-cli-lock-'))
    expect(await inspectServerLock(dir)).toBe('none')

    const lockPath = serverLockPath(dir)
    await writeFile(lockPath, JSON.stringify({ pid: 4242, startedAt: '2026-10-01T00:00:00Z' }))
    expect(await inspectServerLock(dir)).toBe('running')

    // 崩溃残留：把 mtime 拨到陈旧窗口之外
    const stale = new Date(Date.now() - SERVER_LOCK_STALE_MS - 60_000)
    await utimes(lockPath, stale, stale)
    expect(await inspectServerLock(dir)).toBe('stale')
  })

  it('users add / passwd / remove 在服务器运行中拒绝执行（users list 不受限）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aurora-center-cli-refuse-'))
    await writeFile(serverLockPath(dir), JSON.stringify({ pid: 1, startedAt: 'now' }))

    const out: string[] = []
    const err: string[] = []
    const write = (argv: string[]): Promise<number> =>
      runCli({ argv, stdout: (line) => out.push(line), stderr: (line) => err.push(line) })

    const code = await write(['users', 'add', 'blocked', '--password', 'abcdef', '--data', dir])
    expect(code).toBe(1)
    expect(err.join('\n')).toContain('停止服务器')
    expect(err.join('\n')).toContain(serverLockPath(dir))
    // 拒绝发生在写盘之前：用户没有被悄悄建出来
    expect(out.join('\n')).not.toContain('已创建用户')

    expect(await write(['users', 'passwd', 'blocked', '--password', 'abcdef', '--data', dir])).toBe(
      1,
    )
    expect(await write(['users', 'remove', 'blocked', '--data', dir])).toBe(1)
    // 只读的 list 不需要停服（它不写 users.json）
    expect(await write(['users', 'list', '--data', dir])).toBe(0)
  }, 20_000)

  it('无锁（或陈旧锁）时照常执行：陈旧锁只提示、不拦', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aurora-center-cli-stale-'))
    const lockPath = serverLockPath(dir)
    await writeFile(lockPath, JSON.stringify({ pid: 1, startedAt: 'stale' }))
    const stale = new Date(Date.now() - SERVER_LOCK_STALE_MS - 60_000)
    await utimes(lockPath, stale, stale)

    const out: string[] = []
    const err: string[] = []
    const code = await runCli({
      argv: ['users', 'add', 'fresh', '--password', 'abcdef', '--data', dir],
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    })
    expect(code).toBe(0)
    expect(out.join('\n')).toContain('已创建用户 fresh')
    expect(err.join('\n')).toContain('陈旧锁文件')
  }, 20_000)
})
