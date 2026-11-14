/**
 * 文件面板的文档正文（2026-11-12，docs/07 §2.3）：
 * `officeBodyOf` 的正文口径（干净 Markdown / 表格 / 上限）+ `createPreviewExtractor` 的 LRU 与降级。
 * 提取池用假实现注入，不起 utilityProcess。
 */
import { describe, expect, it } from 'vitest'
import { BODY_TABLE_MAX_COLS, BODY_TABLE_MAX_ROWS, officeBodyOf } from './extract.js'
import type { ExtractPoolRequest, ExtractPoolResult } from './extract-pool.js'
import {
  PREVIEW_BODY_CACHE_ENTRIES,
  PREVIEW_BODY_MAX_BYTES,
  createPreviewExtractor,
} from './preview-extract.js'

function parsedOf(text: string, format: 'md' | 'csv' = 'md') {
  return {
    toText: () => '不应优先走的纯文本',
    to: async (requested: string) => ({ value: requested === format ? text : '别的格式' }),
  }
}

function fakePool(body: string | undefined, warnings: string[] = []) {
  const calls: ExtractPoolRequest[] = []
  return {
    calls,
    pool: {
      extract: async (request: ExtractPoolRequest): Promise<ExtractPoolResult> => {
        calls.push(request)
        return {
          kind: 'document',
          evidence: '文件名：不该出现在预览里',
          evidenceChars: 0,
          warnings,
          degraded: warnings.length > 0,
          ...(body === undefined ? {} : { body }),
        }
      },
    },
  }
}

describe('officeBodyOf（预览正文）', () => {
  it('docx 走 Markdown，且不含证据 header', async () => {
    const result = await officeBodyOf(parsedOf('# 欧姆定律\n\n正文一段'), 'docx')
    expect(result.body).toBe('# 欧姆定律\n\n正文一段')
    expect(result.body).not.toContain('文件名：')
    expect(result.body).not.toContain('文档结构：')
    expect(result.warnings).toEqual([])
  })

  it('xlsx 的 CSV 转成 Markdown 表格（首行当表头）', async () => {
    const result = await officeBodyOf(parsedOf('姓名,分数\n张三,90\n李四,88', 'csv'), 'xlsx')
    expect(result.body).toBe('| 姓名 | 分数 |\n| --- | --- |\n| 张三 | 90 |\n| 李四 | 88 |')
  })

  it('认引号包裹的逗号与 "" 转义，竖线被转义不撑破表格', async () => {
    const result = await officeBodyOf(parsedOf('"物理, 上","他说""好"""\na|b,2', 'csv'), 'ods')
    expect(result.body).toContain('| 物理, 上 | 他说"好" |')
    expect(result.body).toContain('| a\\|b | 2 |')
  })

  it('行数超限截断并告警', async () => {
    const csv = ['表头,值', ...Array.from({ length: 400 }, (_, i) => `第${i}行,1`)].join('\n')
    const result = await officeBodyOf(parsedOf(csv, 'csv'), 'xlsx')
    expect(result.body.split('\n')).toHaveLength(BODY_TABLE_MAX_ROWS + 1)
    expect(result.warnings).toContain(`表格超过 ${BODY_TABLE_MAX_ROWS} 行，已截断`)
  })

  it('列数超限截断并告警', async () => {
    const wide = Array.from({ length: 40 }, (_, i) => `c${i}`).join(',')
    const result = await officeBodyOf(parsedOf(`${wide}\n${wide}`, 'csv'), 'xlsx')
    const cells = result.body.split('\n')[0]?.split('|') ?? []
    expect(cells.length - 2).toBe(BODY_TABLE_MAX_COLS)
    expect(result.warnings).toContain(`表格超过 ${BODY_TABLE_MAX_COLS} 列，已截断`)
  })

  it('解析器退回纯文本（单列）时不硬套表格', async () => {
    const result = await officeBodyOf(parsedOf('第一行\n第二行', 'csv'), 'xlsx')
    expect(result.body).toBe('第一行\n第二行')
    expect(result.warnings).toEqual([])
  })

  it('结构化输出不可用时退回 toText()', async () => {
    const result = await officeBodyOf({ toText: () => '  纯文本兜底  ' }, 'pdf')
    expect(result.body).toBe('纯文本兜底')
  })
})

