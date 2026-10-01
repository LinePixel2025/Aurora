/**
 * 附件分流与图片读盘（多模态输入，docs/06 §3.1 / docs/07 §2.3，v22）。
 *
 * 为什么单独成文件：`ipc.ts` 依赖 Electron（`dialog` / `BrowserWindow`），
 * 而 vitest 的 include **只收不 import electron 的主进程测试** —— 把纯逻辑放这里
 * 才能被单测直接覆盖，接线（读盘、注入端口）留在 `ipc.ts` / `index.ts`。
 *
 * 三条口径（改动前先读 docs/06 §3.1）：
 * 1. **图片不提取文本**：`png / jpg / jpeg / webp / gif / bmp` 作为图片分片下发；
 *    其余扩展名仍走分类管线的 `extract.ts` 提取文本；
 * 2. **能力开关在装配层判定**：当前生效模型在 `llm.providers.<id>.modelParams.<模型 id>.vision`（v23 起按模型绑定）关着时图片降级为一行文字说明
 *    （对不支持视觉的模型发图片分片会被服务端 400，整轮对话都用不了）；
 * 3. **一切失败都降级、不阻断发送**：读不出 / 超限的文件如实写进上下文，绝不假装读过。
 */
import type { LlmImageInput } from '@aurora/agent-core'

/** 判定为「图片」的扩展名（小写、不含点）。与 `extract.ts` 的 `IMAGE_EXT` 有意重叠但**不等同**：
 *  那边是「分类管线的图片类型」，这边是「能作为图片分片发给模型」的格式子集 ——
 *  `tif` / `svg` 归前者不归后者（模型侧普遍不认这两种）。 */
export const IMAGE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']

/** 扩展名 → MIME（图片分片的 data URL 前缀） */
export const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
}

/**
 * 单张图片下发上限（8 MiB）。
 *
 * base64 之后约 10.7 MB 进请求体，再大就不是"发一张图"而是"发一个文件"了；
 * 超限时**如实降级**为一行未读取说明并写明原因 —— 静默截断会让用户以为模型看到了图。
 */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024

/**
 * 缩略图上限（2 MiB，docs/07 §2.3）。
 *
 * 这是**渲染层预览**的上限，与是否发给模型无关：一张 20 MB 的图不该把窗口卡住，
 * 但它的缩略图缺失只影响预览，因此上限比 `IMAGE_MAX_BYTES` 更紧。
 */
export const PREVIEW_MAX_BYTES = 2 * 1024 * 1024

