/**
 * 内容提取 worker —— 运行在 Electron `utilityProcess` 里（docs/02 §2.1、docs/05 §3.2）。
 *
 * 为什么单独进程：文档解析（PDF / Office）可能耗时数秒且可能因畸形文件卡死，
 * 放在主进程会阻塞事件循环，导致对话、托盘与窗口操作全部卡顿。
 *
 * 协议：`execArgv` 无关，纯 `parentPort.postMessage` 请求/响应。
 *   → { id, path, ext, sizeBytes }
 *   ← { id, ok: true, kind, evidence, evidenceChars, warnings }
 *   ← { id, ok: false, error }
 *
 * 本文件由 `electron.vite.config.ts` 的第二个 main 入口构建为 `out/main/extract-worker.js`，
 * 因此 workspace 包会被内联，第三方依赖（officeparser）保持 external。
 */
import { createRequire } from 'node:module'
import { promises as fs } from 'node:fs'
import { extract, type EvidenceKind } from './extract.js'

/** 在 CJS 产物里解析外部依赖（officeparser 是 CJS，其内部再动态 import ESM 的 pdfjs） */
const requireExternal = createRequire(import.meta.url)

interface ExtractRequest {
  id: string
  path: string
  ext: string
  sizeBytes: number
}

interface ExtractResponse {
  id: string
  ok: boolean
  kind?: EvidenceKind
  evidence?: string
  evidenceChars?: number
  warnings?: string[]
  error?: string
}

/** 懒加载解析器：只有真的遇到 Office / PDF 文件时才付加载成本 */
let parserPromise:
  Promise<((path: string) => Promise<{ toText(): string }>) | undefined> | undefined

async function loadParser(): Promise<
  ((path: string) => Promise<{ toText(): string }>) | undefined
> {
  parserPromise ??= (async () => {
    try {
      const mod = requireExternal('officeparser') as {
        parseOffice(file: string): Promise<{ toText(): string }>
      }
      return (file: string) => mod.parseOffice(file)
    } catch {
      return undefined
    }
  })()
  return parserPromise
}

async function handle(request: ExtractRequest): Promise<ExtractResponse> {
  try {
    const parseOffice = await loadParser()
    const result = await extract({
      path: request.path,
      ext: request.ext,
      sizeBytes: request.sizeBytes,
      readFile: (target) => fs.readFile(target),
      ...(parseOffice === undefined ? {} : { parseOffice }),
    })
    return {
      id: request.id,
      ok: true,
      kind: result.kind,
      evidence: result.evidence,
      evidenceChars: result.evidenceChars,
      warnings: result.warnings,
    }
  } catch (error) {
    // 提取失败也不应让 worker 崩掉：由主进程决定降级策略
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }
  }
}

process.parentPort.on('message', (message) => {
  const request = message.data as ExtractRequest | undefined
  if (
    request === undefined ||
    typeof request !== 'object' ||
    typeof request.id !== 'string' ||
    typeof request.path !== 'string'
  ) {
    return
  }
  void handle(request).then((response) => {
    try {
      process.parentPort.postMessage(response)
    } catch {
      /* 父进程已退出：无需处理 */
    }
  })
})
