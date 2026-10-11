import { describe, expect, it } from 'vitest'
import type { CenterOfficialServiceCatalog } from '@aurora/shared'
import {
  normalizeImageSize,
  normalizeTtsFormat,
  resolveOfficialModelEntry,
  withOfficialImageGenModel,
  withOfficialSttModel,
  withOfficialTtsModel,
} from './official-selection.js'

function service(
  models: CenterOfficialServiceCatalog['models'],
  defaultModel: string,
): CenterOfficialServiceCatalog {
  return { type: 'openai-compat', defaultModel, models }
}

describe('resolveOfficialModelEntry', () => {
  it('目录缺席返回 undefined', () => {
    expect(resolveOfficialModelEntry(undefined, 'm1')).toBeUndefined()
  })

  it('空目录返回 undefined', () => {
    expect(resolveOfficialModelEntry(service([], ''), 'm1')).toBeUndefined()
  })

  it('选中项命中目录：用它且不算回落', () => {
    const resolved = resolveOfficialModelEntry(service([{ id: 'm1' }, { id: 'm2' }], 'm1'), 'm2')
    expect(resolved?.entry.id).toBe('m2')
    expect(resolved?.fellBack).toBe(false)
  })

  it('未选择（空串）回落 defaultModel，不算回落', () => {
    const resolved = resolveOfficialModelEntry(service([{ id: 'm1' }, { id: 'm2' }], 'm2'), '')
    expect(resolved?.entry.id).toBe('m2')
    expect(resolved?.fellBack).toBe(false)
  })

  it('所选模型被下线：回落 defaultModel 并标记 fellBack', () => {
    const resolved = resolveOfficialModelEntry(service([{ id: 'm1' }, { id: 'm2' }], 'm1'), 'gone')
    expect(resolved?.entry.id).toBe('m1')
    expect(resolved?.fellBack).toBe(true)
  })

  it('defaultModel 不在开放列表时取首个模型', () => {
    const resolved = resolveOfficialModelEntry(service([{ id: 'm1' }], 'missing'), '')
    expect(resolved?.entry.id).toBe('m1')
  })
})

describe('参数归一化（与 syncProviders 镜像同口径）', () => {
  it('尺寸白名单外回落 1024x1024', () => {
    expect(normalizeImageSize('512x512')).toBe('512x512')
    expect(normalizeImageSize('auto')).toBe('auto')
    expect(normalizeImageSize('999x999')).toBe('1024x1024')
    expect(normalizeImageSize(undefined)).toBe('1024x1024')
  })

  it('音频格式白名单外回落 mp3', () => {
    expect(normalizeTtsFormat('wav')).toBe('wav')
    expect(normalizeTtsFormat('ogg')).toBe('mp3')
    expect(normalizeTtsFormat(undefined)).toBe('mp3')
  })
})

describe('withOfficial* 覆写', () => {
  it('生图：写 model 与 size，不改原对象', () => {
    const provider = {
      type: 'openai-compat',
      baseUrl: 'https://x',
      apiKeyEnc: '',
      model: 'old',
      size: 'auto',
    } as const
    const next = withOfficialImageGenModel(provider, { id: 'new', size: '768x768' })
    expect(next.model).toBe('new')
    expect(next.size).toBe('768x768')
    expect(provider.model).toBe('old')
  })

  it('生图：条目尺寸非法回落白名单', () => {
    const provider = {
      type: 'openai-compat',
      baseUrl: 'https://x',
      apiKeyEnc: '',
      model: 'old',
      size: 'auto',
    } as const
    expect(withOfficialImageGenModel(provider, { id: 'new', size: 'bogus' }).size).toBe('1024x1024')
  })

  it('TTS：写 model / voice / speed / format', () => {
    const provider = {
      type: 'openai-compat',
      baseUrl: 'https://x',
      apiKeyEnc: '',
      model: 'old',
      voice: 'alloy',
      speed: 1,
      format: 'mp3',
    } as const
    const next = withOfficialTtsModel(provider, {
      id: 'new',
      voice: 'nova',
      speed: 1.5,
      format: 'wav',
    })
    expect(next).toMatchObject({ model: 'new', voice: 'nova', speed: 1.5, format: 'wav' })
    expect(provider.voice).toBe('alloy')
  })

  it('TTS：条目缺字段按镜像口径回退（voice 空串 / speed 1 / format mp3）', () => {
    const provider = {
      type: 'dashscope',
      baseUrl: 'https://x',
      apiKeyEnc: '',
      model: 'old',
      voice: 'alloy',
      speed: 2,
      format: 'wav',
    } as const
    const next = withOfficialTtsModel(provider, { id: 'new' })
    expect(next).toMatchObject({ voice: '', speed: 1, format: 'mp3' })
  })

  it('STT：写 model 与 language，缺省 zh', () => {
    const provider = {
      type: 'openai-compat',
      baseUrl: 'https://x',
      apiKeyEnc: '',
      model: 'old',
      language: 'zh',
    } as const
    expect(withOfficialSttModel(provider, { id: 'new', language: 'en' })).toMatchObject({
      model: 'new',
      language: 'en',
    })
    expect(withOfficialSttModel(provider, { id: 'new' }).language).toBe('zh')
  })
})
