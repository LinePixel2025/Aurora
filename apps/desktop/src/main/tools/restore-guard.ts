/**
 * 快照回滚的写入守卫（docs/06 §11.8，P2-07）。
 *
 * 为什么单列一个模块：`restoreSnapshot`（`ipc.ts`）此前直接用 `nodeFs.writeFile` 写回快照路径——
 * **跟随符号链接**、也不做项目根边界校验，file-port 六个方法都过的 `resolveWithin`
 * （realpath 最近存在父目录 + 前缀判定）被整段旁路，而函数头注释却写着「路径仍然过项目根边界」。
 * 这里把两条守卫收敛成**一处**：边界判定**复用** file-port 的 `resolveWithin`（不另立第二套口径），
 * 外加一条回滚特有的 `lstat` 符号链接拒绝，并把写回改成 tmp + rename 的原子写。
 *
 * 本文件**不 import electron**，因此能进 vitest（`restore-guard.test.ts`，Node + 真实临时目录）。
 */
import { lstat, rename, rm, writeFile } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { resolve } from 'node:path'
import { resolveWithin, type WorkspaceGuardOptions } from './file-port.js'

/**
 * 「目标已是符号链接 / junction」的拒绝码。
 *
 * 与 `PATH_OUTSIDE_CODE` 分开：越界是**边界**问题（用户配了项目根），这个是回滚**自身**的
 * 拒绝（无论边界配没配都成立）。调用方据 `code` 决定回错误码（两者都按 `E_INVALID_ARGUMENT`
 * 如实报给渲染层，而不是当 IO 失败）。
 */
export const RESTORE_PATH_REJECTED_CODE = 'E_RESTORE_PATH_REJECTED'

/** 回滚路径被拒的错误（`code` 固定为 `RESTORE_PATH_REJECTED_CODE`） */
export interface RestorePathRejectedError extends Error {
  code: typeof RESTORE_PATH_REJECTED_CODE
}

/** 拒绝判定：唯一识别方式是错误上的 `code`（message 只给人看） */
export function isRestorePathRejectedError(error: unknown): error is RestorePathRejectedError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === RESTORE_PATH_REJECTED_CODE
  )
}

/**
 * 回滚守卫的可注入面。
 *
 * `guard` 与 file-port 的 `workspaceRoot` guard 是**同一个对象**（装配层注入
 * `sessionProjects.boundaryRoot`），因此边界根按**快照所属会话**现解析（会话绑定项目 >
 * 空间目录 > 全局当前项目 > 激活模式工作目录）。
 */
export interface RestoreGuardOptions {
  /** 项目根边界 guard；未注入 = 不做边界校验（与 `resolveWithin` 同款语义） */
  guard?: WorkspaceGuardOptions
  /** 快照所属会话 id（边界根按会话解析，docs/06 §5.1） */
  sessionId?: string
}

/**
 * 写回前的守卫：`lstat` 拒符号链接 + 项目根 realpath 前缀校验。
 *
 * ## 为什么必须拒绝符号链接（而不是"跟随链接写回去"）
 * 快照创建时目标还是项目根内的普通文件；此后它可能被替换成指向根外的符号链接 / junction
 * （`run_command` 在 confirm 档弹卡后能建 junction，用户也可能手动放一个）。直接写回会：
 * ① 把内容写到链接指向的**根外任意位置**（file-port 的 `resolveWithin` 防线被旁路）；
 * ② 若走 tmp + rename，则把用户的软链**替换**成普通文件 —— 静默改写语义。
 * 两条都不能接受，所以一律拒绝。判定必须用 `lstat`：跟随链接的 `stat` 会把它看成普通文件。
 *
 * ## 边界判定与新建场景
 * 边界**复用** `resolveWithin`（与 file-port / run_command 同一条链）：目标还不存在时
 * （`exists: false` 的快照回滚 = 删除后可能再新建、或写回前目标已被删）它按
 * 「最近存在的父目录」做 realpath 再拼回尾部 —— 只看字符串前缀挡不住 junction。
 * 根不可解析（没配 / 配了但目录不存在）时 `resolveWithin` 静默放行，与 file-port 逐字一致。
 *
 * @returns 校验通过的**解析后绝对路径**（形态与 `resolveWithin` 的返回一致：`resolve(path)`，
 *          不是 realpath 形态 —— 回带路径与用户存入快照时看到的一致）。
 * @throws `PATH_OUTSIDE_CODE`（越界，来自 `resolveWithin`）或 `RESTORE_PATH_REJECTED_CODE`（符号链接）。
 */
export async function assertRestorablePath(
  path: string,
  options: RestoreGuardOptions = {},
): Promise<string> {
  const target = resolve(path)
  const guard = options.guard
  // 没注入边界根 = 不做任何校验，行为与 file-port 未配根时逐字一致
  if (guard === undefined || guard.workspaceRoot === undefined) return target

  const info = await lstatOrUndefined(target)
  if (info?.isSymbolicLink() === true) {
    throw createRejected(
      target,
      '目标已被替换为符号链接 / junction，已拒绝按该路径写回快照（请先移除链接，或改用链接指向的真实路径）',
    )
  }

  return resolveWithin(target, false, guard, options.sessionId)
}

/**
 * 原子写回快照内容（同目录临时文件 + rename）。
 *
 * 两处都是**有意**的：
 * - 不用裸 `writeFile`：中途崩溃会留下**半截文件**（比没有回滚更糟：用户以为回滚成功了）；
 * - 不用「先删后写」：删除与写入之间失败就是内容彻底丢失。
 *
 * `rename` 覆盖的是**目录项本身**（不是链接目标），因此即便校验与写入之间被塞进一个链接，
 * 结果也只是把那个目录项替换掉 —— 不会写到链接指向的位置。
 */
export async function writeRestoredFile(path: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(tmp, bytes)
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

/** 目标不存在（ENOENT）时返回 undefined：符号链接判定与边界判定各管一段，不在读态上抛错 */
async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path)
  } catch {
    return undefined
  }
}

/** 拒绝错误：message 里带目标路径（**拒绝不静默**），并带上可识别的 `code` */
function createRejected(target: string, message: string): RestorePathRejectedError {
  const error = new Error(`${message}（目标：${target}）`) as RestorePathRejectedError
  error.code = RESTORE_PATH_REJECTED_CODE
  return error
}
