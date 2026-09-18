/**
 * 分类落盘（docs/05 §3.2 ③「映射与落盘」）—— 纯逻辑，文件系统操作全部注入，可独立单测。
 *
 * 策略：
 * - 目标目录不存在则创建；
 * - 重名自动加后缀 ` (1)`、` (2)`…（docs/05 §3.2「重名自动加后缀」）；
 * - 优先 `rename`（同盘瞬间完成）；失败（跨盘 `EXDEV`、被占用）回退 `copy` 并**校验大小**后删源，
 *   避免"复制不完整却删掉原文件"造成数据丢失；
 * - `autoMove: false` 时只返回目标路径、不动文件。
 */
import { dirname, extname, join, resolve } from 'node:path'

export interface ClassifyFs {
  exists(path: string): Promise<boolean>
  ensureDir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  copy(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
  /** 读取字节数；文件不存在返回 undefined */
  sizeOf(path: string): Promise<number | undefined>
}

export interface MoveOutcome {
  ok: boolean
  /** 落盘后的绝对路径（ok = true 时必定存在） */
  targetPath: string
  /** 是否实际移动了文件 */
  moved: boolean
  /** 使用的落盘方式 */
  method: 'rename' | 'copy' | 'none'
  /** 失败原因（ok = false） */
  error?: string
  warnings: string[]
}

/** 在 `dir` 内为 `fileName` 找一个不冲突的路径：`a.pdf` → `a (1).pdf` → `a (2).pdf`… */
export async function uniqueTargetPath(
  fs: ClassifyFs,
  dir: string,
  fileName: string,
  maxAttempts = 200,
): Promise<string> {
  const ext = extname(fileName)
  const stem = ext === '' ? fileName : fileName.slice(0, -ext.length)

  let candidate = join(dir, fileName)
  let attempt = 1
  while (await fs.exists(candidate)) {
    candidate = join(dir, `${stem} (${attempt})${ext}`)
    attempt += 1
    if (attempt > maxAttempts) {
      // 极端情况下退化为时间戳后缀，保证一定拿到可用路径
      candidate = join(dir, `${stem} (${Date.now()})${ext}`)
      break
    }
  }
  return candidate
}

/**
 * 目标目录是否就是感知文件夹本身。
 *
 * 为什么必须拦：`depth: 0` 只在**子目录**内移动时不触发 add，
 * 但若目标目录就是感知文件夹根，`rename(root/a.txt → root/a (1).txt)` 会触发
 * 一个新的 `add` 事件 → 再分类 → 再重命名，形成**无限循环**（磁盘被塞满 ` (1) (1)…`）。
 * 而 `SubjectSchema.folder` 只要求「非空字符串」，`"."`、`"./"`、`"a/.."` 都会解析到根目录，
 * 因此这里必须显式拒绝。
 */
export function resolvesToWatchRoot(watchDir: string, targetDir: string): boolean {
  const root = watchDir.trim()
  const target = targetDir.trim()
  if (root === '' || target === '') return false
  return resolve(root) === resolve(target)
}

/**
 * 把文件落到目标目录。
 *
 * `sourcePath` 不存在（用户已手动处理）时返回 `ok: false` 且 `moved: false`——
 * 调用方据此记一条 `skipped`，不视为错误。
 */
export async function moveInto(input: {
  fs: ClassifyFs
  sourcePath: string
  /** 目标目录（已解析为绝对路径） */
  targetDir: string
  fileName: string
  /** false 时只解析目标路径、不动文件 */
  autoMove: boolean
  /** 感知文件夹根目录：与 `targetDir` 重合时拒绝移动（防无限自触发） */
  watchDir?: string
}): Promise<MoveOutcome> {
  const warnings: string[] = []

  if (
    input.autoMove &&
    input.watchDir !== undefined &&
    resolvesToWatchRoot(input.watchDir, input.targetDir)
  ) {
    return {
      ok: false,
      targetPath: join(input.targetDir, input.fileName),
      moved: false,
      method: 'none',
      error: '目标目录就是智慧感知文件夹本身，会造成重复分类；请把科目文件夹设为它的子目录',
      warnings,
    }
  }

  const sourceSize = await input.fs.sizeOf(input.sourcePath)

  try {
    await input.fs.ensureDir(input.targetDir)
  } catch (error) {
    return {
      ok: false,
      targetPath: join(input.targetDir, input.fileName),
      moved: false,
      method: 'none',
      error: `创建目标目录失败：${describe(error)}`,
      warnings,
    }
  }

  const targetPath = await uniqueTargetPath(input.fs, input.targetDir, input.fileName)

  if (!input.autoMove) {
    return { ok: true, targetPath, moved: false, method: 'none', warnings }
  }

  if (sourceSize === undefined) {
    return {
      ok: false,
      targetPath,
      moved: false,
      method: 'none',
      error: '源文件已不存在',
      warnings,
    }
  }

  // 1. 优先 rename（同盘最快）
  try {
    await input.fs.rename(input.sourcePath, targetPath)
    return { ok: true, targetPath, moved: true, method: 'rename', warnings }
  } catch (error) {
    warnings.push(`直接移动失败（${describe(error)}），回退为复制后删除`)
  }

  // 2. 回退 copy + 校验 + 删源
  try {
    await input.fs.copy(input.sourcePath, targetPath)
  } catch (error) {
    return {
      ok: false,
      targetPath,
      moved: false,
      method: 'none',
      error: `复制失败：${describe(error)}`,
      warnings,
    }
  }

  // 3. 大小校验（复制成功但内容截断时不得删源）
  const copiedSize = await input.fs.sizeOf(targetPath)
  if (copiedSize !== sourceSize) {
    await input.fs.remove(targetPath).catch(() => undefined)
    return {
      ok: false,
      targetPath,
      moved: false,
      method: 'none',
      error: `复制的文件大小不一致（源 ${sourceSize} B / 目标 ${copiedSize ?? '未知'} B），已保留原文件`,
      warnings,
    }
  }

  try {
    await input.fs.remove(input.sourcePath)
  } catch (error) {
    // 目标已就绪、源未删：记为成功但告警（用户可见重复文件，比丢文件好）
    warnings.push(`原文件删除失败，请手动清理：${describe(error)}`)
  }
  return { ok: true, targetPath, moved: true, method: 'copy', warnings }
}

/** 目标目录的父目录（用于「打开所在文件夹」） */
export function parentOf(path: string): string {
  return dirname(path)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
