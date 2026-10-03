import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMemoryLogger } from '@aurora/shared'
import {
  MAX_DISPLAY_IMAGE_BYTES,
  createImageDisplayPort,
  readDisplayImageDataUrl,
} from './image-display-port.js'

let root = ''
let owned = ''
let outside = ''

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'aurora-display-root-'))
  owned = await fs.mkdtemp(join(tmpdir(), 'aurora-display-owned-'))
  outside = await fs.mkdtemp(join(tmpdir(), 'aurora-display-out-'))
  await fs.writeFile(join(root, 'result.png'), Buffer.from([137, 80, 78, 71]))
  await fs.writeFile(join(owned, 'generated.webp'), Buffer.from([1, 2, 3]))
  await fs.writeFile(join(outside, 'secret.png'), Buffer.from([1]))
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(owned, { recursive: true, force: true })
  await fs.rm(outside, { recursive: true, force: true })
})

function setup() {
  return createImageDisplayPort({
    workspaceDirOf: () => root,
    boundaryRootOf: () => root,
    ownedDirs: [owned],
    logger: createMemoryLogger(),
  })
}

describe('image-display-port', () => {
  it('接受会话边界内与 Aurora 自有目录里的图片，并生成无路径投影所需元数据', async () => {
    const port = setup()
    const inRoot = await port.prepareImage({ path: 'result.png', sessionId: 's1' })
    const inOwned = await port.prepareImage({
      path: join(owned, 'generated.webp'),
      sessionId: 's1',
    })
    expect(inRoot).toMatchObject({ name: 'result.png', mime: 'image/png' })
    expect(inOwned).toMatchObject({ name: 'generated.webp', mime: 'image/webp' })
    expect(inRoot.path).toBe(join(root, 'result.png'))
  })

  it('拒绝越界路径、非图片与超限文件', async () => {
    const port = setup()
    await expect(
      port.prepareImage({ path: join(outside, 'secret.png'), sessionId: 's1' }),
    ).rejects.toThrow(/工作目录之外/)
    await fs.writeFile(join(root, 'note.txt'), 'x')
    await expect(port.prepareImage({ path: 'note.txt', sessionId: 's1' })).rejects.toThrow(
      /不支持的图片格式/,
    )
    await fs.writeFile(join(root, 'large.png'), Buffer.alloc(MAX_DISPLAY_IMAGE_BYTES + 1))
    await expect(port.prepareImage({ path: 'large.png', sessionId: 's1' })).rejects.toThrow(
      /超过展示上限/,
    )
  })

  it('readImage 读取已登记路径并返回 data URL；格式校验仍在', async () => {
    const port = setup()
    const result = await port.readImage({
      path: join(root, 'result.png'),
      sessionId: 's1',
    })
    expect(result.mime).toBe('image/png')
    expect(result.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    await expect(port.readImage({ path: join(root, 'note.txt'), sessionId: 's1' })).rejects.toThrow(
      /不支持的图片格式/,
    )
  })

  it('底层读图函数同样执行格式与大小校验', async () => {
    await expect(readDisplayImageDataUrl(join(root, 'note.txt'))).rejects.toThrow(
      /不支持的图片格式/,
    )
  })
})
