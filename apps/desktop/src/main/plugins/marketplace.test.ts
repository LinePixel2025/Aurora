import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { PluginManager } from './manager.js'
import { PluginMarketplaceClient } from './marketplace.js'

const PLUGIN_ID = 'com.example.market'
const PAYLOAD = Buffer.from('fake plugin zip bytes')

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

const ENTRY = {
  id: PLUGIN_ID,
  name: 'Market Demo',
  summary: '测试插件',
  author: 'Test',
  latestVersion: '1.2.0',
  updatedAt: '2026-10-01T00:00:00.000Z',
  downloads: 3,
  versions: [
    {
      version: '1.2.0',
      apiVersion: 1,
      sha256: sha256(PAYLOAD),
      size: PAYLOAD.byteLength,
      publishedAt: '2026-10-01T00:00:00.000Z',
    },
  ],
}

function makeManager(installedVersion?: string): {
  manager: PluginManager
  installs: Array<{ kind: string; path?: string; pluginId?: string; version?: string }>
} {
  const installs: Array<{ kind: string; path?: string; pluginId?: string; version?: string }> = []
  const manager = {
    updateCandidates: () =>
      installedVersion === undefined
        ? []
        : [{ pluginId: PLUGIN_ID, name: 'Market Demo', currentVersion: installedVersion }],
    install: async (ref: { kind: string; path?: string; pluginId?: string; version?: string }) => {
      installs.push({ ...ref })
      return {
        id: PLUGIN_ID,
        name: 'Market Demo',
        version: ref.version ?? '1.2.0',
      }
    },
  } as unknown as PluginManager
  return { manager, installs }
}

function marketplace(options: {
  manager: PluginManager
  enabled?: boolean
  serverUrl?: string
  payload?: Buffer
  failList?: boolean
}): {
  client: PluginMarketplaceClient
  calls: string[]
} {
  const calls: string[] = []
  const payload = options.payload ?? PAYLOAD
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/api/plugins?')) {
      if (options.failList === true) return new Response('boom', { status: 500 })
      return new Response(JSON.stringify({ total: 1, entries: [ENTRY] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.includes('/download')) {
      return new Response(payload, { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return {
    calls,
    client: new PluginMarketplaceClient({
      manager: options.manager,
      getCenter: () => ({
        enabled: options.enabled ?? true,
        serverUrl: options.serverUrl ?? 'https://center.example.com',
        token: '',
      }),
      fetchImpl: () => fetchImpl,
    }),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('PluginMarketplaceClient.list', () => {
  it('Center 未启用 / 未配置地址时给明确空态，不发请求', async () => {
    const { manager } = makeManager()
    const disabled = marketplace({ manager, enabled: false })
    expect(await disabled.client.list()).toMatchObject({
      entries: [],
      error: 'Aurora Center 未启用',
    })
    expect(disabled.calls).toEqual([])

    const noUrl = marketplace({ manager, serverUrl: '' })
    expect(await noUrl.client.list()).toMatchObject({ error: '尚未配置 Aurora Center 服务器地址' })
    expect(noUrl.calls).toEqual([])
  })

  it('标注已安装版本与更新；缓存内不重复请求，refresh 强制重拉', async () => {
    const { manager } = makeManager('1.0.0')
    const { client, calls } = marketplace({ manager })
    const first = await client.list()
    expect(first.entries[0]).toMatchObject({ installedVersion: '1.0.0', updateAvailable: true })
    expect(calls).toHaveLength(1)
    await client.list()
    expect(calls).toHaveLength(1)
    await client.list(true)
    expect(calls).toHaveLength(2)
  })

  it('网络失败转成 error 字段（不抛）', async () => {
    const { manager } = makeManager()
    const { client } = marketplace({ manager, failList: true })
    const result = await client.list()
    expect(result.entries).toEqual([])
    expect(result.error).toContain('读取插件市场失败')
  })
})

describe('PluginMarketplaceClient.install', () => {
  it('sha256 校验通过后以 kind=marketplace 交给安装器，临时文件清理掉', async () => {
    const { manager, installs } = makeManager()
    const { client } = marketplace({ manager })
    await client.install(PLUGIN_ID)
    expect(installs).toHaveLength(1)
    expect(installs[0]).toMatchObject({
      kind: 'marketplace',
      pluginId: PLUGIN_ID,
      version: '1.2.0',
    })
    expect(installs[0]?.path).toBeDefined()
    expect(existsSync(installs[0]!.path!)).toBe(false)
  })

  it('sha256 不匹配：拒绝安装且不调用安装器', async () => {
    const { manager, installs } = makeManager()
    const tampered = Buffer.from(PAYLOAD)
    tampered[0] = (tampered[0] ?? 0) ^ 0xff
    const { client } = marketplace({ manager, payload: tampered })
    await expect(client.install(PLUGIN_ID)).rejects.toThrow(/SHA-256 不匹配/)
    expect(installs).toEqual([])
  })

  it('未知插件 / 未知版本直接报错', async () => {
    const { manager } = makeManager()
    const { client } = marketplace({ manager })
    await expect(client.install('com.example.unknown')).rejects.toThrow(/市场里没有插件/)
    await expect(client.install(PLUGIN_ID, '9.9.9')).rejects.toThrow(/没有版本/)
  })
})

describe('PluginMarketplaceClient.checkUpdates', () => {
  it('只返回有更新的已安装插件，并带 latest 校验和', async () => {
    const { manager } = makeManager('1.0.0')
    const { client } = marketplace({ manager })
    expect(await client.checkUpdates()).toEqual([
      {
        pluginId: PLUGIN_ID,
        name: 'Market Demo',
        currentVersion: '1.0.0',
        latestVersion: '1.2.0',
        sha256: ENTRY.versions[0]!.sha256,
      },
    ])
  })

  it('已是最新时返回空数组', async () => {
    const { manager } = makeManager('1.2.0')
    const { client } = marketplace({ manager })
    expect(await client.checkUpdates()).toEqual([])
  })
})
