import { describe, expect, it } from 'vitest'
import {
  EVIDENCE_LIMIT_BYTES,
  decodeText,
  extract,
  listZipEntries,
  normalizeWhitespace,
  readImageSize,
  truncateEvidence,
} from './extract.js'

const readFileOf = (content: Buffer | string) => async (): Promise<Buffer> =>
  typeof content === 'string' ? Buffer.from(content, 'utf8') : content

describe('truncateEvidence', () => {
  it('未超限时原样返回', () => {
    expect(truncateEvidence('hello', 100)).toBe('hello')
  })

  it('超限时保留头尾，并标注省略量', () => {
    const text = 'A'.repeat(500) + 'M'.repeat(500) + 'Z'.repeat(500)
    const result = truncateEvidence(text, 300)
    expect(result).toContain('省略')
    expect(result.startsWith('A')).toBe(true)
    expect(result.endsWith('Z')).toBe(true)
    // 输出的字节数不应显著超过上限（含省略提示文字）
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThan(400)
  })

  it('按字节而非字符计数（中文占 3 字节）', () => {
    const text = '数'.repeat(200) // 600 字节
    const result = truncateEvidence(text, 90)
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThan(200)
  })

  it('不切出半个多字节字符（不产生替换符）', () => {
    const text = '数'.repeat(3000)
    const result = truncateEvidence(text, 1000)
    // 只有省略提示里的字符是合法的，正文不应出现 U+FFFD
    expect(result.replace(/…（此处省略约 \d+ 字节）…/g, '')).not.toContain('\uFFFD')
  })
})

describe('decodeText', () => {
  it('识别 UTF-8 BOM', () => {
    expect(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('数学')]))).toBe(
      '数学',
    )
  })

  it('识别 UTF-16LE BOM', () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('数学作业', 'utf16le')])
    expect(decodeText(bytes)).toBe('数学作业')
  })

  it('无 BOM 的合法 UTF-8 原样解码', () => {
    expect(decodeText(Buffer.from('一元二次方程', 'utf8'))).toBe('一元二次方程')
  })

  it('GBK 中文不产生替换符（回退解码）', () => {
    // 「数学」的 GBK 编码：CA FD D1 A7
    const gbk = Buffer.from([0xca, 0xfd, 0xd1, 0xa7])
    const decoded = decodeText(gbk)
    expect(decoded).not.toContain('\uFFFD')
  })
})

describe('normalizeWhitespace', () => {
  it('统一换行并压缩连续空行', () => {
    expect(normalizeWhitespace('a\r\n\r\n\r\n\r\nb')).toBe('a\n\nb')
  })

  it('压缩行内多余空格但保留段落', () => {
    expect(normalizeWhitespace('a   b\n\nc')).toBe('a b\n\nc')
  })
})

describe('readImageSize', () => {
  it('解析 PNG 尺寸', () => {
    const png = Buffer.alloc(24)
    png.writeUInt32BE(0x89504e47, 0)
    png.writeUInt32BE(1920, 16)
    png.writeUInt32BE(1080, 20)
    expect(readImageSize(png, 'png')).toEqual({ width: 1920, height: 1080 })
  })

  it('解析 BMP 尺寸', () => {
    const bmp = Buffer.alloc(30)
    bmp.write('BM', 0, 'latin1')
    bmp.writeInt32LE(800, 18)
    bmp.writeInt32LE(-600, 22) // 高度为负表示自上而下
    expect(readImageSize(bmp, 'bmp')).toEqual({ width: 800, height: 600 })
  })

  it('损坏数据返回 undefined 而不抛错', () => {
    expect(readImageSize(Buffer.from('not-an-image'), 'png')).toBeUndefined()
  })
})

describe('listZipEntries', () => {
  /** 构造最小 STORE 模式 zip（测试用，不引依赖） */
  function makeZip(names: string[]): Buffer {
    const locals: Buffer[] = []
    const centrals: Buffer[] = []
    let offset = 0
    for (const name of names) {
      const nameBuffer = Buffer.from(name, 'utf8')
      const header = Buffer.alloc(30)
      header.writeUInt32LE(0x04034b50, 0)
      locals.push(header, nameBuffer)
      const central = Buffer.alloc(46)
      central.writeUInt32LE(0x02014b50, 0)
      central.writeUInt16LE(nameBuffer.length, 28)
      central.writeUInt32LE(offset, 42)
      centrals.push(central, nameBuffer)
      offset += 30 + nameBuffer.length
    }
    const centralDirectory = Buffer.concat(centrals)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(names.length, 8)
    eocd.writeUInt16LE(names.length, 10)
    eocd.writeUInt32LE(centralDirectory.length, 12)
    eocd.writeUInt32LE(offset, 16)
    return Buffer.concat([...locals, centralDirectory, eocd])
  }

  it('列出文件条目并跳过目录条目', () => {
    const zip = makeZip(['数学/试卷.pdf', '数学/', '答案.docx'])
    expect(listZipEntries(zip)).toEqual(['数学/试卷.pdf', '答案.docx'])
  })

  it('不是 zip 时返回空数组而不抛错', () => {
    expect(listZipEntries(Buffer.from('plain text'))).toEqual([])
  })
})

