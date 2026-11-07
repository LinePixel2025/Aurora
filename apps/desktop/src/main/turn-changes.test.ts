/**
 * 轮终改动汇总的单测（2026-11-07，docs/06 §4.2）。
 *
 * 只验证纯汇总口径：新建 / 修改 / 未变 / 删除 / 二进制 / 超限 / 没有快照 / 同文件多次写 /
 * 展示路径 / 行数对比的粗粒度退化。快照与文件系统都注入假实现，不碰真实磁盘。
 */
import { describe, expect, it } from 'vitest'
import type { AgentToolCall, Logger, SnapshotRef } from '@aurora/shared'
import {
  MAX_TURN_CHANGE_BYTES,
  collectTurnChanges,
  countLineChanges,
  displayPath,
  pathOfToolCall,
  splitLines,
  type TurnChangesDeps,
} from './turn-changes.js'

function quietLogger(): Logger {
  const noop = (): void => {}
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => quietLogger(),
    setLevel: noop,
  } as unknown as Logger
}

interface HarnessOptions {
  sessionId?: string
  root?: string
  home?: string
  files?: Record<string, string | Uint8Array>
  refs?: SnapshotRef[]
  /** snapshotId → 内容（字符串或字节）；缺省视为内容读不出来 */
  contents?: Record<string, string | Uint8Array>
  now?: () => number
}

function createDeps(options: HarnessOptions = {}): TurnChangesDeps & {
  snapshots: {
    list: () => Promise<SnapshotRef[]>
    readContent: (
      ref: SnapshotRef,
    ) => Promise<{ bytes: Uint8Array; truncated: boolean } | undefined>
  }
} {
  const files = new Map<string, Uint8Array>()
  for (const [path, content] of Object.entries(options.files ?? {})) {
    files.set(path, typeof content === 'string' ? Buffer.from(content, 'utf8') : content)
  }
  const contents = new Map<string, Uint8Array>()
  for (const [id, content] of Object.entries(options.contents ?? {})) {
    contents.set(id, typeof content === 'string' ? Buffer.from(content, 'utf8') : content)
  }
  return {
    snapshots: {
      list: async () => options.refs ?? [],
      readContent: async (ref) => {
        const bytes = contents.get(ref.id)
        return bytes === undefined ? undefined : { bytes, truncated: false }
      },
    },
    readFile: async (path) => {
      const bytes = files.get(path)
      if (bytes === undefined) throw new Error(`ENOENT: ${path}`)
      return bytes
    },
    stat: async (path) => {
      const bytes = files.get(path)
      if (bytes === undefined) throw new Error(`ENOENT: ${path}`)
      return { size: bytes.byteLength }
    },
    logger: quietLogger(),
    ...(options.root === undefined ? {} : { workspaceRootOf: () => options.root }),
    ...(options.home === undefined ? {} : { homeDir: options.home }),
    ...(options.now === undefined ? {} : { now: options.now }),
  }
}

function ref(input: {
  id: string
  sessionId?: string
  path: string
  toolCallId?: string
  exists?: boolean
  createdAt?: string
  origin?: SnapshotRef['origin']
}): SnapshotRef {
  return {
    id: input.id,
    sessionId: input.sessionId ?? 'main',
    path: input.path,
    ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
    origin: input.origin ?? 'write_file',
    createdAt: input.createdAt ?? '2026-11-07T10:00:00.000Z',
    contentPath: input.exists === false ? '' : `main/${input.id}.snap`,
    bytes: 0,
    exists: input.exists !== false,
  }
}

function call(input: {
  id: string
  name?: string
  path?: string
  saveAs?: string
  outputPath?: string
  state?: AgentToolCall['state']
}): AgentToolCall {
  const args: Record<string, unknown> = {}
  if (input.path !== undefined) args.path = input.path
  if (input.saveAs !== undefined) args.saveAs = input.saveAs
  if (input.outputPath !== undefined) args.outputPath = input.outputPath
  return {
    id: input.id,
    name: input.name ?? 'write_file',
    input: args,
    state: input.state ?? 'success',
  }
}

