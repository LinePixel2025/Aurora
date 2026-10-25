import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLUGIN_USAGE_DAYS, type Logger } from '@aurora/shared'
import { UsageStatsStore } from './usage-stats.js'

function silentLogger(): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  }
  return logger
}

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeStore(
  now: () => Date = () => new Date(2026, 9, 25, 12, 0, 0),
): Promise<{ store: UsageStatsStore; file: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'aurora-usage-stats-'))
  roots.push(root)
  const file = join(root, 'usage-stats.json')
  const store = new UsageStatsStore({
    file,
    logger: silentLogger(),
    now,
    flushDebounceMs: 0,
  })
  await store.init()
  return { store, file, root }
}

describe('UsageStatsStore · 汇总口径', () => {
  it('按本地日期分桶：默认 30 天，含空白日；Token 与缓存命中率正确', async () => {
    const clock = new Date(2026, 9, 23, 12, 0, 0)
    const { store } = await makeStore(() => clock)

    store.recordTokens(
      { promptTokens: 1000, completionTokens: 100, totalTokens: 1100, cachedTokens: 600 },
      { background: true },
    )
    clock.setDate(25)
    store.recordTokens({ promptTokens: 500, completionTokens: 50, totalTokens: 550 })

    const summary = store.summary()
    expect(summary.days).toBe(PLUGIN_USAGE_DAYS.default)
    expect(summary.from).toBe('2026-09-26')
    expect(summary.to).toBe('2026-10-25')
    expect(summary.daily).toHaveLength(30)
    expect(summary.tokens).toMatchObject({
      promptTokens: 1500,
      completionTokens: 150,
      totalTokens: 1650,
      cachedTokens: 600,
      rounds: 2,
      cacheHitRate: 0.4,
      background: {
        promptTokens: 1000,
        completionTokens: 100,
        totalTokens: 1100,
        cachedTokens: 600,
        rounds: 1,
      },
    })

    expect(summary.daily[29]).toMatchObject({
      date: '2026-10-25',
      tokens: { totalTokens: 550, rounds: 1 },
    })
    expect(summary.daily[27]).toMatchObject({
      date: '2026-10-23',
      tokens: { totalTokens: 1100, rounds: 1, cacheHitRate: 0.6 },
    })
    // 空白日也出现，值为 0（直接画折线不缺口）
    expect(summary.daily[0]).toMatchObject({
      date: '2026-09-26',
      tokens: { totalTokens: 0, rounds: 0, cacheHitRate: 0 },
      images: 0,
      voice: { tts: 0, stt: 0 },
    })
  })

  it('生图 / TTS / STT 只累计成功次数与字符数；窗口天数夹取到 1–90', async () => {
    const clock = new Date(2026, 9, 25, 9, 0, 0)
    const { store } = await makeStore(() => clock)

    store.recordImage()
    store.recordImage()
    store.recordTts(12)
    store.recordTts(8)
    store.recordStt(5)

    const summary = store.summary({ days: 7 })
    expect(summary.days).toBe(7)
    expect(summary.daily).toHaveLength(7)
    expect(summary.images.generated).toBe(2)
    expect(summary.voice).toEqual({ tts: 2, ttsChars: 20, stt: 1, sttChars: 5 })

    expect(store.summary({ days: 0 }).days).toBe(PLUGIN_USAGE_DAYS.min)
    expect(store.summary({ days: 1 }).days).toBe(1)
    expect(store.summary({ days: 999 }).days).toBe(PLUGIN_USAGE_DAYS.max)
    expect(store.summary({ days: Number.NaN }).days).toBe(PLUGIN_USAGE_DAYS.default)
  })

  it('空账本不伪造数据：全 0、命中率为 0', async () => {
    const { store } = await makeStore()
    const summary = store.summary()
    expect(summary.tokens.totalTokens).toBe(0)
    expect(summary.tokens.cacheHitRate).toBe(0)
    expect(summary.images.generated).toBe(0)
    expect(summary.voice).toEqual({ tts: 0, ttsChars: 0, stt: 0, sttChars: 0 })
  })
})

describe('UsageStatsStore · 落盘', () => {
  it('flush 后重新加载：日桶、后台拆分与字符数都保留', async () => {
    const clock = new Date(2026, 9, 25, 12, 0, 0)
    const { store, file } = await makeStore(() => clock)
    store.recordTokens(
      { promptTokens: 100, completionTokens: 10, totalTokens: 110, cachedTokens: 40 },
      { background: true },
    )
    store.recordImage()
    store.recordTts(3)
    store.recordStt(2)
    await store.flush()

    const raw = JSON.parse(await readFile(file, 'utf8')) as { version: number }
    expect(raw.version).toBe(1)

    const reloaded = new UsageStatsStore({
      file,
      logger: silentLogger(),
      now: () => clock,
      flushDebounceMs: 0,
    })
    await reloaded.init()
    const summary = reloaded.summary({ days: 1 })
    expect(summary.tokens).toMatchObject({
      totalTokens: 110,
      cachedTokens: 40,
      rounds: 1,
      background: { totalTokens: 110, rounds: 1 },
    })
    expect(summary.images.generated).toBe(1)
    expect(summary.voice).toEqual({ tts: 1, ttsChars: 3, stt: 1, sttChars: 2 })
  })

  it('损坏 / 畸形账本按空账本归化，不抛错', async () => {
    const { store, file } = await makeStore()
    await store.flush()
    await rm(file)
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        days: {
          '2026-10-25': { tokens: { promptTokens: -5, totalTokens: 'x' }, images: 3 },
          'not-a-date': { images: 9 },
        },
      }),
    )

    const reloaded = new UsageStatsStore({
      file,
      logger: silentLogger(),
      now: () => new Date(2026, 9, 25, 12, 0, 0),
    })
    await reloaded.init()
    const summary = reloaded.summary({ days: 1 })
    expect(summary.tokens.totalTokens).toBe(0)
    expect(summary.images.generated).toBe(3)
  })

  it('只保留最近 90 天：窗口外旧日桶在记录时被清理', async () => {
    const clock = new Date(2026, 9, 25, 12, 0, 0)
    const { store, file } = await makeStore(() => clock)
    store.recordImage()
    await store.flush()

    // 把账本时间推到 100 天后：旧日桶超出 90 天保留窗口，记录时应被清掉
    clock.setDate(clock.getDate() + 100)
    store.recordImage()
    await store.flush()
    const payload = JSON.parse(await readFile(file, 'utf8')) as { days: Record<string, unknown> }
    expect(Object.keys(payload.days)).toEqual(['2027-02-02'])
  })
})