/** 取小写扩展名（不含点）；没有扩展名返回空串。Windows 反斜杠与正斜杠都认。 */
export function extensionOf(path: string): string {
  const name = fileNameOf(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** 从绝对路径取文件名（渲染层传来的路径可能含 Windows 反斜杠）。 */
export function fileNameOf(path: string): string {
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1] ?? path
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.includes(extensionOf(path))
}

/** 该图片格式的 MIME；不认识的返回 `application/octet-stream`（调用方一般已先判过扩展名）。 */
export function imageMimeOf(path: string): string {
  return IMAGE_MIME_TYPES[extensionOf(path)] ?? 'application/octet-stream'
}

/**
 * 把附件路径分成「图片」与「其它文件」两类，**保持原顺序**。
 *
 * 顺序有意义：`extraContext` 里的文本块与图片分片的下发顺序会随附件顺序变化，
 * 用户按「图 + 说明文档」的顺序拖进来时，模型看到的顺序应与之一致。
 */
export function splitAttachments(paths: readonly string[]): {
  images: string[]
  documents: string[]
} {
  const images: string[] = []
  const documents: string[] = []
  for (const path of paths) {
    if (isImagePath(path)) images.push(path)
    else documents.push(path)
  }
  return { images, documents }
}

/** 读盘端口（注入以便单测；真实实现是 `node:fs`）。 */
export interface ImageReadPort {
  /** 文件字节数；读不到 stat 时返回 undefined（按"大小未知"继续读） */
  sizeOf(path: string): Promise<number | undefined>
  readFile(path: string): Promise<Buffer>
}

export interface LoadedImageInput {
  path: string
  /** 读成功时的图片内容；缺省 = 这张图读不出来（调用方按未读取处理） */
  image?: LlmImageInput
  /** 降级原因（写进 `extraContext` 的说明文案） */
  note?: string
}

/**
 * 读一批图片为可下发的形状。
 *
 * 返回**与入参一一对应**（含失败项），调用方据此写降级文案 —— 只回成功的那些会让
 * 「哪张没读出来」的信息在链路上丢失，最后表现为模型被问「这张图里有什么」时胡编。
 */
export async function readImages(
  paths: readonly string[],
  port: ImageReadPort,
): Promise<LoadedImageInput[]> {
  const out: LoadedImageInput[] = []
  for (const path of paths) {
    const name = fileNameOf(path)
    try {
      const size = await port.sizeOf(path)
      if (size !== undefined && size > IMAGE_MAX_BYTES) {
        out.push({
          path,
          note: `图片超过 ${Math.round(IMAGE_MAX_BYTES / 1024 / 1024)} MB 上限，未发送`,
        })
        continue
      }
      const bytes = await port.readFile(path)
      if (bytes.byteLength > IMAGE_MAX_BYTES) {
        out.push({
          path,
          note: `图片超过 ${Math.round(IMAGE_MAX_BYTES / 1024 / 1024)} MB 上限，未发送`,
        })
        continue
      }
      if (bytes.byteLength === 0) {
        out.push({ path, note: '图片为空文件' })
        continue
      }
      out.push({
        path,
        image: {
          mimeType: imageMimeOf(path),
          dataBase64: bytes.toString('base64'),
          ...(name === '' ? {} : { name }),
        },
      })
    } catch (error) {
      out.push({
        path,
        note: `读取失败：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  return out
}

/**
 * 图片未作为分片下发时写进上下文的说明（docs/06 §3.1 的「如实说明」口径）。
 *
 * 两种来源共用一份文案：能力开关关着（`vision` 为假）与读盘失败。
 * 措辞刻意写成**模型能读懂的事实**（而不是给用户看的错误提示）：模型据此知道自己
 * 并没有看到这张图，从而不会编造内容。
 */
export function imageFallbackBlock(fileName: string, reason: string): string {
  return `【附件】${fileName}：内容未读取（${reason}）`
}

/** 缩略图（渲染层 chip 用）的构建结果，对应 IPC 契约 `ChatAttachmentPreview`。 */
export interface AttachmentPreview {
  path: string
  name: string
  image: boolean
  dataUrl?: string
  note?: string
}

/**
 * 构建附件缩略图（docs/07 §2.3）：图片读成 `data:` URL，非图片 / 超限 / 读失败只回文件名。
 *
 * 渲染层拿不到 fs，这是它显示缩略图的**唯一**通道；因此这条路径上没有任何写入能力，
 * 读的内容也只以 data URL 形式回传（不回原始字节、不回目录信息）。
 */
export async function buildAttachmentPreview(
  path: string,
  port: ImageReadPort,
): Promise<AttachmentPreview> {
  const name = fileNameOf(path)
  if (!isImagePath(path)) return { path, name, image: false }
  try {
    const size = await port.sizeOf(path)
    if (size !== undefined && size > PREVIEW_MAX_BYTES) {
      return {
        path,
        name,
        image: true,
        note: `图片超过 ${Math.round(PREVIEW_MAX_BYTES / 1024 / 1024)} MB，未生成缩略图`,
      }
    }
    const bytes = await port.readFile(path)
    if (bytes.byteLength === 0) return { path, name, image: true, note: '图片为空文件' }
    if (bytes.byteLength > PREVIEW_MAX_BYTES) {
      return {
        path,
        name,
        image: true,
        note: `图片超过 ${Math.round(PREVIEW_MAX_BYTES / 1024 / 1024)} MB，未生成缩略图`,
      }
    }
    return {
      path,
      name,
      image: true,
      dataUrl: `data:${imageMimeOf(path)};base64,${bytes.toString('base64')}`,
    }
  } catch (error) {
    return {
      path,
      name,
      image: true,
      note: `读取失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