describe('pathOfToolCall', () => {
  it('write_file / edit_file / office_create 取 path', () => {
    expect(pathOfToolCall(call({ id: 'a', path: '  C:\\x\\a.txt  ' }))).toBe('C:\\x\\a.txt')
    expect(pathOfToolCall(call({ id: 'a', name: 'edit_file', path: 'a.txt' }))).toBe('a.txt')
    expect(pathOfToolCall(call({ id: 'a', name: 'office_create', path: 'a.docx' }))).toBe('a.docx')
  })

  it('office_edit 优先 saveAs，office_pdf 只认显式 outputPath', () => {
    expect(
      pathOfToolCall(call({ id: 'a', name: 'office_edit', path: 'src.docx', saveAs: 'out.docx' })),
    ).toBe('out.docx')
    expect(pathOfToolCall(call({ id: 'a', name: 'office_edit', path: 'src.docx' }))).toBe(
      'src.docx',
    )
    expect(pathOfToolCall(call({ id: 'a', name: 'office_pdf', path: 'a.docx' }))).toBeUndefined()
    expect(
      pathOfToolCall(call({ id: 'a', name: 'office_pdf', path: 'a.docx', outputPath: 'a.pdf' })),
    ).toBe('a.pdf')
  })

  it('非写文件工具 / 非法入参返回 undefined', () => {
    expect(pathOfToolCall({ name: 'read_file', input: { path: 'x' } })).toBeUndefined()
    expect(pathOfToolCall({ name: 'write_file', input: { path: 42 } })).toBeUndefined()
    expect(pathOfToolCall({ name: 'write_file', input: null })).toBeUndefined()
  })
})

describe('splitLines / countLineChanges', () => {
  it('CRLF 归一、末尾换行不算额外一行', () => {
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b'])
    expect(splitLines('')).toEqual([])
    expect(splitLines('\n')).toEqual([''])
  })

  it('只改中间一行：added 1 / removed 1', () => {
    expect(countLineChanges('a\nb\nc\n', 'a\nB\nc\n')).toEqual({
      added: 1,
      removed: 1,
      coarse: false,
    })
  })

  it('插入两行：added 2 / removed 0', () => {
    expect(countLineChanges('a\nb\n', 'a\nx\ny\nb\n')).toEqual({
      added: 2,
      removed: 0,
      coarse: false,
    })
  })

  it('超过行数上限退化整文件替换并标 coarse', () => {
    const before = Array.from({ length: 10 }, (_, index) => `before-${index}`).join('\n')
    const after = Array.from({ length: 12 }, (_, index) => `after-${index}`).join('\n')
    expect(countLineChanges(before, after, { maxLines: 2 })).toEqual({
      added: 12,
      removed: 10,
      coarse: true,
    })
  })

  it('时间预算为 0 时退化', () => {
    const diff = countLineChanges('a\nb\n', 'a\nc\n', { budgetMs: 0 })
    expect(diff.coarse).toBe(true)
  })
})

describe('displayPath', () => {
  it('工作目录内给相对路径，家目录内给 ~，其余绝对路径', () => {
    expect(displayPath('D:\\proj\\sub\\a.txt', 'D:\\proj', 'C:\\Users\\me')).toBe('sub/a.txt')
    expect(displayPath('C:\\Users\\me\\Desktop\\a.txt', 'D:\\proj', 'C:\\Users\\me')).toBe(
      '~/Desktop/a.txt',
    )
    expect(displayPath('E:\\other\\a.txt', 'D:\\proj', 'C:\\Users\\me')).toBe('E:/other/a.txt')
    expect(displayPath('D:\\proj2\\a.txt', 'D:\\proj', 'C:\\Users\\me')).toBe('D:/proj2/a.txt')
  })
})

