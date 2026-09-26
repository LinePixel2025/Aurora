/**
 * `ProjectFs` 的**真实文件系统**实现（docs/06 §5.1）。
 *
 * 为什么用 `lstat` 而不是 `stat`：只有 `lstat` 能识别符号链接 ——
 * 项目里的 `AGENTS.md` 若是指向仓库外的软链，收集器必须跳过它（不跟随），
 * `stat` 会跟随后把它当成普通文件放行。
 *
 * 文件不存在 / 无权限时**照常抛错**（由调用方 `collectProjectInstructions` 捕获并降级），
 * 这里不做任何吞异常处理。
 */
import { lstat, readFile } from 'node:fs/promises'
import type { ProjectFs, ProjectStat } from './agentsFile.js'

/** 真实 fs 的 `ProjectFs` 实现（docs/06 §5.1） */
export const nodeProjectFs: ProjectFs = {
  /** 读 utf8 文本；二进制判定（含 NUL）在收集器一侧做 */
  readFile(path: string): Promise<string> {
    return readFile(path, 'utf8')
  },

  /** `lstat` → 普通字段（`Stats` 的谓词与 mtime / size 都是方法或 getter，跨端口只传数据） */
  async stat(path: string): Promise<ProjectStat> {
    const stats = await lstat(path)
    return {
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      isSymbolicLink: stats.isSymbolicLink(),
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    }
  },
}
