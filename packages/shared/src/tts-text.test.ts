import { describe, expect, it } from 'vitest'
import { cleanTtsText, splitTtsText, TTS_CHUNK_CHARS, TTS_FIRST_CHUNK_CHARS } from './tts-text.js'

describe('cleanTtsText（朗读前清洗，docs/06 §13.4）', () => {
  it('围栏代码块整段删除（带语言标记），正文保留', () => {
    const text = '先看代码：\n```ts\nconst a = 1\nconsole.log(a)\n```\n就是这段。'
    expect(cleanTtsText(text)).toBe('先看代码： 就是这段。')
  })

  it('落单的围栏行也删掉（流式残尾防御）', () => {
    expect(cleanTtsText('开头\n```ts\n')).toBe('开头')
  })

  it('行内代码保留内容、去掉反引号', () => {
    expect(cleanTtsText('把 `maxChars` 调大')).toBe('把 maxChars 调大')
  })

  it('图片整删、链接只留文字', () => {
    const text = '看图 ![截图](https://x.com/a.png) 和 [文档](https://x.com/doc) 说明'
    expect(cleanTtsText(text)).toBe('看图 和 文档 说明')
  })

  it('参考式链接只留文字', () => {
    expect(cleanTtsText('见[说明][ref]。')).toBe('见说明。')
  })

  it('裸 URL 删除且不吞相邻中文（\\S 会吞中文，这里用 ASCII 字符集）', () => {
    expect(cleanTtsText('访问https://x.com/a?b=1看看效果')).toBe('访问看看效果')
  })

  it('标题 / 引用 / 列表 / 水平线标记剥离', () => {
    const text = '## 标题\n> 引用内容\n- 项目一\n1. 项目二\n---\n正文'
    expect(cleanTtsText(text)).toBe('标题 引用内容 项目一 项目二 正文')
  })

  it('表格：分隔行删除、竖线变空格、单元格文字保留', () => {
    const text = '| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |'
    expect(cleanTtsText(text)).toBe('名称 数量 苹果 3')
  })

  it('强调 / 删除线成对剥离、内容保留', () => {
    expect(cleanTtsText('这是**重点**和*斜体*还有~~删掉~~')).toBe('这是重点和斜体还有删掉')
    expect(cleanTtsText('__粗体__ 与 _斜体_')).toBe('粗体 与 斜体')
  })

  it('snake_case 标识符不被单下划线规则误伤', () => {
    expect(cleanTtsText('字段 max_chars 保持不变')).toBe('字段 max_chars 保持不变')
  })

  it('HTML 标签剥离', () => {
    expect(cleanTtsText('前面<br>后面<b>加粗</b>')).toBe('前面后面加粗')
  })

  it('情感标签原样保留（Qwen-Audio-TTS 文本内标签）', () => {
    expect(cleanTtsText('[excited]今天天气不错！[laughing]出去玩吧')).toBe(
      '[excited]今天天气不错！[laughing]出去玩吧',
    )
  })

  it('Markdown 转义还原', () => {
    expect(cleanTtsText('价格 \\* 数量')).toBe('价格 * 数量')
  })

  it('空白折叠：换行变空格、连续空白合一、首尾 trim', () => {
    expect(cleanTtsText('  第一句。\n\n  第二句。  \t 第三句。 ')).toBe(
      '第一句。 第二句。 第三句。',
    )
  })

  it('幂等：复杂样本清洗两次 = 一次（主进程与渲染层各洗一次不互相改写）', () => {
    const sample = [
      '# 标题',
      '正文带 **重点**、`code`、[链接](https://x.com) 与 ![图](https://x.com/a.png)。',
      '```py',
      'print("hello")',
      '```',
      '> 引用 [excited] 情绪标签',
      '| 甲 | 乙 |',
      '| --- | --- |',
      '| 1 | 2 |',
      ' snake_case 与 https://bare.url/path 结尾',
    ].join('\n')
    const once = cleanTtsText(sample)
    expect(cleanTtsText(once)).toBe(once)
    expect(once).not.toContain('```')
    expect(once).not.toContain('https://')
    expect(once).toContain('[excited]')
  })
})

describe('splitTtsText（清洗 + 总量截断 + 句界分块，docs/06 §13.8）', () => {
  it('空文本 / 全标记文本返回空数组', () => {
    expect(splitTtsText('', { maxChars: 2000 })).toEqual([])
    expect(splitTtsText('```ts\ncode\n```', { maxChars: 2000 })).toEqual([])
  })

  it('短文本单块返回（试听样例句路径）', () => {
    expect(splitTtsText('你好，我是 Aurora。', { maxChars: 2000 })).toEqual(['你好，我是 Aurora。'])
  })

  it('总量截断在分块前：各块合计不超过 maxChars（隐私边界）', () => {
    const text = '这是一句很长的话。'.repeat(200)
    const chunks = splitTtsText(text, { maxChars: 500 })
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    expect(total).toBeLessThanOrEqual(500)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('首块不超过 120 字且落在句界；后续块不超过 300 字', () => {
    // 每句 30 字 × 40 句 = 1200 字
    const sentence = '这是一个三十个字的句子用来测试分块行为' + '啊'.repeat(10) + '。'
    expect(sentence.length).toBe(30)
    const chunks = splitTtsText(sentence.repeat(40), { maxChars: 2000 })
    expect(chunks[0]!.length).toBeLessThanOrEqual(TTS_FIRST_CHUNK_CHARS)
    expect(chunks[0]!.endsWith('。')).toBe(true)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TTS_CHUNK_CHARS)
      expect(chunk.trim()).toBe(chunk)
      expect(chunk.length).toBeGreaterThan(0)
    }
    // 句界整齐时不丢字
    expect(chunks.join('')).toBe(sentence.repeat(40))
  })

  it('无句界的超长单句按上限硬切', () => {
    const text = '字'.repeat(1000)
    const chunks = splitTtsText(text, { maxChars: 2000 })
    expect(chunks[0]!.length).toBe(TTS_FIRST_CHUNK_CHARS)
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i]!.length).toBeLessThanOrEqual(TTS_CHUNK_CHARS)
    }
    expect(chunks.join('')).toBe(text)
  })

  it('后续块句界太靠前（< 半窗）时硬切，不切碎块', () => {
    // 首块 120 字硬切后，剩余开头 10 字处有个句界，其后 400 字无句界：
    // 第二块不应只切 10 字，而应硬切到 300
    const text = '字'.repeat(120) + '短句子。' + '文'.repeat(400)
    const chunks = splitTtsText(text, { maxChars: 2000 })
    expect(chunks[0]!.length).toBe(TTS_FIRST_CHUNK_CHARS)
    expect(chunks[1]!.length).toBe(TTS_CHUNK_CHARS)
  })

  it('maxChars 小于首块上限时整体单块', () => {
    const text = '第一句。第二句。第三句。'
    expect(splitTtsText(text, { maxChars: 50 })).toEqual([text])
  })

  it('先清洗再分块：代码块不占块、链接只留文字', () => {
    const text = '开头。\n```ts\nconst a = 1\n```\n结尾说明。'
    const chunks = splitTtsText(text, { maxChars: 2000 })
    expect(chunks).toEqual(['开头。 结尾说明。'])
  })
})
