/**
 * 脱敏主体（docs/08 §1.1）：只依赖 `SettingsStoreLike`（取凭据"是否已设置"），
 * `settings:get` / `settings:changed` 广播（`ipc.ts`）与 `set_setting` 端口
 * （`tools/settings-port.ts`）复用**同一份**逻辑，不会出现"两处脱敏，改一处漏一处"。
 *
 * 本文件不 import electron —— `settings-port.ts` 的单测要进 vitest
 * （vitest 只收不 import 'electron' 的主进程测试），故从 `ipc.ts` 拆出。
 *
 * **凭据 checklist**：`llm` / `tts` / `stt` / `imagegen` 四组 provider 的密文都在这里折成
 * `apiKeySet` 标记，MCP 服务器的 `envEnc` / `headersEnc` 折成 `envSet` / `headersSet` 名单
 * ——漏掉任何一组 = 该组密文随 `settings:get` 泄漏进渲染层（AGENTS.md）。
 */
import type { Settings } from '@aurora/shared'
import type { SettingsStoreLike } from './contracts.js'

export function redactSettings(settings: SettingsStoreLike, source: Settings): Settings {
  const clone = structuredClone(source)
  const providerGroups = [
    { providers: clone.llm.providers, prefix: 'llm' },
    { providers: clone.tts.providers, prefix: 'tts' },
    { providers: clone.stt.providers, prefix: 'stt' },
    { providers: clone.imagegen.providers, prefix: 'imagegen' },
  ] as const
  for (const { providers, prefix } of providerGroups) {
    for (const [id, provider] of Object.entries(providers)) {
      const draft = provider as unknown as Record<string, unknown>
      draft['apiKeySet'] = settings.getSecret(`${prefix}.providers.${id}.apiKey`) !== ''
      draft['apiKeyEnc'] = ''
    }
  }
  for (const server of clone.mcp.servers) {
    const draft = server as unknown as Record<string, unknown>
    const env = (server as unknown as { envEnc?: Record<string, string> }).envEnc ?? {}
    draft['envSet'] = Object.keys(env)
    draft['envEnc'] = {}
    const headers = (server as unknown as { headersEnc?: Record<string, string> }).headersEnc ?? {}
    draft['headersSet'] = Object.keys(headers)
    draft['headersEnc'] = {}
  }
  return clone
}
