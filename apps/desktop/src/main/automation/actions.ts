/**
 * 操作组件执行器（docs/13 §5）。Normal Mode 的**封闭能力集**：
 * 系统通知 / ClassIsland 提醒 / 打开文件夹 / 打开网址 / 打开应用 —— 没有命令、没有任意写，
 * 自动化的无人值守面被限制在这几个预设能力上（要更强走 Agent Mode 的权限链）。
 *
 * 纯 Node：系统能力全部经 port 注入，可完整单测。失败一律返回 `{ ok: false, error }`
 * 绝不抛错 —— 单个操作的失败不阻断后续操作，也不能拖垮引擎 tick。
 */
import type { AutomationAction } from '@aurora/shared'
import type { ClassIslandNotifyRequest } from '@aurora/shared'
import type { Logger } from '@aurora/shared'
import { resolveSubjectFolder } from '../paths.js'
import { isWebUrl } from './catalog.js'

/** 注入的系统能力端口（主进程装配时接线，docs/13 §3） */
export interface AutomationActionPorts {
  /** 系统通知（`NotificationService.notify`；返回 false = 载体不可用或被去重） */
  notify(request: { title: string; body: string; openPath?: string }): boolean
  /** ClassIsland 提醒通道；未配置桥接时 `available()` 为 false */
  classisland: {
    available(): boolean
    notify(request: ClassIslandNotifyRequest): Promise<{ ok: boolean; error?: string }>
  }
  /** 打开路径（`shell.openPath`） */
  openPath(target: string): Promise<void>
  /** 用系统默认浏览器打开 URL（`shell.openExternal`；仅 http(s)，协议白名单在执行器里校验） */
  openExternal(url: string): Promise<void>
  /** 科目名 → 科目文件夹绝对路径（空串 = 未映射，复用 `paths.resolveSubjectFolder` 链） */
  resolveSubjectDir(subjectName: string): string
  logger: Logger
}

export interface ActionExecutionResult {
  ok: boolean
  error?: string
  /** 给日志 / 审计的一句话摘要（**不进** Normal 历史记录） */
  summary: string
}

export async function executeAction(
  action: AutomationAction,
  ports: AutomationActionPorts,
): Promise<ActionExecutionResult> {
  const params = isRecord(action.params) ? action.params : {}
  switch (action.kind) {
    case 'system-notify':
      return executeSystemNotify(params, ports)
    case 'classisland-remind':
      return await executeClassislandRemind(params, ports)
    case 'open-folder':
      return await executeOpenFolder(params, ports)
    case 'open-url':
      return await executeOpenUrl(params, ports)
    case 'open-app':
      return await executeOpenApp(params, ports)
    default:
      return { ok: false, error: `不支持的操作组件：${String(action.kind)}`, summary: '' }
  }
}

function executeSystemNotify(
  params: Record<string, unknown>,
  ports: AutomationActionPorts,
): ActionExecutionResult {
  const title = readString(params['title'], '自动化通知')
  const body = readString(params['body'], '')
  const openPath = readString(params['openPath'], '')
  const shown = ports.notify({
    title,
    body,
    openPath: openPath === '' ? undefined : openPath,
  })
  return {
    ok: true,
    summary: shown
      ? `已发系统通知「${title}」`
      : `系统通知「${title}」未展示（被去重或载体不可用）`,
  }
}

async function executeClassislandRemind(
  params: Record<string, unknown>,
  ports: AutomationActionPorts,
): Promise<ActionExecutionResult> {
  if (!ports.classisland.available()) {
    return { ok: false, error: '尚未配置 ClassIsland 桥接端点', summary: '' }
  }
  const channel = params['channel']
  const request: ClassIslandNotifyRequest = {
    title: readString(params['title'], '自动化提醒'),
    body: readString(params['body'], ''),
    channel:
      channel === 'class-started' || channel === 'pre-class' || channel === 'custom'
        ? channel
        : 'custom',
  }
  const result = await ports.classisland.notify(request)
  return result.ok
    ? { ok: true, summary: `已发 ClassIsland 提醒「${request.title}」` }
    : { ok: false, error: result.error ?? 'ClassIsland 提醒失败', summary: '' }
}

async function executeOpenFolder(
  params: Record<string, unknown>,
  ports: AutomationActionPorts,
): Promise<ActionExecutionResult> {
  const target = params['target']
  let dir = ''
  if (target === 'subject') {
    const subject = readString(params['subject'], '')
    if (subject.trim() === '') {
      return { ok: false, error: '未指定科目名', summary: '' }
    }
    try {
      dir = ports.resolveSubjectDir(subject.trim()).trim()
    } catch (error) {
      ports.logger.warn('自动化解析科目目录失败', { subject, error: String(error) })
      dir = ''
    }
    if (dir === '') {
      return { ok: false, error: `科目「${subject}」未映射文件夹`, summary: '' }
    }
  } else if (target === 'path') {
    dir = readString(params['path'], '').trim()
    if (dir === '') return { ok: false, error: '未指定文件夹路径', summary: '' }
  } else {
    return { ok: false, error: `未知的目标类型：${String(target)}`, summary: '' }
  }
  try {
    await ports.openPath(dir)
  } catch (error) {
    return { ok: false, error: `打开文件夹失败：${String(error)}`, summary: '' }
  }
  return { ok: true, summary: `已打开 ${dir}` }
}

/**
 * 打开网址（open-url）：协议白名单只放 http / https —— `file:` / 自定义协议
 * （`ms-settings:` 之类）一律拒绝，防 URL 字段变成协议逃逸面（docs/13 §5）。
 */
async function executeOpenUrl(
  params: Record<string, unknown>,
  ports: AutomationActionPorts,
): Promise<ActionExecutionResult> {
  const url = readString(params['url'], '').trim()
  if (url === '') return { ok: false, error: '未指定网址', summary: '' }
  if (!isWebUrl(url)) {
    return { ok: false, error: `仅支持 http(s) 网址：${url}`, summary: '' }
  }
  try {
    await ports.openExternal(url)
  } catch (error) {
    return { ok: false, error: `打开网址失败：${String(error)}`, summary: '' }
  }
  return { ok: true, summary: `已在默认浏览器打开 ${url}` }
}

/**
 * 打开应用（open-app）：走 `openPath` 端口（`shell.openPath`，单一路径参数、
 * 不经 shell —— 不存在参数拼接的注入面）。应用路径只来自用户在 UI 里的配置
 * （automations.* 是 AI 只读前缀），执行器只兜底拦空值。
 */
async function executeOpenApp(
  params: Record<string, unknown>,
  ports: AutomationActionPorts,
): Promise<ActionExecutionResult> {
  const path = readString(params['path'], '').trim()
  if (path === '') return { ok: false, error: '未指定应用路径', summary: '' }
  try {
    await ports.openPath(path)
  } catch (error) {
    return { ok: false, error: `打开应用失败：${String(error)}`, summary: '' }
  }
  return { ok: true, summary: `已打开应用 ${path}` }
}

/**
 * 科目 → 文件夹解析（主进程装配注入）：与课前提醒同一套链
 * （`resolveSubjectFolder`：绝对路径原样、相对路径拼 watchDir）。
 */
export function createSubjectDirResolver(settings: {
  watchDir: () => string
  subjects: () => ReadonlyArray<{ name: string; folder: string }>
}): (subjectName: string) => string {
  return (subjectName: string) => {
    const subject = settings.subjects().find((item) => item.name === subjectName)
    if (subject === undefined) return ''
    return resolveSubjectFolder(settings.watchDir(), subject.folder)
  }
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
