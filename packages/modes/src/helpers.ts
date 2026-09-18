/**
 * 模式实现辅助工具（纯函数，便于单测）。
 */
import { DEFAULT_SUBJECT_FOLDER_PREFIX, type Settings, type SubjectConfig } from '@aurora/shared'

export interface SubjectFolderUpdate {
  name: string
  folder: string
}

/**
 * 解析用户输入的科目列表（中文逗号 / 顿号 / 分号 / 换行都接受）。
 * 空输入返回空数组，由调用方决定是否回退默认模板。
 */
export function parseSubjectList(input: string): string[] {
  return input
    .split(/[,，、;；\n\r\t]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/** 用户未指定目标文件夹时的默认值（docs/05 §2 ③）。 */
export function defaultSubjectFolder(subject: string): string {
  return `${DEFAULT_SUBJECT_FOLDER_PREFIX}/${subject}`
}

/**
 * 把科目名与目标文件夹写回 `modes.classroom.subjects`。
 * 保留已有科目的 keywords（P4 分类规则缓存会用到）。
 */
export function upsertSubjects(
  settings: Settings,
  updates: readonly SubjectFolderUpdate[],
): SubjectConfig[] {
  const existing = new Map(settings.modes.classroom.subjects.map((item) => [item.name, item]))
  return updates.map(({ name, folder }) => {
    const previous = existing.get(name)
    return {
      name,
      folder,
      keywords: previous?.keywords ?? [],
    }
  })
}

/**
 * 校验用户填写的目录：必须是绝对路径。
 * 相对路径容易因主进程 cwd 变化而出错，因此明确拒绝。
 */
export function validateAbsolutePath(input: string): string | undefined {
  const value = input.trim()
  if (value === '') return '路径不能为空'
  const isWindowsAbsolute = /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')
  const isPosixAbsolute = value.startsWith('/')
  if (!isWindowsAbsolute && !isPosixAbsolute) {
    return '请填写绝对路径（例如 D:\\Aurora\\感知文件夹）'
  }
  return undefined
}