describe('extract', () => {
  it('纯文本：给出文件名与正文', async () => {
    const result = await extract({
      path: 'D:\\感知\\数学作业.txt',
      ext: 'txt',
      sizeBytes: 12,
      readFile: readFileOf('一元二次方程练习题'),
    })
    expect(result.kind).toBe('text')
    expect(result.evidence).toContain('数学作业.txt')
    expect(result.evidence).toContain('一元二次方程练习题')
    expect(result.warnings).toEqual([])
  })

  it('Office 文档：走注入的解析器且正文进入证据', async () => {
    const result = await extract({
      path: 'D:\\感知\\物理.pptx',
      ext: 'pptx',
      sizeBytes: 100,
      readFile: readFileOf(''),
      parseOffice: async () => ({ toText: () => '欧姆定律 电路图' }),
    })
    expect(result.kind).toBe('document')
    expect(result.evidence).toContain('欧姆定律')
  })

  it('解析器抛错 → 降级为文件名证据且记入告警（绝不抛错）', async () => {
    const result = await extract({
      path: 'D:\\感知\\数学.pdf',
      ext: 'pdf',
      sizeBytes: 100,
      readFile: readFileOf(''),
      parseOffice: async () => {
        throw new Error('解析器崩了')
      },
    })
    expect(result.kind).toBe('document')
    expect(result.evidence).toContain('数学.pdf')
    expect(result.warnings.join()).toContain('解析器崩了')
  })

  it('解析器返回空正文 → 降级并告警', async () => {
    const result = await extract({
      path: 'D:\\感知\\空白.docx',
      ext: 'docx',
      sizeBytes: 10,
      readFile: readFileOf(''),
      parseOffice: async () => ({ toText: () => '   ' }),
    })
    expect(result.evidence).toContain('空白.docx')
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('没有可用解析器时不抛错', async () => {
    const result = await extract({
      path: 'D:\\感知\\x.pdf',
      ext: 'pdf',
      sizeBytes: 10,
      readFile: readFileOf(''),
    })
    expect(result.evidence).toContain('x.pdf')
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('老式二进制 Office：只给文件名 + 类型说明', async () => {
    const result = await extract({
      path: 'D:\\感知\\旧课件.ppt',
      ext: 'ppt',
      sizeBytes: 10,
      readFile: readFileOf(''),
    })
    expect(result.kind).toBe('binary')
    expect(result.evidence).toContain('旧课件.ppt')
    expect(result.warnings.join()).toContain('老式二进制')
  })

  it('图片：给出文件名、大小与尺寸，并说明未启用 OCR', async () => {
    const png = Buffer.alloc(24)
    png.writeUInt32BE(0x89504e47, 0)
    png.writeUInt32BE(640, 16)
    png.writeUInt32BE(480, 20)
    const result = await extract({
      path: 'D:\\感知\\note.png',
      ext: 'png',
      sizeBytes: png.length,
      readFile: readFileOf(png),
    })
    expect(result.kind).toBe('image')
    expect(result.evidence).toContain('640×480')
    expect(result.evidence).toContain('OCR')
  })

  it('压缩包：列出条目清单', async () => {
    const zip = Buffer.concat([
      (() => {
        const header = Buffer.alloc(30)
        header.writeUInt32LE(0x04034b50, 0)
        return header
      })(),
      Buffer.from('a.txt', 'utf8'),
      (() => {
        const central = Buffer.alloc(46)
        central.writeUInt32LE(0x02014b50, 0)
        central.writeUInt16LE(5, 28)
        central.writeUInt32LE(0, 42)
        return central
      })(),
      Buffer.from('a.txt', 'utf8'),
      (() => {
        const eocd = Buffer.alloc(22)
        eocd.writeUInt32LE(0x06054b50, 0)
        eocd.writeUInt16LE(1, 8)
        eocd.writeUInt16LE(1, 10)
        eocd.writeUInt32LE(51, 12)
        eocd.writeUInt32LE(35, 16)
        return eocd
      })(),
    ])
    const result = await extract({
      path: 'D:\\感知\\资料.zip',
      ext: 'zip',
      sizeBytes: zip.length,
      readFile: readFileOf(zip),
    })
    expect(result.kind).toBe('archive')
    expect(result.evidence).toContain('a.txt')
  })

  it('读文件失败也不抛错', async () => {
    const result = await extract({
      path: 'D:\\感知\\locked.txt',
      ext: 'txt',
      sizeBytes: 10,
      readFile: async () => {
        throw new Error('EACCES')
      },
    })
    expect(result.evidence).toContain('locked.txt')
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('超大文本的证据被限制在上限附近', async () => {
    const result = await extract({
      path: 'D:\\感知\\big.txt',
      ext: 'txt',
      sizeBytes: 100_000,
      readFile: readFileOf('字'.repeat(50_000)),
    })
    expect(result.evidenceChars).toBeGreaterThan(EVIDENCE_LIMIT_BYTES)
    expect(Buffer.byteLength(result.evidence, 'utf8')).toBeLessThan(EVIDENCE_LIMIT_BYTES * 1.5)
  })

  it('未知扩展名：只给文件名与元数据', async () => {
    const result = await extract({
      path: 'D:\\感知\\mystery.bin',
      ext: 'bin',
      sizeBytes: 42,
      readFile: readFileOf(''),
    })
    expect(result.kind).toBe('unknown')
    expect(result.evidence).toContain('mystery.bin')
    expect(result.evidence).toContain('42')
  })
})
