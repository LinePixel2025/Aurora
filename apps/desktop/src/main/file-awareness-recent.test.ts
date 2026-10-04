import { describe, expect, it } from 'vitest'
import { parseRecentProbeOutput, recentEntryKey } from './file-awareness-recent.js'

describe('file-awareness-recent', () => {
  it('解析单条与数组，保留所有可感知文档与图片扩展名', () => {
    const one = parseRecentProbeOutput(
      JSON.stringify({
        target: 'D:\\Docs\\A.docx',
        shortcutPath: 'C:\\Recent\\A.lnk',
        observedAt: '2026-10-04T00:00:00.000Z',
      }),
    )
    expect(one).toHaveLength(1)

    const many = parseRecentProbeOutput(
      JSON.stringify([
        {
          target: 'D:\\Docs\\A.pptx',
          shortcutPath: 'C:\\Recent\\A.lnk',
          observedAt: '2026-10-04T00:00:00.000Z',
        },
        {
          target: 'D:\\Docs\\A.txt',
          shortcutPath: 'C:\\Recent\\B.lnk',
          observedAt: '2026-10-04T00:00:00.000Z',
        },
      ]),
    )
    expect(many.map((item) => item.target)).toEqual(['D:\\Docs\\A.pptx', 'D:\\Docs\\A.txt'])
  })

  it('畸形 JSON 与缺字段安全降级为空数组', () => {
    expect(parseRecentProbeOutput('{')).toEqual([])
    expect(parseRecentProbeOutput(JSON.stringify({ target: 'A.docx' }))).toEqual([])
  })

  it('去重键不区分路径大小写，但保留观察时间', () => {
    expect(recentEntryKey({ target: 'D:\\A.docx', observedAt: 't1' })).not.toBe(
      recentEntryKey({ target: 'D:\\A.docx', observedAt: 't2' }),
    )
    expect(recentEntryKey({ target: 'D:\\A.docx', observedAt: 't1' })).toBe(
      recentEntryKey({ target: 'd:\\a.docx', observedAt: 't1' }),
    )
  })
})
