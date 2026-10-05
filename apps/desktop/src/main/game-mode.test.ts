import { describe, expect, it, vi } from 'vitest'
import { createMemoryLogger } from '@aurora/shared'
import {
  GameModeController,
  parseGameModeProbeLine,
  windowsGameModeProbeScript,
  type GameModeSnapshot,
  type GameModeWatcherLike,
} from './game-mode.js'

class FakeWatcher implements GameModeWatcherLike {
  listener: ((snapshot: GameModeSnapshot) => void) | undefined
  starts = 0
  stops = 0

  start(listener: (snapshot: GameModeSnapshot) => void): void {
    this.starts += 1
    this.listener = listener
  }

  stop(): void {
    this.stops += 1
    this.listener = undefined
  }

  emit(snapshot: GameModeSnapshot): void {
    this.listener?.(snapshot)
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate() && Date.now() < deadline) await flush()
  if (!predicate()) throw new Error('等待条件超时')
}

describe('game-mode', () => {
  it('解析探针标记行，拒绝非法行', () => {
    expect(parseGameModeProbeLine('noise')).toBeUndefined()
    expect(parseGameModeProbeLine('AURORA_GAME|1|gamebar')).toEqual({
      active: true,
      reason: 'gamebar',
    })
    expect(parseGameModeProbeLine('AURORA_GAME|0|none')).toEqual({
      active: false,
      reason: 'none',
    })
    expect(parseGameModeProbeLine('AURORA_GAME|0|gamebar')).toBeUndefined()
    expect(parseGameModeProbeLine('AURORA_GAME|1|unknown')).toBeUndefined()
  })

  it('探针脚本同时检查 Game Bar 进程与独占全屏 D3D 状态', () => {
    const script = windowsGameModeProbeScript(100)
    expect(script).toContain('GameBarPresenceWriter')
    expect(script).toContain('SHQueryUserNotificationState')
    expect(script).toContain('$state -eq 3')
    expect(script).toContain('Start-Sleep -Milliseconds 500')
  })

  it('进入游戏触发 enter，退出触发 exit，顺序串行', async () => {
    const watcher = new FakeWatcher()
    const order: string[] = []
    const controller = new GameModeController({
      enabled: () => true,
      watcher,
      enter: async () => {
        await flush()
        order.push('enter')
      },
      exit: async () => {
        order.push('exit')
      },
      logger: createMemoryLogger(),
      supported: true,
    })
    controller.start()
    watcher.emit({ active: true, reason: 'gamebar' })
    watcher.emit({ active: false, reason: 'none' })
    await waitFor(() => order.length === 2)
    expect(order).toEqual(['enter', 'exit'])
    expect(controller.getStatus()).toEqual({ active: false, reason: 'none' })
    controller.stop()
  })

  it('配置关闭时停止探针并解除当前游戏态', async () => {
    const watcher = new FakeWatcher()
    const exit = vi.fn()
    let enabled = true
    const controller = new GameModeController({
      enabled: () => enabled,
      watcher,
      enter: () => undefined,
      exit,
      logger: createMemoryLogger(),
      supported: true,
    })
    controller.start()
    watcher.emit({ active: true, reason: 'fullscreen' })
    enabled = false
    controller.reconfigure()
    await flush()
    expect(watcher.stops).toBe(1)
    expect(exit).toHaveBeenCalledTimes(1)
    controller.stop()
  })
})
