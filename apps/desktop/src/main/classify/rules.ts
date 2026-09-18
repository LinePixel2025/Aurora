/**
 * 分类规则（docs/05 §3.2「规则缓存」）—— 纯函数，可独立单测。
 *
 * 规则来源有两处：
 * 1. **配置**：`modes.classroom.subjects[].keywords`（用户在设置页维护）；
 * 2. **用户修正**：`classification.json` 里 `corrected` 的记录 —— 同类文件名再次出现时直接命中，
 *    跳过 LLM，既省 token 又让用户的修正"越用越准"（docs/05 §3.2 ④）。
 *
 * 规则只处理**文件名**：文件名是用户输入的判断依据，命中最强、零成本。
 * 内容证据不参与规则——那需要读文件，就不省成本了。
 */

export interface SubjectLike {
  name: string
  keywords: readonly string[]
}

export type ClassificationSource = 'rule' | 'llm' | 'fallback' | 'user'

export interface RuleVerdict {
  subject: string
  confidence: number
  reason: string
  source: ClassificationSource
  /** 命中的关键词 / 修正来源，用于日志与流水 */
  matched: string
}

/** 一条从用户修正中沉淀的规则 */
export interface LearnedRule {
  /** 归一后的文件名关键字（不含扩展名） */
  token: string
  subject: string
  /** 被修正的次数：次数多的规则优先 */
  hits: number
}

/** 配置关键词命中的置信度：文件名里直接出现科目关键词，是最强的信号 */
export const KEYWORD_CONFIDENCE = 0.92
/** 文件名包含科目名本身（如「数学」）时的置信度 */
export const SUBJECTNAME_CONFIDENCE = 0.95
/** 用户修正规则的置信度 */
export const LEARNED_CONFIDENCE = 0.9

/**
 * 归一化文件名：去掉扩展名，去掉空白与常见分隔符，转小写。
 * 让「数学 - 作业(1).pdf」与「数学作业.pdf」能归一为相近 token。
 */
export function normalizeFileName(fileName: string): string {
  const withoutExt = fileName.replace(/\.[^.\\/]+$/, '')
  return withoutExt
    .toLowerCase()
    .replace(/[\s_\-–—()（）[\]【】.．、,，]+/g, '')
    .trim()
}

/**
 * 从用户修正记录里沉淀规则（docs/05 §3.2「用户修正分类时同步更新规则与历史」）。
 *
 * 输入是历史流水中的 `corrected` 记录；同一文件名 token 被多次修正到同一科目时 `hits` 累加。
 * 后续分类按 `hits` 降序匹配，让反复修正过的规则更强势。
 */
export function learnRules(
  records: readonly { fileName: string; subject: string; corrected?: boolean }[],
): LearnedRule[] {
  const map = new Map<string, LearnedRule>()
  for (const record of records) {
    if (record.corrected !== true || record.subject.trim() === '') continue
    const token = normalizeFileName(record.fileName)
    if (token === '') continue
    const key = `${token}\u0000${record.subject}`
    const existing = map.get(key)
    if (existing) existing.hits += 1
    else map.set(key, { token, subject: record.subject, hits: 1 })
  }
  return [...map.values()].sort((a, b) => b.hits - a.hits)
}

/**
 * 用**配置关键词 + 科目名 + 用户修正规则**判定科目。
 *
 * 匹配顺序（越靠前越可信）：
 * 1. 文件名直接包含科目名（「数学试卷.pdf」→ 数学）；
 * 2. 文件名包含该科目的某个关键词（含用户修正沉淀的 token）；
 * 3. 无命中 → 返回 `undefined`，由上层交给 LLM。
 *
 * 注意：**不猜**。多个科目同时命中时取匹配的科目名最长者（更具体），
 * 仍并列则放弃，交给 LLM（避免规则误判污染结果）。
 */
export function matchRules(input: {
  fileName: string
  subjects: readonly SubjectLike[]
  learned?: readonly LearnedRule[]
}): RuleVerdict | undefined {
  const normalizedName = normalizeFileName(input.fileName)
  const rawName = input.fileName.toLowerCase()
  if (normalizedName === '' && rawName === '') return undefined

  interface Hit {
    subject: string
    confidence: number
    reason: string
    matched: string
    /** 匹配到的关键字长度：越长越具体 */
    length: number
  }
  const hits: Hit[] = []

  for (const subject of input.subjects) {
    const name = subject.name.trim()
    if (name === '') continue

    // 1. 科目名直接出现在文件名里
    const normalizedSubject = normalizeFileName(name)
    if (normalizedSubject !== '' && normalizedName.includes(normalizedSubject)) {
      hits.push({
        subject: name,
        confidence: SUBJECTNAME_CONFIDENCE,
        reason: `文件名包含科目名「${name}」`,
        matched: name,
        length: normalizedSubject.length,
      })
      continue
    }

    // 2. 配置关键词
    let best: Hit | undefined
    for (const keyword of subject.keywords) {
      const token = keyword.trim().toLowerCase()
      if (token === '') continue
      if (!normalizedName.includes(normalizeFileName(token)) && !rawName.includes(token)) continue
      const candidate: Hit = {
        subject: name,
        confidence: KEYWORD_CONFIDENCE,
        reason: `文件名命中关键词「${keyword.trim()}」`,
        matched: keyword.trim(),
        length: token.length,
      }
      if (best === undefined || candidate.length > best.length) best = candidate
    }
    if (best) hits.push(best)
  }

  // 3. 用户修正沉淀的规则（token 必须在归一文件名里完整出现）
  if (normalizedName !== '') {
    for (const rule of input.learned ?? []) {
      if (rule.token === '' || !normalizedName.includes(rule.token)) continue
      if (!input.subjects.some((s) => s.name === rule.subject)) continue
      hits.push({
        subject: rule.subject,
        confidence: LEARNED_CONFIDENCE,
        reason: `你之前把同类文件归到「${rule.subject}」（已学习）`,
        matched: rule.token,
        length: rule.token.length,
      })
    }
  }

  if (hits.length === 0) return undefined

  hits.sort((a, b) => b.confidence - a.confidence || b.length - a.length)
  const top = hits[0]!
  const second = hits[1]
  // 并列时放弃：宁可问模型，也不猜。
  // 但若并列项指向**同一个科目**（如科目名与关键词同时命中「数学」），则不算歧义。
  if (
    second !== undefined &&
    second.subject !== top.subject &&
    second.confidence === top.confidence &&
    second.length === top.length
  ) {
    return undefined
  }
  return {
    subject: top.subject,
    confidence: top.confidence,
    reason: top.reason,
    source: 'rule',
    matched: top.matched,
  }
}