describe('createPreviewExtractor（薄封装 + LRU）', () => {
  it('只发 bodyOnly 请求，回干净正文', async () => {
    const { calls, pool } = fakePool('# 正文')
    const extractor = createPreviewExtractor(pool)
    const result = await extractor.documentBodyOf('D:\\p\\a.docx', 'docx', 100, 1)
    expect(result.body).toBe('# 正文')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ path: 'D:\\p\\a.docx', ext: 'docx', bodyOnly: true })
  })

  it('同 path + mtime + size 命中缓存，不再调池', async () => {
    const { calls, pool } = fakePool('# 正文')
    const extractor = createPreviewExtractor(pool)
    await extractor.documentBodyOf('D:\\p\\a.docx', 'docx', 100, 1)
    await extractor.documentBodyOf('D:\\p\\a.docx', 'docx', 100, 1)
    expect(calls).toHaveLength(1)
  })

  it('文件改过（mtime 变）自然失效', async () => {
    const { calls, pool } = fakePool('# 正文')
    const extractor = createPreviewExtractor(pool)
    await extractor.documentBodyOf('D:\\p\\a.docx', 'docx', 100, 1)
    await extractor.documentBodyOf('D:\\p\\a.docx', 'docx', 100, 2)
    expect(calls).toHaveLength(2)
  })

  it(`超过 ${PREVIEW_BODY_CACHE_ENTRIES} 条淘汰最旧的一条`, async () => {
    const { calls, pool } = fakePool('# 正文')
    const extractor = createPreviewExtractor(pool)
    for (let i = 0; i <= PREVIEW_BODY_CACHE_ENTRIES; i += 1) {
      await extractor.documentBodyOf(`D:\\p\\${i}.docx`, 'docx', 100, 1)
    }
    expect(calls).toHaveLength(PREVIEW_BODY_CACHE_ENTRIES + 1)
    await extractor.documentBodyOf('D:\\p\\0.docx', 'docx', 100, 1)
    expect(calls).toHaveLength(PREVIEW_BODY_CACHE_ENTRIES + 2)
    await extractor.documentBodyOf(`D:\\p\\${PREVIEW_BODY_CACHE_ENTRIES}.docx`, 'docx', 100, 1)
    expect(calls).toHaveLength(PREVIEW_BODY_CACHE_ENTRIES + 2)
  })

  it('单条超上限不进缓存（避免内存膨胀）', async () => {
    const { calls, pool } = fakePool('x'.repeat(PREVIEW_BODY_MAX_BYTES + 1))
    const extractor = createPreviewExtractor(pool)
    await extractor.documentBodyOf('D:\\p\\big.docx', 'docx', 100, 1)
    await extractor.documentBodyOf('D:\\p\\big.docx', 'docx', 100, 1)
    expect(calls).toHaveLength(2)
  })

  it('降级（没有 body）如实报错，带上池给的原因', async () => {
    const { pool } = fakePool(undefined, ['提取超时（12000ms）'])
    const extractor = createPreviewExtractor(pool)
    await expect(extractor.documentBodyOf('D:\\p\\a.docx', 'docx', 100, 1)).rejects.toThrow(
      '提取超时（12000ms）',
    )
  })

  it('空正文也报错（让面板给信息卡而不是空白页）', async () => {
    const { pool } = fakePool('   ')
    const extractor = createPreviewExtractor(pool)
    await expect(extractor.documentBodyOf('D:\\p\\a.docx', 'docx', 100, 1)).rejects.toThrow(
      '没有可显示的正文',
    )
  })

  it('clear() 后重新提取', async () => {
    const { calls, pool } = fakePool('# 正文')
    const extractor = createPreviewExtractor(pool)
    await extractor.documentBodyOf('D:\\p\\a.docx', 'docx', 100, 1)
    extractor.clear()
    await extractor.documentBodyOf('D:\\p\\a.docx', 'docx', 100, 1)
    expect(calls).toHaveLength(2)
  })
})
