/**
 * 远程控制的纯判定（docs/12 §6）。
 *
 * Center 发来的配置补丁**不走** AI 的 `set_setting` 通道，也不受
 * `SETTINGS_READONLY_PREFIXES` 管辖（那条黑名单防的是 AI 自我提权；Center 是
 * 人操作的远端）。但客户端只接受**显式白名单**内的路径（docs/12 §6.2）：
 * 白名单外的补丁整条拒绝、不部分应用 —— 否则"远程改一个合法字段 + 一个非法字段"
 * 的组合会留下半截状态。
 */
import { CENTER_REMOTE_CONFIG_PREFIXES, type ClientStatus, type Settings } from '@aurora/shared'

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

/** 客户端状态快照（连接后与每次 settings:changed 时上报，docs/12 §6.1）。 */
export function buildClientStatus(
  settings: Settings,
  version: string,
  platform: string,
): ClientStatus {
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
    },
  }
}

/** 生效档位与 docs/06 §12.2 同源：confirmSensitiveTools=false 时非 readonly 档按 auto 处理 */
function resolvePermissionModeOf(settings: Settings): string {
  if (!settings.advanced.confirmSensitiveTools && settings.agent.permissionMode !== 'readonly') {
    return 'auto'
  }
  return settings.agent.permissionMode
}
