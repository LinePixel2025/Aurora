/**
 * 右栏「文件」预览的读盘实现（2026-10-03，docs/07 §2.3）：
 * 用**真实临时目录**测（读盘 + 边界 realpath 校验没有值得替换的抽象层）。
 */
import { promises as nodeFs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildFilePreview,
  PREVIEW_DOCUMENT_MAX_BYTES,
  PREVIEW_TEXT_MAX_BYTES,
} from './file-preview.js'

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
  // Office 夹具故意带 NUL（真实 docx/xlsx/pptx 是 ZIP）：证明分流排在二进制探测之前
  const zipish = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00])
  for (const name of ['书.docx', '表.xlsx', '幻灯片.pptx', '论文.pdf', '网页.html', '旧.doc']) {
    await nodeFs.writeFile(join(base, name), zipish)
  }
  // 稀疏文件：只为了越过 32 MiB 上限，不必真写 33 MB
  const huge = join(base, '巨.docx')
  await nodeFs.writeFile(huge, '')
  await nodeFs.truncate(huge, PREVIEW_DOCUMENT_MAX_BYTES + 1)
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

  // 2026-11-14 用户实测：点 .mov / .mp3 主界面卡死 —— 旧实现 > 2 MB 先走「截断当文本」，
  // 于是大二进制被判成 text（2 MB 垃圾进渲染层 <pre>），且整份 readFile 把主进程拖死。
  it('超过 2 MB 的二进制仍是 unsupported（不许先当文本截断）', async () => {
    const movie = join(base, 'movie.mov')
    // 稀疏文件：只需要"头部含 NUL + 体积大"，不必真写几百 MB
    await nodeFs.writeFile(movie, '')
    await nodeFs.truncate(movie, PREVIEW_TEXT_MAX_BYTES * 2)
    const result = await buildFilePreview(port(base), { sessionId: 's1', path: movie })
    expect(result.kind).toBe('unsupported')
    expect(result.note).toContain('二进制')
    expect(result.bytes).toBe(PREVIEW_TEXT_MAX_BYTES * 2)
    expect(result.content).toBeUndefined()
    expect(result.truncated).toBeUndefined()
  })

  it('再大的二进制也只嗅头部：返回值不随体积膨胀', async () => {
    const huge = join(base, 'concert.mp3')
    await nodeFs.writeFile(huge, '')
    await nodeFs.truncate(huge, 512 * 1024 * 1024)
    const result = await buildFilePreview(port(base), { sessionId: 's1', path: huge })
    expect(result.kind).toBe('unsupported')
    expect(result.bytes).toBe(512 * 1024 * 1024)
  })
})

function docPort(
  options: { body?: string; warnings?: string[]; fail?: string; layout?: boolean } = {},
) {
  return {
    rootOf: () => base,
    documentBodyOf: async () => {
      if (options.fail !== undefined) throw new Error(options.fail)
      return { body: options.body ?? '# 注入正文', warnings: options.warnings ?? [] }
    },
    ...(options.layout === undefined ? {} : { layoutAvailable: () => options.layout === true }),
  }
}

describe('buildFilePreview（Office / PDF 正文）', () => {
  it('docx / xlsx / pptx / pdf / html 落 document，不落 unsupported（夹具含 NUL）', async () => {
    for (const [name, format] of [
      ['书.docx', 'docx'],
      ['表.xlsx', 'xlsx'],
      ['幻灯片.pptx', 'pptx'],
      ['论文.pdf', 'pdf'],
      ['网页.html', 'html'],
    ] as const) {
      const result = await buildFilePreview(docPort(), { sessionId: 's1', path: join(base, name) })
      expect(result.kind).toBe('document')
      expect(result.content).toBe('# 注入正文')
      expect(result.document?.format).toBe(format)
      expect(result.mtimeMs).toBeGreaterThan(0)
    }
  })

  it('提取告警原样带回（渲染层显示截断提示）', async () => {
    const result = await buildFilePreview(docPort({ warnings: ['表格超过 200 行，已截断'] }), {
      sessionId: 's1',
      path: join(base, '表.xlsx'),
    })
    expect(result.document?.warnings).toEqual(['表格超过 200 行，已截断'])
  })

  it('.doc 老式二进制：unsupported + 说明（不尝试解析）', async () => {
    const result = await buildFilePreview(docPort(), {
      sessionId: 's1',
      path: join(base, '旧.doc'),
    })
    expect(result.kind).toBe('unsupported')
    expect(result.note).toContain('老式二进制')
  })

  it('超过 32 MiB 拒绝提取，给信息卡文案', async () => {
    const result = await buildFilePreview(docPort(), {
      sessionId: 's1',
      path: join(base, '巨.docx'),
    })
    expect(result.kind).toBe('unsupported')
    expect(result.note).toContain('超过预览上限')
  })

  it('提取失败不抛到 IPC 顶层：unsupported + 原因（面板仍能给信息卡 + 系统打开）', async () => {
    const result = await buildFilePreview(docPort({ fail: '提取超时（12000ms）' }), {
      sessionId: 's1',
      path: join(base, '书.docx'),
    })
    expect(result.kind).toBe('unsupported')
    expect(result.note).toContain('提取超时（12000ms）')
  })

  it('未注入提取器时如实说不可用', async () => {
    const result = await buildFilePreview(port(base), {
      sessionId: 's1',
      path: join(base, '书.docx'),
    })
    expect(result.kind).toBe('unsupported')
    expect(result.note).toContain('提取器不可用')
  })

  it('版式可用性随注入的 CLI 状态变化；pdf 连档位都不出现', async () => {
    const on = await buildFilePreview(docPort({ layout: true }), {
      sessionId: 's1',
      path: join(base, '书.docx'),
    })
    expect(on.layoutAvailable).toBe(true)
    expect(on.layoutUnavailableReason).toBeUndefined()

    const off = await buildFilePreview(docPort({ layout: false }), {
      sessionId: 's1',
      path: join(base, '书.docx'),
    })
    expect(off.layoutAvailable).toBe(false)
    expect(off.layoutUnavailableReason).toContain('未安装 Office 渲染组件')

    const pdf = await buildFilePreview(docPort({ layout: true }), {
      sessionId: 's1',
      path: join(base, '论文.pdf'),
    })
    expect(pdf.layoutAvailable).toBeUndefined()
  })

  it('文本与图片也回填 mtimeMs（信息卡要用）', async () => {
    const txt = await buildFilePreview(port(base), {
      sessionId: 's1',
      path: join(base, 'plain.txt'),
    })
    expect(txt.mtimeMs).toBeGreaterThan(0)
    const img = await buildFilePreview(port(base), {
      sessionId: 's1',
      path: join(base, 'pixel.png'),
    })
    expect(img.mtimeMs).toBeGreaterThan(0)
  })
})
