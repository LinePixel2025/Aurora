import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OfficeCliRunner } from './office-cli.js'
import { handleOfficeRequest } from './office-worker.js'

const CLI = join(process.cwd(), 'apps', 'desktop', 'resources', 'officecli', 'officecli.exe')
const describeReal = existsSync(CLI) ? describe : describe.skip

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aurora-office-real-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describeReal('OfficeCLI 真实闭环', () => {
  it('DOCX 创建 → 读取 → 编辑 → 截图 → PDF', async () => {
    const runner = new OfficeCliRunner({ binaryPath: CLI })
    const file = join(dir, 'report.docx')
    const pdf = join(dir, 'report.pdf')

    const created = await handleOfficeRequest(
      {
        id: 'create',
        action: 'create',
        timeoutMs: 45_000,
        outputPath: file,
        format: 'docx',
        commands: [
          {
            command: 'add',
            parent: '/body',
            type: 'paragraph',
            props: { text: 'AURORA_REAL_OK', style: 'Heading1' },
          },
          {
            command: 'add',
            parent: '/body',
            type: 'paragraph',
            props: { text: '第二段' },
          },
        ],
      },
      { runner },
    )
    expect(created.ok, created.error).toBe(true)

    const read = await handleOfficeRequest(
      {
        id: 'read',
        action: 'read',
        timeoutMs: 45_000,
        path: file,
        format: 'docx',
        mode: 'text',
        offset: 0,
        limit: 20,
        depth: 1,
      },
      { runner },
    )
    expect(read.ok, read.error).toBe(true)
    expect(read.read?.content).toContain('AURORA_REAL_OK')

    const editedOutput = join(dir, 'report-edited.docx')
    const edited = await handleOfficeRequest(
      {
        id: 'edit',
        action: 'edit',
        timeoutMs: 45_000,
        sourcePath: file,
        outputPath: editedOutput,
        format: 'docx',
        commands: [
          {
            command: 'set',
            path: '/',
            props: { find: 'AURORA_REAL_OK', replace: 'AURORA_REAL_EDITED' },
          },
        ],
      },
      { runner },
    )
    expect(edited.ok, edited.error).toBe(true)
    expect((await readFile(editedOutput)).byteLength).toBeGreaterThan(0)

    const rendered = await handleOfficeRequest(
      {
        id: 'render',
        action: 'render',
        timeoutMs: 120_000,
        sourcePath: editedOutput,
        format: 'docx',
        mode: 'screenshot',
        outputDir: join(dir, 'preview'),
        pageStart: 1,
        pageEnd: 1,
        maxPages: 1,
      },
      { runner },
    )
    expect(rendered.ok, rendered.error).toBe(true)
    expect(rendered.render?.files).toHaveLength(1)
    expect((await stat(rendered.render!.files[0]!)).size).toBeGreaterThan(0)

    const exported = await handleOfficeRequest(
      {
        id: 'pdf',
        action: 'pdf',
        timeoutMs: 120_000,
        sourcePath: editedOutput,
        outputPath: pdf,
        format: 'docx',
      },
      { runner },
    )
    expect(exported.ok, exported.error).toBe(true)
    expect(exported.pdf?.pages).toBeGreaterThan(0)
    expect((await readFile(pdf)).subarray(0, 4).toString()).toBe('%PDF')
  }, 120_000)
})
