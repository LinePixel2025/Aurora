import { describe, expect, it } from 'vitest'
import type { CenterOfficialServiceConfig } from '@aurora/shared'
import {
  createModelEntry,
  isDirty,
  mergeFetchedModels,
  modelRowIssues,
  validateDraft,
} from './official-models.js'

function service(patch: Partial<CenterOfficialServiceConfig> = {}): CenterOfficialServiceConfig {
  return {
    enabled: false,
    type: 'openai-compat',
    baseUrl: '',
    apiKeySet: false,
    defaultModel: '',
    models: [],
    ...patch,
  }
}

describe('官方模型配置纯逻辑', () => {
  it('拉取模型是合并而不是替换：保留既有条目，新增默认未开放', () => {
    const current = [
      {
        id: 'm1',
        enabled: true,
        reasoningEffort: 'high' as const,
        contextWindow: 128000,
        vision: true,
      },
      {
        id: 'm2',
        enabled: false,
        reasoningEffort: 'auto' as const,
        contextWindow: 0,
        vision: false,
      },
    ]
    const merged = mergeFetchedModels('llm', current, ['m2', 'm1', 'new-1', 'new-2', '  ', 'new-1'])

    expect(merged.added).toBe(2)
    expect(merged.kept).toBe(2)
    expect(merged.models.map((model) => model.id)).toEqual(['m1', 'm2', 'new-1', 'new-2'])
    // 既有条目的开放位与参数原样保留（旧实现整表替换会把它们冲掉）
    expect(merged.models[0]).toMatchObject({ enabled: true, contextWindow: 128000, vision: true })
    expect(merged.models[1]?.enabled).toBe(false)
    // 新来的默认未开放，能力参数走默认值
    expect(merged.models[2]).toMatchObject({
      enabled: false,
      reasoningEffort: 'auto',
      contextWindow: 0,
    })
    // 不改动入参
    expect(current).toHaveLength(2)
  })

  it('模型行的问题能定位到具体行：空 ID / 重复 ID', () => {
    const issues = modelRowIssues([
      { id: 'm1', enabled: true },
      { id: '  ', enabled: true },
      { id: 'm1', enabled: true },
      { id: 'm2', enabled: false },
    ])
    expect([...issues.keys()]).toEqual([1, 2])
    expect(issues.get(1)).toContain('不能为空')
    expect(issues.get(2)).toContain('重复')
  })

  it('保存前校验：未启用只查模型 ID，启用后按服务端规则补齐', () => {
    // 未启用：baseUrl / 模型 / Key 都不要求（服务端同样只在 enabled 时校验）
    expect(validateDraft(service({ models: [{ id: 'm1', enabled: false }] }), '')).toEqual([])

    const noBaseUrl = validateDraft(
      service({ enabled: true, apiKeySet: true, models: [{ id: 'm1', enabled: true }] }),
      '',
    )
    expect(noBaseUrl).toEqual(['启用前必须填写 Base URL。'])

    const noOpenModel = validateDraft(
      service({
        enabled: true,
        baseUrl: 'https://api.example.com/v1',
        apiKeySet: true,
        models: [{ id: 'm1', enabled: false }],
      }),
      '',
    )
    expect(noOpenModel).toEqual(['启用前至少开放一个模型。'])

    const noKey = validateDraft(
      service({
        enabled: true,
        baseUrl: 'https://api.example.com/v1',
        models: [{ id: 'm1', enabled: true }],
      }),
      '',
    )
    expect(noKey).toEqual(['启用前必须填写并保存 API Key。'])

    // 输入框里有新 Key 也算「保存后会有 Key」
    expect(
      validateDraft(
        service({
          enabled: true,
          baseUrl: 'https://api.example.com/v1',
          models: [{ id: 'm1', enabled: true }],
        }),
        'sk-new',
      ),
    ).toEqual([])

    const rows = validateDraft(service({ models: [{ id: '', enabled: true }] }), '')
    expect(rows[0]).toContain('模型 ID')
  })

  it('脏值判定：只看改动，不吃键序 / 缺省值差异', () => {
    const saved = service({
      enabled: true,
      baseUrl: 'https://api.example.com/v1',
      apiKeySet: true,
      defaultModel: 'm1',
      models: [
        { id: 'm1', enabled: true, reasoningEffort: 'auto', contextWindow: 0, vision: false },
      ],
    })
    // 服务端回来的形状 vs 本地新建后填好 id 的形状：键序不同但语义相同
    const sameShape = {
      ...createModelEntry('llm'),
      id: 'm1',
    }
    const draft = { ...saved, models: [sameShape] }
    expect(isDirty(draft, saved, '')).toBe(false)
    expect(isDirty({ ...saved, models: [{ ...sameShape, vision: true }] }, saved, '')).toBe(true)
    expect(isDirty({ ...saved, models: [] }, saved, '')).toBe(true)
    // 只比较 trim 后的值：纯空格差异不算改动，真改了（含末尾多一个 /）就算
    expect(isDirty({ ...saved, baseUrl: '  https://api.example.com/v1  ' }, saved, '')).toBe(false)
    expect(isDirty({ ...saved, baseUrl: 'https://api.example.com/v1/' }, saved, '')).toBe(true)
    expect(isDirty({ ...saved, baseUrl: 'https://other.example.com/v1' }, saved, '')).toBe(true)
    expect(isDirty({ ...saved, enabled: false }, saved, '')).toBe(true)
    // 正在输入的新 Key 也算未保存的修改
    expect(isDirty(draft, saved, 'sk-typing')).toBe(true)
    // 清除已存 Key：apiKeySet 变 false 就是脏
    expect(isDirty({ ...draft, apiKeySet: false }, saved, '')).toBe(true)
    // 「未指定」与显式 auto 在服务端是两种落盘结果，不能抹平成一件事
    const unspecified = {
      ...saved,
      models: [{ id: 'm1', enabled: true, contextWindow: 0, vision: false }],
    }
    expect(isDirty(draft, unspecified, '')).toBe(true)
  })
})
