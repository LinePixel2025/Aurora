import { describe, expect, it, vi } from 'vitest'
import { createMemoryLogger } from '@aurora/shared'
import type { UpdateState } from '@aurora/shared'
import {
  UpdateService,
  describeUpdateError,
  resolveUpdateFeeds,
  type UpdaterPort,
} from './updater.js'

interface FakePortOptions {
  supported?: boolean
  checkResult?: { version: string } | null
  checkError?: unknown
  downloadError?: unknown
  feed?: string
}

function createFakePort(options: FakePortOptions = {}) {
  const state = {
    checkCalls: 0,
    downloadCalls: 0,
    installCalls: 0,
    progressListeners: new Set<
      (progress: { percent: number; transferred: number; total: number }) => void
    >(),
  }
  const port: UpdaterPort = {
    isSupported: () => options.supported ?? true,
    describeFeed: () => options.feed ?? 'github: LineFive/Aurora-releases',
    async checkForUpdates() {
      state.checkCalls += 1
      if (options.checkError !== undefined) throw options.checkError
      return options.checkResult ?? null
    },
    async downloadUpdate() {
      state.downloadCalls += 1
      if (options.downloadError !== undefined) throw options.downloadError
      // 模拟真实进度回调
      for (const listener of state.progressListeners) {
        listener({ percent: 42.4, transferred: 424, total: 1000 })
      }
    },
    quitAndInstall() {
      state.installCalls += 1
    },
    onDownloadProgress(listener) {
      state.progressListeners.add(listener)
      return () => state.progressListeners.delete(listener)
    },
  }
  return { port, state }
}

function createService(options: FakePortOptions & { autoCheckDelayMs?: number } = {}) {
  const { port, state } = createFakePort(options)
  const logger = createMemoryLogger()
  const service = new UpdateService({
    port,
    currentVersion: '0.3.0',
    logger,
    autoCheckDelayMs: options.autoCheckDelayMs ?? 0,
  })
  return { service, port, state, logger }
}

