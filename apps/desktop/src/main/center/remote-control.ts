/**
 * 远程控制的纯判定（docs/12 §6）。
 *
 * Center 发来的配置补丁**不走** AI 的 `set_setting` 通道，也不受
 * `SETTINGS_READONLY_PREFIXES` 管辖（那条黑名单防的是 AI 自我提权；Center 是
 * 人操作的远端）。但客户端只接受**显式白名单**内的路径（docs/12 §6.2）：
 * 白名单外的补丁整条拒绝、不部分应用 —— 否则"远程改一个合法字段 + 一个非法字段"
 * 的组合会留下半截状态。
 */
import {
  CENTER_REMOTE_CONFIG_PREFIXES,
  resolveModelParams,
  type ClientStatus,
  type Settings,
  type SttSettings,
  type TtsSettings,
} from '@aurora/shared'

export interface RemotePatchCheck {
  ok: boolean
  /** 被拒绝时的首个非法路径（供回执与审计） */
  forbiddenPath?: string
}

/** 白名单校验：按路径段前缀匹配，白名单外整条拒绝。 */
export function checkRemotePatch(patch: Record<string, unknown>): RemotePatchCheck {
  for (const path of Object.keys(patch)) {
    const allowed = (CENTER_REMOTE_CONFIG_PREFIXES as readonly string[]).some(
      (prefix) => path === prefix || path.startsWith(`${prefix}.`),
    )
    if (!allowed) return { ok: false, forbiddenPath: path }
  }
  return { ok: true }
}

/**
 * 把白名单补丁应用到一份**草稿**上（路径 → 值的扁平表）。
 * 调用方（connector 的装配）负责在 `settings.mutate` 的 mutator 里传入 draft。
 * 返回 false = 有路径在当前结构里落不下去（不该发生：白名单路径全部是 Schema 叶子）。
 */
export function applyWhitelistedPaths(draft: Settings, patch: Record<string, unknown>): boolean {
  for (const [path, value] of Object.entries(patch)) {
    const segments = path.split('.')
    // 逐段下钻；类型断言由"白名单路径全部是 Schema 叶子"保证，
    // 落不下去（中途 undefined）就整体失败
    let cursor: Record<string, unknown> = draft as unknown as Record<string, unknown>
    for (let i = 0; i < segments.length - 1; i += 1) {
      const next = cursor[segments[i] as string]
      if (typeof next !== 'object' || next === null) return false
      cursor = next as Record<string, unknown>
    }
    cursor[segments[segments.length - 1] as string] = value
  }
  return true
}

/**
 * STT 能力位（docs/12 §6.4）：与渲染层 `sttReady`（chat/App.vue）同一口径 ——
 * `enabled && active` 指向**存在**的 provider，且该 provider 的 `baseUrl` / `model`
 * 齐全。**不查 API Key**（本地 whisper 类免密钥部署同样算可用；密钥问题由转写
 * 失败的错误文案兜底）。
 */
function sttReadyOf(settings: SttSettings): boolean {
  if (!settings.enabled || settings.active === '') return false
  const provider = settings.providers[settings.active]
  if (provider === undefined) return false
  return provider.baseUrl.trim() !== '' && provider.model.trim() !== ''
}

/** TTS 能力位：与渲染层 `ttsReady` 同口径 —— 在 baseUrl / model 之上多查 `voice` 齐全。 */
function ttsReadyOf(settings: TtsSettings): boolean {
  if (!settings.enabled || settings.active === '') return false
  const provider = settings.providers[settings.active]
  if (provider === undefined) return false
  return (
    provider.baseUrl.trim() !== '' && provider.model.trim() !== '' && provider.voice.trim() !== ''
  )
}

/**
 * 语音能力位（v0.3.2，docs/12 §6.4）：connector 的语音命令门控
 * （`E_VOICE_NOT_CONFIGURED`）与 `ClientStatus.voice` 能力位**共用这一份**，
 * 别再写第二套判定。
 */
export function voiceReadiness(settings: Settings): { stt: boolean; tts: boolean } {
  return { stt: sttReadyOf(settings.stt), tts: ttsReadyOf(settings.tts) }
}

/** 客户端状态快照（连接后与每次 settings:changed 时上报，docs/12 §6.1）。 */
export function buildClientStatus(
  settings: Settings,
  version: string,
  platform: string,
): ClientStatus {
  // 生效 LLM 快照（docs/12 §6.3）：只取展示用的三个字段，凭据（apiKeyEnc / baseUrl）绝不进快照。
  // 无激活 provider（active 为空 / 指向不存在的 id）时给安全缺省 —— 空串 + 'auto'，
  // 网页端据此展示「未配置」而不是渲染出半截条目。
  const activeProvider = settings.llm.providers[settings.llm.active]
  return {
    mode: settings.modes.current,
    version,
    platform,
    agent: {
      permissionMode: resolvePermissionModeOf(settings),
      tools: {
        enabled: settings.agent.tools.enabled,
        files: settings.agent.tools.files.enabled,
        search: settings.agent.tools.search.enabled,
        open: settings.agent.tools.open.enabled,
        terminal: settings.agent.tools.terminal.enabled,
      },
    },
    center: {
      allowRemoteSession: settings.center.allowRemoteSession,
      allowRemoteConfig: settings.center.allowRemoteConfig,
      allowFileTransfer: settings.center.allowFileTransfer,
      // 本端支持随远程消息接收图片附件（2026-10-18，docs/12 §5）：网页端据此渲染粘贴入口，
      // 服务器转发前也按它与 hello 的能力位校验（旧客户端缺省 = 不支持）。
      inputAttachments: true,
    },
    llm: {
      activeProviderId: settings.llm.active,
      model: activeProvider?.model ?? '',
      // 思考等级在 v23 下沉到**模型级**（`modelParams[模型]`），口径与主进程装配层同源：
      // 缺省按 `provider.model` 取值、键未命中回落 'auto'。快照**形状不变**，
      // Center 网页端与服务器协议都不用改。
      reasoningEffort:
        activeProvider === undefined ? 'auto' : resolveModelParams(activeProvider).reasoningEffort,
    },
    // 语音能力位（v0.3.2，docs/12 §6.4）：网页端据此决定是否渲染麦克风 / 朗读按钮
    //（与桌面端同口径：未配置连按钮都不出现）
    voice: voiceReadiness(settings),
  }
}

/** 生效档位与 docs/06 §12.2 同源：confirmSensitiveTools=false 时非 readonly 档按 auto 处理 */
function resolvePermissionModeOf(settings: Settings): string {
  if (!settings.advanced.confirmSensitiveTools && settings.agent.permissionMode !== 'readonly') {
    return 'auto'
  }
  return settings.agent.permissionMode
}