describe('collectTurnChanges', () => {
  it('新建文件：before 是 exists:false 的快照 → created + added 行数', async () => {
    const path = 'D:\\proj\\new.txt'
    const deps = createDeps({
      root: 'D:\\proj',
      files: { [path]: 'a\nb\n' },
      refs: [ref({ id: 'r1', path, toolCallId: 'c1', exists: false })],
    })
    const files = await collectTurnChanges(
      { sessionId: 'main', toolCalls: [call({ id: 'c1', path })] },
      deps,
    )
    expect(files).toEqual([{ path, display: 'new.txt', status: 'created', added: 2, removed: 0 }])
  })

  it('修改文件：before 读快照、after 读盘 → modified + 行数', async () => {
    const path = 'D:\\proj\\a.txt'
    const deps = createDeps({
      root: 'D:\\proj',
      files: { [path]: 'a\nB\nc\n' },
      refs: [ref({ id: 'r1', path, toolCallId: 'c1' })],
      contents: { r1: 'a\nb\nc\n' },
    })
    const files = await collectTurnChanges(
      { sessionId: 'main', toolCalls: [call({ id: 'c1', name: 'edit_file', path })] },
      deps,
    )
    expect(files).toEqual([{ path, display: 'a.txt', status: 'modified', added: 1, removed: 1 }])
  })

  it('内容没变 → 不列', async () => {
    const path = 'D:\\proj\\a.txt'
    const deps = createDeps({
      root: 'D:\\proj',
      files: { [path]: 'same\n' },
      refs: [ref({ id: 'r1', path, toolCallId: 'c1' })],
      contents: { r1: 'same\n' },
    })
    expect(
      await collectTurnChanges({ sessionId: 'main', toolCalls: [call({ id: 'c1', path })] }, deps),
    ).toEqual([])
  })

  it('二进制扩展名（Office）→ binary，且不读行数', async () => {
    const path = 'D:\\proj\\a.docx'
    const deps = createDeps({
      root: 'D:\\proj',
      files: { [path]: new Uint8Array([1, 2, 3]) },
      refs: [ref({ id: 'r1', path, toolCallId: 'c1', origin: 'office_edit' })],
      contents: { r1: new Uint8Array([9, 9]) },
    })
    expect(
      await collectTurnChanges(
        { sessionId: 'main', toolCalls: [call({ id: 'c1', name: 'office_edit', path })] },
        deps,
      ),
    ).toEqual([{ path, display: 'a.docx', status: 'binary' }])
  })

  it('after 超过上限 → oversized（不读内容）', async () => {
    const path = 'D:\\proj\\big.log'
    const deps = createDeps({
      root: 'D:\\proj',
      files: {},
      refs: [ref({ id: 'r1', path, toolCallId: 'c1' })],
      contents: { r1: 'x\n' },
    })
    const originalStat = deps.stat
    deps.stat = async (target) => {
      if (target === path) return { size: MAX_TURN_CHANGE_BYTES + 1 }
      return originalStat(target)
    }
    expect(
      await collectTurnChanges({ sessionId: 'main', toolCalls: [call({ id: 'c1', path })] }, deps),
    ).toEqual([{ path, display: 'big.log', status: 'oversized' }])
  })

  it('没有快照但盘上有文件 → unknown（只列路径，不猜行数）', async () => {
    const path = 'D:\\proj\\a.txt'
    const deps = createDeps({ root: 'D:\\proj', files: { [path]: 'a\n' } })
    expect(
      await collectTurnChanges({ sessionId: 'main', toolCalls: [call({ id: 'c1', path })] }, deps),
    ).toEqual([{ path, display: 'a.txt', status: 'unknown' }])
  })

  it('after 不存在且 before 有内容 → deleted + removed 行数', async () => {
    const path = 'D:\\proj\\gone.txt'
    const deps = createDeps({
      root: 'D:\\proj',
      refs: [ref({ id: 'r1', path, toolCallId: 'c1' })],
      contents: { r1: 'a\nb\n' },
    })
    expect(
      await collectTurnChanges({ sessionId: 'main', toolCalls: [call({ id: 'c1', path })] }, deps),
    ).toEqual([{ path, display: 'gone.txt', status: 'deleted', added: 0, removed: 2 }])
  })

  it('同一路径本轮写多次：before 取最早那份快照', async () => {
    const path = 'D:\\proj\\a.txt'
    const deps = createDeps({
      root: 'D:\\proj',
      files: { [path]: 'a\nb\nc\n' },
      refs: [
        ref({ id: 'r2', path, toolCallId: 'c2', createdAt: '2026-11-07T10:00:05.000Z' }),
        ref({ id: 'r1', path, toolCallId: 'c1', createdAt: '2026-11-07T10:00:00.000Z' }),
      ],
      contents: { r1: 'a\n', r2: 'a\nb\n' },
    })
    expect(
      await collectTurnChanges(
        {
          sessionId: 'main',
          toolCalls: [call({ id: 'c1', path }), call({ id: 'c2', path })],
        },
        deps,
      ),
    ).toEqual([{ path, display: 'a.txt', status: 'modified', added: 2, removed: 0 }])
  })

  it('只认失败 / 非写文件调用之外的结算成功调用', async () => {
    const path = 'D:\\proj\\a.txt'
    const deps = createDeps({ root: 'D:\\proj', files: { [path]: 'a\n' } })
    expect(
      await collectTurnChanges(
        {
          sessionId: 'main',
          toolCalls: [
            call({ id: 'c1', path, state: 'error' }),
            call({ id: 'c2', name: 'read_file', path }),
          ],
        },
        deps,
      ),
    ).toEqual([])
  })

  it('相对路径按会话工作目录解析；解析不出（无根）时不计入', async () => {
    const deps = createDeps({
      root: 'D:\\proj',
      files: { 'D:\\proj\\a.txt': 'a\n' },
      refs: [ref({ id: 'r1', path: 'D:\\proj\\a.txt', toolCallId: 'c1', exists: false })],
    })
    expect(
      await collectTurnChanges(
        { sessionId: 'main', toolCalls: [call({ id: 'c1', path: 'a.txt' })] },
        deps,
      ),
    ).toEqual([
      { path: 'D:\\proj\\a.txt', display: 'a.txt', status: 'created', added: 1, removed: 0 },
    ])

    const noRoot = createDeps({})
    expect(
      await collectTurnChanges(
        { sessionId: 'main', toolCalls: [call({ id: 'c1', path: 'a.txt' })] },
        noRoot,
      ),
    ).toEqual([])
  })
})
