import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { MAX_WEB_FETCH_CHARS } from './web-fetch.js'
import { createNetWebFetchPort } from './web-fetch.js'

/** 与 agent-core 的常量同源（re-export），这条断言防将来两边各自漂移 */
import { MAX_WEB_FETCH_CHARS as KERNEL_MAX } from '@aurora/agent-core'

/** 本地真实 HTTP 服务（P2-09 用真实 socket 验超时与限量，不打桩 fetch 的 body 语义） */
const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer((request, response) => {
    response.on('error', () => {
      /* 客户端提前 abort（限量 / 超时）会让服务端写入报错：测试里吞掉 */
    })
    handler(request, response)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}/`
}

function htmlResponse(body: string, contentType = 'text/html; charset=utf-8'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } })
}

describe('createNetWebFetchPort', () => {
  it('剥标签：script/style 整块移除、标签转空格、常见实体解码、空白压平', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} })
      return Promise.resolve(
        htmlResponse(
          [
            '<html><head><style>.a{color:red}</style></head>',
            '<body><!-- comment -->',
            '<script>alert(1)</script>',
            '<h1>标题&nbsp;&amp;&nbsp;摘要</h1>',
            '<p>正文&#x4e00;段，&quot;引用&quot;&#39;单引号&#39;&lt;标签&gt;</p>',
            '</body></html>',
          ].join(''),
        ),
      )
    }) as typeof fetch
    const port = createNetWebFetchPort({ fetchImpl: () => fetchImpl })

    const result = await port.fetch('https://example.com/post/1')

    expect(result.status).toBe(200)
    expect(result.text).toBe('标题 & 摘要 正文一段，"引用"\'单引号\'<标签>')
    expect(requests[0]!.init.method).toBe('GET')
  })

  it('非 HTML（JSON）不剥标签，原样压平', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response('{"a":"<b>保留</b>"}', { headers: { 'content-type': 'application/json' } }),
      )) as typeof fetch
    const port = createNetWebFetchPort({ fetchImpl: () => fetchImpl })
    const result = await port.fetch('https://example.com/api')
    expect(result.text).toBe('{"a":"<b>保留</b>"}')
  })

  it('超长文本按 MAX_WEB_FETCH_CHARS 截断并带省略标记', async () => {
    expect(MAX_WEB_FETCH_CHARS).toBe(KERNEL_MAX)
    const fetchImpl = (() =>
      Promise.resolve(htmlResponse('x'.repeat(MAX_WEB_FETCH_CHARS + 500)))) as typeof fetch
    const port = createNetWebFetchPort({ fetchImpl: () => fetchImpl })
    const result = await port.fetch('https://example.com/big')
    expect(result.text.length).toBeLessThanOrEqual(MAX_WEB_FETCH_CHARS + 60)
    expect(result.text).toContain('已截断')
  })

  it('只允许 http/https；非 2xx 仍回 status 与错误页文本（由工具层判 isError）', async () => {
    const port = createNetWebFetchPort({
      fetchImpl: () => (() => Promise.resolve(new Response(''))) as typeof fetch,
    })
    await expect(port.fetch('ftp://example.com')).rejects.toThrow('http/https')
    await expect(port.fetch('not a url')).rejects.toThrow('不是合法的网址')

    const failing = (() => Promise.resolve(new Response('nope', { status: 500 }))) as typeof fetch
    const errorPort = createNetWebFetchPort({ fetchImpl: () => failing })
    const result = await errorPort.fetch('https://example.com/broken')
    expect(result.status).toBe(500)
    expect(result.text).toBe('nope')
  })
})

/**
 * P2-09：超时只覆盖响应头 = 形同虚设（`clearTimeout` 在拿到响应头后即执行，
 * 随后的 `response.text()` 不受 abort 约束，工具可挂起数分钟并阻塞整轮 agentLoop）；
 * body 无大小上限 = 超大文件整体读入主进程内存。
 *
 * 这里用 node:http 起真实服务：`fetchImpl` 就是 `globalThis.fetch`（默认回落），
 * 因此打桩不了的那部分（响应头秒回但 body 停滞、持续推流）如实复现。
 */
describe('createNetWebFetchPort · body 超时与限量（P2-09）', () => {
  it('响应头秒回但 body 停滞：超时覆盖 body 读取，不会挂到 TCP 超时', async () => {
    const url = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('partial')
      // 故意不 end()：body 停滞（慢速 / 恶意服务器）
    })
    const port = createNetWebFetchPort({ fetchImpl: () => globalThis.fetch, timeoutMs: 500 })

    await expect(port.fetch(url)).rejects.toThrow('抓取超时')
  })

  it('超大 body 只读到上限附近即停，不把整份内容读进内存、带「已截断」标记', async () => {
    const CHUNK = 'x'.repeat(8 * 1024)
    const CHUNKS = 300 // ≈ 2.4MB：远大于下面的 maxChars
    const url = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      for (let index = 0; index < CHUNKS; index += 1) response.write(CHUNK)
      response.end()
    })
    const port = createNetWebFetchPort({
      fetchImpl: () => globalThis.fetch,
      timeoutMs: 5_000,
      maxChars: 1_000,
    })

    const result = await port.fetch(url)

    expect(result.status).toBe(200)
    // 回填文本被钉在上限附近（一个 chunk 的越界余量），不是 2.4MB
    expect(result.text.length).toBeLessThanOrEqual(1_000 + 60)
    expect(result.text).toContain('已截断')
  })

  it('正常小响应不受限量影响：完整返回、无截断标记', async () => {
    const url = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('hello world')
    })
    const port = createNetWebFetchPort({ fetchImpl: () => globalThis.fetch, timeoutMs: 5_000 })
    const result = await port.fetch(url)
    expect(result).toMatchObject({ status: 200, text: 'hello world' })
  })
})
