/**
 * 图像产物落盘的**纯逻辑**（图像工具，docs/06 §25）：文件名与清理选人。
 *
 * 截屏（`screenshots/`）与剪贴板图片（`clipboard/`）两条落盘链共用这一份 ——
 * 各自抄一遍的下场是「一个目录清理了、另一个无限长」，而清理本身是纯字符串逻辑，
 * 放这里就能被单测直接覆盖（真正的读目录 / 删文件在各自的端口里）。
 *
 * 与生图（`imagegen.ts` 的 `<ts>-<rand6>.png`）同一套命名：13 位毫秒时间戳打头、
 * 随机段防同毫秒覆盖 —— 顺带让**按名字字典序 = 按时间序**成立，清理不必 stat 每个文件。
 */

/** `<13 位毫秒时间戳>-<随机段>.png`（生图链路的同款形态） */
export function imageFileName(now: number, random: string): string {
  return `${now}-${random}.png`
}

/**
 * 从目录里的文件名中挑出**该删的**：保留最新 `keep` 个，返回更旧的那些。
 *
 * 依赖「名字以时间戳打头」这个约定（`imageFileName` 保证），因此用字典序排序即可 ——
 * 固定 13 位、十进制、无前导零，字典序与数值序一致。
 * `keep <= 0` 视为**不清理**（返回空数组）：宁可留着，也不要因为一个错误配置把目录清空。
 */
export function selectExpiredFiles(names: readonly string[], keep: number): string[] {
  if (keep <= 0) return []
  const sorted = [...names].sort()
  if (sorted.length <= keep) return []
  return sorted.slice(0, sorted.length - keep)
}
