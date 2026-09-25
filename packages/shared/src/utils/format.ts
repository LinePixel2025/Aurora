/**
 * 展示用的数值格式化（纯函数，docs/07 §2.3 的上下文详解条）。
 *
 * 放在 `shared` 而不是渲染层组件里的理由：它是**跨窗口可复用**的展示口径
 * （提示条 / 设置页将来若展示 token 数，必须与对话窗一致），而且只有放在这里
 * 才能进 vitest 的收集范围（渲染层没有单测入口，见 vitest.config.ts 的 include）。
 *
 * 本文件不得 import 任何 Node 内置模块（`@aurora/shared/browser` 的依赖链约束）。
 */

/**
 * token 数 → 紧凑显示：`0`→`0`、`999`→`999`、`1234`→`1.2k`、`128000`→`128k`、`1500000`→`1.50M`。
 *
 * 按 **1000** 进制而不是 1024：这些数字要么来自服务商的报文（本身就是十进制口径的 token 数），
 * 要么来自用户照着文档填的窗口大小；混用 1024 只会让两边对不上（128000 → 125k 让人以为填错了）。
 *
 * 千位以上保留一位小数，但**百位以上不再保留**（`128.0k` 读起来比 `128k` 差）；
 * 负数与非有限数一律按 `0` 处理（调用方拿到的是算出来的值，出错时显示 0 比显示 `NaN` 强）。
 */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1000) return String(Math.round(value))
  // 先按一位小数定下来再判断档位：`99999 / 1000 = 99.999` 直接判断会走进 `toFixed(1)` 分支
  // 得到 `100.0k`，`999999` 更会得到 `1000k` —— 进位后才越界的情况必须靠四舍五入后的值判断。
  const thousands = Math.round(value / 100) / 10
  if (thousands < 1000) {
    return thousands >= 100 ? `${Math.round(thousands)}k` : `${thousands.toFixed(1)}k`
  }
  return `${(value / 1_000_000).toFixed(2)}M`
}

/**
 * 精确显示（详情面板用）：带千分位，且**不缩写** —— 用户在「明细」里要看的就是准确数字，
 * 那里再写 `12.3k` 等于把四舍五入后的值当成事实。
 */
export function formatExactCount(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Math.round(value).toLocaleString('en-US')
}
