/**
 * 快照回滚守卫的单测（docs/06 §11.8，P2-07）。
 *
 * 用 `os.tmpdir()` 下的真实临时目录（每个用例一个随机目录，`afterEach` 递归删除）：
 * 守卫的三条判据（符号链接拒绝、realpath 前缀、最近存在父目录）**只有真实文件系统**验得出来，
 * 纯 mock 出来的 `lstat` / `realpath` 只是在测自己写的桩。本文件不 import electron，
 * 因此能进 vitest 的 Node 环境。
 *
 * 覆盖：根内常规路径放行、根内**不存在**的新路径放行、目标已是符号链接 → 拒绝、
 * 目标不存在但最近存在父目录是指向根外的 junction → 拒绝、明显落在根外 → 拒绝、
 * 未配根时一律放行（与 `resolveWithin` 同款语义）、以及 `writeRestoredFile` 的 tmp + rename 原子写。
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryLogger } from '@aurora/shared'
import { PATH_OUTSIDE_CODE } from './file-port.js'
import {
  RESTORE_PATH_REJECTED_CODE,
  assertRestorablePath,
  isRestorePathRejectedError,
  writeRestoredFile,
} from './restore-guard.js'

let root = ''
/** 根**之外**的真实目录（与 `root` 同级，互为兄弟，谁也不包含谁） */
let outside = ''

beforeAll(async () => {
  outside = await fs.mkdtemp(join(tmpdir(), 'aurora-restore-outside-'))
})

afterAll(async () => {
  if (outside !== '') await fs.rm(outside, { recursive: true, force: true, maxRetries: 3 })
  outside = ''
})

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'aurora-restore-root-'))
})

afterEach(async () => {
  if (root !== '') await fs.rm(root, { recursive: true, force: true, maxRetries: 3 })
  root = ''
})

/** 取错误（而不是断言抛）：越界与拒绝都是"正常返回的错误"，不是测试框架的异常 */
async function failureOf(call: () => Promise<unknown>): Promise<NodeJS.ErrnoException> {
  const error = await call().then(
    () => undefined,
    (reason: unknown) => reason as NodeJS.ErrnoException,
  )
  expect(error).toBeDefined()
  return error as NodeJS.ErrnoException
}

/** 与 file-port.test.ts 同款：建不出链接时把两边的失败原因拼成一句话 */
function describeLinkError(...errors: unknown[]): string {
  return errors
    .map((error) => {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (typeof code === 'string') return code
      return error instanceof Error ? error.message : String(error)
    })
    .join(' / ')
}

/**
 * 在 `root` 下建一个指向 `outside` 的目录链接（junction 兜底：Windows 上 junction 不需要管理员）。
 * 环境建不出来时返回原因串（调用方据此 `ctx.skip()`，**不许静默通过**）。
 */
async function linkOutsideIntoRoot(linkPath: string): Promise<string> {
  try {
    await fs.symlink(outside, linkPath, 'dir')
    return ''
  } catch (dirError) {
    try {
      await fs.symlink(outside, linkPath, 'junction')
      return ''
    } catch (junctionError) {
      return describeLinkError(dirError, junctionError)
    }
  }
}

