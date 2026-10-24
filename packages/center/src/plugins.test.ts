import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { PluginStore, inspectPluginArchive } from './plugins.js'

const MANIFEST = {
  id: 'com.example.market',
  name: 'Market Demo',
  version: '1.0.0',
  apiVersion: 1,
  description: '市场测试插件',
  author: { name: 'Test' },
  main: 'main.js',
  permissions: ['skills', 'ui.panels'],
  contributes: {
    skills: ['skills/demo'],
    panels: [{ id: 'board', title: '看板', schema: 'ui/panel.json' }],
  },
}

function archive(files: Record<string, string | Uint8Array> = {}): Buffer {
  const entries: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(MANIFEST)),
    'main.js': strToU8('module.exports = {}'),
    'skills/demo/SKILL.md': strToU8('---\nname: demo\n---\n'),
    'ui/panel.json': strToU8('{"version":1,"nodes":[]}'),
    ...Object.fromEntries(
      Object.entries(files).map(([name, value]) => [
        name,
        typeof value === 'string' ? strToU8(value) : value,
      ]),
    ),
  }
  return Buffer.from(zipSync(entries))
}

describe('inspectPluginArchive', () => {
  it('合法包返回清单、sha256 与文件清单', () => {
    const result = inspectPluginArchive(archive())
    expect(result.manifest.id).toBe('com.example.market')
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(result.files).toContain('skills/demo/SKILL.md')
  })

  it('拒绝上级路径 / 缺 main / 缺 SKILL.md', () => {
    expect(() => inspectPluginArchive(archive({ '../evil.js': 'x' }))).toThrow(/上级路径/)
    expect(() =>
      inspectPluginArchive(
        archive({
          'manifest.json': JSON.stringify({ ...MANIFEST, main: 'missing.js' }),
        }),
      ),
    ).toThrow(/main 入口/)
    const entries: Record<string, Uint8Array> = {
      'manifest.json': strToU8(JSON.stringify(MANIFEST)),
      'main.js': strToU8('x'),
      'ui/panel.json': strToU8('{}'),
    }
    expect(() => inspectPluginArchive(Buffer.from(zipSync(entries)))).toThrow(/SKILL\.md/)
  })

  it('非 zip / 清单不合法直接拒绝', () => {
    expect(() => inspectPluginArchive(Buffer.from('not a zip'))).toThrow(/zip/)
    const bad = Buffer.from(
      zipSync({
        'manifest.json': strToU8(JSON.stringify({ ...MANIFEST, apiVersion: 99 })),
        'main.js': strToU8('x'),
      }),
    )
    expect(() => inspectPluginArchive(bad)).toThrow(/清单校验失败/)
  })
})

describe('PluginStore', () => {
  let dir = ''
  let store: PluginStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aurora-center-plugins-'))
    store = new PluginStore({ dataDir: dir })
    await store.init()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function publish(version: string, changelog?: string) {
    const body = archive({
      'manifest.json': JSON.stringify({ ...MANIFEST, version }),
    })
    const staged = await store.stage(body)
    return await store.publish(staged.token, changelog)
  }

  it('stage → publish：进入市场、latestVersion 取最高版本、同版本不可覆盖', async () => {
    const first = await publish('1.0.0', '首个版本')
    expect(first.latestVersion).toBe('1.0.0')
    expect(first.versions[0]?.changelog).toBe('首个版本')
    expect(store.list({}).total).toBe(1)

    await publish('1.2.0')
    const entry = store.get(MANIFEST.id)
    expect(entry?.latestVersion).toBe('1.2.0')
    expect(entry?.versions.map((item) => item.version)).toEqual(['1.2.0', '1.0.0'])

    const duplicate = await store.stage(archive())
    await expect(store.publish(duplicate.token)).rejects.toThrow(/不能覆盖/)
  })

  it('assetOf 指向归档文件；remove 回落到剩余最高版本、删空后条目消失', async () => {
    await publish('1.0.0')
    await publish('1.1.0')
    const asset = store.assetOf(MANIFEST.id)
    expect(asset?.fileName).toBe(`${MANIFEST.id}-1.1.0.aurora-plugin`)
    expect(asset?.sha256).toMatch(/^[0-9a-f]{64}$/)

    expect(await store.remove(MANIFEST.id, '1.1.0')).toBe(true)
    expect(store.get(MANIFEST.id)?.latestVersion).toBe('1.0.0')
    expect(await store.remove(MANIFEST.id, '1.0.0')).toBe(true)
    expect(store.get(MANIFEST.id)).toBeUndefined()
    expect(store.list({}).total).toBe(0)
  })

  it('搜索 / 分页；下载计数增加', async () => {
    await publish('1.0.0')
    expect(store.list({ q: 'market' }).total).toBe(1)
    expect(store.list({ q: '不存在的词' }).total).toBe(0)
    await store.recordDownload(MANIFEST.id)
    expect(store.get(MANIFEST.id)?.downloads).toBe(1)
  })

  it('图标只接受 PNG 且 ≤256 KB', async () => {
    await publish('1.0.0')
    await expect(store.setIcon(MANIFEST.id, Buffer.from('GIF89a'))).rejects.toThrow(/PNG/)
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(32),
    ])
    await store.setIcon(MANIFEST.id, png)
    expect(store.get(MANIFEST.id)?.iconUrl).toBe(`/api/plugins/${MANIFEST.id}/icon`)
    expect(store.iconPathOf(MANIFEST.id)).toContain('icons')
  })
})
