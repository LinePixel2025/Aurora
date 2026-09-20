import { describe, expect, it } from 'vitest'
import { createDefaultSettings } from '../config/defaults.js'
import { fieldAccepts } from '../config/schema.js'
import { deepClone, sanitizeWithDefaults, type SanitizeIssue } from './object.js'

const defaults = createDefaultSettings() as unknown as Record<string, unknown>
const leaf = fieldAccepts

describe('sanitizeWithDefaults（非法字段回退默认值）', () => {
  it('合法字段被保留，缺失字段补默认值', () => {
    const issues: SanitizeIssue[] = []
    const result = sanitizeWithDefaults(
      { general: { language: 'en-US' }, modes: { current: 'work' } },
      defaults,
      leaf,
      issues,
    )
    const general = result['general'] as Record<string, unknown>
    expect(general['language']).toBe('en-US')
    expect(general['hotkey']).toBe('Alt+Space')
    expect((result['modes'] as Record<string, unknown>)['current']).toBe('work')
    expect(issues).toEqual([])
  })

  it('字段类型非法时回退默认并记录 issue，其它字段不受影响', () => {
    const issues: SanitizeIssue[] = []
    const result = sanitizeWithDefaults(
      { general: { language: 42, hotkey: 'Ctrl+K' } },
      defaults,
      leaf,
      issues,
    )
    const general = result['general'] as Record<string, unknown>
    expect(general['language']).toBe('zh-CN')
    expect(general['hotkey']).toBe('Ctrl+K')
    expect(issues.map((i) => i.path)).toContain('general.language')
  })

  it('非对象输入整体退回默认', () => {
    const result = sanitizeWithDefaults('not-an-object', defaults, leaf)
    expect(result).toEqual(defaults)
  })

  it('嵌套对象逐层回退，不整块丢弃', () => {
    const issues: SanitizeIssue[] = []
    const result = sanitizeWithDefaults(
      { general: { edgeBar: { enabled: false, opacity: 'oops' } } },
      defaults,
      leaf,
      issues,
    )
    const edgeBar = (result['general'] as Record<string, unknown>)['edgeBar'] as Record<
      string,
      unknown
    >
    expect(edgeBar['enabled']).toBe(false)
    expect(edgeBar['opacity']).toBe(0.9)
    expect(issues.map((i) => i.path)).toContain('general.edgeBar.opacity')
  })

  it('数组值原样保留（科目 / 课程表）', () => {
    const subjects = [{ name: '数学', folder: '分类/数学', keywords: ['函数'] }]
    const result = sanitizeWithDefaults({ modes: { classroom: { subjects } } }, defaults, leaf)
    const classroom = ((result['modes'] as Record<string, unknown>)['classroom'] ?? {}) as Record<
      string,
      unknown
    >
    expect(classroom['subjects']).toEqual(subjects)
  })

  it('deepClone 后修改副本不影响源对象', () => {
    const source = createDefaultSettings()
    const clone = deepClone(source)
    clone.modes.classroom.watchDir = 'D:\\感知文件夹'
    expect(source.modes.classroom.watchDir).toBe('')
  })

  it('deepClone 能把 Proxy 变成可结构化克隆的纯数据', () => {
    // 这条钉住的是一个真实踩过的坑：`ipcRenderer.invoke` 用结构化克隆传参，
    // Vue reactive 产出的 Proxy 不可克隆（DataCloneError）；渲染层发往主进程的
    // patch / 数组必须先过 deepClone（见 renderer/shared/stores.ts、useChat.ts）。
    const proxy = new Proxy({ modes: { classroom: { subjects: ['数学'] } } }, {})
    expect(() => structuredClone(proxy)).toThrow()

    const plain = deepClone(proxy)
    expect(plain).toEqual({ modes: { classroom: { subjects: ['数学'] } } })
    expect(() => structuredClone(plain)).not.toThrow()
  })

  it('deepClone 处理数组 Proxy（附件列表的场景）', () => {
    const list = new Proxy(['a.txt', 'b.pdf'], {})
    expect(() => structuredClone(list)).toThrow()
    expect(deepClone(list)).toEqual(['a.txt', 'b.pdf'])
  })
})
