import { describe, expect, it } from 'vitest'
import { MAX_WEB_FETCH_CHARS } from './web-fetch.js'
import { createNetWebFetchPort } from './web-fetch.js'

/** 与 agent-core 的常量同源（re-export），这条断言防将来两边各自漂移 */
import { MAX_WEB_FETCH_CHARS as KERNEL_MAX } from '@aurora/agent-core'

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
