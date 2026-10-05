import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OfficeCliRunner, OfficeCliRunResult } from './office-cli.js'
import { handleOfficeRequest } from './office-worker.js'

let dir = ''
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aurora-office-worker-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function okResult(stdout = ''): OfficeCliRunResult {
  return { code: 0, stdout, stderr: '', timedOut: false }
}

function fakeRunner(options: {
  run?: (args: readonly string[]) => Promise<OfficeCliRunResult>
  json?: (args: readonly string[]) => Promise<{ envelope: unknown; run: OfficeCliRunResult }>
}): OfficeCliRunner {
  const run = vi.fn(async (args: readonly string[]) => (await options.run?.(args)) ?? okResult())
  const runJson = vi.fn(async (args: readonly string[]) => {
    if (options.json !== undefined) return options.json(args)
    return { envelope: { success: true, data: {} }, run: okResult() }
  })
  return { run, runJson } as unknown as OfficeCliRunner
}

describe('office-worker OfficeCLI adapter', () => {
  it('read text 直接返回 CLI 文本并带 warnings 字段', async () => {
    const runner = fakeRunner({
      run: async () => okResult('paragraph one\nparagraph two'),
    })
    const response = await handleOfficeRequest(
      {
        id: '1',
        action: 'read',
        timeoutMs: 1000,
        path: 'a.docx',
        format: 'docx',
        mode: 'text',
        offset: 0,
        limit: 20,
        depth: 1,
      },
      { runner },
    )
    expect(response.ok, response.error).toBe(true)
    expect(response.read?.content).toContain('paragraph one')
    expect(response.read?.warnings).toEqual([])
  })

  it('create 先创建空白文件，再 batch、validate，并收集 issues', async () => {
    const output = join(dir, 'created.docx')
    const runner = fakeRunner({
      json: async (args) => {
        if (args[0] === 'create') await writeFile(args[1]!, 'docx-bytes')
        if (args[0] === 'view' && args[2] === 'issues') {
          return {
            envelope: {
              success: true,
              data: { issues: [{ message: '字体不一致' }] },
            },
            run: okResult(),
          }
        }
        return { envelope: { success: true, data: {} }, run: okResult() }
      },
    })
    const response = await handleOfficeRequest(
      {
        id: '1',
        action: 'create',
        timeoutMs: 1000,
        outputPath: output,
        format: 'docx',
        commands: [{ command: 'add', parent: '/body', type: 'paragraph', props: { text: 'Hi' } }],
      },
      { runner },
    )
    expect(response.ok, response.error).toBe(true)
    expect(response.write?.bytes).toBe(10)
    expect(response.write?.warnings).toContain('字体不一致')
    expect(await readFile(output, 'utf8')).toBe('docx-bytes')
  })

  it('edit 在输出副本上执行 batch，源文件不变', async () => {
    const source = join(dir, 'source.docx')
    const output = join(dir, 'output.docx')
    await writeFile(source, 'source')
    const runner = fakeRunner({
      json: async (args) => {
        if (args[0] === 'batch') {
          await writeFile(args[1]!, 'edited')
        }
        return { envelope: { success: true, data: {} }, run: okResult() }
      },
    })
    const response = await handleOfficeRequest(
      {
        id: '1',
        action: 'edit',
        timeoutMs: 1000,
        sourcePath: source,
        outputPath: output,
        format: 'docx',
        commands: [{ command: 'set', path: '/body/p[1]', props: { text: 'new' } }],
      },
      { runner },
    )
    expect(response.ok).toBe(true)
    expect(await readFile(source, 'utf8')).toBe('source')
    expect(await readFile(output, 'utf8')).toBe('edited')
  })

  it('render screenshot 写出 PNG 并返回文件路径', async () => {
    const source = join(dir, 'deck.pptx')
    await writeFile(source, 'pptx')
    const runner = fakeRunner({
      run: async (args) => {
        if (args[0] === 'view' && args[2] === 'screenshot') {
          const out = args[args.indexOf('-o') + 1]
          if (out !== undefined) await writeFile(out, PNG)
        }
        return okResult()
      },
      json: async (args) => {
        if (args[0] === 'view' && args[2] === 'outline') {
          return {
            envelope: { success: true, data: { slides: [{}, {}] } },
            run: okResult(),
          }
        }
        return { envelope: { success: true, data: {} }, run: okResult() }
      },
    })
    const response = await handleOfficeRequest(
      {
        id: '1',
        action: 'render',
        timeoutMs: 1000,
        sourcePath: source,
        format: 'pptx',
        mode: 'screenshot',
        outputDir: join(dir, 'render'),
        maxPages: 2,
      },
      { runner },
    )
    expect(response.ok).toBe(true)
    expect(response.render?.files).toHaveLength(2)
    expect(response.render?.pageCount).toBe(2)
  })

  it('pdf 用逐页截图合成一个可重新打开的 PDF', async () => {
    const source = join(dir, 'deck.pptx')
    const output = join(dir, 'deck.pdf')
    await writeFile(source, 'pptx')
    const runner = fakeRunner({
      run: async (args) => {
        if (args[0] === 'view' && args[2] === 'screenshot') {
          const out = args[args.indexOf('-o') + 1]
          if (out !== undefined) await writeFile(out, PNG)
        }
        return okResult()
      },
      json: async (args) => {
        if (args[0] === 'view' && args[2] === 'outline') {
          return {
            envelope: { success: true, data: { slides: [{}] } },
            run: okResult(),
          }
        }
        return { envelope: { success: true, data: {} }, run: okResult() }
      },
    })
    const response = await handleOfficeRequest(
      {
        id: '1',
        action: 'pdf',
        timeoutMs: 1000,
        sourcePath: source,
        outputPath: output,
        format: 'pptx',
      },
      { runner },
    )
    expect(response.ok).toBe(true)
    expect(response.pdf?.pages).toBe(1)
    expect((await readFile(output)).subarray(0, 4).toString()).toBe('%PDF')
  })

  it('CLI 错误码与建议会原样回传', async () => {
    const runner = fakeRunner({
      json: async () => ({
        envelope: {
          success: false,
          error: { error: 'Slide not found', code: 'not_found', suggestion: 'Use 1-3' },
        },
        run: { code: 1, stdout: '', stderr: '', timedOut: false },
      }),
    })
    const response = await handleOfficeRequest(
      {
        id: '1',
        action: 'read',
        timeoutMs: 1000,
        path: 'deck.pptx',
        format: 'pptx',
        mode: 'issues',
        offset: 0,
        limit: 10,
        depth: 1,
      },
      { runner },
    )
    expect(response.ok).toBe(false)
    expect(response.code).toBe('not_found')
    expect(response.suggestion).toBe('Use 1-3')
  })
})
