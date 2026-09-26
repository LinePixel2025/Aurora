/**
 * 项目级指令的**取用器**（docs/06 §5.1）。
 *
 * 装配层在「每轮组装系统提示词」时调一次取用器，拿到的文本直接拼进提示词；
 * 取用器自己负责两件事：
 * 1. **按 mtime 缓存**：同一项目根且文件签名未变时复用上一轮文本，
 *    连 `readFile` 都不做（长会话里每轮都读盘是纯粹的浪费）；
 * 2. **永不抛错**：无项目 / 收集结果为空 / 任何异常都返回 `undefined`（该轮不注入），
 *    失败只记一条 warn —— 项目约定读不到不该让整轮对话失败。
 *
 * 缓存按 `root` 隔离：切换项目立即换缓存条目（`Map` 里各留一份，切回来还能命中）。
 */
import { createNoopLogger, type Logger } from '@aurora/shared'
import { collectProjectInstructions } from './agentsFile.js'
import type { ProjectFs } from './agentsFile.js'

/** 取用器的数据来源（全部**同步**取当前值，装配层在每轮开始时调用） */
export interface ProjectInstructionsSource {
  fs: ProjectFs
  logger?: Logger
  /** 同步取当前项目根（绝对路径）；无项目返回 undefined */
  resolveRoot(): string | undefined
  /** 同步取当前工作目录（绝对路径），作为逐层收集的下界 */
  resolveCwd(): string
  /** 同步取字节预算；返回 undefined 用默认 */
  resolveMaxBytes?(): number | undefined
}

/**
 * 造一个「每轮取项目级 `AGENTS.md` 注入文本」的取用器（docs/06 §5.1）。
 *
 * 同一项目根且文件 mtime 未变时复用缓存文本（连 readFile 都不做）；
 * 无项目 / 收集结果为空 / 抛错时返回 `undefined`（**永不抛错**，失败只记 warn）。
 */
export function createProjectInstructionsSource(
  source: ProjectInstructionsSource,
): () => Promise<string | undefined> {
  const logger = source.logger ?? createNoopLogger()
  /** root → 上一轮的「签名 + 文本」；按 root 隔离，切换项目不会串味 */
  const cache = new Map<string, { signature: string; text: string }>()

  return async (): Promise<string | undefined> => {
    const root = source.resolveRoot()
    if (root === undefined) return undefined // 无项目：不碰缓存，也不记日志（正常情况）

    const cwd = source.resolveCwd()
    const maxBytes = source.resolveMaxBytes?.()
    const previous = cache.get(root)

    let result: Awaited<ReturnType<typeof collectProjectInstructions>>
    try {
      result = await collectProjectInstructions({
        root,
        cwd,
        fs: source.fs,
        logger,
        maxBytes,
        previous,
      })
    } catch (error) {
      // 收集器自己永不抛错，这里是最后一道保险（例如注入的 fs 实现抛了意外异常）
      logger.warn('项目级 AGENTS.md 收集失败，本轮不注入', { root, error: describeError(error) })
      return undefined
    }

    for (const warning of result.warnings) {
      // 单条候选的缺失 / 跳过属于**正常降级**，用 debug 记（否则没有 AGENTS.md 的项目每轮都刷 warn）
      logger.debug('项目级 AGENTS.md 降级', { root, warning })
    }

    if (result.text === '') {
      cache.delete(root) // 没有可注入的内容：清掉旧签名，下次从头探测
      return undefined
    }

    cache.set(root, { signature: result.signature, text: result.text })
    return result.text
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
