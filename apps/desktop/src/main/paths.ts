/**
 * ClassRoom Mode 的路径解析（docs/05 §2 ③、docs/05 §3.2）。
 *
 * 单独成文件的原因：分类管线（`classify/paths.ts`）、自动化的「打开科目文件夹」操作组件
 * 与 IPC 的 `app:openPath` 必须用**同一套**规则解析「科目（或兜底目录）→ 目标目录」，
 * 否则会出现"分类移到 A、点开却打开 B"这类不一致。
 *
 * 纯函数、不依赖 Electron，可单测。
 */
import { isAbsolute, join } from 'node:path'

/**
 * 相对路径按感知文件夹解析；绝对路径（盘符 / 正斜杠 / UNC）原样返回；
 * `watchDir` 为空（尚未配置）时相对路径原样返回，由调用方决定如何处理。
 */
export function resolveSubjectFolder(watchDir: string, folder: string): string {
  const trimmed = folder.trim()
  if (trimmed === '') return ''
  if (isAbsolute(trimmed)) return trimmed
  if (watchDir.trim() === '') return trimmed
  return join(watchDir, trimmed)
}