describe('UpdateService 状态机', () => {
  it('未打包（不支持自动更新）时为 disabled 且不发请求', async () => {
    const { service } = createService({ supported: false })
    expect(service.getState()).toMatchObject({ status: 'disabled', enabled: false })
    await service.check()
    expect(service.getState().status).toBe('disabled')
  })

  it('检查到新版本 → available，带可用版本与检查时间', async () => {
    const { service, state } = createService({ checkResult: { version: '0.4.0' } })
    const next = await service.check()
    expect(next).toMatchObject({
      status: 'available',
      availableVersion: '0.4.0',
      currentVersion: '0.3.0',
      enabled: true,
      feed: 'github: LineFive/Aurora-releases',
    })
    expect(next.checkedAt).toBeDefined()
    expect(state.checkCalls).toBe(1)
  })

  it('已是最新 → up-to-date', async () => {
    const { service } = createService({ checkResult: null })
    expect((await service.check()).status).toBe('up-to-date')
  })

  it('下载 → downloading 进度 → downloaded', async () => {
    const { service, state } = createService({ checkResult: { version: '0.4.0' } })
    await service.check()
    const next = await service.download()
    expect(next).toMatchObject({ status: 'downloaded', progressPercent: 100 })
    expect(state.downloadCalls).toBe(1)
  })

  it('下载过程中的进度事件被转换成百分比', async () => {
    const { service } = createService({ checkResult: { version: '0.4.0' } })
    const seen: number[] = []
    service.onStateChanged((snapshot) => {
      if (snapshot.status === 'downloading') seen.push(snapshot.progressPercent ?? -1)
    })
    await service.check()
    await service.download()
    expect(seen).toContain(42)
  })

  it('未检查到新版本时不允许下载', async () => {
    const { service, state } = createService({ checkResult: null })
    await service.check()
    await service.download()
    expect(state.downloadCalls).toBe(0)
    expect(service.getState().status).toBe('up-to-date')
  })

  it('检查失败 → error 且带人话说明；网络错误可识别', async () => {
    const { service } = createService({
      checkError: new Error('getaddrinfo ENOTFOUND github.com'),
    })
    const next = await service.check()
    expect(next.status).toBe('error')
    expect(next.error).toContain('网络不可达')
  })

  it('静默自动检查失败时只记 warn，不打断启动', async () => {
    // 关键顺序：**必须先装假定时器，再构造服务**。
    // `UpdateService` 在构造时就把 `setTimeout` 抓进 `setTimeoutImpl`，
    // 若先构造再 useFakeTimers，服务持有的是真实定时器 —— 假定时器推进不到它，
    // 只能赌真实 1ms 定时器抢在断言前跑完，于是这条断言会在负载高时随机失败。
    vi.useFakeTimers()
    try {
      const { service, logger } = createService({
        checkError: new Error('ENOTFOUND'),
        autoCheckDelayMs: 1,
      })
      service.scheduleAutoCheck()
      // 自动检查是 fire-and-forget：触发定时器后还要让 `checkForUpdates()` 的
      // Promise 落地（catch → fail → 写日志）才会留下 warn。
      await vi.advanceTimersByTimeAsync(10)
      expect(
        logger.entries.some((line) => line.includes('[warn]') && line.includes('更新失败')),
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('只允许在 downloaded 状态安装，安装后调用 quitAndInstall', async () => {
    const { service, state } = createService({ checkResult: { version: '0.4.0' } })
    expect(service.install()).toBe(false)
    await service.check()
    expect(service.install()).toBe(false) // available 还不能装
    await service.download()
    expect(service.install()).toBe(true)
    expect(state.installCalls).toBe(1)
  })

  it('状态变化会广播快照（不会泄漏内部引用）', async () => {
    const { service } = createService({ checkResult: { version: '0.4.0' } })
    const snapshots: UpdateState[] = []
    service.onStateChanged((snapshot) => snapshots.push(snapshot))
    await service.check()
    expect(snapshots.map((item) => item.status)).toEqual(['checking', 'available'])
    snapshots[0]!.status = 'error'
    expect(service.getState().status).toBe('available')
  })

  it('busy 期间重复 check 被忽略（不并发请求）', async () => {
    let release: (() => void) | undefined
    const { port, state } = createFakePort()
    port.checkForUpdates = async () => {
      state.checkCalls += 1
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { version: '0.4.0' }
    }
    const service = new UpdateService({ port, currentVersion: '0.3.0', autoCheckDelayMs: 0 })
    const first = service.check()
    await service.check()
    expect(state.checkCalls).toBe(1)
    release?.()
    await first
    expect(service.getState().status).toBe('available')
  })

  it('dispose 清理定时器与进度订阅', () => {
    const { port, state } = createFakePort()
    const service = new UpdateService({ port, currentVersion: '0.3.0', autoCheckDelayMs: 1000 })
    service.scheduleAutoCheck()
    service.dispose()
    expect(state.progressListeners.size).toBe(0)
  })
})

describe('更新源选择', () => {
  it('Center 优先并保留 GitHub 回退；未配置 Center 时只用 GitHub', () => {
    expect(resolveUpdateFeeds('', 'http://center.example/api/updates')).toEqual([
      'http://center.example/api/updates',
      '',
    ])
    expect(resolveUpdateFeeds('', undefined)).toEqual([''])
  })

  it('调试环境覆盖拥有最高优先级且不启用回退', () => {
    expect(resolveUpdateFeeds('http://127.0.0.1:9000/updates', 'http://center.example')).toEqual([
      'http://127.0.0.1:9000/updates',
    ])
  })
})

describe('describeUpdateError', () => {
  it('识别网络 / 清单缺失 / 校验失败三类常见错误', () => {
    expect(describeUpdateError(new Error('ETIMEDOUT'))).toContain('网络不可达')
    expect(describeUpdateError(new Error('Cannot find latest.yml'))).toContain('还没有可用的发行版')
    expect(describeUpdateError(new Error('sha512 checksum mismatch'))).toContain('校验失败')
    expect(describeUpdateError(new Error('something else'))).toContain('something else')
  })
})
