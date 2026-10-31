/**
 * 「当前生效模型是否支持图片输入」的**唯一判据**（docs/06 §3.1、§25）。
 *
 * 为什么单独成文件：这一个布尔有两个完全不同的消费方，而它们必须同源 ——
 * ① 图片附件管线（`ipc.ts` 的 `prepareAttachments`）：关闭时把图片降级成一行文字、
 *    请求体里不放图片分片（对不支持视觉的模型发图会被服务端 400，整轮对话都用不了）；
 * ② 图像工具注册（`tools/index.ts` 的 `registerImageTools`）：关闭时 `view_image` /
 *    `screenshot` / `clipboard_read_image` **根本不进工具表**。
 * 判据若各写一份，就会出现「工具给了、附件被降级」这种自相矛盾的组合。
 *
 * 纯函数、不 import electron：`ipc.ts`（要弹文件对话框）与工具装配器都能用它，
 * 也便于单测直接喂配置。
 */
import {
  resolveModelParams,
  resolveSessionModel,
  type SessionModelOverrideLike,
  type Settings,
} from '@aurora/shared'

/**
 * 取值口径：`resolveModelParams(llm.providers[llm.active]).vision`（v23 起下沉到
 * **模型级** `modelParams[<模型 id>]`，唯一入口是 `resolveModelParams`）。
 *
 * 读不到 provider（未配置 / 条目被删 / 配置被写坏）一律按**关**处理 ——
 * 与内核 `ProviderConfig.vision` 的缺省一致，绝不因为配置异常就把图片发出去。
 */
export function visionEnabled(settings: Settings): boolean {
  try {
    const llm = settings.llm
    const provider = llm.providers[llm.active]
    if (provider === undefined) return false
    return resolveModelParams(provider).vision === true
  } catch {
    return false
  }
}

/**
 * 会话生效模型是否支持图片输入（Computer Use v39 用）。
 *
 * 会话级模型覆盖优先于全局档：`resolveSessionModel` 是唯一解析口径，覆盖失效时
 * 静默回落全局；读不到 provider 一律按关处理（与 `visionEnabled` 同款保守口径）。
 */
export function visionEnabledForSession(
  settings: Settings,
  override: SessionModelOverrideLike | null | undefined,
): boolean {
  try {
    const effective = resolveSessionModel(settings.llm, override ?? undefined)
    const provider = settings.llm.providers[effective.providerId]
    if (provider === undefined) return false
    return resolveModelParams(provider, effective.model).vision === true
  } catch {
    return false
  }
}
