import { describe, expect, it } from 'vitest'
import { isParseError, parseSkillMarkdown } from './parse.js'

const VALID = `---
name: file-classify
description: 根据文件内容证据判定科目
when_to_use: 智慧感知文件夹出现新文件时
---

# 步骤
1. 读取证据
`

describe('parseSkillMarkdown', () => {
  it('解析 frontmatter 与正文', () => {
    const parsed = parseSkillMarkdown(VALID)
    if (isParseError(parsed)) throw new Error(parsed.error)
    expect(parsed.frontmatter.name).toBe('file-classify')
    expect(parsed.frontmatter.description).toBe('根据文件内容证据判定科目')
    expect(parsed.frontmatter['when_to_use']).toBe('智慧感知文件夹出现新文件时')
    expect(parsed.body.startsWith('# 步骤')).toBe(true)
  })

  it('支持带引号的值与 CRLF 换行', () => {
    const source = '---\r\nname: "demo"\r\ndescription: \'带引号描述\'\r\n---\r\n正文\r\n'
    const parsed = parseSkillMarkdown(source)
    if (isParseError(parsed)) throw new Error(parsed.error)
    expect(parsed.frontmatter.name).toBe('demo')
    expect(parsed.frontmatter.description).toBe('带引号描述')
    expect(parsed.body).toBe('正文')
  })

  it('忽略注释与空行，允许额外的自定义键', () => {
    const parsed = parseSkillMarkdown(
      ['---', '# 注释', 'name: a', '', 'description: b', 'version: 2', '---', 'x'].join('\n'),
    )
    if (isParseError(parsed)) throw new Error(parsed.error)
    expect(parsed.frontmatter['version']).toBe('2')
  })

  it('缺少 frontmatter 报错', () => {
    const parsed = parseSkillMarkdown('# 只有正文')
    expect(isParseError(parsed)).toBe(true)
    if (isParseError(parsed)) expect(parsed.error).toContain('frontmatter')
  })

  it('缺少 name / description 报错', () => {
    const noName = parseSkillMarkdown('---\ndescription: b\n---\n')
    expect(isParseError(noName)).toBe(true)

    const noDescription = parseSkillMarkdown('---\nname: a\n---\n')
    expect(isParseError(noDescription)).toBe(true)
  })

  it('容忍 BOM 头', () => {
    const parsed = parseSkillMarkdown(`\uFEFF${VALID}`)
    expect(isParseError(parsed)).toBe(false)
  })
})
