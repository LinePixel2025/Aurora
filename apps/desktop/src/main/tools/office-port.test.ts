import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SnapshotPort } from '@aurora/agent-core'
import type { OfficePool } from '../office-pool.js'
import type { OfficeWorkerRunRequest } from '../office-protocol.js'
import { createNodeOfficePort } from './office-port.js'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aurora-office-port-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function fakePool(): OfficePool & { requests: OfficeWorkerRunRequest[] } {
  const requests: OfficeWorkerRunRequest[] = []
  return {
    requests,
    async run(request: OfficeWorkerRunRequest) {
      requests.push(request)
      if (request.action === 'read') {
        return {
          id: 'r',
          ok: true,
          read: { content: 'summary', truncated: false, warnings: [] },
        }
      }
      await writeFile(request.outputPath, 'generated')
      return { id: 'w', ok: true, write: { bytes: 9, warnings: [] } }
    },
  } as unknown as OfficePool & { requests: OfficeWorkerRunRequest[] }
}

function snapshots(
  result: Awaited<ReturnType<SnapshotPort['capture']>>,
): Pick<SnapshotPort, 'capture'> {
  return {
    capture: vi.fn(async () => result),
  }
}

describe('createNodeOfficePort', () => {
  it('read 校验扩展名与普通文件', async () => {
    const file = join(dir, 'a.docx')
    await writeFile(file, 'x')
    const port = createNodeOfficePort({
      pool: fakePool(),
      snapshots: snapshots({ skipped: 'disabled' }),
    })
    await expect(port.read({ path: file })).resolves.toMatchObject({
      absolutePath: file,
      format: 'docx',
      content: 'summary',
    })
    await expect(port.read({ path: join(dir, 'a.doc') })).rejects.toThrow('不支持')
  })

  it('create 默认拒绝覆盖已有文件', async () => {
    const file = join(dir, 'a.docx')
    await writeFile(file, 'old')
    const port = createNodeOfficePort({
      pool: fakePool(),
      snapshots: snapshots({ skipped: 'disabled' }),
    })
    await expect(
      port.create({ path: file, format: 'docx', content: {}, overwrite: false }),
    ).rejects.toThrow('已存在')
  })

  it('create 覆盖时必须有成功快照，然后原子替换', async () => {
    const file = join(dir, 'a.docx')
    await writeFile(file, 'old')
    const snapshot = {
      capture: vi.fn(async () => ({
        snapshot: {
          id: 'snap-1',
          sessionId: 's1',
          path: file,
          origin: 'office_edit' as const,
          createdAt: new Date().toISOString(),
          contentPath: 's1/snap-1.snap',
          bytes: 3,
          exists: true,
        },
      })),
    }
    const port = createNodeOfficePort({ pool: fakePool(), snapshots: snapshot })
    const result = await port.create({
      path: file,
      format: 'docx',
      content: {},
      overwrite: true,
      sessionId: 's1',
    })
    expect(result.snapshot).toEqual({ id: 'snap-1' })
    expect(await readFile(file, 'utf8')).toBe('generated')
  })

  it('edit 默认另存，不碰源文件；显式覆盖时强依赖快照', async () => {
    const source = join(dir, 'a.docx')
    await writeFile(source, 'old')
    const port = createNodeOfficePort({
      pool: fakePool(),
      snapshots: snapshots({ skipped: 'too-large' }),
    })
    const saved = await port.edit({
      path: source,
      overwrite: false,
      operations: [{ type: 'replace_text', find: 'a', replace: 'b' }],
    })
    expect(saved.absolutePath).not.toBe(source)
    expect(await readFile(source, 'utf8')).toBe('old')

    await expect(
      port.edit({
        path: source,
        overwrite: true,
        operations: [{ type: 'replace_text', find: 'a', replace: 'b' }],
      }),
    ).rejects.toThrow('已拒绝原地覆盖')

    await expect(
      port.edit({
        path: source,
        saveAs: source,
        overwrite: false,
        operations: [{ type: 'replace_text', find: 'a', replace: 'b' }],
      }),
    ).rejects.toThrow('saveAs 指向源文件')
  })
})
