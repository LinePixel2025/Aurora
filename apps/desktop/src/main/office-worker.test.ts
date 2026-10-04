import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
