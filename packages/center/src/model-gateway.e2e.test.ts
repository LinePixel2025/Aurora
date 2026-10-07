import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthStore } from './auth.js'
import { createCenterServer, type RunningCenterServer } from './server.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return typeof address === 'object' && address !== null ? address.port : 0
}

async function startCenter(
  dataDir: string,
): Promise<{ server: RunningCenterServer; port: number }> {
  const auth = new AuthStore({ dataDir })
  await auth.init()
  await auth.ensureAdmin('admin', 'admin-password')
  const server = createCenterServer({ dataDir })
  const { port } = await server.listen(0, '127.0.0.1')
  return { server, port }
}

describe('Center 官方模型网关 · 端到端', () => {
  it('流式对话透传、记录真实 usage，并可被管理员用量接口读取', async () => {
    process.env['AURORA_CENTER_SECRET'] = 'gateway-test-master-secret'
    const upstream = createServer((req, res) => {
      if (req.url !== '/v1/chat/completions') {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n')
      res.write(
        'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15,"prompt_tokens_details":{"cached_tokens":5}}}\n\n',
      )
      res.end('data: [DONE]\n\n')
    })
    const upstreamPort = await listen(upstream)
    const dataDir = await mkdtemp(join(tmpdir(), 'aurora-center-gateway-'))
    const { server, port } = await startCenter(dataDir)
    cleanups.push(async () => {
      await server.close()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
      await rm(dataDir, { recursive: true, force: true })
      delete process.env['AURORA_CENTER_SECRET']
    })
    const base = `http://127.0.0.1:${port}`

    const adminLogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin-password' }),
    })
    const adminToken = ((await adminLogin.json()) as { token: string }).token
    const configured = await fetch(`${base}/api/admin/model-services/llm`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        type: 'openai-compat',
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        apiKey: 'upstream-key',
        defaultModel: 'm1',
        models: [
          { id: 'm1', enabled: true },
          { id: 'blocked', enabled: false },
        ],
      }),
    })
    expect(configured.ok).toBe(true)

    const clientLogin = await fetch(`${base}/api/client/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin-password', clientId: 'client-1' }),
    })
    const clientToken = ((await clientLogin.json()) as { token: string }).token

    const blocked = await fetch(`${base}/api/model-gateway/llm/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${clientToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'blocked', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(blocked.status).toBe(403)

    const streamed = await fetch(`${base}/api/model-gateway/llm/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${clientToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'm1',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    })
    expect(streamed.status).toBe(200)
    const text = await streamed.text()
    expect(text).toContain('hello')
    expect(text).toContain('[DONE]')

    const today = new Date().toISOString().slice(0, 10)
    const usageResponse = await fetch(`${base}/api/usage?from=${today}&to=${today}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const usage = (await usageResponse.json()) as {
      totals: { totalTokens: number; cachedTokens: number }
      recent: Array<{ model: string; clientId: string }>
    }
    expect(usage.totals.totalTokens).toBe(15)
    expect(usage.totals.cachedTokens).toBe(5)
    expect(usage.recent[0]).toMatchObject({ model: 'm1', clientId: 'client-1' })
  })
})
