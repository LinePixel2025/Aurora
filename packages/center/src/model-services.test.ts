import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ModelServicesStore } from './model-services.js'
import { createSecretBox } from './secrets.js'

const dirs: string[] = []

async function store(secret = 'master-secret') {
  const dir = await mkdtemp(join(tmpdir(), 'aurora-center-models-'))
  dirs.push(dir)
  const service = new ModelServicesStore({
    dataDir: dir,
    secrets: createSecretBox(secret),
  })
  await service.init()
  return service
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('Center 官方模型目录', () => {
  it('保存后管理端只看 apiKeySet，客户端目录只含开放模型且无上游地址', async () => {
    const service = await store()
    const saved = await service.updateService('llm', {
      enabled: true,
      type: 'openai-compat',
      baseUrl: 'https://upstream.example/v1',
      apiKey: 'sk-upstream',
      defaultModel: 'm1',
      models: [
        { id: 'm1', enabled: true, reasoningEffort: 'high', contextWindow: 128000, vision: true },
        { id: 'm2', enabled: false },
      ],
    })
    expect(saved.apiKeySet).toBe(true)
    expect(JSON.stringify(saved)).not.toContain('sk-upstream')
    expect(saved.baseUrl).toBe('https://upstream.example/v1')

    const catalog = service.catalog()
    expect(catalog.services.llm?.models.map((model) => model.id)).toEqual(['m1'])
    expect(JSON.stringify(catalog)).not.toContain('upstream.example')
    expect(JSON.stringify(catalog)).not.toContain('apiKey')
  })

  it('主密钥丢失后能力不可用且管理端给出错误', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aurora-center-models-'))
    dirs.push(dir)
    const first = new ModelServicesStore({ dataDir: dir, secrets: createSecretBox('master') })
    await first.init()
    await first.updateService('tts', {
      enabled: true,
      type: 'openai-compat',
      baseUrl: 'https://tts.example/v1',
      apiKey: 'tts-key',
      defaultModel: 'v1',
      models: [{ id: 'v1', enabled: true, voice: 'alloy', speed: 1, format: 'mp3' }],
    })

    const second = new ModelServicesStore({ dataDir: dir, secrets: createSecretBox('other') })
    await second.init()
    expect(second.resolve('tts')).toBeUndefined()
    expect(second.adminConfig().tts.error).toContain('unable')
  })
})
