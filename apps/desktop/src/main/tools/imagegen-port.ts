/**
 * `ImageGenPort` 的主进程实现（Design/betav2-spec.md §8.4、docs/06 §14）。
 *
 * 只是把 `ImageGenService.generate`（main/imagegen.ts，出网 + 落盘 + dataUrl）
 * 收窄成内核需要的形状：工具结果只关心 `filePath`（dataUrl 由渲染层经
 * `imagegen:read` 按需换取，不进工具回填文本，避免一张图的 base64 撑爆上下文）。
 * 本文件不 import electron，可在 Node 里单测。
 */
import type { ImageGenPort } from '@aurora/agent-core'

/** 结构化最小面：`ImageGenService`（main/imagegen.ts）满足 */
export interface ImageGenServiceLike {
  generate(request: {
    prompt: string
    size?: string
  }): Promise<{ filePath: string; dataUrl: string }>
}

export function createImageGenPort(service: ImageGenServiceLike): ImageGenPort {
  return {
    async generate(input: { prompt: string; size?: string }): Promise<{ filePath: string }> {
      const result = await service.generate(input)
      return { filePath: result.filePath }
    },
  }
}
