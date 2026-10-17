/**
 * 粘贴图片落盘（`chat:stageImage` 的对端，docs/07 §2.3，2026-10-18）。
 *
 * 判据都落在「错了会让用户拿到坏附件或磁盘无限增长」的那一类：
 * mime 白名单、空内容、8 MB 上限、命名可排序、只保留最近 50 张。
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PASTED_IMAGE_MAX_BYTES } from '@aurora/shared'
import {
  PASTED_IMAGE_EXTENSIONS,
  PASTED_IMAGE_KEEP,
  PastedImageError,
  pastedImageExtensionOf,
  writePastedImage,
} from './pasted-image.js'

let dir = ''

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'aurora-pasted-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('writePastedImage · 校验', () => {
  it('写进目标目录：文件名 pasted-<13 位时间戳>-<随机段>.<ext>，字节原样落盘', async () => {
    const result = await writePastedImage({
      dir,
      mimeType: 'image/png',
      data: png,
      now: 1_770_000_000_000,
      random: 'abc123',
    })
    expect(result.name).toBe('pasted-1770000000000-abc123.png')
    expect(result.path).toBe(join(dir, result.name))
    expect(result.mimeType).toBe('image/png')
    expect([...(await fs.readFile(result.path))]).toEqual([...png])
  })

  it('mime 大小写不敏感；五种白名单各自映射成正确扩展名', async () => {
    expect(pastedImageExtensionOf('IMAGE/PNG')).toBe('png')
    expect(PASTED_IMAGE_EXTENSIONS).toEqual({
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/bmp': 'bmp',
    })
    for (const mime of Object.keys(PASTED_IMAGE_EXTENSIONS)) {
      const result = await writePastedImage({
        dir,
        mimeType: mime.toUpperCase(),
        data: png,
        now: Date.now(),
        random: 'r',
      })
      expect(result.name.endsWith(`.${PASTED_IMAGE_EXTENSIONS[mime]}`)).toBe(true)
      expect(result.mimeType).toBe(mime)
    }
  })

  it('不支持的 mime 拒绝（E_INVALID_ARGUMENT），不写盘', async () => {
    for (const mimeType of ['image/svg+xml', 'text/plain', '']) {
      await expect(
        writePastedImage({ dir, mimeType, data: png, now: 1, random: 'x' }),
      ).rejects.toMatchObject({ code: 'E_INVALID_ARGUMENT' })
    }
    await expect(fs.readdir(dir)).resolves.toEqual([])
  })

  it('空内容拒绝（E_INVALID_ARGUMENT）', async () => {
    await expect(
      writePastedImage({ dir, mimeType: 'image/png', data: new Uint8Array(0) }),
    ).rejects.toMatchObject({ code: 'E_INVALID_ARGUMENT' })
    await expect(fs.readdir(dir)).resolves.toEqual([])
  })

  it('超过 8 MiB 上限拒绝（E_INVALID_ARGUMENT）', async () => {
    await expect(
      writePastedImage({
        dir,
        mimeType: 'image/png',
        data: new Uint8Array(PASTED_IMAGE_MAX_BYTES + 1),
      }),
    ).rejects.toBeInstanceOf(PastedImageError)
    await expect(fs.readdir(dir)).resolves.toEqual([])
  })

  it('目录不可创建时映射成 E_IO', async () => {
    const blocked = join(dir, 'blocked')
    await fs.writeFile(blocked, 'not a directory')
    await expect(
      writePastedImage({ dir: blocked, mimeType: 'image/png', data: png }),
    ).rejects.toMatchObject({ code: 'E_IO' })
  })
})

describe('writePastedImage · 清理', () => {
  it('只保留最近 50 张：按文件名（时间戳打头）删最旧的', async () => {
    for (let i = 0; i < PASTED_IMAGE_KEEP + 3; i += 1) {
      await writePastedImage({
        dir,
        mimeType: 'image/png',
        data: png,
        now: 1_770_000_000_000 + i,
        random: String(i).padStart(3, '0'),
      })
    }
    const names = (await fs.readdir(dir)).sort()
    expect(names).toHaveLength(PASTED_IMAGE_KEEP)
    // 000 / 001 / 002 这三张最旧被清掉，最新一张（052）还在
    expect(names[0]).toBe('pasted-1770000000003-003.png')
    expect(names[names.length - 1]).toBe(`pasted-${1_770_000_000_052}-052.png`)
  })

  it('不清理目标目录里的其它文件（只认 pasted- 前缀）', async () => {
    await fs.writeFile(join(dir, 'keep-me.png'), 'x')
    await fs.writeFile(join(dir, 'pasted-not-a-timestamp.txt'), 'x')
    await writePastedImage({ dir, mimeType: 'image/png', data: png, keep: 1 })
    expect((await fs.readdir(dir)).sort()).toEqual([
      'keep-me.png',
      expect.stringMatching(/^pasted-\d{13}-[0-9a-f]+\.png$/),
      'pasted-not-a-timestamp.txt',
    ])
  })

  it('keep=0 表示不清理', async () => {
    for (let i = 0; i < 3; i += 1) {
      await writePastedImage({
        dir,
        mimeType: 'image/png',
        data: png,
        now: 1_770_000_000_000 + i,
        random: String(i),
        keep: 0,
      })
    }
    await expect(fs.readdir(dir)).resolves.toHaveLength(3)
  })
})
