import { describe, expect, it } from 'vitest'
import {
  defaultSubjectFolder,
  parseSubjectList,
  upsertSubjects,
  validateAbsolutePath,
} from './helpers.js'
import { createDefaultSettings } from '@aurora/shared'

describe('parseSubjectList', () => {
  it('支持中英文逗号 / 顿号 / 分号 / 换行分隔', () => {
    expect(parseSubjectList('数学,物理、化学；生物\n地理')).toEqual([
      '数学',
      '物理',
      '化学',
      '生物',
      '地理',
    ])
  })

  it('忽略空白项与首尾空格', () => {
    expect(parseSubjectList('  数学 ,, 物理  ')).toEqual(['数学', '物理'])
    expect(parseSubjectList('   ')).toEqual([])
  })
})

describe('defaultSubjectFolder', () => {
  it('默认规则为 分类/<科目>', () => {
    expect(defaultSubjectFolder('数学')).toBe('分类/数学')
  })
})

describe('upsertSubjects', () => {
  it('保留已有科目的 keywords，并剔除列表外的科目', () => {
    const settings = createDefaultSettings()
    settings.modes.classroom.subjects = [
      { name: '数学', folder: '分类/数学', keywords: ['函数'] },
      { name: '英语', folder: '分类/英语', keywords: [] },
    ]
    const result = upsertSubjects(settings, [
      { name: '数学', folder: 'D:/课程/数学' },
      { name: '物理', folder: '分类/物理' },
    ])
    expect(result).toEqual([
      { name: '数学', folder: 'D:/课程/数学', keywords: ['函数'] },
      { name: '物理', folder: '分类/物理', keywords: [] },
    ])
  })
})

describe('validateAbsolutePath', () => {
  it('拒绝相对路径与空值', () => {
    expect(validateAbsolutePath('')).toContain('不能为空')
    expect(validateAbsolutePath('感知文件夹')).toContain('绝对路径')
    expect(validateAbsolutePath('./data')).toContain('绝对路径')
  })

  it('接受 Windows 与 POSIX 绝对路径', () => {
    expect(validateAbsolutePath('D:\\Aurora\\感知文件夹')).toBeUndefined()
    expect(validateAbsolutePath('D:/Aurora/watch')).toBeUndefined()
    expect(validateAbsolutePath('\\\\server\\share')).toBeUndefined()
    expect(validateAbsolutePath('/home/user/aurora')).toBeUndefined()
  })
})
