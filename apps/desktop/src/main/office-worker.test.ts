import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseDocument } from '@office-open/docx'
import { handleOfficeRequest } from './office-worker.js'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aurora-office-worker-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('office-worker 真实引擎闭环', () => {
  it('DOCX 创建 → 读取 → 替换文字', async () => {
    const path = join(dir, 'report.docx')
    const created = await handleOfficeRequest({
      id: '1',
      action: 'create',
      outputPath: path,
      format: 'docx',
      content: {
        title: '季度报告',
        blocks: [
          { type: 'heading', level: 2, text: '概览' },
          { type: 'paragraph', text: '状态：{{status}}' },
          { type: 'bullets', items: ['第一项'] },
          { type: 'numbered', items: ['步骤一'] },
          { type: 'table', headers: ['项目', '结果'], rows: [['交付', '完成']] },
        ],
      },
    })
    expect(created.ok).toBe(true)

    const read = await handleOfficeRequest({
      id: '2',
      action: 'read',
      path,
      format: 'docx',
      offset: 0,
      limit: 50,
    })
    expect(read.ok).toBe(true)
    expect(read.read?.content).toContain('季度报告')

    const parsed = (await parseDocument(new Uint8Array(await readFile(path)))) as unknown as {
      numbering?: { abstractNumberings?: { levels?: { format?: string }[] }[] }
      sections?: { children?: { paragraph?: Record<string, unknown> }[] }[]
    }
    const formats = (parsed.numbering?.abstractNumberings ?? []).flatMap((item) =>
      (item.levels ?? []).map((level) => level.format),
    )
    expect(formats).toContain('decimal')
    expect(formats).toContain('bullet')
    const children = parsed.sections?.[0]?.children ?? []
    const paragraphs = children
      .map((child) => child.paragraph)
      .filter((paragraph): paragraph is Record<string, unknown> => paragraph !== undefined)
    const serialized = JSON.stringify(parsed)
    expect(paragraphs.some((paragraph) => paragraph['heading'] === 'Heading1')).toBe(true)
    expect(serialized).toContain('第一项')
    expect(serialized).toContain('步骤一')
    expect(serialized).not.toContain('• 第一项')
    expect(serialized).not.toContain('1. 步骤一')
    expect(
      paragraphs.find((paragraph) => paragraph['text'] === '第一项')?.['numbering'],
    ).toBeTruthy()
    expect(
      paragraphs.find((paragraph) => paragraph['text'] === '步骤一')?.['numbering'],
    ).toBeTruthy()

    const editedPath = join(dir, 'report-edited.docx')
    const edited = await handleOfficeRequest({
      id: '3',
      action: 'edit',
      sourcePath: path,
      outputPath: editedPath,
      format: 'docx',
      operations: [{ type: 'replace_text', find: '{{status}}', replace: '正常' }],
    })
    if (!edited.ok) throw new Error(`edit failed: ${edited.error}`)

    const reread = await handleOfficeRequest({
      id: '4',
      action: 'read',
      path: editedPath,
      format: 'docx',
      offset: 0,
      limit: 50,
    })
    expect(reread.ok).toBe(true)
    expect(reread.read?.content).toContain('正常')
  })

  it('XLSX 创建 → set_cells → 再读取公式', async () => {
    const path = join(dir, 'book.xlsx')
    const created = await handleOfficeRequest({
      id: '1',
      action: 'create',
      outputPath: path,
      format: 'xlsx',
      content: {
        sheets: [
          {
            name: '数据',
            rows: [
              ['项目', '数量', '单价', '合计'],
              ['苹果', 2, 3.5, { value: 7, formula: 'B2*C2' }],
            ],
          },
        ],
      },
    })
    expect(created.ok).toBe(true)

    const editedPath = join(dir, 'book-edited.xlsx')
    const edited = await handleOfficeRequest({
      id: '2',
      action: 'edit',
      sourcePath: path,
      outputPath: editedPath,
      format: 'xlsx',
      operations: [
        {
          type: 'set_cells',
          cells: [{ sheet: '数据', address: 'B2', value: 5 }],
        },
      ],
    })
    expect(edited.ok).toBe(true)

    const read = await handleOfficeRequest({
      id: '3',
      action: 'read',
      path: editedPath,
      format: 'xlsx',
      target: '数据',
      offset: 0,
      limit: 20,
    })
    expect(read.ok).toBe(true)
    expect(read.read?.content).toContain('B2=5')
    expect(read.read?.content).toContain('D2==B2*C2')
  })

  it('DOCX 模板占位符替换与列表追加都保留真实编号', async () => {
    const template = join(dir, 'template.docx')
    const createdTemplate = await handleOfficeRequest({
      id: '1',
      action: 'create',
      outputPath: template,
      format: 'docx',
      content: {
        title: '模板',
        blocks: [{ type: 'paragraph', text: '姓名：{{name}}' }],
      },
    })
    expect(createdTemplate.ok).toBe(true)

    const output = join(dir, 'template-filled.docx')
    const filled = await handleOfficeRequest({
      id: '2',
      action: 'create',
      outputPath: output,
      format: 'docx',
      templatePath: template,
      templateData: { name: '张三' },
      content: {
        blocks: [
          { type: 'bullets', items: ['第一项'] },
          { type: 'numbered', items: ['步骤一'] },
        ],
      },
    })
    expect(filled.ok).toBe(true)

    const parsed = (await parseDocument(new Uint8Array(await readFile(output)))) as unknown as {
      numbering?: { abstractNumberings?: { levels?: { format?: string }[] }[] }
    }
    const formats = (parsed.numbering?.abstractNumberings ?? []).flatMap((item) =>
      (item.levels ?? []).map((level) => level.format),
    )
    const serialized = JSON.stringify(parsed)
    expect(serialized).toContain('姓名：')
    expect(serialized).toContain('张三')
    expect(serialized).toContain('第一项')
    expect(serialized).toContain('步骤一')
    expect(formats).toContain('bullet')
    expect(formats).toContain('decimal')
  })

  it('PPTX 创建 → 追加幻灯片 → 删除原幻灯片', async () => {
    const path = join(dir, 'deck.pptx')
    const created = await handleOfficeRequest({
      id: '1',
      action: 'create',
      outputPath: path,
      format: 'pptx',
      content: {
        title: '演示',
        slides: [{ title: '第一页', bullets: ['A', 'B'], notes: '备注' }],
      },
    })
    expect(created.ok).toBe(true)

    const editedPath = join(dir, 'deck-edited.pptx')
    const edited = await handleOfficeRequest({
      id: '2',
      action: 'edit',
      sourcePath: path,
      outputPath: editedPath,
      format: 'pptx',
      operations: [
        { type: 'append_slides', slides: [{ title: '第二页', bullets: ['C'] }] },
        { type: 'remove_slides', indexes: [0] },
      ],
    })
    expect(edited.ok).toBe(true)

    const read = await handleOfficeRequest({
      id: '3',
      action: 'read',
      path: editedPath,
      format: 'pptx',
      offset: 0,
      limit: 50,
    })
    expect(read.ok).toBe(true)
    expect(read.read?.content).toContain('第二页')
  })

  it('DOCX / PPTX 能嵌入本地图片', async () => {
    const image = join(dir, 'pixel.png')
    await writeFile(
      image,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    )
    const docx = await handleOfficeRequest({
      id: '1',
      action: 'create',
      outputPath: join(dir, 'with-image.docx'),
      format: 'docx',
      content: { blocks: [{ type: 'image', path: image, width: '2cm', height: '2cm' }] },
    })
    expect(docx.ok).toBe(true)

    const pptx = await handleOfficeRequest({
      id: '2',
      action: 'create',
      outputPath: join(dir, 'with-image.pptx'),
      format: 'pptx',
      content: { slides: [{ title: '图片页', image: { path: image, width: 200, height: 200 } }] },
    })
    expect(pptx.ok).toBe(true)
  })
})
