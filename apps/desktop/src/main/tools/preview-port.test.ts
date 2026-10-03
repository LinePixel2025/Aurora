/**
 * `show_preview` 的主进程端口（2026-10-03，docs/06 §14）：
 * 用**真实临时目录**测边界校验与 file:// 转换（没有值得替换的抽象层）。
 */
import { promises as nodeFs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMemoryLogger } from '@aurora/shared'
import { createPreviewPort, type PreviewPresentPayload } from './preview-port.js'

let base = ''
let outside = ''

beforeAll(async () => {
  base = await nodeFs.mkdtemp(join(tmpdir(), 'aurora-preview-port-'))
  outside = await nodeFs.mkdtemp(join(tmpdir(), 'aurora-preview-port-out-'))
  await nodeFs.mkdir(join(base, 'reports'), { recursive: true })
  await nodeFs.writeFile(join(base, 'reports', 'index.html'), '<h1>报告</h1>', 'utf8')
  await nodeFs.writeFile(join(outside, 'secret.html'), '<h1>越界</h1>', 'utf8')
})

afterAll(async () => {
  if (base !== '') await nodeFs.rm(base, { recursive: true, force: true })
  if (outside !== '') await nodeFs.rm(outside, { recursive: true, force: true })
})

function setup(): { port: ReturnType<typeof createPreviewPort>; shown: PreviewPresentPayload[] } {
  const shown: PreviewPresentPayload[] = []
  const port = createPreviewPort({
    workspaceDirOf: () => base,
    boundaryRootOf: () => base,
    present: (payload) => shown.push(payload),
    logger: createMemoryLogger(),
  })
  return { port, shown }
}

describe('createPreviewPort（show_preview 的主进程实现）', () => {
  it('http / https 网址直接放行，原样推送', async () => {
    const { port, shown } = setup()
    const outcome = await port.show('https://example.com/a?b=1', {
      sessionId: 's1',
      title: '示例',
    })
    expect(outcome.url).toBe('https://example.com/a?b=1')
    expect(outcome.display).toBe('https://example.com/a?b=1')
    expect(shown).toEqual([
      {
        sessionId: 's1',
        url: 'https://example.com/a?b=1',
        display: 'https://example.com/a?b=1',
        title: '示例',
      },
    ])
  })

  it('其它协议在入口即拒绝（file: / javascript: 都不放行）', async () => {
    const { port, shown } = setup()
    await expect(
      port.show('file:///C:/Windows/win.ini', { sessionId: 's1', title: '' }),
    ).rejects.toThrow(/存在|普通文件|边界/)
    await expect(port.show('javascript:alert(1)', { sessionId: 's1', title: '' })).rejects.toThrow()
    expect(shown).toEqual([])
  })

  it('相对路径按会话工作目录解析，转成 file:// 推送', async () => {
    const { port, shown } = setup()
    const outcome = await port.show(join('reports', 'index.html'), { sessionId: 's1', title: '' })
    expect(outcome.url).toBe(pathToFileURL(join(base, 'reports', 'index.html')).toString())
    expect(outcome.display).toBe(join(base, 'reports', 'index.html'))
    expect(shown[0]?.url.startsWith('file:///')).toBe(true)
  })

  it('绝对路径同样支持（边界根之内）', async () => {
    const { port } = setup()
    const target = join(base, 'reports', 'index.html')
    await expect(port.show(target, { sessionId: 's1', title: '' })).resolves.toEqual({
      url: pathToFileURL(target).toString(),
      display: target,
    })
  })

  it('越界文件 / 不存在的文件都拒绝，且不推送', async () => {
    const { port, shown } = setup()
    await expect(
      port.show(join(outside, 'secret.html'), { sessionId: 's1', title: '' }),
    ).rejects.toThrow(/边界之外/)
    await expect(
      port.show(join(base, 'nope.html'), { sessionId: 's1', title: '' }),
    ).rejects.toThrow(/不存在/)
    expect(shown).toEqual([])
  })

  it('空 target 直接拒绝', async () => {
    const { port } = setup()
    await expect(port.show('   ', { sessionId: 's1', title: '' })).rejects.toThrow(/缺少/)
  })

  it('子代理会话 id（`-sub`）剥回父会话后再推送', async () => {
    const { port, shown } = setup()
    await port.show('https://example.com', { sessionId: 's1-sub', title: '' })
    expect(shown[0]?.sessionId).toBe('s1')
  })

  it('边界根解析不出来时拒绝本地文件（不退回无边界）', async () => {
    const shown: PreviewPresentPayload[] = []
    const port = createPreviewPort({
      workspaceDirOf: () => base,
      boundaryRootOf: () => undefined,
      present: (payload) => shown.push(payload),
      logger: createMemoryLogger(),
    })
    await expect(
      port.show(join(base, 'reports', 'index.html'), { sessionId: 's1', title: '' }),
    ).rejects.toThrow(/没有可用的工作目录/)
    expect(shown).toEqual([])
  })
})
