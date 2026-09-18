import { describe, expect, it } from 'vitest'
import {
  KEYWORD_CONFIDENCE,
  LEARNED_CONFIDENCE,
  SUBJECTNAME_CONFIDENCE,
  learnRules,
  matchRules,
  normalizeFileName,
} from './rules.js'

const subjects = [
  { name: '数学', keywords: ['函数', '方程'] },
  { name: '物理', keywords: ['电路'] },
  { name: '语文', keywords: [] },
]

describe('normalizeFileName', () => {
  it('去掉扩展名与空白 / 分隔符并转小写', () => {
    expect(normalizeFileName('数学 - 作业(1).PDF')).toBe('数学作业1')
  })

  it('无扩展名时保留原名', () => {
    expect(normalizeFileName('数学作业')).toBe('数学作业')
  })

  it('中文括号与顿号也被归一', () => {
    expect(normalizeFileName('物理【实验】报告.docx')).toBe('物理实验报告')
  })
})

describe('matchRules', () => {
  it('文件名包含科目名 → 高置信度命中', () => {
    const verdict = matchRules({ fileName: '数学试卷.pdf', subjects })
    expect(verdict?.subject).toBe('数学')
    expect(verdict?.confidence).toBe(SUBJECTNAME_CONFIDENCE)
    expect(verdict?.source).toBe('rule')
  })

  it('文件名命中科目关键词 → 命中', () => {
    const verdict = matchRules({ fileName: '一元二次方程练习.docx', subjects })
    expect(verdict?.subject).toBe('数学')
    expect(verdict?.confidence).toBe(KEYWORD_CONFIDENCE)
    expect(verdict?.reason).toContain('方程')
  })

  it('无任何命中 → undefined（交给模型）', () => {
    expect(matchRules({ fileName: '扫描件001.pdf', subjects })).toBeUndefined()
  })

  it('空文件名 → undefined', () => {
    expect(matchRules({ fileName: '', subjects })).toBeUndefined()
  })

  it('两个不同科目并列命中时放弃（不猜）', () => {
    // 「物理」与「方程词」同长度关键词，且文件名同时包含两者
    const ambiguous = [
      { name: '数学', keywords: ['方程'] },
      { name: '物理', keywords: ['电路'] },
    ]
    // 两科各有一个长度 2 的关键词，但只有数学命中 → 正常返回
    expect(matchRules({ fileName: '方程.pdf', subjects: ambiguous })?.subject).toBe('数学')

    // 真正并列：两科都命中且关键词长度相同
    const tie = [
      { name: 'A科', keywords: ['xx'] },
      { name: 'B科', keywords: ['yy'] },
    ]
    expect(matchRules({ fileName: 'xxyy.pdf', subjects: tie })).toBeUndefined()
  })

  it('同一科目被科目名与关键词同时命中不算歧义', () => {
    const verdict = matchRules({ fileName: '数学方程.pdf', subjects })
    expect(verdict?.subject).toBe('数学')
  })

  it('更具体（更长）的关键词优先', () => {
    // 刻意让两个科目的**名字都不出现**在文件名里，隔离"关键词长度决定优先级"这一条
    const specific = [
      { name: '甲科', keywords: ['电路'] },
      { name: '乙科', keywords: ['电路实验报告'] },
    ]
    const verdict = matchRules({ fileName: '电路实验报告.docx', subjects: specific })
    expect(verdict?.subject).toBe('乙科')
  })

  it('关键词为空字符串时被忽略', () => {
    const withBlank = [{ name: '数学', keywords: ['', '   '] }]
    expect(matchRules({ fileName: '数学作业.pdf', subjects: withBlank })?.subject).toBe('数学')
  })
})

describe('learnRules / 用户修正反哺', () => {
  it('只从 corrected 记录沉淀规则', () => {
    const rules = learnRules([
      { fileName: '扫描件001.pdf', subject: '数学', corrected: true },
      { fileName: '未修正.pdf', subject: '物理' },
    ])
    expect(rules).toHaveLength(1)
    expect(rules[0]?.token).toBe('扫描件001')
    expect(rules[0]?.subject).toBe('数学')
  })

  it('同一 token 被多次修正 → hits 累加并排前', () => {
    const rules = learnRules([
      { fileName: 'scan1.pdf', subject: '数学', corrected: true },
      { fileName: 'scan1.pdf', subject: '数学', corrected: true },
      { fileName: 'other.pdf', subject: '物理', corrected: true },
    ])
    expect(rules[0]?.hits).toBe(2)
    expect(rules[0]?.subject).toBe('数学')
  })

  it('空科目名的修正不沉淀', () => {
    expect(learnRules([{ fileName: 'a.pdf', subject: '', corrected: true }])).toEqual([])
  })

  it('沉淀的规则可让后续同类文件名命中（跳过 LLM 的关键）', () => {
    const learned = learnRules([{ fileName: '扫描件001.pdf', subject: '数学', corrected: true }])
    const verdict = matchRules({ fileName: '扫描件001.pdf', subjects, learned })
    expect(verdict?.subject).toBe('数学')
    expect(verdict?.confidence).toBe(LEARNED_CONFIDENCE)
    expect(verdict?.reason).toContain('已学习')
  })

  it('修正到的科目已不存在时不使用该规则', () => {
    const learned = learnRules([
      { fileName: '扫描件001.pdf', subject: '已删除科目', corrected: true },
    ])
    expect(matchRules({ fileName: '扫描件001.pdf', subjects, learned })).toBeUndefined()
  })

  it('无任何规则命中时，学习规则能命中并优先于普通关键词', () => {
    // 「试卷」不是任何科目的关键词；学习规则把它指向物理
    const learned = learnRules([{ fileName: '期中试卷.pdf', subject: '物理', corrected: true }])
    const verdict = matchRules({ fileName: '期中试卷.pdf', subjects, learned })
    expect(verdict?.subject).toBe('物理')
    expect(verdict?.confidence).toBe(LEARNED_CONFIDENCE)
  })

  it('科目名命中（0.95）优先于学习规则（0.9）：字面科目名更可信', () => {
    const learned = learnRules([{ fileName: '数学试卷.pdf', subject: '物理', corrected: true }])
    const verdict = matchRules({ fileName: '数学试卷.pdf', subjects, learned })
    expect(verdict?.subject).toBe('数学')
    expect(verdict?.confidence).toBe(SUBJECTNAME_CONFIDENCE)
  })
})
