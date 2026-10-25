import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { createCenterServer, type RunningCenterServer } from './server.js'

const MANIFEST = {
  id: 'com.example.market',
  name: 'Market Demo',
  version: '1.0.0',
  apiVersion: 1,
  description: '市场集成测试',
  author: { name: 'Test' },
  main: 'main.js',
  permissions: ['tools'],
  contributes: {
    tools: [
      {
        name: 'echo',
        description: '回显',
        parameters: { type: 'object', properties: {} },
        readonly: true,
      },
    ],
  },
}

function archive(): Buffer {
  return Buffer.from(
    zipSync({
      'manifest.json': strToU8(JSON.stringify(MANIFEST)),
      'main.js': strToU8('module.exports = {}'),
    }),
  )
}

let server: RunningCenterServer
let base = ''
let dataDir = ''
let adminToken = ''
let userToken = ''

async function login(username: string, password: string): Promise<string> {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as { token: string }
  return body.token
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'aurora-center-plugin-e2e-'))
  const { AuthStore } = await import('./auth.js')
  const boot = new AuthStore({ dataDir })
  await boot.init()
  await boot.createUser({ username: 'root', password: 'root-pass-123', role: 'admin' })
  await boot.createUser({ username: 'alice', password: 'alice-pass-123', role: 'user' })
  server = createCenterServer({ dataDir })
  const { port } = await server.listen(0, '127.0.0.1')
  base = `http://127.0.0.1:${port}`
  adminToken = await login('root', 'root-pass-123')
  userToken = await login('alice', 'alice-pass-123')
}, 20_000)

afterAll(async () => {
  await server.close()
  await rm(dataDir, { recursive: true, force: true })
})

describe('Center 插件市场', () => {
  it('管理员上传 / 发布后公开可见可下载；普通用户不能管理', async () => {
    const body = archive()

    const forbidden = await fetch(`${base}/api/admin/plugins/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/octet-stream' },
      body,
    })
    expect(forbidden.status).toBe(403)

    const upload = await fetch(`${base}/api/admin/plugins/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/octet-stream',
      },
      body,
    })
    expect(upload.status).toBe(200)
    const staged = (await upload.json()) as {
      token: string
      plugin: { id: string; version: string; sha256: string }
    }
    expect(staged.plugin).toMatchObject({ id: MANIFEST.id, version: '1.0.0' })

    const publish = await fetch(`${base}/api/admin/plugins/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: staged.token, changelog: '首个版本' }),
    })
    expect(publish.status).toBe(200)

    // 公开浏览（不带令牌）
    const list = await fetch(`${base}/api/plugins`)
    expect(list.status).toBe(200)
    const listed = (await list.json()) as { total: number; entries: Array<{ id: string }> }
    expect(listed.total).toBe(1)
    expect(listed.entries[0]?.id).toBe(MANIFEST.id)

    // 下载：校验和与内容一致
    const download = await fetch(`${base}/api/plugins/${MANIFEST.id}/download`)
    expect(download.status).toBe(200)
    expect(download.headers.get('x-checksum-sha256')).toBe(
      createHash('sha256').update(body).digest('hex'),
    )
    expect(Buffer.from(await download.arrayBuffer()).byteLength).toBe(body.byteLength)

    // 普通用户不能删
    const deleteForbidden = await fetch(`${base}/api/admin/plugins/${MANIFEST.id}/1.0.0`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${userToken}` },
    })
    expect(deleteForbidden.status).toBe(403)

    const remove = await fetch(`${base}/api/admin/plugins/${MANIFEST.id}/1.0.0`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(remove.status).toBe(200)
    const after = await fetch(`${base}/api/plugins`)
    expect(((await after.json()) as { total: number }).total).toBe(0)
  })

  it('非法包在 upload 阶段就被拒绝（不落 staging）', async () => {
    const response = await fetch(`${base}/api/admin/plugins/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/octet-stream',
      },
      body: Buffer.from('not a zip'),
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toContain('zip')
  })
})

const PAGE_MANIFEST = {
  id: 'com.example.page',
  name: 'Page Demo',
  version: '1.0.0',
  apiVersion: 1,
  description: '页面型面板集成测试',
  author: { name: 'Test' },
  main: 'main.js',
  permissions: ['ui.panels'],
  contributes: {
    panels: [{ id: 'counter', title: '计数器', entry: 'ui/page.html' }],
  },
}

const PAGE_HTML = '<!doctype html><html><head><title>page</title></head><body>hi</body></html>'

function pageArchive(): Buffer {
  return Buffer.from(
    zipSync({
      'manifest.json': strToU8(JSON.stringify(PAGE_MANIFEST)),
      'main.js': strToU8('module.exports = {}'),
      'ui/page.html': strToU8(PAGE_HTML),
      'ui/app.js': strToU8('console.log(1)'),
      'ui/data.svg': strToU8('<svg/>'),
    }),
  )
}

describe('Center 页面型面板资源（/p/）', () => {
  beforeAll(async () => {
    const upload = await fetch(`${base}/api/admin/plugins/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/octet-stream',
      },
      body: pageArchive(),
    })
    expect(upload.status).toBe(200)
    const staged = (await upload.json()) as { token: string }
    const publish = await fetch(`${base}/api/admin/plugins/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: staged.token }),
    })
    expect(publish.status).toBe(200)
  })

  const assetUrl = (path: string): string =>
    `${base}/p/${PAGE_MANIFEST.id}/${PAGE_MANIFEST.version}/${path}`

  it('HTML 注入桥 + CSP + no-cache；脚本资源 immutable；带 nosniff', async () => {
    const html = await fetch(assetUrl('ui/page.html'))
    expect(html.status).toBe(200)
    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(html.headers.get('cache-control')).toBe('no-cache')
    expect(html.headers.get('x-content-type-options')).toBe('nosniff')
    const csp = html.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain('sandbox allow-scripts')
    expect(csp).toContain('frame-ancestors')
    const body = await html.text()
    expect(body).toContain('window.auroraPlugin')
    expect(body).toContain('<title>page</title>')

    const js = await fetch(assetUrl('ui/app.js'))
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(js.headers.get('cache-control')).toContain('immutable')
    expect(js.headers.get('content-security-policy')).toBeNull()
    expect(await js.text()).toBe('console.log(1)')
  })

  it('HEAD 只回头部；穿越 / 非白名单 / 未知版本 / 缺文件都是 404', async () => {
    const head = await fetch(assetUrl('ui/page.html'), { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(Number(head.headers.get('content-length'))).toBeGreaterThan(0)
    expect(await head.text()).toBe('')

    expect((await fetch(assetUrl('..%2Fsecret.js'))).status).toBe(404)
    expect((await fetch(assetUrl('ui/data.svg'))).status).toBe(404)
    expect((await fetch(assetUrl('ui/missing.js'))).status).toBe(404)
    expect((await fetch(`${base}/p/${PAGE_MANIFEST.id}/9.9.9/ui/page.html`)).status).toBe(404)
  })
})
