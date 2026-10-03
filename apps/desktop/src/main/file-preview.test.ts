/**
 * 右栏「文件」预览的读盘实现（2026-10-03，docs/07 §2.3）：
 * 用**真实临时目录**测（读盘 + 边界 realpath 校验没有值得替换的抽象层）。
 */
import { promises as nodeFs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildFilePreview, PREVIEW_TEXT_MAX_BYTES } from './file-preview.js'

let base = ''

beforeAll(async () => {
  base = await nodeFs.mkdtemp(join(tmpdir(), 'aurora-preview-'))
  await nodeFs.writeFile(join(base, 'note.md'), '# 标题\n\n正文', 'utf8')
  await nodeFs.writeFile(join(base, 'plain.txt'), '一行文本', 'utf8')
  // 最小 PNG（1×1 像素）——够扩展名判定与 base64 链路
  await nodeFs.writeFile(
    join(base, 'pixel.png'),
    Buffer.from(
      '89504e470d0a1a0a0000000d494844520000000100000001080600000' +
        '01f15c4890000000a49444154789c6300010000050001' +
        '0d0a2db40000000049454e44ae426082',
      'hex',
    ),
  )
  await nodeFs.writeFile(join(base, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03]))
  await nodeFs.mkdir(join(base, 'dir'), { recursive: true })
})

afterAll(async () => {
  if (base !== '') await nodeFs.rm(base, { recursive: true, force: true })
})

function port(root?: string) {
  return { rootOf: () => root }
}

describe('buildFilePreview（右栏文件预览）', () => {
  it('markdown / 文本按扩展名分流；图片回 dataUrl；二进制报 unsupported', async () => {
    const md = await buildFilePreview(port(base), { sessionId: 's1', path: join(base, 'note.md') })
    expect(md.kind).toBe('markdown')
    expect(md.truncated).toBeUndefined()
    expect(md.content).toContain('# 标题')

    const txt = await buildFilePreview(port(base), {
      sessionId: 's1',
      path: join(base, 'plain.txt'),
    })
    expect(txt.kind).toBe('text')

    const img = await buildFilePreview(port(base), {
      sessionId: 's1',
      path: join(base, 'pixel.png'),
    })
    expect(img.kind).toBe('image')
    expect(img.dataUrl).toMatch(/^data:image\/png;base64,/)

    const bin = await buildFilePreview(port(base), {
      sessionId: 's1',
      path: join(base, 'blob.bin'),
    })
    expect(bin).toMatchObject({ kind: 'unsupported' })
  })

  it('边界根之外的路径拒绝；根不可用直接拒绝（不退回无边界）', async () => {
    const outside = await nodeFs.mkdtemp(join(tmpdir(), 'aurora-outside-'))
    try {
      const outsideFile = join(outside, 'secret.txt')
      await nodeFs.writeFile(outsideFile, '机密', 'utf8')
      await expect(
        buildFilePreview(port(base), { sessionId: 's1', path: outsideFile }),
      ).rejects.toThrow('边界之外')

      await expect(
        buildFilePreview(port(undefined), { sessionId: 's1', path: join(base, 'plain.txt') }),
      ).rejects.toThrow('工作目录')
    } finally {
      await nodeFs.rm(outside, { recursive: true, force: true })
    }
  })

  it('目录与不存在的路径都如实报错', async () => {
    await expect(
      buildFilePreview(port(base), { sessionId: 's1', path: join(base, 'dir') }),
    ).rejects.toThrow('不是普通文件')
    await expect(
      buildFilePreview(port(base), { sessionId: 's1', path: join(base, 'missing.txt') }),
    ).rejects.toThrow('不存在')
  })

  it('超限文本截断并标记 truncated（不整份拒绝）', async () => {
    const big = join(base, 'big.log')
    await nodeFs.writeFile(big, 'x'.repeat(PREVIEW_TEXT_MAX_BYTES + 1024), 'utf8')
    const result = await buildFilePreview(port(base), { sessionId: 's1', path: big })
    expect(result.truncated).toBe(true)
    expect(result.content?.length).toBeLessThanOrEqual(PREVIEW_TEXT_MAX_BYTES)
  })
})
