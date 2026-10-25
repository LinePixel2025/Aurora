/**
 * 插件面板中继的错误码 → 界面文案（声明式面板与页面型 iframe 共用）。
 *
 * 服务器 / 客户端回的都是稳定错误码，直接抛给用户看不懂；未知码原样返回，
 * 便于排障时不丢信息。
 */
export function pluginErrorText(raw: string): string {
  if (raw.startsWith('E_REMOTE_DISABLED')) return '设备已关闭「允许 Center 远程操作」'
  if (raw === 'E_CLIENT_OFFLINE') return '设备已离线，无法调用插件面板'
  if (raw === 'E_PANEL_NOT_FOUND') return '该设备上已没有此插件面板（插件被卸载或停用）'
  if (raw === 'E_UNSUPPORTED') return '该设备不支持插件面板中继（客户端版本过旧）'
  if (raw === 'E_CLIENT_NOT_FOUND') return '设备不存在或已解绑'
  if (raw === 'E_FORBIDDEN') return '无权访问该设备的插件面板'
  if (raw === 'E_RATE_LIMITED') return '操作过于频繁，请稍后再试'
  if (raw === 'E_RESULT_TOO_LARGE') return '插件返回内容过大，已中止'
  if (raw === 'E_INVALID_ARGUMENT') return '请求参数不合法（可能超出大小上限）'
  if (raw.startsWith('E_INVALID_SCHEMA')) return `面板 schema 非法：${raw.slice(17).trim()}`
  if (raw === 'E_CLIENT_TIMEOUT' || raw === 'E_TIMEOUT') return '插件响应超时'
  return raw
}
