/**
 * 附件分流与图片读盘（docs/06 §3.1、docs/07 §2.3，v22）的单测。
 *
 * 这一层的判据都围绕「失败也必须如实」：读不出 / 超限 / 空文件都要给出**可读的原因**，
 * 而不是静默少一张图 —— 少一张图而模型不知道，就是一次胡编。
 */
import { describe, expect, it } from 'vitest'
import {
  IMAGE_MAX_BYTES,
  PREVIEW_MAX_BYTES,
  buildAttachmentPreview,
  extensionOf,
  fileNameOf,
  imageFallbackBlock,
  imageMimeOf,
  isImagePath,
  readImages,
  splitAttachments,
  type ImageReadPort,
} from './attachments.js'

/** 可控的读盘端口：按路径给字节，未登记 = ENOENT */
function port(files: Record<string, Buffer | number>): ImageReadPort {
  return {
    sizeOf: async (path) => {
      const value = files[path]
      if (value === undefined) return undefined
      return typeof value === 'number' ? value : value.byteLength
    },
    readFile: async (path) => {
      const value = files[path]
      if (value === undefined || typeof value === 'number') throw new Error('ENOENT')
      return value
    },
  }
}

describe('扩展名与文件名', () => {
  it('取小写扩展名（Windows 反斜杠与正斜杠都认）', () => {
    expect(extensionOf('C:\\pics\\A.PNG')).toBe('png')
    expect(extensionOf('/home/u/b.jpeg')).toBe('jpeg')
    expect(extensionOf('C:\\dir.with.dot\\noext')).toBe('')
    expect(extensionOf('.gitignore')).toBe('')
  })

  it('文件名取最后一段', () => {
    expect(fileNameOf('C:\\a\\b\\c.png')).toBe('c.png')
    expect(fileNameOf('a/b/c.png')).toBe('c.png')
  })

  it('图片判定只认模型能看的格式（tif / svg 不算）', () => {
    expect(isImagePath('a.png')).toBe(true)
    expect(isImagePath('a.JPEG')).toBe(true)
    expect(isImagePath('a.webp')).toBe(true)
    // 分类管线把 tif / svg 当图片，但模型侧普遍不认这两种 → 走文本提取路径
    expect(isImagePath('a.tif')).toBe(false)
    expect(isImagePath('a.svg')).toBe(false)
    expect(isImagePath('a.pdf')).toBe(false)
  })

  it('MIME 未知时退回 application/octet-stream（不编一个 image/*）', () => {
    expect(imageMimeOf('a.jpg')).toBe('image/jpeg')
    expect(imageMimeOf('a.bin')).toBe('application/octet-stream')
  })
})

describe('splitAttachments', () => {
  it('按扩展名分流且保持原顺序', () => {
    const { images, documents } = splitAttachments(['a.png', 'b.txt', 'c.jpg', 'd.docx', 'e.pdf'])
    expect(images).toEqual(['a.png', 'c.jpg'])
    expect(documents).toEqual(['b.txt', 'd.docx', 'e.pdf'])
  })
})

describe('readImages', () => {
  it('读成功时给出 base64 与 MIME（不带 data: 前缀）', async () => {
    const loaded = await readImages(['a.png'], port({ 'a.png': Buffer.from([1, 2, 3]) }))
    expect(loaded).toEqual([
      {
        path: 'a.png',
        image: {
          mimeType: 'image/png',
          dataBase64: Buffer.from([1, 2, 3]).toString('base64'),
          name: 'a.png',
        },
      },
    ])
  })

  it('超过 8 MiB 的图按未读取处理并写明原因（不静默截断）', async () => {
    const loaded = await readImages(
      ['big.png'],
      port({ 'big.png': Buffer.alloc(IMAGE_MAX_BYTES + 1) }),
    )
    expect(loaded[0]?.image).toBeUndefined()
    expect(loaded[0]?.note).toContain('上限')
  })

  it('stat 拿不到大小时仍按内容长度兜底判定', async () => {
    const loaded = await readImages(['big.png'], {
      sizeOf: async () => undefined,
      readFile: async () => Buffer.alloc(IMAGE_MAX_BYTES + 1),
    })
    expect(loaded[0]?.note).toContain('上限')
  })

  it('空文件与读失败都如实给原因', async () => {
    const empty = await readImages(['a.png'], port({ 'a.png': Buffer.alloc(0) }))
    expect(empty[0]?.note).toBe('图片为空文件')
    const missing = await readImages(['none.png'], port({}))
    expect(missing[0]?.note).toContain('读取失败')
  })

  it('返回与入参一一对应（含失败项）—— 否则「哪张没读出来」会在链路上丢失', async () => {
    const loaded = await readImages(['ok.png', 'bad.png'], port({ 'ok.png': Buffer.from([9]) }))
    expect(loaded).toHaveLength(2)
    expect(loaded[0]?.image).toBeDefined()
    expect(loaded[1]?.image).toBeUndefined()
  })
})

describe('imageFallbackBlock', () => {
  it('措辞是给模型看的事实（它会据此知道没看到图）', () => {
    expect(imageFallbackBlock('a.png', '当前模型未开启图片输入')).toBe(
      '【附件】a.png：内容未读取（当前模型未开启图片输入）',
    )
  })
})

describe('buildAttachmentPreview', () => {
  it('图片回 data URL', async () => {
    const preview = await buildAttachmentPreview(
      'C:\\pics\\a.png',
      port({ 'C:\\pics\\a.png': Buffer.from([1]) }),
    )
    expect(preview).toEqual({
      path: 'C:\\pics\\a.png',
      name: 'a.png',
      image: true,
      dataUrl: `data:image/png;base64,${Buffer.from([1]).toString('base64')}`,
    })
  })

  it('非图片只回文件名（连读盘都不尝试）', async () => {
    const preview = await buildAttachmentPreview('a.pdf', port({}))
    expect(preview).toEqual({ path: 'a.pdf', name: 'a.pdf', image: false })
  })

  it('超过 2 MiB 不生成缩略图（预览上限比下发上限更紧）', async () => {
    expect(PREVIEW_MAX_BYTES).toBeLessThan(IMAGE_MAX_BYTES)
    const preview = await buildAttachmentPreview(
      'big.png',
      port({ 'big.png': Buffer.alloc(PREVIEW_MAX_BYTES + 1) }),
    )
    expect(preview.dataUrl).toBeUndefined()
    expect(preview.note).toContain('未生成缩略图')
  })

  it('读失败时只有 note（渲染层据此退回纯文字 chip，不显示裂图）', async () => {
    const preview = await buildAttachmentPreview('gone.png', port({}))
    expect(preview.image).toBe(true)
    expect(preview.dataUrl).toBeUndefined()
    expect(preview.note).toContain('读取失败')
  })
})
