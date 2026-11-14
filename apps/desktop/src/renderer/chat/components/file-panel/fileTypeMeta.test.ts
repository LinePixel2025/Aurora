/** 文件类型映射与大小 / 时间格式化（右栏文件面板，docs/07 §2.3）。 */
import { describe, expect, it } from 'vitest'
import { extensionOf, fileTypeMetaOf, formatFileBytes, formatFileTime } from './fileTypeMeta.js'

describe('extensionOf', () => {
  it('取最后一段的小写扩展名', () => {
    expect(extensionOf('C:\\项目\\报告.DOCX')).toBe('docx')
    expect(extensionOf('/tmp/a.b.tar.gz')).toBe('gz')
  })

  it('无扩展名回空串；点开头按整名查表', () => {
    expect(extensionOf('Makefile')).toBe('')
    expect(extensionOf('.gitignore')).toBe('gitignore')
  })
})

describe('fileTypeMetaOf', () => {
  it('目录一律 folder 色相', () => {
    const meta = fileTypeMetaOf('src', 'dir')
    expect(meta.tone).toBe('folder')
    expect(meta.label).toBe('文件夹')
  })

  it('Office 三件套各自色相与中文类型名', () => {
    expect(fileTypeMetaOf('报告.docx')).toMatchObject({ tone: 'word', label: 'Word 文档' })
    expect(fileTypeMetaOf('账本.xlsx')).toMatchObject({ tone: 'excel', label: 'Excel 工作簿' })
    expect(fileTypeMetaOf('讲义.pptx')).toMatchObject({
      tone: 'ppt',
      label: 'PowerPoint 演示文稿',
    })
    expect(fileTypeMetaOf('论文.pdf').tone).toBe('pdf')
  })

  it('旧式二进制格式与对应新格式同色相，但类型名标出「旧格式」', () => {
    expect(fileTypeMetaOf('老文档.doc')).toMatchObject({
      tone: 'word',
      label: 'Word 文档（旧格式）',
    })
  })

  it('音视频同色相、不同图标', () => {
    const video = fileTypeMetaOf('录屏.mp4')
    const audio = fileTypeMetaOf('配音.mp3')
    expect(video.tone).toBe('media')
    expect(audio.tone).toBe('media')
    expect(video.icon).not.toBe(audio.icon)
  })

  it('代码 / 文本 / 图片 / 压缩包分色', () => {
    expect(fileTypeMetaOf('main.ts').tone).toBe('code')
    expect(fileTypeMetaOf('说明.md').tone).toBe('text')
    expect(fileTypeMetaOf('截图.png').tone).toBe('image')
    expect(fileTypeMetaOf('备份.zip').tone).toBe('archive')
  })

  it('未知扩展名回落 unknown，类型名带上扩展名本身', () => {
    expect(fileTypeMetaOf('数据.bin')).toMatchObject({ tone: 'unknown', label: 'BIN 文件' })
    expect(fileTypeMetaOf('Makefile')).toMatchObject({ tone: 'unknown', label: '文件' })
  })

  it('大小写不敏感', () => {
    expect(fileTypeMetaOf('REPORT.DOCX').tone).toBe('word')
  })
})

describe('formatFileBytes', () => {
  it('按 1024 进位，小于 10 保留一位小数', () => {
    expect(formatFileBytes(0)).toBe('0 B')
    expect(formatFileBytes(512)).toBe('512 B')
    expect(formatFileBytes(1024)).toBe('1 KB')
    expect(formatFileBytes(1536)).toBe('1.5 KB')
    expect(formatFileBytes(20 * 1024)).toBe('20 KB')
    expect(formatFileBytes(3 * 1024 * 1024)).toBe('3 MB')
  })

  it('目录的 0 字节与非法值都回 0 B（列表里目录不显示大小）', () => {
    expect(formatFileBytes(-1)).toBe('0 B')
    expect(formatFileBytes(Number.NaN)).toBe('0 B')
  })
})

describe('formatFileTime', () => {
  it('缺省 / 非法时间戳回空串，由调用方决定要不要占位', () => {
    expect(formatFileTime(undefined)).toBe('')
    expect(formatFileTime(0)).toBe('')
  })

  it('本地时区的 YYYY-MM-DD HH:mm', () => {
    const stamp = new Date(2026, 10, 12, 9, 5).getTime()
    expect(formatFileTime(stamp)).toBe('2026-11-12 09:05')
  })
})