describe('assertRestorablePath：项目根 realpath 前缀校验', () => {
  it('根内常规路径放行，回带路径与存入快照时看到的一致（resolve 形态）', async () => {
    const guard = { workspaceRoot: () => root }
    const file = join(root, 'note.txt')
    await fs.writeFile(file, 'V1', 'utf8')

    expect(await assertRestorablePath(file, { guard })).toBe(resolve(file))
  })

  it('目标还不存在（exists:false 快照回滚的新建场景）同样放行', async () => {
    const guard = { workspaceRoot: () => root }
    const missing = join(root, 'deep', 'not-created-yet.txt')

    expect(await assertRestorablePath(missing, { guard })).toBe(resolve(missing))
  })

  it('明显落在根外：拒绝，code = E_PATH_OUTSIDE_WORKSPACE', async () => {
    const guard = { workspaceRoot: () => root }
    const escaped = join(outside, 'escaped.txt')

    const error = await failureOf(() => assertRestorablePath(escaped, { guard }))
    expect(error.code).toBe(PATH_OUTSIDE_CODE)
    expect(error.message).toContain('该路径在项目根之外')
  })

  it('`..` 穿越（字符串层面仍在根下）同样被 realpath 判定拒绝', async () => {
    const guard = { workspaceRoot: () => root }
    const traversed = join(root, '..', basename(outside), 'escaped.txt')

    const error = await failureOf(() => assertRestorablePath(traversed, { guard }))
    expect(error.code).toBe(PATH_OUTSIDE_CODE)
  })

  it('目标本身就是符号链接：拒绝，且**不跟随**（环境建不了链接时明确跳过）', async (ctx) => {
    const guard = { workspaceRoot: () => root }
    const secret = join(outside, 'secret.txt')
    await fs.writeFile(secret, 'secret\n', 'utf8')
    // 文件级链接：直接指向根外的文件
    const link = join(root, 'link-file.txt')
    let linkError = ''
    try {
      await fs.symlink(secret, link, 'file')
    } catch (error) {
      linkError = describeLinkError(error)
    }
    if (linkError !== '') {
      console.warn(`跳过「目标是符号链接」用例：当前环境建不了符号链接（${linkError}）`)
      ctx.skip()
      return
    }

    const error = await failureOf(() => assertRestorablePath(link, { guard }))
    expect(error.code).toBe(RESTORE_PATH_REJECTED_CODE)
    expect(isRestorePathRejectedError(error)).toBe(true)
    expect(error.message).toContain('符号链接')
    // 拒绝 = 什么都没做：链接与它指向的内容都没被改动
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(secret, 'utf8')).toBe('secret\n')
  })

  it('目标不存在、最近存在父目录是指向根外的 junction：按 realpath 判定拒绝', async (ctx) => {
    const guard = { workspaceRoot: () => root }
    const link = join(root, 'link-outside')
    const linkError = await linkOutsideIntoRoot(link)
    if (linkError !== '') {
      // 明确跳过并打印原因：否则看起来像"最近存在父目录判定已被覆盖"
      console.warn(`跳过「最近存在父目录是根外链接」用例：当前环境建不了链接（${linkError}）`)
      ctx.skip()
      return
    }

    // 目标本身**不存在**（lstat 会 ENOENT，符号链接判定不命中），
    // 但逐级上溯到的第一个存在祖先 `link` 是指向根外的 junction —— 必须靠 realpath 拦下
    const target = join(link, 'new.txt')
    const error = await failureOf(() => assertRestorablePath(target, { guard }))
    expect(error.code).toBe(PATH_OUTSIDE_CODE)
  })

  it('未注入根 / 根解析不出：一律放行（与 resolveWithin 同款语义，行为与从前一致）', async () => {
    const target = join(outside, 'allowed.txt')

    // ① 完全没注入 guard
    expect(await assertRestorablePath(target)).toBe(resolve(target))
    // ② 注入了 guard 但 workspaceRoot 缺席（装配层未接上边界）
    expect(await assertRestorablePath(target, { guard: {} })).toBe(resolve(target))
    // ③ 根目录还不存在：退回"无边界"并留一条 warn（项目目录没建好不该让回滚整体失效）
    const logger = createMemoryLogger()
    const missingRoot = join(root, 'not-created-yet')
    expect(
      await assertRestorablePath(target, { guard: { workspaceRoot: () => missingRoot, logger } }),
    ).toBe(resolve(target))
    expect(logger.entries.some((line) => line.includes('项目根不可用'))).toBe(true)
    // ④ workspaceRoot 返回空串 = 未配置（与 ports 的既有口径一致）
    expect(await assertRestorablePath(target, { guard: { workspaceRoot: () => '' } })).toBe(
      resolve(target),
    )
  })
})

describe('writeRestoredFile：tmp + rename 原子写', () => {
  it('写回内容与字节一致，覆盖既有文件（不是追加、也不留 .tmp 残留）', async () => {
    const file = join(root, 'note.txt')
    await fs.writeFile(file, 'CURRENT-LONGER-CONTENT', 'utf8')

    const bytes = new TextEncoder().encode('V1')
    await writeRestoredFile(file, bytes)

    expect(await fs.readFile(file, 'utf8')).toBe('V1')
    const leftovers = (await fs.readdir(root)).filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('目录不存在时抛错（由调用方补 mkdir），且不留下半截文件', async () => {
    const file = join(root, 'missing-dir', 'note.txt')
    await expect(writeRestoredFile(file, new TextEncoder().encode('V1'))).rejects.toThrow()
    await expect(fs.stat(file)).rejects.toThrow()
  })

  it('二进制字节逐字节保真（不经过 UTF-8 往返）', async () => {
    const file = join(root, 'bytes.bin')
    const bytes = Uint8Array.from([0x00, 0xff, 0x80, 0x41])

    await writeRestoredFile(file, bytes)

    expect(Array.from(await fs.readFile(file))).toEqual([0x00, 0xff, 0x80, 0x41])
  })
})
