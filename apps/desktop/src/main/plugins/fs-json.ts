/**
 * 插件运行时的 JSON 落盘小工具（registry / 配置 / 键值存储共用）。
 *
 * 原子写 = 先写 `<file>.tmp` 再 `rename`：Windows 上 rename 到已存在文件会
 * 直接覆盖（Node 的 `fs.rename` 语义），因此不需要先删目标 —— 先删会让
 * 「写一半崩溃」变成「文件消失」而不是「保留上一版」。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
  await rename(temp, file)
}
