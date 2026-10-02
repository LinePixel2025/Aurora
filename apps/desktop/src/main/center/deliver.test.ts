/**
 * 服务器下发文件的落地（docs/12 §5，本轮）：`downloadFileFromCenter`。
 *
 * 三个判据都是「错了会让用户丢文件或拿到坏文件」的那一类：
 * 重名不覆盖、超限不留半截、失败映射成可读原因（错误会一路回到网页端提示）。
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CenterDeliverError, downloadFileFromCenter } from './deliver.js'

let dir = ''

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'aurora-deliver-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** 造一个返回给定内容 / 状态码的 fetch 桩 */
function fetchOf(
  body: Uint8Array | string,
  init: { status?: number; contentType?: string } = {},
): typeof fetch {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  return (async () =>
    new Response(bytes, {
      status: init.status ?? 200,
      headers: { 'Content-Type': init.contentType ?? 'application/octet-stream' },
    })) as unknown as typeof fetch
}

const base = {
  serverUrl: 'ws://127.0.0.1:8787',
  token: 'client-token',
  clientId: 'client-1',
  fileId: 'f-1',
}

describe('downloadFileFromCenter', () => {
  it('正常下载：写进目标目录、返回路径与实际字节数', async () => {
    const result = await downloadFileFromCenter({
      ...base,
      name: '报告.pdf',
      targetDir: dir,
      maxBytes: 1024,
      fetchImpl: fetchOf('hello'),
    })
    expect(result.path).toBe(join(dir, '报告.pdf'))
    expect(result.size).toBe(5)
    expect(await fs.readFile(result.path, 'utf8')).toBe('hello')
    // 不留 .part 残骸
    expect(await fs.readdir(dir)).toEqual(['报告.pdf'])
  })

  it('重名不覆盖：第二个同名文件落成「报告 (1).pdf」', async () => {
    await downloadFileFromCenter({
      ...base,
      name: '报告.pdf',
      targetDir: dir,
      maxBytes: 1024,
      fetchImpl: fetchOf('first'),
    })
    const second = await downloadFileFromCenter({
      ...base,
      name: '报告.pdf',
      targetDir: dir,
      maxBytes: 1024,
      fetchImpl: fetchOf('second'),
    })
    expect(second.path).toBe(join(dir, '报告 (1).pdf'))
    expect(await fs.readFile(join(dir, '报告.pdf'), 'utf8')).toBe('first')
    expect(await fs.readFile(second.path, 'utf8')).toBe('second')
  })

  it('只取 basename：服务器给的名字带路径也写不出目录', async () => {
    const result = await downloadFileFromCenter({
      ...base,
      name: '../../evil.txt',
      targetDir: dir,
      maxBytes: 1024,
      fetchImpl: fetchOf('x'),
    })
    expect(result.path).toBe(join(dir, 'evil.txt'))
  })

  it('超过上限：抛 E_TOO_LARGE 且不留半截文件', async () => {
    await expect(
      downloadFileFromCenter({
        ...base,
        name: 'big.bin',
        targetDir: dir,
        maxBytes: 8,
        fetchImpl: fetchOf('too long content'),
      }),
    ).rejects.toMatchObject({ code: 'E_TOO_LARGE' })
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('HTTP 非 2xx：错误信息里带状态码与响应体片段（便于网页端展示）', async () => {
    const fetchImpl = (async () =>
      new Response('E_FORBIDDEN', { status: 403 })) as unknown as typeof fetch
    await expect(
      downloadFileFromCenter({ ...base, name: 'a.txt', targetDir: dir, maxBytes: 1024, fetchImpl }),
    ).rejects.toMatchObject({ code: 'E_HTTP' })
    await expect(
      downloadFileFromCenter({ ...base, name: 'a.txt', targetDir: dir, maxBytes: 1024, fetchImpl }),
    ).rejects.toThrow(/403/)
  })

  it('未配置（缺 token / clientId）：抛 E_NOT_CONFIGURED，且不发请求', async () => {
    const spy = vi.fn()
    await expect(
      downloadFileFromCenter({
        ...base,
        token: '',
        name: 'a.txt',
        targetDir: dir,
        maxBytes: 1024,
        fetchImpl: spy as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(CenterDeliverError)
    expect(spy).not.toHaveBeenCalled()
  })
})
