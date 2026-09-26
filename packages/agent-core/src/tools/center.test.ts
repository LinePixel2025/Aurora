import { describe, expect, it } from 'vitest'
import {
  CENTER_SEND_FILE_TOOL_NAME,
  CENTER_STATUS_TOOL_NAME,
  createCenterSendFileTool,
  createCenterStatusTool,
  type CenterPort,
} from './center.js'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function makePort(overrides?: Partial<CenterPort>): CenterPort {
  return {
    status: () => ({
      enabled: true,
      connected: true,
      serverUrl: 'wss://center.example.com',
      displayName: '测试机',
    }),
    sendFile: async (path) => ({ fileId: 'f-1', name: path, size: 10, url: '/api/files/f-1' }),
    ...overrides,
  }
}

describe('center_status 工具', () => {
  it('在线 / 离线 / 未启用 三种口径', async () => {
    const tool = createCenterStatusTool({
      port: makePort(),
      maxFileBytes: () => 1024,
      fileTransferEnabled: () => true,
    })
    const online = await tool.execute({})
    expect(online?.content).toContain('已连接到 Aurora Center')

    const offline = createCenterStatusTool({
      port: makePort({
        status: () => ({ enabled: true, connected: false, serverUrl: 'ws://x', displayName: 'n' }),
      }),
      maxFileBytes: () => 1024,
      fileTransferEnabled: () => true,
    })
    expect((await offline.execute({}))?.content).toContain('离线')

    const disabled = createCenterStatusTool({
      port: makePort({
        status: () => ({ enabled: false, connected: false, serverUrl: '', displayName: '' }),
      }),
      maxFileBytes: () => 1024,
      fileTransferEnabled: () => true,
    })
    expect((await disabled.execute({}))?.content).toContain('未启用')
  })
})

describe('center_send_file 工具', () => {
  it('发送存在的文件并回传结果', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aurora-center-tool-'))
    const file = join(dir, 'hello.txt')
    await writeFile(file, '你好')
    try {
      const tool = createCenterSendFileTool({
        port: makePort(),
        maxFileBytes: () => 1024,
        fileTransferEnabled: () => true,
      })
      const result = await tool.execute({ path: file })
      expect(result?.isError).not.toBe(true)
      expect(result?.content).toContain('已发送到 Aurora Center')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('文件不存在 / 超上限 / 传输被禁用 三种拒绝', async () => {
    const tool = createCenterSendFileTool({
      port: makePort(),
      maxFileBytes: () => 1024,
      fileTransferEnabled: () => true,
    })
    expect((await tool.execute({ path: 'Z:/不存在的文件.txt' }))?.content).toContain('文件不存在')

    const dir = await mkdtemp(join(tmpdir(), 'aurora-center-tool-'))
    const big = join(dir, 'big.bin')
    await writeFile(big, Buffer.alloc(2048))
    try {
      const over = createCenterSendFileTool({
        port: makePort(),
        maxFileBytes: () => 1024,
        fileTransferEnabled: () => true,
      })
      expect((await over.execute({ path: big }))?.content).toContain('超过上限')

      const disabled = createCenterSendFileTool({
        port: makePort(),
        maxFileBytes: () => 1024,
        fileTransferEnabled: () => false,
      })
      expect((await disabled.execute({ path: big }))?.content).toContain('已被禁用')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('端口抛错 → isError 且消息可读；工具名与 sensitivity 正确', async () => {
    const tool = createCenterSendFileTool({
      port: makePort({
        sendFile: async () => {
          throw new Error('网络不可达')
        },
      }),
      maxFileBytes: () => 1024,
      fileTransferEnabled: () => true,
    })
    const dir = await mkdtemp(join(tmpdir(), 'aurora-center-tool-'))
    const file = join(dir, 'x.txt')
    await writeFile(file, 'x')
    try {
      const result = await tool.execute({ path: file })
      expect(result?.isError).toBe(true)
      expect(result?.content).toContain('网络不可达')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
    expect(tool.name).toBe(CENTER_SEND_FILE_TOOL_NAME)
    expect(tool.sensitivity).toBe('confirm')
    expect(
      createCenterStatusTool({
        port: makePort(),
        maxFileBytes: () => 1,
        fileTransferEnabled: () => true,
      }).name,
    ).toBe(CENTER_STATUS_TOOL_NAME)
  })
})
