/**
 * 自定义提示音文件读取的单测（`main/notification-sound.ts`，docs/07 §2.2.3 R4）。
 *
 * 用真实临时文件证「扩展名白名单 + 2MB 上限 + 存在性」三道闸，
 * 以及 base64 / MIME 回传形状（渲染层拿它建 blob URL 播放）。
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_SOUND_BYTES,
  SOUND_FILE_EXTENSIONS,
  readNotificationSound,
} from './notification-sound.js'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'aurora-sound-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** 写一个假音频文件（本模块不解码，字节内容任意）。 */
async function writeSound(
  name: string,
  bytes: Buffer = Buffer.from('RIFF-fake-wav'),
): Promise<string> {
  const path = join(dir, name)
  await fs.writeFile(path, bytes)
  return path
}

describe('readNotificationSound', () => {
  it('空串 / 纯空白 → null（未配置，走默认合成音）', async () => {
    expect(await readNotificationSound('')).toBeNull()
    expect(await readNotificationSound('   ')).toBeNull()
  })

  it('合法 wav → base64 与 mime 原样回传', async () => {
    const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x01, 0x02, 0xff])
    const path = await writeSound('ring.wav', bytes)
    const result = await readNotificationSound(path)
    expect(result).toEqual({ dataBase64: bytes.toString('base64'), mime: 'audio/wav' })
  })

  it('白名单内各扩展名 → 对应播放 MIME（大小写不敏感）', async () => {
    const expected: Record<string, string> = {
      wav: 'audio/wav',
      mp3: 'audio/mpeg',
      ogg: 'audio/ogg',
      m4a: 'audio/mp4',
      aac: 'audio/aac',
      flac: 'audio/flac',
      webm: 'audio/webm',
    }
    expect([...SOUND_FILE_EXTENSIONS].sort()).toEqual(Object.keys(expected).sort())
    for (const [ext, mime] of Object.entries(expected)) {
      const path = await writeSound(`ring.${ext}`)
      expect((await readNotificationSound(path))?.mime).toBe(mime)
    }
    const upper = await writeSound('RING.WAV')
    expect((await readNotificationSound(upper))?.mime).toBe('audio/wav')
  })

  it('不支持的扩展名 / 无扩展名 → 拒绝（连磁盘都不碰）', async () => {
    const path = await writeSound('ring.txt')
    await expect(readNotificationSound(path)).rejects.toThrow(/不支持的音频格式/)
    await expect(readNotificationSound(join(dir, 'noext'))).rejects.toThrow(/不支持的音频格式/)
  })

  it('文件不存在 → 中文文案（设置页据此提示重新选择）', async () => {
    await expect(readNotificationSound(join(dir, 'ghost.wav'))).rejects.toThrow(/不存在或已被移动/)
  })

  it('路径是目录 → 拒绝', async () => {
    const sub = join(dir, 'folder.wav')
    await fs.mkdir(sub)
    await expect(readNotificationSound(sub)).rejects.toThrow(/不是一个文件/)
  })

  it('超过 2MB → 拒绝；恰好 2MB → 放行（边界）', async () => {
    const tooBig = await writeSound('big.mp3', Buffer.alloc(MAX_SOUND_BYTES + 1))
    await expect(readNotificationSound(tooBig)).rejects.toThrow(/超过 2MB/)
    const exact = await writeSound('exact.mp3', Buffer.alloc(MAX_SOUND_BYTES))
    expect((await readNotificationSound(exact))?.mime).toBe('audio/mpeg')
  })
})
