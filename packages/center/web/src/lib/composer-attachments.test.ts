import { describe, expect, it } from 'vitest'
import {
  COMPOSER_IMAGE_MIME_TYPES,
  imageRejectReason,
  isImageFile,
  maxAttachmentSizeLabel,
  readyFileIds,
  type ComposerAttachment,
} from './composer-attachments.js'

/** 造一张"粘贴进来的图片"：只看这几个字段，不需要真的 File */
function image(patch: Partial<{ type: string; name: string; size: number }> = {}) {
  return { type: 'image/png', name: '粘贴的图片.png', size: 1024, ...patch }
}

describe('输入卡图片附件的纯判定', () => {
  it('白名单覆盖 png / jpeg / webp / gif / bmp，其它 MIME 一律不算图片', () => {
    for (const type of COMPOSER_IMAGE_MIME_TYPES) {
      expect(isImageFile(image({ type })), type).toBe(true)
    }
    expect(isImageFile(image({ type: 'image/svg+xml', name: 'a.svg' }))).toBe(false)
    expect(isImageFile(image({ type: 'application/pdf', name: 'a.pdf' }))).toBe(false)
    expect(isImageFile(image({ type: 'text/plain', name: 'a.txt' }))).toBe(false)
  })

  it('MIME 缺失时按扩展名兜底（剪贴板 File.type 可能是空串）', () => {
    expect(isImageFile(image({ type: '', name: 'shot.PNG' }))).toBe(true)
    expect(isImageFile(image({ type: '', name: 'photo.jpeg' }))).toBe(true)
    expect(isImageFile(image({ type: '', name: 'icon.bmp' }))).toBe(true)
    expect(isImageFile(image({ type: '', name: 'notes.txt' }))).toBe(false)
    // 有非空 MIME 时不看扩展名（防止 .png 的 PDF 混进来）
    expect(isImageFile(image({ type: 'application/pdf', name: 'fake.png' }))).toBe(false)
  })

  it('数量到上限先报"最多带 N 张"，不被格式 / 大小理由盖掉', () => {
    expect(imageRejectReason(image(), 5)).toBe('一条消息最多带 5 张图片')
    expect(imageRejectReason(image({ size: 100 * 1024 * 1024 }), 5)).toBe('一条消息最多带 5 张图片')
    expect(imageRejectReason(image(), 4)).toBe('')
  })

  it('非图片 / 空文件 / 超 8 MiB 各自给可执行的提示', () => {
    expect(imageRejectReason(image({ type: 'text/plain', name: 'a.txt' }), 0)).toBe(
      '只支持图片（PNG / JPEG / WebP / GIF / BMP）',
    )
    expect(imageRejectReason(image({ size: 0 }), 0)).toBe('这张图片是空的，换一张再试')
    expect(imageRejectReason(image({ size: 8 * 1024 * 1024 + 1 }), 0)).toBe('单张图片不能超过 8 MB')
    expect(imageRejectReason(image({ size: 8 * 1024 * 1024 }), 0)).toBe('')
    expect(maxAttachmentSizeLabel()).toBe('8 MB')
  })

  it('只把"已上传完成且有 fileId"的附件交给发送命令', () => {
    const items: ComposerAttachment[] = [
      { id: 'a', fileId: 'f-1', name: 'a.png', size: 1, previewUrl: 'blob:a', status: 'ready' },
      { id: 'b', fileId: '', name: 'b.png', size: 1, previewUrl: 'blob:b', status: 'uploading' },
      { id: 'c', fileId: '', name: 'c.png', size: 1, previewUrl: 'data:c', status: 'ready' },
      { id: 'd', fileId: 'f-2', name: 'd.png', size: 1, previewUrl: 'blob:d', status: 'ready' },
    ]
    expect(readyFileIds(items)).toEqual(['f-1', 'f-2'])
  })
})
