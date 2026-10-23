import { describe, expect, it } from 'vitest'
import { createDefaultSettings, createMemoryLogger } from '@aurora/shared'
import type { CenterOfficialModelCatalog, Settings } from '@aurora/shared'
import { CenterModelServices } from './model-services.js'

const catalog: CenterOfficialModelCatalog = {
  revision: 'rev-1',
  services: {
    llm: {
      type: 'openai-responses',
      defaultModel: 'm1',
      models: [{ id: 'm1' }, { id: 'm2', contextWindow: 128000 }],
    },
  },
}

function settingsOf(): Settings {
  const settings = createDefaultSettings()
  settings.center.enabled = true
  settings.center.serverUrl = 'http://center.test:8787'
  return settings
}

function servicesOf(
  fetchImpl: typeof fetch,
  cache: { read(serverUrl: string): unknown; write(serverUrl: string, value: unknown): void } = {
    read: () => null,
    write: () => undefined,
  },
): CenterModelServices {
  const settings = settingsOf()
  return new CenterModelServices({
    settings: { get: () => settings, update: () => settings },
    logger: createMemoryLogger(),
    fetchImpl: () => fetchImpl,
    config: () => ({
      enabled: true,
      serverUrl: settings.center.serverUrl,
      token: 'ac-token',
      clientId: 'client-1',
    }),
    cache,
  })
}

const rejectFetch = (async () => {
  throw new Error('offline')
}) as unknown as typeof fetch

describe('CenterModelServices · 目录快照', () => {
  it('启动时用本机缓存把目录置为已就绪（首个请求不会误判官方不可用）', () => {
    const services = servicesOf(rejectFetch, {
      read: (serverUrl) => (serverUrl === 'http://center.test:8787' ? catalog : null),
      write: () => undefined,
    })
    expect(services.loaded()).toBe(true)
    expect(services.service('llm')?.defaultModel).toBe('m1')
  })

  it('缓存的服务器地址不匹配时忽略快照', () => {
    const services = new CenterModelServices({
      settings: { get: () => settingsOf(), update: () => undefined },
      logger: createMemoryLogger(),
      fetchImpl: () => rejectFetch,
      config: () => ({
        enabled: true,
        serverUrl: 'http://another.test:8787',
        token: 'ac-token',
        clientId: 'client-1',
      }),
      cache: {
        read: (serverUrl) => (serverUrl === 'http://center.test:8787' ? catalog : null),
        write: () => undefined,
      },
    })
    expect(services.loaded()).toBe(false)
  })

  it('刷新成功时写回快照', async () => {
    const writes: Array<{ serverUrl: string; value: unknown }> = []
    const services = servicesOf(
      (async () =>
        new Response(JSON.stringify(catalog), { status: 200 })) as unknown as typeof fetch,
      {
        read: () => null,
        write: (serverUrl, value) => writes.push({ serverUrl, value }),
      },
    )
    await services.refresh()
    expect(services.loaded()).toBe(true)
    expect(writes).toEqual([{ serverUrl: 'http://center.test:8787', value: catalog }])
  })

  it('网络失败保留已有目录（不静默切回本机模型）', async () => {
    let online = true
    const services = servicesOf((async () =>
      online
        ? new Response(JSON.stringify(catalog), { status: 200 })
        : Promise.reject(new Error('offline'))) as unknown as typeof fetch)
    await services.refresh()
    online = false
    await services.refresh()
    expect(services.loaded()).toBe(true)
  })

  it('凭据失效（401）清空目录', async () => {
    let status = 200
    const services = servicesOf((async () =>
      status === 200
        ? new Response(JSON.stringify(catalog), { status })
        : new Response('', { status })) as unknown as typeof fetch)
    await services.refresh()
    expect(services.loaded()).toBe(true)
    status = 401
    await services.refresh()
    expect(services.loaded()).toBe(false)
  })

  it('refreshIfStale 在节流窗口内不重复请求', async () => {
    let calls = 0
    const services = servicesOf((async () => {
      calls += 1
      return new Response(JSON.stringify(catalog), { status: 200 })
    }) as unknown as typeof fetch)
    services.refreshIfStale()
    await new Promise((resolve) => setTimeout(resolve, 0))
    services.refreshIfStale()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toBe(1)
  })
})
