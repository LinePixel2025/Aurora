import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseOffice } from 'officeparser'
import { buildDocxFixture } from './capture-office-fixture.js'
import { listZipEntries, officeBodyOf, type OfficeParseResult } from './extract.js'

const PARAGRAPHS = ['季度经营报告', '第一段：营收同比增长。', '第二段 & <特殊字符> 也要原样保留。']

describe('截图用 docx 夹具', () => {
  it('是一份能被 ZIP 目录读出来的合规包', () => {
    const names = listZipEntries(buildDocxFixture(PARAGRAPHS))
    expect(names).toContain('[Content_Types].xml')
    expect(names).toContain('_rels/.rels')
    expect(names).toContain('word/document.xml')
  })

  it('同样内容两次生成的字节完全一致（夹具可复现）', () => {
    expect(buildDocxFixture(PARAGRAPHS).equals(buildDocxFixture(PARAGRAPHS))).toBe(true)
  })

  describe('交给真实解析器', () => {
    let dir = ''
    let file = ''

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'aurora-docx-fixture-'))
      file = join(dir, '报告.docx')
      await writeFile(file, buildDocxFixture(PARAGRAPHS))
    })

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('officeparser 认它是 docx，正文原样抽得出来', async () => {
      const parsed = await parseOffice(file, {
        extractAttachments: false,
        includeRawContent: false,
      })
      expect(parsed.type).toBe('docx')
      const text = parsed.toText()
      for (const paragraph of PARAGRAPHS) expect(text).toContain(paragraph)
    })

    it('officeBodyOf 产出干净正文，不带证据 header', async () => {
      const parsed = (await parseOffice(file, {
        extractAttachments: false,
        includeRawContent: false,
      })) as unknown as OfficeParseResult
      const { body } = await officeBodyOf(parsed, 'docx')
      expect(body).toContain('季度经营报告')
      expect(body).toContain('营收同比增长')
      expect(body).not.toContain('文件名：')
      expect(body).not.toContain('类型：')
    })
  })
})
